# @jackiehank/dsh-kiln

DSH × kiln 的插件：在会话顶部标签排（对话 / 轨迹 / 上下文）**之后**加一个 `kiln` 标签，
只读展示 kiln 仓库的三页视图（时间线 / issue / 关系）。**插件版本 0.14.0**：按视图取数——
首屏只读一条动作流，关系图与详情点开才取，图 / 详情 / 搜索按会话缓存；动作流双端按 HEAD 缓存
（HEAD 未变时切回标签 **0 子进程、0 字节**），HEAD 前进时只读**安全可证的前缀**，
列表按可视区虚拟渲染、滚到底再追加。动作行是 **7 槽数组**（宿主缓存、线上、客户端缓存同形），
10 万行线上约 24MB。

- 版本要求：**取数需 kiln v0.2.0+**（`graph --json`、单条 `path --json`、`commit` 键），
  **搜索需 v0.2.1+**（`rank` / `hit.total` / `hit.date`），**动作流与词表需 v0.3.0+**
  （`action log --jsonl`、`action list --json`）。v0.4.0 起热读约 30–40ms（缓存默认开启），
  插件不需要它才能工作，只是更快。旧版会在对应面明确报错，其余页面不受影响。
- 数据来源：宿主路由 `GET /kiln/graph`（关系图，HEAD 缓存）、`GET /kiln/issue?id=`
  （详情，点开才取）、`GET /kiln/timeline`（NDJSON 流；带 `?head=` 时未变就回 `unchanged`）、
  `GET /kiln/actions`（词表）、`GET /kiln/search`（一次搜索）。宿主进程里对应跑
  `kiln graph --json`、`kiln path <id> --json`、`kiln action log --jsonl`、
  `kiln action list --json`、`kiln list --search <q> --json`——**一个视图一条命令**。
- 浏览器半不直接读文件，也不调 CLI；仓库根 = 当前会话的工作区目录。

## 三页与取数

| 视图 | 数据 | 何时取 | 本机代价（热 / 冷） |
| --- | --- | --- | --- |
| 时间线 | `action log --jsonl`（全仓动作流） | 打开标签就订阅 | 42ms / 120ms（HEAD 未变 ~2ms、0 字节） |
| issue 列表 | 同一条流，客户端折叠 | 随流 | 0 |
| 详情 / 聚焦 | `path <id> --json`（动作 + 进出的边） | 点开时 | 42ms / 120ms |
| 关系图 | `graph --json`（节点 + 折叠边） | 切到关系页时 | 42ms / 120ms |
| 搜索 | `list --search <q> --json` | 输入停 120ms 后 | 42ms / 120ms |

（数字是本机 Node spawn 的中位数，本仓 24 issue / 153 动作；冷 = `kiln cache clear` 之后。
HEAD 用文件直读，命中时宿主只花 1–2ms。）

- **无焦点的 issue 列表只吃动作流**（见 `docs/issues/kiln-input-streams.md`、`kiln-v040-adapter.md`）：
  按 issue 折叠出「首现 = 最近动作」的行——顺序天然是 recency，色条随流增长，`done` 用
  `action list` 的终点词表判定，`domain`/`tags` 按 kiln 的聚合规则折叠。**没有 80 条上限**，
  也没有「快照外」这条死路：任何一行都能聚焦，结构由详情现取。流没读完时计数标「读取中」，
  筛选空结果显示「筛选中，继续加载…」，不会拿半截数据说“没有符合条件”。
- **详情 = 单条 `path`**：动作、序号与这个 issue 的**全部边**（进 + 出）都在一份文档里，
  聚焦页的分组与时间线收窄都用它，不再依赖关系图；邻居的标题与领域来自流折叠出的 issue 索引。
  同一 `(repo,id)` 在会话内复用（再次聚焦 0 进程），hover 行 120ms 后预取，点开即开。
- **关系图懒加载**：只在关系页取；切回页签先渲染会话缓存、再后台重取（不闪空）；hover
  「关系」页签会预取。聚焦半径 1/2 的局部图由客户端在图上裁，不再预取整仓。
