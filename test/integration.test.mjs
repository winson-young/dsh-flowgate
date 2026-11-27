import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { clientFactoryRevision } from '../lib/runtime.js'
import { join } from 'node:path'

// 假宿主：只实现 flowgate 用到的 ctx 能力（inject/effect/on/get/tools/connection/workingDirectory），
// 让真实的 apply() 跑起来，从而验证注册、守卫、路由与门禁全链路。
const CWD = mkdtempSync(join(tmpdir(), 'flowgate-integration-'))
process.once('exit', () => rmSync(CWD, { recursive: true, force: true }))
console.log('FLOWGATE_INTEGRATION_FIXTURE ' + CWD)
mkdirSync(join(CWD, 'src', 'auth'), { recursive: true })
writeFileSync(join(CWD, 'src', 'auth', 'session.ts'), 'fixture source\n')
const PREVIOUS_HUB_HOME = process.env.DSH_FLOWGATE_HOME
process.env.DSH_FLOWGATE_HOME = join(CWD, 'hub-home')

const SESSION = 'sess-main'
const SHELL_OUT = ' M src/auth/session.ts\n---numstat---\n3\t1\tsrc/auth/session.ts\n'

// 与真实夹具源码对应，避免证据契约把旧用例的阻塞发现逐条丢弃。
const reviewFinding = (severity, summary) => ({
  file: 'src/auth/session.ts', line: 1, severity, ac: 'AC-1', kind: 'defect',
  evidence: 'fixture', summary,
  repro: { when: '调用 session 的刷新分支', expected: '处理并发刷新', actual: '缺少并发处理' },
  ...(severity === 'MINOR' ? {} : { counter: { attempt: '检查是否已有处理并发刷新的路径', survived: true } }),
})

function makeHost() {
  const tools = new Map()
  const routes = new Map()
  const listeners = new Map()
  const guards = []
  const sessions = new Map([SESSION, 'sess-other'].map((id) => [id, { header: { id, cwd: CWD, delegationDepth: 0 } }]))
  const agents = new Map()
  // 假子代理：捕获 spawn 请求，立即返回一份结构化报告。
  const spawns = []
  const subagents = {
    getProvider(name) { return name === 'spawn' ? { prepareContinuable() {} } : undefined },
    async startActivation(request) {
      const entry = { provider: request.provider, request, released: false }
      spawns.push(entry)
      sessions.set(request.childId, { header: { id: request.childId, cwd: CWD, delegationDepth: request.parent.session.header.delegationDepth + 1, origin: 'subagent', parentSession: request.parent.session.header.id } })
      const write = execFor(request.childId, 'ops_write_file', { path: 'src/auth/session.ts' })
      assert.ok(guards.some((guard) => guard(write)), '启动返回前真实 childId 已受最终守卫保护')
      const sdk = {
        read: async ({ file_path }) => {
          const read = execFor(request.childId, 'read', { file_path })
          assert.ok(guards.every((guard) => !guard(read)), '默认读取工具须获只读守卫授权')
          return { lines: [{ number: 1, text: readFileSync(join(CWD, file_path), 'utf8').trim() }] }
        },
      }
      assert.equal(sdk.ops_read_files, undefined, '初始 SDK 不预加载 ops_read_files')
      const checkedFiles = request.prompt[0].text.includes('checkedFiles') ? ['src/auth/session.ts'] : []
      const readContent = checkedFiles.length ? (await sdk.read({ file_path: checkedFiles[0] })).lines[0].text : null
      return {
        childId: request.childId,
        name: 'child-' + spawns.length,
        messageId: 'message-' + spawns.length,
        result: Promise.resolve({
          stopReason: 'completed',
          output: [{
            type: 'text',
            text: JSON.stringify({
              verdict: 'advisory',
              suggestUpgrade: false,
              ...(checkedFiles.length ? { checkedFiles, readEvidence: [
                { file: checkedFiles[0], firstLine: readContent, lastLine: readContent },
              ] } : {}),
              findings: [reviewFinding('MINOR', '缺少失败路径的注释')],
            }),
          }],
        }),
        dispose: async () => {
          assert.ok(guards.some((guard) => guard(write)), '释放过程中仍保留最终守卫')
          entry.released = true
        },
      }
    },
  }
  const host = { tools, routes, listeners, spawns, guards, sessions, agents }
  const ctx = {
    inject(_deps, cb) { cb(ctx) },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on(event, handler) { listeners.set(event, handler); return () => {} },
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      if (name === 'agents') return { get: (id) => agents.get(id) }
      if (name === 'subagents') return subagents
      if (name === 'shell') {
      return {
        resolve: (request) => ({ ...request, resolved: true }),
        run: async (spec) => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs ?? 0,
          stdout: { text: SHELL_OUT, truncated: false },
          stderr: { text: '', truncated: false },
        }),
      }
    }
      return undefined
    },
    tools: {
      register(def) { tools.set(def.name, def); return () => {} },
      get(name) { return tools.get(name) },
      guard(check) { guards.push(check); return () => { guards.splice(guards.indexOf(check), 1) } },
    },
    connection: { fetch: { register(spec) { routes.set(spec.path, spec); return () => {} } } },
    workingDirectory: { ensure: async () => CWD },
  }
  host.ctx = ctx
  return host
}

const host = makeHost()
const mod = await import('../lib/index.js')
mod.apply(host.ctx)

const execFor = (sessionId, name, args) => {
  let session = host.sessions.get(sessionId) ?? host.agents.get(sessionId)?.session
  if (!session) {
    session = { header: { id: sessionId, cwd: CWD, delegationDepth: 0 } }
    host.sessions.set(sessionId, session)
  }
  return { name, arguments: args, signal: undefined, agent: { session } }
}

const actionRouteRef = () => host.routes.get('/api/flowgate/action')
// 本文件的用例验证「每一步都停下来等确认」的手动门禁语义：门禁模式默认随档位
// （fast 档是自动通过），启动后显式切成每步确认。自动通过的行为在 test/gatemode.test.mjs 里覆盖。
// flowgate_doc 必须交代追问结果；这套用例验的是流程串联，追问内容给一份默认清单。
const DEFAULT_GRILL = {
  decisions: [{ question: '这次要改到什么程度？', answer: '把追问纪律写进工具文案与提交校验' }],
  assumptions: [],
  open_questions: [],
}
const withGrill = (name, args) => (name === 'flowgate_doc' ? { ...DEFAULT_GRILL, ...args } : args)

const call = async (name, args, sessionId = SESSION) => {
  const prepared = withGrill(name, args)
  const value = await host.tools.get(name).execute(prepared, execFor(sessionId, name, prepared))
  if (name === 'flowgate_start') {
    const res = await actionRouteRef().fetch(new Request('http://host/api/flowgate/action', {
      method: 'POST', body: JSON.stringify({ sessionId, action: 'setGateMode', payload: { mode: 'manual' } }),
    }))
    assert.equal(res.status, 200)
  }
  return value
}

const guard = async (name, args, sessionId = SESSION) => {
  const handler = host.listeners.get('tools/pre-execute')
  assert.ok(handler, 'pre-execute 守卫必须注册')
  return handler(execFor(sessionId, name, args), async () => ({ kind: 'allow' }))
}

const stateRoute = host.routes.get('/api/flowgate/state')
const actionRoute = host.routes.get('/api/flowgate/action')

const getState = async (sessionId = SESSION) => {
  const res = await stateRoute.fetch({ url: 'http://host/api/flowgate/state?sessionId=' + encodeURIComponent(sessionId) })
  assert.equal(res.status, 200)
  return res.json()
}

const postHubApi = async (route, body) => {
  const res = await host.routes.get('/api/flowgate/hub/' + route).fetch({ json: async () => body })
  return { status: res.status, data: await res.json() }
}

const post = async (body) => {
  const res = await actionRoute.fetch({ json: async () => body })
  return { status: res.status, data: await res.json() }
}

