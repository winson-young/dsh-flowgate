import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { HOST_MODULES } from '../lib/runtime.js'
import { capture as captureAsync, captureSync } from '../scripts/capture-child.mjs'
import { runSuites, suites } from '../scripts/run-tests.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const exec = promisify(execFile)
const options = { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 90000 }
const suiteFor = (name) => suites.find((entry) => entry.name === name)

// node --test 会给自己起的子进程塞 NODE_TEST_CONTEXT，让子进程按测试协议输出。
// 这套件断言的是子进程的普通 stdout，所以起子进程前统一洗掉它：直跑与 node --test
// 两个入口因此走同一条输出通道，同一条断言不会一边绿一边红。
const TEST_CONTEXT_ENV = ['NODE_TEST_CONTEXT']
function childEnv(env = process.env) {
  const next = { ...env }
  for (const key of TEST_CONTEXT_ENV) delete next[key]
  return next
}

function run(args, env = process.env) {
  // 捕获走 captureSync：受限沙箱拒绝管道 stdio（spawn EPERM），文件描述符不拒绝。
  const result = captureSync(process.execPath, args, { ...options, env: childEnv(env) })
  assert.ifError(result.error)
  return result
}

// capture 把两条输出通道分开：汇总行仍走 console.log，子进程 stdout 走 sink。
// 不分开的话，node --test 下子进程输出会混进测试运行器要解析的 TAP 流。
function capture(callback) {
  const messages = []
  const child = []
  const original = console.log
  try {
    console.log = (message) => messages.push(message)
    const status = callback({ write: (chunk) => child.push(String(chunk)) })
    return { status, output: messages.join(String.fromCharCode(10)), child: child.join('') }
  } finally {
    console.log = original
  }
}

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flowgate-runner-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('默认测试汇总过期指纹，继续运行其余十套且不改写模块', (t) => {
  const cwd = join(temp(t), 'test project')
  for (const dir of ['lib', 'scripts']) mkdirSync(join(cwd, dir), { recursive: true })
  // capture-child.mjs 是 run-tests.mjs 的直接依赖（受限沙箱里靠它捕获子进程输出），夹具必须一起复制。
  for (const file of ['scripts/run-tests.mjs', 'scripts/stamp-revisions.mjs', 'scripts/capture-child.mjs', ...HOST_MODULES.map((name) => 'lib/' + name)]) {
    copyFileSync(join(root, file), join(cwd, file))
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const fixtureSuites = [
    ['provenance', 'test:provenance', '# tests 1'],
    ['acceptance', 'test:acceptance', '# tests 1'],
    ['runtime', 'test:runtime', 'Runtime: 1 checks passed'],
    ['host', 'test:host', '通过：1 项'],
    ['gatemode', 'test:gatemode', '全部通过：1 项'],
    // subagents 直跑（顶层 await test 与 --experimental-test-isolation=none 在 Node 26 下会挂死），
    // 完成标记因此是直跑打印的 `ℹ tests N`，不是 TAP 的 `# tests N`。
    ['subagents', 'test:subagents', 'ℹ tests 1'],
    ['integration', 'test:integration', '全部通过：1 项'],
    ['client', 'test:client', '全部通过：1 项'],
    ['install', 'test:install:fixture', '全部通过：1 项'],
    ['layout', 'test:layout', '{"checks": 25}'],
  ]
  for (const [name, alias, completion] of fixtureSuites) {
    manifest.scripts[alias] = 'node ' + name + '.mjs'
    writeFileSync(join(cwd, name + '.mjs'), 'console.log(' + JSON.stringify(completion) + ')')
  }
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest))

  const runFixture = (command) => {
    const [node, ...args] = command.split(' ')
    assert.equal(node, 'node')
    const path = join(cwd, 'runner.log')
    const fd = openSync(path, 'w')
    let result
    try {
      result = spawnSync(process.execPath, args, { ...options, cwd, env: childEnv(), stdio: ['ignore', fd, fd] })
    } finally {
      closeSync(fd)
    }
    assert.ifError(result.error)
    return { status: result.status, output: readFileSync(path, 'utf8') }
  }
  const stamp = () => {
    const result = runFixture(manifest.scripts.stamp)
    assert.equal(result.status, 0, result.output)
  }
  const assertSummary = (fingerprintLine, output) => {
    const expected = ['=== 测试汇总 ===', fingerprintLine, ...fixtureSuites.map(([name]) => name + '=PASS')]
    assert.deepEqual(output.trimEnd().split(/\r?\n/).slice(-expected.length), expected)
  }
  const verifyClean = () => {
    const result = runFixture(manifest.scripts.test)
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /^Module revisions verified \([1-9]\d* modules\)\.$/m)
    assertSummary('revisions=PASS', result.output)
  }

  stamp()
  verifyClean()
  const target = join(cwd, 'lib', 'acceptance.js')
  const stale = Buffer.concat([readFileSync(target), Buffer.from('\n// unstamped fixture edit\n')])
  writeFileSync(target, stale)
  const result = runFixture(manifest.scripts.test)
  assert.equal(result.status, 1, result.output)
  const events = result.output.trim().split(/\r?\n/).filter(Boolean)
  assert.deepEqual(events.slice(0, 2), ['=== revisions ===', 'Stale module revisions: acceptance.js'])
  assert.deepEqual(events.slice(2, 2 + fixtureSuites.length * 2),
    fixtureSuites.flatMap(([name, , completion]) => ['=== ' + name + ' ===', completion]))
  assertSummary('revisions=FAIL (退出码 1)', result.output)
  assert.deepEqual(readFileSync(target), stale)
  stamp()
  verifyClean()
})

