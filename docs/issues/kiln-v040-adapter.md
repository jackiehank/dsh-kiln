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

## collect（续，2026-10-30）：机器输出全景，`--jsonl` 只有 `action log`

上游这一版只动了 `action log --jsonl` 的 schema，其余读命令的 `--json` 一律没变。下面是逐条验证，
外加新字段的规格、实仓分布与「下游能拿它做什么」。

### 1. 全部机器可读输出（v0.4.0）

| 命令 | flag | 形态 | 顶层形状 | 相对 v0.3.0 |
| --- | --- | --- | --- | --- |
| `status` | `--json` | 单文档 | `{summary{total,done,open,actions,domains}, worktree{policy,open,current?}, issues[]}` | 逐字节相同 |
| `list` | `--json` | 单文档 | `{filter,count,issues[{id,domain?,action,done,rank?,title?,commit?,tags?,hit?}]}`；`hit={ordinal,action,commit,subject,total,date}` | 逐字节相同 |
| `graph` | `--json` | 单文档 | `{summary{issues,edges,missing},nodes[{id,domain?,action,done,title?,tags?}],missing?,edges[{from,to,name,directed}]}` | 逐字节相同 |
| `path` | `--json` | 单文档（1 个 id）或批量 `{issues[],errors?}` | 每条 `{issue,action,done,actions[{ordinal,action,commit,date,title?,refs?,tags?,stat?}],relations[边]}` | 逐字节相同 |
| `show` | `--json` | 单文档 | `{issue,ordinal,total,action,commit,date,title?,body?,stat?}` | 逐字节相同（含 `--stat`） |
| `check` | `--json` | 单文档 | `{passed,findings{ok,warn,error},results[{issue,level,rule,actions[]}]}` | 逐字节相同 |
| `worktree list` | `--json` | 单文档 | `{backend?,worktrees[{path,main,issue?,gone,dirty,unmerged}]}` | 逐字节相同 |
| `action list` | `--json` | 单文档 | `{actions{names,start,terminal},source,config?}` | 逐字节相同 |
| `action log` | `--jsonl` | **NDJSON，一行一个动作** | `issue/action/commit/date` 恒有 + 见下 | **纯增量** |

- **`--jsonl` 是 `action log` 独占**。其余命令给 `--jsonl` 是「未知 flag」：stderr 警告后**回落到文本输出**
  且 **exit 0**（`list` / `graph` / `status` / `check` 实测）；`path` 是例外，exit 2。反过来
  `action log --json` 明确拒绝：「action log 用 --jsonl（一行一个动作），不用 --json」，exit 2。
- `do` / `commit` / `config path` 没有任何 JSON 形态（`do` 的 stdout 必须能直接喂 `git commit -m`）。
- 逐字节对照补全：两个真仓上 `status` / `check` / `show` / `show --stat` / `worktree list --json`
  与 v0.3.0 完全相同；加上第一轮的 `list` / `list --search` / `graph` / `path --all` / `action list`，
  **除 `action log` 外没有任何文档变过**。

### 2. 新字段规格（`internal/cli/action.go:381` 的 `actionLogDoc`）

| 键 | 类型 | 何时出现 | 语义 |
| --- | --- | --- | --- |
| `refs` | `[]string` | 有 `refs:` | 引用条目；`SplitList` 后去重 |
| `target` | `[]string` | 有 `target:` | 涉及文件；去重（提交时校验文件必须在改动里） |
| `scope` | `string` | 有 `scope:` | 范围文本，单值 |
| `relations` | `[{name,target}]` | 有任一声明 | **声明**，不是折叠后的边；别名已按词表归一 |
| `unrelate` | `[]string` | 有 `unrelate:` | 撤销目标列表；单列，不混进 `relations` |

四个旧键（`title` / `domain` / `tags` / `date`）与行序不变；**没有 `ordinal`、没有文件列表、没有
增量游标**。缺省即省略（不出现 `null` / `[]`），键序固定为结构体顺序（`tags, refs, target, scope,
relations, unrelate` 依次插在 `domain` 之后），所以同一份历史每次的字节相同。

