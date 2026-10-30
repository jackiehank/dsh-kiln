/**
 * 数据层：宿主只通过 `kiln <cmd> --json` 取数，一个视图一条命令。
 *
 * - 关系图：`kiln graph --json`（节点 + 折叠后的边），只在打开关系页时取；
 * - 详情：`kiln path <id> --json`（动作序列 + 这个 issue 的全部边），点开才取；
 * - 搜索 / 词表：`list --search` / `action list`。
 *
 * 关系强弱、层级、方向这些语义留给定词表的前端；这里不判断“什么算重要”，
 * 也不复刻 kiln 的折叠规则（流里的 `relations` 是声明，不是边）。
 */
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const RUN_TIMEOUT_MS = 20_000
const MAX_BUFFER = 8 * 1024 * 1024
const MAX_TITLE = 200

/** 一次 kiln 调用失败时携带可读原因，方便路由层原样透出。 */
export class KilnError extends Error {
  constructor(message) {
    super(message)
    this.name = 'KilnError'
  }
}

export const truncateTitle = (text) =>
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
 * 跑一次 kiln，**不因退出码非零就丢掉 stdout**：`path` 在 issue 不存在时仍可能
 * 给出部分文档，调用方要自己判断能不能解析。
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

/**
 * `kiln path --json` 的 actions → 视图需要的字段（保留完整 sha 与短哈希）。
 *
 * 哈希键是 `commit`（`id` 只指 issue）；没有提交时给空串，不猜旧键。
 */
export function mapActions(document) {
  const actions = Array.isArray(document?.actions) ? document.actions : []
  return actions.map((action) => {
    const sha = typeof action.commit === 'string' ? action.commit : ''
    return {
      ordinal: action.ordinal,
      action: action.action,
      /** 完整提交 sha：timeline 的“跳回提交”与详情都靠它。 */
      id: sha,
      /** 展示用的短哈希（7 位）；空提交没有 id，保持空串而不是猜。 */
      short: sha.slice(0, 7),
      date: action.date,
      title: truncateTitle(action.title),
      /** 该动作声明的 refs：详情展开时显示，空就是空，不补默认值。 */
      refs: Array.isArray(action.refs) ? action.refs.map((ref) => String(ref)) : [],
    }
  })
}

/** 边统一成客户端认识的形状（缺 directed 时按有向处理）。 */
function mapEdges(edges) {
  return (Array.isArray(edges) ? edges : []).map((edge) => ({
    from: edge.from,
    to: edge.to,
    name: edge.name,
    directed: edge.directed !== false,
  }))
}

/**
 * 纯变换：`kiln graph --json` → 关系页的节点与边。
 *
 * 不再截断（80 条上限随批量 path 一起删掉）；节点只有结构字段，动作在详情里。
 */
export function buildGraph(input) {
  const repo = String(input?.repo ?? '')
  const graph = input?.graph ?? {}
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph.edges) ? graph.edges : []
  return {
    repo,
    generatedAt: new Date().toISOString(),
    ok: true,
    issues: nodes.map((node) => ({
      id: node.id,
      domain: node.domain ?? '',
      action: node.action ?? '',
      done: node.done === true,
      title: truncateTitle(node.title),
      tags: Array.isArray(node.tags) ? node.tags : [],
    })),
    edges: mapEdges(edges),
  }
}

/**
 * 纯变换：`kiln path <id> --json` → 详情。
 *
 * 单条文档是裸 pathDoc（`issue` / `action` / `done` / `actions` / `relations`）。
 * 形状不认识、或回来的不是请求的那个 id，都明确报错，不静默换人。
 */
export function parseIssueDocument(document, requestedId) {
  if (typeof document?.issue !== 'string' || !Array.isArray(document?.actions)) {
    return { ok: false, reason: 'shape', message: 'kiln path 输出不是单个 issue 的文档' }
  }
  if (typeof requestedId === 'string' && document.issue !== requestedId) {
    return {
      ok: false,
      reason: 'mismatch',
      message: `kiln path 返回了 ${document.issue}，不是 ${requestedId}`,
    }
  }
  return {
    ok: true,
    issue: {
      id: document.issue,
      done: document.done === true,
      actions: mapActions(document),
      relations: mapEdges(document.relations),
    },
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
export function repoProblem(dir) {
  if (dir === '' || !isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) return 'invalid-dir'
  if (!existsSync(join(dir, '.kilnconfig.jsonc'))) return 'not-kiln-repo'
  return null
}

/** 取关系图（节点 + 折叠边）。关系页唯一的数据来源。 */
export async function readGraph(repo) {
  const dir = typeof repo === 'string' ? repo : ''
  const invalid = repoProblem(dir)
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
 * 取一个 issue 的详情：只起 **1 个** `kiln path` 进程（单条形态，v0.2.0 起稳定）。
 *
 * 返回的 `relations` 是折叠后的边（进+出），聚焦页的分组与时间线收窄都用它，
 * 不需要再取 graph。
 */
export async function readIssue(repo, id) {
  const dir = typeof repo === 'string' ? repo : ''
  const issueId = typeof id === 'string' ? id.trim() : ''
  if (issueId === '') return { ok: false, reason: 'missing-id' }
  const invalid = repoProblem(dir)
  if (invalid !== null) return { ok: false, reason: invalid }
  const bin = ensureKiln()
  if (bin === null) return { ok: false, reason: 'kiln-missing' }
  try {
    const document = JSON.parse(await runKiln(bin, ['path', issueId, '--json'], dir))
    const parsed = parseIssueDocument(document, issueId)
    if (parsed.ok !== true) {
      return { ok: false, reason: 'kiln-error', message: parsed.message }
    }
    return { ok: true, issue: parsed.issue }
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
  const invalid = repoProblem(dir)
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
 * 动作词表：`kiln action list --json`（不读历史、只读配置）。
 *
 * 客户端把 action 流折叠成 issue 索引时，要用它做两个判断：
 * - `done`：最近动作 ∈ `terminal`；
 * - “这条 issue 读完了”：看到 `start`（本仓是 `ask`，但词表是每个项目的自定义点，不硬编码）。
 */
export async function readActions(repo) {
  const dir = typeof repo === 'string' ? repo : ''
  const invalid = repoProblem(dir)
  if (invalid !== null) return { ok: false, reason: invalid }
  const bin = ensureKiln()
  if (bin === null) return { ok: false, reason: 'kiln-missing' }
  try {
    const doc = JSON.parse(await runKiln(bin, ['action', 'list', '--json'], dir))
    const actions = doc?.actions ?? {}
    if (
      !Array.isArray(actions.names) ||
      typeof actions.start !== 'string' ||
      actions.start === '' ||
      !Array.isArray(actions.terminal)
    ) {
      return {
        ok: false,
        reason: 'kiln-too-old',
        message: '需要 kiln v0.3.0+：action list --json 缺少 names/start/terminal',
      }
    }
    return { ok: true, actions }
  } catch (error) {
    return { ok: false, reason: 'kiln-error', message: String(error?.message ?? error) }
  }
}
