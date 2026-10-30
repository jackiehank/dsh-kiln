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