`relations` 的顺序是**词表序**，不是提交里的书写序（`action.go:303` 的注释）：

- 先按当前词表的声明名顺序输出（`part-of` / `has-part` / `blocks` / …），每个名字下按提交里的书写顺序；
- 完全相同的 `(name,target)` 只留一条；
- 别名在 `trailer.Parse` 阶段就归一了（`derived-from` → `caused-by`），逆名**不翻转**：
  `has-part: X` 原样输出 `{name:"has-part",target:X}`，折叠成边是 `path` / `graph` 的事。

三个探针提交（在一次性克隆里做的，未进本仓历史）验证了上面三条：
`--derived-from kiln-v030-adapter` 输出 `{"name":"caused-by",...}`；
`--has-part kiln-v040-adapter` 输出 `{"name":"has-part",...}`；
两次相同的 `--relates-to x` 只输出一条，而 `--unrelate a,b` 输出 `["a","b"]`。

### 3. 实仓分布（v0.4.0，两个真仓）

| 键 | 本仓 151 行 | `~/kiln` 447 行 |
| --- | --- | --- |
| `refs` | 111 行 / 187 条 / 6,731 B | 10 行 / 10 条 / 141 B |
| `target` | 144 行 / 177 条 / 6,931 B | 58 行 / 99 条 / 3,069 B |
| `scope` | 19 行 / 414 B | 161 行 / 11,134 B |
| `relations` | 19 行 / 36 条声明（`relates-to` 29、`caused-by` 4、`part-of` 3） | 90 行 / 154 条（`relates-to` 128、`caused-by` 23、`blocks` / `blocked-by` / `causes` 各 1） |
| `unrelate` | 0 | 1 行（`commit-cache` 的 `unrelate:["action-log-relations"]`） |

整条流：本仓 43,325 → 59,516 B（+16,191 B，+37.4%，其中 refs+target 占 13.7 KB）；
`~/kiln` 127,893 → 151,135 B（+23,242 B，+18.2%，其中 `scope` 占 11.1 KB）。
冷读与热读的 `action log` 输出逐字节相同（清缓存前后对比过），缓存层没有丢字段。

### 4. 「声明」不等于「图」：差多少

- 本仓 36 条声明 → 36 条边，逐条能对上（历史里没有重复声明或逆名）；`~/kiln` 154 条 → 125 条边，
  差额来自折叠时的合并（同一对 issue 的重复声明、逆名、对称关系、槽内取强）；
- 例：`kiln-v040-adapter` 的 `ask` 声明 3 条 `relates-to`，`path --json` 给出 3 条无向边
  （`from`/`to`/`name`/`directed:false`）；
- 上游在 `action-log-relations` 里明确不承诺「重放流能还原 `graph`」：同秒排序、逆名归一、
  对称合并、槽内取强都不在流里。所以下游要边就得继续用 `graph` / `path`，流只适合做
  「谁声明了什么」的展示。

### 5. 插件要不要消费

现状：`timeline.js:46` 的 `mapActionRecord` 只取 7 个旧字段，多余键直接丢弃；
`client.js:903` 折叠 issue 时把 `refs` 固定成 `[]`。所以新字段**不影响任何渲染**，测试不用改。

逐个看：

- `refs` / `target` / `scope`：可以安全地透传，但界面从不渲染 refs（详情也没展示 target/scope），
  收益为零；等详情页需要「引用/涉及文件」时再加；
- `relations`：不能折叠（要复刻词表、逆名、槽位与同秒规则），与「插件不复刻 kiln 状态」的约定冲突，
  继续用快照的边；
- `unrelate`：只有真做折叠时才需要，届时必须按时间序撤销——比现在多一类正确性负担，先不接；
- `--limit N` 截断的是**最新**的 N 条，声明折叠只对完整流成立；插件现在就是全量流，无需改。

结论：这一版对插件是**文档级适配**（数字分冷/热、补缓存边界），代码保持不动；新字段留给
「按需详情」那条 issue 作为可选素材。

## hypothesize（2026-10-30）：把「一次预取全仓」换成「按视图取数」

