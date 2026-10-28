# kiln-many-issues — issue 多起来时，Flow 的快照边界怎么定

- **domain**：integration
- **关联**：caused-by `kiln-search`（全仓搜索把 80 条上限暴露出来）；relates-to `kiln-perf-snapshot`、relates-to `kiln-flow-focus-ui`

## 问题

Flow 是**只读快照**：打开仓库时拿全量 `graph`，但只保留前 80 条 issue 的完整动作序列
（`DEFAULT_MAX_ISSUES`）。80 条以内一切正常；超过之后：

1. **Flow 只看得到前 80 条**：文本、issue 页、时间线、关系图都只用这 80 条；
   `payload.total` / `truncated` 只给计数与一行提示。
2. **“前 80”是 id 字典序的前 80**：graph 节点按 issue id 排序，不是按最近动作、也不是按焦点邻域。
   新 issue 的 id 如果排在后面，可能压根不在快照里。
3. **搜索是全仓的**：`kiln list --search` 会返回快照外的 issue。这些行有 id / 领域 / 状态 / 标题
   与 kiln 给的 `hit`，但没有 actions——色条画不出、动作展不开；点它只会得到
   「焦点 X 不在本次快照里」的提示。
4. **大仓不承诺**：上游压测 100k issue 时 `path --all` 是 35MB 输出 / 约 329MB 峰值；
   80 条这个护栏不能简单拿掉。

当前两个仓都不到 80（dsh-kiln 20、`~/kiln` 64），所以这是「尚未发生但一定会发生」的问题。
本 issue 只讨论边界与方向，不做实现。

## 现状与证据

| 事实 | 位置 / 数字 |
| --- | --- |
| 上限 | `DEFAULT_MAX_ISSUES = 80`（`plugin/lib/flow.js:17`） |
| 截断点 | graph 全量 → `nodes.slice(0, maxIssues)`（`flow.js:199`）；`total` / `truncated`（`:239`） |
| 只取这 80 条的动作 | `readFlow()` 只对 kept ids 跑批量 `path`（`flow.js:378`） |
| 节点顺序 | graph 的节点按 id 字典序；所以是“字母序前 80” |
| 快照体积 | 20 条 ≈ 41.7KB、63 条 ≈ 103KB（约 1.6KB/issue；含标题/动作） |
| 冷启动 | 批量 path 后本仓 0.21s、`~/kiln` 0.23s（20 / 63 条） |
| 搜索 | 全仓 `list --search`；本机 103–112ms/次，不受 80 限制 |
| 搜索行跨出快照 | `mapSearchRows()` 给一个 `actions: []` 的最小行（`client.js:1029`）；点击后 `missingFocus` 提示（`client.js:2536`） |
| 截断提示 | `payload.truncated` 时显示「共 N 条 issue，只展示前 M 条」（`client.js:2544`） |
| 历史结论 | `kiln-flow-focus-ui` 已记录“焦点不在 80 条里会静默丢”，后来只补了提示；`kiln-search` 把“快照外命中要能把焦点纳入”列为后续 |

## 要回答的问题

1. **80 是什么性质的上限**：UI 渲染/性能护栏，还是数据完整性边界？要不要可配、按仓库规模自适应，
   还是明确写成“只保证前 N 条”？
2. **选哪 80 条**：id 字典序（现状）/ 最近动作 / 焦点邻域 / 混合？需要稳定可复现吗？
   如果按“最近”，大仓里活跃 issue 会更可能在快照里，但顺序会随每次快照变化。
3. **快照外的命中怎么处理**：
   - 加 `GET /kiln/issue?cwd=&id=`，按需取一条 `path` 做 overlay；
   - 还是让 `readFlow` 把焦点 issue（及一跳邻域）强制纳入，哪怕在 80 之外；
   - 还是只给简版行、明确“搜到了但打不开”。
