import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCriteria, acceptanceLedger, grillReadiness, remediationList, scopeReadiness, stageSummary } from '../lib/acceptance.js'

const snapshot = { id: 'a'.repeat(64), complete: true }
const runtime = { status: 'verified', hostRevision: 'host-v1', clientRevision: 'client-v1', pageId: 'page-1', viewport: { width: 1440, height: 900 } }
const unit = { id: 'AC-1', when: '提交有效请求', then: '返回成功结果', verification: { method: 'unit', procedure: '运行请求断言' } }
const layout = { id: 'AC-2', when: '打开桌面界面', then: '输入框与表格左右对齐，宽度相同' }
const visual = { id: 'AC-3', when: '打开界面', then: '按钮颜色符合设计', verification: { method: 'visual', procedure: '核对截图' } }
const flowOf = (criteria = [unit]) => ({ cwd: 'D:/Projects/demo', scope: { data: { acceptance_criteria: criteria, in_scope: { files_expected_to_change: ['src/ui.js'] } } } })
const evidence = (ac = 'AC-1', overrides = {}) => ({ ac, status: 'pass', method: 'unit', evidence: '实际运行断言：1 项通过', version: snapshot.id, ...overrides })
const report = (acceptance, overrides = {}) => ({ snapshot: { ...snapshot }, acceptance, ...overrides })
const layoutEvidenceId = 'a0a0a0a0-1111-4111-8111-a0a0a0a0a0a0'
const measured = (overrides = {}) => evidence('AC-2', { evidenceId: layoutEvidenceId, method: 'visual', evidence: '浏览器 getBoundingClientRect 实际测量', runtime: { hostRevision: runtime.hostRevision, clientRevision: runtime.clientRevision, pageId: runtime.pageId, viewport: { ...runtime.viewport } }, measurements: [{ element: 'input', reference: 'table', left: 24, right: 800, referenceLeft: 24, referenceRight: 800 }], ...overrides })
const receiptFor = (entry, overrides = {}) => ({ id: entry.evidenceId, version: entry.version, ...entry.runtime, measurements: structuredClone(entry.measurements), at: '2026-11-19T15:00:00.000Z', ...overrides })
// 模拟宿主采集回执；每次修改几何数据的试验都显式提供对应回执。
runtime.layoutEvidence = [receiptFor(measured())]
const statusOf = (flow, current = snapshot, live = runtime) => acceptanceLedger(flow, current, live).items[0].status

test('规范化兼容旧 scope，保留声明内容且默认明显布局要求为 visual', () => {
  const normalized = normalizeCriteria([layout, { id: '旧验收', when: '出现错误', then: '显示提示' }, unit])
  assert.equal(normalized[0].verification.method, 'visual')
  assert.equal(normalized[0].verification.tolerancePx, 1)
  assert.equal(normalized[0].when, layout.when)
  assert.equal(normalized[0].then, layout.then)
  assert.ok(normalized[0].verification.procedure)
  assert.equal(normalized[1].verification.method, 'manual')
  assert.deepEqual(normalized[2], unit)
  assert.deepEqual(normalizeCriteria(null), [])
  assert.equal(normalizeCriteria([{ ...layout, verification: { tolerancePx: -1 } }])[0].verification.tolerancePx, 1)
  assert.equal(normalizeCriteria([{ ...layout, verification: { method: 'visual', tolerancePx: 0 } }])[0].verification.tolerancePx, 0)
})

test('冻结前的验收方案体检：集成验收缺测试文件与命令时给出缺口，不拦截', () => {
  const criteria = [
    { id: 'AC-1', when: '跨模块调用', then: '夹具联动成功', verification: { method: 'integration', procedure: '运行集成用例' } },
  ]
  const readiness = scopeReadiness(criteria, [], ['src/auth/session.ts'])
  assert.deepEqual(readiness.blockers, [])
  assert.deepEqual(readiness.risks.map((item) => item.code), ['no-test-command', 'integration-without-test-file'])
  assert.deepEqual(readiness.risks[0].acs, ['AC-1'])
  assert.match(readiness.risks[0].message, /声明了可执行验证（集成测试）/)
  assert.match(readiness.risks[0].message, /清单为空/)
  assert.match(readiness.risks[1].message, /没有任何测试文件/)
  assert.match(readiness.risks[1].message, /S3 评审会要求回 S1 调 scope/)
})

