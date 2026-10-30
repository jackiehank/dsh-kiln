# 头部窄宽压叠：搜索框与焦点 chip 互相压，× 被省略号吃掉

## 背景

插件头顶是一条 34px 的单行头部 `.dkf-head`（`plugin/lib/client.js:439`），JSX 在 `:2966`：
三列网格，左仓库名、中搜索框、右「焦点 chip + 刷新」。

```css
grid-template-columns: minmax(0,1fr) minmax(96px,min(360px,40%)) minmax(0,1fr)
```

## 症状（用户实测，845×53 截图）

1. 侧栏一收窄（约 840px 起就看得见），`焦点：kiln-memory-cache` 压到搜索框上，「刷新」被挤到最右。
2. chip 尾部的 `×` 消失：chip 的文本是 `焦点：${id} ×` 一整串，而 CSS 给了
   `max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`（`:460`）——
   **省略号先吃掉的就是末尾那个 `×`**。

## 读码得到的机制（不是实测）

- 右列是 `minmax(0,1fr)`，**允许窄于内容**；`.dkf-head-actions` 是 `justify-content:flex-end` 的
  flex 行，放不下时溢出部分**向左**长，正好画在中列搜索框上。网格不会替你裁，也不会报警。
- chip 的宽度上限 320px 与 id 长度无关，而右列实际只有约
  `(W - 24 - 2×8 - 搜索列) / 2`：W=840 时搜索列 336，右列约 224px，已小于 chip 的 320。
- `×` 不是独立元素，只是文本末字：**只要触发 ellipsis 就必然被吃掉**；即使不被吃，它也只是装饰
  （点整块 chip 都是「退出聚焦」）。

## 验收

1. 任意宽度（含 ~280px 的窄侧栏）下，头部元素**互不重叠、互不裁切**。
2. 关闭标识始终完整可见（它是自己的元素，不参与文本截断）；点击整块 chip 仍是「退出聚焦」。
3. 收窄时牺牲的顺序**写进文档、可预测**，不是碰运气。
4. 不靠 JS 测宽：用容器查询跟随**侧栏宽度**——媒体查询跟的是窗口宽度，窗口 1200px、侧栏 300px
   时它根本不触发。
5. 三页结构与既有测试不受影响，85 + 61 全过。

## 边界

- 只动 `.dkf-head` 及其子元素（含 chip / refresh 的 DOM 拆分与 CSS）。
- 不动搜索、聚焦的逻辑；不动三页内容；不引入配置项与环境变量。

## 待定

- 收窄时先牺牲谁：仓库名 → 搜索框 → chip 的「焦点：」前缀 → 刷新文字？
- 头部允许换行吗？Fluent 2 的说法是「工具栏永不换行，放不下就收进 overflow 菜单」，而本仓
  第二行 `.dkf-bar`（`:462`）选的是 `flex-wrap:wrap`——头部跟哪一个。

## 收集：别的 UI 怎么处理「工具栏放不下」

分三类，每类都对着我们的情况看一遍。

### 一、收进 overflow 菜单（规范派）

- **Fluent 2 Toolbar**：工具栏跟着父容器长，但**永不换行**；放不下时用 overflow 工具，把最后一个
  选项变成「⋯」菜单。它的 React 实现要靠 `Overflow` / `OverflowItem` 真正测量宽度再决定谁进菜单。
- **SAP Fiori top app bar**：紧凑屏超过 3 个图标按钮、宽屏超过 4 个，就收进 overflow 菜单；大尺寸
  app bar 会折叠成小尺寸的那条。
- **Adobe Spectrum Action Bar**：放不下就换成 icon-only 动作组，多出来的放到栏尾菜单里。

代价都要「先测量、再决定」：这几家全部依赖运行时测宽（ResizeObserver / 自研 Overflow 组件），
不是纯 CSS。

### 二、把控件降级成图标，或把搜索框折成放大镜（桌面应用常见）

