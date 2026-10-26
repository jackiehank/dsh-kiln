/**
 * 宿主侧单元测试：只测纯逻辑与可注入的编排，不起任何子进程。
 *
 * 用法：`node plugin/test/run.mjs`（不依赖测试框架，沙箱里也能跑）。
 * 真正 fork `kiln` / `git` 的路径在本机沙箱里会被 EPERM 拦住，那一层靠浏览器/桌面端实机验证。
 */
import assert from 'node:assert/strict'

import { buildFlow, mapActions } from '../lib/flow.js'
import { applyFocus, createSnapshotCache, evaluateCache } from '../lib/snapshot.js'
import { parseTrailerRange } from '../lib/git.js'

let passed = 0
const failures = []

/** 最小的用例封装：一个断言失败不影响其他用例继续跑。 */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL ${name}`)
    console.log(`     ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

const graphOf = () => ({
  nodes: [
    { id: 'a', domain: 'integration', action: 'apply', done: true, title: 'A' },
    { id: 'b', domain: 'integration', action: 'test', done: false, title: 'B' },
  ],
  edges: [{ from: 'b', to: 'a', name: 'caused-by' }],
})

const historyOf = (id, date) => [
  { ordinal: 1, action: 'ask', id: id === 'a' ? SHA_A : SHA_B, short: id === 'a' ? 'aaaaaaa' : 'bbbbbbb', date, title: `first ${id}` },
]

function makeFakeFlow() {
  const state = {
    graph: graphOf(),
    histories: new Map([
      ['a', historyOf('a', '2026-01-01T00:00:00+08:00')],
      ['b', historyOf('b', '2026-02-01T00:00:00+08:00')],
    ]),
    calls: [],
    graphFails: false,
  }
  const flow = {
    readGraph: async () => {
      state.calls.push('graph')
      return state.graphFails ? { ok: false, reason: 'not-kiln-repo' } : { ok: true, graph: state.graph }
    },
    readHistories: async (_repo, ids) => {
      state.calls.push(`histories:${ids.join(',')}`)
      const out = new Map()
      for (const id of ids) out.set(id, state.histories.get(id) ?? [])
      return out
    },
    buildFlow: (input) => buildFlow(input),
  }
  return { flow, state }
}

function makeFakeGit() {
  const state = {
    head: 'h1',
    config: 'c1',
    bin: 'b1',
    ancestor: true,
    delta: { ok: true, ids: new Set() },
    calls: [],
  }
  const git = {
    readHead: async () => {
      state.calls.push('head')
      return state.head
    },
    configToken: () => state.config,
    binaryToken: () => state.bin,
    isAncestor: async () => {
      state.calls.push('ancestor')
      return state.ancestor
    },
    newIssueIds: async () => {
      state.calls.push('delta')
      return state.delta
    },
  }
  return { git, state }
}

const probe = (over = {}) => ({ repo: 'r', head: 'h1', maxIssues: 80, configToken: 'c1', binToken: 'b1', ...over })
const previous = (over = {}) => ({ repo: 'r', head: 'h1', maxIssues: 80, configToken: 'c1', binToken: 'b1', histories: new Map(), payload: {}, ...over })

// ---------------------------------------------------------------- 失效决策

await check('evaluateCache：冷启动 → build', () => {
  assert.equal(evaluateCache(null, probe()).action, 'build')
})

await check('evaluateCache：四元组全同 → hit', () => {
  const decision = evaluateCache(previous(), probe())
  assert.equal(decision.action, 'hit')
})

await check('evaluateCache：HEAD 前进 → changed（交给 ancestor 判断）', () => {
  const decision = evaluateCache(previous(), probe({ head: 'h2' }))
  assert.equal(decision.action, 'changed')
})

await check('evaluateCache：配置变了 → build（未提交也会失效）', () => {
  const decision = evaluateCache(previous(), probe({ configToken: 'c2' }))
  assert.equal(decision.action, 'build')
  assert.equal(decision.reason, 'config-changed')
})

