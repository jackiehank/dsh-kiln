# @local/dsh-kiln

DSH × kiln 的插件初稿：在会话顶部标签排（对话 / 轨迹 / 上下文）**之后**加一个 `kiln` 标签，
只读展示 kiln 仓库的 Flow 视图。**插件版本 0.2.0，只支持 kiln v0.2.0+**（取数依赖 v0.2.0 的
批量 `path` 与 `commit` 键；旧版会在取数时明确报错，不会退回逐条）。

- 数据来源：宿主路由 `GET /kiln/flow?cwd=<绝对路径>&focus=<issue>`，宿主进程里跑
  `kiln graph --json` 与一次批量 `kiln path <id> … --json`（v0.2.0+）。
- 浏览器半不直接读文件，也不调 CLI；仓库根 = 当前会话的工作区目录。
- 视图语义：三页共享一个焦点 issue。issue 页无焦点时一行一个 issue；有焦点时读出结构——
  part-of 作母/子分组与面包屑，`blocks` → `supersedes` → `caused-by` 按强弱排，弱关联（relates-to）
  默认展开，行内带方向与关系名。关系页只有图（全局 / 聚焦），hover 节点弹出该 issue 的 ask 标题。
  焦点切换只在内存里，不落盘。
- 筛选（见 `docs/issues/kiln-issue-filter.md`、`kiln-timeline-filter.md`）：两页各筛自己的行。
  issue 页按 **领域 / 状态**，时间线页按 **动作 / 领域**；同组多选是 OR、组间是 AND，
  某个维度在本仓没有可选项时整组不出现。纯客户端过滤（不调 `kiln list`），筛选状态按仓库记在内存里。
  标签不作为筛选维度：tag 是动作级 trailer、视图只有 issue 级并集，而且一个仓动辄十几个标签。
- 搜索（见 `docs/issues/kiln-search.md`）：第一层页头中间常驻一个输入框，输入即搜（全仓范围，
  不看筛选与焦点），有输入就把内容区换成结果列表；`↑↓` 选、`⏎` 确认、`Esc` 清空。
  检索面 = issue id ＋ 当前标题（最后一条动作）＋ **所有动作标题**。
  结果分两行：第一行"哪个 issue"（动作色条 + id + 领域/状态；命中动作时色条突出的是**命中的那一格**），第二行"凭什么命中"——命中动作时是
  动作名 + 那条标题 + `历史动作 n/m`，命中 issue 名时则是弱化的当前标题。
  悬停结果行有预览（id/状态/日期 + 完整标题）；回车按命中类型分流：
  issue 名 → issue 页；动作标题 → 时间线并展开、滚到那条动作。
  标签 / 领域 / 关系名还没进检索面。查询串只在内存里。
- 外观（见 `docs/issues/kiln-ui-refresh.md`）：两层页头——第一层是仓库名、搜索框与全局动作，
  第二层左边页切换、右边当前页的计数或图的取景控件。字号 / 圆角 / 颜色全部取宿主 `--dsw-*`
  语义 token（11 / 12 / 13px，4 / 8 / 12px），代码字体用 `--ds-font-family-code`。
  变量集中在 `.dkf-root` 的 `--dkf-*` 上，改皮肤只动那一处。
- 状态只有一套：hover 是"在当前底色上叠一层 `--dkf-hover`"（用 `background-image` 叠，
  所以焦点行的底色不会被顶掉）；图里没有底色可叠，就把淡化的节点临时拉回正常亮度。
  选中是 bg-layer-2 + 600 字重，键盘焦点是 2px accent 内环。
- 提示框也只有一套（`docs/issues/kiln-hint-style.md`）：`.dkf-tip`。元素上写 `data-hint="…"`，
  根节点用事件委托统一弹（260ms 延迟、滚动/拖动/离开即收）；不再用原生 `title`
  （系统样式 + 会和自绘提示同时出现）。图节点的提示内容更富（ask 摘要），但共用同一个 `Tip`。
- 关系图跟着主题走：Pele 不认主题（默认白底深字），所以 `.dkf-graph` 把它的 8 个 `--pele-*` 钩子
  接到同一套 `--dkf-*` 角色上，淡化色也改成向画布混（`docs/issues/kiln-graph-dark-theme.md`）。
  图里的字体同样接进这套角色：字族/等宽走 `--pele-font(-mono)`，字号作为 `fontSize` 传给
  `pele.mount()`（Pele 没有字号变量，只改 CSS 会“字小框不变”，见 `docs/issues/kiln-graph-typography.md`）。
