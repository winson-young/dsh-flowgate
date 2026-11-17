/**
 * dsh-flowgate · host
 *
 * 四阶段流程约束开发工作台。宿主端负责：
 *   - 四阶段状态机（S1 需求分析 → S2 开发 → S3 评审 → S4 测试）
 *   - scope.json 的冻结与守卫（tools/pre-execute 硬拦截）
 *   - 门禁等待（工具挂起，等用户在工作台点按钮）
 *   - flows.jsonl 事件日志与 state.json 快照
 *   - 给客户端用的 /api/flowgate 路由
 *
 * 设计原则见 README：门禁软跳过、硬顺序；评审工具层只读；scope 先冻结；
 * 所有确认都是按钮。
 */

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, readdirSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

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

/** 规则默认全开；overrides.rules 为 null 时用它。 */
const DEFAULT_RULE_IDS = BUILTIN_RULES.map((rule) => rule.id)

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
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
/**
 * 评审 / 测试子代理在工具集里被剥离的能力（PRD 4.3.1）。
 * 这只是第一层：子代理会话的写操作还会被宿主端 pre-execute 守卫硬拦。
 */
const READONLY_DENY = [
  'str_replace_editor',
  'write',
  'edit',
  'subagent',
  'subagent_fork',
  'workflow',
  'send_message',
  'web_search',
]

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

