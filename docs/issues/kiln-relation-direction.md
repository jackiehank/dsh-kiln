# 聚焦态的关系分组：把「谁对谁」写成人话，别让读者解箭头

## 背景

issue 页的聚焦态负责把焦点周围的关系读成文字（`kiln-issue-focus-page` 定下的分工：关系页只剩
图，关系名与方向集中在这一页）。数据侧是 `relatedOf`（`plugin/lib/client.js:800`），词表是
`GROUPS`（`:219`）与 `EDGE_LEGEND`（`:274`），视图是 `IssueFocusList`（`:1857`）。

今天五种关系在页面上呈现成**四套互不相同的形状**：

| 关系 | 页面上的样子 | 代码 |
| --- | --- | --- |
| `part-of`，我是子 | 单独一行面包屑 `↑ part-of: <父 id>` | `:1894` |
| `part-of`，我是父 | 分组表头 `子 issue · part-of <n>` | `:1901` |
| `blocks` / `supersedes` / `caused-by` | 表头 `<中文标签> · <词表原词> <n>`，行内前缀 `<箭头> <词表原词>` | `:1920`，`:1933` |
| `relates-to` | 表头 `弱关联 · relates-to <n>`，行内无标注 | `:1938` |

实测渲染（`kiln-many-issues` 的聚焦态，见本轮配图）：面包屑 `↑ part-of: kiln-many-issues`、
`子 issue · part-of 2`、`因果 · caused-by 1` 加一行 `← caused-by kiln-search`、
`弱关联 · relates-to 7`。

## 问题

1. **表头是标签拼接，不是句子。** `<中文标签> · <词表原词> <计数>` 把中文名和 `caused-by` 这类
   数据词并排放着，读者得自己在两个词之间建立映射；两截词说的是同一件事，却不互为解释。
2. **方向没有主语。** 行内只有相对箭头：`← caused-by`。它要读成「焦点由它引发」，但 `←` 也
   可以念成「它指向焦点」。本仓 4 条 `caused-by` 全在一条链上
   （`kiln-dsh-integration → kiln-flow-focus-ui → kiln-views-shared-focus → kiln-focus-gesture`，
   另有 `kiln-search → kiln-many-issues`），链上换一个焦点同一对 issue 的箭头就要翻面——
   **同一段文字在不同页面读法相反**，这正是要避免的。
3. **列表的说法与图例反着。** 图例写「A 引发 B」并把因果边反向绘制成「因 → 果」（`:271` 注释
   有说明），列表行的箭头却沿着数据里的名字走。两页讲同一件事，方向相反，无从对照。
4. **父与子不对称，且父只有单值。** 父走面包屑、子走分组表头，视觉上是两种东西；父还只取
   `view.parent[0]`（`:1898`），多父会被静默丢弃。本仓 `part-of` 只有 4 条、无多父，所以今天
   没暴露；**这一条是读码得出的，不是实测**。
5. **分组本该数据驱动，这里成了三份硬编码。** `GROUPS` 给 `part-of` 定义的 `label: '母 issue'`
   从来没被渲染过——part-of 绕开 `GROUPS` 走了上面两个特例分支。
6. **计数位置不统一。** 三个分组表头把计数放最后，父那条面包屑没有计数；`part-of` 的父子两侧
   连「有几个」都不对等。

## 目标与验收

- 每条关系的方向用一句完整中文说清，**不需要读者解读箭头**；行内不再出现 `→` / `←`。
- 每个分组标题能独立读懂：谁是焦点、谁是对方、关系朝哪边。至少要覆盖
  父 / 子 / 由谁引发 / 引发了谁 / 阻塞谁 / 被谁阻塞 / 取代谁 / 被谁取代。
- 多父、多因、多果全部显示，不静默丢弃。
- issue 页与关系页图例用**同一句话**表述同一事实，可互相追溯。
- 词表之外的关系名仍然不硬编码：方向与分组继续从 `INVERSE` / `GROUPS` 推导，不按关系名写 `if`。
- 现有 82 + 58 条测试继续通过；`plugin/test/render.mjs` 补结构断言：新表头文案、行内无箭头、
  多父用例、图例与表头用同一句话。

