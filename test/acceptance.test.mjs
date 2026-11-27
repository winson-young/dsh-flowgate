import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCriteria, acceptanceLedger, grillReadiness, remediationList, scopeReadiness, stageSummary } from '../lib/acceptance.js'
import { BROAD_COMMAND, INLINE_EXEC, PARSE_ONLY, READONLY_VERSION, TEST_COMMAND, ecosystemsFor, needsOf, resolveExecutable } from '../lib/ecosystems.js'
import { join } from 'node:path'

const snapshot = { id: 'a'.repeat(64), complete: true }
const sourceLines = Array.from({ length: 40 }, (_, index) => `// line ${index + 1}`)
sourceLines[11] = 'export function render() { return ui }'
const runtime = { status: 'verified', hostRevision: 'host-v1', clientRevision: 'client-v1', pageId: 'page-1', viewport: { width: 1440, height: 900 }, cwd: 'D:/Projects/demo', scopeFiles: ['src/ui.js'], evidenceSources: [{ file: 'src/ui.js', lineCount: sourceLines.length, lines: sourceLines }] }
const unit = { id: 'AC-1', when: '提交有效请求', then: '返回成功结果', verification: { method: 'unit', procedure: '运行请求断言' } }
const layout = { id: 'AC-2', when: '打开桌面界面', then: '输入框与表格左右对齐，宽度相同' }
const visual = { id: 'AC-3', when: '打开界面', then: '按钮颜色符合设计', verification: { method: 'visual', procedure: '核对截图' } }
const flowOf = (criteria = [unit]) => ({ cwd: 'D:/Projects/demo', scope: { data: { acceptance_criteria: criteria, in_scope: { files_expected_to_change: ['src/ui.js'], commands: ['node test/ui.test.mjs'] } } } })
const evidence = (ac = 'AC-1', overrides = {}) => ({ ac, status: 'pass', method: 'unit', summary: '实际运行断言：1 项通过', citations: [{ file: 'src/ui.js', line: 12, anchor: 'export function render() {' }], command: 'node test/ui.test.mjs', exitCode: 0, version: snapshot.id, ...overrides })
const report = (acceptance, overrides = {}) => ({ snapshot: { ...snapshot }, acceptance, ...overrides })
const layoutEvidenceId = 'a0a0a0a0-1111-4111-8111-a0a0a0a0a0a0'
const measured = (overrides = {}) => evidence('AC-2', { evidenceId: layoutEvidenceId, method: 'visual', summary: '浏览器 getBoundingClientRect 实际测量', runtime: { hostRevision: runtime.hostRevision, clientRevision: runtime.clientRevision, pageId: runtime.pageId, viewport: { ...runtime.viewport } }, measurements: [{ element: 'input', reference: 'table', left: 24, right: 800, referenceLeft: 24, referenceRight: 800 }], ...overrides })
const receiptFor = (entry, overrides = {}) => ({ id: entry.evidenceId, version: entry.version, ...entry.runtime, measurements: structuredClone(entry.measurements), at: '2026-11-19T15:00:00.000Z', ...overrides })
// 模拟宿主采集回执；每次修改几何数据的试验都显式提供对应回执。
runtime.layoutEvidence = [receiptFor(measured())]
const statusOf = (flow, current = snapshot, live = runtime) => acceptanceLedger(flow, current, live).items[0].status

test('规范化兼容旧 scope，保留声明内容且默认明显布局要求为 visual', () => {
  const normalized = normalizeCriteria([layout, { id: '旧验收', when: '出现错误', then: '显示提示' }, unit])
  assert.equal(normalized[0].verification.method, 'visual')
  assert.equal(normalized[0].verification.tolerancePx, 1)
  assert.equal(normalized[0].when, layout.when)
  assert.equal(normalized[0].then, layout.then)
  assert.ok(normalized[0].verification.procedure)
  assert.equal(normalized[1].verification.method, 'manual')
  assert.deepEqual(normalized[2], unit)
  assert.deepEqual(normalizeCriteria(null), [])
  assert.equal(normalizeCriteria([{ ...layout, verification: { tolerancePx: -1 } }])[0].verification.tolerancePx, 1)
  assert.equal(normalizeCriteria([{ ...layout, verification: { method: 'visual', tolerancePx: 0 } }])[0].verification.tolerancePx, 0)
})

test('冻结前的验收方案体检：没写 verification.commands 是硬阻塞，不是风险', () => {
  const criteria = [
    { id: 'AC-1', when: '跨模块调用', then: '夹具联动成功', verification: { method: 'integration', procedure: '运行集成用例' } },
  ]
  const readiness = scopeReadiness(criteria, [], ['src/auth/session.ts'])
  assert.deepEqual(readiness.blockers.map((item) => item.code), ['ac-without-command'])
  assert.deepEqual(readiness.blockers[0].acs, ['AC-1'])
  assert.match(readiness.blockers[0].message, /没写 verification\.commands/)
})

test('写了命令但清单里没有测试命令、也没有测试文件时给出缺口，不拦截', () => {
  const criteria = [
    { id: 'AC-1', when: '跨模块调用', then: '夹具联动成功', verification: { method: 'integration', procedure: '运行集成用例', commands: ['node scripts/build.mjs'] } },
  ]
  const readiness = scopeReadiness(criteria, ['node scripts/build.mjs'], ['src/auth/session.ts'])
  assert.deepEqual(readiness.blockers, [])
  assert.deepEqual(readiness.risks.map((item) => item.code), ['no-test-command', 'integration-without-test-file'])
  assert.deepEqual(readiness.risks[0].acs, ['AC-1'])
  assert.match(readiness.risks[0].message, /声明了可执行验证（集成测试）/)
  assert.match(readiness.risks[0].message, /现有 1 条都不是测试命令/)
  assert.match(readiness.risks[1].message, /没有任何测试文件/)
  assert.match(readiness.risks[1].message, /S3 评审会要求回 S1 调 scope/)
})

