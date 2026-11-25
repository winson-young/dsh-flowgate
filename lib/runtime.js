/** Compare actually evaluated module literals with independently hashed disk source. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerModuleRevision, registeredModuleRevisions } from './revisions.js'

export const FLOWGATE_MODULE_REVISION = '4bffbc0c4e843c9b70fd08fdf8afd879c067138d1c33d70497cf5926e7d91e82'
registerModuleRevision(import.meta.url, FLOWGATE_MODULE_REVISION)

const digest = (text) => createHash('sha256').update(text).digest('hex')
export const HOST_MODULES = Object.freeze(['index.js', 'runtime.js', 'provenance.js', 'acceptance.js', 'ecosystems.js', 'requirements.js', 'revisions.js'])
const validRevision = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const markerPattern = () => /^export const FLOWGATE_MODULE_REVISION = '([a-f0-9]{64})'$/gm

/** 页面上报的有效期：超过就当作没上报，避免把过期快照当成当前页面。 */
export const CLIENT_REPORT_TTL = 30000

/** 首行只显示前 8 位；完整 64 位留在字段里做逐字节比对。 */
const shortRevision = (value) => (validRevision(value) ? value.slice(0, 8) : '')

/** The literal is excluded, so stamping is stable and CRLF checkouts are equivalent. */
export function moduleSourceRevision(source) {
  const normalized = String(source).replace(/\r\n?/g, '\n')
  const matches = [...normalized.matchAll(markerPattern())]
  if (matches.length !== 1) return ''
  return digest(normalized.replace(markerPattern(), "export const FLOWGATE_MODULE_REVISION = ''"))
}

export function moduleRevisions() {
  try {
    const disk = [], loaded = [], stale = []
    for (const name of HOST_MODULES) {
      const url = new URL('./' + name, import.meta.url)
      const source = readFileSync(url, 'utf8')
      const actual = moduleSourceRevision(source)
      const declared = [...source.replace(/\r\n?/g, '\n').matchAll(markerPattern())][0]?.[1]
      if (!actual || !declared) return { hostRevision: '', diskHostRevision: '', missing: name }
      if (declared !== actual) stale.push(name)
      const versions = registeredModuleRevisions(url)
      if (!versions.length || !versions.every(validRevision)) return { hostRevision: '', diskHostRevision: '', missing: name }
      // Preserve all evaluated versions: a later import must not hide an old cached consumer.
      loaded.push(name + ':' + versions.join(','))
      disk.push(name + ':' + actual)
    }
    return { hostRevision: digest(loaded.join('\n')), diskHostRevision: digest(disk.join('\n')), stale }
  } catch { return { hostRevision: '', diskHostRevision: '' } }
}

export function clientFactoryRevision(source) {
  const start = '/* flowgate-factory:start */'
  const end = '/* flowgate-factory:end */'
  const first = String(source).indexOf(start)
  const last = String(source).lastIndexOf(end)
  if (first < 0 || last <= first || String(source).indexOf(start, first + start.length) >= 0) return ''
  const factory = String(source).slice(first + start.length, last).trim().replaceAll('\r\n', '\n')
  if (!factory.startsWith('function flowgateFactory(require) {') || !factory.endsWith('}')) return ''
  return digest(factory)
}

/** 页面层期望指纹：读页面源码算，读不到就返回空串（上层据此归 unverified，不静默当成已核对）。 */
export function expectedClientRevisionOf() {
  try { return clientFactoryRevision(readFileSync(new URL('./client.js', import.meta.url), 'utf8')) } catch { return '' }
}

/** 插件自身版本号：G38 要求 status 能念出「验的是哪一版」，版本来自 package.json。 */
let cachedPackageVersion = ''
export function packageVersion() {
  if (cachedPackageVersion) return cachedPackageVersion
  try {
    const raw = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    cachedPackageVersion = typeof raw?.version === 'string' ? raw.version : ''
  } catch { cachedPackageVersion = '' }
  return cachedPackageVersion
}

/**
 * 宿主层：只看宿主模块指纹，页面侧的问题一律不影响这里。
 * expectedClientRevision 属于页面层源码形态（client.js 的 factory 标记），
 * 放在这里会让 client.js 一行标记损坏就把宿主层拖成 unverified，把 Agent 引向查模块加载和重启。
 */
export function hostState(revisions) {
  const detected = revisions ?? moduleRevisions()
  const hostRevision = validRevision(detected.hostRevision) ? detected.hostRevision : ''
  const diskHostRevision = validRevision(detected.diskHostRevision) ? detected.diskHostRevision : ''
  const stale = Array.isArray(detected.stale) ? detected.stale.filter((name) => typeof name === 'string' && name) : []
  const state = { hostRevision, diskHostRevision, stale }
  if (!hostRevision || !diskHostRevision) {
    return { ...state, status: 'unverified', reason: '无法读取完整运行版本或模块尚未登记，宿主层无法核对。' }
  }
  if (hostRevision !== diskHostRevision || stale.length) {
    return { ...state, status: 'mismatch', reason: '宿主已加载模块与磁盘源码不一致，或模块 revision 尚未更新；请重新生成标记并重新加载插件后核对。' }
  }
  return { ...state, status: 'verified', reason: '' }
}

