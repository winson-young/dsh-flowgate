/**
 * 解释器与生态登记表：宿主判定 shell 命令时唯一的事实来源。
 *
 * 守卫与体检从同一登记表派生规则：
 *  - 只读白名单（`node --version`、`npm --version`）
 *  - 单文件纯解析命令（`node --check file.js`）
 *  - 逃逸检查里的解释器内联执行名单
 *  - 验收体检里的测试命令识别与超宽命令判定
 *
 * 它们原本是四段写死的正则，加一个语言就要改四处，而且改漏一处不会有任何报错：
 * `php -r` 能执行任意代码，却因为 php 不在名单里而一路放行。所以收敛成一张表，
 * 新增生态只改这里一处，插件自己维护，不需要用户配置。
 *
 * 守卫字段 inline/parse/version 必须声明各解释器自己的标志与完整参数边界，
 * 因为 parse/version 会影响免授权范围，不能继承任意尾参或跨语言标志。
 * 体检字段 runtimes/managers/test/broad/needs 则保持宽松识别，辅助核对清单与环境。
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { registerModuleRevision } from './revisions.js'

export const FLOWGATE_MODULE_REVISION = '3ef428c3d2fff810bfc7b833489720330fa33f7ad71e6493ad3e352937baec2a'
registerModuleRevision(import.meta.url, FLOWGATE_MODULE_REVISION)

// parse/version 的每条规则声明自己的可执行名与完整参数边界，绝不继承任意尾参。
// inline 的短标志允许相邻源码；shortPrefix 只列不消费下一个参数的组合标志。

/**
 * 生态登记。
 *
 * 字段含义：
 *  - runtimes  该生态的解释器可执行名（可以不带扩展名）
 *  - managers  包管理器 / 构建入口，它们本身不内联执行，但能拉起任意脚本
 *  - markers   仓库里出现这些文件，说明该生态是「本项目真的在用」，体检才核对可执行文件
 *  - inline    按解释器声明 names / flags / shortPrefix / ignoreCase，标志不跨语言混用
 *  - parse     明确可免授权的语法解析形式：names / flags / file（仅一个位置文件）
 *  - version   明确会退出的版本探测形式：names / flags，无额外参数
 *  - test      识别「这是一条测试命令」的正则片段
 *  - broad     超宽通配判定里要列出的名字
 *  - needs     该名字必须先有谁才能跑起来（npm 本身是 node 程序）；不写表示自包含
 */
