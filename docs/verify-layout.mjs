/**
 * 在已认证的 DSH 桌面端页面取证；不启动浏览器或服务，不导航或修改样式。
 * CDP 消息关联与 Runtime.evaluate 基础参考 capture-ui.mjs；不复用其预览标签流程。
 * 仅此维护脚本要求 Node >=22（内置 WebSocket），插件仍要求 Node >=20。
 */
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const HELP = [
  '用法：node docs/verify-layout.mjs [参数]',
  '',
  '在现有、已认证的 DSH 桌面端页面调用布局诊断 API，输出 JSON 证据。',
  '必填参数（无默认地址、页面或参照选择器）：',
  '  --cdp <HTTP(S)地址>       已有浏览器的 CDP 调试地址，例如 http://127.0.0.1:9229',
  '  --page-url <完整URL>      已有真实 DSH 页面 URL，精确匹配唯一 page target',
  '  --session-id <会话ID>     当前流程所属会话',
  '  --task-selector <CSS>     页面中真实任务条的唯一 CSS 选择器',
  '  --goal-selector <CSS>     页面中真实目标条的唯一 CSS 选择器',
  '可选参数：',
  '  --element <CSS>           待测提示条，默认 .fg-hint；应唯一匹配当前会话的提示条',
  '  --tolerance-px <数值>     左右对齐容差，默认 1 CSS 像素；须为非负有限数',
  '  --out <文件>             同时将 JSON 写入指定文件，不创建父目录',
  '  --help                    显示中文帮助，不连接 CDP',
  '  --self-test               运行脚本纯函数自检，不连接 CDP 或启动服务',
  '',
  '请从现有桌面端开发者工具确认页面 URL 和两条真实参照的选择器；脚本不猜私有类。',
  '仅选择已有页面，不打开窗口、不导航、不刷新、不注入或修改样式，不绕过认证。',
  '诊断 API 会向宿主登记本次实测证据并返回绑定内容版本和页面的回执。',
  'file: 预览不能作为真实验证。只有运行版本、页面身份与实际视口均已核对、宿主回执完整且左右边界合格才为 pass。',
  '缺少 CDP、认证、插件、唯一可见元素、页面身份/视口或版本证据均为 uncovered；版本不匹配也为 uncovered。',
  '退出码：0=pass/帮助/自检，1=实际布局不符，2=未覆盖（含版本未核对或不符）/参数或取证错误。',
].join('\n')

export function parseArgs(argv) {
  const keys = new Map([
    ['--cdp', 'cdp'], ['--page-url', 'pageUrl'], ['--session-id', 'sessionId'],
    ['--task-selector', 'taskSelector'], ['--goal-selector', 'goalSelector'],
    ['--element', 'element'], ['--tolerance-px', 'tolerancePx'], ['--out', 'out'],
  ])
  const options = { element: '.fg-hint', tolerancePx: 1 }
  const seen = new Set()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (seen.has(arg)) throw Error('重复参数：' + arg)
    seen.add(arg)
    if (arg === '--help' || arg === '--self-test') {
      options[arg === '--help' ? 'help' : 'selfTest'] = true
      continue
    }
    const key = keys.get(arg)
    if (!key) throw Error('未知参数：' + arg)
    const value = argv[++index]
    if (!value || value.startsWith('--') || !value.trim()) throw Error('缺少参数值：' + arg)
    options[key] = value
  }
  if (options.help || options.selfTest) return options
  for (const key of ['cdp', 'pageUrl', 'sessionId', 'taskSelector', 'goalSelector']) {
    if (!options[key]) throw Error('必须显式提供参数：' + [...keys].find(([, value]) => value === key)[0])
  }
  const cdp = new URL(options.cdp)
  if (!['http:', 'https:'].includes(cdp.protocol) || cdp.search || cdp.hash) {
    throw Error('--cdp 必须是无查询串和片段的 HTTP(S) 调试地址')
  }
  const page = new URL(options.pageUrl)
  if (['file:', 'data:', 'about:', 'javascript:'].includes(page.protocol)) {
    throw Error('--page-url 必须是真实 DSH 桌面端页面，不能使用预览或空白页')
  }
  options.tolerancePx = Number(options.tolerancePx)
  if (!Number.isFinite(options.tolerancePx) || options.tolerancePx < 0) throw Error('容差必须是非负有限数')
  if (options.taskSelector === options.goalSelector || [options.taskSelector, options.goalSelector].includes(options.element)) {
    throw Error('任务条、目标条和提示条必须提供不同的选择器')
  }
  return options
}

