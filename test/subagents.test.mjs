import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'

// 独立假宿主只暴露新版 subagents 契约；不调用或导出生产内部辅助函数。
const WAIT_MS = 2500
const defer = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  promise.catch(() => {})
  return { promise, resolve, reject }
}
const turn = () => new Promise((resolve) => setImmediate(resolve))
async function within(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('等待超时：' + label)), WAIT_MS) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function eventually(predicate, label) {
  const deadline = Date.now() + WAIT_MS
  do {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  } while (Date.now() < deadline)
  assert.fail('条件未满足：' + label)
}
function observe(promise) {
  const state = { settled: false, outcome: undefined }
  state.promise = promise.then(
    (value) => { state.settled = true; return (state.outcome = { ok: true, value }) },
    (error) => { state.settled = true; return (state.outcome = { ok: false, error }) },
  )
  return state
}
function reportFor(spec, expectedPoints = [], checkedFiles = [], readEvidence = []) {
  const report = spec.label.startsWith('测试')
    ? { points: expectedPoints.map((point, index) => ({
      point, result: ['pass', 'fail', 'uncovered'][index % 3], detail: 'fixture evidence',
    })) }
    : { verdict: 'advisory', suggestUpgrade: false, checkedFiles,
      readEvidence, findings: [
      // 发现现在要带能对上的证据：design 类给出文件里逐字存在的一行与冲突的约定。
      { file: 'src/auth/session.ts', kind: 'design', evidence: 'fixture', summary: 'fixture finding', severity: 'MINOR',
        basis: { quote: 'fixture source', conflict: '缺少失败路径的注释' } },
    ] }
  return { stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(report) }] }
}

function reportForActivation(activation) {
  return reportFor(activation.spec, activation.points, activation.checkedFiles, activation.readEvidence)
}

function makeHost(options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'flowgate-subagents-'))
  mkdirSync(join(cwd, 'src', 'auth'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'auth', 'session.ts'), 'fixture source\n')
  const sessionId = 'parent-' + cwd.split(/[\\/]/).pop()
  const parent = { session: { header: { id: sessionId, cwd } } }
  const shutdown = new AbortController()
  const definitions = new Map()
  const routes = new Map()
  const listeners = new Map()
  const guards = []
  const effects = []
  const pending = []
  const activations = []
  const providerLookups = []
  const oldCalls = []
  const fixtureErrors = []
  const capture = async (callback) => {
    try { return await callback() } catch (error) {
      if (error?.code === 'ERR_ASSERTION') fixtureErrors.push(error)
      throw error
    }
  }
  const visible = new Set([
    'read', 'ops_stat', 'ops_diff', 'ops_grep', 'ops_glob',
    'write', 'edit', 'str_replace_editor', 'ops_write_file', 'ops_edit_file', 'ops_remove',
    'ops_batch', 'ops_copy', 'ops_move', 'ops_replace', 'bash', 'ops_bash', 'run_code',
    'subagent', 'subagent_fork', 'send_message', 'schedule_create', 'schedule_edit',
    'unknown_plugin_tool', 'ops_load_sdk', 'suggest_workspace_rule',
  ])
  let host
  const provider = options.nonContinuable ? {} : { prepareContinuable() {} }
  const subagents = {
    getProvider(name) {
      providerLookups.push(name)
      if (options.providerThrows) throw new Error('fixture provider lookup failed')
      return options.noProvider || name !== 'spawn' ? undefined : provider
    },
    startActivation(spec) {
      return capture(async () => {
        const activation = {
          spec, childId: spec.childId, result: defer(), disposeCalls: 0, stopped: false,
        }
        activations.push(activation)
        if (spec.label.startsWith('测试')) {
          const direction = (await host.state()).directions.find((item) => spec.label === '测试：' + item.name)
          assert.ok(direction, '测试 activation 必须对应公开方向')
          activation.points = direction.points
        }
        if (options.onStart) await options.onStart(activation, host)
        if (spec.label.startsWith('评审') && !options.skipRead) {
          try {
            const file = 'src/auth/session.ts'
            const response = await host.childSdk(spec.childId).read({ file_path: file })
            const content = response.content.trim()
            activation.checkedFiles = [file]
            activation.readEvidence = [{ file, firstLine: content, lastLine: content }]
          } catch { activation.checkedFiles = []; activation.readEvidence = [] }
        }
        if (options.startFails) throw new Error('fixture start failed')
        if (options.receiptGate) await options.receiptGate.promise
        if (!options.manualResult) {
          if (options.executionFails) activation.result.reject(new Error('fixture execution failed'))
          else activation.result.resolve(options.response ? options.response(activation) : reportFor(spec, activation.points, activation.checkedFiles, activation.readEvidence))
        }
        return {
          childId: spec.childId,
          name: 'child-' + activations.length,
          messageId: 'message-' + activations.length,
          result: activation.result.promise,
          async dispose() {
            activation.disposeCalls += 1
            if (options.onDispose) await capture(() => options.onDispose(activation, host))
            if (options.disposeGate) await options.disposeGate.promise
            if (options.cleanupFails) throw new Error('fixture cleanup failed')
            activation.stopped = true
            activation.result.resolve({ stopReason: 'aborted', output: [] })
          },
        }
      })
    },
  }
  if (options.legacyOnly) {
    delete subagents.getProvider
    delete subagents.startActivation
    subagents.list = () => { oldCalls.push('list'); throw new Error('旧 list 不应调用') }
    subagents.start = () => { oldCalls.push('start'); throw new Error('旧 start 不应调用') }
  }
  if (options.noGetProvider) delete subagents.getProvider
  if (options.noStartActivation) delete subagents.startActivation

  const tools = {
    register(definition) { definitions.set(definition.name, definition); return () => {} },
    get(name) { return definitions.get(name) ?? (visible.has(name) ? { name } : undefined) },
    list() { return [...definitions.values(), ...[...visible].map((name) => ({ name }))] },
  }
  if (!options.noGuard) tools.guard = (guard) => {
    guards.push(guard)
    return () => { const index = guards.indexOf(guard); if (index >= 0) guards.splice(index, 1) }
  }
  const ctx = {
    inject(_names, callback) { callback(ctx) },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') effects.push(dispose); return dispose },
    on(name, listener) {
      const entries = listeners.get(name) ?? []
      entries.push(listener)
      listeners.set(name, entries)
      return () => { const index = entries.indexOf(listener); if (index >= 0) entries.splice(index, 1) }
    },
    get(name) {
      if (name === 'subagents') return options.noService ? undefined : subagents
      if (name === 'sessions') return { get: (id) => ({ header: { id, cwd } }) }
      if (name === 'agents') return { get: () => ({ followup() {} }) }
      if (name === 'shell') return {
        resolve: (request) => request,
        run: async () => ({
          exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 0,
          stdout: { text: ' M src/auth/session.ts\n---numstat---\n1\t0\tsrc/auth/session.ts\n', truncated: false },
          stderr: { text: '', truncated: false },
        }),
      }
      return undefined
    },
    tools,
    connection: { fetch: { register(spec) { routes.set(spec.path, spec); return () => {} } } },
    workingDirectory: { ensure: async () => cwd },
  }
  const execFor = (name, args, id, signal) => ({
    name, arguments: args, signal,
    agent: id === sessionId ? parent : { session: { header: { id, cwd } } },
  })
  async function checkExec(exec, finalOnly = false) {
    const chain = listeners.get('tools/pre-execute') ?? []
    const next = async (index) => index >= chain.length
      ? { kind: 'allow' }
      : chain[index](exec, () => next(index + 1))
    // 模拟宿主不可被普通 pre-execute allow 覆盖的最终守卫。
    const before = finalOnly ? { kind: 'allow' } : await next(0)
    if (before.kind === 'deny') return before
    for (const guard of guards) {
      const verdict = await guard(exec)
      const reason = typeof verdict === 'string' ? verdict : verdict?.reason
      if (reason) return { kind: 'deny', reason }
    }
    return before
  }
  host = {
    cwd, sessionId, parent, activations, guards, oldCalls, providerLookups, fixtureErrors,
    childSdk(id) {
      let loaded = false
      const access = async (name, args) => {
        if (name === 'ops_read_files' && !loaded) throw new TypeError('tools.ops_read_files is not a function')
        const verdict = await host.check(name, args, id, true)
        if (verdict.kind !== 'allow') throw new Error(verdict.reason)
        if (options.readFails) throw new Error('fixture read failed')
        const path = args.file_path ?? args.files?.[0]?.path
        return { path, content: readFileSync(join(cwd, path), 'utf8') }
      }
      const sdk = {
        read: (args) => access('read', args),
        async ops_load_sdk(args) {
          const verdict = await host.check('ops_load_sdk', args, id, true)
          if (verdict.kind !== 'allow') throw new Error(verdict.reason)
          if (args.tools.includes('read_files')) {
            loaded = true
            sdk.ops_read_files = (args) => access('ops_read_files', args)
          }
        },
      }
      return sdk
    },
    check(name, args = {}, id = sessionId, finalOnly = false) {
      return checkExec(execFor(name, args, id, undefined), finalOnly)
    },
    call(name, args = {}, options = {}) {
      const signal = options.signal ? AbortSignal.any([shutdown.signal, options.signal]) : shutdown.signal
      const exec = execFor(name, args, options.sessionId ?? sessionId, signal)
      const promise = (async () => {
        const verdict = await checkExec(exec)
        if (verdict?.kind === 'deny') throw new Error(verdict.reason)
        const definition = definitions.get(name)
        assert.ok(definition, '工具必须注册：' + name)
        return definition.execute(args, exec)
      })()
      pending.push(promise)
      promise.catch(() => {})
      return promise
    },
    async state() {
      const route = routes.get('/api/flowgate/state')
      const response = await route.fetch(new Request('http://host/api/flowgate/state?sessionId=' + encodeURIComponent(sessionId)))
      assert.equal(response.status, 200)
      return response.json()
    },
    async requestAction(action, payload = {}) {
      const route = routes.get('/api/flowgate/action')
      const response = await route.fetch(new Request('http://host/api/flowgate/action', {
        method: 'POST', body: JSON.stringify({ sessionId, action, payload }),
      }))
      return { status: response.status, body: await response.json() }
    },
    async action(action, payload = {}) {
      const response = await host.requestAction(action, payload)
      assert.equal(response.status, 200, JSON.stringify(response.body))
      return response.body
    },
    async hub(route, body) {
      const endpoint = routes.get('/api/flowgate/hub/' + route)
      const response = await endpoint.fetch(new Request('http://host/api/flowgate/hub/' + route, {
        method: 'POST', body: JSON.stringify(body),
      }))
      return { status: response.status, body: await response.json() }
    },
    async advance(stage = 'S3', { reviewDecision = 'pass', criteria, commands = [] } = {}) {
      await host.call('flowgate_start', { title: '新版子代理黑盒回归', preset: 'fast' })
      // 这套黑盒用例验证每步都要人点的手动门禁；fast 档默认自动通过，这里显式切回来。
      await host.action('setGateMode', { mode: 'manual' })
      const doc = host.call('flowgate_doc', {
        html: '<!doctype html><html><body>fixture requirements</body></html>',
        // 这套黑盒用例验子代理与门禁，追问内容给一份能过校验的清单。
        decisions: [{ question: '这次要改到什么程度？', answer: '把追问纪律写进工具文案与提交校验' }],
        assumptions: [],
        open_questions: [],
        scope: {
          files_expected_to_change: ['src/auth/session.ts'], commands, capabilities: ['fixture'],
          out_of_scope_explicitly: [], acceptance_criteria: criteria ?? [{ id: 'AC-1', when: '运行', then: '可验证' }],
        },
      })
      await eventually(async () => (await host.state()).waitingKind === 'doc', '文档待确认')
      await host.action('doc', { decision: 'approve' })
      await within(doc, '批准文档')
      const dev = host.call('flowgate_gate', {})
      await eventually(async () => (await host.state()).waitingKind === 'gate', '开发门禁')
      await host.action('gate', { decision: 'pass' })
      await within(dev, '开发完成')
      if (stage === 'S4') {
        const review = host.call('flowgate_review', { angles: [{ id: 'correctness', name: '正确性', verdict: 'pass', findings: [] }] })
        await eventually(async () => (await host.state()).waitingKind === 'gate', '评审门禁')
        await host.action('gate', { decision: reviewDecision })
        await within(review, '评审完成')
      }
      assert.equal((await host.state()).stage, stage)
    },
    // 这些传输/权限夹具没有实际 AC 执行证据；S4 默认明确跳过，不冒充验收通过。
    // 跳过与通过走同一套校验，所以缺口要显式接受，否则这些夹具都会被 409 拦住。
    async complete(kind, promise, payload = kind === 'test' ? { decision: 'skip', acceptUncovered: true } : { decision: 'pass' }) {
      const field = kind === 'review' ? 'review' : 'test'
      await eventually(async () => {
        const state = await host.state()
        return state[field] && state.waitingKind === 'gate'
      }, field + '报告与门禁')
      const before = await host.state()
      await host.action('gate', payload)
      const value = await within(promise, field + '运行返回')
      return { before, value }
    },
    async close() {
      shutdown.abort()
      options.receiptGate?.resolve()
      options.disposeGate?.resolve()
      for (const activation of activations) activation.result.resolve({ stopReason: 'aborted', output: [] })
      await Promise.allSettled(pending.map((promise) => within(promise, 'fixture teardown')))
      for (const dispose of effects.reverse()) await dispose()
      rmSync(cwd, { recursive: true, force: true })
    },
  }
  apply(ctx)
  return host
}
async function fixture(options, body) {
  const host = makeHost(options)
  try {
    await body(host)
    if (host.fixtureErrors.length) throw host.fixtureErrors[0]
  } finally { await host.close() }
}

