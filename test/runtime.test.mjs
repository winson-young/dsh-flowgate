import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { clientFactoryRevision, runtimeState, moduleSourceRevision, HOST_MODULES, hostState, clientState, describeRuntime, runtimeFields, packageVersion, CLIENT_REPORT_TTL } from '../lib/runtime.js'
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

// G38：宿主层只看模块指纹。client.js 的 factory 标记损坏属于页面层，不能把宿主层拖成 unverified。
check('宿主层只按模块指纹判定，页面侧问题不拖累它', () => {
  assert.equal(hostState({ hostRevision: a, diskHostRevision: a, stale: [] }).status, 'verified')
  assert.equal(hostState({ hostRevision: a, diskHostRevision: b }).status, 'mismatch')
  assert.equal(hostState({ hostRevision: a, diskHostRevision: a, stale: ['client.js'] }).status, 'mismatch')
  assert.equal(hostState({ hostRevision: '', diskHostRevision: '' }).status, 'unverified')
  assert.equal(hostState({}).status, 'unverified')
})

// absent 是「没参与」，unverified 是「参与了但读不懂」；压成同一个值就再也分不出来。
check('页面层四态可区分：已核对、不一致、未参与、读不懂', () => {
  assert.equal(clientState({ clientRevision: a, reportedAt: 1000 }, a, 2000).status, 'verified')
  assert.equal(clientState({ clientRevision: b, reportedAt: 1000 }, a, 2000).status, 'mismatch')
  assert.equal(clientState(null, a, 2000).status, 'absent')
  assert.equal(clientState({ clientRevision: a, reportedAt: 1000 }, a, 1000 + 30001).status, 'absent')
  assert.equal(clientState({ rejected: true, reason: '指纹不是 64 位十六进制' }, a, 2000).status, 'unverified')
  assert.equal(clientState({ clientRevision: a, reportedAt: 1000 }, '', 2000).status, 'unverified')
  assert.notEqual(clientState(null, a, 2000).status, clientState({ rejected: true }, a, 2000).status)
  // 两种 unverified 的来源必须能靠文案分开：一个是「页面没跑插件」，一个是「跑的是另一份代码」。
  const noExpect = clientState({ clientRevision: a, reportedAt: 1000 }, '', 2000)
  const rejected = clientState({ rejected: true, reason: '指纹不是 64 位十六进制' }, a, 2000)
  assert.equal(noExpect.status, rejected.status)
  assert.notEqual(noExpect.reason, rejected.reason)
  // AC-2：文案必须点出「页面源码标记缺失」——只断言 status 时，reason 写成任意字符串照样全绿。
  assert.match(noExpect.reason, /页面源码标记缺失/)
  // 端到端：factory 标记损坏时页面仍会带 pageId/viewport 上报却没有指纹可报，这条记录不得被念成「上报被拒」。
  const noMark = clientState({ reported: true, pageId: 'de54a6e1-b162-42c9-910a-470575847521', reportedAt: 1000 }, '', 2000)
  assert.equal(noMark.status, 'unverified')
  assert.match(noMark.reason, /页面源码标记缺失/)
  assert.doesNotMatch(noMark.reason, /上报被拒/)
  // 期望读不到时即使带 rejected 记录，也要先说标记缺失——根因在构建标记，不在上报参数。
  // 上报被拒这件事不能塞进 reason 拼串（一半结构化一半拼串，下游只能正则捞），改走结构化字段。
  const both = clientState({ rejected: true, reason: '指纹不是 64 位十六进制' }, '', 2000)
  assert.match(both.reason, /页面源码标记缺失/)
  assert.equal(both.rejectedReason, '指纹不是 64 位十六进制')
  assert.doesNotMatch(both.reason, /上报被拒/)
  // 「参与了但没指纹」与「没参与」不能同值：absent 说明页面这一侧压根没动静。
  assert.notEqual(noMark.status, clientState(null, a, 2000).status)
})

// AC-5：过期既不是「参与过」也不是「参与出问题」——它是页面那一侧的上报失效，宿主层结论不受影响。
check('上报过期归 absent 且文案写明过期，宿主层判定不受影响', () => {
  const detected = { hostRevision: a, diskHostRevision: a, stale: [] }
  const fresh = clientState({ clientRevision: a, reportedAt: 1000 }, a, 1000 + CLIENT_REPORT_TTL)
  const expired = clientState({ clientRevision: a, reportedAt: 1000 }, a, 1000 + CLIENT_REPORT_TTL + 1)
  assert.equal(fresh.status, 'verified')
  assert.equal(expired.status, 'absent')
  assert.match(expired.reason, /过期/)
  assert.equal(hostState(detected).status, 'verified')
})

