# kiln-ui-refresh — 三页视觉语言统一 + 重做外观

## 问题

三个页面（时间线 / issue / 关系）功能上已经闭环，视觉却是逐次长出来的：时间线来自
`kiln-flow-focus-ui`，关系图来自 `kiln-relation-graph`，聚焦结构来自 `kiln-issue-focus-page`，
节点提示来自 `kiln-node-hover`。每个 issue 只对"当下那一页"负责，没有人为"三页并排看"做过一次决定。
结果是：观感像三个插件，而不是一个视图的三个面。

可以在 `plugin/lib/client.js` 的 CSS 里数出来的症状：

- **字号自己一套**：手写 10 / 11 / 12 / 13px 五档。宿主有八档语义字号
  （11 / 12 / 13 / 14 / 16 / 18 / 20 / 24），最小的一档是 11px，我们用了它没有的 10px。
- **圆角六种**：2 / 3 / 4 / 6 / 10px。宿主有 `xs 4 / sm 8 / md 12 / lg 16 / xl / panel 28` 六档，
  一对一对不上，卡片（6）、胶囊（10）、标签（3）互相之间也没有可推的规律。
- **三种行网格各写各的**：issue 行 7 列、action 行 7 列、子行 5 列，`grid-template-columns`
  三段独立字符串；同一个"issue id"列在三页的 x 位置不同，扫视时眼睛要重排。
- **选中态两套**：页面 tab 用 2px 下划线（`inset 0 -2px 0`），分段按钮用浅底
  （`interactive-bg-hover`，而且两处透明度不一致：`.04` 与 `.06`）。
- **hover 底色硬编码** 9 处 `rgba(0,0,0,.04)`；深色模式下语法上仍能靠 token 生效，
  但 .06 那处是叠加色，深色下会发灰。
- **代码字体 token 写错**：CSS 里 11 处 `var(--dsw-font-family-code,monospace)`，
  宿主全部包内 **0 处**定义这个名字（正确的叫 `--ds-font-family-code`）。后果是这些代码文本
  永远落在 `monospace`，用户在设置里换代码字体对这三页无效。
- **颜色靠硬编码兜底**：`#111` 出现 17 次、`#666` 14 次、`#999` 11 次、`#e3e3e3` 9 次。
  token 存在时兜底不生效，但 `#b4690e`（warn）和 `#35a35f`（完成态）是裸色，
  在深色主题里没有对应台阶，和宿主其它面板不是一个色阶。
- **间距不是网格**：`padding` 有 `5px 6px / 4px 6px / 2px 4px / 1px 8px / 6px 9px / 10px 14px 32px`，
  `gap` 有 2 / 4 / 6 / 8，没有一条能一眼推出的规律。

还有一层结构性问题：宿主本来就有一条视图 tab 条（对话 / 轨迹 / 上下文 …），我们注册一个
`kiln` 视图后在它正下方又画了一条 `.dkf-tabs`——两条 tab 叠着，层级重复，而且我们这条的
选中样式和宿主那条不一样。

## 目标

1. **一套几何**：字号、行高、间距、圆角只用宿主有的台阶，三页共用同一组值。
2. **一套颜色角色**：文本三级 / 边框两级 / 背景两级 / 交互底色 / 状态色，全部走 `--dsw-*`；
   action 六色是数据语义（不必是宿主色），但集中定义一次、派生色也用变量。
3. **一套行语法**：序号、动作条、issue id、标题、时间在同一批 x 位置上；同类行行高一致。
4. **一套页头**：标题 + 计数 + 工具的位置三页相同；空态 / 错误态 / 加载态共用一套排版。
5. **重做外观**：拉开信息层级（标题 > 元信息 > 细节），图的外框、工具条、图例与页面其余部分同材质。

## 边界

- 只改客户端呈现：DOM 结构与 CSS。宿主代码不动，不引新依赖，不加构建步骤。
- 交互模型不变（点行展开、行尾聚焦、Esc 退出、图上 hover / 拖动语义）。这是重做外观，不是重做交互。
- 只读约束不变：数据仍只来自 `/kiln/flow`。
- 关系图的线型阶梯（part-of 3.4px → relates-to 2 5 虚线）已被 `kiln-graph-label-threshold` 定过，
  不改语义，只允许改画在什么底色上、图例怎么排。

## 验收

- 字号不再出现 10px 与 13px 之外的手写档；全部来自一组定义在 `.dkf-root` 上的局部变量，
  变量值本身引用宿主 `--dsw-font-*` 台阶。
- 圆角只用 3 档（4 / 8 / 12），全部引用 `--dsw-radius-*`。
- 文本 / 边框 / 背景 / 交互色 0 处裸 hex（action 语义色除外，且只在一处定义）。
- `--dsw-font-family-code` 全部换成 `--ds-font-family-code`。
- 三页的行列定义收敛成一份常量，同名列 x 对齐。
- 一致性自查表（见下）逐条通过，并留下三页截图作对照。

