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
 * 动作行的形状：**7 槽数组**，宿主缓存、线上 NDJSON、客户端缓存、折叠输入全同形。
 *
 * 为什么不是对象（测量见 `docs/issues/kiln-cache-budget.md`）：
 * - 线上省掉键名与 `short` 派生字段，10 万行 32MB → 23.6MB（−26%）；
 * - 宿主存的数组就是发出去的字节，客户端 parse 出来的就是要存的行，两端都不再“建对象”；
 * - 代价：数组比同槽对象多约 24B/行；纯省内存该用对象（B2）或列式（F）。
 *
 * 形状一变，两端所有字段访问都要跟——所以下标只从这里取，不写字面量。
 */
export const ROW = Object.freeze({
  ISSUE: 0,
  ACTION: 1,
  COMMIT: 2,
  DATE: 3,
  TITLE: 4,
  DOMAIN: 5,
  TAGS: 6,
})
export const ROW_WIDTH = 7
/** 标签的连接符：kiln 的标签是 kebab 词，不含控制字符。 */
export const TAGS_SEPARATOR = '\u0001'

/** 行的短 sha：只对可见行调用，不存（省 7 字符 × 每行）。 */
export function rowShort(row) {
  return String(row?.[ROW.COMMIT] ?? '').slice(0, 7)
}

/** 行的标签：驱动里存连接串，读出时才切。 */
export function rowTags(row) {
  const tags = row?.[ROW.TAGS]
  return typeof tags === 'string' && tags !== '' ? tags.split(TAGS_SEPARATOR) : []
}

/**
 * 驻留池：issueId / action / domain 在整条流里高度重复，共享成同一批字符串。
 * 实测 10 万行省约 108B/行；池的键数 = 唯一值数（issue 数 + 动作名数 + 领域数），有界。
 */
export function createRowInterner(sharedPool) {
  const pool = sharedPool instanceof Map ? sharedPool : new Map()
  const intern = (value) => {
    if (typeof value !== 'string' || value === '') return value ?? ''
    const hit = pool.get(value)
    if (hit !== undefined) return hit
    pool.set(value, value)
    return value
  }
  return {
    pool,
    /** 原地把三个重复字段换成池里的那一份。 */
    intern(row) {
      if (!Array.isArray(row)) return row
      row[ROW.ISSUE] = intern(row[ROW.ISSUE])
      row[ROW.ACTION] = intern(row[ROW.ACTION])
      row[ROW.DOMAIN] = intern(row[ROW.DOMAIN])
      return row
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
  const tags = Array.isArray(record.tags) ? record.tags.map((tag) => String(tag)) : []
  return [
    issueId,
    action,
    /** 完整 sha：行 key、搜索跳转与「跳回提交」都用它；短 sha 由 `rowShort` 现切。 */
    commit,
    typeof record.date === 'string' ? record.date : '',
    truncateTitle(record.title),
    /** 动作级分类（这一条提交声明的），不是 issue 级；筛选目前仍按 issue 的领域。 */
    typeof record.domain === 'string' ? record.domain : '',
    tags.length === 0 ? null : tags.join(TAGS_SEPARATOR),
  ]
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