await check('evaluateCache：kiln 二进制变了 → build', () => {
  assert.equal(evaluateCache(previous(), probe({ binToken: 'b2' })).reason, 'binary-changed')
})

await check('evaluateCache：容量变了 → build', () => {
  assert.equal(evaluateCache(previous(), probe({ maxIssues: 40 })).reason, 'capacity-changed')
})

// ---------------------------------------------------------------- focus 叠加

await check('applyFocus：已知 issue 才覆盖', () => {
  const payload = { focus: 'b', issues: [{ id: 'a' }, { id: 'b' }] }
  assert.equal(applyFocus(payload, 'a').focus, 'a')
})

await check('applyFocus：未知 issue 原样返回（不静默换人）', () => {
  const payload = { focus: 'b', issues: [{ id: 'a' }, { id: 'b' }] }
  assert.equal(applyFocus(payload, 'zzz'), payload)
})

await check('applyFocus：没有 focus 参数时不动', () => {
  const payload = { focus: 'b', issues: [{ id: 'b' }] }
  assert.equal(applyFocus(payload, undefined), payload)
})

// ---------------------------------------------------------------- 数据层

await check('mapActions：保留完整 sha 并派生短哈希', () => {
  const actions = mapActions({ actions: [{ ordinal: 1, action: 'ask', id: SHA_A, date: 'd', title: 't' }] })
  assert.equal(actions[0].id, SHA_A)
  assert.equal(actions[0].short, 'aaaaaaa')
})

await check('mapActions：没有 id 时给空串而不是猜', () => {
  const actions = mapActions({ actions: [{ ordinal: 1, action: 'ask', date: 'd', title: 't' }] })
  assert.equal(actions[0].id, '')
  assert.equal(actions[0].short, '')
})

await check('buildFlow：默认焦点取最近动作，边按保留的节点过滤', () => {
  const payload = buildFlow({ repo: 'r', graph: graphOf(), histories: new Map([['a', historyOf('a', '2026-01-01T00:00:00+08:00')], ['b', historyOf('b', '2026-02-01T00:00:00+08:00')]]) })
  assert.equal(payload.focus, 'b')
  assert.equal(payload.edges.length, 1)
  assert.equal(payload.issues[0].last.title, 'first a')
})

// ---------------------------------------------------------------- trailer 解析

await check('parseTrailerRange：正常提交 → issue 集合', () => {
  const stdout = `\u001e${SHA_A}\u001fkiln-a,klin-b\u001fcollect\u001e${SHA_B}\u001fkiln-a\u001fapply`
  const parsed = parseTrailerRange(stdout)
  assert.equal(parsed.ok, true)
  assert.deepEqual([...parsed.ids].sort(), ['kiln-a', 'klin-b'])
})

await check('parseTrailerRange：chore 提交（两个 trailer 都空）→ 忽略', () => {
  const parsed = parseTrailerRange(`\u001e${SHA_A}\u001f\u001f`)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ids.size, 0)
})

await check('parseTrailerRange：有 action 没 issue → 不可判定', () => {
  assert.equal(parseTrailerRange(`\u001e${SHA_A}\u001f\u001fcollect`).ok, false)
})

await check('parseTrailerRange：字段错位 / 坏 sha → 不可判定', () => {
  assert.equal(parseTrailerRange(`\u001enot-a-sha\u001fkiln-a\u001fcollect`).ok, false)
  assert.equal(parseTrailerRange('\u001egarbage').ok, false)
})

// ---------------------------------------------------------------- 编排

await check('缓存：首次构建取全部 issue，第二次 HEAD 未动 → 0 次取数', async () => {
  const { flow, state } = makeFakeFlow()
  const { git } = makeFakeGit()
  const cache = createSnapshotCache({ git, flow })

  const first = await cache.get('r', { bin: 'b1' })
  assert.equal(first.ok, true)
  assert.equal(first.cache.action, 'build')
  assert.deepEqual(state.calls, ['graph', 'histories:a,b'])

  state.calls.length = 0
  const second = await cache.get('r', { bin: 'b1' })
  assert.equal(second.cache.action, 'hit')
  assert.deepEqual(state.calls, [], '命中时不应再取任何数据')
})

