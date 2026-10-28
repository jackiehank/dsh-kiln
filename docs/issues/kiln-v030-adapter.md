# kiln-v030-adapter — 接入 v0.3.0 的动作流：时间线不再从快照摊平

- **domain**：integration
- **关联**：relates-to `kiln-v020-adapter`（上一次适配）、relates-to `kiln-many-issues`（方向与上游清单）

## 问题

`/kiln/flow` 一次快照 = 1 次 `kiln graph --json` + 1 次批量 `kiln path <id>… --json`，最多点名 80 个
issue（`DEFAULT_MAX_ISSUES`）。时间线页的行是**从这份快照的 `issue.actions` 摊平**出来的
（`client.js` 的 `flattenActions`），所以：

- 超过 80 条 issue 时，第 81 条以后的动作根本不在视图里；
- 搜索是全仓的（`list --search`），命中快照外的动作时，时间线里没有那一行可跳——
  「找到的是那句话，却带不到那句话」。

`kiln-many-issues` 已把方向定成「index + timeline 流 + 按需详情」，并列出上游依赖：
`kiln timeline --jsonl`、`list --json` 带 `date`、`list --limit/--offset`。其中第一项在 v0.3.0 交付了
（命令名是 `action log`），这一条 issue 只接这一项。

## 上游已交付（kiln v0.3.0）

下游接入定稿见 kiln 仓 `8f942fc`（`docs/action-log.md` 第六轮）。要点：

- 机器入口只有 `--jsonl`：一行一个 JSON 对象；`--json` 会被拒绝（exit 2），不会静默降级；
- 只有同时带 `issue:` + `action:` 的提交算一条；
- 字段：`issue` / `action` / `commit` / `date` **恒有**；`title` / `domain` / `tags` **缺省即没有**
  （键直接省略，不出现 `null` / `""` / `[]`）；
- `commit` 是全长 40 位（不是短 hash）；`date` 是 RFC3339，保留提交自己的 offset；
- 顺序：git 是 author-date 倒序，jj 是拓扑序；
- **没有终止记录**：EOF 就是结束；**没有增量游标**（无 `--since` / `--after`）；
- 退出码：`0` 正常（含空结果、`--limit` 用尽、Windows 上消费者提前关管道），`1` 读历史失败，
  `2` 参数错误；空仓 stdout 为空、提示只在 stderr。

本机实测（v0.3.0）：本仓 142 行 101ms；`~/kiln` 350 行 115ms；`--limit 3` 的启动开销落在噪声里。

## 本次接入什么

时间线页改为订阅宿主 **`GET /kiln/timeline`**（NDJSON 流），不再从快照摊平；issue 页、关系图与
搜索仍用原快照。

- 宿主新增 `lib/timeline.js`：`spawn` + 按行切 + 错误分类；`index.js` 增路由，边读边 flush，
  客户端断开（切页、刷新、卸载）即 kill 子进程；
- 客户端边收边渲染（合批刷新），EOF 定稿；没定稿前计数标「读取中」，不把半截当全部；
- 聚焦仍收窄时间线：流是全仓的，客户端按焦点邻域过滤；
- 快照外的 issue 的时间线行可以展开详情；「聚焦」按钮在它身上落回既有的「不在本次快照」警告，
  与今天一致，不新增死链；
- 旧二进制（< 0.3.0）上时间线明确报「需要 kiln v0.3.0+」，其余两页照常。

## 不做什么

- 不碰索引与详情：`list --json` 仍没有 `date`、没有 `limit/offset`，窗口与按需详情继续等上游；
- 不做首屏缓存（时间线首行 ~0.1s，缓存/滚动窗口留给下一步）；
- 不把时间线筛选切到动作级 `domain`：现在按「所属 issue 的领域」筛，改成动作级会出现两种口径，
  另行决定；
- 不改关系图、issue 页、搜索的行为。

## 验收

- 时间线行不再受 80 条快照限制：本仓 142 条动作全部出现、可展开；
- NDJSON 跨 chunk 的半行不丢不重；坏行明确报错，不静默吞；
- 切页 / 卸载 / 刷新会结束流并 kill 子进程；
- kiln < 0.3.0 时只有时间线报版本不足，issue / 关系页照常；
- 既有 58（宿主）+ 45（渲染）用例继续过，新增覆盖分行、映射、空结果、错误行。

## 落地（2026-10-28）

按「一条数据路径」只换了时间线的数据源，其余三块（快照 / 搜索 / 关系图）原样：

| 位置 | 做什么 |
| --- | --- |
| `plugin/lib/timeline.js:25` | `createLineSplitter()`：chunk 跨行不丢不重，最后的无换行尾巴在 `flush()` 收 |
| `plugin/lib/timeline.js:46` | `mapActionRecord()`：契约字段 → 视图行；缺 `issue/action/commit` 判坏行 |
| `plugin/lib/timeline.js:67` | `actionLogProblem()`：旧版 / 参数错时说人话，正常（exit 0）返回 null |
| `plugin/lib/timeline.js:87` | `consumeActionLog()`：EOF 即终点（上游没有 summary），`done` 只调一次 |
| `plugin/lib/index.js:97` | `GET /kiln/timeline`：写 NDJSON 事件（`action` / `error` / `done`），断连即 kill；`res.write` 背压时暂停子进程 stdout |
| `plugin/lib/client.js:2052` | 浏览器半订阅流，50ms 合批；unmount / 换仓库 / 刷新都 abort |
| `plugin/lib/client.js:837` | 聚焦仍收窄时间线（`view.ids` 过滤），但不再重排——顺序由上游给 |
| `plugin/lib/client.js:2320` | 快照外的 issue：行尾显示「快照外」而不是假的聚焦按钮 |

数字（本机 v0.3.0，2026-10-28）：本仓 `action log --jsonl` 全量 142 行 101ms，
`~/kiln` 350 行 115ms；把真实输出按 97 字节切块喂给 `consumeActionLog`，60 行全解析、
`commit` 全是 40 位、`domain`/`tags` 缺省不出现。测试 63（宿主）+ 48（渲染）全过。

已知代价：时间线不再有「步骤 n/m」——动作流行没有 ordinal，编一个出来就是假数据；
要恢复得等上游给游标或宿主按 issue 反算。快照外的 issue 仍不能聚焦（没有结构），
这一半要等 `list` 的 `date` 与 `limit/offset`。

复现：`node plugin/test/run.mjs && node plugin/test/render.mjs`；实机要看宿主重启
（浏览器半随刷新更新，`/kiln/timeline` 路由在宿主进程里注册）。
