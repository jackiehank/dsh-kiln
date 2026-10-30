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

## 本仓实测：重复取数发生在哪里（collect）

探针：`plugin/test/probe-memory.mjs`，`node --expose-gc plugin/test/probe-memory.mjs`；
读法：`plugin/lib/client.js` 的五个取数 effect + `plugin/lib/index.js` 的五条路由。
仓库当前 **164 条动作 / 27 个 issue**。

### 一、五条数据五套缓存，只有动作流是裸的

| 数据 | 路由 → 命令 | 客户端缓存 | 宿主缓存 | 什么时候重取 |
| --- | --- | --- | --- | --- |
| 动作流 | `/kiln/timeline` → `action log --jsonl` | **无** | **无** | 每次视图 mount（切页 / 换会话 / F5）、换仓库、点刷新 |
| 关系图 | `/kiln/graph` → `graph --json` | 有（LRU 4） | 有（HEAD+config+bin 键控） | 刷新、换仓库；命中也会后台重取一次 |
| 详情 | `/kiln/issue` → `path <id> --json` | 有（LRU 20） | **无** | 换焦点、刷新、F5 |
| 搜索 | `/kiln/search` → `list --search --json` | 有（按 query，LRU 20） | **无** | 新查询词、刷新、F5 |
| 词表 | `/kiln/actions` → `action list --json` | 有（按仓库） | 有（LRU 16） | 首次 |

`conversation.view` 只渲染激活的那个标签，切走就整块卸载（`client.js:206-208` 的注释、以及
`viewStates` 这份“按仓库的视图内存”存在的理由都是它）——所以**每进一次 kiln 页，动作流就整条重读一遍**，
哪怕 HEAD 没动、上一分钟才读过。这是当前唯一“每次都要付一遍”的成本。

### 二、固定成本是子进程，不是数据

| 命令 | 5 次热读（ms） | 输出 |
| --- | --- | --- |
| `action log --jsonl` | 37.8 / 41.7 / 45.9 / 38.1 / 37.8 | 63.5KB，164 行（396B/行） |
| `action log --jsonl --limit 1` | 33.8 | 1 行 |
| `graph --json` | 41.2 / 41.1 / 47.5 / 44.6（首读 126.9） | 13.8KB |
| `path <id> --json` | 36.3–38.0 | 1.6KB |
| `list --search --json` | 36.0–38.6 | 0.8KB |
| `action list --json` | 32.6–41.3 | 94B |

`--limit 1` 和全量差不到 5ms → **约 34ms 是 spawn + 定位仓库 + 读配置的地板价**，164 条数据本身几乎免费。
本仓重读一次动作流 ≈ 38ms，用户感知不到；10 万条时地板之上还要加 git log 与 24MB 传输
（上游实测热读 166ms）。

### 三、堆与解析（本仓实测 + 10 万行克隆实测）

| 项 | 164 行 | 10 万行 |
| --- | --- | --- |
| rows 常驻 | 153.9KB（961B/行） | 78MB（rows + fold） |
| fold 额外 | 49.1KB（307B/行） | — |
| 逐行 `JSON.parse` | 0.2ms | 58.4ms |
| `foldIssues` | 0.3ms | 61.1ms |
| 每批发布 `slice`+`Map` | 0.1ms | 4.2ms |
| `JSON.stringify(rows)` | 0.1ms / 40KB | 75.9ms / 24.6MB |

两个容易记错的换算：

- **396B/行是原始 NDJSON**（带 `refs` / `target` / `scope`，v0.4.0 的字段全在）；客户端 rows 只留
  8 个字段，序列化后约 **244B/行**，10 万行 ≈ 24MB。所以“缓存 rows 再发一遍”的传输量比
  “重跑 git log”小得多——但**原始行和 rows 不能同时留**：两份一起量到 176MB 峰值。
- `foldIssues` 给每个动作**再建一个对象 + 一个 `refs: []` 数组**，额外 307B/行；10 万行就是 30MB。
  这就是“不留多份”的具体所指。

