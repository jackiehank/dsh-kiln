# 发 0.15.0：版本号、README 与 tag

## 背景

`v0.14.0` 的 Release 是本仓第一次发版，资产 `jackiehank-dsh-kiln-0.14.0.tgz`（345,542 B）。
之后又有两条 issue 落地，都还没进任何 Release：

- `kiln-relation-direction`：聚焦态从「箭头 + 关系名」改成方向分桶的一句短语（父/子、阻塞了/被阻塞、
  由…引发/引发了…），多父不再丢；
- `kiln-head-width`：页头在窄宽下不再压叠，焦点 chip 的 `×` 永远完整，刷新位置固定，
  搜索框让位（30% / 72px），刷新在最窄处降成 `↻`。

根 README 也已经按这两条改写（`plugin-readme`）。用户要截图、要发版，所以现在把版本号、tag、
Release 对齐。

## 目标

1. `plugin/package.json` 版本 `0.14.0` → **`0.15.0`**（新增功能、无破坏性：minor）。
2. 三处引用旧版本号的地方同步：根 README 安装段的 tgz 文件名、`plugin/README.md` 的版本行与
   安装段的 tgz 文件名。
3. `plugin/README.md` 的版本行补一句 0.15.0 的两项新能力（方向分桶、页头分档收缩）。
4. 打 tag **`v0.15.0`**，由 `.github/workflows/release.yml` 产出 Release 与 tgz。

## 验收

- `plugin/package.json` 的 version 与 tag 去掉 `v` 后完全一致（workflow 第 31 步会校验，不一致直接失败）；
- `npm test --prefix plugin` 仍 **86 + 63**；
- `npm pack` 产物名是 `jackiehank-dsh-kiln-0.15.0.tgz`，内容仍是 16 个文件；
- Release 出在 <https://github.com/jackiehank/dsh-kiln/releases/tag/v0.15.0>，资产同上。

## 边界

- 不动依赖与 `engines.dsh`；不改 `v0.14.0` 已发布的 Release 内容；
- 不发布 npm（仍无账号）；tag 由本地打、推送后由 Actions 建 Release。