await test('新版 review：预留真实 childId，执行前已有最终只读守卫，按角度聚合并清理', async () => {
  await fixture({ onStart: async (activation, host) => {
    const { spec } = activation
    assert.equal(spec.provider, 'spawn')
    assert.match(spec.childId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    assert.equal(spec.parent, host.parent)
    assert.equal(spec.cwd, host.cwd)
    assert.equal(spec.delivery, 'caller')
    assert.ok(spec.signal instanceof AbortSignal)
    assert.ok(Array.isArray(spec.prompt) && spec.prompt[0].type === 'text')
    assert.ok(host.guards.length > 0, '必须注册 tools.guard 最终守卫')
    assert.equal((await host.check('write', { file_path: 'src/auth/session.ts' }, spec.childId, true)).kind, 'deny', 'startActivation 返回前也已保护真实 childId')
    assert.equal((await host.check('read', { file_path: 'src/auth/session.ts' }, spec.childId, true)).kind, 'allow')
  } }, async (host) => {
    await host.advance()
    assert.equal((await host.state()).canSpawn, true)
    const { before, value } = await host.complete('review', host.call('flowgate_review_run'))
    assert.equal(host.activations.length, 2)
    assert.equal(new Set(host.activations.map((activation) => activation.childId)).size, 2)
    assert.equal(before.review.angles.length, 2)
    assert.equal(before.review.blocking, 0)
    assert.equal(before.review.by, 'subagents')
    assert.equal(before.review.angles[0].findings[0].summary, 'fixture finding')
    assert.equal(value.next, 'S4')
    assert.deepEqual(host.oldCalls, [])
    assert.ok(host.providerLookups.every((name) => name === 'spawn'))
    for (const activation of host.activations) {
      assert.equal(activation.disposeCalls, 1)
      assert.equal(activation.stopped, true)
      assert.equal((await host.check('write', { path: 'x' }, activation.childId, true)).kind, 'allow', '确认停止后才允许移除子会话归属')
    }
    const correctnessPrompt = host.activations.find((activation) => activation.spec.label.includes('正确性')).spec.prompt[0].text
    assert.match(correctnessPrompt, /用户定义的开发规则/)
    // 全量枚举：一次报全被改函数的边界分支，不逐条增量上报。
    assert.match(correctnessPrompt, /全量枚举/)
    assert.match(correctnessPrompt, /发现一个报一个/)
    for (const token of ['带引号引用', '普通引用', '未引用', 'Unicode', 'UNC', '盘根', '上限 + 1']) {
      assert.ok(correctnessPrompt.includes(token), '提示词缺少边界分支：' + token)
    }
  })
})

// AC-8：子代理通道不能成为换目录的后门。清单条目绑住执行目录之后，子代理在流程根跑
// 一条「只在 packages/web 下批准」的命令必须被拒；同一个判定在主 Agent 那边也一样。
// 走 S4 的测试子代理：只有 S2 / S4 才把 scope 清单交给子代理通道。
await test('AC-8 子代理 shell 与主 Agent 同一套目录规则', async () => {
  await fixture({ manualResult: true }, async (host) => {
    mkdirSync(join(host.cwd, 'packages', 'web'), { recursive: true })
    await host.advance('S4', { commands: ['npm test', 'node --test test/host.test.mjs [packages/web]'] })
    const running = observe(host.call('flowgate_test_run'))
    await eventually(() => host.activations.length >= 1, '测试子代理启动')
    const activation = host.activations[0]
    const id = activation.childId
    // 子会话的 cwd 就是流程根：带 [packages/web] 的条目在这里不该命中。
    const wrongDir = await host.check('ops_bash', { command: 'node --test test/host.test.mjs' }, id, true)
    assert.equal(wrongDir.kind, 'deny', '子代理在流程根不能命中只批准在子目录执行的条目')
    // 不带目录后缀的条目照旧在流程根放行：收紧的是目录，不是命令本身。
    assert.equal((await host.check('ops_bash', { command: 'npm test' }, id, true)).kind, 'allow')
    // 换行在子代理通道同样先被拒：多行命令会让审查只看前半句。
    const multiline = await host.check('ops_bash', { command: 'npm test\nrm -rf src' }, id, true)
    assert.equal(multiline.kind, 'deny')
    assert.match(multiline.reason, /换行/)
    const trailingNewline = await host.check('ops_bash', { command: 'npm test\r\n' }, id, true)
    assert.equal(trailingNewline.kind, 'deny')
    assert.match(trailingNewline.reason, /换行/)
    // 主 Agent 用的是同一个判定：同一条命令在流程根同样被拒，清单内的照旧放行。
    assert.equal((await host.check('ops_bash', { command: 'node --test test/host.test.mjs' })).kind, 'deny')
    assert.equal((await host.check('ops_bash', { command: 'npm test' })).kind, 'allow')
    // workdir 是同一个旁路的第二个入口：子会话 header.cwd 在流程根，但 `ops_bash({ command, workdir })`
    // 能让它在子目录里跑另一个同名程序。判定必须跟着 workdir 走，否则「绑目录」只在 header.cwd 上成立。
    const listedInSubdir = await host.check('ops_bash', { command: 'node --test test/host.test.mjs', workdir: 'packages/web' }, id, true)
    assert.equal(listedInSubdir.kind, 'allow', '带 workdir 指向被批准的子目录时应该放行')
    const wrongWorkdir = await host.check('ops_bash', { command: 'npm test', workdir: 'packages/web' }, id, true)
    assert.equal(wrongWorkdir.kind, 'deny', '流程根批准的命令带 workdir 换到子目录必须被拒')
    const auditPath = join(host.cwd, '.dsh-flowgate', 'flows.jsonl')
    const events = () => readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const auditStart = events().length
    assert.equal((await host.check('ops_bash', { command: 'npm test', workdir: 'packages/web' }, id)).kind, 'deny')
    assert.equal((await host.check('ops_bash', { command: 'node --test test/host.test.mjs', workdir: 'packages/web' }, id)).kind, 'allow')
    assert.deepEqual(events().slice(auditStart).map(({ type, detail }) => [type, detail.dir, detail.cwd]), [
      ['shell.denied', 'packages/web', join(host.cwd, 'packages', 'web')],
      ['shell.allowed', 'packages/web', join(host.cwd, 'packages', 'web')],
    ])
    // 主 Agent 侧同一个旁路同样堵上。
    assert.equal((await host.check('ops_bash', { command: 'npm test', workdir: 'packages/web' })).kind, 'deny')
    assert.equal((await host.check('ops_bash', { command: 'node --test test/host.test.mjs', workdir: 'packages/web' })).kind, 'allow')
    activation.result.resolve(reportFor(activation.spec, activation.points))
    await host.complete('test', running.promise)
  })
})

await test('初始 SDK 未加载 ops_read_files：默认 read 与按需加载均通过只读守卫', async () => {
  await fixture({ onStart: async (activation, host) => {
    if (!activation.spec.label.startsWith('评审')) return
    const sdk = host.childSdk(activation.childId)
    assert.equal(sdk.ops_read_files, undefined)
    assert.match(activation.spec.prompt[0].text, /默认可用的 read/)
    assert.doesNotMatch(activation.spec.prompt[0].text, /直接调用 tools\.ops_read_files/)
    // 提示要给出自救路径：ops_* 默认未加载，先 ops_load_sdk 下一轮才可用。
    assert.match(activation.spec.prompt[0].text, /先调 ops_load_sdk/)
    assert.match(activation.spec.prompt[0].text, /下一轮才能用/)
    assert.equal((await host.check('ops_load_sdk', { tools: ['write_file'] }, activation.childId, true)).kind, 'deny')
    await sdk.ops_load_sdk({ tools: ['read_files'] })
    assert.equal((await sdk.ops_read_files({ files: [{ path: 'src/auth/session.ts' }] })).content, 'fixture source\n')
    assert.equal((await sdk.read({ file_path: 'src/auth/session.ts' })).content, 'fixture source\n')
  } }, async (host) => {
    await host.advance()
    const { before, value } = await host.complete('review', host.call('flowgate_review_run'))
    assert.equal(value.next, 'S4')
    assert.ok(before.review.angles.every((angle) => angle.coverage !== 'uncovered'))
  })
})

for (const [name, content] of [['空文件', ''], ['纯空白文件', '  \n\t\n']]) {
  await test(name + '成功读取后不误标未覆盖', async () => {
    await fixture({ response: (activation) => {
      const report = reportForActivation(activation)
      if (!activation.spec.label.startsWith('评审')) return report
      const body = JSON.parse(report.output[0].text)
      return { stopReason: 'completed', structured: { ...body, verdict: 'pass', findings: [] }, output: [] }
    } }, async (host) => {
      await host.advance()
      writeFileSync(join(host.cwd, 'src/auth/session.ts'), content)
      const { before, value } = await host.complete('review', host.call('flowgate_review_run'))
      assert.equal(value.next, 'S4')
      assert.ok(before.review.angles.every((angle) => angle.coverage !== 'uncovered'))
    })
  })
}

await test('并行读取也算读过：Promise.all 读到目标文件后不判未覆盖', async () => {
  await fixture({
    skipRead: true,
    onStart: async (activation, host) => {
      if (!activation.spec.label.startsWith('评审')) return
      const code = 'return await Promise.all([tools.read({"file_path":"src/auth/session.ts"}), tools.read({"file_path":"src/auth/other.ts"})])'
      const verdict = await host.check('run_code', { code }, activation.childId, true)
      assert.equal(verdict.kind, 'allow', '并行只读应放行')
      activation.checkedFiles = ['src/auth/session.ts']
      activation.readEvidence = [{ file: 'src/auth/session.ts', firstLine: 'fixture source', lastLine: 'fixture source' }]
    },
  }, async (host) => {
    await host.advance()
    const { before, value } = await host.complete('review', host.call('flowgate_review_run'))
    assert.equal(value.next, 'S4')
    assert.ok(before.review.angles.every((angle) => angle.coverage !== 'uncovered'), JSON.stringify(before.review.angles))
  })
})

await test('并行读取没碰到目标文件时仍判未覆盖', async () => {
  await fixture({
    skipRead: true,
    onStart: async (activation, host) => {
      if (!activation.spec.label.startsWith('评审')) return
      const code = 'return await Promise.all([tools.read({"file_path":"src/auth/other.ts"}), tools.read({"file_path":"src/auth/third.ts"})])'
      await host.check('run_code', { code }, activation.childId, true)
      activation.checkedFiles = ['src/auth/session.ts']
      activation.readEvidence = [{ file: 'src/auth/session.ts', firstLine: 'fixture source', lastLine: 'fixture source' }]
    },
  }, async (host) => {
    await host.advance()
    const pending = host.call('flowgate_review_run')
    await eventually(async () => Boolean((await host.state()).review) && (await host.state()).waitingKind === 'gate', '待处理评审报告')
    const report = (await host.state()).review
    assert.ok(report.angles.every((angle) => angle.coverage === 'uncovered' && angle.verdict !== 'pass'), JSON.stringify(report.angles))
    const rejected = await host.requestAction('gate', { decision: 'pass' })
    assert.equal(rejected.status, 409)
    assert.match(rejected.body.error, /读取失败|未检查/)
    await host.complete('review', pending, { decision: 'skip' })
  })
})

for (const [name, options] of [
  ['读取失败', { readFails: true }],
  ['读取失败且报告谎称已读', { readFails: true, response: () => ({
    stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify({
      verdict: 'pass', checkedFiles: ['src/auth/session.ts'],
      readEvidence: [{ file: 'src/auth/session.ts', firstLine: '猜测的内容', lastLine: '猜测的内容' }], findings: [],
    }) }],
  }) }],
  ['读取成功但报告遗漏内容证据', { response: (activation) => ({
    stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify({
      verdict: 'pass', checkedFiles: activation.checkedFiles, findings: [],
    }) }],
  }) }],
  ['未读取目标文件', { skipRead: true }],
  ['子代理主动报告未覆盖', { response: (activation) => ({
    stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify({ verdict: 'pass', coverage: 'uncovered', checkedFiles: activation.checkedFiles, findings: [] }) }],
  }) }],
  ['报告伪称已读取但无调用', { skipRead: true, response: () => ({
    stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify({
      verdict: 'pass', checkedFiles: ['src/auth/session.ts'],
      readEvidence: [{ file: 'src/auth/session.ts', firstLine: 'fixture source', lastLine: 'fixture source' }], findings: [],
    }) }],
  }) }],
]) {
  await test(name + '：聚合标未覆盖并拒绝评审通过', async () => {
    await fixture(options, async (host) => {
      await host.advance()
      const pending = host.call('flowgate_review_run')
      await eventually(async () => Boolean((await host.state()).review) && (await host.state()).waitingKind === 'gate', '待处理评审报告')
      const report = (await host.state()).review
      assert.ok(report.angles.every((angle) => angle.coverage === 'uncovered' && angle.verdict !== 'pass'))
      const rejected = await host.requestAction('gate', { decision: 'pass' })
      assert.equal(rejected.status, 409)
      assert.match(rejected.body.error, /读取失败|未检查/)
      assert.equal((await host.state()).stage, 'S3')
      await host.complete('review', pending, { decision: 'skip' })
    })
  })
}

