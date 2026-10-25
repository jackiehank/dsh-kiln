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
function render({ focusId = null, tabId = 'timeline', expanded = null, mode = 'graph', direction = 'LR', scope = 'auto' }) {
  const React = makeReact([
    { phase: 'ready', payload, error: null }, // state：直接给成 ready
    0, //                        nonce
    tabId, //                    tabId
    focusId, //                  focusId
    expanded, //                 expanded（展开项）
    false, //                    expandedWeak
    false, //                    expandedChildren
    mode, //                     relationMode（关系页取景）
    direction, //                graphDirection（图方向）
    scope, //                    graphScope（结构 / 全部）
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

check('绑定：三段 tablist，默认选中第一段', () => {
  tree = render({})
  const tabs = byClass(tree, 'dkf-tab')
  assert.equal(tabs.length, 3)
  assert.equal(tabs[0].props['aria-selected'], true)
  assert.equal(tabs[1].props['aria-selected'], false)
  assert.equal(tabs[0].props.tabIndex, 0)
  assert.equal(tabs[1].props.tabIndex, -1)
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

// ---------------------------------------------------------------- relation 页

check('relation 页全局（列表取景）：按关系分组列出边', () => {
  const focused = render({ tabId: 'relation', mode: 'list' })
  const groups = byClass(focused, 'dkf-group-head')
  assert.equal(groups.length, 2)
  assert.match(textOf(groups[0]), /caused-by 1/)
  assert.equal(byClass(focused, 'dkf-grow').length, 2)
})

check('relation 页聚焦（列表取景）：焦点行 + 一跳邻居行', () => {
  const focused = render({ tabId: 'relation', focusId: 'b', mode: 'list' })
  const rows = byClass(focused, 'dkf-row')
  assert.ok(rows.length >= 2, `期望至少 2 行，实际 ${rows.length}`)
  assert.equal(textOf(byClass(rows[0], 'dkf-id')[0]), 'b')
  const edges = byClass(focused, 'dkf-edge').map(textOf).join(' ')
  assert.match(edges, /caused-by/)
})

// ---------------------------------------------------------------- relation 页（图）

/** 图模式：容器上挂着 mermaid 源，便于在无浏览器环境里断言。 */
function mermaidOf(tree) {
  const hosts = byClass(tree, 'dkf-graph')
  assert.equal(hosts.length, 1, '图模式应有一个图容器')
  return String(hosts[0].props['data-mermaid'] ?? '')
}

check('relation 页默认是图：结构取景只画有向关系', () => {
  const tree = render({ tabId: 'relation' })
  const source = mermaidOf(tree)
  assert.match(source, /^flowchart LR/)
  const nodes = source.split('\n').filter((line) => /^ {2}n_\w+\["/.test(line))
  assert.deepEqual(nodes.map((line) => line.trim().slice(0, 3)), ['n_a', 'n_b'], 'c 只挂在弱关联上，默认不画')
  assert.ok(source.includes('n_b -.->|caused-by| n_a'), source)
  assert.ok(!source.includes('---'), '结构取景不含无向边')
  assert.equal(byClass(tree, 'dkf-mermaid').length, 1, '渲染器就位前先显示源码')
  // 隐藏的东西必须说出来，不能悄悄消失
  const notes = byClass(tree, 'dkf-note').map(textOf).join('\n')
  assert.match(notes, /隐藏 1 条弱关联/)
  assert.match(notes, /1 个只挂在弱关联上的 issue/)
})

check('全部取景：弱关联与只挂弱关联的节点都回来', () => {
  const source = mermaidOf(render({ tabId: 'relation', scope: 'all' }))
  const nodes = source.split('\n').filter((line) => /^ {2}n_\w+\["/.test(line))
  assert.deepEqual(nodes.map((line) => line.trim().slice(0, 3)), ['n_a', 'n_b', 'n_c'])
  assert.ok(source.includes('n_c ---|relates-to| n_a'), source)
  const notes = byClass(render({ tabId: 'relation', scope: 'all' }), 'dkf-note').map(textOf).join('\n')
  assert.ok(!/已隐藏/.test(notes), '全部取景不该再提示隐藏')
})

check('节点 id 能反查回 issue：data-id = n_<issue>', () => {
  const source = mermaidOf(render({ tabId: 'relation', scope: 'all' }))
  for (const id of ['a', 'b', 'c']) assert.ok(source.includes(`  n_${id}["${id}"]`), source)
})

check('聚焦一个只挂弱关联的节点：结构取景下它也必须被带上', () => {
  const tree = render({ tabId: 'relation', focusId: 'c', scope: 'structure' })
  const source = mermaidOf(tree)
  assert.ok(source.includes('n_c["c"]'), `焦点 c 被结构取景藏掉了：\n${source}`)
  // 临时放宽必须说出来，不能让人以为结构里本来就有 k_c 的弱边
  const notes = byClass(tree, 'dkf-note').map(textOf).join('\n')
  assert.match(notes, /只挂在弱关联上，已临时按「全部」画/)
})

check('自动取景：无焦点用结构，有焦点用焦点（用户定的两条默认）', () => {
  const idle = mermaidOf(render({ tabId: 'relation' }))
  assert.equal(idle, mermaidOf(render({ tabId: 'relation', scope: 'structure' })), '无焦点 → 结构')
  const focused = mermaidOf(render({ tabId: 'relation', focusId: 'b' }))
  assert.equal(focused, mermaidOf(render({ tabId: 'relation', focusId: 'b', scope: 'focus' })), '有焦点 → 焦点')
  assert.match(byClass(render({ tabId: 'relation' }), 'dkf-modebtn-active').map(textOf).join(','), /自动/)
})

check('图与焦点：聚焦只落在容器的 data-focus 上（文本不变）', () => {
  const plain = render({ tabId: 'relation' })
  const focused = render({ tabId: 'relation', focusId: 'b' })
  assert.equal(mermaidOf(plain), mermaidOf(focused), 'mermaid 源必须与焦点无关，否则会重排')
  const host = byClass(focused, 'dkf-graph')[0]
  assert.equal(host.props['data-focus'], 'b')
})

check('关系取景可切换：列表不画图，图有三组控件', () => {
  const graph = render({ tabId: 'relation' })
  assert.deepEqual(byClass(graph, 'dkf-modebtn').map(textOf), ['图', '列表', '横向', '纵向', '自动', '结构', '全部', '焦点'])
  assert.equal(byClass(graph, 'dkf-modebtn-active').length, 3, '取景 / 方向 / 范围各选中一个')
  const list = render({ tabId: 'relation', mode: 'list' })
  assert.equal(byClass(list, 'dkf-graph').length, 0)
  assert.deepEqual(byClass(list, 'dkf-modebtn').map(textOf), ['图', '列表'], '列表取景没有方向与范围')
})

check('焦点取景：以焦点为中心重画，只留它的一跳', () => {
  const tree = render({ tabId: 'relation', focusId: 'b', scope: 'focus' })
  const source = mermaidOf(tree)
  const nodes = source.split('\n').filter((line) => /^ {2}n_\w+\["/.test(line))
  assert.deepEqual(nodes.map((line) => line.trim().slice(0, 3)), ['n_a', 'n_b'], 'c 与 b 不相邻，不进来')
  assert.ok(source.includes('n_b -.->|caused-by| n_a'), source)
  const notes = byClass(tree, 'dkf-note').map(textOf).join('\n')
  assert.match(notes, /焦点取景：只画 b 与它的 1 个邻居/)
  // 重画之后不需要淡化：整张图都是焦点的一圈
  assert.equal(byClass(tree, 'dkf-modebtn-active').map(textOf).includes('焦点'), true)
})

check('焦点取景但还没聚焦：退回结构取景并提示', () => {
  const tree = render({ tabId: 'relation', scope: 'focus' })
  const source = mermaidOf(tree)
  assert.equal(source, mermaidOf(render({ tabId: 'relation' })), '无焦点时与结构取景一致')
  assert.match(byClass(tree, 'dkf-note').map(textOf).join('\n'), /选定.*issue|先选一个 issue/)
})

check('切焦点：结构取景不变文本，焦点取景重画', () => {
  const structural = render({ tabId: 'relation', focusId: 'a', scope: 'structure' })
  const structuralOther = render({ tabId: 'relation', focusId: 'b', scope: 'structure' })
  assert.equal(mermaidOf(structural), mermaidOf(structuralOther), '结构取景下切焦点不重排')
  const focusA = render({ tabId: 'relation', focusId: 'a', scope: 'focus' })
  const focusC = render({ tabId: 'relation', focusId: 'c', scope: 'focus' })
  assert.notEqual(mermaidOf(focusA), mermaidOf(focusC), '焦点取景下换焦点就是要重画')
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
