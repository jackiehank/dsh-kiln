/**
 * 宿主侧单元测试：只测纯逻辑与可注入的编排，不起任何子进程。
 *
 * 用法：`node plugin/test/run.mjs`（不依赖测试框架，沙箱里也能跑）。
 * 真正 fork `kiln` / `git` 的路径在本机沙箱里会被 EPERM 拦住，那一层靠浏览器/桌面端实机验证。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { buildGraph, mapActions, parseIssueDocument, searchDocumentError } from '../lib/flow.js'
import { createRowsCache, evaluateRowsCache } from '../lib/rowsCache.js'
import { createSnapshotCache, evaluateCache } from '../lib/snapshot.js'
import { createTimelineHandler } from '../lib/timelineHandler.js'
import { actionsCacheKey } from '../lib/index.js'
import {
  actionLogArgs,
  actionLogProblem,
  consumeActionLog,
  createLineSplitter,
  mapActionRecord,
} from '../lib/timeline.js'

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
    // 断言失败的关键信息在第二行起（expected/actual），整段打出来才排得动
    for (const line of String(error?.message ?? error).split('\n')) console.log(`     ${line}`)
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

function makeFakeFlow() {
  const state = {
    graph: graphOf(),
    calls: [],
    graphFails: false,
    /** 闸门：把取数挂起来，用来排并发请求的时序。 */
    graphGate: null,
    /** 取数层抛错（例如 kiln 版本过旧）；保持 null 表示正常返回。 */
    graphError: null,
    /** 每次调用时通知测试（排“是否同时发出”）。 */
    onCall: null,
  }
  const note = (name) => {
    state.calls.push(name)
    if (typeof state.onCall === 'function') state.onCall(name)
  }
  const flow = {
    readGraph: async () => {
      note('graph')
      if (state.graphGate !== null) await state.graphGate
      if (state.graphError !== null) throw state.graphError
      return state.graphFails ? { ok: false, reason: 'not-kiln-repo' } : { ok: true, graph: state.graph }
    },
    buildGraph: (input) => buildGraph(input),
  }
  return { flow, state }
}

function makeFakeGit() {
  const state = { head: 'h1', config: 'c1', bin: 'b1', calls: [], onCall: null }
  const note = (name) => {
    state.calls.push(name)
    if (typeof state.onCall === 'function') state.onCall(name)
  }
  const git = {
    readHead: async () => {
      note('head')
      return state.head
    },
    configToken: () => state.config,
    binaryToken: () => state.bin,
  }
  return { git, state }
}

const probe = (over = {}) => ({ repo: 'r', head: 'h1', configToken: 'c1', binToken: 'b1', ...over })
const previous = (over = {}) => ({ repo: 'r', head: 'h1', configToken: 'c1', binToken: 'b1', payload: {}, ...over })

// ---------------------------------------------------------------- 失效决策

await check('evaluateCache：冷启动 → build', () => {
  assert.equal(evaluateCache(null, probe()).action, 'build')
})

await check('evaluateCache：四元组全同 → hit', () => {
  const decision = evaluateCache(previous(), probe())
  assert.equal(decision.action, 'hit')
  assert.equal(decision.reason, 'head-unchanged')
})

await check('evaluateCache：HEAD 前进 → changed（直接全量重建）', () => {
  assert.equal(evaluateCache(previous(), probe({ head: 'h2' })).action, 'changed')
})

await check('evaluateCache：配置变了 → build（未提交也会失效）', () => {
  assert.equal(evaluateCache(previous(), probe({ configToken: 'c2' })).reason, 'config-changed')
})

await check('evaluateCache：kiln 二进制变了 → build', () => {
  assert.equal(evaluateCache(previous(), probe({ binToken: 'b2' })).reason, 'binary-changed')
})

await check('evaluateCache：仓库变了 → build', () => {
  assert.equal(evaluateCache(previous(), probe({ repo: 'other' })).reason, 'repo-changed')
})

// ---------------------------------------------------------------- 文档变换

await check('buildGraph：节点只带结构字段，边缺 directed 时按有向处理', () => {
  const payload = buildGraph({ repo: 'r', graph: graphOf() })
  assert.equal(payload.ok, true)
  assert.equal(payload.issues.length, 2)
  assert.equal(payload.issues[0].id, 'a')
  assert.equal(payload.issues[0].done, true)
  assert.equal(payload.issues[0].actions, undefined, '动作在详情里，不在图节点上')
  assert.equal(payload.edges[0].directed, true)
  assert.equal(payload.total, undefined, '不再有 80 条上限与截断标记')
  assert.equal(payload.truncated, undefined)
})

await check('buildGraph：长标题按 200 字截断（与列表同一套渲染口径）', () => {
  const long = 'x'.repeat(260)
  const payload = buildGraph({ repo: 'r', graph: { nodes: [{ id: 'a', title: long }], edges: [] } })
  assert.equal(payload.issues[0].title.length, 200)
  assert.ok(payload.issues[0].title.endsWith('…'))
})

await check('mapActions：commit 保留完整 sha 并派生短哈希', () => {
  const mapped = mapActions({
    actions: [{ ordinal: 1, action: 'ask', commit: SHA_A, date: 'd', title: 't', refs: ['x'] }],
  })
  assert.equal(mapped[0].id, SHA_A)
  assert.equal(mapped[0].short, 'aaaaaaa')
  assert.deepEqual(mapped[0].refs, ['x'])
})

await check('mapActions：没有 commit 时给空串（不再读 v0.1.1 的 id）', () => {
  const mapped = mapActions({ actions: [{ ordinal: 1, action: 'ask' }] })
  assert.equal(mapped[0].id, '')
  assert.equal(mapped[0].short, '')
})

await check('parseIssueDocument：单条 pathDoc → 动作 + 这个 issue 的全部边', () => {
  const parsed = parseIssueDocument(
    {
      issue: 'a',
      action: 'apply',
      done: true,
      actions: [{ ordinal: 1, action: 'ask', commit: SHA_A, date: 'd', title: 't' }],
      relations: [
        { from: 'a', to: 'b', name: 'relates-to', directed: false },
        { from: 'c', to: 'a', name: 'part-of' },
      ],
    },
    'a',
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.issue.id, 'a')
  assert.equal(parsed.issue.done, true)
  assert.equal(parsed.issue.actions.length, 1)
  assert.equal(parsed.issue.relations.length, 2)
  assert.equal(parsed.issue.relations[1].directed, true)
})

