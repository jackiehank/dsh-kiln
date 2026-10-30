# kiln-cache-budget — 动作流缓存的容量默认值：总预算而不是每仓乘法

## 问题

动作流缓存现在有两条上限，宿主与客户端各一份：

- `plugin/lib/rowsCache.js:26` `ROWS_LIMIT = 50_000`、`:27` `BYTES_LIMIT = 20MB`，`:29` `REPO_LIMIT = 2`；
- `plugin/lib/client.js:72` `TIMELINE_CACHE_ROWS = 50_000`、`:73` `TIMELINE_CACHE_BYTES = 20MB`。

容量是按**每仓**给的，而 `REPO_LIMIT = 2` 让它变成**乘法**：两个大仓就是 2 倍。

后果在 100k 动作的仓上最明显：整条流约 **26MB**、10 万行，两条上限都越界，两端都判 `oversize`，
之后每次挂载都全量流式（暖读 166ms + 26MB 传输 + 53ms 解析 + 28ms 折叠 ≈ 0.25–0.3s），**每次都要付**；
而一个 100k 仓其实完全值得驻留——HEAD 不变时切页本该 0 字节。

抬高上限又会撞另一头：宿主是 DSH 服务进程，**长命、跨会话共用**；浏览器标签是另一个进程。
按已测的每行成本，100k 行两端合计约 100MB+/仓，两仓就 200MB+。默认值定错，用户要么慢，要么卡。

## 已有的证据（2026-10-30 实测）

本仓 170 行，克隆到 10 万行后测（`node --expose-gc`，与 `plugin/test/probe-memory.mjs` 同一套方法）：

| 项 | 数字 |
| --- | --- |
| NDJSON 体积 | 100k 行 **26.1MB**（本仓 399B/行） |
| rows 常驻堆（宿主形态） | 322 B/行（克隆共享了部分字符串；真实约 400 B/行 → ~40MB） |
| rows + fold 常驻堆（客户端形态） | 502 B/行 → ~50MB（fold 171 B/行，15.9k issue） |
| parse / fold / stringify（100k） | 53ms / 28ms / 68ms |
| 首次构建峰值 | 探针 170MB（含 stringify 副本；真实流式会低一些） |
| 现行绕过时的每次挂载 | kiln 暖读 166ms（上游 v0.4.0 数字）+ 26MB + parse 53ms |

上游 v0.4.0 之后读耗时与仓大小无关（本仓 36ms、`~/kiln` 36ms，都在 node 起进程地板），
所以容量问题**只剩内存与传输**，不再有“读得太慢”这一项。

## 约束

- **不给用户配置项**：不新增环境变量、不加设置 UI。默认值要按测得的事实自适应；
  唯一的“关断”仍是已有的 `DSH_KILN_TIMELINE_CACHE=off`（诊断用，不是常规配置）。
- 不落盘（与整仓一致）；不做跨进程共享内存。
- 宿主与客户端各自独立计算，不要求两边同一时刻做同一决定（现有 `hit/unchanged/…` 协议不变）。
- 只读，不碰上游；分页/索引已由 `kiln-many-issues` 判为不做。

## 要回答的问题

1. **“够用”怎么定**：一台机器通常同时开几个 kiln 仓？宿主多留 40–80MB、浏览器多留 50–100MB 可接受吗？
2. **容量表达**：从“每仓上限 × 仓数”改成“**总预算，跨仓 LRU**”？预算取多少——
   固定值（如 128MB）、还是按 `os.totalmem()` 比例（不配置也算自适应）？
3. **超预算时的降级**：淘汰最旧仓、还是把小仓也降级？必须是“少缓存”而不是“报错/空页”。
4. **要不要先做紧凑存储**：`short`/`action`/`domain` 大量重复，驻留或打包能把 400B/行压到 ~250B/行，
   省下的是内存而不是代码；值不值得为它改 rows 形状（会影响 `delta` 合并与测试）？
5. **峰值控制**：流式构建时的临时对象、以及客户端每批 `foldIssues` 为 O(n)（10 万每批约 50ms，
   已在 backlog）要不要一起处理？
6. **与增量门槛的配合**：100k 仓保留 5 万行以上时，`incremental` 的 5000 行门槛与 2000 提交上限
   是否仍合适？

## 非目标

- 不做用户可见配置（环境变量、设置页、配置文件都不加）。
- 不做分页 / 截断输出（上游 `issue-list-scaling` 已否决 `--limit`）。
- 不做持久化缓存。
- 不改变现有缓存协议（`hit/unchanged/incremental/delta/bypass`）与安全判定。

## 验收

- 用 100k 行 fixture 直接喂宿主 handler（不必造 10 万提交的 git 仓）：首次流式 ≤0.4s；
  HEAD 未变时挂载 **0 字节**；两端常驻不超过设定预算。
- 两个 100k 仓来回切：总常驻不超预算，淘汰可观测（`stats` 有记录），不出现空页/错误。
- 小仓（本仓 170 行）：行为、内存、首屏与现在一致，缓存命中路径不变。
- 单仓超过总预算：该仓单独降级为每次流式，**另一个仓的缓存不受影响**。
- `run.mjs` / `render.mjs` 覆盖：预算淘汰、单仓超限降级、两仓并存、100k fixture 的往返正确。
- 文档写明默认预算值与理由（数字来自探针，不是拍的）。

## collect（2026-10-30）：现在缓存里到底存的是什么形状

复现：`node --expose-gc plugin/test/probe-format.mjs`（把真实行克隆到 10 万行，逐变体 gc 后取堆增量）。

### 1. 两端各存一份

