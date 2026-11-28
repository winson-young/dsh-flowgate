import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

// ---------------------------------------------------------------------------
// 门禁模式：auto 没有阻塞项就放行，manual 每一步都等确认。
// 本文件只覆盖新模式本身；每一步都停的旧语义在 host.test.mjs 里。
// ---------------------------------------------------------------------------

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failures.push({ name, error })
    console.log('  FAIL ' + name + '\n       ' + (error?.message ?? error))
  }
}

function makeHost(cwd, sessionId, reviewFindingsFor) {
  const tools = new Map()
  const routes = []
  const handlers = new Map()
  let guard
  const subagents = {
    getProvider(name) { return name === 'spawn' ? { prepareContinuable() {} } : undefined },
    async startActivation({ childId, label }) {
      const checkedFiles = cleanScope().files_expected_to_change
      // 通过宿主注册的最终守卫发起读取，生成生产代码核对的读取痕迹。
      const readEvidence = checkedFiles.map((file) => {
        const attempt = execOf('read', { file_path: file }, undefined, childId)
        assert.equal(guard(attempt), undefined, file)
        const lines = readFileSync(join(cwd, file), 'utf8').trim().split(/\r?\n/)
        return { file, firstLine: lines[0], lastLine: lines.at(-1) }
      })
      const text = JSON.stringify({ verdict: 'advisory', checkedFiles, readEvidence, findings: reviewFindingsFor(label) })
      return {
        childId,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text }] }),
        async dispose() {},
      }
    },
  }
  const shell = {
    resolve(request) {
      return { ...request, resolved: true }
    },
    async run(spec) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: spec.timeoutMs ?? 0,
        // 变更摘要必须带 numstat 段，否则插件判「git 没正常返回」，快照不完整、S2 不会自动放行。
        stdout: { text: ' M src/app.js\n---numstat---\n1\t0\tsrc/app.js\n', truncated: false },
        stderr: { text: '', truncated: false },
      }
    },
  }
  const scoped = {
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => {}
    },
    get(name) {
      if (name === 'shell') return shell
      if (name === 'subagents' && reviewFindingsFor) return subagents
      if (name === 'sessions') return { get: (id) => ({ header: { id, cwd } }) }
      if (name === 'agents') return { get: (id) => ({ followup: () => {} }) }
      return undefined
    },
    tools: {
      guard(check) {
        guard = check
        return () => { guard = undefined }
      },
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    connection: {
      fetch: {
        register(spec) {
          routes.push(spec)
          return () => {}
        },
      },
    },
  }
  apply({ inject: (_names, cb) => cb(scoped) })

  const execOf = (name, args, signal, id = sessionId) => ({
    name,
    arguments: args,
    agent: { session: { header: { id, cwd } } },
    signal,
  })

  // flowgate_doc 必须交代追问结果；这套用例验门禁模式，追问内容给一份默认清单。
  const GRILL = {
    decisions: [{ question: '这次要改到什么程度？', answer: '把追问纪律写进工具文案与提交校验' }],
    assumptions: [],
    open_questions: [],
  }
  // G35 第四层：交件工具立即返回 submitted，等签收由 flowgate_wait 承担。
  // 本文件的用例验的是「门禁模式决定流程走到哪」，所以夹具替用例补上等签收这一步；
  // 拆分本身（交件不等、wait 才中断）在 test/host.test.mjs 的专项用例里单独断言。
  const SUBMIT_TOOLS = new Set(['flowgate_doc', 'flowgate_gate', 'flowgate_review', 'flowgate_test'])
  const chainWait = (name, result) => {
    if (!SUBMIT_TOOLS.has(name) || result?.decision !== 'submitted') return Promise.resolve(result)
    const definition = tools.get('flowgate_wait')
    assert.ok(definition, '工具未注册：flowgate_wait')
    const waitArgs = result.gateId ? { gateId: result.gateId } : {}
    return definition.execute(waitArgs, execOf('flowgate_wait', waitArgs))
  }
  const tool = (name, args, opts = {}) => {
    const definition = tools.get(name)
    assert.ok(definition, '工具未注册：' + name)
    const prepared = name === 'flowgate_doc' ? { ...GRILL, ...args } : args
    return Promise.resolve(definition.execute(prepared, execOf(name, prepared, opts.signal)))
      .then((result) => chainWait(name, result))
  }

  const request = async (path, body) => {
    const pathname = path.split('?')[0]
    const spec = routes.find((r) => r.path === pathname)
    assert.ok(spec, '路由未注册：' + pathname)
    const init = body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }
    const response = await spec.fetch(new Request('http://host' + path, init))
    return { status: response.status, body: await response.json() }
  }

  const state = async () => (await request('/api/flowgate/state?sessionId=' + sessionId)).body
  const act = (action, payload) => request('/api/flowgate/action', { sessionId, action, payload })

  return { tools, routes, shell, tool, request, state, act }
}

