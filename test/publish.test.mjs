import assert from 'node:assert/strict'
import { captureSync } from '../scripts/capture-child.mjs'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { suites } from '../scripts/run-tests.mjs'
import {
  compareVersions,
  evaluateVersionGate,
  formatTimestamp,
  listVersions,
  maxExistingVersion,
  parsePackageFileName,
  parseVersion,
  sha256File,
  stampedFileName,
  uniqueFileName,
} from '../scripts/publish-gate.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const packageName = 'dsh-flowgate'

function temp(t, prefix = 'flowgate-publish-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// npm 打包前要往自己的 cache 目录写日志。受限沙箱把 %LOCALAPPDATA% 的默认位置
// 判成不可写，npm 于是直接退出 1（"Log files were not written"），打包本身没跑。
// 夹具因此给它一个临时目录当 cache：测的是 publish.mjs，不是宿主 ACL。
const npmCache = mkdtempSync(join(tmpdir(), 'flowgate-npm-cache-'))
after(() => rmSync(npmCache, { recursive: true, force: true }))

function publish(args, env) {
  // 捕获走 captureSync：受限沙箱拒绝管道 stdio（spawn EPERM），文件描述符不拒绝。
  return captureSync(process.execPath, ['scripts/publish.mjs', ...args], {
    cwd: root,
    windowsHide: true,
    timeout: 300000,
    env: { ...process.env, npm_config_cache: npmCache, ...env },
  })
}

// ---- 版本解析与比较 ----------------------------------------------------

test('版本解析认三段数值与 prerelease，其余一律不认', () => {
  assert.deepEqual(parseVersion('0.1.7'), { nums: [0, 1, 7], pre: [] })
  assert.deepEqual(parseVersion(' 0.1.7 '), { nums: [0, 1, 7], pre: [] })
  assert.deepEqual(parseVersion('1.2.3-rc.1'), { nums: [1, 2, 3], pre: ['rc', '1'] })
  for (const bad of ['', '0.1', '0.1.7.8', 'v0.1.7', 'x.y.z', null, undefined]) {
    assert.equal(parseVersion(bad), null, String(bad))
  }
})

test('版本比较按数值而非字典序，prerelease 小于同号正式版', () => {
  assert.equal(compareVersions('0.1.7', '0.1.6'), 1)
  assert.equal(compareVersions('0.1.6', '0.1.7'), -1)
  assert.equal(compareVersions('0.1.6', '0.1.6'), 0)
  // 字典序会把 0.1.10 判成小于 0.1.9，这正是「版本升了却仍被覆盖」的来源。
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1)
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1)
  assert.equal(compareVersions('bad', '0.1.6'), null)
})

// ---- 包名解析 ----------------------------------------------------------

test('包名解析同时认旧式与带时间戳两种命名', () => {
  assert.deepEqual(parsePackageFileName('dsh-flowgate-0.1.6.tgz', packageName),
    { version: '0.1.6', stamped: false, seq: 0 })
  assert.deepEqual(parsePackageFileName('dsh-flowgate-0.1.7-20261126T1000.tgz', packageName),
    { version: '0.1.7', stamped: true, seq: 0 })
  assert.deepEqual(parsePackageFileName('dsh-flowgate-0.1.7-20261126T1000-2.tgz', packageName),
    { version: '0.1.7', stamped: true, seq: 2 })
  assert.deepEqual(parsePackageFileName('dsh-flowgate-1.0.0-rc.1-20261126T1000.tgz', packageName),
    { version: '1.0.0-rc.1', stamped: true, seq: 0 })
  for (const bad of ['other-pkg-0.1.6.tgz', 'dsh-flowgate-0.1.6.zip', 'dsh-flowgate.tgz', 'dsh-flowgate-notes.tgz', 'dsh-flowgate-0.1.6.tgz.bak']) {
    assert.equal(parsePackageFileName(bad, packageName), null, bad)
  }
})

