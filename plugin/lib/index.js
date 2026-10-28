/**
 * Host half：给浏览器半提供一条只读路由，`GET /kiln/flow?cwd=<绝对路径>&focus=<issue>`。
 *
 * 浏览器里没有 kiln，但宿主进程有；插件只在宿主侧调 CLI，把结果当成一次快照返回。
 * 快照按 HEAD 失效（见 snapshot.js）：HEAD 没动就完全不碰子进程，动了只重取受影响的 issue。
 * 路由走与 open-in-app 相同的信任栅栏（connection.requestRejection），不额外做鉴权。
 */
import { readSearch, repoProblem, resolveKiln } from './flow.js'
import { createSnapshotCache } from './snapshot.js'
import { actionLogProblem, consumeActionLog, spawnActionLog } from './timeline.js'

/** Cordis function-plugin name；与包名一致，便于排查。 */
export const name = 'kiln'

/** 需要宿主提供：HTTP 路由载体与请求信任栅栏。 */
export const inject = ['webServer', 'connection']

const FLOW_PATH = '/kiln/flow'
const SEARCH_PATH = '/kiln/search'
const TIMELINE_PATH = '/kiln/timeline'

/** 进程内缓存：不落盘，重启即失效。 */
const cache = createSnapshotCache()

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

/** 注册只读 Flow 路由；disposer 由 ctx.effect 持有，插件卸载即摘除。 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: FLOW_PATH,
        handler: async (req, res) => {
          const rejection = connectionOf(ctx).requestRejection(req)
          if (rejection !== undefined) {
            res.statusCode = rejection
            res.end()
            return
          }
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }

          const url = new URL(String(req.url ?? '/'), 'http://localhost')
          const cwd = url.searchParams.get('cwd') ?? ''
          if (cwd === '') {
            sendJson(res, 400, { ok: false, reason: 'missing-cwd' })
            return
          }
          const bin = resolveKiln()
          if (bin === null) {
            sendJson(res, 200, { ok: false, repo: cwd, reason: 'kiln-missing', generatedAt: new Date().toISOString() })
            return
          }

          const focus = url.searchParams.get('focus') ?? undefined
          try {
            const payload = await cache.get(cwd, { focus, bin })
            // 便于在浏览器 / 日志里确认缓存行为：hit · incremental · build
            const mode = typeof payload?.cache?.action === 'string' ? payload.cache.action : 'build'
            res.setHeader('x-kiln-cache', mode)
            sendJson(res, 200, payload)
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              repo: cwd,
              reason: 'internal',
              message: String(error?.message ?? error),
              generatedAt: new Date().toISOString(),
            })
          }
        },
      }),
    `kiln: GET ${FLOW_PATH}`,
  )

  /**
   * 时间线：`kiln action log --jsonl` 原样转成 NDJSON 边读边发。
   *
   * 浏览器拿到的是「一行一个事件」：`action`（一条动作）、`error`（一条人话）、`done`（收口）。
   * 上游没有终止记录，EOF 就是终点，所以 `done` 由宿主补——客户端只认这个事件，不用猜行数。
   * 客户端断开（切页 / 刷新 / 卸载）就 kill 子进程，别让一个大仓的 git log 留在后台。
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: TIMELINE_PATH,
        handler: async (req, res) => {
          const rejection = connectionOf(ctx).requestRejection(req)
          if (rejection !== undefined) {
            res.statusCode = rejection
            res.end()
            return
          }
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }

          const url = new URL(String(req.url ?? '/'), 'http://localhost')
          const cwd = url.searchParams.get('cwd') ?? ''
          if (cwd === '') {
            sendJson(res, 400, { ok: false, reason: 'missing-cwd' })
            return
          }
          const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10)

          res.statusCode = 200
          res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
          res.setHeader('cache-control', 'no-store')

          const write = (event) => {
            if (res.writableEnded === true) return false
            return res.write(`${JSON.stringify(event)}\n`)
          }
          const close = (reason, message, extra) => {
            write({ kind: 'error', reason, ...(message === undefined ? {} : { message }), ...(extra ?? {}) })
            write({ kind: 'done', exit: 0, count: 0 })
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

          const startedAt = Date.now()
          const child = spawnActionLog(bin, cwd, limit)
          let closed = false
          res.on('close', () => {
            closed = true
            child.kill()
          })

          consumeActionLog(child, {
            onRecord: (row) => {
              if (closed) return
              // 背压：浏览器没读走之前别让子进程继续吐，100k 仓也不至于把宿主堆满。
              if (write({ kind: 'action', ...row }) === false) {
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
              write({ kind: 'done', exit: code, count, ms: Date.now() - startedAt })
              res.end()
            },
          })
        },
      }),
    `kiln: GET ${TIMELINE_PATH}`,
  )

  /** 搜索：每次查询一个进程，不缓存；客户端负责防抖与取消。 */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SEARCH_PATH,
        handler: async (req, res) => {
          const rejection = connectionOf(ctx).requestRejection(req)
          if (rejection !== undefined) {
            res.statusCode = rejection
            res.end()
            return
          }
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }

          const url = new URL(String(req.url ?? '/'), 'http://localhost')
          const cwd = url.searchParams.get('cwd') ?? ''
          const query = url.searchParams.get('q') ?? ''
          if (cwd === '') {
            sendJson(res, 400, { ok: false, reason: 'missing-cwd' })
            return
          }
          if (query.trim() === '') {
            sendJson(res, 400, { ok: false, reason: 'missing-query' })
            return
          }

          try {
            const result = await readSearch(cwd, query)
            sendJson(res, 200, { ...result, repo: cwd, generatedAt: new Date().toISOString() })
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              repo: cwd,
              reason: 'internal',
              message: String(error?.message ?? error),
              generatedAt: new Date().toISOString(),
            })
          }
        },
      }),
    `kiln: GET ${SEARCH_PATH}`,
  )
}