export function selectTarget(targets, pageUrl) {
  if (!Array.isArray(targets)) throw Error('CDP target 列表不是数组')
  const matches = targets.filter(target => target.type === 'page' && target.url === pageUrl)
  if (matches.length !== 1) throw Error('页面 URL 必须精确匹配一个已有 page target，实际匹配 ' + matches.length + ' 个')
  if (!matches[0].webSocketDebuggerUrl) throw Error('已有页面没有可用的 CDP WebSocket 地址')
  return matches[0]
}

// 独立检查版本和几何证据，不能仅凭 API 的 status: pass 宣称通过。
export function validateEvidence(value, request) {
  const result = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}
  if (Array.isArray(result.measurements)) {
    result.measurements = result.measurements.map(item => {
      const reference = request.references.find(reference => reference.name === item?.reference || reference.selector === item?.reference)
      return reference ? { ...item, reference: reference.name } : item
    })
  }
  const finish = (status, reason) => ({ ...result, status, reason })
  const runtime = result.runtime
  if (runtime?.status === 'mismatch') return finish('uncovered', runtime.reason || '运行时版本不匹配')
  if (runtime?.status !== 'verified') return finish('uncovered', runtime?.reason || result.reason || '运行时版本尚未核对')
  const names = ['hostRevision', 'diskHostRevision', 'expectedClientRevision', 'clientRevision']
  if (names.some(key => typeof runtime[key] !== 'string' || !/^[a-f0-9]{64}$/i.test(runtime[key]))) {
    return finish('uncovered', '运行版本缺少完整 SHA256 证据')
  }
  if (runtime.hostRevision !== runtime.diskHostRevision || runtime.expectedClientRevision !== runtime.clientRevision || result.clientRevision !== runtime.clientRevision) {
    return finish('uncovered', '运行宿主、磁盘宿主或客户端版本不一致')
  }
  const page = result.pageEvidence
  if (typeof page?.pageId !== 'string' || !page.pageId.trim() || result.pageId !== page.pageId || runtime.pageId !== page.pageId) {
    return finish('uncovered', '缺少本次页面身份或页面身份不一致')
  }
  const viewports = [page.viewport, result.viewport, runtime.viewport]
  if (viewports.some(viewport => !viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0 || viewport.width !== page.viewport.width || viewport.height !== page.viewport.height)) {
    return finish('uncovered', '页面实际视口、测量视口或运行时视口缺失或不一致')
  }
  if (!['pass', 'fail', 'uncovered'].includes(result.status)) return finish('uncovered', '诊断 API 未返回有效状态')
  if (result.status !== 'uncovered' && (typeof result.evidenceId !== 'string' || !result.evidenceId.trim() || typeof result.version !== 'string' || !result.version.trim())) {
    return finish('uncovered', '缺少宿主取证回执 ID 或内容版本')
  }
  if (result.status !== 'pass') return result
  const viewport = result.viewport
  if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
    return finish('uncovered', '缺少有效视口证据')
  }
  if (!Array.isArray(result.measurements)) return finish('uncovered', '缺少布局测量证据')
  for (const reference of request.references) {
    const measurements = result.measurements.filter(item => item && item.element === request.element && [reference.name, reference.selector].includes(item.reference))
    if (measurements.length !== 1) return finish('uncovered', '参照测量不唯一或缺失：' + reference.name)
    const item = measurements[0]
    if (['left', 'right', 'referenceLeft', 'referenceRight'].some(key => !Number.isFinite(item[key])) || item.right <= item.left || item.referenceRight <= item.referenceLeft) {
      return finish('uncovered', '参照测量无效：' + reference.name)
    }
    if (Math.abs(item.left - item.referenceLeft) > request.tolerancePx || Math.abs(item.right - item.referenceRight) > request.tolerancePx) {
      return finish('fail', '左右边界超过容差：' + reference.name)
    }
  }
  return result
}