### 出发点

v0.4.0 让单条 kiln 命令落到进程地板（热读 42ms/条，其中约 15ms 是缓存工作），于是**总成本由
「命令条数 × 传输量」决定，而不是单条命令快慢**。插件还是 v0.2.0 的形态：mount 就把
`graph` + 全量 `path` 拉下来，再另起一条 `action log` 流；为「一次取全」付的代价是
**80 条上限、快照/流双源合并、「快照外」死链、按 issue 增量重取 ~200 行缓存逻辑**。
这些复杂度今天都不再必要——详情单取只要 42ms。

### 实测（Node spawn，与宿主同形态；本仓 24 issue / 153 动作）

| 调用 | 热 42ms 档 | 冷（clear 后） | 输出 |
| --- | --- | --- | --- |
| 单条 `graph --json` | 42 ms | 120 ms | 11,443 B |
| 单条 `path <id> --json` | 42 ms | 120 ms | 3,497 B |
| `graph --issue --depth 1` | 42 ms | — | 925 B |
| 单条 `action log --jsonl` | 42 ms | 120 ms | 60,280 B |
| 单条 `list --json` / `--search` | 41 / 42 ms | — | 27 KB 级 |
| `graph` + 批量 `path`（串行） | **85 ms** | — | 88 KB |
| `graph` + 批量 `path`（并行） | 59 ms | — | 88 KB |
| `path --all`（= 批量全 id，逐字节相同） | 42 ms | 121 ms | 77,442 B |

（collect 里的 30ms 是 PowerShell 直调；宿主从 Node spawn 起子进程每条多约 12ms，以本表为准。
HEAD 探测走 `readHeadFast` 读文件约 2ms，只有 packed-refs 等形状才回退 `git rev-parse`（46ms）。）

三条由此得出的事实：

1. **批量 path 是唯一随 issue 数线性膨胀的预取**：约 3.1 KB/issue（1000 个 issue ≈ 3 MB），
   80 条上限就是为它设的；`graph` 只有约 0.45 KB/issue；
2. **单个 issue 的详情只要一次 42ms / 3.5 KB**，比「预取 80 个再挑一个」便宜两个数量级；
3. **mount 的关键路径现在是 85ms**（graph+path 串行），而流（42ms）本来就在并行跑——把 path
   从 mount 拿掉，关键路径立刻减半。

### 候选

| 方案 | mount spawn | mount 传输 | 80 上限 | 聚焦第 81 个 | 代价 / 风险 |
| --- | --- | --- | --- | --- | --- |
| **A 现状 + 两路并行** | 2（并行） | 88 KB | 保留 | 仍不可用 | 59ms → 只省 26ms；双源合并与上限都留着 |
| **B 单条 `path --all` 快照** | 1 | 77 KB | 仍需（payload 涨） | 仍不可用 | path 没有 `domain`/`tags`，还得靠流补；77 KB 换 11 KB 不划算 |
| **C 按视图取数（推荐）** | 1（流；graph/详情按需） | 60 KB | **删除** | 42ms 可用 | 首次点开详情/关系页各 +42ms；首屏依赖流收口 |

### 目标形态：一个视图一条命令

| 视图 | 命令 | 何时取 | 传输 | 宿主缓存 |
| --- | --- | --- | --- | --- |
| 时间线 | `action log --jsonl` | mount（唯一必取） | 60 KB | 无（流式） |
| issue 列表 | 同一条流（客户端 `foldIssues`） | 随流 | 0 | 无 |
| 详情 / 聚焦 | `path <id> --json` | 点开时 | 3.5 KB | 可选 LRU（按 HEAD+id） |
| 关系图 | `graph --json` | 打开关系页时（可 hover 预取） | 11 KB | HEAD 键控 |
| 搜索 | `list --search=<q> --json` | 输入时 | 10–20 KB | 无 |
| 词表 | `action list --json` | 首次（客户端缓存） | 0.4 KB | 按仓库 |