## 收集：同类工具怎么设计

选样标准：只收「以只读身份嵌进一个宿主应用」的图 / 列表视图，而不是独立 Web 应用——
我们受制于宿主的字号台阶、面板宽度与主题，独立 app 的排版自由我们用不上。

### 1. 聚焦图 — Obsidian 的局部图

![Obsidian 局部图：一个实心焦点圆、圈外描边小圆、邻域紫色实线](assets/ref-obsidian-local-graph.png)

- 焦点是**唯一**的实心大圆，其余节点退成描边小圆 + 灰色标签；
- 焦点到邻居的边是紫色实线，非邻域的边不是隐藏，而是淡到几乎看不见——保留"还有别的结构"的信号；
- 标签直接写在节点旁边，没有框、没有底板；节点密的地方让位而不是压暗；
- 图占满内容区，设置/文件树在侧栏，图不跟列表争空间。

对照我们：聚焦视图现在是「圈外淡化 + 焦点蓝色 glow」。glow 是**第二个**视觉系统（颜色 + 阴影），
而 Obsidian 只用"实心 vs 描边 + 边着色"就分出了主次。

### 2. 结构化关系 — Obsidian 的 Backlinks 面板

![Obsidian 右栏：Linked mentions / Unlinked mentions 两个可折叠分组，条目带摘要与高亮](assets/ref-obsidian-relations-panel.png)

- 分组标题是可折叠的一行，字号比条目大一号，前面一个三角；
- 条目 = **来源标题 + 上下文片段**（片段里把命中的词高亮），条目之间不画分割线，靠留白分组；
- 整个面板是右栏一块浅底区域，与正文只靠底色差分开，没有边框。

对照我们：issue 页的聚焦结构是「`→` `←` + 关系名 + 标题」，回答"是什么关系"，
不回答"凭什么说它们有关系"。片段/证据这件事我们其实有（action 标题），只是没摆出来。

### 3. 事件流 — VS Code 的 TIMELINE 视图

![VS Code TIMELINE：左侧竖轨 + 空心点，行内只有标题、相对时间、作者](assets/ref-vscode-timeline.png)

- 一条竖轨，每个事件一个空心点，点与点之间只有竖线；
- 行内三样：标题（常规字重）、相对时间、作者，全部同一字号，只有颜色分主次；
- 行高紧凑（约 22px），没有卡片、没有分割线、没有斑马纹。

对照我们：时间线一行里塞了动作色条 + 序号 + issue id + 动作名 + 标题 + 时间 + 短 sha 七样，
比它密一档；密集不是问题，问题是七样东西**字重、颜色、字号全一样**，扫视没有抓手。

### 4. 图与行混排 — VS Code 的 Source Control Graph

![VS Code GRAPH：行左侧轨道与彩色节点、引用画成胶囊、区块标题右侧一排无边框图标按钮](assets/ref-vscode-scm-graph.png)

- 每一行左边是"轨道 + 节点"，节点颜色区分分支——图例不是单独一块，而是**每行自带**的语义；
- 引用（`upstream/main`）画成胶囊：强调色 10% 底 + 强调色文字 + 云图标；
- 区块标题（`GRAPH`）大写小字，右侧一排图标按钮，按钮默认无边框，hover 才有底；
- 选中行是整行底色高亮，不是描边。

对照我们：关系页现在是「图 + 图例网格 + 提示框」三套讲法。图例占掉一整块，
而它讲的东西（线型 ↔ 关系）在聚焦视图里其实已经由行上的关系名讲过一遍了。

### 5. 页面骨架 — Linear 的 2026-03 UI refresh

![Linear issue 视图：issue id 小字压在标题上方、卡片大圆角大内边距、引用块左侧竖线](assets/ref-linear-issue-view.png)

来源：<https://linear.app/changelog/2026-03-12-ui-refresh>。原文列的三条正是我们要做的：
header、导航与视图控件在各处保持一致；图标统一重绘并统一尺寸；侧栏比内容区更暗，让内容区浮起来。

图上可读到的排版决定：issue id 用次级色小字放在标题上方（不是同行）；标题一行 600 字重；
引用块用左侧 2px 竖线（没有底色）；卡片圆角 ≥ 16px、内边距 ≥ 16px。

### 归纳：五个可以直接照搬的决定

1. **主次只用一个维度**：焦点靠"实心 vs 描边 + 边着色"，不用 glow。
2. **分组靠留白与字号，不靠线和框**：标题大一号、条目无边框。
3. **每行自带语义**，不要独立的图例块。
4. **一条竖轨**做时间与层级的公共骨架（时间线、聚焦结构都能用）。
5. **先统一骨架再谈装饰**：标题 / 计数 / 工具三件套位置固定，装饰（圆角、底色）才有意义。

## 收集：宿主的设计系统（这是"统一"的判据）

