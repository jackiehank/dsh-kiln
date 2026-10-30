/**
 * Client half：在会话顶部标签排（对话 / 轨迹 / 上下文）末尾加一个 `kiln` 标签。
 *
 * 标签内是三个平级页面，共用同一个焦点 issue：
 *   timeline —— 一行一个 action，按时间倒序（只算带 issue: + action: 的提交）
 *   issue    —— 无焦点：一行一个 issue，按最近动作排序；有焦点：读出焦点周围的**结构**
 *               （母 / 子 / 阻塞 / 因果 / 取代 / 弱关联，行内带关系名与方向）
 *   relation —— 关系图（mermaid + Pele），全局与聚焦两种取景
 *
 * 交互约定（三页一致）：
 *   · 点行 = 展开（issue 展开它的 action 列表；timeline 展开这条提交的详情）
 *   · 行尾 `⌖ 聚焦` = 切焦点；头部 `焦点：x ×` / Esc = 退出聚焦
 *   · 列表内方向键走行、Enter 展开、f 聚焦
 *   · 图上点节点 = 聚焦（节点没有“第二层”可展开，这是三页里唯一的手势差异）
 *
 * 焦点、展开项与当前页都只存在内存里（按仓库）：切页会卸载视图，靠这份内存把状态接回来；
 * 刷新页面即清空，不进 URL。数据按视图取：动作流 `/kiln/timeline`、关系图 `/kiln/graph`、
 * 详情 `/kiln/issue`、搜索 `/kiln/search`、词表 `/kiln/actions`。
 */
