# plugin-publish — 把 dsh-kiln 发布到 GitHub：打包形态与分发方式

## 问题

dsh-kiln 现在只是这台机器上的一个本地 bundle：

- 仓库**没有 remote**（`git remote -v` 为空），历史只在本机；
- `plugin/package.json` 里包名是 `@local/dsh-kiln`、`private: true`；
- profile `desktop` 的 `node_modules/@local/dsh-kiln` 是指回 `plugin/` 的 **junction**（开发期链接安装）。

也就是说，别人拿不到、装了也不会自动加载。要发布到 GitHub，先得回答三件事：**DSH 插件通常怎么打包、官方推荐哪种分发方式、我们这个包按官方要求还差什么。**

## 范围

- 只管 `plugin/` 这个包的发布形态：包名、`exports`/`files`、`dsh.bundle`/`dsh.client` 清单、展示元数据、版本约束、安装方式；
- 仓库本身（kiln 历史、`docs/`、`AGENTS.md`）留在原地，不做拆分；
- 本动作只调研，**不动**发布形态的代码。

## 验收

1. 官方文档（`docs/user/develop/basic/publish.zh.md`、skill 的 `references/host-plugin.md`、`references/ui-plugin.md`）里关于 bundle manifest、客户端半边、展示元数据、版本约束的**硬性要求**逐条列出；
2. 对照本包现状，标出缺什么、哪些只是"官方建议"；
3. npm / GitHub 源码 / tarball 三条分发路线的代价（账号、构建、pnpm 授权、升级路径、子目录）说清楚；
4. 给出可验证的落地路径，留给 `hypothesize` 选型。

## 收集：官方文档怎么说（2026-10-30，master）

来源三份，都是 DSH 仓库里的官方文档：

- 打包与安装：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md>
- bundle 清单、展示元数据、Host 导出形式：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md>
- 客户端半边：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset/skills/cordis-plugin-development/references/ui-plugin.md>

### 1. 两个概念，两种 manifest

- **组合包（bundle）**是附带一个配置层的 npm 包，`package.json` 声明 `dsh.bundle`，回答"这个包贡献什么"（一个 patch 文件）；
- **profile** 是 `$DSH_HOME/profiles/<name>` 下描述可启动组合的目录，声明 `dsh.profile`，回答"由哪些 bundle 按什么顺序组成"。
- 原文：**"没有东西同时是两者。"** 我们发布的是前者，仓库不是 profile。

### 2. 一个 bundle 至少三样

```
package.json     # dsh.bundle.patch → ./cordis.patch.yml
cordis.patch.yml # insert 行，按**包名**引用这个包
index.js         # patch 行引用的插件入口
```

官方特别解释了为什么按包名而不是相对路径：**"这样 Node 的模块解析才能找到已安装的代码"**。Host-only bundle **不需要依赖、安装脚本或构建工具**。

### 3. 客户端半边是另一份清单

```json
"dsh": { "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-conversation"] } }
```

- 必须有 `./client` 导出；浏览器产物在 `window.__ModuleLoader__.load({ id, factory })` 里注册一个懒工厂，**`id` 等于包名**；
- `React` 从浏览器模块表 `require('react')` 拿，不重复安装、不走 CDN；
- 非基线的运行时 import 要写进 `dsh.client.external`；
- 编译型源码要用部署自带的 Client 构建工具产出这个格式——**手写 JS 直接满足契约就不用构建**（官方模板 `templates/decoration/client.js` 与我们的 `plugin/lib/client.js` 是同一个形状）。

### 4. 展示元数据是硬要求，不是可选项

host-plugin.md 的清单要求：插件管理器与设置页**在不激活插件的情况下**读取标题、描述、图标：

- `locale/en.json` + `locale/zh.json`，各含 `meta.title` / `meta.description`，不能留模板文案；英文标签用句子式大小写；
- 图标 SVG/PNG/JPEG/WebP、**≤256 KiB、必须在包内**（绝对路径、URL、跳出包的软链会被拒）；可用 `exports["./icon"]` 或 `package.json` 顶层 `icon`；
- `files` 要同时覆盖 patch、locale、icon 和每个运行时文件，**每次加模块/资源都要改**；
- 明确写了：**打包/发布按 `files` 过滤，本地目录链接安装不过滤**——"本地能跑"不代表"打包后能用"；
- 缺字段会回退到 `package.json` 的 `name`/`description`，缺图用默认图，但那是 fallback，不算合规。

