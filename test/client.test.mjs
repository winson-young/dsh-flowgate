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

function findTags(node, tag, out = []) {
  if (node == null) return out
  if (Array.isArray(node)) {
    for (const child of node) findTags(child, tag, out)
    return out
  }
  if (node.type === tag) out.push(node)
  if (node.children) for (const child of node.children) findTags(child, tag, out)
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
    rules: [
      { id: 'scope-only', name: '只改 scope 内的文件', points: ['不新增 scope 之外的文件'] },
      { id: 'no-debug-leftovers', name: '不留调试残留', points: ['不留 console.log / debugger'] },
    ],
    ruleIds: ['scope-only', 'no-debug-leftovers'],
    ruleCatalog: [
      { id: 'scope-only', name: '只改 scope 内的文件', points: ['不新增 scope 之外的文件'] },
      { id: 'no-debug-leftovers', name: '不留调试残留', points: ['不留 console.log / debugger'] },
      { id: 'match-style', name: '与既有代码风格一致', points: ['命名习惯一致'] },
    ],
    review: null,
    reviewOutsideScope: [],
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
  // 宿主同槽条目 order 升序：任务 0、目标 10、排队 20；取 15 才贴在输入框上方。
  assert.equal(registrations[1].options.order, 15)
})

await check('样式只注入一次', () => {
  assert.equal(styleNodes.length, 1)
  assert.ok(styleNodes[0].textContent.includes('.fg-root'))
})

