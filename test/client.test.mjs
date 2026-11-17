import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import React from 'react'
import TestRenderer from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const require = createRequire(import.meta.url)
const { act } = TestRenderer
const h = React.createElement

// ---------------------------------------------------------------------------
// 浏览器环境替身：只提供客户端 bundle 真正用到的几个全局
// ---------------------------------------------------------------------------

const styleNodes = []
globalThis.document = {
  adoptedStyleSheets: [],
  head: { appendChild(node) { styleNodes.push(node) } },
  getElementById() { return null },
  createElement() { return { id: '', textContent: '' } },
}
globalThis.CSSStyleSheet = undefined

let plugin = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) { plugin = entry.factory(require) },
  },
}

await import('../lib/client.js')

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ ok: true, name })
  } catch (error) {
    results.push({ ok: false, name, message: error?.message ?? String(error) })
  }
}

function texts(node, out = []) {
  if (node == null) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (node.children) texts(node.children, out)
  return out
}

function flat(node) {
  return texts(node).join(' ')
}

function buttons(node, out = []) {
  if (node == null) return out
  if (Array.isArray(node)) {
    for (const child of node) buttons(child, out)
    return out
  }
  if (node.type === 'button') out.push(node)
  if (node.children) buttons(node.children, out)
  return out
}

function buttonByText(tree, needle) {
  const found = buttons(tree).find((node) => flat(node).includes(needle))
  assert.ok(found, '找不到按钮：' + needle)
  return found
}

function stagesFor(stage) {
  const ids = ['S1', 'S2', 'S3', 'S4']
  const labels = ['需求分析', '开发', '评审', '测试']
  const outputs = ['需求文档 + scope.json', '代码变更', '评审报告', '测试报告']
  const index = ids.indexOf(stage)
  return ids.map((id, i) => ({
    id,
    label: labels[i],
    output: outputs[i],
    status: i < index ? 'passed' : i === index ? 'active' : 'pending',
    skipped: false,
  }))
}

function baseView(stage, patch = {}) {
  return {
    active: true,
    id: 'flow-1',
    title: '会话过期检测',
    stage,
    finished: false,
    preset: 'fast',
    presetInfo: { label: '小功能快速开发', summary: '两个评审角度 + 一个测试方向' },
    presets: {
      fast: { label: '小功能快速开发', summary: '两个评审角度 + 一个测试方向' },
      strict: { label: '大需求严格执行', summary: '四个评审角度 + 三个测试方向' },
    },
    stages: stagesFor(stage),
    skippedCount: 0,
    scope: {
      frozen: true,
      frozenAt: '2026-11-17T10:00:00Z',
      withoutDocApproval: false,
      data: {
        version: 1,
        frozen_at: '2026-11-17T10:00:00Z',
        in_scope: { files_expected_to_change: ['src/auth/session.ts'], capabilities: ['会话过期检测'] },
        out_of_scope_explicitly: ['OAuth 第三方登录'],
        acceptance_criteria: [{ id: 'AC-1', when: '会话超过 30 分钟未活动', then: '返回 401' }],
      },
    },
    doc: { html: null, recommendedPreset: 'fast', reason: '只改两个文件', at: null, pending: false },
    grill: { pending: null, answeredCount: 0, awaiting: false },
    angles: [{ id: 'correctness', name: '正确性', points: ['边界条件'] }],
    angleCatalog: [
      { id: 'correctness', name: '正确性', points: ['边界条件'] },
      { id: 'test-quality', name: '测试质量', points: ['覆盖失败路径'] },
      { id: 'security', name: '安全', points: ['凭据处理'] },
    ],
    directions: [{ id: 'smoke', name: '冒烟验证', points: ['主路径可用'] }],
    directionCatalog: [
      { id: 'smoke', name: '冒烟验证', points: ['主路径可用'] },
      { id: 'regression', name: '回归影响', points: ['旧用例不退化'] },
    ],
    review: null,
    test: null,
    devChanges: null,
    waiting: false,
    waitingKind: null,
    canSpawn: true,
    createdAt: '2026-11-17T09:00:00Z',
    updatedAt: '2026-11-17T09:30:00Z',
    ...patch,
  }
}

let currentView = null
let posted = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/action')) {
    posted.push(JSON.parse(init.body))
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  return { ok: true, status: 200, json: async () => currentView }
}