- **宿主**（`rowsCache.js:73`）：`repo → { head, configToken, binToken, rows, bytes }`；
  `rows` 是 `mapActionRecord()`（`timeline.js:46`）产出的 **8 键对象**数组：
  `issueId / action / id（40 位）/ short（7 位）/ date（25 字符）/ title / domain / tags[]`。
  命中时逐行 `JSON.stringify({ kind: 'action', ...row })` 重发（`timelineHandler.js:218`），
  `bytes` 记的是**线上字节**，不是堆占用。
- **客户端**（`client.js:80`）：`timelineCache` 再存同一批行对象；另外 `foldIssues` 为每个动作
  **另建一个对象**塞进 `issue.actions`（`client.js:1054`）。所以浏览器里是 rows + fold 两半。

### 2. 100k 行实测矩阵

数据分布：171 条真行 → 28 issue / 6 个动作 / 2 个 domain / 14% 行带 tags；平均 title 51.6 字（中文）、
id 40、date 25、issueId 18.6。克隆后每行 id/title/date 唯一，其余文本重复（与真仓同形）。

| 变体 | 常驻堆 | B/行 | build | serve（每次重发） | 线上字节 |
| --- | --- | --- | --- | --- | --- |
| A 现状：8 键对象 | 47.6MB | 499 | 50ms | 74ms | 31.9MB |
| B 去 `short`、空 `tags`→null | 41.9MB | 439 | 54ms | 76ms | 32.0MB |
| B2 B + 驻留 issueId/action/domain（tags 存串） | 31.6MB | 331 | 66ms | 67ms | 32.1MB |
| B3 B + `date` 存 epoch 毫秒 | 37.6MB | 395 | 68ms | 129ms | 32.0MB |
| C B2 + B3 | 28.5MB | 299 | 77ms | 126ms | 32.0MB |
| D 数组行（7 槽） | 30.8MB | 323 | 85ms | 125ms | 32.0MB |
| F 列式（7 条平行数组） | 24.7MB | 259 | 83ms | 126ms | 32.0MB |
| G 数组行 + **数组线上格式** | 30.8MB | 323 | 82ms | **58ms** | **22.2MB** |
| E 原始 NDJSON 行（JS 字符串） | 51.6MB | 541 | 27ms | 16ms | 28.8MB |
| H 原始字节（Buffer/行） | external 29.6MB + heap 10.8MB | 302 | 53ms | ≈0 | 22.9MB |
| H2 原始字节（一整块 Buffer） | external 28.8MB | 302 | 41ms | ≈0 | 22.9MB |

### 3. 归因（哪一刀最值）

- **驻留重复串**是最大的一刀：B→B2 **−108B/行**（28 个 issueId、6 个 action、2 个 domain 的重复文本
  在 10 万行里各占一份独立字符串对象），且 serve 不变（67ms 比 B 还略低）。
- 去 `short`（可由 `id` 推出）+ 空 `tags` 数组换 `null`：B−A **−60B/行**；86% 的行 tags 为空。
- `date` 换数字：**−44B/行**，但 serve **+55ms**——每次重发都要 `new Date(ms).toISOString()`。
- 数组行/列式再省 30–70B/行，但访问方式从字段名变成下标。
- **原始 NDJSON 当 JS 字符串存是最差选项**（541B/行）：含中文的行在 V8 里按两字节/字符存，
  240B 的字节行变成 ~480B 的字符串 + 头。这也印证了 `rowsCache.js:10` 的注释（不存原文）。
- 但**存字节**（Buffer）只要 22.9–29MB、serve≈0；代价是宿主不再持有可读行——增量判定要用的
  `boundary.id` / `boundary.date`、行数、HEAD 得另存，delta 也要按字节拼。

### 4. 客户端是双份：rows + fold

`foldIssues` 为每个动作建对象并复制字段（`client.js:1054-1063`），100k 行约 **14MB / 147B 行**（34ms）。
所以浏览器总占用 ≈ rows + fold：

- 现状：499 + 147 ≈ **646B/行 ≈ 63MB**（100k）；
- 只做 rows 紧凑（C）：299 + 147 ≈ 446B/行 ≈ 44MB；
- 若 rows 与线上都换数组（G）：同样 44MB，但线上 22.2MB（−31%）、重发 58ms（−16ms）。

### 5. 迁移面（形状一变全要跟）

- 客户端 3500 行里：`.id` 76 处、`.action` 26、`.title` 16、`.date` 15、`.domain` 12、
  `.issueId` 11、`.tags` 6；`mergeTimelineRows` 按 `row.id` 去重（`client.js:94`）；
- 增量判定读 `boundary.id` / `boundary.date`（`rowsCache.js:157-184`）；
- `foldIssues`、筛选、搜索跳转、渲染都按字段名取；
- 宿主 `timelineHandler` 的逐行 stringify；`run.mjs` 的 fixture payloads、`render.mjs` 的行对象。

### 6. 候选方向（留给 hypothesize 选）

1. **只紧凑行内**（驻留 + 去 short + tags 串 + date 数字）：499→299B/行（−40%），协议不动；
   serve 每次多 50ms，但只在 HEAD 变化时付。
2. **协议一起换数组**：G，323B/行、线上 −31%、serve 58ms；接口面与测试改动最大。
3. **宿主只存字节**：H，宿主内存 −40%~−50%、serve≈0；客户端仍解析成紧凑行；
   宿主不再有“行”，增量/delta 要重新设计边界。
4. **不做行紧凑，改 fold 增量**：省的是 CPU（每批 O(n)），不减常驻。

### 7. 与本文目标的关系

紧凑化要回答的是：**默认值能不能覆盖 100k**。以现状算，两端合计约 130MB/仓（63 宿主 + 63 浏览器）；
只做方向 1 降到约 90MB/仓；方向 3 能把宿主那半压到 30MB 左右，浏览器那半仍取决于 rows 形状。