test('清单写对了但机器上没有这个可执行体时给出缺口，仓库没声明该生态就不误报', () => {
  const criteria = [{ id: 'AC-1', when: '跑测试', then: '全部通过', verification: { method: 'unit', procedure: '运行用例' } }]
  const project = (ecosystems, found) => ({
    ecosystems,
    resolveExecutable: (token) => ({ found: found.includes(token), path: found.includes(token) ? '/usr/bin/' + token : null, source: 'path' }),
  })
  const missing = scopeReadiness(criteria, ['node test/host.test.mjs', 'php -l index.php'], ['test/host.test.mjs'], {
    project: project(['node'], []),
  })
  assert.deepEqual(missing.risks.map((item) => item.code), ['command-runtime-missing'])
  assert.deepEqual(missing.risks[0].commands, ['node test/host.test.mjs'])
  assert.match(missing.risks[0].message, /找不到/)
  assert.match(missing.risks[0].message, /绝对路径/)
  // php 没在仓库里声明：空目录里写 php 命令无从判断，跳过比误报有用。
  assert.ok(!missing.risks[0].commands.includes('php -l index.php'))
  // 找得到就不报；绝对路径与登记名同样按可执行体核对。
  const found = scopeReadiness(criteria, ['node test/host.test.mjs'], ['test/host.test.mjs'], {
    project: project(['node'], ['node']),
  })
  assert.deepEqual(found.risks.map((item) => item.code), ['no-test-command'].filter(() => false))
  // 没有 project 时整条检查不参与：老调用点与未知工作区不受影响。
  assert.deepEqual(scopeReadiness(criteria, ['node test/x.mjs'], ['test/x.mjs']).risks, [])
})

test('验证步骤点名 scope 外的文件时给出缺口，点名的文件已在 scope 内就不再提示', () => {
  const criteria = [{
    id: 'AC-1',
    when: '跨模块联动',
    then: '夹具一起跑通',
    verification: { method: 'integration', procedure: '先改 test/fixtures/session.ts，再运行 test/integration.test.mjs' },
  }]
  const outside = scopeReadiness(criteria, ['npm test'], ['test/integration.test.mjs'])
  const risk = outside.risks.find((item) => item.code === 'procedure-file-outside-scope')
  assert.ok(risk, JSON.stringify(outside.risks))
  assert.deepEqual(risk.acs, ['AC-1'])
  assert.match(risk.message, /test\/fixtures\/session\.ts/)
  assert.doesNotMatch(risk.message, /test\/integration\.test\.mjs/)
  // 目录级覆盖也算：scope 列了 test/ 就把下面的文件都算在内。
  const covered = scopeReadiness(criteria, ['npm test'], ['test/integration.test.mjs', 'test/'])
  assert.deepEqual(covered.risks.map((item) => item.code), [])
  // 人工核验不需要动文件，不该被这条规则误伤。
  const manual = [{ id: 'AC-2', when: '看界面', then: '观感正常', verification: { method: 'manual', procedure: '人工核对 src/a.ts 的文案' } }]
  assert.deepEqual(scopeReadiness(manual, [], []).risks.map((item) => item.code), [])
})

test('清单里已经有测试文件时不再报「没有测试文件」', () => {
  const criteria = [{ id: 'AC-1', when: '跨模块调用', then: '夹具联动成功', verification: { method: 'integration', procedure: '运行集成用例' } }]
  const readiness = scopeReadiness(criteria, ['npm test'], ['test/host.test.mjs'])
  assert.deepEqual(readiness.risks, [])
})

test('补全命令与测试文件后体检无缺口', () => {
  const criteria = [
    { id: 'AC-1', when: '跨模块调用', then: '夹具联动成功', verification: { method: 'integration', procedure: '运行集成用例' } },
    { id: 'AC-2', when: '提交请求', then: '返回成功', verification: { method: 'unit', procedure: '跑单测' } },
  ]
  const readiness = scopeReadiness(criteria, ['npm test'], ['test/integration.test.mjs'])
  assert.deepEqual(readiness.blockers, [])
  assert.deepEqual(readiness.risks, [])
  assert.deepEqual(readiness.testCommands, ['npm test'])
  assert.deepEqual(readiness.testFiles, ['test/integration.test.mjs'])
})