await test('新版 test：按方向聚合通过、失败与未覆盖，清理后才进入门禁', async () => {
  await fixture({}, async (host) => {
    await host.advance('S4', { reviewDecision: 'skip' })
    const added = await host.action('addDirection', { name: '三种验证结果', points: ['主路径', '错误路径', '未覆盖路径'] })
    const custom = added.directions.find((item) => item.name === '三种验证结果')
    for (const direction of added.directions.filter((item) => item.id !== custom.id)) {
      await host.action('toggleDirection', { id: direction.id, enabled: false })
    }
    const { before, value } = await host.complete('test', host.call('flowgate_test_run'))
    assert.equal(host.activations.length, before.directions.length)
    assert.match(host.activations[0].spec.prompt[0].text, /默认可用的 read/)
    assert.doesNotMatch(host.activations[0].spec.prompt[0].text, /直接调用 tools\.ops_read_files/)
    assert.equal(before.test.failed, 1)
    assert.equal(before.test.by, 'subagents')
    assert.deepEqual(before.test.directions[0].points.map((point) => point.result), ['pass', 'fail', 'uncovered'])
    assert.equal(value.directions, before.directions.length)
    assert.ok(host.activations.every((activation) => activation.disposeCalls === 1 && activation.stopped))
  })
})

for (const [name, options, explanation] of [
  ['无服务', { noService: true }, /subagents|服务/i],
  ['仅旧 start/list', { legacyOnly: true }, /subagents|新版|服务|startActivation/i],
  ['缺 getProvider', { noGetProvider: true }, /subagents|服务|getProvider/i],
  ['缺 startActivation', { noStartActivation: true }, /subagents|服务|startActivation/i],
  ['spawn 未注册', { noProvider: true }, /provider|spawn|注册/i],
  ['provider 不支持预留 ID', { nonContinuable: true }, /continuable|预留|prepare|provider/i],
  ['provider 查询失败', { providerThrows: true }, /provider|lookup|服务/i],
  ['缺最终 guard', { noGuard: true }, /只读|guard/i],
]) {
  await test('能力不足不启动：' + name, async () => {
    await fixture(options, async (host) => {
      await host.advance()
      assert.equal((await host.state()).canSpawn, false)
      const { before } = await host.complete('review', host.call('flowgate_review_run'), { decision: 'skip' })
      assert.equal(host.activations.length, 0)
      assert.deepEqual(host.oldCalls, [])
      assert.ok(before.review.angles.every((angle) => angle.verdict === 'advisory'))
      assert.ok(before.review.angles.every((angle) => angle.findings.length && angle.findings.every((finding) => finding.severity === 'MINOR')))
      assert.match(JSON.stringify(before.review), explanation)
    })
  })
}

await test('异步 result：第一子代理未完成时不提前聚合或启动下一角度', async () => {
  await fixture({ manualResult: true }, async (host) => {
    await host.advance()
    const pending = observe(host.call('flowgate_review_run'))
    await eventually(() => host.activations.length === 1, '首个 activation')
    assert.equal((await host.state()).review, null)
    assert.equal((await host.state()).stageSummary.execution.status, 'running', 'receipt 任务 ID 不能证明 result 已完成')
    assert.equal(pending.settled, false)
    host.activations[0].result.resolve(reportForActivation(host.activations[0]))
    await eventually(() => host.activations.length === 2, '第二个 activation')
    assert.equal(host.activations[0].disposeCalls, 1)
    assert.equal((await host.state()).review, null)
    host.activations[1].result.resolve(reportForActivation(host.activations[1]))
    const { before } = await host.complete('review', pending.promise)
    assert.equal(before.review.angles.length, 2)
    assert.equal(before.stageSummary.execution.status, 'completed')
  })
})

