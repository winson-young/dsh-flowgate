#!/usr/bin/env node
/**
 * 把当前工作副本打成 tgz 放进发布目录，并把 profile 的依赖声明指向新包。
 *
 * 只做三件事：跑自测、打包、改一行依赖声明。
 * 不执行 pnpm install，也不重启 DSH —— 插件什么时候真正换新版，由你决定。
 *
 * 用法：
 *   node scripts/publish.mjs                自测 + 打包 + 改 profile 依赖
 *   node scripts/publish.mjs --skip-test    跳过自测
 *   node scripts/publish.mjs --no-profile   只打包，不动 profile
 *
 * 环境变量：
 *   FLOWGATE_PKG_DIR       发布目录，默认 D:/Plugins/flowgate-pkg
 *   FLOWGATE_PROFILE_DIR   profile 目录，默认 ~/.dsh/profiles/desktop
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const flags = new Set(process.argv.slice(2))
const skipTest = flags.has('--skip-test')
const noProfile = flags.has('--no-profile')

const PKG_DIR = resolve(process.env.FLOWGATE_PKG_DIR ?? 'D:/Plugins/flowgate-pkg')
const PROFILE = resolve(
  process.env.FLOWGATE_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop'),
)

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** npm 在 Windows 上是 npm.cmd，统一走 shell 才能跨平台。 */
function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, shell: true, encoding: 'utf8', ...options })
}

const pkg = readJson(join(ROOT, 'package.json'))
const version = pkg.version
console.log('发布 dsh-flowgate@' + version)
console.log('  工作副本：' + ROOT)
console.log('  发布目录：' + PKG_DIR)

// 1. 自测。install.test.mjs 只核对「已安装的那份自身是否完整」，不跟工作副本比版本，
//    所以「改了代码还没发布」不会让它失败，这里跑得过就说明这份代码本身是好的。
if (skipTest) {
  console.log('\n[1/3] 跳过自测（--skip-test）')
} else {
  console.log('\n[1/3] 自测 npm test')
  try {
    run('npm', ['test'], { stdio: 'inherit' })
  } catch {
    console.error('\n自测失败，已中止发布。修好之后再跑一次。')
    process.exit(1)
  }
}

// 2. 打包。npm pack 直接把 tgz 生成到发布目录，省掉一次复制。
console.log('\n[2/3] 打包到发布目录')
mkdirSync(PKG_DIR, { recursive: true })
let fileName = ''
try {
  const output = run('npm', ['pack', '--json', '--pack-destination', PKG_DIR])
  const parsed = JSON.parse(output.slice(output.indexOf('[')))
  fileName = parsed?.[0]?.filename ?? ''
} catch (error) {
  console.error('打包失败：' + (error?.message ?? String(error)))
  process.exit(1)
}
if (!fileName) {
  console.error('打包失败：没能从 npm pack 的输出里解析出文件名。')
  process.exit(1)
}
const tgzPath = join(PKG_DIR, fileName)
const sizeKb = Math.round(statSync(tgzPath).size / 1024)
console.log('  已生成 ' + tgzPath + '（' + sizeKb + ' KB）')

// 3. 改 profile 的依赖声明。只改这一个字段，其余键原样保留。
console.log('\n[3/3] 更新 profile 依赖声明')
const profileJsonPath = join(PROFILE, 'package.json')
const spec = 'file:' + tgzPath.replace(/\\/g, '/')

if (noProfile) {
  console.log('  跳过（--no-profile）。要手动接上，把 profile 的 dependencies 改成：')
  console.log('    "dsh-flowgate": "' + spec + '"')
} else if (!existsSync(profileJsonPath)) {
  console.error('  找不到 ' + profileJsonPath + '，跳过。用 FLOWGATE_PROFILE_DIR 指定 profile 目录。')
} else {
  const profile = readJson(profileJsonPath)
  const previous = profile?.dependencies?.['dsh-flowgate']
  profile.dependencies = profile.dependencies ?? {}
  profile.dependencies['dsh-flowgate'] = spec
  writeFileSync(profileJsonPath, JSON.stringify(profile, null, 2) + '\n', 'utf8')
  console.log('  ' + (previous ?? '(原本没有)') + '  ->  ' + spec)

  const bundles = profile?.dsh?.profile?.bundles ?? []
  if (!bundles.includes('dsh-flowgate')) {
    console.log('  注意：bundles 清单里没有 dsh-flowgate，宿主不会加载它。当前：' + JSON.stringify(bundles))
  }
}

// 收尾：把「接下来要做什么」讲清楚，避免以为已经生效。
const history = existsSync(PKG_DIR)
  ? readdirSync(PKG_DIR)
      .filter((name) => name.endsWith('.tgz'))
      .map((name) => ({ name, at: statSync(join(PKG_DIR, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 5)
  : []

console.log('\n发布目录里现有的包（新的在前）：')
for (const item of history) {
  console.log('  ' + (item.name === fileName ? '* ' : '  ') + item.name)
}

console.log('\n还没生效。要让 DSH 用上这一版，依次执行：')
console.log('  1. cd ' + PROFILE)
console.log('  2. pnpm install')
console.log('  3. 完全退出并重启 DSH')
console.log('\n改回上一版：把 profile 的依赖指向发布目录里的旧 tgz，再重复上面 2、3 步。')
console.log('下次改代码后要重新发布，记得先把 package.json 的 version 往上加，')
console.log('否则文件名不变，pnpm 会认为没有变化而跳过解压。')