test('视觉验收没写测量方式时给出缺口，写了就不再提示', () => {
  const vague = [{ id: 'AC-1', when: '打开界面', then: '按钮居中', verification: { method: 'visual', procedure: '看一下' } }]
  assert.deepEqual(scopeReadiness(vague, [], []).risks.map((item) => item.code), ['visual-without-measurement'])
  const measured = [{ id: 'AC-1', when: '打开界面', then: '按钮居中', verification: { method: 'visual', procedure: '用 getBoundingClientRect 量左右边界，容差 1px' } }]
  assert.deepEqual(scopeReadiness(measured, [], []).risks, [])
})

test('追问体检：未决问题没问完、决策缺半边、什么都没澄清都直接拒绝提交', () => {
  const agreed = grillReadiness(
    [{ question: '追问纪律落在哪一层？', answer: '工具参数加提交校验，不只写在提示词里' }],
    ['不新增依赖'],
    [],
  )
  assert.deepEqual(agreed.blockers, [])
  assert.equal(agreed.decisions[0].question, '追问纪律落在哪一层？')
  assert.deepEqual(agreed.assumptions, ['不新增依赖'])

  const pending = grillReadiness([{ question: '问什么', answer: '定什么' }], [], ['失败后要不要自动重试'])
  assert.deepEqual(pending.blockers.map((item) => item.code), ['open-questions-remain'])
  assert.match(pending.blockers[0].message, /失败后要不要自动重试/)
  assert.match(pending.blockers[0].message, /需求文档不是记录待定的地方/)

  const half = grillReadiness([{ question: '只问了问题' }, { answer: '只写了结论' }], [], [])
  assert.deepEqual(half.blockers.map((item) => item.code), ['incomplete-decision'])
  assert.match(half.blockers[0].message, /缺 question 或 answer/)

  assert.deepEqual(grillReadiness([], [], []).blockers.map((item) => item.code), ['nothing-clarified'])
  // 只写假设、一条决策都没有也算澄清过：确实无需追问时允许这么提交。
  assert.deepEqual(grillReadiness([], ['沿用现有门禁语义'], []).blockers, [])
  // 空白条目不算数，别让空字符串把 open_questions 骗成已问清。
  assert.deepEqual(grillReadiness([{ question: '问', answer: '答' }], [], ['  ']).blockers, [])
})

test('id 缺失或重复是硬阻塞，不是风险', () => {
  const readiness = scopeReadiness([
    { when: '没有 id', then: '无法关联证据', verification: { method: 'unit', procedure: '跑单测' } },
    { id: 'AC-1', when: 'a', then: 'b', verification: { method: 'unit', procedure: '跑单测' } },
    { id: 'AC-1', when: 'c', then: 'd', verification: { method: 'unit', procedure: '跑单测' } },
  ], ['npm test'], ['test/a.test.mjs'])
  assert.deepEqual(readiness.blockers.map((item) => item.code), ['missing-id', 'duplicate-id'])
  assert.match(readiness.blockers[0].message, /没有 id/)
  assert.match(readiness.blockers[1].message, /AC-1（2 条）/)
})

test('提交测试之前为 pending，旧测试总数和方向通过不转为 AC 通过', () => {
  const flow = flowOf()
  assert.equal(statusOf(flow), 'pending')
  flow.test = { failed: 0, directions: [{ id: 'functional', points: [{ result: 'pass' }] }] }
  assert.equal(statusOf(flow), 'uncovered')
  assert.deepEqual(acceptanceLedger(flow, snapshot).counts, { total: 1, pending: 0, pass: 0, fail: 0, uncovered: 1, excluded: 0 })
})

test('只有当前版本的 test 证据可以证明通过，review pass 不算执行', () => {
  const flow = flowOf()
  flow.review = report([evidence()])
  assert.equal(statusOf(flow), 'pending')
  flow.test = report([evidence()])
  assert.equal(statusOf(flow), 'pass')
  assert.equal(acceptanceLedger(flow, snapshot).items[0].version, snapshot.id)
})

