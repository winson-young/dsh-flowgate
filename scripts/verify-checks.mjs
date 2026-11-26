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

const SELF_TESTS = [
  ['空回调被判为违规', "check('x', () => {})", ['empty']],
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
  if (runSelfTest) return selfTest()
  // 默认先自检再扫描：一条命令同时证明「判定本身在判定」与「仓库没有违约」，
  // 聚合器和 npm run check 才能共用同一个入口。
  const selfStatus = selfTest()
  if (selfStatus) return selfStatus

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
  console.log('check contracts verified (' + calls + ' calls in ' + files.length + ' files).')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv)
}
