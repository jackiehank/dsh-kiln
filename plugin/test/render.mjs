/**
 * 渲染冒烟测试：用一个极简 React 替身把三页各渲染一次，检查结构而不碰浏览器。
 *
 * 覆盖：模块能加载、tablist 三项、timeline 的行数与聚焦收窄、issue 行、relation 全局与聚焦。
 * 不覆盖：真实布局/CSS、键盘事件、异步取数（effect 不执行）。
 *
 * 用法：`node plugin/test/render.mjs`
 */
import assert from 'node:assert/strict'

/** 极简 React 替身：createElement 只造树，函数组件由 expand() 手动展开。 */
function makeReact(presets) {
  let stateIndex = 0
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'fragment',
    useState: () => {
      const value = presets[stateIndex]
      stateIndex += 1
      return [value, () => {}]
    },
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
  }
}

/** 递归展开函数组件与数组，得到纯 DOM 树。 */
function expand(node) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, children: (node.children ?? []).map(expand) }
}

function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function byClass(tree, name) {
  const found = []
  walk(tree, (node) => {
    const className = node.props?.className
    if (typeof className === 'string' && className.split(/\s+/).includes(name)) found.push(node)
  })
  return found
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

const action = (name, ordinal, date) => ({
  ordinal,
  action: name,
  id: `${'a'.repeat(30)}${String(ordinal).padStart(10, '0')}`,
  short: `aaaaaaa`,
  date,
  title: `${name} 动作 ${ordinal}`,
})

const issue = (id, actions) => ({
  id,
  domain: 'integration',
  action: actions[actions.length - 1].action,
  done: false,
  title: `${id} 标题`,
  tags: [],
  actions,
  last: actions[actions.length - 1],
})

const payload = {
  ok: true,
  repo: '/repo',
  generatedAt: '2026-10-25T00:00:00+08:00',
  focus: 'b',
  issues: [
    issue('a', [action('ask', 1, '2026-10-01T00:00:00+08:00'), action('apply', 2, '2026-10-05T00:00:00+08:00')]),
    issue('b', [action('collect', 1, '2026-10-03T00:00:00+08:00')]),
    issue('c', [action('test', 1, '2026-10-02T00:00:00+08:00')]),
  ],
  // c 只通过一条无向弱关联挂在 a 上：结构取景下应连同这条边一起被收起来，
  // 而且它不能被算成 b 的一跳邻居（否则聚焦用例就测不出“收窄”了）
  edges: [
    { from: 'b', to: 'a', name: 'caused-by', directed: true },
    { from: 'c', to: 'a', name: 'relates-to' },
  ],
  total: 3,
  truncated: false,
  cache: { action: 'hit' },
}

// ---------------------------------------------------------------- 载入真实模块

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      loaded = definition
    },
  },
}
globalThis.document = { getElementById: () => ({}), createElement: () => ({}) }
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })

await import('../lib/client.js?render=1')
assert.equal(loaded?.id, '@local/dsh-kiln')

/** 渲染一次：presets 依次喂给 KilnView 的 useState。 */
function render({
  focusId = null,
  tabId = 'timeline',
  expanded = null,
  children = false,
  focusOpen = true,
  direction = 'LR',
  view = 'global',
  depth = '1',
  filterOpen = false,
  filters = undefined,
  rowFilters = undefined,
  query = '',
}) {
  const React = makeReact([
    {
      phase: 'ready',
      payload,
      error: null,
    }, //                          state：直接给成 ready
    0, //                          nonce
    tabId, //                      tabId
    focusId, //                    focusId
    expanded, //                   expanded（三页共享的展开项）
    children, //                   expandedChildren（子 issue 组是否全展开）
    focusOpen, //                  focusOpen（焦点行是否展开动作）
    direction, //                  graphDirection（图方向）
    view, //                       graphView（全局 / 聚焦）
    depth, //                      graphDepth（一圈的半径）
    filterOpen, //                 filterOpen（筛选条是否展开）
    filters, //                    filters（issue 页：领域 / 状态）
    rowFilters, //                 rowFilters（时间线：动作 / 领域）
    query, //                      query（搜索框的输入）
  ])
  const requireOf = (name) => {
    if (name === 'react') return React
    throw new Error(`意外的 require: ${name}`)
  }
  // 图渲染器不在测试里加载：effect 本来就不执行，这里只是让 loadPele 走“取不到”的分支
  requireOf.async = async (name) => {
    throw new Error(`测试里没有 chunk: ${name}`)
  }
  const mod = loaded.factory(requireOf)
  const KilnView = captureComponent(mod)
  return expand(KilnView({ cwd: '/repo' }))
}

