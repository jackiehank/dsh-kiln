# kiln-search — 插件里的全局搜索框

## 问题

三页都只有"按属性收窄"（`kiln-issue-filter` / `kiln-timeline-filter`），没有"按记忆里的字符串找"。
仓库一大就不够用：本仓 16 条 issue、`~/kiln` 58 条，动作数 104 / 256。
典型场景是"我记得有条 issue 名字里带 graph，但想不起是哪条、属于哪个领域"——
这时要一个一个看，或者把整页滚一遍。

## 目标（这一版的最小要求）

**能按 issue 名找到 issue**：输入片段 → 列表收窄 → 命中片段可见 → 回车聚焦到那条 issue。

"要不要做成多功能搜索"**这一版不定**，留给 hypothesize 比较。候选范围：

- 只搜 issue id（最小）；
- 加上标题（issue 的 ask / 最后动作标题）与动作标题；
- 再加标签、领域、关系名（`part-of` / `blocks`…）；
- 或者学 Quick Open 的前缀语法（`#tag`、`@action`）把多功能塞进一个输入框。

## 边界

- **客户端过滤**：数据都在快照里，不加宿主路由参数、不调 `kiln list`。
- 不引第三方搜索库：模糊匹配与高亮自己写（几十行）。
- 不改现有筛选的语义；搜索与筛选是两条路，可以叠加，但不能互相顶掉。
- 不做跨页的"跳到某个动作"（要不要有，取决于多功能那条怎么定）。

## 验收（最小版）

- 输入即收窄（不按回车才搜）；没有命中时给明确空态，而不是空列表。
- 命中的片段在结果里可见（高亮）。
- 键盘能全程操作：进入搜索、上下选、回车确认、Esc 退出各一条。
- 清空输入后回到进入搜索前的视图（筛选状态、展开项不被破坏）。
- 纯函数（匹配 + 排序 + 高亮切分）可单测。

## 收集：同类工具的搜索是怎么做的

看的是三种形态：**一个输入框按前缀切模式**（VS Code Quick Open）、**就地过滤 + 分组计数**
（VS Code Search 面板）、**语法化查询 + 结果分组**（Obsidian 搜索）。外加 GitHub 的限定符写法做对照。

### 1. VS Code Quick Open：一个框，前缀决定模式

![VS Code Quick Open 的 `?` 速查：`>` 命令、`@` 符号、`#` 工作区符号、`%` 文本搜索、`:` 行号](assets/ref-vscode-quick-open.png)

- 输入框在窗口顶部，**没有模式下拉框**：打 `>` 切命令、`@` 切符号、`#` 切工作区符号、
  `%` 直接全文搜索、`:` 跳到行号；
- 打 `?` 就地列出这张速查表——**自解释**，不用去翻文档；
- 结果行把命中的字符**加粗**（图里 `edt` 在 `edt`、`Editors` 里是粗的），右侧标出等价快捷键；
- 也就是说：**搜索框同时承担"发现功能"**，而"多功能"是靠前缀塞进去的，不是靠多个输入框。

对我们的含义：多功能搜索完全可行的形态是"一个框 + 前缀"，但必须配 `?` 这种自解释入口，
否则用户不知道有 `#tag` 这种写法。

### 2. VS Code Search 面板：就地过滤 + 计数摘要 + 按文件分组

![VS Code Search：顶部输入框、`10 results in 3 files` 摘要、按文件分组并高亮命中](assets/ref-vscode-search.png)

- 输入框下方一行摘要：`10 results in 3 files` —— 先给"规模感"，再给细节；
- 结果**按文件分组**，每组右侧是命中数，组内每条是带上下文的一行，命中片段高亮；
- 大小写 / 全词 / 正则做成输入框右侧的小开关（`Aa`、`ab`、`.*`）——**高级能力收在开关里**，
  不占输入框、不要求用户先学会语法。

对我们的含义：结果要带计数；分组是天然的（issue / 动作 / 关系）；高级选项不要塞进输入语法。

### 3. Obsidian 搜索：语法化查询 + 结果分组

![Obsidian 搜索结果：按文件分组、可折叠、每组带命中数、片段里高亮关键词](assets/ref-obsidian-search.png)

- 查询支持限定符：`file:`（文件名）、`path:`、`content:`、`tag:`、`line:`、`section:`、`task:`、
  `match-case:` / `ignore-case:`，还有引号短语、`OR`、`-` 取反、`/regex/`、括号嵌套
  （`task:(call OR email)`）；
- 结果按**文件**分组（可折叠），组名右侧是命中数，展开后是带高亮的片段；
- 第一层体验仍然简单：打几个字就有结果，语法是"会了更省事"的第二层。

对我们的含义：语法可以很强大，但默认体验必须"打字即搜"；语法是给熟练用户的增量。

### 4. 对照：GitHub 的限定符

`is:issue` / `is:open` / `in:title` / `label:bug` / `author:` ——同一套语法贯穿网页搜索、API 与
`gh` 命令；代价是**必须记住词表**（没有 `?` 速查，只能翻文档）。它说明"前缀语法"能表达很复杂的筛选，
但也说明：**只靠语法、不给默认路径**会把大多数用户挡在门外。

### 归纳：四条可以照搬的决定

1. **默认"打字即搜"**，不用先选模式；模式靠前缀或开关，不靠下拉框。
2. **多功能可以塞进一个框**，但要有自解释入口（`?` 速查 / 占位提示里写出几个前缀）。
3. **结果成组 + 每组带计数 + 命中高亮**；空结果给"没找到 X"而不是空白。
4. **高级选项做成开关**（大小写 / 全词 / 正则），不要求用户写对语法。

### 我们的约束（与上面四家的差别）

- **没有全屏覆盖层**：插件活在会话的侧边视图里，结果只能落在这一块区域。
  所以 Quick Open 那种"浮层 + 分组列表"要压缩成"页栏里的一条输入 + 就地过滤"。
- **数据量小**：16–58 条 issue、104–256 个动作都在内存里，不需要索引，线性扫一遍即可（毫秒级）；
  也因此**不需要引入模糊搜索库**。
- **已有三层状态**：筛选（`filters` / `rowFilters`）、焦点、展开项。搜索是**第四条**状态，
  必须定义好它与前三条的叠加关系（尤其"清空搜索后回到原样"）。
- **键盘入口**：宿主有 `ctx.shortcuts` 能力（`kiln-flow-focus-ui` 里查过："热键须走 ctx.shortcuts"），
  所以"按 `/` 或 `Ctrl+F` 进入搜索"在技术上可行，但要不要占用全局快捷键是 hypothesize 的问题。

## 候选交互（留给 hypothesize 比）