test('清单写对了但机器上没有这个可执行体时给出缺口，仓库没声明该生态就不误报', () => {
  const criteria = [{ id: 'AC-1', when: '跑测试', then: '全部通过', verification: { method: 'unit', procedure: '运行用例', commands: ['node test/host.test.mjs'] } }]
  const project = (ecosystems, found) => ({
    ecosystems,
    resolveExecutable: (token) => ({ found: found.includes(token), path: found.includes(token) ? '/usr/bin/' + token : null, source: 'path' }),
  })
  const missing = scopeReadiness(criteria, ['node test/host.test.mjs', 'php -l index.php'], ['test/host.test.mjs'], {
    project: project(['node'], []),
  })
  assert.deepEqual(missing.risks.map((item) => item.code), ['command-runtime-missing'])
  assert.deepEqual(missing.risks[0].commands, ['node test/host.test.mjs'])
  assert.match(missing.risks[0].message, /找不到/)
  assert.match(missing.risks[0].message, /绝对路径/)
  // php 没在仓库里声明：空目录里写 php 命令无从判断，跳过比误报有用。
  assert.ok(!missing.risks[0].commands.includes('php -l index.php'))
  // 找得到就不报；绝对路径与登记名同样按可执行体核对。
  const found = scopeReadiness(criteria, ['node test/host.test.mjs'], ['test/host.test.mjs'], {
    project: project(['node'], ['node']),
  })
  assert.deepEqual(found.risks.map((item) => item.code), ['no-test-command'].filter(() => false))
  // 没有 project 时整条检查不参与：老调用点与未知工作区不受影响。
  assert.deepEqual(scopeReadiness(criteria, ['node test/x.mjs'], ['test/x.mjs']).risks, [])
})

test('每个生态都登记了「它靠谁才能跑」：包管理器指向解释器，自包含的留空', () => {
  for (const [name, deps] of [
    ['npm', ['node']], ['pnpm', ['node']], ['yarn', ['node']], ['npx', ['node']], ['corepack', ['node']],
    ['composer', ['php']],
    ['pip', ['python', 'python3', 'py']], ['poetry', ['python', 'python3', 'py']], ['uv', ['python', 'python3', 'py']],
    ['bundle', ['ruby']], ['gem', ['ruby']],
    ['mvn', ['java']], ['gradlew', ['java']],
    ['prove', ['perl']],
    ['luarocks', ['lua', 'luajit']],
    ['cargo', ['rustc']],
    ['mix', ['elixir']],
  ]) {
    assert.deepEqual(needsOf(name), deps, name)
  }
  // 自包含的生态留空：解释器就是那个工具本身，没有额外一层可查。
  for (const name of ['go', 'dotnet', 'deno', 'bash', 'pwsh', 'cmd', 'make']) {
    assert.deepEqual(needsOf(name), [], name)
  }
  // 名字先归一化再查表：带目录、带 Windows 扩展名的写法认得出同一条。
  assert.deepEqual(needsOf('C:/tools/npm.cmd'), ['node'])
  assert.deepEqual(needsOf('C:\\tools\\npm.cmd'), ['node'])
  assert.deepEqual(needsOf('"npm"'), ['node'])
  // 没登记的名字不猜。
  assert.deepEqual(needsOf('some-unknown-tool'), [])
})

test('免授权解析只接受明确的单文件形式，不接纳启动选项或隐式配置', () => {
  for (const command of [
    'node --check file.js', 'nodejs -c file.js', 'php -l index.php', 'php --syntax-check index.php',
    'bash -n script.sh', 'sh -n script.sh', 'zsh -n script.sh', 'dash -n script.sh',
    'node --check "目录/文件 名.js"', "node --check '目录/文件 名.js'",
    'node --check C:/repo/file.js', 'node --check C:\\repo\\file.js',
  ]) assert.equal(PARSE_ONLY.test(command), true, command)
  for (const command of [
    '', 'node --check', 'node --check a.js b.js', 'node --check --require',
    'node --require ./hook.cjs --check file.js', 'node --check file.js --require ./hook.cjs',
    'node --import ./hook.mjs --check file.js', 'node --check file.js --import ./hook.mjs',
    'node --loader ./hook.mjs --check file.js', 'node --check file.js --loader ./hook.mjs',
    'node --check "file.js" --require ./hook.cjs', 'node --check *', 'node --check [ab].js', 'node --check \\--require=./hook.cjs',
    'node --check file.js\n', 'node --check file.js\r\n', 'node --check ""',
    'node --check "--require"', 'node --check "file.js\n--require hook.cjs"',
    'bash +n script.sh', 'bash -n script.sh +n', 'bash -n script.sh -c echo',
    'bash -c echo -n script.sh', 'bash -nc echo', 'php -l index.php -r echo',
    'php -r echo -l index.php', 'php -l --run=echo', 'perl -c script.pl', 'ruby -c script.rb',
    'tsc --noEmit', 'tsc --noEmit file.ts', 'deno check file.ts',
  ]) assert.equal(PARSE_ONLY.test(command), false, command)
})

test('版本规则逐条退出且不继承任意尾参或其他生态的选项', () => {
  for (const command of [
    'node --version', 'npm --version', 'node -v', 'npm -v', 'nodejs --version',
    'python -V', 'py --version', 'pip --version', 'php -v', 'composer -V',
    'go version', 'cargo -V', 'java -version', 'javac --version', 'dotnet --version',
    'mvn --version', 'gradle -v',
    'ruby --version', 'bundle -v', 'perl -v', 'luarocks --version', 'bash --version',
    'pwsh --version', 'make --version', 'command -v node', 'where node', 'npm --version\t',
  ]) assert.equal(READONLY_VERSION.test(command), true, command)
  for (const command of [
    '', 'node --version file.js', 'npm --version --require hook.cjs', 'python -v',
    'pip -V', 'gofmt version', 'go --version', 'ruby -v', 'lua -v', 'cmd --version',
    'sh --version', 'node --version\n', 'node --version\r\n', 'where node npm',
    'mvnw --version', 'mvnw -v', 'gradlew --version', 'gradlew -v', './gradlew --version',
    'node --version'.padEnd(1024, ' ') + '--require hook.cjs',
  ]) assert.equal(READONLY_VERSION.test(command), false, command)
})

