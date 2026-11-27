import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// check() 契约的元验证。
//
// 背景：test/host.test.mjs 曾有五处 `check(名称, () => {})`，断言写在调用之前。
// 那种写法不会让断言消失，但会切断名字与失败的对应关系：断言抛出时 check 那一行
// 根本没进去，既不打印 FAIL <用例名>，也不进 passed；反过来，有人把断言删掉或改成
// 恒真时，名字照旧打印 ok 并计入「全部通过」。名字说「这组行为有人守着」，实际没有。
// 同一形态的另一半是 `() => assert.ok(true)`：占位符替掉了真正的断言，效果一样。
//
// 这里不做「测试有没有失败」的判断——那由各套件自己负责。这里只判断一件更前置的事：
// 每个 check 的回调里到底有没有一条可能失败的断言。这条契约一旦破了，整套用例的
// 结论都不再可信，而且不会有任何东西报错。

const MODES = { code: 0, line: 1, block: 2, single: 3, double: 4, template: 5, regex: 6 }

// 正则字面量与除号在源码里长得一样，只能靠前一个代码字符判断。
// 这个启发式在测试代码里足够：正则几乎总是出现在 `(`、`,`、`=` 之后。
const REGEX_PREFIX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'return', 'typeof', 'case', 'in', 'of'])