test('scoped 包名按 npm pack 的写法识别，闸门不会永远判首发', () => {
  // npm pack 把 @scope/pkg 写成 scope-pkg-<version>.tgz。只认 pkg.name 原文的话，
  // scoped 仓库里一个已有包都匹配不上，闸门永远判首发放行——版本递增检查等于不存在。
  assert.deepEqual(parsePackageFileName('scope-pkg-0.1.6.tgz', '@scope/pkg'),
    { version: '0.1.6', stamped: false, seq: 0 })
  assert.deepEqual(parsePackageFileName('scope-pkg-0.1.7-20261126T1000.tgz', '@scope/pkg'),
    { version: '0.1.7', stamped: true, seq: 0 })
  assert.deepEqual(parsePackageFileName('@scope/pkg-0.1.6.tgz', '@scope/pkg'),
    { version: '0.1.6', stamped: false, seq: 0 })
  assert.equal(parsePackageFileName('other-pkg-0.1.6.tgz', '@scope/pkg'), null)
  // 空包名不该匹配任何文件：否则 '-0.1.6.tgz' 这种名字会被当成自家的包。
  assert.equal(parsePackageFileName('-0.1.6.tgz', ''), null)
  assert.equal(parsePackageFileName('dsh-flowgate-0.1.6.tgz', ''), null)
})

test('发布目录里的最大版本从文件名解析，不看修改时间', () => {
  const names = [
    'dsh-flowgate-0.1.6.tgz',
    'dsh-flowgate-0.1.10-20261125T0900.tgz',
    'dsh-flowgate-0.1.9.tgz',
    'notes.txt',
    'other-9.9.9.tgz',
  ]
  assert.equal(listVersions(names, packageName).length, 3)
  assert.deepEqual(maxExistingVersion(names, packageName),
    { version: '0.1.10', fileName: 'dsh-flowgate-0.1.10-20261125T0900.tgz' })
  assert.equal(maxExistingVersion(['notes.txt'], packageName), null)
  assert.equal(maxExistingVersion([], packageName), null)
})

// ---- 版本闸门 ----------------------------------------------------------

test('首次发布放行，版本递增放行', () => {
  assert.equal(evaluateVersionGate({ version: '0.1.7', packageName, fileNames: [] }).code, 'first-release')
  const bumped = evaluateVersionGate({
    version: '0.1.7', packageName, fileNames: ['dsh-flowgate-0.1.6.tgz'],
  })
  assert.equal(bumped.ok, true)
  assert.equal(bumped.code, 'bumped')
  assert.equal(bumped.maxVersion, '0.1.6')
})

test('版本未递增时中止，并报出已有最大版本', () => {
  for (const version of ['0.1.6', '0.1.5']) {
    const gate = evaluateVersionGate({ version, packageName, fileNames: ['dsh-flowgate-0.1.6.tgz'] })
    assert.equal(gate.ok, false, version)
    assert.equal(gate.code, 'not-bumped')
    assert.equal(gate.maxVersion, '0.1.6')
    assert.match(gate.message, /版本未递增/)
    assert.match(gate.message, /0\.1\.6/)
    assert.match(gate.message, /--force/)
  }
  // 带时间戳的旧包同样计入最大版本，否则「上次已用时间戳发过」会漏判。
  const stamped = evaluateVersionGate({
    version: '0.1.7', packageName, fileNames: ['dsh-flowgate-0.1.7-20261126T1000.tgz'],
  })
  assert.equal(stamped.ok, false)
  assert.equal(stamped.code, 'not-bumped')
})

