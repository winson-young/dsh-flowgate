import { readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

// 语法自检的文件名单不手写：按目录展开，新增文件自动纳入。
// 手写名单必然漏——漏掉的文件要到运行期才暴露语法错误，而 check 通过曾被当成「提交是安全的」。
const TARGETS = [
  { dir: 'lib', ext: '.js' },
  { dir: 'docs', ext: '.mjs' },
  { dir: 'scripts', ext: '.mjs' },
  { dir: 'test', ext: '.mjs' },
]

// 只吞掉 stripTypeScriptTypes 那一条实验性警告。它走的是 Node 的默认打印，不经过 'warning'
// 事件（监听器拦不住），必须在 emitWarning 这一层过滤；其余警告原样交给默认处理器。
const emitWarning = process.emitWarning
process.emitWarning = function (warning, ...rest) {
  const name = warning && typeof warning === 'object' ? warning.name : rest[0]
  const message = warning && typeof warning === 'object' ? warning.message : String(warning)
  if (name === 'ExperimentalWarning' && /stripTypeScriptTypes/.test(message)) return
  return emitWarning.call(process, warning, ...rest)
}

const args = process.argv.slice(2)
let root = fileURLToPath(new URL('../', import.meta.url))
let rootSet = false
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--root' && !rootSet && args[index + 1] && !args[index + 1].startsWith('--')) {
    root = resolve(args[++index])
    rootSet = true
  } else {
    console.error('Usage: node scripts/check-syntax.mjs [--root path]')
    process.exit(2)
  }
}

const files = []
for (const target of TARGETS) {
  const dir = resolve(root, target.dir)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // 目录不存在时跳过：隔离夹具只复制了部分目录，不该因此报语法失败。
    continue
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(target.ext)) continue
    files.push(resolve(dir, entry.name))
  }
}
files.sort()

// 首选 node --check（与旧 check 逐字等价）。宿主若禁止再起 Node 子进程（EPERM / EACCES），
// 退化为进程内解析：结论弱一些（只解析、不判 ESM 语义），但不静默跳过，并把降级写在输出里。
// 一旦确认起不了子进程就不再逐文件重试：沙箱是进程级限制，重试只会多出 N 次必然失败的 spawn。
let degraded = false
function checkWithChild(file) {
  if (degraded) return checkInProcess(file)
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    return null
  } catch (error) {
    const code = error && error.code
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') {
      degraded = true
      return checkInProcess(file)
    }
    const stderr = error && error.stderr ? String(error.stderr).trim() : String(error && error.message)
    return stderr || 'node --check failed'
  }
}

// 懒加载：只有在真要降级时才碰这个实验性 API。能起子进程的环境因此完全不会看到那条警告。
function stripTypes(source) {
  return require('node:module').stripTypeScriptTypes(source)
}

function checkInProcess(file) {
  const source = readFileSync(file, 'utf8')
  try {
    stripTypes(source)
    return null
  } catch (error) {
    return error && error.message ? String(error.message) : 'parse failed'
  }
}

let failed = 0
for (const file of files) {
  const problem = checkWithChild(file)
  if (!problem) continue
  failed += 1
  console.error('Syntax error: ' + file)
  console.error(problem)
}

if (failed) {
  console.error('Syntax check failed in ' + failed + '/' + files.length + ' files.')
  process.exitCode = 1
} else {
  const note = degraded ? '（宿主禁止子进程，已退化为进程内解析）' : ''
  console.log('Syntax verified (' + files.length + ' files)' + note + '.')
}