// codeMask 把源码切成「代码态」与「非代码态」。字符串、模板、注释、正则字面量的内容
// 不参与结构判断——否则注释里写一句 check('x', () => {}) 就能骗过扫描。
function codeMask(source) {
  const mask = new Uint8Array(source.length)
  const templateStack = []
  let mode = MODES.code
  let lastWord = ''
  let word = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (mode === MODES.line) {
      if (char === '\n') mode = MODES.code
      index += 1
      continue
    }
    if (mode === MODES.block) {
      if (char === '*' && source[index + 1] === '/') {
        mode = MODES.code
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (mode === MODES.single || mode === MODES.double) {
      if (char === '\\') { index += 2; continue }
      if ((mode === MODES.single && char === "'") || (mode === MODES.double && char === '"')) mode = MODES.code
      index += 1
      continue
    }
    if (mode === MODES.template) {
      if (char === '\\') { index += 2; continue }
      if (char === '`') { mode = MODES.code; index += 1; continue }
      if (char === '$' && source[index + 1] === '{') {
        templateStack.push('tpl')
        mode = MODES.code
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (mode === MODES.regex) {
      if (char === '\\') { index += 2; continue }
      if (char === '[') {
        index += 1
        while (index < source.length) {
          if (source[index] === '\\') { index += 2; continue }
          if (source[index] === ']') break
          if (source[index] === '\n') break
          index += 1
        }
        index += 1
        continue
      }
      if (char === '/') {
        mode = MODES.code
        index += 1
        while (index < source.length && /[a-z]/i.test(source[index])) index += 1
        continue
      }
      index += 1
      continue
    }
    // 代码态
    mask[index] = 1
    if (char === '/' && source[index + 1] === '/') { mask[index] = 0; mode = MODES.line; index += 2; continue }
    if (char === '/' && source[index + 1] === '*') { mask[index] = 0; mode = MODES.block; index += 2; continue }
    if (char === "'") { mode = MODES.single; index += 1; continue }
    if (char === '"') { mode = MODES.double; index += 1; continue }
    if (char === '`') { mode = MODES.template; index += 1; continue }
    if (char === '/') {
      if (REGEX_PREFIX.has(lastWord)) { mask[index] = 0; mode = MODES.regex; index += 1; continue }
      lastWord = ''
      index += 1
      continue
    }
    if (char === '{' && templateStack.length) { templateStack.push('brace'); index += 1; continue }
    if (char === '}' && templateStack.length) {
      if (templateStack[templateStack.length - 1] === 'brace') {
        templateStack.pop()
        index += 1
        continue
      }
      templateStack.pop()
      mode = MODES.template
      index += 1
      continue
    }
    if (/[\w$]/.test(char)) {
      word += char
    } else {
      if (word) { lastWord = word; word = '' }
      if (!/\s/.test(char)) lastWord = ''
    }
    index += 1
  }
  return mask
}

// 把非代码态字符换成空格，得到只保留结构的骨架。字符串内容不参与判定：
// 我们只关心「有没有 assert」，而 assert 一定是标识符，不会被引号包住。
function skeleton(source, mask) {
  let out = ''
  for (let index = 0; index < source.length; index += 1) out += mask[index] ? source[index] : ' '
  return out
}

function findCalls(source, mask) {
  const calls = []
  for (let index = 0; index < source.length; index += 1) {
    if (!mask[index]) continue
    if (!source.startsWith('check', index)) continue
    if (index > 0 && /[\w$.]/.test(source[index - 1])) continue
    // `function check(label, fn)` 是定义，不是调用。
    const before = skeleton(source.slice(Math.max(0, index - 24), index), mask.slice(Math.max(0, index - 24), index)).trimEnd()
    if (/(?:^|\W)function$/.test(before)) continue
    let open = index + 5
    while (open < source.length && /\s/.test(source[open])) open += 1
    if (source[open] !== '(' || !mask[open]) continue
    let depth = 0
    let close = open
    for (; close < source.length; close += 1) {
      if (!mask[close]) continue
      if (source[close] === '(') depth += 1
      else if (source[close] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (close >= source.length) continue
    // 对象字面量或类里的方法简写 `check(name, args = {}, ...) { ... }` 是定义，不是调用：
    // 真正的调用后面跟的是换行、分号或右括号。
    let after = close + 1
    while (after < source.length && /\s/.test(source[after])) after += 1
    if (source[after] === '{' && mask[after]) continue
    calls.push({ start: index, open, close })
  }
  return calls
}

function splitArguments(source, mask, open, close) {
  const parts = []
  let depth = 0
  let start = open + 1
  for (let index = open + 1; index < close; index += 1) {
    if (!mask[index]) continue
    const char = source[index]
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push({ from: start, to: index })
      start = index + 1
    }
  }
  parts.push({ from: start, to: close })
  return parts
}

const ASSERT_HINT = /\b(?:assert|throws|rejects|expect)\b/
const TRIVIAL_OK = /^\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*(?:\{\s*)?assert\.ok\(\s*true\s*\)\s*;?\s*\}?\s*$/
const TRIVIAL_SELF = /^\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*(?:\{\s*)?assert\.(?:equal|strictEqual|deepEqual)\(\s*([\w$.]+)\s*,\s*\1\s*\)\s*;?\s*\}?\s*$/

// 只认「回调里没有一条可能失败的断言」这一件事，分三种形态。
// 空回调与 assert.ok(true) 是同一个毛病的两副面孔：名字还在，断言没了。
function classify(source, mask, call) {
  const parts = splitArguments(source, mask, call.open, call.close)
  if (parts.length < 2) return null
  const callback = skeleton(source.slice(parts[1].from, parts[1].to), mask.slice(parts[1].from, parts[1].to)).trim()
  // 裸标识符是 check 的定义或转调（`check(name, fn)`），不是一条用例。
  if (/^[\w$.]+$/.test(callback)) return null
  const EMPTY_ARROW = /^(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*\{\s*\}$/
  const EMPTY_FUNCTION = /^(?:async\s+)?function[\w$]*\([^)]*\)\s*\{\s*\}$/
  if (!callback || EMPTY_ARROW.test(callback) || EMPTY_FUNCTION.test(callback)) {
    return { kind: 'empty', reason: '回调是空函数' }
  }
  if (TRIVIAL_OK.test(callback)) return { kind: 'trivial', reason: '回调里只有 assert.ok(true)' }
  if (TRIVIAL_SELF.test(callback)) return { kind: 'trivial', reason: '回调里只有自己等于自己的断言' }
  if (!ASSERT_HINT.test(callback)) return { kind: 'no-assert', reason: '回调里没有任何断言' }
  return null
}

function lineOf(source, index) {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) if (source[cursor] === '\n') line += 1
  return line
}

// scanSource 是纯函数：给一段源码，回它违反了哪些契约。自检与真实扫描走同一条路径，
// 所以自检通过才说明真实扫描的判定是真的在判定。
export function scanSource(source, label = '<source>') {
  const mask = codeMask(source)
  const violations = []
  let calls = 0
  for (const call of findCalls(source, mask)) {
    const verdict = classify(source, mask, call)
    if (verdict === null) {
      const parts = splitArguments(source, mask, call.open, call.close)
      if (parts.length >= 2) {
        const callback = skeleton(source.slice(parts[1].from, parts[1].to), mask.slice(parts[1].from, parts[1].to)).trim()
        if (!/^[\w$.]+$/.test(callback)) calls += 1
      }
      continue
    }
    calls += 1
    violations.push({ file: label, line: lineOf(source, call.start), kind: verdict.kind, reason: verdict.reason })
  }
  return { calls, violations }
}

// —— 源码不变量：frozen 字段必须来自真正的冻结标志 ——
// 同一个判定在 lib/index.js 里曾并存三种写法，其中 Boolean(flow.scope) 只要方案对象还在
// 就答「已冻结」。它在正常路径上碰巧不出错（退回 S1 会同时清空阶段并解冻 scope），所以
// 行为测试很难钉住；这里用逐行扫描保证这个表达式不会再被写回来。
// 不用 codeMask：它在 7000+ 行的 lib/index.js 上会把整段代码误判成非代码态（实测
// 含 4563 的零段是 4556–4590），守卫会静默失效。lib/ 的字段一律独占一行，窄规则就够。
function scanFrozenBoolean(source, label = '<source>') {
  const violations = []
  source.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*frozen\s*:\s*Boolean\s*\(/.test(line)) {
      violations.push({
        file: label,
        line: index + 1,
        reason: 'frozen 字段用 Boolean(...) 判定：只要方案对象存在就会答「已冻结」，应写 flow.scope?.frozen === true',
      })
    }
  })
  return violations
}

const INVARIANT_SELF_TESTS = [
  ['行首属性用 Boolean 被判违规', 'frozen: Boolean(flow.scope)', 1],
  ['带缩进同样违规', '          frozen: Boolean(flow.scope),', 1],
  ['冒号后不留空格也违规', 'frozen:Boolean(scope)', 1],
  ['正确写法放行', 'frozen: flow.scope?.frozen === true,', 0],
  ['行尾注释里的旧写法不误伤', 'frozen: flow.scope?.frozen === true, // frozen: Boolean(x)', 0],
  ['整行注释不算', '// frozen: Boolean(flow.scope)', 0],
  ['块注释行不算', ' * frozen: Boolean(flow.scope)', 0],
  ['字符串里的旧写法不算', "const s = 'frozen: Boolean(flow.scope)'", 0],
  ['内联对象写法不在本规则覆盖范围（如实记录）', 'const x = { frozen: Boolean(flow.scope) }', 0],
]

function invariantSelfTest() {
  const failures = []
  for (const [name, source, expected] of INVARIANT_SELF_TESTS) {
    const found = scanFrozenBoolean(source).length
    if (found !== expected) failures.push(name + '：期望 ' + expected + ' 处，实际 ' + found + ' 处')
  }
  if (failures.length) {
    for (const failure of failures) console.error('  FAIL ' + failure)
    console.error('frozen 不变量自检失败：' + failures.length + ' / ' + INVARIANT_SELF_TESTS.length)
    return 1
  }
  console.log('frozen 不变量自检通过：' + INVARIANT_SELF_TESTS.length + ' 个用例')
  return 0
}

// 静默截断规则。
//
// 背景（G19）：报告曾经是「先截断再统计」——把方向截到 40 个、要点截到 200 条，
// 然后用截断后的数组去数 fail。排在后面的失败根本没被数过，门禁于是显示 0 失败并放行。
// 那条 bug 不会抛错、不会留日志，只会让结论建立在残缺数据上，所以必须由静态规则守着。
//
// 这条规则刻意做得窄：只盯「规范化提交」这三个函数体，以及历史滚动淘汰的写法。
// 全仓扫描 .slice( 会淹死在字符串截断与分页里，那种规则只会被加白名单绕过。
const NORMALIZER_NAMES = ['normalizeSubmittedDirections', 'normalizeSubmittedAngles', 'normalizeAcceptance']

/** 取一个具名函数的大括号体；注释与字符串里的括号不在这些函数体里出现，按配对切即可。 */
function functionBody(source, name) {
  const marker = 'function ' + name + '('
  const start = source.indexOf(marker)
  if (start < 0) return null
  const open = source.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return { body: source.slice(open, index + 1), offset: open }
    }
  }
  return null
}