test('--force 放行同一版本并留下记录，非法版本一律中止', () => {
  const forced = evaluateVersionGate({
    version: '0.1.6', packageName, fileNames: ['dsh-flowgate-0.1.6.tgz'], force: true,
  })
  assert.equal(forced.ok, true)
  assert.equal(forced.code, 'forced')
  assert.equal(forced.sameCount, 1)
  // 版本相等是「重发」，不是「降级」。两种情况都靠 --force 放行，但后果完全不同：
  // 降级会让 profile 指向一个更旧的包，文案必须分开。
  assert.equal(forced.downgrade, false)
  const downgraded = evaluateVersionGate({
    version: '0.1.5', packageName, fileNames: ['dsh-flowgate-0.1.6.tgz'], force: true,
  })
  assert.equal(downgraded.ok, true)
  assert.equal(downgraded.code, 'forced')
  assert.equal(downgraded.downgrade, true)
  assert.match(downgraded.message, /更旧的包/)
  assert.match(downgraded.message, /0\.1\.5 比发布目录里的最大版本 0\.1\.6 更低/)
  const invalid = evaluateVersionGate({ version: 'v0.1.6', packageName, fileNames: [] })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'invalid-version')
  assert.equal(invalid.maxVersion, null)
})

// ---- 时间戳命名 --------------------------------------------------------

test('时间戳精确到分钟，重复加戳不叠加', () => {
  const date = new Date(2026, 10, 26, 10, 0, 0)
  assert.equal(formatTimestamp(date), '20261126T1000')
  assert.equal(formatTimestamp(new Date(2026, 0, 2, 3, 4, 0)), '20260102T0304')
  assert.equal(stampedFileName('dsh-flowgate-0.1.7.tgz', date), 'dsh-flowgate-0.1.7-20261126T1000.tgz')
  assert.equal(
    stampedFileName('dsh-flowgate-0.1.7-20261126T1000.tgz', date),
    'dsh-flowgate-0.1.7-20261126T1000.tgz',
  )
  assert.equal(
    stampedFileName('dsh-flowgate-0.1.7-20261125T0900-2.tgz', date),
    'dsh-flowgate-0.1.7-20261126T1000.tgz',
  )
})

test('版本号自带时间戳形 prerelease 时，不把它当成上一轮加的时间戳剥掉', () => {
  const date = new Date(2026, 10, 26, 10, 0, 0)
  // 1.0.0-20261126T1000 里那串时间戳是版本的一部分，不是上一个发布加的。
  // 剥掉会让包名与 package.json 的 version 对不上号，而闸门正是按文件名解析版本的。
  assert.equal(
    stampedFileName('dsh-flowgate-1.0.0-20261126T1000.tgz', date, '1.0.0-20261126T1000'),
    'dsh-flowgate-1.0.0-20261126T1000-20261126T1000.tgz',
  )
  // 普通版本照旧剥掉上一轮的时间戳，不叠加。
  assert.equal(
    stampedFileName('dsh-flowgate-0.1.7-20261125T0900.tgz', date, '0.1.7'),
    'dsh-flowgate-0.1.7-20261126T1000.tgz',
  )
  // 不知道版本时保持旧行为：一律剥掉末尾的时间戳。
  assert.equal(
    stampedFileName('dsh-flowgate-0.1.7-20261125T0900.tgz', date),
    'dsh-flowgate-0.1.7-20261126T1000.tgz',
  )
})

test('同一分钟重复发布时追加序号，不覆盖旧包', () => {
  const taken = new Set(['a-20261126T1000.tgz', 'a-20261126T1000-2.tgz'])
  assert.equal(uniqueFileName('b-20261126T1000.tgz', (n) => taken.has(n)), 'b-20261126T1000.tgz')
  assert.equal(uniqueFileName('a-20261126T1000.tgz', (n) => taken.has(n)), 'a-20261126T1000-3.tgz')
  // 序号用尽时必须抛错，不能悄悄复用名字：静默复用等于覆盖掉唯一的回退路径，
  // 调用方却拿到一个「成功」的返回值，什么都不会察觉。
  assert.throws(
    () => uniqueFileName('a-20261126T1000.tgz', () => true),
    /同名包过多/,
  )
})

// ---- 端到端：真的跑一遍 scripts/publish.mjs -----------------------------