async function connect(address) {
  const ws = new WebSocket(address)
  const pending = new Map()
  let nextId = 0
  const rejectAll = reason => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error(reason)) }
    pending.clear()
  }
  ws.addEventListener('message', event => {
    let message
    try { message = JSON.parse(event.data) } catch { rejectAll('CDP 返回了无效 JSON'); return }
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id); clearTimeout(item.timer)
    message.error ? item.reject(Error('CDP 错误：' + JSON.stringify(message.error))) : item.resolve(message.result)
  })
  ws.addEventListener('close', () => rejectAll('CDP 连接已关闭'))
  ws.addEventListener('error', () => rejectAll('CDP WebSocket 连接错误'))
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('CDP 连接超时')), 10000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('CDP WebSocket 无法连接')) }, { once: true })
      ws.addEventListener('close', () => { clearTimeout(timer); reject(Error('CDP 在连接完成前关闭')) }, { once: true })
    })
  } catch (error) { ws.close(); throw error }
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP 请求超时：' + method)) }, 15000)
        pending.set(id, { resolve, reject, timer })
        try { ws.send(JSON.stringify({ id, method, params })) }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error) }
      })
    },
    close() { rejectAll('取证结束'); ws.close() },
  }
}

// 仅调用已有诊断 API；元素挂载根、会话归属和可见性由 API 统一核对。
async function inspectPage(request, pageUrl) {
  const unavailable = reason => ({ status: 'uncovered', reason })
  if (location.href !== pageUrl) return unavailable('页面在取证前已改变 URL')
  const api = window.__DSH_FLOWGATE_DIAGNOSTICS__
  if (!api || typeof api.inspectLayout !== 'function') return unavailable('页面未加载布局诊断 API，可能未认证或插件未加载')
  const pageEvidence = { pageId: api.pageId, viewport: { width: window.innerWidth, height: window.innerHeight } }
  try {
    const result = await api.inspectLayout(request)
    if (location.href !== pageUrl) return unavailable('页面在取证过程中改变 URL')
    if (api.pageId !== pageEvidence.pageId || window.innerWidth !== pageEvidence.viewport.width || window.innerHeight !== pageEvidence.viewport.height) {
      return { ...result, pageEvidence, status: 'uncovered', reason: '页面身份或实际视口在取证过程中改变' }
    }
    return { ...result, pageEvidence }
  } catch (error) { return unavailable('诊断 API 无法完成：' + (error?.message || String(error))) }
}

async function collect(options) {
  if (Number(process.versions.node.split('.')[0]) < 22 || typeof WebSocket !== 'function') {
    return { status: 'uncovered', reason: '此维护脚本需要 Node >=22 的内置 WebSocket；插件最低版本仍为 Node >=20' }
  }
  const request = {
    sessionId: options.sessionId, element: options.element,
    references: [{ name: '任务条', selector: options.taskSelector }, { name: '目标条', selector: options.goalSelector }],
    tolerancePx: options.tolerancePx,
  }
  let connection
  let targetId
  try {
    const endpoint = options.cdp.endsWith('/') ? options.cdp : options.cdp + '/'
    const response = await fetch(new URL('json/list', endpoint), { signal: AbortSignal.timeout(10000), redirect: 'error' })
    if (!response.ok) throw Error('CDP target 列表不可用：HTTP ' + response.status)
    const target = selectTarget(await response.json(), options.pageUrl)
    targetId = target.id
    connection = await connect(target.webSocketDebuggerUrl)
    const evaluation = await connection.send('Runtime.evaluate', {
      expression: '(' + inspectPage.toString() + ')(' + JSON.stringify(request) + ',' + JSON.stringify(options.pageUrl) + ')',
      awaitPromise: true, returnByValue: true,
    })
    if (evaluation.exceptionDetails) throw Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text)
    return { targetId, pageUrl: options.pageUrl, request, ...validateEvidence(evaluation.result?.value, request) }
  } catch (error) {
    return { targetId, pageUrl: options.pageUrl, request, status: 'uncovered', reason: error.message || String(error) }
  } finally { connection?.close() }
}