const mounted = []
let seq = 0
async function render(Component, props, withSession = true) {
  const input = withSession ? { ...(props || {}), sessionId: 's' + (++seq) } : (props || {})
  let renderer = null
  await act(async () => {
    renderer = TestRenderer.create(h(Component, input))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  mounted.push(renderer)
  return renderer
}

async function click(node) {
  await act(async () => {
    node.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
}

// ---------------------------------------------------------------------------
// 1. 模块契约
// ---------------------------------------------------------------------------

await check('模块导出 name / inject / apply', () => {
  assert.equal(plugin.name, 'dsh-flowgate')
  assert.deepEqual(plugin.inject, ['slots'])
  assert.equal(typeof plugin.apply, 'function')
})

const registrations = []
plugin.apply({
  slots: {
    inject(_name, callback) { callback() },
    register(options, Component) { registrations.push({ options, Component }) },
  },
})

await check('apply 注册 conversation.view 与 conversation.input.dock', () => {
  assert.equal(registrations.length, 2)
  assert.equal(registrations[0].options.name, 'conversation.view')
  assert.equal(registrations[0].options.id, 'flowgate')
  assert.equal(registrations[0].options.label(), '流程工作台')
  assert.equal(registrations[1].options.name, 'conversation.input.dock')
  assert.equal(registrations[1].options.id, 'flowgate-dock')
})

await check('样式只注入一次', () => {
  assert.equal(styleNodes.length, 1)
  assert.ok(styleNodes[0].textContent.includes('.fg-root'))
})

const WorkbenchView = registrations[0].Component
const FlowgateDock = registrations[1].Component

// ---------------------------------------------------------------------------
// 2. 空态
// ---------------------------------------------------------------------------

{
  const renderer = await render(WorkbenchView, {}, false)
  await check('没有 sessionId 时不渲染任何东西', () => {
    assert.equal(renderer.toJSON(), null)
  })
}

{
  currentView = null
  const renderer = await render(WorkbenchView, {})
  await check('拿不到宿主状态时提示正在连接', () => {
    assert.ok(flat(renderer.toJSON()).includes('正在连接宿主端'))
  })
}

{
  currentView = { active: false, presets: {}, builtinAngles: [], builtinDirections: [] }
  const renderer = await render(WorkbenchView, {})
  await check('流程未启动时给出如何开始的说明', () => {
    const text = flat(renderer.toJSON())
    assert.ok(text.includes('当前会话还没有流程'))
    assert.ok(text.includes('flowgate_start'))
  })
}

// ---------------------------------------------------------------------------
// 3. S1：追问卡片（按钮化）
// ---------------------------------------------------------------------------

{
  posted = []
  currentView = baseView('S1', {
    grill: {
      pending: {
        id: 'q_1',
        question: '过期判定用滑动窗口还是绝对时间？',
        context: '影响是否需要额外的活动时间戳字段。',
        options: [
          { label: '滑动窗口', tradeoff: '语义更贴近“30 分钟未活动”，需要多存一个时间戳。' },
          { label: '绝对时间', tradeoff: '实现最省，但与需求描述不一致。' },
        ],
        recommended: 0,
        allowCustom: true,
        at: '2026-11-17T09:10:00Z',
      },
      answeredCount: 2,
      awaiting: true,
    },
    waiting: true,
    waitingKind: 'answer',
  })
  const renderer = await render(WorkbenchView, {})
  const tree = renderer.toJSON()
  const text = flat(tree)

  await check('S1 追问卡片显示问题、上下文与已回答数', () => {
    assert.ok(text.includes('过期判定用滑动窗口还是绝对时间？'))
    assert.ok(text.includes('影响是否需要额外的活动时间戳字段。'))
    assert.ok(text.includes('已回答 2 个决策问题'))
  })

  await check('推荐选项排第一并标注推荐', () => {
    const first = buttonByText(tree, '滑动窗口')
    assert.ok(flat(first).includes('滑动窗口'))
    assert.ok(flat(first).includes('推荐'))
    assert.ok(first.props.className.includes('rec'))
  })

  await check('点选项即提交，不需要键盘输入', async () => {
    await click(buttonByText(tree, '滑动窗口'))
    assert.equal(posted.length, 1)
    assert.equal(posted[0].action, 'answer')
    assert.equal(posted[0].payload.choiceIndex, 0)
    assert.equal(posted[0].payload.customText, '')
  })
}

// ---------------------------------------------------------------------------
// 4. S1：需求文档门禁
// ---------------------------------------------------------------------------

{
  posted = []
  currentView = baseView('S1', {
    doc: {
      html: '<html><body>需求文档</body></html>',
      recommendedPreset: 'fast',
      reason: '只改两个文件，一个验收标准',
      at: '2026-11-17T09:20:00Z',
      pending: true,
    },
    waiting: true,
    waitingKind: 'doc',
  })
  const renderer = await render(WorkbenchView, {})
  const tree = renderer.toJSON()
  const text = flat(tree)

  await check('需求文档以 iframe 预览渲染', () => {
    const iframe = JSON.stringify(tree)
    assert.ok(iframe.includes('iframe'))
    assert.ok(iframe.includes('需求文档'))
  })

  await check('文档底部给出档位选择与推荐理由', () => {
    assert.ok(text.includes('推荐理由：只改两个文件，一个验收标准'))
    assert.ok(text.includes('小功能快速开发'))
    assert.ok(text.includes('大需求严格执行'))
  })

  await check('门禁面板给出批准 / 修改 / 跳过三个按钮', () => {
    assert.ok(buttonByText(tree, '批准并冻结 scope'))
    assert.ok(buttonByText(tree, '修改需求'))
    assert.ok(buttonByText(tree, '跳过评审，直接开发'))
  })

  await check('点「批准并冻结 scope」提交 doc/approve', async () => {
    await click(buttonByText(renderer.toJSON(), '批准并冻结 scope'))
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'doc')
    assert.equal(last.payload.decision, 'approve')
  })
}

// ---------------------------------------------------------------------------
// 5. S2：开发
// ---------------------------------------------------------------------------

{
  posted = []
  currentView = baseView('S2', {
    devChanges: { files: ['src/auth/session.ts'], added: 42, removed: 7, at: '2026-11-17T09:40:00Z' },
    waiting: true,
    waitingKind: 'gate',
  })
  const renderer = await render(WorkbenchView, {})
  const tree = renderer.toJSON()
  const text = flat(tree)

  await check('S2 显示自动采集的变更摘要', () => {
    assert.ok(text.includes('+42'))
    assert.ok(text.includes('-7'))
    assert.ok(text.includes('src/auth/session.ts'))
  })

  await check('S2 显示冻结 scope 的白名单与越界清单', () => {
    assert.ok(text.includes('OAuth 第三方登录'))
    assert.ok(text.includes('会话过期检测'))
  })

  await check('S2 门禁按钮可点并提交 gate/pass', async () => {
    await click(buttonByText(tree, '完成开发'))
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'gate')
    assert.equal(last.payload.decision, 'pass')
  })

  await check('S2 提供回到需求分析调整 scope 的入口', () => {
    assert.ok(buttonByText(renderer.toJSON(), '回到需求分析调整 scope'))
  })
}

// ---------------------------------------------------------------------------
// 6. S3：评审报告
// ---------------------------------------------------------------------------

{
  posted = []
  currentView = baseView('S3', {
    preset: 'strict',
    presetInfo: { label: '大需求严格执行', summary: '四个评审角度 + 三个测试方向' },
    review: {
      blocking: 1,
      by: 'subagents',
      at: '2026-11-17T10:10:00Z',
      angles: [
        {
          id: 'correctness',
          name: '正确性',
          verdict: 'blocking',
          suggestUpgrade: false,
          findings: [
            { file: 'src/auth/session.ts', line: 88, severity: 'CRITICAL', summary: '过期判断用了客户端时间' },
          ],
        },
        { id: 'test-quality', name: '测试质量', verdict: 'pass', findings: [] },
      ],
    },
    waiting: true,
    waitingKind: 'gate',
  })
  const renderer = await render(WorkbenchView, {})
  const tree = renderer.toJSON()
  const text = flat(tree)

  await check('S3 按角度聚合评审报告', () => {
    assert.ok(text.includes('正确性'))
    assert.ok(text.includes('有阻塞项'))
    assert.ok(text.includes('1 个阻塞项'))
    assert.ok(text.includes('测试质量'))
    assert.ok(text.includes('该角度没有发现'))
  })

  await check('S3 每条发现带 file:line 与 severity', () => {
    assert.ok(text.includes('src/auth/session.ts:88'))
    assert.ok(text.includes('CRITICAL'))
    assert.ok(text.includes('过期判断用了客户端时间'))
  })

  await check('S3 门禁给出通过 / 退回 / 跳过', () => {
    assert.ok(buttonByText(tree, '通过评审，进入测试'))
    assert.ok(buttonByText(tree, '退回开发修复'))
    assert.ok(buttonByText(tree, '跳过评审，直接测试'))
  })

  await check('S3 点「退回开发修复」提交 gate/back S2', async () => {
    await click(buttonByText(renderer.toJSON(), '退回开发修复'))
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'gate')
    assert.equal(last.payload.decision, 'back')
    assert.equal(last.payload.to, 'S2')
  })

  await check('升档按钮只在 fast 档出现', () => {
    assert.ok(!flat(renderer.toJSON()).includes('升档到大需求严格执行'))
  })
}

// ---------------------------------------------------------------------------
// 7. S4：测试报告
// ---------------------------------------------------------------------------

{
  posted = []
  currentView = baseView('S4', {
    test: {
      failed: 1,
      by: 'subagents',
      at: '2026-11-17T10:30:00Z',
      directions: [
        {
          id: 'smoke',
          name: '冒烟验证',
          points: [
            { point: '主路径可用', result: 'pass' },
            { point: '过期后返回 401', result: 'fail', detail: '返回了 500' },
          ],
        },
        { id: 'regression', name: '回归影响', points: [{ point: '旧用例不退化', result: 'uncovered' }] },
      ],
    },
    waiting: true,
    waitingKind: 'gate',
  })
  const renderer = await render(WorkbenchView, {})
  const tree = renderer.toJSON()
  const text = flat(tree)

  await check('S4 按方向分组展示要点结果', () => {
    assert.ok(text.includes('冒烟验证'))
    assert.ok(text.includes('1 项失败'))
    assert.ok(text.includes('通过'))
    assert.ok(text.includes('失败'))
    assert.ok(text.includes('未覆盖'))
    assert.ok(text.includes('返回了 500'))
  })

  await check('S4 门禁给出验收 / 退回 / 跳过', () => {
    assert.ok(buttonByText(tree, '验收通过，结束流程'))
    assert.ok(buttonByText(tree, '退回开发修复'))
    assert.ok(buttonByText(tree, '跳过测试门禁'))
  })

  await check('S4 点「验收通过」提交 gate/pass', async () => {
    await click(buttonByText(renderer.toJSON(), '验收通过，结束流程'))
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'gate')
    assert.equal(last.payload.decision, 'pass')
  })
}

