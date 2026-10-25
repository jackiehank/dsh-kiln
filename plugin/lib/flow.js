/**
 * Flow 数据层：把一个 kiln 仓库读成一份只读快照。
 *
 * 这里只做两件事——调 `kiln graph --json` 取 issue 与折叠后的关系边，调
 * `kiln path <id> --json` 取每条 issue 的动作序列。语义（关系强弱、层级、
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
const PATH_CONCURRENCY = 4
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

async function runKiln(bin, args, cwd) {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      cwd,
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    })
    return stdout
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const reason = stderr !== '' ? stderr.split(/\r?\n/)[0] : String(error?.message ?? error)
    throw new KilnError(reason)
  }
}

/** 目录是不是一个 kiln 仓库：只有 .kilnconfig.jsonc 是登记在仓库里的判据。 */
export function isKilnRepo(dir) {
  try {
    return isAbsolute(dir) && statSync(dir).isDirectory() && existsSync(join(dir, '.kilnconfig.jsonc'))
  } catch {
    return false
  }
}

async function mapLimit(tasks, limit) {
  const out = new Array(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++
      out[index] = await tasks[index]()
    }
  })
  await Promise.all(workers)
  return out
}

/** `kiln path --json` 的 actions → 视图需要的字段（保留完整 sha 与短哈希）。 */
export function mapActions(document) {
  const actions = Array.isArray(document?.actions) ? document.actions : []
  return actions.map((action) => {
    const sha = typeof action.id === 'string' ? action.id : ''
    return {
      ordinal: action.ordinal,
      action: action.action,
      /** 完整提交 sha：缓存增量失效与 timeline 的“跳回提交”都要它。 */
      id: sha,
      /** 展示用的短哈希（7 位）；空提交没有 id，保持空串而不是猜。 */
      short: sha.slice(0, 7),
      date: action.date,
      title: truncate(action.title),
    }
  })
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

/** 取若干 issue 的动作序列；单条失败当空序列处理，不拖垮整份快照。 */
export async function readHistories(repo, ids) {
  const dir = typeof repo === 'string' ? repo : ''
  const histories = new Map()
  if (!Array.isArray(ids) || ids.length === 0) return histories
  const bin = ensureKiln()
  if (bin === null) return histories
  await mapLimit(
    ids.map((id) => async () => {
      try {
        const document = JSON.parse(await runKiln(bin, ['path', id, '--json'], dir))
        histories.set(id, mapActions(document))
      } catch {
        histories.set(id, [])
      }
    }),
    PATH_CONCURRENCY,
  )
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
  const histories = await readHistories(
    dir,
    kept.map((node) => node.id),
  )
  return buildFlow({ repo: dir, graph: graphResult.graph, histories, focus: options.focus, maxIssues })
}