| | A 就地过滤 | B 覆盖层（Quick Open 式） | C 混合 |
| --- | --- | --- | --- |
| 输入框位置 | 页栏（与计数/筛选同层） | 浮层，覆盖内容区 | 页栏 + 跨页提示 |
| 结果呈现 | 当前页列表就地收窄 | 独立结果列表（分组） | 同页收窄；跨页命中给"去另一页" |
| 适合规模 | 小数据量（我们） | 大数据量、跨领域 | 两者之间 |
| 与筛选的关系 | 可叠加（AND） | 通常互斥（覆盖层清空筛选） | 可叠加 |
| 键盘 | 输入框内上下选 | 全局快捷键 + 输入 | 同 A |
| 风险 | 侧栏高度被输入框吃掉 | 在窄面板里做浮层很挤 | 两套逻辑容易分叉 |


## 决定：输入框放在第一层页头的中间

用户给了方向：搜索框放在 `.dkf-head`（仓库名 / 刷新那一行）的中间。据此比完三个候选：

| | A 就地过滤（**选**） | B 覆盖层 | C 混合 |
| --- | --- | --- | --- |
| 位置 | 第一层页头中间，`flex:1` | 浮层覆盖内容 | 页头 + 跨页跳转 |
| 为什么不选 | — | 侧栏宽度下浮层比内容区还挤，且要自己管焦点陷阱 | 两套呈现逻辑必然分叉 |
| 结果 | 有输入时内容区换成结果列表 | 同左 | 同左 |
| 与筛选 | 搜索期间忽略筛选（见下） | 互斥 | — |

**"就地过滤"在这里的准确含义**：输入框常驻页头，**一旦有输入，内容区整体换成结果列表**；
不是把当前页的列表收窄（那样搜不到别的页里的东西，和"全局"矛盾）。

### 页头几何

```text
┌──────────────────────────────────────────────────────────────┐
│ dsh-kiln   [ 搜索 issue…            ]   焦点：x ×     刷新  │  34px
└──────────────────────────────────────────────────────────────┘
             └─ flex:1 1 160px，max-width 360px ─┘
```

- 输入框占掉原来的 `.dkf-spacer` 位置（repo 与焦点 chip 之间），高度 22px（与刷新、chip 同档），
  圆角 `--dkf-r`，底色 `--dkf-bg2`，`.5px` 内描边 `--dkf-line`；聚焦时描边换 `--dkf-accent`（2px 内环，与全站一致）；
- 仓库名让位：`flex:0 1 auto; max-width:180px`（超长省略，提示里已有全路径）；
- 焦点 chip 保持 `max-width:320px` 但可被压缩（`flex:0 1 auto`），窄宽度下先缩它，不缩输入框；
- 搜索期间**页签与筛选条仍在原位**（点页签＝清空搜索并离开，见状态表），避免布局跳动。

### 搜什么：这一版只搜 issue

| 方案 | 内容 | 判定 |
| --- | --- | --- |
| M1（**选**） | issue id + issue 标题（ask / 最后动作标题） | 最小要求已满足；结果结构按"分组"设计，天然留给 M2 |
| M2 | 再加动作标题（选中要跳到时间线并展开那条提交） | 需要跨页状态编排（tab + expanded + 滚动定位），价值还没验证 |
| M3 | 前缀语法（`#tag` / `@action`） | 词表只有 6 个动作 + 少量标签，语法的学习成本大于收益 |

M2/M3 的触发条件写在这：**等动作级标签进 `path --json`**（见 `~/kiln` 的 `path-action-tags`）、
或者"在时间线里找某条提交"变成高频动作时，再把结果分组扩到动作。

### 匹配与排序（纯函数，可单测）

- **切词**：按空格切成多个 term，**全部命中才算命中**（AND）；大小写不敏感；中文按原文匹配；
- **字段**：`id` 与 `title` 分开算，命中位置用于高亮；
- **排序**：`id` 前缀命中 > `id` 子串命中 > `title` 命中 > 仅标题末命中；同档按最近动作时间倒序（与 issue 页一致）；
- **不做的**：模糊子序列（`kdsh` 匹配 `kiln-dsh-*`）。数据量小，子序列会带来大量意外命中，
  收益不如"前缀优先"的排序。

### 结果视图

- 顶部一行摘要：`8 条命中 · 仓库共 16 条`（与 VS Code 的 `10 results in 3 files` 同思路：先给规模）；
- 行 = `[id（mono，高亮）] [title（高亮）] [domain chip] [状态 chip]`，右侧 `⏎ 聚焦`；
- 空结果：`没有找到「xxx」` + 一行提示"试试更短的关键词，或按 Esc 清空"；
- 选中一行 → 聚焦该 issue + 切到 issue 页 + 清空输入（回到进入搜索前的视图）。
  与列表里点行的行为一致（`⌖ 聚焦` 走同一条 `focusIssue`）。

### 状态与键盘

| 事件 | 行为 |
| --- | --- |
| 输入 | 立即计算（数据在内存，无需 debounce） |
| `↓` / `↑` | 在结果里移动选中（输入框保持焦点） |
| `⏎` | 确认选中行（IME 组合中不触发，见风险） |
| `Esc` | 第一次清空输入；输入已空时退出搜索（回到原页） |
| 点击页签 / 打开筛选 | 清空输入并离开搜索 |
| 清空输入 | 内容区回到当前页（页签、筛选、展开项原样） |

- **搜索期间忽略筛选与焦点作用域**：搜索是"直接找那一条"，被筛选悄悄过滤掉最糟；
  要收窄可以搜完再筛。摘要里的"仓库共 N 条"就是用来表明这是全仓范围。
- **不做全局快捷键**（v1）：`ctx.shortcuts` 能绑，但与宿主的 `Ctrl+F` / `/` 语义冲突风险大；
  先用"点输入框"这一条路，等有人抱怨再说。

### 风险与边界

- **窄宽度**：页头四件套（repo / 搜索 / 焦点 chip / 刷新）在 400px 以下会挤。
  缓解：repo 与 chip 都可省略号，输入框 `min-width:96px` 保底；实在放不下时输入框换到第二行（后续）。
- **IME**：中文输入时 `Enter` 是"上屏"不是"确认"。必须监听 `compositionstart` / `compositionend`，
  组合期间不处理 `Enter` 与 `↑↓`。
- **输入框抢键**：搜索框获得焦点时，列表的方向键处理器必须让路（现在的 `listKeyDown` 挂在列表上，
  只要不在列表内触发就不会冲突，但 `Esc` 要按"输入框优先"处理）。
- **不落盘**：查询串只在内存里，切页/卸载即清空（不进 `VIEW_STATE`）。
## 落地

1. **纯函数**（`client.js`，可单测）：
   - `splitTerms(query)`：按空白切词、小写、去空；
   - `mergeRanges(ranges)` / `matchRanges(text, terms)`：算出所有命中区间并合并相邻段，供高亮切分；
   - `searchIssues(issues, query)`：AND 匹配（词可分别落在 id 或标题）、四档排序
     （id 前缀 > id 命中 > 标题命中 > 拆开命中）＋同档按最近动作时间。