await test('最终守卫默认拒绝未知、写入、代理、消息、流程、提权与调度能力', async () => {
  await fixture({ manualResult: true }, async (host) => {
    await host.advance()
    const pending = host.call('flowgate_review_run')
    await eventually(() => host.activations.length === 1, '子代理运行')
    const id = host.activations[0].childId
    for (const name of ['read', 'ops_read_files', 'ops_stat', 'ops_diff', 'ops_grep', 'ops_glob']) {
      assert.equal((await host.check(name, {}, id, true)).kind, 'allow', name)
    }
    for (const name of [
      'unknown_plugin_tool', 'ops_write_file', 'ops_edit_file', 'ops_remove', 'ops_batch',
      'ops_copy', 'ops_move', 'ops_replace', 'write', 'edit', 'str_replace_editor',
      'subagent', 'subagent_fork', 'send_message', 'flowgate_start', 'flowgate_cancel',
      'schedule_create', 'schedule_edit', 'suggest_workspace_rule',
    ]) assert.equal((await host.check(name, { path: 'src/auth/session.ts' }, id, true)).kind, 'deny', name)
    assert.equal((await host.check('ops_bash', { command: 'git diff --stat', sandbox_permissions: 'danger-full-access' }, id, true)).kind, 'deny', '只读命令也不得提权')
    assert.equal((await host.check('ops_result', { action: 'page', id: 'ref://fixture' }, id, true)).kind, 'allow')
    for (const action of ['put', 'release']) {
      assert.equal((await host.check('ops_result', { action, id: 'ref://fixture' }, id, true)).kind, 'deny')
    }
    assert.equal((await host.check('ops_result', { action: 'page', sandbox_permissions: 'danger-full-access' }, id, true)).kind, 'deny')
    assert.equal((await host.check('ops_bash', { command: 'pwd' }, id, true)).kind, 'allow')
    // 最终 tools.guard 也必须使用严格参数语法，不能让 parse 正则吃掉任意尾参。
    for (const command of ['node --check source.js', 'node --check "目录/语法 检查.js"',
      "node --check '目录/语法 检查.js'", 'bash -n deploy.sh', 'php -l index.php',
      'node --version', 'npm -v', 'python --version']) {
      assert.equal((await host.check('ops_bash', { command }, id, true)).kind, 'allow', command)
      const code = 'return await tools.ops_bash(' + JSON.stringify({ command }) + ');'
      assert.equal((await host.check('run_code', { code, description: '纯解析转发' }, id, true)).kind, 'allow', command)
    }
    for (const command of [
      'node --check --require ./preload.cjs source.js',
      'node --check --require=./preload.cjs source.js',
      'node --check --import ./preload.mjs source.js',
      'node --check --loader ./loader.mjs source.js',
      'node --check source.js --require ./preload.cjs',
      'node --check source.js --import ./preload.mjs',
      'node --check source.js --loader ./loader.mjs',
      'node --check source.js --trace-warnings',
      'node --check source.js other.js', 'node --check',
      'node --version --require ./preload.cjs', 'npm -v exec arbitrary',
      'bash -n +n deploy.sh', 'bash -n -c "touch changed"',
      'bash -n deploy.sh +n', 'bash -n deploy.sh -c "touch changed"',
      'php -l -r "unlink(1);"', 'php -l index.php -r "unlink(1);"',
      'tsc --noEmit -p tsconfig.json', 'deno check source.ts',
      'python -E test/check.py', 'perl -E "say 1"',
    ]) {
      for (const name of ['ops_bash', 'bash']) {
        assert.equal((await host.check(name, { command }, id, true)).kind, 'deny', name + ': ' + command)
      }
      const code = 'return await tools.ops_bash(' + JSON.stringify({ command }) + ');'
      assert.equal((await host.check('run_code', { code, description: 'parse 尾参逃逸' }, id, true)).kind, 'deny', command)
    }
    // 评审要核对「实际改了什么」，测试方向要核对工作区有没有多余改动；
    // 原来只认精确的 pwd，子代理只能按文件正文猜。git 的这三个子命令只读。
    for (const command of ['git diff --stat', 'git status', 'git log --oneline -5']) {
      assert.equal((await host.check('ops_bash', { command }, id, true)).kind, 'allow', command)
    }
    for (const args of [
      { script_path: 'script.sh' }, { command: 'node -e "process.exit(0)"' },
      { command: 'python -c "print(1)"' }, { command: 'pnpm test' },
      { command: 'npm run test' }, { command: 'git diff; touch changed' },
      { command: 'git diff && touch changed' }, { command: 'touch changed' },
    ]) assert.equal((await host.check('ops_bash', args, id, true)).kind, 'deny', JSON.stringify(args))
    for (let index = 0; index < 2; index++) {
      await eventually(() => host.activations.length > index, 'activation ' + index)
      host.activations[index].result.resolve(reportFor(host.activations[index].spec))
    }
    await host.complete('review', pending, { decision: 'skip' })
  })
})

await test('run_code 只允许单个严格 JSON 工具转发，嵌套目标受同一守卫', async () => {
  await fixture({ manualResult: true }, async (host) => {
    await host.advance()
    const pending = host.call('flowgate_review_run')
    await eventually(() => host.activations.length === 1, '子代理运行')
    const id = host.activations[0].childId
    for (const code of [
      'return await tools.ops_read_files({"files":[{"path":"x"}]})',
      'await tools.ops_stat({"path":"x"});',
      'return await tools.ops_result({"action":"page","id":"ref://fixture"});',
      // 评审要一次核对十几个文件：并行只读是同一个判定的批量形式。
      'return await Promise.all([tools.ops_stat({"path":"x"}), tools.ops_grep({"pattern":"a"})]);',
      'return await Promise.all([\n  tools.ops_stat({"path":"x"}),\n  tools.read({"file_path":"src/auth/session.ts"}),\n]);',
    ]) assert.equal((await host.check('run_code', { code, description: 'fixture' }, id, true)).kind, 'allow', code)
    for (const code of [
      'return await tools.ops_write_file({"path":"x","content":"x","expectedRevision":"absent"});',
      'return await tools.run_code({"code":"return 1"});',
      'return await tools.ops_result({"action":"put","items":[]});',
      'return await tools.ops_result({"action":"release","id":"ref://fixture"});',
      'return await tools.ops_result({"action":"page","nested":{"action":"put"}});',
      'const fs = await import("node:fs"); fs.writeFileSync("x", "x");',
      'return await tools.ops_stat({"path":"x",});',
      'return await tools.ops_stat({"path":"x"}); await tools.ops_remove({"path":"x"});',
      'return await tools.ops_stat({"path": "x" + "y"});',
      'return await tools.ops_stat({path:"x"});',
      'return await tools.ops_stat({"path":"x","nested":{"__proto__":{"x":true}}});',
      'return await tools.ops_stat({"path":"x","nested":[{"constructor":"x"}]});',
      'return await tools.ops_stat({"path":"x","prototype":"x"});',
      'return await tools.ops_stat({"path":"x","action":"write"});',
      'return await tools.ops_stat({"path":"x","mode":"write"});',
      'return await tools.ops_stat({"path":"x","sandbox_permissions":"danger-full-access"});',
      'return await tools.ops_stat({"path":"x"});\nreturn 1;',
      // 并行形状也要逐个过同一套判定：夹一个写工具或非严格 JSON 就整体拒绝。
      'return await Promise.all([tools.ops_stat({"path":"x"}), tools.ops_write_file({"path":"x","content":"x"})]);',
      'return await Promise.all([tools.ops_stat({"path":"x"}), tools.run_code({"code":"return 1"})]);',
      'return await Promise.all([tools.ops_stat({path:"x"})]);',
      'return await Promise.all([tools.ops_stat({"path":"x"})]).then(() => 1);',
      'const r = await Promise.all([tools.ops_stat({"path":"x"})]); return r;',
    ]) assert.equal((await host.check('run_code', { code, description: 'fixture' }, id, true)).kind, 'deny', code)
    assert.equal((await host.check('run_code', { code: 'return await tools.ops_stat({"path":"x"});', sandbox_permissions: 'danger-full-access' }, id, true)).kind, 'deny')
    for (let index = 0; index < 2; index++) {
      await eventually(() => host.activations.length > index, 'activation ' + index)
      host.activations[index].result.resolve(reportFor(host.activations[index].spec))
    }
    await host.complete('review', pending, { decision: 'skip' })
  })
})

await test('S4 子代理只看 scope 清单：清单内放行、清单外一律拒，没有方向级写权限', async () => {
  await fixture({ onStart: async (activation, host) => {
    const id = activation.childId
    assert.equal((await host.check('ops_bash', { command: 'npm test' }, id, true)).kind, 'allow')
    assert.equal((await host.check('ops_bash', { command: 'python -E test/check.py' }, id, true)).kind, 'allow')
    for (const command of [
      'node --check --require ./preload.cjs source.js',
      'node --check source.js --require ./preload.cjs',
      'node --check source.js --import ./preload.mjs',
      'node --check source.js --loader ./loader.mjs',
      'bash -n +n deploy.sh', 'php -l -r "unlink(1);"',
      'perl -E "say 1"', 'tsc --noEmit -p tsconfig.json', 'deno check source.ts',
    ]) {
      assert.equal((await host.check('ops_bash', { command }, id, true)).kind, 'deny', command)
      const code = 'return await tools.ops_bash(' + JSON.stringify({ command }) + ');'
      assert.equal((await host.check('run_code', { code, description: 'S4 尾参逃逸' }, id, true)).kind, 'deny', command)
    }
    assert.equal((await host.check('ops_bash', { command: 'touch fixture-output' }, id, true)).kind, 'deny')
    assert.equal((await host.check('ops_write_file', { path: 'src/auth/session.ts' }, id, true)).kind, 'deny')
    assert.equal((await host.check('unknown_plugin_tool', {}, id, true)).kind, 'deny')
    assert.equal((await host.check('ops_bash', { command: 'pwd', sandbox_permissions: 'danger-full-access' }, id, true)).kind, 'deny')
  } }, async (host) => {
    await host.advance('S4', { reviewDecision: 'skip', commands: ['npm test', 'python -E test/check.py'] })
    const added = await host.action('addDirection', { name: '迁移回滚', points: ['迁移后回滚'], needsWrite: true })
    const direction = added.directions.find((item) => item.name === '迁移回滚')
    // 客户端多传的 needsWrite 被忽略：方向对象里没有这个概念，也没有任何授予结果。
    assert.equal('needsWrite' in direction, false)
    assert.equal('writeGranted' in direction, false)
    for (const item of added.directions.filter((item) => item.id !== direction.id)) {
      await host.action('toggleDirection', { id: item.id, enabled: false })
    }
    const { before } = await host.complete('test', host.call('flowgate_test_run'))
    assert.equal(host.activations.length, 1)
    assert.equal(before.test.directions[0].id, direction.id)
  })
})

for (const [name, options, marker] of [
  ['启动失败', { startFails: true }, /fixture start failed/],
  ['执行失败', { executionFails: true }, /fixture execution failed/],
  ['非正常结束', { response: (activation) => ({ ...reportFor(activation.spec), stopReason: 'error' }) }, /error|正常结束/],
  ['坏 JSON', { response: () => ({ stopReason: 'completed', output: [{ type: 'text', text: '{invalid json' }] }) }, /JSON|报告|解析/],
]) {
  for (const kind of ['review', 'test']) {
    await test(kind + ' 的' + name + '可见降级且不悬挂', async () => {
      await fixture(options, async (host) => {
        await host.advance(kind === 'review' ? 'S3' : 'S4')
        // S4 的跳过不再免检：这些降级夹具没有真实 AC 证据，缺口必须显式接受。
        const skipPayload = kind === 'test' ? { decision: 'skip', acceptUncovered: true } : { decision: 'skip' }
        const { before } = await host.complete(kind, host.call('flowgate_' + kind + '_run'), skipPayload)
        const report = before[kind]
        assert.equal(before.stageSummary.execution.status, 'failed', '降级报告不能掩盖实际执行失败')
        assert.match(JSON.stringify(report), marker)
        if (kind === 'review') {
          assert.ok(report.angles.every((angle) => angle.verdict === 'advisory'))
          assert.ok(report.angles.every((angle) => angle.findings.length && angle.findings.every((finding) => finding.severity === 'MINOR')))
        } else {
          assert.ok(report.directions.every((direction) => direction.points.length && direction.points.every((point) => point.result === 'uncovered')))
        }
        if (!options.startFails) assert.ok(host.activations.every((activation) => activation.disposeCalls === 1 && activation.stopped))
        else for (const activation of host.activations) {
          assert.equal((await host.check('ops_write_file', { path: 'x' }, activation.childId, true)).kind, 'deny', '无 receipt 的启动失败不能证明资源已释放')
        }
      })
    })
  }
}