function captureComponent(mod) {
  let component = null
  mod.apply({
    slots: {
      inject: (_name, run) => run(),
      register: (_options, value) => {
        component = value
      },
    },
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
  })
  return component
}

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(`ok   ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}\n     ${String(error?.message ?? error).split('\n')[0]}`)
    process.exitCode = 1
  }
}

let tree = null

// ---------------------------------------------------------------- 全局态

check('视图根节点带 .dkf-root：藏调宽手柄的规则靠它当锚点', () => {
  const plain = render({})
  assert.equal(byClass(plain, 'dkf-root').length, 1)
})

check('绑定：三段 tablist，默认选中第一段', () => {
  tree = render({})
  const tabs = byClass(tree, 'dkf-tab')
  assert.equal(tabs.length, 3)
  assert.equal(tabs[0].props['aria-selected'], true)
  assert.equal(tabs[1].props['aria-selected'], false)
  assert.equal(tabs[0].props.tabIndex, 0)
  assert.equal(tabs[1].props.tabIndex, -1)
})

check('页头：两层，第二层左页切换、右当前页计数', () => {
  const view = render({ tabId: 'timeline' })
  assert.equal(byClass(view, 'dkf-bar').length, 1, '三页共用一个第二层页头')
  const bar = byClass(view, 'dkf-bar')[0]
  assert.equal(byClass(bar, 'dkf-tabs').length, 1, '页切换在第二层左侧')
  assert.equal(textOf(byClass(bar, 'dkf-count')[0]), '4 个动作', '时间线页右侧放动作数')
  const labels = byClass(view, 'dkf-modebtn').map(textOf)
  assert.ok(!labels.some((label) => ['横向', '纵向', '全局', '聚焦'].includes(label)), '非关系页没有图的取景控件')
  assert.ok(labels.includes('筛选'), '时间线页有动作筛选（4 条动作里不止一种动作名）')
})

check('页头：关系页右侧换成取景控件，不再另起一行工具条', () => {
  const view = render({ tabId: 'relation' })
  const bar = byClass(view, 'dkf-bar')[0]
  assert.equal(byClass(bar, 'dkf-count').length, 0, '关系页右侧是控件不是计数')
  assert.deepEqual(byClass(bar, 'dkf-modebtn').map(textOf), ['横向', '纵向', '全局', '聚焦'])
  assert.equal(byClass(view, 'dkf-toolbar').length, 0, '旧的行内工具条已去掉')
})

check('时间线：列表带竖脊，行的动作色走行级 CSS 变量', () => {
  const view = render({ tabId: 'timeline' })
  assert.equal(byClass(view, 'dkf-rail').length, 1, '竖脊只在时间线的列表上')
  const row = byClass(view, 'dkf-arow')[0]
  assert.ok(row.props.style['--dkf-row-color'], '行把动作色放进 --dkf-row-color')
  assert.equal(byClass(row, 'dkf-abar')[0].props.style, undefined, '色点不再内联 background')
  assert.equal(byClass(row, 'dkf-achip')[0].props.style, undefined, '动作名不再内联 color')
})

check('提示框：渲染树里没有原生 title，提示一律走 data-hint', () => {
  const view = render({ tabId: 'timeline' })
  const withTitle = []
  const hints = []
  walk(view, (node) => {
    const props = node.props
    if (props === undefined || props === null || typeof props !== 'object') return
    if ('title' in props) withTitle.push(props.title)
    if (typeof props['data-hint'] === 'string') hints.push(props['data-hint'])
  })
  assert.deepEqual(withTitle, [], '原生 title 会弹出第二个提示框（系统样式）')
  assert.ok(hints.includes('点开看这条提交的详情'), '时间线行要带提示')
  assert.ok(hints.includes('重新读取 kiln 快照'), '刷新按钮要带提示')
})

