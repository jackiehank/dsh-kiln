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
