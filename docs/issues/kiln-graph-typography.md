# kiln-graph-typography — 关系图的文字接入统一字号

## 问题

三页的列表、页头、图例都已经走 `--dkf-fs-*`（11 / 12 / 13px，来自宿主台阶），
只有**图里的文字**没有：

- **字号没接入**：Pele 的布局与渲染都用 `fontSize ?? 16`（bundle 里 35 处），
  所以节点标签、边标签都是 16px —— 比同一页的行标题（12px）大一档半，
  在侧栏里显得"图比内容大一号"。
- **字族是隐式继承**：Pele 会从宿主元素的计算样式里读 `--pele-font`，没有就退回宿主计算出的
  `font-family`。我们没设这个变量，所以当前"恰好"是宿主字体——能对，但没人声明过，
  哪天 `.dkf-root` 不设 font-family，图就静悄悄退回 `sans-serif`。
- **等宽没接入**：`--pele-font-mono` 未设，Pele 内部退回字面量 `monospace`，
  而不是宿主设置里的代码字体（`--ds-font-family-code`）。

## 目标

图的字体从 `.dkf-root` 已有的角色里来，和另外两页同一套：

- 字族 ← `--dkf-sans`（`--dsw-font-family`），等宽 ← `--dkf-mono`（`--ds-font-family-code`）；
- 字号 ← 容器实际计算出的字号（`.dkf-root` 的 12px），**并且要进 Pele 的布局**，
  不能只改渲染——只改渲染会"字缩小、框不变"，节点里多出一圈空白。

## 边界

- 不动线型阶梯、配色、交互、布局算法。
- 不新增 token：只引用 `--dkf-sans` / `--dkf-mono` / 容器字号。
- 不引入字体文件，也不改宿主设置。

## 验收

- 图里的文字 12px，与行标题同号；字族与页面一致；等宽元素走代码字体。
- 字号变化必须同时体现在**测量**上：同一张图在 16px 与 12px 下的节点框宽度不同
  （否则就是"字小了框没小"）。
- 拿不到计算样式时退回 12，不能把 `NaN` 传给渲染器。

## 收集：Pele 的三个字体入口

Pele 在生成的 `<svg>` 上写一段内联样式，字体全在里面（把 `fontSize:12` 传进去后的实测输出）：

```text
--_fm:var(--pele-font-mono,"JetBrains Mono", monospace);
font:12px sans-serif;
letter-spacing:normal;word-spacing:normal;text-transform:none;direction:ltr;
font-family:var(--pele-font,"PingFang SC", system-ui, sans-serif)
```

| 入口 | 谁给的 | 默认 | 备注 |
| --- | --- | --- | --- |
| `--pele-font` | 宿主元素的 `--pele-font`，没有就退回宿主计算出的 `font-family` | 无 | 字族**能继承**，但属于隐式兜底（我们没声明） |
| `--pele-font-mono` | 同上（`--pele-font-mono`） | 无 | 未设时退回字面量 `monospace`，不是宿主的代码字体 |
| `fontSize` | **mount 选项** | `16` | bundle 里 `n.fontSize ?? 16` 出现 35 次；没有对应的 CSS 变量 |

关键点：字号**没有** CSS 变量可设，只能走 mount 选项；而 CSS 覆盖 `font-size` 只改渲染、
不改测量（`measurer` 用的是 `fontSize` 算出来的文本宽度），那会变成"字小了框没小"。

### 实测：选项同时影响测量与渲染

把 vendored 的 chunk 在 Node 里直接跑（`render(text, opts)`，不碰浏览器）：

| 传入 | 内联样式 | 最宽节点框 | 整图宽 |
| --- | --- | --- | --- |
| `fontSize: 16` | `font:16px sans-serif` | `171.15 × 48` | `391` |
| `fontSize: 12` | `font:12px sans-serif` | `137.36 × 42` | `327` |

框跟着字号一起缩了（171 → 137），说明 `fontSize` 进的是布局参数，不是只改字体。
这条正是"能不能只靠 CSS 改字号"的判据——答案是不能。

复现：

```powershell
node -e "
  const fs=require('fs'),vm=require('vm');
  let src=fs.readFileSync('plugin/lib/client.pele.js','utf8').replace(/if \(typeof window[\s\S]*$/,'');
  src+='\nglobalThis.__pele=pele\n';
  globalThis.window={__ModuleLoader__:{load(){}}};
  vm.runInThisContext(src);
  const t='flowchart LR\n  a[\"kiln-dsh-integration\"]\n  b[\"kiln-flow-focus-ui\"]\n  a -.-> b';
  console.log(__pele.render(t,{fontSize:12}).width, __pele.render(t,{fontSize:16}).width);
"
```

### 结论

- 字族/等宽：在 `.dkf-graph` 上声明 `--pele-font: var(--dkf-sans)`、`--pele-font-mono: var(--dkf-mono)`，
  从"隐式继承"变成"显式声明"，同时把等宽接到宿主的代码字体。
- 字号：把容器的计算字号（`.dkf-root` 的 12px）作为 `fontSize` 传给 `pele.mount()`，
  测量与渲染一起变；拿不到计算样式时退回 12。

## 落地

三处，都在客户端半：

1. `.dkf-graph` 加两行：`--pele-font:var(--dkf-sans)`、`--pele-font-mono:var(--dkf-mono)`。
2. 新函数 `graphFontSize(computed)`：从 `getComputedStyle(容器)` 取 `font-size`，
   夹在 8–24，读不到就退回 12（`GRAPH_FONT_FALLBACK`）。
3. `pele.mount(host, source, { zoom, fontSize: graphFontSize(computed), onRender })`
   —— 字号进的是**布局参数**，不是 CSS。

顺带修掉一处不一致：`TIP_MAX_WIDTH` 常量是 340，而改版后的 `.dkf-tip` 是 `max-width:320px`
（说明框靠右时会多翻 20px）。统一成 320，与"位置由常量算、宽度由 CSS 画"的约定对齐。

### 验证

- `npm test --prefix plugin` → 35 个宿主用例 + 31 个渲染用例全过。新增两条：
  `graphFontSize` 的读取/夹取/退回（12、13.4→13、2→8、40→24、空→12），
  以及 CSS 里 `--pele-font` / `--pele-font-mono` 的接线。
- 测量是否真的跟着字号走：用 Node 直接跑 vendored 的 `render()`，`fontSize:16` 时最宽节点
  `171.15×48`、整图 `391`；`fontSize:12` 时 `137.36×42`、整图 `327`。框缩了 20%，
  说明不是"只换字体"。
- **没验证到的**：实拍（沙箱里起不了 Chromium）。重启后应看到：节点/边标签的字与行标题同号，
  长标签的图整体变窄、更适合侧栏。

### 已知边界

- 字号在 mount 时读一次：改宿主字号设置后，切一次页（视图重挂载）就会跟上；
  不切页时图会保持旧字号，直到下一次重画。
- 换主题不用重挂载：颜色与字族都是 CSS 变量，实时生效；只有"测量"用的是挂载时的字号。

