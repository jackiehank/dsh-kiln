/**
 * 内存探针：动作流缓存“值多少钱、占多少堆”。
 *
 * 用法：`node --expose-gc plugin/test/probe-memory.mjs [repo]`
 *
 * 量四件事，全部用真仓数据：
 *   1. 取数：`kiln action log --jsonl` 的墙钟（子进程 + git + 传输）；
 *   2. 解析：逐行 JSON.parse + mapActionRecord（客户端 take() 做的同一件事）；
 *   3. 常驻：解析后 rows 的堆增量；
 *   4. 折叠：`foldIssues` 的耗时与它额外分配的堆（每个动作一个对象 + 一个 refs 数组）。
 *
 * 沙箱里不能用管道读子进程（EPERM），所以 stdout 直接重定向到临时文件再读回。
 * 只读，不改仓库；数字会随机器与仓库规模变，看趋势不看绝对值。
 */
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mapActionRecord } from '../lib/timeline.js'

const repo = process.argv[2] ?? process.cwd()

// ---------------------------------------------------------------- 载入客户端内部函数

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      loaded = definition
    },
  },
}
globalThis.document = { getElementById: () => ({}), createElement: () => ({}) }
globalThis.__DSH_KILN_TEST__ = true
await import('../lib/client.js?probe-memory=1')

const reactStub = {
  createElement: () => null,
  Fragment: 'fragment',
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}
const { foldIssues } = loaded.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error(`意外的 require: ${name}`)
}).__internals

if (typeof foldIssues !== 'function') throw new Error('client.js 没有导出 foldIssues')

// ---------------------------------------------------------------- 工具

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`
const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`
const ms = (value) => `${value.toFixed(1)}ms`
const gc = () => {
  if (typeof globalThis.gc !== 'function') throw new Error('请用 node --expose-gc 运行')
  globalThis.gc()
  globalThis.gc()
}
const heap = () => process.memoryUsage().heapUsed
const time = (fn) => {
  const started = process.hrtime.bigint()
  const value = fn()
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 }
}

// ---------------------------------------------------------------- 1. 取数

const tmp = mkdtempSync(join(tmpdir(), 'kiln-probe-'))
const outPath = join(tmp, 'actions.ndjson')
const errPath = join(tmp, 'stderr.txt')
const outFd = openSync(outPath, 'w')
const errFd = openSync(errPath, 'w')
const spawnStarted = process.hrtime.bigint()
const run = spawnSync('kiln', ['action', 'log', '--jsonl'], {
  cwd: repo,
  stdio: ['ignore', outFd, errFd],
  windowsHide: true,
})
closeSync(outFd)
closeSync(errFd)
const spawnMs = Number(process.hrtime.bigint() - spawnStarted) / 1e6
if (run.status !== 0) {
  throw new Error(`kiln 退出码 ${run.status}: ${readFileSync(errPath, 'utf8').slice(0, 300)}`)
}

const text = readFileSync(outPath, 'utf8')
const bytes = statSync(outPath).size
const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')

// ---------------------------------------------------------------- 2. 解析 + 映射

gc()
const base = heap()
const parsed = time(() => lines.map((line) => JSON.parse(line)))
const rows = parsed.value.map((record) => mapActionRecord(record)).filter((row) => row !== null)
gc()
const rowsHeap = heap() - base

// ---------------------------------------------------------------- 3. 折叠

gc()
const beforeFold = heap()
const folded = time(() => foldIssues(rows, { start: 'ask', terminal: new Set(['conclude', 'apply']), complete: true }))
gc()
const foldHeap = heap() - beforeFold

// ---------------------------------------------------------------- 4. 放大线性性：10 倍克隆

/** 克隆成 n 倍：issueId / commit / title 都造新串，避免共享字符串低估堆。 */
function cloneRows(source, times) {
  const out = []
  for (let copy = 0; copy < times; copy += 1) {
    for (const row of source) {
      out.push({
        issueId: `${row.issueId}-${copy}`,
        action: row.action,
        id: row.id.slice(0, 32) + copy.toString(16).padStart(8, '0'),
        short: row.short,
        date: row.date,
        title: `${copy}:${row.title}`,
        domain: row.domain,
        tags: row.tags.slice(),
      })
    }
  }
  return out
}

