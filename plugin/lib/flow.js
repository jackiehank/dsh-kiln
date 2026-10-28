/**
 * Flow 数据层：把一个 kiln 仓库读成一份只读快照。
 *
 * 这里只做两件事——调 `kiln graph --json` 取 issue 与折叠后的关系边，调
 * `kiln path <id> … --json`（v0.2.0 的批量形态）一次取多条 issue 的动作序列。语义（关系强弱、层级、
 * 方向）全部留给定词表的前端，宿主不判断“什么算重要”。
 */
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const RUN_TIMEOUT_MS = 20_000
const MAX_BUFFER = 8 * 1024 * 1024
const DEFAULT_MAX_ISSUES = 80
/** 插件只支持 v0.2.0+：批量 `path` 的契约从这一版开始（旧版对多 id 静默只回第一条）。 */
const KILN_MIN_VERSION = '0.2.0'
const MAX_TITLE = 200

/** 一次 kiln 调用失败时携带可读原因，方便路由层原样透出。 */
export class KilnError extends Error {
  constructor(message) {
    super(message)
    this.name = 'KilnError'
  }
}

const truncate = (text) =>
  typeof text === 'string' && text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text ?? ''

/** 每个目录只探测一次；探测结果随进程存活。 */
const kilnBinaries = new Map()

