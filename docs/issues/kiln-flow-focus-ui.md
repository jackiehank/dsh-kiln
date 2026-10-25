# Flow 视图的焦点追踪界面

## 背景

`kiln-dsh-integration` 以 `d0b26ca` 收尾（`apply`），形态定为 **DSH profile bundle**：Host 半提供
`GET /kiln/flow`，浏览器半在 `conversation.view` 插槽加一个 `kiln` 标签，把 kiln 的 trailer 投影成
“以焦点 issue 为核心的关系子图”。

初稿能出图，但**焦点本身只有一个默认值**：没有可操作的选择、没有可见的状态、没有退路。
这条 issue 只处理“焦点”这一件事——选谁、怎么换、换过之后怎么看见和退回。

## 现状（对着 `plugin/` 的代码核过）

1. **默认焦点 = 最近一次动作的 issue**：`buildFlow` 扫 `issue.last.date` 取最大者，空仓库退化为第一条
   （`plugin/lib/flow.js:160-169`）；
2. **宿主接受 `?focus=<id>`**，但只在该 id 存在于当前快照时生效，否则用默认值
   （`plugin/lib/index.js:41-44`）；
3. **浏览器半的焦点是 React state**：`focusId`（`plugin/lib/client.js:248`），每次取数后被宿主返回的
   `payload.focus` 覆盖（`client.js:273`）；
4. **切换焦点不重新取数**：effect 依赖只有 `[cwd, nonce]`（`client.js:281`），焦点不在依赖里，
   切焦点只重算 `relate()`（`client.js:129`）——这是 hypothesize 4“子图重根、不重取数”的落地；
5. **切换入口只有三处**：`part-of` 面包屑（`client.js:346-352`）、子 issue 行（`client.js:372`）、
   各关系组的关系行（`client.js:386-391`、`client.js:410-416`）；
6. **焦点的视觉标记只有一条 CSS**：`dkf-focus` 的边框与底色（`client.js:61`），焦点行固定在
   第一行（`client.js:345`）。

## 缺口

- **选不到**：只能沿关系爬。想直接跳到一个不在当前一跳邻域里的 issue，没有入口——而 hypothesize 4
  写的是“可点击任意节点或搜索切换焦点”；
- **看不清**：焦点只靠边框区分，且与“最近动作”的强调混在一起；
- **退不回**：母 → 子 → 孙之后，面包屑只能回母（`client.js:349`），回不到上一个焦点；hypothesize 4
  遗留的“内存返回栈”没做；
- **会静默丢**：快照截断到 80 条（`plugin/lib/flow.js:17`、`flow.js:217`）时，若焦点不在其中，
  `buildFlow` 会悄悄换成别的 issue，界面不提示；
- **口径不一**：hypothesize 2 说“不做刷新按钮、展开即实时读 Git”，初稿有刷新按钮（`client.js:298`）；
  hypothesize 4 说可搜索切换焦点，初稿没有。这些偏差需要有结论，不能留两份说法。

## 问题

在一个只有关系子图、没有全量列表的只读视图里，“当前焦点是哪个 issue、怎么换、换过之后怎么退”
应当怎么表达——既不新增状态，又让人一眼看懂自己站在哪条线程上？

## 约束

- **只读、不落盘**：焦点只存在内存里，刷新页面回默认（沿用 hypothesize 4 的决定）；
- **不新增数据通路**：切换焦点不得触发新的 `/kiln/flow` 请求（保住 `[cwd, nonce]` 依赖）；
- **不改 kiln**、不引入构建步骤；浏览器半保持纯 DOM（`React.createElement`），不引 UI 库；
- **诚实降级**：焦点不可用（不在快照 / 非 kiln 仓库）时说明原因，不静默换人；
- **词表驱动**：关系名与强弱从 `GROUPS`（`client.js:25`）推导，不把关系名写进焦点逻辑。

## 验收标准

- 焦点行有可读标识（`焦点：<issue id>` 之类），不依赖单一颜色即可辨认；
- 任意 issue 可在一次操作内成为焦点（最小搜索或索引入口）；不在本次快照里的 issue 明确提示
  “不在本次快照”，而不是变成另一个 issue；
- 切换焦点不发起网络请求（DevTools 里 `/kiln/flow` 请求数不变）；
- 焦点切换保留内存返回栈（至少一级“返回上一个焦点”），刷新或重挂载后回默认焦点；
- 焦点丢失（截断、issue 消失）时有可读提示，并提供“回到默认焦点”的动作；
- 鼠标与键盘都能完成“进入 / 返回”，且不劫持会话输入框的按键；
- **零关系时仍可用**：本仓现在就是 0 条边（`edges:[]`），视图至少要能显示焦点 issue 自己与它的动作条。

