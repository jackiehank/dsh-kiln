/**
 * 性能探针：量关系图冷/热、详情单条、以及旧“按 issue 预取”的对照。
 *
 * 用法：node plugin/test/probe-perf.mjs [repo...]（默认当前目录）
 * 只读：只跑 `kiln --json` 与直读 HEAD，不写任何文件。数字打到 stdout，供 issue 文档引用。
 */
import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readGraph, readIssue, resolveKiln } from '../lib/flow.js'
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

/** 改造前的取法：一条 issue 一个进程（并发 8）。只用来对照，不再参与取数。 */
async function legacyPerId(repo, ids, limit = 8) {
  const { ms } = await timeIt(async () => {
    let next = 0
    const workers = Array.from({ length: Math.min(limit, ids.length) }, async () => {
      while (next < ids.length) {
        const id = ids[next++]
        await run(bin, ['path', id, '--json'], {
          cwd: repo,
          timeout: 20_000,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        })
      }
    })
    await Promise.all(workers)
  })
  return ms
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
    console.log(
      `graph: ${graphRead.ms.toFixed(0)} ms · nodes=${nodes.length} · edges=${graph.graph?.edges?.length ?? 0} · bytes=${JSON.stringify(graph.graph).length}`,
    )

    const cache = createSnapshotCache()
    const cold = await timeIt(() => cache.get(repo))
    console.log(
      `cold get: ${cold.ms.toFixed(0)} ms · cache=${cold.value.cache?.action} · payload=${JSON.stringify(cold.value).length} B`,
    )
    const hit = await timeIt(() => cache.get(repo))
    console.log(`hit get: ${hit.ms.toFixed(1)} ms · cache=${hit.value.cache?.action}`)
    cache.clear()

    const detail = await timeIt(() => readIssue(repo, ids[0]))
    console.log(
      `详情 path ${ids[0]}: ${detail.ms.toFixed(0)} ms · ok=${detail.value.ok} · bytes=${JSON.stringify(detail.value).length}`,
    )

    // 单飞：冷缓存上同时发两个请求，应该只跑一轮构建
    const shared = createSnapshotCache()
    const coalesce = await timeIt(async () => Promise.all([shared.get(repo), shared.get(repo)]))
    const actions = coalesce.value.map((payload) => payload.cache?.action ?? 'unknown')
    console.log(`两个并发请求: ${coalesce.ms.toFixed(0)} ms · ${actions.join(' + ')}`)

    const legacy = await legacyPerId(repo, ids)
    console.log(`旧法 ${ids.length} 次 path @8：${legacy.toFixed(0)} ms（${ids.length} 个进程）`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