### 5. 版本约束

`engines.dsh` 用 SemVer 范围声明支持的 DSH 版本（例：`"engines": { "dsh": ">=0.2.0 <0.3.0" }`）；没写就退而检查 `@deepseek-ai/dsh*` 的 peer 依赖范围。安装和 profile 启动都会拒绝不满足的包。

### 6. 三条分发路线（publish.zh.md 明写）

| 路线 | 命令 | 官方说明 |
| --- | --- | --- |
| npm | `pnpm publish` → `dsh plugin add your-package` | **发布前构建好 `lib/`**，装的是预构建代码 |
| tarball | `pnpm pack` → `dsh plugin add ./hello-plugin-0.1.0.tgz` | 同样无需构建授权 |
| git | `dsh plugin add github:you/hello-plugin` | 拉的是**源码不是产物**，没有任何环节跑 `build`；`prepare` 例外，但 pnpm ≥10 默认拒绝运行，要在 profile 的 `pnpm-workspace.yaml` 写 `allowBuilds`，官方建议锁 commit |
| 本地 checkout | `dsh plugin add ./hello-plugin` | 链接安装，保留自己的 `node_modules`（我们现在的 junction 就是这条路的开发形态） |

另外两条官方事实：

- 需要与宿主共享实例的 dsh 包应同时写进 `peerDependencies` 与 `devDependencies`；第三方依赖放 `dependencies`；
- **官方没有插件注册中心或市场**——发布 DSH 插件就是发布 npm 包（社区目录是第三方维护的，不构成官方渠道）。

### 7. 本包对照表

| 项 | 官方要求 | 现状 | 缺口 |
| --- | --- | --- | --- |
| 包名 | 可公开发布，且与 client id 一致 | `@local/dsh-kiln`、`private: true` | 换公开名、去 private |
| `exports` | `.` 与 `./client` | 两者都有 | ✓ |
| `files` | 覆盖 patch + 全部运行时文件 + locale/icon | `["lib", "cordis.patch.yml"]` | 无 locale/icon |
| locale 元数据 | `meta.title`/`meta.description`，中英 | 无 | 缺 |
| 图标 | ≤256 KiB、包内 | 无 | 缺 |
| `engines.dsh` | SemVer 范围 | 无 | 缺 |
| client id | 等于包名 | `@local/dsh-kiln`；pele 分块自注册 `@local/dsh-kiln/client.pele.js` | 改名要同步 `client.js`、`client.pele.js` 与用例 |
| 构建 | 无构建则无需授权 | 纯 ESM，无 tsc/tsdown，无 `prepare` | ✓ 反而省事：git 安装不触发 build 授权 |
| 运行时依赖 | 共享包进 peerDependencies | 只有 `node:` 内置与 `require('react')`，无 `dependencies` | ✓ |
| 体积 | — | `npm pack --dry-run`：12 文件，压缩 343 KB / 解包 957 KB（其中 `client.pele.js` 710 KB） | 可接受 |

打包内容（`npm pack --dry-run --json`）：`README.md`（npm 自动带上）、`package.json`、`cordis.patch.yml`、`lib/` 下 9 个文件；`test/` 被 `files` 排除，符合预期。

### 8. 还没验的

1. **非 junction 安装**（从 tgz/npm 装出的真实目录）时，`./client` 与 `./client.pele.js` 的相对加载是否照常——现在 profile 是 junction 指回源码树，路径解析可能被链接掩盖；
2. 新包名下的 client id 一致性（含 pele 分块的自注册 id）与现有 82 + 58 用例；
3. `dsh-kiln` 在 npm registry 上是 404（未注册），但 404 不等于一定能注册（保留字、命名策略未查）；
4. GitHub 账号、仓库名、是否走 Release 附件：都还没定。

### 9. 复现命令

```powershell
git remote -v                                  # 空：还没有远端
cd plugin; npm pack --dry-run --json --cache .npm-tmp
Get-ChildItem "$env:DSH_PROFILE_DIR\node_modules\@local" | Format-List Name, LinkType, Target
```

## 假设与选型（2026-10-30）

### 要定的三件事

1. **主渠道**：npm、GitHub Release、git 源码、本地克隆，选哪条主推；
2. **公开身份**：包名、版本号、`engines.dsh`、展示元数据、LICENSE；
3. **仓库形态**：包留在 `plugin/`，还是为 git 安装把它挪到仓库根。