/**
 * 页面层：只看页面上报与期望指纹。
 * absent 与 unverified 必须分开：前者是「没参与」，后者是「参与了但读不懂」，
 * 压成同一个值就再也分不出「页面没开」和「上报了垃圾」。
 */
export function clientState(reported, expected, now = Date.now()) {
  const expectedClientRevision = validRevision(expected) ? expected : ''
  const entry = typeof reported === 'string' ? { clientRevision: reported } : (reported ?? null)
  const raw = typeof entry?.clientRevision === 'string' ? entry.clientRevision : ''
  const clientRevision = validRevision(raw) ? raw : ''
  const rejectedReason = entry?.rejected
    ? (typeof entry.reason === 'string' && entry.reason ? entry.reason : '指纹不是 64 位十六进制')
    : ''
  // 「当初为什么被拒」「上次有没有指纹可报」一律走结构化字段：文案改一次，任何从文案里捞的判定
  // 就断一次，断掉的判定不算判定——本轮把 reason.includes('过期') 换成 clientExpired 就是这个理由。
  const state = {
    clientRevision,
    expectedClientRevision,
    expired: false,
    rejectedReason,
    reportedWithoutRevision: Boolean(entry?.reported && !raw),
  }
  // 宿主算不出期望指纹时，根因在构建标记、不在页面上报：这一条必须先判，否则「factory 标记损坏」
  // 会被念成「上报被拒」，把 Agent 引去查上报参数而不是查构建。
  if (!expectedClientRevision) {
    return { ...state, status: 'unverified', reason: 'client 无法核对（页面源码标记缺失，宿主算不出期望指纹）' }
  }
  // 过期必须先于 rejected / reported 判定：页面关掉之后，任何旧记录都不再代表「现在」。
  // 排在后面会让 clientStatus 永远钉在 unverified——Agent 会去查一个根本没在跑的页面。
  if (Number.isFinite(entry?.reportedAt) && now - entry.reportedAt > CLIENT_REPORT_TTL) {
    return { ...state, expired: true, status: 'absent', reason: 'client 上次上报已过期（30 秒内无刷新）' }
  }
  if (entry?.rejected) {
    return { ...state, status: 'unverified', reason: 'client 上报被拒（' + rejectedReason + '）' }
  }
  // 页面参与了轮询却没有指纹可报：不是「没参与」，是「参与了但读不懂」，两者不能同值（G01/G18）。
  if (state.reportedWithoutRevision) {
    return { ...state, status: 'unverified', reason: 'client 无法核对（页面参与了轮询但没有可上报的指纹，页面源码标记缺失）' }
  }
  if (!raw) return { ...state, status: 'absent', reason: 'client 未参与（本次没有页面轮询）' }
  if (!clientRevision) {
    return { ...state, status: 'unverified', reason: 'client 上报被拒（指纹不是 64 位十六进制）' }
  }
  if (clientRevision !== expectedClientRevision) {
    return { ...state, status: 'mismatch', reason: 'client ' + shortRevision(clientRevision) + ' ≠ 期望 ' + shortRevision(expectedClientRevision) + '（页面跑的是旧版，刷新后重新核对）' }
  }
  return { ...state, status: 'verified', reason: 'client ' + shortRevision(clientRevision) + '（已核对）' }
}

/**
 * 运行版本的唯一出口：flowgate_status 的七个字段、summary 首行、view().runtime 都从这里取。
 * moduleRevision / diskModuleRevision 是 status 的契约名；hostRevision / diskHostRevision 是
 * 布局证据链路（lib/acceptance.js、lib/client.js，均在 scope 外）沿用的旧名字，只作内部别名。
 * 加第八个版本字段要动三处：这里的返回值、lib/index.js 的 STATUS_RUNTIME_KEYS、以及 output.schema
 * 的 properties 与 required（properties 是手写的，漏了就被 additionalProperties:false 直接拒掉）。
 */
export function runtimeFields(version, host, client) {
  const hostRevision = validRevision(host?.hostRevision) ? host.hostRevision : ''
  const diskHostRevision = validRevision(host?.diskHostRevision) ? host.diskHostRevision : ''
  const staleModules = Array.isArray(host?.stale) ? host.stale.filter((name) => typeof name === 'string' && name) : []
  return {
    version: typeof version === 'string' ? version : '',
    moduleRevision: hostRevision,
    diskModuleRevision: diskHostRevision,
    runtimeStatus: typeof host?.status === 'string' ? host.status : 'unverified',
    clientRevision: validRevision(client?.clientRevision) ? client.clientRevision : '',
    clientStatus: typeof client?.status === 'string' ? client.status : 'absent',
    staleModules,
    // 以下只喂 describeRuntime 与内部消费方，不进 flowgate_status 的输出。
    expectedClientRevision: validRevision(client?.expectedClientRevision) ? client.expectedClientRevision : '',
    clientReason: typeof client?.reason === 'string' ? client.reason : '',
    clientExpired: client?.expired === true,
    clientRejectedReason: typeof client?.rejectedReason === 'string' ? client.rejectedReason : '',
    clientReportedWithoutRevision: client?.reportedWithoutRevision === true,
    hostRevision,
    diskHostRevision,
  }
}