## 待验证

- `conversation.view` 标签里能否放输入框而不与宿主会话的键盘快捷键冲突；
- 宿主是否已有可复用的搜索 / 命令面板组件，避免自造输入框；
- 焦点是否该进 URL query（可分享、刷新可保持）——“不落盘”指的是磁盘，URL 会进浏览器历史，
  这算不算状态需要判定；
- 默认焦点规则（最近动作）在 `worktree: on` 的多个 worktree 下是否仍然成立。

前三条的调研见下节；第 4 条仍未收集。

## 调研记录（collect）：待验证 1–3

证据来源：本机 DSH **0.2.1-rc.2** 的实现副本
`…\default-workspace\.dsh-src\dsh\node_modules\@deepseek-ai\`（`app.asar` 不可直接读，但同一
release 的包在此目录，下列路径与行号可复现）。运行中的 GUI 走 `connection` 信任栅栏，未持浏览器
会话时 `/` 返回 401、`/plugins` 返回 404，**拿不到运行时证据**；以下均为源码级证据，标「未实测」的
项需要浏览器手验。

### 1. `conversation.view` 里放输入框

- **slot 契约不限 DOM**：注册形状是
  `{ name, id, order, label, locale, children, store, inject(sessionId) }`
  （`dsh-client-ui-chat/lib/client.js:13222-13245`），视图是普通 React 组件，宿主不约束内部元素；
  我们现在的视图里已经有可聚焦的「刷新」按钮。
- **但没有先例**：全量 `conversation.view` 注册者只有 `chat`（同上 `:13224`）与 `trajectory`
  （`dsh-client-ui-trajectory/lib/client.js:8206`），两者都无文本输入。带输入框的 DSH 表面都在
  模态/页面层——设置外壳、快捷键速查、计划任务页、插件市场、插件管理器、侧栏浏览器地址栏。
- **键盘冲突的真实边界是 `ctx.shortcuts`，不是视图容器**：
  - 有效绑定**优先于**原生操作、编辑器、终端、iframe 与模态控件；只拦截已注册的修饰键组合，
    普通打字不受影响（`dsh-client-shortcuts/README.zh.md:36`）；
  - 输入法组合与已消费输入继续传递（同文件 `:50`、`:52`）；
  - `Esc Esc` 停轮序列限定在「获得焦点的 Chat 或 Composer」（`dsh-client-ui-conversation/README.zh.md:115`），
    焦点在我们的输入框里时不在该作用域；
  - Web 默认键位都是 `Mod+…`（`Mod+/`、`Mod+\`、`Control+\``、`Mod+Alt+*`、`Mod+Shift+*`，
    `dsh-client-shortcuts/README.zh.md:82`），**`Mod+K` 未被占用**；加「聚焦搜索」热键应走
    `ctx.shortcuts` 注册（参与冲突校验、可在设置里改），不要自己 `window.addEventListener`。

**结论（候选）**：输入框可做，热键走 `ctx.shortcuts`；「输入框在会话视图里的样式与焦点回归」
没有先例可依，必须手验一次。

### 2. 可复用的搜索 / 命令面板

- **没有全局命令面板**：全仓 `palette` 命中都是配色板，也没有 `Mod+K` 类入口。搜索都是局部组件：
  - 斜杠菜单：`ctx.commandUi.popupSelect` + `searchLabels()` + `searchMode: 'substring'|'fuzzy-label'`
    （`dsh-client-ui-commands/README.zh.md:28,34,38`）——**弹窗持有 composer 焦点**，属于输入框
    流水线，不是通用面板；
  - 模型菜单搜索（`dsh-client-ui-model-selection/README.zh.md:40,42`）、设置外壳搜索、快捷键速查
    搜索（打开即聚焦搜索框）、插件市场搜索、计划任务页搜索——各自实现，样式对齐
    「command 弹窗的紧凑样式」。
- **共享原语可用**：Web 前端注入给客户端 bundle 的模块表里有 `@deepseek-ai/dsh-client-ui-primitives`
  （与 `react`、`dsh-client-ui-slots`、`dsh-client-ui-dockkit`、`dsh-client-store`、`zod`、
  `@tanstack/react-virtual` 并列，见 `dsh-web-frontend/dist/assets/index-CN7NIWNw.js` 内 `SZ()`），
  约 55 个官方客户端包都在 `require` 它（`MenuSurface` / `MenuGroup` / `InlineEditor` /
  `relativeTime` 等）。**未实测**：插件 bundle 经 `window.__ModuleLoader__` 的 `require` 能否解析这个
  名字——`react` 已能解析，同一张表里的 primitives 预期可以，但要用一次
  `console.log(require('@deepseek-ai/dsh-client-ui-primitives'))` 证实。

