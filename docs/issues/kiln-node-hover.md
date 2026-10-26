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

## 待定

1. 用原生 `<title>`（零 JS）还是自绘说明框。
2. 说明框里除了 ask 标题还放什么（domain / 当前动作 / 邻居数 / 日期）。
3. 出现时机：立即 / 300ms 延迟；要不要同时给 hover 的节点一个高亮。