function scanSilentTruncation(source, file = '') {
  const violations = []
  const push = (offset, reason) => {
    const line = source.slice(0, Math.max(0, offset)).split('\n').length
    violations.push({ file, line, reason })
  }
  // 只有宿主主体才该定义这三个函数；别的模块不该被要求有它们。
  const ownsNormalizers = !file || /index\.js$/.test(file)
  if (ownsNormalizers) {
    for (const name of NORMALIZER_NAMES) {
      const found = functionBody(source, name)
      if (!found) {
        push(0, '找不到 ' + name + '：它守着「规范化提交不许丢数据」，改名时必须同步改这条规则')
        continue
      }
      const index = found.body.indexOf('.slice(')
      if (index >= 0) {
        push(found.offset + index, name + ' 里出现 .slice(：规范化阶段替提交方丢数据，判定会建立在残缺输入上；超限应当抛错拒绝')
      }
    }
  }
  const rolling = source.indexOf('.slice(-19)')
  if (rolling >= 0) push(rolling, '出现 .slice(-19)：按时间滚动淘汰证据，会让已经通过的验收倒退回「没有证据」')
  return violations
}

const TRUNCATION_SELF_TESTS = (() => {
  const empty = NORMALIZER_NAMES.map((name) => 'function ' + name + '(a, b) {\n  return a\n}\n').join('')
  const withSlice = empty.replace(
    'function normalizeAcceptance(a, b) {\n  return a\n}',
    'function normalizeAcceptance(a, b) {\n  return a.slice(0, 160)\n}',
  )
  return [
    ['规范化函数不截断时放行', empty, 0],
    ['规范化函数里截断被判违规', withSlice, 1],
    ['滚动淘汰被判违规', empty + 'flow.layoutEvidence = [...(flow.layoutEvidence ?? []).slice(-19), receipt]', 1],
    ['三个函数都缺失时逐个报出', 'const a = 1', 3],
  ]
})()