test('内联执行按解释器标志区分大小写并识别相邻、组合、引号及路径写法', () => {
  const embedded = new RegExp(INLINE_EXEC.source, 'u')
  for (const command of [
    'node -e1', 'node -pe1', 'node --eval=1', 'node --print 1', 'nodejs -p1', 'bun -e1',
    'npx -c echo', 'python -c1', 'python3 -Ic1', 'py -Ec1', 'perl -E1', 'perl -we1',
    'ruby -ne1', 'ruby -W2e1', 'ruby -0777ne1', 'perl -0777ne1', 'perl -l0777e1', 'php -nr1', 'php --run=1', 'php -R1', 'php -E1', 'php -nE1', 'php -E "echo 1;"', 'php --process-end=1', 'elixir -e 1', 'iex --eval 1',
    'lua -e1', 'luajit -e1', 'deno eval 1', 'bash -xc echo', 'sh -c echo',
    'pwsh -COMMAND echo', 'powershell -enc QQ==', 'pwsh -CommandWithArgs echo', 'cmd /Cecho',
    'NODE.EXE -e1', 'C:/工具/node.exe -e1', 'C:\\工具\\python.exe -c1',
    '"C:/Program Files/node.exe" -e1', "'/usr/bin/perl' -E1",
    'n"od"e -"e"1', '"node" "-e"1', 'node --require hook.cjs -e1',
    'node --version -e1', 'php -l index.php -r1', 'node \\-e1', 'n\\ode -\\e1',
  ]) {
    assert.equal(INLINE_EXEC.test(command), true, command)
    assert.equal(embedded.test(command), true, '嵌入 source：' + command)
  }
  for (const command of [
    '', 'python -E', 'python -E script.py', 'python -e1', 'node -E1', 'node --Eval=1',
    'node --check file.js', 'node -c file.js', 'php -l index.php', 'php -e index.php', 'php -F script.php', 'php -nFscript.php', 'php --process-file script.php',
    'perl -c file.pl', 'ruby -c file.rb', 'bash -n script.sh', 'bash +n script.sh',
    'npm -e1', 'pip -c1', 'go -e1', 'mix -e1', 'cmd -c echo', 'deno --eval 1',
    'notnode -e1', 'node-helper -e1', 'node --evaluation=1',
  ]) {
    assert.equal(INLINE_EXEC.test(command), false, command)
    assert.equal(embedded.test(command), false, '嵌入 source：' + command)
  }
})

test('严格执行规则不收紧体检的测试、宽泛命令和生态依赖识别', () => {
  for (const command of ['npm run test -- --coverage', 'NODE --test test/x.mjs', 'python -m pytest -q', 'deno test --allow-all', 'composer run test']) {
    assert.equal(TEST_COMMAND.test(command), true, command)
  }
  for (const command of ['npm *', 'PYTHON *', 'php *', 'deno *', '*']) {
    assert.equal(BROAD_COMMAND.test(command), true, command)
  }
  // 清单条目可以带执行目录（`node * [.]`）：只给超宽命令加一个方括号后缀就能把它洗成
  // 「看起来限定在某目录」的合规条目，所以超宽判定必须穿透后缀看命令本身。
  for (const command of ['npm * [.]', 'node * [packages/web]', '* [packages/web]', 'PYTHON * [ a/b ]']) {
    assert.equal(BROAD_COMMAND.test(command), true, command)
  }
  // 具体命令带后缀不算超宽：后缀不是命令的一部分。
  for (const command of ['npm run * [packages/web]', 'node test/host.test.mjs [.]']) {
    assert.equal(BROAD_COMMAND.test(command), false, command)
  }
  for (const [token, ids] of [
    ['"C:/工具/NODE.EXE"', ['node']], ['C:\\tools\\python3.exe', ['python']],
    ['"./gradlew.bat"', ['java']], ['bun', ['node']], ['some-unknown-tool', []],
  ]) assert.deepEqual(ecosystemsFor(token), ids, token)
  assert.deepEqual(needsOf('"C:/工具/NPM.CMD"'), ['node'])
  assert.deepEqual(needsOf('C:\\tools\\pip3.exe'), ['python', 'python3', 'py'])
  const readiness = scopeReadiness([{ ...unit, verification: { ...unit.verification, commands: ['python -E -m pytest -q'] } }], ['python -E -m pytest -q', 'deno test --allow-all'], ['test/example.test.js'])
  assert.ok(!readiness.risks.some((risk) => risk.code === 'no-test-command'))
})

test('带目录的写法相对仓库根解析：宿主进程 cwd 不是仓库根时也不误报', () => {
  const root = process.cwd()
  // 相对路径按调用方给的 cwd 解析，而不是按宿主进程的 cwd。
  const here = resolveExecutable('./package.json', { cwd: root })
  assert.equal(here.found, true)
  assert.equal(here.source, 'relative')
  assert.equal(here.path, join(root, 'package.json'))
  // 换个 cwd 就找不到：证明用的是传入的 cwd，不是 process.cwd()。
  assert.equal(resolveExecutable('./package.json', { cwd: join(root, 'lib') }).found, false)
  // 绝对路径直接查，不走 cwd。
  const absolute = resolveExecutable(process.execPath, { cwd: join(root, 'lib') })
  assert.equal(absolute.found, true)
  assert.equal(absolute.source, 'absolute')
  // 空 token 不猜。
  assert.equal(resolveExecutable('   ').source, 'empty')
})

