import assert from 'node:assert/strict'
import fs, { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
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
  // 界面启动后插件会通过宿主 agents 服务给会话补一条消息；这里记下来给用例断言。
  const delivered = []
  // sess-late-agent 用它模拟「第一次拿不到、之后拿得到」：验证重复点开始会重试唤醒。
  const agentLookups = new Map()
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
      // sess-no-agent 模拟宿主没返回 live agent：唤醒失败时要降级成界面提示。
      if (name === 'agents') {
        const live = (id) => ({ followup: (message) => { delivered.push({ sessionId: id, message }) } })
        return {
          get: (id) => {
            if (id === 'sess-no-agent') return undefined
            if (id === 'sess-late-agent') {
              const seen = agentLookups.get(id) ?? 0
              agentLookups.set(id, seen + 1)
              return seen === 0 ? undefined : live(id)
            }
            return live(id)
          },
        }
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
  // opts.signal 用来模拟工具调用被中断：真实宿主在执行超时时会中止这个 signal。
  const tool = (name, args, opts = {}) => {
    const definition = tools.get(name)
    assert.ok(definition, '工具未注册：' + name)
    return definition.execute(args, {
      name,
      arguments: args,
      agent: { session: { header: { id: sessionId, cwd } } },
      signal: opts.signal,
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
  return { tools, routes, handlers, shell, tool, request, guard, delivered }
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
// AC-3：S1 只是起点，文案必须说清文档获批后继续 S2，否则模型会把 S1 当终点。
check('start 返回说明 S1 之后继续推进', () => {
  assert.match(started.message, /S1 只是这条流程的起点/)
  assert.match(started.message, /直接继续 S2 开发/)
  assert.match(started.message, /不要在阶段交界处停下来/)
})

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
  // AC-4：批准之后必须立刻进入 S2，而不是停在 S1 等用户再发一句。
  assert.match(docResult.message, /现在直接开始 S2/)
  assert.match(docResult.message, /flowgate_gate/)
  assert.match(docResult.message, /不要停下来等用户再确认一次/)
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
// AC-5：门禁通过后直接给出下一阶段动作，措辞里不能只有「进入 S3」。
check('S2 完成开发后进入 S3', () => {
  assert.equal(devResult.next, 'S3')
  assert.match(devResult.message, /现在直接开始 S3/)
  assert.match(devResult.message, /不要在阶段交界处停下/)
})
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
// AC-6：评审通过后要求立即开始 S4，不停在阶段交界处。
check('评审通过后进入 S4', () => {
  assert.equal(reviewResult.next, 'S4')
  assert.match(reviewResult.message, /现在直接开始 S4 测试/)
  assert.match(reviewResult.message, /不要在阶段交界处停下/)
})
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
  // 用户什么都没写就点了输入框上方那个按钮：Agent 不能照着「需求分析」四个字
  // 自己编一个需求去分析，S1 第一步必须是问清目标。
  check('没填需求时唤醒消息要求 Agent 先问要做什么，不许自己开始分析', () => {
    assert.equal(uiCtx.delivered.length, 1)
    const text = uiCtx.delivered[0].message.content.map((block) => block.text).join('\n')
    assert.match(text, /没有填写需求描述/)
    assert.match(text, /只问一个问题/)
    assert.match(text, /这次要做什么/)
    assert.match(text, /不要自己假设目标/)
    // AC-2：问清目标之后仍是一路走完四阶段，不能停在 S1。
    assert.match(text, /问清楚目标后同样一路走完四阶段/)
    assert.match(text, /不要在阶段交界处/)
    assert.doesNotMatch(text, /需求原文：/)
  })
  // 需求描述：标题由第一行派生，原文进 brief，Agent 在 S1 直接读它提问。
  const briefCtx = makeHost(cwd, 'sess-brief')
  const withBrief = await briefCtx.request('/api/flowgate/action', {
    sessionId: 'sess-brief',
    action: 'start',
    payload: { preset: 'fast', brief: '# 会话过期返回 401，并给出重新认证入口。\n\n第二段补充说明。' },
  })
  check('界面启动带需求描述时标题从第一行派生', () => {
    assert.equal(withBrief.status, 200)
    assert.equal(withBrief.body.title, '会话过期返回 401，并给出重新认证入口')
    assert.equal(withBrief.body.brief, '# 会话过期返回 401，并给出重新认证入口。\n\n第二段补充说明。')
  })
  check('界面启动会把需求投递给 Agent，S1 不会停在原地等用户开口', () => {
    assert.equal(withBrief.body.nudge.ok, true)
    assert.equal(briefCtx.delivered.length, 1)
    const { sessionId: target, message } = briefCtx.delivered[0]
    assert.equal(target, 'sess-brief')
    assert.equal(message.role, 'user')
    assert.equal(message.source.kind, 'user')
    const text = message.content.map((block) => block.text).join('\n')
    assert.match(text, /S1 需求分析/)
    assert.match(text, /会话过期返回 401/)
    assert.match(text, /flowgate_doc/)
    // AC-1：有需求原文时说明 S1 不是一次单独的需求分析，批准后继续 S2。
    assert.match(text, /这是同一条流程的 S1/)
    assert.match(text, /立刻继续 S2 开发/)
    assert.match(text, /不要在阶段交界处/)
  })
  // 宿主没返回 live agent 时不能吞掉启动：流程照建，只是界面提示用户去对话里说一句。
  const noAgent = await makeHost(cwd, 'sess-no-agent').request('/api/flowgate/action', {
    sessionId: 'sess-no-agent',
    action: 'start',
    payload: { brief: '宿主拿不到 Agent 时也要能开流程' },
  })
  check('拿不到 Agent 时启动照常成功，视图里标记唤醒失败', () => {
    assert.equal(noAgent.status, 200)
    assert.equal(noAgent.body.active, true)
    assert.equal(noAgent.body.nudge.ok, false)
    assert.ok(noAgent.body.nudge.reason.length > 0)
  })
  // 上一次没唤醒成功时，用户再点一次「开始需求分析」应当重试，而不是静默返回旧视图。
  const lateCtx = makeHost(cwd, 'sess-late-agent')
  const lateFirst = await lateCtx.request('/api/flowgate/action', {
    sessionId: 'sess-late-agent',
    action: 'start',
    payload: { brief: '第一次拿不到 Agent' },
  })
  const lateSecond = await lateCtx.request('/api/flowgate/action', {
    sessionId: 'sess-late-agent',
    action: 'start',
    payload: { brief: '第一次拿不到 Agent' },
  })
  check('唤醒失败后再点一次开始会重试，且不新建流程', () => {
    assert.equal(lateFirst.body.nudge.ok, false)
    assert.equal(lateSecond.body.nudge.ok, true)
    assert.equal(lateSecond.body.id, lateFirst.body.id)
    assert.equal(lateCtx.delivered.length, 1)
    assert.equal(lateCtx.delivered[0].sessionId, 'sess-late-agent')
  })
  const briefStatus = await briefCtx.tool('flowgate_status', {})
  check('流程摘要里带上需求原文，Agent 不必再问用户要一遍', () => {
    assert.match(briefStatus.summary, /需求描述：# 会话过期返回 401/)
  })
  const longTitle = await makeHost(cwd, 'sess-brief-long').request('/api/flowgate/action', {
    sessionId: 'sess-brief-long',
    action: 'start',
    payload: { brief: '一'.repeat(60) },
  })
  check('过长的需求第一行会被截断成标题', () => {
    assert.equal(longTitle.body.title, '一'.repeat(40) + '…')
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
  // 受限沙箱会禁止 spawn git（EPERM）：这时构造不出真实仓库，跳过这段而不是中断整套测试。
  let gitUsable = true
  try {
    execFileSync('git', ['--version'], { windowsHide: true })
  } catch {
    gitUsable = false
  }
  if (!gitUsable) {
    console.log('  skip 没有 shell 服务时改用 child_process 采集变更摘要（当前环境禁止 spawn git）')
  } else {
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
}
// ---------------------------------------------------------------------------
// 取消：用户放弃流程时必须把流程判死、解冻 scope，并唤醒挂起的门禁工具。
// 否则 Agent 的工具会一直等到超时，用户看到的是「点了没反应」。
// ---------------------------------------------------------------------------

{
  const cx = makeHost(cwd, 'sess-cancel')
  await cx.tool('flowgate_start', { title: '取消演示', preset: 'fast' })

  // 需求文档门禁挂起时放弃：工具要立刻返回 cancelled，而不是等到超时。
  const pendingDoc = cx.tool('flowgate_doc', {
    html: '<html><body><p>取消</p></body></html>',
    scope: {
      files_expected_to_change: ['src/a.ts'],
      capabilities: ['改 a.ts'],
      out_of_scope_explicitly: [],
      acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
    },
  })
  await tick()
  const cancelReply = await cx.request('/api/flowgate/action', {
    sessionId: 'sess-cancel',
    action: 'cancel',
    payload: { reason: '这个需求先不做了' },
  })
  const docResult = await pendingDoc
  check('取消会唤醒挂起的文档门禁，工具返回 cancelled', () => {
    assert.equal(cancelReply.status, 200, JSON.stringify(cancelReply.body))
    assert.equal(docResult.decision, 'cancelled')
    assert.equal(docResult.frozen, false)
    assert.match(docResult.message, /放弃/)
  })
  check('取消后流程标记为已放弃，scope 解冻', () => {
    const v = cancelReply.body
    assert.equal(v.finished, true)
    assert.equal(v.cancelled, true)
    assert.equal(v.cancelReason, '这个需求先不做了')
    assert.ok(v.cancelledAt, '应记录放弃时间')
    assert.equal(v.scope.frozen, false)
    assert.equal(v.scope.data, null)
  })
  const afterCancel = await cx.guard('write', { file_path: join(cwd, 'src/a.ts'), content: 'x' })
  check('取消后写操作不再被 scope 拦截', () => assert.equal(afterCancel.kind, 'allow'))

  const twice = await cx.tool('flowgate_cancel', {})
  check('流程已结束后再放弃工具返回「不需要」而不是报错', () => {
    assert.equal(twice.cancelled, false)
    assert.match(twice.message, /已经结束/)
  })
  const again = await cx.request('/api/flowgate/action', { sessionId: 'sess-cancel', action: 'cancel', payload: {} })
  check('已结束流程再发 cancel 动作返回 409', () => {
    assert.equal(again.status, 409)
    assert.match(again.body.error, /已经结束/)
  })

  // 用户点了「结束」，Agent 却不知道：修复前它还能继续追问、继续提交文档，
  // 用户就会看到「明明结束了，对话框里还在问我问题」。
  let askError = null
  try {
    await cx.tool('flowgate_ask', { question: '还要继续吗？', options: [{ label: '要', tradeoff: '继续做' }, { label: '不要', tradeoff: '收工' }] })
  } catch (err) {
    askError = err
  }
  check('放弃后追问工具直接报错，不再挂起等用户回答', () => {
    assert.ok(askError, '应抛错')
    assert.match(String(askError.message), /放弃/)
    assert.match(String(askError.message), /重新启动/)
  })
  let docError = null
  try {
    await cx.tool('flowgate_doc', {
      html: '<html><body><p>作废</p></body></html>',
      scope: {
        files_expected_to_change: ['src/a.ts'],
        capabilities: ['改 a.ts'],
        out_of_scope_explicitly: [],
        acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
      },
    })
  } catch (err) {
    docError = err
  }
  check('放弃后文档提交也被拒绝，流程不会自己复活', () => {
    assert.ok(docError, '应抛错')
    assert.match(String(docError.message), /放弃/)
  })
  const deadView = await cx.request('/api/flowgate/state?sessionId=sess-cancel')
  check('放弃后视图不再残留作废的追问卡片', () => {
    assert.equal(deadView.body.finished, true)
    assert.equal(deadView.body.grill.pending, null)
    assert.equal(deadView.body.doc.pending, false)
  })
  // 文档要留着给人看，但不能再被批准：放弃是终态，不能靠点按钮复活。
  check('放弃后文档仍可查看，只是不再待批准', () => {
    assert.ok(deadView.body.doc.html, '已提交的文档应保留给用户查看')
    assert.equal(deadView.body.doc.decision, null)
  })
  const approveAfterCancel = await cx.request('/api/flowgate/action', {
    sessionId: 'sess-cancel',
    action: 'doc',
    payload: { decision: 'approve' },
  })
  check('放弃后批准需求文档被拒', () => {
    assert.equal(approveAfterCancel.status, 409)
    assert.match(approveAfterCancel.body.error, /放弃/)
  })

  // 放弃后必须能重开，并且新流程不带着上一轮的 scope 白名单。
  const restarted = await cx.request('/api/flowgate/action', {
    sessionId: 'sess-cancel',
    action: 'start',
    payload: { title: '再来一次' },
  })
  check('放弃后可以重新启动一条干净的新流程', () => {
    assert.equal(restarted.status, 200)
    assert.equal(restarted.body.active, true)
    assert.equal(restarted.body.cancelled, false)
    assert.equal(restarted.body.title, '再来一次')
    assert.equal(restarted.body.scope.frozen, false)
  })
}

// 开发阶段门禁挂起时放弃：gate 工具返回 cancelled，阶段不再推进。
{
  const gx = makeHost(cwd, 'sess-cancel-gate')
  await gx.tool('flowgate_start', { title: '取消开发门禁', preset: 'fast' })
  const docGate = gx.tool('flowgate_doc', {
    html: '<html><body><p>取消</p></body></html>',
    scope: {
      files_expected_to_change: ['src/a.ts'],
      capabilities: ['改 a.ts'],
      out_of_scope_explicitly: [],
      acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
    },
  })
  await tick()
  await gx.request('/api/flowgate/action', { sessionId: 'sess-cancel-gate', action: 'doc', payload: { decision: 'approve' } })
  await docGate

  const pendingGate = gx.tool('flowgate_gate', { summary: '改完了' })
  await tick()
  await gx.request('/api/flowgate/action', { sessionId: 'sess-cancel-gate', action: 'cancel', payload: { reason: '不想做了' } })
  const gateResult = await pendingGate
  check('取消会唤醒挂起的开发门禁，gate 返回 cancelled 且停在原地', () => {
    assert.equal(gateResult.decision, 'cancelled')
    assert.equal(gateResult.next, 'cancelled')
    assert.equal(gateResult.stage, 'S2')
    assert.match(gateResult.message, /放弃/)
  })
  const v = await gx.request('/api/flowgate/state?sessionId=sess-cancel-gate')
  check('取消后阶段不再推进，S2 保持原状', () => {
    assert.equal(v.body.stage, 'S2')
    assert.equal(v.body.finished, true)
    assert.equal(v.body.cancelled, true)
  })
  const log = readFileSync(join(cwd, '.dsh-flowgate', 'flows.jsonl'), 'utf8')
  check('放弃写了一条 flow.cancelled 审计事件', () => {
    assert.match(log, /"type":"flow\.cancelled"/)
    assert.match(log, /不想做了/)
  })
}

rmSync(cwd, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// 实时进度：提交需求后工作台要能显示「正在做什么」与推进到哪，
// 否则用户只能对着一个静止页面等 Agent。
// ---------------------------------------------------------------------------

{
  const cx = makeHost(cwd, 'sess-live')
  const exec = (name, args) => ({ name, arguments: args, agent: { session: { header: { id: 'sess-live', cwd } } }, signal: undefined })
  const pre = cx.handlers.get('tools/pre-execute')

  await cx.tool('flowgate_start', { title: '实时进度', preset: 'fast', brief: '会话过期返回 401' })

  const first = await cx.request('/api/flowgate/state?sessionId=sess-live')
  check('启动后视图带阶段进度与已用时', () => {
    const progress = first.body.progress
    assert.ok(progress, '缺少 progress')
    assert.equal(progress.steps.length, 4)
    assert.equal(progress.steps[0].status, 'active')
    assert.equal(progress.steps[1].status, 'pending')
    assert.equal(progress.label, '需求分析')
    assert.ok(progress.percent > 0 && progress.percent < 100, '进行中的流程不该是 0 或 100')
    assert.equal(typeof first.body.elapsedMs, 'number')
    assert.equal(first.body.activity, null)
  })

  await pre(exec('read', { path: join(cwd, 'src/auth/session.ts') }), async () => ({ kind: 'allow' }))
  const second = await cx.request('/api/flowgate/state?sessionId=sess-live')
  check('工具执行会留下「正在做什么」的摘要', () => {
    const activity = second.body.activity
    assert.ok(activity, '缺少 activity')
    assert.match(activity.text, /读取文件/)
    assert.match(activity.text, /session\.ts/)
    assert.ok(activity.elapsedMs >= 0)
  })

  // Agent 停下来以后，上一条「正在读取文件」必须消失，否则像是卡住了。
  const statusHandler = cx.handlers.get('agent/status')
  assert.ok(statusHandler, 'agent/status 未被订阅')
  statusHandler({ agent: { session: { header: { id: 'sess-live' } } }, status: 'idle' })
  const idle = await cx.request('/api/flowgate/state?sessionId=sess-live')
  check('Agent 空闲后不再显示上一次动作', () => assert.equal(idle.body.activity, null))

  const docPending = cx.tool('flowgate_doc', {
    html: '<html><body><h1>实时进度</h1></body></html>',
    scope: {
      files_expected_to_change: ['src/auth/session.ts'],
      capabilities: ['会话过期检测'],
      out_of_scope_explicitly: [],
      acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
    },
  })
  await tick()
  await cx.request('/api/flowgate/action', { sessionId: 'sess-live', action: 'doc', payload: { decision: 'approve' } })
  await docPending
  const third = await cx.request('/api/flowgate/state?sessionId=sess-live')
  check('进入下一阶段后不再显示上个阶段的旧动作', () => {
    assert.equal(third.body.stage, 'S2')
    assert.equal(third.body.activity, null)
    assert.equal(third.body.progress.steps[0].status, 'done')
    assert.equal(third.body.progress.steps[1].status, 'active')
    assert.ok(third.body.progress.percent >= 25, 'S1 落地后总进度应有四分之一以上')
  })

  await cx.request('/api/flowgate/action', { sessionId: 'sess-live', action: 'cancel', payload: { reason: '测进度' } })
  const ended = await cx.request('/api/flowgate/state?sessionId=sess-live')
  check('放弃后的视图不再带活动摘要，进度保留实际值', () => {
    assert.equal(ended.body.activity, null)
    assert.ok(ended.body.progress.percent > 0)
  })
}

// ---------------------------------------------------------------------------
// 文档等待的韧性：提交文档的那次工具调用可能被中断（执行超时、宿主重启、
// 新门禁取代旧门禁）。文档已经落盘，批准入口不能跟着调用一起消失。
// ---------------------------------------------------------------------------

{
  const cx = makeHost(cwd, 'sess-resume')
  await cx.tool('flowgate_start', { title: '中断恢复', preset: 'fast' })
  const controller = new AbortController()
  const pending = cx.tool('flowgate_doc', {
    html: '<html><body><h1>中断</h1></body></html>',
    scope: {
      files_expected_to_change: ['src/auth/session.ts'],
      capabilities: ['会话过期检测'],
      out_of_scope_explicitly: [],
      acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
    },
  }, { signal: controller.signal })
  await tick()
  const before = await cx.request('/api/flowgate/state?sessionId=sess-resume')
  check('中断前文档处于待批准且未标记中断', () => {
    assert.equal(before.body.doc.pending, true)
    assert.equal(before.body.doc.interrupted, false)
  })
  controller.abort()
  const interrupted = await pending
  check('调用中断后工具返回 pending 而不是 timeout，文档保留', () => {
    assert.equal(interrupted.decision, 'pending')
    assert.equal(interrupted.frozen, false)
    assert.match(interrupted.message, /已保留/)
  })
  const after = await cx.request('/api/flowgate/state?sessionId=sess-resume')
  check('中断后仍停在 S1 待批准，并标记确认入口曾中断', () => {
    assert.equal(after.body.stage, 'S1')
    assert.equal(after.body.finished, false)
    assert.equal(after.body.doc.pending, true)
    assert.equal(after.body.doc.interrupted, true)
  })
  const approved = await cx.request('/api/flowgate/action', {
    sessionId: 'sess-resume',
    action: 'doc',
    payload: { decision: 'approve' },
  })
  check('没有等待器时批准按钮仍然生效', () => {
    assert.equal(approved.status, 200)
    assert.equal(approved.body.stage, 'S2')
    assert.equal(approved.body.scope.frozen, true)
  })
}

{
  const first = makeHost(cwd, 'sess-reboot')
  await first.tool('flowgate_start', { title: '重启恢复', preset: 'fast' })
  const scope = {
    files_expected_to_change: ['src/auth/session.ts'],
    capabilities: ['会话过期检测'],
    out_of_scope_explicitly: [],
    acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
  }
  // 故意不 await：重启会丢掉内存里的等待器，这次调用永远不会结算。
  void first.tool('flowgate_doc', { html: '<html><body><h1>重启</h1></body></html>', scope }).catch(() => {})
  await tick()
  // 新实例 = 宿主重启：内存等待器全没了，只剩磁盘上的流程快照。
  const second = makeHost(cwd, 'sess-reboot')
  const listed = await second.request('/api/flowgate/hub', { paths: [cwd] })
  assert.ok(listed.body.workspaces[0].flows.some((flow) => flow.sessionId === 'sess-reboot' && !flow.finished))
  // 不调用任何工具预热：工作台应能从磁盘摘要直接进入完整详情。
  const restored = await second.request('/api/flowgate/state?sessionId=sess-reboot')
  check('宿主重启后直接打开工作台可恢复待批准文档，无需先调用工具', () => {
    assert.equal(restored.body.active, true)
    assert.equal(restored.body.stage, 'S1')
    assert.equal(restored.body.finished, false)
    assert.equal(restored.body.doc.pending, true)
    assert.equal(restored.body.doc.interrupted, true)
  })
  const approved = await second.request('/api/flowgate/action', {
    sessionId: 'sess-reboot',
    action: 'doc',
    payload: { decision: 'approve' },
  })
  check('重启后仍能批准，scope 与验收标准完整保留', () => {
    assert.equal(approved.status, 200)
    assert.equal(approved.body.stage, 'S2')
    assert.deepEqual(approved.body.scope.data.in_scope.files_expected_to_change, ['src/auth/session.ts'])
    assert.deepEqual(approved.body.scope.data.acceptance_criteria.map((item) => item.id), ['AC-1'])
  })
  const repeat = await second.request('/api/flowgate/action', {
    sessionId: 'sess-reboot',
    action: 'doc',
    payload: { decision: 'approve' },
  })
  check('重启后重复批准不会重复推进', () => {
    assert.equal(repeat.status, 200)
    assert.equal(repeat.body.stage, 'S2')
    assert.equal(repeat.body.doc.decision.kind, 'approve')
  })
}

{
  const cx = makeHost(cwd, 'sess-race')
  await cx.tool('flowgate_start', { title: '等待竞争', preset: 'fast' })
  const scope = {
    files_expected_to_change: ['src/auth/session.ts'],
    capabilities: ['会话过期检测'],
    out_of_scope_explicitly: [],
    acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
  }
  const staleSignal = new AbortController()
  const freshSignal = new AbortController()
  const stale = cx.tool('flowgate_doc', { html: '<html><body><p>旧</p></body></html>', scope }, { signal: staleSignal.signal })
  await tick()
  const fresh = cx.tool('flowgate_doc', { html: '<html><body><p>新</p></body></html>', scope }, { signal: freshSignal.signal })
  await tick()
  const staleResult = await stale
  check('新门禁取代旧门禁时旧调用返回 pending', () => {
    assert.equal(staleResult.decision, 'pending')
  })
  // 修复前：旧 signal 的 abort 回调会删掉「当前」等待器，后一次调用永远不结算。
  staleSignal.abort()
  await tick()
  const approved = await cx.request('/api/flowgate/action', {
    sessionId: 'sess-race',
    action: 'doc',
    payload: { decision: 'approve' },
  })
  const freshResult = await Promise.race([
    fresh,
    new Promise((_, reject) => setTimeout(() => reject(new Error('新等待被旧信号误删：批准没有结算它')), 500)),
  ])
  check('旧调用中断不影响新等待，批准能结算新调用', () => {
    assert.equal(approved.status, 200)
    assert.equal(freshResult.decision, 'approve')
    assert.equal(freshResult.frozen, true)
  })
}

// 门禁等待也可能被中断：S2 的变更摘要已经采集完，用户点「完成开发」不能因为等待器没了而失效。
{
  const cx = makeHost(cwd, 'sess-gate')
  await cx.tool('flowgate_start', { title: '门禁中断', preset: 'fast' })
  const scope = {
    files_expected_to_change: ['src/auth/session.ts'],
    capabilities: ['会话过期检测'],
    out_of_scope_explicitly: [],
    acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
  }
  const docSignal = new AbortController()
  const docCall = cx.tool('flowgate_doc', { html: '<html><body><p>门禁</p></body></html>', scope }, { signal: docSignal.signal })
  await tick()
  await cx.request('/api/flowgate/action', { sessionId: 'sess-gate', action: 'doc', payload: { decision: 'approve' } })
  await docCall
  const gateSignal = new AbortController()
  const gateCall = cx.tool('flowgate_gate', { summary: '代码已改完' }, { signal: gateSignal.signal })
  await tick()
  gateSignal.abort()
  const waited = await gateCall
  check('门禁调用中断后返回 wait 而不是报错', () => {
    assert.equal(waited.decision, 'wait')
  })
  const view = await cx.request('/api/flowgate/state?sessionId=sess-gate')
  check('门禁中断后仍停在 S2 并标记可确认', () => {
    assert.equal(view.body.stage, 'S2')
    assert.equal(view.body.gate.pending, true)
    assert.equal(view.body.gate.interrupted, true)
  })
  const passed = await cx.request('/api/flowgate/action', {
    sessionId: 'sess-gate',
    action: 'gate',
    payload: { decision: 'pass' },
  })
  check('没有等待器时「完成开发」仍然推进到 S3', () => {
    assert.equal(passed.status, 200)
    assert.equal(passed.body.stage, 'S3')
  })
  // 阶段推进了但没有人叫醒 Agent，流程就停在交界处；这里锁住补发的唤醒消息。
  check('门禁决策落地后补一条唤醒消息，Agent 不会被留在阶段交界处', () => {
    const texts = cx.delivered.map((item) => item.message.content.map((block) => block.text).join('\n'))
    assert.ok(
      texts.some((text) => /进入 S3/.test(text)),
      '没有补发「进入 S3」的唤醒消息',
    )
    assert.ok(
      texts.some((text) => /用户通过了 S2 门禁/.test(text)),
      '唤醒消息没有说明是哪一次门禁',
    )
  })
  const again = await cx.request('/api/flowgate/action', {
    sessionId: 'sess-gate',
    action: 'gate',
    payload: { decision: 'pass' },
  })
  check('S3 还没有评审报告时重复点击会被拒绝并说明原因', () => {
    assert.equal(again.status, 409)
    assert.match(again.body.error, /可确认的产物/)
  })
}

// AC-5 / AC-7：跳过门禁同样要给出下一阶段动作，且返回字段集合不变（schema 不动）。
{
  const cx = makeHost(cwd, 'sess-skip')
  await cx.tool('flowgate_start', { title: '跳过门禁文案', preset: 'fast' })
  const scope = {
    files_expected_to_change: ['src/auth/session.ts'],
    capabilities: ['会话过期检测'],
    out_of_scope_explicitly: [],
    acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
  }
  const docCall = cx.tool('flowgate_doc', { html: '<html><body><p>跳过门禁</p></body></html>', scope })
  await tick()
  await cx.request('/api/flowgate/action', {
    sessionId: 'sess-skip',
    action: 'doc',
    payload: { decision: 'approve' },
  })
  const docSkipped = await docCall
  check('AC-7 文档批准返回字段集合不变', () => {
    assert.deepEqual(Object.keys(docSkipped).sort(), ['decision', 'frozen', 'message', 'preset'])
  })
  const gateCall = cx.tool('flowgate_gate', {})
  await tick()
  await cx.request('/api/flowgate/action', {
    sessionId: 'sess-skip',
    action: 'gate',
    payload: { decision: 'skip' },
  })
  const skippedGate = await gateCall
  check('AC-5 跳过门禁后同样给出下一阶段动作', () => {
    assert.equal(skippedGate.decision, 'skip')
    assert.equal(skippedGate.next, 'S3')
    assert.match(skippedGate.message, /用户跳过了本阶段门禁/)
    assert.match(skippedGate.message, /现在直接开始 S3 的工作/)
    assert.match(skippedGate.message, /不要在阶段交界处停下/)
  })
  check('AC-7 门禁返回字段集合不变', () => {
    assert.deepEqual(Object.keys(skippedGate).sort(), ['decision', 'message', 'next', 'stage'])
  })
  // 工具还挂在门禁上时它自己会接着跑，不需要再补一条消息（否则会重复推进）。
  check('等待器还在时不重复补发唤醒消息', () => {
    const texts = cx.delivered.map((item) => item.message.content.map((block) => block.text).join('\n'))
    assert.equal(texts.filter((text) => /进入 S3/.test(text)).length, 0)
  })
}

// 评审回归：Agent 的工具已经中断时点「修改需求」，补发的消息不能宣称 scope 已冻结，
// 否则 Agent 会跳过改文档、直接开始改代码——而 revise 分支里 scope 根本没有冻结。
{
  const cx = makeHost(cwd, 'sess-revise')
  await cx.tool('flowgate_start', { title: '修改需求', preset: 'fast' })
  const scope = {
    files_expected_to_change: ['src/auth/session.ts'],
    capabilities: ['会话过期检测'],
    out_of_scope_explicitly: [],
    acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
  }
  const docSignal = new AbortController()
  const docCall = cx.tool(
    'flowgate_doc',
    { html: '<html><body><p>修改</p></body></html>', scope },
    { signal: docSignal.signal },
  )
  await tick()
  docSignal.abort()
  const waited = await docCall
  check('修改需求前文档工具已中断，停在等待状态', () => {
    assert.ok(
      ['wait', 'pending'].includes(waited.decision),
      '文档工具中断后应返回等待状态，实际：' + waited.decision,
    )
  })
  const revised = await cx.request('/api/flowgate/action', {
    sessionId: 'sess-revise',
    action: 'doc',
    payload: { decision: 'revise' },
  })
  check('修改需求后仍停在 S1', () => {
    assert.equal(revised.status, 200)
    assert.equal(revised.body.stage, 'S1')
  })
  check('修改需求的补发文案要求改完文档重新提交，且不宣称 scope 已冻结', () => {
    const last = cx.delivered[cx.delivered.length - 1]
    const text = last.message.content.map((block) => block.text).join('\n')
    assert.match(text, /用户要求修改需求文档/)
    assert.match(text, /scope 尚未冻结/)
    assert.match(text, /重新提交 flowgate_doc/)
    assert.doesNotMatch(text, /scope 已冻结/)
  })
}

// 门禁被中断后点「退回开发修复」：Agent 必须被告知回到 S2 重做，否则它会停在 S3。
{
  const sid = 'sess-back'
  const cx = makeHost(cwd, sid)
  await cx.tool('flowgate_start', { title: '退回唤醒', preset: 'fast' })
  const scope = {
    files_expected_to_change: ['src/auth/session.ts'],
    capabilities: ['会话过期检测'],
    out_of_scope_explicitly: [],
    acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
  }
  const docCall = cx.tool('flowgate_doc', { html: '<html><body><p>退回</p></body></html>', scope })
  await tick()
  await cx.request('/api/flowgate/action', { sessionId: sid, action: 'doc', payload: { decision: 'approve' } })
  await docCall
  const devCall = cx.tool('flowgate_gate', { summary: '代码已改完' })
  await tick()
  await cx.request('/api/flowgate/action', { sessionId: sid, action: 'gate', payload: { decision: 'pass' } })
  await devCall
  const reviewSignal = new AbortController()
  const reviewCall = cx.tool(
    'flowgate_review',
    { angles: [{ id: 'correctness', name: '正确性', verdict: 'pass', findings: [] }] },
    { signal: reviewSignal.signal },
  )
  await tick()
  reviewSignal.abort()
  await reviewCall
  const back = await cx.request('/api/flowgate/action', {
    sessionId: sid,
    action: 'gate',
    payload: { decision: 'back', to: 'S2' },
  })
  check('无等待器时退回开发修复会补发回到 S2 的指令', () => {
    assert.equal(back.status, 200)
    assert.equal(back.body.stage, 'S2')
    const last = cx.delivered[cx.delivered.length - 1]
    const text = last.message.content.map((block) => block.text).join('\n')
    assert.match(text, /用户退回到 S2 重做/)
    assert.match(text, /进入 S2（/)
  })
}

// 最后一个门禁通过后流程结束：补发的消息要说「结束了」，不能让 Agent 再找下一阶段。
{
  const sid = 'sess-finish'
  const cx = makeHost(cwd, sid)
  await cx.tool('flowgate_start', { title: '结束唤醒', preset: 'fast' })
  const scope = {
    files_expected_to_change: ['src/auth/session.ts'],
    capabilities: ['会话过期检测'],
    out_of_scope_explicitly: [],
    acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
  }
  const docCall = cx.tool('flowgate_doc', { html: '<html><body><p>结束</p></body></html>', scope })
  await tick()
  await cx.request('/api/flowgate/action', { sessionId: sid, action: 'doc', payload: { decision: 'approve' } })
  await docCall
  const devCall = cx.tool('flowgate_gate', { summary: '代码已改完' })
  await tick()
  await cx.request('/api/flowgate/action', { sessionId: sid, action: 'gate', payload: { decision: 'pass' } })
  await devCall
  const reviewCall = cx.tool('flowgate_review', {
    angles: [{ id: 'correctness', name: '正确性', verdict: 'pass', findings: [] }],
  })
  await tick()
  await cx.request('/api/flowgate/action', { sessionId: sid, action: 'gate', payload: { decision: 'pass' } })
  await reviewCall
  const testSignal = new AbortController()
  const testCall = cx.tool(
    'flowgate_test',
    { directions: [{ id: 'functional', name: '功能正确性', points: [{ point: '过期返回 401', result: 'pass' }] }] },
    { signal: testSignal.signal },
  )
  await tick()
  testSignal.abort()
  await testCall
  const done = await cx.request('/api/flowgate/action', {
    sessionId: sid,
    action: 'gate',
    payload: { decision: 'pass' },
  })
  check('无等待器时最后一个门禁通过后说明流程已结束', () => {
    assert.equal(done.status, 200)
    assert.equal(done.body.stage, 'S4')
    assert.equal(done.body.finished, true)
    const last = cx.delivered[cx.delivered.length - 1]
    const text = last.message.content.map((block) => block.text).join('\n')
    assert.match(text, /用户通过了 S4 门禁/)
    assert.match(text, /四个阶段已经全部结束/)
  })
}

// ---------------------------------------------------------------------------
// A：开发规则跟工作区走（工作区默认 < 本次流程临时调整 < 内置默认）
// ---------------------------------------------------------------------------

{
  const wsCwd = mkdtempSync(join(tmpdir(), 'flowgate-ws-'))
  const configFile = join(wsCwd, '.dsh-flowgate', 'config.json')
  const stateOf = (target, sid) => target.request('/api/flowgate/state?sessionId=' + sid)
  const act = (target, sid, action, payload) => target.request('/api/flowgate/action', { sessionId: sid, action, payload })

  const firstSid = 'sess-ws-first'
  const first = makeHost(wsCwd, firstSid)
  await first.tool('flowgate_start', { title: '工作区默认规则', preset: 'fast' })
  const fresh = await stateOf(first, firstSid)
  check('A 没有 config.json 时规则来源是内置默认', () => {
    assert.equal(fresh.body.ruleSource, 'default')
    assert.equal(fresh.body.workspaceRules.configured, false)
    assert.equal(existsSync(configFile), false)
  })

  const toggled = await act(first, firstSid, 'toggleRule', { id: 'no-debug-leftovers', enabled: false })
  check('A 勾选只改本次流程，不写工作区配置', () => {
    assert.equal(toggled.status, 200)
    assert.equal(toggled.body.ruleSource, 'flow')
    assert.ok(!toggled.body.ruleIds.includes('no-debug-leftovers'))
    assert.equal(existsSync(configFile), false)
  })

  const switched = await act(first, firstSid, 'preset', { preset: 'strict' })
  check('A 切档位保留本次流程的规则勾选', () => {
    assert.equal(switched.status, 200)
    assert.equal(switched.body.ruleSource, 'flow')
    assert.ok(!switched.body.ruleIds.includes('no-debug-leftovers'))
  })

  const saved = await act(first, firstSid, 'saveRuleDefaults', {})
  check('A 保存为工作区默认后写入 config.json 并转为跟随默认', () => {
    assert.equal(saved.status, 200)
    assert.equal(saved.body.ruleSource, 'workspace')
    assert.equal(saved.body.workspaceRules.configured, true)
    assert.ok(existsSync(configFile), 'config.json 没有落盘')
    const config = JSON.parse(readFileSync(configFile, 'utf8'))
    assert.deepEqual(config.rules.ids, saved.body.ruleIds)
    assert.equal(config.rules.ids.includes('no-debug-leftovers'), false)
  })
  check('A 工作区配置里没有写权限之类的流程内授权', () => {
    const raw = readFileSync(configFile, 'utf8')
    assert.equal(raw.includes('writeGrants'), false)
    assert.equal(raw.includes('needWrite'), false)
  })

  // 换一个宿主实例：确认规则是从盘上的 config.json 继承来的，不是内存缓存。
  const secondSid = 'sess-ws-second'
  const second = makeHost(wsCwd, secondSid)
  await second.tool('flowgate_start', { title: '继承工作区默认', preset: 'fast' })
  const inherited = await stateOf(second, secondSid)
  check('A 同工作区的新流程继承工作区默认规则', () => {
    assert.equal(inherited.body.ruleSource, 'workspace')
    assert.deepEqual(inherited.body.ruleIds, saved.body.ruleIds)
    assert.ok(!inherited.body.ruleIds.includes('no-debug-leftovers'))
  })

  await act(second, secondSid, 'addRule', { name: '日志用结构化字段', points: ['不拼字符串'] })
  const savedCustom = await act(second, secondSid, 'saveRuleDefaults', {})
  const customRule = savedCustom.body.ruleCatalog.find((rule) => rule.name === '日志用结构化字段')
  check('A 自定义规则能存进工作区默认', () => {
    assert.ok(customRule, '自定义规则没有生成 id')
    const config = JSON.parse(readFileSync(configFile, 'utf8'))
    assert.ok(config.rules.custom.some((rule) => rule.id === customRule.id))
    assert.deepEqual(config.rules.custom.find((rule) => rule.id === customRule.id).points, ['不拼字符串'])
  })

  const thirdSid = 'sess-ws-third'
  const third = makeHost(wsCwd, thirdSid)
  await third.tool('flowgate_start', { title: '继承自定义规则', preset: 'fast' })
  const thirdState = await stateOf(third, thirdSid)
  check('A 新流程的规则目录带出工作区自定义规则', () => {
    assert.ok(thirdState.body.ruleCatalog.some((rule) => rule.id === customRule.id))
    assert.ok(thirdState.body.ruleIds.includes(customRule.id))
    assert.equal(thirdState.body.rules.length, 5)
  })

  const cleared = await act(third, thirdSid, 'clearRuleDefaults', {})
  check('A 清除工作区默认后回到内置默认规则', () => {
    assert.equal(cleared.status, 200)
    assert.equal(existsSync(configFile), false)
    assert.equal(cleared.body.ruleSource, 'default')
    assert.equal(cleared.body.rules.length, 5)
  })

  rmSync(wsCwd, { recursive: true, force: true })
}
// Hub 不依赖 session：空工作区先设规则，再启动流程继承。
{
  const root = mkdtempSync(join(tmpdir(), 'flowgate-hub-api-'))
  const ws = join(root, 'workspace')
  const empty = join(root, 'empty')
  const unlisted = join(root, 'unlisted')
  for (const dir of [ws, empty, unlisted]) mkdirSync(dir)
  const previousHome = process.env.DSH_FLOWGATE_HOME
  process.env.DSH_FLOWGATE_HOME = join(root, 'home')
  const cx = makeHost(ws, 'hub-new-flow')
  const post = (route, body) => cx.request('/api/flowgate/hub/' + route, body)
  const configFile = join(ws, '.dsh-flowgate', 'config.json')
  const flowsDir = join(ws, '.dsh-flowgate', 'flows')
  mkdirSync(flowsDir, { recursive: true })
  const fixture = (n) => ({
    id: 'f_' + String(n).padStart(2, '0'), sessionId: 'archived-' + n, cwd: ws,
    title: '历史流程 ' + n, brief: '需求'.repeat(300), stage: 'S4', preset: 'fast', finished: true,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    stages: Object.fromEntries(['S1', 'S2', 'S3', 'S4'].map((id) => [id, { status: 'done', gate: 'pass' }])),
  })
  for (let n = 0; n < 25; n++) writeFileSync(join(flowsDir, fixture(n).id + '.json'), JSON.stringify(fixture(n)))
  const originals = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, unlinkSync: fs.unlinkSync }
  let snapshotReads = 0
  fs.readFileSync = function (file, ...args) {
    if (String(file).startsWith(flowsDir)) snapshotReads++
    return originals.readFileSync.call(this, file, ...args)
  }
  syncBuiltinESMExports()
  try {
    const added = await post('add', { path: ws })
    const emptyAdded = await post('add', { path: empty })
    check('Hub 添加成员仅返回摘要，冷扫描每份快照只读一次', () => {
      assert.equal(added.status, 200)
      assert.equal(added.body.member.flowCount, 25)
      assert.equal(Object.hasOwn(added.body.member, 'flows'), false)
      assert.equal(emptyAdded.body.member.flowCount, 0)
      assert.equal(snapshotReads, 25)
    })
    const first = await post('flows', { path: ws })
    const second = await post('flows', { path: ws, page: 2, pageSize: 10 })
    const last = await post('flows', { path: ws, page: 999, pageSize: 10 })
    const capped = await post('flows', { path: ws, pageSize: 500 })
    const members = await post('members', {})
    check('Hub 分页默认10条、稳定排序、末页归一与最大50条', () => {
      assert.equal(first.status, 200)
      assert.deepEqual([first.body.total, first.body.page, first.body.pageSize, first.body.totalPages], [25, 1, 10, 3])
      assert.deepEqual(first.body.flows.map((flow) => flow.id), Array.from({ length: 10 }, (_, n) => fixture(n).id))
      assert.equal(second.body.flows[0].id, 'f_10')
      assert.equal(last.body.page, 3)
      assert.equal(last.body.flows.length, 5)
      assert.equal(capped.body.pageSize, 50)
      assert.equal(first.body.flows[0].brief.length, 200)
      assert.equal(first.body.currentFlow, null, '只有已结束记录时没有当前流程')
      assert.equal(members.body.members[0].flowCount, 25)
      assert.equal(Object.hasOwn(members.body.members[0], 'flows'), false)
      assert.equal(snapshotReads, 25, '翻页/成员刷新不可重新读取完整快照')
    })
    const emptyPage = await post('flows', { path: empty, page: 99 })
    check('Hub 空集固定第一页且总页数为1', () => {
      assert.deepEqual(emptyPage.body, { flows: [], currentFlow: null, total: 0, page: 1, pageSize: 10, totalPages: 1 })
    })
    for (const body of [{ page: 0 }, { page: -1 }, { page: 1.5 }, { page: '2' }, { page: null }, { page: Number.MAX_SAFE_INTEGER + 1 }, { pageSize: 0 }, { pageSize: '10' }, { pageSize: null }]) {
      assert.equal((await post('flows', { path: ws, ...body })).status, 400)
    }
    const plainFile = join(root, 'plain-file')
    writeFileSync(plainFile, 'text')
    for (const path of ['relative/path', plainFile, unlisted, join(root, 'missing')]) {
      assert.equal((await post('flows', { path })).status, 400)
      assert.equal((await post('rules', { path, rules: null })).status, 400)
    }
    assert.equal((await post('add', { path: plainFile })).status, 400)
    for (const route of ['flows', 'rules']) {
      assert.equal((await post(route, null)).status, 400)
      assert.equal((await post(route, [])).status, 400)
      const spec = cx.routes.find((item) => item.path.endsWith('/hub/' + route))
      const response = await spec.fetch(new Request('http://host/api/flowgate/hub/' + route, { method: 'POST', body: '{' }))
      assert.equal(response.status, 400)
    }
    check('Hub 拒绝非法页码、未登记/相对/文件路径与非法请求体', () => {})

    const changed = { ...fixture(24), updatedAt: '2099-01-01T00:00:00.000Z', title: '外部更新' }
    writeFileSync(join(flowsDir, 'f_24.json'), JSON.stringify(changed))
    const changedPage = await post('flows', { path: ws })
    check('Hub 外部更改仅重读该快照并更新排序', () => {
      assert.equal(changedPage.body.flows[0].title, '外部更新')
      assert.equal(snapshotReads, 26)
    })
    writeFileSync(join(flowsDir, 'f_25.json'), JSON.stringify(fixture(25)))
    assert.equal((await post('flows', { path: ws })).body.total, 26)
    rmSync(join(flowsDir, 'f_00.json'))
    assert.equal((await post('members', {})).body.members[0].flowCount, 25)
    writeFileSync(join(flowsDir, 'f_01.json'), '{bad')
    assert.equal((await post('flows', { path: ws })).body.total, 24)
    const afterCorruptRead = snapshotReads
    await post('flows', { path: ws, page: 2 })
    assert.equal(snapshotReads, afterCorruptRead, '损坏快照不应每页重读')
    writeFileSync(join(flowsDir, 'f_01.json'), JSON.stringify(fixture(1)))
    assert.equal((await post('flows', { path: ws })).body.total, 25)
    check('Hub 外部新增、删除、损坏与修复快照及时更新计数', () => {})

    const defaults = await post('rules', { path: ws })
    const custom = { id: 'project-logs', name: '结构化日志', points: ['输出结构化字段'] }
    const saved = await post('rules', { path: ws, rules: { ids: ['scope-only', custom.id], custom: [custom] }, scope: { files: ['unsafe'] }, writeGrants: ['all'] })
    check('Hub 无流程即可读写工作区规则，响应包含有效ID和目录', () => {
      assert.equal(defaults.body.rules.configured, false)
      assert.equal(defaults.body.rules.ids.length, 5)
      assert.equal(saved.status, 200)
      assert.equal(saved.body.rules.configured, true)
      assert.equal(saved.body.rules.customCount, 1)
      assert.deepEqual(saved.body.rules.ids, ['scope-only', custom.id])
      assert.deepEqual(saved.body.rules.custom, [custom])
      assert.equal(saved.body.rules.catalog.length, 6)
      const config = JSON.parse(readFileSync(configFile, 'utf8'))
      assert.deepEqual(Object.keys(config).sort(), ['rules', 'updatedAt', 'version'])
      assert.deepEqual(config.rules.custom, [custom])
    })
    const invalid = [
      {}, [], false, { ids: [], custom: null }, { ids: ['unknown'], custom: [] },
      { ids: ['scope-only', 'scope-only'], custom: [] },
      { ids: [], custom: [custom, custom] },
      { ids: [], custom: [{ ...custom, id: 'scope-only' }] },
      { ids: [], custom: [{ ...custom, name: '  ' }] },
      { ids: [], custom: [{ ...custom, points: [1] }] },
    ]
    for (const rules of invalid) assert.equal((await post('rules', { path: ws, rules })).status, 400)
    assert.deepEqual((await post('rules', { path: ws })).body, saved.body)
    check('Hub 拒绝重复/未知/冲突规则ID、空名称和非法字段类型', () => {})

    fs.writeFileSync = function (file, ...args) {
      if (String(file).startsWith(configFile)) throw Object.assign(new Error('写入失败 EACCES'), { code: 'EACCES' })
      return originals.writeFileSync.call(this, file, ...args)
    }
    syncBuiltinESMExports()
    const failedSave = await post('rules', { path: ws, rules: { ids: [], custom: [] } })
    fs.writeFileSync = originals.writeFileSync
    fs.unlinkSync = function (file, ...args) {
      if (String(file) === configFile) throw Object.assign(new Error('删除失败 EACCES'), { code: 'EACCES' })
      return originals.unlinkSync.call(this, file, ...args)
    }
    syncBuiltinESMExports()
    const failedClear = await post('rules', { path: ws, rules: null })
    fs.unlinkSync = originals.unlinkSync
    syncBuiltinESMExports()
    check('Hub 保存或清除失败显式返回500且缓存保留原规则', () => {
      assert.equal(failedSave.status, 500)
      assert.match(failedSave.body.error, /EACCES/)
      assert.equal(failedClear.status, 500)
      assert.match(failedClear.body.error, /EACCES/)
    })
    assert.deepEqual((await post('rules', { path: ws })).body, saved.body)
    await cx.tool('flowgate_start', { title: '从 Hub 规则启动', preset: 'fast' })
    const state = await cx.request('/api/flowgate/state?sessionId=hub-new-flow')
    const beforeMemoryRead = snapshotReads
    const livePage = await post('flows', { path: ws, pageSize: 50 })
    const liveLastPage = await post('flows', { path: ws, page: 3 })
    check('Hub 保存刷新服务缓存，新流程继承规则并立即更新流程计数', () => {
      assert.deepEqual(state.body.ruleIds, ['scope-only', custom.id])
      assert.equal(state.body.ruleSource, 'workspace')
      assert.equal(livePage.body.total, 26)
      assert.equal(livePage.body.currentFlow.id, state.body.id)
      assert.equal(liveLastPage.body.currentFlow.id, state.body.id, '当前流程不随历史分页变化')
      assert.ok(!liveLastPage.body.flows.some((flow) => flow.id === state.body.id))
      assert.ok(livePage.body.flows.some((flow) => flow.id === state.body.id && !flow.finished))
      assert.equal(snapshotReads, beforeMemoryRead, 'persist 已更新摘要，无需重新解析快照')
    })
    const diskFile = join(flowsDir, state.body.id + '.json')
    const stale = JSON.parse(readFileSync(diskFile, 'utf8'))
    stale.title = '外部陈旧状态'
    stale.finished = true
    writeFileSync(diskFile, JSON.stringify(stale))
    const memoryPage = await post('flows', { path: ws, pageSize: 50 })
    assert.equal(memoryPage.body.flows.find((flow) => flow.id === state.body.id).title, '从 Hub 规则启动')
    assert.equal((await post('members', {})).body.members[0].activeCount, 1)
    await cx.request('/api/flowgate/action', { sessionId: 'hub-new-flow', action: 'cancel', payload: {} })
    const cancelled = await post('members', {})
    assert.equal(cancelled.body.members[0].activeCount, 0)
    assert.equal((await post('flows', { path: ws })).body.currentFlow, null, '放弃后恢复空闲主入口')
    check('Hub 内存状态优先，取消后摘要计数立即刷新', () => {})

    writeFileSync(configFile, JSON.stringify({ version: 1, rules: { ids: ['match-style', 'unknown', 'match-style'], custom: [] } }))
    const external = await post('rules', { path: ws })
    assert.deepEqual(external.body.rules.ids, ['match-style'])
    assert.deepEqual((await cx.request('/api/flowgate/state?sessionId=hub-new-flow')).body.ruleIds, ['match-style', 'unknown', 'match-style'])
    const cleared = await post('rules', { path: ws, rules: null })
    check('Hub 外部规则更新刷新缓存，null 恢复内置默认且不创建流程', () => {
      assert.equal(external.body.rules.configured, true)
      assert.equal(cleared.status, 200)
      assert.equal(cleared.body.rules.configured, false)
      assert.equal(cleared.body.rules.ids.length, 5)
      assert.equal(existsSync(configFile), false)
    })
    await post('remove', { path: ws })
    assert.equal((await post('rules', { path: ws, rules: null })).status, 400)
    rmSync(empty, { recursive: true })
    assert.equal((await post('flows', { path: empty })).status, 400)
    assert.equal((await post('rules', { path: empty })).status, 400)
    assert.equal((await post('members', {})).body.members[0].missing, true)
    check('Hub 已移除成员或已消失目录拒绝读取和写入', () => {})
  } finally {
    Object.assign(fs, originals)
    syncBuiltinESMExports()
    if (previousHome === undefined) delete process.env.DSH_FLOWGATE_HOME
    else process.env.DSH_FLOWGATE_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
}
// 读取失败不能被当成空闲；恢复权限后同一个服务实例必须可以重试。
{
  const root = mkdtempSync(join(tmpdir(), 'flowgate-hub-read-failure-'))
  const ws = join(root, 'workspace')
  mkdirSync(ws)
  const previousHome = process.env.DSH_FLOWGATE_HOME
  process.env.DSH_FLOWGATE_HOME = join(root, 'home')
  const original = { readdirSync: fs.readdirSync, statSync: fs.statSync, readFileSync: fs.readFileSync }
  try {
    const first = makeHost(ws, 'read-existing')
    await first.tool('flowgate_start', { title: '不能被漏掉的流程', preset: 'fast' })
    const state = (await first.request('/api/flowgate/state?sessionId=read-existing')).body
    await first.request('/api/flowgate/hub/add', { path: ws })
    const flowsDir = join(ws, '.dsh-flowgate', 'flows')
    const snapshot = join(flowsDir, state.id + '.json')
    for (const [kind, method, target, code] of [
      ['目录扫描', 'readdirSync', flowsDir, 'EACCES'],
      ['文件签名', 'statSync', snapshot, 'EPERM'],
      ['快照读取', 'readFileSync', snapshot, 'EACCES'],
    ]) {
      // 快照改动使每个场景都需要重新读取，不能被前一场景的摘要缓存命中。
      const flow = JSON.parse(original.readFileSync(snapshot, 'utf8'))
      flow.title += '。'
      writeFileSync(snapshot, JSON.stringify(flow))
      fs[method] = function (file, ...args) {
        if (String(file) === target) throw Object.assign(new Error(kind + '失败 ' + code), { code })
        return original[method].call(this, file, ...args)
      }
      syncBuiltinESMExports()
      const restarted = makeHost(ws, 'read-new')
      for (let retry = 0; retry < 2; retry++) {
        const page = await restarted.request('/api/flowgate/hub/flows', { path: ws })
        assert.equal(page.status, 500)
        assert.match(page.body.error, new RegExp(code))
        if (method !== 'statSync') {
          const start = await restarted.request('/api/flowgate/action', {
            sessionId: 'read-new', action: 'start', payload: { title: '不能误启动', brief: '读取失败时不能创建流程', preset: 'fast' },
          })
          assert.equal(start.status, 409)
          assert.match(start.body.error, new RegExp(code))
        }
      }
      Object.assign(fs, original)
      syncBuiltinESMExports()
      const page = await restarted.request('/api/flowgate/hub/flows', { path: ws })
      const restored = await restarted.request('/api/flowgate/state?sessionId=read-existing')
      check('Hub ' + kind + '失败显式报错，连续重试安全且恢复后能继续原流程', () => {
        assert.equal(page.status, 200)
        assert.equal(page.body.currentFlow.id, state.id)
        assert.equal(restored.status, 200)
        assert.equal(restored.body.active, true)
        assert.equal(restored.body.id, state.id)
        assert.equal(page.body.total, 1)
      })
    }
  } finally {
    Object.assign(fs, original)
    syncBuiltinESMExports()
    if (previousHome === undefined) delete process.env.DSH_FLOWGATE_HOME
    else process.env.DSH_FLOWGATE_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
}
console.log('\n全部通过：' + passed.length + ' 项')
