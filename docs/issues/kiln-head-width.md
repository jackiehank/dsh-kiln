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

## 方案（hypothesize）

四个候选，判断标准：**在 280–900px 的侧栏里都不压叠，且不让用户多点一次**。

### A. 只把 `×` 拆出来

把 chip 的文本拆成 `label` + `×` 两段，`×` 不参与省略。**只修症状 2**，头部布局照旧压叠。否决。

### B. 头部换 flex + 容器查询分档 + chip 拆两段（推荐）

三件事一起做：

1. **拆 DOM**（光调 CSS 修不了）：
   - chip → `焦点：` / `id` / `×` 三个 span，只有 `id` 参与省略，`×` 永远完整；
   - 刷新 → `刷新` / `↻` 两个 span，窄档只显示字形。
2. **头部从 grid 换 flex，给每项显式伸缩权**：`minmax(0,1fr)` 只解决「列可以变窄」，没解决
   「谁先让位」；flex 里每个 `min-width:0` + `flex` 才是一份可读的优先级表。
3. **两条容器查询**（查 `.dkf-head` 自己的宽度，所以拖侧栏也生效）：

| 内容宽度 | 牺牲什么 |
| --- | --- |
| 任意 | 搜索框可缩到 96px；chip 的 id 先省略（`×` 不动） |
| ≤ 520px | 仓库名收到 72px；chip 去掉「焦点：」前缀（hint 里仍有完整说明） |
| ≤ 360px | 搜索框地板降到 72px；刷新只剩 `↻`（hint 仍是「重新读取…」） |

硬保证：`.dkf-head{overflow:hidden}` + 所有子项 `min-width:0`——**结构上不可能压叠**，最坏是省略号
或裁边，不会盖到邻居身上。

估算（内容宽 240px 时）：仓库名 72 + 搜索 72 + chip 约 25 + 刷新 22 + 间距 16 = 207px，仍有余量。

### C. 头部允许换行

和 `.dkf-bar` 的先例一致，窄时搜索框掉到第二行。零风险但头部会从 34px 变成 68px，而下面紧跟着
的 `.dkf-bar` 本身就会换行，两处换行叠在一起，视觉上分不清哪层是哪层。否决（保留作 B 的兜底：
真窄到 207px 以下，B 的表现是裁边，C 是换行；需要时再加一条 `@container` 切 `flex-wrap`）。

### D. overflow 菜单

Fluent / Fiori / HIG 的标准做法，但我们的动作只有 2 个（刷新、退出聚焦）。为 1 个动作建菜单：
菜单按钮 ~40px + 一层交互，比直接显示还贵。否决。

### 决定

**B**。理由：

- 不换行，头部高度与另外两行（`.dkf-bar` / `.dkf-filters`）保持 34–36px 的节奏；
- 不引入新状态（不像 collapsible search 要记「搜索框是否展开」），也不引入 JS 测宽；
- 牺牲顺序可写、可测：先省略 chip 的 id，再砍仓库名与「焦点：」前缀，最后把刷新降成字形；
- `×` 单独成元素后，省略号只能吃 id，关闭入口在任何宽度下都完整可见。

风险与兜底：

- 容器查询要求 Chromium 105+（DSH 的 Electron 与 Web GUI 都满足）；不支持时退化为「不折叠」，
  但因为 flex + `min-width:0` 仍在，**不会压叠**，只是更早开始省略。
- 侧栏窄到 ~210px 以下会裁边（`overflow:hidden`）。这属于宿主给的极限，不额外处理；真要处理，
  按 C 加一条换行。

### 落地清单（apply 时照着做）

- `plugin/lib/client.js:2966` 起的 header JSX：chip 拆三段、刷新拆两段，chip 补 `aria-label`。
- CSS（`:439`–`:460`）：`.dkf-head` 改 flex + `container-type:inline-size` + `overflow:hidden`；
  `.dkf-repo` / `.dkf-search` / `.dkf-head-actions` / `.dkf-focuschip` 补 `min-width:0` 与 `flex`；
  `.dkf-focuschip` 去掉 `overflow/text-overflow`（交给 label），加 `.dkf-focuschip-label` /
  `.dkf-focuschip-x{flex:none}`；`.dkf-refresh-icon{display:none}`；两条 `@container`。
- 测试：`render.mjs` 断言 chip 的 `×` 在独立元素、刷新有两个 span；`run.mjs` 断言 CSS 含
  `container-type:inline-size` 与两条 `@container`，且 `.dkf-head` 不再用那套三列
  `grid-template-columns`（防止悄悄回退）。
- 验证：结构测试 + 用户在 GUI 里拖窄侧栏看三档。