## 边界

- 只动 issue 页聚焦态的分组标题与行标注。关系页的图不动；若图例为对齐要改，在 `hypothesize`
  里单独说。
- 不动 kiln 数据、不动 `kiln graph --json` 的形状、不改强弱排序（`slot` / `rank`）。
- 不引入配置项与环境变量（沿用本仓偏好：不要求用户配置）。

## 方案（hypothesize）

四条路，判断标准只有一条：**不看箭头、不查词表能不能读懂**。

### A. 方向写进句子，主语固定为「我」（采纳）

每条关系拆成两个方向，一组一句完整的中文；`{n}` 是这一组的条数：

| 数据里的边 | 焦点在哪头 | 表头 |
| --- | --- | --- |
| `part-of`，焦点是子 | `a` | `我属于 1 个母 issue` |
| `part-of`，焦点是父 | `b` | `2 个子 issue 属于我`（超过 4 条才折叠） |
| `blocks` | `a` | `我阻塞 1 个 issue` |
| `blocks` | `b` | `1 个 issue 阻塞我` |
| `supersedes` | `a` | `我取代了 1 个 issue` |
| `supersedes` | `b` | `1 个 issue 取代了我` |
| `caused-by` | `a`（我是果） | `我由 1 个 issue 引发` |
| `caused-by` | `b`（我是因） | `我引发了 2 个 issue` |
| `relates-to` | 无向 | `7 个弱关联（无方向）` |

行内只剩 issue 行本身：**没有箭头、没有关系名**。原词（`part-of` 等）放进表头的 `data-hint`，
需要跟 kiln 文档或 CLI 对照时悬停可见，不占视觉。

方向仍从数据推导：`a === focus` 记 `out`（焦点是主语），`b === focus` 记 `in`，桶键是
`<rel>|<dir>`。句子是展示表，`if` 只认「哪个桶」，不认关系名——加一条词表外的关系时，
缺的是一行文案，不是一个分支。

### B. 只换措辞、保留箭头

`← 由它引发`。改动最小，但箭头仍在，等于把 A 的句子挤进行内；而且每个方向都要另造一套短语，
最后还是落回 A 的信息量，只是位置更挤。否决。

### C. 层级树（父在上、焦点居中、子在下）

对 `part-of` 最直观，但 `blocks` / 因果天然多对多，树装不下；焦点行也不再是第一行，和列表
「焦点钉在第一条」（`kiln-issue-focus-page`）的约定冲突。否决，只借用它的顺序感：父子两组相邻，
且不再有 crumb 这种第三种形状。

### D. 左右两列（左「来自」、右「发出」）

信息密度最高，但侧栏宽度只有约 300px，两列会把 issue id 挤到换行。否决。

## 决定（回答「待定」）

1. **方向靠语态，不靠箭头**。第一轮写成第一人称（「我属于 1 个母 issue」），保住了「同一个句子
   主语永远是焦点」，但每组标题都重复一次「我」，侧栏窄时会换行；按反馈改成不带主语的短标签
   （见文末「修订」），方向改由语态承担（`父 / 子`、`由…引发 / 引发了…`）。
2. **父子不合成一棵树，但去掉 crumb**。父、子变成同一套机制下的两个桶（`part-of|out` 与
   `part-of|in`），相邻渲染、样式一致。多父因此天然支持（旧版 `view.parent[0]` 会丢）。
3. **行内不加「父 / 因」这类短标注**。标题已经说尽；行内再标一次是同一句话重复两遍。

## 落地（apply）

代码只在 `plugin/lib/client.js`，三处：

1. `REL_SIDES`（`:230`）取代 `GROUPS`：九个方向桶，每桶一句带 `{n}` 的中文。句子是展示表，
   方向由数据判（`out` = 焦点是 `a`，`in` = 焦点是 `b`，无向边 `none`）。