await test('正常完成也要等 dispose 结束，清理期间保护子会话且不提前聚合', async () => {
  const disposeGate = defer()
  await fixture({ disposeGate }, async (host) => {
    await host.advance()
    const pending = observe(host.call('flowgate_review_run'))
    await eventually(() => host.activations[0]?.disposeCalls === 1, '进入清理')
    const first = host.activations[0]
    assert.equal(first.stopped, false)
    assert.equal((await host.state()).stageSummary.execution.status, 'running', 'result 已完成但 dispose 未结束时仍在运行')
    assert.equal((await host.check('ops_write_file', { path: 'x' }, first.childId, true)).kind, 'deny')
    assert.equal((await host.state()).review, null)
    assert.equal(host.activations.length, 1)
    assert.equal(pending.settled, false)
    disposeGate.resolve()
    const { before } = await host.complete('review', pending.promise)
    assert.equal(before.stageSummary.execution.status, 'completed', '全部 dispose 成功后才显示执行完成')
    assert.ok(host.activations.every((activation) => activation.stopped))
  })
})

await test('清理失败：可见降级、继续隔离旧子会话，流程取消后也不撤销保护', async () => {
  await fixture({ cleanupFails: true }, async (host) => {
    await host.advance()
    const pending = host.call('flowgate_review_run')
    await eventually(async () => Boolean((await host.state()).review), '清理失败报告')
    const view = await host.state()
    assert.equal(host.activations.length, 2)
    assert.match(JSON.stringify(view.review), /fixture cleanup failed/)
    assert.ok(view.review.angles.every((angle) => angle.verdict === 'advisory'))
    for (const activation of host.activations) {
      assert.equal(activation.stopped, false)
      assert.equal((await host.check('ops_write_file', { path: 'x' }, activation.childId, true)).kind, 'deny')
    }
    await host.call('flowgate_cancel', { reason: 'fixture cleanup failure' })
    await within(pending, '取消失败清理后的门禁')
    for (const activation of host.activations) {
      assert.equal((await host.check('ops_write_file', { path: 'x' }, activation.childId, true)).kind, 'deny', 'result 已完成也不能替代 dispose 成功')
    }
  })
})

await test('signal 在 receipt 前取消：等待 receipt 并清理，不继续启动、不写报告', async () => {
  const receiptGate = defer()
  const controller = new AbortController()
  await fixture({ receiptGate, manualResult: true }, async (host) => {
    await host.advance()
    const pending = observe(host.call('flowgate_review_run', {}, { signal: controller.signal }))
    await eventually(() => host.activations.length === 1, 'startActivation 已进入')
    const activation = host.activations[0]
    assert.equal((await host.check('ops_write_file', { path: 'x' }, activation.childId, true)).kind, 'deny')
    controller.abort()
    await turn()
    assert.equal(pending.settled, false, 'receipt 未到，不能声称已完成清理')
    receiptGate.resolve()
    const outcome = await within(pending.promise, 'receipt 到达后取消完成')
    assert.equal(outcome.ok, false)
    assert.equal(outcome.error.name, 'AbortError')
    assert.equal(activation.disposeCalls, 1)
    assert.equal(activation.stopped, true)
    assert.equal(host.activations.length, 1)
    assert.equal((await host.state()).review, null)
    assert.equal((await host.state()).waiting, false)
  })
})

for (const failure of ['startFails', 'cleanupFails']) {
  await test('S4 方向执行失败后子会话仍被隔离，变更性 shell 始终被拒：' + failure, async () => {
    await fixture({ [failure]: true, onStart: async (activation, host) => {
      assert.equal((await host.check('ops_bash', { command: 'touch fixture-output' }, activation.childId, true)).kind, 'deny')
    } }, async (host) => {
      await host.advance('S4', { reviewDecision: 'skip' })
      const added = await host.action('addDirection', { name: '失败方向', points: ['执行并回滚'] })
      const custom = added.directions.find((direction) => direction.name === '失败方向')
      for (const direction of added.directions.filter((direction) => direction.id !== custom.id)) {
        await host.action('toggleDirection', { id: direction.id, enabled: false })
      }
      const pending = host.call('flowgate_test_run')
      await eventually(async () => Boolean((await host.state()).test), '失败方向报告')
      assert.equal((await host.state()).stage, 'S4')
      assert.equal(host.activations.length, 1)
      const activation = host.activations[0]
      assert.equal(activation.stopped, false)
      assert.equal((await host.check('ops_write_file', { path: 'x' }, activation.childId, true)).kind, 'deny')
      assert.equal((await host.check('ops_bash', { command: 'touch fixture-output' }, activation.childId, true)).kind, 'deny')
      assert.match(JSON.stringify((await host.state()).test), /fixture (start|cleanup) failed/)
      await host.complete('test', pending)
      assert.equal((await host.check('ops_bash', { command: 'touch fixture-output' }, activation.childId, true)).kind, 'deny')
    })
  })
}

await test('夹具内断言不能被生产降级逻辑吞掉', async () => {
  await assert.rejects(fixture({ onStart: () => assert.fail('fixture assertion sentinel') }, async (host) => {
    await host.advance()
    await host.complete('review', host.call('flowgate_review_run'), { decision: 'skip' })
  }), /fixture assertion sentinel/)
})

for (const kind of ['review', 'test']) {
  await test(kind + ' 接收 structured 报告，不依赖文本 JSON', async () => {
    await fixture({ response: (activation) => ({
      stopReason: 'completed',
      structured: JSON.parse(reportForActivation(activation).output[0].text),
      output: [{ type: 'text', text: '这段文本不是 JSON' }],
    }) }, async (host) => {
      await host.advance(kind === 'review' ? 'S3' : 'S4')
      const { before } = await host.complete(kind, host.call('flowgate_' + kind + '_run'))
      if (kind === 'review') {
        assert.ok(before.review.angles.every((angle) => angle.findings[0].summary === 'fixture finding'))
      } else {
        assert.deepEqual(before.test.directions[0].points.map((point) => point.point), before.directions[0].points)
        assert.equal(before.test.directions[0].points[0].result, 'pass')
        assert.equal(before.test.directions[0].points[1].result, 'fail')
      }
    })
  })
}

await test('手工与子代理同一批坏发现给出相同缺项清单并保留合格同伴', async () => {
  const valid = { file: 'src/auth/session.ts', kind: 'design', severity: 'MINOR', evidence: 'fixture',
    summary: 'fixture finding', basis: { quote: 'fixture source', conflict: '缺少失败路径注释' } }
  const findings = [
    { ...valid, kind: undefined },
    { ...valid, severity: 'UNKNOWN', counter: { attempt: '已尝试反驳', survived: true } },
    { ...valid, basis: { quote: 'fixture source' } },
    { ...valid, evidence: undefined },
    valid,
  ]
  let manual
  await fixture({}, async (host) => {
    await host.advance()
    const report = { angles: [{ id: 'correctness', name: '正确性', verdict: 'advisory', findings }] }
    const { before } = await host.complete('review', host.call('flowgate_review', JSON.parse(JSON.stringify(report))), { decision: 'skip' })
    manual = before.review.angles[0]
  })
  await fixture({ response: (activation) => {
    const report = JSON.parse(reportForActivation(activation).output[0].text)
    return { stopReason: 'completed', structured: { ...report, findings: JSON.parse(JSON.stringify(findings)) }, output: [] }
  } }, async (host) => {
    await host.advance()
    const { before } = await host.complete('review', host.call('flowgate_review_run'), { decision: 'skip' })
    const child = before.review.angles[0]
    assert.deepEqual(child.rejectedFindings, manual.rejectedFindings)
    assert.deepEqual([...child.rejectedFindings].sort((a, b) => a.index - b.index).map((item) => item.missing),
      [['kind'], ['severity'], ['basis.conflict'], ['evidence']])
    assert.equal(child.findings.length, 1)
    assert.equal(manual.findings.length, 1)
  })
})

for (const sample of [
  { name: '缺失 verdict，文本报告', count: 201, format: 'text' },
  { name: '非法 verdict，文本报告', count: 205, format: 'text', verdict: 'UNKNOWN' },
  { name: '缺失 verdict，structured 报告', count: 205, format: 'structured' },
  { name: '非法 verdict，structured 报告', count: 201, format: 'structured', verdict: 'UNKNOWN' },
]) {
  await test('AC-3 原始发现超限优先于 verdict 校验：' + sample.name, async () => {
    const expectedError = '这些评审角度的发现超过单角度上限 200 条：正确性 ' + sample.count + ' 条；请缩减到上限以内后重新提交整份报告。'
    const findings = Array.from({ length: sample.count }, () => ({ severity: 'UNKNOWN' }))
    const verdictFields = Object.hasOwn(sample, 'verdict') ? { verdict: sample.verdict } : {}
    await fixture({ response: (activation) => {
      const report = JSON.parse(reportForActivation(activation).output[0].text)
      if (activation.spec.label === '评审：正确性') {
        delete report.verdict
        Object.assign(report, verdictFields, { findings })
      }
      return sample.format === 'structured'
        ? { stopReason: 'completed', structured: report, output: [] }
        : { stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(report) }] }
    } }, async (host) => {
      await host.advance()
      let manualError
      await assert.rejects(within(host.call('flowgate_review', {
        angles: [{ id: 'correctness', name: '正确性', ...verdictFields, findings }],
      }), '手工原始发现超限被拒'), (error) => {
        assert.equal(error.message, expectedError)
        manualError = error.message
        return true
      })
      const { before } = await host.complete('review', host.call('flowgate_review_run'), { decision: 'skip' })
      const boundary = before.review.angles.find((angle) => angle.id === 'correctness')
      const sibling = before.review.angles.find((angle) => angle.id === 'tests')
      assert.equal(boundary.executionError, expectedError)
      assert.equal(boundary.executionError, manualError)
      assert.equal(boundary.coverage, 'uncovered')
      assert.deepEqual(boundary.findings, [])
      assert.notEqual(sibling.coverage, 'uncovered')
      assert.equal(sibling.executionError, undefined)
      assert.deepEqual(sibling.findings.map((finding) => finding.summary), ['fixture finding'])
      assert.equal(before.review.counts.total, 1)
      assert.equal(before.review.blocking, 0)
    })
  })
}