await check('parseIssueDocument：回来的不是请求的 id → 明说，不静默换人', () => {
  const parsed = parseIssueDocument({ issue: 'b', actions: [] }, 'a')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.reason, 'mismatch')
  assert.match(parsed.message, /b/)
})

await check('parseIssueDocument：形状不认识 → 报 shape（旧版 / 坏输出）', () => {
  assert.equal(parseIssueDocument({}, 'a').reason, 'shape')
  assert.equal(parseIssueDocument(null, 'a').reason, 'shape')
  assert.equal(parseIssueDocument({ issue: 'a', actions: 'nope' }, 'a').reason, 'shape')
})

// ---------------------------------------------------------------- 编排（图缓存）

await check('缓存：先探 HEAD 再取图；第二次 HEAD 未动 → 0 次取数', async () => {
  const { flow, state } = makeFakeFlow()
  const { git, state: gitState } = makeFakeGit()
  const cache = createSnapshotCache({ git, flow })

  const first = await cache.get('r', { bin: 'b1' })
  assert.equal(first.ok, true)
  assert.equal(first.cache.action, 'build')
  assert.deepEqual(gitState.calls, ['head'])
  assert.deepEqual(state.calls, ['graph'])

  state.calls.length = 0
  const second = await cache.get('r', { bin: 'b1' })
  assert.equal(second.cache.action, 'hit')
  assert.deepEqual(state.calls, [], '命中时不应再取任何数据')
})

await check('缓存：HEAD 前进 → 整张图重取（不再按 issue 增量）', async () => {
  const { flow, state } = makeFakeFlow()
  const { git, state: gitState } = makeFakeGit()
  const cache = createSnapshotCache({ git, flow })
  await cache.get('r', { bin: 'b1' })

  gitState.head = 'h2'
  state.calls.length = 0
  const result = await cache.get('r', { bin: 'b1' })
  assert.equal(result.cache.action, 'build')
  assert.equal(result.cache.reason, 'head-moved')
  assert.deepEqual(state.calls, ['graph'])
  assert.equal(result.issues.length, 2)
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
  assert.deepEqual(state.calls, ['graph'])
})