### 补充证据（本轮实测）

- 本机 dsh CLI 可用：`...\resources\runtime\cli\bin\dsh.cmd` → **0.2.1-rc.5**，可以起临时 profile 做安装验证；
- DSH 自带 pnpm **11.28.5**（`resources\runtime\primary-runtime\dependencies\pnpm`）——`github:owner/repo#path:/subdir` 语法从 pnpm 9 起支持，可用；
- 本机**没有 `gh`**，`npm whoami` → `ENEEDAUTH`：建仓库与 npm 发布都需要用户账号，apply 只能做到"打包 + 本地安装验证"。

### 五条路线

| 路线 | 用户命令 | 我们付出 | 更新 | 官方口径 | 风险 |
| --- | --- | --- | --- | --- | --- |
| **A** npm 无 scope `dsh-kiln` | `dsh plugin --profile web add dsh-kiln` | npm 账号 + `publish` | `add dsh-kiln@latest` | 官方首推：装的是预构建代码 | 名字被抢（现在 registry 404 = 未占用）；publish 24h 后不可撤回 |
| **B** npm scope `@jackiehank/dsh-kiln` | `... add @jackiehank/dsh-kiln` | 同上 | 同上 | 同上 | 命令更长；scope 天然防撞 |
| **C** GitHub Release tgz | `... add ./dsh-kiln-1.0.0.tgz` | tag + Release 附件 | 手动下载 | 官方列出的 tarball 路线，无需构建授权 | 用户得先拿到文件 |
| **D** git 源码 | `... add github:jackiehank/dsh-kiln#path:/plugin` | 仓库公开 | 重跑 `add` 换 ref/版本 | 拉源码不跑 build；我们无 `prepare`，不触发 `allowBuilds` | 依赖 pnpm ≥9 的 `path:` 语法；每次都 clone 整个含历史的仓库 |
| **E** 本地克隆 | `... add ./dsh-kiln/plugin` | 无 | `git pull` | 官方"本地 checkout"路线 | 要本机 Node/pnpm，普通用户门槛最高 |

### 选型

- **主渠道 A**：无 scope 的 `dsh-kiln`。一条命令、可被检索、天然带版本；registry 404 说明名字空着。
  - 不用 B 的理由：包名同时是 loader 的 id，越长越容易抄错；身份信息已经在仓库 URL 和 README 里。B 保留为"名字被抢/被拒"的退路。
- **同时做 C**：GitHub 打 tag `v1.0.0` + Release 附 `pnpm pack` 的 tgz。它不依赖 npm 账号，是离线备份，也是 README 里给"不想走 npm"的人的路。
- **D 只写进 README 的备用一节**，不主推：语法要 pnpm ≥9，且仓库带完整 issue 历史，clone 比装包重。
- **否决 E 作主渠道**：要本机 Node/pnpm 环境，普通用户门槛最高；开发者本来就会 clone。

### 公开身份

- 包名 **`dsh-kiln`**，版本 **1.0.0**：第一次公开把版本号归整，`0.13.0` 属于内部迭代号；client id 与包名绑定，这次改完就固定。
- `engines.dsh`: **`>=0.2.0 <0.3.0`**（本机 0.2.1-rc.5 在范围内；与官方示例同款范围）。
- `repository`（带 `directory: "plugin"`）/ `homepage` / `bugs` / `keywords`（`dsh`、`dsh-plugin`、`kiln`、`git`）。
- **LICENSE**（MIT，放 `plugin/`；npm 自动收录，`files` 不用列）。
- 展示元数据：`locale/en.json`、`locale/zh.json`（`meta.title` / `meta.description`）、`icon.svg`（≤256 KiB），一并进 `exports` 与 `files`。
- `dsh.client` 保持现状；**不需要 `external`**——客户端只 `require('react')`，属于基线。

### 落地清单（留给 apply）

