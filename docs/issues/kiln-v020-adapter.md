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

## 假设（方案比较）

### 传输：逐条改字段 / `--all` / 点名 ≤80 个 id

- **A 保持逐条，只改 `commit`**：改动最小，但冷启动 19 条仍约 0.5s、59 条约 1.3s；上游这次
  专门为这个消费者做了批量，不用等于白升。
- **B `path --all --json`**：一次 105ms，但会越过 `maxIssues`（80）。上游压测 100k issue 时
  输出 35MB、峰值约 329MB；插件只画前 80 条，拉全仓是浪费，还可能把宿主拖住。
- **C 点名 ≤80 个 id**：一次进程、保持给定顺序；80 个 id 的 argv 约 2–3KB，远低于 Windows
  32767 字节上限；与 A 的逐条语义一一对应。
- **选 C**。`--all` 留给真正要全仓的消费者。

### 兼容：只支持 v0.2.0 / 双形状回退

- **只支持 0.2.0**：代码最短，但仓库约定是 v0.1.1+；v0.1.1 对多 id **静默只回第一条**，
  按批量形状解析会把其余 issue 静默读成空——错数据比慢更贵。
- **版本探测**（`kiln --version`）：多一次进程、要解析版本串，还要处理预发布/构建版本。
- **形状探测**：批量文档一定有 `issues` 数组；v0.1.1 多 id 返回裸 pathDoc。看到裸对象就退回
  逐条（每条都正确）；v0.2.0 批量里未被 `issues` / `errors` 覆盖的 id 也退回逐条。
  代价只是旧版多一次白跑的批量调用（约 100ms），正确性不丢。
- **选形状探测**：不解析版本串，新老二进制同一段代码。

### 增量缓存：保留 / 删除

- 批量后单条与 80 条的耗时只差几毫秒，增量「只重取几条」不再省时间；三条探测（graph、
  merge-base、git log）本来就与 graph 并行，不增加等待。
- 删除能少一条代码路径，但会顺带改缓存状态名（`incremental`）与一批用例，超出「适配」范围。
- **保留**：`readHistories()` 的签名与调用点不变，批量在函数内部生效；要删增量另开 issue，用实测说话。

### 标签：接 / 不接

- v0.2.0 的 `path --json` 现在有动作级 `tags`，但「时间线按标签筛」是产品功能而不是适配；
  接进来会改交互（新增筛选维度），与「功能不变」冲突。
- **不接**。只改 `client.js` 里「path --json 不吐 tags」的注释——能力已存在，用不用另议。

### 落地方式

- `flow.js`：`mapActions()` 读 `commit`（`id` 作为旧版回退）；`readHistories()` 换成一次批量，
  并保留形状回退与单条回退；`runKiln()` 增加「非零退出但 stdout 可解析」的路径，供部分失败用；
- `snapshot.js` / `client.js` 的取数协议不动；`probe-perf.mjs` 增加批量与旧法的对比；
- 用例补：批量解析、单条形状、旧键回退。

## 假设修订（2026-10-28）：推翻双兼容，只支持 v0.2.0+

上一条选了「形状探测 + 旧版逐条兜底」；讨论后推翻：**只支持 kiln v0.2.0+，多 id 却拿到单条
文档时直接报错**。

理由：

- 插件未发布（`private`、仓库没有 tag），唯一使用者已升级到 v0.2.0，兼容路径保护不到任何人；
- 双路径最贵的不是那 45 行，而是把「批量契约坏了」变成静默降速：兜底一触发只是变慢，
  缓存头也看不出走了哪条路。和「宁可多跑、不出错数据」相比，明确报错更可解释；
- 旧路径在常规 CI 里没有真二进制可跑（要另建 v0.1.1），只能测形状，等于维护一份「看起来支持」。

做法：

- `readHistories()` 只发一次批量；多 id 却拿到单条 pathDoc → `KilnError`
  「需要 kiln v0.2.0+：path 批量只回了单条文档（旧版会静默丢弃其余 id）」，经既有的
  `kiln-error` 通道显示，客户端不用改；
- 删逐条兜底、`mapLimit` / `PATH_CONCURRENCY`、`action.id` 旧键回退；
- 保留单条形状（1 个 id 时 v0.2.0 也回裸 pathDoc）与 `errors` / exit 1 的容忍；
- 版本下限：`AGENTS.md` / `README.md` 改为 kiln v0.2.0+。

代价（已确认）：

- 旧版不可用，升级就一条 `go install …@latest`；
- 取数层抛错要经 `snapshot.js` / `readFlow()` 转成 `kiln-error` 失败快照（约 10 行）；
- 插件版本从 0.1.0 提到 **0.2.0**（`private`、未发布，只是内部标记：0.2.x ↔ kiln 0.2.x+），
  `package.json` 的 description 写明所需 kiln 版本。
