/**
 * 存储格式探针：动作行缓存「存什么形状、占多少堆、重发要多少 CPU」（默认 10 万行）。
 *
 * 用法：`node --expose-gc plugin/test/probe-format.mjs [repo]`
 *
 * 数据：把仓库真行克隆到 10 万行（issue/action/domain 文本重复，id/title/date 唯一），
 * 每个变体都重新 JSON.parse，字符串不跨变体共享；每组都在 gc 后取堆增量。
 * 只读，不写仓库；数字看趋势，不看绝对值。
 */
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapActionRecord } from '../lib/timeline.js'

const repo = process.argv[2] ?? process.cwd()
const tmp = mkdtempSync(join(tmpdir(), 'kiln-fmt-'))
const out = join(tmp, 'a.ndjson')
const fd = openSync(out, 'w')
spawnSync('kiln', ['action', 'log', '--jsonl'], { cwd: repo, stdio: ['ignore', fd, 'ignore'], windowsHide: true })
closeSync(fd)
const realLines = readFileSync(out, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '')
const real = realLines.map((l) => mapActionRecord(JSON.parse(l))).filter(Boolean)

// 真实分布
const uniq = (fn) => new Set(real.map(fn)).size
console.log(`真行 ${real.length} 行：issue ${uniq((r) => r.issueId)} 个 · action ${uniq((r) => r.action)} 个 · domain ${uniq((r) => r.domain)} 个 · 带 tags ${real.filter((r) => r.tags.length > 0).length}`)
const avg = (fn) => (real.reduce((n, r) => n + fn(r), 0) / real.length).toFixed(1)
console.log(`平均长度：title ${avg((r) => r.title.length)} · id ${avg((r) => r.id.length)} · date ${avg((r) => r.date.length)} · issueId ${avg((r) => r.issueId.length)}`)

// 生成 10 万行文本（每行 title/id/date 唯一，其余重复）
const N = 100_000
const lines = []
for (let i = 0; i < N; i += 1) {
  const base = real[i % real.length]
  const seconds = String(i % 60).padStart(2, '0')
  lines.push(
    JSON.stringify({
      issue: base.issueId,
      action: base.action,
      commit: (base.id.slice(0, 32) + i.toString(16).padStart(8, '0')),
      date: `${base.date.slice(0, 17)}${seconds}${base.date.slice(19)}`,
      title: `${base.title} ${i}`,
      domain: base.domain,
      tags: base.tags,
    }),
  )
}
const wireBytes = lines.reduce((n, l) => n + l.length, 0)
console.log(`\n100k 行：NDJSON ${(wireBytes / 1048576).toFixed(1)}MB  ${(wireBytes / N).toFixed(0)}B/行\n`)

const mb = (n) => (n / 1048576).toFixed(1) + 'MB'
const gc = () => {
  globalThis.gc()
  globalThis.gc()
}
const heap = () => process.memoryUsage().heapUsed
const time = (fn) => {
  const t = process.hrtime.bigint()
  const v = fn()
  return { v, ms: Number(process.hrtime.bigint() - t) / 1e6 }
}

/** 每个变体都重新 parse，避免字符串跨变体共享。 */
function measure(label, build, serve) {
  gc()
  const base = heap()
  const t = time(build)
  gc()
  const used = heap() - base
  const value = t.v
  const st = time(() => serve(value))
  const out = st.v
  const outBytes = typeof out === 'string' ? Buffer.byteLength(out) : 0
  console.log(`${label.padEnd(26)} ${mb(used).padStart(7)}  ${(used / N).toFixed(0).padStart(4)}B/行  build ${t.ms.toFixed(0).padStart(4)}ms  serve ${st.ms.toFixed(0).padStart(3)}ms  ${mb(outBytes).padStart(6)}`)
  return t.v
}

const parsed = () => lines.map((l) => JSON.parse(l))

// A. 现在的形态
let keepA = measure(
  'A 8 键对象（现状）',
  () => parsed().map((r) => mapActionRecord(r)),
  (rows) => rows.map((r) => JSON.stringify({ kind: 'action', ...r })).join('\n'),
)

// B. 去掉 short、tags 空数组换 null
let keepB = measure(
  'B A-去 short/空 tags',
  () =>
    parsed().map((r) => {
      const row = mapActionRecord(r)
      return { issueId: row.issueId, action: row.action, id: row.id, date: row.date, title: row.title, domain: row.domain, tags: row.tags.length === 0 ? null : row.tags }
    }),
  (rows) => rows.map((r) => JSON.stringify({ kind: 'action', ...r, short: r.id.slice(0, 7) })).join('\n'),
)

