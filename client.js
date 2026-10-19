/**
 * dsh-image-annotate — client half.
 *
 * Registers an image file viewer into `dsh-better-sidebar`'s viewer registry
 * (priority above the built-in image viewer). The viewer lets you drag boxes
 * over the image, type a question/instruction, and then inserts a structured
 * prompt into the conversation composer:
 *
 *     【图片标注】文件：<path>
 *     原图：<W×H> px
 *     - ① x=.., y=.., w=.., h=..
 *     ...
 *     要求：<text>
 *
 * The agent then crops those exact pixel rectangles (PIL) and answers. No
 * file writes happen in the browser — coordinates are handed over verbatim,
 * so cropping is exact rather than model-guessed.
 *
 * Constraints honoured:
 * - React comes from the browser module table (`require('react')`); no Harness
 *   client package is required, no CDN, no second app root.
 * - Plain JS, no JSX (this file ships as-is).
 * - Colours come from host theme tokens (`--dsw-*`) with literal fallbacks.
 *
 * @module dsh-image-annotate/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-image-annotate',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg']

    /** Palette: theme tokens with literal fallbacks so the viewer never renders blank. */
    const C = {
      border: 'var(--dsw-alias-border, #3a3f4b)',
      text: 'var(--dsw-alias-text, #e6e8ec)',
      textDim: 'var(--dsw-alias-text-dim, #9aa2b1)',
      accent: 'var(--dsw-alias-accent, #4d9cf6)',
      warn: 'var(--dsw-alias-warn, #e0a53a)',
      panel: 'var(--dsw-alias-surface, #1c1f26)',
      bg: 'var(--dsw-alias-canvas, #14161b)',
    }

    /** Clamp a number into [lo, hi]. */
    function clamp(v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v
    }

    /**
     * Deliver a composed prompt as robustly as possible.
     *
     * Preferred path is a real insert into the session composer. When the
     * session cannot be resolved (the `shell.overlay` slot is not session
     * scoped, so a host that publishes no mounted-session feed leaves us
     * without an id), the text is copied to the clipboard instead — the user
     * always ends up with the exact prompt, never an empty result.
     *
     * @param {unknown} ctx - client context.
     * @param {string} sid - session id ('' when unresolved).
     * @param {string} text - prompt text.
     * @param {(how: 'inserted'|'copied'|'failed') => void} onDone - outcome callback.
     */
    function deliverPrompt(ctx, sid, text, onDone) {
      if (insertIntoComposer(ctx, sid, text)) {
        onDone('inserted')
        return
      }
      try {
        const nav = typeof navigator !== 'undefined' ? navigator : undefined
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
          nav.clipboard.writeText(text).then(
            function () {
              onDone('copied')
            },
            function () {
              onDone('failed')
            }
          )
          return
        }
      } catch (_) {
        /* clipboard unavailable */
      }
      onDone('failed')
    }

    /**
     * Tiny activation bus shared by the two entry points.
     *
     * The marquee lives in `shell.overlay`, but the user also needs an entry
     * point inside the sidebar (a button / floating ball). Two independent
     * components cannot share React state across slots, so they share this
     * module-level store: the sidebar button arms the marquee, the marquee
     * observes the arm counter and starts selecting.
     */
    const marqueeBus = (function () {
      let armed = 0
      let sessionId = ''
      const subs = new Set()
      return {
        getArmed: function () {
          return armed
        },
        /** The session whose header button armed us ('' when unknown). */
        getSession: function () {
          return sessionId
        },
        /** Remember a session id resolved by a session-scoped component. */
        setSession: function (id) {
          if (typeof id === 'string' && id) sessionId = id
        },
        arm: function () {
          armed += 1
          subs.forEach(function (fn) {
            try {
              fn()
            } catch (_) {
              /* listener errors must not break the others */
            }
          })
        },
        subscribe: function (fn) {
          subs.add(fn)
          return function () {
            subs.delete(fn)
          }
        },
      }
    })()

    /**
     * Sidebar entry point: a compact button that arms the marquee.
     *
     * Registered into `conversation.session.header.utilities` so it sits with
     * the other session-header controls; the floating ball in `shell.overlay`
     * is the second entry point. Both call `marqueeBus.arm()`.
     */
    function MarqueeButton(props) {
      const [hover, setHover] = React.useState(false)
      // The session-scoped header slot hands us `sessionId`; cache it because
      // the marquee itself lives in `shell.overlay`, which is NOT session
      // scoped and therefore cannot resolve the composer on its own.
      const sid = props && props.sessionId
      React.useEffect(
        function () {
          if (sid) marqueeBus.setSession(sid)
        },
        [sid]
      )
      return h(
        'button',
        {
          'data-ia-ui': '1',
          title: '请求修改 / 框选：点在界面上拖出一个矩形，对框内内容提问或提修改要求',
          onMouseEnter: function () {
            setHover(true)
          },
          onMouseLeave: function () {
            setHover(false)
          },
          onClick: function () {
            marqueeBus.arm()
          },
          style: {
            // Icon-only: the header row is tight, so the label lives in the
            // tooltip and only the glyph is rendered.
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            padding: 0,
            borderRadius: 6,
            border: '1px solid ' + (hover ? C.accent : 'transparent'),
            background: hover ? C.accent : 'transparent',
            color: hover ? '#fff' : C.text,
            cursor: 'pointer',
            font: '14px/1 system-ui, sans-serif',
            whiteSpace: 'nowrap',
            boxSizing: 'border-box',
          },
        },
        h('span', { 'aria-hidden': 'true', title: '请求修改' }, '⌗')
      )
    }

    /**
     * Diagnostic: why the last session probe failed. Rendered in the panel's
     * failure note so a mismatch shows up in one round instead of five.
     */
    let lastProbe = ''

    /** Diagnostic: why the last composer insert failed. */
    let lastInsertWhy = ''

    /**
     * Resolve the session that owns the composer we should write into.
     *
     * The `shell.overlay` slot does not guarantee a sessionId prop, so this
     * walks the three sources that exist, cheapest first:
     *   1. the slot's own `sessionId` prop (present on session-scoped slots);
     *   2. `ctx.sidebarRight.mounted` — the sanctioned "whose seat is on
     *      screen" feed documented by the sidebar runtime;
     *   3. `props.scope.sessionId` handed to a file viewer;
     *   4. a DOM scan for a `data-session-id` carrier.
     * Returns '' when none resolves (callers degrade to a copy affordance).
     *
     * @param {unknown} ctx - client context.
     * @param {unknown} props - the component's props.
     * @returns {string}
     */
    function resolveSessionId(ctx, props) {
      const why = []
      // 0. Session cached by a session-scoped component (the header button).
      const cached = marqueeBus.getSession()
      if (cached) return cached

      // 1. `uiSession` — the authoritative "which session is on screen" feed.
      //    Mirrors dsh-annotation's readCurrentSessionId(): the adapter's
      //    `current` observable snapshots to a BINDING whose session key is
      //    `.key` — not `.id`/`.sessionId`. Reading the wrong field yields an
      //    id that `sessions.scope()` rejects (it throws), which is exactly the
      //    failure this replaced.
      try {
        const face = ctx && typeof ctx.get === 'function' ? ctx.get('uiSession') : undefined
        if (!face) {
          why.push('uiSession 服务未取到')
        } else {
          const adapter = face.adapter
          const src = adapter && adapter.current
          const v = src && typeof src.getSnapshot === 'function' ? src.getSnapshot() : src
          if (typeof v === 'string' && v) return v
          if (v && typeof v.key === 'string' && v.key) return v.key
          if (v && typeof v.id === 'string' && v.id) return v.id
          if (v && typeof v.sessionId === 'string' && v.sessionId) return v.sessionId
          why.push('uiSession.adapter.current 无 key')
        }
      } catch (e) {
        why.push('uiSession 异常')
      }

      // 2. The persisted "current session" pointer the shell writes.
      try {
        const raw = localStorage.getItem('dsh.sessions.current')
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed.sessionId === 'string' && parsed.sessionId) {
            return parsed.sessionId
          }
        }
        why.push('localStorage 无 dsh.sessions.current')
      } catch (_) {
        why.push('localStorage 读失败')
      }

      // 3. The session list: its `current`, else the row the main view retains.
      try {
        const snap =
          ctx && ctx.sessions && ctx.sessions.list && ctx.sessions.list.getSnapshot
            ? ctx.sessions.list.getSnapshot()
            : undefined
        if (snap) {
          if (typeof snap.current === 'string' && snap.current) return snap.current
          const byId = snap.byId
          if (byId && typeof byId === 'object') {
            const ids = Array.isArray(snap.ids) ? snap.ids : Object.keys(byId)
            for (let i = 0; i < ids.length; i++) {
              const row = byId[ids[i]]
              const retained = row && row.retainedBy
              if (retained && typeof retained.mainView === 'number' && retained.mainView > 0) {
                return ids[i]
              }
            }
          }
          why.push('list 无 current/retained')
        } else {
          why.push('sessions.list 不可用')
        }
      } catch (_) {
        why.push('sessions.list 异常')
      }

      if (props && typeof props.sessionId === 'string' && props.sessionId) return props.sessionId
      if (props && props.scope && typeof props.scope.sessionId === 'string' && props.scope.sessionId) {
        return props.scope.sessionId
      }
      why.push('props 无 sessionId')
      try {
        const sr = ctx && typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined
        const mounted = sr && sr.mounted
        const v =
          mounted && typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : mounted
        if (typeof v === 'string' && v) return v
        why.push('sidebarRight.mounted 空/无服务')
      } catch (_) {
        why.push('sidebarRight 异常')
      }
      try {
        const el = document.querySelector('[data-session-id]')
        if (el) {
          const v = el.getAttribute('data-session-id')
          if (v) return v
        }
        why.push('DOM 无 data-session-id')
      } catch (_) {
        /* no DOM */
      }
      // 5. The route may carry the session id (`/session/<id>`, `#/<id>`).
      try {
        const m = String(location.href).match(/session[/=]([A-Za-z0-9_-]{8,})/i)
        if (m) return m[1]
        why.push('URL 无 session')
      } catch (_) {
        /* no location */
      }
      // 6. Last resort: any storage entry that looks like a session id.
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i) || ''
          if (/session/i.test(k)) {
            const raw = localStorage.getItem(k) || ''
            const m = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
            if (m) return m[0]
          }
        }
        why.push('localStorage 无')
      } catch (_) {
        /* storage blocked */
      }
      lastProbe = why.join(' / ')
      return ''
    }

    /**
     * Write `text` into the composer of `sid`, appending to any existing draft.
     *
     * @param {unknown} ctx - client context.
     * @param {string} sid - session id ('' = unresolved).
     * @param {string} text - prompt text.
     * @returns {boolean} whether the insert landed.
     */
    function insertIntoComposer(ctx, sid, text) {
      // Sets `lastInsertWhy` so a failure is attributable in one round.
      lastInsertWhy = ''
      if (!ctx) {
        lastInsertWhy = '无 ctx'
        return false
      }
      if (!sid) {
        lastInsertWhy = '无 sessionId'
        return false
      }
      let actx
      try {
        const sessionsSvc =
          ctx.sessions || (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined)
        actx = sessionsSvc && sessionsSvc.scope ? sessionsSvc.scope(sid) : undefined
      } catch (e) {
        lastInsertWhy =
          'sessions.scope 抛错：' + String(e && e.message ? e.message : e).slice(0, 50)
        return false
      }
      if (!actx) {
        lastInsertWhy = 'sessions.scope 返回空（id 可能不匹配）'
        return false
      }
      // dsh-annotation reaches the composer as `ctx.conversation` (a direct
      // service property); `ctx.get('conversation')` is the fallback form.
      let conversation
      try {
        conversation = ctx.conversation
        if (!conversation && typeof ctx.get === 'function') conversation = ctx.get('conversation')
      } catch (e) {
        lastInsertWhy = 'conversation 取用抛错'
        return false
      }
      if (!conversation || !conversation.input) {
        lastInsertWhy = 'conversation 服务不可用'
        return false
      }
      try {
        const input = conversation.input.for(actx)
        if (!input || !input.state || typeof input.setDraft !== 'function') {
          lastInsertWhy = 'input.for 返回空'
          return false
        }
        const draft = (input.state.getSnapshot() || {}).draft || ''
        input.setDraft(draft ? draft.replace(/\s+$/, '') + '\n\n' + text : text)
        return true
      } catch (e) {
        lastInsertWhy = 'setDraft 抛错：' + String(e && e.message ? e.message : e).slice(0, 60)
        return false
      }
    }

    /** Normalise a drag into an axis-aligned rect (all values >= 0). */
    function normRect(a, b) {
      return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x),
        h: Math.abs(b.y - a.y),
      }
    }

    /** Compose the prompt text handed to the composer. */
    function buildPrompt(path, cwd, naturalW, naturalH, boxes, question, intent) {
      const lines = []
      const kind = intent === 'edit' ? '编辑' : '识图'
      lines.push('【图片标注 ·' + kind + '】')
      lines.push('文件：`' + path + '`')
      if (cwd) lines.push('工作目录：`' + cwd + '`')
      lines.push('原图尺寸：' + naturalW + ' × ' + naturalH + ' px（框选坐标均以原图像素计，原点在左上角）')
      if (boxes.length > 0) {
        lines.push('')
        lines.push('框选区域：')
        boxes.forEach(function (b, i) {
          lines.push(
            '  ' + (i + 1) + '. x=' + b.x + ', y=' + b.y + ', w=' + b.w + ', h=' + b.h
          )
        })
        lines.push('')
        lines.push(
          '请按上面的像素坐标精确裁剪出各区域（Python + PIL：`img.crop((x, y, x + w, y + h))`），' +
            '再逐个区域回答下面的要求。坐标由我在图上框选得到，请原样使用，不要自行改动或重新估计。'
        )
      }
      lines.push('')
      lines.push('要求：' + (question.trim() || '（未填写，请描述你看到的内容）'))
      return lines.join('\n')
    }

    /**
     * The image annotation viewer.
     * @param {{ ctx: unknown, scope: { sessionId: string, cwd?: string }, path: string,
     *           mediaUrl?: string, title?: string }} props
     */
    function ImageAnnotateViewer(props) {
      const path = props.path || ''
      const cwd = (props.scope && props.scope.cwd) || ''
      const mediaUrl = props.mediaUrl || ''

      const [boxes, setBoxes] = React.useState([])
      const [drag, setDrag] = React.useState(null) // { x0, y0, cur: {x,y} } in CSS px
      const [question, setQuestion] = React.useState('')
      const [intent, setIntent] = React.useState('recognize') // 'recognize' | 'edit'
      const [natural, setNatural] = React.useState({ w: 0, h: 0 })
      const [note, setNote] = React.useState('')
      const [failed, setFailed] = React.useState(false)

      const stageRef = React.useRef(null) // the positioned layer that holds img + canvas
      const imgRef = React.useRef(null)
      const dragRef = React.useRef(null) // mirrors `drag` for the up-handler

      dragRef.current = drag

      /** Convert a root-relative CSS px point into natural image pixels. */
      const toNatural = function (pt) {
        const el = stageRef.current
        const img = imgRef.current
        if (!el || !img) return pt
        const r = el.getBoundingClientRect()
        const sx = natural.w > 0 ? natural.w / (r.width || 1) : 1
        const sy = natural.h > 0 ? natural.h / (r.height || 1) : 1
        return { x: Math.round((pt.x - r.left) * sx), y: Math.round((pt.y - r.top) * sy) }
      }

      const onImageLoad = function (e) {
        const img = e.currentTarget
        setNatural({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 })
        setFailed(false)
      }

      const onDown = function (e) {
        if (!e.currentTarget) return
        const r = e.currentTarget.getBoundingClientRect()
        const p = { x: e.clientX - r.left, y: e.clientY - r.top }
        dragRef.current = { x0: p.x, y0: p.y, cur: p }
        setDrag(dragRef.current)
        if (e.currentTarget.setPointerCapture && e.pointerId !== undefined) {
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch (_) {
            /* pointer capture is best-effort */
          }
        }
      }

      const onMove = function (e) {
        if (!dragRef.current) return
        const el = e.currentTarget
        if (!el) return
        const r = el.getBoundingClientRect()
        setDrag({
          x0: dragRef.current.x0,
          y0: dragRef.current.y0,
          cur: { x: e.clientX - r.left, y: e.clientY - r.top },
        })
      }

      const onUp = function (e) {
        const d = dragRef.current
        if (!d) return
        setDrag(null)
        const el = e.currentTarget
        if (!el) return
        const r = el.getBoundingClientRect()
        const end = { x: e.clientX - r.left, y: e.clientY - r.top }
        const cssRect = normRect({ x: d.x0, y: d.y0 }, end)
        if (cssRect.w < 4 || cssRect.h < 4) return // a click, not a box
        // Map CSS px -> natural px using the stage rect (img fills the stage).
        const sx = natural.w > 0 ? natural.w / (r.width || 1) : 1
        const sy = natural.h > 0 ? natural.h / (r.height || 1) : 1
        const rect = {
          x: Math.round(cssRect.x * sx),
          y: Math.round(cssRect.y * sy),
          w: Math.round(cssRect.w * sx),
          h: Math.round(cssRect.h * sy),
        }
        setBoxes(function (prev) {
          return prev.concat([rect])
        })
      }

      const undo = function () {
        setBoxes(function (prev) {
          return prev.slice(0, -1)
        })
      }
      const clearAll = function () {
        setBoxes([])
        setNote('')
      }

      const submit = function () {
        if (!mediaUrl) {
          setNote('该文件没有可用的图片地址，无法标注。')
          return
        }
        const canvasBoxes = boxes.length > 0 ? boxes : []
        const text = buildPrompt(
          path,
          cwd,
          natural.w,
          natural.h,
          canvasBoxes,
          question,
          intent
        )
        const sid = resolveSessionId(props.ctx, props)
        deliverPrompt(props.ctx, sid, text, function (how) {
          if (how === 'inserted') {
            setNote('已插入输入框（' + canvasBoxes.length + ' 个框），请检查后发送。')
          } else if (how === 'copied') {
            setNote('插入未成功（' + (lastInsertWhy || lastProbe || '未知原因') + '），已复制到剪贴板 —— 直接在输入框 Ctrl+V。')
          } else {
            setNote('插入失败，请手动复制。')
          }
        })
      }

      // ---- styles -------------------------------------------------------
      const wrap = {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: C.bg,
        color: C.text,
        font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
      }
      const bar = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderBottom: '1px solid ' + C.border,
        flex: '0 0 auto',
        flexWrap: 'wrap',
      }
      const btn = function (active) {
        return {
          padding: '3px 10px',
          borderRadius: 6,
          border: '1px solid ' + (active ? C.accent : C.border),
          background: active ? C.accent : 'transparent',
          color: active ? '#fff' : C.text,
          cursor: 'pointer',
          font: 'inherit',
        }
      }
      const stage = {
        position: 'relative',
        flex: '1 1 auto',
        minHeight: 0,
        overflow: 'auto',
        padding: 10,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
      }
      const canvasLayer = {
        position: 'absolute',
        inset: 0,
        cursor: 'crosshair',
        touchAction: 'none',
      }
      const boxDiv = function (b, i) {
        // Render in natural->CSS scale inside the stage's coordinate space is
        // unnecessary: the canvas layer overlays the <img> exactly, and we keep
        // boxes in natural px, so convert back with the current scale factors.
        const img = imgRef.current
        let sx = 1
        let sy = 1
        if (img && natural.w > 0) {
          const r = img.getBoundingClientRect()
          sx = r.width / natural.w
          sy = r.height / natural.h
        }
        return {
          position: 'absolute',
          left: b.x * sx + 'px',
          top: b.y * sy + 'px',
          width: Math.max(1, b.w * sx) + 'px',
          height: Math.max(1, b.h * sy) + 'px',
          border: '2px solid ' + C.accent,
          borderRadius: 2,
          pointerEvents: 'none',
          boxSizing: 'border-box',
        }
      }
      const badge = {
        position: 'absolute',
        left: -2,
        top: -22,
        background: C.accent,
        color: '#fff',
        borderRadius: 4,
        padding: '0 5px',
        font: '11px/18px system-ui, sans-serif',
        pointerEvents: 'none',
      }
      const panel = {
        flex: '0 0 auto',
        borderTop: '1px solid ' + C.border,
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: C.panel,
      }
      const ta = {
        width: '100%',
        minHeight: 54,
        resize: 'vertical',
        background: C.bg,
        color: C.text,
        border: '1px solid ' + C.border,
        borderRadius: 6,
        padding: 8,
        font: 'inherit',
        boxSizing: 'border-box',
      }

      // ---- render -------------------------------------------------------
      const liveRect = drag ? normRect({ x: drag.x0, y: drag.y0 }, drag.cur) : null

      return h(
        'div',
        { style: wrap },
        h(
          'div',
          { style: bar },
          h('span', { style: { color: C.textDim } }, '标注模式'),
          h('button', { style: btn(intent === 'recognize'), onClick: function () { setIntent('recognize') } }, '识图'),
          h('button', { style: btn(intent === 'edit'), onClick: function () { setIntent('edit') } }, '编辑'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: { color: C.textDim } }, boxes.length + ' 个框'),
          h('button', { style: btn(false), onClick: undo, disabled: boxes.length === 0 }, '撤销一个'),
          h('button', { style: btn(false), onClick: clearAll, disabled: boxes.length === 0 }, '清空')
        ),
        h(
          'div',
          { style: stage },
          h(
            'div',
            { ref: stageRef, style: { position: 'relative', display: 'inline-block', maxWidth: '100%' } },
            h('img', {
              ref: imgRef,
              src: mediaUrl,
              alt: props.title || path,
              draggable: false,
              onLoad: onImageLoad,
              onError: function () { setFailed(true) },
              style: { display: 'block', maxWidth: '100%', userSelect: 'none' },
            }),
            h(
              'div',
              {
                style: canvasLayer,
                onPointerDown: onDown,
                onPointerMove: onMove,
                onPointerUp: onUp,
                onPointerCancel: onUp,
              },
              boxes.map(function (b, i) {
                return h('div', { key: 'b' + i, style: boxDiv(b, i) }, h('span', { style: badge }, String(i + 1)))
              }),
              liveRect && liveRect.w > 0
                ? h('div', {
                    style: {
                      position: 'absolute',
                      left: liveRect.x + 'px',
                      top: liveRect.y + 'px',
                      width: liveRect.w + 'px',
                      height: liveRect.h + 'px',
                      border: '1px dashed ' + C.warn,
                      pointerEvents: 'none',
                    },
                  })
                : null
            )
          )
        ),
        h(
          'div',
          { style: panel },
          failed
            ? h('div', { style: { color: C.warn } }, '图片加载失败：' + (mediaUrl || '（无地址）'))
            : null,
          h(
            'div',
            { style: { color: C.textDim, fontSize: 12 } },
            natural.w > 0
              ? '原图 ' + natural.w + ' × ' + natural.h + ' px　·　在图上拖拽画框（可多个），然后填写要求'
              : '载入中…'
          ),
          h('textarea', {
            style: ta,
            placeholder:
              intent === 'edit'
                ? '写修改要求，例如：把这一块里的公式识别成 LaTeX 并改写进笔记'
                : '写问题，例如：这块写的什么？把公式转成 LaTeX',
            value: question,
            onChange: function (e) { setQuestion(e.target.value) },
          }),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('button', { style: btn(true), onClick: submit }, '插入到输入框'),
            note ? h('span', { style: { color: C.textDim, fontSize: 12 } }, note) : null
          )
        )
      )
    }

    /**
     * PDF entry point.
     *
     * A PDF page cannot be dragged over in the browser here (the host bundle
     * has no pdf.js, and an <embed>'s own scroll surface swallows the pointer),
     * so this viewer does the one thing that works with the existing pipeline:
     * it composes a render request and drops it in the composer. The agent
     * renders the pages to PNG with pymupdf, the PNG then opens in the image
     * annotator above, and box selection proceeds on real pixels.
     *
     * @param {{ ctx: unknown, scope: { sessionId: string, cwd?: string }, path: string, title?: string }} props
     */
    function PdfRenderHelper(props) {
      const path = props.path || ''
      const cwd = (props.scope && props.scope.cwd) || ''
      const [pages, setPages] = React.useState('')
      const [note, setNote] = React.useState('')

      const submit = function () {
        const range = pages.trim()
        const lines = ['【PDF 渲染请求】', '文件：`' + path + '`']
        if (cwd) lines.push('工作目录：`' + cwd + '`')
        lines.push('页码范围：' + (range || '（未填，请先告诉我页码）'))
        lines.push('')
        lines.push(
          '请用 pymupdf 以 300 dpi 灰度把上述页渲染成 PNG（`page.get_pixmap(dpi=300)`），' +
            '存到工作区的 `_work/pages/` 下并在回复里给出文件路径；' +
            '渲染完成后我会在图片标注界面里框选区域提问。'
        )
        lines.push('')
        lines.push('提示：原书页码与 PDF 页码通常有偏移，若不确定请先读出页脚页码再换算。')
        const text = lines.join('\n')
        const sid = resolveSessionId(props.ctx, props)
        deliverPrompt(props.ctx, sid, text, function (how) {
          if (how === 'inserted') {
            setNote('已插入输入框，请检查后发送。')
          } else if (how === 'copied') {
            setNote('插入未成功（' + (lastInsertWhy || lastProbe || '未知原因') + '），已复制到剪贴板 —— 直接在输入框 Ctrl+V。')
          } else {
            setNote('插入失败，请手动复制。')
          }
        })
      }

      const wrap = {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        height: '100%',
        minHeight: 0,
        padding: 14,
        boxSizing: 'border-box',
        background: C.bg,
        color: C.text,
        font: '13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
        overflow: 'auto',
      }
      const field = {
        width: '100%',
        background: C.bg,
        color: C.text,
        border: '1px solid ' + C.border,
        borderRadius: 6,
        padding: '7px 9px',
        font: 'inherit',
        boxSizing: 'border-box',
      }
      const go = {
        padding: '6px 14px',
        borderRadius: 6,
        border: '1px solid ' + C.accent,
        background: C.accent,
        color: '#fff',
        cursor: 'pointer',
        font: 'inherit',
        alignSelf: 'flex-start',
      }
      return h(
        'div',
        { style: wrap },
        h('div', { style: { fontSize: 15, fontWeight: 600 } }, 'PDF：先渲染成图片再框选'),
        h(
          'div',
          { style: { color: C.textDim } },
          '浏览器里没有 PDF 引擎，无法直接在页面上拖框。这里把「渲染请求」插进输入框：' +
            '我按你给的页码用 pymupdf 渲染成 300 dpi PNG，之后你在图片标注界面里框选提问。'
        ),
        h(
          'div',
          { style: { color: C.textDim, fontSize: 12, wordBreak: 'break-all' } },
          '当前文件：' + path
        ),
        h('div', { style: { marginTop: 4 } }, '页码范围'),
        h('input', {
          style: field,
          placeholder: '例如：14-16　或　单页 14　（原书页码请注明，如「书页 1-3」）',
          value: pages,
          onChange: function (e) {
            setPages(e.target.value)
          },
        }),
        h('button', { style: go, onClick: submit }, '插入渲染请求到输入框'),
        note ? h('div', { style: { color: C.textDim, fontSize: 12 } }, note) : null,
        h(
          'div',
          {
            style: {
              color: C.textDim,
              fontSize: 12,
              marginTop: 8,
              borderTop: '1px solid ' + C.border,
              paddingTop: 8,
            },
          },
          '已有的图片文件（png/jpg/webp…）可直接在文件树里点开，用拖框标注；' +
            '文本 / Markdown / 代码用 dsh-annotation 的「选中文字加批注」。'
        )
      )
    }

    /**
     * Global marquee selector, mounted in the `shell.overlay` slot.
     *
     * This is the "drag a rectangle like selecting files on the desktop" tool:
     * it neither replaces nor wraps any file viewer, so markdown previews,
     * the code editor, PDFs and images all keep their own rendering. Activate
     * it (button or Alt+Q), drag a rectangle anywhere on the page, and it reads
     * back whatever sits inside the rectangle:
     *
     * - **text** — every text node whose client rects intersect the marquee, in
     *   document order, so a box over half a markdown paragraph yields exactly
     *   those words;
     * - **image** — an `<img>` intersecting the marquee becomes a pixel rect
     *   relative to that image's natural size (exact `crop()` coordinates);
     * - **file** — the nearest `[data-path]` ancestor names the file.
     *
     * It then composes a prompt the agent can act on and inserts it into the
     * composer. Nothing is written from the browser; coordinates are handed
     * over verbatim so the agent crops precisely.
     */
    /**
     * Sidebar-scoped marquee for "request changes".
     *
     * Flow:
     *   1. arm it (sidebar header button or the floating ball);
     *   2. the cover only spans the RIGHT SIDEBAR, so the chat stays usable;
     *   3. drag a rectangle → that rectangle immediately gets its OWN annotation
     *      field pinned next to it, with two round buttons (✓ save / ✕ discard);
     *   4. repeat for as many regions as needed — each keeps its own note;
     *   5. the bottom bar's 确认修改 sends ONE message carrying every saved
     *      region, its note, its extracted text, and the exact geometry so the
     *      agent can screenshot-and-crop the visible pixels.
     *
     * Geometry reported per region is in **viewport CSS px**; together with the
     * window metrics in the header it maps onto a desktop screenshot.
     *
     * @param {{ ctx: unknown }} props
     */
    function ShellMarquee(props) {
      const [phase, setPhase] = React.useState('idle') // 'idle' | 'armed' | 'draft'
      const [drag, setDrag] = React.useState(null) // {x0,y0,cur}
      const [boxes, setBoxes] = React.useState([]) // saved: {x,y,w,h,note,text,img}
      const [draft, setDraft] = React.useState(null) // {x,y,w,h,text,img,note}
      const [bounds, setBounds] = React.useState(null)
      const [scroll, setScroll] = React.useState(0)
      // Geometry captured the moment the tool was armed — used to detect drift.
      const [armInfo, setArmInfo] = React.useState(null)
      // The clean freeze-frame the HOST captured at arm time (before any overlay
      // painted). { ok, path, w, h, at, error }
      const [shot, setShot] = React.useState(null)
      const [note, setNote] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const dragRef = React.useRef(null)
      const draftRef = React.useRef(null)
      dragRef.current = drag
      draftRef.current = draft

      /** Sidebar rect in viewport coords (multi-strategy, geometry-verified). */
      const sidebarRect = function () {
        const vw = window.innerWidth || 0
        const vh = window.innerHeight || 0
        const pack = function (r) {
          return { left: r.left, top: r.top, width: r.width, height: r.height }
        }
        try {
          const direct = ['[data-dsh-better-sidebar]', '[data-dsh-panel-host] > *', '[data-dsh-bottom-panel]']
          for (let i = 0; i < direct.length; i++) {
            const el = document.querySelector(direct[i])
            if (!el) continue
            const r = el.getBoundingClientRect()
            if (r.width >= 160 && r.height >= vh * 0.4) return pack(r)
          }
        } catch (_) {
          /* miss */
        }
        try {
          const inner = ['[data-path]', '[data-dir]', '.cm-editor', '.cm-content', '[data-dsh-revealed]']
          for (let i = 0; i < inner.length; i++) {
            const el = document.querySelector(inner[i])
            if (!el) continue
            let node = el
            for (let d = 0; d < 12 && node && node !== document.body; d++) {
              const r = node.getBoundingClientRect()
              if (r.width >= 160 && r.height >= vh * 0.4 && r.right <= vw + 2 && r.width < vw * 0.96) {
                return pack(r)
              }
              node = node.parentElement
            }
          }
        } catch (_) {
          /* miss */
        }
        try {
          const all = document.body.querySelectorAll('div, aside, section')
          let best = null
          for (let i = 0; i < all.length && i < 4000; i++) {
            const r = all[i].getBoundingClientRect()
            if (r.width < 200 || r.width > vw * 0.9) continue
            if (r.height < vh * 0.6) continue
            if (Math.abs(r.right - vw) > 6) continue
            if (!best || r.width > best.width) best = r
          }
          if (best) return pack(best)
        } catch (_) {
          /* miss */
        }
        return null
      }

      /** The file the sidebar currently has open. */
      const currentSidebarFile = function (ctx) {
        try {
          const sb = ctx && typeof ctx.get === 'function' ? ctx.get('betterSidebar') : undefined
          const store = sb && sb.store
          if (store && typeof store.getSnapshot === 'function') {
            const snap = store.getSnapshot()
            const st = snap && snap.state
            if (st) {
              const walk = function (node) {
                if (!node || typeof node !== 'object') return null
                if (node.kind === 'leaf' && Array.isArray(node.tabs)) {
                  const t = node.tabs.find(function (x) {
                    return x && x.id === node.active
                  })
                  if (t && typeof t.path === 'string' && t.path) return t.path
                  return null
                }
                if (Array.isArray(node.children)) {
                  for (let i = 0; i < node.children.length; i++) {
                    const r = walk(node.children[i])
                    if (r) return r
                  }
                }
                return null
              }
              const panes = st.panes || st.pane || st.root
              if (panes && typeof panes === 'object') {
                if (st.activePane && panes[st.activePane]) {
                  const r = walk(panes[st.activePane])
                  if (r) return r
                }
                const r = walk(panes)
                if (r) return r
              }
            }
          }
        } catch (_) {
          /* store shape */
        }
        const looksLikePath = function (v) {
          return v && v.length <= 300 && (/[\\/]/.test(v) || /\.[A-Za-z0-9]{1,8}$/.test(v))
        }
        try {
          const inputs = document.querySelectorAll('input')
          for (let i = 0; i < inputs.length; i++) {
            const v = (inputs[i].value || '').trim()
            if (looksLikePath(v)) return v
          }
        } catch (_) {
          /* no inputs */
        }
        try {
          const sel = document.querySelector('[aria-selected="true"], [data-active="true"], [data-selected="true"]')
          if (sel) {
            const a = sel.getAttribute('title') || sel.getAttribute('data-path') || ''
            if (looksLikePath(a)) return a
            const t = (sel.textContent || '').trim()
            if (looksLikePath(t)) return t
          }
        } catch (_) {
          /* no tab */
        }
        return ''
      }

      /** Window geometry so a desktop screenshot can be mapped to CSS pixels. */
      const envInfo = function (b) {
        return {
          vw: window.innerWidth || 0,
          vh: window.innerHeight || 0,
          dpr: window.devicePixelRatio || 1,
          screenX: window.screenX || 0,
          screenY: window.screenY || 0,
          outerW: window.outerWidth || 0,
          outerH: window.outerHeight || 0,
          chromeH: Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0)),
          sidebar: b,
          sidebarScroll: (function () {
            try {
              const sc =
                document.querySelector('.cm-scroller') ||
                document.querySelector('[data-dsh-better-sidebar]')
              return sc ? Math.round(sc.scrollTop || 0) : 0
            } catch (_) {
              return 0
            }
          })(),
        }
      }

      const hit = function (a, b) {
        return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom
      }

      /** All text nodes whose client rects intersect the marquee. */
      const collectText = function (rect) {
        const parts = []
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
              const p = node.parentElement
              if (!p) return NodeFilter.FILTER_REJECT
              if (p.closest('[data-ia-ui]')) return NodeFilter.FILTER_REJECT
              const tag = p.tagName
              if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT
              if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
              return NodeFilter.FILTER_ACCEPT
            },
          })
          let node
          let guard = 0
          while ((node = walker.nextNode()) && guard < 20000) {
            guard++
            const range = document.createRange()
            range.selectNodeContents(node)
            const rects = range.getClientRects()
            for (let i = 0; i < rects.length; i++) {
              if (hit(rects[i], rect)) {
                parts.push(node.nodeValue)
                break
              }
            }
          }
        } catch (_) {
          /* best effort */
        }
        return parts.join(' ').replace(/[ \t\u00a0]+/g, ' ').trim()
      }

      /** An <img> the marquee overlaps, reported as source-image pixel coords. */
      const detectImage = function (rect) {
        try {
          const imgs = Array.prototype.slice.call(document.images || [])
          for (let i = 0; i < imgs.length; i++) {
            const el = imgs[i]
            if (!el.getBoundingClientRect) continue
            const r = el.getBoundingClientRect()
            if (!hit(r, rect) || r.width < 2 || r.height < 8) continue
            const iw = el.naturalWidth || 0
            const ih = el.naturalHeight || 0
            if (!iw || !ih) continue
            const ox = Math.max(0, rect.left - r.left)
            const oy = Math.max(0, rect.top - r.top)
            const w = Math.min(rect.right, r.right) - Math.max(rect.left, r.left)
            const hh = Math.min(rect.bottom, r.bottom) - Math.max(rect.top, r.top)
            const sx = iw / r.width
            const sy = ih / r.height
            return {
              src: el.currentSrc || el.src || '',
              x: Math.round(ox * sx),
              y: Math.round(oy * sy),
              w: Math.round(w * sx),
              h: Math.round(hh * sy),
              iw: iw,
              ih: ih,
            }
          }
        } catch (_) {
          /* best effort */
        }
        return null
      }

      const clampToSidebar = function (p, b) {
        if (!b) return p
        return {
          x: Math.min(Math.max(p.x, b.left), b.left + b.width),
          y: Math.min(Math.max(p.y, b.top), b.top + b.height),
        }
      }

      /** The scrollable element that holds the sidebar's file content. */
      const scrollerEl = function () {
        try {
          return (
            document.querySelector('.cm-scroller') ||
            document.querySelector('[data-dsh-better-sidebar]') ||
            null
          )
        } catch (_) {
          return null
        }
      }

      /** Current vertical scroll of the sidebar content. */
      const readScroll = function () {
        const el = scrollerEl()
        return el ? Math.round(el.scrollTop || 0) : 0
      }

      /**
       * Arm the tool: snapshot the sidebar geometry AND the scroll position, so
       * every box can be stored in CONTENT coordinates instead of viewport
       * coordinates. That is what makes the crop follow a moved/resized window
       * or a scrolled pane: we re-derive viewport coordinates at render time and
       * again at send time, against the then-current geometry.
       */
      const startSelecting = function () {
        let b = sidebarRect()
        let warn = ''
        if (!b) {
          b = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
          warn = '未能定位右侧栏，已退化为全屏框选。'
        }
        setBounds(b)
        setScroll(readScroll())
        setArmInfo({ at: Date.now(), bounds: b, scroll: readScroll() })
        setNote(warn)
        setDrag(null)
        setDraft(null)
        setPhase('armed')

        // Freeze the screen NOW, before the overlay paints, through the host
        // route. The resulting PNG is the exact frame the user armed on, so the
        // crops never depend on what the layout looks like at send time.
        setShot({ pending: true })
        try {
          fetch('/dsh-image-annotate/capture', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ env: envInfo(b), at: Date.now() }),
          })
            .then(function (r) { return r.json() })
            .then(function (j) { setShot(j || { ok: false, error: 'empty' }) })
            .catch(function (e) { setShot({ ok: false, error: String(e && e.message ? e.message : e) }) })
        } catch (e) {
          setShot({ ok: false, error: String(e && e.message ? e.message : e) })
        }
      }

      React.useEffect(function () {
        return marqueeBus.subscribe(function () {
          startSelecting()
        })
      }, [])

      // Keep the overlay glued to the sidebar while the window is resized/moved
      // or the file is scrolled: geometry and scroll are re-read continuously.
      React.useEffect(function () {
        if (phase === 'idle') return undefined
        const sync = function () {
          const b = sidebarRect()
          if (b) setBounds(b)
          setScroll(readScroll())
        }
        const sc = scrollerEl()
        window.addEventListener('resize', sync)
        window.addEventListener('scroll', sync, true)
        if (sc) sc.addEventListener('scroll', sync, { passive: true })
        const t = setInterval(sync, 500)
        return function () {
          window.removeEventListener('resize', sync)
          window.removeEventListener('scroll', sync, true)
          if (sc) sc.removeEventListener('scroll', sync)
          clearInterval(t)
        }
      }, [phase])

      // Esc cancels: a pending draft first, otherwise the whole session.
      React.useEffect(function () {
        const onKey = function (e) {
          if (e.key !== 'Escape') return
          if (draftRef.current) {
            setDraft(null)
            setNote('')
            setPhase('armed')
          } else {
            setBoxes([])
            setDrag(null)
            setNote('')
            setPhase('idle')
          }
        }
        document.addEventListener('keydown', onKey, true)
        return function () {
          document.removeEventListener('keydown', onKey, true)
        }
      }, [])

      // ---- drag ----------------------------------------------------------
      const onDown = function (e) {
        if (draftRef.current) return // finish the open annotation first
        const p = clampToSidebar({ x: e.clientX, y: e.clientY }, bounds)
        dragRef.current = { x0: p.x, y0: p.y, cur: p }
        setDrag(dragRef.current)
      }
      const onMove = function (e) {
        if (!dragRef.current) return
        const p = clampToSidebar({ x: e.clientX, y: e.clientY }, bounds)
        setDrag({ x0: dragRef.current.x0, y0: dragRef.current.y0, cur: p })
      }
      const onUp = function (e) {
        const d = dragRef.current
        setDrag(null)
        if (!d) return
        const end = clampToSidebar({ x: e.clientX, y: e.clientY }, bounds)
        const rect = {
          left: Math.min(d.x0, end.x),
          top: Math.min(d.y0, end.y),
          right: Math.max(d.x0, end.x),
          bottom: Math.max(d.y0, end.y),
        }
        rect.width = rect.right - rect.left
        rect.height = rect.bottom - rect.top
        if (rect.width < 6 || rect.height < 6) return
        setDraft({
          // CONTENT coordinates: x is the offset from the sidebar's left edge,
          // y is the offset from the scroller's content origin.
          cx: Math.round(rect.left - (bounds ? bounds.left : 0)),
          cy: Math.round(rect.top - (bounds ? bounds.top : 0) + scroll),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          text: collectText(rect),
          img: detectImage(rect),
          note: '',
        })
        setPhase('draft')
      }

      // ---- per-box actions -----------------------------------------------
      const saveDraft = function () {
        const d = draftRef.current
        if (!d) return
        if (!d.note.trim() && !d.text && !d.img) {
          setNote('这条没有注释，已丢弃。')
          setDraft(null)
          setPhase('armed')
          return
        }
        setBoxes(function (prev) {
          return prev.concat([
            {
              cx: d.cx,
              cy: d.cy,
              w: d.w,
              h: d.h,
              note: d.note.trim(),
              text: d.text,
              img: d.img,
            },
          ])
        })
        setDraft(null)
        setNote('')
        setPhase('armed')
      }
      const discardDraft = function () {
        setDraft(null)
        setNote('')
        setPhase('armed')
      }
      const removeBox = function (idx) {
        setBoxes(function (prev) {
          return prev.filter(function (_, i) {
            return i !== idx
          })
        })
      }
      const cancelAll = function () {
        setBoxes([])
        setDraft(null)
        setDrag(null)
        setNote('')
        setPhase('idle')
      }

      // ---- compose + send -------------------------------------------------
      /** Compose the single message describing every saved region. */
      const composeText = function () {
        const file = currentSidebarFile(props.ctx)
        // Re-resolve geometry NOW: the window may have moved, been resized, or
        // the file scrolled since the tool was armed. Boxes are stored in
        // content coordinates precisely so this re-derivation stays correct.
        const nowBounds = sidebarRect() || bounds
        const nowScroll = readScroll()
        const env = envInfo(nowBounds)
        const viewportOf = function (b) {
          const sb = nowBounds || { left: 0, top: 0 }
          return {
            x: Math.round(sb.left + b.cx),
            y: Math.round(sb.top + b.cy - nowScroll),
            w: Math.round(b.w),
            h: Math.round(b.h),
          }
        }
        const L = []
        L.push('【请求修改 · 侧栏框选 ' + boxes.length + ' 处】')
        if (file) L.push('文件：`' + file + '`')
        L.push('')
        L.push('### 冻结帧（宿主在「点请求修改」那一刻截的，**不含任何标注**）')
        if (shot && shot.ok && shot.path) {
          L.push('截图文件：`' + shot.path + '`')
          L.push('截图尺寸：' + shot.w + 'x' + shot.h + ' px，截于 ' + new Date(shot.at).toLocaleTimeString())
          L.push('👉 **优先用这张图裁剪**：它对应我按下按钮的瞬间，不受之后滚动/窗口变动影响。')
        } else {
          L.push('⚠️ 宿主截屏不可用（' + ((shot && (shot.error || '未知')) || '未触发') + '）。')
          L.push('请我在收到本条消息时立刻用 DPI-aware 桌面截屏，再按下面的坐标裁剪。')
        }
        L.push('')
        L.push('### 截图换算（发送时刻的实时几何，作兜底）')
        L.push(
          '视口 ' + env.vw + 'x' + env.vh + ' CSS px，dpr ' + env.dpr +
          '，窗口外框 ' + env.outerW + 'x' + env.outerH +
          '，浏览器边框高 chromeH=' + env.chromeH + ' px'
        )
        L.push('窗口左上角（外框）：screenX=' + env.screenX + ', screenY=' + env.screenY)
        if (env.sidebar) {
          L.push(
            '侧栏在视口中的矩形：left=' + Math.round(env.sidebar.left) +
            ', top=' + Math.round(env.sidebar.top) +
            ', w=' + Math.round(env.sidebar.width) +
            ', h=' + Math.round(env.sidebar.height)
          )
          L.push('侧栏内部滚动量：' + env.sidebarScroll)
        }
        L.push('')
        L.push('**换算公式**（CSS px → 桌面截图 px）：')
        L.push('') 
        L.push('```')
        L.push('sx = (screenX + 视口x) * dpr')
        L.push('sy = (screenY + chromeH + 视口y) * dpr')
        L.push('sw = 视口w * dpr ; sh = 视口h * dpr')
        L.push('```')
        L.push('')
        L.push('请先对桌面整屏截图，再按上式裁剪每个框（以及整个侧栏），这样拿到的是我框住的真实像素。')
        L.push('注意：我的遮罩与框内填充都是透明的，截图里只会看到细边框，可按坐标大致对齐后裁掉边框。')
        boxes.forEach(function (b, i) {
          L.push('')
          const vp = viewportOf(b)
          L.push('### 框 ' + (i + 1))
          L.push('- 视口坐标：x=' + vp.x + ', y=' + vp.y + ', w=' + vp.w + ', h=' + vp.h)
          L.push('- 截图坐标：x=' + Math.round((env.screenX + vp.x) * env.dpr) +
                ', y=' + Math.round((env.screenY + env.chromeH + vp.y) * env.dpr) +
                ', w=' + Math.round(vp.w * env.dpr) + ', h=' + Math.round(vp.h * env.dpr))
          L.push('- 注释：' + (b.note || '（无）'))
          if (b.img) {
            L.push(
              '- 含图片区域：原图 ' + b.img.iw + 'x' + b.img.ih +
              '，在原图内的裁剪 x=' + b.img.x + ', y=' + b.img.y +
              ', w=' + b.img.w + ', h=' + b.img.h +
              (b.img.src ? '，来源 ' + b.img.src : '')
            )
          }
          if (b.text) {
            L.push('- 框内文字：')
            L.push('```')
            L.push(b.text.slice(0, 3000))
            L.push('```')
          }
        })
        L.push('')
        L.push('请按上面每条的注释，对照裁剪出的图片逐条处理。')
        return L.join('\n')
      }

      const send = function () {
        if (boxes.length === 0) {
          setNote('还没有保存任何框。')
          return
        }
        setBusy(true)
        const text = composeText()
        const sid = resolveSessionId(props.ctx, props)
        if (!insertIntoComposer(props.ctx, sid, text)) {
          setNote('插入失败（' + (lastInsertWhy || lastProbe || '未知') + '），已复制到剪贴板。')
          deliverPrompt(props.ctx, '', text, function () {})
          setBusy(false)
          return
        }
        // Send it for real: same call dsh-annotation uses.
        let sent = false
        try {
          const sessionsSvc =
            props.ctx.sessions || (typeof props.ctx.get === 'function' ? props.ctx.get('sessions') : undefined)
          const actx = sessionsSvc && sessionsSvc.scope ? sessionsSvc.scope(sid) : undefined
          const conversation = props.ctx.conversation
          const input = conversation && actx ? conversation.input.for(actx) : undefined
          if (input && typeof input.submit === 'function') {
            input.submit('queue')
            sent = true
          }
        } catch (_) {
          sent = false
        }
        setBusy(false)
        if (sent) {
          cancelAll()
        } else {
          setNote('已填入输入框，请按回车发送。')
          cancelAll()
        }
      }

      // ---- styles --------------------------------------------------------
      const ball = {
        position: 'fixed',
        right: 18,
        bottom: 84,
        zIndex: 8000,
        pointerEvents: 'auto',
        padding: '7px 13px',
        borderRadius: 999,
        border: '1px solid ' + C.accent,
        background: C.panel,
        color: C.text,
        cursor: 'pointer',
        font: '12px system-ui, sans-serif',
        boxShadow: '0 3px 14px rgba(0,0,0,.45)',
      }
      const cover = bounds
        ? {
            position: 'fixed',
            left: bounds.left + 'px',
            top: bounds.top + 'px',
            width: bounds.width + 'px',
            height: bounds.height + 'px',
            zIndex: 9000,
            cursor: 'crosshair',
            pointerEvents: 'auto',
            background: 'transparent',
          }
        : { display: 'none' }
      /**
       * Viewport rect for a box stored in content coordinates, derived against
       * the CURRENT sidebar geometry and scroll. This is what makes the overlay
       * follow a moved/resized window or a scrolled pane.
       */
      const toViewport = function (b) {
        const sb = bounds || { left: 0, top: 0 }
        return {
          x: Math.round(sb.left + b.cx),
          y: Math.round(sb.top + b.cy - scroll),
          w: b.w,
          h: b.h,
        }
      }
      const boxStyle = function (b, draftMode) {
        const vp = toViewport(b)
        return {
          position: 'fixed',
          left: vp.x + 'px',
          top: vp.y + 'px',
          width: vp.w + 'px',
          height: vp.h + 'px',
          border: (draftMode ? '2px dashed ' : '2px solid ') + (draftMode ? C.warn : C.accent),
          background: 'transparent',
          borderRadius: 3,
          pointerEvents: 'none',
          boxSizing: 'border-box',
          zIndex: 9010,
        }
      }
      const badge = function (color) {
        return {
          position: 'absolute',
          left: -2,
          top: -20,
          background: color,
          color: '#fff',
          borderRadius: '0 0 4px 4px',
          padding: '0 6px',
          font: '11px/18px system-ui, sans-serif',
          whiteSpace: 'nowrap',
        }
      }
      const roundBtn = function (ok) {
        return {
          width: 26,
          height: 26,
          borderRadius: '50%',
          border: 'none',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          font: '14px/1 system-ui, sans-serif',
          background: ok ? '#2ea043' : '#8b949e',
          color: '#fff',
          padding: 0,
        }
      }
      const popover = function (d) {
        // Place to the right of the box when it fits inside the sidebar,
        // otherwise below it (still inside the sidebar column).
        const sb = bounds || { left: 0, width: window.innerWidth }
        const wPanel = 260
        let left = toViewport(d).x + d.w + 10
        if (left + wPanel > sb.left + sb.width - 8) left = Math.max(sb.left + 8, toViewport(d).x - wPanel - 10)
        if (left < sb.left + 8) left = sb.left + 8
        let top = toViewport(d).y
        if (top + 150 > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 160)
        return {
          position: 'fixed',
          left: left + 'px',
          top: top + 'px',
          width: wPanel + 'px',
          zIndex: 9200,
          pointerEvents: 'auto',
          background: C.panel,
          color: C.text,
          border: '1px solid ' + C.border,
          borderRadius: 8,
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          boxShadow: '0 6px 20px rgba(0,0,0,.45)',
          font: '12px/1.5 system-ui, sans-serif',
        }
      }
      const bottomBar = {
        position: 'fixed',
        left: (bounds ? bounds.left + 8 : 8) + 'px',
        bottom: 10,
        width: (bounds ? Math.max(240, bounds.width - 16) : 420) + 'px',
        zIndex: 9250,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: 8,
        background: C.panel,
        border: '1px solid ' + C.border,
        borderRadius: 10,
        boxShadow: '0 6px 20px rgba(0,0,0,.45)',
        boxSizing: 'border-box',
        font: '12px system-ui, sans-serif',
      }
      const ta = {
        width: '100%',
        minHeight: 46,
        resize: 'vertical',
        background: C.bg,
        color: C.text,
        border: '1px solid ' + C.border,
        borderRadius: 6,
        padding: 6,
        font: 'inherit',
        boxSizing: 'border-box',
      }
      const primaryBtn = {
        padding: '6px 14px',
        borderRadius: 6,
        border: '1px solid ' + C.accent,
        background: C.accent,
        color: '#fff',
        cursor: 'pointer',
        font: 'inherit',
        whiteSpace: 'nowrap',
      }
      const ghostBtn = {
        padding: '6px 12px',
        borderRadius: 6,
        border: '1px solid ' + C.border,
        background: 'transparent',
        color: C.text,
        cursor: 'pointer',
        font: 'inherit',
        whiteSpace: 'nowrap',
      }

      // ---- render --------------------------------------------------------
      if (phase === 'idle') {
        return h(
          'div',
          { 'data-ia-ui': '1' },
          h(
            'button',
            {
              style: ball,
              title: '在右侧栏里框选内容，逐块注释后一次性发出',
              onClick: startSelecting,
            },
            '⌗ 请求修改'
          ),
          note
            ? h(
                'div',
                {
                  style: {
                    position: 'fixed',
                    right: 18,
                    bottom: 122,
                    zIndex: 8000,
                    pointerEvents: 'auto',
                    maxWidth: 260,
                    padding: '6px 10px',
                    borderRadius: 8,
                    background: C.panel,
                    color: C.warn,
                    border: '1px solid ' + C.border,
                    font: '12px system-ui, sans-serif',
                  },
                },
                note
              )
            : null
        )
      }

      const liveRect = drag
        ? {
            x: Math.min(drag.x0, drag.cur.x),
            y: Math.min(drag.y0, drag.cur.y),
            w: Math.abs(drag.cur.x - drag.x0),
            h: Math.abs(drag.cur.y - drag.y0),
          }
        : null

      return h(
        'div',
        { 'data-ia-ui': '1' },
        h('div', {
          style: cover,
          onMouseDown: function (e) {
            if (e.button !== 0) return
            e.preventDefault()
            onDown(e)
          },
          onMouseMove: onMove,
          onMouseUp: onUp,
        }),

        // Saved regions with their notes.
        boxes.map(function (b, i) {
          return h(
            'div',
            { key: 'b' + i, style: boxStyle(b) },
            h('span', { style: badge(C.accent) }, (i + 1) + (b.note ? ' ' + b.note.slice(0, 14) : '')),
            h(
              'button',
              {
                style: Object.assign({}, roundBtn(false), {
                  position: 'absolute',
                  right: -12,
                  top: -12,
                  pointerEvents: 'auto',
                  width: 20,
                  height: 20,
                  font: '11px/1 system-ui, sans-serif',
                  zIndex: 9020,
                }),
                title: '删除这一框',
                onClick: function () {
                  removeBox(i)
                },
              },
              '×'
            )
          )
        }),

        // Live drag rectangle.
        liveRect && liveRect.w > 0
          ? h('div', { style: boxStyle(liveRect, true) })
          : null,

        // The draft box + its own annotation field with ✓ / ✕.
        draft
          ? h(
              'div',
              { style: boxStyle(draft, true) },
              h('span', { style: badge(C.warn) }, String(boxes.length + 1))
            )
          : null,
        draft
          ? h(
              'div',
              { style: popover(draft) },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('strong', { style: { flex: '1 1 auto' } }, '框 ' + (boxes.length + 1) + ' 注释'),
                h('button', { style: roundBtn(true), title: '保存这一框', onClick: saveDraft }, '✓'),
                h('button', { style: roundBtn(false), title: '丢弃这一框', onClick: discardDraft }, '×')
              ),
              h('textarea', {
                style: ta,
                autoFocus: true,
                placeholder: '对这块的要求，例如：把这段公式转成 LaTeX',
                value: draft.note,
                onChange: function (e) {
                  const v = e.target.value
                  setDraft(function (prev) {
                    return prev ? Object.assign({}, prev, { note: v }) : prev
                  })
                },
                onKeyDown: function (e) {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    saveDraft()
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    discardDraft()
                  }
                },
              }),
              h(
                'div',
                { style: { color: C.textDim, fontSize: 11 } },
                (draft.text ? '文字 ' + draft.text.length + ' 字' : '无文字') +
                  (draft.img ? '　·　含图片区域' : '') +
                  '　·　Ctrl+Enter 保存'
              )
            )
          : null,

        // Bottom bar: confirm & send everything.
        h(
          'div',
          { style: bottomBar },
          h('span', { style: { color: C.textDim } }, '已框 ' + boxes.length + ' 处'),
          h('span', { style: { flex: '1 1 auto' } }),
          note ? h('span', { style: { color: C.warn, fontSize: 11, maxWidth: 180 } }, note) : null,
          h('button', { style: ghostBtn, onClick: cancelAll }, '取消'),
          h(
            'button',
            { style: primaryBtn, disabled: busy || boxes.length === 0, onClick: send },
            '确认修改并发送'
          )
        )
      )
    }

    return {
      // Cordis REJECTS property access on an undeclared service:
      // `ctx.sessions` throws "cannot get property \"sessions\" without inject".
      // `ctx.get('x')` is the inject-free read; anything we reach as `ctx.x`
      // must be listed here. `sessions` (scope) and `conversation` (composer)
      // are both core in the web profile, so requiring them is safe.
      inject: ['slots', 'sessions', 'conversation'],

      apply(ctx) {
        // 1) Global marquee into the shell overlay — independent of any viewer.
        try {
          if (ctx.slots && typeof ctx.slots.inject === 'function') {
            const slots = [
              // The marquee itself (a viewport overlay layer). `shell.overlay`
              // does NOT hand its components a cordis ctx, so it is injected
              // explicitly here — without this the panel had no services.
              {
                name: 'shell.overlay',
                id: 'dsh-image-annotate:marquee',
                order: 900,
                component: ShellMarquee,
                inject: function () {
                  return { ctx: ctx }
                },
              },
              // Sidebar entry point: a "请求修改" button in the session header.
              {
                name: 'conversation.session.header.utilities',
                id: 'dsh-image-annotate:button',
                order: 60,
                component: MarqueeButton,
                // This slot is session-scoped: it calls inject(sessionId) and
                // merges the result into the component's props.
                inject: function (sessionId) {
                  return { sessionId: sessionId, ctx: ctx }
                },
              },
            ]
            slots.forEach(function (s) {
              try {
                const d = ctx.slots.inject(s.name, function () {
                  return ctx.slots.register(
                    {
                      name: s.name,
                      id: s.id,
                      order: s.order,
                      registrant: 'dsh-image-annotate',
                      ...(s.inject ? { inject: s.inject } : {}),
                    },
                    s.component
                  )
                })
                if (typeof ctx.effect === 'function' && typeof d === 'function') {
                  ctx.effect(function () {
                    return d
                  })
                }
              } catch (err) {
                console.warn('[dsh-image-annotate] slot registration failed: ' + s.name, err)
              }
            })
          }
        } catch (err) {
          console.warn('[dsh-image-annotate] slot wiring failed', err)
        }

        // 2) Image + PDF viewers (optional: only when better-sidebar is mounted).
        let sb
        try {
          sb = ctx.get('betterSidebar')
        } catch (_) {
          sb = undefined
        }
        if (!sb || typeof sb.registerFileViewer !== 'function') {
          console.warn('[dsh-image-annotate] betterSidebar service unavailable; file viewers not registered')
          return
        }
        const disposers = []
        disposers.push(
          sb.registerFileViewer({
            id: 'dsh-image-annotate:image',
            title: '图片标注',
            exts: IMAGE_EXTS,
            priority: 50,
            fetchStrategy: 'mediaUrl',
            component: ImageAnnotateViewer,
          })
        )
        disposers.push(
          sb.registerFileViewer({
            id: 'dsh-image-annotate:pdf',
            title: 'PDF 转图标注',
            exts: ['pdf'],
            priority: 50,
            fetchStrategy: 'mediaUrl',
            component: PdfRenderHelper,
          })
        )
        if (typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return function () {
              disposers.forEach(function (d) {
                if (typeof d === 'function') d()
              })
            }
          })
        }
      },
    }
  },
})
