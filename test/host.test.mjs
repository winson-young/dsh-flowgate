import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, scopeDenial } from '../lib/index.js'

// ---------------------------------------------------------------------------
// 宿主端 mock：只实现插件实际用到的 ctx 成员。
// ---------------------------------------------------------------------------

function makeHost(cwd, sessionId, options = {}) {
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
        stdout: {
          text: ' M src/auth/session.ts\n?? src/auth/new-helper.ts\n---numstat---\n1\t2\tsrc/auth/session.ts\n',
          truncated: false,
        },
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
      // noShell 用来模拟 dsh-ops 这类退掉官方 shell 行的 profile。
      if (name === 'shell') return options.noShell ? undefined : shell
      // 界面一键启动靠它把 sessionId 换成工作目录；sess-no-cwd 用来验失败分支。
      if (name === 'sessions') {
        return { get: (id) => (id === 'sess-no-cwd' ? undefined : { header: { id, cwd } }) }
      }
      return undefined
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
  // 便捷入口：一个宿主实例自带 session 上下文，多流程用例不必各自拼 exec 与 Request。
  const tool = (name, args) => {
    const definition = tools.get(name)
    assert.ok(definition, '工具未注册：' + name)
    return definition.execute(args, {
      name,
      arguments: args,
      agent: { session: { header: { id: sessionId, cwd } } },
      signal: undefined,
    })
  }
  const request = async (path, body) => {
    const pathname = path.split('?')[0]
    const spec = routes.find((r) => r.path === pathname)
    assert.ok(spec, '路由未注册：' + pathname)
    const init = body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }
    const response = await spec.fetch(new Request('http://host' + path, init))
    return { status: response.status, body: await response.json() }
  }

  const guard = (name, args) => {
    const handler = handlers.get('tools/pre-execute')
    assert.ok(handler, 'scope 守卫未注册')
    return handler(
      { name, arguments: args, agent: { session: { header: { id: sessionId, cwd } } }, signal: undefined },
      async () => ({ kind: 'allow' }),
    )
  }

  apply({ inject: (_names, cb) => cb(scoped) })
  return { tools, routes, handlers, shell, tool, request, guard }
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
  // PRD 4.1.2：走「批准」路径时这个标记是 false，只有跳过需求文档评审才为 true。
  assert.equal(frozen.scope_frozen_without_doc_approval, false)
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
// 变更性 shell 无法逐条核对 scope，S2 也必须拒绝——放行等于给 scope 边界开后门。
const denyShell = await guard('bash', { command: 'git checkout -- src/api/middleware.ts' })
check('变更性 shell 在 S2 被拒并给出回退指引', () => {
  assert.equal(denyShell.kind, 'deny')
  assert.match(denyShell.reason, /变更性 shell 无法核对冻结 scope/)
  assert.match(denyShell.reason, /回到需求分析阶段/)
})
const denyShellOps = await guard('ops_bash', { command: 'rm -rf src/api' })
check('ops_bash 这类别名 shell 同样被拦（不同 profile 装的 shell 插件不同）', () => {
  assert.equal(denyShellOps.kind, 'deny')
  assert.match(denyShellOps.reason, /变更性 shell/)
})
const denyShell2 = await guard('bash', { command: 'echo hello' })
check('只读 shell 放行', () => assert.equal(denyShell2.kind, 'allow'))
const allowGitDiff = await guard('ops_bash', { command: 'git diff --stat' })
check('ops_bash 的只读命令放行', () => assert.equal(allowGitDiff.kind, 'allow'))

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
  // 新文件在开发阶段很常见：porcelain 的 ?? 行必须进摘要，否则评审看不到新增文件。
  assert.ok(afterDev.body.devChanges.untracked.includes('src/auth/new-helper.ts'))
  assert.equal(afterDev.body.devChanges.added, 1)
  assert.equal(afterDev.body.devChanges.removed, 2)
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
// 角度/方向随档位重置是对的；开发规则的勾选与档位无关，升档不该静默丢掉。
check('升档保留用户勾选的开发规则', () => assert.equal(upgraded.body.ruleIds.length, 5))

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

