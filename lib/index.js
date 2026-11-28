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

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, readdirSync, unlinkSync, statSync, realpathSync, openSync, closeSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, sep, dirname, delimiter } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { deriveTitle, prepareRequirement, sanitizeTitle } from './requirements.js'
import { captureSnapshot, sameSnapshot, findingCounts } from './provenance.js'
import { normalizeCriteria, acceptanceLedger, grillReadiness, remediationList, scopeReadiness, stageSummary, testStall, TEST_STALL_LIMIT } from './acceptance.js'
import { INLINE_EXEC, PARSE_ONLY, READONLY_VERSION, declaredEcosystems, executableName, isRegisteredExecutable, resolveExecutable } from './ecosystems.js'
import { hostState, clientState, describeRuntime, runtimeFields, moduleRevisions, expectedClientRevisionOf, packageVersion } from './runtime.js'
import { registerModuleRevision } from './revisions.js'

export const FLOWGATE_MODULE_REVISION = 'f93f3f13a9d894aad3242764b8c80e64eca5fa11df375daf5cb2c89c9b5fa941'
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

/**
 * 交件工具（doc / gate / review / test）的 decision 取值。
 *
 * 交件与等签收拆开之后，交件这一步根本不等：产物落盘、门禁打开、立刻返回。
 * 于是「这次交成没有」不再需要靠返回值去猜——它只有 submitted 和 stale 两种。
 */
const SUBMIT_DECISION_DESC =
  'submitted：本阶段产物已经提交并保存，门禁已经打开，工具立即返回、不在这里等。' +
  '接下来调用 flowgate_wait 等签收；不要重复提交这份产物，也不要先做下一阶段的工作。' +
  'stale：本阶段没有可交的产物，或者阶段已经变了——先读 flowgate_status，按提示做。'

/**
 * flowgate_wait 的 decision 取值。
 *
 * 只有这里会挂起，也就只有这里会被中断。中断一律返回 halt 并附 submitted 回执：
 * 产物在等待之前就已经保存，Agent 没有「这次没交成」的解释空间。
 */
const WAIT_DECISION_DESC =
  'halt：这次等待被中断（等满上限 / 被新的等待取代 / 调用被取消），工具已经返回；' +
  '本阶段产物在等待之前就已经保存，不要重新提交，停下来等用户在工作台点按钮。' +
  'decided / revise / skipped / cancelled / approved / submitted：用户已经点了按钮，按 next 继续。' +
  'stale：这张门禁已经收尾，或者本阶段还没有产物，不要继续等。'

/**
 * *_run 的 decision 取值。
 *
 * 这两个入口把「跑子代理、落盘、等签收」放在同一次调用里，所以它们没有 submitted：
 * 落盘之后就地挂起，返回的是等待的结果；被中断时是 halt 并附 submitted 回执。
 */
const RUN_DECISION_DESC =
  'halt：这次等待被中断（等满上限 / 被新的等待取代 / 调用被取消），工具已经返回；' +
  '本阶段产物在等待之前就已经保存，不要重新提交，停下来等用户在工作台点按钮。' +
  'pass / reject / skip / cancelled / reopened / stale：用户已经点了按钮或门禁已收尾，按 next 继续。'

/** 中断返回的「产物已落盘」回执形状，四个工具共用。 */
const SUBMITTED_SCHEMA = {
  type: 'object',
  description: '本阶段产物已经保存的凭据：已经交过了，不要再交一次。',
  properties: {
    kind: { type: 'string' },
    label: { type: 'string', description: '产物名称，如「评审报告」。' },
    id: { type: 'string', description: '产物 id（报告 id 或快照 id）；需求文档用提交时间。' },
    detail: { type: 'string' },
  },
  required: ['kind', 'label', 'id', 'detail'],
  additionalProperties: false,
}

/** 需求分析规则可配置；阶段顺序、scope 冻结及门禁仍由宿主强制执行。 */
const BUILTIN_ANALYSIS_RULES = [
  { id: 'clarify-goal', name: '明确目标与约束', points: ['从需求原文确认目标、预期行为与必要约束', '只追问现有信息无法回答的关键决策，一次一个问题'] },
  {
    id: 'grill-until-agreed',
    name: '追问到共识再动手',
    points: ['每次只问一个关键决策，把模糊表述、隐含假设和关键取舍逼出来', '未决问题清零、双方认可同一结论后才提交需求文档'],
  },
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
    analysisRules: ['clarify-goal', 'grill-until-agreed', 'define-scope'],
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
  'flowgate_wait',
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
const SHELL_READONLY = /^(?:pwd|ls|cat|head|tail|wc|echo|git\s+(?:status|diff|log|show|rev-parse|ls-files))(?:[ \t]+[^\r\n|;&`$<>]*)?$/u

/**
 * git branch 单独收紧。通用白名单允许尾部带任意参数，于是
 * `git branch -a --delete main` 能借 -a 通过白名单，再把分支删掉。
 * 这里只允许一个只读选项，外加一个不以 - 开头的分支名过滤模式（`git branch --list 'feat*'`）。
 */
const SHELL_GIT_BRANCH = /^git[ \t]+branch(?:[ \t]*|[ \t]+(?:--list|-a|-v|--show-current)(?:[ \t]+(?!-)[^\r\n|;&`$<>]*)?[ \t]*)$/u

/**
 * A 档：纯解析命令，只读源码不执行它。任何阶段都放行，也不需要用户授权。
 * 由 lib/ecosystems.js 逐项声明固定选项及位置文件的严格边界；附加加载/执行选项不属于纯解析。
 * 隐式配置或缓存可能写盘的 tsc / deno 走批准清单，不从这条免授权通道进入。
 */

/** 审计流水里保留的命令原文上限；超长命令截断并标记，避免一条命令撑爆日志。 */
const SHELL_AUDIT_LIMIT = 200
// 修改意见的长度上限：客户端与宿主共用同一口径，超出的部分在事件里留 truncated 痕迹。
const REVISION_NOTE_LIMIT = 2000
/**
 * 同一批 scope 缺口连续被退回多少次，就把流程停在 S1、把决定权交回给人。
 *
 * 缺口在 S1 就该补齐，不该端给用户去接受；但 Agent 可能陷在「改一点、还差一点」的循环里。
 * 到上限**不判死**：这个信号会误杀（换了一批 AC、缺口类型没变），也会漏杀（每轮只修一条），
 * 而结束一条做了一半的流程代价太大。停在原地让人在「继续改 / 清零重来 / 放弃」里选更划算。
 */
const SCOPE_RISK_STRIKE_LIMIT = 3
/**
 * 门禁等待的默认上限（分钟）。
 *
 * 原来这里没有上限：等待器只活在进程内存里，宿主重启后工具调用就永久悬挂，
 * Agent 既不知道等的是哪个门禁，也无法自救（G40）。0 或负数仍表示「不超时」，
 * 但配置层与调用方都不许传 0——那等于把这个缺陷重新打开。
 */
const GATE_WAIT_DEFAULT_MINUTES = 10
const GATE_WAIT_MIN_MINUTES = 1
const GATE_WAIT_MAX_MINUTES = 60
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
const SHELL_ESCAPE_HINTS = new RegExp(
  '[|;&`$<>\\r\\n]|\\s--output(?:=|\\s)|' + INLINE_EXEC.source,
  'u',
)

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

/**
 * 多行命令单独判一次：拒绝文案要指认「换行是命令分隔符」，而不是笼统说成管道。
 *
 * 与 SHELL_ESCAPE_HINTS 里的换行检查是两道：这里是入口断言，那里是通用逃逸检查。
 * 只留一道的话，以后有人调整字符类就会悄悄放开多行命令。
 */
const SHELL_MULTILINE = /[\r\n]/u

/**
 * 清单条目末尾的目录后缀：`npm run build [packages/web]`。
 *
 * 方括号前必须至少一个空白，避免把 `node --check a[0].js` 这类参数当后缀。
 * 后缀本身不是要执行的命令，剥掉它剩下的才是匹配对象；执行时用的永远是剥掉后的原文。
 */
const SCOPE_DIR_SUFFIX = /\s+\[([^\[\]]*)\]\s*$/u

/** 目录后缀归一：相对流程根、posix 分隔符、根写作 `.`；越界或绝对路径返回 null。 */
function normalizeScopeDir(value) {
  const raw = String(value ?? '').trim().replaceAll('\\', '/')
  if (!raw) return null
  // 控制字符（换行、制表符、NUL）一律判无效：trim 只去掉首尾空白，`[a\nb]` 这种后缀会把
  // 换行留在目录名中间存进清单。commandDirKey 算出来的是真实路径，带换行的目录名和任何
  // 真实 cwd 都比不上，条目看着在清单里、实际永不生效——和「含换行的命令」是同一类问题：
  // 用户以为授权过了，执行侧永远拒。
  if (/[\u0000-\u001f\u007f]/u.test(raw)) return null
  if (raw === '.' || raw === './') return '.'
  if (isAbsolute(raw) || /^[A-Za-z]:/u.test(raw)) return null
  const parts = []
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue
    // 目录后缀只认流程根之内：`..` 等于把授权范围交回给执行时的 cwd。
    if (segment === '..') return null
    parts.push(segment)
  }
  return parts.length ? parts.join('/') : '.'
}

/**
 * 拆一条清单条目：`{command, dir, explicitDir}`。
 * 目录后缀非法（绝对路径、含 ..、空方括号）时返回 null——这种条目不能被当成一条普通命令存下来。
 */
function parseScopeCommand(entry) {
  const text = typeof entry === 'string' ? entry.trim() : ''
  if (!text) return null
  const match = SCOPE_DIR_SUFFIX.exec(text)
  if (!match) return { command: text, dir: '.', explicitDir: false }
  const dir = normalizeScopeDir(match[1])
  if (!dir) return null
  const command = text.slice(0, match.index).trim()
  if (!command) return null
  // 一个条目只能声明一个执行目录。剥掉末尾后缀后还剩一个方括号后缀，说明作者写了两个目录：
  // 留着它会被当成「在目录 b 里跑 `npm run build [a]`」，命令和目录都错位，所以判无效。
  if (SCOPE_DIR_SUFFIX.test(command)) return null
  return { command, dir, explicitDir: true }
}

/** 把目录后缀拼回条目：根目录不带后缀，与「默认只认流程根」是同一个意思。 */
function scopeCommandEntry(command, dir) {
  const normalized = normalizeScopeDir(dir)
  if (normalized === null || normalized !== dir) return null
  const text = normalized === '.' ? command : command + ' [' + normalized + ']'
  const parsed = parseScopeCommand(text)
  return parsed?.command === command && parsed.dir === normalized && text.length <= SCOPE_COMMAND_LIMIT ? text : null
}

/**
 * 一次命令判定的执行目录，相对流程根（根为 `.`）。
 *
 * 清单条目里的目录后缀与 files_expected_to_change 用的是同一个基准（flow.cwd），
 * 不是 git 仓库根：同一份 scope 里两套基准会让「这条命令在哪个目录跑」出现两种答案。
 */
function commandDirKey(root, cwd) {
  const base = typeof root === 'string' && root ? root : process.cwd()
  const actual = typeof cwd === 'string' && cwd ? cwd : base
  const rel = relative(resolve(base), resolve(actual))
  if (!rel) return '.'
  return rel.replaceAll(sep, '/')
}

/** 流程根之外（含另一盘符）的目录不可能被任何条目覆盖，单列出来好写拒绝文案。 */
function isOutsideFlowRoot(dirKey) {
  return dirKey === '..' || dirKey.startsWith('../') || isAbsolute(dirKey) || /^[A-Za-z]:/u.test(dirKey)
}

/** 授权目录的相对路径与文件系统身份必须一致，流程根本身可以有规范路径别名。 */
function executionDirectory(root, requested) {
  const absolute = resolve(root, requested ?? root)
  const requestedDir = commandDirKey(root, absolute)
  let realRoot, cwd
  try {
    realRoot = realpathSync.native(root)
    cwd = realpathSync.native(absolute)
    if (!statSync(cwd).isDirectory()) throw new Error('目标不是目录')
  } catch (error) {
    return { cwd: absolute, dir: requestedDir, error: '无法确认执行目录（' + (error.code ?? error.message) + '）' }
  }
  const dir = commandDirKey(realRoot, cwd)
  if (isOutsideFlowRoot(requestedDir) || isOutsideFlowRoot(dir)) {
    return { cwd, dir, error: '执行目录不在流程根目录之内' }
  }
  if (compareKey(requestedDir) !== compareKey(dir)) {
    return { cwd, dir, error: '执行目录的实际位置与请求的路径不一致' }
  }
  return { cwd, dir, error: null }
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

/** 正式 SDK 字段逐工具声明；不跨工具猜测参数别名。 */
const TOOL_TARGETS = Object.freeze({
  write: { enumerable: true, fields: [{ name: 'file_path', required: true }] },
  edit: { enumerable: true, fields: [{ name: 'file_path', required: true }] },
  str_replace_editor: { enumerable: true, fields: [{ name: 'path', required: true }] },
  ops_write_file: { enumerable: true, fields: [{ name: 'path', required: true }] },
  ops_edit_file: { enumerable: true, fields: [{ name: 'path', required: true }] },
  ops_remove: { enumerable: true, fields: [{ name: 'path', required: true }] },
  ops_move: { enumerable: true, fields: [{ name: 'path', required: true }, { name: 'to', required: true }] },
  ops_copy: { enumerable: true, fields: [{ name: 'path', required: true }, { name: 'to', required: true }] },
  ops_replace: { enumerable: true, fields: [{ name: 'path', required: true }] },
  decompress: { enumerable: true, fields: [{ name: 'toFile', required: false }] },
  ops_batch: { enumerable: false, mode: 'batch' },
})
const BATCH_TARGETS = Object.freeze({
  copy: TOOL_TARGETS.ops_copy,
  move: TOOL_TARGETS.ops_move,
  remove: TOOL_TARGETS.ops_remove,
})
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const validTargetPath = (value) => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')

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
    if (SHELL_MULTILINE.test(entry)) {
      commandErrors.push('这条命令含换行：换行是命令分隔符：' + entry.slice(0, 60))
      continue
    }
    const text = entry.trim()
    if (!text) {
      commandErrors.push('有一条空命令条目')
      continue
    }
    if (text.length > SCOPE_COMMAND_LIMIT) {
      commandErrors.push('这条命令超过 ' + SCOPE_COMMAND_LIMIT + ' 字：' + text.slice(0, 60) + '…')
      continue
    }
    // 条目可能带目录后缀（`npm run build [packages/web]`）：后缀不是要执行的命令，
    // 逃逸检查必须只看剥掉后缀的那一段，否则 `[.]` 里的字符会干扰判定；
    // 反过来，后缀本身非法（绝对路径、含 ..、空方括号）时这条条目根本没法生效，必须报错而不是存下来。
    const parsed = parseScopeCommand(text)
    if (!parsed) {
      commandErrors.push('这条命令的目录后缀无效（只能是流程根之内的相对目录，不要用绝对路径或 ..）：' + text)
      continue
    }
    // 判定与真实放行同源：逃逸检查在清单匹配之前，所以命中的条目永远不会生效。
    if (SHELL_ESCAPE_HINTS.test(stripHarmlessSuffixes(parsed.command))) {
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

/**
 * 冻结 scope 反推成可编辑草稿。
 *
 * 退回 S1 补命令清单时用它把原来批准过的那份 scope 抄回来：
 * 用户要补的是一条命令，不是从零重写文件清单与验收标准。
 */
function pendingScopeFromFrozen(frozen) {
  const inScope = frozen?.in_scope ?? {}
  return {
    files_expected_to_change: strings(inScope.files_expected_to_change),
    commands: strings(inScope.commands),
    command_sources: [],
    capabilities: strings(inScope.capabilities),
    shared_contracts: Array.isArray(inScope.shared_contracts) ? inScope.shared_contracts.slice() : [],
    out_of_scope_explicitly: strings(frozen?.out_of_scope_explicitly),
    acceptance_criteria: Array.isArray(frozen?.acceptance_criteria) ? frozen.acceptance_criteria.slice() : [],
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

/** 必填字段不可缺失；可选字段只有真正省略时才表示无写入。 */
function targetsFromFields(name, args, declaration) {
  const targets = []
  for (const field of declaration.fields) {
    if (!Object.hasOwn(args, field.name) && !field.required) continue
    if (!validTargetPath(args[field.name])) {
      return { kind: 'unknown', reason: '工具 ' + name + ' 的目标参数 ' + field.name + ' 必须是明确的非空路径，无法核对目标，已拒绝。' }
    }
    targets.push({ path: args[field.name] })
  }
  return targets.length ? { kind: 'targets', targets } : { kind: 'none' }
}

/** null = 未登记；已登记工具明确区分无写入、完整目标与无法核对。 */
function scopeTargetsOf(name, args, cwd) {
  if (!Object.hasOwn(TOOL_TARGETS, name)) return null
  const unknown = (reason) => ({ kind: 'unknown', reason })
  if (!isRecord(args)) return unknown('工具 ' + name + ' 的目标参数格式无效，无法核对目标，已拒绝。')
  const declaration = TOOL_TARGETS[name]
  // 图片恢复会自行选择落盘路径，不能当成普通的无 toFile 上下文恢复。
  if (name === 'decompress' && Object.hasOwn(args, 'imageRef') && args.imageRef !== 'list') {
    return unknown('图片恢复的落盘目标无法静态核对，已拒绝。')
  }
  if (declaration.enumerable) return targetsFromFields(name, args, declaration)

  if (declaration.mode === 'batch') {
    // plan 只创建无效应审计计划；resume 引用的历史计划不能从本次参数证明。
    if (args.action === 'plan') return { kind: 'none' }
    if (Object.hasOwn(args, 'operationsRef')) {
      return unknown('批量操作的分页引用无法静态核对目标路径，已拒绝：请把 operations 直接写进参数再执行。')
    }
    if (args.action !== 'run') return unknown('批量操作的 action 必须是可枚举的 run；历史计划 resume 的目标无法静态核对，已拒绝。')
    if (!Array.isArray(args.operations)) return unknown('批量操作必须显式声明 operations 数组，无法核对目标，已拒绝。')
    if (Object.hasOwn(args, 'root') && !validTargetPath(args.root)) return unknown('批量操作的 root 必须是明确的非空路径，无法核对目标，已拒绝。')
    const targets = []
    for (const operation of args.operations) {
      if (!isRecord(operation) || typeof operation.op !== 'string' || !Object.hasOwn(BATCH_TARGETS, operation.op)) {
        return unknown('批量操作包含未声明的操作类型，无法核对目标，已拒绝。')
      }
      const result = targetsFromFields('ops_batch.' + operation.op, operation, BATCH_TARGETS[operation.op])
      if (result.kind === 'unknown') return result
      for (const target of result.targets) {
        // path/to 相对 root 解析；root 未提供时保持相对实际调用会话的语义。
        targets.push({ path: Object.hasOwn(args, 'root') ? resolve(cwd, args.root, target.path) : target.path })
      }
    }
    return targets.length ? { kind: 'targets', targets } : { kind: 'none' }
  }
  return unknown('工具 ' + name + ' 未声明可核对的目标边界，已拒绝。')
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
/** 单条验收证据内部的视觉测量条数上限；超限拒绝，不截断。 */
const MEASUREMENT_LIMIT = 100
/** 单条验收证据内部的文件引用条数上限；超限拒绝，不截断。 */
const CITATION_ENTRY_LIMIT = 20
/** 工作台最多登记的工作目录数：每次打开面板都要逐个目录读快照。 */
const HUB_MEMBER_LIMIT = 50
/** 单个评审角度原始发现数上限；手工超限整份拒绝，子代理超限标未覆盖。 */
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
/** 快照超限时先裁事件流水副本（完整流水在 flows.jsonl）保留最近这么多条。 */
const SNAPSHOT_EVENT_KEEP = 50
/**
 * 布局回执的保留上限。
 *
 * 回执按「引用」而不是按时间滚动淘汰：还挂在验收记录上的回执永不丢弃，
 * 因为丢掉它就等于把一条已经通过的视觉验收改成「没有证据」。
 */
const LAYOUT_EVIDENCE_LIMIT = 200

/** 人类可读的字节数：界面与报错文案都靠它说清「到底多大」。 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MiB'
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
  flow.persistProblem = null
  flow.persistTrimmed = null
  let body = null
  try {
    body = JSON.stringify(flow, null, 2)
  } catch (error) {
    flow.persistError = { at: nowIso(), message: error?.message ? String(error.message).slice(0, 200) : '序列化失败' }
  }
  // 写侧与读侧必须用同一把尺子：读侧超过 SNAPSHOT_LIMIT 会拒绝载入，
  // 所以写侧绝不产出一个自己读不回来的文件——那种文件只会让流程在重启后凭空消失。
  if (body !== null && Buffer.byteLength(body, 'utf8') > SNAPSHOT_LIMIT) {
    const before = Array.isArray(flow.events) ? flow.events.length : 0
    if (before > SNAPSHOT_EVENT_KEEP) {
      flow.events = flow.events.slice(-SNAPSHOT_EVENT_KEEP)
      const dropped = before - flow.events.length
      flow.persistTrimmed = {
        at: nowIso(), events: dropped, kept: flow.events.length,
        message: '快照超过 ' + formatBytes(SNAPSHOT_LIMIT) + '，已丢弃最早的 ' + dropped
          + ' 条事件副本；完整流水仍在 flows.jsonl，账本与报告不受影响。',
      }
      body = JSON.stringify(flow, null, 2)
    }
    if (Buffer.byteLength(body, 'utf8') > SNAPSHOT_LIMIT) {
      const bytes = Buffer.byteLength(body, 'utf8')
      // 裁无可裁：不写盘，但必须说出来。悄悄写出去等于让重启后的流程消失。
      flow.persistProblem = {
        at: nowIso(), kind: 'oversize', bytes, limit: SNAPSHOT_LIMIT,
        message: '状态体积 ' + formatBytes(bytes) + ' 超过快照上限 ' + formatBytes(SNAPSHOT_LIMIT)
          + '，本次没有写盘；当前进度只在内存里，重启会退回上一次成功保存的状态。',
      }
      body = null
    }
  }
  if (body !== null) {
    try {
      writeJsonAtomic(file, flow)
    } catch (error) {
      // 落盘失败不回滚内存状态：状态机优先，日志与快照是审计用途。
      // 但也不能装作没发生：冷恢复后状态会退回旧快照，界面必须能看见这条。
      flow.persistError = { at: nowIso(), message: error?.message ? String(error.message).slice(0, 200) : '写盘失败' }
    }
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
      // 跨会话列表也守同一条上限：超限快照照样登记成「未载入」，
      // 否则卡片会安静地少一条，用户只看到「历史记录不见了」。
      const size = statSync(file).size
      if (size > SNAPSHOT_LIMIT) {
        service.recordLoadProblems(cwd, [{
          file: name, bytes: size, limit: SNAPSHOT_LIMIT, reason: 'oversize',
          message: name + ' 有 ' + formatBytes(size) + '，超过快照上限 ' + formatBytes(SNAPSHOT_LIMIT) + '，本次未载入',
        }])
        cached.set(name, { signature, summary: null, requirement: null })
        continue
      }
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
    } catch (error) {
      // 坏 JSON 记住签名（避免每帧重解析），同时登记成「未载入」：
      // 静默跳过的坏文件在界面上看起来就是「这条流程从来没存在过」。
      service.recordLoadProblems(cwd, [{
        file: name, bytes: null, limit: SNAPSHOT_LIMIT, reason: 'bad-json',
        message: name + ' 不是合法 JSON，本次未载入（'
          + (error?.message ? String(error.message).slice(0, 120) : '解析失败') + '）',
      }])
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

/**
 * 冷恢复读快照。
 *
 * 跳过一个快照的后果是「流程凭空消失」，而数据其实还在盘上——所以每一次跳过
 * 都必须登记进 problems（超大 / 坏 JSON），由界面与 flowgate_status 说出来。
 * 读错误（权限等）仍然向上抛：那是环境问题，修好权限重试即可，不该被当成坏数据。
 */
function loadFlowsFromDisk(cwd, problems = null) {
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
    const file = join(dir, name)
    let raw
    let size = null
    try {
      size = statSync(file).size
      if (size > SNAPSHOT_LIMIT) {
        problems?.push({
          file: name, bytes: size, limit: SNAPSHOT_LIMIT, reason: 'oversize',
          message: name + ' 有 ' + formatBytes(size) + '，超过快照上限 ' + formatBytes(SNAPSHOT_LIMIT) + '，本次未载入',
        })
        continue
      }
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      throw error
    }
    try {
      out.push(JSON.parse(raw))
    } catch (error) {
      problems?.push({
        file: name, bytes: size, limit: SNAPSHOT_LIMIT, reason: 'bad-json',
        message: name + ' 不是合法 JSON，本次未载入（'
          + (error?.message ? String(error.message).slice(0, 120) : '解析失败') + '）',
      })
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
  return { id, name, points }
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
    return {
      version: WORKSPACE_CONFIG_VERSION,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      stages,
      rules: stages.S2,
      // 门禁等待上限：越界或缺失一律回默认，绝不接受 0——0 等于「永不超时」，
      // 那正是这条流程要修的永久悬挂。
      gateWaitMinutes: normalizeGateWaitMinutes(raw.gateWaitMinutes),
    }
  } catch {
    // 坏文件当没配置；已知旧版 rules 仅迁移到 S2，绝不扩大授权。
    return null
  }
}

/** 配置里的等待上限只接受 [1, 60] 的整数分钟；其余一律回默认 10 分钟。 */
function normalizeGateWaitMinutes(value) {
  // 只认有限数值（或纯数字字符串）：Number(true) === 1，配置文件手写成布尔值不只是
  // 类型脏，还会把「没写」悄悄解释成「等 1 分钟」。空串同理，它是「缺省」不是 0。
  const typed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  const minutes = Number(typed)
  if (!Number.isFinite(minutes)) return GATE_WAIT_DEFAULT_MINUTES
  const rounded = Math.round(minutes)
  if (rounded < GATE_WAIT_MIN_MINUTES || rounded > GATE_WAIT_MAX_MINUTES) return GATE_WAIT_DEFAULT_MINUTES
  return rounded
}

/** 等待上限的毫秒值：工作区配置优先，没有配置就用默认 10 分钟。 */
function gateWaitTimeoutMs(workspace) {
  return normalizeGateWaitMinutes(workspace?.gateWaitMinutes) * 60000
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
    // 门禁请求记录：null 表示本阶段还没请求过门禁；请求时写成 { id, at, kind, endedAt, endKind }。
    // 旧快照里这里是布尔值 true，gateRequestOf 仍然认——冷恢复不能因为换了形状就丢历史。
    gateRequested: null,
  }
}

/**
 * 「一轮 scope 作业」的全部易失状态，整体生成、整体丢弃。
 *
 * 这些字段的共同点是：含义只在**同一次 scope 作业**内成立。退回 S1 意味着重写方案，
 * 也就是换了一轮——上一轮的待补命令、已拒命令、缺口记录、连续退回次数都不再描述任何
 * 正在发生的事。留着只会让新方案背着旧账：门禁追问一条早就不存在问题的命令，
 * 连续退回计数还会把新方案直接判成「AI 卡死」。
 *
 * 所以不按字段清单清零（漏一个就是一个 G21），而是让「换一轮」等于换掉整个对象：
 * epoch 递增，其余回到初值。清理只发生在 create / rollback / cancel / repair 四处，
 * 而这四处都只替换这一个属性。
 */
function emptyScopeCycle(epoch = 1) {
  return {
    /** 第几轮 scope 作业；退回 S1 时递增。纯诊断用，也方便日志分辨「这是新的一轮」。 */
    epoch,
    /** 需求文档随附、尚未冻结的 scope；批准前展示给用户核对。 */
    draft: null,
    /** 提交时被剔除的越界条目，批准前一并展示。 */
    dropped: [],
    /**
     * S1 静态体检出的「验收方案缺口」：声明要跑测试却没有测试命令、集成验收却没有测试文件等。
     * 不拦截提交，但批准 scope 前必须让用户看见并明确接受。
     */
    risks: [],
    /**
     * 上一次提交因验收方案缺口被退回时的缺口原文：界面要能回答「为什么还没让我批准」。
     * 与 risks 分开：后者是「待批准且需确认」，前者是「已被退回」。
     */
    riskLast: [],
    /**
     * 同一批缺口连续被退回的计数：{ signature, count }，null 表示还没被退过。
     * 到 SCOPE_RISK_STRIKE_LIMIT 时不再判死流程，而是停 S1 把选择权交回给人。
     */
    strikes: null,
    /**
     * 补录申请单（G41）：用户把被拒的命令补进清单时，把「现场」一并留在流程里。
     * 举证由 Agent 在重新提交时用 AC 的 verification.commands 补上，不另造自报字段。
     * 作用期就是「退回 S1 到重新批准」这一段，所以随轮次一起作废。
     */
    requests: [],
    /**
     * 被拒、但用户还没决定补不补的变更性命令。
     *
     * 队列而不是单值：开发期间连拒三条命令，门禁上要能一次问清楚。
     * 出队有三条路——用户点「补」进清单、点「不补」记进 declinedCommands、
     * 或冻结时发现它已经在新清单里（对账出队）。
     */
    pendingCommands: [],
    /**
     * 用户明确放弃授权的命令：不再重复弹窗，但仍然会被拒绝——「不补」只代表知情。
     *
     * 这一条跨轮保留：清掉的话，用户改主意后连「再问一次」的入口都没了。
     * 它在冻结时同样参与对账——命令既然进了新清单，这个「不补」也就过期了。
     */
    declinedCommands: [],
  }
}

/**
 * 读门禁请求记录，兼容旧快照的布尔值。
 *
 * 旧版本只存 true：它表达不了「哪一次请求」和「这次请求怎么结束的」，
 * 而这正是 G40 要补的两件事——重启后 Agent 得知道上次等的是哪个门禁，
 * 界面也得区分「还在等」与「等过但中断了」。
 */
function gateRequestOf(record) {
  const raw = record?.gateRequested
  if (raw === true) return { id: null, at: null, kind: null, endedAt: null, endKind: null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : null,
    at: typeof raw.at === 'string' ? raw.at : null,
    kind: typeof raw.kind === 'string' ? raw.kind : null,
    endedAt: typeof raw.endedAt === 'string' ? raw.endedAt : null,
    endKind: typeof raw.endKind === 'string' ? raw.endKind : null,
  }
}

/**
 * 记下「这一轮确实请求过门禁」：用来区分「产物刚落地、Agent 还没请求」与「请求被中断」。
 * 前者不该提示用户「上次的请求被中断」。
 *
 * 每次挂起都换一个新 id：同一个 id 表示「同一次等待」，重启恢复后 Agent 据此判断
 * 等的是不是刚才那一关。上一轮的收尾标记必须一起清掉，否则新一轮一挂上就被当成已结束。
 */
function markGateRequested(flow, kind, existing) {
  const record = flow.stages[flow.stage]
  if (!record) return null
  // 交件与等签收是两次工具调用：交件时已经把闸打开了，等签收必须认同一张闸。
  // 换 id 会让 Agent 手上那个 gateId 立刻失效，界面也会把一次等待显示成两次。
  const current = gateRequestOf(record)
  if (existing && current && existing.id && current.id === existing.id && !current.endedAt) {
    return current
  }
  const request = {
    id: 'gate_' + randomUUID().slice(0, 8),
    at: nowIso(),
    kind: kind ?? null,
    endedAt: null,
    endKind: null,
  }
  record.gateRequested = request
  // 新的一轮等待开始了：上一轮的「重启过」「已超时」都不再描述当前状态。
  flow.gateRecovered = null
  flow.gateWaitReason = null
  persist(flow)
  return request
}

/**
 * 给当前门禁请求收尾：等待器没了（超时、被取消、被新的等待取代），
 * 但请求本身确实发生过——不清空，只标记它是怎么结束的。
 *
 * 清掉会让界面回到「pending 且未中断」，把「没提交」与「提交了但没人点」合并成一件事。
 */
function endGateRequest(flow, endKind, gateId) {
  const record = flow.stages[flow.stage]
  const request = gateRequestOf(record)
  if (!record || !request || request.endedAt) return null
  // 只收尾自己那一次：被取代时新等待已经写了自己的 id，
  // 旧调用晚一步回来，绝不能把新请求标成「已结束」——那正是「以为还在等、其实记录说结束了」。
  if (gateId && request.id && request.id !== gateId) return null
  const ended = { ...request, endedAt: nowIso(), endKind: endKind ?? 'unknown' }
  record.gateRequested = ended
  flow.gateWaitReason = ended.endKind
  appendEvent(flow.cwd, flow, ended.endKind === 'timeout' ? 'gate.timeout' : 'gate.interrupted', {
    gateId: ended.id,
    kind: ended.kind,
    stage: flow.stage,
    endKind: ended.endKind,
  })
  persist(flow)
  return ended
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
    /**
     * 用户声明的额外只读工具名。
     * 宿主新增只读工具（例如刷新入口）时，插件不认识就一律拒绝——默认拒绝是对的，
     * 但没有出口的话，一个刷新按钮就能把整条流程卡死（实机踩到）。
     * 用户在这里声明「我确认它只读」，插件就放行；写工具与 shell 不接受这种豁免。
     */
    toolAllowlist: [],
    doc: { html: null, recommendedPreset: null, reason: null, at: null },
    /** 本轮 scope 作业的全部易失状态；退回 S1 时整体换掉，见 emptyScopeCycle。 */
    scopeCycle: emptyScopeCycle(),
    grill: { pending: null, answered: [] },
    /**
     * 宿主重启后补写的「门禁还开着，但等待器没了」记录：{ gateId, kind, stage, at }。
     * 与 gateRequested 分开存：后者是「请求过」，前者是「发现它悬在重启里」。
     */
    gateRecovered: null,
    /** 最近一次等待是怎么结束的：timeout / superseded / aborted / restart；null 表示还在等或没等过。 */
    gateWaitReason: null,
    stages: { S1: emptyStage(), S2: emptyStage(), S3: emptyStage(), S4: emptyStage() },
    review: null,
    test: null,
    devChanges: null,
    /** 回退留下的可复用结论；null 表示没有可复用的上一轮。 */
    carryOver: null,
    /**
     * S4 退回时卡住的 AC 批次：{ gaps, statuses, streak, at }。
     * 同一批 AC 连续 TEST_STALL_LIMIT 轮没通过就改道 S1，别再让人在同一个循环里烧 token。
     */
    testStall: null,
    /**
     * 本流程被退回的累计账：{ total, byReason, skipped, last }。
     * 与 testStall 分工不同：testStall 判「是不是在原地打转」（会重置），
     * 这里记「这条流程一共被退回几次」（只增不减），用来看成本与复盘。
     */
    rollbacks: { total: 0, byReason: {}, skipped: 0, last: null },
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
/** 轮次号只增不减；坏值按第 1 轮处理，别让一条脏快照把计数洗回去。 */
function nextScopeEpoch(cycle) {
  const current = cycle && Number.isSafeInteger(cycle.epoch) && cycle.epoch >= 1 ? cycle.epoch : 0
  return current + 1
}

/**
 * 冷恢复：整块读回 scope 作业状态。
 *
 * 逐字段抢救看起来更「宽容」，实际会把旧快照里的半套状态带进新的一轮——
 * 那正是 G21 的病根。这里只认两种结果：整块形状可信就整块留下，否则整块作废。
 */
function repairScopeCycle(saved, fallback) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return fallback
  const listOf = (value) => (Array.isArray(value) ? value : [])
  const objectOr = (value, empty) => (value && typeof value === 'object' && !Array.isArray(value) ? value : empty)
  return {
    epoch: Number.isSafeInteger(saved.epoch) && saved.epoch >= 1 ? saved.epoch : fallback.epoch,
    draft: objectOr(saved.draft, null),
    dropped: listOf(saved.dropped),
    risks: listOf(saved.risks),
    riskLast: listOf(saved.riskLast),
    strikes: objectOr(saved.strikes, null),
    requests: listOf(saved.requests),
    pendingCommands: listOf(saved.pendingCommands),
    declinedCommands: listOf(saved.declinedCommands),
  }
}

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
  for (const key of ['customAnalysisRules', 'customAngles', 'customDirections', 'customRules', 'toolAllowlist', 'events']) {
    if (!Array.isArray(flow[key])) flow[key] = []
  }
  // scope 作业状态要么整块可信、要么整块作废：不做逐字段抢救。
  // 抢救出来的半套状态正是 G21 的来源——草稿清空了、队列还在，界面自相矛盾。
  flow.scopeCycle = repairScopeCycle(raw.scopeCycle, base.scopeCycle)
  // 卡住记录同理：形状不对就当作没卡住，别让一条坏快照决定「改道 S1」。
  if (!flow.testStall || typeof flow.testStall !== 'object' || Array.isArray(flow.testStall)
    || !Array.isArray(flow.testStall.gaps) || !Number.isSafeInteger(flow.testStall.streak)) {
    flow.testStall = null
  } else {
    // 缺口身份（id + 验收办法）与改道次数都要可信：缺了 keys 就没法判断「还是不是同一批」，
    // 而 redirects 决定界面要不要升级提示，坏值按「还没改道过」处理。
    if (!Array.isArray(flow.testStall.keys)) flow.testStall.keys = []
    flow.testStall.redirects = Number.isSafeInteger(flow.testStall.redirects) && flow.testStall.redirects >= 0 ? flow.testStall.redirects : 0
  }
  // 回退账只保留可信的计数字段：坏形状按「还没退过」处理，别让一条坏快照算出负数次数。
  const savedRollbacks = flow.rollbacks && typeof flow.rollbacks === 'object' && !Array.isArray(flow.rollbacks) ? flow.rollbacks : {}
  const safeCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0)
  flow.rollbacks = {
    total: safeCount(savedRollbacks.total),
    byReason: savedRollbacks.byReason && typeof savedRollbacks.byReason === 'object' && !Array.isArray(savedRollbacks.byReason) ? savedRollbacks.byReason : {},
    skipped: safeCount(savedRollbacks.skipped),
    last: savedRollbacks.last && typeof savedRollbacks.last === 'object' && !Array.isArray(savedRollbacks.last) ? savedRollbacks.last : null,
  }
  // 旧快照可能带着已废弃的整理稿字段：一律丢掉，需求依据只有 brief 原文。
  delete flow.summary
  // 单值的被拒命令字段已被 pendingCommands 队列取代：展开会把旧值带回来，
  // 留着只会变成没人读的僵尸字段，读它的代码也已经改完了。
  delete flow.lastDeniedCommand
  // 旧快照里的授权字段同样丢掉：权限只有一个来源，就是冻结 scope 的 commands 清单。
  delete flow.shellGrant
  delete flow.writeGrants
  delete flow.directionWriteDeclared
  // 旧的顶层 scope 作业字段已经搬进 scopeCycle：展开会把它们原样带回来，
  // 留着就是两份真相，而且是没人更新的那一份。
  for (const key of [
    'pendingScope', 'pendingScopeDropped', 'pendingScopeRisks', 'scopeRiskLast',
    'scopeRiskStrikes', 'scopeRequests', 'pendingCommands', 'declinedCommands',
  ]) {
    delete flow[key]
  }
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

function activeAngles(flow, workspace) { return stageConfig(flow, 'S3', workspace).ids }
function activeDirections(flow, workspace) { return stageConfig(flow, 'S4', workspace).ids }
function angleCatalog(flow, workspace) { return stageConfig(flow, 'S3', workspace).catalog }
function directionCatalog(flow, workspace) { return stageConfig(flow, 'S4', workspace).catalog }
function ruleSourceOf(flow, workspace) { return stageConfig(flow, 'S2', workspace).source }
function activeRules(flow, workspace) { return stageConfig(flow, 'S2', workspace).ids }
function ruleCatalog(flow, workspace) { return stageConfig(flow, 'S2', workspace).catalog }
function resolveRules(flow, workspace) { return stageConfig(flow, 'S2', workspace).items }
function resolveAngles(flow, workspace) { return stageConfig(flow, 'S3', workspace).items }
function resolveDirections(flow, workspace) { return stageConfig(flow, 'S4', workspace).items }

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
    stages: Object.fromEntries(STAGES.map((stage) => [
      stage,
      stageConfig(flow, stage, workspace).items,
    ])),
  })
}