const ECOSYSTEMS = [
  {
    id: 'node',
    label: 'Node.js',
    runtimes: ['node', 'nodejs'],
    managers: ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'corepack'],
    needs: { npm: ['node'], pnpm: ['node'], yarn: ['node'], npx: ['node'], corepack: ['node'] },
    markers: ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'],
    inline: [
      { names: ['node', 'nodejs', 'bun'], flags: ['-e', '--eval', '-p', '--print'], shortPrefix: 'i' },
      { names: ['npx'], flags: ['-c', '--call'], shortPrefix: '' },
    ],
    parse: [{ names: ['node', 'nodejs'], flags: ['--check', '-c'], file: true }],
    version: [{ names: ['node', 'nodejs', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'corepack'], flags: ['--version', '-v'] }],
    test: [
      '\\b(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test\\b',
      '\\bnode\\s+--test\\b',
      '\\bnode\\s+test/',
      '\\b(?:vitest|jest|mocha|ava|playwright|karma|tap)\\b',
      '\\bnpx\\s+(?:vitest|jest|playwright|mocha)\\b',
    ],
    broad: ['node', 'nodejs', 'npx'],
  },
  {
    id: 'deno',
    label: 'Deno',
    runtimes: ['deno'],
    managers: [],
    markers: ['deno.json', 'deno.jsonc', 'deno.lock'],
    inline: [{ names: ['deno'], flags: ['eval'] }],
    // check 可读取隐式配置、解析依赖并写缓存，必须走批准清单。
    parse: [],
    version: [{ names: ['deno'], flags: ['--version', '-V'] }],
    test: ['\\bdeno\\s+test\\b'],
    broad: ['deno'],
  },
  {
    id: 'python',
    label: 'Python',
    runtimes: ['python', 'python3', 'py'],
    managers: ['pip', 'pip3', 'poetry', 'uv', 'pipenv', 'hatch', 'pdm'],
    // 候选写法：任一存在即算通过，吸收 python / python3 / py 的跨平台命名差异：
    // Windows 上常见的只有 py 启动器，缺了 py 会把装了 Python 的机器判成缺依赖。
    needs: {
      pip: ['python', 'python3', 'py'], pip3: ['python', 'python3', 'py'], poetry: ['python', 'python3', 'py'],
      uv: ['python', 'python3', 'py'], pipenv: ['python', 'python3', 'py'], hatch: ['python', 'python3', 'py'],
      pdm: ['python', 'python3', 'py'],
    },
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'tox.ini', 'Pipfile'],
    inline: [{ names: ['python', 'python3', 'py'], flags: ['-c'], shortPrefix: 'bBdEhiIOPqRsSuvVx' }],
    parse: [],
    version: [
      { names: ['python', 'python3', 'py'], flags: ['--version', '-V'] },
      { names: ['pip', 'pip3', 'poetry', 'uv', 'pipenv', 'hatch', 'pdm'], flags: ['--version'] },
    ],
    test: ['\\bpytest\\b', '\\bpython3?\\s+-m\\s+(?:pytest|unittest)\\b', '\\btox\\b', '\\bnox\\b', '\\bpoetry\\s+run\\s+pytest\\b'],
    broad: ['python', 'python3', 'pip', 'pip3'],
  },
  {
    id: 'php',
    label: 'PHP',
    runtimes: ['php'],
    managers: ['composer'],
    needs: { composer: ['php'] },
    markers: ['composer.json', 'composer.lock'],
    inline: [{ names: ['php'], flags: ['-r', '-R', '-B', '-E', '--run', '--process-code', '--process-begin', '--process-end'], shortPrefix: 'nq' }],
    parse: [{ names: ['php'], flags: ['-l', '--syntax-check'], file: true }],
    version: [
      { names: ['php'], flags: ['--version', '-v'] },
      { names: ['composer'], flags: ['--version', '-V'] },
    ],
    test: ['\\bphpunit\\b', '\\bpest\\b', '\\bcodecept\\b', '\\bparatest\\b', '\\bcomposer\\s+(?:run\\s+)?test\\b'],
    broad: ['php', 'composer'],
  },
  {
    id: 'go',
    label: 'Go',
    runtimes: ['go', 'gofmt'],
    managers: [],
    markers: ['go.mod', 'go.sum'],
    inline: [],
    parse: [],
    version: [{ names: ['go'], flags: ['version'] }],
    test: ['\\bgo\\s+test\\b'],
    broad: ['go'],
  },
  {
    id: 'rust',
    label: 'Rust',
    runtimes: ['cargo', 'rustc', 'rustup'],
    // cargo 与 rustc 同属 runtimes，但 cargo 自己就是 rustc 的前端：rustc 不在时 cargo 也跑不起来。
    needs: { cargo: ['rustc'] },
    managers: [],
    markers: ['Cargo.toml', 'Cargo.lock'],
    inline: [],
    parse: [],
    version: [{ names: ['cargo', 'rustc', 'rustup'], flags: ['--version', '-V'] }],
    test: ['\\bcargo\\s+test\\b'],
    broad: ['cargo', 'rustc'],
  },
  {
    id: 'java',
    label: 'Java',
    runtimes: ['java', 'javac', 'jshell'],
    managers: ['mvn', 'gradle', 'gradlew', 'mvnw'],
    needs: { mvn: ['java'], gradle: ['java'], gradlew: ['java'], mvnw: ['java'] },
    markers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
    inline: [],
    parse: [],
    version: [
      { names: ['java', 'javac'], flags: ['--version', '-version'] },
      { names: ['jshell'], flags: ['--version'] },
      // 项目提供的 mvnw / gradlew 包装脚本需要通过批准清单运行。
      { names: ['mvn', 'gradle'], flags: ['--version', '-v'] },
    ],
    test: ['\\bmvnw?\\b[^;&|]*\\btest\\b', '\\bgradlew?\\b[^;&|]*\\btest\\b'],
    broad: ['mvn', 'gradle', 'gradlew', 'mvnw', 'java', 'javac'],
  },
  {
    id: 'dotnet',
    label: '.NET',
    runtimes: ['dotnet'],
    managers: [],
    markers: ['*.csproj', '*.fsproj', '*.vbproj', '*.sln', 'global.json'],
    inline: [],
    parse: [],
    version: [{ names: ['dotnet'], flags: ['--version'] }],
    test: ['\\bdotnet\\s+test\\b'],
    broad: ['dotnet'],
  },
  {
    id: 'ruby',
    label: 'Ruby',
    runtimes: ['ruby', 'irb'],
    managers: ['bundle', 'bundler', 'gem', 'rake'],
    needs: { bundle: ['ruby'], bundler: ['ruby'], gem: ['ruby'], rake: ['ruby'] },
    markers: ['Gemfile', 'Gemfile.lock', '*.gemspec', 'Rakefile', '.rspec'],
    inline: [{ names: ['ruby', 'irb'], flags: ['-e'], shortPrefix: 'acdlnpsSvwW01234567' }],
    parse: [],
    // ruby -v 会继续处理脚本；仅保留明确退出的 --version。
    version: [
      { names: ['ruby', 'irb', 'gem'], flags: ['--version'] },
      { names: ['bundle', 'bundler'], flags: ['--version', '-v'] },
      { names: ['rake'], flags: ['--version', '-V'] },
    ],
    test: ['\\brspec\\b', '\\brake\\s+test\\b', '\\bbundle\\s+exec\\s+rspec\\b'],
    broad: ['ruby', 'bundle', 'bundler', 'rake'],
  },
  {
    id: 'elixir',
    label: 'Elixir',
    runtimes: ['elixir', 'iex', 'mix'],
    // mix 与 elixir 由同一个发行包安装，正常机器上不会只缺其一；这条关系仍写在这里，
    // 是因为它确实存在，且 elixir 不在时 mix 一定跑不起来。真正更深的 erlang/erl 没进登记表，不猜。
    needs: { mix: ['elixir'] },
    managers: [],
    markers: ['mix.exs', 'mix.lock'],
    inline: [{ names: ['elixir', 'iex'], flags: ['-e', '--eval'], shortPrefix: '' }],
    parse: [],
    version: [{ names: ['elixir', 'mix'], flags: ['--version', '-v'] }],
    test: ['\\bmix\\s+test\\b'],
    broad: ['elixir', 'mix'],
  },
  {
    id: 'perl',
    label: 'Perl',
    runtimes: ['perl'],
    managers: ['cpanm', 'carton', 'prove'],
    needs: { prove: ['perl'], cpanm: ['perl'], carton: ['perl'] },
    markers: ['Makefile.PL', 'cpanfile', 'META.json'],
    inline: [{ names: ['perl'], flags: ['-e', '-E'], shortPrefix: 'acdDfhilnpsStTuUvVwWX01234567' }],
    parse: [],
    version: [
      { names: ['perl'], flags: ['--version', '-v'] },
      { names: ['cpanm', 'carton', 'prove'], flags: ['--version'] },
    ],
    test: ['\\bprove\\b', '\\bmake\\s+test\\b'],
    broad: ['perl'],
  },
  {
    id: 'lua',
    label: 'Lua',
    runtimes: ['lua', 'luajit'],
    managers: ['luarocks'],
    needs: { luarocks: ['lua', 'luajit'] },
    markers: ['*.rockspec'],
    inline: [{ names: ['lua', 'luajit'], flags: ['-e'], shortPrefix: 'iv' }],
    parse: [],
    // lua -v 仍可能读取 stdin；复杂启动选项留给批准清单。
    version: [{ names: ['luarocks'], flags: ['--version'] }],
    test: ['\\bbusted\\b'],
    broad: ['lua', 'luajit'],
  },
  {
    id: 'shell',
    label: 'Shell',
    runtimes: ['bash', 'sh', 'zsh', 'dash'],
    managers: [],
    markers: [],
    inline: [{ names: ['bash', 'sh', 'zsh', 'dash'], flags: ['-c'], shortPrefix: 'abefhiklmnprstuvxBCEHPT' }],
    parse: [{ names: ['bash', 'sh', 'zsh', 'dash'], flags: ['-n'], file: true }],
    version: [{ names: ['bash', 'zsh'], flags: ['--version'] }],
    test: ['\\bbats\\b'],
    broad: ['bash', 'sh', 'zsh', 'dash'],
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    runtimes: ['pwsh', 'powershell'],
    managers: [],
    markers: ['*.ps1', '*.psm1', '*.psd1'],
    inline: [{ names: ['pwsh', 'powershell'], flags: ['-c', '-Command', '-EncodedCommand', '-ec', '-CommandWithArgs'], ignoreCase: true, abbreviate: true }],
    parse: [],
    version: [{ names: ['pwsh'], flags: ['--version', '-v'] }],
    test: ['\\bpester\\b'],
    broad: ['pwsh', 'powershell'],
  },
  {
    id: 'cmd',
    label: 'Windows 命令解释器',
    runtimes: ['cmd'],
    managers: [],
    markers: [],
    inline: [{ names: ['cmd'], flags: ['/c', '/k'], ignoreCase: true }],
    parse: [],
    version: [],
    test: [],
    broad: ['cmd'],
  },
  {
    id: 'make',
    label: 'Make / CMake',
    runtimes: ['make', 'gmake', 'cmake'],
    managers: [],
    markers: ['Makefile', 'makefile', 'GNUmakefile', 'CMakeLists.txt'],
    inline: [],
    parse: [],
    version: [{ names: ['make', 'gmake', 'cmake'], flags: ['--version'] }],
    test: ['\\bmake\\s+(?:test|check)\\b', '\\bctest\\b'],
    broad: ['make', 'gmake', 'cmake'],
  },
]

