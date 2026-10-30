/**
 * 动作流缓存：HEAD 没动就不起子进程，把上一次的 rows 按原 NDJSON 重发；
 * HEAD 前进时，**只在能证明前缀安全的情况下**只读新前缀（阶段 3）。
 *
 * 与 `snapshot.js` 同构——`(repo, HEAD, config, bin)` 四件套决定能不能用；两点不同：
 * - 存的是**动作行**而不是聚合结果，命中时要能逐行重发；
 * - 超限不是“退回每次都重算”那么简单，而是记成 `oversize` 并**不再尝试**：
 *   大仓每次都会付全量流的钱，硬存一份只会多占几十 MB。
 *
 * 只存内存，进程重启即丢。**不存原始 NDJSON**：parse 十万行只要几十毫秒，
 * 多留一份原始文本是白占（实测多 25MB）。缓存里只有客户端要的那 8 个字段。
 *
 * 增量判定（`planIncrement`）宁可保守：旧 HEAD 不是祖先、区间内有回退日期的提交、
 * 区间太大、缓存太小，任何一条都回退全量。判定依据与实测见
 * `docs/issues/kiln-memory-cache.md` 的「落地（阶段 3）」一节。
 */
import {
  binaryToken as binaryTokenOf,
  configToken as configTokenOf,
  isAncestor as isAncestorOf,
  rangeAuthorTimes as rangeAuthorTimesOf,
  readHead,
} from './git.js'

/** 单仓上限：5 万行或 20MB（按发出去的 NDJSON 字节算）。超过就 bypass。 */
export const ROWS_LIMIT = 50_000
export const BYTES_LIMIT = 20 * 1024 * 1024
/** 最多留几个仓库（按最后访问淘汰）。 */
export const REPO_LIMIT = 2
/**
 * 前缀增量的门槛：缓存少于这么多行时不值得——两次 git 探测（祖先 + 日期）
 * 本身就要 40–60ms，还不如整条重读。大仓（10 万行）一次全读约 166ms，才有得赚。
 */
export const INCREMENT_MIN_ROWS = 5_000
/** 一次增量最多容忍多少个新提交；超过说明“增量”不比全量便宜，直接重读。 */
export const INCREMENT_MAX_COMMITS = 2_000

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
    isAncestor: isAncestorOf,
    rangeAuthorTimes: rangeAuthorTimesOf,
    ...(deps.git ?? {}),
  }
  const limits = {
    rows: Number.isInteger(deps.rowsLimit) ? deps.rowsLimit : ROWS_LIMIT,
    bytes: Number.isInteger(deps.bytesLimit) ? deps.bytesLimit : BYTES_LIMIT,
    repos: Number.isInteger(deps.repoLimit) ? deps.repoLimit : REPO_LIMIT,
    incrementMinRows: Number.isInteger(deps.incrementMinRows) ? deps.incrementMinRows : INCREMENT_MIN_ROWS,
    incrementMaxCommits: Number.isInteger(deps.incrementMaxCommits)
      ? deps.incrementMaxCommits
      : INCREMENT_MAX_COMMITS,
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
    const previous = store.get(repo) ?? null

    if (options.fresh === true) {
      store.delete(repo)
      oversize.delete(repo)
      stats.build += 1
      return { mode: 'build', reason: 'fresh', ...probe, previousHead: '' }
    }
    if (options.enabled === false) {
      stats.bypass += 1
      return { mode: 'bypass', reason: 'disabled', ...probe, previousHead: previous?.head ?? '' }
    }
    if (oversize.get(repo) === probe.binToken) {
      stats.bypass += 1
      return { mode: 'bypass', reason: 'oversize', ...probe, previousHead: previous?.head ?? '' }
    }

    const decision = evaluateRowsCache(previous, probe, { enabled: true })
    stats[decision.mode] += 1
    return { ...decision, ...probe, previousHead: previous?.head ?? '' }
  }

  /** 当前缓存条目（不动 LRU）：增量路径要拿它的行与字节数。 */
  function peek(repo) {
    return store.get(repo) ?? null
  }

  /** 再读一次 HEAD：增量读完用它确认“这期间没有新提交混进来”。 */
  async function headNow(repo) {
    try {
      return await git.readHead(repo)
    } catch {
      return null
    }
  }

  /**
   * 能不能只读“新前缀”。这是**可靠性优先**的判定：任何一条不满足就全量重读。
   *
   * 前置（缺一不可）：
   * 1. 本次是 `head-moved`，且缓存够大（小仓全读更快，不值得冒风险）；
   * 2. 旧 HEAD 是新 HEAD 的祖先（否则历史被改写，缓存里的行可能是幽灵）；
   * 3. `旧 HEAD..新 HEAD` 里**所有**提交的 author 时间都严格晚于缓存首行的日期——
   *    kiln 用 `git log --author-date-order`，父子关系保证子在前，但合并进来的旁支
   *    只按日期排；旧日期的旁支会排到 boundary 之后，前缀读法就会漏掉它们。
   *
   * 任何一项探测失败/超时都返回 `full`：宁可多读一次，不可少一行。
   */
  async function planIncrement(repo, decision) {
    if (decision?.mode !== 'build' || decision?.reason !== 'head-moved') {
      return { mode: 'full', reason: decision?.reason ?? 'not-head-moved' }
    }
    const entry = store.get(repo)
    if (entry === null || entry === undefined || !Array.isArray(entry.rows) || entry.rows.length === 0) {
      return { mode: 'full', reason: 'no-cache' }
    }
    if (entry.rows.length < limits.incrementMinRows) return { mode: 'full', reason: 'cache-too-small' }
    // 配置/二进制变了就不做增量（decide 已经把这种情况判成 build，这里再兜一次）
    if (entry.configToken !== decision.configToken || entry.binToken !== decision.binToken) {
      return { mode: 'full', reason: 'tokens-changed' }
    }

    const boundary = entry.rows[0]
    const boundaryMs = Date.parse(String(boundary?.date ?? ''))
    if (!Number.isFinite(boundaryMs)) return { mode: 'full', reason: 'boundary-date-unknown' }

    let ancestor = null
    try {
      ancestor = await git.isAncestor(repo, entry.head, decision.head)
    } catch {
      ancestor = null
    }
    if (ancestor !== true) return { mode: 'full', reason: ancestor === false ? 'not-ancestor' : 'ancestor-unknown' }

    let range = null
    try {
      range = await git.rangeAuthorTimes(repo, entry.head, decision.head, limits.incrementMaxCommits)
    } catch {
      range = null
    }
    if (range === null || !Number.isInteger(range.count) || range.count === 0) {
      return { mode: 'full', reason: 'range-unknown' }
    }
    if (range.count > limits.incrementMaxCommits) return { mode: 'full', reason: 'range-too-large' }
    if (!(range.min * 1000 > boundaryMs)) return { mode: 'full', reason: 'back-dated' }

    return {
      mode: 'incremental',
      reason: 'prefix-safe',
      boundary: boundary.id,
      commits: range.count,
      previousHead: entry.head,
    }
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
    peek,
    headNow,
    planIncrement,
    rows,
    commit,
    clear,
    markOversize,
    limits: () => ({ ...limits }),
    stats: () => ({ ...stats }),
    oversizeReason: (repo) => oversize.get(repo) ?? null,
  }
}