/** 过期之后仍要能查出「当初为什么被拒」；诊断从结构化字段取，不从文案里正则捞。 */
function expiredNote(state = {}) {
  const rejected = typeof state.clientRejectedReason === 'string' ? state.clientRejectedReason : ''
  if (rejected) return '；上次记录被拒（' + rejected + '）'
  if (state.clientReportedWithoutRevision === true) return '；上次上报没有可用的指纹（页面源码标记缺失）'
  return ''
}

/** 首行文案：宿主层是主判据，页面层只是附加信息。纯字符串拼接，纯对象即可断言。 */
export function describeRuntime(state = {}) {
  const version = typeof state.version === 'string' && state.version ? state.version : '未知版本'
  const host = typeof state.runtimeStatus === 'string' ? state.runtimeStatus : 'unverified'
  const hostRevision = validRevision(state.moduleRevision) ? state.moduleRevision : ''
  const diskRevision = validRevision(state.diskModuleRevision) ? state.diskModuleRevision : ''
  const client = typeof state.clientStatus === 'string' ? state.clientStatus : 'absent'
  const clientRevision = validRevision(state.clientRevision) ? state.clientRevision : ''
  const expected = validRevision(state.expectedClientRevision) ? state.expectedClientRevision : ''
  const reason = typeof state.clientReason === 'string' ? state.clientReason : ''
  let hostText
  if (host === 'verified') hostText = shortRevision(hostRevision) + '（与磁盘一致）'
  else if (host === 'mismatch') hostText = shortRevision(hostRevision) + ' ≠ 磁盘 ' + shortRevision(diskRevision) + '（加载的是旧模块，验证结论不可用）'
  else hostText = '无法核对（模块未登记或源码缺失，验证结论不可用）'
  let clientText
  if (client === 'verified') clientText = shortRevision(clientRevision) + '（已核对）'
  else if (client === 'mismatch') clientText = shortRevision(clientRevision) + ' ≠ 期望 ' + shortRevision(expected) + '（页面跑的是旧版，刷新后重新核对）'
  else if (client === 'absent') {
    clientText = state.clientExpired === true
      ? '上次上报已过期（30 秒内无刷新）' + expiredNote(state)
      : (host === 'verified' ? '未参与（本次没有页面轮询，宿主层已核对）' : '未参与（本次没有页面轮询）')
  } else clientText = reason ? reason.replace(/^client /, '') : '无法核对'
  const lines = ['运行版本：' + version + ' / host ' + hostText + ' / client ' + clientText]
  if (host === 'mismatch') {
    const stale = Array.isArray(state.staleModules) ? state.staleModules.filter((name) => typeof name === 'string' && name) : []
    lines.push('未重新盖章的模块：' + (stale.length ? stale.join('、') : '（磁盘源码已变但标记未更新）'))
  }
  return lines.join('\n')
}

/**
 * 组合函数，保留给布局证据回执、视觉采集前置核对与 visualResult 三个既有消费方：
 * 它们都读 status，且 test/runtime.test.mjs 的既有断言依赖「宿主优先」的合并语义。
 * 页面层 absent 在合并态里继续记为 unverified——把保护性断言改弱比多一个分支更糟。
 */
export function runtimeState(clientRevision = '', revisions) {
  let expectedClientRevision = ''
  if (!revisions) {
    try { expectedClientRevision = clientFactoryRevision(readFileSync(new URL('./client.js', import.meta.url), 'utf8')) } catch { /* Missing source remains unverified. */ }
  }
  const detected = revisions ?? moduleRevisions()
  expectedClientRevision = detected.expectedClientRevision ?? expectedClientRevision
  const host = hostState(detected)
  const client = clientState(clientRevision, expectedClientRevision)
  const merged = {
    hostRevision: host.hostRevision,
    diskHostRevision: host.diskHostRevision,
    expectedClientRevision: client.expectedClientRevision,
    clientRevision: client.clientRevision,
    stale: host.stale,
    hostStatus: host.status,
    clientStatus: client.status,
    clientReason: client.reason,
  }
  if (host.status !== 'verified') return { ...merged, status: host.status, reason: host.reason }
  if (client.status === 'verified') return { ...merged, status: 'verified', reason: '页面执行的插件与宿主实际加载模块版本均已核对。' }
  if (client.status === 'mismatch') return { ...merged, status: 'mismatch', reason: '页面执行版本与当前插件文件不一致，需要刷新后核对；构建改写源码也会导致指纹无法匹配。' }
  return { ...merged, status: 'unverified', reason: client.reason || '页面尚未上报实际执行的插件指纹。' }
}
