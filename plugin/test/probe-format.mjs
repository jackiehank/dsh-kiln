/**
 * 存储格式探针：动作行缓存「存什么形状、占多少堆、重发要多少 CPU」（默认 10 万行）。
 *
 * 用法：`node --expose-gc plugin/test/probe-format.mjs [repo]`
 *
 * 数据：把仓库真行克隆到 10 万行（issue/action/domain 文本重复，id/title/date 唯一），
 * 每个变体都重新解析原始记录，字符串不跨变体共享；每组都在 gc 后取堆增量。
 * 只读，不写仓库；数字看趋势，不看绝对值。
 *
 * 现在的出生形状是 7 槽数组（`ROW`），对象形状只留作对照——回退或换形状时拿它比。
 */
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = process.argv[2] ?? process.cwd()
const tmp = mkdtempSync(join(tmpdir(), 'kiln-fmt-'))
const out = join(tmp, 'a.ndjson')
const fd = openSync(out, 'w')
spawnSync('kiln', ['action', 'log', '--jsonl'], { cwd: repo, stdio: ['ignore', fd, 'ignore'], windowsHide: true })
closeSync(fd)
const records = readFileSync(out, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))

const uniq = (pick) => new Set(records.map(pick)).size
const avg = (pick) => (records.reduce((n, r) => n + String(pick(r) ?? '').length, 0) / records.length).toFixed(1)
console.log(
  `真行 ${records.length} 条：issue ${uniq((r) => r.issue)} 个 · action ${uniq((r) => r.action)} 个 · domain ${uniq((r) => r.domain)} 个 · 带 tags ${records.filter((r) => Array.isArray(r.tags) && r.tags.length > 0).length}`,
)
console.log(
  `平均长度：title ${avg((r) => r.title)} · commit 40 · date ${avg((r) => r.date)} · issue ${avg((r) => r.issue)}`,
)

// 生成 10 万条记录（每行 title/commit/date 唯一，其余重复），当作“刚 parse 出来”的输入
const N = 100_000
const inputs = []
for (let i = 0; i < N; i += 1) {
  const base = records[i % records.length]
  inputs.push({
    issue: base.issue,
    action: base.action,
    commit: base.commit.slice(0, 32) + i.toString(16).padStart(8, '0'),
    date: `${String(base.date).slice(0, 17)}${String(i % 60).padStart(2, '0')}${String(base.date).slice(19)}`,
    title: `${base.title ?? ''} ${i}`,
    domain: base.domain,
    tags: Array.isArray(base.tags) ? base.tags : [],
  })
}
const recordLines = inputs.map((r) => JSON.stringify(r))
const wire = inputs.map((r) => JSON.stringify([r.issue, r.action, r.commit, r.date, r.title ?? '', r.domain ?? '', r.tags.length === 0 ? null : r.tags.join('\u0001')]))
console.log(`\n100k 行：数组 NDJSON ${(wire.reduce((n, l) => n + l.length, 0) / 1048576).toFixed(1)}MB\n`)

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

/**
 * 把原始记录变成要测的形状；`pool` 给了就做驻留（issue/action/domain）。
 * 每条都造新字符串（issue/action/domain 的文本重复），模拟真解析。
 */
function makeRows(kind, interned) {
  const list = recordLines.map((line) => JSON.parse(line))
  const pool = interned ? new Map() : null
  const keep = (value) => {
    if (pool === null) return value
    const hit = pool.get(value)
    if (hit !== undefined) return hit
    pool.set(value, value)
    return value
  }
  return list.map((r) => {
    const issue = keep(r.issue)
    const action = keep(r.action)
    const domain = keep(r.domain ?? '')
    const tags = r.tags.length === 0 ? null : r.tags.join('\u0001')
    if (kind === 'shipped') return [issue, action, r.commit, r.date, r.title ?? '', domain, tags]
    // 旧形状：8 键对象（对照用）
    return { issueId: issue, action, id: r.commit, short: r.commit.slice(0, 7), date: r.date, title: r.title ?? '', domain, tags }
  })
}

