/**
 * dsh-flowgate · host
 *
 * 四阶段流程约束开发工作台。宿主端负责：
 *   - 四阶段状态机（S1 需求分析 → S2 开发 → S3 评审 → S4 测试）
 *   - scope.json 的冻结与守卫、只读子代理的最终工具守卫
 *   - 门禁等待（工具挂起，等用户在工作台点按钮）
 *   - flows.jsonl 事件日志与 state.json 快照
 *   - 给客户端用的 /api/flowgate 路由
 *
 * 设计原则见 README：门禁软跳过、硬顺序；评审工具层只读；scope 先冻结；
 * 所有确认都是按钮。
 */

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const PLUGIN = 'dsh-flowgate'
const API_BASE = '/api/flowgate'
const DATA_DIR = '.dsh-flowgate'

/** 阶段顺序固定，不可增删、不可调序。 */
const STAGES = ['S1', 'S2', 'S3', 'S4']
const STAGE_LABEL = { S1: '需求分析', S2: '开发', S3: '评审', S4: '测试' }
const STAGE_OUTPUT = {
  S1: '需求文档 + scope.json',
  S2: '代码变更（对照 scope）',
  S3: '评审报告',
  S4: '测试报告',
}
const NEXT_STAGE = { S1: 'S2', S2: 'S3', S3: 'S4', S4: null }

/** 内置评审角度。自定义角度只能追加，不能删除内置角度。 */
const BUILTIN_ANGLES = [
  {
    id: 'security',
    name: '安全',
    points: ['凭据与敏感数据的读取/落盘路径', '注入、越权、路径穿越', '依赖与配置的暴露面'],
  },
  {
    id: 'correctness',
    name: '正确性',
    points: ['实现是否覆盖 scope 声明的能力', '边界条件与错误路径', '是否逐条遵守用户定义的开发规则'],
  },
  {
    id: 'tests',
    name: '测试质量',
    points: ['是否覆盖验收标准', '断言是否真的会失败', '是否存在不可验证的测试'],
  },
  {
    id: 'style',
    name: '风格',
    points: ['与既有代码风格一致', '命名与分层', '注释是否解释「为什么」而非复述代码'],
  },
]

/** 内置测试方向。自定义方向只能追加。 */
const BUILTIN_DIRECTIONS = [
  { id: 'smoke', name: '冒烟验证', points: ['主路径可运行', '无启动期错误'] },
  {
    id: 'functional',
    name: '功能正确性',
    points: ['逐条验证 acceptance_criteria', '返回结构与状态码符合声明'],
  },
  {
    id: 'boundary',
    name: '边界与异常',
    points: ['空/超长/非法输入', '并发与超时', '失败后状态可恢复'],
  },
  { id: 'regression', name: '回归影响', points: ['受影响的相邻模块', '公共接口契约未被破坏'] },
]

/**
 * 内置开发规则。PRD 4.5：开发规则是结构化条目，S2 里作为检查清单存在，
 * S3 的正确性 / 风格角度会逐条核对。自定义规则只能追加，不能删掉内置规则。
 */
const BUILTIN_RULES = [
  { id: 'scope-only', name: '只改 scope 内的文件', points: ['不新增 scope 之外的文件', '不顺手重构无关代码'] },
  { id: 'no-new-dep', name: '不引入未声明的依赖', points: ['不新增 package.json 依赖', '不 import 未声明的包'] },
  { id: 'explicit-errors', name: '错误路径显式处理', points: ['不吞异常', '失败时返回可诊断的信息'] },
  { id: 'no-debug-leftovers', name: '不留调试残留', points: ['不留 console.log / debugger', '不留注释掉的死代码'] },
  { id: 'match-style', name: '与既有代码风格一致', points: ['命名习惯一致', '目录与分层一致'] },
]

/** 规则默认全开；工作区默认与流程覆盖都没有时用它。 */
const DEFAULT_RULE_IDS = BUILTIN_RULES.map((rule) => rule.id)

/** 规则来源的中文说明：状态摘要与界面共用，避免两处各写一份。 */
const RULE_SOURCE_LABEL = {
  flow: '本次流程临时调整',
  workspace: '工作区默认（' + DATA_DIR + '/config.json）',
  default: '内置默认',
}

/** 两档预设：同一引擎的两组参数，不是独立流程。 */
const PRESETS = {
  fast: {
    id: 'fast',
    label: '小功能快速开发',
    summary: '两个评审角度、一个测试方向，追问只走核心决策点。',
    angles: ['correctness', 'tests'],
    directions: ['smoke'],
    grillDepth: 'shallow',
  },
  strict: {
    id: 'strict',
    label: '大需求严格执行',
    summary: '四个评审角度、三个测试方向，追问走完决策树各分支。',
    angles: ['security', 'correctness', 'tests', 'style'],
    directions: ['functional', 'boundary', 'regression'],
    grillDepth: 'deep',
  },
}

/** 写类工具：全部要在 scope 守卫里过一遍。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'ops_write_file', 'ops_edit_file'])

const READONLY_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep',
  'ops_read_files', 'ops_inspect_local_file', 'ops_stat', 'ops_glob', 'ops_grep', 'ops_diff',
  'job_output',
  'load_workspace_dependencies',
])
const READONLY_OPS_APIS = new Set(['read_files', 'stat', 'glob', 'grep', 'diff', 'result'])

/**
 * shell 类工具的名字。不同 profile 装的 shell 插件不一样（内置 bash、dsh-ops 的
 * ops_bash / ops_pwsh……），只认一个名字等于给自己留后门，所以按名字集合判定。
 */
const SHELL_TOOLS = new Set(['bash', 'shell', 'exec', 'run_shell', 'terminal', 'ops_bash', 'ops_pwsh', 'ops_powershell', 'powershell', 'pwsh'])

/** 变更性 shell 的特征。命中即在 S2 之外被拒。 */
const SHELL_WRITE_HINTS = /(\s>>?\s|\btee\b|\bsed\s+-i|\brm\s|\bmv\s|\bcp\s|\bgit\s+(apply|checkout|reset|clean|stash|rm)|\bnpm\s+(install|i)\b|\bpnpm\s+(add|install)\b|\bmkdir\b|\btouch\b|\bchmod\b|\bchown\b|\btruncate\b|\bdd\s|\bSet-Content\b|\bOut-File\b|\bNew-Item\b|\bRemove-Item\b)/

const nowIso = () => new Date().toISOString()
const clone = (value) => JSON.parse(JSON.stringify(value))

/** 读取写类工具的目标路径（三套工具参数名不同）。 */
function writeTargetOf(name, args) {
  if (!args || typeof args !== 'object') return null
  const raw = args.file_path ?? args.path ?? args.filePath ?? args.target
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/** 把任意路径规范成相对 cwd 的 posix 形式，便于与 scope 声明比较。 */
function normalizeTarget(cwd, target) {
  const absolute = isAbsolute(target) ? target : resolve(cwd, target)
  const rel = relative(cwd, absolute)
  if (rel.startsWith('..')) return absolute.replaceAll(sep, '/')
  return rel.replaceAll(sep, '/')
}

function isInsideDataDir(relOrAbs) {
  return relOrAbs === DATA_DIR || relOrAbs.startsWith(DATA_DIR + '/')
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

function dataRoot(cwd) {
  return join(cwd, DATA_DIR)
}

function flowFile(cwd, flowId) {
  return join(dataRoot(cwd), 'flows', flowId + '.json')
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

/** 原子写：先写临时文件再 rename，避免半截 JSON。 */
function writeJsonAtomic(file, value) {
  ensureDir(dirname(file))
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

function appendEvent(cwd, flow, type, detail) {
  const record = {
    at: nowIso(),
    flowId: flow.id,
    sessionId: flow.sessionId,
    stage: flow.stage,
    type,
    detail: detail ?? null,
  }
  flow.events.push(record)
  try {
    ensureDir(dataRoot(cwd))
    appendFileSync(join(dataRoot(cwd), 'flows.jsonl'), JSON.stringify(record) + '\n', 'utf8')
  } catch {
    // 日志失败不影响流程本身。
  }
  return record
}

// 只缓存列表所需字段，不保留 events、scope、报告等完整快照；工作区按 LRU 限定数量。
const HUB_CACHE_LIMIT = 64
const hubFlowCache = new Map()

function fileSignature(file) {
  try {
    const stat = statSync(file, { bigint: true })
    return [stat.mtimeNs, stat.ctimeNs, stat.size, stat.ino].join(':')
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

function persist(flow) {
  flow.updatedAt = nowIso()
  const file = flowFile(flow.cwd, flow.id)
  try {
    writeJsonAtomic(file, flow)
  } catch {
    // 落盘失败不回滚内存状态：状态机优先，日志与快照是审计用途。
  }
  const cached = hubFlowCache.get(resolve(flow.cwd))
  if (cached) {
    try {
      cached.set(flow.id + '.json', { signature: fileSignature(file), summary: hubFlowSummary(null, flow) })
    } catch {
      // Hub 的读盘缓存不能影响状态机；内存流程仍会覆盖列表里的磁盘摘要。
    }
  }
}

function hubFlows(service, cwd) {
  const key = resolve(cwd)
  let cached = hubFlowCache.get(key)
  if (!cached) cached = new Map()
  hubFlowCache.delete(key)
  hubFlowCache.set(key, cached)
  if (hubFlowCache.size > HUB_CACHE_LIMIT) hubFlowCache.delete(hubFlowCache.keys().next().value)
  const dir = join(dataRoot(cwd), 'flows')
  let names = []
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    // 不可读/被移除的目录仍可作为名单成员显示。
  }
  const present = new Set(names)
  for (const name of cached.keys()) if (!present.has(name)) cached.delete(name)
  for (const name of names) {
    try {
      const file = join(dir, name)
      const signature = fileSignature(file)
      if (cached.has(name) && cached.get(name).signature === signature) continue
      const flow = JSON.parse(readFileSync(file, 'utf8'))
      if (!flow || typeof flow.id !== 'string' || typeof flow.sessionId !== 'string') throw new Error('无效快照')
      cached.set(name, { signature, summary: hubFlowSummary(null, flow) })
    } catch {
      // 坏文件也记住签名，避免每次翻页重复解析；文件修复后自动刷新。
      try { cached.set(name, { signature: fileSignature(join(dir, name)), summary: null }) } catch { cached.delete(name) }
    }
  }
  const byId = new Map()
  for (const { summary } of cached.values()) if (summary) byId.set(summary.id, summary)
  // 活跃流程的门禁与落盘失败后的状态以本服务内存为准。
  for (const flow of service.flows.values()) {
    if (resolve(flow.cwd) === key) byId.set(flow.id, hubFlowSummary(service, flow))
  }
  return [...byId.values()].map((summary) => ({
    ...summary,
    waiting: service.get(summary.sessionId)?.id === summary.id && service.gates.has(summary.sessionId),
    waitingKind: service.get(summary.sessionId)?.id === summary.id ? service.gates.kindOf(summary.sessionId) : null,
  })).sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) || a.id.localeCompare(b.id))
}

function loadFlowsFromDisk(cwd) {
  const dir = join(dataRoot(cwd), 'flows')
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), 'utf8')))
    } catch {
      // 坏文件跳过。
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 工作区配置
// ---------------------------------------------------------------------------

/**
 * 工作区级设置：跨流程记住的默认值，存在 <cwd>/.dsh-flowgate/config.json。
 * 这份文件是「默认值」而不是「流程状态」——可以提交进版本库，让同一个仓库的
 * 所有流程都从同一套开发规则起步；单条流程的临时调整仍然只写它自己的快照。
 */
const WORKSPACE_CONFIG_VERSION = 1

function workspaceConfigFile(cwd) {
  return join(dataRoot(cwd), 'config.json')
}

/** 给界面展示的路径：不把机器上的绝对路径泄到工作台里。 */
function workspaceConfigLabel() {
  return DATA_DIR + '/config.json'
}

function normalizeRuleEntry(item) {
  if (!item || typeof item !== 'object') return null
  const id = typeof item.id === 'string' ? item.id.trim() : ''
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  if (!id || !name) return null
  const points = Array.isArray(item.points)
    ? item.points.map((point) => String(point).trim()).filter(Boolean)
    : String(item.points ?? '').split('\n').map((point) => point.trim()).filter(Boolean)
  return { id, name, points }
}

/** 手写的 config.json 可能缺字段或类型不对：读盘时归一，坏配置不该拦住流程。 */
function normalizeWorkspaceRules(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const ids = Array.isArray(raw.ids)
    ? raw.ids.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
    : null
  const custom = Array.isArray(raw.custom) ? raw.custom.map(normalizeRuleEntry).filter(Boolean) : []
  return { ids, custom }
}

function loadWorkspaceConfig(cwd) {
  const file = workspaceConfigFile(cwd)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    return {
      version: WORKSPACE_CONFIG_VERSION,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      rules: normalizeWorkspaceRules(raw.rules),
    }
  } catch {
    // 坏文件当没配置：规则是来约束开发的，配置损坏不该让流程起不来。
    return null
  }
}

function saveWorkspaceConfig(cwd, config) {
  const file = workspaceConfigFile(cwd)
  ensureDir(dirname(file))
  writeJsonAtomic(file, config)
  return config
}

// ---------------------------------------------------------------------------
// 流程模型
// ---------------------------------------------------------------------------

function emptyStage() {
  return {
    status: 'pending',
    gate: 'pending',
    skipped: false,
    decidedAt: null,
    note: null,
    gateRequested: false,
  }
}

/**
 * 记下「这一轮确实请求过门禁」：用来区分「产物刚落地、Agent 还没请求」与「请求被中断」。
 * 前者不该提示用户「上次的请求被中断」。
 */
function markGateRequested(flow) {
  const record = flow.stages[flow.stage]
  if (!record) return
  record.gateRequested = true
  persist(flow)
}

/**
 * 从需求描述里派生出标题：用户在工作台里贴一段需求时，标题栏不该是空白或整段文字。
 * 取首个非空行，去掉 markdown 前缀与句末标点，超长截断。
 */
