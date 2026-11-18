/**
 * Capture the real plugin components with sample data (no running DSH required).
 * Install dev dependencies, start Chrome with a debugging port and file access,
 * then run: node docs/capture-ui.mjs
 * FLOWGATE_CDP can override http://127.0.0.1:9229.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const endpoint = process.env.FLOWGATE_CDP || 'http://127.0.0.1:9229'
const pages = await fetch(endpoint + '/json').then(r => r.json())
const target = pages.find(p => p.type === 'page')
if (!target) throw Error('No Chrome page available at ' + endpoint)
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
let nextId = 0
const pending = new Map(), events = new Map(), errors = []
ws.addEventListener('message', event => {
  const msg = JSON.parse(event.data)
  if (msg.id) {
    const item = pending.get(msg.id); pending.delete(msg.id)
    msg.error ? item?.reject(Error(JSON.stringify(msg.error))) : item?.resolve(msg.result)
  } else {
    events.get(msg.method)?.()
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text)
  }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}
const ready = condition => evaluate('new Promise((resolve,reject)=>{let n=0;function check(){if(' + condition + ')requestAnimationFrame(()=>requestAnimationFrame(resolve));else if(n++<240)requestAnimationFrame(check);else reject(Error("Preview not ready"))}check()})')
try {
  await send('Runtime.enable'); await send('Page.enable')
  const cases = [], screenshots = [], layoutIssues = []
  for (const width of [1280, 768, 390]) for (const theme of ['light', 'dark']) for (const stage of ['home', 'workspace', 'empty', 'S1', 'S2', 'S3', 'S4', 'doc']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
    const url = new URL('./ui-preview.html', import.meta.url); url.searchParams.set('stage', stage); url.searchParams.set('theme', theme)
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Page load timed out')), 10000)
      events.set('Page.loadEventFired', () => { clearTimeout(timer); events.delete('Page.loadEventFired'); resolve() })
    })
    await send('Page.navigate', { url: url.href }); await loaded
    await ready('document.querySelector(".fg-root") && !document.body.textContent.includes("正在连接宿主端")')
    if (stage === 'workspace') {
      await ready('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("atlas-console"))')
      await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("atlas-console")).click()')
      await ready('document.querySelector(".fg-start-section")')
      await evaluate('document.querySelector(".fg-start-section").open=true')
      await ready('document.querySelector("textarea[required]")')
    }
    if (!['home', 'workspace', 'empty'].includes(stage)) await ready('document.querySelector(".fg-nav")')
    const info = await evaluate('(()=>({overflow:[...document.querySelectorAll(".fg-root,.fg-content,.fg-head,.fg-card,.fg-opt,.fg-hub-ws,.fg-stage-list,.fg-gate")].filter(el=>el.scrollWidth>el.clientWidth+2).map(el=>({class:el.className,width:el.clientWidth,scroll:el.scrollWidth})),background:getComputedStyle(document.querySelector(".fg-root")).backgroundColor,question:!!document.querySelector(".fg-q")}))()')
    cases.push({ width, theme, stage, ...info })
    const name = width === 1280 ? stage === 'home' && theme === 'light' ? 'home' : stage === 'workspace' && theme === 'light' ? 'workspace' : stage === 'S1' && theme === 'dark' ? 'decision' : stage === 'S3' && theme === 'light' ? 'workbench' : null : null
    if (name) {
      const height = name === 'home' ? 400 : name === 'decision' ? 900 : 1000
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width, height, scale: 1 } })
      const dest = new URL('./images/' + name + '.png', import.meta.url)
      await writeFile(dest, Buffer.from(shot.data, 'base64')); screenshots.push(fileURLToPath(dest))
    }
    if (width === 1280 && stage === 'S3') {
      const issues = await evaluate(`(()=>{
        const flow=document.querySelector('.fg-hub-flow'),nav=flow.querySelector('.fg-nav');
        const banner=document.createElement('div');banner.className='fg-banner';banner.textContent='无法刷新，正在显示上次保存的结果';flow.insertBefore(banner,nav);
        return [true,false].flatMap(progress=>{
          if(!progress)flow.querySelector('.fg-progress')?.remove();
          const b=banner.getBoundingClientRect(),n=nav.getBoundingClientRect(),m=flow.querySelector('.fg-main').getBoundingClientRect(),g=flow.querySelector('.fg-gate').getBoundingClientRect(),s=flow.querySelector('.fg-settings').getBoundingClientRect();
          return b.bottom>n.top||n.bottom>m.top||Math.abs(g.top-m.top)>2||s.top-g.bottom>20?[{progress,bannerBottom:b.bottom,navTop:n.top,navBottom:n.bottom,mainTop:m.top,gateTop:g.top}]:[];
        });
      })()`)
      layoutIssues.push(...issues.map(issue => ({ theme, ...issue })))
    }
  }
  const result = { cases: cases.length, errors, overflows: cases.filter(c => c.overflow.length), layoutIssues, screenshots }
  console.log(JSON.stringify(result, null, 2))
  if (errors.length || result.overflows.length || layoutIssues.length) process.exitCode = 1
} finally { ws.close() }