// 一个工作区同时只允许一条流程：每个用例开自己的目录，互不干扰。
// scope 里声明的文件要真的存在，否则快照不完整（S2 门禁会因此不自动放行）。
function freshCwd() {
  const dir = mkdtempSync(join(tmpdir(), 'flowgate-gatemode-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'test'), { recursive: true })
  writeFileSync(join(dir, 'src', 'app.js'), 'export const value = 1\n')
  writeFileSync(join(dir, 'test', 'app.test.mjs'), "import assert from 'node:assert/strict'\nassert.equal(1, 1)\n")
  return dir
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

// 一份「体检无阻塞项也无缺口」的 scope：AC 可执行、有对应命令、命令写了来源。
const cleanScope = (over = {}) => ({
  files_expected_to_change: ['src/app.js', 'test/app.test.mjs'],
  commands: ['node --test test/app.test.mjs'],
  command_sources: [{ command: 'node --test test/app.test.mjs', from: 'package.json scripts.test' }],
  capabilities: [],
  out_of_scope_explicitly: [],
  acceptance_criteria: [
    {
      id: 'AC-1',
      when: '改完 src/app.js',
      then: 'node --test 通过',
      verification: { method: 'unit', procedure: '跑 node --test test/app.test.mjs', commands: ['node --test test/app.test.mjs'] },
    },
  ],
  ...over,
})

await check('fast 档默认自动通过', async () => {
  const host = makeHost(freshCwd(), 'sess-default-fast')
  const started = await host.tool('flowgate_start', { brief: '加一个功能', preset: 'fast' })
  assert.equal(started.preset, 'fast')
  assert.equal((await host.state()).gateMode, 'auto')
})

await check('strict 档默认每步确认', async () => {
  const host = makeHost(freshCwd(), 'sess-default-strict')
  const started = await host.tool('flowgate_start', { brief: '大改', preset: 'strict' })
  assert.equal(started.preset, 'strict')
  assert.equal((await host.state()).gateMode, 'manual')
})

await check('自动通过模式下 S1 体检干净就直接冻结，不等用户', async () => {
  const host = makeHost(freshCwd(), 'sess-auto-s1')
  await host.tool('flowgate_start', { brief: '加一个功能', preset: 'fast' })
  const doc = await host.tool('flowgate_doc', { html: '<p>需求</p>', scope: cleanScope() })
  assert.equal(doc.decision, 'approve')
  assert.equal(doc.frozen, true)
  const state = await host.state()
  assert.equal(state.stage, 'S2')
  assert.ok(state.autoPassed?.S1, '自动放行要留痕')
  assert.equal(state.gateBlockers, null)
})

await check('自动通过模式下 S1 有缺口就直接退回，不摆到批准按钮前', async () => {
  const host = makeHost(freshCwd(), 'sess-auto-s1-gap')
  await host.tool('flowgate_start', { brief: '加一个功能', preset: 'fast' })
  // 缺口在提交这一步就退回给 Agent：AC 声明了可执行验证，但清单里只有构建命令、没有测试命令。
  // 自动模式只是少了「等人点确认」，不会把一份体检不过的 scope 端到批准按钮前。
  const buildOnly = cleanScope({
    commands: ['node scripts/build.mjs'],
    command_sources: [],
    acceptance_criteria: [{
      id: 'AC-1',
      when: '改完 src/app.js',
      then: '构建产出版本号',
      verification: { method: 'unit', procedure: '跑 node scripts/build.mjs', commands: ['node scripts/build.mjs'] },
    }],
  })
  await assert.rejects(
    () => host.tool('flowgate_doc', { html: '<p>需求</p>', scope: buildOnly }),
    /提交被退回（第 1\/3 次）/,
  )
  const state = await host.state()
  assert.equal(state.stage, 'S1')
  assert.equal(state.gateMode, 'auto')
  assert.equal(state.doc.pending, false, '带缺口的草稿不进待批准状态')
  assert.match(state.doc.scopeRiskLast.map((item) => item.message).join('|'), /测试命令/)
  assert.equal(state.doc.scopeRiskStrikes.count, 1)
  // 补齐命令后照常冻结：缺口本来就该由 Agent 补，不是让用户签掉。
  const doc = await host.tool('flowgate_doc', { html: '<p>需求</p>', scope: cleanScope() })
  assert.equal(doc.frozen, true)
  assert.equal((await host.state()).stage, 'S2')
})

await check('硬阻塞项当场拒绝提交，不占缺口退回次数', async () => {
  const host = makeHost(freshCwd(), 'sess-auto-s1-blocker')
  await host.tool('flowgate_start', { brief: '加一个功能', preset: 'fast' })
  // AC 引用了清单里没有的命令：这是硬阻塞，不是可累积的缺口——当场拒绝，不写缺口台账。
  await assert.rejects(
    () => host.tool('flowgate_doc', { html: '<p>需求</p>', scope: cleanScope({ commands: [] }) }),
    /scope 的验收标准无法核验/,
  )
  const state = await host.state()
  assert.equal(state.stage, 'S1')
  assert.equal(state.doc.pending, false, '被拒绝的草稿不进待批准状态')
  assert.equal(state.doc.scopeRiskStrikes?.count ?? 0, 0, '硬阻塞不占缺口退回次数')
})

await check('全部 AC 声明人工核验时自动通过会停下', async () => {
  const host = makeHost(freshCwd(), 'sess-auto-s1-manual')
  await host.tool('flowgate_start', { brief: '加一个功能', preset: 'fast' })
  const pending = host.tool('flowgate_doc', {
    html: '<p>需求</p>',
    // 命令清单照留：人工核验不要求测试命令，有命令也不构成缺口。
    scope: cleanScope({
      acceptance_criteria: [
        { id: 'AC-1', when: '人工看', then: '看起来对', verification: { method: 'manual', procedure: '人工核验' } },
      ],
    }),
  })
  await tick()
  const state = await host.state()
  assert.ok(state.gateBlockers?.items?.some((item) => item.includes('人工核验')), '要说明全是人工核验')
  await host.act('doc', { decision: 'approve' })
  assert.equal((await pending).frozen, true)
})

await check('自动通过模式下 S2 快照完整就直接进入 S3', async () => {
  const host = makeHost(freshCwd(), 'sess-auto-s2')
  await host.tool('flowgate_start', { brief: '加一个功能', preset: 'fast' })
  await host.tool('flowgate_doc', { html: '<p>需求</p>', scope: cleanScope() })
  const gate = await host.tool('flowgate_gate', { summary: '开发完成' })
  assert.equal(gate.decision, 'pass')
  // 返回里的 stage 是进入门禁时的阶段，next 才是推进后的阶段。
  assert.equal(gate.stage, 'S2')
  assert.equal(gate.next, 'S3')
  assert.ok((await host.state()).autoPassed?.S2)
})

await check('每步确认下挂起，切成自动通过后当场放行', async () => {
  const host = makeHost(freshCwd(), 'sess-switch-to-auto')
  await host.tool('flowgate_start', { brief: '加一个功能', preset: 'fast' })
  await host.act('setGateMode', { mode: 'manual' })
  const pending = host.tool('flowgate_doc', { html: '<p>需求</p>', scope: cleanScope() })
  await tick()
  assert.equal((await host.state()).doc.pending, true)
  const switched = await host.act('setGateMode', { mode: 'auto' })
  assert.equal(switched.status, 200, JSON.stringify(switched.body))
  const doc = await pending
  assert.equal(doc.frozen, true, '切到自动后要重判并放行')
  assert.equal((await host.state()).stage, 'S2')
})

await check('自动通过因阻塞项停下后切回每步确认仍然等用户', async () => {
  const host = makeHost(freshCwd(), 'sess-switch-to-manual')
  await host.tool('flowgate_start', { brief: '加一个功能', preset: 'fast' })
  // 用「全是人工核验」造一个能提交、但自动模式不会放行的 scope：
  // 缺口类问题在提交这一步就退回给 Agent 了，走不到门禁。
  const pending = host.tool('flowgate_doc', {
    html: '<p>需求</p>',
    scope: cleanScope({
      acceptance_criteria: [
        { id: 'AC-1', when: '人工看', then: '看起来对', verification: { method: 'manual', procedure: '人工核验' } },
      ],
    }),
  })
  await tick()
  assert.ok((await host.state()).gateBlockers?.items?.length)
  await host.act('setGateMode', { mode: 'manual' })
  await tick()
  const state = await host.state()
  assert.equal(state.gateMode, 'manual')
  assert.equal(state.doc.pending, true, '切回手动不能顺手放行')
  await host.act('doc', { decision: 'approve' })
  assert.equal((await pending).frozen, true)
})

await check('非法门禁模式被拒绝且不改流程', async () => {
  const host = makeHost(freshCwd(), 'sess-bad-mode')
  await host.tool('flowgate_start', { brief: '加一个功能', preset: 'fast' })
  const before = (await host.state()).gateMode
  const bad = await host.act('setGateMode', { mode: 'always' })
  assert.equal(bad.status, 409)
  assert.equal((await host.state()).gateMode, before)
})

await check('同一模式重复设置是幂等的', async () => {
  const host = makeHost(freshCwd(), 'sess-same-mode')
  await host.tool('flowgate_start', { brief: '加一个功能', preset: 'fast' })
  const first = await host.act('setGateMode', { mode: 'auto' })
  assert.equal(first.status, 200)
  const second = await host.act('setGateMode', { mode: 'auto' })
  assert.equal(second.status, 200)
  assert.equal((await host.state()).gateMode, 'auto')
})

// 证据门禁：未核实与缺字段分别拦截；零发现和部分未核实不应误拦。
const reviewFinding = (overrides = {}) => ({
  file: 'src/app.js', line: 1, kind: 'defect', severity: 'MINOR', ac: 'AC-1',
  summary: 'value 在失败路径不返回预期', evidence: 'value',
  repro: { when: '调用失败路径', expected: '返回 2', actual: '返回 1' },
  ...overrides,
})
const reviewCases = [
  { name: '全未核实角度', findings: [reviewFinding({ evidence: 'nonexistent' })], status: 409, message: /全部未核实/, skipped: ['correctness'] },
  { name: '部分未核实角度', findings: [reviewFinding(), reviewFinding({ evidence: 'nonexistent' })], status: 200, skipped: [] },
  { name: '零发现角度', findings: [], status: 200, skipped: [] },
  { name: '严重缺字段条目', findings: [reviewFinding({ severity: 'MAJOR', counter: undefined })], status: 409, message: /缺少证据字段被丢弃/, skipped: [] },
]
for (const [index, sample] of reviewCases.entries()) {
  await check('评审证据门禁：' + sample.name, async () => {
    const host = makeHost(freshCwd(), 'sess-evidence-' + index)
    await host.tool('flowgate_start', { brief: '核对评审证据', preset: 'strict' })
    const doc = host.tool('flowgate_doc', { html: '<p>证据</p>', scope: cleanScope() })
    await tick()
    assert.equal((await host.act('doc', { decision: 'approve' })).status, 200)
    await doc
    const dev = host.tool('flowgate_gate', {})
    await tick()
    assert.equal((await host.act('gate', { decision: 'pass' })).status, 200)
    await dev
    const review = host.tool('flowgate_review', { angles: [{ id: 'correctness', name: '正确性', verdict: 'advisory', findings: sample.findings }] })
    await tick()
    const current = await host.state()
    if (sample.name === '严重缺字段条目') {
      assert.deepEqual(current.review.angles[0].rejectedFindings[0].missing, ['counter.attempt', 'counter.survived'])
      assert.equal(Object.hasOwn(current.review.angles[0].rejectedFindings[0], 'summary'), false)
      assert.equal(Object.hasOwn(current.review.angles[0].rejectedFindings[0], 'file'), false)
    }
    const response = await host.act('gate', { decision: 'pass' })
    assert.equal(response.status, sample.status, JSON.stringify(response.body))
    if (sample.message) assert.match(response.body.error, sample.message)
    if (sample.status === 409) {
      const skipped = await host.act('gate', { decision: 'skip' })
      assert.equal(skipped.status, 200, JSON.stringify(skipped.body))
      assert.deepEqual((await host.state()).review.skippedUnverified ?? [], sample.skipped)
    }
    await review
  })
}

// 多角度时的量词边界：被拦的只有「全未核实」的那个角度，跳过也只记它的名。
// 把已核实的角度也写进拦截文案，等于让人去补本来就有的证据。
await check('评审证据门禁：多角度只拦未核实的那个并只记它的名', async () => {
  const host = makeHost(freshCwd(), 'sess-evidence-multi')
  await host.tool('flowgate_start', { brief: '多角度证据核对', preset: 'strict' })
  const doc = host.tool('flowgate_doc', { html: '<p>多角度</p>', scope: cleanScope() })
  await tick()
  assert.equal((await host.act('doc', { decision: 'approve' })).status, 200)
  await doc
  const dev = host.tool('flowgate_gate', {})
  await tick()
  assert.equal((await host.act('gate', { decision: 'pass' })).status, 200)
  await dev
  const review = host.tool('flowgate_review', { angles: [
    { id: 'correctness', name: '正确性', verdict: 'advisory', findings: [reviewFinding({ evidence: 'nonexistent' })] },
    { id: 'security', name: '安全', verdict: 'advisory', findings: [reviewFinding()] },
  ] })
  await tick()
  const blocked = await host.act('gate', { decision: 'pass' })
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body))
  assert.match(blocked.body.error, /：正确性；/)
  assert.ok(!/、安全/.test(blocked.body.error), blocked.body.error)
  assert.ok(!/：安全/.test(blocked.body.error), blocked.body.error)
  const skipped = await host.act('gate', { decision: 'skip' })
  assert.equal(skipped.status, 200, JSON.stringify(skipped.body))
  assert.deepEqual((await host.state()).review.skippedUnverified ?? [], ['correctness'])
  await review
})

// AC-3 从子代理文本报告入口走到状态与确认 API，覆盖超限角度与有效角度共存。
for (const count of [201, 200]) {
  await check('AC-3 子代理评审门禁：单角度 ' + count + ' 条发现', async () => {
    const host = makeHost(freshCwd(), 'sess-review-limit-' + count, (label) => {
      if (label === '评审：正确性') {
        return Array.from({ length: count }, (_, index) => reviewFinding({ summary: '边界发现 ' + (index + 1) }))
      }
      return [reviewFinding({ summary: '另一角度的有效发现' })]
    })
    await host.tool('flowgate_start', { brief: '验证子代理评审发现上限', preset: 'fast' })
    assert.equal((await host.tool('flowgate_doc', { html: '<p>评审发现上限</p>', scope: cleanScope() })).frozen, true)
    assert.equal((await host.tool('flowgate_gate', {})).next, 'S3')

    const controller = new AbortController()
    const review = host.tool('flowgate_review_run', {}, { signal: controller.signal })
    // 在状态查询期间已拒绝时避免未处理的拒绝，最终仍直接等待原调用。
    void review.catch(() => {})
    try {
      await tick()
      const state = await host.state()
      assert.equal(state.review?.by, 'subagents')
      assert.equal(state.review.angles.length, 2)
      const boundary = state.review.angles.find((angle) => angle.id === 'correctness')
      const sibling = state.review.angles.find((angle) => angle.id === 'tests')
      assert.notEqual(sibling.coverage, 'uncovered')
      assert.equal(sibling.executionError, undefined)
      assert.deepEqual(sibling.findings.map((finding) => finding.summary), ['另一角度的有效发现'])
      assert.equal(state.review.blocking, 0)
      const expectedTotal = count === 201 ? 1 : 201
      assert.equal(state.review.counts.total, expectedTotal)
      assert.equal(state.review.counts.minor, expectedTotal)
      assert.equal(state.review.counts.advisories, expectedTotal)
      assert.equal(state.review.counts.unverified, 0)

      if (count === 201) {
        assert.equal(boundary.coverage, 'uncovered')
        assert.match(boundary.executionError, /正确性.*201.*条/)
        assert.deepEqual(boundary.findings, [])
        assert.equal(state.stage, 'S3')
        assert.equal(state.waitingKind, 'gate')
        assert.equal(state.autoPassed?.S3, undefined)
        const blocked = await host.act('gate', { decision: 'pass' })
        assert.equal(blocked.status, 409, JSON.stringify(blocked.body))
        const uncoveredDiagnostic = '评审角度仍有目标文件未检查、读取失败或证据字段不完整'
        const reviewAdvice = '请重新评审，不能通过评审'
        assert.ok(state.gateBlockers?.items.some((reason) => reason.includes(uncoveredDiagnostic) && reason.includes(reviewAdvice)),
          '自动通过拒绝理由必须包含既有未覆盖角度诊断与重评建议')
        assert.ok(blocked.body.error.includes(uncoveredDiagnostic), '普通通过拒绝理由必须包含既有未覆盖角度诊断')
        assert.ok(blocked.body.error.includes(reviewAdvice), '普通通过拒绝理由必须包含重评建议')
        assert.ok(state.gateBlockers?.items.includes(blocked.body.error), '自动与普通通过应由同一原因拦截')
        assert.equal((await host.state()).stage, 'S3')

        const skipped = await host.act('gate', { decision: 'skip' })
        assert.equal(skipped.status, 200, JSON.stringify(skipped.body))
      } else {
        assert.notEqual(boundary.coverage, 'uncovered')
        assert.equal(boundary.executionError, undefined)
        assert.deepEqual(boundary.findings.map((finding) => finding.summary),
          Array.from({ length: count }, (_, index) => '边界发现 ' + (index + 1)))
        assert.ok(state.autoPassed?.S3)
        assert.equal(state.stage, 'S4')
      }
      const result = await review
      assert.equal(result.decision, count === 201 ? 'skip' : 'pass')
      assert.equal(result.next, 'S4')
      if (count === 201) {
        const after = await host.state()
        assert.equal(after.stages.find((stage) => stage.id === 'S3').status, 'skipped_by_user')
        assert.deepEqual(after.review.skippedUnverified ?? [], [])
        assert.equal(after.review.angles.find((angle) => angle.id === 'correctness').coverage, 'uncovered')
      }
    } finally {
      controller.abort()
      await review.catch(() => {})
    }
  })
}

console.log('\n全部通过：' + passed + ' 项')
if (failures.length) {
  console.log('失败：' + failures.length + ' 项')
  for (const item of failures) console.log(' - ' + item.name + '：' + (item.error?.stack ?? item.error))
  process.exitCode = 1
}
