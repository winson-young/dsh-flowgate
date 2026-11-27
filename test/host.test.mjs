import assert from 'node:assert/strict'
import fs, { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { captureSync } from '../scripts/capture-child.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, scopeDenial, shellDenial, currentService, parseChanges } from '../lib/index.js'
import { prepareRequirement, SYSTEM_PROMPT, TIMEOUT_MS } from '../lib/requirements.js'

// ---------------------------------------------------------------------------
// 宿主端 mock：只实现插件实际用到的 ctx 成员。
// ---------------------------------------------------------------------------

// flowgate_doc 现在必须交代追问结果（decisions / assumptions / open_questions）。
// 本文件多数用例关心的是门禁与 scope 语义，不是追问内容，所以夹具补一份默认清单；
// 追问校验本身的用例也走 runTool，在调用处覆盖对应清单来打三条阻塞。
const DEFAULT_GRILL = {
  decisions: [{ question: '这次要改到什么程度？', answer: '把追问纪律写进工具文案与提交校验' }],
  assumptions: [],
  open_questions: [],
}
const withGrill = (name, args) => (name === 'flowgate_doc' ? { ...DEFAULT_GRILL, ...args } : args)

function makeHost(cwd, sessionId, options = {}) {
  const tools = new Map()
  const routes = []
  const handlers = new Map()
  // 界面启动后插件会通过宿主 agents 服务给会话补一条消息；这里记下来给用例断言。
  const delivered = []
  // sess-late-agent 用它模拟「第一次拿不到、之后拿得到」：验证重复点开始会重试唤醒。
  const agentLookups = new Map()
  // options.shell 用来模拟慢采集：S2 采集变更摘要最长有 10 秒窗口，
  // 期间用户点门禁会把阶段推进掉，用例要能停在这个窗口里断言。
  const shell = options.shell ?? {
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
      if (Object.prototype.hasOwnProperty.call(options.services ?? {}, name)) return options.services[name]
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
    const prepared = withGrill(name, args)
    const value = definition.execute(prepared, {
      name,
      arguments: prepared,
      agent: { session: { header: { id: sessionId, cwd } } },
      signal: opts.signal,
    })
    // 本文件的用例全部验证「每一步都停下来等确认」的手动门禁语义。
    // 门禁模式默认随档位（fast 档是自动通过），夹具里显式切成每步确认；
    // 自动通过的行为在 test/gatemode.test.mjs 里单独覆盖。
    if (name !== 'flowgate_start') return value
    return Promise.resolve(value).then(async (result) => {
      const switched = await request('/api/flowgate/action', {
        sessionId, action: 'setGateMode', payload: { mode: 'manual' },
      })
      assert.equal(switched.status, 200, JSON.stringify(switched.body))
      return result
    })
  }
  const request = async (path, body) => {
    const pathname = path.split('?')[0]
    // 取最新注册的那份：多 host 用例会重复 apply，只有最新的 service 是当前生效的。
    const spec = routes.findLast((r) => r.path === pathname)
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

  // 插件只认最后一次 apply 的 service：用例里临时建 host 验完必须切回来，
  // 否则后面的流程会落到别人的工作目录里。
  const activate = () => apply({ inject: (_names, cb) => cb(scoped) })
  activate()
  return { tools, routes, handlers, shell, tool, request, guard, delivered, activate }
}

const cwd = mkdtempSync(join(tmpdir(), 'flowgate-'))
const testRoot = cwd
const sessionId = 'sess_test'
const host = makeHost(cwd, sessionId)

const execOf = (name, args) => ({
  name,
  arguments: args,
  agent: { session: { header: { id: sessionId, cwd } } },
  signal: undefined,
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

// 评审发现现在要带证据：evidence 必须是目标文件里真实出现的标识符，
// defect 还要给能对上的 line 与复现。下面这些用例关心的是门禁语义，
// 不是证据校验本身，所以统一准备一份真实文件并生成合法发现。
const REVIEW_SOURCE = 'export const session = (now, expiresAt) => (now > expiresAt ? 401 : 200)\n'
function seedReviewSource(root) {
  mkdirSync(join(root, 'src', 'auth'), { recursive: true })
  writeFileSync(join(root, 'src', 'auth', 'session.ts'), REVIEW_SOURCE)
}
function reviewFinding(overrides = {}) {
  return {
    file: 'src/auth/session.ts',
    line: 1,
    severity: 'MAJOR',
    ac: 'AC-1',
    summary: '时区错误',
    kind: 'defect',
    evidence: 'expiresAt',
    repro: { when: 'now 与 expiresAt 处于不同时区', expected: '返回 401', actual: '返回 200' },
    counter: { attempt: '我尝试证明 now 与 expiresAt 同源、不会跨时区', survived: true },
    ...overrides,
  }
}

async function runTool(name, args = {}) {
  const definition = host.tools.get(name)
  assert.ok(definition, '工具未注册：' + name)
  const prepared = withGrill(name, args)
  const value = await definition.execute(prepared, execOf(name, prepared))
  // 本文件的用例全部验证「每一步都停下来等用户确认」的手动门禁语义。
  // 门禁模式默认随档位（fast 档是自动通过），夹具里显式切成每步确认；
  // 自动通过的行为在 test/gatemode.test.mjs 里单独覆盖。
  if (name === 'flowgate_start') {
    const switched = await postAction('setGateMode', { mode: 'manual' })
    assert.equal(switched.status, 200, JSON.stringify(switched.body))
  }
  return value
}

function routeOf(path) {
  const spec = host.routes.findLast((r) => r.path === path)
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


// 用例体里需要 await 时必须走这个入口：交给同步 check 的话，它在断言跑完之前就记了通过，
// 失败也带不上用例名。
async function checkAsync(label, fn) {
  try {
    await fn()
    passed.push(label)
    console.log('  ok   ' + label)
  } catch (error) {
    console.log('  FAIL ' + label + ' -> ' + error.message)
    throw error
  }
}
const status0 = await runTool('flowgate_status', {})
check('无流程时 status 返回 active=false', () => assert.equal(status0.active, false))
// G38：没有流程时也要能确认「验的是哪一版」，否则 Agent 连自己跑的是不是刚发布的那一版都不知道。
check('G38 无流程时 status 也带齐七个版本字段', () => {
  // AC-8：版本号必须来自 package.json——写成常量会把「没读盘」也断言成通过，而且每升一次版本就得跟着改一次，忘了改就让整个 host 套件一直红（它曾写死 0.1.5，升到 0.1.6 之后这条断言再没通过过）。所以这里只跟 package.json 比，再校验形状，不钉具体版本号。
  assert.equal(status0.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  assert.match(status0.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.match(status0.moduleRevision, /^[a-f0-9]{64}$/)
  assert.equal(status0.diskModuleRevision, status0.moduleRevision)
  assert.equal(status0.runtimeStatus, 'verified')
  assert.equal(status0.clientRevision, '')
  assert.equal(status0.clientStatus, 'absent')
  assert.deepEqual(status0.staleModules, [])
  // AC-6：没有流程时 summary 也必须首行念版本——接手任务的那一刻往往还没启动流程。
  assert.equal(status0.summary.split('\n')[0].startsWith('运行版本：'), true)
  assert.match(status0.summary.split('\n')[0], /host [a-f0-9]{8}（与磁盘一致）/)
  assert.match(status0.summary, /当前会话还没有流程/)
})
// AC-1：schema 与返回值必须同时增字段——additionalProperties 为 false，漏写 required 时宿主侧会拒收。
check('G38 status 的 output.schema 把七个版本字段都列为 required', () => {
  const schema = host.tools.get('flowgate_status').output.schema
  const added = ['version', 'moduleRevision', 'diskModuleRevision', 'runtimeStatus', 'clientRevision', 'clientStatus', 'staleModules']
  assert.equal(schema.additionalProperties, false)
  for (const key of added) {
    assert.ok(schema.required.includes(key), 'required 缺 ' + key)
    assert.ok(schema.properties[key], 'properties 缺 ' + key)
  }
  assert.deepEqual(Object.keys(schema.properties).sort(), [...Object.keys(status0)].sort())
  // 键集合全等挡不住「properties 里误加内部字段」——那种情况下两边同样相等。
  // 这里独立证明内部字段既不进契约也不进返回值，pickRuntime 的剔除名单才真的有效。
  const internal = ['expectedClientRevision', 'clientReason', 'clientExpired', 'clientRejectedReason', 'clientReportedWithoutRevision', 'hostRevision', 'diskHostRevision', 'stale', 'hostStatus', 'pageId', 'viewport', 'layoutEvidence']
  for (const key of internal) {
    assert.equal(Object.prototype.hasOwnProperty.call(schema.properties, key), false, 'properties 不该含内部字段 ' + key)
    assert.equal(Object.prototype.hasOwnProperty.call(status0, key), false, 'status 返回值不该含内部字段 ' + key)
  }
})

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

// 追问内容会随快照全量落盘：空问题与超长问题都要在提交前挡住。
{
  const opts = [{ label: 'A', tradeoff: 'a' }, { label: 'B', tradeoff: 'b' }]
  const emptyQuestion = await runTool('flowgate_ask', { question: '   ', options: opts }).catch((error) => error)
  const longQuestion = await runTool('flowgate_ask', { question: '问'.repeat(501), options: opts }).catch((error) => error)
  const oneOption = await runTool('flowgate_ask', { question: '只有一个选项？', options: [{ label: 'A', tradeoff: 'a' }] }).catch((error) => error)
  const blankOptions = await runTool('flowgate_ask', { question: '选项都是空的？', options: [{ label: '  ', tradeoff: 'a' }, { label: '', tradeoff: 'b' }] }).catch((error) => error)
  check('追问的空内容与超长内容被拒', () => {
    assert.match(String(emptyQuestion?.message ?? emptyQuestion), /不能为空/)
    assert.match(String(longQuestion?.message ?? longQuestion), /500/)
    assert.match(String(oneOption?.message ?? oneOption), /至少给出 2 个选项/)
    // 空白选项被剔除后不足两个，同样要拒：界面上点不到有效选项。
    assert.match(String(blankOptions?.message ?? blankOptions), /至少给出 2 个选项/)
  })
}

// 只读白名单里漏登记的工具会被整体拒绝。skill 只把说明文本读进上下文，必须登记。
const allowSkill = await guard('skill', { name: 'office-docx' })
check('skill 这类只读工具在流程运行期间照常可用', () => assert.equal(allowSkill.kind, 'allow'))
// 未登记的工具默认拒绝：宿主新增写工具时是「被挡住」而不是「静默放行」。
const unknownTool = await guard('some_future_write_tool', { file_path: 'src/auth/session.ts' })
check('未登记进白名单的工具默认被拒绝', () => {
  assert.equal(unknownTool.kind, 'deny')
  assert.match(unknownTool.reason, /只读登记表/)
})

// G07 / P1-5：防绕过以真实父链为界，同目录不代表同一条需求。
{
  const ws = mkdtempSync(join(tmpdir(), 'flowgate-归属-'))
  const owner = '流程 owner'
  const headers = new Map()
  const child = (id, parentSession, cwd = ws, delegationDepth = 1) => ({ id, cwd, parentSession, delegationDepth, origin: 'subagent' })
  const services = { sessions: { get: (id) => headers.has(id) ? { header: headers.get(id) } : undefined }, agents: { get: () => undefined } }
  const run = (cx, header, name = 'write', args = { file_path: join(ws, 'x'), content: 'x' }) => cx.handlers.get('tools/pre-execute')(
    { name, arguments: args, agent: { session: { header } } }, async () => ({ kind: 'allow' }),
  )
  try {
    const cx = makeHost(ws, owner, { services })
    await cx.tool('flowgate_start', { title: '归属隔离' })
    const service = currentService()
    const flow = service.get(owner)
    headers.set(owner, { id: owner, cwd: ws, delegationDepth: 0 })
    headers.set('middle', child('middle', owner))
    headers.set('other', { id: 'other', cwd: ws, delegationDepth: 0 })
    headers.set('other-middle', child('other-middle', 'other'))
    const ordinary = [
      { id: 'top', cwd: ws, delegationDepth: 0 }, { id: 'legacy', cwd: ws },
      { id: 'nested', cwd: join(ws, 'nested'), delegationDepth: 0 },
      child('other-child', 'other'), child('other-grandchild', 'other-middle', ws, 2),
    ]
    const operations = [
      ['read', { file_path: join(ws, 'x') }], ['ops_bash', { command: 'git status' }],
      ['ops_bash', { command: 'npm test' }], ['ops_bash', { command: 'npm install left-pad' }],
      ['write', { file_path: join(ws, 'x'), content: 'x' }], ['some_future_write_tool', {}],
    ]
    for (const stage of ['S1', 'S2', 'S3', 'S4']) {
      flow.stage = stage
      flow.scope = { frozen: true, data: { commands: ['npm test'], files_expected_to_change: ['allowed.js'] } }
      const before = JSON.stringify(flow.pendingCommands)
      service.noteActivity(owner, { name: 'read', arguments: { path: 'owner-marker' } }, stage)
      const activity = service.activity.get(owner)
      for (const header of ordinary) {
        for (const [name, args] of operations) assert.equal((await run(cx, header, name, args)).kind, 'allow', `${stage}: ${header.id}: ${name}`)
        cx.handlers.get('agent/status')({ status: 'idle', agent: { session: { header } } })
      }
      check(`G07 ${stage} 无关顶层与子代理普通操作全部放行且不污染清单或进度`, () => {
        assert.equal(JSON.stringify(flow.pendingCommands), before)
        assert.equal(service.activity.get(owner), activity)
      })
      for (const header of [child('sess_sibling', owner), child('sess_nested', owner, join(ws, 'nested')), child('moved', owner, tmpdir()), child('grandchild', 'middle', ws, 2)]) {
        assert.equal((await run(cx, header)).kind, 'deny', `${stage}: ${header.id}`)
        assert.notEqual(service.activity.get(owner), activity)
        cx.handlers.get('agent/status')({ status: 'idle', agent: { session: { header } } })
        assert.equal(service.activity.has(owner), false)
      }
    }
    check('G07 同目录、子目录、跨目录和多级真实后代始终受流程约束', () => assert.ok(flow))
    flow.stage = 'S1'
    const invalid = [undefined, null, 0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
    for (const depth of invalid) assert.equal((await run(cx, { ...child('invalid', owner), delegationDepth: depth })).kind, 'allow')
    await checkAsync('G07 异常元数据、循环、断链、服务异常与已结束最近流程安全终止', async () => {
      for (const header of [
        child('', owner), child('self', 'self'), child('broken', 'missing'),
        { ...child('no-origin', owner), origin: undefined }, child('blank-parent', ''),
        child('null-parent', null), { id: 'top-parent', cwd: ws, parentSession: owner, delegationDepth: 0 },
      ]) assert.equal((await run(cx, header)).kind, 'allow', header.id)
      headers.set('cycle-a', child('cycle-a', 'cycle-b'))
      headers.set('cycle-b', child('cycle-b', 'cycle-a'))
      assert.equal((await run(cx, headers.get('cycle-a'))).kind, 'allow')
      for (const id of ['ASCII', '会话 🧪', 'x'.repeat(10000)]) {
        assert.equal((await run(cx, child(id, owner))).kind, 'deny')
        assert.equal((await run(cx, { id, cwd: ws, delegationDepth: 0 })).kind, 'allow')
      }
      services.sessions.get = () => { throw new Error('session store unavailable') }
      services.agents.get = (id) => id === 'middle' ? { session: { header: headers.get(id) } } : undefined
      assert.equal((await run(cx, child('agent-fallback', 'middle', ws, 2))).kind, 'deny')
      services.agents.get = () => { throw new Error('agent store unavailable') }
      assert.equal((await run(cx, child('unresolved', 'middle', ws, 2))).kind, 'allow')
      services.sessions.get = (id) => headers.has(id) ? { header: headers.get(id) } : undefined
      services.agents.get = () => undefined
      service.flows.set('finished-middle', { sessionId: 'finished-middle', finished: true })
      headers.set('finished-middle', child('finished-middle', owner))
      assert.equal((await run(cx, child('after-finish', 'finished-middle', ws, 2))).kind, 'allow')
    })

    // 全新服务第一次执行的就是守卫，不先调用任何工作台或 flowgate 查询。
    await checkAsync('G07 冷启动先恢复再核对身份：本人和完整后代受限，无关及缺失链放行', async () => {
      for (const header of [headers.get(owner), child('cold-direct', owner), child('cold-grandchild', 'middle', ws, 2), child('cold-moved', 'middle', tmpdir(), 2)]) {
        const cold = makeHost(ws, owner, { services })
        assert.equal((await run(cold, header)).kind, 'deny', header.id)
      }
      for (const header of [...ordinary, child('cold-missing', 'missing', ws, 2)]) {
        const cold = makeHost(ws, owner, { services })
        assert.equal((await run(cold, header)).kind, 'allow', header.id)
      }
    })

    flow.stage = 'S2'
    flow.scope.data = { in_scope: { commands: ['npm test'], files_expected_to_change: ['allowed.js', 'nested/allowed-nested.js'] } }
    const nested = child('relative-child', owner, join(ws, 'nested'))
    const outside = child('relative-outside', owner, tmpdir())
    await checkAsync('G07 后代相对目标按执行目录解析，嵌套调用和批量 root 不得绕出 scope', async () => {
      const writes = [
        ['write', { file_path: 'allowed.js', content: 'x' }, 'deny'],
        ['write', { file_path: '../allowed.js', content: 'x' }, 'allow'],
        ['edit', { file_path: 'allowed-nested.js', old_string: 'a', new_string: 'b' }, 'allow'],
        ['write', { file_path: join(ws, 'allowed.js'), content: 'x' }, 'allow'],
        ['write', { file_path: join(ws, 'nested', 'allowed.js'), content: 'x' }, 'deny'],
        ['ops_move', { path: '../allowed.js', to: 'allowed.js' }, 'deny'],
        ['ops_copy', { path: '../allowed.js', to: 'allowed-nested.js' }, 'allow'],
        ['ops_batch', { root: '.', action: 'run', operations: [{ op: 'remove', path: 'allowed.js' }] }, 'deny'],
        ['ops_batch', { root: '..', action: 'run', operations: [{ op: 'remove', path: 'allowed.js' }] }, 'allow'],
        ['decompress', { toFile: 'allowed.js' }, 'deny'],
        ['run_code', { code: 'return await tools.write({"file_path":"allowed.js","content":"x"})' }, 'deny'],
        ['run_code', { code: 'return await tools.write({"file_path":"../allowed.js","content":"x"})' }, 'allow'],
      ]
      for (const [name, args, expected] of writes) assert.equal((await run(cx, nested, name, args)).kind, expected, name + ': ' + JSON.stringify(args))
      assert.equal((await run(cx, outside, 'write', { file_path: 'allowed.js', content: 'x' })).kind, 'deny')
      assert.equal((await run(cx, outside, 'write', { file_path: join(ws, 'allowed.js'), content: 'x' })).kind, 'allow')
    })

    // 最近已结束的流程是父链边界；热态与第一次调用即守卫的冷态必须一致。
    await checkAsync('G07 已结束最近流程的持久化边界在冷热态一致，不套用更远祖先', async () => {
      const endedCwd = join(ws, 'ended workspace')
      mkdirSync(endedCwd)
      const endedHost = makeHost(endedCwd, 'finished-middle', { services })
      await endedHost.tool('flowgate_start', { title: '已经结束的最近流程' })
      await endedHost.tool('flowgate_cancel', { reason: '结束边界回归' })
      headers.set('finished-middle', child('finished-middle', owner, endedCwd))
      for (const header of [headers.get('finished-middle'), child('cold-after-finish', 'finished-middle', endedCwd, 2)]) {
        assert.equal((await run(cx, header)).kind, 'allow')
        const cold = makeHost(ws, owner, { services })
        assert.equal((await run(cold, header)).kind, 'allow', header.id)
        assert.equal(currentService().get('finished-middle'), null, '不改变 hydrate 对结束快照的处理')
        assert.equal((await run(cold, child('still-owned', owner))).kind, 'deny', '其他真实后代仍受活动流程约束')
      }
    })
  } finally {
    rmSync(ws, { recursive: true, force: true })
    host.activate()
  }
}

// git branch 有删除与创建模式：通用只读白名单允许尾部任意参数，
// `git branch -a --delete main` 就能借 -a 混过白名单再删分支。
{
  const branchList = await host.guard('ops_bash', { command: 'git branch -a' })
  const branchPattern = await host.guard('ops_bash', { command: "git branch --list 'feat*'" })
  const branchDelete = await host.guard('ops_bash', { command: 'git branch -a --delete main' })
  const branchCreate = await host.guard('ops_bash', { command: 'git branch feature-x' })
  check('git branch 只放行列分支，删除与创建照旧被拦', () => {
    assert.equal(branchList.kind, 'allow', JSON.stringify(branchList))
    assert.equal(branchPattern.kind, 'allow', JSON.stringify(branchPattern))
    assert.equal(branchDelete.kind, 'deny', JSON.stringify(branchDelete))
    assert.equal(branchCreate.kind, 'deny', JSON.stringify(branchCreate))
  })
}

// 命令授权开关已退场：任何阶段都没有 toggleShellGrant 这个操作，S1 更不能提前开。
const earlyShellGrant = await postAction('toggleShellGrant', { enabled: true })
check('命令授权开关已退场，S1 也开不了', () => {
  assert.equal(earlyShellGrant.status, 409)
  assert.match(earlyShellGrant.body.error, /未知操作/)
})

// 文档与 scope 都会原样进快照、每次全量写盘：体积不设上限，一次提交就能让流程卡死。
{
  const minimalScope = {
    commands: [], files_expected_to_change: ['src/auth/session.ts'],
    capabilities: ['体积校验'],
    out_of_scope_explicitly: [],
    acceptance_criteria: [{ id: 'AC-1', when: '体积超限', then: '提交被拒绝' }],
  }
  const emptyHtml = await runTool('flowgate_doc', { html: '   ', scope: minimalScope }).catch((error) => error)
  const bigHtml = await runTool('flowgate_doc', { html: '<p>' + 'x'.repeat(400001) + '</p>', scope: minimalScope }).catch((error) => error)
  const bigScope = await runTool('flowgate_doc', {
    html: '<html><body><p>体积</p></body></html>',
    scope: { ...minimalScope, capabilities: Array.from({ length: 4000 }, () => '能力条目'.repeat(4)) },
  }).catch((error) => error)
  check('需求文档与 scope 的体积上限在提交前拦住', () => {
    assert.match(String(emptyHtml?.message ?? emptyHtml), /不能为空/)
    assert.match(String(bigHtml?.message ?? bigHtml), /400000/)
    assert.match(String(bigScope?.message ?? bigScope), /40000/)
  })
}
// 追问纪律是提交门槛，不是提示词里的建议：没问到共识的三种形态都在 submit 之前被拦下。
{
  const grillScope = {
    commands: [], files_expected_to_change: ['src/auth/session.ts'],
    capabilities: ['追问门槛'], out_of_scope_explicitly: [],
    acceptance_criteria: [{ id: 'AC-1', when: '追问没问到共识', then: '提交被拒绝' }],
  }
  const askDoc = (overrides) =>
    runTool('flowgate_doc', {
      html: '<html><body><h1>需求文档</h1></body></html>',
      scope: grillScope,
      ...overrides,
    }).catch((error) => error)
  const stillOpen = await askDoc({ open_questions: ['两处数据冲突时以哪份为准'] })
  const halfDecision = await askDoc({ decisions: [{ question: '只问了问题没有结论' }] })
  const nothingClarified = await askDoc({ decisions: [], assumptions: [] })
  check('未问清的三种形态都在提交前被拒', () => {
    assert.match(String(stillOpen?.message ?? stillOpen), /还有 1 个未决问题没有问清/)
    assert.match(String(stillOpen?.message ?? stillOpen), /两处数据冲突时以哪份为准/)
    assert.match(String(halfDecision?.message ?? halfDecision), /缺 question 或 answer/)
    assert.match(String(nothingClarified?.message ?? nothingClarified), /没有澄清任何东西/)
  })
}
// AC-2：三份清单任意一份缺失都在提交前被拦，报错点名缺了哪份——schema 层拦不住直接调 execute 的宿主。
{
  const missingScope = {
    commands: [], files_expected_to_change: ['src/auth/session.ts'],
    capabilities: ['追问门槛'], out_of_scope_explicitly: [],
    acceptance_criteria: [{ id: 'AC-1', when: '清单缺失', then: '提交被拒绝' }],
  }
  // 夹具默认会补一份清单，这里显式给 undefined 覆盖掉，模拟调用方根本没传这个字段。
  const dropDoc = (key) => runTool('flowgate_doc', {
    html: '<html><body><h1>需求文档</h1></body></html>',
    scope: missingScope,
    decisions: [{ question: '问什么', answer: '定什么' }],
    assumptions: [],
    open_questions: [],
    [key]: undefined,
  }).catch((error) => error)
  const missing = {
    decisions: await dropDoc('decisions'),
    assumptions: await dropDoc('assumptions'),
    open_questions: await dropDoc('open_questions'),
  }
  check('三份追问清单缺一份就拒绝提交，并点名缺了哪个', () => {
    for (const [key, value] of Object.entries(missing)) {
      const message = String(value?.message ?? value)
      assert.match(message, /三份追问清单/, key)
      assert.match(message, new RegExp('缺少 ' + key), key)
      for (const name of ['decisions', 'assumptions', 'open_questions']) {
        assert.ok(message.includes(name), key + ' 的报错里必须出现 ' + name)
      }
    }
  })
}
// AC-5：追问纪律要出现在 Agent 真正读得到的地方，不能只写进一条提示词。
{
  const root = mkdtempSync(join(tmpdir(), 'flowgate-grill-'))
  const ws = join(root, 'workspace')
  mkdirSync(ws)
  const cx = makeHost(ws, 'sess-grill')
  // 工具启动与界面启动是两条路径：唤醒消息只有界面启动才会投递，工具返回的文案单独验。
  mkdirSync(join(root, 'tool'))
  const viaTool = makeHost(join(root, 'tool'), 'sess-grill-tool')
  try {
    const started = await viaTool.tool('flowgate_start', { preset: 'fast', brief: '把追问纪律写进 S1' })
    // 全新工作区没有规则覆盖，S1 走档位默认——fast 档也必须带上追问规则。
    await cx.request('/api/flowgate/action', {
      sessionId: 'sess-grill', action: 'start', payload: { preset: 'fast', brief: '把追问纪律写进 S1' },
    })
    await tick()
    const view = await cx.request('/api/flowgate/state?sessionId=sess-grill')
    const ask = cx.tools.get('flowgate_ask').description
    const wake = cx.delivered.map((item) => item.message.content.map((block) => block.text).join('\n')).join('\n')
    check('追问纪律在 S1 规则、唤醒消息、ask 描述与 start 返回消息四处都写明', () => {
      assert.ok(view.body.stageConfigs.S1.ids.includes('grill-until-agreed'), JSON.stringify(view.body.stageConfigs.S1.ids))
      assert.ok(view.body.stageConfigs.S1.items.some((item) => item.name === '追问到共识再动手'))
      assert.match(wake, /追问到共识再动手/)
      assert.match(wake, /一次只问一个关键决策/)
      assert.match(ask, /追问要问到共识/)
      assert.match(ask, /open_questions 非空时提交会被拒绝/)
      assert.match(started.message, /一次只解决一个分歧/)
      assert.match(started.message, /答完接着问下一个/)
      // 清单里的命令能不能跑，S1 就该验一次：这条要求写在 doc 工具描述里，Agent 才读得到。
      assert.match(cx.tools.get('flowgate_doc').description, /提交 scope 前先对清单里每个工具跑一次版本探测/)
      assert.match(cx.tools.get('flowgate_doc').description, /绝对路径的探测/)
      // 探测出问题要落到清单上，不是知道了就完：这条是「S1 就该验」的收口。
      assert.match(cx.tools.get('flowgate_doc').description, /跑不通就把绝对路径或替代方案写进清单/)
    })
    // 推荐标记只能有一个来源：标签只写文本，推荐由 recommended 表达，界面统一追加「（推荐）」。
    // 少了这条约束，Agent 会自己往 label 里写「（推荐）」，界面上就变成「（推荐）（推荐）」。
    check('flowgate_ask 的选项标签契约：推荐交给 recommended，标签只写文本', () => {
      const label = cx.tools.get('flowgate_ask').parameters.properties.options.items.properties.label
      assert.match(label.description, /不要自己加「（推荐）」/)
      assert.match(label.description, /recommended/)
      // 参数级描述不一定被模型读到：工具顶层 description 里也要有同一条约束，
      // 否则只靠 schema 兜底，Agent 照样会自己往标签里写「（推荐）」。
      const description = cx.tools.get('flowgate_ask').description
      assert.match(description, /不要自己加「（推荐）」/)
      assert.match(description, /recommended/)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
    // 把插件的当前 service 切回主 host：后面所有用例都还挂在它上面。
    host.activate()
  }
}
// 需求文档 → 批准并冻结 scope（AC-2 的对照：这里走正常批准路径）。
const scopeInput = {
  // P0-4：scope 由 Agent 自报。绝对路径与项目根之外的条目必须在提交时就被剔除，
  // 否则 normalizeTarget 会把绝对路径原样返回，等于给任意文件开通行证。
  commands: [], files_expected_to_change: ['src/auth/session.ts', '../outside/evil.ts', 'D:/absolute/evil.ts'],
  capabilities: ['会话过期检测', '过期后返回 401'],
  out_of_scope_explicitly: ['OAuth 第三方登录', '前端 UI 改动'],
  acceptance_criteria: [
    { id: 'AC-1', when: 'session 超过 30 分钟未活动', then: '下一次请求返回 401' },
    { id: 'AC-2', when: '并发刷新令牌', then: '只产生一次刷新请求' },
  ],
  // 影响面：评审发现的归属与「这次会动哪些共用契约」都靠它，冻结后原样落进 scope.json。
  shared_contracts: ['lib/auth/token.ts 的刷新入口参数保持 (sessionId, now) 不变'],
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
// 批准前用户必须看到「这次将允许改哪些文件」，并且越界条目已被剔除（P0-4）。
check('提交的 scope 里越界条目被剔除并回报给界面', () => {
  assert.deepEqual(docState.body.doc.pendingScope.files_expected_to_change, ['src/auth/session.ts'])
  assert.equal(docState.body.doc.droppedScopeEntries.length, 2)
  assert.ok(docState.body.doc.droppedScopeEntries.includes('../outside/evil.ts'))
  assert.ok(docState.body.doc.droppedScopeEntries.includes('D:/absolute/evil.ts'))
})
// 追问结果是文档的一部分，不是提交后即弃的对话记录：批准前就该能从落盘状态里查。
check('追问结果随文档一起落盘', () => {
  const dir = join(cwd, '.dsh-flowgate', 'flows')
  const name = fs.readdirSync(dir).find((item) => item.endsWith('.json'))
  assert.ok(name, '没有流程落盘文件')
  const saved = JSON.parse(readFileSync(join(dir, name), 'utf8'))
  assert.equal(saved.doc.grill.decisions.length, 1)
  assert.equal(saved.doc.grill.decisions[0].question, '这次要改到什么程度？')
  assert.deepEqual(saved.doc.grill.openQuestions, [])
  assert.deepEqual(saved.doc.grill.blockers, [])
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
check('变更性 shell 在 S2 被拒，并指向 scope 清单与待补决定', () => {
  assert.equal(denyShell.kind, 'deny')
  assert.match(denyShell.reason, /只允许只读 shell 命令/)
  // 唯一通道是 S1 批准过的 scope 清单，界面上没有别的授权开关。
  assert.match(denyShell.reason, /变更性命令只有一条通道/)
  // 补清单不再是「点一下就把这条加进去」：命令先进待补队列，由用户在门禁上二选一。
  assert.match(denyShell.reason, /已记进待补清单/)
  assert.match(denyShell.reason, /不要换别的写法再试一次/)
})
const deniedView = await getState()
check('被拒命令进待补队列，供门禁二选一', () => {
  const pending = deniedView.body.pendingCommands
  assert.ok(Array.isArray(pending), 'pendingCommands 应为数组')
  const entry = pending.find((one) => one.command === 'git checkout -- src/api/middleware.ts')
  assert.ok(entry, '被拒的命令应进待补队列')
  assert.equal(entry.stage, 'S2')
  // 单值字段已退场：一个「最近一条」装不下开发期间连拒的多条命令。
  assert.equal('deniedCommand' in deniedView.body, false)
  assert.equal('shellGrant' in deniedView.body, false)
})
const denyShellOps = await guard('ops_bash', { command: 'rm -rf src/api' })
check('ops_bash 这类别名 shell 同样被拦（不同 profile 装的 shell 插件不同）', () => {
  assert.equal(denyShellOps.kind, 'deny')
  assert.match(denyShellOps.reason, /只允许只读 shell 命令/)
})
const denyShell2 = await guard('bash', { command: 'echo hello' })
check('只读 shell 放行', () => assert.equal(denyShell2.kind, 'allow'))
const allowGitDiff = await guard('ops_bash', { command: 'git diff --stat' })
check('ops_bash 的只读命令放行', () => assert.equal(allowGitDiff.kind, 'allow'))

// scope 清单里没有 npm run build：S2 照样拒绝，且没有任何勾选能绕过它。
const unlistedBuild = await guard('bash', { command: 'npm run build' })
const unlistedView = await getState()
check('清单外的构建命令被拒，没有可勾选的授权通道', () => {
  assert.equal(unlistedBuild.kind, 'deny')
  assert.match(unlistedBuild.reason, /只允许只读 shell 命令/)
  assert.ok(unlistedView.body.pendingCommands.some((one) => one.command === 'npm run build'))
  assert.equal('shellGrant' in unlistedView.body, false)
})
// 解释器内联执行始终拒绝：那等价于任意代码执行，与清单无关。
const stillEscape = await guard('bash', { command: 'node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"' })
check('解释器内联执行始终被拒绝', () => {
  assert.equal(stillEscape.kind, 'deny')
  assert.match(stillEscape.reason, /任意代码/)
})

// 只读白名单本身也有边界：多行命令、能写文件的选项、会改 refs 的子命令。
const denyMultiline = await guard('bash', { command: 'pwd\nrm -rf src' })
check('多行 shell 不能借只读前缀夹带变更命令', () => {
  assert.equal(denyMultiline.kind, 'deny')
})
const denyOutput = await guard('bash', { command: 'git diff --output=evil.patch' })
check('git 的 --output 选项被拒绝（它能把内容写进任意文件）', () => {
  assert.equal(denyOutput.kind, 'deny')
  assert.match(denyOutput.reason, /写盘或执行任意代码/)
})
const denyBranch = await guard('bash', { command: 'git branch feature-x' })
check('git branch 建分支被拒绝（会写 .git/refs）', () => {
  assert.equal(denyBranch.kind, 'deny')
})
const allowBranchList = await guard('bash', { command: 'git branch --list' })
check('git branch --list 放行', () => assert.equal(allowBranchList.kind, 'allow'))

// run_code 是 PTC：程序里能直接 import node:fs 写盘，pre-execute 看不到。
const denyNodeIo = await guard('run_code', { code: "await import('node:fs')" })
check('run_code 里直接用 Node IO 被拒绝', () => {
  assert.equal(denyNodeIo.kind, 'deny')
  assert.match(denyNodeIo.reason, /绕过 scope 守卫/)
})
const denyMultiWrite = await guard('run_code', {
  code: "const r = await tools.ops_remove({ path: 'src/api/middleware.ts', expectedRevision: 'x' })\nreturn r",
})
check('run_code 多语句里夹带写工具被拒绝', () => {
  assert.equal(denyMultiWrite.kind, 'deny')
  assert.match(denyMultiWrite.reason, /无法静态取出参数/)
})
const denyBracket = await guard('run_code', { code: "return await tools['ops_remove']({ path: 'src/api/middleware.ts' })" })
check('run_code 用括号访问工具名同样被拒绝', () => {
  assert.equal(denyBracket.kind, 'deny')
})
const denySingleWrite = await guard('run_code', {
  code: 'return await tools.write({"file_path":"src/api/middleware.ts","content":"x"})',
})
check('run_code 单次调用写工具仍按 scope 判定', () => {
  assert.equal(denySingleWrite.kind, 'deny')
  assert.match(denySingleWrite.reason, /不在冻结 scope 内/)
})
const allowReadOnly = await guard('run_code', {
  code: 'const a = await tools.ops_grep({ pattern: "x", path: "src" })\nreturn a',
})
check('run_code 里组合只读工具照常放行', () => assert.equal(allowReadOnly.kind, 'allow'))

// batching-guidance 这类插件要求在程序第一行写 `// plan: …`。单调用前面带注释时
// 仍要能解析出参数：解析失败会退化成「提到工具名就拒绝」，Agent 按报错提示改成
// 单调用也永远过不去，提示与行为自相矛盾（实机踩到）。
{
  const annotatedRead = await guard('run_code', {
    code: '// plan: 读 package.json\nreturn await tools.ops_stat({"path":"package.json"})',
  })
  const annotatedWrite = await guard('run_code', {
    code: '// plan: 写文件\nreturn await tools.write({"file_path":"src/api/middleware.ts","content":"x"})',
  })
  check('单次调用带前置注释仍能解析参数并按 scope 判定', () => {
    assert.equal(annotatedRead.kind, 'allow', JSON.stringify(annotatedRead))
    assert.equal(annotatedWrite.kind, 'deny')
    // 解析成功才会走到 scope 判定；解析失败会报「多语句程序无法静态取出参数」。
    assert.match(annotatedWrite.reason, /S1|需求分析/)
    assert.doesNotMatch(annotatedWrite.reason, /多语句程序/)
  })
}

// 命令文本与文件路径都在字符串里：`rmdir` / `unlink` 这些词出现在 shell 命令或路径里
// 不代表程序在直接用 Node IO。扫原文会把一条正常的清理命令整条拒掉。
{
  const cleanUp = await guard('run_code', {
    code: 'const r = await tools.ops_bash({ command: "rmdir .tmp-x", description: "清理临时目录" })\nreturn r',
  })
  const readPath = await guard('run_code', {
    code: 'const r = await tools.ops_read_files({ files: [{ path: "docs/unlink-notes.md" }] })\nreturn r',
  })
  // 注释里写说明文字同样不该被当成 IO：`// 清理 rmdir 残留` 只是注释。
  const commentOnly = await guard('run_code', {
    code: '// 用 rmdir 清理临时目录，别再 unlink 单文件\nconst r = await tools.ops_bash({ command: "pwd", description: "看目录" })\nreturn r',
  })
  const blockComment = await guard('run_code', {
    code: '/* rmdir / unlink / writeFile 都只是注释 */\nconst r = await tools.ops_stat({ path: "package.json" })\nreturn r',
  })
  check('run_code 不把字符串与注释里的 rmdir / unlink 当成 Node IO', () => {
    assert.equal(cleanUp.kind, 'allow', JSON.stringify(cleanUp))
    assert.equal(readPath.kind, 'allow', JSON.stringify(readPath))
    assert.equal(commentOnly.kind, 'allow', JSON.stringify(commentOnly))
    assert.equal(blockComment.kind, 'allow', JSON.stringify(blockComment))
  })
  // 真正的 IO 痕迹在字面量之外，剥字符串不能把它一起放过。
  const realIo = await guard('run_code', {
    code: 'const fs = await import("node:fs")\nfs.writeFileSync("x", "y")\nreturn 1',
  })
  const hiddenIo = await guard('run_code', {
    code: 'const name = "node:" + "fs"\nconst m = await import(name)\nreturn m',
  })
  check('剥掉字符串后仍拦得住真正的 Node IO', () => {
    assert.equal(realIo.kind, 'deny')
    assert.equal(hiddenIo.kind, 'deny')
  })
}

// 放行按阶段判定：只有 S2 / S4 认 scope 清单，S1 与 S3 一律只接受只读命令（AC4）。
check('G07 执行目录参数保留空流程与结束流程的放行契约', () => {
  for (const flow of [null, undefined, { finished: true }]) {
    assert.equal(scopeDenial(flow, 'write', { file_path: 'ordinary.js' }), null)
  }
})

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
check('AC1 离开 S2 进入 S3 后视图不再有任何授权字段', () => {
  assert.equal(afterDev.body.stage, 'S3')
  assert.equal('shellGrant' in afterDev.body, false)
  assert.equal('writeGrants' in afterDev.body, false)
})
// AC4：阶段闸门在前——评审阶段不能跑变更性命令，哪怕清单里写了。
const s3ShellAfterAdvance = await guard('bash', { command: 'npm run build' })
check('AC4 S3 阶段仍拒绝变更性 shell', () => {
  assert.equal(s3ShellAfterAdvance.kind, 'deny')
  assert.match(s3ShellAfterAdvance.reason, /只允许只读 shell 命令/)
})
check('S2 记录变更摘要凭据', () => {
  assert.equal(afterDev.body.stages.find((s) => s.id === 'S2').status, 'passed')
  assert.ok(afterDev.body.devChanges.files.includes('src/auth/session.ts'))
  // 新文件在开发阶段很常见：porcelain 的 ?? 行必须进摘要，否则评审看不到新增文件。
  assert.ok(afterDev.body.devChanges.untracked.includes('src/auth/new-helper.ts'))
  assert.equal(afterDev.body.devChanges.added, 1)
  assert.equal(afterDev.body.devChanges.removed, 2)
})

// AC-6 / AC-7：评审阶段升档 + 评审发现问题 → 回退 S2。
seedReviewSource(cwd)
const reviewPending = runTool(
  'flowgate_review',
  {
    angles: [
      {
        id: 'correctness',
        name: '正确性',
        verdict: 'blocking',
        findings: [
          // 挂在已声明的验收标准上、且在 scope 文件内：这类发现才进重做清单。
          reviewFinding({ ac: 'AC-1', summary: '过期时间未考虑时区' }),
        ],
      },
    ],
  },
)
await tick()
const blockedReport = await getState()
const blockedPass = await postAction('gate', { decision: 'pass' })
const blockedSkip = await postAction('gate', { decision: 'skip' })
check('阻塞评审的普通通过和跳过均被拒绝', () => {
  assert.equal(blockedPass.status, 409)
  assert.equal(blockedSkip.status, 409)
  assert.equal(blockedReport.body.review.blocking, 1)
})
const acceptedRisk = await postAction('gate', { decision: 'accept-risk', reviewId: blockedReport.body.review.id, riskReason: '接受本轮时区缺陷风险' })
check('显式例外记录报告与接受原因', () => {
  assert.equal(acceptedRisk.status, 200)
  const stage = acceptedRisk.body.stages.find((s) => s.id === 'S3')
  assert.equal(stage.status, 'accepted_with_risk')
  assert.equal(stage.riskAcceptance.reviewId, blockedReport.body.review.id)
  assert.equal(stage.riskAcceptance.reason, '接受本轮时区缺陷风险')
})
const reviewResult = await reviewPending
// AC-6：评审通过后要求立即开始 S4，不停在阶段交界处。
check('显式带风险继续后进入 S4 且不声称评审通过', () => {
  assert.equal(reviewResult.decision, 'accept-risk')
  assert.doesNotMatch(reviewResult.message, /^评审通过/)
  assert.equal(reviewResult.next, 'S4')
  assert.match(reviewResult.message, /现在直接开始 S4 测试/)
  assert.match(reviewResult.message, /不要在阶段交界处停下/)
})
check('评审报告结构化聚合', () => {
  assert.equal(reviewResult.blocking, 1)
})
// AC2：阶段推进不改变放行口径——S4 认的还是同一份 scope 清单，没有可继承的授权。
const s4InheritedState = await getState()
const s4InheritedShell = await guard('bash', { command: 'npm run build' })
check('AC2 进 S4 不继承任何授权，清单外命令照样被拒', () => {
  assert.equal(s4InheritedState.body.stage, 'S4')
  assert.equal('shellGrant' in s4InheritedState.body, false)
  assert.equal(s4InheritedShell.kind, 'deny')
})

// AC3：回退不产生也不残留任何授权字段。
const ac3Dir = await postAction('addDirection', {
  name: '回退授权口径',
  points: ['回退后仍能跑构建与测试'],
})
check('AC3 前置：追加方向不产生写授权', () => {
  assert.equal(ac3Dir.status, 200)
  assert.equal('writeGrants' in ac3Dir.body, false)
})

// 回退验证：S4 门禁点「退回开发修复」。
const s4Gate = runTool('flowgate_gate', {})
await tick()
const backToDev = await postAction('gate', { decision: 'back', to: 'S2' })
check('门禁可回退到 S2', () => {
  assert.equal(backToDev.status, 200)
  assert.equal(backToDev.body.stage, 'S2')
})
check('AC3 回退后视图仍无授权字段', () => {
  assert.equal('shellGrant' in backToDev.body, false)
  assert.equal('writeGrants' in backToDev.body, false)
})
await s4Gate

// AC7：界面文案与新语义一致，不能再声称「阶段推进就失效」。
{
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  check('AC7 客户端不再提供任何命令授权开关', () => {
    assert.doesNotMatch(clientSource, /允许执行构建\/测试命令/)
    assert.doesNotMatch(clientSource, /授权只在当前阶段有效/)
    assert.doesNotMatch(clientSource, /阶段推进后需重新授权/)
    assert.match(clientSource, /scope 清单/)
  })
}

const devPending2 = gateRound('flowgate_gate', {}, { decision: 'pass' })
await devPending2
const reviewPending2 = runTool('flowgate_review', {
  angles: [
    {
      id: 'correctness',
      name: '正确性',
      verdict: 'blocking',
      findings: [reviewFinding({ severity: 'CRITICAL', ac: 'AC-2', summary: '缺少并发保护' })],
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
        findings: [reviewFinding({ severity: 'MINOR', ac: 'AC-1', summary: '建议日志脱敏' })],
      },
    ],
  },
  { decision: 'pass' },
)
const zeroReviewResult = await reviewPending3
const zeroReportState = await getState()
check('零阻塞评审仍按普通通过落状态并写入评审通过事件', () => {
  assert.equal(zeroReviewResult.decision, 'pass')
  assert.equal(zeroReviewResult.next, 'S4')
  assert.match(zeroReviewResult.message, /^评审通过/)
  assert.equal(zeroReportState.body.review.blocking, 0)
  assert.equal(zeroReportState.body.stages.find((stage) => stage.id === 'S3').status, 'passed')
  const events = readFileSync(join(cwd, '.dsh-flowgate', 'flows.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(events.some((event) => event.type === 'gate.passed' && event.detail.stage === 'S3'))
})

// S4 要跑测试命令，入口仍然只有 scope 清单：清单里没有的命令照样拒绝。
const s4Shell = await guard('bash', { command: 'npm test' })
const s4Escape = await guard('bash', { command: 'node -e "process.exit(0)"' })
check('S4 清单外的测试命令被拒，只给待补队列', () => {
  assert.equal(s4Shell.kind, 'deny')
  assert.match(s4Shell.reason, /已记进待补清单/)
})
check('S4 解释器内联执行仍被拒绝', () => {
  assert.equal(s4Escape.kind, 'deny')
  assert.match(s4Escape.reason, /任意代码/)
})

// 写权限声明与授权已整体退场：测试方向只决定验证什么，不决定能执行什么。
const addDir = await postAction('addDirection', {
  name: '迁移回滚',
  points: ['迁移后回滚可恢复'],
  needsWrite: true,
})
check('追加测试方向不再带写权限声明', () => {
  assert.equal(addDir.status, 200)
  const dir = addDir.body.directions.find((d) => d.name === '迁移回滚')
  assert.equal('needsWrite' in dir, false, '方向对象不该再有 needsWrite')
  assert.equal('writeGranted' in dir, false, '方向对象不该再有 writeGranted')
})
const legacyGrant = await postAction('toggleWriteGrant', { id: 'smoke', enabled: true })
check('写权限授权操作已退场', () => {
  assert.equal(legacyGrant.status, 409)
  assert.match(legacyGrant.body.error, /未知操作/)
})
const legacyDeclare = await postAction('declareDirectionWrite', { id: 'smoke', enabled: true })
check('写权限声明操作已退场', () => {
  assert.equal(legacyDeclare.status, 409)
  assert.match(legacyDeclare.body.error, /未知操作/)
})
const dirView = await getState()
check('视图不再暴露任何写权限字段', () => {
  assert.equal('writeGrants' in dirView.body, false)
  assert.equal('directionWriteDeclared' in dirView.body, false)
  for (const dir of dirView.body.directions) {
    assert.equal('needsWrite' in dir, false)
    assert.equal('writeGranted' in dir, false)
  }
})

// 只读豁免：插件不认识的只读工具（实机是刷新入口）默认被拒，用户声明后放行。
const allowBefore = await guard('unlag_refresh', {})
check('未登记的工具默认被拒并指向豁免入口', () => {
  assert.equal(allowBefore.kind, 'deny')
  assert.match(allowBefore.reason, /只读豁免/)
})
const allowSet = await postAction('setToolAllowlist', { tools: ['unlag_refresh', 'unlag_refresh', '  '] })
check('只读豁免名单去重去空并写进视图', () => {
  assert.equal(allowSet.status, 200)
  assert.deepEqual(allowSet.body.toolAllowlist, ['unlag_refresh'])
})
const allowAfter = await guard('unlag_refresh', {})
check('声明后的工具被放行', () => assert.equal(allowAfter.kind, 'allow'))
for (const tools of [['write'], ['ops_bash'], ['run_code'], ['bad name']]) {
  const denied = await postAction('setToolAllowlist', { tools })
  check('豁免名单不能声明 ' + tools[0], () => assert.equal(denied.status, 409))
}
const allowCleared = await postAction('setToolAllowlist', { tools: [] })
check('清空豁免名单后恢复默认拒绝', () => {
  assert.deepEqual(allowCleared.body.toolAllowlist, [])
})

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
  // 本夹具只验证授权回收；S4 已改方向规则，显式跳过而不伪造当前验收证据。
  // 跳过不再免检：缺口必须由用户显式接受，所以这里带上 acceptUncovered。
  { decision: 'skip', acceptUncovered: true },
)
const testResult = await testPending
check('S4 显式跳过后流程结束', () => assert.equal(testResult.next, 'done'))

// AC-8：flows.jsonl 完整、跳过计数正确。
const finalState = await getState()
check('AC-8 流程结束且显式跳过 S4 的计数为 1', () => {
  assert.equal(finalState.body.finished, true)
  assert.equal(finalState.body.skippedCount, 1)
})
check('AC6 流程结束后视图不再有授权字段', () => {
  assert.equal('shellGrant' in finalState.body, false)
  assert.equal('writeGrants' in finalState.body, false)
  // 待补命令与已拒命令都不该跟到流程结束后。
  assert.deepEqual(finalState.body.pendingCommands, [])
  assert.deepEqual(finalState.body.declinedCommands, [])
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
  scope: { ...scopeInput, commands: [], files_expected_to_change: ['src/auth/session.ts'] },
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
// G38：summary 首行必须是运行版本，Agent 第一眼就能看到验的是哪一版。
check('G38 有流程时 status 首行是运行版本', () => {
  assert.equal(statusS2.summary.split('\n')[0].startsWith('运行版本：'), true)
  assert.match(statusS2.summary.split('\n')[0], /host [a-f0-9]{8}（与磁盘一致）/)
  assert.match(statusS2.version, /^\d+\.\d+\.\d+$/)
  assert.match(statusS2.moduleRevision, /^[a-f0-9]{64}$/)
  assert.equal(statusS2.diskModuleRevision, statusS2.moduleRevision)
  assert.equal(statusS2.runtimeStatus, 'verified')
  assert.ok(['verified', 'mismatch', 'absent', 'unverified'].includes(statusS2.clientStatus))
  assert.ok(Array.isArray(statusS2.staleModules))
  // 键集合必须与 schema 全等：只在有流程分支多给字段时，additionalProperties:false 会在宿主侧拒收。
  const schemaBoth = host.tools.get('flowgate_status').output.schema
  assert.deepEqual(Object.keys(statusS2).sort(), Object.keys(schemaBoth.properties).sort())
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
  const cwd = join(testRoot, d4Session)
  const ctx4 = makeHost(cwd, d4Session)
  const state4 = await ctx4.request('/api/flowgate/state?sessionId=' + d4Session)
  assert.equal(state4.body.active, false)

  await ctx4.tool('flowgate_start', { title: 'D4 回退深度', preset: 'fast' })
  const doc4 = ctx4.tool('flowgate_doc', {
    html: '<html><body><p>D4</p></body></html>',
    recommendedPreset: 'fast',
    reason: '只验回退深度',
    scope: {
      commands: [], files_expected_to_change: ['src/auth/session.ts'],
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
  // 这条发现要能进快照，证据就得对得上真实文件，所以先把它说的文件写出来。
  mkdirSync(join(cwd, 'src', 'config'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'config', 'secrets.ts'), 'export const secret = process.env.API_KEY\nexport const rotated = () => secret\nexport const ttl = 60\n')
  const review4 = ctx4.tool('flowgate_review', {
    angles: [{
      id: 'security',
      name: '安全',
      verdict: 'blocking',
      // 挂上了验收标准，但文件不在 scope 内：仍然不算阻塞项，且说明 scope 没划够。
      findings: [reviewFinding({ file: 'src/config/secrets.ts', line: 1, severity: 'CRITICAL', ac: 'AC-1', summary: '密钥硬编码', evidence: 'API_KEY' })],
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
  const uiCtx = makeHost(join(cwd, 'ui'), 'sess-ui')
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
  const unchanged = await uiCtx.request('/api/flowgate/state?sessionId=sess-ui')
  check('界面重复启动明确拒绝，原流程和档位保留', () => {
    assert.equal(again.status, 409)
    assert.match(again.body.error, /已有流程在进行/)
    assert.equal(unchanged.body.id, started.body.id)
    assert.equal(unchanged.body.preset, 'fast')
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
  const briefCtx = makeHost(join(cwd, 'brief'), 'sess-brief')
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
  const noAgent = await makeHost(join(cwd, 'no-agent'), 'sess-no-agent').request('/api/flowgate/action', {
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
  // 已有流程即使唤醒失败，也需明确拒绝重复启动。
  const lateCtx = makeHost(join(cwd, 'late-agent'), 'sess-late-agent')
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
  check('唤醒失败后仍拒绝重复启动，不重复投递消息', () => {
    assert.equal(lateFirst.body.nudge.ok, false)
    assert.equal(lateSecond.status, 409)
    assert.match(lateSecond.body.error, /先结束或放弃/)
    assert.equal(lateCtx.delivered.length, 0)
  })
  const briefStatus = await briefCtx.tool('flowgate_status', {})
  check('流程摘要里带上需求原文，Agent 不必再问用户要一遍', () => {
    assert.match(briefStatus.summary, /需求描述：# 会话过期返回 401/)
  })
  const longTitle = await makeHost(join(cwd, 'brief-long'), 'sess-brief-long').request('/api/flowgate/action', {
    sessionId: 'sess-brief-long',
    action: 'start',
    payload: { brief: '一'.repeat(60) },
  })
  check('过长的需求第一行按 24 字截断成标题', () => {
    assert.equal(longTitle.body.title, '一'.repeat(24))
  })
  const rewritten = await makeHost(join(cwd, 'brief-rewritten'), 'sess-brief-rewritten').request('/api/flowgate/action', {
    sessionId: 'sess-brief-rewritten',
    action: 'start',
    payload: { title: '模型改写的标题', brief: '  原文不许动：路径 src/a.js 与 123\n第二行  ' },
  })
  check('标题被改写时需求原文逐字保留，快照里没有第二份需求文本', () => {
    assert.equal(rewritten.body.title, '模型改写的标题')
    assert.equal(rewritten.body.brief, '  原文不许动：路径 src/a.js 与 123\n第二行  ')
    assert.equal('summary' in rewritten.body, false)
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
  const toolCtx = makeHost(join(cwd, 'ui-tool'), 'sess-ui-tool')
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
  // 受限沙箱会禁止管道 stdio 的 spawn（EPERM），捕获一律走文件描述符，探到的才是真结论。
  // 真找不到 git 时构造不出真实仓库，跳过这段而不是中断整套测试。
  const probe = captureSync('git', ['--version'], { windowsHide: true, timeout: 5000 })
  let skipReason
  if (probe.error) {
    if (!['ENOENT', 'EACCES', 'EPERM'].includes(probe.error.code)) throw probe.error
    skipReason = '宿主无 shell 时的 Git 子进程用例未执行：Git 不可用（' + probe.error.code + '）'
  } else if (probe.status !== 0) {
    skipReason = '宿主无 shell 时的 Git 子进程用例未执行：git --version 退出码 ' + probe.status
  }
  if (skipReason) {
    console.log('FLOWGATE_TEST_SKIP ' + JSON.stringify({ reason: skipReason }))
  } else {
  const repo = mkdtempSync(join(tmpdir(), 'flowgate-repo-'))
  const git = (args) => {
    const result = captureSync('git', args, { cwd: repo, windowsHide: true })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('git ' + args.join(' ') + ' 失败：' + result.stderr)
    return result.stdout
  }
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
      commands: [], files_expected_to_change: ['a.txt'],
      capabilities: ['改 a.txt'],
      out_of_scope_explicitly: [],
      acceptance_criteria: [{ id: 'AC-1', when: '改完', then: '能采到变更' }],
    },
  })
  await tick()
  await noShellCtx.request('/api/flowgate/action', { sessionId: 'sess-noshell', action: 'doc', payload: { decision: 'approve' } })
  await docNoShell

  const gateNoShell = noShellCtx.tool('flowgate_gate', { summary: '改完了 a.txt' })
  // 等真实 Git 采集完成、门禁注册后再模拟点击。
  const deadline = performance.now() + 15_000
  for (;;) {
    const state = await noShellCtx.request('/api/flowgate/state?sessionId=sess-noshell')
    assert.equal(state.status, 200, JSON.stringify(state.body))
    if (state.body.waitingKind === 'gate') break
    assert.ok(performance.now() < deadline, '15 秒内未观察到开发门禁就绪')
    await tick()
  }
  const gateReply = await noShellCtx.request('/api/flowgate/action', { sessionId: 'sess-noshell', action: 'gate', payload: { decision: 'pass' } })
  assert.equal(gateReply.status, 200, JSON.stringify(gateReply.body))
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
// 采集解析：git 的报错文本不能变成「改动文件」。非仓库目录下 stderr 会被
// 某些 shell 实现混进 stdout，逐行解析时 "fatal: not a git repository" 的
// 前两个字符 'fa' 看起来正好像一个 porcelain 状态码。
// ---------------------------------------------------------------------------
{
  check('采集解析：非仓库的报错文本不会被当成改动文件', () => {
    const parsed = parseChanges('fatal: not a git repository (or any of the parent directories): .git\n', 'now')
    assert.deepEqual(parsed.files, [])
    assert.deepEqual(parsed.tracked, [])
    assert.deepEqual(parsed.untracked, [])
    assert.match(String(parsed.error), /变更摘要可能不完整/)
  })

  check('采集解析：正常输出照旧解析并统计行数', () => {
    const parsed = parseChanges(' M src/a.ts\n?? src/b.ts\n---numstat---\n3\t1\tsrc/a.ts\n', 'now')
    assert.deepEqual(parsed.tracked, ['src/a.ts'])
    assert.deepEqual(parsed.untracked, ['src/b.ts'])
    assert.deepEqual(parsed.files, ['src/a.ts', 'src/b.ts'])
    assert.equal(parsed.added, 3)
    assert.equal(parsed.removed, 1)
    assert.equal(parsed.error, undefined)
  })
}
// ---------------------------------------------------------------------------
// 取消：用户放弃流程时必须把流程判死、解冻 scope，并唤醒挂起的门禁工具。
// 否则 Agent 的工具会一直等到超时，用户看到的是「点了没反应」。
// ---------------------------------------------------------------------------

{
  const cwd = join(testRoot, 'sess-cancel')
  const cx = makeHost(cwd, 'sess-cancel')
  await cx.tool('flowgate_start', { title: '取消演示', preset: 'fast' })

  // 需求文档门禁挂起时放弃：工具要立刻返回 cancelled，而不是等到超时。
  const pendingDoc = cx.tool('flowgate_doc', {
    html: '<html><body><p>取消</p></body></html>',
    scope: {
      commands: [], files_expected_to_change: ['src/a.ts'],
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
    // 本用例的文档还挂在门禁上、scope 从未冻结，所以 data 本来就是 null：
    // 这行不证明「放弃保留 scope」，那份证据在下面 AC6 的已冻结用例里。
    assert.equal(v.scope.data, null)
    assert.equal(v.acceptance.counts.total, 0)
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
        commands: [], files_expected_to_change: ['src/a.ts'],
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
  const cwd = join(testRoot, 'sess-cancel-gate')
  const gx = makeHost(cwd, 'sess-cancel-gate')
  await gx.tool('flowgate_start', { title: '取消开发门禁', preset: 'fast' })
  const docGate = gx.tool('flowgate_doc', {
    html: '<html><body><p>取消</p></body></html>',
    scope: {
      commands: [], files_expected_to_change: ['src/a.ts'],
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

  // AC6：放弃流程时授权必须一起清掉，别把「看似仍有效」的开关留在已结束的流程里。
  // 放在本块最后：另起宿主会换掉内存里的 service 实例，前面的 cx 断言必须先跑完。
  {
    const grantCwd = mkdtempSync(join(tmpdir(), 'flowgate-grant-'))
    const gx = makeHost(grantCwd, 'sess-cancel-grant')
    await gx.tool('flowgate_start', { title: '放弃前授权', preset: 'fast' })
    const gxDoc = gx.tool('flowgate_doc', {
      html: '<html><body><p>授权</p></body></html>',
      scope: {
        commands: [], files_expected_to_change: ['src/g.ts'],
        capabilities: ['改 g.ts'],
        out_of_scope_explicitly: [],
        acceptance_criteria: [{ id: 'AC-1', when: '授权后放弃', then: '开关清空' }],
      },
    })
    await tick()
    const gxApprove = await gx.request('/api/flowgate/action', { sessionId: 'sess-cancel-grant', action: 'doc', payload: { decision: 'approve' } })
    await gxDoc
    const gxCancel = await gx.request('/api/flowgate/action', { sessionId: 'sess-cancel-grant', action: 'cancel', payload: {} })
    check('AC6 放弃流程后视图不再有授权字段', () => {
      assert.equal(gxApprove.status, 200)
      assert.equal(gxCancel.status, 200)
      assert.equal('shellGrant' in gxCancel.body, false)
      assert.equal('writeGrants' in gxCancel.body, false)
    })
    // 这里的 scope 已经冻结过：放弃可以解冻白名单，但不能把验收账本抹成 0 条，
    // 否则一条缺口流程在放弃后会显示成「0 条 · 全部通过」。
    check('取消已冻结的流程后验收标准仍在账本里，不归零', () => {
      assert.equal(gxCancel.body.scope.frozen, false)
      assert.deepEqual(gxCancel.body.scope.data.acceptance_criteria.map((item) => item.id), ['AC-1'])
      assert.equal(gxCancel.body.acceptance.counts.total, 1)
      assert.equal(gxCancel.body.acceptance.counts.pending, 1)
    })
  }
}

rmSync(cwd, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// 实时进度：提交需求后工作台要能显示「正在做什么」与推进到哪，
// 否则用户只能对着一个静止页面等 Agent。
// ---------------------------------------------------------------------------

{
  const cwd = join(testRoot, 'sess-live')
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
      commands: [], files_expected_to_change: ['src/auth/session.ts'],
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
  const cwd = join(testRoot, 'sess-resume')
  const cx = makeHost(cwd, 'sess-resume')
  await cx.tool('flowgate_start', { title: '中断恢复', preset: 'fast' })
  const controller = new AbortController()
  const pending = cx.tool('flowgate_doc', {
    html: '<html><body><h1>中断</h1></body></html>',
    scope: {
      commands: [], files_expected_to_change: ['src/auth/session.ts'],
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
  const cwd = join(testRoot, 'sess-reboot')
  const first = makeHost(cwd, 'sess-reboot')
  await first.tool('flowgate_start', { title: '重启恢复', preset: 'fast' })
  const scope = {
    commands: [], files_expected_to_change: ['src/auth/session.ts'],
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
  const cwd = join(testRoot, 'sess-race')
  const cx = makeHost(cwd, 'sess-race')
  await cx.tool('flowgate_start', { title: '等待竞争', preset: 'fast' })
  const scope = {
    commands: [], files_expected_to_change: ['src/auth/session.ts'],
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
  const cwd = join(testRoot, 'sess-gate')
  const cx = makeHost(cwd, 'sess-gate')
  await cx.tool('flowgate_start', { title: '门禁中断', preset: 'fast' })
  const scope = {
    commands: [], files_expected_to_change: ['src/auth/session.ts'],
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
  check('门禁调用中断后返回 wait，并且明确要求 Agent 停下来等确认', () => {
    assert.equal(waited.decision, 'wait')
    // 按钮仍然可点是为了不剥夺用户确认的权利；Agent 不能因此自己往下做。
    assert.match(waited.message, /停下来等确认/)
    assert.match(waited.message, /不要继续做后续阶段的工作/)
    assert.doesNotMatch(waited.message, /门禁还在等待用户操作/)
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
    assert.ok(texts.some((text) => /先调用 flowgate_status 读取当前有效规则、ID 与要点/.test(text)), '主会话开始下一阶段前必须先读取完整检查清单')
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

// 用户点击与 Agent 采集撞在一起：S2 采集变更摘要最长有 10 秒窗口，
// 期间用户点「完成开发」会把阶段推进到 S3。采集返回后若照写开发摘要再挂门禁，
// Agent 会以一个按钮永远不会再出现的阶段身份等下去——卡到工具超时。
{
  const cwd = join(testRoot, 'sess-stale-gate')
  const fastResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 0,
    stdout: { text: ' M src/auth/session.ts\n---numstat---\n1\t2\tsrc/auth/session.ts\n', truncated: false },
    stderr: { text: '', truncated: false },
  }
  // 第一次采集立刻返回（上一轮开发摘要已经落地），第二次挂起，用来停住「采集窗口」。
  let calls = 0
  let release = null
  const twoStepShell = {
    resolve(request) {
      return { ...request, resolved: true }
    },
    run() {
      calls += 1
      if (calls === 1) return Promise.resolve(fastResult)
      return new Promise((resolve) => { release = () => resolve(fastResult) })
    },
  }
  const cx = makeHost(cwd, 'sess-stale-gate', { shell: twoStepShell })
  await cx.tool('flowgate_start', { title: '撞车', preset: 'fast' })
  const scope = {
    commands: [], files_expected_to_change: ['src/auth/session.ts'],
    capabilities: ['会话过期检测'],
    out_of_scope_explicitly: [],
    acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
  }
  const docCall = cx.tool('flowgate_doc', { html: '<html><body><p>撞车</p></body></html>', scope })
  await tick()
  await cx.request('/api/flowgate/action', { sessionId: 'sess-stale-gate', action: 'doc', payload: { decision: 'approve' } })
  await docCall
  // 上一轮门禁被中断：开发摘要已经写进流程，按钮因此可点。
  const firstSignal = new AbortController()
  const firstGate = cx.tool('flowgate_gate', {}, { signal: firstSignal.signal })
  await tick()
  firstSignal.abort()
  await firstGate

  const gateCall = cx.tool('flowgate_gate', { summary: '改完了' })
  await tick()
  // 采集还卡着，用户先点了「完成开发」。
  const passed = await cx.request('/api/flowgate/action', {
    sessionId: 'sess-stale-gate',
    action: 'gate',
    payload: { decision: 'pass' },
  })
  check('采集窗口里点门禁：阶段照常推进到 S3', () => {
    assert.equal(passed.status, 200)
    assert.equal(passed.body.stage, 'S3')
  })
  release()
  const stale = await gateCall
  check('采集回来发现阶段已经变了：返回 stale，不再挂到一个没有按钮的阶段上', () => {
    assert.equal(stale.decision, 'stale')
    assert.equal(stale.stage, 'S2')
    assert.equal(stale.next, 'S3')
    assert.match(stale.message, /阶段已推进到 S3/)
    assert.match(stale.message, /读取 flowgate_status/)
  })
  const after = await cx.request('/api/flowgate/state?sessionId=sess-stale-gate')
  check('撞车后停在 S3，开发摘要仍是上一轮那份', () => {
    assert.equal(after.body.stage, 'S3')
    assert.ok(after.body.devChanges, '第一轮的开发摘要不该被清掉')
    assert.equal(after.body.devChanges.files.length, 1)
  })
  const events = readFileSync(join(cwd, '.dsh-flowgate', 'flows.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  // 同一处的另一种表现：撞车之后已经站在 S3，但评审报告还没交。
  // S3 的门禁按钮要等评审报告才出现，此时挂起就是在等一个不会来的按钮。
  const noArtifact = await cx.tool('flowgate_gate', {})
  check('本阶段还没有产物就调用门禁：当场返回 stale，不挂起', () => {
    assert.equal(noArtifact.decision, 'stale')
    assert.equal(noArtifact.stage, 'S3')
    assert.equal(noArtifact.next, 'S3')
    assert.match(noArtifact.message, /评审报告（flowgate_review）/)
    assert.match(noArtifact.message, /门禁按钮不会出现/)
  })

  check('撞车不写第二条 dev.summary：审计里不能出现没生效的开发摘要', () => {
    assert.equal(events.filter((item) => item.type === 'dev.summary').length, 1)
  })
}

// AC-5 / AC-7：跳过门禁同样要给出下一阶段动作，且返回字段集合不变（schema 不动）。
{
  const cwd = join(testRoot, 'sess-skip')
  const cx = makeHost(cwd, 'sess-skip')
  await cx.tool('flowgate_start', { title: '跳过门禁文案', preset: 'fast' })
  const scope = {
    commands: [], files_expected_to_change: ['src/auth/session.ts'],
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
  check('AC-7 文档批准返回字段只新增 scopeRisks，其余不变', () => {
    // scopeRisks 是刻意扩展的契约：Agent 要能看到「用户带着哪些缺口批准了 scope」。
    assert.deepEqual(Object.keys(docSkipped).sort(), ['decision', 'frozen', 'message', 'preset', 'scopeRisks'])
    // 没有缺口时是空数组，调用方不需要额外分支。
    assert.deepEqual(docSkipped.scopeRisks, [])
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
  const cwd = join(testRoot, 'sess-revise')
  const cx = makeHost(cwd, 'sess-revise')
  await cx.tool('flowgate_start', { title: '修改需求', preset: 'fast' })
  const scope = {
    commands: [], files_expected_to_change: ['src/auth/session.ts'],
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
    payload: { decision: 'revise', revisionNote: '把 AC-2 的测量方式写清楚，并补上失败分支' },
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
  check('修改意见原文原样进入唤醒消息', () => {
    const last = cx.delivered[cx.delivered.length - 1]
    const text = last.message.content.map((block) => block.text).join('\n')
    assert.match(text, /把 AC-2 的测量方式写清楚，并补上失败分支/)
  })
  const revisedState = await cx.request('/api/flowgate/state?sessionId=sess-revise')
  check('修改意见原文落盘到快照与事件日志', () => {
    assert.equal(revisedState.body.doc.revisionNote, '把 AC-2 的测量方式写清楚，并补上失败分支')
    const events = readFileSync(join(cwd, '.dsh-flowgate', 'flows.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const revisedEvent = events.filter((event) => event.type === 'doc.revised').at(-1)
    assert.equal(revisedEvent.detail.note, '把 AC-2 的测量方式写清楚，并补上失败分支')
  })
}

// 文档工具还挂在等待器上时点「修改需求」：这句意见必须原样回到工具返回值里。
// 只有补发唤醒消息这条支路带备注是不够的 —— 用户大多数时候并不会中断工具再点按钮。
{
  const sid = 'sess-revise-live'
  const cwd = join(testRoot, sid)
  const cx = makeHost(cwd, sid)
  await cx.tool('flowgate_start', { title: '意见直达', preset: 'fast' })
  const scope = {
    commands: [],
    files_expected_to_change: ['src/auth/session.ts'],
    capabilities: ['会话过期检测'],
    out_of_scope_explicitly: [],
    acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
  }
  const liveCall = cx.tool('flowgate_doc', { html: '<html><body><p>待改</p></body></html>', scope })
  await tick()
  const liveNote = '  把 AC-1 的失败分支补上，并写明退出码  '
  await cx.request('/api/flowgate/action', { sessionId: sid, action: 'doc', payload: { decision: 'revise', revisionNote: liveNote } })
  const liveResult = await liveCall
  check('AC-11 文档工具在途时点修改需求，意见原文直接回到工具返回值', () => {
    assert.equal(liveResult.decision, 'revise')
    assert.match(liveResult.message, /把 AC-1 的失败分支补上，并写明退出码/)
    assert.match(liveResult.message, /进入 S1/)
    assert.doesNotMatch(liveResult.message, /补齐未决项/)
  })
  await cx.tool('flowgate_cancel', {})
}

// 空着意见点提交：工具值不能假装有意见，必须明确告诉 Agent 先问清要改什么。
{
  const sid = 'sess-revise-empty'
  const cwd = join(testRoot, sid)
  const cx = makeHost(cwd, sid)
  await cx.tool('flowgate_start', { title: '空白意见', preset: 'fast' })
  const scope = {
    commands: [],
    files_expected_to_change: ['src/auth/session.ts'],
    capabilities: ['会话过期检测'],
    out_of_scope_explicitly: [],
    acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
  }
  const emptyCall = cx.tool('flowgate_doc', { html: '<html><body><p>待改</p></body></html>', scope })
  await tick()
  await cx.request('/api/flowgate/action', { sessionId: sid, action: 'doc', payload: { decision: 'revise', revisionNote: '   ' } })
  const emptyResult = await emptyCall
  check('AC-11 没填修改意见时，工具返回值要求先问清要改什么', () => {
    assert.equal(emptyResult.decision, 'revise')
    assert.match(emptyResult.message, /没有填写修改意见/)
    assert.doesNotMatch(emptyResult.message, /修改意见原文/)
  })
  await cx.tool('flowgate_cancel', {})
}

// 2000 字是备注的硬上限：超出的部分不进快照，长度断言就是这条边界的证据。
{
  const sid = 'sess-revise-long'
  const cwd = join(testRoot, sid)
  const cx = makeHost(cwd, sid)
  await cx.tool('flowgate_start', { title: '超长意见', preset: 'fast' })
  const scope = {
    commands: [],
    files_expected_to_change: ['src/auth/session.ts'],
    capabilities: ['会话过期检测'],
    out_of_scope_explicitly: [],
    acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
  }
  const longCall = cx.tool('flowgate_doc', { html: '<html><body><p>待改</p></body></html>', scope })
  await tick()
  await cx.request('/api/flowgate/action', { sessionId: sid, action: 'doc', payload: { decision: 'revise', revisionNote: '改'.repeat(2500) } })
  await longCall
  const longState = await cx.request('/api/flowgate/state?sessionId=' + sid)
  check('AC-11 修改意见按 2000 字上限收口后落盘', () => {
    assert.equal(longState.body.doc.revisionNote.length, 2000)
  })
  await cx.tool('flowgate_cancel', {})
}

// 门禁被中断后点「退回开发修复」：Agent 必须被告知回到 S2 重做，否则它会停在 S3。
{
  const sid = 'sess-back'
  const cwd = join(testRoot, sid)
  const cx = makeHost(cwd, sid)
  await cx.tool('flowgate_start', { title: '退回唤醒', preset: 'fast' })
  const scope = {
    commands: [], files_expected_to_change: ['src/auth/session.ts'],
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
    assert.match(text, /退回已经生效/)
    assert.match(text, /进入 S2（/)
    // 补发的是状态通知：Agent 收到时若已经在 S2 重做，不能把它当成再来一次回退。
    assert.match(text, /不要再次回退/)
  })
}

// 评审报告已经落盘但等待器中断：HTTP 仍必须阻止普通通过，风险例外仍需绑定报告。
{
  const sid = 'sess-risk-interrupted'
  const cwd = join(testRoot, sid)
  const cx = makeHost(cwd, sid)
  await cx.tool('flowgate_start', { title: '阻塞评审中断', preset: 'fast' })
  const scope = { commands: [], files_expected_to_change: ['src/auth/session.ts'], capabilities: ['会话过期检测'],
    out_of_scope_explicitly: [], acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }] }
  const docCall = cx.tool('flowgate_doc', { html: '<html><body><p>阻塞评审</p></body></html>', scope })
  await tick()
  await cx.request('/api/flowgate/action', { sessionId: sid, action: 'doc', payload: { decision: 'approve' } })
  await docCall
  const devCall = cx.tool('flowgate_gate', {})
  await tick()
  await cx.request('/api/flowgate/action', { sessionId: sid, action: 'gate', payload: { decision: 'pass' } })
  await devCall
  seedReviewSource(cwd)
  const signal = new AbortController()
  const reviewCall = cx.tool('flowgate_review', { angles: [{ id: 'correctness', name: '正确性', verdict: 'blocking',
    findings: [reviewFinding()] }] }, { signal: signal.signal })
  await tick()
  const submitted = await cx.request('/api/flowgate/state?sessionId=' + sid)
  assert.equal(submitted.body.review.blocking, 1)
  signal.abort()
  await reviewCall
  for (const decision of ['pass', 'skip']) {
    const denied = await cx.request('/api/flowgate/action', { sessionId: sid, action: 'gate', payload: { decision } })
    assert.equal(denied.status, 409, decision + ' cannot close a blocking review without a waiter')
  }
  const still = await cx.request('/api/flowgate/state?sessionId=' + sid)
  check('无等待器时阻塞报告仍不可普通通过且阶段和事件未变', () => {
    assert.equal(still.body.stage, 'S3')
    const events = readFileSync(join(cwd, '.dsh-flowgate', 'flows.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(!events.some((event) => event.type === 'gate.passed' && event.detail.stage === 'S3'))
  })
  const accepted = await cx.request('/api/flowgate/action', { sessionId: sid, action: 'gate',
    payload: { decision: 'accept-risk', reviewId: submitted.body.review.id } })
  check('无等待器时无理由也能带风险继续且绑定当前报告', () => {
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.stage, 'S4')
    const stage = accepted.body.stages.find((item) => item.id === 'S3')
    assert.equal(stage.status, 'accepted_with_risk')
    assert.equal(stage.riskAcceptance.reason, undefined)
    assert.equal(stage.riskAcceptance.reviewId, submitted.body.review.id)
    assert.equal(accepted.body.skippedCount, 0)
    const events = readFileSync(join(cwd, '.dsh-flowgate', 'flows.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(events.some((event) => event.type === 'gate.risk_accepted' && event.detail.stage === 'S3' && !('reason' in event.detail)))
    assert.ok(!events.some((event) => event.type === 'gate.passed' && event.detail.stage === 'S3'))
    const text = cx.delivered.at(-1).message.content.map((block) => block.text).join('\n')
    assert.match(text, /显式接受/)
  })
}

for (const [kind, reason, expected] of [
  ['ascii', 'x'.repeat(2001), 'x'.repeat(2000) + '…（超长已截断）'],
  ['unicode', 'x'.repeat(1999) + '😀', 'x'.repeat(1999) + '…（超长已截断）'],
]) {
  const sid = 'sess-risk-overlong-' + kind
  const cwd = join(testRoot, sid)
  const cx = makeHost(cwd, sid)
  await cx.tool('flowgate_start', { title: '风险理由边界 ' + kind, preset: 'fast' })
  const scope = { commands: [], files_expected_to_change: ['src/auth/session.ts'], capabilities: ['会话过期检测'],
    out_of_scope_explicitly: [], acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }] }
  const docCall = cx.tool('flowgate_doc', { html: '<html><body><p>风险理由边界</p></body></html>', scope })
  await tick()
  await cx.request('/api/flowgate/action', { sessionId: sid, action: 'doc', payload: { decision: 'approve' } })
  await docCall
  const devCall = cx.tool('flowgate_gate', {})
  await tick()
  await cx.request('/api/flowgate/action', { sessionId: sid, action: 'gate', payload: { decision: 'pass' } })
  await devCall
  seedReviewSource(cwd)
  const reviewCall = cx.tool('flowgate_review', { angles: [{ id: 'correctness', name: '正确性', verdict: 'blocking',
    findings: [reviewFinding()] }] })
  await tick()
  const report = await cx.request('/api/flowgate/state?sessionId=' + sid)
  const accepted = await cx.request('/api/flowgate/action', { sessionId: sid, action: 'gate',
    payload: { decision: 'accept-risk', reviewId: report.body.review.id, riskReason: reason } })
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
  const result = await reviewCall
  check('超长风险理由 ' + kind + ' 不破坏可见字符或独立风险状态', () => {
    assert.equal(accepted.status, 200)
    assert.equal(result.decision, 'accept-risk')
    const stage = accepted.body.stages.find((item) => item.id === 'S3')
    assert.equal(stage.status, 'accepted_with_risk')
    assert.equal(stage.riskAcceptance.reason, expected)
    const events = readFileSync(join(cwd, '.dsh-flowgate', 'flows.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(events.some((event) => event.type === 'gate.risk_accepted' && event.detail.reason === expected))
  })
}

// 等待器在场时点「退回开发修复」：决策由工具结果带回，不能再补一条排队消息——
// 否则 Agent 跑完当前轮又收到一次退回，把刚重做的产物清掉（用户看到的「又退回一次」）。
{
  const sid = 'sess-back-live'
  const cwd = join(testRoot, sid)
  const cx = makeHost(cwd, sid)
  await cx.tool('flowgate_start', { title: '退回不重复', preset: 'fast' })
  const scope = {
    commands: [], files_expected_to_change: ['src/auth/session.ts'],
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
  const reviewCall = cx.tool(
    'flowgate_review',
    { angles: [{ id: 'correctness', name: '正确性', verdict: 'pass', findings: [] }] },
  )
  await tick()
  const before = cx.delivered.length
  const back = await cx.request('/api/flowgate/action', {
    sessionId: sid,
    action: 'gate',
    payload: { decision: 'back', to: 'S2' },
  })
  const reviewed = await reviewCall
  check('等待器在场时退回只回退一次且不补发排队消息', () => {
    assert.equal(back.status, 200)
    assert.equal(back.body.stage, 'S2')
    assert.equal(cx.delivered.length, before)
    assert.equal(reviewed.decision, 'reject')
    assert.equal(reviewed.next, 'S2')
  })
  // 同一目标阶段在时间窗内的第二次退回只留事件，不再重置刚重做的阶段产物。
  const again = await cx.request('/api/flowgate/action', {
    sessionId: sid,
    action: 'gate',
    payload: { decision: 'back', to: 'S2' },
  })
  check('重复退回不会二次重置阶段', () => {
    assert.equal(again.status, 200)
    assert.equal(again.body.stage, 'S2')
    const file = join(cwd, '.dsh-flowgate', 'flows.jsonl')
    const events = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(events.some((event) => event.type === 'flow.rollback.skipped'))
  })
}

// 最后一个门禁通过后流程结束：补发的消息要说「结束了」，不能让 Agent 再找下一阶段。
{
  const sid = 'sess-finish'
  const cwd = join(testRoot, sid)
  const cx = makeHost(cwd, sid)
  await cx.tool('flowgate_start', { title: '结束唤醒', preset: 'fast' })
  const scope = {
    commands: [], files_expected_to_change: ['src/auth/session.ts'],
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
    payload: { decision: 'pass', acceptUncovered: true, acceptanceNote: '测试夹具：证据缺口已确认可接受' },
  })
  check('无等待器时显式接受证据缺口后说明流程已结束', () => {
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
    assert.deepEqual(config.stages.S2.ids, saved.body.ruleIds)
    assert.equal(config.stages.S2.ids.includes('no-debug-leftovers'), false)
  })
  check('A 工作区配置里没有写权限之类的流程内授权', () => {
    const raw = readFileSync(configFile, 'utf8')
    assert.equal(raw.includes('writeGrants'), false)
    assert.equal(raw.includes('needWrite'), false)
  })

  // 换一个宿主实例：确认规则是从盘上的 config.json 继承来的，不是内存缓存。
  const secondSid = 'sess-ws-second'
  await first.tool('flowgate_cancel', {})
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
    assert.ok(config.stages.S2.custom.some((rule) => rule.id === customRule.id))
    assert.deepEqual(config.stages.S2.custom.find((rule) => rule.id === customRule.id).points, ['不拼字符串'])
  })

  const thirdSid = 'sess-ws-third'
  await second.tool('flowgate_cancel', {})
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
    const invalidPages = []
    for (const body of [{ page: 0 }, { page: -1 }, { page: 1.5 }, { page: '2' }, { page: null }, { page: Number.MAX_SAFE_INTEGER + 1 }, { pageSize: 0 }, { pageSize: '10' }, { pageSize: null }]) {
      invalidPages.push((await post('flows', { path: ws, ...body })).status)
    }
    const plainFile = join(root, 'plain-file')
    writeFileSync(plainFile, 'text')
    const invalidPaths = []
    for (const path of ['relative/path', plainFile, unlisted, join(root, 'missing')]) {
      invalidPaths.push((await post('flows', { path })).status)
      invalidPaths.push((await post('rules', { path, rules: null })).status)
    }
    const plainAdd = await post('add', { path: plainFile })
    const invalidBodies = []
    for (const route of ['flows', 'rules']) {
      invalidBodies.push((await post(route, null)).status)
      invalidBodies.push((await post(route, [])).status)
      const spec = cx.routes.find((item) => item.path.endsWith('/hub/' + route))
      const response = await spec.fetch(new Request('http://host/api/flowgate/hub/' + route, { method: 'POST', body: '{' }))
      invalidBodies.push(response.status)
    }
    // 断言必须写进回调：写在 check 之前时，失败不会带上用例名，用例计数也照旧算通过（G13）。
    check('Hub 拒绝非法页码、未登记/相对/文件路径与非法请求体', () => {
      assert.deepEqual(invalidPages, Array.from({ length: 9 }, () => 400))
      assert.deepEqual(invalidPaths, Array.from({ length: 8 }, () => 400))
      assert.equal(plainAdd.status, 400)
      assert.deepEqual(invalidBodies, Array.from({ length: 6 }, () => 400))
    })

    const changed = { ...fixture(24), updatedAt: '2099-01-01T00:00:00.000Z', title: '外部更新' }
    writeFileSync(join(flowsDir, 'f_24.json'), JSON.stringify(changed))
    const changedPage = await post('flows', { path: ws })
    check('Hub 外部更改仅重读该快照并更新排序', () => {
      assert.equal(changedPage.body.flows[0].title, '外部更新')
      assert.equal(snapshotReads, 26)
    })
    writeFileSync(join(flowsDir, 'f_25.json'), JSON.stringify(fixture(25)))
    const pageAfterAdd = await post('flows', { path: ws })
    rmSync(join(flowsDir, 'f_00.json'))
    const membersAfterRemove = await post('members', {})
    writeFileSync(join(flowsDir, 'f_01.json'), '{bad')
    const pageAfterCorrupt = await post('flows', { path: ws })
    const afterCorruptRead = snapshotReads
    await post('flows', { path: ws, page: 2 })
    const readsAfterPaging = snapshotReads
    writeFileSync(join(flowsDir, 'f_01.json'), JSON.stringify(fixture(1)))
    const pageAfterRepair = await post('flows', { path: ws })
    check('Hub 外部新增、删除、损坏与修复快照及时更新计数', () => {
      assert.equal(pageAfterAdd.body.total, 26)
      assert.equal(membersAfterRemove.body.members[0].flowCount, 25)
      assert.equal(pageAfterCorrupt.body.total, 24)
      assert.equal(readsAfterPaging, afterCorruptRead, '损坏快照不应每页重读')
      assert.equal(pageAfterRepair.body.total, 25)
    })

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
      assert.deepEqual(Object.keys(config).sort(), ['gateWaitMinutes', 'stages', 'updatedAt', 'version'])
      // gateWaitMinutes 是工作区级门禁等待上限，保存规则时一并写回。
      assert.equal(config.gateWaitMinutes, 10)
      assert.deepEqual(config.stages.S2.custom, [custom])
    })
    const invalid = [
      {}, [], false, { ids: [], custom: null }, { ids: ['unknown'], custom: [] },
      { ids: ['scope-only', 'scope-only'], custom: [] },
      { ids: [], custom: [custom, custom] },
      { ids: [], custom: [{ ...custom, id: 'scope-only' }] },
      { ids: [], custom: [{ ...custom, name: '  ' }] },
      { ids: [], custom: [{ ...custom, points: [1] }] },
    ]
    const invalidStatuses = []
    for (const rules of invalid) invalidStatuses.push((await post('rules', { path: ws, rules })).status)
    const afterInvalidRules = await post('rules', { path: ws })
    check('Hub 拒绝重复/未知/冲突规则ID、空名称和非法字段类型', () => {
      assert.deepEqual(invalidStatuses, Array.from({ length: invalid.length }, () => 400))
      assert.deepEqual(afterInvalidRules.body, saved.body)
    })

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
    const activeBefore = await post('members', {})
    await cx.request('/api/flowgate/action', { sessionId: 'hub-new-flow', action: 'cancel', payload: {} })
    const cancelled = await post('members', {})
    const afterCancelPage = await post('flows', { path: ws })
    check('Hub 内存状态优先，取消后摘要计数立即刷新', () => {
      assert.equal(memoryPage.body.flows.find((flow) => flow.id === state.body.id).title, '从 Hub 规则启动')
      assert.equal(activeBefore.body.members[0].activeCount, 1)
      assert.equal(cancelled.body.members[0].activeCount, 0)
      assert.equal(afterCancelPage.body.currentFlow, null, '放弃后恢复空闲主入口')
    })

    writeFileSync(configFile, JSON.stringify({ version: 1, rules: { ids: ['match-style', 'unknown', 'match-style'], custom: [] } }))
    const external = await post('rules', { path: ws })
    assert.deepEqual(external.body.rules.ids, ['match-style'])
    assert.deepEqual((await cx.request('/api/flowgate/state?sessionId=hub-new-flow')).body.ruleIds, ['match-style'])
    const cleared = await post('rules', { path: ws, rules: null })
    check('Hub 外部规则更新刷新缓存，null 恢复内置默认且不创建流程', () => {
      assert.equal(external.body.rules.configured, true)
      assert.equal(cleared.status, 200)
      assert.equal(cleared.body.rules.configured, false)
      assert.equal(cleared.body.rules.ids.length, 5)
      assert.equal(existsSync(configFile), false)
    })
    await post('remove', { path: ws })
    const rulesAfterRemove = await post('rules', { path: ws, rules: null })
    rmSync(empty, { recursive: true })
    const flowsAfterGone = await post('flows', { path: empty })
    const rulesAfterGone = await post('rules', { path: empty })
    const membersAfterGone = await post('members', {})
    check('Hub 已移除成员或已消失目录拒绝读取和写入', () => {
      assert.equal(rulesAfterRemove.status, 400)
      assert.equal(flowsAfterGone.status, 400)
      assert.equal(rulesAfterGone.status, 400)
      assert.equal(membersAfterGone.body.members[0].missing, true)
    })
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
      const readService = currentService()
      await checkAsync('G07 ' + kind + '失败不打断无关或归属无法确认的普通操作，不污染进度', async () => {
        for (const header of [
          { id: 'independent', cwd: ws, delegationDepth: 0 },
          { id: 'independent-child', cwd: ws, delegationDepth: 1, origin: 'subagent', parentSession: 'independent' },
          { id: 'unconfirmed-child', cwd: ws, delegationDepth: 1, origin: 'subagent', parentSession: 'read-existing' },
        ]) {
          const result = await restarted.handlers.get('tools/pre-execute')(
            { name: 'write', arguments: { file_path: 'ordinary.js', content: 'x' }, agent: { session: { header } } },
            async () => ({ kind: 'allow' }),
          )
          assert.equal(result.kind, 'allow', kind + ': ' + header.id)
        }
        assert.equal(readService.activity.size, 0)
        assert.equal(readService.loaded.has(ws), false, '读失败不标记已恢复，权限修复后必须能重试')
      })
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
// 四阶段统一配置：旧格式迁移、内置对照、来源优先、局部重置与原子失败。
{
  const root = mkdtempSync(join(tmpdir(), 'flowgate-stages-'))
  const ws = join(root, 'workspace'), other = join(root, 'other')
  mkdirSync(ws); mkdirSync(other)
  const previousHome = process.env.DSH_FLOWGATE_HOME
  process.env.DSH_FLOWGATE_HOME = join(root, 'home')
  const configFile = join(ws, '.dsh-flowgate', 'config.json')
  const sid = 'all-stages'
  const cx = makeHost(ws, sid)
  const post = (route, body) => cx.request('/api/flowgate/hub/' + route, body)
  const act = (action, payload, sessionId = sid) => cx.request('/api/flowgate/action', { sessionId, action, payload })
  const originalRename = fs.renameSync
  try {
    await post('add', { path: ws }); await post('add', { path: other })
    const defaults = (await post('rules', { path: ws })).body.rules.stages
    check('四阶段 Hub 读出各阶段内置目录、档位默认和未配置状态', () => {
      assert.deepEqual(Object.keys(defaults), ['S1', 'S2', 'S3', 'S4'])
      for (const value of Object.values(defaults)) {
        assert.equal(value.configured, false)
        assert.equal(value.selection, null)
        assert.deepEqual(value.ids, value.defaults.fast)
        assert.ok(value.builtin.length > 0 && value.defaults.strict.length > 0)
      }
      assert.equal(existsSync(join(ws, '.dsh-flowgate')), false)
    })
    mkdirSync(join(ws, '.dsh-flowgate'))
    const legacy = { version: 1, rules: { ids: ['match-style', 'unknown', 'match-style'], custom: [] }, writeGrants: ['unsafe'], scope: { frozen: true } }
    writeFileSync(configFile, JSON.stringify(legacy))
    const migrated = (await post('rules', { path: ws })).body.rules.stages
    check('旧 rules 只迁移 S2，读取不改盘且过滤重复未知ID', () => {
      assert.deepEqual(migrated.S2.ids, ['match-style'])
      assert.equal(migrated.S2.configured, true)
      assert.ok(['S1', 'S3', 'S4'].every((stage) => !migrated[stage].configured))
      assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), legacy)
    })
    const chosen = { S1: 'clarify-goal', S2: 'scope-only', S3: 'correctness', S4: 'smoke' }
    const stages = Object.fromEntries(Object.entries(chosen).map(([stage, id]) => {
      const custom = { id: 'project-' + stage, name: '新增 ' + stage, points: ['新增要点 ' + stage] }
      const edit = { ...defaults[stage].builtin.find((item) => item.id === id), name: '已编辑 ' + stage, points: ['执行标记 ' + stage] }
      return [stage, { ids: stage === 'S1' ? null : [id, custom.id], custom: [custom], edits: [edit] }]
    }))
    const saved = await post('rules', { path: ws, stages, scope: { frozen: true }, writeGrants: ['smoke'] })
    check('四阶段整体保存，保留内置原文并单独提供编辑版和新增条目', () => {
      assert.equal(saved.status, 200)
      for (const stage of Object.keys(chosen)) {
        const value = saved.body.rules.stages[stage]
        assert.equal(value.configured, true)
        assert.deepEqual(value.selection, stages[stage].ids)
        assert.deepEqual(value.builtin, defaults[stage].builtin)
        assert.deepEqual(value.catalog.find((item) => item.id === chosen[stage]).points, ['执行标记 ' + stage])
        assert.deepEqual(value.custom, stages[stage].custom)
      }
      assert.ok(!saved.body.rules.stages.S1.ids.includes('project-S1'), '跟随档位不应自动启用新增条目')
      const disk = JSON.parse(readFileSync(configFile, 'utf8'))
      assert.equal(disk.version, 2)
      assert.deepEqual(disk.stages, stages)
      assert.deepEqual(Object.keys(disk).sort(), ['gateWaitMinutes', 'stages', 'updatedAt', 'version'])
      // 写权限概念已删除：客户端多传的字段不会被写进工作区配置。
      assert.equal(JSON.stringify(disk).includes('needsWrite'), false)
    })
    const savedRaw = readFileSync(configFile, 'utf8')
    const invalidStages = [
      { S1: null }, { ...stages, S5: null }, { ...stages, S3: { ...stages.S3, ids: ['unknown'] } },
      { ...stages, S1: { ...stages.S1, edits: [{ id: 'security', name: '跨阶段编辑', points: [] }] } },
      { ...stages, S3: { ...stages.S3, edits: [...stages.S3.edits, ...stages.S3.edits] } },
      { ...stages, S4: { ...stages.S4, custom: [{ id: 'smoke', name: '冲突', points: [] }] } },
      { ...stages, S4: { ...stages.S4, edits: [{ ...stages.S4.edits[0], points: '不是数组' }] } },
      { ...stages, S2: { ...stages.S2, custom: [{ ...stages.S2.custom[0], points: [1] }] } },
    ]
    for (const invalid of invalidStages) assert.equal((await post('rules', { path: ws, stages: invalid })).status, 400)
    assert.equal((await post('rules', { path: ws, stages, rules: null })).status, 400)
    check('任一阶段非法则全部拒绝，配置与有效目录都不发生部分更新', () => {
      assert.equal(readFileSync(configFile, 'utf8'), savedRaw)
    })
    fs.renameSync = function (from, to) {
      if (String(to) === configFile) throw Object.assign(new Error('原子保存 EACCES'), { code: 'EACCES' })
      return originalRename.call(this, from, to)
    }
    syncBuiltinESMExports()
    const failed = await post('rules', { path: ws, stages: { ...stages, S1: null } })
    fs.renameSync = originalRename; syncBuiltinESMExports()
    const afterFailure = (await post('rules', { path: ws })).body.rules.stages
    check('四阶段原子重命名失败显式报错，盘与缓存继续保持旧配置', () => {
      assert.equal(failed.status, 500)
      assert.match(failed.body.error, /EACCES/)
      assert.equal(readFileSync(configFile, 'utf8'), savedRaw)
      assert.deepEqual(afterFailure, saved.body.rules.stages)
    })
    const brief = '  需求原文含路径 src/a.js 与数字 123\n' + '完整保留需求原文。\n'.repeat(650) + '\n '
    const badPreset = await act('start', { preset: 'turbo', brief: '档位写错' })
    const noFlowYet = await cx.request('/api/flowgate/state?sessionId=' + sid)
    check('未知档位启动被拒绝，不静默回落到 fast', () => {
      assert.equal(badPreset.status, 409)
      assert.match(badPreset.body.error, /未知档位/)
      assert.equal(noFlowYet.body.active, false)
    })
    const started = await act('start', { title: '语义标题', brief, preset: 'strict' })
    const duplicate = await act('start', { title: '重复标题', brief: '替换原文', preset: 'fast' })
    const afterDuplicate = await cx.request('/api/flowgate/state?sessionId=' + sid)
    check('流程完整独立保存原文，重复启动被拒绝', () => {
      assert.equal(started.status, 200)
      assert.equal(started.body.title, '语义标题')
      assert.equal(started.body.brief, brief)
      // 需求整理稿已废弃：快照里不能再带这个字段，需求依据只有 brief。
      assert.equal('summary' in started.body, false)
      assert.equal(duplicate.status, 409)
      assert.match(duplicate.body.error, /已有流程在进行/)
      assert.equal(afterDuplicate.body.id, started.body.id)
      assert.equal(afterDuplicate.body.brief, brief)
      assert.equal('summary' in afterDuplicate.body, false)
      assert.equal(afterDuplicate.body.preset, 'strict')
      assert.equal(started.body.scope.frozen, false)
      assert.equal('writeGrants' in started.body, false)
      for (const stage of Object.keys(chosen)) assert.equal(started.body.stageConfigs[stage].source, 'workspace')
      assert.deepEqual(started.body.stageConfigs.S1.ids, defaults.S1.defaults.strict)
      assert.ok(started.body.directions.every((item) => !('writeGranted' in item)))
      assert.match(cx.delivered[0].message.content.map((item) => item.text).join('\n'), /执行标记 S1/)
      assert.match(cx.delivered[0].message.content.map((item) => item.text).join('\n'), /完整保留需求原文/)
      // 需求依据只能来自原文：唤醒消息里出现 brief 首行，而不是把标题当成需求描述。
      const wake = cx.delivered[0].message.content.map((item) => item.text).join('\n')
      assert.match(wake, /需求原文含路径 src\/a\.js 与数字 123/)
      assert.match(wake, /需求分析以「需求原文」为唯一依据/)
      assert.equal(wake.includes('需求整理稿'), false)
    })
    const status = await cx.tool('flowgate_status', {})
    const page = await post('flows', { path: ws })
    check('S1 消费工作区需求规则，当前流程全文与历史短摘要独立', () => {
      assert.match(status.summary, /执行标记 S1/)
      assert.equal(page.body.currentFlow.brief, brief)
      assert.equal(page.body.currentFlow.summary, undefined)
      assert.equal(page.body.flows.find((flow) => flow.id === started.body.id).brief, brief.slice(0, 200))
      assert.equal(page.body.flows.find((flow) => flow.id === started.body.id).summary, undefined)
      assert.equal(started.body.stage, 'S1')
    })
    for (const [stage, id] of Object.entries(chosen)) {
      const action = { S1: 'toggleAnalysisRule', S2: 'toggleRule', S3: 'toggleAngle', S4: 'toggleDirection' }[stage]
      const changed = await act(action, { id, enabled: false })
      assert.equal(changed.status, 200)
      assert.equal(changed.body.stageConfigs[stage].source, 'flow')
      assert.ok(!changed.body.stageConfigs[stage].ids.includes(id))
    }
    const analysisAdded = await act('addAnalysisRule', { name: '本次需求补充', points: ['仅本次启用的需求要点'] })
    check('S1 新增需求规则仅作用本次流程，保留工作区配置', () => {
      assert.equal(analysisAdded.status, 200)
      assert.ok(analysisAdded.body.stageConfigs.S1.items.some((item) => item.name === '本次需求补充' && item.points[0] === '仅本次启用的需求要点'))
      assert.equal(analysisAdded.body.stageConfigs.S1.source, 'flow')
      assert.equal(readFileSync(configFile, 'utf8'), savedRaw)
    })
    const followed = await act('followStageDefaults', { stage: 'S3' })
    check('本次选择优先于工作区，恢复跟随只清指定阶段覆盖', () => {
      assert.equal(followed.body.stageConfigs.S3.source, 'workspace')
      assert.deepEqual(followed.body.stageConfigs.S3.ids, stages.S3.ids)
      for (const stage of ['S1', 'S2', 'S4']) assert.equal(followed.body.stageConfigs[stage].source, 'flow')
      assert.equal(readFileSync(configFile, 'utf8'), savedRaw)
      assert.equal('writeGrants' in followed.body, false)
    })
    const reset = await post('rules', { path: ws, rules: null })
    await act('followStageDefaults', { stage: 'S2' })
    check('旧 rules:null 仅重置 S2，其他阶段配置及内置编辑保留', () => {
      assert.equal(reset.body.rules.stages.S2.configured, false)
      for (const stage of ['S1', 'S3', 'S4']) assert.deepEqual(reset.body.rules.stages[stage], saved.body.rules.stages[stage])
      assert.equal(existsSync(configFile), true)
    })
    const restoredBuiltin = await post('rules', { path: ws, stages: { ...stages, S2: null, S3: { ...stages.S3, ids: null, edits: [] } } })
    const current = await cx.request('/api/flowgate/state?sessionId=' + sid)
    check('去掉内置编辑恢复原文，ids:null 在严格档位跟随严格默认', () => {
      assert.equal(restoredBuiltin.status, 200)
      assert.deepEqual(current.body.stageConfigs.S3.ids, defaults.S3.defaults.strict)
      assert.equal(current.body.stageConfigs.S3.catalog.find((item) => item.id === 'correctness').name, '正确性')
      assert.equal(current.body.stageConfigs.S2.source, 'default')
    })
    const otherConfig = await post('rules', { path: other })
    check('工作区配置相互隔离且任何阶段配置均不创建 scope 或授权', () => {
      assert.ok(Object.values(otherConfig.body.rules.stages).every((value) => !value.configured))
      assert.equal(existsSync(join(other, '.dsh-flowgate')), false)
      assert.equal(existsSync(join(ws, '.dsh-flowgate', 'scope.json')), false)
      assert.equal(JSON.stringify(JSON.parse(readFileSync(configFile, 'utf8'))).includes('writeGrants'), false)
    })
    const titleHost = makeHost(other, 'long-title-start')
    const longTitle = await titleHost.request('/api/flowgate/action', { sessionId: 'long-title-start', action: 'start', payload: { title: '标'.repeat(500), brief: '标题截断' } })
    check('超长标题按 24 字截断，不写进快照', () => {
      assert.equal(longTitle.status, 200)
      assert.equal(longTitle.body.title.length, 24)
    })
    // 这条流程只是参数校验的载体，立刻结束，免得抢走后面 Hub 的 currentFlow。
    await titleHost.tool('flowgate_cancel', {})
    const tooLong = await titleHost.request('/api/flowgate/action', { sessionId: 'overlong-start', action: 'start', payload: { brief: 'x'.repeat(20001) } })
    check('启动明确拒绝超限需求且不静默截断', () => {
      assert.equal(tooLong.status, 409)
      assert.match(tooLong.body.error, /20000/)
    })
    const file = join(ws, '.dsh-flowgate', 'flows', started.body.id + '.json')
    const restarted = makeHost(ws, sid)
    const loaded = await restarted.request('/api/flowgate/state?sessionId=' + sid)
    check('重启恢复需求原文', () => {
      assert.equal(loaded.body.brief, brief)
      assert.equal(loaded.body.summary, undefined)
    })
    // 旧快照可能还带着已废弃的整理稿字段：读盘时一律丢掉，不能让界面或提示词再用到它。
    const old = JSON.parse(readFileSync(file, 'utf8')); old.summary = '旧版整理稿残留'
    writeFileSync(file, JSON.stringify(old))
    const legacyHost = makeHost(ws, sid)
    const legacyPage = await legacyHost.request('/api/flowgate/hub/flows', { path: ws })
    const legacyPageAgain = await legacyHost.request('/api/flowgate/hub/flows', { path: ws, pageSize: 1 })
    const legacyState = await legacyHost.request('/api/flowgate/state?sessionId=' + sid)
    check('旧流程的整理稿字段被忽略，详情和 Hub 只给原文', () => {
      assert.equal(legacyState.body.brief, brief)
      assert.equal(legacyState.body.summary, undefined)
      assert.equal(legacyPage.body.flows.find((flow) => flow.id === old.id).summary, undefined)
      assert.equal(legacyPage.body.currentFlow.summary, undefined)
      assert.equal(legacyPage.body.currentFlow.brief, brief)
      assert.deepEqual(legacyPageAgain.body.currentFlow, legacyPage.body.currentFlow)
    })
    // 冷恢复兜底：缺字段、坏字段、无法修复的快照都不能让整个工作台的流程功能崩掉。
    const brokenId = 'f_broken000001'
    writeFileSync(join(ws, '.dsh-flowgate', 'flows', brokenId + '.json'), JSON.stringify({
      id: brokenId, sessionId: 'broken-session', cwd: ws, title: '残缺快照',
      preset: 'turbo', stage: 'S9', finished: false,
      scope: 'oops', doc: null, writeGrants: 'nope', shellGrant: true,
    }))
    writeFileSync(join(ws, '.dsh-flowgate', 'flows', 'f_noid.json'), JSON.stringify({ sessionId: 'x' }))
    const brokenHost = makeHost(ws, 'broken-session')
    const brokenState = await brokenHost.request('/api/flowgate/state?sessionId=broken-session')
    const brokenHub = await brokenHost.request('/api/flowgate/hub/flows', { path: ws })
    check('AC6 残缺快照冷恢复时补齐结构并撤销授权，无法修复的条目直接丢弃', () => {
      assert.equal(brokenState.status, 200)
      assert.equal(brokenState.body.active, true)
      assert.equal(brokenState.body.stage, 'S1')
      assert.equal(brokenState.body.preset, 'fast')
      // 旧快照里的授权字段一律清洗掉：权限只有一个来源，就是冻结 scope 的 commands 清单。
      assert.equal('shellGrant' in brokenState.body, false)
      assert.equal('writeGrants' in brokenState.body, false)
      assert.equal(brokenHub.status, 200)
      assert.equal(brokenHub.body.flows.some((flow) => flow.id === 'f_noid'), false)
    })
  } finally {
    fs.renameSync = originalRename; syncBuiltinESMExports()
    if (previousHome === undefined) delete process.env.DSH_FLOWGATE_HOME
    else process.env.DSH_FLOWGATE_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
}

// 权限只有一个来源：S1 批准过的 scope.commands 清单。冷恢复不复活任何授权，
// 旧快照里残留的授权字段一律清洗，测试子代理也只看清单。
{
  const root = mkdtempSync(join(tmpdir(), 'flowgate-scope-only-'))
  const ws = join(root, 'workspace'), other = join(root, 'other')
  mkdirSync(ws); mkdirSync(other)
  const previousHome = process.env.DSH_FLOWGATE_HOME
  process.env.DSH_FLOWGATE_HOME = join(root, 'home')
  const sid = 'scope-only', foreignSid = 'scope-only-other'
  const sessionDirs = new Map([[sid, ws], [foreignSid, other]])
  const services = { sessions: { get: (id) => ({ header: { id, cwd: sessionDirs.get(id) ?? ws } }) } }
  let cx = makeHost(ws, sid, { services })
  const post = (route, body) => cx.request('/api/flowgate/hub/' + route, body)
  const act = (action, payload, id = sid) => cx.request('/api/flowgate/action', { sessionId: id, action, payload })
  const state = (id = sid) => cx.request('/api/flowgate/state?sessionId=' + encodeURIComponent(id))
  // 这套用例验证每步都要人点的手动门禁；fast 档默认自动通过，启动后显式切回来。
  const call = async (name, args, id = sid) => {
    const prepared = withGrill(name, args)
    const value = await cx.tools.get(name).execute(prepared, {
      name, arguments: prepared, agent: { session: { header: { id, cwd: sessionDirs.get(id) } } },
    })
    if (name === 'flowgate_start') assert.equal((await act('setGateMode', { mode: 'manual' }, id)).status, 200)
    return value
  }
  try {
    for (const path of [ws, other]) assert.equal((await post('add', { path })).status, 200)
    for (const id of [sid, foreignSid]) {
      await call('flowgate_start', { title: '清单是唯一权限', preset: 'fast' }, id)
      const doc = call('flowgate_doc', { html: '<html><body>清单</body></html>', scope: {
        commands: ['npm test'], files_expected_to_change: ['src/auth/session.ts'], capabilities: ['清单放行'],
        out_of_scope_explicitly: [],
        acceptance_criteria: [{ id: 'AC-1', when: '清单命中', then: '放行' }],
      } }, id)
      await tick(); assert.equal((await act('doc', { decision: 'approve' }, id)).status, 200); await doc
      const dev = call('flowgate_gate', {}, id)
      await tick(); assert.equal((await act('gate', { decision: 'pass' }, id)).status, 200); await dev
      const review = call('flowgate_review', { angles: [{ id: 'correctness', name: '正确性', verdict: 'pass', findings: [] }] }, id)
      await tick(); assert.equal((await act('gate', { decision: 'pass' }, id)).status, 200); await review
    }
    const initial = (await state()).body
    check('两个工作区都进到 S4，视图里没有任何授权字段', () => {
      assert.equal(initial.stage, 'S4')
      assert.equal('shellGrant' in initial, false)
      assert.equal('writeGrants' in initial, false)
      assert.equal('directionWriteDeclared' in initial, false)
      for (const dir of initial.directions) {
        assert.equal('needsWrite' in dir, false)
        assert.equal('writeGranted' in dir, false)
      }
    })
    // 旧版本留在磁盘上的授权字段：冷恢复必须清洗，不能靠「上次勾过」继续放行。
    const flowFile = join(ws, '.dsh-flowgate', 'flows', initial.id + '.json')
    const legacy = JSON.parse(readFileSync(flowFile, 'utf8'))
    legacy.shellGrant = true
    legacy.writeGrants = ['smoke']
    legacy.directionWriteDeclared = ['smoke']
    writeFileSync(flowFile, JSON.stringify(legacy))
    cx = makeHost(ws, sid, { services })
    const restored = (await state()).body
    check('旧快照里的授权字段冷恢复后被清洗', () => {
      assert.equal(restored.stage, 'S4')
      assert.equal('shellGrant' in restored, false)
      assert.equal('writeGrants' in restored, false)
      assert.equal('directionWriteDeclared' in restored, false)
      assert.equal(JSON.parse(readFileSync(flowFile, 'utf8')).shellGrant, undefined)
    })
    // 测试子代理同样只看清单：登记里根本没有权限位可传。
    const service = currentService()
    service.registerChild(sid, 'scope-only-child', { flowId: restored.id, directionId: restored.directions[0].id })
    const childExec = (command) => ({ name: 'ops_bash', arguments: { command },
      agent: { session: { header: { id: 'scope-only-child', cwd: ws } } } })
    const childIn = service.childDenial(childExec('npm test'))
    const childOut = service.childDenial(childExec('npm publish'))
    check('测试子代理只按 scope 清单放行，没有别的权限位', () => {
      assert.equal(childIn, null)
      assert.ok(childOut)
      assert.match(String(childOut), /scope\.commands/)
    })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_FLOWGATE_HOME
    else process.env.DSH_FLOWGATE_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
}

// 需求整理只借用工作区已有模型：无会话创建、流程落盘、工具调用或 Agent 唤醒。
{
  const root = mkdtempSync(join(tmpdir(), 'flowgate-prepare-'))
  const ws = join(root, 'workspace'), foreign = join(root, 'foreign')
  mkdirSync(ws); mkdirSync(foreign)
  const previousHome = process.env.DSH_FLOWGATE_HOME
  process.env.DSH_FLOWGATE_HOME = join(root, 'home')
  const live = [
    { header: { id: 'foreign', cwd: foreign } },
    { header: { id: 'same-workspace', cwd: ws } },
    { header: { id: 'missing-model', cwd: ws } },
    { header: { id: 'child', cwd: ws, delegationDepth: 1 } },
  ]
  const calls = [], streams = []
  let created = 0, delivered = 0, modelFails = false
  let modelResult = { title: '工作区模型生成标题' }
  const services = {
    sessions: { list: () => live, get: (id) => live.find((session) => session.header.id === id), create() { created++; throw new Error('不许创建会话') } },
    agents: { get: (id) => ({ model: { current: () => id === 'missing-model' ? undefined : { provider: 'fixture-provider', model: 'fixture-' + id } }, followup() { delivered++ } }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
    llm: { async prepareCall(config, signal) {
      calls.push({ config, signal })
      if (modelFails) throw new Error('credential secret-forbidden')
      return { config: { ...config, maxTokens: 2048 }, async *stream(options) {
        streams.push(options)
        yield { type: 'text-delta', index: 0, text: JSON.stringify(modelResult) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    } },
  }
  const cx = makeHost(ws, 'prepare-view', { services })
  const post = (route, body) => cx.request('/api/flowgate/hub/' + route, body)
  try {
    await post('add', { path: ws })
    const brief = '  原文含路径 src/a.js\n保留 123 与约束。\n '
    const prepared = await post('prepare', { path: ws, brief })
    const state = await cx.request('/api/flowgate/state?sessionId=prepare-view')
    const page = await post('flows', { path: ws })
    check('prepare 优先当前工作区已有模型，跳过其他工作区和子会话且不创建流程', () => {
      assert.equal(prepared.status, 200)
      assert.deepEqual(prepared.body, { title: '工作区模型生成标题', status: 'ready' })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].config.model, 'fixture-same-workspace')
      assert.equal(streams[0].sessionId, 'same-workspace')
      assert.deepEqual(streams[0].tools, [])
      assert.equal(streams[0].maxTokens, 2048)
      assert.equal(JSON.parse(streams[0].messages[0].content[0].text).brief, brief)
      // 提示词本身必须带上会话标题的口径，否则模型只会照着原文首句复述。
      assert.equal(streams[0].system, SYSTEM_PROMPT)
      assert.match(streams[0].system, /会话标题/)
      assert.match(streams[0].system, /名词短语/)
      assert.match(streams[0].system, /4 到 12 个字/)
      assert.match(streams[0].system, /只输出一个 JSON 对象/)
      assert.equal(state.body.active, false)
      assert.equal(page.body.total, 0)
      assert.equal(created, 0)
      assert.equal(delivered, 0)
      assert.equal(existsSync(join(ws, '.dsh-flowgate')), false)
    })
    check('标题生成期限固定为 6000ms', () => {
      assert.equal(TIMEOUT_MS, 6_000)
    })
    for (const value of [null, [], {}, 1, false]) assert.equal((await post('prepare', { path: ws, brief: value })).status, 400)
    assert.equal((await post('prepare', { path: ws, brief: 'x'.repeat(20001) })).status, 400)
    assert.equal((await post('prepare', { path: foreign, brief })).status, 400)
    assert.equal((await post('prepare', { path: 'relative/path', brief })).status, 400)
    const maxInput = 'x'.repeat(20000)
    const maximum = await post('prepare', { path: ws, brief: maxInput })
    check('prepare 拒绝非法需求和未登记路径，20000字符边界原样交给模型', () => {
      assert.equal(maximum.status, 200)
      assert.equal(calls.length, 2)
      assert.equal(JSON.parse(streams[1].messages[0].content[0].text).brief, maxInput)
    })
    // 标题只做形式收敛：带标点、带编号、超长时按同一规则清洗；空标题或带「整理稿」
    // 字样的答案整次降级，绝不让脏标题进快照。
    for (const [label, value, expected, status] of [
      ['带句末标点', '会话过期检测。', '会话过期检测', 'ready'],
      ['带 Markdown 前缀与引号', '## 「导出报表」', '导出报表', 'ready'],
      ['超长标题截断', '会'.repeat(40), '会'.repeat(24), 'ready'],
      ['空标题降级', '   ', '', 'fallback'],
      ['整理稿字样降级', '需求整理稿', '', 'fallback'],
      ['非字符串标题降级', 42, '', 'fallback'],
    ]) {
      modelResult = { title: value }
      const result = await post('prepare', { path: ws, brief: '会话过期后请求返回 401。' })
      check('标题形式收敛：' + label, () => {
        assert.equal(result.status, 200)
        assert.equal(result.body.status, status)
        assert.equal(result.body.title, status === 'ready' ? expected : '会话过期后请求返回 401')
      })
    }
    modelResult = { title: '会话模型标题' }
    const sessionBrief = '目标：保留全部需求。'
    const bySession = await post('prepare', { sessionId: 'foreign', brief: sessionBrief })
    check('会话入口按真实会话选择模型，无须先登记工作区', () => {
      assert.equal(bySession.status, 200)
      assert.equal(bySession.body.status, 'ready')
      assert.equal(bySession.body.title, '会话模型标题')
      assert.equal(streams.at(-1).sessionId, 'foreign')
      assert.equal(JSON.parse(streams.at(-1).messages[0].content[0].text).brief, sessionBrief)
    })
    const beforeInvalid = calls.length
    for (const invalid of [undefined, '', 'not-a-session']) {
      const rejected = await post('prepare', { sessionId: invalid, brief: sessionBrief })
      assert.equal(rejected.status, 400)
    }
    assert.equal((await post('prepare', { sessionId: 'foreign', path: foreign, brief: sessionBrief })).status, 400)
    check('无效会话和未登记的显式路径不得触发模型或流程', () => {
      assert.equal(calls.length, beforeInvalid)
      assert.equal(created, 0)
      assert.equal(delivered, 0)
    })
    modelFails = true
    const fallback = await post('prepare', { path: ws, brief: '  # 本地标题。\n\n\n保留原文 456  ' })
    check('模型不可用时标题回落到原文首个非空行，原始错误不进用户消息', () => {
      assert.equal(fallback.status, 200)
      assert.equal(fallback.body.status, 'fallback')
      assert.equal(fallback.body.title, '本地标题')
      assert.equal(fallback.body.summary, undefined)
      assert.equal(JSON.stringify(fallback.body).includes('secret-forbidden'), false)
      assert.equal(created, 0)
      assert.equal(delivered, 0)
      assert.equal(existsSync(join(ws, '.dsh-flowgate')), false)
    })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_FLOWGATE_HOME
    else process.env.DSH_FLOWGATE_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
}

// 直接调用公开 helper，避免期限替身经过 Hub 的文件或 JSON 请求链路。
{
  const realNow = performance.now.bind(performance)
  const immediateContext = (title) => ({
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    llm: {
      async prepareCall(config) {
        return {
          config,
          async *stream() {
            yield { type: 'text-delta', index: 0, text: JSON.stringify({ title }) }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  })

  // 标题只解析一个字段：两万字的原文也必须在一瞬间走完，不能因为体积卡在解析或截断上。
  for (const [label, brief, title] of [
    ['中文原文达到合法上限', '中'.repeat(20_000), '会话过期检测'],
    // 19991 + ' src/x.md' 正好 20000：卡在合法上限，不再是 20004 那种越界请求。
    ['最大中文文本附真实相对路径', '中'.repeat(19_991) + ' src/x.md', '修复路径解析'],
    ['超长标题按 24 字截断', '需求。', '会'.repeat(40)],
    ['英文需求给英文标题', 'Add session expiry detection.', 'Session expiry'],
  ]) {
    const ctx = immediateContext(title)
    const started = realNow()
    const result = await prepareRequirement(ctx, { brief })
    const elapsed = realNow() - started
    check('标题生成性能：' + label, () => {
      assert.equal(result.status, 'ready')
      assert.equal(result.title, title.length > 24 ? title.slice(0, 24) : title)
      assert.ok(elapsed < 2_000, label + ' 用时 ' + elapsed.toFixed(2) + 'ms，必须低于2000ms')
    })
    console.log('       性能耗时：' + elapsed.toFixed(2) + 'ms')
  }

  async function deadlineProbe(phase, elapsed, { invalidJson = false } = {}) {
    const brief = '原始需求。'
    const payload = invalidJson ? '{' : JSON.stringify({ title: '需求标题' })
    const origin = 40_000
    let logicalNow = origin
    let signal
    let streamCalls = 0
    let nextCalls = 0
    let closed = 0
    let result
    const events = []
    const timers = []
    const restores = []
    const perf = globalThis.performance
    const originalParse = JSON.parse
    const properties = [
      [globalThis, 'performance'],
      [perf, 'now'],
      [globalThis, 'setTimeout'],
      [globalThis, 'clearTimeout'],
      [JSON, 'parse'],
    ].map(([object, key]) => ({ object, key, descriptor: Object.getOwnPropertyDescriptor(object, key) }))

    function reach(event) {
      events.push(event)
      if (event === 'prepare') logicalNow = origin + 4_500
      if (event === phase) logicalNow = origin + elapsed
    }

    function replace(object, key, value) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key)
      Object.defineProperty(object, key, { configurable: true, writable: true, value })
      restores.push(() => {
        if (descriptor) Object.defineProperty(object, key, descriptor)
        else Reflect.deleteProperty(object, key)
      })
    }

    try {
      replace(perf, 'now', () => logicalNow)
      // 不执行定时器回调：逻辑期限必须独立发现同步工作已超时。
      replace(globalThis, 'setTimeout', (callback, delay) => {
        const timer = { callback, delay, cleared: false, unref() { return this } }
        timers.push(timer)
        return timer
      })
      replace(globalThis, 'clearTimeout', (timer) => { timer.cleared = true })
      replace(JSON, 'parse', function (text, ...args) {
        try {
          return Reflect.apply(originalParse, this, [text, ...args])
        } finally {
          // 原生解析成功和抛错都在完成这个响应时推进时间。
          if (text === payload) reach('json')
        }
      })
      const ctx = {
        agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
        llm: {
          async prepareCall(config, receivedSignal) {
            signal = receivedSignal
            await Promise.resolve()
            reach('prepare')
            return {
              config,
              stream(options) {
                assert.equal(options.signal, signal)
                streamCalls++
                reach('stream-open')
                const cut = Math.floor(payload.length / 2)
                const steps = [
                  ['first', { type: 'text-delta', index: 0, text: payload.slice(0, cut) }],
                  ['chunk', { type: 'text-delta', index: 0, text: payload.slice(cut) }],
                  ['finish', { type: 'finish', reason: { kind: 'stop' } }],
                ]
                let index = 0
                return {
                  [Symbol.asyncIterator]() { return this },
                  next() {
                    nextCalls++
                    const step = steps[index++]
                    if (!step) return Promise.resolve({ done: true })
                    reach(step[0])
                    return Promise.resolve({ done: false, value: step[1] })
                  },
                  return() {
                    closed++
                    return Promise.resolve({ done: true })
                  },
                }
              },
            }
          },
        },
      }
      result = await prepareRequirement(ctx, { brief })
    } finally {
      for (let index = restores.length - 1; index >= 0; index--) restores[index]()
      // 同时比较函数和自有属性；原型上的now不能被恢复成新增自有属性。
      for (const { object, key, descriptor } of properties) {
        assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), descriptor, key + '替身未完整恢复')
      }
      assert.equal(globalThis.performance, perf)
      assert.equal(JSON.parse, originalParse)
    }
    return { result, signal, events, timers, streamCalls, nextCalls, closed, brief }
  }

  // 所有替身串行安装、finally恢复，断言与日志在恢复后运行。
  for (const [label, phase, elapsed, invalidJson, expected] of [
    ['JSON完成5999ms仍成功', 'json', 5_999, false, 'ready'],
    ['prepare完成6000ms中止且不开始流', 'prepare', 6_000, false, 'fallback'],
    ['stream返回6000ms中止且不读取', 'stream-open', 6_000, false, 'fallback'],
    ['中途片段6000ms中止并关闭流', 'chunk', 6_000, false, 'fallback'],
    ['finish完成6000ms中止并关闭流', 'finish', 6_000, false, 'fallback'],
    ['JSON成功解析6000ms仍按超时降级', 'json', 6_000, false, 'fallback'],
    ['JSON抛错6000ms优先超时文案', 'json', 6_000, true, 'fallback'],
  ]) {
    const probe = await deadlineProbe(phase, elapsed, { invalidJson })
    check('标题生成统一期限：' + label, () => {
      assert.equal(probe.result.status, expected)
      assert.ok(probe.events.includes(phase))
      assert.ok(probe.timers.length > 0)
      assert.ok(probe.timers.every((timer) => timer.cleared))
      if (expected === 'ready') {
        assert.equal(probe.result.title, '需求标题')
        assert.equal(probe.signal.aborted, false)
      } else {
        assert.equal(probe.result.title, '原始需求')
        assert.equal(probe.result.message, '标题生成超时，已回落为本地取值。')
        assert.equal(probe.signal.aborted, true)
        assert.equal(probe.signal.reason?.code, 'timeout')
      }
      if (phase === 'prepare') {
        assert.equal(probe.streamCalls, 0)
        assert.equal(probe.nextCalls, 0)
        assert.equal(probe.closed, 0)
      } else if (phase === 'stream-open') {
        assert.equal(probe.streamCalls, 1)
        assert.equal(probe.nextCalls, 0)
        assert.equal(probe.closed, 0)
      } else {
        assert.equal(probe.streamCalls, 1)
        assert.ok(probe.nextCalls > 0)
        assert.equal(probe.closed, 1)
      }
    })
  }

// ---------------------------------------------------------------------------
// 部分重跑：回退只重置受影响阶段，已通过的结论留下来复用。
// ---------------------------------------------------------------------------

{
  const sid = 'sess-carry'
  const cwd = join(testRoot, sid)
  const cx = makeHost(cwd, sid)
  const act = (action, payload) => cx.request('/api/flowgate/action', { sessionId: sid, action, payload })
  const state = () => cx.request('/api/flowgate/state?sessionId=' + sid)
  const round = async (name, args, payload) => {
    const pending = cx.tool(name, args)
    await tick()
    const done = await act('gate', payload)
    assert.equal(done.status, 200, JSON.stringify(done.body))
    return pending
  }

  await cx.tool('flowgate_start', { title: '部分重跑', preset: 'fast' })
  const doc = cx.tool('flowgate_doc', {
    html: '<html><body><p>复用</p></body></html>',
    recommendedPreset: 'fast',
    reason: '验部分重跑',
    scope: {
      commands: [], files_expected_to_change: ['src/auth/session.ts'],
      capabilities: ['会话过期检测'],
      out_of_scope_explicitly: ['OAuth'],
      acceptance_criteria: [{ id: 'AC-1', when: '过期时', then: '返回 401' }],
    },
  })
  await tick()
  await act('doc', { decision: 'approve' })
  await doc

  await round('flowgate_gate', {}, { decision: 'pass' })
  await round('flowgate_review', {
    angles: [{ id: 'correctness', name: '正确性', verdict: 'pass', findings: [] }],
  }, { decision: 'pass' })

  // S4 点「退回开发修复」：只该重置 S2 及之后，评审结论存成可复用产物。
  const backGate = cx.tool('flowgate_gate', {})
  await tick()
  const back = await act('gate', { decision: 'back', to: 'S2' })
  await backGate
  const afterBack = await state()
  check('部分重跑：回退到 S2 后保留上一轮评审结论', () => {
    assert.equal(back.body.stage, 'S2')
    // 门禁不能提前可点，所以本轮 review 仍要清空；结论只活在 carryOver 里。
    assert.equal(afterBack.body.review, null)
    assert.ok(afterBack.body.carryOver)
    assert.equal(afterBack.body.carryOver.angles.length, 1)
    assert.equal(afterBack.body.carryOver.angles[0].id, 'correctness')
    assert.equal(afterBack.body.carryOver.angles[0].reusable, true)
  })

  // 重做 S2 后代码没再变：状态摘要要把可复用项点出来。
  await round('flowgate_gate', {}, { decision: 'pass' })
  const statusAfterRedo = await cx.tool('flowgate_status', {})
  check('部分重跑：状态摘要点名可复用的角度', () => {
    assert.match(statusAfterRedo.summary, /可复用/)
    assert.match(statusAfterRedo.summary, /correctness/)
    assert.match(statusAfterRedo.summary, /reusedAngles/)
  })

  // 直接传 reusedAngles：不重新评审，把上一轮结论并进来。
  const reuseReview = cx.tool('flowgate_review', { angles: [], reusedAngles: ['correctness'] })
  await tick()
  const reusePass = await act('gate', { decision: 'pass' })
  await reuseReview
  const afterReuse = await state()
  check('部分重跑：reusedAngles 直接复用上一轮角度结论', () => {
    assert.equal(reusePass.status, 200)
    assert.equal(afterReuse.body.review.angles.length, 1)
    assert.equal(afterReuse.body.review.angles[0].reused, true)
    assert.deepEqual(afterReuse.body.review.reused, ['correctness'])
    // 复用过的条目要从 carryOver 里摘掉，不能拿同一条结论再复用一次。
    assert.equal(afterReuse.body.carryOver, null)
  })

  // 环境受限的测试点必须写明原因，否则「排除」就是绕过验收的后门。
  let exclusionError = null
  try {
    await cx.tool('flowgate_test', {
      directions: [{ id: 'smoke', name: '冒烟验证', points: [{ point: '迁移后回滚可恢复', result: 'excluded' }] }],
    })
  } catch (error) {
    exclusionError = error
  }
  check('环境受限的测试点缺原因时被拒', () => {
    assert.match(String(exclusionError?.message), /必须用 excludeReason 写明环境限制原因/)
  })

  const excludedTest = cx.tool('flowgate_test', {
    directions: [{
      id: 'smoke',
      name: '冒烟验证',
      points: [
        { point: '超过 30 分钟未活动后请求返回 401', result: 'pass' },
        { point: '迁移后回滚可恢复', result: 'excluded', excludeReason: '沙箱没有数据库，无法执行迁移' },
      ],
    }],
  })
  await tick()
  const uncoveredGate = await act('gate', { decision: 'pass' })
  check('环境排除与缺失 AC 证据不能默认验收通过', () => {
    assert.equal(uncoveredGate.status, 409)
    assert.match(uncoveredGate.body.error, /acceptUncovered/)
  })
  const doneGate = await act('gate', { decision: 'pass', acceptUncovered: true, acceptanceNote: '环境受限项已确认，其余要点通过' })
  await excludedTest
  check('环境受限的点显式排除并单独计数', () => {
    assert.equal(doneGate.status, 200)
    assert.equal(doneGate.body.test.excluded, 1)
    assert.equal(doneGate.body.test.directions[0].points[1].result, 'excluded')
    assert.match(doneGate.body.test.directions[0].points[1].excludeReason, /沙箱/)
  })
}
}

// ---------------------------------------------------------------------------
// 需求原文是 S1 唯一的分析依据：类型写错时必须报错，不能静默当空串。
// 这条校验在 createFlow 里、不在 pre-execute 钩子上，所以要真的调工具。
// 放在最后单独起一个 host：currentService 是模块级单例，中途再 apply 会顶掉前面的实例。
// ---------------------------------------------------------------------------
{
  const cwd = join(testRoot, 'sess-typecheck')
  const typeCtx = makeHost(cwd, 'sess-typecheck')
  const startWith = (args) => typeCtx.tool('flowgate_start', args).catch((error) => error)
  const badBrief = await startWith({ title: '类型校验', brief: 12345 })
  // 整理稿参数已废弃：传进来也不会落进快照，需求依据只有 brief。
  const staleSummary = await startWith({ title: '类型校验', brief: '正常需求', summary: { a: 1 } })
  const staleState = await typeCtx.request('/api/flowgate/state?sessionId=sess-typecheck')
  check('需求原文的类型错误被拒绝，整理稿参数不再落进快照', () => {
    assert.match(String(badBrief?.message ?? badBrief), /需求原文必须是字符串/)
    // summary 已从 flowgate_start 的入参删掉：真传了也只当多余字段丢掉，
    // 流程照常启动，快照里只有 brief 原文这一份需求文本。
    assert.equal(staleSummary.stage, 'S1')
    assert.equal(staleState.body.brief, '正常需求')
    assert.equal('summary' in staleState.body, false)
  })
  await typeCtx.tool('flowgate_cancel', {})
}

// ---------------------------------------------------------------------------
// AC4 的 S1 那一半与 AC6 的冷恢复那一半：授权字段可以跨阶段存活，
// 但放行永远按阶段判定；冷恢复则一律清除，不静默继承。
// 放在最后单独起 host：currentService 是模块级单例，中途再 apply 会顶掉前面的实例。
// ---------------------------------------------------------------------------
{
  const grantCwd = mkdtempSync(join(tmpdir(), 'flowgate-s1-grant-'))
  try {
    const sx = makeHost(grantCwd, 'sess-s1-grant')
    await sx.tool('flowgate_start', { title: '回退到 S1 的授权口径', preset: 'fast' })
    const s1Doc = sx.tool('flowgate_doc', {
      html: '<html><body><p>回退授权</p></body></html>',
      scope: {
        commands: [], files_expected_to_change: ['src/s1.ts'],
        capabilities: ['改 s1.ts'],
        out_of_scope_explicitly: [],
        acceptance_criteria: [{ id: 'AC-1', when: '退回 S1', then: '变更性命令仍被拒' }],
      },
    })
    await tick()
    await sx.request('/api/flowgate/action', { sessionId: 'sess-s1-grant', action: 'doc', payload: { decision: 'approve' } })
    await s1Doc
    const s1Grant = await sx.request('/api/flowgate/action', { sessionId: 'sess-s1-grant', action: 'toggleShellGrant', payload: { enabled: true } })
    // S2 直接退回 S1：权限只来自冻结 scope 的清单，回退不该留下任何授权残留。
    const s1Back = await sx.request('/api/flowgate/action', { sessionId: 'sess-s1-grant', action: 'gate', payload: { decision: 'back', to: 'S1' } })
    const s1Shell = await sx.guard('bash', { command: 'npm run build' })
    check('AC4 退回 S1 后变更性 shell 仍被拒，且没有授权字段', () => {
      assert.equal(s1Grant.status, 409, '授权开关已退场，S1 里也不该存在')
      assert.equal(s1Back.body.stage, 'S1')
      assert.equal('shellGrant' in s1Back.body, false)
      assert.equal(s1Shell.kind, 'deny')
      assert.match(s1Shell.reason, /只允许只读 shell 命令/)
    })

    // AC6 冷恢复：快照里不会有授权字段，新宿主读出来的视图也不该凭空多出来。
    const cold = makeHost(grantCwd, 'sess-s1-grant')
    const coldState = await cold.request('/api/flowgate/state?sessionId=sess-s1-grant')
    check('AC6 结构完好的快照冷恢复后没有授权字段', () => {
      assert.equal(coldState.body.active, true)
      assert.equal(coldState.body.stage, 'S1')
      assert.equal('shellGrant' in coldState.body, false)
      assert.equal('writeGrants' in coldState.body, false)
    })
  } finally {
    rmSync(grantCwd, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// A 档纯解析命令 + scope 命令清单：这两条决定用户还要不要勾授权。
// 纯解析命令不执行仓库代码，任何阶段都放行；清单内的命令在 S1 批准 scope 时
// 一并过目，S2 / S4 直接放行，清单外的变更性命令仍走原来的开关。
// 放在最后单独起 host：currentService 是模块级单例，中途再 apply 会顶掉前面的实例。
// ---------------------------------------------------------------------------
{
  const cmdCwd = mkdtempSync(join(tmpdir(), 'flowgate-scope-cmd-'))
  try {
    const cx = makeHost(cmdCwd, 'sess-scope-cmd')
    const act = (action, payload) => cx.request('/api/flowgate/action', { sessionId: 'sess-scope-cmd', action, payload })
    await cx.tool('flowgate_start', { title: 'scope 命令清单', preset: 'fast' })

    const s1Parse = await cx.guard('bash', { command: 'node --check lib/index.js' })
    const s1Tsc = await cx.guard('bash', { command: 'tsc --noEmit -p tsconfig.json' })
    const s1Build = await cx.guard('bash', { command: 'npm run build' })
    const s1Sneak = await cx.guard('bash', { command: 'node --check a.js; rm -rf src' })
    check('A 档纯解析命令不需要授权就放行，夹带逃逸的照样拒', () => {
      assert.equal(s1Parse.kind, 'allow', JSON.stringify(s1Parse))
      assert.equal(s1Tsc.kind, 'deny', JSON.stringify(s1Tsc))
      assert.equal(s1Build.kind, 'deny')
      assert.equal(s1Sneak.kind, 'deny')
      assert.match(s1Sneak.reason, /任意代码|无法核对/)
    })
    // 只读白名单与纯解析不再只认 node：登记表里有哪个生态，就放行哪个生态的版本探测与语法检查。
    const multiVersion = await cx.guard('bash', { command: 'php --version' })
    const multiVersionPy = await cx.guard('bash', { command: 'python --version' })
    const multiWhich = await cx.guard('bash', { command: 'command -v php' })
    const multiLint = await cx.guard('bash', { command: 'php -l index.php' })
    const multiSyntax = await cx.guard('bash', { command: 'bash -n deploy.sh' })
    // 内联执行是任意代码执行：php -r 原来根本不在名单里，一路放行。
    const multiInline = await cx.guard('bash', { command: "php -r 'unlink(1);'" })
    const multiPwsh = await cx.guard('bash', { command: 'pwsh -Command Get-Item .' })
    check('版本探测与语法检查按生态放行，内联执行一律拒', () => {
      for (const item of [multiVersion, multiVersionPy, multiWhich, multiLint, multiSyntax]) {
        assert.equal(item.kind, 'allow', JSON.stringify(item))
      }
      for (const item of [multiInline, multiPwsh]) {
        assert.equal(item.kind, 'deny', JSON.stringify(item))
        assert.match(item.reason, /任意代码|无法核对/)
      }
    })

    const cmdHtml = '<html><body><p>命令清单</p></body></html>'
    const cmdScope = (commands) => ({
      files_expected_to_change: ['src/cmd.ts'],
      commands,
      capabilities: ['改 cmd.ts'],
      out_of_scope_explicitly: [],
      acceptance_criteria: [{ id: 'AC-1', when: '清单内命令', then: '不需要授权' }],
    })
    // 无效条目包括空、超长、含逃逸或换行、后缀含控制字符、超量。
    // 全部在提交时拒绝，不留待批准文档。
    for (const [commands, marker] of [
      [['   '], /空命令条目/],
      [['x'.repeat(400)], /超过 300 字/],
      [['node -e "process.exit(0)"'], /永远不会被放行/],
      // 换行是命令分隔符：一条条目里写两条命令，放行的永远只是第一行。
      [['npm run build\nrm -rf src'], /换行/],
      // 换行落在目录后缀前面也得拦：后缀正则的 `\s+\[` 会把那个换行当成空白吃掉，
      // 只按剥完后缀的 command 判，剥出来是单行的 `npm run build`，含换行的原文就安静存进清单了。
      [['npm run build\n[packages/web]'], /换行/],
      [['npm run build\r\n'], /换行/],
      // 后缀里的控制字符会拼出一个永远算不出来的目录名：commandDirKey 得到的是真实路径，
      // 带制表符的目录名和任何真实 cwd 都比不上——条目看着在清单里，执行侧永远拒。
      [['npm run build [a\tb]'], /目录后缀无效/],
      [Array.from({ length: 25 }, (_, index) => 'cmd-' + index), /超过上限 20 条/],
    ]) {
      await assert.rejects(cx.tool('flowgate_doc', { html: cmdHtml, scope: cmdScope(commands) }), marker)
    }
    const cmdRejected = await cx.request('/api/flowgate/state?sessionId=sess-scope-cmd')
    check('无法生效的命令条目在提交时就拒绝，不留待批准文档', () => {
      assert.equal(cmdRejected.body.stage, 'S1')
      assert.equal(cmdRejected.body.doc.pending, false)
    })
    const cmdDoc = cx.tool('flowgate_doc', {
      html: cmdHtml,
      scope: {
        files_expected_to_change: ['src/cmd.ts'],
        // 无效条目必须在 S1 就报错。原来空白与超长会被静默剔掉、`node -e *` 会被安静存下来：
        // 界面显示「已经授权」，实际每次都被逃逸检查拦掉，用户与 Agent 都以为放行过了。
        commands: ['  npm test  ', 'npm test', 'npm run *', 'node test/host.test.mjs'],
        capabilities: ['改 cmd.ts'],
        out_of_scope_explicitly: [],
        acceptance_criteria: [{ id: 'AC-1', when: '清单内命令', then: '不需要授权' }],
      },
    })
    await tick()
    const approvedCmd = await act('doc', { decision: 'approve' })
    await cmdDoc
    check('scope 命令清单规范化：去空、去重、保留原顺序', () => {
      assert.deepEqual(approvedCmd.body.scope.data.in_scope.commands, ['npm test', 'npm run *', 'node test/host.test.mjs'])
    })

    const listExact = await cx.guard('bash', { command: 'npm test' })
    const listWild = await cx.guard('bash', { command: 'npm run build' })
    const listMiss = await cx.guard('bash', { command: 'npm publish' })
    // 清单里写的是裸 node，机器上跑的是带盘符的 node.exe：这是同一条命令。
    // 不按解释器身份归一化，Agent 照抄 package.json 的 scripts 写清单，到 S2 就一条都放行不了。
    const listAbs = await cx.guard('bash', { command: '"' + process.execPath + '" test/host.test.mjs' })
    const listOther = await cx.guard('bash', { command: '"' + process.execPath + '" test/other.test.mjs' })
    const s2CmdState = await cx.request('/api/flowgate/state?sessionId=sess-scope-cmd')
    check('S2 清单内命令不需要开关就放行，清单外仍然拒', () => {
      assert.equal(s2CmdState.body.stage, 'S2')
      // 放行完全来自 scope 清单：视图里根本没有授权字段。
      assert.equal('shellGrant' in s2CmdState.body, false)
      assert.equal(listExact.kind, 'allow', JSON.stringify(listExact))
      assert.equal(listWild.kind, 'allow', JSON.stringify(listWild))
      assert.equal(listMiss.kind, 'deny')
      assert.match(listMiss.reason, /scope\.commands/)
      assert.match(listMiss.reason, /已记进待补清单/)
      // 同一条命令换个可执行体路径仍然算命中，参数不同就不算。
      assert.equal(listAbs.kind, 'allow', JSON.stringify(listAbs))
      assert.equal(listOther.kind, 'deny', JSON.stringify(listOther))
    })

    mkdirSync(join(cmdCwd, 'packages', 'web'), { recursive: true })
    const inside = await cx.guard('working_directory', { cd: 'packages/web' })
    const outside = await cx.guard('working_directory', { cd: tmpdir() })
    const query = await cx.guard('working_directory', {})
    check('AC-6 宿主守卫在 S2 按流程根核对换目录请求', () => {
      assert.equal(inside.kind, 'allow')
      assert.equal(outside.kind, 'deny')
      assert.equal(query.kind, 'allow')
    })
    await cx.guard('bash', { command: 'npm publish ' + 'a'.repeat(300) })
    const audit = readFileSync(join(cmdCwd, '.dsh-flowgate', 'flows.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((item) => item.type === 'shell.allowed' || item.type === 'shell.denied')
    check('每条 shell 判定都进审计流水，带命令原文与判定依据', () => {
      const allowed = audit.filter((item) => item.type === 'shell.allowed')
      const denied = audit.filter((item) => item.type === 'shell.denied')
      assert.ok(allowed.some((item) => item.detail.command === 'npm test' && item.detail.reason === 'scope 命令清单'))
      assert.ok(allowed.some((item) => item.detail.command === 'node --check lib/index.js' && item.detail.reason === '只读白名单'))
      assert.ok(denied.some((item) => item.detail.command === 'npm publish' && item.detail.outcome === 'denied'))
      // 逃逸命令单列 outcome：事后能分清是「不在白名单」还是「想拼出别的事」。
      assert.ok(audit.some((item) => item.detail.outcome === 'escape'))
      const clipped = audit.find((item) => item.detail.truncated === true)
      assert.ok(clipped, '超长命令必须标记 truncated')
      assert.equal(clipped.detail.command.length, 200)
    })
  } finally {
    rmSync(cmdCwd, { recursive: true, force: true })
  }
}

// 阶段闸门是唯一防线：清单是用户在 S1 批准的，但放行仍然只发生在 S2 / S4。
{
  const stageCwd = mkdtempSync(join(tmpdir(), 'flowgate-cmd-stage-'))
  try {
    mkdirSync(join(stageCwd, 'packages', 'web', 'sub'), { recursive: true })
    const flowOf = (stage, commands) => ({
      id: 'f_cmd_stage',
      sessionId: 'sess_cmd_stage',
      cwd: stageCwd,
      finished: false,
      stage,
      events: [],
      scope: { frozen: true, data: { in_scope: { files_expected_to_change: ['src/a.ts'], commands, capabilities: [] } } },
    })
    const s1 = flowOf('S1', ['npm test'])
    const s3 = flowOf('S3', ['npm test', 'npm run *'])
    const s4 = flowOf('S4', ['npm test', 'npm run *'])
    check('清单命中只在 S2 / S4 放行，S1 与 S3 照样拒', () => {
      assert.ok(shellDenial(s1, { command: 'npm test' }), 'S1 不该被清单放过')
      assert.ok(shellDenial(s3, { command: 'npm test' }), 'S3 不该被清单放过')
      assert.equal(shellDenial(s4, { command: 'npm test' }), null)
      assert.equal(shellDenial(s4, { command: 'npm run build' }), null)
    })
    check('前缀通配只认开头，空白条目不会放行任何命令', () => {
      assert.ok(shellDenial(s4, { command: 'docker npm run build' }))
      assert.ok(shellDenial(flowOf('S4', ['   ']), { command: 'npm test' }))
    })
    // 收尾写法不换执行体、不写盘：卡住它们只会让已授权的测试命令永远跑不了。
    check('无害输出后缀不算逃逸，剥掉后缀后仍按原命令判定', () => {
      assert.equal(shellDenial(s4, { command: 'npm test 2>&1' }), null)
      assert.equal(shellDenial(s4, { command: 'npm test | tail -n 20' }), null)
      assert.equal(shellDenial(s4, { command: 'npm test > /dev/null' }), null)
      assert.ok(shellDenial(s4, { command: 'npm publish 2>&1' }), '换了命令体照样拒')
      assert.ok(shellDenial(s4, { command: 'npm test | rm -rf src' }), '管道接写命令照样拒')
      assert.ok(shellDenial(s4, { command: 'npm test 2>&1; touch x' }), '分号拼接照样拒')
    })
    // AC-1：换行与 `;` 一样是命令分隔符。判定必须在入口就拦下，不能等清单匹配——
    // 清单匹配看到的只是第一行，放行它等于「审查前半句、执行全部」。
    check('AC-1 含换行的命令在任何阶段都被拒，理由指认换行', () => {
      for (const stage of ['S1', 'S2', 'S3', 'S4']) {
        const denial = shellDenial(flowOf(stage, ['npm test']), { command: 'pwd\nrm -rf src' })
        assert.ok(denial, stage + ' 不该放过多行命令')
        assert.match(denial, /多行.*换行/)
        for (const command of ['\npwd', 'pwd\r\n', '\n']) {
          assert.match(shellDenial(flowOf(stage, []), { command }), /多行.*换行/)
        }
      }
      // 清单里原样写着这条也不行：入口断言先于清单匹配。
      const listed = flowOf('S2', ['npm run build\nrm -rf src'])
      assert.ok(shellDenial(listed, { command: 'npm run build\nrm -rf src' }))
      // 单独的 \r 同样是分隔符：只加 \n 会留下 CR 这条缝。
      assert.ok(shellDenial(flowOf('S2', ['npm test']), { command: 'npm test\rrm -rf src' }))
    })
    // AC-2：条目带目录后缀时，剥掉后缀剩下的命令仍然按前缀通配匹配。
    check('AC-2 带目录后缀的条目剥掉后缀后仍按前缀通配', () => {
      assert.equal(shellDenial(flowOf('S2', ['npm run *']), { command: 'npm run build' }), null)
      const listed = flowOf('S2', ['npm run * [packages/web]'])
      const dir = join(stageCwd, 'packages', 'web')
      assert.equal(shellDenial(listed, { command: 'npm run build' }, dir), null)
      assert.ok(shellDenial(listed, { command: 'npm run build' }), '流程根不在授权目录内')
      assert.ok(shellDenial(listed, { command: 'npm publish' }, dir), '前缀不符照样拒')
    })
    // AC-4：不带目录后缀的条目只认流程根。子目录里同名的 build 脚本做的是另一件事。
    check('AC-4 不带目录后缀的条目只在流程根放行', () => {
      const listed = flowOf('S2', ['npm run build'])
      assert.equal(shellDenial(listed, { command: 'npm run build' }), null)
      assert.equal(shellDenial(listed, { command: 'npm run build' }, stageCwd), null)
      assert.match(shellDenial(listed, { command: 'npm run build' }, join(stageCwd, 'packages', 'web')), /执行目录：packages\/web/)
    })
    // AC-5：带 [packages/web] 的条目只在那一个目录精确匹配，父子目录都不算。
    check('AC-5 带 [packages/web] 的条目只在该目录精确匹配', () => {
      const listed = flowOf('S2', ['npm run build [packages/web]'])
      const dir = join(stageCwd, 'packages', 'web')
      assert.equal(shellDenial(listed, { command: 'npm run build' }, dir), null)
      assert.ok(shellDenial(listed, { command: 'npm run build' }, join(dir, 'sub')), '子目录要另写一条')
      assert.ok(shellDenial(listed, { command: 'npm run build' }, join(stageCwd, 'packages')), '父目录不匹配')
      assert.ok(shellDenial(listed, { command: 'npm run build' }, tmpdir()), '流程根之外')
    })
    // AC-4 / AC-7：`ops_bash({ command, workdir })` 里的 workdir 才是真正决定跑哪个程序的东西。
    // 只看会话 header.cwd 等于把目录绑定交回给调用方：header.cwd 在流程根、命令却带 workdir
    // 指向子目录时，必须在子目录上判定，否则「授权不绑目录」从 workdir 这个入口原样漏回来。
    check('AC-4 workdir 参数同样决定执行目录，不能用它绕过目录后缀', () => {
      const listed = flowOf('S2', ['npm run build'])
      assert.equal(shellDenial(listed, { command: 'npm run build', workdir: '.' }), null)
      assert.equal(shellDenial(listed, { command: 'npm run build', workdir: stageCwd }), null)
      assert.ok(shellDenial(listed, { command: 'npm run build', workdir: join(stageCwd, 'packages', 'web') }), '带 workdir 换到子目录必须按子目录判定')
      assert.ok(shellDenial(listed, { command: 'npm run build', workdir: 'packages/web' }), '相对 workdir 一样')
      // 审计流水要能自己说清「到底在哪儿跑的」：只记相对流程根的 dir，事后还得翻流程快照里的
      // flow.cwd 才能还原，所以 detail 同时记 dir 与绝对路径 cwd——这里两条一起断言。
      const audited = listed.events.filter((event) => event.type === 'shell.denied' && event.detail?.command === 'npm run build')
      assert.equal(audited.at(-1).detail.dir, 'packages/web', '审计要记 workdir 决定的执行目录')
      assert.equal(audited.at(-1).detail.cwd, join(stageCwd, 'packages', 'web'), '审计还要记绝对路径，流水才自足')
      assert.ok(shellDenial(listed, { command: 'npm run build', workdir: tmpdir() }), '流程根之外更不行')
      // 反过来：条目声明了子目录，只带 workdir 不带 cwd 也要命中；不带 workdir 就是流程根。
      const scoped = flowOf('S2', ['npm run build [packages/web]'])
      assert.equal(shellDenial(scoped, { command: 'npm run build', workdir: join(stageCwd, 'packages', 'web') }), null)
      assert.ok(shellDenial(scoped, { command: 'npm run build' }), '不带 workdir 就是流程根，不该命中子目录条目')
    })
    // AC-6：working_directory 会改掉后面所有命令的执行位置，S2 / S4 必须留在流程根之内。
    check('AC-6 S2 / S4 的 working_directory 只能在流程根之内换目录', () => {
      for (const stage of ['S2', 'S4']) {
        const flow = flowOf(stage, [])
        assert.equal(scopeDenial(flow, 'working_directory', {}), null, stage + '：不带 cd 只查看当前目录')
        assert.equal(scopeDenial(flow, 'working_directory', { cd: join(stageCwd, 'packages') }), null, stage + '：绝对子目录')
        assert.equal(scopeDenial(flow, 'working_directory', { cd: 'packages/web' }), null, stage + '：相对子目录')
        assert.ok(scopeDenial(flow, 'working_directory', { cd: tmpdir() }), stage + '：根外必须拒')
        assert.ok(scopeDenial(flow, 'working_directory', { cd: '..' }), stage + '：父目录必须拒')
        assert.ok(scopeDenial(flow, 'working_directory', { cd: '   ' }), stage + '：空目标必须拒')
        assert.match(scopeDenial(flow, 'working_directory', { cd: 'packages/missing' }), /无法确认执行目录/)
      }
      // S1 / S3 本来就不放行变更性命令：换目录在那里不构成新的授权通道，维持原样。
      for (const stage of ['S1', 'S3']) {
        assert.equal(scopeDenial(flowOf(stage, []), 'working_directory', { cd: tmpdir() }), null, stage)
      }
    })
    check('AC-5 / AC-6 按实际目录拒绝不一致的目录别名', () => {
      const alias = join(stageCwd, 'packages', 'alias')
      fs.symlinkSync(join(stageCwd, 'packages', 'web'), alias, process.platform === 'win32' ? 'junction' : 'dir')
      try {
        for (const stage of ['S2', 'S4']) {
          const flow = flowOf(stage, ['npm run build [packages/alias]'])
          assert.match(scopeDenial(flow, 'working_directory', { cd: alias }), /实际位置与请求的路径不一致/)
          assert.match(shellDenial(flow, { command: 'npm run build', workdir: alias }), /实际位置与请求的路径不一致/)
          assert.equal(flow.events.at(-1).detail.cwd, fs.realpathSync.native(join(stageCwd, 'packages', 'web')))
        }
      } finally {
        if (process.platform === 'win32') fs.rmdirSync(alias)
        else fs.unlinkSync(alias)
      }
    })
    // 只读豁免：插件不认识的工具默认拒，用户声明后放行。写工具与 shell 不接受这种豁免。
    check('未登记工具默认拒，用户声明只读后放行', () => {
      const base = flowOf('S2', ['npm test'])
      assert.match(scopeDenial(base, 'unlag_refresh', {}), /只读登记表/)
      assert.equal(scopeDenial({ ...base, toolAllowlist: ['unlag_refresh'] }, 'unlag_refresh', {}), null)
      // 写工具仍然按 scope 判：S2 里写 scope 内的文件本来就允许，写 scope 外照样拒。
      assert.equal(scopeDenial({ ...base, toolAllowlist: ['write'] }, 'write', { file_path: 'src/a.ts' }), null)
      assert.ok(scopeDenial({ ...base, toolAllowlist: ['write'] }, 'write', { file_path: 'src/b.ts' }))
      assert.ok(scopeDenial({ ...flowOf('S1', []), toolAllowlist: ['str_replace_editor'] }, 'str_replace_editor', { path: 'src/a.ts' }))
      assert.ok(scopeDenial({ ...base, toolAllowlist: ['ops_bash'] }, 'ops_bash', { command: 'npm publish' }))
    })
  } finally {
    rmSync(stageCwd, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// S1 冻结前的验收方案体检：AC 声明集成验收、验证步骤点名跨模块夹具，而 scope 只列了
// 主机测试文件与命令——这是「scope 与验证方法不相容」里唯一能静态抓到的一类。
// 必须批准前摊开缺口清单并明确接受；补全 scope 后要能正常推进，S4 仍按方法核验。
// 放在最后单独起 host：currentService 是模块级单例，中途再 apply 会顶掉前面的实例。
// ---------------------------------------------------------------------------
{
  const riskCwd = mkdtempSync(join(tmpdir(), 'flowgate-scope-risk-'))
  try {
    const rx = makeHost(riskCwd, 'sess-scope-risk')
    const act = (action, payload) => rx.request('/api/flowgate/action', { sessionId: 'sess-scope-risk', action, payload })
    await rx.tool('flowgate_start', { title: '验收方案缺口', preset: 'fast' })
    const riskHtml = '<html><body><p>缺口</p></body></html>'
    const riskScope = (extraFiles) => ({
      files_expected_to_change: ['test/host.test.mjs', ...(extraFiles || [])],
      commands: ['node test/host.test.mjs'],
      capabilities: ['补集成测试'],
      out_of_scope_explicitly: [],
      acceptance_criteria: [{
        id: 'AC-1',
        when: '跨模块联动',
        then: '夹具一起跑通',
        verification: { method: 'integration', procedure: '先改 test/fixtures/session.ts，再运行集成用例' },
      }],
    })
    // 带缺口的提交一定会抛错：把错误文案当返回值取出来，用例才好断言它说了什么。
    const rejected = async (scope) => {
      try {
        await rx.tool('flowgate_doc', { html: riskHtml, scope })
      } catch (error) {
        return String(error?.message ?? error)
      }
      throw new Error('这份 scope 有缺口，本应被退回，却提交成功了')
    }

    const firstError = await rejected(riskScope())
    const firstState = await rx.request('/api/flowgate/state?sessionId=sess-scope-risk')
    check('提交时就体检出验收方案缺口，直接退回，不摆到批准按钮前', () => {
      assert.match(firstError, /验收方案缺口/)
      assert.match(firstError, /提交被退回（第 1\/3 次）/)
      assert.match(firstError, /test\/fixtures\/session\.ts/)
      assert.match(firstError, /不要让用户来接受这些缺口/)
      assert.equal(firstState.body.doc.pending, false, '带缺口的草稿不进待批准状态')
      assert.deepEqual(firstState.body.doc.pendingScopeRisks, [])
      assert.equal(firstState.body.doc.scopeRiskStrikes.count, 1)
      assert.equal(firstState.body.doc.scopeRiskLast[0].code, 'procedure-file-outside-scope')
      assert.deepEqual(firstState.body.doc.scopeRiskLast[0].acs, ['AC-1'])
    })

    const secondError = await rejected(riskScope())
    const secondState = await rx.request('/api/flowgate/state?sessionId=sess-scope-risk')
    check('同一批缺口再交一次，计数累加并预告下一次就结束', () => {
      assert.match(secondError, /第 2\/3 次/)
      assert.match(secondError, /同一批缺口再出现一次，这条流程会被自动结束/)
      assert.equal(secondState.body.doc.scopeRiskStrikes.count, 2)
    })

    // 补全 scope 后应能正常推进：把夹具补进白名单，缺口消失。
    const fixedDoc = rx.tool('flowgate_doc', { html: riskHtml, scope: riskScope(['test/fixtures/session.ts']) })
    await tick()
    const fixedState = await rx.request('/api/flowgate/state?sessionId=sess-scope-risk')
    const fixedOk = await act('doc', { decision: 'approve' })
    await fixedDoc
    check('补全 scope 后缺口消失，不需要接受例外就能冻结', () => {
      assert.deepEqual(fixedState.body.doc.pendingScopeRisks, [])
      assert.deepEqual(fixedState.body.doc.scopeRiskLast, [], '补齐后不再留着上一轮的缺口')
      assert.equal(fixedState.body.doc.scopeRiskStrikes, null)
      assert.equal(fixedOk.status, 200)
      assert.equal(fixedOk.body.stage, 'S2')
      assert.equal(fixedOk.body.scope.data.scope_risks, undefined)
    })

    // 缺口补掉之后再退回补命令，重算结果应当仍是「没有缺口」：
    // 重算不是「一律报缺口」，它只是让结论跟着当前清单走。
    // 先让这条命令真的被拒一次：待补队列只收实际拒绝过的命令，
    // 「随手加一条进清单」的入口已经不存在了。
    await rx.guard('bash', { command: 'npm test' })
    await act('reopenScopeForCommands', {})
    const cleanState = await rx.request('/api/flowgate/state?sessionId=sess-scope-risk')
    check('缺口补掉后补命令，重算不会凭空造出缺口', () => {
      assert.deepEqual(cleanState.body.doc.pendingScopeRisks, [])
      assert.ok(cleanState.body.doc.pendingScope.commands.includes('npm test'))
    })
    // 退回 S1 后文档还挂着门禁，收尾：此时没有缺口，直接放行。
    await act('doc', { decision: 'approve' })
  } finally {
    rmSync(riskCwd, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 同一批缺口连交三次：不是 Agent 不努力，是这条路走不通。
// 让它结束，比让同一份 scope 在人和 Agent 之间再抛三个来回更诚实。
// ---------------------------------------------------------------------------
{
  const strikeCwd = mkdtempSync(join(tmpdir(), 'flowgate-scope-strike-'))
  try {
    const sx = makeHost(strikeCwd, 'sess-scope-strike')
    await sx.tool('flowgate_start', { title: '缺口三振', preset: 'fast' })
    const strikeScope = {
      files_expected_to_change: ['test/host.test.mjs'],
      commands: ['node test/host.test.mjs'],
      capabilities: ['补集成测试'],
      out_of_scope_explicitly: [],
      acceptance_criteria: [{
        id: 'AC-1',
        when: '跨模块联动',
        then: '夹具一起跑通',
        verification: { method: 'integration', procedure: '先改 test/fixtures/session.ts，再运行集成用例' },
      }],
    }
    const messages = []
    for (let round = 0; round < 3; round += 1) {
      try {
        await sx.tool('flowgate_doc', { html: '<html><body><p>缺口</p></body></html>', scope: strikeScope })
        messages.push('')
      } catch (error) {
        messages.push(String(error?.message ?? error))
      }
    }
    const strikeState = await sx.request('/api/flowgate/state?sessionId=sess-scope-strike')
    check('同一批缺口连交三次，流程自动结束并说清原因', () => {
      assert.match(messages[0], /第 1\/3 次/)
      assert.match(messages[1], /第 2\/3 次/)
      assert.match(messages[2], /连续 3 次没能补齐，这条流程已自动结束/)
      assert.equal(strikeState.body.finished, true)
      assert.match(String(strikeState.body.cancelReason ?? ''), /scope 缺口/)
      assert.deepEqual(strikeState.body.doc.scopeRiskLast, [], '结束的流程不再留待办缺口')
      assert.equal(strikeState.body.doc.scopeRiskStrikes, null)
    })
  } finally {
    rmSync(strikeCwd, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 评审归属口径与完整计数：只有挂在冻结 scope 的验收标准上、且落在 scope 文件内的
// 非 MINOR 发现才进重做清单；对不上的降级成建议。fast 档同样保留完整发现。
// 放在最后单独起 host：currentService 是模块级单例，中途再 apply 会顶掉前面的实例。
// ---------------------------------------------------------------------------
{
  const gateCwd = mkdtempSync(join(tmpdir(), 'flowgate-finding-gate-'))
  try {
    const px = makeHost(gateCwd, 'sess-finding-gate')
    const act = (action, payload) => px.request('/api/flowgate/action', { sessionId: 'sess-finding-gate', action, payload })
    await px.tool('flowgate_start', { title: '评审归属口径', preset: 'fast' })
    const doc = px.tool('flowgate_doc', {
      html: '<html><body><p>归属口径</p></body></html>',
      scope: {
        commands: [], files_expected_to_change: ['src/gate.ts'],
        capabilities: ['改 gate.ts'],
        out_of_scope_explicitly: [],
        acceptance_criteria: [{ id: 'AC-1', when: '并发调用', then: '只刷新一次令牌' }],
        shared_contracts: ['src/gate.ts 导出的 gate(x) 签名不变'],
      },
    })
    await tick()
    const s1State = await px.request('/api/flowgate/state?sessionId=sess-finding-gate')
    check('影响面随 scope 一起进待批准清单', () => {
      assert.deepEqual(s1State.body.doc.pendingScope.shared_contracts, ['src/gate.ts 导出的 gate(x) 签名不变'])
    })
    await act('doc', { decision: 'approve' })
    await doc
    const frozenScope = JSON.parse(readFileSync(join(gateCwd, '.dsh-flowgate', 'scope.json'), 'utf8'))
    const s2Status = await px.tool('flowgate_status', {})
    check('影响面冻结进 scope.json 并写进状态摘要', () => {
      assert.deepEqual(frozenScope.in_scope.shared_contracts, ['src/gate.ts 导出的 gate(x) 签名不变'])
      assert.match(s2Status.summary, /本次会动的共用契约与已知约束/)
      assert.match(s2Status.summary, /gate\(x\) 签名不变/)
    })

    const dev = px.tool('flowgate_gate', {})
    await tick()
    await act('gate', { decision: 'pass' })
    await dev
    // 发现要带能对上的证据：先把它们说的文件写出来，否则全部按未核实降级。
    mkdirSync(join(gateCwd, 'src'), { recursive: true })
    writeFileSync(join(gateCwd, 'src', 'gate.ts'), [
      'export const gate = (x) => x',
      'export const refresh = (token) => token',
      'export const lock = new Set()',
      'export const pending = new Map()',
      'export const retry = () => {}',
      'export const backoff = 0',
      'export const jitter = 0',
      'export const queued = []',
      'export const flushed = false',
      'export const metrics = {}',
    ].join('\n') + '\n')
    writeFileSync(join(gateCwd, 'src', 'other.ts'), 'export const legacy = true\nexport const old = true\nexport const deprecated = true\n')
    const review = px.tool('flowgate_review', {
      angles: [{
        id: 'correctness',
        name: '正确性',
        verdict: 'blocking',
        findings: [
          reviewFinding({ file: 'src/gate.ts', line: 1, severity: 'MAJOR', ac: 'AC-1', summary: '并发时可能重复刷新', evidence: 'gate' }),
          reviewFinding({ file: 'src/gate.ts', line: 2, severity: 'CRITICAL', summary: '没挂验收标准的发现', evidence: 'refresh', ac: undefined }),
          reviewFinding({ file: 'src/other.ts', line: 3, severity: 'MAJOR', ac: 'AC-1', summary: '落在 scope 之外', evidence: 'legacy' }),
          reviewFinding({ file: 'src/gate.ts', line: 4, severity: 'MAJOR', ac: 'AC-9', summary: '验收标准 id 不存在', evidence: 'lock' }),
          reviewFinding({ file: 'src/gate.ts', line: 5, severity: 'MINOR', ac: 'AC-1', summary: '只是建议', evidence: 'pending' }),
          ...Array.from({ length: 4 }, (_, index) => reviewFinding({ file: 'src/gate.ts', line: 6 + index, severity: 'MINOR', ac: 'AC-1', summary: '额外建议 ' + index, evidence: ['retry', 'backoff', 'jitter', 'queued'][index] })),
        ],
      }],
    })
    await tick()
    const reviewState = await px.request('/api/flowgate/state?sessionId=sess-finding-gate')
    const reported = reviewState.body.review
    const kept = reported.angles[0].findings
    check('fast 档保留完整发现与超过 3 条的 MINOR 计数，不用摘要冒充发现', () => {
      assert.equal(kept.length, 9)
      assert.deepEqual(reported.counts, { total: 9, critical: 1, major: 3, minor: 5, blocking: 1, advisories: 8, unscoped: 3, unverified: 0, unverifiedSevere: 0 })
      assert.equal(kept.filter((finding) => finding.severity === 'MINOR').length, 5)
      assert.ok(kept.every((finding) => !/另有.*未列出/.test(finding.summary)))
    })
    check('只有挂在验收标准上且在 scope 文件内的发现进重做清单', () => {
      assert.equal(reported.blocking, 1)
      assert.equal(reported.advisories, 8)
      assert.equal(kept[0].acMatched, false)
      assert.equal(kept[0].blocking, false)
      assert.equal(kept[1].acMatched, true)
      assert.equal(kept[1].fileInScope, true)
      assert.equal(kept[1].blocking, true)
      assert.equal(kept[2].fileInScope, false)
      assert.equal(kept[2].blocking, false)
    })
    check('scope 外的发现单独回报给界面', () => {
      assert.equal(reviewState.body.reviewOutsideScope.length, 1)
      assert.equal(reviewState.body.reviewOutsideScope[0].file, 'src/other.ts')
    })
    const returned = await act('gate', { decision: 'back', to: 'S2', note: '先补 AC-1 并发复现，再修复重复刷新' })
    const reviewResult = await review
    check('退回时保留用户 note 和按 AC 的修复清单，MINOR 与范围外发现仍作建议', () => {
      assert.equal(returned.status, 200)
      assert.equal(reviewResult.decision, 'reject')
      assert.match(reviewResult.message, /另有 8 条非阻塞发现/)
      assert.match(reviewResult.message, /先补 AC-1 并发复现，再修复重复刷新/)
      assert.match(reviewResult.message, /退回修复清单（按 AC）/)
      assert.equal(returned.body.remediation.note, '先补 AC-1 并发复现，再修复重复刷新')
      assert.ok(returned.body.remediation.items.some((item) => item.ac === 'AC-1' && item.source === 'review' && item.summary === '并发时可能重复刷新'))
      assert.ok(returned.body.remediation.items.some((item) => item.ac === 'AC-1' && item.source === 'acceptance'))
      assert.ok(returned.body.remediation.items.every((item) => item.ac === 'AC-1'))
      assert.equal(returned.body.remediation.advisories.length, 8)
    })
    const indexSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    check('评审子代理的提示里带上冻结 scope 的影响面与验收标准', () => {
      assert.match(indexSource, /in_scope\.shared_contracts 就是本次允许触及的影响面/)
      assert.match(indexSource, /'验收标准：' \+ JSON\.stringify\(scope\.acceptance_criteria/)
    })
  } finally {
    rmSync(gateCwd, { recursive: true, force: true })
  }
}

// 工作区提示与启动限制共用同一条活动流程，冷恢复后也必须成立。
{
  const ws = mkdtempSync(join(tmpdir(), 'flowgate-共享 工作区-'))
  const services = { sessions: { get: (id) => ({ header: { id, cwd: id === 'nested' ? join(ws, 'nested') : id === 'outside' ? join(ws, '..', 'other-workspace') : id === 'case-alias' ? ws.toUpperCase() : ws } }) } }
  const state = (host, id) => host.request('/api/flowgate/state?sessionId=' + id)
  try {
    const first = makeHost(ws, 'owner', { services })
    assert.equal((await state(first, 'sibling')).body.workspace.flow, null)
    await first.tool('flowgate_start', { title: '共享提示' })
    const shared = (await state(first, 'sibling')).body
    check('同工作区无流程会话也读取活动流程的阶段摘要', () => {
      assert.equal(shared.active, false)
      assert.equal(shared.workspace.active, true)
      assert.equal(shared.workspace.flow.sessionId, 'owner')
      assert.equal(shared.workspace.flow.stage, 'S1')
      assert.equal(shared.workspace.flow.stageIndex, 0)
    })
    if (process.platform === 'win32') {
      const alias = (await state(first, 'case-alias')).body.workspace
      const rejected = await first.request('/api/flowgate/action', { sessionId: 'case-alias', action: 'start', payload: { title: '不得替换原流程' } })
      const owner = (await state(first, 'owner')).body
      check('Windows 工作区路径仅大小写不同时共享提示并拒绝第二条，原流程保持不变', () => {
        assert.equal(alias.flow.sessionId, 'owner')
        assert.equal(rejected.status, 409)
        assert.match(rejected.body.error, /已有流程在进行.*先结束或放弃/)
        assert.equal(owner.title, '共享提示')
        assert.equal(owner.workspace.flow.sessionId, 'owner')
        assert.equal(owner.stage, 'S1')
      })
    }
    const nested = (await state(first, 'nested')).body.workspace
    const outside = (await state(first, 'outside')).body.workspace
    check('工作区精确隔离，子目录和相邻工作区不显示父工作区提示', () => {
      assert.equal(nested.flow, null)
      assert.equal(outside.flow, null)
    })
    const restored = makeHost(ws, 'owner', { services })
    const cold = await state(restored, 'sibling')
    const duplicate = await restored.request('/api/flowgate/action', { sessionId: 'sibling', action: 'start', payload: {} })
    check('宿主冷恢复后其他会话仍显示活动流程并拒绝第二条流程', () => {
      assert.equal(cold.body.workspace.flow.sessionId, 'owner')
      assert.equal(duplicate.status, 409)
      assert.match(duplicate.body.error, /已有流程在进行.*先结束或放弃/)
    })
    await restored.tool('flowgate_cancel', {})
    assert.equal((await state(restored, 'sibling')).body.workspace.flow, null)
    const next = await restored.request('/api/flowgate/action', { sessionId: 'sibling', action: 'start', payload: {} })
    const history = (await state(restored, 'owner')).body
    check('放弃后可启动新流程，历史会话的结束状态不遮住工作区活动摘要', () => {
      assert.equal(next.status, 200)
      assert.equal(history.cancelled, true)
      assert.equal(history.workspace.flow.sessionId, 'sibling')
    })
    await restored.request('/api/flowgate/action', { sessionId: 'sibling', action: 'cancel', payload: {} })
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 内容、规则与执行证据必须通过真实宿主工具与 HTTP 门禁串起来，不能只测纯函数。
// ---------------------------------------------------------------------------
async function provenanceFixture(label) {
  const ws = mkdtempSync(join(tmpdir(), 'flowgate-provenance-' + label + '-'))
  const sid = 'provenance-' + label
  mkdirSync(join(ws, 'src'))
  writeFileSync(join(ws, 'src/session.mjs'), 'export const response = (expired) => expired ? 401 : 200\n')
  writeFileSync(join(ws, 'src/helper.mjs'), 'export const unchanged = true\n')
  const px = makeHost(ws, sid)
  px.shell.run = async () => ({
    exitCode: 0, signal: null, timedOut: false, aborted: false,
    stdout: { text: ' M src/session.mjs\n M src/helper.mjs\n---numstat---\n1\t1\tsrc/session.mjs\n1\t1\tsrc/helper.mjs\n', truncated: false },
    stderr: { text: '', truncated: false },
  })
  const act = (action, payload) => px.request('/api/flowgate/action', { sessionId: sid, action, payload })
  const state = async () => (await px.request('/api/flowgate/state?sessionId=' + sid)).body
  const round = async (name, args, payload) => {
    const pending = px.tool(name, args)
    await tick()
    const result = await act('gate', payload)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    await pending
    return result
  }
  const angles = ['correctness', 'safety'].map((id) => ({ id, name: id, verdict: 'pass', findings: [] }))
  const directions = ['smoke', 'regression'].map((id) => ({ id, name: id, points: [{ point: '过期请求返回 401', result: 'pass' }] }))
  await px.tool('flowgate_start', { title: label, preset: 'fast' })
  const doc = px.tool('flowgate_doc', {
    html: '<html><body><p>按内容与执行证据验收</p></body></html>',
    scope: {
      // 验收方案体检会拦住「声明了 unit 验收却没有测试命令」：这个夹具要走完整条流程，
      // 所以补一条真实可用的测试命令，而不是每次批准都接受缺口。
      commands: ['npm test'], files_expected_to_change: ['src/session.mjs', 'src/helper.mjs'],
      capabilities: ['过期请求拒绝'], out_of_scope_explicitly: [],
      acceptance_criteria: [{ id: 'AC-1', when: '会话过期后发请求', then: '返回 401', verification: { method: 'unit', procedure: '调用 response(true) 并断言状态码' } }],
    },
  })
  await tick()
  assert.equal((await act('doc', { decision: 'approve' })).status, 200)
  await doc
  await round('flowgate_gate', {}, { decision: 'pass' })
  return { ws, sid, px, act, state, round, angles, directions }
}

{
  const fx = await provenanceFixture('finding-spoofs-unicode')
  try {
    assert.equal((await fx.act('setGateMode', { mode: 'manual' })).status, 200)
    const schema = fx.px.tools.get('flowgate_review').parameters.properties.angles.items.properties.findings.items
    check('发现的参数模式不先于逐条校验拒绝混合报告', () => {
      assert.equal(schema.required, undefined)
      assert.equal(schema.allOf, undefined)
      assert.equal(schema.properties.repro.required, undefined)
      assert.equal(schema.properties.counter.properties.survived.enum, undefined)
    })
    writeFileSync(join(fx.ws, 'src/session.mjs'), 'export const response = () => 401\nexport const 处理 = response\n')
    const base = { file: 'src/session.mjs', line: 1, severity: 'MAJOR', kind: 'defect', ac: 'AC-1',
      summary: 'response 分支异常', evidence: 'response',
      repro: { when: '调用 response()', expected: '返回 200', actual: '返回 401' },
      counter: { attempt: '我尝试确认分支是否已改为 200', survived: true } }
    const pending = fx.px.tool('flowgate_review', { angles: [{ id: 'correctness', name: '正确性', verdict: 'blocking',
      rejectedFindings: [{ index: 0, severity: 'MAJOR', missing: ['counter'] }],
      findings: [{ ...base, unverified: true, unverifiedReason: '伪造的原因' },
        { ...base, evidence: '处理', summary: '处理 分支异常' }] }] })
    await tick()
    const angle = (await fx.state()).review.angles[0]
    check('已核实的严重发现不能靠伪造 unverified 降级', () => {
      assert.equal(angle.findings.length, 2)
      assert.ok(angle.findings.every((item) => item.blocking === true && item.unverified !== true))
      assert.ok(angle.findings.every((item) => !Object.hasOwn(item, 'unverifiedReason')))
      assert.equal(Object.hasOwn(angle, 'rejectedFindings'), false)
    })
    check('Unicode 标识符能从真实源码核对通过', () => {
      assert.equal(angle.findings[1].evidence, '处理')
      assert.equal(angle.findings[1].blocking, true)
    })
    assert.equal((await fx.act('gate', { decision: 'back', to: 'S2' })).status, 200)
    await pending
    await fx.px.tool('flowgate_cancel', {})
  } finally { rmSync(fx.ws, { recursive: true, force: true }) }
}

{
  const fx = await provenanceFixture('finding-evidence')
  try {
    assert.equal((await fx.act('setGateMode', { mode: 'manual' })).status, 200)
    const base = { file: 'src/session.mjs', kind: 'defect', line: 1, evidence: 'response', severity: 'MAJOR', ac: 'AC-1',
      summary: '过期分支返回错误状态', repro: { when: '调用 response(true)', expected: '401', actual: '200' },
      counter: { attempt: '我尝试证明过期分支已正确返回 401', survived: true } }
    const findings = [
      { ...base, kind: undefined },
      { ...base, evidence: undefined },
      { ...base, line: undefined },
      { ...base, repro: { when: '调用 response(true)', expected: '401', actual: '401' } },
      { ...base, counter: { attempt: '自我反驳', survived: false } },
      { ...base, evidence: 'a'.repeat(65) },
      { ...base, kind: 'design', basis: undefined },
      { ...base, evidence: 'notInSource' },
      { ...base, kind: 'design', evidence: 'response', basis: { quote: '不存在的一行', conflict: '违反过期约定' } },
      { ...base, line: 999 },
      { ...base, severity: 'MINOR', counter: undefined },
    ]
    const pending = fx.px.tool('flowgate_review', { angles: [{ id: 'correctness', name: '正确性', verdict: 'advisory', findings }] })
    await tick()
    const view = await fx.state()
    check('缺字段逐条丢弃并保留安全的索引和缺项，不泄漏原文', () => {
      const rejected = view.review.angles[0].rejectedFindings
      assert.equal(rejected.length, 7)
      assert.deepEqual(rejected.map((item) => item.index).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6])
      assert.ok(rejected.every((item) => Object.keys(item).sort().join(',') === 'index,missing,severity'))
      assert.ok(rejected.some((item) => item.index === 3 && item.missing.includes('repro.actual')))
      assert.ok(rejected.some((item) => item.index === 4 && item.missing.includes('counter.survived')))
    })
    check('严重发现的源码证据对不上时保留严重度但不阻塞', () => {
      assert.equal(view.review.angles[0].findings.length, 4)
      assert.equal(view.review.counts.unverified, 3)
      assert.equal(view.review.counts.unverifiedSevere, 3)
      assert.equal(view.review.counts.blocking, 0)
      assert.equal(view.review.counts.advisories, 4)
      assert.equal(view.review.angles[0].verdict, 'advisory')
      const reasons = view.review.angles[0].findings.filter((item) => item.unverified).map((item) => item.unverifiedReason)
      assert.ok(reasons.some((reason) => /evidence 标识符 notInSource 不在/.test(reason)))
      assert.ok(reasons.some((reason) => /basis.quote 不是/.test(reason)))
      assert.ok(reasons.some((reason) => /line 999 超出/.test(reason)))
    })
    assert.equal((await fx.act('gate', { decision: 'back', to: 'S2' })).status, 200)
    await pending
    await fx.px.tool('flowgate_cancel', {})
  } finally { rmSync(fx.ws, { recursive: true, force: true }) }
}

{
  const fx = await provenanceFixture('finding-evidence-boundaries')
  try {
    assert.equal((await fx.act('setGateMode', { mode: 'manual' })).status, 200)
    const longQuote = 'export const longQuote = \"' + 'x'.repeat(305) + '\"'
    writeFileSync(join(fx.ws, 'src/session.mjs'), 'export const response = () => 401\n  const indented = response\n' + longQuote + '\n')
    const base = { file: 'src/session.mjs', line: 1, severity: 'MAJOR', kind: 'defect', ac: 'AC-1',
      summary: 'response 分支错误', evidence: 'response',
      repro: { when: '调用 response()', expected: '返回 200', actual: '返回 401' },
      counter: { attempt: '尝试检查其他路径', survived: true } }
    const design = { ...base, kind: 'design', evidence: 'indented',
      basis: { quote: '  const indented = response', conflict: '与约定冲突' } }
    const findings = [
      // 合格发现额外带嵌套的非契约字段与超大对象：它们一律不许进快照。
      { ...base,
        repro: { ...base.repro, expected: 'a'.repeat(200) + 'X', actual: 'a'.repeat(200) + 'Y', payload: { blob: 'x'.repeat(512 * 1024) } },
        counter: { ...base.counter, payload: { blob: 'y'.repeat(512 * 1024) } },
        ignored: 'z'.repeat(512 * 1024) },
      { ...design, evidence: 'longQuote', basis: { ...design.basis, quote: longQuote } },
      design,
      { ...design, basis: { ...design.basis, quote: 'const indented = response' } },
      { ...base, file: undefined }, { ...base, summary: undefined }, { ...base, kind: undefined },
      { ...base, evidence: undefined }, { ...base, line: undefined },
      { ...base, repro: { ...base.repro, when: undefined } },
      { ...base, repro: { ...base.repro, expected: undefined } },
      { ...base, repro: { ...base.repro, actual: undefined } },
      { ...design, basis: { ...design.basis, quote: undefined } },
      { ...design, basis: { ...design.basis, conflict: undefined } },
      { ...base, counter: { ...base.counter, attempt: undefined } },
      { ...base, counter: { ...base.counter, survived: false } },
      { ...base, severity: 'X'.repeat(65536) },
    ]
    const pending = fx.px.tool('flowgate_review', { angles: [{ id: 'correctness', name: '正确性', verdict: 'pass', findings }] })
    await tick()
    const view = await fx.state()
    const angle = view.review.angles[0]
    check('手工结论按已核实严重项推导，原声称另存冲突', () => {
      assert.equal(angle.verdict, 'blocking')
      assert.deepEqual(angle.verdictConflict, { declared: 'pass', derived: 'blocking' })
    })
    check('按原文判定超长差异和逐字引文，且只保存合同字段', () => {
      assert.equal(angle.findings.length, 4)
      assert.equal(angle.findings[0].unverified, undefined)
      assert.notEqual(angle.findings[0].repro.expected, angle.findings[0].repro.actual)
      assert.match(angle.findings[0].repro.expected, /SHA-256/)
      assert.equal(angle.findings[1].unverified, undefined)
      assert.match(angle.findings[1].basis.quote, /SHA-256/)
      assert.equal(angle.findings[2].unverified, undefined)
      assert.equal(angle.findings[3].unverified, true)
      assert.match(angle.findings[3].unverifiedReason, /basis.quote 不是/)
      assert.equal(Object.hasOwn(angle.findings[0], 'ignored'), false)
      // 嵌套位置上的非合同字段同样不许落盘：子代理入口不过 schema，
      // 原样保留一个 512KB 的嵌套对象就能把快照顶过冷恢复上限。
      assert.equal(Object.hasOwn(angle.findings[0].repro, 'payload'), false)
      assert.equal(Object.hasOwn(angle.findings[0].counter, 'payload'), false)
    })
    check('必填字段逐个拒绝，非法严重度不以原文写入快照', () => {
      const rejected = new Map(angle.rejectedFindings.map((item) => [item.index, item]))
      for (const [index, field] of [[4, 'file'], [5, 'summary'], [6, 'kind'], [7, 'evidence'],
        [8, 'line'], [9, 'repro.when'], [10, 'repro.expected'], [11, 'repro.actual'],
        [12, 'basis.quote'], [13, 'basis.conflict'], [14, 'counter.attempt'], [15, 'counter.survived'], [16, 'severity']]) {
        assert.ok(rejected.get(index)?.missing.includes(field), field)
      }
      assert.equal(rejected.get(16).severity, 'INVALID')
      assert.ok(JSON.stringify(view.review).length < 16000)
    })
    assert.equal((await fx.act('gate', { decision: 'back', to: 'S2' })).status, 200)
    await pending
    await fx.px.tool('flowgate_cancel', {})
  } finally { rmSync(fx.ws, { recursive: true, force: true }) }
}

// AC1：范围外的严重发现仍保留展示严重度，只有已核实项能触发升档回退。
for (const severity of ['MAJOR', 'CRITICAL']) {
  for (const mixed of [false, true]) {
    const fx = await provenanceFixture('outside-evidence-' + severity + '-' + mixed)
    try {
      writeFileSync(join(fx.ws, 'src/outside.mjs'), 'export const outside = true\n')
      const unverified = reviewFinding({ file: 'src/outside.mjs', severity, evidence: 'missingOutside', summary: '未核实的范围外发现' })
      const verified = reviewFinding({ file: 'src/outside.mjs', severity, evidence: 'outside', summary: '已核实的范围外发现' })
      const pending = fx.px.tool('flowgate_review', { angles: [{ id: 'correctness', name: '正确性', verdict: 'blocking',
        findings: mixed ? [unverified, verified] : [unverified] }] })
      await tick()
      const before = await fx.state()
      const waiter = currentService().gates.waiters.get(fx.sid)
      const expectedOutside = mixed ? [{ file: 'src/outside.mjs', severity, angle: '正确性' }] : []
      check('AC1 ' + severity + (mixed ? ' 混合证据' : ' 仅未核实') + '保留严重度、范围与未核实原因', () => {
        const findings = before.review.angles[0].findings
        assert.equal(findings.length, mixed ? 2 : 1)
        assert.ok(findings.every((item) => item.severity === severity && item.fileInScope === false && item.blocking === false))
        assert.equal(findings[0].unverified, true)
        assert.match(findings[0].unverifiedReason, /evidence 标识符 missingOutside 不在/)
        if (mixed) assert.equal(findings[1].unverified, undefined)
        assert.equal(before.review.counts.blocking, 0)
        assert.equal(before.review.counts.advisories, findings.length)
        assert.equal(before.review.counts.unverifiedSevere, 1)
        assert.deepEqual(before.reviewOutsideScope, expectedOutside)
        assert.ok(waiter)
      })
      const upgraded = await fx.act('upgrade', { preset: 'strict' })
      check('AC1 ' + severity + (mixed ? ' 混合证据升档回 S1' : ' 仅未核实升档留 S3'), () => {
        assert.equal(upgraded.status, 200)
        assert.equal(upgraded.body.preset, 'strict')
        assert.equal(upgraded.body.stage, mixed ? 'S1' : 'S3')
        assert.deepEqual(upgraded.body.reviewOutsideScope, expectedOutside)
        if (!mixed) {
          assert.deepEqual(upgraded.body.review, before.review)
          assert.deepEqual(upgraded.body.gate, before.gate)
          assert.equal(currentService().gates.waiters.get(fx.sid), waiter)
        } else {
          assert.equal(upgraded.body.scope.frozen, false)
          assert.equal(upgraded.body.review, null)
        }
      })
      if (mixed) {
        const result = await pending
        assert.equal(result.decision, 'interrupted')
        assert.equal(result.next, 'S1')
      }
      await fx.px.tool('flowgate_cancel', {})
      if (!mixed) await pending
    } finally { rmSync(fx.ws, { recursive: true, force: true }) }
  }
}

// AC2：上限按原始数组预检；拒绝整份提交，不改旧报告或其门禁等待。
{
  const fx = await provenanceFixture('hard-cap-atomic')
  try {
    const base = reviewFinding({ file: 'src/session.mjs', evidence: 'response' })
    const valid = Array.from({ length: 197 }, (_, i) => ({ ...base, severity: i === 0 ? 'MINOR' : 'MAJOR', summary: '有效发现 ' + i }))
    const findings = [...valid, { ...base, severity: 'CRITICAL', evidence: 'missingResponse' },
      { ...base, line: 999 }, { ...base, evidence: undefined }]
    const angle = (name, items, id = 'correctness') => ({ id, name, verdict: 'blocking', findings: items })
    const pending = fx.px.tool('flowgate_review', { angles: [angle('原报告', findings)] })
    await tick()
    const before = await fx.state()
    const service = currentService()
    const flow = service.get(fx.sid)
    const oldReview = flow.review
    const waiter = service.gates.waiters.get(fx.sid)
    const file = join(fx.ws, '.dsh-flowgate', 'flows', flow.id + '.json')
    const disk = readFileSync(file, 'utf8')
    const auditFile = join(fx.ws, '.dsh-flowgate', 'flows.jsonl')
    const audit = readFileSync(auditFile, 'utf8')
    check('AC2 200 条仍逐条校验证据与缺失字段，不静默跳过校验', () => {
      const stored = before.review.angles[0]
      assert.equal(findings.length, 200)
      assert.equal(stored.findings.length, 199)
      assert.equal(stored.rejectedFindings.length, 1)
      assert.equal(stored.rejectedFindings[0].index, 199)
      assert.ok(stored.rejectedFindings[0].missing.includes('evidence'))
      assert.equal(before.review.counts.total, 199)
      assert.equal(before.review.counts.blocking, 196)
      assert.equal(before.review.counts.advisories, 3)
      assert.equal(before.review.counts.unverified, 2)
      assert.equal(before.review.counts.unverifiedSevere, 2)
      assert.ok(stored.findings.some((item) => item.severity === 'CRITICAL' && /missingResponse/.test(item.unverifiedReason)))
      assert.ok(stored.findings.some((item) => /line 999 超出/.test(item.unverifiedReason)))
      assert.equal(Object.hasOwn(stored, 'omittedCounts'), false)
      assert.ok(waiter)
      assert.equal(before.waiting, true)
      assert.equal(before.waitingKind, 'gate')
      assert.deepEqual(JSON.parse(disk).review, before.review)
    })
    const overflow = (count) => Array.from({ length: count }, () => ({ ...base }))
    const prefix = '这些评审角度的发现超过单角度上限 200 条：'
    const suffix = '；请缩减到上限以内后重新提交整份报告。'
    const longNames = Array.from({ length: 12 }, (_, i) => '角度' + i + '长'.repeat(200))
    const longListed = longNames.slice(0, 10).map((name, i) => name.slice(0, 120) + '…（超长已截断） ' + (201 + i) + ' 条')
    const asciiPrefix = 'x'.repeat(119)
    const cases = [
      { label: '201 整份拒绝', angles: [angle('正确性', overflow(201))], message: prefix + '正确性 201 条' + suffix },
      { label: '空白名称回退到去除首尾空白的 id',
        angles: [angle(' \t ', overflow(201), ' correctness ')],
        message: prefix + 'correctness 201 条' + suffix },
      { label: '长名称去除首尾空白后在 emoji 前截断',
        angles: [angle(' ' + asciiPrefix + '😀 ', overflow(201))],
        message: prefix + asciiPrefix + '…（超长已截断） 201 条' + suffix },
      { label: '多角度只有一个超限', angles: [angle('合格角度', valid), angle('安全性', overflow(201), 'safety')], message: prefix + '安全性 201 条' + suffix },
      { label: '所有超限角度均列入错误', angles: [angle('正确性', overflow(201)), angle('安全性', overflow(202), 'safety')], message: prefix + '正确性 201 条、安全性 202 条' + suffix },
      { label: '长名称限 120 且只列前十角度和剩余数量',
        angles: longNames.map((name, i) => angle(name, overflow(201 + i), 'angle-' + i)),
        message: prefix + [...longListed, '另有 2 个角度超限'].join('、') + suffix },
      { label: '无效发现仍按原始数组长度计数', angles: [angle('无效发现', Array.from({ length: 201 }, (_, i) => i % 2 ? {} : null))], message: prefix + '无效发现 201 条' + suffix },
    ]
    for (const item of cases) {
      const error = await fx.px.tool('flowgate_review', { angles: item.angles }).catch((error) => error)
      const after = await fx.state()
      check('AC2 ' + item.label + '，报告、磁盘和等待器原样保留', () => {
        assert.ok(error instanceof RangeError)
        assert.equal(error.message, item.message)
        assert.ok(error.message.length <= 2000 + '…（超长已截断）'.length)
        assert.equal(flow.review, oldReview)
        assert.deepEqual(after.review, before.review)
        assert.equal(after.stage, before.stage)
        assert.deepEqual(after.stages, before.stages)
        assert.deepEqual(after.gate, before.gate)
        assert.equal(after.waiting, before.waiting)
        assert.equal(after.waitingKind, before.waitingKind)
        assert.equal(service.gates.waiters.get(fx.sid), waiter)
        assert.equal(readFileSync(file, 'utf8'), disk)
        assert.equal(readFileSync(auditFile, 'utf8'), audit)
      })
    }
    const reduced = fx.px.tool('flowgate_review', { angles: [angle('缩减后的报告', overflow(200))] })
    await tick()
    const resubmitted = await fx.state()
    check('AC2 超限报告缩减至 200 后可重新提交整份报告', () => {
      assert.notEqual(resubmitted.review.id, before.review.id)
      assert.equal(resubmitted.review.angles[0].name, '缩减后的报告')
      assert.equal(resubmitted.review.angles[0].findings.length, 200)
      assert.equal(resubmitted.review.counts.blocking, 200)
      assert.equal(resubmitted.waiting, true)
      assert.notEqual(service.gates.waiters.get(fx.sid), waiter)
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).review, resubmitted.review)
    })
    await pending
    assert.equal((await fx.act('gate', { decision: 'back', to: 'S2' })).status, 200)
    await reduced
    await fx.px.tool('flowgate_cancel', {})
  } finally { rmSync(fx.ws, { recursive: true, force: true }) }
}

for (const change of ['content', 'rules']) {
  const fx = await provenanceFixture('reuse-' + change)
  const { ws, px, act, state, round, angles, directions } = fx
  try {
    await round('flowgate_review', { angles }, { decision: 'pass' })
    await round('flowgate_test', { directions }, { decision: 'back', to: 'S2' })
    const before = await state()
    assert.equal(before.snapshot.complete, true)
    assert.ok(before.carryOver.angles.every((entry) => entry.reusable))
    assert.ok(before.carryOver.directions.every((entry) => entry.reusable))
    if (change === 'content') {
      // 同一路径、同长度、同一组 git 状态；只有实际文件内容发生改变。
      writeFileSync(join(ws, 'src/session.mjs'), 'export const response = (expired) => expired ? 403 : 200\n')
    } else {
      const enabledRule = before.stageConfigs.S2.ids[0]
      assert.ok(enabledRule)
      assert.equal((await act('toggleRule', { id: enabledRule, enabled: false })).status, 200)
    }
    const changed = await state()
    check((change === 'content' ? '同路径内容改变' : '规则改变') + '使整轮所有评审角度和测试方向都不可复用', () => {
      assert.equal(changed.snapshot.complete, true)
      assert.notEqual(changed.snapshot.id, before.snapshot.id)
      assert.deepEqual(changed.snapshot.files.map((file) => file.path), before.snapshot.files.map((file) => file.path))
      assert.equal(changed.carryOver.sameCode, false)
      assert.equal(changed.carryOver.angles.length, 2)
      assert.equal(changed.carryOver.directions.length, 2)
      assert.ok(changed.carryOver.angles.every((entry) => !entry.reusable))
      assert.ok(changed.carryOver.directions.every((entry) => !entry.reusable))
      if (change === 'rules') assert.deepEqual(changed.snapshot.files, before.snapshot.files)
      else assert.deepEqual(changed.snapshot.files.find((file) => file.path === 'src/helper.mjs'), before.snapshot.files.find((file) => file.path === 'src/helper.mjs'))
    })
    await round('flowgate_gate', {}, { decision: 'pass' })
    const reviewError = await px.tool('flowgate_review', { angles: [], reusedAngles: ['correctness'] }).catch((error) => error)
    check((change === 'content' ? '内容变化' : '规则变化') + '不能用 reusedAngles 偷渡旧报告', () => assert.match(String(reviewError?.message), /快照已失效.*不能复用/))
    await round('flowgate_review', { angles }, { decision: 'pass' })
    const testError = await px.tool('flowgate_test', { directions: [], reusedDirections: ['smoke'] }).catch((error) => error)
    check((change === 'content' ? '内容变化' : '规则变化') + '不能用 reusedDirections 偷渡旧报告', () => assert.match(String(testError?.message), /快照已失效.*不能复用/))
    await px.tool('flowgate_cancel', {})
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

for (const stage of ['S3', 'S4']) {
  for (const invalidation of ['changed', 'incomplete']) {
    const { ws, px, act, state, round, angles, directions } = await provenanceFixture(stage + '-' + invalidation)
    try {
      if (stage === 'S4') await round('flowgate_review', { angles }, { decision: 'pass' })
      if (invalidation === 'incomplete') {
        rmSync(join(ws, 'src/helper.mjs'))
        mkdirSync(join(ws, 'src/helper.mjs'))
      }
      const pending = px.tool(stage === 'S3' ? 'flowgate_review' : 'flowgate_test', stage === 'S3' ? { angles } : { directions })
      await tick()
      if (invalidation === 'changed') writeFileSync(join(ws, 'src/session.mjs'), 'export const response = () => 403\n')
      const rejected = await act('gate', { decision: 'pass', acceptUncovered: true })
      const after = await state()
      check(stage + ' ' + (invalidation === 'changed' ? '已过期' : '不完整') + '报告快照不能通过，显式接受缺口也不能绕过', () => {
        assert.equal(rejected.status, 409)
        assert.match(rejected.body.error, /快照已失效或不完整/)
        assert.equal(after.stage, stage)
        assert.equal(after.finished, false)
        assert.equal(after.gate.pending, true)
        if (invalidation === 'incomplete') assert.equal(after.snapshot.complete, false)
      })
      await px.tool('flowgate_cancel', {})
      await pending
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  }
}

{
  const { ws, px, act, state, round, angles, directions } = await provenanceFixture('old-review')
  try {
    await round('flowgate_review', { angles }, { decision: 'pass' })
    const reviewed = await state()
    writeFileSync(join(ws, 'src/session.mjs'), 'export const response = () => 403\n')
    const pending = px.tool('flowgate_test', { directions })
    await tick()
    const rejected = await act('gate', { decision: 'pass', acceptUncovered: true })
    const after = await state()
    check('S4 当前测试报告也不能替代已经过期的 S3 通过快照', () => {
      assert.equal(after.test.snapshot.id, after.snapshot.id)
      assert.equal(after.test.snapshot.complete, true)
      assert.equal(after.review.snapshot.id, reviewed.snapshot.id)
      assert.notEqual(after.review.snapshot.id, after.snapshot.id)
      assert.equal(rejected.status, 409)
      assert.match(rejected.body.error, /评审后代码已变化/)
      assert.equal(after.finished, false)
    })
    await px.tool('flowgate_cancel', {})
    await pending
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

for (const evidenceCase of ['missing', 'empty', 'valid', 'nonpass-point']) {
  const { ws, px, act, state, round, angles, directions } = await provenanceFixture('evidence-' + evidenceCase)
  try {
    const reviewedVersion = (await state()).snapshot.id
    await round('flowgate_review', {
      angles,
      acceptance: [{ ac: 'AC-1', status: 'pass', method: 'unit', evidence: '静态检查声称通过，不能替代执行', version: reviewedVersion }],
    }, { decision: 'pass' })
    const reviewed = await state()
    assert.equal(reviewed.acceptance.counts.pass, 0)
    const version = reviewed.snapshot.id
    const source = readFileSync(join(ws, 'src/session.mjs'), 'utf8')
    const executed = await import('data:text/javascript,' + encodeURIComponent(source))
    const actualStatus = executed.response(true)
    assert.equal(actualStatus, 401)
    const evidence = '实际调用当前 src/session.mjs response(true) 得到 ' + actualStatus + '，assert.equal(actualStatus, 401) 通过'
    const acceptance = evidenceCase === 'missing' ? [] : [{ ac: 'AC-1', status: 'pass', method: 'unit', evidence: evidenceCase === 'empty' ? '' : evidence, version }]
    const reportedDirections = evidenceCase === 'nonpass-point'
      ? [{ ...directions[0], points: [{ point: '未验证的额外边界', result: 'uncovered' }] }]
      : directions
    const pending = px.tool('flowgate_test', { directions: reportedDirections, acceptance })
    await tick()
    const submitted = await state()
    const first = await act('gate', { decision: 'pass' })
    if (evidenceCase === 'valid') {
      const result = await pending
      const finished = await state()
      check('当前版本有实际 AC 执行证据且验证要点全通过才记录 passed', () => {
        assert.equal(first.status, 200)
        assert.equal(result.decision, 'pass')
        assert.equal(finished.acceptanceDecision.status, 'passed')
        assert.equal(finished.acceptance.counts.pass, 1)
        assert.equal(finished.acceptance.items[0].evidence, evidence)
        assert.equal(finished.acceptance.items[0].version, version)
        assert.equal(finished.finished, true)
      })
    } else {
      const stillPending = await state()
      check(evidenceCase + '：缺执行证据或存在非 pass 要点时最终门禁返回 409', () => {
        assert.equal(first.status, 409)
        assert.match(first.body.error, /acceptUncovered/)
        assert.equal(stillPending.finished, false)
        assert.equal(stillPending.gate.pending, true)
        assert.equal(stillPending.acceptance.counts.pass, evidenceCase === 'nonpass-point' ? 1 : 0)
      })
      const accepted = await act('gate', { decision: 'pass', acceptUncovered: true, acceptanceNote: '明确接受未覆盖项，保留账本原状态' })
      await pending
      const finished = await state()
      check(evidenceCase + '：显式例外记录 accepted-with-gaps，AC 原状态与验证要点不被改写', () => {
        assert.equal(accepted.status, 200)
        assert.equal(finished.finished, true)
        assert.equal(finished.acceptanceDecision.status, 'accepted-with-gaps')
        assert.equal(finished.acceptanceDecision.note, '明确接受未覆盖项，保留账本原状态')
        assert.deepEqual(finished.acceptance, submitted.acceptance)
        assert.deepEqual(finished.test.directions, submitted.test.directions)
        assert.equal(finished.acceptanceDecision.unpassedPoints, evidenceCase === 'nonpass-point' ? 1 : 0)
      })
    }
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

{
  const ws = mkdtempSync(join(tmpdir(), 'flowgate-running-recovery-'))
  const sid = 'running-recovery'
  try {
    const first = makeHost(ws, sid)
    const started = await first.tool('flowgate_start', { title: '恢复未完成任务' })
    const file = join(ws, '.dsh-flowgate', 'flows', started.flowId + '.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.execution = { status: 'running', taskId: 'persisted-task-42', stage: 'S3', text: '仍在等待最终结果' }
    writeFileSync(file, JSON.stringify(raw))
    const restored = makeHost(ws, sid)
    const cold = (await restored.request('/api/flowgate/state?sessionId=' + sid)).body
    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    check('持久化 running 任务冷恢复后标为 failed，任务 ID 不能冒充执行完成', () => {
      assert.equal(cold.active, true)
      assert.equal(cold.finished, false)
      assert.equal(cold.stageSummary.execution.status, 'failed')
      assert.match(cold.stageSummary.execution.text, /没有可确认的最终执行结果.*不能按任务 ID 认为已经完成/)
      assert.equal(cold.acceptanceDecision, null)
      assert.equal(persisted.execution.status, 'failed')
      assert.equal(persisted.execution.taskId, 'persisted-task-42')
    })
    await restored.tool('flowgate_cancel', {})
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

// S1 清单要在提交时校验，并在冻结前重验旧待批准数据。
for (const listedCommands of [[], ['node --check lib/index.js']]) {
  const ws = mkdtempSync(join(tmpdir(), 'flowgate-scope-shape-'))
  const sid = 'scope-shape-' + listedCommands.length
  try {
    const host = makeHost(ws, sid)
    await host.tool('flowgate_start', { title: '清单结构验证' })
    const base = { files_expected_to_change: ['src/gate.ts'], commands: listedCommands, capabilities: [],
      out_of_scope_explicitly: [], acceptance_criteria: [{ id: 'AC-1', when: '提交', then: '冻结正确清单' }] }
    const html = '<html><body><p>清单校验</p></body></html>'
    const invalid = [
      [{ in_scope: { files_expected_to_change: base.files_expected_to_change, commands: listedCommands },
        capabilities: [], out_of_scope_explicitly: [], acceptance_criteria: base.acceptance_criteria }, /scope.files_expected_to_change/],
      [{ ...base, files_expected_to_change: undefined }, /scope.files_expected_to_change/],
      [{ ...base, commands: undefined }, /scope.commands/],
      [{ ...base, files_expected_to_change: [] }, /没有有效的项目内文件/],
      [{ ...base, files_expected_to_change: ['../outside.ts'] }, /没有有效的项目内文件/],
    ]
    for (const [scope, error] of invalid) {
      await assert.rejects(host.tool('flowgate_doc', { html, scope }), error)
      const state = (await host.request('/api/flowgate/state?sessionId=' + sid)).body
      check('无效清单在提交时拒绝且不留下待批准文档：' + error + '/' + listedCommands.length, () => {
        assert.equal(state.stage, 'S1')
        assert.equal(state.doc.pending, false)
      })
    }
    const pending = host.tool('flowgate_doc', { html, scope: base })
    await tick()
    const before = (await host.request('/api/flowgate/state?sessionId=' + sid)).body
    check('合法清单保留显式的命令数组：' + listedCommands.length, () => {
      assert.deepEqual(before.doc.pendingScope.commands, listedCommands)
      assert.deepEqual(before.doc.pendingScope.files_expected_to_change, ['src/gate.ts'])
    })
    const live = currentService().get(sid)
    const saved = live.pendingScope
    live.pendingScope = { ...saved, files_expected_to_change: [] }
    for (const decision of ['approve', 'skip']) {
      const denied = await host.request('/api/flowgate/action', { sessionId: sid, action: 'doc', payload: { decision } })
      check('旧待批准空清单不能在 ' + decision + ' 时冻结：' + listedCommands.length, () => {
        assert.equal(denied.status, 409)
        assert.match(denied.body.error, /没有有效的项目内文件/)
        assert.equal(live.stage, 'S1')
        assert.equal(live.scope.frozen, false)
      })
    }
    live.pendingScope = saved
    const approved = await host.request('/api/flowgate/action', { sessionId: sid, action: 'doc', payload: { decision: 'approve' } })
    await pending
    const frozen = JSON.parse(readFileSync(join(ws, '.dsh-flowgate', 'scope.json'), 'utf8'))
    check('修复后可正常冻结并进入 S2：' + listedCommands.length, () => {
      assert.equal(approved.status, 200)
      assert.equal(approved.body.stage, 'S2')
      assert.deepEqual(frozen.in_scope.files_expected_to_change, ['src/gate.ts'])
      assert.deepEqual(frozen.in_scope.commands, listedCommands)
    })
    await host.tool('flowgate_cancel', {})
  } finally { rmSync(ws, { recursive: true, force: true }) }
}

// 正式字段与三类目标结果：缺目标必须拒绝，确定没有写入才可跨阶段放行。
{
  const ws = mkdtempSync(join(tmpdir(), 'flowgate-target-contract-'))
  mkdirSync(join(ws, 'src', 'tree'), { recursive: true })
  const flowOf = (stage, files = ['src/a.js', 'src/b.js', 'src/目标.js', 'src/tree/']) => ({
    id: 'target-contract', sessionId: 'target-contract', cwd: ws, finished: false, stage, events: [],
    scope: { frozen: true, data: { in_scope: { files_expected_to_change: files, commands: [] } } },
  })
  const batch = (operations, extra = {}) => ({ action: 'run', operations, ...extra })
  const legitimateWrites = [
    ['write', { file_path: 'src/a.js' }], ['edit', { file_path: 'src/a.js' }],
    ['str_replace_editor', { path: 'src/a.js' }],
    ...['ops_write_file', 'ops_edit_file', 'ops_remove', 'ops_replace'].map((name) => [name, { path: 'src/a.js' }]),
    ...['ops_copy', 'ops_move'].map((name) => [name, { path: 'src/a.js', to: 'src/b.js' }]),
    ['ops_batch', batch([{ op: 'copy', path: 'src/a.js', to: 'src/b.js' },
      { op: 'move', path: 'src/b.js', to: 'src/目标.js' }, { op: 'remove', path: 'src/目标.js' }])],
    ['decompress', { toFile: 'src/a.js' }],
  ]
  try {
    for (const stage of ['S1', 'S2', 'S3', 'S4']) {
      const flow = flowOf(stage)
      check(stage + ' 正式字段写目标只在冻结 S2 放行', () => {
        for (const [name, args] of legitimateWrites) {
          const denial = scopeDenial(flow, name, args)
          if (stage === 'S2') assert.equal(denial, null, name + ': ' + denial)
          else assert.ok(denial, stage + ': ' + name)
        }
      })
      check(stage + ' tsc/deno 复杂命令只按批准清单在 S2/S4 准入', () => {
        const commands = ['tsc --noEmit -p tsconfig.json', 'deno check source.ts']
        const listed = { ...flow, scope: { frozen: true, data: { in_scope: { commands } } } }
        for (const command of commands) {
          const denial = shellDenial(listed, { command })
          if (stage === 'S2' || stage === 'S4') assert.equal(denial, null, command)
          else assert.ok(denial, command)
          assert.ok(shellDenial(flow, { command }), '未批准：' + command)
        }
        for (const command of ['tsc --noEmit -p other.json', 'deno check other.ts']) {
          assert.ok(shellDenial(listed, { command }), '参数不匹配：' + command)
        }
      })
      check(stage + ' 明确无写入的 plan、空 run 与普通 decompress 放行', () => {
        for (const [name, args] of [
          ['ops_batch', { action: 'plan' }],
          ['ops_batch', { action: 'plan', root: '..', operations: 'invalid', operationsRef: 'ref://opaque' }],
          ['ops_batch', batch([])], ['decompress', {}], ['decompress', { blockId: 'b1' }],
          ['decompress', { imageRef: 'list' }],
        ]) assert.equal(scopeDenial(flow, name, args), null, name + ': ' + JSON.stringify(args))
      })
      check(stage + ' 未知工具只读豁免不吞掉已知工具的无效目标', () => {
        assert.ok(scopeDenial(flow, 'future_reader', {}))
        assert.equal(scopeDenial({ ...flow, toolAllowlist: ['future_reader'] }, 'future_reader', {}), null)
        for (const [name] of legitimateWrites.filter(([tool]) => tool !== 'decompress')) {
          assert.ok(scopeDenial({ ...flow, toolAllowlist: [name] }, name, {}), name)
        }
        for (const [name] of legitimateWrites) {
          for (const args of [null, [], '', 42]) assert.ok(scopeDenial(flow, name, args), name + ': 非 record')
        }
      })
    }
    const flow = flowOf('S2')
    check('write/edit 只接受 file_path；其他正式写工具只接受 path', () => {
      for (const name of ['write', 'edit']) {
        for (const args of [{}, { path: 'src/a.js' }, { filePath: 'src/a.js' },
          { dest: 'outside.js' }, { file: 'outside.js' }, { filename: 'outside.js' },
          { file_path: '' }, { file_path: '   ' }, { file_path: null }, { file_path: 42 }, { file_path: [] },
          { file_path: '', path: 'src/a.js' }]) assert.ok(scopeDenial(flow, name, args), name + ': ' + JSON.stringify(args))
        assert.equal(scopeDenial(flow, name, { file_path: 'src/a.js', path: 'outside.js' }), null)
        assert.ok(scopeDenial(flow, name, { file_path: 'outside.js', path: 'src/a.js' }))
      }
      for (const name of ['str_replace_editor', 'ops_write_file', 'ops_edit_file', 'ops_remove', 'ops_replace']) {
        for (const args of [{}, { file_path: 'src/a.js' },
          { dest: 'outside.js' }, { file: 'outside.js' }, { filename: 'outside.js' },
          { path: '' }, { path: null }, { path: 42 }, { path: [] }]) {
          assert.ok(scopeDenial(flow, name, args), name + ': ' + JSON.stringify(args))
        }
        assert.equal(scopeDenial(flow, name, { path: 'src/a.js', file_path: 'outside.js' }), null)
        assert.ok(scopeDenial(flow, name, { path: 'outside.js', file_path: 'src/a.js' }))
      }
    })
    check('move/copy 必须完整提供正式 path/to 且两端都在 scope', () => {
      for (const name of ['ops_move', 'ops_copy']) {
        for (const args of [{ path: 'src/a.js' }, { to: 'src/b.js' },
          { path: 'src/a.js', dest: 'outside.js' }, { path: 'src/a.js', file: 'outside.js' },
          { path: 'src/a.js', filename: 'outside.js' }, { dest: 'outside.js', to: 'src/b.js' },
          { file: 'outside.js', to: 'src/b.js' }, { filename: 'outside.js', to: 'src/b.js' },
          { source: 'src/a.js', destination: 'src/b.js' }, { from: 'src/a.js', to: 'src/b.js' },
          { path: '', to: 'src/b.js' }, { path: 'src/a.js', to: '' },
          { path: null, to: 'src/b.js' }, { path: 'src/a.js', to: 42 },
          { path: 'src/a.js\u0000', to: 'src/b.js' }, { path: 'src/a.js', to: 'src/b.js\u0000' },
          { path: 'outside.js', to: 'src/b.js' }, { path: 'src/a.js', to: 'outside.js' }]) {
          assert.ok(scopeDenial(flow, name, args), name + ': ' + JSON.stringify(args))
        }
      }
    })
    check('ops_replace 仅精确文件，目录 scope、点根、缺省与文件后代均拒绝', () => {
      for (const args of [{}, { path: '.' }, { path: './' }, { path: ws }, { path: 'src/tree' },
        { path: 'src/tree/' }, { path: 'src/tree/new.js' }, { path: 'src/a.js/descendant' }]) {
        assert.ok(scopeDenial(flow, 'ops_replace', args), JSON.stringify(args))
      }
      assert.equal(scopeDenial(flow, 'ops_replace', { path: 'src/目标.js' }), null)
    })
    check('batch run 无法完整枚举操作与路径时 fail closed', () => {
      for (const args of [{}, { operations: [] }, { action: 'run' },
        batch(null), batch({}), batch('operations'), batch([null]), batch([42]), batch([{}]),
        batch([{ op: null }]), batch([{ op: [] }]), batch([{ op: {} }]),
        batch([{ op: { toString: null }, path: 'src/a.js' }]),
        batch([{ op: 'remove', path: 'src/a.js\u0000' }]),
        batch([{ op: 'copy', path: 'src/a.js', to: 'src/b.js\u0000' }]),
        batch([{ op: 'write', path: 'src/a.js' }]), batch([{ kind: 'remove', path: 'src/a.js' }]),
        batch([{ op: 'future', path: 'src/a.js' }]), batch([{ op: 'remove' }]),
        batch([{ op: 'copy', path: 'src/a.js' }]), batch([{ op: 'move', to: 'src/a.js' }]),
        batch([{ op: 'remove', path: 'outside.js' }]),
        batch([{ op: 'copy', path: 'outside.js', to: 'src/a.js' }]),
        batch([{ op: 'move', path: 'src/a.js', to: 'outside.js' }]),
        batch([], { operationsRef: 'ref://opaque' }), batch([], { operationsRef: '' }),
        { action: 'resume' }, { action: 'resume', operations: [] }, { action: 'future', operations: [] }]) {
        assert.ok(scopeDenial(flow, 'ops_batch', args), JSON.stringify(args))
      }
    })
    check('decompress 显式无效 toFile 与隐式图片落盘不能冒充只读', () => {
      for (const args of [{ toFile: '' }, { toFile: '   ' }, { toFile: null }, { toFile: 42 },
        { toFile: [] }, { toFile: {} }, { imageRef: 'm00001' }, { imageRef: 'm00001', toFile: 'src/a.js' }]) {
        assert.ok(scopeDenial(flow, 'decompress', args), JSON.stringify(args))
      }
    })
    check('ASCII/Unicode、正反斜杠、UNC、盘根、超长及数据目录隔离', () => {
      for (const path of ['src/a.js', 'src/目标.js', './src/a.js', join(ws, 'src', 'a.js')]) {
        assert.equal(scopeDenial(flow, 'write', { file_path: path }), null, path)
      }
      if (process.platform === 'win32') {
        assert.equal(scopeDenial(flow, 'write', { file_path: 'src\\目标.js' }), null)
        for (const path of ['C:/', 'C:\\', '\\\\server\\share\\outside.js', '//server/share/outside.js']) {
          assert.ok(scopeDenial(flow, 'write', { file_path: path }), path)
        }
      }
      for (const path of ['../outside.js', 'src/a.js/child', 'src/a.js\u0000', 'x'.repeat(10000)]) {
        assert.ok(scopeDenial(flow, 'write', { file_path: path }), path.slice(0, 80))
      }
      const internal = '.dsh-flowgate/scope.json'
      assert.ok(scopeDenial(flowOf('S2', [internal]), 'write', { file_path: internal }))
      assert.ok(scopeDenial({ ...flow, scope: { ...flow.scope, frozen: false } }, 'write', { file_path: 'src/a.js' }))
    })
    check('batch root 与执行 cwd 按流程根 scope 隔离', () => {
      const nested = join(ws, 'src')
      assert.equal(scopeDenial(flow, 'ops_batch', batch([{ op: 'remove', path: 'a.js' }]), nested), null)
      assert.ok(scopeDenial(flow, 'ops_batch', batch([{ op: 'remove', path: 'src/a.js' }]), nested))
      assert.equal(scopeDenial(flow, 'ops_batch', batch([{ op: 'remove', path: 'src/a.js' }], { root: '..' }), nested), null)
      assert.ok(scopeDenial(flow, 'ops_batch', batch([{ op: 'remove', path: 'src/a.js' }], { root: '..' })))
      assert.ok(scopeDenial(flow, 'write', { file_path: 'src/a.js' }, tmpdir()))
      assert.equal(scopeDenial(flow, 'write', { file_path: join(ws, 'src/a.js') }, tmpdir()), null)
    })
  } finally { rmSync(ws, { recursive: true, force: true }) }
}

// 真实 --check 会不会写盘，由 test/spawn.test.mjs 起真进程证明：那一套在受限环境里
// 显式记 SKIP（FLOWGATE_TEST_SKIP），主套件不再依赖能否派生进程。
// 这里只钉守卫对 parse 尾参与 preload 的字符串判定。
{
  const ws = mkdtempSync(join(tmpdir(), 'flowgate-node-check-'))
  try {
    const cx = makeHost(ws, 'node-check-probe')
    await cx.tool('flowgate_start', { title: 'Node parse preload 边界' })
    const flow = currentService().get('node-check-probe')
    const safe = ['node --check a.js', 'node --check "语法 检查.cjs"', "node --check '语法 检查.cjs'"]
    const unsafe = [
      'node --check --require ./preload.cjs "语法 检查.cjs"',
      'node --check --require=./preload.cjs a.js',
      'node --check --import ./preload.mjs a.js', 'node --check --loader ./loader.mjs a.js',
      'node --check a.js --require ./preload.cjs', 'node --check a.js --import ./preload.mjs',
      'node --check a.js --loader ./loader.mjs', 'node --check a.js --trace-warnings',
      'node --check a.js b.js', 'node --check',
      'bash -n +n deploy.sh', 'bash -n -c "touch changed"', 'bash -n deploy.sh +n',
      'php -l -r "unlink(1);"', 'php -l index.php -r "unlink(1);"',
      'tsc --noEmit -p tsconfig.json', 'deno check source.ts',
      'node --version --require ./preload.cjs',
    ]
    for (const stage of ['S1', 'S3']) {
      flow.stage = stage
      for (const command of safe) assert.equal((await cx.guard('ops_bash', { command })).kind, 'allow', stage + ': ' + command)
      for (const command of unsafe) assert.equal((await cx.guard('ops_bash', { command })).kind, 'deny', stage + ': ' + command)
    }
    await cx.tool('flowgate_cancel', {})
  } finally { rmSync(ws, { recursive: true, force: true }) }
}

// python -E 忽略环境变量，不是内联执行；清单提交与实际 S2/S4 判定必须一致。
{
  const ws = mkdtempSync(join(tmpdir(), 'flowgate-python-E-'))
  const sid = 'python-E-contract'
  try {
    const cx = makeHost(ws, sid)
    await cx.tool('flowgate_start', { title: '解释器选项按生态判定' })
    const wrappers = ['mvnw --version', 'gradlew -v']
    const scope = { files_expected_to_change: ['src/a.js'], commands: ['python -E test/check.py', 'php -F test/check.php', ...wrappers],
      capabilities: [], out_of_scope_explicitly: [],
      acceptance_criteria: [{ id: 'AC-1', when: '清单批准后', then: 'python -E 正常放行' }] }
    for (const command of ['perl -E "say 1"', 'python -c "print(1)"', 'node -e "1"',
      'php -r "echo 1;"', 'php -E "echo 1;"', 'php -nE1', 'ruby -e "puts 1"', 'bash -c "touch x"']) {
      await assert.rejects(cx.tool('flowgate_doc', { html: '<p>inline</p>', scope: { ...scope, commands: [command] } }), /永远不会被放行/)
    }
    const pending = cx.tool('flowgate_doc', { html: '<p>python 环境隔离选项</p>', scope })
    await tick()
    const approved = await cx.request('/api/flowgate/action', { sessionId: sid, action: 'doc', payload: { decision: 'approve' } })
    assert.equal(approved.status, 200, JSON.stringify(approved.body))
    await pending
    const flow = currentService().get(sid)
    check('normalizePendingScope 保留合法 python -E 清单', () => {
      assert.deepEqual(approved.body.scope.data.in_scope.commands, scope.commands)
    })
    for (const stage of ['S1', 'S2', 'S3', 'S4']) {
      flow.stage = stage
      check(stage + ' python -E 清单按阶段放行，perl -E 内联仍拒绝', () => {
        const denial = shellDenial(flow, { command: scope.commands[0] })
        if (stage === 'S2' || stage === 'S4') assert.equal(denial, null)
        else assert.ok(denial)
        const fileModeDenial = shellDenial(flow, { command: scope.commands[1] })
        if (stage === 'S2' || stage === 'S4') assert.equal(fileModeDenial, null)
        else assert.ok(fileModeDenial)
        assert.ok(shellDenial({ ...flow, scope: { frozen: true, data: { in_scope: { commands: [] } } } }, { command: scope.commands[1] }))
        for (const command of ['perl -E "say 1"', 'php -E "echo 1;"', 'php -nE1']) {
          assert.ok(shellDenial({ ...flow, scope: { frozen: true, data: { in_scope: { commands: [command] } } } }, { command }))
        }
        const unapproved = { ...flow, scope: { frozen: true, data: { in_scope: { commands: [] } } } }
        for (const command of wrappers) {
          assert.ok(shellDenial(unapproved, { command }), command)
          const wrapperDenial = shellDenial(flow, { command })
          if (stage === 'S2' || stage === 'S4') assert.equal(wrapperDenial, null, command)
          else assert.ok(wrapperDenial, command)
        }
        for (const command of ['node --version', 'npm -v', 'python --version', 'perl --version', 'mvn --version', 'gradle -v']) {
          assert.equal(shellDenial(flow, { command }), null, command)
        }
      })
    }
    await cx.tool('flowgate_cancel', {})
  } finally { rmSync(ws, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
// G40：门禁等待器只活在进程内存里，而且不设超时。
// 上限在 GateHub 一个入口解析，用例用测试注入压到毫秒级，不用真等十分钟。
// ---------------------------------------------------------------------------
function g40Workspace(label) {
  const ws = mkdtempSync(join(tmpdir(), 'flowgate-g40-' + label + '-'))
  mkdirSync(join(ws, 'src'), { recursive: true })
  writeFileSync(join(ws, 'src', 'session.mjs'), 'export const response = (expired) => (expired ? 401 : 200)\n')
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'g40-fixture', scripts: { test: 'node --test test/session.test.mjs' } }, null, 2) + '\n')
  return ws
}

// AC 可执行、命令带来源：S1 体检不留缺口，用例只关心等待语义。
const G40_SCOPE = {
  files_expected_to_change: ['src/session.mjs'],
  commands: ['npm test'],
  command_sources: [{ command: 'npm test', from: 'package.json scripts.test', acs: ['AC-1'] }],
  capabilities: [],
  out_of_scope_explicitly: [],
  acceptance_criteria: [{
    id: 'AC-1',
    when: '会话过期后发请求',
    then: '返回 401',
    verification: { method: 'unit', procedure: '调用 response(true) 并断言状态码 401' },
  }],
}

function g40Events(ws) {
  const file = join(ws, '.dsh-flowgate', 'flows.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/**
 * 等待器给自己的定时器调了 unref：它是为了让等待器不拖住宿主退出，代价是
 * 「只剩这个定时器」时事件循环判定为空、顶层 await 直接悬空（进程以 13 退出）。
 * 用例里等超时必须自己挂一个被引用的句柄，否则测的根本不是超时。
 */
async function keepAlive(promise) {
  const timer = setInterval(() => {}, 50)
  try {
    return await promise
  } finally {
    clearInterval(timer)
  }
}

// 用例 A：上限在等待入口生效，超时只给请求收尾、不清空记录。
{
  const ws = g40Workspace('timeout')
  const sid = 'g40-timeout'
  try {
    const cx = makeHost(ws, sid)
    const service = currentService()
    // 生产路径是分钟粒度（默认 10 分钟）；注入毫秒级才能让用例跑得动。
    service.gateWaitOverrideMs = 60
    await cx.tool('flowgate_start', { title: '门禁等待上限', preset: 'fast' })
    const pendingDoc = cx.tool('flowgate_doc', { html: '<p>等待上限</p>', scope: G40_SCOPE })
    await tick()
    const flow = service.get(sid)
    const during = flow.stages.S1.gateRequested
    const snapshotDuring = readFileSync(join(ws, '.dsh-flowgate', 'flows', flow.id + '.json'), 'utf8')
    const statusDuring = await cx.tool('flowgate_status', {})
    check('G40-1 挂起时请求记录带 id，status.waiting 报得出同一个 id', () => {
      assert.ok(during && typeof during === 'object', '请求记录必须是对象，不能还是布尔值')
      assert.match(during.id, /^gate_[0-9a-f]{8}$/)
      assert.equal(during.kind, 'doc')
      assert.equal(during.endedAt, null)
      assert.deepEqual(statusDuring.waiting, { gateId: during.id, kind: 'doc', since: during.at })
      assert.ok(statusDuring.summary.includes('门禁等待：id ' + during.id), statusDuring.summary)
    })
    const outcome = await keepAlive(pendingDoc)
    check('G40-2 等满上限返回等待态而不是报错，并说清点按钮不会唤醒 Agent', () => {
      assert.equal(outcome.decision, 'pending')
      assert.equal(outcome.waitReason, 'timeout')
      assert.equal(outcome.willWake, false)
      assert.equal(outcome.gateId, during.id)
      assert.equal(outcome.frozen, false)
      assert.match(outcome.message, /等待超时/)
      assert.match(outcome.message, /不会叫醒你/)
      assert.ok(outcome.message.includes('门禁 id 是 ' + during.id), outcome.message)
    })
    check('G40-3 超时只给请求收尾，不清空记录，门禁仍然 pending', () => {
      const record = flow.stages.S1.gateRequested
      assert.equal(record.id, during.id)
      assert.ok(record.endedAt, '必须写下收尾时间')
      assert.equal(record.endKind, 'timeout')
      assert.equal(flow.stages.S1.gate, 'pending')
      assert.equal(flow.scope.frozen, false)
      assert.equal(flow.gateWaitReason, 'timeout')
    })
    check('G40-4 追加一条 gate.timeout 事件', () => {
      const timeouts = g40Events(ws).filter((event) => event.type === 'gate.timeout')
      assert.equal(timeouts.length, 1)
      assert.equal(timeouts[0].detail.gateId, during.id)
      assert.equal(timeouts[0].detail.endKind, 'timeout')
      assert.equal(timeouts[0].detail.stage, 'S1')
    })
    const statusAfter = await cx.tool('flowgate_status', {})
    const viewAfter = (await cx.request('/api/flowgate/state?sessionId=' + sid)).body
    check('G40-5 收尾之后 status.waiting 清空，但界面仍说门禁开着', () => {
      assert.deepEqual(statusAfter.waiting, {})
      assert.ok(statusAfter.summary.includes('这次等待已经结束'), statusAfter.summary)
      // S1 的门禁产物是需求文档：可确认状态在 doc 段，gate.pending 恒为 false。
      assert.equal(viewAfter.doc.pending, true)
      assert.equal(viewAfter.doc.interrupted, true)
      assert.equal(viewAfter.doc.waitReason, 'timeout')
      assert.equal(viewAfter.doc.request.id, during.id)
      assert.equal(viewAfter.waiting, false)
    })
    // 冷恢复：把快照退回「请求还没收尾」的样子，模拟重启前正挂着的那一刻。
    writeFileSync(join(ws, '.dsh-flowgate', 'flows', flow.id + '.json'), snapshotDuring)
    const revived = makeHost(ws, sid)
    const statusRevived = await revived.tool('flowgate_status', {})
    check('G40-6 冷恢复补写「门禁仍在等待，但宿主重启过」', () => {
      assert.deepEqual(statusRevived.waiting, { gateId: during.id, kind: 'doc', since: during.at })
      assert.ok(statusRevived.summary.includes('宿主重启过'), statusRevived.summary)
      const recovered = g40Events(ws).filter((event) => event.type === 'flow.gate.recovered')
      assert.equal(recovered.length, 1)
      assert.equal(recovered[0].detail.gateId, during.id)
    })
    const viewRevived = (await revived.request('/api/flowgate/state?sessionId=' + sid)).body
    check('G40-7 同一工作区再查一次不重复写恢复事件，界面读得到 recovered', () => {
      assert.equal(g40Events(ws).filter((event) => event.type === 'flow.gate.recovered').length, 1)
      // S1 的门禁产物是需求文档，可确认状态在 doc 段；gate.pending 这个阶段恒为 false。
      assert.equal(viewRevived.doc.recovered.gateId, during.id)
      assert.equal(viewRevived.doc.interrupted, true)
    })
  } finally { rmSync(ws, { recursive: true, force: true }) }
}

// 用例 B：追问等待也吃同一个上限，超时不清卡片，用户点选仍然算数。
{
  const ws = g40Workspace('ask')
  const sid = 'g40-ask'
  try {
    const cx = makeHost(ws, sid)
    const service = currentService()
    service.gateWaitOverrideMs = 60
    await cx.tool('flowgate_start', { title: '追问等待上限', preset: 'fast' })
    const flow = service.get(sid)
    const pendingAsk = cx.tool('flowgate_ask', {
      question: '门禁等待上限放在哪里配？',
      options: [
        { label: '工作区配置', tradeoff: '一处生效，所有流程共用', recommended: true },
        { label: '每条流程各自配', tradeoff: '灵活，但多一层覆盖规则' },
      ],
    })
    await tick()
    const questionId = flow.grill.pending?.id
    const askOutcome = await keepAlive(pendingAsk)
    check('G40-8 追问等满上限返回 answered=false，并说清卡片仍然有效', () => {
      assert.equal(askOutcome.answered, false)
      assert.equal(askOutcome.waitReason, 'timeout')
      assert.match(askOutcome.reason, /等待超时/)
      assert.match(askOutcome.reason, /追问卡片仍留在工作台/)
      assert.match(String(questionId), /^q_[0-9a-f]{8}$/)
    })
    const viewAfterTimeout = (await cx.request('/api/flowgate/state?sessionId=' + sid)).body
    check('G40-9 超时不清 grill.pending：卡片还在，只是没有等待器接着', () => {
      assert.equal(flow.grill.pending.id, questionId)
      assert.equal(viewAfterTimeout.grill.pending.id, questionId)
      assert.equal(viewAfterTimeout.grill.awaiting, false)
    })
    const late = await cx.request('/api/flowgate/action', { sessionId: sid, action: 'answer', payload: { choiceIndex: 1 } })
    check('G40-10 超时之后点选照样落盘：答案进 grill.answered，卡片收起', () => {
      assert.equal(late.status, 200, JSON.stringify(late.body))
      assert.equal(flow.grill.answered.length, 1)
      assert.equal(flow.grill.answered[0].questionId, questionId)
      assert.equal(flow.grill.answered[0].choice, '每条流程各自配')
      assert.equal(flow.grill.pending, null)
      assert.equal(late.body.grill.pending, null)
      assert.equal(late.body.grill.answeredCount, 1)
    })
    check('G40-11 补一条唤醒消息，事件标成 late，答案不会丢', () => {
      const wake = cx.delivered.filter((item) => String(item.message?.content?.[0]?.text ?? '').includes('用户回答了你的追问'))
      assert.equal(wake.length, 1)
      assert.match(String(wake[0].message.content[0].text), /每条流程各自配/)
      const events = g40Events(ws).filter((event) => event.type === 'grill.answered')
      assert.equal(events.length, 1)
      assert.equal(events[0].detail.late, true)
      assert.equal(events[0].detail.questionId, questionId)
    })
    const again = await cx.request('/api/flowgate/action', { sessionId: sid, action: 'answer', payload: { choiceIndex: 0 } })
    check('G40-12 同一条追问重复点击被拒，不重复写记录也不重复唤醒', () => {
      assert.equal(again.status, 409)
      assert.match(again.body.error, /已经处理过/)
      assert.equal(flow.grill.answered.length, 1)
      assert.equal(cx.delivered.filter((item) => String(item.message?.content?.[0]?.text ?? '').includes('用户回答了你的追问')).length, 1)
    })
  } finally { rmSync(ws, { recursive: true, force: true }) }
}

// 用例 C：上限的真源是工作区配置（不是测试注入），越界与脏类型一律回落默认。
// 没有这组，把 gateWaitMs 里读配置那行改成固定 60000，上面两组用例仍然全绿。
{
  const ws = g40Workspace('config')
  const sid = 'g40-config'
  try {
    const cx = makeHost(ws, sid)
    await cx.tool('flowgate_start', { title: '等待上限来源', preset: 'fast' })
    const service = currentService()
    const flow = service.get(sid)
    const configFile = join(ws, '.dsh-flowgate', 'config.json')
    const readConfigMinutes = () => JSON.parse(readFileSync(configFile, 'utf8')).gateWaitMinutes
    check('G40-13 没有配置时等待上限是默认 10 分钟，且不靠测试注入', () => {
      assert.equal(service.gateWaitOverrideMs, null, '生产路径不该预设注入值')
      assert.equal(service.gateWaitMs(flow), 10 * 60000)
    })
    check('G40-14 工作区配置的分钟数被真实读到，改了对下一次等待立即生效', () => {
      assert.deepEqual(service.setWorkspaceGateWaitMinutes(ws, 25), { minutes: 25, rejected: false })
      assert.equal(readConfigMinutes(), 25)
      assert.equal(service.gateWaitMs(flow), 25 * 60000)
      service.setWorkspaceGateWaitMinutes(ws, 60)
      assert.equal(service.gateWaitMs(flow), 60 * 60000)
      service.setWorkspaceGateWaitMinutes(ws, 1)
      assert.equal(service.gateWaitMs(flow), 1 * 60000)
    })
    check('G40-15 0 与越界值不会被当成「不超时」，一律回落默认并标 rejected', () => {
      for (const bad of [0, -5, 61, 120]) {
        const result = service.setWorkspaceGateWaitMinutes(ws, bad)
        assert.equal(result.minutes, 10, '配置 ' + bad + ' 必须回落默认')
        assert.equal(result.rejected, true, '配置 ' + bad + ' 必须标成被拒')
        assert.equal(service.gateWaitMs(flow), 10 * 60000)
      }
    })
    check('G40-16 脏类型（布尔 / 空串 / 非数字）回落默认，不把 true 解释成 1 分钟', () => {
      for (const dirty of [true, false, '', 'abc', null]) {
        const result = service.setWorkspaceGateWaitMinutes(ws, dirty)
        assert.equal(result.minutes, 10, '配置 ' + String(dirty) + ' 必须回落默认')
        assert.equal(result.rejected, true, '脏类型 ' + String(dirty) + ' 必须标 rejected：写错了要让用户看见，不能静默当成默认值')
        assert.equal(service.gateWaitMs(flow), 10 * 60000)
      }
    })
    const viewConfig = (await cx.request('/api/flowgate/state?sessionId=' + sid)).body
    check('G40-17 界面读得到上限与边界，供设置面板挡住 0', () => {
      assert.equal(viewConfig.gateWait.minutes, 10)
      assert.equal(viewConfig.gateWait.min, 1)
      assert.equal(viewConfig.gateWait.max, 60)
      assert.equal(viewConfig.gateWait.fallback, 10)
    })
  } finally { rmSync(ws, { recursive: true, force: true }) }
}

// 用例 D：同一会话挂起新等待会取代旧的。被取代的旧调用必须知道「自己被换掉了」，
// 而等待器归新调用所有——这是 gateWaitPayload 里 outcome.self 修复的底层语义。
{
  const ws = g40Workspace('superseded')
  const sid = 'g40-superseded'
  try {
    const cx = makeHost(ws, sid)
    const service = currentService()
    await cx.tool('flowgate_start', { title: '被取代的等待', preset: 'fast' })
    const first = service.gates.wait(sid, 'answer', 60000)
    await tick()
    const second = service.gates.wait(sid, 'answer', 60000)
    await tick()
    const firstOutcome = await keepAlive(first)
    check('G40-18 新等待取代旧等待：旧调用收到 superseded，等待器归新调用', () => {
      assert.equal(firstOutcome.kind, 'superseded')
      assert.equal(service.gates.has(sid), true)
      assert.equal(service.gates.kindOf(sid), 'answer')
    })
    // 用户点选路径：notify 必须叫醒「现在挂着的那次等待」（second），而不是别的。
    await tick()
    const notified = service.gates.notify(sid, { kind: 'answer', choiceIndex: 0 }, 'answer')
    const delivered = await keepAlive(second)
    check('G40-19 用户回答只唤醒当前那次等待，被取代的旧调用不会被误唤醒', () => {
      assert.equal(notified, true, 'notify 必须命中还挂着的等待器')
      assert.equal(delivered.kind, 'answer')
      assert.equal(firstOutcome !== delivered, true, '两次等待必须解析成不同的结果对象')
      assert.equal(service.gates.has(sid), false)
    })
  } finally { rmSync(ws, { recursive: true, force: true }) }
}

// 用例 E：走宿主 flowgate_doc 完整路径验证被取代语义——不再直接调 gates.wait，
// 而是让两个真实的 flowgate_doc 调用撞在一起：旧调用必须报「自己」的 gateId，
// 且 willWake 为 false（等待器即使挂着也属于取代者，文案不能说「你会被唤醒」）。
{
  const ws = g40Workspace('host-superseded')
  const sid = 'g40-hostsup'
  let service
  try {
    const cx = makeHost(ws, sid)
    service = currentService()
    // 生产上限是 10 分钟；这条用例只需要第二个等待收尾，注入毫秒级，
    // 否则整套宿主测试会被这一个等待拖满十分钟，聚合器的 3 分钟超时直接判 FAIL。
    service.gateWaitOverrideMs = 60
    await cx.tool('flowgate_start', { title: '宿主路径被取代', preset: 'fast' })
    const first = cx.tool('flowgate_doc', { html: '<p>第一次等待</p>', scope: G40_SCOPE })
    await tick()
    const second = cx.tool('flowgate_doc', { html: '<p>第二次等待</p>', scope: G40_SCOPE })
    await tick()
    const firstResult = await keepAlive(first)
    check('G40-20 宿主路径被取代：旧调用报自己的 gateId，不是盘上取代者的', () => {
      assert.equal(firstResult.decision, 'pending')
      assert.equal(firstResult.waitReason, 'superseded')
      assert.equal(firstResult.willWake, false, '这次等待已收尾：等待器即使挂着也属于取代者')
      assert.match(firstResult.gateId, /^gate_[0-9a-f]{8}$/)
      assert.match(firstResult.message, /被新的等待取代/)
      assert.match(firstResult.message, /不会叫醒你/)
      // 盘上的请求已经是取代者的：id 必须与旧调用报出的不同。
      const onDisk = service.get(sid).stages.S1.gateRequested
      assert.notEqual(onDisk.id, firstResult.gateId)
    })
    await keepAlive(second).catch(() => {})
  } finally {
    if (service) service.gateWaitOverrideMs = null
    rmSync(ws, { recursive: true, force: true })
  }
}

console.log('\n全部通过：' + passed.length + ' 项')