4. **截断怎么表达**：页头提示、搜索行标记、计数、空态；用户如何一眼知道“结果在但视图不含它”？
5. **大仓要不要换模式**：搜索优先、按需加载、分页/目录，还是明确“超过 N 条请缩小仓库/用 CLI”？
   不能让 100k 仓在打开时悄悄卡死。
6. **性能目标**：80 / 500 / 5k 合成仓的冷启动、内存、搜索延迟各是多少？超出时降级到什么？
7. **怎么测**：合成仓（80/500/5k）的探针；不落盘、不把重资源测试塞进常规 CI。

## 约束

- 只读、不落盘；数据只走 `kiln <cmd> --json`；不引构建步骤；
- **<80 条的行为不变**；
- 搜索仍应是全仓的，不能为了迁就快照把结果过滤成前 80；
- 不建索引、不做持久化缓存；焦点只在内存；
- 不在插件里复刻 kiln 的状态解析。

## 候选方向（待比较，先不选）

| 方向 | 做法 | 代价 |
| --- | --- | --- |
| **A** 只修可导航性 | 加按需 `/kiln/issue`，快照外命中取单条 `path` 后 overlay | cap 仍是 80；多一条路由与客户端 overlay 状态 |
| **B** 焦点优先 | `readFlow` 把焦点 issue + 一跳邻域纳入保留集合 | 缓存要按 focus 建或重建；边/邻居缺失要说清 |
| **C** 换 cap 策略 | 最近 N / 可配 N / 按仓库自适应 | 顺序随快照变；大仓仍会撞墙 |
| **D** 大仓换模式 | 搜索优先 + 按需打开，列表不追求全量 | 交互形态变化最大 |
| **E** 明示 partial | 保持现状，把“前 80 条/搜到了打不开”写进 UI 与文档 | 不解决大仓可用性 |

## 验收（讨论出方向后）

- 80 / 500 / 5k 合成仓各跑一次，记录：冷启动、payload、截断提示、搜索命中的可打开性；
- 快照外命中要么能打开完整动作（A/B），要么 UI 明确说“当前快照不含它”（E）；不能默默只给半行；
- <80 条的现有输出、性能与用例不变；
- 搜索仍全仓；不新增落盘文件；
- 新用例覆盖截断计数、焦点缺失、快照外搜索命中。

## 非目标

- 不改 kiln 的搜索语义、rank、hit；
- 不引入索引 / 数据库 / 持久化缓存；
- 不承诺把 100k issue 全塞进一次快照；
- 不改关系图 / 时间线的视觉。

## 收集：同类工具怎么处理“多”（2026-10-28）

看的是同一个问题：对象很多、不可能全塞进一个本地视图时，CLI / TUI / Web / GUI 分别怎么办。

### 1. GitHub（Web + gh CLI）：一页 + 服务端搜索 + 按需详情

- REST 列表分页：`per_page`，大多数端点最大 100，下一页靠 `Link` header
  （[pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)）。