await check('缓存：构建失败不写缓存，下次会重试', async () => {
  const { flow, state } = makeFakeFlow()
  const { git, state: gitState } = makeFakeGit()
  const cache = createSnapshotCache({ git, flow })
  await cache.get('r', { bin: 'b1' })

  gitState.config = 'c2'
  state.graphFails = true
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

await check('缓存：cache.ms 是宿主侧实测耗时（界面上要能复核）', async () => {
  const { flow } = makeFakeFlow()
  const { git } = makeFakeGit()
  const cache = createSnapshotCache({ git, flow })
  const result = await cache.get('r', { bin: 'b1' })
  assert.equal(typeof result.cache.ms, 'number')
  assert.ok(result.cache.ms >= 0)
})

await check('缓存：同仓并发请求只构建一次（连点刷新不跑两遍子进程）', async () => {
  const { flow, state } = makeFakeFlow()
  const { git } = makeFakeGit()
  const cache = createSnapshotCache({ git, flow })

  let release = null
  state.graphGate = new Promise((resolve) => {
    release = resolve
  })

  const first = cache.get('r', { bin: 'b1' })
  const second = cache.get('r', { bin: 'b1' })
  state.graphGate = null
  release()
  const [a, b] = await Promise.all([first, second])

  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(a.cache.action, 'build')
  assert.equal(b.cache.action, 'coalesced')
  assert.deepEqual(state.calls, ['graph'], '一轮构建只该取一遍图')
  assert.equal(a.issues.length, 2)
  assert.equal(b.issues.length, 2)
})

await check('缓存：合并只认同一 HEAD（构建期间 HEAD 又动了就不复用）', async () => {
  const { flow, state } = makeFakeFlow()
  const { git, state: gitState } = makeFakeGit()
  const cache = createSnapshotCache({ git, flow })

  let release = null
  state.graphGate = new Promise((resolve) => {
    release = resolve
  })

  const first = cache.get('r', { bin: 'b1' })
  await new Promise((resolve) => setImmediate(resolve))
  gitState.head = 'h2'
  const second = cache.get('r', { bin: 'b1' })
  state.graphGate = null
  release()
  const [a, b] = await Promise.all([first, second])

  assert.equal(a.cache.action, 'build')
  assert.notEqual(b.cache.action, 'coalesced', '不同 HEAD 的记录不能顶给新请求')
  assert.equal(b.ok, true)
  assert.equal(state.calls.filter((call) => call === 'graph').length, 2, '第二个请求要自己取一遍')
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
  const layer = '--dkf-hover-layer:linear-gradient(var(--dkf-hover),var(--dkf-hover))'
  assert.equal(css.split(layer).length - 1, 1, 'hover 底色只定义一次（变量），各处引用它')
  const at = css.indexOf('background-image:var(--dkf-hover-layer)')
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
  assert.equal(facets.tags, undefined, '标签已不是筛选维度（动作级数据，视图只有并集，且标签太多）')

  const single = issueFacets([{ id: 'a', domain: 'x', tags: [], done: true }])
  assert.deepEqual(single.domains, [], '只有一个领域就不给这一组')
  assert.deepEqual(single.states, [], '只有一个状态就不给这一组')
})

await check('筛选：同组多选是 OR，组间是 AND', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const { filterIssues, readFilters, filtersActive } = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals ?? {}
  const issues = [
    { id: 'a', domain: 'design', done: true },
    { id: 'b', domain: 'cli', done: false },
    { id: 'c', domain: 'cli', done: false },
  ]
  const ids = (list) => list.map((issue) => issue.id).join(',')
  assert.equal(ids(filterIssues(issues, { domains: ['cli'], states: [] })), 'b,c')
  assert.equal(ids(filterIssues(issues, { domains: ['cli', 'design'], states: [] })), 'a,b,c', '同组多选是 OR')
  assert.equal(ids(filterIssues(issues, { domains: ['cli'], states: ['open'] })), 'b,c', '组间是 AND')
  assert.equal(ids(filterIssues(issues, { domains: ['design'], states: ['open'] })), '', '领域与状态交叉为空')
  assert.equal(ids(filterIssues(issues, { domains: [], states: ['done'] })), 'a')
  assert.equal(ids(filterIssues(issues, readFilters(undefined))), 'a,b,c', '没筛选就是原样')
  assert.equal(filtersActive(readFilters(null)), false)
  assert.equal(filtersActive({ domains: ['x'], states: [] }), true)
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

await check('搜索：切词/高亮 + 宿主行映射（rank/hit 由 kiln 给，不再自己匹配）', () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const { splitTerms, mapSearchRows, matchRanges } = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals ?? {}
  assert.equal(typeof mapSearchRows, 'function', '需要 __DSH_KILN_TEST__ 暴露 mapSearchRows')

  assert.deepEqual(splitTerms('  Graph   UI '), ['graph', 'ui'], '按空白切词并小写')
  assert.deepEqual(splitTerms('   '), [])
  assert.deepEqual(matchRanges('Kiln-Graph', ['graph']), [[5, 10]])
  assert.deepEqual(matchRanges('aaaa', ['aa']), [[0, 4]], '相邻区间合并成一段')

  const a = {
    id: 'a',
    title: 'A 标题',
    domain: 'integration',
    done: false,
    actions: [{ action: 'ask', title: 'ask 动作 1', id: 'sha-a1', ordinal: 1, date: '2026-01-01' }],
    last: { date: '2026-01-01' },
  }
  const b = {
    id: 'b',
    title: 'B 标题',
    domain: 'cli',
    done: true,
    actions: [
      { action: 'ask', title: 'ask 动作 1', id: 'sha-b1', ordinal: 1, date: '2026-02-01' },
      { action: 'apply', title: '落地 搜索框', id: 'sha-apply', ordinal: 2, date: '2026-02-02' },
    ],
    last: { date: '2026-02-02' },
  }
  const document = {
    count: 3,
    issues: [
      { id: 'a', rank: 0, title: 'A 标题', domain: 'integration', done: false, hit: null },
      {
        id: 'b',
        rank: 3,
        title: 'B 标题',
        domain: 'cli',
        done: true,
        hit: { ordinal: 2, action: 'apply', commit: 'sha-apply', subject: '落地 搜索框', total: 2, date: '2026-02-02T10:00:00+08:00' },
      },
      { id: 'c', rank: 4, title: 'C 标题', domain: 'docs', done: false, hit: null },
    ],
  }
  const rows = mapSearchRows(document, new Map([['a', a], ['b', b]]), splitTerms('搜索'))
  assert.deepEqual(rows.map((row) => row.issue.id), ['a', 'b', 'c'], '顺序由 kiln 决定，不再本地排序')
  assert.equal(rows[0].action, null)
  assert.equal(rows[0].date, '2026-01-01', '没 hit 时退回快照里最后一条动作的日期')
  assert.equal(rows[1].issue, b, '快照里有的 issue 用完整对象（色条/展开要靠 actions）')
  assert.equal(rows[1].action, 'apply')
  assert.equal(rows[1].actionId, 'sha-apply')
  assert.equal(rows[1].ordinal, 2)
  assert.equal(rows[1].total, 2)
  assert.equal(rows[1].date, '2026-02-02')
  assert.equal(rows[1].title, '落地 搜索框', '命中动作时显示命中的那条标题')
  assert.deepEqual(rows[1].titleRanges, [[3, 5]], '高亮落在展示的标题上')
  assert.equal(rows[2].issue.actions.length, 0, '快照外的命中退化成最小行')
  assert.equal(rows[2].issue.id, 'c')
})

await check('搜索文档校验：旧二进制没有 rank / hit.total 就明说需要 v0.2.1+', () => {
  assert.equal(searchDocumentError({ issues: [] }), null)
  assert.equal(
    searchDocumentError({ issues: [{ id: 'a', rank: 0, hit: null }] }),
    null,
    '新形状合格',
  )
  assert.match(searchDocumentError({ issues: [{ id: 'a', hit: null }] }), /v0\.2\.1\+/)
  assert.match(
    searchDocumentError({ issues: [{ id: 'a', rank: 0, hit: { ordinal: 1, action: 'ask', commit: 's', subject: 't' } }] }),
    /total/,
  )
  assert.match(
    searchDocumentError({ issues: [{ id: 'a', rank: 0, hit: { ordinal: 1, action: 'ask', commit: 's', subject: 't', total: 2 } }] }),
    /date/,
  )
})

await check('搜索框真居中：页头是左右等宽的三栏网格，输入框占中间那栏', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const css = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals.css
  assert.match(
    css,
    /\.dkf-head\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(96px,min\(360px,40%\)\) minmax\(0,1fr\)/,
    '左右两栏必须等宽，否则"剩下的空白居中"不是真居中',
  )
  assert.ok(css.includes('.dkf-head-actions{'), '右侧动作要单独成一栏（否则栏宽由内容决定，居中会偏）')
})

await check('选中一行：与鼠标经过同一层底色，不加额外强调', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const css = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals.css
  assert.ok(
    css.includes('.dkf-hit-on{background-image:var(--dkf-hover-layer)}'),
    '搜索选中 = 鼠标经过的那层底色（同一个变量，与 issue 行同一套观感）',
  )
  assert.ok(!/\.dkf-hit-on[^{]*\{[^}]*dkf-accent/.test(css), '不要强调条')
  assert.match(
    css,
    /\.dkf-focus\{background:var\(--dkf-bg2\);box-shadow:inset 0 0 0 \.5px var\(--dkf-line\)\}/,
    'issue 焦点行回到原来那条（与普通行一致，只是底色不同）',
  )
})
await check('标签已不作为筛选维度：组清单里只剩领域与状态', async () => {
  const reactStub = { createElement: () => null, Fragment: 'fragment', useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f() }
  const { filterGroups } = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  }).__internals ?? {}
  assert.deepEqual((filterGroups ?? []).map((group) => group.id), ['domains', 'states'])
})
// ---------------------------------------------------------------- 时间线流（kiln v0.3.0 action log --jsonl）

/** 假子进程：stdout/stderr 是可手动 emit 的数据源，生命周期由测试自己收口。 */
function childStub() {
  const child = new EventEmitter()
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
  return child
}

await check('时间线：chunk 不按行到，半行留到下一块，CRLF 也认', () => {
  const splitter = createLineSplitter()
  assert.deepEqual(splitter.push('{"a":1}\n{"b"'), ['{"a":1}'], '没有换行的尾巴不算一行')
  assert.deepEqual(splitter.push(':2}\r\n'), ['{"b":2}'])
  assert.deepEqual(splitter.flush(), [])
  assert.deepEqual(splitter.push('tail'), [])
  assert.deepEqual(splitter.flush(), ['tail'], '没有换行收尾的最后一行不能丢')
})

