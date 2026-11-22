/**
 * 解释器与生态登记表：宿主判定 shell 命令时唯一的事实来源。
 *
 * 这里收口的是三份曾经各自为政的名单：
 *  - 只读白名单（`node --version`、`npm --version`）
 *  - 纯解析命令（`node --check`、`tsc --noEmit`）
 *  - 逃逸检查里的解释器内联执行名单
 *  - 验收体检里的测试命令识别与超宽命令判定
 *
 * 它们原本是四段写死的正则，加一个语言就要改四处，而且改漏一处不会有任何报错：
 * `php -r` 能执行任意代码，却因为 php 不在名单里而一路放行。所以收敛成一张表，
 * 新增生态只改这里一处，插件自己维护，不需要用户配置。
 *
 * 两条纪律：
 *  1. 登记表只描述「这是什么」，不描述「允不允许」。放行规则仍在 lib/index.js，
 *     体检规则仍在 lib/acceptance.js，两边都从这张表取名单，不再各自维护。
 *  2. 表里任何一项写错都只会收紧或放宽「识别」，不会放宽「写盘检查」：
 *     SHELL_ESCAPE_HINTS 的逃逸字符部分与这张表无关。
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { registerModuleRevision } from './revisions.js'

export const FLOWGATE_MODULE_REVISION = '8f4a2287431514654f783ed20633bb0ef49b1071cbdbdbba46fabb87c22b6624'
registerModuleRevision(import.meta.url, FLOWGATE_MODULE_REVISION)

/**
 * 解释器内联执行的标志并集。
 *
 * 用并集而不是按语言分别判定，是因为「这条命令能不能执行任意代码」只有两种答案：
 * 能，或者不能。按语言细分只会让漏登记的语言成为缺口——这正是 php 当初的状态。
 * `-c` 对 shell 与 python 是内联，`/c` 对 cmd 是内联，`-r` 对 php/perl 是内联。
 */
const INLINE_FLAGS = ['-e', '-E', '-c', '-r', '-R', '-p', '--eval', '--print', '/c', '/k', '-Command', '-EncodedCommand']

/**
 * 生态登记。
 *
 * 字段含义：
 *  - runtimes  该生态的解释器可执行名（可以不带扩展名）
 *  - managers  包管理器 / 构建入口，它们本身不内联执行，但能拉起任意脚本
 *  - markers   仓库里出现这些文件，说明该生态是「本项目真的在用」，体检才核对可执行文件
 *  - inline    该生态的内联执行标志；判定时与 INLINE_FLAGS 取并集
 *  - parse     纯解析（只读源码、不执行、不写盘）的子命令或标志
 *  - version   只读的版本探测参数
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
    inline: ['-e', '--eval', '-p', '--print'],
    parse: [['--check']],
    version: ['--version', '-v'],
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
    inline: ['-e', 'eval'],
    parse: [['check']],
    version: ['--version', '-V'],
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
    inline: ['-c'],
    parse: [],
    version: ['--version', '-V'],
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
    inline: ['-r', '-R'],
    parse: [['-l']],
    version: ['--version', '-v'],
    test: ['\\bphpunit\\b', '\\bpest\\b', '\\bcodecept\\b', '\\bparatest\\b', '\\bcomposer\\s+(?:run\\s+)?test\\b'],
    broad: ['php', 'composer'],
  },
  {
    id: 'go',
    label: 'Go',
    runtimes: ['go', 'gofmt'],
    managers: [],
    markers: ['go.mod', 'go.sum'],
    inlineCapable: false,
    inline: [],
    parse: [],
    version: ['version'],
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
    inlineCapable: false,
    inline: [],
    parse: [],
    version: ['--version', '-V'],
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
    inlineCapable: false,
    inline: [],
    parse: [],
    version: ['--version', '-version'],
    test: ['\\bmvnw?\\b[^;&|]*\\btest\\b', '\\bgradlew?\\b[^;&|]*\\btest\\b'],
    broad: ['mvn', 'gradle', 'gradlew', 'mvnw', 'java', 'javac'],
  },
  {
    id: 'dotnet',
    label: '.NET',
    runtimes: ['dotnet'],
    managers: [],
    markers: ['*.csproj', '*.fsproj', '*.vbproj', '*.sln', 'global.json'],
    inlineCapable: false,
    inline: [],
    parse: [],
    version: ['--version'],
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
    inline: ['-e'],
    parse: [],
    version: ['--version', '-v'],
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
    inline: ['-e'],
    parse: [],
    version: ['--version', '-v'],
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
    inline: ['-e', '-E'],
    parse: [],
    version: ['--version', '-v'],
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
    inline: ['-e'],
    parse: [],
    version: ['--version', '-v'],
    test: ['\\bbusted\\b'],
    broad: ['lua', 'luajit'],
  },
  {
    id: 'shell',
    label: 'Shell',
    runtimes: ['bash', 'sh', 'zsh', 'dash'],
    managers: [],
    markers: [],
    inline: ['-c'],
    parse: [['-n']],
    version: ['--version'],
    test: ['\\bbats\\b'],
    broad: ['bash', 'sh', 'zsh', 'dash'],
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    runtimes: ['pwsh', 'powershell'],
    managers: [],
    markers: ['*.ps1', '*.psm1', '*.psd1'],
    inline: ['-c', '-Command', '-EncodedCommand'],
    parse: [],
    version: ['--version'],
    test: ['\\bpester\\b'],
    broad: ['pwsh', 'powershell'],
  },
  {
    id: 'cmd',
    label: 'Windows 命令解释器',
    runtimes: ['cmd'],
    managers: [],
    markers: [],
    inline: ['/c', '/k'],
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
    inlineCapable: false,
    inline: [],
    parse: [],
    version: ['--version'],
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

/** 能直接内联执行源码的名字：只有解释器，包管理器靠子命令拉起脚本，走 scope 清单。 */
const INLINE_CAPABLE = new Set(ECOSYSTEMS
  .filter((entry) => entry.inlineCapable !== false)
  .flatMap((entry) => entry.runtimes)
  .concat(['npx']))

