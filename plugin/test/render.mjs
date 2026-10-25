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
  edges: [{ from: 'b', to: 'a', name: 'caused-by', directed: true }],
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

/** 渲染一次：presets 依次喂给 KilnView 的 useState（phase/payload 等）。 */
function render({ focusId = null, tabId = 'timeline' }) {
  const React = makeReact([
    { phase: 'ready', payload, error: null }, // state：直接给成 ready
    0, //                        nonce
    focusId, //                  focusId
    tabId, //                    tabId
    false, //                    expandedWeak
    false, //                    expandedChildren
  ])
  const mod = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error(`意外的 require: ${name}`)
  })
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

check('relation 页全局：按关系分组列出边', () => {
  const focused = render({ tabId: 'relation' })
  const groups = byClass(focused, 'dkf-group-head')
  assert.equal(groups.length, 1)
  assert.match(textOf(groups[0]), /caused-by 1/)
  assert.equal(byClass(focused, 'dkf-grow').length, 1)
})

check('relation 页聚焦：焦点行 + 一跳邻居行', () => {
  const focused = render({ tabId: 'relation', focusId: 'b' })
  const rows = byClass(focused, 'dkf-row')
  assert.ok(rows.length >= 2, `期望至少 2 行，实际 ${rows.length}`)
  assert.equal(textOf(byClass(rows[0], 'dkf-id')[0]), 'b')
  const edges = byClass(focused, 'dkf-edge').map(textOf).join(' ')
  assert.match(edges, /caused-by/)
})

// ---------------------------------------------------------------- 汇总

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL')).length
console.log('')
console.log(failed === 0 ? `全部通过：${results.length} 个渲染用例` : `失败 ${failed} 个`)
