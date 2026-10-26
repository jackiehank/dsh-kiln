# @local/dsh-kiln

DSH × kiln 的插件初稿：在会话顶部标签排（对话 / 轨迹 / 上下文）**之后**加一个 `kiln` 标签，
只读展示 kiln 仓库的 Flow 视图。

- 数据来源：宿主路由 `GET /kiln/flow?cwd=<绝对路径>&focus=<issue>`，宿主进程里跑
  `kiln graph --json` 与 `kiln path <id> --json`。
- 浏览器半不直接读文件，也不调 CLI；仓库根 = 当前会话的工作区目录。
- 视图语义：三页共享一个焦点 issue。issue 页无焦点时一行一个 issue；有焦点时读出结构——
  part-of 作母/子分组与面包屑，`blocks` → `supersedes` → `caused-by` 按强弱排，弱关联（relates-to）
  默认展开，行内带方向与关系名。关系页只有图（全局 / 聚焦）。焦点切换只在内存里，不落盘。

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