test('代码变化使旧报告证据失效，同路径同测试总数不能续用', () => {
  const flow = flowOf()
  flow.test = report([evidence()])
  const changed = { id: 'b'.repeat(64), complete: true }
  assert.equal(statusOf(flow, changed), 'uncovered')
  flow.test.snapshot = { ...changed }
  assert.equal(statusOf(flow, changed), 'uncovered')
  flow.test.acceptance[0].version = changed.id
  assert.equal(statusOf(flow, changed), 'pass')
})

test('报告和当前快照必须都有同 ID 且明确完整', () => {
  for (const invalid of [undefined, {}, { id: snapshot.id }, { id: snapshot.id, complete: false }, { id: 'other', complete: true }]) {
    const flow = flowOf()
    flow.test = report([evidence()], { snapshot: invalid })
    assert.equal(statusOf(flow), 'uncovered')
  }
  const flow = flowOf()
  flow.test = report([evidence()])
  for (const invalid of [undefined, {}, { id: snapshot.id }, { id: snapshot.id, complete: false }, { id: '', complete: true }]) {
    assert.equal(statusOf(flow, invalid ?? {}), 'uncovered')
  }
})

test('证据必须包含匹配的方法、非空文字和当前版本', () => {
  for (const override of [{ evidence: '' }, { evidence: '  ' }, { evidence: 42 }, { method: 'manual' }, { version: 'old' }, { version: undefined }, { status: 'completed' }]) {
    const flow = flowOf()
    flow.test = report([evidence('AC-1', override)])
    assert.equal(statusOf(flow), 'uncovered')
  }
})

test('无效 ID、重复 scope ID、未知 AC、重复或冲突证据均不能误通过', () => {
  for (const id of ['', ' ', 'AC 1', 12, null]) {
    const flow = flowOf([{ ...unit, id }])
    flow.test = report([evidence(id)])
    assert.equal(statusOf(flow), 'uncovered')
  }
  const flow = flowOf([unit, { ...unit }])
  flow.test = report([evidence()])
  assert.equal(acceptanceLedger(flow, snapshot).counts.pass, 0)
  assert.equal(acceptanceLedger(flow, snapshot).counts.uncovered, 2)
  flow.scope.data.acceptance_criteria = [unit]
  flow.test = report([evidence('unknown')])
  assert.equal(statusOf(flow), 'uncovered')
  flow.test = report([evidence(), evidence()])
  assert.equal(statusOf(flow), 'uncovered')
  flow.test = report([evidence(), evidence('AC-1', { status: 'fail', evidence: '实际断言失败' })])
  assert.equal(statusOf(flow), 'fail')
  flow.test = report([evidence(), evidence('AC-1', { status: 'uncovered' })])
  assert.equal(statusOf(flow), 'uncovered')
})

test('有效当前 test pass 关闭 review uncovered，review fail 仍优先', () => {
  const flow = flowOf()
  flow.review = report([evidence('AC-1', { status: 'uncovered' })])
  assert.equal(statusOf(flow), 'uncovered')
  flow.test = report([evidence('AC-1', { version: 'old' })])
  assert.equal(statusOf(flow), 'uncovered')
  flow.test = report([evidence()])
  assert.equal(statusOf(flow), 'pass')
  flow.review.acceptance.push(evidence('AC-1', { status: 'uncovered' }))
  assert.equal(statusOf(flow), 'pass', '重复的旧缺口也由实际执行证据关闭')
  flow.review = report([evidence('AC-1', { status: 'fail' })])
  assert.equal(statusOf(flow), 'fail')
  flow.review = report([evidence('AC-1', { status: 'fail', version: 'old' })], { snapshot: { id: 'old', complete: true } })
  assert.equal(statusOf(flow), 'pass')
})

test('布局 AC 误标 unit、integration 或 manual 也不能用 CSS 断言绕过视觉实测', () => {
  for (const method of ['unit', 'integration', 'manual']) {
    const criterion = { ...layout, verification: { method, procedure: '断言 CSS width:100%' } }
    assert.equal(normalizeCriteria([criterion])[0].verification.method, 'visual')
    const flow = flowOf([criterion])
    flow.test = report([evidence('AC-2', { method, evidence: 'CSS width:100% 断言通过' })])
    assert.equal(statusOf(flow), 'uncovered')
    flow.test = report([measured({ measurements: undefined })])
    assert.equal(statusOf(flow), 'uncovered')
    flow.test = report([measured()])
    assert.equal(statusOf(flow), 'pass')
  }
})

