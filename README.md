# dsh-kiln

DSH（DeepSeek Harness）与 [kiln](https://github.com/jackiehank/kiln) 的接入仓。

**状态：刚建立。** 具体形态（DSH 插件 / skill / 命令 / 其他）由第一个 issue 决定，见
[`AGENTS.md`](AGENTS.md) §1。

## 这个仓库怎么管 issue

用 kiln：每个动作是一次带 `issue:` + `action:` trailer 的 git 提交，没有数据库、没有索引，
`git clone` 到哪历史就跟到哪。

```powershell
kiln status          # 全库概览
kiln path <issue>    # 某条 issue 的研究路径
kiln check           # 语义完整性
```

约定、流程和踩过的坑都写在 [`AGENTS.md`](AGENTS.md)；issue 的解释与验收写在
[`docs/issues/`](docs/issues/)。

## 依赖

- [kiln](https://github.com/jackiehank/kiln) v0.1.1+：`go install github.com/jackiehank/kiln/cmd/kiln@latest`
- git

## 目录

```text
AGENTS.md            agent 工作约定（先读这个）
.kilnconfig.jsonc    kiln 配置：动作词表 / VCS / worktree 模式
docs/issues/         一条 issue 一个 Markdown：问题、证据、结论、落地位置
```