/** 在 PATH 上找 kiln（Windows 需要逐个拼 PATHEXT）。 */
function findOnPath(command) {
  const dirs = String(process.env.PATH ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .filter(Boolean)
  const exts =
    process.platform === 'win32'
      ? ['', ...String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')]
      : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${command}${ext}`)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // 下一个候选
      }
    }
  }
  return null
}

/** 解析 kiln 可执行文件：显式环境变量优先，其次 PATH。 */
export function resolveKiln() {
  if (kilnBinaries.has('*')) return kilnBinaries.get('*')
  const explicit = process.env.DSH_KILN_BIN ?? process.env.KILN_BIN
  let resolved = null
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) resolved = explicit
  else resolved = findOnPath('kiln')
  kilnBinaries.set('*', resolved)
  return resolved
}

/** 详情页里恢复探测，避免用户装好 kiln 后还要重启 DSH。 */
export function forgetKiln() {
  kilnBinaries.delete('*')
}

/**
 * 跑一次 kiln，**不因退出码非零就丢掉 stdout**：`path` 批量在部分 issue 取不到时
 * 仍会给出完整文档（`errors` 数组 + exit 1），调用方要自己判断能不能解析。
 *
 * ENOENT / EACCES 这类「根本没跑起来」的错误没有数字退出码，仍抛 KilnError。
 */
async function execKiln(bin, args, cwd) {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      cwd,
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    if (typeof error?.code === 'number') {
      return {
        code: error.code,
        stdout: typeof error.stdout === 'string' ? error.stdout : '',
        stderr: typeof error.stderr === 'string' ? error.stderr.trim() : '',
      }
    }
    throw new KilnError(String(error?.message ?? error))
  }
}

function reasonOf(result) {
  return result.stderr !== '' ? result.stderr.split(/\r?\n/)[0] : `kiln 退出码 ${result.code}`
}

async function runKiln(bin, args, cwd) {
  const result = await execKiln(bin, args, cwd)
  if (result.code !== 0) throw new KilnError(reasonOf(result))
  return result.stdout
}

/** 目录是不是一个 kiln 仓库：只有 .kilnconfig.jsonc 是登记在仓库里的判据。 */
export function isKilnRepo(dir) {
  try {
    return isAbsolute(dir) && statSync(dir).isDirectory() && existsSync(join(dir, '.kilnconfig.jsonc'))
  } catch {
    return false
  }
}

/**
 * `kiln path --json` 的 actions → 视图需要的字段（保留完整 sha 与短哈希）。
 *
 * v0.2.0 的哈希键是 `commit`（`id` 只指 issue）；没有提交时给空串，不猜旧键。
 */
export function mapActions(document) {
  const actions = Array.isArray(document?.actions) ? document.actions : []
  return actions.map((action) => {
    const sha = typeof action.commit === 'string' ? action.commit : ''
    return {
      ordinal: action.ordinal,
      action: action.action,
      /** 完整提交 sha：缓存增量失效与 timeline 的“跳回提交”都要它。 */
      id: sha,
      /** 展示用的短哈希（7 位）；空提交没有 id，保持空串而不是猜。 */
      short: sha.slice(0, 7),
      date: action.date,
      title: truncate(action.title),
      /** 该动作声明的 refs：timeline 展开时显示，空就是空，不补默认值。 */
      refs: Array.isArray(action.refs) ? action.refs.map((ref) => String(ref)) : [],
    }
  })
}

/**
 * 解析 `kiln path` 的 JSON：单条与批量两种形状。
 *
 * - 给多个 id 时必须是 `{ issues: [...], errors?: [...] }`（v0.2.0+）；
 * - 给一个 id 时是裸 pathDoc——v0.2.0 也这样，单条形状本身不是「旧版」的证据。
 *
 * `errors`（`unknown-issue` / `stat-failed`）里的 issue 不产生动作序列，保持空。
 */
export function parsePathDocument(document) {
  if (Array.isArray(document?.issues)) {
    const histories = new Map()
    for (const doc of document.issues) {
      if (typeof doc?.issue !== 'string') continue
      histories.set(doc.issue, mapActions(doc))
    }
    return { kind: 'batch', histories }
  }
  if (typeof document?.issue === 'string' && Array.isArray(document?.actions)) {
    return { kind: 'single', histories: new Map([[document.issue, mapActions(document)]]) }
  }
  return { kind: 'unknown', histories: new Map() }
}

/**
 * 多 id 请求的形状校验：返回错误文案，合格返回 null。
 *
 * v0.1.1 对多余 id **静默只回第一条**（exit 0、文档还是裸 pathDoc），所以「多条却拿到
 * 单条」必须报错，不能把第一条当全部——这是旧版兼容最危险的坑，也是版本下限的判据。
 */
export function pathShapeError(parsed, requestedCount) {
  if (parsed.kind === 'batch') return null
  if (parsed.kind === 'single' && requestedCount === 1) return null
  if (parsed.kind === 'single') {
    return `需要 kiln v${KILN_MIN_VERSION}+：path 批量只回了单条文档（旧版会静默丢弃其余 id）`
  }
  return 'kiln path 输出形状不认识（既不是批量文档，也不是单条 pathDoc）'
}

/**
 * 纯变换：把已经拿到的 graph 文档与每条 issue 的动作序列折成 Flow 快照。
 *
 * 与 `readFlow` 分开导出，便于在没有子进程的环境（沙箱、测试）里用真实
 * kiln 输出离线验证布局所需的每个字段。
 *
 * @param input - { repo, graph, histories: Map<id, actions>, focus, maxIssues }
 */
export function buildFlow(input) {
  const repo = String(input?.repo ?? '')
  const graph = input?.graph ?? {}
  const histories = input?.histories instanceof Map ? input.histories : new Map()
  const maxIssues =
    Number.isInteger(input?.maxIssues) && input.maxIssues > 0 ? input.maxIssues : DEFAULT_MAX_ISSUES

  const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph.edges) ? graph.edges : []
  const kept = nodes.slice(0, maxIssues)

  const issues = kept.map((node) => {
    const actions = Array.isArray(histories.get(node.id)) ? histories.get(node.id) : []
    const last = actions.length > 0 ? actions[actions.length - 1] : null
    return {
      id: node.id,
      domain: node.domain ?? '',
      action: node.action ?? '',
      done: node.done === true,
      title: truncate(node.title),
      tags: Array.isArray(node.tags) ? node.tags : [],
      actions,
      last,
    }
  })

  const ids = new Set(issues.map((issue) => issue.id))
  const keptEdges = edges
    .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
    .map((edge) => ({ from: edge.from, to: edge.to, name: edge.name, directed: edge.directed !== false }))

  let focus = typeof input?.focus === 'string' && ids.has(input.focus) ? input.focus : null
  if (focus === null) {
    let newest = null
    for (const issue of issues) {
      const date = issue.last?.date
      if (typeof date !== 'string' || date === '') continue
      if (newest === null || date > newest.date) newest = { date, issue }
    }
    focus = newest?.issue.id ?? issues[0]?.id ?? null
  }

  return {
    repo,
    generatedAt: new Date().toISOString(),
    ok: true,
    focus,
    issues,
    edges: keptEdges,
    total: nodes.length,
    truncated: nodes.length > kept.length,
  }
}

/** 找个可用的 kiln：解析不到时清缓存重试一次（用户刚装好 kiln，不必重启宿主）。 */
function ensureKiln() {
  const first = resolveKiln()
  if (first !== null) return first
  forgetKiln()
  return resolveKiln()
}

/** 仓库形状校验：返回原因字符串，合格返回 null。 */
function validateRepo(dir) {
  if (dir === '' || !isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) return 'invalid-dir'
  if (!existsSync(join(dir, '.kilnconfig.jsonc'))) return 'not-kiln-repo'
  return null
}

/**
 * 取关系图（节点 + 折叠边）。
 * 与 `readHistories` 拆开，是为了让快照缓存能“只重取受影响的 issue”而不重跑 graph 之外的东西。
 */
export async function readGraph(repo) {
  const dir = typeof repo === 'string' ? repo : ''
  const invalid = validateRepo(dir)
  if (invalid !== null) return { ok: false, reason: invalid }
  const bin = ensureKiln()
  if (bin === null) return { ok: false, reason: 'kiln-missing' }
  try {
    const graph = JSON.parse(await runKiln(bin, ['graph', '--json'], dir))
    return { ok: true, graph }
  } catch (error) {
    return { ok: false, reason: 'kiln-error', message: String(error?.message ?? error) }
  }
}

/**
 * 搜索文档的形状校验：rank 与 hit.total/date 是 kiln v0.2.1+ 才有的字段。
 * 返回错误文案，合格返回 null。
 *
 * 不解析版本串：旧版二进制会静默给出没有 rank 的行，按形状拒绝比按版本猜更直接。
 */
export function searchDocumentError(document) {
  const rows = Array.isArray(document?.issues) ? document.issues : null
  if (rows === null) return 'kiln list --search 输出缺少 issues 数组'
  for (const row of rows) {
    if (!Number.isInteger(row?.rank)) {
      return '需要 kiln v0.2.1+：list --search 的行缺少 rank'
    }
    if (row.hit !== null && row.hit !== undefined) {
      if (!Number.isInteger(row.hit.total)) return '需要 kiln v0.2.1+：hit 缺少 total'
      if (typeof row.hit.date !== 'string' || row.hit.date === '') {
        return '需要 kiln v0.2.1+：hit 缺少 date'
      }
    }
  }
  return null
}

/**
 * 一次整仓搜索：`kiln list --search <q> --json`。
 *
 * 搜索结果不缓存：查询串是动态的，缓存只会带来“同一个 q 读到旧结果”的歧义；
 * 每次一个进程，宿主路由按输入防抖后调用。
 */
export async function readSearch(repo, query) {
  const dir = typeof repo === 'string' ? repo : ''
  const text = String(query ?? '').trim()
  if (text === '') return { ok: false, reason: 'empty-query' }
  const invalid = validateRepo(dir)
  if (invalid !== null) return { ok: false, reason: invalid }
  const bin = ensureKiln()
  if (bin === null) return { ok: false, reason: 'kiln-missing' }
  try {
    const document = JSON.parse(await runKiln(bin, ['list', `--search=${text}`, '--json'], dir))
    const shapeError = searchDocumentError(document)
    if (shapeError !== null) return { ok: false, reason: 'kiln-too-old', message: shapeError }
    return { ok: true, query: text, document }
  } catch (error) {
    return { ok: false, reason: 'kiln-error', message: String(error?.message ?? error) }
  }
}

/**
 * 取若干 issue 的动作序列：只起 **1 个** `kiln path` 进程（v0.2.0 批量，一次读全）。
 *
 * 只支持 kiln v0.2.0+：多 id 请求却拿到单条文档时抛 KilnError（v0.1.1 会静默只回第一条，
 * 按单条解析会丢数据）。批量里个别 issue 取不到时上游走 `errors`，这里保持空序列，
 * 不拖垮整份快照。
 */
export async function readHistories(repo, ids) {
  const dir = typeof repo === 'string' ? repo : ''
  const histories = new Map()
  if (!Array.isArray(ids) || ids.length === 0) return histories
  const unique = [...new Set(ids)]
  for (const id of unique) histories.set(id, [])
  const bin = ensureKiln()
  if (bin === null) return histories

  // 部分 issue 取不到时 kiln 仍输出完整文档（exit 1），所以不要求退出码为 0。
  const result = await execKiln(bin, ['path', ...unique, '--json'], dir)
  if (result.code !== 0 && result.code !== 1) throw new KilnError(reasonOf(result))
  let document
  try {
    document = JSON.parse(result.stdout)
  } catch {
    throw new KilnError(result.stderr !== '' ? reasonOf(result) : 'kiln path 输出不是 JSON')
  }
  const parsed = parsePathDocument(document)
  const shapeError = pathShapeError(parsed, unique.length)
  if (shapeError !== null) throw new KilnError(shapeError)
  for (const [id, actions] of parsed.histories) {
    if (histories.has(id)) histories.set(id, actions)
  }
  return histories
}

/**
 * 读取一个仓库的 Flow 快照（**不带缓存**；缓存与失效在 snapshot.js）。
 *
 * @param repo - 绝对路径，必须是 kiln 仓库根。
 * @param options - focus（可选 issue id）与 maxIssues（默认 80）。
 * @returns 永远 resolve：失败时带 ok:false 与 reason，前端据此显示降级提示。
 */
export async function readFlow(repo, options = {}) {
  const dir = typeof repo === 'string' ? repo : ''
  const base = { repo: dir, generatedAt: new Date().toISOString() }
  const graphResult = await readGraph(dir)
  if (graphResult.ok !== true) {
    return {
      ...base,
      ok: false,
      reason: graphResult.reason,
      ...(graphResult.message === undefined ? {} : { message: graphResult.message }),
    }
  }
  const nodes = Array.isArray(graphResult.graph?.nodes) ? graphResult.graph.nodes : []
  const maxIssues =
    Number.isInteger(options.maxIssues) && options.maxIssues > 0 ? options.maxIssues : DEFAULT_MAX_ISSUES
  const kept = nodes.slice(0, maxIssues)
  let histories
  try {
    histories = await readHistories(
      dir,
      kept.map((node) => node.id),
    )
  } catch (error) {
    return { ...base, ok: false, reason: 'kiln-error', message: String(error?.message ?? error) }
  }
  return buildFlow({ repo: dir, graph: graphResult.graph, histories, focus: options.focus, maxIssues })
}
