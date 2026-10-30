/**
 * Git 探测层：只回答两件事——HEAD 是哪个提交、新提交碰了哪些 issue。
 *
 * 这里**不解析 kiln 的状态语义**：git 的结论只用于决定“重取谁”，
 * 视图数据仍然只来自 `kiln <cmd> --json`。判定不了就返回不可用，让调用方保守全量重建。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const RUN_TIMEOUT_MS = 5_000
const MAX_BUFFER = 1 << 20

/** sha1（40）或 sha256（64）仓库都能匹配。 */
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i

export class GitError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GitError'
  }
}

/** 跑一条 git 命令；非零退出以 code 返回而不抛——merge-base 正是用退出码表达的。 */
async function run(repo, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repo,
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    })
    return { code: 0, stdout }
  } catch (error) {
    if (typeof error?.code === 'number') {
      return { code: error.code, stdout: typeof error.stdout === 'string' ? error.stdout : '' }
    }
    throw new GitError(String(error?.message ?? error))
  }
}

/** 解析 git 目录：普通仓库是目录；worktree / submodule 时 `.git` 是含 `gitdir: …` 的文件。 */
export function gitDirOf(repo) {
  const dotGit = join(repo, '.git')
  let stat
  try {
    stat = statSync(dotGit)
  } catch {
    return null
  }
  if (stat.isDirectory()) return dotGit
  if (!stat.isFile()) return null
  let text
  try {
    text = readFileSync(dotGit, 'utf8')
  } catch {
    return null
  }
  const match = /^gitdir:\s*(.+)$/m.exec(text)
  if (match === null) return null
  const target = resolve(repo, match[1].trim())
  return existsSync(target) ? target : null
}

/**
 * 直读 HEAD：`HEAD` → ref 文件。实测 ~2ms，是 `git rev-parse` 的 1/30。
 * packed-refs（gc 之后）或分支文件缺失时返回 null，由调用方回退到 git。
 */
export function readHeadFast(repo) {
  const dir = gitDirOf(repo)
  if (dir === null) return null
  let head
  try {
    head = readFileSync(join(dir, 'HEAD'), 'utf8').trim()
  } catch {
    return null
  }
  const ref = /^ref:\s*(.+)$/.exec(head)
  if (ref === null) return HASH.test(head) ? head : null
  try {
    const value = readFileSync(join(dir, ref[1].trim()), 'utf8').trim()
    return HASH.test(value) ? value : null
  } catch {
    return null
  }
}

/** 读 HEAD：先直读，再 `git rev-parse`；都失败返回 null（调用方退化为不缓存）。 */
export async function readHead(repo) {
  const fast = readHeadFast(repo)
  if (fast !== null) return fast
  const result = await run(repo, ['rev-parse', 'HEAD'])
  const value = result.stdout.trim()
  return result.code === 0 && HASH.test(value) ? value : null
}

/** 配置令牌：动作词表改了就换，**包括未提交的改动**（它们不进 HEAD）。 */
export function configToken(repo) {
  try {
    const stat = statSync(join(repo, '.kilnconfig.jsonc'))
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

/** 二进制令牌：kiln 换了版本或路径，解析语义可能变。 */
export function binaryToken(bin) {
  if (typeof bin !== 'string' || bin === '') return 'missing'
  try {
    const stat = statSync(bin)
    return `${bin}:${stat.mtimeMs}:${stat.size}`
  } catch {
    return `${bin}:unknown`
  }
}
