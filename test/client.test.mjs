import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
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
let clientFactory = null
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
// 工作台的页面记忆存在 localStorage 里：这里给一个内存替身，用例之间可清空。
const memoryStore = new Map()
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 1,
  localStorage: {
    getItem(key) { return memoryStore.has(key) ? memoryStore.get(key) : null },
    setItem(key, value) { memoryStore.set(key, String(value)) },
    removeItem(key) { memoryStore.delete(key) },
  },
  __ModuleLoader__: {
    load(entry) { clientFactory = entry.factory; plugin = entry.factory(require) },
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
        in_scope: {
          files_expected_to_change: ['src/auth/session.ts'],
          capabilities: ['会话过期检测'],
          shared_contracts: ['src/auth/session.ts 的 checkExpiry(session, now) 签名保持不变'],
        },
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
let prepareHandler = null
const prepareCalls = []
// 整理请求必须挂上可中止的 signal：超时和「换不到会话」都要能收掉在飞的请求。
const prepareSignals = []
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
const withoutFlows = ({ flows: _flows, ...member }) => member
function flowPage(body) {
  const member = currentMembers.find((item) => item.path === body.path) || (addResult?.path === body.path ? addResult : null)
  const flows = flowsByPath.get(body.path) ?? member?.flows ?? []
  const page = body.page || 1
  const pageSize = body.pageSize || 10
  return { flows: flows.slice((page - 1) * pageSize, page * pageSize), currentFlow: flows.find((flow) => !flow.finished && !flow.cancelled) || null, total: flows.length, page, pageSize, totalPages: Math.max(1, Math.ceil(flows.length / pageSize)) }
}
const stageLabels = { S1: '需求分析', S2: '开发规则', S3: '评审角度', S4: '测试方向' }
function resolveWorkspaceStage(stage, input = null, existing = null) {
  const view = baseView('S2')
  const builtin = existing?.builtin || ({
    S1: [{ id: 'clarity', name: '明确需求目标', points: ['说明现状与目标'] }, { id: 'acceptance', name: '明确验收标准', points: ['逐条给出验收行为'] }],
    S2: view.ruleCatalog, S3: view.angleCatalog, S4: view.directionCatalog,
  })[stage]
  const defaults = existing?.defaults || { fast: stage === 'S2' ? builtin.map((item) => item.id) : [builtin[0].id], strict: builtin.map((item) => item.id) }
  const custom = input?.custom || []
  const edits = input?.edits || []
  const selection = input?.ids ?? null
  const catalog = builtin.map((entry) => edits.find((item) => item.id === entry.id) || entry).concat(custom)
  return { label: stageLabels[stage], configured: input !== null, selection, ids: selection || defaults.fast, defaults, builtin, custom, edits, catalog }
}
function workspaceRules(path) {
  const stored = rulesByPath.get(path)
  if (stored?.stages) return stored
  const legacy = stored || { configured: false, ids: baseView('S2').ruleCatalog.map((rule) => rule.id), custom: [], customCount: 0, catalog: baseView('S2').ruleCatalog }
  const stages = Object.fromEntries(Object.keys(stageLabels).map((stage) => [stage, resolveWorkspaceStage(stage,
    stage === 'S2' && legacy.configured ? { ids: legacy.ids, custom: legacy.custom || [], edits: [] } : null)]))
  return { ...legacy, stages }
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
  if (target.includes('/hub/prepare')) {
    const body = JSON.parse(init.body)
    prepareCalls.push(body)
    prepareSignals.push(init.signal || null)
    return prepareHandler ? prepareHandler(body, init) : response({ title: body.brief.split(/\r?\n/).find((line) => line.trim())?.trim() || '', status: 'fallback' })
  }
  if (target.includes('/hub/rules')) {
    const body = JSON.parse(init.body)
    assert.equal(init.method, 'POST')
    ruleCalls.push(body)
    if (ruleHandler) return ruleHandler(body)
    if (Object.hasOwn(body, 'stages')) {
      const previous = workspaceRules(body.path)
      const stages = Object.fromEntries(Object.keys(stageLabels).map((stage) => [stage, resolveWorkspaceStage(stage, body.stages[stage], previous.stages[stage])]))
      rulesByPath.set(body.path, { ...previous, stages, ...stages.S2, customCount: stages.S2.custom.length })
    } else if (Object.hasOwn(body, 'rules')) {
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

function nodeByTag(tree, tag) {
  let found = null
  const walk = (node) => {
    if (!node || found) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.type === tag) { found = node; return }
    if (node.children) walk(node.children)
  }
  walk(tree)
  return found
}

function nodeByLabel(tree, label) {
  let found = null
  const walk = (node) => {
    if (!node || found) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.props && node.props['aria-label'] === label) { found = node; return }
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

await check('apply 注册左侧栏面板与会话输入框上方的阶段提示', () => {
  // 会话提示条提供快捷启动入口；门禁仍在工作台确认，两处注册 id 独立。
  assert.equal(registrations.length, 3)
  const names = registrations.map((item) => item.options.name).sort()
  assert.deepEqual(names, ['conversation.input.dock', 'main', 'sidebar.panellist'])
  const byName = (name) => registrations.find((item) => item.options.name === name)
  // 侧栏条目 id 与 main 的 key 必须同名，否则点图标打不开面板。
  assert.equal(byName('sidebar.panellist').options.id, 'flowgate-hub')
  assert.equal(byName('sidebar.panellist').options.label(), '流程工作台')
  assert.equal(byName('main').options.key, 'flowgate-hub')
  // 核对插槽注册的顺序值：提示 30 排在任务 0、目标 10、排队消息 20 之后。
  const dock = byName('conversation.input.dock')
  assert.equal(dock.options.id, 'flowgate-hub-stage-hint')
  assert.equal(dock.options.order, 30)
  assert.ok(dock.options.order > 20, '提示的顺序值必须大于排队消息的顺序值')
})

await check('会话视图仍不注册：流程状态只走输入框上方那一行', () => {
  assert.equal((registrations.filter((item) => item.options.name === 'conversation.view')).length, 0)
  assert.equal((registrations.filter((item) => item.options.name === 'conversation.input.dock')).length, 1)
})

const stageHint = registrations.find((item) => item.options.name === 'conversation.input.dock').Component

// 工作区摘要与当前会话独立：不附带 active/finished 等旧会话开关。
function workspaceFlow(patch = {}) {
  return {
    sessionId: 'other-running-session',
    stage: 'S4', stageIndex: 3, label: '测试',
    waiting: false, waitingKind: null,
    activity: { text: '核对工作区结果' }, elapsedMs: 125000,
    updatedAt: '2026-11-19T12:00:00Z',
    ...patch,
  }
}

await check('阶段提示：轮询返回同会话工作区摘要时保留本会话门禁按钮', async () => {
  const sessionId = 'hint-own-' + (++seq)
  const originalFetch = globalThis.fetch
  let pollCount = 0
  currentView = baseView('S2', {
    waiting: true, waitingKind: 'gate',
    progress: { stageIndex: 1, label: '开发' },
    workspace: { flow: workspaceFlow({ sessionId, stage: 'S4', label: '旧摘要阶段' }) },
  })
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/state?sessionId=' + sessionId)) pollCount++
    return originalFetch(url, init)
  }
  let renderer
  try {
    renderer = await render(stageHint, { session: { sessionId } }, false)
    let tree = renderer.toJSON()
    assert.ok(flat(tree).includes('S2 开发'), '阶段与门禁应来自完整视图')
    assert.ok(!flat(tree).includes('旧摘要阶段'))
    assert.equal(buttonByText(tree, '完成开发').props.disabled, false)
    currentView = { ...currentView, elapsedMs: 5000, workspace: { flow: workspaceFlow({ sessionId, stage: 'S4', label: '轮询摘要阶段' }) } }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1650)) })
    tree = renderer.toJSON()
    assert.ok(pollCount >= 2, '应包含挂载后的初次拉取和后续轮询')
    assert.ok(flat(tree).includes('S2 开发'))
    assert.ok(!flat(tree).includes('轮询摘要阶段'))
    assert.equal(buttonByText(tree, '完成开发').props.disabled, false, '轮询后不能隐藏或置灰按钮')
    posted = []
    await click(buttonByText(tree, '完成开发'))
    assert.equal(posted.at(-1).sessionId, sessionId)
    assert.equal(posted.at(-1).action, 'gate')
  } finally {
    if (renderer) await act(async () => { renderer.unmount() })
    globalThis.fetch = originalFetch
  }
})

await check('阶段提示：归属不明的工作区摘要不提供流转按钮', async () => {
  for (const value of [undefined, null, '', 0]) {
    currentView = baseView('S2', { waiting: true, workspace: { flow: workspaceFlow({ sessionId: value }) } })
    const tree = (await render(stageHint, {})).toJSON()
    assert.ok(nodeByClass(tree, 'fg-hint-stage'), '摘要仍可显示')
    assert.equal(buttons(tree).length, 0, '归属不明不能操作门禁：' + String(value))
  }
})

await check('阶段提示：工作区摘要优先，本会话已结束或无流程也展示其他会话', async () => {
  for (const patch of [{}, { active: false }, { finished: true }, { cancelled: true }]) {
    currentView = baseView('S1', {
      progress: { stageIndex: 0, label: '旧会话需求' },
      waiting: true, waitingKind: 'doc', elapsedMs: 1000,
      activity: { text: '旧会话动作' },
      ...patch, workspace: { flow: workspaceFlow() },
    })
    const tree = (await render(stageHint, {})).toJSON()
    const text = flat(tree)
    assert.ok(text.includes('S4 测试'), text)
    assert.ok(text.includes('正在核对工作区结果'), text)
    assert.ok(text.includes('已用 2 分 5 秒'), text)
    assert.ok(!text.includes('旧会话') && !text.includes('批准并冻结'), text)
    assert.ok(nodeByClass(tree, 'fg-hint'), '不得继承本会话等待态')
    assert.equal(buttons(tree).length, 0, '跨会话摘要判不了门禁就绪，不给流转按钮')
    assert.ok(!hasButton(tree, '开始需求分析'), '流程进行中不能再从 dock 开新流程')
  }
})

await check('阶段提示：工作区等待使用摘要阶段与 waitingKind，不回读本会话', async () => {
  for (const [flow, expected] of [
    [workspaceFlow({ stage: 'S3', stageIndex: 2, label: '评审', waiting: true, waitingKind: 'gate' }), '等你点「通过评审，进入测试」'],
    [workspaceFlow({ stage: 'S1', stageIndex: 0, label: '需求分析', waiting: true, waitingKind: 'answer' }), '等你回答上面的问题'],
  ]) {
    currentView = baseView('S2', { workspace: { flow } })
    const tree = (await render(stageHint, {})).toJSON()
    assert.ok(nodeByClass(tree, 'fg-hint is-waiting'))
    assert.ok(flat(tree).includes(expected), flat(tree))
    assert.ok(!flat(tree).includes('完成开发'), flat(tree))
  }
})

await check('阶段提示：workspace 空摘要不回退，入口始终保留', async () => {
  for (const workspace of [{ flow: null }, {}, null]) {
    currentView = baseView('S2', { workspace })
    const tree = (await render(stageHint, {})).toJSON()
    assert.ok(buttonByText(tree, '开始需求分析'))
    assert.equal(nodeByClass(tree, 'fg-hint-stage'), null, JSON.stringify(workspace))
  }
  currentView = null
  assert.ok(buttonByText((await render(stageHint, {})).toJSON(), '开始需求分析'))
  assert.equal((await render(stageHint, {}, false)).toJSON(), null, '没有有效会话不占行')
})

await check('阶段提示：四阶段复用 Icon，每阶段图形不同且不增加读屏噪音', async () => {
  const paths = []
  for (const [index, stage] of ['S1', 'S2', 'S3', 'S4'].entries()) {
    currentView = baseView(stage, { workspace: { flow: workspaceFlow({ stage, stageIndex: index }) } })
    const renderer = await render(stageHint, {})
    const tree = renderer.toJSON()
    const icons = findTags(nodeByClass(tree, 'fg-hint-stage'), 'svg')
    assert.equal(icons.length, 1)
    assert.equal(icons[0].props.className, 'fg-icon')
    assert.equal(icons[0].props['aria-hidden'], true)
    assert.equal(renderer.root.findAll((node) => node.type?.name === 'Icon').length, 1, '复用现有 Icon 组件')
    paths.push(findTags(icons[0], 'path')[0].props.d)
  }
  assert.equal(new Set(paths).size, 4, '四阶段必须使用不同图形')
})

await check('阶段提示：切 session 首帧不闪旧 view，旧请求晚到不覆盖新会话', async () => {
  const originalFetch = globalThis.fetch
  const nextId = 'hint-switch-next-' + (++seq)
  const staleId = 'hint-switch-stale-' + (++seq)
  const commits = []
  let renderer = null
  let releaseNext = null
  let releaseStale = null
  function ObserveHint(props) {
    React.useLayoutEffect(() => { if (renderer) commits.push(flat(renderer.toJSON())) })
    return h(stageHint, props)
  }
  try {
    currentView = baseView('S2', { workspace: { flow: workspaceFlow({ stage: 'S2', stageIndex: 1, label: '旧工作区开发' }) } })
    renderer = await render(ObserveHint, { session: { sessionId: 'hint-switch-old-' + (++seq) } }, false)
    assert.ok(flat(renderer.toJSON()).includes('旧工作区开发'))
    globalThis.fetch = async (url, init) => {
      const id = new URL(String(url), 'http://localhost').searchParams.get('sessionId')
      if (id === nextId) return new Promise((resolve) => { releaseNext = resolve })
      if (id === staleId) return new Promise((resolve) => { releaseStale = resolve })
      return originalFetch(url, init)
    }
    commits.length = 0
    await act(async () => { renderer.update(h(ObserveHint, { session: { sessionId: staleId } })) })
    assert.ok(buttonByText(renderer.toJSON(), '开始需求分析'), '新会话加载中仍有入口')
    assert.equal(nodeByClass(renderer.toJSON(), 'fg-hint-stage'), null)
    assert.ok(commits.length > 0)
    assert.ok(commits.every((text) => !text.includes('旧工作区开发')), JSON.stringify(commits))
    await act(async () => { renderer.update(h(ObserveHint, { session: { sessionId: nextId } })) })
    assert.ok(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.equal(nodeByClass(renderer.toJSON(), 'fg-hint-stage'), null)
    assert.equal(typeof releaseNext, 'function')
    assert.equal(typeof releaseStale, 'function')
    await act(async () => { releaseNext(response({ active: false, workspace: { flow: workspaceFlow({ label: '新工作区测试' }) } })) })
    assert.ok(flat(renderer.toJSON()).includes('S4 新工作区测试'))
    await act(async () => { releaseStale(response({ active: false, workspace: { flow: workspaceFlow({ label: '迟到旧摘要' }) } })) })
    assert.ok(flat(renderer.toJSON()).includes('S4 新工作区测试'))
    assert.ok(!flat(renderer.toJSON()).includes('迟到旧摘要'))
  } finally {
    if (renderer) await act(async () => { renderer.unmount() })
    globalThis.fetch = originalFetch
    // 断言提前失败时也收掉在飞请求，不影响后续用例。
    await act(async () => {
      releaseNext?.(response(null))
      releaseStale?.(response(null))
    })
  }
})

await check('阶段提示样式：沿用宿主宽度变量和居中规则（静态契约，非视觉验收）', () => {
  const css = styleNodes[0].textContent
  const hint = css.match(/\.fg-hint\s*\{([^}]+)\}/)[1]
  assert.match(css, /\.fg-hint, \.fg-hint \*, \.fg-hint \*::before, \.fg-hint \*::after\s*\{\s*box-sizing:\s*border-box;/)
  assert.ok(hint.includes('width: calc(100% - 2 * var(--dsh-composer-side-clearance, 0px) - 4 * var(--dsh-composer-dock-inset, 0px));'))
  assert.ok(hint.includes('max-width: calc(var(--dsh-composer-card-max-width, 100%) - 4 * var(--dsh-composer-dock-inset, 0px));'))
  assert.match(hint, /flex:\s*none;/)
  assert.match(hint, /min-width:\s*0;/)
  assert.match(hint, /padding:\s*7px 0;/)
  assert.match(hint, /margin:\s*0 auto;/)
  assert.match(hint, /border:\s*0;/)
  assert.match(hint, /border-radius:\s*0;/)
  assert.match(hint, /background:\s*transparent;/)
  assert.ok(!/\.fg-hint\.is-waiting\s*\{/.test(css), '等待态也不应恢复卡片背景或边框')
})

await check('阶段提示：一行说清第几步、在做什么、已用多久', async () => {
  currentView = baseView('S2', {
    progress: { stageIndex: 1, label: '开发', percent: 50 },
    activity: { tool: 'edit', text: '编辑 lib/client.js', elapsedMs: 1000 },
    elapsedMs: 96000,
  })
  const tree = (await render(stageHint, {})).toJSON()
  assert.ok(nodeByClass(tree, 'fg-hint'), '应渲在输入框卡片上方那一行')
  const text = flat(tree)
  assert.ok(text.includes('S2 开发'), '应写明第几步与阶段名：' + text)
  assert.ok(text.includes('正在编辑 lib/client.js'), '应显示当前动作：' + text)
  assert.ok(text.includes('已用 1 分 36 秒'), '应显示已用时：' + text)
  assert.deepEqual(buttons(tree).map((node) => flat(node)), ['完成开发', '查看 scope 问题', '放弃这次流程'], 'S2 阶段信息旁给本阶段的流转按钮')
})

await check('阶段提示：宿主真实挂载形态（InputZone 的 session.sessionId）也渲染', async () => {
  currentView = baseView('S2', {
    progress: { stageIndex: 1, label: '开发', percent: 50 },
    elapsedMs: 96000,
  })
  // 宿主传给插槽组件的是 InputZone，sessionId 挂在 props.session.sessionId 上；
  // 这是组件唯一的真实挂载路径，写错时线上一个字都不显示。
  const tree = (await render(stageHint, { session: { sessionId: 'zone-session' } }, false)).toJSON()
  assert.ok(nodeByClass(tree, 'fg-hint'), '应渲染：' + flat(tree))
  assert.ok(flat(tree).includes('S2 开发'), '应认出当前阶段：' + flat(tree))
})

await check('阶段提示：已用时长不随轮询反复播报', async () => {
  currentView = baseView('S2', { progress: { stageIndex: 1, label: '开发' }, elapsedMs: 96000 })
  const tree = (await render(stageHint, {})).toJSON()
  const elapsed = nodeByClass(tree, 'fg-hint-elapsed')
  assert.ok(elapsed, '应显示已用时长：' + flat(tree))
  assert.equal(elapsed.props['aria-hidden'], 'true', '时长每 1.5 秒都在变，不该让读屏器反复重播整行')
})

await check('阶段提示：门禁在等时点名要点的按钮，并说明去哪里点', async () => {
  currentView = baseView('S3', {
    waiting: true,
    waitingKind: 'gate',
    progress: { stageIndex: 2, label: '评审', percent: 60 },
  })
  const tree = (await render(stageHint, {})).toJSON()
  const text = flat(tree)
  assert.ok(nodeByClass(tree, 'fg-hint is-waiting'), '等待态要有单独样式')
  assert.ok(text.includes('S3 评审'))
  assert.ok(text.includes('等你点「通过评审，进入测试」'), '应点名要点的按钮：' + text)
  assert.ok(text.includes('流程工作台'), '应说明去哪里点：' + text)
  assert.deepEqual(buttons(tree).map((node) => flat(node)), ['通过评审，进入测试', '退回开发修复', '回到需求分析调整 scope', '跳过评审，直接测试', '放弃这次流程'], '等待门禁时给的是本阶段可点的按钮')
})

await check('阶段提示：S1 的两种等待各自点名要做的动作', async () => {
  for (const [kind, want] of [['answer', '等你回答上面的问题'], ['doc', '等你点「批准并冻结 scope」']]) {
    currentView = baseView('S1', { waiting: true, waitingKind: kind })
    const text = flat((await render(stageHint, {})).toJSON())
    assert.ok(text.includes(want), kind + ' 应点名要做的动作：' + text)
  }
  // 子代理那边的 waitingKind 与阶段都取不到时，只说等确认，不编一个不存在的按钮名。
  currentView = baseView('S9', { waiting: true, waitingKind: null })
  const text = flat((await render(stageHint, {})).toJSON())
  assert.ok(text.includes('等你确认后继续'), '不该编造按钮名：' + text)
})

await check('阶段提示：视图没带 progress 时退回 stages 里的当前阶段', async () => {
  currentView = baseView('S3')
  const text = flat((await render(stageHint, {})).toJSON())
  assert.ok(text.includes('S3 评审'), '应能从 stages 认出当前阶段：' + text)
  assert.ok(text.includes('等待 Agent 下一步'), '没有动作时给中性文案：' + text)
  // 视图没带 elapsedMs 时不该渲染出一个不真实的「已用 0 秒」。
  assert.ok(!text.includes('已用 0 秒'), '缺时长时整段不渲染：' + text)
})

await check('阶段提示：阶段名缺失时只写 S 几，不留尾随空格', async () => {
  currentView = baseView('S2', {
    stages: [
      { id: 'S1', label: '' },
      { id: 'S2', label: '' },
      { id: 'S3', label: '' },
      { id: 'S4', label: '' },
    ],
  })
  const tree = (await render(stageHint, {})).toJSON()
  const stage = nodeByClass(tree, 'fg-hint-stage')
  assert.ok(stage, '应渲染阶段段：' + flat(tree))
  assert.equal(texts(stage).join(''), 'S2', '没有阶段名时只写 S2：' + JSON.stringify(texts(stage)))
})

await check('阶段提示：没有流程、已结束或已放弃时仅保留快捷入口', async () => {
  for (const patch of [{ active: false }, { finished: true }, { cancelled: true }]) {
    currentView = baseView('S2', patch)
    const tree = (await render(stageHint, {})).toJSON()
    assert.ok(buttonByText(tree, '开始需求分析'))
    assert.equal(nodeByClass(tree, 'fg-hint-stage'), null, JSON.stringify(patch))
  }
})

await check('阶段提示：dock 给出本阶段的流转按钮，四个阶段各不相同', async () => {
  const labels = (tree) => buttons(nodeByClass(tree, 'fg-hint-actions') || tree).map((node) => flat(node))
  const cases = [
    ['S1', { doc: { html: '<p>需求</p>', pending: true } }, ['需求文档', '批准并冻结 scope', '修改需求', '跳过评审，直接开发', '放弃这次流程']],
    // S2 不再给「跳过门禁，直接评审」：服务端对 S2 不做门禁校验，两个按钮只有阶段标记不同。
    ['S2', {}, ['完成开发', '查看 scope 问题', '放弃这次流程']],
    ['S3', {}, ['通过评审，进入测试', '退回开发修复', '回到需求分析调整 scope', '跳过评审，直接测试', '放弃这次流程']],
    // S4 无缺口时只留结束流程：没有可修的东西，跳过门禁的结果还更差。
    ['S4', { acceptance: { items: [{ id: 'AC-1', status: 'pass', evidence: '日志' }], counts: { total: 1, pass: 1, fail: 0, uncovered: 0, pending: 0 } } }, ['结束流程', '放弃这次流程']],
  ]
  const seen = []
  for (const [stage, patch, expected] of cases) {
    currentView = baseView(stage, patch)
    const got = labels((await render(stageHint, {})).toJSON())
    assert.deepEqual(got, expected, stage + ' 的流转按钮')
    seen.push(got.join('|'))
  }
  assert.equal(new Set(seen).size, cases.length, '四个阶段的按钮集合两两不同')
})

await check('阶段提示：S1 未交文档只留放弃，S3 有 scope 外发现时先让回需求分析', async () => {
  // 文档还没交：工作台此时也不给决策按钮，dock 保持一致。
  currentView = baseView('S1', { waiting: true, waitingKind: 'answer' })
  assert.deepEqual(buttons((await render(stageHint, {})).toJSON()).map((node) => flat(node)), ['放弃这次流程'])
  // 有发现落在冻结 scope 之外：退回开发也改不到，要先调 scope，顺序与工作台一致。
  currentView = baseView('S3', { reviewOutsideScope: [{ id: 'f1', file: 'src/other.ts', severity: 'CRITICAL', summary: '跨出 scope' }] })
  assert.deepEqual(buttons((await render(stageHint, {})).toJSON()).map((node) => flat(node)), ['通过评审，进入测试', '退回开发修复', '回到需求分析调整 scope', '跳过评审，直接测试', '放弃这次流程'])
  // 为什么冒出回 S1 的入口，工作台会用一句话说清，dock 也要说清。
  assert.match(flat((await render(stageHint, {})).toJSON()), /评审有 1 条发现落在冻结 scope 之外/)
})

await check('阶段提示：流转按钮的置灰与门禁就绪同源', async () => {
  // 宿主没在等、门禁产物也还没交：点了不会发生任何事，跟工作台一样置灰。
  currentView = baseView('S2')
  let tree = (await render(stageHint, {})).toJSON()
  for (const label of ['完成开发']) {
    assert.equal(buttonByText(tree, label).props.disabled, true, label + ' 在门禁就绪前应置灰')
  }
  assert.equal(buttonByText(tree, '放弃这次流程').props.disabled, false, '放弃不受门禁限制')
  // 「查看 scope 问题」只是摊开原因，不推进阶段，门禁没就绪也该能点。
  assert.equal(buttonByText(tree, '查看 scope 问题').props.disabled, false, '查看类入口不受门禁限制')
  assert.ok(buttonByText(tree, '完成开发').props.className.includes('fg-hint-btn-primary'), '主按钮要与工作台一样用主色')
  // 宿主正在等：就绪。
  currentView = baseView('S2', { waiting: true, waitingKind: 'gate' })
  tree = (await render(stageHint, {})).toJSON()
  assert.equal(buttonByText(tree, '完成开发').props.disabled, false, '宿主在等时可点')
  // 门禁产物已交（gate.pending）同样算就绪。
  currentView = baseView('S2', { gate: { pending: true } })
  tree = (await render(stageHint, {})).toJSON()
  assert.equal(buttonByText(tree, '完成开发').props.disabled, false, '门禁产物已交时可点')
})

await check('阶段提示：放弃要两次确认，S4 带缺口时不提供一键结束', async () => {
  currentView = baseView('S4', {
    waiting: true,
    waitingKind: 'gate',
    acceptance: { items: [{ id: 'AC-1', status: 'fail', reason: '返回 500' }], counts: { total: 1, pass: 0, fail: 1, uncovered: 0, pending: 0 } },
  })
  const renderer = await render(stageHint, {})
  posted = []
  await click(buttonByText(renderer.toJSON(), '放弃这次流程'))
  assert.equal(posted.length, 0, '第一次点击只是换按钮，不投递请求')
  assert.ok(buttonByText(renderer.toJSON(), '确认放弃'))
  await click(buttonByText(renderer.toJSON(), '再想想'))
  assert.ok(buttonByText(renderer.toJSON(), '放弃这次流程'), '反悔后回到原按钮')
  assert.equal(posted.length, 0)
  // 有未通过项时快捷入口不再给一键结束：这一排按钮摆不下缺口清单，
  // 也就没法让人「看清了再接受」，所以例外结项只留在出口门禁里走两步确认。
  const hintTree = renderer.toJSON()
  const hintLabels = buttons(hintTree).map((node) => flat(node))
  assert.equal(hintLabels.includes('结束流程'), false, '快捷入口不能绕开例外确认')
  assert.ok(hintLabels.includes('结束流程（需确认）'), '有缺口时先摊开缺口，再点第二次确认')
  assert.ok(buttonByText(hintTree, '退回开发修复'), '带缺口时仍能退回修复')
  // 两本账并排写在一行：只报测试要点会让人把「0 失败」读成验收通过。
  assert.match(flat(hintTree), /验收标准：通过 0 · 未通过 1 · 未覆盖 0 · 待验证 0（共 1 条）/, '快捷入口要说清 AC 账本')
  assert.match(flat(hintTree), /测试要点：通过 0 · 失败 0 · 未覆盖 0 · 环境受限 0（共 0 个）/, '快捷入口要并排报测试要点')
  assert.match(flat(hintTree), /带缺口结束要先看清缺口，再点「结束流程（需确认）」/)
  assert.equal(posted.length, 0, '摆说明本身不投递任何请求')
  // 放弃：两次确认后才真的投递 cancel。
  await click(buttonByText(renderer.toJSON(), '放弃这次流程'))
  await click(buttonByText(renderer.toJSON(), '确认放弃'))
  const cancel = posted[posted.length - 1]
  assert.equal(cancel.action, 'cancel')
  assert.ok(cancel.payload.reason, '放弃要留下原因')
})

await check('阶段提示：投递失败要留下可诊断的错误行，认不出的阶段落到最后一档', async () => {
  currentView = baseView('S2', { waiting: true, waitingKind: 'gate' })
  const renderer = await render(stageHint, {})
  posted = []
  // 只让这一次投递失败，其它请求照旧交给默认 mock。
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => String(url).includes('/action')
    ? { ok: false, status: 500, json: async () => ({ ok: false, error: '宿主拒绝了这次操作' }) }
    : realFetch(url, init)
  try {
    await click(buttonByText(renderer.toJSON(), '完成开发'))
    const err = nodeByClass(renderer.toJSON(), 'fg-hint-err')
    assert.ok(err, '投递失败要显示错误行，不能静默吞掉')
    assert.equal(err.props.role, 'alert')
    assert.match(flat(err), /宿主拒绝了这次操作/)
  } finally {
    globalThis.fetch = realFetch
  }
  // stage 认不出来时工作台落到最后一档，dock 给出同一组按钮。
  currentView = baseView('S9', { waiting: true, waitingKind: 'gate' })
  assert.deepEqual(buttons(nodeByClass((await render(stageHint, {})).toJSON(), 'fg-hint-actions')).map((node) => flat(node)), ['结束流程', '放弃这次流程'])
})

await check('阶段提示：标题计时与待办分组，右侧独立承载按钮', async () => {
  for (const stage of ['S1', 'S2', 'S3', 'S4']) {
    currentView = baseView(stage, { elapsedMs: 96000 })
    const tree = (await render(stageHint, {})).toJSON()
    const hint = nodeByClass(tree, 'fg-hint')
    const content = nodeByClass(hint, 'fg-hint-content')
    const head = nodeByClass(content, 'fg-hint-head')
    assert.ok(nodeByClass(head, 'fg-hint-title'), stage + ' 标题保留在左侧辅助信息组')
    assert.ok(nodeByClass(head, 'fg-hint-elapsed'), stage + ' 时长保留在左侧辅助信息组')
    assert.deepEqual(head.children.map((node) => node.props.className), ['fg-hint-title', 'fg-hint-elapsed'], stage + ' 标题在前，辅助计时在后')
    assert.ok(nodeByClass(content, 'fg-hint-info'), stage + ' 阶段与待办保留在独立信息组')
    assert.equal(nodeByClass(content, 'fg-hint-actions'), null, '按钮不应挤进左侧内容')
    assert.ok(nodeByClass(hint, 'fg-hint-actions'), stage + ' 右侧应有操作按钮')
  }
  currentView = baseView('S2', { active: false })
  const empty = (await render(stageHint, {})).toJSON()
  const content = nodeByClass(empty, 'fg-hint-content')
  assert.equal(flat(nodeByClass(content, 'fg-hint-info')), '从需求分析开始新流程')
  assert.equal(nodeByClass(content, 'fg-hint-start'), null)
  assert.ok(nodeByClass(empty, 'fg-hint-start'), '空态右侧保留开始入口')
  assert.equal(nodeByClass(empty, 'fg-hint-elapsed'), null)
})

function quickDialog(renderer) { return findTags(renderer.toJSON(), 'dialog')[0] || null }

await check('阶段提示：左右列自适应、按钮换排且颜色区分（样式契约）', async () => {
  const css = styleNodes[0].textContent
  assert.match(css, /\.fg-hint\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) fit-content\(65%\);[^}]*align-items:\s*center;/)
  assert.match(css, /@media \(max-width: 640px\) \{\s*\.fg-hint \{ grid-template-columns: minmax\(0, 1fr\); \}\s*\.fg-hint-actions \{[^}]*justify-content: flex-start;[^}]*\}/)
  assert.match(css, /\.fg-hint-content\s*\{[^}]*flex-direction:\s*column;[^}]*justify-content:\s*center;/)
  assert.match(css, /\.fg-hint-title\s*\{[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis;/)
  assert.match(css, /\.fg-hint-actions\s*\{[^}]*justify-content:\s*flex-end;[^}]*flex-wrap:\s*wrap;/)
  assert.match(css, /\.fg-hint-btn-primary:not\(:disabled\)\s*\{[^}]*background:\s*var\(--dsw-alias-brand-primary\);/)
  assert.match(css, /\.fg-hint-btn-danger:not\(:disabled\)\s*\{[^}]*color:\s*var\(--dsw-alias-state-error-primary\);/)
  assert.match(css, /\.fg-hint-start\s*\{[^}]*justify-self:\s*end;[^}]*background:\s*var\(--dsw-alias-brand-primary\);/)
  currentView = baseView('S2', { title: '超长需求标题'.repeat(30) })
  const tree = (await render(stageHint, {})).toJSON()
  const title = nodeByClass(tree, 'fg-hint-title')
  assert.equal(title.props.title, currentView.title)
  assert.equal(flat(title), currentView.title)
})