2. **组件** `SearchResults`：`[id 高亮] [标题高亮] [领域] [状态] [⏎]`；空结果显示
   「没有找到「xxx」」＋“试试更短的关键词，或按 Esc 清空”。
3. **输入框**进第一层页头（替掉原来的弹性空白）：`flex:1 1 160px; min-width:96px; max-width:360px`，
   22px 高、`bg-layer-2` 底、`.5px` 内描边，聚焦换 2px accent 内环；仓库名收到 `max-width:180px`。
4. **状态**：`query` / `searchIndex` 只活在本次挂载（不进 `VIEW_STATE`）；有输入时内容区换成结果，
   页栏右侧显示 `N 条命中 · 仓库共 M 条`，筛选条让位。
5. **键盘**：`↓/↑` 在结果里移动（焦点留在输入框，选中行用 `.dkf-hit-on`）；
   `⏎` 确认（未选中时取第一条）→ 聚焦 + 切到 issue 页 + 清空；`Esc` 先清空、再失焦。
6. **IME**：`compositionstart/end` 期间不处理 `⏎` 与方向键——中文输入时回车是“上屏”。

### 与 hypothesize 的偏差（小）

- 搜索期间**筛选条隐藏**（原稿写"仍在原位"）：结果已整块换掉，留着筛选条会让人以为筛选仍作用于结果；
  点页签仍是"离开搜索"，这条没变。
- 摘要文案用 `N 条命中 · 仓库共 M 条`（原稿 `N 条命中 · 仓库共 16 条` 的示例值换成实际总数）。

### 验证

- `npm test --prefix plugin` → 43 个宿主用例 + 40 个渲染用例全过。新增四条：
  - 单测：切词/大小写、`matchRanges` 的相邻合并、AND、排序（id 命中在前）、空查询；
  - 渲染：输入框在 `.dkf-head` 内（不是另起一行）、有输入时换成结果列表且页栏写「1 条命中 · 仓库共 3 条」、
    命中片段有 `.dkf-hl`、没命中时文案含「没有找到「zzz」」与 Esc 提示。
- 静态：CSS 仍无裸 hex；`.dkf-spacer` 已删（它被输入框取代）。

### 已知边界

- **没有全局快捷键**：要搜就点输入框（`ctx.shortcuts` 能绑，但与宿主 `Ctrl+F` / `/` 冲突风险大）。
- **只搜 issue 的 id 与标题**：动作、标签、领域都还没进搜索（M2/M3 的触发条件写在上面）。
- **不做模糊子序列**：`kdsh` 不会命中 `kiln-dsh-*`。数据量小，收益不如可预测的前缀排序。
- **窄宽度**：页头四件套在 400px 以下会挤；缓解是 repo/chip 省略号 + 输入框 96px 保底，
  再窄就得把输入框挪到第二行（未做）。
- **没实拍**：沙箱起不了 Chromium，需重启桌面应用肉眼验收（重点看：输入是否即时、焦点行高亮、
  窄侧栏下四件套是否挤）。
### 应用 2：页头居中 + 选中行统一

1. **真居中**：`.dkf-head` 从 flex 换成三栏网格
   `minmax(0,1fr) minmax(96px,min(360px,40%)) minmax(0,1fr)`，焦点 chip 与刷新包进 `.dkf-head-actions`（右对齐）。
   之前是 flex，"居中"其实是**剩下空白的居中**：左边只有仓库名、右边有 chip + 刷新，重心偏左；
   现在左右两栏等宽，中间那栏才是页头的几何中心。窄宽度下中间栏按 `40%` 收，两侧仍等宽。
2. **选中行（改过两次，最终版）**：先把 `.dkf-hit-on` 和 issue 页焦点行合并、加左侧 2px accent 强调条；
   试下来 accent 条太重、和页面其它"选中"不是一个语汇，于是**又退回**：
   - `.dkf-hit-on` 只用**鼠标经过那层底色**（`background-image:var(--dkf-hover-layer)`），
     与 issue 行听起来看到的是同一套观感；
   - `.dkf-focus` 回到原来的 `bg-layer-2` + 0.5px 描边，**不加**任何强调条。
   为什么先做后撤：浅色主题下 `bg-layer-2` 与 `layer-1` 同为 `#fff`，光靠它确实看不见反馈；
   但"看不见"的正确解法是让选中行**用 hover 那层**（有主题自适应、本来就存在），
   而不是新造一条 accent 语汇。教训记在这：缺可见性时先找现成的层，别急着加新颜色。
3. **hover 底色收成一个变量**：新增 `--dkf-hover-layer`（`linear-gradient(hover, hover)`），
   鼠标经过规则与 `.dkf-hit-on` 都引用它——"当前选中"和"鼠标经过"从此是同一层，只有一处定义。

测试补两条：页头必须是"左右等宽三栏"（否则退回 flex 就会再偏），
以及 `.dkf-hit-on` 与 `.dkf-focus` 必须同一条规则且带 2px accent 强调条。现在 45 + 40 全过。
### 应用 3：为什么搜「搜索」没有结果（检索面扩到全部动作标题）

用户在本仓搜「搜索」得到空结果，查了一下——**规则没错，检索面太窄**。

实测（`kiln graph --json` ＋ `kiln path kiln-search --json`）：

- 18 条 issue 的**节点标题**里，含「搜索」的：**0 条**；
- `kiln-search` 的 6 条动作标题里，含「搜索」的有 3 条（collect「三种搜索形态…」、
  apply「落地：页头中间常驻搜索框…」、apply「页头改三栏…」）——**但最后一条是「撤掉 accent 强调条…」**，
  不含「搜索」。

原来的检索面只有 `id + issue.title`，而 `issue.title` 取自 graph 节点 = **最后一个动作的标题**。
于是"我记得这条 issue 讨论过搜索"这种最自然的记忆方式恰好落在检索面之外。

改法（数据本来就在快照里，不需要动宿主）：

- **检索面** = `id` ＋ 当前标题 ＋ **该 issue 所有动作的标题**（`issue.actions[].title`，`path --json` 早就给了）；
- **排序**：`id` 前缀 > `id` 命中 > 当前标题命中 > **历史动作标题命中** > 词拆散在多个字段；
- **展示**：命中历史标题时，行里显示**命中的那条标题**（否则高亮看不见），并挂一个「历史标题」chip
  （tooltip：命中的是这条 issue 早期动作的标题）。

加上这一条之后，本仓搜「搜索」能命中 `kiln-search`（展示「落地：页头中间常驻搜索框…」+ 历史标题 chip）。

测试补了两条：单测（只出现在早期动作标题里的词能命中、展示命中的那条、`history` 标记、高亮区间落在展示标题上），
渲染（三个 issue 的第 1 条动作标题都命中「动作 1」时，行里带「历史标题」chip）。现在 45 + 41 全过。
### 应用 4：结果分两行，命中动作就直接落到那条动作