test('CSS 字符串或截图不能证明对齐，必须包含实际几何测量', () => {
  const flow = flowOf([layout])
  flow.test = report([measured({ measurements: undefined, evidence: 'width:100%; margin-left:0', artifact: 'screenshot.png' })])
  const item = acceptanceLedger(flow, snapshot, runtime).items[0]
  assert.equal(item.status, 'uncovered')
  assert.match(item.reason, /实际边界测量/)
})

test('完整当前版本实际测量可通过，左右两边分别比较并支持声明容差', () => {
  const flow = flowOf([layout])
  flow.test = report([measured()])
  assert.equal(statusOf(flow), 'pass')
  flow.test.acceptance[0].measurements[0].left = 25
  flow.test.acceptance[0].measurements[0].right = 799
  const live = { ...runtime, layoutEvidence: [receiptFor(flow.test.acceptance[0])] }
  assert.equal(statusOf(flow, snapshot, live), 'pass')
  flow.scope.data.acceptance_criteria[0] = { ...layout, verification: { method: 'visual', tolerancePx: 0 } }
  assert.equal(statusOf(flow, snapshot, live), 'fail')
  flow.scope.data.acceptance_criteria[0].verification.tolerancePx = 2
  assert.equal(statusOf(flow, snapshot, live), 'pass')
})

test('视觉测量任一左右边超差即 fail，相同宽度但整体错位不能通过', () => {
  for (const override of [{ left: 26 }, { right: 802 }, { left: 27, right: 803 }]) {
    const flow = flowOf([layout])
    const entry = measured()
    Object.assign(entry.measurements[0], override)
    flow.test = report([entry])
    const live = { ...runtime, layoutEvidence: [receiptFor(entry)] }
    assert.equal(statusOf(flow, snapshot, live), 'fail')
  }
})

test('视觉测量必须有限、矩形有效且具名，所有测量均需有效', () => {
  for (const override of [{ left: NaN }, { right: Infinity }, { referenceLeft: '24' }, { referenceRight: null }, { right: 24 }, { right: 23 }, { referenceRight: 24 }, { element: '' }, { reference: ' ' }]) {
    const flow = flowOf([layout])
    const entry = measured()
    entry.measurements.push({ ...entry.measurements[0], ...override })
    flow.test = report([entry])
    assert.equal(statusOf(flow), 'uncovered')
  }
})

test('视觉证据要求 verified 运行态、宿主客户端版本吻合及有效视口', () => {
  const flow = flowOf([layout])
  flow.test = report([measured()])
  for (const live of [{}, { ...runtime, status: 'pending' }, { ...runtime, hostRevision: 'host-v2' }, { ...runtime, clientRevision: 'client-v2' }, { ...runtime, hostRevision: '' }]) {
    assert.equal(statusOf(flow, snapshot, live), 'uncovered')
  }
  for (const viewport of [undefined, {}, { width: 0, height: 900 }, { width: '1440', height: 900 }, { width: 1440, height: Infinity }, { width: 1440, height: -1 }]) {
    flow.test = report([measured()])
    flow.test.acceptance[0].runtime.viewport = viewport
    assert.equal(statusOf(flow), 'uncovered')
  }
  flow.test = report([measured()])
  assert.equal(statusOf(flow, snapshot, { ...runtime, viewport: { width: 800, height: 600 } }), 'uncovered')
})

test('视觉通过要求相同非空页面标识，不能以其它页面的测量通过', () => {
  const flow = flowOf([layout])
  flow.test = report([measured()])
  assert.equal(statusOf(flow), 'pass')
  for (const pageId of [undefined, '', ' ', 'another-page']) {
    assert.equal(statusOf(flow, snapshot, { ...runtime, pageId }), 'uncovered')
    flow.test = report([measured()])
    flow.test.acceptance[0].runtime.pageId = pageId
    assert.equal(statusOf(flow), 'uncovered')
    flow.test = report([measured()])
  }
})

test('缺少或无效运行态视口时，即使证据视口有效也不能通过', () => {
  const flow = flowOf([layout])
  flow.test = report([measured()])
  for (const viewport of [undefined, null, {}, { width: 0, height: 900 }, { width: '1440', height: 900 }, { width: 1440, height: Infinity }, { width: 1440, height: -1 }]) {
    assert.equal(statusOf(flow, snapshot, { ...runtime, viewport }), 'uncovered')
  }
  assert.equal(statusOf(flow), 'pass')
})