- **会话缓存（0.7.0）**：图 / 详情 / 搜索都以仓库为前缀缓存在内存里（详情、搜索 LRU 20），
  点「刷新」或重开页面才失效——与动作流“mount 时重读”的失效模型一致，不落盘。宿主另按
  `(repo, 配置令牌, 二进制令牌)` 缓存词表，浏览器 F5 后不必再起一次 `action list`。
  搜索 effect 通过 ref 读 issue 索引，流式期间不会因为索引每批换新而 abort 重发。
- **动作流缓存（0.10.0 → 0.13.0）**：宿主按 `(repo, HEAD, 配置令牌, 二进制令牌)` 记住上一次的动作行；
  客户端也按仓库记住同一份行与它对应的 HEAD，下次带 `?head=` 去问：
  HEAD 没动就回 `x-kiln-mode: unchanged`（**0 子进程、0 字节**，切页直接复用本地行）；
  HEAD 前进且**前缀可以证明安全**时只读新前缀（`incremental`），客户端那份正好是旧 HEAD 时
  只发新增行（`delta`）。客户端先用手上的行渲染、等流读完一次性换掉，不闪白也不闪半截。
  安全条件（缺一即全量）：旧 HEAD 是新 HEAD 的祖先；`旧..新` 区间里所有提交的 author 时间
  都晚于缓存首行（挡住 cherry-pick / rebase 带进来的旧日期提交）；缓存 ≥ 5000 行
  （小仓全读更快）；区间提交数 ≤ 2000。单仓超 **12 万行 / 32MB** 两端都不存；
  两端各有 **64MB 总预算**，跨仓按 LRU 淘汰（单仓超限只降级它自己）。
  `DSH_KILN_TIMELINE_CACHE=off` 一键关掉宿主那份，`?fresh=1` / 「刷新」清掉两份。
- **行的形状（0.13.0）**：`[issueId, action, commit, date, title, domain, tags]`，标签存连接串、
  `short` 由 commit 现切、重复的 issueId/action/domain 走驻留池。宿主存的数组就是发出去的字节，
  客户端 parse 出来就是要存的行——两端都不再“建对象”。线上带 `?format=2`；
  不带（旧客户端）由宿主回 400 并提示刷新，避免拿到假的空列表。
- **虚拟列表（0.9.0）**：时间线、issue 列表、搜索结果都只挂“可视区 ± 600px”的行，
  上下用 `.dkf-vspacer` 撑出内容总高；行高先按 30px 估、渲染后按真实高度修正
  （键 = 提交 sha / issue id，流在顶部插行也不会串）。内容总高不超过视口 + 2×overscan 时
  整份渲染（小仓不变）。键盘最后一行再按 `↓` 会继续滚并接管焦点；搜索 `↑/↓` 按高度表滚到
  选中行；搜索跳转同样按索引 + 高度表滚过去，目标还没进流就等流。没有「加载更多」按钮，
  也没有 footer。切页 / 换焦点 / 改筛选 / 改查询 / 刷新都回到第一屏。
  已知：find-in-page / aria 只覆盖已挂行；极端快速滚动时实测高度修正可能带来轻微位移。
- 视图语义：三页共享一个焦点 issue。issue 页无焦点时一行一个 issue；有焦点时读出结构——
  part-of 作母/子分组与面包屑，`blocks` → `supersedes` → `caused-by` 按强弱排，弱关联（relates-to）
  默认展开，行内带方向与关系名。关系页只有图（全局 / 聚焦），hover 节点弹出该 issue 的 ask 标题。
  焦点切换只在内存里，不落盘。
- 筛选（见 `docs/issues/kiln-issue-filter.md`、`kiln-timeline-filter.md`）：两页各筛自己的行。
  issue 页按 **领域 / 状态**，时间线页按 **动作 / 领域**；同组多选是 OR、组间是 AND，
  某个维度在本仓没有可选项时整组不出现。筛选是纯客户端过滤（不调 `kiln list`），状态按仓库记在内存里。
  标签不作为筛选维度：tag 是动作级 trailer、视图只有 issue 级并集。
- 搜索（见 `docs/issues/kiln-search.md`）：第一层页头中间常驻一个输入框，输入停 **120ms** 后由宿主
  `GET /kiln/search` 调 `kiln list --search <q> --json`（全仓范围，不看筛选与焦点）；
  `↑↓` 选、`⏎` 确认、`Esc` 清空，新查询会 abort 旧请求。**匹配、rank、顺序、hit 全由 kiln 给**；
  检索面 = issue id ＋ 当前标题 ＋ 所有动作标题。高亮区间由客户端从查询串现算；悬停结果行有预览；
  回车按命中类型分流：issue 名 → issue 页；动作标题 → 时间线并展开、滚到那条动作。