test('工具在、它依赖的解释器不在时照样报缺口，并点名缺的是哪一层', () => {
  const criteria = [{ id: 'AC-1', when: '跑测试', then: '全部通过', verification: { method: 'unit', procedure: '运行用例', commands: ['npm test'] } }]
  const project = (ecosystems, found) => ({
    ecosystems,
    resolveExecutable: (token) => ({ found: found.includes(token), path: found.includes(token) ? '/usr/bin/' + token : null, source: 'path' }),
  })
  // npm 本身是 node 程序：npm 在、node 不在，命令到 S2 照样 127。
  const viaTool = scopeReadiness(criteria, ['npm test'], [], { project: project(['node'], ['npm']) })
  assert.deepEqual(viaTool.risks.map((item) => item.code), ['command-runtime-missing'])
  assert.deepEqual(viaTool.risks[0].commands, ['npm test'])
  assert.match(viaTool.risks[0].message, /npm 在，但它需要的 node 不在/)
  // 依赖也在就不报。
  const both = scopeReadiness(criteria, ['npm test'], [], { project: project(['node'], ['npm', 'node']) })
  assert.ok(!both.risks.some((item) => item.code === 'command-runtime-missing'))
  // 候选写法任一存在即算通过：python / python3 的命名差异不该判成缺。
  const candidate = scopeReadiness(criteria, ['uv sync'], [], { project: project(['python'], ['uv', 'python3']) })
  assert.ok(!candidate.risks.some((item) => item.code === 'command-runtime-missing'))
  const candidateGone = scopeReadiness(criteria, ['uv sync'], [], { project: project(['python'], ['uv']) })
  // uv sync 不是测试命令，会先多出一条 no-test-command：按 code 取，不赌顺序。
  const candidateRisk = candidateGone.risks.find((item) => item.code === 'command-runtime-missing')
  assert.ok(candidateRisk, JSON.stringify(candidateGone.risks))
  assert.match(candidateRisk.message, /uv 在，但它需要的 python 或 python3 或 py 不在/)
  // 首 token 也不在时第一层就收下，不再顺依赖查第二层：缺口只出一条，命令不重复记。
  const headGone = scopeReadiness(criteria, ['npm test', 'npm run build'], [], { project: project(['node'], []) })
  assert.equal(headGone.risks.filter((item) => item.code === 'command-runtime-missing').length, 1)
  assert.deepEqual(headGone.risks[0].commands, ['npm test', 'npm run build'])
  assert.match(headGone.risks[0].message, /命令本身找不到/)
  // 仓库没声明这个生态：跳过比误报有用。
  const skipped = scopeReadiness(criteria, ['composer install'], [], { project: project(['node'], ['composer']) })
  assert.ok(!skipped.risks.some((item) => item.code === 'command-runtime-missing'))
})

test('验证步骤点名 scope 外的文件时给出缺口，点名的文件已在 scope 内就不再提示', () => {
  const criteria = [{
    id: 'AC-1',
    when: '跨模块联动',
    then: '夹具一起跑通',
    verification: { method: 'integration', procedure: '先改 test/fixtures/session.ts，再运行 test/integration.test.mjs', commands: ['npm test'] },
  }]
  const outside = scopeReadiness(criteria, ['npm test'], ['test/integration.test.mjs'])
  const risk = outside.risks.find((item) => item.code === 'procedure-file-outside-scope')
  assert.ok(risk, JSON.stringify(outside.risks))
  assert.deepEqual(risk.acs, ['AC-1'])
  assert.match(risk.message, /test\/fixtures\/session\.ts/)
  assert.doesNotMatch(risk.message, /test\/integration\.test\.mjs/)
  // 目录级覆盖也算：scope 列了 test/ 就把下面的文件都算在内。
  const covered = scopeReadiness(criteria, ['npm test'], ['test/integration.test.mjs', 'test/'])
  assert.deepEqual(covered.risks.map((item) => item.code), [])
  // 人工核验不需要动文件，不该被这条规则误伤。
  const manual = [{ id: 'AC-2', when: '看界面', then: '观感正常', verification: { method: 'manual', procedure: '人工核对 src/a.ts 的文案' } }]
  assert.deepEqual(scopeReadiness(manual, [], []).risks.map((item) => item.code), [])
})

test('清单里已经有测试文件时不再报「没有测试文件」', () => {
  const criteria = [{ id: 'AC-1', when: '跨模块调用', then: '夹具联动成功', verification: { method: 'integration', procedure: '运行集成用例', commands: ['npm test'] } }]
  const readiness = scopeReadiness(criteria, ['npm test'], ['test/host.test.mjs'])
  assert.deepEqual(readiness.risks, [])
})

test('补全命令与测试文件后体检无缺口', () => {
  const criteria = [
    { id: 'AC-1', when: '跨模块调用', then: '夹具联动成功', verification: { method: 'integration', procedure: '运行集成用例', commands: ['npm test'] } },
    { id: 'AC-2', when: '提交请求', then: '返回成功', verification: { method: 'unit', procedure: '跑单测', commands: ['npm test'] } },
  ]
  const readiness = scopeReadiness(criteria, ['npm test'], ['test/integration.test.mjs'])
  assert.deepEqual(readiness.blockers, [])
  assert.deepEqual(readiness.risks, [])
  assert.deepEqual(readiness.testCommands, ['npm test'])
  assert.deepEqual(readiness.testFiles, ['test/integration.test.mjs'])
})

test('视觉验收没写测量方式时给出缺口，写了就不再提示', () => {
  const vague = [{ id: 'AC-1', when: '打开界面', then: '按钮居中', verification: { method: 'visual', procedure: '看一下' } }]
  assert.deepEqual(scopeReadiness(vague, [], []).risks.map((item) => item.code), ['visual-without-measurement'])
  const measured = [{ id: 'AC-1', when: '打开界面', then: '按钮居中', verification: { method: 'visual', procedure: '用 getBoundingClientRect 量左右边界，容差 1px' } }]
  assert.deepEqual(scopeReadiness(measured, [], []).risks, [])
})