test('布局通过必须引用当前宿主采集回执，缺失、错页、旧版本或篡改均未覆盖', () => {
  const flow = flowOf([layout])
  const entry = measured()
  flow.test = report([entry])
  assert.equal(statusOf(flow), 'pass')
  for (const layoutEvidence of [undefined, [], [{}], [receiptFor(entry, { id: 'unknown-receipt' })]]) {
    assert.equal(statusOf(flow, snapshot, { ...runtime, layoutEvidence }), 'uncovered')
  }
  for (const evidenceId of [undefined, '', ' ', 'another-receipt']) {
    flow.test = report([measured({ evidenceId })])
    assert.equal(statusOf(flow), 'uncovered')
  }
  flow.test = report([entry])
  for (const overrides of [
    { version: 'b'.repeat(64) }, { pageId: 'another-page' },
    { hostRevision: 'other-host' }, { clientRevision: 'other-client' },
    { viewport: { width: 800, height: 600 } },
    { measurements: [{ ...entry.measurements[0], left: 25 }] },
    { measurements: [] },
  ]) {
    const live = { ...runtime, layoutEvidence: [receiptFor(entry, overrides)] }
    assert.equal(statusOf(flow, snapshot, live), 'uncovered')
  }
  flow.test = report([measured({ measurements: [{ ...entry.measurements[0], right: 799 }] })])
  assert.equal(statusOf(flow), 'uncovered', '手填修改记录不能替代宿主原始采集结果')
})

test('其它视觉尚无真实通用截图采集，任意产物字符串不能证明通过', () => {
  const flow = flowOf([visual])
  const entry = measured({ ac: 'AC-3', measurements: undefined })
  flow.test = report([entry])
  assert.equal(statusOf(flow), 'uncovered')
  for (const artifact of ['does-not-exist.png', 'screenshots/button.png', 'data:image/png;base64,pretend']) {
    entry.artifact = artifact
    assert.equal(statusOf(flow), 'uncovered', '任意产物名称不得充当真实采集和视觉验证')
  }
  entry.evidence = ''
  assert.equal(statusOf(flow), 'uncovered')
})

test('MINOR 只影响评审发现分级，不能把未通过或未覆盖的 AC 变成通过', () => {
  const flow = flowOf()
  flow.test = report([evidence('AC-1', { status: 'fail' })])
  flow.review = report([], { angles: [{ findings: [{ ac: 'AC-1', file: 'src/ui.js', severity: 'MINOR', summary: '视觉缺口' }] }] })
  const ledger = acceptanceLedger(flow, snapshot)
  const remediation = remediationList(flow, ledger, { reason: 'test', note: '重新验证' })
  assert.equal(ledger.items[0].status, 'fail')
  assert.equal(remediation.items[0].ac, 'AC-1')
  assert.equal(remediation.items[0].status, 'fail')
  assert.equal(remediation.advisories.length, 1)
  assert.equal(remediation.reason, 'test')
  assert.equal(remediation.note, '重新验证')
})

test('重做清单保留 AC 缺口及 scope 内归属发现，scope 外与未知归属仅建议', () => {
  const flow = flowOf([unit, layout, { ...unit, id: 'AC-4' }])
  flow.test = report([evidence('AC-1', { status: 'fail' })])
  flow.review = { angles: [{ findings: [
    { ac: 'AC-1', file: 'D:/Projects/demo/src/ui.js', severity: 'MAJOR', summary: '必须修复' },
    { ac: 'AC-1', file: 'src/else.js', severity: 'CRITICAL', summary: '范围外建议' },
    { ac: 'UNKNOWN', file: 'src/ui.js', severity: 'MAJOR', summary: '未知归属建议' },
  ] }] }
  const ledger = acceptanceLedger(flow, snapshot)
  const frozenBefore = structuredClone(flow)
  const result = remediationList(flow, ledger)
  assert.equal(result.items.filter((item) => item.source === 'acceptance').length, 3)
  assert.equal(result.items.filter((item) => item.source === 'review').length, 1)
  assert.equal(result.advisories.length, 2)
  assert.equal(result.items[0].status, 'fail')
  assert.ok(result.items.every((item) => item.summary !== '范围外建议'))
  assert.deepEqual(flow, frozenBefore)
  flow.review = null
  assert.equal(result.advisories.length, 2, '调用方保存清单后可安全清空旧报告')
})