async function selfTest() {
  const { default: assert } = await import('node:assert/strict')
  const argv = ['--cdp', 'http://127.0.0.1:9229', '--page-url', 'http://127.0.0.1:52185/', '--session-id', 'session', '--task-selector', '#task', '--goal-selector', '#goal']
  assert.equal(parseArgs(argv).tolerancePx, 1)
  for (const invalid of [[], [...argv, '--unknown'], [...argv, '--tolerance-px', 'NaN'], [...argv, '--element', '#task']]) assert.throws(() => parseArgs(invalid))
  assert.throws(() => parseArgs(argv.map(value => value === 'http://127.0.0.1:52185/' ? 'file:///preview.html' : value)))
  assert.throws(() => selectTarget([{ type: 'page', url: 'http://other/' }], 'http://wanted/'))
  assert.throws(() => selectTarget([{ type: 'page', url: 'x' }, { type: 'page', url: 'x' }], 'x'))
  const revision = 'a'.repeat(64)
  const request = { element: '.fg-hint', tolerancePx: 1, references: [{ name: '任务条', selector: '#task' }, { name: '目标条', selector: '#goal' }] }
  const valid = { evidenceId: 'receipt-test', version: 'b'.repeat(64), pageId: 'page-test', pageEvidence: { pageId: 'page-test', viewport: { width: 1280, height: 800 } }, clientRevision: revision, runtime: { status: 'verified', pageId: 'page-test', viewport: { width: 1280, height: 800 }, hostRevision: revision, diskHostRevision: revision, expectedClientRevision: revision, clientRevision: revision }, viewport: { width: 1280, height: 800 }, measurements: request.references.map(reference => ({ element: request.element, reference: reference.name, left: 10, right: 100, referenceLeft: 11, referenceRight: 101 })), status: 'pass', reason: '边界合格' }
  assert.equal(validateEvidence(valid, request).status, 'pass')
  assert.deepEqual(validateEvidence({ ...valid, measurements: valid.measurements.map((item, index) => ({ ...item, reference: request.references[index].selector })) }, request).measurements.map(item => item.reference), ['任务条', '目标条'])
  assert.equal(validateEvidence({ ...valid, runtime: { ...valid.runtime, status: 'unverified' } }, request).status, 'uncovered')
  assert.equal(validateEvidence({ ...valid, runtime: { ...valid.runtime, diskHostRevision: 'b'.repeat(64) } }, request).status, 'uncovered')
  assert.equal(validateEvidence({ ...valid, runtime: { ...valid.runtime, hostRevision: 'unknown' } }, request).status, 'uncovered')
  assert.equal(validateEvidence({ ...valid, measurements: valid.measurements.slice(1) }, request).status, 'uncovered')
  assert.equal(validateEvidence({ ...valid, measurements: valid.measurements.map(item => ({ ...item, right: 103 })) }, request).status, 'fail')
  assert.equal(validateEvidence({ ...valid, measurements: valid.measurements.map(item => ({ ...item, left: NaN })) }, request).status, 'uncovered')
  assert.equal(validateEvidence({ ...valid, runtime: { ...valid.runtime, status: 'mismatch' } }, request).status, 'uncovered')
  assert.equal(validateEvidence({ ...valid, pageEvidence: undefined }, request).status, 'uncovered')
  assert.equal(validateEvidence({ ...valid, runtime: { ...valid.runtime, pageId: null } }, request).status, 'uncovered')
  assert.equal(validateEvidence({ ...valid, runtime: { ...valid.runtime, viewport: undefined } }, request).status, 'uncovered')
  assert.equal(validateEvidence({ ...valid, runtime: { ...valid.runtime, viewport: { width: 390, height: 800 } } }, request).status, 'uncovered')
  assert.equal(validateEvidence({ ...valid, pageId: 'another-page' }, request).status, 'uncovered')
  assert.equal(validateEvidence({ ...valid, pageEvidence: { ...valid.pageEvidence, viewport: { width: 768, height: 800 } } }, request).status, 'uncovered')
  assert.equal(validateEvidence({ ...valid, evidenceId: undefined }, request).status, 'uncovered')
  assert.equal(validateEvidence({ ...valid, status: 'fail', version: undefined }, request).status, 'uncovered')
  console.log(JSON.stringify({ status: 'pass', scope: '脚本纯函数自检；未连接 CDP，不代表真实 GUI 验证', checks: 25 }, null, 2))
}

async function main() {
  let options
  let result
  try { options = parseArgs(process.argv.slice(2)) }
  catch (error) { result = { status: 'uncovered', reason: error.message, help: '运行 --help 查看必填参数' } }
  if (options?.help) { console.log(HELP); return }
  if (options?.selfTest) { await selfTest(); return }
  result = { capturedAt: new Date().toISOString(), verification: 'existing-authenticated-desktop-page', ...(result || await collect(options)) }
  let json = JSON.stringify(result, null, 2) + '\n'
  if (options?.out) {
    try { await writeFile(options.out, json, 'utf8') }
    catch (error) {
      result = { ...result, status: 'uncovered', reason: '证据文件写入失败：' + error.message }
      json = JSON.stringify(result, null, 2) + '\n'
    }
  }
  process.stdout.write(json)
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.log(JSON.stringify({ status: 'uncovered', reason: error.message || String(error) }, null, 2))
    process.exitCode = 2
  })
}