// ---------------------------------------------------------------------------
// 8. 台账、等待态、设置面板
// ---------------------------------------------------------------------------

{
  currentView = baseView('S2', {
    skippedCount: 1,
    stages: stagesFor('S2').map((stage) => (stage.id === 'S1' ? { ...stage, status: 'skipped_by_user', skipped: true } : stage)),
    waiting: false,
  })
  const renderer = await render(WorkbenchView, {})
  const tree = renderer.toJSON()
  const text = flat(tree)

  await check('顶部台账显示跳过计数', () => {
    assert.ok(text.includes('本流程有 1 个阶段被跳过'))
  })

  await check('被跳过的阶段在导航条里显示已跳过', () => {
    assert.ok(text.includes('已跳过'))
  })

  await check('门禁未就绪时按钮不可点并给出说明', () => {
    const node = buttonByText(tree, '完成开发')
    assert.equal(node.props.disabled, true)
    assert.ok(text.includes('门禁未就绪'))
  })
}

{
  currentView = baseView('S1', { preset: 'fast' })
  const renderer = await render(WorkbenchView, {})
  const text = flat(renderer.toJSON())
  await check('S1 阶段提供升档按钮', () => {
    assert.ok(text.includes('升档到大需求严格执行'))
  })
}

{
  currentView = baseView('S2')
  const renderer = await render(WorkbenchView, {})
  const tree = renderer.toJSON()
  const text = flat(tree)
  await check('设置面板列出可勾选的角度与方向', () => {
    assert.ok(text.includes('阶段设置'))
    assert.ok(text.includes('评审角度'))
    assert.ok(text.includes('测试方向'))
    assert.ok(text.includes('追加自定义角度'))
    assert.ok(text.includes('追加自定义方向'))
  })
}

