# 关系图上的“调宽手柄”

## 背景

关系页的图上有一条竖直灰线（窗口中间偏下），鼠标靠近会变成左右拖动光标，拖它改的是 **DSH 对话
内容的宽度**（正文/输入框那一列），不是图。它在图里看着像一条关系线，读图时容易误认；而且它和
图的平移手势抢同一块区域——在它那 10px 带上按住拖，改的是对话宽度。

## 目标

kiln 视图激活时不出现这个手柄：不可见、不可拖、不抢光标。切回对话页后它照常工作。

## 边界

- 只藏“调宽手柄”，不动对话页的调宽能力，也不改 DSH 的代码（不 patch 壳）；
- 不改图的布局与交互（缩放 / 平移 / 点击聚焦）；
- 只靠插件自己的 CSS 作用域，壳的结构变了要能退化回现状（不报错、不白屏）。

## 验收

- kiln 视图激活时看不到手柄竖线，指针经过原来的位置也不再变成 `col-resize`；
- 在关系页沿原手柄位置横向拖动 = 平移图，不再改对话宽度；
- 切回对话页手柄恢复；
- `npm test --prefix plugin` 通过（CSS 规则断言）。

## 待定

1. 藏的范围：三页都藏，还是只藏关系页（图上才有歧义）。
2. 用 `.dkf-root` 作锚点，还是给根再加一个 `data-kiln-view`（更显式，但要动组件）。
3. 壳以后改 DOM 时，这条 CSS 失效的方式是否可接受（静默退化 vs 加个可视化提示）。

## collect：它是什么、长在哪、能不能藏

### 1. 出处：DSH 对话容器的调宽手柄

`@deepseek-ai/dsh-client-ui-conversation/lib/client.js`（本机 `app.asar` 抽出来的那份）：

- `WidthHandle`（`:17399`）渲染 `<div class="Dc7zOa_widthHandle" data-side="left|right"
  data-width-handle="left|right">`（属性见 `:17470`）；
- 样式在 `:17325`：`position:absolute; top:0; bottom:0; width:min(10px, …); cursor:col-resize;
  z-index:0`。`:after` 是一条 2px 竖线，默认 `opacity:0`，只有 `:hover` / `[data-dragging]` 才显形
  ——**所以“线”只在指针靠近时出现，但 10px 命中区和 `col-resize` 光标一直都在**，这也是它和图
  平移抢手势的原因；
- 拖完把宽度写进 `localStorage["dsh.conversation.contentWidth"]`，并用 `ResizeObserver` 把
  `--dsh-conversation-column-width` / `--dsh-chat-user-width` 发布到父元素（`:17512` 附近）。

### 2. 它和我们的视图是兄弟

`ConversationContent` 的 JSX（`:17862`–`:17877`）：

```text
div[data-conversation-content][data-conversation-region=chat]
├ div[data-conversation-scroll]
│  ├ Views                 ← conversation.session → conversation.view（.dkf-root 在这层里）
│  └ div[data-composer-seat]（输入框）
└ WidthControls → div[data-width-handle=left|right]
```

手柄**不在**我们的子树里，但它和我们的根共享同一个 `[data-conversation-content]` 祖先。

### 3. 能用的钩子

- `data-width-handle` 是稳定属性；类名 `Dc7zOa_*` 是 CSS Module 哈希，不能依赖；
- `.dkf-root` 是我们自己的根节点（`KilnView` 的 className），稳定；
- 壳自己就在用 `:has()`（例如 `[data-conversation-scroll]:has(.xz4KEq_root[data-chat-following-tail])`，
  这个 `client.js` 里有 6 处），说明这个 Chromium 支持；
- 于是只需一行：

```css
[data-conversation-content]:has(.dkf-root) [data-width-handle] { display: none }
```

我们的根卸载时（切回对话页）`:has()` 不再命中，手柄自动回来——不用 JS、不落状态。

### 4. 副作用核查

