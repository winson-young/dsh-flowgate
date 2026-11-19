import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { clientFactoryRevision, runtimeState, moduleSourceRevision, HOST_MODULES } from '../lib/runtime.js'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let passed = 0
const check = (name, run) => { run(); passed += 1; console.log('✓ ' + name) }
const hash = (text) => createHash('sha256').update(text).digest('hex')
const factory = 'function flowgateFactory(require) {\n  return require(\'react\')\n}'
const source = '/* flowgate-factory:start */\n' + factory + '\n/* flowgate-factory:end */'
const a = hash('a'), b = hash('b')
const revisions = { hostRevision: a, diskHostRevision: a, expectedClientRevision: b }
check('页面工厂的真实内容生成 SHA256', () => assert.equal(clientFactoryRevision(source), hash(factory)))
check('CRLF 与 LF 的工厂源码等价', () => assert.equal(clientFactoryRevision(source.replaceAll('\n', '\r\n')), hash(factory)))
check('同一构建标签下内容变化仍可识别', () => assert.notEqual(clientFactoryRevision(source.replace('return require', 'return 1 || require')), hash(factory)))
check('旧模块或重复标记不能生成有效页面指纹', () => { assert.equal(clientFactoryRevision(factory), ''); assert.equal(clientFactoryRevision(source + source), '') })
check('宿主和页面都匹配才是已核对', () => assert.equal(runtimeState(b, revisions).status, 'verified'))
check('宿主源码改变但未重载时不能宣布生效', () => assert.equal(runtimeState(b, { ...revisions, diskHostRevision: b }).status, 'mismatch'))
check('旧页面即使宿主匹配也必须标记不一致', () => assert.equal(runtimeState(a, revisions).status, 'mismatch'))
check('未上报或非法指纹均为未核对', () => { assert.equal(runtimeState('', revisions).status, 'unverified'); assert.equal(runtimeState('same-version', revisions).status, 'unverified') })
check('读盘失败不能复用相同的空指纹宣布生效', () => assert.equal(runtimeState('', { hostRevision: '', diskHostRevision: '', expectedClientRevision: '' }).status, 'unverified'))

const literal = "export const FLOWGATE_MODULE_REVISION = '" + '0'.repeat(64) + "'"
check('模块标记排除自身且换行标准化', () => {
  const one = literal + '\nexport const value = 1\n'
  assert.equal(moduleSourceRevision(one), moduleSourceRevision(one.replaceAll('\n', '\r\n')))
  assert.equal(moduleSourceRevision(one), moduleSourceRevision(one.replace('0'.repeat(64), 'a'.repeat(64))))
  assert.notEqual(moduleSourceRevision(one), moduleSourceRevision(one.replace('value = 1', 'value = 2')))
  assert.equal(moduleSourceRevision('export const value = 1'), '')
  assert.equal(moduleSourceRevision(one + '\n' + literal), '')
})