function deriveTitle(brief) {
  const text = typeof brief === 'string' ? brief : ''
  const first = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)
  if (!first) return ''
  const cleaned = first.replace(/^[#>*\-\s]+/, '').replace(/[。；;，,.！!？?]+$/, '').trim()
  if (!cleaned) return ''
  return cleaned.length > 40 ? cleaned.slice(0, 40) + '…' : cleaned
}

function createFlow({ sessionId, cwd, title, preset, brief }) {
  const at = nowIso()
  const text = typeof brief === 'string' ? brief.trim().slice(0, 4000) : ''
  return {
    id: 'f_' + randomUUID().slice(0, 12),
    sessionId,
    cwd,
    title: title || deriveTitle(text) || '未命名任务',
    /** 界面里贴进来的需求原文；Agent 在 S1 用它提问，不再要求用户复述一遍。 */
    brief: text,
    createdAt: at,
    updatedAt: at,
    stage: 'S1',
    finished: false,
    preset: preset === 'strict' ? 'strict' : 'fast',
    /** 用户对预设的覆盖：null 表示跟随 preset。 */
    overrides: { angles: null, directions: null, rules: null },
    customAngles: [],
    customDirections: [],
    customRules: [],
    scope: { frozen: false, frozenAt: null, data: null, withoutDocApproval: false },
    /** D2：用户显式授权写权限的测试方向 id。 */
    writeGrants: [],
    doc: { html: null, recommendedPreset: null, reason: null, at: null },
    grill: { pending: null, answered: [] },
    stages: { S1: emptyStage(), S2: emptyStage(), S3: emptyStage(), S4: emptyStage() },
    review: null,
    test: null,
    devChanges: null,
    events: [],
  }
}

/** 当前生效的评审角度 id 列表。 */
function activeAngles(flow) {
  const base = flow.overrides.angles ?? PRESETS[flow.preset].angles
  return base.slice()
}

function activeDirections(flow) {
  const base = flow.overrides.directions ?? PRESETS[flow.preset].directions
  return base.slice()
}

function angleCatalog(flow) {
  return BUILTIN_ANGLES.concat(flow.customAngles)
}

function directionCatalog(flow) {
  return BUILTIN_DIRECTIONS.concat(flow.customDirections)
}

/** 规则现在的来源：本次流程临时调整、工作区默认、还是内置默认。 */
function ruleSourceOf(flow, workspace) {
  if (Array.isArray(flow.overrides?.rules)) return 'flow'
  if (Array.isArray(workspace?.rules?.ids)) return 'workspace'
  return 'default'
}

/** 当前生效的开发规则 id 列表：流程临时调整 > 工作区默认 > 内置默认。 */
function activeRules(flow, workspace) {
  const base = flow.overrides?.rules ?? workspace?.rules?.ids ?? DEFAULT_RULE_IDS
  return base.slice()
}

/** 规则目录：内置 < 工作区自定义 < 本次流程自定义，同 id 只留先出现的那个。 */
function ruleCatalog(flow, workspace) {
  const out = []
  const seen = new Set()
  for (const rule of BUILTIN_RULES.concat(workspace?.rules?.custom ?? [], flow.customRules ?? [])) {
    if (!rule || typeof rule.id !== 'string' || seen.has(rule.id)) continue
    seen.add(rule.id)
    out.push(rule)
  }
  return out
}

function resolveRules(flow, workspace) {
  const catalog = ruleCatalog(flow, workspace)
  return activeRules(flow, workspace)
    .map((id) => catalog.find((rule) => rule.id === id))
    .filter(Boolean)
}

function resolveAngles(flow) {
  const catalog = angleCatalog(flow)
  return activeAngles(flow)
    .map((id) => catalog.find((a) => a.id === id))
    .filter(Boolean)
}

function resolveDirections(flow) {
  const catalog = directionCatalog(flow)
  return activeDirections(flow)
    .map((id) => catalog.find((d) => d.id === id))
    .filter(Boolean)
}

/** 前序阶段是否全部落地（passed 或 skipped_by_user）。 */
function canEnter(flow, stage) {
  const index = STAGES.indexOf(stage)
  if (index <= 0) return true
  for (let i = 0; i < index; i += 1) {
    const s = flow.stages[STAGES[i]].status
    if (s !== 'passed' && s !== 'skipped_by_user') return false
  }
  return true
}

function skippedCount(flow) {
  return STAGES.filter((s) => flow.stages[s].status === 'skipped_by_user').length
}

/**
 * 推进门禁。
 * @param {object} flow
 * @param {'pass'|'skip'} decision
 */
function passGate(flow, decision) {
  abortChildRun(flow)
  const stage = flow.stage
  const record = flow.stages[stage]
  if (decision === 'skip') {
    record.status = 'skipped_by_user'
    record.skipped = true
    record.gate = 'skipped'
  } else {
    record.status = 'passed'
    record.gate = 'passed'
  }
  record.decidedAt = nowIso()
  const next = NEXT_STAGE[stage]
  appendEvent(flow.cwd, flow, decision === 'skip' ? 'gate.skipped' : 'gate.passed', { stage })
  if (next === null) {
    flow.finished = true
    appendEvent(flow.cwd, flow, 'flow.finished', { skipped: skippedCount(flow) })
  } else {
    flow.stage = next
    flow.stages[next].status = 'active'
  }
  persist(flow)
}

/**
 * 评审发现里落在冻结 scope 之外的那些。
 * 升档回退时用它决定回退深度：scope 外的发现重做 S2 也修不了（D4）。
 */
function reviewFindingsOutsideScope(flow) {
  const angles = flow.review?.angles ?? []
  const allowed = flow.scope?.data?.in_scope?.files_expected_to_change ?? []
  const normalizedAllowed = allowed.map((entry) => normalizeTarget(flow.cwd, entry))
  const outside = []
  for (const angle of angles) {
    for (const finding of angle?.findings ?? []) {
      if (finding?.severity === 'MINOR') continue
      if (!finding?.file) continue
      const normalized = normalizeTarget(flow.cwd, finding.file)
      if (!normalizedAllowed.includes(normalized)) {
        outside.push({ file: finding.file, severity: finding.severity, angle: angle?.name ?? angle?.id })
      }
    }
  }
  return outside
}

/** 回退到某一阶段重做；被回退覆盖的阶段重新变为 pending。 */
function rollbackTo(flow, stage, reason) {
  abortChildRun(flow)
  const target = STAGES.indexOf(stage)
  for (let i = target; i < STAGES.length; i += 1) {
    const key = STAGES[i]
    flow.stages[key] = emptyStage()
    if (i === target) flow.stages[key].status = 'active'
  }
  flow.stage = stage
  flow.finished = false
  // 回退意味着代码要重做，之前授予的写权限随之失效（D2 的例外只对当次测试成立）。
  flow.writeGrants = []
  // 被回退覆盖的产物不再作数：旧摘要 / 旧评审 / 旧测试留着，门禁会以为「已经交过」而提前可点。
  flow.gateNote = null
  flow.devChanges = null
  flow.review = null
  flow.test = null
  // 回到 S1 是为了改 scope：旧 scope 必须解冻，否则用户改了文档、S2 却仍按旧白名单放行。
  if (stage === 'S1') {
    flow.scope = { frozen: false, frozenAt: null, data: null, withoutDocApproval: false }
    flow.doc = { html: null, recommendedPreset: null, reason: null, at: null }
  }
  appendEvent(flow.cwd, flow, 'flow.rollback', { to: stage, reason })
  persist(flow)
}

/**
 * 放弃整条流程：用户主动中止，随时可以重新开一条。
 *
 * 与 passGate 走到末阶段的自然结束不同，这里必须把 scope 一起解冻——否则流程
 * 名义上结束了、旧白名单却还在，下一次启动会带着上一轮的范围跑。
 * @param {object} flow
 * @param {string} [reason]
 */
function cancelFlow(flow, reason) {
  abortChildRun(flow)
  flow.finished = true
  flow.cancelled = true
  flow.cancelledAt = nowIso()
  flow.cancelReason = reason && reason.trim() ? reason.trim().slice(0, 200) : '用户放弃这次流程'
  // 放弃那一刻可能还有没答完的追问：留着它，工作台会继续显示一张已经作废的卡片。
  flow.grill.pending = null
  // 放弃之后不该再有任何白名单：旧 scope 不许继续放行写操作。
  flow.scope = { frozen: false, frozenAt: null, data: null, withoutDocApproval: false }
  flow.writeGrants = []
  appendEvent(flow.cwd, flow, 'flow.cancelled', { stage: flow.stage, reason: flow.cancelReason })
  persist(flow)
}

/**
 * 工具层的第一道闸：流程结束后（验收通过或用户放弃）不再受理任何推进。
 *
 * 只有 flowgate_gate 查过 finished，其余工具只查阶段，于是「放弃后 Agent 还在追问
 * 需求」成了真事：状态已经判死，追问却照样弹出卡片、照样能提交文档。
 */
function requireRunning(flow) {
  if (!flow.finished) return
  throw new Error(
    flow.cancelled
      ? '这次流程已被放弃（' + (flow.cancelReason ?? '用户放弃这次流程') + '），不再受理追问或提交。请让用户在工作台重新启动一条流程。'
      : '流程已经结束，不再受理追问或提交。',
  )
}

/**
 * 统一的需求文档决策：不依赖某次工具调用是否还挂在内存里。
 *
 * 文档一提交就写进了流程快照，而「能不能批准」原来只取决于等待器还在不在：
 * 工具调用被中断（执行超时、宿主重启、新门禁取代旧门禁）后等待器消失，界面
 * 退回「门禁未就绪」，文档却还在，用户只能放弃整条流程。这里把决策直接落到
 * 流程状态上，等待器存在时再把同一个结果交给它。
 *
 * @param {object} service
 * @param {object} flow
 * @param {string} sessionId
 * @param {'approve'|'revise'|'skip'} decision
 */
function decideDoc(service, flow, sessionId, decision) {
  if (flow.finished) {
    throw new Error(
      flow.cancelled
        ? '这次流程已被放弃，不能再确认需求文档。'
        : '流程已经结束，不能再确认需求文档。',
    )
  }
  // 幂等：同一份文档只生效一次，重复点击不重复冻结、也不重复推进。
  if (flow.doc?.decision) {
    return {
      decision: flow.doc.decision.kind,
      preset: flow.preset,
      frozen: flow.scope?.frozen === true,
      repeated: true,
    }
  }
  if (flow.stage !== 'S1') throw new Error('需求文档确认只在 S1 阶段，当前阶段是 ' + flow.stage + '。')
  if (!flow.doc?.html) throw new Error('当前还没有提交需求文档。')

  if (decision === 'revise') {
    // 留住「用户点过修改需求」这件事：客户端据此在空态里说明下一步该做什么。
    const at = nowIso()
    flow.doc = {
      html: null,
      recommendedPreset: null,
      reason: null,
      at: null,
      revisedAt: at,
      decision: { kind: 'revise', at },
    }
    appendEvent(flow.cwd, flow, 'doc.revised', {})
    persist(flow)
    return { decision: 'revise', preset: flow.preset, frozen: false, repeated: false }
  }

  const skipped = decision === 'skip'
  const pendingScope = flow.pendingScope ?? {}
  // 批准或跳过都会冻结 scope：跳过只影响需求文档评审，不影响 scope 的冻结。
  const frozen = {
    version: 1,
    frozen_at: nowIso(),
    // PRD 4.1.2：跳过需求文档评审也冻结 scope，但在落盘文件里留下这件事的痕迹。
    scope_frozen_without_doc_approval: skipped,
    in_scope: {
      files_expected_to_change: pendingScope.files_expected_to_change ?? [],
      capabilities: pendingScope.capabilities ?? [],
    },
    out_of_scope_explicitly: pendingScope.out_of_scope_explicitly ?? [],
    acceptance_criteria: pendingScope.acceptance_criteria ?? [],
  }
  flow.scope = {
    frozen: true,
    frozenAt: frozen.frozen_at,
    data: frozen,
    withoutDocApproval: skipped,
  }
  try {
    writeJsonAtomic(join(dataRoot(flow.cwd), 'scope.json'), frozen)
  } catch {
    // 落盘失败不影响内存中的冻结状态。
  }
  // 先记下决策再推进：passGate 内部的 persist 会把这份标记一起写进快照。
  flow.doc = { ...flow.doc, decision: { kind: skipped ? 'skip' : 'approve', at: frozen.frozen_at } }
  appendEvent(flow.cwd, flow, 'scope.frozen', {
    withoutDocApproval: skipped,
    files: frozen.in_scope.files_expected_to_change,
  })
  passGate(flow, skipped ? 'skip' : 'pass')
  return { decision: flow.doc.decision.kind, preset: flow.preset, frozen: true, repeated: false }
}

/**
 * 应用一次门禁决策（S2 / S3 / S4 的出口门禁）。
 *
 * 和需求文档同一套做法：决策先落流程状态，挂着的工具只是「顺带被告知」。
 * 工具调用被中断（超时、宿主重启）后等待器就没了，这时用户的点击仍然有效；
 * 同一阶段重复点击只推进一次。
 *
 * @param {object} service
 * @param {object} flow
 * @param {string} sessionId
 * @param {'pass'|'skip'|'back'} decision
 * @param {string} [to]
 */
function decideGate(service, flow, sessionId, decision, to) {
  if (flow.finished) {
    throw new Error(
      flow.cancelled ? '这次流程已被放弃，不能再确认门禁。' : '流程已经结束，不能再确认门禁。',
    )
  }
  const stage = flow.stage
  if (stage === 'S1') throw new Error('S1 的门禁是需求文档：请在工作台点「批准并冻结 scope」。')
  const record = flow.stages[stage]
  if (record.gate === 'passed' || record.gate === 'skipped') {
    return { decision, stage, next: flow.stage, repeated: true }
  }
  // 有等待中的工具就交给它推进（续体会同步 passGate / rollbackTo），没有就自己推进。
  if (service.gates.notify(sessionId, { decision, to }, 'gate')) {
    return { decision, stage, next: flow.stage, repeated: false, delivered: true }
  }
  if (decision !== 'back' && !gateArtifactReady(flow)) {
    // 产物还没交就点确认，只可能是重复点击或提前点：不许跳过还没做的阶段。
    throw new Error('当前阶段还没有可确认的产物：等 Agent 把 ' + STAGE_LABEL[stage] + ' 的结果交上来再点。')
  }
  if (decision === 'back') {
    rollbackTo(flow, to === 'S1' ? 'S1' : 'S2', 'user')
  } else {
    passGate(flow, decision === 'skip' ? 'skip' : 'pass')
  }
  return { decision, stage, next: flow.stage, repeated: false, delivered: false }
}

/**
 * 当前阶段是否已经交过产物、可以确认门禁。
 * 门禁按钮等产物落地才可用：避免用户提前点掉一个还没做的阶段。
 */
function gateArtifactReady(flow) {
  if (flow.stage === 'S2') return Boolean(flow.devChanges)
  if (flow.stage === 'S3') return Boolean(flow.review)
  if (flow.stage === 'S4') return Boolean(flow.test)
  return false
}


// ---------------------------------------------------------------------------
// scope 守卫
// ---------------------------------------------------------------------------

/**
 * 判断一次写操作是否被允许。
 * @returns {string|null} 拒绝理由；null 表示放行。
 */
function scopeDenial(flow, name, args) {
  if (!flow || flow.finished) return null

  const isWrite = WRITE_TOOLS.has(name)
  const isShell = SHELL_TOOLS.has(name)

  if (isWrite) {
    const target = writeTargetOf(name, args)
    if (target === null) return null
    const normalized = normalizeTarget(flow.cwd, target)
    if (isInsideDataDir(normalized)) return null

    if (flow.stage !== 'S2') {
      return (
        '当前处于 ' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）阶段，不能修改业务代码。' +
        '要先通过 S1 门禁（批准并冻结 scope）进入开发阶段，写操作才会被允许。'
      )
    }
    if (!flow.scope.frozen) {
      return 'scope 尚未冻结，开发阶段的写操作被拒绝。请先回到需求分析阶段点击「批准并冻结 scope」。'
    }
    const allowed = flow.scope.data?.in_scope?.files_expected_to_change ?? []
    const matched = allowed.some((entry) => normalizeTarget(flow.cwd, entry) === normalized)
    if (!matched) {
      return (
        '该文件不在冻结 scope 内：' + normalized + '\n' +
        'scope 声明的文件：' + (allowed.length ? allowed.join('、') : '（空）') + '\n' +
        '要修改它，必须先回到需求分析阶段更新 scope.json 并重新批准。'
      )
    }
    return null
  }

  if (isShell) {
    const command = typeof args?.command === 'string' ? args.command : ''
    if (!SHELL_WRITE_HINTS.test(command)) return null
    if (flow.stage !== 'S2') {
      return (
        '当前处于 ' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）阶段，变更性 shell 被拒绝。' +
        '变更性命令只在 S2 开发阶段可用。'
      )
    }
    // S2 也要拦：shell 命令没法逐条核对 scope，放行等于给 scope 边界开后门。
    return (
      '变更性 shell 无法核对冻结 scope，开发阶段被拒绝：' + command.slice(0, 120) + '\n' +
      '请改用 write / edit 修改 scope 内的文件：' +
      ((flow.scope.data?.in_scope?.files_expected_to_change ?? []).join('、') || '（空）') + '\n' +
      '如果这个命令确实必要，请回到需求分析阶段把要动的文件写进 scope.json 并重新批准。'
    )
  }

  return null
}

/** JSON.parse 与 JavaScript 对象字面量的原型语义必须一致。 */
function unsafeReadonlyArguments(value) {
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) =>
    ['__proto__', 'prototype', 'constructor', 'sandbox_permissions', 'justification',
      'action', 'mode', 'download_path', 'output_path', 'outputPath', 'save_to'].includes(key) ||
    unsafeReadonlyArguments(child),
  )
}