await check('缓存：HEAD 前进且只碰了 a → 只重取 a 的 path', async () => {
  const { flow, state } = makeFakeFlow()
  const { git, state: gitState } = makeFakeGit()
  const cache = createSnapshotCache({ git, flow })
  await cache.get('r', { bin: 'b1' })

  gitState.head = 'h2'
  gitState.delta = { ok: true, ids: new Set(['a']) }
  state.histories.set('a', [
    ...historyOf('a', '2026-01-01T00:00:00+08:00'),
    { ordinal: 2, action: 'apply', id: SHA_B, short: 'bbbbbbb', date: '2026-03-01T00:00:00+08:00', title: 'second a' },
  ])
  state.calls.length = 0

  const result = await cache.get('r', { bin: 'b1' })
  assert.equal(result.cache.action, 'incremental')
  assert.deepEqual(result.cache.issues, ['a'])
  assert.deepEqual(state.calls, ['graph', 'histories:a'])
  assert.equal(result.issues.find((issue) => issue.id === 'a').actions.length, 2)
})

await check('缓存：历史被改写（不是祖先）→ 全量重建', async () => {
  const { flow, state } = makeFakeFlow()
  const { git, state: gitState } = makeFakeGit()
  const cache = createSnapshotCache({ git, flow })
  await cache.get('r', { bin: 'b1' })

  gitState.head = 'h9'
  gitState.ancestor = false
  state.calls.length = 0

  const result = await cache.get('r', { bin: 'b1' })
  assert.equal(result.cache.action, 'build')
  assert.equal(result.cache.reason, 'history-rewritten')
  assert.deepEqual(state.calls, ['graph', 'histories:a,b'])
})

await check('缓存：增量不可判定（trailer 解析失败）→ 全量', async () => {
  const { flow } = makeFakeFlow()
  const { git, state: gitState } = makeFakeGit()
  const cache = createSnapshotCache({ git, flow })
  await cache.get('r', { bin: 'b1' })

  gitState.head = 'h3'
  gitState.delta = { ok: false }
  const result = await cache.get('r', { bin: 'b1' })
  assert.equal(result.cache.reason, 'delta-unusable')
})

await check('缓存：配置未提交改动 → 重建（不用等新提交）', async () => {
  const { flow, state } = makeFakeFlow()
  const { git, state: gitState } = makeFakeGit()
  const cache = createSnapshotCache({ git, flow })
  await cache.get('r', { bin: 'b1' })

  gitState.config = 'c2'
  state.calls.length = 0
  const result = await cache.get('r', { bin: 'b1' })
  assert.equal(result.cache.reason, 'config-changed')
  assert.deepEqual(state.calls, ['graph', 'histories:a,b'])
})

await check('缓存：构建失败不写缓存，下次会重试', async () => {
  const { flow, state } = makeFakeFlow()
  const { git, state: gitState } = makeFakeGit()
  const cache = createSnapshotCache({ git, flow })
  await cache.get('r', { bin: 'b1' })

  // 先制造一次“需要重建”（配置变更），再让 graph 失败
  gitState.config = 'c2'
  state.graphFails = true
  state.calls.length = 0
  const failed = await cache.get('r', { bin: 'b1' })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'not-kiln-repo')

  state.graphFails = false
  const retried = await cache.get('r', { bin: 'b1' })
  assert.equal(retried.ok, true)
  assert.equal(retried.cache.reason, 'config-changed')
})

