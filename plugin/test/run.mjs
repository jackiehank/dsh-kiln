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

await check('client：能加载、导出形态正确、注册 id=kiln 的 conversation.view', async () => {
  let loaded = null
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

// ---------------------------------------------------------------- 汇总

console.log('')
if (failures.length === 0) {
  console.log(`全部通过：${passed} 个用例`)
} else {
  console.log(`通过 ${passed}，失败 ${failures.length}`)
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.stack ?? failure.error}`)
  process.exitCode = 1
}