// 挂起的工具不能真的卡死测试：等它注册进 waiters 再唤醒，超时就失败。
const tick = () => new Promise((r) => setTimeout(r, 30))
const within = (promise, label) => Promise.race([
  promise,
  new Promise((_r, rej) => setTimeout(() => rej(new Error('超时未返回：' + label)), 4000)),
])

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log('ok   ' + name)
}

await check('apply 注册 10 个工具与 9 条路由', () => {
  assert.deepEqual([...host.tools.keys()].sort(), [
    'flowgate_ask', 'flowgate_cancel', 'flowgate_doc', 'flowgate_gate', 'flowgate_review',
    'flowgate_review_run', 'flowgate_start', 'flowgate_status', 'flowgate_test', 'flowgate_test_run',
  ])
  assert.ok(host.routes.has('/api/flowgate/state'))
  assert.ok(host.routes.has('/api/flowgate/action'))
  assert.ok(host.routes.has('/api/flowgate/hub'))
  assert.ok(host.routes.has('/api/flowgate/hub/members'))
  assert.ok(host.routes.has('/api/flowgate/hub/add'))
  assert.ok(host.routes.has('/api/flowgate/hub/remove'))
  assert.ok(host.routes.has('/api/flowgate/hub/flows'))
  assert.ok(host.routes.has('/api/flowgate/hub/rules'))
  assert.ok(host.routes.has('/api/flowgate/hub/prepare'))
  // state 是 GET，其余都是 POST —— 工作台读名单、添加、移除、按目录拉快照。
  assert.deepEqual([...host.routes.values()].map((r) => r.methods.join(',')).sort(), ['GET', 'POST', 'POST', 'POST', 'POST', 'POST', 'POST', 'POST', 'POST'])
})

await check('未启动时 status 给出引导', async () => {
  const value = await call('flowgate_status', {})
  assert.equal(value.active, false)
  assert.match(value.summary, /flowgate_start/)
})

await check('未启动时 S1 之外的写操作不被守卫拦截（无流程即不管）', async () => {
  const d = await guard('write', { file_path: 'src/anything.ts' })
  assert.equal(d.kind, 'allow')
})

await check('Hub 无流程时保存规则，不建立流程或 scope 授权', async () => {
  const added = await postHubApi('add', { path: CWD })
  assert.equal(added.status, 200)
  assert.equal(added.data.member.flowCount, 0)
  assert.equal(Object.hasOwn(added.data.member, 'flows'), false)
  const defaults = (await postHubApi('rules', { path: CWD })).data.rules.stages
  const ids = { S1: 'clarify-goal', S2: 'scope-only', S3: 'correctness', S4: 'smoke' }
  const stages = Object.fromEntries(Object.entries(ids).map(([stage, id]) => [stage, {
    ids: null, custom: [], edits: [{ ...defaults[stage].builtin.find((item) => item.id === id), points: ['集成工作区规则 ' + stage] }],
  }]))
  stages.S2.ids = ['scope-only', 'integration-rule']
  stages.S2.custom = [{ id: 'integration-rule', name: '集成规则', points: ['输出结构化日志'] }]
  const saved = await postHubApi('rules', { path: CWD, stages })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.data.rules.ids, ['scope-only', 'integration-rule'])
  assert.equal((await getState()).active, false)
  const config = JSON.parse(readFileSync(join(CWD, '.dsh-flowgate', 'config.json'), 'utf8'))
  // gateWaitMinutes 是工作区级的门禁等待上限：保存规则时一并写回，不额外建文件。
  assert.deepEqual(Object.keys(config).sort(), ['gateWaitMinutes', 'stages', 'updatedAt', 'version'])
  assert.equal(config.gateWaitMinutes, 10)
  assert.ok(Object.values(saved.data.rules.stages).every((value) => value.configured))
  assert.deepEqual(config.stages, stages)
  assert.equal(existsSync(join(CWD, '.dsh-flowgate', 'scope.json')), false)
})

const REQUIREMENT_BRIEF = '  原文需求 src/auth/session.ts\n约束 123 保持完整。  '

await check('prepare 在没有模型能力时降级，不启动流程也不改变配置', async () => {
  const file = join(CWD, '.dsh-flowgate', 'config.json')
  const before = readFileSync(file, 'utf8')
  const prepared = await postHubApi('prepare', { path: CWD, brief: REQUIREMENT_BRIEF })
  assert.equal(prepared.status, 200)
  assert.equal(prepared.data.status, 'fallback')
  assert.equal(prepared.data.title, '原文需求 src/auth/session.ts')
  assert.equal('summary' in prepared.data, false, 'prepare 只返回标题，不再返回整理稿')
  assert.equal((await getState()).active, false)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(existsSync(join(CWD, '.dsh-flowgate', 'scope.json')), false)
})

await check('flowgate_start 启动流程并进入 S1', async () => {
  const value = await call('flowgate_start', { title: '会话过期检测', preset: 'fast', brief: REQUIREMENT_BRIEF })
  assert.equal(value.stage, 'S1')
  const view = await getState()
  assert.equal(view.active, true)
  assert.equal(view.stage, 'S1')
  assert.equal(view.preset, 'fast')
  assert.equal(view.ruleSource, 'workspace')
  assert.deepEqual(view.ruleIds, ['scope-only', 'integration-rule'])
  assert.equal(view.brief, REQUIREMENT_BRIEF)
  assert.equal(view.summary, undefined, '状态里不再带整理稿，需求依据只有原文')
  for (const stage of ['S1', 'S2', 'S3', 'S4']) assert.equal(view.stageConfigs[stage].source, 'workspace')
  assert.match((await call('flowgate_status', {})).summary, /集成工作区规则 S1/)
})

await check('工作区所有会话读取同一条流程，工具与界面均拒绝重复启动', async () => {
  const sibling = await getState('sess-other')
  assert.equal(sibling.active, false)
  assert.equal(sibling.workspace.active, true)
  assert.equal(sibling.workspace.flow.sessionId, SESSION)
  assert.equal(sibling.workspace.flow.stage, 'S1')
  assert.equal(sibling.workspace.flow.stageIndex, 0)
  await assert.rejects(call('flowgate_start', {}, 'sess-other'), /已有流程在进行/)
  await assert.rejects(call('flowgate_start', {}), /已有流程在进行/)
  const rejected = await post({ sessionId: 'sess-other', action: 'start', payload: {} })
  assert.equal(rejected.status, 409)
  assert.match(rejected.data.error, /先结束或放弃/)
  assert.equal((await getState('sess-other')).active, false)
  assert.equal((await getState()).workspace.flow.sessionId, SESSION)
})

await check('S1 阶段的写操作被拒绝', async () => {
  const d = await guard('write', { file_path: 'src/auth/session.ts' })
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /S1/)
  assert.match(d.reason, /批准并冻结 scope/)
})

await check('S1 的变更性 shell 被拒绝，只读 shell 放行', async () => {
  const bad = await guard('bash', { command: 'rm -rf src' })
  assert.equal(bad.kind, 'deny')
  const ok = await guard('bash', { command: 'git diff' })
  assert.equal(ok.kind, 'allow')
})