/** 造一个发布目录 + profile，profile 里预先写着旧包路径。 */
function fixture(t) {
  const pkgDir = temp(t, 'flowgate-pkg-')
  const profileDir = temp(t, 'flowgate-profile-')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const existing = 'dsh-flowgate-' + manifest.version + '.tgz'
  writeFileSync(join(pkgDir, existing), 'stale package placeholder')
  const profileJson = join(profileDir, 'package.json')
  writeFileSync(profileJson, JSON.stringify({
    dependencies: { 'dsh-flowgate': 'file:D:/Plugins/flowgate-pkg/dsh-flowgate-0.1.5.tgz' },
    dsh: { profile: { bundles: ['dsh-flowgate'] } },
  }, null, 2) + '\n')
  return { pkgDir, profileDir, profileJson, manifest, existing }
}

test('版本未递增时退出码非 0、不打包、不改 profile', (t) => {
  const { pkgDir, profileDir, profileJson, existing } = fixture(t)
  const before = readFileSync(profileJson, 'utf8')
  const result = publish(['--skip-test'], { FLOWGATE_PKG_DIR: pkgDir, FLOWGATE_PROFILE_DIR: profileDir })
  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stderr, /版本未递增/)
  assert.match(result.stderr, new RegExp(existing.replace(/\./g, '\\.')))
  // 只留下原来那个占位包，没有生成任何新 tgz。
  assert.deepEqual(readdirSync(pkgDir), [existing])
  // profile 一个字都没动。
  assert.equal(readFileSync(profileJson, 'utf8'), before)
  // 闸门在自测之前，所以根本不会跑到打包那一步。
  assert.doesNotMatch(result.stdout, /打包到发布目录/)
})

test('--skip-test 跳不过版本闸门', (t) => {
  const { pkgDir, profileDir, existing } = fixture(t)
  const gated = publish(['--skip-test'], { FLOWGATE_PKG_DIR: pkgDir, FLOWGATE_PROFILE_DIR: profileDir })
  // 精确到 1：闸门判定中止才走 process.exit(1)。只写「非 0」的话，脚本打印完 [1/4]
  // 之后因为任何原因炸掉（甚至 status 为 null）都能混过去，分不清是谁拦下的。
  assert.equal(gated.status, 1, gated.stderr)
  assert.match(gated.stdout, /\[1\/4\] 版本闸门/)
  // 中止的判据必须是闸门自己给的那句话，不是随便一条错误。
  assert.match(gated.stderr, /版本未递增，已中止发布/)
  assert.ok(gated.stderr.includes(existing), gated.stderr)
  // 闸门判定失败时后面三步连日志都不该出现——包括 --skip-test 的 [2/4]。
  assert.doesNotMatch(gated.stdout, /\[2\/4\]/)
  assert.doesNotMatch(gated.stdout, /\[3\/4\]/)
  assert.doesNotMatch(gated.stdout, /\[4\/4\]/)
})

