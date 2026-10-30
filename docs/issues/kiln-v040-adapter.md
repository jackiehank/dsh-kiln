# kiln-v040-adapter — v0.4.0 默认开缓存、内部重构与 jsonl 新字段，插件哪些假设变了

- **domain**：integration
- **关联**：relates-to `kiln-v030-adapter`（上一次适配）、relates-to `kiln-input-streams`（第 2 步详情等这一轮判断）、relates-to `kiln-many-issues`（80 条上限与窗口的方向）

## 问题

kiln 于 2026-10-30 发布 v0.4.0（v0.3.0 之后 95 个提交）。CLI 面声称只有两条新命令
（`kiln cache gc` / `kiln cache clear`）和 `action log --jsonl` 的纯增量字段，无破坏性变更；但
**默认行为变了**——提交记录缓存默认开启，第一次读会写 `.git/kiln/`，之后的热读从「每次起 git 进程」
变成「解层 + 快照」。插件当前的设计数字与假设都建立在 v0.3.0 的冷读上：

- `/kiln/flow` 快照 = `graph --json` + 批量 `path`，DEFAULT_MAX_ISSUES=80；
- 时间线 = `action log --jsonl` 全量流；issue 列表 = 客户端折叠这条流；
- `kiln-v030-adapter` 与 `kiln-input-streams` 里记的「首行 ~0.1s」「list 111ms」都是冷读价；
- 插件只读、零残留：现在 `kiln` 自己会在 `.git/kiln` 留缓存（不是插件写的，但接手时要交代）。

需要先答清楚：v0.4.0 到底改了什么、性能提升在插件的调用形态（每次请求起一个新进程）里还剩多少、
`action log --jsonl` 的新字段是否让「快照外 issue 的详情/refs」不必再等上游。

## 非目标

- 本轮只收集与测量，不改插件代码；
- 不替用户决定是否清缓存、不把 `cache gc/clear` 接进 UI（是否接下一轮定）；
- 不做 100k 合成仓的独立复测（上游 `docs/perf-profile.md` 有 1k/10k/100k 全套；本轮以两个真仓为准，
  需要时再补）。

## 验收

- v0.3.0 → v0.4.0 的提交按「破坏性 / 性能 / 新字段 / 纯内部」分类，列出与插件相关的条目；
- 插件实际用到的命令（`graph --json`、批量 `path --json`、`action log --jsonl`、`list --json`、
  `list --search`、`action list --json`）在新旧二进制上输出逐字节一致，或在文档里写清差异；
- 两个真仓的冷/热读数字（本仓、`~/kiln`），以及缓存占用与首个请求的代价；
- 结论：插件哪些假设失效、哪些不受影响、`/kiln/actions` 与时间线要不要动版本声明。
