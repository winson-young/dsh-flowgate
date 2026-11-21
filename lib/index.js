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
import { deriveTitle, prepareRequirement, sanitizeTitle } from './requirements.js'
import { captureSnapshot, sameSnapshot, findingCounts } from './provenance.js'
import { normalizeCriteria, acceptanceLedger, remediationList, scopeReadiness, stageSummary } from './acceptance.js'
import { runtimeState } from './runtime.js'
import { registerModuleRevision } from './revisions.js'

export const FLOWGATE_MODULE_REVISION = '4186606f4ad28671d822788fc0c20a72abc2728df449c4cba30594a934c67657'
registerModuleRevision(import.meta.url, FLOWGATE_MODULE_REVISION)

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

/** 需求分析规则可配置；阶段顺序、scope 冻结及门禁仍由宿主强制执行。 */
const BUILTIN_ANALYSIS_RULES = [
  { id: 'clarify-goal', name: '明确目标与约束', points: ['从需求原文确认目标、预期行为与必要约束', '只追问现有信息无法回答的关键决策，一次一个问题'] },
  { id: 'define-scope', name: '界定实施范围', points: ['列出允许修改的具体文件与不在范围内的事项', '说明方案、依赖与风险，等待用户批准 scope 后开发'] },
  { id: 'acceptance-evidence', name: '明确验收证据', points: ['给出可观察、可验证的验收标准', '覆盖必要的边界、异常和相邻功能影响'] },
]

/** 内置评审角度。工作区可修改内容，原始定义保留用于对照。 */
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
    analysisRules: ['clarify-goal', 'define-scope'],
    angles: ['correctness', 'tests'],
    directions: ['smoke'],
    grillDepth: 'shallow',
  },
  strict: {
    id: 'strict',
    label: '大需求严格执行',
    summary: '四个评审角度、三个测试方向，追问走完决策树各分支。',
    analysisRules: BUILTIN_ANALYSIS_RULES.map((rule) => rule.id),
    angles: ['security', 'correctness', 'tests', 'style'],
    directions: ['functional', 'boundary', 'regression'],
    grillDepth: 'deep',
  },
}

const STAGE_KEYS = { S1: 'analysisRules', S2: 'rules', S3: 'angles', S4: 'directions' }
const STAGE_CUSTOM_KEYS = { S1: 'customAnalysisRules', S2: 'customRules', S3: 'customAngles', S4: 'customDirections' }

/**
 * 只读 / 无磁盘副作用的工具：显式登记，登记过才跳过 scope 判定。
 *
 * 这里原来是「写工具黑名单」，黑名单的问题是宿主新增一个写工具就静默放行——
 * 漏登记等于开后门。翻成白名单后，漏登记的后果是「被拒绝」，逼着维护者补登记。
 */
const PASSIVE_TOOLS = new Set([
  // 读取
  'read', 'read_image', 'glob', 'grep',
  'ops_read_files', 'ops_inspect_local_file', 'ops_stat', 'ops_glob', 'ops_grep', 'ops_diff',
  'ops_result', 'ops_load_sdk', 'load_workspace_dependencies', 'working_directory',
  'todo_write', 'present',
  // 会话 / 任务调度
  'job_output', 'job_list', 'job_kill', 'list_agents', 'list_subagent_models',
  'wait_agent', 'send_message', 'interrupt_agent', 'subagent', 'subagent_fork',
  'ask_user_question', 'schedule_list', 'schedule_view', 'schedule_create', 'schedule_edit',
  // 上下文管理
  // 注意 decompress 不在这里：它带 toFile 参数，能把内容写进任意文件，要走写目标判定。
  'compress', 'search_context', 'acp_cache', 'acp_status',
  'acp_read_original_image', 'get_goal', 'update_goal', 'create_goal', 'suggest_workspace_rule',
  // skill 只把说明文本读进上下文，不碰项目磁盘。漏登记会让技能在流程运行期间整体不可用。
  'skill',
  // 网络检索：不碰本地磁盘
  'web_fetch', 'web_search', 'multi_search', 'advanced_search', 'video_search',
  'platform_search', 'domain_search', 'research', 'cache_search', 'free_search_test', 'weather',
  // flowgate 自己的工具：状态变更由插件内部校验，不走文件守卫
  'flowgate_status', 'flowgate_start', 'flowgate_ask', 'flowgate_doc', 'flowgate_gate',
  'flowgate_cancel', 'flowgate_review', 'flowgate_test', 'flowgate_review_run', 'flowgate_test_run',
])

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

/**
 * 只读 shell 白名单。不看阶段，任何时候都放行。
 * 黑名单（原来的 SHELL_WRITE_HINTS）在这个维度上不可能穷举：node -e / python -c /
 * deno eval / npx tsc 都是写通道，实测全部漏网。
 */
const SHELL_READONLY = /^(?:pwd|ls|cat|head|tail|wc|echo|node\s+--version|npm\s+(?:--version|-v)|git\s+(?:status|diff|log|show|rev-parse|ls-files))(?:[ \t]+[^\r\n|;&`$<>]*)?$/u

/**
 * git branch 单独收紧。通用白名单允许尾部带任意参数，于是
 * `git branch -a --delete main` 能借 -a 通过白名单，再把分支删掉。
 * 这里只允许一个只读选项，外加一个不以 - 开头的分支名过滤模式（`git branch --list 'feat*'`）。
 */
const SHELL_GIT_BRANCH = /^git[ \t]+branch(?:[ \t]*|[ \t]+(?:--list|-a|-v|--show-current)(?:[ \t]+(?!-)[^\r\n|;&`$<>]*)?[ \t]*)$/u

/**
 * A 档：纯解析命令，只读源码不执行它。任何阶段都放行，也不需要用户授权。
 * `node --check` 只做语法解析，连 require 都不会跑；`tsc --noEmit` 只做类型检查，不产出文件。
 * 这一类命令被拦掉的收益是零，代价却是每次都要用户点一次授权，所以单独列出来。
 */
