/**
 * Host half：给浏览器半提供一条只读路由，`GET /kiln/flow?cwd=<绝对路径>&focus=<issue>`。
 *
 * 浏览器里没有 kiln，但宿主进程有；插件只在宿主侧调 CLI，把结果当成一次快照返回。
 * 路由走与 open-in-app 相同的信任栅栏（connection.requestRejection），不额外做鉴权。
 */
import { readFlow, resolveKiln } from './flow.js'

/** Cordis function-plugin name；与包名一致，便于排查。 */
export const name = 'kiln'

/** 需要宿主提供：HTTP 路由载体与请求信任栅栏。 */
export const inject = ['webServer', 'connection']

const FLOW_PATH = '/kiln/flow'
const CACHE_TTL_MS = 2000

/** 按仓库路径做短期缓存：同一个视图的重复挂载（StrictMode、切标签）不重复起进程。 */
const cache = new Map()

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

async function readFlowCached(repo, focus) {
  const key = repo.toLowerCase()
  const hit = cache.get(key)
  const now = Date.now()
  const payload =
    hit !== undefined && now - hit.at < CACHE_TTL_MS
      ? hit.payload
      : await readFlow(repo, { focus })
  cache.set(key, { at: now, payload })
  if (focus !== undefined && payload.ok === true) {
    const known = payload.issues.some((issue) => issue.id === focus)
    return { ...payload, focus: known ? focus : payload.focus }
  }
  return payload
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
          if (resolveKiln() === null) {
            sendJson(res, 200, { ok: false, repo: cwd, reason: 'kiln-missing', generatedAt: new Date().toISOString() })
            return
          }

          const focus = url.searchParams.get('focus') ?? undefined
          try {
            const payload = await readFlowCached(cwd, focus)
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
}