test('失败后继续，汇总四种状态并返回真实退出码', (t) => {
  const cwd = temp(t)
  const fixture = (name, lines, code = 0) => {
    const source = 'for (const line of ' + JSON.stringify(lines) + ') console.log(line); process.exitCode = ' + code
    writeFileSync(join(cwd, name + '.mjs'), source)
    return { name, command: 'node ' + name + '.mjs', completion: /^complete$/m }
  }
  const failure = fixture('first', ['complete'], 7)
  const early = fixture('early', [])
  const skip = fixture('skip', ['FLOWGATE_TEST_SKIP ' + JSON.stringify({ reason: 'Git missing' }), 'complete'])
  const later = fixture('later', ['complete'])
  const missing = { name: 'missing', script: 'test:missing' }
  const mixed = capture((sink) => runSuites([failure, early, skip, missing, later], { cwd, env: childEnv(), ...sink }))
  assert.equal(mixed.status, 1)
  assert.match(mixed.output, /first=FAIL .*退出码 7/)
  assert.match(mixed.output, /early=NOT_RUN .*缺少完成记录/)
  assert.match(mixed.output, /skip=SKIP .*Git missing/)
  assert.match(mixed.output, /missing=NOT_RUN .*test:missing/)
  assert.match(mixed.output, /later=PASS/)
  assert.equal(capture((sink) => runSuites([skip, later], { cwd, env: childEnv(), ...sink })).status, 0)
  assert.equal(capture((sink) => runSuites([early], { cwd, env: childEnv(), ...sink })).status, 1)
})

test('缺少有效跳过原因时判为失败', (t) => {
  const cwd = temp(t)
  const command = 'node invalid.mjs'
  for (const payload of ['', '{', '{}', 'null', '{"reason":" "}', '{"reason":1}']) {
    const marker = 'FLOWGATE_TEST_SKIP' + (payload ? ' ' + payload : '')
    writeFileSync(join(cwd, 'invalid.mjs'), 'console.log(' + JSON.stringify(marker) + '); console.log("complete")')
    const result = capture((sink) => runSuites([{ name: 'invalid', command, completion: /^complete$/m }], { cwd, env: childEnv(), ...sink }))
    assert.equal(result.status, 1, payload)
    assert.match(result.output, /invalid=FAIL .*跳过记录格式无效/)
  }
})