const SHELL_PARSE_ONLY = /^(?:node[ \t]+--check|tsc[ \t]+--noEmit)(?:[ \t]+[^\r\n|;&`$<>]*)?$/u

/** 审计流水里保留的命令原文上限；超长命令截断并标记，避免一条命令撑爆日志。 */
const SHELL_AUDIT_LIMIT = 200
// 修改意见的长度上限：客户端与宿主共用同一口径，超出的部分在事件里留 truncated 痕迹。
const REVISION_NOTE_LIMIT = 2000
/** scope 命令清单的上限：单条长度与条数。清单是要用户逐个过目的，不能变成一堵墙。 */
const SCOPE_COMMAND_LIMIT = 300
const SCOPE_COMMAND_MAX = 20
/** scope 影响面清单（本次会动的共用契约）的上限：单条长度与条数。 */
const SCOPE_CONTRACT_LIMIT = 400
const SCOPE_CONTRACT_MAX = 12
/**
 * 用户声明的「额外只读工具」上限。
 * 宿主新增一个只读工具，插件不认识就一律拒绝——这条默认拒绝本身是对的，
 * 但缺一个用户可控的出口，流程就会被一个刷新入口整段卡死（实机踩到）。
 */
const TOOL_ALLOW_LIMIT = 12
const TOOL_ALLOW_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u

/**
 * shell 里的逃逸痕迹：重定向、管道、子 shell、解释器内联执行、把输出写进文件的选项。
 * 命中一律拒绝，不看阶段。`--output` 单列出来是因为 `git diff --output=x` 能把内容写进任意文件。
 */
const SHELL_ESCAPE_HINTS = /[|;&`$<>]|\s--output(?:=|\s)|\b(?:node|nodejs|python|python3|perl|ruby|deno|bun|pwsh|powershell|cmd|bash|sh|npx|npx\.cmd)\b[^\n]*(?:\s-e\b|\s-c\b|\s--eval\b|\beval\b)/u

/**
 * 无害的输出收尾：`2>&1`、`> /dev/null`、`| tail -n 20`、`| head -50`。
 *
 * 这些既不写盘也不换执行体，但原来的逃逸检查把它们和真正的管道一视同仁，
 * 结果是已授权的测试命令 `npm test 2>&1 | tail -20` 永远跑不了——测试方向只能记
 * uncovered，最后又变成一次带缺口结项。只剥末尾，且每段形状固定：
 * `npm test | tee out` 剥不动，照旧被拒。
 */
const SHELL_HARMLESS_SUFFIX = /(?:\s*\|\s*(?:head|tail)(?:\s+-n\s*\d+|\s+-\d+)?|\s*[12]?\s*>\s*\/dev\/null|\s*[12]?\s*>&\s*[12])\s*$/u

/** 反复剥到稳定：`npm test 2>&1 | tail -5` 要两层都剥掉。 */
function stripHarmlessSuffixes(command) {
  let base = command
  for (let guard = 0; guard < 8; guard += 1) {
    const next = base.replace(SHELL_HARMLESS_SUFFIX, '').trim()
    if (next === base) break
    base = next
  }
  return base
}

/** Windows 路径大小写不敏感，比较 scope 时必须统一大小写，否则 scope 内的文件会被误拒。 */
const compareKey = (value) => (process.platform === 'win32' ? String(value).toLowerCase() : String(value))

/**
 * run_code 里能绕过工具层的 Node IO 痕迹。
 * run_code 是 PTC：程序里直接 await import('node:fs') 就能写盘，pre-execute 完全看不到。
 * 实测在 S1 阶段用 fs.writeFileSync 成功写出文件，所以这里必须拦。
 */
const RUN_CODE_IO_HINTS = /(?:\bimport\s*\(|\brequire\s*\(|node:fs|node:child_process|node:net|node:http|\bchild_process\b|\bprocess\.(?:binding|dlopen|mainModule)|\bglobalThis\b|\bDeno\b|\bBun\b|\bfs\s*\.|\bwriteFile|\bappendFile|\bunlink|\brmdir|\brenameSync|\bmkdirSync|\bcopyFile|\bcreateWriteStream|\bFunction\s*\(|\beval\s*\(|\bconstructor\s*[.[])/

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

/** 流程数据目录：插件自己维护，工具层一律不许写（见 targetDenial）。 */
/**
 * 提交时规范化 scope：文件白名单转成项目内相对路径，越界条目剔除并回报。
 * 越界条目不能静默丢弃——要让 Agent 和用户都看见「你声明的这条不算数」。
 */
function normalizePendingScope(cwd, scope) {
  const source = scope && typeof scope === 'object' ? scope : {}
  const files = []
  const dropped = []
  for (const entry of Array.isArray(source.files_expected_to_change) ? source.files_expected_to_change : []) {
    const normalized = normalizeScopeEntry(cwd, entry)
    if (normalized === null) dropped.push(String(entry))
    else if (!files.includes(normalized)) files.push(normalized)
  }
  const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [])
  // 「本次会动的共用契约与已知约束」：S1 必须显式声明影响面。
  // 缺了它，评审只能猜「这条发现算不算本次开发范围内的」，最终就退化成照 diff 挑刺。
  const contracts = []
  for (const entry of strings(source.shared_contracts)) {
    const text = entry.trim().slice(0, SCOPE_CONTRACT_LIMIT)
    if (!text || contracts.includes(text) || contracts.length >= SCOPE_CONTRACT_MAX) continue
    contracts.push(text)
  }
  // 命令清单是用户逐条过目的授权：无效条目不能静默剔掉。
  // 原来 `node -e *` 这种永远不可能被放行的条目会被安静存下来——界面显示有这条，
  // 实际每次都被逃逸检查拦掉，用户与 Agent 都以为「已经授权过了」。
  const commands = []
  const commandErrors = []
  for (const entry of strings(source.commands)) {
    const text = entry.trim()
    if (!text) {
      commandErrors.push('有一条空命令条目')
      continue
    }
    if (text.length > SCOPE_COMMAND_LIMIT) {
      commandErrors.push('这条命令超过 ' + SCOPE_COMMAND_LIMIT + ' 字：' + text.slice(0, 60) + '…')
      continue
    }
    // 判定与真实放行同源：逃逸检查在清单匹配之前，所以命中的条目永远不会生效。
    if (SHELL_ESCAPE_HINTS.test(stripHarmlessSuffixes(text))) {
      commandErrors.push('这条命令含重定向 / 管道 / 解释器内联，永远不会被放行：' + text)
      continue
    }
    if (commands.includes(text)) continue
    commands.push(text)
  }
  if (commands.length > SCOPE_COMMAND_MAX) {
    commandErrors.push('共 ' + commands.length + ' 条命令，超过上限 ' + SCOPE_COMMAND_MAX + ' 条')
  }
  // 来源标注只服务体检与界面解释，不进冻结的 scope.json：
  // 它是「怎么想出来的」过程记录，不是这份授权的条款，混进冻结结构会让每次推导变化都像改了授权。
  const commandSources = []
  for (const entry of Array.isArray(source.command_sources) ? source.command_sources : []) {
    if (!entry || typeof entry !== 'object') continue
    const command = typeof entry.command === 'string' ? entry.command.trim() : ''
    if (!command || !commands.includes(command)) continue
    if (commandSources.some((item) => item.command === command)) continue
    commandSources.push({
      command,
      from: typeof entry.from === 'string' ? entry.from.trim().slice(0, 200) : '',
      acs: strings(entry.acs).map((id) => id.trim()).filter(Boolean).slice(0, 20),
    })
  }
  return {
    scope: {
      files_expected_to_change: files,
      // 允许直接执行的命令清单：用户批准 scope 时一并过目，S2/S4 命中即放行。
      commands,
      command_sources: commandSources,
      capabilities: strings(source.capabilities),
      shared_contracts: contracts,
      out_of_scope_explicitly: strings(source.out_of_scope_explicitly),
      acceptance_criteria: normalizeCriteria(source.acceptance_criteria),
    },
    dropped,
    commandErrors,
  }
}

function validatedPendingScope(cwd, scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !Array.isArray(scope.files_expected_to_change)) {
    throw new Error('scope.files_expected_to_change 必须在 scope 根层声明为文件数组（不要放在 in_scope 中）。')
  }
  if (!Array.isArray(scope.commands)) {
    throw new Error('scope.commands 必须在 scope 根层声明为命令数组；无需执行命令时请填写 []。')
  }
  const normalized = normalizePendingScope(cwd, scope)
  if (!normalized.scope.files_expected_to_change.length) {
    throw new Error('scope.files_expected_to_change 没有有效的项目内文件，不能提交或冻结空文件清单。')
  }
  // 无效命令条目在这里就报错：静默剔除会让用户以为授权已经生效。
  if (normalized.commandErrors.length) {
    throw new Error(
      'scope.commands 有无法生效的条目，请先修正再提交：\n- ' +
      normalized.commandErrors.join('\n- ') +
      '\n命令清单里的条目会被用户在批准 scope 时逐条过目，所以这里不接受「存下来但永远不生效」的写法。',
    )
  }
  return normalized
}

function isInsideDataDir(relOrAbs) {
  const key = compareKey(String(relOrAbs).replaceAll('\\', '/'))
  const marker = compareKey(DATA_DIR)
  // 相对形式是「.dsh-flowgate/…」；越界或绝对形式是「../.dsh-flowgate/…」「D:/x/.dsh-flowgate/…」。
  // 只看前缀会把后两种漏掉：子代理的 cwd 可能不在项目根，绝对路径照样能写进来。
  return key === marker || key.startsWith(marker + '/') ||
    key.includes('/' + marker + '/') || key.endsWith('/' + marker)
}

/**
 * 一次调用可能碰到的全部目标路径；null = 这个工具没有登记，默认拒绝。
 * @returns {{path: string, prefix?: boolean}[]|null}
 */
function scopeTargetsOf(name, args) {
  switch (name) {
    case 'write': case 'edit': case 'str_replace_editor':
    case 'ops_write_file': case 'ops_edit_file': case 'ops_remove': {
      const target = writeTargetOf(name, args)
      return target ? [{ path: target }] : []
    }
    case 'ops_move': case 'ops_copy':
      return [args?.path, args?.to].filter((value) => typeof value === 'string' && value.length > 0)
        .map((value) => ({ path: value }))
    case 'decompress':
      // 只有带 toFile 时才碰磁盘；不带时是纯上下文操作。
      return typeof args?.toFile === 'string' && args.toFile.length > 0 ? [{ path: args.toFile }] : []
    case 'ops_replace':
      // path 在这里是 glob 根目录，按目录前缀判定，不能当单文件比较
      return typeof args?.path === 'string' && args.path.length > 0 ? [{ path: args.path, prefix: true }] : []
    case 'ops_batch': {
      const operations = Array.isArray(args?.operations) ? args.operations : []
      // root 是批量的基准目录，path 相对它解析。忽略 root 会把 D:/evil.txt 当成项目内的 evil.txt 放行。
      const root = typeof args?.root === 'string' && args.root.length > 0 ? args.root : null
      return operations
        .flatMap((op) => [op?.path, op?.to])
        .filter((value) => typeof value === 'string' && value.length > 0)
        .map((value) => ({ path: root ? resolve(root, value) : value }))
    }
    default:
      return null
  }
}

/**
 * 把 scope 条目规范化成项目内的相对路径。项目根之外的条目返回 null（调用方负责剔除并告知）。
 * 这条是 P0-4 的根因：原来绝对路径条目会被 normalizeTarget 原样返回，等于给任意文件开通行证。
 */
function normalizeScopeEntry(cwd, entry) {
  if (typeof entry !== 'string' || !entry.trim()) return null
  // 用 relative 判定越界：越界会得到以 .. 开头或另一个盘符的绝对路径。
  const absolute = isAbsolute(entry) ? entry : resolve(cwd, entry)
  const rel = relative(cwd, absolute)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.replaceAll(sep, '/')
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
  // 临时名带上随机后缀：同一个进程里两个流程快照并发写同一文件时，只用 pid 会互相覆盖。
  const tmp = file + '.tmp-' + process.pid + '-' + randomUUID().slice(0, 8)
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 单个流程快照里保留的事件条数上限；完整流水在 flows.jsonl。 */
/** 单个流程快照的体积上限：超过就不参与冷恢复，避免一个坏文件拖垮整个工作区。 */
const SNAPSHOT_LIMIT = 8 * 1024 * 1024
/** 评审角度 / 测试方向单次提交的条数上限：报告会随快照全量落盘，条数必须有边界。 */
const REPORT_ENTRY_LIMIT = 40
/** 单个测试方向最多保留的验证要点条数。 */
const POINT_LIMIT = 200
/** 工作台最多登记的工作目录数：每次打开面板都要逐个目录读快照。 */
const HUB_MEMBER_LIMIT = 50
/** 单个评审角度最多保留的发现条数；超出的部分会以一条 MINOR 说明省略了多少。 */
const FINDINGS_LIMIT = 200
/**
 * fast 档位下单个角度最多保留的发现条数。
 *
 * 小功能快速开发这一档的意义是「别把一次小改动拖成一场评审马拉松」：
 * 一个角度列 20 条建议，用户点「退回」时无法逐条取舍，只能整轮重来。
 * 上限按严重度取最重要的几条，被截掉的条数单独留痕，不静默丢掉。
 */
const FAST_FINDING_CAP = 3
/** 单条发现摘要的字符上限；超长截断并加标记。 */
const FINDING_SUMMARY_LIMIT = 400
const EVENT_LIMIT = 500

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
  // 事件是审计流水，不是状态机：只留最近的一段，避免快照随流程寿命无限增长。
  // 完整的流水另有 flows.jsonl 追加记录，不会因为这里的截断而丢失。
  if (flow.events.length > EVENT_LIMIT) flow.events.splice(0, flow.events.length - EVENT_LIMIT)
  try {
    ensureDir(dataRoot(cwd))
    appendFileSync(join(dataRoot(cwd), 'flows.jsonl'), JSON.stringify(record) + '\n', 'utf8')
  } catch {
    // 日志失败不影响流程本身。
  }
  return record
}

// 缓存列表摘要与进行中需求文本，不保留 events、scope、报告等完整快照；工作区按 LRU 限定数量。
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
  // 先清掉上一次的失败记录：成功写盘时快照里不该残留旧告警。
  flow.persistError = null
  try {
    writeJsonAtomic(file, flow)
  } catch (error) {
    // 落盘失败不回滚内存状态：状态机优先，日志与快照是审计用途。
    // 但也不能装作没发生：冷恢复后状态会退回旧快照，界面必须能看见这条。
    flow.persistError = { at: nowIso(), message: error?.message ? String(error.message).slice(0, 200) : '写盘失败' }
  }
  const cached = hubFlowCache.get(resolve(flow.cwd))
  if (cached) {
    try {
      cached.set(flow.id + '.json', { signature: fileSignature(file), summary: hubFlowSummary(null, flow), requirement: activeRequirement(flow) })
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
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
  }
  const present = new Set(names)
  for (const name of cached.keys()) if (!present.has(name)) cached.delete(name)
  for (const name of names) {
    let signature, raw
    try {
      const file = join(dir, name)
      signature = fileSignature(file)
      if (cached.has(name) && cached.get(name).signature === signature) continue
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      cached.delete(name)
      continue
    }
    let summary = null, requirement = null
    try {
      const flow = JSON.parse(raw)
      if (flow && typeof flow.id === 'string' && typeof flow.sessionId === 'string') {
        summary = hubFlowSummary(null, flow)
        requirement = activeRequirement(flow)
      }
    } catch {
      // 坏 JSON 记住签名；I/O 失败则向上报错，不能当作没有进行中的流程。
    }
    cached.set(name, { signature, summary, requirement })
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

/** 只有进行中卡片需要全文；历史列表继续保留短摘要。 */
function activeRequirement(flow) {
  if (flow.finished || flow.cancelled) return null
  return { brief: String(flow.brief ?? '') }
}

function hubCurrentFlow(service, cwd, current) {
  if (!current) return null
  const live = service.get(current.sessionId)
  const requirement = live?.id === current.id
    ? activeRequirement(live)
    : [...(hubFlowCache.get(resolve(cwd))?.values() ?? [])].find((entry) => entry.summary?.id === current.id)?.requirement
  return { ...current, ...requirement }
}

function loadFlowsFromDisk(cwd) {
  const dir = join(dataRoot(cwd), 'flows')
  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
    throw error
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let raw
    try {
      // 快照是自己写的，但坏文件（手改、写到一半断电）不该把整个流程功能拖死：
      // 超过上限的直接跳过，恢复是尽力而为，不是数据修复。
      if (statSync(join(dir, name)).size > SNAPSHOT_LIMIT) continue
      raw = readFileSync(join(dir, name), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      throw error
    }
    try {
      out.push(JSON.parse(raw))
    } catch {
      // 坏 JSON 跳过；读取失败时必须中止恢复，允许修复权限后重试。
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
const WORKSPACE_CONFIG_VERSION = 2

function workspaceConfigFile(cwd) {
  return join(dataRoot(cwd), 'config.json')
}

/** 给界面展示的路径：不把机器上的绝对路径泄到工作台里。 */
function workspaceConfigLabel() {
  return DATA_DIR + '/config.json'
}

function normalizeRuleEntry(item, stage = 'S2') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const id = typeof item.id === 'string' ? item.id.trim() : ''
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  if (!id || !name) return null
  const points = Array.isArray(item.points)
    ? item.points.map((point) => String(point).trim()).filter(Boolean)
    : String(item.points ?? '').split('\n').map((point) => point.trim()).filter(Boolean)
  const entry = { id, name, points }
  if (stage === 'S4' && typeof item.needsWrite === 'boolean') entry.needsWrite = item.needsWrite
  return entry
}

function builtinStageItems(stage) {
  return { S1: BUILTIN_ANALYSIS_RULES, S2: BUILTIN_RULES, S3: BUILTIN_ANGLES, S4: BUILTIN_DIRECTIONS }[stage] ?? []
}

function stageDefaultIds(stage, preset = 'fast') {
  if (stage === 'S2') return DEFAULT_RULE_IDS.slice()
  return (PRESETS[preset] ?? PRESETS.fast)[STAGE_KEYS[stage]]?.slice() ?? []
}

/** 手写配置宽容读取：无效条目忽略，绝不把配置字段作为流程授权。 */
function normalizeWorkspaceStage(value, stage) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const builtinIds = new Set(builtinStageItems(stage).map((entry) => entry.id))
  const custom = [], edits = [], customIds = new Set(), editIds = new Set()
  for (const raw of Array.isArray(value.custom) ? value.custom : []) {
    const entry = normalizeRuleEntry(raw, stage)
    if (!entry || builtinIds.has(entry.id) || customIds.has(entry.id)) continue
    customIds.add(entry.id)
    custom.push(entry)
  }
  for (const raw of Array.isArray(value.edits) ? value.edits : []) {
    const entry = normalizeRuleEntry(raw, stage)
    if (!entry || !builtinIds.has(entry.id) || editIds.has(entry.id)) continue
    editIds.add(entry.id)
    edits.push(entry)
  }
  const known = new Set([...builtinIds, ...customIds])
  const ids = Array.isArray(value.ids)
    ? [...new Set(value.ids.filter((id) => typeof id === 'string').map((id) => id.trim()))].filter((id) => known.has(id))
    : null
  return { ids, custom, edits }
}

function workspaceStage(workspace, stage) {
  if (workspace?.stages && Object.prototype.hasOwnProperty.call(workspace.stages, stage)) return workspace.stages[stage]
  return stage === 'S2' ? workspace?.rules ?? null : null
}

function loadWorkspaceConfig(cwd) {
  const file = workspaceConfigFile(cwd)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const stages = Object.fromEntries(STAGES.map((stage) => {
      const value = raw.stages && Object.prototype.hasOwnProperty.call(raw.stages, stage)
        ? raw.stages[stage] : stage === 'S2' ? raw.rules : null
      return [stage, normalizeWorkspaceStage(value, stage)]
    }))
    return { version: WORKSPACE_CONFIG_VERSION, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null, stages, rules: stages.S2 }
  } catch {
    // 坏文件当没配置；已知旧版 rules 仅迁移到 S2，绝不扩大授权。
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

function createFlow({ sessionId, cwd, title, preset, brief }) {
  const at = nowIso()
  // 类型写错时不能静默当成空串：需求原文是 S1 唯一的分析依据，
  // 悄悄丢掉之后流程还能照常跑，用户与 Agent 都会以为需求已经被记录下来了。
  if (brief !== undefined && brief !== null && typeof brief !== 'string') {
    throw new Error('需求原文必须是字符串，收到的是 ' + typeof brief + '。')
  }
  const text = typeof brief === 'string' ? brief : ''
  if (text.length > 20000) throw new Error('需求原文不能超过 20000 字符，请精简后重试。')
  // 档位写错要当场报错：静默回落到 fast 会让用户以为选了 strict。
  if (preset !== undefined && preset !== null && !PRESETS[preset]) {
    throw new Error('未知档位：' + String(preset) + '。可选 fast（小功能快速开发）或 strict（大需求严格执行）。')
  }
  const resolvedPreset = preset === 'strict' ? 'strict' : 'fast'
  return {
    id: 'f_' + randomUUID().slice(0, 12),
    sessionId,
    cwd,
    title: cleanTitle(title, text),
    /** 界面里贴进来的需求原文；Agent 在 S1 用它提问，不再要求用户复述一遍。 */
    brief: text,
    createdAt: at,
    updatedAt: at,
    stage: 'S1',
    finished: false,
    preset: resolvedPreset,
    /**
     * 门禁模式：auto 没有阻塞项就直接通过，manual 每一步都停下等确认。
     * 默认跟随档位——strict 是「大需求严格执行」，不该被默认跳过人工确认；
     * fast 是小功能，每次都点一遍只是噪音。两种模式随时可切。
     */
    gateMode: resolvedPreset === 'strict' ? 'manual' : 'auto',
    /** 用户对预设的覆盖：null 表示跟随 preset。 */
    overrides: { analysisRules: null, angles: null, directions: null, rules: null },
    customAnalysisRules: [],
    customAngles: [],
    customDirections: [],
    customRules: [],
    scope: { frozen: false, frozenAt: null, data: null, withoutDocApproval: false },
    /** D2：用户显式授权写权限的测试方向 id。 */
    writeGrants: [],
    /**
     * 用户对「内置方向需要写权限」的声明。
     * 内置方向（冒烟 / 功能 / 边界 / 回归）原来没有 needsWrite 字段，界面就没有任何入口
     * 能让它们跑测试命令——S4 只能记 uncovered。声明是配置，任何阶段都能改；
     * 真正的授权仍然只在 S4 生效（writeGrants）。
     */
    directionWriteDeclared: [],
    /**
     * 用户声明的额外只读工具名。
     * 宿主新增只读工具（例如刷新入口）时，插件不认识就一律拒绝——默认拒绝是对的，
     * 但没有出口的话，一个刷新按钮就能把整条流程卡死（实机踩到）。
     * 用户在这里声明「我确认它只读」，插件就放行；写工具与 shell 不接受这种豁免。
     */
    toolAllowlist: [],
    /** 开发阶段「允许执行构建/测试命令」的显式授权；默认关闭，冷恢复后失效。 */
    shellGrant: false,
    doc: { html: null, recommendedPreset: null, reason: null, at: null },
    /** 需求文档随附、尚未冻结的 scope；批准前展示给用户核对。 */
    pendingScope: null,
    /** 提交时被剔除的越界条目，批准前一并展示。 */
    pendingScopeDropped: [],
    /**
     * S1 静态体检出的「验收方案缺口」：声明要跑测试却没有测试命令、集成验收却没有测试文件等。
     * 这些不拦截提交，但批准 scope 前必须让用户看见并明确接受——否则等到 S4 才发现
     * 方法对不上证据，只能带缺口结项或整轮退回。
     */
    pendingScopeRisks: [],
    grill: { pending: null, answered: [] },
    stages: { S1: emptyStage(), S2: emptyStage(), S3: emptyStage(), S4: emptyStage() },
    review: null,
    test: null,
    devChanges: null,
    /** 回退留下的可复用结论；null 表示没有可复用的上一轮。 */
    carryOver: null,
    events: [],
  }
}

/** 标题来自 Agent 或界面输入，长度不可控：截断而不是让超长标题撑爆列表与快照。 */
function cleanTitle(title, brief) {
  const raw = typeof title === 'string' ? title.trim() : ''
  if (raw) return sanitizeTitle(raw) || '未命名任务'
  return deriveTitle(brief) || '未命名任务'
}

/**
 * 冷恢复兜底：磁盘快照可能来自旧版本、被手工改过，或者写到一半。
 * 这里只补结构、不改语义——缺的字段按新流程的默认值填，坏字段整个丢弃。
 * 没有这层的话，一个缺 `stages` 的快照会让 `flow.stages.S1.status` 抛 TypeError，
 * 而 hydrate 是同步调用，异常会一路冒到工具执行，整个会话的流程功能都用不了。
 */
function repairFlow(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || typeof raw.sessionId !== 'string' || typeof raw.cwd !== 'string') return null
  let base
  try {
    base = createFlow({
      sessionId: raw.sessionId,
      cwd: raw.cwd,
      title: raw.title,
      preset: PRESETS[raw.preset] ? raw.preset : 'fast',
      brief: raw.brief,
    })
  } catch {
    // 原文超长这类不可修复的坏快照直接丢弃，不影响其他流程恢复。
    return null
  }
  const flow = { ...base, ...raw }
  // 展开会把旧快照的 title 原样盖回来：那份标题可能是旧的 40 字截断或带句末标点，
  // 形式收口必须在这一层重算，否则标题规则只对新流程成立。
  flow.title = cleanTitle(raw.title, raw.brief) || '未命名任务'
  flow.id = raw.id
  flow.stage = STAGES.includes(flow.stage) ? flow.stage : 'S1'
  flow.finished = flow.finished === true
  flow.preset = PRESETS[flow.preset] ? flow.preset : 'fast'
  // 模式是用户的选择，冷恢复保留；缺失或非法时回到档位默认。
  if (flow.gateMode !== 'auto' && flow.gateMode !== 'manual') flow.gateMode = base.gateMode
  flow.stages = flow.stages && typeof flow.stages === 'object' && !Array.isArray(flow.stages) ? flow.stages : {}
  for (const stage of STAGES) {
    const saved = flow.stages[stage]
    flow.stages[stage] = { ...emptyStage(), ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}) }
  }
  flow.scope = { ...base.scope, ...(flow.scope && typeof flow.scope === 'object' ? flow.scope : {}) }
  flow.doc = { ...base.doc, ...(flow.doc && typeof flow.doc === 'object' ? flow.doc : {}) }
  flow.grill = { ...base.grill, ...(flow.grill && typeof flow.grill === 'object' ? flow.grill : {}) }
  flow.overrides = { ...base.overrides, ...(flow.overrides && typeof flow.overrides === 'object' ? flow.overrides : {}) }
  for (const key of ['customAnalysisRules', 'customAngles', 'customDirections', 'customRules', 'writeGrants', 'directionWriteDeclared', 'toolAllowlist', 'events', 'pendingScopeDropped', 'pendingScopeRisks']) {
    if (!Array.isArray(flow[key])) flow[key] = []
  }
  // 旧快照可能带着已废弃的整理稿字段：一律丢掉，需求依据只有 brief 原文。
  delete flow.summary
  // 冷恢复一律撤销命令授权：旧快照里的 shellGrant 不能静默继承。
  flow.shellGrant = false
  return flow
}

/** 四阶段使用同一套目录、选择优先级与来源，界面与真实执行保持一致。 */
function stageConfig(flow, stage, workspace) {
  const saved = workspaceStage(workspace, stage)
  const edits = new Map((saved?.edits ?? []).map((entry) => [entry.id, entry]))
  const catalog = [], known = new Set()
  const builtins = builtinStageItems(stage).map((entry) => edits.get(entry.id) ?? entry)
  for (const entry of builtins.concat(saved?.custom ?? [], flow?.[STAGE_CUSTOM_KEYS[stage]] ?? [])) {
    if (!entry || typeof entry.id !== 'string' || known.has(entry.id)) continue
    known.add(entry.id)
    catalog.push(entry)
  }
  const override = flow?.overrides?.[STAGE_KEYS[stage]]
  const selection = override ?? saved?.ids ?? stageDefaultIds(stage, flow?.preset)
  const ids = [...new Set(selection)].filter((id) => known.has(id))
  return {
    ids, catalog, items: ids.map((id) => catalog.find((entry) => entry.id === id)),
    source: Array.isArray(override) ? 'flow' : saved ? 'workspace' : 'default',
  }
}

/**
 * 把用户对内置方向的写权限声明并进方向条目。
 *
 * 内置方向是常量，不能为了一个开关去改常量本身；声明单独存 flow.directionWriteDeclared，
 * 读的时候合并。needsWrite 为真的条目走原有的一套授权链（S4 显式勾选 → writeGrants）。
 */
function withDirectionWriteDeclared(flow, items) {
  const declared = Array.isArray(flow?.directionWriteDeclared) ? flow.directionWriteDeclared : []
  if (!declared.length) return items
  const set = new Set(declared)
  // writeDeclared 让界面知道这条 needsWrite 是用户声明出来的，而不是方向自带的，
  // 否则界面上只有一个授权勾选，撤回声明的入口就没了。
  return items.map((item) => (set.has(item.id) && item.needsWrite !== true ? { ...item, needsWrite: true, writeDeclared: true } : item))
}

function activeAngles(flow, workspace) { return stageConfig(flow, 'S3', workspace).ids }
function activeDirections(flow, workspace) { return stageConfig(flow, 'S4', workspace).ids }
function angleCatalog(flow, workspace) { return stageConfig(flow, 'S3', workspace).catalog }
function directionCatalog(flow, workspace) { return withDirectionWriteDeclared(flow, stageConfig(flow, 'S4', workspace).catalog) }
function ruleSourceOf(flow, workspace) { return stageConfig(flow, 'S2', workspace).source }
function activeRules(flow, workspace) { return stageConfig(flow, 'S2', workspace).ids }
function ruleCatalog(flow, workspace) { return stageConfig(flow, 'S2', workspace).catalog }
function resolveRules(flow, workspace) { return stageConfig(flow, 'S2', workspace).items }
function resolveAngles(flow, workspace) { return stageConfig(flow, 'S3', workspace).items }
function resolveDirections(flow, workspace) { return withDirectionWriteDeclared(flow, stageConfig(flow, 'S4', workspace).items) }

/**
 * 全文、冻结 scope 和实际启用规则共同决定报告依据。
 *
 * 运行环境（宿主/客户端版本）刻意不参与：它衡量的是「这份报告可不可信」，
 * 不是「这份报告针对哪些代码」。把它算进 id，重载插件、重新生成 revision 标记
 * 这类与代码无关的动作就会让全部验收证据变成「版本不一致」——
 * 12 条全 pass 的报告在一次重启后全判未覆盖，正是这么发生的。
 * 环境可信度由 runtimeOf() 单独报告，不参与内容比对。
 */
function currentSnapshot(flow) {
  const workspace = SERVICE?.workspaceOf(flow.cwd)
  const previousFiles = (flow.snapshot?.files ?? []).map((file) => file.path)
  return captureSnapshot({
    ...flow,
    devChanges: { ...flow.devChanges, files: [...(flow.devChanges?.files ?? []), ...previousFiles] },
  }, {
    preset: flow.preset,
    // S4 走 resolveDirections：用户声明的写权限也属于报告依据，改声明要让旧报告失效。
    stages: Object.fromEntries(STAGES.map((stage) => [
      stage,
      stage === 'S4' ? resolveDirections(flow, workspace) : stageConfig(flow, stage, workspace).items,
    ])),
  })
}

function runtimeOf(flow) {
  const page = SERVICE?.runtimeClients.get(flow.sessionId)
  const runtime = { ...runtimeState(page?.clientRevision ?? ''), pageId: page?.pageId ?? '', viewport: page?.viewport ?? null, layoutEvidence: flow.layoutEvidence ?? [] }
  if (runtime.status !== 'verified') return runtime
  if (!page?.pageId || !page.viewport || Date.now() - page.reportedAt > 30000) {
    return { ...runtime, status: 'unverified', reason: '当前页面实例或视口尚未核对，或页面上报已过期。' }
  }
  return runtime
}

function acceptanceOf(flow, snapshot = currentSnapshot(flow)) {
  return acceptanceLedger(flow, snapshot, runtimeOf(flow))
}

/** 前序阶段是否已落地，带风险继续可进入后续阶段。 */
function canEnter(flow, stage) {
  const index = STAGES.indexOf(stage)
  if (index <= 0) return true
  for (let i = 0; i < index; i += 1) {
    const s = flow.stages[STAGES[i]].status
    if (s !== 'passed' && s !== 'skipped_by_user' && s !== 'accepted_with_risk') return false
  }
  return true
}

function skippedCount(flow) {
  return STAGES.filter((s) => flow.stages[s].status === 'skipped_by_user').length
}

/**
 * 只比代码内容：评审之后代码变了才该拦。
 *
 * 规则与配置（含 S4 自己的测试方向、写权限声明）刻意不进这个比较——
 * 在 S4 里勾一个测试方向会让整份快照 id 变，于是评审「失效」，
 * 用户只能退回 S2 重做一遍评审，而代码其实一行没动。
 * 快照不完整（文件读不到）时仍然拦：那时连「代码有没有变」都无从判断。
 */
function sameCode(left, right) {
  if (left?.complete !== true || right?.complete !== true) return false
  const codeOf = (side) => JSON.stringify((side.files ?? []).map((file) => [file.path, file.hash]))
  return codeOf(left) === codeOf(right)
}

/**
 * 推进门禁。
 * @param {object} flow
 * @param {'pass'|'skip'|'accept-risk'} decision
 */
function gateValidation(flow, decision, options = {}) {
  if (decision === 'accept-risk' && flow.stage !== 'S3') throw new Error('带风险继续仅适用于 S3 阻塞评审。')
  if (!['pass', 'skip', 'accept-risk'].includes(decision) || !['S3', 'S4'].includes(flow.stage)) return null
  // 跳过不是免检：S4 的 skip 曾经在这里直接放行，于是「跳过测试门禁」比
  // 「验收通过」还容易过——有缺口时前者一点就走，后者反而被拦。
  // 现在两条路走同一套校验，只是结果记成 skipped、缺口照实留在账本里。
  const snapshot = currentSnapshot(flow)
  const report = flow.stage === 'S3' ? flow.review : flow.test
  if (!sameSnapshot(report?.snapshot, snapshot)) {
    throw new Error('当前报告的内容或规则快照已失效或不完整，请重新提交本阶段报告后再确认。')
  }
  if (flow.stage === 'S3' && report?.blocking > 0 && (decision === 'pass' || decision === 'skip')) {
    throw new Error('当前评审仍有阻塞发现，不能通过或跳过评审；请退回修复，或选择显式带风险继续。')
  }
  if (decision === 'accept-risk') {
    if (!(report?.blocking > 0)) throw new Error('当前评审没有阻塞发现，请使用普通通过。')
    if (typeof options.reviewId !== 'string' || options.reviewId !== report.id) throw new Error('评审报告已更新，请针对当前报告重新确认带风险继续。')
  }
  if (flow.stage === 'S3' && decision !== 'skip' && report?.angles?.some((angle) => angle.coverage === 'uncovered' || angle.executionError)) {
    throw new Error('评审角度仍有目标文件未检查或读取失败，请修复读取后重新评审，不能通过评审。')
  }
  if (flow.stage === 'S4' && ['passed', 'accepted_with_risk'].includes(flow.stages.S3.status) && !sameCode(flow.review?.snapshot, snapshot)) {
    throw new Error('评审后代码已变化，请退回开发并重新评审，不能用旧评审通过新代码。')
  }
  const ledger = acceptanceOf(flow, snapshot)
  const points = (flow.test?.directions ?? []).flatMap((direction) => direction.points ?? [])
  const pointCounts = countPointResults(points)
  // 环境受限不算缺口：它说的是「这个环境跑不了」，重测多少轮都是同一个结果。
  // 把它算进缺口就成了死循环——用户点退回修复、Agent 改代码、再测，缺口原样还在。
  const unpassedPoints = pointCounts.fail + pointCounts.uncovered
  const gaps = ledger.counts.total - ledger.counts.pass - (ledger.counts.excluded ?? 0)
  if (flow.stage === 'S4' && (gaps || unpassedPoints)) {
    if (options.acceptUncovered !== true) {
      throw new Error('仍有 ' + gapSentence(ledger.counts, pointCounts) + '；请选择退回修复，或明确接受未通过/未覆盖项（acceptUncovered: true）。')
    }
    // 缺口靠「明确接受」这道动作区分，不靠用户打一段字：
    // 必填说明只会让人随手打「ok」，而缺口清单、计数与结束方式才是事后能核的东西。
    // 想写原因时 acceptanceNote 仍然会被记录。
  }
  return { snapshot, ledger, gaps, unpassedPoints, pointCounts }
}

/**
 * 测试要点与验收标准是两套独立账本。
 * 一个方向可以 0 个失败要点，而它的验收标准一条都没通过——
 * 把两者合成一个数字，就会得出「失败 0 项」这种听起来没事的结论。
 */
/**
 * 自动门禁的阻塞项：返回空数组表示这一关没有需要人判断的东西，可以直接放行。
 * 判定只认清单与报告，不碰 shellGrant——自动通过是少点几下，不是多给权限。
 */
function gateBlockers(flow, stage) {
  if (stage === 'S1') {
    const pending = flow.pendingScope
    if (!pending) return ['还没有提交待冻结的 scope']
    const readiness = scopeReadiness(
      pending.acceptance_criteria,
      pending.commands,
      pending.files_expected_to_change,
      { commandSources: pending.command_sources, project: projectProfile(flow.cwd) },
    )
    // 缺口和阻塞一样挡住自动通过：S1 的缺口是「这份 scope 有东西会拖到 S4 才炸」，
    // 自动模式下没人看它，就只能现在停下来问。
    const items = [...readiness.blockers, ...readiness.risks].map((entry) => entry.message)
    // 全部验收标准都靠人工核验时，S4 拿不到任何执行证据，自动通过等于替用户认下一个
    // 没人验证过的范围。这不算 scope 的缺口（人工核验是合法方法），所以只拦自动通过。
    const executable = (readiness.items ?? []).filter((item) => item.verification.method !== 'manual')
    if ((readiness.items ?? []).length && !executable.length) {
      items.push('这份 scope 的验收标准全部声明为人工核验：S4 不会有任何执行证据，自动通过等于替你认下这个范围。')
    }
    return items
  }
  if (stage === 'S2') {
    if (!flow.snapshot) return ['开发阶段还没有生成快照']
    if (flow.snapshot.complete === false) return ['快照不完整：有文件没能读取，评审与测试都基于旧内容']
    return []
  }
  // S3 / S4 与用户手动点「通过」走同一条校验：口径必须一致，
  // 否则自动通过会放过手动通过根本不允许的东西。
  try {
    gateValidation(flow, 'pass', {})
    return []
  } catch (error) {
    return [error.message]
  }
}

/**
 * 门禁等待的统一入口：auto 模式没有阻塞项就直接放行，manual 模式挂起等用户。
 * 用户中途切模式会唤醒这里（mode-changed），醒来重判一次，所以是个循环。
 * 自动放行返回的形状与客户端点按钮完全一致，下游分支不需要区分两种来源。
 */
async function awaitGate(service, flow, sessionId, kind, exec) {
  for (;;) {
    if (flow.gateMode === 'auto') {
      const blockers = gateBlockers(flow, flow.stage)
      if (!blockers.length) {
        flow.autoPassed = { ...(flow.autoPassed ?? {}), [flow.stage]: { at: nowIso(), snapshot: currentSnapshot(flow).id } }
        flow.gateBlockers = null
        appendEvent(flow.cwd, flow, 'gate.auto_passed', { stage: flow.stage })
        persist(flow)
        // S1 的放行形状是 approve，其余是 pass：与工作台按钮发出的值同形。
        return flow.stage === 'S1'
          ? { kind: 'approve', auto: true }
          : { kind: 'gate', decision: 'pass', auto: true }
      }
      // 停下来时把阻塞项写进流程：界面要能回答「为什么这次没自动过」。
      flow.gateBlockers = { stage: flow.stage, items: blockers }
    }
    markGateRequested(flow)
    const outcome = await service.gates.wait(sessionId, kind, 0, exec?.signal)
    if (decisionOf(outcome) === 'mode-changed') continue
    return outcome
  }
}

/** 缺口指纹：同一批 AC 以同样状态再挂一次，就说明改代码这条路走不通了。 */
function gapSignature(flow) {
  const ledger = acceptanceOf(flow)
  return (ledger.items ?? [])
    .filter((item) => item.status !== 'pass' && item.status !== 'excluded')
    .map((item) => item.ac + ':' + item.status)
    .sort()
    .join('|')
}

/**
 * S1 推导命令清单时能读到的项目事实：只读，不猜。
 * 体检用它判断「这条命令在这个仓库里到底跑不跑得起来」——写错脚本名比清单为空更糟：
 * 清单为空时用户至少知道要授权，写错的脚本名会在 S2 第一次跑构建时就炸。
 */
function projectProfile(cwd) {
  const profile = { hasPackageJson: false, scripts: {}, testRunners: [], hasTsConfig: false, hasMakefile: false }
  const readJson = (name) => {
    try {
      const raw = JSON.parse(readFileSync(join(cwd, name), 'utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
    } catch {
      return null
    }
  }
  const pkg = readJson('package.json')
  if (pkg) {
    profile.hasPackageJson = true
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}
    for (const [name, value] of Object.entries(scripts)) {
      if (typeof value === 'string') profile.scripts[name] = value.slice(0, 200)
    }
  }
  const has = (name) => existsSync(join(cwd, name))
  profile.hasTsConfig = has('tsconfig.json')
  profile.hasMakefile = has('Makefile') || has('makefile')
  const runners = [
    ['vitest', ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts']],
    ['jest', ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs']],
    ['playwright', ['playwright.config.ts', 'playwright.config.js']],
    ['mocha', ['.mocharc.json', '.mocharc.yml', '.mocharc.yaml', '.mocharc.js']],
    ['karma', ['karma.conf.js']],
    ['pytest', ['pytest.ini', 'pyproject.toml', 'tox.ini']],
    ['go', ['go.mod']],
    ['cargo', ['Cargo.toml']],
  ]
  for (const [name, files] of runners) {
    if (files.some(has)) profile.testRunners.push(name)
  }
  return profile
}

function countPointResults(points) {
  const counts = { total: points.length, pass: 0, fail: 0, uncovered: 0, excluded: 0 }
  for (const point of points) {
    if (point?.result === 'pass') counts.pass += 1
    else if (point?.result === 'fail') counts.fail += 1
    else if (point?.result === 'excluded') counts.excluded += 1
    else counts.uncovered += 1
  }
  return counts
}

/** 一句话把两套账都说全：只报其中一套都会让缺口显得比实际小。 */
function gapSentence(counts, pointCounts) {
  const ac = counts ?? {}
  const points = pointCounts ?? {}
  return '验收标准 ' + (ac.pass ?? 0) + ' 通过 / ' + (ac.fail ?? 0) + ' 未通过 / ' + (ac.uncovered ?? 0) + ' 未覆盖（共 ' + (ac.total ?? 0) + ' 条），'
    + '测试要点 ' + (points.fail ?? 0) + ' 失败 / ' + (points.uncovered ?? 0) + ' 未覆盖（共 ' + (points.total ?? 0) + ' 个）'
}

/**
 * 「流程怎么收尾的」说成人话。
 * 带缺口结束必须自己说出来，不能借「流程已结束」蒙过去——
 * 那句话读起来和全部验收通过没有区别。
 */
function closureSentence(flow) {
  const closure = flow.closure
  if (!closure) return flow.finished ? '流程已结束（结束方式未记录）' : '流程进行中'
  if (closure.kind === 'skipped') return '流程已结束：用户跳过验收门禁'
  if (closure.kind === 'accepted_with_gaps') {
    const counts = closure.counts ?? {}
    const points = closure.pointCounts ?? {}
    return '流程已结束：带缺口结束（用户明确接受未通过/未覆盖项）——验收标准 '
      + (counts.pass ?? 0) + ' 通过 / ' + (counts.fail ?? 0) + ' 未通过 / ' + (counts.uncovered ?? 0) + ' 未覆盖（共 ' + (counts.total ?? 0) + ' 条），测试要点 '
      + (points.fail ?? 0) + ' 失败 / ' + (points.uncovered ?? 0) + ' 未覆盖（共 ' + (points.total ?? 0) + ' 个）'
      + (closure.note ? '；用户补充的接受原因：' + closure.note : '')
  }
  return '流程已结束：全部验收通过'
}

function remediationNote(flow) {
  const list = flow.remediation
  if (!list) return ''
  return '退回修复清单（按 AC）：' + JSON.stringify({ reason: list.reason, note: list.note, items: list.items, advisories: list.advisories })
}

function passGate(flow, decision, options = {}) {
  const validation = gateValidation(flow, decision, options)
  if (flow.stage === 'S4') {
    const snapshot = validation?.snapshot ?? currentSnapshot(flow)
    const ledger = validation?.ledger ?? acceptanceOf(flow, snapshot)
    const status = decision === 'skip' ? 'skipped' : validation.gaps || validation.unpassedPoints ? 'accepted-with-gaps' : 'passed'
    flow.acceptanceDecision = { status, version: snapshot.id, counts: ledger.counts, unpassedPoints: validation?.unpassedPoints ?? 0, pointCounts: validation?.pointCounts ?? countPointResults([]), note: clampText(options.acceptanceNote ?? options.note, 2000), at: nowIso() }
    appendEvent(flow.cwd, flow, 'acceptance.decided', flow.acceptanceDecision)
  }
  abortChildRun(flow)
  const stage = flow.stage
  const record = flow.stages[stage]
  // 带缺口结束不是「通过」：阶段记录、审计事件、流程结束方式必须三处同口径。
  // 否则界面读 gate === 'passed' 就会把一个有未覆盖项的流程显示成「已完成」。
  const gapsAccepted = decision !== 'skip' && flow.stage === 'S4' && flow.acceptanceDecision?.status === 'accepted-with-gaps'
  if (decision === 'skip') {
    record.status = 'skipped_by_user'
    record.skipped = true
    record.gate = 'skipped'
  } else if (gapsAccepted) {
    record.status = 'accepted_with_gaps'
    record.gate = 'accepted_with_gaps'
    record.gapAcceptance = {
      ...(flow.acceptanceDecision.note ? { note: flow.acceptanceDecision.note } : {}),
      counts: flow.acceptanceDecision.counts,
      pointCounts: flow.acceptanceDecision.pointCounts,
      version: flow.acceptanceDecision.version,
      at: flow.acceptanceDecision.at,
    }
  } else {
    record.status = 'passed'
    record.gate = 'passed'
  }
  if (decision === 'accept-risk') {
    record.status = 'accepted_with_risk'
    record.gate = 'risk_accepted'
    const rawReason = typeof options.riskReason === 'string' ? options.riskReason.trim() : ''
    const boundary = rawReason.charCodeAt(1999)
    const reason = rawReason.length > 2000 && boundary >= 0xD800 && boundary <= 0xDBFF
      ? rawReason.slice(0, 1999) + '…（超长已截断）'
      : clampText(rawReason, 2000)
    record.riskAcceptance = { ...(reason ? { reason } : {}), version: validation.snapshot.id, reviewId: flow.review.id, blocking: flow.review.blocking, at: nowIso() }
  }
  record.decidedAt = nowIso()
  const next = NEXT_STAGE[stage]
  const eventType = decision === 'skip' ? 'gate.skipped'
    : decision === 'accept-risk' ? 'gate.risk_accepted'
      : gapsAccepted ? 'gate.accepted_with_gaps'
        : 'gate.passed'
  const eventDetail = decision === 'accept-risk' ? { stage, ...record.riskAcceptance }
    : gapsAccepted ? { stage, ...record.gapAcceptance }
      : { stage }
  appendEvent(flow.cwd, flow, eventType, eventDetail)
  // 命令授权在本次流程内持久：阶段推进不清除，只在流程结束、放弃、冷恢复时清除。
  // 下面只在 next === null（流程结束）里清 shellGrant，其余分支一律不碰。
  if (next === null) {
    flow.finished = true
    // 流程结束：授权已经没有任何东西可放行，清掉快照里那条看似仍有效的授权。
    flow.shellGrant = false
    // 结束方式单独存一份：acceptanceDecision 只描述 S4 那次决定，
    // 而「这条流程到底怎么收尾的」是给汇总、列表和对外状态用的。
    flow.closure = {
      kind: decision === 'skip' ? 'skipped' : gapsAccepted ? 'accepted_with_gaps' : 'passed',
      ...(decision === 'skip' ? {} : {
        counts: flow.acceptanceDecision?.counts ?? null,
        pointCounts: flow.acceptanceDecision?.pointCounts ?? null,
        ...(flow.acceptanceDecision?.note ? { note: flow.acceptanceDecision.note } : {}),
      }),
      at: nowIso(),
    }
    appendEvent(flow.cwd, flow, 'flow.finished', { skipped: skippedCount(flow), closure: flow.closure.kind, ...(flow.closure.counts ? { counts: flow.closure.counts, pointCounts: flow.closure.pointCounts } : {}) })
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

/** 冻结 scope 里声明的验收标准 id 集合：评审发现的唯一归属依据。 */
function acceptanceIds(flow) {
  const criteria = flow.scope?.data?.acceptance_criteria ?? []
  return new Set(
    criteria.map((item) => (typeof item?.id === 'string' ? item.id.trim() : '')).filter(Boolean),
  )
}

/**
 * 给一条评审发现定归属：挂在哪条验收标准上、文件是否在冻结 scope 内、算不算阻塞项。
 *
 * 只有「挂在已声明的验收标准上 + 文件在 scope 内 + 不是 MINOR」的发现才进重做清单。
 * 对不上验收标准的发现仍然展示，但降级成建议：没有验收标准的发现既证明不了是缺陷，
 * 重做时也无法判定「修好了没有」——把它塞进重做清单，回退就成了无底洞。
 */
function classifyFinding(flow, finding) {
  const ac = typeof finding?.ac === 'string' ? finding.ac.trim() : ''
  const acMatched = ac.length > 0 && acceptanceIds(flow).has(ac)
  const allowed = (flow.scope?.data?.in_scope?.files_expected_to_change ?? [])
    .map((entry) => normalizeTarget(flow.cwd, entry))
  // 没有 file 的发现（子代理整体失败之类）不按路径判定，交给严重度与 AC 归属决定。
  const fileInScope = !finding?.file ? true : allowed.includes(normalizeTarget(flow.cwd, finding.file))
  return { ac, acMatched, fileInScope, blocking: finding?.severity !== 'MINOR' && acMatched && fileInScope }
}

/**
 * 把报告统一贴上归属标记，并算出「进重做清单」与「只作提示」的条数。
 * 标记随报告落盘：界面上要能一眼分清哪条会被要求修掉、哪条只是提示。
 */
function applyFindingGate(flow, angles) {
  let blocking = 0
  let advisories = 0
  const marked = (Array.isArray(angles) ? angles : []).map((angle) => ({
    ...angle,
    findings: (Array.isArray(angle?.findings) ? angle.findings : []).map((finding) => {
      const verdict = classifyFinding(flow, finding)
      if (verdict.blocking) blocking += 1
      else advisories += 1
      return { ...finding, ...verdict }
    }),
  }))
  const counts = findingCounts(marked)
  return { angles: marked, blocking: counts.blocking, advisories: counts.advisories, counts }
}

/**
 * 按严重度排序后截断到统一存储硬上限，省略项按原严重度另行计数。
 * fast 只减少默认角度，展示折叠不改变保存结果和总数。
 */
function capFindings(flow, findings) {
  const list = Array.isArray(findings) ? findings : []
  const rank = { CRITICAL: 0, MAJOR: 1, MINOR: 2 }
  return list.slice().sort((left, right) => (rank[left?.severity] ?? 3) - (rank[right?.severity] ?? 3)).slice(0, FINDINGS_LIMIT)
}

/**
 * 回退时把上一轮的评审 / 测试结论存成「可复用产物」。
 *
 * 只重置受影响阶段会留下一个空档：门禁不能提前可点，所以当前 review / test 必须清空；
 * 但结论本身没作废——重跑时据此判断哪些角度与方向可以跳过，省掉整轮重做。
 * 存下来的还有结论依据的代码快照，重跑时用它判断这一轮又改了哪些文件。
 */
function carryOverOf(flow, to, reason) {
  const review = flow.review
  const test = flow.test
  if (!review && !test) return null
  return {
    at: nowIso(),
    from: flow.stage,
    to,
    reason,
    /** 文件集合仅供展示；复用必须核对完整内容快照。 */
    files: [...(flow.devChanges?.files ?? []), ...(flow.devChanges?.untracked ?? [])],
    angles: Array.isArray(review?.angles) ? review.angles : [],
    directions: Array.isArray(test?.directions) ? test.directions : [],
    reviewAt: review?.at ?? null,
    testAt: test?.at ?? null,
    reviewSnapshot: review?.snapshot ?? null,
    testSnapshot: test?.snapshot ?? null,
    reviewAcceptance: review?.acceptance ?? [],
    testAcceptance: test?.acceptance ?? [],
  }
}

/** 任一文件内容、scope、规则或插件版本改变，整轮旧结论失效。旧报告缺快照同样失效。 */
function carryOverAdvice(flow) {
  const carry = flow.carryOver
  if (!carry) return null
  const snapshot = currentSnapshot(flow)
  const reviewSame = sameSnapshot(carry.reviewSnapshot, snapshot)
  const testSame = sameSnapshot(carry.testSnapshot, snapshot)
  const judge = (reusable) => ({ reusable, reason: reusable
    ? '内容、scope、规则及插件版本快照一致'
    : '内容或规则已变化、快照不完整，或旧报告没有内容快照，必须整轮重做' })
  return {
    at: carry.at ?? null, from: carry.from ?? null,
    sameCode: reviewSame && (!carry.directions?.length || testSame),
    snapshot: snapshot.id,
    angles: (carry.angles ?? []).map((angle) => ({ id: angle?.id ?? '', name: angle?.name ?? '', ...judge(reviewSame) })),
    directions: (carry.directions ?? []).map((direction) => ({ id: direction?.id ?? '', name: direction?.name ?? '', ...judge(testSame) })),
  }
}

/** 复用过的条目要从 carryOver 里摘掉，否则下一轮会被当成还没用过的旧结论。 */
function dropCarryOver(flow, key, ids) {
  const carry = flow.carryOver
  if (!carry) return
  const drop = new Set(ids)
  carry[key] = (carry[key] ?? []).filter((entry) => !drop.has(entry?.id))
  if (!carry.angles.length && !carry.directions.length) flow.carryOver = null
}

/**
 * 决定这一轮哪些角度 / 方向可以跳过。
 *
 * 依据 carryOverAdvice：它已经按本轮改动文件判定过每一条结论是否还成立。
 * 只挑当前仍然启用的条目——用户关掉的角度不该被旧结论复活。
 */
function reusePlan(flow, key, items, allow = true) {
  const empty = { reusable: new Set(), reports: [], ids: [] }
  if (!allow) return empty
  const advice = carryOverAdvice(flow)
  if (!advice) return empty
  const enabled = new Set(items.map((item) => item.id))
  const reusableIds = new Set(
    (advice[key] ?? []).filter((entry) => entry.reusable && enabled.has(entry.id)).map((entry) => entry.id),
  )
  if (!reusableIds.size) return empty
  const pool = (flow.carryOver?.[key] ?? []).filter((entry) => reusableIds.has(entry?.id))
  return { reusable: reusableIds, reports: pool.map((entry) => ({ ...entry, reused: true })), ids: [...reusableIds] }
}

/**
 * 把上一轮的角度结论并入本次评审。
 * 只在 carryOver 里确实存在该角度时成立——否则「复用」就是凭空捏造结论。
 */
function mergeReusedAngles(flow, requested, submitted) {
  const ids = (Array.isArray(requested) ? requested : []).filter((id) => typeof id === 'string')
  if (!ids.length) return { angles: submitted, reused: [] }
  if (!sameSnapshot(flow.carryOver?.reviewSnapshot, currentSnapshot(flow))) {
    throw new Error('评审依据的内容或规则快照已失效，必须重新评审，不能复用。')
  }
  const pool = new Map((flow.carryOver?.angles ?? []).map((angle) => [angle?.id, angle]))
  const present = new Set(submitted.map((angle) => angle?.id))
  const angles = submitted.slice()
  const reused = []
  for (const id of ids) {
    const angle = pool.get(id)
    if (!angle) throw new Error('没有可复用的角度结论：' + id + '。上一轮没有这个角度的结果，必须重新评审。')
    if (present.has(id)) throw new Error('角度 ' + id + ' 已经在本轮报告里，不要同时标记复用。')
    angles.push({ ...angle, reused: true })
    reused.push(id)
  }
  return { angles, reused }
}

/** 同 mergeReusedAngles，用于测试方向。 */
function mergeReusedDirections(flow, requested, submitted) {
  const ids = (Array.isArray(requested) ? requested : []).filter((id) => typeof id === 'string')
  if (!ids.length) return { directions: submitted, reused: [] }
  if (!sameSnapshot(flow.carryOver?.testSnapshot, currentSnapshot(flow))) {
    throw new Error('测试依据的内容或规则快照已失效，必须重新测试，不能复用。')
  }
  const pool = new Map((flow.carryOver?.directions ?? []).map((direction) => [direction?.id, direction]))
  const present = new Set(submitted.map((direction) => direction?.id))
  const directions = submitted.slice()
  const reused = []
  for (const id of ids) {
    const direction = pool.get(id)
    if (!direction) throw new Error('没有可复用的测试结论：' + id + '。上一轮没有这个方向的结果，必须重新测试。')
    if (present.has(id)) throw new Error('方向 ' + id + ' 已经在本轮报告里，不要同时标记复用。')
    directions.push({ ...direction, reused: true })
    reused.push(id)
  }
  return { directions, reused }
}

/** 环境受限的测试点必须显式排除并写明原因，不能让它永远停在「未覆盖」。 */
function assertExclusions(directions) {
  for (const direction of directions) {
    for (const point of direction?.points ?? []) {
      if (point?.result !== 'excluded') continue
      if (typeof point.excludeReason !== 'string' || !point.excludeReason.trim()) {
        throw new Error('测试要点「' + (point?.point ?? '') + '」标记为 excluded，必须用 excludeReason 写明环境限制原因。')
      }
    }
  }
}

function countExcluded(directions) {
  return directions.reduce(
    (sum, direction) => sum + (direction?.points ?? []).filter((point) => point?.result === 'excluded').length,
    0,
  )
}

/** 回退到某一阶段重做；只重置受影响的阶段，已通过阶段的产物保留下来供复用。 */
function rollbackTo(flow, stage, reason, note = '') {
  // 退回可能被触发两次：门禁工具被中断后补发的排队消息、或用户在按钮上连点。
  // 同一目标阶段的重复退回会清掉刚重做的产物，所以短时间内同因同目标的第二次调用只留事件、不再动手。
  // 只有「已经在目标阶段」时的第二次退回才是重复信号；已经推进到别的阶段再退回是正常操作。
  const lastRollback = flow.lastRollback
  if (flow.stage === stage && lastRollback && lastRollback.to === stage && Date.now() - lastRollback.at < 10000) {
    appendEvent(flow.cwd, flow, 'flow.rollback.skipped', { to: stage, reason })
    return
  }
  // 同一个缺口连着退回两轮还在，第三轮大概率也一样：这不是 Agent 不努力，
  // 而是这条 AC 靠改代码修不好（环境测不了，或验收方法本身不成立）。
  // 这时只有改 scope 或接受缺口两条路，所以改道 S1——别让人在同一个循环里烧 token。
  const signature = stage === 'S2' && reason === 'test-rejected' ? gapSignature(flow) : ''
  if (signature) {
    const budget = flow.rollbackBudget ?? {}
    budget[signature] = (budget[signature] ?? 0) + 1
    flow.rollbackBudget = budget
    if (budget[signature] > 2) {
      appendEvent(flow.cwd, flow, 'flow.rollback.redirected', { from: 'S2', to: 'S1', repeats: budget[signature], signature })
      stage = 'S1'
    }
  }
  abortChildRun(flow)
  const carried = stage === 'S1' ? null : carryOverOf(flow, stage, reason)
  const remediation = remediationList(flow, acceptanceOf(flow), { reason, note })
  if (flow.review || flow.test || !flow.remediation) flow.remediation = remediation
  else if (note) flow.remediation = { ...flow.remediation, note }
  flow.execution = { status: 'idle', text: '已退回，等待按修复清单重做。' }
  const target = STAGES.indexOf(stage)
  if (target < 0) throw new Error('未知阶段：' + stage)
  // 受影响阶段 = target 及其之后；target 之前已经通过，状态与产物原样保留。
  for (let i = target; i < STAGES.length; i += 1) {
    const key = STAGES[i]
    flow.stages[key] = emptyStage()
  }
  flow.stages[stage].status = 'active'
  flow.stage = stage
  flow.finished = false
  // 回退意味着代码要重做，之前授予的写权限随之失效（D2 的例外只对当次测试成立）。
  flow.writeGrants = []
  // 命令授权不跟着回退清掉：它在本次流程内持久，返工期间仍能跑构建与测试；
  // 撤销走界面上同一个开关，放弃与流程结束另有清除路径。
  // 被回退覆盖的产物不再作数：旧摘要 / 旧评审 / 旧测试留着，门禁会以为「已经交过」而提前可点。
  flow.gateNote = null
  // 回退保留报告供检查；任一文件内容或规则变化都使整轮复用失效。
  // 回到 S1 是要改 scope，结论的前提变了，旧产物一律作废。
  flow.carryOver = carried
  flow.devChanges = null
  flow.review = null
  flow.test = null
  // 回到 S1 是为了改 scope：旧 scope 必须解冻，否则用户改了文档、S2 却仍按旧白名单放行。
  if (stage === 'S1') {
    flow.scope = { frozen: false, frozenAt: null, data: null, withoutDocApproval: false }
    flow.doc = { html: null, recommendedPreset: null, reason: null, at: null }
    flow.pendingScope = null
    flow.pendingScopeDropped = []
  }
  flow.lastRollback = { to: stage, reason, at: Date.now() }
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
  flow.execution = { status: 'cancelled', text: '用户已放弃流程，执行结果不再计为成功。' }
  flow.cancelledAt = nowIso()
  flow.cancelReason = reason && reason.trim() ? reason.trim().slice(0, 200) : '用户放弃这次流程'
  // 放弃那一刻可能还有没答完的追问：留着它，工作台会继续显示一张已经作废的卡片。
  flow.grill.pending = null
  // 放弃之后不该再有任何白名单：写权限只看 frozen，解冻即失效。
  // 但 scope.data 要留着：验收账本按 acceptance_criteria 计数，抹掉它会让
  // 一条 12 项全未覆盖的流程在放弃后显示成「0 条 · 验收通过」。
  flow.scope = { ...(flow.scope ?? {}), frozen: false, frozenAt: null, withoutDocApproval: false }
  flow.writeGrants = []
  flow.shellGrant = false
  flow.pendingScope = null
  flow.pendingScopeDropped = []
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
function decideDoc(service, flow, sessionId, decision, options = {}) {
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
      risksAccepted: flow.scope?.data?.scope_risks?.risks ?? [],
    }
  }
  if (flow.stage !== 'S1') throw new Error('需求文档确认只在 S1 阶段，当前阶段是 ' + flow.stage + '。')
  if (!flow.doc?.html) throw new Error('当前还没有提交需求文档。')

  if (decision === 'revise') {
    // 留住「用户点过修改需求」这件事：客户端据此在空态里说明下一步该做什么。
    const at = nowIso()
    const rawNote = typeof options.revisionNote === 'string' ? options.revisionNote.trim() : ''
    // 2000 字是硬上限：客户端已经先拦一次，这里仍要收口（客户端可以绕过）。
    // 真被截断时在事件里写明，别让「用户写了 3000 字」事后无从查证。
    const revisionNote = rawNote.slice(0, REVISION_NOTE_LIMIT)
    flow.doc = {
      html: null,
      recommendedPreset: null,
      reason: null,
      at: null,
      revisedAt: at,
      decision: { kind: 'revise', at },
      // 用户的修改意见必须留住：唤醒消息要念原文，Agent 才不用反问一遍。
      revisionNote: revisionNote || null,
    }
    // 改了需求，旧的白名单不能留着：下一份文档会带新的 scope 过来。
    flow.pendingScope = null
    flow.pendingScopeDropped = []
    flow.pendingScopeRisks = []
    appendEvent(flow.cwd, flow, 'doc.revised', revisionNote
      ? { note: revisionNote, ...(rawNote.length > REVISION_NOTE_LIMIT ? { truncated: true, noteLength: rawNote.length } : {}) }
      : {})
    persist(flow)
    return { decision: 'revise', preset: flow.preset, frozen: false, repeated: false, risksAccepted: [] }
  }

  const skipped = decision === 'skip'
  // 冻结前再规范化一次：快照可能来自旧版本或冷恢复，不能假定它已经干净。
  const normalizedPending = validatedPendingScope(flow.cwd, flow.pendingScope)
  const pendingScope = normalizedPending.scope
  // 体检也重算：pendingScope 可能来自旧版本或冷恢复，提交时那份 risks 不能当作当前结论。
  const readiness = scopeReadiness(
    pendingScope.acceptance_criteria,
    pendingScope.commands,
    pendingScope.files_expected_to_change,
    { commandSources: pendingScope.command_sources, project: projectProfile(flow.cwd) },
  )
  if (readiness.blockers.length) {
    throw new Error('scope 的验收标准无法核验，不能冻结：\n- ' + readiness.blockers.map((item) => item.message).join('\n- '))
  }
  const risks = readiness.risks
  const scopeRiskNote = typeof options.scopeRiskNote === 'string' ? options.scopeRiskNote.trim().slice(0, 2000) : ''
  if (risks.length && options.acceptScopeRisks !== true) {
    throw new Error(
      '这份 scope 有 ' + risks.length + ' 条验收方案缺口，不能直接冻结：\n- ' +
      risks.map((item) => item.message + '（' + item.acs.join('、') + '）').join('\n- ') +
      '\n请先补 scope（补测试命令、测试文件或写明测量方式），或在确认区明确接受这些缺口后重试（acceptScopeRisks: true）。',
    )
  }
  const frozenAt = nowIso()
  // 批准或跳过都会冻结 scope：跳过只影响需求文档评审，不影响 scope 的冻结。
  const frozen = {
    version: 1,
    frozen_at: frozenAt,
    // PRD 4.1.2：跳过需求文档评审也冻结 scope，但在落盘文件里留下这件事的痕迹。
    scope_frozen_without_doc_approval: skipped,
    in_scope: {
      files_expected_to_change: pendingScope.files_expected_to_change,
      // 命令清单是 scope 的一部分：用户批准的是「这些文件 + 这些命令」。
      commands: pendingScope.commands ?? [],
      capabilities: pendingScope.capabilities,
      // 影响面随 scope 一起冻结：评审要拿它判断一条发现是否落在本次开发范围内。
      shared_contracts: pendingScope.shared_contracts ?? [],
    },
    out_of_scope_explicitly: pendingScope.out_of_scope_explicitly ?? [],
    acceptance_criteria: pendingScope.acceptance_criteria ?? [],
    // 缺口是用户明确接受的例外：随冻结凭据一起落盘，事后能追溯当时接受了什么、为什么。
    ...(risks.length ? { scope_risks: { accepted: true, ...(scopeRiskNote ? { note: scopeRiskNote } : {}), at: frozenAt, risks } } : {}),
  }
  // scope.json 是冻结凭据的外部副本：写不下去就不该宣布冻结，否则用户以为批准了，
  // 外部工具与人都看不到任何范围声明。先落盘再改内存状态，失败可以直接重试。
  try {
    writeJsonAtomic(join(dataRoot(flow.cwd), 'scope.json'), frozen)
  } catch (error) {
    throw new Error('scope.json 无法写入（' + String(error?.message ?? error).slice(0, 120) + '）。请检查 .dsh-flowgate 目录权限后重试。')
  }
  flow.scope = {
    frozen: true,
    frozenAt: frozen.frozen_at,
    data: frozen,
    withoutDocApproval: skipped,
  }
  // 先记下决策再推进：passGate 内部的 persist 会把这份标记一起写进快照。
  flow.doc = { ...flow.doc, decision: { kind: skipped ? 'skip' : 'approve', at: frozen.frozen_at } }
  appendEvent(flow.cwd, flow, 'scope.frozen', {
    withoutDocApproval: skipped,
    files: frozen.in_scope.files_expected_to_change,
    commands: frozen.in_scope.commands,
    droppedScopeEntries: normalizedPending.dropped,
    scopeRisks: risks.map((item) => item.code),
  })
  // 例外要单独留痕：只写 scope.frozen 会让「用户接受过缺口」这件事无从追溯。
  if (risks.length) {
    appendEvent(flow.cwd, flow, 'scope.risks_accepted', {
      codes: risks.map((item) => item.code),
      acs: risks.flatMap((item) => item.acs),
      // 原因可选：用户写了就留，没写不占位。留痕的核心是「接受了哪些缺口」。
      ...(scopeRiskNote ? { note: scopeRiskNote } : {}),
      decision: skipped ? 'skip' : 'approve',
    })
  }
  passGate(flow, skipped ? 'skip' : 'pass')
  return { decision: flow.doc.decision.kind, preset: flow.preset, frozen: true, repeated: false, risksAccepted: risks }
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
 * @param {'pass'|'skip'|'back'|'accept-risk'} decision
 * @param {string} [to]
 */
function decideGate(service, flow, sessionId, decision, to, options = {}) {
  if (flow.finished) {
    throw new Error(
      flow.cancelled ? '这次流程已被放弃，不能再确认门禁。' : '流程已经结束，不能再确认门禁。',
    )
  }
  const stage = flow.stage
  if (stage === 'S1') throw new Error('S1 的门禁是需求文档：请在工作台点「批准并冻结 scope」。')
  const record = flow.stages[stage]
  if (record.gate === 'passed' || record.gate === 'skipped' || record.gate === 'risk_accepted') {
    return { decision, stage, next: flow.stage, repeated: true }
  }
  // HTTP 与等待器续体都核对快照和例外，避免有等待器时绕过校验。
  if (decision !== 'back' && !gateArtifactReady(flow)) {
    throw new Error('当前阶段还没有可确认的产物：等 Agent 把 ' + STAGE_LABEL[stage] + ' 的结果交上来再点。')
  }
  gateValidation(flow, decision, options)
  // 有等待中的工具就交给它推进；最终落状态时再核对一次内容版本。
  if (service.gates.notify(sessionId, { decision, to, ...options }, 'gate')) {
    return { decision, stage, next: flow.stage, repeated: false, delivered: true }
  }
  if (decision !== 'back' && !gateArtifactReady(flow)) {
    // 产物还没交就点确认，只可能是重复点击或提前点：不许跳过还没做的阶段。
    throw new Error('当前阶段还没有可确认的产物：等 Agent 把 ' + STAGE_LABEL[stage] + ' 的结果交上来再点。')
  }
  if (decision === 'back') {
    rollbackTo(flow, to === 'S1' ? 'S1' : 'S2', 'user', options.note ?? '')
  } else {
    passGate(flow, decision, options)
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
 * 不能靠用户声明豁免的工具。
 *
 * 这几类要么能绕过 scope 判定本身（shell / run_code 自己另有一套判定），
 * 要么就是权限开关（flowgate_*、写工具）。把它们排除掉，豁免名单才不会变成
 * 「一句话给自己开后门」。
 */
const TOOL_ALLOW_NEVER = new Set([
  'run_code', 'bash', 'shell', 'exec', 'run_shell', 'terminal', 'ops_bash', 'ops_pwsh',
  'ops_powershell', 'powershell', 'pwsh',
  'write', 'edit', 'ops_write_file', 'ops_edit_file', 'ops_replace', 'ops_move', 'ops_copy',
  'ops_remove', 'ops_batch', 'decompress',
  'flowgate_doc', 'flowgate_gate', 'flowgate_start', 'flowgate_cancel',
])

/** 规范化用户的只读豁免名单：名字合法、不重复、不超过上限。 */
function normalizeToolAllowlist(list) {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const name = String(raw ?? '').trim()
    if (!name) continue
    if (!TOOL_ALLOW_NAME.test(name)) {
      throw new Error('只读豁免的工具名不合法：' + name + '（只接受字母、数字、下划线、点、连字符）')
    }
    if (TOOL_ALLOW_NEVER.has(name)) {
      throw new Error('工具 ' + name + ' 不能声明为只读：它要么能绕过 scope 判定，要么本身就是权限开关。')
    }
    // 插件已经认识的工具不需要声明：只读的本来就放行，写的有自己的判定，
    // 把它塞进豁免名单只会让「为什么这个能写」变得说不清。
    if (PASSIVE_TOOLS.has(name) || scopeTargetsOf(name, {}) !== null) {
      throw new Error(
        '工具 ' + name + ' 插件已经认识，不需要声明为只读豁免：' +
        '只读工具本来就会放行，写工具仍要按 scope 声明要改的文件。',
      )
    }
    if (!out.includes(name)) out.push(name)
  }
  if (out.length > TOOL_ALLOW_LIMIT) {
    throw new Error('只读豁免最多 ' + TOOL_ALLOW_LIMIT + ' 条，当前 ' + out.length + ' 条。')
  }
  return out
}

function isToolAllowlisted(flow, name) {
  return Array.isArray(flow?.toolAllowlist) && flow.toolAllowlist.includes(name)
}

/**
 * 判断一次调用是否被允许。
 * @returns {string|null} 拒绝理由；null 表示放行。
 */
function scopeDenial(flow, name, args) {
  if (!flow || flow.finished) return null
  // 显式登记的只读工具直接放行；未登记的工具走下面的默认拒绝。
  if (PASSIVE_TOOLS.has(name)) return null
  if (SHELL_TOOLS.has(name)) return shellDenial(flow, args)
  if (name === 'run_code') return runCodeDenial(flow, args)

  // 分页引用里的操作清单取不到，等于无法核对目标路径：直接拒绝，让它把 operations 写进参数。
  if (args && typeof args === 'object' && typeof args.operationsRef === 'string' && args.operationsRef.length > 0) {
    return '批量操作的分页引用无法静态核对目标路径，已拒绝：请把 operations 直接写进参数再执行。'
  }

  const targets = scopeTargetsOf(name, args)
  if (targets === null) {
    // 豁免只在这里生效：写工具与 shell 上面已经各自判过，不会走到这一步。
    // 放在这里而不是入口处，是为了让「已知工具」永远按自己的规则判，豁免名单不成为后门。
    if (isToolAllowlisted(flow, name)) return null
    return (
      '工具 ' + name + ' 没有在 flowgate 的只读登记表里，无法核对它是否会改动磁盘，已拒绝。\n' +
      '只读工具请登记进 lib/index.js 的 PASSIVE_TOOLS；写工具请按 scope 声明要改的文件。\n' +
      '如果你确认这个工具只读，可以在工作台「阶段设置 → 只读豁免」里声明它，' +
      '或让用户在那里声明；写工具与 shell 不接受这种豁免。'
    )
  }
  for (const target of targets) {
    const denial = targetDenial(flow, target)
    if (denial) return denial
  }
  return null
}

/** 单个目标路径的判定：数据目录、阶段、冻结 scope、大小写。 */
function targetDenial(flow, target) {
  const normalized = normalizeTarget(flow.cwd, target.path)
  // 数据目录由插件自己维护。原来是无条件放行，等于让 Agent 自己改自己的 scope 和状态快照。
  if (isInsideDataDir(normalized)) {
    return '流程数据目录 ' + DATA_DIR + '/ 由插件自身维护，不接受工具写入：' + normalized
  }

  if (flow.stage !== 'S2') {
    return (
      '当前处于 ' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）阶段，不能修改业务代码。' +
      '要先通过 S1 门禁（批准并冻结 scope）进入开发阶段，写操作才会被允许。'
    )
  }
  if (!flow.scope?.frozen) {
    return 'scope 尚未冻结，开发阶段的写操作被拒绝。请先回到需求分析阶段点击「批准并冻结 scope」。'
  }
  const allowed = flow.scope.data?.in_scope?.files_expected_to_change ?? []
  const targetKey = compareKey(normalized)
  const matched = allowed.some((entry) => {
    const normalizedEntry = normalizeScopeEntry(flow.cwd, entry)
    if (!normalizedEntry) return false
    const entryKey = compareKey(normalizedEntry)
    return target.prefix ? targetKey === entryKey || targetKey.startsWith(entryKey + '/') : targetKey === entryKey
  })
  if (!matched) {
    return (
      '该文件不在冻结 scope 内：' + normalized + '\n' +
      'scope 声明的文件：' + (allowed.length ? allowed.join('、') : '（空）') + '\n' +
      '要修改它，必须先回到需求分析阶段更新 scope.json 并重新批准。'
    )
  }
  return null
}

/**
 * scope 命令清单匹配。
 *
 * 清单是用户在批准需求文档时一并过目的，所以它的粒度是「具体命令」而不是「阶段授权」。
 * 末尾的 `*` 只做前缀通配，例如 `node --check *`；它不会跨过逃逸字符，
 * 因为 `node --check a; rm -rf /` 这类命令在进到这里之前就被 SHELL_ESCAPE_HINTS 拒了。
 */
function scopeCommandMatches(flow, command) {
  const list = flow.scope?.data?.in_scope?.commands
  if (!Array.isArray(list) || list.length === 0) return false
  for (const entry of list) {
    const pattern = typeof entry === 'string' ? entry.trim() : ''
    if (!pattern) continue
    if (pattern === command) return true
    if (pattern.endsWith('*') && command.startsWith(pattern.slice(0, -1))) return true
  }
  return false
}

/**
 * 每条 shell 命令都进审计流水。
 *
 * 判定结果只留在返回值里的话，事后没人能回答「这一轮到底跑了哪些命令」——
 * flows.jsonl 里原来只有 shell.granted / shell.revoked（开关本身），没有命令原文。
 * 放宽白名单之前必须先有这张账：出问题时要能定位到具体命令与判定依据。
 */
function auditShell(flow, command, outcome, reason) {
  appendEvent(flow.cwd, flow, outcome === 'allowed' ? 'shell.allowed' : 'shell.denied', {
    command: command.slice(0, SHELL_AUDIT_LIMIT),
    truncated: command.length > SHELL_AUDIT_LIMIT,
    outcome,
    reason: reason ?? null,
  })
}

/**
 * shell 判定：逃逸痕迹 → 只读白名单 → 纯解析命令 → scope 命令清单 → 阶段授权。
 * 变更性命令只在用户显式授权（或已在 scope 清单里）后放行。
 */
function shellDenial(flow, args) {
  const command = typeof args?.command === 'string' ? args.command.trim() : ''
  if (!command) return '空 shell 命令被拒绝。'
  // 先把 `2>&1` / `> /dev/null` / `| tail -n 20` 这类纯收尾剥掉再判：
  // 它们不写盘也不换执行体，卡住它们只会让已授权的测试命令永远跑不了。
  const base = stripHarmlessSuffixes(command)
  const trimmed = base !== command
  const note = trimmed ? '（已忽略无害输出后缀）' : ''
  if (SHELL_ESCAPE_HINTS.test(base)) {
    auditShell(flow, command, 'escape', '重定向 / 管道 / 解释器内联')
    return (
      '这条命令可能写盘或执行任意代码（重定向 / 管道 / 解释器内联），无法核对冻结 scope，已拒绝：' +
      command.slice(0, 120) + '\n' +
      '请改用读取工具（read / ops_grep / ops_stat）。'
    )
  }
  if (SHELL_READONLY.test(base) || SHELL_GIT_BRANCH.test(base) || SHELL_PARSE_ONLY.test(base)) {
    auditShell(flow, command, 'allowed', '只读白名单' + note)
    return null
  }
  // scope 清单是用户在 S1 批准过的：清单内的命令不必再勾一次阶段授权。
  // 阶段闸门照旧：S1 与 S3 不放行任何变更性命令，清单也不例外。
  if (flow.stage === 'S2' || flow.stage === 'S4') {
    if (scopeCommandMatches(flow, base)) {
      auditShell(flow, command, 'allowed', 'scope 命令清单' + note)
      return null
    }
    if (flow.shellGrant === true) {
      auditShell(flow, command, 'allowed', '阶段授权' + note)
      return null
    }
  }
  auditShell(flow, command, 'denied', '不在白名单、不在 scope 清单、当前阶段未授权')
  return (
    '当前处于 ' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）阶段，只允许只读 shell 命令：' +
    command.slice(0, 120) + '\n' +
    '变更性命令需要用户在工作台显式授权（开发阶段的「允许执行构建/测试命令」），' +
    '或在需求文档的 scope 里把这条命令列进 commands 清单。'
  )
}

/**
 * 去掉注释与字符串字面量，只留可执行代码。
 *
 * 检测 Node IO 时不能直接扫原文：命令文本、文件路径在字符串里，说明文字在注释里，
 * `tools.ops_bash({ command: 'rmdir .tmp-x' })` 与 `// 清理 rmdir 残留` 都会被
 * \brmdir 误判成 Node IO，一条正常的清理命令就整条被拒（实机踩到）。
 * 真正的 IO 痕迹（import(、require(、fs.writeFileSync、globalThis[...]）都出现在
 * 字面量与注释之外，剥掉它们不会漏判。
 */
function stripCodeNoise(code) {
  const noStrings = String(code).replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/gu, "''")
  return noStrings
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
}

/**
 * 严格 JSON 单调用：`return await tools.<名字>({...})`。
 *
 * 开头与结尾允许注释：batching-guidance 这类插件要求程序第一行写 `// plan: …`。
 * 不认前置注释的话，Agent 照报错提示改成单调用也永远解析不出来，一律退化成
 * 「提到工具名就拒绝」——提示与行为自相矛盾（实机踩到）。
 */
const SINGLE_CALL = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*(?:return\s+)?await\s+tools\.([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)\s*;?(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*$/u

/** run_code 判定：拦住绕过工具层的 Node IO / 子进程（P0-5）。 */
function runCodeDenial(flow, args) {
  const code = typeof args?.code === 'string' ? args.code : ''
  if (!code.trim()) return '空 run_code 程序被拒绝。'
  const bare = stripCodeNoise(code)
  if (RUN_CODE_IO_HINTS.test(bare)) {
    return (
      'run_code 里不允许直接使用 Node IO / 子进程：它会绕过 scope 守卫（实测可以直接写出任意文件）。\n' +
      '请改用 read / ops_grep / ops_stat / write / edit 这类工具调用，' +
      '它们在流程运行期间会被 scope 守卫逐条核对。'
    )
  }
  // 单调用形式（await tools.x(严格 JSON)）能静态解析，就把参数也判一遍。
  const parsed = parseSingleToolCall(code)
  if (parsed) return scopeDenial(flow, parsed.name, parsed.args)

  // 多语句程序解析不出参数。这里不能直接放行：`const r = await tools.ops_remove({...})`
  // 的写操作会从这条缝里漏过去。退一步按「程序里提到了哪些工具」判：
  // 出现任何一个没登记成只读的工具名，就拒绝。
  const mentioned = new Set()
  // 点访问在剥过字面量的代码里找；括号访问的工具名本身就是字符串，
  // 只能回原文找——只扫 bare 会让 tools['ops_remove'] 变成 tools[''] 而漏判。
  for (const match of bare.matchAll(/tools\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/gu)) mentioned.add(match[1])
  for (const match of code.matchAll(/tools\s*\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/gu)) mentioned.add(match[1])
  // shell 工具在这里不算「无法核对」：它自己的命令文本会由嵌套调用的 pre-execute 再判一次
  // （实测 run_code 里 await tools.ops_bash(...) 仍会触发守卫），这里再拦一遍只是把
  // 正常的「先跑只读命令、再读结果」程序整段拒掉。
  const risky = Array.from(mentioned).filter((name) => !PASSIVE_TOOLS.has(name) && name !== 'run_code' && !SHELL_TOOLS.has(name))
  if (risky.length > 0) {
    return (
      'run_code 程序里用到了需要核对 scope 的工具：' + risky.join('、') + '\n' +
      '多语句程序无法静态取出参数，也就无法核对它要改哪个文件。\n' +
      '请拆成单次调用 `return await tools.<名字>(<严格 JSON 参数>)`，或改用独立的 write / edit 调用。'
    )
  }
  return null
}

/**
 * 并行只读：`return await Promise.all([tools.a({...}), tools.b({...})])`。
 *
 * 评审要一次核对十几个文件，逐个单调用转发既慢又容易超出步数上限。
 * 只放行这一种并行形状：每个元素仍是「工具名 + 严格 JSON 参数」，
 * 逐个过同一套只读判定，不解释任何其他 JavaScript。
 */
const PARALLEL_CALL = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*return\s+await\s+Promise\.all\(\s*\[([\s\S]*)\]\s*\)\s*;?(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*$/u
const PARALLEL_ELEMENT = /^tools\.([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/u

/** 按顶层逗号切分：JSON 里的逗号、字符串里的逗号都不能切。 */
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      current += char
      if (char === '\\') {
        current += text[index + 1] ?? ''
        index += 1
      } else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      current += char
      continue
    }
    if (char === '{' || char === '[' || char === '(') depth += 1
    if (char === '}' || char === ']' || char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current)
  return parts
}

/** 解析并行只读调用；形状不对返回 null。 */
function parseParallelCalls(code) {
  const match = PARALLEL_CALL.exec(code)
  if (!match) return null
  const parts = splitTopLevel(match[1])
  if (!parts.length) return null
  const calls = []
  for (const part of parts) {
    const element = PARALLEL_ELEMENT.exec(part.trim())
    if (!element || element[1] === 'run_code') return null
    try {
      const args = JSON.parse(element[2])
      if (!args || typeof args !== 'object' || Array.isArray(args)) return null
      calls.push({ name: element[1], args })
    } catch {
      return null
    }
  }
  return calls
}

/** 解析 return await tools.<名字>(<严格 JSON>)；解析不出来返回 null。 */
function parseSingleToolCall(code) {
  const match = SINGLE_CALL.exec(code)
  if (!match || match[1] === 'run_code') return null
  try {
    const args = JSON.parse(match[2])
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null
    return { name: match[1], args }
  } catch {
    return null
  }
}

/**
 * 记下子代理这次调用真正读过哪些文件。
 *
 * 评审要求每个目标文件都有读取痕迹（readAttempts），缺一条就把该角度判成未覆盖。
 * 所以这里的形状识别必须和守卫放行的形状完全一致：单调用与 Promise.all 并行调用都算。
 * 只认单调用会让「并行读三个文件」被判成没读——而并行恰恰是我们鼓励的写法。
 */
function recordReadAttempts(attempts, flow, name, args) {
  let calls
  if (name === 'run_code') {
    calls = parseParallelCalls(args?.code)
    if (!calls) {
      const single = parseSingleToolCall(args?.code)
      calls = single ? [single] : []
    }
  } else {
    calls = [{ name, args }]
  }
  for (const call of calls) {
    if (call.name !== 'read' && call.name !== 'ops_read_files') continue
    const paths = call.name === 'read'
      ? [call.args?.file_path]
      : Array.isArray(call.args?.files) ? call.args.files.map((file) => file?.path)
        : Array.isArray(call.args?.paths) ? call.args.paths : [call.args?.path]
    for (const path of paths) {
      if (typeof path === 'string' && path) attempts.add(normalizeTarget(flow.cwd, path))
    }
  }
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
    // 只接收两种形状：单个工具调用，或 Promise.all 里的一批只读调用；
    // 参数必须是严格 JSON，不执行/解释其他代码。
    const code = typeof args?.code === 'string' ? args.code : ''
    const parallel = parseParallelCalls(code)
    if (parallel) {
      for (const call of parallel) {
        const denial = readonlyDenial(call.name, call.args, allowShellWrite)
        if (denial) return denial
      }
      return null
    }
    const match = SINGLE_CALL.exec(code)
    if (!match || match[1] === 'run_code') {
      return denied + ' 仅允许 return await tools.<工具名>(<JSON 参数>) 或 return await Promise.all([tools.<工具名>(<JSON 参数>), …])。'
    }
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
    if (args?.script_path || !command) return denied
    if (SHELL_ESCAPE_HINTS.test(command)) return denied + ' 不允许重定向、管道、子 shell 或解释器内联。'
    // 只读命令放行。原来只认精确的 pwd，评审子代理连 git diff 都拿不到，
    // 只能按文件正文猜改了什么；测试方向也核不了工作区有没有多余改动。
    // git status 会刷新索引文件，但既不改工作区内容也不改历史，属于可接受的副作用。
    if (SHELL_READONLY.test(command) || SHELL_GIT_BRANCH.test(command) || SHELL_PARSE_ONLY.test(command)) return null
    return denied + ' 测试命令、脚本和解释器不能被推定为只读；请改用只读命令（pwd / ls / cat / git diff / git status / git log / node --check），或取得该测试方向的明确授权。'
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
  const settled = (s) => ['passed', 'skipped_by_user', 'accepted_with_risk'].includes(flow.stages[s].status)
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
    /** 页面实际执行的工厂指纹，仅在已认证的 state 请求中更新；不跨宿主重启复用。 */
    this.runtimeClients = new Map()
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
      readAttempts: policy?.readAttempts,
      signal: policy?.signal,
    })
  }

  /** 最终守卫与 pre-execute 使用同一规则；放弃/回退后仍保护未释放会话。 */
  childDenial(exec) {
    const policy = this.childPolicyOf(sessionIdOf(exec))
    if (!policy) return null
    const flow = this.get(policy.parent)
    const workspace = flow ? this.workspaceOf(flow.cwd) : null
    const direction = flow ? resolveDirections(flow, workspace).find((item) => item.id === policy.directionId) : null
    const allowShellWrite = policy.allowShellWrite && !policy.signal?.aborted && !flow?.finished &&
      flow?.id === policy.flowId && flow?.stage === 'S4' && direction?.needsWrite === true &&
      (flow.writeGrants ?? []).includes(policy.directionId)
    const denial = readonlyDenial(exec.name, exec.arguments, allowShellWrite)
    if (!denial && policy.readAttempts && flow) {
      recordReadAttempts(policy.readAttempts, flow, exec.name, exec.arguments)
    }
    return denial
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

  /**
   * 按工作目录找运行中的流程。
   * 用户自己 spawn 的普通子代理没有登记进 childOwner，但它在同一个项目里干活，
   * 同样要守 scope——这是 P1-5 的兜底。
   */
  activeFlowByCwd(cwd) {
    if (typeof cwd !== 'string' || !cwd) return null
    // 不能用 normalizeTarget(cwd, '.')：它返回的是「相对 cwd 的路径」，
    // 目标就是 cwd 本身时得到空串，任何两个目录都会互相等于。
    const key = compareKey(resolve(cwd).replaceAll(sep, '/'))
    let nested = null
    for (const flow of this.flows.values()) {
      if (flow.finished) continue
      const flowKey = compareKey(resolve(flow.cwd).replaceAll(sep, '/'))
      if (flowKey === key) return flow
      // 子代理可以把 cwd 指到项目子目录：那也还在这个流程的项目里，不能因此漏判。
      if (!nested && key.startsWith(flowKey + '/')) nested = flow
    }
    return nested
  }

  /** 惰性恢复快照；写例外只对当次测试有效，冷恢复后必须重新勾选。 */
  hydrate(cwd) {
    if (this.loaded.has(cwd)) return
    for (const raw of loadFlowsFromDisk(cwd)) {
      const flow = repairFlow(raw)
      if (!flow || flow.finished || this.flows.has(flow.sessionId)) continue
      {
        const previous = flow.writeGrants ?? []
        flow.writeGrants = []
        const interrupted = flow.execution?.status === 'running'
        if (interrupted) {
          flow.execution = { ...flow.execution, status: 'failed', text: '宿主重启后没有可确认的最终执行结果，不能按任务 ID 认为已经完成。', at: nowIso() }
        }
        // 写授权要靠这里清空：repairFlow 只保证它是数组，不清内容。
        // shellGrant 不用在这里再清一遍——repairFlow 冷恢复时已无条件置为 false。
        this.flows.set(flow.sessionId, flow)
        if (interrupted) persist(flow)
        if (previous.length) {
          appendEvent(flow.cwd, flow, 'write.revoked', { ids: previous, reason: '宿主从磁盘恢复流程，新的测试运行需要重新授权' })
          persist(flow)
        }
      }
    }
    this.loaded.add(cwd)
  }

  get(sessionId) {
    return this.flows.get(sessionId) ?? null
  }

  require(sessionId) {
    const flow = this.flows.get(sessionId)
    if (!flow) throw new Error('当前会话还没有流程。先调用 flowgate_start 启动四阶段流程。')
    return flow
  }

  /** 提示条和启动入口共用精确工作区匹配，子目录工作区单独处理。 */
  workspaceFlow(cwd) {
    this.hydrate(cwd)
    const key = compareKey(resolve(cwd))
    return [...this.flows.values()].find((flow) =>
      !flow.finished && !flow.cancelled && compareKey(resolve(flow.cwd)) === key) ?? null
  }

  workspaceHint(sessionId) {
    const cwd = cwdOfSession(this, sessionId) || this.get(sessionId)?.cwd
    if (!cwd) return null
    const flow = this.workspaceFlow(cwd)
    if (!flow) return { path: cwd, active: false, flow: null }
    const view = this.view(flow.sessionId)
    return {
      path: cwd,
      active: true,
      flow: {
        sessionId: flow.sessionId,
        stage: view.stage,
        stageIndex: view.progress.stageIndex,
        label: view.progress.label,
        waiting: view.waiting,
        waitingKind: view.waitingKind,
        activity: view.activity,
        elapsedMs: view.elapsedMs,
        updatedAt: view.updatedAt,
        acceptance: { counts: view.acceptance.counts },
        test: view.test ? { directions: view.test.directions.map((direction) => ({ points: (direction.points ?? []).map((point) => ({ result: point.result })) })) } : null,
      },
    }
  }

  start(sessionId, cwd, title, preset, brief) {
    const running = this.workspaceFlow(cwd)
    if (running) throw new Error('该工作区已有流程在进行，请先结束或放弃它，再启动新流程。')
    const flow = createFlow({ sessionId, cwd, title, preset, brief })
    flow.stages.S1.status = 'active'
    this.flows.set(sessionId, flow)
    appendEvent(cwd, flow, 'flow.started', { preset: flow.preset, title: flow.title })
    persist(flow)
    return flow
  }

  /** 只移除失效的单次授权；重新启用方向或恢复 needsWrite 都不会自动重新授予。 */
  reconcileWriteGrants(flow, workspace) {
    const previous = flow.writeGrants ?? []
    if (!previous.length) return
    const writable = new Set(resolveDirections(flow, workspace).filter((item) => item.needsWrite === true).map((item) => item.id))
    const next = previous.filter((id) => writable.has(id))
    if (next.length === previous.length) return
    flow.writeGrants = next
    appendEvent(flow.cwd, flow, 'write.revoked', { ids: previous.filter((id) => !writable.has(id)), reason: '测试方向已停用、移除或不再声明需要写权限' })
    persist(flow)
  }

  reconcileWorkspaceGrants(cwd, workspace) {
    for (const flow of this.flows.values()) {
      if (!flow.finished && resolve(flow.cwd) === cwd) this.reconcileWriteGrants(flow, workspace)
    }
  }

  /** 配置只在签名变化时重新解析；缓存命中也要核对刚从磁盘恢复的流程授权。 */
  workspaceOf(cwd) {
    if (!cwd) return null
    cwd = resolve(cwd)
    const signature = fileSignature(workspaceConfigFile(cwd))
    if (!this.workspaces.has(cwd) || this.workspaceSignatures.get(cwd) !== signature) {
      this.workspaces.set(cwd, loadWorkspaceConfig(cwd))
      this.workspaceSignatures.set(cwd, signature)
    }
    const config = this.workspaces.get(cwd)
    this.reconcileWorkspaceGrants(cwd, config)
    return config
  }

  /** 四阶段作为一个整体原子落盘；只有全部恢复内置才删除配置文件。 */
  setWorkspaceStages(cwd, value) {
    cwd = resolve(cwd)
    const stages = Object.fromEntries(STAGES.map((stage) => [stage, normalizeWorkspaceStage(value[stage], stage)]))
    if (STAGES.every((stage) => stages[stage] === null)) {
      try {
        unlinkSync(workspaceConfigFile(cwd))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      this.workspaces.set(cwd, null)
      this.workspaceSignatures.set(cwd, null)
      this.reconcileWorkspaceGrants(cwd, null)
      return null
    }
    const config = saveWorkspaceConfig(cwd, { version: WORKSPACE_CONFIG_VERSION, updatedAt: nowIso(), stages })
    // 兼容旧宿主消费者；磁盘只保存 stages 这一份事实来源。
    config.rules = stages.S2
    this.workspaces.set(cwd, config)
    this.workspaceSignatures.set(cwd, fileSignature(workspaceConfigFile(cwd)))
    this.reconcileWorkspaceGrants(cwd, config)
    return config
  }

  /** 旧开发规则接口只更新 S2，不能抹掉其他阶段的设置。 */
  setWorkspaceRules(cwd, rules) {
    const current = this.workspaceOf(cwd)
    const stages = Object.fromEntries(STAGES.map((stage) => [stage, workspaceStage(current, stage)]))
    stages.S2 = rules
    return this.setWorkspaceStages(cwd, stages)
  }

  /** 客户端可见的视图（不含内部等待器等）。 */
  view(sessionId) {
    const flow = this.flows.get(sessionId)
    const runtime = runtimeOf(flow ?? { sessionId })
    if (!flow) {
      return { active: false, presets: PRESETS, builtinAngles: BUILTIN_ANGLES, builtinDirections: BUILTIN_DIRECTIONS, runtime }
    }
    // 门禁同样与等待器解耦：产物已交、还没决策就可确认，中断也不影响按钮。
    const gatePending =
      !flow.finished && gateArtifactReady(flow) && flow.stages[flow.stage]?.gate === 'pending'
    const workspace = this.workspaceOf(flow.cwd)
    const snapshot = currentSnapshot(flow)
    const acceptance = acceptanceLedger(flow, snapshot, runtime)
    return {
      active: true,
      snapshot, acceptance, runtime,
      remediation: flow.remediation ?? null,
      stageSummary: stageSummary(flow, acceptance, runtime),
      acceptanceDecision: flow.acceptanceDecision ?? null,
      // 结束方式单独给一份：acceptanceDecision 只在 S4 有值，
      // 而「这条流程是不是全部验收通过」在别的阶段结束（放弃、跳过）时同样要说得清。
      closure: flow.closure ?? null,
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
        riskAcceptance: flow.stages[s].riskAcceptance ?? null,
      })),
      skippedCount: skippedCount(flow),
      scope: flow.scope,
      // 冻结时用户明确接受的验收方案缺口（含原因）：结束后也要能追溯。
      scopeRisksAccepted: flow.scope?.data?.scope_risks ?? null,
      // 文档已提交且流程未结束就是待批准：不再取决于某次工具调用是否还挂在内存里。
      // 界面靠 pending 决定显示按钮，靠 interrupted 说明「入口曾中断但仍可确认」。
      doc: {
        ...flow.doc,
        pending: !flow.finished && Boolean(flow.doc?.html) && !flow.doc?.decision,
        interrupted: !flow.finished && Boolean(flow.doc?.html) && !this.gates.has(sessionId),
        // 批准前用户必须能看到「这次将允许改哪些文件」，否则等于盲签（P0-4）。
        pendingScope: flow.finished ? null : flow.pendingScope ?? null,
        // 提交时被剔除的越界条目：批准前给用户看，别让它们静默消失。
        droppedScopeEntries: flow.finished ? [] : flow.pendingScopeDropped ?? [],
        // 验收方案缺口：批准前必须看见。非空时界面不能一键批准，要先看清清单再确认接受。
        pendingScopeRisks: flow.finished ? [] : flow.pendingScopeRisks ?? [],
      },
      // 门禁模式：auto 没有阻塞项就自动放行，manual 每一步都等确认；任何阶段都能切。
      gateMode: flow.gateMode ?? 'manual',
      // 上次自动判定为什么没放行：界面要能回答「这次怎么没自动过」，否则用户只会觉得开关坏了。
      gateBlockers: flow.gateBlockers ?? null,
      // 自动放行过哪几关：结束后回溯时「谁批准的这一关」必须说得清。
      autoPassed: flow.autoPassed ?? null,
      shellGrant: flow.shellGrant === true,
      // 落盘失败会让冷恢复退回旧快照，用户必须能看到这条，而不是以为一切正常。
      persistError: flow.persistError ?? null,
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
      // S4 的目录必须和 resolveDirections 用同一份数据：写权限声明只存在流程里，
      // 裸 stageConfig 看不到它，设置弹窗就会一直显示「未声明」，点完声明像没生效。
      stageConfigs: Object.fromEntries(STAGES.map((stage) => {
        const config = stageConfig(flow, stage, workspace)
        if (stage !== 'S4') return [stage, config]
        return [stage, { ...config, catalog: withDirectionWriteDeclared(flow, config.catalog), items: withDirectionWriteDeclared(flow, config.items) }]
      })),
      angles: resolveAngles(flow, workspace),
      angleCatalog: angleCatalog(flow, workspace),
      // PRD 4.5：开发规则清单，S2 主区与设置面板都读这两项。
      rules: resolveRules(flow, workspace),
      ruleIds: activeRules(flow, workspace),
      ruleCatalog: ruleCatalog(flow, workspace),
      /** 规则从哪来：本次流程临时改过 / 跟工作区默认 / 内置默认（界面必须标出来）。 */
      ruleSource: ruleSourceOf(flow, workspace),
      /** 工作区默认规则：路径、是否已配置、保存的是哪一套（null 表示没有 ids 覆盖）。 */
      workspaceRules: {
        file: workspaceConfigLabel(),
        configured: Boolean(workspaceStage(workspace, 'S2')),
        ruleIds: workspaceStage(workspace, 'S2')?.ids ?? null,
        customCount: (workspaceStage(workspace, 'S2')?.custom ?? []).length,
        updatedAt: workspace?.updatedAt ?? null,
      },
      directions: resolveDirections(flow, workspace).map((direction) => ({
        ...direction,
        writeGranted: (flow.writeGrants ?? []).includes(direction.id),
      })),
      directionCatalog: directionCatalog(flow, workspace),
      writeGrants: (flow.writeGrants ?? []).slice(),
      // 声明只存在流程里，目录是派生结果。界面把这份原始列表也摆出来，
      // 用户点完能立刻分清「数据没写进去」和「界面没刷新」。
      directionWriteDeclared: (flow.directionWriteDeclared ?? []).slice(),
      /** 用户声明的额外只读工具：界面据此显示与编辑。 */
      toolAllowlist: (flow.toolAllowlist ?? []).slice(),
      review: flow.review ? { ...flow.review, counts: findingCounts(flow.review.angles ?? []) } : null,
      // 评审发现里落在 scope 外的部分：客户端据此提示「这些得回 S1 调 scope」。
      reviewOutsideScope: flow.review ? reviewFindingsOutsideScope(flow) : [],
      test: flow.test,
      devChanges: flow.devChanges,
      /** 部分重跑：回退留下的可复用结论与判定理由；客户端据此提示「这些不用重跑」。 */
      carryOver: flow.finished ? null : carryOverAdvice(flow),
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
        // 模式必须念出来：auto 下门禁会自己往下走，Agent 不能还以为有人在盯每一关。
        '门禁模式：' + (flow.gateMode === 'auto' ? '自动通过（没有阻塞项就进入下一阶段）' : '每步确认（每个阶段出口都等用户点通过）'),
        ...((flow.gateBlockers?.items ?? []).length
          ? ['这一关没有自动通过，因为：', ...flow.gateBlockers.items.map((item) => '- ' + item)]
          : []),
        'scope：' + (flow.scope.frozen
          ? '已冻结（' + (flow.scope.data?.in_scope?.files_expected_to_change ?? []).length + ' 个文件、' +
            (flow.scope.data?.in_scope?.commands ?? []).length + ' 条可执行命令、' +
            (flow.scope.data?.in_scope?.shared_contracts ?? []).length + ' 条影响面）'
          : '未冻结'),
      ]
      // 缺口不能只留在界面里：Agent 也要知道自己是在什么限制下推进，别把缺口当成「已经通过」。
      const acceptedRisks = flow.scope?.data?.scope_risks
      if (acceptedRisks?.risks?.length) {
        lines.push('验收方案缺口（用户已明确接受 ' + acceptedRisks.risks.length + ' 条）：')
        for (const risk of acceptedRisks.risks) lines.push('- ' + risk.message + '（' + (risk.acs ?? []).join('、') + '）')
        if (acceptedRisks.note) lines.push('用户补充的接受原因：' + acceptedRisks.note)
        lines.push('S4 仍严格按每条验收标准声明的方法核验证据：缺口不会被当成通过。')
      }
      if (!flow.finished && (flow.pendingScopeRisks ?? []).length) {
        lines.push('待批准的 scope 有 ' + flow.pendingScopeRisks.length + ' 条验收方案缺口，用户批准时需要明确确认接受。')
      }
      // 影响面必须逐个念出来：评审要据此判断发现是否属于本次范围，Agent 也得知道自己承诺动过什么。
      const contracts = flow.scope?.frozen ? (flow.scope.data?.in_scope?.shared_contracts ?? []) : []
      if (contracts.length) {
        lines.push('本次会动的共用契约与已知约束（影响面）：')
        for (const entry of contracts) lines.push('- ' + entry)
      }
      if (flow.finished) lines.push('状态：' + closureSentence(flow))
      const skipped = skippedCount(flow)
      if (skipped > 0) lines.push('本流程有 ' + skipped + ' 个阶段被用户跳过')
      const checklist = (stage, label) => {
        const config = stageConfig(flow, stage, workspace)
        const source = RULE_SOURCE_LABEL[config.source]
        lines.push(label + '（来源：' + source + '）：')
        for (const item of config.items) {
          lines.push('- [' + item.id + '] ' + item.name + '（来源：' + source + '）：' + (item.points ?? []).join('；'))
        }
        if (!config.items.length) lines.push('未启用条目。')
      }
      if (flow.stage === 'S1') checklist('S1', '需求分析规则')
      if (flow.stage === 'S2') checklist('S2', '开发规则检查清单（逐条遵守，S3 会逐条核对）')
      if (flow.stage === 'S3') {
        checklist('S3', '评审角度')
        checklist('S2', '开发规则检查清单（评审时逐条核对）')
        lines.push('评审发现的归属：每条 finding 必须带 ac（冻结 scope 里的验收标准 id）；' +
          '对不上 ac 或落在 scope 文件之外的发现只作提示，不计入重做清单。')
      }
      if (flow.stage === 'S4') checklist('S4', '测试方向')
      // 部分重跑：回退留下的结论还有效时，直接点名能跳过的条目，别让 Agent 整轮重来。
      const advice = flow.finished ? null : carryOverAdvice(flow)
      if (advice && (flow.stage === 'S3' || flow.stage === 'S4')) {
        const group = flow.stage === 'S3' ? advice.angles : advice.directions
        if (group.length) {
          lines.push('上一轮结论（' + (advice.from ?? '?') + ' 回退时留下，共 ' + group.length + ' 条）：')
          for (const entry of group) {
            lines.push('- [' + entry.id + '] ' + entry.name + '：' + (entry.reusable ? '可复用' : '需重跑') + '（' + entry.reason + '）')
          }
          if (group.some((entry) => entry.reusable)) {
            lines.push(flow.stage === 'S3'
              ? '可复用的角度 id 传给 flowgate_review 的 reusedAngles；用 flowgate_review_run 时自动复用。'
              : '可复用的方向 id 传给 flowgate_test 的 reusedDirections；用 flowgate_test_run 时自动复用。')
          }
        }
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
        title: { type: 'string', description: '这次任务的简短标题，可省略。界面启动时自动生成；省略时由需求描述派生，再退化为「未命名任务」。' },
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
      // 追问内容会进快照并每次全量写盘：不设上限，一段长文本就能把流程拖慢。
      const question = typeof args.question === 'string' ? args.question.trim() : ''
      if (!question) throw new Error('追问内容不能为空。')
      if (question.length > 500) throw new Error('追问内容不能超过 500 字符（当前 ' + question.length + '）。')
      const context = typeof args.context === 'string' ? args.context.trim() : ''
      if (context.length > 1000) throw new Error('追问的背景说明不能超过 1000 字符（当前 ' + context.length + '）。')
      const options = (Array.isArray(args.options) ? args.options : [])
        .slice(0, 4)
        .map((option) => ({
          ...option,
          label: typeof option?.label === 'string' ? option.label.trim().slice(0, 120) : '',
          tradeoff: typeof option?.tradeoff === 'string' ? option.tradeoff.trim().slice(0, 300) : '',
        }))
        .filter((option) => option.label.length > 0)
      if (options.length < 2) throw new Error('至少给出 2 个选项。')
      const pending = {
        id: 'q_' + randomUUID().slice(0, 8),
        question,
        context,
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
      // 追问记录只用于回看 S1 的决策过程：留最近 100 条足够，不能让快照跟着问题数无限长。
      if (flow.grill.answered.length >= 100) flow.grill.answered.splice(0, flow.grill.answered.length - 99)
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
      '每条 acceptance_criteria 都要声明 verification.method 与 procedure。视觉宽度和对齐验收必须实际测量真实宿主元素，CSS字符串断言不能证明视觉通过；无接入时记录未覆盖。',
      'scope 里必须写 shared_contracts：为实现这个需求要动的共用契约、共用基础设施与已知约束。' +
        '评审会据此判断一条发现是否落在本次开发范围内，没写就等于让评审去猜。',
      // 清单驱动的前提是「清单是读出来的」：凭印象编的命令会在 S2 第一次跑构建时当场失败。
      'commands 必须从项目里读出来，不要凭印象编：先看 package.json 的 scripts、测试框架配置、tsconfig、Makefile，' +
        '再把真正要跑的命令逐条写进来，并用 command_sources 标注每条来自哪里、能证明哪几条验收标准。' +
        '清单是用户批准的授权范围：写全了，S2/S4 跑构建与测试就不必再勾选任何开关；写空了，用户就只能回到那个全局开关。',
      '自动通过模式下，S1 只有在体检没有阻塞项与缺口时才会自动冻结：验收方案缺口（缺测试命令、验证步骤点名 scope 外文件、视觉验收没写测量方式）会让它停下来等人确认。',
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
            commands: {
              type: 'array',
              items: { type: 'string' },
              description:
                '用户批准后可以直接执行的命令清单（如 npm test、node --check *）。' +
                'S2 / S4 里命中清单的命令直接放行，不需要再勾「允许执行构建/测试命令」；' +
                '末尾 * 做前缀通配。写清具体命令，别写成「构建相关命令」这种散文。',
            },
            command_sources: {
              type: 'array',
              description:
                '命令清单的来源标注（可选，不进冻结的 scope.json）：每条命令是从哪读出来的、对应哪几条验收标准。' +
                'S1 请先读 package.json 的 scripts、测试框架配置、tsconfig、Makefile，再按读到的内容写命令，不要凭印象编。' +
                '标注的作用是让用户批准前看懂「这条命令为什么在这里」，也让体检能逐条 AC 判断清单是否覆盖到位。',
              items: {
                type: 'object',
                properties: {
                  command: { type: 'string', description: '与 commands 里某一条完全一致。' },
                  from: { type: 'string', description: '来源，例如 package.json scripts.test。' },
                  acs: { type: 'array', items: { type: 'string' }, description: '这条命令能证明哪些验收标准（写 AC id）。' },
                },
                required: ['command', 'from'],
                additionalProperties: false,
              },
            },
            capabilities: { type: 'array', items: { type: 'string' } },
            shared_contracts: {
              type: 'array',
              items: { type: 'string' },
              description:
                '本次会动的共用契约与已知约束（影响面）：为实现需求要改的共用函数 / 接口 / 入参约定、' +
                '被牵动的既有行为、以及必须遵守的约束。一条一句，写具体位置与受影响方，' +
                '例如「postJson 入参只接受 signal，调用方传错也覆盖不掉请求语义（lib/client.js）」。' +
                '评审用它判断一条发现是否属于本次开发范围。',
            },
            out_of_scope_explicitly: { type: 'array', items: { type: 'string' } },
            acceptance_criteria: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  when: { type: 'string' },
                  then: { type: 'string' },
                  verification: {
                    type: 'object',
                    properties: {
                      method: { type: 'string', enum: ['unit', 'integration', 'visual', 'manual'] },
                      procedure: { type: 'string', description: '具体步骤与预期证据；视觉对齐须测真实宿主元素左右边缘并核对页面版本。' },
                      tolerancePx: { type: 'number', minimum: 0, maximum: 10 },
                    },
                    required: ['method', 'procedure'], additionalProperties: false,
                  },
                },
                required: ['id', 'when', 'then'],
                additionalProperties: false,
              },
            },
          },
          required: ['files_expected_to_change', 'commands', 'capabilities', 'out_of_scope_explicitly', 'acceptance_criteria'],
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
          scopeRisks: {
            type: 'array',
            items: { type: 'string' },
            description: '批准前静态体检出的验收方案缺口（每条一句）。空数组表示没有发现缺口。',
          },
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
      // 文档与 scope 都会原样进快照并每次全量写盘：体积不设上限，一次提交就能让流程卡死。
      const html = typeof args.html === 'string' ? args.html : ''
      if (!html.trim()) throw new Error('需求文档 HTML 不能为空。')
      if (html.length > 400000) {
        throw new Error('需求文档 HTML 超过 400000 字符（当前 ' + html.length + '），请精简后再提交。')
      }
      const scopeSize = JSON.stringify(args.scope ?? {}).length
      if (scopeSize > 40000) {
        throw new Error('scope 参数超过 40000 字符（当前 ' + scopeSize + '），请精简条目后再提交。')
      }

      const normalizedScope = validatedPendingScope(cwd, args.scope)
      // S1 是唯一能低成本改 scope 的阶段：验收方法跟命令 / 文件清单对不上时，这里就要说清，
      // 别等 S4 才发现「声明 integration，却只有 unit 证据」——那时只能带缺口结项或整轮退回。
      const readiness = scopeReadiness(
        normalizedScope.scope.acceptance_criteria,
        normalizedScope.scope.commands,
        normalizedScope.scope.files_expected_to_change,
        { commandSources: normalizedScope.scope.command_sources, project: projectProfile(cwd) },
      )
      if (readiness.blockers.length) {
        throw new Error('scope 的验收标准无法核验，请先修正再提交：\n- ' + readiness.blockers.map((item) => item.message).join('\n- '))
      }
      flow.doc = {
        html,
        recommendedPreset: args.recommendedPreset ?? flow.preset,
        reason: args.reason ?? '',
        at: nowIso(),
        // 用户决策后写在这里：工具调用中断也不影响这份文档还能被确认。
        decision: null,
      }
      // scope 是 Agent 自报的：先规范化再存，绝对路径与项目根之外的条目一律剔除。
      flow.pendingScope = normalizedScope.scope
      // 被剔除的越界条目要留痕：用户批准前有权知道 Agent 报了哪些越界路径。
      flow.pendingScopeDropped = normalizedScope.dropped
      // 风险随 scope 一起留在流程里：界面按它决定批准前要不要走确认区。
      flow.pendingScopeRisks = readiness.risks
      appendEvent(cwd, flow, 'doc.submitted', {
        recommendedPreset: flow.doc.recommendedPreset,
        files: normalizedScope.scope.files_expected_to_change,
        commands: normalizedScope.scope.commands,
        droppedScopeEntries: normalizedScope.dropped,
        scopeRisks: readiness.risks.map((item) => item.code),
      })
      persist(flow)

      const outcome = await awaitGate(service, flow, sessionId, 'doc', exec)
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
          message:
            '用户要求修改需求，scope 尚未冻结。\n' +
            (typeof flow.doc?.revisionNote === 'string' && flow.doc.revisionNote.trim()
              ? '修改意见原文：\n' + flow.doc.revisionNote.trim() + '\n'
              : '用户这次没有填写修改意见：先问清要改什么，不要自己猜。\n') +
            '进入 ' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）：按上面的意见改完后重新提交 flowgate_doc。',
        }
      }
      const acceptedRisks = Array.isArray(result.risksAccepted) ? result.risksAccepted : []
      return {
        decision: result.decision,
        preset: flow.preset,
        frozen: result.frozen,
        scopeRisks: acceptedRisks.map((item) => item.message),
        message:
          'scope 已冻结，进入 S2 开发阶段。只能修改：' +
          (flow.scope?.data?.in_scope?.files_expected_to_change?.join('、') || '（scope 未声明文件）') +
          '。现在直接开始 S2：先读这些文件再改，完成后调用 flowgate_gate 等待用户点「完成开发」；' +
          '不要停下来等用户再确认一次。' +
          (acceptedRisks.length
            ? '\n用户在批准时明确接受了 ' + acceptedRisks.length + ' 条验收方案缺口：\n- ' +
              acceptedRisks.map((item) => item.message).join('\n- ') +
              '\nS4 仍然严格按每条 AC 声明的方法核验证据：unit 证据不能顶 integration，集成验收要真的跑到跨模块测试。'
            : ''),
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
        flow.snapshot = currentSnapshot(flow)
        appendEvent(cwd, flow, 'dev.summary', { ...changes, snapshot: flow.snapshot.id, complete: flow.snapshot.complete })
        persist(flow)
      }
      if (args.summary) flow.gateNote = args.summary

      const outcome = await awaitGate(service, flow, sessionId, 'gate', exec)
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
        passGate(flow, decision === 'skip' ? 'skip' : 'pass', outcome)
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
        rollbackTo(flow, outcome.to ?? 'S2', 'user', outcome.note ?? '')
        return {
          decision,
          stage,
          next: flow.stage,
          message: '用户退回到 ' + flow.stage + ' 重做。' + remediationNote(flow),
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
  const status = await execFileAsync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all'], options)
  const numstat = await execFileAsync('git', ['diff', '--numstat'], options)
  return String(status.stdout ?? '') + '\n---numstat---\n' + String(numstat.stdout ?? '')
}

/** porcelain 里合法的 XY 状态码；别的字符只可能来自 stderr 混入或非仓库目录。 */
const PORCELAIN_CODES = new Set([' ', 'M', 'A', 'D', 'R', 'C', 'U', '?', '!'])

/** 解析 git status --porcelain=v1 与 git diff --numstat 的输出。 */
export function parseChanges(text, at) {
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
      // 目录不是 git 仓库时，stderr 的 "fatal: not a git repository" 会被当成一行
      // porcelain（'fa' + 路径），评审就会看到一条根本不存在的改动文件。状态码不合法就丢掉。
      if (status.length < 2 || !PORCELAIN_CODES.has(status[0]) || !PORCELAIN_CODES.has(status[1])) continue
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
  const changes = { files: files.concat(untracked), tracked: files, untracked, added, removed, at }
  // 没看到分隔行说明第一条 git 命令就没跑成（非仓库、git 不在 PATH）：
  // 空摘要会让评审以为「没有改动」，必须把这一点说出来。
  if (!inNumstat) {
    const first = String(text).split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? ''
    changes.error = '变更摘要可能不完整：git 没有正常返回' + (first ? '（' + first.slice(0, 160) + '）' : '') + '。评审时需要人工确认改动范围。'
  }
  return changes
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
        command: 'git -c core.quotepath=false status --porcelain=v1 --untracked-files=all && echo "---numstat---" && git diff --numstat',
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

/** 报告字段一律按上限裁剪：静默放行超长内容会让快照越写越大，直到写盘变慢。 */
function clampText(value, limit) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length > limit ? text.slice(0, limit) + '…（超长已截断）' : text
}

function normalizeSubmittedAngles(flow, angles) {
  return (Array.isArray(angles) ? angles : []).slice(0, REPORT_ENTRY_LIMIT).map((angle) => {
    const normalized = (Array.isArray(angle?.findings) ? angle.findings : []).map((finding) => ({
      ...finding, file: clampText(finding?.file, 400),
      ac: typeof finding?.ac === 'string' ? clampText(finding.ac, 64) : undefined,
      summary: clampText(finding?.summary, FINDING_SUMMARY_LIMIT),
    }))
    const rank = { CRITICAL: 0, MAJOR: 1, MINOR: 2 }
    const sorted = normalized.slice().sort((a, b) => (rank[a?.severity] ?? 3) - (rank[b?.severity] ?? 3))
    const omittedCounts = findingCounts([{ findings: sorted.slice(FINDINGS_LIMIT).map((finding) => ({ ...finding, ...classifyFinding(flow, finding) })) }])
    return { ...angle, id: clampText(angle?.id, 64), name: clampText(angle?.name, 120), findings: capFindings(flow, normalized), omittedCounts }
  })
}

const ACCEPTANCE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      ac: { type: 'string' }, status: { type: 'string', enum: ['pass', 'fail', 'uncovered', 'excluded'] },
      excludeReason: { type: 'string', description: 'status=excluded 时必填：这条验收标准为什么在当前环境无法验证（缺依赖、需要网络或特权、需要特定系统）。环境受限不阻塞门禁，但必须写明原因。' },
      method: { type: 'string', enum: ['unit', 'integration', 'visual', 'manual'] },
      evidence: { type: 'string' }, version: { type: 'string', description: '可省略：省略时由工具自动填当前内容快照 id。仅当证据确实对应另一份代码（例如重跑旧版本）时才显式填写；与当前快照不一致的证据不会被补盖当前版本，会按未覆盖计入账本。' },
      artifact: { type: 'string' }, evidenceId: { type: 'string', description: '真实页面 inspectLayout 采集后返回的布局证据回执 ID。' },
      runtime: {
        type: 'object', properties: {
          hostRevision: { type: 'string' }, clientRevision: { type: 'string' }, pageId: { type: 'string' },
          viewport: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'], additionalProperties: false },
        }, required: ['hostRevision', 'clientRevision', 'viewport'], additionalProperties: false,
      },
      measurements: { type: 'array', items: {
        type: 'object', properties: {
          element: { type: 'string' }, reference: { type: 'string' },
          left: { type: 'number' }, right: { type: 'number' }, referenceLeft: { type: 'number' }, referenceRight: { type: 'number' },
        }, required: ['element', 'reference', 'left', 'right', 'referenceLeft', 'referenceRight'], additionalProperties: false,
      } },
    }, required: ['ac', 'status', 'method', 'evidence'], additionalProperties: false,
  },
}

/**
 * 验收证据的 version 由提交时刻统一盖戳。
 *
 * 工具自己算出内容快照却不回传 id，让 Agent 去别处抄，抄错了只会静默把证据
 * 判成「版本不一致」——一份 12 条全 pass 的报告一夜之间全变未覆盖就是这么来的。
 * 现在：留空即由工具填当前快照 id；Agent 显式写了别的版本则原样保留，
 * 绝不替它补盖当前版本——那会把「对着旧代码测的」改写成「对着新代码测的」，
 * 是伪造证据。写了旧版本就照实记旧版本，账本据此判未覆盖并给出原因。
 */
function stampAcceptanceVersions(records, snapshot) {
  const id = typeof snapshot?.id === 'string' ? snapshot.id : ''
  return (Array.isArray(records) ? records : []).map((entry) => {
    const declared = typeof entry?.version === 'string' ? entry.version.trim() : ''
    return { ...entry, version: declared || id }
  })
}

/** Keep current-version AC evidence when a top-level manual report is reused automatically. */
function reportAcceptance(flow, kind, reports, reused, submitted, snapshot) {
  const records = submitted ?? reports.flatMap((report) => report.acceptance ?? [])
  const present = new Set(records.map((record) => record?.ac))
  const carried = reused.length && submitted === undefined ? flow.carryOver?.[kind + 'Acceptance'] ?? [] : []
  return normalizeAcceptance(flow, stampAcceptanceVersions([...carried.filter((entry) => !present.has(entry.ac)), ...records], snapshot))
}

function normalizeAcceptance(flow, records) {
  const criteria = new Set((flow.scope?.data?.acceptance_criteria ?? []).map((item) => item.id))
  return (Array.isArray(records) ? records : []).slice(0, REPORT_ENTRY_LIMIT * 4).map((entry) => {
    if (!criteria.has(entry?.ac)) throw new Error('验收证据引用了未声明的标准：' + String(entry?.ac))
    const measurements = (Array.isArray(entry?.measurements) ? entry.measurements : []).slice(0, 100).map((item) => ({
      element: clampText(item?.element, 400), reference: clampText(item?.reference, 400),
      left: item?.left, right: item?.right, referenceLeft: item?.referenceLeft, referenceRight: item?.referenceRight,
    }))
    return {
      ac: entry.ac, status: entry.status, method: entry.method, excludeReason: clampText(entry.excludeReason, 400),
      evidence: clampText(entry.evidence, 4000), version: clampText(entry.version, 64), artifact: clampText(entry.artifact, 1000),
      evidenceId: clampText(entry.evidenceId, 64),
      runtime: entry.runtime ? { hostRevision: entry.runtime.hostRevision, clientRevision: entry.runtime.clientRevision, pageId: entry.runtime.pageId, viewport: entry.runtime.viewport } : undefined,
      measurements,
    }
  })
}

function normalizeSubmittedDirections(directions) {
  return (Array.isArray(directions) ? directions : []).slice(0, REPORT_ENTRY_LIMIT).map((direction) => ({
    ...direction,
    id: clampText(direction?.id, 64),
    name: clampText(direction?.name, 120),
    points: (Array.isArray(direction?.points) ? direction.points : []).slice(0, POINT_LIMIT).map((point) => ({
      ...point,
      point: clampText(point?.point, 400),
      detail: clampText(point?.detail, 2000),
      excludeReason: clampText(point?.excludeReason, 400),
    })),
  }))
}

function reviewTool(scoped) {
  return {
    name: 'flowgate_review',
    description: [
      '提交 S3 评审报告，然后挂起等待用户点「通过评审」或「退回开发修复」。',
      '每个启用角度一节；每条发现必须带 file:line 与 severity（CRITICAL/MAJOR/MINOR）。',
      '每条发现还要带 ac：把它挂到冻结 scope 里已声明的验收标准 id 上（如 AC-3）。',
      '对不上任何验收标准的发现、以及落在冻结 scope 文件之外的发现，都会被降级成建议、不进重做清单——照实写，但别把它们当阻塞项。',
      'fast 档位只缩减默认评审角度，不丢弃发现；每角度保存最多 200 条，超过硬上限的已知数量仍单独计数。MINOR 仍计入发现和建议总数。',
      '可用 acceptance 逐条记录 AC 的缺陷或未覆盖；通过评审不能替代实际执行验证。证据的 version 可省略，省略时工具自动填当前内容快照 id。',
      '每个角度先按边界矩阵对被改函数全量枚举，再一次性提交全部发现，不要发现一个报一个。',
      '矩阵至少覆盖：输入形态（带引号引用 / 普通引用 / 未引用）、字符集（ASCII / Unicode）、路径形态（正斜杠 / 反斜杠 / UNC / 盘根 / 相对路径）、长度（空串 / 正好上限 / 上限 + 1 / 超长）与其他边界。',
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
                    ac: {
                      type: 'string',
                      description:
                        '这条发现对应的验收标准 id（冻结 scope 的 acceptance_criteria 里声明过的，如 AC-1）。' +
                        '对不上任何验收标准的发现会被降级成建议、不计入重做清单。',
                    },
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
        acceptance: ACCEPTANCE_SCHEMA,
        reusedAngles: {
          type: 'array',
          items: { type: 'string' },
          description: '上一轮已评审、本轮改动未触及的角度 id：直接复用上次结论，不重新评审。',
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

      const submitted = normalizeSubmittedAngles(flow, args.angles)
      // 部分重跑：上一轮已经评审过、本轮又没碰到相关文件的角度，直接沿用结论。
      const merged = mergeReusedAngles(flow, args.reusedAngles, submitted)
      // 归属判定放在合并之后：复用来的旧结论同样要按当前验收标准重新归类。
      const gated = applyFindingGate(flow, merged.angles)
      const angles = gated.angles
      const blocking = gated.blocking
      const snapshot = currentSnapshot(flow)
      const acceptance = reportAcceptance(flow, 'review', angles, merged.reused, args.acceptance, snapshot)
      flow.review = { id: randomUUID(), angles, blocking, advisories: gated.advisories, counts: gated.counts, snapshot, acceptance, at: nowIso(), reused: merged.reused, fresh: angles.length - merged.reused.length }
      flow.execution = { status: 'completed', text: '手工评审报告已接收；实际执行证据见验收账本。', stage: 'S3', at: nowIso() }
      if (merged.reused.length) dropCarryOver(flow, 'angles', merged.reused)
      appendEvent(cwd, flow, 'review.submitted', { angles: angles.length, blocking, advisories: gated.advisories, reused: merged.reused })
      persist(flow)

      return waitReviewGate(service, flow, sessionId, exec, blocking)
    },
  }
}

/**
 * 未进重做清单的发现条数说明。
 * 被降级的发现不是被丢掉，而是不进重做清单：用户和 Agent 都要知道这个差别。
 */
function advisoryNote(flow) {
  const count = flow.review?.advisories ?? 0
  if (!count) return ''
  return '另有 ' + count + ' 条非阻塞发现（含 MINOR 及范围外建议），仍计入发现总数；AC 是否通过请另看验收账本。'
}

/** S3 出口门禁：等用户点「通过评审」/「退回开发修复」。 */
async function waitReviewGate(service, flow, sessionId, exec, blocking) {
  const outcome = await awaitGate(service, flow, sessionId, 'gate', exec)
  const decision = decisionOf(outcome)
  if (decision === 'wait') {
    return { decision, next: flow.stage, blocking, message: '门禁还在等待用户操作。' }
  }
  if (decision === 'cancelled') {
    return { decision, next: 'cancelled', blocking, message: '用户放弃了这次流程，评审结果作废。' }
  }
  if (decision === 'pass') {
    passGate(flow, 'pass', outcome)
    return {
      decision,
      next: flow.stage,
      blocking,
      message: '评审通过，进入 S4 测试阶段。' + advisoryNote(flow) +
        '现在直接开始 S4 测试，不要在阶段交界处停下等用户再说一句。',
    }
  }
  if (decision === 'accept-risk') {
    passGate(flow, 'accept-risk', outcome)
    return { decision, next: flow.stage, blocking, message: '用户已接受当前评审的阻塞风险，进入 S4 测试；评审未通过。' +
      '现在直接开始 S4 测试，不要在阶段交界处停下等用户再说一句。' }
  }
  if (decision === 'skip') {
    passGate(flow, 'skip', outcome)
    return {
      decision,
      next: flow.stage,
      blocking,
      message: '用户跳过了评审门禁，进入 ' + flow.stage + '。现在直接开始该阶段的工作，不要在阶段交界处停下等用户再说一句。',
    }
  }
  if (decision === 'back') {
    // 回退会清掉 flow.review，建议条数必须在清空之前算好，否则文案里永远是 0 条。
    const note = advisoryNote(flow)
    rollbackTo(flow, outcome.to === 'S1' ? 'S1' : 'S2', 'review-rejected', outcome.note ?? '')
    return {
      decision: 'reject',
      next: flow.stage,
      blocking,
      message: '用户退回到 ' + flow.stage + ' 重做。' + note +
        '请同时处理阻塞发现和验收账本的失败/未覆盖项；严重度与验收状态分别记录。' + remediationNote(flow),
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
      '还须提交 acceptance，逐条说明 AC 的 method、status、evidence；version 可省略，省略时工具自动填当前内容快照 id。没有执行证据不能填 pass。',
      '视觉对齐需真实宿主矩形、实际加载的 hostRevision/clientRevision 和视口；静态 CSS 断言不能代替。桌面接入不可用或未认证时如实记 uncovered，不索要不存在的启动链接。',
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
                    result: { type: 'string', enum: ['pass', 'fail', 'uncovered', 'excluded'] },
                    detail: { type: 'string' },
                    excludeReason: { type: 'string', description: 'result=excluded 时必填：环境限制的具体原因（缺依赖、需要网络或特权、需要特定系统、只读沙箱不允许执行）。' },
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
        acceptance: ACCEPTANCE_SCHEMA,
        reusedDirections: {
          type: 'array',
          items: { type: 'string' },
          description: '上一轮已验证、本轮改动未触及的测试方向 id：直接复用上次结论，不重新测试。',
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

      const submitted = normalizeSubmittedDirections(args.directions)
      const merged = mergeReusedDirections(flow, args.reusedDirections, submitted)
      const directions = merged.directions
      // 环境受限的点必须写明原因：不然「排除」只是把未覆盖换了个名字。
      assertExclusions(directions)
      const failed = directions.reduce(
        (sum, d) => sum + (d.points ?? []).filter((p) => p.result === 'fail').length,
        0,
      )
      const excluded = countExcluded(directions)
      const snapshot = currentSnapshot(flow)
      const acceptance = reportAcceptance(flow, 'test', directions, merged.reused, args.acceptance, snapshot)
      flow.test = { directions, failed, excluded, snapshot, acceptance, at: nowIso(), reused: merged.reused, fresh: directions.length - merged.reused.length }
      flow.execution = { status: 'completed', text: '手工测试报告已接收；实际执行证据见验收账本。', stage: 'S4', at: nowIso() }
      if (merged.reused.length) dropCarryOver(flow, 'directions', merged.reused)
      appendEvent(cwd, flow, 'test.submitted', { directions: directions.length, failed, excluded, reused: merged.reused })
      persist(flow)

      return waitTestGate(service, flow, sessionId, exec, failed)
    },
  }
}

/** S4 出口门禁：等用户点「验收通过」/「退回开发修复」。 */
async function waitTestGate(service, flow, sessionId, exec, failed) {
  const outcome = await awaitGate(service, flow, sessionId, 'gate', exec)
  const decision = decisionOf(outcome)
  if (decision === 'wait') {
    return { decision, next: flow.stage, failed, message: '门禁还在等待用户操作。' }
  }
  if (decision === 'cancelled') {
    return { decision, next: 'cancelled', failed, message: '用户放弃了这次流程，测试结果作废。' }
  }
  if (decision === 'pass') {
    passGate(flow, 'pass', outcome)
    const label = flow.acceptanceDecision?.status === 'accepted-with-gaps' ? '用户已明确接受未通过或未覆盖项，流程以例外结束；这些验收项仍保留原状态。' : '验收通过，流程结束。'
    return { decision, next: 'done', failed, message: label + '完整记录已写入 flows.jsonl。' }
  }
  if (decision === 'skip') {
    // 跳过和通过共用一套校验：缺口必须同样由用户显式接受，
    // 所以这里要把 outcome 一起传下去，否则第二道校验会丢掉 acceptUncovered。
    passGate(flow, 'skip', outcome)
    return { decision, next: 'done', failed, message: '用户跳过验收门禁，流程结束。' }
  }
  if (decision === 'back') {
    rollbackTo(flow, 'S2', 'test-rejected', outcome.note ?? '')
    return { decision: 'reject', next: flow.stage, failed, message: '用户退回到 S2 修复。' + remediationNote(flow) }
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
      '回退后只有完整内容与规则快照一致才复用；任一变化整轮重评。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        reuse: { type: 'boolean', description: '默认 true：自动复用上一轮仍然成立的角度结论。传 false 强制全量重评。' },
      },
      required: [],
      additionalProperties: false,
    },
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
    async execute(args, exec) {
      const { sessionId, cwd } = await sessionOf(scoped, exec)
      const service = SERVICE
      service.hydrate(cwd)
      const flow = service.require(sessionId)
      requireRunning(flow)
      if (flow.stage !== 'S3') {
        throw new Error('评审子代理只在 S3 阶段运行，当前阶段是 ' + flow.stage + '。')
      }
      const angles = resolveAngles(flow, service.workspaceOf(flow.cwd))
      if (!angles.length) throw new Error('当前没有启用的评审角度，先在阶段设置里勾选至少一个。')

      // 只有完整内容与全部规则快照一致，上一轮报告才可复用。
      const snapshot = currentSnapshot(flow)
      const plan = reusePlan(flow, 'angles', angles, args.reuse !== false)
      const fresh = angles.filter((angle) => !plan.reusable.has(angle.id))
      const reports = plan.reports.concat(
        fresh.length ? await collectChildReports(scoped, service, flow, exec, fresh, runAngle) : [],
      )
      // 复用项按当前启用顺序归位，别让旧结论全挤到报告前面。
      const order = new Map(angles.map((angle, index) => [angle.id, index]))
      reports.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
      const gated = applyFindingGate(flow, reports)
      const blocking = gated.blocking
      const acceptance = reportAcceptance(flow, 'review', reports, plan.ids, undefined, snapshot)
      flow.review = { id: randomUUID(), angles: gated.angles, blocking, advisories: gated.advisories, counts: gated.counts, snapshot, acceptance, at: nowIso(), by: 'subagents', reused: plan.ids, fresh: fresh.length }
      if (!fresh.length) flow.execution = { status: 'completed', text: '内容快照相同，沿用既有评审报告；本轮新评审 0 个角度。', stage: 'S3', at: nowIso() }
      if (plan.ids.length) dropCarryOver(flow, 'angles', plan.ids)
      appendEvent(cwd, flow, 'review.submitted', { angles: reports.length, blocking, advisories: gated.advisories, by: 'subagents', reused: plan.ids })
      persist(flow)

      const outcome = await waitReviewGate(service, flow, sessionId, exec, blocking)
      const reuseNote = plan.ids.length
        ? '（复用上一轮结论：' + plan.ids.join(' / ') + '；重新评审 ' + fresh.length + ' 个角度）'
        : ''
      return { ...outcome, angles: reports.length, message: outcome.message + reuseNote }
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
      '回退后只有完整内容与规则快照一致才复用；任一变化整轮重测。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        reuse: { type: 'boolean', description: '默认 true：自动复用上一轮仍然成立的测试结论。传 false 强制全量重测。' },
      },
      required: [],
      additionalProperties: false,
    },
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
    async execute(args, exec) {
      const { sessionId, cwd } = await sessionOf(scoped, exec)
      const service = SERVICE
      service.hydrate(cwd)
      const flow = service.require(sessionId)
      requireRunning(flow)
      if (flow.stage !== 'S4') {
        throw new Error('测试子代理只在 S4 阶段运行，当前阶段是 ' + flow.stage + '。')
      }
      const directions = resolveDirections(flow, service.workspaceOf(flow.cwd))
      if (!directions.length) throw new Error('当前没有启用的测试方向，先在阶段设置里勾选至少一个。')

      const snapshot = currentSnapshot(flow)
      const plan = reusePlan(flow, 'directions', directions, args.reuse !== false)
      const fresh = directions.filter((direction) => !plan.reusable.has(direction.id))
      const results = plan.reports.concat(
        fresh.length ? await collectChildReports(scoped, service, flow, exec, fresh, runDirection) : [],
      )
      const order = new Map(directions.map((direction, index) => [direction.id, index]))
      results.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
      const failed = results.reduce(
        (sum, direction) => sum + direction.points.filter((point) => point.result === 'fail').length,
        0,
      )
      const excluded = results.reduce(
        (sum, direction) => sum + direction.points.filter((point) => point.result === 'excluded').length,
        0,
      )
      const acceptance = reportAcceptance(flow, 'test', results, plan.ids, undefined, snapshot)
      flow.test = { directions: results, failed, excluded, snapshot, acceptance, at: nowIso(), by: 'subagents', reused: plan.ids, fresh: fresh.length }
      if (!fresh.length) flow.execution = { status: 'completed', text: '内容快照相同，沿用既有测试报告；本轮新测 0 个方向。', stage: 'S4', at: nowIso() }
      if (plan.ids.length) dropCarryOver(flow, 'directions', plan.ids)
      appendEvent(cwd, flow, 'test.submitted', { directions: results.length, failed, excluded, by: 'subagents', reused: plan.ids })
      persist(flow)

      const outcome = await waitTestGate(service, flow, sessionId, exec, failed)
      const reuseNote = plan.ids.length
        ? '（复用上一轮结论：' + plan.ids.join(' / ') + '；重新测试 ' + fresh.length + ' 个方向）'
        : ''
      return { ...outcome, directions: results.length, message: outcome.message + reuseNote }
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
    // 别在这里写死宿主版本号：插件声明的是版本范围，报错只说缺了什么接口。
    const missing = ['startActivation', 'getProvider'].filter((key) => typeof subagents[key] !== 'function')
    return { available: false, reason: '宿主 subagents 接口不匹配，缺少 ' + missing.join(' / ') + '；可以升级 DSH，或改用 flowgate_review / flowgate_test 由主会话自行组织。' }
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
  flow.execution = { status: 'running', stage, startedAt: nowIso(), text: '只读子代理仍在执行，等待 ' + items.length + ' 份最终报告。' }
  persist(flow)
  exec.signal?.addEventListener('abort', abort, { once: true })
  try {
    const reports = []
    assertCurrent()
    for (const item of items) {
      assertCurrent()
      reports.push(await run(scoped, service, flow, exec.agent, controller.signal, item))
      assertCurrent()
    }
    const failed = reports.filter((report) => report.executionError).length
    flow.execution = { ...flow.execution, status: failed ? 'failed' : 'completed', at: nowIso(), text: failed ? failed + ' 个子代理没有正常产出报告，相关验证仍未覆盖。' : items.length + ' 份子代理最终报告已收到；验收是否通过见逐条账本。' }
    persist(flow)
    return reports
  } catch (error) {
    // 迟到任务不得覆盖用户已退回/放弃后的新阶段状态。
    if (service.get(flow.sessionId) === flow && flow.stage === stage && flow.stages[stage] === record && !flow.finished) {
      flow.execution = { ...flow.execution, status: controller.signal.aborted ? 'cancelled' : 'failed', at: nowIso(), text: error?.message ?? String(error) }
      persist(flow)
    }
    throw error
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
    readAttempts: new Set(),
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
    const result = await Promise.race([activation.result, cancelled])
    return { ...result, readAttempts: [...policy.readAttempts] }
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

/** S3 评审的边界分支矩阵：每个角度都要对被改函数逐格判定，一次报全。 */
const BOUNDARY_ENUMERATION = [
  '全量枚举协议（先枚举再一次性报全，不要发现一个报一个）：',
  '1. 从「本阶段的代码变更摘要」列出被改函数（文件 + 函数名或导出符号）。摘要只有文件、没有改动行时，把该文件的每个导出函数都算作被改函数，不得跳过。',
  '2. 对每个被改函数，按下面的矩阵逐项判定，每个维度都不能留空：',
  '   - 输入形态：带引号引用（如 @"..."）、普通引用（作为引用参数但未加引号）、未引用（裸值 / 裸文本）；',
  '   - 字符集：ASCII、Unicode（CJK、全角标点、emoji、组合字符）；',
  '   - 路径形态：正斜杠 /、反斜杠 \\、UNC（\\\\server\\share）、盘根（C:\\ 与 C:/）、相对路径、混合分隔符；',
  '   - 长度：空串、单字符、典型值、正好上限、上限 + 1、远超上限；',
  '   - 其他边界：null / undefined、纯空白、尾随分隔符、. 与 ..、大小写差异。',
  '   按维度枚举分支；只有分支之间确实存在交互（例如「未引用 + Unicode + UNC」走不同代码路径）时才组合，不要为凑组合重复报同一处问题。',
  '3. 每项标 covered（有实现且有测试证据）/ missing（无处理、会抛错或行为未定义）/ n/a（该函数不处理这一类），并给出 file:line。',
  '4. 输出前自检：枚举总数 = covered + missing + n/a；有未判定的分支就先补判，再输出。',
  '5. 把全部 missing 一次性写进 findings，一条一个分支，按「函数 → 矩阵顺序」排列；不得合并、不得省略、不得按严重度分批。',
  '6. summary 以「[函数名 · 分支标签]」开头，例如「[resolvePath · 未引用·Unicode·UNC] 未做归一化」。',
]

function acceptancePrompt(flow) {
  const snapshot = currentSnapshot(flow)
  return [
    '当前内容版本（仅对该版本的实际检查有效）：' + snapshot.id + '；完整：' + snapshot.complete + '。',
    '逐条 AC 的 verification.method/procedure 是取证要求；评审通过、通过总数、任务 ID、CSS 字符串都不是实际执行证据。',
    'JSON 可附 acceptance:[{ac,status:"pass|fail|uncovered",method:"unit|integration|visual|manual",evidence,version,artifact,runtime,measurements}]。version 必须是你实际检查的上述内容版本，不要凭当前版本补盖章。',
    '只输出本方向涉及的 AC；不知道或无实际执行证据就标 uncovered 并说明限制，不得伪造命令、测量或截图。',
    '视觉宽度/对齐必须测真实宿主中的目标及任务/目标参照元素的 getBoundingClientRect()；每条 measurements 含 element/reference/left/right/referenceLeft/referenceRight，默认容差 1px。',
    '视觉证据还必须含实际已核对的 runtime:{hostRevision,clientRevision,pageId,viewport:{width,height}}；布局验收必须引用真实 inspectLayout 返回的 evidenceId，不能手填相等矩形冒充采集。构建标签、旧截图和独立预览均不足以证明实际页面生效。',
    '无受支持的桌面接入、现有认证页或真实 DOM 时记录 uncovered；401 只说明验证环境未认证，不代表功能失败，不索要不存在的 dsh web 启动链接，不另启替代服务。',
    '只读工具或环境限制导致无法执行验证时，如实记录限制，不把静态阅读当作已执行测试。',
  ].join('\n')
}

function reviewTargets(flow) {
  const files = flow.scope.data?.in_scope?.files_expected_to_change ?? []
  return [...new Set(files.map((file) => normalizeTarget(flow.cwd, file)))]
}

function matchingReadEvidence(flow, file, proof) {
  if (!proof || normalizeTarget(flow.cwd, proof.file) !== file) return false
  try {
    const lines = readFileSync(resolve(flow.cwd, file), 'utf8').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    return proof.firstLine === (lines[0] ?? '').slice(0, 160) &&
      proof.lastLine === (lines.at(-1) ?? '').slice(0, 160)
  } catch {
    return false
  }
}

function anglePrompt(flow, angle, workspace) {
  const scope = flow.scope.data ?? {}
  const cap = FINDINGS_LIMIT
  const rules = RULE_CHECKING_ANGLES.has(angle.id) ? resolveRules(flow, workspace) : []
  return [
    '你是只读评审子代理，评审角度：' + angle.name + '。',
    '只允许读取工具；shell 仅允许 pwd。Git、写操作、未知工具、脚本和解释器默认拒绝。',
    '读取文件优先直接使用默认可用的 read({"file_path":"文件路径"})；使用 run_code 时仅写 return await tools.read({"file_path":"文件路径"})，参数须为严格 JSON。',
    'ops_* 系列工具默认没有加载，直接调用会报 not a function；确实需要时先调 ops_load_sdk({"tools":["read_files"]})，下一轮才能用。',
    '',
    '检查要点：',
    ...(angle.points ?? []).map((point) => '- ' + point),
    ...(rules.length
      ? ['', '用户定义的开发规则（逐条核对，未遵守的写进 findings）：', ...rules.map((rule) => '- ' + rule.name + '：' + (rule.points ?? []).join('；'))]
      : []),
    '',
    ...BOUNDARY_ENUMERATION,
    '',
    '冻结 scope（开发只允许碰这些文件）：',
    JSON.stringify(scope.in_scope ?? {}, null, 2),
    '显式排除项：' + JSON.stringify(scope.out_of_scope_explicitly ?? []),
    '验收标准：' + JSON.stringify(scope.acceptance_criteria ?? []),
    acceptancePrompt(flow),
    '',
    'in_scope.shared_contracts 就是本次允许触及的影响面：为实现需求要动的共用契约与已知约束。',
    '发现必须能挂到上面某条验收标准（把它的 id 填进 ac），并且落在 in_scope 文件内，才算本次要修的缺陷。',
    '对不上验收标准、或落在 scope 文件之外的观察，severity 照实写，但会被降级成建议、不进重做清单。',
    '',
    '本阶段的代码变更摘要：' + JSON.stringify(flow.devChanges ?? null),
    '必须逐一读取的目标文件：' + JSON.stringify(reviewTargets(flow)),
    'checkedFiles 只列实际成功读取且检查过的目标文件；读取失败或遗漏目标文件时不能声称完成评审。',
    '每个目标文件还须给出 readEvidence：完整读取后，取首尾非空行，去掉两端空白并各截取前 160 字符，填入 firstLine/lastLine；没有非空行时首尾均填空字符串；读取失败时不得猜测内容。',
    '',
    '只输出一个 JSON 对象，不要额外文字：',
    '{"verdict":"pass|blocking|advisory","suggestUpgrade":false,"checkedFiles":["已检查的相对路径"],',
    ' "readEvidence":[{"file":"已检查的相对路径","firstLine":"首个非空行","lastLine":"最后非空行"}],',
    ' "findings":[{"file":"相对路径","line":12,"severity":"CRITICAL|MAJOR|MINOR","ac":"AC-1","summary":"[函数 · 分支] 一句话"}]}',
    'verdict：有 CRITICAL/MAJOR 用 blocking，只有 MINOR 用 advisory，都没有用 pass；目标文件未检查时不得用 pass。',
    'findings 先按边界矩阵全量枚举，最多输出 ' + cap + ' 条；fast 只缩减角度数量，不允许按前三条隐藏其余发现。',
    'suggestUpgrade 只在发现 scope 内存在架构性问题时填 true。',
  ].join('\n')
}

function directionPrompt(flow, direction, allowShellWrite = false) {
  return [
    '你是只读测试子代理，测试方向：' + direction.name + '。',
    allowShellWrite
      ? '用户已在 S4 设置面板为这个方向显式授权写权限：可以执行变更性命令（如迁移后回滚），但 write / edit / str_replace_editor 仍被宿主端拒绝——代码本身不能改。'
      : '只允许读取工具；shell 仅允许 pwd。Git 和测试脚本不能推定只读，未授权时应说明未覆盖，不能尝试运行。',
    '读取文件优先直接使用默认可用的 read({"file_path":"文件路径"})；使用 run_code 时仅写 return await tools.read({"file_path":"文件路径"})，参数须为严格 JSON。',
    'ops_* 系列工具默认没有加载，直接调用会报 not a function；确实需要时先调 ops_load_sdk({"tools":["read_files"]})，下一轮才能用。',
    '',
    '验证要点：',
    ...(direction.points ?? []).map((point) => '- ' + point),
    '',
    '验收标准：' + JSON.stringify(flow.scope.data?.acceptance_criteria ?? []),
    acceptancePrompt(flow),
    '',
    '',
    '结果口径（四选一，不能混用）：',
    '- pass：已验证通过，detail 写证据；',
    '- fail：验证失败，detail 写实际行为与期望的差异；',
    '- uncovered：本轮没能验证（时间不够、没跑到这一步），detail 说明缺了什么；',
    '- excluded：当前环境根本测不了（缺依赖或工具链、需要网络或特权、需要特定操作系统、只读沙箱不允许执行），',
    '  必须用 excludeReason 写明具体限制。不许把环境受限的点留在 uncovered——',
    '  uncovered 是「该测没测」，excluded 是「这个环境测不了」，验收时要分开看。',
    '',
    '只输出一个 JSON 对象，不要额外文字：',
    '{"points":[{"point":"验证要点原文","result":"pass|fail|uncovered|excluded","detail":"一句话证据","excludeReason":"result=excluded 时必填"}]}',
  ].join('\n')
}

/** 跑一个评审角度；读取或执行失败时标未覆盖，禁止评审门禁通过。 */
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
    if (report.coverage === 'uncovered' || report.executionError) {
      throw new Error('子代理报告目标文件未检查或读取失败：' + (report.executionError ?? '未覆盖'))
    }
    const targets = reviewTargets(flow)
    const checked = Array.isArray(report.checkedFiles)
      ? new Set(report.checkedFiles.filter((file) => typeof file === 'string').map((file) => normalizeTarget(flow.cwd, file)))
      : new Set()
    const attempted = new Set(result.readAttempts ?? [])
    const missing = targets.filter((file) => {
      const proofs = Array.isArray(report.readEvidence)
        ? report.readEvidence.filter((proof) => typeof proof?.file === 'string' && normalizeTarget(flow.cwd, proof.file) === file)
        : []
      return !checked.has(file) || !attempted.has(file) || proofs.length !== 1 ||
        !matchingReadEvidence(flow, file, proofs[0])
    })
    if (!targets.length || missing.length) {
      throw new Error('目标文件未完成读取或缺少有效内容证据：' + (missing.length ? missing.join('、') : '无可核对目标'))
    }
    const normalized = normalizeSubmittedAngles(flow, [{ ...report, id: angle.id, name: angle.name }])[0]
    const findings = normalized.findings
    const verdict = findings.some((item) => item.severity !== 'MINOR') ? 'blocking'
      : findings.length ? 'advisory' : report.verdict
    return {
      id: angle.id,
      name: angle.name,
      verdict,
      suggestUpgrade: report.suggestUpgrade === true,
      findings, omittedCounts: normalized.omittedCounts,
      acceptance: normalizeAcceptance(flow, report.acceptance),
    }
  } catch (error) {
    rethrowChildCancellation(signal, error)
    return {
      id: angle.id,
      name: angle.name,
      verdict: 'advisory',
      suggestUpgrade: false, coverage: 'uncovered', executionError: error?.message ?? String(error),
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
      if (matches.length !== 1 || !['pass', 'fail', 'uncovered', 'excluded'].includes(item?.result)) {
        return { ...expected, detail: '子代理未返回该验证要点的唯一有效结果。' }
      }
      // 只报 excluded 不给理由的，按未覆盖处理：不然「排除」就成了绕过验收的后门。
      if (item.result === 'excluded' && (typeof item.excludeReason !== 'string' || !item.excludeReason.trim())) {
        return { ...expected, detail: '子代理把该要点标为环境受限，但没有写明限制原因，按未覆盖处理。' }
      }
      return {
        point: expected.point,
        result: item.result,
        detail: typeof item.detail === 'string' ? item.detail : undefined,
        excludeReason: item.result === 'excluded' ? item.excludeReason.trim() : undefined,
      }
    })
    return { id: direction.id, name: direction.name, points: resolved, acceptance: normalizeAcceptance(flow, report.acceptance) }
  } catch (error) {
    rethrowChildCancellation(signal, error)
    return {
      id: direction.id,
      name: direction.name, executionError: error?.message ?? String(error),
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

/** 取这次调用所在会话的工作目录；用于把未登记的子代理按项目归到运行中的流程。 */
function cwdOfExec(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
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

/** 只借用已有工作区会话的模型选择，不能为整理草稿创建/恢复会话。 */
function sessionIdForWorkspace(service, path) {
  try {
    const ctx = service.ctx
    const sessions = ctx?.sessions ?? ctx?.get?.('sessions')
    const agents = ctx?.agents ?? ctx?.get?.('agents')
    const candidates = []
    for (const flow of service.flows.values()) {
      if (!flow.finished && typeof flow.cwd === 'string' && resolve(flow.cwd) === path) candidates.push(flow.sessionId)
    }
    const live = typeof sessions?.list === 'function' ? sessions.list() : []
    for (const session of Array.isArray(live) ? live.slice().reverse() : []) {
      if (typeof session?.header?.cwd !== 'string' || resolve(session.header.cwd) !== path || session.header.delegationDepth > 0) continue
      const id = session.header.id
      if (typeof id === 'string' && service.ownerOf(id) === id && !candidates.includes(id)) candidates.push(id)
    }
    for (const id of candidates) {
      try {
        const selected = agents?.get?.(id)?.model?.current?.()
        if (selected?.provider && selected?.model) return id
      } catch { /* 会话可能正在释放，继续检查其他已有会话。 */ }
    }
    return candidates[0]
  } catch {
    return undefined
  }
}

/**
 * 界面启动后投递给 Agent 的那条消息：把档位与需求原文交代清楚，并指定下一步动作。
 */
function wakeMessage(flow, workspace) {
  const label = PRESETS[flow.preset]?.label ?? flow.preset
  const lines = ['【流程工作台】已启动一次四阶段流程（档位：' + label + '），当前阶段 S1 需求分析。']
  if (flow.brief) {
    lines.push('需求原文：', flow.brief)
    lines.push(
      '',
      '请接着做 S1：先调用 flowgate_status 确认状态，再用 flowgate_ask 一次只问一个关键决策问题；需求原文里已经写清楚的内容不要重复问。问完后用 flowgate_doc 提交需求文档与 scope。',
      '需求分析以「需求原文」为唯一依据：流程标题只是界面显示用的短名，不替代原文，也不得据它增删目标、约束或验收标准；两者不一致时一律以原文为准。',
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
  const analysis = stageConfig(flow, 'S1', workspace)
  lines.push('需求分析规则（来源：' + RULE_SOURCE_LABEL[analysis.source] + '）：')
  for (const rule of analysis.items) lines.push('- ' + rule.name + '：' + rule.points.join('；'))
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
  const record = deliverToAgent(service, flow, wakeMessage(flow, service.workspaceOf(flow.cwd)))
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
    '先调用 flowgate_status 读取当前有效规则、ID 与要点。现在直接开始 ' + flow.stage + ' 的工作，不要在阶段交界处停下等用户再说一句。' +
    // 这条消息只是状态通知：决策已经落进流程状态，Agent 再执行一次阶段切换就会把刚重做的产物清掉。
    '\n这是状态通知，不是要求你再切一次阶段：决策已经落地，不要再次回退，也不要重新提交上一个门禁的产物。'
  )
}

/** 决策已落地但没有等待器接着跑时，补一条消息把 Agent 叫醒；记录留下来给界面降级提示。 */
function wakeAfterGate(service, flow, lead) {
  return deliverToAgent(service, flow, gateWakeText(flow, lead) + (flow.remediation ? '\n' + remediationNote(flow) : ''))
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
    const note = typeof flow.doc?.revisionNote === 'string' ? flow.doc.revisionNote.trim() : ''
    return (
      head + '用户要求修改需求文档，scope 尚未冻结。\n' +
      (note ? '修改意见原文：\n' + note + '\n' : '用户这次没有填写修改意见：先问清要改什么，不要自己猜。\n') +
      '进入 ' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）：' +
      '按上面的意见改完后重新提交 flowgate_doc，不要在阶段交界处停下等用户再说一句。'
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
      throw new Error('该工作区已有流程在进行，请先结束或放弃它，再启动新流程。')
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
  if (action === 'layout-evidence') {
    requireRunning(flow)
    const runtime = runtimeOf(flow)
    const snapshot = currentSnapshot(flow)
    if (!snapshot.complete || payload?.version !== snapshot.id || runtime.status !== 'verified'
      || payload?.pageId !== runtime.pageId || payload?.clientRevision !== runtime.clientRevision
      || payload?.viewport?.width !== runtime.viewport?.width || payload?.viewport?.height !== runtime.viewport?.height) {
      throw new Error('真实页面实例、版本或视口未核对，不能登记布局证据。')
    }
    const measurements = payload.measurements
    if (!Array.isArray(measurements) || !measurements.length || measurements.length > 100
      || measurements.some((m) => !m || typeof m.element !== 'string' || !m.element.trim() || m.element.length > 400
        || typeof m.reference !== 'string' || !m.reference.trim() || m.reference.length > 400
        || !['left', 'right', 'referenceLeft', 'referenceRight'].every((key) => Number.isFinite(m[key]))
        || m.right <= m.left || m.referenceRight <= m.referenceLeft)) throw new Error('布局证据缺少实际有效的具名边界测量。')
    const receipt = { id: randomUUID(), version: snapshot.id, pageId: runtime.pageId,
      hostRevision: runtime.hostRevision, clientRevision: runtime.clientRevision,
      viewport: { ...runtime.viewport }, measurements: measurements.map(({ element, reference, left, right, referenceLeft, referenceRight }) => ({ element, reference, left, right, referenceLeft, referenceRight })), at: nowIso() }
    flow.layoutEvidence = [...(flow.layoutEvidence ?? []).slice(-19), receipt]
    persist(flow)
    return { layoutEvidence: receipt }
  }

  const gates = service.gates
  const workspace = service.workspaceOf(flow.cwd)
  flow.overrides = flow.overrides ?? {}

  switch (action) {
    case 'answer': {
      const choiceIndex = Number(payload?.choiceIndex)
      const customText = typeof payload?.customText === 'string' ? payload.customText : ''
      // -1 表示「自定义」：宿主记录里 choice 为空，custom 承载用户输入。
      if (!Number.isInteger(choiceIndex) || choiceIndex < -1) throw new Error('choiceIndex 非法')
      if (choiceIndex === -1 && !customText.trim()) throw new Error('自定义内容不能为空')
      // 自定义回答会写进追问记录并随快照全量落盘：留个上限，别让一次粘贴把流程文件撑大。
      if (customText.length > 2000) throw new Error('自定义内容不能超过 2000 字符（当前 ' + customText.length + '）。')
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
      // 验收方案缺口必须显式接受并写明原因：只带 acceptScopeRisks 不带原因仍然拒绝。
      const result = decideDoc(service, flow, sessionId, decision, {
        acceptScopeRisks: payload?.acceptScopeRisks === true,
        scopeRiskNote: clampText(payload?.scopeRiskNote, 2000),
        revisionNote: clampText(payload?.revisionNote, REVISION_NOTE_LIMIT),
      })
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
      if (!['pass', 'skip', 'back', 'accept-risk'].includes(decision)) throw new Error('decision 必须是 pass / skip / back / accept-risk')
      // 决策直接落流程状态：等待器可能已被中断或重启清掉，界面仍然要能确认。
      const gateOutcome = decideGate(service, flow, sessionId, decision, payload?.to, {
        acceptUncovered: payload?.acceptUncovered === true,
        acceptanceNote: clampText(payload?.acceptanceNote, 2000),
        note: clampText(payload?.note, 2000),
        riskReason: payload?.riskReason,
        reviewId: payload?.reviewId,
      })
      // 没有等待器接手时补一条消息：否则阶段推进了，Agent 却还停在上一个阶段。
      if (!gateOutcome.delivered && !gateOutcome.repeated) {
        // 两个阶段分开命名：passedStage 是被点掉的那个门禁，nextStage 是接下来要做的阶段。
        const passedStage = gateOutcome.stage
        const nextStage = flow.stage
        const lead =
          decision === 'back'
            ? '退回已经生效，当前在 ' + nextStage + '（' + STAGE_LABEL[nextStage] + '）重做。'
            : decision === 'accept-risk' ? '用户显式接受了 ' + passedStage + ' 的评审阻塞风险。'
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
      flow.overrides = { analysisRules: flow.overrides?.analysisRules ?? null, angles: null, directions: null, rules: flow.overrides?.rules ?? null }
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
      flow.overrides = { analysisRules: flow.overrides?.analysisRules ?? null, angles: null, directions: null, rules: flow.overrides?.rules ?? null }
      appendEvent(flow.cwd, flow, 'preset.upgraded', { from, to: target, stage: flow.stage })
      // 升档意味着用户要求更严格：进重做清单的阻塞项、或落在 scope 之外的发现，都算「确实有问题」。
      // scope 外的发现不进 S2 的重做清单（重做也改不到），但它是范围没划够的信号，所以要回 S1 调 scope。
      const foundProblems = flow.review && (flow.review.blocking > 0 || reviewFindingsOutsideScope(flow).length > 0)
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
    case 'followStageDefaults': {
      const stage = payload?.stage
      if (!STAGES.includes(stage)) throw new Error('未知阶段')
      flow.overrides[STAGE_KEYS[stage]] = null
      if (stage === 'S4') service.reconcileWriteGrants(flow, workspace)
      appendEvent(flow.cwd, flow, 'stage.defaults.followed', { stage })
      persist(flow)
      break
    }
    case 'toggleAnalysisRule': {
      const id = payload?.id
      const config = stageConfig(flow, 'S1', workspace)
      if (!config.catalog.some((rule) => rule.id === id)) throw new Error('未知的需求分析规则：' + id)
      const set = new Set(config.ids)
      if (payload?.enabled !== false) set.add(id)
      else set.delete(id)
      flow.overrides.analysisRules = Array.from(set)
      appendEvent(flow.cwd, flow, 'analysis.rules.changed', { id, enabled: payload?.enabled !== false })
      persist(flow)
      break
    }
    case 'addAnalysisRule': {
      const name = String(payload?.name ?? '').trim()
      if (!name) throw new Error('名称不能为空')
      const points = Array.isArray(payload?.points)
        ? payload.points.map((point) => String(point).trim()).filter(Boolean)
        : String(payload?.points ?? '').split('\n').map((point) => point.trim()).filter(Boolean)
      const item = { id: 'analysis_' + randomUUID().slice(0, 8), name, points }
      const ids = stageConfig(flow, 'S1', workspace).ids
      flow.customAnalysisRules = (flow.customAnalysisRules ?? []).concat(item)
      flow.overrides.analysisRules = ids.concat(item.id)
      appendEvent(flow.cwd, flow, 'analysis.rule.added', { name })
      persist(flow)
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
      service.setWorkspaceRules(flow.cwd, { ids, custom, edits: workspaceStage(workspace, 'S2')?.edits ?? [] })
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
      const config = stageConfig(flow, isAngle ? 'S3' : 'S4', workspace)
      if (!config.catalog.some((entry) => entry.id === id)) throw new Error('未知阶段条目：' + id)
      const current = config.ids
      const set = new Set(current)
      if (enabled) set.add(id)
      else set.delete(id)
      flow.overrides[key] = Array.from(set)
      if (!isAngle) service.reconcileWriteGrants(flow, workspace)
      appendEvent(flow.cwd, flow, isAngle ? 'angles.changed' : 'directions.changed', { id, enabled })
      persist(flow)
      break
    }
    case 'setGateMode': {
      // 流程级开关，任何阶段都能切：人往往是被门禁卡住的那一刻才想起来要切。
      const mode = payload?.mode === 'auto' ? 'auto' : payload?.mode === 'manual' ? 'manual' : null
      if (!mode) throw new Error('门禁模式只能是 auto（没有阻塞项就自动通过）或 manual（每一步都等确认）。')
      if (flow.gateMode === mode) break
      flow.gateMode = mode
      appendEvent(flow.cwd, flow, 'gate.mode.changed', { mode, stage: flow.stage })
      persist(flow)
      // 正挂在门禁上时立刻重判：切到 auto 就该当场放行，切到 manual 就继续等。
      // 没挂起时 notify 返回 false，不改任何状态。
      if (!service.gates.notify(sessionId, { kind: 'mode-changed' }, 'gate')) {
        service.gates.notify(sessionId, { kind: 'mode-changed' }, 'doc')
      }
      break
    }
    case 'toggleShellGrant': {
      // 开发阶段的「允许执行构建/测试命令」：默认关闭，用户显式勾选才放行变更性 shell。
      if (flow.stage !== 'S2' && flow.stage !== 'S4') throw new Error('命令授权只在 S2 开发 / S4 测试阶段开放，当前阶段是 ' + flow.stage + '。')
      if (!flow.scope?.frozen) throw new Error('scope 尚未冻结，不能授权执行命令。')
      const enabled = payload?.enabled !== false
      flow.shellGrant = enabled
      appendEvent(flow.cwd, flow, enabled ? 'shell.granted' : 'shell.revoked', {})
      persist(flow)
      break
    }
    case 'setToolAllowlist': {
      // 只读豁免：整份覆盖，便于界面上一次编辑多行。规范化在 normalizeToolAllowlist 里，
      // 写工具 / shell / 权限开关会在那里被拒。
      const next = normalizeToolAllowlist(payload?.tools)
      const previous = flow.toolAllowlist ?? []
      flow.toolAllowlist = next
      const added = next.filter((name) => !previous.includes(name))
      const removed = previous.filter((name) => !next.includes(name))
      if (added.length || removed.length) {
        appendEvent(flow.cwd, flow, 'tools.allowlist', { added, removed })
        persist(flow)
      }
      break
    }
    case 'declareDirectionWrite': {
      // 声明「这个方向需要写权限」：内置方向没有 needsWrite 字段，靠这里补。
      // 声明是配置，任何阶段都能改；授权（writeGrants）仍然只在 S4 生效。
      const id = payload?.id
      if (typeof id !== 'string' || !id) throw new Error('测试方向 id 不能为空')
      const enabled = payload?.enabled !== false
      const direction = directionCatalog(flow, workspace).find((item) => item.id === id)
      if (!direction) throw new Error('未知的测试方向：' + id)
      if (direction.needsWrite === true && enabled) {
        // 已经声明过（自定义方向自带该字段）就不重复写，避免声明列表里堆冗余 id。
        break
      }
      const set = new Set(flow.directionWriteDeclared ?? [])
      if (enabled) set.add(id)
      else set.delete(id)
      flow.directionWriteDeclared = Array.from(set)
      appendEvent(flow.cwd, flow, enabled ? 'write.declared' : 'write.undeclared', { id, name: direction.name })
      // 撤销声明必须连带撤销已有授权，否则授权会挂在一个「不需要写权限」的方向上。
      if (!enabled) service.reconcileWriteGrants(flow, workspace)
      persist(flow)
      break
    }
    case 'toggleWriteGrant': {
      // D2：授予只在 S4 对当前启用且声明 needsWrite 的方向开放；撤销不受这些前置条件限制。
      const id = payload?.id
      if (typeof id !== 'string' || !id) throw new Error('测试方向 id 不能为空')
      const enabled = payload?.enabled !== false
      const direction = directionCatalog(flow, workspace).find((item) => item.id === id)
      if (enabled) {
        if (flow.stage !== 'S4') throw new Error('写权限例外只在 S4 测试阶段开放，当前阶段是 ' + flow.stage + '。')
        if (!direction) throw new Error('未知的测试方向：' + id)
        if (!activeDirections(flow, workspace).includes(id)) throw new Error('该测试方向当前未启用，不允许授予。')
        if (direction.needsWrite !== true) throw new Error('该测试方向没有声明需要写权限，不允许授予。')
      }
      const set = new Set(flow.writeGrants ?? [])
      if (enabled) set.add(id)
      else set.delete(id)
      flow.writeGrants = Array.from(set)
      appendEvent(flow.cwd, flow, enabled ? 'write.granted' : 'write.revoked', { id, name: direction?.name ?? id })
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
        flow.customAngles = (flow.customAngles ?? []).concat(item)
        const set = new Set(activeAngles(flow, workspace))
        set.add(item.id)
        flow.overrides.angles = Array.from(set)
      } else {
        flow.customDirections = (flow.customDirections ?? []).concat(item)
        const set = new Set(activeDirections(flow, workspace))
        set.add(item.id)
        flow.overrides.directions = Array.from(set)
      }
      appendEvent(flow.cwd, flow, isAngle ? 'angle.added' : 'direction.added', { name })
      persist(flow)
      break
    }
    case 'note': {
      // 备注会随快照全量落盘：留个上限，别让一次粘贴把流程文件撑大。
      flow.gateNote = String(payload?.text ?? '').slice(0, 2000)
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
    // 清单里也要能分辨「全部通过」和「带缺口结束」：
    // 只给 finished 一个布尔值，两种收尾在列表里长得一模一样。
    closure: flow.closure ?? null,
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
  const stages = Object.fromEntries(STAGES.map((stage) => {
    const saved = workspaceStage(config, stage)
    const effective = stageConfig({ preset: 'fast' }, stage, config)
    return [stage, {
      label: STAGE_LABEL[stage], configured: Boolean(saved), selection: saved?.ids ?? null,
      ids: effective.ids,
      defaults: { fast: stageDefaultIds(stage, 'fast'), strict: stageDefaultIds(stage, 'strict') },
      builtin: builtinStageItems(stage), custom: saved?.custom ?? [], edits: saved?.edits ?? [], catalog: effective.catalog,
    }]
  }))
  const rules = stages.S2
  return { configured: rules.configured, ids: rules.ids, custom: rules.custom, customCount: rules.custom.length, catalog: rules.catalog, stages }
}

/** 写接口严格校验；自定义条目与内置编辑分开，原始内置定义保持不变。 */
function validateHubStage(value, stage) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.ids !== null && !Array.isArray(value.ids)) || !Array.isArray(value.custom) || !Array.isArray(value.edits)) {
    throw new Error(stage + ' 必须是 { ids: null|string[], custom: Entry[], edits: Entry[] } 或 null')
  }
  const builtin = new Set(builtinStageItems(stage).map((entry) => entry.id))
  const known = new Set(builtin)
  const entryOf = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id.trim() ||
        typeof item.name !== 'string' || !item.name.trim() || !Array.isArray(item.points) ||
        item.points.some((point) => typeof point !== 'string') ||
        (item.needsWrite !== undefined && typeof item.needsWrite !== 'boolean')) {
      throw new Error(stage + ' 条目需要非空 id、名称及字符串数组 points')
    }
    return normalizeRuleEntry(item, stage)
  }
  const custom = value.custom.map((item) => {
    const entry = entryOf(item)
    if (known.has(entry.id)) throw new Error('自定义条目 id 重复或与内置条目冲突：' + entry.id)
    known.add(entry.id)
    return entry
  })
  const edited = new Set()
  const edits = value.edits.map((item) => {
    const entry = entryOf(item)
    if (!builtin.has(entry.id)) throw new Error('只能编辑同阶段的内置条目：' + entry.id)
    if (edited.has(entry.id)) throw new Error('内置编辑 id 重复：' + entry.id)
    edited.add(entry.id)
    return entry
  })
  const selected = new Set()
  const ids = value.ids === null ? null : value.ids.map((raw) => {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error(stage + '.ids 只能包含非空字符串')
    const id = raw.trim()
    if (selected.has(id)) throw new Error('启用条目 id 重复：' + id)
    if (!known.has(id)) throw new Error('未知条目 id：' + id)
    selected.add(id)
    return id
  })
  return { ids, custom, edits }
}

function validateHubStages(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== STAGES.length || STAGES.some((stage) => !Object.prototype.hasOwnProperty.call(value, stage))) {
    throw new Error('stages 必须包含 S1、S2、S3、S4 四个阶段，整体保存')
  }
  return Object.fromEntries(STAGES.map((stage) => [stage, validateHubStage(value[stage], stage)]))
}

function validateHubRules(value) {
  if (value === null) return null
  if (!value || !Array.isArray(value.ids)) throw new Error('rules.ids 必须是字符串数组')
  return validateHubStage({ ...value, edits: value.edits ?? [] }, 'S2')
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
      const clientRevision = url.searchParams.get('clientRevision')
      const pageId = url.searchParams.get('pageId')
      const width = Number(url.searchParams.get('viewportWidth')), height = Number(url.searchParams.get('viewportHeight'))
      if (clientRevision && /^[a-f0-9]{64}$/.test(clientRevision) && /^[a-f0-9-]{36}$/i.test(pageId ?? '') && Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
        service.runtimeClients.set(sessionId, { clientRevision, pageId, viewport: { width, height }, reportedAt: Date.now() })
      } else service.runtimeClients.delete(sessionId)
      const workspace = service.workspaceHint(sessionId)
      return json(200, { ...service.view(sessionId), workspace })
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
      const currentFlow = hubCurrentFlow(service, path, flows.find((flow) => !flow.finished && !flow.cancelled))
      return json(200, { flows: flows.slice((page - 1) * pageSize, page * pageSize), currentFlow, total, page, pageSize, totalPages })
    } catch (error) {
      return json(500, { error: error?.message ?? String(error) })
    }
  })

  // stages 整体校验后原子保存；旧 rules 负载只修改 S2。
  register(API_BASE + '/hub/rules', ['POST'], async (request) => {
    let body, path, rules, stages, writing, writingStages
    try {
      body = await request.json()
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是对象')
      path = requireHubPath(body.path)
      writing = Object.prototype.hasOwnProperty.call(body, 'rules')
      writingStages = Object.prototype.hasOwnProperty.call(body, 'stages')
      if (writing && writingStages) throw new Error('rules 与 stages 不能同时保存')
      if (writing) rules = validateHubRules(body.rules)
      if (writingStages) stages = validateHubStages(body.stages)
    } catch (error) {
      return json(400, { error: error?.message ?? String(error) })
    }
    try {
      if (writingStages) service.setWorkspaceStages(path, stages)
      else if (writing) service.setWorkspaceRules(path, rules)
      return json(200, { rules: hubRules(service, path) })
    } catch (error) {
      return json(500, { error: error?.message ?? String(error) })
    }
  })

  // 只整理输入文本：不创建会话、不启动流程、不唤醒 Agent。
  register(API_BASE + '/hub/prepare', ['POST'], async (request) => {
    let body, sessionId
    try {
      body = await request.json()
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是对象')
      if (body.path !== undefined) {
        const path = requireHubPath(body.path)
        sessionId = sessionIdForWorkspace(service, path)
      } else {
        sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        const cwd = sessionId && cwdOfSession(service, sessionId)
        if (!cwd || !isAbsolute(cwd) || !isDirectory(cwd)) throw new Error('无法确定当前会话的工作目录')
      }
      if (typeof body.brief !== 'string') throw new Error('需求原文必须是字符串')
      if (body.brief.length > 20000) throw new Error('需求原文不能超过 20000 字符，请精简后重试。')
    } catch (error) {
      return json(400, { error: error?.message ?? String(error) })
    }
    try {
      return json(200, await prepareRequirement(scoped, { brief: body.brief, ...(sessionId ? { sessionId } : {}) }))
    } catch (error) {
      return json(error?.statusCode === 400 ? 400 : 500, { error: error?.message ?? String(error) })
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
      // 面板每次打开都要逐个目录读快照：名单没有上限，加一个慢盘就能把面板拖住。
      if (registry.workspaces.length >= HUB_MEMBER_LIMIT &&
          !registry.workspaces.some((member) => member.path === path)) {
        return json(400, { error: '工作台最多登记 ' + HUB_MEMBER_LIMIT + ' 个目录，请先移除不用的。' })
      }
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
        // 登记过的评审 / 测试子代理只由 readonlyDenial 管：放行就是放行，
        // 再跑一次 scopeDenial 会把父流程的 scope 当成它们的写权限。
        if (service.childPolicyOf(sessionId)) return next()
        let flow = service.get(ownerId)
        if (!flow) {
          // 这个会话从来没有发起过流程：按工作目录找同项目里运行中的流程兜底（P1-5）。
          // 用户自己 spawn 的普通子代理不会登记进 childOwner（ownerOf 退回它自己），
          // 只有这条兜底能把它纳进 scope——否则子代理就是一条现成的绕过通道。
          flow = service.activeFlowByCwd(cwdOfExec(exec))
          if (!flow) return next()
        } else if (flow.finished) {
          return next()
        }
        // 工作台靠这条摘要显示「正在做什么」；只放内存，不写快照。
        service.noteActivity(flow.sessionId, exec, flow.stage)
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

export { WorkbenchService, scopeDenial, shellDenial }