// AC-4：评审 / 测试子代理的会话归到父流程，写工具在工具层被拒绝（不是靠提示词）。
await check('AC-4 子代理会话的写工具被工具层拒绝', async () => {
  const service = mod.currentService()
  assert.ok(service, 'apply() 之后必须能拿到当前服务')
  host.sessions.set('sess-review', { header: { id: 'sess-review', cwd: CWD, delegationDepth: 1, origin: 'subagent', parentSession: SESSION } })
  service.registerChild(SESSION, 'sess-review')
  try {
    for (const name of ['write', 'edit', 'str_replace_editor']) {
      const args = name === 'str_replace_editor' ? { path: 'src/auth/session.ts' } : { file_path: 'src/auth/session.ts' }
      const d = await guard(name, args, 'sess-review')
      assert.equal(d.kind, 'deny', name + ' 必须被拒绝')
      assert.match(d.reason, /只读/)
    }
    const shell = await guard('bash', { command: 'rm -rf src' }, 'sess-review')
    assert.equal(shell.kind, 'deny')
    // 只读 Git 放行：评审子代理要能自己看改了什么，否则只能按文件正文猜。
    for (const command of ['git diff', 'git status', 'git log --oneline -5', 'git diff --stat']) {
      assert.equal((await guard('bash', { command }, 'sess-review')).kind, 'allow', command + ' 应放行')
    }
    // 写 Git 与解释器内联仍然拒绝，放行范围只到只读子命令。
    for (const command of ['git push', 'git commit -am x', 'git checkout main', 'git diff | tee out.txt', 'node -e "x"']) {
      assert.equal((await guard('bash', { command }, 'sess-review')).kind, 'deny', command + ' 应拒绝')
    }
    const readShell = await guard('bash', { command: 'pwd' }, 'sess-review')
    assert.equal(readShell.kind, 'allow')
    const read = await guard('read', { file_path: 'src/auth/session.ts' }, 'sess-review')
    assert.equal(read.kind, 'allow')
  } finally {
    service.unregisterChild('sess-review')
  }
})

// D2：手工布尔标志不能替代实际 S4 的方向授权。完整授权路径另由子代理回归测试覆盖。
await check('D2 非 S4 的手工写权限标志仍拒绝变更性 shell', async () => {
  const service = mod.currentService()
  service.registerChild(SESSION, 'sess-test', { allowShellWrite: true })
  try {
    const shell = await guard('bash', { command: 'pnpm migrate && pnpm migrate:rollback' }, 'sess-test')
    assert.equal(shell.kind, 'deny', '只有实际 S4 的已授权方向才能放行变更性 shell')
    const write = await guard('write', { file_path: 'src/auth/session.ts' }, 'sess-test')
    assert.equal(write.kind, 'deny', '写权限例外不覆盖代码写工具')
  } finally {
    service.unregisterChild('sess-test')
  }
})

// 解绑只读权限后仍保留真实父链：普通流程后代也必须过 scope，不能靠解绑绕过。
await check('AC-4 子会话解绑后仍按真实父链所属流程判 scope', async () => {
  assert.equal(mod.currentService().childOwner.has('sess-review'), false)
  const d = await guard('write', { file_path: 'src/auth/session.ts' }, 'sess-review')
  assert.equal(d.kind, 'deny', '真实流程后代解绑后仍不能绕过 S1 的写限制')
  assert.match(d.reason, /S1|需求分析/)
})

await check('S1 同 cwd 独立顶层会话及其子代理放行', async () => {
  host.sessions.set('sess-independent', { header: { id: 'sess-independent', cwd: CWD, delegationDepth: 0 } })
  host.sessions.set('sess-independent-child', { header: { id: 'sess-independent-child', cwd: CWD, delegationDepth: 1, origin: 'subagent', parentSession: 'sess-independent' } })
  for (const id of ['sess-independent', 'sess-independent-child']) {
    assert.equal((await guard('write', { file_path: 'src/outside.ts' }, id)).kind, 'allow', id + ' 不属于流程，应放行')
    assert.equal((await guard('bash', { command: 'pnpm run independent' }, id)).kind, 'allow')
  }
})

await check('追问卡片挂起，用户点选项后工具返回答案', async () => {
  const pending = within(call('flowgate_ask', {
    question: '过期后是返回 401 还是静默续期？',
    options: [{ label: '返回 401', tradeoff: '客户端能明确提示重新登录' }, { label: '静默续期', tradeoff: '体验好但会掩盖会话失效' }],
    recommended: 0,
  }), 'flowgate_ask')
  await tick()
  const view = await getState()
  assert.equal(view.grill.pending.question, '过期后是返回 401 还是静默续期？')
  assert.equal(view.waitingKind, 'answer')
  assert.equal(view.waiting, true)
  const res = await post({ sessionId: SESSION, action: 'answer', payload: { choiceIndex: 0 } })
  assert.equal(res.status, 200)
  const value = await pending
  assert.equal(value.answered, true)
  assert.equal(value.choice, '返回 401')
})

await check('需求文档门禁：批准后 scope 冻结并进入 S2', async () => {
  const pending = within(call('flowgate_doc', {
    html: '<!doctype html><html><body><h1>需求</h1></body></html>',
    recommendedPreset: 'fast',
    reason: '只改一个中间件，范围可控',
    // AC-4：三份清单齐备、open_questions 为空、decisions 有两条 —— 走完整条 start → ask → doc 路径。
    decisions: [
      { question: '过期后是返回 401 还是静默续期？', answer: '返回 401' },
      { question: '过期检测放在中间件还是网关？', answer: '放在中间件' },
    ],
    assumptions: ['客户端会自己跳转登录页'],
    open_questions: [],
    scope: {
      files_expected_to_change: ['src/auth/session.ts'],
      commands: [],
      capabilities: ['会话过期检测'],
      out_of_scope_explicitly: ['OAuth 第三方登录'],
      acceptance_criteria: [{ id: 'AC-1', when: '会话超过 30 分钟未活动', then: '返回 401' }],
    },
  }), 'flowgate_doc')
  await tick()
  const res = await post({ sessionId: SESSION, action: 'doc', payload: { decision: 'approve' } })
  assert.equal(res.status, 200)
  const value = await pending
  assert.equal(value.decision, 'approve')
  assert.equal(value.frozen, true)
  const view = await getState()
  assert.equal(view.stage, 'S2')
  assert.equal(view.scope.frozen, true)
  // AC-4：决策清单随文档落盘，批准后仍能从状态里查到「问了什么、定了什么」。
  assert.equal(view.doc.grill.decisions.length, 2)
  assert.equal(view.doc.grill.decisions[0].question, '过期后是返回 401 还是静默续期？')
  assert.equal(view.doc.grill.decisions[1].answer, '放在中间件')
  assert.deepEqual(view.doc.grill.assumptions, ['客户端会自己跳转登录页'])
  assert.deepEqual(view.doc.grill.openQuestions, [])
  assert.deepEqual(view.doc.grill.blockers, [])
  assert.deepEqual(view.scope.data.in_scope.files_expected_to_change, ['src/auth/session.ts'])
})

await check('S2 无关会话或不完整父链放行，不污染所属流程台账', async () => {
  const service = mod.currentService()
  const flow = service.get(SESSION)
  const pending = structuredClone(flow.pendingCommands)
  const activity = structuredClone([...service.activity])
  const unrelated = [
    ['sess-independent', { delegationDepth: 0 }],
    ['sess-independent-child', { delegationDepth: 1, origin: 'subagent', parentSession: 'sess-independent' }],
    ['sess-depth-zero', { delegationDepth: 0, origin: 'subagent', parentSession: SESSION }],
    ['sess-depth-negative', { delegationDepth: -1, origin: 'subagent', parentSession: SESSION }],
    ['sess-depth-fraction', { delegationDepth: 0.5, origin: 'subagent', parentSession: SESSION }],
    ['sess-depth-string', { delegationDepth: '1', origin: 'subagent', parentSession: SESSION }],
    ['sess-depth-unsafe', { delegationDepth: Number.MAX_SAFE_INTEGER + 1, origin: 'subagent', parentSession: SESSION }],
    ['sess-wrong-origin', { delegationDepth: 1, origin: 'user', parentSession: SESSION }],
    ['sess-no-parent', { delegationDepth: 1, origin: 'subagent', parentSession: '' }],
    ['sess-missing-chain', { delegationDepth: 2, origin: 'subagent', parentSession: 'sess-unloaded-parent' }],
  ]
  for (const [id, header] of unrelated) {
    host.sessions.set(id, { header: { id, cwd: CWD, ...header } })
    assert.equal((await guard('write', { file_path: 'src/outside.ts' }, id)).kind, 'allow', id + ' 不应借 cwd 归入流程')
    assert.equal((await guard('bash', { command: 'pnpm run ' + id }, id)).kind, 'allow', id + ' 命令应放行')
  }
  assert.deepEqual(flow.pendingCommands, pending, '无关命令不能进入流程待补清单')
  assert.deepEqual([...service.activity], activity, '无关调用不能覆盖流程活动或新增活动记录')
})