test('追问体检：未决问题没问完、决策缺半边、什么都没澄清都直接拒绝提交', () => {
  const agreed = grillReadiness(
    [{ question: '追问纪律落在哪一层？', answer: '工具参数加提交校验，不只写在提示词里' }],
    ['不新增依赖'],
    [],
  )
  assert.deepEqual(agreed.blockers, [])
  assert.equal(agreed.decisions[0].question, '追问纪律落在哪一层？')
  assert.deepEqual(agreed.assumptions, ['不新增依赖'])

  const pending = grillReadiness([{ question: '问什么', answer: '定什么' }], [], ['失败后要不要自动重试'])
  assert.deepEqual(pending.blockers.map((item) => item.code), ['open-questions-remain'])
  assert.match(pending.blockers[0].message, /失败后要不要自动重试/)
  assert.match(pending.blockers[0].message, /需求文档不是记录待定的地方/)

  const half = grillReadiness([{ question: '只问了问题' }, { answer: '只写了结论' }], [], [])
  assert.deepEqual(half.blockers.map((item) => item.code), ['incomplete-decision'])
  assert.match(half.blockers[0].message, /缺 question 或 answer/)

  assert.deepEqual(grillReadiness([], [], []).blockers.map((item) => item.code), ['nothing-clarified'])
  // 只写假设、一条决策都没有也算澄清过：确实无需追问时允许这么提交。
  assert.deepEqual(grillReadiness([], ['沿用现有门禁语义'], []).blockers, [])
  // 空白条目不算数，别让空字符串把 open_questions 骗成已问清。
  assert.deepEqual(grillReadiness([{ question: '问', answer: '答' }], [], ['  ']).blockers, [])
})

test('id 缺失或重复是硬阻塞，不是风险', () => {
  const readiness = scopeReadiness([
    { when: '没有 id', then: '无法关联证据', verification: { method: 'unit', procedure: '跑单测', commands: ['npm test'] } },
    { id: 'AC-1', when: 'a', then: 'b', verification: { method: 'unit', procedure: '跑单测', commands: ['npm test'] } },
    { id: 'AC-1', when: 'c', then: 'd', verification: { method: 'unit', procedure: '跑单测', commands: ['npm test'] } },
  ], ['npm test'], ['test/a.test.mjs'])
  assert.deepEqual(readiness.blockers.map((item) => item.code), ['missing-id', 'duplicate-id'])
  assert.match(readiness.blockers[0].message, /没有 id/)
  assert.match(readiness.blockers[1].message, /AC-1（2 条）/)
})

test('提交测试之前为 pending，旧测试总数和方向通过不转为 AC 通过', () => {
  const flow = flowOf()
  assert.equal(statusOf(flow), 'pending')
  flow.test = { failed: 0, directions: [{ id: 'functional', points: [{ result: 'pass' }] }] }
  assert.equal(statusOf(flow), 'uncovered')
  assert.deepEqual(acceptanceLedger(flow, snapshot).counts, { total: 1, pending: 0, pass: 0, fail: 0, uncovered: 1, excluded: 0 })
})

test('只有当前版本的 test 证据可以证明通过，review pass 不算执行', () => {
  const flow = flowOf()
  flow.review = report([evidence()])
  assert.equal(statusOf(flow), 'pending')
  flow.test = report([evidence()])
  assert.equal(statusOf(flow), 'pass')
  assert.equal(acceptanceLedger(flow, snapshot).items[0].version, snapshot.id)
})

test('代码变化使旧报告证据失效，同路径同测试总数不能续用', () => {
  const flow = flowOf()
  flow.test = report([evidence()])
  const changed = { id: 'b'.repeat(64), complete: true }
  assert.equal(statusOf(flow, changed), 'uncovered')
  flow.test.snapshot = { ...changed }
  assert.equal(statusOf(flow, changed), 'uncovered')
  flow.test.acceptance[0].version = changed.id
  assert.equal(statusOf(flow, changed), 'pass')
})

test('报告和当前快照必须都有同 ID 且明确完整', () => {
  for (const invalid of [undefined, {}, { id: snapshot.id }, { id: snapshot.id, complete: false }, { id: 'other', complete: true }]) {
    const flow = flowOf()
    flow.test = report([evidence()], { snapshot: invalid })
    assert.equal(statusOf(flow), 'uncovered')
  }
  const flow = flowOf()
  flow.test = report([evidence()])
  for (const invalid of [undefined, {}, { id: snapshot.id }, { id: snapshot.id, complete: false }, { id: '', complete: true }]) {
    assert.equal(statusOf(flow, invalid ?? {}), 'uncovered')
  }
})

test('证据必须包含可核对的引用、授权命令、匹配方法与当前版本', () => {
  const bad = [
    { citations: [] },
    { citations: [{ file: 'src/ui.js', line: 12, anchor: '' }] },
    { citations: [{ file: 'src/ui.js', line: 12, anchor: '不存在的断言文本' }] },
    { citations: [{ file: 'src/ui.js', line: 999, anchor: 'export function' }] },
    { citations: [{ file: 'src/absent.js', line: 1, anchor: 'x' }] },
    { citations: [{ file: 'src/other.js', line: 1, anchor: 'x' }] },
    { command: '' },
    { command: 'node run-everything.mjs' },
    { exitCode: 1 },
    { method: 'manual' },
    { version: 'old' }, { version: undefined }, { status: 'completed' },
  ]
  for (const override of bad) {
    const flow = flowOf()
    flow.test = report([evidence('AC-1', override)])
    assert.equal(statusOf(flow), 'uncovered')
  }
})

test('无效 ID、重复 scope ID、未知 AC、重复或冲突证据均不能误通过', () => {
  for (const id of ['', ' ', 'AC 1', 12, null]) {
    const flow = flowOf([{ ...unit, id }])
    flow.test = report([evidence(id)])
    assert.equal(statusOf(flow), 'uncovered')
  }
  const flow = flowOf([unit, { ...unit }])
  flow.test = report([evidence()])
  assert.equal(acceptanceLedger(flow, snapshot).counts.pass, 0)
  assert.equal(acceptanceLedger(flow, snapshot).counts.uncovered, 2)
  flow.scope.data.acceptance_criteria = [unit]
  flow.test = report([evidence('unknown')])
  assert.equal(statusOf(flow), 'uncovered')
  flow.test = report([evidence(), evidence()])
  assert.equal(statusOf(flow), 'uncovered')
  flow.test = report([evidence(), evidence('AC-1', { status: 'fail', summary: '实际断言失败' })])
  assert.equal(statusOf(flow), 'fail')
  flow.test = report([evidence(), evidence('AC-1', { status: 'uncovered' })])
  assert.equal(statusOf(flow), 'uncovered')
})

