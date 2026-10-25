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

## hypothesize：取景、表达、加载

前提：`--json` 本来就是给数据的（用户确认），`--mermaid` 只是给人看的副产品。所以**数据走 `edges`，
图像是可以自由重排的投影**——不再受“kiln 出什么文本就只能用什么文本”的约束。

### 假设 1：图与列表并存，图是默认（不替换、不二选一）

| 备选 | 评价 |
| --- | --- |
| A1 只保留图 | 丢掉精确关系名（`relates-to` 53 条在图上都是无标签线），也丢掉强弱分组；否 |
| A2 **列表 ⇄ 图 切换，图默认** | 图看形状、列表读文字；两者共用同一份数据与同一个焦点；取 |
| A3 全局用图、聚焦用列表 | 同一页两种介质来回跳，位置记忆全断；否 |

分段控件从“三页”内部再加一档（只在 relation 页内），状态进 `viewStates`（`relationMode`），
与已有的 tab/focus/expanded 一起记忆。

### 假设 2：mermaid 文本自己生成，`kiln --mermaid` 只当语法样板

四条理由（对 collect 1 的两条限制）：

1. **对称边能带标签**：`A -. relates-to .- B`，53 条无向边不再是静默的线；
2. **强弱能进 classDef**：`ordering` 槽（`part-of` / `blocks`）与 `lineage` 槽
   （`supersedes` / `caused-by` / `relates-to`）可以给实线/虚线，语义与列表分组同源；
3. **节点 id 自己定**（`n_<slug>`），不依赖复刻 kiln 的 sanitize + 撞名规则，`data-id` 映射稳定；
4. 标签可以只写 issue id（见假设 4），58 个 `id (apply)` 会撑爆节点。

代价：文本不再与 `kiln graph --mermaid` 逐字一致。用 test 兜住事实：**节点集 = 快照 issues 集、
边集 = 快照 edges 集、方向按词表推导**，保证“图画的是同一份图”。

### 假设 3：聚焦不改布局，只改视觉；分四档

| 档 | 范围 | 视觉 |
| --- | --- | --- |
| 焦点 | 自己 | 实心 accent 描边 + 不透明 |
| 强邻居 | `part-of` / `blocks` 一跳 | 不透明，描边正常 |
| 弱邻居 | 其余关系一跳 | 不透明，描边转灰 |
| 无关 | 其余 | 整组 `opacity: .3`，边一并淡 |

实现优先走纯 CSS：`.pele-node[data-id="n_x"]` 已确认可用（theming 文档），切焦点只加/删根容器属性，
**SVG 字符串不变、位置不动**。

不确定的是边：Pele 没文档说明 `.pele-edge` 上有没有 from/to 之类的属性。
**兜底**：重绘同一份文本（节点集、边集不变 → 布局应是确定且相同的），用 `classDef`/`linkStyle` 表达；
这条要在浏览器里验一次“重绘后节点坐标是否逐点相同”，不同就退回“边不做区分，只淡化全部”。

### 假设 4：节点只写 id，颜色 = 最近动作的类型色

与 timeline / issue 同一张 `ACTION_COLOR` 表：图上看颜色就知道这个 issue 停在哪种动作，
但**不把状态写进标签**（`(apply)` 这类由 issue 页负责）。这也是全项目“同一 action 同一颜色”的延伸。

### 假设 5：进页面就是全图，无焦点；不默认裁成 1 跳

理由：默认就裁，等于一进来看不到全局，“全局与聚焦同框”也就没发生过。
辅助：Pele 自带缩放/平移/窄屏转 TB；聚焦时外周淡化（假设 3）。

风险：`~/kiln` 58 节点在几百像素里读不清。可接受——图看形状，读文字切列表；
若实测真的不可读，退路是“聚焦时只画 1 跳 + 一个「展开全部」按钮”，但那要重排，得重评假设 3。

### 假设 6：Pele 用 `require.async` 懒加载，首次进关系页才取

- 文件放 `plugin/lib/pele.global.js`（vendored，MIT，记录版本与来源），随插件走，断网可用；
- 首次切到“图”才 `require.async`，不进首屏；
- 体积未测：先量 `dist/pele.global.js`；若 > 1.5 MB，改用 `dist/esm/core.js` + `dist/esm/diagrams/flowchart.js`
  （只装 flowchart，需确认这两份是自洽的相对导入）。

### 与其它页的手势差异（一条，需接受）