check('提示框：被截断的 id / 标题也有提示', () => {
  const view = render({ tabId: 'issue' })
  const id = byClass(view, 'dkf-id')[0]
  const title = byClass(view, 'dkf-title')[0]
  assert.ok(String(id.props['data-hint'] ?? '').length > 0, 'id 有 max-width，截断后要能看全')
  assert.ok(String(title.props['data-hint'] ?? '').length > 0, '标题有省略号，同样要有提示')
})

check('搜索：输入框在第一层页头，不是另一行', () => {
  const view = render({})
  const input = byClass(view, 'dkf-search')[0]
  assert.ok(input !== undefined, '页头要有搜索输入框')
  assert.equal(input.props.placeholder, '搜索 issue…')
  assert.equal(byClass(view, 'dkf-head')[0].children.filter(Boolean).includes(input), true, '输入框属于 .dkf-head 这一行')
})

check('搜索：有输入就换成结果列表，页栏显示命中数', () => {
  const view = render({ tabId: 'issue', query: 'a' })
  const hits = byClass(view, 'dkf-hit')
  assert.equal(hits.length, 1, '测试数据里只有 a 命中')
  assert.equal(textOf(byClass(view, 'dkf-count')[0]), '1 条命中 · 仓库共 3 条')
  assert.equal(byClass(view, 'dkf-row').length, 0, '搜索期间不再渲染当前页的列表')
  assert.equal(byClass(hits[0], 'dkf-hl').length > 0, true, '命中片段要能高亮')
})

check('搜索：命中早期动作标题时，行里显示那条标题并标「历史标题」', () => {
  const view = render({ tabId: 'issue', query: '动作 1' })
  const hits = byClass(view, 'dkf-hit')
  assert.equal(hits.length, 3, '三个 issue 的第 1 条动作标题都含「动作 1」')
  const chips = byClass(hits[0], 'dkf-chip').map(textOf)
  assert.ok(chips.includes('历史标题'), '要标出命中的不是当前标题')
  assert.match(textOf(byClass(hits[0], 'dkf-title')[0]), /动作 1/, '显示的是命中的那条标题')
  assert.equal(byClass(hits[0], 'dkf-hl').length > 0, true, '高亮落在显示的标题上')
})
check('搜索：没有命中时给明确空态', () => {
  const view = render({ tabId: 'issue', query: 'zzz' })
  assert.equal(byClass(view, 'dkf-hit').length, 0)
  const empty = byClass(view, 'dkf-empty')[0]
  assert.match(textOf(empty), /没有找到「zzz」/)
  assert.match(textOf(empty), /Esc/)
})

check('筛选：本仓没有可筛维度时不给空壳按钮', () => {
  // 测试数据只有一个领域、一个状态、没有标签 —— 三组都筛不出东西
  const view = render({ tabId: 'issue' })
  const labels = byClass(view, 'dkf-modebtn').map(textOf)
  assert.ok(!labels.includes('筛选'), '没有可选项时不该出现筛选按钮')
  assert.equal(byClass(view, 'dkf-filters').length, 0, '也不该有筛选条')
})

check('筛选：命中为空时说「没有符合筛选」，不是「还没有 issue」', () => {
  const view = render({ tabId: 'issue', filters: { domains: [], tags: [], states: ['done'] } })
  assert.equal(byClass(view, 'dkf-row').length, 0, '测试数据全是进行中，按已完成筛就空了')
  assert.match(textOf(byClass(view, 'dkf-empty')[0]), /没有符合筛选/)
})

check('时间线筛选：按动作名收窄，计数变成「命中 / 总数」', () => {
  const view = render({ tabId: 'timeline', rowFilters: { actions: ['apply'], domains: [] } })
  assert.equal(byClass(view, 'dkf-arow').length, 1, '4 条动作里只有 a 的 apply')
  assert.equal(textOf(byClass(view, 'dkf-count')[0]), '1 / 4 个动作')
  assert.deepEqual(
    byClass(view, 'dkf-modebtn').filter((node) => textOf(node).startsWith('筛选')).map(textOf),
    ['筛选 1'],
    '按钮上带选中数量',
  )
})