await check('缓存：读不到 HEAD 时不缓存，但功能不降级', async () => {
  const { flow, state } = makeFakeFlow()
  const { git, state: gitState } = makeFakeGit()
  const cache = createSnapshotCache({ git, flow })
  gitState.head = null

  const first = await cache.get('r', { bin: 'b1' })
  assert.equal(first.ok, true)
  assert.equal(first.cache.reason, 'head-unavailable')

  state.calls.length = 0
  const second = await cache.get('r', { bin: 'b1' })
  assert.notEqual(second.cache.action, 'hit')
  assert.ok(state.calls.includes('graph'), '无 HEAD 时每次都重建')
})

let loaded = null

await check('client：能加载、导出形态正确、注册 id=kiln 的 conversation.view', async () => {
  globalThis.window = {
    __ModuleLoader__: {
      load: (definition) => {
        loaded = definition
      },
    },
  }
  globalThis.document = {
    // 返回非 null：ensureStyle 认为样式已注入，不去碰 DOM
    getElementById: () => ({}),
    createElement: () => ({}),
  }
  // 打开测试缝，后面要直接调用 paintFocus（只在测试里开）
  globalThis.__DSH_KILN_TEST__ = true
  await import('../lib/client.js?wiring=1')
  assert.equal(loaded?.id, '@local/dsh-kiln')

  const reactStub = {
    createElement: () => null,
    Fragment: 'fragment',
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
  }
  const mod = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`意外的 require: ${name}`)
  })
  assert.equal(mod.name, '@local/dsh-kiln')
  assert.deepEqual(mod.inject, ['slots', 'sessions'])

  let registered = null
  const ctx = {
    slots: {
      inject: (name, run) => {
        assert.equal(name, 'conversation.view')
        run()
      },
      register: (options, component) => {
        registered = { options, component }
      },
    },
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
  }
  mod.apply(ctx)
  assert.equal(registered?.options.id, 'kiln')
  assert.equal(registered?.options.order, 30)
  assert.equal(typeof registered?.component, 'function')
  assert.deepEqual(registered?.options.inject('missing-session'), { cwd: '' })
})

// ---------------------------------------------------------------- 图渲染器 chunk

await check('Pele chunk：名字合法、自注册、导出 mount', async () => {
  // DSH 的客户端加载器只接受 `client.<name>.js`，且要求 chunk 自己 load 注册；
  // 这两条错了，浏览器里只会看到 "loaded without registering"。
  let registered = null
  const previous = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load: (definition) => {
        registered = definition
      },
    },
  }
  try {
    await import('../lib/client.pele.js?chunk-test=1')
  } finally {
    globalThis.window = previous
  }
  assert.equal(registered?.id, '@local/dsh-kiln/client.pele.js')
  const exported = registered.factory()
  assert.equal(typeof exported?.mount, 'function')
  assert.equal(typeof exported?.render, 'function')
  const { svg } = exported.render('flowchart LR\n  a["a"] -->|caused-by| b["b"]')
  assert.match(svg, /^<svg/)
})

// ---------------------------------------------------------------- 边淡化