2. `relatedOf`（`:817`）：按桶收邻居，删掉 `parent` / `children` 两个特例出口，改为
   `{ groups, ids }`；`part-of` 仍覆盖它蕴含的 `blocks`（父子之间不重复列一条「阻塞」）；
   词表外的关系照样丢弃。
3. `IssueFocusList`（`:1856`）：一组一个循环，空桶不渲染；表头 `side.text.replace('{n}', n)`，
   折叠只留给可能很长的子 issue 桶（>4 条）；行内删掉 `dkf-edge`，关系原词退到表头的
   `data-hint`（悬停可见）。顺带删掉 `IssueRow` 的 `edge` 入参、`.dkf-edge` 与 `.dkf-crumb`
   两条样式。

**真数据核对**（`kiln graph --json` 的边喂给 `relatedOf`，本仓 29 issue / 46 边；下面是第二轮
改简后的文案）：

```
== kiln-many-issues
  2 个子 issue        -> kiln-input-streams, kiln-list-window
  由 1 个 issue 引发  -> kiln-search
  7 个弱关联（无方向） -> kiln-cache-budget, …, kiln-v040-adapter
== kiln-flow-focus-ui
  由 1 个 issue 引发  -> kiln-dsh-integration
  引发了 1 个 issue   -> kiln-views-shared-focus
== kiln-list-window
  1 个父 issue        -> kiln-many-issues
```

因果链因此在两端都读得通：在 `kiln-flow-focus-ui` 上是「由 A 引发 / 引发了 B」，在 `kiln-search`
上是「引发了 kiln-many-issues」——同一对 issue 换个焦点，方向词自动翻面，不再出现「同一段文字
两种读法」。

测试：`npm test --prefix plugin` → 85（宿主）+ 61（渲染），原为 82 + 58。新增四例：表头一句话
且行内无 `dkf-edge`、多父全出现、父看子（含 >4 折叠）、因果与阻塞各两向；`run.mjs` 另加三例
分桶单测（多父、`part-of` 吞 `blocks`、未知关系丢弃、九个桶都带 `{n}`）。

**代价（记下来）**：一个 issue 有九种可能的表头，但只有非空的才渲染（本仓最多三块同现）；
头两轮来回改过口径（「母 issue」→「父 issue」，「我属于 X」→「X 个父 issue」），说明**文案要
在真数据上看几眼才算定**——测试只能锁住写法，锁不住读感。

## 修订（第二轮 apply）：文案去掉「我」，改短语

反馈很直接：`我属于 1 个母 issue`、`我引发了 1 个 issue` 每组都带「我」，读起来啰嗦，侧栏窄时
还容易折行。焦点行就在这组行的正上方，主语本来就明确，于是把主语删掉，方向交给语态：

| 桶 | 第一轮 | 定稿 |
| --- | --- | --- |
| `part-of\|out`（我的父） | 我属于 1 个母 issue | `1 个父 issue` |
| `part-of\|in`（我的子） | 2 个子 issue 属于我 | `2 个子 issue` |
| `blocks\|out` | 我阻塞 1 个 issue | `阻塞了 1 个 issue` |
| `blocks\|in` | 1 个 issue 阻塞我 | `被 1 个 issue 阻塞` |
| `supersedes\|out` | 我取代了 1 个 issue | `取代了 1 个 issue` |
| `supersedes\|in` | 1 个 issue 取代了我 | `被 1 个 issue 取代` |
| `caused-by\|out` | 我由 1 个 issue 引发 | `由 1 个 issue 引发` |
| `caused-by\|in` | 我引发了 1 个 issue | `引发了 1 个 issue` |
| `relates-to` | 7 个弱关联（无方向） | 不变 |

「母 issue」一并改成「父 issue」，跟反馈里的说法一致（父子成对，不再混用母/父）。

只改了 `REL_SIDES` 的 `text`：分桶、顺序、折叠、`data-hint`、CSS 都不动，测试期望同步更新，
85 + 61 仍全过。
