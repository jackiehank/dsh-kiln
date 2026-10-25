# 三视图与共享焦点：timeline / issue / relation

## 背景

`kiln-dsh-integration`（`d0b26ca`）落地了只读 Flow 初稿：Host 路由 `GET /kiln/flow` + `conversation.view`
里的一个 `kiln` 标签，只能在焦点子图上平移。`kiln-flow-focus-ui` 把“焦点怎么表达”当研究对象，
验证了三条（输入框可放、宿主不抢键、primitives 可 `require`），但它的前提——**只有一个焦点子图、
没有全量列表**——在 2026-10-25 的设计讨论里被取代：

> 三个页面，三种粒度，一个共享的焦点 issue。

本条接住全部实现工作，并把“焦点”从一个视觉标记提升为**跨页的导航状态**。

## 设计

### 三页 = 三种粒度

| 页面 | 粒度 | 全局态（无焦点） | 聚焦后 |
| --- | --- | --- | --- |
| `timeline` | 提交 / action | 全部 kiln 动作，按时间倒序；**只算同时带 `issue:` 与 `action:` 的提交**，普通 git 提交不出现 | 焦点 issue + 相关 issue 的动作，仍按时间倒序 |
| `issue` | issue | 一行一条，按最近动作倒序 | 只剩焦点与相关 issue |
| `relation` | 关系边 | 全局关系图 | 以焦点为中心的子图，一跳邻居按关系强弱排列 |

三者不是三套数据，而是**同一份快照的三种投影**：收窄只换取景，不重新取数。

### 焦点语义

- **来源**：任意页点行、点边；无焦点时默认“最近一次动作的 issue”；
- **共享**：切页不丢，三页同时收窄；
- **清除**：必须有“退出聚焦 / 全局面”，否则进去出不来；
- **返回**：内存返回栈至少一级（`kiln-flow-focus-ui` 的旧验收，继续有效）；
- **失效**：焦点不在快照（截断、issue 消失）时明说原因并给回全局的动作，不静默换人；
- **不落盘**：刷新或重挂载回默认；**不进 URL query**（宿主不读 URL、也不听 `popstate`，
  URL 会变成应用无法对账的第二份状态——见 `kiln-flow-focus-ui` 的 collect 3）。

### “相关 issue”的口径（已定）

强弱按 kiln 的槽与 rank：`ordering` 槽（`part-of`(2) > `blocks`(1)）整体强于 `lineage` 槽
（`supersedes`(3) > `caused-by`(2) > `relates-to`(1)）。聚焦时：

- **强关联（`part-of` / `blocks`）全展开**；
- **弱关联（`supersedes` / `caused-by` / `relates-to`）默认折叠**成“+N 可展开”。

## 承载：一个 tab，三段导航（已定）

`conversation.view` 是按 id 注册的**顶层标签页**（现在注册的是 `id: "kiln", order: 30`，与
“对话 / 轨迹 / 上下文”并列）。三页**不注册成三个 tab**，而是同一个 tab 内的三段导航（顶部分段控件）：
焦点状态因此天然落在同一棵组件树里，切页与切换焦点都不需要新请求。

## 数据面：不新增通路

- `kiln path <issue> --json` 每条 action 带完整 sha（`id`）、`date`、`title`、`refs`、`ordinal`、`action`；
- 宿主现在把它们折进 `issues[].actions`，但 `actionList` 丢掉了 `id`（`plugin/lib/flow.js:111-119`）——
  **要补回来**，timeline 需要 commit 短哈希；
- 于是三页全是同一份快照的投影：`timeline` = `issues[].actions` 拍平按 `date` 倒序；
  `issue` = `issues` 行；`relation` = `edges` 的全局/焦点布局。**零新增子进程**；
- 已知缺口：`kiln path --json` **没有 author 字段**。要显示“执行者”就得回 `git log`，本条暂不展示作者。

## 约束

- **只读**：不写 trailer、不造提交、不装 git 钩子；
- **不落盘、不进 URL**；
- **不新增数据通路**：不为了 timeline 去解析 `git log`——`kiln` 才是判断“什么是动作”的唯一权威；
- 不改 kiln 源码；浏览器半保持纯 DOM（`React.createElement`），不引构建、不引 UI 库；
- 关系名与强弱从词表推导（`GROUPS`），不把关系名写进页面逻辑；
- 诚实降级：无 kiln / 非 kiln 仓库 / 空图 / 不合约定的 trailer 都要显示原因，不猜不修。

## 验收标准

- 三页共用同一份快照：切页、切焦点都不发起新的 `/kiln/flow` 请求；
- `timeline` 只出现同时带 `issue:` 与 `action:` 的提交，普通提交不出现；全局与聚焦态都按时间倒序；
- 聚焦任一行/边后，三页同时收窄；切页焦点不变；“退出聚焦”回到全局态；
- 关系强弱：`part-of` / `blocks` 全展开，弱关联默认折叠且可展开；
- 焦点失效（截断 / issue 不存在）有可读提示 + 回全局的动作；
- 刷新后回默认焦点，不残留、不进 URL；
- **零关系仍可用**（本仓当前 0 条边）：timeline 与 issue 页正常，relation 页给空态而不是空白。

## 待验证 / 待 hypothesize

- 三段导航的具体形态（分段控件 vs 侧边小导航）与键盘可达性——用 `ctx.shortcuts` 还是纯 Tab 序；
- timeline 的成本：当前快照上限 80 条 issue、每条一次 `kiln path`（4 并发、2s 缓存）够不够；
- “相关 issue”的判定留在浏览器半（现在的 `relate()`）还是下推到宿主；
- 聚焦态下 timeline 是按“issue 分行”呈现，还是仍一条提交一行；
- `worktree: on` 时多个 worktree 的提交如何聚合到同一 timeline。

## 边界（不做）

- **不做搜索框**（用户明确：先不做；焦点入口只有点行 / 点边 / 默认值）；
- 不做写操作、不做看板与拖拽——写路径只有 `git commit`；
- 不做 Triage / Genealogy 的独立模式——它们已被 timeline / relation 吸收；
- 不做作者展示（缺字段，先记账，等确认是否值得回 `git log`）。