await test('AC-3 子代理仅隔离超过发现上限的角度，恰好 200 条仍逐条校验证据', async () => {
  const design = {
    file: 'src/auth/session.ts', kind: 'design', ac: 'AC-3', evidence: 'fixture',
    basis: { quote: 'fixture source', conflict: '缺少失败路径注释' },
  }
  const severe = { ...design, severity: 'MAJOR', summary: '测试质量角度的严重发现',
    counter: { attempt: '对照文件确认已有注释是否覆盖失败路径', survived: true } }
  const overflowing = Array.from({ length: 201 }, (_, index) => ({
    ...severe, severity: 'CRITICAL', summary: '正确性角度的超限发现 ' + (index + 1),
  }))
  const atLimit = [severe, ...Array.from({ length: 199 }, (_, index) => ({
    ...design, severity: 'MINOR', summary: '测试质量角度的轻微发现 ' + (index + 2),
    evidence: index === 198 ? 'notInSource' : design.evidence,
  }))]
  const expectedError = '这些评审角度的发现超过单角度上限 200 条：正确性 201 条；请缩减到上限以内后重新提交整份报告。'

  await fixture({ response: (activation) => {
    const report = JSON.parse(reportForActivation(activation).output[0].text)
    const findings = activation.spec.label === '评审：正确性' ? overflowing : atLimit
    return { stopReason: 'completed', structured: { ...report, verdict: 'blocking', findings }, output: [] }
  } }, async (host) => {
    await host.advance('S3', { criteria: [{ id: 'AC-3', when: '提交角度结果', then: '检查发现条数' }] })
    const manual = host.call('flowgate_review', {
      angles: [{ id: 'correctness', name: '正确性', verdict: 'blocking', findings: overflowing }],
    })
    let manualError
    await assert.rejects(within(manual, '手工报告超限被拒'), (error) => {
      assert.equal(error.message, expectedError)
      manualError = error.message
      return true
    })

    const { before, value } = await host.complete('review', host.call('flowgate_review_run'), { decision: 'back', to: 'S2' })
    const { angles, blocking, counts } = before.review
    assert.equal(angles.length, 2)
    const overflowAngle = angles.find((angle) => angle.id === 'correctness')
    const validAngle = angles.find((angle) => angle.id === 'tests')
    assert.equal(overflowAngle.coverage, 'uncovered')
    assert.equal(overflowAngle.executionError, manualError)
    assert.deepEqual(overflowAngle.findings, [])

    assert.notEqual(validAngle.coverage, 'uncovered')
    assert.equal(validAngle.executionError, undefined)
    assert.equal(validAngle.verdict, 'blocking')
    assert.deepEqual(validAngle.findings.map((finding) => finding.summary), atLimit.map((finding) => finding.summary))
    assert.equal(validAngle.findings[0].blocking, true)
    assert.notEqual(validAngle.findings[0].unverified, true)
    assert.equal(validAngle.findings[199].unverified, true)
    assert.match(validAngle.findings[199].unverifiedReason, /notInSource/)
    assert.equal(counts.total, 200)
    assert.equal(counts.critical, 0)
    assert.equal(counts.major, 1)
    assert.equal(counts.minor, 199)
    assert.equal(counts.unverified, 1)
    assert.equal(counts.blocking, 1)
    assert.equal(blocking, 1)
    assert.equal(value.blocking, 1)
    assert.equal(value.next, 'S2')
  })
})

for (const sample of [
  { name: '一致', change: (report) => report, verdict: 'advisory' },
  { name: '声称通过但有发现', change: (report) => ({ ...report, verdict: 'pass' }), verdict: 'advisory', declared: 'pass' },
  { name: '零发现却声称阻塞', change: (report) => ({ ...report, verdict: 'blocking', findings: [] }), verdict: 'pass', declared: 'blocking' },
  { name: '严重发现未核实', change: (report) => ({ ...report, verdict: 'blocking', findings: [{
    file: 'src/auth/session.ts', kind: 'design', severity: 'MAJOR', evidence: 'notInSource', summary: '定位符号不存在',
    basis: { quote: 'fixture source', conflict: '缺少失败路径的注释' },
    counter: { attempt: '我尝试证明存在对应标识符', survived: true },
  }] }), verdict: 'advisory', declared: 'blocking', unverified: true },
  { name: '缺字段不丢掉同角度合格发现', change: (report) => ({ ...report, findings: [
    { ...report.findings[0], kind: undefined }, report.findings[0],
  ] }), verdict: 'advisory', rejected: true },
  { name: '未知严重度只丢弃对应一条', change: (report) => ({ ...report, findings: [
    { ...report.findings[0], severity: 'UNKNOWN', counter: { attempt: '检查过严重度', survived: true } }, report.findings[0],
  ] }), verdict: 'advisory', rejected: true, missing: ['severity'] },
]) {
  await test('子代理证据与结论：' + sample.name, async () => {
    await fixture({ response: (activation) => ({ stopReason: 'completed',
      structured: sample.change(JSON.parse(reportForActivation(activation).output[0].text)), output: [],
    }) }, async (host) => {
      await host.advance()
      const { before } = await host.complete('review', host.call('flowgate_review_run'), { decision: 'skip' })
      const angle = before.review.angles[0]
      assert.equal(angle.verdict, sample.verdict)
      if (sample.declared) assert.deepEqual(angle.verdictConflict, { declared: sample.declared, derived: sample.verdict })
      else assert.equal(Object.hasOwn(angle, 'verdictConflict'), false)
      if (sample.unverified) {
        assert.equal(angle.findings[0].unverified, true)
        assert.equal(before.review.counts.unverifiedSevere, before.review.angles.length)
        assert.equal(before.review.blocking, 0)
      }
      if (sample.rejected) {
        assert.equal(angle.findings.length, 1)
        assert.deepEqual(angle.rejectedFindings[0].missing, sample.missing ?? ['kind'])
        assert.equal(angle.coverage, 'uncovered')
        assert.match(angle.executionError, /第 1 条缺 (kind|severity)/)
      }
    })
  })
}

for (const [name, report] of [
  ['缺字段', {}],
  ['findings 非数组', { verdict: 'pass', findings: {} }],
  ['未知 verdict', { verdict: 'unknown', findings: [] }],
]) {
  await test('合法 JSON 的坏评审结构也降级：' + name, async () => {
    await fixture({ response: () => ({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(report) }] }) }, async (host) => {
      await host.advance()
      const { before } = await host.complete('review', host.call('flowgate_review_run'), { decision: 'skip' })
      assert.ok(before.review.angles.every((angle) => angle.verdict === 'advisory'))
      assert.ok(before.review.angles.every((angle) => angle.findings[0].severity === 'MINOR'))
      assert.match(JSON.stringify(before.review), /有效的 JSON 评审报告/)
    })
  })
}

for (const [name, pointsFor, partial] of [
  ['遗漏', () => [], false],
  ['重复', (points) => [
    ...points.map((point) => ({ point, result: 'pass' })),
    { point: points[0], result: 'pass' },
  ], true],
  ['非法状态', (points) => points.map((point, index) => ({ point, result: index === 0 ? 'ok' : 'pass' })), true],
  ['额外通过项', () => [{ point: '不属于方向的要点', result: 'pass' }], false],
]) {
  await test('测试报告保留原始方向要点，不让坏结果替代验证：' + name, async () => {
    await fixture({ response: (activation) => ({
      stopReason: 'completed', structured: { points: pointsFor(activation.points) }, output: [],
    }) }, async (host) => {
      await host.advance('S4')
      const { before } = await host.complete('test', host.call('flowgate_test_run'))
      const expected = before.directions[0].points
      const actual = before.test.directions[0].points
      assert.deepEqual(actual.map((point) => point.point), expected)
      assert.deepEqual(actual.map((point) => point.result), expected.map((_point, index) => partial && index > 0 ? 'pass' : 'uncovered'))
      assert.match(actual[0].detail, /唯一有效结果/)
    })
  })
}

await test('test 运行取消且清理失败：不生成报告，父流程结束仍保留隔离', async () => {
  const controller = new AbortController()
  await fixture({ manualResult: true, cleanupFails: true }, async (host) => {
    await host.advance('S4')
    await host.action('addDirection', { name: '稍后方向', points: ['不能继续启动'] })
    const pending = observe(host.call('flowgate_test_run', {}, { signal: controller.signal }))
    await eventually(() => host.activations.length === 1, '测试子代理运行')
    const activation = host.activations[0]
    controller.abort()
    const outcome = await within(pending.promise, '清理失败后取消')
    assert.equal(outcome.ok, false)
    assert.equal(outcome.error.name, 'AbortError')
    assert.match(outcome.error.message, /fixture cleanup failed/)
    assert.equal(activation.disposeCalls, 1)
    assert.equal(activation.stopped, false)
    assert.equal(host.activations.length, 1)
    assert.equal((await host.state()).test, null)
    assert.equal((await host.check('ops_write_file', { path: 'x' }, activation.childId, true)).kind, 'deny')
    await host.call('flowgate_cancel', { reason: 'fixture cleanup failure' })
    assert.equal((await host.check('ops_write_file', { path: 'x' }, activation.childId, true)).kind, 'deny')
  })
})

await test('工作区 S2/S3 内置编辑进入真实评审子代理，保留最终只读守卫', async () => {
  await fixture({ onStart: async (activation, host) => {
    assert.equal(activation.spec.label, '评审：工作区正确性')
    assert.match(activation.spec.prompt[0].text, /工作区评审要点标记/)
    assert.match(activation.spec.prompt[0].text, /工作区开发规则标记/)
    assert.equal((await host.check('write', { file_path: 'src/auth/session.ts' }, activation.childId, true)).kind, 'deny')
  } }, async (host) => {
    mkdirSync(join(host.cwd, '.dsh-flowgate'))
    writeFileSync(join(host.cwd, '.dsh-flowgate', 'config.json'), JSON.stringify({ version: 2, stages: {
      S1: null,
      S2: { ids: ['scope-only'], custom: [], edits: [{ id: 'scope-only', name: '工作区开发规范', points: ['工作区开发规则标记'] }] },
      S3: { ids: ['correctness'], custom: [], edits: [{ id: 'correctness', name: '工作区正确性', points: ['工作区评审要点标记'] }] },
      S4: null,
    } }))
    await host.advance('S3')
    const { before } = await host.complete('review', host.call('flowgate_review_run'))
    assert.equal(host.activations.length, 1)
    assert.equal(before.stageConfigs.S2.source, 'workspace')
    assert.equal(before.stageConfigs.S3.source, 'workspace')
    assert.equal(before.review.angles[0].name, '工作区正确性')
  })
})

