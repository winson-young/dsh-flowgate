import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { HOST_MODULES } from '../lib/runtime.js'
import { runSuites, suites } from '../scripts/run-tests.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const exec = promisify(execFile)
const options = { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 90000 }
const suiteFor = (name) => suites.find((entry) => entry.name === name)

function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { ...options, env })
  assert.ifError(result.error)
  return result
}

function capture(callback) {
  const messages = []
  const original = console.log
  try {
    console.log = (message) => messages.push(message)
    return { status: callback(), output: messages.join(String.fromCharCode(10)) }
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
  for (const file of ['scripts/run-tests.mjs', 'scripts/stamp-revisions.mjs', ...HOST_MODULES.map((name) => 'lib/' + name)]) {
    copyFileSync(join(root, file), join(cwd, file))
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const fixtureSuites = [
    ['provenance', 'test:provenance', '# tests 1'],
    ['acceptance', 'test:acceptance', '# tests 1'],
    ['runtime', 'test:runtime', 'Runtime: 1 checks passed'],
    ['host', 'test:host', '通过：1 项'],
    ['gatemode', 'test:gatemode', '全部通过：1 项'],
    ['subagents', 'test:subagents', '# tests 1'],
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
      result = spawnSync(process.execPath, args, { ...options, cwd, stdio: ['ignore', fd, fd] })
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
  const mixed = capture(() => runSuites([failure, early, skip, missing, later], { cwd }))
  assert.equal(mixed.status, 1)
  assert.match(mixed.output, /first=FAIL .*退出码 7/)
  assert.match(mixed.output, /early=NOT_RUN .*缺少完成记录/)
  assert.match(mixed.output, /skip=SKIP .*Git missing/)
  assert.match(mixed.output, /missing=NOT_RUN .*test:missing/)
  assert.match(mixed.output, /later=PASS/)
  assert.equal(capture(() => runSuites([skip, later], { cwd })).status, 0)
  assert.equal(capture(() => runSuites([early], { cwd })).status, 1)
})

test('缺少有效跳过原因时判为失败', (t) => {
  const cwd = temp(t)
  const command = 'node invalid.mjs'
  for (const payload of ['', '{', '{}', 'null', '{"reason":" "}', '{"reason":1}']) {
    const marker = 'FLOWGATE_TEST_SKIP' + (payload ? ' ' + payload : '')
    writeFileSync(join(cwd, 'invalid.mjs'), 'console.log(' + JSON.stringify(marker) + '); console.log("complete")')
    const result = capture(() => runSuites([{ name: 'invalid', command, completion: /^complete$/m }], { cwd }))
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
  const suite = { ...suiteFor('provenance'), name: 'nested', command: 'node --test --test-reporter=tap nested.mjs' }
  const result = capture(() => runSuites([suite], { cwd }))
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

test('没有 Git 时宿主退出 0，汇总标记 SKIP 并显示原因', (t) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
  env.PATH = temp(t)
  const result = capture(() => runSuites([suiteFor('host')], { env }))
  assert.equal(result.status, 0)
  assert.match(result.output, /host=SKIP .*Git 不可用（ENOENT）/)
})

test('两个集成进程各用独立临时目录并清理', async () => {
  const outputs = await Promise.all([
    exec(process.execPath, ['test/integration.test.mjs'], options),
    exec(process.execPath, ['test/integration.test.mjs'], options),
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

for (const name of ['provenance', 'acceptance', 'runtime', 'layout']) {
  test(name + ' 的独立入口执行并报告完成', () => {
    const suite = suiteFor(name)
    const result = run(suite.command.split(' ').slice(1))
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, suite.completion)
  })
}
