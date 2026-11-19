import { posix, win32 } from 'node:path'
import { sameSnapshot } from './provenance.js'
import { registerModuleRevision } from './revisions.js'

export const FLOWGATE_MODULE_REVISION = 'c02c052a34d1c201e5b764b1c2dae54259d8c2564744802949b58148ce9976b3'
registerModuleRevision(import.meta.url, FLOWGATE_MODULE_REVISION)

const METHODS = new Set(['unit', 'integration', 'visual', 'manual'])
const STATUSES = new Set(['pass', 'fail', 'uncovered'])
const text = (value) => typeof value === 'string' ? value.trim() : ''
const list = (value) => Array.isArray(value) ? value : []
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = (value) => typeof value === 'string' && Boolean(value.trim()) && !/[\s\u0000-\u001f\u007f]/u.test(value.trim())

/** Layout assertions need browser measurements, even when CSS source looks plausible. */
function needsMeasurements(criterion) {
  return /宽度|等宽|同宽|对齐|齐平|左右边界|边缘一致|\bwidth\b|\balign(?:ed|ment)?\b|\bsame[ -]width\b|\bequal[ -]width\b/i.test(
    [criterion?.when, criterion?.then].filter((value) => typeof value === 'string').join(' '),
  )
}

/** Preserve one entry per declared criterion: malformed or duplicate IDs stay visible. */
export function normalizeCriteria(criteria) {
  return list(criteria).map((entry) => {
    const source = object(entry) ? entry : {}
    const verification = object(source.verification) ? source.verification : {}
    const method = needsMeasurements(source) ? 'visual' : METHODS.has(verification.method) ? verification.method : 'manual'
    const normalized = {
      id: text(source.id),
      when: typeof source.when === 'string' ? source.when : '',
      then: typeof source.then === 'string' ? source.then : '',
      verification: {
        method,
        procedure: text(verification.procedure) || [text(source.when), text(source.then)].filter(Boolean).join('；'),
      },
    }
    if (method === 'visual') {
      normalized.verification.tolerancePx = typeof verification.tolerancePx === 'number'
        && Number.isFinite(verification.tolerancePx) && verification.tolerancePx >= 0
        ? verification.tolerancePx : 1
    }
    return normalized
  })
}

function currentReport(report, snapshot) {
  return sameSnapshot(report?.snapshot, snapshot)
}

function visualResult(criterion, entry, runtime) {
  if (runtime?.status !== 'verified') return { status: 'uncovered', reason: '运行中的宿主与客户端版本尚未验证' }
  const measuredRuntime = entry.runtime
  if (!text(runtime.hostRevision) || !text(runtime.clientRevision)
    || !object(measuredRuntime) || measuredRuntime.hostRevision !== runtime.hostRevision
    || measuredRuntime.clientRevision !== runtime.clientRevision
    || !text(runtime.pageId) || measuredRuntime.pageId !== runtime.pageId) {
    return { status: 'uncovered', reason: '视觉证据与当前宿主或客户端版本不一致' }
  }
  const viewport = measuredRuntime.viewport
  if (!object(viewport) || !Number.isFinite(viewport.width) || viewport.width <= 0
    || !Number.isFinite(viewport.height) || viewport.height <= 0) {
    return { status: 'uncovered', reason: '视觉证据缺少有效视口尺寸' }
  }
  if (!object(runtime.viewport) || runtime.viewport.width !== viewport.width || runtime.viewport.height !== viewport.height) {
    return { status: 'uncovered', reason: '视觉证据的视口与当前验证环境不一致' }
  }
  if (!needsMeasurements(criterion)) {
    return { status: 'uncovered', reason: '该视觉标准需要对应的真实视觉采集产物；当前布局采集器只验证边界对齐，任意截图路径字符串不能作为通过证据' }
  }
  const measurements = list(entry.measurements)
  if (!measurements.length) return { status: 'uncovered', reason: '宽度或对齐验收缺少实际边界测量，CSS 声明不能证明视觉结果' }
  for (const measurement of measurements) {
    if (!object(measurement) || !text(measurement.element) || !text(measurement.reference)
      || !['left', 'right', 'referenceLeft', 'referenceRight'].every((key) => Number.isFinite(measurement[key]))
      || measurement.right <= measurement.left || measurement.referenceRight <= measurement.referenceLeft) {
      return { status: 'uncovered', reason: '视觉测量缺少具名元素、参考元素或有效矩形边界' }
    }
  }
  const receipt = list(runtime.layoutEvidence).find((item) => text(entry.evidenceId) && item?.id === entry.evidenceId)
  const keys = ['element', 'reference', 'left', 'right', 'referenceLeft', 'referenceRight']
  if (!receipt || receipt.version !== entry.version || receipt.pageId !== runtime.pageId
    || receipt.hostRevision !== runtime.hostRevision || receipt.clientRevision !== runtime.clientRevision
    || receipt.viewport?.width !== viewport.width || receipt.viewport?.height !== viewport.height
    || !Array.isArray(receipt.measurements) || receipt.measurements.length !== measurements.length
    || measurements.some((measurement, index) => keys.some((key) => measurement[key] !== receipt.measurements[index]?.[key]))) {
    return { status: 'uncovered', reason: '缺少与当前版本、页面、视口及测量一致的真实布局采集回执' }
  }
  const tolerance = criterion.verification.tolerancePx
  if (measurements.some((measurement) => Math.abs(measurement.left - measurement.referenceLeft) > tolerance
    || Math.abs(measurement.right - measurement.referenceRight) > tolerance)) {
    return { status: 'fail', reason: '实际左右边界测量超出 ' + tolerance + 'px 容差' }
  }
  return { status: 'pass', reason: '实际左右边界测量均在 ' + tolerance + 'px 容差内' }
}