await test('工作区 S4 里的 needsWrite 字段被忽略：不落盘、不给权限', async () => {
  await fixture({ onStart: async (activation, host) => {
    assert.equal(activation.spec.label, '测试：工作区冒烟')
    assert.match(activation.spec.prompt[0].text, /工作区测试验证标记/)
    assert.equal((await host.check('ops_bash', { command: 'touch fixture-output' }, activation.childId, true)).kind, 'deny')
    assert.equal((await host.check('ops_write_file', { path: 'src/auth/session.ts' }, activation.childId, true)).kind, 'deny')
  } }, async (host) => {
    mkdirSync(join(host.cwd, '.dsh-flowgate'))
    // 旧版本写下的 writeGrants 与 needsWrite 留在配置里，新宿主一律不认。
    writeFileSync(join(host.cwd, '.dsh-flowgate', 'config.json'), JSON.stringify({ version: 2, writeGrants: ['smoke'], stages: {
      S1: null, S2: null, S3: null,
      S4: { ids: ['smoke'], custom: [], edits: [{ id: 'smoke', name: '工作区冒烟', points: ['工作区测试验证标记'], needsWrite: true }] },
    } }))
    await host.advance('S4')
    const inherited = await host.state()
    assert.equal(inherited.stageConfigs.S4.source, 'workspace')
    assert.equal('needsWrite' in inherited.directions[0], false)
    assert.equal('writeGranted' in inherited.directions[0], false)
    assert.equal('writeGrants' in inherited, false)
    const { before } = await host.complete('test', host.call('flowgate_test_run'))
    assert.equal(host.activations.length, 1)
    assert.deepEqual(before.test.directions[0].points.map((item) => item.point), ['工作区测试验证标记'])
    assert.equal(before.test.directions[0].points[0].result, 'pass')
  })
})

await test('测试子代理运行中改动方向配置，仍然只能跑 scope 清单里的命令', async () => {
  await fixture({ manualResult: true }, async (host) => {
    const previousHome = process.env.DSH_FLOWGATE_HOME
    process.env.DSH_FLOWGATE_HOME = join(host.cwd, 'hub-home')
    try {
      const direction = { id: 'running-scope', name: '运行中方向', points: ['运行中要点'] }
      const stages = { S1: null, S2: null, S3: null, S4: { ids: ['running-scope'], custom: [direction], edits: [] } }
      assert.equal((await host.hub('add', { path: host.cwd })).status, 200)
      assert.equal((await host.hub('rules', { path: host.cwd, stages })).status, 200)
      await host.advance('S4', { commands: ['npm test'] })
      const running = observe(host.call('flowgate_test_run'))
      await eventually(() => host.activations.length === 1, '方向正在执行')
      const activation = host.activations[0]
      assert.equal((await host.check('ops_bash', { command: 'npm test' }, activation.childId, true)).kind, 'allow')
      assert.equal((await host.check('ops_bash', { command: 'touch fixture-output' }, activation.childId, true)).kind, 'deny')
      // 运行中把方向从工作区配置里删掉：放行依据只有 scope 清单，与方向配置无关。
      const changed = structuredClone(stages)
      changed.S4 = { ids: [], custom: [], edits: [] }
      assert.equal((await host.hub('rules', { path: host.cwd, stages: changed })).status, 200)
      assert.equal((await host.check('ops_bash', { command: 'npm test' }, activation.childId, true)).kind, 'allow')
      assert.equal((await host.check('ops_bash', { command: 'touch fixture-output' }, activation.childId, true)).kind, 'deny')
      assert.equal((await host.check('ops_write_file', { path: 'src/auth/session.ts' }, activation.childId, true)).kind, 'deny')
      void running
    } finally {
      if (previousHome === undefined) delete process.env.DSH_FLOWGATE_HOME
      else process.env.DSH_FLOWGATE_HOME = previousHome
    }
  })
})

for (const stage of ['S3', 'S4']) {
  await test('无子代理时 status 提供有效阶段 ID、要点与来源：' + stage, async () => {
    await fixture({ noService: true }, async (host) => {
      mkdirSync(join(host.cwd, '.dsh-flowgate'))
      writeFileSync(join(host.cwd, '.dsh-flowgate', 'config.json'), JSON.stringify({ version: 2, stages: {
        S1: null,
        S2: { ids: ['scope-only', 'workspace-rule'], edits: [{ id: 'scope-only', name: '开发编辑名', points: ['开发编辑标记'] }],
          custom: [{ id: 'workspace-rule', name: '开发新增名', points: ['开发新增标记'] }] },
        S3: { ids: ['correctness', 'workspace-review'], edits: [{ id: 'correctness', name: '评审编辑名', points: ['评审编辑标记'] }],
          custom: [{ id: 'workspace-review', name: '评审新增名', points: ['评审新增标记'] }] },
        S4: { ids: ['smoke', 'workspace-test'], edits: [{ id: 'smoke', name: '测试编辑名', points: ['测试编辑标记'] }],
          custom: [{ id: 'workspace-test', name: '测试新增名', points: ['测试新增标记'] }] },
      } }))
      await host.advance(stage)
      assert.equal((await host.state()).canSpawn, false)
      const status = await host.call('flowgate_status')
      assert.match(status.summary, /来源：工作区默认/)
      for (const token of stage === 'S3'
        ? ['correctness', '评审编辑名', '评审编辑标记', 'workspace-review', '评审新增名', '评审新增标记', 'scope-only', '开发编辑名', '开发编辑标记', 'workspace-rule', '开发新增名', '开发新增标记']
        : ['smoke', '测试编辑名', '测试编辑标记', 'workspace-test', '测试新增名', '测试新增标记']) {
        assert.ok(status.summary.includes(token), '主会话 status 缺少：' + token)
      }
    })
  })
}

for (const kind of ['review', 'test']) for (const cancellation of ['signal', 'flowgate_cancel', 'rollback']) {
  await test(kind + '运行中取消并等待清理：' + cancellation, async () => {
    const disposeGate = defer()
    const controller = new AbortController()
    await fixture({ manualResult: true, disposeGate }, async (host) => {
      await host.advance(kind === 'review' ? 'S3' : 'S4', { commands: ['npm test'] })
      if (kind === 'test') {
        const added = await host.action('addDirection', { name: '正在测试', points: ['清单命令'] })
        const custom = added.directions.find((direction) => direction.name === '正在测试')
        for (const direction of added.directions.filter((direction) => direction.id !== custom.id)) {
          await host.action('toggleDirection', { id: direction.id, enabled: false })
        }
        await host.action('addDirection', { name: '稍后方向', points: ['不能继续启动'] })
      }
      const pending = observe(host.call('flowgate_' + kind + '_run', {}, { signal: controller.signal }))
      await eventually(() => host.activations.length === 1, '子代理运行中')
      const activation = host.activations[0]
      if (kind === 'test') assert.equal((await host.check('ops_bash', { command: 'npm test' }, activation.childId, true)).kind, 'allow')
      let request
      if (cancellation === 'signal') controller.abort()
      else if (cancellation === 'flowgate_cancel') request = host.call('flowgate_cancel', { reason: 'fixture cancellation' })
      else request = host.action('gate', { decision: 'back', to: 'S2' })
      request?.catch(() => {})
      await eventually(() => activation.disposeCalls === 1, '取消触发 dispose')
      assert.equal((await host.check('ops_write_file', { path: 'x' }, activation.childId, true)).kind, 'deny', '父流程已结束或回退也要保护清理中的子会话')
      // 回退到 S2 后 scope 清单仍然有效，那里由既有用例覆盖；取消与结束则必须立刻失效。
      if (kind === 'test' && cancellation !== 'rollback') assert.equal((await host.check('ops_bash', { command: 'npm test' }, activation.childId, true)).kind, 'deny', '取消后清理期间不再放行清单内命令')
      assert.equal(pending.settled, false)
      assert.equal(host.activations.length, 1)
      disposeGate.resolve()
      const outcome = await within(pending.promise, '取消后停止')
      assert.equal(outcome.ok, false)
      assert.equal(outcome.error.name, 'AbortError')
      if (request) await within(request, '取消/回退请求')
      assert.equal(activation.stopped, true)
      assert.equal(host.activations.length, 1)
      const state = await host.state()
      assert.equal(state[kind], null)
      assert.equal(state.waiting, false)
      assert.notEqual(state.stageSummary.execution.status, 'completed', '取消或回退不能显示执行成功')
      if (cancellation === 'rollback') assert.equal(state.stage, 'S2')
      if (cancellation === 'flowgate_cancel') assert.equal(state.cancelled, true)
    })
  })
}


await test('S4 执行状态等待 result 与 dispose，不把任务 ID 或报告接收当验收通过', async () => {
  const disposeGate = defer()
  await fixture({ manualResult: true, disposeGate }, async (host) => {
    await host.advance('S4')
    const running = observe(host.call('flowgate_test_run'))
    await eventually(() => host.activations.length === 1, '测试 receipt 已发布')
    const activation = host.activations[0]
    assert.equal((await host.state()).stageSummary.execution.status, 'running')
    assert.equal((await host.state()).test, null)
    assert.equal(running.settled, false)
    activation.result.resolve(reportFor(activation.spec, activation.points))
    await eventually(() => activation.disposeCalls === 1, '测试 result 完成并进入清理')
    assert.equal(activation.stopped, false)
    assert.equal((await host.state()).stageSummary.execution.status, 'running')
    assert.equal((await host.state()).test, null)
    disposeGate.resolve()
    const { before } = await host.complete('test', running.promise)
    assert.equal(before.stageSummary.execution.status, 'completed')
    assert.ok(host.activations.every((child) => child.stopped))
    assert.equal(before.acceptance.counts.pass, 0, '方向通过总数不能替代 AC 执行证据')
    assert.equal(before.acceptance.counts.uncovered, 1)
    assert.equal((await host.state()).acceptanceDecision.status, 'skipped')
  })
})

