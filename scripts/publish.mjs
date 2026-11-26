#!/usr/bin/env node
/**
 * 把当前工作副本打成 tgz 放进发布目录，并把 profile 的依赖声明指向新包。
 *
 * 做四件事：版本闸门、跑自测、打包、改一行依赖声明。
 * 不执行 pnpm install，也不重启 DSH —— 插件什么时候真正换新版，由你决定。
 *
 * 用法：
 *   node scripts/publish.mjs                闸门 + 自测 + 打包 + 改 profile 依赖
 *   node scripts/publish.mjs --skip-test    跳过自测（闸门照跑）
 *   node scripts/publish.mjs --no-profile   只打包，不动 profile
 *   node scripts/publish.mjs --force        版本没有递增也照发
 *
 * 环境变量：
 *   FLOWGATE_PKG_DIR       发布目录，默认 D:/Plugins/flowgate-pkg
 *   FLOWGATE_PROFILE_DIR   profile 目录，默认 ~/.dsh/profiles/desktop
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { captureSync } from './capture-child.mjs'
import {
  evaluateVersionGate,
  fingerprintLines,
  sha256File,
  stampedFileName,
  uniqueFileName,
} from './publish-gate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const flags = new Set(process.argv.slice(2))
// 拼错的参数不能静默退回默认行为：--no-profil 少一个字母，脚本就会照默认去改写 profile，
// 而用户以为自己只是打了个「只打包」的命令。这个脚本到处都在避免猜用户意图，参数这一层不能例外。
const KNOWN_FLAGS = ['--skip-test', '--no-profile', '--force']
const unknownFlags = [...flags].filter((flag) => !KNOWN_FLAGS.includes(flag))
if (unknownFlags.length) {
  console.error('不认识的参数：' + unknownFlags.join(' '))
  console.error('可用参数：' + KNOWN_FLAGS.join('、'))
  process.exit(1)
}
const skipTest = flags.has('--skip-test')
const noProfile = flags.has('--no-profile')
const force = flags.has('--force')

const PKG_DIR = resolve(process.env.FLOWGATE_PKG_DIR ?? 'D:/Plugins/flowgate-pkg')
const PROFILE = resolve(
  process.env.FLOWGATE_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop'),
)

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** npm 在 Windows 上是 npm.cmd，统一走 shell 才能跨平台。 */
function run(command, args, options = {}) {
  // stdio 显式给了值（例如 'inherit'）就原样透传：那不是管道，沙箱不拦。
  if (options.stdio) return spawnSync(command, args, { cwd: ROOT, shell: true, ...options })
  // 默认捕获走 captureSync：受限沙箱拒绝管道 stdio，文件描述符不拒绝。
  const result = captureSync(command, args, { cwd: ROOT, shell: true, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const error = new Error(`命令失败：${command} ${args.join(' ')}`)
    error.status = result.status
    error.signal = result.signal
    error.stdout = result.stdout
    error.stderr = result.stderr
    throw error
  }
  return result.stdout
}

const pkg = readJson(join(ROOT, 'package.json'))
const version = pkg.version
console.log('发布 dsh-flowgate@' + version)
console.log('  工作副本：' + ROOT)
console.log('  发布目录：' + PKG_DIR)

// 1. 版本闸门。忘了升版本时包名虽带时间戳、旧包也不会被覆盖，但装上的仍是同一个
//    版本号：pnpm 分不出新旧，判为「没有变化」而跳过解压，最后装上的还是旧内容——
//    而且退出码是 0、输出一切正常，没有任何异常迹象。
//    放在自测之前：版本没动，跑一遍全套自测也是白跑。--skip-test 跳不过这一步。
console.log('\n[1/4] 版本闸门')
let existingNames = []
try {
  existingNames = existsSync(PKG_DIR) ? readdirSync(PKG_DIR) : []
} catch (error) {
  // 发布目录存在但不是目录（或读不了）时，别把 ENOTDIR 的裸栈甩给用户。
  console.error('\n读不了发布目录 ' + PKG_DIR + '：' + (error?.message ?? String(error)))
  process.exit(1)
}
const gate = evaluateVersionGate({ version, packageName: pkg.name, fileNames: existingNames, force })
if (!gate.ok) {
  console.error('\n' + gate.message)
  process.exit(1)
}
// 放行的三句文案由闸门自己给出，这里只负责打印：文案与判定在同一个地方，
// 不会出现「判定说放行、打印说另一回事」的偏差。
console.log('  ' + gate.message)
// 版本本来就更高时 --force 是多余的。明说一句，否则用户看不出这个参数是被接受
// 还是被忽略了——两种情况下输出本来会一字不差。
if (gate.forced && gate.code === 'bumped') {
  console.log('  --force 这次没派上用场：版本本来就高于已有最大版本，不加也一样放行。')
}
// --force 对更低版本也放行，但那是降级：profile 会被指向一个更旧的包。
// 文案已经分开，这里再提示一句后果，免得用户以为自己在「重发同一版本」。
if (gate.downgrade) {
  console.log('  注意：这一版比发布目录里的最大版本低，profile 会被指向一个更旧的包。')
}
if (gate.sameCount) {
  console.log('  发布目录里已有 ' + gate.sameCount + ' 个 ' + version + ' 的包，这次生成带时间戳的新文件，不覆盖它们。')
}

// 2. 自测。install.test.mjs 只核对「已安装的那份自身是否完整」，不跟工作副本比版本，
//    所以「改了代码还没发布」不会让它失败，这里跑得过就说明这份代码本身是好的。
if (skipTest) {
  console.log('\n[2/4] 跳过自测（--skip-test）')
} else {
  console.log('\n[2/4] 自测 npm test')
  try {
    run('npm', ['test'], { stdio: 'inherit' })
  } catch {
    console.error('\n自测失败，已中止发布。修好之后再跑一次。')
    process.exit(1)
  }
}

// 3. 打包。npm pack 用 package.json 的 version 命名，所以它一定会产出
//    <name>-<version>.tgz 这个名字。先落到一个临时目录，再按带时间戳的新名字复制进
//    发布目录：直接 pack 到发布目录会在改名前就覆盖掉同名旧包，而旧包是唯一的回退路径。
console.log('\n[3/4] 打包到发布目录')
// 建目录与建临时目录都会失败（只读磁盘、没有写权限、临时目录被清掉）。和第 1 步读目录一样
// 给显式文案：否则用户看到的是一串 EACCES 裸栈，既不知道是哪一步失败，也不知道闸门与自测
// 其实都已经通过了。
try {
  mkdirSync(PKG_DIR, { recursive: true })
} catch (error) {
  console.error('\n建不了发布目录 ' + PKG_DIR + '：' + (error?.message ?? String(error)))
  console.error('  版本闸门与自测已经通过，这一步只差一个可写的目录。')
  process.exit(1)
}
let staging = ''
try {
  staging = mkdtempSync(join(tmpdir(), 'flowgate-pack-'))
} catch (error) {
  console.error('\n建不了临时打包目录：' + (error?.message ?? String(error)))
  console.error('  版本闸门与自测已经通过，检查一下系统临时目录 ' + tmpdir() + ' 是否可写。')
  process.exit(1)
}
let fileName = ''
let tgzPath = ''
let incomingPath = ''
let packError = null
try {
  // 临时目录落在 tmpdir，账户目录含空格时 shell 会把路径拆成两段，引号兜住。
  const output = run('npm', ['pack', '--json', '--pack-destination', '"' + staging + '"'])
  const parsed = JSON.parse(output.slice(output.indexOf('[')))
  const packedName = parsed?.[0]?.filename ?? ''
  if (!packedName) throw new Error('没能从 npm pack 的输出里解析出文件名')
  // 文件名每次都不同，pnpm 一定会重新解压，不会因为同名而判为「没有变化」。
  fileName = uniqueFileName(
    stampedFileName(packedName, new Date(), version),
    (candidate) => existsSync(join(PKG_DIR, candidate)),
  )
  tgzPath = join(PKG_DIR, fileName)
  // 先写到发布目录里的临时名，写完再 rename 成最终名。直接往最终名上复制的话，
  // 复制中途失败会留下一个「文件名合法、内容不完整」的半包——闸门与 profile 只认文件名，
  // 下次发布就会把这个半包当成已有最大版本，唯一能回退的那条路也就脏了。
  incomingPath = join(PKG_DIR, fileName + '.incoming')
  copyFileSync(join(staging, packedName), incomingPath)
  renameSync(incomingPath, tgzPath)
  incomingPath = ''
} catch (error) {
  packError = error
} finally {
  // pack 失败、copy 抛错、成功，临时目录三种情况都要收掉；
  // 这里不能直接 process.exit，那会跳过 finally。
  rmSync(staging, { recursive: true, force: true })
  // 复制到一半留下的 .incoming 也要收掉，不然发布目录里会积攒无主的半包。
  if (incomingPath) rmSync(incomingPath, { force: true })
}
if (packError) {
  console.error('打包失败：' + (packError?.message ?? String(packError)))
  process.exit(1)
}
const sizeKb = Math.round(statSync(tgzPath).size / 1024)
console.log('  已生成 ' + tgzPath + '（' + sizeKb + ' KB）')
// 指纹只供人工核对：version 本身也在 tgz 里，两个版本的摘要天然不同，
// 所以这里不拿它跟上一个包比，也不据此宣称「代码没有变化」。
for (const line of fingerprintLines(tgzPath, sha256File(tgzPath))) console.log(line)

// 4. 改 profile 的依赖声明。只改这一个字段，其余键原样保留。
console.log('\n[4/4] 更新 profile 依赖声明')
const profileJsonPath = join(PROFILE, 'package.json')
const spec = 'file:' + tgzPath.replace(/\\/g, '/')

let profileUpdated = false
if (noProfile) {
  console.log('  跳过（--no-profile）。要手动接上，把 profile 的 dependencies 改成：')
  console.log('    "dsh-flowgate": "' + spec + '"')
} else if (!existsSync(profileJsonPath)) {
  console.error('  找不到 ' + profileJsonPath + '，跳过。用 FLOWGATE_PROFILE_DIR 指定 profile 目录。')
} else {
  // profile 是手写的 JSON，坏了就是坏了。把 SyntaxError 的裸栈直接甩出去，用户看到的
  // 只有「Unexpected token」和一串内部帧：既不知道是哪个文件坏了，也不知道包其实已经打好了。
  let profile = null
  try {
    profile = readJson(profileJsonPath)
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new Error('顶层不是一个对象')
    }
    // dependencies 也必须是普通对象：是数组时赋值不报错，但 JSON.stringify 只序列化数组的
    // 索引项，写回的文件里根本没有这条依赖，脚本却会打印「old -> spec」并叫你去 pnpm install；
    // 是字符串时在 ESM 的严格模式下直接抛 TypeError。null 与缺失都按「还没有」处理。
    const deps = profile.dependencies
    if (deps !== undefined && deps !== null && (typeof deps !== 'object' || Array.isArray(deps))) {
      throw new Error('dependencies 不是对象（当前是 ' + (Array.isArray(deps) ? '数组' : typeof deps) + '）')
    }
  } catch (error) {
    console.error('  读不了 ' + profileJsonPath + '：' + (error?.message ?? String(error)))
    console.error('  包已经打好了：' + tgzPath)
    console.error('  修好那个文件再跑一次，或者手动把 dependencies 改成：')
    console.error('    "dsh-flowgate": "' + spec + '"')
    process.exit(1)
  }
  const previous = profile?.dependencies?.['dsh-flowgate']
  profile.dependencies = profile.dependencies ?? {}
  profile.dependencies['dsh-flowgate'] = spec
  writeFileSync(profileJsonPath, JSON.stringify(profile, null, 2) + '\n', 'utf8')
  profileUpdated = true
  console.log('  ' + (previous ?? '(原本没有)') + '  ->  ' + spec)

  // bundles 必须是数组才谈得上「含不含」：写成字符串时 includes 会做子串匹配，
  // 'dsh-flowgate-extra' 或 'other,dsh-flowgate' 都会让这条检查静默通过，
  // 而宿主真正读到的清单可能是另一种形状。说不准就直说说不准。
  const bundles = profile?.dsh?.profile?.bundles
  if (bundles === undefined || bundles === null) {
    console.log('  注意：profile 里没有 dsh.profile.bundles，宿主不会加载 dsh-flowgate。')
  } else if (!Array.isArray(bundles)) {
    const kind = typeof bundles === 'string' ? '字符串' : typeof bundles
    console.log('  注意：dsh.profile.bundles 不是数组（当前是 ' + kind + '），无法确认宿主会不会加载 dsh-flowgate。当前：' + JSON.stringify(bundles))
  } else if (!bundles.includes('dsh-flowgate')) {
    console.log('  注意：bundles 清单里没有 dsh-flowgate，宿主不会加载它。当前：' + JSON.stringify(bundles))
  }
}

