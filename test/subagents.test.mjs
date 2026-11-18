import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
function reportFor(spec, expectedPoints = []) {
  const report = spec.label.startsWith('测试')
    ? { points: expectedPoints.map((point, index) => ({
      point, result: ['pass', 'fail', 'uncovered'][index % 3], detail: 'fixture evidence',
    })) }
    : { verdict: 'advisory', suggestUpgrade: false, findings: [
      { file: 'src/auth/session.ts', line: 17, severity: 'MINOR', summary: 'fixture finding' },
    ] }
  return { stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(report) }] }
}

function makeHost(options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'flowgate-subagents-'))
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
    'read', 'ops_read_files', 'ops_stat', 'ops_diff', 'ops_grep', 'ops_glob',
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
        if (options.startFails) throw new Error('fixture start failed')
        if (options.receiptGate) await options.receiptGate.promise
        if (!options.manualResult) {
          if (options.executionFails) activation.result.reject(new Error('fixture execution failed'))
          else activation.result.resolve(options.response ? options.response(activation) : reportFor(spec, activation.points))
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
    for (const guard of guards) {
      const verdict = await guard(exec)
      const reason = typeof verdict === 'string' ? verdict : verdict?.reason
      if (reason) return { kind: 'deny', reason }
    }
    return before
  }
  host = {
    cwd, sessionId, parent, activations, guards, oldCalls, providerLookups, fixtureErrors,
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
    async action(action, payload = {}) {
      const route = routes.get('/api/flowgate/action')
      const response = await route.fetch(new Request('http://host/api/flowgate/action', {
        method: 'POST', body: JSON.stringify({ sessionId, action, payload }),
      }))
      const body = await response.json()
      assert.equal(response.status, 200, JSON.stringify(body))
      return body
    },
    async advance(stage = 'S3') {
      await host.call('flowgate_start', { title: '新版子代理黑盒回归', preset: 'fast' })
      const doc = host.call('flowgate_doc', {
        html: '<!doctype html><html><body>fixture requirements</body></html>',
        scope: {
          files_expected_to_change: ['src/auth/session.ts'], capabilities: ['fixture'],
          out_of_scope_explicitly: [], acceptance_criteria: [{ id: 'AC-1', when: '运行', then: '可验证' }],
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
        await host.action('gate', { decision: 'pass' })
        await within(review, '评审完成')
      }
      assert.equal((await host.state()).stage, stage)
    },
    async complete(kind, promise) {
      const field = kind === 'review' ? 'review' : 'test'
      await eventually(async () => {
        const state = await host.state()
        return state[field] && state.waitingKind === 'gate'
      }, field + '报告与门禁')
      const before = await host.state()
      await host.action('gate', { decision: 'pass' })
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
    assert.match(host.activations.find((activation) => activation.spec.label.includes('正确性')).spec.prompt[0].text, /用户定义的开发规则/)
  })
})

await test('新版 test：按方向聚合通过、失败与未覆盖，清理后才进入门禁', async () => {
  await fixture({}, async (host) => {
    await host.advance('S4')
    const added = await host.action('addDirection', { name: '三种验证结果', points: ['主路径', '错误路径', '未覆盖路径'] })
    const custom = added.directions.find((item) => item.name === '三种验证结果')
    for (const direction of added.directions.filter((item) => item.id !== custom.id)) {
      await host.action('toggleDirection', { id: direction.id, enabled: false })
    }
    const { before, value } = await host.complete('test', host.call('flowgate_test_run'))
    assert.equal(host.activations.length, before.directions.length)
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
      const { before } = await host.complete('review', host.call('flowgate_review_run'))
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
    assert.equal(pending.settled, false)
    host.activations[0].result.resolve(reportFor(host.activations[0].spec))
    await eventually(() => host.activations.length === 2, '第二个 activation')
    assert.equal(host.activations[0].disposeCalls, 1)
    assert.equal((await host.state()).review, null)
    host.activations[1].result.resolve(reportFor(host.activations[1].spec))
    const { before } = await host.complete('review', pending.promise)
    assert.equal(before.review.angles.length, 2)
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
    assert.equal((await host.check('ops_bash', { command: 'git diff --stat' }, id, true)).kind, 'deny')
    assert.equal((await host.check('ops_bash', { command: 'git status' }, id, true)).kind, 'deny')
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
    await host.complete('review', pending)
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
    ]) assert.equal((await host.check('run_code', { code, description: 'fixture' }, id, true)).kind, 'deny', code)
    assert.equal((await host.check('run_code', { code: 'return await tools.ops_stat({"path":"x"});', sandbox_permissions: 'danger-full-access' }, id, true)).kind, 'deny')
    for (let index = 0; index < 2; index++) {
      await eventually(() => host.activations.length > index, 'activation ' + index)
      host.activations[index].result.resolve(reportFor(host.activations[index].spec))
    }
    await host.complete('review', pending)
  })
})