for (const kind of ['review', 'test']) {
  await test(kind + ' 内容快照不变时全量复用：新执行 0，保持原验收状态', async () => {
    await fixture({}, async (host) => {
      await host.advance(kind === 'review' ? 'S3' : 'S4')
      const first = host.call('flowgate_' + kind + '_run')
      await eventually(async () => Boolean((await host.state())[kind]) && (await host.state()).waitingKind === 'gate', '首轮报告门禁')
      const original = await host.state()
      const entries = original[kind][kind === 'review' ? 'angles' : 'directions']
      assert.equal(original.stageSummary[kind].fresh, entries.length)
      await host.action('gate', { decision: 'back', to: 'S2', note: '检查原快照复用' })
      await within(first, '首轮退回')
      const dev = host.call('flowgate_gate')
      await eventually(async () => (await host.state()).waitingKind === 'gate', '复用前开发门禁')
      await host.action('gate', { decision: 'pass' })
      await within(dev, '复用前开发提交')
      assert.equal((await host.state()).snapshot.id, original.snapshot.id)
      if (kind === 'test') {
        await host.complete('review', host.call('flowgate_review', { angles: [{ id: 'correctness', name: '正确性', verdict: 'pass', findings: [] }] }))
      }
      const started = host.activations.length
      const { before } = await host.complete(kind, host.call('flowgate_' + kind + '_run'))
      assert.equal(host.activations.length, started, '全复用不得启动任何新子代理')
      assert.deepEqual(before[kind].reused, entries.map((entry) => entry.id))
      assert.equal(before[kind].fresh, 0)
      assert.deepEqual(before.stageSummary[kind], { fresh: 0, reused: entries.length, total: entries.length })
      assert.equal(before.stageSummary.execution.status, 'completed')
      assert.match(before.stageSummary.execution.text, kind === 'review' ? /本轮新评审 0 个角度/ : /本轮新测 0 个方向/)
      assert.deepEqual(before.acceptance.counts, original.acceptance.counts)
      assert.equal(before.acceptance.counts.pass, 0)
    })
  })
}

await test('复用角度保留原结论但不带上轮结论冲突', async () => {
  await fixture({ response: (activation) => ({ stopReason: 'completed',
    structured: { ...JSON.parse(reportForActivation(activation).output[0].text), verdict: 'pass' }, output: [],
  }) }, async (host) => {
    await host.advance()
    const first = host.call('flowgate_review_run')
    await eventually(async () => Boolean((await host.state()).review), '首轮冲突报告')
    assert.deepEqual((await host.state()).review.angles[0].verdictConflict, { declared: 'pass', derived: 'advisory' })
    await host.action('gate', { decision: 'back', to: 'S2' })
    await within(first, '退回开发')
    const dev = host.call('flowgate_gate')
    await eventually(async () => (await host.state()).waitingKind === 'gate', '开发门禁')
    await host.action('gate', { decision: 'pass' })
    await within(dev, '开发完成')
    const { before } = await host.complete('review', host.call('flowgate_review_run'))
    assert.equal(before.review.angles[0].reused, true)
    assert.equal(before.review.angles[0].verdict, 'advisory')
    assert.equal(Object.hasOwn(before.review.angles[0], 'verdictConflict'), false)
  })
})

for (const kind of ['review', 'test']) for (const stale of [false, true]) {
  await test(kind + ' 子报告传输 AC 证据与原始版本，不替陈旧证据补盖当前版本：' + stale, async () => {
    let submitted
    await fixture({
      onStart: async (activation, host) => {
        const state = await host.state()
        const prompt = activation.spec.prompt[0].text
        assert.ok(prompt.includes(state.snapshot.id), '子代理提示必须携带实际内容版本')
        assert.match(prompt, /getBoundingClientRect\(\)/)
        assert.match(prompt, /element\/reference\/left\/right\/referenceLeft\/referenceRight/)
        assert.match(prompt, /hostRevision,clientRevision,pageId,viewport/)
        assert.match(prompt, /inspectLayout.*evidenceId/)
        assert.match(prompt, /401.*未认证/)
        assert.match(prompt, /真实 DOM 时记录 uncovered/)
        assert.match(prompt, /CSS 字符串.*不是实际执行证据/)
        assert.match(prompt, /不得伪造命令、测量或截图/)
        if (host.activations.length === 1) {
          submitted = {
            ac: 'AC-1', status: 'uncovered', method: 'visual',
            evidence: '模拟宿主没有已认证的真实 DOM；未执行视觉测量。',
            version: stale ? '0'.repeat(64) : state.snapshot.id,
          }
          activation.acceptance = [submitted]
        }
      },
      response: (activation) => ({
        stopReason: 'completed',
        structured: { ...JSON.parse(reportForActivation(activation).output[0].text), acceptance: activation.acceptance ?? [] },
        output: [],
      }),
    }, async (host) => {
      await host.advance(kind === 'review' ? 'S3' : 'S4', { criteria: [{
        id: 'AC-1', when: '显示实际宿主界面', then: '目标与任务参照元素左右边缘对齐',
        verification: { method: 'visual', procedure: '核对页面版本后测量真实元素左右边缘' },
      }] })
      const { before } = await host.complete(kind, host.call('flowgate_' + kind + '_run'))
      assert.equal(before[kind].snapshot.id, before.snapshot.id)
      assert.equal(before[kind].snapshot.complete, true)
      assert.equal(before[kind].acceptance.length, 1)
      for (const [key, value] of Object.entries(submitted)) assert.deepEqual(before[kind].acceptance[0][key], value)
      assert.equal(before[kind].acceptance[0].version, stale ? '0'.repeat(64) : before.snapshot.id)
      assert.equal(before.acceptance.items[0].status, 'uncovered')
      assert.equal(before.acceptance.counts.pass, 0)
      if (stale) assert.match(before.acceptance.items[0].reason, /版本/)
      else assert.match(before.acceptance.items[0].evidence, /未执行视觉测量/)
    })
  })
}

await test('S4 只加测试方向不算代码变化，已通过的评审仍然有效', async () => {
  await fixture({}, async (host) => {
    await host.advance('S4')
    const reviewed = (await host.state()).review.snapshot.id
    await host.action('addDirection', { name: '评审后新增规则', points: ['真实执行仍待覆盖'] })
    const pending = host.call('flowgate_test_run')
    await eventually(async () => Boolean((await host.state()).test) && (await host.state()).waitingKind === 'gate', '新规则测试报告')
    const state = await host.state()
    // 加方向会让整份快照 id 变（规则进了 digest），但代码一行没动，
    // 所以不该判成「评审后代码已变化」把用户赶回 S2 重做评审。
    assert.notEqual(state.snapshot.id, reviewed)
    assert.equal(state.test.snapshot.id, state.snapshot.id)
    await host.complete('test', pending, { decision: 'pass', acceptUncovered: true, acceptanceNote: '规则变化不等于代码变化；缺口显式接受' })
    const after = await host.state()
    assert.equal(after.finished, true)
    assert.equal(after.acceptanceDecision.status, 'accepted-with-gaps')
  })
})

await test('S4 无 AC 证据及非通过要点必须显式接受缺口，接受后仍保留未覆盖', async () => {
  await fixture({}, async (host) => {
    await host.advance('S4')
    const pending = host.call('flowgate_test_run')
    await eventually(async () => Boolean((await host.state()).test) && (await host.state()).waitingKind === 'gate', '缺口测试报告')
    const before = await host.state()
    const rejected = await host.requestAction('gate', { decision: 'pass' })
    assert.equal(rejected.status, 409)
    assert.match(rejected.body.error, /acceptUncovered: true/)
    assert.equal((await host.state()).finished, false)
    await host.complete('test', pending, { decision: 'pass', acceptUncovered: true, acceptanceNote: '测试夹具明确接受未覆盖；不声称实际通过' })
    const accepted = await host.state()
    assert.equal(accepted.finished, true)
    assert.equal(accepted.acceptanceDecision.status, 'accepted-with-gaps')
    assert.equal(accepted.acceptanceDecision.version, before.snapshot.id)
    assert.equal(accepted.acceptanceDecision.counts.pass, 0)
    assert.deepEqual(accepted.acceptance.counts, before.acceptance.counts)
    assert.equal(accepted.acceptanceDecision.unpassedPoints, 1)
  })
})

for (const kind of ['review', 'test']) for (const stale of [false, true]) {
  await test(kind + ' 人工顶层 AC 证据在自动全复用后保留来源内容与原始版本：' + stale, async () => {
    await fixture({}, async (host) => {
      await host.advance(kind === 'review' ? 'S3' : 'S4')
      const state = await host.state()
      const submitted = {
        ac: 'AC-1', status: 'uncovered', method: 'manual',
        evidence: '来源：人工顶层报告；当前模拟宿主未进行实际执行，保持未覆盖。',
        version: stale ? '0'.repeat(64) : state.snapshot.id,
      }
      const entries = kind === 'review'
        ? state.angles.map(({ id, name }) => ({ id, name, verdict: 'advisory', findings: [] }))
        : state.directions.map(({ id, name, points }) => ({ id, name, points: points.map((point) => ({ point, result: 'uncovered', detail: '人工夹具没有实际执行' })) }))
      const field = kind === 'review' ? 'angles' : 'directions'
      assert.ok(entries.length > 0)
      assert.ok(entries.every((entry) => !('acceptance' in entry)), '证据必须仅位于人工报告顶层')
      const originalCall = host.call('flowgate_' + kind, { [field]: entries, acceptance: [submitted] })
      await eventually(async () => Boolean((await host.state())[kind]) && (await host.state()).waitingKind === 'gate', '人工顶层报告门禁')
      const original = await host.state()
      assert.equal(original[kind].acceptance.length, 1)
      for (const [key, value] of Object.entries(submitted)) assert.deepEqual(original[kind].acceptance[0][key], value)
      await host.action('gate', { decision: 'back', to: 'S2', note: '检查人工顶层证据的同快照复用' })
      await within(originalCall, '人工报告退回')
      const dev = host.call('flowgate_gate')
      await eventually(async () => (await host.state()).waitingKind === 'gate', '人工证据复用前开发门禁')
      await host.action('gate', { decision: 'pass' })
      await within(dev, '人工证据复用前提交开发')
      assert.equal((await host.state()).snapshot.id, original.snapshot.id)
      if (kind === 'test') {
        await host.complete('review', host.call('flowgate_review', { angles: [{ id: 'correctness', name: '正确性', verdict: 'pass', findings: [] }] }))
      }
      const started = host.activations.length
      const { before } = await host.complete(kind, host.call('flowgate_' + kind + '_run'))
      assert.equal(host.activations.length, started, '全复用不得启动新的子代理')
      assert.deepEqual(before[kind].reused, entries.map((entry) => entry.id))
      assert.equal(before[kind].fresh, 0)
      assert.equal(before[kind].snapshot.id, original.snapshot.id)
      assert.equal(before[kind].acceptance.length, 1, '角度或方向没有局部证据也必须保留人工顶层证据')
      for (const [key, value] of Object.entries(submitted)) assert.deepEqual(before[kind].acceptance[0][key], value)
      assert.equal(before.acceptance.items[0].status, 'uncovered')
      assert.equal(before.acceptance.counts.pass, 0)
      if (stale) assert.match(before.acceptance.items[0].reason, /版本/)
      else assert.match(before.acceptance.items[0].evidence, /来源：人工顶层报告/)
    })
  })
}
