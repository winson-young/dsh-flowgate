/**
 * Verify plugin components with file: fixtures; this does not verify deployed DSH.
 * Node 22+ and existing React dev dependencies are required. Connect Chrome CDP
 * with file access enabled, then run: node docs/capture-ui.mjs [--verify-only]
 * FLOWGATE_CDP overrides http://127.0.0.1:9229. Workspace and rules images are written.
 * A dedicated tab is created and closed without navigating existing tabs.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const cdpAddress = process.env.FLOWGATE_CDP || 'http://127.0.0.1:9229'
const endpoint = cdpAddress.endsWith('/') ? cdpAddress.slice(0, -1) : cdpAddress
const verifyOnly = process.argv.includes('--verify-only')
const json = async (path, options) => {
  const response = await fetch(endpoint + path, { ...options, signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw Error('CDP HTTP ' + response.status + ': ' + path)
  return response.json()
}
const originalPages = (await json('/json/list')).filter(page => page.type === 'page')
const target = await json('/json/new?about:blank', { method: 'PUT' })
let ws = null, nextId = 0, currentCase = null
const pending = new Map(), events = new Map(), errors = [], cases = [], layoutIssues = [], checks = [], screenshots = []
const onMessage = event => {
  const msg = JSON.parse(event.data)
  if (msg.id) {
    const item = pending.get(msg.id)
    if (!item) return
    pending.delete(msg.id); clearTimeout(item.timer)
    msg.error ? item.reject(Error(JSON.stringify(msg.error))) : item.resolve(msg.result)
  } else {
    events.get(msg.method)?.()
    if (msg.method === 'Runtime.exceptionThrown') errors.push({ case: currentCase, error: msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text })
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId
  const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timed out: ' + method)) }, 15000)
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
const ready = condition => evaluate('new Promise((resolve,reject)=>{let n=0;function check(){if(' + condition + ')requestAnimationFrame(()=>requestAnimationFrame(resolve));else if(n++<240)requestAnimationFrame(check);else reject(Error("Preview not ready: "+' + JSON.stringify(condition) + '))}check()})')
const button = (label, scope = 'document') => '[...' + scope + '.querySelectorAll("button")].find(b=>b.textContent.trim()===' + JSON.stringify(label) + ')'
const click = async (label, scope) => evaluate('(()=>{const b=' + button(label, scope) + ';if(!b||b.disabled)throw Error("Button unavailable: "+' + JSON.stringify(label) + ');b.click()})()')
const focus = async selector => evaluate('(()=>{const el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)throw Error("Focus target missing");el.focus();if(document.activeElement!==el)throw Error("Focus failed")})()')
const key = async (name, modifiers = 0) => {
  const code = { Enter: 13, Tab: 9, Escape: 27, ' ': 32 }[name]
  const params = { key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers }
  const text = !modifiers && (name === 'Enter' || name === ' ') ? (name === 'Enter' ? String.fromCharCode(13) : ' ') : undefined
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(text ? { text, unmodifiedText: text } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}
const check = (name, pass, detail) => {
  checks.push({ case: currentCase, name, pass, ...(detail === undefined ? {} : { detail }) })
  if (!pass) layoutIssues.push({ ...currentCase, issue: name, detail })
}
const navigate = async (stage, state, theme) => {
  const url = new URL('./ui-preview.html', import.meta.url)
  url.searchParams.set('stage', stage); url.searchParams.set('theme', theme)
  if (state) url.searchParams.set('state', state)
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { events.delete('Page.loadEventFired'); reject(Error('Page load timed out')) }, 10000)
    events.set('Page.loadEventFired', () => { clearTimeout(timer); events.delete('Page.loadEventFired'); resolve() })
  })
  await send('Page.navigate', { url: url.href }); await loaded
  await ready('document.querySelector(".fg-root") && !document.body.textContent.includes("正在连接宿主端")')
}
const inspectLayout = async phase => {
  const info = await evaluate('(()=>({overflow:[...document.querySelectorAll(".fg-root,.fg-content,.fg-head,.fg-card,.fg-opt,.fg-hub-ws,.fg-stage-list,.fg-gate,.fg-workspace-overview,.fg-workspace-primary,.fg-workspace-card,.fg-pagination,.fg-modal,.fg-workspace-rule-row,.fg-workspace-rule-body,.fg-workspace-rule-footer,.fg-requirement")].filter(el=>el.getClientRects().length&&el.scrollWidth>el.clientWidth+2).map(el=>({class:el.className,width:el.clientWidth,scroll:el.scrollWidth})),background:getComputedStyle(document.querySelector(".fg-root")).backgroundColor}))()')
  cases.push({ ...currentCase, phase, ...info })
}
const inspectWorkspace = async state => {
  const info = await evaluate('(()=>{const primary=document.querySelector(".fg-workspace-primary"),overview=document.querySelector(".fg-workspace-overview"),history=document.querySelector(".fg-flow-history"),rules=document.querySelector(".fg-workspace-tools"),form=primary?.querySelector(".fg-start-section"),current=primary?.querySelector(".fg-current-flow");return {formTag:form?.tagName,current:!!current,forms:document.querySelectorAll(".fg-start-section").length,historyClosed:!history?.open,historyAfterOverview:!!(overview.compareDocumentPosition(history)&Node.DOCUMENT_POSITION_FOLLOWING),rulesAside:rules?.tagName==="ASIDE",primaryBeforeRules:!!(primary.compareDocumentPosition(rules)&Node.DOCUMENT_POSITION_FOLLOWING),primaryVisible:(form||current)?.getBoundingClientRect().top<innerHeight,firstPageHasCurrent:[...document.querySelectorAll(".fg-flow-row")].some(row=>row.textContent.includes("会话过期检测与重新认证提示"))}})()')
  check('primary entry matches workspace state', state === 'active' ? info.current && info.forms === 0 : info.formTag === 'SECTION' && info.forms === 1, info)
  check('history starts collapsed after overview; rules follow primary in aside', info.historyClosed && info.historyAfterOverview && info.rulesAside && info.primaryBeforeRules && info.primaryVisible, info)
  if (state === 'active') check('current flow is available independently of first history page', !info.firstPageHasCurrent && info.current)
}
const historyAndKeyboard = async state => {
  await focus('.fg-flow-history > summary'); await key('Enter')
  await ready('document.querySelector(".fg-flow-history").open')
  check('Enter expands history', true)
  await inspectLayout('history expanded')
  for (const [label, page, rows] of [['下一页', 2, 10], ['下一页', 3, 3], ['上一页', 2, 10], ['上一页', 1, 10]]) {
    await evaluate('(' + button(label, 'document.querySelector(".fg-pagination")') + ').focus()')
    await key('Enter')
    await ready('document.querySelector(".fg-pagination").textContent.includes("第 ' + page + ' / 3 页") && document.querySelectorAll(".fg-flow-row").length===' + rows)
    check('keyboard history page ' + page + ' has ' + rows + ' rows', true)
    if (state === 'active') check('continue entry survives history page ' + page, await evaluate('!!document.querySelector(".fg-current-flow") && !document.querySelector(".fg-start-section")'))
  }
  await focus('.fg-flow-history > summary'); await key(' ')
  await ready('!document.querySelector(".fg-flow-history").open')
  check('Space collapses history', true)
}
const openAndInspectDetail = async state => {
  if (state === 'active') {
    await focus('.fg-current-flow button'); await key('Enter')
  } else {
    await focus('.fg-flow-history > summary'); await key('Enter')
    await focus('.fg-flow-row'); await key('Enter')
  }
  await ready('document.querySelector(".fg-hub-flow .fg-nav")')
  const info = await evaluate('(()=>{const flow=document.querySelector(".fg-hub-flow"),detail=flow.closest("section"),history=document.querySelector(".fg-flow-history");return {historyAfterDetail:!!(detail.compareDocumentPosition(history)&Node.DOCUMENT_POSITION_FOLLOWING),detailForms:flow.querySelectorAll(".fg-start-section").length,allForms:document.querySelectorAll(".fg-start-section").length,text:flow.textContent}})()')
  check('detail precedes history and has no restart form', info.historyAfterDetail && info.detailForms === 0 && info.allForms === (state === 'active' ? 0 : 1), { historyAfterDetail: info.historyAfterDetail, detailForms: info.detailForms, allForms: info.allForms })
  if (state === 'finished' || state === 'cancelled') check('ended history detail shows final status', info.text.includes(state === 'cancelled' ? '已放弃' : '已完成'))
  await inspectLayout('detail opened')
  await click('收起')
  await ready('!document.querySelector(".fg-hub-flow")')
}
const fill = async (selector, text) => {
  await focus(selector)
  await evaluate('document.querySelector(' + JSON.stringify(selector) + ').select()')
  await send('Input.insertText', { text })
}
const saveScreenshot = async name => {
  if (verifyOnly || currentCase.width !== 1280 || currentCase.theme !== 'light') return
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width: currentCase.width, height: 1000, scale: 1 } })
  const dest = new URL('./images/' + name + '.png', import.meta.url)
  await writeFile(dest, Buffer.from(shot.data, 'base64')); screenshots.push(fileURLToPath(dest))
}
const startWithKeyboard = async theme => {
  const raw = '.fg-start-section textarea[aria-label="需求原文"]'
  const form = '.fg-start-section'
  const brief = '新需求：超过 30 分钟返回 401，保留 C:/Projects/atlas-console。'
  await fill(raw, brief)
  // 只填需求原文：输入期间不生成标题、预览或重新生成按钮，也不发整理请求。
  check('start form asks only for the requirement and prepares nothing while typing', await evaluate('(function(){const form=document.querySelector(' + JSON.stringify(form) + ');return form.textContent.includes("需求描述") && form.querySelectorAll("textarea").length===1 && form.querySelectorAll("input").length===0 && !form.textContent.includes("标题与整理稿") && !form.textContent.includes("重新生成") && window.fixtureRequests.every(r=>!r.route.includes("/hub/prepare"))})()'))
  await inspectLayout('requirement filled')
  await evaluate('document.activeElement?.blur()')
  await saveScreenshot('workspace')
  // 慢响应：点击后一次性请求整理，请求带的是原始原文，结果直接进启动请求。
  await evaluate('window.fixturePrepare.delay=1500')
  if (theme === 'light') {
    await focus(raw); await key('Enter', 2)
  } else {
    await evaluate('(' + button('开始需求分析') + ').focus()'); await key('Enter')
  }
  await ready('window.fixtureActions.some(a=>a.action==="start") && document.querySelector(".fg-current-flow")')
  const actions = await evaluate('window.fixtureActions.filter(a=>a.action==="start")')
  const prepared = await evaluate('window.fixtureRequests.filter(r=>r.route.includes("/hub/prepare"))')
  check('clicking start prepares once with the raw requirement', prepared.length === 1 && prepared[0].body.brief === brief, prepared.length)
  check(theme === 'light' ? 'Ctrl+Enter starts once with original and prepared summary' : 'Enter starts once with original and prepared summary', actions.length === 1 && actions[0].payload.brief === brief && actions[0].payload.title.startsWith('新需求') && actions[0].payload.summary.startsWith('目标与要求'))
  check('start form shows no preparation status copy', await evaluate('!document.body.textContent.includes("自动生成暂不可用") && !document.body.textContent.includes("本地整理") && !document.body.textContent.includes("重新生成标题与整理稿")'))
  check('current flow shows prepared content and expandable original', await evaluate('document.querySelector(".fg-current-flow .fg-requirement-text")?.textContent.startsWith("目标与要求") && document.querySelector(".fg-current-flow .fg-requirement-original")?.textContent.includes("C:/Projects/atlas-console")'))
  await evaluate('window.fixturePrepare.delay=80')
}
const inspectRules = async () => {
  const modal = 'document.querySelector("[role=dialog]")'
  const stageLabels = ['S1 · 需求分析', 'S2 · 开发规则', 'S3 · 评审角度', 'S4 · 测试方向']
  const before = await evaluate('JSON.stringify(window.fixtureState().workspaceStages)')
  await click('编辑规则'); await ready('document.querySelector("[role=dialog]")')
  check('all four stages are editable without a session', await evaluate(modal + '.querySelectorAll("nav[aria-label=工作区规则分组] button").length===4'))
  const initialChecked = await evaluate(modal + '.querySelector(".fg-workspace-rule-row input").checked')
  await evaluate(modal + '.querySelector(".fg-workspace-rule-row input").click()')
  await key('Escape'); await ready('!document.querySelector("[role=dialog]")')
  check('Escape discards edits without writing', await evaluate('JSON.stringify(window.fixtureState().workspaceStages)===' + JSON.stringify(before) + ' && !window.fixtureRequests.some(r=>r.route.includes("/hub/rules")&&r.body.stages)'))
  check('Escape returns focus to edit trigger', await evaluate('document.activeElement.textContent.trim()==="编辑规则"'))
  await click('编辑规则'); await ready('document.querySelector("[role=dialog]")')
  await evaluate(modal + '.querySelector("button").focus()'); await key('Tab', 8)
  check('Shift+Tab stays within dialog', await evaluate(modal + '.contains(document.activeElement)'))
  await key('Tab')
  check('Tab wraps to dialog first button', await evaluate('document.activeElement===' + modal + '.querySelector("button")'))
  check('cancelled stage draft was reset', await evaluate(modal + '.querySelector(".fg-workspace-rule-row input").checked===' + initialChecked))
  await evaluate(modal + '.querySelector(".fg-workspace-rule-row input").click()')
  await click(stageLabels[1], modal)
  check('default, edited builtin and custom origins are distinct', await evaluate('["内置","已自定义内置","新增自定义"].every(label=>[...' + modal + '.querySelectorAll(".fg-badge")].some(b=>b.textContent===label))'))
  const original = modal + '.querySelector("button[aria-label^=恢复内置规则]").closest(".fg-workspace-rule-item").querySelector("details")'
  await evaluate('(' + original + ').querySelector("summary").focus()'); await key('Enter')
  check('builtin original expands for comparison', await evaluate('(' + original + ').open'))
  await inspectLayout('builtin original expanded')
  await saveScreenshot('rules')
  await click('恢复内置', modal)
  check('single restore removes only the builtin edit', await evaluate('!' + modal + '.textContent.includes("已自定义内置") && ' + modal + '.textContent.includes("新增自定义")'))
  await click(stageLabels[2], modal)
  await evaluate(modal + '.querySelector(".fg-workspace-rule-row input").click()')
  await click(stageLabels[3], modal)
  await click('添加规则', modal)
  await fill('[role=dialog] input[placeholder="规则名称"]', '检查会话恢复')
  await fill('[role=dialog] textarea[placeholder="检查要点，每行一条"]', '保留 30 分钟与 401\n写入仅在单独授权后执行')
  await evaluate(modal + '.querySelector(".fg-modal-form input[type=checkbox]").click()')
  await click('加入列表', modal)
  await inspectLayout('custom test direction added')
  await click(stageLabels[0], modal)
  check('stage switching keeps unsaved selections', await evaluate(modal + '.querySelector(".fg-workspace-rule-row input").checked!==' + initialChecked))
  await click(stageLabels[1], modal)
  await click('恢复本阶段内置默认', modal)
  await evaluate('window.fixtureRuleSaveDelay=1500')
  await click('保存规则', modal)
  await ready(button('保存中…', modal) + '?.disabled')
  await evaluate('const summaries=' + modal + '.querySelectorAll("details > summary");summaries[summaries.length-1].focus()')
  await key('Tab')
  check('Tab wraps between builtin originals while save is pending', await evaluate('document.activeElement===' + modal + '.querySelector("details > summary")'))
  await key('Tab', 8)
  check('Shift+Tab stays within pending save dialog', await evaluate('(()=>{const summaries=' + modal + '.querySelectorAll("details > summary");return document.activeElement===summaries[summaries.length-1]})()'))
  await ready('!document.querySelector("[role=dialog]")')
  await evaluate('window.fixtureRuleSaveDelay=0')
  const writes = await evaluate('window.fixtureRequests.filter(r=>r.route.includes("/hub/rules")&&r.body.stages).map(r=>r.body.stages)')
  const stages = writes[0]
  check('one save commits all stages and preserves other stage drafts on reset', writes.length === 1 && stages.S1 !== null && stages.S2 === null && stages.S3 !== null && stages.S4.custom.some(rule => rule.name === '检查会话恢复' && rule.needsWrite))
  check('test direction configuration grants no write permission', !JSON.stringify(stages).includes('writeGrants'))
}
try {
  if (!target.id || !target.webSocketDebuggerUrl) throw Error('Chrome did not create a dedicated preview tab')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.addEventListener('message', onMessage)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('CDP connection timed out')), 10000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', event => { clearTimeout(timer); reject(Error('CDP WebSocket failed: ' + event.message)) }, { once: true })
  })
  await send('Runtime.enable'); await send('Page.enable')
  // Each fixture starts at its own homepage rather than inheriting another case's navigation.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { localStorage.removeItem('dsh-flowgate.hub.memory.v1') } catch {}" })
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const scenarios = [
    ...['idle', 'active', 'finished', 'cancelled'].map(state => ({ stage: 'workspace', state })),
    ...['home', 'rules', 'empty', 'missing', 'S1', 'S2', 'S3', 'S4', 'doc'].map(stage => ({ stage }))
  ]
  const widths = [1280, 768, 390, 320, 264]
  const themes = ['light', 'dark']
  for (const width of widths) for (const theme of themes) for (const scenario of scenarios) {
    currentCase = { width, theme, ...scenario }
    try {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
      await navigate(scenario.stage, scenario.state, theme)
      if (['workspace', 'rules', 'missing'].includes(scenario.stage)) {
        await ready('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("atlas-console"))')
        await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("atlas-console")).click()')
        if (scenario.stage === 'missing') {
          await ready('document.querySelector(".fg-workspace-primary")')
          check('missing workspace cannot start', await evaluate('!document.querySelector(".fg-start-section") && !document.querySelector(".fg-current-flow")'))
        } else {
          await ready('document.querySelector(".fg-workspace-primary .fg-start-section,.fg-workspace-primary .fg-current-flow") && document.querySelectorAll(".fg-flow-row").length===10 && ' + button('编辑规则') + ' && !' + button('编辑规则') + '.disabled')
        }
        if (scenario.stage === 'rules') {
          await inspectRules()
        }
      } else if (!['home', 'empty'].includes(scenario.stage)) {
        await ready('document.querySelector(".fg-nav")')
      }
      await inspectLayout('initial')
      if (scenario.stage === 'workspace') {
        await inspectWorkspace(scenario.state)
        await historyAndKeyboard(scenario.state)
        await openAndInspectDetail(scenario.state)
        if (scenario.state === 'idle') await startWithKeyboard(theme)
        if (scenario.state === 'active') for (const cancelled of [false, true]) {
          await evaluate('window.fixtureFinish(' + cancelled + ')')
          await click('刷新', 'document.querySelector(".fg-head")')
          await ready('document.querySelector(".fg-start-section")')
          check(cancelled ? 'abandoning current flow restores primary start form' : 'finishing current flow restores primary start form', await evaluate('!document.querySelector(".fg-current-flow") && document.querySelectorAll(".fg-start-section").length===1'))
          await inspectLayout(cancelled ? 'after abandonment refresh' : 'after completion refresh')
          if (!cancelled) {
            await navigate('workspace', 'active', theme)
            await ready('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("atlas-console"))')
            await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("atlas-console")).click()')
            await ready('document.querySelector(".fg-current-flow")')
          }
        }
      }
      if (width === 1280 && scenario.stage === 'S3') {
        const issues = await evaluate('(()=>{const flow=document.querySelector(".fg-hub-flow"),nav=flow.querySelector(".fg-nav"),banner=document.createElement("div");banner.className="fg-banner";banner.textContent="无法刷新，正在显示上次保存的结果";flow.insertBefore(banner,nav);return [true,false].flatMap(progress=>{if(!progress)flow.querySelector(".fg-progress")?.remove();const b=banner.getBoundingClientRect(),n=nav.getBoundingClientRect(),m=flow.querySelector(".fg-main").getBoundingClientRect(),g=flow.querySelector(".fg-gate").getBoundingClientRect(),s=flow.querySelector(".fg-settings").getBoundingClientRect();return b.bottom>n.top||n.bottom>m.top||Math.abs(g.top-m.top)>2||s.top-g.bottom>20?[{progress,bannerBottom:b.bottom,navTop:n.top,navBottom:n.bottom,mainTop:m.top,gateTop:g.top}]:[]})})()')
        check('review banner and stage controls do not overlap', issues.length === 0, issues)
      }
    } catch (error) {
      errors.push({ case: currentCase, error: error.message })
    }
  }
  const after = await json('/json/list')
  const result = { preview: 'file fixtures, not deployed DSH', scenarios: scenarios.length * widths.length * themes.length, layoutSnapshots: cases.length, checks: checks.length, failedChecks: checks.filter(item => !item.pass), errors, overflows: cases.filter(item => item.overflow.length), layoutIssues, screenshots, originalTabsPreserved: originalPages.every(page => after.some(item => item.id === page.id && item.url === page.url)) }
  console.log(JSON.stringify(result, null, 2))
  if (errors.length || result.overflows.length || layoutIssues.length) process.exitCode = 1
} finally {
  ws?.close()
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Preview connection closed')) }
  if (target.id) {
    const closed = await fetch(endpoint + '/json/close/' + target.id, { signal: AbortSignal.timeout(10000) })
    if (!closed.ok) throw Error('Could not close dedicated preview tab: HTTP ' + closed.status)
  }
}