### 四、现状在三处漏，另有一处小毛病

1. **动作流零缓存**：切页即重读。本仓 38ms；10 万条 166ms + 24MB + 50ms fold，且流式期间每 50ms
   全量重折一次。
2. **详情 / 搜索只有客户端缓存**：F5 后第一个焦点、第一句搜索都要各起一次进程（约 37ms）。
3. **词表缓存不随刷新失效**：`clearRepoCaches` 清了图/详情/搜索，没清 `actionsCache`，词表 effect 的
   依赖里也没有 `nonce`——改了 `.kilnconfig.jsonc` 的 terminal 词表后，done 状态要等整页刷新才更新。
   宿主那份是按 `configToken` 键控的，只是客户端不再问。
4. 宿主 `/kiln/timeline` 支持 `?limit`（`index.js:205`），客户端从没传过。本轮**不建议**打开：
   issue 页的 done 与序号要全史才对，截断会把它们算错。

### 五、优先级（按“每次交互省多少”）

| 次序 | 缓存什么 | 省什么 | 代价 |
| --- | --- | --- | --- |
| 1 | 动作流 rows：客户端模块级 + 宿主，HEAD 键控 | 切页 / 换会话不再起进程，也不再传 24MB | 78–120MB 堆（10 万行），必须有上限 |
| 2 | 宿主详情（HEAD 键控） | F5 后首个焦点 37ms | 很小（KB 级） |
| 3 | 词表失效修正 | 配置改动立即可见 | 一行 |
| 4 | 流式期间增量折叠 | 10 万条每批 50ms 的主线程卡顿 | 折叠逻辑变复杂 |

搜索不进这张表：查询词本身就是新的，缓存只在“同一个词再查一次”时有用，现有客户端缓存够了。

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

## 选型假设（hypothesize）

前提是一条便宜的事实：**探 HEAD 不要钱**。`readHeadFast` 直读 `.git/HEAD`（`git.js:68-89`，实测 ~2ms），
不需要 spawn；贵的是“没变也把 24MB 再搬一遍”。所以问题不是“要不要每次问一句”，而是“问完能不能不搬”。

### 三个候选

| 维度 | A：只缓存宿主 rows | B：只缓存客户端 rows | C：两层 + 协议 |
| --- | --- | --- | --- |
| 切回标签（HEAD 未变） | 一次全量 HTTP + parse + fold | 探测 HEAD 后直接用本地 | 2ms 探测，0 传输 |
| F5 / 换会话 | 宿主还在，直接重发 | 全量流（34–166ms） | 重发一次，之后恢复 |
| 新提交之后 | 全量重跑 `action log` | 全量流 | 只读新前缀（增量） |
| 常驻堆（10 万行） | 78MB（宿主） | 78MB（浏览器） | 156MB，阈值要更严 |
| 实现量 / 风险 | 小 / 低 | 中 / 中 | 大 / 中 |

单看某一次切页，B 最省（连 HTTP 都省）；但它不知道数据新不新，必须靠 A 的 HEAD 探测；
而 A 没有 B 的话，每次切页仍要搬 24MB。**两者缺一都只解决一半**，但可以分期落地，每阶段自身可用。

### 推荐：C 的做法，分三个阶段，每期独立可回退

| 阶段 | 做什么 | 拿到的收益 | 验收 |
| --- | --- | --- | --- |
| 1 | 宿主 rows 缓存，HEAD 未变直接按原 NDJSON 重发 | 不再起子进程（省 34–166ms） | 切页时 `x-kiln-mode: hit`，宿主子进程数 0；HEAD 变了走 build |
| 2 | 客户端模块级 rows + `?head=` 协议（unchanged / full） | 切页 0 传输、0 parse、0 fold | 切页时无请求体传输，页头显示 cache 命中 |
| 3 | 宿主前缀增量（HEAD 前进只读新前缀） | 新提交后也是 ~40ms，不是 166ms | 新加 1 条动作后 `x-kiln-mode: delta`，只发新增行 |

