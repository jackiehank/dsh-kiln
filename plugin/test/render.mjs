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
  mode = 'graph',
  direction = 'LR',
  view = 'global',
  depth = '1',
}) {
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
    view, //                     graphView（全局 / 聚焦）
    depth, //                    graphDepth（一圈的半径）
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

check('relation 页默认（全局、无焦点）：只画有向关系', () => {
  const tree = render({ tabId: 'relation' })
  const source = mermaidOf(tree)
  assert.match(source, /^flowchart LR/)
  const nodes = source.split('\n').filter((line) => /^ {2}n_\w+\["/.test(line))
  assert.deepEqual(nodes.map((line) => line.trim().slice(0, 3)), ['n_a', 'n_b'], 'c 只挂在无向关联上，没焦点时不画')
  assert.ok(source.includes('n_b -.->|caused-by| n_a'), source)
  assert.ok(!source.includes('---'), '无焦点时不含无向边')
  assert.match(byClass(tree, 'dkf-note').map(textOf).join('\n'), /只画有向关系：另 1 条无向关联/)
})

check('全局 + 有焦点：焦点的无向邻居被带出来（不再需要开关）', () => {
  const tree = render({ tabId: 'relation', focusId: 'a' })
  const source = mermaidOf(tree)
  assert.ok(source.includes('n_c["c"]'), source)
  assert.ok(source.includes('n_c ---|relates-to| n_a'), source)
  // b 与 a 有向相连，但不该因此把别的无向边也拖进来
  assert.equal(source.split('\n').filter((line) => line.includes('---|')).length, 1)
})

check('节点 id 能反查回 issue：data-id = n_<issue>', () => {
  const source = mermaidOf(render({ tabId: 'relation', focusId: 'a' }))
  for (const id of ['a', 'b', 'c']) assert.ok(source.includes(`  n_${id}["${id}"]`), source)
})

check('聚焦：只有无向邻居也能画出一圈', () => {
  const tree = render({ tabId: 'relation', focusId: 'c', view: 'focus' })
  const source = mermaidOf(tree)
  assert.ok(source.includes('n_c["c"]'), source)
  assert.ok(source.includes('n_a["a"]'), source)
  assert.match(byClass(tree, 'dkf-note').map(textOf).join('\n'), /聚焦：c 与 1 跳内的 1 个邻居/)
})

check('控件：列表不画图；图里只剩视图与方向，半径只在「聚焦」出现', () => {
  const graph = render({ tabId: 'relation' })
  assert.deepEqual(byClass(graph, 'dkf-modebtn').map(textOf), ['图', '列表', '横向', '纵向', '全局', '聚焦'])
  const ego = render({ tabId: 'relation', focusId: 'b', view: 'focus' })
  assert.deepEqual(byClass(ego, 'dkf-modebtn').map(textOf).slice(-2), ['1 跳', '2 跳'])
  const list = render({ tabId: 'relation', mode: 'list' })
  assert.equal(byClass(list, 'dkf-graph').length, 0)
  assert.deepEqual(byClass(list, 'dkf-modebtn').map(textOf), ['图', '列表'])
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

check('切焦点：焦点有无向邻居时全局会补上那几条边，聚焦则整张重画', () => {
  const withWeak = render({ tabId: 'relation', focusId: 'a' })
  const withoutWeak = render({ tabId: 'relation', focusId: 'b' })
  assert.notEqual(mermaidOf(withWeak), mermaidOf(withoutWeak), 'a 有无向邻居，b 没有')
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