/** 只读子代理默认拒绝未知能力，防止新增工具绕过写工具黑名单。 */
function readonlyDenial(name, args, allowShellWrite = false) {
  const denied = '评审 / 测试子代理是只读的：' + name + ' 未被允许，已由宿主端拒绝。'
  if (name === 'ops_result') {
    const { action, ...pageArgs } = args ?? {}
    if (action !== 'page') return denied
    return unsafeReadonlyArguments(pageArgs) ? denied : null
  }
  if (unsafeReadonlyArguments(args)) return denied + ' 不允许原型、状态变更或提权参数。'
  if (name === 'run_code') {
    // PTC 的任意 JS 可直接 import Node，不能只检查嵌套 tools.*。
    // 仅接收单个工具调用和严格 JSON 参数，不执行/解释其他代码。
    const match = typeof args?.code === 'string'
      ? /^\s*(?:return\s+)?await\s+tools\.([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)\s*;?\s*$/u.exec(args.code)
      : null
    if (!match || match[1] === 'run_code') return denied + ' 仅允许 return await tools.<工具名>(<JSON 参数>)。'
    try {
      const parameters = JSON.parse(match[2])
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return denied
      return readonlyDenial(match[1], parameters, allowShellWrite)
    } catch {
      return denied + ' 工具参数必须是严格 JSON，不能包含其他 JavaScript。'
    }
  }
  if (name === 'working_directory') return args && Object.hasOwn(args, 'cd') ? denied : null
  if (name === 'ops_load_sdk') {
    return Array.isArray(args?.tools) && args.tools.every((tool) => READONLY_OPS_APIS.has(tool)) ? null : denied
  }
  if (READONLY_TOOLS.has(name)) return null
  if (SHELL_TOOLS.has(name)) {
    if (args?.run_in_background) return denied + ' 不能创建脱离 activation 生命周期的后台任务。'
    // D2：只为本次测试方向授权；代码写工具及任意 JS 仍不开放。
    if (allowShellWrite) return null
    const command = typeof args?.command === 'string' ? args.command.trim() : ''
    if (args?.script_path || !command || !/^[A-Za-z0-9_./:@,%=+ -]+$/u.test(command)) return denied
    if (/^pwd$/u.test(command)) return null
    // Git 可能刷新索引、启动 fsmonitor 或执行仓库配置的过滤器，不能仅按子命令判断只读。
    return denied + ' Git、脚本、解释器和测试命令不能被推定为只读；请改用读取工具，或取得该测试方向的明确授权。'
  }
  return denied
}

// ---------------------------------------------------------------------------
// 门禁等待：工具挂起，等用户点按钮
// ---------------------------------------------------------------------------

class GateHub {
  constructor() {
    /** @type {Map<string, {resolve: Function, reject: Function, timer: any, kind: string}>} */
    this.waiters = new Map()
  }

  wait(sessionId, kind, timeoutMs, signal) {
    // 同一会话只允许一个挂起门禁：新的等待先唤醒旧的，否则旧的会永久悬挂。
    const previous = this.waiters.get(sessionId)
    if (previous) previous.resolve({ kind: 'superseded', detail: '被新的门禁等待取代' })
    return new Promise((resolvePromise, rejectPromise) => {
      let timer = null
      let onAbort = null
      /** 只认自己那一条：旧调用的中断不许删掉后来居上的新等待。 */
      const own = () => this.waiters.get(sessionId) === entry
      /** 结算后立刻摘掉计时器与 abort 监听，避免旧信号继续影响后续等待。 */
      const detach = () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (onAbort && signal) {
          signal.removeEventListener('abort', onAbort)
          onAbort = null
        }
      }
      const finish = (value) => {
        if (!own()) return
        this.waiters.delete(sessionId)
        detach()
        resolvePromise(value)
      }
      const entry = { resolve: finish, reject: rejectPromise, kind, timer: null }
      // 先进表，下面的计时器与 abort 回调都靠它判断自己是否仍是当前等待。
      this.waiters.set(sessionId, entry)
      if (timeoutMs > 0) {
        timer = setTimeout(() => finish({ kind: 'timeout', detail: '等待用户操作超时' }), timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
        entry.timer = timer
      }
      if (signal) {
        onAbort = () => finish({ kind: 'aborted', detail: '调用被取消' })
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /** 客户端点击按钮时唤醒挂起的工具。 */
  notify(sessionId, value, expectKind) {
    const entry = this.waiters.get(sessionId)
    if (!entry) return false
    // kind 不匹配时保持挂起：用户点错面板不该把工具唤醒成别的门禁结果。
    if (expectKind !== undefined && entry.kind !== expectKind) return false
    entry.resolve(value)
    return true
  }

  has(sessionId) {
    return this.waiters.has(sessionId)
  }

  /** 当前挂起的门禁类型（'answer' | 'doc' | 'gate'），没有则 null。 */
  kindOf(sessionId) {
    return this.waiters.get(sessionId)?.kind ?? null
  }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 实时进度
// ---------------------------------------------------------------------------

/**
 * 工具名 → 一句用户能看懂的「正在做什么」。
 * 只翻译常见的读写与流程工具，未知工具退化成工具名本身。
 */
const TOOL_ACTIVITY = {
  read: '读取文件',
  read_files: '读取文件',
  ops_read_files: '读取文件',
  ops_inspect_local_file: '查看文件',
  write: '写入文件',
  write_file: '写入文件',
  edit: '修改文件',
  edit_file: '修改文件',
  str_replace_editor: '修改文件',
  ops_edit_file: '修改文件',
  grep: '搜索代码',
  ops_grep: '搜索代码',
  glob: '查找文件',
  ops_glob: '查找文件',
  ops_bash: '执行命令',
  bash: '执行命令',
  run_code: '运行脚本',
  dispatch: '分派任务',
  task: '分派任务',
  flowgate_ask: '整理决策问题',
  flowgate_doc: '撰写需求文档',
  flowgate_gate: '请求阶段门禁',
  flowgate_review: '评审代码',
  flowgate_review_run: '评审代码',
  flowgate_test: '验证测试',
  flowgate_test_run: '验证测试',
}

/** 取第一个非空字符串参数。 */
function pickText() {
  for (let i = 0; i < arguments.length; i += 1) {
    const value = arguments[i]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** 长路径只留末两段，避免把整条绝对路径塞进一行小字。 */
function shortDetail(text, max) {
  const flat = String(text).replace(/\s+/g, ' ')
  const parts = flat.split(/[\\/]/).filter(Boolean)
  const tail = parts.length > 2 ? parts.slice(-2).join('/') : flat
  return tail.length > max ? tail.slice(0, max - 1) + '…' : tail
}

/**
 * 把一次工具执行翻译成工作台能直接显示的「正在进行」摘要。
 * 参数只取路径 / 命令 / 关键字这类可读字段，不上报整段内容。
 */
function activityOf(exec) {
  const name = typeof exec?.name === 'string' ? exec.name : ''
  const args = exec?.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
  const label = TOOL_ACTIVITY[name] ?? (name ? '调用 ' + name : '调用工具')
  const detail = pickText(args.path, args.file_path, args.filePath, args.command, args.pattern, args.query, args.title)
  return {
    tool: name,
    text: detail ? label + '：' + shortDetail(detail, 52) : label,
    at: Date.now(),
  }
}

/** 每个阶段在总进度里的权重：四段等分，读起来最直观。 */
const STAGE_WEIGHT = 25

/**
 * 当前阶段的内部完成度。只看已经发生的事实（文档交没交、代码动没动），
 * 不按时间瞎猜比例——进度条宁可粗一点，也不要骗人。
 */
function stageFraction(flow, stage) {
  if (stage === 'S1') {
    if (flow.doc?.html) return 0.9
    return Math.min(0.75, 0.15 + (flow.grill?.answered?.length ?? 0) * 0.15)
  }
  if (stage === 'S2') return flow.devChanges ? 0.8 : 0.15
  if (stage === 'S3') return flow.review ? 0.85 : 0.1
  if (stage === 'S4') return flow.test ? 0.85 : 0.1
  return 0
}

/** 阶段级进度：已完成阶段满格，当前阶段按内部事实给部分进度。 */
function progressOf(flow) {
  const settled = (s) => flow.stages[s].status === 'passed' || flow.stages[s].status === 'skipped_by_user'
  let percent = 0
  const steps = STAGES.map((s) => {
    if (settled(s)) {
      percent += STAGE_WEIGHT
      return { id: s, label: STAGE_LABEL[s], status: 'done', percent: 100 }
    }
    if (s === flow.stage && !flow.finished) {
      const fraction = stageFraction(flow, s)
      percent += STAGE_WEIGHT * fraction
      return { id: s, label: STAGE_LABEL[s], status: 'active', percent: Math.round(fraction * 100) }
    }
    return { id: s, label: STAGE_LABEL[s], status: 'pending', percent: 0 }
  })
  return {
    // 结束的流程不该停在 99%：正常收尾直接给满，放弃则保留实际进度。
    percent: flow.cancelled ? Math.round(percent) : flow.finished ? 100 : Math.max(0, Math.min(99, Math.round(percent))),
    stageIndex: Math.max(0, STAGES.indexOf(flow.stage)),
    label: STAGE_LABEL[flow.stage] ?? '',
    steps,
  }
}
class WorkbenchService {
  constructor(ctx) {
    this.ctx = ctx
    this.flows = new Map()
    this.gates = new GateHub()
    this.loaded = new Set()
    /** 界面启动的唤醒结果：只放内存，不写进快照（重启后不该还提示上次的失败）。 */
    this.nudges = new Map()
    /** 子代理会话 → 拥有它的流程会话。评审/测试子代理在这里登记为只读。 */
    this.childOwner = new Map()
    this.childRuns = new Map()
    this.readonlyGuardReady = false
    /** 会话 → 最近一次工具动作：只放内存，给工作台显示「正在做什么」。 */
    this.activity = new Map()
    /** cwd → 工作区配置（null 表示这份工作区没有 config.json）。 */
    this.workspaces = new Map()
    this.workspaceSignatures = new Map()
  }

  /** 登记一个只读子代理会话；allowShellWrite 承载 D2 的写权限例外。 */
  registerChild(parentSessionId, childSessionId, policy) {
    this.childOwner.set(childSessionId, {
      parent: parentSessionId,
      allowShellWrite: policy?.allowShellWrite === true,
      flowId: policy?.flowId,
      directionId: policy?.directionId,
      signal: policy?.signal,
    })
  }

  /** 最终守卫与 pre-execute 使用同一规则；放弃/回退后仍保护未释放会话。 */
  childDenial(exec) {
    const policy = this.childPolicyOf(sessionIdOf(exec))
    if (!policy) return null
    const flow = this.get(policy.parent)
    const allowShellWrite = policy.allowShellWrite && !policy.signal?.aborted && !flow?.finished &&
      flow?.id === policy.flowId && flow?.stage === 'S4' &&
      (flow.writeGrants ?? []).includes(policy.directionId)
    return readonlyDenial(exec.name, exec.arguments, allowShellWrite)
  }

  unregisterChild(childSessionId) {
    this.childOwner.delete(childSessionId)
  }

  /** 子代理会话的归属与权限；不是子会话时返回 null。 */
  childPolicyOf(sessionId) {
    return this.childOwner.get(sessionId) ?? null
  }

  /** 记下这个会话最近一次工具动作；阶段一起存，好让界面只显示当前阶段的动作。 */
  noteActivity(sessionId, exec, stage) {
    this.activity.set(sessionId, { ...activityOf(exec), stage })
  }

  /** Agent 空闲或流程结束时清掉：留着「正在执行命令」会让人以为还在跑。 */
  clearActivity(sessionId) {
    this.activity.delete(sessionId)
  }

  /** 会话 → 它所属的流程会话（子代理会话归到父流程）。 */
  ownerOf(sessionId) {
    return this.childOwner.get(sessionId)?.parent ?? sessionId
  }

  /** 按 cwd 惰性加载磁盘上的流程快照。 */
  hydrate(cwd) {
    if (this.loaded.has(cwd)) return
    this.loaded.add(cwd)
    for (const flow of loadFlowsFromDisk(cwd)) {
      if (!flow.finished && !this.flows.has(flow.sessionId)) {
        this.flows.set(flow.sessionId, flow)
      }
    }
  }

  get(sessionId) {
    return this.flows.get(sessionId) ?? null
  }

  require(sessionId) {
    const flow = this.flows.get(sessionId)
    if (!flow) throw new Error('当前会话还没有流程。先调用 flowgate_start 启动四阶段流程。')
    return flow
  }

  start(sessionId, cwd, title, preset, brief) {
    this.hydrate(cwd)
    const existing = this.flows.get(sessionId)
    if (existing && !existing.finished) return existing
    const flow = createFlow({ sessionId, cwd, title, preset, brief })
    flow.stages.S1.status = 'active'
    this.flows.set(sessionId, flow)
    appendEvent(cwd, flow, 'flow.started', { preset: flow.preset, title: flow.title })
    persist(flow)
    return flow
  }

  /** 配置仅在文件签名变化时重新解析；Hub 保存后立即供本服务的新流程继承。 */
  workspaceOf(cwd) {
    if (!cwd) return null
    cwd = resolve(cwd)
    const signature = fileSignature(workspaceConfigFile(cwd))
    if (this.workspaces.has(cwd) && this.workspaceSignatures.get(cwd) === signature) return this.workspaces.get(cwd)
    const config = loadWorkspaceConfig(cwd)
    this.workspaces.set(cwd, config)
    this.workspaceSignatures.set(cwd, signature)
    return config
  }

  /** 写入工作区默认规则；传 null 表示清除，回到内置默认。 */
  setWorkspaceRules(cwd, rules) {
    cwd = resolve(cwd)
    if (!rules) {
      const file = workspaceConfigFile(cwd)
      try {
        unlinkSync(file)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      this.workspaces.set(cwd, null)
      this.workspaceSignatures.set(cwd, null)
      return null
    }
    const config = saveWorkspaceConfig(cwd, {
      version: WORKSPACE_CONFIG_VERSION,
      updatedAt: nowIso(),
      rules,
    })
    this.workspaces.set(cwd, config)
    this.workspaceSignatures.set(cwd, fileSignature(workspaceConfigFile(cwd)))
    return config
  }

  /** 客户端可见的视图（不含内部等待器等）。 */
  view(sessionId) {
    const flow = this.flows.get(sessionId)
    if (!flow) {
      return { active: false, presets: PRESETS, builtinAngles: BUILTIN_ANGLES, builtinDirections: BUILTIN_DIRECTIONS }
    }
    // 门禁同样与等待器解耦：产物已交、还没决策就可确认，中断也不影响按钮。
    const gatePending =
      !flow.finished && gateArtifactReady(flow) && flow.stages[flow.stage]?.gate === 'pending'
    const workspace = this.workspaceOf(flow.cwd)
    return {
      active: true,
      id: flow.id,
      title: flow.title,
      brief: flow.brief ?? '',
      stage: flow.stage,
      finished: flow.finished,
      preset: flow.preset,
      presetInfo: PRESETS[flow.preset],
      presets: PRESETS,
      stages: STAGES.map((s) => ({
        id: s,
        label: STAGE_LABEL[s],
        output: STAGE_OUTPUT[s],
        status: flow.stages[s].status,
        skipped: flow.stages[s].skipped,
      })),
      skippedCount: skippedCount(flow),
      scope: flow.scope,
      // 文档已提交且流程未结束就是待批准：不再取决于某次工具调用是否还挂在内存里。
      // 界面靠 pending 决定显示按钮，靠 interrupted 说明「入口曾中断但仍可确认」。
      doc: {
        ...flow.doc,
        pending: !flow.finished && Boolean(flow.doc?.html) && !flow.doc?.decision,
        interrupted: !flow.finished && Boolean(flow.doc?.html) && !this.gates.has(sessionId),
      },
      gate: {
        pending: gatePending,
        interrupted:
          gatePending && !this.gates.has(sessionId) && flow.stages[flow.stage]?.gateRequested === true,
      },
      grill: {
        pending: flow.finished ? null : flow.grill.pending,
        answeredCount: flow.grill.answered.length,
        awaiting: !flow.finished && this.gates.kindOf(sessionId) === 'answer',
      },
      angles: resolveAngles(flow),
      angleCatalog: angleCatalog(flow),
      // PRD 4.5：开发规则清单，S2 主区与设置面板都读这两项。
      rules: resolveRules(flow, workspace),
      ruleIds: activeRules(flow, workspace),
      ruleCatalog: ruleCatalog(flow, workspace),
      /** 规则从哪来：本次流程临时改过 / 跟工作区默认 / 内置默认（界面必须标出来）。 */
      ruleSource: ruleSourceOf(flow, workspace),
      /** 工作区默认规则：路径、是否已配置、保存的是哪一套（null 表示没有 ids 覆盖）。 */
      workspaceRules: {
        file: workspaceConfigLabel(),
        configured: Boolean(workspace?.rules?.ids) || (workspace?.rules?.custom ?? []).length > 0,
        ruleIds: workspace?.rules?.ids ?? null,
        customCount: (workspace?.rules?.custom ?? []).length,
        updatedAt: workspace?.updatedAt ?? null,
      },
      directions: resolveDirections(flow).map((direction) => ({
        ...direction,
        writeGranted: (flow.writeGrants ?? []).includes(direction.id),
      })),
      directionCatalog: directionCatalog(flow),
      writeGrants: (flow.writeGrants ?? []).slice(),
      review: flow.review,
      // 评审发现里落在 scope 外的部分：客户端据此提示「这些得回 S1 调 scope」。
      reviewOutsideScope: flow.review ? reviewFindingsOutsideScope(flow) : [],
      test: flow.test,
      devChanges: flow.devChanges,
      waiting: this.gates.has(sessionId),
      waitingKind: this.gates.kindOf(sessionId),
      /** 界面启动时是否成功把需求投递给 Agent；null 表示不是界面启动。 */
      nudge: this.nudges.get(sessionId) ?? null,
      cancelled: Boolean(flow.cancelled),
      cancelledAt: flow.cancelledAt ?? null,
      cancelReason: flow.cancelReason ?? null,
      canSpawn: subagentCapability(this.ctx, this.readonlyGuardReady).available,
      // 阶段进度 + 正在进行的那一步：客户端每 1.5 秒拉一次，不用额外的推送通道。
      progress: progressOf(flow),
      activity: (() => {
        const live = this.activity.get(sessionId)
        if (!live || flow.finished || live.stage !== flow.stage) return null
        return { tool: live.tool, text: live.text, elapsedMs: Math.max(0, Date.now() - live.at) }
      })(),
      /** 从启动到现在的时间：界面用它显示「已用 1 分 20 秒」。 */
      elapsedMs: (() => {
        const started = Date.parse(flow.createdAt)
        return Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0
      })(),
      createdAt: flow.createdAt,
      updatedAt: flow.updatedAt,
    }
  }
}


// ---------------------------------------------------------------------------
// 会话上下文
// ---------------------------------------------------------------------------

async function sessionOf(scoped, exec) {
  const agent = exec?.agent ?? null
  const header = agent?.session?.header ?? null
  let cwd = header && typeof header.cwd === 'string' ? header.cwd : null
  if (!cwd && agent && scoped.workingDirectory) {
    try {
      cwd = await scoped.workingDirectory.ensure(agent, exec.signal)
    } catch {
      cwd = null
    }
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('无法确定当前会话的工作目录，流程无法启动。')
  }
  const sessionId = header && typeof header.id === 'string' ? header.id : null
  if (!sessionId) throw new Error('当前会话没有 id，流程无法绑定。')
  return { agent, header, sessionId, cwd }
}

const textOut = (text) => [{ type: 'text', text }]

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function statusTool(scoped) {
  return {
    name: 'flowgate_status',
    description: [
      '读取当前会话的四阶段流程状态：阶段、门禁、预设档位、冻结的 scope、评审/测试进度。',
      '每次接手任务、或被门禁拒绝后，先调用它确认自己处于哪个阶段。',
    ].join(''),
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          active: { type: 'boolean' },
          stage: { type: 'string' },
          stageLabel: { type: 'string' },
          finished: { type: 'boolean' },
          preset: { type: 'string' },
          scopeFrozen: { type: 'boolean' },
          skippedCount: { type: 'number' },
          summary: { type: 'string' },
        },
        required: ['active', 'stage', 'stageLabel', 'finished', 'preset', 'scopeFrozen', 'skippedCount', 'summary'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textOut(value.summary)
      },
    },
    async execute(_args, exec) {
      const { sessionId, cwd } = await sessionOf(scoped, exec)
      SERVICE.hydrate(cwd)
      const flow = SERVICE.get(sessionId)
      const workspace = SERVICE.workspaceOf(cwd)
      if (!flow) {
        return {
          active: false,
          stage: '-',
          stageLabel: '未启动',
          finished: false,
          preset: '-',
          scopeFrozen: false,
          skippedCount: 0,
          summary: '当前会话还没有流程。调用 flowgate_start 启动四阶段流程（需求分析 → 开发 → 评审 → 测试）。',
        }
      }
      const lines = [
        '流程：' + flow.title,
        ...(flow.brief ? ['需求描述：' + flow.brief] : []),
        '当前阶段：' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）',
        '档位：' + PRESETS[flow.preset].label,
        'scope：' + (flow.scope.frozen ? '已冻结（' + (flow.scope.data?.in_scope?.files_expected_to_change ?? []).length + ' 个文件）' : '未冻结'),
      ]
      if (flow.finished) lines.push('状态：流程已结束')
      const skipped = skippedCount(flow)
      if (skipped > 0) lines.push('本流程有 ' + skipped + ' 个阶段被用户跳过')
      if (flow.stage === 'S2') {
        const rules = resolveRules(flow, workspace)
        if (rules.length) {
          lines.push('开发规则检查清单（来源：' + RULE_SOURCE_LABEL[ruleSourceOf(flow, workspace)] + '；逐条遵守，S3 会逐条核对）：')
          for (const rule of rules) lines.push('- ' + rule.name + '：' + (rule.points ?? []).join('；'))
        }
      }
      if (flow.stage === 'S3') {
        lines.push('评审角度：' + resolveAngles(flow).map((a) => a.name).join('、'))
      }
      if (flow.stage === 'S4') {
        lines.push('测试方向：' + resolveDirections(flow).map((d) => d.name).join('、'))
      }
      return {
        active: true,
        stage: flow.stage,
        stageLabel: STAGE_LABEL[flow.stage],
        finished: flow.finished,
        preset: flow.preset,
        scopeFrozen: flow.scope.frozen,
        skippedCount: skipped,
        summary: lines.join('\n'),
      }
    },
  }
}

function startTool(scoped) {
  return {
    name: 'flowgate_start',
    description: [
      '启动四阶段流程约束工作台：需求分析 → 开发 → 评审 → 测试。',
      '启动后由用户在工作台里点按钮推进门禁；开发阶段只能修改 scope.json 声明的文件。',
      '用户也可以在工作台界面直接一键启动，这时不需要调用本工具。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '这次任务的简短标题，可省略（省略时由需求描述派生，再退化为「未命名任务」）。' },
        brief: {
          type: 'string',
          description: '用户的需求描述原文。界面一键启动时由用户填写；Agent 代启动时可以转述用户的原话。',
        },
        preset: {
          type: 'string',
          enum: ['fast', 'strict'],
          description: '执行档位：fast=小功能快速开发（默认），strict=大需求严格执行。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          flowId: { type: 'string' },
          stage: { type: 'string' },
          preset: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['flowId', 'stage', 'preset', 'message'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textOut(value.message)
      },
    },
    async execute(args, exec) {
      const { sessionId, cwd } = await sessionOf(scoped, exec)
      const flow = SERVICE.start(sessionId, cwd, args.title, args.preset, args.brief)
      return {
        flowId: flow.id,
        stage: flow.stage,
        preset: flow.preset,
        message:
          '流程已启动（' + PRESETS[flow.preset].label + '），当前 S1 需求分析。' +
          '接下来用 flowgate_ask 一次问一个决策问题，问完后用 flowgate_doc 提交需求文档与 scope。' +
          'S1 只是这条流程的起点：文档获批后直接继续 S2 开发，不要在阶段交界处停下来等用户再说一句。',
      }
    },
  }
}

function askTool(scoped) {
  return {
    name: 'flowgate_ask',
    description: [
      '在工作台里提出一个决策问题，等用户在卡片上点选后返回答案。',
      '纪律：一次只问一个问题；只问代码或已有资料回答不了的问题；推荐答案必须排在第一位。',
      '2–4 个选项，每个都带一句权衡说明。用户也可以点「自定义」输入。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问题本身，一句话。' },
        context: { type: 'string', description: '为什么需要问：一句话说明这个决策影响什么。' },
        options: {
          type: 'array',
          description: '2–4 个选项，推荐项必须放第一个。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '选项标题。' },
              tradeoff: { type: 'string', description: '一句权衡说明。' },
            },
            required: ['label', 'tradeoff'],
            additionalProperties: false,
          },
        },
        recommended: { type: 'number', description: '推荐选项的下标（从 0 开始，通常为 0）。' },
        allowCustom: { type: 'boolean', description: '是否允许用户自定义输入，默认 true。' },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          answered: { type: 'boolean' },
          choice: { type: 'string' },
          custom: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['answered', 'choice', 'custom', 'reason'],
        additionalProperties: false,
      },
      render(_args, value) {
        if (!value.answered) return textOut('用户没有回答这个问题（' + value.reason + '）。流程停在 S1，不要自行假设答案。')
        const picked = value.custom ? value.custom : value.choice
        return textOut('用户选择了：' + picked)
      },
    },
    async execute(args, exec) {
      const { sessionId, cwd } = await sessionOf(scoped, exec)
      const service = SERVICE
      service.hydrate(cwd)
      const flow = service.require(sessionId)
      requireRunning(flow)
      if (flow.stage !== 'S1') {
        throw new Error('追问只在 S1 需求分析阶段进行，当前阶段是 ' + flow.stage + '。')
      }
      const options = Array.isArray(args.options) ? args.options.slice(0, 4) : []
      if (options.length < 2) throw new Error('至少给出 2 个选项。')
      const pending = {
        id: 'q_' + randomUUID().slice(0, 8),
        question: args.question,
        context: args.context ?? '',
        options,
        recommended: typeof args.recommended === 'number' ? args.recommended : 0,
        allowCustom: args.allowCustom !== false,
        at: nowIso(),
      }
      flow.grill.pending = pending
      persist(flow)
      appendEvent(cwd, flow, 'grill.asked', { questionId: pending.id, question: pending.question })

      const outcome = await service.gates.wait(sessionId, 'answer', 0, exec.signal)
      if (outcome.kind !== 'answer') {
        flow.grill.pending = null
        persist(flow)
        // 放弃流程也是一种「结束等待」：文案要说清楚，别让 Agent 以为只是超时重试。
        const reason = outcome.kind === 'cancelled'
          ? '用户放弃了这次流程，追问作废。'
          : (outcome.detail ?? '未回答')
        return { answered: false, choice: '', custom: '', reason }
      }
      flow.grill.pending = null
      flow.grill.answered.push({
        questionId: pending.id,
        question: pending.question,
        choiceIndex: outcome.choiceIndex,
        choice: options[outcome.choiceIndex]?.label ?? '',
        custom: outcome.customText ?? '',
        at: nowIso(),
      })
      appendEvent(cwd, flow, 'grill.answered', {
        questionId: pending.id,
        choiceIndex: outcome.choiceIndex,
        custom: outcome.customText ?? '',
      })
      persist(flow)
      return {
        answered: true,
        choice: options[outcome.choiceIndex]?.label ?? '',
        custom: outcome.customText ?? '',
        reason: '',
      }
    },
  }
}

function docTool(scoped) {
  return {
    name: 'flowgate_doc',
    description: [
      '提交 S1 的产出：自包含单文件 HTML 需求文档 + scope.json 等价内容 + 推荐档位。',
      '提交后工作台会显示只读预览，用户点「批准并冻结 scope」才进入开发阶段。',
      'HTML 必须自包含（内联样式、无外链），包含目标、in-scope/out-of-scope、验收标准表格。',
      '预览是视口内渲染，宽度会自适应桌面与平板：用相对宽度（百分比 / max-width）排版，不要写死像素宽度。',
      '预览区域是透明底，会跟随用户的明暗主题：文档自己写死白底会在深色主题下变成刺眼白块，建议用 color-scheme: light dark 并同时给出深色配色，或干脆不写背景色。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        html: { type: 'string', description: '自包含单文件 HTML 全文（内联样式、无外链、相对宽度自适应）。' },
        recommendedPreset: {
          type: 'string',
          enum: ['fast', 'strict'],
          description: '推荐档位。',
        },
        reason: { type: 'string', description: '一句话说明为什么推荐这个档位。' },
        scope: {
          type: 'object',
          description: 'scope.json 等价内容。',
          properties: {
            files_expected_to_change: {
              type: 'array',
              items: { type: 'string' },
              description: '开发阶段允许修改的文件（相对项目根，posix 路径）。',
            },
            capabilities: { type: 'array', items: { type: 'string' } },
            out_of_scope_explicitly: { type: 'array', items: { type: 'string' } },
            acceptance_criteria: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  when: { type: 'string' },
                  then: { type: 'string' },
                },
                required: ['id', 'when', 'then'],
                additionalProperties: false,
              },
            },
          },
          required: ['files_expected_to_change', 'capabilities', 'out_of_scope_explicitly', 'acceptance_criteria'],
          additionalProperties: false,
        },
      },
      required: ['html', 'scope'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          decision: { type: 'string' },
          preset: { type: 'string' },
          frozen: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['decision', 'preset', 'frozen', 'message'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textOut(value.message)
      },
    },
    async execute(args, exec) {
      const { sessionId, cwd } = await sessionOf(scoped, exec)
      const service = SERVICE
      service.hydrate(cwd)
      const flow = service.require(sessionId)
      requireRunning(flow)
      if (flow.stage !== 'S1') throw new Error('需求文档只在 S1 阶段提交，当前阶段是 ' + flow.stage + '。')

      flow.doc = {
        html: args.html,
        recommendedPreset: args.recommendedPreset ?? flow.preset,
        reason: args.reason ?? '',
        at: nowIso(),
        // 用户决策后写在这里：工具调用中断也不影响这份文档还能被确认。
        decision: null,
      }
      flow.pendingScope = args.scope
      appendEvent(cwd, flow, 'doc.submitted', {
        recommendedPreset: flow.doc.recommendedPreset,
        files: args.scope?.files_expected_to_change ?? [],
      })
      persist(flow)

      const outcome = await service.gates.wait(sessionId, 'doc', 0, exec.signal)
      if (outcome.kind === 'cancelled') {
        return {
          decision: 'cancelled',
          preset: flow.preset,
          frozen: false,
          message: '用户放弃了这次流程，需求文档没有批准，scope 没有冻结。',
        }
      }
      if (outcome.kind === 'aborted' || outcome.kind === 'superseded' || outcome.kind === 'timeout') {
        // 等待没了不等于文档作废：文档已经落盘，用户仍可在工作台确认。
        return {
          decision: 'pending',
          preset: flow.preset,
          frozen: false,
          message:
            '这次等待被中断（工具调用超时、宿主重启或被新的门禁取代），需求文档已保留。' +
            '用户仍可在工作台点「批准并冻结 scope」；确认后读取 flowgate_status 就能看到最新阶段。',
        }
      }

      const result = decideDoc(
        service,
        flow,
        sessionId,
        outcome.kind === 'revise' ? 'revise' : outcome.kind,
      )
      if (result.decision === 'revise') {
        return {
          decision: 'revise',
          preset: flow.preset,
          frozen: false,
          message: '用户要求修改需求。补齐未决项后重新用 flowgate_ask 追问，再重新提交 flowgate_doc。',
        }
      }
      return {
        decision: result.decision,
        preset: flow.preset,
        frozen: result.frozen,
        message:
          'scope 已冻结，进入 S2 开发阶段。只能修改：' +
          (flow.scope?.data?.in_scope?.files_expected_to_change?.join('、') || '（scope 未声明文件）') +
          '。现在直接开始 S2：先读这些文件再改，完成后调用 flowgate_gate 等待用户点「完成开发」；' +
          '不要停下来等用户再确认一次。',
      }
    },
  }
}

function gateTool(scoped) {
  return {
    name: 'flowgate_gate',
    description: [
      '在当前阶段的出口门禁处挂起，等用户在工作台点按钮。',
      'S2 会等到「完成开发」或「跳过」；返回值告诉流程下一步走向。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '给用户看的一句话：本阶段做了什么，门禁在等什么。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          decision: { type: 'string' },
          stage: { type: 'string' },
          next: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['decision', 'stage', 'next', 'message'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textOut(value.message)
      },
    },
    async execute(args, exec) {
      const { sessionId, cwd } = await sessionOf(scoped, exec)
      const service = SERVICE
      service.hydrate(cwd)
      const flow = service.require(sessionId)
      requireRunning(flow)
      const stage = flow.stage

      if (stage === 'S2') {
        const changes = await collectChanges(scoped, flow)
        flow.devChanges = changes
        appendEvent(cwd, flow, 'dev.summary', changes)
        persist(flow)
      }
      if (args.summary) flow.gateNote = args.summary
      markGateRequested(flow)

      const outcome = await service.gates.wait(sessionId, 'gate', 0, exec.signal)
      if (outcome.kind === 'timeout' || outcome.kind === 'aborted') {
        return { decision: 'wait', stage, next: stage, message: '门禁还在等待用户操作。' }
      }
      const decision = outcome.decision
      if (decision === 'cancelled') {
        return {
          decision,
          stage,
          next: 'cancelled',
          message: '用户放弃了这次流程。停止推进阶段，等用户在工作台里重新开始一条新流程。',
        }
      }
      if (decision === 'pass' || decision === 'skip') {
        passGate(flow, decision === 'skip' ? 'skip' : 'pass')
        const next = flow.finished ? '结束' : flow.stage
        return {
          decision,
          stage,
          next,
          message:
            (decision === 'skip' ? '用户跳过了本阶段门禁。' : '用户通过了本阶段门禁。') +
            (flow.finished
              ? '流程已结束，不需要再推进阶段。'
              : '进入 ' + next + '（' + STAGE_LABEL[next] + '）。现在直接开始 ' + next + ' 的工作，' +
                '不要在阶段交界处停下等用户再说一句。'),
        }
      }
      if (decision === 'back') {
        rollbackTo(flow, outcome.to ?? 'S2', 'user')
        return {
          decision,
          stage,
          next: flow.stage,
          message: '用户退回到 ' + flow.stage + ' 重做。',
        }
      }
      return { decision, stage, next: stage, message: '门禁结果：' + decision }
    },
  }
}

const execFileAsync = promisify(execFile)

/**
 * 用 node:child_process 直接跑只读 git 命令。
 * 有些 profile 装的是替代 shell 插件（例如 dsh-ops 提供 ops_bash 并退掉官方的 shell 行），
 * 宿主就没有 'shell' 服务可用——这时不能直接放弃采集。
 */
async function gitSummaryText(cwd) {
  const options = { cwd, timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
  const status = await execFileAsync('git', ['status', '--porcelain=v1'], options)
  const numstat = await execFileAsync('git', ['diff', '--numstat'], options)
  return String(status.stdout ?? '') + '\n---numstat---\n' + String(numstat.stdout ?? '')
}

/** 解析 git status --porcelain=v1 与 git diff --numstat 的输出。 */
function parseChanges(text, at) {
  const files = []
  const untracked = []
  let added = 0
  let removed = 0
  let inNumstat = false
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '---numstat---') { inNumstat = true; continue }
    if (!inNumstat) {
      // porcelain：XY path。未跟踪是 '??'，新文件在开发阶段很常见。
      const status = line.slice(0, 2)
      const path = line.slice(3).trim()
      if (!path) continue
      if (status === '??') untracked.push(path)
      else files.push(path)
      continue
    }
    const numstat = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (numstat) {
      added += numstat[1] === '-' ? 0 : Number(numstat[1])
      removed += numstat[2] === '-' ? 0 : Number(numstat[2])
    }
  }
  return { files: files.concat(untracked), tracked: files, untracked, added, removed, at }
}