- 外观与交互（`docs/issues/kiln-ui-refresh.md`、`kiln-hint-style.md`）：两层页头；字号 / 圆角 /
  颜色全部取宿主 `--dsw-*` 语义 token。状态只有一套（叠一层 `--dkf-hover`），提示框只有一套
  （`data-hint` + 260ms 委托），关系图把 Pele 的 8 个钩子接到同一套角色上。

## 与 kiln v0.4.0 缓存的关系

v0.4.0 默认开启提交记录缓存，落在 `<git-common-dir>/kiln/`（层 + 枚举快照），热读 0 个 git 进程。
插件**自己不写文件**，但用插件就会让 kiln 写这份缓存（约 0.2KB/提交、本仓 3 个文件 35KB）。

- 每个 HEAD 的第一次读多付一次全扫（本仓约 20ms；上游 100k 约 230ms），之后命中；
- 缓存异常 / 升级后想重建，用 `kiln cache clear`（插件不代劳），日常回收 `kiln cache gc`；
- 插件只读的边界不变：不写 trailer、不造提交、不落盘。

插件自己还有一层**进程内**缓存（0.7.0 的图/详情/搜索、0.10.0 的动作流），与上面这份互不相干：
kiln 的缓存省的是“git 进程”，插件省的是“kiln 进程”。两层都失效时才是完整的一次冷读。

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半：注册只读 HTTP 路由（`/kiln/graph`、`/kiln/issue`、`/kiln/timeline`、`/kiln/actions`、`/kiln/search`） |
| `lib/flow.js` | 宿主半的数据层：调 kiln CLI（graph / path 单条 / list --search / action list） |
| `lib/timeline.js` | 宿主半的时间线：spawn `kiln action log --jsonl`、按行切、失败文案 |
| `lib/timelineHandler.js` | 宿主半的时间线路由体：命中内存重发 / 构建 / bypass 三条路 |
| `lib/rowsCache.js` | 宿主半的动作流缓存：HEAD / 配置 / 二进制失效，12 万行 / 32MB 单仓 + 64MB 总预算 |
| `lib/snapshot.js` | 宿主半的图缓存：HEAD / 配置 / 二进制三元组失效，同仓并发合并 |
| `lib/git.js` | 宿主半的 git 探测：直读 HEAD、配置/二进制令牌 |
| `lib/client.js` | 浏览器半：`conversation.view` 插槽条目，名字 `kiln`；折叠与渲染 |
| `test/run.mjs` | 宿主侧用例（数据层、缓存决策、动作流缓存/路由、搜索行映射/筛选纯函数） |
| `test/render.mjs` | 渲染冒烟（极简 React 替身，不碰浏览器） |
| `test/probe-perf.mjs` | 性能探针：graph 冷/热、详情单条、并发合并、旧法逐条取数对照 |
| `test/probe-memory.mjs` | 内存探针：动作流的传输/解析/折叠/常驻堆，含 10 万行实测 |
| `test/probe-format.mjs` | 形状探针：7 槽数组 / 旧对象 / 原始行 / Buffer 的 10 万行堆与重发对照 |
| `cordis.patch.yml` | 宿主侧插入声明（`insert: id: dsh-kiln`） |
| `package.json` | `dsh.bundle.patch` + `dsh.client` 平台与依赖声明 |

## 单独验证数据层

不需要 DSH，只要 PATH 上有 kiln、目录里有 `.kilnconfig.jsonc`：

```powershell
node --input-type=module -e "
  const { readGraph, buildGraph, readIssue } = await import('./lib/flow.js');
  const g = await readGraph('C:/path/to/a/kiln-repo');
  const graph = buildGraph({ repo: 'x', graph: g.graph });
  console.log(graph.ok, graph.issues.length, graph.edges.length);
  const one = await readIssue('C:/path/to/a/kiln-repo', graph.issues[0].id);
  console.log(one.ok, one.issue?.actions.length, one.issue?.relations.length);
"
```

