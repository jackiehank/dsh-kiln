/**
 * `/kiln/timeline` 的实现体：命中就内存重发，没命中就流式读并顺手把行存起来。
 *
 * 三条路（`x-kiln-mode` 头会写出来，排障时一眼能看出走的哪条）：
 * - `hit`：HEAD/配置/二进制都没变，零子进程，把缓存的行按同样的 NDJSON 发一遍；
 * - `build`：要读一遍，读完整了才写缓存（半截数据会让折叠算错 done）；
 * - `bypass`：关掉了 / 读不到 HEAD / 仓库太大，行为与没有缓存时完全一致。
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
    const write = (event) => {
      if (res.writableEnded === true) return false
      return res.write(`${JSON.stringify(event)}\n`)
    }
    const close = (reason, message) => {
      write({ kind: 'error', reason, ...(message === undefined ? {} : { message }) })
      write({ kind: 'done', exit: 0, count: 0, cache: 'skip' })
      if (res.writableEnded !== true) res.end()
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

    if (decision.mode === 'hit') {
      const rows = cache.rows(cwd) ?? []
      let closed = false
      res.on('close', () => {
        closed = true
      })
      for (const row of rows) {
        if (closed === true || res.writableEnded === true) return
        if (write({ kind: 'action', ...row }) === false) {
          // 命中时的背压：没有子进程可暂停，只能等 drain（或连接提前关掉）
          await Promise.race([once(res, 'drain'), once(res, 'close')])
        }
      }
      write({ kind: 'done', exit: 0, count: rows.length, ms: Date.now() - startedAt, cache: 'hit' })
      if (res.writableEnded !== true) res.end()
      return
    }

    const limits = cache.limits()
    /** build 才攒行；bypass 不攒，连内存也不占。 */
    const collected = decision.mode === 'build' ? [] : null
    let bytes = 0
    let overflowed = false
    let closed = false

    const child = spawnActionLog(bin, cwd, 0)
    res.on('close', () => {
      closed = true
      child.kill()
    })

    consumeActionLog(child, {
      onRecord: (row) => {
        if (closed) return
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
        if (closed || res.writableEnded === true) return
        const problem = actionLogProblem(code, stderr)
        if (problem !== null) write({ kind: 'error', reason: 'kiln-error', message: problem })
        let cacheState = 'skip'
        if (collected !== null && problem === null && code === 0 && overflowed === false) {
          const stored = cache.commit(cwd, {
            head: decision.head,
            configToken: decision.configToken,
            binToken: decision.binToken,
            rows: collected,
            bytes,
          })
          cacheState = stored.stored === true ? 'stored' : stored.reason
        } else if (overflowed === true) {
          // 攒到一半才发现超限：不写，并记住这个仓——下次直接 bypass，不再白攒一遍
          cache.markOversize(cwd, decision.binToken)
          cacheState = 'oversize'
        }
        write({ kind: 'done', exit: code, count, ms: Date.now() - startedAt, cache: cacheState })
        res.end()
      },
    })
  }
}
