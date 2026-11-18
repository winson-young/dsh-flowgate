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
const docListeners = new Map()
globalThis.document = {
  adoptedStyleSheets: [],
  head: { appendChild(node) { styleNodes.push(node) } },
  body: { style: { overflow: '' } },
  getElementById() { return null },
  createElement() { return { id: '', textContent: '' } },
  addEventListener(type, fn) {
    const list = docListeners.get(type) ?? []
    list.push(fn)
    docListeners.set(type, list)
  },
  removeEventListener(type, fn) {
    docListeners.set(type, (docListeners.get(type) ?? []).filter((item) => item !== fn))
  },
}

// 模拟按下 Esc：直接触发弹窗注册在 document 上的 keydown 监听。
function pressEscape() {
  for (const fn of [...(docListeners.get('keydown') ?? [])]) fn({ key: 'Escape' })
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
// 面板读的是「用户添加过的工作区」名单：默认空，用例里按需塞。
let currentMembers = []
// add 的返回值要能定制：空目录与有任务/规则的目录要分别断言。
let addResult = null
const listCalls = []
const addCalls = []
const removeCalls = []
const flowCalls = []
const ruleCalls = []
const flowsByPath = new Map()
const rulesByPath = new Map()
let flowHandler = null
let ruleHandler = null
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
const withoutFlows = ({ flows: _flows, ...member }) => member
function flowPage(body) {
  const member = currentMembers.find((item) => item.path === body.path) || (addResult?.path === body.path ? addResult : null)
  const flows = flowsByPath.get(body.path) ?? member?.flows ?? []
  const page = body.page || 1
  const pageSize = body.pageSize || 10
  return { flows: flows.slice((page - 1) * pageSize, page * pageSize), total: flows.length, page, pageSize, totalPages: Math.max(1, Math.ceil(flows.length / pageSize)) }
}
function workspaceRules(path) {
  const catalog = baseView('S2').ruleCatalog
  return rulesByPath.get(path) ?? { configured: false, ids: catalog.map((rule) => rule.id), custom: [], customCount: 0, catalog }
}
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/hub/members')) {
    listCalls.push(1)
    return { ok: true, status: 200, json: async () => ({ members: currentMembers.map(withoutFlows), file: '~/.dsh-flowgate/hub.json' }) }
  }
  if (target.includes('/hub/flows')) {
    const body = JSON.parse(init.body)
    assert.equal(init.method, 'POST')
    flowCalls.push(body)
    return flowHandler ? flowHandler(body) : response(flowPage(body))
  }
  if (target.includes('/hub/rules')) {
    const body = JSON.parse(init.body)
    assert.equal(init.method, 'POST')
    ruleCalls.push(body)
    if (ruleHandler) return ruleHandler(body)
    if (Object.hasOwn(body, 'rules')) {
      const previous = workspaceRules(body.path)
      const next = body.rules === null
        ? { configured: false, ids: baseView('S2').ruleCatalog.map((rule) => rule.id), custom: [], customCount: 0, catalog: baseView('S2').ruleCatalog }
        : { ...previous, ...body.rules, configured: true, customCount: body.rules.custom.length, catalog: baseView('S2').ruleCatalog.concat(body.rules.custom) }
      rulesByPath.set(body.path, next)
      currentMembers = currentMembers.map((member) => member.path === body.path ? { ...member, rules: next } : member)
    }
    return response({ rules: workspaceRules(body.path) })
  }
  if (target.includes('/hub/add')) {
    const body = JSON.parse(init.body)
    addCalls.push(body)
    const member = addResult || {
      path: body.path,
      name: body.path.split('/').pop(),
      missing: false,
      flows: [],
      flowCount: 0,
      activeCount: 0,
      waitingCount: 0,
      rules: { configured: false, ids: null, customCount: 0 },
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        member: withoutFlows(member),
        created: true,
        imported: {
          flows: member.flowCount,
          rules: member.rules.ids ? member.rules.ids.length : 0,
          customRules: member.rules.customCount,
        },
      }),
    }
  }
  if (target.includes('/hub/remove')) {
    removeCalls.push(JSON.parse(init.body))
    return { ok: true, status: 200, json: async () => ({ removed: true }) }
  }
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
    node.props.onClick({ currentTarget: { focus() {} } })
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
}

async function changeValue(node, value) {
  await act(async () => { node.props.onChange({ target: { value } }) })
}

async function pressKey(node, modifiers = {}) {
  let prevented = 0
  await act(async () => {
    node.props.onKeyDown({ key: 'Enter', preventDefault() { prevented += 1 }, ...modifiers })
  })
  return prevented
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
}

// 设置面板收进弹窗：先点开，再断言弹窗里的分组内容。
async function openSettings(renderer) {
  await click(buttonByText(renderer.toJSON(), '配置角度与规则'))
  return renderer.toJSON()
}

async function switchGroup(renderer, label) {
  await click(buttonByText(renderer.toJSON(), label))
  return renderer.toJSON()
}

function hasButton(tree, needle) {
  return buttons(tree).some((node) => flat(node).includes(needle))
}

function checkboxNodes(tree) {
  const boxes = []
  const walk = (node) => {
    if (!node) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.type === 'input' && node.props.type === 'checkbox') boxes.push(node)
    if (node.children) walk(node.children)
  }
  walk(tree)
  return boxes
}

function nodeByClass(tree, className) {
  let found = null
  const walk = (node) => {
    if (!node || found) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.props && node.props.className === className) { found = node; return }
    if (node.children) walk(node.children)
  }
  walk(tree)
  return found
}

function nodeByRole(tree, role) {
  let found = null
  const walk = (node) => {
    if (!node || found) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.props && node.props.role === role) { found = node; return }
    if (node.children) walk(node.children)
  }
  walk(tree)
  return found
}

function inputByPlaceholder(tree, placeholder) {
  let found = null
  const walk = (node) => {
    if (!node || found) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.type === 'input' && node.props.placeholder === placeholder) { found = node; return }
    if (node.children) walk(node.children)
  }
  walk(tree)
  return found
}

// ---------------------------------------------------------------------------
// 1. 模块契约
// ---------------------------------------------------------------------------

await check('模块导出 name / inject / apply', () => {
  assert.equal(plugin.name, 'dsh-flowgate')
  // workspaces 是可选服务：靠 ctx.get 取，缺了也只影响面板，不该拖垮会话视图。
  assert.deepEqual([...plugin.inject], ['slots'])
  assert.equal(typeof plugin.apply, 'function')
})

const registrations = []
const fakeWorkspaces = { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } }
plugin.apply({
  slots: {
    inject(_name, callback) { callback() },
    register(options, Component) { registrations.push({ options, Component }) },
  },
  get(name) { return name === 'workspaces' ? fakeWorkspaces : undefined },
})

await check('apply 只注册左侧栏面板（图标 + 面板本体）', () => {
  // 入口收敛到左侧栏：会话视图「本次流程」与输入框上方常驻条都已移除，
  // 否则同一件事有三个入口，用户每次都要判断该点哪个。
  assert.equal(registrations.length, 2)
  const names = registrations.map((item) => item.options.name).sort()
  assert.deepEqual(names, ['main', 'sidebar.panellist'])
  const byName = (name) => registrations.find((item) => item.options.name === name)
  // 侧栏条目 id 与 main 的 key 必须同名，否则点图标打不开面板。
  assert.equal(byName('sidebar.panellist').options.id, 'flowgate-hub')
  assert.equal(byName('sidebar.panellist').options.label(), '流程工作台')
  assert.equal(byName('main').options.key, 'flowgate-hub')
})

