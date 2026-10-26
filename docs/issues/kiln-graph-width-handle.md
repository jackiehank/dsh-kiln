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