await check('边淡化：线、箭头、标签按同一个 data-id 一起淡，节点走自己的档', async () => {
  // Pele 的边标签是 .pele-edge 的兄弟节点，但 data-id 相同——这里是这条契约的回归用例。
  class FakeClassList {
    constructor(initial) {
      this.set = new Set(String(initial).split(' ').filter(Boolean))
    }
    contains(name) {
      return this.set.has(name)
    }
    toggle(name, on) {
      if (on) this.set.add(name)
      else this.set.delete(name)
    }
  }
  const element = (dataId, className) => ({
    attrs: { 'data-id': dataId },
    classList: new FakeClassList(className),
    getAttribute(name) {
      return this.attrs[name] ?? null
    },
  })
  const nodes = [element('n_a', 'pele-node'), element('n_b', 'pele-node'), element('n_c', 'pele-node')]
  const edges = [element('L_n_a_n_b_0', 'pele-edge'), element('L_n_b_n_c_0', 'pele-edge')]
  const labels = [element('L_n_a_n_b_0', 'pele-edge-label'), element('L_n_b_n_c_0', 'pele-edge-label')]
  const everything = [...nodes, ...edges, ...labels]
  const host = {
    querySelectorAll: (selector) => {
      if (selector === '.pele-node') return nodes
      if (selector === '.pele-edge, .pele-edge-label') return [...edges, ...labels]
      return []
    },
  }

  const built = {
    byNode: new Map([
      ['n_a', 'a'],
      ['n_b', 'b'],
      ['n_c', 'c'],
    ]),
    nodeOf: new Map([
      ['a', 'n_a'],
      ['b', 'n_b'],
      ['c', 'n_c'],
    ]),
  }
  const relations = [
    { a: 'b', b: 'a', rel: 'caused-by' },
    { a: 'b', b: 'c', rel: 'relates-to' },
  ]
  const reactStubForInternals = {
    createElement: () => null,
    Fragment: 'fragment',
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
  }
  const modForInternals = loaded.factory((name) => {
    if (name === 'react') return reactStubForInternals
    throw new Error('unexpected require: ' + name)
  })
  const { paintFocus, graphTiers } = modForInternals.__internals ?? {}
  assert.equal(typeof paintFocus, 'function', '需要 __DSH_KILN_TEST__ 暴露内部函数')

  // 焦点 b：a、c 都是一跳 → 两条边都该亮
  const stats = paintFocus(host, graphTiers('b', relations), built)
  assert.equal(stats.edges, 2)
  assert.equal(stats.labels, 2)
  assert.equal(stats.matched, 2, '两条边都该被认出来')
  assert.ok(!edges[0].classList.contains('dkf-gedge-dim'))
  assert.ok(!labels[0].classList.contains('dkf-gedge-label-dim'))

  // 焦点 a：b 是一跳，c 不在圈内 → b-c 那条线的线与标签一起淡
  paintFocus(host, graphTiers('a', relations), built)
  assert.ok(!edges[0].classList.contains('dkf-gedge-dim'), 'a-b 与焦点有关')
  assert.ok(edges[1].classList.contains('dkf-gedge-dim'), 'b-c 与焦点无关，线要淡')
  assert.ok(labels[1].classList.contains('dkf-gedge-label-dim'), 'b-c 的标签要一起淡')
  assert.ok(!labels[0].classList.contains('dkf-gedge-label-dim'))
  assert.ok(nodes[2].classList.contains('dkf-gnode-dim'), 'c 不在圈内，节点要淡')

  // 聚焦视图（没有 tier）：焦点高亮仍然在，两个视图共用同一个 class
  paintFocus(host, null, { ...built, focusId: 'b' })
  assert.ok(nodes[1].classList.contains('dkf-gnode-focus'), '聚焦视图里焦点必须被标出来')
  assert.ok(!nodes[0].classList.contains('dkf-gnode-focus'))
  assert.ok(!nodes[1].classList.contains('dkf-gnode-dim'), '聚焦视图不做淡化')

  // 焦点清空：全部恢复
  paintFocus(host, null, built)
  for (const item of everything) {
    assert.ok(!item.classList.contains('dkf-gedge-dim'))
    assert.ok(!item.classList.contains('dkf-gedge-label-dim'))
    assert.ok(!item.classList.contains('dkf-gnode-dim'))
  }
})

await check('图例淡化：未画类别压到 15%（与图上淡化分开调）', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const mod = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  })
  assert.match(mod.__internals.css, /\.dkf-legend-off\{opacity:\.15\}/)
})

await check('边淡化：认不出边元素时返回 0（上层据此提示，不静默）', async () => {
  const reactStubForInternals = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const { paintFocus } = loaded.factory((name) => { if (name === 'react') return reactStubForInternals; throw new Error('unexpected require: ' + name) }).__internals ?? {}
  const bare = { querySelectorAll: () => [] }
  const stats = paintFocus(bare, { focus: 'a', related: new Set(['a']), relations: [] }, { byNode: new Map(), nodeOf: new Map() })
  assert.equal(stats.edges, 0)
  assert.equal(stats.labels, 0)
})