## 落地（apply）：B′——保留居中网格，真实根因是 `box-sizing`

**机制更正**：动手前又读了一遍 CSS，压叠的直接原因不是 `justify-content:flex-end` 向左溢出，而是
`.dkf-search` 的 `width:100%` 加 `padding:0 8px` **没有配 `box-sizing:border-box`**：输入框是
content-box，实际比所在的网格轨道宽 16px，那 16px 就画在第三列上，看起来像「搜索框和焦点框重叠」。
第三列其实已经缩到位了（chip 左边缘贴着输入框的右边）。

所以方案 B 的第 2 条（**头部换 flex**）不再必要：网格本来就允许两侧等量收缩，**「真居中」这个
既有性质不用丢**。实际按 B′ 落地，只留 B 的第 1、3 条，并把根因修掉：

| 改动 | 位置 | 作用 |
| --- | --- | --- |
| `.dkf-search` 补 `box-sizing:border-box` | `client.js:446` | 根因：输入框不再越出轨道 |
| `.dkf-head` 加 `container-type:inline-size` + `overflow:hidden` | `:441` | 分档跟头部自身宽度；宁可裁边也不盖邻居 |
| chip 拆 `prefix / label / x` 三段 | `:3019`，CSS `:464` | 只有 id 参与省略，`×` 永远完整；补 `aria-label` |
| 刷新拆 `label / icon` 两段 | `:3031`，CSS `:469` | 窄档只换显示，不丢语义（hint 还在） |
| `@container (max-width:520px)` | `:472` | 仓库名收到 72px；去掉「焦点：」前缀 |
| `@container (max-width:360px)` | `:473` | 刷新降成 `↻` |

**收缩顺序（写死，可预测）**：两侧等量变窄（仓库名与 chip 的 id 同时省略）→ 522px 以下砍仓库名
与「焦点：」前缀 → 360px 以下刷新只剩字形 → 搜索框的 96px 地板始终不动。任何宽度下 `×` 都完整。

真实宽度换算（内容宽 = 头部宽 − 24）：内容 240px 时，两侧各约 64px，chip 显示成
`kiln-mem… ×`，仍不重叠、不裁掉关闭符。

测试：`npm test --prefix plugin` → **86 + 63**（原 85 + 61）。新增：chip 三段与 `aria-label`、
刷新两段、CSS 侧断言 `box-sizing` / `container-type` / 两条 `@container` / `.dkf-focuschip-x{flex:none}`
且 chip 自身不再带 `text-overflow`（防止悄悄回退到「省略号吃 ×」）。

**代价与边界**：

- 侧栏窄到 ~210px 以下会裁边（`overflow:hidden` 的兜底）；这是宿主能给的最小宽度，不额外处理。
- 容器查询不可用时退化成「不折叠」，但因为 `border-box` 已修，**不会再压叠**，只是更早开始省略。
- 没做 C（换行）：`overflow:hidden` 已经是「绝不压叠」的硬保证，换行只在 ~210px 以下才有意义。
- 没做 D（overflow 菜单）：动作只有 2 个，菜单比动作本身还占地方。

**顺带修掉的坑**：CSS 里写注释时别用反引号——这整段 CSS 是模板字符串，反引号会提前结束它
（本轮踩了两次，`node --check` 报 `Unexpected identifier 'container'` 才反应过来）。

## 落地（apply 第二轮）：刷新按钮不再随焦点挪位

用户复现：窄窗口下从「没有焦点」切到「有焦点」，`刷新` 会向右挪一点点。仍记在这个 issue 里。

**机制**：`.dkf-refresh` 与 `.dkf-focuschip` 原本挤在同一条 flex 行里，两者都带 `min-width:0`；
chip 一出现这行就进入负空间，刷新跟着被压窄，而它里面的「刷新」文字是 `flex:none`——文字从变窄
的盒子里**向右溢出**，看起来就是按钮挪了位。刷新本不该参与收缩：它的右边缘应当就是页头右边界。

**改法（结构性，不赌 flex 的溢出方向）**：右侧动作区从 flex 改成两列网格。

```css
.dkf-head-actions{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;overflow:hidden}
.dkf-focuschip{grid-column:1;justify-self:end;max-width:min(320px,100%);min-width:0}
.dkf-refresh{grid-column:2;justify-self:end}
```

- 刷新被明确摆在 `auto` 列：有没有 chip 都落同一格，宽度只由内容决定，不参与伸缩；
- chip 独占 `1fr` 列，是这一排里唯一会被压的东西；`max-width:min(320px,100%)` 把它的宽度封在
  自己的格子里，超出时交给 label 省略——向左的溢出被 `overflow:hidden` 裁掉，碰不到刷新；
