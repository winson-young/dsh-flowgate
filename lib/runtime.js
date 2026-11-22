/** Compare actually evaluated module literals with independently hashed disk source. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerModuleRevision, registeredModuleRevisions } from './revisions.js'

export const FLOWGATE_MODULE_REVISION = 'f7eea25c9ab72c430dcd21f3a35dea803e7b7d25f402c7b971915f60db7089c9'
registerModuleRevision(import.meta.url, FLOWGATE_MODULE_REVISION)

const digest = (text) => createHash('sha256').update(text).digest('hex')
export const HOST_MODULES = Object.freeze(['index.js', 'runtime.js', 'provenance.js', 'acceptance.js', 'ecosystems.js', 'requirements.js', 'revisions.js'])
const validRevision = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const markerPattern = () => /^export const FLOWGATE_MODULE_REVISION = '([a-f0-9]{64})'$/gm

/** The literal is excluded, so stamping is stable and CRLF checkouts are equivalent. */
export function moduleSourceRevision(source) {
  const normalized = String(source).replace(/\r\n?/g, '\n')
  const matches = [...normalized.matchAll(markerPattern())]
  if (matches.length !== 1) return ''
  return digest(normalized.replace(markerPattern(), "export const FLOWGATE_MODULE_REVISION = ''"))
}

function moduleRevisions() {
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

export function runtimeState(clientRevision = '', revisions) {
  let expectedClientRevision = ''
  if (!revisions) {
    try { expectedClientRevision = clientFactoryRevision(readFileSync(new URL('./client.js', import.meta.url), 'utf8')) } catch { /* Missing source remains unverified. */ }
  }
  const detected = revisions ?? moduleRevisions()
  const hostRevision = detected.hostRevision
  const diskRevision = detected.diskHostRevision
  expectedClientRevision = detected.expectedClientRevision ?? expectedClientRevision
  const runtime = { hostRevision, diskHostRevision: diskRevision, expectedClientRevision, clientRevision: validRevision(clientRevision) ? clientRevision : '' }
  if (!validRevision(hostRevision) || !validRevision(diskRevision) || !validRevision(expectedClientRevision)) {
    return { ...runtime, status: 'unverified', reason: '无法读取完整运行版本或模块尚未登记，页面生效情况尚未核对。' }
  }
  if (hostRevision !== diskRevision || detected.stale?.length) {
    return { ...runtime, status: 'mismatch', reason: '宿主已加载模块与磁盘源码不一致，或模块 revision 尚未更新；请重新生成标记并重新加载插件后核对。' }
  }
  if (!runtime.clientRevision) {
    return { ...runtime, status: 'unverified', reason: '页面尚未上报实际执行的插件指纹。' }
  }
  if (runtime.clientRevision !== expectedClientRevision) {
    return { ...runtime, status: 'mismatch', reason: '页面执行版本与当前插件文件不一致，需要刷新后核对；构建改写源码也会导致指纹无法匹配。' }
  }
  return { ...runtime, status: 'verified', reason: '页面执行的插件与宿主实际加载模块版本均已核对。' }
}