for (const granted of [false, true]) {
  await test('S4 写权限例外只覆盖 shell：授权=' + granted, async () => {
    await fixture({ onStart: async (activation, host) => {
      const id = activation.childId
      assert.equal((await host.check('ops_bash', { command: 'touch fixture-output' }, id, true)).kind, granted ? 'allow' : 'deny')
      assert.equal((await host.check('ops_write_file', { path: 'src/auth/session.ts' }, id, true)).kind, 'deny')
      assert.equal((await host.check('unknown_plugin_tool', {}, id, true)).kind, 'deny')
      assert.equal((await host.check('ops_bash', { command: 'pwd', sandbox_permissions: 'danger-full-access' }, id, true)).kind, 'deny')
    } }, async (host) => {
      await host.advance('S4')
      const added = await host.action('addDirection', { name: '迁移回滚', points: ['迁移后回滚'], needsWrite: true })
      const direction = added.directions.find((item) => item.name === '迁移回滚')
      for (const item of added.directions.filter((item) => item.id !== direction.id)) {
        await host.action('toggleDirection', { id: item.id, enabled: false })
      }
      if (granted) await host.action('toggleWriteGrant', { id: direction.id, enabled: true })
      const { before } = await host.complete('test', host.call('flowgate_test_run'))
      assert.equal(host.activations.length, 1)
      assert.equal(before.test.directions[0].id, direction.id)
    })
  })
}

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
        const { before } = await host.complete(kind, host.call('flowgate_' + kind + '_run'))
        const report = before[kind]
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
    assert.equal((await host.check('ops_write_file', { path: 'x' }, first.childId, true)).kind, 'deny')
    assert.equal((await host.state()).review, null)
    assert.equal(host.activations.length, 1)
    assert.equal(pending.settled, false)
    disposeGate.resolve()
    await host.complete('review', pending.promise)
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
  await test('S4 已授权方向失败后撤销 shell 写例外并保留隔离：' + failure, async () => {
    await fixture({ [failure]: true, onStart: async (activation, host) => {
      assert.equal((await host.check('ops_bash', { command: 'touch fixture-output' }, activation.childId, true)).kind, 'allow')
    } }, async (host) => {
      await host.advance('S4')
      const added = await host.action('addDirection', { name: '授权失败方向', points: ['执行并回滚'], needsWrite: true })
      const custom = added.directions.find((direction) => direction.name === '授权失败方向')
      for (const direction of added.directions.filter((direction) => direction.id !== custom.id)) {
        await host.action('toggleDirection', { id: direction.id, enabled: false })
      }
      await host.action('toggleWriteGrant', { id: custom.id, enabled: true })
      const pending = host.call('flowgate_test_run')
      await eventually(async () => Boolean((await host.state()).test), '失败方向报告')
      assert.equal((await host.state()).stage, 'S4')
      assert.equal(host.activations.length, 1)
      const activation = host.activations[0]
      assert.equal(activation.stopped, false)
      assert.equal((await host.check('ops_write_file', { path: 'x' }, activation.childId, true)).kind, 'deny')
      assert.equal((await host.check('ops_bash', { command: 'touch fixture-output' }, activation.childId, true)).kind, 'deny', '失败后即使父流程仍在 S4 也不能保留变更性 shell')
      assert.match(JSON.stringify((await host.state()).test), /fixture (start|cleanup) failed/)
      await host.complete('test', pending)
      assert.equal((await host.check('ops_bash', { command: 'touch fixture-output' }, activation.childId, true)).kind, 'deny')
    })
  })
}

