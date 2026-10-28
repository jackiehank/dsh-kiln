# kiln-input-streams — 时间线之后，剩下哪几路输入还在整份缓冲

- **domain**：integration
- **关联**：part-of `kiln-many-issues`；relates-to `kiln-v030-adapter`（时间线流已落地）、
  relates-to `kiln-perf-snapshot`（快照的取数成本）

## 问题

`kiln-v030-adapter` 把时间线改成了流式：宿主 spawn `kiln action log --jsonl`，一行一个动作，
边读边发，EOF 收口。于是 `kiln-many-issues` 里“timeline 流”那一项不再欠账。

但**插件还有四路输入是整份缓冲**，它们各自在什么规模下开始疼、该用流式还是分页、上游缺什么、
插件侧要不要改传输，都还没定：

| # | 输入 | 产出方 | 插件怎么用 | 现在的形态 |
| --- | --- | --- | --- | --- |
| 1 | **索引** `kiln list --json` | 上游 `writeJSON` | 将来做 issue 列表窗口 / 按最近排序 | 一份 JSON 文档；无 `date`、无 `limit/offset` |
| 2 | **关系图** `kiln graph --json` | 上游 `writeJSON` | 关系页全局图；快照的节点与边来源 | 一份 JSON 文档；`--issue/--depth` 只是收窄输出，**仍 build 全仓** |
| 3 | **详情** `kiln path <id> --json` | 上游 `writeJSON`（单条） | 按需详情（还没做）/ issue 页动作链 | 一份 JSON 文档；一个 issue 的动作越多，单条文档越大 |
| 4 | **插件传输** `GET /kiln/flow` | 宿主组装 | 三页的 `issues + edges` 快照 | 一份 JSON 文档，HEAD 变了整份重发 |

时间线已经证明“NDJSON + 逐条 flush + 断连即 kill”在插件里可行；现在要回答的是**其余四路是否值得照做**，
还是“上游给窗口/分页 + 宿主只取一页”更划算。这不是纯上游问题：既可能上游加 `--jsonl/--limit`，
也可能插件自己分帧，两条路的代价与验收差很多。

## 现状与边界

- 流式不是免费的：一行一行发意味着**没有“完整文档”可言**，收口要靠 EOF/退出码；
  如果消费方需要“总计 / 排序 / 筛选”，全量仍然跑不掉，流式只买到“首屏早一点”。
- 索引天然要全量才能排序与筛选；`list --json` 缺 `date`（按最近排序）与 `limit/offset`（翻页），
  这两项是 `kiln-many-issues` 已经点名、v0.3.0 复验仍缺的上游缺口。
- 关系图页在 100k 时**画不出来**（不是传输慢，是布局不可读）。这一路要讨论的可能不是“流式”，
  而是“全局图降级成统计 / 只画焦点邻域”。
- 详情这一路要先有端点（`GET /kiln/issue`），才谈得上它的传输形态；它同时决定
  “快照外的 issue 能不能聚焦”（见 `kiln-v030-adapter` 的已知代价）。
- 约束照旧：只读、不落盘、不在插件里复刻 kiln 的解析、数据只走 `kiln <cmd>` 子进程。

## collect（2026-10-28）：四路输入的量级与上游实现

### 1. 实测（kiln v0.3.0，`~/kiln`：70 issue / 350 动作；耗时是 5 次中位数）

| 输入 | 字节 | 折合 | 中位耗时 |
| --- | --- | --- | --- |
| `list --json` | 22,920 | 327 B / issue | 111 ms |
| `graph --json` | 33,576 | 480 B / issue | 114 ms |
| `graph --issue action-log --depth 1 --json` | 2,414 | 3 节点 / 2 边 | **114 ms** |
| `path action-log --json` | 4,351 | 单条 issue | 115 ms |
| `path --all --json` | 168,106 | 480 B / 动作 | 148 ms |
| `action log --jsonl` | 100,768 | 288 B / 动作 | 115 ms |
| `list --search=kiln --json` | 17,490 | 命中数决定 | 111 ms |

本仓（22 issue / 146 动作）同口径：`list` 7,484 B / `graph` 10,410 B / `path --all` 74,324 B /
`action log` 41,834 B；小仓上四路的耗时都落在进程启动的 ~100ms 地板上，**看不出字节数的影响**。

外推到 100k（按上面每行/每动作的实测比例，不是旧估算）：

- `list --json` ≈ **32 MB**（0.33 KB/issue）；
- `graph --json` ≈ **48 MB**（0.48 KB/issue）；
- `path --all` ≈ **48 MB**（0.48 KB/动作）；
- `action log --jsonl` ≈ **29 MB**，已经是流式，宿主不整份拿。

**修正**：`kiln-many-issues` 里写的「100k 索引 17MB」与这里的 32MB 对不上——那个 17MB 是当时
按 64 issue 的粗估，这次按本机逐条实测比例重算，以本表为准；结论（索引是最大的一路整份文档）
不变，只是量级更大。