阶段 4（可选，暂不做）：客户端已持有旧 rows 时只发差集（delta 传输）。它只省“有新提交那一次”的 24MB，
而阶段 2 已经把最常见的情况（没新提交）降到 0；先量再决定。

### 阶段 2/3 的协议

```text
GET /kiln/timeline?cwd=<repo>[&head=<客户端持有的 HEAD>][&fresh=1]
  x-kiln-mode: full | unchanged | delta | bypass
  x-kiln-head: <本次看到的 HEAD>
  x-kiln-rows: <本次发出的行数>
```

- `unchanged`：空 body，客户端保留本地 rows，只更新耗时；
- `delta`：body 是**新前缀**（倒序，最后一行紧邻客户端已知的第一条），客户端 prepend；
- `full`：整个流，客户端替换；
- `bypass`：仓库超限或 HEAD 探测失败，按老样子流式读，客户端不写缓存。

客户端合并按 sha 去重（`existing.has(row.id)`），**不按日期**：同秒多条只靠 sha 定序，日期只用于显示。

### 增量算法（阶段 3）

前置：宿主缓存 `{ head: Hc, rows }`、`binToken` 相同、`readHeadFast` 得到 `Hn`。

1. `Hn === Hc` → `unchanged`，收工。
2. `Hn !== Hc` → 跑一次 `git merge-base --is-ancestor Hc Hn`（只在 HEAD 变化时跑，约 15–30ms）：
   - 非祖先（rebase / amend / force-push）→ `full` 重建；
   - 是祖先 → 继续。
3. 起 `action log --jsonl`，边收边比：收到 `row.id === rows[0].id`（缓存里最新那条）即停，kill 子进程，
   把新前缀 prepend 到缓存，`head = Hn`。
4. EOF 都没撞上 → 缓存的第一条已被改写/裁剪 → `full` 重建。

**已知漏洞（要写进文档，不装看不见）**：cherry-pick / rebase 会保留**旧 author date**，这种新提交在
author-date 倒序里排在 boundary 之后，前缀读法看不到。`merge-base` 只能挡住改写，挡不住这种。
在拿到上游 `--since` / 范围查询之前，这是信息上限；缓解是「刷新 = 清双端 + full」，
以及第一次发现 `Hn !== Hc` 时**总是**至少跑一次完整校验（可配置关掉）。

### 容量与降级

- 单仓上限：**50,000 行 / 20MB 原始 NDJSON**（客户端 rows 序列化后约 12MB）。
- 超限 → `bypass` 并记 `oversize`（本会话不再尝试；HEAD 或 binToken 变化时重置）。行为**等于今天**。
- 不做“只缓存首屏 N 条”：issue 页的 done 与序号要全史，截断的 rows 会让 `foldIssues` 算错，
  比没缓存更糟。也不做“首屏 + 新前缀”的混合态，理由相同。
- 双端预算：宿主最多 2 个仓（按最后访问 LRU），客户端只留当前仓。5 万阈值下双端合计约 78MB，
  10 万行会到 156MB —— 所以阈值按下限取，不按“能放得下”取。
- 不存原始 NDJSON：多 25MB / 10 万行，而 parse 只要 58ms。
- 不存 fold 索引：10 万行 61ms，memo 在 rows 身份上就够（`React.useMemo` 已经这么做）。

### 估算（实测外推）

| 规模 | rows 传输 | 每层堆 | 全量流 | HEAD 命中 | 增量（+1 条） |
| --- | --- | --- | --- | --- | --- |
| 1 万 | 2.4MB | 7.8MB | ~40ms | ~2ms | ~40ms + 2.4KB |
| 5 万 | 12MB | 39MB | ~83ms | ~2ms | ~40ms |
| 10 万 | 24MB | 78MB | ~166ms | ~2ms | ~40ms + 0.1MB |