1. `plugin/package.json`：`name`、去掉 `private`、`version: 1.0.0`、`engines.dsh`、`repository`/`homepage`/`bugs`/`keywords`、`exports`/`files` 加 locale 与 icon；
2. `plugin/cordis.patch.yml`：行的 `name` 改成 `dsh-kiln`；
3. `plugin/lib/client.js`：`id: 'dsh-kiln'`；`plugin/lib/client.pele.js`：自注册 id 改 `dsh-kiln/client.pele.js`；
4. `plugin/test/*.mjs`：改对 id / patch 名的断言（`run.mjs` 里 Pele chunk 那条）；
5. 新增 `plugin/LICENSE`、`plugin/locale/en.json`、`plugin/locale/zh.json`、`plugin/icon.svg`；
6. `plugin/README.md`：安装段（npm 主、tgz 与 git 各一行）、兼容版本表；
7. 包名出现在注释里的地方一起改（`client.js` 头部与 `client.pele.js` 自注册注释）。

### 风险与验证顺序

1. **先本地验**：`npm pack` 出 tgz → `dsh plugin --profile kiln-check add ./dsh-kiln-1.0.0.tgz` → `dsh --profile kiln-check --dump-config` 确认层与行 → （可选）用临时 profile 起一个 web 看标签是否出现。这一步顺带回答 collect 里的"非 junction 安装能否加载 client 与 pele 分块"。
2. **公开前扫历史**：`git log -p` 里有没有本机绝对路径、令牌；`plugin/` 里有没有调试残留。
3. **外部动作**（要账号）：`npm login` + `npm publish`；建 GitHub 仓库、push、tag、Release。本机两者都没就绪，属于用户操作。

### 已知代价

- 包名只能改这一次：id 与包名绑定，以后再改会让用户的已有配置失配；
- npm publish 24h 后不可撤回（能 deprecate 不能删）；
- 仓库公开 = 全部 kiln 历史与 `docs/` 公开——这是本仓的设计（"为什么这么做"就该在历史里），不是副作用；
- git 安装路径要写 `#path:/plugin`，比 npm 长；若是为它把包挪到根，会打乱文档布局，收益不值。

### 被否决

- **把 `plugin/` 挪到仓库根**：只省掉 git 安装的 `#path:`，却让仓库根变成 npm 包（`files` 要排除 docs/AGENTS），且与本仓"issue 历史 + 文档"的重心冲突；
- **发布到社区目录/市场**：官方没有注册中心，社区目录是第三方维护的，可以以后顺手做，不进入本次验收。

### 定稿（用户 2026-10-30 决定）

上面按"身份已在仓库 URL 里"推荐了无 scope 的 `dsh-kiln`，实际采纳另一条：

- 包名 **`@jackiehank/dsh-kiln`**——与本机已发布的 `@jackiehank/sol-dsh` 同一身份，scope 天然防撞；
- 版本 **`0.14.0`**——延续内部迭代号，首个公开版本仍是 0.x。

后果不变：包名就是浏览器半的 loader id，这次定下之后不再改；安装命令比无 scope 长 15 个字符。

## 落地（2026-10-30）

### 改了什么

| 文件 | 改动 |
| --- | --- |
| `plugin/package.json` | `name` 改 `@jackiehank/dsh-kiln`、去 `private`、`version: 0.14.0`；加 `engines.dsh: >=0.2.0 <0.3.0`、`repository`（带 `directory: "plugin"`）/`homepage`/`bugs`/`keywords`、`publishConfig.access: public`；`exports`/`files` 加 `locale/*.json` 与 `icon.svg` |
| `plugin/cordis.patch.yml` | 行的 `name` 改新包名 |
| `plugin/lib/client.js` | `__ModuleLoader__.load` 的 `id` 与工厂返回的 `name` 改新包名 |
| `plugin/lib/client.pele.js` | 自注册 id 改 `@jackiehank/dsh-kiln/client.pele.js` |
| `plugin/test/{run,render}.mjs` | id 断言同步 |
| `plugin/LICENSE` | 新增 MIT |
| `plugin/locale/{en,zh}.json` | 新增 `meta.title` / `meta.description` |
| `plugin/icon.svg` | 新增原创图标（窑拱 + 三层动作线，1.1 KB，远低于 256 KiB 上限） |
| `plugin/README.md` | 标题与版本号；安装段改成 npm / tgz / git / 本地四条，并纠正"安装命令不会写 bundles"的旧说法 |
| `.gitignore` | 忽略 `.tmp-dsh-home/`、`plugin/.npm-tmp/`、`plugin/*.tgz` |

### 怎么验证的

打包 → 装进一个**真的独立 profile**（不是 junction）→ 看宿主编排与浏览器半：