function evaluate(criterion, entry, report, snapshot, runtime, source) {
  const base = { evidence: text(entry?.evidence), artifact: text(entry?.artifact), version: text(entry?.version) }
  const result = (status, reason) => ({ ...base, status, reason })
  if (!currentReport(report, snapshot)) return result('uncovered', '报告快照不完整或与当前代码版本不一致')
  if (entry?.version !== snapshot.id) return result('uncovered', '验收证据版本与当前代码版本不一致')
  if (!STATUSES.has(entry?.status)) return result('uncovered', '验收证据状态无效')
  if (entry.status !== 'pass') return result(entry.status, entry.status === 'fail' ? '已报告该验收标准未通过' : '该验收标准尚未被验证')
  if (source !== 'test') return result('uncovered', '评审通过不能替代实际执行验证')
  if (!base.evidence) return result('uncovered', '通过结论缺少非空执行证据')
  if (entry.method !== criterion.verification.method) return result('uncovered', '执行验证方法与验收标准声明不匹配')
  if (criterion.verification.method === 'visual') return { ...base, ...visualResult(criterion, entry, runtime) }
  return result('pass', '当前代码版本的执行证据已核验')
}

/** Pure evidence ledger. Aggregate test totals and review passes never prove an AC. */
export function acceptanceLedger(flow, snapshot, runtime = {}) {
  const criteria = normalizeCriteria(flow?.scope?.data?.acceptance_criteria)
  const idCounts = new Map()
  for (const criterion of criteria) idCounts.set(criterion.id, (idCounts.get(criterion.id) || 0) + 1)
  const test = flow?.test
  const review = flow?.review
  const items = criteria.map((criterion) => {
    const base = {
      id: criterion.id, when: criterion.when, then: criterion.then,
      method: criterion.verification.method, procedure: criterion.verification.procedure,
      status: test ? 'uncovered' : 'pending', evidence: '', artifact: '', version: '',
      reason: test ? '已提交测试，但没有该验收标准的执行证据' : '尚未提交该验收标准的执行验证',
    }
    if (!validId(criterion.id)) return { ...base, status: 'uncovered', reason: '验收标准 ID 无效，无法关联执行证据' }
    if (idCounts.get(criterion.id) !== 1) return { ...base, status: 'uncovered', reason: '验收标准 ID 重复，无法唯一关联执行证据' }
    if (!text(criterion.when) || !text(criterion.then)) return { ...base, status: 'uncovered', reason: '验收标准缺少触发条件或预期结果' }
    const testEntries = list(test?.acceptance).filter((entry) => text(entry?.ac) === criterion.id)
    const reviewEntries = list(review?.acceptance).filter((entry) => text(entry?.ac) === criterion.id && entry?.status !== 'pass')
    const evaluated = testEntries.map((entry) => evaluate(criterion, entry, test, snapshot, runtime, 'test'))
    const reviewResults = reviewEntries.map((entry) => evaluate(criterion, entry, review, snapshot, runtime, 'review'))
    // Failures win over positive evidence; duplicate positives cannot silently mask conflicts.
    const failures = [...evaluated, ...reviewResults].filter((entry) => entry.status === 'fail')
    if (failures.length) return { ...base, ...failures[0] }
    if (testEntries.length > 1) return { ...base, status: 'uncovered', reason: '同一验收标准存在重复证据，必须先消除重复或冲突' }
    // Actual execution closes review gaps; current review failures were handled above.
    if (evaluated.length) return { ...base, ...evaluated[0] }
    if (reviewEntries.length > 1) return { ...base, status: 'uncovered', reason: '同一验收标准存在重复评审证据，必须先消除重复或冲突' }
    const reviewGap = reviewResults.find((entry) => entry.status === 'uncovered')
    if (reviewGap) return { ...base, ...reviewGap }
    return base
  })
  const counts = { total: items.length, pending: 0, pass: 0, fail: 0, uncovered: 0 }
  for (const item of items) counts[item.status] += 1
  return { version: text(snapshot?.id), items, counts }
}

