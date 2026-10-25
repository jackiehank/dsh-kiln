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
- 每行标出所属 issue；颜色只由 action 类型决定，且与 issue 页动作条、relation 页节点一致；
  未登记的动作给中性色；同刻行序稳定，刷新不乱跳；
- 聚焦任一行/边后，三页同时收窄；切页焦点不变；“退出聚焦”回到全局态；
- 关系强弱：`part-of` / `blocks` 全展开，弱关联默认折叠且可展开；
- 焦点失效（截断 / issue 不存在）有可读提示 + 回全局的动作；
- 刷新后回默认焦点，不残留、不进 URL；
- **零关系仍可用**（本仓当前 0 条边）：timeline 与 issue 页正常，relation 页给空态而不是空白。

## 待验证 / 待 hypothesize

- 三段导航的形态与键盘——**已定**：页面内 tablist 三件套 + roving tabindex + 方向键，
  不绑全局快捷键（见假设 1）；
- “相关 issue”的归属——**已定**：留在浏览器半，但收口成一个 `related(focus, edges)`（见假设 1）；
- timeline 的形态——**已定 A**：一行一 action，颜色 = action 类型，每行标 issue，同刻稳定排序（见假设 1）；
- timeline 的成本：当前快照上限 80 条 issue、每条一次 `kiln path`（4 并发、2s 缓存）够不够；
- `worktree: on` 时多个 worktree 的提交如何聚合到同一 timeline。

## 调研记录（collect）：DSH 里的“几个平级页面”怎么做

证据来源同前：`.dsh-src/.../@deepseek-ai/*`（0.2.1-rc.2），路径行号可复现。共有四种做法，
按“谁拥有切换状态”分。

### 1. 壳级 View 标签（`conversation.view`）——壳拥有、会持久化

`dsh-client-ui-conversation/lib/client.js:18043-18057`：`role="tablist"` 容器 + 每个 View 一个
`role="tab"` + `aria-selected`，`onClick` 调 `selectView(id)`。**没有** roving tabindex、
没有方向键、没有 `aria-controls`——就是排在一起的普通按钮。

- 可见性：可用 View 少于两个时整条隐藏（`README.zh.md:73`）；
- 选中：写进持久化的 View 偏好，刷新后恢复（`README.zh.md:89-91`）；
- 判断：这是“彼此独立的工具”的容器，不是“同一份数据的几种取景”。我们只该占一个 tab。

### 2. 页面内 tablist——组件自己拥有（最接近我们的形态）

三个官方实现：会话轨迹的详情页签（`dsh-client-ui-trajectory/lib/client.js:5633-5654`）、
计划任务详情的“规则 / 任务运行记录”（`dsh-client-ui-schedule/lib/client.js:4517-4557`）、
设置里的插件页签（`dsh-client-ui-settings-plugins/lib/client.js:66-99`）。三者的公共做法：

| 约定 | 实现 |
| --- | --- |
| 语义 | `role="tablist"`（带 `aria-label`）→ `role="tab"`（`aria-controls`）→ `role="tabpanel"`（`aria-labelledby`） |
| 焦点 | **roving tabindex**：选中项 `tabIndex: 0`，其余 `-1`（schedule `:4531`、settings-plugins `:86`） |
| 键盘 | `ArrowLeft/Right` 循环、`Home/End` 首尾、`preventDefault()`、切换后 `focus()` 新页签（schedule `:4536-4555`）；带修饰键时直接放行 |
| 单页不显示 | 只有一个页时不渲染 tablist（settings-plugins `:66-69`），与壳对 View 的处理一致 |
| 状态归属 | 放在**页面根组件**的 `useState`，以 prop 下传（schedule `:4150`、`:4173`）；换对象时重置（`:4155`） |
| 记住上次 | trajectory 用 `tabHistory`（recency Set，`:4923`、`:5051-5055`），对象变化时挑“最近用过且仍可用”的页（`:5074`） |