check('时间线筛选：筛空时给的是「没有符合筛选条件的动作」', () => {
  const view = render({ tabId: 'timeline', rowFilters: { actions: ['conclude'], domains: [] } })
  assert.equal(byClass(view, 'dkf-arow').length, 0)
  assert.match(textOf(byClass(view, 'dkf-empty')[0]), /没有符合筛选条件的动作/)
})

check('timeline 全局：4 条 action 一行一条，按时间倒序', () => {
  const rows = byClass(tree, 'dkf-arow')
  assert.equal(rows.length, 4)
  const short = byClass(tree, 'dkf-ashort').map(textOf)
  assert.deepEqual(short, ['aaaaaaa', 'aaaaaaa', 'aaaaaaa', 'aaaaaaa'])
  // 第一行应是 10-05 的 apply（最近）
  const firstTitle = byClass(rows[0], 'dkf-atitle')[0]
  assert.match(textOf(firstTitle), /apply/)
})

check('timeline 全局：每行标出所属 issue，没有焦点 chip', () => {
  const rows = byClass(tree, 'dkf-arow')
  const owners = rows.map((row) => textOf(byClass(row, 'dkf-aissue')[0]))
  assert.deepEqual(owners, ['a', 'b', 'c', 'a'])
  assert.equal(byClass(tree, 'dkf-focuschip').length, 0)
})

// ---------------------------------------------------------------- 聚焦态

check('聚焦 b：timeline 收窄到 b 与它的相关 issue（a），c 消失', () => {
  const focused = render({ focusId: 'b' })
  const rows = byClass(focused, 'dkf-arow')
  assert.equal(rows.length, 3)
  const owners = rows.map((row) => textOf(byClass(row, 'dkf-aissue')[0]))
  assert.deepEqual([...new Set(owners)].sort(), ['a', 'b'])
  assert.ok(!owners.includes('c'))
})

check('聚焦 b：出现可点击的焦点 chip', () => {
  const focused = render({ focusId: 'b' })
  const chips = byClass(focused, 'dkf-focuschip')
  assert.equal(chips.length, 1)
  assert.match(textOf(chips[0]), /焦点：b/)
})

check('焦点不在快照里：给出提示并可回全局', () => {
  const focused = render({ focusId: 'zzz' })
  const warnings = byClass(focused, 'dkf-warn')
  assert.equal(warnings.length, 1)
  assert.match(textOf(warnings[0]), /zzz/)
})

// ---------------------------------------------------------------- issue 页

check('issue 页全局：一行一个 issue', () => {
  const focused = render({ tabId: 'issue' })
  const rows = byClass(focused, 'dkf-row')
  assert.equal(rows.length, 3)
  const ids = rows.map((row) => textOf(byClass(row, 'dkf-id')[0]))
  assert.deepEqual([...ids].sort(), ['a', 'b', 'c'])
})

check('issue 页聚焦：只留焦点与相关 issue，且焦点钉在第一条', () => {
  const focused = render({ tabId: 'issue', focusId: 'b' })
  const rows = byClass(focused, 'dkf-row')
  assert.equal(rows.length, 2)
  assert.equal(textOf(byClass(rows[0], 'dkf-id')[0]), 'b')
  assert.ok(rows[0].props.className.includes('dkf-focus'))
})

// ---------------------------------------------------------------- issue 页（聚焦态）

check('issue 页聚焦：按结构分组，行内带关系名与方向', () => {
  const focused = render({ tabId: 'issue', focusId: 'a' })
  const heads = byClass(focused, 'dkf-group-head').map(textOf)
  assert.deepEqual(heads, ['因果 · caused-by 1', '弱关联 · relates-to 1'])
  const edges = byClass(focused, 'dkf-edge').map((node) => textOf(node).trim())
  assert.deepEqual(edges, ['← caused-by'], 'b 引发了 a，所以从 a 看是 ←')
})

