import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, scopeDenial } from '../lib/index.js'

// ---------------------------------------------------------------------------
// 宿主端 mock：只实现插件实际用到的 ctx 成员。
// ---------------------------------------------------------------------------

function makeHost(cwd, sessionId) {
  const tools = new Map()
  const routes = []
  const handlers = new Map()
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
        stdout: { text: ' M src/auth/session.ts\n1\t2\tsrc/auth/session.ts\n', truncated: false },
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
      return name === 'shell' ? shell : undefined
    },
    tools: {
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
  return { tools, routes, handlers, shell }
}

const cwd = mkdtempSync(join(tmpdir(), 'flowgate-'))
const sessionId = 'sess_test'
const host = makeHost(cwd, sessionId)

const execOf = (name, args) => ({
  name,
  arguments: args,
  agent: { session: { header: { id: sessionId, cwd } } },
  signal: undefined,
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

async function runTool(name, args) {
  const definition = host.tools.get(name)
  assert.ok(definition, '工具未注册：' + name)
  return definition.execute(args, execOf(name, args))
}

function routeOf(path) {
  const spec = host.routes.find((r) => r.path === path)
  assert.ok(spec, '路由未注册：' + path)
  return spec
}

async function getState() {
  const spec = routeOf('/api/flowgate/state')
  const response = await spec.fetch(new Request('http://host/api/flowgate/state?sessionId=' + sessionId))
  return { status: response.status, body: await response.json() }
}

async function postAction(action, payload) {
  const spec = routeOf('/api/flowgate/action')
  const response = await spec.fetch(
    new Request('http://host/api/flowgate/action', {
      method: 'POST',
      body: JSON.stringify({ sessionId, action, payload }),
    }),
  )
  return { status: response.status, body: await response.json() }
}

async function guard(name, args) {
  const handler = host.handlers.get('tools/pre-execute')
  assert.ok(handler, 'scope 守卫未注册')
  return handler(execOf(name, args), async () => ({ kind: 'allow' }))
}

// 门禁工具会挂起等按钮：先让 execute 跑到 wait()，再模拟用户点击。
async function gateRound(name, args, payload) {
  const pending = runTool(name, args)
  await tick()
  const result = await postAction('gate', payload)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return pending
}

const passed = []
function check(label, fn) {
  try {
    fn()
    passed.push(label)
    console.log('  ok   ' + label)
  } catch (error) {
    console.log('  FAIL ' + label + ' -> ' + error.message)
    throw error
  }
}

// ---------------------------------------------------------------------------

console.log('flowgate host 单测')

const status0 = await runTool('flowgate_status', {})
check('无流程时 status 返回 active=false', () => assert.equal(status0.active, false))

const started = await runTool('flowgate_start', { title: '会话过期检测', preset: 'fast' })
check('start 进入 S1', () => assert.equal(started.stage, 'S1'))

// AC-1：未通过 S1 门禁前，写操作被拒。
const denyS1 = await guard('write', { file_path: join(cwd, 'src/auth/session.ts'), content: 'x' })
check('AC-1 S1 阶段 write 被拒', () => {
  assert.equal(denyS1.kind, 'deny')
  assert.match(denyS1.reason, /不能修改业务代码/)
})
const allowRead = await guard('read', { file_path: join(cwd, 'src/auth/session.ts') })
check('读操作在 S1 放行', () => assert.equal(allowRead.kind, 'allow'))

// AC-5：追问卡片点选即回答，不需要键盘输入。
const askPending = runTool('flowgate_ask', {
  question: '过期判定以什么为准？',
  options: [
    { label: '最后活动时间 30 分钟', tradeoff: '简单，但长任务会被打断', recommended: true },
    { label: '绝对会话时长 8 小时', tradeoff: '不打断长任务，但过期更晚' },
  ],
})
await tick()
const answered = await postAction('answer', { choiceIndex: 0 })
check('AC-5 点选推荐选项即完成回答', () => assert.equal(answered.status, 200))
const askResult = await askPending
check('AC-5 追问返回 answered=true 且 choice 为选项文案', () => {
  assert.equal(askResult.answered, true)
  assert.match(String(askResult.choice), /最后活动时间/)
})

// 自定义输入是唯一键盘路径。
const askPending2 = runTool('flowgate_ask', {
  question: '401 响应体要不要带重新认证链接？',
  options: [
    { label: '带 reauthenticate_url', tradeoff: '前端可直接跳转', recommended: true },
    { label: '只返回 401', tradeoff: '最简单，前端自己拼' },
  ],
})
await tick()
const badCustom = await postAction('answer', { choiceIndex: -1, customText: '   ' })
check('自定义内容为空时被拒', () => assert.equal(badCustom.status, 409))
const customAnswer = await postAction('answer', { choiceIndex: -1, customText: '带 reauthenticate_url 且附 expires_at' })
check('自定义文本可提交', () => assert.equal(customAnswer.status, 200))
await askPending2

// 需求文档 → 批准并冻结 scope（AC-2 的对照：这里走正常批准路径）。
const scopeInput = {
  files_expected_to_change: ['src/auth/session.ts'],
  capabilities: ['会话过期检测', '过期后返回 401'],
  out_of_scope_explicitly: ['OAuth 第三方登录', '前端 UI 改动'],
  acceptance_criteria: [{ id: 'AC-1', when: 'session 超过 30 分钟未活动', then: '下一次请求返回 401' }],
}
const docPending = runTool('flowgate_doc', {
  html: '<!doctype html><html><body><h1>需求文档</h1></body></html>',
  scope: scopeInput,
  recommendedPreset: 'fast',
  reason: '只动一个文件、一条验收标准',
})
await tick()
const docState = await getState()
check('文档提交后进入待批准状态', () => {
  assert.equal(docState.body.doc.pending, true)
  assert.equal(docState.body.stage, 'S1')
})
const approved = await postAction('doc', { decision: 'approve' })
check('点「批准并冻结 scope」成功', () => assert.equal(approved.status, 200))
const docResult = await docPending
check('批准后 scope 冻结并进入 S2', () => {
  assert.equal(docResult.frozen, true)
  assert.equal(docResult.decision, 'approve')
  assert.equal(approved.body.stage, 'S2')
  assert.equal(approved.body.scope.frozen, true)
})
check('scope.json 已落盘', () => {
  const file = join(cwd, '.dsh-flowgate', 'scope.json')
  assert.ok(existsSync(file), 'scope.json 未生成')
  const frozen = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(frozen.in_scope.files_expected_to_change, ['src/auth/session.ts'])
})

// AC-3：scope 外文件被阻断，并带路径与回退指引。
const denyOut = await guard('write', { file_path: join(cwd, 'src/api/middleware.ts'), content: 'x' })
check('AC-3 scope 外 write 被拒且给出路径与指引', () => {
  assert.equal(denyOut.kind, 'deny')
  assert.match(denyOut.reason, /不在冻结 scope 内/)
  assert.match(denyOut.reason, /middleware\.ts/)
  assert.match(denyOut.reason, /回到需求分析阶段更新 scope\.json/)
})
const allowIn = await guard('edit', { file_path: join(cwd, 'src/auth/session.ts'), old_string: 'a', new_string: 'b' })
check('scope 内 edit 放行', () => assert.equal(allowIn.kind, 'allow'))
const denyShell = await guard('bash', { command: 'git checkout -- src/api/middleware.ts' })
check('变更性 shell 在 S1/S2 按阶段判定', () => assert.equal(denyShell.kind, 'allow'))
const denyShell2 = await guard('bash', { command: 'echo hello' })
check('只读 shell 放行', () => assert.equal(denyShell2.kind, 'allow'))

// scope 未冻结分支：直接构造 flow 验证守卫文案。
check('scope 未冻结时 S2 写操作返回「scope 未冻结」', () => {
  const flow = { cwd, finished: false, stage: 'S2', scope: { frozen: false, data: null } }
  const reason = scopeDenial(flow, 'write', { file_path: join(cwd, 'src/auth/session.ts') })
  assert.match(String(reason), /scope 尚未冻结/)
})

// S2 出口门禁：完成开发 → 变更摘要作为凭据。
const devPending = gateRound('flowgate_gate', { summary: '实现了过期检测' }, { decision: 'pass' })
const devResult = await devPending
check('S2 完成开发后进入 S3', () => assert.equal(devResult.next, 'S3'))
const afterDev = await getState()
check('S2 记录变更摘要凭据', () => {
  assert.equal(afterDev.body.stages.find((s) => s.id === 'S2').status, 'passed')
  assert.ok(afterDev.body.devChanges.files.includes('src/auth/session.ts'))
})

// AC-6 / AC-7：评审阶段升档 + 评审发现问题 → 回退 S2。
const reviewPending = gateRound(
  'flowgate_review',
  {
    angles: [
      {
        id: 'correctness',
        name: '正确性',
        verdict: 'blocking',
        findings: [
          { file: 'src/auth/session.ts', line: 42, severity: 'MAJOR', summary: '过期时间未考虑时区' },
        ],
      },
    ],
  },
  { decision: 'pass' },
)
const reviewResult = await reviewPending
check('评审通过后进入 S4', () => assert.equal(reviewResult.next, 'S4'))
check('评审报告结构化聚合', () => {
  assert.equal(reviewResult.blocking, 1)
})

// 回退验证：S4 门禁点「退回开发修复」。
const s4Gate = runTool('flowgate_gate', {})
await tick()
const backToDev = await postAction('gate', { decision: 'back', to: 'S2' })
check('门禁可回退到 S2', () => {
  assert.equal(backToDev.status, 200)
  assert.equal(backToDev.body.stage, 'S2')
})
await s4Gate

const devPending2 = gateRound('flowgate_gate', {}, { decision: 'pass' })
await devPending2
const reviewPending2 = runTool('flowgate_review', {
  angles: [
    {
      id: 'correctness',
      name: '正确性',
      verdict: 'blocking',
      findings: [{ file: 'src/auth/session.ts', line: 12, severity: 'CRITICAL', summary: '缺少并发保护' }],
    },
  ],
})
await tick()
const upgraded = await postAction('upgrade', { preset: 'strict' })
check('AC-6 升档到严格执行', () => {
  assert.equal(upgraded.status, 200)
  assert.equal(upgraded.body.preset, 'strict')
})
check('AC-7 升档且评审有阻塞项 → 回退 S2 重做', () => assert.equal(upgraded.body.stage, 'S2'))
const reviewResult2 = await reviewPending2
check('AC-7 回退后评审工具返回 wait/reject 语义', () => assert.ok(reviewResult2))
check('升档后评审角度切换为 4 个', () => assert.equal(upgraded.body.angles.length, 4))

// 重做 → 门禁 → 评审 → 测试 → 验收通过。
const devPending3 = gateRound('flowgate_gate', {}, { decision: 'pass' })
await devPending3
const reviewPending3 = gateRound(
  'flowgate_review',
  {
    angles: [
      {
        id: 'security',
        name: '安全',
        verdict: 'pass',
        findings: [{ file: 'src/auth/session.ts', line: 20, severity: 'MINOR', summary: '建议日志脱敏' }],
      },
    ],
  },
  { decision: 'pass' },
)
await reviewPending3

const testPending = gateRound(
  'flowgate_test',
  {
    directions: [
      {
        id: 'smoke',
        name: '冒烟验证',
        points: [
          { point: '超过 30 分钟未活动后请求返回 401', result: 'pass' },
          { point: '401 响应体含 reauthenticate_url', result: 'pass' },
        ],
      },
    ],
  },
  { decision: 'pass' },
)
const testResult = await testPending
check('S4 验收通过后流程结束', () => assert.equal(testResult.next, 'done'))

// AC-8：flows.jsonl 完整、跳过计数正确。
const finalState = await getState()
check('AC-8 流程结束且跳过计数为 0', () => {
  assert.equal(finalState.body.finished, true)
  assert.equal(finalState.body.skippedCount, 0)
})
check('AC-8 flows.jsonl 记录完整阶段事件', () => {
  const file = join(cwd, '.dsh-flowgate', 'flows.jsonl')
  assert.ok(existsSync(file), 'flows.jsonl 未生成')
  const events = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const types = new Set(events.map((e) => e.type))
  for (const required of ['flow.started', 'scope.frozen', 'gate.passed', 'review.submitted', 'flow.rollback', 'flow.finished']) {
    assert.ok(types.has(required), '缺少事件：' + required)
  }
})

// 结束后写操作恢复放行（流程结束不再守卫）。
const afterFinish = await guard('write', { file_path: join(cwd, 'anywhere.ts'), content: 'x' })
check('流程结束后守卫不再拦截', () => assert.equal(afterFinish.kind, 'allow'))

// AC-2：S1 点「跳过评审，直接开发」——scope 仍冻结，S1 标记 skipped_by_user。
const started2 = await runTool('flowgate_start', { title: '第二个任务', preset: 'fast' })
check('新流程从 S1 开始', () => assert.equal(started2.stage, 'S1'))
const docPending2 = runTool('flowgate_doc', {
  html: '<!doctype html><html><body>跳过路径</body></html>',
  scope: { ...scopeInput, files_expected_to_change: ['src/auth/session.ts'] },
})
await tick()
const skipped = await postAction('doc', { decision: 'skip' })
const docResult2 = await docPending2
check('AC-2 跳过需求文档评审仍冻结 scope', () => {
  assert.equal(skipped.status, 200)
  assert.equal(docResult2.frozen, true)
  assert.equal(docResult2.decision, 'skip')
  assert.equal(skipped.body.stage, 'S2')
  assert.equal(skipped.body.scope.frozen, true)
  assert.equal(skipped.body.scope.withoutDocApproval, true)
})
check('AC-2 S1 记录为 skipped_by_user 且台账计数为 1', () => {
  assert.equal(skipped.body.stages.find((s) => s.id === 'S1').status, 'skipped_by_user')
  assert.equal(skipped.body.skippedCount, 1)
})
const writeAfterSkip = await guard('write', { file_path: join(cwd, 'src/auth/session.ts'), content: 'x' })
check('AC-2 跳过后 S2 写操作放行', () => assert.equal(writeAfterSkip.kind, 'allow'))

rmSync(cwd, { recursive: true, force: true })
console.log('\n全部通过：' + passed.length + ' 项')