`@deepseek-ai/dsh-client-ui-theme` 的 README 写明「token 样式表是颜色值的唯一权威来源：设计系统中
缺失的值会有意不补入；一律采用最接近的语义 token」。从它的 `lib/client.js` 里数出来：

| 类别 | 宿主提供 |
| --- | --- |
| 变量总数 | 414 个 `--dsw-*` / `--dsh-*` 定义 |
| 字号台阶 | `xxxs 11 / xxs 12 / xs 13 / s 14 / base 16 / m 18 / l 20 / xl 24`，每档带 family / weight / line-height |
| 圆角 | `--dsw-radius-xs/sm/md/lg/panel` = 4 / 8 / 12 / 16 / 28 |
| 背景 | `bg-layer-1/2/3`、`bg-base`、`bg-overlay`、`bg-skeleton` |
| 文本 | `label-primary / secondary / tertiary / dimmed / caption / inverted` |
| 边框 | `border-l1..l4`（l2 = `#0000001a`），另有 `border-thin` |
| 交互 | `interactive-bg-hover` = `#2631480f` |
| 状态 | `state-business-primary` = `--dsw-static-deepseek-500` 等 |
| 浮层 | `elevation-panel / prominent / soft`、`shadow-lv1..3` |
| 代码字体 | **`--ds-font-family-code`**（= `--dsh-font-family-code-default` 的别名） |

两条硬事实，直接决定能不能"像宿主"：

- 宿主 8 档字号不是死常量：设置里的正文字号步进器改 `--dsh-content-font-size`，台阶跟着缩放。
  我们手写 `font:12px/18px` 就是彻底脱离这套缩放。
- 宿主样式是 CSS Modules 哈希类名（`Dc7zOa_*` 这种），**不能复用**。能对齐的只有 token 与几何
  （字号 / 行高 / 圆角 / 底色 / 边框），这也正是本 issue 的范围。

## 收集：现状测量

都在 `plugin/lib/client.js` 的 `CSS` 模板串里（103 行 / 93 条规则 / 339 条声明）：

| 项 | 现状 | 宿主对应 |
| --- | --- | --- |
| 字号 | 手写 10 / 11 / 12 / 13px 五档，字重 400 / 500 / 600 | 8 档台阶，最小 11px |
| 圆角 | 2 / 3 / 4 / 6 / 10px 六种 | 4 / 8 / 12 / 16 / 28 |
| `gap` | 2 / 4 / 6 / 8 | 无间距 token |
| 行网格 | issue 行 7 列、action 行 7 列、子行 5 列，三份独立的 `grid-template-columns` | — |
| `var()` 声明 | 111 / 339 | — |
| 裸 hex 声明 | 2（`#b4690e` 警告、`#35a35f` 完成） | 状态色 token |
| hex 兜底 | 13 个不同值：`#111`×17、`#666`×14、`#999`×11、`#e3e3e3`×9、`#fff`×4… | label / border 梯队 |
| `rgba()` | 11 处（hover 底 `.04`×9、`.06`×1、tooltip 阴影 1） | `interactive-bg-hover` |
| 代码字体 | `--dsw-font-family-code`×11 —— 宿主 **0 处**定义 | `--ds-font-family-code` |

附带一个可复现的结论：`Get-ChildItem … | Select-String 'dsw-font-family-code'` 在
`@deepseek-ai` 全部包内 0 命中，`dsh-font-family-code` 2 个文件命中（定义处 + 引导脚本）。
即"改代码字体设对这三页无效"是可验证的事实，不是推测。

## 一致性自查表（apply 时逐条过）

1. 三页的页面标题行在同一 y 位置，字体与字号相同。
2. 同一列（issue id / 标题 / 时间）在三页的 x 位置相同（同一份列定义）。
3. 页面上出现的每一种字号都能在宿主台阶里找到（11 / 12 / 13 / 14 之一，或 mono 11 / 12）。
4. 页面上出现的每一种圆角都能在 `--dsw-radius-*` 里找到。
5. 文本 / 边框 / 背景 0 处裸 hex；action 六色集中定义一次。
6. hover / 选中 / 聚焦三种状态在三页用同一套表达（底色 or 阴影，不混用）。
7. 空态、错误态、加载态三页共用一套排版（标题 + 说明 + 可选动作）。
8. 深色主题下不出现"硬编码浅色底"或"看不见的边框"。

### 参考图来源

五张都是截屏，仅作排版参考，不随仓库分发许可证；上游地址：

- `ref-obsidian-local-graph.png` / `ref-obsidian-relations-panel.png` —
  <https://github.com/obsidianmd/obsidian-help>（`en/Attachments/obsidian-graph-view.png`、
  `en/Attachments/Backlinks.png`），对应帮助页面「Graph view」「Backlinks」；
- `ref-vscode-timeline.png` / `ref-vscode-scm-graph.png` —
  <https://code.visualstudio.com/docs/sourcecontrol/history>；
- `ref-linear-issue-view.png` — <https://linear.app/changelog/2026-03-12-ui-refresh>。