/**
 * 采集 S2 的变更摘要（文件列表 + 行数），作为门禁凭据。
 * 优先用宿主 shell 服务（走沙箱策略）；没有就走 child_process 直接跑 git。
 * 两条路都拿不到就把原因写进摘要——采集不到不等于没有变更，不能让评审误以为没改动。
 */
async function collectChanges(scoped, flow) {
  const at = nowIso()
  const empty = { files: [], added: 0, removed: 0, untracked: [], at }
  const shell = scoped.get('shell')
  let text = null
  let shellError = null
  if (shell && typeof shell.run === 'function' && typeof shell.resolve === 'function') {
    try {
      const result = await shell.run(shell.resolve({
        command: 'git status --porcelain=v1 && echo "---numstat---" && git diff --numstat',
        workdir: flow.cwd,
        timeoutMs: 10000,
      }))
      text = typeof result === 'string' ? result : result?.stdout?.text ?? ''
    } catch (error) {
      shellError = error?.message ?? String(error)
    }
  }
  if (text === null) {
    try {
      text = await gitSummaryText(flow.cwd)
    } catch (error) {
      const reason = error?.message ?? String(error)
      return {
        ...empty,
        error:
          '无法自动采集变更摘要：' + reason +
          (shellError ? '（宿主 shell 服务同样不可用：' + shellError + '）' : '') +
          '。评审时需要人工确认改动范围。',
      }
    }
  }
  return { ...parseChanges(text, at), via: shell && !shellError ? 'shell' : 'child_process' }
}

