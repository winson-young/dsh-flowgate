/** Read-only probes for the existing DSH GUI; never starts a browser or server. */
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const getJSON = async url => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw Error('HTTP ' + res.status + ': ' + url)
  return res.json()
}
if (args.length === 1 && args[0] === '--environment') {
  const script = String.raw`Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'DeepSeek|chrome|msedge|node' } | ForEach-Object { $line=$_.CommandLine; [PSCustomObject]@{ id=$_.ProcessId; name=$_.Name; executable=$_.ExecutablePath; debug=[regex]::Matches($line,'--remote-debugging-(port|pipe)(=\S+)?').Value; webWatcher=($line -match 'dev:web') } } | ConvertTo-Json -Depth 4 -Compress`
  console.log(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 15000 }).trim())
} else if (args.length === 2 && args[0] === '--resources') {
  const page = new URL(args[1])
  if (!['http:', 'https:'].includes(page.protocol) || !['127.0.0.1', 'localhost'].includes(page.hostname)) throw Error('Use the existing local GUI URL')
  const response = await fetch(page, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw Error('GUI HTTP ' + response.status)
  const html = await response.text()
  const sources = [...html.matchAll(/<script[^>]+src=["']([^"']+)/g)].map(match => new URL(match[1], page).href)
  for (const source of sources) {
    if (new URL(source).origin !== page.origin) continue
    const res = await fetch(source, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw Error('Resource HTTP ' + res.status)
    const text = await res.text()
    const hits = [...text.matchAll(/conversation\.input\.dock|进行中的目标|--dsh-composer|flowgate-hub-stage-hint/g)].slice(0,12).map(m => text.slice(Math.max(0,m.index-700),m.index+1000))
    console.log(JSON.stringify({ source, bytes:text.length, hits }))
  }
} else if (args.length === 4 && args[0] === '--cdp' && args[2] === '--page-url') {
  const address = new URL(args[1])
  if (!['http:', 'https:'].includes(address.protocol) || !['127.0.0.1', 'localhost'].includes(address.hostname)) throw Error('Use an existing local CDP endpoint')
  const matches = (await getJSON(new URL('/json/list',address))).filter(p => p.type==='page' && p.url===args[3])
  if (matches.length!==1 || !matches[0].webSocketDebuggerUrl) throw Error('Expected one existing page with exact URL')
  const ws = new WebSocket(matches[0].webSocketDebuggerUrl)
  await new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(Error('CDP open timeout')),5000)
    ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true})
    ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP open failed'))},{once:true})
  })
  try {
    const expression = `(() => {
      const rect = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return { tag:el.tagName, class:el.className, left:r.left, right:r.right, width:r.width, client:el.clientWidth, scroll:el.scrollWidth, display:s.display, maxWidth:s.maxWidth, padding:s.padding, margin:s.margin, boxSizing:s.boxSizing }; };
      const ancestors=el=>[el,el.parentElement,el.parentElement?.parentElement,el.parentElement?.parentElement?.parentElement].filter(Boolean).map(rect);
      return { url:location.href, viewport:{width:innerWidth,height:innerHeight}, diagnostics:!!window.__DSH_FLOWGATE_DIAGNOSTICS__, hints:[...document.querySelectorAll('.fg-hint')].filter(el=>el.getClientRects().length).map(el=>({sessionId:el.dataset.fgSessionId,ancestors:ancestors(el)})), references:[...document.querySelectorAll('button,summary,h3,h4,span')].filter(el=>['任务','进行中的目标'].includes(el.textContent.trim()) && el.getClientRects().length).slice(0,12).map(el=>({label:el.textContent.trim(),ancestors:ancestors(el)})) };
    })()`
    const result=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('CDP evaluate timeout')),10000)
      ws.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id!==1)return;clearTimeout(timer);if(data.error||data.result?.exceptionDetails)reject(Error(JSON.stringify(data.error||data.result.exceptionDetails)));else resolve(data.result.result.value)})
      ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}))
    })
    console.log(JSON.stringify(result))
  } finally { ws.close() }
} else {
  throw Error('Usage: --environment | --resources <existing GUI URL> | --cdp <existing local HTTP URL> --page-url <exact existing page URL>')
}