await check('会话视图与输入框常驻条都不再注册', () => {
  assert.equal((registrations.filter((item) => item.options.name === 'conversation.view')).length, 0)
  assert.equal((registrations.filter((item) => item.options.name === 'conversation.input.dock')).length, 0)
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

const componentOf = (name) => registrations.find((item) => item.options.name === name).Component
// 流程详情没有独立插槽：它是面板内部组件，由插件单独导出给单测用。
const FlowDetail = plugin.components.FlowDetail
assert.equal(typeof FlowDetail, 'function', '面板内嵌的流程详情要能被单测直接渲染')
const HubPanelIcon = componentOf('sidebar.panellist')

// ---------------------------------------------------------------------------
// 2. 空态
// ---------------------------------------------------------------------------

{
  const renderer = await render(FlowDetail, {}, false)
  await check('没有 sessionId 时不渲染任何东西', () => {
    assert.equal(renderer.toJSON(), null)
  })
}

{
  currentView = null
  const renderer = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
  await check('流程未启动时可以直接在界面启动', () => {
    const text = flat(renderer.toJSON())
    assert.ok(text.includes('当前会话还没有流程'))
    assert.ok(text.includes('开始一次新流程'))
    assert.ok(text.includes('小功能快速开发'))
  })
  const areas = () => findTags(renderer.toJSON(), 'textarea')
  await check('空态给的是需求描述输入框，不是只能填标题', () => {
    assert.ok(flat(renderer.toJSON()).includes('需求描述'))
    const found = areas()
    assert.equal(found.length, 1, '必须有一个多行的需求描述输入框')
    assert.equal(found[0].props.rows, 4)
    assert.equal(found[0].props.required, true)
    assert.equal(found[0].props['aria-required'], true)
    const label = findTags(renderer.toJSON(), 'label').find((node) => findTags(node, 'textarea').length)
    assert.ok(flat(label).includes('需求描述'))
    const marker = nodeByClass(label, 'fg-required')
    assert.equal(flat(marker), '*')
    assert.equal(marker.props['aria-hidden'], true)
  })
  await check('需求描述为空时按钮不可点，点也不发请求', async () => {
    const button = buttonByText(renderer.toJSON(), '开始需求分析')
    assert.equal(button.props.disabled, true, '空需求时启动按钮应当禁用')
    await click(button)
    assert.equal(posted.length, 0, '空需求不该发出 start')
  })
  await check('需求描述纯空白时快捷键不启动并给出必填提示', async () => {
    posted = []
    await changeValue(areas()[0], ' \n  ')
    assert.equal(buttonByText(renderer.toJSON(), '开始需求分析').props.disabled, true)
    assert.equal(await pressKey(areas()[0], { ctrlKey: true }), 1)
    assert.equal(posted.length, 0)
    assert.ok(flat(nodeByRole(renderer.toJSON(), 'alert')).includes('先写一句这次要做什么'))
  })
  await check('需求描述普通 Enter 换行，不启动流程', async () => {
    await changeValue(areas()[0], '第一行需求\n第二行补充')
    const before = posted.length
    assert.equal(await pressKey(areas()[0]), 0)
    assert.equal(posted.length, before)
    assert.equal(areas()[0].props.value, '第一行需求\n第二行补充')
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
  const renderer = await render(FlowDetail, {})
  const tree = renderer.toJSON()
  const text = flat(tree)

  await check('S1 追问卡片显示问题、上下文与已回答数', () => {
    assert.ok(text.includes('拍板'))
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

  const customArea = () => findTags(renderer.toJSON(), 'textarea').find((node) => node.props['aria-label'] === '自定义答案')
  await check('自定义答案点击后才展开多行输入', async () => {
    assert.equal(customArea(), undefined)
    await click(buttonByText(renderer.toJSON(), '自定义答案'))
    assert.equal(customArea().props.rows, 3)
    assert.equal(customArea().props.autoFocus, true)
    assert.equal(hasButton(renderer.toJSON(), '提交答案'), true)
  })
  await check('自定义答案为空或纯空白时不可提交，快捷键也不发请求', async () => {
    const before = posted.length
    assert.equal(buttonByText(renderer.toJSON(), '提交答案').props.disabled, true)
    assert.equal(await pressKey(customArea(), { ctrlKey: true }), 1)
    await changeValue(customArea(), ' \n  ')
    assert.equal(buttonByText(renderer.toJSON(), '提交答案').props.disabled, true)
    assert.equal(await pressKey(customArea(), { metaKey: true }), 1)
    assert.equal(posted.length, before)
  })
  await check('自定义答案普通 Enter 保留多行，不提交', async () => {
    const before = posted.length
    await changeValue(customArea(), '保留滑动窗口\n超时后允许重新认证')
    assert.equal(await pressKey(customArea()), 0)
    assert.equal(posted.length, before)
    assert.equal(customArea().props.value, '保留滑动窗口\n超时后允许重新认证')
  })
  await check('输入法组合输入期间 Ctrl/Cmd+Enter 不提交', async () => {
    const before = posted.length
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
      assert.equal(await pressKey(customArea(), { ...modifiers, nativeEvent: { isComposing: true } }), 0)
    }
    assert.equal(posted.length, before)
  })
  await check('取消自定义答案只收起输入并保留草稿', async () => {
    const before = posted.length
    const draft = customArea().props.value
    await click(buttonByText(renderer.toJSON(), '取消'))
    assert.equal(customArea(), undefined)
    assert.equal(hasButton(renderer.toJSON(), '提交答案'), false)
    assert.equal(posted.length, before)
    await click(buttonByText(renderer.toJSON(), '自定义答案'))
    assert.equal(customArea().props.value, draft)
  })
  for (const [label, modifiers] of [['Ctrl', { ctrlKey: true }], ['Cmd', { metaKey: true }]]) {
    await check('自定义答案 ' + label + '+Enter 提交完整多行并去掉首尾空白', async () => {
      const before = posted.length
      await changeValue(customArea(), '  第一行方案\n第二行说明  ')
      assert.equal(await pressKey(customArea(), modifiers), 1)
      assert.equal(posted.length, before + 1)
      assert.equal(posted.at(-1).action, 'answer')
      assert.deepEqual(posted.at(-1).payload, { choiceIndex: -1, customText: '第一行方案\n第二行说明' })
    })
  }
  await check('自定义答案按钮也提交完整多行内容', async () => {
    const before = posted.length
    await changeValue(customArea(), '按钮提交\n保留换行')
    await click(buttonByText(renderer.toJSON(), '提交答案'))
    assert.equal(posted.length, before + 1)
    assert.deepEqual(posted.at(-1).payload, { choiceIndex: -1, customText: '按钮提交\n保留换行' })
  })
  await check('提交未完成时拦截同一轮快捷键与选项的重复提交', async () => {
    const originalFetch = globalThis.fetch
    let release
    const pendingResponse = new Promise((resolve) => { release = resolve })
    let calls = 0
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/action')) {
        calls += 1
        await pendingResponse
      }
      return originalFetch(url, init)
    }
    const before = posted.length
    try {
      const area = customArea()
      const option = buttonByText(renderer.toJSON(), '滑动窗口')
      await act(async () => {
        const event = { key: 'Enter', ctrlKey: true, preventDefault() {} }
        area.props.onKeyDown(event)
        area.props.onKeyDown(event)
        option.props.onClick()
      })
      assert.equal(calls, 1, 'React 重渲染前的重复事件也只能发出一次请求')
      assert.equal(customArea().props.disabled, true)
      assert.equal(buttonByText(renderer.toJSON(), '取消').props.disabled, true)
      assert.equal(buttonByText(renderer.toJSON(), '滑动窗口').props.disabled, true)
      assert.equal(nodeByClass(renderer.toJSON(), 'fg-list fg-options').props['aria-busy'], true)
    } finally {
      await act(async () => { release(); await pendingResponse })
      globalThis.fetch = originalFetch
    }
    assert.equal(posted.length, before + 1)
    assert.equal(customArea().props.disabled, false)
  })
  await act(async () => { renderer.unmount() })
}

{
  currentView = baseView('S1', {
    grill: { pending: { id: 'q-no-custom', question: '是否启用？', options: [{ label: '启用' }], allowCustom: false }, answeredCount: 0 },
  })
  const renderer = await render(FlowDetail, {})
  await check('禁止自定义时仅提供可直接提交的选项', () => {
    assert.equal(hasButton(renderer.toJSON(), '自定义答案'), false)
    assert.equal(findTags(renderer.toJSON(), 'textarea').length, 0)
    assert.ok(hasButton(renderer.toJSON(), '启用'))
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
  const renderer = await render(FlowDetail, {})
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

// 提交文档的那次工具调用可能被中断：文档还在就必须还能确认。
{
  posted = []
  currentView = baseView('S1', {
    doc: {
      html: '<html><body>需求文档</body></html>',
      recommendedPreset: 'fast',
      reason: '只改两个文件',
      at: '2026-11-17T09:20:00Z',
      pending: true,
      interrupted: true,
    },
    waiting: false,
    waitingKind: null,
  })
  const renderer = await render(FlowDetail, {})
  const tree = renderer.toJSON()
  await check('确认入口中断后按钮仍然在，并说明文档已保存', () => {
    assert.ok(buttonByText(tree, '批准并冻结 scope'))
    assert.ok(flat(tree).includes('被中断'))
  })
  await check('中断后点批准仍然提交 doc/approve', async () => {
    await click(buttonByText(renderer.toJSON(), '批准并冻结 scope'))
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'doc')
    assert.equal(last.payload.decision, 'approve')
  })
}

{
  currentView = baseView('S1', {
    doc: {
      html: '<html><body>需求文档</body></html>',
      pending: false,
      decision: { kind: 'approve', at: '2026-11-17T09:25:00Z' },
    },
    waiting: false,
  })
  const tree = (await render(FlowDetail, {})).toJSON()
  await check('已决策的文档不再显示批准按钮', () => {
    let approveButton = null
    try { approveButton = buttonByText(tree, '批准并冻结 scope') } catch { approveButton = null }
    assert.ok(!approveButton, '已决策的文档不应再给批准按钮')
    assert.ok(flat(tree).includes('已经确认过'))
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
  const renderer = await render(FlowDetail, {})
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

// 门禁请求被中断后等待器就没了：变更摘要已经采集完，按钮仍然该能点。
{
  posted = []
  currentView = baseView('S2', {
    devChanges: { files: ['src/auth/session.ts'], added: 42, removed: 7, at: '2026-11-17T09:40:00Z' },
    gate: { pending: true, interrupted: true },
    waiting: false,
    waitingKind: null,
  })
  const renderer = await render(FlowDetail, {})
  const tree = renderer.toJSON()
  await check('门禁中断后按钮仍然可点并说明原因', async () => {
    assert.ok(flat(tree).includes('上次的门禁请求被中断'))
    await click(buttonByText(tree, '完成开发'))
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'gate')
    assert.equal(last.payload.decision, 'pass')
  })
}

// S3 / S4 同理：报告已经交上来，按钮就不该再等内存里的等待器。
{
  posted = []
  currentView = baseView('S3', {
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
          findings: [{ file: 'src/auth/session.ts', line: 88, severity: 'CRITICAL', summary: '过期判断用了客户端时间' }],
        },
      ],
    },
    gate: { pending: true, interrupted: true },
    waiting: false,
    waitingKind: null,
  })
  const renderer = await render(FlowDetail, {})
  const tree = renderer.toJSON()
  await check('S3 评审交上来后门禁按钮可点', async () => {
    assert.ok(flat(tree).includes('上次的门禁请求被中断'))
    await click(buttonByText(tree, '通过评审，进入测试'))
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'gate')
    assert.equal(last.payload.decision, 'pass')
  })
}

{
  posted = []
  currentView = baseView('S4', {
    test: {
      directions: [{ id: 'unit', name: '单元测试', points: [{ point: '过期判断', result: 'pass' }] }],
      failed: 0,
      at: '2026-11-17T10:20:00Z',
    },
    gate: { pending: true, interrupted: true },
    waiting: false,
    waitingKind: null,
  })
  const renderer = await render(FlowDetail, {})
  const tree = renderer.toJSON()
  await check('S4 测试结果交上来后门禁按钮可点', async () => {
    assert.ok(flat(tree).includes('上次的门禁请求被中断'))
    await click(buttonByText(tree, '验收通过，结束流程'))
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'gate')
    assert.equal(last.payload.decision, 'pass')
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
  const renderer = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
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
    assert.ok(text.includes('等待 Agent 提交本阶段结果。'))
  })
}

{
  posted = []
  currentView = baseView('S1', { preset: 'fast' })
  const renderer = await render(FlowDetail, {})
  const text = flat(renderer.toJSON())
  await check('侧栏不再直接摆升档按钮', () => {
    assert.ok(text.includes('阶段设置'))
    assert.ok(!text.includes('升档到大需求严格执行'), '升档按钮应该收进弹窗')
  })

  await check('S1 弹窗默认落在执行档位，可升档', async () => {
    const tree = await openSettings(renderer)
    assert.ok(flat(tree).includes('升档到大需求严格执行'))
    await click(buttonByText(renderer.toJSON(), '升档到大需求严格执行'))
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'upgrade')
    assert.equal(last.payload.preset, 'strict')
    // 收尾关掉弹窗：残留实例会共享 document.body 的滚动锁，影响后续断言。
    await click(buttonByText(renderer.toJSON(), '关闭'))
  })
}

{
  posted = []
  currentView = baseView('S2')
  const renderer = await render(FlowDetail, {})
  const text = flat(renderer.toJSON())
  await check('侧栏退化为统计摘要与打开按钮', () => {
    assert.ok(text.includes('阶段设置'))
    assert.ok(text.includes('评审角度 1/3'))
    assert.ok(text.includes('测试方向 1/2'))
    assert.ok(text.includes('开发规则 2/3'))
    const triggerButton = buttonByText(renderer.toJSON(), '配置角度与规则')
    assert.equal(triggerButton.props['aria-expanded'], false, '未打开时扩展状态为 false')
    assert.ok(!text.includes('追加自定义开发规则'), '侧栏不该再堆叠追加入口')
    assert.ok(!text.includes('与既有代码风格一致'), '侧栏不该再列全部规则')
  })

  const modalTree = await openSettings(renderer)

  await check('弹窗带 dialog 语义，S2 默认落在开发规则组', () => {
    const dialog = nodeByRole(renderer.toJSON(), 'dialog')
    assert.ok(dialog, '必须有 dialog 卡片')
    assert.equal(dialog.props['aria-modal'], 'true')
    assert.match(dialog.props['aria-labelledby'], /^fg-settings-title/)
    assert.equal(dialog.props.tabIndex, -1)
    assert.equal(buttonByText(renderer.toJSON(), '配置角度与规则').props['aria-expanded'], true)
    const paneText = flat(modalTree)
    assert.ok(paneText.includes('开发规则'))
    assert.ok(paneText.includes('与既有代码风格一致'))
    assert.ok(paneText.includes('追加自定义开发规则'))
    assert.equal(hasButton(modalTree, '追加自定义角度'), false, '默认组之外的入口不该渲染')
  })

  await check('打开弹窗时锁背景滚动', () => {
    assert.equal(globalThis.document.body.style.overflow, 'hidden')
  })

  await check('切换分组只渲染当前组', async () => {
    const anglesTree = await switchGroup(renderer, '评审角度')
    assert.ok(hasButton(anglesTree, '追加自定义角度'))
    assert.equal(hasButton(anglesTree, '追加自定义开发规则'), false)
    const backTree = await switchGroup(renderer, '开发规则')
    assert.ok(hasButton(backTree, '追加自定义开发规则'))
    assert.equal(hasButton(backTree, '追加自定义角度'), false)
  })

  await check('列表自己滚动，追加入口不在滚动区里', () => {
    const list = nodeByClass(renderer.toJSON(), 'fg-modal-list')
    assert.ok(list, '弹窗列表应有独立滚动容器')
    assert.equal(hasButton(list, '追加自定义开发规则'), false, '追加入口不能被滚走')
  })

  await check('Tab 在弹窗内首尾循环，不跑到背景', () => {
    const dialog = nodeByRole(renderer.toJSON(), 'dialog')
    assert.equal(typeof dialog.props.onKeyDown, 'function', '弹窗应拦截 Tab')
    const a = { focus() { a.focused = true } }
    const b = { focus() { b.focused = true } }
    const off = { disabled: true, focus() { off.focused = true } }
    const card = { querySelectorAll: () => [a, off, b] }
    let prevented = 0
    const tabEvent = (target, shiftKey) => ({
      key: 'Tab',
      shiftKey,
      target,
      currentTarget: card,
      preventDefault() { prevented += 1 },
    })
    dialog.props.onKeyDown(tabEvent(b, false))
    assert.equal(a.focused, true, '末位 Tab 应回绕到首位')
    dialog.props.onKeyDown(tabEvent(a, true))
    assert.equal(b.focused, true, '首位 Shift+Tab 应回绕到末位')
    prevented = 0
    dialog.props.onKeyDown(tabEvent(card, false))
    assert.equal(prevented, 0, '卡片自身出发的 Tab 交给浏览器')
    assert.equal(off.focused, undefined, 'disabled 元素不该被当成回绕目标')
    prevented = 0
    const only = { focus() { only.focused = true } }
    const singleCard = { querySelectorAll: () => [only] }
    dialog.props.onKeyDown({ key: 'Tab', shiftKey: false, target: only, currentTarget: singleCard, preventDefault() { prevented += 1 } })
    assert.equal(prevented, 0, '只剩一个可聚焦元素时不拦 Tab')
  })

  await check('窄屏下弹窗分组导航改横向、卡片占满高度', () => {
    const css = styleNodes[0].textContent
    const at = css.indexOf('@container flowgate (max-width: 720px)')
    assert.ok(at >= 0, '缺少 720px 容器查询')
    const block = css.slice(at, css.indexOf('@container flowgate (max-width: 480px)', at))
    assert.ok(/\.fg-modal-nav \{[^}]*flex-direction: row/.test(block), '窄屏分组导航应横排')
    assert.ok(/\.fg-modal-body \{[^}]*grid-template-columns: minmax\(0, 1fr\)/.test(block), '窄屏应改成单列')
  })

  await check('勾选开发规则会提交 toggleRule', async () => {
    const target = checkboxNodes(renderer.toJSON()).find((node) => node.props['aria-label'] === '与既有代码风格一致')
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

  await check('追加自定义规则后留在当前组且表单收起', async () => {
    await click(buttonByText(renderer.toJSON(), '追加自定义开发规则'))
    const input = inputByPlaceholder(renderer.toJSON(), '规则名称')
    assert.ok(input, '追加表单应出现在列表上方')
    await act(async () => {
      input.props.onChange({ target: { value: '禁止新增第三方依赖' } })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await click(buttonByText(renderer.toJSON(), '追加'))
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'addRule')
    assert.equal(last.payload.name, '禁止新增第三方依赖')
    assert.deepEqual(last.payload.points, [])
    const after = renderer.toJSON()
    assert.ok(hasButton(after, '追加自定义开发规则'), '提交后仍停在开发规则组')
    assert.equal(inputByPlaceholder(after, '规则名称'), null, '提交后表单收起')
  })

  await check('Esc 关闭弹窗并释放背景滚动', async () => {
    await act(async () => {
      pressEscape()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    assert.equal(nodeByRole(renderer.toJSON(), 'dialog'), null)
    assert.equal(globalThis.document.body.style.overflow, '')
  })

  await check('点遮罩关闭弹窗，点卡片内部不关闭', async () => {
    await openSettings(renderer)
    const overlay = nodeByClass(renderer.toJSON(), 'fg-modal')
    const card = nodeByRole(renderer.toJSON(), 'dialog')
    await act(async () => {
      overlay.props.onClick({ target: card, currentTarget: overlay })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    assert.ok(nodeByRole(renderer.toJSON(), 'dialog'), '点卡片内部不该关闭')
    await act(async () => {
      overlay.props.onClick({ target: overlay, currentTarget: overlay })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    assert.equal(nodeByRole(renderer.toJSON(), 'dialog'), null)
  })

  await check('关闭按钮关闭弹窗，重开后表单为空', async () => {
    await openSettings(renderer)
    await click(buttonByText(renderer.toJSON(), '关闭'))
    assert.equal(nodeByRole(renderer.toJSON(), 'dialog'), null)
    const reopened = await openSettings(renderer)
    assert.equal(inputByPlaceholder(reopened, '规则名称'), null)
    assert.ok(hasButton(reopened, '追加自定义开发规则'))
  })
}

{
  posted = []
  currentView = baseView('S3', { waiting: true, waitingKind: 'gate' })
  const renderer = await render(FlowDetail, {})
  // S3 默认落在评审角度组：弹窗一开就是这组勾选框。
  const boxes = checkboxNodes(await openSettings(renderer))
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
  const renderer = await render(FlowDetail, {})
  // S4 默认落在测试方向组，写权限授权勾选也在这组里。
  const modalTree = await openSettings(renderer)
  const boxes = checkboxNodes(modalTree)
  const text = flat(modalTree)
  await check('S1 拍板不再提供无实际作用的跳过按钮', async () => {
  currentView = baseView('S1', {
    grill: { pending: { id: 'q-skip', question: '过期后是否强制重新登录？', options: [{ label: '强制重新登录', tradeoff: '更安全' }], recommended: 0 }, answeredCount: 0 },
  })
  posted = []
  const tree = await render(FlowDetail, {})
  const card = nodeByClass(tree.toJSON(), 'fg-q')
  assert.ok(card)
  assert.equal(hasButton(tree.toJSON(), '跳过'), false)
  assert.ok(hasButton(tree.toJSON(), '强制重新登录'))
  assert.equal(posted.length, 0)
})

await check('点「修改需求」后回到追问流程并说明下一步', async () => {
  currentView = baseView('S1', { doc: { html: null, revisedAt: '2026-11-17T10:00:00Z' } })
  const tree = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
  await openSettings(renderer)
  // S2 默认组是开发规则，授权说明在测试方向组里。
  const text = flat(await switchGroup(renderer, '测试方向'))
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
  const renderer = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
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

{
  currentView = baseView('S4', { finished: true })
  const renderer = await render(FlowDetail, {})
  const text = flat(renderer.toJSON())
  await check('已结束时工作台仍然能开始新流程', () => {
    assert.ok(text.includes('这次流程已结束'))
    assert.ok(text.includes('开始一次新流程'))
    assert.ok(text.includes('开始需求分析'))
  })
}

{
  currentView = baseView('S2', { finished: true, cancelled: true, cancelReason: '先不做了' })
  const renderer = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
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
  const renderer = await render(FlowDetail, {})
  const text = flat(renderer.toJSON())
  await check('流程结束后收起进度条，结果页不再被占一行', () => {
    assert.ok(!text.includes('已用'))
    assert.ok(!text.includes('等待 Agent 下一步'))
  })
}

{
  // 旧宿主不给 progress 时也不能崩：这条条是纯增量字段。
  currentView = baseView('S1')
  const renderer = await render(FlowDetail, {})
  await check('宿主没给进度字段时进度条不出现，布局也不塌', () => {
    assert.ok(!flat(renderer.toJSON()).includes('等待 Agent 下一步'))
  })
}
// ---------------------------------------------------------------------------
// 左侧栏全局面板：面板不属于任何会话，只读盘上快照
// ---------------------------------------------------------------------------

const HubPanel = componentOf('main')
const useWorkspacesOf = (items) => (selector) => selector({ items })

/** 面板的宿主动作替身：挑目录、登记工作区、跳会话。 */
const hubActionsWith = (overrides = {}) => ({
  pickDirectory: async () => null,
  createWorkspace: async (path) => ({ workspaceId: 'w-new', path }),
  openSession: () => {},
  ...overrides,
})

const alphaMember = {
  path: 'D:/repo/alpha',
  name: 'alpha',
  addedAt: '2026-11-18T08:00:00Z',
  missing: false,
  activeCount: 2,
  waitingCount: 1,
  flowCount: 2,
  updatedAt: '2026-11-18T08:00:00Z',
  rules: { configured: true, ids: ['scope-only', 'no-debug-leftovers'], customCount: 1 },
  flows: [
    { id: 'f1', sessionId: 'sess-alpha-1', title: '会话过期检测', brief: '细节…', preset: 'fast', stage: 'S2', stageLabel: '开发', finished: false, cancelled: false, waiting: true, waitingKind: 'gate', skippedCount: 0, percent: 45, createdAt: '…', updatedAt: '…' },
    { id: 'f2', sessionId: 'sess-alpha-2', title: '导出报表', brief: '', preset: 'strict', stage: 'S4', stageLabel: '测试', finished: true, cancelled: false, waiting: false, waitingKind: null, skippedCount: 1, percent: 100, createdAt: '…', updatedAt: '…' },
  ],
}

const resetHub = (members = []) => {
  currentMembers = members
  addResult = null
  listCalls.length = 0
  addCalls.length = 0
  removeCalls.length = 0
  flowCalls.length = 0
  ruleCalls.length = 0
  flowsByPath.clear()
  rulesByPath.clear()
  flowHandler = null
  ruleHandler = null
}

{
  // 用户没添加过任何工作区：工作台必须是空的，不能把宿主的工作区摊出来。
  resetHub([])
  const renderer = await render(HubPanel, {
    useHubWorkspaces: useWorkspacesOf([{ workspaceId: 'w1', path: 'D:/repo/alpha', title: 'alpha' }]),
    hubActions: hubActionsWith(),
  })
  const text = flat(renderer.toJSON())
  await check('名单为空时工作台是空的，不把宿主工作区摊出来', () => {
    assert.ok(text.includes('添加第一个工作区，集中查看需求、进度与待办。'), text)
    assert.ok(!text.includes('D:/repo/alpha'), '没添加过的工作区不该出现在工作台里')
    assert.equal(listCalls.length, 1, '只读一次名单，不读任何工作区目录')
    assert.equal(addCalls.length, 0)
  })
  await check('空名单给出两个添加入口', () => {
    assert.ok(hasButton(renderer.toJSON(), '添加目录…'))
    assert.ok(hasButton(renderer.toJSON(), '添加工作区'))
  })
}

{
  // 添加工作区：候选只来自宿主里还没加进名单的那些。
  resetHub([])
  addResult = alphaMember
  const importedCustom = { id: 'imported-custom', name: '导入的自定义规则', points: ['确认导入内容'] }
  rulesByPath.set(alphaMember.path, { ...alphaMember.rules, custom: [importedCustom], catalog: baseView('S2').ruleCatalog.concat([importedCustom]) })
  const renderer = await render(HubPanel, {
    useHubWorkspaces: useWorkspacesOf([{ workspaceId: 'w1', path: 'D:/repo/alpha', title: 'alpha' }]),
    hubActions: hubActionsWith(),
  })
  await click(buttonByText(renderer.toJSON(), '添加工作区'))
  await check('「添加工作区」列出的是宿主里还没添加过的', () => {
    assert.ok(flat(renderer.toJSON()).includes('D:/repo/alpha'))
  })
  await click(buttonByText(renderer.toJSON(), 'D:/repo/alpha'))
  await check('选中的工作区会被登记进名单', () => {
    assert.deepEqual(addCalls[0], { path: 'D:/repo/alpha' })
  })
  const text = flat(renderer.toJSON())
  await check('添加后顺手导入任务与规则', () => {
    assert.ok(text.includes('导入 2 条任务'), text)
    assert.ok(text.includes('2 条规则'), text)
    assert.ok(text.includes('含自定义 1 条'), text)
  })
  await check('详情列出这个工作区的任务', () => {
    assert.ok(text.includes('会话过期检测'))
    assert.ok(text.includes('导出报表'))
    assert.ok(text.includes('等你确认'))
    assert.ok(text.includes('进行中 2 条'))
    assert.ok(text.includes('其中 1 条在等你确认'))
  })
  await check('规则摘要常驻，配置路径仅放在 title 中', () => {
    assert.ok(text.includes('工作区默认 · 2 条启用'), text)
    assert.ok(!text.includes('.dsh-flowgate/config.json'), '配置路径不应挤占常驻内容')
    const card = nodeByClass(renderer.toJSON(), 'fg-hub-section fg-workspace-card fg-workspace-rules')
    assert.ok(card)
    assert.ok(hasButton(card, '编辑规则'))
    assert.ok(flat(card).includes('只改 scope 内的文件'))
    assert.ok(flat(card).includes('不留调试残留'))
    assert.ok(findTags(card, 'div').some((node) => node.props.title === '规则配置：.dsh-flowgate/config.json'))
  })
  await check('已有流程时新建入口默认折叠，summary 保留入口', () => {
    const start = findTags(renderer.toJSON(), 'details').find((node) => node.props.className?.includes('fg-start-section'))
    assert.ok(start, '新建流程必须使用可展开的 details')
    assert.equal(start.props.open, false)
    assert.equal(flat(findTags(start, 'summary')[0]), '开始新流程')
  })

  await click(buttonByText(renderer.toJSON(), '会话过期检测'))
  const detail = flat(renderer.toJSON())
  await check('点任务展开详情，详情里就是完整工作台', () => {
    assert.ok(detail.includes('会话过期检测'), '详情标题用任务名')
    assert.ok(detail.includes('S2 开发'), '详情里要能看到当前阶段')
    // 面板内可以直接操作门禁与规则，不再把用户赶回会话。
    assert.ok(detail.includes('出口门禁'), '详情里要有门禁面板')
    assert.ok(detail.includes('阶段设置'), '详情里要有阶段设置')
  })

  const opened = []
  renderer.unmount()
  resetHub([alphaMember])
  const again = await render(HubPanel, {
    useHubWorkspaces: useWorkspacesOf([]),
    hubActions: hubActionsWith({ openSession: (id) => opened.push(id) }),
  })
  await click(buttonByText(again.toJSON(), 'alpha'))
  await click(buttonByText(again.toJSON(), '会话过期检测'))
  await click(buttonByText(again.toJSON(), '打开会话'))
  await check('详情里能把这个会话打开', () => {
    assert.deepEqual(opened, ['sess-alpha-1'])
  })
}

{
  // 面板里直接开一条流程：面板不属于任何会话，所以要先向宿主换一个属于这个工作区的会话。
  resetHub([alphaMember])
  posted = []
  const asked = []
  const renderer = await render(HubPanel, {
    useHubWorkspaces: useWorkspacesOf([]),
    hubActions: hubActionsWith({
      sessionForWorkspace: async (path) => { asked.push(path); return 'sess-new' },
    }),
  })
  await click(buttonByText(renderer.toJSON(), 'alpha'))
  await check('选中工作区后就能写需求，不用回会话', () => {
    assert.ok(hasButton(renderer.toJSON(), '开始需求分析'))
    assert.equal(findTags(renderer.toJSON(), 'textarea').length, 1)
  })
  const area = findTags(renderer.toJSON(), 'textarea')[0]
  await act(async () => {
    area.props.onChange({ target: { value: '会话过期要返回 401' } })
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  await click(buttonByText(renderer.toJSON(), '开始需求分析'))
  await check('点开始时先向宿主换一个属于这个工作区的会话', () => {
    assert.deepEqual(asked, ['D:/repo/alpha'])
  })
  await check('需求原文作为 brief 直接发给宿主', () => {
    const start = posted.find((item) => item.action === 'start')
    assert.ok(start, JSON.stringify(posted))
    assert.equal(start.sessionId, 'sess-new')
    assert.equal(start.payload.brief, '会话过期要返回 401')
  })
  await check('启动成功后显示状态提示并刷新流程名单', () => {
    assert.equal(flat(nodeByRole(renderer.toJSON(), 'status')), '流程已启动')
    assert.ok(listCalls.length >= 2, '成功启动后应重新读取工作区流程')
  })
  renderer.unmount()
}

{
  // 拿不到会话时不能假装成功：错误就地显示，一个请求都不发。
  resetHub([alphaMember])
  posted = []
  const renderer = await render(HubPanel, {
    useHubWorkspaces: useWorkspacesOf([]),
    hubActions: hubActionsWith({
      sessionForWorkspace: async () => { throw new Error('这个目录还不是宿主的工作区') },
    }),
  })
  await click(buttonByText(renderer.toJSON(), 'alpha'))
  const area = findTags(renderer.toJSON(), 'textarea')[0]
  await act(async () => {
    area.props.onChange({ target: { value: '随便写点需求' } })
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  await click(buttonByText(renderer.toJSON(), '开始需求分析'))
  await check('换不到会话时显示原因且不发 start', () => {
    assert.ok(flat(renderer.toJSON()).includes('这个目录还不是宿主的工作区'), flat(renderer.toJSON()))
    assert.equal(posted.filter((item) => item.action === 'start').length, 0)
  })
  renderer.unmount()
}

{
  // 添加目录：调宿主选择器，目录还不是工作区就先 create。
  resetHub([])
  const created = []
  const renderer = await render(HubPanel, {
    useHubWorkspaces: useWorkspacesOf([]),
    hubActions: hubActionsWith({
      pickDirectory: async () => 'D:/repo/beta',
      createWorkspace: async (path) => { created.push(path); return { workspaceId: 'w2', path } },
    }),
  })
  await click(buttonByText(renderer.toJSON(), '添加目录…'))
  await check('选中的目录会先登记成工作区再进名单', () => {
    assert.deepEqual(created, ['D:/repo/beta'])
    assert.deepEqual(addCalls[0], { path: 'D:/repo/beta' })
  })
  await check('工作区尚无流程时新建入口默认展开', () => {
    const start = findTags(renderer.toJSON(), 'details').find((node) => node.props.className?.includes('fg-start-section'))
    assert.ok(start)
    assert.equal(start.props.open, true)
    assert.ok(findTags(start, 'textarea').some((node) => node.props.required))
    assert.ok(hasButton(start, '开始需求分析'))
  })
}

{
  // 取消选目录：什么都不发生。
  resetHub([])
  const created = []
  const renderer = await render(HubPanel, {
    useHubWorkspaces: useWorkspacesOf([]),
    hubActions: hubActionsWith({ createWorkspace: async (path) => { created.push(path); return { path } } }),
  })
  await click(buttonByText(renderer.toJSON(), '添加目录…'))
  await check('取消选目录不会登记任何东西', () => {
    assert.deepEqual(created, [])
    assert.equal(addCalls.length, 0)
    assert.ok(flat(renderer.toJSON()).includes('添加第一个工作区，集中查看需求、进度与待办。'))
  })
}

{
  // 移除：只改名单，回到列表。
  resetHub([alphaMember])
  const renderer = await render(HubPanel, {
    useHubWorkspaces: useWorkspacesOf([]),
    hubActions: hubActionsWith(),
  })
  await click(buttonByText(renderer.toJSON(), 'alpha'))
  await click(buttonByText(renderer.toJSON(), '移除'))
  await check('移除只改名单，回到工作区列表', () => {
    assert.deepEqual(removeCalls[0], { path: 'D:/repo/alpha' })
    assert.ok(!flat(renderer.toJSON()).includes('D:/repo/alpha'))
  })
}

{
  // 宿主读名单失败时不能白屏。
  resetHub([])
  const saved = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/hub/members')) return { ok: false, status: 500, json: async () => ({ error: '读盘失败' }) }
    return saved(url, init)
  }
  const renderer = await render(HubPanel, {
    useHubWorkspaces: useWorkspacesOf([]),
    hubActions: hubActionsWith(),
  })
  const text = flat(renderer.toJSON())
  globalThis.fetch = saved
  await check('名单读取失败时面板显示错误而不是空白', () => {
    assert.match(text, /读盘失败/)
  })
}

// ---------------------------------------------------------------------------
// 工作区规则草稿与流程分页
// ---------------------------------------------------------------------------

const emptyMember = (name) => ({
  path: 'D:/repo/' + name, name, missing: false, flowCount: 0, activeCount: 0, waitingCount: 0,
  rules: { configured: false, ids: null, customCount: 0 },
})
const ruleWrites = () => ruleCalls.filter((body) => Object.hasOwn(body, 'rules'))
const ruleDialog = (renderer) => nodeByRole(renderer.toJSON(), 'dialog')
function buttonByAria(tree, label) {
  const found = buttons(tree).find((node) => node.props['aria-label'] === label)
  assert.ok(found, '找不到按钮：' + label)
  return found
}
function ruleCheckbox(tree, name) {
  const label = findTags(tree, 'label').find((node) => flat(node).includes(name) && checkboxNodes(node).length)
  assert.ok(label, '找不到规则勾选框：' + name)
  return checkboxNodes(label)[0]
}
async function toggleRule(renderer, name, checked) {
  const box = ruleCheckbox(ruleDialog(renderer), name)
  await act(async () => { box.props.onChange({ target: { checked } }) })
  assert.equal(ruleCheckbox(ruleDialog(renderer), name).props.checked, checked)
}
async function addDraftRule(renderer, name, points = '检查第一项\n检查第二项') {
  await click(buttonByText(ruleDialog(renderer), '添加规则'))
  assert.equal(buttonByText(ruleDialog(renderer), '加入列表').props.disabled, true)
  await changeValue(inputByPlaceholder(ruleDialog(renderer), '规则名称'), name)
  const area = findTags(ruleDialog(renderer), 'textarea').find((node) => node.props.placeholder === '检查要点，每行一条')
  assert.ok(area, '规则检查要点使用多行表单')
  await changeValue(area, points)
  await click(buttonByText(ruleDialog(renderer), '加入列表'))
}
async function renderHub(actions = {}) {
  return render(HubPanel, { useHubWorkspaces: useWorkspacesOf([]), hubActions: hubActionsWith(actions) }, false)
}

await check('无流程工作区可直接配置规则，新增与取消草稿不创建会话或落盘', async () => {
  resetHub([emptyMember('empty')])
  posted = []
  const sessions = []
  const renderer = await renderHub({ sessionForWorkspace: async (path) => { sessions.push(path); return 'unexpected-session' } })
  try {
    await click(buttonByText(renderer.toJSON(), 'empty'))
    assert.ok(hasButton(renderer.toJSON(), '编辑规则'), '无流程也有常驻规则入口')
    await click(buttonByText(renderer.toJSON(), '编辑规则'))
    assert.ok(flat(ruleDialog(renderer)).includes('工作区规则'))
    assert.ok(flat(ruleDialog(renderer)).includes('未单独设置规则的流程将使用此配置。'))
    assert.deepEqual(ruleCalls[0], { path: 'D:/repo/empty' })
    await addDraftRule(renderer, '仅保留在草稿')
    assert.ok(flat(ruleDialog(renderer)).includes('仅保留在草稿'))
    assert.equal(inputByPlaceholder(ruleDialog(renderer), '规则名称'), null)
    await toggleRule(renderer, '只改 scope 内的文件', false)
    await toggleRule(renderer, '仅保留在草稿', false)
    await toggleRule(renderer, '仅保留在草稿', true)
    assert.equal(ruleWrites().length, 0, '加入列表和勾选都不能立即保存')
    await click(buttonByText(ruleDialog(renderer), '取消'))
    assert.equal(ruleDialog(renderer), null)
    await click(buttonByText(renderer.toJSON(), '编辑规则'))
    assert.ok(!flat(ruleDialog(renderer)).includes('仅保留在草稿'), '取消后重开不保留未保存条目')
    assert.equal(ruleCheckbox(ruleDialog(renderer), '只改 scope 内的文件').props.checked, true)
    await addDraftRule(renderer, '关闭也丢弃草稿')
    await click(buttonByText(ruleDialog(renderer), '关闭'))
    await click(buttonByText(renderer.toJSON(), '编辑规则'))
    assert.ok(!flat(ruleDialog(renderer)).includes('关闭也丢弃草稿'))
    assert.equal(ruleWrites().length, 0)
    assert.deepEqual(sessions, [])
    assert.deepEqual(posted, [])
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('工作区规则保存失败保留草稿可重试，自定义编辑移除与恢复默认仅保存时生效', async () => {
  resetHub([emptyMember('rules')])
  const renderer = await renderHub()
  try {
    await click(buttonByText(renderer.toJSON(), 'rules'))
    await click(buttonByText(renderer.toJSON(), '编辑规则'))
    await addDraftRule(renderer, '禁止新增依赖', '  逐项核对依赖  \n\n检查锁文件  ')
    await toggleRule(renderer, '只改 scope 内的文件', false)
    ruleHandler = (body) => Object.hasOwn(body, 'rules') ? response({ error: '规则保存失败，请重试' }, 500) : response({ rules: workspaceRules(body.path) })
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    assert.ok(flat(ruleDialog(renderer)).includes('规则保存失败，请重试'))
    assert.ok(flat(ruleDialog(renderer)).includes('禁止新增依赖'))
    assert.equal(buttonByText(ruleDialog(renderer), '保存规则').props.disabled, false)
    const failedPayload = ruleWrites()[0]
    assert.equal(failedPayload.path, 'D:/repo/rules')
    assert.equal(failedPayload.rules.custom.length, 1)
    assert.equal(failedPayload.rules.custom[0].name, '禁止新增依赖')
    assert.deepEqual(failedPayload.rules.custom[0].points, ['逐项核对依赖', '检查锁文件'])
    assert.ok(!failedPayload.rules.ids.includes('scope-only'))
    assert.ok(failedPayload.rules.ids.includes(failedPayload.rules.custom[0].id))
    ruleHandler = null
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    assert.deepEqual(ruleWrites()[1], failedPayload, '重试应保留同一个规则 id 和草稿')
    assert.equal(ruleDialog(renderer), null)
    assert.ok(flat(renderer.toJSON()).includes('禁止新增依赖'), '成功后规则卡片刷新摘要')
    await click(buttonByText(renderer.toJSON(), '编辑规则'))
    await click(buttonByAria(ruleDialog(renderer), '编辑规则：禁止新增依赖'))
    assert.equal(inputByPlaceholder(ruleDialog(renderer), '规则名称').props.value, '禁止新增依赖')
    await changeValue(inputByPlaceholder(ruleDialog(renderer), '规则名称'), '核对新增依赖')
    await click(buttonByText(ruleDialog(renderer), '更新规则'))
    assert.ok(flat(ruleDialog(renderer)).includes('核对新增依赖'))
    await toggleRule(renderer, '核对新增依赖', false)
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    const edited = ruleWrites().at(-1).rules
    assert.equal(edited.custom[0].id, failedPayload.rules.custom[0].id, '编辑保留 id')
    assert.equal(edited.custom[0].name, '核对新增依赖')
    assert.ok(!edited.ids.includes(edited.custom[0].id), '自定义规则可以关闭但保留定义')
    await click(buttonByText(renderer.toJSON(), '编辑规则'))
    await click(buttonByAria(ruleDialog(renderer), '移除规则：核对新增依赖'))
    assert.ok(!flat(ruleDialog(renderer)).includes('核对新增依赖'))
    assert.equal(ruleWrites().length, 3, '移除只改变本地草稿')
    await click(buttonByText(ruleDialog(renderer), '取消'))
    await click(buttonByText(renderer.toJSON(), '编辑规则'))
    assert.ok(flat(ruleDialog(renderer)).includes('核对新增依赖'), '取消移除后定义仍在')
    await click(buttonByText(ruleDialog(renderer), '恢复内置默认'))
    assert.ok(!flat(ruleDialog(renderer)).includes('核对新增依赖'))
    assert.ok(checkboxNodes(ruleDialog(renderer)).every((box) => box.props.checked))
    assert.equal(ruleWrites().length, 3, '恢复默认先留在草稿')
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    assert.deepEqual(ruleWrites().at(-1), { path: 'D:/repo/rules', rules: null })
    assert.equal(ruleDialog(renderer), null)
  } finally { ruleHandler = null; await act(async () => { renderer.unmount() }) }
})

function numberedFlows(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({ ...alphaMember.flows[0], id: prefix + '-' + (index + 1), sessionId: prefix + '-session-' + (index + 1), title: prefix + '任务' + String(index + 1).padStart(2, '0') }))
}

await check('流程列表通过新接口每页显示十条，翻页清详情，返回后进入其他工作区重置第一页', async () => {
  const alpha = { ...alphaMember, flowCount: 23, flows: [{ ...alphaMember.flows[0], title: '旧名单流程不能渲染' }] }
  const beta = { ...emptyMember('beta'), flowCount: 12 }
  resetHub([alpha, beta])
  flowsByPath.set(alpha.path, numberedFlows('甲', 23))
  flowsByPath.set(beta.path, numberedFlows('乙', 12))
  currentView = baseView('S2')
  const renderer = await renderHub()
  try {
    assert.equal(flowCalls.length, 0, '工作区列表不预取全部流程')
    await click(buttonByText(renderer.toJSON(), 'alpha'))
    assert.deepEqual(flowCalls[0], { path: alpha.path, page: 1, pageSize: 10 })
    assert.equal(buttonByText(renderer.toJSON(), '上一页').props.disabled, true)
    assert.ok(/第\s*1\s*[/]\s*3\s*页/.test(flat(renderer.toJSON())))
    assert.equal(buttons(renderer.toJSON()).filter((button) => /甲任务\d+/.test(flat(button))).length, 10)
    assert.ok(!flat(renderer.toJSON()).includes('甲任务11'))
    assert.ok(!flat(renderer.toJSON()).includes('旧名单流程不能渲染'))
    await click(buttonByText(renderer.toJSON(), '甲任务01'))
    assert.ok(flat(renderer.toJSON()).includes('出口门禁'))
    await click(buttonByText(renderer.toJSON(), '下一页'))
    assert.deepEqual(flowCalls.at(-1), { path: alpha.path, page: 2, pageSize: 10 })
    assert.ok(!flat(renderer.toJSON()).includes('出口门禁'), '换页必须清掉 opened 流程详情')
    assert.ok(flat(renderer.toJSON()).includes('甲任务11'))
    assert.ok(!flat(renderer.toJSON()).includes('甲任务01'))
    await click(buttonByText(renderer.toJSON(), '下一页'))
    assert.equal(buttons(renderer.toJSON()).filter((button) => /甲任务\d+/.test(flat(button))).length, 3)
    assert.equal(buttonByText(renderer.toJSON(), '下一页').props.disabled, true)
    await click(buttonByText(renderer.toJSON(), '上一页'))
    assert.deepEqual(flowCalls.at(-1), { path: alpha.path, page: 2, pageSize: 10 })
    await click(buttonByText(renderer.toJSON(), '工作区列表'))
    await click(buttonByText(renderer.toJSON(), 'beta'))
    assert.deepEqual(flowCalls.at(-1), { path: beta.path, page: 1, pageSize: 10 })
    assert.ok(/第\s*1\s*[/]\s*2\s*页/.test(flat(renderer.toJSON())))
    assert.ok(flat(renderer.toJSON()).includes('乙任务01'))
    assert.ok(!flat(renderer.toJSON()).includes('甲任务'))
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('翻页后旧目录的流程和规则迟到响应不能覆盖新选目录', async () => {
  const alpha = { ...emptyMember('alpha'), flowCount: 11 }
  const beta = { ...emptyMember('beta'), flowCount: 1 }
  resetHub([alpha, beta])
  flowsByPath.set(alpha.path, numberedFlows('迟到甲', 11))
  flowsByPath.set(beta.path, numberedFlows('当前乙', 1))
  let releaseFlows
  let releaseRules
  const delayedFlows = new Promise((resolve) => { releaseFlows = resolve })
  const delayedRules = new Promise((resolve) => { releaseRules = resolve })
  flowHandler = (body) => body.path === alpha.path && body.page === 2 ? delayedFlows : response(flowPage(body))
  ruleHandler = (body) => body.path === alpha.path ? delayedRules : response({ rules: workspaceRules(body.path) })
  const renderer = await renderHub()
  try {
    await click(buttonByText(renderer.toJSON(), 'alpha'))
    await click(buttonByText(renderer.toJSON(), '下一页'))
    assert.deepEqual(flowCalls.at(-1), { path: alpha.path, page: 2, pageSize: 10 })
    await click(buttonByText(renderer.toJSON(), '工作区列表'))
    await click(buttonByText(renderer.toJSON(), 'beta'))
    assert.ok(flat(renderer.toJSON()).includes('当前乙任务01'))
    await act(async () => {
      releaseFlows(response(flowPage({ path: alpha.path, page: 2, pageSize: 10 })))
      const custom = { id: 'late-rule', name: '迟到甲规则', points: [] }
      releaseRules(response({ rules: { configured: true, ids: [custom.id], custom: [custom], customCount: 1, catalog: [custom] } }))
    })
    await settle()
    assert.ok(flat(renderer.toJSON()).includes('当前乙任务01'))
    assert.ok(!flat(renderer.toJSON()).includes('迟到甲任务'), '旧目录第二页不能覆盖新目录第一页')
    assert.ok(!flat(renderer.toJSON()).includes('迟到甲规则'))
    await click(buttonByText(renderer.toJSON(), '编辑规则'))
    assert.ok(!flat(ruleDialog(renderer)).includes('迟到甲规则'))
    assert.ok(flat(ruleDialog(renderer)).includes('只改 scope 内的文件'))
  } finally {
    releaseFlows(response({ flows: [], total: 0, page: 1, pageSize: 10, totalPages: 1 }))
    releaseRules(response({ rules: workspaceRules(alpha.path) }))
    flowHandler = null
    ruleHandler = null
    await act(async () => { renderer.unmount() })
  }
})

await check('刷新时目录先消失且分页响应迟到，恢复目录后仍可刷新', async () => {
  const member = { ...emptyMember('recover'), flowCount: 1 }
  resetHub([member])
  flowsByPath.set(member.path, numberedFlows('恢复后', 1))
  const renderer = await renderHub()
  let releaseFlows
  const delayedFlows = new Promise((resolve) => { releaseFlows = resolve })
  try {
    await click(buttonByText(renderer.toJSON(), 'recover'))
    assert.equal(buttonByText(renderer.toJSON(), '刷新').props.disabled, false)
    flowHandler = () => delayedFlows
    currentMembers = [{ ...member, missing: true }]
    await click(buttonByText(renderer.toJSON(), '刷新'))
    assert.equal(flowCalls.length, 2, '目录状态返回前分页请求已启动')
    assert.ok(flat(renderer.toJSON()).includes('目录不可用'))
    assert.equal(buttonByText(renderer.toJSON(), '刷新').props.disabled, false, '目录不可用时应取消加载状态，允许再次刷新')
    await act(async () => { releaseFlows(response({ error: '目录已消失' }, 400)) })
    await settle()
    assert.equal(buttonByText(renderer.toJSON(), '刷新').props.disabled, false)
    assert.ok(!flat(renderer.toJSON()).includes('目录已消失'), '已失效请求不能覆盖当前目录状态')
    flowHandler = null
    currentMembers = [member]
    await click(buttonByText(renderer.toJSON(), '刷新'))
    assert.equal(buttonByText(renderer.toJSON(), '刷新').props.disabled, false)
    assert.ok(flat(renderer.toJSON()).includes('恢复后任务01'), '恢复目录后能重新读取流程')
  } finally {
    releaseFlows(response({ flows: [], total: 0, page: 1, pageSize: 10, totalPages: 1 }))
    flowHandler = null
    await act(async () => { renderer.unmount() })
  }
})

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