量一次取数的代价（只读，跑 `kiln` 与直读 ref，不写文件）：

```powershell
node plugin/test/probe-perf.mjs . C:\Users\jacki\kiln
```

## 安装

要求 DSH **0.2.x**（包内 `engines.dsh: >=0.2.0 <0.3.0`）与 kiln v0.3.0+（见开头）。装进哪个
profile，就把下面的 `web` 换成它（桌面端通常是 `desktop`）。

**npm（推荐）**

```powershell
dsh plugin --profile web add @jackiehank/dsh-kiln
```

**GitHub Release 里的 tgz**（机器上没有 npm 账号也能装）

```powershell
dsh plugin --profile web add ./jackiehank-dsh-kiln-0.14.0.tgz
```

**GitHub 源码**（pnpm 9+ 的 `#path:` 语法；仓库带完整 issue 历史，装一次要 clone 整仓）

```powershell
dsh plugin --profile web add github:jackiehank/dsh-kiln#path:/plugin
```

**本地 checkout**（开发这个插件时用）

```powershell
dsh plugin --profile web add <本仓库>/plugin
```

装完刷新 GUI（或重启 DSH）；标签出现后，在 kiln 仓库里打开会话即可看到视图。若 profile 的
`package.json` 里没有出现 `@jackiehank/dsh-kiln`，手动把它加进 `dsh.profile.bundles` 再重启。

## 已知边界

- 只读；不写 issue、不提交。
- **版本下限**：取数 v0.2.0+、搜索 v0.2.1+、动作流与词表 v0.3.0+。旧版对多余 id 会静默只回
  第一条、搜索行没有 `rank`、没有 `action` 子命令——插件直接报对应版本，不退回逐条或自己补排序。
- **规模上界是整条动作流**：issue 列表与时间线都要读完全部动作（O(动作数)）。1k 动作内一次
  42ms 热读；100k 动作约 24MB 线上，默认预算（12 万行 / 32MB）正好覆盖，上游明确不做分页
  （`issue-list-scaling`：多了靠筛/搜/解释命中），见 `kiln-many-issues`。
  0.10.0 起 HEAD 未变时重进标签 0 子进程、0 字节（双端命中）；0.12.0 起 HEAD 前进且前缀安全时
  只读新前缀，但仍要先跑两次 git 探测（`merge-base` + 区间 `git log`，约 40–60ms）。
- **增量的残余风险**：判定用的是“旧 HEAD 是新 HEAD 的祖先 + 区间提交日期都晚于缓存首行”。
  kiln 的排序是 `git log --author-date-order`，旁支提交只按日期排；日期回退的提交会被这条件挡下、
  退回全量。读完前缀还会再读一次 HEAD，变了就重来。真出现判定失误（例如上游改排序），
  后果是**少读到新行**而不是读到错行，刷新即可自愈。
- **虚拟列表之外的行不在 DOM**：find-in-page 只能搜到当前挂载的“可视区 ± 600px”；
  滚过去的行会重新挂上，但搜索不会自动跳到它们（虚拟化的固有代价）。
- **详情按需带来一跳**：点开 issue 多等约 42ms（冷 120ms），换来没有 80 条上限、没有快照/流双源；
  同一 issue 二次点开走会话缓存。hover 预取只在鼠标停留 120ms 后触发，扫过列表不会取一整屏。
- **缓存语义分两层**：图 / 详情 / 搜索是“本次挂载内一致”，刷新或重开页面即失效；
  动作流是“跟 HEAD 一致”，切页、换会话都复用它，新提交只在 HEAD 前进后重新读。
  想让两层都作废，按「刷新」或用 `?fresh=1`。
- **动作流缓存占内存**：客户端与宿主各留一份（10 万行约 35MB/份，7 槽数组实测 356B/行）。
  单仓超 12 万行 / 32MB 不存，两端各 64MB 总预算按 LRU 淘汰（单仓超限只降级它自己）；
  浏览器堆没有可靠的测量 API，页头显示的是自报字节数，不是实测堆。
- 关系词表按 kiln 0.2.0 的内置词表硬编码在 `client.js` 的 `GROUPS` 里；等 kiln 支持
  `.kilnconfig.jsonc` 配置 `relations` 后改成读配置。
- Flow 布局是初稿，Triage / Genealogy 尚未实现。
