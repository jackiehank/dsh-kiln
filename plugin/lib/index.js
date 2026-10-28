/**
 * Host half：给浏览器半提供一条只读路由，`GET /kiln/flow?cwd=<绝对路径>&focus=<issue>`。
 *
 * 浏览器里没有 kiln，但宿主进程有；插件只在宿主侧调 CLI，把结果当成一次快照返回。
 * 快照按 HEAD 失效（见 snapshot.js）：HEAD 没动就完全不碰子进程，动了只重取受影响的 issue。
 * 路由走与 open-in-app 相同的信任栅栏（connection.requestRejection），不额外做鉴权。
 */
import { readSearch, resolveKiln } from './flow.js'
import { createSnapshotCache } from './snapshot.js'

/** Cordis function-plugin name；与包名一致，便于排查。 */
export const name = 'kiln'

/** 需要宿主提供：HTTP 路由载体与请求信任栅栏。 */
export const inject = ['webServer', 'connection']

const FLOW_PATH = '/kiln/flow'
const SEARCH_PATH = '/kiln/search'

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