路由随之收敛为 `/kiln/timeline`、`/kiln/issue?id=`、`/kiln/graph`、`/kiln/actions`、`/kiln/search`，
**删除 `/kiln/flow`**（连同 `buildFlow` 的历史拼装、`DEFAULT_MAX_ISSUES`、截断提示、
`knownOf`/「快照外」、`missingFocus`、快照/流合并）。

### 关键决定

1. **issue 列表只吃流**。折叠规则已经用真仓对齐过 `kiln list --json`（23/23、70/70），
   `domain`/`tags`/`done`/`title` 不缺；`ordinal` 在「看到该 issue 的起点」或流收口时回填。
   快照唯一独有的是 `refs`（界面不渲染，且 v0.4.0 的流里也有），不再需要双源。
2. **详情 = `path <id>` 单条**。它自带 `ordinal`、`actions`、`done` 和该 issue 的**全部边**
   （进+出，`relations` 是折叠后的 `graphEdge`），足够画聚焦页的母/子/强/弱分组；
   邻居的标题与领域来自流折叠出的 issue 索引（`byId` 改由 `streamIssues` 提供），不额外取数。
3. **关系图懒加载**。`graph --json` 只为关系页存在；首次进入 42ms，之后 HEAD 命中约 2ms。
   聚焦半径 1 的局部图用 `graph --issue --depth 1`（925 B/42ms），半径 2 用 `--depth 2`
   （或整图，视规模）。
4. **宿主缓存只剩一份**：graph（键 = HEAD + 配置令牌 + 二进制令牌）。详情可用同一个 HEAD 令牌
   做 `(head,id)` 的 LRU（16 条），HEAD 一动自然失效；不为详情再起 `git rev-parse`。
5. **词表保持独立一次**（28ms），客户端按仓库缓存；不塞进 graph，免得配置改动词表要重取图。

### 分期落地

- **S1 详情先行**：加 `GET /kiln/issue`（`path <id>`），聚焦页改吃它；其余不动。验证 42ms、
  错误路径（不存在的 id）、以及聚焦页的展开/邻居渲染。
- **S2 拆掉预取**：删除批量 path 与 80 上限；issue 列表改单一流源；`/kiln/flow` 换成
  `/kiln/graph` 并改为关系页按需加载；删除 `knownOf`/截断/合并逻辑与对应测试。
- **S3 可选提速**：行 hover 120ms 后预取详情（复用 hint 的延迟习惯）；关系页页签 hover 预取
  `graph`；详情 LRU 把「反复点同一条」降到 0 spawn。

### 代价与边界

- **首屏不再是完整快照**：流收口前，序号/动作数标「读取中」，与今天时间线的规则一致；
  热读 42ms 基本一帧完成，冷读 120ms 是可见的等待。
- **点开详情多一跳**：42ms（冷 120ms）需要 loading 态；今天的「瞬间」是预取换来的。
- **规模上界没变**：整条流仍是 O(动作数)；100k 动作（约 29 MB）必须等上游分页/索引
  （`kiln-many-issues` 仍开着），本设计只是让 1k 以内更简单、更快。
- **测试面不小**：删掉快照合并/截断/「快照外」约 15 条用例，新增详情与 graph 路由、
  懒加载、聚焦边三组；渲染用例的 props 也要跟着改。
- **没有新版本要求**：`path` 单条自 0.2.0、`action log` 自 0.3.0，v0.4.0 只是让它们变快。

### 验收

- mount 只起 1 个 kiln 子进程（+ 首次词表），本仓传输 ≈60 KB；HEAD 命中时 ≤5ms、无子进程；
- 第 81 个及以后 issue 能聚焦：`path` 42ms、动作带序号、边齐全；
- 关系页首次 42ms、二次 ≤5ms；聚焦半径 1 用 `graph --issue`（≤1 KB）；
- 删除 `DEFAULT_MAX_ISSUES`、截断提示、「快照外」、快照/流合并后，宿主与渲染用例全绿；
- 旧行为回归：时间线/搜索/筛选/焦点收窄不变，kiln <0.4.0 照常。

### 不做什么