{
  posted = []
  currentView = baseView('S3', { waiting: true, waitingKind: 'gate' })
  const renderer = await render(WorkbenchView, {})
  const boxes = []
  const walk = (node) => {
    if (!node) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.type === 'input' && node.props.type === 'checkbox') boxes.push(node)
    if (node.children) walk(node.children)
  }
  walk(renderer.toJSON())
  await check('勾选评审角度会提交 toggleAngle', async () => {
    assert.ok(boxes.length >= 3, '应至少有三个角度勾选框，实际 ' + boxes.length)
    const target = boxes.find((node) => node.props.checked === false)
    await act(async () => {
      target.props.onChange({ target: { checked: true } })
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'toggleAngle')
    assert.equal(last.payload.enabled, true)
  })
}

{
  // D2：v1 唯一的写权限例外——只对声明 needsWrite 的方向、只在 S4、只由用户显式勾选。
  posted = []
  currentView = baseView('S4', {
    directions: [{ id: 'mig', name: '迁移回滚', points: ['回滚可恢复'], needsWrite: true, writeGranted: false }],
    directionCatalog: [{ id: 'mig', name: '迁移回滚', points: ['回滚可恢复'], needsWrite: true }],
  })
  const renderer = await render(WorkbenchView, {})
  const boxes = []
  const walk = (node) => {
    if (!node) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.type === 'input' && node.props.type === 'checkbox') boxes.push(node)
    if (node.children) walk(node.children)
  }
  walk(renderer.toJSON())
  const text = flat(renderer.toJSON())
  await check('S1 追问卡片的跳过按钮不放行追问', async () => {
  currentView = baseView('S1', {
    grill: { pending: { id: 'q-skip', question: '过期后是否强制重新登录？', options: [{ label: '强制重新登录', tradeoff: '更安全' }], recommended: 0 }, answeredCount: 0 },
  })
  posted = []
  const tree = await render(WorkbenchView, {})
  const skip = buttonByText(tree.toJSON(), '跳过')
  await click(skip)
  assert.equal(posted.length, 0, '跳过不能提交任何动作')
  const text = flat(tree.toJSON())
  assert.ok(text.includes('跳过不会放行追问'), '必须说明跳过不放行')
})