// B2. B + 只驻留 issueId/action/domain（date 仍是原字符串）
let keepB2 = measure(
  'B2 B+驻留（date 原串）',
  () => {
    const pool = new Map()
    const id = (s) => pool.get(s) ?? (pool.set(s, s), s)
    return parsed().map((r) => {
      const row = mapActionRecord(r)
      return { issueId: id(row.issueId), action: id(row.action), id: row.id, date: row.date, title: row.title, domain: id(row.domain), tags: row.tags.length === 0 ? null : row.tags.join('\u0001') }
    })
  },
  (rows) => rows.map((r) => JSON.stringify({ kind: 'action', issue: r.issueId, action: r.action, commit: r.id, date: r.date, title: r.title, domain: r.domain, tags: r.tags === null ? [] : r.tags.split('\u0001'), short: r.id.slice(0, 7) })).join('\n'),
)

// B3. B + 只把 date 存成 epoch 毫秒
let keepB3 = measure(
  'B3 B+date 数字',
  () =>
    parsed().map((r) => {
      const row = mapActionRecord(r)
      return { issueId: row.issueId, action: row.action, id: row.id, dateMs: Date.parse(row.date), title: row.title, domain: row.domain, tags: row.tags.length === 0 ? null : row.tags.join('\u0001') }
    }),
  (rows) => rows.map((r) => JSON.stringify({ kind: 'action', issue: r.issueId, action: r.action, commit: r.id, date: new Date(r.dateMs).toISOString(), title: r.title, domain: r.domain, tags: r.tags === null ? [] : r.tags.split('\u0001'), short: r.id.slice(0, 7) })).join('\n'),
)

// C. B + 驻留 issueId/action/domain + date 存 epoch 毫秒
let keepC = measure(
  'C B+驻留+date 数字',
  () => {
    const pool = new Map()
    const id = (s) => pool.get(s) ?? (pool.set(s, s), s)
    return parsed().map((r) => {
      const row = mapActionRecord(r)
      return {
        issueId: id(row.issueId),
        action: id(row.action),
        id: row.id,
        dateMs: Date.parse(row.date),
        title: row.title,
        domain: id(row.domain),
        tags: row.tags.length === 0 ? null : row.tags.join('\u0001'),
      }
    })
  },
  (rows) =>
    rows
      .map((r, i) => JSON.stringify({ kind: 'action', issue: r.issueId, action: r.action, commit: r.id, date: new Date(r.dateMs).toISOString(), title: r.title, domain: r.domain, tags: r.tags === null ? [] : r.tags.split('\u0001'), short: r.id.slice(0, 7) }))
      .join('\n'),
)

// G2. 数组行 + 数组线上，date 保留原字符串（不丢提交自己的 offset）
let keepG2 = measure(
  'G2 数组+数组线上(date 原串)',
  () => {
    const pool = new Map()
    const id = (s) => pool.get(s) ?? (pool.set(s, s), s)
    return parsed().map((r) => {
      const row = mapActionRecord(r)
      return [id(row.issueId), id(row.action), row.id, row.date, row.title, id(row.domain), row.tags.length === 0 ? null : row.tags.join('\u0001')]
    })
  },
  (rows) => rows.map((r) => JSON.stringify(r)).join('\n'),
)

// G3. 同 G2 但不驻留：看驻留在数组形态里还剩多少
let keepG3 = measure(
  'G3 数组(date 原串,不驻留)',
  () =>
    parsed().map((r) => {
      const row = mapActionRecord(r)
      return [row.issueId, row.action, row.id, row.date, row.title, row.domain, row.tags.length === 0 ? null : row.tags.join('\u0001')]
    }),
  (rows) => rows.map((r) => JSON.stringify(r)).join('\n'),
)

// D. 数组行 [issueId, action, id, dateMs, title, domain, tagsStr]，驻留重复串
let keepD = measure(
  'D 数组行（7 槽）',
  () => {
    const pool = new Map()
    const id = (s) => pool.get(s) ?? (pool.set(s, s), s)
    return parsed().map((r) => {
      const row = mapActionRecord(r)
      return [id(row.issueId), id(row.action), row.id, Date.parse(row.date), row.title, id(row.domain), row.tags.length === 0 ? null : row.tags.join('\u0001')]
    })
  },
  (rows) =>
    rows
      .map((r) => JSON.stringify({ kind: 'action', issue: r[0], action: r[1], commit: r[2], date: new Date(r[3]).toISOString(), title: r[4], domain: r[5], tags: r[6] === null ? [] : r[6].split('\u0001'), short: r[2].slice(0, 7) }))
      .join('\n'),
)

// E. 原文行（宿主只存收到的每一行字符串）
let keepE = measure(
  'E 原始 NDJSON 行',
  () => lines.map((l) => (' ' + l).slice(1)),
  (rows) => rows.join('\n'),
)