- 不折叠流里的 `relations`（词表/逆名/同秒规则不复刻，边继续来自 `graph`/`path`）；
- 不换 `path --all` 当快照（缺 domain/tags，且 77 KB 换 11 KB 不值）；
- 不引入 daemon、常驻进程、WebSocket 或磁盘缓存；
- 不改 UI 信息架构与三页分工，只换取数方式。

## apply（2026-10-30）：按视图取数落地，插件 0.6.0

按 hypothesize 的形态直接做完（S1+S2），没有留半截：

| 位置 | 改了什么 |
| --- | --- |
| `plugin/lib/flow.js` | 删批量 `path` / `buildFlow` / `readHistories` / `DEFAULT_MAX_ISSUES`；新增 `buildGraph`（节点+边，不截断）与 `parseIssueDocument`/`readIssue`（单条 `path`，校验 id 不回错人） |
| `plugin/lib/snapshot.js` | 缓存收成一张图：HEAD / 配置 / 二进制三元组失效，HEAD 动了整图重取；删 `maxIssues`、按 issue 增量、`applyFocus` |
| `plugin/lib/git.js` | 删 `isAncestor` / `newIssueIds` / `parseTrailerRange`（不再需要“哪些 issue 被碰过”），只留直读 HEAD 与两个令牌 |
| `plugin/lib/index.js` | 路由换成 `GET /kiln/graph` + `GET /kiln/issue?id=`；删 `/kiln/flow`；时间线/词表/搜索不动 |
| `plugin/lib/client.js` | issue 列表单一流源（删快照兜底、`knownOf`、`快照外`、截断提示、`missingFocus`）；聚焦改吃 `/kiln/issue`（边 + 动作），关系页切到时才取图；首屏不再预取整仓 |
| `plugin/test/run.mjs` | 删批量 path / 增量 / trailer 区间用例，补 `buildGraph`、`parseIssueDocument`、图缓存（冷/热/HEAD 前进/并发合并） |
| `plugin/test/render.mjs` | 预置换成 graph + detail 两段；「快照外不给按钮」改成「都能聚焦」；焦点不存在 / 流失败的语义按新行为改 |
| `plugin/README.md`、根 `README.md`、`AGENTS.md`、`plugin/package.json` | 版本 0.6.0；数据来源、按视图取数表、v0.4.0 缓存边界、已知规模上界 |

### 验证

- **两套用例全绿**：宿主 52、渲染 53；`node --check` 覆盖 9 个文件。
- **路由注册**：`/kiln/graph,/kiln/issue,/kiln/timeline,/kiln/actions,/kiln/search`（假的 ctx 收集到的顺序）。
- **真仓对照**（v0.4.0，Node spawn）：`buildGraph` 把本仓 `graph --json` 读成 24 节点 / 36 边 / 7.3 KB；
  `parseIssueDocument` 对 `path kiln-v040-adapter --json` 得到 4 条动作（序号 1–4）、3 条边、`done=false`。
- **issue 列表只剩流**：直接把 `action log --jsonl` 的行喂 `foldIssues`，与 `kiln list --json` 对齐——
  本仓 **24/24**、`~/kiln` **84/84**，`id/action/domain/done/title/tags` 全等，首现顺序严格 date-desc。
- **取数账**（本仓，热）：mount = 动作流 42ms / 60KB（+ 首次词表 28ms）；详情 42ms / 3.5KB；
  关系图 42ms / 11KB。对照改造前：mount 的 flow = `graph` + 批量 `path` 串行 85ms / 88KB，
  且每条请求都要先探 HEAD。第 81 个 issue 现在与第 1 个同价。

### 已知代价

- 首屏不再有“已完整的快照”：流收口前计数标「读取中」、序号等看到起点或 EOF 才回填；
  热读一帧内完成，冷读 120ms 是可感知的等待。
- 点开一个 issue 多一跳 42ms（换掉 80 条上限与双源合并）。
- 规模上界仍是整条动作流（O(动作数)）：100k 动作约 29MB，等上游分页（`kiln-many-issues`）。
- 关系图与详情不再由宿主按 issue 缓存；重复点同一条会重取（42ms），换来没有第二套失效逻辑。