**最关键的一条先例**：trajectory 的选中态（`selectedRecordId` / `selectedRequest`，`:4915-4923`）
在 tablist **之上**，页签只是同一选中的不同切面（`:5656` 起按 `activeTab` 渲染）。也就是说
“一个共享状态 + 多页取景”在官方代码里就是这么写的——不需要 store，也不需要额外 slot。

### 3. 全局页面：`sidebar.panellist` + `main` 键控槽——布局服务拥有

计划任务页（`dsh-client-ui-schedule/lib/client.js:7473-7490`）与插件管理页
（`dsh-client-ui-plugin-manager/lib/client.js:4418`、`:4477`）同构：`main` 注册一个 `key`，
`sidebar.panellist` 注册同一 `id` 的入口，点侧栏图标就把主区切到那一页（`ctx.layout.selectPanel`，
`dsh-client-ui-layout/README.zh.md:59`；同一 id 寻址同一面板，`dsh-client-ui-sidebar/README.zh.md:38`）。
设置弹窗的 `settings.section` 是同一思路的模态版。

判断：适合“工作区级一等页面”，代价是占一个侧栏入口；会话内看 issue 不需要升到这层。

### 4. 右栏 tabs（`ctx.sidebarRight.openTab`）——最重的一档

`ctx.sidebarRight.openTab(kind, { params })`（schedule `:7501-7504`；`dsh-client-ui-sidebar-browser/README.zh.md:43`），
每种 kind 一个页面、params 决定内容，页签自带 actions/命令、按 occurrence 解析关闭与刷新
（`dsh-client-ui-sidebar-right/README.zh.md:110`）。要布局、命令、标签页生命周期三套东西，还要求
用户先把右栏打开。

### 对我们的判断（进 hypothesize 用，不是结论）

1. **承载**：沿用“一个 tab 内三段 tablist”，与 schedule / settings-plugins 同构——语义、roving、
   方向键三件套照抄即可，不需要发明控件；
2. **焦点状态**：放在 tab 根组件的 `useState`，三页作为 prop 消费（trajectory 的“选中在页签之上”
   就是先例）；不引入 store，也不新增 slot；
3. **页签记忆**：可照抄 trajectory 的 `tabHistory`（最近可用优先），解决“焦点被清空 / 切焦点后
   落到哪一页”；
4. **不做**：三个壳级 View（会被 <2 隐藏规则误伤，且壳不给我们方向键）、`sidebar.panellist` 全局页
   （要占侧栏入口）、右栏 tab（生命周期与命令面都太重）；
5. **页签切换不放全局快捷键**：官方约定是 tablist 内方向键；`ctx.shortcuts` 只用于“打开表面”
   （如 `workspace.files`、`browser.new`），不用于页间切换。

## 调研记录（collect 2）：缓存拿什么当失效令牌

### 实测（本仓 3 条 issue，Windows，取多次均值）

| 操作 | 耗时 |
| --- | --- |
| 直读 `.git/HEAD` + `.git/refs/heads/main` | **~2 ms** |
| `git rev-parse HEAD` | ~65 ms（进程启动占大头） |
| `kiln graph --json` | ~102 ms |
| `kiln path <id> --json`（单条） | ~100 ms |
| 当前一次全量重建（graph + 3 条 path） | ~405 ms |

**推论**：成本几乎全在“每条 issue 起一个 `kiln path`”。按快照上限 80 条外推，
一次全量 ≈ 102 + 80×100 ≈ **8.1 s**。现有 2 秒 TTL 只能挡住“同一窗口内的重复挂载”，
每 2 秒就要重付一次，而且新提交后最多陈旧 2 秒——粒度既不省也不准。

### git 侧可用的事实

- **`.git/HEAD` 直读只要 2 ms**，是 `git rev-parse` 的 1/30；后者只在 ref 被 pack 或
  `.git` 是文件（worktree）时才需要；
