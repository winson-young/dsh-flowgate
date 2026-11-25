/**
 * 发布闸门的纯函数：版本解析与比较、闸门判定、时间戳命名、包指纹。
 *
 * 只做计算：不读发布目录、不打印、也不决定退出码——读写与退出码由
 * scripts/publish.mjs 组装。拆出来是因为这些规则要能被单元测试逐条钉住，
 * 版本比较、时间戳命名、闸门判定都属于「写错了照样退出 0」的地方。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
// 带时间戳的包名：<x.y.z>[-<prerelease>]-<YYYYMMDDTHHMM>[-<seq>]
const STAMPED = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(\d{8}T\d{4})(?:-(\d+))?$/
const STAMP_SUFFIX = /-\d{8}T\d{4}(?:-\d+)?$/

/** 解析 x.y.z[-prerelease]；无法解析返回 null。 */
export function parseVersion(text) {
  const match = VERSION.exec(String(text ?? '').trim())
  if (!match) return null
  return { nums: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] }
}

/** 比较两个版本：a<b 返回 -1，相等 0，a>b 返回 1；任一无法解析返回 null。 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (let index = 0; index < 3; index += 1) {
    if (left.nums[index] !== right.nums[index]) return left.nums[index] < right.nums[index] ? -1 : 1
  }
  // 带 prerelease 的版本小于同号正式版；两段 prerelease 逐段比。
  if (!left.pre.length && !right.pre.length) return 0
  if (!left.pre.length) return 1
  if (!right.pre.length) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    const one = left.pre[index]
    const two = right.pre[index]
    if (one === undefined) return -1
    if (two === undefined) return 1
    if (one === two) continue
    const oneNum = /^\d+$/.test(one)
    const twoNum = /^\d+$/.test(two)
    if (oneNum && twoNum) return Number(one) < Number(two) ? -1 : 1
    if (oneNum) return -1
    if (twoNum) return 1
    return one < two ? -1 : 1
  }
  return 0
}

/**
 * 包名在 tgz 文件名里的所有可能前缀。
 * npm pack 把 @scope/pkg 写成 scope-pkg-<version>.tgz（去掉 @ 与 /，用 - 连接），
 * 所以 scoped 包要同时认这两种写法——只认 pkg.name 原文的话，scoped 仓库里
 * 闸门永远匹配不上已有包，会一直判首发放行，版本递增检查等于不存在。
 */
export function packageNamePrefixes(packageName) {
  const name = String(packageName ?? '').trim()
  if (!name) return []
  const prefixes = [name]
  const scoped = /^@([^/]+)\/(.+)$/.exec(name)
  if (scoped) prefixes.push(scoped[1] + '-' + scoped[2])
  return prefixes
}

/**
 * 从 tgz 文件名解析出包内版本。
 * 两种命名都认：旧式 <name>-0.1.7.tgz 与带时间戳的 <name>-0.1.7-20261126T1000.tgz
 * （同一分钟重复发布时追加 -2、-3 序号）。不是本包的 tgz 返回 null。
 */
export function parsePackageFileName(fileName, packageName) {
  const name = String(fileName ?? '')
  if (!/\.tgz$/i.test(name)) return null
  const base = name.slice(0, -4)
  for (const prefix of packageNamePrefixes(packageName)) {
    const head = prefix + '-'
    if (!base.startsWith(head)) continue
    const rest = base.slice(head.length)
    const stamped = STAMPED.exec(rest)
    if (stamped) return { version: stamped[1], stamped: true, seq: stamped[3] ? Number(stamped[3]) : 0 }
    if (VERSION.test(rest)) return { version: rest, stamped: false, seq: 0 }
  }
  return null
}

/** 把一组文件名过滤成「同包名的 tgz 及其版本」。 */
export function listVersions(fileNames, packageName) {
  const entries = []
  for (const fileName of Array.isArray(fileNames) ? fileNames : []) {
    const parsed = parsePackageFileName(fileName, packageName)
    if (parsed) entries.push({ fileName, ...parsed })
  }
  return entries
}

/** 发布目录里已有的最大版本；没有可识别的包时返回 null。 */
export function maxExistingVersion(fileNames, packageName) {
  const entries = listVersions(fileNames, packageName)
  if (!entries.length) return null
  let max = entries[0]
  for (const entry of entries) {
    if (compareVersions(entry.version, max.version) > 0) max = entry
  }
  return { version: max.version, fileName: max.fileName }
}

/**
 * 版本闸门：工作副本的 version 必须严格大于发布目录里已有的最大版本。
 * 版本没升说明这次发布没有带来新版本——包名带时间戳、旧包也不会被覆盖，
 * 但装上的仍是同一个版本号，pnpm 分不出新旧，等于发布这个动作什么也没做。
 *
 * 每个分支都返回同一组字段：{ ok, code, message, maxVersion, maxFileName, sameCount }。
 * code 取 first-release | bumped | forced | not-bumped | invalid-version。
 * message 是给终端看的一句话，放行与中止都有；maxFileName 是最大版本对应的文件名
 * （首发放行时为 null），中止时一并报出来，省得自己去发布目录里翻。
 */