```powershell
# 1) 打包（16 个文件，压缩 345 KB / 解包 957 KB）
cd plugin; npm pack --cache .npm-tmp

# 2) 用仓库内的 DSH_HOME，别碰用户 desktop profile
$env:DSH_HOME = "<repo>/.tmp-dsh-home"
dsh plugin --profile pkgcheck add <repo>/plugin/jackiehank-dsh-kiln-0.14.0.tgz
dsh --profile pkgcheck --dump-config          # 出现 "# == @jackiehank/dsh-kiln" 层与 id: dsh-kiln 行
```

结果：

1. `dsh plugin add` 真的会把包名**写进** `dsh.profile.bundles`（与官方文档一致，纠正了 README 旧说法）；
2. 装出来的 `node_modules/@jackiehank/dsh-kiln` 含 `lib/ locale/ icon.svg LICENSE cordis.patch.yml`；
3. 在 profile 里补上 `@deepseek-ai/dsh-web-app` 启动 web（`--no-open --port 55991`）后：
   - 引导清单里出现 `{"id":"@jackiehank/dsh-kiln","url":"plugins/??@jackiehank/dsh-kiln/client.js&rev=627002a4a34e",...}`；
   - 合并包 `plugins/??…dsh-kiln/client.js…` 200，内容含 `dkf-`（我们的样式前缀）；
   - **pele 分块按 loader 的解析规则取到**：`/plugins/@jackiehank/dsh-kiln/client.pele.js?rev=627002a4a34e` → 200、710 KB、含自注册 id。collect 里"非 junction 安装能否加载 client"的疑问到此关闭；
   - 宿主路由已注册：`/kiln/actions` 先回 `{"ok":false,"reason":"missing-cwd"}`，带 `cwd` 后进到真正执行（本 shell 沙箱下 `spawn EPERM`，是环境限制，desktop 里正常）。

### 还没做的（需要账号，留给用户）

- `npm publish`：本机 `npm whoami` → `ENEEDAUTH`；scoped 包要公开，`publishConfig.access: public` 已备好；
- 建 GitHub 仓库、push、打 tag `v0.14.0`、Release 附 `pnpm pack` 的 tgz：本机没有 `gh`。

### 安装后要重装

桌面上原来那套是 `@local/dsh-kiln` 的 junction。包名换了，等于换了一个插件：要把旧链接从
profile 里移除（`dsh plugin --profile desktop remove @local/dsh-kiln`，或手动删 junction 与
`dsh.profile.bundles` 里的旧项），再按新包名安装。

## 追加：暂时没有 npm 账号，改走 GitHub（2026-10-30）

上一步把 npm 当主渠道，值的前提是"能注册/登录 npm"。现在这个前提不成立，分发要改成**只用 GitHub**。

### 受影响的判断

| 原计划 | 现在 |
| --- | --- |
| npm 主渠道，`dsh plugin add @jackiehank/dsh-kiln` | **降级为"以后有账号再说"**；主渠道换成 Release 里的 tgz |
| Release tgz 当兜底 | **升为主渠道**，并且已端到端验证过 |
| git 源码当备用 | 仍备用；语法可用但本机无法验证（见下） |

包名、版本号、client id 全都不用动——`@jackiehank/dsh-kiln` 这个名字在 git 安装下同样成立，
scope 不依赖 registry。

### 两条 GitHub 安装路径的证据

1. **tgz → profile：已验证**。`npm pack` 出的 16 个文件装进独立 profile 后，`--dump-config`
   出现整层，浏览器半的 `client.js` 与 `client.pele.js` 都按 rev 取到（上一步的记录）。
2. **`github:owner/repo#path:/plugin`：本机验不了，但不是语法问题**。

```powershell
dsh plugin --profile gh add "git+file:///C:/…/dsh-kiln#path:/plugin"
# [ERR_PNPM_GIT_RESOLVE_FAILED] git ls-remote … spawn EPERM
```

pnpm 是 Node 程序，spawn git 时用**命名管道**收输出；DSH 的沙箱不允许打开命名管道，所以
`git ls-remote` 直接 EPERM。同一台机器上 `kiln`（Go，匿名管道）调 git 完全正常——**是沙箱限制，
不是 pnpm 或语法的问题**。验证只能等仓库公开后在普通终端里做第一条真实安装。

### 顺带确认的两件事