- 顺带消掉了「flex 负空间往哪边溢出」这种依赖浏览器实现的假设。

测试：仍 **86 + 63**。`run.mjs` 的页头用例补了四条结构断言：刷新在 `grid-column:2`、不许带
`min-width:0`；chip 在 `grid-column:1` 且宽度不超过格子；动作区是两列模板 + `overflow:hidden`。

**本轮没能在本机验证布局**：Edge headless 在这个沙箱里起不来（`--single-process` 也挂死，
`crashpad ... OpenProcess: 拒绝访问`）。所以只有结构断言 + CSS 机制推理，最终仍需在 GUI 里
拖窄对比「有焦点 / 无焦点」两态下刷新的位置。

## 落地（apply 第三轮）：按 dsh-desktop 的实际最窄宽度调参

用户在 dsh-desktop 上实测：窗口最窄只能到 **652px**（头部内容宽 = 628）。这一测把这个 issue 的
几个假设当场推翻／重置：

| 现象 | 原因 | 改法 |
| --- | --- | --- |
| `刷新` 从来没缩成 `↻` | 上一轮阈值定的 360px，而最窄也有 628，那一档**永远不触发** | 阈值抬到 **700px**（最窄时生效，再宽就显文字） |
| chip 左边被截断（显示成 `iln-head-wi… ×`） | 上一轮把动作区改成两列网格，chip 靠 `justify-self:end` + `max-width:min(320px,100%)` 封宽；一旦盒子仍超出格子，`justify-self:end` 就把**左边缘**顶出动作区，被 `overflow:hidden` 裁掉 | 动作区退回 flex：**只有 chip 是 `flex:0 1 auto` + `min-width:0`**（唯一可收缩项，flexbox 保证盒子不出这一行），刷新固定 `flex:0 0 auto`；chip 自己再加 `overflow:hidden` |
| 搜索框太占地方，chip 不够显示 | 中间那栏偏好宽度 `40%`、地板 96px | 偏好宽度降到 **30%**、地板降到 **72px**：窄时先让位给 chip |

现在的分布（内容宽 628 时）：搜索 188｜两侧各 212｜动作区 212（`↻` 26 + 间隙 8 + chip 178），
chip 内容约 168，够显示完整的「焦点：kiln-head-width ×」。

**为什么这次不再靠猜**：flex 的收缩是定义明确的——`flex:0 1 auto` + `min-width:0` 的项会被压到
这一行放得下为止，所以 chip 的盒子不可能超出行宽，也就没有「左边缘被裁」这种失败模式；刷新
`flex:0 0 auto` 则保证它的右边缘永远贴着页头右边界。

测试：仍 **86 + 63**；页头用例改成断言收缩权（chip `flex:0 1 auto` + `min-width:0`、刷新
`flex:0 0 auto`）、`30%` / `72px` 的新轨道、`@container (max-width:700px)`，以及「真居中」那例的
轨道同步更新。

**仍待用户目测**：652px 下 `↻` 是否出现、chip 左边是否完整、搜索框变窄后是否够用。

## 结论

三个症状全部修掉，用户验收「效果不错」：窄宽不压叠、`×` 永远完整、刷新位置与有没有焦点无关。

**这一轮最值钱的三条经验**：

1. **根因常常是一行缺失的声明，而不是选错了范式。** 压叠的真身是搜索框少了 `box-sizing:border-box`
   （比轨道宽 16px），chip 左侧被裁的真身是网格里 `justify-self:end` 把超宽盒子的左边缘顶了出去。
   两次都想靠「换成另一种布局」解决，两次都被下一张截图纠正——先量再改。
2. **没有浏览器测量时，只信定义明确的机制。** flex 收缩（`flex:0 1 auto` + `min-width:0`）和
   `border-box` 是能推到底的；`max-width:min(320px,100%)` + `justify-self:end` 看着更严格，
   反而更脆。本仓没有无头浏览器（Edge headless 在沙箱里起不来），这条约束会一直成立。
3. **阈值必须按宿主给的真实下限定。** 上一轮把「刷新降成字形」定在 360px，而 dsh-desktop 最窄
   只到 652（头部内容 628）——那一档**永远不触发**，等于没写。拍脑袋的阈值等于没有阈值。

**代价**：头部现在有 2 个容器查询 + 3 条收缩规则（chip 让位、仓库名收窄、刷新降字形），
需要记住「只有 chip 会让位，刷新钉死在右边界」。

**明确没做**：头部换行（C）与 overflow 菜单（D）。`overflow:hidden` 是「绝不压叠」的兜底，
~210px 以下会裁边；那是宿主给不到的最小宽度，真遇到再按 C 加一条断点。
