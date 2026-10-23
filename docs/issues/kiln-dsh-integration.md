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
