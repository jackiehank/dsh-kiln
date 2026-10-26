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
    /**
     * 筛选的三个维度。来源只有快照里已有的字段：domain / tags / done。
     * 顺序是"越常用越靠左"；某组在本仓没有可选项时整组不渲染（见 issueFacets）。
     */
    const FILTER_GROUPS = [
      { id: 'domains', label: '领域' },
      { id: 'states', label: '状态' },
      { id: 'tags', label: '标签' },
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
    const EMPTY_FILTERS = { domains: [], tags: [], states: [] }
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
.dkf-refresh:hover,.dkf-focuschip:hover,.dkf-tab:hover,.dkf-modebtn:hover,.dkf-row:hover,.dkf-focus:hover,.dkf-crumb:hover,.dkf-subrow:hover,.dkf-arow:hover,.dkf-toggle:hover,.dkf-focusbtn:hover,.dkf-filterbtn:hover,.dkf-filter-clear:hover{background-image:linear-gradient(var(--dkf-hover),var(--dkf-hover))}
.dkf-refresh:hover,.dkf-focuschip:hover,.dkf-tab:hover,.dkf-modebtn:hover,.dkf-crumb:hover,.dkf-toggle:hover,.dkf-focusbtn:hover,.dkf-filterbtn:hover,.dkf-filter-clear:hover{color:var(--dkf-fg)}
/* 页头第一层：只放身份与全局动作 */
.dkf-head{display:flex;align-items:center;gap:8px;padding:0 12px;min-height:34px;border-bottom:.5px solid var(--dkf-line);flex:none}
.dkf-repo{font-size:var(--dkf-fs-body);line-height:var(--dkf-lh-body);font-weight:600;color:var(--dkf-fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dkf-spacer{flex:1}
.dkf-refresh,.dkf-focuschip{all:unset;cursor:pointer;display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:var(--dkf-r);color:var(--dkf-fg2);white-space:nowrap;font-family:var(--dkf-sans);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-focuschip{font-family:var(--dkf-mono);color:var(--dkf-fg);box-shadow:inset 0 0 0 .5px var(--dkf-line-2);max-width:320px;overflow:hidden;text-overflow:ellipsis}
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
/* 列表：三页共用同一套列宽，同名列落在同一 x */
.dkf-list{display:flex;flex-direction:column;outline:none;position:relative}
/* 竖脊：时间线的“有序”由这一条线承担，色点压在线上 */
.dkf-rail::before{content:'';position:absolute;left:12px;top:12px;bottom:12px;width:1px;background:var(--dkf-line)}
.dkf-row{display:grid;grid-template-columns:auto 10px auto auto minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:4px 6px;border-radius:var(--dkf-r);min-width:0;outline:none}
.dkf-row:focus-visible,.dkf-arow:focus-visible{box-shadow:inset 0 0 0 2px var(--dkf-accent)}
.dkf-focus{background:var(--dkf-bg2);box-shadow:inset 0 0 0 .5px var(--dkf-line)}
.dkf-clickable{cursor:pointer}
.dkf-indent{margin-left:18px}
.dkf-crumb{color:var(--dkf-fg2);cursor:pointer;padding:2px 6px;width:max-content;border-radius:var(--dkf-r);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-strip{display:inline-flex;gap:1px;align-items:center}
.dkf-block{width:3px;height:11px;border-radius:1px;background:var(--dkf-fg3);opacity:.55}
.dkf-block-current{height:13px;opacity:1}
.dkf-caret{color:var(--dkf-fg3);width:10px;text-align:center;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-id{font-family:var(--dkf-mono);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta);font-weight:500;color:var(--dkf-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.dkf-edge{font-family:var(--dkf-mono);color:var(--dkf-fg3)}
.dkf-badges{display:inline-flex;gap:4px;align-items:center;flex:none}
.dkf-chip{padding:0 4px;border-radius:var(--dkf-r);color:var(--dkf-fg2);white-space:nowrap;box-shadow:inset 0 0 0 .5px var(--dkf-line);font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-chip-done{color:var(--dkf-ok);box-shadow:inset 0 0 0 .5px currentColor}
.dkf-chip-action{color:var(--dkf-row-color,var(--dkf-fg2))}
.dkf-title{color:var(--dkf-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dkf-fs-body);line-height:var(--dkf-lh-body)}
.dkf-ago{color:var(--dkf-fg3);white-space:nowrap;font-variant-numeric:tabular-nums;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-focusbtn{all:unset;cursor:pointer;color:var(--dkf-fg3);white-space:nowrap;padding:0 5px;border-radius:var(--dkf-r);opacity:0;font-size:var(--dkf-fs-meta);line-height:var(--dkf-lh-meta)}
.dkf-row:hover .dkf-focusbtn,.dkf-row:focus-within .dkf-focusbtn,.dkf-arow:hover .dkf-focusbtn,.dkf-arow:focus-within .dkf-focusbtn{opacity:1}
.dkf-focusbtn:focus-visible{opacity:1}
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

    /**
     * 筛选：同组内多选是 OR（领域 A 或 B），组间是 AND（领域 A 且标签 x）。
     * 只认快照里已有的字段（domain / tags / done），不猜"应该有什么"。
     */
    function readFilters(value) {
      const source = value === null || value === undefined ? EMPTY_FILTERS : value
      return {
        domains: Array.isArray(source.domains) ? source.domains.slice() : [],
        tags: Array.isArray(source.tags) ? source.tags.slice() : [],
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
        if (filters.actions.length > 0 && !filters.actions.includes(row.action)) return false
        if (filters.domains.length > 0) {
          const domain = byId?.get?.(row.issueId)?.domain ?? ''
          if (!filters.domains.includes(domain)) return false
        }
        return true
      })
    }

    /**
     * 时间线可筛的值：动作名（按出现次数）、领域（按条数，且只在多于一个时给）。
     * 标签不在这里——kiln 的 tag 是动作提交上的 trailer，但 `path --json` 不吐它，
     * 视图只能拿到 issue 级并集，拿它筛动作会张冠李戴。
     */
    function rowFacets(rows, byId) {
      const actions = new Map()
      const domains = new Map()
      for (const row of rows) {
        const action = row.action ?? ''
        actions.set(action, (actions.get(action) ?? 0) + 1)
        const domain = byId?.get?.(row.issueId)?.domain ?? ''
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
      if (filters.tags.length > 0) {
        const tags = Array.isArray(issue.tags) ? issue.tags : []
        if (!tags.some((tag) => filters.tags.includes(tag))) return false
      }
      if (filters.states.length > 0) {
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
      const tags = new Map()
      const states = new Map()
      for (const issue of issues) {
        const domain = issue.domain ?? ''
        domains.set(domain, (domains.get(domain) ?? 0) + 1)
        for (const tag of Array.isArray(issue.tags) ? issue.tags : []) {
          tags.set(tag, (tags.get(tag) ?? 0) + 1)
        }
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
        tags: toOptions(tags, ''),
      }
    }

    /** 焦点行下方的迷你动作条：最近 12 个，更早的折成 +k。 */
    function strip(actions) {
      if (!Array.isArray(actions) || actions.length === 0) return null
      const visible = actions.slice(-12)
      const extra = actions.length - visible.length
      return h(
        'span',
        { className: 'dkf-strip', 'data-hint': actions.map((action) => `${action.ordinal}. ${action.action}`).join('\n') },
        extra > 0 ? h('span', { className: 'dkf-ago' }, `+${extra}`) : null,
        visible.map((action, index) =>
          h('span', {
            key: `${action.ordinal}-${index}`,
            className: cls('dkf-block', index === visible.length - 1 && 'dkf-block-current'),
            style: { background: colorOf(action.action) },
            'data-hint': `${action.ordinal}. ${action.action} · ${action.date} · ${action.title ?? ''}`,
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
              { className: 'dkf-subrow', key: `${action.ordinal}-${action.short || ''}`, style: { '--dkf-row-color': colorOf(action.action) } },
              h('span', { className: 'dkf-abar' }),
              h('span', { className: 'dkf-achip' }, action.action || '?'),
              h('span', { className: 'dkf-atitle', 'data-hint': action.title }, action.title || '（无标题）'),
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
            style: { '--dkf-row-color': colorOf(issue.action) },
            onClick: props.onToggle,
            onKeyDown: (event) => rowKeyDown(event, props),
          },
          strip(issue.actions),
          h('span', { className: 'dkf-caret', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'),
          h(
            'span',
            { className: 'dkf-id', 'data-hint': issue.id },
            props.edge !== undefined ? h('span', { className: 'dkf-edge' }, ` ${props.edge} `) : null,
            issue.id,
          ),
          h(
            'span',
            { className: 'dkf-badges' },
            issue.domain ? h('span', { className: 'dkf-chip' }, issue.domain) : null,
            h('span', { className: 'dkf-chip dkf-chip-action' }, issue.action || '?'),
            issue.done ? h('span', { className: 'dkf-chip dkf-chip-done' }, 'done') : null,
          ),
          h('span', { className: 'dkf-title', 'data-hint': last?.title || issue.title || '（无标题）' }, last?.title || issue.title || '（无标题）'),
          h('span', { className: 'dkf-ago' }, ago(last?.date)),
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
      return h(
        React.Fragment,
        null,
        h(
          'div',
          {
            className: 'dkf-arow',
            'data-row': '',
            tabIndex: -1,
            style: { '--dkf-row-color': colorOf(row.action) },
            onClick: props.onToggle,
            onKeyDown: (event) => rowKeyDown(event, props),
            'data-hint': '点开看这条提交的详情',
          },
          h('span', { className: 'dkf-abar' }),
          h('span', { className: 'dkf-aissue', 'data-hint': row.issueId }, row.issueId),
          h('span', { className: 'dkf-achip' }, row.action || '?'),
          h('span', { className: 'dkf-atitle', 'data-hint': row.title }, row.title || '（无标题）'),
          h('span', { className: 'dkf-ashort' }, row.short || ''),
          h('span', { className: 'dkf-ago' }, ago(row.date)),
          h(
            'button',
            {
              type: 'button',
              className: 'dkf-focusbtn',
              tabIndex: -1,
              'data-hint': `聚焦 ${row.issueId}（快捷键 f）`,
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
            h(
              'span',
              { className: 'dkf-filter-label', 'data-hint': group.hint === undefined ? null : group.hint },
              group.label,
            ),
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

    function TimelinePanel(props) {
      if (props.rows.length === 0) return h('p', { className: 'dkf-empty' }, props.emptyText)
      return h(
        'div',
        { className: 'dkf-list dkf-rail', tabIndex: 0, onKeyDown: listKeyDown },
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
     * issue 页的聚焦态：把焦点周围的关系按“结构”分组读出来。
     *
     * 这块从关系页的“列表”取景搬来（见 docs/issues/kiln-issue-focus-page.md）：关系页只剩图，
     * 关系名与方向这些“读得出来”的东西集中在这一页。两处有意和旧版不同：
     *   · 弱关联默认展开——`~/kiln` 的数据说折叠时 55% 的焦点只剩焦点自己一行；
     *   · 焦点行默认展开它的动作，让“没有邻居”的焦点也有内容。
     */
    function IssueFocusList(props) {
      const view = props.view
      const focus = props.focus
      const children = view.children
        .map((id) => props.byId.get(id))
        .filter(Boolean)
        .sort(byRecency)
      const visibleChildren = props.expandedChildren || children.length <= 4 ? children : children.slice(0, 4)
      const weak = (view.groups.get('relates-to') ?? [])
        .map((entry) => props.byId.get(entry.id))
        .filter(Boolean)
        .sort(byRecency)
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
        view.parent.length > 0
          ? h(
              'div',
              { className: 'dkf-crumb', onClick: () => props.onFocus(view.parent[0]), 'data-hint': '切到母 issue' },
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
              h('div', { className: 'dkf-group-head' }, `弱关联 · relates-to ${weak.length}`),
              weak.map((issue) => h(IssueRow, { key: `weak-${issue.id}`, ...rowProps(issue, { indent: true }) })),
            )
          : null,
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

      // 切焦点时收起附属展开，并把焦点行重新展开：换焦点等于换一批邻居与一份动作
      React.useEffect(() => {
        setExpandedChildren(false)
        setFocusOpen(true)
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

      const refresh = () => setNonce((value) => value + 1)
      const totalOf = (issueId) => (Array.isArray(byId.get(issueId)?.actions) ? byId.get(issueId).actions.length : 0)

      const header = h(
        'div',
        { className: 'dkf-head' },
        h(
          'span',
          {
            className: 'dkf-repo',
            'data-hint':
              payload?.ok === true
                ? `${cwd}\n快照：${payload.cache?.action ?? 'unknown'} · ${payload.generatedAt ?? ''}`
                : cwd,
          },
          basename(cwd) || 'kiln',
        ),
        h('span', { className: 'dkf-spacer' }),
        focus !== null
          ? h(
              'button',
              {
                type: 'button',
                className: 'dkf-focuschip',
                onClick: clearFocus,
                'data-hint': '退出聚焦，回到全局（Esc）',
              },
              `焦点：${focus.id} ×`,
            )
          : null,
        h('button', { type: 'button', className: 'dkf-refresh', onClick: refresh, 'data-hint': '重新读取 kiln 快照' }, '刷新'),
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
      const shownIssues = React.useMemo(() => filterIssues(issueList, activeFilters), [issueList, activeFilters])
      const filterOn = filtersActive(activeFilters)
      const filterCount = activeFilters.domains.length + activeFilters.tags.length + activeFilters.states.length
      const filterGroups = facets.domains.length + facets.states.length + facets.tags.length
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
      const shownRows = React.useMemo(() => filterRows(rows, activeRowFilters, byId), [rows, activeRowFilters, byId])
      const rowFilterOn = filtersActive(activeRowFilters)
      const rowFilterCount = activeRowFilters.actions.length + activeRowFilters.domains.length
      const canFilterRows = tabId === 'timeline' && rowFacetData.actions.length + rowFacetData.domains.length > 0

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
          rowFilterOn && canFilterRows ? `${shownRows.length} / ${rows.length} 个动作` : `${rows.length} 个动作`,
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
          filterOn && canFilter ? `${shownIssues.length} / ${issueList.length} issue` : `${issueList.length} 个 issue`,
        ),
      ]

      const bar =
        payload?.ok === true
          ? h(
              'div',
              { className: 'dkf-bar' },
              h(PageTabs, { pages: PAGES, active: tabId, onSelect: selectTab, idBase }),
              h(
                'div',
                { className: 'dkf-bar-tools' },
                pageTools !== null
                  ? pageTools
                  : tabId === 'issue'
                    ? issueTools
                    : rowTools,
              ),
            )
          : null

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
            rows: shownRows,
            totalOf,
            expanded,
            onToggle: toggleExpand,
            onFocus: focusIssue,
            emptyText: rowFilterOn
              ? '没有符合筛选条件的动作。'
              : focus === null
                ? '还没有任何 kiln 动作。'
                : '焦点与相关 issue 还没有动作。',
          })
        } else if (tabId === 'issue') {
          // 有焦点 = 读结构（母 / 子 / 强关系 / 弱关联）；没焦点 = 一行一个 issue
          content =
            focus === null
              ? h(IssuePanel, {
                  issues: shownIssues,
                  focusId: null,
                  expanded,
                  onToggle: toggleExpand,
                  onFocus: focusIssue,
                  emptyText: filterOn ? '没有符合筛选条件的 issue。' : '这个仓库还没有 issue。',
                })
              : h(IssueFocusList, {
                  focus,
                  view,
                  byId,
                  expanded,
                  focusOpen,
                  expandedChildren,
                  onToggle: toggleExpand,
                  onToggleFocus: () => setFocusOpen((value) => !value),
                  onFocus: focusIssue,
                  onToggleChildren: () => setExpandedChildren((value) => !value),
                })
        } else {
          content = h(GraphPanel, {
            issues,
            relations,
            focusId: focus === null ? null : focus.id,
            direction: graphDirection,
            graphView,
            depth: graphDepth,
            onFocus: focusIssue,
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
        // 筛选条只在展开时出现，紧贴页栏下面（不跟着内容滚走）
        filterOpen && canFilterRows
          ? h(FilterRow, {
              groups: ROW_FILTER_GROUPS,
              facets: rowFacetData,
              active: activeRowFilters,
              onToggle: toggleRowFilter,
              onClear: clearRowFilters,
            })
          : filterOpen && canFilter
            ? h(FilterRow, {
                groups: FILTER_GROUPS,
                facets,
                active: activeFilters,
                onToggle: toggleFilter,
                onClear: clearFilters,
              })
            : null,
        // 滚动时内容从提示框底下走，必须收起来
        h('div', { className: 'dkf-scroll', onScroll: clearHint }, body),
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

    return { name: '@local/dsh-kiln', inject, apply, ...(globalThis.__DSH_KILN_TEST__ === true ? { __internals: { paintFocus, buildMermaid, graphTiers, issueSummary, tipPlacement, graphFontSize, issueFacets, filterIssues, filtersActive, readFilters, rowFacets, filterRows, readRowFilters, css: CSS } } : {}) }
  },
})