// 收尾：把「接下来要做什么」讲清楚，避免以为已经生效。
// 这是第二次读发布目录，和第 1 步一样要有显式文案：包已经打好、profile 可能已经改完，
// 这里甩一句 ENOENT 裸栈会让用户以为整次发布失败，而实际只差最后一段日志。
let history = []
try {
  history = existsSync(PKG_DIR)
    ? readdirSync(PKG_DIR)
        .filter((name) => name.endsWith('.tgz'))
        .map((name) => ({ name, at: statSync(join(PKG_DIR, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
        .slice(0, 5)
    : []
} catch (error) {
  console.error('  读不了发布目录 ' + PKG_DIR + '：' + (error?.message ?? String(error)))
}

console.log('\n发布目录里现有的包（新的在前）：')
for (const item of history) {
  console.log('  ' + (item.name === fileName ? '* ' : '  ') + item.name)
}

if (profileUpdated) {
  console.log('\n还没生效。要让 DSH 用上这一版，依次执行：')
  console.log('  1. cd ' + PROFILE)
  console.log('  2. pnpm install')
  console.log('  3. 完全退出并重启 DSH')
  console.log('\n改回上一版：把 profile 的依赖指向发布目录里的旧 tgz，再重复上面 2、3 步。')
} else {
  // profile 一个字都没改。这时候照念「cd / pnpm install / 重启」是有害的：
  // 依赖声明还指着旧包，三步走完装上的仍是旧版，而用户会以为已经换新了。
  console.log('\nprofile 没有改动，先别急着 pnpm install：依赖声明还指着旧包，重装只会装回旧版。')
  console.log('要生效，先把上面那句 spec 写进 profile 的 dependencies，再在 profile 目录跑 pnpm install，')
  console.log('然后完全退出并重启 DSH。')
}
console.log('下次发布前会先比版本：version 不高于发布目录里的最大版本就中止，')
console.log('确需重发同一版本时加 --force。包名带时间戳，每次发布都是新文件名。')