await check('节点说明：优先 ask 的标题，没有 ask 退到最后一条动作', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const { issueSummary } = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals ?? {}
  assert.equal(typeof issueSummary, 'function', '需要 __DSH_KILN_TEST__ 暴露 issueSummary')

  const withAsk = {
    actions: [
      { action: 'ask', title: 'Agent 手握 git 时，CLI 还有多少必要性', date: '2026-10-14T20:40:07+08:00' },
      { action: 'collect', title: '收到的数字', date: '2026-10-15T09:00:00+08:00' },
    ],
  }
  assert.deepEqual(issueSummary(withAsk), {
    kind: 'ask',
    date: '2026-10-14T20:40:07+08:00',
    title: 'Agent 手握 git 时，CLI 还有多少必要性',
  })

  // ask 不在首位也要认出来（快照里动作按 ordinal 升序，但不能靠“第一条就是 ask”这个假设）
  const askLater = { actions: [{ action: 'collect', title: '先收集' }, { action: 'ask', title: '后问的' }] }
  assert.equal(issueSummary(askLater).title, '后问的')

  const noAsk = { actions: [{ action: 'collect', title: '收到的数字', date: '2026-10-02' }] }
  assert.deepEqual(issueSummary(noAsk), { kind: 'last', date: '2026-10-02', title: '收到的数字' })
  assert.deepEqual(issueSummary({}), { kind: 'none', date: '', title: '' })
})

await check('说明框定位：靠边翻转，拿不到窗口尺寸时不翻', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const { tipPlacement } = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals ?? {}
  assert.equal(typeof tipPlacement, 'function', '需要 __DSH_KILN_TEST__ 暴露 tipPlacement')

  assert.deepEqual(tipPlacement(100, 100, 1200, 800), {
    left: '114px',
    top: '118px',
    transform: 'translate(0, 0)',
  })
  assert.deepEqual(tipPlacement(1100, 780, 1200, 800), {
    left: '1086px',
    top: '768px',
    transform: 'translate(-100%, -100%)',
  })
  assert.equal(tipPlacement(1100, 780, 0, 0).transform, 'translate(0, 0)')
})

await check('调宽手柄：只在 .dkf-root 挂载时藏掉（切回对话页自动恢复）', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const mod = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  })
  const css = mod.__internals.css
  assert.ok(
    css.includes('[data-conversation-content]:has(.dkf-root) [data-width-handle]{display:none}'),
    '规则必须用 :has(.dkf-root) 限定，切回对话页才能自动恢复',
  )
  assert.ok(!/\n\[data-width-handle\]\{display:none\}/.test(css), '不能写不带作用域的规则')
})

await check('深色主题：Pele 的 8 个主题变量都接到 --dkf-* 上（不接就永远是白底深字）', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const css = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals.css
  const pairs = [
    ['--pele-line', '--dkf-fg2'],
    ['--pele-surface', '--dkf-raise'],
    ['--pele-fg', '--dkf-fg'],
    ['--pele-muted', '--dkf-fg3'],
    ['--pele-bg', '--dkf-raise'],
    ['--pele-border', '--dkf-line-2'],
    ['--pele-accent', '--dkf-accent'],
  ]
  for (const [pele, ours] of pairs) {
    assert.ok(css.includes(`${pele}:var(${ours})`), `${pele} 必须接到 ${ours}`)
  }
})

await check('深色主题：淡化色向画布混，不再混白底（否则越淡越亮）', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const css = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals.css
  assert.ok(css.includes('--dkf-canvas:var(--dkf-bg2)'), '画布色要有自己的名字')
  assert.match(css, /--dkf-dim-edge-color:color-mix\(in srgb,var\(--dkf-fg2\)[^;]*var\(--dkf-canvas\)\)/)
  assert.ok(!css.includes('var(--_fg,'), '不能再拿 Pele 的浅色默认值当混色起点')
  assert.ok(!css.includes('var(--_bg)'), '也不能再拿白底当混色终点')
})