check('issue 页聚焦：弱关联默认展开，没有「+N 弱关联」按钮', () => {
  const focused = render({ tabId: 'issue', focusId: 'a' })
  assert.equal(byClass(focused, 'dkf-toggle').length, 0)
  const ids = byClass(focused, 'dkf-row').map((row) => textOf(byClass(row, 'dkf-id')[0]))
  assert.equal(ids.length, 3, '焦点 + 强关系 + 弱关联各一行')
  assert.match(ids[0], /^a$/)
  assert.match(ids[1], /caused-by\s+b$/)
  assert.match(ids[2], /^c$/)
})

check('issue 页聚焦：焦点行默认展开它的动作，点一下收起', () => {
  const open = render({ tabId: 'issue', focusId: 'a' })
  assert.equal(byClass(open, 'dkf-subrow').length, 2, 'a 有两个动作')
  const closed = render({ tabId: 'issue', focusId: 'a', focusOpen: false })
  assert.equal(byClass(closed, 'dkf-subrow').length, 0)
})

// ---------------------------------------------------------------- relation 页（图）

/** 图模式：容器上挂着 mermaid 源，便于在无浏览器环境里断言。 */
function mermaidOf(tree) {
  const hosts = byClass(tree, 'dkf-graph')
  assert.equal(hosts.length, 1, '图模式应有一个图容器')
  return String(hosts[0].props['data-mermaid'] ?? '')
}

