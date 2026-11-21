import { posix, win32 } from 'node:path'
import { sameSnapshot } from './provenance.js'
import { registerModuleRevision } from './revisions.js'

export const FLOWGATE_MODULE_REVISION = 'e20b02b1e4001b3364670d5270f678e58a815ce9c2b2a5dfae3fccf53b2bdeda'
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

/**
 * S1 冻结前的验收方案体检。
 *
 * 验收账本只在 S4 才发现「方法与证据不匹配」——那时候开发做完、评审过了，用户只能
 * 带缺口结项或整轮退回。能在 S1 静态确认的矛盾（id 缺失或重复）直接拒绝；只能推断的
 * 风险（声明要跑测试却没有测试命令、集成验收却没有测试文件、视觉验收没写怎么测）
 * 不拦截，但必须让用户在批准 scope 前看见并明确接受。
 */
const TEST_FILE = /(?:^|\/)(?:[^/]*\.(?:test|spec)\.[^/]*|__tests__\/|tests?\/)/i
const TEST_COMMAND = /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\bnode\s+test\/|\b(?:vitest|jest|pytest|mocha|ava|phpunit|rspec)\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bmvn\b[^;&|]*\btest\b|\bgradle\w*\s+test\b|\bmix\s+test\b/i
const MEASURE_HINT = /getBoundingClientRect|测量|实测|左右边界|左右边缘|像素|\bpx\b|measure/i
// 验证步骤里点名要改的文件（带目录的相对路径，例如 test/fixtures/session.ts）。
const PATH_HINT = /[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+\.[A-Za-z0-9]+/g

function scopeCovers(files, target) {
  const want = target.toLowerCase()
  return files.some((file) => {
    const have = file.toLowerCase().replace(/\/+$/, '')
    return have === want || want.startsWith(have + '/')
  })
}

/**
 * 验证步骤里点了名、但冻结范围里没有的文件。
 * 这是 S1 唯一能静态抓到的「scope 与验证方案不相容」：AC 写着要动跨模块夹具，
 * 文件清单却只有主机测试——评审时才发现，只能整轮退回重来。
 */
function procedureOutsideScope(item, files) {
  const text = [item.verification.procedure, item.when, item.then].map((part) => String(part ?? '')).join('\n')
  const mentioned = [...new Set(text.match(PATH_HINT) ?? [])].filter((path) => !scopeCovers(files, path))
  return mentioned
}
const METHOD_LABEL = { unit: '单元测试', integration: '集成测试', visual: '视觉测量', manual: '人工核验' }

function uniqueMethods(items) {
  return [...new Set(items.map((item) => item.verification.method))].map((method) => METHOD_LABEL[method] ?? method).join('、')
}

export function scopeReadiness(criteria, commands, files) {
  const items = normalizeCriteria(criteria)
  const commandList = list(commands).map(text).filter(Boolean)
  const fileList = list(files).map(text).filter(Boolean)
  const blockers = []
  const ids = new Map()
  for (const item of items) {
    if (!item.id) {
      blockers.push({ code: 'missing-id', message: '有一条验收标准没有 id：S4 无法把执行证据关联到它，它永远是未覆盖。' })
      continue
    }
    ids.set(item.id, (ids.get(item.id) || 0) + 1)
  }
  for (const [id, count] of ids) {
    if (count > 1) blockers.push({ code: 'duplicate-id', id, message: '验收标准 id 重复：' + id + '（' + count + ' 条），S4 无法唯一关联执行证据。' })
  }
  const idList = (subset) => subset.map((item) => item.id || '（无 id）')
  const executable = items.filter((item) => item.verification.method === 'unit' || item.verification.method === 'integration')
  const integration = items.filter((item) => item.verification.method === 'integration')
  const visual = items.filter((item) => item.verification.method === 'visual' && !MEASURE_HINT.test(item.verification.procedure))
  const testCommands = commandList.filter((command) => TEST_COMMAND.test(command))
  const testFiles = fileList.filter((file) => TEST_FILE.test(file))
  const risks = []
  if (executable.length && !testCommands.length) {
    risks.push({
      code: 'no-test-command',
      acs: idList(executable),
      message: '这些验收标准声明了可执行验证（' + uniqueMethods(executable) + '），但命令清单里没有能识别的测试命令'
        + (commandList.length ? '（现有 ' + commandList.length + ' 条都不是测试命令）' : '（清单为空）')
        + '：S4 默认跑不起来，它们只能记未覆盖。',
    })
  }
  if (integration.length && !testFiles.length) {
    risks.push({
      code: 'integration-without-test-file',
      acs: idList(integration),
      message: '这些验收标准声明用集成测试验证，但文件清单里没有任何测试文件：集成验收通常要改跨模块夹具；夹具若在 scope 外，S3 评审会要求回 S1 调 scope，这一轮就白做了。',
    })
  }
  // 验证步骤点名要动的文件必须在 scope 内：否则 S3 评审会判「范围外发现」，S4 也改不了。
  const outside = items
    .filter((item) => item.verification.method !== 'manual')
    .map((item) => ({ id: item.id, files: procedureOutsideScope(item, fileList) }))
    .filter((entry) => entry.files.length)
  if (outside.length) {
    risks.push({
      code: 'procedure-file-outside-scope',
      acs: outside.map((entry) => entry.id),
      message: '这些验收标准的验证步骤点名了 scope 之外的文件：' + outside.map((entry) => entry.id + ' → ' + entry.files.join('、')).join('；')
        + '。开发阶段改不了它们，评审也会把相关发现判成范围外；要么把这些文件补进 scope，要么调整验证步骤。',
    })
  }
  if (visual.length) {
    risks.push({
      code: 'visual-without-measurement',
      acs: idList(visual),
      message: '这些验收标准的 procedure 没有写明怎么测（getBoundingClientRect / 左右边界 / 像素容差）：视觉验收只认真实宿主测量，没写清就只能记未覆盖。',
    })
  }
  return { blockers, risks, items, testCommands, testFiles }
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