const repo = fileURLToPath(new URL('../', import.meta.url))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowgate-runtime-'))
  try {
    mkdirSync(join(root, 'lib'))
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    for (const name of [...HOST_MODULES, 'client.js']) copyFileSync(join(repo, 'lib', name), join(root, 'lib', name))
    copyFileSync(join(repo, 'scripts', 'stamp-revisions.mjs'), join(root, 'scripts', 'stamp-revisions.mjs'))
    execFileSync(process.execPath, [join(root, 'scripts', 'stamp-revisions.mjs')], { stdio: 'inherit' })
    return root
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
function coldCheck(name, body) {
  const root = fixture()
  try {
    const prelude = [
      "import assert from 'node:assert/strict'",
      "import { readFileSync, writeFileSync } from 'node:fs'",
      "import { execFileSync } from 'node:child_process'",
      "import { join } from 'node:path'",
      "import { pathToFileURL } from 'node:url'",
      'const root = ' + JSON.stringify(root),
      "const path = (name) => join(root, 'lib', name)",
      "const url = (name) => pathToFileURL(path(name)).href",
      "const stamp = () => execFileSync(process.execPath, [join(root, 'scripts', 'stamp-revisions.mjs')], { stdio: 'inherit' })",
      "const state = async () => { const mod = await import(url('runtime.js')); return mod.runtimeState(mod.clientFactoryRevision(readFileSync(path('client.js'), 'utf8'))) }",
    ].join('\n')
    execFileSync(process.execPath, ['--input-type=module', '-e', prelude + '\n' + body], { stdio: 'inherit' })
    passed += 1
    console.log('✓ ' + name)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

coldCheck('完整冷加载的模块常量与磁盘一致才通过', String.raw`
  await import(url('index.js'))
  assert.equal((await state()).status, 'verified')
`
)
coldCheck('先加载旧依赖再修改磁盘并加载主模块不能误认证', String.raw`
  await import(url('acceptance.js'))
  const before = readFileSync(path('acceptance.js'), 'utf8')
  writeFileSync(path('acceptance.js'), before + '\n// modified dependency\n')
  stamp()
  await import(url('index.js'))
  assert.equal((await state()).status, 'mismatch')
`
)
coldCheck('旧缓存依赖即使主模块重复加载也不能冒充新版本', String.raw`
  await import(url('index.js'))
  const before = readFileSync(path('acceptance.js'), 'utf8')
  writeFileSync(path('acceptance.js'), before + '\n// changed with cached consumer\n')
  stamp()
  await import(url('index.js') + '?reload=1')
  assert.equal((await state()).status, 'mismatch')
`
)
coldCheck('重新加载新主模块后磁盘回滚的ABA不能认证', String.raw`
  await import(url('index.js'))
  const before = readFileSync(path('index.js'), 'utf8')
  writeFileSync(path('index.js'), before + '\n// hot-loaded main\n')
  stamp()
  await import(url('index.js') + '?reload=2')
  writeFileSync(path('index.js'), before)
  assert.equal((await state()).status, 'mismatch')
`
)
coldCheck('未更新模块标记或缺少模块登记均不认证', String.raw`
  await import(url('index.js'))
  const before = readFileSync(path('acceptance.js'), 'utf8')
  writeFileSync(path('acceptance.js'), before + '\n// unstamped edit\n')
  assert.equal((await state()).status, 'mismatch')
  writeFileSync(path('acceptance.js'), before.replace(/^export const FLOWGATE_MODULE_REVISION.*$/m, ''))
  assert.equal((await state()).status, 'unverified')
`
)
coldCheck('只加载runtime的进程不能将缺失登记认证', String.raw`
  assert.equal((await state()).status, 'unverified')
`
)

check('--check只读且修改源码后返回非零', () => {
  const root = fixture()
  try {
    const script = join(root, 'scripts', 'stamp-revisions.mjs')
    const command = (args) => spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' })
    assert.equal(command(['--check']).status, 0)
    const target = join(root, 'lib', 'acceptance.js')
    const stale = readFileSync(target, 'utf8') + '\n// check must not mutate\n'
    writeFileSync(target, stale)
    assert.equal(command(['--check']).status, 1)
    assert.equal(readFileSync(target, 'utf8'), stale)
    assert.equal(command(['--unknown']).status, 2)
    assert.equal(readFileSync(target, 'utf8'), stale)
    assert.equal(command([]).status, 0)
    assert.equal(command(['--check']).status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
check('stamp只更新字面量并保留CRLF与LF原始字节', () => {
  const root = fixture()
  try {
    const script = join(root, 'scripts', 'stamp-revisions.mjs')
    const target = join(root, 'lib', 'acceptance.js')
    const original = readFileSync(target, 'utf8').replace(/\r\n?/g, '\n')
    const masked = (value) => value.replace(/^export const FLOWGATE_MODULE_REVISION = '[a-f0-9]{64}'$/gm, 'REVISION')
    for (const newline of ['\r\n', '\n']) {
      const stale = (original + '\n// preserve exact source bytes\n').replaceAll('\n', newline)
      writeFileSync(target, stale)
      execFileSync(process.execPath, [script], { stdio: 'inherit' })
      const stamped = readFileSync(target, 'utf8')
      assert.equal(masked(stamped), masked(stale))
      assert.equal(spawnSync(process.execPath, [script, '--check'], { stdio: 'inherit' }).status, 0)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
console.log('\nRuntime: ' + passed + ' checks passed')