- 仓库不大：`git count-objects -vH` → 1.03 MiB 松散 + 1.81 MiB 打包，git 安装的 clone 成本可接受；
- `npm publish --dry-run` 能过（16 文件 / 345 KB / public），只是本机 `npm whoami` → `ENEEDAUTH`；
  另外 `~/.npmrc` 指向 `registry.npmmirror.com`（只读镜像），将来发布必须显式 `--registry
  https://registry.npmjs.org`。

### 结论

主渠道 = **GitHub Release 附 tgz**；备用 = **git 源码**（`#path:/plugin`）与本地 checkout；npm
等有账号再补，不改包名、不改版本。

## 落地：GitHub 作为唯一分发渠道（2026-10-30）

### 改了什么

| 文件 | 改动 |
| --- | --- |
| `plugin/README.md` | 安装段按 GitHub 重排：Release 的 tgz 主渠道、`github:…#path:/plugin` 次之、本地 checkout 开发用；npm 降为"以后有账号再多一条最短命令" |
| `.github/workflows/release.yml` | 新增：tag `v*` 触发 → 校验 tag 与 `package.json` 一致 → `npm test` → `npm pack` → 校验 tgz 里有 `client.js` / `client.pele.js` / `locale/zh.json` / `cordis.patch.yml` → `gh release create` 附 tgz |

包名 `@jackiehank/dsh-kiln`、版本 `0.14.0`、client id 都没动——换分发渠道不改身份。

### 发布流程（需要账号，三步）

```powershell
# 1) GitHub 建空仓 jackiehank/dsh-kiln，然后：
git remote add origin https://github.com/jackiehank/dsh-kiln.git
git push -u origin main

# 2) 打 tag（workflow 只认 v* 且必须与 package.json 的 0.14.0 一致）
git tag v0.14.0; git push origin v0.14.0

# 3) workflow 自动：跑用例 → 打包 → 建 Release 并附 jackiehank-dsh-kiln-0.14.0.tgz
```

用户侧就一条：从 Releases 下 tgz，`dsh plugin --profile web add ./jackiehank-dsh-kiln-0.14.0.tgz`。

### 验证边界

- **workflow 本身没在 CI 里跑过**（本机没有 `gh`、也还没有远端）。它的每一步都在本机单独等价跑过：
  `npm test`（82 + 58 全过）、`npm pack`（16 文件）、`tar -tf` 核对四个关键文件、版本一致性脚本；
  YAML 在第一次推 tag 时才是真验证。
- **git 安装路径仍待验**：本机沙箱拦 pnpm 的 `git ls-remote`，只能等仓库公开后在普通终端跑一次
  `dsh plugin --profile x add github:jackiehank/dsh-kiln#path:/plugin`。
- **公开前扫过历史**：`git log -p` 匹配常见令牌格式（`sk-`、`ghp_`、`AKIA`、私钥头）无命中；
  仓库会连同全部 issue 历史与 `docs/` 一起公开，这是本仓的设计。

## 追加：tag 推了却没有 Release（2026-10-30）

**原因不是 workflow 写错，是它没被登记**：GitHub 只从**默认分支**发现 workflow 文件。

时间线：

1. `main` 推到 `f551420`——当时 `.github/workflows/` 还不存在；
2. 随后推 tag `v0.14.0` → `59d30f3`，这个提交里**有** workflow，但只在 tag 上，`main` 上没有。

API 证据（公开仓，无需登录）：

| 查询 | 结果 |
| --- | --- |
| `GET /repos/jackiehank/dsh-kiln/actions/workflows` | `total_count: 0`——一个 workflow 都没注册 |
| `GET …/contents/.github/workflows?ref=v0.14.0` | `release.yml` 在（1305 B） |
| `GET …/branches/main` | `f551420`（不含 workflow） |
| `GET …/actions/runs` | `total_count: 0` |
| `GET …/releases` | `[]` |

所以既没有 run、也没有报错、更没有 Release——tag 事件根本没有匹配到任何已注册的 workflow。

### 修了什么

1. **`main` 必须先带 workflow**：推完 main，GitHub 才会登记，tag 事件才有人接；
2. workflow 加 **`workflow_dispatch`（带 `tag` 输入）**：已经在远端、但当时没登记的 tag 不必删了重打——推完 main 后从 Actions 页手动跑一次，输入 `v0.14.0` 即可；
3. 补**根 `LICENSE`**（MIT），GitHub 才会显示 license 徽章（`plugin/LICENSE` 只作用于 npm 包）。