await check('时间线：记录按契约映射，缺省字段就是空（键不存在 ≠ null）', () => {
  const row = mapActionRecord({
    issue: 'a',
    action: 'apply',
    commit: SHA_A,
    date: '2026-10-28T23:06:28+08:00',
  })
  assert.deepEqual(row, {
    issueId: 'a',
    action: 'apply',
    id: SHA_A,
    short: 'aaaaaaa',
    date: '2026-10-28T23:06:28+08:00',
    title: '',
    domain: '',
    tags: [],
  })
  const full = mapActionRecord({
    issue: 'b',
    action: 'test',
    commit: SHA_B,
    date: '2026-10-28T00:00:00Z',
    title: 'x'.repeat(250),
    domain: 'integration',
    tags: ['plugin', 'flow'],
  })
  assert.equal(full.title.length, 200, '标题沿用快照同样的 200 字截断')
  assert.equal(full.domain, 'integration')
  assert.deepEqual(full.tags, ['plugin', 'flow'])
  assert.equal(mapActionRecord({ issue: 'a', action: 'apply' }), null, '缺 commit 是坏行')
  assert.equal(mapActionRecord(null), null)
})

await check('时间线：limit 只给正数，0/负数当作全量', () => {
  assert.deepEqual(actionLogArgs(0), ['action', 'log', '--jsonl'])
  assert.deepEqual(actionLogArgs(-3), ['action', 'log', '--jsonl'])
  assert.deepEqual(actionLogArgs(5), ['action', 'log', '--jsonl', '--limit', '5'])
})

await check('时间线：失败文案——旧版指路 v0.3.0+，其他错误原样给出', () => {
  assert.equal(actionLogProblem(0, ''), null)
  assert.match(actionLogProblem(2, '未知子命令: action'), /v0\.3\.0\+/)
  assert.match(actionLogProblem(1, 'unknown command "action log"'), /v0\.3\.0\+/)
  assert.match(actionLogProblem(1, 'fatal: bad revision HEAD'), /bad revision/)
  assert.match(actionLogProblem(-1, ''), /退出码 -1/)
})

await check('时间线：逐条回调、跨块拼行、坏行不吞、done 只来一次', () => {
  const calls = []
  const child = childStub()
  consumeActionLog(child, {
    onRecord: (row) => calls.push(row.issueId),
    onError: (message) => calls.push(`err:${message.slice(0, 4)}`),
    onDone: (info) => calls.push(`done:${info.code}:${info.count}:${info.failed}`),
  })
  child.stdout.emit(
    'data',
    `{"issue":"a","action":"ask","commit":"${SHA_A}","date":"2026-10-01T00:00:00+08:00"}\n{"issue":"b"`,
  )
  child.stdout.emit(
    'data',
    `,"action":"apply","commit":"${SHA_B}","date":"2026-10-02T00:00:00+08:00"}\nnot json\n`,
  )
  child.emit('close', 0)
  assert.deepEqual(calls, ['a', 'b', 'err:acti', 'done:0:2:true'])

  const errors = []
  const failedSpawn = childStub()
  consumeActionLog(failedSpawn, {
    onError: (message) => errors.push(message),
    onDone: () => errors.push('done'),
  })
  failedSpawn.emit('error', new Error('spawn kiln ENOENT'))
  failedSpawn.emit('close', -1)
  assert.deepEqual(errors, ['spawn kiln ENOENT', 'done'], 'error 之后 close 不能把 done 再说一遍')
})

// ---------------------------------------------------------------- 动作流缓存（rowsCache + timelineHandler）

const CACHE_ROWS = [
  { issue: 'a', action: 'ask', commit: SHA_A, date: '2026-10-01T00:00:00+08:00', title: 'A' },
  { issue: 'b', action: 'apply', commit: SHA_B, date: '2026-10-02T00:00:00+08:00', title: 'B' },
]
const CACHE_NDJSON = `${CACHE_ROWS.map((row) => JSON.stringify(row)).join('\n')}\n`

/** 假 res：够用的写端 + 一个能手动收口的连接事件。 */
function makeFakeRes() {
  const bus = new EventEmitter()
  const state = { chunks: [], headers: {}, ended: false }
  const res = {
    statusCode: 0,
    get writableEnded() {
      return state.ended
    },
    setHeader(name, value) {
      state.headers[String(name).toLowerCase()] = String(value)
    },
    write(chunk) {
      if (state.ended) return false
      state.chunks.push(String(chunk))
      return true
    },
    end() {
      if (state.ended) return
      state.ended = true
      bus.emit('close')
    },
    on(name, fn) {
      bus.on(name, fn)
      return res
    },
    once(name, fn) {
      bus.once(name, fn)
      return res
    },
    off(name, fn) {
      bus.off(name, fn)
      return res
    },
  }
  const events = () =>
    state.chunks
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
  const disconnect = () => bus.emit('close')
  return { res, state, events, disconnect }
}

/** 假子进程：能 emit 数据，也记账 kill 与 pause（背压路径要能看到）。 */
function streamChild() {
  const child = childStub()
  child.killed = 0
  child.kill = () => {
    child.killed += 1
  }
  child.stdout.pause = () => {}
  child.stdout.resume = () => {}
  return child
}

function timelineHarness(options = {}) {
  const state = {
    head: options.head ?? 'h1',
    config: 'c1',
    bin: 'b1',
    enabled: options.enabled ?? true,
    spawns: 0,
    children: [],
    /** 增量前置：祖先与区间日期由测试直接摆布。 */
    ancestor: options.ancestor ?? true,
    range: options.range ?? { count: 0, min: 0 },
    probes: [],
    headCalls: 0,
    /** 模拟“读前缀期间又有人提交”：从第 N 次 readHead 起返回 raceHead。 */
    raceFrom: null,
    raceHead: 'h-race',
  }
  const git = {
    readHead: async () => {
      state.headCalls += 1
      if (Number.isInteger(state.raceFrom) && state.headCalls >= state.raceFrom) return state.raceHead
      return state.head
    },
    configToken: () => state.config,
    binaryToken: () => state.bin,
    isAncestor: async (_repo, from, to) => {
      state.probes.push(`ancestor:${from}->${to}`)
      return state.ancestor
    },
    rangeAuthorTimes: async (_repo, from, to) => {
      state.probes.push(`range:${from}..${to}`)
      return state.range
    },
  }
  const cache = createRowsCache({
    git,
    rowsLimit: options.rowsLimit ?? 1000,
    bytesLimit: options.bytesLimit ?? 1 << 20,
    repoLimit: options.repoLimit ?? 2,
    incrementMinRows: options.incrementMinRows ?? 0,
    incrementMaxCommits: options.incrementMaxCommits ?? 100,
  })
  const handler = createTimelineHandler({
    resolveKiln: () => '/bin/kiln',
    repoProblem: () => null,
    spawnActionLog: () => {
      state.spawns += 1
      const child = streamChild()
      state.children.push(child)
      return child
    },
    consumeActionLog,
    actionLogProblem,
    cache,
    enabled: () => state.enabled,
  })
  return { state, cache, handler }
}