// D2：v1 唯一的写权限例外——只在 S4、只对声明 needsWrite 的方向、只由用户显式授权。
const addDir = await postAction('addDirection', {
  name: '迁移回滚',
  points: ['迁移后回滚可恢复'],
  needsWrite: true,
})
check('D2 追加带写权限声明的测试方向', () => assert.equal(addDir.status, 200))
const customDirId = addDir.body.directions.find((d) => d.name === '迁移回滚').id
const grantBuiltin = await postAction('toggleWriteGrant', { id: 'smoke', enabled: true })
check('D2 未声明需要写权限的方向不能被授权', () => assert.equal(grantBuiltin.status, 409))
const granted = await postAction('toggleWriteGrant', { id: customDirId, enabled: true })
check('D2 用户显式勾选后授权生效', () => {
  assert.equal(granted.status, 200)
  assert.deepEqual(granted.body.writeGrants, [customDirId])
  assert.equal(granted.body.directions.find((d) => d.id === customDirId).writeGranted, true)
})
const revoked = await postAction('toggleWriteGrant', { id: customDirId, enabled: false })
check('D2 取消勾选后授权撤销', () => assert.deepEqual(revoked.body.writeGrants, []))

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
check('AC-2 跳过后 scope.json 带上 without_doc_approval 标记', () => {
  const frozen = JSON.parse(readFileSync(join(cwd, '.dsh-flowgate', 'scope.json'), 'utf8'))
  assert.equal(frozen.scope_frozen_without_doc_approval, true)
})

// PRD 4.5：开发规则是结构化检查清单，用户可勾选，也可追加自定义规则。
const rulesState = await getState()
check('PRD 4.5 开发规则默认启用全部内置规则', () => {
  assert.equal(rulesState.body.rules.length, 5)
  assert.equal(rulesState.body.ruleCatalog.length, 5)
  assert.ok(rulesState.body.ruleIds.includes('scope-only'))
})

const statusS2 = await runTool('flowgate_status', {})
check('PRD 4.5 S2 的 status 给出逐条检查清单', () => {
  assert.match(statusS2.summary, /开发规则检查清单/)
  assert.match(statusS2.summary, /只改 scope 内的文件/)
})

const ruleOff = await postAction('toggleRule', { id: 'no-debug-leftovers', enabled: false })
check('PRD 4.5 取消勾选后规则从清单里移除', () => {
  assert.equal(ruleOff.status, 200)
  assert.equal(ruleOff.body.rules.length, 4)
  assert.ok(!ruleOff.body.ruleIds.includes('no-debug-leftovers'))
})

const ruleAdded = await postAction('addRule', { name: '日志用结构化字段', points: ['不拼字符串', '不带敏感值'] })
check('PRD 4.5 追加自定义规则后默认启用', () => {
  assert.equal(ruleAdded.status, 200)
  const rule = ruleAdded.body.ruleCatalog.find((item) => item.name === '日志用结构化字段')
  assert.ok(rule, '自定义规则没有进 catalog')
  assert.ok(ruleAdded.body.ruleIds.includes(rule.id))
  assert.deepEqual(rule.points, ['不拼字符串', '不带敏感值'])
})

const unknownRule = await postAction('toggleRule', { id: 'nope', enabled: true })
check('PRD 4.5 未知规则 id 被拒绝', () => assert.equal(unknownRule.status, 409))

// ---------------------------------------------------------------------------
// D4：升档只改执行深度，不改范围——回退深度由「发现落在哪」决定。
// ---------------------------------------------------------------------------

