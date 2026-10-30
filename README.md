# dsh-kiln

DSH（DeepSeek Harness）与 [kiln](https://github.com/jackiehank/kiln) 的接入仓。

**形态：DSH profile bundle（插件）。** 一个只读的 kiln 镜头：把 Git 里 `issue:` / `action:` trailer
投影成会话内的三页视图——时间线、issue、关系（全局 / 聚焦），三页共享一个焦点 issue。
不写 trailer、不造提交、不装 git 钩子。
代码在 `plugin/`，形态结论见[第一份 issue 文档](docs/issues/kiln-dsh-integration.md)。
插件包名 `@jackiehank/dsh-kiln`，安装（npm / GitHub Release 的 tgz / 源码 / 本地目录）见
[`plugin/README.md`](plugin/README.md#安装)。

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

- [kiln](https://github.com/jackiehank/kiln) **v0.3.0+**（建议 v0.4.0+：热读 30–40ms）：
  `go install github.com/jackiehank/kiln/cmd/kiln@latest`
  （取数 v0.2.0+ 即可；搜索要 v0.2.1+ 的 `rank` / `hit.total` / `hit.date`；动作流要 v0.3.0+ 的
  `action log --jsonl`。开发版可用 `DSH_KILN_BIN=<kiln 可执行文件>` 指向本地构建，旧版会明确报错）
- git

## 目录

```text
AGENTS.md            agent 工作约定（先读这个）
.kilnconfig.jsonc    kiln 配置：动作词表 / VCS / worktree 模式
docs/issues/         一条 issue 一个 Markdown：问题、证据、结论、落地位置
plugin/              DSH 插件本体：Host 半 lib/index.js + 浏览器半 lib/client.js
```