await test('夹具内断言不能被生产降级逻辑吞掉', async () => {
  await assert.rejects(fixture({ onStart: () => assert.fail('fixture assertion sentinel') }, async (host) => {
    await host.advance()
    await host.complete('review', host.call('flowgate_review_run'))
  }), /fixture assertion sentinel/)
})

for (const kind of ['review', 'test']) {
  await test(kind + ' 接收 structured 报告，不依赖文本 JSON', async () => {
    await fixture({ response: (activation) => ({
      stopReason: 'completed',
      structured: JSON.parse(reportFor(activation.spec, activation.points).output[0].text),
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

for (const [name, report] of [
  ['缺字段', {}],
  ['findings 非数组', { verdict: 'pass', findings: {} }],
  ['未知 verdict', { verdict: 'unknown', findings: [] }],
  ['未知 severity', { verdict: 'pass', findings: [{ file: 'x', severity: 'UNKNOWN', summary: 'x' }] }],
]) {
  await test('合法 JSON 的坏评审结构也降级：' + name, async () => {
    await fixture({ response: () => ({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(report) }] }) }, async (host) => {
      await host.advance()
      const { before } = await host.complete('review', host.call('flowgate_review_run'))
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

for (const kind of ['review', 'test']) for (const cancellation of ['signal', 'flowgate_cancel', 'rollback']) {
  await test(kind + '运行中取消并等待清理：' + cancellation, async () => {
    const disposeGate = defer()
    const controller = new AbortController()
    await fixture({ manualResult: true, disposeGate }, async (host) => {
      await host.advance(kind === 'review' ? 'S3' : 'S4')
      if (kind === 'test') {
        const added = await host.action('addDirection', { name: '正在测试', points: ['授权命令'], needsWrite: true })
        const custom = added.directions.find((direction) => direction.name === '正在测试')
        for (const direction of added.directions.filter((direction) => direction.id !== custom.id)) {
          await host.action('toggleDirection', { id: direction.id, enabled: false })
        }
        await host.action('toggleWriteGrant', { id: custom.id, enabled: true })
        await host.action('addDirection', { name: '稍后方向', points: ['不能继续启动'] })
      }
      const pending = observe(host.call('flowgate_' + kind + '_run', {}, { signal: controller.signal }))
      await eventually(() => host.activations.length === 1, '子代理运行中')
      const activation = host.activations[0]
      if (kind === 'test') assert.equal((await host.check('ops_bash', { command: 'touch fixture-output' }, activation.childId, true)).kind, 'allow')
      let request
      if (cancellation === 'signal') controller.abort()
      else if (cancellation === 'flowgate_cancel') request = host.call('flowgate_cancel', { reason: 'fixture cancellation' })
      else request = host.action('gate', { decision: 'back', to: 'S2' })
      request?.catch(() => {})
      await eventually(() => activation.disposeCalls === 1, '取消触发 dispose')
      assert.equal((await host.check('ops_write_file', { path: 'x' }, activation.childId, true)).kind, 'deny', '父流程已结束或回退也要保护清理中的子会话')
      if (kind === 'test') assert.equal((await host.check('ops_bash', { command: 'touch fixture-output' }, activation.childId, true)).kind, 'deny', '取消后清理期间必须撤销先前 shell 写授权')
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
      if (cancellation === 'rollback') assert.equal(state.stage, 'S2')
      if (cancellation === 'flowgate_cancel') assert.equal(state.cancelled, true)
    })
  })
}
