/**
 * Host half：只读路由，一个视图一条命令。
 *
 * - `GET /kiln/graph`：关系图（`kiln graph --json`），HEAD 没动就用缓存；
 * - `GET /kiln/issue?id=`：详情（`kiln path <id> --json`），点开才取；
 * - `GET /kiln/timeline`：动作流（`kiln action log --jsonl`，NDJSON），HEAD 没动就内存重发；
 * - `GET /kiln/actions`：词表；`GET /kiln/search`：整仓搜索。
 *
 * 浏览器里没有 kiln，但宿主进程有；插件只在宿主侧调 CLI。
 * 路由走与 open-in-app 相同的信任栅栏（connection.requestRejection），不额外做鉴权。
 */
import { readActions, readIssue, readSearch, repoProblem, resolveKiln } from './flow.js'
import { createRowsCache } from './rowsCache.js'
import { createSnapshotCache } from './snapshot.js'
import { binaryToken, configToken } from './git.js'
import { createTimelineHandler } from './timelineHandler.js'
import { actionLogProblem, consumeActionLog, spawnActionLog } from './timeline.js'

/** Cordis function-plugin name；与包名一致，便于排查。 */
export const name = 'kiln'

/** 需要宿主提供：HTTP 路由载体与请求信任栅栏。 */
export const inject = ['webServer', 'connection']

const GRAPH_PATH = '/kiln/graph'
const ISSUE_PATH = '/kiln/issue'
const SEARCH_PATH = '/kiln/search'
const TIMELINE_PATH = '/kiln/timeline'
const ACTIONS_PATH = '/kiln/actions'

/** 进程内缓存：不落盘，重启即失效。 */
const cache = createSnapshotCache()

/**
 * 动作流缓存（阶段 1）：HEAD 没动就不起子进程，把上一次的行按原 NDJSON 重发。
 * 关掉的方式：`DSH_KILN_TIMELINE_CACHE=off`（等价于每次全量，行为与没有它时一致）。
 */
const timelineCache = createRowsCache()

const timeline = createTimelineHandler({
  resolveKiln,
  repoProblem,
  spawnActionLog,
  consumeActionLog,
  actionLogProblem,
  cache: timelineCache,
  enabled: () => process.env.DSH_KILN_TIMELINE_CACHE !== 'off',
})

/**
 * 词表缓存：只读配置、不读历史，按 (仓库, 配置令牌, 二进制令牌) 失效。
 * 浏览器 F5 会丢掉客户端缓存，宿主这份还在，就不必再起一次 `action list`。
 */
const actionsCache = new Map()
const ACTIONS_CACHE_LIMIT = 16

export function actionsCacheKey(repo, bin) {
  return `${repo}\u0000${configToken(repo)}\u0000${binaryToken(bin ?? '')}`
}

function rememberActions(key, result) {
  if (result?.ok !== true) return
  if (actionsCache.size >= ACTIONS_CACHE_LIMIT) actionsCache.delete(actionsCache.keys().next().value)
  actionsCache.set(key, result)
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

/** 注册只读路由；disposer 由 ctx.effect 持有，插件卸载即摘除。 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: GRAPH_PATH,
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

          try {
            const payload = await cache.get(cwd, { bin })
            // 便于在浏览器 / 日志里确认缓存行为：hit · build · coalesced
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
    `kiln: GET ${GRAPH_PATH}`,
  )

  /**
   * 详情：`kiln path <id> --json` 单条，点开一个 issue 才取。
   *
   * 一次进程（v0.4.0 热读约 30–40ms）；不缓存——HEAD 键控的图缓存管结构，
   * 详情按需读才简单，也天然是新的。
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ISSUE_PATH,
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
          const id = url.searchParams.get('id') ?? ''
          if (cwd === '') {
            sendJson(res, 400, { ok: false, reason: 'missing-cwd' })
            return
          }
          if (id === '') {
            sendJson(res, 400, { ok: false, repo: cwd, reason: 'missing-id' })
            return
          }
          const bin = resolveKiln()
          if (bin === null) {
            sendJson(res, 200, { ok: false, repo: cwd, id, reason: 'kiln-missing', generatedAt: new Date().toISOString() })
            return
          }

          try {
            const result = await readIssue(cwd, id)
            sendJson(res, 200, { ...result, repo: cwd, id, generatedAt: new Date().toISOString() })
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              repo: cwd,
              id,
              reason: 'internal',
              message: String(error?.message ?? error),
              generatedAt: new Date().toISOString(),
            })
          }
        },
      }),
    `kiln: GET ${ISSUE_PATH}`,
  )

  /**
   * 时间线：`kiln action log --jsonl` 原样转成 NDJSON 边读边发。
   *
   * 浏览器拿到的是「一行一个事件」：`action`（一条动作）、`error`（一条人话）、`done`（收口）。
   * 上游没有终止记录，EOF 就是终点，所以 `done` 由宿主补——客户端只认这个事件，不用猜行数。
   * 客户端断开（切页 / 刷新 / 卸载）就 kill 子进程，别让一个大仓的 git log 留在后台。
   *
   * HEAD 没动时走缓存的内存重发（`x-kiln-mode: hit`），实现体在 `timelineHandler.js`。
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
          await timeline(cwd, res, {
            // limit 的缩水结果不能顶替全量缓存：带 limit 的请求永远直读
            noCache: Number.isInteger(limit) && limit > 0,
            fresh: url.searchParams.get('fresh') === '1',
          })
        },
      }),
    `kiln: GET ${TIMELINE_PATH}`,
  )

  /**
   * 动作词表：给客户端折叠 issue 索引用（done = 最近动作 ∈ terminal；“读到起点”= 看到 start）。
   * 一次进程、不读历史；客户端按仓库缓存，不随刷新重取。老版本没有这个命令时明确报 v0.3.0+，
   * 客户端退化成“done 未知”，不影响列表本身。
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ACTIONS_PATH,
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
          const key = actionsCacheKey(cwd, bin)
          const hit = actionsCache.get(key)
          if (hit !== undefined) {
            sendJson(res, 200, { ...hit, repo: cwd, generatedAt: new Date().toISOString() })
            return
          }

          try {
            const result = await readActions(cwd)
            rememberActions(key, result)
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
    `kiln: GET ${ACTIONS_PATH}`,
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
