# kiln-memory-cache — 插件侧内存缓存方案：动作流、图、详情放哪、怎么失效、多大上限

- **domain**：integration
- **关联**：relates-to `kiln-list-window`（虚拟化已把 DOM 压住，剩下的成本在 JS 堆与重复取数）、relates-to `kiln-session-cache`（图/详情/搜索已有会话缓存）、relates-to `kiln-many-issues`（上游分页缺口）、relates-to `kiln-v040-adapter`

## 问题

插件目前**只缓存图 / 详情 / 搜索**（会话内、HEAD 键控那一类），**动作流完全不缓存**：每次 mount / 刷新都重新起
`kiln action log --jsonl`，全量读、全量解析、全量折叠。虚拟化之后 DOM 已经有上界（可视区 ± 600px），
剩下的成本集中在两处：

1. **重复取数**：同一仓库、HEAD 没变，切页/刷新仍要重跑一遍全史扫描；
2. **常驻 JS 堆**：如果为了省这次扫描把动作流缓存下来，10 万动作的 rows + 折叠索引会占多少内存、
   会不会把插件变成 DSH 里的内存大户。

上游短期不会给分页/游标（`kiln-many-issues`），所以要设计的是**插件侧**的内存缓存：存什么、放哪、
怎么增量、多大就降级。这个 issue 只做设计，不实现。

## 已知数字（来自前几轮实测/估算）

| 项 | 数字 |
| --- | --- |
| 一行动作的 JSON | 约 400B（commit 40 位 + issue/action/date + 标题 + domain + tags） |
| 20MB / 29MB 对应 | 约 **5 万 / 10 万** 条动作 |
| 宿主 parse+map | 100k 行约 29ms |
| `foldIssues` | 100k 行一次约 21ms；流式重折 20 次累计约 99ms |
| 常驻内存粗估 | 解析后约为 payload 的 **2.5–4×**；折叠索引再叠接近一倍动作对象 |
| 5 万动作 | 常驻约 70–120MB |
| 10 万动作 | 常驻约 150–250MB |
| 当前真仓 | 153 / 455 条动作，约 0.2MB，完全无压力 |

结论先行：**20MB 的传输/解析不大，常驻 JS 堆是中等偏大**；关键是不留多份（原始 rows + 折叠 actions + tags 数组）。
这决定缓存不能“无脑全存”，要有条数/字节上限与降级路径。

## 外部调研：同类系统怎么做（collect）

调研范围限定为“客户端拿到一份只增不减的事件流 / 时间线，要在内存里缓存并增量更新”这一类问题。
挑六个能对照的实现，逐个记：它解决什么、机制是什么、**能借什么 / 不能借什么**。

### 1. TanStack Query：键控缓存 + 失活回收 + 结构共享

- 缓存以 `queryKey` 为唯一身份，**key 必须包含所有输入**；失活条目由 `gcTime` 回收（v5 默认 5 分钟 = `300 000` ms）。
- **结构共享**（`structuralSharing`，内部 `replaceEqualDeep`）：重新取数后，未变化的子树保持**原引用**，
  只有变化的部分换新对象——“省内存”和“省重渲染”是同一件事。
