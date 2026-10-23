# issue 文档

一 issue 一个 Markdown 文件，文件名 = issue id（小写 kebab-case），如 `dsh-issue-graph.md`。

- **提交里的 trailer 是事实来源**（动作、关系、时间）；这里写解释、证据与验收。
- **不写状态**（进行中 / 已完成）——状态由 `kiln path` / `kiln check` 从提交解析。
- 建议结构：问题与目标 / 约束 / 证据与数字 / 方案与取舍 / 结论与落地 / 已知代价与复现。
- 提交动作时把本文件写进 `--target docs/issues/<issue>.md`；只改文档的动作可用
  `--only docs/issues/<issue>.md` 精确提交。
