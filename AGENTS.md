# AGENTS.md — dsh-kiln

本文件是接手 dsh-kiln 的 agent 的工作约定：**这个仓库用 kiln 管理 issue**，所有功能、缺陷、调研
都由带 `issue:` + `action:` 的提交记录。代码在 diff 里，**为什么这么做只能在提交历史里找到**。

- kiln 手册：本机 `~/kiln/README.md`（v0.1.1，已发布）；上游 <https://github.com/jackiehank/kiln>
- issue 文档：[`docs/issues/`](docs/issues/)
- 配置：[`.kilnconfig.jsonc`](.kilnconfig.jsonc)

---

## 1. 项目定位

dsh-kiln 是 **DSH（DeepSeek Harness）× kiln** 的接入仓。仓库刚建立，**具体形态由第一个 issue
决定**（可能是 DSH 插件 / skill / 命令，或其他）。因此：

- 不预置技术栈，不为填目录写空实现；
- 第一个 issue 的 `ask` 先写清“DSH 侧缺什么、现状如何、验收标准”；
- 目录、语言、构建方式在 `hypothesize` 里比较后再定，由 `apply` 落地。

仓库的初始提交是普通 `chore:`（不带 trailer），因为它先于所有 issue——这是唯一的常规例外。

## 2. kiln 是什么（一句话）

kiln 把“问题 → 动作 → 结论”编码成 git commit 的 trailer，`kiln path <issue>` 按时间重放整条
研究路径。它不是 todo 工具：**它的产出是“为什么这么做”的可读历史**。

识别规则只有一条：**一个提交是 kiln 动作，当且仅当同时带 `issue:` 与 `action:`**。普通提交
（无 trailer）被忽略，所以杂务提交不会污染 issue 列表。

二进制：`kiln`（在 PATH 上，需 v0.1.1+）。`kiln --version` 确认。
安装：`go install github.com/jackiehank/kiln/cmd/kiln@latest`。

## 3. 配置（仓库根 `.kilnconfig.jsonc`，随仓库提交）

```jsonc
"actions": { "names": ["ask", "hypothesize", "collect", "test", "conclude", "apply"],
             "start": "ask", "terminal": ["conclude", "apply"] },
"vcs": "auto",
"worktree": "off"
```

- 词表是 kiln 的**自定义点**；改词表等于改校验规则。别为了绕开 `check` 删掉 terminal。
- `worktree: off`：单人顺序推进，允许直接在 main 提交。要并行跑多个 agent 时再改 `on`（见 §8）。
- 配置缺失时 `kiln config path` 会写一份默认配置（幂等，不覆盖已有文件）。

## 4. 核心原则

1. **功能、缺陷、调研一律走 kiln**。普通 `git commit` 只用于仓库初始化、工具配置、依赖升级
   这类与 issue 无关的杂务，且**不写** `issue:` / `action:`。
2. **一个提交 = 一个 issue 的一个动作**。两个 issue 的改动混在同一次提交里，说明该拆。
3. **issue id 用小写 kebab-case**（`dsh-issue-graph`、`issue-list-view`）。同名即同一条 issue，
   **对已有 `ask` 的 issue 再 `ask` 会被拒绝**。
4. **trailer 是事实来源**，`docs/issues/<issue>.md` 是解释与验收。文档随动作更新，但**不写状态**（§6）。
5. **标题写结论**：这一步学到了什么、落地了什么，不要写文件名。`kiln path` 里只有标题可读。
6. 中文优先：标题、文档、说明用中文；标识符与代码注释按项目语言习惯。
7. **不伪造动作**：没有改代码就 `conclude`，不要写 `apply`；做过的实验别合并成一条。

## 5. 标准流程

```text
ask → (hypothesize | collect | test)* → conclude | apply
```

中间完全自由：任意次序、可重复（同一个 `test` 出现三次很正常）。只有两端是结构——
每个 issue **至少一个 `ask`**，**最后一个动作是 `conclude` 或 `apply`**。
终点动作之后还能继续加动作，issue 会回到“进行中”，补一个终点就重新闭合；
**不要为了保持“完整”另开一个重复 issue**，只有“这是另一个问题”时才开新 issue 并用 `--relates-to` 连过去。

```powershell
# 0) 开工前
kiln status
git status --short

# 1) 开题：先写 issue 文档，只提交文档（把代码留到后面的动作）
kiln commit <issue> ask --title "<问题一句话>" --domain <domain> `
    --target docs/issues/<issue>.md --only docs/issues/<issue>.md

# 2) 中间动作：先改文件，再提交；--refs 指向证据文件
kiln commit <issue> collect --title "<收到了什么、关键数字>" --domain <domain> `
    --refs "docs/issues/<issue>.md, probe.log"

# 3) 收尾：apply = 已落地；只有结论用 conclude
kiln commit <issue> apply --title "<落地了什么、怎么验证>" --target src/foo.ts

# 4) 复核
kiln path <issue> --shortstat
kiln check
```

`kiln do` **只打印提交信息、不写文件**，不确定 trailer 排版时先用它预览。

## 6. 提交范围与 issue 文档

**`kiln commit` 默认提交当前工作区的全部改动（快照），不是“已暂存”的内容，也不需要先 `git add`。**
提交前 stdout 会打一行 `将提交 N 个文件: …`。

- 提交前先 `git status --short`，确认工作区只有本动作的改动；
- 只想提交一部分用 `--only <paths>`（逗号分隔或重复给）：`--only docs/issues/x.md`，
  未列出的文件保持未提交——这正是“先开单、再写实现”的用法；