function reviewTool(scoped) {
  return {
    name: 'flowgate_review',
    description: [
      '提交 S3 评审报告，然后挂起等待用户点「通过评审」或「退回开发修复」。',
      '每个启用角度一节；每条发现必须带 file:line 与 severity（CRITICAL/MAJOR/MINOR）。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        angles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              verdict: { type: 'string', enum: ['pass', 'blocking', 'advisory'] },
              suggestUpgrade: { type: 'boolean' },
              findings: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    file: { type: 'string' },
                    line: { type: 'number' },
                    severity: { type: 'string', enum: ['CRITICAL', 'MAJOR', 'MINOR'] },
                    summary: { type: 'string' },
                  },
                  required: ['file', 'severity', 'summary'],
                  additionalProperties: false,
                },
              },
            },
            required: ['id', 'name', 'verdict', 'findings'],
            additionalProperties: false,
          },
        },
      },
      required: ['angles'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          decision: { type: 'string' },
          next: { type: 'string' },
          blocking: { type: 'number' },
          message: { type: 'string' },
        },
        required: ['decision', 'next', 'blocking', 'message'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textOut(value.message)
      },
    },
    async execute(args, exec) {
      const { sessionId, cwd } = await sessionOf(scoped, exec)
      const service = SERVICE
      service.hydrate(cwd)
      const flow = service.require(sessionId)
      requireRunning(flow)
      if (flow.stage !== 'S3') throw new Error('评审报告只在 S3 阶段提交，当前阶段是 ' + flow.stage + '。')

      const angles = Array.isArray(args.angles) ? args.angles : []
      const blocking = angles.reduce(
        (sum, a) => sum + (a.findings ?? []).filter((f) => f.severity !== 'MINOR').length,
        0,
      )
      flow.review = { angles, blocking, at: nowIso() }
      appendEvent(cwd, flow, 'review.submitted', { angles: angles.length, blocking })
      persist(flow)

      return waitReviewGate(service, flow, sessionId, exec, blocking)
    },
  }
}

/** S3 出口门禁：等用户点「通过评审」/「退回开发修复」。 */
async function waitReviewGate(service, flow, sessionId, exec, blocking) {
  markGateRequested(flow)
  const outcome = await service.gates.wait(sessionId, 'gate', 0, exec.signal)
  const decision = decisionOf(outcome)
  if (decision === 'wait') {
    return { decision, next: flow.stage, blocking, message: '门禁还在等待用户操作。' }
  }
  if (decision === 'cancelled') {
    return { decision, next: 'cancelled', blocking, message: '用户放弃了这次流程，评审结果作废。' }
  }
  if (decision === 'pass') {
    passGate(flow, 'pass')
    return {
      decision,
      next: flow.stage,
      blocking,
      message: '评审通过，进入 S4 测试阶段。现在直接开始 S4 测试，不要在阶段交界处停下等用户再说一句。',
    }
  }
  if (decision === 'skip') {
    passGate(flow, 'skip')
    return {
      decision,
      next: flow.stage,
      blocking,
      message: '用户跳过了评审门禁，进入 ' + flow.stage + '。现在直接开始该阶段的工作，不要在阶段交界处停下等用户再说一句。',
    }
  }
  if (decision === 'back') {
    rollbackTo(flow, 'S2', 'review-rejected')
    return {
      decision: 'reject',
      next: flow.stage,
      blocking,
      message: '用户退回到 S2 开发修复。评审发现已作为重做输入。',
    }
  }
  return {
    decision,
    next: flow.stage,
    blocking,
    // 回退深度由 D4 决定（可能 S1 也可能 S2），文案跟着实际目标走，别写死。
    message: decision === 'interrupted'
      ? '用户升档到严格执行并回退到 ' + flow.stage + ' 重做，评审发现已作为重做输入。'
      : '门禁结果：' + decision,
  }
}

function testTool(scoped) {
  return {
    name: 'flowgate_test',
    description: [
      '提交 S4 测试报告，然后挂起等待用户点「验收通过」或「退回开发修复」。',
      '按测试方向分组，每个验证要点给出 通过 / 失败 / 未覆盖。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        directions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              points: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    point: { type: 'string' },
                    result: { type: 'string', enum: ['pass', 'fail', 'uncovered'] },
                    detail: { type: 'string' },
                  },
                  required: ['point', 'result'],
                  additionalProperties: false,
                },
              },
            },
            required: ['id', 'name', 'points'],
            additionalProperties: false,
          },
        },
      },
      required: ['directions'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          decision: { type: 'string' },
          next: { type: 'string' },
          failed: { type: 'number' },
          message: { type: 'string' },
        },
        required: ['decision', 'next', 'failed', 'message'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textOut(value.message)
      },
    },
    async execute(args, exec) {
      const { sessionId, cwd } = await sessionOf(scoped, exec)
      const service = SERVICE
      service.hydrate(cwd)
      const flow = service.require(sessionId)
      requireRunning(flow)
      if (flow.stage !== 'S4') throw new Error('测试报告只在 S4 阶段提交，当前阶段是 ' + flow.stage + '。')

      const directions = Array.isArray(args.directions) ? args.directions : []
      const failed = directions.reduce(
        (sum, d) => sum + (d.points ?? []).filter((p) => p.result === 'fail').length,
        0,
      )
      flow.test = { directions, failed, at: nowIso() }
      appendEvent(cwd, flow, 'test.submitted', { directions: directions.length, failed })
      persist(flow)

      return waitTestGate(service, flow, sessionId, exec, failed)
    },
  }
}

/** S4 出口门禁：等用户点「验收通过」/「退回开发修复」。 */
async function waitTestGate(service, flow, sessionId, exec, failed) {
  markGateRequested(flow)
  const outcome = await service.gates.wait(sessionId, 'gate', 0, exec.signal)
  const decision = decisionOf(outcome)
  if (decision === 'wait') {
    return { decision, next: flow.stage, failed, message: '门禁还在等待用户操作。' }
  }
  if (decision === 'cancelled') {
    return { decision, next: 'cancelled', failed, message: '用户放弃了这次流程，测试结果作废。' }
  }
  if (decision === 'pass') {
    passGate(flow, 'pass')
    return { decision, next: 'done', failed, message: '验收通过，流程结束。完整记录已写入 flows.jsonl。' }
  }
  if (decision === 'skip') {
    passGate(flow, 'skip')
    return { decision, next: 'done', failed, message: '用户跳过验收门禁，流程结束。' }
  }
  if (decision === 'back') {
    rollbackTo(flow, 'S2', 'test-rejected')
    return { decision: 'reject', next: flow.stage, failed, message: '用户退回到 S2 修复。' }
  }
  return { decision, next: flow.stage, failed, message: '门禁结果：' + decision }
}

/**
 * 放弃当前流程。用户在工作台点「放弃这次流程」，或 Agent 判断需求已被取消时调用。
 * 宿主会把挂起的门禁工具一起叫醒，所以不会有人等一个永远不会来的按钮。
 */
function cancelTool(scoped) {
  return {
    name: 'flowgate_cancel',
    description: [
      '放弃当前会话里正在进行的四阶段流程。',
      '流程标记为已放弃、解冻 scope、写一条 flow.cancelled 审计事件；之后可以重新启动新流程。',
      '用户在工作台门禁面板点「放弃这次流程」时不需要调用本工具，那是同一件事的界面入口。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '放弃的原因；会写进 flows.jsonl 的审计事件。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          cancelled: { type: 'boolean' },
          flowId: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['cancelled', 'flowId', 'message'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textOut(value.message)
      },
    },
    async execute(args, exec) {
      const { sessionId, cwd } = await sessionOf(scoped, exec)
      const service = SERVICE
      service.hydrate(cwd)
      const flow = service.get(sessionId)
      if (!flow) throw new Error('当前会话没有流程。')
      if (flow.finished) {
        return { cancelled: false, flowId: flow.id, message: '流程已经结束，不需要再放弃。' }
      }
      cancelFlow(flow, args.reason)
      // 与界面按钮走同一条收尾路径：叫醒所有挂起的门禁工具。
      service.gates.notify(sessionId, { kind: 'cancelled', decision: 'cancelled' }, undefined)
      return {
        cancelled: true,
        flowId: flow.id,
        message: '已放弃流程 ' + flow.id + '。scope 已解冻，可以重新启动新流程。',
      }
    },
  }
}

function reviewRunTool(scoped) {
  return {
    name: 'flowgate_review_run',
    description: [
      'S3 评审的宿主驱动版本：宿主为每个启用的评审角度 spawn 一个只读子代理，',
      '收集结构化报告后聚合，然后挂起等待用户在门禁上点「通过评审」或「退回开发修复」。',
      '在启动前登记真实子会话，由 tools.guard 最终守卫拒绝未授权能力。',
      '如果宿主没有 subagents 服务，改用 flowgate_review 由主会话自行组织只读评审。',
    ].join(''),
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          decision: { type: 'string' },
          next: { type: 'string' },
          blocking: { type: 'number' },
          angles: { type: 'number' },
          message: { type: 'string' },
        },
        required: ['decision', 'next', 'blocking', 'angles', 'message'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textOut(value.message)
      },
    },
    async execute(_args, exec) {
      const { sessionId, cwd } = await sessionOf(scoped, exec)
      const service = SERVICE
      service.hydrate(cwd)
      const flow = service.require(sessionId)
      requireRunning(flow)
      if (flow.stage !== 'S3') {
        throw new Error('评审子代理只在 S3 阶段运行，当前阶段是 ' + flow.stage + '。')
      }
      const angles = resolveAngles(flow)
      if (!angles.length) throw new Error('当前没有启用的评审角度，先在阶段设置里勾选至少一个。')

      const reports = await collectChildReports(scoped, service, flow, exec, angles, runAngle)
      const blocking = reports.reduce(
        (sum, report) => sum + report.findings.filter((item) => item.severity !== 'MINOR').length,
        0,
      )
      flow.review = { angles: reports, blocking, at: nowIso(), by: 'subagents' }
      appendEvent(cwd, flow, 'review.submitted', { angles: reports.length, blocking, by: 'subagents' })
      persist(flow)

      const outcome = await waitReviewGate(service, flow, sessionId, exec, blocking)
      return { ...outcome, angles: reports.length }
    },
  }
}

function testRunTool(scoped) {
  return {
    name: 'flowgate_test_run',
    description: [
      'S4 测试的宿主驱动版本：宿主为每个启用的测试方向 spawn 一个只读子代理，',
      '收集「方向 × 要点」的结构化结果后挂起，等用户点「验收通过」或「退回开发修复」。',
      '子代理只能执行只读 shell。如果宿主没有 subagents 服务，改用 flowgate_test。',
    ].join(''),
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          decision: { type: 'string' },
          next: { type: 'string' },
          failed: { type: 'number' },
          directions: { type: 'number' },
          message: { type: 'string' },
        },
        required: ['decision', 'next', 'failed', 'directions', 'message'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textOut(value.message)
      },
    },
    async execute(_args, exec) {
      const { sessionId, cwd } = await sessionOf(scoped, exec)
      const service = SERVICE
      service.hydrate(cwd)
      const flow = service.require(sessionId)
      requireRunning(flow)
      if (flow.stage !== 'S4') {
        throw new Error('测试子代理只在 S4 阶段运行，当前阶段是 ' + flow.stage + '。')
      }
      const directions = resolveDirections(flow)
      if (!directions.length) throw new Error('当前没有启用的测试方向，先在阶段设置里勾选至少一个。')

      const results = await collectChildReports(scoped, service, flow, exec, directions, runDirection)
      const failed = results.reduce(
        (sum, direction) => sum + direction.points.filter((point) => point.result === 'fail').length,
        0,
      )
      flow.test = { directions: results, failed, at: nowIso(), by: 'subagents' }
      appendEvent(cwd, flow, 'test.submitted', { directions: results.length, failed, by: 'subagents' })
      persist(flow)

      const outcome = await waitTestGate(service, flow, sessionId, exec, failed)
      return { ...outcome, directions: results.length }
    },
  }
}

// ---------------------------------------------------------------------------
// 只读子代理（S3 评审 / S4 测试）
// ---------------------------------------------------------------------------