window.__ModuleLoader__.load({
  id: '@jackiehank/dsh-kiln',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STYLE_ID = 'dsh-kiln-flow-style'
    const GRAPH_URL = '/kiln/graph'
    const ISSUE_URL = '/kiln/issue'
    const SEARCH_URL = '/kiln/search'
    const TIMELINE_URL = '/kiln/timeline'
    const ACTIONS_URL = '/kiln/actions'
    /** 搜索走宿主 → kiln；输入停 120ms 再发，连击只留最后一轮。 */
    const SEARCH_DEBOUNCE_MS = 120
    /** 时间线边收边渲染：最多 20fps，350 行动作不会把 React 刷 350 次。 */
    const TIMELINE_FLUSH_MS = 50
    /**
     * 虚拟列表：只挂“可视区 ± overscan”的行，其余用上下 spacer 撑高度。
     * 未测量的行按 ROW_ESTIMATE 估；挂出来之后按真实高度修正（见 measureRows）。
     * overscan 取 600px（约 20 行），快速滚动时不会立刻看到空白。
     */
    const ROW_ESTIMATE = 30
    const VIRTUAL_OVERSCAN = 600
    const VIRTUAL_MIN_VIEWPORT = 480
    const EMPTY_SEARCH = { query: '', rows: [], pending: false, ms: 0, count: 0, error: null }
    const EMPTY_TIMELINE = { rows: [], phase: 'idle', error: null, ms: 0, count: 0 }
    const EMPTY_GRAPH = { phase: 'idle', payload: null, error: null }
    const EMPTY_DETAIL = { id: null, phase: 'idle', issue: null, error: null }
    /** 动作词表按仓库缓存：一次进程、不读历史，重挂载不重取。 */
    const actionsCache = new Map()
    /**
     * 会话内取数缓存：键都带仓库，刷新（nonce）才整体失效。
     *
     * 插件是只读视图，失效模型本来就是“刷新才更新”（动作流也只在 mount/刷新时重读），
     * 所以图 / 详情 / 搜索在会话内复用；不跨刷新，也不落盘。
     */
    const graphCache = new Map()
    /** 页签预取与切页可能同时发：同一仓库只发一次。 */
    const graphInflight = new Map()
    const detailCache = new Map()
    /** 预取与点击可能同时发生：同一 (repo,id) 只发一次。 */
    const detailInflight = new Map()
    const searchCache = new Map()
    const CACHE_LIMIT = 20
    /**
     * 动作流行缓存（0.11.0）：按仓库记住「这份行对应哪个 HEAD」。
     *
     * 切页 / 换会话时先拿它渲染，再带 `?head=` 去问宿主：HEAD 没变就一个字节都不传
     * （宿主回 `x-kiln-mode: unchanged`）。上限见下——12 万行 / 32MB 单仓、总预算 64MB，
     * 超了不存或按 LRU 挤掉，退回每次流式（大仓在浏览器里再留一份不划算）。
     */
    const timelineCache = new Map()
    /**
     * 上限与宿主同一口径：12 万行 / 32MB 单仓，**两端总预算 64MB**（= 32MB × 2 仓）。
     * 超了不存（大仓不划算）或按 LRU 挤掉最久没用的仓——不留给用户配。
     */
    const TIMELINE_CACHE_ROWS = 120_000
    const TIMELINE_CACHE_BYTES = 32 * 1024 * 1024
    const TIMELINE_CACHE_REPOS = 2
    const TIMELINE_CACHE_TOTAL_BYTES = 64 * 1024 * 1024

    /**
     * 记一份动作流（只在流完整读完时调用）。
     * 返回是否真的留下——超限时静默不留，页面照常工作。
     */
    function rememberTimeline(cwd, head, rows, bytes, pool) {
      timelineCache.delete(cwd)
      if (typeof head !== 'string' || head === '') return false
      if (!Array.isArray(rows) || rows.length > TIMELINE_CACHE_ROWS) return false
      if (!Number.isFinite(bytes) || bytes > TIMELINE_CACHE_BYTES) return false
      timelineCache.set(cwd, { head, rows, bytes, pool: pool instanceof Map ? pool : null })
      const total = () => {
        let sum = 0
        for (const entry of timelineCache.values()) if (Number.isFinite(entry.bytes)) sum += entry.bytes
        return sum
      }
      while (timelineCache.size > TIMELINE_CACHE_REPOS) timelineCache.delete(timelineCache.keys().next().value)
      // 单仓都很小、仓数多起来时乘法会顶到这里；留最后一份，别把自己也挤掉
      while (timelineCache.size > 1 && total() > TIMELINE_CACHE_TOTAL_BYTES) {
        timelineCache.delete(timelineCache.keys().next().value)
      }
      return true
    }

    /**
     * 增量响应（`delta`）要和手上那份拼起来：新行在前，旧行里去掉重复的 sha。
     * 按 sha（不是日期）去重——同秒多条的先后顺序只有 sha 能定。
     */
    function mergeTimelineRows(newer, older) {
      const head = Array.isArray(newer) ? newer : []
      if (!Array.isArray(older) || older.length === 0) return head.slice()
      const known = new Set(head.map((row) => rowCommit(row)))
      return head.concat(older.filter((row) => !known.has(rowCommit(row))))
    }
    /** hover 预取的延迟：太短会在扫过列表时把每一行都取一遍。 */
    const PREFETCH_MS = 120

    /** 缓存键：仓库与标识之间用 NUL 分隔，id 里不可能出现。 */
    function cacheKey(scope, id) {
      return `${scope}\u0000${id}`
    }

    /** 读缓存并把命中的键挪到末尾（LRU）；未命中返回 undefined。 */
    function cacheGet(map, key) {
      if (!map.has(key)) return undefined
      const value = map.get(key)
      map.delete(key)
      map.set(key, value)
      return value
    }

    function cacheSet(map, key, value, limit = CACHE_LIMIT) {
      if (map.has(key)) map.delete(key)
      map.set(key, value)
      while (map.size > limit) map.delete(map.keys().next().value)
    }

    /** 刷新时清掉一个仓库的会话缓存（词表与动作流也在内：刷新就该拿到真数据）。 */
    function clearRepoCaches(cwd) {
      graphCache.delete(cwd)
      graphInflight.delete(cwd)
      actionsCache.delete(cwd)
      timelineCache.delete(cwd)
      const prefix = `${cwd}\u0000`
      for (const key of [...detailCache.keys()]) if (key.startsWith(prefix)) detailCache.delete(key)
      for (const key of [...detailInflight.keys()]) if (key.startsWith(prefix)) detailInflight.delete(key)
      for (const key of [...searchCache.keys()]) if (key.startsWith(prefix)) searchCache.delete(key)
    }

    /** NDJSON 按行切：chunk 不保证按行到，半行留到下一块（与宿主 timeline.js 同一套规则）。 */
    function createLineSplitter() {
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
     * 动作行的形状：7 槽数组，与宿主 `timeline.js` 的 `ROW` 一一对应。
     *
     * 宿主发出来的行就是这个数组（`?format=2`），客户端 parse 完直接存——不再建对象。
     * 下标只从 `ROW` 取；读字段一律走下面几个函数，避免 `row[1]` 写错槽还能静默跑。
     */
    const ROW = Object.freeze({ ISSUE: 0, ACTION: 1, COMMIT: 2, DATE: 3, TITLE: 4, DOMAIN: 5, TAGS: 6 })
    const TAGS_SEPARATOR = '\u0001'
    /** 空标签的共享数组：折叠时 86% 的行没有标签，不该每行造一个空数组。 */
    const NO_TAGS = Object.freeze([])
    /** 行形状的版本号：2 = 7 槽数组。宿主不带它就 400，让旧页面刷新而不是静默空列表。 */
    const TIMELINE_FORMAT = 2
    const rowIssue = (row) => (typeof row[ROW.ISSUE] === 'string' ? row[ROW.ISSUE] : '')
    const rowAction = (row) => (typeof row[ROW.ACTION] === 'string' ? row[ROW.ACTION] : '')
    const rowCommit = (row) => (typeof row[ROW.COMMIT] === 'string' ? row[ROW.COMMIT] : '')
    const rowDate = (row) => (typeof row[ROW.DATE] === 'string' ? row[ROW.DATE] : '')
    const rowTitle = (row) => (typeof row[ROW.TITLE] === 'string' ? row[ROW.TITLE] : '')
    const rowDomain = (row) => (typeof row[ROW.DOMAIN] === 'string' ? row[ROW.DOMAIN] : '')
    const rowShort = (row) => rowCommit(row).slice(0, 7)
    const rowTags = (row) => {
      const tags = row[ROW.TAGS]
      return typeof tags === 'string' && tags !== '' ? tags.split(TAGS_SEPARATOR) : []
    }
    /** 驻留：issueId/action/domain 在整条流里重复，共享同一批字符串（实测省约 108B/行）。 */
    const createRowInterner = (shared) => {
      const pool = shared instanceof Map ? shared : new Map()
      const intern = (value) => {
        if (typeof value !== 'string' || value === '') return value ?? ''
        const hit = pool.get(value)
        if (hit !== undefined) return hit
        pool.set(value, value)
        return value
      }
      return {
        pool,
        intern(row) {
          row[ROW.ISSUE] = intern(row[ROW.ISSUE])
          row[ROW.ACTION] = intern(row[ROW.ACTION])
          row[ROW.DOMAIN] = intern(row[ROW.DOMAIN])
          return row
        },
      }
    }

    /** 关系词表：宿主只回原始边，方向与强弱在这里推导（不在宿主判断“什么算重要”）。 */
    const INVERSE = {
      'has-part': 'part-of',
      'blocked-by': 'blocks',
      'superseded-by': 'supersedes',
      causes: 'caused-by',
    }
    /**
     * 关系按**方向**分桶，每桶一句中文。`dir` 说的是焦点站在哪一头：
     * `out` = 数据里 `a 关系 b` 的 a（焦点是主语），`in` = b（焦点是宾语）。
     *
     * 这是**展示表**，不是业务判断：方向由 `a/b` 与焦点的比较得出，文案按 `(rel, dir)` 查表，
     * 没有按关系名写的 `if`——词表外再多一种关系，缺的是一行文案，不是新分支。
     * 文案不再写「我」：焦点行就在这组行的正上方，方向靠语态承担（父 / 子、由…引发 / 引发了…），
     * 计数 `{n}` 写进句子里，于是行内不需要箭头，也不需要 `part-of` 这类原词
     * （见 docs/issues/kiln-relation-direction.md）。
     *
     * 顺序即渲染顺序：沿用旧的强弱次序 part-of → blocks → supersedes → caused-by → relates-to。
     * `foldable`：这一桶可能很长（伞 issue 的子 issue），超过 4 条先折叠。
     */
    const REL_SIDES = [
      { rel: 'part-of', dir: 'out', text: '{n} 个父 issue' },
      { rel: 'part-of', dir: 'in', text: '{n} 个子 issue', foldable: true },
      { rel: 'blocks', dir: 'out', text: '阻塞了 {n} 个 issue' },
      { rel: 'blocks', dir: 'in', text: '被 {n} 个 issue 阻塞' },
      { rel: 'supersedes', dir: 'out', text: '取代了 {n} 个 issue' },
      { rel: 'supersedes', dir: 'in', text: '被 {n} 个 issue 取代' },
      { rel: 'caused-by', dir: 'out', text: '由 {n} 个 issue 引发' },
      { rel: 'caused-by', dir: 'in', text: '引发了 {n} 个 issue' },
      { rel: 'relates-to', dir: 'none', text: '{n} 个弱关联（无方向）' },
    ].map((side) => ({ ...side, key: `${side.rel}|${side.dir}` }))
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
    /**
     * 筛的两个维度。来源只有快照里已有的字段：domain / done。
     * 标签不做：它是动作级的 trailer，视图只拿得到 issue 级并集，而且一个仓动辄十几个标签，
     * 一行 chips 根本装不下（kiln-issue-filter 的"去掉标签筛选"一节）。
     * 顺序是"越常用越靠左"；某组在本仓没有可选项时整组不渲染（见 issueFacets）。
     */
    const FILTER_GROUPS = [
      { id: 'domains', label: '领域' },
      { id: 'states', label: '状态' },
    ]
    /** 时间线的筛选组：动作名 + 算在动作头上的领域。 */
    const ROW_FILTER_GROUPS = [
      { id: 'actions', label: '动作' },
      { id: 'domains', label: '领域' },
    ]
    const FILTER_STATE_LABEL = { open: '进行中', done: '已完成' }
    /**
     * 边的线型阶梯：结构性强 → 弱，墨越来越轻。
     * 用 \`linkStyle\` 写死 dasharray / 线宽，而不是靠端点标识——多条线汇到一个节点时，
     * 端点标识会叠在一起（见 docs/issues/kiln-graph-label-threshold.md）。
     */
    const EDGE_STROKE = {
      'part-of': 'stroke-width:3.4px',
      blocks: 'stroke-width:1.6px',
      'caused-by': 'stroke-width:1.6px,stroke-dasharray:10 5',
      supersedes: 'stroke-width:1.6px,stroke-dasharray:9 3 2 3',
      'relates-to': 'stroke-width:1.3px,stroke-dasharray:2 5',
    }
    /**
     * 图例的文案一律写成「A 动词 B」——箭头从 A 指向 B。
     * 注意 caused-by：数据里是“A 由 B 引发”，为了让箭头和句子同向（因果图惯例：因 → 果），
     * 画的时候反过来（B → A），于是图例这句就是「A 引发 B」。
     */
    const EDGE_LEGEND = [
      { rel: 'part-of', sentence: 'A 是 B 的一部分' },
      { rel: 'blocks', sentence: 'A 阻塞 B' },
      { rel: 'caused-by', sentence: 'A 引发 B' },
      { rel: 'supersedes', sentence: 'A 取代 B' },
      { rel: 'relates-to', sentence: 'A 与 B 相关' },
    ]
    /** 布局方向：侧栏是竖的，`TB` 常常比 `LR` 更省横向空间。 */
    const GRAPH_DIRECTIONS = [
      { id: 'LR', label: '横向' },
      { id: 'TB', label: '纵向' },
    ]
    /**
     * 三种**视图**（不是两个可自由组合的维度）——参考 Obsidian 的“全局图 / 局部图”与
     * Gephi 的 ego 过滤：工具给的是一组有名字的视图，而不是旋钮的笛卡尔积。
     *   · `global`  整张图 + 淡化焦点圈外（无焦点时就是整张图）；
     *   · `focus`   以焦点为中心重画，只画 `depth` 跳内的邻域，换焦点即重排。
     */
    const GRAPH_VIEWS = [
      { id: 'global', label: '全局' },
      { id: 'focus', label: '聚焦' },
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
    const EMPTY_FILTERS = { domains: [], states: [] }
    const EMPTY_VIEW_STATE = {
      tabId: 'timeline',
      focusId: null,
      expanded: null,
      graphDirection: 'LR',
      graphView: 'global',
      graphDepth: '1',
      filters: EMPTY_FILTERS,
      rowFilters: { actions: [], domains: [] },
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

    /** 展开项的键：优先用提交 sha；空提交退化成 issue#时间，避免多条空 sha 互相顶掉。 */
    function actionKey(row) {
      const commit = rowCommit(row)
      return commit !== '' ? commit : `${rowIssue(row)}#${rowDate(row)}`
    }

    const CSS = `
/* 设计语言的唯一出处：具体值只写在这里，其余规则一律引用变量。
   字号取宿主台阶（11 / 12 / 13），圆角取 --dsw-radius-*（4 / 8 / 12），
   颜色取语义 token（label / border / bg / interactive / state），不写裸色。 */
.dkf-root{
  --dkf-fs-meta:11px;--dkf-lh-meta:16px;
  --dkf-fs-body:12px;--dkf-lh-body:18px;
  --dkf-fs-em:13px;--dkf-lh-em:20px;
  --dkf-r:var(--dsw-radius-xs,4px);
  --dkf-r-box:var(--dsw-radius-sm,8px);
  --dkf-r-float:var(--dsw-radius-md,12px);
  --dkf-fg:var(--dsw-alias-label-primary,#1f1f1f);
  --dkf-fg2:var(--dsw-alias-label-secondary,#5c5c5c);
  --dkf-fg3:var(--dsw-alias-label-tertiary,#8c8c8c);
  --dkf-line:var(--dsw-alias-border-l2,#0000001a);
  --dkf-line-2:var(--dsw-alias-border-l3,#00000029);
  --dkf-bg:var(--dsw-alias-bg-layer-1,#fff);
  --dkf-bg2:var(--dsw-alias-bg-layer-2,#f7f7f7);
  --dkf-raise:var(--dsw-alias-bg-layer-3,#fff);
  --dkf-hover:var(--dsw-alias-interactive-bg-hover,#2631480f);
  /* 唯一的一层 hover 底色：鼠标经过与「当前选中行」共用它 */
  --dkf-hover-layer:linear-gradient(var(--dkf-hover),var(--dkf-hover));
  --dkf-accent:var(--dsw-alias-state-business-primary,#4176e6);
  --dkf-ok:var(--dsw-alias-state-success-primary,#35a35f);
  --dkf-warn:var(--dsw-alias-state-warn-primary,#b4690e);
  --dkf-mono:var(--ds-font-family-code,ui-monospace,Menlo,monospace);
  --dkf-sans:var(--dsw-font-family,inherit);
  display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;
  background:var(--dkf-bg);color:var(--dkf-fg);
  font-family:var(--dkf-sans);font-size:var(--dkf-fs-body);line-height:var(--dkf-lh-body);
}
/* 键盘焦点：三页一套，与宿主 focus ring 同宽 */
.dkf-tab:focus-visible,.dkf-modebtn:focus-visible,.dkf-refresh:focus-visible,.dkf-focuschip:focus-visible,.dkf-toggle:focus-visible,.dkf-focusbtn:focus-visible,.dkf-filterbtn:focus-visible,.dkf-filter-clear:focus-visible{box-shadow:inset 0 0 0 2px var(--dkf-accent)}
/*
 * hover 只有一套说法：在“当前底色”上叠一层 --dkf-hover。
 * 用 background-image 叠而不是 background-color，是因为它不覆盖已有底色——
 * 焦点行本来就铺了 bg-layer-2，换成 background-color 会把它“顶掉”，
 * 以前那条 .dkf-focus:hover{background:bg2} 等于没有反馈，就是这么来的。
 * 可点控件的文字顺带提到 primary；行不需要（标题本来就是 primary）。
 * 不做过渡：这类即时反馈在宿主里也是直接切（图上的 .12s 只给淡化/焦点那种状态变化）。
 */
.dkf-refresh:hover,.dkf-focuschip:hover,.dkf-tab:hover,.dkf-modebtn:hover,.dkf-row:hover,.dkf-focus:hover,.dkf-subrow:hover,.dkf-arow:hover,.dkf-toggle:hover,.dkf-focusbtn:hover,.dkf-filterbtn:hover,.dkf-filter-clear:hover,.dkf-hit:hover{background-image:var(--dkf-hover-layer)}
.dkf-refresh:hover,.dkf-focuschip:hover,.dkf-tab:hover,.dkf-modebtn:hover,.dkf-toggle:hover,.dkf-focusbtn:hover,.dkf-filterbtn:hover,.dkf-filter-clear:hover,.dkf-hit:hover{color:var(--dkf-fg)}
/* 页头第一层：三栏网格——左右两栏等宽，搜索框因此是**真居中**（不是"剩下的空白居中"）。
   窄宽下两侧等比变窄；搜索框的**偏好宽度只有 30%**（上限 360、地板 72），它先让位，
   把空间留给右侧的焦点 chip。container-type:inline-size 让分档跟着**头部自己的宽度**走
   （拖侧栏也生效，媒体查询不行）。 */
.dkf-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(72px,min(360px,30%)) minmax(0,1fr);align-items:center;gap:8px;padding:0 12px;min-height:34px;border-bottom:.5px solid var(--dkf-line);flex:none;container-type:inline-size;overflow:hidden}
.dkf-repo{font-size:var(--dkf-fs-body);line-height:var(--dkf-lh-body);font-weight:600;color:var(--dkf-fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
/* 右侧动作区：一条 flex 行，**只有 chip 允许收缩**（flex:0 1 auto），刷新固定不缩（flex:0 0 auto）——
   刷新的右边缘因此永远是页头右边界，有没有 chip 都落同一处。
   溢出的兜底是 overflow:hidden：chip 一旦订到自己的最小宽度就裁边，绝不外溢到搜索框上。 */
.dkf-head-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0;overflow:hidden}
/* 搜索框：占满中间那栏。box-sizing:border-box 不能省——输入框是 content-box，
   少了它 width:100% + 左右各 8px 内边距就会比轨道宽 16px，那 16px 正好画在第三列上（压叠的根因）。 */
.dkf-search{width:100%;min-width:0;box-sizing:border-box;height:22px;padding:0 8px;border:0;border-radius:var(--dkf-r);background:var(--dkf-bg2);color:var(--dkf-fg);box-shadow:inset 0 0 0 .5px var(--dkf-line);font-family:var(--dkf-sans);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-search::placeholder{color:var(--dkf-fg3)}
.dkf-search:focus{outline:none;box-shadow:inset 0 0 0 2px var(--dkf-accent)}
/* 搜索结果：两行——第一行是"哪个 issue"，第二行是"为什么命中"（issue 名 or 某条动作的标题） */
.dkf-hit{display:flex;flex-direction:column;gap:2px;padding:4px 6px;border-radius:var(--dkf-r);cursor:pointer;min-width:0}
.dkf-hit-head{display:flex;align-items:center;gap:6px;min-width:0}
.dkf-hit-head .dkf-hit-go{margin-left:auto}
.dkf-hit-body{display:flex;align-items:baseline;gap:6px;min-width:0}
.dkf-hit-title{color:var(--dkf-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
/* 命中 issue 名时，第二行是"这条 issue 现在在干什么"，只作背景，不做高亮主角 */
.dkf-hit-title-quiet{color:var(--dkf-fg2)}
.dkf-hit-meta{color:var(--dkf-fg3);margin-left:auto;flex:none;white-space:nowrap;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
/* 选中一行：就是"鼠标经过"那层底色常驻，和 issue 行同一套观感，不加额外强调 */
.dkf-hit-on{background-image:var(--dkf-hover-layer)}
.dkf-hit-go{color:var(--dkf-fg3);flex:none;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-hl{color:var(--dkf-fg);border-radius:var(--dkf-r);background:color-mix(in srgb,var(--dkf-accent) 18%,transparent)}
.dkf-refresh,.dkf-focuschip{all:unset;cursor:pointer;display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:var(--dkf-r);color:var(--dkf-fg2);white-space:nowrap;font-family:var(--dkf-sans);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
/* chip 拆三段：只有 label（issue id）参与省略，× 是独立元素、永远完整——它是关闭的唯一标识。
   chip 是这条行里**唯一允许被压**的东西：它先收缩、再让 label 省略，盒子永远不出自己的格子，
   所以左边不会被谁裁掉。 */
.dkf-focuschip{font-family:var(--dkf-mono);color:var(--dkf-fg);box-shadow:inset 0 0 0 .5px var(--dkf-line-2);max-width:320px;min-width:0;flex:0 1 auto;overflow:hidden}
.dkf-focuschip-prefix{flex:none}
.dkf-focuschip-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dkf-focuschip-x{flex:none;margin-left:4px;color:var(--dkf-fg3)}
/* 刷新不参与伸缩：宽度只由内容决定，位置由右边界决定 */
.dkf-refresh{flex:0 0 auto}
.dkf-refresh-label{flex:none}
.dkf-refresh-icon{display:none;flex:none;font-family:var(--dkf-mono)}
/* 两档收缩：先砍长期不变的信息（仓库名、chip 前缀），再砍低频动作的文字（刷新）。
   700 这一档是按 dsh-desktop 的最窄宽度定的（窗口 652 → 头部内容宽 628），窄到这里就只留字形。 */
@container (max-width:520px){.dkf-repo{max-width:72px}.dkf-focuschip-prefix{display:none}}
@container (max-width:700px){.dkf-refresh-label{display:none}.dkf-refresh-icon{display:inline}}
/* 页头第二层：左页切换、右当前页计数或工具，三页同高同排 */
.dkf-bar{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;padding:4px 12px;min-height:36px;border-bottom:.5px solid var(--dkf-line);flex:none}
.dkf-tabs{display:inline-flex;align-items:center;gap:2px;padding:2px 0;flex:none}
.dkf-tab{all:unset;cursor:pointer;display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:var(--dkf-r);color:var(--dkf-fg2);font-family:var(--dkf-sans);font-size:var(--dkf-fs-body);line-height:var(--dkf-lh-body)}
.dkf-tab-active{background:var(--dkf-bg2);color:var(--dkf-fg);font-weight:600;box-shadow:inset 0 0 0 .5px var(--dkf-line)}
.dkf-bar-tools{display:flex;align-items:center;gap:6px;margin-left:auto;min-width:0}
.dkf-count{color:var(--dkf-fg3);white-space:nowrap;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-mode{display:inline-flex;align-items:center;gap:2px}
.dkf-modebtn{all:unset;cursor:pointer;display:inline-flex;align-items:center;height:22px;padding:0 6px;border-radius:var(--dkf-r);color:var(--dkf-fg3);font-family:var(--dkf-sans);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-modebtn-active{background:var(--dkf-bg2);color:var(--dkf-fg);font-weight:600;box-shadow:inset 0 0 0 .5px var(--dkf-line)}
.dkf-bar-tools .dkf-mode+.dkf-mode{padding-left:6px;box-shadow:inset 1px 0 0 var(--dkf-line)}
/* 筛选条：与页栏同材质；chip 的“选中”沿用全站那一条（bg2 + 600 + 0.5px 内描边） */
.dkf-filters{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;padding:6px 12px;border-bottom:.5px solid var(--dkf-line);flex:none}
.dkf-filter-group{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0}
.dkf-filter-label{color:var(--dkf-fg3);margin-right:2px;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-filterbtn{all:unset;cursor:pointer;display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:var(--dkf-r);color:var(--dkf-fg2);white-space:nowrap;box-shadow:inset 0 0 0 .5px var(--dkf-line);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-filterbtn-on{background:var(--dkf-bg2);color:var(--dkf-fg);font-weight:600;box-shadow:inset 0 0 0 .5px var(--dkf-line-2)}
.dkf-filter-clear{all:unset;cursor:pointer;color:var(--dkf-fg3);margin-left:auto;padding:0 6px;border-radius:var(--dkf-r);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
/* 内容区：唯一可滚动的地方 */
.dkf-scroll{flex:1;min-height:0;overflow:auto;padding:8px 8px 32px}
.dkf-note{color:var(--dkf-fg2);margin:0 0 8px;padding:0 4px;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-warn{color:var(--dkf-warn);margin:0 0 8px;padding:0 4px;font-size:var(--dkf-fs-body);line-height:var(--dkf-lh-body)}
.dkf-error{margin:8px 4px;padding:10px 12px;border-radius:var(--dkf-r-box);background:var(--dkf-bg2);box-shadow:inset 0 0 0 .5px var(--dkf-line)}
.dkf-error-title{margin:0 0 4px;font-size:var(--dkf-fs-em);line-height:var(--dkf-lh-em);font-weight:600}
.dkf-error-detail{margin:0;color:var(--dkf-fg2);word-break:break-all;font-family:var(--dkf-mono);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-empty{color:var(--dkf-fg3);margin:8px 4px;font-size:var(--dkf-fs-body);line-height:var(--dkf-lh-body)}
.dkf-empty p{margin:0 0 4px}
.dkf-empty p:last-child{margin:0}
/* 虚拟列表：行外壳（测量高度用）与上下占位 */
.dkf-vitem{display:block;min-width:0}
.dkf-vspacer{flex:none;width:100%}
/* 列表：三页共用同一套列宽，同名列落在同一 x */
.dkf-list{display:flex;flex-direction:column;outline:none;position:relative}
/* 竖脊：时间线的“有序”由这一条线承担，色点压在线上 */
.dkf-rail::before{content:'';position:absolute;left:12px;top:12px;bottom:12px;width:1px;background:var(--dkf-line)}
.dkf-row{display:grid;grid-template-columns:auto 10px auto auto minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:4px 6px;border-radius:var(--dkf-r);min-width:0;outline:none}
.dkf-row:focus-visible,.dkf-arow:focus-visible{box-shadow:inset 0 0 0 2px var(--dkf-accent)}
.dkf-focus{background:var(--dkf-bg2);box-shadow:inset 0 0 0 .5px var(--dkf-line)}
.dkf-clickable{cursor:pointer}
.dkf-indent{margin-left:18px}
.dkf-strip{display:inline-flex;gap:1px;align-items:center}
.dkf-block{width:3px;height:11px;border-radius:1px;background:var(--dkf-fg3);opacity:.55}
.dkf-block-current{height:13px;opacity:1}
.dkf-caret{color:var(--dkf-fg3);width:10px;text-align:center;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-id{font-family:var(--dkf-mono);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta);font-weight:500;color:var(--dkf-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.dkf-badges{display:inline-flex;gap:4px;align-items:center;flex:none}
.dkf-chip{padding:0 4px;border-radius:var(--dkf-r);color:var(--dkf-fg2);white-space:nowrap;box-shadow:inset 0 0 0 .5px var(--dkf-line);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-chip-done{color:var(--dkf-ok);box-shadow:inset 0 0 0 .5px currentColor}
.dkf-chip-action{color:var(--dkf-row-color,var(--dkf-fg2))}
.dkf-title{color:var(--dkf-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dkf-fs-body);line-height:var(--dkf-lh-body)}
.dkf-ago{color:var(--dkf-fg3);white-space:nowrap;font-variant-numeric:tabular-nums;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-focusbtn{all:unset;cursor:pointer;color:var(--dkf-fg3);white-space:nowrap;padding:0 5px;border-radius:var(--dkf-r);opacity:0;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-row:hover .dkf-focusbtn,.dkf-row:focus-within .dkf-focusbtn,.dkf-arow:hover .dkf-focusbtn,.dkf-arow:focus-within .dkf-focusbtn{opacity:1}
.dkf-focusbtn:focus-visible{opacity:1}
.dkf-afaint{color:var(--dkf-fg3);white-space:nowrap;padding:0 5px;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta);opacity:.7}
/* 时间线：一行一个动作，点色 = 动作色 */
.dkf-arow{position:relative;display:grid;grid-template-columns:12px auto auto minmax(0,1fr) auto auto auto;align-items:center;gap:8px;padding:4px 6px;border-radius:var(--dkf-r);min-width:0;outline:none;cursor:pointer}
.dkf-abar{width:7px;height:7px;border-radius:50%;justify-self:center;position:relative;z-index:1;background:var(--dkf-row-color,var(--dkf-fg3))}
.dkf-aissue{font-family:var(--dkf-mono);color:var(--dkf-fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:22ch;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-achip{color:var(--dkf-row-color,var(--dkf-fg2));white-space:nowrap;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-atitle{color:var(--dkf-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dkf-fs-body);line-height:var(--dkf-lh-body)}
.dkf-ashort{font-family:var(--dkf-mono);color:var(--dkf-fg3);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
/* 展开层：动作历史与提交详情，缩进到标题列 */
.dkf-sub{margin:2px 0 6px 34px;padding:2px 0 2px 10px;border-left:1px solid var(--dkf-line);display:flex;flex-direction:column;gap:1px}
.dkf-subrow{display:grid;grid-template-columns:12px auto minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:2px 6px;border-radius:var(--dkf-r)}
.dkf-subrow .dkf-abar{width:5px;height:5px}
.dkf-detail{margin:2px 6px 8px 34px;padding:2px 0 2px 10px;border-left:1px solid var(--dkf-line);display:flex;flex-direction:column;gap:2px;color:var(--dkf-fg2);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-detail-key{display:inline-block;min-width:44px;color:var(--dkf-fg3)}
.dkf-detail code{font-family:var(--dkf-mono);color:var(--dkf-fg);word-break:break-all;font-size:var(--dkf-fs-meta)}
.dkf-panel{display:flex;flex-direction:column;min-height:0}
/* 分组：靠字号与留白分组，不画线 */
.dkf-group{margin:12px 0 0}
.dkf-group-head{display:flex;align-items:center;gap:6px;color:var(--dkf-fg3);font-weight:600;margin:0 0 4px;padding:0 6px;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-toggle{all:unset;cursor:pointer;color:var(--dkf-fg2);padding:0 4px;border-radius:var(--dkf-r);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
/* 关系图：图框去外边框，图例压成一行 */
.dkf-graphwrap{display:flex;flex-direction:column;gap:8px;min-width:0}
.dkf-graph{border-radius:var(--dkf-r-box);background:var(--dkf-bg2);box-shadow:inset 0 0 0 .5px var(--dkf-line);padding:8px;overflow:hidden;min-height:260px}
.dkf-graph svg{display:block;max-width:100%;height:auto}
/*
 * Pele 在自己生成的 SVG 上写死了一套浅色默认值（白底、近黑的线），且不看主题。
 * 不把 --pele-* 接过来，深色下就是“近黑压深灰”（1.18:1）、节点还是白卡片。
 * 这里全部接到 --dkf-* 角色上：线用次级文字色，节点用抬起的一层，淡化的终点是画布。
 */
.dkf-graph{
  --pele-bg:var(--dkf-raise);--pele-fg:var(--dkf-fg);--pele-muted:var(--dkf-fg3);
  --pele-line:var(--dkf-fg2);--pele-surface:var(--dkf-raise);--pele-surface-alt:var(--dkf-bg);
  --pele-border:var(--dkf-line-2);--pele-accent:var(--dkf-accent);
  --pele-font:var(--dkf-sans);--pele-font-mono:var(--dkf-mono);
  --dkf-canvas:var(--dkf-bg2);
  --dkf-dim-node:.2;--dkf-dim-edge-mix:20%;--dkf-dim-label-mix:20%;
  --dkf-focus-glow:2px;--dkf-focus-color:var(--dkf-accent);
}
/* 淡化向画布色混，而不是向白底混：按定义永远比正常边更靠近画布，换主题也不会反过来 */
.dkf-graph svg{--dkf-dim-edge-color:color-mix(in srgb,var(--dkf-fg2) var(--dkf-dim-edge-mix),var(--dkf-canvas));--dkf-dim-label-color:color-mix(in srgb,var(--dkf-fg2) var(--dkf-dim-label-mix),var(--dkf-canvas))}
.dkf-gnode-dim{opacity:var(--dkf-dim-node);transition:opacity .12s ease}
/*
 * 图上的 hover 与列表同一句话：“指到谁，谁就恢复可读”。
 * 列表是叠一层浅底；图里没有底色可叠，就把淡化的节点临时拉回正常亮度
 * （鼠标移开自动退回，不需要 JS，也不会跟焦点的光晕抢）。
 */
.dkf-graph .pele-node{cursor:pointer}
.dkf-gnode-dim:hover{opacity:1}
/* 边用“换颜色”而不是整体透明度：多条箭头叠在一起时，透明度会累加出更深的块 */
.dkf-gedge-dim path{stroke:var(--dkf-dim-edge-color);transition:stroke .12s ease}
.dkf-gedge-dim .pele-marker{fill:var(--dkf-dim-edge-color)}
.dkf-gedge-label-dim text{fill:var(--dkf-dim-label-color);transition:fill .12s ease}
/* 淡化的边标签连底板一起退回画布，否则“暗字压亮板”会糊成一团 */
.dkf-gedge-label-dim rect{fill:var(--dkf-canvas)}
.dkf-gnode-focus{filter:drop-shadow(0 0 var(--dkf-focus-glow) var(--dkf-focus-color)) drop-shadow(0 0 calc(var(--dkf-focus-glow) * 2) var(--dkf-focus-color))}
.dkf-legend{display:flex;flex-wrap:wrap;gap:4px 16px;padding:0 4px}
.dkf-legend-row{display:flex;align-items:center;gap:6px;color:var(--dkf-fg3);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-legend-off{opacity:.15}
.dkf-legend-svg{flex:none;width:40px;height:auto;color:var(--dkf-fg2)}
.dkf-legend-end{font-family:var(--dkf-mono);color:var(--dkf-fg2);flex:none}
.dkf-legend-text{color:var(--dkf-fg3)}
/* 节点提示：宿主浮层阴影，不自己画边框 */
.dkf-tip{position:fixed;z-index:40;pointer-events:none;max-width:320px;padding:8px 10px;border-radius:var(--dkf-r-float);background:var(--dkf-bg);box-shadow:var(--dsw-elevation-panel,0 3px 8px rgba(0,0,0,.08))}
.dkf-tip-head{display:flex;align-items:baseline;gap:8px;margin-bottom:2px}
.dkf-tip-id{font-family:var(--dkf-mono);color:var(--dkf-fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-tip-meta{margin-left:auto;flex:none;color:var(--dkf-fg3);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-tip-title{color:var(--dkf-fg);white-space:pre-line;overflow-wrap:anywhere;font-size:var(--dkf-fs-body);line-height:var(--dkf-lh-body)}
.dkf-mermaid{margin:0;padding:8px 10px;max-height:320px;overflow:auto;border-radius:var(--dkf-r);background:var(--dkf-bg2);color:var(--dkf-fg2);font-family:var(--dkf-mono);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta);white-space:pre}
/*
 * DSH 的“拖动调宽”手柄（[data-width-handle]，由 dsh-client-ui-conversation 的
 * ConversationWidthControls 渲染）是对话容器的兄弟节点、绝对定位，会横穿我们的整个视图：
 * 2px 竖线像一条关系线，10px 命中区还会把横向拖动从“平移图”抢成“改对话宽度”。
 * 它调的是对话正文宽度，对这三页没有意义，所以只在我们根节点挂载时藏掉——切回对话页
 * .dkf-root 卸载，:has() 不再命中，手柄自动回来。
 */
[data-conversation-content]:has(.dkf-root) [data-width-handle]{display:none}
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

    /**
     * 节点说明里“这条 issue 在问什么”：优先 ask 的标题，没有 ask 就退到最后一条动作。
     * 标题在宿主侧已截到 200 字（`MAX_TITLE`），这里不再截，交给 CSS 换行。
     */
    function issueSummary(issue) {
      const actions = Array.isArray(issue?.actions) ? issue.actions : []
      const ask = actions.find((action) => action.action === 'ask')
      if (ask !== undefined) return { kind: 'ask', date: String(ask.date ?? ''), title: String(ask.title ?? '') }
      const last = actions.length > 0 ? actions[actions.length - 1] : null
      if (last !== null) return { kind: 'last', date: String(last.date ?? ''), title: String(last.title ?? '') }
      return { kind: 'none', date: '', title: '' }
    }

    /** 说明框的宽度上限：`.dkf-tip` 的 max-width 与这个数必须一致，靠边翻转靠它算。 */
    const TIP_MAX_WIDTH = 320
    /** 下边缘的判断留一点余量：标题可能一两行，量真实高度要额外一次 layout，不值。 */
    const TIP_FLIP_HEIGHT = 120

    /**
     * 图的字号：Pele 只认 mount 选项里的 `fontSize`（它没有对应的 CSS 变量），
     * 而且这个数同时决定**测量**——只改 CSS 会变成“字缩小、框不变”。
     * 所以从容器算出来的字号里取，夹到 8–24；拿不到就退回 12（与 `.dkf-root` 的正文同号）。
     */
    const GRAPH_FONT_FALLBACK = 12

    function graphFontSize(computed) {
      const raw = computed === null || computed === undefined ? Number.NaN : Number.parseFloat(computed.fontSize)
      if (!Number.isFinite(raw) || raw <= 0) return GRAPH_FONT_FALLBACK
      return Math.max(8, Math.min(24, Math.round(raw)))
    }

    /**
     * 说明框位置：默认在光标右下；贴近窗口右边 / 下边就翻到另一侧。
     * 翻转用 `transform`，所以不必知道说明框到底多高。
     */
    function tipPlacement(x, y, width, height) {
      const flipX = Number.isFinite(width) && width > 0 && x + 14 + TIP_MAX_WIDTH > width
      const flipY = Number.isFinite(height) && height > 0 && y + 18 + TIP_FLIP_HEIGHT > height
      return {
        left: `${flipX ? x - 14 : x + 14}px`,
        top: `${flipY ? y - 12 : y + 18}px`,
        transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`,
      }
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
    function listKeyDown(event, options = {}) {
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
      // 已经在最后一行：让滚动容器再走一段，虚拟列表会挂出下一批；下一帧把焦点交给新的末行
      if (next === current && delta === 1 && typeof options.onEdge === 'function') {
        options.onEdge()
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            const added = Array.from(container.querySelectorAll('[data-row]'))
            const target = added[added.length - 1]
            if (target !== undefined && typeof target.focus === 'function') target.focus()
          })
        }
        return
      }
      const target = rows[next]
      if (target !== undefined && typeof target.focus === 'function') target.focus()
    }

    /**
     * 搜索结果的下一项；到两端回绕。`-1` 表示没有结果。
     * 结果全量在内存里，虚拟化只影响挂载，不影响可选中项。
     */
    function nextSearchIndex(current, length, delta) {
      if (!(length > 0)) return -1
      const base = Number.isFinite(current) && current >= 0 ? current : delta === 1 ? -1 : 0
      return (((base + delta) % length) + length) % length
    }

    /** 跳转计划：目标还没进数据就等流，流结束仍没有才放弃，否则按索引滚动。 */
    function jumpPlan(index, streaming) {
      if (index < 0) return streaming ? 'wait' : 'give-up'
      return 'scroll'
    }

    /** 行的稳定键：时间线用提交 sha，issue/搜索用 issue id（流在前面插行也不会串高度）。 */
    function rowKeyOf(kind, row) {
      if (kind === 'timeline') return actionKey(row)
      return String(row?.issue?.id ?? row?.id ?? '')
    }

    /**
     * 前缀高度表：offsets[i] 是第 i 行顶部的位置。
     * 已测量的行用真实高度，没测过的按 estimate；只在数据或测量版本变化时重算。
     */
    function buildOffsets(rows, kind, heights, estimate = ROW_ESTIMATE) {
      const list = Array.isArray(rows) ? rows : []
      const offsets = new Float64Array(list.length + 1)
      for (let index = 0; index < list.length; index += 1) {
        const key = `${kind}\u0000${rowKeyOf(kind, list[index])}`
        const height = heights?.get?.(key)
        offsets[index + 1] = offsets[index] + (Number.isFinite(height) && height > 0 ? height : estimate)
      }
      return offsets
    }

    /**
     * 可视窗口：`scrollTop ± overscan` 覆盖的行区间 + 上下 spacer 高度。
     * 内容总高不超过“视口 + 2×overscan”时整份渲染（小仓与没有虚拟化时一致）。
     */
    function virtualWindow(offsets, total, scrollTop, viewport, overscan = VIRTUAL_OVERSCAN) {
      if (!(total > 0) || offsets.length <= total) return { start: 0, end: 0, top: 0, bottom: 0 }
      if (offsets[total] <= viewport + overscan * 2) return { start: 0, end: total, top: 0, bottom: 0 }
      const top = Math.max(0, scrollTop - overscan)
      const bottom = scrollTop + Math.max(viewport, 1) + overscan
      let lo = 0
      let hi = total
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (offsets[mid + 1] <= top) lo = mid + 1
        else hi = mid
      }
      const start = lo
      lo = start
      hi = total
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (offsets[mid] < bottom) lo = mid + 1
        else hi = mid
      }
      const end = Math.min(total, Math.max(start + 1, lo))
      return { start, end, top: offsets[start], bottom: offsets[total] - offsets[end] }
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
     * 以 focus 为根折成「按方向分桶」的邻居，并给出本次取景的 issue 集合。
     *
     * 父与子不再是两种特例：它们只是 `part-of` 的两个方向（`out` = 我是子，`in` = 我是父），
     * 于是多父 / 多子都自然成立。旧版把父收在 `parent[0]` 里，第二个父会被静默丢掉。
     * 桶里不排序（调用处按“最近在前”排），桶外不出现任何关系名——见 `REL_SIDES`。
     * `part-of` 蕴含的 `blocks` 边仍被 `part-of` 覆盖，不重复显示。
     */
    function relatedOf(focus, relations) {
      const groups = new Map(REL_SIDES.map((side) => [side.key, []]))
      const ids = new Set([focus])

      const partOfPairs = new Set()
      for (const relation of relations) {
        if (relation.rel !== 'part-of') continue
        partOfPairs.add(`${relation.a}\u0000${relation.b}`)
        partOfPairs.add(`${relation.b}\u0000${relation.a}`)
      }

      for (const relation of relations) {
        if (relation.a !== focus && relation.b !== focus) continue
        const other = relation.a === focus ? relation.b : relation.a
        if (relation.rel === 'blocks' && partOfPairs.has(`${focus}\u0000${other}`)) continue
        const dir = relation.directed === false ? 'none' : relation.a === focus ? 'out' : 'in'
        const bucket = groups.get(`${relation.rel}|${dir}`)
        if (bucket === undefined) continue
        bucket.push(other)
      }

      for (const list of groups.values()) for (const id of list) ids.add(id)
      return { groups, ids }
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
     *   · 无向的 `relates-to` 平时不画（58 节点里 53 条边是它，去掉后交叉 112 → 0）；
     *     但**有焦点时**会把焦点的无向邻居一起带出来——它们正是“相关但没方向”的那一圈；
     *   · `view` —— `global` 全图 / `dim` 全图+淡化（文本同 global）/ `ego` 只画焦点邻域（`depth` 跳）。
     *
     * 只有后两者会改文本，所以「全局 / 全局+焦点」两档切焦点不重排，只有 `ego` 会重画。
     */
    function buildMermaid(issues, relations, options = {}) {
      const direction = options.direction === 'TB' ? 'TB' : 'LR'
      const view = options.view === 'focus' ? 'focus' : 'global'
      const focusId = options.focusId ?? null
      const depth = options.depth === 2 ? 2 : 1

      const directed = relations.filter((relation) => relation.directed !== false)
      let kept = directed
      let ego = false

      if (view === 'focus' && focusId !== null) {
        // 聚焦：以焦点为中心，全部关系类型，depth 跳
        ego = true
        const within = egoNodes(focusId, relations, depth)
        kept = within.size > 1 ? edgesWithin(relations, within) : []
      }

      const touched = new Set()
      for (const relation of kept) {
        touched.add(relation.a)
        touched.add(relation.b)
      }
      if (ego) touched.add(focusId)
      const visible = issues.filter((issue) => touched.has(issue.id))

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
      let edgeIndex = 0
      const drawn = new Set()
      for (const relation of kept) {
        const from = nodeOf.get(relation.a)
        const to = nodeOf.get(relation.b)
        if (from === undefined || to === undefined) {
          dropped += 1
          continue
        }
        drawn.add(relation.rel)
        // 不要边标签：关系类型由线型 + 图例表达，标签会重复几十遍（见本 issue 的 collect）
        // caused-by 按“因 → 果”画，好让箭头与图例里的「A 引发 B」同向
        const flipped = relation.rel === 'caused-by'
        const tail = flipped ? to : from
        const head = flipped ? from : to
        if (relation.directed === false) lines.push(`  ${tail} --- ${head}`)
        else lines.push(`  ${tail} --> ${head}`)
        // 线型统一走 linkStyle：序号就是上面的声明顺序，稳定可控
        const stroke = EDGE_STROKE[relation.rel]
        if (stroke !== undefined) lines.push(`  linkStyle ${edgeIndex} ${stroke}`)
        edgeIndex += 1
      }

      for (const [action, nodes] of byAction) lines.push(`  class ${nodes.join(',')} act_${action}`)

      return {
        source: lines.join('\n'),
        nodeOf,
        byNode,
        dropped,
        ego,
        focusId,
        drawn,
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
     *
     * Pele 的元素都带 `data-id`：节点是 `n_<id>`，边是 `L_<from>_<to>_<序号>`，
     * 而**边的标签是兄弟节点**（`.pele-edge-label`），不在 `.pele-edge` 里，但 `data-id` 相同。
     * 所以淡化按“边 id 集合”来，线和标签一起处理，不依赖它们各自的层级。
     *
     * 返回统计，供上层在“一条边都没认出来”时兜底说明（Pele 升级改了 id 形态会走到这里）。
     */
    function paintFocus(host, tiers, built) {
      const stats = { nodes: 0, edges: 0, labels: 0, matched: 0 }
      if (host === null || typeof host.querySelectorAll !== 'function') return stats
      const { byNode, nodeOf } = built
      const focus = built.focusId ?? null

      for (const element of host.querySelectorAll('.pele-node')) {
        stats.nodes += 1
        const id = byNode.get(element.getAttribute('data-id')) ?? null
        const related = tiers !== null && id !== null && tiers.related.has(id)
        element.classList.toggle('dkf-gnode-dim', tiers !== null && !related)
        // 焦点高亮与“是否淡化”无关：全局与聚焦两个视图共用这一个 class
        element.classList.toggle('dkf-gnode-focus', focus !== null && id === focus)
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
        // 两端都在圈里才亮：一端在圈里、另一端在圈外的边，就是“亮线连暗节点”的元凶
        if (!bright.has(from) || !bright.has(to)) continue
        // 两个方向都认：renders 的顺序由 Pele 决定，不该由我们猜
        prefixes.push(`L_${from}_${to}_`, `L_${to}_${from}_`)
      }

      for (const element of host.querySelectorAll('.pele-edge, .pele-edge-label')) {
        const isLabel = element.classList.contains('pele-edge-label')
        const dataId = element.getAttribute('data-id') ?? ''
        const incident = prefixes.some((prefix) => dataId.startsWith(prefix))
        if (isLabel) stats.labels += 1
        else {
          stats.edges += 1
          if (dataId !== '' && incident) stats.matched += 1
        }
        element.classList.toggle(isLabel ? 'dkf-gedge-label-dim' : 'dkf-gedge-dim', tiers !== null && !incident)
      }
      return stats
    }

    /** 三页共用的“相关集”：焦点 + 一跳邻居。 */
    function scopedIssues(issues, view) {
      if (view === null) return issues
      return issues.filter((issue) => view.ids.has(issue.id))
    }
    /**
     * 时间线的聚焦收窄：流是全仓的，聚焦时只留焦点 + 一跳邻居。
     * 不重排——上游 git 已按 author-date 倒序（jj 是拓扑序），边到边画就是时间顺序。
     */
    function scopeTimeline(rows, view) {
      if (view === null) return rows
      return rows.filter((row) => view.ids.has(rowIssue(row)))
    }

    /** `action list --json` → 折叠要用的词表；形状不对就当没有（done 未知，不猜）。 */
    function normalizeVocab(document) {
      const actions = document?.actions ?? document
      const names = Array.isArray(actions?.names) ? actions.names.map(String) : []
      const start = typeof actions?.start === 'string' ? actions.start : ''
      const terminal = Array.isArray(actions?.terminal) ? actions.terminal.map(String) : []
      if (names.length === 0 || start === '') return null
      return { names, start, terminal: new Set(terminal) }
    }

    /**
     * 把 action 流折叠成 issue 索引（无焦点的 issue 页用它）。
     *
     * 规则对着 kiln 的聚合实现（`engine.Build` / `Issue.Last` / `isDone`）：
     * - 流是 author-date 倒序 → issue 的**首现**就是它的最近动作，首现顺序就是 recency；
     * - `domain`：kiln 在时间序里用最后一个非空覆盖 → 倒序流的**首个非空**；
     * - `tags`：全部动作的并集，按时间序 appendUnique（这里先倒着收、翻正后再去重）；
     * - `done`：最近动作 ∈ `terminal`（词表来自 `action list --json`，不硬编码 conclude/apply）；
     * - `ordinal`：要等看到 `start`（这条 issue 读完了）或流结束才回填，否则会先小后大。
     *
     * 返回顺序 = 首现顺序（最新动作在前）；调用方可以再按 date 排，但不必。
     */
    function foldIssues(rows, options = {}) {
      const start = typeof options?.start === 'string' ? options.start : ''
      const terminal = options?.terminal instanceof Set ? options.terminal : null
      const complete = options?.complete === true
      const byId = new Map()
      const order = []
      for (const row of Array.isArray(rows) ? rows : []) {
        const id = rowIssue(row)
        if (id === '') continue
        let issue = byId.get(id)
        if (issue === undefined) {
          issue = {
            id,
            domain: '',
            action: '',
            done: false,
            /** 词表拿不到时 done 不可知：不画 done chip，也不参与状态筛选。 */
            doneKnown: terminal !== null,
            title: '',
            tags: [],
            actions: [],
            last: null,
          }
          byId.set(id, issue)
          order.push(id)
        }
        if (issue.domain === '' && rowDomain(row) !== '') issue.domain = rowDomain(row)
        issue.actions.push({
          action: rowAction(row),
          id: rowCommit(row),
          short: rowShort(row),
          date: rowDate(row),
          title: rowTitle(row),
          /** 动作级标签只在折叠时用来合并 issue 级 tags，渲染不看它。空的共用一份，别每行建数组。 */
          tags: row[ROW.TAGS] === null ? NO_TAGS : rowTags(row),
          refs: [],
        })
      }

      const issues = []
      for (const id of order) {
        const issue = byId.get(id)
        // 倒序流 → 翻成时间升序，与快照的 actions 同向（strip / ActionLines 都按升序读）
        issue.actions.reverse()
        const last = issue.actions[issue.actions.length - 1] ?? null
        issue.last = last
        issue.action = last?.action ?? ''
        issue.title = last?.title ?? ''
        issue.done = terminal !== null && last !== null && terminal.has(last.action)
        const tags = []
        for (const action of issue.actions) {
          for (const tag of action.tags) if (!tags.includes(tag)) tags.push(tag)
        }
        issue.tags = tags
        // 看到起点（最早那条动作 = start）或整条流结束，动作数才不会再变，序号可以定稿
        const finished = complete || (start !== '' && issue.actions[0]?.action === start)
        if (finished) issue.actions.forEach((action, index) => { action.ordinal = index + 1 })
        issues.push(issue)
      }
      return issues
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

    /** 组内按最近动作时间排序；按时间而不是 ISO 字符串比较，缺失日期的排最后。 */
    function byRecency(left, right) {
      const leftTime = Date.parse(left.last?.date ?? '')
      const rightTime = Date.parse(right.last?.date ?? '')
      const leftMissing = Number.isNaN(leftTime)
      const rightMissing = Number.isNaN(rightTime)
      if (leftMissing && rightMissing) return left.id.localeCompare(right.id)
      if (leftMissing) return 1
      if (rightMissing) return -1
      if (leftTime === rightTime) return left.id.localeCompare(right.id)
      return leftTime < rightTime ? 1 : -1
    }

    /**
     * 筛选：同组内多选是 OR（领域 A 或 B），组间是 AND（领域 A 且未完成）。
     * 只认快照里已有的字段（domain / done），不猜"应该有什么"。
     */
    function readFilters(value) {
      const source = value === null || value === undefined ? EMPTY_FILTERS : value
      return {
        domains: Array.isArray(source.domains) ? source.domains.slice() : [],
        states: Array.isArray(source.states) ? source.states.slice() : [],
      }
    }

    /** 任何一组有选中就算"筛选中"；issue 用三组、时间线用两组，共用同一套判断。 */
    function filtersActive(filters) {
      if (filters === null || filters === undefined) return false
      return Object.values(filters).some((list) => Array.isArray(list) && list.length > 0)
    }

    /** 时间线的动作筛选：动作名 + 所属 issue 的领域。 */
    const EMPTY_ROW_FILTERS = { actions: [], domains: [] }

    function readRowFilters(value) {
      const source = value === null || value === undefined ? EMPTY_ROW_FILTERS : value
      return {
        actions: Array.isArray(source.actions) ? source.actions.slice() : [],
        domains: Array.isArray(source.domains) ? source.domains.slice() : [],
      }
    }

    /** 动作行上的筛选：actions 看动作名，domains 看这个动作所属 issue 的领域。 */
    function filterRows(rows, filters, byId) {
      if (filters === null || filters === undefined || !filtersActive(filters)) return rows
      return rows.filter((row) => {
        if (filters.actions.length > 0 && !filters.actions.includes(rowAction(row))) return false
        if (filters.domains.length > 0) {
          const domain = byId?.get?.(rowIssue(row))?.domain ?? ''
          if (!filters.domains.includes(domain)) return false
        }
        return true
      })
    }

    /**
     * 时间线可筛的值：动作名（按出现次数）、领域（按条数，且只在多于一个时给）。
     * 标签不在这里——kiln v0.2.0 起 `path --json` 已带动作级 `tags`，但「按标签筛」是
     * 产品决定（会新增一个筛选维度），这轮适配不接，见 kiln-v020-adapter。
     */
    function rowFacets(rows, byId) {
      const actions = new Map()
      const domains = new Map()
      for (const row of rows) {
        const action = rowAction(row)
        actions.set(action, (actions.get(action) ?? 0) + 1)
        const domain = byId?.get?.(rowIssue(row))?.domain ?? ''
        domains.set(domain, (domains.get(domain) ?? 0) + 1)
      }
      const toOptions = (map, emptyLabel) =>
        [...map.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .map(([id, count]) => ({ id, label: id === '' ? emptyLabel : id, count }))
      return {
        actions: actions.size > 1 ? toOptions(actions, '?') : [],
        domains: domains.size > 1 ? toOptions(domains, '未分类') : [],
      }
    }

    function matchesFilters(issue, filters) {
      if (filters.domains.length > 0 && !filters.domains.includes(issue.domain ?? '')) return false

      if (filters.states.length > 0) {
        // done 不可知（词表没取到）时不猜：这条 issue 不进任何状态筛选结果
        if (issue.doneKnown === false) return false
        const state = issue.done === true ? 'done' : 'open'
        if (!filters.states.includes(state)) return false
      }
      return true
    }

    function filterIssues(issues, filters) {
      if (filters === null || filters === undefined || !filtersActive(filters)) return issues
      return issues.filter((issue) => matchesFilters(issue, filters))
    }

    /**
     * 本仓实际有哪些可筛的值。只在"有得选"时才给这一组：
     * 只有一个领域就没有"按领域筛"的意义；一个标签都没有就不给标签组。
     */
    function issueFacets(issues) {
      const domains = new Map()
      const states = new Map()
      for (const issue of issues) {
        const domain = issue.domain ?? ''
        domains.set(domain, (domains.get(domain) ?? 0) + 1)
        if (issue.doneKnown === false) continue
        const state = issue.done === true ? 'done' : 'open'
        states.set(state, (states.get(state) ?? 0) + 1)
      }
      const toOptions = (map, emptyLabel) =>
        [...map.entries()]
          .sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0]))
          .map(([id, count]) => ({ id, label: id === '' ? emptyLabel : id, count }))
      return {
        domains: domains.size > 1 ? toOptions(domains, '未分类') : [],
        states:
          states.size > 1
            ? toOptions(states, '').map((option) => ({ ...option, label: FILTER_STATE_LABEL[option.id] ?? option.id }))
            : [],
      }
    }

    /**
     * 搜索：空白切词、大小写不敏感；每个词都要出现（AND），可分别落在 id 或标题上。
     * 只认快照里已有的两个字段（issue id、issue 标题），不做模糊子序列——
     * 数据量小，子序列只会带来意外命中，收益不如"id 前缀优先"的排序。
     */
    function splitTerms(query) {
      return String(query ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term !== '')
    }

    function mergeRanges(ranges) {
      if (ranges.length === 0) return []
      const sorted = ranges.slice().sort((left, right) => left[0] - right[0])
      const merged = [sorted[0]]
      for (const range of sorted.slice(1)) {
        const last = merged[merged.length - 1]
        if (range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
        else merged.push(range)
      }
      return merged
    }

    /** 文本里所有命中的区间；词之间相邻或重叠时合并成一段，正好用来切高亮。 */
    function matchRanges(text, terms) {
      const haystack = String(text ?? '').toLowerCase()
      const ranges = []
      for (const term of terms) {
        let from = 0
        for (;;) {
          const at = haystack.indexOf(term, from)
          if (at < 0) break
          ranges.push([at, at + term.length])
          from = at + term.length
        }
      }
      return mergeRanges(ranges)
    }

    /** 搜索失败时的可读文案：优先用宿主带来的 message，其次按 reason 翻成人话。 */
    function searchFailureText(body) {
      if (typeof body?.message === 'string' && body.message !== '') return body.message
      const reason = String(body?.reason ?? '')
      const known = {
        'kiln-missing': '宿主进程里找不到 kiln 可执行文件。把 kiln 放进 PATH，或设置 DSH_KILN_BIN。',
        'not-kiln-repo': '这个工作区不是 kiln 仓库（缺 .kilnconfig.jsonc）。',
        'invalid-dir': '工作区路径无效。',
        'empty-query': '搜索词为空。',
      }
      return known[reason] ?? (reason === '' ? 'kiln 搜索失败' : `搜索失败：${reason}`)
    }

    /** 详情失败时的可读文案：优先用宿主带来的 message，其次按 reason 翻成人话。 */
    function detailFailureText(body) {
      if (typeof body?.message === 'string' && body.message !== '') return body.message
      const reason = String(body?.reason ?? '')
      const known = {
        'kiln-missing': '宿主进程里找不到 kiln 可执行文件。把 kiln 放进 PATH，或设置 DSH_KILN_BIN。',
        'not-kiln-repo': '这个工作区不是 kiln 仓库（缺 .kilnconfig.jsonc）。',
        'invalid-dir': '工作区路径无效。',
        'missing-id': '缺少 issue id。',
      }
      return known[reason] ?? (reason === '' ? 'kiln path 失败' : `详情读取失败：${reason}`)
    }

    /** 关系图失败文案。 */
    function graphFailureText(body) {
      if (typeof body?.message === 'string' && body.message !== '') return body.message
      const reason = String(body?.reason ?? '')
      const known = {
        'kiln-missing': '宿主进程里找不到 kiln 可执行文件。把 kiln 放进 PATH，或设置 DSH_KILN_BIN。',
        'not-kiln-repo': '这个工作区不是 kiln 仓库（缺 .kilnconfig.jsonc）。',
        'invalid-dir': '工作区路径无效。',
      }
      return known[reason] ?? (reason === '' ? 'kiln graph 失败' : `关系图读取失败：${reason}`)
    }

    /** 整个视图不可用（不是 kiln 仓库 / 找不到 kiln / 路径无效）时的说明。 */
    function unavailableText(problem) {
      const known = {
        'kiln-missing': '宿主进程里找不到 kiln 可执行文件。把 kiln 放进 PATH，或设置 DSH_KILN_BIN。',
        'not-kiln-repo': '这个工作区不是 kiln 仓库（缺 .kilnconfig.jsonc）。以仓库根目录打开会话后再看。',
        'invalid-dir': '工作区路径无效。',
      }
      return problem?.message !== '' && typeof problem?.message === 'string'
        ? problem.message
        : known[String(problem?.reason ?? '')] ?? `未知原因：${problem?.reason ?? 'unknown'}`
    }

    /**
     * `kiln list --search --json` 的行 → 搜索结果视图需要的字段。
     *
     * **顺序、rank、hit 全部由 kiln 给**，这里只做字段改名与高亮区间；不再自己匹配/排序。
     * 命中的 issue 总在动作流里（列表不再有 80 条上限），所以行上带得到它的 actions。
     */
    function mapSearchRows(document, byId, terms) {
      const rows = Array.isArray(document?.issues) ? document.issues : []
      return rows.map((row) => {
        const id = String(row?.id ?? '')
        const found = byId?.get?.(id)
        const issue = found ?? {
          id,
          domain: String(row?.domain ?? ''),
          action: String(row?.action ?? ''),
          done: row?.done === true,
          title: String(row?.title ?? ''),
          tags: Array.isArray(row?.tags) ? row.tags : [],
          actions: [],
          last: null,
        }
        const hit = row?.hit ?? null
        const shown = hit === null ? String(row?.title ?? issue.title ?? '') : String(hit.subject ?? '')
        const date = hit === null ? issue.last?.date : hit.date
        return {
          issue,
          rank: row?.rank,
          title: shown,
          /** 命中来自动作时带上"哪条动作"——结果行要能区分"找到的是 issue 名"还是"动作里的词"。 */
          action: hit === null ? null : String(hit.action ?? ''),
          actionId: hit === null ? null : String(hit.commit ?? ''),
          ordinal: hit === null ? null : hit.ordinal,
          total: hit === null ? (Array.isArray(issue.actions) ? issue.actions.length : 0) : hit.total,
          /** 命中动作的日期（preview 里给到天）；只命中 id/标题时退回快照里的最后一条动作日期。 */
          date: String(date ?? '').slice(0, 10),
          idRanges: matchRanges(id, terms),
          titleRanges: matchRanges(shown, terms),
        }
      })
    }

    /**
     * 焦点行下方的迷你动作条：最多 12 格，颜色 = 动作类型。
     *
     * 默认标最后一格（= 当前动作）；`highlightId` 给了就标**那一格**——搜索结果命中某条动作时，
     * 突出显示的是"命中的那条"，不是"最后那条"。命中太早、落在窗口外时，窗口会挪到包含它的位置，
     * 末尾用 `+k` 表示"更新的动作没画下"（前缀 `+k` 仍是"更早的没画下"）。
     */
    function strip(actions, highlightId) {
      if (!Array.isArray(actions) || actions.length === 0) return null
      const hitIndex =
        highlightId === undefined || highlightId === null
          ? -1
          : actions.findIndex((action) => action.id === highlightId)
      const end = hitIndex < 0 ? actions.length : Math.min(actions.length, Math.max(hitIndex + 1, 12))
      const start = Math.max(0, end - 12)
      const visible = actions.slice(start, end)
      const older = start
      const newer = actions.length - end
      const anchor = hitIndex >= start && hitIndex < end ? hitIndex - start : visible.length - 1
      /** 流里还没读到起点时没有 ordinal：序号缺了就省略，不编一个。 */
      const label = (action) => `${Number.isInteger(action.ordinal) ? `${action.ordinal}. ` : ''}${action.action}`
      return h(
        'span',
        { className: 'dkf-strip', 'data-hint': actions.map(label).join('\n') },
        older > 0 ? h('span', { className: 'dkf-ago' }, `+${older}`) : null,
        visible.map((action, index) =>
          h('span', {
            key: `${action.ordinal ?? action.id ?? index}-${index}`,
            className: cls('dkf-block', index === anchor && 'dkf-block-current'),
            style: { background: colorOf(action.action) },
            'data-hint': `${label(action)} · ${action.date} · ${action.title ?? ''}`,
          }),
        ),
        newer > 0 ? h('span', { className: 'dkf-ago', 'data-hint': `还有 ${newer} 条更新的动作没画下` }, `+${newer}`) : null,
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
              { className: 'dkf-subrow', key: `${action.ordinal ?? action.id ?? index}-${action.short || ''}`, style: { '--dkf-row-color': colorOf(action.action) } },
              h('span', { className: 'dkf-abar' }),
              h('span', { className: 'dkf-achip' }, action.action || '?'),
              h('span', { className: 'dkf-atitle', 'data-hint': action.title }, action.title || '（无标题）'),
              h('span', { className: 'dkf-ashort' }, action.short || ''),
              h('span', { className: 'dkf-ago' }, ago(action.date)),
            ),
          ),
      )
    }

    /** timeline 行展开：这条提交的详情。动作级 domain/tags 由 action log 给，缺了就不显示。 */
    function ActionDetail(props) {
      const row = props.row
      const tags = rowTags(row)
      const domain = rowDomain(row)
      return h(
        'div',
        { className: 'dkf-detail' },
        h('div', null, h('span', { className: 'dkf-detail-key' }, '提交'), h('code', null, rowCommit(row) || '（无 sha）')),
        domain !== ''
          ? h('div', null, h('span', { className: 'dkf-detail-key' }, '领域'), h('span', null, domain))
          : null,
        tags.length > 0
          ? h('div', null, h('span', { className: 'dkf-detail-key' }, '标签'), h('span', null, tags.join('、')))
          : null,
        h('div', null, h('span', { className: 'dkf-detail-key' }, '时间'), h('span', null, rowDate(row))),
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
            style: { '--dkf-row-color': colorOf(issue.action) },
            onClick: props.onToggle,
            onPointerEnter: () => props.onPrefetch?.(issue.id),
            onKeyDown: (event) => rowKeyDown(event, props),
          },
          strip(issue.actions),
          h('span', { className: 'dkf-caret', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'),
          h(
            'span',
            { className: 'dkf-id', 'data-hint': issue.id },
            issue.id,
          ),
          h(
            'span',
            { className: 'dkf-badges' },
            issue.domain ? h('span', { className: 'dkf-chip' }, issue.domain) : null,
            h('span', { className: 'dkf-chip dkf-chip-action' }, issue.action || '?'),
            issue.done && issue.doneKnown !== false ? h('span', { className: 'dkf-chip dkf-chip-done' }, 'done') : null,
          ),
          h('span', { className: 'dkf-title', 'data-hint': last?.title || issue.title || '（无标题）' }, last?.title || issue.title || '（无标题）'),
          h('span', { className: 'dkf-ago' }, ago(last?.date)),
          // 列表里的 issue 都能聚焦：结构由详情（path 单条）现取，不再有“快照外”这条死路。
          h(
            'button',
            {
              type: 'button',
              className: 'dkf-focusbtn',
              tabIndex: -1,
              'data-hint': `聚焦 ${issue.id}（快捷键 f）`,
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
      const issue = rowIssue(row)
      const action = rowAction(row)
      const title = rowTitle(row)
      return h(
        React.Fragment,
        null,
        h(
          'div',
          {
            className: 'dkf-arow',
            'data-row': '',
            'data-key': actionKey(row),
            tabIndex: -1,
            style: { '--dkf-row-color': colorOf(action) },
            onClick: props.onToggle,
            onPointerEnter: () => props.onPrefetch?.(issue),
            onKeyDown: (event) => rowKeyDown(event, props),
            'data-hint': '点开看这条提交的详情',
          },
          h('span', { className: 'dkf-abar' }),
          h('span', { className: 'dkf-aissue', 'data-hint': issue }, issue),
          h('span', { className: 'dkf-achip' }, action || '?'),
          h('span', { className: 'dkf-atitle', 'data-hint': title }, title || '（无标题）'),
          h('span', { className: 'dkf-ashort' }, rowShort(row)),
          h('span', { className: 'dkf-ago' }, ago(rowDate(row))),
          h(
            'button',
            {
              type: 'button',
              className: 'dkf-focusbtn',
              tabIndex: -1,
              'data-hint': `聚焦 ${issue}（快捷键 f）`,
              onClick: (event) => {
                event.stopPropagation()
                props.onFocus()
              },
            },
            '⌖ 聚焦',
          ),
        ),
        props.expanded === true ? h(ActionDetail, { row }) : null,
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
              // 只表达“想去这一页”的意图：调用方据此预取（关系页的图），不改变选中
              onPointerEnter: () => props.onIntent?.(page.id),
              onFocus: () => props.onIntent?.(page.id),
              onKeyDown: (event) => onKeyDown(event, index),
            },
            page.label,
          )
        }),
      )
    }

    /**
     * 筛选条：三组 chips（同组 OR、组间 AND）；空组不渲染，有筛选时右侧给「清除」。
     * 组清单由调用方给（issue 页三组、时间线两组），选项标签在 facets 里已经拍平。
     */
    function FilterRow(props) {
      const facets = props.facets
      const groups = props.groups.filter((group) => (facets[group.id] ?? []).length > 0)
      if (groups.length === 0) return null
      return h(
        'div',
        { className: 'dkf-filters', role: 'group', 'aria-label': '筛选' },
        groups.map((group) =>
          h(
            'div',
            { className: 'dkf-filter-group', key: group.id },
            h('span', { className: 'dkf-filter-label' }, group.label),
            facets[group.id].map((option) =>
              h(
                'button',
                {
                  key: `${group.id}:${option.id}`,
                  type: 'button',
                  className: cls('dkf-filterbtn', props.active[group.id].includes(option.id) && 'dkf-filterbtn-on'),
                  'aria-pressed': props.active[group.id].includes(option.id),
                  onClick: () => props.onToggle(group.id, option.id),
                },
                `${option.label} ${option.count}`,
              ),
            ),
          ),
        ),
        filtersActive(props.active)
          ? h('button', { type: 'button', className: 'dkf-filter-clear', onClick: props.onClear }, '清除')
          : null,
      )
    }

    /** 把命中区间切成「文本 / 高亮 / 文本…」，高亮段用 `.dkf-hl`。 */
    function highlightParts(text, ranges) {
      if (!Array.isArray(ranges) || ranges.length === 0) return text
      const parts = []
      let at = 0
      for (const [start, end] of ranges) {
        if (start > at) parts.push(text.slice(at, start))
        parts.push(h('span', { key: `${start}-${end}`, className: 'dkf-hl' }, text.slice(start, end)))
        at = end
      }
      if (at < text.length) parts.push(text.slice(at))
      return parts
    }

    /**
     * 搜索结果的 hover 预览：行里的标题会被省略号截断，这里把它补全，
     * 并说清命中来自哪条动作（动作名 + 位置 + 日期）。多行文本，`.dkf-tip-title` 用 pre-line 渲染。
     */
    function hitHint(row) {
      const state = row.issue.done === true ? '已完成' : '进行中'
      const head = [String(row.issue.id ?? ''), state, String(row.issue.domain ?? '')]
        .filter((part) => part !== '')
        .join(' · ')
      const when = row.date === '' || row.date === undefined ? '' : ` · ${row.date}`
      const lines =
        row.action === null
          ? [head, `当前标题${when}`, String(row.title ?? '')]
          : [head, `命中：${row.action} · 第 ${row.ordinal ?? '?'}/${row.total ?? '?'} 条${when}`, String(row.title ?? '')]
      return lines.join('\n')
    }
    /** 虚拟列表的上下占位：用高度撑住“没挂出来的行”，滚动条长度才正确。 */
    function VirtualSpacer(props) {
      if (!(props.height > 0)) return null
      return h('div', {
        className: 'dkf-vspacer',
        style: { height: `${Math.round(props.height)}px` },
        'aria-hidden': 'true',
      })
    }

    /** 一行 item 的外壳：`data-vkey` 给测量用，真实高度按行键存（流在顶部插行也不会串）。 */
    function VirtualItem(props) {
      return h('div', { className: 'dkf-vitem', 'data-vkey': props.vkey }, props.children)
    }

    /**
     * 搜索结果：一行一条 issue（id / 标题 / 领域 / 状态 / ⏎）。
     * 有输入就整块替掉内容区——不是把当前页的列表收窄（那样搜不到别的页里的东西）。
     */
    function SearchResults(props) {
      if (props.rows.length === 0) {
        return h(
          'div',
          { className: 'dkf-empty' },
          h('p', null, `没有找到「${String(props.query ?? '').trim()}」`),
          h('p', null, '试试更短的关键词，或按 Esc 清空。'),
        )
      }
      return h(
        'div',
        { className: 'dkf-list', role: 'listbox', 'aria-label': '搜索结果' },
        h(VirtualSpacer, { height: props.vtop }),
        props.rows.map((row, offset) => {
          const index = (props.start ?? 0) + offset
          return h(
            VirtualItem,
            { key: row.issue.id, vkey: row.issue.id },
            h(
              'div',
              {
                className: cls('dkf-hit', index === props.selected && 'dkf-hit-on'),
                role: 'option',
                'aria-selected': index === props.selected,
                onClick: () => props.onPick(row),
                style: row.action === null ? undefined : { '--dkf-row-color': colorOf(row.action) },
                // hover 预览：把行里被省略号吃掉的东西补全（完整标题 + 命中动作的日期与位置）
                'data-hint': hitHint(row),
              },
              h(
                'div',
                { className: 'dkf-hit-head' },
                strip(row.issue.actions, row.actionId),
                h('span', { className: 'dkf-id' }, highlightParts(String(row.issue.id), row.idRanges)),
                row.issue.domain ? h('span', { className: 'dkf-chip' }, row.issue.domain) : null,
                h('span', { className: 'dkf-chip' }, row.issue.done === true ? '已完成' : '进行中'),
                h('span', { className: 'dkf-hit-go', 'aria-hidden': 'true' }, '⏎'),
              ),
              h(
                'div',
                { className: 'dkf-hit-body' },
                row.action === null ? null : h('span', { className: 'dkf-chip dkf-chip-action' }, row.action),
                h(
                  'span',
                  { className: cls('dkf-hit-title', row.action === null && 'dkf-hit-title-quiet') },
                  highlightParts(String(row.title ?? ''), row.titleRanges),
                ),
                row.action === null
                  ? null
                  : h('span', { className: 'dkf-hit-meta' }, `历史动作 ${row.ordinal ?? '?'}/${row.total ?? '?'}`),
              ),
            ),
          )
        }),
        h(VirtualSpacer, { height: props.vbottom }),
      )
    }

    function TimelinePanel(props) {
      if (props.rows.length === 0) return h('p', { className: 'dkf-empty' }, props.emptyText)
      return h(
        'div',
        {
          className: 'dkf-list dkf-rail',
          tabIndex: 0,
          onKeyDown: (event) => listKeyDown(event, { onEdge: props.onEdge }),
        },
        h(VirtualSpacer, { height: props.vtop }),
        props.rows.map((row) => {
          const key = actionKey(row)
          return h(
            VirtualItem,
            { key, vkey: key },
            h(ActionRow, {
              row,
              onPrefetch: props.onPrefetch,
              expanded:
                props.expanded !== null && props.expanded.kind === 'action' && props.expanded.id === key,
              onToggle: () => props.onToggle({ kind: 'action', id: key }),
              onFocus: () => props.onFocus(rowIssue(row)),
            }),
          )
        }),
        h(VirtualSpacer, { height: props.vbottom }),
      )
    }

    function IssuePanel(props) {
      if (props.issues.length === 0) return h('p', { className: 'dkf-empty' }, props.emptyText)
      return h(
        'div',
        {
          className: 'dkf-list',
          tabIndex: 0,
          onKeyDown: (event) => listKeyDown(event, { onEdge: props.onEdge }),
        },
        h(VirtualSpacer, { height: props.vtop }),
        props.issues.map((issue) =>
          h(
            VirtualItem,
            { key: issue.id, vkey: issue.id },
            h(IssueRow, {
              issue,
              focus: issue.id === props.focusId,
              onPrefetch: props.onPrefetch,
              expanded:
                props.expanded !== null && props.expanded.kind === 'issue' && props.expanded.id === issue.id,
              onToggle: () => props.onToggle({ kind: 'issue', id: issue.id }),
              onFocus: () => props.onFocus(issue.id),
            }),
          ),
        ),
        h(VirtualSpacer, { height: props.vbottom }),
      )
    }

    /**
     * issue 页的聚焦态：把焦点周围的关系按方向读出来（`REL_SIDES` 一人一句）。
     *
     * 这块从关系页的“列表”取景搬来（见 docs/issues/kiln-issue-focus-page.md）：关系页只剩图，
     * 关系名与方向这些“读得出来”的东西集中在这一页。三处有意和旧版不同：
     *   · 弱关联默认展开——`~/kiln` 的数据说折叠时 55% 的焦点只剩焦点自己一行；
     *   · 焦点行默认展开它的动作，让“没有邻居”的焦点也有内容；
     *   · 方向写在表头的句子里（「我由 1 个 issue 引发」），行内不画箭头——同一个桶里所有行的
     *     方向必然相同，逐行标一遍只是重复（见 docs/issues/kiln-relation-direction.md）。
     */
    function IssueFocusList(props) {
      const view = props.view
      const focus = props.focus
      /** 一组一个桶：先按处置顺序遍历 `REL_SIDES`，空桶不渲染。行内按“最近在前”排。 */
      const buckets = REL_SIDES.map((side) => ({
        side,
        rows: (view.groups.get(side.key) ?? []).map((id) => props.byId.get(id)).filter(Boolean).sort(byRecency),
      })).filter((bucket) => bucket.rows.length > 0)

      const rowProps = (issue, extra) => ({
        issue,
        onPrefetch: props.onPrefetch,
        expanded: props.expanded !== null && props.expanded.kind === 'issue' && props.expanded.id === issue.id,
        onToggle: () => props.onToggle({ kind: 'issue', id: issue.id }),
        onFocus: () => props.onFocus(issue.id),
        ...extra,
      })

      return h(
        'div',
        { className: 'dkf-list', tabIndex: 0, onKeyDown: (event) => listKeyDown(event, { onEdge: props.onEdge }) },
        h(
          IssueRow,
          {
            key: focus.id,
            ...rowProps(focus, {
              focus: true,
              expanded: props.focusOpen,
              onToggle: props.onToggleFocus,
            }),
          },
        ),
        buckets.map(({ side, rows }) => {
          const foldable = side.foldable === true && rows.length > 4
          const visible = foldable && !props.expandedChildren ? rows.slice(0, 4) : rows
          return h(
            'div',
            { className: 'dkf-group', key: side.key },
            h(
              'div',
              { className: 'dkf-group-head', 'data-hint': side.rel },
              side.text.replace('{n}', String(rows.length)),
              foldable
                ? h(
                    'button',
                    { type: 'button', className: 'dkf-toggle', onClick: props.onToggleChildren },
                    props.expandedChildren ? '收起' : `展开全部 ${rows.length}`,
                  )
                : null,
            ),
            visible.map((issue) => h(IssueRow, { key: `${side.key}-${issue.id}`, ...rowProps(issue, { indent: true }) })),
          )
        }),
      )
    }

    /**
     * 唯一的提示框：图上的节点提示与页面里的文字提示共用一个组件、一套样式、一个定位函数。
     * 图那边多一个 head（issue id + ask/最后动作），文字提示只有正文。
     */
    function Tip(props) {
      const head = props.head === undefined || props.head === null ? null : h('div', { className: 'dkf-tip-head' }, props.head)
      return h(
        'div',
        {
          className: 'dkf-tip',
          role: 'tooltip',
          style: tipPlacement(props.x, props.y, props.w, props.h),
        },
        head,
        h('div', { className: 'dkf-tip-title' }, props.title),
      )
    }

    /**
     * 关系页：只有图。
     *
     * 文本在渲染期一次算好、挂到 `data-mermaid` 上（排查也方便）；真正画图放在 effect 里，
     * 因为 render 阶段不能碰 DOM。**文本与焦点无关**，所以切焦点只跑 paintFocus 改 class，
     * 图不重排、不重解析——这是“全局关系与聚焦状态同框”的前提。
     */
    function GraphPanel(props) {
      const direction = props.direction === 'TB' ? 'TB' : 'LR'
      const view = props.graphView === 'focus' ? 'focus' : 'global'
      const depth = props.depth === '2' ? 2 : 1
      const built = React.useMemo(
        () => buildMermaid(props.issues, props.relations, { direction, view, focusId: props.focusId, depth }),
        [props.issues, props.relations, direction, view, props.focusId, depth],
      )
      // 只有「全局+焦点」需要分档；ego 画出来的本来就是一圈，global 不淡化
      const tiers = React.useMemo(
        () => (props.focusId === null || view !== 'global' ? null : graphTiers(props.focusId, props.relations)),
        [props.focusId, props.relations, view],
      )
      const hostRef = React.useRef(null)
      const paintState = React.useRef({ tiers: null, built: null })
      const [phase, setPhase] = React.useState('idle')
      const [edgeDimLost, setEdgeDimLost] = React.useState(false)
      /** 当前 hover 的节点（id + 光标位置）；null = 没在节点上。 */
      const [hover, setHover] = React.useState(null)
      /** id → “这条 issue 在问什么”。每份快照算一次，hover 时只查表。 */
      const askOf = React.useMemo(() => {
        const map = new Map()
        for (const issue of props.issues) map.set(issue.id, issueSummary(issue))
        return map
      }, [props.issues])

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
            const computed =
              typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
                ? window.getComputedStyle(host)
                : null
            handle = pele.mount(host, built.source, {
              zoom: 'auto',
              // 字号进 Pele 的布局参数（不是 CSS）：节点框宽度是拿这个字号量出来的
              fontSize: graphFontSize(computed),
              // Pele 会在容器宽度变化时**自己重画**，重画后 SVG 是新的、我们加的 class 全没了。
              // 所以每次渲染完都重涂一遍——这是“切回全局后焦点样式消失”的根因。
              onRender: () => repaint(),
            })
            setPhase('ready')
            repaint()
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

      // 每次渲染都把“当前该涂什么”更新到 ref：onRender 回调里读到的必须是最新一份
      paintState.current = { tiers, built }
      const repaint = (retried = false) => {
        const stats = paintFocus(hostRef.current, paintState.current.tiers, paintState.current.built)
        // mount 之后 SVG 可能还没进 DOM（等字体/量宽度），这一帧一个节点都没找到就下一帧再涂一次
        if (stats.nodes === 0 && !retried && typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => repaint(true))
        }
        // Pele 改了 id 形态就会走到这里：一条边都没认出来 → 说明淡化没生效，别静默
        setEdgeDimLost(paintState.current.tiers !== null && stats.edges === 0)
      }

      React.useEffect(() => {
        if (phase !== 'ready') return
        repaint()
      }, [phase, built, tiers, props.focusId])

      const onClick = (event) => {
        const target = event?.target
        const node = typeof target?.closest === 'function' ? target.closest('[data-id]') : null
        if (node === null) return
        const id = built.byNode.get(node.getAttribute('data-id'))
        if (typeof id === 'string') props.onFocus(id)
      }

      /**
       * 拖动期间压住说明框。
       *
       * Pele 拖动时会 `setPointerCapture` 到容器，`pointermove` 的 target 随之变成容器本身，
       * `closest('[data-id]')` 自然找不到节点——说明框“顺手”就没了。那是它的实现细节，不是我们的
       * 保证，所以这里显式记一笔：按下就算拖动开始，抬起 / 取消才结束。用 ref 而不是 state，
       * 免得每次拖动都多一次渲染。
       */
      const dragging = React.useRef(false)
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        // 捕获期间 pointerup 有可能落在窗口外面，挂到 window 上才收得干净
        const end = () => {
          dragging.current = false
        }
        window.addEventListener('pointerup', end)
        window.addEventListener('pointercancel', end)
        return () => {
          window.removeEventListener('pointerup', end)
          window.removeEventListener('pointercancel', end)
        }
      }, [])
      const onPointerDown = () => {
        dragging.current = true
        if (hover !== null && hover !== undefined) setHover(null)
      }

      /** 与 click 同一套反查：光标压到节点上就记下它的 issue，压到边/空白就收掉说明框。 */
      const onPointerMove = (event) => {
        if (dragging.current === true) {
          if (hover !== null && hover !== undefined) setHover(null)
          return
        }
        const target = event?.target
        const node = typeof target?.closest === 'function' ? target.closest('[data-id]') : null
        const id = node === null ? null : built.byNode.get(node.getAttribute('data-id'))
        if (typeof id !== 'string') {
          if (hover !== null && hover !== undefined) setHover(null)
          return
        }
        setHover({
          id,
          x: Number(event.clientX) || 0,
          y: Number(event.clientY) || 0,
          w: typeof window === 'undefined' ? 0 : window.innerWidth,
          h: typeof window === 'undefined' ? 0 : window.innerHeight,
        })
      }
      const onPointerLeave = () => {
        if (hover !== null && hover !== undefined) setHover(null)
      }

      const hoverId = hover === null || hover === undefined ? null : hover.id
      const summary = hoverId === null ? null : (askOf.get(hoverId) ?? { kind: 'none', date: '', title: '' })
      const tip =
        summary === null || hover === null || hover === undefined
          ? null
          : h(Tip, {
              x: hover.x,
              y: hover.y,
              w: hover.w,
              h: hover.h,
              head: [
                h('span', { key: 'id', className: 'dkf-tip-id' }, hoverId),
                h(
                  'span',
                  { key: 'meta', className: 'dkf-tip-meta' },
                  summary.kind === 'ask'
                    ? `ask · ${summary.date.slice(0, 10)}`
                    : summary.kind === 'last'
                      ? `最后一条动作 · ${summary.date.slice(0, 10)}`
                      : '快照里没有这条 issue',
                ),
              ],
              title: summary.title || '（还没有标题）',
            })

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
          onPointerDown,
          onPointerMove,
          onPointerLeave,
        }),
        tip,
        phase === 'ready' ? null : h('pre', { className: 'dkf-mermaid' }, built.source),
        h(EdgeLegend, { drawn: built.drawn }),
        built.ego && props.focusId !== null
          ? h(
              'p',
              { className: 'dkf-note' },
              `聚焦：${props.focusId} 与 ${depth} 跳内的 ${Math.max(0, built.byNode.size - 1)} 个邻居。`,
            )
          : null,
        !built.ego && built.hidden.edges > 0
          ? h(
              'p',
              { className: 'dkf-note' },
              `只画有向关系：另 ${built.hidden.edges} 条无向关联、${built.hidden.nodes} 个只挂在它们上面的 issue 没画；它们的关系可以到「聚焦」里看。`,
            )
          : null,
        edgeDimLost
          ? h('p', { className: 'dkf-note' }, '没在 SVG 里认出任何边元素，这一轮不做边淡化（Pele 可能改了 data-id 形态）。')
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

    /** 把 EDGE_STROKE 里的宽度与虚线拆出来，供图例画样条。 */
    function strokeOf(rel) {
      const decl = EDGE_STROKE[rel] ?? ''
      const width = Number(/stroke-width:([\d.]+)px/.exec(decl)?.[1] ?? 1.5)
      const dash = /stroke-dasharray:([^,;]+)/.exec(decl)?.[1]
      return { width, dash }
    }

    /** 图例：用与图上完全相同的 dasharray 画样条，让人能对上号。 */
    function EdgeLegend(props) {
      const drawn = props.drawn ?? new Set()
      return h(
        'div',
        { className: 'dkf-legend', role: 'list', 'aria-label': '关系线型图例' },
        EDGE_LEGEND.map((entry) => {
          const { width, dash } = strokeOf(entry.rel)
          const directed = entry.rel !== 'relates-to'
          const active = drawn.has(entry.rel)
          return h(
            'div',
            {
              key: entry.rel,
              role: 'listitem',
              className: `dkf-legend-row${active ? '' : ' dkf-legend-off'}`,
              'data-hint': active ? entry.rel : `${entry.rel}（当前视图没画这类关系）`,
            },
            h('span', { className: 'dkf-legend-end' }, 'A'),
            h(
              'svg',
              { width: 46, height: 12, viewBox: '0 0 46 12', className: 'dkf-legend-svg', 'aria-hidden': 'true' },
              h('line', {
                x1: 1,
                y1: 6,
                x2: directed ? 34 : 45,
                y2: 6,
                stroke: 'currentColor',
                strokeWidth: width,
                strokeDasharray: dash === undefined ? undefined : dash,
                strokeLinecap: 'round',
              }),
              directed
                ? h('polygon', {
                    points: '45,6 33,2 33,10',
                    fill: 'currentColor',
                  })
                : null,
            ),
            h('span', { className: 'dkf-legend-end' }, 'B'),
            h('span', { className: 'dkf-legend-text' }, entry.sentence),
          )
        }),
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

    function KilnView(props) {
      const cwd = typeof props.cwd === 'string' ? props.cwd : ''
      /** 测试缝：渲染用例不跑 effect，直接喂一份宿主搜索结果（生产恒为 null）。 */
      const searchFixture = globalThis.__DSH_KILN_TEST__ === true ? globalThis.__DSH_KILN_SEARCH_FIXTURE__ : null
      /** 同一条缝：时间线流在渲染用例里也不跑，喂一份已收完的流（生产恒为 null）。 */
      const timelineFixture = globalThis.__DSH_KILN_TEST__ === true ? globalThis.__DSH_KILN_TIMELINE_FIXTURE__ : null
      /** 词表在渲染用例里也不跑：直接喂 names/start/terminal（生产恒为 null）。 */
      const vocabFixture = globalThis.__DSH_KILN_TEST__ === true ? globalThis.__DSH_KILN_VOCAB_FIXTURE__ : null
      /** 关系图与详情同样留测试缝：渲染用例不跑 effect，直接喂宿主会返回的文档。 */
      const graphFixture = globalThis.__DSH_KILN_TEST__ === true ? globalThis.__DSH_KILN_GRAPH_FIXTURE__ : null
      const detailFixture = globalThis.__DSH_KILN_TEST__ === true ? globalThis.__DSH_KILN_DETAIL_FIXTURE__ : null
      const idBase = 'dsh-kiln-view'
      const memory = readViewState(cwd)
      /** 关系图只在关系页取；详情只在聚焦/展开时取。首屏不再预取整仓。 */
      const [graph, setGraph] = React.useState(EMPTY_GRAPH)
      const [nonce, setNonce] = React.useState(0)
      const [tabId, setTabId] = React.useState(memory.tabId)
      const [focusId, setFocusId] = React.useState(memory.focusId)
      const [expanded, setExpanded] = React.useState(memory.expanded)
      const [expandedChildren, setExpandedChildren] = React.useState(false)
      /** 焦点行默认展开（issue 页聚焦态读的就是它）；与三页共享的 `expanded` 分开，免得串页。 */
      const [focusOpen, setFocusOpen] = React.useState(true)
      const [graphDirection, setGraphDirection] = React.useState(memory.graphDirection === 'TB' ? 'TB' : 'LR')
      const [graphView, setGraphView] = React.useState(
        memory.graphView === 'focus' ? 'focus' : 'global',
      )
      const [graphDepth, setGraphDepth] = React.useState(memory.graphDepth === '2' ? '2' : '1')
      const [filterOpen, setFilterOpen] = React.useState(false)
      const [filters, setFilters] = React.useState(() => readFilters(memory.filters))
      const [rowFilters, setRowFilters] = React.useState(() => readRowFilters(memory.rowFilters))
      /** 搜索：查询串与结果里被选中的下标都只活在本次挂载（切页/卸载即清空）。 */
      const [query, setQuery] = React.useState('')
      const [searchIndex, setSearchIndex] = React.useState(-1)
      /** 选中一条"动作命中"的结果后要滚到的那一行（值 = 动作的提交 sha）。 */
      const [scrollTo, setScrollTo] = React.useState(null)
      /** 宿主返回的搜索结果；测试里由 __DSH_KILN_SEARCH_FIXTURE__ 覆盖（effect 不执行）。 */
      const [rawSearch, setRawSearch] = React.useState(EMPTY_SEARCH)
      /** 时间线：宿主 NDJSON 流收下来的行 + 阶段；测试里由 __DSH_KILN_TIMELINE_FIXTURE__ 覆盖。 */
      const [timeline, setTimeline] = React.useState(EMPTY_TIMELINE)
      /** 动作词表（start / terminal）：折叠 issue 索引要用；拿不到时 done 未知，不猜。 */
      const [vocab, setVocab] = React.useState(() => normalizeVocab(vocabFixture) ?? actionsCache.get(cwd) ?? null)
      /** 聚焦/详情的动作与边；点开才取，拿不到时只影响焦点区，不影响两个列表。 */
      const [detail, setDetail] = React.useState(EMPTY_DETAIL)
      /** 仓库级不可用（不是 kiln 仓库 / 找不到 kiln / 路径无效）：词表路由最先能判定。 */
      const [unavailable, setUnavailable] = React.useState(null)
      /** 虚拟列表：滚动位置、视口高度、测量版本（任一变化都重算行高表与可视区间）。 */
      const [scrollTop, setScrollTop] = React.useState(0)
      const [viewportH, setViewportH] = React.useState(VIRTUAL_MIN_VIEWPORT)
      const [heightsVersion, setHeightsVersion] = React.useState(0)
      /** 已测量的行高：`kind\u0000<行键>` → px；流在顶部插行也不会串。 */
      const heightsRef = React.useRef(new Map())
      const rootRef = React.useRef(null)
      const scrollRef = React.useRef(null)
      const searchRef = React.useRef(null)
      /** 中文输入法组合期间，回车是"上屏"不是"确认"，别让键盘处理抢先。 */
      const composing = React.useRef(false)
      /** 搜索 effect 通过 ref 读最新的 issue 索引（见搜索 effect 的依赖说明）。 */
      const byIdRef = React.useRef(new Map())
      /** hover 预取的延迟句柄：扫过列表时只取最后停下的那一行。 */
      const prefetchTimer = React.useRef(null)
      /** 布局后测量用；测试替身没有 useLayoutEffect 时退回 useEffect（测试不执行 effect）。 */
      const useIsoLayoutEffect =
        typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect

      /**
       * 提示框：元素上只写 `data-hint`，机制收在这里（根节点监听 pointerover 做委托）。
       * 12 个提示点因此不用把 hint 状态穿过组件链；图的节点提示另有一套状态（内容更富、跟随指针），
       * 但样式与定位共用同一个 Tip / tipPlacement。
       * 延迟取 260ms：原生 title 约 1s 太慢，即时又会在扫过列表时闪。
       */
      const HINT_DELAY = 260
      const [hint, setHint] = React.useState(null)
      const hintTimer = React.useRef(null)
      const hintNode = React.useRef(null)

      const clearHint = () => {
        if (hintTimer.current !== null) {
          clearTimeout(hintTimer.current)
          hintTimer.current = null
        }
        hintNode.current = null
        setHint(null)
      }

      const onHintOver = (event) => {
        const target = event.target
        const node =
          target === null || target === undefined || typeof target.closest !== 'function'
            ? null
            : target.closest('[data-hint]')
        if (node === hintNode.current) return
        clearHint()
        hintNode.current = node
        if (node === null || typeof node.getAttribute !== 'function') return
        const text = node.getAttribute('data-hint')
        if (text === null || text === '') return
        const x = event.clientX
        const y = event.clientY
        hintTimer.current = setTimeout(() => {
          hintTimer.current = null
          setHint({ x, y, text })
        }, HINT_DELAY)
      }

      React.useEffect(
        () => () => {
          if (hintTimer.current !== null) clearTimeout(hintTimer.current)
        },
        [],
      )

      /** 回到第一屏、滚动回顶：切页 / 换焦点 / 改筛选 / 刷新都走这里。 */
      const resetViewport = () => {
        setScrollTop(0)
        const node = scrollRef.current
        if (node !== null && node !== undefined) node.scrollTop = 0
      }

      const selectTab = (id) => {
        resetViewport()
        setTabId(id)
        // 点页签 = 离开搜索（否则结果页签与结果视图各说一套）
        setQuery('')
        setSearchIndex(-1)
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
      /** 方向会换掉 mermaid 文本，是唯一允许重排的显式操作（方向本身不跟焦点走）。 */
      const selectDirection = (id) => {
        const value = id === 'TB' ? 'TB' : 'LR'
        setGraphDirection(value)
        writeViewState(cwd, { graphDirection: value })
      }
      /** 视图 / 半径：都按仓库记忆；两者都会重排。 */
      const selectView = (id) => {
        const value = id === 'focus' ? 'focus' : 'global'
        setGraphView(value)
        writeViewState(cwd, { graphView: value })
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

      /**
       * 关系图：只在关系页取（`kiln graph --json`）。
       * 会话内按仓库缓存：切回页签先渲染缓存，再后台重取一次（有旧图就不闪空）；
       * 刷新时缓存被清掉，重新拉起。
       */
      React.useEffect(() => {
        if (graphFixture !== null && graphFixture !== undefined) return undefined
        if (cwd === '' || tabId !== 'relation') return undefined
        const controller = new AbortController()
        const cached = cacheGet(graphCache, cwd)
        setGraph((previous) => {
          // 换了仓库就不能拿上一份图顶着；同一仓库则保留旧图后台刷新，不闪空
          const reusable = cached ?? (previous.payload !== null && previous.payload.repo === cwd ? previous.payload : null)
          return { phase: reusable === null ? 'loading' : 'ready', payload: reusable, error: null }
        })
        ;(async () => {
          try {
            const response = await fetch(`${GRAPH_URL}?cwd=${encodeURIComponent(cwd)}`, {
              credentials: 'same-origin',
              signal: controller.signal,
              cache: 'no-store',
            })
            const body = await response.json()
            if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`)
            if (body?.ok !== true) {
              setGraph({ phase: 'error', payload: null, error: graphFailureText(body) })
              return
            }
            cacheSet(graphCache, cwd, body, 4)
            setGraph({ phase: 'ready', payload: body, error: null })
          } catch (error) {
            if (controller.signal.aborted) return
            setGraph({ phase: 'error', payload: null, error: String(error?.message ?? error) })
          }
        })()
        return () => controller.abort()
      }, [cwd, nonce, tabId, graphFixture])

      /**
       * 详情：聚焦一个 issue 时才取（`kiln path <id> --json`）。
       *
       * 动作、序号和这个 issue 的全部边都在这一份文档里。同一 (repo,id) 在会话内复用，
       * 再次聚焦不再起进程；hover 预取会先把缓存填上。刷新时清空。
       */
      React.useEffect(() => {
        if (detailFixture !== null && detailFixture !== undefined) return undefined
        if (cwd === '' || focusId === null) {
          setDetail(EMPTY_DETAIL)
          return undefined
        }
        const controller = new AbortController()
        const key = cacheKey(cwd, focusId)
        const cached = cacheGet(detailCache, key)
        if (cached !== undefined) {
          setDetail({ id: focusId, phase: 'ready', issue: cached, error: null })
          return () => controller.abort()
        }
        setDetail((previous) => ({
          id: focusId,
          phase: 'loading',
          issue: previous.id === focusId ? previous.issue : null,
          error: null,
        }))
        ;(async () => {
          try {
            const response = await fetch(
              `${ISSUE_URL}?cwd=${encodeURIComponent(cwd)}&id=${encodeURIComponent(focusId)}`,
              { credentials: 'same-origin', signal: controller.signal, cache: 'no-store' },
            )
            const body = await response.json()
            if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`)
            if (body?.ok !== true) {
              setDetail({ id: focusId, phase: 'error', issue: null, error: detailFailureText(body) })
              return
            }
            cacheSet(detailCache, key, body.issue)
            setDetail({ id: focusId, phase: 'ready', issue: body.issue, error: null })
          } catch (error) {
            if (controller.signal.aborted) return
            setDetail({ id: focusId, phase: 'error', issue: null, error: String(error?.message ?? error) })
          }
        })()
        return () => controller.abort()
      }, [cwd, focusId, nonce, detailFixture])

      /**
       * 时间线：订阅宿主 `/kiln/timeline`（宿主把 `kiln action log --jsonl` 原样转出来）。
       *
       * 上游没有终止记录，EOF 就是结束；宿主补一个 `done` 事件把「读完了」和退出码带过来。
       * 收行合批（50ms）刷新，350 条动作不会把 React 刷 350 次。离开页面 / 换仓库 / 刷新都
       * abort，宿主随之 kill 子进程。
       */
      React.useEffect(() => {
        if (timelineFixture !== null && timelineFixture !== undefined) return undefined
        if (cwd === '') {
          setTimeline(EMPTY_TIMELINE)
          return undefined
        }
        // 先拿上一次的行把页面画出来（切页不再白屏），再带 head 去问一句变没变
        const cached = timelineCache.get(cwd)
        if (cached !== undefined) {
          setTimeline({ rows: cached.rows, phase: 'done', error: null, ms: 0, count: cached.rows.length })
        }
        const controller = new AbortController()
        const startedAt = Date.now()
        const splitter = createLineSplitter()
        const decoder = new TextDecoder()
        const rows = []
        let bytes = 0
        let head = cached?.head ?? ''
        let error = null
        let settled = false
        let sawDone = false
        let timer = null
        /**
         * 有缓存时不把半截流画到屏幕上——那会把整张列表闪成几条。
         * 缓存先顶着，HEAD 变了就等流读完一次性换掉（最多多等一次传输的时间）。
         */
        const publish = (phase) => {
          if (cached !== undefined && phase !== 'done') return
          setTimeline({ rows: rows.slice(), phase, error, ms: Date.now() - startedAt, count: rows.length })
        }
        const schedule = () => {
          if (timer !== null) return
          timer = setTimeout(() => {
            timer = null
            if (!settled) publish('streaming')
          }, TIMELINE_FLUSH_MS)
        }
        const interner = createRowInterner(cached?.pool)
        const take = (line) => {
          const text = String(line ?? '').trim()
          if (text === '') return
          let event
          try {
            event = JSON.parse(text)
          } catch {
            error = `时间线输出不是 JSON：${text.slice(0, 120)}`
            return
          }
          // 行是 7 槽数组（format=2），事件是对象：按形状分流，不再靠 kind 标记每一行
          if (Array.isArray(event)) {
            if (typeof event[ROW.ISSUE] !== 'string' || typeof event[ROW.COMMIT] !== 'string') {
              error = `时间线行不是 7 槽数组：${text.slice(0, 120)}`
              return
            }
            rows.push(interner.intern(event))
            schedule()
            return
          }
          if (event?.kind === 'error') {
            error = String(event.message ?? '时间线读取失败')
            return
          }
          if (event?.kind === 'done') sawDone = true
        }
        const fail = (failure) => {
          settled = true
          error = String(failure?.message ?? failure)
          if (cached !== undefined) {
            // 缓存还能看，就把错误挂在它上面，而不是把列表清空
            setTimeline({ rows: cached.rows, phase: 'error', error, ms: Date.now() - startedAt, count: cached.rows.length })
            return
          }
          publish('error')
        }
        const run = async () => {
          try {
            const query = `${TIMELINE_URL}?cwd=${encodeURIComponent(cwd)}&format=${TIMELINE_FORMAT}${cached !== undefined ? `&head=${encodeURIComponent(cached.head)}` : ''}`
            const response = await fetch(query, {
              credentials: 'same-origin',
              signal: controller.signal,
              cache: 'no-store',
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            head = response.headers.get('x-kiln-head') ?? head
            const mode = response.headers.get('x-kiln-mode') ?? ''
            // 增量响应：body 里只有新增的行，读完要和手上那份拼起来
            const delta = mode === 'delta' && cached !== undefined
            if (mode === 'unchanged') {
              // 客户端这份就是最新的：一个字节都不用读，渲染保持缓存，只把耗时刷新一下
              settled = true
              if (timer !== null) {
                clearTimeout(timer)
                timer = null
              }
              try {
                await response.body?.cancel?.()
              } catch {
                // 空 body 取不取消都不影响
              }
              if (cached !== undefined) {
                setTimeline({
                  rows: cached.rows,
                  phase: 'done',
                  error: null,
                  ms: Date.now() - startedAt,
                  count: cached.rows.length,
                })
              }
              return
            }
            const reader = response.body?.getReader?.()
            if (reader === undefined || reader === null) throw new Error('当前环境不支持流式读取')
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              bytes += value?.byteLength ?? 0
              for (const line of splitter.push(decoder.decode(value, { stream: true }))) take(line)
            }
            for (const line of splitter.flush()) take(line)
            settled = true
            if (timer !== null) {
              clearTimeout(timer)
              timer = null
            }
            if (!sawDone && error === null) error = '时间线流被提前中断（没有收到收口事件）。'
            if (error === null && sawDone && delta === true) {
              // 只收到新增的几行：和本地那份拼起来，再整体存回
              const merged = mergeTimelineRows(rows, cached.rows)
              rememberTimeline(cwd, head, merged, bytes + cached.bytes, interner.pool)
              setTimeline({ rows: merged, phase: 'done', error: null, ms: Date.now() - startedAt, count: merged.length })
            } else if (error === null && sawDone) {
              rememberTimeline(cwd, head, rows.slice(), bytes, interner.pool)
              publish('done')
            } else {
              timelineCache.delete(cwd)
              if (cached !== undefined) {
                // 新流没读成：别拿半截覆盖缓存，挂着错误继续显示旧数据
                setTimeline({
                  rows: cached.rows,
                  phase: 'error',
                  error,
                  ms: Date.now() - startedAt,
                  count: cached.rows.length,
                })
              } else {
                publish('done')
              }
            }
          } catch (failure) {
            if (controller.signal.aborted) return
            fail(failure)
          }
        }
        publish('streaming')
        run()
        return () => {
          if (timer !== null) clearTimeout(timer)
          controller.abort()
        }
      }, [cwd, nonce, timelineFixture])

      /**
       * 动作词表：折叠 issue 索引要判断 done（最近动作 ∈ terminal）与“读到起点”（start）。
       * 一次进程、不读历史；按仓库缓存，重挂载不重取。拿不到就保持 null——done 未知，列表照常。
       */
      React.useEffect(() => {
        if (vocabFixture !== null && vocabFixture !== undefined) {
          setVocab(normalizeVocab(vocabFixture))
          return undefined
        }
        if (cwd === '') {
          setVocab(null)
          return undefined
        }
        const cached = actionsCache.get(cwd)
        if (cached !== undefined) {
          setVocab(cached)
          return undefined
        }
        const controller = new AbortController()
        ;(async () => {
          try {
            const response = await fetch(`${ACTIONS_URL}?cwd=${encodeURIComponent(cwd)}`, {
              signal: controller.signal,
              cache: 'no-store',
            })
            const body = await response.json()
            if (body?.ok !== true) {
              // 仓库级不可用（不是 kiln 仓库 / 找不到 kiln / 路径无效）要整块提示；
              // 旧版没有 action list 只影响 done 未知，不挡列表。
              if (body?.reason === 'not-kiln-repo' || body?.reason === 'invalid-dir' || body?.reason === 'kiln-missing') {
                setUnavailable({ reason: body.reason, message: body?.message ?? '' })
              }
              return
            }
            setUnavailable(null)
            const next = normalizeVocab(body.actions)
            if (next === null) return
            actionsCache.set(cwd, next)
            setVocab(next)
          } catch {
            // 旧版没有 action list，或宿主还没重启：done 未知，不猜也不挡列表
          }
        })()
        return () => controller.abort()
      }, [cwd, vocabFixture, nonce])

      // 切焦点时收起附属展开，并把焦点行重新展开：换焦点等于换一批邻居与一份动作
      React.useEffect(() => {
        setExpandedChildren(false)
        setFocusOpen(true)
      }, [focusId])

      // 关系图只服务关系页；两个列表都不依赖它。
      const graphPayload = graph.payload
      const graphIssues =
        graphPayload?.ok === true && Array.isArray(graphPayload.issues) ? graphPayload.issues : []
      const graphEdges =
        graphPayload?.ok === true && Array.isArray(graphPayload.edges) ? graphPayload.edges : []
      const relations = React.useMemo(() => canonicalEdges(graphEdges), [graphEdges])

      const timelineState = timelineFixture ?? timeline
      const timelineStreaming = timelineState.phase === 'streaming'
      const timelineError = timelineState.error ?? null

      /** issue 索引只来自动作流：折叠规则已在真仓对齐 list（23/23、70/70），不再和快照合并。 */
      const streamIssues = React.useMemo(
        () =>
          foldIssues(timelineState.rows, {
            start: vocab?.start ?? '',
            terminal: vocab?.terminal ?? null,
            complete: timelineState.phase === 'done',
          }),
        [timelineState.rows, timelineState.phase, vocab],
      )
      const byId = React.useMemo(() => new Map(streamIssues.map((issue) => [issue.id, issue])), [streamIssues])
      // 搜索 effect 通过 ref 读它：流式期间 byId 每批都换新，不该因此 abort 重发搜索
      byIdRef.current = byId

      /** 详情只补“这个 issue 的边”（以及 path 给出的序号/refs）；动作在流里本来就有。 */
      const detailIssue = detailFixture ?? (detail.id === focusId ? detail.issue : null)
      const detailPhase =
        detailFixture !== null && detailFixture !== undefined
          ? 'ready'
          : detail.id === focusId
            ? detail.phase
            : 'idle'
      const focusRow = focusId === null ? null : (byId.get(focusId) ?? null)
      const focus = React.useMemo(() => {
        if (focusRow === null) return null
        const fromDetail = Array.isArray(detailIssue?.actions) ? detailIssue.actions : []
        const actions = fromDetail.length > 0 ? fromDetail : focusRow.actions
        return { ...focusRow, actions, last: actions[actions.length - 1] ?? null }
      }, [focusRow, detailIssue])
      const view = React.useMemo(() => {
        if (focus === null) return null
        const edges = Array.isArray(detailIssue?.relations) ? detailIssue.relations : []
        return relatedOf(focus.id, canonicalEdges(edges))
      }, [focus, detailIssue])
      const rows = React.useMemo(() => scopeTimeline(timelineState.rows, view), [timelineState.rows, view])
      const issueList = React.useMemo(
        () => sortIssues(view === null ? streamIssues : scopedIssues(streamIssues, view), focus?.id ?? null),
        [streamIssues, view, focus],
      )
      /** issue 页的“还在读”：列表来自流，读数要说清。 */
      const issueStreaming = timelineStreaming

      /**
       * 搜索：宿主路由 → `kiln list --search --json`；整仓范围，不看筛选与焦点。
       * 输入停 120ms 再发，新查询会 abort 旧请求；高亮与键盘交互仍在客户端。
       */
      const searching = splitTerms(query).length > 0
      const searchState = searchFixture ?? rawSearch ?? EMPTY_SEARCH
      React.useEffect(() => {
        if (searchFixture !== null && searchFixture !== undefined) return
        const terms = splitTerms(query)
        if (terms.length === 0) {
          setRawSearch(EMPTY_SEARCH)
          return
        }
        // 同一个词在本会话里查过就直接回放：回退 / 重输不再起进程
        const key = cacheKey(cwd, query)
        const cached = cacheGet(searchCache, key)
        if (cached !== undefined) {
          setRawSearch({ query, rows: cached.rows, pending: false, ms: 0, count: cached.count, error: null })
          return
        }
        const controller = new AbortController()
        let cancelled = false
        const startedAt = Date.now()
        setRawSearch((previous) => ({ ...previous, pending: true, error: null }))
        const timer = setTimeout(async () => {
          try {
            const response = await fetch(
              `${SEARCH_URL}?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`,
              { signal: controller.signal, cache: 'no-store' },
            )
            const body = await response.json()
            if (cancelled) return
            if (body?.ok !== true) {
              setRawSearch({
                query,
                rows: [],
                pending: false,
                ms: Date.now() - startedAt,
                count: 0,
                error: searchFailureText(body),
              })
              return
            }
            const rows = mapSearchRows(body.document, byIdRef.current, terms)
            const count = Number.isInteger(body.document?.count) ? body.document.count : rows.length
            cacheSet(searchCache, key, { rows, count })
            setRawSearch({
              query,
              rows,
              pending: false,
              ms: Date.now() - startedAt,
              count,
              error: null,
            })
          } catch (error) {
            if (cancelled || error?.name === 'AbortError') return
            setRawSearch({
              query,
              rows: [],
              pending: false,
              ms: Date.now() - startedAt,
              count: 0,
              error: String(error?.message ?? error),
            })
          }
        }, SEARCH_DEBOUNCE_MS)
        return () => {
          cancelled = true
          clearTimeout(timer)
          controller.abort()
        }
      }, [query, cwd, nonce, searchFixture])

      const searchPending =
        searching &&
        (searchFixture === null || searchFixture === undefined) &&
        (searchState.pending === true || searchState.query !== query)
      const searchResults = searchPending ? [] : Array.isArray(searchState.rows) ? searchState.rows : []
      const searchMs = searchState.ms ?? 0
      const searchTotal = searchResults.length
      const searchError =
        searchFixture === null || searchFixture === undefined ? (searchState.error ?? null) : null

      const clearSearch = () => {
        setQuery('')
        setSearchIndex(-1)
      }
      /**
       * 选中一条结果：
       *   · 命中 issue 名 / 当前标题 → 聚焦 + issue 页（看结构）；
       *   · 命中某条动作的标题 → 聚焦 + 时间线 + 展开那条动作 + 滚到它（"找到的是那句话，就带你到那句话"）。
       */
      const pickSearch = (row) => {
        const id = row === null || row === undefined ? '' : String(row.issue?.id ?? '')
        if (id === '') return
        const hitAction = typeof row.actionId === 'string' && row.actionId !== '' ? row.actionId : null
        clearSearch()
        focusIssue(id)
        if (hitAction === null) {
          selectTab('issue')
          return
        }
        const expanded = { kind: 'action', id: hitAction }
        selectTab('timeline')
        setExpanded(expanded)
        writeViewState(cwd, { expanded })
        setScrollTo(hitAction)
      }
      const onSearchKeyDown = (event) => {
        if (composing.current) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (query !== '') clearSearch()
          else if (searchRef.current !== null && typeof searchRef.current.blur === 'function') searchRef.current.blur()
          return
        }
        if (searchResults.length === 0) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const delta = event.key === 'ArrowDown' ? 1 : -1
          setSearchIndex(nextSearchIndex(searchIndex, searchResults.length, delta))
          return
        }
        if (event.key === 'Enter') {
          const index = Number.isFinite(searchIndex) && searchIndex >= 0 ? searchIndex : 0
          const row = searchResults[index]
          if (row !== undefined) {
            event.preventDefault()
            pickSearch(row)
          }
        }
      }
      // 查询变了就把选中退回第一条：否则清空再输入还停在上次的下标上
      React.useEffect(() => {
        setSearchIndex(-1)
      }, [query])

      // 从搜索结果跳到某条动作、以及 ↑/↓ 把选中带进视口的滚动，都放在虚拟列表计算之后

      /**
       * 刷新 = 丢掉本仓库的会话缓存（图 / 详情 / 搜索）再重读动作流。
       * 缓存只活一次挂载，刷新后一切按当前历史重建。
       */
      const refresh = () => {
        clearRepoCaches(cwd)
        setNonce((value) => value + 1)
      }

      /** 取一条详情（点开与 hover 预取共用）：同一 (repo,id) 同时只发一次。 */
      const prefetchDetail = (id) => {
        if (cwd === '' || typeof id !== 'string' || id === '') return
        const key = cacheKey(cwd, id)
        if (detailCache.has(key) || detailInflight.has(key)) return
        const promise = fetch(
          `${ISSUE_URL}?cwd=${encodeURIComponent(cwd)}&id=${encodeURIComponent(id)}`,
          { credentials: 'same-origin', cache: 'no-store' },
        )
          .then((response) => response.json())
          .then((body) => {
            if (body?.ok === true && body.issue !== undefined) cacheSet(detailCache, key, body.issue)
          })
          .catch(() => {})
          .finally(() => detailInflight.delete(key))
        detailInflight.set(key, promise)
      }

      /** hover 停在行上 120ms 才预取：扫过列表不会取一整屏。 */
      const schedulePrefetch = (id) => {
        if (prefetchTimer.current !== null) clearTimeout(prefetchTimer.current)
        prefetchTimer.current = setTimeout(() => {
          prefetchTimer.current = null
          prefetchDetail(id)
        }, PREFETCH_MS)
      }

      /** 页签意图：鼠标移到「关系」页签就先取图，点开即开。 */
      const prefetchGraph = () => {
        if (cwd === '' || graphCache.has(cwd) || graphInflight.has(cwd)) return
        const promise = fetch(`${GRAPH_URL}?cwd=${encodeURIComponent(cwd)}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        })
          .then((response) => response.json())
          .then((body) => {
            if (body?.ok === true) cacheSet(graphCache, cwd, body, 4)
          })
          .catch(() => {})
          .finally(() => graphInflight.delete(cwd))
        graphInflight.set(cwd, promise)
      }

      React.useEffect(
        () => () => {
          if (prefetchTimer.current !== null) clearTimeout(prefetchTimer.current)
        },
        [],
      )

      const graphHint =
        graph.phase === 'ready'
          ? `${graphPayload?.cache?.action ?? 'ready'}${typeof graphPayload?.cache?.ms === 'number' ? ` · ${graphPayload.cache.ms}ms` : ''}`
          : graph.phase === 'error'
            ? '读取失败'
            : '未取'

      const header = h(
        'div',
        { className: 'dkf-head' },
        h(
          'span',
          {
            className: 'dkf-repo',
            'data-hint':
              unavailable !== null
                ? `${cwd}\n${unavailableText(unavailable)}`
                : `${cwd}\n动作流：${timelineState.rows.length} 条${timelineStreaming ? '（读取中）' : ''} · ${timelineState.ms}ms\n关系图：${graphHint}`,
          },
          basename(cwd) || 'kiln',
        ),
        h('input', {
          className: 'dkf-search',
          type: 'text',
          value: query,
          placeholder: '搜索 issue…',
          'aria-label': '搜索 issue',
          spellCheck: false,
          autoComplete: 'off',
          ref: searchRef,
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: onSearchKeyDown,
          onCompositionStart: () => {
            composing.current = true
          },
          onCompositionEnd: () => {
            composing.current = false
          },
        }),
        h(
          'div',
          { className: 'dkf-head-actions' },
          focus !== null
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dkf-focuschip',
                  onClick: clearFocus,
                  'data-hint': '退出聚焦，回到全局（Esc）',
                  'aria-label': `退出聚焦 ${focus.id}`,
                },
                h('span', { className: 'dkf-focuschip-prefix' }, '焦点：'),
                h('span', { className: 'dkf-focuschip-label' }, focus.id),
                h('span', { className: 'dkf-focuschip-x', 'aria-hidden': 'true' }, '×'),
              )
            : null,
          h(
            'button',
            { type: 'button', className: 'dkf-refresh', onClick: refresh, 'data-hint': '重新读取动作流、关系图与详情' },
            h('span', { className: 'dkf-refresh-label' }, '刷新'),
            h('span', { className: 'dkf-refresh-icon', 'aria-hidden': 'true' }, '↻'),
          ),
        ),
      )

      /**
       * 第二层页头：左页切换，右「当前页的计数或工具」。
       * 关系页放三段取景控件，其余两页放计数——三页的第二层永远存在、同高、内容右对齐。
       */
      const pageTools =
        tabId === 'relation'
          ? [
              h(Segmented, {
                key: 'direction',
                label: '图的布局方向',
                options: GRAPH_DIRECTIONS,
                active: graphDirection,
                onSelect: selectDirection,
              }),
              h(Segmented, {
                key: 'view',
                label: '视图',
                options: GRAPH_VIEWS,
                active: graphView,
                onSelect: selectView,
              }),
              graphView === 'focus'
                ? h(Segmented, {
                    key: 'depth',
                    label: '聚焦的半径',
                    options: GRAPH_DEPTHS,
                    active: graphDepth,
                    onSelect: selectDepth,
                  })
                : null,
            ]
          : null

      /**
       * 筛选只作用在 issue 页的列表（无焦点时）；聚焦读的是结构，不掺筛选。
       * 可选项来自快照本身：只有一个领域就不给"领域"组，没有标签就不给"标签"组。
       */
      const facets = React.useMemo(() => issueFacets(issueList), [issueList])
      const activeFilters = readFilters(filters)
      const filteredIssues = React.useMemo(() => filterIssues(issueList, activeFilters), [issueList, activeFilters])
      const filterOn = filtersActive(activeFilters)
      const filterCount = activeFilters.domains.length + activeFilters.states.length
      const filterGroups = facets.domains.length + facets.states.length
      const canFilter = tabId === 'issue' && focus === null && filterGroups > 0

      const toggleFilter = (groupId, id) => {
        setFilters((previous) => {
          const base = readFilters(previous)
          const list = Array.isArray(base[groupId]) ? base[groupId] : []
          const next = {
            ...base,
            [groupId]: list.includes(id) ? list.filter((value) => value !== id) : [...list, id],
          }
          writeViewState(cwd, { filters: next })
          return next
        })
      }
      const clearFilters = () => {
        setFilters(EMPTY_FILTERS)
        writeViewState(cwd, { filters: EMPTY_FILTERS })
      }

      /** 时间线：筛的是动作（行就是动作），维度是动作名与它所属 issue 的领域。 */
      const rowFacetData = React.useMemo(() => rowFacets(rows, byId), [rows, byId])
      const activeRowFilters = readRowFilters(rowFilters)
      const filteredRows = React.useMemo(
        () => filterRows(rows, activeRowFilters, byId),
        [rows, activeRowFilters, byId],
      )
      const rowFilterOn = filtersActive(activeRowFilters)
      const rowFilterCount = activeRowFilters.actions.length + activeRowFilters.domains.length
      const canFilterRows = tabId === 'timeline' && rowFacetData.actions.length + rowFacetData.domains.length > 0

      /**
       * 虚拟列表：只挂“可视区 ± overscan”的行；数据仍是全量（动作流/搜索结果都在内存）。
       * 高度没测过的行按 ROW_ESTIMATE 估，挂出来之后按真实高度修正；流在顶部插行也不会串。
       */
      const virtualKind = searching
        ? 'search'
        : tabId === 'timeline'
          ? 'timeline'
          : tabId === 'issue' && focus === null
            ? 'issue'
            : null
      const virtualRows =
        virtualKind === 'search'
          ? searchResults
          : virtualKind === 'timeline'
            ? filteredRows
            : virtualKind === 'issue'
              ? filteredIssues
              : []
      const activeOffsets = React.useMemo(
        () => buildOffsets(virtualRows, virtualKind ?? '', heightsRef.current),
        [virtualRows, virtualKind, heightsVersion],
      )
      const activeWindow = React.useMemo(
        () => virtualWindow(activeOffsets, virtualRows.length, scrollTop, viewportH),
        [activeOffsets, virtualRows.length, scrollTop, viewportH],
      )
      const activeSlice = React.useMemo(
        () => virtualRows.slice(activeWindow.start, activeWindow.end),
        [virtualRows, activeWindow],
      )

      const onScroll = (event) => {
        clearHint()
        const node = event.currentTarget
        if (node !== null && node !== undefined) setScrollTop(node.scrollTop)
      }

      /** 键盘走到最后一行时，让滚动容器再走一小段，虚拟列表会挂出下一批。 */
      const scrollMore = () => {
        const node = scrollRef.current
        if (node !== null && node !== undefined) node.scrollTop += ROW_ESTIMATE * 4
      }

      // 渲染后按真实高度修正估算；只在高度变化时 bump 版本，避免自激循环
      useIsoLayoutEffect(() => {
        const root = scrollRef.current
        if (root === null || root === undefined) return
        const viewport = typeof root.clientHeight === 'number' ? root.clientHeight : 0
        if (viewport > 0 && Math.abs(viewport - viewportH) > 1) setViewportH(viewport)
        const nodes =
          typeof root.querySelectorAll === 'function' ? Array.from(root.querySelectorAll('[data-vkey]')) : []
        let changed = false
        for (const node of nodes) {
          const key = `${virtualKind ?? ''}\u0000${node.getAttribute('data-vkey') ?? ''}`
          const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null
          const height = rect === null ? 0 : rect.height
          if (height > 0 && heightsRef.current.get(key) !== height) {
            heightsRef.current.set(key, height)
            changed = true
          }
        }
        if (changed) setHeightsVersion((value) => value + 1)
      })

      // 视口尺寸变化（拖窗口、切布局）要重新算区间
      React.useEffect(() => {
        const root = scrollRef.current
        if (root === null || root === undefined || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(() => setViewportH(root.clientHeight))
        observer.observe(root)
        return () => observer.disconnect()
      }, [cwd])

      // 换焦点 / 改筛选 / 改查询 / 换仓库 / 刷新：回到第一屏
      React.useEffect(() => {
        resetViewport()
      }, [cwd, focusId, query, filters, rowFilters, nonce])

      /**
       * 从搜索结果跳到某条动作：按高度表直接滚到目标索引（虚拟列表里目标行可能还没挂）。
       * 目标还没进数据就等流继续送，流结束仍没有才放弃。
       */
      React.useEffect(() => {
        if (scrollTo === null) return
        const index = filteredRows.findIndex((row) => actionKey(row) === scrollTo)
        const plan = jumpPlan(index, timelineStreaming)
        if (plan === 'wait') return
        if (plan === 'give-up') {
          setScrollTo(null)
          return
        }
        const node = scrollRef.current
        if (node !== null && node !== undefined) {
          const offset = activeOffsets[index]
          node.scrollTop = Math.max(0, (Number.isFinite(offset) ? offset : 0) - viewportH / 2)
        }
        setScrollTo(null)
      }, [scrollTo, filteredRows, activeOffsets, viewportH, timelineStreaming])

      // ↑/↓ 选中后把它带进视口：按搜索结果的行高表滚到居中位置
      React.useEffect(() => {
        if (searchIndex < 0 || virtualKind !== 'search') return
        const node = scrollRef.current
        if (node === null || node === undefined) return
        const offset = activeOffsets[searchIndex]
        node.scrollTop = Math.max(0, (Number.isFinite(offset) ? offset : 0) - viewportH / 2)
      }, [searchIndex, activeOffsets, virtualKind, viewportH])

      const toggleRowFilter = (groupId, id) => {
        setRowFilters((previous) => {
          const base = readRowFilters(previous)
          const list = Array.isArray(base[groupId]) ? base[groupId] : []
          const next = {
            ...base,
            [groupId]: list.includes(id) ? list.filter((value) => value !== id) : [...list, id],
          }
          writeViewState(cwd, { rowFilters: next })
          return next
        })
      }
      const clearRowFilters = () => {
        setRowFilters(EMPTY_ROW_FILTERS)
        writeViewState(cwd, { rowFilters: EMPTY_ROW_FILTERS })
      }

      const rowTools = [
        canFilterRows
          ? h(
              'button',
              {
                key: 'filter',
                type: 'button',
                className: cls('dkf-modebtn', filterOpen && 'dkf-modebtn-active'),
                'aria-expanded': filterOpen,
                'data-hint': filterOpen ? '收起筛选' : '按动作 / 领域筛选',
                onClick: () => setFilterOpen((value) => !value),
              },
              rowFilterOn ? `筛选 ${rowFilterCount}` : '筛选',
            )
          : null,
        h(
          'span',
          { key: 'count', className: 'dkf-count' },
          rowFilterOn && canFilterRows
            ? `${filteredRows.length} / ${rows.length} 个动作${timelineStreaming ? ' · 读取中…' : ''}`
            : `${rows.length} 个动作${timelineStreaming ? ' · 读取中…' : ''}`,
        ),
      ]

      const issueTools = [
        canFilter
          ? h(
              'button',
              {
                key: 'filter',
                type: 'button',
                className: cls('dkf-modebtn', filterOpen && 'dkf-modebtn-active'),
                'aria-expanded': filterOpen,
                'data-hint': filterOpen ? '收起筛选' : '按领域 / 状态 / 标签筛选',
                onClick: () => setFilterOpen((value) => !value),
              },
              filterOn ? `筛选 ${filterCount}` : '筛选',
            )
          : null,
        h(
          'span',
          { key: 'count', className: 'dkf-count' },
          filterOn && canFilter
            ? `${filteredIssues.length} / ${issueList.length} issue${issueStreaming ? ' · 读取中…' : ''}`
            : `${issueList.length} 个 issue${issueStreaming ? ' · 读取中…' : ''}`,
        ),
      ]

      const bar =
        cwd !== '' && unavailable === null
          ? h(
              'div',
              { className: 'dkf-bar' },
              h(PageTabs, {
                pages: PAGES,
                active: tabId,
                onSelect: selectTab,
                idBase,
                onIntent: (id) => {
                  if (id === 'relation') prefetchGraph()
                },
              }),
              h(
                'div',
                { className: 'dkf-bar-tools' },
                searching
                  ? searchPending
                    ? h('span', { key: 'hits', className: 'dkf-count' }, '搜索中…')
                    : searchError
                      ? h('span', { key: 'hits', className: 'dkf-count' }, '搜索失败')
                      : h(
                          'span',
                          { key: 'hits', className: 'dkf-count' },
                          `${searchTotal} 条命中 · ${searchMs}ms · 仓库共 ${issueList.length} 条`,
                        )
                  : pageTools !== null
                    ? pageTools
                    : tabId === 'issue'
                      ? issueTools
                      : rowTools,
              ),
            )
          : null

      let body = null
      if (cwd === '') {
        body = h(
          'div',
          { className: 'dkf-error' },
          h('p', { className: 'dkf-error-title' }, '当前会话没有工作区路径'),
          h('p', { className: 'dkf-error-detail' }, 'Flow 以会话工作区为仓库根；请在一个 kiln 仓库里打开会话。'),
        )
      } else if (unavailable !== null) {
        body = h(
          'div',
          { className: 'dkf-error' },
          h('p', { className: 'dkf-error-title' }, 'kiln 暂不可用'),
          h('p', { className: 'dkf-error-detail' }, unavailableText(unavailable)),
          h('p', { className: 'dkf-error-detail' }, cwd),
        )
      } else {
        let content = null
        if (searching) {
          // 有输入就整块换成结果：搜索是"直接找那一条"，不掺页面与筛选
          content = searchPending
            ? h(
                'div',
                { className: 'dkf-empty', 'aria-live': 'polite' },
                h('p', null, '搜索中…'),
              )
            : searchError !== null
              ? h(
                  'div',
                  { className: 'dkf-error' },
                  h('p', { className: 'dkf-error-title' }, '搜索失败'),
                  h('p', { className: 'dkf-error-detail' }, searchError),
                )
              : h(SearchResults, {
                  rows: activeSlice,
                  start: activeWindow.start,
                  vtop: activeWindow.top,
                  vbottom: activeWindow.bottom,
                  query,
                  selected: searchIndex,
                  onPick: pickSearch,
                })
        } else if (tabId === 'timeline') {
          content = h(TimelinePanel, {
            rows: activeSlice,
            vtop: activeWindow.top,
            vbottom: activeWindow.bottom,
            onEdge: scrollMore,
            expanded,
            onToggle: toggleExpand,
            onFocus: focusIssue,
            onPrefetch: schedulePrefetch,
            emptyText: rowFilterOn
              ? timelineStreaming
                ? '筛选中，继续加载…'
                : '没有符合筛选条件的动作。'
              : timelineStreaming
                ? '正在读取动作…'
                : timelineError !== null
                  ? '时间线读取失败。'
                  : focus === null
                    ? '还没有任何 kiln 动作。'
                    : '焦点与相关 issue 还没有动作。',
          })
        } else if (tabId === 'issue') {
          // 有焦点 = 读结构（母 / 子 / 强关系 / 弱关联），边由详情现取；没焦点 = 一行一个 issue
          if (focusId !== null && focus === null) {
            content = h(
              'p',
              { className: 'dkf-empty' },
              issueStreaming
                ? '正在读取焦点 issue…'
                : `焦点 ${focusId} 不在动作流里（可能已删除或改名）。`,
            )
          } else if (focus === null) {
            content = h(IssuePanel, {
              issues: activeSlice,
              vtop: activeWindow.top,
              vbottom: activeWindow.bottom,
              onEdge: scrollMore,
              focusId: null,
              expanded,
              onToggle: toggleExpand,
              onFocus: focusIssue,
              onPrefetch: schedulePrefetch,
              emptyText: filterOn
                ? issueStreaming
                  ? '筛选中，继续加载…'
                  : '没有符合筛选条件的 issue。'
                : issueStreaming
                  ? '正在读取 issue…'
                  : '这个仓库还没有 issue。',
            })
          } else {
            content = h(
              React.Fragment,
              null,
              detailPhase === 'error' && detail !== null && detail.error !== null
                ? h('p', { className: 'dkf-note' }, detail.error)
                : null,
              h(IssueFocusList, {
                focus,
                view,
                byId,
                expanded,
                focusOpen,
                expandedChildren,
                onToggle: toggleExpand,
                onToggleFocus: () => setFocusOpen((value) => !value),
                onFocus: focusIssue,
                onPrefetch: schedulePrefetch,
                onToggleChildren: () => setExpandedChildren((value) => !value),
              }),
            )
          }
        } else {
          if (graph.payload === null && graph.phase === 'loading') {
            content = h('p', { className: 'dkf-empty' }, '读取关系图…')
          } else if (graph.payload === null && graph.phase === 'error') {
            content = h('p', { className: 'dkf-note' }, graph.error)
          } else {
            content = h(GraphPanel, {
              issues: graphIssues,
              relations,
              focusId: focus === null ? null : focus.id,
              direction: graphDirection,
              graphView,
              depth: graphDepth,
              onFocus: focusIssue,
            })
          }
        }

        body = h(
          React.Fragment,
          null,
          !searching && tabId === 'timeline' && timelineError !== null
            ? h('p', { className: 'dkf-note' }, timelineError)
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

      const hintTip =
        hint === null || hint === undefined
          ? null
          : h(Tip, {
              x: hint.x,
              y: hint.y,
              w: typeof window === 'undefined' ? 0 : window.innerWidth,
              h: typeof window === 'undefined' ? 0 : window.innerHeight,
              title: hint.text,
            })

      return h(
        'div',
        {
          className: 'dkf-root',
          ref: rootRef,
          // 提示走委托：进入/离开/按下都从这里收口，元素上只留 data-hint
          onPointerOver: onHintOver,
          onPointerLeave: clearHint,
          onPointerDown: clearHint,
          onKeyDown: (event) => {
            if (event.key === 'Escape' && focus !== null) {
              event.preventDefault()
              clearFocus()
            }
          },
        },
        header,
        bar,
        // 筛选条只在展开时出现，紧贴页栏下面（不跟着内容滚走）；搜索期间让位给结果
        !searching && filterOpen && canFilterRows
          ? h(FilterRow, {
              groups: ROW_FILTER_GROUPS,
              facets: rowFacetData,
              active: activeRowFilters,
              onToggle: toggleRowFilter,
              onClear: clearRowFilters,
            })
          : !searching && filterOpen && canFilter
            ? h(FilterRow, {
                groups: FILTER_GROUPS,
                facets,
                active: activeFilters,
                onToggle: toggleFilter,
                onClear: clearFilters,
              })
            : null,
        // 滚动时内容从提示框底下走，必须收起来
        h('div', { className: 'dkf-scroll', ref: scrollRef, onScroll }, body),
        hintTip,
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

    return { name: '@jackiehank/dsh-kiln', inject, apply, ...(globalThis.__DSH_KILN_TEST__ === true ? { __internals: { paintFocus, buildMermaid, graphTiers, relatedOf, REL_SIDES, issueSummary, tipPlacement, graphFontSize, issueFacets, filterIssues, filtersActive, readFilters, rowFacets, filterRows, readRowFilters, filterGroups: FILTER_GROUPS, splitTerms, mapSearchRows, matchRanges, mergeRanges, foldIssues, normalizeVocab, scopeTimeline, cacheKey, cacheGet, cacheSet, clearRepoCaches, actionsCache, timelineCache, rememberTimeline, mergeTimelineRows, nextSearchIndex, jumpPlan, rowKeyOf, buildOffsets, virtualWindow, ROW, rowIssue, rowAction, rowCommit, rowDate, rowTitle, rowDomain, rowShort, rowTags, createRowInterner, css: CSS } } : {}) }
  },
})
