/**
 * 快照缓存：用 HEAD 做失效令牌，HEAD 前进时按 issue 增量重取。
 *
 * 失效四元组：repo / HEAD / `.kilnconfig.jsonc` 的 mtime+size / kiln 可执行文件。
 * 增量条件：旧 HEAD 是**新 HEAD 的祖先**，且 `旧HEAD..新HEAD` 的 trailer 能被 git 完整判定。
 * 其余情况一律全量重建——宁可多跑，不出错数据。
 *
 * 缓存只在内存：进程重启后首个请求走全量，不写任何磁盘文件。
 */
import { buildFlow, readFlow, readGraph, readHistories } from './flow.js'
import { binaryToken, configToken, isAncestor, newIssueIds, readHead } from './git.js'

const DEFAULT_MAX_ISSUES = 80

/** 纯决策（不做 I/O，便于单测）：这次请求该走哪条路。 */
export function evaluateCache(previous, probe) {
  if (previous === null || previous === undefined) return { action: 'build', reason: 'cold' }
  if (previous.repo !== probe.repo) return { action: 'build', reason: 'repo-changed' }
  if (previous.maxIssues !== probe.maxIssues) return { action: 'build', reason: 'capacity-changed' }
  if (previous.configToken !== probe.configToken) return { action: 'build', reason: 'config-changed' }
  if (previous.binToken !== probe.binToken) return { action: 'build', reason: 'binary-changed' }
  if (previous.head === probe.head) return { action: 'hit', reason: 'head-unchanged' }
  return { action: 'changed', reason: 'head-moved' }
}

/** 把请求里的 focus 叠到已构建的 payload 上；快照里没有的 id 不认（不静默换人）。 */
export function applyFocus(payload, focus) {
  if (typeof focus !== 'string' || focus === '') return payload
  if (!Array.isArray(payload?.issues)) return payload
  if (!payload.issues.some((issue) => issue.id === focus)) return payload
  return { ...payload, focus }
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
  const git = { readHead, configToken, binaryToken, isAncestor, newIssueIds, ...(deps.git ?? {}) }
  const flow = { readFlow, readGraph, readHistories, buildFlow, ...(deps.flow ?? {}) }
  const store = new Map()
  const stats = { hit: 0, build: 0, incremental: 0, failure: 0 }

  function maxIssuesOf(options) {
    return Number.isInteger(options?.maxIssues) && options.maxIssues > 0 ? options.maxIssues : DEFAULT_MAX_ISSUES
  }

  /**
   * 重建一条记录。
   * 给了 previous 且 seed 非空时走增量：保留旧 histories，只补 seed 里的 issue 和“新出现的 issue”。
   */
  async function buildRecord(repo, probe, { previous = null, seed = null, maxIssues } = {}) {
    const graphResult = await flow.readGraph(repo)
    if (graphResult.ok !== true) return { ok: false, reason: graphResult.reason, message: graphResult.message }

    const graph = graphResult.graph
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
    const nodeIds = nodes.slice(0, maxIssues).map((node) => node.id)
    const kept = new Set(nodeIds)

    const histories = new Map()
    if (previous !== null) {
      for (const id of nodeIds) {
        const cached = previous.histories.get(id)
        if (Array.isArray(cached)) histories.set(id, cached)
      }
    }
    const missing = nodeIds.filter((id) => !histories.has(id))
    const touched = seed === null ? [] : [...seed].filter((id) => kept.has(id))
    const fetchIds = [...new Set([...missing, ...touched])]
    if (fetchIds.length > 0) {
      const fresh = await flow.readHistories(repo, fetchIds)
      for (const [id, actions] of fresh) histories.set(id, actions)
    }

    const payload = flow.buildFlow({ repo, graph, histories, maxIssues })
    return {
      ok: true,
      record: { repo, head: probe.head, maxIssues, configToken: probe.configToken, binToken: probe.binToken, histories, payload },
    }
  }

  /**
   * 取一份快照。永远 resolve：失败时带 ok:false 与 reason（与 `readFlow` 同形），
   * 额外带 `cache: { action, reason?, issues? }` 便于观测与验证。
   */
  async function get(repo, options = {}) {
    const dir = typeof repo === 'string' ? repo : ''
    const maxIssues = maxIssuesOf(options)
    const bin = typeof options.bin === 'string' ? options.bin : null

    let head = null
    try {
      head = await git.readHead(dir)
    } catch {
      head = null
    }
    const probe = {
      repo: dir,
      head,
      maxIssues,
      configToken: git.configToken(dir),
      binToken: git.binaryToken(bin),
    }

    // 读不到 HEAD（不是 git 仓库 / 权限异常）：不缓存，行为与改造前一致。
    if (head === null) {
      const built = await buildRecord(dir, probe, { maxIssues })
      if (built.ok !== true) {
        stats.failure += 1
        return failurePayload(dir, built.reason, built.message)
      }
      stats.build += 1
      return {
        ...applyFocus(built.record.payload, options.focus),
        cache: { action: 'build', reason: 'head-unavailable' },
      }
    }

    const previous = store.get(dir) ?? null
    const decision = evaluateCache(previous, probe)

    if (decision.action === 'hit') {
      stats.hit += 1
      return { ...applyFocus(previous.payload, options.focus), cache: { action: 'hit', reason: decision.reason } }
    }

    if (decision.action === 'build') {
      const built = await buildRecord(dir, probe, { maxIssues })
      if (built.ok !== true) {
        stats.failure += 1
        return failurePayload(dir, built.reason, built.message)
      }
      store.set(dir, built.record)
      stats.build += 1
      return {
        ...applyFocus(built.record.payload, options.focus),
        cache: { action: 'build', reason: decision.reason },
      }
    }

    // HEAD 动过：先确认是前进，再算增量
    let ancestor = false
    try {
      ancestor = await git.isAncestor(dir, previous.head, head)
    } catch {
      ancestor = false
    }
    if (ancestor) {
      const delta = await git.newIssueIds(dir, previous.head, head)
      if (delta.ok) {
        const built = await buildRecord(dir, probe, { previous, seed: delta.ids, maxIssues })
        if (built.ok === true) {
          store.set(dir, built.record)
          stats.incremental += 1
          return {
            ...applyFocus(built.record.payload, options.focus),
            cache: { action: 'incremental', issues: [...delta.ids] },
          }
        }
      }
    }

    // 历史被改写（rebase / 切分支 / force）或增量不可判定：全量
    const built = await buildRecord(dir, probe, { maxIssues })
    if (built.ok !== true) {
      stats.failure += 1
      return failurePayload(dir, built.reason, built.message)
    }
    store.set(dir, built.record)
    stats.build += 1
    return {
      ...applyFocus(built.record.payload, options.focus),
      cache: { action: 'build', reason: ancestor ? 'delta-unusable' : 'history-rewritten' },
    }
  }

  /** 丢弃一个仓库的缓存（测试与排障用）。 */
  function clear(repo) {
    if (typeof repo === 'string' && repo !== '') store.delete(repo)
    else store.clear()
  }

  return { get, clear, stats: () => ({ ...stats }) }
}