### 2. 上游实现（v0.3.0，`internal/cli/cli.go`）

- `writeJSON` 的注释就是「one document on stdout」（`cli.go:3108`）——`list` / `graph` / 单条 `path`
  都走它：先在内存里拼完整份，再一次性写。
- `list --json` 先建全量 `rows` 再 `writeJSON`（`cli.go:2706` / `cli.go:2730`）；`listIssue` 没有 `date`；
  `--limit` 只服务 `action log`（`cli.go:1258`，`list --limit` 在测试里明确被拒：`cli_test.go:2246`）。
- `graphJSON` 先 `engine.IDs` + `FoldEdges` 把**全仓**折好，`--issue/--depth` 的裁剪发生在之后
  （`cli.go:2915`–`2931`），再 `writeJSON`（`cli.go:2965`）——这解释了为什么 `graph --issue`
  的输出只有 2.4KB、耗时却和全图一样（114 vs 114ms）。
- `path --all` **已经有流式 writer**（`pathBatchWriter`，`cli.go:1873`）：按 issue 逐个写进 64KB
  `bufio`，不再把整份文档憋在内存里；但单条 `path` 仍走 `writeJSON`（`cli.go:1823`）。
- `action log` 是真正的逐条 sink，`--limit` 用尽或消费方消失都能停扫（`cli.go:1344`）。

也就是说：上游已经证明「行式文档 + 边读边写」能做（`path --all` 的 writer、`action log` 的 sink），
但只用在两处；`list` 与 `graph` 还是整份，且 `list` 连分页与 `date` 都没有。

### 3. 对四路的直接含义

- **索引**：唯一同时缺 `date`、`limit/offset`、流式的输入。100k 时 32MB 要先进宿主内存再解析；
  「窗口 + 分页」比「流式」更贴近它的用途（列表要排序、要总数、要筛选完整性）。
- **关系图**：字节随 issue 线性，但更麻烦的是「全仓构建 + 布局不可读」。`--issue` 省不掉构建
  （实测同耗时），所以这一路的结论很可能是**大仓降级**，而不是把 `graph --json` 改成 NDJSON。
- **详情**：单条典型 4KB，整份就够；只有「一个 issue 上千动作」时才值得一动作一行，属于边角。
- **快照传输**：`/kiln/flow` 的 payload = 全图 + 80 条 `path`，本仓 10KB 级、`~/kiln` 74KB 级，
  **不随仓规模爆**（80 是硬上限）；它的问题是「HEAD 一动整份重发」，属于缓存帧，而不是流式。

## 要回答的问题

1. **尺子**：每一路输入，按什么指标判定“必须改”？首字节时间、首个可用屏、总时长、宿主/浏览器峰值内存，
   还是“能否在数据到齐前给用户可用内容”？给出各路的阈值（例如 100k 合成仓）。
2. **索引**：`list --json` 该加 `--jsonl`、`--limit/--offset`、还是 `--count`+窗口？
   插件侧“宿主窗口 W=100”与前端虚拟滚动分别解决哪一段？
   排序需要 `date`，这个字段放 `list` 行还是让插件按 `action log` 补？
3. **关系图**：全局图在大仓还画不画？若不画，降级形态是什么（统计/领域簇/只画焦点邻域）？
   `graph --issue` 要不要上游做“低成本邻域”（不 build 全仓），还是接受现在的 build 成本？
4. **详情**：`GET /kiln/issue` 的契约（`path` + `graph --issue --depth` 并发？分帧？LRU 键？）；
   单条 `path` 在“动作特别多”的 issue 上要不要 NDJSON（一动作一行），还是整份就够？
5. **插件传输**：`/kiln/flow` 要不要也变成 NDJSON（`nodes` 帧 / `edges` 帧 / `done`）？
   还是等上游分页后“只发一页”，保持单文档？两种方案对快照缓存（HEAD 失效、增量）的影响分别是什么？
6. **优先级**：四路里先做哪一路？以“用户能感知的收益 / 上游依赖是否就绪 / 改动面”排序，给出理由。

## 非目标

- 不改时间线（`kiln action log --jsonl` 已定稿，这次不回头）；
- 不做落盘缓存 / 本地数据库；
- 不改搜索语义（`list --search` 的 rank / hit / 顺序仍归 kiln）；
- 不在这个 issue 里写实现；实现按结论另开 `apply`（或在本 issue 继续动作）。

## 验收（讨论出方向后）

- 四路输入各有一句结论：流式 / 分页窗口 / 保持整份（含“大仓降级”），并写明依据；
- 上游缺口清单（命令、字段、参数、退出码语义）与插件侧改动清单分开列；
- 至少一次真实规模实验：1k / 10k / 100k 合成仓上量首字节、首个可用屏、总时长、峰值内存；
- 给出执行顺序与依赖关系，能直接拆成后续 issue。
