/**
 * 安装就绪度检查：不启动 DSH，只静态核对「装进 profile 之后能否被加载」。
 * 对应源码：packages/client/modules/src/index.ts（parseDshClient / clientExportOf）
 *           packages/client/modules/src/client/system.ts（__ModuleLoader__ 注册契约）
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

function fixtureProfile() {
  const profile = mkdtempSync(join(tmpdir(), 'flowgate-install-'))
  process.once('exit', () => rmSync(profile, { recursive: true, force: true }))
  const installed = join(profile, 'node_modules', 'dsh-flowgate')
  mkdirSync(installed, { recursive: true })
  for (const entry of ['package.json', 'lib', 'cordis.patch.yml']) {
    cpSync(join(ROOT, entry), join(installed, entry), { recursive: true })
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['dsh-flowgate'] } },
    dependencies: { 'dsh-flowgate': 'link:' + ROOT },
  }))
  return profile
}

const PROFILE = process.argv.includes('--fixture')
  ? fixtureProfile()
  : process.env.FLOWGATE_PROFILE_DIR
    ?? join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), '.dsh', 'profiles', 'desktop')

let passed = 0
const failures = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failures.push(name + ' -> ' + (error?.message ?? String(error)))
    console.log('  FAIL ' + name + ' -> ' + (error?.message ?? String(error)))
  }
}

console.log('flowgate 安装就绪度检查（profile: ' + PROFILE + '）')

// ---------------------------------------------------------------------------
// 最小 semver 判定：宿主用 semver.satisfies(version, range, { includePrerelease: true })
// 决定插件能否加载，这里只实现插件声明会用到的那部分，用来把兼容声明钉进测试。
// ---------------------------------------------------------------------------

function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim())
  if (!m) throw new Error('无法解析版本号：' + text)
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

function comparePre(a, b) {
  // 没有 prerelease 的版本高于任何同号 prerelease 版本。
  if (!a.length && !b.length) return 0
  if (!a.length) return 1
  if (!b.length) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const delta = Number(x) - Number(y)
      if (delta !== 0) return delta < 0 ? -1 : 1
    } else if (nx !== ny) {
      return nx ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

function compareVersion(a, b) {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (va.nums[i] !== vb.nums[i]) return va.nums[i] < vb.nums[i] ? -1 : 1
  }
  return comparePre(va.pre, vb.pre)
}

function satisfiesRange(version, range) {
  const clauses = String(range).trim().split(/\s+/).filter(Boolean)
  if (!clauses.length) throw new Error('空的版本范围')
  return clauses.every((clause) => {
    const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(clause)
    if (!m) throw new Error('无法解析的范围片段：' + clause)
    const op = m[1] ?? '='
    const cmp = compareVersion(version, m[2])
    if (op === '>=') return cmp >= 0
    if (op === '<=') return cmp <= 0
    if (op === '>') return cmp > 0
    if (op === '<') return cmp < 0
    return cmp === 0
  })
}

const profileJsonPath = join(PROFILE, 'package.json')
let profile = null

await check('profile 的 package.json 可读', () => {
  assert.ok(existsSync(profileJsonPath), '找不到 ' + profileJsonPath)
  profile = JSON.parse(readFileSync(profileJsonPath, 'utf8'))
})

await check('profile 的 bundles 清单包含 dsh-flowgate', () => {
  const bundles = profile?.dsh?.profile?.bundles ?? []
  assert.ok(bundles.includes('dsh-flowgate'), 'bundles 里没有 dsh-flowgate：' + JSON.stringify(bundles))
})

await check('profile 的 dependencies 声明了 dsh-flowgate 的来源', () => {
  const spec = profile?.dependencies?.['dsh-flowgate']
  assert.ok(typeof spec === 'string' && spec.length > 0, '依赖缺失：' + String(spec))
  // 开发期用 link: 指向工作副本，发布期用 file: 指向打好的 tgz，两种都合法。
  // 但必须能在盘上找到实际内容，否则 pnpm install 会失败。
  assert.match(spec, /^(link|file):/, '依赖必须写成 link: 或 file: 开头：' + spec)
  const raw = spec.replace(/^(link|file):/, '')
  const target = isAbsolute(raw) ? raw : resolve(PROFILE, raw)
  assert.ok(existsSync(target), '依赖指向的路径不存在：' + spec)
})

// 安装目录：link: 时是符号链接，file: 时是解压出来的实体目录，两种都接受。
// 这里只核对「装进来的这一份自身是完整的」，不跟工作副本比版本 ——
// 发布节奏由 publish.mjs 掌握，安装就绪度不该因为「还没发布」而失败。
const installedDir = join(PROFILE, 'node_modules', 'dsh-flowgate')

await check('profile 的 node_modules 里已安装 dsh-flowgate', () => {
  assert.ok(existsSync(installedDir), '缺少 ' + installedDir + '（先跑 pnpm install）')
  assert.ok(
    existsSync(join(installedDir, 'package.json')),
    '安装目录里没有 package.json：' + installedDir + '（安装可能不完整）',
  )
})

let pkg = null
const pkgJsonPath = join(installedDir, 'package.json')

await check('包自身的 package.json 可读', () => {
  assert.ok(existsSync(pkgJsonPath), '找不到 ' + pkgJsonPath)
  pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
})

await check('parseDshClient：dsh.client 是对象且 platform/inject 合法', () => {
  const decl = pkg?.dsh?.client
  assert.ok(decl && typeof decl === 'object' && !Array.isArray(decl), 'dsh.client 必须是对象')
  assert.equal(typeof decl.platform, 'string', 'platform 必须是 string')
  assert.ok(Array.isArray(decl.inject) && decl.inject.every((i) => typeof i === 'string'), 'inject 必须是 string[]')
  if ('immediately' in decl) assert.equal(typeof decl.immediately, 'boolean')
})

await check('platform 是 web（否则宿主直接跳过该客户端行）', () => {
  assert.equal(pkg?.dsh?.client?.platform, 'web')
})

await check('engines.dsh 声明版本范围而不是精确版本', () => {
  const range = pkg?.engines?.dsh
  assert.equal(typeof range, 'string', '缺少 engines.dsh：宿主会回落到 peerDependencies 判定')
  // 精确版本会让宿主每次小版本升级都静默禁用插件，这里必须一直是范围。
  assert.match(range, /[<>]/, 'engines.dsh 必须是范围（例如 >=0.2.2-rc.3 <0.3.0-0），不能写死精确版本：' + range)
})

await check('engines.dsh 的范围覆盖 0.2.2 全系、拦住 0.3.0 与更老的 0.1.x', () => {
  const range = pkg?.engines?.dsh
  for (const version of ['0.2.2-rc.3', '0.2.2-rc.5', '0.2.2', '0.2.3', '0.2.99']) {
    assert.ok(satisfiesRange(version, range), range + ' 应当接受 ' + version)
  }
  for (const version of ['0.1.5', '0.2.2-rc.2', '0.3.0-0', '0.3.0', '0.3.1']) {
    assert.ok(!satisfiesRange(version, range), range + ' 不应当接受 ' + version)
  }
})

await check('商城口径 dsh.compatibility.dsh 与 engines.dsh 一致', () => {
  assert.equal(pkg?.dsh?.compatibility?.dsh, pkg?.engines?.dsh)
})

await check('dshReleases 记录的版本都落在声明范围内', () => {
  const range = pkg?.engines?.dsh
  const releases = pkg?.dsh?.compatibility?.dshReleases ?? {}
  assert.ok(Object.keys(releases).length > 0, 'dshReleases 不能为空')
  for (const version of Object.keys(releases)) {
    assert.ok(satisfiesRange(version, range), 'dshReleases 里的 ' + version + ' 不在 ' + range + ' 内')
  }
})

let clientPath = null
await check('clientExportOf：exports["./client"] 存在且文件在盘上', () => {
  const raw = pkg?.exports?.['./client']
  const rel = typeof raw === 'string' ? raw : raw?.default
  assert.equal(typeof rel, 'string', 'exports["./client"] 缺失')
  clientPath = join(installedDir, rel)
  assert.ok(existsSync(clientPath), '找不到客户端 bundle：' + clientPath)
})

await check('bundle 用包名作为 __ModuleLoader__ 的 id', () => {
  const text = readFileSync(clientPath, 'utf8')
  assert.match(text, /__ModuleLoader__\.load\(/, 'bundle 没有调用 __ModuleLoader__.load')
  assert.match(text, new RegExp("id:\\s*'" + pkg.name + "'"), 'bundle 的 id 必须等于包名 ' + pkg.name)
})

await check('bundle 不自行打包 react（react 由宿主 seed）', () => {
  const text = readFileSync(clientPath, 'utf8')
  assert.match(text, /require\('react'\)/, 'bundle 应当 require("react") 而不是自带实现')
  assert.ok(!/react-dom/.test(text), 'bundle 不应依赖 react-dom')
})

let host = null
await check('宿主半可被 import 且导出 name / inject / apply', async () => {
  host = await import(pathToFileURL(join(installedDir, pkg.main ?? 'lib/index.js')).href)
  assert.equal(typeof host.apply, 'function', '缺少 apply')
  assert.equal(host.name, pkg.name, '导出的 name 必须等于包名（Cordis 用它做诊断与依赖解析）')
})

await check('宿主半不引入任何 @deepseek-ai/* 运行时依赖', () => {
  const text = readFileSync(join(installedDir, 'lib', 'index.js'), 'utf8')
  const valueImports = [...text.matchAll(/^import\s+(?!type)[^'"]*from\s+'([^']+)'/gm)].map((m) => m[1])
  const foreign = valueImports.filter((spec) => spec.startsWith('@deepseek-ai/'))
  assert.deepEqual(foreign, [], '宿主半出现了跨包值导入：' + JSON.stringify(foreign))
})

await check('bundle patch 声明的行 id 与包名一致', () => {
  const patchPath = join(installedDir, 'cordis.patch.yml')
  const text = readFileSync(patchPath, 'utf8')
  assert.match(text, /- insert:/, 'patch 必须是 insert 形状')
  assert.match(text, new RegExp("name: '" + pkg.name + "'"), 'patch 里的 name 必须是包名')
})

// 安装副本与工作副本的版本对照：只作提示，不参与判定。
// 两者不一致通常意味着「改了代码但还没发布」，运行中的插件仍是安装的那一版 ——
// 这是发布节奏问题，不是安装错误，不该让 S4 的测试失败。
try {
  const localVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  if (localVersion !== pkg?.version) {
    console.log('')
    console.log('提示：工作副本是 ' + localVersion + '，安装的是 ' + pkg?.version + '。')
    console.log('      运行中的插件仍是安装的那一版。要换上工作副本的代码，先跑 node scripts/publish.mjs。')
  }
} catch {
  // 读不到工作副本的版本不影响安装就绪度判定，忽略。
}

console.log('')
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项')
  for (const item of failures) console.log('  - ' + item)
  process.exit(1)
}
console.log('全部通过：' + passed + ' 项')