export function evaluateVersionGate({ version, packageName, fileNames, force = false } = {}) {
  if (!parseVersion(version)) {
    return {
      ok: false,
      code: 'invalid-version',
      maxVersion: null,
      maxFileName: null,
      sameCount: 0,
      message: 'package.json 的 version「' + String(version ?? '') + '」不是 x.y.z 形式，无法判断这次发布是否带来了新版本。',
    }
  }
  const entries = listVersions(fileNames, packageName)
  if (!entries.length) {
    return {
      ok: true,
      code: 'first-release',
      maxVersion: null,
      maxFileName: null,
      sameCount: 0,
      message: '发布目录里还没有 ' + String(packageName ?? '') + ' 的包，按首发放行。',
    }
  }
  // 最大版本只在这里算一次：直接复用上面的公开出口，避免闸门与 maxExistingVersion
  // 各写一份循环，改一处忘另一处时给出不同结论。
  const max = maxExistingVersion(fileNames, packageName)
  const sameCount = entries.filter((entry) => compareVersions(entry.version, version) === 0).length
  // --force 只跳过「必须递增」这条检查。版本本来就更高时如实报成递增，
  // 不能一律说「跳过递增检查」——0.1.7 对 0.1.6 加 --force 时它确实是更高的。
  if (compareVersions(version, max.version) > 0) {
    return {
      ok: true,
      code: 'bumped',
      maxVersion: max.version,
      maxFileName: max.fileName,
      sameCount,
      forced: force,
      message: version + ' 高于已有最大版本 ' + max.version + '，放行。',
    }
  }
  if (force) {
    return {
      ok: true,
      code: 'forced',
      maxVersion: max.version,
      maxFileName: max.fileName,
      sameCount,
      downgrade: compareVersions(version, max.version) < 0,
      // --force 对更低版本也放行，但那是「降级」不是「重发」：profile 会被指向一个更旧的包。
      // 两种情况文案必须分开，否则用户从日志里看不出自己刚把 profile 降级了。
      message: compareVersions(version, max.version) < 0
        ? '--force：package.json 的 ' + version + ' 比发布目录里的最大版本 ' + max.version + ' 更低，仍然继续——这次发布会让 profile 指向一个更旧的包。'
        : '--force：跳过版本递增检查（package.json ' + version + '，已有最大版本 ' + max.version + '），仍然继续。',
    }
  }
  return {
    ok: false,
    code: 'not-bumped',
    maxVersion: max.version,
    maxFileName: max.fileName,
    sameCount,
    message: '版本未递增，已中止发布：package.json 是 ' + version + '，发布目录里已有最大版本 '
      + max.version + '（' + max.fileName + '）。'
      + '同一个版本号重发不会带来新内容：pnpm 会认为没有变化而跳过解压，装上的还是旧的那份。'
      + '先把 package.json 的 version 往上加；确需重发同一版本时加 --force。',
  }
}

/** 本地时间戳，精确到分钟：YYYYMMDDTHHMM。 */
export function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate())
    + 'T' + pad(date.getHours()) + pad(date.getMinutes())
}

/**
 * 给 tgz 文件名加时间戳；已带时间戳的先剥掉再加，避免叠加。
 *
 * 第三个参数是 package.json 里的 version：版本号自己就可能带一个形如 -20261126T1000 的
 * prerelease，那串字符是版本的一部分，不是上一个发布加的时间戳。文件名以 -<version>
 * 结尾时说明末尾那一段来自版本号，剥掉会让包名和 package.json 的 version 对不上号，
 * 而闸门正是按文件名解析版本的——所以这种情况原样保留。
 */
export function stampedFileName(fileName, date, version) {
  const bare = String(fileName ?? '').replace(/\.tgz$/i, '')
  const fromVersion = version ? bare.endsWith('-' + String(version)) : false
  const base = fromVersion ? bare : bare.replace(STAMP_SUFFIX, '')
  return base + '-' + formatTimestamp(date) + '.tgz'
}

/** 目标名已存在时追加 -2、-3…，绝不覆盖发布目录里的旧包。 */
export function uniqueFileName(fileName, exists) {
  if (!exists(fileName)) return fileName
  const base = String(fileName).replace(/\.tgz$/i, '')
  for (let index = 2; index < 1000; index += 1) {
    const candidate = base + '-' + index + '.tgz'
    if (!exists(candidate)) return candidate
  }
  throw new Error('发布目录里同名包过多，无法生成不冲突的文件名：' + fileName)
}

/** 文件内容的 sha256（十六进制）。 */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 发布结束打印的指纹行。只供人工核对，不用于判断代码是否变化。 */
export function fingerprintLines(tgzPath, digest) {
  return ['本次包指纹（仅供人工核对，不用于判断代码是否变化）：', '  ' + tgzPath, '  sha256 ' + digest]
}