/**
 * 运行版本：宿主层与页面层分开算，合并态 status 仍是三值（verified / mismatch / unverified），
 * 既有消费方（布局证据回执、visualResult）读的是它，语义不变。
 * 页面层的 absent 与 unverified 在合并态里都记 unverified——把保护性断言改弱比多一个分支更糟；
 * 但 status 输出会各自念出来，Agent 才分得清「页面没开」和「上报了垃圾」。
 */
/** 验收引用要按真实文件核对：按 citations 里出现的文件去重读一次，读不到也记下来，交给账本降级。 */
function evidenceCitations(flow) {
  const entries = [
    ...(Array.isArray(flow?.test?.acceptance) ? flow.test.acceptance : []),
    ...(Array.isArray(flow?.review?.acceptance) ? flow.review.acceptance : []),
  ]
  const files = new Set()
  for (const entry of entries) {
    for (const citation of Array.isArray(entry?.citations) ? entry.citations : []) {
      const file = typeof citation?.file === 'string' ? citation.file.trim() : ''
      if (file) files.add(file)
    }
  }
  const cache = new Map()
  return [...files].slice(0, 40).map((file) => {
    const source = findingSource(flow, file, cache)
    return source
      ? { file, lineCount: source.lineCount, lines: source.lines }
      : { file, lineCount: 0, lines: [], error: '文件不存在、不可读或不在项目目录内' }
  })
}

function runtimeOf(flow) {
  const page = SERVICE?.runtimeClients.get(flow.sessionId)
  const detected = moduleRevisions()
  const host = hostState(detected)
  const client = clientState(page ?? null, detected.expectedClientRevision ?? expectedClientRevisionOf())
  // 运行版本字段只在这里产出一次；stale / hostStatus 是内部消费方沿用的旧名字。
  const runtime = {
    ...runtimeFields(packageVersion(), host, client),
    stale: host.stale,
    hostStatus: host.status,
    pageId: page?.pageId ?? '',
    viewport: page?.viewport ?? null,
    layoutEvidence: flow.layoutEvidence ?? [],
    cwd: flow.cwd ?? '',
    evidenceSources: evidenceCitations(flow),
    scopeFiles: Array.isArray(flow?.scope?.data?.in_scope?.files_expected_to_change)
      ? flow.scope.data.in_scope.files_expected_to_change : [],
  }
  if (host.status !== 'verified') return { ...runtime, status: host.status, reason: host.reason }
  // 页面层：过期与「没参与」都归 absent，由 clientState 一处判定。TTL 只在那里比一次——
  // 两处各比一次，阈值一旦漂移，页面层与合并层就会对「过期」给出不同结论，而 G38 的价值
  // 恰恰在两层结论可互相核对。这里只补 clientState 看不到的页面实例信息。
  if (client.status === 'verified' && page?.pageId && page.viewport) {
    return { ...runtime, status: 'verified', reason: '页面执行的插件与宿主实际加载模块版本均已核对。' }
  }
  if (client.status === 'mismatch') return { ...runtime, status: 'mismatch', reason: client.reason }
  // verified 却缺 pageId / 视口的记录不该存在；真出现也按「实例不全」念，
  // 不借用「已核对」的文案，更不把「过期」再判一遍。
  if (client.status === 'verified') return { ...runtime, status: 'unverified', reason: '页面实例或视口信息缺失，页面层无法核对。' }
  return { ...runtime, status: 'unverified', reason: client.reason || '页面尚未上报实际执行的插件指纹。' }
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
 * 规则与配置（含 S4 自己的测试方向）刻意不进这个比较——
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
  // 未核实不等于已评审：位置与描述对不上的发现，格式齐全也只是「看起来像证据」。
  // 整条角度的发现全部未核实，说明这个角度没有一条站得住——放过去就是把
  // 「评审通过」变成一句没有内容的话，而这正是评审要挡的事。
  // 跳过评审仍允许，但被跳过的未核实角度要留名：跳过是用户的权利，
  // 事后要能看出「这个角度是没核过就被跳过的」，而不是只剩一句「用户跳过了」。
  const unverifiedAngles = flow.stage === 'S3'
    ? (report?.angles ?? []).filter((angle) =>
      Array.isArray(angle?.findings) && angle.findings.length > 0 && angle.findings.every((finding) => finding?.unverified === true))
    : []
  if (flow.stage === 'S3' && decision !== 'skip') {
    if (unverifiedAngles.length) {
      throw new Error('这些评审角度的发现全部未核实（位置与描述对不上）：'
        + unverifiedAngles.map((angle) => String(angle?.name ?? angle?.id ?? '')).join('、')
        + '；请让评审补上能对上的证据后重新提交。')
    }
    // 被丢弃的严重发现是另一种漏网：它因为缺字段没进 blocking，但缺的恰恰是
    // 「严重」这一档最该有的证据。当成没看见，等于用格式错误换一次放行。
    const dropped = (report?.angles ?? []).flatMap((angle) => (Array.isArray(angle?.rejectedFindings) ? angle.rejectedFindings : [])
      .filter((item) => item?.severity !== 'MINOR')
      .map((item) => ({ angle, item })))
    if (dropped.length) {
      throw new Error('这些角度有 CRITICAL/MAJOR 级发现因缺少证据字段被丢弃：'
        + dropped.map(({ angle, item }) => String(angle?.name ?? angle?.id ?? '')
          + ' 第 ' + (Number.isSafeInteger(item?.index) ? item.index + 1 : '?') + ' 条缺 '
          + (Array.isArray(item?.missing) ? item.missing.join('、') : '证据')).join('；')
        + '；请补上证据后重新提交评审。')
    }
  }
  if (flow.stage === 'S3' && decision !== 'skip' && report?.angles?.some((angle) => angle.coverage === 'uncovered' || angle.executionError)) {
    throw new Error('评审角度仍有目标文件未检查、读取失败或证据字段不完整，请重新评审，不能通过评审。')
  }
  if (flow.stage === 'S4' && ['passed', 'accepted_with_risk'].includes(flow.stages.S3.status) && !sameCode(flow.review?.snapshot, snapshot)) {
    throw new Error('评审后代码已变化，请退回开发并重新评审，不能用旧评审通过新代码。')
  }
  const ledger = acceptanceOf(flow, snapshot)
  const points = (flow.test?.directions ?? []).flatMap((direction) => direction.points ?? [])
  const pointCounts = countPointResults(points)
  // 环境受限也是缺口：它说的是「这个环境没验过」，不是「验证通过」。
  // 从缺口里减掉它，等于让被测方用一句理由把一条没验过的 AC 结清；
  // 现在它单独成账，并要求用户再明确接受一次（acceptExcluded），而不是跟着
  // 「接受未通过/未覆盖」一起被顺手点掉。
  const unpassedPoints = pointCounts.fail + pointCounts.uncovered
  const gaps = ledger.counts.total - ledger.counts.pass
  const excluded = ledger.counts.excluded ?? 0
  const excludedGaps = gaps - excluded
  if (flow.stage === 'S4' && (excludedGaps || unpassedPoints)) {
    if (options.acceptUncovered !== true) {
      throw new Error('仍有 ' + gapSentence(ledger.counts, pointCounts) + '；请选择退回修复，或明确接受未通过/未覆盖项（acceptUncovered: true）。')
    }
  }
  if (flow.stage === 'S4' && excluded && options.acceptExcluded !== true) {
    const ids = (ledger.items ?? []).filter((item) => item.status === 'excluded').map((item) => item.id + '（' + (item.excludeReason || '未写明原因') + '）')
    throw new Error('另有 ' + excluded + ' 条验收标准标为环境受限、没有验证过：' + ids.join('、')
      + '。环境受限不是通过；接受它需要单独确认（acceptExcluded: true），否则请退回修复到能验证的环境。')
  }
  // 缺口靠「明确接受」这道动作区分，不靠用户打一段字：
  // 必填说明只会让人随手打「ok」，而缺口清单、计数与结束方式才是事后能核的东西。
  // 想写原因时 acceptanceNote 仍然会被记录。
  return { snapshot, ledger, gaps, unpassedPoints, pointCounts, excluded, unverifiedAngleIds: unverifiedAngles.map((angle) => String(angle?.id ?? '')) }
}

/**
 * 测试要点与验收标准是两套独立账本。
 * 一个方向可以 0 个失败要点，而它的验收标准一条都没通过——
 * 把两者合成一个数字，就会得出「失败 0 项」这种听起来没事的结论。
 */
/**
 * 自动门禁的阻塞项：返回空数组表示这一关没有需要人判断的东西，可以直接放行。
 * 判定只认清单与报告，不碰任何权限位——自动通过是少点几下，不是多给权限。
 */
function gateBlockers(flow, stage) {
  const items = stageGateBlockers(flow, stage)
  const pending = Array.isArray(flow.scopeCycle.pendingCommands) ? flow.scopeCycle.pendingCommands : []
  if (!pending.length) return items
  // 待补命令是跨阶段残留：任何一关的出口都先问清楚。
  // 只挂在 S2 出口的话，用户批准完 scope 走到 S2 才发现上一轮被拒的命令还挂着，
  // 而那时 Agent 已经按旧清单干了一轮活。
  if (stage === 'S1') {
    // 唯一例外是 S1：用户正要重写 scope，命令诉求不该抢在「还没有提交待冻结的 scope」前面，
    // 也不该让人以为不处理它就交不了件。队列跨轮保留（记的是用户想补的命令），
    // 但这里说明它是上一轮的遗留、可以先不管；进了 S2 再无条件问。
    return [
      ...items,
      '另有 ' + pending.length + ' 条上一轮被拒的变更性命令还没决定补不补：' +
        pending.map((entry) => entry.command).join('；') +
        '。它们与这份还没提交的 scope 无关，可以先不管；进 S2 前会再问一次。',
    ]
  }
  return [
    '有 ' + pending.length + ' 条被拒的变更性命令还没决定补不补：' +
      pending.map((entry) => entry.command).join('；') +
      '。补会退回 S1 让你重新批准 scope；不补则继续推进，这些命令之后仍然会被拒。',
    ...items,
  ]
}

