
window.__ModuleLoader__.load({
  id: 'dsh-flowgate',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement
    const useEffect = react.useEffect
    const useState = react.useState
    const useRef = react.useRef

    const API = '/api/flowgate'
    const STYLE_ID = 'dsh-flowgate-styles'
    const POLL_MS = 1500

    const CSS_TEXT = `
.fg-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  font-size: 13px;
  color: var(--dsw-alias-text-primary, #1f2328);
  background: var(--dsw-alias-bg-base, #fbfbfc);
}
.fg-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-default, #e6e8eb);
  background: var(--dsw-alias-bg-elevated, #ffffff);
  flex: none;
}
.fg-title { font-weight: 600; font-size: 13px; }
.fg-sub { color: var(--dsw-alias-text-secondary, #667085); font-size: 12px; }
.fg-spacer { flex: 1; }
.fg-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr) 296px;
  gap: 0;
}
.fg-body.collapsed { grid-template-columns: 168px minmax(0, 1fr); }
.fg-nav {
  border-right: 1px solid var(--dsw-alias-border-default, #e6e8eb);
  padding: 12px 10px;
  overflow: auto;
  background: var(--dsw-alias-bg-elevated, #ffffff);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fg-stage {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  cursor: default;
}
.fg-stage.on {
  border-color: var(--dsw-alias-accent-primary, #3b6ef6);
  background: var(--dsw-alias-bg-accent-soft, #eef3ff);
}
.fg-stage-top { display: flex; align-items: center; gap: 6px; }
.fg-stage-idx {
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-text-tertiary, #98a2b3);
  font-size: 11px;
}
.fg-stage-name { font-weight: 500; }
.fg-stage-out { font-size: 11px; color: var(--dsw-alias-text-tertiary, #98a2b3); line-height: 1.4; }
.fg-main {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.fg-side {
  border-left: 1px solid var(--dsw-alias-border-default, #e6e8eb);
  background: var(--dsw-alias-bg-elevated, #ffffff);
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.fg-card {
  border: 1px solid var(--dsw-alias-border-default, #e6e8eb);
  border-radius: 10px;
  background: var(--dsw-alias-bg-elevated, #ffffff);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.fg-card.grow { flex: 1; min-height: 320px; }
.fg-card-title { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 8px; }
.fg-q { font-size: 14px; font-weight: 600; line-height: 1.5; }
.fg-muted { color: var(--dsw-alias-text-secondary, #667085); line-height: 1.6; }
.fg-tiny { font-size: 11px; color: var(--dsw-alias-text-tertiary, #98a2b3); line-height: 1.6; }
.fg-opt {
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-default, #e6e8eb);
  background: var(--dsw-alias-bg-base, #fbfbfc);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.fg-opt:hover:not(:disabled) { border-color: var(--dsw-alias-accent-primary, #3b6ef6); }
.fg-opt:disabled { opacity: 0.5; cursor: not-allowed; }
.fg-opt.rec { border-color: var(--dsw-alias-accent-primary, #3b6ef6); background: var(--dsw-alias-bg-accent-soft, #eef3ff); }
.fg-opt-label { font-weight: 600; display: flex; gap: 6px; align-items: center; }
.fg-opt-tradeoff { font-size: 12px; color: var(--dsw-alias-text-secondary, #667085); }
.fg-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.fg-btn {
  border: 1px solid var(--dsw-alias-border-default, #e6e8eb);
  background: var(--dsw-alias-bg-elevated, #ffffff);
  color: inherit;
  font: inherit;
  padding: 6px 12px;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
}
.fg-btn:hover:not(:disabled) { border-color: var(--dsw-alias-accent-primary, #3b6ef6); }
.fg-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.fg-btn.primary {
  background: var(--dsw-alias-accent-primary, #3b6ef6);
  border-color: var(--dsw-alias-accent-primary, #3b6ef6);
  color: #fff;
  font-weight: 600;
}
.fg-btn.danger { color: var(--dsw-alias-text-danger, #b42318); }
.fg-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  border: 1px solid var(--dsw-alias-border-default, #e6e8eb);
  color: var(--dsw-alias-text-secondary, #667085);
  white-space: nowrap;
}
.fg-badge.ok { color: #067647; border-color: #abefc6; background: #ecfdf3; }
.fg-badge.warn { color: #b54708; border-color: #fedf89; background: #fffaeb; }
.fg-badge.bad { color: #b42318; border-color: #fecdca; background: #fef3f2; }
.fg-badge.info { color: #175cd3; border-color: #b2ddff; background: #eff8ff; }
.fg-doc { flex: 1; min-height: 320px; display: flex; }
.fg-doc iframe {
  flex: 1;
  width: 100%;
  min-height: 320px;
  border: 0;
  border-radius: 8px;
  background: #fff;
}
.fg-list { display: flex; flex-direction: column; gap: 6px; }
.fg-item {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 7px 9px;
  border-radius: 7px;
  background: var(--dsw-alias-bg-base, #fbfbfc);
  border: 1px solid var(--dsw-alias-border-default, #f0f1f3);
}
.fg-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.fg-check { display: flex; gap: 7px; align-items: flex-start; cursor: pointer; padding: 3px 0; }
.fg-check input { margin: 2px 0 0; }
.fg-grant { margin-left: 22px; }
.fg-input {
  border: 1px solid var(--dsw-alias-border-default, #e6e8eb);
  border-radius: 7px;
  padding: 6px 9px;
  font: inherit;
  background: var(--dsw-alias-bg-base, #fbfbfc);
  color: inherit;
  width: 100%;
  box-sizing: border-box;
}
.fg-textarea {
  border: 1px solid var(--dsw-alias-border-default, #e6e8eb);
  border-radius: 7px;
  padding: 6px 9px;
  font: inherit;
  background: var(--dsw-alias-bg-base, #fbfbfc);
  color: inherit;
  width: 100%;
  min-height: 58px;
  resize: vertical;
  box-sizing: border-box;
}
.fg-err {
  border: 1px solid #fecdca;
  background: #fef3f2;
  color: #b42318;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
}
.fg-hr { height: 1px; background: var(--dsw-alias-border-default, #e6e8eb); margin: 2px 0; }
.fg-sec-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dsw-alias-text-tertiary, #98a2b3);
}
.fg-dock {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-default, #e6e8eb);
  border-radius: 9px;
  background: var(--dsw-alias-bg-elevated, #ffffff);
  font-size: 12px;
  margin-bottom: 8px;
}
@media (max-width: 900px) {
  .fg-body { grid-template-columns: 1fr; }
  .fg-nav { flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-default, #e6e8eb); }
  .fg-side { border-left: 0; border-top: 1px solid var(--dsw-alias-border-default, #e6e8eb); }
}
`

    let sharedSheet = null

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (sharedSheet || document.getElementById(STYLE_ID)) return
      try {
        if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
          const sheet = new CSSStyleSheet()
          sheet.replaceSync(CSS_TEXT)
          document.adoptedStyleSheets = Array.from(document.adoptedStyleSheets).concat(sheet)
          sharedSheet = sheet
          return
        }
      } catch (error) {
        // 落到 <style> 路径
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS_TEXT
      document.head.appendChild(style)
    }

    // -----------------------------------------------------------------------
    // 数据层：客户端只拉取 + 渲染 + 回调，流程逻辑全在宿主
    // -----------------------------------------------------------------------

    const EMPTY = { view: null, error: null }

    /** sessionId → { view, error } */
    const entries = new Map()
    /** sessionId → Set<listener> */
    const listeners = new Map()
    /** sessionId → interval */
    const timers = new Map()

    function emit(sessionId) {
      const set = listeners.get(sessionId)
      if (!set) return
      for (const fn of Array.from(set)) fn()
    }

    function setEntry(sessionId, next) {
      entries.set(sessionId, next)
      emit(sessionId)
    }

    async function pull(sessionId) {
      try {
        const res = await fetch(API + '/state?sessionId=' + encodeURIComponent(sessionId), {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
        if (!res.ok) throw new Error('宿主返回 HTTP ' + res.status)
        const view = await res.json()
        setEntry(sessionId, { view, error: null })
      } catch (error) {
        const prev = entries.get(sessionId) || EMPTY
        setEntry(sessionId, { view: prev.view, error: error?.message ?? String(error) })
      }
    }

    function subscribe(sessionId, fn) {
      let set = listeners.get(sessionId)
      if (!set) {
        set = new Set()
        listeners.set(sessionId, set)
      }
      set.add(fn)
      if (!timers.has(sessionId)) {
        void pull(sessionId)
        const timer = setInterval(() => { void pull(sessionId) }, POLL_MS)
        timers.set(sessionId, timer)
      }
      return () => {
        set.delete(fn)
        if (set.size === 0) {
          const timer = timers.get(sessionId)
          if (timer) clearInterval(timer)
          timers.delete(sessionId)
        }
      }
    }

    function useEntry(sessionId) {
      const [entry, setState] = useState(() => entries.get(sessionId) || EMPTY)
      useEffect(() => {
        let alive = true
        const sync = () => { if (alive) setState(entries.get(sessionId) || EMPTY) }
        sync()
        const unsubscribe = subscribe(sessionId, sync)
        return () => { alive = false; unsubscribe() }
      }, [sessionId])
      return entry
    }

    /** 提交一次按钮操作；返回错误文案或 null。 */
    async function act(sessionId, action, payload) {
      try {
        const res = await fetch(API + '/action', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, action, payload: payload || {} }),
        })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(data?.error || '宿主返回 HTTP ' + res.status)
        if (data && typeof data === 'object' && 'active' in data) setEntry(sessionId, { view: data, error: null })
        else void pull(sessionId)
        return null
      } catch (error) {
        const message = error?.message ?? String(error)
        const prev = entries.get(sessionId) || EMPTY
        setEntry(sessionId, { view: prev.view, error: message })
        return message
      }
    }

    // -----------------------------------------------------------------------
    // 原子组件
    // -----------------------------------------------------------------------

    function Badge({ tone, children }) {
      return h('span', { className: 'fg-badge' + (tone ? ' ' + tone : '') }, children)
    }

    function Btn({ children, onClick, disabled, tone, title }) {
      return h('button', {
        type: 'button',
        className: 'fg-btn' + (tone ? ' ' + tone : ''),
        onClick,
        disabled: Boolean(disabled),
        title,
      }, children)
    }

    function Card({ title, children, grow, extra }) {
      return h('div', { className: 'fg-card' + (grow ? ' grow' : '') },
        title ? h('div', { className: 'fg-card-title' }, title, extra) : null,
        children)
    }

    function Empty({ children }) {
      return h('div', { className: 'fg-muted' }, children)
    }

    const STAGE_TONE = { passed: 'ok', active: 'info', skipped_by_user: '', pending: '' }
    const STAGE_TEXT = { passed: '已通过', active: '进行中', skipped_by_user: '已跳过', pending: '待开始' }
    const VERDICT_TONE = { pass: 'ok', blocking: 'bad', advisory: 'warn' }
    const VERDICT_TEXT = { pass: '通过', blocking: '有阻塞项', advisory: '有建议项' }
    const SEV_TONE = { CRITICAL: 'bad', MAJOR: 'warn', MINOR: '' }
    const RESULT_TONE = { pass: 'ok', fail: 'bad', uncovered: 'warn' }
    const RESULT_TEXT = { pass: '通过', fail: '失败', uncovered: '未覆盖' }

    // -----------------------------------------------------------------------
    // S1：追问卡片
    // -----------------------------------------------------------------------

    function GrillCard({ sessionId, pending }) {
      const [custom, setCustom] = useState('')
      const [showCustom, setShowCustom] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      useEffect(() => {
        setCustom('')
        setShowCustom(false)
        setError(null)
      }, [pending.id])

      const options = Array.isArray(pending.options) ? pending.options : []
      const recommended = Number.isInteger(pending.recommended) ? pending.recommended : 0

      const submit = async (choiceIndex, customText) => {
        setBusy(true)
        setError(null)
        const failure = await act(sessionId, 'answer', { choiceIndex, customText: customText || '' })
        setBusy(false)
        if (failure) setError(failure)
      }

      return h(Card, { title: ['决策问题', h(Badge, { key: 'c', tone: 'info' }, 'S1 需求分析')] },
        h('div', { className: 'fg-q' }, pending.question),
        pending.context ? h('div', { className: 'fg-muted' }, pending.context) : null,
        h('div', { className: 'fg-list' }, options.map((option, index) =>
          h('button', {
            key: 'opt-' + index,
            type: 'button',
            className: 'fg-opt' + (index === recommended ? ' rec' : ''),
            disabled: busy,
            onClick: () => { void submit(index, '') },
          },
            h('span', { className: 'fg-opt-label' },
              h('span', null, option?.label ?? '选项 ' + (index + 1)),
              index === recommended ? h(Badge, { tone: 'info' }, '推荐') : null),
            option?.tradeoff ? h('span', { className: 'fg-opt-tradeoff' }, option.tradeoff) : null))),
        pending.allowCustom === false ? null : (showCustom
          ? h('div', { className: 'fg-row' },
              h('input', {
                className: 'fg-input',
                value: custom,
                placeholder: '用一句话说明你的选择',
                autoFocus: true,
                onChange: (event) => setCustom(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && custom.trim()) void submit(-1, custom.trim())
                },
              }),
              h(Btn, {
                tone: 'primary',
                disabled: busy || !custom.trim(),
                onClick: () => { void submit(-1, custom.trim()) },
              }, '提交'))
          : h('div', null, h(Btn, { onClick: () => setShowCustom(true), disabled: busy }, '自定义'))),
        error ? h('div', { className: 'fg-err' }, error) : null,
        h('div', { className: 'fg-tiny' }, '必须选择一项才能继续：追问不放行，也不会替你假设答案。'))
    }

    // -----------------------------------------------------------------------
    // S1：需求文档
    // -----------------------------------------------------------------------

    function DocGate({ sessionId, view, waiting, busy, setBusy }) {
      const run = async (decision) => {
        setBusy(true)
        await act(sessionId, 'doc', { decision })
        setBusy(false)
      }
      if (!waiting) {
        return h('div', { className: 'fg-tiny' }, '门禁未就绪：等 Agent 提交需求文档后，这里会出现「批准并冻结 scope」。')
      }
      return h('div', { className: 'fg-row' },
        h(Btn, { tone: 'primary', disabled: busy, onClick: () => { void run('approve') } }, '批准并冻结 scope'),
        h(Btn, { disabled: busy, onClick: () => { void run('revise') } }, '修改需求'),
        h(Btn, { disabled: busy, onClick: () => { void run('skip') } }, '跳过评审，直接开发'))
    }

    function PresetPicker({ sessionId, view, busy, setBusy }) {
      const presets = view.presets || {}
      const keys = Object.keys(presets)
      const recommended = view.doc?.recommendedPreset
      const choose = async (key) => {
        setBusy(true)
        await act(sessionId, 'preset', { preset: key })
        setBusy(false)
      }
      return h('div', { className: 'fg-list' },
        h('div', { className: 'fg-sec-title' }, '执行档位'),
        h('div', { className: 'fg-row' }, keys.map((key) => h('button', {
          key: 'preset-' + key,
          type: 'button',
          className: 'fg-opt' + (view.preset === key ? ' rec' : ''),
          style: { width: 'auto', flex: '1 1 160px' },
          disabled: busy,
          onClick: () => { void choose(key) },
        },
          h('span', { className: 'fg-opt-label' },
            h('span', null, presets[key]?.label ?? key),
            view.preset === key ? h(Badge, { tone: 'ok' }, '当前') : (key === recommended ? h(Badge, { tone: 'info' }, '推荐') : null)),
          h('span', { className: 'fg-opt-tradeoff' }, presets[key]?.summary ?? '')))),
        view.doc?.reason ? h('div', { className: 'fg-tiny' }, '推荐理由：' + view.doc.reason) : null)
    }

    function DocCard({ sessionId, view, waiting }) {
      const [busy, setBusy] = useState(false)
      const doc = view.doc || {}
      return h(Card, { title: ['需求文档', h(Badge, { key: 'b', tone: 'info' }, '自包含 HTML')], grow: true },
        h('div', { className: 'fg-doc' },
          h('iframe', { title: '需求文档预览', sandbox: '', srcDoc: doc.html || '' })),
        h('div', { className: 'fg-hr' }),
        h(PresetPicker, { sessionId, view, busy, setBusy }),
        h('div', { className: 'fg-hr' }),
        h(DocGate, { sessionId, view, waiting, busy, setBusy }),
        h('div', { className: 'fg-tiny' },
          '「批准并冻结 scope」= S1 出口门禁通过；「跳过评审，直接开发」仍会冻结 scope，但记为用户跳过。'))
    }

    // -----------------------------------------------------------------------
    // S2：开发
    // -----------------------------------------------------------------------

    function ScopeBlock({ scope }) {
      const data = scope?.data || {}
      const files = Array.isArray(data.in_scope?.files_expected_to_change) ? data.in_scope.files_expected_to_change : []
      const capabilities = Array.isArray(data.in_scope?.capabilities) ? data.in_scope.capabilities : []
      const outOfScope = Array.isArray(data.out_of_scope_explicitly) ? data.out_of_scope_explicitly : []
      const criteria = Array.isArray(data.acceptance_criteria) ? data.acceptance_criteria : []
      return h(Card, { title: ['冻结 scope', scope?.frozen ? h(Badge, { key: 'f', tone: 'ok' }, '已冻结') : h(Badge, { key: 'f', tone: 'warn' }, '未冻结')] },
        scope?.withoutDocApproval ? h('div', { className: 'fg-tiny' }, '注意：scope 是在需求文档未获批准的情况下冻结的。') : null,
        h('div', { className: 'fg-sec-title' }, '允许改动的文件'),
        files.length
          ? h('div', { className: 'fg-list' }, files.map((file, index) => h('div', { key: 'f-' + index, className: 'fg-item' },
              h('span', { className: 'fg-mono' }, file))))
          : h(Empty, null, '未声明文件白名单——任何写操作都会被阻断。'),
        capabilities.length ? h('div', { className: 'fg-sec-title' }, '要交付的能力') : null,
        capabilities.length ? h('div', { className: 'fg-list' }, capabilities.map((item, index) => h('div', { key: 'c-' + index, className: 'fg-item' }, item))) : null,
        outOfScope.length ? h('div', { className: 'fg-sec-title' }, '明确不做') : null,
        outOfScope.length ? h('div', { className: 'fg-list' }, outOfScope.map((item, index) => h('div', { key: 'o-' + index, className: 'fg-item' }, item))) : null,
        criteria.length ? h('div', { className: 'fg-sec-title' }, '验收标准') : null,
        criteria.length ? h('div', { className: 'fg-list' }, criteria.map((item, index) => h('div', { key: 'a-' + index, className: 'fg-item' },
          h('div', null,
            h('div', { className: 'fg-mono' }, item?.id ?? 'AC-' + (index + 1)),
            h('div', null, '当 ' + (item?.when ?? '') ),
            h('div', null, '则 ' + (item?.then ?? '')))))) : null)
    }

    function DevCard({ view }) {
      const changes = view.devChanges
      const files = Array.isArray(changes?.files) ? changes.files : []
      return h(Card, { title: ['开发变更', h(Badge, { key: 's', tone: 'info' }, 'S2 开发')] },
        changes
          ? h('div', null,
              h('div', { className: 'fg-row' },
                h(Badge, { tone: 'info' }, files.length + ' 个文件'),
                h(Badge, { tone: 'ok' }, '+' + (changes.added ?? 0)),
                h(Badge, { tone: 'bad' }, '-' + (changes.removed ?? 0))),
              files.length
                ? h('div', { className: 'fg-list', style: { marginTop: '8px' } }, files.map((file, index) =>
                    h('div', { key: 'd-' + index, className: 'fg-item' }, h('span', { className: 'fg-mono' }, file))))
                : h('div', { className: 'fg-tiny' }, 'git 未报告任何改动。'))
          : h(Empty, null, '变更摘要会在点击「完成开发」时由宿主自动采集（文件列表 + 行数），不需要手贴 diff。'),
        h('div', { className: 'fg-tiny' }, '开发期间，任何对 scope 白名单之外文件的写操作都会被宿主端拦截。'))
    }

    // -----------------------------------------------------------------------
    // S3：评审
    // -----------------------------------------------------------------------

    function ReviewCard({ view }) {
      const review = view.review
      if (!review) {
        return h(Card, { title: ['评审报告', h(Badge, { key: 'r', tone: 'info' }, 'S3 评审')] },
          h(Empty, null, '等待只读评审子代理提交结构化报告（每个角度一节，每条发现带 file:line 与 severity）。'))
      }
      const angles = Array.isArray(review.angles) ? review.angles : []
      return h(Card, { title: ['评审报告', h(Badge, { key: 'r', tone: 'info' }, 'S3 评审'),
        review.blocking > 0 ? h(Badge, { key: 'b', tone: 'bad' }, review.blocking + ' 个阻塞项') : h(Badge, { key: 'b', tone: 'ok' }, '无阻塞项')] },
        angles.map((angle, index) => h('div', { key: 'ang-' + index, className: 'fg-list' },
          h('div', { className: 'fg-row' },
            h('strong', null, angle?.name ?? '角度 ' + (index + 1)),
            h(Badge, { tone: VERDICT_TONE[angle?.verdict] ?? '' }, VERDICT_TEXT[angle?.verdict] ?? String(angle?.verdict ?? '')),
            angle?.suggestUpgrade ? h(Badge, { tone: 'warn' }, '建议升档') : null),
          (Array.isArray(angle?.findings) ? angle.findings : []).length
            ? h('div', { className: 'fg-list' }, angle.findings.map((finding, fIndex) => h('div', { key: 'fi-' + fIndex, className: 'fg-item' },
                h(Badge, { tone: SEV_TONE[finding?.severity] ?? '' }, finding?.severity ?? 'MINOR'),
                h('span', { className: 'fg-mono' }, (finding?.file ?? '') + (finding?.line ? ':' + finding.line : '')),
                h('span', null, finding?.summary ?? ''))))
            : h('div', { className: 'fg-tiny' }, '该角度没有发现。'),
          h('div', { className: 'fg-hr' }))))
    }

    // -----------------------------------------------------------------------
    // S4：测试
    // -----------------------------------------------------------------------

    function TestCard({ view }) {
      const test = view.test
      if (!test) {
        return h(Card, { title: ['测试报告', h(Badge, { key: 't', tone: 'info' }, 'S4 测试')] },
          h(Empty, null, '等待测试执行单元按方向提交结果（每个方向 × 每个要点：通过 / 失败 / 未覆盖）。'))
      }
      const directions = Array.isArray(test.directions) ? test.directions : []
      return h(Card, { title: ['测试报告', h(Badge, { key: 't', tone: 'info' }, 'S4 测试')] },
        directions.map((direction, index) => {
          const points = Array.isArray(direction?.points) ? direction.points : []
          const failed = points.filter((point) => point?.result === 'fail').length
          return h('div', { key: 'dir-' + index, className: 'fg-list' },
            h('div', { className: 'fg-row' },
              h('strong', null, direction?.name ?? '方向 ' + (index + 1)),
              failed > 0 ? h(Badge, { tone: 'bad' }, failed + ' 项失败') : h(Badge, { tone: 'ok' }, '全部通过')),
            h('div', { className: 'fg-list' }, points.map((point, pIndex) => h('div', { key: 'p-' + pIndex, className: 'fg-item' },
              h(Badge, { tone: RESULT_TONE[point?.result] ?? '' }, RESULT_TEXT[point?.result] ?? String(point?.result ?? '')),
              h('span', null, point?.point ?? ''),
              point?.detail ? h('span', { className: 'fg-tiny' }, point.detail) : null))),
            h('div', { className: 'fg-hr' }))
        }))
    }

    // -----------------------------------------------------------------------
    // 左侧阶段导航（不可点击：阶段之间没有自由导航）
    // -----------------------------------------------------------------------

    function StageNav({ view }) {
      const stages = Array.isArray(view.stages) ? view.stages : []
      return h('div', { className: 'fg-nav' }, stages.map((stage, index) => {
        const status = stage?.status ?? 'pending'
        const tone = STAGE_TONE[status] ?? ''
        return h('div', { key: 'nav-' + index, className: 'fg-stage' + (status === 'active' ? ' on' : ''), title: '阶段之间没有自由导航，只能通过门禁推进或回退' },
          h('div', { className: 'fg-stage-top' },
            h('span', { className: 'fg-stage-idx' }, stage?.id ?? 'S' + (index + 1)),
            h('span', { className: 'fg-stage-name' }, stage?.label ?? ''),
            status === 'passed' ? h('span', { className: 'fg-badge ok', style: { marginLeft: 'auto' } }, '✓') : null),
          h('div', { className: 'fg-stage-out' }, stage?.output ?? ''),
          status === 'active' || status === 'pending' ? null : h('div', null, h(Badge, { tone }, STAGE_TEXT[status] ?? status)))
      }))
    }

    // -----------------------------------------------------------------------
    // 右侧：阶段设置
    // -----------------------------------------------------------------------

    function CheckRow({ checked, name, points, onChange }) {
      return h('label', { className: 'fg-check' },
        h('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) }),
        h('span', null,
          h('div', null, name),
          Array.isArray(points) && points.length
            ? h('div', { className: 'fg-tiny' }, points.join(' · '))
            : null))
    }

    function SettingsPanel({ sessionId, view }) {
      const [busy, setBusy] = useState(false)
      const [adding, setAdding] = useState(null)
      const [name, setName] = useState('')
      const [points, setPoints] = useState('')
      const [needsWrite, setNeedsWrite] = useState(false)

      const angleIds = new Set((view.angles || []).map((angle) => angle.id))
      const directionIds = new Set((view.directions || []).map((direction) => direction.id))
      const angleCatalog = Array.isArray(view.angleCatalog) ? view.angleCatalog : []
      const directionCatalog = Array.isArray(view.directionCatalog) ? view.directionCatalog : []

      const toggle = async (action, id, enabled) => {
        setBusy(true)
        await act(sessionId, action, { id, enabled })
        setBusy(false)
      }

      const submit = async () => {
        if (!name.trim()) return
        setBusy(true)
        const list = points.split('\n').map((line) => line.trim()).filter(Boolean)
        const payload = { name: name.trim(), points: list }
        if (adding === 'direction' && needsWrite) payload.needsWrite = true
        await act(sessionId, adding === 'angle' ? 'addAngle' : 'addDirection', payload)
        setBusy(false)
        setName('')
        setPoints('')
        setNeedsWrite(false)
        setAdding(null)
      }

      const canUpgrade = view.preset === 'fast' && !view.finished

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', { className: 'fg-sec-title' }, '阶段设置'),
        h('div', { className: 'fg-row' },
          h(Badge, { tone: 'info' }, view.presetInfo?.label ?? view.preset ?? ''),
          canUpgrade ? h(Btn, {
            disabled: busy,
            onClick: async () => { setBusy(true); await act(sessionId, 'upgrade', { preset: 'strict' }); setBusy(false) },
          }, '升档到大需求严格执行') : null),
        canUpgrade && view.stage === 'S3'
          ? h('div', { className: 'fg-tiny' }, '若评审已发现 scope 内的问题，升档会让流程回到 S2 按严格参数重做（scope 不会自动扩充）。')
          : null,
        h('div', { className: 'fg-hr' }),
        h('div', { className: 'fg-sec-title' }, '评审角度'),
        h('div', null, angleCatalog.map((angle) => h(CheckRow, {
          key: 'angle-' + angle.id,
          checked: angleIds.has(angle.id),
          name: angle.name,
          points: angle.points,
          onChange: (enabled) => { void toggle('toggleAngle', angle.id, enabled) },
        }))),
        adding === 'angle'
          ? h('div', { className: 'fg-list' },
              h('input', { className: 'fg-input', placeholder: '角度名称', value: name, onChange: (event) => setName(event.target.value) }),
              h('textarea', { className: 'fg-textarea', placeholder: '检查要点，每行一条', value: points, onChange: (event) => setPoints(event.target.value) }),
              h('div', { className: 'fg-row' },
                h(Btn, { tone: 'primary', disabled: busy || !name.trim(), onClick: () => { void submit() } }, '追加'),
                h(Btn, { disabled: busy, onClick: () => { setAdding(null); setName(''); setPoints('') } }, '取消')))
          : h('div', null, h(Btn, { disabled: busy, onClick: () => setAdding('angle') }, '追加自定义角度')),
        h('div', { className: 'fg-hr' }),
        h('div', { className: 'fg-sec-title' }, '测试方向'),
        h('div', null, directionCatalog.map((direction) => h('div', { key: 'dir-' + direction.id },
          h(CheckRow, {
            checked: directionIds.has(direction.id),
            name: direction.name,
            points: direction.points,
            onChange: (enabled) => { void toggle('toggleDirection', direction.id, enabled) },
          }),
          // D2：v1 唯一的写权限例外，必须由用户在这里显式勾选。
          direction.needsWrite
            ? h('label', { className: 'fg-check fg-grant' },
                h('input', {
                  type: 'checkbox',
                  checked: direction.writeGranted === true,
                  disabled: busy || view.stage !== 'S4',
                  onChange: (event) => { void toggle('toggleWriteGrant', direction.id, event.target.checked) },
                }),
                h('span', null,
                  h('div', null, '授权执行变更性命令'),
                  h('div', { className: 'fg-tiny' },
                    view.stage === 'S4'
                      ? '该方向声明需要写权限。授权只覆盖 shell 命令，代码写工具仍然被拒绝。'
                      : '写权限例外只在 S4 测试阶段开放。')))
            : null))),
        adding === 'direction'
          ? h('div', { className: 'fg-list' },
              h('input', { className: 'fg-input', placeholder: '方向名称', value: name, onChange: (event) => setName(event.target.value) }),
              h('textarea', { className: 'fg-textarea', placeholder: '验证要点，每行一条', value: points, onChange: (event) => setPoints(event.target.value) }),
              h('label', { className: 'fg-check' },
                h('input', { type: 'checkbox', checked: needsWrite, onChange: (event) => setNeedsWrite(event.target.checked) }),
                h('span', null,
                  h('div', null, '这个方向需要写权限'),
                  h('div', { className: 'fg-tiny' }, '勾选后该方向会出现在 S4 的授权清单里，仍需用户在 S4 再显式勾选一次才生效。'))),
              h('div', { className: 'fg-row' },
                h(Btn, { tone: 'primary', disabled: busy || !name.trim(), onClick: () => { void submit() } }, '追加'),
                h(Btn, { disabled: busy, onClick: () => { setAdding(null); setName(''); setPoints(''); setNeedsWrite(false) } }, '取消')))
          : h('div', null, h(Btn, { disabled: busy, onClick: () => setAdding('direction') }, '追加自定义方向')),
        h('div', { className: 'fg-tiny' }, '追加只会在内置集合上加条目，不会替换内置角度或方向。'))
    }

    // -----------------------------------------------------------------------
    // 右侧：门禁
    // -----------------------------------------------------------------------

    function GatePanel({ sessionId, view }) {
      const [busy, setBusy] = useState(false)
      const waiting = Boolean(view.waiting)
      const gate = async (decision, to) => {
        setBusy(true)
        await act(sessionId, 'gate', { decision, to })
        setBusy(false)
      }
      const head = h('div', { className: 'fg-sec-title' }, '出口门禁')

      if (view.finished) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          head,
          h('div', { className: 'fg-row' }, h(Badge, { tone: 'ok' }, '流程已结束')),
          h('div', { className: 'fg-tiny' }, '四个阶段的产物、门禁操作与跳过标记已写入 flows.jsonl。'))
      }

      const note = waiting
        ? null
        : h('div', { className: 'fg-tiny' }, '门禁未就绪：Agent 正在推进，等它请求门禁后按钮才可用。')

      if (view.stage === 'S1') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          head, h(DocGate, { sessionId, view, waiting, busy, setBusy }), note)
      }

      if (view.stage === 'S2') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          head,
          h(Btn, { tone: 'primary', disabled: busy || !waiting, onClick: () => { void gate('pass') } }, '完成开发'),
          h(Btn, { disabled: busy || !waiting, onClick: () => { void gate('skip') } }, '跳过门禁，直接评审'),
          h(Btn, { tone: 'danger', disabled: busy || !waiting, onClick: () => { void gate('back', 'S1') } }, '回到需求分析调整 scope'),
          note)
      }

      if (view.stage === 'S3') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          head,
          h(Btn, { tone: 'primary', disabled: busy || !waiting, onClick: () => { void gate('pass') } }, '通过评审，进入测试'),
          h(Btn, { disabled: busy || !waiting, onClick: () => { void gate('back', 'S2') } }, '退回开发修复'),
          h(Btn, { disabled: busy || !waiting, onClick: () => { void gate('skip') } }, '跳过评审，直接测试'),
          note)
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        head,
        h(Btn, { tone: 'primary', disabled: busy || !waiting, onClick: () => { void gate('pass') } }, '验收通过，结束流程'),
        h(Btn, { disabled: busy || !waiting, onClick: () => { void gate('back', 'S2') } }, '退回开发修复'),
        h(Btn, { disabled: busy || !waiting, onClick: () => { void gate('skip') } }, '跳过测试门禁'),
        note)
    }

    // -----------------------------------------------------------------------
    // 工作台主视图
    // -----------------------------------------------------------------------

    function stageIndex(stages, id) {
      const found = (stages || []).findIndex((stage) => stage?.id === id)
      return found < 0 ? 0 : found
    }

    function WorkbenchView(props) {
      const sessionId = props?.sessionId
      const entry = useEntry(sessionId)
      const [collapsed, setCollapsed] = useState(false)
      const [refreshing, setRefreshing] = useState(false)

      if (!sessionId) return null
      const view = entry.view

      if (!view) {
        return h('div', { className: 'fg-root' },
          h('div', { className: 'fg-head' }, h('span', { className: 'fg-title' }, '流程工作台')),
          h('div', { className: 'fg-main' },
            h('div', { className: 'fg-err' }, entry.error || '正在连接宿主端…')))
      }

      if (!view.active) {
        return h('div', { className: 'fg-root' },
          h('div', { className: 'fg-head' },
            h('span', { className: 'fg-title' }, '流程工作台'),
            h('span', { className: 'fg-spacer' }),
            h('span', { className: 'fg-sub' }, '当前会话还没有流程')),
          h('div', { className: 'fg-main' },
            h(Card, { title: '如何开始' },
              h('div', { className: 'fg-muted' }, '在对话里让 Agent 调用 flowgate_start 启动四阶段流程。流程启动后，这里会出现需求分析的追问卡片、需求文档预览，以及右侧的设置与门禁面板。'),
              h('div', { className: 'fg-tiny' }, '阶段顺序是硬性的：S1 需求分析 → S2 开发 → S3 评审 → S4 测试，只能通过门禁推进或回退。'))))
      }

      const stages = Array.isArray(view.stages) ? view.stages : []
      const currentIndex = stageIndex(stages, view.stage)

      const main = []
      if (view.stage === 'S1') {
        if (view.grill?.pending) {
          main.push(h(GrillCard, { key: 'grill', sessionId, pending: view.grill.pending }))
          if (view.grill.answeredCount) {
            main.push(h('div', { key: 'grill-count', className: 'fg-tiny' }, '已回答 ' + view.grill.answeredCount + ' 个决策问题'))
          }
        } else if (view.doc?.html) main.push(h(DocCard, { key: 'doc', sessionId, view, waiting: Boolean(view.waiting) }))
        else main.push(h(Card, { key: 'wait', title: ['需求分析', h(Badge, { key: 'w', tone: 'info' }, 'S1')] },
          h(Empty, null, '等待 Agent 提出第一个决策问题。追问会以卡片形式出现在这里，点选项即可回答，不需要键盘输入。'),
          view.grill?.answeredCount ? h('div', { className: 'fg-tiny' }, '已回答 ' + view.grill.answeredCount + ' 个决策问题') : null))
      } else if (view.stage === 'S2') {
        main.push(h(DevCard, { key: 'dev', view }))
        main.push(h(ScopeBlock, { key: 'scope', scope: view.scope }))
      } else if (view.stage === 'S3') {
        main.push(h(ReviewCard, { key: 'review', view }))
        main.push(h(ScopeBlock, { key: 'scope', scope: view.scope }))
      } else if (view.stage === 'S4') {
        main.push(h(TestCard, { key: 'test', view }))
      }

      return h('div', { className: 'fg-root' },
        h('div', { className: 'fg-head' },
          h('span', { className: 'fg-title' }, '流程工作台'),
          h('span', { className: 'fg-sub' }, view.title || '未命名需求'),
          h('span', { className: 'fg-spacer' }),
          h(Badge, { tone: 'info' }, 'S' + (currentIndex + 1) + '/4 · ' + (stages[currentIndex]?.label ?? '')),
          view.skippedCount > 0 ? h(Badge, { tone: 'warn' }, '本流程有 ' + view.skippedCount + ' 个阶段被跳过') : null,
          h(Btn, {
            disabled: refreshing,
            title: '立即从宿主端拉取最新状态',
            onClick: async () => { setRefreshing(true); await pull(sessionId); setRefreshing(false) },
          }, '刷新'),
          h(Btn, { onClick: () => setCollapsed((value) => !value) }, collapsed ? '显示设置' : '收起设置')),
        entry.error ? h('div', { className: 'fg-main', style: { paddingBottom: 0, flex: 'none' } }, h('div', { className: 'fg-err' }, entry.error)) : null,
        h('div', { className: 'fg-body' + (collapsed ? ' collapsed' : '') },
          h(StageNav, { view }),
          h('div', { className: 'fg-main' }, main),
          collapsed ? null : h('div', { className: 'fg-side' },
            h(SettingsPanel, { sessionId, view }),
            h('div', { className: 'fg-hr' }),
            h(GatePanel, { sessionId, view }))))
    }

    // -----------------------------------------------------------------------
    // 输入区上方的常驻条
    // -----------------------------------------------------------------------

    function FlowgateDock(props) {
      const sessionId = props?.sessionId
      const entry = useEntry(sessionId)
      if (!sessionId) return null
      const view = entry.view
      if (!view || !view.active) return null
      const stages = Array.isArray(view.stages) ? view.stages : []
      const index = stageIndex(stages, view.stage)
      return h('div', { className: 'fg-dock' },
        h('span', { className: 'fg-badge info' }, 'S' + (index + 1) + ' ' + (stages[index]?.label ?? '')),
        view.finished
          ? h('span', null, '流程已结束')
          : h('span', null, view.waiting ? '门禁等你点击确认' : '等待 Agent 推进'),
        view.skippedCount > 0 ? h('span', { className: 'fg-badge warn' }, '已跳过 ' + view.skippedCount + ' 个阶段') : null,
        h('span', { className: 'fg-spacer' }),
        h('span', { className: 'fg-tiny' }, '在「流程工作台」视图里操作'))
    }

    // -----------------------------------------------------------------------
    // 插件入口
    // -----------------------------------------------------------------------

    function apply(ctx) {
      ensureStyles()
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'flowgate',
        order: 8,
        label: () => '流程工作台',
      }, WorkbenchView))
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'flowgate-dock',
        order: 5,
      }, FlowgateDock))
    }

    exports.name = 'dsh-flowgate'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})


