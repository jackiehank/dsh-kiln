/**
 * 性能探针：量冷启动、命中、并发度对一次快照构建的影响。
 *
 * 用法：node plugin/test/probe-perf.mjs [repo...]（默认当前目录）
 * 只读：只跑 `kiln --json` 与直读 HEAD，不写任何文件。数字打到 stdout，供 issue 文档引用。
 */
import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { buildFlow, readGraph, readHistories, resolveKiln } from '../lib/flow.js'
import { createSnapshotCache } from '../lib/snapshot.js'

const run = promisify(execFile)
const repos = process.argv.slice(2).map((value) => (isAbsolute(value) ? value : resolve(value)))
if (repos.length === 0) repos.push(process.cwd())

const bin = resolveKiln()
if (bin === null) {
  console.error('找不到 kiln（PATH 或 DSH_KILN_BIN）')
  process.exit(1)
}

async function timeIt(fn) {
  const started = process.hrtime.bigint()
  const value = await fn()
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, value }
}

/** 按同样的 worker 池跑一遍 `kiln path`，只为比较并发度（readHistories 的并发是模块常量）。 */
async function sweep(repo, ids) {
  const out = []
  for (const limit of [2, 4, 8, 12, 16, 24]) {
    const { ms } = await timeIt(async () => {
      let next = 0
      const workers = Array.from({ length: Math.min(limit, ids.length) }, async () => {
        while (next < ids.length) {
          const id = ids[next++]
          await run(bin, ['path', id, '--json'], { cwd: repo, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
        }
      })
      await Promise.all(workers)
    })
    out.push(`${limit}→${ms.toFixed(0)}ms`)
  }
  return out
}

async function main() {
  console.log(`cpus=${cpus().length} node=${process.version} kiln=${bin}`)
  for (const repo of repos) {
    console.log(`\n## ${repo}`)
    const graphRead = await timeIt(() => readGraph(repo))
    const graph = graphRead.value
    if (graph.ok !== true) {
      console.log(`graph 失败: ${graph.reason}${graph.message ? ` · ${graph.message}` : ''}`)
      continue
    }
    const nodes = Array.isArray(graph.graph?.nodes) ? graph.graph.nodes : []
    const ids = nodes.map((node) => node.id)
    console.log(`graph: ${graphRead.ms.toFixed(0)} ms · nodes=${nodes.length} · edges=${graph.graph?.edges?.length ?? 0} · bytes=${JSON.stringify(graph.graph).length}`)

    const cache = createSnapshotCache()
    const cold = await timeIt(() => cache.get(repo))
    console.log(
      `cold get: ${cold.ms.toFixed(0)} ms · cache=${cold.value.cache?.action} · payload=${JSON.stringify(cold.value).length} B`,
    )
    const hit = await timeIt(() => cache.get(repo))
    console.log(`hit get: ${hit.ms.toFixed(1)} ms · cache=${hit.value.cache?.action}`)
    cache.clear()

    const perCall = await timeIt(() => readHistories(repo, ids.slice(0, 1)))
    console.log(`readHistories(1): ${perCall.ms.toFixed(0)} ms`)
    const hist = await timeIt(() => readHistories(repo, ids))
    console.log(`readHistories(${ids.length}) @当前并发: ${hist.ms.toFixed(0)} ms`)

    const built = await timeIt(() => buildFlow({ repo, graph: graph.graph, histories: hist.value }))
    console.log(`buildFlow: ${built.ms.toFixed(1)} ms`)

    console.log(`并发扫描: ${(await sweep(repo, ids)).join('  ')}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
