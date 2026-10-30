# kiln-v040-adapter — v0.4.0 默认开缓存、内部重构与 jsonl 新字段，插件哪些假设变了

- **domain**：integration
- **关联**：relates-to `kiln-v030-adapter`（上一次适配）、relates-to `kiln-input-streams`（第 2 步详情等这一轮判断）、relates-to `kiln-many-issues`（80 条上限与窗口的方向）

## 问题

kiln 于 2026-10-30 发布 v0.4.0（v0.3.0 之后 95 个提交）。CLI 面声称只有两条新命令
（`kiln cache gc` / `kiln cache clear`）和 `action log --jsonl` 的纯增量字段，无破坏性变更；但
**默认行为变了**——提交记录缓存默认开启，第一次读会写 `.git/kiln/`，之后的热读从「每次起 git 进程」
变成「解层 + 快照」。插件当前的设计数字与假设都建立在 v0.3.0 的冷读上：

- `/kiln/flow` 快照 = `graph --json` + 批量 `path`，DEFAULT_MAX_ISSUES=80；
- 时间线 = `action log --jsonl` 全量流；issue 列表 = 客户端折叠这条流；
- `kiln-v030-adapter` 与 `kiln-input-streams` 里记的「首行 ~0.1s」「list 111ms」都是冷读价；
- 插件只读、零残留：现在 `kiln` 自己会在 `.git/kiln` 留缓存（不是插件写的，但接手时要交代）。

需要先答清楚：v0.4.0 到底改了什么、性能提升在插件的调用形态（每次请求起一个新进程）里还剩多少、
`action log --jsonl` 的新字段是否让「快照外 issue 的详情/refs」不必再等上游。

## 非目标

- 本轮只收集与测量，不改插件代码；
- 不替用户决定是否清缓存、不把 `cache gc/clear` 接进 UI（是否接下一轮定）；
- 不做 100k 合成仓的独立复测（上游 `docs/perf-profile.md` 有 1k/10k/100k 全套；本轮以两个真仓为准，
  需要时再补）。

## 验收

- v0.3.0 → v0.4.0 的提交按「破坏性 / 性能 / 新字段 / 纯内部」分类，列出与插件相关的条目；
- 插件实际用到的命令（`graph --json`、批量 `path --json`、`action log --jsonl`、`list --json`、
  `list --search`、`action list --json`）在新旧二进制上输出逐字节一致，或在文档里写清差异；
- 两个真仓的冷/热读数字（本仓、`~/kiln`），以及缓存占用与首个请求的代价；
- 结论：插件哪些假设失效、哪些不受影响、`/kiln/actions` 与时间线要不要动版本声明。

## collect（2026-10-30）：99 个提交里，与插件有关的只有四条

上游发布说明（`~/kiln/docs/release-v040.md`）自己把 CLI 面收成「两条新命令 + 纯增量字段」，
本轮逐条验证并实测。v0.3.0 二进制用 `git archive v0.3.0` + 本机 `go1.27.0` 现编
（`go build ./cmd/kiln`），与已安装的 v0.4.0 交替跑同一命令；冷读 = `kiln cache clear`
之后的第一条读，热读 = 缓存命中。真仓两个：本仓 152 提交 / 24 issue / 151 动作，
`~/kiln` 462 提交 / 83 issue / 447 动作。

### 1. 变化分类

| 类别 | 内容 | 与插件的关系 |
| --- | --- | --- |
| 默认行为 | 提交记录缓存**默认开启**，落在 `<git-common-dir>/kiln/`（`records/` 层 + `enums/` 枚举快照）；每次 HEAD 前进写一层，64 层自动合并，枚举快照留最近 4 份；tmp 1 小时、旧指纹层 7 天自动清 | 插件仍不写任何文件，但**用插件就会让 kiln 写 `.git/kiln`**；每个 HEAD 的第一次读付一次全扫 |
| 性能 | 热读 0 个 git 进程：枚举快照 + 记录层；上游真仓 462 提交 warm 29ms、100k warm 185ms；冷读与 v0.3.0 持平 | 插件每次请求起新进程，恰好是这版优化的受益形态 |
| jsonl 字段 | `action log --jsonl` 追加 `refs` / `target` / `scope` / `relations` / `unrelate`（**声明形**，不折叠）；`title` / `domain` / `tags` 与顺序不变，仍无 `ordinal` | 时间线与 issue 列表都吃这条流；新增字段本插件暂未消费 |
| 新命令 | `kiln cache gc`、`kiln cache clear`；`--no-cache` / `KILN_NO_CACHE` 从未发布，现在是包内测试开关 | 插件不接：清缓存是用户维护动作，不是视图动作 |
| 纯内部 | `cli.go` 3,475 行拆成 21 个文件、`engine.Builder` 一趟建模、缓存解码器用字节游标 | 无 |

### 2. 插件用到的命令逐字节对照（新旧二进制，SHA-256）

两个真仓上 `graph --json`、`path --all --json`、`list --json`、`list --search=kiln --json`、
`action list --json` **全部逐字节相同**；只有 `action log --jsonl` 不同，且差异是纯增量：

- 行数、行序、`issue/action/commit/date/title/domain/tags` 全部相同（逐行比对）；
- 新增键只在有对应 trailer 的行出现，没有 `null` / `[]` 占位；
- `relations` 是「这次动作声明了什么」，不是折叠后的边；上游明说流不能承诺重放出与
  `graph` 相同的图（同秒排序、逆名归一），所以关系图继续走 `graph`。