// F. 列式：8 条平行数组
let keepF = measure(
  'F 列式 8 槽',
  () => {
    const pool = new Map()
    const id = (s) => pool.get(s) ?? (pool.set(s, s), s)
    const issueId = []
    const action = []
    const sha = []
    const dateMs = []
    const title = []
    const domain = []
    const tags = []
    for (const r of parsed()) {
      const row = mapActionRecord(r)
      issueId.push(id(row.issueId))
      action.push(id(row.action))
      sha.push(row.id)
      dateMs.push(Date.parse(row.date))
      title.push(row.title)
      domain.push(id(row.domain))
      tags.push(row.tags.length === 0 ? null : row.tags.join('\u0001'))
    }
    return { issueId, action, sha, dateMs, title, domain, tags }
  },
  (rows) =>
    rows.sha
      .map((sha, i) => JSON.stringify({ kind: 'action', issue: rows.issueId[i], action: rows.action[i], commit: sha, date: new Date(rows.dateMs[i]).toISOString(), title: rows.title[i], domain: rows.domain[i], tags: rows.tags[i] === null ? [] : rows.tags[i].split('\u0001'), short: sha.slice(0, 7) }))
      .join('\n'),
)

// 访问成本：读标题
// G. 数组行 + 数组也就是线上格式（宿主直接发数组，客户端不用重建对象）
let keepG = measure(
  'G 数组行+数组线上',
  () => {
    const pool = new Map()
    const id = (s) => pool.get(s) ?? (pool.set(s, s), s)
    return parsed().map((r) => {
      const row = mapActionRecord(r)
      return [id(row.issueId), id(row.action), row.id, Date.parse(row.date), row.title, id(row.domain), row.tags.length === 0 ? null : row.tags.join('\u0001')]
    })
  },
  (rows) => rows.map((r) => JSON.stringify(r)).join('\n'),
)

// fold 的额外常驻（客户端 rows + fold 两半）
globalThis.window = { __ModuleLoader__: { load: (d) => (globalThis.__def = d) } }
globalThis.document = { getElementById: () => ({}), createElement: () => ({}) }
globalThis.__DSH_KILN_TEST__ = true
await import('../lib/client.js?probe-format=1')
const reactStub = {
  createElement: () => null,
  Fragment: 'f',
  useRef: (v) => ({ current: v }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}
const { foldIssues } = globalThis.__def.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error(name)
}).__internals
gc()
const beforeFold = heap()
const foldT = time(() => foldIssues(keepA, { start: 'ask', terminal: new Set(['conclude', 'apply']), complete: true }))
gc()
const foldHeap = heap() - beforeFold
console.log(`fold(A)                    ${mb(foldHeap).padStart(7)}  ${(foldHeap / N).toFixed(0).padStart(4)}B/行  ${foldT.ms.toFixed(0)}ms  ${foldT.v.length} issue`)

// H. 原始字节：宿主不存行对象，只存收到的字节（Buffer 在 JS 堆外）
gc()
const beforeBytes = process.memoryUsage()
const perLine = time(() => lines.map((l) => Buffer.from(' ' + l)))
gc()
const afterBytes = process.memoryUsage()
console.log(`H 原始字节（Buffer/行）      heap +${mb(afterBytes.heapUsed - beforeBytes.heapUsed).padStart(7)}  external +${mb(afterBytes.external - beforeBytes.external)}  ${(perLine.v.reduce((n, b) => n + b.length, 0) / N).toFixed(0)}B/行  build ${perLine.ms.toFixed(0)}ms`)
gc()
const beforeOne = process.memoryUsage()
const oneBig = time(() => Buffer.from(lines.join('\n')))
gc()
const afterOne = process.memoryUsage()
console.log(`H2 原始字节（一整块）        heap +${mb(afterOne.heapUsed - beforeOne.heapUsed).padStart(7)}  external +${mb(afterOne.external - beforeOne.external)}  ${(oneBig.v.length / N).toFixed(0)}B/行  build ${oneBig.ms.toFixed(0)}ms`)

// 客户端收行成本：现状（对象事件 → 建行对象，等价 take()）vs 数组（parse 完直接 push）
const objLines = keepA.map((r) => JSON.stringify({ kind: 'action', ...r }))
const aryLines = keepG2.map((r) => JSON.stringify(r))
const takeObj = time(() =>
  objLines.map((line) => {
    const e = JSON.parse(line)
    return { issueId: e.issueId, action: e.action, id: e.id, short: e.short, date: e.date, title: e.title, domain: e.domain, tags: e.tags }
  }),
)
const takeAry = time(() => aryLines.map((line) => JSON.parse(line)))
console.log(`客户端收 100k 行：对象 ${takeObj.ms.toFixed(0)}ms（含建行对象）  数组 ${takeAry.ms.toFixed(0)}ms（parse 即行）`)

const accessA = time(() => {
  let n = 0
  for (const r of keepA) n += r.title.length
  return n
})
const accessD = time(() => {
  let n = 0
  for (const r of keepD) n += r[4].length
  return n
})
console.log(`\n访问 title ×100k：A ${accessA.ms.toFixed(1)}ms  D ${accessD.ms.toFixed(1)}ms`)
console.log(`保留数组：${[keepA, keepB, keepC, keepD, keepE, keepF].map((x) => x.length).join('/')}`)
