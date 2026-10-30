# kiln-session-cache — 重复取数的 40ms：图 / 详情 / 搜索按会话缓存，hover 预取

- **domain**：integration
- **关联**：relates-to `kiln-v040-adapter`（按视图取数落地后留下的重复取数）、relates-to `kiln-many-issues`（大仓优化只做了 Tier 0，窗口/虚拟化另开）

## 问题

`kiln-v040-adapter` 把取数改成「一个视图一条命令」之后，每一条命令都热读 42ms，于是**重复操作**
开始显形：

- 切到关系页 → 每次 `graph`（42ms / 11KB）；切走再切回又取一次；
- 聚焦一个 issue → 每次 `path`（42ms / 3.5KB）；清焦点再点回同一个 issue 又取一次；
- 搜索 → 每次查询 `list --search`（42ms），回退/重输同一个词也重跑；
- 页面刷新（F5）→ 客户端词表缓存丢失，再跑一次 `action list`（28ms），而宿主其实一直在。

这些都不是“数据变了”，只是**同一份数据被重复取**。插件是只读视图，会话内的失效模型本来就是
“刷新才更新”（动作流也只在 mount / 刷新时重读），所以这几类取数适合按会话缓存。

另有一个真实缺陷：搜索 effect 依赖 `byId`，而 `byId` 在流式期间每 50ms 换一次新 Map，
所以**流还没读完时输入搜索，请求会被反复 abort/重发**，可能一直拿不到结果。

## 做什么

1. **关系图会话缓存**：客户端按仓库缓存 `/kiln/graph` 的 payload；切页先渲染缓存、后台重取
   （stale-while-revalidate），刷新时清掉；
2. **详情会话缓存**：按 `(repo,id)` 缓存 `path` 的结果；再次聚焦同一个 issue 不再起进程；
   刷新时清掉；hover 行 120ms 后预取，点下去即开；
3. **搜索缓存**：按 `(repo,query)` 缓存结果（LRU 20），回退/重输同词 0 进程；
   并把 `byId` 改成 ref 读取，流式期间不再 abort 重发；
4. **词表宿主缓存**：宿主按 `(repo, configToken, binaryToken)` 缓存 `action list`，F5 后不再重跑；
5. **关系页页签 hover 预取**：鼠标移到「关系」页签时取一次图，点开即开。

## 非目标

- 不做列表窗口 / 虚拟化 / 色条上限（Tier 1，等有 1k+ 动作的仓再做）；
- 不做宿主首屏流缓存 N 条 / 详情 LRU（Tier 2）；
- 不动上游（`list` 的 date / limit、`action log` 游标都不等）。

## 验收

- 切到关系页两次：第二次命中缓存（页面直接可用），后台仍会更新；
- 聚焦同一 issue 两次：第二次 0 次 `kiln` 子进程，内容与第一次一致；
- 搜索同一个词两次：第二次不再发请求，结果相同；流式期间输入不再被 `byId` 变化打断；
- 刷新后：图 / 详情 / 搜索 / 词表都重新取（缓存按会话失效）；
- hover 一行 / 关系页签后立刻点开：不等 42ms（预取命中）；
- 既有 52 宿主 + 53 渲染用例全绿；新增缓存键 / LRU 的纯函数用例。

## apply（2026-10-30）：插件 0.7.0，Tier 0 五项全落地

| 位置 | 改了什么 |
| --- | --- |
| `plugin/lib/client.js` | 新增会话缓存（`graphCache` / `detailCache` / `searchCache`，键都带仓库前缀，LRU 20；`clearRepoCaches` 在刷新时清空）；详情命中缓存时不再起进程；图切页先渲染缓存再后台重取；搜索按 `(repo,query)` 回放，并把 `byId` 改成 ref 读取、从依赖里移除；行 hover 120ms 预取详情、页签 hover 预取图；普通缓存函数 `cacheKey/cacheGet/cacheSet` 挂到 `__internals` 供用例 |
| `plugin/lib/index.js` | 词表按 `(repo, configToken, binaryToken)` 缓存（LRU 16），导出 `actionsCacheKey` 供用例；命中时 `action list` 不再起进程 |
| `plugin/test/run.mjs` | 新增 3 条纯函数用例：缓存键隔离、LRU 命中挪尾/淘汰、词表缓存键随三个维度变化 |
| `plugin/README.md`、`package.json` | 版本 0.7.0；补“会话缓存”一节与“缓存 = 会话内一致视图”的边界 |

### 行为与失效

- 缓存只活一次挂载：`刷新` 按钮清 `(repo,*)` 的图 / 详情 / 搜索并重读动作流；页面重开同理；
- 详情 / 搜索 LRU 20，图按仓库 4 份；键用 NUL 分隔仓库与 id/查询，不会串仓；
- 预取只在 hover 停留 120ms 后触发（扫过列表不取整屏）；同一 `(repo,id)` 的预取与点击共用
  `detailInflight`，不会重复发；
- 搜索在流式期间不再被 `byId` 的每批新 Map 打断——查询一旦发出就跑到自己结束。

### 验证

- 宿主 **55**、渲染 **53** 用例全绿；`node --check` 覆盖 6 个文件。
- 纯函数用例覆盖：`cacheKey` 不同仓库/不同 id 不串；LRU 命中挪到末尾、超限淘汰最久未用；
  `actionsCacheKey` 对仓库 / 二进制变化换键、同输入同键。
- 预期收益（单次操作）：切回关系页 42ms → 缓存命中即渲染（后台仍更新）；二次聚焦 42ms → 0 进程；
  回退/重输同一搜索词 42ms → 0 进程；F5 后词表 28ms → 0 进程；hover 预取把首次详情的 42ms 藏到
  hover 里。

### 代价

- 会话内是“一致视图”：新提交要刷新才可见（与动作流原本的 mount 语义一致），README 已写明；
- hover 预取可能白取一次（用户没点开），代价是 42ms / 3.5KB，且 120ms 延迟已挡掉扫过；
- 搜索缓存存的是映射后的行（含 issue 引用），20 条查询的内存可忽略。