- 与壳的关系：kiln 视图挂载期间隐藏 DSH 的“拖动调宽”手柄
  （`[data-conversation-content]:has(.dkf-root) [data-width-handle]`），切回对话页自动恢复。
- 取数的代价（见 `docs/issues/kiln-perf-snapshot.md`、`kiln-v020-adapter.md`）：一次快照 = 1 次
  `kiln graph` + **1 次批量 `kiln path`**（v0.2.0 起一次进程读多条，点名 ≤80 个 id）。成本几乎
  全在**进程启动**（Windows 约 80ms/次），所以批量化之后「条数」不再进入延迟公式；HEAD 是失效
  令牌，HEAD 不动只花一次直读 ref（<1ms），HEAD 前进只重取受影响的 issue；增量路径上 `graph`
  与两条 git 探测**同时发**；同仓并发的请求并到同一轮构建（连点刷新不会跑两遍子进程）。
  实测：本仓冷启动 0.21s（20 条）、`~/kiln` 0.23s（63 条）、命中 0.4–0.7ms；旧法逐条
  20 次 @并发 8 是 0.46s、63 次 @8 是 1.38s。
  构建耗时进 `payload.cache.ms`，悬停页头的仓库名就能看到「build / incremental / coalesced · 多少 ms」。

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半：注册只读 HTTP 路由（Cordis function plugin） |
| `lib/flow.js` | 宿主半的数据层：调 kiln CLI，把仓库读成一份快照 |
| `lib/snapshot.js` | 宿主半的快照缓存：HEAD 失效、按 issue 增量、同仓并发合并 |
| `lib/git.js` | 宿主半的 git 探测：HEAD、配置/二进制令牌、`old..new` 碰了哪些 issue |
| `lib/client.js` | 浏览器半：`conversation.view` 插槽条目，名字 `kiln` |
| `test/run.mjs` | 宿主侧用例（数据层、缓存决策、搜索/筛选纯函数） |
| `test/render.mjs` | 渲染冒烟（极简 React 替身，不碰浏览器） |
| `test/probe-perf.mjs` | 性能探针：graph / 冷启动 / 命中 / 批量与旧逐条取法的对比 / 并发合并 |
| `cordis.patch.yml` | 宿主侧插入声明（`insert: id: dsh-kiln`） |
| `package.json` | `dsh.bundle.patch` + `dsh.client` 平台与依赖声明 |

## 单独验证数据层

不需要 DSH，只要 PATH 上有 kiln、目录里有 `.kilnconfig.jsonc`：

```powershell
node --input-type=module -e "
  const { readFlow } = await import('./lib/flow.js');
  const flow = await readFlow('C:/path/to/a/kiln-repo');
  console.log(flow.ok, flow.focus, flow.issues.length, flow.edges.length);
"
```

量一次取数的代价（只读，跑 `kiln` 与直读 ref，不写文件）：

```powershell
node plugin/test/probe-perf.mjs . C:\Users\jacki\kiln
```

## 安装（桌面端 profile）

插件目前只是本地目录，不发布。安装需要写 `~/.dsh/profiles/desktop`：

1. 把本目录装进 profile：`dsh plugin --profile desktop add <本目录绝对路径>`；
2. 在 profile 的 `package.json` 里把包名加入顶层 `dsh.profile.bundles`（安装命令不会替你加）；
3. 刷新 GUI（或重启 DSH）；标签出现后，在 kiln 仓库里打开会话即可看到 Flow。

## 已知边界

- 只读；不写 issue、不提交。
- **只支持 kiln v0.2.0+**。一次快照 = 1 次 `graph` + 1 次批量 `path`（≤80 条）。旧版对多 id
  会静默只回第一条，插件不会退回逐条——多 id 却拿到单条文档时直接报「需要 kiln v0.2.0+」，
  避免把第一条当全部。
- 关系词表按 kiln 0.2.0 的内置词表硬编码在 `client.js` 的 `GROUPS` 里；等 kiln 支持
  `.kilnconfig.jsonc` 配置 `relations` 后改成读配置。
- Flow 布局是初稿，Triage / Genealogy 尚未实现。