const ratio = rows.length / Math.max(folded.value.length, 1)
const clone10 = cloneRows(rows, 10)
gc()
const beforeClone = heap()
const cloneFold = time(() => foldIssues(clone10, { start: 'ask', terminal: new Set(['conclude', 'apply']), complete: true }))
gc()
const cloneHeap = heap() - beforeClone

// ---------------------------------------------------------------- 5. 每批发布与往返的固定成本

const publish = time(() => {
  const snapshot = rows.slice()
  const index = new Map(folded.value.map((issue) => [issue.id, issue]))
  return { snapshot, index }
})
const stringify = time(() => JSON.stringify(rows))
const stringifyClone = time(() => JSON.stringify(clone10))

// 子进程地板价：同样起一次进程，只读 1 条
const floorPath = join(tmp, 'floor.ndjson')
const floorFd = openSync(floorPath, 'w')
const floorStarted = process.hrtime.bigint()
spawnSync('kiln', ['action', 'log', '--jsonl', '--limit', '1'], {
  cwd: repo,
  stdio: ['ignore', floorFd, 'ignore'],
  windowsHide: true,
})
const floorMs = Number(process.hrtime.bigint() - floorStarted) / 1e6
closeSync(floorFd)

// ---------------------------------------------------------------- 6. 10 万行实测（不是外推）

const target = 100000
const big = cloneRows(rows, Math.ceil(target / rows.length)).slice(0, target)
gc()
const beforeBig = heap()
const bigFold = time(() => foldIssues(big, { start: 'ask', terminal: new Set(['conclude', 'apply']), complete: true }))
const bigPublish = time(() => {
  const snapshot = big.slice()
  const index = new Map(bigFold.value.map((issue) => [issue.id, issue]))
  return { snapshot, index }
})
const bigStringify = time(() => JSON.stringify(big))
const bigLines = big.map((row) => JSON.stringify(row))
const bigParse = time(() => bigLines.map((line) => JSON.parse(line)))
gc()
const bigHeap = heap() - beforeBig

// ---------------------------------------------------------------- 输出

const perRow = rowsHeap / rows.length
const perFold = foldHeap / rows.length
const perRowTotal = perRow + perFold

console.log(`repo            ${repo}`)
console.log(`take            ${ms(spawnMs)}  ${kb(bytes)}  ${rows.length} 行  ${(bytes / rows.length).toFixed(0)}B/行`)
console.log(`parse           ${ms(parsed.ms)}`)
console.log(`rows 堆         ${kb(rowsHeap)}  ${perRow.toFixed(0)}B/行`)
console.log(`fold            ${ms(folded.ms)}  ${folded.value.length} 个 issue（${ratio.toFixed(1)} 动作/issue）`)
console.log(`fold 额外堆     ${kb(foldHeap)}  ${perFold.toFixed(0)}B/行  （×${(perFold / perRow).toFixed(2)} rows）`)
console.log(`克隆 10×        ${clone10.length} 行：fold ${ms(cloneFold.ms)}，堆 ${mb(cloneHeap)}（${(cloneHeap / clone10.length).toFixed(0)}B/行）`)
console.log(`每行合计        ${perRowTotal.toFixed(0)}B（rows + fold）`)
console.log(
  `每批发布        slice+Map ${ms(publish.ms)}（${rows.length} 行）  JSON.stringify ${ms(stringify.ms)}  ${kb(stringify.value.length)}`,
)
console.log(`进程地板        ${ms(floorMs)}（--limit 1，仍然起一次 kiln）`)
console.log(
  `实测 ${big.length} 行  fold ${ms(bigFold.ms)}  slice+Map ${ms(bigPublish.ms)}  stringify ${ms(bigStringify.ms)}（${kb(bigStringify.value.length)}）  逐行 parse ${ms(bigParse.ms)}  堆 ${mb(bigHeap)}`,
)
const perRowStringify = stringifyClone.ms / clone10.length
for (const n of [10000, 50000, 100000]) {
  const size = (bytes / rows.length) * n
  console.log(
    `估算 ${String(n).padStart(6)} 行  ${mb(size)} 传输  fold ${ms((cloneFold.ms / clone10.length) * n)}  stringify ${ms(perRowStringify * n)}  堆 ${mb(perRowTotal * n)}`,
  )
}
console.log(`临时文件        ${outPath}`)