// AC-3：被拒与没指纹的记录同样会过期——否则页面关掉之后 clientStatus 永远钉在 unverified。
check('被拒或没指纹的旧上报同样会过期，过期后一律 absent', () => {
  const late = 1000 + CLIENT_REPORT_TTL + 1
  const rejectedLate = clientState({ rejected: true, reason: '指纹不是 64 位十六进制', reportedAt: 1000 }, a, late)
  const reportedLate = clientState({ reported: true, pageId: 'de54a6e1-b162-42c9-910a-470575847521', reportedAt: 1000 }, a, late)
  assert.equal(rejectedLate.status, 'absent')
  assert.equal(reportedLate.status, 'absent')
  assert.equal(rejectedLate.expired, true)
  assert.equal(reportedLate.expired, true)
  // 过期了也要留着「当初为什么被拒」，否则事后查不到原因。
  assert.match(rejectedLate.reason, /过期/)
  assert.match(reportedLate.reason, /过期/)
  // 诊断必须是结构化字段：从文案里正则捞原因，改一次文案就断一次（本轮刚把 reason.includes('过期') 换掉）。
  assert.equal(rejectedLate.rejectedReason, '指纹不是 64 位十六进制')
  assert.equal(reportedLate.rejectedReason, '')
  assert.equal(reportedLate.reportedWithoutRevision, true)
  assert.equal(rejectedLate.reportedWithoutRevision, false)
  // 过期时 describeRuntime 仍要把当初的原因念出来，且来源是结构化字段而不是拼在 reason 里。
  const expiredLine = describeRuntime({ version: '0.1.5', runtimeStatus: 'verified', moduleRevision: a, diskModuleRevision: a, clientStatus: 'absent', clientExpired: true, clientRejectedReason: rejectedLate.rejectedReason })
  assert.match(expiredLine, /client 上次上报已过期（30 秒内无刷新）\uff1b上次记录被拒（指纹不是 64 位十六进制）/)
  // 没过期时仍然照旧区分：被拒不是没参与。
  assert.equal(clientState({ rejected: true, reason: '指纹不是 64 位十六进制', reportedAt: 1000 }, a, 2000).status, 'unverified')
})

// AC-1 / AC-7：版本字段只在一处产出，对外名与内部别名必须同时给对。
check('运行版本字段统一由 runtimeFields 产出，对外名与内部别名一致', () => {
  const host = { hostRevision: a, diskHostRevision: a, stale: [], status: 'verified' }
  const client = { status: 'verified', clientRevision: a, expectedClientRevision: a, reason: '', expired: false }
  const fields = runtimeFields('0.1.5', host, client)
  assert.equal(fields.version, '0.1.5')
  assert.equal(fields.moduleRevision, a)
  assert.equal(fields.diskModuleRevision, a)
  assert.equal(fields.hostRevision, a)
  assert.equal(fields.diskHostRevision, a)
  assert.equal(fields.runtimeStatus, 'verified')
  assert.equal(fields.clientStatus, 'verified')
  assert.deepEqual(fields.staleModules, [])
  assert.equal(fields.clientExpired, false)
  // 读不懂的指纹与空模块名一律不许流到文案里。
  const broken = runtimeFields('0.1.5', { hostRevision: 'zzz', diskHostRevision: a, stale: ['acceptance.js', ''], status: 'mismatch' }, { status: 'absent' })
  assert.equal(broken.moduleRevision, '')
  assert.equal(broken.clientRevision, '')
  assert.deepEqual(broken.staleModules, ['acceptance.js'])
})

check('运行版本首行含版本号与两侧指纹，不一致时念出未盖章模块', () => {
  const ok = describeRuntime({ version: '0.1.5', runtimeStatus: 'verified', moduleRevision: a, diskModuleRevision: a, clientStatus: 'verified', clientRevision: a })
  assert.equal(ok, '运行版本：0.1.5 / host ' + a.slice(0, 8) + '（与磁盘一致） / client ' + a.slice(0, 8) + '（已核对）')
  const bad = describeRuntime({ version: '0.1.5', runtimeStatus: 'mismatch', moduleRevision: a, diskModuleRevision: b, staleModules: ['acceptance.js'] })
  assert.match(bad, /加载的是旧模块，验证结论不可用/)
  assert.match(bad, /未重新盖章的模块：acceptance\.js/)
  const absent = describeRuntime({ version: '0.1.5', runtimeStatus: 'verified', moduleRevision: a, diskModuleRevision: a, clientStatus: 'absent' })
  assert.match(absent, /client 未参与（本次没有页面轮询，宿主层已核对）/)
  // AC-6：宿主读不到指纹时首行必须写「无法核对」，这一支写错了测试不会失败。
  const unknown = describeRuntime({ version: '0.1.5', runtimeStatus: 'unverified', moduleRevision: '', diskModuleRevision: '' })
  assert.match(unknown, /host 无法核对（模块未登记或源码缺失，验证结论不可用）/)
})

check('插件版本号来自 package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(packageVersion(), pkg.version)
  assert.match(packageVersion(), /^\d+\.\d+\.\d+$/)
})
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
