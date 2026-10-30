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