/** 单看这一阶段自己的阻塞项；待补命令由 gateBlockers 统一加在前面。 */
function stageGateBlockers(flow, stage) {
  if (stage === 'S1') {
    const pending = flow.scopeCycle.draft
    if (!pending) return ['还没有提交待冻结的 scope']
    const readiness = scopeReadiness(
      pending.acceptance_criteria,
      pending.commands,
      pending.files_expected_to_change,
      {
        commandSources: pending.command_sources,
        project: projectProfile(flow.cwd),
        supplementedCommands: supplementedCommandList(flow),
      },
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

// ---------------------------------------------------------------------------
// 唤醒协议（G04）
//
// 叫醒一次等待只有两种合法形状：
//   { type: 'decision', decision } —— 用户做了决定，等待方据此往下走；
//   { type: 'signal',   signal   } —— 状态变了，等待方自己重判或收尾。
// wait() 自己产生的 timeout / aborted / superseded 不在此列：它们不是外部注入的值。
//
// 安全方向是「看不懂就报错」。旧实现把不认识的值原样透传给 Agent，
// 而 decideDoc 又把一切非 revise 当成批准——一次接错线就变成一次真的冻结。
// ---------------------------------------------------------------------------

/** 每种等待能收到的决定值。不在表里 = 这次唤醒根本不该发到这个等待器上。 */
const WAKE_DECISIONS = {
  doc: new Set(['approve', 'revise', 'skip']),
  gate: new Set(['pass', 'skip', 'back', 'accept-risk']),
  answer: new Set(['answer']),
}

/** 信号白名单：前两个重判后继续等，后两个交回调用方并给出明确指令。 */
const WAKE_SIGNALS = new Set(['mode-changed', 'commands-decided', 'scope-reopened', 'cancelled'])
const RESIGNALS = new Set(['mode-changed', 'commands-decided'])

function wakeShapeError(outcome, expectKind) {
  return new Error(
    '门禁唤醒值非法：' + expectKind + ' 等待器收到 ' + JSON.stringify(outcome ?? null) +
    '。合法形状只有 { type: "decision", decision } 与 { type: "signal", signal }。' +
    '这个值不会被执行，也不会被当成通过——请检查发出唤醒的那一处。',
  )
}

/**
 * 把一次唤醒归一化成 { kind, ... }。
 *
 * 这里是唯一入口：四个门禁工具与追问工具都从这里拿到结果，
 * 因此「不认识的值」在这里就被拦住，不会再流到任何一个 if 链的兜底分支里。
 */
function normalizeWake(outcome, expectKind) {
  if (!outcome || typeof outcome !== 'object') throw wakeShapeError(outcome, expectKind)
  // 中断由 wait() 自己产生，不是外部注入：原样交回，由调用方走「停下来」那一支。
  if (outcome.kind === 'timeout' || outcome.kind === 'aborted' || outcome.kind === 'superseded') {
    return { kind: outcome.kind }
  }
  const carried = {
    ...(typeof outcome.choiceIndex === 'number' ? { choiceIndex: outcome.choiceIndex } : {}),
    ...(typeof outcome.customText === 'string' ? { customText: outcome.customText } : {}),
    ...(Array.isArray(outcome.supplemented) ? { supplemented: outcome.supplemented } : {}),
    ...(Array.isArray(outcome.declined) ? { declined: outcome.declined } : {}),
    ...(typeof outcome.remaining === 'number' ? { remaining: outcome.remaining } : {}),
    ...(typeof outcome.to === 'string' ? { to: outcome.to } : {}),
    ...(typeof outcome.note === 'string' && outcome.note ? { note: outcome.note } : {}),
  }
  if (outcome.type === 'decision') {
    const allowed = WAKE_DECISIONS[expectKind]
    if (!allowed) throw wakeShapeError(outcome, expectKind)
    if (!allowed.has(outcome.decision)) {
      throw new Error(
        '门禁唤醒值非法：' + expectKind + ' 等待器收到决定 ' + String(outcome.decision) +
        '，它只认 ' + [...allowed].join(' / ') + '。这个值不会被当成通过。',
      )
    }
    return { kind: outcome.decision, ...(outcome.applied === true ? { applied: true } : {}), ...carried }
  }
  if (outcome.type === 'signal') {
    if (!WAKE_SIGNALS.has(outcome.signal)) throw wakeShapeError(outcome, expectKind)
    return { kind: outcome.signal, ...carried }
  }
  throw wakeShapeError(outcome, expectKind)
}

/**
 * 把等待期间发生的「用户补了 / 不补」翻译成一句给 Agent 的话。
 *
 * 这些事在界面上早就写清楚了（CommandGapDecision 的说明文案），
 * 但只写给了用户看——Agent 那边一个字都没有，于是它要么不知道，
 * 要么按自己的猜测去试一条已经被明确否掉的命令。
 */
function wakeNotesText(notes) {
  const list = Array.isArray(notes) ? notes : []
  const supplemented = [...new Set(list.flatMap((item) => item.supplemented ?? []))]
  const declined = [...new Set(list.flatMap((item) => item.declined ?? []))]
  let text = ''
  if (supplemented.length) {
    text += '\n等待期间用户把这几条命令补进了 scope 清单：' + supplemented.join('、') +
      '。scope 已按新清单批准，这些命令可以直接用。'
  }
  if (declined.length) {
    text += '\n等待期间用户明确不批这几条命令：' + declined.join('、') +
      '。之后不要再用它们，相关验收标准按未覆盖处理，不要反复尝试。'
  }
  return text
}

/**
 * 门禁请求被中断时的统一口径。
 * 关键在「停下来」这三个字：按钮仍然可点是为了不剥夺用户确认的权利，
 * 不是因为 Agent 可以自己往下做——它一边跑、用户一边批，就成了用户自顾自批准。
 */
function gateWaitNote(reason, extra) {
  const request = extra?.request ?? null
  const label = reason === 'timeout'
    ? '等待超时（等满了配置的上限）'
    : reason === 'superseded'
      ? '被新的等待取代'
      : reason === 'aborted'
        ? '调用被取消'
        : '被中断（工具调用超时或宿主重启）'
  // 门禁 id 必须念出来：重启之后 Agent 只有靠它才能说清「上次等的是哪一关」。
  const id = request?.id ? '这次等待的门禁 id 是 ' + request.id + '。' : ''
  // 「会不会被叫醒」取决于有没有等待器，不能一律承诺收到唤醒消息——
  // 那正是 G35：用户点了、Agent 却一直等一条永远不会来的消息。
  const tail = extra?.willWake === true
    ? '用户点了按钮之后你会收到一条唤醒消息，届时读取 flowgate_status 看最新状态再继续。'
    : '现在没有等待器挂着：用户点了按钮只会记录决定，不会叫醒你。不要再调用同一个门禁工具空等，'
      + '停下来等用户发消息；也可以调用 flowgate_status 看 waiting 字段确认门禁是否还开着。'
  // 产物在挂起之前就已经 persist 了：中断只砍在「等」这一段。
  // 这句话不写进返回值，Agent 就会以为没交上去，重跑一遍把上一份覆盖掉。
  return '门禁请求' + label + '了，用户仍可在工作台点按钮。' + id + submissionSentence(extra?.submission)
    + '现在停下来等确认：不要继续做后续阶段的工作，也不要假设已经通过。' + tail
}

/**
 * 「本阶段产物已经落盘」这一句。
 *
 * G35 的残留就在这里：报告先落盘（flow.review / flow.test / devChanges）、再挂起等门禁，
 * 中断只砍在「等」这一段。返回值里只有「等被中断」，Agent 读不出「交」成功没有，
 * 于是重跑一遍——而提交是整体赋值，重跑既覆盖上一份结论，又白烧一轮。
 * 所以中断返回值必须自带凭据：交了什么、id 是多少、接下来不该再做什么。
 */
function submissionSentence(submission) {
  if (!submission || typeof submission !== 'object' || !submission.label) return ''
  const id = typeof submission.id === 'string' && submission.id ? '（id ' + submission.id + '）' : ''
  const detail = typeof submission.detail === 'string' && submission.detail ? '，' + submission.detail : ''
  const tool = typeof submission.tool === 'string' && submission.tool ? '，也不要再调用 ' + submission.tool : ''
  return '本阶段的' + submission.label + '已经提交并保存' + id + detail + '：这次不需要重新提交' + tool
    + '——重跑会覆盖这份产物，并白烧一轮。'
}

/**
 * 两份提交内容是否完全相同。
 *
 * 相同就不覆盖：中断之后的重跑多半就是这种——它以为没交上去，报告其实早就在盘上了。
 * 内容真的改过（补了发现、重跑了测试）才允许覆盖，那是修正，不是重复。
 */
function sameSubmission(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** 同一份回执的结构化版本：给 output schema 用，Agent 不用从文案里抠。 */
function submissionPayload(submission) {
  if (!submission || typeof submission !== 'object' || !submission.label) return null
  return {
    kind: typeof submission.kind === 'string' ? submission.kind : '',
    label: typeof submission.label === 'string' ? submission.label : '',
    id: typeof submission.id === 'string' ? submission.id : '',
    detail: typeof submission.detail === 'string' ? submission.detail : '',
  }
}

/**
 * 门禁等待中断时四个工具共用的返回字段。
 *
 * gateId 取自落盘的请求记录（重启后仍然读得到），不是临时生成——
 * 临时 id 一重启就断，Agent 下次问「刚才等的是哪一关」还是答不上来。
 * willWake 读实时等待器：没有等待器时用户点按钮只会记录决定，不会唤醒 Agent。
 */
function gateWaitPayload(outcome, submission) {
  // 只收中断分支：awaitGate 已把 timeout / aborted / superseded 归一化成同名 kind，
  // 四个调用点的分支条件与此一一对应。其他 kind 走到这里就是调用方接错了线，
  // 当场报错，不要静默编出一个 payload。
  if (!outcome || (outcome.kind !== 'timeout' && outcome.kind !== 'aborted' && outcome.kind !== 'superseded')) {
    throw new Error('gateWaitPayload 只处理等待被中断的结果（timeout / aborted / superseded），收到的是 ' + ((outcome && outcome.kind) ?? String(outcome)) + '。')
  }
  // 这次等待自己的请求必须由 awaitGate 附在结果的 self 上（唯一写入点）：
  // 被取代时盘上的 gateRequested 已经是取代者的新请求，读盘会拿错 id——
  // self 缺失就是契约被破坏，直接报错，不能回退读盘或静默给 null。
  const request = outcome.self
  if (!request || typeof request !== 'object' || typeof request.id !== 'string') {
    throw new Error('等待结果没有携带 outcome.self（awaitGate 是唯一写入点）：无法确定这次等待自己的门禁 id。')
  }
  // willWake 说的是「用户点按钮会叫醒收到这条文案的这次等待」：中断分支里这次
  // 等待都已经收尾，等待器即使还挂着也属于取代者的那次调用——一律 false。
  // 不读会话级 has()：被取代时它会念出「你会收到唤醒消息」这句假话。
  const willWake = false
  return {
    waitReason: outcome.kind,
    willWake,
    gateId: request.id,
    // 交了什么必须跟着返回值走：这是 Agent 判断「要不要重跑一遍」的唯一依据。
    submitted: submissionPayload(submission),
    note: gateWaitNote(outcome.kind, { request, willWake, submission }),
  }
}

/**
 * 本阶段产物交了没有。
 *
 * 门禁等待被中断后，Agent 能查到的只有「门禁还开着」——那既可能是「没交」，
 * 也可能是「交了、没人点」。这一行把两种状态分开念，重跑之前先看一眼就够了。
 */
function stageArtifactLine(flow) {
  if (flow.stage === 'S1') {
    if (!flow.doc) return ''
    return '本阶段产物：需求文档已提交（' + (flow.doc.at ?? '时间未知') + '），scope '
      + (flow.scope?.frozen ? '已冻结' : '未冻结') + '。'
  }
  if (flow.stage === 'S2') {
    if (!flow.snapshot) return ''
    return '本阶段产物：开发摘要已提交（快照 ' + flow.snapshot.id + '）。'
  }
  if (flow.stage === 'S3') {
    if (!flow.review) return ''
    return '本阶段产物：评审报告已提交（id ' + flow.review.id + '，阻塞 ' + flow.review.blocking + ' 条）。'
  }
  if (flow.stage === 'S4') {
    if (!flow.test) return ''
    return '本阶段产物：测试报告已提交（快照 ' + (flow.test.snapshot?.id ?? '未知') + '，失败 ' + flow.test.failed + ' 条）。'
  }
  return ''
}

/** 本阶段还没有可确认的产物：挂起只会让 Agent 等一个不会出现的按钮。 */
function gateNoArtifactNote(flow) {
  const need = flow.stage === 'S3' ? '评审报告（flowgate_review）' : flow.stage === 'S4' ? '测试报告（flowgate_test）' : '本阶段的产物'
  return '当前在 ' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '），还没有提交' + need + '，门禁按钮不会出现。' +
    '先把本阶段的产物交上来，再调用 flowgate_wait 等签收。'
}

/** 用户在中断窗口里已经点过：这次等待不该再挂起，否则等的是一个不会来的按钮。 */
function gateStaleNote(flow) {
  if (flow.finished) return '这次流程已经结束了：用户已在门禁上确认过。不要再调用门禁工具，也不要继续往下一阶段做。'
  return '本阶段门禁已经由用户确认过，当前在 ' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）。' +
    '不要再等一次确认：读取 flowgate_status 看最新状态，直接开始当前阶段的工作。'
}

/**
 * 门禁等待的统一入口：auto 模式没有阻塞项就直接放行，manual 模式挂起等用户。
 * 用户中途切模式会唤醒这里（mode-changed），醒来重判一次，所以是个循环。
 * 自动放行返回的形状与客户端点按钮完全一致，下游分支不需要区分两种来源。
 */
async function awaitGate(service, flow, sessionId, kind, exec, expectedStage, reuse) {
  // 等待期间收到的「重判类」信号（切模式、待补命令被决定）不能读完就扔：
  // 用户点过的东西要跟着最终结果一起交出去，否则 Agent 永远不知道发生过什么。
  const notes = []
  for (;;) {
    // 用户可能在等待器消失的时间窗里点过按钮：阶段已经推进，或者本阶段门禁已经决策。
    // 这时候再挂起，等的是一个永远不会再来的按钮——Agent 会一直卡到工具超时。
    // 交回调用方：它不该再等，也不该再往本阶段写产物。
    const record = flow.stages[flow.stage]
    if ((expectedStage && flow.stage !== expectedStage) || (record && record.gate !== 'pending')) {
      return { kind: 'stale', stage: flow.stage, gate: record?.gate ?? 'pending' }
    }
    if (flow.gateMode === 'auto') {
      const blockers = gateBlockers(flow, flow.stage)
      if (!blockers.length) {
        flow.autoPassed = { ...(flow.autoPassed ?? {}), [flow.stage]: { at: nowIso(), snapshot: currentSnapshot(flow).id } }
        flow.gateBlockers = null
        appendEvent(flow.cwd, flow, 'gate.auto_passed', { stage: flow.stage })
        persist(flow)
        // S1 的放行值是 approve，其余是 pass：与工作台按钮发出的值同义。
        // 形状用内部的 kind（不是投递形状的 type/decision）：awaitGate 之后
        // 一律是 kind，投递形状只活在 gates.wait 那一层边界上。
        // applied 为 false——状态还没落盘，消费端照常执行 passGate；
        // auto 标记是给消费端认的「这次不是外部唤醒」，不是给状态机看的。
        return flow.stage === 'S1'
          ? { kind: 'approve', applied: false, auto: true }
          : { kind: 'pass', applied: false, auto: true }
      }
      // 停下来时把阻塞项写进流程：界面要能回答「为什么这次没自动过」。
      flow.gateBlockers = { stage: flow.stage, items: blockers }
    }
    const request = markGateRequested(flow, kind, reuse)
    // 上限走工作区配置（默认 10 分钟）：0 = 永不超时正是这条流程要修的永久悬挂，
    // 所以这里不能再传 0——超时上限的规范化只发生在配置层，入口处不接受关闭。
    const outcome = await service.gates.wait(sessionId, kind, service.gateWaitMs(flow), exec?.signal)
    // 外部注入的值必须先过协议：不认识就当场抛错，绝不当成通过。
    // 这一步之后，wake.kind 一定在白名单里，下面的分支是穷尽的。
    const wake = normalizeWake(outcome, kind)
    // 重判类信号：状态可能变了（待补队列空了、门禁模式切了），重判一次再决定要不要继续等。
    if (RESIGNALS.has(wake.kind)) {
      notes.push(wake)
      continue
    }
    // 「用户补了命令」会退回 S1：门禁等待器等的那个阶段已经不存在了，必须交回调用方，
    // 否则它会在循环顶部撞上 stale，被念成「用户已经确认过了」。
    // 文档等待器相反：文档已保留、scope 还没批准，它该在原地继续等用户点批准。
    if (wake.kind === 'scope-reopened') {
      if (kind === 'doc') {
        notes.push(wake)
        continue
      }
      wake.notes = notes
      return wake
    }
    // 等待器没了（超时/取消/被取代）但请求确实发生过：只标收尾，不清空记录，
    // 否则界面会回到「pending 且未中断」，把「没提交」与「提交了但没人点」合并成一件事。
    if (wake.kind === 'timeout' || wake.kind === 'aborted' || wake.kind === 'superseded') {
      endGateRequest(flow, wake.kind, request?.id)
    }
    // 契约（gateWaitPayload 与本函数共同遵守，不是临时技巧）：
    // gates.wait 的每个工具侧结果都带 outcome.self = 这次等待自己的请求记录。
    // 被取代时盘上的 gateRequested 已经是取代者的新请求，调用方回头读盘会拿错
    // id——必须从这里带出去。awaitGate 是唯一写入点，gateWaitPayload 是唯一消费点。
    wake.self = request
    wake.notes = notes
    return wake
  }
}

/**
 * 交件的收尾：产物已经落盘，这里只负责开闸，然后立刻把「已提交」交回去。
 *
 * G35 的根因是「交件」与「等签收」两种失败语义塞在同一个返回值里：等待被中断时，
 * Agent 分不清是「没交成」还是「交了但没人点」，于是重跑一遍交件、覆盖掉上一份产物。
 * 拆开之后，交件这一步根本不等——它没有中断可言，重跑也就失去了理由。
 */
function submitGate(flow, kind, submission, extra) {
  const request = markGateRequested(flow, kind)
  const payload = submissionPayload(submission)
  return {
    ...extra,
    decision: 'submitted',
    ...(payload ? { submitted: payload } : {}),
    ...(request?.id ? { gateId: request.id } : {}),
    message:
      '本阶段的' + (submission.label ?? '产物') + '已经提交并保存（id ' + (submission.id || '无') + '）。' +
      '门禁已经打开，用户现在就能在工作台点按钮。' +
      '接下来调用 flowgate_wait 等签收：不要重复提交这份产物，也不要先做下一阶段的工作——' +
      '用户点完按钮，结果会由 flowgate_wait 带回来。',
  }
}

/**
 * 卡住说明：念清哪几条 AC、卡了几轮。
 *
 * 判据是 AC 的 id 集合，不是「id + 状态」拼出来的签名——后者既分不开「换了一批缺口」，
 * 又会因为状态抖一下就重数，两头都判不准（G20）。
 */
function stallStatusText(status) {
  const text = { pending: '待验证', pass: '通过', fail: '未通过', uncovered: '未覆盖', excluded: '环境受限' }[status]
  return text ?? (status ? String(status) : '未通过')
}

function stallNote(flow) {
  const stall = flow.testStall
  if (!stall || !Array.isArray(stall.gaps) || !stall.gaps.length) return ''
  // 这段文本会直接显示在工作台上，状态写英文码等于让用户自己翻译。
  const detail = stall.gaps.map((id) => id + '（' + stallStatusText(stall.statuses?.[id]) + '）').join('、')
  return '这些验收标准已连续 ' + stall.streak + ' 轮退回仍没通过：' + detail
}

/**
 * S1 推导命令清单时能读到的项目事实：只读，不猜。
 * 体检用它判断「这条命令在这个仓库里到底跑不跑得起来」——写错脚本名比清单为空更糟：
 * 清单为空时用户至少知道要授权，写错的脚本名会在 S2 第一次跑构建时就炸。
 */
function projectProfile(cwd) {
  const profile = { hasPackageJson: false, scripts: {}, testRunners: [], hasTsConfig: false, hasMakefile: false, ecosystems: [], resolveExecutable: null }
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
  // 生态登记：仓库里出现了哪个生态的标志文件，体检才去核对它的可执行文件。
  // 空目录里写 `node test/x.mjs` 本来就无从判断，跳过比误报更有用。
  let entries = []
  try { entries = readdirSync(cwd) } catch { entries = [] }
  profile.ecosystems = declaredEcosystems(entries)
  // PATH 就是 shell 子进程继承的那一份：宿主进程能解析到的可执行文件，shell 里才跑得起来。
  // 这是本轮踩坑的根因——原来的体检只问「这个 npm script 名存在吗」，
  // 从不问「这个可执行文件在这台机器上有没有」，于是裸 node 一路通过 S1，到 S2 才 127。
  const pathDirs = String(process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
  const pathext = String(process.env.PATHEXT ?? '').split(';').filter(Boolean)
  const resolved = new Map()
  profile.resolveExecutable = (token) => {
    const key = String(token ?? '').trim()
    // cwd 一起传：清单里的 `./gradlew` 这类相对路径要相对仓库根解析，不能按宿主进程 cwd。
    if (!resolved.has(key)) resolved.set(key, resolveExecutable(key, { cwd, platform: process.platform, pathDirs, pathext }))
    return resolved.get(key)
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
  return '验收标准 ' + (ac.pass ?? 0) + ' 通过 / ' + (ac.fail ?? 0) + ' 未通过 / ' + (ac.uncovered ?? 0) + ' 未覆盖 / ' + (ac.excluded ?? 0) + ' 环境受限（共 ' + (ac.total ?? 0) + ' 条），'
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
    return '流程已结束：带缺口结束（用户明确接受未通过/未覆盖/环境受限项）——验收标准 '
      + (counts.pass ?? 0) + ' 通过 / ' + (counts.fail ?? 0) + ' 未通过 / ' + (counts.uncovered ?? 0) + ' 未覆盖 / ' + (counts.excluded ?? 0) + ' 环境受限（共 ' + (counts.total ?? 0) + ' 条），测试要点 '
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
    // 跳过是用户的权力，但「跳过了哪些全未核实的角度」必须留在快照里：
    // 否则「评审被跳过」和「评审通过了」在事后读起来一样干净。
    const skippedUnverified = Array.isArray(validation?.unverifiedAngleIds) ? validation.unverifiedAngleIds.filter(Boolean) : []
    if (flow.stage === 'S3' && skippedUnverified.length) {
      flow.review = { ...(flow.review ?? {}), skippedUnverified }
    }
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
  if (next === null) {
    flow.finished = true
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
      if (finding?.severity === 'MINOR' || finding?.unverified === true) continue
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
  return { ac, acMatched, fileInScope, blocking: finding?.severity !== 'MINOR' && acMatched && fileInScope && finding?.unverified !== true }
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
  return { reusable: reusableIds, reports: pool.map((entry) => {
    const reused = { ...entry, reused: true }
    if (key === 'angles') delete reused.verdictConflict
    return reused
  }), ids: [...reusableIds] }
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
    const reusedAngle = { ...angle, reused: true }
    delete reusedAngle.verdictConflict
    angles.push(reusedAngle)
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

/** 退回原因的中文说法：审计、状态摘要、工作台三处都用这一份，避免各写各的。 */
const ROLLBACK_REASON_TEXT = {
  user: '用户手动退回',
  'test-rejected': '测试未通过',
  'review-rejected': '评审未通过',
  'scope-commands-missing': '命令清单缺失',
}

/**
 * 记一笔退回。只增不减，跨回退累积——回退到 S1 会清 scope、清产物，
 * 但「这条流程被退回几次」是流程级事实，不该跟着一起清零。
 */
function noteRollback(flow, to, reason) {
  const counts = flow.rollbacks && typeof flow.rollbacks === 'object' && !Array.isArray(flow.rollbacks)
    ? flow.rollbacks
    : { total: 0, byReason: {}, skipped: 0, last: null }
  const byReason = counts.byReason && typeof counts.byReason === 'object' && !Array.isArray(counts.byReason) ? counts.byReason : {}
  const key = typeof reason === 'string' && reason ? reason : 'unknown'
  flow.rollbacks = {
    total: (Number.isSafeInteger(counts.total) ? counts.total : 0) + 1,
    byReason: { ...byReason, [key]: (Number.isSafeInteger(byReason[key]) ? byReason[key] : 0) + 1 },
    skipped: Number.isSafeInteger(counts.skipped) ? counts.skipped : 0,
    last: { to, reason: key, at: nowIso() },
  }
}

/** 被幂等拦下的重复退回：状态没动，所以不计入 total，但要能看出「按钮被点重了」。 */
function noteRollbackSkipped(flow) {
  const counts = flow.rollbacks && typeof flow.rollbacks === 'object' && !Array.isArray(flow.rollbacks) ? flow.rollbacks : null
  if (!counts) return
  flow.rollbacks = { ...counts, skipped: (Number.isSafeInteger(counts.skipped) ? counts.skipped : 0) + 1 }
}

/** 「已退回 N 次（测试未通过 2 · 评审未通过 1）」；一次都没退过时返回空串，不占版面。 */
function rollbackSummaryLine(flow) {
  const counts = flow.rollbacks
  if (!counts || !Number.isSafeInteger(counts.total) || counts.total <= 0) return ''
  const parts = Object.entries(counts.byReason ?? {})
    .filter(([, n]) => Number.isSafeInteger(n) && n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => (ROLLBACK_REASON_TEXT[reason] ?? reason) + ' ' + n)
  return '本流程已退回 ' + counts.total + ' 次' + (parts.length ? '（' + parts.join(' · ') + '）' : '')
}

/** 回退到某一阶段重做；只重置受影响的阶段，已通过阶段的产物保留下来供复用。 */
function rollbackTo(flow, stage, reason, note = '') {
  // 退回可能被触发两次：门禁工具被中断后补发的排队消息、或用户在按钮上连点。
  // 同一目标阶段的重复退回会清掉刚重做的产物，所以短时间内同因同目标的第二次调用只留事件、不再动手。
  // 只有「已经在目标阶段」时的第二次退回才是重复信号；已经推进到别的阶段再退回是正常操作。
  const lastRollback = flow.lastRollback
  if (flow.stage === stage && lastRollback && lastRollback.to === stage && Date.now() - lastRollback.at < 10000) {
    appendEvent(flow.cwd, flow, 'flow.rollback.skipped', { to: stage, reason })
    noteRollbackSkipped(flow)
    return
  }
  // 同一个缺口连着退回两轮还在，第三轮大概率也一样：这不是 Agent 不努力，
  // 而是这条 AC 靠改代码修不好（环境测不了，或验收方法本身不成立）。
  // 这时只有改 scope 或接受缺口两条路，所以改道 S1——别让人在同一个循环里烧 token。
  // 兜底认「从 S4 退回 S2」这件事本身：调用方少给一次 reason，也不该让卡住判定整条失效。
  if (stage === 'S2' && (reason === 'test-rejected' || flow.stage === 'S4')) {
    const stall = testStall(acceptanceOf(flow), flow.testStall)
    if (!stall) flow.testStall = null
    else {
      flow.testStall = { ...stall, at: nowIso() }
      if (stall.streak >= TEST_STALL_LIMIT) {
        appendEvent(flow.cwd, flow, 'flow.rollback.redirected', { from: 'S2', to: 'S1', repeats: stall.streak, gaps: stall.gaps })
        // 改道不是判死，是把决定权交回给人：回 S1 改完 scope 就重新从第一轮数起。
        // 不重置的话，回来第一次退回就是 streak = 4，立刻又被扔回 S1——补救路径等于只给一次机会。
        // 但「被扔回来几次」要留着：同一批 AC 反复改不好，复盘时才看得见。
        flow.testStall = { ...flow.testStall, streak: 1, redirects: (flow.testStall.redirects ?? 0) + 1, redirectedAt: nowIso() }
        stage = 'S1'
      }
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
    // 换一轮就等于换掉整块状态（G21）：缺口记录、连续退回次数、补录申请都是
    // 「同一份方案」的账，留着会让新方案背着旧账——门禁追问一条早就不存在的问题，
    // 连续退回计数还会把新方案直接判成 AI 卡死。
    // 只有两个队列跨轮活着：它们记的是「用户想解决什么」和「用户拒绝过什么」，
    // 与方案内容无关，且都会在冻结时按新清单一并对账出队，不会变成死路。
    const prev = flow.scopeCycle
    flow.scopeCycle = {
      ...emptyScopeCycle(nextScopeEpoch(prev)),
      pendingCommands: Array.isArray(prev?.pendingCommands) ? prev.pendingCommands : [],
      declinedCommands: Array.isArray(prev?.declinedCommands) ? prev.declinedCommands : [],
    }
  }
  flow.lastRollback = { to: stage, reason, at: Date.now() }
  noteRollback(flow, stage, reason)
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
  // 放弃之后不该再有任何白名单：命令清单只看 frozen，解冻即失效。
  // 但 scope.data 要留着：验收账本按 acceptance_criteria 计数，抹掉它会让
  // 一条 12 项全未覆盖的流程在放弃后显示成「0 条 · 验收通过」。
  flow.scope = { ...(flow.scope ?? {}), frozen: false, frozenAt: null, withoutDocApproval: false }
  // 流程结束等于这一轮彻底作废：连同待补/已拒队列一起清掉。
  // 留着它们没有第二轮可对账，只会在重开同名流程时把上一条的旧账带出来。
  flow.scopeCycle = emptyScopeCycle(flow.scopeCycle?.epoch ?? 1)
  appendEvent(flow.cwd, flow, 'flow.cancelled', { stage: flow.stage, reason: flow.cancelReason })
  persist(flow)
}

/**
 * 工具层的第一道闸：流程结束后（验收通过或用户放弃）不再受理任何推进。
 *
 * 只有 flowgate_gate 查过 finished，其余工具只查阶段，于是「放弃后 Agent 还在追问
 * 需求」成了真事：状态已经判死，追问却照样弹出卡片、照样能提交文档。
 */
function queuedCommandKey(entry) {
  return JSON.stringify([entry.command, compareKey(entry.dir ?? '.'), entry.cwd ?? null, entry.directoryError ?? null, entry.truncated === true])
}

/** 旧客户端传命令文本时，该文本必须唯一对应队列中的一个条目。 */
function resolveChosenCommands(queued, wanted) {
  if (wanted == null) return queued.slice()
  if (!Array.isArray(wanted) || !wanted.length) throw new Error('至少要勾选一条待补命令。')
  const chosen = new Set()
  for (const text of wanted) {
    if (typeof text !== 'string') throw new Error('待补命令选择格式无效。')
    const keyed = queued.find((entry) => queuedCommandKey(entry) === text)
    const matches = keyed ? [keyed] : queued.filter((entry) => (
      entry.command === text || scopeCommandEntry(entry.command, entry.dir) === text
    ))
    if (matches.length !== 1) throw new Error('请选择待补清单中可唯一识别的命令及目录。')
    chosen.add(matches[0])
  }
  return [...chosen]
}

/**
 * 「补」：把用户勾选的待补命令并进 scope 草稿，退回 S1 等重新批准。
 *
 * manual 模式停在这里，等用户点「批准并冻结 scope」——scope 变了就必须再过一个人的眼睛，
 * 这是整套权限模型的地基，不能因为「只是加了一条命令」就跳过。
 *
 * auto 模式在没有新的验收方案缺口时直接冻结回 S2：用户选 auto 就是不想要每一步都点，
 * 这里悄悄改回 manual 等于替他改了设置。有缺口时停在 S1，让 gateBlockers 把缺口摊出来。
 *
 * @returns {{frozen: boolean, commands: string[], remaining: number}}
 */
/**
 * 冻结时把两个队列按新清单一并对账（G21）。
 *
 * 这两个队列跨轮保留——它们记的是「用户想解决什么」和「用户已经拒绝过什么」，
 * 与方案内容无关。但命令一旦进了新清单，那条诉求就已经被满足、那条拒绝也已经过期：
 * 不在这里出队，门禁会一直追问一条早就不存在的问题，用户点「补」还会撞上
 * 「这些命令已经在 scope 清单里了，不需要再补」——那是一条没有出口的死路。
 */
function reconcileScopeQueues(flow, frozen) {
  const commands = new Set(Array.isArray(frozen?.in_scope?.commands) ? frozen.in_scope.commands : [])
  const stillPending = (entry) => {
    const text = scopeCommandEntry(entry?.command, entry?.dir ?? '.')
    // 拼不出清单条目（目录非法、命令超长）时保守保留：宁可多问一次，也别悄悄丢用户的诉求。
    return text === null || !commands.has(text)
  }
  flow.scopeCycle.pendingCommands = (flow.scopeCycle.pendingCommands ?? []).filter(stillPending)
  flow.scopeCycle.declinedCommands = (flow.scopeCycle.declinedCommands ?? []).filter(stillPending)
}

function supplementScopeCommands(service, flow, sessionId, wanted) {
  if (flow.finished) throw new Error('流程已经结束，不能再补命令清单。')
  const queued = Array.isArray(flow.scopeCycle.pendingCommands) ? flow.scopeCycle.pendingCommands : []
  if (!queued.length) {
    throw new Error('当前没有待补的命令：补清单只能从门禁上的待补提醒进入，没有「顺手加一条」的旁路。')
  }
  const selected = resolveChosenCommands(queued, wanted)
  const chosen = selected.map((entry) => {
    const text = scopeCommandEntry(entry.command, entry.dir)
    if (entry.directoryError || !text || entry.truncated || SHELL_MULTILINE.test(entry.command)) {
      throw new Error('无法补录执行目录 ' + (entry.dir ?? '未知') + ' 的命令。' +
        (entry.directoryError ?? '命令或目录无法完整写入清单。'))
    }
    const directory = executionDirectory(flow.cwd, resolve(flow.cwd, entry.dir))
    if (directory.error || (entry.cwd && compareKey(directory.cwd) !== compareKey(entry.cwd))) {
      throw new Error('无法补录执行目录 ' + entry.dir + ' 的命令。' + (directory.error ?? '目录已变更。'))
    }
    return text
  })
  // 草稿从冻结 scope 抄回来：退回 S1 会解冻 scope 并整块重置这一轮的作业状态，
  // 不先抄就只剩一份空清单。抄到的是局部变量，下面 rollbackTo 换轮也不会把它带走。
  const frozenScope = flow.scope?.data ?? null
  const draft = flow.scopeCycle.draft ?? (frozenScope ? pendingScopeFromFrozen(frozenScope) : null)
  if (!draft) throw new Error('当前还没有 scope 草稿，先让 Agent 提交需求文档与 scope。')
  const commands = Array.isArray(draft.commands) ? draft.commands.slice() : []
  const fresh = [...new Set(chosen)].filter((command) => !commands.includes(command))
  if (!fresh.length) throw new Error('这些命令已经在 scope 清单里了，不需要再补。')
  if (commands.length + fresh.length > SCOPE_COMMAND_MAX) {
    throw new Error('命令清单最多 ' + SCOPE_COMMAND_MAX + ' 条，请先删掉不再需要的条目。')
  }
  for (const command of fresh) commands.push(command)
  const from = flow.stage
  // 补录申请单（G41）：现场由系统记下来，举证留给 Agent 重新提交时用 AC 引用补上。
  // 只加不覆盖：同一个门禁上连着补两批时，第一批的现场不能被第二批冲掉。
  // 去重只看本次这一批：上一轮的申请单属于上一轮，不能拿来挡新申请。
  // 换轮之后要用的清单在下面合并时现取（rollbackTo 会把它们整块换掉）。
  let existingRequests = []
  const requests = []
  for (const entry of selected) {
    const entryText = scopeCommandEntry(entry.command, entry.dir)
    if (!fresh.includes(entryText)) continue
    if (existingRequests.some((old) => old.entry === entryText) || requests.some((old) => old.entry === entryText)) continue
    requests.push({
      command: entry.command,
      dir: entry.dir,
      cwd: entry.cwd ?? null,
      entry: entryText,
      deniedStage: entry.stage ?? null,
      deniedAt: entry.at ?? null,
      deniedBecause: entry.reason ?? '',
      context: entry.context ?? '',
      addedAt: Date.now(),
    })
  }
  // 文档内容没变，只有清单要补：退回后保留原文，用户核对完直接重新批准即可。
  const savedDoc = flow.doc ?? null
  if (from !== 'S1') rollbackTo(flow, 'S1', 'scope-commands-missing', '命令清单缺少：' + fresh.join('、'))
  // 申请单必须写在 rollbackTo 之后：退回 S1 会把这一轮的作业状态整块换掉（G21），
  // 先写后换等于自己把自己的现场清掉，Agent 重新提交时就没了举证依据。
  existingRequests = Array.isArray(flow.scopeCycle.requests) ? flow.scopeCycle.requests : []
  flow.scopeCycle.requests = [
    ...existingRequests,
    ...requests.filter((item) => !existingRequests.some((old) => old.entry === item.entry)),
  ]
  if (savedDoc?.html) {
    // 保留文档、清掉已批准标记：界面据此重新显示「批准并冻结 scope」。
    flow.doc = { html: savedDoc.html, recommendedPreset: savedDoc.recommendedPreset ?? null, reason: savedDoc.reason ?? null, at: savedDoc.at ?? null }
  }
  flow.scopeCycle.draft = { ...draft, commands }
  flow.scopeCycle.dropped = []
  // 旧结论作废，但要按新清单重算，不能直接归零：补一条命令不会让
  // 「验证步骤点名 scope 外文件」这类缺口消失，归零会让界面以为没缺口，
  // 用户一点批准又被拒——和 decideDoc 的回填是同一个死循环的两半。
  const reopened = scopeReadiness(
    flow.scopeCycle.draft.acceptance_criteria,
    flow.scopeCycle.draft.commands,
    flow.scopeCycle.draft.files_expected_to_change,
    {
      commandSources: flow.scopeCycle.draft.command_sources,
      project: projectProfile(flow.cwd),
      // 刚补进来的命令还没人作证：这里就要报出来，否则自动模式会替用户放行一份没人验证过的授权。
      supplementedCommands: supplementedCommandList(flow),
    },
  )
  flow.scopeCycle.risks = reopened.risks
  // 用户主动补了一条命令：这是给 Agent 的一次新机会，退回计数从这里重新起算，
  // 否则「补命令 → 重新提交 → 被拒」会把流程直接推到自动结束。
  flow.scopeCycle.strikes = null
  flow.scopeCycle.riskLast = []
  // 补过的出队；没勾选的留着，门禁上还会再问一次。
  flow.scopeCycle.pendingCommands = queued.filter((entry) => !selected.includes(entry))
  appendEvent(flow.cwd, flow, 'scope.command_supplemented', {
    commands: fresh,
    from,
    risksAfter: reopened.risks.length,
    // 申请单也要留痕：事后追「这条命令是谁在什么情况下补的」不能只靠内存快照。
    requests: requests.map((entry) => ({ command: entry.command, dir: entry.dir, deniedStage: entry.deniedStage })),
    auto: false,
  })
  persist(flow)
  // 挂着的等待要醒过来：阶段已经退回 S1，门禁等的那个按钮不会来了。
  // 两种等待器分别发一次（同一会话只有一个等待器，只有对得上的那个会收到）：
  // 门禁等待器交回调用方，文档等待器继续在原地等用户点批准——文档正文还在，不用重交。
  const reopenedWake = {
    type: 'signal',
    signal: 'scope-reopened',
    supplemented: fresh,
    remaining: flow.scopeCycle.pendingCommands.length,
  }
  for (const target of ['gate', 'doc']) service.gates.notify(sessionId, reopenedWake, target)

  // 自动通过只在「没有缺口、也没有硬阻塞」时才发生：补进来的命令如果没人作证，
  // 那是材料不成立，自动放行等于替用户认下一次没人验证过的授权。
  if ((flow.gateMode ?? 'manual') === 'auto' && !reopened.risks.length && !reopened.blockers.length) {
    // 没有新缺口才自动冻结；有缺口就停在 S1 等人看，别替用户接受。
    decideDoc(service, flow, sessionId, 'approve', {})
    appendEvent(flow.cwd, flow, 'scope.command_gap_decided', {
      choice: 'supplement',
      commands: chosen,
      stage: flow.stage,
      auto: true,
    })
    persist(flow)
    return { frozen: flow.scope?.frozen === true, commands: fresh, remaining: flow.scopeCycle.pendingCommands.length }
  }
  return { frozen: false, commands: fresh, remaining: flow.scopeCycle.pendingCommands.length }
}

/**
 * 「不补」：用户看过了，明确不授权这些命令。
 *
 * 不补 ≠ 放行：命令照样被拒，S3/S4 的账本会把相关验收标准记成未覆盖。
 * 记进 declinedCommands 是为了不再重复弹窗——同一个问题每关问一遍，比不修更烦。
 */
function declineScopeCommands(service, flow, sessionId, wanted) {
  if (flow.finished) throw new Error('流程已经结束，不需要再处理待补命令。')
  const queued = Array.isArray(flow.scopeCycle.pendingCommands) ? flow.scopeCycle.pendingCommands : []
  if (!queued.length) throw new Error('当前没有待补的命令。')
  const selected = resolveChosenCommands(queued, wanted)
  if (!Array.isArray(flow.scopeCycle.declinedCommands)) flow.scopeCycle.declinedCommands = []
  for (const entry of selected) {
    if (flow.scopeCycle.declinedCommands.some((item) => queuedCommandKey(item) === queuedCommandKey(entry))) continue
    flow.scopeCycle.declinedCommands.push({ ...entry, stage: flow.stage, at: Date.now(), by: 'user' })
  }
  const chosen = selected.map((entry) => scopeCommandEntry(entry.command, entry.dir) ?? entry.command)
  flow.scopeCycle.pendingCommands = queued.filter((entry) => !selected.includes(entry))
  appendEvent(flow.cwd, flow, 'scope.command_gap_decided', {
    choice: 'decline',
    commands: chosen,
    stage: flow.stage,
    auto: false,
  })
  persist(flow)
  // 两种等待器都要收到：S1 上等文档批准的那个原来收不到「用户不补」这件事，
  // 于是同一张卡片上两个按钮，一个叫错人、一个叫不到人。
  // 收到后各自重判一次：队列空了，那条阻塞项也就没了。
  const declinedWake = {
    type: 'signal',
    signal: 'commands-decided',
    declined: chosen,
    remaining: flow.scopeCycle.pendingCommands.length,
  }
  for (const target of ['gate', 'doc']) service.gates.notify(sessionId, declinedWake, target)
  return { declined: chosen, remaining: flow.scopeCycle.pendingCommands.length }
}

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
  // 封闭枚举：这里以前是「只认 revise，其余全当批准」，
  // 于是一个接错线的值（例如 'scope-reopened'）会直接变成一次真的冻结。
  // 现在不认识就报错——宁可这一次不生效，也不能替用户批准。
  if (!WAKE_DECISIONS.doc.has(decision)) {
    throw new Error(
      'decideDoc 只接受 ' + [...WAKE_DECISIONS.doc].join(' / ') + '，收到的是 ' + String(decision) +
      '。这个值不会被执行，也不会被当成批准。',
    )
  }
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
      // 追问记录不随「修改需求」清空：用户改了需求，之前问清的那几条依然算数，
      // Agent 下一轮接着问没问到的，而不是从头再问一遍。
      grill: flow.doc?.grill ?? null,
      recommendedPreset: null,
      reason: null,
      at: null,
      revisedAt: at,
      decision: { kind: 'revise', at },
      // 用户的修改意见必须留住：唤醒消息要念原文，Agent 才不用反问一遍。
      revisionNote: revisionNote || null,
    }
    // 改了需求，旧的白名单不能留着：下一份文档会带新的 scope 过来。
    flow.scopeCycle.draft = null
    flow.scopeCycle.dropped = []
    flow.scopeCycle.risks = []
    // 补录申请单一起作废：用户改的是需求本身，范围要重新谈，
    // 拿旧申请单去核对新 scope 只会报一堆对不上的错。
    flow.scopeCycle.requests = []
    // 改了需求就等于 scope 内容要变：缺口计数必须从零算（G21 原文那句「内容变了就重置」的落点）。
    // 留着它，Agent 改完重交时只要签名碰巧一样，计数就从 2 直接跳到 3，刚改完就被判卡住。
    flow.scopeCycle.strikes = null
    flow.scopeCycle.riskLast = []
    appendEvent(flow.cwd, flow, 'doc.revised', revisionNote
      ? { note: revisionNote, ...(rawNote.length > REVISION_NOTE_LIMIT ? { truncated: true, noteLength: rawNote.length } : {}) }
      : {})
    persist(flow)
    return { decision: 'revise', preset: flow.preset, frozen: false, repeated: false, risksAccepted: [] }
  }

  const skipped = decision === 'skip'
  // 冻结前再规范化一次：快照可能来自旧版本或冷恢复，不能假定它已经干净。
  const normalizedPending = validatedPendingScope(flow.cwd, flow.scopeCycle.draft)
  const pendingScope = normalizedPending.scope
  // 体检也重算：pendingScope 可能来自旧版本或冷恢复，提交时那份 risks 不能当作当前结论。
  const readiness = scopeReadiness(
    pendingScope.acceptance_criteria,
    pendingScope.commands,
    pendingScope.files_expected_to_change,
    {
      commandSources: pendingScope.command_sources,
      project: projectProfile(flow.cwd),
      supplementedCommands: supplementedCommandList(flow),
    },
  )
  if (readiness.blockers.length) {
    throw new Error('scope 的验收标准无法核验，不能冻结：\n- ' + readiness.blockers.map((item) => item.message).join('\n- '))
  }
  const risks = readiness.risks
  const scopeRiskNote = typeof options.scopeRiskNote === 'string' ? options.scopeRiskNote.trim().slice(0, 2000) : ''
  if (risks.length && options.acceptScopeRisks !== true) {
    // 拒绝前先把这次的体检结论写回状态：界面靠 pendingScopeRisks 决定要不要弹确认区。
    // 不写回去就会出现「服务端说有缺口、界面说没有」的死循环——用户反复点批准，
    // 每次都被拒，却永远看不到那个能确认缺口的按钮。
    flow.scopeCycle.risks = risks
    persist(flow)
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
    // 这次批准里包含哪些补录命令：事后要能回答「这条命令是谁批进来的」。
    supplemented: supplementedCommandList(flow),
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
  // 申请单的作用期到此结束：scope 已按含这些命令的清单冻结，后续再引用只会念旧账。
  flow.scopeCycle.requests = []
  // 队列同样按新清单对账：命令既然批进清单，这条诉求就满足了、这条拒绝也过期了。
  reconcileScopeQueues(flow, frozen)
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
  // 封闭枚举：与 decideDoc 同一口径，任何上游接错线都在这里停下。
  if (!WAKE_DECISIONS.gate.has(decision)) {
    throw new Error(
      'decideGate 只接受 ' + [...WAKE_DECISIONS.gate].join(' / ') + '，收到的是 ' + String(decision) +
      '。这个值不会被执行，也不会被当成通过。',
    )
  }
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
  // 挂着的不是门禁等待器：这次点击与它无关。以前这里会落到下面的「本地推进」，
  // 结果是状态推进了、挂着的那个工具却永远收不到结果——两边各自看着都合法。
  // 现在直接报冲突，让用户刷新后重新点。
  const waiting = service.gates.kindOf(sessionId)
  if (waiting && waiting !== 'gate') {
    throw new Error(
      '冲突：当前挂着的是' + (waiting === 'doc' ? '需求文档' : '追问') + '等待，不是阶段门禁。' +
      '这次点击没有生效：刷新工作台后再确认一次。',
    )
  }
  // HTTP 与等待器续体都核对快照和例外，避免有等待器时绕过校验。
  if (decision !== 'back' && !gateArtifactReady(flow)) {
    throw new Error('当前阶段还没有可确认的产物：等 Agent 把 ' + STAGE_LABEL[stage] + ' 的结果交上来再点。')
  }
  gateValidation(flow, decision, options)
  // 先落盘，再通知：醒来的一方读到的就是唯一真相（盘上的阶段与门禁状态）。
  // 顺序反过来的话，通知先到、状态后到，等待方就得自己猜这次决定是什么。
  if (decision === 'back') {
    // 从 S4 退回是「测试没过」，不是「用户随手退回」：两者在审计里读起来一样，
    // 卡住判定也就认不出这是同一类退回（G20）。
    const reason = stage === 'S4' && to !== 'S1' ? 'test-rejected' : 'user'
    rollbackTo(flow, to === 'S1' ? 'S1' : 'S2', reason, options.note ?? '')
  } else {
    passGate(flow, decision, options)
  }
  const delivered = service.gates.notify(sessionId, { type: 'decision', decision, to, applied: true }, 'gate')
  if (delivered === 'kind-mismatch') {
    // kindOf 已经拦过一次；真走到这里说明等待器在这两步之间换了人。
    // 状态已经推进，但绝不能假装送达：把冲突说清楚，别让挂着的工具空等。
    throw new Error('冲突：门禁结果没能送达——挂着的等待器已经换成了别的类型。状态已推进，请刷新工作台核对。')
  }
  return { decision, stage, next: flow.stage, repeated: false, delivered: delivered === 'delivered' }
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
    if (PASSIVE_TOOLS.has(name) || Object.hasOwn(TOOL_TARGETS, name)) {
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
/**
 * working_directory：换目录不写盘，但它会把后续命令的执行位置改掉。
 *
 * 命令授权一旦绑定目录，cd 就成了这套绑定的旁路：清单里写的是「在流程根跑 npm run build」，
 * cd 到别处再跑，执行的是另一个同名程序，而判定看到的仍是那条被批准的原文。
 * 所以 S2 / S4 只允许在流程根之内移动；S1 / S3 本来就不放行变更性命令，维持原样。
 */
function workingDirectoryDenial(flow, args, cwd) {
  if (!args || !Object.hasOwn(args, 'cd')) return null
  if (flow.stage !== 'S2' && flow.stage !== 'S4') return null
  const target = typeof args.cd === 'string' ? args.cd : ''
  if (!target.trim()) return 'working_directory 的 cd 必须是明确目录；只想查看当前目录请不要带 cd 参数。'
  const directory = executionDirectory(flow.cwd, resolve(cwd ?? flow.cwd, target))
  return directory.error ? '换目录被拒绝：目标 ' + target + '。' + directory.error + '。' : null
}

function scopeDenial(flow, name, args, cwd = flow?.cwd, mode = 'unknown') {
  if (!flow || flow.finished) return null
  // 换目录先于 PASSIVE_TOOLS 判定：它本身不写盘，但会改掉后面所有命令的执行位置，
  // 当成纯只读工具放行等于把目录绑定又交回给执行时的 cwd。
  if (name === 'working_directory') return workingDirectoryDenial(flow, args, cwd)
  // 显式登记的只读工具直接放行；未登记的工具走下面的默认拒绝。
  if (PASSIVE_TOOLS.has(name)) return null
  if (SHELL_TOOLS.has(name)) return shellDenial(flow, args, cwd, mode)
  if (name === 'run_code') return runCodeDenial(flow, args, cwd, mode)

  const result = scopeTargetsOf(name, args, cwd)
  if (result === null) {
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
  if (result.kind === 'unknown') return result.reason
  if (result.kind === 'none') return null
  for (const target of result.targets) {
    const denial = targetDenial(flow, target, cwd)
    if (denial) return denial
  }
  return null
}

/** 单个目标路径的判定：数据目录、阶段、冻结 scope、大小写。 */
function targetDenial(flow, target, cwd) {
  // 目标相对执行会话解析，清单仍相对流程根目录；后代切换目录不能换出 scope。
  const normalized = normalizeTarget(flow.cwd, resolve(cwd, target.path))
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
  // scope 只授权具体文件；已存在的目录不能借规范化后的相等路径获得整棵树权限。
  if (/[\\/]$/u.test(target.path) || isDirectory(resolve(cwd, target.path))) {
    return 'scope 只允许精确文件目标，不接受目录：' + normalized
  }
  const allowed = flow.scope.data?.in_scope?.files_expected_to_change ?? []
  const targetKey = compareKey(normalized)
  const matched = allowed.some((entry) => {
    const normalizedEntry = normalizeScopeEntry(flow.cwd, entry)
    if (!normalizedEntry) return false
    const entryKey = compareKey(normalizedEntry)
    return targetKey === entryKey
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
/**
 * 把一条命令拆成「可执行体身份 + 参数」。
 *
 * 清单里写 `node test/x.mjs`，实际执行时常常是 `C:\...\node.exe test/x.mjs`：
 * 同一个解释器、同一条命令，只因为路径写法不同就被判成「清单外」。
 * 这正是本轮实测踩到的坑——绝对路径的 node.exe 一律被拒，测试一条都跑不起来。
 */
function commandKey(command) {
  const trimmed = String(command ?? '').trim().replace(/\s+/gu, ' ')
  const match = /^("[^"]*"|'[^']*'|\S+)([\s\S]*)$/u.exec(trimmed)
  if (!match) return null
  const head = match[1].replace(/^["']|["']$/gu, '')
  return {
    head,
    name: executableName(head),
    rest: match[2].trim(),
    registered: isRegisteredExecutable(head),
  }
}

function scopeCommandMatches(flow, command, directory) {
  const list = flow.scope?.data?.in_scope?.commands
  if (directory.error || !Array.isArray(list) || list.length === 0) return false
  const dirKey = compareKey(directory.dir)
  const want = commandKey(command)
  // 原文比较也要空白归一：commandKey 已经把连续空白压成单空格，
  // 清单里批准的是 `npm  run build`（中间两个空格）时，直接用原文比会永远不命中——只误拒、不误放，
  // 但用户会以为「这条明明批准过」。
  const wantText = String(command ?? '').trim().replace(/\s+/gu, ' ')
  for (const entry of list) {
    // 条目可能带目录后缀，剥掉后缀剩下的才是要比较的命令；后缀就是这条授权的目录边界。
    const parsed = parseScopeCommand(entry)
    if (!parsed) continue
    // 目录精确相等才算命中：条目只认它声明的那个目录，子目录要另写一条。
    // 放宽成「子目录也算」等于让 [packages] 覆盖 packages/web 下的另一套 npm 脚本——
    // 同名的 build 脚本做的是完全不同的事。
    if (compareKey(parsed.dir) !== dirKey) continue
    const pattern = parsed.command
    // 两侧都按空白归一再比：清单里写 `npm  run build`、实际调用写 `npm run build` 时是同一条命令。
    const patternText = pattern.trim().replace(/\s+/gu, ' ')
    if (patternText === wantText) return true
    if (patternText.endsWith('*') && wantText.startsWith(patternText.slice(0, -1))) return true
    // 解释器身份归一化只对登记表里的可执行名生效：没登记的名字仍按原文精确比较，
    // 否则任意同名脚本都能借用清单里的授权。
    if (!want?.registered) continue
    const have = commandKey(pattern)
    if (!have?.registered || have.name !== want.name) continue
    if (pattern.endsWith('*')) {
      const restPrefix = have.rest.endsWith('*') ? have.rest.slice(0, -1) : have.rest
      if (want.rest.startsWith(restPrefix)) return true
    } else if (have.rest === want.rest) {
      return true
    }
  }
  return false
}

/**
 * 每条 shell 命令都进审计流水。
 *
 * 判定结果只留在返回值里的话，事后没人能回答「这一轮到底跑了哪些命令」——
 * flows.jsonl 里原来只有「开关被点过」这种记录，没有命令原文。
 * 放宽白名单之前必须先有这张账：出问题时要能定位到具体命令与判定依据。
 */
function auditShell(flow, command, outcome, reason, directory, mode = 'unknown') {
  appendEvent(flow.cwd, flow, outcome === 'allowed' ? 'shell.allowed' : 'shell.denied', {
    command: command.slice(0, SHELL_AUDIT_LIMIT),
    truncated: command.length > SHELL_AUDIT_LIMIT,
    outcome,
    reason: reason ?? null,
    // 执行目录必须进审计：同一条命令在不同目录下跑的是不同的程序，
    // 只记命令原文，事后追责时无法回答「这条授权到底在哪儿被执行了」。
    dir: directory.dir,
    cwd: directory.cwd,
    // 权限模式同样不能省：同一条命令在 read-only 与 danger-full-access 下能做的事完全不同，
    // 只记「放行 / 拒绝」回答不了「它当时到底有没有权限写盘」。
    // 取不到时写 unknown 而不是省略：省略会让「这条事件没有权限信息」和「老版本写的事件」混成一种形状。
    mode,
    ...(directory.error ? { directoryError: directory.error } : {}),
  })
}

/**
 * 宿主沙箱模式。插件自己不设策略，只把宿主当前生效的那一档记下来。
 * 取不到（老宿主没有这个服务、只读子代理的 exec 不带 ctx）时返回 unknown：
 * 记成 unknown 表示「不知道」，记成 workspace-write 才是编造。
 */
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])

function sandboxModeOf(exec) {
  try {
    const policy = exec?.agent?.ctx?.get?.('sandboxPolicy')
    const resolved = policy?.resolve?.({ session: exec.agent.session })
    return SANDBOX_MODES.has(resolved?.mode) ? resolved.mode : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 提权目标：模型被沙箱挡住后重试时带上的 sandbox_permissions。 */
function escalationTarget(args) {
  const target = args?.sandbox_permissions
  return SANDBOX_MODES.has(target) ? target : null
}

function shellCommandOf(exec) {
  const command = exec?.arguments?.command
  return typeof command === 'string' ? command : ''
}

/**
 * 提权申请：模型带上 sandbox_permissions 重试的那一刻。
 *
 * 审批本身在 flowgate 看不见的地方发生（宿主审批服务），能留下的唯一证据是
 * 「它申请升到哪一档、为什么」。申请与结果必须分开记：只记最终模式的话，
 * 一次被驳回的提权会在流水里彻底消失，事后看不出它试过。
 */
function auditEscalation(flow, exec, mode) {
  const target = escalationTarget(exec.arguments)
  if (!target) return
  const command = shellCommandOf(exec)
  const justification = exec?.arguments?.justification
  appendEvent(flow.cwd, flow, 'sandbox.escalated', {
    tool: exec.name,
    ...(command
      ? { command: command.slice(0, SHELL_AUDIT_LIMIT), truncated: command.length > SHELL_AUDIT_LIMIT }
      : {}),
    from: mode,
    to: target,
    justification: typeof justification === 'string' ? justification.slice(0, SHELL_AUDIT_LIMIT) : null,
  })
}

/** 取工具结果里的 value 与 sandbox 段；失败结果两者都为空。 */
function shellResultOf(exec, result) {
  const value = result?.isError === false && result.value && typeof result.value === 'object' ? result.value : {}
  const sandbox = value.sandbox && typeof value.sandbox === 'object' ? value.sandbox : {}
  return { value, sandbox }
}

/**
 * 执行结果：命令跑完（或跑挂）之后的独立事件。
 *
 * shell.allowed 只说明「判定放行」，不说明它有没有真的执行、成没成。
 * 退出码是这条链上唯一能区分「跑成功了」「跑失败了」「根本没起来」的硬证据，
 * 拿不到时也写 null——省略会被读成成功。
 */
function auditShellResult(flow, exec, result) {
  const { value, sandbox } = shellResultOf(exec, result)
  const command = shellCommandOf(exec)
  const mode = SANDBOX_MODES.has(sandbox.mode) ? sandbox.mode : sandboxModeOf(exec)
  appendEvent(flow.cwd, flow, 'shell.result', {
    command: command.slice(0, SHELL_AUDIT_LIMIT),
    truncated: command.length > SHELL_AUDIT_LIMIT,
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    signal: typeof value.signal === 'string' ? value.signal : null,
    timedOut: value.timedOut === true,
    // 后台任务没有退出码，只有 jobId：把它标出来，免得被当成「跑完且成功」。
    background: value.kind === 'background' || typeof value.jobId === 'string',
    mode,
    ...(sandbox.denied === true ? { sandboxDenied: true } : {}),
    ...(result?.isError === true ? { failed: true } : {}),
  })
}

/** 提权结果：申请之后实际生效的是哪一档，与申请分开记一条。 */
function auditEscalationOutcome(flow, exec, result) {
  const target = escalationTarget(exec.arguments)
  if (!target) return
  const { sandbox } = shellResultOf(exec, result)
  const effective = SANDBOX_MODES.has(sandbox.mode) ? sandbox.mode : null
  // 算不算批准，看的是「实际生效的那一档」而不是「调用有没有报错」：
  // 提权批了但命令本身失败，仍然是批准过的提权；结果里没有 sandbox 段时
  // 只能退回「调用成功即视为生效」，因为这时没有更硬的证据。
  const granted = effective ? effective === target : result?.isError !== true
  appendEvent(flow.cwd, flow, granted ? 'sandbox.approved' : 'sandbox.denied', {
    tool: exec.name,
    from: sandboxModeOf(exec),
    to: target,
    effective: effective ?? 'unknown',
    ...(granted ? {} : { reason: '提权未生效' }),
  })
}

/**
 * shell 工具自带的执行目录参数。
 *
 * `ops_bash({ command: 'npm run build', workdir: 'packages/web' })` 里真正决定「跑的是哪个程序」的是 workdir，
 * 会话 header.cwd 只是默认值。只看 header.cwd 等于把目录绑定原样交回给调用方：
 * 清单里批准的是「在流程根跑 npm run build」，实际却在子目录跑了另一个同名脚本，
 * 审计还会记成流程根——这正是本轮要修的问题换了个入口。
 *
 * 只认 `workdir` / `cwd`：`dir` 在不同工具里语义不保证是执行目录，
 * 拿它判定会让「按一个实际不生效的目录命中条目」变成误放。
 */
function shellWorkdir(args) {
  for (const field of ['workdir', 'cwd']) {
    const value = args?.[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

function shellDirectory(root, sessionCwd, workdir) {
  const base = resolve(root, sessionCwd ?? root)
  return executionDirectory(root, workdir ? resolve(base, workdir) : base)
}

/**
 * shell 判定：换行 → 逃逸痕迹 → 只读白名单与纯解析命令 → scope 命令清单。
 * 变更性命令只有一条通道：在 S1 批准过的 scope 清单里。
 */
function shellDenial(flow, args, cwd, mode = 'unknown') {
  const rawCommand = typeof args?.command === 'string' ? args.command : ''
  const directory = shellDirectory(flow.cwd, cwd, shellWorkdir(args))
  // 检查原始命令，避免 trim 隐去首尾的换行。
  if (SHELL_MULTILINE.test(rawCommand)) {
    auditShell(flow, rawCommand, 'multiline', '多行命令', directory, mode)
    return '多行命令被拒绝：换行是 shell 命令分隔符。请每次提交一条单行命令。'
  }
  const command = rawCommand.trim()
  if (!command) {
    auditShell(flow, rawCommand, 'empty', '空命令', directory, mode)
    return '空 shell 命令被拒绝。'
  }
  // 先把 `2>&1` / `> /dev/null` / `| tail -n 20` 这类纯收尾剥掉再判：
  // 它们不写盘也不换执行体，卡住它们只会让已授权的测试命令永远跑不了。
  const base = stripHarmlessSuffixes(command)
  const trimmed = base !== command
  const note = trimmed ? '（已忽略无害输出后缀）' : ''
  if (SHELL_ESCAPE_HINTS.test(base)) {
    auditShell(flow, command, 'escape', '重定向 / 管道 / 解释器内联', directory, mode)
    return (
      '这条命令可能写盘或执行任意代码（重定向 / 管道 / 解释器内联），无法核对冻结 scope，已拒绝：' +
      command.slice(0, 120) + '\n' +
      '请改用读取工具（read / ops_grep / ops_stat）。'
    )
  }
  if (SHELL_READONLY.test(base) || READONLY_VERSION.test(base) || SHELL_GIT_BRANCH.test(base) || PARSE_ONLY.test(base)) {
    auditShell(flow, command, 'allowed', '只读白名单' + note, directory, mode)
    return null
  }
  // scope 清单是用户在 S1 批准过的：清单内的命令直接放行，这是唯一通道。
  // 阶段闸门照旧：S1 与 S3 不放行任何变更性命令，清单也不例外。
  // cwd 一起进匹配：同一条命令在不同目录下跑的是不同的程序，授权必须绑定目录。
  if (flow.stage === 'S2' || flow.stage === 'S4') {
    if (scopeCommandMatches(flow, base, directory)) {
      auditShell(flow, command, 'allowed', 'scope 命令清单' + note, directory, mode)
      return null
    }
  }
  auditShell(flow, command, 'denied', directory.error ?? '不在白名单、不在 scope 清单', directory, mode)
  // 只有 S2 / S4 被拒才算「清单写漏」：S1 还没批准 scope、S3 是评审阶段，
  // 这两处跑变更性命令本身就是阶段违规，把命令塞进清单等于替这次越界背书。
  const supplementable = flow.stage === 'S2' || flow.stage === 'S4'
  if (supplementable) rememberDeniedCommand(flow, command, '不在 scope 命令清单', directory)
  return (
    '当前处于 ' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）阶段，只允许只读 shell 命令：' +
    command.slice(0, 120) + '\n' +
    '变更性命令只有一条通道：在需求文档的 scope.commands 里列出它，由用户在批准 scope 时一并过目。' +
    (supplementable
      ? '执行目录：' + directory.dir + '。' + (directory.error ? directory.error + '。' : '') +
        '这条命令已记进待补清单，用户下次到门禁时会看到它并决定补不补。在补上之前不要换别的写法再试一次：' +
        '那只会多出一条待补命令，不会让这条命令跑起来。'
      : '这里没有别的授权开关。')
  )
}

/** 补录申请单里的清单条目原文：S1 的两道反向核对要按它逐条比对。 */
function supplementedCommandList(flow) {
  return (Array.isArray(flow?.scopeCycle?.requests) ? flow.scopeCycle.requests : []).map((entry) => entry.entry).filter(Boolean)
}

/**
 * 被拒那一刻「正在做什么」：补录申请单上的现场之一。
 *
 * 只取系统已经记下的事实（阶段、返工清单、已交测试方向），不猜 Agent 的意图——
 * 意图只能由它在重新提交时用 AC 的 verification.commands 说明，
 * 自报一段理由不构成证据，反而会让申请单看起来像已经核过。
 */
function stageWorkContext(flow) {
  const items = Array.isArray(flow.remediation?.items) ? flow.remediation.items.length : 0
  const directions = Array.isArray(flow.test?.directions) ? flow.test.directions.length : 0
  if (flow.stage === 'S2') return 'S2 开发' + (items ? '（按 ' + items + ' 条修复项返工中）' : '')
  if (flow.stage === 'S4') return 'S4 测试' + (directions ? '（已交 ' + directions + ' 个测试方向）' : '')
  return (STAGE_LABEL[flow.stage] ?? flow.stage) + '（' + flow.stage + '）'
}

/**
 * 补命令把流程退回 S1 之后，三个工具（gate / review / test）共用的说明。
 *
 * 只说三件事：哪几条被补进来了、眼下这份东西作废了、重新走 S1 时要拿什么来换。
 * 第三件是 G41 的核心：补录不是「用户点头就完事」，Agent 必须回来为每条命令说明
 * 它证明哪一条验收标准——否则这些命令进了清单也产不出证据。
 */
function reopenedMessage(supplemented, what) {
  const list = Array.isArray(supplemented) ? supplemented : []
  return '用户把这几条命令补进了 scope 清单：' + (list.length ? list.join('、') : '（清单里没有命令原文）') +
    '。scope 已退回 S1 重新批准，' + what + '作废。' +
    '现在停下来。重新走 S1 时，每条补录命令都要有验收标准为它作证：' +
    '把命令原文（含目录后缀，例如 npm run build [packages/web]）写进对应 AC 的 verification.commands，' +
    '说明它证明哪一条。没人作证的命令会让这份 scope 批不了；原样删掉它同样批不了——' +
    '补录是用户在门禁上做过的决定，只能由用户再走一次「不补」来撤销。' +
    '等用户重新批准 scope，再按 flowgate_status 给出的阶段开始工作。'
}

/**
 * 记下被拒的变更性命令，等用户在门禁上决定补不补。
 *
 * 队列而不是「最近一条」：开发期间连着被拒三条，门禁上要能一次问完，
 * 而不是补一条、重跑一轮、又被拒、再补一条——那正是「随时都能加」的乱象。
 *
 * 用户不该自己去抄命令原文：被拒的是 Agent 刚拼出来的长命令，
 * 让用户复述一遍只会抄错。这里只留原文、阶段与时间，不参与任何判定。
 *
 * 已经明确「不补」的命令不再入队：同一个问题每关问一遍比不修更烦。
 * 「不补」只代表用户知情，不代表放行——这条命令照样会被拒。
 */
function rememberDeniedCommand(flow, command, reason, directory) {
  if (!flow) return
  // 防御式补齐：手工拼出来的 flow（测试夹具、迁移前的旧快照）可能没有这一层。
  // 缺它就会崩在「读 pendingCommands」上，比记不下这条被拒命令更糟。
  if (!flow.scopeCycle) flow.scopeCycle = emptyScopeCycle()
  const text = command.slice(0, SCOPE_COMMAND_LIMIT)
  const { cwd, dir, error } = directory
  if (!Array.isArray(flow.scopeCycle.pendingCommands)) flow.scopeCycle.pendingCommands = []
  if (!Array.isArray(flow.scopeCycle.declinedCommands)) flow.scopeCycle.declinedCommands = []
  const pending = {
    command: text, dir, cwd, reason, stage: flow.stage, at: Date.now(),
    // 被拒那一刻「正在做什么」：补录申请单上要能看出这条命令是为哪一轮工作拼出来的。
    // 只记系统看得见的事实（阶段与已交产物），不猜 Agent 的意图——
    // 意图只能由它在重新提交时用 AC 引用说明，自报一段理由不构成证据。
    context: stageWorkContext(flow),
    directoryError: error, truncated: command.length > SCOPE_COMMAND_LIMIT,
  }
  const key = queuedCommandKey(pending)
  if (flow.scopeCycle.declinedCommands.some((entry) => queuedCommandKey(entry) === key)) return
  if (flow.scopeCycle.pendingCommands.some((entry) => queuedCommandKey(entry) === key)) return
  // 队列不是无限账本：清单本身就装不下超过 SCOPE_COMMAND_MAX 条，
  // 再往队列里堆只会让用户在门禁上看一屏补不进去的命令。
  if (flow.scopeCycle.pendingCommands.length >= SCOPE_COMMAND_MAX) return
  flow.scopeCycle.pendingCommands.push(pending)
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
function runCodeDenial(flow, args, cwd, mode = 'unknown') {
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
  if (parsed) return scopeDenial(flow, parsed.name, parsed.args, cwd, mode)

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

/**
 * 只读子代理默认拒绝未知能力，防止新增工具绕过写工具黑名单。
 *
 * scopeShell 是「这条命令是否在 S1 批准过的 commands 清单里」的判定器；
 * 没有它时子代理只能跑只读命令。以前这里传的是布尔授权位，
 * 勾一下就把整类变更性命令全放行——用户根本不知道自己在放行什么。
 */
function readonlyDenial(name, args, scopeShell = null) {
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
        const denial = readonlyDenial(call.name, call.args, scopeShell)
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
      return readonlyDenial(match[1], parameters, scopeShell)
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
    const rawCommand = typeof args?.command === 'string' ? args.command : ''
    if (SHELL_MULTILINE.test(rawCommand)) return denied + ' 命令含换行：换行是命令分隔符，一次只能跑一条单行命令。'
    const command = rawCommand.trim()
    if (args?.script_path || !command) return denied
    // 逃逸与白名单都看剥掉无害收尾之后的那一段，与 shellDenial 的顺序完全一致：
    // 主 Agent 能用 `npm test 2>&1 | tail -20`，子代理却因为同一串被拒，
    // 两条通道的规则就不再是「同一套」，测试子代理会无端少一条已授权的验证手段。
    const base = stripHarmlessSuffixes(command)
    if (SHELL_ESCAPE_HINTS.test(base)) return denied + ' 不允许重定向、管道、子 shell 或解释器内联。'
    // 只读命令放行。原来只认精确的 pwd，评审子代理连 git diff 都拿不到，
    // 只能按文件正文猜改了什么；测试方向也核不了工作区有没有多余改动。
    // git status 会刷新索引文件，但既不改工作区内容也不改历史，属于可接受的副作用。
    if (SHELL_READONLY.test(base) || READONLY_VERSION.test(base) || SHELL_GIT_BRANCH.test(base) || PARSE_ONLY.test(base)) return null
    // 变更性命令只认 S1 批准过的清单：没有清单命中的，一律拒绝。
    // workdir 也要带进去：子代理的 header.cwd 只是默认值，`ops_bash({ command, workdir })`
    // 里真正决定跑哪个程序的是 workdir，只按 header.cwd 判定等于把目录绑定交回给调用方。
    if (typeof scopeShell === 'function' && scopeShell(stripHarmlessSuffixes(command), shellWorkdir(args))) return null
    return denied + ' 测试命令、脚本和解释器不能被推定为只读。' +
      '只有需求文档 scope.commands 里列出过的命令才能执行；' +
      '不在清单里时请改用只读命令（pwd / ls / cat / git diff / git status / git log / node --check），' +
      '并把该验证要点标为未覆盖，不要反复尝试。'
  }
  return denied
}

// ---------------------------------------------------------------------------
// 门禁等待：工具挂起，等用户点按钮
// ---------------------------------------------------------------------------

class GateHub {
  constructor() {
    /** @type {Map<string, {resolve: Function, reject: Function, timer: any, kind: string, tag: string|null}>} */
    this.waiters = new Map()
  }

  /**
   * tag 是这一次等待的身份（追问用 questionId）：notify 带着 tag 来时只唤醒对得上的那一条，
   * 否则「用户答的是上一问」会变成「答对了这一问」。
   */
  wait(sessionId, kind, timeoutMs, signal, tag = null) {
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
      const entry = { resolve: finish, reject: rejectPromise, kind, tag, timer: null }
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

  /**
   * 客户端点击按钮时唤醒挂起的工具。
   *
   * 返回三态而不是布尔：false 原来同时表示「没人在等」与「在等的不是这一种」，
   * 调用方无从区分——于是「送不出去」被当成「没人要」，本地照样推进，
   * 而挂着的那个工具永远收不到结果（G04 情况三）。
   *
   * expectKind 必须显式给：要发给「任意等待器」时传 null，并在调用点写明为什么。
   * 省略参数不再等于「谁在等都行」——那正是广播叫错人的入口。
   */
  notify(sessionId, value, expectKind, tag) {
    if (expectKind !== null && expectKind !== 'doc' && expectKind !== 'gate' && expectKind !== 'answer') {
      throw new Error('notify 必须显式说明唤醒哪一种等待器（doc / gate / answer）；需要发给任意等待器时传 null。收到的是 ' + String(expectKind) + '。')
    }
    const entry = this.waiters.get(sessionId)
    if (!entry) return 'no-waiter'
    // kind 不匹配时保持挂起：用户点错面板不该把工具唤醒成别的门禁结果。
    if (expectKind !== null && entry.kind !== expectKind) return 'kind-mismatch'
    // tag 不匹配同理：这不是它在等的那一问，就当没人在等（调用方会走迟到落盘那条路）。
    if (tag !== undefined && entry.tag !== tag) return 'kind-mismatch'
    entry.resolve(value)
    return 'delivered'
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
    /** 会话 → 页面版本上报：两种形态——可信上报（clientRevision/pageId/viewport）与「参与了但读不懂」（reported 或 rejected）。只放内存，不跨宿主重启复用。 */
    this.runtimeClients = new Map()
    /**
     * 门禁等待上限的毫秒级注入点：只有测试会写它（真实配置是分钟粒度，
     * 让测试等一分钟才能验证「超时」等于不验证）。生产路径永远是 null，走工作区配置。
     */
    this.gateWaitOverrideMs = null
    /** cwd → 工作区配置（null 表示这份工作区没有 config.json）。 */
    this.workspaces = new Map()
    this.workspaceSignatures = new Map()
    /**
     * cwd → 冷恢复时被跳过的快照（超大 / 坏 JSON）。
     *
     * 这些流程不在 this.flows 里，所以没有任何流程视图能承载这条告警；
     * 必须单独存一份，由工作台横幅与 flowgate_status 直接念出来。
     */
    this.loadProblems = new Map()
  }

  /** 登记冷恢复时跳过的快照；同一文件只记一条。 */
  recordLoadProblems(cwd, problems) {
    if (!Array.isArray(problems) || !problems.length) return
    const key = resolve(cwd)
    const prev = this.loadProblems.get(key) ?? []
    const seen = new Set(prev.map((item) => item.file))
    const merged = prev.concat(problems.filter((item) => !seen.has(item.file)))
    this.loadProblems.set(key, merged.slice(0, 50))
  }

  /** 当前目录下没载入的快照清单；空数组表示全都读进来了。 */
  loadProblemsFor(cwd) {
    return typeof cwd === 'string' && cwd ? this.loadProblems.get(resolve(cwd)) ?? [] : []
  }

  /**
   * 门禁等待上限：唯一解析点。配置改了立刻对下一次等待生效；
   * 注入值只给测试用（真实上限是分钟粒度，测超时不能真等十分钟）。
   */
  gateWaitMs(flow) {
    if (Number.isFinite(this.gateWaitOverrideMs) && this.gateWaitOverrideMs > 0) return this.gateWaitOverrideMs
    return gateWaitTimeoutMs(this.workspaceOf(flow?.cwd))
  }

  /** 登记一个只读子代理会话；能跑哪些命令由所属流程的 scope 清单实时决定。 */
  registerChild(parentSessionId, childSessionId, policy) {
    this.childOwner.set(childSessionId, {
      parent: parentSessionId,
      flowId: policy?.flowId,
      directionId: policy?.directionId,
      readAttempts: policy?.readAttempts,
      signal: policy?.signal,
    })
  }

  /** 最终守卫与 pre-execute 使用同一规则；放弃/回退后仍保护未释放会话。 */
  childDenial(exec, final = false) {
    const policy = this.childPolicyOf(sessionIdOf(exec))
    if (!policy) return null
    const flow = this.get(policy.parent)
    // 每次调用都重新读流程：流程结束、被放弃、换了流程之后，旧子代理立即失去清单权限。
    const live = flow && !policy.signal?.aborted && !flow.finished && flow.id === policy.flowId
    // 子代理通道与主 Agent 同一套 cwd 规则：闭包把这次调用的执行目录带进去，
    // 否则子代理换个目录跑同名命令，清单授权照样命中——那正是这次要堵的后门。
    const headerCwd = exec?.agent?.session?.header?.cwd
    const childCwd = typeof headerCwd === 'string' && isAbsolute(headerCwd) ? headerCwd : flow?.cwd
    // 闭包多接一个 workdir：子代理也可能用 `ops_bash({ command, workdir })` 换目录，
    // 只按 header.cwd 判定等于给子代理留了同一条旁路。
    const scopeShell = live && (flow.stage === 'S2' || flow.stage === 'S4')
      ? (command, workdir) => scopeCommandMatches(flow, command, shellDirectory(flow.cwd, childCwd, workdir))
      : null
    const denial = readonlyDenial(exec.name, exec.arguments, scopeShell)
    // 前置拒绝会结束调用。其余 shell 调用由最终守卫记录一次。
    if (live && SHELL_TOOLS.has(exec.name) && (denial || final)) {
      const args = exec.arguments
      const command = typeof args?.command === 'string' ? args.command : ''
      const directory = shellDirectory(flow.cwd, childCwd, shellWorkdir(args))
      auditShell(flow, command, denial ? 'denied' : 'allowed', denial ?? '子代理最终守卫', directory, sandboxModeOf(exec))
    }
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

  /** 按宿主会话身份找流程；目录只定位冷恢复快照，不能证明归属。 */
  flowForSession(header) {
    const visited = new Set()
    const snapshots = new Map()
    while (typeof header?.id === 'string' && header.id && !visited.has(header.id)) {
      visited.add(header.id)
      const ownerId = this.ownerOf(header.id)
      let flow = this.get(ownerId)
      if (!flow && typeof header.cwd === 'string' && isAbsolute(header.cwd)) {
        try {
          this.hydrate(header.cwd)
          flow = this.get(ownerId)
          if (!flow) {
            // hydrate 只恢复活动流程；归属查询还要识别最近已结束的身份边界。
            // 只缓存本次追溯读到的快照，不建立会话索引或改变恢复语义。
            if (!snapshots.has(header.cwd)) {
              const problems = []
              snapshots.set(header.cwd, loadFlowsFromDisk(header.cwd, problems))
              this.recordLoadProblems(header.cwd, problems)
            }
            if (snapshots.get(header.cwd).some((raw) => raw?.sessionId === ownerId
              && raw.finished === true && repairFlow(raw))) return null
          }
        } catch {
          // 快照不可读时无法确认归属，按约定放行；启动入口仍显式报错并禁止抢占。
          return null
        }
      }
      // 最近的流程已经结束时，不再套用更远祖先的流程。
      if (flow) return flow.finished ? null : flow
      if (!Number.isSafeInteger(header.delegationDepth) || header.delegationDepth <= 0
        || header.origin !== 'subagent' || typeof header.parentSession !== 'string' || !header.parentSession
        || visited.has(header.parentSession)) return null
      const parentId = header.parentSession
      // 直接父会话的 ID 已足够证明归属，即使父会话尚未加载。
      flow = this.get(this.ownerOf(parentId))
      if (flow) return flow.finished ? null : flow
      header = sessionHeaderOf(this, parentId)
    }
    return null
  }

  /**
   * 按目录列出进行中的流程，只给界面用，不参与任何授权判定。
   *
   * 目录只能回答「东西放在哪」，回答不了「这条流程属于谁」：同一目录下可以同时
   * 存在多条互不相干的流程。所以这里返回数组——调用方一旦「挑一条」当作当前流程，
   * 就等于用目录反推身份，那正是 G07/G09 的成因。
   */
  flowsUnder(cwd) {
    if (typeof cwd !== 'string' || !cwd) return []
    // 不能用 normalizeTarget(cwd, '.')：它返回的是「相对 cwd 的路径」，
    // 目标就是 cwd 本身时得到空串，任何两个目录都会互相等于。
    const key = compareKey(resolve(cwd))
    const out = []
    for (const flow of this.flows.values()) {
      if (flow.finished || flow.cancelled) continue
      // 只认同一个目录：子目录里的流程属于它自己的目录，
      // 把它算成「同目录的邻居」会让提示说错地方，也把范围又扩回了目录推断。
      if (compareKey(resolve(flow.cwd)) === key) out.push(flow)
    }
    return out
  }

  /** 惰性恢复快照；权限不落在流程里，冷恢复不涉及任何重新授权。 */
  hydrate(cwd) {
    if (this.loaded.has(cwd)) return
    const problems = []
    for (const raw of loadFlowsFromDisk(cwd, problems)) {
      const flow = repairFlow(raw)
      if (!flow || flow.finished || this.flows.has(flow.sessionId)) continue
      {
        const interrupted = flow.execution?.status === 'running'
        if (interrupted) {
          flow.execution = { ...flow.execution, status: 'failed', text: '宿主重启后没有可确认的最终执行结果，不能按任务 ID 认为已经完成。', at: nowIso() }
          this.flows.set(flow.sessionId, flow)
          this.recoverGateRequest(flow)
          persist(flow)
          continue
        }
        this.flows.set(flow.sessionId, flow)
        const recovered = this.recoverGateRequest(flow)
        // 旧版本写在磁盘上的授权字段已经在 repairFlow 里丢掉，顺手写回去：
        // 留着的话文件里一直有 shellGrant: true，读的人分不清它还算不算数。
        if (recovered || 'shellGrant' in raw || 'writeGrants' in raw || 'directionWriteDeclared' in raw) persist(flow)
      }
    }
    this.loaded.add(cwd)
    this.recordLoadProblems(cwd, problems)
  }

  /**
   * 冷恢复时补写「门禁还开着，但宿主重启过」。
   *
   * 等待器只活在进程内存里，重启后必然为空：所以「gateRequested 有、endedAt 空、waiters 里没有」
   * 就是「上次那个门禁还在等，只是没人接得住它了」。这件事必须留痕，
   * 否则 Agent 与用户都只能看到「门禁 pending」，分不清是刚提交还是等了半天没人点。
   *
   * 只在惰性 hydrate 里写，不引入启动扫目录：谁先碰这个工作区，谁就把这条记录补上。
   */
  recoverGateRequest(flow) {
    if (!flow || flow.finished || flow.cancelled) return false
    const record = flow.stages[flow.stage]
    if (!record || record.gate !== 'pending') return false
    const request = gateRequestOf(record)
    if (!request || request.endedAt) return false
    if (this.gates.has(flow.sessionId)) return false
    // 同一次请求只写一条：hydrate 是按目录去重的，但同一目录可能被多次查询。
    if (flow.gateRecovered?.gateId === request.id) return false
    flow.gateRecovered = { gateId: request.id, kind: request.kind, stage: flow.stage, at: nowIso() }
    flow.gateWaitReason = 'restart'
    appendEvent(flow.cwd, flow, 'flow.gate.recovered', { gateId: request.id, kind: request.kind, stage: flow.stage })
    return true
  }

  get(sessionId) {
    return this.flows.get(sessionId) ?? null
  }

  require(sessionId) {
    const flow = this.flows.get(sessionId)
    if (!flow) throw new Error('当前会话还没有流程。先调用 flowgate_start 启动四阶段流程。')
    return flow
  }

  /** 一条流程给提示条看的摘要：自己的流程与同目录邻居共用同一份字段。 */
  flowSummary(flow) {
    const view = this.view(flow.sessionId)
    return {
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
    }
  }

  /**
   * 界面提示条用的工作区摘要，把两件事分开说：
   * `flow` 是这个会话自己的流程（身份来自会话），`neighbors` 是同目录还有谁在做流程。
   * 邻居只用于提示：不给按钮，也不挡启动。用别人的流程渲染「你现在处于 S2」正是 G07 的误伤。
   */
  workspaceHint(sessionId) {
    const cwd = cwdOfSession(this, sessionId) || this.get(sessionId)?.cwd
    if (!cwd) return null
    this.hydrate(cwd)
    const own = this.get(sessionId)
    const mine = own && !own.finished && !own.cancelled ? own : null
    const neighbors = this.flowsUnder(cwd)
      .filter((flow) => flow.sessionId !== sessionId)
      .map((flow) => this.flowSummary(flow))
    return {
      path: cwd,
      active: Boolean(mine),
      flow: mine ? this.flowSummary(mine) : null,
      neighbors,
    }
  }

  start(sessionId, cwd, title, preset, brief) {
    // 先把这个工作区的快照读进来：读不出来就不知道这个会话是不是已有流程，
    // 那时候凭空新建会把一条看不见的旧流程顶掉。读盘失败照原样抛给上层，不在这里吞。
    this.hydrate(cwd)
    // 只按会话拒绝：flows 以会话为键，同一会话再 start 会把上一条顶掉。
    // 目录不能当身份——同一个项目里另开一个会话是正常用法，按目录硬拒只会误伤别人。
    const existing = this.get(sessionId)
    if (existing && !existing.finished) {
      throw new Error('当前会话已经有一条进行中的流程（' + (existing.title || '未命名需求') + '，' + existing.stage + '）。要开始新的一条，请先结束或放弃它。')
    }
    const flow = createFlow({ sessionId, cwd, title, preset, brief })
    flow.stages.S1.status = 'active'
    this.flows.set(sessionId, flow)
    appendEvent(cwd, flow, 'flow.started', { preset: flow.preset, title: flow.title })
    persist(flow)
    return flow
  }

  /** 配置只在签名变化时重新解析。 */
  workspaceOf(cwd) {
    if (!cwd) return null
    cwd = resolve(cwd)
    const signature = fileSignature(workspaceConfigFile(cwd))
    if (!this.workspaces.has(cwd) || this.workspaceSignatures.get(cwd) !== signature) {
      this.workspaces.set(cwd, loadWorkspaceConfig(cwd))
      this.workspaceSignatures.set(cwd, signature)
    }
    return this.workspaces.get(cwd)
  }

  /** 四阶段作为一个整体原子落盘；只有全部恢复内置才删除配置文件。 */
  setWorkspaceStages(cwd, value, extra = {}) {
    cwd = resolve(cwd)
    const current = this.workspaceOf(cwd)
    const stages = Object.fromEntries(STAGES.map((stage) => [stage, normalizeWorkspaceStage(value[stage], stage)]))
    // 等待上限与阶段条目共用同一份文件：改一个不能把另一个抹掉。
    const gateWaitMinutes = normalizeGateWaitMinutes(
      extra.gateWaitMinutes !== undefined ? extra.gateWaitMinutes : current?.gateWaitMinutes,
    )
    if (STAGES.every((stage) => stages[stage] === null) && gateWaitMinutes === GATE_WAIT_DEFAULT_MINUTES) {
      try {
        unlinkSync(workspaceConfigFile(cwd))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      this.workspaces.set(cwd, null)
      this.workspaceSignatures.set(cwd, null)
      return null
    }
    const config = saveWorkspaceConfig(cwd, { version: WORKSPACE_CONFIG_VERSION, updatedAt: nowIso(), stages, gateWaitMinutes })
    // 兼容旧宿主消费者；磁盘只保存 stages 这一份事实来源。
    config.rules = stages.S2
    config.gateWaitMinutes = gateWaitMinutes
    this.workspaces.set(cwd, config)
    this.workspaceSignatures.set(cwd, fileSignature(workspaceConfigFile(cwd)))
    return config
  }

  /** 旧开发规则接口只更新 S2，不能抹掉其他阶段的设置。 */
  setWorkspaceRules(cwd, rules) {
    const current = this.workspaceOf(cwd)
    const stages = Object.fromEntries(STAGES.map((stage) => [stage, workspaceStage(current, stage)]))
    stages.S2 = rules
    return this.setWorkspaceStages(cwd, stages)
  }

  /**
   * 门禁等待上限：工作区级默认，改了对当前进行中的流程立即生效。
   *
   * 越界（含 0）不静默接受：0 会让永久悬挂这个缺陷重新打开，
   * 所以写回默认值并在返回值里说明被改写了。
   */
  setWorkspaceGateWaitMinutes(cwd, value) {
    const current = this.workspaceOf(cwd)
    const stages = Object.fromEntries(STAGES.map((stage) => [stage, workspaceStage(current, stage)]))
    // 先按类型取数再交给 normalize：布尔 true / 空串 / 非数字串不能先被 Number() 变成 1 或 0，
    // 否则「写错了」会静默变成「上限被设成能接受的最小值」，而写错的人以为自己在用默认值。
    const requested = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
    const accepted = normalizeGateWaitMinutes(requested)
    const rejected = !Number.isFinite(requested)
      || Math.round(requested) < GATE_WAIT_MIN_MINUTES
      || Math.round(requested) > GATE_WAIT_MAX_MINUTES
    this.setWorkspaceStages(cwd, stages, { gateWaitMinutes: accepted })
    return { minutes: accepted, rejected }
  }

  /** 客户端可见的视图（不含内部等待器等）。 */
  view(sessionId) {
    return this.viewOf(this.flows.get(sessionId), sessionId, true)
  }

  /**
   * 给一条流程对象生成客户端视图。
   *
   * `attached` 表示这条流程绑在一个活会话上：只有活会话才查得到等待器、
   * 活动行与「门禁还在等」的语义。历史快照（流程已结束，或被同会话的新流程
   * 顶掉）没有活会话可绑，这些一律为空——那不是「没人点」，而是本来就不该有按钮。
   */
  viewOf(flow, sessionId, attached) {
    const runtime = runtimeOf(flow ?? { sessionId })
    if (!flow) {
      return { active: false, presets: PRESETS, builtinAngles: BUILTIN_ANGLES, builtinDirections: BUILTIN_DIRECTIONS, runtime }
    }
    // 门禁同样与等待器解耦：产物已交、还没决策就可确认，中断也不影响按钮。
    const gatePending =
      !flow.finished && gateArtifactReady(flow) && flow.stages[flow.stage]?.gate === 'pending'
    // 请求记录可能来自旧快照（布尔 true）或新形状（带 id 与收尾标记），统一在这里读一次。
    const gateRequest = gateRequestOf(flow.stages[flow.stage])
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
      // S4 退回卡住的批次：界面要能说清「卡在哪几条 AC、卡了几轮」，而不是只给一句「退回了」。
      // 挂在顶层而不是 doc 段：它描述的是测试门禁，与需求文档无关。
      testStall: flow.finished ? null : flow.testStall ?? null,
      // 退回累计账：结束后也保留，复盘时「这条流程退了几次」比只看当前阶段有用。
      rollbacks: flow.rollbacks ?? { total: 0, byReason: {}, skipped: 0, last: null },
      // 冻结时用户明确接受的验收方案缺口（含原因）：结束后也要能追溯。
      scopeRisksAccepted: flow.scope?.data?.scope_risks ?? null,
      // 文档已提交且流程未结束就是待批准：不再取决于某次工具调用是否还挂在内存里。
      // 界面靠 pending 决定显示按钮，靠 interrupted 说明「入口曾中断但仍可确认」。
      doc: {
        ...flow.doc,
        pending: !flow.finished && Boolean(flow.doc?.html) && !flow.doc?.decision,
        // 与 gate.interrupted 同一套判据：要求这一轮确实请求过门禁。
        // 否则文档刚写完、还没进 awaitGate 的那个瞬间也会被标成「已中断」，把提示说早一步。
        interrupted:
          !flow.finished && Boolean(flow.doc?.html) && !(attached && this.gates.has(sessionId)) && Boolean(gateRequest),
        // 门禁请求本身（id / 时间 / 怎么结束的）：界面与 flowgate_status 都靠它说清「上次等的是哪一关」。
        request: gateRequest,
        // 标记必须绑定到「本阶段这一次请求」：阶段推进后上一轮的恢复标记还留在 flow 上，
        // 不校验 id 就会让从没请求过门禁的新阶段显示「宿主重启过」。
        recovered:
          !flow.finished && gateRequest && flow.gateRecovered?.gateId === gateRequest.id
            ? flow.gateRecovered
            : null,
        // S1 的门禁产物是需求文档，`gate.pending` 在这个阶段永远是 false，
        // 界面靠 doc 这一段显示按钮：等待原因也必须一并给到，否则 S1 超时后
        // 界面只会说「请求被中断了」，说不出是等满了上限还是宿主重启过。
        waitReason: gateRequest ? flow.gateWaitReason ?? null : null,
        // 批准前用户必须能看到「这次将允许改哪些文件」，否则等于盲签（P0-4）。
        pendingScope: flow.finished ? null : flow.scopeCycle.draft ?? null,
        // 提交时被剔除的越界条目：批准前给用户看，别让它们静默消失。
        droppedScopeEntries: flow.finished ? [] : flow.scopeCycle.dropped ?? [],
        // 验收方案缺口：批准前必须看见。非空时界面不能一键批准，要先看清清单再确认接受。
        pendingScopeRisks: flow.finished ? [] : flow.scopeCycle.risks ?? [],
        // 上一次提交因缺口被退回时的缺口原文与累计次数：界面要能回答「为什么还没到批准这一步」。
        scopeRiskLast: flow.finished ? [] : flow.scopeCycle.riskLast ?? [],
        scopeRiskStrikes: flow.finished ? null : flow.scopeCycle.strikes ?? null,
      },
      // 门禁模式：auto 没有阻塞项就自动放行，manual 每一步都等确认；任何阶段都能切。
      gateMode: flow.gateMode ?? 'manual',
      // 上次自动判定为什么没放行：界面要能回答「这次怎么没自动过」，否则用户只会觉得开关坏了。
      gateBlockers: flow.gateBlockers ?? null,
      // 自动放行过哪几关：结束后回溯时「谁批准的这一关」必须说得清。
      autoPassed: flow.autoPassed ?? null,
      /**
       * 被拒、等用户决定补不补的命令。
       *
       * 界面只读它：补与不补都是用户在门禁上的一次显式选择，
       * 没有「顺手把这条加进去」这种旁路——那正是原来那套乱象的来源。
       */
      pendingCommands: flow.finished ? [] : (flow.scopeCycle.pendingCommands ?? []).map((entry) => ({
        ...entry, selectionKey: queuedCommandKey(entry),
        canSupplement: !entry.directoryError && !entry.truncated && Boolean(scopeCommandEntry(entry.command, entry.dir)),
      })),
      /** 用户已明确不补的命令：账本与评审要能解释「这条为什么没跑成」。 */
      declinedCommands: flow.finished ? [] : flow.scopeCycle.declinedCommands ?? [],
      /**
       * 补录申请单：用户补进清单的每条命令，带着被拒时的现场。
       *
       * 界面在 S1 上把它摊开，逐条标出「有没有验收标准为它作证」——
       * 这是 S1 能独立判断的唯一依据，不能只显示「清单多了三行」。
       */
      scopeRequests: flow.finished ? [] : (flow.scopeCycle.requests ?? []).map((entry) => ({
        ...entry,
        attestedBy: (Array.isArray(flow.scopeCycle.draft?.acceptance_criteria) ? flow.scopeCycle.draft.acceptance_criteria : [])
          .filter((item) => item && ['unit', 'integration'].includes(item.verification?.method))
          .filter((item) => Array.isArray(item.verification?.commands) && item.verification.commands.includes(entry.entry))
          .map((item) => item.id ?? '（无 id）'),
      })),
      // 落盘失败会让冷恢复退回旧快照，用户必须能看到这条，而不是以为一切正常。
      persistError: flow.persistError ?? null,
      /** 写侧超限、本次没有写盘：和 persistError 一样，属于「进度可能丢」的告警。 */
      persistProblem: flow.persistProblem ?? null,
      /** 写侧主动裁掉的事件副本条数：裁剪本身必须留痕。 */
      persistTrimmed: flow.persistTrimmed ?? null,
      /** 冷恢复时被跳过的快照：它们没有消失，只是这次没读进来。 */
      loadProblems: this.loadProblemsFor(flow.cwd),
      gate: {
        pending: gatePending,
        interrupted:
          gatePending && !(attached && this.gates.has(sessionId)) && Boolean(gateRequest),
        // 请求记录与「重启过」标记：界面据此区分「刚提交」与「提交了但没人点」。
        request: gateRequest,
        // 同上：上一阶段的「重启过」与「等待原因」不能借用新阶段的门禁显示出来。
        recovered:
          !flow.finished && gateRequest && flow.gateRecovered?.gateId === gateRequest.id
            ? flow.gateRecovered
            : null,
        waitReason: gateRequest ? flow.gateWaitReason ?? null : null,
      },
      grill: {
        pending: flow.finished ? null : flow.grill.pending,
        answeredCount: flow.grill.answered.length,
        awaiting: attached && !flow.finished && this.gates.kindOf(sessionId) === 'answer',
      },
      stageConfigs: Object.fromEntries(STAGES.map((stage) => [stage, stageConfig(flow, stage, workspace)])),
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
      /**
       * 门禁等待上限：工作区级配置，改了对进行中的流程立即生效。
       * 0 不允许（那会把「永久悬挂」这个缺陷重新打开），所以界面上只给 1–60 的输入框。
       */
      gateWait: {
        minutes: normalizeGateWaitMinutes(workspace?.gateWaitMinutes),
        min: GATE_WAIT_MIN_MINUTES,
        max: GATE_WAIT_MAX_MINUTES,
        fallback: GATE_WAIT_DEFAULT_MINUTES,
        file: workspaceConfigLabel(),
      },
      directions: resolveDirections(flow, workspace),
      directionCatalog: directionCatalog(flow, workspace),
      /** 用户声明的额外只读工具：界面据此显示与编辑。 */
      toolAllowlist: (flow.toolAllowlist ?? []).slice(),
      review: flow.review ? { ...flow.review, counts: findingCounts(flow.review.angles ?? []) } : null,
      // 评审发现里落在 scope 外的部分：客户端据此提示「这些得回 S1 调 scope」。
      reviewOutsideScope: flow.review ? reviewFindingsOutsideScope(flow) : [],
      test: flow.test,
      devChanges: flow.devChanges,
      /** 部分重跑：回退留下的可复用结论与判定理由；客户端据此提示「这些不用重跑」。 */
      carryOver: flow.finished ? null : carryOverAdvice(flow),
      waiting: attached && this.gates.has(sessionId),
      waitingKind: attached ? this.gates.kindOf(sessionId) : null,
      /** 界面启动时是否成功把需求投递给 Agent；null 表示不是界面启动。 */
      nudge: attached ? this.nudges.get(sessionId) ?? null : null,
      cancelled: Boolean(flow.cancelled),
      cancelledAt: flow.cancelledAt ?? null,
      cancelReason: flow.cancelReason ?? null,
      canSpawn: subagentCapability(this.ctx, this.readonlyGuardReady).available,
      // 阶段进度 + 正在进行的那一步：客户端每 1.5 秒拉一次，不用额外的推送通道。
      progress: progressOf(flow),
      activity: (() => {
        const live = attached ? this.activity.get(sessionId) : null
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

  /**
   * 按 flowId 取只读视图（历史详情用）。
   *
   * 会话只能回答「这个会话现在这条」，回答不了「当初那条」：同一个会话开了新流程，
   * 旧条目就被顶掉，再按 sessionId 取只会看到新的那份。所以历史必须按流程自己的 id 找：
   * 内存里有就用内存（还活着的），否则读这个工作区盘上的快照。
   */
  flowView(flowId, cwd) {
    if (typeof flowId !== 'string' || !flowId) return null
    for (const flow of this.flows.values()) {
      if (flow.id === flowId) return this.viewOf(flow, flow.sessionId, true)
    }
    if (typeof cwd !== 'string' || !cwd) return null
    const problems = []
    for (const raw of loadFlowsFromDisk(cwd, problems)) {
      if (raw?.id !== flowId) continue
      const flow = repairFlow(raw)
      if (!flow) return null
      // 历史快照不绑活会话：没有等待器，也没有可点的门禁。
      return this.viewOf(flow, flow.sessionId, false)
    }
    return null
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

// status 的版本字段名单：两个分支的返回值按它挑（pickRuntime），output.schema 的 required 也由它生成。
// 但 output.schema.properties 是手写的：加第八个版本字段要同时改 lib/runtime.js 的 runtimeFields、
// 这里、以及 properties 与 required 两处，少一处就被 additionalProperties:false 直接拒掉。
const STATUS_RUNTIME_KEYS = ['version', 'moduleRevision', 'diskModuleRevision', 'runtimeStatus', 'clientRevision', 'clientStatus', 'staleModules']

function pickRuntime(fields) {
  const picked = {}
  for (const key of STATUS_RUNTIME_KEYS) picked[key] = fields[key]
  return picked
}

/**
 * 冷恢复跳过的快照必须念出来。
 *
 * 这些流程不在内存里，所以没有任何流程视图能承载这条信息；不念的后果是
 * 用户以为流程没启动过，而数据其实还躺在 flows/ 目录里。
 */
function loadProblemLines(problems) {
  if (!Array.isArray(problems) || !problems.length) return []
  return [
    '有 ' + problems.length + ' 个流程快照没有载入（数据还在盘上，只是这次没读进来）：',
    ...problems.slice(0, 5).map((item) => '- ' + item.message),
    ...(problems.length > 5 ? ['- 另有 ' + (problems.length - 5) + ' 个'] : []),
    '处理方式：把超限或损坏的快照文件挪走、修复后重启宿主；宿主不会自动删除它们。',
  ]
}

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
          rollbacks: {
            type: 'object',
            properties: {
              total: { type: 'number', description: '本流程被退回的总次数（只增不减，流程结束后仍保留）。' },
              byReason: {
                type: 'object',
                additionalProperties: { type: 'number' },
                description: '按原因分的退回次数：user / test-rejected / review-rejected / scope-commands-missing。',
              },
              skipped: { type: 'number', description: '被幂等拦下的重复退回次数（10 秒内同目标同原因，状态没动）。' },
              last: {
                type: 'object',
                properties: { to: { type: 'string' }, reason: { type: 'string' }, at: { type: 'string' } },
                required: [],
                additionalProperties: false,
              },
            },
            required: ['total', 'byReason', 'skipped', 'last'],
            additionalProperties: false,
            description: '回退累计账：回答「这条流程被退回几次、都因为什么」。',
          },
          summary: { type: 'string' },
          version: { type: 'string' },
          moduleRevision: { type: 'string' },
          diskModuleRevision: { type: 'string' },
          runtimeStatus: { type: 'string' },
          clientRevision: { type: 'string' },
          clientStatus: { type: 'string' },
          staleModules: { type: 'array', items: { type: 'string' } },
          waiting: {
            type: 'object',
            properties: {
              gateId: { type: 'string', description: '这次等待的门禁 id（落盘的请求记录里读回，重启后仍然读得到）。' },
              kind: { type: 'string', description: '等待的种类：doc（需求文档）/ gate（阶段门禁）/ answer（追问卡片）。' },
              since: { type: 'string', description: '这次等待开始的时间（ISO 时间戳）。' },
            },
            required: [],
            additionalProperties: false,
            description: '当前还没收尾的门禁等待请求（从落盘记录读回，宿主重启后仍读得到）。空对象表示门禁没在等，或这次等待已经收尾：这时用户点按钮只会记录决定，不会唤醒你。',
          },
          loadProblems: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                bytes: { type: 'number' },
                limit: { type: 'number' },
                reason: { type: 'string', description: 'oversize（超过快照上限）/ bad-json（文件损坏）。' },
                message: { type: 'string' },
              },
              required: ['file', 'reason', 'message'],
              additionalProperties: false,
            },
            description: '冷恢复时被跳过的快照。非空表示有流程没载入：它们没有消失，只是这次没读进来——不要当成「用户没启动过流程」。',
          },
        },
        required: ['active', 'stage', 'stageLabel', 'finished', 'preset', 'scopeFrozen', 'skippedCount', 'rollbacks', 'summary', 'waiting', 'loadProblems', ...STATUS_RUNTIME_KEYS],
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
      // 没载入的快照在任何分支都要能看见：恰恰是没有流程时最容易被误判成「从没启动过」。
      const loadProblems = SERVICE.loadProblemsFor(cwd)
      if (!flow) {
        // G38：没有流程也要念出版本——Agent 接手任务的第一件事就是确认验的是哪一版。
        const host = hostState(moduleRevisions())
        const fields = runtimeFields(packageVersion(), host, { status: 'absent', clientRevision: '', expectedClientRevision: '', reason: '', expired: false })
        return {
          active: false,
          stage: '-',
          stageLabel: '未启动',
          finished: false,
          preset: '-',
          scopeFrozen: false,
          skippedCount: 0,
          // 没有流程时也给一个空账：字段缺一块会让读它的客户端各自猜默认值。
          rollbacks: { total: 0, byReason: {}, skipped: 0, last: null },
          // G38：没有流程时 summary 首行也必须念出运行版本——接手任务的那一刻往往还没启动流程。
          summary: [
            describeRuntime(fields),
            ...loadProblemLines(loadProblems),
            '当前会话还没有流程。调用 flowgate_start 启动四阶段流程（需求分析 → 开发 → 评审 → 测试）。',
          ].join('\n'),
          waiting: {},
          loadProblems,
          ...pickRuntime(fields),
        }
      }
      const runtimeInfo = runtimeOf(flow)
      // 等待器只在进程内存里：重启后必然为空，所以「有没有等待器」和「有没有请求记录」要分开念。
      const gateRequest = gateRequestOf(flow.stages[flow.stage])
      // waiting 说的是「门禁还开着、这次请求也没收尾」，不是「内存里有等待器」：
      // 等待器只在进程内存里，重启后必然为空，而那时恰恰是 Agent 最需要这份信息的时候。
      // 有没有活体等待器由 summary 那行分开念。
      const waiting = !flow.finished && flow.stages[flow.stage]?.gate === 'pending' && gateRequest && !gateRequest.endedAt
        ? { gateId: gateRequest.id ?? '', kind: gateRequest.kind ?? '', since: gateRequest.at ?? '' }
        : {}
      const lines = [
        // G38：第一行就是运行版本，Agent 不用再去别处找「验的是哪一版」。
        describeRuntime(runtimeInfo),
        ...loadProblemLines(loadProblems),
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
      if (!flow.finished && (flow.scopeCycle.risks ?? []).length) {
        lines.push('待批准的 scope 有 ' + flow.scopeCycle.risks.length + ' 条验收方案缺口，用户批准时需要明确确认接受。')
      }
      // 缺口在 S1 就该补齐，不该留给用户接受：被退回的次数要念出来，Agent 才知道自己卡在哪。
      if (!flow.finished && flow.scopeCycle.strikes?.count && (flow.scopeCycle.riskLast ?? []).length) {
        const strikes = flow.scopeCycle.strikes
        lines.push(
          strikes.stalled
            ? '同一批验收方案缺口已经连续 ' + strikes.count + ' 次没补齐，流程停在 S1 等用户决定（继续改、补命令清零后重来，或放弃重开）：'
            : '上一次提交的 scope 有 ' + flow.scopeCycle.riskLast.length + ' 条验收方案缺口，已被退回（第 ' + strikes.count
              + '/' + SCOPE_RISK_STRIKE_LIMIT + ' 次）；同一批缺口再出现一次，这条流程会停在 S1 等你决定：',
        )
        for (const risk of flow.scopeCycle.riskLast) lines.push('- ' + risk.message + '（' + (risk.acs ?? []).join('、') + '）')
      }
      // 影响面必须逐个念出来：评审要据此判断发现是否属于本次范围，Agent 也得知道自己承诺动过什么。
      const contracts = flow.scope?.frozen ? (flow.scope.data?.in_scope?.shared_contracts ?? []) : []
      if (contracts.length) {
        lines.push('本次会动的共用契约与已知约束（影响面）：')
        for (const entry of contracts) lines.push('- ' + entry)
      }
      // 产物交了没有必须能自查：中断之后 Agent 最先怀疑的就是「是不是没提交成功」。
      const artifactLine = stageArtifactLine(flow)
      if (artifactLine) lines.push(artifactLine)
      // 门禁等待状态必须能自查：Agent 被中断后只能靠这里回答「上次等的是哪一关、现在还开不开」。
      if (!flow.finished) {
        const record = flow.stages[flow.stage]
        if (gateRequest && record?.gate === 'pending') {
          const endText = gateRequest.endedAt
            ? '这次等待已经结束（' + (gateRequest.endKind === 'timeout' ? '等满上限超时' : '被中断') + '），但门禁仍然开着：' +
              '用户点按钮只会记录决定，不会唤醒你。'
            : SERVICE.gates.has(sessionId)
              ? '等待器还挂着：用户点按钮会当场唤醒你。'
              : '没有等待器接着这个门禁：用户点按钮只会记录决定，不会唤醒你。'
          lines.push('门禁等待：id ' + (gateRequest.id ?? '（旧记录，没有 id）') + '，种类 ' + (gateRequest.kind ?? '未知') +
            '，从 ' + (gateRequest.at ?? '未知时间') + ' 开始；' + endText)
        } else if (record?.gate === 'pending') {
          lines.push('门禁等待：本阶段还没有请求过门禁。')
        }
        // 宿主重启过：这条要单独念，否则「门禁 pending」会被当成「刚提交」。
        // 只念属于本阶段那次请求的那一条：阶段推进后上一轮的恢复标记还留在 flow 上，
        // 直接看它会把「新阶段从没请求过门禁」说成「宿主重启过」。
        if (gateRequest && flow.gateRecovered?.gateId === gateRequest.id) {
          lines.push('宿主重启过：门禁仍在等待，但原来的等待器随进程一起没了（gateId ' + (flow.gateRecovered.gateId ?? '无') + '，' + flow.gateRecovered.at + ' 发现）。')
        }
      }
      if (flow.finished) lines.push('状态：' + closureSentence(flow))
      const skipped = skippedCount(flow)
      if (skipped > 0) lines.push('本流程有 ' + skipped + ' 个阶段被用户跳过')
      // 退回次数念进摘要：Agent 接手时最先想知道的就是「这条流程已经耗掉多少轮」。
      const rollbackLine = rollbackSummaryLine(flow)
      if (rollbackLine) lines.push(rollbackLine)
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
        rollbacks: flow.rollbacks ?? { total: 0, byReason: {}, skipped: 0, last: null },
        summary: lines.join('\n'),
        // 空对象 = 没有等待器：用户点按钮只会记录决定，不会唤醒 Agent。
        waiting,
        loadProblems,
        ...pickRuntime(runtimeInfo),
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
          'S1 只是这条流程的起点：文档获批后直接继续 S2 开发，不要在阶段交界处停下来等用户再说一句。' +
          '追问一次只解决一个分歧，答完接着问下一个，直到能写出可验收的需求或只剩用户能拍板的事。',
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
      '选项 label 只写标签文本，不要自己加「（推荐）」：推荐由 recommended 下标表达，界面按它统一追加一次。',
      '追问要问到共识，不是问一句就收工：先问目标与关键取舍，再从答案里找下一个模糊点（隐含假设、边界情况、失败的后果），一个问题只解决一个分歧。',
      '用户答完一个就接着问下一个，直到你要么能写出可验收的需求，要么剩下的分歧只有用户能拍板；没把握的地方写进 flowgate_doc 的 assumptions，问不清的留在 open_questions 里继续问——open_questions 非空时提交会被拒绝。',
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
              label: { type: 'string', description: '选项标题：只写标签文本，不要自己加「（推荐）」——推荐由 recommended 下标表达，界面按它统一追加。' },
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
          // 追问也走同一个等待上限：超时后要能让调用方分清「没回答」与「等超时了」。
          waitReason: { type: 'string' },
        },
        required: ['answered', 'choice', 'custom', 'reason', 'waitReason'],
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

      // 追问用同一个上限：共用入口，不另写一个数字。
      // 第五个参数是这一问的身份：别的题目的答案不会被当成对这一问的回答。
      // 切门禁模式、待补命令被处理这类信号会让追问的等待提前醒来：
      // 它们不是「这一问有答案了」，重挂一次继续等——否则用户看着卡片，
      // Agent 却被告知「等待被中断」，两边对同一件事的判断就分叉了。
      let wake = null
      for (;;) {
        const outcome = await service.gates.wait(sessionId, 'answer', service.gateWaitMs(flow), exec.signal, pending.id)
        wake = normalizeWake(outcome, 'answer')
        if (RESIGNALS.has(wake.kind)) continue
        break
      }
      if (wake.kind !== 'answer') {
        // 只有「用户放弃流程」才作废卡片。超时/取消/被取代都保留 pending：
        // 清掉会让工作台上那张卡片凭空消失，而用户可能正看着它准备点；
        // 保留的代价只是状态里多一条，收益是「点选之后仍然算数」。
        if (wake.kind === 'cancelled') {
          // 只作废自己那一份：这段等待期间 pending 可能已经换成了后发起的新问题。
          if (flow.grill.pending?.id === pending.id) {
            flow.grill.pending = null
            persist(flow)
          }
          return { answered: false, choice: '', custom: '', reason: '用户放弃了这次流程，追问作废。', waitReason: 'cancelled' }
        }
        // 不自动重挂：追问 id 每轮换新，会把用户正在看的卡片悄悄替换掉。
        const reason = wake.kind === 'timeout'
          ? '等待超时（等满了配置的上限）。追问卡片仍留在工作台：用户点选后答案会被记录并唤醒你，不要重新提同一个问题。'
          : '这次等待被中断（工具调用超时或被新的等待取代）。追问卡片仍留在工作台：用户点选后答案会被记录并唤醒你，不要重新提同一个问题。'
        return { answered: false, choice: '', custom: '', reason, waitReason: wake.kind }
      }
      // 只清自己那一份：答案属于这一问，不代表后来发起的新问题也该一起收起来。
      if (flow.grill.pending?.id === pending.id) flow.grill.pending = null
      // 追问记录只用于回看 S1 的决策过程：留最近 100 条足够，不能让快照跟着问题数无限长。
      if (flow.grill.answered.length >= 100) flow.grill.answered.splice(0, flow.grill.answered.length - 99)
      flow.grill.answered.push({
        questionId: pending.id,
        question: pending.question,
        choiceIndex: wake.choiceIndex,
        choice: options[wake.choiceIndex]?.label ?? '',
        custom: wake.customText ?? '',
        at: nowIso(),
      })
      appendEvent(cwd, flow, 'grill.answered', {
        questionId: pending.id,
        choiceIndex: wake.choiceIndex,
        custom: wake.customText ?? '',
      })
      persist(flow)
      return {
        answered: true,
        choice: options[wake.choiceIndex]?.label ?? '',
        custom: wake.customText ?? '',
        reason: '',
        waitReason: '',
      }
    },
  }
}

function docTool(scoped) {
  return {
    name: 'flowgate_doc',
    description: [
      '提交 S1 的产出：自包含单文件 HTML 需求文档 + scope.json 等价内容 + 推荐档位。',
      '交件立即返回（decision=submitted）：产物落盘、门禁打开，然后调用 flowgate_wait 等用户点「批准并冻结 scope」。',
      '不要重复提交同一份需求文档：重跑会覆盖上一份并白烧一轮。',
      'HTML 必须自包含（内联样式、无外链），包含目标、in-scope/out-of-scope、验收标准表格。',
      '每条 acceptance_criteria 都要声明 verification.method 与 procedure。视觉宽度和对齐验收必须实际测量真实宿主元素，CSS字符串断言不能证明视觉通过；无接入时记录未覆盖。' +
        '声明 unit / integration 的验收标准还必须写 verification.commands：它能被清单里的哪几条命令证明——覆盖关系在 AC 这侧声明，命令侧不再自报。',
      'scope 里必须写 shared_contracts：为实现这个需求要动的共用契约、共用基础设施与已知约束。' +
        '评审会据此判断一条发现是否落在本次开发范围内，没写就等于让评审去猜。',
      // 清单驱动的前提是「清单是读出来的」：凭印象编的命令会在 S2 第一次跑构建时当场失败。
      'commands 必须从项目里读出来，不要凭印象编：先看 package.json 的 scripts、测试框架配置、tsconfig、Makefile，' +
        '再把真正要跑的命令逐条写进来，并用 command_sources 标注每条来自哪里（只标来源，不标它能证明谁）。' +
        '清单是用户唯一的授权范围：写全了，S2/S4 跑构建与测试就一路放行；写漏了，那条命令会被直接拒绝，' +
        '用户只能退回 S1 补清单再批准一次——没有「临时授权」这种后门。',
      // 补录申请单（G41）：用户补进来的命令必须由 Agent 用 AC 说明「它证明哪一条」。
      // 否则 S4 不会为它产出证据，它只是一份没人用的额外授权。
      '用户在门禁上把被拒的命令补进清单后，scope 会退回 S1：重新提交时要为每条补录命令给出举证——' +
        '把它的原文（含目录后缀，例如 npm run build [packages/web]）写进对应验收标准的 verification.commands，' +
        '说明它证明哪一条。补进来却没有任何 AC 引用它、或者重新提交时把它静默删掉，都会被拒绝提交。',
      // 清单里的命令能不能跑，S1 就能验：版本探测属于只读白名单，任何阶段都放行。
      // 这一步补的是静态体检查不到的那半：文件在不在能查，跑起来报不报错只有跑一次才知道。
      '提交 scope 前先对清单里每个工具跑一次版本探测（node --version、npm --version、php --version 等）：' +
        '这类命令是只读的，S1 直接放行，跑一次就知道它在不在、能不能用。' +
        '探测跑不通就把绝对路径或替代方案写进清单，不要带着一条跑不了的命令去批准 scope——' +
        '批准之后 S2 第一次构建就会当场失败，而那时候用户已经批过了。' +
        '注意绝对路径的探测（C:/…/node.exe --version）不在只读白名单里，S1 会被拒；' +
        '所以用裸名探测，报「找不到」恰好说明该把绝对路径写进清单，交给 S2 按清单放行。',
      '自动通过模式下，S1 只有在体检没有阻塞项与缺口时才会自动冻结：验收方案缺口（缺测试命令、验证步骤点名 scope 外文件、视觉验收没写测量方式）会让它停下来等人确认。',
      '预览是视口内渲染，宽度会自适应桌面与平板：用相对宽度（百分比 / max-width）排版，不要写死像素宽度。',
      '预览区域是透明底，会跟随用户的明暗主题：文档自己写死白底会在深色主题下变成刺眼白块，建议用 color-scheme: light dark 并同时给出深色配色，或干脆不写背景色。',
      '提交时必须交代追问结果，三份清单缺一不可：decisions 是已经问定的事项（每条写清问了什么、定了什么）；assumptions 是没问、由你自己补全的前提；open_questions 是还没问清的问题。open_questions 非空说明共识还没达成，宿主会直接拒绝提交——需求文档不是记录待定的地方。',
      '追问要问到共识，不是问一句就收工：每条模糊表述、每个隐含假设、每个关键取舍都该摊开，问出的东西写进 decisions 或 assumptions，剩下问不清的留在 open_questions 里继续问。',
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
        decisions: {
          type: 'array',
          description:
            '已经和用户问定的事项：每条写清问了什么（question）、定成什么（answer）。' +
            '这是「追问过」的证据，不是可选备注；一条都没问过时至少要有 assumptions。',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '问用户的原问题。' },
              answer: { type: 'string', description: '用户拍板的结论，写具体，别写「已确认」。' },
            },
            required: ['question', 'answer'],
            additionalProperties: false,
          },
        },
        assumptions: {
          type: 'array',
          items: { type: 'string' },
          description: '没问、由你自己补全的前提，一条一句。写成可被推翻的断言，别写「假设一切正常」。',
        },
        open_questions: {
          type: 'array',
          items: { type: 'string' },
          description: '还没问清的问题。非空说明共识还没达成，宿主会拒绝这次提交——先回去用 flowgate_ask 问掉。',
        },
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
                'S2 / S4 里命中清单的命令直接放行，这是变更性命令的唯一通道；' +
                '末尾 * 做前缀通配。写清具体命令，别写成「构建相关命令」这种散文。' +
                '清单外的命令会被拒绝，用户只能退回 S1 补清单——写漏一条就要重跑一轮评审与测试。',
            },
            command_sources: {
              type: 'array',
              description:
                '命令清单的来源标注（可选，不进冻结的 scope.json）：每条命令是从哪读出来的。' +
                'S1 请先读 package.json 的 scripts、测试框架配置、tsconfig、Makefile，再按读到的内容写命令，不要凭印象编。' +
                '标注的作用是让用户批准前看懂「这条命令为什么在这里」。' +
                '哪条命令证明哪条验收标准不写在这里：那件事由 acceptance_criteria 的 verification.commands 声明。',
              items: {
                type: 'object',
                properties: {
                  command: { type: 'string', description: '与 commands 里某一条完全一致。' },
                  from: { type: 'string', description: '来源，例如 package.json scripts.test。' },
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
                      commands: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'method 为 unit / integration 时必填：能产出这条验收标准证据的命令，必须与 scope.commands 里某几条完全一致。逐条列全，不要笼统写「跑测试」。',
                      },
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
      required: ['html', 'scope', 'decisions', 'assumptions', 'open_questions'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          decision: { type: 'string', description: SUBMIT_DECISION_DESC },
          submitted: SUBMITTED_SCHEMA,
          preset: { type: 'string' },
          frozen: { type: 'boolean' },
          message: { type: 'string' },
          scopeRisks: {
            type: 'array',
            items: { type: 'string' },
            description: '批准前静态体检出的验收方案缺口（每条一句）。空数组表示没有发现缺口。',
          },
          waitReason: {
            type: 'string',
            description: '等待中断的原因：timeout（等满上限）/ superseded（被新的等待取代）/ aborted（调用被取消）。只有等待中断时才有值。',
          },
          willWake: {
            type: 'boolean',
            description: '现在是否还有等待器：false 表示用户点按钮只会记录决定，不会唤醒你。',
          },
          gateId: {
            type: 'string',
            description: '这次等待的门禁 id（落盘的请求记录里读回，重启后仍然有效）。',
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

      // 三份清单是契约的一部分：少一份说明 Agent 没走完 S1 的追问流程。schema 层会拦，
      // 但直接调 execute 的宿主（含测试与嵌入方）绕过 schema，这里再兜一层，报错点名缺了哪个。
      const missingGrill = ['decisions', 'assumptions', 'open_questions'].filter((key) => !Array.isArray(args[key]))
      if (missingGrill.length) {
        throw new Error('提交需求文档必须同时带上三份追问清单：decisions（已确认决策）、assumptions（隐含假设）、open_questions（未决问题）；缺少 ' + missingGrill.join('、') + '。')
      }
      // 追问纪律不能只写在提示词里：Agent 想说「差不多了」的时候，没有东西拦得住。
      const grill = grillReadiness(args.decisions, args.assumptions, args.open_questions)
      if (grill.blockers.length) {
        throw new Error('需求还没问到共识，先补完追问再提交：\n- ' + grill.blockers.map((item) => item.message).join('\n- '))
      }

      const normalizedScope = validatedPendingScope(cwd, args.scope)
      // S1 是唯一能低成本改 scope 的阶段：验收方法跟命令 / 文件清单对不上时，这里就要说清，
      // 别等 S4 才发现「声明 integration，却只有 unit 证据」——那时只能带缺口结项或整轮退回。
      const readiness = scopeReadiness(
        normalizedScope.scope.acceptance_criteria,
        normalizedScope.scope.commands,
        normalizedScope.scope.files_expected_to_change,
        {
          commandSources: normalizedScope.scope.command_sources,
          project: projectProfile(cwd),
          supplementedCommands: supplementedCommandList(flow),
        },
      )
      if (readiness.blockers.length) {
        throw new Error('scope 的验收标准无法核验，请先修正再提交：\n- ' + readiness.blockers.map((item) => item.message).join('\n- '))
      }
      // 缺口不端给用户去接受：S1 是唯一能低成本改 scope 的阶段，交给 Agent 补齐。
      // 用户在这一步看到的应当是「可以批准的东西」；把缺口摆到批准按钮前，等于让他替 Agent
      // 判断验收方法成不成立，而这正是他最没有信息去判断的事。
      if (readiness.risks.length) {
        // 签名必须带 AC 身份（G20）：只取缺口代码的话，「换了一批验收标准、缺口类型没变」
        // 会被当成同一批一直累加，而 Agent 每轮只修一条时签名又每轮都变、上限永远到不了。
        const signature = readiness.risks
          .flatMap((item) => ((item.acs ?? []).length ? item.acs.map((ac) => ac + ':' + item.code) : [item.code]))
          .sort()
          .join('+')
        const previous = flow.scopeCycle.strikes
        const repeated = previous && previous.signature === signature ? (previous.count ?? 0) + 1 : 1
        // 到上限就不再累加：继续涨没有信息量，只会把「还得再试几轮」这种误导写进界面。
        const count = Math.min(repeated, SCOPE_RISK_STRIKE_LIMIT)
        const stalled = repeated >= SCOPE_RISK_STRIKE_LIMIT
        flow.scopeCycle.strikes = { signature, count, at: nowIso(), ...(stalled ? { stalled: true } : {}) }
        // 缺口原文留在状态里：界面据此说明「为什么还没到批准这一步」。
        flow.scopeCycle.riskLast = readiness.risks
        // 上一份草稿带着缺口，不再是待批准状态：留着它界面会又摆出「批准（需确认缺口）」，
        // 也就是把同一个缺口从提交这一步挪回批准这一步，白绕一圈。
        flow.scopeCycle.risks = []
        flow.scopeCycle.draft = null
        flow.scopeCycle.dropped = []
        // 计数必须先落盘：下面走的是失败路径，不 persist 就丢了下一次的机会。
        persist(flow)
        const listed = readiness.risks.map((item) => item.message + '（' + (item.acs ?? []).join('、') + '）').join('\n- ')
        if (stalled) {
          // 卡住不判死（G21）：同一个信号既会误杀——换了一批 AC、缺口类型没变，签名不变、计数照涨；
          // 也会漏杀——Agent 每轮只修一条，签名每轮都变、上限永远到不了。
          // 改道不是判死，是把决定权交回给人：流程停在 S1，由用户在三条路里选。
          throw new Error(
            '同一批 scope 缺口连续 ' + count + ' 次没能补齐，提交仍被退回：\n- '
              + listed
              + '\n这条流程停在 S1：既不自动结束，也不再自动重试，请让用户在工作台选一条路：'
              + '\n- 让 Agent 继续改 scope 后重新提交（补测试命令、补测试文件、把验证步骤点名的 scope 外文件加进 files_expected_to_change 或改成不动它们、给视觉验收写明测量方式）；'
              + '\n- 在工作台补一条被拒的命令——这等于给这次重写一次新机会，退回计数会清零；'
              + '\n- 放弃这条流程，重新梳理需求后再启动。'
              + '\n反复卡在同一批缺口，通常不是执行不力，而是验收方法本身不成立或当前环境测不了。',
          )
        }
        throw new Error(
          '这份 scope 有 ' + readiness.risks.length + ' 条验收方案缺口，提交被退回（第 ' + count + '/' + SCOPE_RISK_STRIKE_LIMIT + ' 次）：\n- '
            + listed
            + '\n请自己补 scope 后重新提交，不要让用户来接受这些缺口：补测试命令、补测试文件、把验证步骤点名的 scope 外文件加进 files_expected_to_change 或改成不动它们、给视觉验收写明测量方式。'
            + (count === SCOPE_RISK_STRIKE_LIMIT - 1 ? '\n注意：同一批缺口再出现一次，这条流程会停在 S1 等你决定，不会自动结束。' : ''),
        )
      }
      // 缺口补齐了：上一轮的退回计数与缺口原文都作废，否则状态摘要会一直念旧账。
      flow.scopeCycle.strikes = null
      flow.scopeCycle.riskLast = []
      flow.doc = {
        html,
        // 追问结果随文档一起落盘：用户批准前能看到「到底问了什么、定了什么」。
        grill,
        recommendedPreset: args.recommendedPreset ?? flow.preset,
        reason: args.reason ?? '',
        at: nowIso(),
        // 用户决策后写在这里：工具调用中断也不影响这份文档还能被确认。
        decision: null,
      }
      // scope 是 Agent 自报的：先规范化再存，绝对路径与项目根之外的条目一律剔除。
      flow.scopeCycle.draft = normalizedScope.scope
      // 被剔除的越界条目要留痕：用户批准前有权知道 Agent 报了哪些越界路径。
      flow.scopeCycle.dropped = normalizedScope.dropped
      // 风险随 scope 一起留在流程里：界面按它决定批准前要不要走确认区。
      flow.scopeCycle.risks = readiness.risks
      appendEvent(cwd, flow, 'doc.submitted', {
        decisions: grill.decisions.length,
        assumptions: grill.assumptions.length,
        recommendedPreset: flow.doc.recommendedPreset,
        files: normalizedScope.scope.files_expected_to_change,
        commands: normalizedScope.scope.commands,
        droppedScopeEntries: normalizedScope.dropped,
        scopeRisks: readiness.risks.map((item) => item.code),
      })
      persist(flow)

      // 交件到此为止：产物落盘 + 门禁打开，然后立刻返回。等签收是 flowgate_wait 的事。
      return submitGate(flow, 'doc', {
        kind: 'doc',
        label: '需求文档',
        // doc 没有独立 id：提交时间就是它的身份，Agent 靠它确认是同一份。
        id: flow.doc?.at ?? '',
        detail: '包含 ' + (flow.scopeCycle.draft?.acceptance_criteria ?? []).length + ' 条验收标准',
        tool: 'flowgate_doc',
      }, { preset: flow.preset, frozen: false })
    },
  }
}

/** S1 出口门禁：等用户点「批准并冻结 scope」。 */
async function waitDocGate(service, flow, sessionId, exec, reuse) {
  const outcome = await awaitGate(service, flow, sessionId, 'doc', exec, 'S1', reuse)
      if (outcome.kind === 'stale') {
        // 用户已经在等待中断的窗口里确认过了：scope 早就冻结，这次提交不该再审一遍。
        return {
          // 读不到决策就不猜：缺记录时说「待确认」，比冒充用户批准安全。
          decision: flow.doc?.decision?.kind ?? 'pending',
          preset: flow.preset,
          frozen: flow.scope?.frozen === true,
          message:
            '用户已经在等待中断期间确认过了，当前在 ' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）。' +
            '不要再提交需求文档：读取 flowgate_status 看最新状态，直接开始当前阶段的工作。',
        }
      }
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
        // 但 Agent 必须真的停下：它一边往下做、用户一边点批准，就成了「用户自顾自批准」。
        const wait = gateWaitPayload(outcome, {
          kind: 'doc',
          label: '需求文档',
          // doc 没有独立 id：提交时间就是它的身份，Agent 靠它确认是同一份。
          id: flow.doc?.at ?? '',
          detail: '包含 ' + (flow.scopeCycle.draft?.acceptance_criteria ?? []).length + ' 条验收标准',
          tool: 'flowgate_doc',
        })
        return {
          decision: 'halt',
          preset: flow.preset,
          frozen: false,
          waitReason: wait.waitReason,
          willWake: wait.willWake,
          gateId: wait.gateId,
          ...(wait.submitted ? { submitted: wait.submitted } : {}),
          message: wait.note,
        }
      }

      // 走到这里只可能是 approve / revise / skip：协议已经挡住其余一切。
      // 真相只有一个——不信唤醒值，读盘上记录的那次决策。
      // 这样即使唤醒值被接错线，最坏结果也只是「读到的还是用户真点过的那个决定」。
      //
      // 唯一的例外是自动通过（outcome.auto）：它不是外部唤醒，是 awaitGate 自己
      // 刚刚判定「没有阻塞项」并写下 flow.autoPassed 才返回的，盘上没有 doc 决策记录
      // 是设计如此。这条分支只认自己写的标记，不接受任何外部投递的形状。
      const recorded = flow.doc?.decision?.kind ?? null
      const autoPass = outcome.auto === true && WAKE_DECISIONS.doc.has(outcome.kind)
      if (!WAKE_DECISIONS.doc.has(recorded) && !autoPass) {
        throw new Error(
          '收到文档决策唤醒（' + String(outcome.kind) + '），但流程里没有对应的决策记录：' +
          '状态与唤醒值对不上，不能当作已批准。请读取 flowgate_status 核对后重新提交 flowgate_doc。',
        )
      }
      const result = decideDoc(service, flow, sessionId, WAKE_DECISIONS.doc.has(recorded) ? recorded : outcome.kind)
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
            : '') +
          wakeNotesText(outcome.notes),
      }
}

function gateTool(scoped) {
  return {
    name: 'flowgate_gate',
    description: [
      '提交 S2 开发摘要：交件立即返回（decision=submitted），门禁随之打开。',
      '交完调用 flowgate_wait 等用户点「完成开发」或「跳过」。',
      'S3 / S4 的产物分别由 flowgate_review / flowgate_test 交件，本工具在这两个阶段只回 stale。',
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
          decision: { type: 'string', description: SUBMIT_DECISION_DESC },
          submitted: SUBMITTED_SCHEMA,
          stage: { type: 'string' },
          next: { type: 'string' },
          message: { type: 'string' },
          waitReason: {
            type: 'string',
            description: '等待中断的原因：timeout（等满上限）/ superseded（被新的等待取代）/ aborted（调用被取消）。只有等待中断时才有值。',
          },
          willWake: {
            type: 'boolean',
            description: '现在是否还有等待器：false 表示用户点按钮只会记录决定，不会唤醒你。',
          },
          gateId: {
            type: 'string',
            description: '这次等待的门禁 id（落盘的请求记录里读回，重启后仍然有效）。',
          },
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
        // 采集最长有 10 秒：这期间用户可能已经点了门禁，阶段推进到 S3。
        // 那就别再写开发摘要——写了就是往新阶段里塞上一阶段的事实。
        if (flow.stage !== stage) {
          return {
            decision: 'stale',
            stage,
            next: flow.stage,
            message:
              '用户已经在本阶段门禁上确认过了，阶段已推进到 ' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）。' +
              '这次开发摘要没有写入：读取 flowgate_status 看最新状态，直接开始当前阶段的工作。',
          }
        }
        flow.devChanges = changes
        flow.snapshot = currentSnapshot(flow)
        appendEvent(cwd, flow, 'dev.summary', { ...changes, snapshot: flow.snapshot.id, complete: flow.snapshot.complete })
        persist(flow)
      }
      if (args.summary) flow.gateNote = args.summary

      // S3 / S4 的产物由评审、测试工具交件，本工具在这两个阶段没有可交的东西。
      // 它以前在这里顺手挂起等签收，正是「交件」与「等签收」混在一起的那一半。
      if (stage !== 'S2') {
        return {
          decision: 'stale',
          stage,
          next: stage,
          message: gateArtifactReady(flow)
            ? '当前在 ' + stage + '（' + STAGE_LABEL[stage] + '）：本阶段的门禁已经由 ' +
              (stage === 'S3' ? 'flowgate_review' : 'flowgate_test') + ' 交件时打开。' +
              '要等用户点按钮，调用 flowgate_wait；不要用 flowgate_gate 代替，也不要重复提交产物。'
            : gateNoArtifactNote(flow),
        }
      }

      // 本阶段还没有产物就挂起，等的是一个按钮永远不会出现的门禁。
      if (!gateArtifactReady(flow)) {
        return { decision: 'stale', stage, next: stage, message: gateNoArtifactNote(flow) }
      }

      // 交件到此为止：开发摘要已落盘，开闸后立刻返回，等签收交给 flowgate_wait。
      return submitGate(flow, 'gate', {
        kind: 'dev-summary',
        label: '开发摘要',
        id: flow.snapshot?.id ?? '',
        tool: 'flowgate_gate',
      }, { stage, next: stage })
    },
  }
}

/** S2 出口门禁：等用户点「完成开发」/「跳过」。 */
async function waitDevGate(service, flow, sessionId, exec, reuse, stage) {
  const outcome = await awaitGate(service, flow, sessionId, 'gate', exec, stage, reuse)
      if (outcome.kind === 'stale') {
        return { decision: 'stale', stage, next: flow.stage, message: gateStaleNote(flow) }
      }
      if (outcome.kind === 'timeout' || outcome.kind === 'aborted' || outcome.kind === 'superseded') {
        const wait = gateWaitPayload(outcome, {
          kind: 'dev-summary',
          label: '开发摘要',
          id: flow.snapshot?.id ?? '',
          tool: 'flowgate_gate',
        })
        return {
          decision: 'halt',
          stage,
          next: stage,
          waitReason: wait.waitReason,
          willWake: wait.willWake,
          gateId: wait.gateId,
          ...(wait.submitted ? { submitted: wait.submitted } : {}),
          message: wait.note,
        }
      }
      // 到这里只可能是白名单里的值：协议在 awaitGate 里已经挡住其余一切，
      // 所以下面每个分支都是明确的，末尾不再有「原样透传」的兜底。
      const decision = outcome.kind
      if (decision === 'cancelled') {
        return {
          decision,
          stage,
          next: 'cancelled',
          message: '用户放弃了这次流程。停止推进阶段，等用户在工作台里重新开始一条新流程。',
        }
      }
      if (decision === 'scope-reopened') {
        return {
          decision: 'reopened',
          stage,
          next: flow.stage,
          message: reopenedMessage(outcome.supplemented, '本阶段的门禁与产物'),
        }
      }
      if (decision === 'pass' || decision === 'skip') {
        // applied 表示「状态已经由点击那一侧落盘」，这里只负责把结果讲清楚。
        if (!outcome.applied) passGate(flow, decision === 'skip' ? 'skip' : 'pass', outcome)
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
                '不要在阶段交界处停下等用户再说一句。') +
            wakeNotesText(outcome.notes),
        }
      }
      if (decision === 'back') {
        if (!outcome.applied) rollbackTo(flow, outcome.to ?? 'S2', 'user', outcome.note ?? '')
        return {
          decision,
          stage,
          next: flow.stage,
          message: '用户退回到 ' + flow.stage + ' 重做。' + remediationNote(flow) + wakeNotesText(outcome.notes),
        }
      }
      throw new Error(
        '门禁结果没有可处理的分支：' + String(decision) +
        '。这是唤醒协议与消费端不同步，请把这个错误报告出来——不要自己猜一个结果继续往下做。',
      )
}

const CAPTURE_LIMIT = 4 * 1024 * 1024

/**
 * 跑一条只读命令，把 stdout 收成字符串；退出码非 0 或派生失败都抛错。
 *
 * 为什么不用 execFile：受限沙箱拒绝的是「用管道 stdio 派生进程」（spawn EPERM），
 * 不是派生本身——同一个子进程把输出指向真实文件描述符就能正常退出并写满输出。
 * 所以优先走临时文件，临时文件打不开才回落到管道；普通宿主上两条路结果一样。
 */
function captureCommand(command, args, options = {}) {
  const { cwd, timeoutMs = 10000, limit = CAPTURE_LIMIT } = options
  const base = { cwd, windowsHide: true, timeout: timeoutMs }
  const readCapped = (file) => {
    try {
      const text = readFileSync(file, 'utf8')
      return text.length > limit ? text.slice(0, limit) : text
    } catch {
      return ''
    }
  }
  const failed = (status, stderr) =>
    new Error(command + ' 退出码 ' + status + (stderr ? '：' + stderr.trim().slice(0, 200) : ''))
  const pipe = () =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, base)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        if (stdout.length < limit) stdout += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        if (stderr.length < limit) stderr += String(chunk)
      })
      child.on('error', reject)
      child.on('close', (status) => {
        if (status === 0) resolve(stdout)
        else reject(failed(status, stderr))
      })
    })
  const stamp = process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  const dirs = cwd ? [tmpdir(), cwd] : [tmpdir()]
  const attempt = (index) => {
    if (index >= dirs.length) return pipe()
    const outPath = join(dirs[index], '.tmp-flowgate-capture-' + stamp + '.out.log')
    const errPath = join(dirs[index], '.tmp-flowgate-capture-' + stamp + '.err.log')
    let outFd
    let errFd
    try {
      outFd = openSync(outPath, 'w')
      errFd = openSync(errPath, 'w')
    } catch {
      for (const fd of [outFd, errFd]) {
        try {
          if (typeof fd === 'number') closeSync(fd)
        } catch {}
      }
      return attempt(index + 1)
    }
    return new Promise((resolve, reject) => {
      let settled = false
      // 先把文件读回来再清理：清理会删掉这两个文件。Windows 上也删不掉还开着的文件，先关。
      const finish = (failure, status) => {
        if (settled) return
        settled = true
        const stdout = readCapped(outPath)
        const stderr = readCapped(errPath)
        for (const fd of [outFd, errFd]) {
          try {
            closeSync(fd)
          } catch {}
        }
        for (const file of [outPath, errPath]) {
          try {
            unlinkSync(file)
          } catch {}
        }
        if (failure) reject(failure)
        else if (status === 0) resolve(stdout)
        else reject(failed(status, stderr))
      }
      const child = spawn(command, args, { ...base, stdio: ['ignore', outFd, errFd] })
      child.on('error', (error) => finish(error))
      child.on('close', (status) => finish(null, status))
    })
  }
  return attempt(0)
}

/**
 * 用 node:child_process 直接跑只读 git 命令。
 * 有些 profile 装的是替代 shell 插件（例如 dsh-ops 提供 ops_bash 并退掉官方的 shell 行），
 * 宿主就没有 'shell' 服务可用——这时不能直接放弃采集。
 */
async function gitSummaryText(cwd) {
  const status = await captureCommand('git', ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all'], { cwd })
  const numstat = await captureCommand('git', ['diff', '--numstat'], { cwd })
  return String(status) + '\n---numstat---\n' + String(numstat)
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

const FINDING_KINDS = ['defect', 'design']
const FINDING_EVIDENCE_LIMIT = 64
const FINDING_TEXT_LIMIT = 300
const FINDING_SHORT_LIMIT = 200
// 证据锚点必须是单个标识符：带括号、参数或行号的写法一律不合格，
// 否则「整行代码」也能当锚点蒙混过去。
const FINDING_IDENTIFIER = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]{0,63}$/u

/** 按 JS 标识符字符切词，避免把标识符片段或数字前缀当成独立锚点。 */
function findingWords(content) {
  return new Set(content.split(/[^$_\u200c\u200d\p{ID_Continue}]+/u).filter((word) => FINDING_IDENTIFIER.test(word)))
}

/** 读 finding.file 的源码：同一轮里同一个文件只读一次。 */
function findingSource(flow, file, cache) {
  const key = normalizeTarget(flow.cwd, file)
  if (cache.has(key)) return cache.get(key)
  let source = null
  try {
    const root = realpathSync(resolve(flow.cwd))
    const full = realpathSync(resolve(root, file))
    // 对真实路径做边界检查：项目内的符号链接不能指向项目外仍算已核实。
    if (full === root || full.startsWith(root + sep)) {
      const content = readFileSync(full, 'utf8')
      source = {
        path: full,
        words: findingWords(content),
        lines: content.split('\n').map((line) => line.replace(/\r$/u, '')),
        lineCount: content.split('\n').length,
      }
    }
  } catch {
    source = null
  }
  cache.set(key, source)
  return source
}

/**
 * 一条发现的完整性判定，返回 { missing, unverified } 两组字段名。
 *
 * missing 是形状问题（字段缺失、枚举外、expected 等于 actual），unverified 是内容
 * 对不上（要读文件才知道）。两者处置不同：前者逐条丢弃，后者保留原严重度降级成
 * 建议——内容对不上就整条丢掉，会把「这里可能有问题」这个最该人看一眼的信号一起丢。
 */
function checkFinding(flow, finding, sources) {
  const missing = []
  const unverified = []
  const asText = (value) => (typeof value === 'string' ? value.trim() : '')
  const file = asText(finding?.file)
  if (!file) missing.push('file')
  if (!['CRITICAL', 'MAJOR', 'MINOR'].includes(finding?.severity)) missing.push('severity')
  if (!asText(finding?.summary)) missing.push('summary')
  const kind = FINDING_KINDS.includes(finding?.kind) ? finding.kind : null
  if (!kind) missing.push('kind')
  const evidence = asText(finding?.evidence)
  if (!evidence || !FINDING_IDENTIFIER.test(evidence)) missing.push('evidence')
  if (kind === 'defect') {
    if (!Number.isInteger(finding?.line) || finding.line < 1) missing.push('line')
    const repro = finding?.repro ?? {}
    const expected = asText(repro.expected)
    const actual = asText(repro.actual)
    if (!asText(repro.when)) missing.push('repro.when')
    if (!expected) missing.push('repro.expected')
    if (!actual) missing.push('repro.actual')
    // 期望与实际写成同一句话等于没写复现：这条发现自己证明了自己不成立。
    if (expected && expected === actual) missing.push('repro.actual')
  }
  if (kind === 'design') {
    const basis = finding?.basis ?? {}
    if (!asText(basis.quote)) missing.push('basis.quote')
    if (!asText(basis.conflict)) missing.push('basis.conflict')
  }
  if (finding?.severity !== 'MINOR') {
    const counter = finding?.counter ?? {}
    if (!asText(counter.attempt)) missing.push('counter.attempt')
    if (counter.survived !== true) missing.push('counter.survived')
  }
  // 形状不全时不读文件：先补字段，别让「文件里找不到」掩盖「根本没写」。
  if (missing.length) return { missing, unverified }
  const source = findingSource(flow, file, sources)
  if (!source) {
    unverified.push('无法读取 ' + file + '（文件不存在或不在项目内）')
    return { missing, unverified }
  }
  if (!source.words.has(evidence)) unverified.push('evidence 标识符 ' + evidence + ' 不在 ' + file + ' 中')
  if (kind === 'defect' && finding.line > source.lineCount) {
    unverified.push('line ' + finding.line + ' 超出 ' + file + ' 的 ' + source.lineCount + ' 行')
  }
  if (kind === 'design') {
    const quote = finding?.basis?.quote
    if (typeof quote === 'string' && !source.lines.includes(quote)) unverified.push('basis.quote 不是 ' + file + ' 中真实存在的一行')
  }
  // 位置以实际读到的文件为凭：后续判断「这条发现是否在 scope 内」只用这个值，
  // 不再相信子代理自填的 file 字符串。
  return { missing, unverified, resolvedFile: source.path }
}

/** 发现字段一律按上限裁剪：新字段和老字段走同一套，超长原文不能借新字段进快照。 */
function clampFinding(finding) {
  const item = finding && typeof finding === 'object' ? finding : {}
  // 非字符串一律丢弃：子代理入口不经 schema，原样保留对象就能把任意大的嵌套值写进快照，
  // 而超过 8 MiB 的快照在冷恢复时会被整条跳过——一条伪造的额外字段足以让流程重启后消失。
  const clip = (value, limit) => (typeof value === 'string' ? clampText(value, limit) : undefined)
  // 长文本按原文核实后再裁剪；指纹让不同的期望/实际在快照里仍可区分。
  const clipProof = (value, limit) => typeof value !== 'string' ? undefined
    : value.length > limit
      ? value.slice(0, limit) + '…（超长已截断，SHA-256 ' + createHash('sha256').update(value).digest('hex').slice(0, 16) + '）'
      : value
  const normalized = {
    kind: item.kind,
    line: item.line,
    severity: item.severity,
    file: clampText(item.file, 400),
    ac: typeof item.ac === 'string' ? clampText(item.ac, 64) : undefined,
    summary: clampText(item.summary, FINDING_SUMMARY_LIMIT),
    evidence: clip(item.evidence, FINDING_EVIDENCE_LIMIT),
  }
  if (item.repro !== undefined) {
    normalized.repro = item.repro && typeof item.repro === 'object'
      ? { when: clip(item.repro.when, FINDING_SHORT_LIMIT), expected: clipProof(item.repro.expected, FINDING_SHORT_LIMIT), actual: clipProof(item.repro.actual, FINDING_SHORT_LIMIT) }
      : undefined
  }
  if (item.basis !== undefined) {
    normalized.basis = item.basis && typeof item.basis === 'object'
      ? { quote: clipProof(item.basis.quote, FINDING_TEXT_LIMIT), conflict: clip(item.basis.conflict, FINDING_TEXT_LIMIT) }
      : undefined
  }
  if (item.counter !== undefined) {
    normalized.counter = item.counter && typeof item.counter === 'object'
      ? { attempt: clip(item.counter.attempt, FINDING_TEXT_LIMIT), survived: item.counter.survived }
      : undefined
  }
  return normalized
}

/** 两条评审入口共用原始数量检查，禁止未校验的超限项补入计数。 */
function assertFindingLimits(angles) {
  const exceeded = (Array.isArray(angles) ? angles : [])
    .filter((angle) => Array.isArray(angle?.findings) && angle.findings.length > FINDINGS_LIMIT)
  if (!exceeded.length) return
  const listed = exceeded.slice(0, 10).map((angle) => {
    const name = (typeof angle?.name === 'string' ? angle.name.trim() : '')
      || (typeof angle?.id === 'string' ? angle.id.trim() : '') || '未命名角度'
    const end = name.length > 120 && /[\uD800-\uDBFF]/.test(name[119]) ? 119 : 120
    return clampText(name, end) + ' ' + angle.findings.length + ' 条'
  })
  if (exceeded.length > 10) listed.push('另有 ' + (exceeded.length - 10) + ' 个角度超限')
  throw new RangeError(clampText('这些评审角度的发现超过单角度上限 ' + FINDINGS_LIMIT + ' 条：'
    + listed.join('、') + '；请缩减到上限以内后重新提交整份报告。', 2000))
}

/**
 * 测试方向与验证要点的条数上限：手工提交超限整份拒绝。
 *
 * 这里曾经是 slice(0, REPORT_ENTRY_LIMIT) 之后再统计 failed：第 41 个方向里的
 * 失败条目从账本里凭空消失，门禁于是报告「0 失败」并放行。裁剪要么发生在判定
 * 之后、并且把丢了多少写进返回体，要么干脆不发生——手工报告选了后者：提交方
 * 自己能缩减，就不该由宿主替它决定哪条失败不重要。
 */
function assertDirectionLimits(directions) {
  const items = Array.isArray(directions) ? directions : []
  const problems = []
  if (items.length > REPORT_ENTRY_LIMIT) {
    problems.push('测试方向 ' + items.length + ' 条（上限 ' + REPORT_ENTRY_LIMIT + ' 条）')
  }
  const wide = []
  items.forEach((direction, index) => {
    const count = Array.isArray(direction?.points) ? direction.points.length : 0
    if (count <= POINT_LIMIT) return
    const name = (typeof direction?.name === 'string' ? direction.name.trim() : '')
      || (typeof direction?.id === 'string' ? direction.id.trim() : '') || '第 ' + (index + 1) + ' 个方向'
    wide.push(clampText(name, 120) + ' ' + count + ' 条')
  })
  if (wide.length) {
    const listed = wide.slice(0, 10)
    if (wide.length > 10) listed.push('另有 ' + (wide.length - 10) + ' 个方向超限')
    problems.push('单个方向的验证要点超过上限 ' + POINT_LIMIT + ' 条：' + listed.join('、'))
  }
  if (!problems.length) return
  throw new RangeError(clampText('测试报告超过条数上限，宿主没有截断后再统计：' + problems.join('；')
    + '。请缩减到上限以内后重新提交整份报告——被截掉的失败条目会从账本里消失。', 2000))
}

/** 验收证据条数上限：同样整份拒绝，不替提交方挑哪条证据不重要。 */
function assertAcceptanceLimits(records) {
  const count = Array.isArray(records) ? records.length : 0
  const limit = REPORT_ENTRY_LIMIT * 4
  if (count <= limit) return
  throw new RangeError(clampText('验收证据 ' + count + ' 条，超过单次提交上限 ' + limit
    + ' 条；请缩减后重新提交，宿主不会替你丢掉排在后面的证据。', 2000))
}

/** 评审角度条数上限：超限整份拒绝，别让后面的角度连账本都进不去。 */
function assertAngleLimits(angles) {
  const count = Array.isArray(angles) ? angles.length : 0
  if (count <= REPORT_ENTRY_LIMIT) return
  throw new RangeError(clampText('评审角度 ' + count + ' 个，超过单次提交上限 ' + REPORT_ENTRY_LIMIT
    + ' 个；请合并或缩减后重新提交整份报告。', 2000))
}

function normalizeSubmittedAngles(flow, angles) {
  assertFindingLimits(angles)
  assertAngleLimits(angles)
  const sources = new Map()
  const rank = { CRITICAL: 0, MAJOR: 1, MINOR: 2 }
  // 条数已由 assertAngleLimits 挡在上限内：这里不再 slice，避免静默丢掉整个角度。
  return (Array.isArray(angles) ? angles : []).map((angle) => {
    // 先按提交顺序编号再排序截断：报错要能指回提交者实际写下的第几条。
    const pairs = (Array.isArray(angle?.findings) ? angle.findings : [])
      .map((raw, index) => ({ raw, finding: clampFinding(raw), index }))
    pairs.sort((left, right) => (rank[left.finding?.severity] ?? 3) - (rank[right.finding?.severity] ?? 3))
    const rejectedFindings = []
    const findings = []
    for (const { raw, finding, index } of pairs) {
      const verdict = checkFinding(flow, raw, sources)
      if (verdict.missing.length) {
        // 只留定位与缺失字段：不把非法值或原文带进快照。
        rejectedFindings.push({ index, severity: ['CRITICAL', 'MAJOR', 'MINOR'].includes(finding.severity) ? finding.severity : 'INVALID', missing: verdict.missing })
        continue
      }
      // resolvedFile 由 checkFinding 的读取结果写入，不是提交字段：clampFinding 不会保留
      // 提交者自填的同名值，这里再覆盖一次。
      const positioned = verdict.resolvedFile ? { ...finding, resolvedFile: clampText(verdict.resolvedFile, 400) } : finding
      findings.push(verdict.unverified.length ? { ...positioned, unverified: true, unverifiedReason: clampText(verdict.unverified.join('；'), FINDING_SUMMARY_LIMIT) } : positioned)
    }
    const declared = angle?.verdict
    const derived = findings.some((item) => item.severity !== 'MINOR' && item.unverified !== true) ? 'blocking'
      : findings.length ? 'advisory' : 'pass'
    const normalized = { id: clampText(angle?.id, 64), name: clampText(angle?.name, 120),
      verdict: derived, suggestUpgrade: angle?.suggestUpgrade === true, findings }
    if (declared !== derived) normalized.verdictConflict = { declared, derived }
    // 没有丢弃项时不写这个键：字段存在就代表「有发现没进来」。
    if (rejectedFindings.length) normalized.rejectedFindings = rejectedFindings
    return normalized
  })
}

const ACCEPTANCE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      ac: { type: 'string' }, status: { type: 'string', enum: ['pass', 'fail', 'uncovered', 'excluded'] },
      excludeReason: { type: 'string', description: 'status=excluded 时必填：这条验收标准为什么在当前环境无法验证（缺依赖、需要网络或特权、需要特定系统）。只写原因不算数：必须同时提交 probe，否则按未覆盖处理。' },
      probe: {
        type: 'object',
        description: 'status=excluded 时必填：真的跑过那条命令的探测记录。command 必须在 scope.commands 清单内，exitCode 必须是非零整数，failure 写报错原文。',
        properties: {
          command: { type: 'string' }, exitCode: { type: 'integer' }, failure: { type: 'string' },
        },
        required: ['command', 'exitCode', 'failure'], additionalProperties: false,
      },
      method: { type: 'string', enum: ['unit', 'integration', 'visual', 'manual'] },
      summary: { type: 'string', description: '可选：一句话说明是怎么验证的，不参与判定。不要在这里写「文件:行号」冒充证据——要写就写进 citations。' },
      version: { type: 'string', description: '可省略：省略时由工具自动填当前内容快照 id。仅当证据确实对应另一份代码（例如重跑旧版本）时才显式填写；与当前快照不一致的证据不会被补盖当前版本，会按未覆盖计入账本。' },
      citations: {
        type: 'array',
        description: '通过结论必须给出实际证据位置：文件、行号与该行里的关键片段。宿主会读文件核对，对不上按未覆盖处理。',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string', description: '项目内相对路径；必须在冻结 scope 内或是 test/ 下的测试文件。' },
            line: { type: 'integer', description: '行号，从 1 开始。' },
            anchor: { type: 'string', description: '该行里真实出现的关键片段（逐字符照抄）；行号会漂，anchor 才是核对依据，允许 ±3 行。' },
          },
          required: ['file', 'line', 'anchor'],
          additionalProperties: false,
        },
      },
      command: { type: 'string', description: 'unit/integration 通过时必填：实际执行的命令，必须在 scope 的命令清单内。人工核验（manual）不需要。' },
      exitCode: { type: 'integer', description: 'command 的退出码，必须为 0。' },
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
    }, required: ['ac', 'status', 'method'], additionalProperties: false,
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
  // 不在这里截断：这些记录直接进账本，被截掉的条目不等于「没有这条证据」。
  // 单次提交的条数上限由 assertAcceptanceLimits 在入口把关。
  return (Array.isArray(records) ? records : []).map((entry) => {
    if (!criteria.has(entry?.ac)) throw new Error('验收证据引用了未声明的标准：' + String(entry?.ac))
    // 单条证据内部的测量与引用同样不截断：少一条测量会让账本比对失败，
    // 少一条引用会让「引用过的文件」凭空消失。超限就拒绝，让提交方自己缩减。
    const rawMeasurements = Array.isArray(entry?.measurements) ? entry.measurements : []
    if (rawMeasurements.length > MEASUREMENT_LIMIT) {
      throw new RangeError('验收证据 ' + String(entry?.ac) + ' 带了 ' + rawMeasurements.length
        + ' 条视觉测量，超过单条上限 ' + MEASUREMENT_LIMIT + ' 条；宿主不会替你丢掉后面的测量，请缩减后重新提交。')
    }
    const rawCitations = Array.isArray(entry?.citations) ? entry.citations : []
    if (rawCitations.length > CITATION_ENTRY_LIMIT) {
      throw new RangeError('验收证据 ' + String(entry?.ac) + ' 带了 ' + rawCitations.length
        + ' 条文件引用，超过单条上限 ' + CITATION_ENTRY_LIMIT + ' 条；宿主不会替你丢掉后面的引用，请缩减后重新提交。')
    }
    const measurements = rawMeasurements.map((item) => ({
      element: clampText(item?.element, 400), reference: clampText(item?.reference, 400),
      left: item?.left, right: item?.right, referenceLeft: item?.referenceLeft, referenceRight: item?.referenceRight,
    }))
    // probe 是环境受限的唯一可信凭据：命令、退出码、失败原文都由执行方留下，
    // 少了它，excludeReason 又变回「一句理由就免验」。
    const probe = entry?.probe && typeof entry.probe === 'object'
      ? { command: clampText(entry.probe.command, 400), exitCode: entry.probe.exitCode, failure: clampText(entry.probe.failure, 4000) }
      : undefined
    return {
      ac: entry.ac, status: entry.status, method: entry.method, excludeReason: clampText(entry.excludeReason, 400), probe,
      summary: clampText(entry.summary, 1000), version: clampText(entry.version, 64), artifact: clampText(entry.artifact, 1000),
      citations: rawCitations.map((item) => ({
        file: clampText(item?.file, 400), line: item?.line, anchor: clampText(item?.anchor, 1000),
      })),
      command: clampText(entry.command, 1000), exitCode: entry.exitCode,
      evidenceId: clampText(entry.evidenceId, 64),
      runtime: entry.runtime ? { hostRevision: entry.runtime.hostRevision, clientRevision: entry.runtime.clientRevision, pageId: entry.runtime.pageId, viewport: entry.runtime.viewport } : undefined,
      measurements,
    }
  })
}

function normalizeSubmittedDirections(directions) {
  assertDirectionLimits(directions)
  return (Array.isArray(directions) ? directions : []).map((direction) => ({
    ...direction,
    id: clampText(direction?.id, 64),
    name: clampText(direction?.name, 120),
    points: (Array.isArray(direction?.points) ? direction.points : []).map((point) => ({
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
      '提交 S3 评审报告：交件立即返回（decision=submitted），门禁随之打开；交完调用 flowgate_wait 等用户点「通过评审」或「退回开发修复」。',
      '内容与上一份完全相同时不覆盖、不重跑，直接返回已提交。',
      '每个启用角度一节；每条发现必须带 file:line 与 severity（CRITICAL/MAJOR/MINOR）。',
      '每条发现还要带 ac：把它挂到冻结 scope 里已声明的验收标准 id 上（如 AC-3）。',
      '对不上任何验收标准的发现、以及落在冻结 scope 文件之外的发现，都会被降级成建议、不进重做清单——照实写，但别把它们当阻塞项。',
      'fast 档位只缩减默认评审角度；每角度按原始发现数计算上限 200 条，任一角度超限即拒绝整份报告，请缩减后重新提交。MINOR 仍计入发现和建议总数。',
      '可用 acceptance 逐条记录 AC 的缺陷或未覆盖；通过评审不能替代实际执行验证。accepted 证据的 version 可省略，省略时工具自动填当前内容快照 id。',
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
                    severity: { type: 'string', description: '必填：CRITICAL、MAJOR 或 MINOR；非法值由逐条校验记录。' },
                    kind: {
                      type: 'string',
                      description:
                        '缺陷类型，决定还要写哪些证据：defect 是「代码没做到声明的行为」，必须给 line 与 repro；' +
                        'design 是「做到了，但与约定冲突」，必须给 basis。两类要求不同，不要混写。',
                    },
                    ac: {
                      type: 'string',
                      description:
                        '这条发现对应的验收标准 id（冻结 scope 的 acceptance_criteria 里声明过的，如 AC-1）。' +
                        '对不上任何验收标准的发现会被降级成建议、不计入重做清单。',
                    },
                    summary: { type: 'string' },
                    evidence: {
                      type: 'string',
                      description:
                        '你读到的那个标识符原文：必须是 file 里真实出现的一个函数名 / 变量名（逐字符照抄，可用 Unicode）。' +
                        '宿主会到该文件里核对它是否存在，对不上就把这条降为「未核实」、不进重做清单。' +
                        '写「已检查过相关逻辑」这类描述不算证据。',
                    },
                    repro: {
                      type: 'object',
                      description: 'kind=defect 必填：怎么复现。expected 与 actual 不能是同一句话。',
                      properties: {
                        when: { type: 'string', description: '触发它的输入 / 命令 / 操作序列。' },
                        expected: { type: 'string', description: '按声明的行为应该发生什么。' },
                        actual: { type: 'string', description: '实际发生了什么（含报错原文）。' },
                      },
                      additionalProperties: false,
                    },
                    basis: {
                      type: 'object',
                      description: 'kind=design 必填：现状与约定的冲突点。',
                      properties: {
                        quote: { type: 'string', description: '现状那一行的原文（逐字符照抄，宿主会核对它是该文件里真实存在的一行）。' },
                        conflict: { type: 'string', description: '它违反了哪条约定 / 规则 id / 需求条目。' },
                      },
                      additionalProperties: false,
                    },
                    counter: {
                      type: 'object',
                      description: 'severity 为 CRITICAL / MAJOR 时必填：上报前先反驳自己一次。',
                      properties: {
                        attempt: { type: 'string', description: '「我尝试这样反驳自己：……」写清反驳路径。' },
                        survived: {
                          type: 'boolean',
                          description: '必须填 true：反驳没能推翻这条发现；填 false 会由逐条校验丢弃。',
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  // 缺字段必须到达 execute，才能逐条记录 rejectedFindings 并保留合格同伴。
                  // 必填和条件必填由 normalizeSubmittedAngles 的 checkFinding 统一执行。
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
          decision: { type: 'string', description: SUBMIT_DECISION_DESC },
          submitted: SUBMITTED_SCHEMA,
          next: { type: 'string' },
          blocking: { type: 'number' },
          message: { type: 'string' },
          waitReason: {
            type: 'string',
            description: '等待中断的原因：timeout（等满上限）/ superseded（被新的等待取代）/ aborted（调用被取消）。只有等待中断时才有值。',
          },
          willWake: {
            type: 'boolean',
            description: '现在是否还有等待器：false 表示用户点按钮只会记录决定，不会唤醒你。',
          },
          gateId: {
            type: 'string',
            description: '这次等待的门禁 id（落盘的请求记录里读回，重启后仍然有效）。',
          },
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
      // 内容完全相同的重提：不覆盖、不换 id，直接告诉 Agent「这份已经交过了」。
      // 报告是整体赋值，放过去就会把上一轮结论连同复用基础一起顶掉。
      const previousReview = flow.review
      if (previousReview && previousReview.blocking === blocking && sameSubmission(previousReview.angles, angles)) {
        const openRequest = gateRequestOf(flow.stages[flow.stage])
        return {
          decision: 'submitted',
          next: flow.stage,
          blocking,
          submitted: submissionPayload({ kind: 'review', label: '评审报告', id: previousReview.id, detail: '阻塞 ' + blocking + ' 条' }),
          ...(openRequest?.id ? { gateId: openRequest.id } : {}),
          message: '这份评审报告已经提交过（id ' + previousReview.id + '），内容和这次完全相同：本次没有重复提交，也没有覆盖上一份。'
            + '门禁还开着——调用 flowgate_wait 等用户点按钮，不要继续做 S4 的工作。',
        }
      }
      const snapshot = currentSnapshot(flow)
      const acceptance = reportAcceptance(flow, 'review', angles, merged.reused, args.acceptance, snapshot)
      flow.review = { id: randomUUID(), angles, blocking, advisories: gated.advisories, counts: gated.counts, snapshot, acceptance, at: nowIso(), reused: merged.reused, fresh: angles.length - merged.reused.length }
      flow.execution = { status: 'completed', text: '手工评审报告已接收；实际执行证据见验收账本。', stage: 'S3', at: nowIso() }
      if (merged.reused.length) dropCarryOver(flow, 'angles', merged.reused)
      appendEvent(cwd, flow, 'review.submitted', { angles: angles.length, blocking, advisories: gated.advisories, reused: merged.reused })
      persist(flow)

      // 交件到此为止：评审报告已落盘，开闸后立刻返回，等签收交给 flowgate_wait。
      return submitGate(flow, 'gate', {
        kind: 'review',
        label: '评审报告',
        id: flow.review?.id ?? '',
        detail: '阻塞 ' + blocking + ' 条',
        tool: 'flowgate_review',
      }, { next: flow.stage, blocking })
    },
  }
}

/**
 * 未进重做清单的发现条数说明。
 * 被降级的发现不是被丢掉，而是不进重做清单：用户和 Agent 都要知道这个差别。
 */
function advisoryNote(flow) {
  // 回退会清掉 flow.review（旧评审不再作数），但建议条数已经跟着修复清单落盘：
  // 先读修复清单，再退回读评审报告——否则「点按钮那一侧先落盘」之后这里永远是 0。
  const count = flow.remediation?.advisories?.length ?? flow.review?.advisories ?? 0
  if (!count) return ''
  return '另有 ' + count + ' 条非阻塞发现（含 MINOR、范围外建议及未核实条目），仍计入发现总数；AC 是否通过请另看验收账本。'
}

/** S3 出口门禁：等用户点「通过评审」/「退回开发修复」。 */
async function waitReviewGate(service, flow, sessionId, exec, reuse, blocking) {
  const outcome = await awaitGate(service, flow, sessionId, 'gate', exec, flow.stage, reuse)
  const decision = outcome.kind
  if (decision === 'stale') {
    return { decision, next: flow.stage, blocking, message: gateStaleNote(flow) }
  }
  if (decision === 'timeout' || decision === 'aborted' || decision === 'superseded') {
    const wait = gateWaitPayload(outcome, {
      kind: 'review',
      label: '评审报告',
      id: flow.review?.id ?? '',
      detail: '阻塞 ' + blocking + ' 条',
      tool: 'flowgate_review',
    })
    return {
      decision: 'halt',
      next: flow.stage,
      blocking,
      waitReason: wait.waitReason,
      willWake: wait.willWake,
      gateId: wait.gateId,
      ...(wait.submitted ? { submitted: wait.submitted } : {}),
      message: wait.note,
    }
  }
  if (decision === 'cancelled') {
    return { decision, next: 'cancelled', blocking, message: '用户放弃了这次流程，评审结果作废。' }
  }
  if (decision === 'scope-reopened') {
    // 补命令会退回 S1 改 scope：这份评审的前提没了，绝不能继续当它有效。
    return {
      decision: 'reopened',
      next: flow.stage,
      blocking,
      message: reopenedMessage(outcome.supplemented, '这份评审'),
    }
  }
  if (decision === 'pass') {
    if (!outcome.applied) passGate(flow, 'pass', outcome)
    return {
      decision,
      next: flow.stage,
      blocking,
      message: '评审通过，进入 S4 测试阶段。' + advisoryNote(flow) +
        '现在直接开始 S4 测试，不要在阶段交界处停下等用户再说一句。' + wakeNotesText(outcome.notes),
    }
  }
  if (decision === 'accept-risk') {
    if (!outcome.applied) passGate(flow, 'accept-risk', outcome)
    return { decision, next: flow.stage, blocking, message: '用户已接受当前评审的阻塞风险，进入 S4 测试；评审未通过。' +
      '现在直接开始 S4 测试，不要在阶段交界处停下等用户再说一句。' + wakeNotesText(outcome.notes) }
  }
  if (decision === 'skip') {
    if (!outcome.applied) passGate(flow, 'skip', outcome)
    return {
      decision,
      next: flow.stage,
      blocking,
      message: '用户跳过了评审门禁，进入 ' + flow.stage + '。现在直接开始该阶段的工作，不要在阶段交界处停下等用户再说一句。' +
        wakeNotesText(outcome.notes),
    }
  }
  if (decision === 'back') {
    // 回退会清掉 flow.review，建议条数必须在清空之前算好，否则文案里永远是 0 条。
    const note = advisoryNote(flow)
    // 升档导致的退回也走这一支：对 Agent 来说它与「退回开发修复」是同一件事，
    // 只是回退在点击那一侧已经落过盘（applied），这里不再回退第二次。
    if (!outcome.applied) rollbackTo(flow, outcome.to === 'S1' ? 'S1' : 'S2', 'review-rejected', outcome.note ?? '')
    return {
      decision: 'reject',
      next: flow.stage,
      blocking,
      message: '用户退回到 ' + flow.stage + ' 重做。' + note +
        '请同时处理阻塞发现和验收账本的失败/未覆盖项；严重度与验收状态分别记录。' + remediationNote(flow) +
        wakeNotesText(outcome.notes),
    }
  }
  throw new Error(
    '评审门禁结果没有可处理的分支：' + String(decision) +
    '。这是唤醒协议与消费端不同步，请把这个错误报告出来——不要自己猜一个结果继续往下做。',
  )
}

function testTool(scoped) {
  return {
    name: 'flowgate_test',
    description: [
      '提交 S4 测试报告：交件立即返回（decision=submitted），门禁随之打开；交完调用 flowgate_wait 等用户点「验收通过」或「退回开发修复」。',
      '内容与上一份完全相同时不覆盖、不重跑，直接返回已提交。',
      '按测试方向分组，每个验证要点给出 通过 / 失败 / 未覆盖。',
      '还须提交 acceptance，逐条说明 AC 的 method、status；填 pass 时要给 citations（文件 + 行号 + 该行关键片段），unit/integration 还要给 command 与 exitCode，宿主会读文件核对，对不上按未覆盖处理。version 可省略，省略时工具自动填当前内容快照 id。没有可核对的证据不能填 pass。',
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
          decision: { type: 'string', description: SUBMIT_DECISION_DESC },
          submitted: SUBMITTED_SCHEMA,
          next: { type: 'string' },
          failed: { type: 'number' },
          message: { type: 'string' },
          waitReason: {
            type: 'string',
            description: '等待中断的原因：timeout（等满上限）/ superseded（被新的等待取代）/ aborted（调用被取消）。只有等待中断时才有值。',
          },
          willWake: {
            type: 'boolean',
            description: '现在是否还有等待器：false 表示用户点按钮只会记录决定，不会唤醒你。',
          },
          gateId: {
            type: 'string',
            description: '这次等待的门禁 id（落盘的请求记录里读回，重启后仍然有效）。',
          },
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

      assertAcceptanceLimits(args.acceptance)
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
      // 与 S3 同理：内容一样就不覆盖，避免中断后的重跑把上一份测试结论顶掉。
      const previousTest = flow.test
      if (previousTest && previousTest.failed === failed && sameSubmission(previousTest.directions, directions)) {
        const openRequest = gateRequestOf(flow.stages[flow.stage])
        return {
          decision: 'submitted',
          next: flow.stage,
          failed,
          submitted: submissionPayload({ kind: 'test', label: '测试报告', id: previousTest.snapshot?.id ?? '', detail: '失败 ' + failed + ' 条' }),
          ...(openRequest?.id ? { gateId: openRequest.id } : {}),
          message: '这份测试报告已经提交过（快照 ' + (previousTest.snapshot?.id ?? '未知') + '），内容和这次完全相同：本次没有重复提交，也没有覆盖上一份。'
            + '门禁还开着——调用 flowgate_wait 等用户点按钮。',
        }
      }
      const snapshot = currentSnapshot(flow)
      const acceptance = reportAcceptance(flow, 'test', directions, merged.reused, args.acceptance, snapshot)
      flow.test = { directions, failed, excluded, snapshot, acceptance, at: nowIso(), reused: merged.reused, fresh: directions.length - merged.reused.length }
      flow.execution = { status: 'completed', text: '手工测试报告已接收；实际执行证据见验收账本。', stage: 'S4', at: nowIso() }
      if (merged.reused.length) dropCarryOver(flow, 'directions', merged.reused)
      appendEvent(cwd, flow, 'test.submitted', { directions: directions.length, failed, excluded, reused: merged.reused })
      persist(flow)

      // 交件到此为止：测试报告已落盘，开闸后立刻返回，等签收交给 flowgate_wait。
      return submitGate(flow, 'gate', {
        kind: 'test',
        label: '测试报告',
        id: flow.test?.snapshot?.id ?? '',
        detail: '失败 ' + failed + ' 条',
        tool: 'flowgate_test',
      }, { next: flow.stage, failed })
    },
  }
}

/**
 * 签收：门禁已经由交件工具打开，这里只负责挂起等用户点按钮。
 *
 * 与四个交件工具的分工是这次拆分的全部意义：交件不等，所以交件不会中断、也不会被重跑；
 * 只有这里会中断，而中断时返回的 submitted 回执说明产物早就交上去了。
 */
function waitTool(scoped) {
  return {
    name: 'flowgate_wait',
    description: [
      '等用户在当前阶段的门禁上点按钮，并把决定带回来。',
      '交件工具（flowgate_doc / flowgate_gate / flowgate_review / flowgate_test）会立即返回「已提交」，交完必须调用本工具，否则流程停在这里没人往下走。',
      '调用前不要重复提交产物：产物已经落盘，重跑只会覆盖它并白烧一轮。',
      'gateId 可以省略；带上交件时返回的 gateId，表示「等的就是那一张门禁」。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        gateId: {
          type: 'string',
          description: '交件时返回的门禁 id：确认等的是同一张闸，而不是被别的等待顶掉。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          decision: { type: 'string', description: WAIT_DECISION_DESC },
          submitted: SUBMITTED_SCHEMA,
          stage: { type: 'string' },
          next: { type: 'string' },
          preset: { type: 'string' },
          frozen: { type: 'boolean' },
          blocking: { type: 'number' },
          failed: { type: 'number' },
          scopeRisks: {
            type: 'array',
            items: { type: 'string' },
            description: 'S1 批准前静态体检出的验收方案缺口（每条一句）。空数组表示没有发现缺口。',
          },
          message: { type: 'string' },
          waitReason: {
            type: 'string',
            description: '等待中断的原因：timeout（等满上限）/ superseded（被新的等待取代）/ aborted（调用被取消）。只有等待中断时才有值。',
          },
          willWake: {
            type: 'boolean',
            description: '现在是否还有等待器：false 表示用户点按钮只会记录决定，不会唤醒你。',
          },
          gateId: {
            type: 'string',
            description: '这次等待的门禁 id（落盘的请求记录里读回，重启后仍然有效）。',
          },
        },
        required: ['decision', 'message'],
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
      const reuse = typeof args.gateId === 'string' && args.gateId ? args.gateId : undefined

      // 没有产物就挂起，等的是一个永远不会出现的按钮：当场说清，别让 Agent 卡到超时。
      const ready = stage === 'S1' ? Boolean(flow.doc) : gateArtifactReady(flow)
      if (!ready) {
        return {
          decision: 'stale',
          stage,
          message: stage === 'S1'
            ? '当前在 S1（需求分析），还没有提交需求文档（flowgate_doc）。先交件，再调用 flowgate_wait。'
            : gateNoArtifactNote(flow),
        }
      }

      // 这里不再自己判「这张闸是不是已经收尾」：收尾只说明上一次等待结束过，
      // 不说明用户点过按钮。真点过的话阶段已经推进、或本阶段 gate 不再是 pending，
      // awaitGate 的循环第一句就会把它识别成 stale——那才是唯一该信的判据。
      if (stage === 'S1') return waitDocGate(service, flow, sessionId, exec, reuse)
      if (stage === 'S2') return waitDevGate(service, flow, sessionId, exec, reuse, stage)
      if (stage === 'S3') return waitReviewGate(service, flow, sessionId, exec, reuse, flow.review?.blocking ?? 0)
      if (stage === 'S4') return waitTestGate(service, flow, sessionId, exec, reuse, flow.test?.failed ?? 0)
      throw new Error('未知阶段：' + String(stage) + '。这是流程状态坏了，请把这个错误报告出来。')
    },
  }
}

/** S4 出口门禁：等用户点「验收通过」/「退回开发修复」。 */
async function waitTestGate(service, flow, sessionId, exec, reuse, failed) {
  const outcome = await awaitGate(service, flow, sessionId, 'gate', exec, flow.stage, reuse)
  const decision = outcome.kind
  if (decision === 'stale') {
    return { decision, next: flow.stage, failed, message: gateStaleNote(flow) }
  }
  if (decision === 'timeout' || decision === 'aborted' || decision === 'superseded') {
    const wait = gateWaitPayload(outcome, {
      kind: 'test',
      label: '测试报告',
      id: flow.test?.snapshot?.id ?? '',
      detail: '失败 ' + failed + ' 条',
      tool: 'flowgate_test',
    })
    return {
      decision: 'halt',
      next: flow.stage,
      failed,
      waitReason: wait.waitReason,
      willWake: wait.willWake,
      gateId: wait.gateId,
      ...(wait.submitted ? { submitted: wait.submitted } : {}),
      message: wait.note,
    }
  }
  if (decision === 'cancelled') {
    return { decision, next: 'cancelled', failed, message: '用户放弃了这次流程，测试结果作废。' }
  }
  if (decision === 'scope-reopened') {
    return {
      decision: 'reopened',
      next: flow.stage,
      failed,
      message: reopenedMessage(outcome.supplemented, '这份测试结果'),
    }
  }
  if (decision === 'pass') {
    if (!outcome.applied) passGate(flow, 'pass', outcome)
    const label = flow.acceptanceDecision?.status === 'accepted-with-gaps' ? '用户已明确接受未通过或未覆盖项，流程以例外结束；这些验收项仍保留原状态。' : '验收通过，流程结束。'
    return { decision, next: 'done', failed, message: label + '完整记录已写入 flows.jsonl。' + wakeNotesText(outcome.notes) }
  }
  if (decision === 'skip') {
    // 跳过和通过共用一套校验：缺口必须同样由用户显式接受，
    // 所以这里要把 outcome 一起传下去，否则第二道校验会丢掉 acceptUncovered。
    if (!outcome.applied) passGate(flow, 'skip', outcome)
    return { decision, next: 'done', failed, message: '用户跳过验收门禁，流程结束。' + wakeNotesText(outcome.notes) }
  }
  if (decision === 'back') {
    if (!outcome.applied) rollbackTo(flow, 'S2', 'test-rejected', outcome.note ?? '')
    // 改道 S1 时 flow.stage 已经不是 S2 了：文案必须跟着实际状态走，
    // 否则用户看到「退回 S2」、工作台却停在 S1，只会以为按钮坏了。
    const note = stallNote(flow)
    const message = flow.stage === 'S1'
      ? '已改道 S1：' + note + '。改代码这条路走不通，请改验收方案或接受缺口。'
      : '用户退回到 S2 修复。' + note
    return { decision: 'reject', next: flow.stage, failed, message: message + remediationNote(flow) + wakeNotesText(outcome.notes) }
  }
  throw new Error(
    '测试门禁结果没有可处理的分支：' + String(decision) +
    '。这是唤醒协议与消费端不同步，请把这个错误报告出来——不要自己猜一个结果继续往下做。',
  )
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
      // 与界面按钮走同一条收尾路径：叫醒所有挂起的工具。
      // 这里显式传 null（任意等待器）：放弃流程要连追问卡片一起作废，
      // 所以不能只发给门禁——这是全库唯一一处「谁在等都算」的地方。
      service.gates.notify(sessionId, { type: 'signal', signal: 'cancelled' }, null)
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
      '收集结构化报告后聚合，落盘后在同一次调用里挂起等签收（与 flowgate_review + flowgate_wait 分两步不同）；',
      '等待被中断时返回 decision: halt 与 submitted 回执——产物已经保存，不要重新提交这份报告。',
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
          decision: { type: 'string', description: RUN_DECISION_DESC },
          submitted: SUBMITTED_SCHEMA,
          next: { type: 'string' },
          blocking: { type: 'number' },
          angles: { type: 'number' },
          message: { type: 'string' },
          waitReason: {
            type: 'string',
            description: '等待中断的原因：timeout（等满上限）/ superseded（被新的等待取代）/ aborted（调用被取消）。只有等待中断时才有值。',
          },
          willWake: {
            type: 'boolean',
            description: '现在是否还有等待器：false 表示用户点按钮只会记录决定，不会唤醒你。',
          },
          gateId: {
            type: 'string',
            description: '这次等待的门禁 id（落盘的请求记录里读回，重启后仍然有效）。',
          },
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

      // 第六位才是 blocking：第五位是 gateId 复用，这里没有交件动作可复用。
      const outcome = await waitReviewGate(service, flow, sessionId, exec, undefined, blocking)
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
      '收集「方向 × 要点」的结构化结果后聚合，落盘后在同一次调用里挂起等签收（与 flowgate_test + flowgate_wait 分两步不同）；',
      '等待被中断时返回 decision: halt 与 submitted 回执——产物已经保存，不要重新提交这份报告。',
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
          decision: { type: 'string', description: RUN_DECISION_DESC },
          submitted: SUBMITTED_SCHEMA,
          next: { type: 'string' },
          failed: { type: 'number' },
          directions: { type: 'number' },
          message: { type: 'string' },
          waitReason: {
            type: 'string',
            description: '等待中断的原因：timeout（等满上限）/ superseded（被新的等待取代）/ aborted（调用被取消）。只有等待中断时才有值。',
          },
          willWake: {
            type: 'boolean',
            description: '现在是否还有等待器：false 表示用户点按钮只会记录决定，不会唤醒你。',
          },
          gateId: {
            type: 'string',
            description: '这次等待的门禁 id（落盘的请求记录里读回，重启后仍然有效）。',
          },
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

      const outcome = await waitTestGate(service, flow, sessionId, exec, undefined, failed)
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
    directionId: spec.directionId,
    readAttempts: new Set(),
    signal,
  }
  service.registerChild(flow.sessionId, childId, policy)
  let activation
  let disposePromise
  let onAbort
  const quarantine = () => {
    const readonly = { ...policy, flowId: null }
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
    'JSON 可附 acceptance:[{ac,status:"pass|fail|uncovered|excluded",method:"unit|integration|visual|manual",summary,citations:[{file,line,anchor}],command,exitCode,version,artifact,runtime,measurements,probe}]。填 pass 必须给 citations：file 是项目内路径（须在冻结 scope 内或是 test/ 下的测试文件），line 从 1 开始，anchor 是该行里逐字符照抄的关键片段（允许 ±3 行）——宿主会读文件核对，对不上按 uncovered 计。unit/integration 还须给 command（必须在 scope 的命令清单内）与 exitCode（必须为 0）。version 必须是你实际检查的上述内容版本，不要凭当前版本补盖章。',
    '只输出本方向涉及的 AC；不知道或无实际执行证据就标 uncovered 并说明限制，不得伪造命令、测量或截图。',
    'status=excluded 只表示「当前环境确实跑不了」，并且必须同时提交 probe:{command,exitCode,failure}：command 是 scope.commands 清单里你真正跑过的那条，exitCode 是非零整数，failure 是报错原文。缺 probe、命令不在清单内、退出码为 0，都会被按 uncovered 计——一句 excludeReason 不算证据。',
    'excluded 只在测试阶段成立；评审阶段提交的 excluded 一律按 uncovered 处理，评审发现环境限制请写成 uncovered 并说明原因。',
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
    ' "findings":[{"kind":"defect|design","file":"相对路径","line":12,"severity":"CRITICAL|MAJOR|MINOR","ac":"AC-1",',
    '   "summary":"[函数 · 分支] 一句话",',
    '   "evidence":"该文件里真实出现的标识符",',
    '   "repro":{"when":"输入或命令","expected":"期望结果","actual":"实际结果"},',
    '   "basis":{"quote":"该文件里逐字存在的一行","conflict":"与哪条约定冲突"},',
    '   "counter":{"attempt":"我尝试这样反驳自己：……","survived":true}}]}',
    'verdict：有已核实的 CRITICAL/MAJOR 用 blocking；只有建议或未核实发现用 advisory；零发现用 pass。目标文件未检查时不得用 pass。',
    '每条发现都要能被核对；缺字段的条目会被丢弃，该角度标为未覆盖，不能通过评审：',
    '- evidence 是 file 指向的源码中真实出现的一个标识符字符串（函数名、变量名、方法名），最长 64 字符；写对象或自由描述会被拒绝。对不上源码会标为未核实，不算阻断。',
    '- kind=defect（实现有缺陷）：必须给 line（1 起算，不能超出该文件行数）和 repro；repro.expected 与 repro.actual 不能写成同一句话。',
    '- kind=design（设计取舍或约定冲突）：必须给 basis.quote，逐字复制该文件里真实存在的一行，外加 basis.conflict 说明与哪条约定冲突。',
    '- severity 是 CRITICAL 或 MAJOR 时必须给 counter：写清你怎么反驳自己、为什么没能推翻。反驳不了就降成 MINOR，不要硬报。',
    'findings 先按边界矩阵全量枚举，最多输出 ' + cap + ' 条；超限会将该角度标为未覆盖，请缩减后重新提交。fast 只缩减角度数量，不允许按前三条隐藏其余发现。',
    'suggestUpgrade 只在发现 scope 内存在架构性问题时填 true。',
  ].join('\n')
}

function directionPrompt(flow, direction) {
  const commands = flow.scope?.data?.in_scope?.commands ?? []
  return [
    '你是只读测试子代理，测试方向：' + direction.name + '。',
    '只允许读取工具；shell 只放行只读命令，以及在需求文档 scope.commands 里列出过的命令（' +
      (commands.length ? commands.join(' / ') : '当前清单为空') +
      '）。代码本身不能改：write / edit / str_replace_editor 由宿主端拒绝。' +
      '清单里没有的测试命令不要反复尝试，直接说明该要点未覆盖。',
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
    assertFindingLimits([{ ...report, id: angle.id, name: angle.name }])
    if (!report || !['pass', 'blocking', 'advisory'].includes(report.verdict) || !Array.isArray(report.findings)) {
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
    const rejected = normalized.rejectedFindings ?? []
    const executionError = rejected.length
      ? '子代理有 ' + rejected.length + ' 条发现缺少证据字段：' +
        rejected.map((item) => '第 ' + (item.index + 1) + ' 条缺 ' + item.missing.join('、')).join('；')
      : undefined
    return {
      id: angle.id,
      name: angle.name,
      verdict: normalized.verdict,
      ...(normalized.verdictConflict ? { verdictConflict: normalized.verdictConflict } : {}),
      ...(executionError ? { coverage: 'uncovered', executionError, rejectedFindings: rejected } : {}),
      suggestUpgrade: report.suggestUpgrade === true,
      findings,
      acceptance: normalizeAcceptance(flow, report.acceptance),
    }
  } catch (error) {
    rethrowChildCancellation(signal, error)
    return {
      id: angle.id,
      name: angle.name,
      verdict: 'advisory',
      suggestUpgrade: false, coverage: 'uncovered', executionError: error?.message ?? String(error),
      findings: error instanceof RangeError ? [] : [{
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
  try {
    const result = await spawnReadonlyChild(scoped, service, flow, parentAgent, signal, {
      label: '测试：' + direction.name,
      prompt: directionPrompt(flow, direction),
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

function sessionIdOf(exec) {
  const header = exec?.agent?.session?.header ?? null
  return header && typeof header.id === 'string' ? header.id : null
}

/** 只读取宿主已加载的会话；缺失或正在释放的祖先不按目录猜归属。 */
function sessionHeaderOf(service, sessionId) {
  const ctx = service.ctx
  try {
    const sessions = ctx?.sessions ?? ctx?.get?.('sessions')
    const header = sessions?.get?.(sessionId)?.header
    if (header?.id === sessionId) return header
  } catch { /* 会话服务可能尚未就绪，继续尝试 live agent。 */ }
  try {
    const agents = ctx?.agents ?? ctx?.get?.('agents')
    const header = agents?.get?.(sessionId)?.session?.header
    if (header?.id === sessionId) return header
  } catch { /* 没有可核实的父链时放行，不阻塞其他会话。 */ }
  return null
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
      '追问要问到共识再动手：一次只问一个关键决策，把模糊表述、隐含假设和关键取舍逼出来，答完接着问下一个，直到没有未决问题或只剩用户能拍板的事——问一句就收工不算做完 S1。',
    )
  } else {
    // 用户可能只是点了「开始需求分析」，一个字都没留。这时候「需求分析」不能变成
    // 照着这四个字自己编一个需求去分析——S1 的第一步必须是问清目标。
    lines.push('用户这次没有填写需求描述，可能只是点了「开始需求分析」就进来了。')
    lines.push(
      '',
      '请接着做 S1：先调用 flowgate_status 确认状态，然后用 flowgate_ask 只问一个问题——这次要做什么。不要自己假设目标，不要直接产出需求文档，也不要写代码。',
      '问清楚目标后同样一路走完四阶段：文档获批就直接进入 S2，不要在阶段交界处停下等用户再发一句。',
      '追问要问到共识再动手：一次只问一个关键决策，把模糊表述、隐含假设和关键取舍逼出来，答完接着问下一个，直到没有未决问题或只剩用户能拍板的事——问一句就收工不算做完 S1。',
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
 * 追问答案的跟进消息。
 *
 * 追问等待超时后卡片仍然留在工作台（不清 pending），用户这时点选，答案照样算数——
 * 但 Agent 那边的工具早就返回了，没有这条消息它会以为用户没回答，重复问同一个问题。
 */
function askWakeText(flow, record) {
  const answer = record.custom ? record.custom : record.choice
  return (
    '【流程工作台】用户回答了你的追问：' + (answer || '（空）') + '\n' +
    '这条回答已经记进流程状态（flow.grill.answered），追问卡片已收起。' +
    '继续 ' + flow.stage + '（' + STAGE_LABEL[flow.stage] + '）：不要重新提同一个问题，也不要替用户假设别的答案。'
  )
}

function wakeAfterAnswer(service, flow, record) {
  return deliverToAgent(service, flow, askWakeText(flow, record))
}

/** 验收记录里实际引用到的回执 id：这些回执是「已通过」的支撑，不能淘汰。 */
function referencedEvidenceIds(flow) {
  const ids = new Set()
  for (const entry of [...(flow.test?.acceptance ?? []), ...(flow.review?.acceptance ?? [])]) {
    if (entry && typeof entry.evidenceId === 'string' && entry.evidenceId) ids.add(entry.evidenceId)
  }
  return ids
}

/**
 * 应用一次客户端操作。返回新的视图；无法应用时抛错。
 */
async function applyAction(service, sessionId, action, payload) {
  const flow = service.get(sessionId)

  if (action === 'start') {
    // 界面一键启动：客户端只带 sessionId，标题与档位都可以省略。
    if (flow && !flow.finished) {
      throw new Error('当前会话已经有一条进行中的流程（' + (flow.title || '未命名需求') + '，' + flow.stage + '）。要开始新的一条，请先结束或放弃它。')
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
    if (!Array.isArray(measurements) || !measurements.length || measurements.length > MEASUREMENT_LIMIT
      || measurements.some((m) => !m || typeof m.element !== 'string' || !m.element.trim() || m.element.length > 400
        || typeof m.reference !== 'string' || !m.reference.trim() || m.reference.length > 400
        || !['left', 'right', 'referenceLeft', 'referenceRight'].every((key) => Number.isFinite(m[key]))
        || m.right <= m.left || m.referenceRight <= m.referenceLeft)) throw new Error('布局证据缺少实际有效的具名边界测量。')
    const receipt = { id: randomUUID(), version: snapshot.id, pageId: runtime.pageId,
      hostRevision: runtime.hostRevision, clientRevision: runtime.clientRevision,
      viewport: { ...runtime.viewport }, measurements: measurements.map(({ element, reference, left, right, referenceLeft, referenceRight }) => ({ element, reference, left, right, referenceLeft, referenceRight })), at: nowIso() }
    // 回执不按时间滚动淘汰。滚动淘汰的后果是：第 21 次采集之后，第一个 AC 的证据悄悄失效，
    // 下一轮核算把一条已经通过的视觉验收倒退回 uncovered，而没有任何地方说明原因。
    // 规则改成「引用保护」：还挂在验收记录上的回执一条都不丢，只有没人引用的旧回执才会让位。
    const previous = (flow.layoutEvidence ?? []).filter((item) => item && typeof item.id === 'string')
    const referenced = referencedEvidenceIds(flow)
    const pinned = previous.filter((item) => referenced.has(item.id))
    const spare = previous.filter((item) => !referenced.has(item.id))
    const room = Math.max(0, LAYOUT_EVIDENCE_LIMIT - pinned.length - 1)
    // room 大于 spare.length 时 spare.length - room 是负数，slice 会从末尾倒数——
    // 那等于在还没到上限时就开始丢回执，比原来的滚动淘汰更难发现。先夹到 0。
    const keepFrom = Math.max(0, spare.length - room)
    const evicted = spare.length > room ? spare.slice(0, keepFrom) : []
    flow.layoutEvidence = [...pinned, ...spare.slice(keepFrom), receipt]
    persist(flow)
    return {
      layoutEvidence: receipt,
      // 淘汰本身必须留痕：被丢弃的回执数量与保留总数都要能看见，不能悄悄少一条。
      layoutEvidenceEvicted: evicted.map((item) => item.id),
      layoutEvidenceKept: flow.layoutEvidence.length,
      layoutEvidenceLimit: LAYOUT_EVIDENCE_LIMIT,
    }
  }

  const gates = service.gates
  const workspace = service.workspaceOf(flow.cwd)
  flow.overrides = flow.overrides ?? {}

  switch (action) {
    case 'answer': {
      const choiceIndex = Number(payload?.choiceIndex)
      const customText = typeof payload?.customText === 'string' ? payload.customText : ''
      // 答案必须自带题号：界面是 1.5 秒轮询刷新的，用户点下去的那一刻卡片可能已经换了，
      // 靠「屏幕上那张卡」推断是答哪一问，等于把错配写成正确答案。
      const questionId = typeof payload?.questionId === 'string' ? payload.questionId : ''
      if (!questionId) throw new Error('答案缺少 questionId：请刷新页面后重新点选当前卡片。')
      const pending = flow.grill.pending
      if (!pending) throw new Error('这条追问已经处理过了。')
      if (pending.id !== questionId) {
        throw new Error('这道题已经换掉了：你答的是上一问，请以工作台上当前的卡片为准。')
      }
      // -1 表示「自定义」：宿主记录里 choice 为空，custom 承载用户输入。
      if (!Number.isInteger(choiceIndex) || choiceIndex < -1) throw new Error('choiceIndex 非法')
      const options = Array.isArray(pending.options) ? pending.options : []
      if (choiceIndex === -1) {
        if (pending.allowCustom === false) throw new Error('这道题不接受自定义答案，请点上面的选项。')
        if (!customText.trim()) throw new Error('自定义内容不能为空')
      } else {
        // 越界不能靠 ?.label ?? '' 兜成空答案：那样记录里会出现「已答，但答案是空」。
        if (choiceIndex >= options.length) {
          throw new Error('选项超出范围：这道题只有 ' + options.length + ' 个选项，收到的是第 ' + (choiceIndex + 1) + ' 个。')
        }
        // 选项与自定义文本互斥：两者同时存在时，记录里的「用户选了什么」无法解释。
        if (customText.trim()) throw new Error('已经选了选项，就不能再填自定义内容。')
      }
      // 自定义回答会写进追问记录并随快照全量落盘：留个上限，别让一次粘贴把流程文件撑大。
      if (customText.length > 2000) throw new Error('自定义内容不能超过 2000 字符（当前 ' + customText.length + '）。')
      // 带上题号唤醒：等待器不是这一问，就当作没人在等，答案走下面的迟到落盘。
      if (gates.notify(sessionId, { type: 'decision', decision: 'answer', choiceIndex, customText }, 'answer', pending.id) === 'delivered') break
      // 等待器已经不在了（追问等待超时、被中断，或宿主重启过）：卡片仍然要算数。
      // 这里不能抛错——用户点一下只得到「当前没有等待中的追问卡片」，答案就丢了，
      // 而工作台上那张卡片看起来明明还在。和 doc / gate 一样：决策先落盘，再叫醒 Agent。
      const record = {
        questionId: pending.id,
        question: pending.question,
        choiceIndex,
        choice: choiceIndex >= 0 ? (pending.options?.[choiceIndex]?.label ?? '') : '',
        custom: customText,
        at: nowIso(),
      }
      if (!Array.isArray(flow.grill.answered)) flow.grill.answered = []
      if (flow.grill.answered.length >= 100) flow.grill.answered.splice(0, flow.grill.answered.length - 99)
      flow.grill.answered.push(record)
      flow.grill.pending = null
      appendEvent(flow.cwd, flow, 'grill.answered', { questionId: record.questionId, choiceIndex, custom: customText, late: true })
      persist(flow)
      // 没有等待器接着跑，就补一条消息把 Agent 叫醒；重复点击不重复唤醒。
      service.nudges.set(sessionId, wakeAfterAnswer(service, flow, record))
      break
    }
    case 'doc': {
      const decision = payload?.decision
      if (decision !== 'approve' && decision !== 'revise' && decision !== 'skip') {
        throw new Error('decision 必须是 approve / revise / skip')
      }
      // 决策直接落流程状态：等待器可能已被中断或重启清掉，界面仍然要能确认。
      // 验收方案缺口必须显式接受（acceptScopeRisks: true）；接受原因可选，写了才留痕。
      const result = decideDoc(service, flow, sessionId, decision, {
        acceptScopeRisks: payload?.acceptScopeRisks === true,
        scopeRiskNote: clampText(payload?.scopeRiskNote, 2000),
        revisionNote: clampText(payload?.revisionNote, REVISION_NOTE_LIMIT),
      })
      // 还挂着的工具立刻收到同一结果；没有等待器时通知不到，也不影响推进。
      const docDelivered = gates.notify(sessionId, { type: 'decision', decision: result.decision }, 'doc') === 'delivered'
      // 重复点击不重复唤醒；等待器已经接手时也不需要补消息。
      if (!docDelivered && !result.repeated) {
        service.nudges.set(sessionId, wakeAfterDoc(service, flow, result.decision))
      }
      break
    }
    case 'cancel': {
      if (flow.finished) throw new Error('流程已经结束，不需要再放弃。')
      cancelFlow(flow, typeof payload?.reason === 'string' ? payload.reason : '')
      // 挂起的工具必须被叫醒，否则它会一直等一个永远不会来的按钮。
      // expectKind 显式传 null（任意等待器）：放弃流程要连追问卡片一起作废，
      // 所以不能只发给门禁——全库只有这一处「谁在等都算」，写在这里而不是靠省略参数。
      const cancelledDelivered = gates.notify(sessionId, { type: 'signal', signal: 'cancelled' }, null) === 'delivered'
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
        acceptExcluded: payload?.acceptExcluded === true,
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
        // 对 Agent 来说，「升档后回退」和点「退回开发修复」是同一件事：都是退回某个阶段重做。
        // 所以这里不另造一个 interrupted 值，走同一条 back 决策。
        // 先落盘再通知：醒来的一方读到的阶段就是已经退回后的阶段，不用自己猜。
        rollbackTo(
          flow,
          to,
          to === 'S1' ? 'upgrade-scope-overflow' : 'upgrade-after-review',
          '用户把执行档位升到 ' + PRESETS[target].label,
        )
        const upgradeDelivered = gates.notify(
          sessionId,
          { type: 'decision', decision: 'back', to, applied: true },
          'gate',
        ) === 'delivered'
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
      // 没挂起时 notify 返回 'no-waiter'，不改任何状态。
      const modeWake = { type: 'signal', signal: 'mode-changed' }
      if (service.gates.notify(sessionId, modeWake, 'gate') !== 'delivered') {
        service.gates.notify(sessionId, modeWake, 'doc')
      }
      break
    }
    case 'setGateWaitMinutes': {
      // 工作区级：门禁等待器等多久算「没人来」。改完立刻影响下一次等待；
      // 已经挂着的等待器保持它自己的定时器（不重排，否则改配置等于偷偷延长/缩短当前等待）。
      const result = setWorkspaceGateWaitMinutes(flow.cwd, payload?.minutes)
      appendEvent(flow.cwd, flow, 'gate.wait.changed', { minutes: result.minutes, rejected: result.rejected })
      if (result.rejected) {
        throw new Error(
          '门禁等待上限必须在 ' + GATE_WAIT_MIN_MINUTES + '–' + GATE_WAIT_MAX_MINUTES +
          ' 分钟之间（0 表示不超时，会把永久悬挂的缺陷重新打开，所以不接受）。已按默认值 ' +
          result.minutes + ' 分钟保存。',
        )
      }
      break
    }
    case 'reopenScopeForCommands': {
      // 「补」只有一个人口：门禁上的待补提醒。这里不再接受任意 command，
      // 只接受待补队列里的原文——「随时都能加一条」正是原来那套乱象的来源。
      supplementScopeCommands(service, flow, sessionId, payload?.commands)
      break
    }
    case 'declineScopeCommands': {
      // 「不补」与「补」成对出现：两个按钮都在门禁上，都要落进流程状态。
      declineScopeCommands(service, flow, sessionId, payload?.commands)
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
    case 'addAngle':
    case 'addDirection': {
      const isAngle = action === 'addAngle'
      const name = String(payload?.name ?? '').trim()
      if (!name) throw new Error('名称不能为空')
      const points = Array.isArray(payload?.points)
        ? payload.points.map((p) => String(p).trim()).filter(Boolean)
        : String(payload?.points ?? '').split('\n').map((p) => p.trim()).filter(Boolean)
      const item = { id: 'custom_' + randomUUID().slice(0, 8), name, points }
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
    // 全局清单里一眼看出哪条流程在反复打转：退回次数比当前阶段更能说明状态。
    rollbacks: flow.rollbacks ?? { total: 0, byReason: {}, skipped: 0, last: null },
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
        item.points.some((point) => typeof point !== 'string')) {
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
      // 历史详情按 flowId 取：同一个会话换了新流程后，按 sessionId 只会拿到新的那条。
      // cwd 只在内存里找不到时才用得上——历史快照要按工作区去盘上翻。
      const flowId = url.searchParams.get('flowId')
      const historyCwd = url.searchParams.get('cwd')
      const clientRevision = url.searchParams.get('clientRevision')
      const pageId = url.searchParams.get('pageId')
      const width = Number(url.searchParams.get('viewportWidth')), height = Number(url.searchParams.get('viewportHeight'))
      // 参数存在与参数合法必须分开：factory 标记缺失时客户端压根没有指纹可报，那不是「上报了垃圾」。
      const revisionPresent = typeof clientRevision === 'string' && clientRevision !== ''
      const revisionValid = revisionPresent && /^[a-f0-9]{64}$/.test(clientRevision)
      const pageValid = /^[a-f0-9-]{36}$/i.test(pageId ?? '')
      const viewportValid = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
      // 四态：合法上报记可信；页面参与了但没有指纹可报记 reported；带了非法参数记 rejected（留痕，供 status 念出来）；完全没带参数才算「没参与」，清掉旧记录。
      const hasAnyReport = Boolean(clientRevision || pageId || url.searchParams.get('viewportWidth') || url.searchParams.get('viewportHeight'))
      if (revisionValid && pageValid && viewportValid) {
        service.runtimeClients.set(sessionId, { clientRevision, pageId, viewport: { width, height }, reportedAt: Date.now() })
      } else if (!hasAnyReport) {
        service.runtimeClients.delete(sessionId)
      } else if (!revisionPresent && pageValid && viewportValid) {
        // 页面参与了轮询却没有指纹可报：缺的是构建期标记，不是上报本身有问题。
        // 记 reported 而不是 rejected，clientState 才能说「页面源码标记缺失」而不是「上报被拒」。
        service.runtimeClients.set(sessionId, { reported: true, clientRevision: '', pageId, viewport: { width, height }, reportedAt: Date.now() })
      } else {
        // 非法上报必须留痕：直接 delete 会让「上报了垃圾」与「没参与」在 status 输出里同值（G01/G18 反模式）。
        // 整份覆盖旧值：旧的可信指纹不能借这条记录继续当「已验证」。
        const reasons = []
        if (revisionPresent && !revisionValid) reasons.push('指纹不是 64 位十六进制')
        if (!pageValid) reasons.push('pageId 不是 UUID')
        if (!viewportValid) reasons.push('视口宽高非法')
        service.runtimeClients.set(sessionId, {
          rejected: true,
          reason: reasons.join('、'),
          // 非法值只留前 64 字符用于诊断：这张表与合法分支的定长指纹同放，不能让它被一条超长参数撑住。
          clientRevision: typeof clientRevision === 'string' ? clientRevision.slice(0, 64) : '',
          // 不记 pageId：这张表的 pageId 只在可信上报分支被 view() 读（且要求 status 为 verified），
          // rejected 记录永远读不到；诊断信息已经在 reasons 里写明了哪个参数不合法。
          reportedAt: Date.now(),
        })
      }
      const workspace = service.workspaceHint(sessionId)
      // 冷恢复时被跳过的快照属于工作区级事实：哪怕这个会话当前没有流程，
      // 也必须让界面看得见「有东西没读进来」，否则用户只会以为流程从没启动过。
      const view = flowId
        ? service.flowView(flowId, historyCwd || workspace?.path || '')
        : service.view(sessionId)
      // 找不到就说找不到：退回当前流程等于把「看旧账」变成「看今天这份」，正是要消掉的毛病。
      if (!view) return json(404, { error: '找不到这条流程，可能已经被清理。' })
      return json(200, { ...view, workspace, loadProblems: view.loadProblems ?? service.loadProblemsFor(workspace?.path ?? '') })
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
      const remove = scoped.tools.guard((exec) => service.childDenial(exec, true) ?? undefined)
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
        // 权限模式在这一次调用上取一次：判定与提权申请记的是同一时刻的宿主状态。
        const mode = sandboxModeOf(exec)
        // 提权申请先记账。审批发生在 flowgate 看不见的地方（宿主审批服务），
        // 「模型带上 sandbox_permissions 重试」是唯一能证明它想升到哪一档的时刻。
        // 主 Agent 与子代理都记：被驳回的申请同样要留痕，否则事后看不出它试过。
        if (escalationTarget(exec.arguments)) {
          const escalationFlow = service.flowForSession(exec.agent.session.header)
          if (escalationFlow) auditEscalation(escalationFlow, exec, mode)
        }
        // 评审 / 测试子代理的会话归到父流程：它们是只读的。
        const readonly = service.childDenial(exec)
        if (readonly) return { kind: 'deny', reason: readonly }
        // 登记过的评审 / 测试子代理只由 readonlyDenial 管：放行就是放行，
        // 再跑一次 scopeDenial 会把父流程的 scope 当成它们的写权限。
        if (service.childPolicyOf(sessionId)) return next()
        const flow = service.flowForSession(exec.agent.session.header)
        if (!flow) return next()
        // 工作台靠这条摘要显示「正在做什么」；只放内存，不写快照。
        service.noteActivity(flow.sessionId, exec, flow.stage)
        const cwd = exec.agent.session.header.cwd
        const denial = scopeDenial(flow, exec.name, exec.arguments,
          typeof cwd === 'string' && isAbsolute(cwd) ? cwd : flow.cwd, mode)
        if (denial) return { kind: 'deny', reason: denial }
        return next()
      }),
      'flowgate: scope guard',
    )

    // 执行结果：tools/result 是宿主给出「这次调用最终怎么了」的唯一出口。
    // pre-execute 只能记「判定放行」，退出码与真正生效的权限模式只有结果里才有；
    // 只记判定的话，「放行了」与「跑成功了」在流水里长得一模一样。
    scoped.effect(
      () => scoped.on('tools/result', (exec, result) => {
        try {
          if (!sessionIdOf(exec)) return
          const flow = service.flowForSession(exec.agent.session.header)
          if (!flow) return
          if (SHELL_TOOLS.has(exec.name)) auditShellResult(flow, exec, result)
          auditEscalationOutcome(flow, exec, result)
        } catch {
          // 记账失败不能反过来把一次正常调用变成异常：宿主已经执行完了，
          // 这里抛错只会让工具结果变成报错。
        }
      }),
      'flowgate: shell result audit',
    )

    // Agent 一停下来，上一条「正在执行命令」就过期了：清掉它，界面回到「等待下一步」。
    // 宿主没这个事件也不影响流程推进，实时进度只是锦上添花。
    scoped.effect(
      () => scoped.on('agent/status', (payload) => {
        try {
          if (payload?.status !== 'idle') return
          const id = payload?.agent?.session?.header?.id
          if (typeof id !== 'string') return
          const flow = service.flowForSession(payload.agent.session.header)
          service.clearActivity(flow?.sessionId ?? service.ownerOf(id))
        } catch {
          // 事件形状变了就跳过，不要让界面细节拖累流程。
        }
      }),
      'flowgate: activity cleanup',
    )

    const builds = [
      statusTool, startTool, askTool, docTool, gateTool, cancelTool,
      reviewTool, reviewRunTool, testTool, testRunTool, waitTool,
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
