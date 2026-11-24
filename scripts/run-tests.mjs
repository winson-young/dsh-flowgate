import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const tap = /^# tests ([1-9]\d*)\s*$/m
const completed = /^全部通过：([1-9]\d*) 项\s*$/m

export const suites = [
  ['provenance', 'test:provenance', tap],
  ['acceptance', 'test:acceptance', tap],
  ['runtime', 'test:runtime', /^Runtime: [1-9]\d* checks passed\s*$/m],
  ['host', 'test:host', /^(?:全部通过：|通过：)[1-9]\d* 项\s*$/m],
  ['gatemode', 'test:gatemode', completed],
  ['subagents', 'test:subagents', tap],
  ['integration', 'test:integration', completed],
  ['client', 'test:client', completed],
  ['install', 'test:install:fixture', completed],
  ['layout', 'test:layout', /"checks": 25\s*}/m],
].map(([name, script, completion]) => ({ name, script, command: scripts[script], completion }))

function resultFor(suite, options) {
  const { command, completion } = suite
  // npm aliases are simple Node invocations. Run them without a shell or npm.cmd.
  if (!/^node(?: [\w./:=\-]+)+$/.test(command ?? '')) {
    return { status: 'NOT_RUN', reason: `缺少有效的 ${suite.script} Node 入口` }
  }
  const child = spawnSync(process.execPath, command.split(' ').slice(1), {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (child.stdout) process.stdout.write(child.stdout)
  if (child.stderr) process.stderr.write(child.stderr)

  const reasons = []
  const skipMarker = 'FLOWGATE_TEST_SKIP'
  let invalidSkip = false
  for (const line of (child.stdout ?? '').split(/\r?\n/)) {
    if (line === skipMarker || line.startsWith(skipMarker + ' ')) {
      try {
        const { reason } = JSON.parse(line.slice(skipMarker.length))
        if (typeof reason === 'string' && reason.trim()) reasons.push(reason.trim())
        else invalidSkip = true
      } catch {
        invalidSkip = true
      }
    } else if (completion === tap && /^[ \t]*(?:not )?ok \d+ .* # (?:SKIP|TODO)\b/i.test(line)) {
      reasons.push(line.trim())
    }
  }
  if (invalidSkip) reasons.push('跳过记录格式无效')
  const withSkips = (reason) => [reason, ...reasons].join('；')
  if (child.error) {
    return { status: child.pid ? 'FAIL' : 'NOT_RUN', reason: withSkips(child.error.code ?? child.error.message) }
  }
  if (child.status !== 0) {
    return { status: 'FAIL', reason: withSkips(child.signal ? `信号 ${child.signal}` : `退出码 ${child.status}`) }
  }
  if (invalidSkip) return { status: 'FAIL', reason: reasons.join('；') }
  if (!completion.test(child.stdout ?? '')) {
    return { status: 'NOT_RUN', reason: withSkips('退出 0，但缺少完成记录') }
  }
  if (reasons.length) return { status: 'SKIP', reason: reasons.join('；') }
  return { status: 'PASS' }
}

export function runSuites(entries = suites, options = {}) {
  const results = []
  for (const suite of entries) {
    console.log(`\n=== ${suite.name} ===`)
    results.push({ name: suite.name, ...resultFor(suite, options) })
  }
  console.log('\n=== 测试汇总 ===')
  for (const { name, status, reason } of results) {
    console.log(`${name}=${status}${reason ? ' (' + reason.replace(/[\r\n]+/g, ' ') + ')' : ''}`)
  }
  return results.some(({ status }) => status === 'FAIL' || status === 'NOT_RUN') ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runSuites()
}
