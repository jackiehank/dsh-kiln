# relation 页：全局关系与聚焦状态怎么同框

## 背景

三页共享焦点已落地（`kiln-views-shared-focus` + `kiln-focus-gesture`）。relation 页当前是**分组边列表**：
全局态把所有边按关系名分组排成行（`caused-by` / `relates-to` …），聚焦态只留焦点与一跳邻居，
强关联展开、弱关联折叠。它能读，但**看不出“关系”的形状**——中心性、链路、谁挂在谁下面，
全靠逐行读 id 再在脑子里连。

设计讨论里提出两条新线索，本条接住：

1. `kiln graph --mermaid` 能直接出 flowchart 文本（**已核实**，见下）；
2. 样式上想用 **Pele**——Obsidian 作者 kepano 2026 年发的 mermaid 渲染器（**已核实**：MIT、
   无运行时依赖、出可主题化 SVG、有 `global` 单文件版）。

## 问题

**全局关系与聚焦状态，怎么在同一块地方表达？**

- **图还是列表**：relation 页改成真图，还是图只作为第三种取景（列表保留）？
- **焦点怎么落在图上**：高亮焦点？淡化其余？裁成子图？加一层外框？逐个都试一遍才知道，
  但有一条硬约束——**布局不能跳**。点一下焦点整张图重排，人就丢了位置，等于换个地方重新找。
- **成本**：现在焦点是纯客户端投影（`relatedOf`，零重取、零重排）。换成图之后，
  切焦点还允不允许重绘/重布局？允许多大的图？
- **文本谁生成**：直接用 `kiln graph --mermaid` 的输出，还是从已有的 `edges` 自己拼 mermaid？
- **Pele 怎么进来**：客户端没有构建步骤，`pele.global.js` 单文件要经由哪里加载；
  断网（或没有 CDN 出口）时还能不能出图。

## 已核实的事实（详见 collect）

- `kiln graph --mermaid` 出 `flowchart LR`：节点 `i_<id>`、标签 `<id> (<state>)`；
  有向边 `A -- 关系名 --> B`，**对称边（`relates-to`）只画一条无标签连线 `---`**；
  未开过的目标 issue 也建节点，状态写 `missing`。
- `--issue` / `--depth` **只服务 `--json`**，`--mermaid` 拿不到邻域收窄——“聚焦态的子图”
  得自己裁。
- 规模实测（`~/kiln`，58 issue）：58 节点 / 73 边（20 有向、53 无向），mermaid 文本 6156 字符 / 132 行。
  **这个量级在几百像素宽的侧栏里不可能全画清**，必须定默认取景。
- Pele 1.10.0：`render(text)` 同步返回 `{svg,width,height,type,mermaidType,links}`；
  `mount(el, text, opts)` 读容器宽度、随宽度重排（ResizeObserver）、`autoDirection` 在窄屏把 LR 转 TB、
  自带缩放/平移/键盘、`onRender` 回调拿得到 SVG（可在其上挂交互）；主题是 CSS 变量 `--pele-*`。

## 边界

- 只读；**不新增数据通道**：仍只吃现有快照（`kiln graph --json` 的 `edges` / `nodes`），
  切焦点不重取；
- 不改三页语义与焦点语义（`kiln-views-shared-focus` 已定），也不改 tab 注册方式；
- **不引构建步骤**：客户端仍是纯 `React.createElement`，Pele 必须是可直接加载的产物；
- 断网可渲染（图不是装饰，缺网就白屏不算落地）；
- 大图有退路：能缩、能移、能只画一跳。

## 待定

1. 图的地位：替换列表，还是“列表 / 图”切换，还是列表=全局、图=聚焦；
2. 聚焦在图上分几档（焦点 / 强邻居 / 弱邻居 / 无关），各用什么视觉量（色、透明度、线宽、虚线）；
3. 切焦点时**只改 class 还是重绘**（布局稳定性）；
4. mermaid 文本由 kiln 出还是本地生成（后者才能给对称边加标签、给强弱上色）；
5. Pele 的加载方式（宿主路由直供 vendored 文件 / CDN / 其它）与体积代价；
6. 全局态的默认取景（全图 + 缩放？还是聚焦 1 跳 + “展开全部”）。

## collect：核实 mermaid 与 Pele 的能力边界

### 1. `kiln graph --mermaid` 的输出（真跑）

`kiln graph --mermaid`（本仓，4 issue / 3 边）：

```text
flowchart LR
  i_kiln_dsh_integration["kiln-dsh-integration (apply)"]
  ...
  i_kiln_flow_focus_ui -- caused-by --> i_kiln_dsh_integration
```

生成规则（`~/kiln/internal/engine/engine.go:468`）：

| 项 | 规则 |
| --- | --- |
| 方向 | 固定 `flowchart LR`，不跟随数据 |
| 节点 id | `i_` + 只保留 `[A-Za-z0-9_]`（其余归一成 `_`）；**撞名加 `_2` 后缀**（`a-b` 与 `a.b` 会撞） |
| 节点标签 | `<issue id> (<状态>)`，`"` 转义成 `#quot;`；未开过的目标 issue 也建节点、状态写 `missing` |
| 有向边 | `A -- <关系名> --> B` |
| 对称边 | **`A --- B`，关系名丢掉**（`relates-to` 因此看不出是哪种关系） |
| 排序 | 节点按 id、边按 (from,to,name)，同仓永远同一份文本 |

两条硬限制：

