# kiln-timeline-filter — 时间线按动作筛

## 问题

时间线一行一个动作，仓库一大就是几百行：本仓 104 行、`~/kiln` 256 行。
想只看某类动作（比如"最近都 apply 了什么"、"只看 test 结论"）只能一路滚。

issue 页已经有筛选了（`kiln-issue-filter`），但两页筛的对象不同：**issue 页的行是 issue，
时间线的行是动作**。所以这一页要筛的是动作，维度不能照搬。

## 目标

时间线页加筛选，作用在**动作行**上：

- **动作**：ask / hypothesize / collect / test / conclude / apply（快照里现成的 `row.action`）；
- **领域**：这个动作所属 issue 的领域（走 `issueId → byId` 查）；
- 同组多选 OR、组间 AND；某维度没有可选项时整组不出现（与 issue 页同一套判断）；
- 页栏右侧出现「筛选」，计数变成 `命中 / 总数 个动作`。

## 边界

- 只筛动作行；不改 issue 页的三组筛选。
- 不做标签维度：标签在 kiln 里是**动作级**的（每个提交的 trailer），但 `kiln path --json`
  的动作对象不带 `tags`，视图拿不到动作级标签（详见 collect 的实证）。
- 不新增数据请求：全部在已有快照上过滤。

## 验收

- 页栏右侧有「筛选」；展开出现一行 chips（动作 + 领域），不随内容滚动。
- 选中后按钮显示计数，计数区变成 `命中 / 总数 个动作`。
- 筛空时文案是「没有符合筛选条件的动作。」，不是「还没有任何 kiln 动作。」。
- 切页回来筛选还在；「清除」复位；同组 OR、组间 AND 有单测。

## 收集：动作分布（值不值得做）

| 仓库 | 动作行 | 分布 |
| --- | --- | --- |
| dsh-kiln | 104 | `apply 38 · collect 23 · ask 16 · hypothesize 14 · conclude 8 · test 5` |
| `~/kiln` | 256 | `hypothesize 64 · ask 58 · test 46 · apply 33 · conclude 33 · collect 22` |

两个仓都是 6 类齐全、分布均匀——"只看 test"是真需求，不是凑维度。

## 收集：标签到底是哪一级

这是本 issue 顺带查清的事，也是 issue 页标签筛选的语义来源。

1. **源头是动作级**：`tags:` 写在每个提交的 trailer 上。以 `kiln-flow-focus-ui` 为例，
   五个动作各写各的：
   `ask: flow,focus,ui` ／ `collect: flow,focus,research` ／ `test: flow,test` ／ `test: flow,test` ／
   `conclude: flow,focus`。
2. **`kiln graph --json` 给的是 issue 级并集**：同一个 issue 的节点回 `tags: [flow, focus, ui, research, test]`
   ——正好是上面五个动作的并集。
3. **`kiln path --json` 的动作对象没有 tags**：实测字段只有
   `ordinal / action / id / date / title`（部分动作多一个 `refs`）。
4. **`kiln show <issue> <n> --json` 有整段 commit body**，理论上能解析出每个动作的 trailer——
   但那是一个动作一次子进程（本仓 104 次、`~/kiln` 256 次），视图不可能这么取数。

结论：**视图能拿到的只有 issue 级并集**。于是：

- 时间线（动作行）不给标签维度——拿并集去筛动作会张冠李戴（某个动作没带这个标签，
  却因为同 issue 的别的动作带了而被筛出来）；
- issue 页（issue 行）可以给，但语义必须说清是"任一条动作带过"，见 `kiln-issue-filter`。

要真正做动作级标签，正确做法是上游给 `kiln path --json` 的动作对象补 `tags` 字段，
而不是在客户端再起 N 个子进程。

## 落地

1. **纯函数**：`rowFacets(rows, byId)`（动作名与领域，按次数降序，单值不给组）、
   `filterRows(rows, filters, byId)`（同组 OR、组间 AND）、`readRowFilters`（归一化记忆值）。
2. **`FilterRow` 泛化**：组清单由调用方给（issue 页三组、时间线两组），选项标签在 facets 里拍平
   （状态的"进行中/已完成"也在 `issueFacets` 里翻译），组件本身不再知道业务维度。
3. **页栏**：时间线右侧 = `[筛选] [N / M 个动作]`；`canFilterRows` 只看"本页有没有两种以上可筛值"，
   与 issue 页的 `canFilter` 各自独立。
4. **状态**：`rowFilters` 进 `VIEW_STATE`（按仓库记内存），与 `filters` 分开——两页筛的东西不同，
   互相不该串。
5. **空态**：筛空时给「没有符合筛选条件的动作。」；焦点作用域下的提示沿用原来的两句。

### 验证

- `npm test --prefix plugin` → 41 个宿主用例 + 37 个渲染用例全过。新增三条：
  - `rowFacets` / `filterRows`：按动作名、按所属 issue 的领域、组间 AND、单值不给组；
  - 渲染：`rowFilters.actions = ['apply']` 时时间线只剩 1 行，计数变 `1 / 4 个动作`，按钮写「筛选 1」；
  - 渲染：筛空时文案是「没有符合筛选条件的动作」。
- 顺带更新了一条旧断言：以前"非关系页没有 `.dkf-modebtn`"，现在时间线页有筛选按钮，
  改成"非关系页没有图的取景控件（横向/纵向/全局/聚焦）"。

### 已知边界

- **动作级标签要等上游**：`kiln path --json` 的动作对象补上 `tags` 之后，这一页才能加标签维度；
  现在只能拿 issue 级并集，用它筛动作会张冠李戴（见 collect）。
- 领域维度依赖动作所属 issue 的 domain；一个仓只有一种领域时该组不出现。