验证方式：`probe-memory.mjs` 的克隆行给堆与 fold；假子进程 stub 进 `run.mjs` 测协议分支
（unchanged / delta / fallback / bypass）；真仓再用页头 `x-kiln-mode` 复核。

### 与现有缓存、刷新的关系

- 图缓存（`snapshot.js`）不动：同样是 HEAD+config+bin 键控，但它没有“增量”这一层；
  timeline 的决策函数可以复用它的形状（`evaluateCache` 的返回多加一个 `changed` 分支）。
- 详情 / 搜索不进这套：37ms/次、KB 级，收益与复杂度不匹配，留作后续小改动。
- 刷新按钮：清双端 + `?fresh=1` → 保证 user 能拿到真数据；这也是增量漏洞的自愈通道。
- 词表：顺手把 `actionsCache` 纳入 `clearRepoCaches`（或让词表 effect 依赖 `nonce`）。
- 虚拟列表无关：它只管 DOM，rows 有多少由缓存决定。

### 风险与回退

1. **增量漏行**（back-dated 提交）→ 刷新自愈；文档写明，不假装没有。
2. **双份内存** → 50k 阈值 + `bypass` + 页头可见，超限就退回今天的流式。
3. **半截缓存**：只在收到 `done` 事件（流完整）后才提交缓存，中途失败不写。
4. **kill 时机**：撞到 boundary 立刻 kill，走现有 `res.close → child.kill` 路径，不新开机制。
5. **一键回退**：宿主 `DSH_KILN_TIMELINE_CACHE=off`（等价于 `bypass`），客户端 `?fresh=1`；不动配置文件。
6. **升级 kiln**：`binaryToken` 变化 → 双端丢弃，重新全量。

### 明确不做

TTL（能精确探测就不猜）、落盘（破坏“不落盘”）、原始行缓存、fold 索引缓存、分页 UI、上游改接口。

**一句话结论**：先做阶段 1（不再起进程），再做阶段 2（不搬字节），阶段 3 视真实提交频率决定；
三者都能单独上线、单独回退。

## 落地（阶段 1，插件 0.10.0）

只做阶段 1：**宿主记住动作行，HEAD 没动就不起子进程**。客户端协议（`?head=`）与前缀增量都没动。

### 改了什么

| 文件 | 改动 |
| --- | --- |
| `plugin/lib/rowsCache.js` | 新增。`evaluateRowsCache` 纯决策 + `createRowsCache` 存储：`(repo, HEAD, 配置令牌, 二进制令牌)` 四元组；5 万行 / 20MB 上限；`hit`/`build`/`bypass`；最多留 2 个仓 |
| `plugin/lib/timelineHandler.js` | 新增。路由实现体：`hit` 从内存按原 NDJSON 重发（带背压）、`build` 边流边 tee 并在**读完后**提交、`bypass` 与无缓存时逐字节一致 |
| `plugin/lib/index.js` | 路由改为委托 handler；新增 `fresh=1`、带 `limit` 时强制 `noCache`、`DSH_KILN_TIMELINE_CACHE=off` |
| `plugin/lib/client.js` | 修词表失效：`clearRepoCaches` 一并清 `actionsCache`，词表 effect 依赖加 `nonce`（改 terminal 词表后刷新即生效） |

响应头 `x-kiln-mode`（`hit|build|bypass`）与 `x-kiln-head` 用于排障；`done` 事件多一个
`cache` 字段（`hit|stored|oversize|skip|head-unavailable`），客户端忽略未知字段，不用改。

### 边界与取舍（照 hypothesize 执行）

- **HEAD 变了就全量重读**：阶段 1 不做前缀增量，宁可多读一次也不冒漏行的险；
- **超限不存半截**：超过 5 万行 / 20MB 就 `markOversize`，本会话对该仓一直 `bypass`（换 kiln 二进制后重试）；
- **不存原始 NDJSON、不存折叠索引**：只留客户端要的 8 个字段；
- **带 `limit` 的请求永不进缓存**：缩水结果不能顶替全量；
- **配置令牌也参与失效**：`action log` 是否受词表影响没有上游保证，保守一点只多写一个 statSync。