/** 新接口与最终守卫缺一不可；同一判定同时服务于视图和实际启动。 */
function subagentCapability(scoped, guardReady) {
  let subagents
  try {
    subagents = scoped.get('subagents')
  } catch (error) {
    return { available: false, reason: '无法读取宿主 subagents 服务：' + (error?.message ?? String(error)) }
  }
  if (!subagents) return { available: false, reason: '宿主未提供 subagents 服务。' }
  if (typeof subagents.startActivation !== 'function' || typeof subagents.getProvider !== 'function') {
    return { available: false, reason: '宿主 subagents 接口不匹配：需要 startActivation / getProvider（DSH 0.2.2-rc.3）。' }
  }
  let provider
  try {
    provider = subagents.getProvider('spawn')
  } catch (error) {
    return { available: false, reason: '无法查询 spawn provider：' + (error?.message ?? String(error)) }
  }
  if (!provider) return { available: false, reason: '宿主没有注册 spawn 子代理 provider。' }
  if (typeof provider.prepareContinuable !== 'function') {
    return { available: false, reason: 'spawn provider 不支持预留子会话 ID，无法在执行前安装只读保护。' }
  }
  if (!guardReady) return { available: false, reason: '宿主缺少可用的 tools.guard 最终守卫，无法保证子代理只读。' }
  return { available: true, subagents }
}

const CHILD_RUNS = new WeakMap()

function childRunCancelled() {
  const error = new Error('只读子代理运行已取消或所属流程阶段已改变。')
  error.name = 'AbortError'
  return error
}

function abortChildRun(flow) {
  CHILD_RUNS.get(flow)?.abort()
}

function rethrowChildCancellation(signal, error) {
  if (!signal?.aborted && error?.name !== 'AbortError') return
  const cancelled = childRunCancelled()
  if (error?.name !== 'AbortError') cancelled.message += ' ' + (error?.message ?? String(error))
  throw cancelled
}

/** 取消不是普通失败降级；每次 await 后重新校验流程，拒绝迟到报告。 */
async function collectChildReports(scoped, service, flow, exec, items, run) {
  if (CHILD_RUNS.has(flow)) throw new Error('这次流程已有只读子代理运行，请等待当前调用完成。')
  const controller = new AbortController()
  const stage = flow.stage
  const record = flow.stages[stage]
  const abort = () => controller.abort()
  const assertCurrent = () => {
    if (exec.signal?.aborted || service.get(flow.sessionId) !== flow || flow.finished ||
        flow.stage !== stage || flow.stages[stage] !== record) controller.abort()
    if (controller.signal.aborted) throw childRunCancelled()
  }
  CHILD_RUNS.set(flow, controller)
  service.childRuns.set(flow, controller)
  exec.signal?.addEventListener('abort', abort, { once: true })
  try {
    const reports = []
    assertCurrent()
    for (const item of items) {
      assertCurrent()
      reports.push(await run(scoped, service, flow, exec.agent, controller.signal, item))
      assertCurrent()
    }
    return reports
  } finally {
    exec.signal?.removeEventListener('abort', abort)
    CHILD_RUNS.delete(flow)
    service.childRuns.delete(flow)
  }
}