test('真实 TAP 子进程的嵌套跳过计入套件汇总', (t) => {
  const cwd = temp(t)
  writeFileSync(join(cwd, 'nested.mjs'), `
    import { test } from 'node:test'
    test('parent', async (t) => {
      await t.test('child', { skip: 'fixture unavailable' }, () => {
        throw new Error('skipped test ran')
      })
    })
  `)
  // 走 node-test.mjs 包装：受限沙箱里 `node --test` 自己派生子进程会用管道，直接 EPERM。
  const wrapper = join(root, 'scripts', 'node-test.mjs').split('\\').join('/')
  const suite = { ...suiteFor('provenance'), name: 'nested', command: 'node ' + wrapper + ' nested.mjs' }
  const result = capture((sink) => runSuites([suite], { cwd, env: childEnv(), ...sink }))
  assert.equal(result.status, 0)
  assert.match(result.output, /nested=SKIP .*fixture unavailable/)
})

test('默认安装夹具忽略覆盖路径，真实入口读取覆盖路径', (t) => {
  const missing = join(temp(t), 'missing profile')
  const env = { ...process.env, FLOWGATE_PROFILE_DIR: missing }
  const fixture = run(suiteFor('install').command.split(' ').slice(1), env)
  assert.equal(fixture.status, 0, fixture.stderr + fixture.stdout)
  assert.match(fixture.stdout, /全部通过：17 项/)
  assert.ok(!fixture.stdout.includes(missing))
  const installed = run(['test/install.test.mjs'], env)
  assert.equal(installed.status, 1)
  assert.ok(installed.stdout.includes(missing))
})

// 宿主里的 scope 体检按 PATH 找清单里的可执行体。整条 PATH 换成空目录会把 npm 一起藏掉，
// 体检随即报「这些命令用到的可执行体在当前 PATH 上找不到：npm test（命令本身找不到：npm）」，
// flowgate_doc 提交时抛错、宿主退出 1——用例就从「无 Git 就 SKIP」退化成「无 Git 顺带崩」。
// 所以只让 git 不可见：剔除含 git 可执行文件的目录，其余（node、npm、系统目录）原样保留。
const GIT_NAMES = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat', 'git.com'] : ['git']

function hasGit(dir) {
  return GIT_NAMES.some((name) => existsSync(join(dir, name)))
}

function pathWithoutGit(t) {
  const separator = process.platform === 'win32' ? ';' : ':'
  const dirs = String(process.env.PATH ?? process.env.Path ?? '')
    .split(separator)
    .map((dir) => dir.replace(/^"(.*)"$/u, '$1'))
    .filter(Boolean)
  const kept = dirs.filter((dir) => !hasGit(dir))
  const nodeDir = dirname(process.execPath)
  if (kept.includes(nodeDir)) return kept.join(separator)
  if (!hasGit(nodeDir)) {
    kept.unshift(nodeDir)
    return kept.join(separator)
  }
  // node 与 git 装在同一个目录时（Linux 的 /usr/bin 就是这样），上面的剔除会把 node/npm
  // 一起带走。把 node 与 npm 复制进一个干净的临时目录顶在最前面，git 仍然不可见。
  const clean = temp(t)
  for (const name of [basename(process.execPath), 'node', 'node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd']) {
    const source = join(nodeDir, name)
    const target = join(clean, name)
    if (!existsSync(source) || existsSync(target)) continue
    copyFileSync(source, target)
    if (process.platform !== 'win32') chmodSync(target, 0o755)
  }
  kept.unshift(clean)
  return kept.join(separator)
}

test('没有 Git 时宿主退出 0，汇总标记 SKIP 并显示原因', (t) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
  env.PATH = pathWithoutGit(t)
  // 先证明构造真的生效：构造失败时要报「PATH 上还有 git」，而不是让下面的断言红得没头没脑。
  const probe = captureSync('git', ['--version'], { env: childEnv(env), windowsHide: true, timeout: 5000 })
  assert.equal(probe.error?.code, 'ENOENT', 'PATH 上仍然找得到 git，这条用例证明不了「Git 不可用」')
  const result = capture((sink) => runSuites([suiteFor('host')], { env: childEnv(env), ...sink }))
  assert.equal(result.status, 0)
  assert.match(result.output, /host=SKIP .*Git 不可用（ENOENT）/)
})

