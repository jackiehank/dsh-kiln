/**
 * Client half：在会话顶部标签排（对话 / 轨迹 / 上下文）末尾加一个 `kiln` 标签。
 *
 * 视图是只读的 Flow 初稿：第一行是焦点 issue（默认最近一次动作的那条），下面按关系
 * 强弱依次排开——part-of 缩进/面包屑、blocks、supersedes、caused-by，relates-to 折叠。
 * 数据来自宿主路由 `/kiln/flow`，本文件不直接碰文件系统。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-kiln',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STYLE_ID = 'dsh-kiln-flow-style'
    const FLOW_URL = '/kiln/flow'

    /** kanonical 关系：a 与 b 之间是谁对谁，只认词表里的五种。 */
    const INVERSE = {
      'has-part': 'part-of',
      'blocked-by': 'blocks',
      'superseded-by': 'supersedes',
      causes: 'caused-by',
    }
    /** 关系强弱：ordering 槽整体强于 lineage 槽；组内 rank 越大越强。 */
    const GROUPS = [
      { rel: 'part-of', slot: 'ordering', rank: 2, label: '母 issue', edge: 'part-of' },
      { rel: 'blocks', slot: 'ordering', rank: 1, label: '阻塞', edge: 'blocks' },
      { rel: 'supersedes', slot: 'lineage', rank: 3, label: '取代', edge: 'supersedes' },
      { rel: 'caused-by', slot: 'lineage', rank: 2, label: '因果', edge: 'caused-by' },
      { rel: 'relates-to', slot: 'lineage', rank: 1, label: '弱关联', edge: 'relates-to' },
    ]
    const ACTION_COLOR = {
      ask: '#5b8def',
      hypothesize: '#9a6bff',
      collect: '#18b6c8',
      test: '#e0a33b',
      conclude: '#35a35f',
      apply: '#35a35f',
    }

    const CSS = `
.dkf-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111)}
.dkf-head{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2,#e3e3e3);flex:none}
.dkf-brand{font:600 13px/20px var(--dsw-font-family,inherit)}
.dkf-repo{color:var(--dsw-alias-label-secondary,#666);font:12px/20px var(--dsw-font-family-code,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dkf-spacer{flex:1}
.dkf-refresh{border:.5px solid var(--dsw-alias-border-l2,#ddd);background:0 0;color:var(--dsw-alias-label-secondary,#666);border-radius:4px;font:12px/18px var(--dsw-font-family,inherit);padding:1px 8px;cursor:pointer}
.dkf-refresh:hover{color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dkf-scroll{flex:1;min-height:0;overflow:auto;padding:10px 14px 32px}
.dkf-note{color:var(--dsw-alias-label-secondary,#666);font:12px/18px var(--dsw-font-family,inherit);margin:0 0 6px}
.dkf-error{margin:18px 0;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2,#e3e3e3);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#fafafa)}
.dkf-error-title{font:600 13px/20px var(--dsw-font-family,inherit);margin:0 0 4px}
.dkf-error-detail{color:var(--dsw-alias-label-secondary,#666);font:12px/18px var(--dsw-font-family-code,monospace);word-break:break-all;margin:0}
.dkf-group{margin:14px 0 0}
.dkf-group-head{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary,#999);font:11px/16px var(--dsw-font-family,inherit);text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px 2px}
.dkf-group-count{color:var(--dsw-alias-label-tertiary,#999)}
.dkf-toggle{all:unset;cursor:pointer;color:var(--dsw-alias-label-secondary,#666);font:11px/16px var(--dsw-font-family,inherit)}
.dkf-toggle:hover{color:var(--dsw-alias-label-primary,#111)}
.dkf-row{display:grid;grid-template-columns:auto auto auto minmax(0,1fr) auto;align-items:center;gap:8px;padding:5px 6px;border-radius:4px;min-width:0}
.dkf-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dkf-focus{border:.5px solid var(--dsw-alias-border-l3,#ccc);background:var(--dsw-alias-bg-layer-2,#fafafa);margin-bottom:2px}
.dkf-clickable{cursor:pointer}
.dkf-indent{margin-left:22px}
.dkf-crumb{color:var(--dsw-alias-label-secondary,#666);font:12px/18px var(--dsw-font-family,inherit);padding:2px 6px;cursor:pointer;width:max-content;border-radius:4px}
.dkf-crumb:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#111)}
.dkf-strip{display:inline-flex;gap:2px;align-items:center}
.dkf-block{width:7px;height:15px;border-radius:2px;background:var(--dsw-alias-label-tertiary,#999);opacity:.85}
.dkf-block-current{outline:1.5px solid var(--dsw-alias-label-primary,#111);outline-offset:1px}
.dkf-id{font:500 12px/18px var(--dsw-font-family-code,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.dkf-badges{display:inline-flex;gap:4px;align-items:center;flex:none}
.dkf-chip{font:10px/16px var(--dsw-font-family,inherit);padding:0 5px;border-radius:3px;border:.5px solid var(--dsw-alias-border-l2,#e3e3e3);color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.dkf-chip-done{color:#35a35f;border-color:rgba(53,163,95,.4)}
.dkf-edge{font:10px/16px var(--dsw-font-family-code,monospace);color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}
.dkf-title{color:var(--dsw-alias-label-primary,#111);font:12px/18px var(--dsw-font-family,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dkf-ago{color:var(--dsw-alias-label-tertiary,#999);font:11px/16px var(--dsw-font-family,inherit);white-space:nowrap}
.dkf-empty{color:var(--dsw-alias-label-tertiary,#999);font:12px/18px var(--dsw-font-family,inherit);margin:6px 2px}
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

    /** 把一条 graph 边归一成 (a 关系 b)；反向名翻转端点。 */
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

    /**
     * 以 focus 为根，把关系边折成“面包屑 + 分组邻居”。
     * part-of 蕴含的 blocks 边在这里被 part-of 覆盖掉，不重复显示。
     */
    function relate(focus, edges) {
      const parent = []
      const children = []
      const groups = new Map(GROUPS.map((group) => [group.rel, []]))
      const pairs = new Map()

      for (const edge of edges) {
        const relation = canonical(edge)
        if (relation === null) continue
        const pairKey = `${relation.rel}|${relation.a}|${relation.b}`
        if (pairs.has(pairKey)) continue
        pairs.set(pairKey, relation)
      }
      const relations = [...pairs.values()]

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
        if (relation.rel === 'supersedes') {
          const other = relation.a === focus ? relation.b : relation.b === focus ? relation.a : null
          if (other === null) continue
          groups.get('supersedes').push({ id: other, arrow: relation.a === focus ? '→' : '←' })
          continue
        }
        if (relation.rel === 'caused-by') {
          const other = relation.a === focus ? relation.b : relation.b === focus ? relation.a : null
          if (other === null) continue
          groups.get('caused-by').push({ id: other, arrow: relation.a === focus ? '→' : '←' })
        }
      }

      return { parent, children, groups }
    }

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
            style: { background: ACTION_COLOR[action.action] ?? undefined },
            title: `${action.ordinal}. ${action.action} · ${action.date} · ${action.title ?? ''}`,
          }),
        ),
      )
    }

    function IssueRow(props) {
      const issue = props.issue
      if (issue === undefined) return null
      const last = issue.last
      return h(
        'div',
        {
          className: cls('dkf-row', props.focus && 'dkf-focus', props.indent && 'dkf-indent', props.onClick && 'dkf-clickable'),
          onClick: props.onClick,
          title: last?.title ?? issue.title,
        },
        strip(issue.actions),
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
          h('span', { className: 'dkf-chip', style: { color: ACTION_COLOR[issue.action] ?? undefined } }, issue.action || '?'),
          issue.done ? h('span', { className: 'dkf-chip dkf-chip-done' }, 'done') : null,
        ),
        h('span', { className: 'dkf-title' }, last?.title || issue.title || '（无标题）'),
        h('span', { className: 'dkf-ago' }, ago(last?.date)),
      )
    }

    /** 组内按最近动作时间排序；没有日期的排最后。 */
    function byRecency(left, right) {
      const leftDate = left.last?.date ?? ''
      const rightDate = right.last?.date ?? ''
      if (leftDate === rightDate) return left.id.localeCompare(right.id)
      return leftDate < rightDate ? 1 : -1
    }

    function FlowView(props) {
      const cwd = typeof props.cwd === 'string' ? props.cwd : ''
      const [state, setState] = React.useState({ phase: 'loading', payload: null, error: null })
      const [nonce, setNonce] = React.useState(0)
      const [expandedWeak, setExpandedWeak] = React.useState(false)
      const [expandedChildren, setExpandedChildren] = React.useState(false)
      const [focusId, setFocusId] = React.useState(null)

      React.useEffect(() => {
        if (cwd === '') {
          setState({ phase: 'no-workspace', payload: null, error: null })
          return undefined
        }
        const controller = new AbortController()
        setState((previous) => ({ phase: 'loading', payload: previous.payload, error: null }))
        const url = `${FLOW_URL}?cwd=${encodeURIComponent(cwd)}${focusId !== null ? `&focus=${encodeURIComponent(focusId)}` : ''}`
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
            if (typeof payload.focus === 'string' && payload.focus !== '') setFocusId(payload.focus)
            setState({ phase: 'ready', payload, error: null })
          })
          .catch((error) => {
            if (controller.signal.aborted) return
            setState({ phase: 'error', payload: null, error: String(error?.message ?? error) })
          })
        return () => controller.abort()
      }, [cwd, nonce])

      const payload = state.payload
      const issues = payload?.ok === true && Array.isArray(payload.issues) ? payload.issues : []
      const byId = React.useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues])
      const focus = focusId !== null && byId.has(focusId) ? byId.get(focusId) : issues.length > 0 ? issues[0] : null
      const edges = payload?.ok === true && Array.isArray(payload.edges) ? payload.edges : []
      const layout = React.useMemo(() => (focus === null ? null : relate(focus.id, edges)), [focus, edges])

      const refresh = () => setNonce((value) => value + 1)

      const header = h(
        'div',
        { className: 'dkf-head' },
        h('span', { className: 'dkf-brand' }, 'kiln'),
        h('span', { className: 'dkf-repo', title: cwd }, payload?.ok === true ? `${basename(cwd)} · ${issues.length} issue` : basename(cwd)),
        h('span', { className: 'dkf-spacer' }),
        h('button', { type: 'button', className: 'dkf-refresh', onClick: refresh }, '刷新'),
      )

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
        const detail = {
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
      } else if (focus !== null && layout !== null) {
        const groups = GROUPS.filter((group) => group.rel !== 'part-of' && group.rel !== 'relates-to')
        const weak = layout.groups.get('relates-to') ?? []
        const children = layout.children
          .map((id) => byId.get(id))
          .filter(Boolean)
          .sort(byRecency)
        const visibleChildren = expandedChildren || children.length <= 4 ? children : children.slice(0, 4)

        body = h(
          React.Fragment,
          null,
          h(IssueRow, { issue: focus, focus: true }),
          layout.parent.length > 0
            ? h(
                'div',
                { className: 'dkf-crumb', onClick: () => setFocusId(layout.parent[0]), title: '切到母 issue' },
                `↑ part-of: ${layout.parent[0]}`,
              )
            : null,
          payload.truncated === true
            ? h('p', { className: 'dkf-note' }, `共 ${payload.total ?? issues.length} 条 issue，只展示前 ${issues.length} 条。`)
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
                        { type: 'button', className: 'dkf-toggle', onClick: () => setExpandedChildren((value) => !value) },
                        expandedChildren ? '收起' : `展开全部 ${children.length}`,
                      )
                    : null,
                ),
                visibleChildren.map((child) => h(IssueRow, { key: child.id, issue: child, indent: true, onClick: () => setFocusId(child.id) })),
              )
            : null,
          groups.map((group) => {
            const rows = (layout.groups.get(group.rel) ?? [])
              .map((entry) => ({ entry, issue: byId.get(entry.id) }))
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
                  issue,
                  edge: `${entry.arrow} ${group.edge}`,
                  onClick: () => setFocusId(issue.id),
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
                  { type: 'button', className: 'dkf-toggle', onClick: () => setExpandedWeak((value) => !value) },
                  expandedWeak ? `收起弱关联` : `+${weak.length} 弱关联 · relates-to`,
                ),
                expandedWeak
                  ? weak
                      .map((entry) => byId.get(entry.id))
                      .filter(Boolean)
                      .sort(byRecency)
                      .map((issue) =>
                        h(IssueRow, {
                          key: `weak-${issue.id}`,
                          issue,
                          edge: '⇄ relates-to',
                          indent: true,
                          onClick: () => setFocusId(issue.id),
                        }),
                      )
                  : null,
              )
            : null,
          layout.parent.length === 0 && children.length === 0 && groups.every((group) => (layout.groups.get(group.rel) ?? []).length === 0) && weak.length === 0
            ? h('p', { className: 'dkf-empty' }, '还没有声明任何关系。')
            : null,
        )
      }

      return h('div', { className: 'dkf-root' }, header, h('div', { className: 'dkf-scroll' }, body))
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
          FlowView,
        ),
      )
    }

    return { name: '@local/dsh-kiln', inject, apply }
  },
})