await check('S2 未登记真实后代沿 sessions 与 agents 父链拒绝越界并记录所属流程', async () => {
  const service = mod.currentService()
  const flow = service.get(SESSION)
  host.agents.set('sess-agent-parent', { session: { header: { id: 'sess-agent-parent', cwd: CWD, delegationDepth: 1, origin: 'subagent', parentSession: SESSION } } })
  host.sessions.set('sess-grandchild', { header: { id: 'sess-grandchild', cwd: CWD, delegationDepth: 2, origin: 'subagent', parentSession: 'sess-agent-parent' } })
  for (const id of ['sess-review', 'sess-grandchild']) {
    assert.equal(service.childOwner.has(id), false, '用例必须走未登记会话父链')
    const denied = await guard('write', { file_path: 'src/outside.ts' }, id)
    assert.equal(denied.kind, 'deny')
    assert.match(denied.reason, /不在冻结 scope 内/)
    const command = 'pnpm run blocked-' + id
    assert.equal((await guard('bash', { command }, id)).kind, 'deny')
    assert.ok(flow.pendingCommands.some((entry) => entry.command === command && entry.stage === 'S2'), '后代命令应写入所属流程的待补清单')
    assert.equal(service.activity.get(SESSION)?.tool, 'bash')
    assert.equal(service.activity.has(id), false, '活动应记在流程所有者而非子会话')
    assert.equal(service.get(id), null, '后代不应另建流程')
    host.listeners.get('agent/status')({ status: 'idle', agent: execFor(id, 'bash', { command }).agent })
    assert.equal(service.activity.has(SESSION), false, '后代空闲应清除所属流程活动')
  }
  const declined = await post({ sessionId: SESSION, action: 'declineScopeCommands', payload: {} })
  assert.equal(declined.status, 200, '后续门禁前通过真实用户动作处理本例产生的待补命令')
  assert.deepEqual(flow.pendingCommands, [])
})

await check('S2 放行 scope 内的写操作', async () => {
  const d = await guard('write', { file_path: 'src/auth/session.ts' })
  assert.equal(d.kind, 'allow')
  const e = await guard('edit', { file_path: 'src/auth/session.ts' })
  assert.equal(e.kind, 'allow')
})

await check('S2 越界写被拒绝并给出回退指引', async () => {
  const d = await guard('write', { file_path: 'src/api/middleware.ts' })
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /不在冻结 scope 内/)
  assert.match(d.reason, /src\/auth\/session\.ts/)
  assert.match(d.reason, /回到需求分析阶段更新 scope\.json/)
})

