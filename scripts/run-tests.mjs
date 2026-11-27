import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { captureSync } from './capture-child.mjs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const tap = /^# tests ([1-9]\d*)\s*$/m
const completed = /^全部通过：([1-9]\d*) 项\s*$/m

// 工作副本里没有的测试文件不接入，但要记账：汇总前单列出来，免得「少跑了一套」
// 在输出里表现为「那一行根本不存在」。打印位置必须在「=== 测试汇总 ===」之前——
// test/test-runner.test.mjs 对汇总末尾做逐行比对，追加在汇总之后会打红它。
const notWired = []
const conditional = (file, entry) => {
  if (existsSync(root + file)) return [entry]
  notWired.push(entry[0])
  return []
}

const testSuites = [
  ['provenance', 'test:provenance', tap],
  ['acceptance', 'test:acceptance', tap],
  ['runtime', 'test:runtime', /^Runtime: [1-9]\d* checks passed\s*$/m],
  ['host', 'test:host', /^(?:全部通过：|通过：)[1-9]\d* 项\s*$/m],
  ['gatemode', 'test:gatemode', completed],
  // subagents 用例是顶层 `await test(...)` 顺序执行的：Node 26 的 --experimental-test-isolation=none
  // 配上顶层 await 会挂死（最小复现三行即可，EXIT=124），所以这一套直跑，完成标记用直跑的汇总行。
  ['subagents', 'test:subagents', /^ℹ tests [1-9]\d*\s*$/m],
  ['integration', 'test:integration', completed],
  ['client', 'test:client', completed],
  ['install', 'test:install:fixture', completed],
  ['layout', 'test:layout', /"checks": 25\s*}/m],
  // check 契约扫描器：它守的是「用例名后面真的有断言」。同样按存在与否接入——
  // 隔离夹具只复制 scripts/ 与 lib/，没有 test/ 目录，硬接会让夹具汇总多出一套 NOT_RUN。
  ...conditional('test/host.test.mjs', ['checks', 'test:checks', /^check contracts verified \([1-9]\d* calls in [1-9]\d* files\)\.$/m]),
  // 真实 spawn 探针单独一套：受限环境跑不了时它自己报 SKIP，不会连累 host 整套。
  ...conditional('test/spawn.test.mjs', ['spawn', 'test:spawn', /^(?:全部通过：[1-9]\d* 项|未执行：宿主禁止 spawn 子进程（[A-Z]+）)\s*$/m]),
  // 发布脚本与聚合器元测试的用例接在这里。但只有工作副本里真有那个测试文件时才接：
  // test/test-runner.test.mjs 的 fixture 只复制 scripts/ 与 lib/，不复制 test/，
  // 按存在与否决定接入，才不会把那个 fixture 的汇总行数与顺序打乱。
  // 元测试自己也在其中：聚合器的判定与清单从此有回归保护，改坏了默认链路直接红。
  ...conditional('test/publish.test.mjs', ['publish', 'test:publish', tap]),
  ...conditional('test/test-runner.test.mjs', ['runner', 'test:runner', tap]),
].map(([name, script, completion]) => ({ name, script, command: scripts[script], completion }))

export const suites = [
  {
    name: 'revisions',
    script: 'scripts/stamp-revisions.mjs',
    command: 'node scripts/stamp-revisions.mjs --check',
    completion: /^Module revisions verified \([1-9]\d* modules\)\.$/m,
  },
  ...testSuites,
]

// 捕获走 captureSync：受限沙箱里管道 stdio 会 EPERM，文件描述符不会。
function runCaptured(args, { cwd, env }) {
  return captureSync(process.execPath, args, { cwd, env, timeout: 180_000, killSignal: 'SIGKILL' })
}

function resultFor(suite, options) {
  const { command, completion } = suite
  // Suite commands are simple Node invocations. Run them without a shell or npm.cmd.
  if (!/^node(?: [\w./:=\-]+)+$/.test(command ?? '')) {
    return { status: 'NOT_RUN', reason: `缺少有效的 ${suite.script} Node 入口` }
  }
  const child = runCaptured(command.split(' ').slice(1), {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
  })
  // 子进程输出默认直接写进程 stdout；需要接管这条通道的调用方传 options.write。
  // 元测试要在 node --test 下跑，那里 stdout 会被测试运行器当 TAP 解析，
  // 所以接管是显式参数，缺省路径保持逐字节不变。
  const writeStdout = typeof options.write === 'function' ? options.write : (chunk) => process.stdout.write(chunk)
  if (child.stdout) writeStdout(child.stdout)
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
  if (notWired.length) console.log('本环境未接入：' + notWired.join('、') + '（对应测试文件不存在）')
  console.log('\n=== 测试汇总 ===')
  for (const { name, status, reason } of results) {
    console.log(`${name}=${status}${reason ? ' (' + reason.replace(/[\r\n]+/g, ' ') + ')' : ''}`)
  }
  return results.some(({ status }) => status === 'FAIL' || status === 'NOT_RUN') ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runSuites()
}