/**
 * 跑一次请求；起了子进程就按顺序喂 payload，直到 handler 收工。
 *
 * 支持“先试增量、失败退回全量”这种一轮里起两次子进程的路径：
 * `payloads` 依次给每个子进程，最后一个会重复使用。
 */
async function respond(harness, options = {}) {
  const fake = makeFakeRes()
  const before = harness.state.children.length
  const payloads = options.payloads ?? [options.payload ?? CACHE_NDJSON]
  let finished = false
  const running = harness
    .handler(options.cwd ?? '/repo', fake.res, options.args ?? {})
    .finally(() => {
      finished = true
    })
  let fed = before
  for (let guard = 0; guard < 5000 && finished === false; guard += 1) {
    if (harness.state.children.length > fed) {
      const child = harness.state.children[fed]
      fed += 1
      child.stdout.emit('data', payloads[Math.min(fed - before - 1, payloads.length - 1)])
      child.emit('close', options.code ?? 0)
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
  await running
  return { ...fake, spawned: harness.state.children.length > before }
}

await check('动作流缓存：决策表——关掉/无 HEAD/冷启/配置/二进制/命中/HEAD 前进', () => {
  const probe = { head: 'h1', configToken: 'c1', binToken: 'b1' }
  const entry = { head: 'h1', configToken: 'c1', binToken: 'b1' }
  assert.equal(evaluateRowsCache(entry, probe).mode, 'hit')
  assert.equal(evaluateRowsCache(entry, probe, { enabled: false }).reason, 'disabled')
  assert.equal(evaluateRowsCache(entry, { ...probe, head: null }).reason, 'head-unavailable')
  assert.equal(evaluateRowsCache(null, probe).reason, 'cold')
  assert.equal(evaluateRowsCache(entry, { ...probe, configToken: 'c2' }).reason, 'config-changed')
  assert.equal(evaluateRowsCache(entry, { ...probe, binToken: 'b2' }).reason, 'binary-changed')
  const moved = evaluateRowsCache(entry, { ...probe, head: 'h2' })
  assert.equal(moved.mode, 'build')
  assert.equal(moved.reason, 'head-moved')
})

await check('动作流缓存：第一次构建并写缓存，第二次同 HEAD 零子进程重发', async () => {
  const harness = timelineHarness()
  const first = await respond(harness)
  const doneFirst = first.events().find((event) => event.kind === 'done')
  assert.equal(first.state.headers['x-kiln-mode'], 'build')
  assert.equal(doneFirst.cache, 'stored')
  assert.equal(harness.state.spawns, 1)
  assert.equal(first.events().filter((event) => event.kind === 'action').length, 2)

  const second = await respond(harness)
  const doneSecond = second.events().find((event) => event.kind === 'done')
  assert.equal(second.state.headers['x-kiln-mode'], 'hit')
  assert.equal(doneSecond.cache, 'hit')
  assert.equal(second.spawned, false, '命中时不该再起子进程')
  assert.equal(harness.state.spawns, 1)
  assert.deepEqual(
    second.events().filter((event) => event.kind === 'action').map((event) => event.issueId),
    ['a', 'b'],
    '重发的行与原流一致',
  )
})

await check('动作流缓存：HEAD 前进 → 重建并覆盖（阶段 1 还不做增量）', async () => {
  const harness = timelineHarness()
  await respond(harness)
  harness.state.head = 'h2'
  const next = await respond(harness, { payload: `${JSON.stringify(CACHE_ROWS[0])}\n` })

  assert.equal(next.state.headers['x-kiln-mode'], 'build')
  assert.equal(harness.state.spawns, 2)
  assert.equal(next.events().filter((event) => event.kind === 'action').length, 1)
  // 新的一份覆盖旧的：同一个 HEAD 再请求一次应当命中新的那一行
  const again = await respond(harness)
  assert.equal(again.state.headers['x-kiln-mode'], 'hit')
  assert.equal(again.events().filter((event) => event.kind === 'action').length, 1)
})

// ---------------------------------------------------------------- 阶段 3：前缀增量

const CACHE_NEW = {
  issue: 'c',
  action: 'test',
  commit: 'c'.repeat(40),
  date: '2026-10-03T00:00:00+08:00',
  title: 'C',
}
const BOUNDARY_SEC = Math.floor(Date.parse(CACHE_ROWS[0].date) / 1000)

/** 增量成功所需的 git 探测结果：祖先成立、区间里只有更新的提交。 */
function safeIncrement(state, min = BOUNDARY_SEC + 60) {
  state.ancestor = true
  state.range = { count: 1, min }
}

await check('阶段3：HEAD 前进且前缀可安全读 → 只读新前缀，拼在缓存前面', async () => {
  const harness = timelineHarness()
  await respond(harness)
  harness.state.head = 'h2'
  safeIncrement(harness.state)

  const payload = `${JSON.stringify(CACHE_NEW)}\n${JSON.stringify(CACHE_ROWS[0])}\n`
  const result = await respond(harness, { payloads: [payload] })

  assert.equal(result.state.headers['x-kiln-mode'], 'incremental')
  assert.deepEqual(
    result.events()
      .filter((event) => event.kind === 'action')
      .map((event) => event.issueId),
    ['c', 'a', 'b'],
    '新行在前、缓存行在后',
  )
  assert.equal(harness.state.spawns, 2, '增量只起一次子进程（加上首次构建）')
  const rows = harness.cache.rows('/repo')
  assert.equal(rows.length, 3)
  assert.equal(rows[0].id, CACHE_NEW.commit)
  assert.equal(harness.cache.peek('/repo').head, 'h2')
})

await check('阶段3：客户端 HEAD 正好是缓存那一份 → 只发新增行（delta）', async () => {
  const harness = timelineHarness()
  await respond(harness)
  harness.state.head = 'h2'
  safeIncrement(harness.state)

  const payload = `${JSON.stringify(CACHE_NEW)}\n${JSON.stringify(CACHE_ROWS[0])}\n`
  const result = await respond(harness, { args: { head: 'h1' }, payloads: [payload] })

  assert.equal(result.state.headers['x-kiln-mode'], 'delta')
  assert.deepEqual(
    result.events()
      .filter((event) => event.kind === 'action')
      .map((event) => event.issueId),
    ['c'],
    'delta 只发新增的那一行',
  )
  assert.equal(harness.cache.rows('/repo').length, 3)
})

await check('阶段3：区间里有回退日期的提交（cherry-pick/rebase）→ 拒绝增量，全量重读', async () => {
  const harness = timelineHarness()
  await respond(harness)
  harness.state.head = 'h2'
  safeIncrement(harness.state, BOUNDARY_SEC - 60)

  const result = await respond(harness, { payloads: [CACHE_NDJSON] })
  assert.equal(result.state.headers['x-kiln-mode'], 'build')
  assert.equal(harness.state.spawns, 2, '只起一次全量')
  assert.equal(harness.cache.rows('/repo').length, 2, '缓存被全量结果覆盖')
})

await check('阶段3：旧 HEAD 不是新 HEAD 的祖先（改写历史）→ 全量重读', async () => {
  const harness = timelineHarness()
  await respond(harness)
  harness.state.head = 'h2'
  harness.state.ancestor = false
  harness.state.range = { count: 5, min: BOUNDARY_SEC + 60 }

  const result = await respond(harness, { payloads: [CACHE_NDJSON] })
  assert.equal(result.state.headers['x-kiln-mode'], 'build')
  assert.equal(harness.cache.rows('/repo').length, 2)
})

await check('阶段3：新前缀读完都没撞到 boundary → 回退全量', async () => {
  const harness = timelineHarness()
  await respond(harness)
  harness.state.head = 'h2'
  safeIncrement(harness.state)

  const truncated = `${JSON.stringify(CACHE_NEW)}\n`
  const result = await respond(harness, { payloads: [truncated, CACHE_NDJSON] })

  assert.equal(result.state.headers['x-kiln-mode'], 'build')
  assert.equal(harness.state.spawns, 3, '一次失败的增量 + 一次全量')
  assert.equal(harness.cache.rows('/repo').length, 2)
  assert.deepEqual(
    result.events()
      .filter((event) => event.kind === 'action')
      .map((event) => event.issueId),
    ['a', 'b'],
    '客户端只收到全量结果，没有半截新行',
  )
})

await check('阶段3：读前缀期间 HEAD 又动了 → 判定过期，回退全量', async () => {
  const harness = timelineHarness()
  await respond(harness)
  harness.state.head = 'h2'
  safeIncrement(harness.state)
  // 下一次 readHead 是 decide（h2），再下一次是读完之后复核（h3）
  harness.state.raceFrom = harness.state.headCalls + 2
  harness.state.raceHead = 'h3'

  const payload = `${JSON.stringify(CACHE_NEW)}\n${JSON.stringify(CACHE_ROWS[0])}\n`
  const result = await respond(harness, { payloads: [payload, CACHE_NDJSON] })

  assert.equal(result.state.headers['x-kiln-mode'], 'build', '复核失败就该退回全量')
  assert.equal(harness.state.spawns, 3, '构建 + 增量 + 全量')
})

await check('阶段3：区间提交数超过上限 → 直接全量（增量不划算）', async () => {
  const harness = timelineHarness({ incrementMaxCommits: 2 })
  await respond(harness)
  harness.state.head = 'h2'
  harness.state.ancestor = true
  harness.state.range = { count: 9, min: BOUNDARY_SEC + 60 }

  const result = await respond(harness, { payloads: [CACHE_NDJSON] })
  assert.equal(result.state.headers['x-kiln-mode'], 'build')
  assert.equal(harness.state.spawns, 2)
})

await check('阶段3：缓存太小时不做增量（两次 git 探测比全读还贵）', async () => {
  const harness = timelineHarness({ incrementMinRows: 1000 })
  await respond(harness)
  harness.state.head = 'h2'
  safeIncrement(harness.state)

  const result = await respond(harness, { payloads: [CACHE_NDJSON] })
  assert.equal(result.state.headers['x-kiln-mode'], 'build')
  assert.equal(harness.state.probes.length, 0, '连探测都不该发')
})

await check('动作流缓存：超限不存半截，这一仓本会话改走 bypass', async () => {
  const harness = timelineHarness({ rowsLimit: 1 })
  const first = await respond(harness)
  const done = first.events().find((event) => event.kind === 'done')
  assert.equal(done.cache, 'oversize')
  assert.equal(harness.cache.rows('/repo'), null, '超限的仓不留半截缓存')

  const second = await respond(harness)
  assert.equal(second.state.headers['x-kiln-mode'], 'bypass')
  assert.equal(harness.state.spawns, 2, 'bypass 就是每次重读')
  assert.equal(second.events().find((event) => event.kind === 'done').cache, 'skip')
})

await check('动作流缓存：关掉缓存（env/带 limit）→ bypass，行为与没有缓存一致', async () => {
  const off = timelineHarness({ enabled: false })
  const first = await respond(off)
  assert.equal(first.state.headers['x-kiln-mode'], 'bypass')
  assert.equal(off.cache.rows('/repo'), null)

  const on = timelineHarness()
  const limited = await respond(on, { args: { noCache: true } })
  assert.equal(limited.state.headers['x-kiln-mode'], 'bypass')
  assert.equal(on.cache.rows('/repo'), null, '带 limit 的缩水结果不能进缓存')
})

await check('动作流缓存：fresh=1 忽略缓存重建，并把新数据写回去', async () => {
  const harness = timelineHarness()
  await respond(harness)
  assert.equal(harness.cache.rows('/repo').length, 2)

  const fresh = await respond(harness, { args: { fresh: true }, payload: `${JSON.stringify(CACHE_ROWS[1])}\n` })
  assert.equal(fresh.state.headers['x-kiln-mode'], 'build')
  assert.equal(harness.state.spawns, 2)
  const rows = harness.cache.rows('/repo')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, SHA_B)
})

await check('动作流缓存：客户端带同一个 HEAD → unchanged，空 body 零子进程', async () => {
  const harness = timelineHarness()
  await respond(harness)
  const again = await respond(harness, { args: { head: 'h1' } })
  assert.equal(again.state.headers['x-kiln-mode'], 'unchanged')
  assert.equal(again.spawned, false)
  assert.equal(harness.state.spawns, 1, 'unchanged 不该再起子进程')
  const done = again.events().find((event) => event.kind === 'done')
  assert.equal(done.cache, 'unchanged')
  assert.equal(again.events().filter((event) => event.kind === 'action').length, 0, 'unchanged 不发行')
})

await check('动作流缓存：客户端 HEAD 过期 → 走全量重发', async () => {
  const harness = timelineHarness()
  await respond(harness)
  harness.state.head = 'h2'
  const stale = await respond(harness, { args: { head: 'h1' }, payload: `${JSON.stringify(CACHE_ROWS[0])}\n` })
  assert.equal(stale.state.headers['x-kiln-mode'], 'build')
  assert.equal(stale.spawned, true)
  assert.equal(stale.events().filter((event) => event.kind === 'action').length, 1)
})

await check('动作流缓存：配置换了就算 HEAD 相同也要重发（客户端那份语义可能过时）', async () => {
  const harness = timelineHarness()
  await respond(harness)
  harness.state.config = 'c2'
  const rebuilt = await respond(harness, { args: { head: 'h1' } })
  assert.equal(rebuilt.state.headers['x-kiln-mode'], 'build')
  assert.equal(rebuilt.spawned, true)
})

await check('动作流缓存：客户端断开 → kill 子进程，后续行不再写', async () => {
  const harness = timelineHarness()
  const fake = makeFakeRes()
  let finished = false
  const running = harness.handler('/repo', fake.res, {}).finally(() => {
    finished = true
  })
  // 等子进程起来（handler 里先 await 探测，再 spawn）
  for (let i = 0; i < 500 && harness.state.children.length === 0 && finished === false; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  const child = harness.state.children[0]
  assert.ok(child !== undefined, '应该起了一个子进程')
  child.stdout.emit('data', `${JSON.stringify(CACHE_ROWS[0])}\n`)
  fake.disconnect()
  assert.equal(child.killed, 1, '连接关了就该 kill')
  const written = fake.state.chunks.length
  child.stdout.emit('data', `${JSON.stringify(CACHE_ROWS[1])}\n`)
  child.emit('close', 0)
  await running
  assert.equal(fake.state.chunks.length, written, '关掉之后不再写')
})

await check('动作流缓存：最多留 2 个仓，第 3 个把最久没用的挤掉', async () => {
  const harness = timelineHarness({ repoLimit: 2 })
  const rows = [{ ...CACHE_ROWS[0] }]
  for (const repo of ['r1', 'r2', 'r3']) {
    harness.cache.commit(repo, { head: 'h1', configToken: 'c1', binToken: 'b1', rows, bytes: 100 })
  }
  assert.equal(await harness.cache.rows('r1'), null)
  assert.notEqual(await harness.cache.rows('r2'), null)
  assert.notEqual(await harness.cache.rows('r3'), null)
})


function clientInternals() {
  const reactStub = {
    createElement: () => null,
    Fragment: 'fragment',
    useRef: (v) => ({ current: v }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useMemo: (f) => f(),
  }
  return (
    loaded.factory((name) => {
      if (name === 'react') return reactStub
      throw new Error('unexpected require: ' + name)
    }).__internals ?? {}
  )
}

await check('issue 折叠：首现=最近动作、domain 取首个非空、tags 并集、done 认终点词表', () => {
  const { foldIssues, normalizeVocab } = clientInternals()
  const vocab = normalizeVocab({
    names: ['ask', 'test', 'conclude', 'apply'],
    start: 'ask',
    terminal: ['conclude', 'apply'],
  })
  assert.ok(vocab !== null)
  const SHA_C = 'c'.repeat(40)
  const rows = [
    { issueId: 'a', action: 'apply', id: SHA_A, short: 'aaaaaaa', date: '2026-10-05T00:00:00+08:00', title: 'a apply', domain: 'newest', tags: ['t1'] },
    { issueId: 'b', action: 'test', id: SHA_B, short: 'bbbbbbb', date: '2026-10-04T00:00:00+08:00', title: 'b test', tags: [] },
    { issueId: 'a', action: 'ask', id: SHA_C, short: 'ccccccc', date: '2026-10-01T00:00:00+08:00', title: 'a ask', domain: 'oldest', tags: ['t2'] },
  ]
  const issues = foldIssues(rows, { start: vocab.start, terminal: vocab.terminal, complete: true })
  assert.deepEqual(issues.map((issue) => issue.id), ['a', 'b'], '首现顺序 = 最近动作顺序')
  assert.equal(issues[0].action, 'apply')
  assert.equal(issues[0].title, 'a apply')
  assert.equal(issues[0].done, true, '最近动作 apply ∈ terminal')
  assert.equal(issues[1].done, false)
  assert.equal(issues[0].domain, 'newest', 'domain 取最新一个非空（= 时间序的最后一个非空）')
  assert.deepEqual(issues[0].tags, ['t2', 't1'], 'tags 按时间序取并集')
  assert.deepEqual(issues[0].actions.map((action) => action.ordinal), [1, 2], '读到起点后 ordinal 定稿')
  assert.deepEqual(issues[0].actions.map((action) => action.action), ['ask', 'apply'], 'actions 翻成时间升序')
  assert.equal(issues[0].last.action, 'apply')
})

await check('issue 折叠：没读到起点、流也没结束时，ordinal 不提前编', () => {
  const { foldIssues } = clientInternals()
  const rows = [
    { issueId: 'a', action: 'apply', id: SHA_A, short: 'aaaaaaa', date: '2026-10-05T00:00:00+08:00', title: 'a apply', tags: [] },
    { issueId: 'a', action: 'test', id: SHA_B, short: 'bbbbbbb', date: '2026-10-04T00:00:00+08:00', title: 'a test', tags: [] },
  ]
  const partial = foldIssues(rows, { start: 'ask', terminal: new Set(['apply']), complete: false })
  assert.equal(partial[0].done, true)
  assert.deepEqual(partial[0].actions.map((action) => action.ordinal), [undefined, undefined])
  const finished = foldIssues(rows, { start: 'ask', terminal: new Set(['apply']), complete: true })
  assert.deepEqual(finished[0].actions.map((action) => action.ordinal), [1, 2], 'EOF 兜底定稿')
})

await check('issue 折叠：词表缺失时 done 不可知，不猜', () => {
  const { foldIssues, normalizeVocab } = clientInternals()
  assert.equal(normalizeVocab(null), null)
  assert.equal(normalizeVocab({ names: [], start: 'ask', terminal: [] }), null)
  assert.equal(normalizeVocab({ names: ['ask'], start: '', terminal: [] }), null)
  const issues = foldIssues(
    [{ issueId: 'a', action: 'apply', id: SHA_A, short: 'aaaaaaa', date: '2026-10-05T00:00:00+08:00', title: '', tags: [] }],
    { start: 'ask', terminal: null, complete: true },
  )
  assert.equal(issues[0].done, false)
  assert.equal(issues[0].doneKnown, false, 'UI 据此不画 done chip、状态筛选也不把它算成 open')
})

// ---------------------------------------------------------------- 会话缓存（纯函数）

await check('会话缓存：键带仓库前缀，不同仓库/不同 id 不串', () => {
  const { cacheKey } = clientInternals()
  assert.notEqual(cacheKey('/a', 'x'), cacheKey('/b', 'x'))
  assert.notEqual(cacheKey('/a', 'x'), cacheKey('/a', 'y'))
  assert.equal(cacheKey('/a', 'x'), cacheKey('/a', 'x'))
})

await check('会话缓存：LRU —— 命中挪到末尾，超限淘汰最久未用', () => {
  const { cacheGet, cacheSet } = clientInternals()
  const map = new Map()
  cacheSet(map, 'a', 1, 2)
  cacheSet(map, 'b', 2, 2)
  assert.equal(cacheGet(map, 'a'), 1, '命中并挪到末尾')
  assert.equal(cacheGet(map, 'nope'), undefined)
  cacheSet(map, 'c', 3, 2)
  assert.equal(map.has('b'), false, 'b 最久未用，被淘汰')
  assert.equal(map.has('a'), true)
  assert.equal(map.has('c'), true)
})

await check('词表缓存键：仓库 / 配置 / 二进制任一变化都换键', () => {
  const a = actionsCacheKey('/repo-a', '')
  const b = actionsCacheKey('/repo-b', '')
  const c = actionsCacheKey('/repo-a', '/bin/kiln.exe')
  assert.equal(a, actionsCacheKey('/repo-a', ''), '同样的输入给同样的键')
  assert.notEqual(a, b)
  assert.notEqual(a, c)
})

await check('动作流客户端缓存：按仓库记 HEAD，超限/换仓/刷新各自处理', () => {
  const { timelineCache, rememberTimeline, clearRepoCaches } = clientInternals()
  timelineCache.clear()
  const rows = [{ id: 'sha1' }]

  assert.equal(rememberTimeline('/a', 'h1', rows, 100), true)
  assert.equal(timelineCache.get('/a').head, 'h1')
  assert.equal(rememberTimeline('/a', 'h2', rows, 100), true, '同一仓覆盖为新的 HEAD')
  assert.equal(timelineCache.get('/a').head, 'h2')
  assert.equal(rememberTimeline('/b', 'h1', rows, 100), true)
  assert.equal(rememberTimeline('/c', 'h1', rows, 100), true)
  assert.equal(timelineCache.has('/a'), false, '只留最近两个仓')

  assert.equal(rememberTimeline('/d', '', rows, 100), false, '没有 HEAD 不记')
  assert.equal(rememberTimeline('/d', 'h1', rows, 20 * 1024 * 1024 + 1), false, '超过字节上限不记')
  assert.equal(rememberTimeline('/d', 'h1', new Array(50001).fill(rows[0]), 100), false, '超过行数上限不记')

  timelineCache.set('/x', { head: 'h1', rows, bytes: 1 })
  clearRepoCaches('/x')
  assert.equal(timelineCache.has('/x'), false, '刷新要连动作流缓存一起清')
})

await check('动作流客户端缓存：delta 合并——新行在前、按 sha 去重、空旧集照抄', () => {
  const { mergeTimelineRows } = clientInternals()
  const newer = [{ id: 'c' }]
  const older = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(mergeTimelineRows(newer, older).map((row) => row.id), ['c', 'a', 'b'])
  assert.deepEqual(mergeTimelineRows([{ id: 'a' }], older).map((row) => row.id), ['a', 'b'], '重复的 sha 不出现两次')
  assert.deepEqual(mergeTimelineRows(newer, []).map((row) => row.id), ['c'])
  assert.deepEqual(mergeTimelineRows([], older).map((row) => row.id), ['a', 'b'])
})

await check('搜索结果键盘：在结果里上下移动，到两端回绕', () => {
  const { nextSearchIndex } = clientInternals()
  assert.equal(nextSearchIndex(-1, 100, 1), 0)
  assert.equal(nextSearchIndex(3, 100, 1), 4)
  assert.equal(nextSearchIndex(99, 100, 1), 0, '末尾向下回绕到第一条')
  assert.equal(nextSearchIndex(0, 100, -1), 99, '第一条向上回绕到最后一条')
  assert.equal(nextSearchIndex(-1, 0, 1), -1, '没有结果')
})

await check('搜索跳转：流没读完先等，流结束仍没有才放弃，否则按索引滚', () => {
  const { jumpPlan } = clientInternals()
  assert.equal(jumpPlan(-1, true), 'wait', '目标还没进数据：等流')
  assert.equal(jumpPlan(-1, false), 'give-up', '流读完仍没有：放弃')
  assert.equal(jumpPlan(0, false), 'scroll')
  assert.equal(jumpPlan(150, true), 'scroll', '索引已定：直接按高度表滚过去')
})

await check('虚拟化：前缀高度表用真实高度、缺的用估算', () => {
  const { buildOffsets, rowKeyOf } = clientInternals()
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const heights = new Map([['issue\u0000b', 50]])
  const offsets = buildOffsets(rows, 'issue', heights, 30)
  assert.deepEqual(Array.from(offsets), [0, 30, 80, 110])
  assert.equal(rowKeyOf('timeline', { id: 'sha', issueId: 'x' }), 'sha')
  assert.equal(rowKeyOf('issue', { id: 'x' }), 'x')
})

await check('虚拟化：可视区取 scrollTop ± overscan，小列表整份渲染', () => {
  const { buildOffsets, virtualWindow } = clientInternals()
  const rows = Array.from({ length: 100 }, (_value, index) => ({ id: `r${index}` }))
  const offsets = buildOffsets(rows, 'issue', new Map(), 30)
  const window = virtualWindow(offsets, 100, 3000, 480, 600)
  assert.equal(window.start, 80, '3000 - 600 = 2400 → 第 80 行')
  assert.equal(window.end, 100, '底部超过总高，截到 100')
  assert.equal(window.top, 2400)
  assert.equal(window.bottom, 0)
  const small = virtualWindow(buildOffsets(rows.slice(0, 4), 'issue', new Map(), 30), 4, 0, 480, 600)
  assert.deepEqual(small, { start: 0, end: 4, top: 0, bottom: 0 })
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