check('relation 页默认（全局、无焦点）：只画有向关系', () => {
  const tree = render({ tabId: 'relation' })
  const source = mermaidOf(tree)
  assert.match(source, /^flowchart LR/)
  const nodes = source.split('\n').filter((line) => /^ {2}n_\w+\["/.test(line))
  assert.deepEqual(nodes.map((line) => line.trim().slice(0, 3)), ['n_a', 'n_b'], 'c 只挂在无向关联上，没焦点时不画')
  assert.ok(source.includes('n_a --> n_b'), 'caused-by 按“因 → 果”画：a 引发 b，所以箭头 a→b')
  assert.ok(source.includes('linkStyle 0 stroke-width:1.6px,stroke-dasharray:10 5'), 'caused-by 应是长虚线')
  assert.ok(!source.includes('---'), '无焦点时不含无向边')
  assert.ok(!source.includes('|'), '边上不该再有标签')
  assert.match(byClass(tree, 'dkf-note').map(textOf).join('\n'), /只画有向关系：另 1 条无向关联/)
})

check('图例：五句话 + 带箭头的样条，没画的那类压到 15%', () => {
  const tree = render({ tabId: 'relation' })
  const rows = byClass(tree, 'dkf-legend-row')
  assert.equal(rows.length, 5)
  assert.deepEqual(byClass(tree, 'dkf-legend-text').map(textOf), [
    'A 是 B 的一部分',
    'A 阻塞 B',
    'A 引发 B',
    'A 取代 B',
    'A 与 B 相关',
  ])

  // 样条两端必须标出 A、B，否则文字里的 A/B 没有落点
  for (const row of rows) {
    assert.deepEqual(byClass(row, 'dkf-legend-end').map(textOf), ['A', 'B'])
  }

  const off = byClass(tree, 'dkf-legend-off').map((row) => textOf(byClass(row, 'dkf-legend-text')[0]))
  assert.deepEqual(off, ['A 是 B 的一部分', 'A 阻塞 B', 'A 取代 B', 'A 与 B 相关'], '只有 caused-by 在当前视图里')
  const titles = rows.map((row) => String(row.props['data-hint'] ?? ''))
  assert.ok(titles.some((title) => title.includes('当前视图没画')), '未画的类别还要有提示（走 data-hint）')
  assert.deepEqual(rows.map((row) => row.props.title), rows.map(() => undefined), '不再用原生 title')

  const swatches = byClass(tree, 'dkf-legend-svg').map((svg) => svg.children.filter(Boolean))
  assert.equal(swatches.length, 5)
  // 有向的四条都画箭头，relates-to 不画
  for (let index = 0; index < 4; index += 1) {
    assert.equal(swatches[index].filter((child) => child.type === 'polygon').length, 1, `第 ${index} 条要有箭头`)
  }
  assert.equal(swatches[4].filter((child) => child.type === 'polygon').length, 0, 'relates-to 没有箭头')

  // 线型与图上完全一致：粗实线 / 长虚 / 点划 / 点线
  const lines = swatches.map((children) => children.find((child) => child.type === 'line').props)
  assert.equal(lines[0].strokeWidth, 3.4)
  assert.equal(lines[2].strokeDasharray, '10 5')
  assert.equal(lines[3].strokeDasharray, '9 3 2 3')
  assert.equal(lines[4].strokeDasharray, '2 5')
  assert.equal(lines[4].strokeWidth, 1.3)
})

check('全局 + 有焦点：布局不变，只把焦点挂在 data-focus 上', () => {
  const plain = render({ tabId: 'relation' })
  const focused = render({ tabId: 'relation', focusId: 'a' })
  assert.equal(mermaidOf(plain), mermaidOf(focused), '全局视图切焦点不重排（无向边不参与绘制）')
  assert.equal(byClass(focused, 'dkf-graph')[0].props['data-focus'], 'a')
  assert.ok(!mermaidOf(focused).includes('---'), '无向边不画')
})

check('节点 id 能反查回 issue：data-id = n_<issue>', () => {
  const source = mermaidOf(render({ tabId: 'relation', focusId: 'a', view: 'focus', depth: '2' }))
  for (const id of ['a', 'b', 'c']) assert.ok(source.includes(`  n_${id}["${id}"]`), source)
})

check('聚焦：只有无向邻居也能画出一圈', () => {
  const tree = render({ tabId: 'relation', focusId: 'c', view: 'focus' })
  const source = mermaidOf(tree)
  assert.ok(source.includes('n_c["c"]'), source)
  assert.ok(source.includes('n_a["a"]'), source)
  assert.match(byClass(tree, 'dkf-note').map(textOf).join('\n'), /聚焦：c 与 1 跳内的 1 个邻居/)
})

check('控件：关系页只剩方向 / 视图 / 半径三段，半径只在「聚焦」出现', () => {
  const graph = render({ tabId: 'relation' })
  assert.deepEqual(byClass(graph, 'dkf-modebtn').map(textOf), ['横向', '纵向', '全局', '聚焦'])
  const ego = render({ tabId: 'relation', focusId: 'b', view: 'focus' })
  assert.deepEqual(byClass(ego, 'dkf-modebtn').map(textOf).slice(-2), ['1 跳', '2 跳'])
  assert.equal(byClass(render({ tabId: 'issue' }), 'dkf-graph').length, 0, 'issue 页不画图')
})

check('聚焦：1 跳只留直接邻居', () => {
  const tree = render({ tabId: 'relation', focusId: 'b', view: 'focus' })
  const nodes = mermaidOf(tree).split('\n').filter((line) => /^ {2}n_\w+\["/.test(line))
  assert.deepEqual(nodes.map((line) => line.trim().slice(0, 3)), ['n_a', 'n_b'])
  assert.match(byClass(tree, 'dkf-note').map(textOf).join('\n'), /聚焦：b 与 1 跳内的 1 个邻居/)
})

check('聚焦：2 跳多出第二层（b→a→c）', () => {
  const nodesOf = (tree) =>
    mermaidOf(tree)
      .split('\n')
      .filter((line) => /^ {2}n_\w+\["/.test(line))
      .map((line) => line.trim().slice(0, 3))
  assert.deepEqual(nodesOf(render({ tabId: 'relation', focusId: 'b', view: 'focus', depth: '1' })), ['n_a', 'n_b'])
  assert.deepEqual(nodesOf(render({ tabId: 'relation', focusId: 'b', view: 'focus', depth: '2' })), ['n_a', 'n_b', 'n_c'], 'c 在 a 的另一侧，只有 2 跳才够得到')
})

check('全局：焦点只影响它自己那一圈，有向骨架不动', () => {
  const plain = render({ tabId: 'relation' })
  const focused = render({ tabId: 'relation', focusId: 'b' })
  assert.equal(mermaidOf(plain), mermaidOf(focused), 'b 没有无向邻居，文本不变')
  assert.equal(byClass(focused, 'dkf-graph')[0].props['data-focus'], 'b')
})

check('切焦点：全局一律不动文本，聚焦一律重画', () => {
  const a = render({ tabId: 'relation', focusId: 'a' })
  const b = render({ tabId: 'relation', focusId: 'b' })
  assert.equal(mermaidOf(a), mermaidOf(b), '全局视图切焦点不重排')
  const egoA = render({ tabId: 'relation', focusId: 'a', view: 'focus' })
  const egoC = render({ tabId: 'relation', focusId: 'c', view: 'focus' })
  assert.notEqual(mermaidOf(egoA), mermaidOf(egoC))
})

check('图方向：默认横向，切纵向只换 flowchart 的方向词', () => {
  const lr = render({ tabId: 'relation' })
  const tb = render({ tabId: 'relation', direction: 'TB' })
  assert.match(mermaidOf(lr), /^flowchart LR/)
  assert.match(mermaidOf(tb), /^flowchart TB/)
  // 除了方向词，节点与边必须逐字相同——否则“换方向”会连带改掉别的东西
  assert.equal(mermaidOf(lr).replace(/^flowchart LR/, ''), mermaidOf(tb).replace(/^flowchart TB/, ''))
  const active = byClass(tb, 'dkf-modebtn-active').map(textOf)
  assert.ok(active.includes('纵向'), active.join(','))
})

check('hover 说明框：默认不出现，图文本里也不带 tooltip 指令', () => {
  const tree = render({ tabId: 'relation' })
  assert.equal(byClass(tree, 'dkf-tip').length, 0, '没有 hover 就不该有说明框')
  const host = byClass(tree, 'dkf-graph')[0]
  assert.equal(typeof host.props.onPointerDown, 'function', '图容器要接 pointerdown（拖动时压住说明框）')
  assert.equal(typeof host.props.onPointerMove, 'function', '图容器要接 pointermove')
  assert.equal(typeof host.props.onPointerLeave, 'function')
  assert.ok(!mermaidOf(tree).includes('tooltip'), '说明框是自绘的，不该往图文本里塞 tooltip 指令')
})

// ---------------------------------------------------------------- 展开与聚焦控件

check('每行都有 `⌖ 聚焦` 控件，行本身是 roving（tabIndex -1）', () => {
  const plain = render({})
  const rows = byClass(plain, 'dkf-arow')
  const buttons = byClass(plain, 'dkf-focusbtn')
  assert.equal(buttons.length, rows.length)
  assert.deepEqual(buttons.map(textOf), rows.map(() => '⌖ 聚焦'))
  for (const row of rows) {
    assert.equal(row.props.tabIndex, -1)
    assert.equal(row.props['data-row'], '')
  }
})

check('issue 页点开一行：展开它的动作，一行一条、时间倒序', () => {
  const opened = render({ tabId: 'issue', expanded: { kind: 'issue', id: 'a' } })
  const subRows = byClass(opened, 'dkf-subrow')
  assert.equal(subRows.length, 2, 'a 有两个动作')
  const titles = subRows.map((row) => textOf(byClass(row, 'dkf-atitle')[0]))
  assert.match(titles[0], /apply/)
  assert.match(titles[1], /ask/)
})

check('展开是互斥的：展开 a 时 b 不展开', () => {
  const opened = render({ tabId: 'issue', expanded: { kind: 'issue', id: 'a' } })
  const carets = byClass(opened, 'dkf-caret').map(textOf)
  assert.equal(carets.filter((text) => text === '▾').length, 1, '只有一个展开标记')
  assert.equal(carets.filter((text) => text === '▸').length, 2)
})

check('timeline 点开一行：展开该提交的详情（sha / 步骤 / 时间）', () => {
  const sha = `${'a'.repeat(30)}${String(2).padStart(10, '0')}`
  const opened = render({ expanded: { kind: 'action', id: sha } })
  const details = byClass(opened, 'dkf-detail')
  assert.equal(details.length, 1)
  const text = textOf(details[0])
  assert.match(text, /提交/)
  assert.ok(text.includes(sha), '详情里应有完整 sha')
  assert.match(text, /2 \/ 2/)
})

// ---------------------------------------------------------------- 汇总

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL')).length
console.log('')
console.log(failed === 0 ? `全部通过：${results.length} 个渲染用例` : `失败 ${failed} 个`)
