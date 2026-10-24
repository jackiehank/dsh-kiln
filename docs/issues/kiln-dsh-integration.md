# kiln 除 CLI 外如何与 DSH 交互

## 背景

kiln 是 git trailer 驱动的问题追踪器：一个提交是 kiln 动作，当且仅当它同时带 `issue:` 与
`action:`；状态全部由提交信息解析，没有数据库、没有服务端。本机版本 v0.1.1，二进制在 PATH 上。

当前 dsh-kiln 仓库对 kiln 的用法只有一种：**AGENTS.md 约定 + agent 在 shell 里手动跑 CLI**。
`kiln status / path / check / graph / do` 都能通过 shell 工具调用，`--json` 面齐全
（`status`、`list`、`check`、`graph`、`path`、`show` 都支持 `--json`）。

这套用法的摩擦点：

1. **只能靠约定**：agent 忘记 `issue:`/`action:` 时，kiln 只会把提交当成普通提交，没有拦截；
2. **DSH 侧看不见**：issue 图只存在于提交历史里，会话界面、插件、工具都读不到；
3. **重复劳动**：接手时每次都要跑 `kiln path` + 读 `docs/issues/*.md`，没有结构化入口。

## 问题

kiln 能否以 **CLI 之外**的形态接入 DSH？具体是哪些载体、各自边界在哪、哪条路成本最低？

候选形态（待 collect 后确认）：

- **技能（skill）**：SKILL.md 教 agent 用 CLI，减少遗忘与误用；
- **插件（Cordis bundle）**：注册工具（query/check/do），可挂 git 钩子强制 trailer，可出 Web GUI 视图；
- **MCP server**：把 kiln 的 JSON 面包装成 `mcp__kiln__*` 工具，供多个 agent/客户端共享；
- **钩子（hook）**：`prepare-commit-msg` 之类，在 `git commit` 时补 `issue:`/`action:` 或校验；
- **AGENTS.md 指令**：现状，只算约定，不构成机制。

## 约束

- kiln 只发布 CLI（v0.1.1），**不改 kiln 源码**；封装层不得改变 trailer 语义与 issue 状态解析；
- DSH 扩展只能落在既有接缝上：profile 插件/bundle（`~/.dsh/profiles/<name>`）、MCP client
  （`@deepseek-ai/dsh-mcp-client`）、技能（SKILL.md / skill provider）、AGENTS.md；
- 离线可用，不引入托管服务与网络依赖；
- issue 文档是解释，trailer 是事实；封装层不能制造第二份状态。

## 范围

本 issue 只做**形态调研与对照**（collect），不做实现。实现另开 issue。

## 验收标准

- 列出 DSH 侧可用的接入载体及其契约（插件 / 技能 / MCP / 钩子 / 指令），说明各自能做什么、不能做什么；
- 至少 3 个 kiln 同类工具的既有 DSH 形态，说明其设计取舍；
- 对每种形态给出 kiln 的适配判断（成本、风险、需要 kiln 侧补什么）；
- 产出可进入 `hypothesize` 的候选清单。

## 待验证

- DSH 插件能否在 agent 执行 `git commit` 时可靠地补 trailer（懒安装 hook 的可行性）；
- MCP 形态下写路径怎么归属：MCP 工具代跑 `git commit`，还是只生成提交信息交由 shell 执行；
- 多个 agent 并发提交时，trailer 状态是否仍可线性解析（kiln 的 `check` 是否够用）。

## 调研记录（collect）

证据来源：DSH 官方 MCP client 文档、DSH 插件目录与若干插件仓库、git-bug / ditz / git-issue
的公开文档。以下均为外部资料与实测，未做结论。

### 1. DSH 侧可用的接入载体

| 载体 | 契约 | 能做什么 | 局限 |
| --- | --- | --- | --- |
| AGENTS.md 指令 | 会话自动加载（本仓已实测：进 dsh-kiln 操作时会话注入 "Additional instructions from: dsh-kiln\AGENTS.md"） | 把流程、纪律写成 agent 默认上下文 | 纯文本，无强制力 |
| 技能（SKILL.md） | 技能目录 + `skill` 工具按需加载；插件可充当 skill provider（`list()` 提供技能列表） | 把 kiln 用法做成按需加载的手册，减少常驻上下文 | 仍靠 agent 自觉调用 |
| 插件（Cordis bundle） | profile 的 `package.json` 里 `dsh.profile.bundles`，叠加 `cordis.yml` 条目（`id` / `name` / `config`）；DSH 架构口号是 "Everything is a plugin" | 注册工具、Web UI、钩子、skill provider | 需跟随 DSH 版本维护；发布要过插件市场/安装器 |
| MCP server | `@deepseek-ai/dsh-mcp-client`：每个 server 一条配置（`serverName` 1–32 字符 `[A-Za-z0-9_-]`、`transport` = `stdio` 或 `streamable-http`）；工具以 `mcp__<serverName>__<rawName>` 注册，跨重启稳定 | 把 kiln 的 JSON 面直接变成模型可调工具，可被多个 DSH/Codex 客户端共用 | MCP 只提供工具调用，**管不到 agent 的提交流程**；写操作通常要挂人工审批 |
| 钩子 | 插件可在 agent 直接 `git commit` 时懒安装 `prepare-commit-msg` 钩子并追加 trailer（`dsh-co-authored-by` 插件的做法） | 拦截提交、补 `issue:`/`action:` 或拒绝缺 trailer 的提交 | 依赖 git 钩子生效时机；agent 绕过（`--no-verify`、直接写 ref）时失效 |