用户指出两点：**"历史标题"该叫"历史动作"**；以及**要能分清搜到的是 issue 还是动作**——
理由很实在：issue 只有一句短名（id），而每条 issue 有一串动作，动作标题信息量大、最容易记住关键词。
所以结果列表要回答两个问题：**哪个 issue**、**凭什么命中**。

结果行改成两行：

```text
kiln-search   [integration] [已完成]                         ⏎
[apply] 落地：页头中间常驻搜索框…                    历史动作 4/6
```

- **第一行 = 哪个 issue**：id（命中就高亮）+ 领域/状态；
- **第二行 = 凭什么命中**：
  - 命中动作标题 → 动作名小标签（用的是动作自己的颜色，`--dkf-row-color`）+ 命中的那条标题 + 右侧
    `历史动作 n/m`（n = 第几条，m = 这条 issue 共几条动作）；
  - 命中 issue 名 / 当前标题 → 第二行只是"这条 issue 现在在干什么"（当前标题，弱化成 secondary，不做高亮主角）。
- 文案从「历史标题」改成「历史动作」，并补上位置 `n/m`——它同时告诉你这条动作在 `kiln path` 里的序号。

**交互也跟着分流**（`pickSearch`）：

| 命中来自 | 回车之后 |
| --- | --- |
| issue 名 / 当前标题 | 聚焦该 issue → issue 页（看结构） |
| 某条动作的标题 | 聚焦该 issue → **时间线** → 展开那条动作 → 滚到它 |

理由：搜到的是"那句话"，就该把人送到那句话旁边。实现上是给动作行加了 `data-key`（= 提交 sha），
`pickSearch` 设好 `expanded` 后用 `scrollIntoView({block:'center'})` 滚过去；
展开/滚动的目标用的是 `actionKey(row)` 的同一套键，不会指错行。

测试更新：单测断言命中动作时带 `action/ordinal/total`；渲染断言两行结构、`历史动作 1/2`、
动作名标签，以及"命中 issue 名时第二行是弱化标题、没有动作标记"。现在 45 + 42 全过。
### 应用 5：结果行带动作色条 + hover 预览

两条都是"让人一眼看懂这条 issue"的补强：

1. **第一行最前面加动作色条**：直接复用 issue 页那一套 `strip(issue.actions)`——最多 12 个色块，
   颜色 = 动作类型，最后一格加环标出"当前动作"。于是搜索结果和 issue 列表长得一样：
   先看色条了解**这条 issue 被推过几次、节奏如何**，再看 id 与命中行。
2. **hover 预览**：走已有的 `data-hint` 委托机制（260ms、`.dkf-tip` 那套样式），三行：
   - `id · 状态 · 领域`
   - 命中动作时 `命中：apply · 第 4/6 条 · 2026-10-26`；只命中 issue 名时 `当前标题 · 日期`
   - **完整标题**（行里被省略号截断的那条）
   预览的用处正是补全被截断的内容，并说清"这条结果是怎么命中的"。

一个有意保留的层级：色条自己本来就带每格的提示（`序 · 动作 · 日期 · 标题`），
指针落到具体色块时显示的是那一格的细信息（`closest('[data-hint]')` 取最近的），而不是整行的预览。

测试补了两条渲染断言：结果行里有 `.dkf-strip` 与 `.dkf-block`、`data-hint` 里含「命中：」「第 1/2 条」；
以及只命中 issue 名时预览是「当前标题」+ 该 issue 的当前标题。现在 45 + 44 全过。

### 应用 6：色条里突出的是"命中的那条"，不是"最后那条"

色条原来固定标最后一格（= 当前动作）。但搜索结果已经告诉你"命中第 4/6 条"，色条却把第 6 条加高，
两个信号打架。`strip(actions, highlightId)` 现在多收一个参数：

- 不传（issue 页的行）→ 仍然标最后一格（当前动作），行为不变；
- 传了（搜索结果，值是命中的提交 sha）→ 标**那一格**；
- 命中落在最近 12 格窗口之外时，窗口挪到包含它的位置，末尾用 `+k` 表示"还有 k 条更新的动作没画下"
  （前缀 `+k` 仍是"更早的没画下"；两个方向都能读出来）。

测试补一条：命中第 1 条动作时，被加高的必须是第 1 格而不是最后一格。现在 45 + 45 全过。

## 收集：`kiln list --search` 与插件搜索的差别（2026-10-28）

上游 v0.2.0 新增了 `kiln list --search`（`cb5730a`、`57d7151`），解的是同一个问题：按记忆里的
字符串找回 issue。两边**匹配语义几乎同构**，差别集中在数据范围、排序、提示与成本。

### 一致的（可以当同一个契约）

| 维度 | 两边一致 |
| --- | --- |
| 切词 | 空白分词、词间 AND |
| 匹配 | 字面量子串、大小写不敏感；不支持正则、引号短语、OR、模糊 |
| 检索面 | issue id + 当前标题 + **所有**动作的 subject/title；不搜正文、refs、tags、domain、关系名 |
| 字段边界 | 用 NUL 分隔再 join，词不跨字段 |
| 命中动作 | 当前标题凑不齐所有词、且某一条动作能凑齐时才指出是哪条；词分散在多条动作里时两边都不指 |
| 结果粒度 | 一行一条 issue，不是一行一条动作 |
| 零结果 | 有效答案（kiln exit 0 + stderr 提示；插件显示空态） |

本仓实测（20 条 / 128 个动作），7 个查询的**命中集合逐条相同**：
`graph` 8、`Quick Open` 1、`色条 选中` 1、`SEARCH` 1、`搜索` 2、`dsh` 2、`zzz` 0。

### 不一致的

| 维度 | 插件内搜索（`client.js`） | `kiln list --search` |
| --- | --- | --- |
| 范围 | 内存快照，上限 80 条；按 graph 的 **id 字典序**取前 80，后面的 issue 搜不到 | 每次读全仓，无上限 |
| 新鲜度 | 快照；HEAD 动过要刷新 | 每次调用读当前历史 |
| 排序 | 相关度：id 首词前缀 > id 命中 > 标题命中 > 单条动作命中 > 词分散；同档按最近动作 | 无相关度，固定 id 字典序 |
| 命中提示 | 动作名 + `第 n/m 条` + 色条标那一格 + hover 预览 | 文本尾部 `← subject`；JSON `hit` 带 ordinal/action/commit/subject，仅当行本身解释不了时出现 |
| 高亮 | 自己算区间，id/标题逐段高亮 | 不给区间，没有高亮 |
| 主标题 | 命中动作时换成那条动作的标题 | 始终显示当前标题，命中动作放 `←` 后 |
| 交互 | 输入即搜、↑↓/⏎/Esc、落到时间线展开那条 | 一次命令一次结果，无键盘导航 |
| 与筛选 | 有意忽略筛选与焦点 | 与 `--domain/--tag/--action/--status` AND 叠加 |
| 长标题 | 快照把标题截到 200 字符（`truncate`），截断后的词搜不到 | 用完整 subject |
| 成本 | 纯内存，输入即算 | 起进程读 git：本机 103–105 ms（7 次，`--json`） |
| 空查询 | 清空输入退出搜索 | `--search ""` 拒绝，exit 2 |