await check('点「修改需求」后回到追问流程并说明下一步', async () => {
  currentView = baseView('S1', { doc: { html: null, revisedAt: '2026-11-17T10:00:00Z' } })
  const tree = await render(WorkbenchView, {})
  const text = flat(tree.toJSON())
  assert.ok(text.includes('你点了「修改需求」'))
})

await check('D2 声明写权限的方向在 S4 出现授权勾选', () => {
    assert.ok(text.includes('授权执行变更性命令'))
    const grant = boxes.find((node) => node.props.disabled === false && node.props.checked === false)
    assert.ok(grant, 'S4 下必须有一个可用的授权勾选框')
  })
  await check('D2 勾选授权提交 toggleWriteGrant', async () => {
    const grant = boxes.find((node) => node.props.disabled === false && node.props.checked === false)
    await act(async () => {
      grant.props.onChange({ target: { checked: true } })
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    const call = posted.find((item) => item.action === 'toggleWriteGrant')
    assert.ok(call, '必须提交 toggleWriteGrant')
    assert.equal(call.payload.id, 'mig')
    assert.equal(call.payload.enabled, true)
  })
}

{
  currentView = baseView('S2', {
    directions: [{ id: 'mig', name: '迁移回滚', points: ['回滚可恢复'], needsWrite: true, writeGranted: false }],
    directionCatalog: [{ id: 'mig', name: '迁移回滚', points: ['回滚可恢复'], needsWrite: true }],
  })
  const renderer = await render(WorkbenchView, {})
  const text = flat(renderer.toJSON())
  await check('D2 非 S4 阶段授权勾选被禁用并说明原因', () => {
    assert.ok(text.includes('写权限例外只在 S4 测试阶段开放'))
  })
}

// ---------------------------------------------------------------------------
// 9. 输入区上方的常驻条
// ---------------------------------------------------------------------------

{
  currentView = baseView('S3', { waiting: true, waitingKind: 'gate' })
  const renderer = await render(FlowgateDock, {})
  const text = flat(renderer.toJSON())
  await check('dock 显示当前阶段与等待状态', () => {
    assert.ok(text.includes('S3 评审'))
    assert.ok(text.includes('门禁等你点击确认'))
  })
}

{
  currentView = { active: false }
  const renderer = await render(FlowgateDock, {})
  await check('流程未启动时 dock 不渲染', () => {
    assert.equal(renderer.toJSON(), null)
  })
}

{
  currentView = baseView('S4', { finished: true, skippedCount: 2 })
  const renderer = await render(FlowgateDock, {})
  const text = flat(renderer.toJSON())
  await check('流程结束后 dock 显示已结束与跳过计数', () => {
    assert.ok(text.includes('流程已结束'))
    assert.ok(text.includes('已跳过 2 个阶段'))
  })
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

for (const renderer of mounted) {
  await act(async () => { renderer.unmount() })
}

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log((item.ok ? 'ok   ' : 'FAIL ') + item.name + (item.ok ? '' : ' → ' + item.message))
}
console.log('')
console.log(failed.length === 0
  ? '全部通过：' + results.length + ' 项'
  : failed.length + ' / ' + results.length + ' 项失败')
process.exit(failed.length === 0 ? 0 : 1)