- `--issue` / `--depth` **只服务 `--json`**，`--mermaid` 直接报错 `--issue/--depth 只服务 --json`（退出码 1），
  所以“聚焦态的邻域子图”**不可能由 kiln 裁**，只能自己裁；
- 节点 id 与 issue id 不是一一可逆（sanitize + 撞名），要按 `data-id` 挂交互就得复刻 kiln 的命名，
  或者干脆自己生成文本。

规模（`~/kiln`）：58 节点 / 73 边（有向 20 = `caused-by` 19 + `blocks` 1；`relates-to` 53 条全是无标签线），
文本 6156 字符 / 132 行。

### 2. Pele（核实到 1.10.0）

- 出处：Obsidian 作者 kepano / `obsidianmd/pele`；npm `pele`，**MIT**，`type: module`，
  `engines.node >= 20`；整包 unpacked 2.3 MB / 418 文件（含全部 33 种图与各图 lazy 入口）。
- 入口：`.` → `dist/pele.js`；**`./global` → `dist/pele.global.js`（可直接 `<script>`，挂 `pele` 全局）**；
  `./lazy`、`./core`、`./diagrams/*` 可按图类型拆。
- 渲染：`render(text, opts)` 同步返回 `{ svg, width, height, type, mermaidType, links }`；
  `mount(el, text, opts)` 读容器宽度、随宽度重排（ResizeObserver）、`update()` / `refresh()` / `destroy()`。
- 窄屏：`autoDirection` 默认 `true`，**< 640px 时 LR 自动转 TB**；`directionBreakpoint` 可调。
- 大图：`maxEdges` 默认 5000，`limit` 源长度 5 万字符，超限抛 `PeleError`（`limit` / `syntax` / `semantic`）。
- 交互自带：缩放/平移（滚轮+修饰键、拖拽、双击、`+`/`-`/`0`/方向键），可用 `zoom: false` 关掉；
  `onRender(result)` 回调拿得到 SVGRoot，是挂自定义事件的入口。
- 主题：CSS 变量 `--pele-bg/fg/muted/line/surface/surface-alt/border/accent/critical/error/radius/font…`，
  **换色不重绘**；`.pele-node` 是节点组，**`data-id` 就是 mermaid 源里的节点 id**。

### 3. 由上面两条推出来的可行/不可行

- ✅ **“聚焦只改 class、不重排版”成立**：`.pele-node[data-id="i_x"]` 可被 CSS 直接选中，
  切焦点只是改根容器上的 `data-focus` / 给节点加 class，SVG 不重解析、位置不动；
- ⚠️ **边的定向高亮没有现成抓手**：文档只给了 `.pele-edge`（组），没给边的 `data-id`；
  按 mermaid 的语义，边只能靠 `linkStyle <序号>` 上色——那要求**文本由我们生成**（序号可控）；
- ⚠️ 反过来，若文本用 kiln 现成的，则：对称边丢关系名、无法分强弱上色、节点 id 需复刻 sanitize 才敢挂交互；
  → 倾向**自己从 `edges` 生成 mermaid**（数据仍只来自 `kiln graph --json`），`kiln --mermaid` 只当语法样板；
- ✅ 宿主可以把 vendored 文件直供出去（`webServer.register` 的 handler 能任意设 `content-type`，
  见 `plugin/lib/index.js:37`），但该路由套着 `connection.requestRejection` 栅栏，
  `<script src>`（无自定义头）能否过栅栏**没验**，这条要进 hypothesize 的第一个 test。

### 4. 现状位置（改造点）

- `plugin/lib/client.js:269` `relatedOf`（一跳收集，焦点语义唯一来源）
- `plugin/lib/client.js:314` `globalRelationRows`（现在的“全局关系”= 按关系名分组的边行）
- `plugin/lib/client.js:626` `RelationPanel`（两种态的分发）

### 5. 没拿到的数字

`dist/pele.global.js` 的**单文件体积没测到**：本机没有外网出口（`Invoke-WebRequest` / `curl`
都是 SSL 失败），registry 元数据只说整包 2.3 MB。这条在上线前必须实测——它决定是“直接 vendor”
还是“用 `pele/lazy` 只装 flowchart”。

### 6. 插件怎么带第二个客户端 chunk（这条决定 Pele 怎么进包）

本机 profile 里已经装了一个这么干的插件：`@xbzbing/dsh-git-panel@1.9.1`。

- `lib/client.js`（377 KB）里写着 `var Wc = require.async; … Wc("./client.mermaid.js")`，
  同目录躺着 `lib/client.mermaid.js`（**5.25 MB**，mermaid 12.2.0 整包）；
- 它的宿主半边（`lib/host/*`）搜不到 `register` / `content-type`——**没有自建静态路由**；
- `package.json` 的 `exports` 里也没有第二个 chunk 的条目，只在 `files` 发布清单里列了文件名。

**结论**：DSH 的客户端模块加载器支持插件**按相对路径异步取自带 chunk**（`require.async`），
不需要宿主供文件、不需要 `exports` 声明。由此：

- `pele.global.js` 直接放 `plugin/lib/` 旁边、`require.async('./pele.global.js')` 取回即可；
- **不需要**新增 `GET /kiln/vendor/*` 路由，也就绕开了 `requestRejection` 栅栏那个未验点（collect 3）。

**未验**：`pele.global.js` 是 IIFE（挂 `globalThis.pele`），不是 ESM；`require.async` 对非模块脚本
如何处理没实测过。退路：同一机制取 `dist/pele.js`（ESM）再 `import()`。