test('有效当前 test pass 关闭 review uncovered，review fail 仍优先', () => {
  const flow = flowOf()
  flow.review = report([evidence('AC-1', { status: 'uncovered' })])
  assert.equal(statusOf(flow), 'uncovered')
  flow.test = report([evidence('AC-1', { version: 'old' })])
  assert.equal(statusOf(flow), 'uncovered')
  flow.test = report([evidence()])
  assert.equal(statusOf(flow), 'pass')
  flow.review.acceptance.push(evidence('AC-1', { status: 'uncovered' }))
  assert.equal(statusOf(flow), 'pass', '重复的旧缺口也由实际执行证据关闭')
  flow.review = report([evidence('AC-1', { status: 'fail' })])
  assert.equal(statusOf(flow), 'fail')
  flow.review = report([evidence('AC-1', { status: 'fail', version: 'old' })], { snapshot: { id: 'old', complete: true } })
  assert.equal(statusOf(flow), 'pass')
})

test('布局 AC 误标 unit、integration 或 manual 也不能用 CSS 断言绕过视觉实测', () => {
  for (const method of ['unit', 'integration', 'manual']) {
    const criterion = { ...layout, verification: { method, procedure: '断言 CSS width:100%' } }
    assert.equal(normalizeCriteria([criterion])[0].verification.method, 'visual')
    const flow = flowOf([criterion])
    flow.test = report([evidence('AC-2', { method, summary: 'CSS width:100% 断言通过' })])
    assert.equal(statusOf(flow), 'uncovered')
    flow.test = report([measured({ measurements: undefined })])
    assert.equal(statusOf(flow), 'uncovered')
    flow.test = report([measured()])
    assert.equal(statusOf(flow), 'pass')
  }
})

test('CSS 字符串或截图不能证明对齐，必须包含实际几何测量', () => {
  const flow = flowOf([layout])
  flow.test = report([measured({ measurements: undefined, summary: 'width:100%; margin-left:0', artifact: 'screenshot.png' })])
  const item = acceptanceLedger(flow, snapshot, runtime).items[0]
  assert.equal(item.status, 'uncovered')
  assert.match(item.reason, /实际边界测量/)
})

test('完整当前版本实际测量可通过，左右两边分别比较并支持声明容差', () => {
  const flow = flowOf([layout])
  flow.test = report([measured()])
  assert.equal(statusOf(flow), 'pass')
  flow.test.acceptance[0].measurements[0].left = 25
  flow.test.acceptance[0].measurements[0].right = 799
  const live = { ...runtime, layoutEvidence: [receiptFor(flow.test.acceptance[0])] }
  assert.equal(statusOf(flow, snapshot, live), 'pass')
  flow.scope.data.acceptance_criteria[0] = { ...layout, verification: { method: 'visual', tolerancePx: 0 } }
  assert.equal(statusOf(flow, snapshot, live), 'fail')
  flow.scope.data.acceptance_criteria[0].verification.tolerancePx = 2
  assert.equal(statusOf(flow, snapshot, live), 'pass')
})

test('视觉测量任一左右边超差即 fail，相同宽度但整体错位不能通过', () => {
  for (const override of [{ left: 26 }, { right: 802 }, { left: 27, right: 803 }]) {
    const flow = flowOf([layout])
    const entry = measured()
    Object.assign(entry.measurements[0], override)
    flow.test = report([entry])
    const live = { ...runtime, layoutEvidence: [receiptFor(entry)] }
    assert.equal(statusOf(flow, snapshot, live), 'fail')
  }
})

test('视觉测量必须有限、矩形有效且具名，所有测量均需有效', () => {
  for (const override of [{ left: NaN }, { right: Infinity }, { referenceLeft: '24' }, { referenceRight: null }, { right: 24 }, { right: 23 }, { referenceRight: 24 }, { element: '' }, { reference: ' ' }]) {
    const flow = flowOf([layout])
    const entry = measured()
    entry.measurements.push({ ...entry.measurements[0], ...override })
    flow.test = report([entry])
    assert.equal(statusOf(flow), 'uncovered')
  }
})

test('视觉证据要求 verified 运行态、宿主客户端版本吻合及有效视口', () => {
  const flow = flowOf([layout])
  flow.test = report([measured()])
  for (const live of [{}, { ...runtime, status: 'pending' }, { ...runtime, hostRevision: 'host-v2' }, { ...runtime, clientRevision: 'client-v2' }, { ...runtime, hostRevision: '' }]) {
    assert.equal(statusOf(flow, snapshot, live), 'uncovered')
  }
  for (const viewport of [undefined, {}, { width: 0, height: 900 }, { width: '1440', height: 900 }, { width: 1440, height: Infinity }, { width: 1440, height: -1 }]) {
    flow.test = report([measured()])
    flow.test.acceptance[0].runtime.viewport = viewport
    assert.equal(statusOf(flow), 'uncovered')
  }
  flow.test = report([measured()])
  assert.equal(statusOf(flow, snapshot, { ...runtime, viewport: { width: 800, height: 600 } }), 'uncovered')
})

test('视觉通过要求相同非空页面标识，不能以其它页面的测量通过', () => {
  const flow = flowOf([layout])
  flow.test = report([measured()])
  assert.equal(statusOf(flow), 'pass')
  for (const pageId of [undefined, '', ' ', 'another-page']) {
    assert.equal(statusOf(flow, snapshot, { ...runtime, pageId }), 'uncovered')
    flow.test = report([measured()])
    flow.test.acceptance[0].runtime.pageId = pageId
    assert.equal(statusOf(flow), 'uncovered')
    flow.test = report([measured()])
  }
})

test('缺少或无效运行态视口时，即使证据视口有效也不能通过', () => {
  const flow = flowOf([layout])
  flow.test = report([measured()])
  for (const viewport of [undefined, null, {}, { width: 0, height: 900 }, { width: '1440', height: 900 }, { width: 1440, height: Infinity }, { width: 1440, height: -1 }]) {
    assert.equal(statusOf(flow, snapshot, { ...runtime, viewport }), 'uncovered')
  }
  assert.equal(statusOf(flow), 'pass')
})