{
  // 用独立 session 起一条新流程，避免被上面的流程状态污染。
  const d4Session = 'sess-d4'
  const ctx4 = makeHost(cwd, d4Session)
  const state4 = await ctx4.request('/api/flowgate/state?sessionId=' + d4Session)
  assert.equal(state4.body.active, false)

  await ctx4.tool('flowgate_start', { title: 'D4 回退深度', preset: 'fast' })
  const doc4 = ctx4.tool('flowgate_doc', {
    html: '<html><body><p>D4</p></body></html>',
    recommendedPreset: 'fast',
    reason: '只验回退深度',
    scope: {
      files_expected_to_change: ['src/auth/session.ts'],
      capabilities: ['会话过期检测'],
      out_of_scope_explicitly: ['OAuth'],
      acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
    },
  })
  await tick()
  await ctx4.request('/api/flowgate/action', { sessionId: d4Session, action: 'doc', payload: { decision: 'approve' } })
  await doc4

  const dev4 = ctx4.tool('flowgate_gate', {})
  await tick()
  await ctx4.request('/api/flowgate/action', { sessionId: d4Session, action: 'gate', payload: { decision: 'pass' } })
  await dev4

  // 发现落在 scope 之外：重做 S2 也修不了，只能回 S1 调 scope。
  const review4 = ctx4.tool('flowgate_review', {
    angles: [{
      id: 'security',
      name: '安全',
      verdict: 'blocking',
      findings: [{ file: 'src/config/secrets.ts', line: 7, severity: 'CRITICAL', summary: '密钥硬编码' }],
    }],
  })
  await tick()
  const up4 = await ctx4.request('/api/flowgate/action', { sessionId: d4Session, action: 'upgrade', payload: { preset: 'strict' } })
  check('D4 升档遇到 scope 外发现时回退 S1 而不是 S2', () => {
    assert.equal(up4.status, 200)
    assert.equal(up4.body.stage, 'S1')
    assert.equal(up4.body.preset, 'strict')
    assert.equal(up4.body.reviewOutsideScope.length, 1)
    assert.equal(up4.body.reviewOutsideScope[0].file, 'src/config/secrets.ts')
  })
  const review4Result = await review4
  check('D4 回退 S1 后评审工具被中断而不是继续等待', () => {
    assert.equal(review4Result.decision, 'interrupted')
    assert.equal(review4Result.next, 'S1')
    // 文案必须跟着实际回退目标走：写死 S2 会让 Agent 误以为要去改代码。
    assert.match(review4Result.message, /回退到 S1 重做/)
  })
  check('D4 回退 S1 后 scope 解冻，必须重新批准（不自动扩充）', () => {
    assert.equal(up4.body.scope.frozen, false)
    assert.equal(up4.body.scope.data, null)
  })
  // 解冻的意义：用户改文档重新批准前，S2 的写操作不能被旧白名单放行。
  const afterRollback = await ctx4.guard('write', { file_path: join(cwd, 'src/auth/session.ts'), content: 'x' })
  check('D4 回退 S1 后写操作被拒（旧 scope 不再放行）', () => {
    assert.equal(afterRollback.kind, 'deny')
    assert.match(afterRollback.reason, /不能修改业务代码|scope 尚未冻结/)
  })
}

// ---------------------------------------------------------------------------
// 界面一键启动：客户端只带 sessionId，工作目录由宿主自己解析。
// ---------------------------------------------------------------------------

