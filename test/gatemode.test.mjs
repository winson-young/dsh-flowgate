import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
      if (name === 'sessions') return { get: (id) => ({ header: { id, cwd } }) }
      if (name === 'agents') return { get: (id) => ({ followup: () => {} }) }
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
  apply({ inject: (_names, cb) => cb(scoped) })

  const execOf = (name, args, signal) => ({
    name,
    arguments: args,
    agent: { session: { header: { id: sessionId, cwd } } },
    signal,
  })

  // flowgate_doc 必须交代追问结果；这套用例验门禁模式，追问内容给一份默认清单。
  const GRILL = {
    decisions: [{ question: '这次要改到什么程度？', answer: '把追问纪律写进工具文案与提交校验' }],
    assumptions: [],
    open_questions: [],
  }
  const tool = (name, args, opts = {}) => {
    const definition = tools.get(name)
    assert.ok(definition, '工具未注册：' + name)
    const prepared = name === 'flowgate_doc' ? { ...GRILL, ...args } : args
    return definition.execute(prepared, execOf(name, prepared, opts.signal))
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
  command_sources: [{ command: 'node --test test/app.test.mjs', from: 'package.json scripts.test', acs: ['AC-1'] }],
  capabilities: [],
  out_of_scope_explicitly: [],
  acceptance_criteria: [
    {
      id: 'AC-1',
      when: '改完 src/app.js',
      then: 'node --test 通过',
      verification: { method: 'unit', procedure: '跑 node --test test/app.test.mjs' },
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
  // 缺口在提交这一步就退回给 Agent：自动模式只是少了「等人点确认」，
  // 不会把一份体检不过的 scope 端到批准按钮前。
  await assert.rejects(
    () => host.tool('flowgate_doc', { html: '<p>需求</p>', scope: cleanScope({ commands: [] }) }),
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

console.log('\n全部通过：' + passed + ' 项')
if (failures.length) {
  console.log('失败：' + failures.length + ' 项')
  for (const item of failures) console.log(' - ' + item.name + '：' + (item.error?.stack ?? item.error))
  process.exitCode = 1
}
