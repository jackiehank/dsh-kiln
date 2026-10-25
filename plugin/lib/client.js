/**
 * Client half：在会话顶部标签排（对话 / 轨迹 / 上下文）末尾加一个 `kiln` 标签。
 *
 * 标签内是三个平级页面，共用同一个焦点 issue：
 *   timeline —— 一行一个 action，按时间倒序（只算带 issue: + action: 的提交）
 *   issue    —— 一行一个 issue，按最近动作排序
 *   relation —— 关系；两种取景共用同一个焦点：
 *               图（默认，mermaid + Pele）与列表（分组边表），页内分段切换
 *
 * 交互约定（三页一致）：
 *   · 点行 = 展开（issue 展开它的 action 列表；timeline 展开这条提交的详情）
 *   · 行尾 `⌖ 聚焦` = 切焦点；头部 `焦点：x ×` / Esc = 退出
 *   · 列表内方向键走行、Enter 展开、f 聚焦
 *   · 图上点节点 = 聚焦（节点没有“第二层”可展开，这是三页里唯一的手势差异）
 *
 * 焦点、展开项与当前页都只存在内存里（按仓库）：切页会卸载视图，靠这份内存把状态接回来；
 * 刷新页面即清空，不进 URL。数据来自宿主路由 `/kiln/flow`。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-kiln',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STYLE_ID = 'dsh-kiln-flow-style'
    const FLOW_URL = '/kiln/flow'

    /** 关系词表：宿主只回原始边，方向与强弱在这里推导（不在宿主判断“什么算重要”）。 */
    const INVERSE = {
      'has-part': 'part-of',
      'blocked-by': 'blocks',
      'superseded-by': 'supersedes',
      causes: 'caused-by',
    }
    /** 强弱：ordering 槽整体强于 lineage 槽；组内 rank 越大越强。 */
    const GROUPS = [
      { rel: 'part-of', slot: 'ordering', rank: 2, label: '母 issue', edge: 'part-of' },
      { rel: 'blocks', slot: 'ordering', rank: 1, label: '阻塞', edge: 'blocks' },
      { rel: 'supersedes', slot: 'lineage', rank: 3, label: '取代', edge: 'supersedes' },
      { rel: 'caused-by', slot: 'lineage', rank: 2, label: '因果', edge: 'caused-by' },
      { rel: 'relates-to', slot: 'lineage', rank: 1, label: '弱关联', edge: 'relates-to' },
    ]
    /** 颜色只由 action 类型决定；三页共用同一张表。词表外的动作给中性色，不猜。 */
    const ACTION_COLOR = {
      ask: '#5b8def',
      hypothesize: '#9a6bff',
      collect: '#18b6c8',
      test: '#e0a33b',
      conclude: '#35a35f',
      apply: '#35a35f',
    }
    const NEUTRAL = 'var(--dsw-alias-border-l3,#bbb)'
    const PAGES = [
      { id: 'timeline', label: '时间线' },
      { id: 'issue', label: 'issue' },
      { id: 'relation', label: '关系' },
    ]
    /** 关系页的两种取景：图看形状，列表读文字；共用同一份数据与焦点。 */
    const RELATION_MODES = [
      { id: 'graph', label: '图' },
      { id: 'list', label: '列表' },
    ]
    /** 边的线型：ordering 槽实线、lineage 槽虚线、对称关系一条无箭头的线。 */
    const EDGE_STYLE = {
      'part-of': 'solid',
      blocks: 'solid',
      supersedes: 'dashed',
      'caused-by': 'dashed',
      'relates-to': 'plain',
    }
    /** 布局方向：侧栏是竖的，`TB` 常常比 `LR` 更省横向空间。 */
    const GRAPH_DIRECTIONS = [
      { id: 'LR', label: '横向' },
      { id: 'TB', label: '纵向' },
    ]
    /**
     * 三种**视图**（不是两个可自由组合的维度）——参考 Obsidian 的“全局图 / 局部图”与
     * Gephi 的 ego 过滤：工具给的是一组有名字的视图，而不是旋钮的笛卡尔积。
     *   · `global`  整张图，不淡化；
     *   · `dim`     整张图 + 淡化焦点圈外（用户实测最好用的一档）；
     *   · `ego`     只画焦点邻域（`depth` 跳），换视图即重排。
     */
    const GRAPH_VIEWS = [
      { id: 'global', label: '全局' },
      { id: 'dim', label: '全局+焦点' },
      { id: 'ego', label: '焦点一圈' },
    ]
    /** ego 视图的半径。Obsidian 的实践是局部图设 2 跳，1 跳往往只剩一个点。 */
    const GRAPH_DEPTHS = [
      { id: '1', label: '1 跳' },
      { id: '2', label: '2 跳' },
    ]

    /**
     * 每个仓库的视图内存：当前页、焦点、展开项。
     * `conversation.view` 只渲染激活的那一个，切页会卸载整个视图，靠它把三样东西接回来。
     */
    const VIEW_STATE_LIMIT = 4
    const viewStates = new Map()
    const EMPTY_VIEW_STATE = {
      tabId: 'timeline',
      focusId: null,
      expanded: null,
      relationMode: 'graph',
      graphDirection: 'LR',
      graphView: 'dim',
      graphUndirected: false,
      graphDepth: '1',
    }

    function readViewState(cwd) {
      return viewStates.get(cwd) ?? EMPTY_VIEW_STATE
    }

    function writeViewState(cwd, patch) {
      if (cwd === '') return
      const next = { ...readViewState(cwd), ...patch }
      viewStates.set(cwd, next)
      while (viewStates.size > VIEW_STATE_LIMIT) {
        const oldest = viewStates.keys().next().value
        viewStates.delete(oldest)
      }
    }

    /**
     * 最近一份成功快照（按仓库路径）：重挂载先渲染它再后台刷新（stale-while-revalidate）。
     * 只存在内存，刷新页面即清空。
     */
    const SNAPSHOT_CACHE_LIMIT = 4
    const snapshotCache = new Map()

    function rememberSnapshot(cwd, payload) {
      if (cwd === '' || payload?.ok !== true) return
      if (snapshotCache.has(cwd)) snapshotCache.delete(cwd)
      snapshotCache.set(cwd, payload)
      while (snapshotCache.size > SNAPSHOT_CACHE_LIMIT) {
        const oldest = snapshotCache.keys().next().value
        snapshotCache.delete(oldest)
      }
    }

    /**
     * Pele（mermaid → SVG 渲染器）懒加载：vendored 产物是 `lib/client.pele.js`。
     *
     * 名字和位置都不是随便定的——DSH 的客户端加载器只认 `client.<name>.js` 形式的
     * package-local chunk（相对 client.js 所在目录解析），而且那个 chunk 必须自己调
     * `__ModuleLoader__.load({id})` 注册，否则报 "loaded without registering"。
     * 取不到就返回 null，关系页退化成 mermaid 源码——缺一个渲染器不该让整页报错。
     */
    let peleLoader = null
    /** 最近一次加载失败的原因，显示在图上——排查时不必让人去开控制台。 */
    let peleError = ''
    function loadPele() {
      if (peleLoader !== null) return peleLoader
      const load = typeof require.async === 'function' ? require.async : null
      if (load === null) {
        peleError = 'require.async 不可用'
        return Promise.resolve(null)
      }
      peleLoader = Promise.resolve()
        .then(() => load('./client.pele.js'))
        .catch((error) => {
          peleError = String(error?.message ?? error).slice(0, 240)
          return null
        })
        .then((module) => {
          for (const candidate of [module, globalThis.pele]) {
            if (typeof candidate?.mount === 'function') return candidate
          }
          if (peleError === '') peleError = 'chunk 没有导出 mount()'
          return null
        })
        .then((value) => {
          // 失败不写死：文件后补上时下次进页面还能再试
          if (value === null) peleLoader = null
          return value
        })
      return peleLoader
    }

    /** 展开项的键：优先用提交 sha；空提交退化成 issue#序号，避免多条空 sha 互相顶掉。 */
    function actionKey(row) {
      return typeof row.id === 'string' && row.id !== '' ? row.id : `${row.issueId}#${row.ordinal}`
    }

    const CSS = `
.dkf-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111)}
.dkf-head{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2,#e3e3e3);flex:none}
.dkf-brand{font:600 13px/20px var(--dsw-font-family,inherit)}
.dkf-repo{color:var(--dsw-alias-label-secondary,#666);font:12px/20px var(--dsw-font-family-code,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dkf-spacer{flex:1}
.dkf-refresh{border:.5px solid var(--dsw-alias-border-l2,#ddd);background:0 0;color:var(--dsw-alias-label-secondary,#666);border-radius:4px;font:12px/18px var(--dsw-font-family,inherit);padding:1px 8px;cursor:pointer}
.dkf-refresh:hover{color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dkf-focuschip{all:unset;cursor:pointer;color:var(--dsw-alias-label-primary,#111);font:12px/18px var(--dsw-font-family-code,monospace);border:.5px solid var(--dsw-alias-border-l3,#ccc);border-radius:10px;padding:1px 8px;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}
.dkf-focuschip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dkf-tabs{display:flex;gap:2px;padding:0 14px;border-bottom:.5px solid var(--dsw-alias-border-l2,#e3e3e3);flex:none}
.dkf-tab{all:unset;cursor:pointer;padding:5px 10px;border-radius:4px 4px 0 0;color:var(--dsw-alias-label-secondary,#666);font:12px/18px var(--dsw-font-family,inherit)}
.dkf-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dkf-tab-active{color:var(--dsw-alias-label-primary,#111);box-shadow:inset 0 -2px 0 var(--dsw-alias-label-primary,#111)}
.dkf-scroll{flex:1;min-height:0;overflow:auto;padding:10px 14px 32px}
.dkf-note{color:var(--dsw-alias-label-secondary,#666);font:12px/18px var(--dsw-font-family,inherit);margin:0 0 6px}
.dkf-warn{color:#b4690e;font:12px/18px var(--dsw-font-family,inherit);margin:0 0 6px}
.dkf-error{margin:8px 0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2,#e3e3e3);border-radius:6px}
.dkf-error-title{margin:0 0 4px;font:500 13px/20px var(--dsw-font-family,inherit)}
.dkf-error-detail{margin:0;color:var(--dsw-alias-label-secondary,#666);font:12px/18px var(--dsw-font-family-code,monospace);word-break:break-all}
.dkf-list{display:flex;flex-direction:column;outline:none}
.dkf-row{display:grid;grid-template-columns:auto auto auto auto minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:5px 6px;border-radius:4px;min-width:0;outline:none}
.dkf-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dkf-row:focus-visible{box-shadow:inset 0 0 0 1.5px var(--dsw-alias-state-business-primary,#4176e6)}
.dkf-focus{border:.5px solid var(--dsw-alias-border-l3,#ccc);background:var(--dsw-alias-bg-layer-2,#fafafa);margin-bottom:2px}
.dkf-clickable{cursor:pointer}
.dkf-indent{margin-left:22px}
.dkf-crumb{color:var(--dsw-alias-label-secondary,#666);font:12px/18px var(--dsw-font-family,inherit);padding:2px 6px;cursor:pointer;width:max-content;border-radius:4px}
.dkf-crumb:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#111)}
.dkf-strip{display:inline-flex;gap:2px;align-items:center}
.dkf-block{width:7px;height:15px;border-radius:2px;background:var(--dsw-alias-label-tertiary,#999);opacity:.85}
.dkf-block-current{outline:1.5px solid var(--dsw-alias-label-primary,#111);outline-offset:1px}
.dkf-id{font:500 12px/18px var(--dsw-font-family-code,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.dkf-caret{color:var(--dsw-alias-label-tertiary,#999);font:10px/16px var(--dsw-font-family,inherit);width:8px;text-align:center}
.dkf-badges{display:inline-flex;gap:4px;align-items:center;flex:none}
.dkf-chip{font:10px/16px var(--dsw-font-family,inherit);padding:0 5px;border-radius:3px;border:.5px solid var(--dsw-alias-border-l2,#e3e3e3);color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.dkf-chip-done{color:#35a35f;border-color:rgba(53,163,95,.4)}
.dkf-edge{font:10px/16px var(--dsw-font-family-code,monospace);color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}
.dkf-title{color:var(--dsw-alias-label-primary,#111);font:12px/18px var(--dsw-font-family,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dkf-ago{color:var(--dsw-alias-label-tertiary,#999);font:11px/16px var(--dsw-font-family,inherit);white-space:nowrap}
.dkf-empty{color:var(--dsw-alias-label-tertiary,#999);font:12px/18px var(--dsw-font-family,inherit);margin:6px 2px}
.dkf-group{margin:10px 0 0}
.dkf-group-head{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary,#999);font:11px/16px var(--dsw-font-family,inherit);text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px 2px}
.dkf-toggle{all:unset;cursor:pointer;color:var(--dsw-alias-label-secondary,#666);font:11px/16px var(--dsw-font-family,inherit)}
.dkf-toggle:hover{color:var(--dsw-alias-label-primary,#111)}
.dkf-focusbtn{all:unset;cursor:pointer;color:var(--dsw-alias-label-tertiary,#999);font:11px/16px var(--dsw-font-family,inherit);white-space:nowrap;padding:1px 5px;border-radius:4px;opacity:0}
.dkf-row:hover .dkf-focusbtn,.dkf-row:focus-within .dkf-focusbtn,.dkf-arow:hover .dkf-focusbtn,.dkf-arow:focus-within .dkf-focusbtn{opacity:1}
.dkf-focusbtn:hover,.dkf-focusbtn:focus-visible{opacity:1;color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dkf-arow{display:grid;grid-template-columns:3px auto auto minmax(0,1fr) auto auto auto;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;min-width:0;outline:none;cursor:pointer}
.dkf-arow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dkf-arow:focus-visible{box-shadow:inset 0 0 0 1.5px var(--dsw-alias-state-business-primary,#4176e6)}
.dkf-abar{width:3px;height:16px;border-radius:2px;background:${NEUTRAL}}
.dkf-aissue{color:var(--dsw-alias-label-secondary,#666);font:12px/18px var(--dsw-font-family-code,monospace);white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.dkf-achip{font:10px/16px var(--dsw-font-family,inherit);padding:0 5px;border-radius:3px;border:.5px solid currentColor;white-space:nowrap}
.dkf-atitle{color:var(--dsw-alias-label-primary,#111);font:12px/18px var(--dsw-font-family,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dkf-ashort{font:10px/16px var(--dsw-font-family-code,monospace);color:var(--dsw-alias-label-tertiary,#999)}
.dkf-grow{display:flex;align-items:center;gap:4px;padding:3px 6px;border-radius:4px;flex-wrap:wrap;outline:none}
.dkf-grow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dkf-endpoint{all:unset;cursor:pointer;color:var(--dsw-alias-label-secondary,#666);font:12px/18px var(--dsw-font-family-code,monospace);border-radius:4px;padding:0 3px}
.dkf-endpoint:hover{color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dkf-sub{margin:2px 0 6px 30px;border-left:2px solid var(--dsw-alias-border-l2,#e3e3e3);padding:2px 0 2px 10px;display:flex;flex-direction:column;gap:2px}
.dkf-subrow{display:grid;grid-template-columns:3px auto minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:2px 4px;border-radius:3px}
.dkf-subrow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dkf-detail{margin:2px 0 6px 30px;border-left:2px solid var(--dsw-alias-border-l2,#e3e3e3);padding:2px 0 2px 10px;display:flex;flex-direction:column;gap:2px;color:var(--dsw-alias-label-secondary,#666);font:12px/18px var(--dsw-font-family,inherit)}
.dkf-detail-key{display:inline-block;min-width:48px;color:var(--dsw-alias-label-tertiary,#999)}
.dkf-detail code{font:12px/18px var(--dsw-font-family-code,monospace);word-break:break-all;color:var(--dsw-alias-label-primary,#111)}
.dkf-panel{display:flex;flex-direction:column;min-height:0}
.dkf-mode{display:inline-flex;gap:2px;align-self:flex-start;margin:0 0 8px;padding:2px;border:.5px solid var(--dsw-alias-border-l2,#e3e3e3);border-radius:6px}
.dkf-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dkf-toolbar .dkf-mode{margin:0 0 8px}
.dkf-modebtn{all:unset;cursor:pointer;padding:2px 10px;border-radius:4px;color:var(--dsw-alias-label-secondary,#666);font:12px/18px var(--dsw-font-family,inherit)}
.dkf-modebtn:hover{color:var(--dsw-alias-label-primary,#111)}
.dkf-modebtn-active{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}
.dkf-graphwrap{display:flex;flex-direction:column;gap:6px;min-width:0}
.dkf-graph{border:.5px solid var(--dsw-alias-border-l2,#e3e3e3);border-radius:6px;min-height:260px;padding:6px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#fafafa)}
.dkf-graph svg{display:block;max-width:100%;height:auto}
.dkf-gnode-dim{opacity:.22;transition:opacity .12s ease}
.dkf-gedge-dim{opacity:.18;transition:opacity .12s ease}
.dkf-gnode-focus{filter:drop-shadow(0 0 2px var(--dsw-alias-state-business-primary,#4176e6))}
.dkf-mermaid{margin:0;padding:8px 10px;max-height:320px;overflow:auto;border-radius:4px;background:var(--dsw-alias-markdown-code-block,#f6f6f6);color:var(--dsw-alias-label-secondary,#666);font:11px/16px var(--dsw-font-family-code,monospace);white-space:pre}
`

    /** 样式只注入一次；插件卸载不回收（无害），重载复用同一节点。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function cls(...names) {
      return names.filter(Boolean).join(' ')
    }

    function basename(path) {
      const parts = String(path ?? '').split(/[\\/]+/).filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : String(path ?? '')
    }

    function ago(iso) {
      const time = Date.parse(String(iso ?? ''))
      if (!Number.isFinite(time)) return ''
      const delta = Math.max(0, Date.now() - time)
      const minute = 60_000
      const hour = 60 * minute
      const day = 24 * hour
      if (delta < minute) return '刚刚'
      if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`
      if (delta < day) return `${Math.floor(delta / hour)} 小时前`
      if (delta < 30 * day) return `${Math.floor(delta / day)} 天前`
      if (delta < 365 * day) return `${Math.floor(delta / (30 * day))} 个月前`
      return `${Math.floor(delta / (365 * day))} 年前`
    }

    function colorOf(action) {
      return ACTION_COLOR[action] ?? NEUTRAL
    }

    /** 行内按键：Enter / Space 展开，f 聚焦；方向键交给列表容器。 */
    function rowKeyDown(event, props) {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        props.onToggle()
        return
      }
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault()
        props.onFocus()
      }
    }

    /** 列表容器：↑/↓ 在行之间移动焦点（行本身 tabIndex=-1，避免几十个 tab 停靠点）。 */
    function listKeyDown(event) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const container = event.currentTarget
      if (container === null || container === undefined || typeof container.querySelectorAll !== 'function') return
      const rows = Array.from(container.querySelectorAll('[data-row]'))
      if (rows.length === 0) return
      event.preventDefault()
      const current = rows.indexOf(document.activeElement)
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next =
        current < 0 ? (delta === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, current + delta))
      const target = rows[next]
      if (target !== undefined && typeof target.focus === 'function') target.focus()
    }

    /** 把一条 graph 边归一成 (a 关系 b)；反向名翻转端点，词表外的名字丢弃。 */
    function canonical(edge) {
      const name = String(edge?.name ?? '')
      if (name === 'relates-to') return { a: edge.from, b: edge.to, rel: 'relates-to', directed: false }
      const inverse = INVERSE[name]
      if (inverse !== undefined) return { a: edge.to, b: edge.from, rel: inverse, directed: true }
      if (name === 'part-of' || name === 'blocks' || name === 'supersedes' || name === 'caused-by') {
        return { a: edge.from, b: edge.to, rel: name, directed: true }
      }
      return null
    }

    /** 归一 + 去重（同一 (a, rel, b) 只留一条）。 */
    function canonicalEdges(edges) {
      const seen = new Set()
      const out = []
      for (const edge of edges) {
        const relation = canonical(edge)
        if (relation === null) continue
        const key = `${relation.rel}|${relation.a}|${relation.b}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(relation)
      }
      return out
    }

    /**
     * 以 focus 为根折成“面包屑 + 分组邻居”，并给出本次取景的 issue 集合。
     * part-of 蕴含的 blocks 边被 part-of 覆盖，不重复显示。
     */
    function relatedOf(focus, relations) {
      const parent = []
      const children = []
      const groups = new Map(GROUPS.map((group) => [group.rel, []]))
      const ids = new Set([focus])

      const partOfPairs = new Set()
      for (const relation of relations) {
        if (relation.rel !== 'part-of') continue
        partOfPairs.add(`${relation.a}\u0000${relation.b}`)
        partOfPairs.add(`${relation.b}\u0000${relation.a}`)
      }

      for (const relation of relations) {
        if (relation.rel === 'part-of') {
          if (relation.a === focus) parent.push(relation.b)
          else if (relation.b === focus) children.push(relation.a)
          continue
        }
        if (relation.rel === 'blocks') {
          const other = relation.a === focus ? relation.b : relation.b === focus ? relation.a : null
          if (other === null) continue
          if (partOfPairs.has(`${focus}\u0000${other}`)) continue
          groups.get('blocks').push({ id: other, arrow: relation.a === focus ? '→' : '←' })
          continue
        }
        if (relation.rel === 'relates-to') {
          if (relation.a !== focus && relation.b !== focus) continue
          groups.get('relates-to').push({ id: relation.a === focus ? relation.b : relation.a, arrow: '⇄' })
          continue
        }
        if (relation.rel === 'supersedes' || relation.rel === 'caused-by') {
          const other = relation.a === focus ? relation.b : relation.b === focus ? relation.a : null
          if (other === null) continue
          groups.get(relation.rel).push({ id: other, arrow: relation.a === focus ? '→' : '←' })
        }
      }

      for (const id of parent) ids.add(id)
      for (const id of children) ids.add(id)
      for (const list of groups.values()) for (const entry of list) ids.add(entry.id)
      return { parent, children, groups, ids }
    }

    /** 全局关系视图：按词表顺序分组；词表外的名字归到“未登记”。 */
    function globalRelationRows(relations) {
      const known = new Set(GROUPS.map((group) => group.rel))
      const rows = []
      for (const group of GROUPS) {
        const matched = relations.filter((relation) => relation.rel === group.rel)
        if (matched.length > 0) rows.push({ rel: group.rel, label: group.label, edge: group.edge, rows: matched })
      }
      const unknown = relations.filter((relation) => !known.has(relation.rel))
      if (unknown.length > 0) rows.push({ rel: 'unknown', label: '未登记', edge: '?', rows: unknown })
      return rows
    }

    /**
     * 从快照生成 mermaid 文本（图模式的数据侧）。
     *
     * 不用 `kiln graph --mermaid` 的两个原因：对称边（`relates-to`）在那边会退化成无标签连线，
     * 节点 id 也是 kiln 自己 sanitize + 撞名改名的，反查不回 issue id。这里自己出文本，
     * 换来三件事：对称边带关系名、强弱靠线型、节点 id 与 issue 一一对应（`byNode`）。
     *
     * 三个输入决定文本：
     *   · `direction` —— `LR` / `TB`；
     *   · `undirected` —— 要不要把无向的 `relates-to` 也画进来（默认不画：58 节点里 53 条边是它，
     *     去掉后交叉 112 → 0，见 docs/issues/kiln-graph-readability.md）；
     *   · `view` —— `global` 全图 / `dim` 全图+淡化（文本同 global）/ `ego` 只画焦点邻域（`depth` 跳）。
     *
     * 只有后两者会改文本，所以「全局 / 全局+焦点」两档切焦点不重排，只有 `ego` 会重画。
     */
    function buildMermaid(issues, relations, options = {}) {
      const direction = options.direction === 'TB' ? 'TB' : 'LR'
      const undirected = options.undirected === true
      const view = options.view ?? 'global'
      const focusId = options.focusId ?? null
      const depth = options.depth === 2 ? 2 : 1

      const base = undirected ? relations : relations.filter((relation) => relation.directed !== false)
      let kept = base
      let ego = false
      let widened = false

      if (view === 'ego' && focusId !== null) {
        ego = true
        const within = egoNodes(focusId, base, depth)
        if (within.size > 1) {
          kept = edgesWithin(base, within)
        } else if (!undirected) {
          // 焦点只挂在被藏起来的那一类边上：这一张临时放开，否则画出来是个空图
          const wider = egoNodes(focusId, relations, depth)
          if (wider.size > 1) {
            widened = true
            kept = edgesWithin(relations, wider)
          } else {
            kept = []
          }
        } else {
          kept = []
        }
      }

      const touched = new Set()
      for (const relation of kept) {
        touched.add(relation.a)
        touched.add(relation.b)
      }
      if (ego) touched.add(focusId)
      const visible = undirected && !ego ? issues : issues.filter((issue) => touched.has(issue.id))

      const nodeOf = new Map()
      const byNode = new Map()
      const used = new Set()
      const sorted = visible.slice().sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      const lines = [`flowchart ${direction}`]
      const byAction = new Map()

      for (const issue of sorted) {
        const baseNode = `n_${String(issue.id).replace(/[^A-Za-z0-9_]/g, '_') || 'x'}`
        let node = baseNode
        for (let index = 2; used.has(node); index += 1) node = `${baseNode}_${index}`
        used.add(node)
        nodeOf.set(issue.id, node)
        byNode.set(node, issue.id)
        lines.push(`  ${node}["${String(issue.id).replaceAll('"', '#quot;')}"]`)
        const action = typeof issue.action === 'string' ? issue.action : ''
        if (ACTION_COLOR[action] !== undefined) {
          if (!byAction.has(action)) byAction.set(action, [])
          byAction.get(action).push(node)
        }
      }

      // 节点描边颜色 = 最近一个动作的类型色，与另外两页同一张表
      for (const [action, nodes] of byAction) {
        lines.push(`  classDef act_${action} stroke:${ACTION_COLOR[action]},stroke-width:2px`)
      }

      let dropped = 0
      for (const relation of kept) {
        const from = nodeOf.get(relation.a)
        const to = nodeOf.get(relation.b)
        if (from === undefined || to === undefined) {
          dropped += 1
          continue
        }
        const label = `|${relation.rel}|`
        if (relation.directed === false) lines.push(`  ${from} ---${label} ${to}`)
        else if (EDGE_STYLE[relation.rel] === 'dashed') lines.push(`  ${from} -.->${label} ${to}`)
        else lines.push(`  ${from} -->${label} ${to}`)
      }

      for (const [action, nodes] of byAction) lines.push(`  class ${nodes.join(',')} act_${action}`)

      return {
        source: lines.join('\n'),
        nodeOf,
        byNode,
        dropped,
        ego,
        widened,
        hidden: { edges: relations.length - kept.length, nodes: issues.length - visible.length },
      }
    }

    /** 从焦点出发 k 跳能到达的 issue 集合（含焦点自己）。 */
    function egoNodes(focusId, relations, depth) {
      const seen = new Set([focusId])
      let frontier = [focusId]
      for (let hop = 0; hop < depth; hop += 1) {
        const next = []
        for (const relation of relations) {
          for (const [from, to] of [
            [relation.a, relation.b],
            [relation.b, relation.a],
          ]) {
            if (!frontier.includes(from) || seen.has(to)) continue
            seen.add(to)
            next.push(to)
          }
        }
        if (next.length === 0) break
        frontier = next
      }
      return seen
    }

    /** 两端都落在 within 里的边。 */
    function edgesWithin(relations, within) {
      return relations.filter((relation) => within.has(relation.a) && within.has(relation.b))
    }

    /**
     * 聚焦的三档（焦点 / 强邻居 / 弱邻居），弱邻居与无关共用同一种淡化：
     * 一档太粗（看不见谁是相关），三档太细（色不够分了），所以只区分“相关 / 无关”。
     */
    function graphTiers(focusId, relations) {
      const related = new Set([focusId])
      const strong = new Set()
      const weak = new Set()
      for (const relation of relations) {
        if (relation.a !== focusId && relation.b !== focusId) continue
        const other = relation.a === focusId ? relation.b : relation.a
        related.add(other)
        if (relation.rel === 'part-of' || relation.rel === 'blocks') strong.add(other)
        else weak.add(other)
      }
      return { focus: focusId, related, strong, weak, relations }
    }

    /**
     * 把聚焦画到已经渲染好的 SVG 上：只动 class 与透明度，节点位置一律不碰。
     * Pele 的节点组带 `data-id`（等于 mermaid 源里的节点 id），边也带
     * `data-id="L_<from>_<to>_<序号>"`，所以边也能逐条淡化——不然会出现“亮线连着暗节点”。
     */
    function paintFocus(host, tiers, built) {
      if (host === null || typeof host.querySelectorAll !== 'function') return
      const { byNode, nodeOf } = built
      for (const element of host.querySelectorAll('.pele-node')) {
        const id = byNode.get(element.getAttribute('data-id')) ?? null
        const related = tiers !== null && id !== null && tiers.related.has(id)
        element.classList.toggle('dkf-gnode-dim', tiers !== null && !related)
        element.classList.toggle('dkf-gnode-focus', tiers !== null && id === tiers.focus)
      }

      // 一条边只要有一端在焦点圈里就保持原样，两端都在圈外才淡
      const bright = new Set()
      if (tiers !== null) {
        for (const [id, node] of nodeOf) {
          if (tiers.related.has(id)) bright.add(node)
        }
      }
      const prefixes = []
      for (const relation of tiers?.relations ?? []) {
        const from = nodeOf.get(relation.a)
        const to = nodeOf.get(relation.b)
        if (from === undefined || to === undefined) continue
        if (bright.has(from) || bright.has(to)) prefixes.push(`L_${from}_${to}_`)
      }
      for (const element of host.querySelectorAll('.pele-edge')) {
        const dataId = element.getAttribute('data-id') ?? ''
        const incident = prefixes.some((prefix) => dataId.startsWith(prefix))
        element.classList.toggle('dkf-gedge-dim', tiers !== null && !incident)
      }
    }

    /** 三页共用的“相关集”：焦点 + 一跳邻居。 */
    function scopedIssues(issues, view) {
      if (view === null) return issues
      return issues.filter((issue) => view.ids.has(issue.id))
    }
    function flattenActions(issues) {
      const rows = []
      for (const issue of issues) {
        const actions = Array.isArray(issue.actions) ? issue.actions : []
        for (const action of actions) {
          rows.push({
            issueId: issue.id,
            action: action.action,
            title: action.title,
            date: action.date,
            id: action.id,
            short: action.short,
            ordinal: action.ordinal,
            refs: Array.isArray(action.refs) ? action.refs : [],
          })
        }
      }
      return rows
    }

    /** 时间倒序；同刻按 issue id、再按 ordinal 稳定排序，刷新不乱跳。 */
    function sortActions(rows) {
      return rows.slice().sort((left, right) => {
        const leftDate = left.date ?? ''
        const rightDate = right.date ?? ''
        if (leftDate !== rightDate) return leftDate < rightDate ? 1 : -1
        if (left.issueId !== right.issueId) return left.issueId < right.issueId ? -1 : 1
        return (left.ordinal ?? 0) - (right.ordinal ?? 0)
      })
    }

    /** 按最近动作排序；有焦点时把焦点的行钉在第一条。 */
    function sortIssues(issues, pinId) {
      const sorted = issues.slice().sort(byRecency)
      if (pinId === null) return sorted
      const index = sorted.findIndex((issue) => issue.id === pinId)
      if (index <= 0) return sorted
      const pinned = sorted.splice(index, 1)[0]
      return [pinned, ...sorted]
    }

    /** 组内按最近动作时间排序；没有日期的排最后。 */
    function byRecency(left, right) {
      const leftDate = left.last?.date ?? ''
      const rightDate = right.last?.date ?? ''
      if (leftDate === rightDate) return left.id.localeCompare(right.id)
      return leftDate < rightDate ? 1 : -1
    }

    /** 焦点行下方的迷你动作条：最近 12 个，更早的折成 +k。 */
    function strip(actions) {
      if (!Array.isArray(actions) || actions.length === 0) return null
      const visible = actions.slice(-12)
      const extra = actions.length - visible.length
      return h(
        'span',
        { className: 'dkf-strip', title: actions.map((action) => `${action.ordinal}. ${action.action}`).join('\n') },
        extra > 0 ? h('span', { className: 'dkf-ago' }, `+${extra}`) : null,
        visible.map((action, index) =>
          h('span', {
            key: `${action.ordinal}-${index}`,
            className: cls('dkf-block', index === visible.length - 1 && 'dkf-block-current'),
            style: { background: colorOf(action.action) },
            title: `${action.ordinal}. ${action.action} · ${action.date} · ${action.title ?? ''}`,
          }),
        ),
      )
    }

    /** 展开后的动作列表：一行一条、时间倒序、带 title（像 git log）。 */
    function ActionLines(props) {
      const actions = Array.isArray(props.actions) ? props.actions : []
      if (actions.length === 0) return h('p', { className: 'dkf-empty dkf-sub' }, '这条 issue 还没有动作。')
      return h(
        'div',
        { className: 'dkf-sub' },
        actions
          .slice()
          .reverse()
          .map((action) =>
            h(
              'div',
              { className: 'dkf-subrow', key: `${action.ordinal}-${action.short || ''}` },
              h('span', { className: 'dkf-abar', style: { background: colorOf(action.action) } }),
              h('span', { className: 'dkf-achip', style: { color: colorOf(action.action) } }, action.action || '?'),
              h('span', { className: 'dkf-atitle', title: action.title }, action.title || '（无标题）'),
              h('span', { className: 'dkf-ashort' }, action.short || ''),
              h('span', { className: 'dkf-ago' }, ago(action.date)),
            ),
          ),
      )
    }

    /** timeline 行展开：这条提交的详情。 */
    function ActionDetail(props) {
      const row = props.row
      const refs = Array.isArray(row.refs) ? row.refs : []
      return h(
        'div',
        { className: 'dkf-detail' },
        h('div', null, h('span', { className: 'dkf-detail-key' }, '提交'), h('code', null, row.id || '（无 sha）')),
        h(
          'div',
          null,
          h('span', { className: 'dkf-detail-key' }, '步骤'),
          h('span', null, `${row.ordinal ?? '?'} / ${props.total ?? '?'}`),
        ),
        refs.length > 0
          ? h('div', null, h('span', { className: 'dkf-detail-key' }, '引用'), h('span', null, refs.join('、')))
          : null,
        h('div', null, h('span', { className: 'dkf-detail-key' }, '时间'), h('span', null, row.date || '')),
      )
    }

    /** 一行 issue：点行展开动作，行尾 `⌖ 聚焦` 切焦点。 */
    function IssueRow(props) {
      const issue = props.issue
      if (issue === undefined) return null
      const last = issue.last
      const expanded = props.expanded === true
      return h(
        React.Fragment,
        null,
        h(
          'div',
          {
            className: cls('dkf-row', props.focus && 'dkf-focus', props.indent && 'dkf-indent', 'dkf-clickable'),
            'data-row': '',
            tabIndex: -1,
            onClick: props.onToggle,
            onKeyDown: (event) => rowKeyDown(event, props),
          },
          strip(issue.actions),
          h('span', { className: 'dkf-caret', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'),
          h(
            'span',
            { className: 'dkf-id' },
            props.edge !== undefined ? h('span', { className: 'dkf-edge' }, ` ${props.edge} `) : null,
            issue.id,
          ),
          h(
            'span',
            { className: 'dkf-badges' },
            issue.domain ? h('span', { className: 'dkf-chip' }, issue.domain) : null,
            h('span', { className: 'dkf-chip', style: { color: colorOf(issue.action) } }, issue.action || '?'),
            issue.done ? h('span', { className: 'dkf-chip dkf-chip-done' }, 'done') : null,
          ),
          h('span', { className: 'dkf-title' }, last?.title || issue.title || '（无标题）'),
          h('span', { className: 'dkf-ago' }, ago(last?.date)),
          h(
            'button',
            {
              type: 'button',
              className: 'dkf-focusbtn',
              tabIndex: -1,
              title: `聚焦 ${issue.id}（快捷键 f）`,
              onClick: (event) => {
                event.stopPropagation()
                props.onFocus()
              },
            },
            '⌖ 聚焦',
          ),
        ),
        expanded ? h(ActionLines, { actions: issue.actions }) : null,
      )
    }

    /** timeline 的一行：动作色条 + 所属 issue + action + 完整标题 + 短 sha + 相对时间。 */
    function ActionRow(props) {
      const row = props.row
      return h(
        React.Fragment,
        null,
        h(
          'div',
          {
            className: 'dkf-arow',
            'data-row': '',
            tabIndex: -1,
            onClick: props.onToggle,
            onKeyDown: (event) => rowKeyDown(event, props),
            title: '点开看这条提交的详情',
          },
          h('span', { className: 'dkf-abar', style: { background: colorOf(row.action) } }),
          h('span', { className: 'dkf-aissue' }, row.issueId),
          h('span', { className: 'dkf-achip', style: { color: colorOf(row.action) } }, row.action || '?'),
          h('span', { className: 'dkf-atitle', title: row.title }, row.title || '（无标题）'),
          h('span', { className: 'dkf-ashort' }, row.short || ''),
          h('span', { className: 'dkf-ago' }, ago(row.date)),
          h(
            'button',
            {
              type: 'button',
              className: 'dkf-focusbtn',
              tabIndex: -1,
              title: `聚焦 ${row.issueId}（快捷键 f）`,
              onClick: (event) => {
                event.stopPropagation()
                props.onFocus()
              },
            },
            '⌖ 聚焦',
          ),
        ),
        props.expanded === true ? h(ActionDetail, { row, total: props.total }) : null,
      )
    }

    /** 三页切换：官方 tablist 约定——roving tabindex + 方向键 + Home/End，切完焦点跟到新页签。 */
    function PageTabs(props) {
      const refs = React.useRef([])
      const pages = props.pages
      const idBase = props.idBase

      function onKeyDown(event, index) {
        if (event.altKey || event.ctrlKey || event.metaKey) return
        let next = -1
        if (event.key === 'ArrowRight') next = (index + 1) % pages.length
        else if (event.key === 'ArrowLeft') next = (index - 1 + pages.length) % pages.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = pages.length - 1
        if (next < 0) return
        event.preventDefault()
        props.onSelect(pages[next].id)
        const node = refs.current[next]
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
      }

      return h(
        'div',
        { className: 'dkf-tabs', role: 'tablist', 'aria-label': 'kiln 视图' },
        pages.map((page, index) => {
          const selected = page.id === props.active
          return h(
            'button',
            {
              key: page.id,
              type: 'button',
              ref: (node) => {
                refs.current[index] = node
              },
              role: 'tab',
              id: `${idBase}-tab-${page.id}`,
              'aria-controls': `${idBase}-panel`,
              'aria-selected': selected,
              tabIndex: selected ? 0 : -1,
              className: cls('dkf-tab', selected && 'dkf-tab-active'),
              onClick: () => props.onSelect(page.id),
              onKeyDown: (event) => onKeyDown(event, index),
            },
            page.label,
          )
        }),
      )
    }

    function TimelinePanel(props) {
      if (props.rows.length === 0) return h('p', { className: 'dkf-empty' }, props.emptyText)
      return h(
        'div',
        { className: 'dkf-list', tabIndex: 0, onKeyDown: listKeyDown },
        props.rows.map((row, index) =>
          h(ActionRow, {
            key: `${row.issueId}-${row.ordinal}-${index}`,
            row,
            total: props.totalOf(row.issueId),
            expanded: props.expanded !== null && props.expanded.kind === 'action' && props.expanded.id === actionKey(row),
            onToggle: () => props.onToggle({ kind: 'action', id: actionKey(row) }),
            onFocus: () => props.onFocus(row.issueId),
          }),
        ),
      )
    }

    function IssuePanel(props) {
      if (props.issues.length === 0) return h('p', { className: 'dkf-empty' }, props.emptyText)
      return h(
        'div',
        { className: 'dkf-list', tabIndex: 0, onKeyDown: listKeyDown },
        props.issues.map((issue) =>
          h(IssueRow, {
            key: issue.id,
            issue,
            focus: issue.id === props.focusId,
            expanded: props.expanded !== null && props.expanded.kind === 'issue' && props.expanded.id === issue.id,
            onToggle: () => props.onToggle({ kind: 'issue', id: issue.id }),
            onFocus: () => props.onFocus(issue.id),
          }),
        ),
      )
    }

    /**
     * 关系页的“图”取景。
     *
     * 文本在渲染期一次算好、挂到 `data-mermaid` 上（排查也方便）；真正画图放在 effect 里，
     * 因为 render 阶段不能碰 DOM。**文本与焦点无关**，所以切焦点只跑 paintFocus 改 class，
     * 图不重排、不重解析——这是“全局关系与聚焦状态同框”的前提。
     */
    function GraphPanel(props) {
      const direction = props.direction === 'TB' ? 'TB' : 'LR'
      const view = props.graphView === 'global' || props.graphView === 'ego' ? props.graphView : 'dim'
      const undirected = props.undirected === true
      const depth = props.depth === '2' ? 2 : 1
      const built = React.useMemo(
        () => buildMermaid(props.issues, props.relations, { direction, undirected, view, focusId: props.focusId, depth }),
        [props.issues, props.relations, direction, undirected, view, props.focusId, depth],
      )
      // 只有「全局+焦点」需要分档；ego 画出来的本来就是一圈，global 不淡化
      const tiers = React.useMemo(
        () => (props.focusId === null || view !== 'dim' ? null : graphTiers(props.focusId, props.relations)),
        [props.focusId, props.relations, view],
      )
      const hostRef = React.useRef(null)
      const [phase, setPhase] = React.useState('idle')

      React.useEffect(() => {
        const host = hostRef.current
        if (host === null) return undefined
        let alive = true
        let handle = null
        setPhase('idle')
        loadPele().then((pele) => {
          if (!alive) return
          if (pele === null) {
            setPhase('missing')
            return
          }
          try {
            handle = pele.mount(host, built.source, { zoom: 'auto' })
            setPhase('ready')
          } catch {
            setPhase('failed')
          }
        })
        return () => {
          alive = false
          if (handle !== null && typeof handle.destroy === 'function') {
            try {
              handle.destroy()
            } catch {
              // 卸载时渲染器报错不该影响视图切换
            }
          }
        }
      }, [built.source])

      React.useEffect(() => {
        if (phase !== 'ready') return
        paintFocus(hostRef.current, tiers, built)
      }, [phase, built, tiers])

      const onClick = (event) => {
        const target = event?.target
        const node = typeof target?.closest === 'function' ? target.closest('[data-id]') : null
        if (node === null) return
        const id = built.byNode.get(node.getAttribute('data-id'))
        if (typeof id === 'string') props.onFocus(id)
      }

      const notice =
        phase === 'ready'
          ? null
          : h(
              'p',
              { className: 'dkf-note' },
              phase === 'missing'
                ? `没拿到图渲染器（plugin/lib/client.pele.js）：${peleError}。先显示 mermaid 源码。`
                : phase === 'failed'
                  ? '图渲染失败，先显示 mermaid 源码。'
                  : '正在准备图渲染器…',
            )

      return h(
        'div',
        { className: 'dkf-graphwrap' },
        notice,
        h('div', {
          className: 'dkf-graph',
          ref: hostRef,
          'data-mermaid': built.source,
          'data-focus': props.focusId ?? '',
          onClick,
        }),
        phase === 'ready' ? null : h('pre', { className: 'dkf-mermaid' }, built.source),
        built.ego && props.focusId !== null
          ? h(
              'p',
              { className: 'dkf-note' },
              `焦点一圈：${props.focusId} 与 ${depth} 跳内的 ${Math.max(0, built.byNode.size - 1)} 个邻居。`,
            )
          : null,
        built.widened
          ? h(
              'p',
              { className: 'dkf-note' },
              `焦点 ${props.focusId} 只挂在无向关联上，这一张临时把它们也画了。`,
            )
          : null,
        !undirected && !built.ego && built.hidden.edges > 0
          ? h(
              'p',
              { className: 'dkf-note' },
              `已隐藏 ${built.hidden.edges} 条无向关联、${built.hidden.nodes} 个只挂在它们上面的 issue。`,
              h(
                'button',
                { type: 'button', className: 'dkf-toggle', onClick: () => props.onUndirected(true) },
                ' 显示无向',
              ),
            )
          : null,
        built.dropped > 0 ? h('p', { className: 'dkf-note' }, `${built.dropped} 条边指向快照外的 issue，未画。`) : null,
        h(
          'p',
          { className: 'dkf-note' },
          props.focusId === null
            ? '点节点聚焦；图出来后可用滚轮/拖动缩放平移。'
            : '点别的节点换焦点；头部「×」或 Esc 回到全局。',
        ),
      )
    }

    /** 一排互斥按钮（取景 / 方向共用），roving 交给浏览器，够用。 */
    function Segmented(props) {
      return h(
        'div',
        { className: 'dkf-mode', role: 'group', 'aria-label': props.label },
        props.options.map((option) =>
          h(
            'button',
            {
              key: option.id,
              type: 'button',
              className: `dkf-modebtn${props.active === option.id ? ' dkf-modebtn-active' : ''}`,
              'aria-pressed': props.active === option.id,
              onClick: () => props.onSelect(option.id),
            },
            option.label,
          ),
        ),
      )
    }

    /** 关系页：图上/列表两种取景，共用同一个焦点。 */
    function RelationPanel(props) {
      const modes = h(Segmented, {
        label: '关系取景',
        options: RELATION_MODES,
        active: props.mode,
        onSelect: props.onMode,
      })
      if (props.mode === 'graph') {
        return h(
          'div',
          { className: 'dkf-panel' },
          h(
            'div',
            { className: 'dkf-toolbar' },
            modes,
            h(Segmented, {
              label: '图的布局方向',
              options: GRAPH_DIRECTIONS,
              active: props.direction === 'TB' ? 'TB' : 'LR',
              onSelect: props.onDirection,
            }),
            h(Segmented, {
              label: '视图',
              options: GRAPH_VIEWS,
              active: props.graphView === 'global' || props.graphView === 'ego' ? props.graphView : 'dim',
              onSelect: props.onView,
            }),
            h(
              'button',
              {
                type: 'button',
                className: `dkf-modebtn${props.undirected ? ' dkf-modebtn-active' : ''}`,
                'aria-pressed': props.undirected,
                title: '把无向的 relates-to 也画进图里',
                onClick: () => props.onUndirected(!props.undirected),
              },
              '无向关联',
            ),
            props.graphView === 'ego'
              ? h(Segmented, {
                  label: '焦点一圈的半径',
                  options: GRAPH_DEPTHS,
                  active: props.depth === '2' ? '2' : '1',
                  onSelect: props.onFocusDepth,
                })
              : null,
          ),
          h(GraphPanel, {
            issues: props.issues,
            relations: props.relations,
            focusId: props.focusId,
            direction: props.direction,
            graphView: props.graphView,
            undirected: props.undirected,
            depth: props.depth,
            onUndirected: props.onUndirected,
            onFocus: props.onFocus,
          }),
        )
      }
      return h('div', { className: 'dkf-panel' }, modes, h(RelationList, props))
    }

    /** 关系页：无焦点看全局边表；有焦点看以焦点为中心的一跳子图。 */
    function RelationList(props) {
      if (props.focus === null) {
        if (props.groups.length === 0) return h('p', { className: 'dkf-empty' }, '还没有声明任何关系。')
        return h(
          'div',
          null,
          props.groups.map((group) =>
            h(
              'div',
              { className: 'dkf-group', key: group.rel },
              h('div', { className: 'dkf-group-head' }, `${group.label} · ${group.edge} ${group.rows.length}`),
              group.rows.map((relation) =>
                h(
                  'div',
                  { className: 'dkf-grow', key: `${relation.rel}-${relation.a}-${relation.b}` },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dkf-endpoint',
                      title: `聚焦 ${relation.a}`,
                      onClick: () => props.onFocus(relation.a),
                    },
                    `⌖ ${relation.a}`,
                  ),
                  h('span', { className: 'dkf-edge' }, ` ${relation.rel} `),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dkf-endpoint',
                      title: `聚焦 ${relation.b}`,
                      onClick: () => props.onFocus(relation.b),
                    },
                    `⌖ ${relation.b}`,
                  ),
                ),
              ),
            ),
          ),
        )
      }

      const view = props.view
      const children = view.children
        .map((id) => props.byId.get(id))
        .filter(Boolean)
        .sort(byRecency)
      const visibleChildren = props.expandedChildren || children.length <= 4 ? children : children.slice(0, 4)
      const weak = view.groups.get('relates-to') ?? []
      const strongGroups = GROUPS.filter((group) => group.rel !== 'part-of' && group.rel !== 'relates-to')

      const rowProps = (issue, extra) => ({
        issue,
        expanded: props.expanded !== null && props.expanded.kind === 'issue' && props.expanded.id === issue.id,
        onToggle: () => props.onToggle({ kind: 'issue', id: issue.id }),
        onFocus: () => props.onFocus(issue.id),
        ...extra,
      })

      return h(
        'div',
        { className: 'dkf-list', tabIndex: 0, onKeyDown: listKeyDown },
        h(IssueRow, { key: props.focus.id, ...rowProps(props.focus, { focus: true }) }),
        view.parent.length > 0
          ? h(
              'div',
              { className: 'dkf-crumb', onClick: () => props.onFocus(view.parent[0]), title: '切到母 issue' },
              `↑ part-of: ${view.parent[0]}`,
            )
          : null,
        children.length > 0
          ? h(
              'div',
              { className: 'dkf-group' },
              h(
                'div',
                { className: 'dkf-group-head' },
                `子 issue · part-of ${children.length}`,
                children.length > 4
                  ? h(
                      'button',
                      { type: 'button', className: 'dkf-toggle', onClick: props.onToggleChildren },
                      props.expandedChildren ? '收起' : `展开全部 ${children.length}`,
                    )
                  : null,
              ),
              visibleChildren.map((child) => h(IssueRow, { key: child.id, ...rowProps(child, { indent: true }) })),
            )
          : null,
        strongGroups.map((group) => {
          const rows = (view.groups.get(group.rel) ?? [])
            .map((entry) => ({ entry, issue: props.byId.get(entry.id) }))
            .filter((row) => row.issue !== undefined)
            .sort((left, right) => byRecency(left.issue, right.issue))
          if (rows.length === 0) return null
          return h(
            'div',
            { className: 'dkf-group', key: group.rel },
            h('div', { className: 'dkf-group-head' }, `${group.label} · ${group.edge} ${rows.length}`),
            rows.map(({ entry, issue }) =>
              h(IssueRow, {
                key: `${group.rel}-${issue.id}`,
                ...rowProps(issue, { edge: `${entry.arrow} ${group.edge}` }),
              }),
            ),
          )
        }),
        weak.length > 0
          ? h(
              'div',
              { className: 'dkf-group' },
              h(
                'button',
                { type: 'button', className: 'dkf-toggle', onClick: props.onToggleWeak },
                props.expandedWeak ? '收起弱关联' : `+${weak.length} 弱关联 · relates-to`,
              ),
              props.expandedWeak
                ? weak
                    .map((entry) => props.byId.get(entry.id))
                    .filter(Boolean)
                    .sort(byRecency)
                    .map((issue) => h(IssueRow, { key: `weak-${issue.id}`, ...rowProps(issue, { indent: true }) }))
                : null,
            )
          : null,
      )
    }

    function KilnView(props) {
      const cwd = typeof props.cwd === 'string' ? props.cwd : ''
      const idBase = 'dsh-kiln-view'
      const memory = readViewState(cwd)
      const [state, setState] = React.useState(() => {
        const cached = cwd === '' ? undefined : snapshotCache.get(cwd)
        return cached === undefined
          ? { phase: 'loading', payload: null, error: null }
          : { phase: 'ready', payload: cached, error: null }
      })
      const [nonce, setNonce] = React.useState(0)
      const [tabId, setTabId] = React.useState(memory.tabId)
      const [focusId, setFocusId] = React.useState(memory.focusId)
      const [expanded, setExpanded] = React.useState(memory.expanded)
      const [expandedWeak, setExpandedWeak] = React.useState(false)
      const [expandedChildren, setExpandedChildren] = React.useState(false)
      const [relationMode, setRelationMode] = React.useState(memory.relationMode ?? 'graph')
      const [graphDirection, setGraphDirection] = React.useState(memory.graphDirection === 'TB' ? 'TB' : 'LR')
      const [graphView, setGraphView] = React.useState(
        memory.graphView === 'global' || memory.graphView === 'ego' ? memory.graphView : 'dim',
      )
      const [graphUndirected, setGraphUndirected] = React.useState(memory.graphUndirected === true)
      const [graphDepth, setGraphDepth] = React.useState(memory.graphDepth === '2' ? '2' : '1')

      const selectTab = (id) => {
        setTabId(id)
        writeViewState(cwd, { tabId: id })
      }
      const focusIssue = (id) => {
        setFocusId(id)
        writeViewState(cwd, { focusId: id })
      }
      const clearFocus = () => {
        setFocusId(null)
        writeViewState(cwd, { focusId: null })
      }
      const selectMode = (id) => {
        setRelationMode(id)
        writeViewState(cwd, { relationMode: id })
      }
      /** 方向会换掉 mermaid 文本，是唯一允许重排的显式操作（方向本身不跟焦点走）。 */
      const selectDirection = (id) => {
        const value = id === 'TB' ? 'TB' : 'LR'
        setGraphDirection(value)
        writeViewState(cwd, { graphDirection: value })
      }
      /** 视图 / 无向关联 / 半径：都按仓库记忆。视图与半径会重排，无向开关也会（边的集合变了）。 */
      const selectView = (id) => {
        const value = id === 'global' || id === 'ego' ? id : 'dim'
        setGraphView(value)
        writeViewState(cwd, { graphView: value })
      }
      const toggleUndirected = (next) => {
        const value = next === true
        setGraphUndirected(value)
        writeViewState(cwd, { graphUndirected: value })
      }
      const selectDepth = (id) => {
        const value = id === '2' ? '2' : '1'
        setGraphDepth(value)
        writeViewState(cwd, { graphDepth: value })
      }
      /** 点同一行再点一次收起；同时只保留一个展开项。 */
      const toggleExpand = (next) => {
        const value = expanded !== null && expanded.kind === next.kind && expanded.id === next.id ? null : next
        setExpanded(value)
        writeViewState(cwd, { expanded: value })
      }

      React.useEffect(() => {
        if (cwd === '') {
          setState({ phase: 'no-workspace', payload: null, error: null })
          return undefined
        }
        const controller = new AbortController()
        const cached = snapshotCache.get(cwd)
        setState((previous) => {
          // 只在仓库没变时沿用上一份；换了仓库就不能拿旧仓的数据顶着
          const reusable = previous.payload?.repo === cwd ? previous.payload : (cached ?? null)
          return { phase: reusable === null ? 'loading' : 'ready', payload: reusable, error: null }
        })
        const url = `${FLOW_URL}?cwd=${encodeURIComponent(cwd)}`
        fetch(url, { credentials: 'same-origin', signal: controller.signal })
          .then(async (response) => {
            const text = await response.text()
            try {
              return { response, payload: JSON.parse(text) }
            } catch {
              throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
            }
          })
          .then(({ response, payload }) => {
            if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`)
            if (payload?.ok !== true) {
              setState({ phase: 'unavailable', payload, error: null })
              return
            }
            rememberSnapshot(cwd, payload)
            if (typeof console !== 'undefined' && typeof console.debug === 'function') {
              console.debug('[kiln] snapshot', payload.cache?.action ?? 'unknown', payload.generatedAt)
            }
            setState({ phase: 'ready', payload, error: null })
          })
          .catch((error) => {
            if (controller.signal.aborted) return
            setState({ phase: 'error', payload: null, error: String(error?.message ?? error) })
          })
        return () => controller.abort()
      }, [cwd, nonce])

      // 切焦点时收起“展开全部/弱关联”这类附属展开：焦点换了，展开的是另一批邻居
      React.useEffect(() => {
        setExpandedWeak(false)
        setExpandedChildren(false)
      }, [focusId])

      const payload = state.payload
      const issues = payload?.ok === true && Array.isArray(payload.issues) ? payload.issues : []
      const edges = payload?.ok === true && Array.isArray(payload.edges) ? payload.edges : []
      const byId = React.useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues])
      const missingFocus = focusId !== null && !byId.has(focusId)
      const focus = focusId !== null && byId.has(focusId) ? byId.get(focusId) : null

      const relations = React.useMemo(() => canonicalEdges(edges), [edges])
      const view = React.useMemo(() => (focus === null ? null : relatedOf(focus.id, relations)), [focus, relations])
      const scoped = React.useMemo(() => scopedIssues(issues, view), [issues, view])
      const rows = React.useMemo(() => sortActions(flattenActions(scoped)), [scoped])
      const issueList = React.useMemo(() => sortIssues(scoped, focus === null ? null : focus.id), [scoped, focus])
      const globalGroups = React.useMemo(() => globalRelationRows(relations), [relations])

      const refresh = () => setNonce((value) => value + 1)
      const totalOf = (issueId) => (Array.isArray(byId.get(issueId)?.actions) ? byId.get(issueId).actions.length : 0)

      const header = h(
        'div',
        { className: 'dkf-head' },
        h('span', { className: 'dkf-brand' }, 'kiln'),
        h(
          'span',
          {
            className: 'dkf-repo',
            title:
              payload?.ok === true
                ? `${cwd}\n快照：${payload.cache?.action ?? 'unknown'} · ${payload.generatedAt ?? ''}`
                : cwd,
          },
          payload?.ok === true ? `${basename(cwd)} · ${issues.length} issue` : basename(cwd),
        ),
        h('span', { className: 'dkf-spacer' }),
        focus !== null
          ? h(
              'button',
              {
                type: 'button',
                className: 'dkf-focuschip',
                onClick: clearFocus,
                title: '退出聚焦，回到全局（Esc）',
              },
              `焦点：${focus.id} ×`,
            )
          : null,
        h('button', { type: 'button', className: 'dkf-refresh', onClick: refresh }, '刷新'),
      )

      const tabs = payload?.ok === true ? h(PageTabs, { pages: PAGES, active: tabId, onSelect: selectTab, idBase }) : null

      let body = null
      if (state.phase === 'loading' && payload === null) {
        body = h('p', { className: 'dkf-note' }, '读取 kiln 快照…')
      } else if (state.phase === 'no-workspace') {
        body = h(
          'div',
          { className: 'dkf-error' },
          h('p', { className: 'dkf-error-title' }, '当前会话没有工作区路径'),
          h('p', { className: 'dkf-error-detail' }, 'Flow 以会话工作区为仓库根；请在一个 kiln 仓库里打开会话。'),
        )
      } else if (state.phase === 'error') {
        body = h(
          'div',
          { className: 'dkf-error' },
          h('p', { className: 'dkf-error-title' }, '读取失败'),
          h('p', { className: 'dkf-error-detail' }, state.error),
        )
      } else if (state.phase === 'unavailable') {
        const reason = payload?.reason
        const detail =
          {
            'not-kiln-repo': '这个工作区不是 kiln 仓库（缺 .kilnconfig.jsonc）。以仓库根目录打开会话后再看。',
            'kiln-missing': '宿主进程里找不到 kiln 可执行文件。把 kiln 放进 PATH，或设置 DSH_KILN_BIN。',
            'kiln-error': payload?.message ?? 'kiln 命令失败。',
            'invalid-dir': '工作区路径无效。',
          }[reason] ?? `未知原因：${reason ?? 'unknown'}`
        body = h(
          'div',
          { className: 'dkf-error' },
          h('p', { className: 'dkf-error-title' }, 'Flow 暂不可用'),
          h('p', { className: 'dkf-error-detail' }, detail),
          h('p', { className: 'dkf-error-detail' }, cwd),
        )
      } else {
        let content = null
        if (tabId === 'timeline') {
          content = h(TimelinePanel, {
            rows,
            totalOf,
            expanded,
            onToggle: toggleExpand,
            onFocus: focusIssue,
            emptyText: focus === null ? '还没有任何 kiln 动作。' : '焦点与相关 issue 还没有动作。',
          })
        } else if (tabId === 'issue') {
          content = h(IssuePanel, {
            issues: issueList,
            focusId: focus === null ? null : focus.id,
            expanded,
            onToggle: toggleExpand,
            onFocus: focusIssue,
            emptyText: focus === null ? '这个仓库还没有 issue。' : '焦点与相关 issue 为空。',
          })
        } else {
          content = h(RelationPanel, {
            focus,
            view,
            byId,
            groups: globalGroups,
            mode: relationMode,
            direction: graphDirection,
            graphView,
            undirected: graphUndirected,
            depth: graphDepth,
            issues,
            relations,
            focusId: focus === null ? null : focus.id,
            expanded,
            expandedWeak,
            expandedChildren,
            onToggle: toggleExpand,
            onFocus: focusIssue,
            onMode: selectMode,
            onDirection: selectDirection,
            onView: selectView,
            onUndirected: toggleUndirected,
            onFocusDepth: selectDepth,
            onToggleWeak: () => setExpandedWeak((value) => !value),
            onToggleChildren: () => setExpandedChildren((value) => !value),
          })
        }

        body = h(
          React.Fragment,
          null,
          missingFocus
            ? h(
                'p',
                { className: 'dkf-warn' },
                `焦点 ${focusId} 不在本次快照里（可能被截断或已消失）。`,
                h('button', { type: 'button', className: 'dkf-toggle', onClick: clearFocus }, ' 回到全局'),
              )
            : null,
          payload?.truncated === true
            ? h('p', { className: 'dkf-note' }, `共 ${payload.total ?? issues.length} 条 issue，只展示前 ${issues.length} 条。`)
            : null,
          h(
            'div',
            {
              className: 'dkf-panel',
              id: `${idBase}-panel`,
              role: 'tabpanel',
              'aria-labelledby': `${idBase}-tab-${tabId}`,
            },
            content,
          ),
        )
      }

      return h(
        'div',
        {
          className: 'dkf-root',
          onKeyDown: (event) => {
            if (event.key === 'Escape' && focus !== null) {
              event.preventDefault()
              clearFocus()
            }
          },
        },
        header,
        tabs,
        h('div', { className: 'dkf-scroll' }, body),
      )
    }

    const inject = ['slots', 'sessions']

    function apply(ctx) {
      ensureStyle()
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'kiln',
            order: 30,
            label: () => 'kiln',
            inject: (sessionId) => {
              const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
              return { cwd: summary?.cwd ?? '' }
            },
          },
          KilnView,
        ),
      )
    }

    return { name: '@local/dsh-kiln', inject, apply }
  },
})