- **Apple HIG**（工具栏）：窗口缩到一定程度时，工具栏项会自动收进系统托管的 overflow 菜单；
  并且明确建议尽量别让窗口窄过工具栏的宽度——把「压叠」当成不可接受的失败态。
- **VS Code**：窗口变窄时 Command Center 换更短的标签，菜单栏收进汉堡菜单；官方对相关 issue 的
  回复是「这是设计如此，Command Center 有意显示更短的标签」。
- **Liferay Lexicon 的 collapsible search**：视野一窄，搜索输入框缩成一个放大镜按钮，点开才展开成
  浮层盖住工具栏；常见口径是「宽屏显示输入框、窄屏显示放大镜」。
- **GitHub**：顶栏图标在宽度不够时会被隐藏（社区里能查到「屏幕宽度太低放不下」这种解释），
  属于同一类的粗暴版：宁可不显示，也不叠。

### 三、让它换行，或用容器查询分档

- **Fluent 明确不换行**，但 WordPress 后台、Bootstrap navbar 这类选择 wrap——换行不需要测量，
  代价是高度会变。
- 和我们同构的一条工程结论（daintree#4133）：工具栏宽度取决于**侧栏是否展开**，而不只是窗口宽度，
  所以应该用 CSS 容器查询 `@container`，不是媒体查询。
- 网格/弹性的溢出机制（makandra）：`1fr` 的隐含最小尺寸是 `auto`（= min-content），内容撑不下时
  就溢出、盖住邻居；换成 `minmax(0,1fr)` 并给子项 `min-width:0` 才允许收缩，再配 `overflow:hidden`
  + `white-space:nowrap` 才有省略号。

### 观察（对我们意味着什么）

1. **头部没有优先级**：`1fr / 固定 / 1fr` 是平均分配，从左到右没有「谁先让位」的次序。
2. **chip 是「状态 + 动作」合体**，`×` 又是文本的一部分——这两件事光调 CSS 解决不了，必须拆 DOM。
3. 我们只有 2 个动作（刷新、退出聚焦）。**为 1 个动作建 overflow 菜单不划算**：菜单按钮本身就占
   ~40px，且要多一层交互。
4. 搜索是主入口，但它的结果有别的出口（搜索结果是页面主体）；`×` 没有别的出口。**牺牲顺序里
   `×` 必须排在最后**。
5. 本仓已经有三处「装不下就换行」的先例：`.dkf-bar`（`:462`）、`.dkf-filters`（`:473`）、
   `.dkf-legend`（`:570`）。
6. 无头浏览器在本机跑不起来——Edge headless 一启动就挂死（沙箱挡住它的进程派生：
   `crashpad ... OpenProcess: 拒绝访问`）。所以布局机制只能按 CSS 规范推 + 用户截图核对，
   **最终必须让用户在 GUI 里看一眼**。

### 参考

- [Fluent 2 Toolbar](https://fluent2.microsoft.design/components/web/react/core/toolbar/usage)
- [Fluent UI 迁移文档（Overflow / OverflowItem）](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-commandbar-migration.txt)
- [SAP Fiori: Top App Bar](https://www.sap.com/design-system/fiori-design-android/v26-4/components/m3-standard-components/top-app-bar)
- [Adobe Spectrum: Action bar](https://spectrum.adobe.com/page/action-bar/)
- [Apple HIG: Toolbars（摘要）](https://github.com/sickn33/agentic-awesome-skills/blob/main/skills/hig-components-menus/references/toolbars.md)
- [microsoft/vscode#171032（Command Center 窄窗换短标签）](https://github.com/microsoft/vscode/issues/171032)
- [Liferay Lexicon: Collapsible search](https://liferay.design/lexicon-1/patterns/collapsible-search)
- [daintree#4133（侧栏宽度要用容器查询）](https://github.com/daintreehq/daintree/issues/4133)
- [makandra: prevent a 1fr grid column overflow](https://makandracards.com/makandra/608104-prevent-1fr-grid-column-overflow)
- [Priority Plus Navigation（自动把溢出项收进 More）](https://wordpress.org/plugins/priority-plus-navigation/)