{
  // 上面的用例已经跑过，这里用独立 session 起一条新流程。
  const uiCtx = makeHost(cwd, 'sess-ui')
  const started = await uiCtx.request('/api/flowgate/action', {
    sessionId: 'sess-ui',
    action: 'start',
    payload: { preset: 'fast' },
  })
  check('界面启动：不带标题也能开流程，标题回落默认值', () => {
    assert.equal(started.status, 200)
    assert.equal(started.body.active, true)
    assert.equal(started.body.stage, 'S1')
    assert.equal(started.body.title, '未命名任务')
    assert.equal(started.body.preset, 'fast')
  })
  const again = await uiCtx.request('/api/flowgate/action', {
    sessionId: 'sess-ui',
    action: 'start',
    payload: { title: '第二次点击', preset: 'strict' },
  })
  check('界面启动是幂等的：重复点击不新建流程、不改档位', () => {
    assert.equal(again.status, 200)
    assert.equal(again.body.id, started.body.id)
    assert.equal(again.body.preset, 'fast')
  })
  const noCwd = await uiCtx.request('/api/flowgate/action', {
    sessionId: 'sess-no-cwd',
    action: 'start',
    payload: {},
  })
  check('界面启动：拿不到工作目录时给出可执行的提示', () => {
    assert.equal(noCwd.status, 409)
    assert.match(noCwd.body.error, /无法确定当前会话的工作目录/)
    assert.match(noCwd.body.error, /flowgate_start/)
  })
}

// 工具的 title 不再必填，Agent 省略它也能启动。
{
  const toolCtx = makeHost(cwd, 'sess-ui-tool')
  const viaTool = await toolCtx.tool('flowgate_start', {})
  check('工具启动：title 可以省略', () => {
    assert.equal(viaTool.stage, 'S1')
    assert.equal(viaTool.preset, 'fast')
  })
}

// ---------------------------------------------------------------------------
// D1 兜底采集：有些 profile 没有宿主 shell 服务（例如 dsh-ops 退掉了 shell 行），
// 这时必须改用 child_process 直接跑 git，不能把变更摘要丢成空。
// ---------------------------------------------------------------------------
{
  const repo = mkdtempSync(join(tmpdir(), 'flowgate-repo-'))
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'test'])
  git(['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'init'])
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, 'b.txt'), 'new\n')

  const noShellCtx = makeHost(repo, 'sess-noshell', { noShell: true })
  await noShellCtx.tool('flowgate_start', { title: '兜底采集', preset: 'fast' })
  const docNoShell = noShellCtx.tool('flowgate_doc', {
    html: '<!doctype html><html><body><h1>兜底采集</h1></body></html>',
    scope: {
      files_expected_to_change: ['a.txt'],
      capabilities: ['改 a.txt'],
      out_of_scope_explicitly: [],
      acceptance_criteria: [{ id: 'AC-1', when: '改完', then: '能采到变更' }],
    },
  })
  await tick()
  await noShellCtx.request('/api/flowgate/action', { sessionId: 'sess-noshell', action: 'doc', payload: { decision: 'approve' } })
  await docNoShell

  const gateNoShell = noShellCtx.tool('flowgate_gate', { summary: '改完了 a.txt' })
  // 门禁工具在 S2 会先跑 collectChanges（两次 git 进程），5ms 的 tick 不够，
  // 门禁 waiter 还没注册就点按钮会被丢掉，execute 就一直挂着。
  await new Promise((resolve) => setTimeout(resolve, 800))
  const gateReply = await noShellCtx.request('/api/flowgate/action', { sessionId: 'sess-noshell', action: 'gate', payload: { decision: 'pass' } })
  const gateResult = await gateNoShell
  check('没有 shell 服务时改用 child_process 采集变更摘要', () => {
    assert.equal(gateReply.status, 200, JSON.stringify(gateReply.body))
    assert.equal(gateResult.decision, 'pass')
    const changes = gateReply.body.devChanges
    assert.ok(changes, '门禁后应留下变更摘要')
    assert.equal(changes.via, 'child_process')
    assert.equal(changes.error, undefined)
    assert.ok(changes.files.includes('a.txt'), '应包含已跟踪的修改')
    assert.ok(changes.files.includes('b.txt'), '应包含未跟踪的新文件')
    assert.ok(changes.untracked.includes('b.txt'))
    assert.equal(changes.added, 2)
  })
  rmSync(repo, { recursive: true, force: true })
}
rmSync(cwd, { recursive: true, force: true })
console.log('\n全部通过：' + passed.length + ' 项')