test('布局通过必须引用当前宿主采集回执，缺失、错页、旧版本或篡改均未覆盖', () => {
  const flow = flowOf([layout])
  const entry = measured()
  flow.test = report([entry])
  assert.equal(statusOf(flow), 'pass')
  for (const layoutEvidence of [undefined, [], [{}], [receiptFor(entry, { id: 'unknown-receipt' })]]) {
    assert.equal(statusOf(flow, snapshot, { ...runtime, layoutEvidence }), 'uncovered')
  }
  for (const evidenceId of [undefined, '', ' ', 'another-receipt']) {
    flow.test = report([measured({ evidenceId })])
    assert.equal(statusOf(flow), 'uncovered')
  }
  flow.test = report([entry])
  for (const overrides of [
    { version: 'b'.repeat(64) }, { pageId: 'another-page' },
    { hostRevision: 'other-host' }, { clientRevision: 'other-client' },
    { viewport: { width: 800, height: 600 } },
    { measurements: [{ ...entry.measurements[0], left: 25 }] },
    { measurements: [] },
  ]) {
    const live = { ...runtime, layoutEvidence: [receiptFor(entry, overrides)] }
    assert.equal(statusOf(flow, snapshot, live), 'uncovered')
  }
  flow.test = report([measured({ measurements: [{ ...entry.measurements[0], right: 799 }] })])
  assert.equal(statusOf(flow), 'uncovered', '手填修改记录不能替代宿主原始采集结果')
})

test('其它视觉尚无真实通用截图采集，任意产物字符串不能证明通过', () => {
  const flow = flowOf([visual])
  const entry = measured({ ac: 'AC-3', measurements: undefined })
  flow.test = report([entry])
  assert.equal(statusOf(flow), 'uncovered')
  for (const artifact of ['does-not-exist.png', 'screenshots/button.png', 'data:image/png;base64,pretend']) {
    entry.artifact = artifact
    assert.equal(statusOf(flow), 'uncovered', '任意产物名称不得充当真实采集和视觉验证')
  }
  entry.summary = ''
  assert.equal(statusOf(flow), 'uncovered')
})

test('MINOR 只影响评审发现分级，不能把未通过或未覆盖的 AC 变成通过', () => {
  const flow = flowOf()
  flow.test = report([evidence('AC-1', { status: 'fail' })])
  flow.review = report([], { angles: [{ findings: [{ ac: 'AC-1', file: 'src/ui.js', severity: 'MINOR', summary: '视觉缺口' }] }] })
  const ledger = acceptanceLedger(flow, snapshot)
  const remediation = remediationList(flow, ledger, { reason: 'test', note: '重新验证' })
  assert.equal(ledger.items[0].status, 'fail')
  assert.equal(remediation.items[0].ac, 'AC-1')
  assert.equal(remediation.items[0].status, 'fail')
  assert.equal(remediation.advisories.length, 1)
  assert.equal(remediation.reason, 'test')
  assert.equal(remediation.note, '重新验证')
})

test('重做清单保留 AC 缺口及 scope 内归属发现，scope 外与未知归属仅建议', () => {
  const flow = flowOf([unit, layout, { ...unit, id: 'AC-4' }])
  flow.test = report([evidence('AC-1', { status: 'fail' })])
  flow.review = { angles: [{ findings: [
    { ac: 'AC-1', resolvedFile: 'D:/Projects/demo/src/ui.js', file: 'D:/Projects/demo/src/ui.js', severity: 'MAJOR', summary: '必须修复' },
    { ac: 'AC-1', resolvedFile: 'D:/Projects/demo/src/else.js', file: 'src/else.js', severity: 'CRITICAL', summary: '范围外建议' },
    { ac: 'UNKNOWN', resolvedFile: 'D:/Projects/demo/src/ui.js', file: 'src/ui.js', severity: 'MAJOR', summary: '未知归属建议' },
  ] }] }
  const ledger = acceptanceLedger(flow, snapshot)
  const frozenBefore = structuredClone(flow)
  const result = remediationList(flow, ledger)
  assert.equal(result.items.filter((item) => item.source === 'acceptance').length, 3)
  assert.equal(result.items.filter((item) => item.source === 'review').length, 1)
  assert.equal(result.advisories.length, 2)
  assert.equal(result.items[0].status, 'fail')
  assert.ok(result.items.every((item) => item.summary !== '范围外建议'))
  assert.deepEqual(flow, frozenBefore)
  flow.review = null
  assert.equal(result.advisories.length, 2, '调用方保存清单后可安全清空旧报告')
})

test('Windows 路径按大小写和分隔符规范匹配，不接受目录相似前缀', () => {
  const flow = flowOf()
  flow.review = { angles: [{ findings: [
    { ac: 'AC-1', resolvedFile: 'd:/projects/DEMO/src/UI.js', file: 'd:/projects/DEMO/src/UI.js', severity: 'MAJOR', summary: '相同文件' },
    { ac: 'AC-1', resolvedFile: 'D:/Projects/demo/outside.js', file: 'src/ui.js/../outside.js', severity: 'MAJOR', summary: '不同文件' },
  ] }] }
  const result = remediationList(flow, acceptanceLedger(flow, snapshot))
  assert.equal(result.items.filter((item) => item.source === 'review').length, 1)
  assert.equal(result.advisories.length, 1)
})

test('未核实的 MAJOR 保留原严重度但只能进入重做建议', () => {
  const flow = flowOf()
  flow.review = { angles: [{ findings: [
    { ac: 'AC-1', resolvedFile: 'D:/Projects/demo/src/ui.js', file: 'src/ui.js', severity: 'MAJOR', summary: '真实阻塞项' },
    { ac: 'AC-1', resolvedFile: 'D:/Projects/demo/src/ui.js', file: 'src/ui.js', severity: 'MAJOR', summary: '位置与描述对不上', unverified: true },
  ] }] }
  const result = remediationList(flow, acceptanceLedger(flow, snapshot))
  assert.equal(result.items.filter((item) => item.source === 'review').length, 1)
  assert.equal(result.items.find((item) => item.source === 'review').summary, '真实阻塞项')
  assert.equal(result.advisories.length, 1)
  assert.equal(result.advisories[0].severity, 'MAJOR')
  assert.equal(result.advisories[0].unverified, true)
})