- 行页：**点行 = 展开**，聚焦靠行尾 `⌖ 聚焦`；
- 图上没有“行”也没有可展开的内容，所以**点节点 = 聚焦**；取消走头部 chip / `Esc` / 点空白。
  这是三页里唯一一处手势不一致，理由是“节点没有第二层”。

### 验收

1. 无焦点：节点数 = 快照 issues 数，边数 = 快照 edges 数（含对称边）；
2. 聚焦：**SVG 不变**（同一份字符串），只有根属性/类变化；切焦点连续点 3 个节点，节点坐标不动；
3. 切焦点不产生新的 `/kiln/flow` 请求；
4. 断网可用（vendored，无 CDN）；
5. 列表仍在，切回去焦点与展开项不丢；
6. `~/kiln` 58 节点能出图、能缩放；渲染耗时进控制台一行（与 `[kiln] snapshot` 同样的排查口径）。

### apply 时要实测的四件事

1. `.pele-edge` 上有没有可定位边的属性（决定假设 3 走 CSS 还是重绘）；
2. `require.async` 对 IIFE（`globalThis.pele`）的处理；
3. `render()` 在 58 节点上的耗时；
4. `dist/pele.global.js` 的真实体积。

## 落地（apply）

### 图怎么生成

`buildMermaid(issues, relations)`（`plugin/lib/client.js:387`）从**快照**出文本，不调 `kiln graph --mermaid`：

| 项 | 规则 |
| --- | --- |
| 节点 | `n_<slug>`（只留 `[A-Za-z0-9_]`，撞名加 `_2`），标签只有 issue id |
| 节点色 | 每个最近动作一条 `classDef act_<action> stroke:<ACTION_COLOR>`，与另两页同一张色表 |
| ordering 边 | `a -->\|part-of\| b`（实线，方向按词表归一后） |
| lineage 边 | `a -.->\|caused-by\| b`（虚线） |
| 对称边 | `a ---\|relates-to\| b`——关系名保住了（kiln 自己的 `--mermaid` 会丢） |
| 快照外目标 | 不画，计数进 `dropped`，页面上明说 |

**文本与焦点无关**：`graphTiers`（`:438`）算焦点/强弱一跳，`paintFocus`（`:456`）只 toggle
`.pele-node` 上的 `dkf-gnode-dim` / `dkf-gnode-focus`。所以切焦点不重解析、不重排。

### 组件与状态

- `GraphPanel`（`:771`）：渲染期算文本并挂 `data-mermaid`（排查与测试都用得到），
  effect 里 `loadPele()` → `pele.mount(host, source, {zoom:'auto'})`；点击走事件委托，
  `.pele-node[data-id]` → `byNode` 反查 issue → 聚焦；
- `RelationPanel`（`:861`）/ `RelationList`（`:896`）：页内“图 / 列表”分段；
- `relationMode` 进 `viewStates`，与 tab / 焦点 / 展开项一起按仓库记忆；
- `loadPele`（`:117`）：`require.async('./pele.global.js')`，首次进图才取；取不到返回 `null`。

### 验证

- `plugin/test/render.mjs` **18 例**（新增 4：默认图取景、`data-id` 反查、mermaid 源与焦点无关、
  取景切换）；`plugin/test/run.mjs` 24 例不变；
- 无浏览器环境能验的都验了：源文本、节点映射、焦点不改文本、模式切换。

### 已知代价

1. **边不能单独淡化**：Pele 没给边任何可定位属性（collect 3 的未验点落地为“做不到”），
   所以聚焦只淡化无关**节点**，边保持原样。要按边区分就得重绘（放弃“布局不动”），暂不做。
2. **`pele.global.js` 还没入库**：本机沙箱没有 TLS 出口，`cdn.jsdelivr.net` / registry 全 SSL 失败。
   补齐（一条命令，之后重启应用）：
   ```powershell
   curl.exe -L -o plugin/lib/pele.global.js https://cdn.jsdelivr.net/npm/pele@1.10.0/dist/pele.global.js
   ```
   文件到位前，关系页照常工作，只是显示 mermaid 源码 + 一行说明，不报错。
3. **未在浏览器实测**：`data-id` 命中、缩放、点击穿透都依赖 Pele 的实际 SVG，需重启后看。

### 与假设的偏差

- 假设 3 的“边一并淡化”降级为“只淡节点”（原因见代价 1）；
- 假设 6 的“vendored”未完成（原因见代价 2），代码路径已按 vendored 写好。



