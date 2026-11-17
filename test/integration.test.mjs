import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// 假宿主：只实现 flowgate 用到的 ctx 能力（inject/effect/on/get/tools/connection/workingDirectory），
// 让真实的 apply() 跑起来，从而验证注册、守卫、路由与门禁全链路。
const CWD = join(process.cwd(), '.tmp-it')
rmSync(CWD, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

const SESSION = 'sess-main'
const SHELL_OUT = ' M src/auth/session.ts\n---numstat---\n3\t1\tsrc/auth/session.ts\n'

function makeHost() {
  const tools = new Map()
  const routes = new Map()
  const listeners = new Map()
  // 只读过滤用的工具可见性：与 flowgate 自己注册的工具分开，避免污染 host.tools 的断言。
  const visible = new Set([
    'write', 'edit', 'str_replace_editor', 'subagent', 'subagent_fork', 'workflow', 'send_message', 'web_search',
  ])
  // 假子代理：捕获 spawn 请求，立即返回一份结构化报告。
  const spawns = []
  const subagents = {
    list: () => ['spawn'],
    async start(provider, request) {
      spawns.push({ provider, request })
      return {
        id: 'child-' + spawns.length,
        result: Promise.resolve({
          stopReason: 'completed',
          output: [{
            type: 'text',
            text: JSON.stringify({
              verdict: 'advisory',
              suggestUpgrade: false,
              findings: [{ file: 'src/auth/session.ts', line: 42, severity: 'MINOR', summary: '缺少失败路径的注释' }],
            }),
          }],
        }),
        dispose: async () => {},
      }
    },
  }
  const host = { tools, routes, listeners, spawns }
  const ctx = {
    inject(_deps, cb) { cb(ctx) },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on(event, handler) { listeners.set(event, handler); return () => {} },
    get(name) {
      if (name === 'sessions') return { get: (id) => ({ header: { id, cwd: CWD } }) }
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
      // spawnReadonlyChild 用 tools.get 与 READONLY_DENY 取交集。
      get(name) { return tools.get(name) ?? (visible.has(name) ? { name } : undefined) },
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

const execFor = (sessionId, name, args) => ({
  name, arguments: args, signal: undefined,
  agent: { session: { header: { id: sessionId, cwd: CWD } } },
})

const call = (name, args, sessionId = SESSION) => host.tools.get(name).execute(args, execFor(sessionId, name, args))

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

await check('apply 注册 9 个工具与 2 条路由', () => {
  assert.deepEqual([...host.tools.keys()].sort(), [
    'flowgate_ask', 'flowgate_doc', 'flowgate_gate', 'flowgate_review',
    'flowgate_review_run', 'flowgate_start', 'flowgate_status', 'flowgate_test', 'flowgate_test_run',
  ])
  assert.ok(host.routes.has('/api/flowgate/state'))
  assert.ok(host.routes.has('/api/flowgate/action'))
  assert.deepEqual([...host.routes.values()].map((r) => r.methods.join(',')).sort(), ['GET', 'POST'])
})

await check('未启动时 status 给出引导', async () => {
  const value = await call('flowgate_status', {})
  assert.equal(value.active, false)
  assert.match(value.summary, /flowgate_start/)
})

await check('未启动时 S1 之外的写操作不被守卫拦截（无流程即不管）', async () => {
  const d = await guard('write', { path: 'src/anything.ts' })
  assert.equal(d.kind, 'allow')
})

await check('flowgate_start 启动流程并进入 S1', async () => {
  const value = await call('flowgate_start', { title: '会话过期检测', preset: 'fast' })
  assert.equal(value.stage, 'S1')
  const view = await getState()
  assert.equal(view.active, true)
  assert.equal(view.stage, 'S1')
  assert.equal(view.preset, 'fast')
})

await check('S1 阶段的写操作被拒绝', async () => {
  const d = await guard('write', { path: 'src/auth/session.ts' })
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
  service.registerChild(SESSION, 'sess-review')
  try {
    for (const name of ['write', 'edit', 'str_replace_editor']) {
      const d = await guard(name, { path: 'src/auth/session.ts' }, 'sess-review')
      assert.equal(d.kind, 'deny', name + ' 必须被拒绝')
      assert.match(d.reason, /只读/)
    }
    const shell = await guard('bash', { command: 'rm -rf src' }, 'sess-review')
    assert.equal(shell.kind, 'deny')
    const readShell = await guard('bash', { command: 'git diff' }, 'sess-review')
    assert.equal(readShell.kind, 'allow')
    const read = await guard('read', { file_path: 'src/auth/session.ts' }, 'sess-review')
    assert.equal(read.kind, 'allow')
  } finally {
    service.unregisterChild('sess-review')
  }
})

// D2：用户显式授权的测试方向可以跑变更性 shell，但代码写工具仍然拒绝。
await check('D2 已授权的测试子代理可跑变更性 shell，写工具仍拒绝', async () => {
  const service = mod.currentService()
  service.registerChild(SESSION, 'sess-test', { allowShellWrite: true })
  try {
    const shell = await guard('bash', { command: 'pnpm migrate && pnpm migrate:rollback' }, 'sess-test')
    assert.equal(shell.kind, 'allow', '授权后的变更性 shell 应放行')
    const write = await guard('write', { path: 'src/auth/session.ts' }, 'sess-test')
    assert.equal(write.kind, 'deny', '写权限例外不覆盖代码写工具')
  } finally {
    service.unregisterChild('sess-test')
  }
})

await check('AC-4 子会话解绑后回到父流程的 scope 判定', async () => {
  const d = await guard('write', { path: 'src/auth/session.ts' }, 'sess-review')
  assert.equal(d.kind, 'allow', '没有流程归属的会话不应被只读守卫拦住')
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
    scope: {
      files_expected_to_change: ['src/auth/session.ts'],
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
  assert.deepEqual(view.scope.data.in_scope.files_expected_to_change, ['src/auth/session.ts'])
})

await check('S2 放行 scope 内的写操作', async () => {
  const d = await guard('write', { path: 'src/auth/session.ts' })
  assert.equal(d.kind, 'allow')
  const e = await guard('edit', { file_path: 'src/auth/session.ts' })
  assert.equal(e.kind, 'allow')
})

await check('S2 越界写被拒绝并给出回退指引', async () => {
  const d = await guard('write', { path: 'src/api/middleware.ts' })
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /不在冻结 scope 内/)
  assert.match(d.reason, /src\/auth\/session\.ts/)
  assert.match(d.reason, /回到需求分析阶段更新 scope\.json/)
})

await check('S2 内部台账文件不受 scope 限制', async () => {
  const d = await guard('write', { path: '.dsh-flowgate/notes.md' })
  assert.equal(d.kind, 'allow')
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

await check('评审报告按角度聚合，跳过门禁进入 S4', async () => {
  const pending = within(call('flowgate_review', {
    angles: [{
      id: 'correctness',
      name: '正确性',
      verdict: 'blocking',
      findings: [{ file: 'src/auth/session.ts', line: 42, severity: 'MAJOR', summary: '未处理并发刷新' }],
    }],
  }), 'flowgate_review')
  await tick()
  const mid = await getState()
  assert.equal(mid.review.blocking, 1)
  assert.equal(mid.review.angles[0].findings[0].file, 'src/auth/session.ts')
  const res = await post({ sessionId: SESSION, action: 'gate', payload: { decision: 'skip' } })
  assert.equal(res.status, 200)
  const value = await pending
  assert.equal(value.decision, 'skip')
  assert.equal(value.next, 'S4')
  const view = await getState()
  assert.equal(view.stage, 'S4')
  assert.equal(view.skippedCount, 1)
})

await check('测试报告按方向聚合，验收后流程结束', async () => {
  const pending = within(call('flowgate_test', {
    directions: [{
      id: 'smoke',
      name: '冒烟验证',
      points: [{ point: '过期后请求返回 401', result: 'pass' }, { point: '未过期请求正常', result: 'pass' }],
    }],
  }), 'flowgate_test')
  await tick()
  const res = await post({ sessionId: SESSION, action: 'gate', payload: { decision: 'pass' } })
  assert.equal(res.status, 200)
  const value = await pending
  assert.equal(value.decision, 'pass')
  const view = await getState()
  assert.equal(view.finished, true)
})

await check('流程结束后写操作不再受 scope 限制', async () => {
  const d = await guard('write', { path: 'src/anything.ts' })
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
  assert.ok(events.some((e) => e.type === 'gate.skipped'))
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

await check('flowgate_review_run 为每个角度 spawn 只读子代理并带上开发规则', async () => {
  const S = 'sess-rev'
  await call('flowgate_start', { title: '子代理评审', preset: 'fast' }, S)
  const docPending = within(call('flowgate_doc', {
    html: '<!doctype html><html><body>子代理评审</body></html>',
    scope: {
      files_expected_to_change: ['src/auth/session.ts'],
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
  // PRD 4.3.1：只读靠 toolFilter.deny 在工具层封死，不是提示词建议。
  assert.deepEqual(
    reviewSpawn.request.toolFilter.deny.slice().sort(),
    ['edit', 'send_message', 'str_replace_editor', 'subagent', 'subagent_fork', 'web_search', 'workflow', 'write'],
  )
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

rmSync(CWD, { recursive: true, force: true })
console.log('\n全部通过：' + passed + ' 项')