参考：
- [dsh-mcp-client README（官方）](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)
- [dsh-co-authored-by 插件（懒安装 prepare-commit-msg 加 trailer）](https://deepseekplugin.org/plugins/shelken-dsh-co-authored-by)
- [dsh-doctor（把"技能提供方"当作可诊断对象）](https://dsh-hub.cc/plugins/louisyeaaah/dsh-doctor?lang=en)

### 2. kiln 同类工具及其现有 DSH 形态

| 工具 | 存储形态 | 自身形态 | 在 DSH 中的形态 | 备注 |
| --- | --- | --- | --- | --- |
| git-bug | issue 作为 git 对象存 refs，离线、可 push/pull | CLI + TUI + Web UI + 托管桥（GitHub/GitLab/Jira/Launchpad） | **MCP server**：[git-bug-broker](https://github.com/JovianIce/git-bug-broker)（多 agent 并发 file/label/comment/close，规则校验） | 与 kiln 最像：数据全在 git 里，无托管服务 |
| ditz | `bugs.yaml` 等文件进版本库 | Ruby CLI（init/add/close） | 未发现 DSH 封装，只能 CLI 直调 | 文档时代的设计，靠人遵守 |
| git-issue | issue 存 `issues/xx/` 文本文件，评论存 commit（`gi comment mark`），可独立 issues 仓库 | shell CLI | 未发现 DSH 封装 | 提交信息与 issue 关联弱 |
| Linear | 托管服务 | Web/API | **MCP server**：[dsh-linear-mcp](https://glama.ai/mcp/servers/arucil/dsh-linear-mcp)（为 DSH 写的 stdio server，覆盖 issue/子 issue/关系/评论） | 托管形态的标准答案 |
| GitHub | 托管服务 | Web/API | MCP（`@modelcontextprotocol/server-github`）+ 插件市场的 issue 类插件（`dsh-issue-tracker`、`dsh-project-j4agent`，写操作需人工审批） | 插件形态把 issue 工具做进 DSH 原生工具表 |
| 通用工作流 | — | — | **技能**：`dsh-skill-pack` 的 `to-tickets`（对话 → spec → issue tracker） | 技能形态解决"怎么产出 issue" |
| kiln（本仓） | commit trailer | CLI v0.1.1 | 无公开封装；本仓只有 AGENTS.md 约定 | 差距：无工具、无视图、无拦截 |

参考：
- [git-bug README](https://raw.githubusercontent.com/git-bug/git-bug/master/README.md)
- [ditz（RubyGems）](https://rubygems.org/gems/ditz)
- [git-issue README](https://github.com/dspinellis/git-issue/blob/67aacad35888b4c51e2d7be35c86fef137874f12/README.md)
- [DSH 插件目录（issue-tracker 检索）](https://deepseekharnessai.com/zh/?q=issue-tracker)

### 3. 可借鉴的设计

- **词汇表校验前移**：git-bug-broker 在写入层强制"必须是 `area/` 与 `kind/` 各一个标签、defect/chore 必须带
  What / Done when 段落"，拒绝时一次列出所有问题。kiln 的 `check` 是**事后**检查（start/terminal/关系/
  未知 trailer），没有写入层拦截——这是封装层最值得补的缺口。
- **提交时补 trailer**：`dsh-co-authored-by` 在 agent 直接 `git commit` 时懒安装 `prepare-commit-msg`
  并追加署名 trailer，说明 DSH 插件确实能介入提交流程。kiln 的 `issue:`/`action:` 同样可以在钩子里补
  （例如插件记住"当前 issue 与动作"），或在缺失时拒绝。
- **读写分离**：托管 tracker 的 MCP 普遍把写操作标成需人工审批。kiln 的 `commit` 是"改工作区 + 造提交"，
  更不适合交给 MCP 自动执行。

### 4. 初步判断（待 hypothesize 验证，不是结论）

- **查询面最适合 MCP**：kiln 的 `status/list/check/graph/path/show --json` 是纯读，包成 `mcp__kiln__*`
  只读工具成本最低，收益是跨 agent/跨客户端共享 issue 图；
- **写面不宜走 MCP**：kiln 的写等于创建提交，必须与工作区改动同源；MCP 代跑 `git commit` 会与 agent
  的 shell 改动脱节，更可能落在"插件钩子补/验 trailer + agent 继续用 shell 跑 `kiln commit`"；
- **技能是低保真起点**：解决"记得用"，不解决"强制执行"；作为过渡可以，不能当机制；
- **GUI 视图成本最高**：需要 DSH Web 插件与 HMR，收益（看 issue 图）是否值得要看实际需求。

### 5. 未决问题

- DSH 侧是否真的需要可视化（`kiln path --shortstat` 的输出已足够人读？）；
- 是否需要给 kiln 本身补"提交信息校验入口"（例如 `--validate-file <path>` 供钩子复用）；
- `worktree: on` 下多 agent 并发提交，trailer 状态是否仍线性可解析；
- dsh-kiln 的定位：只做接入仓，还是最终发布成 DSH 插件 / MCP server（发布物形态决定目录结构）。

## 假设（hypothesize）：插件优先，GUI 为中心，不侵入提交流程

**假设**：kiln 与 DSH 的集成做成一个 **DSH 插件**，核心交付是 **Web GUI**——项目级 issue 全景 +
单 issue 全过程时间线；kiln 的 CLI 继续服务 agent，插件只读、只呈现，不接管 git。

**价值判断（来自用户）**：

- GUI 能让人快速掌握“整个项目有哪些 issue、各自走到哪一步”，也能看单个 issue 从 ask 到结论的
  全过程——这是 CLI 的 `kiln path` 给不了的浏览体验；
- kiln 只是给 agent 和人类用户增加某些能力，**不是替代 git**：装了 kiln 而不用完全没问题，不强制；
- 因此“用 `prepare-commit-msg` 钩子强制补 trailer”这条**出局**——不侵入 `git commit` 流程。

**对 collect 排序的修正**：collect 里按成本排序，把只读 MCP 排第一、GUI 排最后；用户按“人读项目”
的价值排序，把 GUI 排第一。排序依据不同，结论就不同——这一步的差异值得记下来，避免下次又按成本
默认选 MCP。

**方案对比**：

| 形态 | 能否满足“人看全景 + 单 issue 全过程” | 是否侵入 git | 成本 | 结论 |
| --- | --- | --- | --- | --- |
| 插件 + Web GUI | 是，原生视图与路由 | 否 | 中高（学 DSH 插件/UI 契约） | **采纳** |
| MCP 只读 | 部分：有数据、无界面，还要 agent 转述 | 否 | 低 | 可作插件的可选数据面，或后续独立 |
| 技能 | 否：只是提示 agent 用 CLI | 否 | 低 | 过渡，不是机制 |
| 提交钩子 | 否：不产生任何视图 | 是（拦截提交） | 低 | **否决**（与“非强制”相悖） |

**边界与不做**：

- 不改 kiln 源码（本 issue 内）；插件只读，不写 trailer、不造提交；
- 不装 git 钩子，不做任何“强制 kiln”的机制；
- 未安装 kiln 的仓库要能降级：插件显示“未检测到 kiln / 无 issue”，不报错、不阻塞。

**风险与待验证**：

- DSH Web 插件能否定义一级导航与自定义视图路由、数据加载与刷新（需查插件 API、HMR 与 settings 挂载）；
- 数据来源：插件内直接跑 `kiln --json` 子进程，还是解析 `.git` 提交（若解析，等于复刻 kiln 语义，不可取）；
- 大仓库/多 issue 的性能与增量刷新；
- kiln `--json` 字段的版本稳定性（v0.1.1 起步，字段变了插件就坏）；
- 发布形态：本地 bundle，还是进插件市场。

**验收（交给后续 apply）**：

- DSH Web 中可见 issue 列表：id、状态（进行中/完成）、domain、关系；
- 点进单个 issue 可见时间线：动作序列、标题、涉及文件与 diff 入口；
- 无 kiln 或空仓库显示空态，不报错。

## 调研记录（collect 2）：DSH 可视化插件一般怎么做

结论先行：DSH 插件几乎都是「**Host 半 + 浏览器半**」——Host 半是 Cordis 插件（Node），负责数据、工具、
RPC、设置命名空间；浏览器半是一个 client module（React 或纯 DOM），由宿主扫进
`window.__DSH_BOOT__`，挂到某个 **slot** 上。可视化 = 选对 slot + 做对这半。

### 1. 形态分类

| 形态 | 挂载点 | 数据来源 | 对 kiln 的适用度 | 代表 |
| --- | --- | --- | --- | --- |
| 设置卡片 | `settings.plugin.item`（键控 slot），Host 半用 `ctx.settings.installSection()` 建命名空间 | 宿主 RPC / settings scope | 只适合放配置（kiln 路径、仓库根、只读开关），不适合大数据浏览 | [cookbook: 新增设置卡片](https://dshfind.com/zh/docs/cookbook/adding-a-settings-card) |
| 整页面板 | 左栏 `sidebar.panellist` 入口 + 中央 `main` 键控槽位切页 | 宿主 RPC（remote methods） | **最贴合**：issue 全景、单 issue 时间线 | [dsh-skill-mcp-panel](https://www.npmjs.com/package/dsh-skill-mcp-panel) v2.1+ |
| 声明式卡片 | 插件注册 `render_ui` 工具，agent 调用后由 client 解释器渲染卡片 | agent 生成 | 适合“会话里画一张 issue 摘要卡”，不适合固定浏览器 | [dsh-intelligent-ui](https://github.com/an-an-618/dsh-intelligent-ui) |
| 宿主路由 + 自建页面 | 插件向 `dsh-host-webserver` 注册 HTTP 前缀路由 | 插件自己的服务 | 适合复用现成 Web 实现，或用 iframe 嵌外部 UI | 通用模式；[VS Code 插件](https://github.com/Cdown1/deepseek-harness-vscode) 就是 iframe 嵌 `dsh web` |
| 独立外部 UI | 不挂 DSH | `kiln --json` | 零适配成本，可作兜底 | git-bug 自带 web UI |

### 2. 整页面板的实际骨架（以 dsh-skill-mcp-panel v2.3.5 为例）

它的 `package.json` 把两半都声明清楚：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-api-gateway",
               "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar"]
  }
},
"exports": { ".": "./lib/index.js", "./client": "./lib/client.js" }
```

- **Host 半**（`lib/index.js`）：在 `cordis.patch.yml` 里注册，注册工具/RPC/设置命名空间；
- **浏览器半**（`lib/client.js`）：宿主扫描 `dsh.client`，把 bundle 组合进 `window.__DSH_BOOT__`，
  由 `/plugins` 路由按 revision 提供；改完由 `dsh-client-hmr` 经 SSE `/plugins/events` 热替换
  （[client-modules 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/client-modules.zh.md)）；
- **页面**：左栏一行入口（`sidebar.panellist`）+ 点开把中央主区切到 `main` 键控槽位，和宿主自带
  「插件」页同一套槽位机制，左上角「← 返回会话」；
- **数据**：Host 侧注册 RPC（typert remote methods），浏览器侧调用。宿主与浏览器各有一份方法清单，
  必须同步——该插件 changelog 里就有“浏览器束清单漏登记导致面板点不开”的修复（#51）；
- **安装**：`dsh plugin --profile web add <tarball|npm 包名|github:owner/repo>`；peer 声明 DSH 版本范围
  （`>=0.2.0-rc.1 <0.3.0-0`），不符时宿主拒绝加载并打印豁免命令。

### 3. 数据通路选项（对 kiln）

| 通路 | 做法 | 优点 | 风险 |
| --- | --- | --- | --- |
| Host RPC + 子进程 | Host 半 spawn `kiln --json`，结果经 remote method 给浏览器 | 复用 kiln 解析，最忠实 | 要处理仓库路径、错误、缓存与刷新 |
| 宿主 HTTP 路由 | 插件注册 `/kiln/...` 返回 JSON，浏览器直接 fetch | 简单、无 RPC 清单维护 | 同源/鉴权需自建，路由随宿主版本 |
| 浏览器直读 `.git` | 前端自己解析提交 | 无宿主依赖 | 等于复刻 kiln 语义，**不可取** |
| 外部服务 | 独立小服务输出 JSON/HTML，DSH 只 iframe | 与 DSH 解耦 | 多一个进程，失去 DSH 原生感 |

### 4. 成本与版本风险

- **纯 DOM 可行**：dsh-plugin-kit 的“纯前端 DOM 面板（React 只承担卡片外壳与展开状态），无构建步骤”
  证明浏览器半不一定要重型构建；但 Host 半仍然要写；
- **slot / 协议 / peer 版本随 DSH 演进**：skill-mcp-panel 为 0.1.x → 0.2.x 反复适配（图标导出改名、
  typert 协议钉版本、peer 上界），说明插件必须钉 peer 范围并准备跟版；
- **开发体验**：只有 `pnpm run dev:web` 在场时 HMR 才能免刷新热替换，否则重建后刷新页面；
- **i18n**：`dsh-client-locale` 提供本地化注入，中文界面需要按它的契约写。

### 5. 对目标形态的映射

- **全景 + 单 issue 时间线** = 一个整页面板（`sidebar.panellist` 入口 + `main` 页面），数据走 Host RPC
  调 `kiln status/list/path --json`；
- **设置卡片**只放配置（仓库根、kiln 可执行文件路径、自动刷新开关）；
- **声明式 `render_ui`** 只适合让 agent 在会话里画摘要卡，不是主界面；
- **外部 UI** 作为兜底：若插件 API 不满足，静态导出 + 独立页面。

### 6. 留给 hypothesize 的问题

- 整页面板 vs 设置卡片（倾向整页面板：符合“人看项目”的浏览诉求）；
- 数据通路选 Host RPC 还是自带 HTTP 路由；
- 要不要像 skill-mcp-panel 那样附带 `dsh-panel` 式伴生命令（kiln 已有 CLI，价值不大）；
- peer 版本策略：只支持当前 DSH 版本，还是兼容多版本。

## 假设（hypothesize 2）：插件形态＝Git 历史的只读镜头，核心视图是“思维线程工作台”

来源：2026-10-23 晚与 DeepSeek 网页版的讨论（<https://chat.deepseek.com/share/dzfn71rutrtqw6ee9l>）。
本节提炼其中与插件形态直接相关的内容，作为对上一条假设（e6e35f0“插件优先、GUI 为中心”）的收敛。

### 继承 kiln 的三条“放弃”

1. **不维护独立状态**：视图是 Git 历史的纯投影，不引入 SQLite / KV / 缓存库；
2. **不发明新工作流**：不内置“待办 / 进行中 / 完成”列——列 = 对 trailer 组合的实时查询；
3. **不增加认知负担**：不提供表单、不做按钮改 issue，写路径始终是 `git commit`。

自检标准：拔掉插件后，kiln 的提交历史与约定完全不受影响，没有任何数据需要迁移。

### 架构定位（其中的 DSH 说法待验证）

讨论把 DSH 扩展面分为 **Session / Agent / Capability** 三层，主张插件只落在 Capability 层：

- 只读观察者：不挂 `agent/pre-step`、`agent/request` 这类决策插桩（那是给“接管决策”的插件用的）；
- 通过 `ctx.tools` 注册只读工具（如 `kiln_issues`），返回结构化 canonical JSON；
- UI 从同一份 canonical value 派生（讨论提到 `output.render`），UI 不解析散文、不重算状态。

（“Session / Agent / Capability 三层”与 `output.render` 来自外部讨论，本仓尚未核实；进 apply 前
要用官方文档验证。）

### 可视化形态

- **三种阅读模式共享同一份 trailer 数据**：
  - 工单模式（Triage）：一行摘要——issue ID、最近动作、执行者、时间、commit 短哈希；不推断优先级；
  - 项目模式（Flow）：时间轴 / 依赖链，`depends-on` 渲染为链接；
  - 知识模式（Genealogy）：单个 issue 的动作序列展开为可折叠的论证链。
- **信息密度分层**：默认一行，Enter 展开动作链，再展开 diff 摘要；展开内容实时读 Git，不做“刷新按钮”；
- **并行视图 = 时间轴多轨**（类似 `git log --graph`），不是看板多列；轨道之间显示交叉（一个 issue
  的结论成为另一个的假设输入）；
- **最小核心**：先做“单 issue 轨迹视图”（动作类型、作者、时间、commit 摘要），三重身份自然叠加，
  再考虑多 issue 分组；
- 格式不合约定的提交：**诚实降级**显示原始 trailer，不静默修正。

### 关注与关系

- 关注集合**不落盘**：默认“最近提交的 issue”，也允许用户临时手动指定；
- 相关 issue 按 relation 的强度并列展示，呈现“思维如何在 issue 之间跳跃”：
  `part-of`（最强有向）> `block` 阻塞 > `causes` 影响 > `related`（无向）。

### 主动拒绝的诱惑

- 拒绝“快速操作”（标记完成、拖拽改状态）——状态只在 commit trailer 里变；
- 拒绝常驻侧栏 / 看板——按需召唤、用完即走，不争夺注意力；
- 拒绝配置中心——用户要改的只是 trailer 词表文件，插件读取即可；
- 拒绝任务管理器化：不做逾期、停滞警告、完成率；issue 长期悬置不是失败。

### 对上一条假设的修正

上一版（e6e35f0）说“插件优先、GUI 为中心、人看全景与全过程”；这一版把形态收紧为：

- 主视图从“issue 列表”改为“**线程工作台**”：最后动作 + 时间距离是第一信息，回答“我上次想到哪了”；
- 明确**只读、无状态、无迁移**；
- 从“看板式全景”改为“时间轴多轨 + 单 issue 论证链”；**看板形态被明确排除**（卡片暗示实体，
  而 kiln 的 issue 是“历史中被反复标注的线索”）。

### 验收（apply 阶段）

- 拔掉插件，仓库无任何残留状态；
- 单 issue 视图能按时间完整重放动作链（类型 / 作者 / 时间 / commit）；
- 多 issue 视图能并置展示关系，并区分关系强度；
- 无 kiln / 无 issue / 格式不合约定时诚实降级。

### 风险与待验证

- “Session / Agent / Capability 三层”与 `output.render` 是否为 DSH 真实契约；
- canonical JSON 是否等于工具的 canonical output（与 dsh-mcp-client 的 canonical value 是否同源）；
- `git log --trailers` 在大仓库的性能，是否需要按 issue 增量读取；
- `worktree: on` 时多 worktree 的提交如何聚合到同一视图；
- 中文 i18n 与 slot 注册方式（见 collect 2）。

## 假设（hypothesize 3）：可视化收敛为“两种形态 × 三种阅读模式”的组合

### 两种形态的定义

- **形态 A：issue 为主体（行视图）**——一行一个 issue，行内是该 issue 的 **action 序列**
  （按时间排布的动作节点条），行首是 issue ID 与“最后动作 + 距离上次动作多久”；
- **形态 B：relation 为主体（关系视图）**——issue 是节点、relation 是边。边按 rank 分型：
  `part-of`（最强有向，实线）、`block` 阻塞（红色）、`causes` 影响（最弱有向，虚线）、
  `related`（无向，灰色）。

两者不是二选一的两个产品，而是**同一份数据的两个尺度**：A 展开“一条线程内部发生了什么”，
B 展开“线程之间如何互相牵动”。三种阅读模式 = 在这两个尺度上不同的默认取景与展开深度。

### 对应矩阵

| 模式 | 默认形态 | A 的展开深度 | B 的用法 | 回答的问题 |
| --- | --- | --- | --- | --- |
| Triage（工单） | A（压缩行） | 只到“最近一步”：ID、最后动作、作者、相对时间；动作条折叠成小点带 | 仅做**行内徽标**（⛔ 被阻塞、part-of 父项）与筛选（只看关注 / 只看被阻塞） | 现在该看哪条线程？ |
| Flow（项目） | A 的时间轴变体（轨道） | 行 = 轨道，横轴 = 时间，节点 = 动作；同一时段多条轨道并置 | 作为**布局与叠加**：轨道按 part-of 层级 + block 拓扑排序；轨道间画关系边；环做 SCC 收缩 | 这些线程如何并行、在哪交叉？ |
| Genealogy（知识） | A 的纵深展开（单 issue） | 选中 issue 纵向展开全部 action，逐步 = 论证步骤（问题→假设→实验→结论） | 作为**邻接面板**：该 issue 的一跳邻居（part-of 父级、causes 来源、blocks 下游），悬停/点击可跳转 | 这个结论是怎么推出来的、受谁影响？ |

一句话：**A 是三模式的骨架，B 是 Flow 的主布局、Triage 的注脚、Genealogy 的邻接页**。

### 关键设计点

- 三种模式共享同一份 trailer 投影；切换模式只是换 lens，不重新取数（除 B 的布局计算）；
- **A 的动作条有密度上限**：默认只画最近 N 个节点（N≈8），更早的折叠成“…+k”，点开才向 Git
  增量读取；
- **B 不假设有向无环**：kiln 的 relation 允许成环（环的设计草案是“从薄弱处切入”）。关系视图用
  **SCC 收缩**——环内节点聚成一个簇，簇内按 rank 着色，环边标出并高亮最弱的一环边
  （`causes` < `block` < `part-of`）作为观察入口；只做提示，不提供“解环”动作；
- **关注集合 = 焦点视图**：默认“最近提交的 issue”，可临时手动指定（不落盘）。B 默认只画
  焦点 issue 与其一跳强关系邻居，A 按关注集合过滤；
- **“思维跳跃”的呈现**：选中节点时，沿 Git 时间顺序高亮 relation 边序列（一个线程的结论成为
  另一个线程的假设输入），不生成新数据；
- 边界：B 的布局（轨道排序、层级）是现值计算，不写回仓库；拔掉插件无残留。

### DSH 界面落位（待 apply 验证）

- 主区 = A 视图（列表 / 轨道 / 纵深三态共享一个组件）；
- 右栏或浮层 = B 的局部视图（选中 issue 的一跳邻居）；
- 顶部一个 lens 切换（Triage / Flow / Genealogy）+ 一个“关系视图”开关；
- 不设常驻侧栏，不设写操作。

### 验收补充

- 三种模式下同一 issue 的 action 链顺序与内容一致；
- Flow 视图能显示跨轨道关系边，环被正确收缩；
- Genealogy 的邻接面板只显示一跳，不索引全仓；
- 切换 lens 复用同一份 canonical 数据，不产生重复读取风暴。

### 遗留问题

- SCC 的展示：簇内边与入/出边是否需要簇级聚合；
- 焦点集合很大（>50 issue）时 A 的渲染与 B 的布局成本；
- “薄弱处”提示是否越过了“只呈现不判断”的边界（倾向：只高亮最弱边，不写建议文案）。

## 假设（hypothesize 4）：Flow 不是全仓视图，而是“以焦点 issue 为核心的关系子图”

修正上一条假设中 Flow =“A 的时间轴变体、全仓多轨”的说法：Flow **默认只围绕一个焦点 issue 展开**，
不展示所有 issue。

### 焦点与分层取景

- **焦点默认 = 最近一次提交所属的 issue**（沿用“关注集合不落盘”的规则）；可点击任意节点或搜索切换焦点；
- 按关系强度分层，**强关联先全部展开，弱关联折叠待展开**：
  - 焦点自身；
  - 第一圈（强关联）：`part-of`（归属/父子）与 `block`（阻塞）——改变线程位置或推进顺序的关系；
  - 第二圈（弱关联）：`causes`（影响）与 `related`（无向）——线索性关系，默认折叠成“+3 弱关联”一行；
  - 二跳只在用户点开某个外层节点时展开，且**只沿强关联继续**；
- 节点内容 = 迷你 action 轨迹条（最近 N 个动作节点，复用 A 的组件），不是卡片；
- 布局：以焦点为中心的**同心分层**（焦点内圈、强关联中圈、弱关联外圈），边按 rank 分型
  （`part-of` 实线、`block` 红、`causes` 虚、`related` 灰无向）；不画全仓时间轴；
- **切换焦点 = 子图重根**，不重新取数（仍是同一份 trailer 投影）；
- 规模上限：默认渲染节点数有上限（如 50），超出时提示“按需再展开”，不自动扩散。

### 与另两种模式的关系

- Triage 仍是压缩行列表，但每行可点进 Flow 并以该 issue 为焦点；
- Genealogy 的邻接面板与 Flow 共用“一跳”数据结构，区别是 Genealogy 纵向展开论证链、Flow 展开关系图；
- 三模式共享焦点：任一模式里切换焦点，其余模式跟随（焦点只在内存中，不落盘）。

### 验收补充

- Flow 默认只画焦点子图；焦点切换即时重根且不重取数据；
- 强关联全部展开、弱关联默认折叠且可展开；
- 子图规模超过上限时不自动扩散。

### 遗留问题

- 强/弱划分是否可配置（某些项目可能把 `causes` 视为强关系）。倾向：默认 `part-of`/`block` = 强、
  `causes`/`related` = 弱，lens 可临时调整阈值（不落盘）；
- 同心分层 vs 力导引布局的取舍（同心更可解释，力导引更省空间）；
- 焦点切换后的返回栈是否算“状态”（倾向：内存内导航栈，不持久化）。

## 假设（hypothesize 5）：强弱由 kiln 的槽/rank 定义；Flow 改为行式布局

### 1. 强弱不是硬编码，是 `RelationSet` 的 slot + rank（读源码）

- 关系词表 = `model.RelationSet`：**槽（slot）是结构层**，引擎只认 `blocking` 一个布尔；
  **名字是名字层**，每个名字挂在某个槽下，带槽内 `rank`（1 最弱，越大越强）；
- 同一 `(target, slot)` 只保留**rank 最大**的一条（平手取后写），这是 `foldRelations` 的语义；
- 有向名字自动注册反名（同槽同 rank），`blocks`/`part-of` 在 `ordering` 槽（blocking=true，
  必须无环），`relates-to`/`caused-by`/`supersedes` 在 `lineage` 槽（非阻塞）；
- 默认词表的强度序：
  - `ordering`：`blocks`(1) < `part-of`(2)——`part-of` 蕴含 `blocks`（母等全部子）；
  - `lineage`：`relates-to`(1) < `caused-by`(2) < `supersedes`(3)，`causes` 是 `caused-by` 的反名；
  - 别名：`derived-from` → `caused-by`，`spawns` → `causes`；
- **口述校正**：此前说“最弱是 causes、还有一般无向的 related”——源码里无向名是 `relates-to`，
  且 `relates-to`(1) 比 `caused-by`(2) 更弱；`causes` 是 `caused-by` 的反名，不是独立名字。

### 2. 配置能写强弱吗——设计已定，当前版本还没解析

- `relation-revision` 定过配置草图：`relations` 段下 `slots`（blocking）+ `names`（slot/rank/directed）
  + `aliases`，即“名字自由、角色映射可配”；
- 但 `internal/config/config.go` 的 `file` 结构体目前只有 `actions` / `vcs` / `worktree`，且
  `dec.DisallowUnknownFields()` ——**在 `.kilnconfig.jsonc` 里写 `relations` 会报
  `配置错误: unknown field "relations"`**（docs/config-compat.md 记为“未实现的段”，plumbing 待
  relations-impl）。所以 **0.x 当前版本配置写不了强弱**；
- 插件对策：
  - 内置一份与源码一致的默认词表（slot/rank/blocking/directed/别名）；
  - 启动时**容错读取** `.kilnconfig.jsonc`：有 `relations` 段就按它建词表（前向兼容），没有/解析失败
    就回退默认，并在界面上标注“词表=默认”；
  - 不把任何关系名硬编码进 UI 逻辑——排序、着色、缩进都从词表推导。

### 3. Flow 布局改为行式（不是同心圆/力导引）

- **第一行 = 焦点 issue**（含迷你 action 条）；
- 其后**按关系强度从强到弱往下排**：先 `ordering` 槽（`part-of` 优先于 `blocks`），再 `lineage` 槽
  （槽内按 rank 降序：`supersedes` → `caused-by` → `relates-to`），同 rank 按时间；
- **`part-of` 用缩进 + 折叠**：
  - 焦点是母（`has-part`）→ 子行缩进在焦点下，可折叠；
  - 焦点是子（`part-of`）→ 焦点行不能下移，行首用“↑ part-of: 母”面包屑表示，点击切成新焦点；
  - 更深一层的 `has-part` 继续缩进，整支可折叠；
- 关系行内容：issue ID、最近动作、时间距离、边名与方向（声明名 `→` / 入边反名 `←`）、子项计数；
- **弱关联默认折叠**成一行“+N 弱关联”，点开展开为独立行；
- 未知关系名或坏 trailer：原样降级显示，不猜；
- **焦点切换临时、不落盘**（确认）：返回栈只在内存里，刷新即回默认焦点（最近提交的 issue）。

### 验收补充

- 词表从源码默认值构建时，排序与 `kiln path --json` 的边方向一致；
- 焦点行固定第一行；`part-of` 缩进/折叠正确（母→子缩进、子→母面包屑）；
- 在 `.kilnconfig.jsonc` 写入 `relations` 的仓库里，插件不崩溃：能读则用，读不了回退默认并标注。

### 遗留

- 等 kiln 落地 `relations` 配置段后，把“容错读取”升级为“显式 schema 校验 + 词表热更新”；
- 跨槽排序（`ordering` vs `lineage`）在引擎层没有定义强弱，插件当前约定“ordering 先于 lineage”，
  是否允许用户调这个槽序（不落盘）待定。

## 实现草稿（in progress）

形态：**profile bundle**（Host 半 + Client 半），代码在仓库内 `plugin/`，可直接装进 DSH desktop profile 做本地迭代。

- **Host 半** `plugin/lib/index.js`：注册 `webServer` 精确路由 `GET /kiln/flow?cwd=<仓库根>`；
  每次请求同步执行 `kiln graph --json` + 逐 issue `kiln path <id> --json`（宿主进程内 `spawn`），
  把 graph 与各 issue 动作历史压成 Flow 视图数据（焦点、行、动作条、关系行、强弱、缩进层级）返回 JSON。
  连接信任校验失败返回 401；`cwd` 缺 `.kilnconfig.jsonc` 时返回明确提示而非空图。
- **Client 半** `plugin/lib/client.js`：`inject: ["slots","sessions"]`，在 `conversation.view` 插槽注册
  `{ id: "kiln", order: 30, label: () => "kiln", inject: (sessionId) => ({ cwd }) }`，与内建
  `chat`(order 0) / `trajectory`(order 10) 同排；组件从会话 cwd 拉 `/kiln/flow`，渲染焦点行（最近提交 issue）、
  迷你动作条、关系行（ordering 槽先、再 lineage 槽按 rank 降序）、`part-of` 缩进/面包屑、弱关联折叠。
- **安装方式**（不通过 pnpm）：profile 的 `node_modules/@local/dsh-kiln` 是指向本仓库 `plugin/` 的
  junction，并在 profile `package.json` 的 `dsh.profile.bundles` 追加 `@local/dsh-kiln`；
  DSH 的 profile 监听与客户端模块扫描会按 bundle 加载两半。
- **已验证**：刷新后标签出现在“对话 / 轨迹 / 上下文”末尾；非 kiln 工作区里显示
  “Flow 暂不可用（缺 .kilnconfig.jsonc）”；`/kiln/flow` 未认证探测为 401（未知路径 404），宿主路由已注册。
- **待验证**：在 dsh-kiln 工作区内的数据正确性（焦点选取、排序、缩进、折叠）、Triage/Genealogy 两种模式、
  `worktree on` 下的聚合、i18n 与错误路径呈现。