`list --limit` 仍是未知 flag（只警告、不生效）：窗口/分页继续等上游。

### 3. 冷 / 热耗时（本机，中位数，9 次）

本仓（152 提交）：

| 命令 | v0.3.0 | v0.4.0 热 | 冷（clear 后首读） |
| --- | --- | --- | --- |
| `list --json` | 103.4 ms | 29.6 ms | 111 ms |
| `list --search` | 103.8 | 30.3 | 107 |
| `graph --json` | 103.8 | 30.1 | 108 |
| `path --all --json` | 102.8 | 31.5 | 110 |
| `action log --jsonl` | 103.1 | 29.9 | 107 |
| `action log --limit 5` | 97.8 | 29.5 | — |
| `action list --json` | 26.1 | 28.2 | —（不读历史） |

`~/kiln`（462 提交）热读同量级：`list` 31.0、`graph` 31.3、`path --all` 34.4、`action log` 31.7，
冷读 110–115 ms（在该仓的副本上清缓存测得，原仓受沙箱限制无法删 `.git/kiln`）。

插件真实调用形态（每次起进程）：

| 场景 | v0.3.0 | v0.4.0 |
| --- | --- | --- |
| `/kiln/flow` = `graph` + 批量 `path`（24 个 id） | 207.8 ms | **61.5 ms 热** / 143 ms 冷（单样本） |
| 单个 issue 详情 = `path <id>` | 103.4 | **29.9** |
| 时间线 = `action log --jsonl` 全量 | 103.1 | **29.9** |

提交之后的第一条读（克隆仓模拟，462 提交 + 1 个空提交）：`list --json` 134 ms、整套 flow 175 ms
——比冷读多付一次枚举（`git log --format=%H`，本仓约 20 ms；上游 100k 约 230 ms）。

### 4. 缓存落点与体积

- 本仓：`records/layer-*.rec` 32 KB + `enums/enum-*.oid` 3 KB（2 个文件，35 KB）；
- `~/kiln`：15 个文件 122 KB（多次 HEAD 各留一层，最大的层 103 KB/462 提交）；
- 克隆仓连做 3 个提交后：8 个文件 140 KB——约 200 B/提交（含标题、refs、关系声明）；
- `kiln cache gc` 83 ms、`kiln cache clear` 30 ms（本仓；维护动作，不在请求路径上）。

缓存目录在 `.git` 里、worktree 共享、不进版本控制；写失败静默（上游 `cache-recovery`/`cache-hardening`
的约定），所以只读克隆上读命令照常。

### 5. 并发（宿主会同时起多个 kiln）

清空缓存后同时起 4 个进程（`graph` / `action log` / `path --all` / `list`），冷启动墙钟 164 ms；
四个输出与串行结果**逐字节相同**，之后再读一次仍是同一份字节——并发写层没有把缓存写坏。
上游的做法是原子 rename + 读方整层校验，本仓没有额外协调的需要。

### 6. jsonl 体积涨了多少

| 仓库 | v0.3.0 | v0.4.0 | 变化 |
| --- | --- | --- | --- |
| 本仓 151 行 | 43,325 B | 59,516 B | +37.4% |
| `~/kiln` 447 行 | 127,893 B | 151,135 B | +18.2% |

绝对增量 16–23 KB，客户端按 50 ms 合批解析，无感；但「流很便宜」不能再用字节数当理由——
真正的成本仍是等待第一个字节（冷 110 ms / 热 30 ms）。

## 对插件的判断

成立的假设：

- **版本门槛不变**：0.2.0（批量 path）/ 0.3.0（action log）在 v0.4.0 上照常，无需声明 0.4.0；
- **快照模型不变**：`graph` + `path` 的字节与语义都没动，HEAD 键控的增量重取继续有效；
- **80 条上限仍要**：`list --json` 仍无 `date` / `limit`，多出来的 issue 只能靠流折叠补齐；
- **关系图继续走快照**：流里的关系是声明，折叠规则与排序契约都不在流里。

失效的假设：

- 所有「一次读 ~100 ms」的数字：热读现在 30 ms，冷读仍是 100–115 ms，文档必须分冷/热两栏
  （`kiln-v030-adapter` 的「142 行 101 ms」、`kiln-input-streams` 的「首行 ~0.1 s」都只对冷读成立）；
- 「插件零残留」：插件自己不写，但 kiln 会在 `.git/kiln` 留缓存，README 的边界要写清楚，
  并告诉用户异常时用 `kiln cache clear`（插件不代劳）。

新出现的机会：

- **按需详情（`kiln-input-streams` 第 2 步）现在纯是成本问题**：`path <id>` 热 30 ms + `graph --issue
  --depth 1` 热 30 ms，别说第 81 个 issue，每次聚焦都现取也够快；剩下的只是「什么时候取」的 UX 决定；
- 缓存让「提交后第一次读」多付一次枚举（本仓 20 ms、100k 230 ms），这是唯一变慢的场景，
  宿主现有按 HEAD 缓存快照的写法正好把它压到每次提交一次。

下一步（不在本轮落地）：把文档与 README 的冷/热数字改一遍、补缓存边界；详情的第 2 步另开 issue。
