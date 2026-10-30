/**
 * `/kiln/timeline` 的实现体：命中就内存重发，没命中就流式读并顺手把行存起来。
 *
 * 五条路（`x-kiln-mode` 头会写出来，排障时一眼能看出走的哪条）：
 * - `unchanged`：客户端带 `?head=` 且与当前 HEAD 相同 —— 空 body，一个字节都不发（阶段 2）；
 * - `hit`：宿主手里有这份 HEAD 的行，零子进程，把行按同样的 NDJSON 重发；
 * - `incremental`：HEAD 前进且**前缀可以安全读**（前置条件见 `rowsCache.planIncrement`），
 *   只读新前缀、拼在缓存前面（阶段 3）；
 * - `delta`：增量时客户端持有的 HEAD 正好是缓存里那一份 → 只发新增的行，客户端自己 prepend；
 * - `build` / `bypass`：整条重读（bypass = 关掉了 / 读不到 HEAD / 仓库太大），与无缓存时一致。
 *
 * 可靠性优先：增量一旦读不成（没撞到 boundary、区间过大、子进程出错），**一律回退全量**。
 * 多读一次可以接受，少一行不行。
 *
 * 抽成独立模块只为一个理由：能用一个假 res 直接测命中、超限与收口，不用起 HTTP。
 */
import { once } from 'node:events'