### 一处语义差异（不能当同一份实现）

两边都用「当前标题能否解释命中」来抑制动作提示，但：

- 插件只检查 `titleHit`（id 命中不抑制）；
- kiln 检查 `id + title`。

本仓查询 `dsh` 正好撞上：`kiln-dsh-integration` 的 id 命中，而第 1 条动作标题也含 "DSH"。
插件的结果行因此显示 `action=ask 第 1/10 条` 并把标题换成那条动作；kiln 不显示 `←`，
仍显示当前标题。命中集合相同，但"为什么命中"的指认不同。

### 对插件的含义

1. **不能直接把搜索换成 `list --search`**：输入即搜要 0 进程、要高亮、要相关度排序、
   要色条与「落到第 n 条动作」；CLI 一次 100 ms 且三样都不给，每键一次子进程也和
   「只读快照 + 客户端过滤」的形态冲突。
2. **它补的恰好是插件的短板**：80 条上限之外、以及快照未刷新的新提交。若要补，合理形态是
   宿主路由在「快照被截断」时用 `list --search` 兜底，而不是把搜索框改成 CLI 调用；那会引入
   第二个数据源与第二套排序/提示语义，需另开 issue 权衡。
3. **可以当回归对照**：同一查询两边命中集合应相同（排序与提示可不同），上面 7 个查询是现成样本。

## 假设：搜索的数据层单源（2026-10-28）

目标不是让 CLI 也能高亮，而是让**同一个查询在同一份仓库上，两边给出同一组行、同一个命中动作、
同一个顺序**。高亮、键位、布局、CLI 文本这些呈现允许不同；插件接入 kiln 的搜索时只做渲染，
不再维护第二套匹配规则。

### 先把「数据层」拆开

| 层 | 内容 | 能否不一致 |
| --- | --- | --- |
| 范围 | 全仓 / 快照前 80 条 | 不能（partial 必须明说） |
| 匹配 | 字段、分词、AND、字面量、大小写、NUL 字段边界 | 不能 |
| 解释 | 命中的是哪条动作（`hit`），什么时候不给 | 不能 |
| 排序 | `rank` 分档 + 同档 tie-break | 不能 |
| 文本 | 检索用的标题是否截断 | 不能 |
| 筛选 | 与 domain/tag/action/status 叠加 | 产品决定（这轮保持插件「忽略筛选」） |
| 呈现 | 高亮、色条、布局、键盘 | 可以 |
| 新鲜度 | 快照 vs 当前 HEAD | 可以（但要能解释） |

### 现状里真正会分叉的四处

collect 已经证明匹配集合一致；下面四处才是数据层的分歧：

1. **hit 规则**：插件只在「当前标题含全部词」时抑制动作提示（`client.js:1017-1022`），
   kiln 在「id + 标题含全部词」时抑制。查询 `dsh` 就能看出差别。
2. **排序**：插件按 `rank`（`client.js:1023`）再按最近动作（`:849`）；kiln 固定 id 字典序。
3. **范围**：插件是快照前 80 条（`flow.js:17`、`:199`），kiln 是全仓。
4. **文本**：插件把标题截到 200 字符（`flow.js:30`、`:137`、`:209`），kiln 用完整 subject。

### 三个选项

| | A. 契约单源 + 快路径 | B. 单一实现（插件调 kiln） | C. 双路径（内存 + 全仓） |
| --- | --- | --- | --- |
| 行为一致 | 靠 parity 测试锁 | 天然 | 两条路径都要锁 |
| 输入延迟 | 0.0414ms（本仓 1000 次实测） | 103–112ms/次 + 防抖 | 0ms / 100ms 分场景 |
| 全仓 | 快照外要另调 CLI | 天然 | 是 |
| 筛选叠加 | 插件仍忽略 | 路由可选传 | 分场景 |
| 代码量 | 中（改插件规则 + 上游 rank） | 高（上游 rank/hit + 路由 + 防抖 + 快照外聚焦） | 最高 |
| 主要风险 | 两实现漂移；仍算「两种算法」 | 延迟与大仓；快照外行渲染 | 两套语义温床 |

#### A 的具体代价

- kiln 补 `rank` 与排序；插件按同一契约改内存匹配器，并加 parity 测试；
- 保住输入即搜与快照架构，但代码仍是两套——正是这次想避免的「一个搜索，两种算法」；
- 快照超过 80 条时仍要调 kiln 才能全仓，等于 A 里已经包含 B 的一条支路。

#### B 的具体代价

- 宿主加 `GET /kiln/search?cwd=&q=` → `kiln list --search <q> --json`；
- 客户端删掉 `searchIssues` 的匹配职责，保留 `matchRanges` 做高亮，防抖 120ms + 取消旧请求；
- 每次查询 103ms（本仓）/112ms（`~/kiln`），端到端约 220–240ms；大仓是 O(全史)（100k 1–2s）；
- 快照外的命中要先把焦点 issue 纳入 Flow（现在 `maxIssues` 之外不可见），否则搜到了打不开；
- 插件从「输入即搜」变成「停 120ms 后搜」，这是唯一要接受的交互退化。

### 推荐：B，带延迟门槛

选 B，理由按优先级：

1. 目标就是一套搜索。A 只能保证行为一致，代码仍是两套；C 更糟。
2. 「与筛选」和「全仓」是 kiln 这边明确更好的两件事，B 直接拿到；A 还得在插件里补全仓。
3. 插件接入变成纯渲染：行、`rank`、`hit` 都由 kiln 给，高亮用查询串现算（呈现，不是匹配）。

门槛与回退：

- **p50 端到端 ≤ 250ms**（本仓 / `~/kiln` 各测一轮）。超过就退回 A 的快路径，
  但契约不变——A 的匹配器必须按同一 `rank`/`hit` 实现，否则不算回退。
- 100k issue 的仓不承诺：那是插件 80 条设计的边界之外，搜索显示「仓库过大，未全量」即可。
- 如果「输入即搜」不能被防抖替代，那就不选 B；这一点必须显式接受，不能事后抱怨。

### 契约草案