function normalizedFile(cwd, file) {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(cwd || '') || /^[a-z]:[\\/]|^\\\\/i.test(file || '')
  const paths = windows ? win32 : posix
  const result = paths.resolve(cwd || '.', file || '').replaceAll('\\', '/')
  return windows ? result.toLowerCase() : result
}

/** Build before clearing reports. The caller owns persistence of this return value. */
export function remediationList(flow, ledger, options = {}) {
  const items = []
  const advisories = []
  const declared = new Map(list(ledger?.items).map((item) => [item.id, item]))
  for (const item of list(ledger?.items)) {
    if (!['fail', 'uncovered', 'pending'].includes(item.status)) continue
    items.push({ ac: item.id, summary: item.reason || item.then || '该验收标准需要重新验证', source: 'acceptance', severity: item.status === 'fail' ? 'MAJOR' : 'MINOR', status: item.status })
  }
  const scope = flow?.scope?.data
  const allowed = new Set(list(scope?.in_scope?.files_expected_to_change ?? scope?.files_expected_to_change)
    .filter((file) => typeof file === 'string' && text(file))
    .map((file) => normalizedFile(flow?.cwd, file)))
  for (const angle of list(flow?.review?.angles)) {
    for (const finding of list(angle?.findings)) {
      const ac = text(finding?.ac)
      const known = validId(ac) && declared.has(ac) && list(ledger?.items).filter((item) => item.id === ac).length === 1
      const inScope = !text(finding?.file) || allowed.has(normalizedFile(flow?.cwd, finding.file))
      const severity = ['CRITICAL', 'MAJOR', 'MINOR'].includes(finding?.severity) ? finding.severity : 'MINOR'
      const entry = {
        ac, summary: text(finding?.summary) || '评审发现需要复核',
        source: 'review', severity, status: known ? declared.get(ac).status : 'uncovered',
      }
      if (known && inScope && severity !== 'MINOR') items.push(entry)
      else advisories.push(entry)
    }
  }
  const rank = { fail: 0, uncovered: 1, pending: 2, pass: 3 }
  const severityRank = { CRITICAL: 0, MAJOR: 1, MINOR: 2 }
  items.sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || severityRank[a.severity] - severityRank[b.severity])
  return { reason: options.reason, note: options.note, at: options.at || new Date().toISOString(), items, advisories }
}

function reportCounts(report, key) {
  const entries = list(report?.[key])
  const reusedIds = new Set(list(report?.reused))
  const reused = entries.filter((entry) => reusedIds.has(entry?.id) || entry?.reused === true).length
  return { fresh: entries.length - reused, reused, total: entries.length }
}

/** Implementation, verification, runtime, and process execution are independent states. */
export function stageSummary(flow, ledger, runtime = {}) {
  const submitted = Boolean(flow?.devChanges)
  const changes = flow?.devChanges || {}
  const files = [...new Set([...list(changes.files), ...list(changes.untracked)]
    .map((file) => typeof file === 'string' ? file : file?.path).filter((file) => typeof file === 'string'))]
  const execution = object(flow?.execution) ? flow.execution : {}
  const status = flow?.cancelled ? 'cancelled' : ['running', 'completed', 'failed', 'cancelled'].includes(execution.status) ? execution.status : 'pending'
  const executionText = { pending: '尚无已确认的执行状态', running: '执行仍在进行，等待最终结果', completed: '执行已完成；验收结果请逐条查看验证状态', failed: '执行失败', cancelled: '执行或流程已取消' }
  const runtimeStatus = text(runtime.status) || 'unverified'
  return {
    implementation: { status: submitted ? 'submitted' : 'pending', text: submitted ? text(flow?.gateNote) || '开发结果已提交，等待逐条验收验证' : '开发结果尚未提交', files },
    verification: { total: 0, pending: 0, pass: 0, fail: 0, uncovered: 0, ...ledger?.counts },
    runtime: { status: runtimeStatus, text: text(runtime.reason) || text(runtime.text) || (runtimeStatus === 'verified' ? '运行中的宿主与客户端版本已验证' : '运行中的宿主与客户端版本尚未验证') },
    execution: { status, text: status === 'cancelled' ? executionText.cancelled : text(execution.text) || executionText[status] },
    review: reportCounts(flow?.review, 'angles'),
    test: reportCounts(flow?.test, 'directions'),
  }
}