const allNames = (key) => ECOSYSTEMS.flatMap((entry) => entry[key] ?? [])
const uniqueSorted = (values) => [...new Set(values)].sort((a, b) => b.length - a.length)
const alternation = (values) => uniqueSorted(values).map(escapeRegExp).join('|')

/**
 * 只读版本探测：登记表里每个可执行名的版本参数。
 *
 * 这一条替代了原来写死的 `node --version` 与 `npm --version`：
 * 非 JS 项目在 S1 连 `php --version` 都跑不了，而版本探测是零风险的。
 */
export const READONLY_VERSION = new RegExp(
  '^(?:' + ECOSYSTEMS
    .filter((entry) => (entry.version ?? []).length > 0)
    .map((entry) => '(?:' + alternation([...entry.runtimes, ...entry.managers]) + ')[ \\t]+(?:'
      + (entry.version ?? []).map(escapeRegExp).join('|') + ')(?:[ \\t]+[^\\r\\n|;&`$<>]*)?')
    .join('|')
    + '|command[ \\t]+-v[ \\t]+[A-Za-z0-9_.:+-]+'
    + '|where[ \\t]+[A-Za-z0-9_.:+-]+'
    + ')$',
  'iu',
)

/**
 * 纯解析命令：只读源码，不执行、不写盘。
 *
 * `php -l` 与 `bash -n` 属于这一类：它们和 `node --check` 一样只做语法解析。
 * 注意不能把 `perl -c` / `ruby -c` 放进来：`-c` 同时是内联执行标志，
 * 逃逸检查先于这里执行，放进来也不会生效，反而让规则看起来自相矛盾。
 */
export const PARSE_ONLY = new RegExp(
  '^(?:' + ECOSYSTEMS
    .filter((entry) => (entry.parse ?? []).length > 0)
    .map((entry) => '(?:' + alternation([...entry.runtimes, ...entry.managers]) + ')[ \\t]+(?:'
      + (entry.parse ?? []).map((flags) => '(?:' + flags.map(escapeRegExp).join('|') + ')').join('|')
      + ')(?:[ \\t]+[^\\r\\n|;&`$<>]*)?')
    .join('|')
    + '|tsc[ \\t]+--noEmit(?:[ \\t]+[^\\r\\n|;&`$<>]*)?'
    + ')$',
  'u',
)

/**
 * 解释器内联执行：命中即视为任意代码执行，不看阶段、不看 scope 清单。
 *
 * 原来这份名单只有 16 个名字且不含 php，于是 `php -r 'unlink(...)'` 一路放行。
 * 现在名单与标志都从登记表派生，新增生态时不可能再漏掉这一处。
 */
const ALL_INLINE_FLAGS = [...new Set([...INLINE_FLAGS, ...ECOSYSTEMS.flatMap((entry) => entry.inline ?? [])])]

const INLINE_FLAG_PATTERN = ALL_INLINE_FLAGS
  .map((flag) => '(?:^|[\\s"\'=])' + escapeRegExp(flag) + '(?:$|[\\s"\'=])')
  .join('|')

export const INLINE_EXEC = new RegExp(
  '\\b(?:' + alternation([...INLINE_CAPABLE]) + ')\\b[^\\n]*(?:' + INLINE_FLAG_PATTERN + ')',
  'u',
)

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