await check('图的字体：字号读容器计算值并夹在 8–24，异常退回 12', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const { graphFontSize } = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals ?? {}
  assert.equal(typeof graphFontSize, 'function', '需要 __DSH_KILN_TEST__ 暴露 graphFontSize')
  assert.equal(graphFontSize({ fontSize: '12px' }), 12, '与 .dkf-root 的正文同号')
  assert.equal(graphFontSize({ fontSize: '13.4px' }), 13)
  assert.equal(graphFontSize({ fontSize: '2px' }), 8, '太小要夹住')
  assert.equal(graphFontSize({ fontSize: '40px' }), 24, '太大要夹住')
  assert.equal(graphFontSize({}), 12, '读不到字号时退回 12')
  assert.equal(graphFontSize(null), 12, '没有计算样式时退回 12')
  assert.equal(graphFontSize(undefined), 12)
})

await check('图的字体：字族/等宽接到 --dkf-sans / --dkf-mono', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const css = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals.css
  assert.ok(css.includes('--pele-font:var(--dkf-sans)'), 'Pele 的字族要走统一角色')
  assert.ok(css.includes('--pele-font-mono:var(--dkf-mono)'), '等宽要走宿主的代码字体')
})

await check('hover：只有一条"叠一层"的规则，三页的元素都在里面', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const css = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals.css
  const overlay = 'background-image:linear-gradient(var(--dkf-hover),var(--dkf-hover))'
  assert.equal(css.split(overlay).length - 1, 1, '叠底公式只能出现一次（一处定义，多处引用选择器）')
  const at = css.indexOf(overlay)
  const selector = css.slice(css.lastIndexOf('}', at) + 1, css.indexOf('{', at))
  for (const name of ['refresh', 'focuschip', 'tab', 'modebtn', 'row', 'focus', 'crumb', 'subrow', 'arow', 'toggle', 'focusbtn']) {
    assert.ok(selector.includes(`.dkf-${name}:hover`), `.dkf-${name} 必须走同一条 hover 规则`)
  }
  assert.ok(!css.includes('background:var(--dkf-hover)'), '不能再退回"直接换底色"的写法（会盖掉焦点行的底色）')
  assert.ok(!css.includes('.dkf-focus:hover{background:var(--dkf-bg2)}'), '焦点行不能还是"没有反馈"的那个例外')
})

await check('hover：图里指到淡化的节点，把它拉回正常亮度', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const css = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals.css
  assert.ok(css.includes('.dkf-gnode-dim:hover{opacity:1}'), '淡化节点 hover 要恢复')
  assert.ok(css.includes('.dkf-graph .pele-node{cursor:pointer}'), '可点的节点要有可点的光标')
})

await check('提示框：只有一套 .dkf-tip 样式，多行提示靠 pre-line 换行', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const css = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals.css
  assert.equal(css.split('.dkf-tip{').length - 1, 1, '提示框样式只能定义一处')
  assert.match(css, /\.dkf-tip-title\{[^}]*white-space:pre-line/, '多行提示（cwd + 快照）要能换行')
})

await check('筛选：facets 只给"有得选"的分组，并按数量降序', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const { issueFacets } = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals ?? {}
  assert.equal(typeof issueFacets, 'function', '需要 __DSH_KILN_TEST__ 暴露 issueFacets')

  const issues = [
    { id: 'a', domain: 'design', tags: ['ui'], done: true },
    { id: 'b', domain: 'cli', tags: [], done: false },
    { id: 'c', domain: 'cli', tags: ['ui', 'perf'], done: false },
  ]
  const facets = issueFacets(issues)
  assert.deepEqual(facets.domains.map((o) => [o.id, o.count]), [['cli', 2], ['design', 1]])
  assert.deepEqual(facets.states.map((o) => [o.id, o.count]), [['open', 2], ['done', 1]])
  assert.deepEqual(facets.tags.map((o) => [o.id, o.count]), [['ui', 2], ['perf', 1]])

  const single = issueFacets([{ id: 'a', domain: 'x', tags: [], done: true }])
  assert.deepEqual(single.domains, [], '只有一个领域就不给这一组')
  assert.deepEqual(single.states, [], '只有一个状态就不给这一组')
  assert.deepEqual(single.tags, [], '没有标签就不给这一组')
})