**结论（候选）**：复用 primitives 的菜单/输入原语，自建一个极小的过滤框；**不要**借
`ctx.commandUi.popupSelect`——它被 composer 的 `/` 流水线拥有，会把键盘交给 composer。

### 3. 焦点进 URL query

- **DSH 从不把 UI 状态放进 URL**：`dsh-web`、`dsh-web-app`、`dsh-web-frontend` 里没有
  `URLSearchParams` / `pushState` / `replaceState` / `location.search`；全量 `location.(search|hash|href)`
  命中都在第三方打包（pdfjs、devtools、终端），`popstate` 同样只在第三方里。会话选择、View 偏好、
  主题分别落在 store 与 settings namespace（`ui-conversation` 持久化 View 偏好；`ui-theme` 写
  `$DSH_HOME/cordis.patch.yml`）。
- 页面由 `/` 提供，鉴权与路由不看 query：`connection.admit()` 只做 Host/Origin 信任（403）与浏览器
  会话认证（401）（`dsh-client-connection/lib/index.js:737-750`）；我们自己的 API 路由已把
  `?cwd=&focus=` 当参数解析（`plugin/lib/index.js:69-80`）。
- **据此可判**：把 `?focus=` 写进页面 URL 是**我们新造的机制**，而且单向——宿主既不读也不听
  `popstate`，浏览器后退会改 URL 却不改视图，等于制造一份应用无法对账的状态。

**结论（候选）**：**不做 URL 携带焦点**。若将来真要「可分享」，应另开 issue 做只读深链
（例如 `kiln path <issue> --json` 的网页视图），而不是把视图状态塞进页面 URL。

### 对四条待验证的处理

| # | 原来 | 现在 |
| --- | --- | --- |
| 1 输入框 | 待验证 | 机制可行；热键走 `ctx.shortcuts`；**需手验**一次 |
| 2 搜索组件 | 待验证 | 用 primitives 自建小过滤框；不借 `commandUi`；**已证实可 require**（见测试 1） |
| 3 URL query | 待验证 | 不做；理由见上（宿主不听 `popstate`） |
| 4 worktree 焦点 | 待验证 | 未收集，仍未验证 |

## 测试 1：插件 bundle 能不能 `require` 到 primitives

**问题**：collect 里标「未实测」的那条——`window.__ModuleLoader__` 的 `require` 能否解析
`@deepseek-ai/dsh-client-ui-primitives`。

**办法**（源码级，无浏览器）：在 Web 前端 bundle 里定位 `__ModuleLoader__` 的构造点。

**证据**：`dsh-web-frontend/dist/assets/index-CN7NIWNw.js`（字符偏移约 918559）：

```js
const i = globalThis.__DSH_TRANSPORT__
this.modules = r.create({
  boot: t.__DSH_BOOT__,
  staticModules: SZ(),
  ...(i?.loadBundle === void 0 ? {} : { loadBundle: i.loadBundle }),
})
```

`r` 就是 `window.__ModuleLoader__`；`SZ()` 正是含 `@deepseek-ai/dsh-client-ui-primitives`（连同
`react`、`dsh-client-ui-slots`、`dsh-client-ui-dockkit`、`dsh-client-store`、`zod`、
`@tanstack/react-virtual`、`@deepseek-ai/cordis`）的那张表。

**结论**：**能解析**。所有客户端 bundle（含本插件）的 `require` 都从同一张 `staticModules` 表取；
`react` 已经用这条路径跑通了我们的标签页，primitives 与它同表同源，不存在「同名不同实例」。
副产物：复用 `MenuSurface` / `MenuGroup` 不会引入第二份 React 或二次样式注入。

**未覆盖**：没有在浏览器里真的调一次 `require(...)` 并断言导出形状；primitives 具体导出哪些组件
仍未核对，写代码时要先看一次实际导出。

## 边界（不做）

- 不做 Triage / Genealogy 两种阅读模式（另开 issue）；
- 不做看板、拖拽、状态编辑——写路径只有 `git commit`；
- 不做全仓 issue 索引页：焦点入口服务“从关系里跳”这条主线，最多加一个最小搜索。