/** 预留真实会话并先设守卫；signal 仅覆盖发布前，发布后须 dispose。 */
async function spawnReadonlyChild(scoped, service, flow, parentAgent, signal, spec) {
  if (signal?.aborted) throw childRunCancelled()
  const capability = subagentCapability(scoped, service.readonlyGuardReady)
  if (!capability.available) {
    throw new Error(capability.reason + ' 改用 flowgate_review / flowgate_test 由主会话自行组织评审与测试。')
  }
  const childId = randomUUID()
  const policy = {
    flowId: flow.id,
    allowShellWrite: spec.allowShellWrite === true,
    directionId: spec.directionId,
    signal,
  }
  service.registerChild(flow.sessionId, childId, policy)
  let activation
  let disposePromise
  let onAbort
  const quarantine = () => {
    const readonly = { ...policy, allowShellWrite: false }
    service.registerChild(flow.sessionId, childId, readonly)
    if (typeof activation?.childId === 'string' && activation.childId !== childId) {
      service.registerChild(flow.sessionId, activation.childId, readonly)
    }
  }
  const dispose = () => {
    if (!disposePromise) disposePromise = Promise.resolve().then(() => activation.dispose())
    return disposePromise
  }
  try {
    activation = await capability.subagents.startActivation({
      provider: 'spawn',
      childId,
      label: spec.label,
      prompt: [{ type: 'text', text: spec.prompt }],
      parent: parentAgent,
      cwd: flow.cwd,
      signal,
      delivery: 'caller',
    })
    if (!activation || typeof activation.dispose !== 'function' || typeof activation.result?.then !== 'function' ||
        activation.childId !== childId) {
      // 失配时也保护宿主实际返回的会话，直到它被确认释放。
      if (activation?.childId) service.registerChild(flow.sessionId, activation.childId, policy)
      throw new Error('宿主返回的 activation 身份或生命周期接口不匹配。')
    }
    const cancelled = new Promise((_resolve, reject) => {
      onAbort = () => {
        dispose().then(() => reject(childRunCancelled()), reject)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
    return await Promise.race([activation.result, cancelled])
  } catch (error) {
    if (!activation) {
      // 宿主可在已投递消息后 reject，并仅记录内部释放失败；无回执不等于未执行。
      throw new Error('子代理启动失败且未能确认释放；已保留会话 ' + childId + ' 的只读隔离：' + (error?.message ?? String(error)))
    }
    throw error
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    if (activation) {
      try {
        await dispose()
      } catch (error) {
        // 释放失败不能证明已经停止；连该测试方向原获准的写命令也一并撤销。
        quarantine()
        throw new Error('子代理资源释放失败；已保留会话 ' + childId + ' 的只读隔离：' + (error?.message ?? String(error)))
      }
      service.unregisterChild(childId)
      if (activation.childId !== childId) service.unregisterChild(activation.childId)
    } else {
      quarantine()
    }
  }
}

/** 从子代理的文本输出里抠出第一个 JSON 对象。 */
function parseReport(text) {
  const raw = String(text ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

const outputText = (output) => (Array.isArray(output) ? output : [])
  .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
  .map((block) => block.text)
  .join('\n')

/** 会逐条核对开发规则的角度。 */
const RULE_CHECKING_ANGLES = new Set(['correctness', 'style'])

function anglePrompt(flow, angle, workspace) {
  const scope = flow.scope.data ?? {}
  const rules = RULE_CHECKING_ANGLES.has(angle.id) ? resolveRules(flow, workspace) : []
  return [
    '你是只读评审子代理，评审角度：' + angle.name + '。',
    '只允许读取工具；shell 仅允许 pwd。Git、写操作、未知工具、脚本和解释器默认拒绝。',
    '使用 run_code 时必须仅写：return await tools.ops_read_files({"files":[{"path":"文件路径"}]})；参数必须是严格 JSON，不能添加其他 JavaScript。',
    '',
    '检查要点：',
    ...(angle.points ?? []).map((point) => '- ' + point),
    ...(rules.length
      ? ['', '用户定义的开发规则（逐条核对，未遵守的写进 findings）：', ...rules.map((rule) => '- ' + rule.name + '：' + (rule.points ?? []).join('；'))]
      : []),
    '',
    '冻结 scope（开发只允许碰这些文件）：',
    JSON.stringify(scope.in_scope ?? {}, null, 2),
    '显式排除项：' + JSON.stringify(scope.out_of_scope_explicitly ?? []),
    '验收标准：' + JSON.stringify(scope.acceptance_criteria ?? []),
    '',
    '本阶段的代码变更摘要：' + JSON.stringify(flow.devChanges ?? null),
    '',
    '只输出一个 JSON 对象，不要额外文字：',
    '{"verdict":"pass|blocking|advisory","suggestUpgrade":false,',
    ' "findings":[{"file":"相对路径","line":12,"severity":"CRITICAL|MAJOR|MINOR","summary":"一句话"}]}',
    'verdict：有 CRITICAL/MAJOR 用 blocking，只有 MINOR 用 advisory，都没有用 pass。',
    'suggestUpgrade 只在发现 scope 内存在架构性问题时填 true。',
  ].join('\n')
}

function directionPrompt(flow, direction, allowShellWrite = false) {
  return [
    '你是只读测试子代理，测试方向：' + direction.name + '。',
    allowShellWrite
      ? '用户已在 S4 设置面板为这个方向显式授权写权限：可以执行变更性命令（如迁移后回滚），但 write / edit / str_replace_editor 仍被宿主端拒绝——代码本身不能改。'
      : '只允许读取工具；shell 仅允许 pwd。Git 和测试脚本不能推定只读，未授权时应说明未覆盖，不能尝试运行。',
    '使用 run_code 时必须仅写：return await tools.ops_read_files({"files":[{"path":"文件路径"}]})；参数必须是严格 JSON，不能添加其他 JavaScript。',
    '',
    '验证要点：',
    ...(direction.points ?? []).map((point) => '- ' + point),
    '',
    '验收标准：' + JSON.stringify(flow.scope.data?.acceptance_criteria ?? []),
    '',
    '只输出一个 JSON 对象，不要额外文字：',
    '{"points":[{"point":"验证要点原文","result":"pass|fail|uncovered","detail":"一句话证据"}]}',
  ].join('\n')
}

/** 跑一个评审角度；子代理失败时降级为一条 MINOR，不阻塞门禁。 */
async function runAngle(scoped, service, flow, parentAgent, signal, angle) {
  try {
    const result = await spawnReadonlyChild(scoped, service, flow, parentAgent, signal, {
      label: '评审：' + angle.name,
      prompt: anglePrompt(flow, angle, service.workspaceOf(flow.cwd)),
    })
    if (result?.stopReason !== 'completed') {
      throw new Error('子代理未正常结束（' + (result?.stopReason ?? '缺少 stopReason') + '）')
    }
    const report = result.structured ?? parseReport(outputText(result.output))
    if (!report || !['pass', 'blocking', 'advisory'].includes(report.verdict) || !Array.isArray(report.findings) ||
        report.findings.some((item) => !item || typeof item.file !== 'string' ||
          typeof item.summary !== 'string' || !item.summary.trim() ||
          !['CRITICAL', 'MAJOR', 'MINOR'].includes(item.severity))) {
      throw new Error('子代理没有返回有效的 JSON 评审报告（需要 verdict 和 findings）')
    }
    const findings = Array.isArray(report.findings)
      ? report.findings
        .filter((item) => item && typeof item.summary === 'string')
        .map((item) => ({
          file: String(item.file ?? ''),
          line: Number.isInteger(item.line) ? item.line : undefined,
          severity: ['CRITICAL', 'MAJOR', 'MINOR'].includes(item.severity) ? item.severity : 'MINOR',
          summary: item.summary,
        }))
      : []
    const verdict = findings.some((item) => item.severity !== 'MINOR') ? 'blocking'
      : findings.length ? 'advisory' : report.verdict
    return {
      id: angle.id,
      name: angle.name,
      verdict,
      suggestUpgrade: report.suggestUpgrade === true,
      findings,
    }
  } catch (error) {
    rethrowChildCancellation(signal, error)
    return {
      id: angle.id,
      name: angle.name,
      verdict: 'advisory',
      suggestUpgrade: false,
      findings: [{
        file: '',
        severity: 'MINOR',
        summary: '该角度的只读子代理没有产出报告：' + (error?.message ?? String(error)),
      }],
    }
  }
}

/** 跑一个测试方向；子代理失败时降级为「未覆盖」，不阻塞门禁。 */
async function runDirection(scoped, service, flow, parentAgent, signal, direction) {
  const points = (direction.points ?? []).map((point) => ({ point, result: 'uncovered' }))
  // D2：只有声明需要写权限、且被用户显式勾选授权的方向才拿到变更性 shell。
  const allowShellWrite = direction.needsWrite === true && (flow.writeGrants ?? []).includes(direction.id)
  try {
    const result = await spawnReadonlyChild(scoped, service, flow, parentAgent, signal, {
      label: '测试：' + direction.name,
      prompt: directionPrompt(flow, direction, allowShellWrite),
      allowShellWrite,
      directionId: direction.id,
    })
    if (result?.stopReason !== 'completed') {
      throw new Error('子代理未正常结束（' + (result?.stopReason ?? '缺少 stopReason') + '）')
    }
    const report = result.structured ?? parseReport(outputText(result.output))
    if (!report || !Array.isArray(report.points)) throw new Error('子代理没有返回可解析的 JSON 报告')
    // 不能用额外的 pass 项替换缺失的验证要点；重复/非法项同样记未覆盖。
    const resolved = points.map((expected) => {
      const matches = report.points.filter((item) => item?.point === expected.point)
      const item = matches[0]
      if (matches.length !== 1 || !['pass', 'fail', 'uncovered'].includes(item?.result)) {
        return { ...expected, detail: '子代理未返回该验证要点的唯一有效结果。' }
      }
      return { point: expected.point, result: item.result, detail: typeof item.detail === 'string' ? item.detail : undefined }
    })
    return { id: direction.id, name: direction.name, points: resolved }
  } catch (error) {
    rethrowChildCancellation(signal, error)
    return {
      id: direction.id,
      name: direction.name,
      points: points.map((item) => ({
        ...item,
        detail: '只读子代理没有产出结果：' + (error?.message ?? String(error)),
      })),
    }
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/** 当前挂载的宿主服务；插件卸载时清空。 */
let SERVICE = null

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** 门禁等待的返回值统一成 decision 字符串。 */
function decisionOf(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'wait'
  if (outcome.kind === 'timeout' || outcome.kind === 'aborted' || outcome.kind === 'superseded') return 'wait'
  if (typeof outcome.decision === 'string') return outcome.decision
  if (typeof outcome.kind === 'string') return outcome.kind
  return 'wait'
}

function sessionIdOf(exec) {
  const header = exec?.agent?.session?.header ?? null
  return header && typeof header.id === 'string' ? header.id : null
}

/**
 * 从宿主会话反查工作目录。界面一键启动时客户端只带 sessionId（客户端快照里没有 cwd），
 * 工作目录由宿主自己解析。拿不到时返回 null，由调用方决定怎么提示。
 */
function cwdOfSession(service, sessionId) {
  const ctx = service?.ctx
  const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
  if (!sessions || typeof sessions.get !== 'function') return null
  let session = null
  try {
    session = sessions.get(sessionId)
  } catch {
    return null
  }
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
}

/**
 * 界面启动后投递给 Agent 的那条消息：把档位与需求原文交代清楚，并指定下一步动作。
 */
function wakeMessage(flow) {
  const label = PRESETS[flow.preset]?.label ?? flow.preset
  const lines = ['【流程工作台】已启动一次四阶段流程（档位：' + label + '），当前阶段 S1 需求分析。']
  if (flow.brief) {
    lines.push('需求原文：', flow.brief)
    lines.push(
      '',
      '请接着做 S1：先调用 flowgate_status 确认状态，再用 flowgate_ask 一次只问一个关键决策问题；需求原文里已经写清楚的内容不要重复问。问完后用 flowgate_doc 提交需求文档与 scope。',
      '这是同一条流程的 S1，不是一次单独的需求分析：flowgate_doc 返回 approve 后立刻继续 S2 开发，此后每个门禁通过都直接进入下一阶段，直到流程验收结束或用户放弃——不要在阶段交界处停下等用户再说一句。S1 本身不写代码，也不要跳过任何门禁。',
    )
  } else {
    // 用户可能只是点了「开始需求分析」，一个字都没留。这时候「需求分析」不能变成
    // 照着这四个字自己编一个需求去分析——S1 的第一步必须是问清目标。
    lines.push('用户这次没有填写需求描述，可能只是点了「开始需求分析」就进来了。')
    lines.push(
      '',
      '请接着做 S1：先调用 flowgate_status 确认状态，然后用 flowgate_ask 只问一个问题——这次要做什么。不要自己假设目标，不要直接产出需求文档，也不要写代码。',
      '问清楚目标后同样一路走完四阶段：文档获批就直接进入 S2，不要在阶段交界处停下等用户再发一句。',
    )
  }
  return lines.join('\n')
}

/**
 * 唤醒当前会话的 Agent。
 *
 * 界面点「开始需求分析」只创建流程状态，Agent 并不知道流程开了；不补一条消息，
 * S1 会一直停在「进行中」等用户自己在对话里再说一句。这里用宿主的 agents 服务
 * 取 live agent，再用 followup 排一条 user 消息。取不到时降级：界面提示用户开口。
 */
function deliverToAgent(service, flow, text) {
  const record = { at: nowIso(), ok: false, reason: '' }
  const agents = service.ctx && typeof service.ctx.get === 'function' ? service.ctx.get('agents') : null
  const agent = agents && typeof agents.get === 'function' ? agents.get(flow.sessionId) : null
  if (!agent || typeof agent.followup !== 'function') {
    record.reason = '宿主没有返回这个会话的 Agent。'
    return record
  }
  try {
    agent.followup({
      id: 'm_' + randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    record.ok = true
  } catch (error) {
    record.reason = error?.message ?? String(error)
  }
  return record
}

function wakeAgent(service, flow) {
  const record = deliverToAgent(service, flow, wakeMessage(flow))
  service.nudges.set(flow.sessionId, record)
  return record
}

/**
 * 门禁决策落地后给 Agent 的跟进消息。
 *
 * 界面上的点击只改流程状态；Agent 那边等门禁的工具如果已经被中断（工具调用超时、
 * 宿主重启、新的门禁取代旧的），没有这条消息，流程就停在阶段交界处——阶段已经推进，
 * 却没有人叫醒 Agent，用户必须自己再发一句。
 */
function gateWakeText(flow, lead) {
  const head = '【流程工作台】' + lead
  // 放弃优先于结束：放弃的流程 finished 也可能为真，先说「已放弃」，别让 Agent 接着推进。
  if (flow.cancelled) return head + '\n这次流程已放弃，停下手上的阶段工作，等用户重新开始。'
  if (flow.finished) return head + '\n四个阶段已经全部结束，不需要再推进阶段。'
  return (
    head +
    '\n进入 ' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）。' +
    '现在直接开始 ' + flow.stage + ' 的工作，不要在阶段交界处停下等用户再说一句。'
  )
}

/** 决策已落地但没有等待器接着跑时，补一条消息把 Agent 叫醒；记录留下来给界面降级提示。 */
function wakeAfterGate(service, flow, lead) {
  return deliverToAgent(service, flow, gateWakeText(flow, lead))
}

/**
 * 需求文档决策的跟进消息。
 *
 * 「修改需求」和「批准/跳过」的下一步完全不同：修改时 scope 还没冻结，Agent 必须回去改文档
 * 而不是开始写代码，所以不能和批准共用一句「scope 已冻结」。
 */
function docWakeText(flow, decision) {
  const head = '【流程工作台】'
  if (decision === 'revise') {
    return (
      head + '用户要求修改需求文档，scope 尚未冻结。\n进入 ' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）：' +
      '按用户意见改完后重新提交 flowgate_doc，不要在阶段交界处停下等用户再说一句。'
    )
  }
  return gateWakeText(
    flow,
    decision === 'skip' ? '需求文档已跳过评审，scope 仍然冻结。' : '需求文档已批准，scope 已冻结。',
  )
}

/** 文档决策已落地但没有等待器接手时补一条消息；和门禁共用同一条投递路径。 */
function wakeAfterDoc(service, flow, decision) {
  return deliverToAgent(service, flow, docWakeText(flow, decision))
}

/**
 * 应用一次客户端操作。返回新的视图；无法应用时抛错。
 */
async function applyAction(service, sessionId, action, payload) {
  const flow = service.get(sessionId)

  if (action === 'start') {
    // 界面一键启动：客户端只带 sessionId，标题与档位都可以省略。
    if (flow && !flow.finished) {
      // 重复点击不新建流程；但上次没唤醒成功时（宿主当时拿不到 live agent）要重试一次，
      // 否则按钮看起来像坏了，用户只能自己回对话里补一句。
      const last = service.nudges.get(sessionId)
      if (last && last.ok === false) service.nudges.set(sessionId, wakeAgent(service, flow))
      return service.view(sessionId)
    }
    const cwd = cwdOfSession(service, sessionId)
    if (!cwd) {
      throw new Error('无法确定当前会话的工作目录，界面启动失败。可以让 Agent 调用 flowgate_start 启动，或确认这个会话已经绑定项目目录。')
    }
    const title = typeof payload?.title === 'string' ? payload.title.trim() : ''
    const brief = typeof payload?.brief === 'string' ? payload.brief : ''
    const created = service.start(sessionId, cwd, title || undefined, payload?.preset, brief)
    // 状态建好了，Agent 还不知情：补一条消息让它接着做 S1。
    service.nudges.set(sessionId, wakeAgent(service, created))
    return service.view(sessionId)
  }
  if (!flow) throw new Error('当前会话没有流程。')

  const gates = service.gates
  const workspace = service.workspaceOf(flow.cwd)

  switch (action) {
    case 'answer': {
      const choiceIndex = Number(payload?.choiceIndex)
      const customText = typeof payload?.customText === 'string' ? payload.customText : ''
      // -1 表示「自定义」：宿主记录里 choice 为空，custom 承载用户输入。
      if (!Number.isInteger(choiceIndex) || choiceIndex < -1) throw new Error('choiceIndex 非法')
      if (choiceIndex === -1 && !customText.trim()) throw new Error('自定义内容不能为空')
      if (!gates.notify(sessionId, { kind: 'answer', choiceIndex, customText }, 'answer')) {
        throw new Error('当前没有等待中的追问卡片。')
      }
      break
    }
    case 'doc': {
      const decision = payload?.decision
      if (decision !== 'approve' && decision !== 'revise' && decision !== 'skip') {
        throw new Error('decision 必须是 approve / revise / skip')
      }
      // 决策直接落流程状态：等待器可能已被中断或重启清掉，界面仍然要能确认。
      const result = decideDoc(service, flow, sessionId, decision)
      // 还挂着的工具立刻收到同一结果；没有等待器时通知不到，也不影响推进。
      const docDelivered = gates.notify(sessionId, { kind: result.decision }, 'doc')
      // 重复点击不重复唤醒；等待器已经接手时也不需要补消息。
      if (!docDelivered && !result.repeated) {
        service.nudges.set(sessionId, wakeAfterDoc(service, flow, result.decision))
      }
      break
    }
    case 'cancel': {
      if (flow.finished) throw new Error('流程已经结束，不需要再放弃。')
      cancelFlow(flow, typeof payload?.reason === 'string' ? payload.reason : '')
      // 挂起的门禁工具必须被叫醒，否则它会一直等一个永远不会来的按钮。
      // expectKind 传 undefined：不关心它停在哪种门禁上，一律唤醒。
      const cancelledDelivered = gates.notify(sessionId, { kind: 'cancelled', decision: 'cancelled' }, undefined)
      if (!cancelledDelivered) {
        service.nudges.set(sessionId, wakeAfterGate(service, flow, '用户放弃了这次流程。'))
      }
      break
    }
    case 'gate': {
      const decision = payload?.decision
      if (!['pass', 'skip', 'back'].includes(decision)) throw new Error('decision 必须是 pass / skip / back')
      // 决策直接落流程状态：等待器可能已被中断或重启清掉，界面仍然要能确认。
      const gateOutcome = decideGate(service, flow, sessionId, decision, payload?.to)
      // 没有等待器接手时补一条消息：否则阶段推进了，Agent 却还停在上一个阶段。
      if (!gateOutcome.delivered && !gateOutcome.repeated) {
        // 两个阶段分开命名：passedStage 是被点掉的那个门禁，nextStage 是接下来要做的阶段。
        const passedStage = gateOutcome.stage
        const nextStage = flow.stage
        const lead =
          decision === 'back'
            ? '用户退回到 ' + nextStage + ' 重做。'
            : (decision === 'skip' ? '用户跳过了 ' : '用户通过了 ') + passedStage + ' 门禁。'
        service.nudges.set(sessionId, wakeAfterGate(service, flow, lead))
      }
      break
    }
    case 'preset': {
      const preset = payload?.preset
      if (!PRESETS[preset]) throw new Error('未知档位')
      flow.preset = preset
      // 角度与方向随档位重置；开发规则的勾选与档位无关，切档不该静默丢掉用户的选择。
      flow.overrides = { angles: null, directions: null, rules: flow.overrides?.rules ?? null }
      appendEvent(flow.cwd, flow, 'preset.set', { preset })
      persist(flow)
      break
    }
    case 'upgrade': {
      const target = payload?.preset ?? 'strict'
      if (!PRESETS[target]) throw new Error('未知档位')
      const from = flow.preset
      flow.preset = target
      // 角度与方向随档位重置；开发规则的勾选与档位无关，升档不该静默丢掉用户的选择。
      flow.overrides = { angles: null, directions: null, rules: flow.overrides?.rules ?? null }
      appendEvent(flow.cwd, flow, 'preset.upgraded', { from, to: target, stage: flow.stage })
      // 评审阶段升档且评审确实发现了问题 → 回到 S2 重做（scope 不扩充）。
      const foundProblems = flow.review && flow.review.blocking > 0
      if (flow.stage === 'S3' && foundProblems) {
        // D4：升档只改执行深度，不改范围。发现落在 scope 之外时，重做 S2 也修不了，
        // 只能回 S1 调整 scope——所以这里按发现的位置决定回退深度。
        const outside = reviewFindingsOutsideScope(flow)
        const to = outside.length ? 'S1' : 'S2'
        // 评审工具还挂在门禁上：先告诉它被升档中断，否则它会一直等下去。
        const upgradeDelivered = gates.notify(sessionId, { decision: 'interrupted', to }, 'gate')
        rollbackTo(flow, to, to === 'S1' ? 'upgrade-scope-overflow' : 'upgrade-after-review')
        // 升档中断了评审工具而没有等待器接手时，同样要把 Agent 叫回到重做的阶段。
        if (!upgradeDelivered) {
          service.nudges.set(
            sessionId,
            wakeAfterGate(service, flow, '用户把执行档位升到 ' + PRESETS[target].label + '，并退回 ' + flow.stage + ' 重做。'),
          )
        }
        // rollbackTo 会清掉旧评审（否则旧报告会让门禁提前可点），
        // 但「发现落在 scope 之外」这个结论得跟着响应带出去，界面才好解释为什么回 S1。
        return { ...service.view(sessionId), reviewOutsideScope: outside }
      } else {
        persist(flow)
      }
      break
    }
    case 'toggleRule': {
      const id = payload?.id
      if (!ruleCatalog(flow, workspace).some((rule) => rule.id === id)) throw new Error('未知的开发规则：' + id)
      const enabled = payload?.enabled !== false
      // 起点是当前生效的那一套：跟随工作区默认时，取消一条也基于它，而不是内置默认。
      const set = new Set(activeRules(flow, workspace))
      if (enabled) set.add(id)
      else set.delete(id)
      flow.overrides.rules = Array.from(set)
      appendEvent(flow.cwd, flow, 'rules.changed', { id, enabled })
      persist(flow)
      break
    }
    case 'addRule': {
      const name = String(payload?.name ?? '').trim()
      if (!name) throw new Error('名称不能为空')
      const points = Array.isArray(payload?.points)
        ? payload.points.map((p) => String(p).trim()).filter(Boolean)
        : String(payload?.points ?? '').split('\n').map((p) => p.trim()).filter(Boolean)
      const item = { id: 'rule_' + randomUUID().slice(0, 8), name, points }
      flow.customRules = flow.customRules ?? []
      flow.customRules.push(item)
      // 追加总是落在本次流程上；要不要留给以后，由「保存为工作区默认」决定。
      const set = new Set(activeRules(flow, workspace))
      set.add(item.id)
      flow.overrides.rules = Array.from(set)
      appendEvent(flow.cwd, flow, 'rule.added', { name })
      persist(flow)
      break
    }
    case 'saveRuleDefaults': {
      // 把当前流程生效的规则存成工作区默认：之后新流程自动继承，不必每次重勾。
      const ids = activeRules(flow, workspace)
      const builtinIds = new Set(BUILTIN_RULES.map((rule) => rule.id))
      const custom = ruleCatalog(flow, workspace)
        .filter((rule) => !builtinIds.has(rule.id) && ids.includes(rule.id))
      service.setWorkspaceRules(flow.cwd, { ids, custom })
      // 存成默认后本次也改为跟随默认：来源标签与行为一致，不再显示「临时调整」。
      flow.overrides.rules = null
      appendEvent(flow.cwd, flow, 'rules.saved', { count: ids.length, custom: custom.length })
      persist(flow)
      break
    }
    case 'clearRuleDefaults': {
      service.setWorkspaceRules(flow.cwd, null)
      appendEvent(flow.cwd, flow, 'rules.cleared', {})
      break
    }
    case 'toggleAngle':
    case 'toggleDirection': {
      const isAngle = action === 'toggleAngle'
      const id = payload?.id
      const enabled = payload?.enabled !== false
      const key = isAngle ? 'angles' : 'directions'
      const current = (flow.overrides[key] ?? (isAngle ? PRESETS[flow.preset].angles : PRESETS[flow.preset].directions)).slice()
      const set = new Set(current)
      if (enabled) set.add(id)
      else set.delete(id)
      flow.overrides[key] = Array.from(set)
      appendEvent(flow.cwd, flow, isAngle ? 'angles.changed' : 'directions.changed', { id, enabled })
      persist(flow)
      break
    }
    case 'toggleWriteGrant': {
      // D2：v1 唯一的写权限例外——只在 S4、只对声明需要写权限的方向、且必须由用户显式勾选。
      if (flow.stage !== 'S4') throw new Error('写权限例外只在 S4 测试阶段开放，当前阶段是 ' + flow.stage + '。')
      const id = payload?.id
      const direction = directionCatalog(flow).find((item) => item.id === id)
      if (!direction) throw new Error('未知的测试方向：' + id)
      if (direction.needsWrite !== true) throw new Error('该测试方向没有声明需要写权限，不允许授予。')
      const enabled = payload?.enabled !== false
      const set = new Set(flow.writeGrants ?? [])
      if (enabled) set.add(id)
      else set.delete(id)
      flow.writeGrants = Array.from(set)
      appendEvent(flow.cwd, flow, enabled ? 'write.granted' : 'write.revoked', { id, name: direction.name })
      persist(flow)
      break
    }
    case 'addAngle':
    case 'addDirection': {
      const isAngle = action === 'addAngle'
      const name = String(payload?.name ?? '').trim()
      if (!name) throw new Error('名称不能为空')
      const points = Array.isArray(payload?.points)
        ? payload.points.map((p) => String(p).trim()).filter(Boolean)
        : String(payload?.points ?? '').split('\n').map((p) => p.trim()).filter(Boolean)
      const item = { id: 'custom_' + randomUUID().slice(0, 8), name, points }
      if (!isAngle && payload?.needsWrite === true) item.needsWrite = true
      if (isAngle) {
        flow.customAngles.push(item)
        const set = new Set(flow.overrides.angles ?? PRESETS[flow.preset].angles)
        set.add(item.id)
        flow.overrides.angles = Array.from(set)
      } else {
        flow.customDirections.push(item)
        const set = new Set(flow.overrides.directions ?? PRESETS[flow.preset].directions)
        set.add(item.id)
        flow.overrides.directions = Array.from(set)
      }
      appendEvent(flow.cwd, flow, isAngle ? 'angle.added' : 'direction.added', { name })
      persist(flow)
      break
    }
    case 'note': {
      flow.gateNote = String(payload?.text ?? '')
      persist(flow)
      break
    }
    default:
      throw new Error('未知操作：' + action)
  }

  // 唤醒挂起的工具后，它的续体会同步推进状态机（passGate / rollbackTo 都不 await）。
  // 让出一拍再取视图，客户端拿到的就是推进后的状态，不需要自己再轮询一次。
  await new Promise((resolve) => setTimeout(resolve, 0))
  return service.view(sessionId)
}

/**
 * 全局面板的工作区视图：把若干工作目录下的流程摊成一份跨会话清单。
 * 面板不属于任何会话，拿不到 sessionId，所以这里只读盘上的快照，
 * 不触发流程状态机——看列表这件事本身不会改变任何状态。
 */
function hubFlowSummary(service, flow) {
  return {
    id: flow.id,
    sessionId: flow.sessionId,
    title: flow.title || '未命名需求',
    brief: String(flow.brief ?? '').slice(0, 200),
    preset: flow.preset,
    stage: flow.stage,
    stageLabel: STAGE_LABEL[flow.stage] ?? '',
    finished: Boolean(flow.finished),
    cancelled: Boolean(flow.cancelled),
    // 门禁在内存里：这份清单正好能看出哪条流程正卡着等用户点击。
    waiting: service?.gates.has(flow.sessionId) ?? false,
    waitingKind: service?.gates.kindOf(flow.sessionId) ?? null,
    skippedCount: skippedCount(flow),
    percent: progressPercent(flow),
    createdAt: flow.createdAt ?? null,
    updatedAt: flow.updatedAt ?? null,
  }
}

/** 进度百分比；坏快照不该让整个清单打不开。 */
function progressPercent(flow) {
  try {
    return progressOf(flow).percent
  } catch {
    return 0
  }
}

function hubSnapshot(service, paths) {
  const seen = new Set()
  const workspaces = []
  for (const raw of Array.isArray(paths) ? paths : []) {
    // 只认绝对路径：cwd 会拼进 .dsh-flowgate，相对路径会被解释到别处。
    if (typeof raw !== 'string' || !raw || !isAbsolute(raw) || seen.has(raw)) continue
    seen.add(raw)
    workspaces.push(hubMemberSummary(service, { path: raw }, true))
  }
  // 有活跃流程的工作区排前面，其次按最近改动：面板打开第一眼就是「在做的那些」。
  workspaces.sort((a, b) => (b.activeCount - a.activeCount) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  return { workspaces }
}

// ---------------------------------------------------------------------------
// 工作台成员名单
// ---------------------------------------------------------------------------

/**
 * 左侧栏面板是全局的，不属于任何会话，所以「用户添加过哪些工作区」这份名单
 * 没法放在某个工作区里——它只能落在用户级目录。
 * 名单只记路径与添加时间；规则和任务仍然留在各自工作区的 .dsh-flowgate/ 下，
 * 添加时按需读出来展示：既不复制，也不改写。
 */
const HUB_REGISTRY_VERSION = 1

/** 测试要能隔离：否则会写进真实的 home 目录。 */
function hubRootDir() {
  return process.env.DSH_FLOWGATE_HOME || join(homedir(), DATA_DIR)
}

function hubRegistryFile() {
  return join(hubRootDir(), 'hub.json')
}

function hubRegistryLabel() {
  return '~/' + DATA_DIR + '/hub.json'
}

function normalizeHubMember(item) {
  if (!item || typeof item !== 'object') return null
  const path = typeof item.path === 'string' ? item.path.trim() : ''
  if (!path || !isAbsolute(path)) return null
  return { path, addedAt: typeof item.addedAt === 'string' ? item.addedAt : null }
}

function loadHubRegistry() {
  const file = hubRegistryFile()
  if (!existsSync(file)) return { version: HUB_REGISTRY_VERSION, workspaces: [] }
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // 名单坏了当空处理：最多让用户重新添加一次，不该整块面板打不开。
    return { version: HUB_REGISTRY_VERSION, workspaces: [] }
  }
  const list = Array.isArray(raw?.workspaces) ? raw.workspaces : []
  const seen = new Set()
  const workspaces = []
  for (const item of list) {
    const member = normalizeHubMember(item)
    if (!member || seen.has(member.path)) continue
    seen.add(member.path)
    workspaces.push(member)
  }
  return { version: HUB_REGISTRY_VERSION, workspaces }
}

function saveHubRegistry(registry) {
  const file = hubRegistryFile()
  ensureDir(dirname(file))
  writeJsonAtomic(file, {
    version: HUB_REGISTRY_VERSION,
    updatedAt: new Date().toISOString(),
    workspaces: registry.workspaces,
  })
  return registry
}

function workspaceNameOf(path) {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

/**
 * 一个成员的读盘摘要：任务来自 flows/，规则来自 config.json。
 * 这就是「添加时顺手导入」的内容——读出来而已，没有搬移。
 */
function hubRules(service, path) {
  const config = service.workspaceOf(path)
  const catalog = ruleCatalog({}, config)
  const known = new Set(catalog.map((rule) => rule.id))
  return {
    configured: Boolean(config?.rules?.ids) || (config?.rules?.custom ?? []).length > 0,
    ids: [...new Set(config?.rules?.ids ?? DEFAULT_RULE_IDS)].filter((id) => known.has(id)),
    custom: catalog.filter((rule) => !DEFAULT_RULE_IDS.includes(rule.id)),
    customCount: catalog.filter((rule) => !DEFAULT_RULE_IDS.includes(rule.id)).length,
    catalog,
  }
}

/** 写接口严格校验；读已有手写配置仍沿用宽容归一策略。 */
function validateHubRules(value) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.ids) || !Array.isArray(value.custom)) {
    throw new Error('rules 必须是 { ids: string[], custom: [{ id, name, points: string[] }] } 或 null')
  }
  const known = new Set(DEFAULT_RULE_IDS)
  const custom = value.custom.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim() ||
        typeof item.name !== 'string' || !item.name.trim() || !Array.isArray(item.points) || item.points.some((point) => typeof point !== 'string')) {
      throw new Error('自定义规则需要非空 id、名称及字符串数组 points')
    }
    const rule = normalizeRuleEntry(item)
    if (known.has(rule.id)) throw new Error('自定义规则 id 重复或与内置规则冲突：' + rule.id)
    known.add(rule.id)
    return rule
  })
  const seen = new Set()
  const ids = value.ids.map((id) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('rules.ids 只能包含非空字符串')
    id = id.trim()
    if (seen.has(id)) throw new Error('启用规则 id 重复：' + id)
    if (!known.has(id)) throw new Error('未知规则 id：' + id)
    seen.add(id)
    return id
  })
  return { ids, custom }
}

function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

function requireHubPath(value) {
  const path = typeof value === 'string' ? value.trim() : ''
  if (!path || !isAbsolute(path)) throw new Error('需要一个绝对目录路径')
  const normalized = resolve(path)
  if (!loadHubRegistry().workspaces.some((member) => resolve(member.path) === normalized)) throw new Error('这个目录尚未添加到工作台')
  if (!isDirectory(normalized)) throw new Error('工作区必须是现存目录')
  return normalized
}

function hubMemberSummary(service, member, includeFlows = false) {
  const path = member.path
  const present = isDirectory(path)
  const flows = present ? hubFlows(service, path) : []
  const rules = present ? hubRules(service, path) : { configured: false, ids: DEFAULT_RULE_IDS, customCount: 0 }
  return {
    path,
    name: workspaceNameOf(path),
    addedAt: member.addedAt ?? null,
    missing: !present,
    ...(includeFlows ? { flows } : {}),
    flowCount: flows.length,
    activeCount: flows.filter((flow) => !flow.finished && !flow.cancelled).length,
    waitingCount: flows.filter((flow) => flow.waiting).length,
    updatedAt: flows[0]?.updatedAt ?? null,
    rules: { configured: rules.configured, ids: rules.ids, customCount: rules.customCount },
  }
}

function routes(scoped, register) {
  const service = SERVICE
  if (!service) throw new Error('flowgate: workbench service 尚未就绪')

  register(API_BASE + '/state', ['GET'], async (request) => {
    try {
      const url = new URL(request.url)
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return json(400, { error: 'sessionId 必填' })
      return json(200, service.view(sessionId))
    } catch (error) {
      return json(500, { error: error?.message ?? String(error) })
    }
  })

  // 左侧栏全局面板用：面板不属于任何会话，靠客户端把工作区路径送过来读盘。
  register(API_BASE + '/hub', ['POST'], async (request) => {
    try {
      let body
      try {
        body = await request.json()
      } catch {
        return json(400, { error: '请求体必须是 JSON' })
      }
      if (typeof body !== 'object' || body === null) return json(400, { error: '请求体必须是对象' })
      return json(200, hubSnapshot(service, body.paths))
    } catch (error) {
      return json(500, { error: error?.message ?? String(error) })
    }
  })

  // 成员名单：面板打开先看这里。空列表就是「用户还没添加过任何工作区」，
  // 界面上应当是空白引导，而不是把宿主里所有工作区摊出来。
  register(API_BASE + '/hub/members', ['POST'], async () => {
    try {
      const registry = loadHubRegistry()
      return json(200, {
        members: registry.workspaces.map((member) => hubMemberSummary(service, member)),
        file: hubRegistryLabel(),
      })
    } catch (error) {
      return json(500, { error: error?.message ?? String(error) })
    }
  })

  // 翻页只输出当前页；冷启动/外部变化时刷新轻量摘要，未变的快照不再解析。
  register(API_BASE + '/hub/flows', ['POST'], async (request) => {
    let body, path, page, pageSize
    try {
      body = await request.json()
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是对象')
      path = requireHubPath(body.path)
      page = body.page === undefined ? 1 : body.page
      pageSize = body.pageSize === undefined ? 10 : body.pageSize
      // 只接受 JSON 正安全整数；超大 pageSize 限到 50，越界页归到最后一页。
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) {
        throw new Error('page 与 pageSize 必须是正安全整数')
      }
      pageSize = Math.min(pageSize, 50)
    } catch (error) {
      return json(400, { error: error?.message ?? String(error) })
    }
    try {
      const flows = hubFlows(service, path)
      const total = flows.length
      const totalPages = Math.max(1, Math.ceil(total / pageSize))
      page = Math.min(page, totalPages)
      return json(200, { flows: flows.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, totalPages })
    } catch (error) {
      return json(500, { error: error?.message ?? String(error) })
    }
  })

  // 与会话/流程无关：自有 rules 字段表示写入，省略字段表示读取。
  register(API_BASE + '/hub/rules', ['POST'], async (request) => {
    let body, path, rules, writing
    try {
      body = await request.json()
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是对象')
      path = requireHubPath(body.path)
      writing = Object.prototype.hasOwnProperty.call(body, 'rules')
      if (writing) rules = validateHubRules(body.rules)
    } catch (error) {
      return json(400, { error: error?.message ?? String(error) })
    }
    try {
      if (writing) service.setWorkspaceRules(path, rules)
      return json(200, { rules: hubRules(service, path) })
    } catch (error) {
      return json(500, { error: error?.message ?? String(error) })
    }
  })

  // 添加：登记路径，顺手把这个目录已有的任务与规则读出来返回。
  // 已经是成员时直接返回现状，不重复登记 —— 幂等，前端可以放心重试。
  register(API_BASE + '/hub/add', ['POST'], async (request) => {
    try {
      let body
      try {
        body = await request.json()
      } catch {
        return json(400, { error: '请求体必须是 JSON' })
      }
      if (typeof body !== 'object' || body === null) return json(400, { error: '请求体必须是对象' })
      const path = typeof body.path === 'string' ? body.path.trim() : ''
      if (!path || !isAbsolute(path)) return json(400, { error: '需要一个绝对目录路径' })
      if (!isDirectory(path)) return json(400, { error: '工作区必须是现存目录：' + path })
      const registry = loadHubRegistry()
      const known = registry.workspaces.find((member) => member.path === path)
      const member = known ?? { path, addedAt: new Date().toISOString() }
      if (!known) {
        registry.workspaces.push(member)
        saveHubRegistry(registry)
      }
      const summary = hubMemberSummary(service, member)
      return json(200, {
        member: summary,
        created: !known,
        // 「顺手导入」：添加的一刻就把它已有的任务与规则读出来。
        imported: {
          flows: summary.flowCount,
          rules: summary.rules.ids ? summary.rules.ids.length : 0,
          customRules: summary.rules.customCount,
        },
      })
    } catch (error) {
      return json(500, { error: error?.message ?? String(error) })
    }
  })

  // 移除：只从名单里拿掉，不动那个目录里的任何文件。
  register(API_BASE + '/hub/remove', ['POST'], async (request) => {
    try {
      let body
      try {
        body = await request.json()
      } catch {
        return json(400, { error: '请求体必须是 JSON' })
      }
      if (typeof body !== 'object' || body === null) return json(400, { error: '请求体必须是对象' })
      const path = typeof body.path === 'string' ? body.path.trim() : ''
      if (!path) return json(400, { error: '缺少 path' })
      const registry = loadHubRegistry()
      const next = registry.workspaces.filter((member) => member.path !== path)
      const removed = next.length !== registry.workspaces.length
      if (removed) saveHubRegistry({ version: registry.version, workspaces: next })
      return json(200, { removed, path })
    } catch (error) {
      return json(500, { error: error?.message ?? String(error) })
    }
  })

  register(API_BASE + '/action', ['POST'], async (request) => {
    try {
      let body
      try {
        body = await request.json()
      } catch {
        return json(400, { error: '请求体必须是 JSON' })
      }
      if (typeof body !== 'object' || body === null) return json(400, { error: '请求体必须是对象' })
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
      if (!sessionId) return json(400, { error: 'sessionId 必填' })
      const action = typeof body.action === 'string' ? body.action : null
      if (!action) return json(400, { error: 'action 必填' })
      const view = await applyAction(service, sessionId, action, body.payload ?? {})
      return json(200, view)
    } catch (error) {
      return json(409, { error: error?.message ?? String(error) })
    }
  })
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

// Cordis 用插件的 name 做诊断与依赖解析（示例插件 dsh-workspace-rules 同样导出 name）。
export const name = 'dsh-flowgate'

/**
 * @param {object} ctx - 宿主上下文。
 */
export function apply(ctx) {
  ctx.inject(['connection', 'tools'], (scoped) => {
    const service = new WorkbenchService(scoped)
    SERVICE = service
    scoped.effect(() => () => {
      for (const controller of service.childRuns.values()) controller.abort()
      service.gates.waiters.clear()
      if (SERVICE === service) SERVICE = null
    }, 'flowgate: workbench service')

    // 门禁路由：客户端只做「拉数据 + 渲染 + 按钮回调」，流程逻辑全在宿主。
    const register = (routePath, methods, handler) => {
      scoped.effect(
        () => scoped.connection.fetch.register({
          path: routePath,
          methods,
          requestBody: 'buffered',
          fetch: handler,
        }),
        'flowgate: ' + methods.join(',') + ' ' + routePath,
      )
    }
    routes(scoped, register)

    // 最终拒绝在可扩展 pre-execute 之后执行，不能被其他插件的 allow 覆盖。
    scoped.effect(() => {
      if (typeof scoped.tools.guard !== 'function') return () => {}
      const remove = scoped.tools.guard((exec) => service.childDenial(exec) ?? undefined)
      service.readonlyGuardReady = true
      return () => {
        service.readonlyGuardReady = false
        remove()
      }
    }, 'flowgate: readonly final guard')

    // scope 守卫：开发阶段只能碰 scope 声明的文件；其余阶段的写操作被拒。
    scoped.effect(
      () => scoped.on('tools/pre-execute', async (exec, next) => {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) return next()
        // 评审 / 测试子代理的会话归到父流程：它们是只读的。
        const ownerId = service.ownerOf(sessionId)
        const readonly = service.childDenial(exec)
        if (readonly) return { kind: 'deny', reason: readonly }
        const flow = service.get(ownerId)
        if (!flow || flow.finished) return next()
        // 工作台靠这条摘要显示「正在做什么」；只放内存，不写快照。
        service.noteActivity(ownerId, exec, flow.stage)
        if (ownerId !== sessionId) {
          return next()
        }
        const denial = scopeDenial(flow, exec.name, exec.arguments)
        if (denial) return { kind: 'deny', reason: denial }
        return next()
      }),
      'flowgate: scope guard',
    )

    // Agent 一停下来，上一条「正在执行命令」就过期了：清掉它，界面回到「等待下一步」。
    // 宿主没这个事件也不影响流程推进，实时进度只是锦上添花。
    scoped.effect(
      () => scoped.on('agent/status', (payload) => {
        try {
          if (payload?.status !== 'idle') return
          const id = payload?.agent?.session?.header?.id
          if (typeof id !== 'string') return
          service.clearActivity(service.ownerOf(id))
        } catch {
          // 事件形状变了就跳过，不要让界面细节拖累流程。
        }
      }),
      'flowgate: activity cleanup',
    )

    const builds = [
      statusTool, startTool, askTool, docTool, gateTool, cancelTool,
      reviewTool, reviewRunTool, testTool, testRunTool,
    ]
    for (const build of builds) {
      scoped.effect(() => scoped.tools.register(build(scoped)), 'flowgate: ' + build.name)
    }
  })
}

/** 当前挂载的宿主服务；供集成测试与宿主内其他插件读取。未装载时为 null。 */
export function currentService() {
  return SERVICE
}

export { WorkbenchService, scopeDenial }