await check('筛选：同组多选是 OR，组间是 AND', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const { filterIssues, readFilters, filtersActive } = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals ?? {}
  const issues = [
    { id: 'a', domain: 'design', tags: ['ui'], done: true },
    { id: 'b', domain: 'cli', tags: [], done: false },
    { id: 'c', domain: 'cli', tags: ['ui', 'perf'], done: false },
  ]
  const ids = (list) => list.map((issue) => issue.id).join(',')
  assert.equal(ids(filterIssues(issues, { domains: ['cli'], tags: [], states: [] })), 'b,c')
  assert.equal(ids(filterIssues(issues, { domains: ['cli', 'design'], tags: [], states: [] })), 'a,b,c', '同组多选是 OR')
  assert.equal(ids(filterIssues(issues, { domains: ['cli'], tags: ['perf'], states: [] })), 'c', '组间是 AND')
  assert.equal(ids(filterIssues(issues, { domains: [], tags: [], states: ['done'] })), 'a')
  assert.equal(ids(filterIssues(issues, readFilters(undefined))), 'a,b,c', '没筛选就是原样')
  assert.equal(filtersActive(readFilters(null)), false)
  assert.equal(filtersActive({ domains: ['x'], tags: [], states: [] }), true)
})

await check('时间线筛选：动作与领域两组，过滤的是动作行', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const { rowFacets, filterRows, readRowFilters } = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals ?? {}
  assert.equal(typeof rowFacets, 'function', '需要 __DSH_KILN_TEST__ 暴露 rowFacets')

  const byId = new Map([
    ['a', { id: 'a', domain: 'design' }],
    ['b', { id: 'b', domain: 'cli' }],
  ])
  const rows = [
    { issueId: 'a', action: 'ask' },
    { issueId: 'a', action: 'apply' },
    { issueId: 'b', action: 'ask' },
  ]
  const facets = rowFacets(rows, byId)
  assert.deepEqual(facets.actions.map((o) => [o.id, o.count]), [['ask', 2], ['apply', 1]])
  assert.deepEqual(facets.domains.map((o) => [o.id, o.count]), [['design', 2], ['cli', 1]])

  const single = rowFacets([{ issueId: 'a', action: 'ask' }], byId)
  assert.deepEqual(single.actions, [], '只有一种动作就不给这一组')
  assert.deepEqual(single.domains, [], '只有一个领域就不给这一组')

  assert.equal(filterRows(rows, { actions: ['apply'], domains: [] }, byId).length, 1, '按动作名')
  assert.equal(filterRows(rows, { actions: [], domains: ['cli'] }, byId).length, 1, '按动作所属 issue 的领域')
  assert.equal(filterRows(rows, { actions: ['ask'], domains: ['design'] }, byId).length, 1, '组间 AND')
  assert.equal(filterRows(rows, readRowFilters(undefined), byId).length, 3, '没筛选就是原样')
})

await check('标签筛选的语义：组名上挂「并集」提示（tag 是动作级的）', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const { filterGroups } = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals ?? {}
  const tags = (filterGroups ?? []).find((group) => group.id === 'tags')
  assert.ok(tags !== undefined, '标签必须是一组')
  assert.match(String(tags.hint ?? ''), /并集/, 'tag 源在动作的 trailer 上，筛选是"任一动作带过"，要在提示里说清')
})

// ---------------------------------------------------------------- 汇总
console.log('')
if (failures.length === 0) {
  console.log(`全部通过：${passed} 个用例`)
} else {
  console.log(`通过 ${passed}，失败 ${failures.length}`)
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.stack ?? failure.error}`)
  process.exitCode = 1
}
