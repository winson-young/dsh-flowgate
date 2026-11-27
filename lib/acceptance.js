import { posix, win32 } from 'node:path'
import { sameSnapshot } from './provenance.js'
import { registerModuleRevision } from './revisions.js'
import { BROAD_COMMAND, TEST_COMMAND, ecosystemsFor, executableName, needsOf } from './ecosystems.js'

export const FLOWGATE_MODULE_REVISION = 'c5f24c14decbb163ee2b01139000ab7598628086230e4299414c684d14bfb0a1'
registerModuleRevision(import.meta.url, FLOWGATE_MODULE_REVISION)

const METHODS = new Set(['unit', 'integration', 'visual', 'manual'])
// excluded 是独立状态，不是 uncovered 的马甲：它说的是「这个环境测不了」，
// 而不是「还没测」。混进 uncovered 会让环境受限项每次都阻塞门禁——重测多少轮都还是它。
const STATUSES = new Set(['pass', 'fail', 'uncovered', 'excluded'])
const text = (value) => typeof value === 'string' ? value.trim() : ''
const list = (value) => Array.isArray(value) ? value : []
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = (value) => typeof value === 'string' && Boolean(value.trim()) && !/[\s\u0000-\u001f\u007f]/u.test(value.trim())

/** 命令的第一个 token：体检用它判断「这条命令靠哪个可执行体跑」。 */
const firstToken = (command) => {
  const match = /^("[^"]*"|'[^']*'|\S+)/u.exec(String(command ?? '').trim())
  return match ? match[1].replace(/^["']|["']$/gu, '') : ''
}

/** Layout assertions need browser measurements, even when CSS source looks plausible. */
function needsMeasurements(criterion) {
  return /宽度|等宽|同宽|对齐|齐平|左右边界|边缘一致|\bwidth\b|\balign(?:ed|ment)?\b|\bsame[ -]width\b|\bequal[ -]width\b/i.test(
    [criterion?.when, criterion?.then].filter((value) => typeof value === 'string').join(' '),
  )
}

/** Preserve one entry per declared criterion: malformed or duplicate IDs stay visible. */
export function normalizeCriteria(criteria) {
  return list(criteria).map((entry) => {
    const source = object(entry) ? entry : {}
    const verification = object(source.verification) ? source.verification : {}
    const method = needsMeasurements(source) ? 'visual' : METHODS.has(verification.method) ? verification.method : 'manual'
    // 证据由哪条命令产出，声明在验收标准自己身上：让命令反过来声称
    // 「我能测 AC-1…AC-12」等于让被测方给自己判卷，写几个 id 就能显示全覆盖。
    const commands = [...new Set(list(verification.commands).map((item) => text(item)).filter(Boolean))].slice(0, 20)
    const normalized = {
      id: text(source.id),
      when: typeof source.when === 'string' ? source.when : '',
      then: typeof source.then === 'string' ? source.then : '',
      verification: {
        method,
        procedure: text(verification.procedure) || [text(source.when), text(source.then)].filter(Boolean).join('；'),
        ...(commands.length ? { commands } : {}),
      },
    }
    if (method === 'visual') {
      normalized.verification.tolerancePx = typeof verification.tolerancePx === 'number'
        && Number.isFinite(verification.tolerancePx) && verification.tolerancePx >= 0
        ? verification.tolerancePx : 1
    }
    return normalized
  })
}

/**
 * S1 冻结前的验收方案体检。
 *
 * 验收账本只在 S4 才发现「方法与证据不匹配」——那时候开发做完、评审过了，用户只能
 * 带缺口结项或整轮退回。能在 S1 静态确认的矛盾（id 缺失或重复）直接拒绝；只能推断的
 * 风险（声明要跑测试却没有测试命令、集成验收却没有测试文件、视觉验收没写怎么测）
 * 不拦截，但必须让用户在批准 scope 前看见并明确接受。
 */
const TEST_FILE = /(?:^|\/)(?:[^/]*\.(?:test|spec)\.[^/]*|__tests__\/|tests?\/)/i
// 测试命令识别由解释器登记表派生（lib/ecosystems.js 的 TEST_COMMAND）：新增生态只改那一处，
// 不会再出现「登记了 php 却漏了 phpunit」这种只漏一行的缺口。
const MEASURE_HINT = /getBoundingClientRect|测量|实测|左右边界|左右边缘|像素|\bpx\b|measure/i
// 超宽放行：一条通配等于批准整类命令，清单就退化成那个「允许执行命令」的勾选框。
// 注意 `npm run *` 不算超宽：它只能在 package.json 的 scripts 里选，范围本身有限，
// 插件也一直支持这种前缀通配。真正宽的是 `npm *`（含 publish / exec）和 `node *`（任意代码）。
// 名单同样由登记表派生（BROAD_COMMAND）：一条通配等于批准整类命令，所以只认登记过的可执行名。
// 验证步骤里点名要改的文件（带目录的相对路径，例如 test/fixtures/session.ts）。
const PATH_HINT = /[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+\.[A-Za-z0-9]+/g

function scopeCovers(files, target) {
  const want = target.toLowerCase()
  return files.some((file) => {
    const have = file.toLowerCase().replace(/\/+$/, '')
    return have === want || want.startsWith(have + '/')
  })
}

/**
 * 验证步骤里点了名、但冻结范围里没有的文件。
 * 这是 S1 唯一能静态抓到的「scope 与验证方案不相容」：AC 写着要动跨模块夹具，
 * 文件清单却只有主机测试——评审时才发现，只能整轮退回重来。
 */
function procedureOutsideScope(item, files) {
  const text = [item.verification.procedure, item.when, item.then].map((part) => String(part ?? '')).join('\n')
  const mentioned = [...new Set(text.match(PATH_HINT) ?? [])].filter((path) => !scopeCovers(files, path))
  return mentioned
}
/**
 * S1 提交需求文档前的追问体检。
 *
 * 「问得更深」不能只写在提示词里：Agent 想说「差不多了」的时候，没有任何东西拦得住。
 * 这里把三份清单变成提交的必要条件——未决问题非空说明共识还没达成，决策与假设同时为空
 * 说明根本没澄清过，两种都直接拒绝提交，而不是记一条风险放行。
 */
export function grillReadiness(decisions, assumptions, openQuestions) {
  const blockers = []
  const decisionList = list(decisions).map((entry) => {
    const source = object(entry) ? entry : {}
    return { question: text(source.question), answer: text(source.answer) }
  })
  const assumptionList = list(assumptions).map(text).filter(Boolean)
  const openList = list(openQuestions).map(text).filter(Boolean)

  if (openList.length) {
    blockers.push({
      code: 'open-questions-remain',
      message: '还有 ' + openList.length + ' 个未决问题没有问清：' + openList.join('；')
        + '。先逐个问掉再提交——需求文档不是记录待定的地方。',
    })
  }
  const incomplete = decisionList.filter((entry) => !entry.question || !entry.answer)
  if (incomplete.length) {
    blockers.push({
      code: 'incomplete-decision',
      message: '有 ' + incomplete.length + ' 条已确认决策缺 question 或 answer：'
        + '每条决策都要能看出「问了什么、定了什么」。',
    })
  }
  if (!decisionList.length && !assumptionList.length) {
    blockers.push({
      code: 'nothing-clarified',
      message: 'decisions 与 assumptions 都是空的：说明这次没有澄清任何东西。'
        + '至少问掉一个关键决策写进 decisions；确实无需追问时，把自行补全的前提写进 assumptions。',
    })
  }
  return { blockers, decisions: decisionList, assumptions: assumptionList, openQuestions: openList }
}

const METHOD_LABEL = { unit: '单元测试', integration: '集成测试', visual: '视觉测量', manual: '人工核验' }

function uniqueMethods(items) {
  return [...new Set(items.map((item) => item.verification.method))].map((method) => METHOD_LABEL[method] ?? method).join('、')
}

export function scopeReadiness(criteria, commands, files, options = {}) {
  const items = normalizeCriteria(criteria)
  const commandList = list(commands).map(text).filter(Boolean)
  const fileList = list(files).map(text).filter(Boolean)
  const blockers = []
  const ids = new Map()
  for (const item of items) {
    if (!item.id) {
      blockers.push({ code: 'missing-id', message: '有一条验收标准没有 id：S4 无法把执行证据关联到它，它永远是未覆盖。' })
      continue
    }
    ids.set(item.id, (ids.get(item.id) || 0) + 1)
  }
  for (const [id, count] of ids) {
    if (count > 1) blockers.push({ code: 'duplicate-id', id, message: '验收标准 id 重复：' + id + '（' + count + ' 条），S4 无法唯一关联执行证据。' })
  }
  const idList = (subset) => subset.map((item) => item.id || '（无 id）')
  const executable = items.filter((item) => item.verification.method === 'unit' || item.verification.method === 'integration')
  const integration = items.filter((item) => item.verification.method === 'integration')
  const visual = items.filter((item) => item.verification.method === 'visual' && !MEASURE_HINT.test(item.verification.procedure))
  const testCommands = commandList.filter((command) => TEST_COMMAND.test(command))
  const testFiles = fileList.filter((file) => TEST_FILE.test(file))
  const risks = []
  if (executable.length && !testCommands.length) {
    risks.push({
      code: 'no-test-command',
      acs: idList(executable),
      message: '这些验收标准声明了可执行验证（' + uniqueMethods(executable) + '），但命令清单里没有能识别的测试命令'
        + (commandList.length ? '（现有 ' + commandList.length + ' 条都不是测试命令）' : '（清单为空）')
        + '：S4 默认跑不起来，它们只能记未覆盖。',
    })
  }
  if (integration.length && !testFiles.length) {
    risks.push({
      code: 'integration-without-test-file',
      acs: idList(integration),
      message: '这些验收标准声明用集成测试验证，但文件清单里没有任何测试文件：集成验收通常要改跨模块夹具；夹具若在 scope 外，S3 评审会要求回 S1 调 scope，这一轮就白做了。',
    })
  }
  // 验证步骤点名要动的文件必须在 scope 内：否则 S3 评审会判「范围外发现」，S4 也改不了。
  const outside = items
    .filter((item) => item.verification.method !== 'manual')
    .map((item) => ({ id: item.id, files: procedureOutsideScope(item, fileList) }))
    .filter((entry) => entry.files.length)
  if (outside.length) {
    risks.push({
      code: 'procedure-file-outside-scope',
      acs: outside.map((entry) => entry.id),
      message: '这些验收标准的验证步骤点名了 scope 之外的文件：' + outside.map((entry) => entry.id + ' → ' + entry.files.join('、')).join('；')
        + '。开发阶段改不了它们，评审也会把相关发现判成范围外；要么把这些文件补进 scope，要么调整验证步骤。',
    })
  }
  if (visual.length) {
    risks.push({
      code: 'visual-without-measurement',
      acs: idList(visual),
      message: '这些验收标准的 procedure 没有写明怎么测（getBoundingClientRect / 左右边界 / 像素容差）：视觉验收只认真实宿主测量，没写清就只能记未覆盖。',
    })
  }
  // 清单要「合适」：过少和过多都是问题，只是过少的后果更晚才暴露。
  // 覆盖关系只有一个来源：AC 侧写的 verification.commands。命令来源标注只解释
  // 「这条命令从哪读出来的」，不再参与判定——它同样是 Agent 自填的字符串。
  const sources = list(options.commandSources)
    .map((entry) => ({ command: text(entry?.command), from: text(entry?.from) }))
    .filter((entry) => entry.command)
  const notes = []
  // 没写命令的 AC 不是「风险」，是硬缺口：S4 根本不知道该跑什么，只能记未覆盖。
  const missingCommand = executable.filter((item) => !list(item.verification.commands).length)
  if (missingCommand.length) {
    blockers.push({
      code: 'ac-without-command',
      acs: idList(missingCommand),
      message: '这些验收标准声明了可执行验证，但没写 verification.commands：S4 不知道该跑哪条命令产出证据。'
        + '请在每条 AC 上写明命令，并把它一并写进 scope.commands。',
    })
  }
  const unauthorized = []
  for (const item of executable) {
    for (const command of list(item.verification.commands)) {
      if (!commandList.includes(command)) unauthorized.push(item.id + ' → ' + command)
    }
  }
  if (unauthorized.length) {
    blockers.push({
      code: 'ac-command-not-authorized',
      acs: [...new Set(unauthorized.map((entry) => entry.split(' → ')[0]))],
      message: '这些验收标准引用了命令清单之外的命令：' + unauthorized.join('；')
        + '。清单是用户批准的唯一授权范围，AC 不能引用一条没被批准的命令；'
        + '要么把命令补进 scope.commands，要么改用清单里已有的命令。',
    })
  }
  const broad = commandList.filter((command) => BROAD_COMMAND.test(command))
  if (broad.length) {
    risks.push({
      code: 'over-broad-command',
      acs: [],
      commands: broad,
      message: '这些命令的放行范围过宽：' + broad.join('、')
        + '。一条通配等于批准了整类命令，清单就失去意义了；请写成具体命令。',
    })
  }
  // 清单条目远超它能证明的验收标准数量时，多出来的部分是白给的权限。
  if (commandList.length > Math.max(8, executable.length * 2)) {
    // 多出来的权限没有验收标准为它作证，就不该被顺手批准——这条从风险升成阻塞。
    blockers.push({
      code: 'over-broad-command',
      acs: [],
      commands: [],
      message: '命令清单有 ' + commandList.length + ' 条，可执行验收标准只有 ' + executable.length
        + ' 条：清单比它能证明的东西多得多，批准它等于批准了一堆用不上的权限。请只留下真正要跑的命令。',
    })
  }
  // 清单里的命令必须在当前仓库里真的能跑：写错脚本名等于 S2/S4 当场卡住。
  const project = object(options.project) ? options.project : null
  if (project && project.hasPackageJson === true) {
    const scripts = object(project.scripts) ? project.scripts : {}
    const builtin = new Set(['install', 'i', 'ci', 'exec', 'x', 'dlx', 'create', 'init', 'publish', 'pack', 'link', 'update', 'add', 'remove'])
    const inapplicable = commandList.filter((command) => {
      const match = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:_.-]+)\b/.exec(command)
      if (!match) return false
      const name = match[1]
      if (builtin.has(name)) return false
      return !Object.prototype.hasOwnProperty.call(scripts, name)
    })
    if (inapplicable.length) {
      risks.push({
        code: 'command-not-applicable',
        acs: [],
        commands: inapplicable,
        message: '这些命令在这个仓库里跑不起来：' + inapplicable.join('、')
          + '（package.json 的 scripts 里没有对应的脚本）。S2 跑构建、S4 跑测试时会直接失败。',
      })
    }
  }
  // 命令里的可执行体必须在这台机器上真的存在：清单写对了、PATH 上没有，S2/S4 照样 127。
  // 只核对「仓库里声明了这个生态」的那些命令：空目录里写 `node test/x.mjs` 无从判断，跳过比误报更有用。
  const resolver = typeof project?.resolveExecutable === 'function' ? project.resolveExecutable : null
  if (project && resolver) {
    const declared = new Set(list(project.ecosystems))
    const missing = []
    // 第二层：工具自己在了，还要看它依赖的解释器在不在（npm 是 node 程序，composer 是 php 程序）。
    const missingDeps = []
    for (const command of commandList) {
      const token = firstToken(command)
      if (!token) continue
      const owners = ecosystemsFor(token)
      if (!owners.length) continue
      if (!owners.some((id) => declared.has(id))) continue
      if (!resolver(token).found) {
        if (!missing.includes(command)) missing.push(command)
        continue
      }
      // 候选写法是「任一存在即通过」（python / python3 / py 是同一个东西的三种叫法），
      // 不是「每个都得在」——否则 Windows 上只有 py 启动器的机器会被判成缺依赖。
      const deps = needsOf(token)
      // 没有登记依赖就不查这一层；有依赖时要求候选里至少有一个在。
      const gone = deps.length > 0 && !deps.some((dep) => resolver(dep).found) ? deps : []
      if (gone.length) missingDeps.push({ command, name: executableName(token), deps: gone })
    }
    if (missing.length || missingDeps.length) {
      // 两层分开说：「npm 不在」和「npm 在、但它需要的 node 不在」是完全不同的修法。
      const parts = []
      if (missing.length) {
        const names = [...new Set(missing.map((command) => firstToken(command)))].join('、')
        parts.push(missing.join('、') + '（命令本身找不到：' + names + '）')
      }
      for (const item of missingDeps) {
        parts.push(item.command + '（' + item.name + ' 在，但它需要的 ' + item.deps.join(' 或 ') + ' 不在）')
      }
      risks.push({
        code: 'command-runtime-missing',
        acs: [],
        commands: [...missing, ...missingDeps.map((item) => item.command)],
        message: '这些命令用到的可执行体在当前 PATH 上找不到：' + parts.join('；')
          + '。清单本身没写错，但这台机器上跑不起来——'
          + 'S2 跑构建、S4 跑测试时会直接失败。请把可执行体的绝对路径写进清单，或者先在环境里装好它。',
      })
    }
  }
  return { blockers, risks, notes, items, testCommands, testFiles, sources }
}

function currentReport(report, snapshot) {
  return sameSnapshot(report?.snapshot, snapshot)
}

function visualResult(criterion, entry, runtime) {
  if (runtime?.status !== 'verified') return { status: 'uncovered', reason: '运行中的宿主与客户端版本尚未验证' }
  const measuredRuntime = entry.runtime
  if (!text(runtime.hostRevision) || !text(runtime.clientRevision)
    || !object(measuredRuntime) || measuredRuntime.hostRevision !== runtime.hostRevision
    || measuredRuntime.clientRevision !== runtime.clientRevision
    || !text(runtime.pageId) || measuredRuntime.pageId !== runtime.pageId) {
    return { status: 'uncovered', reason: '视觉证据与当前宿主或客户端版本不一致' }
  }
  const viewport = measuredRuntime.viewport
  if (!object(viewport) || !Number.isFinite(viewport.width) || viewport.width <= 0
    || !Number.isFinite(viewport.height) || viewport.height <= 0) {
    return { status: 'uncovered', reason: '视觉证据缺少有效视口尺寸' }
  }
  if (!object(runtime.viewport) || runtime.viewport.width !== viewport.width || runtime.viewport.height !== viewport.height) {
    return { status: 'uncovered', reason: '视觉证据的视口与当前验证环境不一致' }
  }
  if (!needsMeasurements(criterion)) {
    return { status: 'uncovered', reason: '该视觉标准需要对应的真实视觉采集产物；当前布局采集器只验证边界对齐，任意截图路径字符串不能作为通过证据' }
  }
  const measurements = list(entry.measurements)
  if (!measurements.length) return { status: 'uncovered', reason: '宽度或对齐验收缺少实际边界测量，CSS 声明不能证明视觉结果' }
  for (const measurement of measurements) {
    if (!object(measurement) || !text(measurement.element) || !text(measurement.reference)
      || !['left', 'right', 'referenceLeft', 'referenceRight'].every((key) => Number.isFinite(measurement[key]))
      || measurement.right <= measurement.left || measurement.referenceRight <= measurement.referenceLeft) {
      return { status: 'uncovered', reason: '视觉测量缺少具名元素、参考元素或有效矩形边界' }
    }
  }
  const receipt = list(runtime.layoutEvidence).find((item) => text(entry.evidenceId) && item?.id === entry.evidenceId)
  const keys = ['element', 'reference', 'left', 'right', 'referenceLeft', 'referenceRight']
  if (!receipt || receipt.version !== entry.version || receipt.pageId !== runtime.pageId
    || receipt.hostRevision !== runtime.hostRevision || receipt.clientRevision !== runtime.clientRevision
    || receipt.viewport?.width !== viewport.width || receipt.viewport?.height !== viewport.height
    || !Array.isArray(receipt.measurements) || receipt.measurements.length !== measurements.length
    || measurements.some((measurement, index) => keys.some((key) => measurement[key] !== receipt.measurements[index]?.[key]))) {
    return { status: 'uncovered', reason: '缺少与当前版本、页面、视口及测量一致的真实布局采集回执' }
  }
  const tolerance = criterion.verification.tolerancePx
  if (measurements.some((measurement) => Math.abs(measurement.left - measurement.referenceLeft) > tolerance
    || Math.abs(measurement.right - measurement.referenceRight) > tolerance)) {
    return { status: 'fail', reason: '实际左右边界测量超出 ' + tolerance + 'px 容差' }
  }
  return { status: 'pass', reason: '实际左右边界测量均在 ' + tolerance + 'px 容差内' }
}

/** anchor 是主键，line 只是定位提示：允许 ±3 行，避免插几行就整条引用失效。 */
const ANCHOR_WINDOW = 3
const CITATION_LIMIT = 20

/** 引用的文件由宿主预读后放在 runtime.evidenceSources 里；这里只查表，不碰文件系统。 */
function citationSources(runtime) {
  const sources = new Map()
  for (const item of list(runtime?.evidenceSources)) {
    const file = text(item?.file)
    if (file && !sources.has(file)) sources.set(file, item)
  }
  return sources
}

/** 引用文件必须在冻结 scope 内，或是测试文件：证据不能指向一份没人审过的文件。 */
function citationInScope(citation, runtime) {
  const file = text(citation?.file).replace(/^(\.\/)+/u, '')
  if (/^test\//u.test(file)) return true
  const target = normalizedFile(text(runtime?.cwd), file)
  for (const entry of list(runtime?.scopeFiles)) {
    const declared = text(entry)
    if (!declared) continue
    const base = normalizedFile(text(runtime?.cwd), declared)
    if (target === base) return true
    // scope 可以列目录：`test/` 覆盖其下所有文件，与 S1 体检的口径一致。
    if (target.startsWith(base.endsWith('/') ? base : base + '/')) return true
  }
  return false
}

/** 一条引用对不上就退未覆盖：文件不在、行号越界、anchor 不在窗口里，都算对不上。 */
function citationProblem(citation, runtime, sources) {
  const file = text(citation?.file)
  if (!file) return '引用缺少文件路径'
  const line = citation?.line
  if (!Number.isSafeInteger(line) || line < 1) return file + ' 的行号必须是从 1 开始的整数'
  const anchor = text(citation?.anchor)
  if (!anchor) return file + ':' + line + ' 缺少 anchor：行号会漂，必须写该行里的关键片段'
  const source = sources.get(file)
  if (!source) return '引用的文件不在本次可核对范围：' + file
  if (source.error) return '引用的文件无法核对：' + file + '（' + text(source.error) + '）'
  if (line > source.lineCount) return file + ' 只有 ' + source.lineCount + ' 行，引用的是第 ' + line + ' 行'
  const start = Math.max(1, line - ANCHOR_WINDOW)
  const end = Math.min(source.lineCount, line + ANCHOR_WINDOW)
  for (let index = start; index <= end; index += 1) {
    if (String(source.lines?.[index - 1] ?? '').includes(anchor)) return ''
  }
  return file + ' 第 ' + start + '–' + end + ' 行里找不到 anchor「' + anchor + '」'
}

/** 通过结论的机器核对：引用真实存在 + 命令被授权且真的成功。 */
function evidenceProof(entry, runtime, allowedCommands) {
  const citations = list(entry?.citations)
  if (!citations.length) return { status: 'uncovered', reason: '通过结论缺少引用：必须给出文件、行号与该行的关键片段' }
  if (citations.length > CITATION_LIMIT) {
    return { status: 'uncovered', reason: '引用条数超过上限 ' + CITATION_LIMIT + '，请只保留关键位置' }
  }
  const sources = citationSources(runtime)
  for (const citation of citations) {
    const problem = citationProblem(citation, runtime, sources)
    if (problem) return { status: 'uncovered', reason: '证据引用对不上：' + problem }
    if (!citationInScope(citation, runtime)) {
      return { status: 'uncovered', reason: '证据引用落在冻结 scope 之外且不是测试文件：' + text(citation?.file) }
    }
  }
  // 人工核验没有可执行的断言，只要求引用可定位。
  if (entry.method === 'manual') return null
  const command = text(entry?.command)
  if (!command) return { status: 'uncovered', reason: '自动化验收缺少实际执行的命令' }
  if (!list(allowedCommands).includes(command)) return { status: 'uncovered', reason: '执行命令不在授权命令清单内：' + command }
  if (entry?.exitCode !== 0) return { status: 'uncovered', reason: '执行命令的退出码不是 0：' + String(entry?.exitCode) }
  return null
}

function evaluate( criterion, entry, report, snapshot, runtime, source, allowedCommands) {
  const base = {
    summary: text(entry?.summary),
    citations: list(entry?.citations).map((item) => ({
      file: text(item?.file), line: item?.line, anchor: text(item?.anchor),
    })),
    command: text(entry?.command), exitCode: entry?.exitCode,
    artifact: text(entry?.artifact), version: text(entry?.version),
  }
  const result = (status, reason) => ({ ...base, status, reason })
  if (!currentReport(report, snapshot)) return result('uncovered', '报告快照不完整或与当前代码版本不一致')
  if (entry?.version !== snapshot.id) return result('uncovered', '验收证据版本与当前代码版本不一致')
  if (!STATUSES.has(entry?.status)) return result('uncovered', '验收证据状态无效')
  // 环境受限不是「写一句理由就免检」：判定输入只能来自系统看到的事实——
  // 测试阶段提交、方法与 AC 声明一致、一条被授权的命令、非零退出码、失败原文齐全。
  // 缺任何一项就退回未覆盖，否则想通过的人只要学会填 excludeReason 就不必真的做事。
  if (entry.status === 'excluded') {
    if (source !== 'test') return result('uncovered', '评审阶段不能把验收标准标记为环境受限，只有测试阶段能声明')
    const reason = text(entry.excludeReason)
    if (!reason) return result('uncovered', '标记为环境受限但没写明原因，不能算作已声明')
    if (entry.method !== criterion.verification.method) return result('uncovered', '执行验证方法与验收标准声明不匹配')
    const probe = object(entry.probe) ? entry.probe : null
    if (!probe) return result('uncovered', '环境受限必须附探测记录：跑了哪条命令、退出码多少、报错原文是什么')
    const command = text(probe.command)
    if (!command) return result('uncovered', '探测记录缺少命令：没执行过就不能声称是环境限制')
    if (!list(allowedCommands).includes(command)) return result('uncovered', '探测命令不在授权命令清单内：' + command)
    const exitCode = probe.exitCode
    if (!Number.isSafeInteger(exitCode) || exitCode === 0) {
      return result('uncovered', '探测记录的退出码无效：环境受限必须是命令真的失败了（exitCode 为非零整数）')
    }
    const failure = text(probe.failure)
    if (!failure) return result('uncovered', '探测记录缺少失败原文：只有退出码无法区分环境限制与代码错误')
    if (!base.summary) return result('uncovered', '环境受限缺少非空说明')
    return { ...base, status: 'excluded', excludeReason: reason, probe: { command, exitCode, failure }, reason: '环境受限，无法验证：' + reason }
  }
  if (entry.status !== 'pass') return result(entry.status, entry.status === 'fail' ? '已报告该验收标准未通过' : '该验收标准尚未被验证')
  if (source !== 'test') return result('uncovered', '评审通过不能替代实际执行验证')
  if (entry.method !== criterion.verification.method) return result('uncovered', '执行验证方法与验收标准声明不匹配')
  if (criterion.verification.method === 'visual') return { ...base, ...visualResult(criterion, entry, runtime) }
  const proof = evidenceProof(entry, runtime, allowedCommands)
  if (proof) return { ...base, status: proof.status, reason: proof.reason }
  return result('pass', '当前代码版本的执行证据已核验')
}

/** Pure evidence ledger. Aggregate test totals and review passes never prove an AC. */
export function acceptanceLedger(flow, snapshot, runtime = {}) {
  const criteria = normalizeCriteria(flow?.scope?.data?.acceptance_criteria)
  const idCounts = new Map()
  for (const criterion of criteria) idCounts.set(criterion.id, (idCounts.get(criterion.id) || 0) + 1)
  const test = flow?.test
  const review = flow?.review
  // 探测命令必须在用户批准过的清单里：清单之外跑的东西不能被用来解释「环境不允许」。
  const scopeData = flow?.scope?.data
  const allowedCommands = list(scopeData?.in_scope?.commands ?? scopeData?.commands).map(text).filter(Boolean)
  const items = criteria.map((criterion) => {
    const base = {
      id: criterion.id, when: criterion.when, then: criterion.then,
      method: criterion.verification.method, procedure: criterion.verification.procedure,
      status: test ? 'uncovered' : 'pending', summary: '', citations: [], command: '', exitCode: null, artifact: '', version: '',
      reason: test ? '已提交测试，但没有该验收标准的执行证据' : '尚未提交该验收标准的执行验证',
    }
    if (!validId(criterion.id)) return { ...base, status: 'uncovered', reason: '验收标准 ID 无效，无法关联执行证据' }
    if (idCounts.get(criterion.id) !== 1) return { ...base, status: 'uncovered', reason: '验收标准 ID 重复，无法唯一关联执行证据' }
    if (!text(criterion.when) || !text(criterion.then)) return { ...base, status: 'uncovered', reason: '验收标准缺少触发条件或预期结果' }
    const testEntries = list(test?.acceptance).filter((entry) => text(entry?.ac) === criterion.id)
    const reviewEntries = list(review?.acceptance).filter((entry) => text(entry?.ac) === criterion.id && entry?.status !== 'pass')
    const evaluated = testEntries.map((entry) => evaluate(criterion, entry, test, snapshot, runtime, 'test', allowedCommands))
    const reviewResults = reviewEntries.map((entry) => evaluate(criterion, entry, review, snapshot, runtime, 'review', allowedCommands))
    // Failures win over positive evidence; duplicate positives cannot silently mask conflicts.
    const failures = [...evaluated, ...reviewResults].filter((entry) => entry.status === 'fail')
    if (failures.length) return { ...base, ...failures[0] }
    if (testEntries.length > 1) return { ...base, status: 'uncovered', reason: '同一验收标准存在重复证据，必须先消除重复或冲突' }
    // Actual execution closes review gaps; current review failures were handled above.
    if (evaluated.length) return { ...base, ...evaluated[0] }
    if (reviewEntries.length > 1) return { ...base, status: 'uncovered', reason: '同一验收标准存在重复评审证据，必须先消除重复或冲突' }
    const reviewGap = reviewResults.find((entry) => entry.status === 'uncovered')
    if (reviewGap) return { ...base, ...reviewGap }
    return base
  })
  const counts = { total: items.length, pending: 0, pass: 0, fail: 0, uncovered: 0, excluded: 0 }
  for (const item of items) counts[item.status] += 1
  return { version: text(snapshot?.id), items, counts }
}

function normalizedFile(cwd, file) {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(cwd || '') || /^[a-z]:[\\/]|^\\\\/i.test(file || '')
  const paths = windows ? win32 : posix
  const result = paths.resolve(cwd || '.', file || '').replaceAll('\\', '/')
  return windows ? result.toLowerCase() : result
}

/** Build before clearing reports. The caller owns persistence of this return value. */
export function remediationList(flow, ledger, options = {}) {
  const items = []
  const advisories = []
  const declared = new Map(list(ledger?.items).map((item) => [item.id, item]))
  for (const item of list(ledger?.items)) {
    if (!['fail', 'uncovered', 'pending'].includes(item.status)) continue
    items.push({ ac: item.id, summary: item.reason || item.then || '该验收标准需要重新验证', source: 'acceptance', severity: item.status === 'fail' ? 'MAJOR' : 'MINOR', status: item.status })
  }
  const scope = flow?.scope?.data
  const allowed = new Set(list(scope?.in_scope?.files_expected_to_change ?? scope?.files_expected_to_change)
    .filter((file) => typeof file === 'string' && text(file))
    .map((file) => normalizedFile(flow?.cwd, file)))
  for (const angle of list(flow?.review?.angles)) {
    for (const finding of list(angle?.findings)) {
      const ac = text(finding?.ac)
      const known = validId(ac) && declared.has(ac) && list(ledger?.items).filter((item) => item.id === ac).length === 1
      // 范围判定只认系统实际读到的路径：resolvedFile 由 checkFinding 的读取结果写入，
      // 不是评审子代理自填的字符串。读不到文件的发现没有可信位置，按范围外处理。
      const target = text(finding?.resolvedFile)
      const inScope = Boolean(target) && allowed.has(normalizedFile(flow?.cwd, target))
      const severity = ['CRITICAL', 'MAJOR', 'MINOR'].includes(finding?.severity) ? finding.severity : 'MINOR'
      // 未核实的发现（证据标识符不在文件里、行号越界、basis.quote 对不上）不配进重做清单：
      // 重做清单是「去改哪里」的作业单，一条位置与描述对不上的条目会把执行者引到错的地方。
      const verified = finding?.unverified !== true
      const entry = {
        ac, summary: text(finding?.summary) || '评审发现需要复核',
        source: 'review', severity, status: known ? declared.get(ac).status : 'uncovered',
        ...(verified ? {} : { unverified: true }),
      }
      if (known && inScope && severity !== 'MINOR' && verified) items.push(entry)
      else advisories.push(entry)
    }
  }
  const rank = { fail: 0, uncovered: 1, pending: 2, pass: 3 }
  const severityRank = { CRITICAL: 0, MAJOR: 1, MINOR: 2 }
  items.sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || severityRank[a.severity] - severityRank[b.severity])
  return { reason: options.reason, note: options.note, at: options.at || new Date().toISOString(), items, advisories }
}

function reportCounts(report, key) {
  const entries = list(report?.[key])
  const reusedIds = new Set(list(report?.reused))
  const reused = entries.filter((entry) => reusedIds.has(entry?.id) || entry?.reused === true).length
  return { fresh: entries.length - reused, reused, total: entries.length }
}

/** Implementation, verification, runtime, and process execution are independent states. */
export function stageSummary(flow, ledger, runtime = {}) {
  const submitted = Boolean(flow?.devChanges)
  const changes = flow?.devChanges || {}
  const files = [...new Set([...list(changes.files), ...list(changes.untracked)]
    .map((file) => typeof file === 'string' ? file : file?.path).filter((file) => typeof file === 'string'))]
  const execution = object(flow?.execution) ? flow.execution : {}
  const status = flow?.cancelled ? 'cancelled' : ['running', 'completed', 'failed', 'cancelled'].includes(execution.status) ? execution.status : 'pending'
  const executionText = { pending: '尚无已确认的执行状态', running: '执行仍在进行，等待最终结果', completed: '执行已完成；验收结果请逐条查看验证状态', failed: '执行失败', cancelled: '执行或流程已取消' }
  const runtimeStatus = text(runtime.status) || 'unverified'
  return {
    implementation: { status: submitted ? 'submitted' : 'pending', text: submitted ? text(flow?.gateNote) || '开发结果已提交，等待逐条验收验证' : '开发结果尚未提交', files },
    verification: { total: 0, pending: 0, pass: 0, fail: 0, uncovered: 0, ...ledger?.counts },
    runtime: { status: runtimeStatus, text: text(runtime.reason) || text(runtime.text) || (runtimeStatus === 'verified' ? '运行中的宿主与客户端版本已验证' : '运行中的宿主与客户端版本尚未验证') },
    execution: { status, text: status === 'cancelled' ? executionText.cancelled : text(execution.text) || executionText[status] },
    review: reportCounts(flow?.review, 'angles'),
    test: reportCounts(flow?.test, 'directions'),
  }
}
