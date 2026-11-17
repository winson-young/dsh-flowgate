/**
 * 安装就绪度检查：不启动 DSH，只静态核对「装进 profile 之后能否被加载」。
 * 对应源码：packages/client/modules/src/index.ts（parseDshClient / clientExportOf）
 *           packages/client/modules/src/client/system.ts（__ModuleLoader__ 注册契约）
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PROFILE = process.env.FLOWGATE_PROFILE_DIR
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop')

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

await check('profile 的 dependencies 用 link: 指向本仓库', () => {
  const spec = profile?.dependencies?.['dsh-flowgate']
  assert.ok(typeof spec === 'string' && spec.startsWith('link:'), '依赖不是 link: spec：' + String(spec))
  const target = resolve(spec.slice('link:'.length))
  assert.equal(realpathSync(target).toLowerCase(), realpathSync(ROOT).toLowerCase())
})

const linkedDir = join(PROFILE, 'node_modules', 'dsh-flowgate')

await check('profile 的 node_modules 里已链到本仓库', () => {
  assert.ok(existsSync(linkedDir), '缺少 ' + linkedDir + '（先跑 pnpm install）')
  assert.equal(realpathSync(linkedDir).toLowerCase(), realpathSync(ROOT).toLowerCase())
})

let pkg = null
const pkgJsonPath = join(linkedDir, 'package.json')

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

let clientPath = null
await check('clientExportOf：exports["./client"] 存在且文件在盘上', () => {
  const raw = pkg?.exports?.['./client']
  const rel = typeof raw === 'string' ? raw : raw?.default
  assert.equal(typeof rel, 'string', 'exports["./client"] 缺失')
  clientPath = join(linkedDir, rel)
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
  host = await import(pathToFileURL(join(linkedDir, pkg.main ?? 'lib/index.js')).href)
  assert.equal(typeof host.apply, 'function', '缺少 apply')
  assert.equal(host.name, pkg.name, '导出的 name 必须等于包名（Cordis 用它做诊断与依赖解析）')
})

await check('宿主半不引入任何 @deepseek-ai/* 运行时依赖', () => {
  const text = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const valueImports = [...text.matchAll(/^import\s+(?!type)[^'"]*from\s+'([^']+)'/gm)].map((m) => m[1])
  const foreign = valueImports.filter((spec) => spec.startsWith('@deepseek-ai/'))
  assert.deepEqual(foreign, [], '宿主半出现了跨包值导入：' + JSON.stringify(foreign))
})

await check('bundle patch 声明的行 id 与包名一致', () => {
  const patchPath = join(ROOT, 'cordis.patch.yml')
  const text = readFileSync(patchPath, 'utf8')
  assert.match(text, /- insert:/, 'patch 必须是 insert 形状')
  assert.match(text, new RegExp("name: '" + pkg.name + "'"), 'patch 里的 name 必须是包名')
})

console.log('')
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项')
  for (const item of failures) console.log('  - ' + item)
  process.exit(1)
}
console.log('全部通过：' + passed + ' 项')