### 正确的发布顺序（以后照这个）

```powershell
git push origin main                        # 先让默认分支带上 workflow
git tag v0.14.1; git push origin v0.14.1    # 再打 tag，事件才会有人接
```

已经有 tag 的情况：推完 main → Actions → release → Run workflow → 填 `v0.14.0`。

**教训**：先推代码、后打 tag；tag 是"触发器"，不是"存档"——触发器所在的那一版代码里必须有 workflow。

## 追加：run 起来了，但 Release 还是没有（2026-10-30）

### 先修掉的：Node 20 弃用

日志提示 `actions/checkout@v4` 与 `actions/setup-node@v4` 被强制跑在 Node 24。两个 action 都已有
`v7` 移动 tag（`GET /repos/actions/checkout/tags` 与 `…/setup-node/tags` 核对过），workflow 里
升到 `@v7`。这是**警告不是失败**，不影响功能，但会一直刷。

### 还没解释的：`/releases` 仍是空

公开 API 的 `GET /repos/jackiehank/dsh-kiln/releases` 返回 `[]`，说明那次 run 没有走到
`gh release create`。最可能的原因是按仓库默认权限被降级：

- 2023 年后新建的个人仓库，Actions 默认令牌是 **Read repository contents and packages permissions**；
- workflow 里写的 `permissions: contents: write` 只是**请求**，仓库上限是只读时会被降级；
- 于是最后一步 `gh release create` 拿到只读令牌 → 403，Release 建不出来。

自查/修法（二选一）：

1. Settings → Actions → General → Workflow permissions → 选 **Read and write permissions** → 保存，再跑一次；
2. 或者把 run 里失败那一步的日志贴出来，按真实的错误码改。

`GET /actions/workflows` 在**未登录**时返回 `total_count: 0`（与 run 实际存在矛盾），说明这个
端点在匿名访问下不可信——以后查 run 状态要看 Actions 页面或带 token 的 API。

## 结论（2026-10-30）

**v0.14.0 已经发布，这条 issue 的目标达成。**

- Release：<https://github.com/jackiehank/dsh-kiln/releases/tag/v0.14.0>
- 资产：`jackiehank-dsh-kiln-0.14.0.tgz`，**345,542 B**，`sha256:8cd63b3b059fcbe9c380a9be2db4a5d09fdfd51cfd69d899fc93f2232568d824`，上传者 `github-actions[bot]`，发布时间 11:35:03Z。
- 工作流：`release.yml`（tag 触发 + 手动 dispatch），步骤是版本一致性 → `npm test` → `npm pack` → 四文件自检 → `gh release create`。

### 我猜错的一件事，记下来

我在上一节把"Release 不存在"归因为**新仓库只读令牌导致 `gh release create` 403**。这个归因是错的：
Release 在 11:35:03 就发布了，我查 `/releases` 的时候还没到时候（匿名 API 有延迟/缓存），
我却拿"空数组"当证据去推原因。

教训与上一次同类：**先确认真实状态，再解释原因**。匿名 API 的空结果是弱证据，页面/带 token 的
API 才是准的；两次失误（workflows 列表的空、releases 的空）都踩在这上面。

### 仍由用户验证的一步

我这个 shell 下载不了 Release 资产：TLS 客户端拿不到凭证（`SEC_E_NO_CREDENTIALS`，与 `git push`
失败同因），`curl` / `Invoke-WebRequest` 都卡在校验阶段。所以"从 Release 下载的包能装"这一步要在
普通终端里跑一次：

```powershell
dsh plugin --profile web add ./jackiehank-dsh-kiln-0.14.0.tgz
```

我们已经在同样打包方式的 tgz 上端到端验证过（装进独立 profile、`--dump-config` 出层、浏览器半的
`client.js` 与 `client.pele.js` 按 rev 取到），所以这里只差"下载通道"这一环。

### 现状小结

| 渠道 | 状态 |
| --- | --- |
| GitHub Release 的 tgz | **在用**（主渠道） |
| `github:jackiehank/dsh-kiln#path:/plugin` | 语法就绪，待公开后第一条真实安装验证（沙箱拦 pnpm 的 git） |
| 本地 checkout | 开发用，已在用（desktop 是旧 `@local/dsh-kiln` 的 junction） |
| npm | 无账号，随时可补，不改包名/版本 |







