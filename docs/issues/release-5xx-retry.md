# Release 步骤撞上 HTTP 500 就整条挂掉：要重试、要幂等

## 背景

`v0.15.1` 打 tag 后，`release.yml` 的最后一步失败：

```
gh release create "$TAG" plugin/jackiehank-dsh-kiln-*.tgz --title "$TAG" --generate-notes
env: TAG: v0.15.1
HTTP 500 (https://api.github.com/repos/jackiehank/dsh-kiln/releases)
```

仓库里因此**没有 v0.15.1 的 Release**（`/releases` 只有 v0.14.0、v0.15.0），
但 tag 与代码都在——也就是「发版卡在最后一步」，资产没上去。

## 现状（读 workflow 得到的）

`.github/workflows/release.yml` 最后一步是一条命令，没有保护：

- **不重试**：`gh release create` 收到 5xx（GitHub 侧瞬时错误）就直接失败，整条工作流红掉；
- **不幂等**：重跑时如果 Release 已经建好（例如上一次建好但上传资产失败、或者 5xx 其实已经建成功），
  `create` 会因「已存在」失败（422），重跑照样红；
- `--generate-notes` 是**服务端**生成发行说明的一次额外调用，也是这条链上最容易 500 的可选环节，
  却没有退路。

也就是说：CLI 单条命令当成一次性的、必然成功的操作来写，对远端不稳定的假设太强。

## 目标

1. 创建 Release 遇到 5xx 时**退避重试**（3 次）；
2. 整个步骤**幂等**：Release 已存在就只 `upload --clobber` 资产，重跑不再红；
3. `--generate-notes` 失败时退回**固定说明**（`Full Changelog` + tag 链接）再试一次；
4. 在 workflow 里写清这条链路的假设，别再回到「一条命令梭哈」。

## 边界

- 只改 `.github/workflows/release.yml` 的最后一步；不动版本校验、用例、打包与自检；
- 不引入第三方 action（保持只用 `gh`，与既有风格一致）；
- 已经发出去的 `v0.14.0` / `v0.15.0` 不动。

## 落地（apply）：一条命令换成「幂等 + 重试 + 退路」

`.github/workflows/release.yml` 的最后一步（`:49`）从一行命令换成 30 行脚本，逻辑四条：

1. **先查**：`gh release view "$TAG"` 成功 → 只 `gh release upload --clobber` 覆盖资产，`exit 0`
   （重跑、或上次建好但上传失败，都不会再红）；
2. **再建**：`gh release create … --generate-notes`，失败就 `sleep 10/20/30` 退避重试，最多 3 次；
3. **每次失败后再查一眼**：5xx 有可能是「已经建好了但返回错误」，这时补传资产并 `exit 0`；
4. **最后一招**：`--generate-notes` 是链上唯一由服务端生成内容的可选调用（也是最可能 500 的环节），
   三次都失败就换成固定说明 `**Full Changelog**: …/commits/$TAG` 再建一次。

资产路径改成 `for f in plugin/jackiehank-dsh-kiln-*.tgz; do ASSET="$f"; break; done`——原来是把通配符
直接交给 `gh`，只有一个文件时能用，多一个打包残留就会传错/传多。

**没能本地验证**：这个沙箱里 bash 起不来（Git Bash 报 `couldn't create signal pipe, Win32 error 5`，
WSL 访问被拒），所以脚本没有 lint 过；YAML 缩进与语法按块标量规则逐行核过。真正的验证是下一次
`workflow_dispatch` 重跑 `v0.15.1`。

**重跑方式**（`v0.15.1` 的 Release 还缺着）：push main 之后，Actions → release → Run workflow →
tag 填 `v0.15.1`。这条路径用的是**默认分支上的 workflow 定义**（带重试），代码仍 checkout 到
`v0.15.1` 那个 tag，所以打包内容不会变。