test('阶段摘要独立展示开发、验收、运行态、执行及复用数量', () => {
  const flow = flowOf()
  flow.devChanges = { files: ['src/ui.js'], untracked: [{ path: 'src/helper.js' }, 'src/ui.js'] }
  flow.gateNote = '实现已提交，等待浏览器实测'
  flow.execution = { status: 'running', taskId: 'job-1' }
  flow.review = { angles: [{ id: 'new' }, { id: 'old' }], reused: ['old'] }
  flow.test = { directions: [{ id: 'fresh' }, { id: 'reused' }, { id: 'another' }], reused: ['reused'] }
  const summary = stageSummary(flow, acceptanceLedger(flow, snapshot), runtime)
  assert.equal(summary.implementation.status, 'submitted')
  assert.equal(summary.implementation.text, flow.gateNote)
  assert.deepEqual(summary.implementation.files, ['src/ui.js', 'src/helper.js'])
  assert.equal(summary.verification.pass, 0)
  assert.equal(summary.verification.uncovered, 1)
  assert.equal(summary.execution.status, 'running')
  assert.equal(summary.runtime.status, 'verified')
  assert.equal(stageSummary(flow, undefined, { status: 'stale', reason: '客户端版本仍旧' }).runtime.text, '客户端版本仍旧')
  assert.deepEqual(summary.review, { fresh: 1, reused: 1, total: 2 })
  assert.deepEqual(summary.test, { fresh: 2, reused: 1, total: 3 })
})

test('执行摘要保留具体阶段文案，流程或执行取消时固定取消提示', () => {
  const flow = flowOf()
  const ledger = acceptanceLedger(flow, snapshot)
  for (const [status, message] of [
    ['completed', '手工报告已接收；实际执行证据见验收账本'],
    ['completed', '已复用本轮新执行0'],
    ['running', '子代理仍运行'],
    ['failed', '子代理失败'],
  ]) {
    flow.execution = { status, text: message }
    assert.equal(stageSummary(flow, ledger).execution.text, message)
  }
  flow.execution = { status: 'completed', text: '  ' }
  assert.match(stageSummary(flow, ledger).execution.text, /执行已完成/ )
  flow.execution.text = '不可覆盖取消状态的旧文案'
  flow.cancelled = true
  assert.equal(stageSummary(flow, ledger).execution.text, '执行或流程已取消')
  flow.cancelled = false
  flow.execution.status = 'cancelled'
  assert.equal(stageSummary(flow, ledger).execution.text, '执行或流程已取消')
})

const excludedFlow = (overrides = {}) => {
  const flow = flowOf()
  flow.scope.data.in_scope.commands = ['npx playwright test']
  flow.test = report([{
    ac: 'AC-1', status: 'excluded', method: 'unit',
    excludeReason: '本机没有 Playwright 浏览器',
    summary: '探测 npx playwright test 失败：Executable doesn\'t exist',
    probe: { command: 'npx playwright test', exitCode: 1, failure: 'Error: browserType.launch: Executable doesn\'t exist at ...' },
    version: snapshot.id, ...overrides,
  }])
  return flow
}

test('环境受限不是写句理由就免检：探测命令、退出码、失败原文、阶段、方法与证据一项不能少', () => {
  const good = excludedFlow()
  assert.equal(statusOf(good), 'excluded')
  assert.equal(acceptanceLedger(good, snapshot).counts.excluded, 1)
  const cases = [
    [{ probe: undefined }, /必须附探测记录/],
    [{ probe: { command: '', exitCode: 1, failure: 'x' } }, /探测记录缺少命令/],
    [{ probe: { command: 'npm test', exitCode: 1, failure: 'x' } }, /不在授权命令清单内/],
    [{ probe: { command: 'npx playwright test', exitCode: 0, failure: 'x' } }, /退出码无效/],
    [{ probe: { command: 'npx playwright test', exitCode: 1, failure: '' } }, /缺少失败原文/],
    [{ method: 'manual' }, /方法与验收标准声明不匹配/],
    [{ summary: '' }, /缺少非空说明/],
    [{ excludeReason: '' }, /没写明原因/],
  ]
  for (const [override, pattern] of cases) {
    const flow = excludedFlow(override)
    assert.equal(statusOf(flow), 'uncovered', JSON.stringify(override))
    assert.match(acceptanceLedger(flow, snapshot).items[0].reason, pattern)
  }
  // 评审阶段不能替测试阶段宣布「环境测不了」：那等于用一句理由把 S4 的门槛挪走。
  const reviewOnly = flowOf()
  reviewOnly.scope.data.in_scope.commands = ['npx playwright test']
  reviewOnly.review = report([{ ac: 'AC-1', status: 'excluded', method: 'unit', excludeReason: '没有浏览器', summary: '探测失败', probe: { command: 'npx playwright test', exitCode: 1, failure: 'ENOENT' }, version: snapshot.id }])
  assert.match(acceptanceLedger(reviewOnly, snapshot).items[0].reason, /评审阶段不能把验收标准标记为环境受限/)
})
test('任务 ID 不代表完成，开发提交与流程取消也不能变成执行成功', () => {
  const flow = flowOf()
  flow.devChanges = { files: [] }
  flow.execution = { taskId: 'job-1' }
  assert.equal(stageSummary(flow, acceptanceLedger(flow, snapshot)).execution.status, 'pending')
  flow.execution = { status: 'completed', taskId: 'job-1' }
  assert.equal(stageSummary(flow, acceptanceLedger(flow, snapshot)).execution.status, 'completed')
  flow.cancelled = true
  assert.equal(stageSummary(flow, acceptanceLedger(flow, snapshot)).execution.status, 'cancelled')
  flow.cancelled = false
  for (const status of ['failed', 'cancelled', 'running']) {
    flow.execution.status = status
    assert.equal(stageSummary(flow, acceptanceLedger(flow, snapshot)).execution.status, status)
  }
})
