/**
 * 关系图缓存：HEAD 变了才重取，其余情况直接用上一次的 `kiln graph --json`。
 *
 * 失效四元组：repo / HEAD / `.kilnconfig.jsonc` 的 mtime+size / kiln 可执行文件。
 * 只缓存关系图（约 0.45 KB/issue）；详情按 issue 现取，不进这里——
 * v0.4.0 的单条 `path` 只要一次进程，没必要为它维护第二套失效逻辑。
 *
 * 缓存只在内存：进程重启后首个请求走全量，不写任何磁盘文件。
 */
import { buildGraph, readGraph } from './flow.js'
import { binaryToken, configToken, readHead } from './git.js'

/** 纯决策（不做 I/O，便于单测）：这次请求该走哪条路。 */
export function evaluateCache(previous, probe) {
  if (previous === null || previous === undefined) return { action: 'build', reason: 'cold' }
  if (previous.repo !== probe.repo) return { action: 'build', reason: 'repo-changed' }
  if (previous.configToken !== probe.configToken) return { action: 'build', reason: 'config-changed' }
  if (previous.binToken !== probe.binToken) return { action: 'build', reason: 'binary-changed' }
  if (previous.head === probe.head) return { action: 'hit', reason: 'head-unchanged' }
  return { action: 'changed', reason: 'head-moved' }
}

function failurePayload(repo, reason, message) {
  return {
    repo,
    generatedAt: new Date().toISOString(),
    ok: false,
    reason,
    ...(message === undefined ? {} : { message }),
  }
}

export function createSnapshotCache(deps = {}) {
  const git = { readHead, configToken, binaryToken, ...(deps.git ?? {}) }
  const flow = { readGraph, buildGraph, ...(deps.flow ?? {}) }
  const store = new Map()
  /** 同一仓库的构建中请求：连点刷新不该把同一张图跑两遍。 */
  const inflight = new Map()
  const stats = { hit: 0, build: 0, coalesced: 0, failure: 0 }

  /**
   * 跑一次构建；合并**只在**「构建结果的 head 等于本次探测的 head」时成立：
   * 两个请求之间 HEAD 可能又动了，拿旧 HEAD 的图顶新请求就是错数据。
   */
  async function buildOnce(repo, probe) {
    const running = inflight.get(repo)
    if (running !== undefined) {
      const joined = await running
      if (joined.ok === true && joined.record.head === probe.head) return { ...joined, joined: true }
    }
    const promise = buildRecord(repo, probe)
    inflight.set(repo, promise)
    try {
      return await promise
    } finally {
      if (inflight.get(repo) === promise) inflight.delete(repo)
    }
  }

  async function buildRecord(repo, probe) {
    const graph = await flow.readGraph(repo)
    if (graph.ok !== true) return { ok: false, reason: graph.reason, message: graph.message }
    return {
      ok: true,
      record: {
        repo,
        head: probe.head,
        configToken: probe.configToken,
        binToken: probe.binToken,
        payload: flow.buildGraph({ repo, graph: graph.graph }),
      },
    }
  }

  /**
   * 取关系图。永远 resolve：失败时带 ok:false 与 reason，前端据此显示降级提示。
   * `ms` 是这次请求在宿主侧花的时间（含子进程），界面上要能复核。
   */
  async function get(repo, options = {}) {
    const started = Date.now()
    const payload = await compute(repo, options)
    return { ...payload, cache: { ...(payload?.cache ?? {}), ms: Date.now() - started } }
  }

  async function compute(repo, options) {
    const dir = typeof repo === 'string' ? repo : ''
    const bin = typeof options.bin === 'string' ? options.bin : null

    let head = null
    try {
      head = await git.readHead(dir)
    } catch {
      head = null
    }
    const probe = { repo: dir, head, configToken: git.configToken(dir), binToken: git.binaryToken(bin) }

    // 读不到 HEAD（不是 git 仓库 / 权限异常）：不缓存，行为与无缓存时一致。
    if (head === null) {
      const built = await buildOnce(dir, probe)
      if (built.ok !== true) {
        stats.failure += 1
        return failurePayload(dir, built.reason, built.message)
      }
      if (built.joined === true) stats.coalesced += 1
      else stats.build += 1
      return { ...built.record.payload, cache: { action: built.joined === true ? 'coalesced' : 'build', reason: 'head-unavailable' } }
    }

    const previous = store.get(dir) ?? null
    const decision = evaluateCache(previous, probe)

    if (decision.action === 'hit') {
      stats.hit += 1
      return { ...previous.payload, cache: { action: 'hit', reason: decision.reason } }
    }

    const built = await buildOnce(dir, probe)
    if (built.ok !== true) {
      stats.failure += 1
      return failurePayload(dir, built.reason, built.message)
    }
    store.set(dir, built.record)
    if (built.joined === true) stats.coalesced += 1
    else stats.build += 1
    return {
      ...built.record.payload,
      cache: {
        action: built.joined === true ? 'coalesced' : 'build',
        reason: decision.reason,
      },
    }
  }

  /** 丢弃一个仓库的缓存（测试与排障用）。 */
  function clear(repo) {
    if (typeof repo === 'string' && repo !== '') store.delete(repo)
    else store.clear()
  }

  return { get, clear, stats: () => ({ ...stats }) }
}