await check('快捷文档：提交后才可点击独立预览，关闭不触发门禁', async () => {
  currentView = baseView('S1', { doc: { html: '<h1>验收标准</h1>', pending: true } }); posted = []
  const renderer = await render(stageHint, {})
  assert.equal(quickDialog(renderer), null, '报告完成后不自动弹窗')
  await click(buttonByText(renderer.toJSON(), '需求文档'))
  const dialog = quickDialog(renderer)
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.equal(findTags(dialog, 'iframe')[0].props.srcDoc, currentView.doc.html)
  await click(buttonByText(dialog, '关闭'))
  assert.equal(quickDialog(renderer), null)
  assert.equal(posted.length, 0)
  currentView = baseView('S1')
  assert.equal(buttons((await render(stageHint, {})).toJSON()).some((node) => flat(node) === '需求文档'), false)
})

await check('快捷评审：阻塞与建议分别列出，报告存在时才显示入口', async () => {
  currentView = baseView('S3', { review: { counts: { blocking: 1, advisories: 2 }, angles: [{ findings: [
    { severity: 'MAJOR', blocking: true, file: 'lib/client.js', ac: 'AC-1', summary: '阻塞问题' },
    { severity: 'CRITICAL', blocking: false, file: 'elsewhere.js', summary: '范围外建议' },
    { severity: 'MINOR', blocking: false, file: 'lib/client.js', summary: '次要建议' },
  ] }] } })
  const renderer = await render(stageHint, {})
  assert.equal(quickDialog(renderer), null)
  await click(buttonByText(renderer.toJSON(), '评审报告'))
  const dialog = quickDialog(renderer)
  assert.match(flat(dialog), /阻塞项 · 1.*阻塞问题.*建议项 · 2.*范围外建议.*次要建议/)
  assert.equal(findTags(dialog, 'h2')[0].props.id, dialog.props['aria-labelledby'])
  await click(buttonByText(dialog, '关闭'))
  assert.equal(quickDialog(renderer), null)
  assert.equal(buttons((await render(stageHint, {})).toJSON()).some((node) => flat(node).startsWith('测试报告')), false)
})

await check('快捷测试：区分失败、未覆盖、环境受限并保留原因', async () => {
  currentView = baseView('S4', {
    test: { directions: [{ name: '回归', points: [
      { result: 'fail', point: '提交失败', detail: '返回 500' },
      { result: 'uncovered', point: '窄屏测量', detail: '宿主未认证' },
      { result: 'excluded', point: '原生弹窗', excludeReason: '缺少桌面宿主' },
      { result: 'pass', point: '正常路径' },
    ] }] },
    acceptance: { items: [{ id: 'AC-4', status: 'fail', reason: '缺少截图' }] },
  })
  const renderer = await render(stageHint, {})
  assert.equal(quickDialog(renderer), null)
  await click(buttonByText(renderer.toJSON(), '测试报告'))
  const text = flat(quickDialog(renderer))
  for (const value of ['未通过 · 2', '提交失败', '返回 500', 'AC-4', '缺少截图', '未覆盖 · 1', '窄屏测量', '环境受限 · 1', '原生弹窗', '缺少桌面宿主']) assert.ok(text.includes(value), value + ' 未出现：' + text)
  assert.ok(!text.includes('正常路径'))
  await click(buttonByText(quickDialog(renderer), '关闭'))
  assert.equal(quickDialog(renderer), null)
})