### 验证

- 宿主用例 **67 个**（原 59 + 新增 8）：决策表 7 种输入；构建→命中零子进程；HEAD 前进重建覆盖；
  超限转 bypass 且不留半截；`enabled=false` 与带 `limit` 都 bypass；`fresh` 重建并写回；
  客户端断开即 kill 且不再写；LRU 只留 2 个仓。
- 渲染用例 58 个照常通过。
- 真仓（HEAD `9cf4393`）：`cold → build`、写回后 `again → hit`、`fresh → build`、`off → bypass`，
  `readHead` 直读 `.git/HEAD` 拿到真 sha。
- 实测口径来自 `probe-memory.mjs`：取数 37.8–45.9ms / 63.5KB，其中 `--limit 1` 也要 33.8ms，
  所以命中时省下的正是这 34ms 起的固定成本。

### 还没做（后续期）

- 阶段 3：HEAD 前进时的前缀增量（停止条件、`merge-base` 前置、EOF 未见 boundary 回退）；
- 阶段 4（可选）：客户端已持有旧行时只发差集（delta 传输）；
- 宿主详情缓存与流式增量折叠（优先级见「本仓实测」第五节的 2、4 位）。

## 落地（阶段 2，插件 0.11.0）

客户端也留一份行，并记住它对应的 HEAD；下次进标签时先用手上的行渲染，再带 `?head=` 问一句——
宿主回 `unchanged` 就**一个字节都不传**。

### 改了什么

| 文件 | 改动 |
| --- | --- |
| `plugin/lib/client.js` | 新增 `timelineCache` + `rememberTimeline`（5 万行 / 20MB / 2 个仓，与宿主同口径）；时间线 effect 先渲染缓存、请求带 `&head=`；`unchanged` 直接保留本地行；有缓存时**流式期间不发布**，`done` 一次性替换（不闪半截）；出错时保留缓存行 + 错误；`clearRepoCaches` 连它一起清 |
| `plugin/lib/timelineHandler.js` | 新增 `reusable` 判定：`clientHead === 当前 HEAD` 且不是 `fresh` / 配置变化 / 二进制变化 → `x-kiln-mode: unchanged`、空 body |
| `plugin/lib/index.js` | 路由解析 `?head=` 并透传 |

### 语义

- **命中条件**：客户端 HEAD = 当前 HEAD，且没有换解析口径（配置 / 二进制）或点刷新；
  配置一变即使 HEAD 相同也整份重发——客户端那份的 done 语义可能过时。
- **不闪**：有缓存时，新流在后台读，读完才替换列表；切页看到的是“上次那份 + 2ms 探测”，
  不是空列表，也不是半截流。
- **失败不砸**：探测或读取失败时继续显示缓存行，并把错误挂在页头（错误不掩盖可用数据）。
- **省在哪**：命中时只有一次 HEAD 直读（约 2ms）和一次空响应；省掉的是 24MB 传输
  （10 万行）与 58ms 的逐行 parse。

### 验证

- 宿主用例 **71 个**（阶段 1 的 67 + 新增 4）：`unchanged` 空 body 零子进程；客户端 HEAD 过期回全量；
  配置变化即使 HEAD 相同也重发；客户端缓存的行数/字节上限、LRU 2 仓、刷新清除。
- 渲染用例 58 个照常。
- 仍未验证的（要真机）：切页时 `unchanged` 的实际观感、F5 后首次全量再命中的节奏——
  需要重启宿主后在浏览器里看 `x-kiln-mode` 与页头耗时。

### 还没做（阶段 3 之后）

- 宿主详情缓存、流式增量折叠。

## 落地（阶段 3，插件 0.12.0）

HEAD 前进时不再整条重读：只要**能证明前缀是安全的**，就只读新前缀、拼在缓存前面；
证明不了就退回全量。delta 也一并做了——客户端手上正好是缓存里那一份 HEAD 时，只发新增行。