export const ECOSYSTEM_IDS = Object.freeze(ECOSYSTEMS.map((entry) => entry.id))

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** 名字 → 所属生态。一个名字可能同时属于多个生态（bun 既是运行时也是包管理器）。 */
const BY_NAME = new Map()
for (const entry of ECOSYSTEMS) {
  for (const name of [...entry.runtimes, ...entry.managers]) {
    const owners = BY_NAME.get(name) ?? []
    owners.push(entry)
    BY_NAME.set(name, owners)
  }
}

/**
 * 名字 → 它必须先有的可执行名。
 *
 * 体检只查第一层（`npm` 在不在）会漏掉最常见的一种：npm 本身是一个 node 程序，
 * node 不在 PATH 上时 npm 也跑不起来，但 `npm` 这个文件可能还躺在那里。
 * 依赖关系与 runtimes/managers 写在同一条目里，新增生态时一起改，不会漏。
 * 只登记能确定的关系：make 实际需要 gcc，但 gcc 不在表里，那就不写——宁可漏报也不猜。
 */
const NEEDS_BY_NAME = new Map()
for (const entry of ECOSYSTEMS) {
  for (const [name, deps] of Object.entries(entry.needs ?? {})) {
    const merged = NEEDS_BY_NAME.get(name) ?? []
    for (const dep of deps) if (!merged.includes(dep)) merged.push(dep)
    NEEDS_BY_NAME.set(name, merged)
  }
}