function measure(label, build, serve) {
  gc()
  const base = heap()
  const t = time(build)
  gc()
  const used = heap() - base
  const st = time(() => serve(t.v))
  const outText = st.v
  const outBytes = typeof outText === 'string' ? Buffer.byteLength(outText) : 0
  console.log(
    `${label.padEnd(26)} ${mb(used).padStart(7)}  ${(used / N).toFixed(0).padStart(4)}B/行  build ${t.ms.toFixed(0).padStart(4)}ms  serve ${st.ms.toFixed(0).padStart(3)}ms  ${mb(outBytes).padStart(6)}`,
  )
  return t.v
}

const servedShipped = (rows) => rows.map((row) => JSON.stringify(row)).join('\n')
const servedObjects = (rows) =>
  rows
    .map((r) =>
      JSON.stringify({
        kind: 'action',
        issue: r.issueId,
        action: r.action,
        commit: r.id,
        date: r.date,
        title: r.title,
        domain: r.domain,
        tags: r.tags === null ? [] : r.tags.split('\u0001'),
        short: r.short,
      }),
    )
    .join('\n')

const shipped = measure('A 现状：7 槽数组+驻留', () => makeRows('shipped', true), servedShipped)
const noIntern = measure('B 数组，不驻留', () => makeRows('shipped', false), servedShipped)
const legacy = measure('C 旧对象形状（8 键）', () => makeRows('legacy', true), servedObjects)

// 原始 NDJSON 行当 JS 字符串存：含中文的行按两字节/字符，实测最差
const rawLines = measure('D 原始行（JS 字符串）', () => inputs.map((r) => ` ${JSON.stringify(r)}`.slice(1)), (list) => list.join('\n'))

// 原始字节（Buffer 在 JS 堆外，serve≈0）
gc()
const beforeBytes = process.memoryUsage()
const bytesT = time(() => carry())
function carry() {
  return recordLines.map((line) => Buffer.from(line))
}
gc()
const afterBytes = process.memoryUsage()
console.log(
  `E 原始字节（Buffer/行）      heap +${mb(afterBytes.heapUsed - beforeBytes.heapUsed).padStart(5)}  external +${mb(afterBytes.external - beforeBytes.external)}  ${((afterBytes.external - beforeBytes.external) / N).toFixed(0)}B/行  build ${bytesT.ms.toFixed(0)}ms`,
)

// 客户端收行成本：数组 parse 即行；旧形状要 parse + 建对象
const objLines = legacy.map((r) => JSON.stringify({ kind: 'action', issue: r.issueId, action: r.action, commit: r.id, date: r.date, title: r.title, domain: r.domain, tags: r.tags, short: r.short }))
const takeObj = time(() =>
  objLines.map((line) => {
    const e = JSON.parse(line)
    return { issueId: e.issue, action: e.action, id: e.commit, date: e.date, title: e.title, domain: e.domain, tags: e.tags }
  }),
)
const takeAry = time(() => wire.map((line) => JSON.parse(line)))
console.log(`客户端收 100k 行：对象 ${takeObj.ms.toFixed(0)}ms（parse+建对象）  数组 ${takeAry.ms.toFixed(0)}ms（parse 即行）`)

// 折叠在原形状上的开销（客户端 rows + fold 两半）
globalThis.window = { __ModuleLoader__: { load: (d) => (globalThis.__def = d) } }
globalThis.document = { getElementById: () => ({}), createElement: () => ({}) }
globalThis.__DSH_KILN_TEST__ = true
await import('../lib/client.js?probe-format=2')
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
const foldT = time(() => foldIssues(shipped, { start: 'ask', terminal: new Set(['conclude', 'apply']), complete: true }))
gc()
const foldHeap = heap() - beforeFold
console.log(`fold(现状数组)              ${mb(foldHeap).padStart(7)}  ${(foldHeap / N).toFixed(0).padStart(4)}B/行  ${foldT.ms.toFixed(0)}ms  ${foldT.v.length} issue`)