function truncationSelfTest() {
  const failures = []
  for (const [name, source, expected] of TRUNCATION_SELF_TESTS) {
    const found = scanSilentTruncation(source, 'index.js').length
    if (found !== expected) failures.push(name + '：期望 ' + expected + ' 处，实际 ' + found + ' 处')
  }
  if (failures.length) {
    for (const failure of failures) console.error('  FAIL ' + failure)
    console.error('静默截断自检失败：' + failures.length + ' / ' + TRUNCATION_SELF_TESTS.length)
    return 1
  }
  console.log('静默截断自检通过：' + TRUNCATION_SELF_TESTS.length + ' 个用例')
  return 0
}

const INVARIANT_DIR = 'lib'

function collectJs(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) collectJs(full, out)
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const SELF_TESTS = [  ['空回调被判为违规', "check('x', () => {})", ['empty']],
  ['带空格的空回调', "check('x', () => { })", ['empty']],
  ['async 空回调', "check('x', async () => {})", ['empty']],
  ['只有注释的回调', "check('x', () => { /* 待补 */ })", ['empty']],
  ['assert.ok(true) 占位', "check('x', () => assert.ok(true))", ['trivial']],
  ['块体里的 assert.ok(true)', "check('x', () => { assert.ok(true) })", ['trivial']],
  ['自己等于自己', "check('x', () => assert.equal(a, a))", ['trivial']],
  ['正常断言放行', "check('x', () => { assert.equal(a, 1) })", []],
  ['块体多语句放行', "check('x', () => {\n  const y = 1\n  assert.equal(y, 1)\n})", []],
  ['异步块体放行', "check('x', async () => { await go(); assert.equal(a, 1) })", []],
  ['字符串里的空 check 不算', "const s = \"check('x', () => {})\"", []],
  ['模板里的空 check 不算', 'const s = `check(\'x\', () => {})`', []],
  ['注释里的空 check 不算', "// check('x', () => {})\nconst a = 1", []],
  ['块注释里的空 check 不算', "/* check('x', () => {}) */\nconst a = 1", []],
  ['正则里的空 check 不算', "const re = /check\\('x', \\(\\) => \\{\\}\)/\nconst a = 1", []],
  ['定义处不算', 'function check(label, fn) { fn() }', []],
  ['转调不算', "const wrap = (fn) => check('x', fn)", []],
  ['一处违规一处正常只报一处', "check('a', () => {})\ncheck('b', () => assert.ok(true))\ncheck('c', () => { assert.ok(1) })", ['empty', 'trivial']],
]