- `git merge-base --is-ancestor A B` 用退出码回答“A 是不是 B 的祖先”（实测 0/1 可用）；
- **git 自带 trailer 解析器**，不用我们自己拆提交信息：

  ```text
  $ git log --format='%h issue=[%(trailers:key=issue,valueonly)] action=[%(trailers:key=action,valueonly)]' 8b905ad..HEAD
  8d46047  issue=[kiln-views-shared-focus] action=[hypothesize]  timeline 定 A…
  437270d  issue=[kiln-views-shared-focus] action=[hypothesize]  页签不换页…
  ef52e74  issue=[kiln-views-shared-focus] action=[collect]      平级页面三种现成做法…
  ```

  普通 `chore:` 提交的 `issue=[]` 为空，天然被排除——与 kiln 的“识别规则只有一条”一致。

### 结论（交给 hypothesize）

1. **HEAD 是精确的全局失效令牌**：HEAD 没动，快照必然没变（kiln 的状态只来自提交历史）；
2. **快照里已存的 action sha 让我们能只算增量**：`cached..HEAD` 范围内用 git 的 trailer
   解析器拿到“哪些 issue 有新提交”，只重取这些 issue 的 `kiln path`；
3. 两条都不需要我们解析 kiln 的**状态语义**——git 的结果只用来决定“重取谁”，不用于推导状态。

## 假设（hypothesize 1）：页签不换页、键盘照官方、timeline 走 action 行

### 已定

1. **切焦点不换页**：焦点变化只换数据，不换取景。页签记忆照抄 trajectory 的 `tabHistory`
   （最近用过且仍可用的那一页，`dsh-client-ui-trajectory/lib/client.js:4923`、`:5074`），
   而不是 schedule 的“换对象就重置”（`dsh-client-ui-schedule/lib/client.js:4153-4157`）。
   理由：三页是同一份数据的三种取景，换焦点时用户“在看什么页”并没有变；
2. **键盘照官方约定**：roving tabindex + `←/→` 循环 + `Home/End`，切完把焦点移到新页签；
   页间切换**不绑全局快捷键**（`ctx.shortcuts` 只用于“打开表面”）。

### “相关 issue”留在浏览器半

- **判定是什么**：给定焦点与全部关系边，算出“哪些 issue 在本次取景里、按什么强度排”。现在是
  `relate()`（`plugin/lib/client.js:129`）在浏览器里算，宿主只给原始 `issues` + `edges`；
- **两个硬理由**：① 切焦点必须零请求（已有验收，也是 `effect` 依赖只有 `[cwd, nonce]` 的前提）；
  ② “宿主不判断什么算重要”是既有设计（`plugin/lib/flow.js:1-7` 的头注释就是这么写的）；
- **但必须收口成一个函数**（`related(focus, edges)`），三页共用。若三页各自过滤，规则一定会漂；
- **会改判的条件**：仓库大到必须由宿主裁剪 payload，或将来要让 MCP / CLI 复用同一套判定。

### timeline 定为 A（一行一 action）

| 案 | 形态 | 结论 |
| --- | --- | --- |
| **A 一行一 action** | 每条 kiln 提交一行：所属 issue、action、完整 title、时间、短 sha | **采纳** |
| B 一行一 issue + 横向动作条 | 仿轨迹，右侧一排动作格按时间倒序 | 否决：与 issue 页撞车，三页粒度退化成两页；横轴跨 issue 的时间不对齐是假对齐 |

**A 的三条呈现规则（用户定 + 一条实现约定）**：

- **颜色 = action 类型**：同一个 action 在 timeline、issue 页的动作条、relation 页的节点上用同一颜色；
  取色以动作词表为准（现有 `ACTION_COLOR`），词表里没有的动作给中性色，不猜；
- **每行显式写出所属 issue**，不做“按 issue 分组”——线程感靠每行的 issue 标识和颜色一致来读，
  不靠视觉合并；
- 排序：全局与聚焦态都是时间倒序；同刻按 issue id 稳定排序（避免刷新后行序跳动）。

### 待定

- 无（timeline 形态已定）。

## 边界（不做）

- **不做搜索框**（用户明确：先不做；焦点入口只有点行 / 点边 / 默认值）；
- 不做写操作、不做看板与拖拽——写路径只有 `git commit`；
- 不做 Triage / Genealogy 的独立模式——它们已被 timeline / relation 吸收；
- 不做作者展示（缺字段，先记账，等确认是否值得回 `git log`）。