### 为什么“证明”是必须的

kiln 的 `action log` 用 `git log --author-date-order`（`internal/cli/enum.go`）：
父子关系保证子在前，但**旁支提交只按 author date 排**。用本仓之外的临时仓实测（脚本在提交前跑过）：

```text
N 2020-01-04      ← 把 side2 合进来
M 2020-01-03
B 2020-01-02      ← 旧 HEAD（缓存首行 boundary 就是它）
C 2019-06-01      ← side 分支（A 的子，早日期）
D 2019-01-01      ← side2 分支（A 的子，更早日期，与 boundary 无父子关系）
A 2020-01-01
```

`D` 排在 `B` 之后。如果只靠“读到 B 就停”，`D` 这一行就永久漏掉了——正是“漏行比缓存失效严重”
的那种情况。所以增量前置里必须有一条：**`旧 HEAD..新 HEAD` 区间内所有提交的 author 时间
都严格晚于缓存首行的日期**（`git log --format=%at`），否则全量。日期相同时也不做（不赌并列顺序）。

### 增量判定（`rowsCache.planIncrement`，缺一即全量）

1. 本次是 `head-moved`，且缓存行数 ≥ **5000**（小仓全读约 40–60ms，两次 git 探测反而更贵）；
2. `git merge-base --is-ancestor 旧HEAD 新HEAD` 成立（否则历史被改写，缓存里可能是幽灵行）；
3. `git log --format=%at --max-count N 旧HEAD..新HEAD` 的最小 author 时间 **严格大于** 缓存首行日期；
4. 区间提交数 ≤ **2000**（再多就不比全量便宜）。

任何一步报错、超时、返回不确定 → `full`。**判定本身只有两三次 git 调用，不解析任何 trailer**
——插件仍然不碰 kiln 的状态语义。

### 执行路径（`timelineHandler.runIncremental`）

- 新行先**攒在内存**，撞到 `boundary`（缓存首行的 sha）才写响应；没撞到就整段丢弃、回退全量。
  这样客户端**永远收不到半截新行**。
- 撞到后 kill 子进程，`rows = 新行 + 缓存行`，`head` 换成新 HEAD，写回缓存。
- `delta` 条件：请求里的 `?head=` 正好等于缓存里的旧 HEAD → 只发新行，客户端 prepend。
- 拼起来超限（>5 万行 / 20MB）也回退全量，由全量路径记成 oversize。

### 客户端

`mergeTimelineRows(newer, older)`：新行在前、按 sha 去重（不按日期——同秒多条只有 sha 定序）。
`delta` 响应读完后合并、重存；失败退化为全量替换。

### 验证

- 宿主用例 **80 个**（+9）：增量成功（行序 `新, 旧…` 且缓存被覆盖）、`delta` 只发新增、
  **回退日期拒绝增量**、**非祖先拒绝增量**、**EOF 未见 boundary 回退全量**（一次失败 + 一次全量）、
  **读前缀期间 HEAD 又动 → 判定过期回退全量**、区间过大拒绝、缓存太小连探测都不发；
  客户端 `mergeTimelineRows` 的四种输入。
- 渲染用例 58 个照常。
- 排序假设的实测证据就是上面那段 `author-date-order` 输出（临时仓已删）。

### 剩余风险与回退

- 判定依赖 author date；若提交来自时钟漂移的机器，最坏情况是被判成“不安全”而多读一次，
  不会漏行。两个 git 调用与读取之间还可能有人提交：读完再读一次 HEAD，变了就退回全量
  （这几十毫秒的窗口也用 2ms 的直读封住了）。
- 真正的漏行只可能来自判定逻辑本身出错（例如上游把排序从 `--author-date-order` 换掉）。
  这种时候最坏也只是漏新行，**刷新自愈**（刷新 = 清双端 + 全量）。
- 一键回退：`DSH_KILN_TIMELINE_CACHE=off`。