- 空动作允许（工作区干净时 stderr 会提示“会记成空提交”），但不要习惯性空提交。

Issue 文档放 `docs/issues/<issue>.md`，一 issue 一文件，`--target` 指它。写**不随动作数变化**的内容：

- 问题/目标、约束与边界；
- 证据与数字（测了什么、多少、怎么测的）；
- 方案与取舍（为什么否决了别的）；
- 结论与落地位置（`路径:行`）；
- 已知代价、复现命令。

**不写状态**：不要 `状态: 进行中`、`✅ 已完成` 这类行。状态只有一个来源——`kiln path` /
`kiln check` 从提交里解析。手写状态迟早和它对不上（文档写着已完成、check 却报“缺少终点动作”），
等于维护两份真相。

## 7. 动作词表与用法

| action | 何时用 | 典型产物 |
| --- | --- | --- |
| `ask` | 提出问题、划范围、定验收 | `docs/issues/x.md` 开头 + 现状 |
| `hypothesize` | 比较方案，记录取舍与风险 | 方案对比 |
| `collect` | 收集证据、数据、外部资料 | 脚本、样本、外部资料 |
| `test` | 验证一个假设（可多次） | 对比结果、结论反转 |
| `conclude` | 只有结论、不落地 | 决策记录 |
| `apply` | 已落地并验证 | 代码 + 文档“落地”一节 |

一个 `test` 只回答一个问题；做三轮实验就提交三次 `test`，每次标题写这轮学到了什么。
结论被推翻时尤其要留痕——**最贵的知识是“看起来有效、后来被证伪”**。

## 8. 关系、domain 与隔离

- `part-of`（子 → 父）挂伞 issue；子 issue 的 `ask` 里就写，不要等最后补。
- `blocks` / `blocked-by` 表达先后依赖；被阻塞的先别开工。
- `relates-to` 是无方向关联；`caused-by` 记录“谁引发了谁”——这类因果最值钱。
- 关系可重复、可逗号分隔，后续动作里也能补；`--unrelate` 撤销。
- **`part-of` 不会自动设 domain**；漏 `--domain` 就进“未分类”。
- 本项目起步 domain（第一个 issue 定稿后可调整，之后只增不删）：`integration`、`tooling`、`docs`、`infra`。
- 并行 agent：配置改 `"worktree": "on"`，先 `kiln worktree new <issue>`，进区再干活；
  此时在 main 上提交会被**结构性拒绝**，`--force` 只是一次性豁免。

## 9. 校验与收尾

```powershell
git status --short          # 应为空
kiln status                 # 分类与完成情况
kiln check                  # 语义完整性
kiln list --domain=integration
kiln graph --format=ascii   # 关系图（--mermaid 出流程图文本）
```

`check` 的规则与严重级别：

- 起点：至少一个 `ask`（缺失 = ✗ `start-action`，**退出码 1**）
- 终点：最后一条是 `conclude` / `apply`（不符 = ⚠ `terminal-action`，只警告）
- 关系：每条关系的目标必须存在（⚠ `relation-target`）
- 未知的 trailer 键（⚠ `unknown-trailer`）

**只有 ✗ 让退出码非零**——“还有进行中的 issue”是正常状态，不代表仓库坏了。
`--json` 给 rule 码，stdout 只放一个 JSON 文档（`status` / `list` / `check` / `graph` / `path` /
`show` / `worktree list` 都支持）。

## 10. 实测踩坑

1. **默认快照整个工作区**：忘 `--only` 会把无关文件卷进动作（建仓时的实测：一条 `test` 动作
   顺手把 `other.txt` 吃掉了）。提交前 `git status`。
2. **空仓库不能先跑 kiln**：没有任何提交时 `kiln status` / `check` 报 `git log` 失败。
   先有初始 `chore:` 提交。
3. **`--verbose` 只属于 `check`**：`kiln status --verbose` 会警告“未知 flag”（不致命，但说明记错了）。
4. **重复 `ask` 被拒**：`拒绝: issue "x" 已经有起点动作 "ask"`，退出码 1；要继续用其他动作。
5. **回填历史 issue**：文档/代码早就有了却没有 `ask` → 先补 `ask`（此时允许），再补 `conclude`。
6. **`collect` 不是终点**：停在 `collect` 的 issue 会一直报“缺少终点动作”。
7. **没有 `--message`**：只有 `--title` 等结构 flag。改标题用 `git commit --amend` 改 `title:` 行；
   **别动 `issue:` / `action:`**，那是 kiln 认路的唯一依据。
8. **`check` 会点名不认识的 trailer 键**；发现拼错就 `git commit --amend --no-edit --trailer "domain: x"` 修正。
9. **标题与 trailer 之间必须空一行**（手写提交信息时）；`kiln do` 已处理好。

## 11. 接手顺序

1. `kiln status` / `kiln list --json`：有哪些 issue、各自停在哪一步；
2. 选一条：`kiln path <issue> --shortstat`，再读 `docs/issues/<issue>.md`；
3. 要看代码：`kiln show <issue> <n|action>` 展开该动作的完整 diff；
4. 动手前 `git status --short` 确认工作区干净；
5. 收尾按 §9。

## 12. 提交信息示例

```text
让 DSH 能读 kiln 的 issue 图

issue: dsh-issue-graph
action: apply
title: 让 DSH 能读 kiln 的 issue 图（graph --json + 无向邻域）
domain: integration
target: src/graph.ts
refs: docs/issues/dsh-issue-graph.md
scope: DSH × kiln
tags: graph, json
```