export function createTimelineHandler(deps) {
  const {
    resolveKiln,
    repoProblem,
    spawnActionLog,
    consumeActionLog,
    actionLogProblem,
    cache,
    enabled = () => true,
  } = deps

  return async function handleTimeline(cwd, res, options = {}) {
    res.statusCode = 200
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('cache-control', 'no-store')

    const startedAt = Date.now()
    let closed = false
    res.on('close', () => {
      closed = true
    })

    const write = (event) => {
      if (res.writableEnded === true) return false
      return res.write(`${JSON.stringify(event)}\n`)
    }
    const finishDone = (count, cacheState, exit = 0) => {
      write({ kind: 'done', exit, count, ms: Date.now() - startedAt, cache: cacheState })
      if (res.writableEnded !== true) res.end()
    }
    const close = (reason, message) => {
      write({ kind: 'error', reason, ...(message === undefined ? {} : { message }) })
      write({ kind: 'done', exit: 0, count: 0, cache: 'skip' })
      if (res.writableEnded !== true) res.end()
    }
    const waitDrain = () => Promise.race([once(res, 'drain'), once(res, 'close')])
    /** 逐行写；返回 false 表示连接没了，别再写了。 */
    const writeRow = async (row) => {
      if (closed || res.writableEnded === true) return false
      if (write({ kind: 'action', ...row }) === false) await waitDrain()
      return !closed && res.writableEnded !== true
    }
    const replay = async (rows) => {
      for (const row of rows) if (!(await writeRow(row))) return false
      return true
    }
    const killOnClose = (child) => {
      const onClose = () => child.kill()
      res.on('close', onClose)
      return () => res.off('close', onClose)
    }

    const bin = resolveKiln()
    if (bin === null) {
      close('kiln-missing', '宿主进程里找不到 kiln 可执行文件。把 kiln 放进 PATH，或设置 DSH_KILN_BIN。')
      return
    }
    const invalid = repoProblem(cwd)
    if (invalid !== null) {
      close(invalid)
      return
    }

    // 带 limit 的请求不回缓存：缓存是全量，缩水的结果不能顶替它
    const cacheEnabled = options.noCache === true ? false : enabled() !== false
    const decision = await cache.decide(cwd, bin, { enabled: cacheEnabled, fresh: options.fresh === true })
    res.setHeader('x-kiln-mode', decision.mode)
    if (typeof decision.head === 'string' && decision.head !== '') res.setHeader('x-kiln-head', decision.head)

    /**
     * 阶段 2：客户端已经持有这个 HEAD 的行，就一个字节都不用发。
     * 只在“HEAD 相同且没有换解析口径”时成立：配置/二进制一变，客户端那份的语义可能不同。
     */
    const clientHead = typeof options.head === 'string' ? options.head : ''
    const reusable =
      clientHead !== '' &&
      decision.head === clientHead &&
      decision.reason !== 'fresh' &&
      decision.reason !== 'config-changed' &&
      decision.reason !== 'binary-changed'
    if (reusable) {
      res.setHeader('x-kiln-mode', 'unchanged')
      finishDone(0, 'unchanged')
      return
    }

    if (decision.mode === 'hit') {
      const rows = cache.rows(cwd) ?? []
      if (!(await replay(rows))) return
      finishDone(rows.length, 'hit')
      return
    }

    if (decision.mode === 'build' && !closed) {
      const plan = await cache.planIncrement(cwd, decision)
      if (plan.mode === 'incremental') {
        const handled = await runIncremental(plan, decision)
        if (handled === true) return
        if (closed) return
      }
    }

    await runFull(decision)

    // ------------------------------------------------------------ 三条实现路径

    /**
     * 阶段 3：只读新前缀，撞到 boundary 就停，把结果拼在缓存前面。
     *
     * 返回 true = 已经响应（成功或放弃）；false = 需要回退全量。
     * 关键点：新行先攒在内存里，**撞到 boundary 之后才写响应**——否则一旦回退，
     * 客户端已经收到半截“新行”，没法撤。
     */
    async function runIncremental(plan, decided) {
      const entry = cache.peek(cwd)
      if (entry === null || entry === undefined || !Array.isArray(entry.rows) || entry.rows.length === 0) {
        return false
      }
      // 客户端手上正好是缓存里的那份 HEAD：只需要发新增行
      const deltaForClient = clientHead !== '' && clientHead === entry.head
      const buffered = []
      let settled = false
      let failure = null

      const child = spawnActionLog(bin, cwd, 0)
      const release = killOnClose(child)
      const finished = await new Promise((resolve) => {
        consumeActionLog(child, {
          onRecord: (row) => {
            if (closed || settled) return
            if (row.id === plan.boundary) {
              // 撞到缓存的首行：后面的全都已经在了
              settled = true
              child.kill()
              resolve(true)
              return
            }
            buffered.push(row)
            if (buffered.length > cache.limits().rows) {
              settled = true
              child.kill()
              resolve(false)
            }
          },
          onError: (message) => {
            failure = message
          },
          onDone: () => {
            if (settled) return
            settled = true
            resolve(false)
          },
        })
      })
      release()
      if (finished !== true || closed) return false
      if (failure !== null) return false

      // 读前缀这几十毫秒里又有人提交：新提交可能带着旧日期落在 boundary 之后，
      // 判定已经过期——不猜，退回全量。
      const current = await cache.headNow(cwd)
      if (current !== null && current !== decided.head) return false

      const rows = buffered.concat(entry.rows)
      let bytes = entry.bytes
      for (const row of buffered) bytes += Buffer.byteLength(JSON.stringify({ kind: 'action', ...row })) + 1
      if (rows.length > cache.limits().rows || bytes > cache.limits().bytes) {
        // 拼起来超限：不存了，回退全量（全量路径会把它记成 oversize）
        return false
      }
      cache.commit(cwd, {
        head: decided.head,
        configToken: decided.configToken,
        binToken: decided.binToken,
        rows,
        bytes,
      })

      const payload = deltaForClient ? buffered : rows
      res.setHeader('x-kiln-mode', deltaForClient ? 'delta' : 'incremental')
      if (!(await replay(payload))) return true
      finishDone(payload.length, deltaForClient ? 'delta' : 'incremental')
      return true
    }

    /** 整条重读。带 limit 的请求也走这里（不写缓存）。 */
    async function runFull(decided) {
      const limits = cache.limits()
      const collected = decided.mode === 'build' ? [] : null
      let bytes = 0
      let overflowed = false
      let settled = false

      const child = spawnActionLog(bin, cwd, 0)
      const release = killOnClose(child)
      await new Promise((resolve) => {
        consumeActionLog(child, {
          onRecord: (row) => {
            if (closed || settled) return resolve()
            const text = `${JSON.stringify({ kind: 'action', ...row })}\n`
            if (collected !== null && overflowed === false) {
              collected.push(row)
              bytes += text.length
              // 一超限就撒手：继续攒只会白占内存，缓存也注定存不下
              if (collected.length > limits.rows || bytes > limits.bytes) {
                overflowed = true
                collected.length = 0
              }
            }
            if (res.write(text) === false) {
              child.stdout.pause()
              res.once('drain', () => child.stdout.resume())
            }
          },
          onError: (message) => {
            if (closed) return
            write({ kind: 'error', reason: 'kiln-error', message })
          },
          onDone: ({ code, stderr, count }) => {
            if (settled) return
            settled = true
            resolve()
            release()
            if (closed || res.writableEnded === true) return
            const problem = actionLogProblem(code, stderr)
            if (problem !== null) write({ kind: 'error', reason: 'kiln-error', message: problem })
            let cacheState = 'skip'
            if (collected !== null && problem === null && code === 0 && overflowed === false) {
              const stored = cache.commit(cwd, {
                head: decided.head,
                configToken: decided.configToken,
                binToken: decided.binToken,
                rows: collected,
                bytes,
              })
              cacheState = stored.stored === true ? 'stored' : stored.reason
            } else if (overflowed === true) {
              // 攒到一半才发现超限：不写，并记住这个仓——下次直接 bypass
              cache.markOversize(cwd, decided.binToken)
              cacheState = 'oversize'
            }
            finishDone(count, cacheState, code)
          },
        })
      })
    }
  }
}