/** 这个可执行名必须先有谁才能跑；自包含或未登记的名字返回空数组（不猜）。 */
export function needsOf(token) {
  return [...(NEEDS_BY_NAME.get(executableName(token)) ?? [])]
}

const allNames = (key) => ECOSYSTEMS.flatMap((entry) => entry[key] ?? [])
const uniqueSorted = (values) => [...new Set(values)].sort((a, b) => b.length - a.length)
const alternation = (values) => uniqueSorted(values).map(escapeRegExp).join('|')

// 大小写展开写在 source 内：宿主会把 INLINE_EXEC.source 拼进另一个 /u 正则。
const casePattern = (value) => [...String(value)].map((char) => /[a-z]/iu.test(char)
  ? '[' + char.toLowerCase() + char.toUpperCase() + ']' : escapeRegExp(char)).join('')

// 仅一个位置文件，裸文件拒绝 glob/展开语法，避免展开后变成额外启动选项。
const PARSE_FILE = /(?:"(?![-+])[^"\r\n|;&`$<>]+"|'(?![-+])[^'\r\n|;&`$<>]+'|(?![-+\\])[^\s"'|;&`$<>*?\[\]{}()~]+)/u.source
const strictRule = (rule) => '(?:' + rule.names.map(casePattern).join('|') + ')' + /[ \t]+/u.source
  + '(?:' + alternation(rule.flags) + ')' + (rule.file ? /[ \t]+/u.source + PARSE_FILE : '')
const strictCommands = (patterns) => new RegExp('^(?:' + patterns.join('|') + ')' + /[ \t]*(?![\s\S])/u.source, 'u')

/** 版本探测逐条声明可执行名和参数，参数之后只能有水平空白。 */
export const READONLY_VERSION = strictCommands([
  ...ECOSYSTEMS.flatMap((entry) => entry.version ?? []).map(strictRule),
  /command[ \t]+-v[ \t]+[A-Za-z0-9_.:+-]+/u.source,
  /where[ \t]+[A-Za-z0-9_.:+-]+/u.source,
])

/**
 * 仅保留明确的单文件解析形式。启动选项、配置、缓存等复杂语义走批准清单。
 * perl/ruby 解析可能运行 BEGIN 块，tsc/deno 可能读隐式配置或写缓存，均不在此列。
 */
export const PARSE_ONLY = strictCommands(ECOSYSTEMS.flatMap((entry) => entry.parse ?? []).map(strictRule))

// shell 会去掉引号片段和反斜杠转义，识别参数时不能让这些拼接写法绕过。
const INLINE_QUOTES = /["'\\]*/u.source
const inlineSpelling = (value, ignoreCase = false) => [...String(value)]
  .map((char) => ignoreCase ? casePattern(char) : escapeRegExp(char)).join(INLINE_QUOTES)
const inlineFlags = (rule) => {
  const flags = rule.abbreviate
    ? rule.flags.flatMap((flag) => Array.from({ length: flag.length - 1 }, (_, index) => flag.slice(0, index + 2)))
    : rule.flags
  return uniqueSorted(flags).map((flag) => {
    if (/^-[A-Za-z]$/u.test(flag) && rule.shortPrefix !== undefined) {
      const prefix = rule.shortPrefix ? '(?:[' + rule.shortPrefix + ']' + INLINE_QUOTES + ')*' : ''
      return '-' + INLINE_QUOTES + prefix + inlineSpelling(flag.slice(1), rule.ignoreCase)
    }
    const boundary = flag.startsWith('/') ? '' : /(?=$|[ \t"'=])/u.source
    return inlineSpelling(flag, rule.ignoreCase) + boundary
  }).join('|')
}

/** 真正内联仍先于 scope 拒绝，每条规则只使用该解释器自己的标志。 */
export const INLINE_EXEC = new RegExp(ECOSYSTEMS.flatMap((entry) => entry.inline ?? []).map((rule) => {
  const names = rule.names.map((name) => inlineSpelling(name, true)).join('|')
  const extension = '(?:' + ['.exe', '.cmd', '.bat', '.com', '.ps1'].map((ext) => inlineSpelling(ext, true)).join('|') + ')?'
  return /(?:^|[ \t"'/\\|;&()])/u.source + '(?:' + names + ')' + extension + INLINE_QUOTES
    + /(?=[ \t])[^\r\n]*?[ \t]/u.source + INLINE_QUOTES + '(?:' + inlineFlags(rule) + ')'
}).join('|'), 'u')

/** 测试命令识别：体检用它判断「声明了 unit 验收却没有测试命令」。 */
export const TEST_COMMAND = new RegExp(
  '(?:^|[\\s;&|/])(?:' + ECOSYSTEMS.flatMap((entry) => entry.test ?? []).join('|') + ')',
  'i',
)

/** 超宽通配：一条 `npm *` 等于批准整类命令。 */
export const BROAD_COMMAND = new RegExp(
  '^(?:' + alternation([...allNames('runtimes'), ...allNames('managers')]) + ')\\s+\\*$|^\\*$',
  'i',
)

/** 登记表里的全部可执行名，用于「解释器身份归一化」。 */
export const EXECUTABLE_NAMES = Object.freeze(uniqueSorted([...allNames('runtimes'), ...allNames('managers')]))

const WINDOWS_EXT = /\.(?:exe|cmd|bat|com|ps1)$/iu

/** 去掉引号、目录与 Windows 扩展名，得到可比较的可执行名。 */
export function executableName(token) {
  const raw = String(token ?? '').trim().replace(/^["']|["']$/gu, '')
  if (!raw) return ''
  return raw.split(/[\\/]/u).pop().toLowerCase().replace(WINDOWS_EXT, '')
}

/** 这个可执行名是否登记过；没登记的名字不参与身份归一化，仍按原文精确匹配。 */
export function isRegisteredExecutable(token) {
  return BY_NAME.has(executableName(token))
}

/** 名字所属的生态 id 列表。 */
export function ecosystemsFor(token) {
  return (BY_NAME.get(executableName(token)) ?? []).map((entry) => entry.id)
}

/**
 * 解析一个可执行名到底存不存在。
 *
 * 这是方案 B 的核心：体检不能只问「这个 npm script 名存在吗」，
 * 还要问「这个可执行文件在这台机器上到底有没有」。原来的体检对后者零覆盖，
 * 于是 `node test/x.mjs` 一路通过 S1，到 S2 才被 shell 守卫按清单放行、
 * 再被 shell 自己以 127 拒绝——两次都发生在开发阶段，用户已经批准过 scope 了。
 *
 * 只读：existsSync 不执行任何东西。pathDirs 由调用方给（宿主进程的 PATH 就是
 * shell 子进程继承的那一份），platform 与 pathext 也由调用方给，便于测试注入。
 */
export function resolveExecutable(token, options = {}) {
  const raw = String(token ?? '').trim().replace(/^["']|["']$/gu, '')
  if (!raw) return { found: false, path: '', source: 'empty' }
  if (/[\\/]/u.test(raw)) {
    // 带目录的写法有两种：绝对路径直接查；`./gradlew`、`tools/node` 这类相对路径
    // 要相对仓库根解析——宿主进程的 cwd 不一定是仓库根，按 cwd 查会误报「找不到」。
    const absolute = isAbsolute(raw) ? raw : join(String(options.cwd ?? process.cwd()), raw)
    const source = isAbsolute(raw) ? 'absolute' : 'relative'
    return existsSync(absolute) ? { found: true, path: absolute, source } : { found: false, path: '', source }
  }
  const platform = options.platform ?? process.platform
  const pathDirs = Array.isArray(options.pathDirs) ? options.pathDirs : []
  const pathext = platform === 'win32'
    ? (Array.isArray(options.pathext) && options.pathext.length ? options.pathext : ['.COM', '.EXE', '.BAT', '.CMD'])
    : ['']
  const seen = new Set()
  const candidates = []
  const push = (value) => { if (!seen.has(value)) { seen.add(value); candidates.push(value) } }
  for (const dir of pathDirs) {
    if (!dir) continue
    push(join(dir, raw))
    if (platform === 'win32') for (const ext of pathext) push(join(dir, raw + String(ext).toLowerCase()))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { found: true, path: candidate, source: 'path' }
  }
  return { found: false, path: '', source: 'path' }
}

/** 该生态的标志文件是否出现在仓库里。markers 支持 `*.csproj` 这类扩展名通配。 */
export function ecosystemDeclared(id, present) {
  const entry = ECOSYSTEMS.find((item) => item.id === id)
  if (!entry) return false
  const files = present instanceof Set ? present : new Set(Array.isArray(present) ? present : [])
  return (entry.markers ?? []).some((marker) => {
    if (marker.startsWith('*.')) {
      const suffix = marker.slice(1).toLowerCase()
      return [...files].some((file) => String(file).toLowerCase().endsWith(suffix))
    }
    return files.has(marker)
  })
}

/** 给 projectProfile 用：一次算出「哪些生态是本项目在用的」。 */
export function declaredEcosystems(present) {
  return ECOSYSTEMS.filter((entry) => ecosystemDeclared(entry.id, present)).map((entry) => entry.id)
}

/** 生态的展示名，用于体检提示。 */
export function ecosystemLabel(id) {
  return ECOSYSTEMS.find((entry) => entry.id === id)?.label ?? id
}