| 项 | 规则 | 现状 |
| --- | --- | --- |
| 查询 | 空白分词、小写、词间 AND、字面量子串；空查询不执行 | 两边一致 |
| 字段 | issue id + 当前标题 + 每条动作 subject；NUL 分隔；**不截断** | 插件要取消 200 字符截断 |
| hit | id+title 已含全部词 → 无；否则按时间取第一条含全部词的动作 → `{ordinal, action, commit, subject, total, date}`；没有 → 无 | 插件改成 id+title；kiln 补 `total`/`date` |
| 排序 | `rank`：0=id 以首词开头，1=id 含全部词，2=标题含全部词，3=单条动作含全部词，4=词分散；同档按最近动作日期降序、id 升序 | kiln 补 `rank` 与排序；插件照用 |
| 范围 | 全仓；JSON 回 `count` 与 `search`；与 domain/tag/action/status AND | kiln 已有；插件调它 |
| 空/错 | 0 结果 exit 0 + stderr；空查询 exit 2；stdout 只有一份 JSON | 一致 |
| 呈现 | 高亮区间由前端从查询与展示文本现算；CLI 不承诺 | 保持 |

### 下一步（不在本动作里做）

上游（`~/kiln`，另开 issue）：

- `list --search --json` 每行加 `rank`，搜索时按 rank 排序（文本视图同步）；
- `hit` 加 `total`（动作总数）与 `date`，让插件不回查 `path` 就能显示 `n/m` 与日期；
- 文档写清 rank 与 tie-break，补契约测试。

插件（本仓）：

- 宿主加 `GET /kiln/search?cwd=&q=`，只读调用 `kiln list --search --json`，复用现有的仓库校验、
  超时与 `kiln-error` 映射；
- 客户端删匹配职责、留 `matchRanges`；防抖 120ms + 取消旧请求；空查询不发；
- 命中行用 kiln 的 `hit`；色条/展开仍用快照里的 actions，快照外的 issue 只渲染简版行；
- `flow.js` 对搜索文本取消 200 字符截断（显示层仍可省略号）；
- 快照外命中：`readFlow` 把焦点 issue 纳入 `maxIssues` 之外（或按需取它的 `path`），否则搜到打不开；
- parity 测试：同一仓一组查询，比对 kiln 与插件的 ids/rank/hit（kiln 不在 PATH 时跳过）。

### 不做 / 留待

- 筛选叠加：插件当前有意忽略筛选；契约支持 filters，但第一阶段不传，保持交互不变。要不要改是另一个产品决定。
- CLI 高亮：不做，高亮是渲染层的事。
- 快捷键与结果布局：不动。
- 若 B 的门槛没过而回退 A：parity 测试必须进 CI，否则 A 很快又会长出第二套行为。

## 测试：把 B 方案的延迟挂到插件上（2026-10-28）

目的：不改宿主、不接 `list --search`，先用浏览器半的定时器模拟 B 的时序，看「输入即搜」变成
「停 120ms + 100ms 查询」后还能不能接受。

怎么做（只动浏览器半，测试除外）：

- `SEARCH_DEBOUNCE_MS = 120`、`SEARCH_SIMULATED_MS = 100`（100ms 取本机 `list --search`
  103–112ms 的下沿）；
- 输入框照旧即时更新；停 120ms 后进入「搜索中…」，再等 100ms 出结果；
- 页栏等待时显示「搜索中…」，完成后显示 `N 条命中 · 220ms（模拟）· 仓库共 X 条`；
- 结果出来前不响应 ↑↓/⏎（和真实异步一致）；Esc 仍即时清空；
- 控制台可覆盖：`window.__DSH_KILN_SEARCH_DELAY__ = { debounce: 0, latency: 0 }`，再输入即生效，
  便于和即时搜索对比；
- `__DSH_KILN_TEST__` 环境两段都置 0，58 + 45 用例仍同步通过。

客观数字：

- 内存匹配 1000 次 41.4ms（0.0414ms/次，20 条 issue）；
- `kiln list --search`：本仓 103–105ms、`~/kiln` 111–115ms（各 7 / 5 次）；
- 模拟端到端 = 120 + 100 = 220ms（不含宿主路由与 JSON 解析，真实 B 会再多几毫秒）。

真机要看的：

1. 输入是否仍然跟手（字符不回退、不卡）；
2. 220ms 左右的结果等待是否可接受；
3. 连续输入时是否只出最后一轮结果（旧请求不覆盖新结果）。

这一步不验证数据层（rank / hit / 全仓），只验证时序。若时序不可接受，结论应回到
A（契约 + 快路径），不要硬上 B。

### 结果（2026-10-28 真机）

- 220ms 的等待**可以接受**；输入跟手，连续输入只出最后一轮结果。
- 模拟装置已撤：搜索恢复同步，57 + 45 用例全过；B 的 p50 门槛通过。
- 后续：按 hypothesize 的「下一步」，先在 `~/kiln` 补 `rank` / `hit.total` / `hit.date`
  与排序，再回本仓做宿主路由 + 客户端改造。在那之前插件仍是即时搜索，不留半成品延迟。

## 收集：多界面工具怎么处理搜索（2026-10-28）

挑的都是「同一份数据，既有 CLI 又有 TUI / Web / GUI」的工具，看三件事：查询与匹配归谁、
UI 加什么、两边靠什么防止漂移。

### 1. fzf：一个匹配器，两种入口