test('Windows 路径按大小写和分隔符规范匹配，不接受目录相似前缀', () => {
  const flow = flowOf()
  flow.review = { angles: [{ findings: [
    { ac: 'AC-1', file: 'd:/projects/DEMO/src/UI.js', severity: 'MAJOR', summary: '相同文件' },
    { ac: 'AC-1', file: 'src/ui.js/../outside.js', severity: 'MAJOR', summary: '不同文件' },
  ] }] }
  const result = remediationList(flow, acceptanceLedger(flow, snapshot))
  assert.equal(result.items.filter((item) => item.source === 'review').length, 1)
  assert.equal(result.advisories.length, 1)
})

test('阶段摘要独立展示开发、验收、运行态、执行及复用数量', () => {
  const flow = flowOf()
  flow.devChanges = { files: ['src/ui.js'], untracked: [{ path: 'src/helper.js' }, 'src/ui.js'] }
  flow.gateNote = '实现已提交，等待浏览器实测'
  flow.execution = { status: 'running', taskId: 'job-1' }
  flow.review = { angles: [{ id: 'new' }, { id: 'old' }], reused: ['old'] }
  flow.test = { directions: [{ id: 'fresh' }, { id: 'reused' }, { id: 'another' }], reused: ['reused'] }
  const summary = stageSummary(flow, acceptanceLedger(flow, snapshot), runtime)
  assert.equal(summary.implementation.status, 'submitted')
  assert.equal(summary.implementation.text, flow.gateNote)
  assert.deepEqual(summary.implementation.files, ['src/ui.js', 'src/helper.js'])
  assert.equal(summary.verification.pass, 0)
  assert.equal(summary.verification.uncovered, 1)
  assert.equal(summary.execution.status, 'running')
  assert.equal(summary.runtime.status, 'verified')
  assert.equal(stageSummary(flow, undefined, { status: 'stale', reason: '客户端版本仍旧' }).runtime.text, '客户端版本仍旧')
  assert.deepEqual(summary.review, { fresh: 1, reused: 1, total: 2 })
  assert.deepEqual(summary.test, { fresh: 2, reused: 1, total: 3 })
})

test('执行摘要保留具体阶段文案，流程或执行取消时固定取消提示', () => {
  const flow = flowOf()
  const ledger = acceptanceLedger(flow, snapshot)
  for (const [status, message] of [
    ['completed', '手工报告已接收；实际执行证据见验收账本'],
    ['completed', '已复用本轮新执行0'],
    ['running', '子代理仍运行'],
    ['failed', '子代理失败'],
  ]) {
    flow.execution = { status, text: message }
    assert.equal(stageSummary(flow, ledger).execution.text, message)
  }
  flow.execution = { status: 'completed', text: '  ' }
  assert.match(stageSummary(flow, ledger).execution.text, /执行已完成/ )
  flow.execution.text = '不可覆盖取消状态的旧文案'
  flow.cancelled = true
  assert.equal(stageSummary(flow, ledger).execution.text, '执行或流程已取消')
  flow.cancelled = false
  flow.execution.status = 'cancelled'
  assert.equal(stageSummary(flow, ledger).execution.text, '执行或流程已取消')
})

test('任务 ID 不代表完成，开发提交与流程取消也不能变成执行成功', () => {
  const flow = flowOf()
  flow.devChanges = { files: [] }
  flow.execution = { taskId: 'job-1' }
  assert.equal(stageSummary(flow, acceptanceLedger(flow, snapshot)).execution.status, 'pending')
  flow.execution = { status: 'completed', taskId: 'job-1' }
  assert.equal(stageSummary(flow, acceptanceLedger(flow, snapshot)).execution.status, 'completed')
  flow.cancelled = true
  assert.equal(stageSummary(flow, acceptanceLedger(flow, snapshot)).execution.status, 'cancelled')
  flow.cancelled = false
  for (const status of ['failed', 'cancelled', 'running']) {
    flow.execution.status = status
    assert.equal(stageSummary(flow, acceptanceLedger(flow, snapshot)).execution.status, status)
  }
})