- 无限列表：一个 cache entry **同时只允许一个 in-flight**，否则会互相覆盖；
  `maxPages` 超限时丢弃最老一页；重新取数时**从第一页顺序取**，因为拿旧 cursor 直接续可能重复或漏条。
  （[Infinite Queries](https://tanstack.com/query/v5/docs/framework/react/guides/infinite-queries)、
  [Render Optimizations](https://tanstack.com/query/v5/docs/framework/react/guides/render-optimizations)）

**借**：键要含 `HEAD` / config / 二进制；同一 key 只允许一次 in-flight（我们已有）；追加新行时**保留旧行对象引用**，
不要重建整个数组。**不借**：TTL 与失活回收——我们的数据源可以精确校验（HEAD），按 key 失比比按时间失效准。

### 2. lru-cache：容量必须显式有界

- 原文：“At least one of `max`, `ttl`, or `maxSize` is required, **to prevent unsafe unbounded storage**.”
- `maxSize` + `sizeCalculation`：**每条必须自报 size（正整数）**，总量超限按 LRU 淘汰；`dispose` 用于释放条目附带的资源。
- TTL 默认**不主动清理**（不设 `ttlAutopurge` 就只在读取时判过期）；作者明确写：size 跟踪、TTL、观测“都不是免费的”。
  （[node-lru-cache](https://github.com/isaacs/node-lru-cache)）

**借**：上限要是两个正交维度（**条数 + 字节**），且字节按“每条自报”累计，而不是用平均值猜总量；
淘汰要能真正松开引用（折叠索引、去重 map 都得跟着放）。**不借**：跨仓 LRU 意义有限——会话里通常只有 1–3 个仓，
真正的上界是**单仓全史**，LRU 只该决定“留几个仓”。

### 3. Git pack 协商：have / want，只发增量

- 客户端先报自己已经有的提交（`have`），服务端据此**只打包缺失的对象**；没有 ack 的简化版就是“发到对方喊停”。
  （[gitprotocol-pack](https://git-scm.com/docs/gitprotocol-pack)）

**借**：增量判据是**“我持有的最新边界”**，不需要源端理解我们的缓存结构；具体到我们，就是
“流里读到缓存里最老一条的 sha 就停，并 kill 子进程”。**差异**：git 是双向协商，我们只有单向下行，
所以“没撞到已知 sha 就读到 EOF”必须等价于**全量替换**，这是唯一的兜底。

### 4. Filebeat registry：offset 只有配上“文件身份”才有效

- 续读靠 `offset`，但**先比身份**：`file_identity` 用 inode+设备号（`native`）或首 N 字节指纹（`fingerprint`）；
  身份变了就当作新文件，**从 0 重读**。指纹默认只取前 1024 字节。
  （[filestream input](https://www.elastic.co/guide/en/beats/filebeat/current/filebeat-input-filestream.html)）

**借**：checkpoint 必须和 identity 绑定，身份不匹配一律重来——这正是“历史被改写就全量”的现成表述。
**差异**：日志文件是尾部追加，我们是**倒序流**：新数据出现在头部（行号更小），checkpoint 是
“最老一条的 sha”而不是字节 offset，因此**不能只读尾部字节**，只能从头读到已知边界。

### 5. kiln 自己的提交缓存：快照 + 记录层 + 合并（最贴近的同款）

本机 `~/kiln/README.md` §缓存（v0.4.0，默认开启）：

- 枚举快照按 HEAD 存（`.git/kiln/enums/`，约 **20 B/提交**）+ 解析后字段的记录层（`.git/kiln/records/`，约 **130 B/提交**），
  **热读不启动 git**，输出逐字节不变；
- 写时保留最近 **4 份**快照，层数到 **64 自动合并**；`kiln cache clear` 一键回退；
- 只读仓写失败**静默降级**；遇到 `refs/replace` / `info/grafts` / `shallow` / reftable / `GIT_DIR` **直接不缓存**；
- 实测（455 提交）：`action log --jsonl` 112 → 27 ms；100k 提交 `graph --json` 1,022 → 144 ms。

**借**：形态（**一次全量快照 + 追加层 + 定期合并**）与**保守回退**（看不懂的仓库就不缓存，而不是猜）。
**差异**：它是磁盘、按 HEAD 逐份快照；我们只有内存、且进程内会经历多次 HEAD 前进——
用“一层 + 回退”就够，不需要 64 层合并。

### 6. 内存怎么量：`measureUserAgentSpecificMemory` 基本用不上

- 该 API 要求 **secure context + cross-origin isolated**（COOP/COEP），且返回值**跨浏览器/跨版本不可比**，
  文档明确要求“不要对 breakdown 硬编码假设”，只适合周期采样看趋势。
  （[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory)）

**结论**：插件跑在 DSH Web GUI 里，拿不到跨域隔离的概率很高；**观测只能靠自报字节**（行长度 + 每行估算），
界面上必须标“估算”而不是“实测”。`performance.memory` 只在 Chromium 有、粒度粗，最多当旁证。

### 落到本仓库：六个问题各自的现成答案

| 本 issue 的问题 | 成熟做法 | 建议采纳 |
| --- | --- | --- |
| 缓存什么 | 原始层 + 派生层，派生可重算 | 存**解析后 rows**（parse+map 100k 仅 29ms，省它不值）；fold 索引**惰性 memo**、不独立存 |
| 放哪 | 源可精确校验时，缓存靠近消费方 | **宿主内存**存 rows（F5 后不重付），客户端只留选中/滚动等 UI 状态 |
| 增量 | have/want + 身份校验 | 倒序读到**已知最老 sha 即停**；EOF 未命中 → 全量替换 |
| 上限 | 显式双维上限 + 可释放淘汰 | **5 万条 / 20MB** 先到先算；超限降级为“首屏 N 条 + 新前缀”，其余退回流式 |
| 失效 | key 含全部输入 | `(repo, HEAD, configToken, binaryToken)`；HEAD 前进是**一次增量**，不是清空 |
| 观测 | 自报字节，别指望 heap API | 页头 hit / rows / bytes / ms，标注“估算” |

### 本次没有验证、留给 hypothesize/test 的

- 倒序流“读到头就停”在 **merge / 同秒（date 相同的多条）/ rebase / amend** 下的实际行为，需要在假仓里造样本确认；
- 宿主缓存 rows 后，客户端重连（F5）走的是“宿主命中”还是“重新流式”，取决于 DSH 宿主生命周期，需要实测；
- 20MB 在宿主进程（Node）里的常驻成本与客户端不同，Node 堆上限更宽但共享给所有插件，需要给出公平预算。 

## 要回答的问题

1. **缓存什么**
   - 原始 NDJSON 行（省上游解析，但客户端仍要 parse）；
   - 解析后的 rows（省 parse + fold，但最占内存）；
   - 折叠后的 issue 索引是否单独缓存（增量折叠）；
   - 图 / 详情 / 搜索要不要并进同一套缓存与 LRU。
2. **放哪**
   - 客户端内存（刷新即丢，F5 后重付 20MB）；
   - 宿主内存（同一 DSH 进程内共享，F5 后仍在，可配合 `readHeadFast` 做“HEAD 未变 0 子进程”）；
   - 两层各存什么、谁负责增量；
   - 持久化（IndexedDB / 磁盘）是否明确排除（与“不落盘”冲突）。
3. **增量怎么取**
   - 动作流是 author-date 倒序：HEAD 前进时新动作在**前面**，理论上读到“旧缓存的第一条 sha”就可以停；
   - 这个前缀性质在线性历史成立吗？merge / 同秒 / rebase / amend 分别怎么办；
   - HEAD 元信息从哪来（timeline 的 meta 帧 / `readHeadFast`）；
   - 历史被改写时如何判定并回退全量；
   - abort 的时机、半行、宿主 kill 子进程的现有语义是否够用。
4. **容量与降级**
   - 上限按“动作条数”还是“估算字节”？候选阈值（如 5 万条 / 20MB）；
   - 超限时降级成什么：只缓存首屏 N 条 + 新前缀？还是退回现在的“全量流 + 虚拟化”；
   - 多仓库要不要 LRU（当前会话缓存按仓库）。
5. **一致性与失效**
   - 缓存键：HEAD / `.kilnconfig.jsonc` / kiln 二进制，是否与图缓存共用；
   - 刷新、筛选、搜索、聚焦与缓存的关系；
   - 缓存里的 rows 和独立取的详情 / 图发生 HEAD 不一致时怎么处理。
6. **观测**
   - 页头要能看到什么（hit / bytes / rows / ms）；
   - 内存怎么量（客户端 `performance.memory`、宿主 RSS、动作条数）。

## 非目标

- 不做持久化缓存（IndexedDB / 磁盘），不引入 LLM 摘要或第二份推导状态；
- 不改上游 kiln，不等 `--since` / `--limit`；
- 不做分页 UI（窗口/虚拟化已覆盖渲染）；
- 不缓存 diff / stat；
- 本 issue 不写实现。

## 验收（设计完成时）

- 给出选型表：缓存粒度（行/rows/索引）× 位置（客户端/宿主）× 增量策略；
- 增量算法写清前置条件、停止条件、历史改写的回退判据，以及“HEAD 未变 0 子进程”的实现路径；
- 给出容量上限与降级触发（条数/字节），以及降级后的行为；
- 对 1 万 / 5 万 / 10 万动作给出堆与首次加载的估算，并标注验证方式；
- 明确与现有图/详情/搜索缓存、刷新语义、虚拟列表的关系；
- 列出风险与回退（缓存坏了会怎样、怎么一键清掉）。
