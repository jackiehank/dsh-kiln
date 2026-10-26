# 图里的 issue 节点，hover 时该显示什么

## 背景

`kiln-graph-label-threshold` 把边标签撤掉之后，关系图读起来只剩形状：**节点标签就是 issue id**，
每个点当初要解决什么问题，得切到 issue 页去读。形状能看懂了，内容还没有落点。

先试最小的一步：**hover 一个节点，显示这条 issue 的 `ask` 动作标题**——也就是它开口问的那句话。

## 现状

- 节点由 Pele 渲染成 `<g class="pele-node pele-shape-…" data-id="n_<issue>">`，里面有 `<rect>` 和
  `<text class="pele-label">`；`GraphPanel` 目前只在 click 上做反查
  （`event.target.closest('[data-id]')` → `built.byNode`）。
- 快照里每条 issue 都带完整动作序列（`plugin/lib/flow.js:112` 的 `mapActions`），每条含
  `action` / `title` / `date`；标题上限 200 字（`MAX_TITLE`，`:19`）。所以 **ask 标题已经在浏览器半了**，
  不需要新通路。
- 图上现在没有任何 hover 反馈：没有 hover 样式，也没有 `<title>` 子节点。Pele 其实支持
  ——`Q.tooltip && '<title>…'`——但 tooltip 来自 mermaid 的 `click` 语句，我们的图文本不写，所以现在没有。
- 列表行（timeline / issue）里提示长文本用的是 HTML `title` 属性，交给浏览器原生 tooltip。

## 目标

hover 节点 → 出现一块说明：**这条 issue 是谁（id）+ 它 ask 了什么（标题）**。够读懂“这个点在问什么”即可。

## 边界

- 只管节点；边的 hover 仍留在 deferred（见 `kiln-graph-label-threshold` 的结论）。
- 不改图文本：不重排、不加边标签、`data-mermaid` 逐字不变。
- 不新增数据通路，只用快照里已有的 actions。
- 键盘 / 触屏可达性这一轮不做，但必须记进结论——不能只有鼠标能读到。

## 验收

- hover 节点出现说明框，内容含 issue id 与 ask 标题；移开消失；贴近窗口边缘时不溢出。
- 没有 `ask` 的 issue（理论上有 `check` 挡着，但快照可能被截断）退到最后一条动作的标题，不出空白框。
- 图的文本与布局不变。
- `npm test --prefix plugin` 通过，且覆盖“ask 不在首位”“没有 ask”两种情况。

## collect：ask 标题有多长，Pele 能怎么挂说明

1. **每条 issue 都有 ask，标题长度差得很大。** 对 `~/kiln` 的 58 条 issue 各跑一次
   `kiln path <id> --json`，取第一条 `action: ask`：58 / 58 都有；标题长度 min 17、中位 39、
   p90 81、最长 119（中文按字计）。最短的是 `action 词表硬编码、不可配置`，最长的是
   `relations-impl` 那条一口气 119 字的。**p90 就有 81 字，单行放不下**——这个数字直接决定下面的选型。
2. **Pele 的节点结构**：`<g class="pele-node pele-shape-<shape>…" data-id="n_<issue>">`，里面是
   `<rect>` + `<text class="pele-label">`。所以 `pointermove` 的 `event.target` 是内层元素，
   `closest('[data-id]')` 能拿到节点——和现在 click 的做法一致，不用另建索引。
3. **Pele 原生支持 `<title>`**：渲染时 `Q.tooltip && (…'<title>…')`。但 `tooltip` 只来自 mermaid 的
   `click` 语句（`setTooltip`），而我们的图文本是自己拼的、没有这条语句。要用原生方案，得么在图文本里
   补 `click`（会连带生成 `<a>`，改变光标与点击行为），要么在 paint 阶段往每个 `<g>` 里插 `<title>` 子节点。
4. **原生 tooltip 的形态不适合这批标题**：约 1 秒延迟、单行、由操作系统画（样式与页面无关）。
   81 字的中文在 Windows 上会是一条很长的单行，读起来费劲。要“能换行、宽度可控”，只能自绘。

## hypothesize：三种挂法

### A. 原生 `<title>`

paint 阶段往每个 `<g class="pele-node">` 里插一个 `<title>` 子节点（和现在贴 class 同一处，Pele 重绘后
重插一遍）。

| | |
| --- | --- |
| 好处 | 几乎零代码、零定位逻辑；读屏软件与触屏长按都能拿到；不占布局 |
| 代价 | 约 1 秒延迟、单行、OS 样式；81 字中文在 Windows 上是一条长条，很难读 |
| 风险 | 要在每次 Pele 重绘后重插；`<title>` 是 SVG 子元素，插入顺序错了会盖住标签的指针事件 |