await check('样式不写死颜色，全部走 DSH 主题 token', () => {
  const css = styleNodes[0].textContent
  const literal = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? []
  assert.deepEqual(literal, [], '不得出现颜色字面量：' + literal.join(', '))
  // 只允许 ui-theme 真正定义的 alias 名；写错名字会静默失效（var() 取不到值即继承/透明）。
  const KNOWN = new Set([
    'label-primary', 'label-secondary', 'label-tertiary', 'label-caption',
    'label-primary-inverted', 'label-primary-foreground',
    'bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-layer-3', 'bg-overlay',
    'border-l1', 'border-l2', 'border-l3', 'border-l4',
    'brand-primary', 'brand-text', 'button-primary-hover',
    'state-error-primary', 'state-error-secondary',
    'state-success-primary', 'state-success-secondary', 'state-success-tertiary',
    'state-warn-primary', 'state-warn-secondary', 'state-warn-tertiary', 'state-warn-label',
    'state-business-primary', 'state-business-tertiary',
    'interactive-bg-hover', 'interactive-bg-hover-accent', 'interactive-bg-hover-danger',
  ])
  const used = [...new Set((css.match(/var\(--dsw-alias-([a-z0-9-]+)/g) ?? [])
    .map((s) => s.replace('var(--dsw-alias-', '')))]
  const unknown = used.filter((name) => !KNOWN.has(name))
  assert.deepEqual(unknown, [], '用到了 ui-theme 未定义的 token：' + unknown.join(', '))
  assert.ok(used.length > 8, '样式应当大量复用主题 token')
})

const WorkbenchView = registrations[0].Component
const FlowgateDock = registrations[1].Component

// ---------------------------------------------------------------------------
// 1b. 滚动归属：视图必须声明自己拥有滚动条
// ---------------------------------------------------------------------------

await check('三种状态下的根节点都声明 data-conversation-composer-overlay', async () => {
  // 没有这个属性时 ConversationRoot 仍把 .scrollBody 当滚动容器，.viewArea 是
  // flex:1 0 auto + min-height:auto，.fg-root 的 height:100% 解析成 auto、内容整个摊开；
  // 切到本 tab 就会继承聊天视图留下的 scrollTop 并被 clamp 到最底部。
  const seen = []
  for (const view of [null, { active: false, presets: {} }, baseView('S2')]) {
    currentView = view
    const renderer = await render(WorkbenchView, {})
    const root = renderer.toJSON()
    seen.push(root?.props?.['data-conversation-composer-overlay'])
  }
  assert.deepEqual(seen, ['', '', ''], '根节点必须带 data-conversation-composer-overlay（值为空串）')
})

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
  posted = []
  currentView = {
    active: false,
    presets: {
      fast: { label: '小功能快速开发', summary: '两个评审角度 + 一个测试方向' },
      strict: { label: '大需求严格执行', summary: '四个评审角度 + 三个测试方向' },
    },
    builtinAngles: [],
    builtinDirections: [],
  }
  const renderer = await render(WorkbenchView, {})
  await check('流程未启动时可以直接在界面启动', () => {
    const text = flat(renderer.toJSON())
    assert.ok(text.includes('当前会话还没有流程'))
    // Agent 仍然是可用路径，只是不再是唯一路径。
    assert.ok(text.includes('flowgate_start'))
    assert.ok(text.includes('开始一次新流程'))
    assert.ok(text.includes('小功能快速开发'))
  })
  const areas = () => findTags(renderer.toJSON(), 'textarea')
  await check('空态给的是需求描述输入框，不是只能填标题', () => {
    assert.ok(flat(renderer.toJSON()).includes('需求描述'))
    const found = areas()
    assert.equal(found.length, 1, '必须有一个多行的需求描述输入框')
    assert.equal(found[0].props.rows, 4)
  })
  await check('需求描述为空时按钮不可点，点也不发请求', async () => {
    const button = buttonByText(renderer.toJSON(), '开始需求分析')
    assert.equal(button.props.disabled, true, '空需求时启动按钮应当禁用')
    await click(button)
    assert.equal(posted.length, 0, '空需求不该发出 start')
  })
  await check('点「开始需求分析」发出 start 动作（标题可以留空）', async () => {
    // 先把需求写进去：这段文字会随 start 一起提交，宿主用它派生标题。
    const area = areas()[0]
    await act(async () => {
      area.props.onChange({ target: { value: '会话过期返回 401，并给出重新认证入口\n第二行补充说明' } })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    const last = posted.at(-1)
    assert.equal(last.action, 'start')
    assert.equal(last.payload.preset, 'fast')
    assert.equal(last.payload.title, '')
    assert.equal(last.payload.brief, '会话过期返回 401，并给出重新认证入口\n第二行补充说明')
  })
  await check('先切档位再启动，请求里带上选择的档位', async () => {
    await click(buttonByText(renderer.toJSON(), '大需求严格执行'))
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.equal(posted.at(-1).payload.preset, 'strict')
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

  await check('S2 显示开发规则检查清单', () => {
    assert.ok(text.includes('开发规则检查清单'))
    assert.ok(text.includes('只改 scope 内的文件'))
    assert.ok(text.includes('逐条核对'))
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

// 未跟踪文件是开发阶段的常态：git diff --numstat 看不见它们，摘要必须单独标出来。
{
  currentView = baseView('S2', {
    devChanges: {
      files: ['src/auth/session.ts', 'src/auth/new-helper.ts'],
      untracked: ['src/auth/new-helper.ts'],
      added: 42,
      removed: 7,
      at: '2026-11-17T09:40:00Z',
    },
    waiting: true,
    waitingKind: 'gate',
  })
  const renderer = await render(WorkbenchView, {})
  const tree = renderer.toJSON()
  const text = flat(tree)

  await check('S2 摘要把未跟踪文件标为新增', () => {
    assert.ok(text.includes('1 个新增'))
    assert.ok(text.includes('新增'))
    assert.ok(text.includes('src/auth/new-helper.ts'))
  })
}

// 采集失败不等于没有变更：原因必须原样显示，否则空摘要会被误读成「什么都没改」。
{
  currentView = baseView('S2', {
    devChanges: {
      files: [],
      untracked: [],
      added: 0,
      removed: 0,
      at: '2026-11-17T09:40:00Z',
      error: '宿主没有可用的 shell 服务，无法自动采集变更摘要。',
    },
    waiting: true,
    waitingKind: 'gate',
  })
  const renderer = await render(WorkbenchView, {})
  const text = flat(renderer.toJSON())

  await check('S2 采集失败时显示宿主给的原因', () => {
    assert.ok(text.includes('无法自动采集变更摘要'))
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

  await check('设置面板列出开发规则并可追加自定义规则', () => {
    assert.ok(text.includes('开发规则'))
    assert.ok(text.includes('与既有代码风格一致'))
    assert.ok(text.includes('追加自定义开发规则'))
  })

  await check('勾选开发规则会提交 toggleRule', async () => {
    const boxes = []
    const walk = (node) => {
      if (!node) return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (node.type === 'input' && node.props.type === 'checkbox') boxes.push(node)
      if (node.children) walk(node.children)
    }
    walk(renderer.toJSON())
    const target = boxes.find((node) => node.props['aria-label'] === '与既有代码风格一致')
    assert.ok(target, '找不到开发规则的勾选框')
    assert.equal(target.props.checked, false)
    await act(async () => {
      target.props.onChange({ target: { checked: true } })
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'toggleRule')
    assert.equal(last.payload.id, 'match-style')
    assert.equal(last.payload.enabled, true)
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
// 8.5 D4：scope 外的评审发现要给出「得回 S1」的指引
// ---------------------------------------------------------------------------

{
  currentView = baseView('S3', {
    review: {
      angles: [{ id: 'security', name: '安全', verdict: 'blocking', findings: [
        { file: 'src/config/secrets.ts', line: 7, severity: 'CRITICAL', summary: '密钥硬编码' },
      ] }],
      blocking: 1,
      at: '2026-11-17T09:20:00Z',
    },
    reviewOutsideScope: [{ file: 'src/config/secrets.ts', severity: 'CRITICAL', angle: '安全' }],
  })
  const renderer = await render(WorkbenchView, {})
  const text = flat(renderer.toJSON())
  await check('D4 评审卡片提示 scope 外发现需要回 S1 调 scope', () => {
    assert.ok(text.includes('1 条发现落在冻结 scope 之外'))
    assert.ok(text.includes('src/config/secrets.ts'))
    assert.ok(text.includes('要先回到需求分析阶段更新 scope.json 并重新批准'))
  })
}

{
  currentView = baseView('S3', {
    review: {
      angles: [{ id: 'correctness', name: '正确性', verdict: 'advisory', findings: [
        { file: 'src/auth/session.ts', line: 12, severity: 'MINOR', summary: '缺少注释' },
      ] }],
      blocking: 0,
      at: '2026-11-17T09:20:00Z',
    },
    reviewOutsideScope: [],
  })
  const renderer = await render(WorkbenchView, {})
  const text = flat(renderer.toJSON())
  await check('D4 没有 scope 外发现时不显示回 S1 提示', () => {
    assert.ok(!text.includes('落在冻结 scope 之外'))
  })
}

{
  currentView = baseView('S3', {
    waiting: true,
    waitingKind: 'gate',
    review: {
      angles: [{ id: 'security', name: '安全', verdict: 'blocking', findings: [
        { file: 'src/config/secrets.ts', line: 7, severity: 'CRITICAL', summary: '密钥硬编码' },
      ] }],
      blocking: 1,
      at: '2026-11-17T09:20:00Z',
    },
    reviewOutsideScope: [{ file: 'src/config/secrets.ts', severity: 'CRITICAL', angle: '安全' }],
  })
  const renderer = await render(WorkbenchView, {})
  const tree = renderer.toJSON()
  const back = buttonByText(tree, '回到需求分析调整 scope')
  await check('D4 有 scope 外发现时 S3 门禁出现回 S1 的按钮', () => {
    assert.ok(back, '没找到「回到需求分析调整 scope」按钮')
    assert.ok(flat(tree).includes('退回开发修复也改不到它们'))
  })
  await click(back)
  await check('D4 点回 S1 发出 gate/back 且 to=S1', () => {
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'gate')
    assert.equal(last.payload.decision, 'back')
    assert.equal(last.payload.to, 'S1')
  })
}

{
  currentView = baseView('S3', {
    waiting: true,
    waitingKind: 'gate',
    review: {
      angles: [{ id: 'correctness', name: '正确性', verdict: 'advisory', findings: [], }],
      blocking: 0,
      at: '2026-11-17T09:20:00Z',
    },
    reviewOutsideScope: [],
  })
  const renderer = await render(WorkbenchView, {})
  await check('D4 没有 scope 外发现时 S3 门禁不显示回 S1 按钮', () => {
    assert.ok(!flat(renderer.toJSON()).includes('回到需求分析调整 scope'))
  })
}

// ---------------------------------------------------------------------------
// 8.6 放弃流程：门禁面板底部必须有出口，而且要点两次才真的放弃
// ---------------------------------------------------------------------------

{
  posted = []
  currentView = baseView('S2', { waiting: true, waitingKind: 'gate' })
  const renderer = await render(WorkbenchView, {})
  await check('门禁面板底部有「放弃这次流程」入口', () => {
    assert.ok(flat(renderer.toJSON()).includes('放弃这次流程'))
  })
  await click(buttonByText(renderer.toJSON(), '放弃这次流程'))
  await check('点一次只是二次确认，不会立刻放弃', () => {
    assert.equal(posted.length, 0, '一按就发 cancel 请求等于没有防手滑')
    const text = flat(renderer.toJSON())
    assert.ok(text.includes('确认放弃'))
    assert.ok(text.includes('都会作废'))
  })
  await click(buttonByText(renderer.toJSON(), '再想想'))
  await check('「再想想」收起确认，同样不发请求', () => {
    assert.equal(posted.length, 0)
    assert.ok(flat(renderer.toJSON()).includes('放弃这次流程'))
  })
  await click(buttonByText(renderer.toJSON(), '放弃这次流程'))
  await click(buttonByText(renderer.toJSON(), '确认放弃'))
  await check('确认放弃发出 cancel 动作并带上原因', () => {
    assert.equal(posted.length, 1, '只能提交一次')
    assert.equal(posted[0].action, 'cancel')
    assert.ok(posted[0].payload.reason.length > 0)
  })
}

{
  // 没有挂起门禁时也要能放弃：用户卡在 S1 想换个需求是常见情形。
  currentView = baseView('S1', { waiting: false })
  const renderer = await render(WorkbenchView, {})
  await check('没有挂起门禁时也能放弃流程', () => {
    assert.ok(flat(renderer.toJSON()).includes('放弃这次流程'))
  })
}

{
  currentView = baseView('S2', {
    finished: true,
    cancelled: true,
    cancelledAt: '2026-11-17T10:30:00Z',
    cancelReason: '这个需求先不做了',
  })
  const renderer = await render(WorkbenchView, {})
  const text = flat(renderer.toJSON())
  await check('已放弃的流程显示放弃标记与原因', () => {
    assert.ok(text.includes('流程已放弃'))
    assert.ok(text.includes('这个需求先不做了'))
    assert.ok(text.includes('scope 已解冻'))
  })
  await check('已放弃后不再显示放弃入口', () => {
    assert.ok(!text.includes('放弃这次流程'))
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
  posted = []
  currentView = { active: false }
  const renderer = await render(FlowgateDock, {})
  await check('流程未启动时 dock 也能启动', () => {
    const text = flat(renderer.toJSON())
    assert.ok(text.includes('这个会话还没有流程'))
    assert.ok(text.includes('开始需求分析'))
  })
  await check('点开始时先就地展开需求输入，不直接建流程', async () => {
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.equal(posted.length, 0, '没填需求之前不该发出 start')
    assert.ok(flat(renderer.toJSON()).includes('先写一句这次要做什么'), '应当展开填写区')
    assert.equal(findTags(renderer.toJSON(), 'textarea').length, 1, '展开后要有一个需求输入框')
  })
  await check('展开后需求为空时按钮禁用，填了才发出带 brief 的 start', async () => {
    assert.equal(buttonByText(renderer.toJSON(), '开始需求分析').props.disabled, true, '空需求时按钮应当禁用')
    const area = findTags(renderer.toJSON(), 'textarea')[0]
    await act(async () => {
      area.props.onChange({ target: { value: '会话过期返回 401，并给出重新认证入口' } })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.equal(posted.at(-1).action, 'start')
    assert.equal(posted.at(-1).payload.preset, 'fast')
    assert.equal(posted.at(-1).payload.brief, '会话过期返回 401，并给出重新认证入口')
  })
}

{
  // 流程结束（含放弃）后 view 仍然是 active，dock 不能因此把启动入口藏起来：
  // 用户在对话里看到「流程已结束」，下一步往往就是想接着做下一件事。
  posted = []
  currentView = baseView('S4', { finished: true, skippedCount: 2 })
  const renderer = await render(FlowgateDock, {})
  const text = flat(renderer.toJSON())
  await check('流程结束后 dock 显示已结束与跳过计数', () => {
    assert.ok(text.includes('流程已结束'))
    assert.ok(text.includes('已跳过 2 个阶段'))
  })
  await check('流程结束后 dock 仍然给得出开始入口', () => {
    assert.ok(text.includes('开始需求分析'), '已结束的流程也要能直接开新的')
  })
  await check('已结束时点开始同样先展开填写区，填了才发 start', async () => {
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.equal(posted.length, 0, '展开阶段不该发请求')
    const area = findTags(renderer.toJSON(), 'textarea')[0]
    assert.ok(area, '展开后要有需求输入框')
    await act(async () => {
      area.props.onChange({ target: { value: '接着做登录限流' } })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.equal(posted.at(-1).action, 'start')
    assert.equal(posted.at(-1).payload.brief, '接着做登录限流')
  })
}

{
  currentView = baseView('S4', { finished: true })
  const renderer = await render(WorkbenchView, {})
  const text = flat(renderer.toJSON())
  await check('已结束时工作台仍然能开始新流程', () => {
    assert.ok(text.includes('这次流程已结束'))
    assert.ok(text.includes('开始一次新流程'))
    assert.ok(text.includes('开始需求分析'))
  })
}

{
  currentView = baseView('S2', { finished: true, cancelled: true, cancelReason: '先不做了' })
  const renderer = await render(WorkbenchView, {})
  await check('已放弃时工作台也能开始新流程', () => {
    const text = flat(renderer.toJSON())
    assert.ok(text.includes('这次流程已放弃'))
    assert.ok(text.includes('开始一次新流程'))
  })
}


// ---------------------------------------------------------------------------
// 实时进度：用户提交需求后要能在工作台里看到「正在做什么」和推进到哪。
// ---------------------------------------------------------------------------

{
  currentView = baseView('S1', {
    progress: { percent: 43, stageIndex: 0, label: '需求分析' },
    activity: { tool: 'read', text: '读取文件：src/auth/session.ts', elapsedMs: 2000 },
    elapsedMs: 65000,
  })
  const renderer = await render(WorkbenchView, {})
  const text = flat(renderer.toJSON())
  await check('工作台顶部显示阶段进度、正在做什么与已用时间', () => {
    assert.ok(text.includes('S1 需求分析 · 正在读取文件：src/auth/session.ts'), text)
    assert.ok(text.includes('43%'))
    assert.ok(text.includes('已用 1 分 5 秒'))
  })
}

{
  currentView = baseView('S2', {
    waiting: true,
    waitingKind: 'gate',
    progress: { percent: 50, stageIndex: 1, label: '开发' },
    elapsedMs: 125000,
  })
  const renderer = await render(WorkbenchView, {})
  const text = flat(renderer.toJSON())
  await check('门禁等待时进度条说明在等你，不假装 Agent 还在跑', () => {
    assert.ok(text.includes('S2 开发 · 门禁等你确认'), text)
    const dots = findTags(renderer.toJSON(), 'span').filter((node) => node.props?.className === 'fg-live-dot')
    assert.equal(dots.length, 0)
  })
}

{
  currentView = baseView('S4', {
    finished: true,
    progress: { percent: 100, stageIndex: 3, label: '测试' },
    elapsedMs: 600000,
  })
  const renderer = await render(WorkbenchView, {})
  const text = flat(renderer.toJSON())
  await check('流程结束后收起进度条，结果页不再被占一行', () => {
    assert.ok(!text.includes('已用'))
    assert.ok(!text.includes('等待 Agent 下一步'))
  })
}

{
  // 旧宿主不给 progress 时也不能崩：这条条是纯增量字段。
  currentView = baseView('S1')
  const renderer = await render(WorkbenchView, {})
  await check('宿主没给进度字段时进度条不出现，布局也不塌', () => {
    assert.ok(!flat(renderer.toJSON()).includes('等待 Agent 下一步'))
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