test('--force 放行同一版本：文件名带时间戳、打印指纹、profile 指向新包', (t) => {
  const { pkgDir, profileDir, profileJson, manifest, existing } = fixture(t)
  const result = publish(['--skip-test', '--force'], {
    FLOWGATE_PKG_DIR: pkgDir, FLOWGATE_PROFILE_DIR: profileDir,
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  // 放行文案必须是闸门自己给出的那一句。只匹配 /--force/ 不够：收尾提示
  // 「确需重发同一版本时加 --force。」本身就含这个词，把闸门的打印删掉也照样能过。
  const escaped = manifest.version.replace(/\./g, '\\.')
  assert.match(
    result.stdout,
    new RegExp('--force：跳过版本递增检查（package\\.json ' + escaped + '，已有最大版本 ' + escaped + '），仍然继续。'),
  )
  // 同版本重发必须把「已有几个同名包」说清楚，否则用户以为旧包被替换了。
  assert.match(result.stdout, new RegExp('发布目录里已有 1 个 ' + escaped + ' 的包'))

  const stamped = readdirSync(pkgDir).filter((name) => name !== existing)
  assert.equal(stamped.length, 1, readdirSync(pkgDir).join(', '))
  const [name] = stamped
  // dsh-flowgate-<version>-<YYYYMMDDTHHMM>.tgz，时间戳精确到分钟。
  assert.match(name, new RegExp('^dsh-flowgate-' + manifest.version.replace(/\./g, '\\.') + '-\\d{8}T\\d{4}\\.tgz$'))
  // 旧包原样留着，这是唯一的回退路径。
  assert.ok(existsSync(join(pkgDir, existing)))

  // 指纹：打印绝对路径与 64 位十六进制摘要，而且这个摘要必须真的等于这个包的 sha256。
  // 只断言「输出里有个 64 位十六进制串」是不够的——把摘要换成别的常量照样能过，
  // 而用户拿去和别处核对的正是这个数。
  assert.match(result.stdout, /本次包指纹/)
  const digest = result.stdout.match(/sha256 ([0-9a-f]{64})/)
  assert.ok(digest, result.stdout)
  assert.equal(digest[1], sha256File(join(pkgDir, name)))
  assert.ok(result.stdout.includes(name), result.stdout)
  // 指纹只供人工核对。脚本不得据此宣称「和上一个包一样」或「代码没有变化」——
  // 它根本没读上一个包，任何这类结论都是编的。
  assert.doesNotMatch(result.stdout, /与上一个包相同/)
  assert.doesNotMatch(result.stdout, /代码没有变化/)
  assert.doesNotMatch(result.stdout, /没有代码变化/)

  const profile = JSON.parse(readFileSync(profileJson, 'utf8'))
  const spec = profile.dependencies['dsh-flowgate']
  assert.match(spec, /^file:.*dsh-flowgate-\d+\.\d+\.\d+-\d{8}T\d{4}\.tgz$/)
  assert.ok(spec.includes(name), spec)
  // 其余键原样保留。
  assert.deepEqual(profile.dsh.profile.bundles, ['dsh-flowgate'])
})

test('发布目录指向普通文件时显式报错，不甩 ENOTDIR 裸栈', (t) => {
  const notADir = join(temp(t, 'flowgate-notdir-'), 'pkg-dir-is-a-file')
  writeFileSync(notADir, 'not a directory')
  const result = publish(['--skip-test'], {
    FLOWGATE_PKG_DIR: notADir, FLOWGATE_PROFILE_DIR: temp(t, 'flowgate-profile-'),
  })
  // 恰好 1：这是脚本自己判定的中止，不是半路崩掉。
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /读不了发布目录/)
  assert.ok(result.stderr.includes(notADir), result.stderr)
  // 用户要看的是「哪个目录读不了」，不是 Node 的内部调用栈。
  assert.doesNotMatch(result.stderr, /\n\s+at /)
})

test('--no-profile：包照打、profile 一字未动，也不叫人去 pnpm install', (t) => {
  const { pkgDir, profileDir, profileJson } = fixture(t)
  const before = readFileSync(profileJson, 'utf8')
  const result = publish(['--skip-test', '--force', '--no-profile'], {
    FLOWGATE_PKG_DIR: pkgDir, FLOWGATE_PROFILE_DIR: profileDir,
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(readFileSync(profileJson, 'utf8'), before)
  // spec 没写进 profile，用户只能照着这句手动接法自己抄。
  assert.match(result.stdout, /--no-profile/)
  assert.match(result.stdout, /"dsh-flowgate": "file:.*\.tgz"/)
  // 收尾不能叫人去 cd profile 跑 pnpm install：profile 没改，装上的还是旧版，
  // 三步走完他只会以为已经换新了。
  assert.match(result.stdout, /profile 没有改动/)
  assert.doesNotMatch(result.stdout, /1\. cd /)
})

test('同一分钟连发两次：第二个包换名，不覆盖第一个', (t) => {
  const { pkgDir, profileDir, existing } = fixture(t)
  const env = { FLOWGATE_PKG_DIR: pkgDir, FLOWGATE_PROFILE_DIR: profileDir }
  const firstRun = publish(['--skip-test', '--force'], env)
  assert.equal(firstRun.status, 0, firstRun.stderr + firstRun.stdout)
  const afterFirst = readdirSync(pkgDir)
  const first = afterFirst.find((name) => name !== existing && name.endsWith('.tgz'))
  assert.ok(first, afterFirst.join(', '))

  const secondRun = publish(['--skip-test', '--force'], env)
  assert.equal(secondRun.status, 0, secondRun.stderr + secondRun.stdout)
  const afterSecond = readdirSync(pkgDir)
  const second = afterSecond.find((name) => name !== existing && name !== first && name.endsWith('.tgz'))
  assert.ok(second, afterSecond.join(', '))
  // 第一次的产物必须还在：同名覆盖会把它抹掉，而它是唯一能退回上一版的东西。
  assert.ok(existsSync(join(pkgDir, first)))
  assert.ok(existsSync(join(pkgDir, existing)))

  const stampOf = (name) => name.match(/^dsh-flowgate-[\d.]+-(\d{8}T\d{4})(?:-(\d+))?\.tgz$/)
  const one = stampOf(first)
  const two = stampOf(second)
  assert.ok(one && two, first + ' / ' + second)
  if (one[1] === two[1]) {
    // 落在同一分钟：只能靠序号区分。不带序号就是同名，等于覆盖。
    assert.equal(two[2], '2')
  } else {
    assert.equal(two[2], undefined)
  }
})

test('拼错的参数直接中止，不静默退回默认行为', (t) => {
  const { pkgDir, profileDir, profileJson } = fixture(t)
  const before = readFileSync(profileJson, 'utf8')
  // --no-profil 少一个字母。静默忽略的话脚本会照默认去改写 profile，
  // 而用户以为自己只是打了个「只打包」的命令——这正是最该拦住的那类误操作。
  const result = publish(['--skip-test', '--no-profil'], {
    FLOWGATE_PKG_DIR: pkgDir, FLOWGATE_PROFILE_DIR: profileDir,
  })
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /不认识的参数/)
  assert.ok(result.stderr.includes('--no-profil'), result.stderr)
  // 报错要说清有哪些参数可用，否则用户只能去翻源码。
  assert.match(result.stderr, /可用参数/)
  assert.ok(result.stderr.includes('--no-profile'), result.stderr)
  // 参数都没认全，什么都不该动。
  assert.equal(readFileSync(profileJson, 'utf8'), before)
  assert.deepEqual(readdirSync(pkgDir).length, 1)
})

test('profile 的 dependencies 不是对象时显式中止，不静默丢掉这条依赖', (t) => {
  const { pkgDir, profileDir, profileJson } = fixture(t)
  // 数组上赋值不报错，但 JSON.stringify 只序列化索引项：写回去的文件里根本没有
  // dsh-flowgate，脚本却会打印「old -> spec」并叫你去 pnpm install。
  writeFileSync(profileJson, JSON.stringify({
    dependencies: [],
    dsh: { profile: { bundles: ['dsh-flowgate'] } },
  }, null, 2) + '\n')
  const before = readFileSync(profileJson, 'utf8')
  const result = publish(['--skip-test', '--force'], {
    FLOWGATE_PKG_DIR: pkgDir, FLOWGATE_PROFILE_DIR: profileDir,
  })
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /dependencies 不是对象/)
  assert.ok(result.stderr.includes('数组'), result.stderr)
  // 包已经打好了，必须说清楚：否则用户以为这一趟白跑了。
  assert.match(result.stderr, /包已经打好了/)
  assert.equal(readFileSync(profileJson, 'utf8'), before)
})

test('版本本来就更高时加 --force：照发，并明说 --force 没派上用场', (t) => {
  const { pkgDir, profileDir, manifest } = fixture(t)
  // 把占位包换成更低的版本，让这次发布确实是递增的。
  rmSync(join(pkgDir, 'dsh-flowgate-' + manifest.version + '.tgz'), { force: true })
  writeFileSync(join(pkgDir, 'dsh-flowgate-0.0.1.tgz'), 'older package placeholder')
  const result = publish(['--skip-test', '--force'], {
    FLOWGATE_PKG_DIR: pkgDir, FLOWGATE_PROFILE_DIR: profileDir,
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  // 版本确实升了，放行文案就该说「高于」，不能一律说「跳过递增检查」。
  assert.match(result.stdout, new RegExp(manifest.version.replace(/\./g, '\\.') + ' 高于已有最大版本 0\\.0\\.1，放行。'))
  assert.doesNotMatch(result.stdout, /--force：跳过版本递增检查/)
  // 这个参数这次是多余的。不说一句的话，用户看不出它是被接受还是被忽略了。
  assert.match(result.stdout, /--force 这次没派上用场/)

  // 那句话不能只是嘴上说说：换一个干净的发布目录，不加 --force 也必须照发。
  const second = fixture(t)
  rmSync(join(second.pkgDir, 'dsh-flowgate-' + second.manifest.version + '.tgz'), { force: true })
  writeFileSync(join(second.pkgDir, 'dsh-flowgate-0.0.1.tgz'), 'older package placeholder')
  const withoutForce = publish(['--skip-test'], {
    FLOWGATE_PKG_DIR: second.pkgDir, FLOWGATE_PROFILE_DIR: second.profileDir,
  })
  assert.equal(withoutForce.status, 0, withoutForce.stderr + withoutForce.stdout)
  assert.doesNotMatch(withoutForce.stdout, /--force 这次没派上用场/)
})

test('--force 降到更低版本：放行，但明说 profile 会被指向一个更旧的包', (t) => {
  const { pkgDir, profileDir, manifest } = fixture(t)
  // 发布目录里已经有一个比 package.json 更高的版本，这次是降级而不是重发。
  rmSync(join(pkgDir, 'dsh-flowgate-' + manifest.version + '.tgz'), { force: true })
  writeFileSync(join(pkgDir, 'dsh-flowgate-9.9.9.tgz'), 'newer package placeholder')
  const result = publish(['--skip-test', '--force'], {
    FLOWGATE_PKG_DIR: pkgDir, FLOWGATE_PROFILE_DIR: profileDir,
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  // 放行文案要说清是「更低」，不能和「同一版本重发」共用一句话。
  assert.match(result.stdout, /比发布目录里的最大版本 9\.9\.9 更低/)
  assert.match(result.stdout, /更旧的包/)
  // 后果也要说：profile 真的会被指到这一版（更旧的）上，脚本不能装作没发生。
  assert.match(result.stdout, /这一版比发布目录里的最大版本低/)
})

test('发布目录建不出来时显式报错，不甩 EACCES / ENOTDIR 裸栈', (t) => {
  // 父路径是个普通文件，所以 pkgDir 不存在、也建不出来：闸门按首发放行、
  // 自测跳过之后，卡在第 3 步建目录。
  const base = temp(t, 'flowgate-mkdir-')
  const blocker = join(base, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const profileDir = temp(t, 'flowgate-profile-')
  const result = publish(['--skip-test'], {
    FLOWGATE_PKG_DIR: join(blocker, 'nested'), FLOWGATE_PROFILE_DIR: profileDir,
  })
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /建不了发布目录/)
  // 说清差在哪一步：闸门与自测都过了，只差一个可写的目录。
  assert.match(result.stderr, /只差一个可写的目录/)
  // 裸调用栈会让用户以为整次发布炸了，其实只差最后一步。
  assert.doesNotMatch(result.stderr, /\n\s+at /)
})

test('profile 目录里没有 package.json：跳过而不是失败，也不叫人去 pnpm install', (t) => {
  const { pkgDir } = fixture(t)
  const emptyProfile = temp(t, 'flowgate-noprofile-')
  const result = publish(['--skip-test', '--force'], {
    FLOWGATE_PKG_DIR: pkgDir, FLOWGATE_PROFILE_DIR: emptyProfile,
  })
  // 没有 profile 是配置问题，不是发布失败：包已经打好了，退出码就该是 0。
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stderr, /找不到/)
  // 得告诉用户怎么把它指对，否则只能去翻源码。
  assert.ok(result.stderr.includes('FLOWGATE_PROFILE_DIR'), result.stderr)
  // 这一趟什么都没改，收尾不能叫人去 profile 里跑 pnpm install。
  assert.match(result.stdout, /profile 没有改动/)
  assert.doesNotMatch(result.stdout, /1\. cd /)
})

test('bundles 不是数组时明说无法确认，不靠子串匹配蒙混', (t) => {
  const { pkgDir, profileDir, profileJson } = fixture(t)
  // 字符串里含 dsh-flowgate 时 includes 会判 true，可宿主读到的清单根本不是这个形状。
  writeFileSync(profileJson, JSON.stringify({
    dependencies: {},
    dsh: { profile: { bundles: 'other,dsh-flowgate' } },
  }, null, 2) + '\n')
  const result = publish(['--skip-test', '--force'], {
    FLOWGATE_PKG_DIR: pkgDir, FLOWGATE_PROFILE_DIR: profileDir,
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /bundles 不是数组/)
  assert.ok(result.stdout.includes('字符串'), result.stdout)
  // 依赖照旧写进去了，这不是致命错误，只是「确认不了」要说清楚。
  const profile = JSON.parse(readFileSync(profileJson, 'utf8'))
  assert.match(profile.dependencies['dsh-flowgate'], /^file:.*\.tgz$/)
})

// ---- 命令清单：新脚本必须挂在 package.json 上 ---------------------------

test('package.json 暴露 test:publish 入口，指向本文件的 TAP 报告', () => {
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  // 包装脚本负责在受限沙箱里换成不派生子进程的隔离模式，命令串因此不是裸 node --test。
  assert.equal(scripts['test:publish'], 'node scripts/node-test.mjs test/publish.test.mjs')
  // run-tests.mjs 只认以 node 开头的简单命令，新脚本要能被它执行。
  assert.match(scripts['test:publish'], /^node(?: [\w./:=\-]+)+$/)
})

// ---- 汇总接入：publish 必须能被 npm test 跑到 ---------------------------

test('run-tests.mjs 把 publish 接进汇总，但只在测试文件真的存在时', async (t) => {
  // 工作副本里 test/publish.test.mjs 存在，套件清单里就该有 publish。
  // 它排在 runner 元测试之前：元测试自己接在最后，才能把前面所有套件的判定纳入回归保护。
  const live = suites.find((entry) => entry.name === 'publish')
  assert.ok(live, suites.map((entry) => entry.name).join(', '))
  assert.equal(live.script, 'test:publish')
  assert.equal(live.command, 'node scripts/node-test.mjs test/publish.test.mjs')
  assert.equal(suites.at(-2).name, 'publish')
  assert.equal(suites.at(-1).name, 'runner')

  // test/test-runner.test.mjs 的 fixture 只复制 scripts/ 与 lib/，没有 test/，
  // 那里必须仍是原来那十套，否则那个回归测试的汇总行数会错位。
  const project = temp(t, 'flowgate-runner-')
  mkdirSync(join(project, 'scripts'), { recursive: true })
  // run-tests.mjs 现在直接 import capture-child.mjs（受限沙箱里靠它捕获子进程输出），夹具要一起复制。
  for (const file of ['run-tests.mjs', 'capture-child.mjs']) {
    copyFileSync(join(root, 'scripts', file), join(project, 'scripts', file))
  }
  writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: {} }, null, 2) + '\n')
  const loaded = await import(pathToFileURL(join(project, 'scripts', 'run-tests.mjs')).href)
  assert.equal(loaded.suites.some((entry) => entry.name === 'publish'), false)
  assert.equal(loaded.suites.length, 11)
})