### B. 自绘说明框（推荐）

`GraphPanel` 用 `pointermove` 做委托：`closest('[data-id]')` → `built.byNode` → issue id，然后在
`.dkf-graphwrap` 里渲染一个 `position:fixed` 的说明框（`pointer-events:none`）。靠近窗口右侧 /
下侧时用 `transform` 翻到另一侧，不需要量尺寸。

| | |
| --- | --- |
| 好处 | 能换行、宽度可控；样式跟随 DSH 变量；顺便放 id 与 ask 日期；不在 SVG 里，Pele 重绘不影响它 |
| 代价 | 要在 `pointermove` 里维护状态（每次移动一次 setState，只重渲染这层小组件）；键盘 / 触屏仍不可达 |
| 风险 | 拖动平移时指针划过节点也会弹框——这一轮接受 |

### C. hover 只做高亮，内容去 issue 页看

hover 时给节点加一圈描边，想看内容点一下切焦点、去 issue 页。

| | |
| --- | --- |
| 好处 | 最轻，不动信息层 |
| 代价 | 不解决“图里读不懂”的原问题；还要求用户离开图才能读到内容 |

### 选 B，规格定成这样

- 内容两行：`issue id`（等宽小字）+ `ask · 2026-10-14`；下面一行 ask 标题，宽度上限 340px、可换行；
- 没有 ask 就退到最后一条动作的标题，元信息改成“最后一条动作”，不出空白框；
- 立即出现（不延迟），移开即消失；不做 hover 高亮（先只加信息，不同时改视觉）；
- 位置：光标右下 14 / 18px；靠近右边缘 `translate(-100%, 0)`，靠近下边缘 `translate(0, -100%)`。

## 落地（apply）：hover 出说明框，读 ask 那句话

代码（`plugin/lib/client.js`）：

- `issueSummary(issue)`：优先第一条 `action: ask` 的标题；没有就退到最后一条动作的标题。返回
  `{ kind, date, title }`，纯函数，测试直接打它（测试缝 `__internals` 里加了 `issueSummary`、`tipPlacement`）。
- `tipPlacement(x, y, width, height)`：光标右下 14 / 18px；`x + 14 + 340 > width` 时 `translate(-100%, 0)`，
  `y + 18 + 120 > height` 时 `translate(0, -100%)`。用 transform 翻转，所以不必量说明框高度。
- `GraphPanel`：`pointermove` 里用和 click 完全相同的一套反查（`closest('[data-id]')` → `built.byNode`），
  拿到 issue id 才渲染说明框；`pointerleave` 收掉。说明框（`.dkf-tip`）是 React 元素、`position:fixed`、
  `pointer-events:none`，**不在 SVG 里**——Pele 重绘不会把它冲掉。
- 反查失败（边、边标签、空白）时立刻收起，所以只有节点会弹。

测试：`npm test --prefix plugin` → 30（宿主）+ 27（渲染）。新增的三例：ask 优先 / ask 不在首位也认得出 /
没有 ask 退到最后一条且空 issue 不炸；定位的靠边翻转与“拿不到窗口尺寸时不翻”；以及“默认没有说明框、
图文本里不带 tooltip 指令”。

**已知代价**：`pointermove` 每次移动都 setState（只重渲染这一层，`buildMermaid` 的 memo 不重算）；
键盘 / 触屏还读不到这块信息（下一轮）。

## 落地（apply 2）：拖动期间显式压住说明框

第一版靠的是“Pele 拖动时把指针捕获到容器”这个副作用：捕获后 `pointermove` 的 target 变成容器本身，
`closest('[data-id]')` 找不到节点，说明框自然就没了。实测确实不闪，但这不是我们的保证——
Pele 改捕获策略、或者我们挪走监听，闪烁就会回来。

所以补一笔显式的：`pointerdown` 记 `dragging = true` 并立刻收框，`pointerup` / `pointercancel`
清掉（监听挂在 `window` 上：捕获期间抬起事件可能落在容器外）。用 ref 而不是 state，拖动本身不该
触发重渲染。

行为上还剩一个小缝：单击节点（按下即抬起、没有移动）之后说明框不会自己回来，要等下一次移动。
这是按下即收的直接后果，比反过来（按下后还挂着、拖动时再收）简单，先这样。

测试：宿主 30 + 渲染 27 不变，渲染用例里补了一条断言——图容器必须接住 `pointerdown`。

## 待定（下一轮）

1. 说明框要不要再补一行信息（domain / 当前动作 / 邻居数）——先看实际用起来缺不缺。
2. 键盘 / 触屏可达：节点能否聚焦并朗读 ask 标题（现在只有鼠标能读到）。
3. 密集区快速划过会不会闪——如果会，加的是「离开宽限」（约 120ms 再收），不是出现延迟。
