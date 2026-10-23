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
