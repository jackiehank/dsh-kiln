# kiln-v020-adapter — 为 kiln v0.2.0 换掉插件的读侧接入

## 问题

本机 kiln 已从 v0.1.1 升到 v0.2.0（`kiln --version` 显示 `v0.2.0`，构建时间 2026-10-28 02:10）。
插件的取数层是按 v0.1.1 的 JSON 契约写的：

- `plugin/lib/flow.js` 只调 `kiln graph --json` 与 `kiln path <id> --json`；
- `mapActions()` 把动作行的 `id` 当提交哈希；
- 一次快照 = 1 次 graph + 每条 issue 一次 path（并发 8，上限 80 条）。

v0.2.0 把动作行的哈希键改成了 `commit`，并给 `path` 加了批量形态。原样跑会先坏在
**用户看得见的地方**：时间线短哈希变空、动作详情显示“（无 sha）”、搜索结果定位到动作时
高亮不到那一格（`actionId` 是空串）。逐条起进程也和上游这次专门做的批量接口对不上。

## 范围

这次只换**读侧接入**，功能和交互保持不变：

- issue / 时间线 / 关系三页的行为、筛选、搜索、焦点、键盘操作、图都不动；
- 只读、不落盘、不写 trailer 的约束不变；
- 不新增界面能力：v0.2.0 新吐出的动作级 `tags` 这轮不接（标签筛选是产品决定，另开 issue）；
- 返回 payload 的字段形状保持（动作对象里仍叫 `id` / `short`），客户端半不改。

## 边界

- 二进制下限仍按 `AGENTS.md` 的 v0.1.1+：批量是 v0.2.0 的能力，旧版要能自动退回逐条取数，
  不能因为多给了 id 就静默丢数据；
- 上限仍是 80 条（`DEFAULT_MAX_ISSUES`），不因为批量把全仓都拉回来；
- 缓存策略不重做：HEAD 失效、同仓并发合并、增量只重取受影响 issue 的语义都保留；
- 性能只承诺实测数字，不引入后台轮询或持久化缓存。

## 验收

- 时间线短哈希、动作详情的完整 sha、搜索命中动作时的高亮恢复；
- 冷启动改成批量：一次快照只起 1 个 `path` 子进程（本仓 19 条、`~/kiln` 59 条都验证）；
- 命中路径仍 <5ms；单条提交后的刷新仍只重取受影响的 issue；
- 旧版 kiln（`path` 多 id 静默只回第一条）能自动退回逐条取数，结果与改造前一致；
- 宿主侧用例与渲染用例全过；性能探针能打出批量前后的子进程数与耗时。

## 收集（2026-10-28，kiln v0.2.0 @ 2ddbd6b）

调查入口是上游开发目录 `~/kiln`：`git log v0.1.1..v0.2.0`、`git diff v0.1.1..v0.2.0`、
`docs/path-batch.md`、`docs/design.md`，以及本机 v0.2.0 二进制的真实输出。

### 读侧契约的变化

| 变化 | 上游出处 | 对本插件 |
| --- | --- | --- |
| `path --json` 动作行的哈希键 `id` → `commit` | b5e6a14（`pathAction.Commit`） | **会坏**：`mapActions()` 读 `action.id`，短哈希、完整 sha、搜索高亮都拿空串 |
| `path` 接受多个 id 或 `--all`，一次进程一份文档；单条输出逐字节不变；批量多一个 `errors`（`unknown-issue` / `stat-failed`，部分失败 exit 1） | 9607fd1；`docs/path-batch.md` | 冷启动可以从 N 次启动降到 1 次；但要处理 exit 1 与非批量形状 |
| 动作行新增 `tags`（该动作自己的 trailer，不是 issue 并集） | baaa190 | 本插件不读；标签筛选另开 issue |
| `check --json` 的 `ok` / `summary` → `passed` / `findings` | 09b9045 | 本插件不调 check，无影响 |
| `--title` 必填、值以 `--` 开头要写 `--flag=值`、`--target` 必须在本次提交里 | ac5de27、1a9795e | 只影响写侧；本插件只读 |
| `list` 新增 `--status` / `--search`；`status` 用 `done/open` | 40405da、cb5730a、09b9045 | 本插件不调 list/status |
| `graph --json` 形状不变（nodes：id/domain/action/done/title/tags；edges：from/to/name/directed） | v0.1.1 与 v0.2.0 的 JSON 结构体逐字段对照 | 不用改 |

### 批量形态的边界（从上游文档核对）

- `path --all --json`：顺序同 graph 的节点（id 字典序），本插件不依赖这个顺序；
- `path <id> <id> … --json`：保持给定顺序；这是本插件要用的形态，因为上限 80 条；
- 只有一个 id 时仍是**裸 pathDoc**（上游按 `len(pos) > 1` 才进批量），解析要认两种形状；
- `--all` 不接 `--domain` / `--tag`；100k issue 的仓里 `path --all` 输出 35MB、峰值约 329MB
  （上游压测），所以不能用 `--all` 越过 `maxIssues`，只能点名 ≤80 个 id；
- 批量不带 `--json`、`--all` 与 issue 参数同用都会 exit 2——与读侧无冲突。

### 实测（本机，kiln v0.2.0，Windows 11 / 20 核）

本仓 19 条 issue / 123 个动作，批量文档 62.8KB。`Measure-Command` 跑原生命令（丢弃首轮冷页）：

| 命令 | 耗时 |
| --- | --- |
| `kiln graph --json` | 103–111 ms（7 次） |
| `kiln path <id> --json` | 102–111 ms（7 次） |
| `kiln path --all --json` | 102–110 ms（7 次；首轮 183 ms） |
| 19 次 `kiln path`，并发 8 | 517 ms |
| `git merge-base --is-ancestor` | 约 51 ms |
| `git log <old>..<new>`（trailer range） | 约 52 ms |

上游同仓（`~/kiln` 59 条 / 258 动作）的数字：59 次 path 并发 8 = 1290 ms；`path --all --json`
60 条 258 动作 120KB = 182 ms（`docs/path-batch.md`）。

由此得到两条与设计有关的事实：

1. 批量把「每条 issue 一次启动」变成「一次启动」，冷启动的取数成本从 `N × ~100ms ÷ 8`
   变成 ~105ms；
2. 单条与批量的耗时只差几毫秒，**增量只重取几条**在耗时上已经没有收益，但它与 graph /
   git 探测并行、不增加等待——这轮不动缓存语义，见下一节取舍。

### 关键代码位置

- `plugin/lib/flow.js`：`mapActions()` 读 `action.id`（第 123 行）；`readHistories()` 逐条起进程
  （第 241–250 行）；`runKiln()` 非零退出即抛（第 81–95 行），批量部分失败会 exit 1，需要能读到 stdout。
- `plugin/lib/snapshot.js`：`buildRecord()` 通过 `readHistories()` 拿 missing + touched（第 80–86 行），
  接口不变即可复用。
- `plugin/lib/client.js`：时间线行、搜索命中的 `actionId`、`strip()`、详情里的 `row.id` 都依赖
  映射后的 `id` 与 `short`（第 817、1032、1057、1111 行）；只要 payload 字段名不变，客户端不用改。