// P0-2：数据目录由插件自己维护。以前是无条件放行，等于让 Agent 改自己的 scope 与状态快照。
// AC-7 / AC-10：命令授权必须绑住执行目录。审计流水与待补队列都要留下「在哪个目录跑的」，
// 用户点「补进清单」时也要把那个目录一起带进去——否则补进去的条目只认流程根，
// 同一条命令换个目录照样跑不了，用户还得再被拒一次。
await check('AC-7 审计流水与待补队列都记下执行目录', async () => {
  const sub = join(CWD, 'packages', 'web')
  mkdirSync(sub, { recursive: true })
  const header = host.sessions.get(SESSION).header
  const original = header.cwd
  const command = 'pnpm run denied-in-subdir'
  let denied
  try {
    header.cwd = sub
    denied = await guard('bash', { command })
  } finally {
    header.cwd = original
  }
  assert.equal(denied.kind, 'deny')
  const flow = mod.currentService().get(SESSION)
  const queued = flow.pendingCommands.find((entry) => entry.command === command)
  assert.ok(queued, '被拒命令必须进待补队列')
  assert.equal(queued.dir, 'packages/web', '待补队列要记下被拒时的执行目录')
  assert.equal(queued.cwd, sub)
  const events = readFileSync(join(CWD, '.dsh-flowgate', 'flows.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const audit = events.filter((item) => item.type === 'shell.denied' && item.detail?.command === command)
  assert.ok(audit.length, '判定必须进审计流水')
  assert.equal(audit.at(-1).detail.dir, 'packages/web', '审计要记下执行目录')
  assert.equal(audit.at(-1).detail.cwd, sub)
  assert.equal(audit.at(-1).detail.outcome, 'denied')
})

await check('AC-10 补进清单时自动带上被拒时的目录后缀', async () => {
  const command = 'pnpm run denied-in-subdir'
  const supplemented = await post({ sessionId: SESSION, action: 'reopenScopeForCommands', payload: {} })
  assert.equal(supplemented.status, 200, JSON.stringify(supplemented.data))
  const view = await getState()
  assert.equal(view.stage, 'S1', '补命令要退回需求分析重新批准 scope')
  assert.deepEqual(view.doc.pendingScope.commands, [command + ' [packages/web]'], '补进去的条目必须带目录后缀')
  // 重新批准后冻结的 scope 也要是带后缀的那一条：清单与执行目录一起被批准。
  const reapproved = await post({ sessionId: SESSION, action: 'doc', payload: { decision: 'approve', acceptScopeRisks: true } })
  assert.equal(reapproved.status, 200, JSON.stringify(reapproved.data))
  const after = await getState()
  assert.equal(after.stage, 'S2')
  assert.deepEqual(after.scope.data.in_scope.commands, [command + ' [packages/web]'])
})

// AC-7 的第二个入口：`ops_bash({ command, workdir })` 里的 workdir 才是真正决定跑哪个程序的东西。
// 会话 header.cwd 留在流程根，光看它就等于把目录绑定交回给调用方——本轮要修的问题会从这里原样漏回来。
await check('AC-7 命令带 workdir 时按 workdir 判定，审计与待补队列都记子目录', async () => {
  const command = 'pnpm run denied-via-workdir'
  const denied = await guard('bash', { command, workdir: 'packages/web' })
  assert.equal(denied.kind, 'deny', '清单条目只批准在流程根执行，workdir 换到子目录必须被拒')
  const flow = mod.currentService().get(SESSION)
  const queued = flow.pendingCommands.find((entry) => entry.command === command)
  assert.ok(queued, '被拒命令必须进待补队列')
  assert.equal(queued.dir, 'packages/web', '待补队列要记下 workdir 决定的执行目录')
  assert.equal(queued.cwd, join(CWD, 'packages', 'web'))
  // 同一条命令不带 workdir 就是流程根：审计里的 dir 要跟着变，不能一律记成流程根。
  assert.equal((await guard('bash', { command })).kind, 'deny')
  const events = readFileSync(join(CWD, '.dsh-flowgate', 'flows.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const audit = events.filter((item) => item.type === 'shell.denied' && item.detail?.command === command)
  assert.equal(audit.length, 2, '两次判定都要进审计流水')
  assert.equal(audit.at(-2).detail.dir, 'packages/web', '带 workdir 时审计要记子目录')
  assert.equal(audit.at(-1).detail.dir, '.', '不带 workdir 时审计要记流程根')
  assert.equal(audit.at(-2).detail.cwd, join(CWD, 'packages', 'web'))
  assert.equal(audit.at(-1).detail.cwd, CWD)
  const declined = await post({ sessionId: SESSION, action: 'declineScopeCommands', payload: {} })
  assert.equal(declined.status, 200, '清理本例产生的待补命令')
  assert.deepEqual(flow.pendingCommands, [])
})

await check('AC-7 空命令拒绝有审计且不进入待补队列', async () => {
  const flow = mod.currentService().get(SESSION)
  const count = flow.pendingCommands.length
  assert.equal((await guard('bash', { command: '   ', workdir: 'packages/web' })).kind, 'deny')
  assert.equal(flow.pendingCommands.length, count)
  const event = flow.events.at(-1)
  assert.equal(event.type, 'shell.denied')
  assert.equal(event.detail.outcome, 'empty')
  assert.equal(event.detail.dir, 'packages/web')
  assert.equal(event.detail.cwd, join(CWD, 'packages', 'web'))
})

// 审计流水只记「放行 / 拒绝」回答不了两个问题：它当时有多少权限、最后跑成没跑成。
// 权限模式、退出码、提权申请各记一条独立事件——合进 shell.allowed 会让「判定」与「结果」混成一条。
await check('审计流水记录权限模式、退出码与提权申请', async () => {
  const auditPath = join(CWD, '.dsh-flowgate', 'flows.jsonl')
  const events = () => readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const since = (start) => events().slice(start)

  // 判定事件：取不到宿主沙箱策略时写 unknown，而不是省略这个字段。
  // 省略会让「这条事件没有权限信息」和「老版本写的事件」长得一样。
  let start = events().length
  assert.equal((await guard('ops_bash', { command: 'pwd' })).kind, 'allow')
  const judged = since(start).filter((item) => item.type === 'shell.allowed').at(-1)
  assert.equal(judged.detail.mode, 'unknown')

  // 结果事件：判定放行之后，退出码由 tools/result 单独记一条。
  const resultListener = host.listeners.get('tools/result')
  assert.ok(resultListener, 'tools/result 必须注册')
  start = events().length
  resultListener(execFor(SESSION, 'ops_bash', { command: 'pwd' }), {
    isError: false, value: { exitCode: 3, signal: null, timedOut: false }, content: [],
  })
  const result = since(start).find((item) => item.type === 'shell.result')
  assert.ok(result, '执行结果必须留一条独立事件')
  assert.equal(result.detail.command, 'pwd')
  assert.equal(result.detail.exitCode, 3, '退出码是区分「跑成功」与「跑失败」的唯一硬证据')
  assert.equal(result.detail.mode, 'unknown')
  // 拿不到退出码（后台任务、宿主未提供）时写 null：省略会被读成成功。
  start = events().length
  resultListener(execFor(SESSION, 'ops_bash', { command: 'npm test' }), {
    isError: false, value: { kind: 'background', jobId: 'bash-1' }, content: [],
  })
  const background = since(start).find((item) => item.type === 'shell.result')
  assert.equal(background.detail.exitCode, null)
  assert.equal(background.detail.background, true)

  // 提权申请：模型带上 sandbox_permissions 重试的那一刻就留痕，与判定结果无关。
  start = events().length
  await guard('ops_bash', { command: 'pwd', sandbox_permissions: 'danger-full-access', justification: '需要写 dist' })
  const applied = since(start).find((item) => item.type === 'sandbox.escalated')
  assert.ok(applied, '提权申请必须留一条独立事件')
  assert.equal(applied.detail.tool, 'ops_bash')
  assert.equal(applied.detail.command, 'pwd')
  assert.equal(applied.detail.from, 'unknown')
  assert.equal(applied.detail.to, 'danger-full-access')
  assert.equal(applied.detail.justification, '需要写 dist')
  // 提权是独立的一条事件，不是塞进判定里的字段：判定照旧记它自己的结果，
  // 「申请升权」与「判定放行」在流水里必须是两个能分别过滤的类型。
  assert.ok(since(start).some((item) => item.type === 'shell.allowed' && item.detail.command === 'pwd'),
    '判定本身照旧记一条 shell.allowed')

  // 批准与驳回分开记：实际生效的那一档才是证据，调用有没有报错不算。
  const escalate = { command: 'pwd', sandbox_permissions: 'danger-full-access' }
  start = events().length
  resultListener(execFor(SESSION, 'ops_bash', escalate), {
    isError: false, value: { exitCode: 0, sandbox: { mode: 'danger-full-access', denied: false } }, content: [],
  })
  const approved = since(start).find((item) => item.type === 'sandbox.approved')
  assert.ok(approved, '批准必须单独记一条')
  assert.equal(approved.detail.effective, 'danger-full-access')
  start = events().length
  resultListener(execFor(SESSION, 'ops_bash', escalate), {
    isError: false, value: { exitCode: 0, sandbox: { mode: 'workspace-write', denied: false } }, content: [],
  })
  const declined = since(start).find((item) => item.type === 'sandbox.denied')
  assert.ok(declined, '驳回必须单独记一条')
  assert.equal(declined.detail.effective, 'workspace-write', '驳回时生效的还是原档位')
  assert.equal(declined.detail.to, 'danger-full-access')
})

await check('AC-10 目录无法确认时禁止补录，同名命令按目录分别处理', async () => {
  const command = 'pnpm run docs-check'
  assert.equal((await guard('bash', { command, workdir: 'packages/missing' })).kind, 'deny')
  assert.equal((await guard('bash', { command })).kind, 'deny')
  const view = await getState()
  const missing = view.pendingCommands.find((entry) => entry.dir === 'packages/missing')
  const root = view.pendingCommands.find((entry) => entry.dir === '.')
  assert.match(missing.directoryError, /无法确认执行目录/)
  assert.equal(missing.canSupplement, false)
  assert.equal(root.canSupplement, true)
  assert.notEqual(missing.selectionKey, root.selectionKey)
  const rejected = await post({ sessionId: SESSION, action: 'reopenScopeForCommands', payload: { commands: [missing.selectionKey] } })
  assert.equal(rejected.status, 409, JSON.stringify(rejected.data))
  assert.match(rejected.data.error, /无法确认执行目录/)
  const after = await getState()
  assert.equal(after.stage, 'S2')
  assert.deepEqual(after.scope.data.in_scope.commands, view.scope.data.in_scope.commands)
  const declined = await post({ sessionId: SESSION, action: 'declineScopeCommands', payload: { commands: [missing.selectionKey] } })
  assert.equal(declined.status, 200, JSON.stringify(declined.data))
  assert.deepEqual((await getState()).pendingCommands.map((entry) => entry.selectionKey), [root.selectionKey])
  assert.equal((await post({ sessionId: SESSION, action: 'declineScopeCommands', payload: {} })).status, 200)
})

await check('数据目录不接受工具写入（含 S2 内部台账）', async () => {
  const d = await guard('write', { file_path: '.dsh-flowgate/notes.md' })
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /由插件自身维护/)
  const snapshot = await guard('write', { file_path: '.dsh-flowgate/flows/f_x.json' })
  assert.equal(snapshot.kind, 'deny')
})

await check('「完成开发」门禁自动采集变更摘要并进入 S3', async () => {
  const pending = within(call('flowgate_gate', { summary: '改完了' }), 'flowgate_gate S2')
  await tick()
  const res = await post({ sessionId: SESSION, action: 'gate', payload: { decision: 'pass' } })
  assert.equal(res.status, 200)
  const value = await pending
  assert.equal(value.decision, 'pass')
  assert.equal(value.next, 'S3')
  const view = await getState()
  assert.equal(view.stage, 'S3')
  assert.equal(view.devChanges.files.length, 1)
  assert.equal(view.devChanges.added, 3)
})

await check('评审阻塞时仅允许当前报告的显式风险接受进入 S4', async () => {
  const pending = within(call('flowgate_review', {
    angles: [{
      id: 'correctness',
      name: '正确性',
      verdict: 'blocking',
      findings: [reviewFinding('MAJOR', '未处理并发刷新')],
    }],
  }), 'flowgate_review')
  await tick()
  const mid = await getState()
  const eventCount = () => readFileSync(join(CWD, '.dsh-flowgate', 'flows.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length
  assert.equal(mid.review.blocking, 1)
  assert.equal(mid.review.angles[0].findings[0].file, 'src/auth/session.ts')
  for (const decision of ['pass', 'skip']) {
    const denied = await post({ sessionId: SESSION, action: 'gate', payload: { decision } })
    assert.equal(denied.status, 409, decision + ' must not advance a blocking review')
  }
  assert.equal((await getState()).waiting, true)
  const beforeOldReport = eventCount()
  const oldReport = await post({ sessionId: SESSION, action: 'gate', payload: { decision: 'accept-risk', reviewId: 'old-report', riskReason: 'accept' } })
  assert.equal(oldReport.status, 409)
  assert.equal(eventCount(), beforeOldReport)
  assert.equal((await getState()).stage, 'S3')
  const source = join(CWD, 'src/auth/session.ts')
  const original = readFileSync(source, 'utf8')
  writeFileSync(source, original + 'changed after review\n')
  const beforeStale = eventCount()
  const stale = await post({ sessionId: SESSION, action: 'gate', payload: { decision: 'accept-risk', reviewId: mid.review.id, riskReason: 'accept stale' } })
  assert.equal(stale.status, 409, '失效报告不能复用风险接受')
  assert.match(stale.data.error, /快照已失效/)
  assert.equal((await getState()).stage, 'S3')
  assert.equal(eventCount(), beforeStale)
  writeFileSync(source, original)
  const replaced = within(call('flowgate_review', {
    angles: [{ id: 'correctness', name: '正确性', verdict: 'blocking',
      findings: [reviewFinding('MAJOR', '重新核对并发刷新')] }],
  }), 'flowgate_review replacement')
  await tick()
  const fresh = await getState()
  assert.notEqual(fresh.review.id, mid.review.id, '重交报告应更新例外绑定目标')
  assert.equal((await pending).decision, 'wait', '旧评审等待器已被新报告取代')
  const beforeReplay = eventCount()
  const replay = await post({ sessionId: SESSION, action: 'gate', payload: { decision: 'accept-risk', reviewId: mid.review.id, riskReason: '旧理由' } })
  assert.equal(replay.status, 409, '旧报告 id 不得沿用')
  assert.equal((await getState()).stage, 'S3')
  assert.equal(eventCount(), beforeReplay)
  const res = await post({ sessionId: SESSION, action: 'gate', payload: { decision: 'accept-risk', reviewId: fresh.review.id } })
  assert.equal(res.status, 200)
  const value = await replaced
  assert.equal(value.decision, 'accept-risk')
  assert.equal(value.next, 'S4')
  assert.doesNotMatch(value.message, /^评审通过/)
  const view = await getState()
  assert.equal(view.stage, 'S4')
  assert.equal(view.skippedCount, 0)
  const stage = view.stages.find((item) => item.id === 'S3')
  assert.equal(stage.status, 'accepted_with_risk')
  assert.equal(stage.riskAcceptance.reason, undefined)
  assert.equal(stage.riskAcceptance.reviewId, fresh.review.id)
  assert.equal(stage.riskAcceptance.version, fresh.review.snapshot.id)
  const events = readFileSync(join(CWD, '.dsh-flowgate', 'flows.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(events.filter((event) => event.type === 'gate.risk_accepted' && event.detail.stage === 'S3' && !('reason' in event.detail)).length, 1)
  assert.ok(!events.some((event) => event.type === 'gate.passed' && event.detail.stage === 'S3'))
})

await check('测试汇总通过不能替代 AC 证据，明确接受缺口后结束', async () => {
  const pending = within(call('flowgate_test', {
    directions: [{
      id: 'smoke',
      name: '冒烟验证',
      points: [{ point: '过期后请求返回 401', result: 'pass' }, { point: '未过期请求正常', result: 'pass' }],
    }],
  }), 'flowgate_test')
  await tick()
  const rejected = await post({ sessionId: SESSION, action: 'gate', payload: { decision: 'pass' } })
  assert.equal(rejected.status, 409)
  assert.match(rejected.data.error, /验收标准.*未通过/)
  assert.equal((await getState()).waiting, true, '拒绝发生在唤醒等待工具之前')
  const falseFlag = await post({ sessionId: SESSION, action: 'gate', payload: { decision: 'pass', acceptUncovered: 'true' } })
  assert.equal(falseFlag.status, 409, '字符串不能冒充明确的布尔确认')
  const res = await post({ sessionId: SESSION, action: 'gate', payload: { decision: 'pass', acceptUncovered: true, acceptanceNote: '接受本次未执行会话请求的验证缺口' } })
  assert.equal(res.status, 200)
  const value = await pending
  assert.equal(value.decision, 'pass')
  const view = await getState()
  assert.equal(view.finished, true)
  assert.equal(view.acceptanceDecision.status, 'accepted-with-gaps')
  assert.equal(view.acceptanceDecision.note, '接受本次未执行会话请求的验证缺口')
  assert.equal(view.acceptance.counts.uncovered, 1, '接受例外不能把未覆盖项改成通过')
  // 结束方式要三处同口径：阶段记录、审计事件、closure。
  assert.equal(view.stages.find((stage) => stage.id === 'S4').status, 'accepted_with_gaps', '阶段记录不能写 passed')
  assert.equal(view.closure.kind, 'accepted_with_gaps')
  assert.deepEqual(view.closure.counts, view.acceptance.counts)
  const tail = readFileSync(join(CWD, '.dsh-flowgate', 'flows.jsonl'), 'utf8').trim().split(String.fromCharCode(10)).map((line) => JSON.parse(line))
  const gapEvents = tail.filter((event) => event.flowId === view.id)
  assert.equal(gapEvents.filter((event) => event.type === 'gate.accepted_with_gaps' && event.detail.stage === 'S4').length, 1, '带缺口结项要有独立事件')
  assert.ok(!gapEvents.some((event) => event.type === 'gate.passed' && event.detail.stage === 'S4'), '带缺口结项不能同时写 gate.passed')
  assert.ok(gapEvents.some((event) => event.type === 'flow.finished' && event.detail.closure === 'accepted_with_gaps'), '结束事件要写明结束方式')
  assert.equal(view.workspace.flow, null)
  assert.equal((await getState('sess-other')).workspace.active, false)
})

await check('流程结束后写操作不再受 scope 限制', async () => {
  const d = await guard('write', { file_path: 'src/anything.ts' })
  assert.equal(d.kind, 'allow')
})

await check('flows.jsonl 记录完整阶段事件', async () => {
  const file = join(CWD, '.dsh-flowgate', 'flows.jsonl')
  assert.ok(existsSync(file), 'flows.jsonl 必须落盘')
  const events = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const kinds = events.map((e) => e.type)
  for (const expected of ['flow.started', 'gate.passed', 'review.submitted', 'test.submitted', 'flow.finished']) {
    assert.ok(kinds.includes(expected), '缺少事件 ' + expected)
  }
  assert.ok(events.some((e) => e.type === 'gate.risk_accepted' && e.detail.stage === 'S3'))
})

await check('未知 session 的 state 请求给出非活动视图', async () => {
  const view = await getState('nope')
  assert.equal(view.active, false)
})

await check('action 缺字段返回 400', async () => {
  const res = await post({ sessionId: SESSION })
  assert.equal(res.status, 400)
})

await check('scope.json 冻结后落盘', async () => {
  const file = join(CWD, '.dsh-flowgate', 'scope.json')
  assert.ok(existsSync(file))
  const scope = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(scope.in_scope.files_expected_to_change[0], 'src/auth/session.ts')
})

await check('当前版本的逐 AC 实际执行证据才可正常验收通过', async () => {
  const S = 'sess-proof'
  const sample = join(CWD, 'proof.txt')
  writeFileSync(sample, '本轮已读取的样例', 'utf8')
  await call('flowgate_start', { title: '证据闭环', preset: 'fast' }, S)
  const doc = within(call('flowgate_doc', {
    html: '<html><body>验证实际样例读取</body></html>',
    scope: { files_expected_to_change: ['proof.txt', 'test/integration.test.mjs'],
      commands: ['node test/integration.test.mjs'], capabilities: [], out_of_scope_explicitly: [],
      acceptance_criteria: [{ id: 'AC-1', when: '读取本轮样例文件', then: '得到本轮写入的精确文本',
        verification: { method: 'integration', procedure: '在集成测试中读取 proof.txt 并断言精确文本', commands: ['node test/integration.test.mjs'] } }] },
  }, S), '证据文档')
  await tick()
  // 本例要验证「证据能对上版本」。scope 必须自带集成测试要动的文件与命令：
  // 缺口类问题在提交这一步就退回给 Agent 补齐了，走不到批准按钮。
  assert.equal((await post({ sessionId: S, action: 'doc', payload: { decision: 'approve' } })).status, 200)
  await doc
  const dev = within(call('flowgate_gate', {}, S), '证据开发门禁')
  await tick()
  assert.equal((await post({ sessionId: S, action: 'gate', payload: { decision: 'pass' } })).status, 200)
  await dev
  const review = within(call('flowgate_review', { angles: [{ id: 'correctness', name: '正确性', verdict: 'pass', findings: [] }] }, S), '证据评审')
  await tick()
  assert.equal((await post({ sessionId: S, action: 'gate', payload: { decision: 'pass' } })).status, 200)
  await review
  const version = (await getState(S)).snapshot.id
  assert.equal(readFileSync(sample, 'utf8'), '本轮已读取的样例')
  const verified = within(call('flowgate_test', {
    directions: [{ id: 'smoke', name: '读取集成验证', points: [{ point: '读取样例并断言精确文本', result: 'pass' }] }],
    acceptance: [{ ac: 'AC-1', status: 'pass', method: 'integration', version,
      evidence: 'test/integration.test.mjs 已实际 readFileSync(proof.txt) 并 strictEqual 精确文本，通过。' }],
  }, S), '证据验收')
  await tick()
  const mid = await getState(S)
  assert.equal(mid.acceptance.counts.pass, 1)
  assert.equal(mid.acceptance.items[0].method, 'integration')
  assert.equal(mid.acceptance.items[0].version, version)
  const accepted = await post({ sessionId: S, action: 'gate', payload: { decision: 'pass' } })
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data))
  await verified
  const done = await getState(S)
  assert.equal(done.finished, true)
  assert.equal(done.acceptanceDecision.status, 'passed')
  assert.equal(done.acceptanceDecision.counts.pass, 1)
})

await check('state 只根据真实上报的客户端代码指纹核对页面版本', async () => {
  const digest = clientFactoryRevision(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  assert.match(digest, /^[a-f0-9]{64}$/)
  const query = async (revision) => (await stateRoute.fetch({ url: 'http://host/api/flowgate/state?sessionId=sess-proof&clientRevision=' + revision + '&pageId=de54a6e1-b162-42c9-910a-470575847521&viewportWidth=1280&viewportHeight=800' })).json()
  assert.equal((await query(digest)).runtime.status, 'verified')
  assert.equal((await query('f'.repeat(64))).runtime.status, 'mismatch')
  assert.equal((await query(digest)).runtime.status, 'verified')
})

// G38：非法上报必须留痕，不能和「没参与」同值——否则 status 会沉默地把垃圾读成 absent。
await check('非法指纹记 rejected 并清掉旧可信记录，只有完全不带上报才算没参与', async () => {
  const digest = clientFactoryRevision(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  const query = async (revision) => (await stateRoute.fetch({ url: 'http://host/api/flowgate/state?sessionId=sess-proof&clientRevision=' + revision + '&pageId=de54a6e1-b162-42c9-910a-470575847521&viewportWidth=1280&viewportHeight=800' })).json()
  assert.equal((await query(digest)).runtime.status, 'verified')
  const rejected = (await query('invalid')).runtime
  assert.equal(rejected.status, 'unverified', '非法指纹不能被当成已核对')
  assert.equal(rejected.clientStatus, 'unverified', 'rejected 必须与 absent 分开记')
  assert.match(rejected.clientReason, /上报被拒/)
  assert.equal(rejected.clientRevision, '', '非法指纹不能顶替旧的可信指纹')
  assert.equal((await getState('sess-proof')).runtime.clientStatus, 'absent', '完全不带参数才算没参与')
})

// G38/AC-2：factory 标记损坏时客户端没有指纹可报，但仍会带 pageId+viewport 上报。
// 端到端必须念成「页面源码标记缺失」——念成「上报被拒」会把 Agent 引去查上报参数而不是查构建标记。
await check('页面参与了轮询却没有指纹可报时念成源码标记缺失，不是上报被拒', async () => {
  const noMark = await (await stateRoute.fetch({ url: 'http://host/api/flowgate/state?sessionId=sess-proof&pageId=de54a6e1-b162-42c9-910a-470575847521&viewportWidth=1280&viewportHeight=800' })).json()
  assert.equal(noMark.runtime.clientStatus, 'unverified', '参与了但读不懂，不能算没参与')
  assert.match(noMark.runtime.clientReason, /页面源码标记缺失/)
  assert.doesNotMatch(noMark.runtime.clientReason, /指纹不是 64 位十六进制/)
  assert.equal(noMark.runtime.hostStatus, 'verified', '页面侧的问题不能拖累宿主层判定')
  const invalid = await (await stateRoute.fetch({ url: 'http://host/api/flowgate/state?sessionId=sess-proof&clientRevision=zzz&pageId=de54a6e1-b162-42c9-910a-470575847521&viewportWidth=1280&viewportHeight=800' })).json()
  assert.match(invalid.runtime.clientReason, /上报被拒/)
  assert.match(invalid.runtime.clientReason, /指纹不是 64 位十六进制/)
})

await check('布局采集回执绑定内容、页面实例和视口，视口变化会使证据失效', async () => {
  // 此处是宿主 API 契约夹具；矩形来自测试替身，不是实际桌面布局结果。
  const S = 'sess-layout-proof'
  await call('flowgate_start', { title: '布局回执契约', preset: 'fast' }, S)
  const doc = within(call('flowgate_doc', { html: '<html><body>对齐采集契约</body></html>',
    scope: { files_expected_to_change: ['proof.txt'], commands: [], capabilities: [], out_of_scope_explicitly: [],
      acceptance_criteria: [{ id: 'AC-1', when: '显示样例行', then: '与参照左右对齐',
        verification: { method: 'visual', procedure: '从已核对页面采集实际左右边界' } }] },
  }, S), '布局回执文档')
  await tick()
  assert.equal((await post({ sessionId: S, action: 'doc', payload: { decision: 'approve' } })).status, 200)
  await doc
  const dev = within(call('flowgate_gate', {}, S), '布局回执开发门禁')
  await tick()
  assert.equal((await post({ sessionId: S, action: 'gate', payload: { decision: 'pass' } })).status, 200)
  await dev
  const review = within(call('flowgate_review', { angles: [{ id: 'correctness', name: '正确性', verdict: 'pass', findings: [] }] }, S), '布局回执评审')
  await tick()
  assert.equal((await post({ sessionId: S, action: 'gate', payload: { decision: 'pass' } })).status, 200)
  await review
  const digest = clientFactoryRevision(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  const pageId = 'a6ac4d37-b034-4bdf-b622-6c72b74c6083'
  const page = async (width = 1280) => (await stateRoute.fetch({ url: 'http://host/api/flowgate/state?sessionId=' + S + '&clientRevision=' + digest + '&pageId=' + pageId + '&viewportWidth=' + width + '&viewportHeight=800' })).json()
  const view = await page()
  assert.equal(view.runtime.status, 'verified')
  const viewport = { width: 1280, height: 800 }
  const measurements = [{ element: '.fixture-row', reference: 'fixture-reference', left: 10, right: 400, referenceLeft: 10, referenceRight: 400 }]
  const payload = { version: view.snapshot.id, pageId, clientRevision: digest, viewport, measurements }
  assert.equal((await post({ sessionId: S, action: 'layout-evidence', payload: { ...payload, pageId: 'wrong-page' } })).status, 409)
  assert.equal((await post({ sessionId: S, action: 'layout-evidence', payload: { ...payload, version: '0'.repeat(64) } })).status, 409)
  assert.equal((await post({ sessionId: S, action: 'layout-evidence', payload: { ...payload, measurements: [{ ...measurements[0], right: 10 }] } })).status, 409)
  const captured = await post({ sessionId: S, action: 'layout-evidence', payload })
  assert.equal(captured.status, 200, JSON.stringify(captured.data))
  const receipt = captured.data.layoutEvidence
  assert.equal(receipt.version, view.snapshot.id)
  assert.equal(receipt.pageId, pageId)
  const test = within(call('flowgate_test', { directions: [{ id: 'smoke', name: '布局取证契约', points: [{ point: '验证回执绑定', result: 'pass' }] }],
    acceptance: [{ ac: 'AC-1', status: 'pass', method: 'visual', version: view.snapshot.id,
      evidence: '宿主 API 契约夹具已核验采集回执绑定，不代表真实桌面测量。', evidenceId: receipt.id,
      runtime: { hostRevision: view.runtime.hostRevision, clientRevision: digest, pageId, viewport }, measurements }],
  }, S), '布局回执验收')
  await tick()
  assert.equal((await page()).acceptance.counts.pass, 1)
  assert.equal((await page(1024)).acceptance.counts.uncovered, 1, '同代码不同视口不能沿用测量')
  assert.equal((await post({ sessionId: S, action: 'gate', payload: { decision: 'pass' } })).status, 409)
  assert.equal((await page()).acceptance.counts.pass, 1)
  assert.equal((await post({ sessionId: S, action: 'gate', payload: { decision: 'pass' } })).status, 200)
  await test
  assert.equal((await page()).acceptanceDecision.status, 'passed')
})

await check('flowgate_review_run 为每个角度 spawn 只读子代理并带上开发规则', async () => {
  const S = 'sess-rev'
  await call('flowgate_start', { title: '子代理评审', preset: 'fast' }, S)
  const docPending = within(call('flowgate_doc', {
    html: '<!doctype html><html><body>子代理评审</body></html>',
    scope: {
      files_expected_to_change: ['src/auth/session.ts'],
      commands: [],
      capabilities: ['会话过期检测'],
      out_of_scope_explicitly: [],
      acceptance_criteria: [{ id: 'AC-1', when: '会话过期', then: '返回 401' }],
    },
  }, S), 'flowgate_doc 子代理流程')
  await tick()
  await post({ sessionId: S, action: 'doc', payload: { decision: 'approve' } })
  await docPending

  const gatePending = within(call('flowgate_gate', {}, S), 'flowgate_gate 子代理流程')
  await tick()
  await post({ sessionId: S, action: 'gate', payload: { decision: 'pass' } })
  await gatePending

  host.spawns.length = 0
  const reviewPending = within(call('flowgate_review_run', {}, S), 'flowgate_review_run')
  await tick()

  const view = await getState(S)
  assert.equal(view.review.angles.length, 2, 'fast 档应有两个评审角度')
  assert.equal(view.review.blocking, 0)
  assert.equal(host.spawns.length, 2, '每个角度各 spawn 一个子代理')

  const reviewSpawn = host.spawns.find((item) => String(item.request.label).includes('正确性'))
  assert.ok(reviewSpawn, '应有正确性角度的子代理')
  assert.equal(reviewSpawn.provider, 'spawn')
  assert.equal(reviewSpawn.request.delivery, 'caller')
  assert.ok(reviewSpawn.request.childId, '必须预留真实 childId')
  assert.equal(reviewSpawn.request.toolFilter, undefined, '新协议不发送旧 toolFilter')
  assert.equal(reviewSpawn.request.parent.session.header.id, S)
  assert.ok(host.spawns.every((item) => item.released), '每次 activation 都应释放：' + JSON.stringify(view.review.angles))
  assert.equal(mod.currentService().childOwner.size, 0, '停止成功后解绑只读会话')
  assert.equal(view.review.angles[0].findings[0].file, 'src/auth/session.ts', '必须实际采用子代理报告')
  // PRD 4.5：正确性角度会逐条核对用户定义的开发规则。
  const prompt = reviewSpawn.request.prompt[0].text
  assert.match(prompt, /用户定义的开发规则/)
  assert.match(prompt, /只改 scope 内的文件/)

  const res = await post({ sessionId: S, action: 'gate', payload: { decision: 'skip' } })
  assert.equal(res.status, 200)
  const value = await reviewPending
  assert.equal(value.decision, 'skip')
  assert.equal(value.next, 'S4')
})

// 侧栏全局面板：不属于任何会话，只按盘上的 flows/ 做跨工作区只读清单。
const hubRoute = host.routes.get('/api/flowgate/hub')
const postHub = async (body) => {
  const res = await hubRoute.fetch({ json: async () => body })
  return { status: res.status, data: await res.json() }
}

await check('hub 拒绝非法路径，不越界读盘', async () => {
  const res = await postHub({ paths: ['relative/dir', 42] })
  assert.equal(res.status, 200)
  assert.deepEqual(res.data.workspaces, [])
})

await check('hub 按工作区返回流程摘要与待确认数', async () => {
  const res = await postHub({ paths: [CWD] })
  assert.equal(res.status, 200)
  assert.equal(res.data.workspaces.length, 1, '同一路径重复时只算一个工作区')
  const workspace = res.data.workspaces[0]
  assert.equal(workspace.path, CWD)
  // 同一目录可能有多个会话的流程：面板列出全部，不按会话过滤。
  assert.ok(workspace.flows.length >= 1)
  const flow = workspace.flows.find((item) => item.sessionId === SESSION)
  assert.ok(flow, '必须包含本会话的流程')
  assert.equal(flow.finished, true, '这条流程已经验收通过')
  assert.equal(flow.stage, 'S4')
  assert.equal(flow.stageLabel, '测试')
  assert.equal(typeof workspace.waitingCount, 'number')
  assert.equal(workspace.activeCount, workspace.flows.filter((item) => !item.finished && !item.cancelled).length)
  assert.ok(flow.brief.length <= 200, 'brief 要截断，别把长需求整段塞进面板')
  assert.equal(flow.summary, undefined, 'Hub 列表也不再带整理稿')
})

await check('hub 带上重复路径时不重复计入', async () => {
  const res = await postHub({ paths: [CWD, CWD] })
  assert.equal(res.data.workspaces.length, 1)
})

await check('Hub 成员摘要与分页计数一致，分页包含完成及活跃流程', async () => {
  const members = await postHubApi('members', {})
  const page = await postHubApi('flows', { path: CWD, pageSize: 50 })
  assert.equal(members.status, 200)
  assert.equal(page.status, 200)
  const member = members.data.members.find((item) => item.path === CWD)
  assert.equal(Object.hasOwn(member, 'flows'), false)
  assert.equal(member.flowCount, page.data.total)
  assert.equal(member.activeCount, page.data.flows.filter((flow) => !flow.finished && !flow.cancelled).length)
  assert.ok(page.data.flows.some((flow) => flow.sessionId === SESSION && flow.finished))
  assert.ok(page.data.flows.some((flow) => !flow.finished))
  assert.deepEqual(page.data.currentFlow, page.data.flows.find((flow) => !flow.finished && !flow.cancelled))
  const one = await postHubApi('flows', { path: CWD, page: page.data.total, pageSize: 1 })
  assert.deepEqual(one.data.currentFlow, page.data.currentFlow, '当前流程摘要独立于页码和每页条数')
  const cleared = await postHubApi('rules', { path: CWD, rules: null })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.data.rules.configured, false)
  assert.equal(cleared.data.rules.ids.length, 5)
  for (const stage of ['S1', 'S3', 'S4']) assert.equal(cleared.data.rules.stages[stage].configured, true)
})

if (PREVIOUS_HUB_HOME === undefined) delete process.env.DSH_FLOWGATE_HOME
else process.env.DSH_FLOWGATE_HOME = PREVIOUS_HUB_HOME
console.log('\n全部通过：' + passed + ' 项')