function persist(flow) {
  flow.updatedAt = nowIso()
  try {
    writeJsonAtomic(flowFile(flow.cwd, flow.id), flow)
  } catch {
    // 落盘失败不回滚内存状态：状态机优先，日志与快照是审计用途。
  }
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
// 流程模型
// ---------------------------------------------------------------------------

function emptyStage() {
  return { status: 'pending', gate: 'pending', skipped: false, decidedAt: null, note: null }
}

function createFlow({ sessionId, cwd, title, preset }) {
  const at = nowIso()
  return {
    id: 'f_' + randomUUID().slice(0, 12),
    sessionId,
    cwd,
    title: title || '未命名任务',
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

/** 当前生效的开发规则 id 列表（默认全部内置规则）。 */
function activeRules(flow) {
  const base = flow.overrides?.rules ?? DEFAULT_RULE_IDS
  return base.slice()
}

function ruleCatalog(flow) {
  return BUILTIN_RULES.concat(flow.customRules ?? [])
}

function resolveRules(flow) {
  const catalog = ruleCatalog(flow)
  return activeRules(flow)
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

/** 回退到某一阶段重做；被回退覆盖的阶段重新变为 pending。 */
function rollbackTo(flow, stage, reason) {
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
  appendEvent(flow.cwd, flow, 'flow.rollback', { to: stage, reason })
  persist(flow)
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

/**
 * 只读子代理（S3 评审 / S4 测试）的写操作判定。
 * toolFilter.deny 只是第一层可见性收敛，真正的拦截在这里。
 * @returns {string|null} 拒绝理由；null 表示放行。
 */
function readonlyDenial(name, args, allowShellWrite = false) {
  if (WRITE_TOOLS.has(name)) {
    return (
      '评审 / 测试子代理是只读的：' + name + ' 被宿主端拒绝。' +
      '只允许读文件、读 diff 和执行只读 shell。' +
      (allowShellWrite ? '（用户授权的写权限只覆盖变更性 shell，不覆盖代码写工具。）' : '')
    )
  }
  if (SHELL_TOOLS.has(name)) {
    const command = typeof args?.command === 'string' ? args.command : ''
    // D2：唯一例外——用户在 S4 设置面板显式授权的测试方向可以跑变更性命令。
    if (!allowShellWrite && SHELL_WRITE_HINTS.test(command)) {
      return (
        '评审 / 测试子代理只能执行只读 shell，变更性命令被拒绝：' +
        command.slice(0, 120)
      )
    }
  }
  return null
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
      const settle = (value) => {
        const entry = this.waiters.get(sessionId)
        if (!entry) return
        this.waiters.delete(sessionId)
        if (entry.timer) clearTimeout(entry.timer)
        resolvePromise(value)
      }
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            const entry = this.waiters.get(sessionId)
            if (!entry) return
            this.waiters.delete(sessionId)
            resolvePromise({ kind: 'timeout', detail: '等待用户操作超时' })
          }, timeoutMs)
        : null
      if (timer && typeof timer.unref === 'function') timer.unref()
      this.waiters.set(sessionId, { resolve: settle, reject: rejectPromise, timer, kind })
      if (signal) {
        const onAbort = () => {
          const entry = this.waiters.get(sessionId)
          if (!entry) return
          this.waiters.delete(sessionId)
          if (entry.timer) clearTimeout(entry.timer)
          resolvePromise({ kind: 'aborted', detail: '调用被取消' })
        }
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

class WorkbenchService {
  constructor(ctx) {
    this.ctx = ctx
    this.flows = new Map()
    this.gates = new GateHub()
    this.loaded = new Set()
    /** 子代理会话 → 拥有它的流程会话。评审/测试子代理在这里登记为只读。 */
    this.childOwner = new Map()
  }

  /** 登记一个只读子代理会话；allowShellWrite 承载 D2 的写权限例外。 */
  registerChild(parentSessionId, childSessionId, policy) {
    this.childOwner.set(childSessionId, {
      parent: parentSessionId,
      allowShellWrite: policy?.allowShellWrite === true,
    })
  }

  unregisterChild(childSessionId) {
    this.childOwner.delete(childSessionId)
  }

  /** 子代理会话的归属与权限；不是子会话时返回 null。 */
  childPolicyOf(sessionId) {
    return this.childOwner.get(sessionId) ?? null
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

  start(sessionId, cwd, title, preset) {
    this.hydrate(cwd)
    const existing = this.flows.get(sessionId)
    if (existing && !existing.finished) return existing
    const flow = createFlow({ sessionId, cwd, title, preset })
    flow.stages.S1.status = 'active'
    this.flows.set(sessionId, flow)
    appendEvent(cwd, flow, 'flow.started', { preset: flow.preset, title: flow.title })
    persist(flow)
    return flow
  }

  /** 客户端可见的视图（不含内部等待器等）。 */
  view(sessionId) {
    const flow = this.flows.get(sessionId)
    if (!flow) {
      return { active: false, presets: PRESETS, builtinAngles: BUILTIN_ANGLES, builtinDirections: BUILTIN_DIRECTIONS }
    }
    return {
      active: true,
      id: flow.id,
      title: flow.title,
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
      doc: { ...flow.doc, pending: this.gates.kindOf(sessionId) === 'doc' },
      grill: {
        pending: flow.grill.pending,
        answeredCount: flow.grill.answered.length,
        awaiting: this.gates.kindOf(sessionId) === 'answer',
      },
      angles: resolveAngles(flow),
      angleCatalog: angleCatalog(flow),
      // PRD 4.5：开发规则清单，S2 主区与设置面板都读这两项。
      rules: resolveRules(flow),
      ruleIds: activeRules(flow),
      ruleCatalog: ruleCatalog(flow),
      directions: resolveDirections(flow).map((direction) => ({
        ...direction,
        writeGranted: (flow.writeGrants ?? []).includes(direction.id),
      })),
      directionCatalog: directionCatalog(flow),
      writeGrants: (flow.writeGrants ?? []).slice(),
      review: flow.review,
      test: flow.test,
      devChanges: flow.devChanges,
      waiting: this.gates.has(sessionId),
      waitingKind: this.gates.kindOf(sessionId),
      canSpawn: (() => {
        try {
          const subagents = this.ctx.get('subagents')
          return !!subagents && typeof subagents.start === 'function'
        } catch {
          return false
        }
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
        '当前阶段：' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）',
        '档位：' + PRESETS[flow.preset].label,
        'scope：' + (flow.scope.frozen ? '已冻结（' + (flow.scope.data?.in_scope?.files_expected_to_change ?? []).length + ' 个文件）' : '未冻结'),
      ]
      if (flow.finished) lines.push('状态：流程已结束')
      const skipped = skippedCount(flow)
      if (skipped > 0) lines.push('本流程有 ' + skipped + ' 个阶段被用户跳过')
      if (flow.stage === 'S2') {
        const rules = resolveRules(flow)
        if (rules.length) {
          lines.push('开发规则检查清单（逐条遵守，S3 会逐条核对）：')
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
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '这次任务的简短标题。' },
        preset: {
          type: 'string',
          enum: ['fast', 'strict'],
          description: '执行档位：fast=小功能快速开发（默认），strict=大需求严格执行。',
        },
      },
      required: ['title'],
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
      const flow = SERVICE.start(sessionId, cwd, args.title, args.preset)
      return {
        flowId: flow.id,
        stage: flow.stage,
        preset: flow.preset,
        message:
          '流程已启动（' + PRESETS[flow.preset].label + '），当前 S1 需求分析。' +
          '接下来用 flowgate_ask 一次问一个决策问题，问完后用 flowgate_doc 提交需求文档与 scope。',
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
        return { answered: false, choice: '', custom: '', reason: outcome.detail ?? '未回答' }
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
      if (flow.stage !== 'S1') throw new Error('需求文档只在 S1 阶段提交，当前阶段是 ' + flow.stage + '。')

      flow.doc = {
        html: args.html,
        recommendedPreset: args.recommendedPreset ?? flow.preset,
        reason: args.reason ?? '',
        at: nowIso(),
      }
      flow.pendingScope = args.scope
      appendEvent(cwd, flow, 'doc.submitted', {
        recommendedPreset: flow.doc.recommendedPreset,
        files: args.scope?.files_expected_to_change ?? [],
      })
      persist(flow)

      const outcome = await service.gates.wait(sessionId, 'doc', 0, exec.signal)
      if (outcome.kind === 'revise') {
        // 留住「用户点过修改需求」这件事：客户端据此在空态里说明下一步该做什么。
        flow.doc = { html: null, recommendedPreset: null, reason: null, at: null, revisedAt: nowIso() }
        persist(flow)
        return {
          decision: 'revise',
          preset: flow.preset,
          frozen: false,
          message: '用户要求修改需求。补齐未决项后重新用 flowgate_ask 追问，再重新提交 flowgate_doc。',
        }
      }
      if (outcome.kind !== 'approve' && outcome.kind !== 'skip') {
        return {
          decision: 'timeout',
          preset: flow.preset,
          frozen: false,
          message: '等待用户批准超时，流程停在 S1。',
        }
      }

      // 批准或跳过都会冻结 scope：跳过只影响需求文档评审，不影响 scope 的冻结。
      const frozen = {
        version: 1,
        frozen_at: nowIso(),
        in_scope: {
          files_expected_to_change: args.scope?.files_expected_to_change ?? [],
          capabilities: args.scope?.capabilities ?? [],
        },
        out_of_scope_explicitly: args.scope?.out_of_scope_explicitly ?? [],
        acceptance_criteria: args.scope?.acceptance_criteria ?? [],
      }
      flow.scope = {
        frozen: true,
        frozenAt: frozen.frozen_at,
        data: frozen,
        withoutDocApproval: outcome.kind === 'skip',
      }
      try {
        writeJsonAtomic(join(dataRoot(cwd), 'scope.json'), frozen)
      } catch {
        // 落盘失败不影响内存中的冻结状态。
      }
      appendEvent(cwd, flow, 'scope.frozen', {
        withoutDocApproval: flow.scope.withoutDocApproval,
        files: frozen.in_scope.files_expected_to_change,
      })

      passGate(flow, outcome.kind === 'skip' ? 'skip' : 'pass')
      return {
        decision: outcome.kind,
        preset: flow.preset,
        frozen: true,
        message:
          'scope 已冻结，进入 S2 开发阶段。只能修改：' +
          (frozen.in_scope.files_expected_to_change.join('、') || '（scope 未声明文件）') +
          '。完成后调用 flowgate_gate 等待用户点「完成开发」。',
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
      if (flow.finished) throw new Error('流程已经结束。')
      const stage = flow.stage

      if (stage === 'S2') {
        const changes = await collectChanges(scoped, flow)
        flow.devChanges = changes
        appendEvent(cwd, flow, 'dev.summary', changes)
        persist(flow)
      }
      if (args.summary) flow.gateNote = args.summary

      const outcome = await service.gates.wait(sessionId, 'gate', 0, exec.signal)
      if (outcome.kind === 'timeout' || outcome.kind === 'aborted') {
        return { decision: 'wait', stage, next: stage, message: '门禁还在等待用户操作。' }
      }
      const decision = outcome.decision
      if (decision === 'pass' || decision === 'skip') {
        passGate(flow, decision === 'skip' ? 'skip' : 'pass')
        const next = flow.finished ? '结束' : flow.stage
        return {
          decision,
          stage,
          next,
          message:
            (decision === 'skip' ? '用户跳过了本阶段门禁。' : '用户通过了本阶段门禁。') +
            (flow.finished ? '流程已结束。' : '进入 ' + next + '（' + STAGE_LABEL[next] + '）。'),
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

/** 采集 S2 的变更摘要（文件列表 + 行数），作为门禁凭据。 */
async function collectChanges(scoped, flow) {
  const at = nowIso()
  const empty = { files: [], added: 0, removed: 0, untracked: [], at }
  const shell = scoped.get('shell')
  if (!shell || typeof shell.run !== 'function' || typeof shell.resolve !== 'function') {
    // 采集不到不等于没有变更：把原因留在摘要里，评审子代理才不会被空摘要误导。
    return { ...empty, error: '宿主没有可用的 shell 服务，无法自动采集变更摘要。' }
  }
  try {
    const result = await shell.run(shell.resolve({
      command: 'git status --porcelain=v1 && echo "---numstat---" && git diff --numstat',
      workdir: flow.cwd,
      timeoutMs: 10000,
    }))
    const text = typeof result === 'string' ? result : result?.stdout?.text ?? ''
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
    const all = files.concat(untracked)
    return { files: all, tracked: files, untracked, added, removed, at }
  } catch (error) {
    return { ...empty, error: '采集变更摘要失败：' + (error?.message ?? String(error)) }
  }
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
  const outcome = await service.gates.wait(sessionId, 'gate', 0, exec.signal)
  const decision = decisionOf(outcome)
  if (decision === 'wait') {
    return { decision, next: flow.stage, blocking, message: '门禁还在等待用户操作。' }
  }
  if (decision === 'pass') {
    passGate(flow, 'pass')
    return { decision, next: flow.stage, blocking, message: '评审通过，进入 S4 测试阶段。' }
  }
  if (decision === 'skip') {
    passGate(flow, 'skip')
    return { decision, next: flow.stage, blocking, message: '用户跳过了评审门禁，进入 ' + flow.stage + '。' }
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
    message: decision === 'interrupted'
      ? '用户升档到严格执行并回退到 S2 重做，评审发现已作为重做输入。'
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
  const outcome = await service.gates.wait(sessionId, 'gate', 0, exec.signal)
  const decision = decisionOf(outcome)
  if (decision === 'wait') {
    return { decision, next: flow.stage, failed, message: '门禁还在等待用户操作。' }
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

function reviewRunTool(scoped) {
  return {
    name: 'flowgate_review_run',
    description: [
      'S3 评审的宿主驱动版本：宿主为每个启用的评审角度 spawn 一个只读子代理，',
      '收集结构化报告后聚合，然后挂起等待用户在门禁上点「通过评审」或「退回开发修复」。',
      '子代理的写工具被 toolFilter 剥离，且其会话在宿主守卫里登记为只读——两层都是硬约束。',
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
      if (flow.stage !== 'S3') {
        throw new Error('评审子代理只在 S3 阶段运行，当前阶段是 ' + flow.stage + '。')
      }
      const angles = resolveAngles(flow)
      if (!angles.length) throw new Error('当前没有启用的评审角度，先在阶段设置里勾选至少一个。')

      const reports = []
      for (const angle of angles) {
        reports.push(await runAngle(scoped, service, flow, exec.agent, exec.signal, angle))
      }
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
      if (flow.stage !== 'S4') {
        throw new Error('测试子代理只在 S4 阶段运行，当前阶段是 ' + flow.stage + '。')
      }
      const directions = resolveDirections(flow)
      if (!directions.length) throw new Error('当前没有启用的测试方向，先在阶段设置里勾选至少一个。')

      const results = []
      for (const direction of directions) {
        results.push(await runDirection(scoped, service, flow, exec.agent, exec.signal, direction))
      }
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

/**
 * spawn 一个只读子代理并等它跑完。
 * toolFilter.deny 剥离写工具；子代理会话同时登记到 service.childOwner，
 * 让宿主端的 pre-execute 守卫对它也生效——两层都不是提示词建议。
 */
async function spawnReadonlyChild(scoped, service, flow, parentAgent, signal, spec) {
  const subagents = scoped.get('subagents')
  if (!subagents || typeof subagents.start !== 'function') {
    throw new Error(
      '宿主没有可用的 subagents 服务，无法 spawn 只读子代理。' +
      '改用 flowgate_review / flowgate_test 由主会话自行组织只读评审与测试。',
    )
  }
  let providers = []
  try {
    providers = subagents.list()
  } catch {
    providers = []
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error(
      '宿主没有注册任何子代理 provider，无法 spawn 只读子代理。' +
      '改用 flowgate_review / flowgate_test 由主会话自行组织只读评审与测试。',
    )
  }
  const provider = providers.includes('spawn') ? 'spawn' : providers[0]
  // toolFilter 不允许命名未知的全局工具，先与当前可见工具取交集。
  const deny = READONLY_DENY.filter((toolName) => {
    try {
      return typeof scoped.tools?.get === 'function' && !!scoped.tools.get(toolName)
    } catch {
      return false
    }
  })

  const run = await subagents.start(provider, {
    label: spec.label,
    prompt: [{ type: 'text', text: spec.prompt }],
    parent: parentAgent,
    signal,
    ...(deny.length ? { toolFilter: { deny } } : {}),
  })
  service.registerChild(flow.sessionId, run.id, { allowShellWrite: spec.allowShellWrite === true })
  try {
    const result = await run.result
    return result
  } finally {
    service.unregisterChild(run.id)
    try {
      await run.dispose()
    } catch {
      // dispose 失败不影响报告。
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

function anglePrompt(flow, angle) {
  const scope = flow.scope.data ?? {}
  const rules = RULE_CHECKING_ANGLES.has(angle.id) ? resolveRules(flow) : []
  return [
    '你是只读评审子代理，评审角度：' + angle.name + '。',
    '你只能读代码、读 diff、执行只读 shell。任何写操作都会被宿主端拒绝。',
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
      : '你只能执行只读命令（跑测试、读输出、grep）。任何写操作都会被宿主端拒绝。',
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
      prompt: anglePrompt(flow, angle),
    })
    if (result?.stopReason && result.stopReason !== 'completed') {
      throw new Error('子代理未正常结束（' + result.stopReason + '）')
    }
    const report = parseReport(outputText(result?.output))
    if (!report) throw new Error('子代理没有返回可解析的 JSON 报告')
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
    const verdict = ['pass', 'blocking', 'advisory'].includes(report.verdict) ? report.verdict : 'advisory'
    return {
      id: angle.id,
      name: angle.name,
      verdict,
      suggestUpgrade: report.suggestUpgrade === true,
      findings,
    }
  } catch (error) {
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
    })
    if (result?.stopReason && result.stopReason !== 'completed') {
      throw new Error('子代理未正常结束（' + result.stopReason + '）')
    }
    const report = parseReport(outputText(result?.output))
    if (!report || !Array.isArray(report.points)) throw new Error('子代理没有返回可解析的 JSON 报告')
    const resolved = report.points
      .filter((item) => item && typeof item.point === 'string')
      .map((item) => ({
        point: item.point,
        result: ['pass', 'fail', 'uncovered'].includes(item.result) ? item.result : 'uncovered',
        detail: typeof item.detail === 'string' ? item.detail : undefined,
      }))
    return { id: direction.id, name: direction.name, points: resolved.length ? resolved : points }
  } catch (error) {
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
 * 应用一次客户端操作。返回新的视图；无法应用时抛错。
 */
async function applyAction(service, sessionId, action, payload) {
  const flow = service.get(sessionId)

  if (action === 'start') {
    if (!flow) throw new Error('流程尚未在宿主端初始化，先在对话里调用 flowgate_start。')
    return service.view(sessionId)
  }
  if (!flow) throw new Error('当前会话没有流程。')

  const gates = service.gates

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
      if (!gates.notify(sessionId, { kind: decision }, 'doc')) {
        throw new Error('当前没有等待中的需求文档门禁。')
      }
      break
    }
    case 'gate': {
      const decision = payload?.decision
      if (!['pass', 'skip', 'back'].includes(decision)) throw new Error('decision 必须是 pass / skip / back')
      if (!gates.notify(sessionId, { decision, to: payload?.to }, 'gate')) {
        throw new Error('当前没有等待中的门禁。')
      }
      break
    }
    case 'preset': {
      const preset = payload?.preset
      if (!PRESETS[preset]) throw new Error('未知档位')
      flow.preset = preset
      flow.overrides = { angles: null, directions: null }
      appendEvent(flow.cwd, flow, 'preset.set', { preset })
      persist(flow)
      break
    }
    case 'upgrade': {
      const target = payload?.preset ?? 'strict'
      if (!PRESETS[target]) throw new Error('未知档位')
      const from = flow.preset
      flow.preset = target
      flow.overrides = { angles: null, directions: null }
      appendEvent(flow.cwd, flow, 'preset.upgraded', { from, to: target, stage: flow.stage })
      // 评审阶段升档且评审确实发现了问题 → 回到 S2 重做（scope 不扩充）。
      const foundProblems = flow.review && flow.review.blocking > 0
      if (flow.stage === 'S3' && foundProblems) {
        // 评审工具还挂在门禁上：先告诉它被升档中断，否则它会一直等下去。
        gates.notify(sessionId, { decision: 'interrupted', to: 'S2' }, 'gate')
        rollbackTo(flow, 'S2', 'upgrade-after-review')
      } else {
        persist(flow)
      }
      break
    }
    case 'toggleRule': {
      const id = payload?.id
      if (!ruleCatalog(flow).some((rule) => rule.id === id)) throw new Error('未知的开发规则：' + id)
      const enabled = payload?.enabled !== false
      const set = new Set(flow.overrides.rules ?? DEFAULT_RULE_IDS)
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
      const set = new Set(flow.overrides.rules ?? DEFAULT_RULE_IDS)
      set.add(item.id)
      flow.overrides.rules = Array.from(set)
      appendEvent(flow.cwd, flow, 'rule.added', { name })
      persist(flow)
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

    // scope 守卫：开发阶段只能碰 scope 声明的文件；其余阶段的写操作被拒。
    scoped.effect(
      () => scoped.on('tools/pre-execute', async (exec, next) => {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) return next()
        // 评审 / 测试子代理的会话归到父流程：它们是只读的。
        const ownerId = service.ownerOf(sessionId)
        const flow = service.get(ownerId)
        if (!flow || flow.finished) return next()
        if (ownerId !== sessionId) {
          // D2：已授权的测试方向可以跑变更性 shell，代码写工具仍然拒绝。
          const policy = service.childPolicyOf(sessionId)
          const readonly = readonlyDenial(exec.name, exec.arguments, policy?.allowShellWrite === true)
          if (readonly) return { kind: 'deny', reason: readonly }
          return next()
        }
        const denial = scopeDenial(flow, exec.name, exec.arguments)
        if (denial) return { kind: 'deny', reason: denial }
        return next()
      }),
      'flowgate: scope guard',
    )

    const builds = [
      statusTool, startTool, askTool, docTool, gateTool,
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