function selfTest() {
  const failures = []
  for (const [name, source, expected] of SELF_TESTS) {
    const { violations } = scanSource(source)
    const kinds = violations.map((violation) => violation.kind)
    if (kinds.length !== expected.length || kinds.some((kind, index) => kind !== expected[index])) {
      failures.push(name + '：期望 [' + expected.join(',') + ']，实际 [' + kinds.join(',') + ']')
    }
  }
  if (failures.length) {
    for (const failure of failures) console.error('  FAIL ' + failure)
    console.error('check 契约自检失败：' + failures.length + ' / ' + SELF_TESTS.length)
    return 1
  }
  console.log('check 契约自检通过：' + SELF_TESTS.length + ' 个用例')
  return 0
}

const TARGET_DIR = 'test'
const TARGET_EXT = '.test.mjs'

function targetFiles(root) {
  const dir = resolve(root, TARGET_DIR)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // 隔离夹具只复制了部分目录，不该因此判失败。
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(TARGET_EXT))
    .map((entry) => resolve(dir, entry.name))
    .sort()
}

function main(argv) {
  const args = argv.slice(2)
  let root = fileURLToPath(new URL('../', import.meta.url))
  let rootSet = false
  let runSelfTest = false
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root' && !rootSet && args[index + 1] && !args[index + 1].startsWith('--')) {
      root = resolve(args[++index])
      rootSet = true
    } else if (args[index] === '--self-test') {
      runSelfTest = true
    } else {
      console.error('Usage: node scripts/verify-checks.mjs [--root path] [--self-test]')
      return 2
    }
  }
  if (runSelfTest) return selfTest() || invariantSelfTest() || truncationSelfTest()
  // 默认先自检再扫描：一条命令同时证明「判定本身在判定」与「仓库没有违约」，
  // 聚合器和 npm run check 才能共用同一个入口。
  const selfStatus = selfTest()
  if (selfStatus) return selfStatus
  const invariantStatus = invariantSelfTest()
  if (invariantStatus) return invariantStatus
  const truncationStatus = truncationSelfTest()
  if (truncationStatus) return truncationStatus

  const files = targetFiles(root)
  if (!files.length) {
    // 没有测试文件时不能假装通过：夹具目录里没有 test/ 是配置问题，不是「零违规」。
    console.error('没有找到 ' + TARGET_DIR + '/*' + TARGET_EXT + '，无法验证 check 契约')
    return 1
  }
  let calls = 0
  const violations = []
  for (const file of files) {
    const result = scanSource(readFileSync(file, 'utf8'), file)
    calls += result.calls
    violations.push(...result.violations)
  }
  if (violations.length) {
    for (const violation of violations) {
      console.error('  FAIL ' + violation.file + ':' + violation.line + ' ' + violation.reason)
    }
    console.error('check 契约被破坏：' + violations.length + ' 处（扫描 ' + files.length + ' 个文件、' + calls + ' 处调用）')
    return 1
  }
  if (!calls) {
    console.error('扫描了 ' + files.length + ' 个文件却没有找到任何 check 调用，判定不可信')
    return 1
  }
  const invariantFiles = collectJs(resolve(root, INVARIANT_DIR))
  const invariantViolations = []
  for (const file of invariantFiles) invariantViolations.push(...scanFrozenBoolean(readFileSync(file, 'utf8'), file))
  if (invariantViolations.length) {
    for (const violation of invariantViolations) {
      console.error('  FAIL ' + violation.file + ':' + violation.line + ' ' + violation.reason)
    }
    console.error('frozen 不变量被破坏：' + invariantViolations.length + ' 处（扫描 ' + invariantFiles.length + ' 个文件）')
    return 1
  }
  const truncationViolations = []
  for (const file of invariantFiles) truncationViolations.push(...scanSilentTruncation(readFileSync(file, 'utf8'), file))
  if (truncationViolations.length) {
    for (const violation of truncationViolations) {
      console.error('  FAIL ' + violation.file + ':' + violation.line + ' ' + violation.reason)
    }
    console.error('静默截断被引入：' + truncationViolations.length + ' 处（扫描 ' + invariantFiles.length + ' 个文件）')
    return 1
  }
  console.log('check contracts verified (' + calls + ' calls in ' + files.length + ' files).')
  if (invariantFiles.length) console.log('frozen invariants verified (' + invariantFiles.length + ' files).')
  else console.log('没有 ' + INVARIANT_DIR + '/ 目录，跳过 frozen 不变量扫描')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv)
}