test('两个集成进程各用独立临时目录并清理', async () => {
  const outputs = await Promise.all([
    captureAsync(process.execPath, ['test/integration.test.mjs'], { ...options, env: childEnv() }),
    captureAsync(process.execPath, ['test/integration.test.mjs'], { ...options, env: childEnv() }),
  ])
  const dirs = outputs.map(({ stdout }) => {
    assert.match(stdout, /全部通过：[1-9]\d* 项/)
    const match = stdout.match(/^FLOWGATE_INTEGRATION_FIXTURE ([^\r\n]+)$/m)
    assert.ok(match, stdout)
    return match[1]
  })
  assert.notEqual(dirs[0], dirs[1])
  for (const dir of dirs) assert.equal(existsSync(dir), false, dir)
})

test('默认链路把元测试自己接在最后，并复用同一份 TAP 完成标记', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const runner = suiteFor('runner')
  assert.ok(runner, '默认链路应当包含 runner 套件')
  assert.equal(runner.command, manifest.scripts['test:runner'])
  // 命令走 node-test.mjs 包装：受限沙箱里 `node --test` 自己派生隔离子进程会用管道，直接 EPERM。
  assert.equal(runner.command, 'node scripts/node-test.mjs test/test-runner.test.mjs')
  assert.equal(runner.completion, suiteFor('provenance').completion)
  assert.equal(suites[0].name, 'revisions')
  assert.equal(suites[suites.length - 1].name, 'runner')
  assert.equal(suites.length, 14 + (existsSync(join(root, 'test/publish.test.mjs')) ? 1 : 0))
})

test('接上输出通道时子进程输出不进汇总通道', (t) => {
  const cwd = temp(t)
  writeFileSync(join(cwd, 'echo.mjs'), 'console.log("child stdout line")')
  const suite = { name: 'echo', command: 'node echo.mjs', completion: /^child stdout line$/m }
  const result = capture((sink) => runSuites([suite], { cwd, env: childEnv(), ...sink }))
  assert.equal(result.status, 0)
  assert.match(result.child, /child stdout line/)
  assert.match(result.output, /echo=PASS/)
  assert.ok(!result.output.includes('child stdout line'), result.output)
})

test('测试运行器上下文下子进程不继承测试协议', (t) => {
  // 先直接钉住清洗本身：直跑时父进程本来就没有 NODE_TEST_CONTEXT，
  // 只靠下面那条子进程观察对「清洗被删掉」没有区分力（直跑仍绿）。
  const polluted = childEnv({ ...process.env, NODE_TEST_CONTEXT: 'child' })
  for (const key of TEST_CONTEXT_ENV) assert.equal(key in polluted, false, key)
  const cwd = temp(t)
  writeFileSync(join(cwd, 'context.mjs'), 'console.log("context=" + String(process.env.NODE_TEST_CONTEXT === undefined))')
  const suite = { name: 'context', command: 'node context.mjs', completion: /^context=true$/m }
  const result = capture((sink) => runSuites([suite], { cwd, env: childEnv(), ...sink }))
  assert.equal(result.status, 0, result.output)
})

test('不接管输出通道时子进程输出仍写进程 stdout', (t) => {
  const cwd = temp(t)
  writeFileSync(join(cwd, 'plain.mjs'), 'console.log("default channel line")')
  const suite = { name: 'plain', command: 'node plain.mjs', completion: /^default channel line$/m }
  const events = []
  const originalWrite = process.stdout.write
  const originalLog = console.log
  try {
    console.log = (message) => events.push({ from: 'log', text: String(message) })
    process.stdout.write = (chunk) => {
      events.push({ from: 'child', text: String(chunk) })
      return true
    }
    assert.equal(runSuites([suite], { cwd, env: childEnv() }), 0)
  } finally {
    process.stdout.write = originalWrite
    console.log = originalLog
  }
  const texts = events.map((event) => event.text)
  const title = texts.findIndex((text) => text.includes('=== plain ==='))
  const child = texts.findIndex((text) => text.includes('default channel line'))
  const summary = texts.findIndex((text) => text.includes('plain=PASS'))
  assert.ok(title >= 0, '缺省通道应打出套件标题')
  assert.ok(child > title, '子进程输出应排在套件标题之后')
  assert.ok(summary > child, '汇总行应排在子进程输出之后')
})

for (const name of ['provenance', 'acceptance', 'runtime', 'layout']) {
  test(name + ' 的独立入口执行并报告完成', () => {
    const suite = suiteFor(name)
    const result = run(suite.command.split(' ').slice(1))
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, suite.completion)
  })
}