- 手柄是绝对定位、`z-index:0`，不参与布局；藏掉不会让内容跳位；
- 宽度测量在 JS 里（`ResizeObserver`），`display:none` 不卸载元素 → CSS 变量照常发布，
  对话页的宽度偏好不受影响；
- 我们自己的样式与布局不依赖 `--dsh-chat-content-width` 或手柄元素（`plugin/lib/client.js` 里
  `grep` 零命中）；
- 手柄在 `[data-dragging]` 时 `z-index:8`，只在拖拽中出现，藏掉更不会触发。

### 5. 没有官方开关

`conversation.view` 注册项只有 `{id, order, label}` 这类展示字段；手柄由 `ConversationContent` 里的
内部 factory slot 渲染（`CONTENT_SLOTS`，`:17530`），全仓只有 `dsh-client-ui-conversation` 引用它，
插件拿不到。→ 只能靠 CSS 作用域，这是本条 issue 的边界。

### 6. 验证限制

视觉验证只能重启桌面应用；工程侧能断言的是“CSS 里有这条规则”与“根节点锚点稳定”。

### 结论（交给 hypothesize）

能藏，成本是一行 CSS，且不依赖 JS。真正要定的是范围（三页 / 只关系页）和锚点写在哪。

## hypothesize：藏的范围

### A. 三页都藏（选中）

规则不区分“哪一页”，只看 `.dkf-root` 在不在：

```css
[data-conversation-content]:has(.dkf-root) [data-width-handle] { display: none }
```

理由是**命中区的问题三页都有**：手柄的 10px 命中区会一直抢“横向拖动”这个手势，列表页里虽然不
容易把线误读成关系线，但划过它时光标会变成 `col-resize`，在列表上想选字/拖动也会撞上。而调宽这
件事本身就是对话页的偏好——在 kiln 里调完也看不到对话，切回去调才合理。

### B. 只藏关系页

用 `:has(.dkf-graph)` 限定，只保留“图上才误读”这个理由。代价是两条规则、两套解释，且列表页仍会
被 `col-resize` 撞一下。

### C. 只禁指针、保留可调宽

`pointer-events:none` 只能挡住命中区，2px 竖线的 hover 效果也就不会再出现；但“调到一半的隐藏”
意义有限：既然看不见也拖不动，不如彻底 `display:none`，省得解释“为什么这里有个看不见的控件”。

**选 A**：一条规则覆盖三页，行为可一句话解释——“kiln 里不显示调宽的竖线”；切回对话页自动恢复，
因为我们只是靠 `:has(.dkf-root)` 决定它出不出现，没有改壳的任何状态。

## 落地（apply）：一行带作用域的 CSS

```css
[data-conversation-content]:has(.dkf-root) [data-width-handle]{display:none}
```

位置在 `plugin/lib/client.js` 的 `CSS` 里（紧跟说明框样式），上面的注释写清了为什么用 `:has(.dkf-root)`
限定、而不做全站隐藏。

- 只在我们根节点挂载时命中；切回对话页 `.dkf-root` 卸载，规则自然失效，手柄回来；
- 不碰壳、不加 JS、不落状态；
- 壳以后改 DOM 时这条规则最多**静默失效**（退回现在的样子），不会报错、不会白屏。

测试：31（宿主）+ 28（渲染）。新增两例：CSS 里必须有这条带作用域的规则、且不能出现不带作用域的
`[data-width-handle]{display:none}`；渲染用例里断言根节点确实带 `.dkf-root`（规则的锚点真实存在）。

**已知限制**：视觉验证仍需重启桌面应用；这条规则依赖三个钩子——壳的 `[data-conversation-content]`、
`[data-width-handle]`，以及我们自己的 `.dkf-root`。壳若改名就静默失效，届时换掉属性名即可。

## 待定（下一轮）

1. 壳若改了这两个 `data-*` 属性，怎么尽早发现（现在只能靠肉眼发现竖线回来了）。
2. 是否把“kiln 里不显示调宽手柄”写进插件说明，免得以后有人以为是 bug。