- `gh issue list` 默认只取**最近 30 条**，`--limit` 调大；筛选/搜索交给服务端
  （[manual](https://cli.github.com/manual/gh_issue_list)）。
- 搜索 API 每次最多 **1,000 条**（[search](https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28#about-search)）；
  超出时不是“全量”，而是明确的分页边界。
- Web 的 issue 列表本身是查询结果，不是全库；点开 issue 才取详情/评论。

**含义**：列表是「一页」，不是「库」；搜索是导航大集合的主入口；详情按需取。

### 2. Jira：JQL 搜索优先 + token 分页

- 新版 `/rest/api/3/search/jql` 用 `maxResults` + `nextPageToken` / `isLast` 翻页
  （[JQL search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)）；
  不再假设能一次拿全。
- 界面是 issue navigator：先写 JQL/筛选，再翻页看结果；详情按需打开。

**含义**：大集合的默认交互是“先查询”，不是“先列全”；页与页之间用稳定 token。

### 3. GitLab：keyset 分页

- API 默认 `per_page` 20、最大 100；用 keyset/游标而不是纯 offset，翻页稳定
  （[pagination](https://docs.gitlab.com/api/rest/#pagination)、
  [keyset](https://docs.gitlab.com/development/database/keyset_pagination/)）。

**含义**：顺序与游标是契约的一部分；同一个仓库翻页不能因为新增对象而漂移。

### 4. gh-dash（TUI）：固定 20/节，导航到未加载项时再取

- 默认每个 section 只取 **20 条** PR / issue，可配置；加载时、定时刷新、以及
  **导航到“还没有取到”的下一条时**再取
  （[defaults](https://www.gh-dash.dev/configuration/defaults)）。
- 右侧 preview pane 按需取当前项的详情；30 分钟定时刷新。

**含义**：这是最接近插件的先例——固定页大小不是问题，**页能前进、当前项能预览**才是关键。

### 5. Sourcegraph：搜索有上限/超时，明确“非穷尽”

- 默认搜索有 `count:` / 超时上限；要穷尽需显式 `count:all`，且仍受服务端超时约束
  （[exhaustive search](https://docs-legacy.sourcegraph.com/@4.4/code_search/how-to/exhaustive)）。

**含义**：上限要可见、可解释；不要用“前 N 条”冒充全量。

### 6. Linear：local-first 同步 + 本地 DB

- 客户端各自维护本地数据库，创建/改状态/导航不依赖网络往返；增量 sync 处理落后
  （[delta sync](https://linear.app/now/rebuilding-delta-sync-read-path)）。

**含义**：这是另一条根治路线——全量本地索引，代价是持久化/同步引擎；与插件“不落盘”冲突，
除非改形态。

### 归纳：五条共识

| 共识 | 例子 | 对 kiln 的含义 |
| --- | --- | --- |
| 列表是「一页」，不是「全库」 | GitHub 30/100、GitLab 20/100、Jira maxResults、gh-dash 20 | 80 本身不是问题 |
| 页必须能前进 | GitHub 下一页、Jira token、gh-dash 导航时补取 | 现在缺“第 81 条”的路 |
| 大集合靠搜索导航 | GitHub/Jira/Sourcegraph | 已有全仓搜索，但结果要能打开 |
| 详情按需取 | GitHub issue 页、Jira、gh-dash preview | 行便宜、详情贵；不该把详情塞进快照 |
| 上限要可见/可解释 | GitHub 1k、Sourcegraph count/timeout | 截断提示要有，且能继续 |

另有两条反例/边界：

- **VS Code** 用 `search.maxResults`（默认 20,000，可调）截断结果，但明确给“show more”；
  说明“上限 + 可调 + 明示”是 GUI 的常见组合。
- **Linear** 的本地全量同步能根治“多”，但要持久化索引；本仓的只读、不落盘约束下不该走。

### 对 dsh-kiln 的直接含义

1. **80 不是问题本身**；“只给前 80 条、且没有第 81 条的路”才是。GitHub / Jira / gh-dash
   都接受页大小，但都能继续取或按需打开。
2. **gh-dash 是最接近的先例**：固定页 + 导航到未加载项再取 + preview。插件的搜索命中已经跨出页，
   缺的正是“打开这一条”的按需取数。
3. **候选 A（`/kiln/issue` 按需取单条）不是补丁，是主流做法**；候选 B（焦点纳入）能让页选得更聪明，
   但替代不了“任何命中都能打开”。
4. **大仓“搜索优先”不是新发明**：Jira/JQL、GitHub search 都是；插件已有全仓搜索，只差结果可打开。
5. **不学 Linear**：本地全量同步能根治，但要持久化索引/同步引擎，与“不落盘”冲突；除非另开 issue
   改形态。

### 来源

- GitHub 分页：<https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api>
- GitHub 搜索上限：<https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28#about-search>
- gh issue list：<https://cli.github.com/manual/gh_issue_list>
- Jira JQL search：<https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/>
- GitLab 分页：<https://docs.gitlab.com/api/rest/#pagination>
- GitLab keyset：<https://docs.gitlab.com/development/database/keyset_pagination/>
- gh-dash defaults：<https://www.gh-dash.dev/configuration/defaults>
- Sourcegraph exhaustive：<https://docs-legacy.sourcegraph.com/@4.4/code_search/how-to/exhaustive>
- Linear delta sync：<https://linear.app/now/rebuilding-delta-sync-read-path>

## 收集：kiln 本身怎么处理“多”（2026-10-28）

核实对象：`C:\Users\jacki\kiln\kiln.exe`，`v0.2.1-0.20261028065156-2b02f3d33cd7`；
当前仓 64 issue / 315 actions。方法：读 `allowedFlags` 与 git log 调用、跑命令数行数/字节/耗时、
再试 `--limit`。

### 结论：kiln 没有分页，所有读命令都是全量

| 命令 | 输出 | 证据 |
| --- | --- | --- |
| `list` | 过滤/搜索后的**全部**行 | `count=64`、`issues=64`；`--limit 5` 只警告未知 flag，仍回 64 |
| `status` | 全部 issue（按 domain 分块） | 64 条行；文本 72 行（含块头/汇总）；`--limit 5` 仍 64 |
| `graph` | 全量节点 + 折叠边 | 64 节点 / 99 边；`--issue` / `--depth` 是**邻域收窄**，不是分页 |
| `path` | 单条或点名的多条全量动作 | 单条 2,033 B；`--all` 64 条 / 315 动作 / 131,929 B |
| `check` / `worktree list` | 全部结果 | 源码里同样没有 limit/offset |
| `list --search` | 全部命中，按 rank 排序 | 例如 `a` 命中 63 条，没有截断 |

源码层面：

- `list` 允许的 flag 只有 `json/domain/tag/action/status/search`（`cli.go:2389`）；
- `status` 只有 `json`；`graph` 是 `format/mermaid/json/issue/depth`；`path` 是 `stat/shortstat/json/all`；
- `git log` 是全史（`internal/vcs/git/git.go:31`，没有 `-n` / `--max-count`）；
- 全仓 grep 没有 `limit` / `offset` / `paginate` / `per_page` 之类的读侧实现；
- 唯一能“变短”的手段是**过滤/取子集**：`list` 的筛选/搜索、`graph --issue --depth`、`path` 指定单条/几条——
  都不是分页。

### 实测数字（本机，64 issue）

| 命令 | 字节 | 耗时（3 次） |
| --- | --- | --- |
| `list --json` | 17,206 | 96–99 ms |
| `status --json` | 15,301 | 99–101 ms |
| `graph --json` | 26,781 | 99–101 ms |
| `path --all --json` | 131,929 | 100–102 ms |
| `path <id> --json` | 2,033 | 98–101 ms |

`--limit 5` 实测：`list --json` 仍 `count=64`，`status --json` 仍 64 行；只打一行
「未知 flag --limit」。

### 对 dsh-kiln 的含义

1. **80 条是插件自己的策略，不是 kiln 的限制**。kiln 侧没有 page/limit 可对，不能指望上游分页。
2. **按需详情的原语已经存在**：`kiln path <id> --json`（约 100ms / 2KB）。候选 A 不需要新上游命令，
   宿主加一条 `/kiln/issue`（或复用 `path` 的单条调用）即可。
3. **`path --all` 不是大仓通解**：64 条已经 132KB；上游压测 100k 时 35MB / 329MB。
4. **`graph` 已是全量节点/边**：插件是在本地切片；如果只想“列全 issue 元数据”可以不取 actions
   （`list`/`graph` 就够），但 timeline/动作详情仍要 `path`。
5. **搜索侧不缺分页**：`list --search` 已返回全量命中；缺的只是“打开快照外那一条”，不是数据层翻页。
6. **kiln 的形态是无状态全量扫描**：要做分页/索引，要么在插件侧做页语义，要么改 kiln 形态（另开 issue）。

## 假设：索引 + 按需详情，把 80 从 dataset 上限降成页（2026-10-28）

> 结论先行：**不再拿全量 `graph` 当初始快照**。初始只取 `list` 的元数据索引（id/domain/action/done/title/commit/tags）；
> 小仓（≤S）再批量取全部 `path`，关系图/焦点图后台或按需；大仓（>S）只取焦点 issue 的 `path` + 邻域 `graph`，
> 列表按窗口渲染，全局图/全时间线降级。100k 的首次全史扫描插件侧消不掉；要更快只能上游加 limit/count，
> 本设计先把 payload、DOM 和单次详情 bounded 住。

### 1. 成本模型：80 只挡住了 path，没挡住 graph

| 项 | 事实 |
| --- | --- |
| 当前初始 | 1 次全量 `graph` + 前 80 条的批量 `path`；64 条仓冷启动约 0.22s、payload 约 103KB |
| `graph` | 64 节点/99 边 = 27KB；随 issue/边线性增长。**它才是“全仓快照”的隐性成本** |
| `list` | 64 行 = 17KB；有 id/domain/action/done/title/commit/tags，**没有 edges、没有 actions、没有 date** |
| `path --all` | 64 条/315 动作 = 132KB；100k 上游压测 35MB / 329MB 峰值 |
| `path <id>` | 约 2KB / 100ms；单条详情的天然原语 |
| 搜索 | 全仓 `list --search`，64 条仓 100–112ms；结果已全量，无分页 |
| 上游读命令 | 100k 时约 1–2s / 190MB 量级；任何命令都重扫全史，没有 limit/offset |

结论：**80 条只限制 path 条数，不限制 graph**。大仓初始仍要拉/解析完整 graph，再把大部分扔掉。
要真正 bounded，必须把“初始快照”从 graph 换成 list，并把 graph/path 变成按需。

### 2. 目标与非目标

目标：

- 首屏只依赖**元数据索引**，payload 与 DOM 都有明确上界；
- 任意搜索命中/任意 issue 都能打开详情（actions/焦点结构），不因不在 80 条里变成死行；
- 小仓保持现有三页体验；大仓只降级“全局图/全时间线”，不降级“找到并打开”；
- 只读、不落盘、数据只走 kiln；不新增常驻进程。

非目标：

- 不让 100k 仓的首屏变成毫秒级——首次全史扫描是 kiln 的成本，插件侧只能减少传输/解析/渲染；
- 不把全仓 issue/动作都塞进一次快照；
- 不建索引/数据库；不引入本地 sync（Linear 路线）。

### 3. 方案：C（推荐）—— index-first + 按需详情

#### 3.1 数据分三层

| 层 | 来源 | 用途 | 失效 |
| --- | --- | --- | --- |
| **索引** | `kiln list --json` | issue 列表、筛选、计数、搜索结果的底表 | HEAD / 配置 / 二进制 |
| **详情** | `kiln path <id> --json` | 该 issue 的 actions、timeline、展开 | HEAD，LRU |
| **邻域** | `kiln graph --issue <id> --depth 1|2 --json` | 焦点结构、关系页的聚焦视图 | HEAD，LRU |

`list` 没有 edges/date，所以：

- 关系图不参与首屏；焦点结构在 focus 时取邻域；
- issue 列表默认按 id 序（或上游给 `date` 后按最近，见 §6）；
- timeline 在 small 模式用批量 path 构建；large 模式只按焦点取。

#### 3.2 两种规模，一条数据路径

- **small（≤S）**：索引 + 批量 `path`（≤S 条）；首屏先用索引渲染，path 到了再填 timeline/动作；
  邻域图/全局图在**后台**取一次并缓存，关系页与焦点结构到齐后可用。
- **large（>S）**：只取索引；issue 列表按窗口（W 行）渲染；焦点时才取 `path` + 邻域；
  没有全局图、没有全时间线；搜索仍是全仓。

S 先取 **200**（200 条约 400KB path、~1000 动作；首屏 path 仍是一个批量进程），W 取 **100**。
这两个数由探针在 64 / 500 / 5k 上量出来后再定，不写死。

#### 3.3 接口

- `GET /kiln/index?cwd=` → `list --json`（全量元数据，按 HEAD 缓存）；
- `GET /kiln/issue?cwd=&id=&depth=1` → `path <id>` + `graph --issue <id> --depth 1`（合并、LRU）；
- `GET /kiln/search` 保持现状（全仓、rank/hit）；
- 关系页：
  - small：后台 `graph --json` 后缓存；
  - large：只用 `/kiln/issue` 的邻域；全局图显示“仓库过大，已切到聚焦视图”。

#### 3.4 客户端

- issue 页：索引 + 窗口渲染（W 行），“加载更多”只是本地切片；筛选/搜索不变；
- timeline：small 用 path 全量；large 只显示焦点 issue 的动作，并明确提示；
- 关系页：small 全图；large 聚焦邻域；
- 搜索：结果行不再分“快照内/外”——任何行都能 `/kiln/issue` 打开；
- 页头常驻“索引 N 条 · 小仓/大仓模式”，截断不再是沉默的。

### 4. 性能推演

| 仓库 | 当前 | C 的首屏 | C 的详情 | 说明 |
| --- | --- | --- | --- | --- |
| 64 条 | ~0.22s / 103KB | 索引 97ms/17KB + path 100ms/132KB ≈ 0.2s | 已缓存 | 与现在同量级；graph 27KB/100ms 转后台 |
| 500 条 | graph 全量 + path | 索引 ~130KB / ~150ms；large 不再拉全图 | path+邻域 ~200ms/次 | 首屏与详情都 bounded |
| 5k 条 | graph/path 明显变大 | 索引 ~1.3MB / ~1s | ~1s/次，LRU | DOM 只渲染 W 行；无全时间线 |
| 100k 条 | 首屏可能数秒/百 MB | 索引 ~27MB / 1–2s | 1–2s/次 | 插件侧不能更快；需上游 limit/count |

数字是线性估算 + 已有实测（64/100k）的组合，**不是承诺**；S/W 由探针定。

### 5. 为什么不是 A / B / E

- **A（只加 /kiln/issue）**：解决“搜到了能打开”，但首屏仍是全量 graph；100k 的 payload/解析没变。
  它是 C 的子集，先做不冲突，但不能单独算“解决大仓”。
- **B（小仓全量 / 大仓 lazy 两套快照）**：要先用 list 探测 count（多一个进程），大仓仍保留全量 graph 的小仓路径；
  两条数据路径更容易分叉。C 用同一份 list 索引，差别只在取多少 path/图。
- **E（本地索引/同步）**：Linear 路线能根治，但要持久化/常驻 sync，与本仓“只读、不落盘”冲突；不在本轮。

### 6. 上游还欠什么

- `list --limit/--offset`（或 cursor）与 `--count`/`status --summary`：让大仓首屏只取一页，而不是 27MB；
- `list --json` 行加 `date`（末条动作时间）：否则 large 模式的 issue 列表只能按 id，不能按最近；
- `graph --summary` / 邻域接口的低成本实现：当前 `graph --issue --depth` 仍会 build 全仓，输出小但耗时没降；
- 这些是 kiln 仓的活，另开 issue；插件侧先用现有命令跑通 C。

### 7. 风险

- **索引仍全量**：100k 时 list 本身 1–2s/几十 MB；没有上游 limit，C 只能保证“不再叠加 graph/path”。
- **邻域命令仍全史扫描**：每次未缓存的 focus 约 100ms（小仓）/1–2s（大仓）；LRU 与加载态必须做。
- **产品降级**：large 没有全局图/全时间线；这是显式取舍，不能默默给空页。
- **缓存失效**：HEAD/配置/二进制任一变化就清索引与详情；详情 LRU 随 HEAD 清空。
- **两套视图**：small/large 的模式提示、空态、错误文案要一起测。

### 8. 验收 / 实验

- 64 条仓：三页体验与现在一致；首屏 ≤0.3s；关系/焦点不因后台加载出现空白（有 skeleton/缓存）。
- 500 / 5k 合成仓：首屏只拉索引；DOM ≤W 行；焦点详情 ≤1s（5k）；搜索命中全部可打开；无全图/全时间线时明示。
- 100k：不崩、不落盘；首屏与 focus 有加载态；文档写明“需上游 limit 才能更快”。
- 测试：80/200/500/5k 合成仓的探针；`__DSH_KILN_TEST__` 下的 fixture；无网络/子进程的纯函数用例。
- 搜索：任意 query 的命中都能打开详情；不再出现“搜到了但打不开”。

## 收集：kiln 的流式 JSON 到底覆盖到哪（2026-10-28）

结论：**只有 `path` 的 batch 形态流式**（`path --all`、`path a b …`）；`list` / `status` / `graph` /
`check` / `show` / 单条 `path` 仍是整份 `writeJSON`。流式降低的是 **kiln 进程的峰值内存**，
不改变输出字节，也不改变消费方“收完整份再 parse”的事实。

### 源码事实

- `pathBatchWriter`（`internal/cli/cli.go:1633`）：`bufio.Writer`（64KB）+ 复用 encoder，逐 issue 写；
  只有 `pathBatch` 用它（`--all` / 多 id）。
- `writeJSON`（`cli.go:2874`）用 `json.Encoder` 一次编码整个 DTO：
  `list`（:2481）、`status`（:2507）、`graph`（:2728）、`check`、`show`、单条 `path` 都走它。
- 测试 `TestPathBatchStreamsTheSameBytesAsWriteJSON`（`cli_test.go:4042`）：流式输出与
  `writeJSON` 逐字节相同——形状是契约，不是实现细节。
- `docs/perf-audit.md`：100k 动作时 `path --all` 35MB 文档 / 1.14s / 峰值 190MB（流式前 330MB，−40%）；
  `list` 约 17MB；明确写「流式只覆盖 batch」；分页/截断列为**不做**，但留了触发条件。

### 实测（64 issue / 315 actions）

| 命令 | 字节 | 是否流式 | 耗时 |
| --- | --- | --- | --- |
| `path --all --json` | 131,929 | 是 | 100–102ms |
| `list --json` | 17,206 | 否 | 96–99ms |
| `graph --json` | 26,781 | 否 | 99–101ms |
| `path <id> --json` | 2,033 | 否 | 98–101ms |

64 条看不出峰值内存差；**输出字节与流式前一致**，因为契约要求同形。

### 对假设的修正

1. **100k 的 `path --all` 峰值是 190MB，不是 329MB**（流式前 330MB）；输出仍是 35MB、时间 +5–10%。
2. **`list` 100k 约 17MB**（原估 27MB）；它不是流式，index-first 仍要整份收/parse。
3. **流式不帮插件**：`flow.js` 用 `execFile` 捕获整个 stdout 再 `JSON.parse`，峰值在插件侧不会因为
   kiln 流式而下降；真要边收边解析得改成 `spawn` + 流式 parser。而且 `path --all` 的 35MB 已超过
   当前 `MAX_BUFFER` 8MB——大仓模式本来就不该用它。
4. **上游对分页/截断的立场比假设里写的更硬**：`issue-list-scaling` 已论证否决，`perf-audit` 的
   “明确不做”里也列了分页/截断。触发条件写的是“真实仓 1k+ / `path --all` >10MB / 消费方需要前 N 条”，
   dsh-kiln 的大仓模式正好命中；可以据此开上游 issue 谈 `--limit`/`--count`，但不能假设它已经有。
5. **结论 C 不变**：索引先行仍然是最小化 payload/DOM 的插件侧办法；只是“上游 limit”从“欠的东西”
   变成“触发条件已到的上游议题”。若上游不做，100k 的首屏仍是 1–2s 的全量 list，只能加加载态，
   不能假装更快。
