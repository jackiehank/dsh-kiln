/**
 * 时间线数据层：把 `kiln action log --jsonl` 读成动作行。
 *
 * 上游契约（kiln v0.3.0，`docs/action-log.md` 第六轮 / 提交 8f942fc）：
 * - 一行一个 JSON 对象，只收同时带 `issue:` + `action:` 的提交；
 * - `issue` / `action` / `commit` / `date` 恒有；`title` / `domain` / `tags` 缺省即没有（键省略）；
 * - `commit` 是全长 40 位；`date` 是 RFC3339，保留提交自己的 offset；
 * - 没有终止记录（EOF 即结束）、没有增量游标；`--json` 会被拒绝；
 * - 退出码 0 = 正常（含空结果、`--limit` 用尽、Windows 上消费者提前关管道）。
 *
 * 因此这里只做三件事：按行切、逐条映射、把失败说人话。不做版本号猜测——
 * 旧版没有这个子命令，stderr 会直说，按「需要 v0.3.0+」透出即可。
 */
import { spawn } from 'node:child_process'

import { truncateTitle } from './flow.js'

/** 时间线需要的 kiln 下限：`action log --jsonl` 从这一版开始。 */
export const TIMELINE_MIN_VERSION = '0.3.0'

/**
 * 按行切 chunk：网络/管道都不保证按行到，半行留到下一块。
 * 空行（含只有 `\r` 的）返回空串，由调用方跳过。
 */
export function createLineSplitter() {
  let rest = ''
  return {
    push(chunk) {
      rest += String(chunk ?? '')
      const lines = rest.split(/\r?\n/)
      rest = lines.pop() ?? ''
      return lines
    },
    flush() {
      const line = rest
      rest = ''
      return line === '' ? [] : [line]
    },
  }
}

/**
 * `action log --jsonl` 的一条记录 → 视图的行。
 * 缺 `issue` / `action` / `commit` 的算坏行（返回 null）；其余字段缺失就是空，不补默认值。
 */
export function mapActionRecord(record) {
  if (record === null || typeof record !== 'object') return null
  const issueId = typeof record.issue === 'string' ? record.issue : ''
  const action = typeof record.action === 'string' ? record.action : ''
  const commit = typeof record.commit === 'string' ? record.commit : ''
  if (issueId === '' || action === '' || commit === '') return null
  return {
    issueId,
    action,
    /** 完整 sha：行 key、搜索跳转与「跳回提交」都用它。 */
    id: commit,
    short: commit.slice(0, 7),
    date: typeof record.date === 'string' ? record.date : '',
    title: truncateTitle(record.title),
    /** 动作级分类（这一条提交声明的），不是 issue 级；筛选目前仍按 issue 的领域。 */
    domain: typeof record.domain === 'string' ? record.domain : '',
    tags: Array.isArray(record.tags) ? record.tags.map((tag) => String(tag)) : [],
  }
}

/** 把退出码 + stderr 折成一句人话；正常（0）返回 null。 */
export function actionLogProblem(code, stderr) {
  if (code === 0) return null
  const first = String(stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '')
  const text = first ?? ''
  // v0.2.x 没有 action 子命令；新版参数写错（exit 2）也会走到这里，但同样给出方向。
  if (/action|未知子命令|unknown command|unknown subcommand|不支持/i.test(text)) {
    return `需要 kiln v${TIMELINE_MIN_VERSION}+：时间线走 action log --jsonl（当前 kiln 不支持这个命令）`
  }
  return text === '' ? `kiln 退出码 ${code}` : text
}

/**
 * 读一个已经 spawn 的子进程，按行回调。
 *
 * `onDone` 只调一次：EOF（EOF 就是终点，上游没有 summary 行）或 spawn 失败都收口到这里。
 * `failed` 表示中途出现过坏行/解析失败——调用方据此决定是提示还是整条失败。
 */
export function consumeActionLog(child, handlers = {}) {
  const splitter = createLineSplitter()
  let stderr = ''
  let count = 0
  let failed = false
  let finished = false

  const finish = (code) => {
    if (finished) return
    finished = true
    for (const line of splitter.flush()) emit(line)
    handlers.onDone?.({ code, stderr: stderr.trim(), count, failed })
  }

  const emit = (line) => {
    const text = String(line ?? '').trim()
    if (text === '') return
    let record
    try {
      record = JSON.parse(text)
    } catch {
      failed = true
      handlers.onError?.(`action log 的输出不是 JSON：${text.slice(0, 120)}`)
      return
    }
    const row = mapActionRecord(record)
    if (row === null) {
      failed = true
      handlers.onError?.(`action log 的行缺少 issue/action/commit：${text.slice(0, 120)}`)
      return
    }
    count += 1
    handlers.onRecord?.(row)
  }

  child.stdout.setEncoding?.('utf8')
  child.stdout.on('data', (chunk) => {
    for (const line of splitter.push(chunk)) emit(line)
  })
  child.stderr.setEncoding?.('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk ?? '')
  })
  child.on('error', (error) => {
    // 没跑起来（ENOENT / EACCES）：没有 stdout 可读，直接收口。
    handlers.onError?.(String(error?.message ?? error))
    finish(-1)
  })
  child.on('close', (code) => {
    finish(typeof code === 'number' ? code : -1)
  })
}

/** `action log` 的参数：`limit > 0` 时只取最近 N 条（N 数的是动作，不是提交）。 */
export function actionLogArgs(limit = 0) {
  const args = ['action', 'log', '--jsonl']
  const count = Number.isInteger(limit) && limit > 0 ? limit : 0
  if (count > 0) args.push('--limit', String(count))
  return args
}

/** 起 `kiln action log --jsonl`。 */
export function spawnActionLog(bin, repo, limit = 0) {
  return spawn(bin, actionLogArgs(limit), { cwd: repo, windowsHide: true })
}
