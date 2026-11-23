/**
 * 启动一个带 CDP 调试端口的 DSH 桌面端实例，供 docs/verify-layout.mjs 与
 * docs/capture-ui.mjs 连接。用法：node scripts/start-cdp.mjs [参数]
 *
 * 为什么需要这个脚本：宿主以 ELECTRON_RUN_AS_NODE=1 启动子进程，这个变量会让
 * Electron 二进制退化成纯 node 解释器，于是 --remote-debugging-port 被当成 node
 * 的非法参数，进程报 bad option 后立刻退出。启动前必须把该变量从子进程环境里摘掉。
 *
 * 默认使用项目内的独立用户数据目录（.dsh-flowgate/cdp-profile，已被 .gitignore
 * 覆盖），因此不会与日常使用的实例抢单实例锁；代价是这个窗口是独立会话。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const valueOf = name => {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  return value && !value.startsWith('--') ? value : undefined
}

if (args.includes('--help')) {
  console.log(`用法：node scripts/start-cdp.mjs [参数]

启动带 CDP 调试端口的 DSH 桌面端实例，供布局取证与界面截图脚本连接。
可选参数：
  --port <端口>        CDP 调试端口，默认 9222
  --exe <可执行文件>   DSH 桌面端可执行文件；默认读 DSH_NODE_EXECUTABLE，
                       再从 DSH_INSTALL_DIR 推断安装目录
  --profile <目录>     用户数据目录，默认 <项目>/.dsh-flowgate/cdp-profile。
                       用独立目录才不会与日常实例抢单实例锁
  --timeout <秒>       等待 CDP 就绪的秒数，默认 30
  --dry-run            只打印将要执行的命令，不启动实例
  --help               显示本帮助

端口上已有可用的 CDP 时脚本直接报告地址并退出 0，不会重复启动。
实例启动后脚本即退出，窗口留在后台；关闭窗口即结束该实例。

下一步：
  npm run ui:verify
  node docs/verify-layout.mjs --cdp http://127.0.0.1:9222 --page-url '<页面URL>' --session-id '<会话ID>' --task-selector '<任务条选择器>' --goal-selector '<目标条选择器>'`)
  process.exit(0)
}

const port = Number(valueOf('--port') ?? 9222)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('--port 必须是 1 到 65535 之间的整数：' + valueOf('--port'))
const timeoutSeconds = Number(valueOf('--timeout') ?? 30)
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw Error('--timeout 必须是正数：' + valueOf('--timeout'))
const dryRun = args.includes('--dry-run')
const profileDir = path.resolve(valueOf('--profile') ?? path.join(projectRoot, '.dsh-flowgate', 'cdp-profile'))

// 安装目录：DSH_INSTALL_DIR 指向 resources/app.asar/dsh/node_modules/@deepseek-ai/dsh，
// 往上找到含 resources 子目录的那一层就是安装根。
const installDirFromEnv = () => {
  const start = process.env.DSH_INSTALL_DIR
  if (!start) return null
  let current = path.resolve(start)
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(path.join(current, 'resources'))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}
const resolveExecutable = () => {
  const explicit = valueOf('--exe')
  if (explicit) {
    if (!existsSync(explicit)) throw Error('--exe 指定的文件不存在：' + explicit)
    return explicit
  }
  const fromEnv = process.env.DSH_NODE_EXECUTABLE
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const installDir = installDirFromEnv()
  if (!installDir) {
    throw Error('找不到 DSH 桌面端可执行文件。请用 --exe 指定，或设置 DSH_NODE_EXECUTABLE；在 DSH 会话里执行 echo $DSH_NODE_EXECUTABLE 可以拿到路径。')
  }
  const candidates = readdirSync(installDir).filter(name => name.toLowerCase().endsWith('.exe') && !name.toLowerCase().startsWith('uninstall'))
  if (candidates.length !== 1) {
    throw Error('安装目录 ' + installDir + ' 下有 ' + candidates.length + ' 个候选可执行文件（' + (candidates.join('、') || '无') + '），请用 --exe 明确指定。')
  }
  return path.join(installDir, candidates[0])
}

const probe = async () => {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(2000) })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}
const pageUrls = async () => {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(2000) })
    if (!response.ok) return []
    const list = await response.json()
    return list.filter(page => page.type === 'page').map(page => page.url)
  } catch {
    return []
  }
}
const describe = async version => {
  const urls = await pageUrls()
  return ['CDP 已就绪：http://127.0.0.1:' + port, '浏览器：' + (version.Browser ?? '未知'), urls.length ? '页面：' + urls.join('、') : '页面：（暂无）'].join('\n')
}

const running = await probe()
if (running) {
  console.log(await describe(running))
  console.log('端口已被现有实例占用，未重复启动。')
  if (dryRun) {
    try {
      console.log('（--dry-run）本应启动：' + resolveExecutable() + ' --remote-debugging-port=' + port + ' --user-data-dir=' + profileDir)
    } catch (error) {
      console.log('（--dry-run）未能解析可执行文件：' + error.message)
    }
  }
  process.exit(0)
}

const executable = resolveExecutable()
const installDir = path.dirname(executable)
const launchArgs = ['--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + profileDir]

// 关键：ELECTRON_RUN_AS_NODE 会让 Electron 退化成 node，调试端口参数随之失效。
const env = { ...process.env }
for (const key of ['ELECTRON_RUN_AS_NODE', 'DSH_NODE_EXECUTABLE', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key]
if (env.NODE_OPTIONS && /--inspect/.test(env.NODE_OPTIONS)) delete env.NODE_OPTIONS

console.log('可执行文件：' + executable)
console.log('用户数据目录：' + profileDir)
console.log('启动参数：' + launchArgs.join(' '))
if (dryRun) {
  console.log('已按 --dry-run 停止，未启动实例。')
  process.exit(0)
}

mkdirSync(profileDir, { recursive: true })
const child = spawn(executable, launchArgs, { cwd: installDir, detached: true, stdio: 'ignore', env })
child.unref()

const deadline = Date.now() + timeoutSeconds * 1000
let version = null
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 500))
  version = await probe()
  if (version) break
}

if (!version) {
  console.error('等待 ' + timeoutSeconds + ' 秒后端口 ' + port + ' 仍不可用。')
  console.error('常见原因：可执行文件不是 DSH 桌面端、端口被别的程序占用、或环境变量 ELECTRON_RUN_AS_NODE 没被清掉。')
  process.exit(1)
}
console.log(await describe(version))
console.log('实例已在后台运行，关闭该窗口即结束它。')
console.log('下一步：npm run ui -- --verify-only')
