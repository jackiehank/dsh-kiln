# @local/dsh-kiln

DSH × kiln 的插件初稿：在会话顶部标签排（对话 / 轨迹 / 上下文）**之后**加一个 `kiln` 标签，
只读展示 kiln 仓库的 Flow 视图。

- 数据来源：宿主路由 `GET /kiln/flow?cwd=<绝对路径>&focus=<issue>`，宿主进程里跑
  `kiln graph --json` 与 `kiln path <id> --json`。
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
  不看筛选与焦点），有输入就把内容区换成结果列表；`↑↓` 选、`⏎` 聚焦并切到 issue 页、`Esc` 清空。
  检索面 = issue id ＋ 当前标题（最后一条动作）＋ **所有动作标题**；命中历史标题时行里显示那条标题
  并标「历史标题」。标签 / 领域 / 关系名还没进检索面。查询串只在内存里。
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

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半：注册只读 HTTP 路由（Cordis function plugin） |
| `lib/flow.js` | 宿主半的数据层：调 kiln CLI，把仓库读成一份快照 |
| `lib/client.js` | 浏览器半：`conversation.view` 插槽条目，名字 `kiln` |
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

## 安装（桌面端 profile）

插件目前只是本地目录，不发布。安装需要写 `~/.dsh/profiles/desktop`：

1. 把本目录装进 profile：`dsh plugin --profile desktop add <本目录绝对路径>`；
2. 在 profile 的 `package.json` 里把包名加入顶层 `dsh.profile.bundles`（安装命令不会替你加）；
3. 刷新 GUI（或重启 DSH）；标签出现后，在 kiln 仓库里打开会话即可看到 Flow。

## 已知边界

- 只读；不写 issue、不提交。
- 每次打开视图 = 1 次 `graph` + N 次 `path`（N = issue 数，上限 80，并发 4）。
- 关系词表按 kiln 0.1.x 的内置词表硬编码在 `client.js` 的 `GROUPS` 里；等 kiln 支持
  `.kilnconfig.jsonc` 配置 `relations` 后改成读配置。
- Flow 布局是初稿，Triage / Genealogy 尚未实现。