- 交互 TUI 与非交互 `--filter` 是同一个二进制、同一套匹配 flags（`--exact` / `--nth` /
  `--no-sort`）；`--filter` 不开 finder，`--no-sort` 时退化成 fuzzy grep
  （[fzf(1)](https://manpages.ubuntu.com/manpages/resolute/man1/fzf.1.html)）。
- 差异只在「有没有交互循环」：TUI 加预览/键位/高亮，CLI 输出纯结果。
- 对 kiln：最理想的「一套实现」形态；但插件是 JS、kiln 是 Go，共享不了代码。

### 2. gh + GitHub Web：一套查询语言，两个前端

- `gh search issues` 用 GitHub search syntax，可 `--json` / `--limit` / `--sort best-match` /
  `--search-type lexical|semantic|hybrid`；`--web` 把同一查询交给浏览器
  （[gh search issues](https://cli.github.com/manual/gh_search_issues)）。
- Web 用同一套 qualifiers；CLI 是搜索 API 的薄客户端。差异在前端：CLI 有 limit/JSON/字段，
  Web 有 facets/高亮/分页。文档也写明 advanced boolean syntax 不支持 `--web`。
- 结论：**查询语言 + 搜索后端是契约**；前端只决定结果怎么切、怎么显示。`--web` 是廉价的跨端复用。

### 3. Sourcegraph `src` + Web：唯一后端，两个客户端

- `src search` 连实例、跑同一套 query syntax（`r:` 这类过滤器就是 Web 那套），`-json` 给程序读
  （[src quickstart](https://sourcegraph.com/docs/cli/quickstart)、
  [src-cli](https://pkg.go.dev/github.com/sourcegraph/src-cli)、
  [query syntax](https://sourcegraph.com/docs/code-search/queries)）。
- Web 用同一套语法，额外做高亮、facets、结果分组；CLI 文本只标命中行。
- 结论：一致性靠「唯一后端」；UI 加的是呈现。代价是必须有服务/网络，离线不可用。

### 4. lazygit：filter 与 search 是两种 UI 动作

- `/` 在多数视图是 filter（内容收窄）；在 commits 视图**故意**是 search（高亮 + n/N，不改变集合），
  因为要看命中前后提交；菜单是 type-to-filter，不用 `/`
  （[Searching.md](https://github.com/jesseduffield/lazygit/blob/master/docs/Searching.md)）。
- 结论：同一查询串可以有两种呈现；数据层只给「匹配/命中」，UI 决定「替换列表还是高亮定位」。

### 5. VS Code：一个 GUI 里两套引擎（反例）

- 工作区搜索用 ripgrep；已打开文件用编辑器的 JS regex；ignore/exclude 共用，但 regex 引擎
  （Rust/PCRE2 vs JS）与换行处理会不一致，官方 wiki 明确列出「开着的文件结果不同」的成因
  （[Search Issues](https://github.com/microsoft/vscode/wiki/Search-Issues)）。
- 结论：两套引擎能活，但差异会以「同一查询、不同结果」暴露；要么单引擎，要么用边界测试兜住。

### 6. gh-dash：TUI 只做服务端查询的壳

- sections 是 GitHub filters，搜索是 TUI 的一个 keybinding；数据来自 GitHub API，UI 只做
  布局/预览/键位/定时刷新（[gh-dash](https://pkg.go.dev/github.com/dlvhdr/gh-dash/v4@v4.3.0)）。
- 结论：TUI 不实现搜索，只实现「查询构造 + 结果呈现」，一致性天然。

### 四种架构

| 架构 | 例子 | 一致性 | 代价 |
| --- | --- | --- | --- |
| 单引擎多入口 | fzf | 天然 | 跨进程 / 性能 |
| 单后端多前端 | gh、src、gh-dash | 语义天然 | 网络、延迟、离线 |
| 单视图双动作 | lazygit | 查询同、呈现异 | 要明确 filter / search |
| 双引擎单 UI | VS Code | 靠契约 / 测试 | 漂移风险 |

### 对 dsh-kiln 的直接含义

1. **语义归数据层，呈现归 UI**：匹配、hit、排序是数据层；filter vs search、高亮、键位是 UI。
   lazygit 是最接近的先例。
2. **要一套实现，gh/src 模式比 fzf 模式现实**：CLI 是唯一后端，UI 调它；Go/JS 共享不了代码，
   只能共享契约。代价是 100ms + 防抖（已实测可接受）。
3. **要两套实现，就抄 VS Code 的反面**：VS Code 把「两套引擎」的差异写进了文档；我们必须用
   共享用例 / parity 测试锁住 ids/rank/hit，否则不要声称一致。
4. **高亮大多在客户端**：fzf 的 matched chars、Sourcegraph 的 match 信息、VS Code 的 editor
   高亮都在前端；数据层给足文本与命中即可，不必把高亮塞进 CLI。
5. **排序不要两边各排**：gh 的 best-match、Sourcegraph 的服务端顺序是唯一顺序；UI 私自重排
   就会和 CLI 分叉。插件的 rank 若要保留，就把它变成 kiln 输出的 `rank`。
6. **filter 与 search 要按视图选**：lazygit 的 commits 视图选 search 是为了保留上下文。插件现在
   是「整块换成结果页」的第三种形态——它牺牲了原列表的上下文，换来全仓结果；这是产品决定，
   不是数据层的一部分。
7. **`--web` 式交接值得抄**：kiln 保证查询串/结果字段一致，插件用自己的渲染；比共享渲染便宜。

### 来源

- fzf(1)：<https://manpages.ubuntu.com/manpages/resolute/man1/fzf.1.html>
- gh search issues：<https://cli.github.com/manual/gh_search_issues>
- GitHub 搜索语法：<https://docs.github.com/en/search-github/getting-started-with-searching-on-github/understanding-the-search-syntax>
- Sourcegraph src quickstart：<https://sourcegraph.com/docs/cli/quickstart>
- Sourcegraph query syntax：<https://sourcegraph.com/docs/code-search/queries>
- Sourcegraph src-cli：<https://pkg.go.dev/github.com/sourcegraph/src-cli>
- lazygit Searching：<https://github.com/jesseduffield/lazygit/blob/master/docs/Searching.md>
- VS Code Search Issues wiki：<https://github.com/microsoft/vscode/wiki/Search-Issues>
- gh-dash：<https://pkg.go.dev/github.com/dlvhdr/gh-dash/v4@v4.3.0>

## 验证：新二进制是否满足 search-result-contract（2026-10-28）

被验对象：`C:\Users\jacki\kiln\kiln.exe`，`v0.2.1-0.20261028065156-2b02f3d33cd7`，构建 2026-10-28 14:55；
对应 kiln issue `search-result-contract` 的 `92b37ad`（实现）+ `2b02f3d`（文档）。
系统 PATH 上的 `kiln` 仍是 v0.2.0，下面的命令都显式用新二进制。

### 结论

**数据层契约满足**：rank 0–4、排序、tie-break、hit.total/date、文本/JSON 同序、非搜索输出不变、filters 叠加、
空结果/空查询、go test/vet/gofmt 全部通过。插件侧只剩两处按计划的主动对齐（hit 规则、时间比较），
不需要 kiln 再改。唯一没在真仓覆盖的是「>200 字符的 subject」——本仓最长 184，kiln 本身不截断；
建议补一条单测，但不阻塞。

### 逐项核对

| 要求 / 验收 | 结果 | 证据 |
| --- | --- | --- |
| `rank` 0–4 都在真仓出现 | ✓ | `path json` → `path-action-tags#0`；`list scaling` → `issue-list-scaling#1`；`排序` → `search-result-contract#2`；`grep fzf` → `issue-list-scaling#3`；`search grep` → `issue-list-scaling#4` |
| rank 只在 `--search` 出现，普通 list 仍按 id | ✓ | `list --json` 无 `rank` 键；与 v0.2.0 逐字节相同（见下） |
| rank 0 只认首词前缀（Q1=A） | ✓ | `path json` 把 `path-action-tags` 排 0；`kiln v0.2.0` 在插件与 kiln 两边都把 `kiln-search` / `kiln-v020-adapter` 排 0 |
| 同 rank tie-break：末条动作时间降序、再 id | ✓ | `path json` 的 rank 3：`perf-audit` 10-27 23:16 > `json-commit-hash` 20:51 > `config-home` 10-15；rank 4：`issue-list-scaling` 21:56 > `cli-consistency` 21:51；单测另有同日期按 id 的用例 |
| `hit.total` / `hit.date` | ✓ | `排序` 的 `issue-list-scaling`：ordinal=6、total=10、date=`2026-10-27T17:40:25+08:00`，与 `path --json` 第 6 条动作的 commit/date/subject 逐项相等 |
| hit 抑制：id+标题能解释 / 词分散 → 无 hit | ✓ | 查询 `search-result-contract` → hit=null；`search grep` → hit=null；`grep fzf` → 有 hit |
| 文本与 JSON 同序 | ✓ | `path json`、`排序`、`worktree json`、`tag json` 四个查询逐条相同；与旧文本的“行集合”也相同（只是顺序变了） |
| 非搜索输出逐字节不变 | ✓ | v0.2.0 vs 新二进制：`list --json` 17,206 B、`list` 3,690 B、`status --json` 15,301 B、`status` 2,579 B、`graph --json` 26,781 B 全部 `identical=True`；`path <id> --json` 与 `path --all --json` 也相同 |
| filters 叠加且排序保持 | ✓ | `path json` 全量 7 条 → `--action=collect` 6 条、`--domain=cli` 6 条；过滤后仍是 rank 序；`filter` 回显 `action/search` |
| 空结果 / 空查询 | ✓ | `--search zzz --json` → exit 0、`count:0`、stderr 一行；`--search ""` → exit 2 |
| 文档同步 | ✓ | README:109 写了 rank 0–4 与 tie-break；`machine-readable-output.md:146/147/154` 写了 `rank`、`hit.total/date` 与“只有搜索改顺序” |
| gofmt / vet / test | ✓ | `gofmt -l` 空；`go vet ./...` exit 0；`go test ./...` 全过；`TestListSearch*` / `TestListJSONWithoutSearch*` / `TestListTextWithoutSearch*` 13 条全 PASS |
| >200 字符 subject | ⚠ | 本仓最长 184；kiln 无截断逻辑，但没找到单独的 >200 用例。建议补一条单测 |
| 零值日期 | ✓（单测） | `TestListSearchSortsMissingDatesLast` 通过；真仓无零值数据 |
| 快照 >80 条时的插件范围 | — | 未验；dsh-kiln 当前 20 条，插件上限 80，两边同范围 |

### 与插件现有搜索的 parity

在同一份 dsh-kiln 快照上跑了 9 个查询，把插件的内存搜索与 `kiln list --search --json` 对比：

- **ids 与 rank 全部逐条相同**：`graph`、`Quick Open`、`色条 选中`、`SEARCH`、`搜索`、`dsh`、`zzz`、
  `kiln v0.2.0`、`path json`；
- **hit 只在两处不同**：`SEARCH`、`dsh`——插件仍按“标题能解释就抑制”，而 kiln 按“id+标题能解释”抑制。
  这正是插件待改的那一处，不是 kiln 的问题；
- 排序 tie-break 两边当前结果一致；插件按 ISO 字符串比较，跨时区会差，插件侧改成按时间即可。

### 插件侧待做

1. 把 `hit` 抑制规则改成 `id + 标题`（与 kiln 一致），删掉“只看标题”的旧判断；
2. `byRecency` / 搜索 tie-break 改成按时间比较；
3. 接宿主 `list --search` 路由与渲染（B 方案），保留高亮/键盘/色条；
4. 二进制解析：PATH 上的 `kiln` 还是 v0.2.0，集成时用 `DSH_KILN_BIN=C:\Users\jacki\kiln\kiln.exe`
   或更新 PATH；新二进制是 `v0.2.1-0.20261028...` 伪版本，若文档写版本下限，等正式 tag。

### 复现命令

```powershell
$k='C:\Users\jacki\kiln\kiln.exe'
& $k list --search '排序' --json
& $k list --search 'path json'
& $k list --json                      # 与 C:\Users\jacki\go\bin\kiln.exe 的 list --json 对拍
go test ./... ; go vet ./... ; gofmt -l .
```

插件 parity 的临时脚本只读本仓与二进制，验证完已删除，不落盘。

## 落地（2026-10-28）

插件从「快照内内存搜索」改成「宿主调 kiln 搜索、客户端只渲染」：

- `plugin/lib/flow.js:306` `readSearch()`：一次 `kiln list --search=<q> --json`；
  `searchDocumentError()`（:283）校验 `rank` / `hit.total` / `hit.date`，旧版直接 `kiln-too-old`，
  不自己补排序。
- `plugin/lib/index.js:93` 新增只读路由 `GET /kiln/search?cwd=&q=`；与 flow 共用信任栅栏、超时与
  `kiln-error` 映射；不缓存，每次读当前历史。
- `plugin/lib/client.js:1019` `mapSearchRows()`：把 kiln 行映射成视图行（rank/hit/title/idRanges），
  快照里有的 issue 带上 actions；`searchIssues` 删除。输入停 120ms（:29）后 fetch（:2073），
  新查询 abort 旧请求；等待显示「搜索中…」，失败显示原因；页栏 `N 条命中 · Xms · 仓库共 M 条`。
- `byRecency`（:853）改成按时间比较（跨时区与缺失日期都正确）。
- 测试：`run.mjs` 改测 `mapSearchRows` / `searchDocumentError`；`render.mjs` 用 fixture 喂搜索结果。
  `node plugin/test/run.mjs` 58、`render.mjs` 45 全过。
- 版本：插件 0.3.0；Flow 取数需 kiln v0.2.0+，搜索需 v0.2.1+；README / AGENTS 同步。

### 验证

- 新二进制 `v0.2.1-0.20261028065156-2b02f3d33cd7`：`GET /kiln/search?cwd=…&q=dsh` 实测 200、
  `count=2`，两行 `rank=1/3`；`readSearch` 对旧 v0.2.0 明确返回 `kiln-too-old`
  「需要 kiln v0.2.1+：list --search 的行缺少 rank」。
- 端到端（`readFlow` + `readSearch` + `mapSearchRows`，真实本仓）：
  - `dsh` → `kiln-dsh-integration#1`（无 hit）、`kiln-graph-width-handle#3`（hit `ask`，1/4）；
  - `kiln v0.2.0` → `kiln-search#0`、`kiln-v020-adapter#0`；
  - `色条 选中` → `kiln-search#4`（无 hit）。
- `node --check` 覆盖 client / index / flow；README、AGENTS、package.json 同步。

### 已知代价 / 边界

- 搜索从 0.04ms 内存匹配变成「120ms 防抖 + 约 100ms 进程」；这段延迟已在真机验收为可接受。
- 全仓结果里快照外的 issue（>80 条）只显示简版行，不能展动作/色条；要把焦点 issue 纳入快照是后续 issue。
- PATH 上的 `kiln` 仍是 v0.2.0；运行插件要 `DSH_KILN_BIN=C:\Users\jacki\kiln\kiln.exe`
  （或更新 PATH）。新二进制目前是 `v0.2.1-0.2026…` 伪版本，正式发布前文档不写死版本号。
- 新路由需要重启 DSH 宿主才加载；客户端刷新后生效。