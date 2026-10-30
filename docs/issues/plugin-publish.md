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
