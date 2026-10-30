/**
 * 动作流缓存（阶段 1）：HEAD 没动就不起子进程，把上一次的 rows 按原 NDJSON 重发。
 *
 * 与 `snapshot.js` 同构——`(repo, HEAD, config, bin)` 四件套决定能不能用；两点不同：
 * - 存的是**动作行**而不是聚合结果，命中时要能逐行重发；
 * - 超限不是“退回每次都重算”那么简单，而是记成 `oversize` 并**不再尝试**：
 *   大仓每次都会付全量流的钱，硬存一份只会多占几十 MB。
 *
 * 只存内存，进程重启即丢。**不存原始 NDJSON**：parse 十万行只要几十毫秒，
 * 多留一份原始文本是白占（实测多 25MB）。缓存里只有客户端要的那 8 个字段。
 *
 * 阶段 1 不做增量：HEAD 变了就整条重读。前缀增量的前置条件与回退判据见
 * `docs/issues/kiln-memory-cache.md` 的「增量算法」一节。
 */
import { binaryToken as binaryTokenOf, configToken as configTokenOf, readHead } from './git.js'

/** 单仓上限：5 万行或 20MB（按发出去的 NDJSON 字节算）。超过就 bypass。 */
export const ROWS_LIMIT = 50_000
export const BYTES_LIMIT = 20 * 1024 * 1024
/** 最多留几个仓库（按最后访问淘汰）。 */
export const REPO_LIMIT = 2

/**
 * 纯决策（不碰 I/O，便于单测）：这次请求走 `hit` / `build` / `bypass` 哪条路。
 *
 * - `head` 读不到 → bypass：没有失效键就不缓存，行为与今天一致；
 * - 二进制或配置换了 → build：解析语义可能变，宁可重来；
 * - HEAD 没动 → hit；动了 → build（阶段 1 全量，阶段 3 才换成增量）。
 */
export function evaluateRowsCache(previous, probe, options = {}) {
  if (options.enabled === false) return { mode: 'bypass', reason: 'disabled' }
  if (typeof probe?.head !== 'string' || probe.head === '') return { mode: 'bypass', reason: 'head-unavailable' }
  if (previous === null || previous === undefined) return { mode: 'build', reason: 'cold' }
  if (previous.configToken !== probe.configToken) return { mode: 'build', reason: 'config-changed' }
  if (previous.binToken !== probe.binToken) return { mode: 'build', reason: 'binary-changed' }
  if (previous.head === probe.head) return { mode: 'hit', reason: 'head-unchanged' }
  return { mode: 'build', reason: 'head-moved' }
}

export function createRowsCache(deps = {}) {
  const git = {
    readHead,
    configToken: configTokenOf,
    binaryToken: binaryTokenOf,
    ...(deps.git ?? {}),
  }
  const limits = {
    rows: Number.isInteger(deps.rowsLimit) ? deps.rowsLimit : ROWS_LIMIT,
    bytes: Number.isInteger(deps.bytesLimit) ? deps.bytesLimit : BYTES_LIMIT,
    repos: Number.isInteger(deps.repoLimit) ? deps.repoLimit : REPO_LIMIT,
  }
  /** repo → { head, configToken, binToken, rows, bytes }；Map 的插入序就是 LRU 序。 */
  const store = new Map()
  /** repo → binToken：这个仓太大，本会话不再尝试；换二进制后允许重试。 */
  const oversize = new Map()
  const stats = { hit: 0, build: 0, bypass: 0, stored: 0, dropped: 0 }

  /**
   * 探 HEAD/配置/二进制，给出这次该走哪条路。
   * `fresh`（刷新按钮）= 丢掉缓存并强制重建，重建成功后照常写回。
   */
  async function decide(repo, bin, options = {}) {
    let head = null
    try {
      head = await git.readHead(repo)
    } catch {
      head = null
    }
    const probe = {
      head,
      configToken: git.configToken(repo),
      binToken: git.binaryToken(typeof bin === 'string' ? bin : ''),
    }

    if (options.fresh === true) {
      store.delete(repo)
      oversize.delete(repo)
      stats.build += 1
      return { mode: 'build', reason: 'fresh', ...probe }
    }
    if (options.enabled === false) {
      stats.bypass += 1
      return { mode: 'bypass', reason: 'disabled', ...probe }
    }
    if (oversize.get(repo) === probe.binToken) {
      stats.bypass += 1
      return { mode: 'bypass', reason: 'oversize', ...probe }
    }

    const decision = evaluateRowsCache(store.get(repo) ?? null, probe, { enabled: true })
    stats[decision.mode] += 1
    return { ...decision, ...probe }
  }

  /** 命中的行（没有就是 null）。命中后把它挪到 LRU 末尾。 */
  function rows(repo) {
    const entry = store.get(repo)
    if (entry === undefined) return null
    store.delete(repo)
    store.set(repo, entry)
    return entry.rows
  }

  /**
   * 流读完了才写缓存：`bytes` 是这次发出去的 NDJSON 字节数。
   * 超限就把仓库记成 oversize 并丢掉这份（不保留半截——半截会让折叠算错 done）。
   */
  function commit(repo, entry) {
    const list = Array.isArray(entry?.rows) ? entry.rows : []
    const bytes = Number.isFinite(entry?.bytes) ? entry.bytes : 0
    const head = typeof entry?.head === 'string' ? entry.head : ''
    if (head === '' || list.length > limits.rows || bytes > limits.bytes) {
      store.delete(repo)
      stats.dropped += 1
      // 读得到 HEAD 才记 oversize；读不到只是这次不存，下次还值得再试
      if (head !== '') oversize.set(repo, entry?.binToken ?? '')
      return { stored: false, reason: head === '' ? 'head-unavailable' : 'oversize' }
    }
    store.delete(repo)
    store.set(repo, {
      head,
      configToken: entry?.configToken ?? '',
      binToken: entry?.binToken ?? '',
      rows: list,
      bytes,
    })
    while (store.size > limits.repos) store.delete(store.keys().next().value)
    stats.stored += 1
    return { stored: true }
  }

  function clear(repo) {
    if (typeof repo === 'string' && repo !== '') {
      store.delete(repo)
      oversize.delete(repo)
      return
    }
    store.clear()
    oversize.clear()
  }

  /**
   * 流读到一半就发现超限：不写缓存，并把这个仓记成 oversize。
   * 记的是 binToken——升级 kiln 之后允许重新试一次（解析变小或修好都说不定）。
   */
  function markOversize(repo, binToken) {
    store.delete(repo)
    oversize.set(repo, typeof binToken === 'string' ? binToken : '')
    stats.dropped += 1
  }

  return {
    decide,
    rows,
    commit,
    clear,
    markOversize,
    limits: () => ({ ...limits }),
    stats: () => ({ ...stats }),
    oversizeReason: (repo) => oversize.get(repo) ?? null,
  }
}