await check('报告弹窗：进入顶层并在 Esc 和关闭按钮后归还触发按钮焦点', async () => {
  currentView = baseView('S2', { doc: { html: '<p>文档</p>' } })
  let focused = null, opened = 0
  const trigger = { focus() { focused = trigger } }
  const mock = (element) => {
    if (element.type === 'button' && element.props['aria-haspopup'] === 'dialog' && element.props.className === 'fg-hint-btn') return trigger
    if (element.type === 'dialog') return { open: false, showModal() { this.open = true; opened += 1 } }
    if (element.props.className === 'fg-modal-card') return { focus() {} }
    return null
  }
  let renderer
  await act(async () => { renderer = TestRenderer.create(h(stageHint, { sessionId: 'report-focus' }), { createNodeMock: mock }) })
  try {
    await settle()
    const open = async () => {
      await act(async () => {
        buttonByText(renderer.toJSON(), '需求文档').props.onClick({ currentTarget: trigger })
      })
      assert.ok(quickDialog(renderer))
    }
    await open()
    assert.equal(opened, 1)
    await click(buttonByText(quickDialog(renderer), '关闭'))
    assert.equal(quickDialog(renderer), null)
    assert.equal(focused, trigger)
    focused = null
    await open()
    await act(async () => { pressEscape() })
    assert.equal(quickDialog(renderer), null)
    assert.equal(focused, trigger)
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('快捷需求：关闭保留草稿和档位，切会话关闭并隔离草稿', async () => {
  currentView = baseView('S1', { active: false, workspace: { flow: null } })
  const first = 'quick-draft-a', second = 'quick-draft-b'
  const renderer = await render(stageHint, { session: { sessionId: first } }, false)
  try {
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    let dialog = quickDialog(renderer)
    const title = findTags(dialog, 'h2')[0]
    assert.equal(dialog.props['aria-labelledby'], title.props.id)
    assert.equal(dialog.props['aria-modal'], 'true')
    const raw = '  快捷需求 "引用" @"D:\\项目 空格\\文件"\n./路径 /d/repo \\\\server\\共享  '
    await changeValue(fieldByAria(dialog, '需求原文'), raw)
    await click(buttonByText(quickDialog(renderer), '大需求严格执行'))
    await click(buttonByText(quickDialog(renderer), '关闭'))
    assert.equal(quickDialog(renderer), null)
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.equal(fieldByAria(quickDialog(renderer), '需求原文').props.value, raw)
    assert.equal(buttonByText(quickDialog(renderer), '大需求严格执行').props['aria-pressed'], true)
    await act(async () => { renderer.update(h(stageHint, { session: { sessionId: second } })) })
    assert.equal(quickDialog(renderer), null, '切换会话应关闭旧弹窗')
    await settle()
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.equal(fieldByAria(quickDialog(renderer), '需求原文').props.value, '')
    await changeValue(fieldByAria(quickDialog(renderer), '需求原文'), '第二个会话')
    await act(async () => { renderer.update(h(stageHint, { session: { sessionId: first } })) })
    await settle()
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.equal(fieldByAria(quickDialog(renderer), '需求原文').props.value, raw)
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('快捷需求：按钮和Ctrl/Cmd+Enter正确提交当前会话、原文与档位，成功清草稿', async () => {
  for (const mode of ['click', 'ctrl', 'meta']) {
    currentView = baseView('S1', { active: false, workspace: { flow: null } }); posted = []; prepareCalls.length = 0
    const sessionId = 'quick-success-' + mode
    const originalPrepare = prepareHandler
    prepareHandler = () => response({ title: '模型整理后的明确标题', status: 'ready' })
    const renderer = await render(stageHint, { sessionId }, false)
    try {
      await click(buttonByText(renderer.toJSON(), '开始需求分析'))
      const raw = '  新需求 "@file" 中文\n保留空格  '
      await changeValue(fieldByAria(quickDialog(renderer), '需求原文'), raw)
      await click(buttonByText(quickDialog(renderer), '大需求严格执行'))
      if (mode === 'click') await click(buttonByText(quickDialog(renderer), '开始需求分析'))
      else {
        assert.equal(await pressKey(fieldByAria(quickDialog(renderer), '需求原文'), { ctrlKey: mode === 'ctrl', metaKey: mode === 'meta' }), 1)
        await settle()
      }
      const starts = posted.filter((item) => item.action === 'start')
      assert.equal(starts.length, 1)
      assert.equal(starts[0].sessionId, sessionId)
      assert.equal(starts[0].payload.brief, raw)
      assert.equal(starts[0].payload.preset, 'strict')
      assert.deepEqual(prepareCalls, [{ sessionId, brief: raw }])
      assert.equal(starts[0].payload.title, '模型整理后的明确标题')
      assert.equal('summary' in starts[0].payload, false, '启动请求不再携带整理稿')
      assert.equal(quickDialog(renderer), null, '成功应关闭弹窗')
      await click(buttonByText(renderer.toJSON(), '开始需求分析'))
      assert.equal(fieldByAria(quickDialog(renderer), '需求原文').props.value, '')
      assert.equal(buttonByText(quickDialog(renderer), '小功能快速开发').props['aria-pressed'], true)
    } finally { prepareHandler = originalPrepare; await act(async () => { renderer.unmount() }) }
  }
})

await check('快捷需求：模型整理失败静默降级，保留原文并继续启动', async () => {
  currentView = baseView('S1', { active: false, workspace: { flow: null } }); posted = []; prepareCalls.length = 0
  const originalPrepare = prepareHandler
  const originalWarn = console.warn
  const warnings = []
  prepareHandler = () => response({ error: '临时不可用' }, 503)
  console.warn = (message) => warnings.push(message)
  const renderer = await render(stageHint, { sessionId: 'quick-fallback' }, false)
  try {
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    const brief = '  记录原文约束\n不能丢失  '
    await changeValue(fieldByAria(quickDialog(renderer), '需求原文'), brief)
    await click(buttonByText(quickDialog(renderer), '开始需求分析'))
    assert.deepEqual(prepareCalls, [{ sessionId: 'quick-fallback', brief }])
    assert.equal(posted.length, 1)
    assert.equal(posted[0].payload.brief, brief)
    assert.match(posted[0].payload.title, /记录原文约束/)
    assert.equal(quickDialog(renderer), null)
    assert.ok(warnings.some((message) => message.includes('unavailable')))
    prepareHandler = () => response({ title: '本地标题', status: 'fallback' })
    posted = []; prepareCalls.length = 0; warnings.length = 0
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    await changeValue(fieldByAria(quickDialog(renderer), '需求原文'), '再次提交')
    await click(buttonByText(quickDialog(renderer), '开始需求分析'))
    assert.deepEqual(prepareCalls, [{ sessionId: 'quick-fallback', brief: '再次提交' }])
    assert.equal(posted[0].payload.title, '本地标题')
    assert.equal(quickDialog(renderer), null)
    assert.ok(warnings.some((message) => message.includes('model-fallback')))
  } finally {
    prepareHandler = originalPrepare; console.warn = originalWarn
    await act(async () => { renderer.unmount() })
  }
})

await check('快捷需求：空白、超长、输入法组合态不提交，正好20000字符可提交', async () => {
  currentView = baseView('S1', { active: false, workspace: { flow: null } }); posted = []; prepareCalls.length = 0
  const renderer = await render(stageHint, { sessionId: 'quick-boundaries' }, false)
  try {
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    for (const raw of ['', ' \n\t ', '中'.repeat(20001), 'a'.repeat(100000)]) {
      await changeValue(fieldByAria(quickDialog(renderer), '需求原文'), raw)
      assert.equal(fieldByAria(quickDialog(renderer), '需求原文').props.value, raw, '不截断用户输入')
      assert.equal(buttonByText(quickDialog(renderer), '开始需求分析').props.disabled, true)
      await pressKey(fieldByAria(quickDialog(renderer), '需求原文'), { ctrlKey: true })
    }
    assert.equal(posted.length, 0); assert.equal(prepareCalls.length, 0)
    await changeValue(fieldByAria(quickDialog(renderer), '需求原文'), '正常需求')
    assert.equal(await pressKey(fieldByAria(quickDialog(renderer), '需求原文'), { ctrlKey: true, isComposing: true }), 0)
    assert.equal(await pressKey(fieldByAria(quickDialog(renderer), '需求原文'), { metaKey: true, nativeEvent: { isComposing: true } }), 0)
    assert.equal(posted.length, 0)
    const limit = '中'.repeat(20000)
    await changeValue(fieldByAria(quickDialog(renderer), '需求原文'), limit)
    assert.equal(buttonByText(quickDialog(renderer), '开始需求分析').props.disabled, false)
    await click(buttonByText(quickDialog(renderer), '开始需求分析'))
    assert.equal(posted.length, 1); assert.equal(posted[0].payload.brief, limit)
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('快捷需求：请求期间及切走返回均防重复提交，关闭/Esc/遮罩不能中断，完成后解锁', async () => {
  currentView = baseView('S1', { active: false, workspace: { flow: null } }); posted = []; prepareCalls.length = 0
  let release
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => {
    if (!String(url).includes('/action')) return originalFetch(url, init)
    posted.push(JSON.parse(init.body))
    return new Promise((resolve) => { release = resolve })
  }
  const renderer = await render(stageHint, { sessionId: 'quick-busy' }, false)
  try {
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    await changeValue(fieldByAria(quickDialog(renderer), '需求原文'), '延迟启动')
    const button = buttonByText(quickDialog(renderer), '开始需求分析')
    await act(async () => { button.props.onClick(); button.props.onClick() })
    await pressKey(fieldByAria(quickDialog(renderer), '需求原文'), { metaKey: true })
    assert.equal(posted.length, 1)
    assert.equal(buttonByText(quickDialog(renderer), '关闭').props.disabled, true)
    await click(buttonByText(quickDialog(renderer), '关闭'))
    await act(async () => { pressEscape() })
    let prevented = 0
    await act(async () => {
      quickDialog(renderer).props.onCancel({ preventDefault() { prevented += 1 } })
      const target = {}
      quickDialog(renderer).props.onClick({ target, currentTarget: target })
    })
    assert.equal(prevented, 1); assert.ok(quickDialog(renderer))
    await act(async () => { renderer.update(h(stageHint, { sessionId: 'quick-busy-other' })) })
    assert.equal(quickDialog(renderer), null)
    await act(async () => { renderer.update(h(stageHint, { sessionId: 'quick-busy' })) })
    await settle()
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.equal(fieldByAria(quickDialog(renderer), '需求原文').props.value, '延迟启动')
    assert.equal(fieldByAria(quickDialog(renderer), '需求原文').props.disabled, true, '旧请求未结束时返回也不能改写提交中的草稿')
    assert.equal(buttonByText(quickDialog(renderer), '正在启动…').props.disabled, true)
    await pressKey(fieldByAria(quickDialog(renderer), '需求原文'), { ctrlKey: true })
    await click(buttonByText(quickDialog(renderer), '正在启动…'))
    assert.equal(posted.length, 1, '跨挂载仍然只有一次请求')
    await act(async () => { release(response({ ok: true })) })
    assert.equal(posted.length, 1); assert.equal(quickDialog(renderer), null)
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.equal(fieldByAria(quickDialog(renderer), '需求原文').props.value, '', '成功后共享草稿已清空')
    assert.equal(fieldByAria(quickDialog(renderer), '需求原文').props.disabled, false)
  } finally {
    release?.(response({ ok: true })); globalThis.fetch = originalFetch
    await act(async () => { renderer.unmount() })
  }
})

await check('快捷需求：启动失败保留原文、档位和错误并恢复关闭能力', async () => {
  currentView = baseView('S1', { active: false, workspace: { flow: null } })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => String(url).includes('/action') ? response({ error: '启动服务暂不可用' }, 503) : originalFetch(url, init)
  const renderer = await render(stageHint, { sessionId: 'quick-failure' }, false)
  try {
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    await changeValue(fieldByAria(quickDialog(renderer), '需求原文'), '不能丢失的原文')
    await click(buttonByText(quickDialog(renderer), '大需求严格执行'))
    await click(buttonByText(quickDialog(renderer), '开始需求分析'))
    assert.equal(fieldByAria(quickDialog(renderer), '需求原文').props.value, '不能丢失的原文')
    assert.equal(buttonByText(quickDialog(renderer), '大需求严格执行').props['aria-pressed'], true)
    assert.ok(flat(quickDialog(renderer)).includes('启动服务暂不可用'))
    assert.equal(buttonByText(quickDialog(renderer), '关闭').props.disabled, false)
    await click(buttonByText(quickDialog(renderer), '关闭'))
    assert.equal(quickDialog(renderer), null)
  } finally { globalThis.fetch = originalFetch; await act(async () => { renderer.unmount() }) }
})

await check('快捷需求：切走返回后的延迟失败持续保留原文档位及原因，成功重试后清除', async () => {
  currentView = baseView('S1', { active: false, workspace: { flow: null } }); posted = []
  const originalFetch = globalThis.fetch
  let release, attempts = 0
  globalThis.fetch = (url, init) => {
    if (!String(url).includes('/action')) return originalFetch(url, init)
    posted.push(JSON.parse(init.body))
    if (++attempts === 1) return new Promise((resolve) => { release = resolve })
    return response({ ok: true })
  }
  const renderer = await render(stageHint, { sessionId: 'quick-late-error' }, false)
  const switchTo = async (sessionId) => {
    await act(async () => { renderer.update(h(stageHint, { sessionId })) })
    await settle()
  }
  try {
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    await changeValue(fieldByAria(quickDialog(renderer), '需求原文'), '异步失败也不能丢失')
    await click(buttonByText(quickDialog(renderer), '大需求严格执行'))
    await click(buttonByText(quickDialog(renderer), '开始需求分析'))
    await switchTo('quick-late-error-other'); await switchTo('quick-late-error')
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    await act(async () => { release(response({ error: '延迟启动失败的具体原因' }, 503)) })
    assert.ok(flat(quickDialog(renderer)).includes('延迟启动失败的具体原因'))
    await click(buttonByText(quickDialog(renderer), '关闭'))
    // 重新订阅会拉取成功状态并清除临时 entry.error；启动错误仍须保留。
    await switchTo('quick-late-error-other'); await switchTo('quick-late-error')
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.ok(flat(quickDialog(renderer)).includes('延迟启动失败的具体原因'))
    assert.equal(fieldByAria(quickDialog(renderer), '需求原文').props.value, '异步失败也不能丢失')
    assert.equal(buttonByText(quickDialog(renderer), '大需求严格执行').props['aria-pressed'], true)
    assert.equal(buttonByText(quickDialog(renderer), '开始需求分析').props.disabled, false)
    await click(buttonByText(quickDialog(renderer), '开始需求分析'))
    assert.equal(attempts, 2); assert.equal(quickDialog(renderer), null)
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.equal(fieldByAria(quickDialog(renderer), '需求原文').props.value, '')
    assert.ok(!flat(quickDialog(renderer)).includes('延迟启动失败的具体原因'))
  } finally {
    release?.(response({ error: '清理延迟请求' }, 503)); globalThis.fetch = originalFetch
    await act(async () => { renderer.unmount() })
  }
})

await check('快捷需求：拿不到工作区流程状态时只允许写草稿，加载失败禁止提交', async () => {
  for (const patch of [
    { active: false, workspace: {} },
    { active: false, workspace: null },
  ]) {
    currentView = baseView('S2', patch); posted = []; prepareCalls.length = 0
    const sessionId = 'quick-guard-' + (++seq)
    const renderer = await render(stageHint, { sessionId }, false)
    try {
      await click(buttonByText(renderer.toJSON(), '开始需求分析'))
      await changeValue(fieldByAria(quickDialog(renderer), '需求原文'), '先记下新需求')
      assert.ok(/请先结束或放弃|暂时无法确认工作区流程状态/.test(flat(quickDialog(renderer))))
      assert.equal(buttonByText(quickDialog(renderer), '开始需求分析').props.disabled, true)
      await pressKey(fieldByAria(quickDialog(renderer), '需求原文'), { ctrlKey: true })
      await click(buttonByText(quickDialog(renderer), '开始需求分析'))
      assert.equal(posted.length, 0); assert.equal(prepareCalls.length, 0)
      assert.equal(fieldByAria(quickDialog(renderer), '需求原文').props.disabled, false)
    } finally { await act(async () => { renderer.unmount() }) }
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => response({ error: '读取状态失败' }, 503)
  const renderer = await render(stageHint, { sessionId: 'quick-load-failure' }, false)
  try {
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    await changeValue(fieldByAria(quickDialog(renderer), '需求原文'), '状态未知')
    assert.ok(flat(quickDialog(renderer)).includes('暂时无法确认流程状态'))
    assert.equal(buttonByText(quickDialog(renderer), '开始需求分析').props.disabled, true)
  } finally { globalThis.fetch = originalFetch; await act(async () => { renderer.unmount() }) }
})

await check('快捷需求：焦点进入原文、Tab回绕，Esc/关闭/遮罩退出后恢复触发按钮', async () => {
  currentView = baseView('S1', { active: false, workspace: { flow: null } })
  let focused = null, showCalls = 0
  const nodes = new Map(), tabNodes = []
  const mock = (element) => {
    const key = element.props.className === 'fg-hint-start' ? 'trigger'
      : element.props.className === 'fg-modal-card' ? 'card'
        : element.type === 'dialog' ? 'dialog' : element.type === 'textarea' ? 'input' : null
    if (!key) return null
    if (nodes.has(key)) return nodes.get(key)
    const node = { focus() { focused = node }, open: false, showModal() { this.open = true; showCalls += 1 } }
    if (key === 'card') node.querySelectorAll = () => tabNodes
    nodes.set(key, node)
    return node
  }
  let renderer
  await act(async () => { renderer = TestRenderer.create(h(stageHint, { sessionId: 'quick-focus' }), { createNodeMock: mock }) })
  try {
    await settle()
    const trigger = renderer.root.findByProps({ className: 'fg-hint-start' }).instance
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.equal(showCalls, 1, '快捷弹窗进入浏览器顶层')
    assert.equal(focused, renderer.root.findByType('textarea').instance, '初始焦点应在原文')
    const first = { focus() { focused = first } }, last = { focus() { focused = last } }
    tabNodes.push(first, { disabled: true, focus() { assert.fail('禁用控件不能获得焦点') } }, last)
    let prevented = 0
    const tab = (target, shiftKey) => quickDialog(renderer).props.onKeyDown({
      key: 'Tab', currentTarget: nodes.get('dialog'), target, shiftKey, preventDefault() { prevented += 1 },
    })
    last.focus(); tab(last, false); assert.equal(focused, first)
    tab(first, true); assert.equal(focused, last)
    tab(nodes.get('card'), true); assert.equal(focused, last); assert.equal(prevented, 3)
    await act(async () => { pressEscape() })
    assert.equal(quickDialog(renderer), null); assert.equal(focused, trigger)
    for (const via of ['close', 'overlay']) {
      await click(buttonByText(renderer.toJSON(), '开始需求分析'))
      if (via === 'close') await click(buttonByText(quickDialog(renderer), '关闭'))
      else await act(async () => { const target = {}; quickDialog(renderer).props.onClick({ target, currentTarget: target }) })
      assert.equal(quickDialog(renderer), null); assert.equal(focused, trigger)
    }
  } finally { await act(async () => { renderer.unmount() }) }
  const plain = await render(stageHint, { sessionId: 'quick-tab' }, false)
  try {
    await click(buttonByText(plain.toJSON(), '开始需求分析'))
    const dialog = quickDialog(plain), card = focusDomOf(dialog)
    const focusable = card.querySelectorAll('button,textarea').filter((node) => !node.disabled)
    const first = focusable[0], last = focusable.at(-1)
    let prevented = 0
    const tab = (target, shiftKey) => dialog.props.onKeyDown({ key: 'Tab', currentTarget: card, target, shiftKey, preventDefault() { prevented += 1 } })
    last.focus(); tab(last, false); assert.equal(card.activeElement, first)
    tab(first, true); assert.equal(card.activeElement, last); assert.equal(prevented, 2)
  } finally { await act(async () => { plain.unmount() }) }
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
  await check('空态只要求填写需求原文，标题自动生成', () => {
    assert.ok(flat(renderer.toJSON()).includes('需求描述'))
    const found = areas()
    assert.equal(found.length, 1, '标题自动生成，表单里不再提供可编辑的标题或整理稿输入框')
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
    assert.equal(last.payload.title, '会话过期返回 401，并给出重新认证入口')
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

// P0-4：批准前必须能看到「这次将允许改哪些文件」，否则等于盲签。
{
  currentView = baseView('S1', {
    doc: {
      html: '<html><body>需求文档</body></html>',
      recommendedPreset: 'fast',
      reason: '只改两个文件',
      at: '2026-11-17T09:20:00Z',
      pending: true,
      pendingScope: {
        files_expected_to_change: ['src/auth/session.ts', 'src/auth/store.ts'],
        // 带方括号后缀的条目要和它执行的目录一起展示：只显示命令原文，用户会以为它在流程根跑。
        commands: ['npm test', 'npm run *', 'npm run build [packages/web]'],
        capabilities: ['会话过期检测'],
        shared_contracts: ['checkExpiry(session, now) 的签名与返回值保持不变'],
        out_of_scope_explicitly: ['OAuth 第三方登录'],
        acceptance_criteria: [{ id: 'AC-1', when: '会话超过 30 分钟未活动', then: '返回 401' }],
      },
      droppedScopeEntries: ['../outside/evil.ts', 'D:/absolute/evil.ts'],
    },
    waiting: false,
    waitingKind: null,
  })
  const tree = (await render(FlowDetail, {})).toJSON()
  const text = flat(tree)
  await check('S1 批准前展示待冻结 scope 的白名单', () => {
    assert.ok(text.includes('待冻结 scope'))
    assert.ok(text.includes('src/auth/session.ts'))
    assert.ok(text.includes('src/auth/store.ts'))
    assert.ok(text.includes('会话过期检测'))
  })
  await check('S1 展示被剔除的越界条目', () => {
    assert.ok(text.includes('已剔除的越界条目'))
    assert.ok(text.includes('../outside/evil.ts'))
    assert.ok(text.includes('D:/absolute/evil.ts'))
  })
  // 影响面同样要盲签前可见：评审据它判定发现是否属于本次范围。
  await check('S1 批准前展示本次会动的共用契约', () => {
    assert.ok(text.includes('本次会动的共用契约与已知约束'))
    assert.ok(text.includes('checkExpiry(session, now) 的签名与返回值保持不变'))
  })
  // 命令清单也是用户批准的东西，批准前必须能逐条看到。
  await check('S1 批准前展示将直接放行的命令清单', () => {
    assert.ok(text.includes('允许直接执行的命令'))
    assert.ok(text.includes('npm test'))
    assert.ok(text.includes('npm run *'))
    assert.ok(text.includes('没有别的开关'))
    assert.ok(text.includes('退回 S1'))
  })
  // AC-9：带目录后缀的条目要把「在哪个目录跑」一起显示。只显示命令原文，
  // 用户会以为它和别的条目一样在流程根执行——那正是这次要修的歧义。
  await check('AC-9 命令清单里带目录的条目补一句执行目录', () => {
    assert.ok(text.includes('npm run build [packages/web]'))
    assert.ok(text.includes('仅限 packages/web 目录内执行'))
    // 不带后缀的条目只说流程根，不能被误读成「任意目录都行」。
    assert.ok(text.includes('方括号后缀是执行目录'))
    assert.ok(text.includes('没有后缀的条目只认流程根目录'))
  })
}

// P2：AC 声明集成验收、验证步骤点名 scope 外的夹具时，批准前必须摊开缺口并明确接受。
// 只点一下「批准」就签掉它，等于等到 S4 才发现方法对不上证据。
{
  posted = []
  currentView = baseView('S1', {
    doc: {
      html: '<html><body>需求文档</body></html>',
      pending: true,
      pendingScope: {
        files_expected_to_change: ['test/host.test.mjs'],
        commands: ['node test/host.test.mjs'],
        capabilities: ['补集成测试'],
        out_of_scope_explicitly: [],
        acceptance_criteria: [{
          id: 'AC-1', when: '跨模块联动', then: '夹具一起跑通',
          method: 'integration', procedure: '先改 test/fixtures/session.ts',
        }],
      },
      droppedScopeEntries: [],
      pendingScopeRisks: [{
        code: 'procedure-file-outside-scope',
        acs: ['AC-1'],
        message: '这些验收标准的验证步骤点名了 scope 之外的文件：AC-1 → test/fixtures/session.ts。开发阶段改不了它们，评审也会把相关发现判成范围外。',
      }],
    },
    waiting: false,
    waitingKind: null,
  })
  const renderer = await render(FlowDetail, {})
  const tree = renderer.toJSON()
  await check('S1 批准前展示验收方案缺口', () => {
    const text = flat(tree)
    assert.ok(text.includes('验收方案缺口（批准前需确认）'), text)
    assert.ok(text.includes('test/fixtures/session.ts'))
    assert.ok(text.includes('批准并冻结 scope（需确认缺口）'))
    assert.ok(text.includes('跳过评审，直接开发（需确认缺口）'))
  })
  await check('点批准先展开缺口确认区，不直接投递', async () => {
    await click(buttonByText(renderer.toJSON(), '批准并冻结 scope（需确认缺口）'))
    assert.equal(posted.length, 0, JSON.stringify(posted))
    const confirm = nodeByLabel(renderer.toJSON(), '验收方案缺口确认')
    const confirmText = flat(confirm)
    assert.ok(confirmText.includes('这份 scope 有 1 条验收方案缺口'), confirmText)
    assert.ok(confirmText.includes('AC-1'))
    assert.ok(confirmText.includes('test/fixtures/session.ts'))
    assert.ok(confirmText.includes('缺口不会被当成通过'))
  })
  await check('确认区不再要用户写接受原因，确认按钮直接可用', () => {
    const confirm = nodeByLabel(renderer.toJSON(), '验收方案缺口确认')
    const confirmButton = buttons(confirm).find((node) => flat(node).includes('确认接受缺口并冻结 scope'))
    assert.ok(confirmButton, '缺少确认按钮')
    assert.equal(confirmButton.props.disabled, false, '接受靠动作本身，不靠一段说明')
    assert.equal(findTags(confirm, 'textarea').length, 0, '确认区不应再有必填说明输入框')
    assert.ok(!flat(confirm).includes('接受原因'), '缺口清单与计数才是事后能核的东西')
  })
  await check('点确认提交 acceptScopeRisks，不附带说明', async () => {
    const confirm = nodeByLabel(renderer.toJSON(), '验收方案缺口确认')
    const confirmButton = buttons(confirm).find((node) => flat(node).includes('确认接受缺口并冻结 scope'))
    await click(confirmButton)
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'doc')
    assert.equal(last.payload.decision, 'approve')
    assert.equal(last.payload.acceptScopeRisks, true)
    assert.equal(last.payload.scopeRiskNote, undefined)
  })
  await check('取消确认区后回到普通批准入口，缺口仍然摆着', async () => {
    const confirm = nodeByLabel(renderer.toJSON(), '验收方案缺口确认')
    await click(buttons(confirm).find((node) => flat(node).includes('取消')))
    assert.equal(nodeByLabel(renderer.toJSON(), '验收方案缺口确认'), null)
    assert.ok(flat(renderer.toJSON()).includes('验收方案缺口（批准前需确认）'))
  })
}

// 宿主拒绝批准时会把重算出的缺口写回状态：界面必须补拉一次，
// 否则用户反复点「批准」只看到红字，那个确认按钮永远不出现。
{
  posted = []
  const pendingScope = {
    files_expected_to_change: ['test/host.test.mjs'],
    commands: ['node test/host.test.mjs'],
    capabilities: ['补集成测试'],
    out_of_scope_explicitly: [],
    acceptance_criteria: [{
      id: 'AC-1', when: '跨模块联动', then: '夹具一起跑通',
      method: 'integration', procedure: '先改 test/fixtures/session.ts',
    }],
  }
  const staleDoc = {
    html: '<html><body>需求文档</body></html>',
    pending: true,
    pendingScope,
    droppedScopeEntries: [],
    pendingScopeRisks: [],
  }
  const freshDoc = {
    ...staleDoc,
    pendingScopeRisks: [{
      code: 'procedure-file-outside-scope',
      acs: ['AC-1'],
      message: '这些验收标准的验证步骤点名了 scope 之外的文件：AC-1 → test/fixtures/session.ts。开发阶段改不了它们，评审也会把相关发现判成范围外。',
    }],
  }
  currentView = baseView('S1', { doc: staleDoc, waiting: false, waitingKind: null })
  const renderer = await render(FlowDetail, {})
  const originalFetch = globalThis.fetch
  let stateCalls = 0
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/action')) {
      posted.push(JSON.parse(init.body))
      return response({ error: '这份 scope 有 1 条验收方案缺口，不能直接冻结：…或在确认区明确接受这些缺口后重试（acceptScopeRisks: true）。' }, 409)
    }
    if (target.includes('/state')) {
      stateCalls += 1
      currentView = baseView('S1', { doc: freshDoc, waiting: false, waitingKind: null })
      return response(currentView)
    }
    return originalFetch(url, init)
  }
  try {
    await check('被拒之后自动补拉状态，按钮改口提示要确认缺口', async () => {
      await click(buttonByText(renderer.toJSON(), '批准并冻结 scope'))
      await settle()
      assert.equal(posted.length, 1)
      assert.ok(stateCalls >= 1, '宿主拒绝后没有补拉状态：界面还拿着旧的空缺口清单')
      assert.ok(hasButton(renderer.toJSON(), '批准并冻结 scope（需确认缺口）'))
    })
    await check('补拉之后点一次就能展开确认区', async () => {
      await click(buttonByText(renderer.toJSON(), '批准并冻结 scope（需确认缺口）'))
      const confirm = nodeByLabel(renderer.toJSON(), '验收方案缺口确认')
      assert.ok(confirm, '补拉之后仍然没有确认区')
      assert.ok(flat(confirm).includes('test/fixtures/session.ts'))
      assert.equal(posted.length, 1, '展开确认区不该再发请求')
    })
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => { renderer.unmount() })
  }
}

// 冻结后缺口要一直可见：结束之后也要能追溯当时接受了什么。用户自己补的原因有就显示，没有不占位。
{
  currentView = baseView('S2', {
    scope: {
      frozen: true,
      frozenAt: '2026-11-17T10:00:00Z',
      withoutDocApproval: false,
      data: {
        version: 1,
        frozen_at: '2026-11-17T10:00:00Z',
        in_scope: {
          files_expected_to_change: ['test/host.test.mjs'],
          commands: ['node test/host.test.mjs'],
          capabilities: ['补集成测试'],
          shared_contracts: [],
        },
        out_of_scope_explicitly: [],
        acceptance_criteria: [{ id: 'AC-1', when: '跨模块联动', then: '夹具一起跑通' }],
        scope_risks: {
          accepted: true,
          note: '夹具下一轮补，本轮先用主机测试兜底',
          at: '2026-11-17T10:00:00Z',
          risks: [{ code: 'procedure-file-outside-scope', acs: ['AC-1'], message: '验证步骤点名了 scope 之外的文件：test/fixtures/session.ts' }],
        },
      },
    },
    waiting: false,
    waitingKind: null,
  })
  const tree = (await render(FlowDetail, {})).toJSON()
  await check('冻结后展示用户已接受的验收方案缺口', () => {
    const text = flat(tree)
    assert.ok(text.includes('验收方案缺口（用户已接受）'), text)
    assert.ok(text.includes('test/fixtures/session.ts'))
    // 用户主动补过原因时才展示，措辞也要说清这是补充说明，不是接受的前提。
    assert.ok(text.includes('用户补充的接受原因：夹具下一轮补，本轮先用主机测试兜底'))
    assert.ok(text.includes('unit 证据也顶不了 integration'))
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

  // 影响面要和文件白名单一起摆出来：评审据它判断发现是否属于本次范围，用户批准 scope 时也批准了这部分。
  await check('S2 显示本次会动的共用契约与已知约束', () => {
    assert.ok(text.includes('本次会动的共用契约与已知约束'))
    assert.ok(text.includes('checkExpiry(session, now) 签名保持不变'))
    assert.ok(!text.includes('未声明影响面'))
  })

  // 没列命令时不能静默留白：用户要能预判「待会儿还得勾授权」。
  await check('scope 没有命令清单时说明仍要授权', () => {
    assert.ok(text.includes('未列出可执行命令'))
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

// 命令放行没有开关：唯一通道是 S1 批准过的 scope 清单，清单内的命令在 S2 / S4 直接执行。
{
  posted = []
  currentView = baseView('S2', {
    devChanges: { files: ['src/auth/session.ts'], added: 42, removed: 7, at: '2026-11-17T09:40:00Z' },
    waiting: true,
    waitingKind: 'gate',
  })
  const renderer = await render(FlowDetail, {})
  const tree = renderer.toJSON()
  await check('S2 不再提供命令授权勾选框，只说明清单放行', () => {
    const all = flat(tree)
    assert.ok(all.includes('不需要在这里勾选任何开关'), '要说清不用勾选')
    assert.equal(all.includes('允许执行构建/测试命令'), false, '命令授权开关必须退场')
    assert.equal(checkboxNodes(tree).length, 0, 'S2 开发卡不该再有任何授权勾选框')
    assert.ok(all.includes('scope 清单里没有命令'), '没有清单时要说明只能跑只读命令')
  })
}

// S4 要跑测试命令：入口必须和测试阶段同屏，且只列清单、不给开关。
{
  posted = []
  currentView = baseView('S4', {
    scope: {
      frozen: true,
      frozenAt: '2026-11-17T10:00:00Z',
      withoutDocApproval: false,
      data: {
        version: 1,
        frozen_at: '2026-11-17T10:00:00Z',
        in_scope: {
          files_expected_to_change: ['src/auth/session.ts'],
          commands: ['npm test', 'npm run *'],
          capabilities: ['会话过期检测'],
        },
      },
    },
  })
  const tree = (await render(FlowDetail, {})).toJSON()
  await check('S4 命令入口只列 scope 清单，不给勾选', () => {
    const all = flat(tree)
    assert.ok(all.includes('npm test'), '清单要原样列出')
    assert.ok(all.includes('npm run *'))
    assert.ok(all.includes('不需要在这里勾选任何开关'))
    assert.equal(all.includes('允许执行构建/测试命令'), false)
    assert.equal(checkboxNodes(tree).length, 0, 'S4 也不该再有授权勾选框')
  })
}

// 清单写漏时的唯一出口：被拒的命令进待补队列，补与不补只能在门禁上二选一。
{
  posted = []
  currentView = baseView('S4', {
    pendingCommands: [{ command: 'npm run build', stage: 'S4', at: '2026-11-17T10:05:00Z' }],
  })
  const renderer = await render(FlowDetail, {})
  const tree = renderer.toJSON()
  await check('被拒命令在门禁上给出补 / 不补二选一', async () => {
    const all = flat(tree)
    assert.ok(all.includes('npm run build'), '要显示被拒的那条命令')
    assert.ok(all.includes('不在冻结 scope 清单里'))
    assert.ok(all.includes('本轮评审与测试需要重跑'), '要说清补的代价')
    assert.ok(all.includes('这些命令之后仍然会被拒'), '要说清不补的后果')
    await click(buttonByText(tree, '补进清单并重新批准'))
    const call = posted.find((item) => item.action === 'reopenScopeForCommands')
    assert.ok(call, '必须提交 reopenScopeForCommands')
    // 只提交勾选的那几条：整份清单是 S1 的事，这里只补被拒的。
    assert.deepEqual(call.payload.commands, ['npm run build'])
  })
}

// 「不补」要把缺口记进结项账本，点一下就落定太轻：先二次确认。
{
  posted = []
  currentView = baseView('S4', {
    pendingCommands: [{ command: 'npm run build', stage: 'S4', at: '2026-11-17T10:05:00Z' }],
  })
  const renderer = await render(FlowDetail, {})
  await check('点「不补」先要确认，确认后才提交 declineScopeCommands', async () => {
    await click(buttonByText(renderer.toJSON(), '不补，继续'))
    assert.equal(posted.length, 0, '第一次点击不该直接提交')
    const confirmTree = renderer.toJSON()
    assert.ok(flat(confirmTree).includes('依赖它们的验收标准会记成未覆盖'), '要预告结项后果')
    await click(buttonByText(confirmTree, '确认不补'))
    const call = posted.find((item) => item.action === 'declineScopeCommands')
    assert.ok(call, '必须提交 declineScopeCommands')
    assert.deepEqual(call.payload.commands, ['npm run build'])
  })
}

// 勾选可以去掉某一条：补清单不该变成「要么全补要么全不补」。
{
  posted = []
  currentView = baseView('S2', {
    pendingCommands: [
      { command: 'npm run build', stage: 'S2', at: '2026-11-17T10:05:00Z' },
      { command: 'git checkout -- src/api/middleware.ts', stage: 'S2', at: '2026-11-17T10:06:00Z' },
    ],
  })
  const renderer = await render(FlowDetail, {})
  const tree = renderer.toJSON()
  await check('取消勾选后只补剩下的那条，按钮文案跟着变', async () => {
    const boxes = checkboxNodes(tree)
    assert.equal(boxes.length, 2, '每条待补命令一个勾选框')
    assert.equal(boxes[0].props.checked, true, '默认全选')
    await changeValue(boxes[0], false)
    const nextTree = renderer.toJSON()
    await click(buttonByText(nextTree, '补进清单（1 条）并重新批准'))
    const call = posted.find((item) => item.action === 'reopenScopeForCommands')
    assert.ok(call, '必须提交 reopenScopeForCommands')
    assert.deepEqual(call.payload.commands, ['git checkout -- src/api/middleware.ts'])
  })
}

{
  posted = []
  currentView = baseView('S2', {
    pendingCommands: [
      { command: 'npm run build', dir: '.', stage: 'S2', selectionKey: 'root', canSupplement: true },
      { command: 'npm run build', dir: 'packages/web', stage: 'S2', selectionKey: 'web', canSupplement: true },
      { command: 'npm run build', dir: 'packages/missing', stage: 'S2', selectionKey: 'missing',
        canSupplement: false, directoryError: '无法确认执行目录' },
    ],
  })
  const renderer = await render(FlowDetail, {})
  await check('待补命令按目录单独勾选，无法补录的目录只显示原因', async () => {
    const tree = renderer.toJSON()
    assert.ok(flat(tree).includes('npm run build [packages/web]'))
    assert.ok(flat(tree).includes('无法补录。无法确认执行目录'))
    await changeValue(checkboxNodes(tree)[0], false)
    await click(buttonByText(renderer.toJSON(), '补进清单（1 条）并重新批准'))
    const call = posted.find((item) => item.action === 'reopenScopeForCommands')
    assert.deepEqual(call?.payload.commands, ['web'])
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
  await check('门禁中断后按钮仍然可点，并说明 Agent 已经停下', async () => {
    assert.ok(flat(tree).includes('上次的门禁请求被中断'))
    // 按钮可点是为了不剥夺用户确认的权利；文案必须说清 Agent 已经停了，不是还在后台干活。
    assert.ok(flat(tree).includes('Agent 已停下等你确认'), flat(tree))
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
      id: 'review-interrupted',
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
    assert.equal(hasButton(tree, '通过评审，进入测试'), false)
    assert.equal(hasButton(tree, '跳过评审，直接测试'), false)
    assert.equal(buttonByText(tree, '带风险进入测试').props.disabled, false)
    assert.equal(findTags(tree, 'textarea').filter((node) => node.props['aria-label'] === '接受风险原因（必填）').length, 0)
    await click(buttonByText(tree, '带风险进入测试'))
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'gate')
    assert.equal(last.payload.decision, 'accept-risk')
    assert.equal(last.payload.riskReason, undefined)
    assert.equal(last.payload.reviewId, 'review-interrupted')
    currentView = { ...currentView, review: { ...currentView.review, id: 'review-interrupted-new' } }
    await click(buttonByText(renderer.toJSON(), '刷新'))
    const replaced = renderer.toJSON()
    assert.equal(buttonByText(replaced, '带风险进入测试').props.disabled, false)
    await click(buttonByText(replaced, '带风险进入测试'))
    assert.equal(posted.at(-1).payload.riskReason, undefined)
    assert.equal(posted.at(-1).payload.reviewId, 'review-interrupted-new')
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
    await click(buttonByText(tree, '结束流程'))
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'gate')
    assert.equal(last.payload.decision, 'pass')
  })
}

// G40：等待器随进程一起没了，来路要分别说清，不能一律说「被中断了」。
{
  posted = []
  currentView = baseView('S2', {
    devChanges: { files: ['src/auth/session.ts'], added: 42, removed: 7, at: '2026-11-17T09:40:00Z' },
    gate: {
      pending: true,
      interrupted: true,
      request: { id: 'gate_ab12cd34', kind: 'gate', at: '2026-11-26T09:00:00Z', endedAt: null, endKind: null },
      recovered: { gateId: 'gate_ab12cd34', kind: 'gate', stage: 'S2', at: '2026-11-26T09:05:00Z' },
      waitReason: 'restart',
    },
    gateWait: { minutes: 10, min: 1, max: 60, fallback: 10, file: '.dsh-flowgate/config.json' },
    waiting: false,
    waitingKind: null,
  })
  const renderer = await render(FlowDetail, {})
  const tree = renderer.toJSON()
  await check('门禁等待器随进程没了：重启过要说明来源，不退回旧文案', async () => {
    const text = flat(tree)
    assert.ok(text.includes('宿主重启过：门禁仍在等待'), text)
    assert.ok(text.includes('gate_ab12cd34'), '要点名门禁 id：' + text)
    assert.ok(text.includes('不会叫醒 Agent'), '必须说清点按钮叫不醒 Agent：' + text)
    assert.equal(text.includes('上次的门禁请求被中断'), false, '知道来路时不该退回旧文案')
    await click(buttonByText(tree, '完成开发'))
    assert.equal(posted.at(-1).action, 'gate')
    assert.equal(posted.at(-1).payload.decision, 'pass')
  })
}

{
  for (const [reason, want] of [
    ['timeout', '等满上限'],
    ['superseded', '已被取代'],
    ['aborted', '被取消了'],
  ]) {
    posted = []
    currentView = baseView('S2', {
      devChanges: { files: ['src/auth/session.ts'], added: 42, removed: 7, at: '2026-11-17T09:40:00Z' },
      gate: {
        pending: true,
        interrupted: true,
        request: { id: 'gate_ff00aa11', kind: 'gate', at: '2026-11-26T09:00:00Z', endedAt: '2026-11-26T09:10:00Z', endKind: reason },
        recovered: null,
        waitReason: reason,
      },
      gateWait: { minutes: 10, min: 1, max: 60, fallback: 10, file: '.dsh-flowgate/config.json' },
      waiting: false,
      waitingKind: null,
    })
    const tree = (await render(FlowDetail, {})).toJSON()
    await check('门禁等待中断：' + reason + ' 有自己的文案', () => {
      const text = flat(tree)
      assert.ok(text.includes(want), reason + ' 应说明来路：' + text)
      assert.ok(text.includes('gate_ff00aa11'), '要点名门禁 id：' + text)
      assert.equal(text.includes('上次的门禁请求被中断'), false, reason + ' 知道来路时不该退回旧文案')
    })
  }
}

// 等待器没了、门禁还开着：提示条不能再说「等待 Agent 下一步」，否则用户会一直等下去。
await check('阶段提示：等待器中断而门禁仍开着时如实说明', async () => {
  currentView = baseView('S2', {
    gate: { pending: true, interrupted: true, waitReason: 'timeout' },
    waiting: false,
    waitingKind: null,
  })
  const text = flat((await render(stageHint, {})).toJSON())
  assert.ok(text.includes('门禁仍在等待，但等待器已中断'), text)
  assert.equal(text.includes('等待 Agent 下一步'), false, '不能表现成还在干活')
})

// 追问卡片：Agent 已经不在了，卡片仍然有效，点选要落盘并叫醒它。
await check('追问卡片：等待器超时后仍可点选，并说明会叫醒 Agent', async () => {
  const base = grillView()
  currentView = grillView({ grill: { ...base.grill, awaiting: false } })
  const text = flat((await render(FlowDetail, {})).toJSON())
  assert.ok(text.includes('Agent 已经不在等了'), text)
  assert.ok(text.includes('叫醒'), '要说清点选会叫醒它：' + text)
})

// 门禁等待上限放在工作台里配：0 不接受，越界由服务端纠正。
{
  posted = []
  currentView = baseView('S2', { gateWait: { minutes: 10, min: 1, max: 60, fallback: 10, file: '.dsh-flowgate/config.json' } })
  const renderer = await render(FlowDetail, {})
  await check('门禁等待上限可在设置面板里改', async () => {
    await openSettings(renderer)
    const tree = await switchGroup(renderer, '门禁等待')
    const text = flat(tree)
    assert.ok(text.includes('门禁等待上限'), text)
    assert.ok(text.includes('不能设成 0'), '必须说清 0 不接受：' + text)
    const input = findTags(tree, 'input').find((node) => node.props.type === 'number')
    assert.ok(input, '要有分钟输入框：' + text)
    assert.equal(input.props.min, 1)
    assert.equal(input.props.max, 60)
    await changeValue(input, '25')
    await click(buttonByText(renderer.toJSON(), '保存上限'))
    await settle()
    assert.equal(posted.at(-1).action, 'setGateWaitMinutes')
    assert.equal(posted.at(-1).payload.minutes, 25)
    await click(buttonByText(renderer.toJSON(), '恢复默认'))
    await settle()
    assert.equal(posted.at(-1).payload.minutes, 10)
    await click(buttonByText(renderer.toJSON(), '关闭'))
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
      advisories: 2,
      by: 'subagents',
      at: '2026-11-17T10:10:00Z',
      angles: [
        {
          id: 'correctness',
          name: '正确性',
          verdict: 'blocking',
          suggestUpgrade: false,
          findings: [
            { file: 'src/auth/session.ts', line: 88, severity: 'CRITICAL', summary: '过期判断用了客户端时间', ac: 'AC-1', acMatched: true },
            { file: 'src/auth/session.ts', line: 92, severity: 'MAJOR', summary: '并发刷新没有去重', acMatched: false },
            { file: 'src/config/secrets.ts', line: 3, severity: 'MAJOR', summary: '密钥写死在配置里', ac: 'AC-9', acMatched: true, fileInScope: false },
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

  // 归属口径：挂不上验收标准、或落在 scope 文件之外的发现只作提示，不进重做清单。
  await check('S3 标出发现的验收标准归属与仅提示条数', () => {
    assert.ok(text.includes('2 条仅提示'))
    assert.ok(text.includes('只有已核实、严重度为 CRITICAL/MAJOR、挂得上冻结 scope 验收标准'))
    assert.ok(text.includes('AC-9'))
    assert.ok(text.includes('未归属验收标准'))
    assert.ok(text.includes('scope 外文件'))
  })

  await check('S3 有阻塞项时仅提供带风险进入测试与退回', () => {
    assert.equal(hasButton(tree, '通过评审，进入测试'), false)
    assert.ok(buttonByText(tree, '带风险进入测试'))
    assert.ok(buttonByText(tree, '退回开发修复'))
    assert.equal(hasButton(tree, '跳过评审，直接测试'), false)
    assert.ok(flat(tree).includes('更多操作'))
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

await check('S3 证据字符串、未核实原因、结论冲突与丢弃项均可见', async () => {
  currentView = baseView('S3', { review: { blocking: 0, advisories: 2,
    counts: { total: 2, critical: 0, major: 1, minor: 1, blocking: 0, advisories: 2, unscoped: 0, unverified: 1, unverifiedSevere: 1 },
    angles: [{ id: 'correctness', name: '正确性', verdict: 'advisory',
      verdictConflict: { declared: 'blocking', derived: 'advisory' },
      findings: [{ file: 'src/app.js', line: 1, kind: 'defect', severity: 'MAJOR', summary: '异常分支', evidence: 'value',
        repro: { when: '传入空值', expected: '拒绝', actual: '通过' }, unverified: true,
        unverifiedReason: 'evidence 标识符 value 不在 src/app.js 中' },
        { file: 'src/app.js', kind: 'design', severity: 'MINOR', summary: '界面约定冲突', evidence: 'render',
          basis: { quote: 'function render() {', conflict: 'AC-2 的设计约定' } }],
      rejectedFindings: [{ index: 0, severity: 'MAJOR', missing: ['repro.when'] }, { index: 2, severity: 'MAJOR', missing: ['counter.attempt'] }] }] } })
  const tree = (await render(FlowDetail, {})).toJSON()
  const text = flat(tree)
  for (const label of ['未核实', '未核实原因：', '位置证据：value', '复现：', '期望 拒绝', '实际 通过',
    '声称 有阻塞项', '未核实 1（其中 CRITICAL/MAJOR 1）', '第 1 条', '第 3 条', 'counter.attempt', '设计依据：', '已核实、严重度为 CRITICAL/MAJOR']) {
    assert.ok(text.includes(label), label)
  }
  assert.ok(findTags(tree, 'details').some((node) => node.props.className.includes('fg-finding-basis')))
})

await check('快捷评审报告单列因缺少证据被丢弃的条目', async () => {
  currentView = baseView('S3', { waiting: true, waitingKind: 'gate', review: { blocking: 0, advisories: 0,
    angles: [{ id: 'correctness', name: '正确性', verdict: 'advisory', findings: [],
      rejectedFindings: [{ index: 0, severity: 'MAJOR', missing: ['counter.attempt'] }] }] } })
  const renderer = await render(stageHint, {})
  await click(buttonByText(renderer.toJSON(), '评审报告'))
  const text = flat(quickDialog(renderer))
  for (const value of ['因缺少证据被丢弃 · 1', '正确性 · 第 1 条', 'counter.attempt', '仍会拦住普通通过']) assert.ok(text.includes(value), value + ' 未出现：' + text)
  await click(buttonByText(quickDialog(renderer), '关闭'))
  assert.equal(quickDialog(renderer), null)
})

await check('S3 老快照缺证据计数也不渲染 undefined', async () => {
  currentView = baseView('S3', { review: { blocking: 0, counts: { total: 0, critical: 0, major: 0, minor: 0, blocking: 0, advisories: 0 },
    angles: [{ id: 'correctness', name: '正确性', verdict: 'pass', findings: [] }] } })
  const text = flat((await render(FlowDetail, {})).toJSON())
  assert.ok(!text.includes('undefined'))
})

await check('快捷操作在阻塞评审时可直接带风险进入测试', async () => {
  posted = []
  currentView = baseView('S3', { waiting: true, waitingKind: 'gate', review: { id: 'review-dock', blocking: 2, angles: [] } })
  const renderer = await render(stageHint, { sessionId: 'risk-dock-reload' }, false)
  const detail = await render(FlowDetail, { sessionId: 'risk-dock-reload' }, false)
  let tree = renderer.toJSON()
  assert.equal(hasButton(tree, '通过评审，进入测试'), false)
  assert.equal(hasButton(tree, '跳过评审，直接测试'), false)
  assert.equal(buttonByText(tree, '带风险进入测试').props.disabled, false)
  assert.ok(buttonByText(tree, '回到需求分析调整 scope'))
  assert.ok(flat(tree).includes('更多操作'))
  assert.equal(findTags(tree, 'input').filter((node) => node.props['aria-label'] === '接受风险原因（必填）').length, 0)
  await click(buttonByText(tree, '带风险进入测试'))
  assert.equal(posted.at(-1).payload.decision, 'accept-risk')
  assert.equal(posted.at(-1).payload.riskReason, undefined)
  assert.equal(posted.at(-1).payload.reviewId, 'review-dock')
  currentView = { ...currentView, review: { ...currentView.review, id: 'review-dock-new' } }
  await click(buttonByText(detail.toJSON(), '刷新'))
  tree = renderer.toJSON()
  assert.equal(buttonByText(tree, '带风险进入测试').props.disabled, false)
  await click(buttonByText(tree, '带风险进入测试'))
  assert.equal(posted.at(-1).payload.riskReason, undefined)
  assert.equal(posted.at(-1).payload.reviewId, 'review-dock-new')
})

await check('接受风险阶段标识与接受原因不同于评审通过或跳过', async () => {
  const stages = stagesFor('S4')
  stages[2] = { ...stages[2], status: 'accepted_with_risk', riskAcceptance: { reason: '接受剩余并发风险' } }
  currentView = baseView('S4', { stages })
  const tree = (await render(FlowDetail, {})).toJSON()
  assert.match(flat(tree), /带风险继续/)
  assert.match(flat(tree), /接受原因：接受剩余并发风险/)
  const css = styleNodes[0].textContent
  const hidden = css.indexOf('.fg-hub-flow .fg-stage-out, .fg-hub-flow .fg-stage-status { display: none; }')
  const visible = css.indexOf('.fg-hub-flow .fg-stage.accepted_with_risk .fg-stage-status { display: block;')
  assert.ok(hidden >= 0 && visible > hidden, '侧栏风险阶段徽标须覆盖通用隐藏规则')
})

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

  await check('S4 门禁给出明确例外验收 / 退回，跳过不再是免检通道', () => {
    assert.ok(buttonByText(tree, '结束流程（需确认）'))
    assert.ok(buttonByText(tree, '退回开发修复'))
    assert.equal(hasButton(tree, '跳过测试门禁'), false, '有缺口时跳过和结束流程等价，留着只会点出错')
  })

  await check('S4 点例外按钮先展开缺口清单，不直接投递', async () => {
    assert.equal(posted.length, 0)
    await click(buttonByText(renderer.toJSON(), '结束流程（需确认）'))
    assert.equal(posted.length, 0, '第一次点击只展开缺口，不发请求')
    const panel = renderer.toJSON()
    assert.match(flat(panel), /这些项目不会被标记为通过/)
    // 缺口要逐条列出来：只有数字，用户没法判断自己接受的是什么。
    assert.match(flat(panel), /未通过的测试要点（2 个）/)
    assert.match(flat(panel), /冒烟验证 · 过期后返回 401（失败）/)
    assert.match(flat(panel), /回归影响 · 旧用例不退化（未覆盖）/)
    const confirmBtn = buttonByText(panel, '确认结束流程')
    assert.equal(confirmBtn.props.disabled, false, '看完清单点确认就能结束，不再要用户打字')
    // 退回修复的说明框还在，这里只断言不再有「接受原因」这种必填项。
    assert.equal(findTags(panel, 'textarea').filter((node) => String(node.props['aria-label'] ?? '').includes('接受原因')).length, 0, '缺口确认区不应再有必填说明输入框')
  })

  await check('S4 确认缺口后提交带缺口结项，不附带说明', async () => {
    await click(buttonByText(renderer.toJSON(), '确认结束流程'))
    const last = posted[posted.length - 1]
    assert.equal(last.action, 'gate')
    assert.equal(last.payload.decision, 'pass')
    assert.equal(last.payload.acceptUncovered, true)
    assert.equal(last.payload.acceptanceNote, undefined)
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
  })

  await check('零个可聚焦项时Tab与Shift+Tab留在dialog且阻止默认跳出', () => {
    const dialog = nodeByRole(renderer.toJSON(), 'dialog')
    const disabled = { disabled: true, focus() { assert.fail('不能聚焦已禁用控件') } }
    const card = { focused: 0, querySelectorAll: () => [disabled], focus() { this.focused += 1 } }
    let prevented = 0
    for (const shiftKey of [false, true]) {
      dialog.props.onKeyDown({ key: 'Tab', target: card, currentTarget: card, shiftKey, preventDefault() { prevented += 1 } })
    }
    assert.equal(prevented, 2)
    assert.equal(card.focused, 2, '两个方向都将焦点保留在dialog自身')
  })

  await check('唯一可聚焦项时正反Tab均回到唯一项，从dialog出发同样受约束', () => {
    const dialog = nodeByRole(renderer.toJSON(), 'dialog')
    const disabled = { disabled: true, focus() { assert.fail('不能聚焦已禁用控件') } }
    const only = { focused: 0, focus() { this.focused += 1 } }
    const card = { querySelectorAll: () => [disabled, only], focus() { assert.fail('有可用项时应聚焦该项') } }
    let prevented = 0
    for (const target of [only, card]) for (const shiftKey of [false, true]) {
      dialog.props.onKeyDown({ key: 'Tab', target, currentTarget: card, shiftKey, preventDefault() { prevented += 1 } })
    }
    assert.equal(prevented, 4)
    assert.equal(only.focused, 4)
  })

  await check('窄屏下弹窗分组导航改横向、卡片占满高度', () => {
    const css = styleNodes[0].textContent
    const at = css.indexOf('@media (max-width: 720px)')
    assert.ok(at >= 0, '弹窗应按视口宽度响应，而非宿主侧栏宽度')
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

await check('点「修改需求」后回到追问流程并说明下一步', async () => {
  currentView = baseView('S1', { doc: { html: null, revisedAt: '2026-11-17T10:00:00Z' } })
  const tree = await render(FlowDetail, {})
  const text = flat(tree.toJSON())
  assert.ok(text.includes('你点了「修改需求」'))
})

await check('点「修改需求」先展开意见输入框，不直接提交', async () => {
  currentView = baseView('S1', { doc: { html: '<p>需求</p>', pending: true } })
  posted = []
  const renderer = await render(FlowDetail, {})
  try {
    assert.equal(posted.length, 0)
    await click(buttonByText(renderer.toJSON(), '修改需求'))
    assert.equal(posted.length, 0, '点开输入框不能直接提交')
    const area = fieldByAria(renderer.toJSON(), '修改意见')
    assert.ok(area, '必须出现修改意见输入框')
    assert.equal(area.props.rows, 3)
    assert.equal(area.props.maxLength, 2000, '输入框要按宿主的 2000 字上限收口')
    assert.ok(flat(renderer.toJSON()).includes('要改哪里？'))
    assert.equal(buttonByText(renderer.toJSON(), '修改需求').props['aria-expanded'], true)
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('修改意见为空时不提交，填写后原样交给宿主', async () => {
  currentView = baseView('S1', { doc: { html: '<p>需求</p>', pending: true } })
  posted = []
  const renderer = await render(FlowDetail, {})
  try {
    await click(buttonByText(renderer.toJSON(), '修改需求'))
    await click(buttonByText(renderer.toJSON(), '提交修改意见'))
    assert.equal(posted.length, 0, '空意见不能提交')
    assert.ok(flat(renderer.toJSON()).includes('请先写清楚要改什么'))
    const note = '  把 AC-2 的测量方式写清楚，并补上失败分支  '
    await changeValue(fieldByAria(renderer.toJSON(), '修改意见'), note)
    await click(buttonByText(renderer.toJSON(), '提交修改意见'))
    const call = posted.find((item) => item.action === 'doc')
    assert.ok(call, '必须提交 doc 动作')
    assert.deepEqual(call.payload, { decision: 'revise', revisionNote: note.trim() })
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('修改意见超过 2000 字时先拦下来，不提交也不静默截断', async () => {
  currentView = baseView('S1', { doc: { html: '<p>需求</p>', pending: true } })
  posted = []
  const renderer = await render(FlowDetail, {})
  try {
    await click(buttonByText(renderer.toJSON(), '修改需求'))
    await changeValue(fieldByAria(renderer.toJSON(), '修改意见'), '改'.repeat(2001))
    await click(buttonByText(renderer.toJSON(), '提交修改意见'))
    assert.equal(posted.length, 0, '超长意见不能提交')
    assert.ok(flat(renderer.toJSON()).includes('最多 2000 字'), '要明确告诉用户上限')
  } finally { await act(async () => { renderer.unmount() }) }
})

// 写权限不再由用户勾选：测试方向只决定验证什么，能执行什么由 S1 批准的 scope 清单决定。
{
  posted = []
  currentView = baseView('S4', {
    directions: [{ id: 'mig', name: '迁移回滚', points: ['回滚可恢复'] }],
    directionCatalog: [{ id: 'mig', name: '迁移回滚', points: ['回滚可恢复'] }],
  })
  const renderer = await render(FlowDetail, {})
  const modalTree = await openSettings(renderer)
  const text = flat(modalTree)
  await check('测试方向面板不再出现写权限声明与授权', () => {
    assert.equal(text.includes('授权执行变更性命令'), false, '用户不再为方向勾选命令授权')
    assert.equal(text.includes('声明该方向需要写权限'), false, '方向不再有写权限这个概念')
    assert.equal(text.includes('本次流程已声明写权限'), false)
    assert.ok(text.includes('不决定能执行什么'), '要说清能执行什么由 scope 清单决定')
  })
}


{
  // 宿主新增的只读工具（实机是刷新入口）默认被拒，界面上必须有个声明出口，
  // 否则 Agent 只能记一条「未覆盖」，用户也看不出该去哪儿改。
  posted = []
  currentView = baseView('S1', { toolAllowlist: ['unlag_refresh'] })
  const renderer = await render(FlowDetail, {})
  await openSettings(renderer)
  const tree = await switchGroup(renderer, '只读豁免')
  const text = flat(tree)
  await check('只读豁免面板列出已声明工具并说明边界', () => {
    assert.ok(text.includes('额外只读工具'))
    assert.ok(text.includes('写工具、shell 与流程自身的状态工具不能靠这里豁免'))
    const area = nodeByTag(tree, 'textarea')
    assert.ok(area, '必须有输入框')
    assert.equal(area.props.value, 'unlag_refresh')
  })
  await check('保存豁免名单提交 setToolAllowlist 并去掉空行', async () => {
    const area = nodeByTag(tree, 'textarea')
    await act(async () => {
      area.props.onChange({ target: { value: 'unlag_refresh\n\n  ops_extra  ' } })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await click(buttonByText(renderer.toJSON(), '保存豁免名单'))
    await settle()
    const call = posted.find((item) => item.action === 'setToolAllowlist')
    assert.ok(call, '必须提交 setToolAllowlist')
    assert.deepEqual(call.payload.tools, ['unlag_refresh', 'ops_extra'])
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
  await check('即使没有 scope 外发现 S3 也保留回 S1 调整入口', () => {
    assert.ok(buttonByText(renderer.toJSON(), '回到需求分析调整 scope'))
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
  activeCount: 1,
  waitingCount: 1,
  flowCount: 2,
  updatedAt: '2026-11-18T08:00:00Z',
  rules: { configured: true, ids: ['scope-only', 'no-debug-leftovers'], customCount: 1 },
  flows: [
    { id: 'f1', sessionId: 'sess-alpha-1', title: '会话过期检测', brief: '细节…', preset: 'fast', stage: 'S2', stageLabel: '开发', finished: false, cancelled: false, waiting: true, waitingKind: 'gate', skippedCount: 0, percent: 45, createdAt: '…', updatedAt: '…' },
    { id: 'f2', sessionId: 'sess-alpha-2', title: '导出报表', brief: '', preset: 'strict', stage: 'S4', stageLabel: '测试', finished: true, cancelled: false, waiting: false, waitingKind: null, skippedCount: 1, percent: 100, createdAt: '…', updatedAt: '…' },
  ],
}

const idleAlphaMember = {
  ...alphaMember, activeCount: 0, waitingCount: 0,
  flows: alphaMember.flows.map((flow) => ({ ...flow, finished: true, waiting: false, waitingKind: null })),
}

const resetHub = (members = []) => {
  // 页面记忆是跨挂载的状态：每个用例都从「没有记忆」开始，免得互相干扰。
  memoryStore.clear()
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
  prepareHandler = null
  prepareCalls.length = 0
  prepareSignals.length = 0
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
    assert.ok(text.includes('进行中 1 条'))
    assert.ok(text.includes('其中 1 条在等你确认'))
  })
  await check('规则摘要常驻，配置路径仅放在 title 中', () => {
    assert.ok(text.includes('工作区默认 · 2 条'), text)
    assert.ok(!text.includes('.dsh-flowgate/config.json'), '配置路径不应挤占常驻内容')
    const card = nodeByClass(renderer.toJSON(), 'fg-hub-section fg-workspace-card fg-workspace-rules')
    assert.ok(card)
    assert.ok(hasButton(card, '编辑规则'))
    assert.ok(flat(card).includes('S1 · 需求分析'))
    assert.ok(flat(card).includes('S4 · 测试方向'))
    assert.ok(flat(card).includes('内置默认'))
  })
  await check('有当前流程时主区提供继续入口，不展示新建表单，记录默认收起', () => {
    const primary = nodeByClass(renderer.toJSON(), 'fg-workspace-primary')
    assert.ok(flat(primary).includes('会话过期检测'))
    assert.ok(flat(primary).includes('S2 · 开发'))
    assert.ok(hasButton(primary, '继续流程'))
    assert.equal(findTags(renderer.toJSON(), 'textarea').length, 0)
    assert.equal(nodeByClass(renderer.toJSON(), 'fg-workspace-card fg-flow-history').props.open, false)
    const text = flat(renderer.toJSON())
    assert.ok(text.indexOf('继续流程') < text.indexOf('流程记录'))
  })

  await click(buttonByText(renderer.toJSON(), '继续流程'))
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
  // 已有完成记录也直接展开新建表单，启动时才向宿主换取会话。
  resetHub([idleAlphaMember])
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
  resetHub([idleAlphaMember])
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
  await check('工作区尚无流程时新建表单直接位于主区域', () => {
    const primary = nodeByClass(renderer.toJSON(), 'fg-workspace-primary')
    const start = findTags(primary, 'section').find((node) => node.props.className?.includes('fg-start-section'))
    assert.ok(start)
    assert.equal(findTags(start, 'details').length, 0)
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
// 工作台的页面记忆
// ---------------------------------------------------------------------------

{
  // 切到别的会话再点进工作台：面板会重新挂载，不能每次都回到首页。
  resetHub([alphaMember])
  const first = await render(HubPanel, {
    useHubWorkspaces: useWorkspacesOf([]),
    hubActions: hubActionsWith(),
  })
  await click(buttonByText(first.toJSON(), 'alpha'))
  await click(buttonByText(first.toJSON(), '继续流程'))
  assert.ok(flat(first.toJSON()).includes('流程详情'), '前置：详情已展开')
  first.unmount()

  const second = await render(HubPanel, {
    useHubWorkspaces: useWorkspacesOf([]),
    hubActions: hubActionsWith(),
  })
  await check('重进工作台回到上次打开的流程详情', () => {
    const text = flat(second.toJSON())
    assert.ok(text.includes('流程详情'), text)
    assert.ok(text.includes('会话过期检测'), text)
  })
  await click(buttonByText(second.toJSON(), '收起'))
  second.unmount()

  const third = await render(HubPanel, {
    useHubWorkspaces: useWorkspacesOf([]),
    hubActions: hubActionsWith(),
  })
  await check('收起详情后重进停在上次的工作区页', () => {
    const text = flat(third.toJSON())
    assert.ok(!text.includes('添加第一个工作区'), text)
    assert.ok(text.includes('D:/repo/alpha'), text)
    assert.ok(!text.includes('流程详情'), '收起后不该再展开详情')
  })
  await click(buttonByText(third.toJSON(), '工作区列表'))
  third.unmount()

  const fourth = await render(HubPanel, {
    useHubWorkspaces: useWorkspacesOf([]),
    hubActions: hubActionsWith(),
  })
  await check('主动回到工作区列表后记忆也跟着回到首页', () => {
    const text = flat(fourth.toJSON())
    // 名单非空时首页是工作区列表，不是空状态引导。
    assert.ok(text.includes('已添加的工作区'), text)
    assert.ok(!text.includes('工作区列表'), '不该还停在某个工作区页上')
    assert.ok(!text.includes('流程详情'), text)
  })
  fourth.unmount()
}

{
  // 记忆里的工作区已经从名单移除：重进必须回首页，不能停在「目录不可用」。
  resetHub([])
  memoryStore.set('dsh-flowgate.hub.memory.v1', JSON.stringify({ workspace: 'D:/repo/gone', sessionId: null, page: 1 }))
  const renderer = await render(HubPanel, {
    useHubWorkspaces: useWorkspacesOf([]),
    hubActions: hubActionsWith(),
  })
  await check('记忆里的工作区不在名单时回首页', () => {
    const text = flat(renderer.toJSON())
    assert.ok(text.includes('添加第一个工作区'), text)
  })
}

{
  // 存储不可用（隐私模式、被策略禁用）：工作台照常工作，异常不冒到界面。
  resetHub([alphaMember])
  const brokenStore = {
    getItem() { throw new Error('storage disabled') },
    setItem() { throw new Error('storage disabled') },
  }
  const savedWindowStore = globalThis.window.localStorage
  const hasGlobalStore = typeof globalThis.localStorage !== 'undefined'
  const savedGlobalStore = hasGlobalStore ? globalThis.localStorage : null
  if (hasGlobalStore) globalThis.localStorage = brokenStore
  globalThis.window.localStorage = brokenStore
  let text = ''
  try {
    const renderer = await render(HubPanel, {
      useHubWorkspaces: useWorkspacesOf([]),
      hubActions: hubActionsWith(),
    })
    text = flat(renderer.toJSON())
  } finally {
    globalThis.window.localStorage = savedWindowStore
    if (hasGlobalStore) globalThis.localStorage = savedGlobalStore
  }
  await check('存储不可用时工作台照常显示，只是不记忆', () => {
    assert.ok(text.includes('已添加的工作区'), text)
    assert.ok(!text.includes('storage disabled'), '存储异常不能冒到界面上')
  })
}

// ---------------------------------------------------------------------------
// 工作区规则草稿与流程分页
// ---------------------------------------------------------------------------

const emptyMember = (name) => ({
  path: 'D:/repo/' + name, name, missing: false, flowCount: 0, activeCount: 0, waitingCount: 0,
  rules: { configured: false, ids: null, customCount: 0 },
})
const ruleWrites = () => ruleCalls.filter((body) => Object.hasOwn(body, 'stages') || Object.hasOwn(body, 'rules'))
async function openWorkspaceRules(renderer, stage = 'S2') {
  await click(buttonByText(renderer.toJSON(), '编辑规则'))
  await click(buttonByText(nodeByRole(renderer.toJSON(), 'dialog'), stage + ' · ' + stageLabels[stage]))
}
async function switchRuleStage(renderer, stage) {
  await click(buttonByText(ruleDialog(renderer), stage + ' · ' + stageLabels[stage]))
}
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
    await openWorkspaceRules(renderer)
    assert.ok(flat(ruleDialog(renderer)).includes('工作区规则'))
    assert.ok(flat(ruleDialog(renderer)).includes('四阶段改动统一保存'))
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
    await openWorkspaceRules(renderer)
    assert.ok(!flat(ruleDialog(renderer)).includes('仅保留在草稿'), '取消后重开不保留未保存条目')
    assert.equal(ruleCheckbox(ruleDialog(renderer), '只改 scope 内的文件').props.checked, true)
    await addDraftRule(renderer, '关闭也丢弃草稿')
    await click(buttonByText(ruleDialog(renderer), '关闭'))
    await openWorkspaceRules(renderer)
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
    await openWorkspaceRules(renderer)
    await addDraftRule(renderer, '禁止新增依赖', '  逐项核对依赖  \n\n检查锁文件  ')
    await toggleRule(renderer, '只改 scope 内的文件', false)
    ruleHandler = (body) => Object.hasOwn(body, 'stages') ? response({ error: '规则保存失败，请重试' }, 500) : response({ rules: workspaceRules(body.path) })
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    assert.ok(flat(ruleDialog(renderer)).includes('规则保存失败，请重试'))
    assert.ok(flat(ruleDialog(renderer)).includes('禁止新增依赖'))
    assert.equal(buttonByText(ruleDialog(renderer), '保存规则').props.disabled, false)
    const failedPayload = ruleWrites()[0]
    assert.equal(failedPayload.path, 'D:/repo/rules')
    assert.equal(failedPayload.stages.S2.custom.length, 1)
    assert.equal(failedPayload.stages.S2.custom[0].name, '禁止新增依赖')
    assert.deepEqual(failedPayload.stages.S2.custom[0].points, ['逐项核对依赖', '检查锁文件'])
    assert.ok(!failedPayload.stages.S2.ids.includes('scope-only'))
    assert.ok(failedPayload.stages.S2.ids.includes(failedPayload.stages.S2.custom[0].id))
    ruleHandler = null
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    assert.deepEqual(ruleWrites()[1], failedPayload, '重试应保留同一个规则 id 和草稿')
    assert.equal(ruleDialog(renderer), null)
    assert.ok(flat(renderer.toJSON()).includes('工作区默认 · 3 条'), '成功后规则卡片刷新阶段摘要')
    await openWorkspaceRules(renderer)
    await click(buttonByAria(ruleDialog(renderer), '编辑规则：禁止新增依赖'))
    assert.equal(inputByPlaceholder(ruleDialog(renderer), '规则名称').props.value, '禁止新增依赖')
    await changeValue(inputByPlaceholder(ruleDialog(renderer), '规则名称'), '核对新增依赖')
    await click(buttonByText(ruleDialog(renderer), '更新规则'))
    assert.ok(flat(ruleDialog(renderer)).includes('核对新增依赖'))
    await toggleRule(renderer, '核对新增依赖', false)
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    const edited = ruleWrites().at(-1).stages.S2
    assert.equal(edited.custom[0].id, failedPayload.stages.S2.custom[0].id, '编辑保留 id')
    assert.equal(edited.custom[0].name, '核对新增依赖')
    assert.ok(!edited.ids.includes(edited.custom[0].id), '自定义规则可以关闭但保留定义')
    await openWorkspaceRules(renderer)
    await click(buttonByAria(ruleDialog(renderer), '移除规则：核对新增依赖'))
    assert.ok(!flat(ruleDialog(renderer)).includes('核对新增依赖'))
    assert.equal(ruleWrites().length, 3, '移除只改变本地草稿')
    await click(buttonByText(ruleDialog(renderer), '取消'))
    await openWorkspaceRules(renderer)
    assert.ok(flat(ruleDialog(renderer)).includes('核对新增依赖'), '取消移除后定义仍在')
    await click(buttonByText(ruleDialog(renderer), '恢复本阶段内置默认'))
    assert.ok(!flat(ruleDialog(renderer)).includes('核对新增依赖'))
    assert.ok(checkboxNodes(ruleDialog(renderer)).every((box) => box.props.checked))
    assert.equal(ruleWrites().length, 3, '恢复默认先留在草稿')
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    assert.deepEqual(ruleWrites().at(-1), { path: 'D:/repo/rules', stages: { S1: null, S2: null, S3: null, S4: null } })
    assert.equal(ruleDialog(renderer), null)
  } finally { ruleHandler = null; await act(async () => { renderer.unmount() }) }
})

function numberedFlows(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({ ...alphaMember.flows[1], id: prefix + '-' + (index + 1), sessionId: prefix + '-session-' + (index + 1), title: prefix + '任务' + String(index + 1).padStart(2, '0') }))
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
    await openWorkspaceRules(renderer)
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

await check('仅有完成或放弃记录时主区直接新建，历史详情不另开新建表单', async () => {
  for (const cancelled of [false, true]) {
    const member = { ...idleAlphaMember, flows: idleAlphaMember.flows.map((flow) => ({ ...flow, cancelled })) }
    resetHub([member])
    currentView = baseView('S4', { finished: true, cancelled })
    const renderer = await renderHub()
    try {
      await click(buttonByText(renderer.toJSON(), 'alpha'))
      const tree = renderer.toJSON()
      assert.ok(hasButton(nodeByClass(tree, 'fg-workspace-primary'), '开始需求分析'))
      assert.ok(flat(tree).indexOf('开始新流程') < flat(tree).indexOf('流程记录'))
      assert.equal(nodeByClass(tree, 'fg-workspace-card fg-flow-history').props.open, false)
      await click(buttonByText(tree, '导出报表'))
      assert.equal(findTags(renderer.toJSON(), 'textarea').length, 1, '历史详情不能新增第二份启动表单')
    } finally { await act(async () => { renderer.unmount() }) }
  }
})

await check('当前流程在历史末页仍有主继续入口，翻页和打开结束详情均不暴露新建', async () => {
  resetHub([alphaMember])
  const archived = numberedFlows('历史', 22)
  flowsByPath.set(alphaMember.path, archived.concat([alphaMember.flows[0]]))
  currentView = baseView('S4', { finished: true })
  const renderer = await renderHub()
  try {
    await click(buttonByText(renderer.toJSON(), 'alpha'))
    assert.ok(!hasButton(nodeByClass(renderer.toJSON(), 'fg-workspace-card fg-flow-history'), '会话过期检测'))
    assert.ok(flat(nodeByClass(renderer.toJSON(), 'fg-workspace-primary')).includes('会话过期检测'))
    await click(buttonByText(renderer.toJSON(), '历史任务01'))
    assert.equal(findTags(renderer.toJSON(), 'textarea').length, 0)
    await click(buttonByText(renderer.toJSON(), '下一页'))
    assert.ok(hasButton(nodeByClass(renderer.toJSON(), 'fg-workspace-primary'), '继续流程'))
    assert.equal(findTags(renderer.toJSON(), 'textarea').length, 0)
    currentView = baseView('S2')
    await click(buttonByText(renderer.toJSON(), '继续流程'))
    assert.ok(flat(renderer.toJSON()).includes('出口门禁'))
    assert.ok(flat(renderer.toJSON()).indexOf('出口门禁') < flat(renderer.toJSON()).indexOf('流程记录'))
    assert.equal(findTags(renderer.toJSON(), 'textarea').length, 0)
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('当前流程完成或放弃后刷新恢复主新建表单', async () => {
  for (const cancelled of [false, true]) {
    resetHub([alphaMember])
    const renderer = await renderHub()
    try {
      await click(buttonByText(renderer.toJSON(), 'alpha'))
      assert.ok(hasButton(renderer.toJSON(), '继续流程'))
      const ended = alphaMember.flows.map((flow) => ({ ...flow, finished: true, cancelled, waiting: false }))
      flowsByPath.set(alphaMember.path, ended)
      currentMembers = [{ ...alphaMember, activeCount: 0, waitingCount: 0 }]
      await click(buttonByText(renderer.toJSON(), '刷新'))
      assert.ok(!hasButton(renderer.toJSON(), '继续流程'))
      assert.ok(hasButton(nodeByClass(renderer.toJSON(), 'fg-workspace-primary'), '开始需求分析'))
    } finally { await act(async () => { renderer.unmount() }) }
  }
})

await check('切换工作区等待流程数据时隐藏旧表单和旧继续入口，迟到数据不覆盖', async () => {
  const beta = emptyMember('beta')
  resetHub([idleAlphaMember, beta])
  let release
  const delayed = new Promise((resolve) => { release = resolve })
  flowHandler = (body) => body.path === beta.path ? delayed : response(flowPage(body))
  const renderer = await renderHub()
  try {
    await click(buttonByText(renderer.toJSON(), 'alpha'))
    assert.equal(findTags(renderer.toJSON(), 'textarea').length, 1)
    await click(buttonByText(renderer.toJSON(), '工作区列表'))
    await click(buttonByText(renderer.toJSON(), 'beta'))
    assert.ok(flat(renderer.toJSON()).includes('正在读取当前流程'))
    assert.equal(findTags(renderer.toJSON(), 'textarea').length, 0)
    await click(buttonByText(renderer.toJSON(), '工作区列表'))
    await click(buttonByText(renderer.toJSON(), 'alpha'))
    await act(async () => { release(response({ ...flowPage({ path: beta.path }), currentFlow: { ...alphaMember.flows[0], title: '迟到的当前流程' } })) })
    await settle()
    assert.ok(!flat(renderer.toJSON()).includes('迟到的当前流程'))
    assert.ok(hasButton(renderer.toJSON(), '开始需求分析'))
  } finally {
    release(response(flowPage({ path: beta.path })))
    flowHandler = null
    await act(async () => { renderer.unmount() })
  }
})

await check('流程读取失败或旧宿主缺少当前流程摘要时禁止新建，并可就地重试', async () => {
  for (const failure of [response({ error: '读取流程失败' }, 500), response({ flows: [], total: 0 })]) {
    resetHub([emptyMember('retry')])
    flowHandler = () => failure
    posted = []
    const renderer = await renderHub()
    try {
      await click(buttonByText(renderer.toJSON(), 'retry'))
      const primary = nodeByClass(renderer.toJSON(), 'fg-workspace-primary')
      assert.ok(flat(primary).includes('读取流程失败') || flat(primary).includes('流程数据不完整'))
      assert.equal(findTags(renderer.toJSON(), 'textarea').length, 0)
      assert.equal(posted.length, 0)
      flowHandler = null
      await click(buttonByText(primary, '重试'))
      assert.ok(hasButton(renderer.toJSON(), '开始需求分析'))
    } finally { flowHandler = null; await act(async () => { renderer.unmount() }) }
  }
})

await check('没有宿主会话服务时启动显示原因且不发送 start', async () => {
  resetHub([emptyMember('no-session')])
  posted = []
  const renderer = await renderHub()
  try {
    await click(buttonByText(renderer.toJSON(), 'no-session'))
    await changeValue(findTags(renderer.toJSON(), 'textarea')[0], '测试缺少会话服务')
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.ok(flat(renderer.toJSON()).includes('宿主没有可用的会话'))
    assert.equal(posted.filter((item) => item.action === 'start').length, 0)
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('新建需求草稿跨规则保存、历史分页和刷新保留，工作区间互不串用', async () => {
  const alpha = { ...emptyMember('alpha'), flowCount: 23 }
  const beta = emptyMember('beta')
  resetHub([alpha, beta])
  flowsByPath.set(alpha.path, numberedFlows('已结束', 23))
  posted = []
  const sessions = []
  const renderer = await renderHub({ sessionForWorkspace: async (path) => { sessions.push(path); return 'draft-start' } })
  const brief = '先完整保留这份长需求\n保存规则、翻页和刷新后仍可以继续编辑。'
  const assertDraft = () => {
    const tree = renderer.toJSON()
    assert.equal(findTags(tree, 'textarea')[0].props.value, brief)
    // 表单只留需求原文：标题点击启动时才生成，界面上既不展示也没有输入框。
    assert.ok(!findTags(tree, 'input').some((node) => node.props['aria-label'] === '任务标题'), '不再要求填写标题')
    assert.ok(!findTags(tree, 'textarea').some((node) => node.props['aria-label'] === '需求整理稿'), '不再要求填写整理稿')
    assert.equal(buttonByText(tree, '大需求严格执行').props['aria-pressed'], true)
  }
  try {
    await click(buttonByText(renderer.toJSON(), 'alpha'))
    await changeValue(findTags(renderer.toJSON(), 'textarea')[0], brief)
    await click(buttonByText(renderer.toJSON(), '大需求严格执行'))
    await openWorkspaceRules(renderer)
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    assertDraft()
    await click(buttonByText(renderer.toJSON(), '下一页'))
    assertDraft()
    await click(buttonByText(renderer.toJSON(), '刷新'))
    assertDraft()
    await click(buttonByText(renderer.toJSON(), '工作区列表'))
    await click(buttonByText(renderer.toJSON(), 'beta'))
    assert.equal(findTags(renderer.toJSON(), 'textarea')[0].props.value, '')
    await changeValue(findTags(renderer.toJSON(), 'textarea')[0], '乙工作区自己的草稿')
    await click(buttonByText(renderer.toJSON(), '工作区列表'))
    await click(buttonByText(renderer.toJSON(), 'alpha'))
    assertDraft()
    flowHandler = () => response({ error: '临时读取失败' }, 500)
    await click(buttonByText(renderer.toJSON(), '刷新'))
    assert.equal(findTags(renderer.toJSON(), 'textarea').length, 0)
    assert.equal(posted.length, 0)
    assert.equal(sessions.length, 0)
    flowHandler = null
    await click(buttonByText(renderer.toJSON(), '重试'))
    assertDraft()
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.deepEqual(sessions, [alpha.path])
    assert.deepEqual(posted.find((item) => item.action === 'start').payload, { title: '先完整保留这份长需求', brief, preset: 'strict' })
    assert.equal(findTags(renderer.toJSON(), 'textarea')[0].props.value, '', '成功启动才清空本工作区草稿')
    await click(buttonByText(renderer.toJSON(), '工作区列表'))
    await click(buttonByText(renderer.toJSON(), 'beta'))
    assert.equal(findTags(renderer.toJSON(), 'textarea')[0].props.value, '乙工作区自己的草稿')
  } finally { flowHandler = null; await act(async () => { renderer.unmount() }) }
})

// ---------------------------------------------------------------------------
// 四阶段统一草稿、内容对照与自动整理的行为契约
// ---------------------------------------------------------------------------

function fieldByAria(tree, label) {
  const field = [...findTags(tree, 'textarea'), ...findTags(tree, 'input')].find((node) => node.props['aria-label'] === label)
  assert.ok(field, '找不到输入：' + label)
  return field
}
await check('四阶段草稿切换保留，取消和Esc丢弃全部未保存改动', async () => {
  resetHub([emptyMember('all-stages')]); posted = []
  const renderer = await renderHub()
  try {
    await click(buttonByText(renderer.toJSON(), 'all-stages'))
    await openWorkspaceRules(renderer, 'S1')
    assert.equal(buttonByText(ruleDialog(renderer), 'S1 · 需求分析').props['aria-current'], 'true')
    await addDraftRule(renderer, 'S1 草稿规则')
    await switchRuleStage(renderer, 'S3')
    await addDraftRule(renderer, 'S3 草稿角度')
    await switchRuleStage(renderer, 'S1')
    assert.ok(flat(ruleDialog(renderer)).includes('S1 草稿规则'))
    assert.equal(ruleWrites().length, 0)
    await click(buttonByText(ruleDialog(renderer), '取消'))
    await openWorkspaceRules(renderer, 'S1')
    assert.ok(!flat(ruleDialog(renderer)).includes('S1 草稿规则'))
    await switchRuleStage(renderer, 'S3')
    assert.ok(!flat(ruleDialog(renderer)).includes('S3 草稿角度'))
    await addDraftRule(renderer, 'Esc 丢弃角度')
    await act(async () => { pressEscape() })
    assert.equal(ruleDialog(renderer), null)
    await openWorkspaceRules(renderer, 'S3')
    assert.ok(!flat(ruleDialog(renderer)).includes('Esc 丢弃角度'))
    assert.equal(ruleWrites().length, 0)
    assert.deepEqual(posted, [])
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('内置内容自定义保存同id和原文对照，单项与阶段恢复不修改其他阶段', async () => {
  const member = emptyMember('builtin-edits')
  resetHub([member])
  const original = structuredClone(workspaceRules(member.path).stages.S1.builtin[0])
  const renderer = await renderHub()
  try {
    await click(buttonByText(renderer.toJSON(), 'builtin-edits'))
    await openWorkspaceRules(renderer, 'S1')
    await toggleRule(renderer, original.name, false)
    await click(buttonByAria(ruleDialog(renderer), '编辑规则：' + original.name))
    await changeValue(inputByPlaceholder(ruleDialog(renderer), '规则名称'), '限定需求目标')
    await changeValue(findTags(ruleDialog(renderer), 'textarea')[0], '保留业务目标\n补全约束')
    await click(buttonByText(ruleDialog(renderer), '更新规则'))
    assert.ok(flat(ruleDialog(renderer)).includes('已自定义内置'))
    const comparison = findTags(ruleDialog(renderer), 'details').find((node) => flat(node).includes(original.name))
    assert.ok(flat(comparison).includes(original.points[0]))
    await switchRuleStage(renderer, 'S3')
    await addDraftRule(renderer, '新增业务评审')
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    const saved = ruleWrites().at(-1).stages
    assert.deepEqual(Object.keys(saved), ['S1', 'S2', 'S3', 'S4'])
    assert.deepEqual(saved.S1.edits, [{ id: original.id, name: '限定需求目标', points: ['保留业务目标', '补全约束'] }])
    assert.deepEqual(saved.S1.custom, [])
    assert.ok(!saved.S1.ids.includes(original.id))
    assert.equal(saved.S2, null); assert.equal(saved.S4, null)
    assert.equal(saved.S3.custom[0].name, '新增业务评审')
    assert.deepEqual(workspaceRules(member.path).stages.S1.builtin[0], original, '内置原文不得被内容自定义覆盖')
    await openWorkspaceRules(renderer, 'S1')
    await click(buttonByAria(ruleDialog(renderer), '恢复内置规则：限定需求目标'))
    assert.equal(ruleCheckbox(ruleDialog(renderer), original.name).props.checked, false, '恢复内容保留原来的关闭状态')
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    assert.deepEqual(ruleWrites().at(-1).stages.S1.edits, [])
    assert.deepEqual(ruleWrites().at(-1).stages.S3, saved.S3)
    await openWorkspaceRules(renderer, 'S1')
    await click(buttonByText(ruleDialog(renderer), '恢复本阶段内置默认'))
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    assert.equal(ruleWrites().at(-1).stages.S1, null)
    assert.deepEqual(ruleWrites().at(-1).stages.S3, saved.S3)
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('预览档位只切换默认启用项，内容自定义与跟随档位保存ids:null', async () => {
  resetHub([emptyMember('preset-preview')])
  const renderer = await renderHub()
  try {
    await click(buttonByText(renderer.toJSON(), 'preset-preview'))
    const overview = nodeByClass(renderer.toJSON(), 'fg-stage-rule-summary')
    assert.ok(flat(overview).includes('内置默认 · 随档位 · 快速 1 / 严格 2 条'))
    assert.ok(flat(overview).includes('内置默认 · 随档位 · 3 条'))
    await openWorkspaceRules(renderer, 'S1')
    assert.equal(ruleCheckbox(ruleDialog(renderer), '明确验收标准').props.checked, false)
    await changeValue(findTags(ruleDialog(renderer), 'select')[0], 'strict')
    assert.equal(ruleCheckbox(ruleDialog(renderer), '明确验收标准').props.checked, true)
    await click(buttonByAria(ruleDialog(renderer), '编辑规则：明确需求目标'))
    await changeValue(inputByPlaceholder(ruleDialog(renderer), '规则名称'), '保留档位默认的目标')
    await click(buttonByText(ruleDialog(renderer), '更新规则'))
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    assert.equal(ruleWrites().at(-1).stages.S1.ids, null)
    assert.equal(ruleWrites().at(-1).stages.S1.edits[0].id, 'clarity')
    assert.ok(flat(nodeByClass(renderer.toJSON(), 'fg-stage-rule-summary')).includes('工作区默认 · 随档位 · 快速 1 / 严格 2 条'))
    await openWorkspaceRules(renderer, 'S1')
    await toggleRule(renderer, '明确验收标准', true)
    await click(buttonByText(ruleDialog(renderer), '启用项跟随档位'))
    assert.equal(ruleCheckbox(ruleDialog(renderer), '明确验收标准').props.checked, false)
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    assert.equal(ruleWrites().at(-1).stages.S1.ids, null)
    assert.equal(ruleWrites().at(-1).stages.S1.edits[0].name, '保留档位默认的目标')
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('工作区S4方向不再声明写权限，只保存方向本身', async () => {
  resetHub([emptyMember('write-direction')]); posted = []
  const renderer = await renderHub()
  try {
    await click(buttonByText(renderer.toJSON(), 'write-direction'))
    await openWorkspaceRules(renderer, 'S4')
    await click(buttonByText(ruleDialog(renderer), '添加规则'))
    await changeValue(inputByPlaceholder(ruleDialog(renderer), '规则名称'), '迁移回滚验证')
    // 方向不再有「写权限」这个概念：能执行什么由 S1 批准的 scope 清单决定。
    assert.equal(flat(ruleDialog(renderer)).includes('仍需在 S4 单独授权'), false)
    await click(buttonByText(ruleDialog(renderer), '加入列表'))
    assert.ok(flat(ruleDialog(renderer)).includes('新增自定义'))
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    const stage = ruleWrites().at(-1).stages.S4
    assert.deepEqual(Object.keys(stage).sort(), ['custom', 'edits', 'ids'])
    assert.equal(Object.hasOwn(stage.custom[0], 'needsWrite'), false)
    assert.equal(Object.hasOwn(stage.custom[0], 'writeGranted'), false)
    assert.deepEqual(posted, [])
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('流程S1沿用统一目录并支持toggleAnalysisRule和addAnalysisRule', async () => {
  posted = []
  const workspace = workspaceRules('D:/unused').stages.S1
  currentView = baseView('S1', { stageConfigs: { S1: { ids: ['clarity'], catalog: workspace.catalog, items: [workspace.catalog[0]], source: 'workspace' } } })
  const renderer = await render(FlowDetail, {})
  try {
    await openSettings(renderer)
    assert.ok(flat(nodeByRole(renderer.toJSON(), 'dialog')).includes('工作区默认'))
    const target = checkboxNodes(renderer.toJSON()).find((node) => node.props['aria-label'] === '明确验收标准')
    await act(async () => { target.props.onChange({ target: { checked: true } }) })
    assert.deepEqual(posted.at(-1).payload, { id: 'acceptance', enabled: true })
    assert.equal(posted.at(-1).action, 'toggleAnalysisRule')
    await click(buttonByText(renderer.toJSON(), '追加自定义需求规则'))
    await changeValue(inputByPlaceholder(renderer.toJSON(), '规则名称'), '确认错误路径')
    await click(buttonByText(nodeByRole(renderer.toJSON(), 'dialog'), '追加'))
    assert.equal(posted.at(-1).action, 'addAnalysisRule')
    assert.deepEqual(posted.at(-1).payload, { name: '确认错误路径', points: [] })
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('跟随默认只清当前阶段的本次覆盖，不保存工作区或授予写权限', async () => {
  posted = []
  currentView = baseView('S3', { stageConfigs: { S3: { ids: ['security'], catalog: baseView('S3').angleCatalog, source: 'flow' } } })
  const renderer = await render(FlowDetail, {})
  try {
    await openSettings(renderer)
    assert.ok(flat(nodeByRole(renderer.toJSON(), 'dialog')).includes('本次流程临时调整'))
    await click(buttonByText(nodeByRole(renderer.toJSON(), 'dialog'), '跟随工作区默认'))
    assert.equal(posted.at(-1).action, 'followStageDefaults')
    assert.deepEqual(posted.at(-1).payload, { stage: 'S3' })
    assert.equal(posted.length, 1)
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('输入需求原文时不发标题请求，点击启动才一次性生成标题', async () => {
  resetHub([emptyMember('prepare-on-start')]); posted = []
  prepareHandler = () => response({ title: '模型标题', status: 'ready' })
  const sessions = []
  const renderer = await renderHub({ sessionForWorkspace: async (path) => { sessions.push(path); return 'started-session' } })
  try {
    await click(buttonByText(renderer.toJSON(), 'prepare-on-start'))
    const raw = '  ## 规划需求。\r\n  - 保持缩进\r\n\r\n\r\n第三段  '
    await changeValue(fieldByAria(renderer.toJSON(), '需求原文'), raw)
    // 输入期间不请求标题，也不在表单里展示标题、预览、重新生成按钮或状态行。
    assert.equal(prepareCalls.length, 0)
    assert.equal(fieldByAria(renderer.toJSON(), '需求原文').props.value, raw)
    assert.deepEqual(sessions, []); assert.deepEqual(posted, [])
    assert.ok(!flat(renderer.toJSON()).includes('正在生成'))
    assert.ok(!flat(renderer.toJSON()).includes('重新生成'))
    assert.ok(!flat(renderer.toJSON()).includes('已自动生成'))
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    // 点击时才带上完整原文请求一次标题，结果直接进 start payload。
    assert.deepEqual(prepareCalls, [{ path: 'D:/repo/prepare-on-start', brief: raw }])
    assert.ok(prepareSignals[0] && typeof prepareSignals[0].addEventListener === 'function', '标题请求必须挂上可中止的 signal')
    assert.deepEqual(sessions, ['D:/repo/prepare-on-start'])
    const start = posted.filter((item) => item.action === 'start')
    assert.equal(start.length, 1)
    assert.deepEqual(start[0].payload, { title: '模型标题', preset: 'fast', brief: raw })
    // 下一个界面（工作区里的当前流程卡片）展示的就是这次提交的标题与原文：锚定卡片内的节点，不做全文包含匹配。
    flowsByPath.set('D:/repo/prepare-on-start', [{ id: 'flow-prepare', title: '模型标题', brief: raw, stage: 'S1', stageLabel: '需求分析', finished: false, cancelled: false }])
    await click(buttonByText(renderer.toJSON(), '刷新'))
    const current = nodeByClass(renderer.toJSON(), 'fg-hub-section fg-workspace-card fg-current-flow')
    assert.ok(current, '工作区要渲染当前流程卡片')
    assert.deepEqual(findTags(current, 'h3').map((node) => texts(node).join('')), ['模型标题'])
    const summaryNodes = findTags(current, 'p').filter((node) => String(node.props.className).includes('fg-requirement-text'))
    assert.equal(texts(summaryNodes[0]).join(''), raw, '卡片里的需求正文就是这次提交的原文')
  } finally { prepareHandler = null; await act(async () => { renderer.unmount() }) }
})

await check('标题生成超时被中止后照常启动，不提示错误也不卡按钮', async () => {
  resetHub([emptyMember('prepare-timeout')]); posted = []
  const aborted = []
  // 宿主一直不回：只有客户端自己的期限能收掉这次请求。
  let missingSignal = false
  prepareHandler = (body, init) => new Promise((resolve, reject) => {
    const signal = init && init.signal
    // 生产代码一旦不再传 signal，这里如实记下，最后由明确的断言失败收场，而不是抛 TypeError。
    if (!signal || typeof signal.addEventListener !== 'function') { missingSignal = true; return }
    signal.addEventListener('abort', () => { aborted.push(1); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
  })
  const sessions = []
  const renderer = await renderHub({ sessionForWorkspace: async (path) => { sessions.push(path); return 'timeout-session' } })
  const realSetTimeout = globalThis.setTimeout
  const realWarn = console.warn
  // 期限值写成字面量：拿生产常量当基准再断言它自己被用过，改坏两边一起变，断言永远不会红。
  // 9000 是 AC-6 写死的口径（宿主 6000ms + 3 秒余量）。
  const prepareTimeoutMs = 9000
  assert.equal(plugin.constants.prepareTimeoutMs, prepareTimeoutMs, '客户端标题期限必须是 9000ms')
  const timerDelays = []
  const warns = []
  globalThis.setTimeout = (fn, ms, ...args) => {
    timerDelays.push(ms)
    return realSetTimeout(fn, ms === prepareTimeoutMs ? 0 : ms, ...args)
  }
  console.warn = (...args) => { warns.push(args.join(' ')) }
  const raw = '超时原文标题\n\n  保留缩进'
  try {
    await click(buttonByText(renderer.toJSON(), 'prepare-timeout'))
    await changeValue(fieldByAria(renderer.toJSON(), '需求原文'), raw)
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    await act(async () => { await new Promise((resolve) => realSetTimeout(resolve, 20)) })
    assert.equal(missingSignal, false, '标题请求必须带可中止的 signal')
    assert.ok(timerDelays.includes(prepareTimeoutMs), '标题请求必须按 9000ms 设一次期限')
    assert.deepEqual(aborted, [1], '超时后必须 abort 在飞的标题请求')
    assert.equal(prepareSignals[0].aborted, true)
    // 启动已经发出（草稿随之清空、按钮回到空需求的禁用态），关键是没有停在「正在启动…」。
    assert.ok(!flat(renderer.toJSON()).includes('正在启动…'), '按钮不能卡在启动中')
    assert.ok(!flat(renderer.toJSON()).includes('自动生成暂不可用'))
    const start = posted.filter((item) => item.action === 'start')
    assert.equal(start.length, 1)
    assert.deepEqual(start[0].payload, { title: '超时原文标题', preset: 'fast', brief: raw })
    assert.deepEqual(sessions, ['D:/repo/prepare-timeout'])
    assert.deepEqual(warns, ['[dsh-flowgate] 自动生成标题回落到原文派生：timeout'], '降级原因要留在诊断日志里')
  } finally { globalThis.setTimeout = realSetTimeout; console.warn = realWarn; prepareHandler = null; await act(async () => { renderer.unmount() }) }
})

await check('换不到会话时立即收掉在飞的标题请求，且不当作降级记日志', async () => {
  resetHub([emptyMember('prepare-cancel')]); posted = []
  const aborted = []
  let missingSignal = false
  prepareHandler = (body, init) => new Promise((resolve, reject) => {
    const signal = init && init.signal
    if (!signal || typeof signal.addEventListener !== 'function') { missingSignal = true; return }
    signal.addEventListener('abort', () => { aborted.push(1); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
  })
  const renderer = await renderHub({ sessionForWorkspace: async () => { throw new Error('工作区目录已不存在') } })
  const realSetTimeout = globalThis.setTimeout
  const realWarn = console.warn
  const warns = []
  console.warn = (...args) => { warns.push(args.join(' ')) }
  try {
    await click(buttonByText(renderer.toJSON(), 'prepare-cancel'))
    await changeValue(fieldByAria(renderer.toJSON(), '需求原文'), '换不到会话的原文')
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    await act(async () => { await new Promise((resolve) => realSetTimeout(resolve, 20)) })
    assert.equal(missingSignal, false, '标题请求必须带可中止的 signal')
    // 会话解析抛错也走同一条收网路径：请求被 abort，而不是继续在飞白耗一次模型。
    assert.deepEqual(aborted, [1], '解析会话抛错也必须收掉在飞的标题请求')
    assert.equal(posted.filter((item) => item.action === 'start').length, 0)
    assert.ok(flat(renderer.toJSON()).includes('工作区目录已不存在'), '换不到会话要把原因显示出来')
    assert.ok(!flat(renderer.toJSON()).includes('正在启动…'), '按钮不能卡在启动中')
    assert.deepEqual(warns, [], '调用方主动取消不是降级，不该写诊断日志')
  } finally { globalThis.setTimeout = realSetTimeout; console.warn = realWarn; prepareHandler = null; await act(async () => { renderer.unmount() }) }
})

await check('切换工作区各自保留启动草稿，返回原目录仍在且不发标题请求', async () => {
  resetHub([emptyMember('prepare-alpha'), emptyMember('prepare-beta')])
  const renderer = await renderHub()
  try {
    await click(buttonByText(renderer.toJSON(), 'prepare-alpha'))
    await changeValue(fieldByAria(renderer.toJSON(), '需求原文'), '甲目录原文')
    assert.equal(prepareCalls.length, 0)
    await click(buttonByText(renderer.toJSON(), '工作区列表'))
    await click(buttonByText(renderer.toJSON(), 'prepare-beta'))
    assert.equal(fieldByAria(renderer.toJSON(), '需求原文').props.value, '')
    await changeValue(fieldByAria(renderer.toJSON(), '需求原文'), '乙目录原文')
    await click(buttonByText(renderer.toJSON(), '工作区列表'))
    await click(buttonByText(renderer.toJSON(), 'prepare-alpha'))
    assert.equal(fieldByAria(renderer.toJSON(), '需求原文').props.value, '甲目录原文')
    assert.equal(prepareCalls.length, 0)
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('超20000字符保留完整输入并拒绝标题请求和启动', async () => {
  resetHub([emptyMember('prepare-limit')]); posted = []
  const sessions = []
  const renderer = await renderHub({ sessionForWorkspace: async (path) => { sessions.push(path); return 'unused' } })
  try {
    await click(buttonByText(renderer.toJSON(), 'prepare-limit'))
    const raw = '长'.repeat(20001)
    await changeValue(fieldByAria(renderer.toJSON(), '需求原文'), raw)
    assert.equal(fieldByAria(renderer.toJSON(), '需求原文').props.value, raw)
    assert.ok(flat(renderer.toJSON()).includes('原文未被截断'))
    assert.equal(buttonByText(renderer.toJSON(), '开始需求分析').props.disabled, true)
    await click(buttonByText(renderer.toJSON(), '开始需求分析'))
    assert.deepEqual(prepareCalls, []); assert.deepEqual(sessions, []); assert.deepEqual(posted, [])
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('标题生成失败静默回落到本地标题，重复点击只启动一次', async () => {
  resetHub([emptyMember('prepare-fallback')]); posted = []
  prepareHandler = () => response({ error: '模型暂不可用' }, 503)
  const realWarn = console.warn
  const warns = []
  console.warn = (...args) => { warns.push(args.join(' ')) }
  const sessions = []
  let resolveSession
  const renderer = await renderHub({ sessionForWorkspace: (path) => { sessions.push(path); return new Promise((resolve) => { resolveSession = resolve }) } })
  try {
    await click(buttonByText(renderer.toJSON(), 'prepare-fallback'))
    const raw = '  原文标题\r\n\r\n\r\n  保留原文缩进  '
    await changeValue(fieldByAria(renderer.toJSON(), '需求原文'), raw)
    // 失败不提示错误、不在表单里回显生成结果，原文原样保留。
    assert.equal(fieldByAria(renderer.toJSON(), '需求原文').props.value, raw)
    assert.ok(!flat(renderer.toJSON()).includes('自动生成暂不可用'))
    assert.ok(!flat(renderer.toJSON()).includes('本地整理'))
    const button = buttonByText(renderer.toJSON(), '开始需求分析')
    await act(async () => { button.props.onClick(); button.props.onClick() })
    assert.deepEqual(sessions, ['D:/repo/prepare-fallback'])
    assert.deepEqual(prepareCalls, [{ path: 'D:/repo/prepare-fallback', brief: raw }])
    await act(async () => { resolveSession('prepared-session') })
    const start = posted.filter((item) => item.action === 'start')
    assert.equal(start.length, 1)
    assert.deepEqual(start[0].payload, { title: '原文标题', preset: 'fast', brief: raw })
    // 宿主返回错误与真超时是两种原因，日志要能区分，不能都写成 timeout。
    assert.deepEqual(warns, ['[dsh-flowgate] 自动生成标题回落到原文派生：unavailable'], '宿主不可用不能被记成超时')
  } finally { console.warn = realWarn; prepareHandler = null; await act(async () => { renderer.unmount() }) }
})

await check('进行中只展示需求原文，详情取最新view而非打开时快照', async () => {
  const flow = { ...alphaMember.flows[0], sessionId: 'sess-latest-requirement', brief: '快照旧原文', summary: '快照旧整理稿' }
  resetHub([{ ...alphaMember, flows: [flow] }])
  currentView = baseView('S2', { title: '最新流程标题', brief: '  最新原文\n  保留缩进  ', summary: '最新整理稿\n第二条验收' })
  const renderer = await renderHub()
  try {
    await click(buttonByText(renderer.toJSON(), 'alpha'))
    const current = nodeByClass(renderer.toJSON(), 'fg-hub-section fg-workspace-card fg-current-flow')
    assert.ok(current, '主区应有当前流程卡片')
    assert.equal(findTags(nodeByClass(current, 'fg-requirement'), 'p')[0].children.join(''), '快照旧原文')
    assert.ok(!flat(current).includes('快照旧整理稿'), '旧整理稿字段不再出现在界面上')
    await click(buttonByText(renderer.toJSON(), '继续流程'))
    const detail = nodeByClass(renderer.toJSON(), 'fg-flow-requirement')
    assert.ok(flat(detail).includes('最新流程标题'))
    assert.ok(!flat(detail).includes('快照旧整理稿'))
    assert.ok(!flat(detail).includes('快照旧原文'))
    const paragraphs = findTags(detail, 'p')
    assert.equal(paragraphs.length, 1, '只展示一段需求原文')
    assert.equal(paragraphs[0].children.join(''), currentView.brief)
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('旧流程带summary字段也只展示brief，不再出现整理稿', async () => {
  currentView = baseView('S2', { brief: '旧需求第一行\n第二行', summary: '旧版整理稿残留' })
  const renderer = await render(FlowDetail, {})
  try {
    const detail = nodeByClass(renderer.toJSON(), 'fg-flow-requirement')
    assert.equal(findTags(detail, 'p')[0].children.join(''), currentView.brief)
    assert.ok(!flat(detail).includes('旧版整理稿残留'), '旧快照的整理稿字段一律忽略')
    assert.equal(findTags(detail, 'details').length, 0, '不再有「查看需求原文」的折叠块')
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('长需求原文可展开和收起全文，按钮关联正文', async () => {
  const brief = '  未整理原文\n' + '原始约束'.repeat(220) + '  '
  currentView = baseView('S2', { brief, summary: '这份整理稿不该出现' })
  const renderer = await render(FlowDetail, {})
  try {
    let requirement = nodeByClass(renderer.toJSON(), 'fg-requirement')
    let paragraph = findTags(requirement, 'p')[0]
    const preview = paragraph.children.join('')
    assert.ok(preview.length <= 241)
    assert.ok(preview.endsWith('…'))
    assert.ok(!flat(requirement).includes('这份整理稿不该出现'))
    const expand = buttonByText(requirement, '展开全文')
    assert.equal(expand.props['aria-expanded'], false)
    assert.equal(expand.props['aria-controls'], paragraph.props.id)
    await click(expand)
    requirement = nodeByClass(renderer.toJSON(), 'fg-requirement')
    paragraph = findTags(requirement, 'p')[0]
    assert.equal(paragraph.children.join(''), brief)
    assert.equal(buttonByText(requirement, '收起').props['aria-expanded'], true)
    await click(buttonByText(requirement, '收起'))
    assert.equal(findTags(nodeByClass(renderer.toJSON(), 'fg-requirement'), 'p')[0].children.join(''), preview)
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('历史行直接呈现需求原文，旧记录的整理稿字段被忽略', async () => {
  resetHub([{ ...idleAlphaMember, flows: [
    { ...idleAlphaMember.flows[0], summary: '整理后的可见历史摘要\n含验收标准', brief: '历史行里应显示的旧原文' },
    { ...idleAlphaMember.flows[1], brief: '没有整理稿时的旧需求摘要' },
  ] }])
  const renderer = await renderHub()
  try {
    await click(buttonByText(renderer.toJSON(), 'alpha'))
    const rows = findTags(renderer.toJSON(), 'button').filter((node) => node.props.className === 'fg-flow-row')
    assert.equal(rows.length, 2)
    const summaries = rows.map((row) => nodeByClass(row, 'fg-flow-summary').children.join(''))
    assert.deepEqual(summaries, ['历史行里应显示的旧原文', '没有整理稿时的旧需求摘要'])
    assert.ok(!summaries[0].includes('整理后的可见历史摘要'))
  } finally { await act(async () => { renderer.unmount() }) }
})

// 只实现模态框使用的选择器，保留渲染后的DOM顺序与焦点身份。
function focusDomOf(tree) {
  const nodes = []
  const append = (source, parentElement = null) => {
    if (!source || typeof source !== 'object') return null
    const node = { tagName: source.type, props: source.props, disabled: source.props?.disabled, parentElement, children: [],
      focus() { card.activeElement = node } }
    nodes.push(node)
    for (const child of source.children || []) { const element = append(child, node); if (element) node.children.push(element) }
    return node
  }
  const card = append(tree)
  card.querySelectorAll = (selector) => nodes.slice(1).filter((node) => selector.split(',').some((part) => {
    const value = part.trim()
    if (['button', 'input', 'select', 'textarea', 'summary'].includes(value)) return node.tagName === value
    if (value === 'a[href]') return node.tagName === 'a' && node.props.href !== undefined
    if (value === '[tabindex]:not([tabindex="-1"])') return node.props.tabIndex !== undefined && node.props.tabIndex !== -1
    if (value === 'details > summary:first-of-type:not([tabindex="-1"])') {
      return node.tagName === 'summary' && node.props.tabIndex !== -1 && node.parentElement?.tagName === 'details'
        && node.parentElement.children.find((child) => child.tagName === 'summary') === node
    }
    return false
  }))
  return card
}

await check('延迟保存禁用控件时原生summary仍参与Tab与Shift+Tab首尾回绕', async () => {
  const member = emptyMember('saving-focus')
  resetHub([member])
  let release
  ruleHandler = (body) => Object.hasOwn(body, 'stages') ? new Promise((resolve) => { release = resolve }) : response({ rules: workspaceRules(body.path) })
  const renderer = await renderHub()
  try {
    await click(buttonByText(renderer.toJSON(), 'saving-focus'))
    await openWorkspaceRules(renderer, 'S1')
    await click(buttonByText(ruleDialog(renderer), '保存规则'))
    const dialog = ruleDialog(renderer)
    assert.ok(buttons(dialog).every((button) => button.props.disabled), '延迟保存期间所有按钮均禁用')
    assert.ok([...findTags(dialog, 'input'), ...findTags(dialog, 'select')].every((node) => node.props.disabled))
    const card = focusDomOf(dialog)
    const summaries = card.querySelectorAll('summary')
    assert.equal(summaries.length, 2, '夹具应提供两个仍可展开的原生summary')
    let prevented = 0
    const tab = (target, shiftKey) => dialog.props.onKeyDown({ key: 'Tab', target, currentTarget: card, shiftKey, preventDefault() { prevented += 1 } })
    const [first, last] = summaries
    last.focus(); tab(last, false)
    assert.equal(prevented, 1)
    assert.equal(card.activeElement, first, '末个summary按Tab应回到首个summary')
    tab(first, true)
    assert.equal(prevented, 2)
    assert.equal(card.activeElement, last, '首个summary按Shift+Tab应回到末个summary')
    card.focus(); tab(card, true)
    assert.equal(prevented, 3)
    assert.equal(card.activeElement, last, '从dialog反向Tab仍应留在summary序列内')
    await act(async () => { pressEscape() })
    assert.ok(ruleDialog(renderer), '正在保存时Esc不应卸载弹窗')
    await act(async () => { release(response({ rules: workspaceRules(member.path) })) })
    assert.equal(ruleDialog(renderer), null)
  } finally {
    if (release) await act(async () => { release(response({ rules: workspaceRules(member.path) })) })
    ruleHandler = null
    await act(async () => { renderer.unmount() })
  }
})

// ---------------------------------------------------------------------------
// 客户端契约与诊断：这些是逻辑及数值替身测试，不代表真实浏览器布局已验证。
// ---------------------------------------------------------------------------

function acceptanceOf(statuses) {
  const items = statuses.map((status, index) => ({ id: 'AC-' + (index + 1), when: '输入 ' + index, then: '输出 ' + index,
    method: '独立浏览器测量', procedure: '选择目标并比较边界', status, evidence: '测量记录 ' + index, artifact: 'layout-' + index + '.json', version: 'v1', reason: status === 'uncovered' ? '缺少真实浏览器' : '' }))
  const counts = { total: items.length, pending: 0, pass: 0, fail: 0, uncovered: 0 }
  for (const item of items) counts[item.status] += 1
  return { version: 'v1', items, counts }
}

await check('验收表展示方法步骤、逐项状态、证据与产物', async () => {
  currentView = baseView('S4', { acceptance: acceptanceOf(['pass', 'fail', 'uncovered', 'pending']) })
  const tree = (await render(FlowDetail, {})).toJSON()
  assert.equal(findTags(tree, 'table').length, 1)
  for (const text of ['独立浏览器测量', '选择目标并比较边界', '测量记录 0', 'layout-0.json', '未通过', '未覆盖', '待验证', '缺少真实浏览器']) assert.ok(flat(tree).includes(text), text)
})

await check('scope展示冻结的验证方法和步骤', async () => {
  currentView = baseView('S2')
  currentView.scope.data.acceptance_criteria[0] = { ...currentView.scope.data.acceptance_criteria[0], method: 'API 请求', procedure: '先过期再请求接口' }
  const text = flat((await render(FlowDetail, {})).toJSON())
  assert.ok(text.includes('验证方法：API 请求'))
  assert.ok(text.includes('验证步骤：先过期再请求接口'))
})

await check('S4未全通过时按钮标出需确认，两步确认后才提交例外结项', async () => {
  // 按钮文案统一成一个短词：缺口性质由旁边的账本行说明，不再把三种长句塞进按钮。
  for (const statuses of [['pass', 'uncovered'], ['pending'], ['fail', 'uncovered']]) {
    currentView = baseView('S4', { waiting: true, acceptance: acceptanceOf(statuses) })
    posted = []
    const renderer = await render(FlowDetail, {})
    assert.equal(buttons(renderer.toJSON()).some((node) => flat(node) === '结束流程'), false, '有缺口时不能出现不带确认的结束按钮')
    await click(buttonByText(renderer.toJSON(), '结束流程（需确认）'))
    assert.equal(posted.length, 0, '第一次点击只展开缺口，不发请求')
    await click(buttonByText(renderer.toJSON(), '确认结束流程'))
    const payload = posted.find((item) => item.action === 'gate').payload
    assert.equal(payload.acceptUncovered, true)
    assert.equal(payload.acceptanceNote, undefined)
    assert.deepEqual(currentView.acceptance.items.map((item) => item.status), statuses)
  }
})

await check('AC全通过但测试要点未通过时仍明确接受例外', async () => {
  for (const result of ['fail', 'uncovered', 'excluded']) {
    currentView = baseView('S4', { waiting: true, acceptance: acceptanceOf(['pass']), test: { directions: [{ id: 'smoke', points: [{ point: '独立验证', result }] }] } })
    posted = []
    const renderer = await render(FlowDetail, {})
    await click(buttonByText(renderer.toJSON(), '结束流程（需确认）'))
    assert.equal(posted.length, 0)
    await click(buttonByText(renderer.toJSON(), '确认结束流程'))
    assert.equal(posted.find((item) => item.action === 'gate').payload.acceptUncovered, true)
  }
})

await check('测试要点 failed: 0 但 AC 一条没过时，两套账分别显示', async () => {
  // 这正是真实流程里出现过的那种：测试要点没有 fail，但 AC 0 通过 / 3 未覆盖。
  // 只报「失败 0 项」会让人以为没事，所以两套数字必须并排出现。
  currentView = baseView('S4', {
    waiting: true,
    acceptance: acceptanceOf(['uncovered', 'uncovered', 'uncovered']),
    test: { failed: 0, directions: [{ id: 'smoke', name: '冒烟验证', points: [{ point: '主路径可用', result: 'uncovered' }] }] },
  })
  posted = []
  const renderer = await render(FlowDetail, {})
  const tree = renderer.toJSON()
  assert.match(flat(tree), /验收标准：通过 0 · 未通过 0 · 未覆盖 3 · 待验证 0（共 3 条）/)
  assert.match(flat(tree), /测试要点：通过 0 · 失败 0 · 未覆盖 1 · 环境受限 0（共 1 个）/)
  // 结束方式必须自成一档，不能读成「全部验收通过」。
  assert.equal(buttons(tree).some((node) => flat(node) === '结束流程'), false)
  assert.ok(hasButton(tree, '结束流程（需确认）'))
  await click(buttonByText(tree, '结束流程（需确认）'))
  const confirmBtn = buttonByText(renderer.toJSON(), '确认结束流程')
  assert.equal(confirmBtn.props.disabled, false, '缺口已摊开，确认即接受')
  await click(buttonByText(renderer.toJSON(), '确认结束流程'))
  assert.equal(posted.find((item) => item.action === 'gate').payload.acceptUncovered, true)
})

await check('流程以带缺口方式结束后，门禁卡显示缺口而不是绿色已完成', async () => {
  currentView = baseView('S4', {
    finished: true,
    closure: { kind: 'accepted_with_gaps', counts: { total: 3, pass: 0, fail: 0, uncovered: 3, pending: 0 }, pointCounts: { total: 1, pass: 0, fail: 0, uncovered: 1, excluded: 0 }, note: '真实浏览器不可用' },
  })
  const tree = (await render(FlowDetail, {})).toJSON()
  assert.ok(hasButton(tree, '带缺口结束') === false, '结束方式用徽标呈现，不是可点按钮')
  assert.match(flat(tree), /带缺口结束/)
  assert.match(flat(tree), /验收标准 0 通过 \/ 0 未通过 \/ 3 未覆盖（共 3 条）/)
  assert.match(flat(tree), /用户补充的接受原因：真实浏览器不可用/)
  const gate = nodeByLabel(tree, '出口门禁')
  assert.ok(gate, '门禁卡必须存在')
  assert.ok(!flat(gate).includes('流程已结束'), '带缺口结束不能只写「流程已结束」，那句话和全部通过没区别')
  assert.ok(!flat(gate).includes('已完成'), '带缺口结束不能显示成绿色已完成')
})

await check('S4全部通过时沿用原按钮且不发送例外许可', async () => {
  currentView = baseView('S4', { waiting: true, acceptance: acceptanceOf(['pass']) })
  posted = []
  const renderer = await render(FlowDetail, {})
  await click(buttonByText(renderer.toJSON(), '结束流程'))
  assert.equal(posted.find((item) => item.action === 'gate').payload.acceptUncovered, undefined)
})

await check('退回开发不再要求用户写说明，原因由宿主按未通过项生成', async () => {
  // 退回原因服务端已经知道（remediationList 按 AC 列出未通过项）：
  // 再让用户重述一遍，只是把系统已知的事变成一道必填题。
  // S3：任何情况都能退回修复；S4 只有带缺口时才有可修的东西。
  const cases = [
    ['S3', {}],
    ['S4', { acceptance: { items: [{ id: 'AC-1', status: 'fail', reason: '返回 500' }], counts: { total: 1, pass: 0, fail: 1, uncovered: 0, pending: 0 } } }],
  ]
  for (const [stage, patch] of cases) {
    currentView = baseView(stage, { waiting: true, ...patch })
    posted = []
    const renderer = await render(FlowDetail, {})
    const fields = findTags(renderer.toJSON(), 'textarea').filter((node) => node.props['aria-label'] === '退回说明（可选）')
    assert.equal(fields.length, 0, stage + ' 不该再有退回说明输入框')
    await click(buttonByText(renderer.toJSON(), '退回开发修复'))
    const payload = posted.find((item) => item.action === 'gate').payload
    assert.equal(payload.to, 'S2')
    assert.equal(payload.note, undefined, '不再附带用户手写的退回说明')
  }
})

await check('S2展示自动修复清单与建议数量', async () => {
  currentView = baseView('S2', { remediation: { reason: '验收未覆盖', note: '补真实测量', items: [{ ac: 'AC-1', summary: '修正对齐边界', source: 'test', severity: 'MAJOR', status: 'pending' }], advisories: [{}] } })
  const text = flat((await render(FlowDetail, {})).toJSON())
  for (const wanted of ['本轮修复清单', '验收未覆盖', '补真实测量', '修正对齐边界', '另有 1 条建议']) assert.ok(text.includes(wanted), text)
})

await check('零阻塞仍显示完整严重度与未覆盖AC，fast只折叠余项', async () => {
  const findings = Array.from({ length: 5 }, (_, index) => ({ severity: 'MINOR', summary: 'minor-' + index, file: 'src/auth/session.ts', ac: 'AC-1', acMatched: true, fileInScope: true }))
  currentView = baseView('S3', { acceptance: acceptanceOf(['uncovered']), review: { counts: { total: 5, critical: 0, major: 0, minor: 5, blocking: 0, advisories: 5, unscoped: 0 }, fresh: 1, reused: [], angles: [{ id: 'correctness', name: '正确性', verdict: 'advisory', findings }] } })
  const tree = (await render(FlowDetail, {})).toJSON()
  const text = flat(tree)
  for (const wanted of ['无阻塞项', '共 5 条发现', 'MINOR 5', '未覆盖 1', '本轮评审 1', '展开其余 2 条发现', 'minor-4']) assert.ok(text.includes(wanted), text)
  const details = findTags(tree, 'details').find((node) => flat(node).includes('展开其余'))
  assert.ok(details && !details.props.open, '余项使用原生details折叠，所有发现仍在树内')
  assert.equal(findTags(details, 'div').filter((node) => node.props.className === 'fg-item fg-finding').length, 2)
})

await check('摘要分开实现验证生效执行，技术哈希仅在诊断详情内', async () => {
  currentView = baseView('S2', { acceptance: acceptanceOf(['uncovered']), runtime: { status: 'unverified', hostRevision: 'host-hash', expectedClientRevision: 'client-hash' }, snapshot: { id: 'snapshot-hash', complete: false, files: [], errors: ['读取失败'] }, stageSummary: { implementation: { status: 'complete', text: '已完成实现' }, verification: acceptanceOf(['uncovered']).counts, runtime: { status: 'unverified', text: '页面尚未核对' }, execution: { status: 'idle', text: '等待独立验证' }, review: { fresh: 1, reused: 2, total: 3 }, test: { fresh: 2, reused: 1, total: 3 } } })
  const tree = (await render(FlowDetail, {})).toJSON()
  for (const text of ['实现：', '验证：', '生效：', '执行：', '已完成实现', '页面尚未核对', '等待独立验证', '采集不完整', '读取失败', '评审：本轮 1 · 复用 2 · 合计 3']) assert.ok(flat(tree).includes(text), text)
  const diagnostics = findTags(tree, 'details').find((node) => flat(node).includes('技术诊断'))
  assert.ok(flat(diagnostics).includes('host-hash'))
  assert.ok(!diagnostics.props.open)
})

await check('客户端上报实际factory的SHA-256，唯一标记可供宿主提取', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.split('/* flowgate-factory:start */').length, 2)
  assert.equal(source.split('/* flowgate-factory:end */').length, 2)
  const declared = source.split('/* flowgate-factory:start */')[1].split('/* flowgate-factory:end */')[0].trim()
  const expected = createHash('sha256').update(clientFactory.toString().replaceAll('\r\n', '\n')).digest('hex')
  assert.equal(createHash('sha256').update(declared.replaceAll('\r\n', '\n')).digest('hex'), expected)
  const originalFetch = globalThis.fetch
  const calls = []
  try {
    currentView = baseView('S2')
    globalThis.fetch = async (url, init) => { calls.push(String(url)); return originalFetch(url, init) }
    await render(FlowDetail, {})
    assert.ok(calls.some((url) => new URL(url, 'http://localhost').searchParams.get('clientRevision') === expected))
  } finally { globalThis.fetch = originalFetch }
})

await check('布局probe使用真实数值接口，覆盖对齐失败、容差与缺失能力', async () => {
  const originalFetch = globalThis.fetch
  const previousQuery = document.querySelectorAll
  const previousStyle = window.getComputedStyle
  const expected = createHash('sha256').update(clientFactory.toString().replaceAll('\r\n', '\n')).digest('hex')
  const sessionId = 'layout-probe-session'
  let right = 300
  const pageId = window.__DSH_FLOWGATE_DIAGNOSTICS__.pageId
  const verified = { status: 'verified', clientRevision: expected, expectedClientRevision: expected, pageId, viewport: { width: window.innerWidth, height: window.innerHeight } }
  let runtime = { ...verified }
  const reports = []
  const receipts = []
  let receiptMode = 'valid'
  let version = 'layout-snapshot'
  const owner = { getAttribute: () => sessionId }
  const target = { tagName: 'DIV', closest: () => owner, getRootNode: () => document, getBoundingClientRect: () => ({ left: 20, right }), isConnected: true }
  const reference = { getBoundingClientRect: () => ({ left: 20, right: 300 }), isConnected: true }
  const references = [{ name: '实际输入卡片', selector: '.explicit-input-card' }]
  let styleCalls = 0
  try {
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'POST') {
        assert.equal(String(url), '/api/flowgate/action')
        const body = JSON.parse(init.body)
        assert.equal(body.sessionId, sessionId)
        assert.equal(body.action, 'layout-evidence')
        assert.equal(body.payload.version, version)
        assert.equal(body.payload.pageId, pageId)
        assert.equal(body.payload.clientRevision, expected)
        assert.deepEqual(body.payload.viewport, { width: window.innerWidth, height: window.innerHeight })
        assert.equal(body.payload.measurements.length, 1)
        receipts.push(body.payload)
        if (receiptMode === 'http') return response({}, 503)
        if (receiptMode === 'throw') throw new Error('receipt network unavailable')
        if (receiptMode === 'missing') return response({})
        if (receiptMode === 'resize') window.innerWidth = 900
        return response({ layoutEvidence: { id: 'receipt-' + receipts.length, ...body.payload,
          ...(receiptMode === 'mismatch' ? { pageId: 'other-page' } : {}) } })
      }
      const query = new URL(String(url), 'http://localhost').searchParams
      assert.equal(query.get('clientRevision'), expected)
      assert.equal(query.get('pageId'), pageId)
      assert.equal(Number(query.get('viewportWidth')), window.innerWidth)
      assert.equal(Number(query.get('viewportHeight')), window.innerHeight)
      reports.push({ width: Number(query.get('viewportWidth')), height: Number(query.get('viewportHeight')) })
      return response({ active: true, runtime, snapshot: { id: version } })
    }
    document.querySelectorAll = (selector) => selector === '.fg-hint' ? [target] : selector === '.explicit-input-card' ? [reference] : []
    window.getComputedStyle = () => { styleCalls += 1; return { display: 'block', visibility: 'visible' } }
    const probe = window.__DSH_FLOWGATE_DIAGNOSTICS__.inspectLayout
    let result = await probe({ sessionId, references })
    assert.equal(result.status, 'pass')
    assert.equal(result.pageId, pageId)
    assert.equal(result.runtime.pageId, pageId)
    assert.equal(result.version, version)
    assert.equal(result.evidenceId, 'receipt-1')
    assert.deepEqual(receipts[0].measurements, result.measurements)
    assert.deepEqual(result.viewport, { width: 1280, height: 720, devicePixelRatio: 1 })
    assert.deepEqual(result.measurements[0], { element: '.fg-hint', reference: '实际输入卡片', left: 20, right: 300, referenceLeft: 20, referenceRight: 300 })
    assert.ok(styleCalls >= 2)
    for (receiptMode of ['http', 'throw', 'missing', 'mismatch', 'resize']) {
      const failedReceipt = await probe({ sessionId, references })
      assert.equal(failedReceipt.status, 'uncovered', receiptMode)
      assert.equal(failedReceipt.evidenceId, null)
      window.innerWidth = 1280
    }
    receiptMode = 'valid'
    version = null
    assert.equal((await probe({ sessionId, references })).status, 'uncovered')
    version = 'layout-snapshot'
    const shadowRoot = { querySelectorAll: () => [reference] }
    assert.equal((await probe({ sessionId, element: { ...target, getRootNode: () => shadowRoot }, references })).status, 'pass', '显式元素实例可在其ShadowRoot内测量参照')
    right = 303
    assert.equal((await probe({ sessionId, references })).status, 'fail')
    assert.equal((await probe({ sessionId, references, tolerancePx: 3 })).status, 'pass')
    assert.equal((await probe({ sessionId, references: [] })).status, 'uncovered')
    assert.equal((await probe({ sessionId, references: [{ name: '缺失', selector: '.missing' }] })).status, 'uncovered')
    assert.equal((await probe({ sessionId, element: '.missing', references })).status, 'uncovered')
    assert.equal((await probe({ sessionId, element: { ...target, closest: () => ({ getAttribute: () => 'wrong-session' }) }, references })).status, 'uncovered')
    const select = document.querySelectorAll
    document.querySelectorAll = (selector) => selector === '.fg-hint' ? [target, target] : select(selector)
    assert.equal((await probe({ sessionId, references })).status, 'uncovered')
    document.querySelectorAll = (selector) => selector === '.explicit-input-card' ? [reference, reference] : select(selector)
    assert.equal((await probe({ sessionId, references })).status, 'uncovered')
    document.querySelectorAll = select
    assert.equal((await probe({ sessionId, references, tolerancePx: -1 })).status, 'uncovered')
    assert.equal((await probe({ references })).status, 'uncovered')
    const workingFetch = globalThis.fetch
    globalThis.fetch = async () => response({}, 503)
    assert.equal((await probe({ sessionId, references })).status, 'uncovered')
    globalThis.fetch = workingFetch
    runtime = { ...runtime, status: 'mismatch' }
    assert.equal((await probe({ sessionId, references })).status, 'uncovered')
    runtime = { ...runtime, status: 'verified', expectedClientRevision: 'different-source' }
    assert.equal((await probe({ sessionId, references })).status, 'uncovered')
    runtime = { ...verified, pageId: 'another-page-instance' }
    assert.equal((await probe({ sessionId, references })).status, 'uncovered')
    runtime = { ...verified, pageId: undefined }
    assert.equal((await probe({ sessionId, references })).status, 'uncovered')
    runtime = { ...verified, viewport: undefined }
    assert.equal((await probe({ sessionId, references })).status, 'uncovered')
    runtime = { ...verified }
    right = 300
    window.innerWidth = 1024
    assert.equal((await probe({ sessionId, references })).status, 'uncovered')
    const reportCount = reports.length
    runtime = { ...verified, viewport: { width: 1024, height: 720 } }
    assert.equal((await probe({ sessionId, references })).status, 'pass')
    assert.equal(reports.length, reportCount + 1, '视口变化后每次测量必须重新pull')
    assert.deepEqual(reports.at(-1), { width: 1024, height: 720 })
    window.innerWidth = 1280
    window.getComputedStyle = undefined
    assert.equal((await probe({ sessionId, references })).status, 'uncovered')
  } finally {
    globalThis.fetch = originalFetch
    document.querySelectorAll = previousQuery
    window.getComputedStyle = previousStyle
    window.innerWidth = 1280
  }
})

await check('无WebCrypto时正常拉取且诊断未核对，不伪造指纹', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let isolatedPlugin
  const urls = []
  const isolatedWindow = { getComputedStyle: () => ({ display: 'block' }), __ModuleLoader__: { load(entry) { isolatedPlugin = entry.factory(require) } } }
  vm.runInNewContext(source, { window: isolatedWindow, document, crypto: undefined, TextEncoder, fetch: async (url) => { urls.push(String(url)); return response(baseView('S2', { runtime: { status: 'unverified' } })) }, setInterval, clearInterval })
  const renderer = await render(isolatedPlugin.components.FlowDetail, {})
  try {
    const probe = await isolatedWindow.__DSH_FLOWGATE_DIAGNOSTICS__.inspectLayout({ sessionId: 'no-crypto', references: [{ name: 'ref', selector: '.ref' }] })
    assert.equal(probe.status, 'uncovered')
    assert.equal(probe.clientRevision, null)
    assert.ok(urls.length >= 2)
    assert.ok(urls.every((url) => !new URL(url, 'http://localhost').searchParams.has('clientRevision')))
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('指纹计算未完成时首次正常拉取，完成后的请求携带实际指纹', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let isolatedPlugin
  let releaseDigest
  const digest = new Promise((resolve) => { releaseDigest = resolve })
  const urls = []
  const isolatedWindow = { __ModuleLoader__: { load(entry) { isolatedPlugin = entry.factory(require) } } }
  vm.runInNewContext(source, { window: isolatedWindow, document, crypto: { subtle: { digest: () => digest } }, TextEncoder,
    fetch: async (url) => { urls.push(String(url)); return response(baseView('S2')) }, setInterval, clearInterval })
  const renderer = await render(isolatedPlugin.components.FlowDetail, {})
  try {
    assert.ok(urls.length > 0)
    assert.ok(urls.every((url) => !new URL(url, 'http://localhost').searchParams.has('clientRevision')))
    releaseDigest(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('deferred-test-source')))
    await isolatedWindow.__DSH_FLOWGATE_DIAGNOSTICS__.inspectLayout({ sessionId: 'digest-ready' })
    const expected = createHash('sha256').update('deferred-test-source').digest('hex')
    assert.equal(new URL(urls.at(-1), 'http://localhost').searchParams.get('clientRevision'), expected)
  } finally { await act(async () => { renderer.unmount() }) }
})

await check('同代码的不同factory页面实例有独立身份，缺能力旧页不能沿用新页认证', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const calls = []
  let latestRuntime
  function createPage(crypto) {
    const isolatedWindow = { innerWidth: 1280, innerHeight: 720, __ModuleLoader__: { load(entry) { entry.factory(require) } } }
    vm.runInNewContext(source, { window: isolatedWindow, document, crypto, TextEncoder, setInterval, clearInterval,
      fetch: async (url, init) => {
        assert.notEqual(init?.method, 'POST', '身份未核对时不得保存布局采集')
        const query = new URL(String(url), 'http://localhost').searchParams
        calls.push(query)
        return response({ runtime: latestRuntime || { status: 'unverified' }, snapshot: { id: 'same-snapshot' } })
      } })
    return isolatedWindow.__DSH_FLOWGATE_DIAGNOSTICS__
  }
  const first = createPage(webcrypto)
  const second = createPage(webcrypto)
  assert.notEqual(first.pageId, second.pageId)
  assert.match(first.pageId, /^[a-f0-9-]{36}$/)
  assert.ok(Object.isFrozen(first))
  const one = await first.inspectLayout({ sessionId: 'same-task' })
  const two = await second.inspectLayout({ sessionId: 'same-task' })
  assert.equal(one.clientRevision, two.clientRevision, '相同源码应有相同哈希')
  assert.equal(calls[0].get('pageId'), first.pageId)
  assert.equal(calls[1].get('pageId'), second.pageId)
  latestRuntime = { status: 'verified', pageId: second.pageId, clientRevision: two.clientRevision,
    expectedClientRevision: two.clientRevision, viewport: { width: 1280, height: 720 } }
  assert.equal((await first.inspectLayout({ sessionId: 'same-task' })).status, 'uncovered', '其他页面认证不能用于本页')
  const noUuid = createPage({ subtle: webcrypto.subtle })
  const noUuidResult = await noUuid.inspectLayout({ sessionId: 'same-task' })
  assert.equal(noUuid.pageId, null)
  assert.equal(noUuidResult.status, 'uncovered')
  assert.ok(noUuidResult.clientRevision)
  assert.equal(calls.at(-1).has('pageId'), false)
  const noDigest = createPage({ randomUUID: () => webcrypto.randomUUID() })
  const oldPage = await noDigest.inspectLayout({ sessionId: 'same-task' })
  assert.equal(oldPage.clientRevision, null)
  assert.equal(oldPage.status, 'uncovered', '缺指纹旧页不能沿用服务端残留的新页verified')
  assert.equal(oldPage.evidenceId, null)
  assert.equal(calls.at(-1).has('clientRevision'), false)
})

await check('已有样式节点和ShadowRoot样式内容会在热更新时替换', async () => {
  const originalGet = document.getElementById
  const oldStyle = { id: 'dsh-flowgate-styles', textContent: 'old-style' }
  try {
    document.getElementById = () => oldStyle
    plugin.apply({ slots: { inject() {}, register() {} } })
    assert.ok(oldStyle.textContent.includes('.fg-ac-table'))
    assert.notEqual(oldStyle.textContent, 'old-style')
    const shadowStyle = { textContent: 'stale-shadow-style' }
    let renderer
    await act(async () => {
      renderer = TestRenderer.create(h(HubPanel, {}), { createNodeMock: (element) => element.props.className === 'fg-root fg-hub'
        ? { getRootNode: () => ({ getElementById: () => shadowStyle }) } : null })
    })
    mounted.push(renderer)
    assert.equal(shadowStyle.textContent, oldStyle.textContent)
  } finally { document.getElementById = originalGet }
})

// ---------------------------------------------------------------------------
// S1 决策问题：会话输入框上方直接作答
// ---------------------------------------------------------------------------

/** S1 停在一个待回答的决策问题上；问题与选项和工作台的 GrillCard 同源。 */
function grillView(patch = {}) {
  return baseView('S1', {
    waiting: true,
    waitingKind: 'answer',
    grill: {
      pending: {
        id: 'q_dock_1',
        question: '点选快捷答案后要不要再留一条用户发言？',
        context: '只影响会话记录，不影响流程推进。',
        options: [
          { label: '不用额外发消息，点一下即答', tradeoff: '不引入「发送用户消息」依赖' },
          { label: '顺带发一条用户发言', tradeoff: '会话里留下这次选择' },
        ],
        recommended: 0,
        allowCustom: true,
        at: '2026-11-21T10:00:00Z',
      },
      answeredCount: 0,
      awaiting: true,
    },
    ...patch,
  })
}

function answerButtons(tree) {
  const opts = nodeByClass(tree, 'fg-hint-answer-opts')
  return opts ? buttons(opts) : []
}

await check('阶段提示：S1 决策问题在 dock 里直接作答，选项与推荐项同源', async () => {
  currentView = grillView()
  const tree = (await render(stageHint, {})).toJSON()
  const box = nodeByClass(tree, 'fg-hint-answer')
  assert.ok(box, '有决策问题时 dock 出现回答区')
  assert.match(flat(box), /问：点选快捷答案后要不要再留一条用户发言？/)
  assert.match(flat(box), /只影响会话记录，不影响流程推进。/)
  const opts = answerButtons(tree)
  // 每个选项按钮里两行：标签（带推荐后缀）与取舍说明，标签文案只取第一行。
  assert.deepEqual(opts.map((node) => flat(nodeByClass(node, 'fg-hint-answer-opt-label'))), ['不用额外发消息，点一下即答（推荐）', '顺带发一条用户发言'])
  assert.ok(opts[0].props.className.includes('fg-hint-btn-primary'), '推荐项用主色')
  // 取舍说明直接排在选项下面：触屏、键盘与读屏都拿得到，不靠悬停。
  assert.equal(flat(nodeByClass(opts[0], 'fg-hint-answer-opt-label')), '不用额外发消息，点一下即答（推荐）')
  assert.equal(flat(nodeByClass(opts[0], 'fg-hint-answer-opt-note')), '不引入「发送用户消息」依赖', '取舍说明可见')
  assert.equal(opts[0].props.title, undefined, '取舍不再只挂在 title 上')
  // 回答区独占一行：流转按钮组仍然是原来那一个（S1 未交文档时只剩放弃）。
  assert.deepEqual(buttons(nodeByClass(tree, 'fg-hint-actions')).map((node) => flat(node)), ['放弃这次流程'])
})

await check('阶段提示：点一下快捷答案只投递一次 answer', async () => {
  currentView = grillView()
  const renderer = await render(stageHint, {})
  posted = []
  await click(answerButtons(renderer.toJSON())[1])
  assert.equal(posted.length, 1, '一次点击只投递一条请求')
  assert.equal(posted[0].action, 'answer')
  assert.deepEqual(posted[0].payload, { choiceIndex: 1, customText: '' })
})

await check('阶段提示：自定义答案 Ctrl+Enter 与按钮同源，禁用时不出现入口', async () => {
  currentView = grillView()
  const renderer = await render(stageHint, {})
  posted = []
  await click(buttonByText(renderer.toJSON(), '其他答案…'))
  assert.equal(buttonByText(renderer.toJSON(), '提交答案').props.disabled, true, '空草稿不能提交')
  await changeValue(findTags(renderer.toJSON(), 'textarea')[0], '  按我的方案来  ')
  const input = findTags(renderer.toJSON(), 'textarea')[0]
  assert.equal(buttonByText(renderer.toJSON(), '提交答案').props.disabled, false)
  assert.equal(await pressKey(input, { ctrlKey: true }), 1, 'Ctrl+Enter 要吞掉默认换行')
  assert.equal(posted.length, 1)
  assert.deepEqual(posted[0].payload, { choiceIndex: -1, customText: '按我的方案来' })
  // allowCustom === false：自定义入口完全不出现。
  const base = grillView()
  currentView = grillView({ grill: { ...base.grill, pending: { ...base.grill.pending, allowCustom: false } } })
  const tree = (await render(stageHint, {})).toJSON()
  // buttonByText 找不到时自己就会抛错，断言「不存在」只能用 buttons 自己找。
  assert.equal(buttons(tree).some((node) => flat(node).includes('其他答案…')), false, 'allowCustom:false 时不出现自定义入口')
  assert.equal(findTags(tree, 'textarea').length, 0)
})

await check('阶段提示：提交中锁住答案按钮，失败给出可读报错', async () => {
  currentView = grillView()
  const renderer = await render(stageHint, {})
  const originalFetch = globalThis.fetch
  let release
  const gate = new Promise((resolve) => { release = resolve })
  posted = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/action')) {
      posted.push(JSON.parse(init.body))
      await gate
      return { ok: false, status: 500, json: async () => ({ error: '宿主正忙，请稍后再试' }) }
    }
    return originalFetch(url, init)
  }
  try {
    const press = (node) => node.props.onClick({ currentTarget: { focus() {} } })
    await act(async () => {
      press(answerButtons(renderer.toJSON())[0])
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    assert.equal(posted.length, 1, '在飞时再点不会重复投递')
    const busy = renderer.toJSON()
    for (const node of answerButtons(busy)) assert.equal(node.props.disabled, true, '在飞时按钮锁住')
    assert.match(flat(busy), /提交中…/)
    await act(async () => {
      press(answerButtons(renderer.toJSON())[0])
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    assert.equal(posted.length, 1, '1.5 秒轮询窗口里连点也只发一次')
    await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 60)) })
    const err = findTags(renderer.toJSON(), 'div').find((node) => node.props?.className === 'fg-hint-err')
    assert.ok(err, '失败要给出报错')
    assert.equal(err.props.role, 'alert')
    assert.match(flat(err), /宿主正忙/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('阶段提示：换问题不继承上一条的提交态与回包', async () => {
  const sessionId = 'hint-swap-' + (++seq)
  currentView = grillView()
  const renderer = await render(stageHint, { session: { sessionId } }, false)
  const originalFetch = globalThis.fetch
  let release
  const gate = new Promise((resolve) => { release = resolve })
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/action')) {
        await gate
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      }
      return originalFetch(url, init)
    }
    await act(async () => {
      answerButtons(renderer.toJSON())[0].props.onClick({ currentTarget: { focus() {} } })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    assert.match(flat(renderer.toJSON()), /提交中…/)
    // 旧请求还挂着时换一道题：新问题的按钮不该被上一道的提交态锁死。
    const base = grillView()
    currentView = grillView({ grill: { ...base.grill, pending: { ...base.grill.pending, id: 'q_dock_2' } } })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1650)) })
    const tree = renderer.toJSON()
    assert.ok(flat(tree).includes('问：'), '换上新问题后仍可作答')
    for (const node of answerButtons(tree)) assert.equal(node.props.disabled, false, '换问题后按钮不该被旧请求锁住')
    assert.ok(!flat(tree).includes('提交中…'))
    // 旧回包这时才到：结果属于上一道题，不能拿来改这一道的状态。
    await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 60)) })
    const after = renderer.toJSON()
    assert.equal(findTags(after, 'div').some((node) => node.props?.className === 'fg-hint-err'), false, '旧回包不能在新问题上报错')
    for (const node of answerButtons(after)) assert.equal(node.props.disabled, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('阶段提示：问题被答掉后回答区随轮询消失，不残留答案按钮', async () => {
  const sessionId = 'hint-answer-' + (++seq)
  currentView = grillView()
  const renderer = await render(stageHint, { session: { sessionId } }, false)
  assert.ok(nodeByClass(renderer.toJSON(), 'fg-hint-answer'))
  currentView = grillView({ grill: { pending: null, answeredCount: 1, awaiting: false } })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1650)) })
  const tree = renderer.toJSON()
  assert.equal(nodeByClass(tree, 'fg-hint-answer'), null)
  assert.equal(buttons(tree).some((node) => flat(node) === '其他答案…'), false)
})

await check('阶段提示：等待说明按 waitingKind 分流，只有可作答时才指向快捷答案', async () => {
  const why = (tree) => flat(nodeByClass(tree, 'fg-hint-why'))
  currentView = grillView()
  assert.equal(why((await render(stageHint, {})).toJSON()), '点上面的快捷答案，或到「流程工作台」回答')
  currentView = baseView('S1', { waiting: true, waitingKind: 'answer' })
  assert.equal(why((await render(stageHint, {})).toJSON()), '到左侧栏「流程工作台」回答这个问题')
  currentView = baseView('S1', { waiting: true, waitingKind: 'doc' })
  assert.equal(why((await render(stageHint, {})).toJSON()), '在左侧栏「流程工作台」确认后才继续')
  currentView = baseView('S2', { waiting: true, waitingKind: 'gate' })
  assert.equal(why((await render(stageHint, {})).toJSON()), '在左侧栏「流程工作台」确认后才继续')
})

await check('阶段提示：推荐标记只追加一次，标签里不再自带', async () => {
  currentView = grillView({
    grill: {
      pending: {
        id: 'q_dock_recommend',
        question: '选哪个方案？',
        options: [{ label: '方案A' }, { label: '方案B' }],
        recommended: 0,
        allowCustom: false,
        at: '2026-11-21T10:00:00Z',
      },
      answeredCount: 0,
      awaiting: true,
    },
  })
  const tree = (await render(stageHint, {})).toJSON()
  const labels = answerButtons(tree).map((node) => flat(nodeByClass(node, 'fg-hint-answer-opt-label')))
  assert.deepEqual(labels, ['方案A（推荐）', '方案B'])
  // 「（推荐）」只有一个来源：渲染层按 recommended 追加，标签文本原样透传。
  assert.equal(labels.join('').split('（推荐）').length - 1, 1)
})

{
  currentView = baseView('S1', {
    waiting: true,
    waitingKind: 'answer',
    grill: {
      pending: {
        id: 'q_card_recommend',
        question: '选哪个方案？',
        options: [{ label: '方案A', tradeoff: '改动最小' }, { label: '方案B' }],
        recommended: 0,
        allowCustom: false,
        at: '2026-11-21T10:00:00Z',
      },
      answeredCount: 0,
      awaiting: true,
    },
  })
  const renderer = await render(FlowDetail, {})
  await check('工作台拍板卡片：推荐标记是标签后缀，不再是独立徽标', () => {
    const tree = renderer.toJSON()
    const opt = buttonByText(tree, '方案A')
    assert.equal(flat(nodeByClass(opt, 'fg-opt-label')), '方案A（推荐）')
    // 卡片标题里还有一个「S1 需求分析」徽标，所以只在选项按钮内部断言。
    const badges = findTags(opt, 'span').filter((node) => String(node.props?.className || '').includes('fg-badge'))
    assert.equal(badges.length, 0, '推荐项按钮内不应再有徽标')
  })
  await act(async () => { renderer.unmount() })
}

await check('阶段提示：回答区选项在任何视口都竖排、整行铺满（样式契约）', async () => {
  const css = styleNodes[0].textContent
  assert.match(css, /\.fg-hint-answer \{[^}]*grid-column: 1 \/ -1;[^}]*display: flex;[^}]*flex-wrap: wrap;/)
  // 选项一律竖排：宽屏下也不并排，否则又会出现「一行两个、第二行一个」。
  assert.match(css, /\.fg-hint-answer-opts \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*width: 100%;/)
  assert.match(css, /\.fg-hint-answer-opts > button \{[^}]*text-align: left;[^}]*width: 100%;/)
  // 横向并排的来源就是 flex-wrap：选项容器里不许再出现它。
  const optsRule = css.match(/\.fg-hint-answer-opts \{[^}]*\}/)
  assert.ok(optsRule, '样式里必须有 .fg-hint-answer-opts 规则')
  assert.doesNotMatch(optsRule[0], /flex-wrap: wrap/, '选项容器不能靠 flex-wrap 换行：' + optsRule[0])
  // 窄屏不再单独声明：竖排已是基础规则，宽窄屏行为一致。
  const narrow = css.match(/@media \(max-width: 640px\) \{[\s\S]*?\n\}/)
  assert.ok(narrow, '样式里必须有窄屏媒体查询')
  assert.doesNotMatch(narrow[0], /\.fg-hint-answer-opts/, '窄屏媒体查询不再重复声明选项布局：' + narrow[0])
  // 自定义入口仍在独立的一行里，不和选项挤在一起。
  assert.match(css, /\.fg-hint-answer-custom \{[^}]*flex: 1 1 100%;/)
  // 不写死布局像素宽度：只允许 min-height / max-height 这类纵向约束。
  for (const line of css.split('\n').filter((entry) => entry.includes('.fg-hint-answer'))) {
    assert.ok(!/width:\s*\d+px/.test(line), '回答区不能写死像素宽度：' + line.trim())
  }
  // .fg-hint 的宽度契约原样保留。
  assert.match(css, /\.fg-hint \{[^}]*width: calc\(100% - 2 \* var\(--dsh-composer-side-clearance, 0px\) - 4 \* var\(--dsh-composer-dock-inset, 0px\)\);/)
  assert.match(css, /max-width: calc\(var\(--dsh-composer-card-max-width, 100%\) - 4 \* var\(--dsh-composer-dock-inset, 0px\)\);/)
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