# Changelog

## Unreleased

- **受限沙箱里「一条命令跑全量」是假的：十四套全部 NOT_RUN，退出码 1**：`npm test` 在本机会话里长期只打印十四行 `xxx=NOT_RUN (EPERM)`。看起来像测试坏了，实际是沙箱拒绝**用管道 stdio 派生进程**——`spawn` 本身没问题。同一个子进程换 `stdio: 'pipe'` 直接 `EPERM`，把 stdout/stderr 指向真实文件描述符（`fs.openSync`）却能正常退出并写满输出。`node --test` 恰恰为每个测试文件派生子进程并用管道收输出，于是整套测试在沙箱里集体消失。

  新增 `scripts/capture-child.mjs`：`captureSync(command, args, options)` 与异步版 `capture(...)` 都先开临时文件、把子进程输出指过去、读回、再删（Windows 上删不掉开着的文件，所以先 `closeSync` 后 `rmSync`）；临时文件打不开才回落管道，普通宿主行为不变。返回值与 `spawnSync` 同形，`stdout`/`stderr` 一律是字符串。

  调用点逐个换掉：`test/host.test.mjs` 的 git 探测与 `git(args)` 包装、`node --check` 自检；`test/test-runner.test.mjs` 里「同时跑两个子进程」改用异步 `capture`；`scripts/run-tests.mjs` 自己经 `spawnSync` 收子进程输出，一并改走捕获。两处夹具（`test/test-runner.test.mjs` 的复制列表、`test/publish.test.mjs` 的 `run-tests.mjs` 复制循环）必须同步复制 `capture-child.mjs`，否则夹具报 `ERR_MODULE_NOT_FOUND`。

  生产代码同样中招：`lib/index.js` 的 `gitSummaryText` 原先用 `promisify(execFile)`——宿主没有 shell 服务（例如 dsh-ops 退掉了 shell 行）时，兜底采集在沙箱里会 `spawn EPERM`，变更摘要变成「无法自动采集」。改成 `captureCommand`：同样的文件描述符捕获、同样的 `cwd`/`timeout`/`4MB` 上限，非 0 退出码仍然抛错（错误文案从 Node 的 `Command failed` 改成 `git 退出码 N：stderr`）。

  另外两个连带问题：① `npm pack` 在沙箱里退 1，因为 npm 打包前要往 `%LOCALAPPDATA%\npm-cache\_logs` 写日志，而那个目录被判不可写——`test/publish.test.mjs` 因此给夹具一个临时 `npm_config_cache`（`loglevel=silent` 不管用，实测仍退 1）。② `test/subagents.test.mjs` 是顶层 `await test(...)` 顺序执行的，配上 `--experimental-test-isolation=none` 在 Node 26.13.1 下会**挂死**（三行最小复现即可复现，超时退出 124），所以这一套改回直跑，完成标记从 TAP 的 `# tests N` 换成直跑的 `ℹ tests N`。

  验证是可证伪的：`node scripts/run-tests.mjs` 从「十四套全 NOT_RUN、EXIT=1」变成十四套全 PASS、`EXIT=0`、89 秒；`test/host.test.mjs` 从 414 项变成 417 项，多出来的正是原先被跳过的那三条「没有 shell 服务时改用 child_process 采集变更摘要」。

- **「check 传空函数」这类退化只能靠人眼发现：G13 那五处修完了，同类问题没有防线**：`test/host.test.mjs` 里五处 `check(名称, () => {})` 已经改掉（见下一条），但改掉的是结果，不是成因。成因是「用例名」与「断言」之间只靠一条约定连着——`check` 只负责跑回调、记名字、打印 `ok`，它无法判断回调里到底有没有断言。于是三种退化都长得像通过：回调是空函数、回调里只有 `assert.ok(true)` 这类恒真占位、回调里断言自己等于自己。`test/host.test.mjs` 就还有五处 `check(名称, () => assert.ok(true))`（`G07 异常元数据、循环、断链、服务异常与已结束最近流程安全终止`、`G07 冷启动先恢复再核对身份：本人和完整后代受限，无关及缺失链放行`、`G07 后代相对目标按执行目录解析，嵌套调用和批量 root 不得绕出 scope`、`G07 已结束最近流程的持久化边界在冷热态一致，不套用更远祖先`，以及按 `kind` 循环生成的那条 `G07 ...失败不打断无关或归属无法确认的普通操作，不污染进度`）：断言确实写在 `check` 之前的语句里，但 `check` 里挂的是一个恒真占位——前面那段断言一旦被删，名字照旧打印 `ok`。这类问题靠评审看不出来，靠人记性也守不住，只能交给扫描。

  新增 `scripts/verify-checks.mjs`：对 `test/*.test.mjs` 做一次手写词法扫描，把「代码态」和「注释 / 字符串 / 模板 / 正则」分开——`codeMask` 是一个逐字符状态机，处理转义、模板 `${}` 嵌套（`templateStack`）、正则字面量（靠前一个代码字符是否属于 `REGEX_PREFIX` 判断），产出只保留代码结构的骨架；`skeleton` 把非代码字符换成空格。不用正则直接匹配 `check(`，是因为注释里、字符串里、模板里都会出现这个形状（`test/client.test.mjs` 就有），正则分不清。`findCalls` 只认裸调用（前一个字符不是 `[\w$.]`），跳过 `function check` 定义，并用一条规则排掉对象/类方法简写——右括号之后跳空白若遇到 `{` 就当作定义（`test/subagents.test.mjs:233` 的 `check(name, args = {}, id = sessionId, finalOnly = false) {` 正是这种，第一版把它误报成违约）。`splitArguments` 按顶层逗号切参数，`classify` 只看第二参数：裸标识符（转调）跳过不计，其余判空回调、恒真占位、自己等于自己三类违约。

  扫描器自己也要被证明「判定在判定」：`SELF_TESTS` 18 例走与真实扫描完全相同的 `scanSource`，覆盖空回调（含带空格与 `async` 形态）、只有注释的回调、`assert.ok(true)`（表达式体与块体两种）、`assert.equal(a, a)`，以及全部该放行的形态（正常断言、块体多语句、异步块体）和全部不该误报的形态（字符串、模板、行注释、块注释、正则字面量里的 `check(`、`function check` 定义处、转调）。默认行为改成先自检再扫描——聚合器只能靠 stdout 的完成标记判断成败，两条路共用一个入口才不会漏掉「判定本身坏了」这种情形。命令行支持 `--root`（与 `scripts/check-syntax.mjs` 同形），扫不到测试文件或一处调用都没扫到都返回 1，不假装通过。

  接入两处：`npm run check` 链尾追加 `node scripts/verify-checks.mjs`（现为 `stamp-revisions.mjs --check && check-syntax.mjs && verify-layout.mjs --self-test && verify-checks.mjs`）；`scripts/run-tests.mjs` 的 `testSuites` 在 `layout` 之后按 `existsSync(root + 'test/host.test.mjs')` 接入 `['checks', 'test:checks', /^check contracts verified \([1-9]\d* calls in [1-9]\d* files\)\.$/m]`——与 `publish` / `runner` 同款存在性判断，因为元测试第一个用例的隔离夹具只复制 `scripts/` 与 `lib/`、没有 `test/` 目录，硬接会让夹具汇总凭空多出 `NOT_RUN`。`package.json` 新增 `"test:checks"`，`test/test-runner.test.mjs:260` 的套件计数从 `12` 改成 `13`。

  同时把 `test/host.test.mjs` 那五处 `assert.ok(true)` 改成了真正的断言：新增 `checkAsync(label, fn)` 异步入口（同步 `check` 拿不住 `await`——它在断言跑完之前就记了通过，失败也带不上用例名），五处一律改成 `await checkAsync('<原名>', async () => { ... })`，把原先写在 `check` 之前的断言整段搬进回调，一条断言都没放宽。

  验证是可证伪的：`node scripts/verify-checks.mjs` 输出 `check 契约自检通过：18 个用例` 与 `check contracts verified (668 calls in 11 files).`，退出码 0；临时夹具里放空回调、`assert.ok(true)`、`assert.equal(1, 1)` 三条，扫描器逐条报 `回调是空函数` / `回调里只有 assert.ok(true)` / `回调里只有自己等于自己的断言` 并返回 1；把 `test/host.test.mjs` 第一处搬进回调的断言期望从 `'allow'` 改成 `'deny'`，`node test/host.test.mjs` 立刻打印 `FAIL G07 异常元数据、循环、断链、服务异常与已结束最近流程安全终止 -> Expected values to be strictly equal` 并非零退出，说明用例名重新绑上了失败；改回后仍是 414 项全过。`node --check` 与 `node scripts/stamp-revisions.mjs --check` 通过，`node scripts/check-syntax.mjs` 输出 `Syntax verified (29 files)`。`npm test` 这套聚合器当时在本机会话里各套全报 `NOT_RUN (EPERM)`（宿主禁止测试进程再起子进程），`test/test-runner.test.mjs` 直接跑同样报 `spawn EPERM`，只能逐套直跑；这一限制已在本条上方的「受限沙箱」条目里修掉，现在十四套全 PASS。
- **五条 Hub 用例把断言写在 check 之前，空回调谁都守不住**：`test/host.test.mjs` 里有五处 `check(名称, () => {})`，真正的断言全写在上一行——非法页码/未登记/相对/文件路径/非法请求体，外部快照新增删除损坏修复，规则 ID 重复未知冲突，内存状态优先与取消计数，成员移除与目录消失。断言照常执行、失败照常抛错，所以它们不是「永远绿」；坏在归因与覆盖：断言抛出时 `check` 那一行根本没进去，既不打印 `FAIL <用例名>` 也不进 `passed`，读日志的人只看到一个不带名字的 `AssertionError`；反过来，有人把断言删掉或改成恒真时，这五个名字照样打印 `ok` 并计进「全部通过」——名字说「这组行为有人守着」，实际什么都没守。

  改法是把断言搬进回调：先把每次请求的响应收进局部变量（`invalidPages` / `invalidPaths` / `invalidBodies` / `pageAfterAdd` / `membersAfterRemove` / `pageAfterCorrupt` / `readsAfterPaging` / `pageAfterRepair` / `invalidStatuses` / `afterInvalidRules` / `activeBefore` / `afterCancelPage` / `rulesAfterRemove` / `flowsAfterGone` / `rulesAfterGone` / `membersAfterGone`），再在 `check` 里断言，一条断言都没有放宽。验证方式是可证伪的：把第一处 `invalidPages` 的期望改成 8，`node test/host.test.mjs` 立刻输出 `FAIL Hub 拒绝非法页码、未登记/相对/文件路径与非法请求体 -> Expected values to be strictly deep-equal` 并以非零码退出，说明名字重新绑上了失败；改回后 414 项全过（项数没有变化——这五条此前也计过数，这次修的是归因和覆盖，不是计数）。`npm run check` 的语法自检通过。`npm test` 这套聚合器当时在本机会话里十三套全报 `NOT_RUN (EPERM)`（宿主禁止测试进程再起子进程），只能逐套直跑 `node test/host.test.mjs`；管道捕获已在本条上方「受限沙箱」条目里修掉，现在全量十四套 PASS。

- **语法自检的名单、文档里的模块数量与测试项数都是手抄的，已经对不上**：`check` 脚本用 `node --check` 逐个列文件，`lib/requirements.js` 从没进过名单——它是生产模块，`lib/runtime.js` 的 `HOST_MODULES` 七个之一，被 `test/host.test.mjs` 直接 import，语法错误要等到运行期才暴露；`docs/probe-stage-width.mjs`、`scripts/stamp-revisions.mjs` 同样缺席，而 G12 修复新增的 `scripts/run-tests.mjs` 与 `test/test-runner.test.mjs` 也没进去，手工清单必漏这件事在同一处当场复发了第二次。文档侧是同一类漂移：`docs/development.md` 与 `docs/verification.md` 有三处按「六个宿主模块」写，实际是七个（漏了 `ecosystems.js`）；测试项数在 `docs/verification.md`、`CHANGELOG.md` 里并存 758 / 760 / 763 / 799 等几套互不相容的数字，同一个文件里集成 33 对 41、子代理 82 对 75；`docs/verification.md` 的 30 处 `test/xxx.test.mjs:行号` 引用里有一半已经指向无关代码行或空行；`README.md` 的 `#开发规则` 锚点在 `docs/development.md` 里并不存在。

  自检改为按目录展开。新增 `scripts/check-syntax.mjs`：`TARGETS` 声明 `lib/*.js`、`docs/*.mjs`、`scripts/*.mjs`、`test/*.mjs` 四个目录，`readdirSync` 展开后逐个 `node --check`，新增文件自动纳入，不必再改 `package.json`；`--root` 可指向别处，目录缺失则跳过。宿主沙箱禁止测试进程再起 Node 子进程（`spawn` 与 `execFileSync` 都报 `EPERM`），这时退化为进程内 `stripTypeScriptTypes` 解析并在输出里注明「宿主禁止子进程，已退化为进程内解析」——**EPERM 不是语法错误**，不区分的话全部文件都会被误报成 `Syntax error`（第一版实现就踩了这个坑，已修）。`check` 同时把此前没有任何自动化入口的 `docs/verify-layout.mjs --self-test`（25 项纯函数断言）接进来，最终为 `stamp-revisions.mjs --check && node scripts/check-syntax.mjs && node docs/verify-layout.mjs --self-test`。`stripTypeScriptTypes` 只在真要降级时才 `require`，能起子进程的环境根本碰不到它；它那一条实验性警告走 Node 的默认打印、不经过 `'warning'` 事件，所以在 `process.emitWarning` 这一层精确过滤掉，其余警告原样转发——不用给调用方加 `--no-warnings`，那样会连真正的警告一起吞掉。

  文档改成「不写会漂的数字」。`docs/verification.md` 文件头新增「怎么读这份记录」：每节是时间点快照，项数逐节变大不是矛盾；「六个模块」是 `ecosystems.js` 加入前的说法，现在唯一来源是 `HOST_MODULES`；**引用测试位置一律用用例标题，不写行号**。30 处行号引用全部改成「`test/xxx.test.mjs` + 用例标题」，全文件 `.test.mjs:数字` 命中数归零；「九个入口」与「八个入口」加「当时的」限定；`docs/development.md` 的「六个宿主模块」改为七个，`README.md` 的失效锚点改指 `docs/development.md` 的「规则跟工作区走」；2026-11-21 那节补一段说明 AC-1 的方向级写权限声明（`shellGrant` / `writeGrants` / `needsWrite` / `directionWriteDeclared` 与三个 `toggle*` / `declareDirectionWrite` 动作）已整体移除，那一节只是当时的记录。

  测试：`npm run check` 退出码 0，输出 `Module revisions verified (7 modules).`、`Syntax verified (28 files)` 与布局自检的 `{"status":"pass","checks":25}`，无实验性警告噪音（28 = lib 8 + docs 3 + scripts 6（含本脚本自身）+ test 11）。同步升到 0.1.12。逐套直跑：客户端 249、宿主 414、集成 44、子代理与 provenance / acceptance / runtime / gatemode / install 全通过；`publish` 与 `test-runner` 两套当时在本机宿主沙箱内因禁止子进程（`spawnSync` → `EPERM`）失败，属环境限制，与本次改动无关；管道捕获落地后这两套已能跑通，见上方「受限沙箱」条目。

- **审计流水只记「允许 / 拒绝」：权限模式、退出码与提权申请一概不落盘**：起因是 `auditShell` 的 `detail` 只有命令原文、`outcome`、`reason` 与执行目录。一次 `shell.allowed` 说不清它是在 `workspace-write` 下跑的还是 `danger-full-access` 下跑的，也说不清跑完到底成功没有——`exitCode` 不在事件里，失败与成功在流水上长得一模一样；提权更是完全不落盘：模型重试时带 `sandbox_permissions` + `justification`，判定侧只会照常写一条 `shell.allowed`，事后既看不出「这次执行是在申请放宽权限」，也看不出「放宽有没有真的生效」。三件事叠在一起，事后追责只能回到对话记录里翻，而 `flows.jsonl` 本来就是为了不依赖对话记录而存在的。

  修法分三处。`auditShell(flow, command, outcome, reason, directory, mode = 'unknown')` 新增 `mode` 字段并一路穿到底：`scopeDenial` / `shellDenial` / `runCodeDenial` 各加一个 `mode` 形参（默认 `'unknown'`），pre-execute 入口用 `sandboxModeOf(exec)` 取一次再往下传，`childDenial` 那条审计也补上同一取值。取不到时（宿主没装 `sandboxPolicy`、`resolve` 抛错、返回值不在 `read-only` / `workspace-write` / `danger-full-access` 之内）一律写字符串 `'unknown'`，不省略这个键——省略会让「这次确实没有权限信息」和「这是老版本写下的事件」变成同一种形状，读流水的人没法区分。

  执行结果另起一条事件。新增 `tools/result` 监听（effect 名 `flowgate: shell result audit`），对 `SHELL_TOOLS` 里的工具写 `shell.result`，`detail` 带 `command` / `truncated` / `exitCode`（非整数写 `null`，后台任务与超时都是这个形状）/ `signal` / `timedOut` / `background`（`value.kind === 'background'` 或 `value.jobId` 是字符串）/ `mode`（优先取结果里的 `value.sandbox.mode`，取不到回落到 `sandboxModeOf(exec)`），另有 `sandboxDenied` 与 `failed` 两个只在成立时出现的键。判定与结果是两条事件，不合并：判定发生在执行前、结果发生在执行后，中间可能隔着一次提权重试，合成一条会丢掉「这一轮被判了两次」这个事实。

  提权拆成申请与结论两条。`sandbox_permissions` 落在 `SANDBOX_MODES` 之内时，pre-execute 在判定之前先写 `sandbox.escalated`（`tool` / `command`（shell 工具才带，截断到 200 字）/ `from` / `to` / `justification`），主 Agent 与子代理都记；`tools/result` 里再按结果写结论——结果里实际生效的 `value.sandbox.mode` 等于目标就写 `sandbox.approved`，否则写 `sandbox.denied` 并在 `detail.reason` 写明「提权未生效」。宿主没有可监听的独立提权事件，结论只能从「请求的目标」与「实际生效的模式」两边比对得出，而这两个值现在都落进了流水。

  测试：`test/integration.test.mjs` 新增「审计流水记录权限模式、退出码与提权申请」，断言放行事件的 `detail.mode` 是 `'unknown'`（夹具宿主没有 `sandboxPolicy`，取不到就该写这个字面量）、`tools/result` 监听已注册、`exitCode: 3` 的结果事件、后台任务那条 `exitCode` 为 `null` 且 `background === true`、带 `sandbox_permissions` 的调用写出 `sandbox.escalated` 且 `from` 与 `to` 分别是 `'unknown'` 与目标模式、同一窗口内判定侧照旧有一条 `shell.allowed`（两条事件可以分别过滤），以及 `effective` 命中与未命中分别落成 `sandbox.approved` / `sandbox.denied`。既有断言一条没放宽：`test/subagents.test.mjs:418-421` 的 `deepEqual` 只映射 `[type, detail.dir, detail.cwd]`，新增字段不影响它。`node --check lib/index.js`、`npm run check`（七个模块修订通过）与 `npm test` 十三套全 PASS。同步升到 0.1.11。
- **默认链路「接入即红」：元测试那条「没有 Git 时宿主退出 0」和 publish 的顺序断言同时失效**：`npm test` 里 `runner=FAIL`、`publish=FAIL`，而这两个套件各自单独跑又能过——红的是链路，不是断言。两处根因摞在一起：其一，用例原本把 `PATH` 换成空的临时目录来模拟「没有 Git」，`npm` 跟着一起消失，宿主套件里带 `commands: ['npm test']` 的 scope 提交时体检报「命令本身找不到：npm」，`lib/index.js` 在提交路径上抛出未捕获错误、宿主以 1 退出，剧本从「无 Git 就 SKIP」变成「无 Git 顺带崩」；其二，宿主套件 G40-20 的第二个 `flowgate_doc` 用生产默认上限真实等待 10 分钟，`runSuites` 的 180 秒上限到点直接 `SIGKILL`——只修 `PATH` 的话仍然超时，所以两处必须一起改。

  用例现在只从 `PATH` 里摘掉含 `git` 可执行文件的目录段，`node` 与 `npm` 所在目录原样保留；`node` 目录本身含 git 时，把 `node` 与 `npm` 复制进一个干净的临时目录顶到最前。构造完先用 `spawnSync('git', ['--version'])` 断言 `error.code === 'ENOENT'`，证明「Git 确实不可见」再跑聚合器，断言没有被放宽。G40-20 改为注入 `service.gateWaitOverrideMs = 60`，并在 `finally` 里恢复；顺带修正 `currentService()` 的取值时机（必须在 `makeHost` 之后，否则模拟宿主还没装好，`service.get(sid)` 返回 null）。`test/publish.test.mjs` 的「接入汇总」用例同步到新顺序：`publish` 在 `runner` 之前，`runner` 才是最后一套。

  文档：`docs/development.md` 的 `npm test` 行从「十二套起」改成「全量十三套；`publish` 与 `runner` 按测试文件是否存在接入」，与 CHANGELOG 口径一致。

  测试：`node --test test/test-runner.test.mjs` 与直跑入口都是 15/15，宿主 417 项、publish 26 项全过，`node scripts/run-tests.mjs` 十三套全 PASS、退出码 0；`node test/host.test.mjs` 从十分钟挂起回到秒级。

- **聚合器的元测试自己不在链路上，用 `node --test` 跑还会假失败**：起因是 `scripts/run-tests.mjs` 的默认链路就是 `suites` 这一个常量——`revisions` 套件加 `...testSuites` 十套，里面没有 `runner`，所以 `test/test-runner.test.mjs` 只靠人记得手工跑：谁改坏了 `resultFor` 或 `suites` 都不会有人发现，而改坏的典型形态恰恰是「汇总器开始骗人」，正是当初加 G12 / G14 要解决的那个问题以更难发现的方式回来。三处缺陷是同一条链上的：元测试不在链路里；要接进去得先给聚合器留一条输出通道，否则元测试的 `capture` 只替换 `console.log`，子进程 stdout 会直接写穿到真实标准输出、混进 `node --test` 的 TAP 流；而 `node --test test/test-runner.test.mjs` 本身会假失败——测试运行器给子进程设了 `NODE_TEST_CONTEXT`，元测试 spawn 出来的 `node scripts/run-tests.mjs` 继承它之后按子测试协议自报，父进程看到的是一份伪造的测试结果。

  `runSuites` 的 `options.write` 成为唯一输出通道：缺省仍是 `process.stdout.write`，`resultFor` 在 `spawnSync` 之后按「是不是函数」决定写哪里，既有调用点一行都不用改；`suites` 末尾按 `existsSync(root + 'test/test-runner.test.mjs')` 接入 `['runner', 'test:runner', tap]`，与 `publish` 同款存在性判断——元测试第一个用例的临时夹具只复制 `scripts/` 与 `lib/`、不复制 `test/`，那里仍是 `revisions` 加十套，所以这条接入不会自己套自己。`package.json` 新增 `"test:runner": "node --test --test-reporter=tap test/test-runner.test.mjs"`，与其它 `test:*` 同形。

  元测试自己建输出通道并清洗环境：`capture(callback)` 现在把两个 sink（`write` 与 `console.log`）一起交给回调，调用点写成 `capture((sink) => runSuites([...], { cwd, env: childEnv(), ...sink }))`；`childEnv()` 浅拷贝 `process.env` 后删掉 `NODE_TEST_CONTEXT`，`run`、`runFixture`、两进程并发那组子进程全部改走它。

  测试：`test/test-runner.test.mjs` 新增三条用例——默认链路把元测试自己接在最后并复用 `provenance` 的 TAP 完成标记（断言 `suiteFor('runner')` 存在、command 等于 `package.json` 的 `test:runner`、`suites[0]` 仍是 `revisions`、条数按 `publish` 是否存在算）、接上输出通道时子进程输出不进汇总通道、`NODE_TEST_CONTEXT` 下子进程不继承测试协议；原有 11 条断言一条未放宽。

  文档：`docs/development.md` 的测试章节把默认链路的套数改成「十三套」，`npm run test:runner` 与直跑入口分成两行并说明二者对同一缺陷给同一个结论，另补一段讲接入条件、夹具为何不会自套、以及 `options.write` 与 `NODE_TEST_CONTEXT` 两处机制。

- **门禁等待器只活在进程内存里、还不设超时：发布重启之后 Agent 永久悬挂**：起因是 `GateHub` 的 `this.waiters` 是一个纯内存 `Map`，而 `awaitGate` 调 `service.gates.wait(sessionId, kind, 0, exec.signal)` 时把超时写死成 0——`GateHub.wait` 里 `if (timeoutMs > 0)` 才装 `setTimeout`，0 就是不装。于是「改代码 → 发布 → 重启 → 验证」这条路上每一次重启都会把正在等的门禁等待器一起杀掉，Agent 侧表现为工具调用永久挂起（只有宿主自己的工具超时或用户手动中断才结束）；恢复之后它只知道「停下来等确认」，不知道上次等的是哪一个门禁，也分不清「没提交」与「提交了但没人点」，而 `flowgate_status` 同样查不回这个 id，只能重跑一遍。修 G38、G39 都要走这条路，所以它是「用 flowgate 修 flowgate」唯一会直接阻断的条目。
  门禁请求现在落盘成对象。`markGateRequested(flow, kind)` 写 `{ id: 'gate_' + randomUUID().slice(0, 8), at, kind, endedAt: null, endKind: null }` 到 `flow.stages[stage].gateRequested`，`emptyStage()` 的默认值由 `false` 改为 `null`；旧快照里那个布尔 `true` 由 `gateRequestOf(record)` 兼容成「id / at / kind 都是 null、也没收尾」的五字段对象——`repairFlow` 的 `{ ...emptyStage(), ...saved }` 会把旧布尔原样带回，读 `=== true` 的地方（`doc.interrupted`、`gate.interrupted`）必须同时改，否则重启后旧流程会被判成「没请求过门禁」。
  超时上限默认 10 分钟，工作台可配。`GATE_WAIT_DEFAULT_MINUTES = 10`、`GATE_WAIT_MIN_MINUTES = 1`、`GATE_WAIT_MAX_MINUTES = 60`，`normalizeGateWaitMinutes` 把非有限数、0、负数与越界值一律改回 10——它只接受数字与非空数字字符串，布尔 `true` 不会被解释成 1 分钟（那样「配置写错了」会静默变成「上限被设成最小值」，而写错的人以为自己在用默认值），`gateWaitTimeoutMs(workspace)` 换算成毫秒；`awaitGate` 与 `flowgate_ask` 都改走 `service.gateWaitMs(flow)` 这个唯一解析点（测试用 `gateWaitOverrideMs` 注入毫秒级上限，生产路径永远 null）。0 在配置层明确不接受：不超时正是这条缺陷的来路，界面上写的是「不能设成 0」，服务端遇到越界值会保存默认值并抛一条说明。上限是工作区级的（`config.json` 的 `gateWaitMinutes`，随 `setWorkspaceStages` 一并写回），改了对进行中的流程立即生效，已经挂着的等待器保持它自己的计时。
  等待收尾有记录。被取代时返回值里的 `gateId` 指向「这一次等待自己」的请求：`awaitGate` 在 `gates.wait` 返回前把请求记录附在 `outcome.self` 上（唯一写入点），`gateWaitPayload` 优先从这里取（唯一消费点）——这时盘上的 `gateRequested` 已经是取代者的新请求，读盘会拿错 id、误报 `willWake`。这是一条显式契约，两处注释互相指认。
  等待收尾有记录。`endGateRequest(flow, endKind, gateId)` 写 `endedAt` / `endKind`，把 `flow.gateWaitReason` 设成同一个值，`appendEvent` 记 `gate.timeout` 或 `gate.interrupted`，然后 persist；第三个参数 `gateId` 是守卫——被新的等待取代时新请求已经写了自己的 id，旧调用晚一步回来绝不能把新请求标成「已结束」。`gateRequested` 本身不清：它的含义是「本阶段确实请求过门禁」，不是「有等待器挂着」；清掉会让界面回到「pending 且未中断」，正好把要区分的两种情况合回一种。四个门禁工具与 `flowgate_ask` 的中断分支都带 `waitReason`（`timeout` / `superseded` / `aborted` / `restart`）、`willWake`、`gateId` 三个字段，`decision` 的取值一个没动（`flowgate_doc` 仍是 `pending`、`flowgate_gate` 仍是 `wait`），既有测试与文档不用跟着改。`gateWaitNote` 按 `willWake` 分岔：内存里还有等待器时才说「点了按钮你会收到唤醒消息」，否则明说「现在没有等待器挂着：用户点了按钮只会记录决定，不会叫醒你」，并要求停下来等用户发消息或查 `flowgate_status` 的 `waiting` 字段——原来那句话在这种情况下是假的。
  `flowgate_ask` 超时不再把卡片作废。只有 `cancelled` 才清 `flow.grill.pending`；`timeout` / `superseded` / `aborted` 一律保留，否则用户正看着的卡片会凭空消失。光保留还不够：`applyAction` 的 `case 'answer'` 原来在 `gates.notify` 落空时直接抛「当前没有等待中的追问卡片」，那样做出来的就是「点了就报错」的卡片，所以它现在改为把答案落进 `flow.grill.answered`（事件 detail 记 `late: true`）、清掉 pending，再经 `service.nudges` 与 `wakeAfterAnswer` 唤醒 Agent。视图语义因此分开：`grill.awaiting` 读实时等待器，`grill.pending` 读落盘字段，超时之后是「pending 有、awaiting 无」。不选「超时自动重挂」——追问 id 每轮 `randomUUID`，重挂会把用户正在看的卡片悄悄替换掉。
  重启之后能读回来。`hydrate(cwd)` 里调 `recoverGateRequest(flow)`，判据是「门禁仍 pending、请求没有 `endedAt`、内存里没有这个会话的等待器、这条 id 还没恢复过」，命中就写 `flow.gateRecovered = { gateId, kind, stage, at }` 与 `flow.gateWaitReason = 'restart'`，并 `appendEvent` 一条 `flow.gate.recovered`。不引入 `bootId`：`hydrate` 早有「持久化说 running、进程里没有活体」的先例，而 `waiters` 本来就是纯内存，重启必为空。也不做启动扫全量目录、不引入工作区登记表——第一次有人碰这个目录时补写一次即可。
  `flowgate_status` 的 `waiting` 字段按落盘记录判定（门禁 pending 且这次请求没 `endedAt`），空对象表示门禁没在等或这次等待已经收尾；`summary` 里另起一行把三种情况分开念：「等待器还挂着」「这次等待已经结束，但门禁仍然开着」「没有等待器接着这个门禁」，重启过的再补一句「原来的等待器随进程一起没了」。`view()` 的 gate 段新增 `request` / `recovered` / `waitReason`，`doc.interrupted` 与 `gate.interrupted` 改用 `gateRequestOf`。这两个标记都绑定到「本阶段这一次请求」：`recovered` 要求 `flow.gateRecovered.gateId === gateRequest.id`，`waitReason` 在 `gateRequest` 为空时一律给 `null`。不校验 id 的话，阶段推进之后上一轮的标记还留在 `flow` 上，从没请求过门禁的新阶段会显示「宿主重启过」或「等待已超时」，而它的 `gateRequest` 根本没有 id 可念；`statusTool` 里那行「宿主重启过」同样按 id 比对，不然旧历史会被一直念下去。
  界面不再一句话打发。`gateInterruptedText(view)` 按重启过、等满上限、被取代、被取消分别说明来路，并统一补一句「现在点按钮只会记录决定，不会叫醒 Agent；要让它接着做，请在对话里发一句「继续」」；提示条在「等待器没了、门禁还开着」时不再显示「等待 Agent 下一步」（用户会一直等下去，那正是这条缺陷的表现）；追问卡片在 `awaiting` 为假时说明点选仍会记录答案并叫醒 Agent；设置面板新增「门禁等待」组，输入框限 1–60 分钟、默认 10，附「恢复默认」与保存路径说明。S1 要单独照顾：那个阶段的门禁产物是需求文档，`gateArtifactReady` 对 S1 恒为 false，`gate.pending` 也就恒为 false，等待记录与原因全落在 `doc` 段——`view().doc` 因此同样带 `waitReason`，`gateInterruptedText` 把 `gate` 与 `doc` 两段合起来读，`DocCard` 的中断提示也改用同一句，否则 S1 超时后界面只会说「请求被中断了（工具调用超时或宿主重启）」，说不出到底是等满了上限还是重启过。
  测试：`test/host.test.mjs` 新增 G40-1 ~ G40-17（`gateId` 落盘与 `status.waiting`、超时返回 `waitReason: 'timeout'` / `willWake: false` / 同 `gateId` 且门禁仍 pending、`gate.timeout` 事件、收尾后 `waiting` 为空、冷恢复只写一次 `flow.gate.recovered`、追问超时后点选仍落盘并唤醒、重复点选 409；G40-13 ~ G40-17 专门钉住上限的真源是工作区配置——默认 10 分钟、`setWorkspaceGateWaitMinutes` 的 1 / 25 / 60 三档、`0` / 负数 / 越界一律回落、布尔与空串与非数字串不冒充最小值、`view.gateWait` 的四个字段。没有这一组，把 `gateWaitMs` 里读配置那行换成固定 `60000`，前两组照样全绿），`test/client.test.mjs` 新增 7 项（三种来路文案、提示条、追问卡片、设置面板保存与恢复默认），`test/integration.test.mjs` 的配置键断言补上 `gateWaitMinutes`。
  后续收紧：`gateWaitPayload` 只认 `outcome.self`——`gates.wait` 的每个工具侧结果由 `awaitGate` 统一附上「自己那一次」的请求，`gateWaitPayload` 是唯一消费点；它不再回退读盘上的 `gateRequested`（被新等待取代时盘上写的已是取代者的请求，读盘会把新 id 报给旧调用、还会误报 `willWake`），`self` 缺失或 id 非字符串直接抛显式错误，`willWake` 在中断分支恒为 `false`（这次等待已收尾，等待器即使挂着也属于取代者），`kind` 不是 timeout/aborted/superseded 也直接抛——四条工具侧调用路径只有这三类会走进中断分支，别的 `kind` 深进去只会产出说假话的文案。配套用例：`test/host.test.mjs` 的 G40-18 ~ G40-20 用宿主路径把两次 `flowgate_doc` 撞在一起，断言旧调用收到 `decision: 'pending'`、`waitReason: 'superseded'`、`willWake: false`、`gateId` 是自己那次的 id（与盘上新请求的 id 不同）、文案说明「被新的等待取代」且「不会叫醒你」。

- **发布脚本没有版本闸门：忘了升 `version` 会生成同名 tgz，静默验证旧代码**：起因是 `scripts/publish.mjs` 唯一的防线是一句收尾提醒——「下次改代码后要重新发布，记得先把 package.json 的 version 往上加，否则文件名不变，pnpm 会认为没有变化而跳过解压」。它靠人记住，而忘了不会有任何报错：`npm pack` 照常生成 `dsh-flowgate-<version>.tgz`，同名文件被直接覆盖，脚本退出码 0、输出一切正常、profile 也被改成了新路径，于是「装上了」与「还是旧内容」在日志里长得一模一样。这和运行版本不可观测是同一个循环的两端：一边看不出跑的是哪一版，一边让「发布」这个动作本身可能什么也没做，两者叠加时任何「已验证通过」的结论都不可信。
  新增 `scripts/publish-gate.mjs`（纯函数模块，无 IO 副作用）承载判定：`parseVersion` / `compareVersions` 按数值而非字典序比较（`0.1.10` 高于 `0.1.9`，prerelease 小于同号正式版），`parsePackageFileName` 同时认旧式 `<name>-0.1.7.tgz` 与带戳 `<name>-0.1.7-20261126T1000.tgz`（可带 `-2` 序号），scoped 包名按 `npm pack` 的写法也认（`@scope/pkg` 写成 `scope-pkg-<version>.tgz`）——只认 `package.json` 里的原文的话，scoped 仓库里闸门永远匹配不上，每次都判首发放行，`maxExistingVersion` 只从文件名解析、不看 mtime，`evaluateVersionGate` 给出 `first-release` / `bumped` / `forced` / `not-bumped` / `invalid-version` 五种结论。`formatTimestamp` 精确到分钟且重复加戳不叠加，`uniqueFileName` 在同一分钟重复发布时追加 `-2`、`-3`，`sha256File` / `fingerprintLines` 出指纹。
  `scripts/publish.mjs` 从三步变四步：`[1/4]` 版本闸门、`[2/4]` 自测、`[3/4]` 打包到发布目录、`[4/4]` 更新 profile 依赖声明。闸门排在自测**之前**——忘了升版本时在第一步就停下并 `exit(1)`，不会先花几分钟跑完测试再生成一个和上次同名的包。放行分支分别打印「按首发放行」「X 高于已有最大版本 Y，放行」「`--force`：跳过版本递增检查，仍然继续」（`--force` 跳过的是「必须递增」这条检查，版本本来就更新的场合也会走到这里，所以文案不能写死「不高于」），中止分支打印「版本未递增，已中止发布：package.json 是 X，发布目录里已有最大版本 Y」并要求确需重发时加 `--force`。打包后把 `npm pack` 的产物改名为带时间戳的新名字（冲突时追加序号，旧包原样保留）：先复制成 `<文件名>.incoming` 再 `renameSync` 到位，中途失败只留一个 `.incoming` 临时文件（`finally` 里清掉），不会在发布目录留下「文件名合法、内容不完整」的半包——闸门与 profile 都只认文件名，半包一旦留在那里就会被下次发布当成已有最大版本，而它恰恰是唯一的回退路径。随后打印本次包的 sha256 供人工核对——指纹只作对照，不参与「要不要重发」的判断。`--skip-test` 跳不过闸门，`--no-profile`、`FLOWGATE_PKG_DIR`、`FLOWGATE_PROFILE_DIR` 的既有契约不变。错误路径也都给了显式文案：profile 的 `package.json` 读不了或顶层不是对象时报「读不了 <路径>」并 `exit(1)`，同时打出已打好的包路径与手动接法，不甩 `SyntaxError` 裸栈；发布目录指向普通文件时报「读不了发布目录」，不甩 `ENOTDIR`；版本本来就高于已有最大版本时再加 `--force`，会多打一句「这次没派上用场」——否则这个参数是被接受还是被忽略，两次输出一字不差。`--no-profile` 与「找不到 profile」两种情况下 profile 一个字都没改，收尾就不再叫人 `cd` 进 profile 跑 `pnpm install`（依赖声明还指着旧包，照做只会装回旧版），改为明说「profile 没有改动」。参数这一层也不猜：拼错的 flag（比如少一个字母的 `--no-profil`）直接报「不认识的参数」并列出可用参数后 `exit(1)`——静默忽略的话脚本会照默认去改写 profile，而用户以为只是打了个「只打包」的命令。profile 的 `dependencies` 必须是普通对象：是数组时赋值不报错、但 `JSON.stringify` 只序列化索引项，写回去的文件里根本没有这条依赖，脚本却会打印「old -> spec」并叫你去 `pnpm install`，所以这里也显式中止并报「dependencies 不是对象」。收尾列包是第二次读发布目录，同样包了显式文案，不会在包已打好、profile 可能已改完之后甩一句 `ENOENT` 裸栈让人以为整次发布失败。`dsh.profile.bundles` 只在确实是数组时才谈得上「含不含」：写成字符串时 `includes` 会做子串匹配，`other,dsh-flowgate` 或 `dsh-flowgate-extra` 都会让这条检查静默通过，所以这里按「不是数组」明说无法确认，不靠子串蒙混。
  测试：新增 `test/publish.test.mjs`，26 项覆盖版本解析与比较、新旧两种包名、最大版本不看 mtime、首次 / 递增 / 未递增 / `--force` 四种放行结论、时间戳精确到分钟与重复加戳不叠加、版本号自带时间戳形 prerelease 时不被当成上一轮加的时间戳剥掉、同分钟追加序号，以及九个端到端用例（版本未递增时退出码非 0 且发布目录与 profile 一字未动、`--skip-test` 跳不过闸门、`--force` 成功时新包名匹配 `<version>-YYYYMMDDTHHMM.tgz` 且 profile 指向新包、发布目录指向普通文件时恰以 1 退出且不甩调用栈、拼错的参数与 `dependencies` 非对象时显式中止、版本本来就高于已有最大版本时再加 `--force` 会多打一句「这次没派上用场」而版本没变时不打、profile 目录里没有 `package.json` 时跳过而不是失败且不叫人去 `pnpm install`、`--force` 把版本降到比发布目录最大版本更低时照放行但明说 profile 会被指向一个更旧的包、发布目录建不出来时报「建不了发布目录」而不甩 `EACCES` / `ENOTDIR` 裸栈）。指纹那一条不只断言「输出里有个 64 位十六进制串」，而是拿这个包的 `sha256File` 结果去比对——否则把摘要换成任何常量，用例照样全过。该套件已接进 `npm test` 的汇总：`scripts/run-tests.mjs` 末尾按「`test/publish.test.mjs` 是否存在」条件接入 publish 套件——真实工作副本里它存在，汇总里就多一行 `publish=PASS`；`test/test-runner.test.mjs` 的 fixture 只复制 `scripts/` 与 `lib/`、不复制 `test/`，那里仍是原来十套，汇总行数与顺序不受影响。这条条件本身也有用例钉住（真实汇总里有 publish、fixture 里没有）。
  文档：`docs/development.md` 的「发布到 `file:` 安装」整节重写，补上四条命令（默认、`--skip-test`、`--no-profile`、`--force`）、闸门排在自测之前的理由，以及必须记住的八点（版本不递增就发布不了、确需重发加 `--force`、包名带时间戳、sha256 只供人工核对、`--no-profile` 时 profile 一个字都不动、出错时说清是哪个文件、旧包即回退路径、流程数据不在插件目录）；安装方式对照表与发布示例的 tgz 文件名同步改成带时间戳的形式。同步升到 0.1.7。

- **`test/host.test.mjs` 的版本断言不再钉死具体版本号**：它曾写死 `assert.equal(status0.version, '0.1.5')`，而同一个用例的上一行已经在跟 `package.json` 的 `version` 比——升到 `0.1.6` 之后这两条互相矛盾，host 套件从此一直红着，每次跑全套都要多花一次人工判断「这是不是本次改动弄坏的」。钉死版本号的断言本身也是错的：它把「读到了旧版本」和「根本没读盘」一起断言成通过，还逼着每次升版本都去改测试。现在只跟 `package.json` 比，再校验形状（`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`），升版本不用再跟着改测试。

- **评审发现必须带证据，「核实过」与「没核实」在重做清单里分开**：起因是评审报告里的发现只有一句结论、没有任何可核对的东西，于是「核实过」和「没核实」在重做清单里长得一模一样——评审就退化成有概率编造的第二个意见，而「评审通过了」还会被当成事实。发现现在必须写 `kind`（`defect` / `design`）和 `evidence`（该文件源码里真实出现的标识符，不是自由描述）；缺陷另需正整数 `line` 与 `repro.when/expected/actual`（期望与实际必须不同），设计问题另需 `basis.quote`（源码里逐字存在的一行）与 `basis.conflict`；`CRITICAL` / `MAJOR` 另需 `counter.attempt` 与 `counter.survived: true`，写明尝试反驳后仍成立。
  `reviewTool` 的 schema 用 `allOf` + `if/then` 表达条件必填，但容许单条发现先不完整地进入执行阶段——否则一份混着合格与不合格发现的报告会被宿主整体拒绝，合格条目跟着一起丢掉。完整性由 `checkFinding` 逐条执行，`flowgate_review` 与子代理 `flowgate_review_run` 共用这一个校验器；缺字段的条目单独存进 `angle.rejectedFindings`（只记索引、严重度与缺项，不回显原文），同角度的合格条目照常保留。
  文件读不到、标识符不在源码里、行号越界或引文对不上时，发现保留原严重度但标 `unverified`，并给出 `unverifiedReason`。未核实项计入 `counts.unverified` / `counts.unverifiedSevere`，不算阻断项、不进重做清单、只作提示。角度内所有发现都未核实、或有 `CRITICAL` / `MAJOR` 因缺字段被丢弃时，门禁拒绝普通通过；`skip` 全未核实角度会记录 `flow.review.skippedUnverified`。
  子代理自己写的 `verdict` 不再被覆盖：`angle.verdict` 存按已核实发现推导的值，声明值与推导值不一致时用 `angle.verdictConflict` 并列保存两者、界面同时显示，复用角度不重复报告旧冲突。
  界面：发现条目下可折叠查看依据（kind、证据位置、复现三件套或设计依据、反驳记录），未核实与冲突各有徽标，门禁的评审快捷报告新增「因缺少证据被丢弃」一节。`counts` 新增两个键后老快照会缺键，渲染改为逐键兜底合并，避免汇总行拼出「未归属 undefined」。
  测试：`test/provenance.test.mjs` 覆盖未核实与阻断分离计数，`test/subagents.test.mjs` 覆盖手工与子代理两条路径给出相同缺项清单，`test/gatemode.test.mjs` 覆盖全未核实 / 部分未核实 / 严重项被丢弃的门禁行为，`test/host.test.mjs` 覆盖非字符串嵌套字段不写入快照。同步升到 0.1.5。

- **插件代码与运行插件隔离：改用 `file:` 装打包好的 tgz，发布交给 `scripts/publish.mjs`**：起因是排查一次耗时 4 小时的流程——用户报的原话是「用有 bug 的守卫去修这个守卫，这个确实是个问题，那有没有办法代码和插件隔离开呢？等我需要安装的时候才安装过来」。desktop profile 原本用 `link:D:/Projects/dsh-flowgate`，开发目录就是运行目录，保存即生效；而那次流程本身就在改命令判定与 scope 规则，于是改动一边落地一边生效，改错时正常调用也被自己的半成品规则拦下（`node --version && npm --version`、`npm run test:subagents 2>&1 | grep ...`、`git -c core.whitespace=cr-at-eol diff --check HEAD` 三次被拒，理由都是「重定向 / 管道 / 解释器内联」）。
  新增 `scripts/publish.mjs`：跑 `npm test`、`npm pack --pack-destination` 直接生成到发布目录（默认 `D:/Plugins/flowgate-pkg`）、把 profile 的 `dependencies["dsh-flowgate"]` 改成 `file:<tgz 绝对路径>`，并列出发布目录里最近的几个包作为回退选项。它**不执行 `pnpm install`、不重启 DSH**——安装时机留给用户，避免「测完就自动换掉运行版本」。支持 `--skip-test`、`--no-profile`，目录可用 `FLOWGATE_PKG_DIR` / `FLOWGATE_PROFILE_DIR` 覆盖。
  `test/install.test.mjs` 放宽为同时接受 `link:` 与 `file:`：原「profile 的 dependencies 用 link: 指向本仓库」断言（`spec.startsWith('link:')` 加 `realpathSync` 相等）与「node_modules 里已链到本仓库」（`realpathSync(linkedDir) === realpathSync(ROOT)`）把「不隔离」写成了硬约束，换安装方式必然失败。现在改为核对「依赖 spec 以 `link:` 或 `file:` 开头且指向的路径存在」与「安装目录里 package.json 存在」。同时把该测试的检查对象统一到**安装副本**（`installedDir`）：原先 `lib/index.js` 与 `cordis.patch.yml` 读的是 `ROOT`，与其余读安装副本的断言混在一起，两份内容分家后会产生「项目是新的、装的是旧的」这类看起来像代码缺陷的报错，而它其实只是还没发布。工作副本与安装副本版本不一致时只打印一句提示，不参与判定——否则 S4 的 `npm test` 会因为发布节奏失败，正好再造一个死循环。
  文档：`README.md` 安装节补一句开发本插件时为何用 `file:`，`docs/development.md` 的「修改代码后如何生效」改成两种安装方式的对照表并新增「发布到 `file:` 安装」一节（含版本号必须先加、旧包即回退路径、流程数据不在插件目录三点）。

- **命令判定看到的必须是完整命令：换行算分隔符，清单条目还要绑执行目录**：用户报的原话是「命令判定看到的不是完整命令：漏了换行，也不看它在哪个目录下跑」。两处缺陷。一是换行没被当成命令分隔符：`SHELL_ESCAPE_HINTS` 的字符类里只有 `|;&`$<>`，没有 `\r` / `\n`，而 shell 把换行当命令分隔；`stripHarmlessSuffixes` 之后只剥输出收尾，第二条命令原样跟着走；前缀通配 `pattern.endsWith('*')` 只比开头，后面的换行与第二条命令完全不参与判断；`normalizePendingScope` 用同一个正则校验清单条目，所以带换行的条目甚至能被写进清单。二是命令授权不绑工作目录：`shellDenial` 只取 `args.command`，`scopeCommandMatches` 只比 `head.name` 与 `rest`，`working_directory` 挂在 `PASSIVE_TOOLS` 里任何阶段都能 `cd` 到任意目录，`cd` 拦截只存在于子代理通道。合起来就是「清单里批准 `npm run *`，`npm run build` + 换行 + `rm -rf src` 一次调用完成，审计流水只记一条」，而撤销授权与事后追责都依赖这条绑定。
  换行在入口单独判。`shellDenial` 拿到命令先看有没有换行或回车，命中就写一条 `multiline` 审计事件并直接拒绝，理由点名换行而不是混进「重定向 / 管道」里——理由指错分隔符，用户会以为去掉管道就能过。子代理通道的 `readonlyDenial` 用同一条断言，`normalizePendingScope` 也给含换行的条目单独报错文案。`SHELL_ESCAPE_HINTS` 的字符类同时补上 `\r\n`，让 `SHELL_READONLY` / `SHELL_GIT_BRANCH` / `SHELL_PARSE_ONLY` 这几条尾部只接受空格与制表符的白名单也真正只认单行。
  执行目录进清单。条目可以带方括号后缀 `npm run build [packages/web]`，`parseScopeCommand` 拆出命令与目录（`normalizeScopeDir` 只接受流程根之内的相对目录，绝对路径、盘符、`..` 一律判无效），`scopeCommandEntry` 负责拼回原样；没带后缀的条目等价于 `[.]`，只认流程根。`scopeCommandMatches` 新增 `cwd` 参数，先算 `commandDirKey(flow.cwd, cwd)` 再逐条比目录，**精确匹配**——子目录要另写一条，不给「目录前缀覆盖」留口子。`exec.cwd` 从 `pre-execute` 一路传进 `scopeDenial`、`shellDenial`、`scopeCommandMatches`，子代理通道的 `childDenial` 闭包捕获子会话 `header.cwd`，与主 Agent 同一套规则。判定用的目录还要看 shell 工具自己的参数：`shellWorkdir` 取 `workdir` / `cwd` 里第一个非空值（`dir` 不认——它在不同工具里不保证是执行目录，认它会让「按一个实际不生效的目录命中条目」变成误放），相对会话目录解析成 `execCwd`，`shellDenial` 的换行、逃逸、只读白名单、清单命中与审计全部改用这个目录——`ops_bash({ command, workdir })` 里真正决定跑哪个程序的是 `workdir`，只看 `header.cwd` 等于把目录绑定原样交回给调用方。子代理通道同样接上：`childDenial` 的 `scopeShell` 闭包多接一个 `workdir`，`readonlyDenial` 把 `shellWorkdir(args)` 传进去。测试另补 `test/host.test.mjs` 的 workdir 用例（`.`, 流程根、`packages/web`、绝对子目录、`tmpdir()`）、`test/subagents.test.mjs` 子会话 `ops_bash({ command, workdir })` 用例，以及 `test/integration.test.mjs` 的 workdir 审计断言。审计事件 `detail.dir` 与待补队列条目 `dir` 都记下执行目录；补进清单时按 `scopeCommandEntry` 拼回后缀，用户看到的就是「在哪个目录跑什么」。`working_directory` 从 `PASSIVE_TOOLS` 的放行里单独摘出来：S2 / S4 的 `cd` 目标必须仍在流程根之内（含子目录），根外直接拒，S1 / S3 维持原样。
  界面把目录一起摆出来：清单、待补、已明确不补三处渲染统一走 `scopeEntryDir`，带后缀的条目补一句「仅限 packages/web 目录内执行」，说明文案改成「没有后缀的条目只认流程根目录——同一条命令换个目录跑的是另一个程序，所以目录也一起批准」。`BROAD_COMMAND` 先剥后缀再判，`node * [.]` 洗不成合规条目。
  测试：`test/host.test.mjs` 新增 AC-1 ~ AC-6（换行命令四阶段全拒、带后缀条目剥后缀后仍按前缀通配、S1 提交含换行的条目被拒、无后缀条目只在流程根放行、带 `[packages/web]` 只在该目录精确匹配、S2 / S4 的 `working_directory` 只能在流程根内换目录），`test/integration.test.mjs` 新增审计流水与待补队列都记执行目录、命令带 `workdir` 时按 `workdir` 判定且两次审计分别记子目录与流程根、补进清单自动带后缀三项，`test/subagents.test.mjs` 新增子代理与主 Agent 同一套目录规则（含子会话带 `workdir` 的两向断言），`test/client.test.mjs` 新增带目录条目补一句执行目录，`test/acceptance.test.mjs` 补 `npm * [.]`、`node * [packages/web]`、`* [packages/web]` 仍算超宽。文档同步 `docs/development.md` 五处、`docs/verification.md` 新增一节、`README.md` 一句。

- **桌面端能自己开 CDP 了，界面验证不再只能靠手工点**：用户问「这个插件做测试经常遇到实机没办法走，或者 ui 没办法实测，这种有办法解决吗？我应该装什么插件或者做什么设置能解决呢？」。查下来卡点不是缺工具，而是**开不出调试端口**：给 `[DSH].exe` 传 `--remote-debugging-port` 会报 `bad option` 后秒退。扫二进制确认这个字符串来自 Node 解释器的参数解析（邻近 `node.cc:260`），而环境里正好有 `ELECTRON_RUN_AS_NODE=1`——它让 Electron 二进制退化成纯 Node 进程，调试端口参数于是成了非法参数。启动子进程前删掉该变量（连同 `DSH_NODE_EXECUTABLE`、`ELECTRON_NO_ATTACH_CONSOLE`）就能正常起。
  新增 `scripts/start-cdp.mjs`：`--port`（默认 9222）/ `--exe` / `--profile`（默认 `.dsh-flowgate/cdp-profile`）/ `--timeout` / `--dry-run` / `--help`，全中文帮助。可执行文件按 `.exe` 后缀加排除 `uninstall` 查找——安装目录里的文件名带方括号，用通配符拼路径会被 shell 当 glob 解析。端口已就绪时只探测报告、不重复启动，所以它同时是个「CDP 在不在」的探针。`package.json` 加了 `npm run cdp`。
  `docs/capture-ui.mjs` 支持复用模式。Electron 不支持 `Target.createTarget`，`PUT /json/new` 返回 HTTP 500 / `Not supported`，原实现直接抛错退出，所以这个脚本在桌面端从来没跑通过。现在优先新建标签，失败则复用已有 page target 并记下原地址，结束时导航回去；关闭标签只在真的新建过时执行。复用会丢掉那个窗口里未保存的输入，脚本头注释与 `docs/development.md` 都写明要指向 `start-cdp.mjs` 起的临时实例。`package.json` 加了 `npm run ui` 与 `npm run ui:verify`，`check` 里补上两个新脚本的 `node --check`。
  顺带修掉三处早就过时的断言（与本次改造无关，是改组件时漏改的）：启动请求已不带 `summary`（整理稿由宿主在启动时生成）、「当前流程」卡片显示原文且没有 `fg-requirement-original` 节点、规则弹窗里已没有新增表单的复选框。修之前两处必错（`Cannot read properties of undefined (reading 'startsWith')`、`Cannot read properties of null (reading 'click')`），修之后 Electron（复用）与 headless Chrome 157（新建标签）两条路径都是 130 个场景 / 260 次布局快照 / 652 项检查，无脚本异常、无横向溢出、无布局失败，原有标签保持不变。
  验证：`node docs/verify-layout.mjs` 连真实桌面端页面返回 `runtime.status: "verified"`，`hostRevision` 与磁盘一致、`clientRevision` 与期望一致，viewport 1280×820，退出码 0——**版本核对链路第一次在真机上跑通**。`npm run check` 与 `npm test`（九套 763 项）全通过。真实门禁元素的视觉取证仍未执行：当前没有未完成流程，取不到门禁元素，`inspectLayout` 在无 sessionId 时按设计返回 `uncovered`。

- **补命令清单从「随时能加一条」改成「门禁上二选一」**：用户报的原话是「开发过程发现有命令清单需要加，会有一个【查看】按钮，点进去看到命令之后再点击单独加这个命令到这个清单，但是好像任何时候都可以加这个命令进去清单」。根因是补清单被做成了「点一下按钮就把这条命令塞进草稿」的随手操作：`reopenScopeForCommands` 接受任意命令原文，快捷条和「开发变更」「测试命令」卡片都挂着入口，于是「哪条命令该不该授权」这个本该由用户在有上下文时决定的事，退化成 Agent 说一句、用户点一下。同一件事还会被点很多次：`flow.lastDeniedCommand` 是单值字段，开发期间连拒三条命令只能记住最后一条。
  现在被拒的命令先入队，不直接进清单。`shellDenial` 只在 S2 / S4 且命令确实被拒时调 `rememberDeniedCommand`，写进 `flow.pendingCommands`（`{ command, reason, stage, at }`，去重、按 `SCOPE_COMMAND_MAX` 封顶、跨阶段保留，直到用户决定）；单值的 `flow.lastDeniedCommand` 与视图字段 `deniedCommand` 一并删除，`repairFlow` 清洗旧快照里的残留。拒绝文案也换了口径：说明「已记进待补清单」，并明确要求 Agent 在用户决定前不要换别的写法再试一次——那只会多出一条待补命令，不会让这条命令跑起来。
  决定发生在门禁出口，只给两个按钮。`gateBlockers` 拆成两层：外层在待补队列非空时往最前面插一条阻塞项（所以 S1 / S2 / S3 / S4 四个出口都会停下来），内层 `stageGateBlockers` 保持原有三阶段逻辑不变。工作台门禁卡新增 `CommandGapDecision`：逐条列出被拒命令、默认全选、可去掉不想授权的那条，然后「补进清单并重新批准」或「不补，继续」（后者还要二次确认，因为它会写进结项账本）。补走 `supplementScopeCommands`：只接受队列里的命令原文（`resolveChosenCommands` 逐条核对，传队列外命令直接拒），追加进草稿、退回 S1、按新清单重算验收方案缺口；auto 档位下「补」不会把用户选的模式悄悄改回 manual——重算后无缺口就当场冻结并记 `auto: true`，有缺口则自然挂在 S1 门禁上。不补走新增的 `declineScopeCommands`：记进 `flow.declinedCommands`（同一条不再重复弹窗）、清空队列、照常推进，这些命令之后仍然被拒，依赖它们的验收标准在 S3 / S4 账本里记成未覆盖。
  界面随之收口：`CommandAccess` 变成只读展示（清单原文 + 待补列表 + 已明确不补的列表，并说明「补不补在右侧门禁卡上决定」），「查看 scope 问题」里的「只补这条命令」按钮删除，只留「重做文档（回 S1）」与待补命令的说明。`awaitGate` 把 `commands-decided` 也当作「继续重判」的信号——队列空了阻塞项就没了，auto 该当场放行。
  测试：`test/host.test.mjs` 的「变更性 shell 在 S2 被拒」改断言「已记进待补清单」与「不要换别的写法再试一次」，新增「被拒命令进待补队列，供门禁二选一」（断言队列内容与 `stage`、且 `deniedCommand` 字段已不存在），S4 与清单外命令两处文案断言同步改写，「流程结束后视图不再有授权字段」补上两个队列为空，验收方案缺口组改成先让命令真的被拒再补；`test/client.test.mjs` 把「被拒命令给出退回 S1 补清单的入口」整段换成三项——「被拒命令在门禁上给出补 / 不补二选一」（断言命令原文、补的代价、不补的后果，点「补进清单并重新批准」提交 `reopenScopeForCommands` 且 `payload.commands` 只含被拒的那条）、「点「不补」先要确认，确认后才提交 declineScopeCommands」、「取消勾选后只补剩下的那条，按钮文案跟着变」。九套测试 763 项全通过（内容快照 20 / 验收账本 35 / 运行版本 18 / 宿主 319 / 门禁模式 10 / 子代理 74 / 集成 33 / 客户端 237 / 安装 17），`stamp-revisions.mjs --check` 输出 `Module revisions verified (7 modules).`。文档同步：`README.md` 两处、`docs/development.md` 四处把「只补这条命令」「退回 S1 补命令清单」改成门禁二选一。

- **快捷入口要能做完工作台能做的事；S1 的验收方案缺口不再让用户点「接受」**：用户报的原话是「点【批准并冻结 scope】，下方提示我这份 scope 有 2 条验收方案缺口，除此以外毫无动静，我是不是没法进行下去了？」。根因不在按钮失灵，而在缺口被放在了错误的位置：`flowgate_doc` 的 `scopeReadiness` 只把 `blockers` 当拒收条件，`risks` 写进 `pendingScopeRisks` 后照常挂门禁，于是「缺测试命令」「验证步骤点名 scope 外文件」这类该由 Agent 补齐的返工，变成了要用户点「确认接受缺口」才能往前走的一步。用户要的是「快捷入口能看缺口」而不是「用户替 Agent 接受缺口」。
  提交侧现在把 `risks` 也当场退回，文案明确要求 Agent 自己补 scope，不要拿给用户。退回按缺口签名（缺口 `code` 去重排序拼接）计数，同一批缺口连续三次就 `cancelFlow` 结束流程——不这么做，Agent 会一遍遍重交同一份 scope，用户等一个永远不来的按钮。计数与上一轮的缺口原文存在 `flow.scopeRiskStrikes` / `flow.scopeRiskLast`，视图对应 `doc.scopeRiskStrikes` / `doc.scopeRiskLast`，提交成功或从冻结态退回补命令清单时一起归零；`decideDoc` 的 `acceptScopeRisks` 路径保留（冷恢复与旧客户端仍可用），但正常流程走不到了。
  按钮层面按用户逐条要求改：S2 删「跳过门禁直接评审」——`gateValidation` 对 S2 不校验产物，跳过与通过只差一个阶段标记，留着只让人以为省掉了什么；S2 的「回到需求分析调整 scope」改成「查看 scope 问题」并就地展开，与命令被拒的提示合进同一个框，按原因给「只补这条命令」（保留文档、追加命令、按新清单重算缺口）与「重做文档（回 S1）」两个出口；S3 与 S4 删掉「退回说明」输入框——`rollbackTo` 的 `remediationList` 早就按未通过项生成了修复清单，让用户再打一段字既非必填也无处消费；S4 无缺口时只留「结束流程」，有缺口时给「结束流程（需确认）」与「退回开发修复」，前者就地摊开缺口清单再确认，「跳过测试门禁」整条删除（它照样要过缺口校验，结果还比「结束流程」更差，记为 `closure.kind = 'skipped'`）。
  dock 快捷条补上工作台已有的能力：修改需求的意见输入、缺口确认区、scope 问题框、S4 的账本行与缺口清单，全部就地展开，不再因为「那一排按钮摆不下」把能力留在工作台里。
  测试：`test/host.test.mjs` 的缺口组重写为「提交即退回」并新增 `sess-scope-strike` 三振组（三次提交的文案、`finished`、`cancelReason`、两个字段归零）；`test/client.test.mjs` 的 S2/S4 按钮集合、置灰断言、带缺口结束文案、「退回开发不再要求用户写说明」全部按新语义改写；`test/gatemode.test.mjs` 三条依赖「缺口停在门禁卡」的用例改用全人工核验的 AC 造阻塞；`test/integration.test.mjs` 的 `sess-proof` 用例补上测试命令与测试文件。九套测试 758 项全通过（内容快照 20 / 验收账本 35 / 运行版本 18 / 宿主 318 / 门禁模式 10 / 子代理 74 / 集成 33 / 客户端 233 / 安装 17），`stamp-revisions.mjs --check` 输出 `Module revisions verified (7 modules).`。
  `lib/index.js`、`test/host.test.mjs`、`test/integration.test.mjs` 是历史混合行尾（CRLF 与 LF 并存），这次改到的段落被编辑器写成 CRLF，所以这三个文件的 diff 行数比逻辑改动多出一截；仓库没有 `.gitattributes`，`core.autocrlf` 未设置，行尾不参与校验。

- **门禁按钮可点，不等于 Agent 还在等**：门禁等待挂在工具调用上，工具超时、宿主重启或被新的等待取代时等待器就没了（`GateHub.wait` 收到 abort 会 `finish({ kind: 'aborted' })`），而产物已经落地，所以按钮继续可点。这个解耦本身是对的——不然一次工具超时就永久剥夺了用户的批准权。错的是配套的两半都没做到位。
  一半在 Agent 侧：中断时 `flowgate_doc` 返回的原话是「用户仍可在工作台点『批准并冻结 scope』；确认后读取 flowgate_status 就能看到最新阶段」，等于告诉它「你不用停，用户会自己批，之后读状态跟上就行」；`flowgate_gate` 只说了句「门禁还在等待用户操作」。于是出现用户描述的那个场景：按钮已经亮了，Agent 还在自顾自往下做，用户一边批、它一边推进。现在两个工具的中断返回统一成「停下来等确认」，明确要求不要继续做后续阶段的工作、也不要假设已经通过；用户点按钮后宿主补一条唤醒消息，Agent 从 `flowgate_status` 接着走。
  另一半在宿主侧，是四处会真正卡死的地方。一是 `awaitGate` 挂起前不看本阶段门禁是否已经决策，用户如果在中断窗口里点过，它仍会挂到一个按钮永远不会再出现的阶段上——`timeoutMs = 0`，没有超时，Agent 会一直卡到工具调用结束。现在挂起前核对 `expectedStage` 与 `record.gate !== 'pending'`，发现已经推进或已决策就返回 `stale`。二是 `gateTool` 的 S2 分支：`collectChanges` 最长有 10 秒的 await 窗口，返回后照写 `flow.devChanges` 与 `flow.snapshot` 并照常挂门禁，不重新看阶段；用户在窗口里点「完成开发」会把阶段推进到 S3，于是 Agent 以 S3 身份挂起、而 S3 的门禁按钮要等评审报告才出现——同样卡死。现在采集回来先比对阶段，变了就丢弃这次摘要并返回 `stale`。三是 `doc.interrupted` 的判据少了 `gateRequested === true`，与 `gate.interrupted` 不一致，文档刚写完、还没进 `awaitGate` 的瞬间也会被标成「已中断」。四是 `gateTool` 既没有阶段保护，也不看本阶段有没有产物：站在 S3 还没交评审报告、或 S4 还没交测试报告时调用它，它照样挂起——而这两个阶段的门禁按钮要等报告交上来才出现，Agent 又卡在一个不会来的按钮上。现在挂起前先看 `gateArtifactReady`，没有产物就当场返回 `stale`，并说清该先去交哪份报告。
  界面上那行提示也从「上次的门禁请求被中断，仍可直接确认」改成「Agent 已停下等你确认：上次的门禁请求被中断了……现在点按钮不会和它抢着推进」——说清按钮可点的理由，而不是让人以为 Agent 还在后台跑。
  测试：`test/host.test.mjs` 新增「采集窗口里点门禁：阶段照常推进到 S3」「采集回来发现阶段已经变了：返回 stale，不再挂到一个没有按钮的阶段上」「撞车后停在 S3，开发摘要仍是上一轮那份」「撞车不写第二条 dev.summary」「本阶段还没有产物就调用门禁：当场返回 stale，不挂起」五项（用可挂起的 shell 替身把采集停住，真实复现撞车），并把「门禁调用中断后返回 wait」扩写成同时断言「停下来等确认」且不再出现旧的「门禁还在等待用户操作」；`test/client.test.mjs` 的门禁中断用例补断言「Agent 已停下等你确认」。

- **批准被拒之后，缺口清单要立刻出现在界面上**：验收方案缺口不是「拦一下就完」的东西——它得让用户看见、看见之后能确认接受。此前这条路会在两个地方断掉。一是 `decideDoc` 冻结前会重算一遍体检（草稿可能来自旧版本或冷恢复），算出缺口后只把它写进 409 的报错文本，没有写回 `flow.pendingScopeRisks`；而工作台是否弹确认区只看这个字段，于是服务端一直说有缺口、界面一直显示没有，用户反复点「批准」只看到红字，那个能确认缺口的按钮永远不出现。现在拒绝之前先把这次的重算结果写回状态并落盘，任何路径造成的不一致都会在下一次拒绝时被纠正。二是「退回 S1 补命令清单」把 `pendingScopeRisks` 直接清成空数组，但文档还挂着、`pending` 仍为真，界面于是认为没缺口、直接发批准请求，服务端又重算又拒——死循环的另外半边。现在改成按新清单重算：清单变了旧结论作废，但作废不等于归零，补一条无关命令不会让「验证步骤点名 scope 外文件」这类缺口消失。第三处补在客户端：`act` 失败后除了留下错误文案，还补拉一次 `/state`，否则服务端已经写回的状态要等用户手动刷新页面才能看见。
  测试：`test/host.test.mjs` 在验收方案缺口用例块里补「被拒之后界面能拿到缺口清单」「退回 S1 补命令后缺口按新清单重算，不会凭空清空」与「缺口补掉后补命令，重算不会凭空造出缺口」三项；`test/client.test.mjs` 新增「被拒之后自动补拉状态，按钮改口提示要确认缺口」与「补拉之后点一次就能展开确认区」（断言宿主拒绝后确实多发了一次状态请求、按钮文案变成带确认提示的版本、展开确认区不再发请求）。

- **体检顺着一层依赖往下查，S1 就把跑不起来的命令挑出来**：上一版补了 `command-runtime-missing`，但只看清单里每条命令的首个 token。`npm` 本身就是个 node 程序、`composer` 是个 php 程序、`prove` 是个 perl 程序——包管理器在、解释器不在的机器上，首 token 查得到，命令照样跑不起来，而用户此时已经批过 scope 了。
  登记表每条生态现在多一个 `needs` 字段，写清「这个名字必须先有谁才能跑起来」：`npm` / `pnpm` / `yarn` / `npx` / `corepack` → `node`，`composer` → `php`，`pip` / `pip3` / `poetry` / `uv` / `pipenv` / `hatch` / `pdm` → `python` / `python3` / `py`，`bundle` / `bundler` / `gem` / `rake` → `ruby`，`mvn` / `gradle` / `gradlew` / `mvnw` → `java`，`prove` / `cpanm` / `carton` → `perl`，`luarocks` → `lua`，`cargo` → `rustc`，`mix` → `elixir`；`go`、`dotnet`、`deno`、shell、PowerShell、`cmd`、`make` 自包含，留空。体检顺着查一层，缺了并进同一条缺口，文案点名缺的是哪一层：「`npm` 在，但它需要的 `node` 不在」。依赖写成候选列表（`python` / `python3` / `py`、`lua` / `luajit`），任一存在即通过——Windows 上只有 `py` 启动器的机器不该被判成缺依赖，候选列表里漏了 `py` 就会把它判成缺依赖。未登记的名字返回空列表，不猜。
  同一处还修了带目录写法的解析：`./gradlew`、`tools/node` 这类相对路径此前按宿主进程的 cwd 查，而 cwd 不一定是仓库根，于是清单里明明写对的相对路径被报成「找不到」。现在相对路径相对仓库根解析（`resolveExecutable` 接受调用方传入的 `cwd`，`projectProfile` 把仓库根传下去），绝对路径仍原样 `existsSync`。
  静态体检管不到的那半交给 S1 的版本探测：`node --version`、`php --version` 这类命令属于只读白名单，任何阶段都放行，`flowgate_doc` 的工具描述现在要求提交 scope 前对清单里每个工具跑一次，跑不通就把绝对路径或替代方案写进清单，别带着一条跑不了的命令去批准——批准之后 S2 第一次构建就当场失败，而那时候用户已经批过了。绝对路径的探测（`C:/…/node.exe --version`）不在只读白名单里，S1 会被拒；所以探测用裸名，报「找不到」恰好说明该把绝对路径写进清单，交给 S2 按清单放行。
  测试：`test/acceptance.test.mjs` 新增「每个生态都登记了「它靠谁才能跑」：包管理器指向解释器，自包含的留空」（逐条核对 16 个生态的 `needs`、`corepack` 归到 `node`、`python` 三候选、正斜杠与反斜杠与带引号三种写法的归一化、未登记名字返回空）、「带目录的写法相对仓库根解析：宿主进程 cwd 不是仓库根时也不误报」（相对路径按传入 cwd 解析、换 cwd 就找不到、绝对路径不走 cwd、空 token 不猜）与「工具在、它依赖的解释器不在时照样报缺口，并点名缺的是哪一层」（只产出一条缺口、`npm` 缺 `node` 与 `uv` 缺三候选 `python` 的文案、候选任一存在即通过、首 token 也不在时不再顺依赖查且命令不重复记、未声明生态跳过）；`test/host.test.mjs` 的追问纪律用例补上 `flowgate_doc` 描述里版本探测要求的断言（含「跑不通就把绝对路径或替代方案写进清单」）。

- **命令能不能跑，不再靠四份各自为政的名单猜**：此前「这个解释器叫什么、能不能内联执行、算不算测试命令」分散在四段写死的正则里——`SHELL_READONLY` 只认 `node --version` / `npm --version`，`SHELL_PARSE_ONLY` 只认 `node --check` / `tsc --noEmit`，逃逸检查的内联名单是 16 个名字，验收体检的 `TEST_COMMAND` / `BROAD_COMMAND` 又是一份。加一个语言要改四处，改漏一处不会有任何报错：实测 `php -r 'unlink(...)'` 能执行任意代码，却因为 php 根本不在名单里而一路放行；非 JS 项目在 S1 连 `php --version` 都跑不了。
  现在收敛成一张登记表 `lib/ecosystems.js`，每条生态记录解释器名、包管理器名、标志文件、内联标志、纯解析标志、版本探测参数与测试命令片段，上面四处名单全部从它派生。已登记 Node.js、Deno、Python、PHP、Go、Rust、Java、.NET、Ruby、Elixir、Perl、Lua、Shell、PowerShell、Windows 命令解释器、Make / CMake。新增生态只改这一处，由插件代码维护，不暴露成用户配置项——用户判断不了「本项目的解释器算不算登记过」，让他勾选只会变成另一种照勾。`PARSE_ONLY` 刻意不含 `perl -c` / `ruby -c`：`-c` 同时是内联标志，逃逸检查先于它执行，放进来也不会生效，只会让规则看起来自相矛盾。
  同时补上**可执行性体检** `command-runtime-missing`：S1 提交 scope 时对每条命令取首个 token，若该名字属于登记表、且仓库里确实声明了对应生态（`markers` 命中），就用宿主进程的 PATH 与 `PATHEXT` 解析它是否存在，绝对路径则直接 `existsSync`。找不到就记一条缺口，提示把绝对路径写进清单或先装好它。这条针对的是实测踩到的坑：裸 `node test/x.mjs` 通过了 S1 体检、在门禁上被批准，到 S2 才被 shell 自己以 127 拒绝——两次都发生在用户已经批过 scope 之后。刻意收窄两处：只核对仓库里声明过的生态（空目录里写 `node test/x.mjs` 无从判断，跳过比误报有用），只取首个 token（`npm` 在而它拉起的 `node` 不在仍查不出来）。用风险码而不是阻塞项，是因为它不该拦住流程；但 `fast` 档的自动通过会把风险一起算进门禁项，所以它一定会停在门禁卡上被看见一次。
  另一处实测踩坑是**清单与执行的可执行体写法不一致**：清单里写 `node test/host.test.mjs`，机器上跑的是 `C:\...\node.exe test/host.test.mjs`，同一条命令只因为路径写法不同就被判成「清单外」，测试一条都放行不了。`scopeCommandMatches` 现在按登记过的可执行名归一化后再比参数；没登记的名字仍按原文精确比较，否则任意同名脚本都能借用清单里的授权。
  测试：新增 `test/acceptance.test.mjs` 的「清单写对了但机器上没有这个可执行体时给出缺口，仓库没声明该生态就不误报」（含找得到时不报、不传 `project` 时整条检查不参与的对照）；`test/host.test.mjs` 新增「版本探测与语法检查按生态放行，内联执行一律拒」（`php --version`、`python --version`、`command -v php`、`php -l`、`bash -n` 放行，`php -r`、`pwsh -Command` 拒绝），并把「S2 清单内命令不需要开关就放行」扩写成含解释器身份归一化的断言（清单写裸 `node`、实际跑带盘符的 `node.exe` 放行，换参数则拒）。九套测试（provenance 20 / acceptance 32 / runtime 18 / host 315 / gatemode 10 / subagents 74 / integration 33 / client 231 / install 17）全部通过，`stamp-revisions.mjs --check` 与各模块语法检查通过。

- **需求分析不能问一句就收工：追问纪律从提示词变成提交门槛**：此前 S1 的追问是「建议」——`flowgate_ask` 的描述只说「一次只问一个问题」，`flowgate_doc` 对「到底问出了什么」一无所知，于是 Agent 问一个不痛不痒的问题就能提交需求文档，模糊表述、隐含假设和关键取舍全部原样进入开发，直到 S3 评审或 S4 测试才炸。
  现在 `flowgate_doc` 的参数契约加了三份必填清单：`decisions`（已经问定的事项，每条 `{ question, answer }`）、`assumptions`（没问、由 Agent 自行补全的前提）、`open_questions`（还没问清的问题），三者与 `html`、`scope` 并列进入 `required`，`additionalProperties` 仍为 `false`——旧调用方不补齐会在参数校验层直接报错，而不是被静默当成「没追问也算过」。提交前由新增的 `grillReadiness(decisions, assumptions, openQuestions)` 硬校验，三条阻塞各自点名：`open-questions-remain`（未决问题非空，逐条列出并说明「需求文档不是记录待定的地方」）、`incomplete-decision`（某条决策缺 `question` 或 `answer`，看不出问了什么定了什么）、`nothing-clarified`（`decisions` 与 `assumptions` 同时为空，说明这次根本没澄清）。三条都是拒绝提交，不是记一条风险放行——风险提示挡不住「差不多了」的判断。
  提示词侧同步收口：`BUILTIN_ANALYSIS_RULES` 新增 `grill-until-agreed`（「追问到共识再动手」），`fast` 档的 `analysisRules` 显式加入该 id（它是显式列表，不加就不生效；`strict` 走全量 `map` 自动包含）；`flowgate_ask` 的描述改为一次解决一个分歧、答完接着问下一个，明确「没把握的写进 `assumptions`，问不清的留 `open_questions` 继续问」；`flowgate_start` 的返回消息与 S1 唤醒消息都补上「问一句就收工不算做完 S1」。三份清单随文档一起落进 `flow.doc.grill`，`doc.submitted` 事件记录决策与假设条数。
  测试：`test/host.test.mjs`、`test/integration.test.mjs`、`test/gatemode.test.mjs` 的夹具统一在 `flowgate_doc` 调用处注入一份默认追问清单（`withGrill` / `GRILL`），`test/subagents.test.mjs` 的黑盒调用内联补齐，避免 55 处调用点逐个改写；`test/acceptance.test.mjs` 新增 `grillReadiness` 的三条阻塞与通过路径用例，`test/host.test.mjs` 在 S1 段新增三条拒绝文案与 `flow.doc.grill` 落盘的用例。

- **权限不再由用户勾选：命令清单是唯一通道**：此前要跑构建或测试，用户得在 S2「开发变更」或 S4「测试命令」卡片里勾「允许执行构建/测试命令」，测试方向还要先「声明需要写权限」、再在 S4 逐个方向勾「授权执行变更性命令」。三处勾选全是空转：用户不知道自己要什么权限，Agent 说一句「需要授权」他就会照勾，勾完的责任却落在他身上。而 S1 批准 `scope.commands` 时，清单和验收标准是摆在一起看的——那一次才是真正有上下文的授权。
  现在放行只有一个来源：需求文档里那份已批准的 `scope.commands`。`shellGrant`、`writeGrants`、`needsWrite`、`directionWriteDeclared` 四个字段从数据模型删除，`toggleShellGrant`、`toggleWriteGrant`、`declareDirectionWrite` 三个 hub 动作一并移除（调用会得到「未知操作」），`repairFlow` 负责清洗旧快照里的残留字段，`hydrate` 再把清洗结果写回磁盘——否则文件里一直留着 `shellGrant: true`，读的人分不清它还算不算数。冷恢复因此不再涉及任何「重新授权」。
  清单写漏时唯一的出口是补清单，不是临时放行：`shellDenial` 拒绝时把命令原文记进 `flow.lastDeniedCommand`（截断到 300 字），视图新增 `deniedCommand`，工作台在「开发变更」「测试命令」卡片和快捷入口里显示被拒命令，并给出「退回 S1 补命令清单」按钮；它调新增的 `reopenScopeForCommands`，带着那条命令退回 S1、预填进清单草稿，用户确认后重新批准，代价是本轮评审与测试要重跑。界面把这条代价写在按钮旁边。
  界面随之退场：`ShellGrantToggle` 换成 `CommandAccess`（只列清单原文、被拒命令与补清单入口，没有任何勾选框）；测试方向面板删掉整段写权限分支，改为一句「测试方向只决定验证什么，不决定能执行什么」；追加自定义方向表单与工作区规则 S4 组里的写权限勾选框一并删除。测试子代理的 `childDenial` 改用当前流程的 `scope.commands` 判定，`registerChild` 不再携带任何权限位。
  测试：`test/client.test.mjs` 的写权限用例整段换成「S2 不再提供命令授权勾选框，只说明清单放行」「S4 命令入口只列 scope 清单，不给勾选」「被拒命令给出退回 S1 补清单的入口」「测试方向面板不再出现写权限声明与授权」；`test/host.test.mjs` 把授权开关的放行/撤销/跨阶段持久用例换成「清单外的构建命令被拒，没有可勾选的授权通道」「旧快照里的授权字段冷恢复后被清洗」；`test/subagents.test.mjs` 把方向级写权限例外换成「S4 子代理只看 scope 清单：清单内放行、清单外一律拒」。九套测试（provenance 20 / acceptance 30 / runtime 18 / host 310 / gatemode 10 / subagents 74 / integration 33 / client 231 / install 17）全部通过，`stamp-revisions.mjs --check` 与各模块语法检查通过。
- **「0 个问题」却点不了通过：证据版本被环境算进快照 id**：实测一次流程在 S4 显示 15 个测试要点全通过，界面上却没有任何通过按钮，用户最后只能「放弃这次流程」。根因是三处叠加：
  一是**快照 id 把运行环境也算进了内容指纹**。`currentSnapshot` 把 `hostRevision` / `diskHostRevision` 塞进 `rules`，`captureSnapshot` 再把 `rules` 一起 digest——重载插件、重新生成模块 revision 这类与代码无关的动作都会换掉快照 id，而两份快照里 11 个文件的内容哈希一字未变。现在 `lib/provenance.js` 的快照格式升到 `version: 2`，运行环境不参与 digest；宿主可信度仍由 `runtimeState()` 经 `runtime.status` 单独报告，不参与内容比对。
  二是**提交测试时不校验 AC 证据的 `version`**。`flowgate_test` 自己算出内容快照却不回传 id，schema 只让 Agent「抄 state.snapshot.id」；抄到的旧评审快照 id（`99655dc8…`）与测试时的快照（`99ac5244…`）不一致，12 条 `pass` 被 `acceptanceLedger` 静默判成 `uncovered`。现在 `version` 改为可选：留空由工具在提交时刻盖当前快照 id；显式写了别的版本则原样保留，绝不替它补盖——把「对着旧代码测的」改写成「对着新代码测的」是伪造证据，照实记旧版本，账本据此判未覆盖并给出原因。
  三是**规则变化被当成代码变化**。S4 里勾一个测试方向会让快照 id 变，于是评审被判「已变化」，用户只能退回 S2 重做一遍评审，而代码一行没动。新增 `sameCode` 只比文件路径与哈希，S4 检查评审是否失效时改用它；报错文案相应改为「评审后代码已变化」。快照不完整（文件读不到）时仍然拦。
  门禁口径另有两处纠偏：**`skip` 不再是免检通道**（`gateValidation` 里 S4 的 `skip` 原本直接 `return null`，于是「跳过测试门禁」比「验收通过」还容易过，有缺口时前者一点就走、后者反被拦）；现在跳过与通过共用一套校验，缺口必须同样由 `acceptUncovered: true` 显式接受，`waitTestGate` / `waitReviewGate` 也把 `outcome` 透传给 `passGate`，阶段记录成 `skipped`、缺口原样留账本。**放弃流程不再抹掉 `scope.data`**（原本重置成 `data: null`，`acceptance_criteria` 随之消失，账本归零后反而显示「0 条 · 验收通过」），现在只清 `frozen` 等授权字段。
  界面随之收口：结项按钮文案统一成一个短词「结束流程」（原为「验收通过，结束流程」/「接受未覆盖并结束」/「接受未通过项并结束」三种长句，按钮上放不下，缺口细节本来就该写在旁边的账本行里），确认按钮改为「确认结束流程」；有缺口时门禁面板不再显示「跳过测试门禁」，快捷入口那排也不再生成一键结束。快捷入口的提示行改为**始终并排显示两本账**（「验收标准：通过 X · 未通过 Y · 未覆盖 Z · 待验证 W；测试要点：通过 A · 失败 B · 未覆盖 C · 环境受限 D」）——此前那行只数测试要点，15 个要点全 `pass` 就显示「0 失败 / 0 未覆盖 / 0 受限」，而同一份报告里 12 条 AC 一条没通过，正是这次「看起来 0 个问题却点不了通过」的直接来源。报告入口按钮只写名字：「评审报告」「测试报告」，数字交给旁边的账本行，给以后的按钮留位置。
  测试：`test/subagents.test.mjs` 的降级夹具与 `test/host.test.mjs` 的跳门禁用例改为显式接受缺口，新增「S4 只加测试方向不算代码变化，已通过的评审仍然有效」取代原来的「规则改变后评审快照失效」，并在已冻结 scope 的放弃用例里补上「取消已冻结的流程后验收标准仍在账本里，不归零」（原先那条 `scope.data === null` 的断言用的是没冻结过 scope 的流程，没有区分力）；`test/client.test.mjs` 的按钮与提示行断言同步到新文案。九套测试（provenance / acceptance / runtime / host / gatemode / subagents / integration / client / install）全部通过，`stamp-revisions.mjs --check` 与各模块语法检查通过。

- **只整理标题，取消需求描述整理**：此前的 `/hub/prepare` 一次生成标题与「需求整理稿」两份文本，整理稿还要逐条做「数字、URL、路径、错误码必须全部出自原文」的保真校验，任一不满足就整次调用失败，连标题一起丢掉、退化成原文首行截断——用户看到的标题几乎总是首行前 40 字，等于没整理。现在只生成标题：`lib/requirements.js` 删掉 `formatRequirement`、`MAX_SUMMARY_CHARS`、`assertLiteralFidelity` 及其路径扫描辅助函数，`SYSTEM_PROMPT` 改为「会话标题生成器」口径（4 到 12 字名词短语、单行、不超过 24 字、不复述首句、不出现「需求」「整理」等元词），模型只被要求输出一个 `title` 字段，返回后统一经 `sanitizeTitle` 收口（去 Markdown 前缀与引号书名号、去句末标点、折叠空白、超长截断）。数据模型同步收窄：`createFlow` 不再接受 `summary`，快照与 `/hub/flows`、`flowgate_status`、`/hub/prepare` 响应都只带 `brief` 与 `title`，旧快照里残留的 `summary` 在读盘时直接丢弃。标题期限收紧到宿主 6 秒、客户端 9 秒，超时或失败静默回落到原文首个非空行派生的标题，照常启动。**原文保真改由数据模型保证**：`brief` 逐字保存用户输入，`title` 只是界面短名，S1 到 S4 的分析只读 `brief`，两者不一致时一律以原文为准。`flowgate_start` 的参数 schema 同时删掉 `summary` 并维持 `additionalProperties: false`：旧调用方仍传 `summary` 会在参数校验层直接报错，而不是被静默忽略——`createFlow` 自身会忽略多余字段，两层口径不同，接入方需删掉该参数。
- **「修改需求」先填意见再提交**：工作台的「修改需求」此前点一下就提交，`doc.revised` 事件的 detail 是空的，唤醒消息却写着「按用户意见改」——意见从来没被采集过，Agent 只能反问用户想改什么。现在按钮先展开一个修改意见输入框（`aria-label` 为「修改意见」），空意见不提交并就地提示「请先写清楚要改什么，再提交修改意见。」；提交后备注原文随 `doc` 动作的 `revisionNote` 送到宿主，落进 `flow.doc.revisionNote` 与 `doc.revised` 事件的 `detail.note`，并原样写进唤醒消息（没填则明确告知 Agent 先问清楚，不要自己猜）。修改需求不冻结 scope，因此不再被「验收方案缺口」的二次确认拦住。
- **会话内快捷开始需求分析**：所有有效会话的输入框上方流程提示卡常驻「开始需求分析」按钮，点击打开原文与档位输入弹窗，支持 Ctrl/Cmd+Enter。草稿、提交锁及失败原因按会话保留，成功后清空；已有工作区流程时仅允许编辑草稿并提示，不替换原流程。弹窗使用浏览器顶层、焦点约束与随视口收缩的内部滚动布局；真实页面视觉测量需另行取证。
- **内容变化使整轮旧结论失效**：回退后比较内容哈希；内容变化、缺少指纹或采集不完整时整轮重评重测，替代下文历史的文件名集合及 finding 文件启发式复用。
- **逐 AC 保存验证证据**：每条验收标准记录 `method / procedure / status / evidence / version`，实现完成、验证完成和运行生效分别说明；MINOR 完整计数与 AC 状态独立，零阻断不再等同于逐 AC 通过。
- **快速档不再截断前三条发现**：仅默认角度/方向较少，界面可折叠前三条；每角度 200 条存储安全上限之外的收到计数由 `omittedCounts` 单独保留严重度与阻断合计。此条替代下文旧的 `FAST_FINDING_CAP` 行为。
- **退回携带修复输入**：保存并传递本轮发现的位置、严重度、AC 与问题描述，以及失败、未覆盖和环境受限的验证要点，避免退回后丢失修复清单。
- **运行生效需要版本证据**：实际具名客户端工厂 `factory.toString()` 的 SHA256 与宿主磁盘工厂字串对比；宿主已加载模块版本与磁盘版本另行对比。任何缺失、未核对或不匹配均不能宣称生效。宿主已加载模块使用各自登记的 `FLOWGATE_MODULE_REVISION` 字面量，修改模块后运行 `node scripts/stamp-revisions.mjs` 更新，再用 `--check` 只读核验；不能以磁盘扫描冒充已加载版本。
- **新增现有桌面端布局取证脚本**：[verify-layout.mjs](docs/verify-layout.mjs) 要求显式提供已有 CDP、真实页面和真实任务条/目标条选择器，只调用异步布局诊断 API 并输出 JSON，可用 `--out` 保存证据。仅此维护脚本要求 Node >=22，无新增依赖；不启动窗口、服务或绕过认证。缺少认证接入的真实视觉校验为未覆盖，显式接受例外也不改成通过。文件预览与脚本自检不证明真实 GUI 已验证。

以下较早条目保留开发历史；涉及发现截断与复用策略时，以上述新契约为准。

- **评审发现按验收标准归口，scope 显式声明影响面**：此前评审把一轮开发里所有能挑出来的问题平铺进重做清单，实测同一轮评出 22 条发现，其中一条改的是 scope 外的文件、根本不在这次允许动的范围里，却照样被列进「重做输入」，退回 S2 也修不掉，回退就成了无底洞。现在分三处收口：
  一是 **scope 新增 `shared_contracts`**（本次会动的共用契约与已知约束，也就是影响面），随需求文档一起给用户过目、一起批准、一起冻结进 `scope.json`，`flowgate_status` 里逐条列出，界面上与文件白名单并排展示——没有它，评审只能按文件白名单猜边界，越界发现自然泛滥。
  二是 **发现必须挂上验收标准**（`ac` 字段指向 `acceptance_criteria` 里的 id）：只有「严重度非 `MINOR` + 挂得上验收标准 + 文件在 `in_scope.files_expected_to_change` 内」三条同时成立才计入 `blocking`，其余降级成 advisory 只作提示，不进重做清单；`flowgate_review` 与 `flowgate_review_run` 都按这条判定，门禁文案与评审卡片都会点明「另有 N 条只作提示」。scope 外发现仍然单独回报，且照样算「范围没划够」——升级档位时它会把你送回 S1 调 scope，而不是回 S2 白重做一轮。
  三是 **`fast` 档单角度最多 3 条发现**（`FAST_FINDING_CAP`），按 `CRITICAL` > `MAJOR` > `MINOR` 取最重要的几条，被截掉的条数写一条 `MINOR` 留痕，避免一个角度刷出几十条把报告注满。`strict` 档维持原上限。
  评审子代理的提示词也一并改了：明确 `in_scope.shared_contracts` 就是本次允许触及的影响面，要求在 JSON 里带上 `ac`，并说明不设无限条数的理由。`test/host.test.mjs` 新增 7 条断言（影响面随 scope 进待批准清单、冻结进 `scope.json` 并写进状态摘要、`fast` 档截断与留痕、归属口径、scope 外发现单独回报、退回文案、子代理提示词）；`test/client.test.mjs` 新增 2 条（S2 展示影响面、S3 展示归属徽标与仅提示条数）。

- **自动生成标题与整理改为点击启动时一次生成**：此前启动表单在输入停下 800ms 后就请求 `/hub/prepare`，把模型结果渲染成只读标题、可折叠的「查看整理稿预览」、一个「重新生成标题与整理稿」按钮和「已自动生成 / 本地整理」状态行，用户填需求时视线被这些与需求无关的生成内容反复打断。现在表单只剩需求原文与档位：输入过程中不发任何整理请求，也不展示标题、预览、重新生成按钮或状态文案；点击「开始需求分析」时才用 15 秒期限调用一次 `/hub/prepare`（比宿主自身的 12 秒多留余量，让宿主先自己收网并给出降级结果），把返回的标题与整理稿直接放进 `start` 请求，由进入流程后的详情页与工作区当前流程卡片展示。整理超时或失败时静默回落到需求原文派生的标题与排版，照常启动、不报错、按钮不卡；请求带可中止的 `signal`，换不到会话时立即收掉在飞的整理请求，不再白占一次模型。重复点击仍靠在途标记幂等，超 20000 字符照旧禁用启动且不发请求。`test/client.test.mjs` 相应调整：新增输入期不发请求、点击后结果进 payload、失败静默回落三条；`docs/capture-ui.mjs` 的截图流程改为填需求后直接启动并断言 prepare 请求带原始原文。

- **命令授权只在该勾的时候勾**：此前所有变更性 shell 都只有一个开关——「允许执行构建/测试命令」，于是每轮都要先勾一次授权才能跑构建或测试（两轮实测里 fast 等了 11 分 47 秒、strict 等了 12 分 49 秒，且用户往往不知道该不该勾）。现在分三层收口：
  一是**纯解析命令**（`node --check`、`tsc --noEmit`）进 `SHELL_PARSE_ONLY`，它们不执行仓库代码，任何阶段都放行、不需要授权；
  二是 scope 新增 `commands` 字段（`in_scope.commands`），随需求文档一起给用户过目、一起批准，`S2` / `S4` 里命中即放行，末尾 `*` 做前缀通配；
  三是阶段授权开关降级为**清单外的兜底**，界面文案在 scope 列过命令时直接说明「这些命令不需要这个开关」。
  阶段闸门不变：`S1` 与 `S3` 即使清单命中也不放行任何变更性命令。命令清单本身也要收敛——提交时去空白、去重、单条截断 300 字、最多 20 条，太长就等于空白授权。
  同时补上**shell 审计**：每条判定都写 `shell.allowed` / `shell.denied` 事件到 `flows.jsonl`，`detail` 带命令原文（截断 200 字并标 `truncated`）、`outcome`（`allowed` / `denied` / `escape`）与 `reason`。此前流水里只有开关本身的 `shell.granted` / `shell.revoked`，没有任何一条命令原文，出问题查不到这一轮跑了什么——放宽白名单之前必须先有这张账。
  `test/host.test.mjs` 新增 6 条断言（A 档放行与夹带逃逸、清单规范化、S2 清单放行与清单外拒绝、审计流水、S1/S3 闸门、前缀通配边界）；`test/client.test.mjs` 新增 3 条（批准前展示命令清单、无清单时说明仍需授权、S4 开关说明清单内命令不需要它）。

- **命令授权在流程内持久**：此前「允许执行构建/测试命令」的授权只在当阶段有效，阶段推进、回退都会清掉，于是从 S2 进 S4 要重勾一次、S4 退回 S2 又要重勾一次，实测一次 fast 流程里光是等用户重新授权就花了 11 分 47 秒。现在一次授权在本次流程内一直有效：`passGate` 只在流程结束时清 `shellGrant`（不再在每次推进后无条件清零），`rollbackTo` 只清 `writeGrants`、保留 `shellGrant`。放行仍然按阶段判定，`shellDenial` 的 `(S2 || S4) && shellGrant` 是唯一放行条件——S1 与 S3 里即使授权为真也只接受只读命令，评审阶段不会因为带着 S2 的授权就跑起构建。清除路径收敛到四条：用户主动取消勾选、放弃流程、验收通过结束流程、冷恢复（`hydrate` / `repairFlow`）。界面文案同步改掉「只在当前阶段有效」的说法，「测试方向写权限」那句也不再提「重启 DSH 后需重新授权」以外的失效条件。`test/host.test.mjs` 相应调整：`离开 S2 后命令授权自动失效` 改成 AC1（进 S3 仍为 true）、补 AC2（带授权进 S4 直接放行）、AC3（回退保留 shellGrant 但 `writeGrants` 仍清空）、AC4（授权为真在 S3 仍拒）、AC6（放弃 / 流程结束两路清除）、AC7（源码里不再出现旧文案）。

- **启动表单只填需求原文**：此前启动流程要填「任务标题」和「需求整理稿」两个框，用户得先自己想标题、再手改整理稿，
  而这两项本来就能由需求原文派生。现在表单只保留「需求描述」一个必填框，标题与整理稿在输入时自动生成、只读展示
  （`fg-start-title` 与可折叠的「查看整理稿预览」），并保留「重新生成标题与整理稿」按钮。自动生成只影响显示：
  S1 唤醒消息、`flowgate_status` 输出与 `flowgate_start` 的工具描述都明确写出「需求分析以需求原文为唯一依据，
  整理稿不替代原文，两者不一致时以原文为准」。去掉了 `titleManual` / `summaryManual` 那层「手改后锁定」逻辑，
  迟到响应仍不能覆盖更新的原文；`createFlow` 在 `summary` 为空白时按 `brief` 重新整理。
  `test/client.test.mjs` 相应调整：断言表单只有一个 textarea、不存在标题输入框，乱序用例改为验证迟到的旧响应不覆盖新稿、
  重新生成会让在途响应失效并同时刷新两个字段。
- **工作台页面记忆**：此前切到别的会话再点侧栏进入「流程工作台」，面板重新挂载、状态全部重置，总是回到首页。
  现在面板把位置记在 `localStorage` 的 `dsh-flowgate.hub.memory.v1`：当前工作区目录、展开的流程 `sessionId`、
  以及流程记录分页，重新挂载时据此恢复——先按目录进工作区页，再在列表（含「继续流程」那条）里按 `sessionId` 找回详情。
  记忆里的目录已从名单移除时回首页，不会停在「目录不可用」；主动点「工作区列表」后记忆也跟着回到首页。
  存储不可用（隐私模式、被策略禁用、配额满）时读写都静默失效，面板照常工作，异常不冒到界面。
  `test/client.test.mjs` 增加三组用例：详情/工作区页/列表页三级恢复、目录失效回首页、存储抛错时照常显示。

- **退回只回退一次**：点「退回开发修复」时退回有两条通道——门禁工具自己的返回值，以及工具被中断后宿主补发的排队 user 消息。两者同时到达时，Agent 跑完当前轮又收到一次退回，把刚重做的产物清掉，用户看到的就是「输入框上方排队发送的退回语句，跑完又退回一次」。现在两层收口：
  一是 `rollbackTo` 幂等，同一目标阶段在 10 秒内重复触发只记一条 `flow.rollback.skipped` 事件并直接返回，不再二次重置阶段产物；判定必须同时满足 `flow.stage === stage`，否则推进到后续阶段后的正常回退会被误挡。
  二是补发消息改成状态通知：`gateWakeText` 明确写出「决策已经落地，不要再次回退，也不要重新提交上一个门禁的产物」，退回分支文案由「用户退回到 X 重做」改为「退回已经生效，当前在 X 重做」，避免 Agent 把它读成新的回退指令。
  `test/host.test.mjs` 增加断言：等待器在场时不补发排队消息（`cx.delivered` 长度不变）、退回后 `decision` 为 `reject`、重复退回只留 `flow.rollback.skipped` 事件。

- **需求整理保真校验补上单反斜杠盘根路径**：`\资料\测试.md` 这类以单个反斜杠开头的 Windows 盘根相对路径此前完全不被识别——
  `isPath` 的绝对路径分支要求 `\\`（UNC）或正斜杠，未加引号扫描的两个 pattern 同样只认 `\\` 与 `/`。
  结果是原文写了该路径、模型整理稿把它丢掉或换成别的路径时，`assertLiteralFidelity` 根本没有可比的路径，
  校验通过、不回退，用户拿到的是残缺整理稿。现在补第三分支：单个反斜杠开头、后接至少一段、以扩展名结尾
  （`\资料\测试.md`、`\测试.md`）；`\\` 仍按 UNC 处理，`\d+` 这类正则转义不会误判为路径。
  归一化沿用现有规则，`\资料\测试.md` 与 `/资料/测试.md` 视为等价；丢掉开头反斜杠（`资料\测试.md`）会降级回原文。
  `test/host.test.mjs` 增加 6 条对应用例，覆盖删除、替换、原样保留、丢开头反斜杠、与正斜杠等价以及带引号的单段盘根文件。

- **回退支持部分重跑**：此前回退到 S2 会把 S3/S4 的结论一并清空，改动只碰了一处也要整轮重评重测（实测每次 20 分钟以上）。现在回退时把上一轮结论存进 `flow.carryOver`，状态里按本轮改动文件逐条判定「可复用 / 需重跑」：角度看 finding 的 `file` 是否被本轮改到，测试方向按改动文件集合是否与上一轮一致整体判定。复用入口三处——`flowgate_review` 的 `reusedAngles`、`flowgate_test` 的 `reusedDirections`，以及 `flowgate_review_run` / `flowgate_test_run` 的默认自动复用（传 `reuse: false` 强制全量）。复用后该条从清单摘除，同一轮既复用又重报会直接报错，避免重复计入。界面在评审/测试卡片上标「N 项复用上轮」。
- **测试要点支持显式排除环境受限项**：`flowgate_test` 的结果新增 `excluded`，必须配 `excludeReason`；只标 excluded 不给原因按 `uncovered` 处理。此前这类要点永远停在未覆盖，看起来像漏测。`test/host.test.mjs` 覆盖回退后可复用清单、`reusedAngles` 复用、缺 `excludeReason` 报错与带原因计数四项。

- **S3 评审改为一次性全量边界枚举**：此前评审子代理只写「边界条件与错误路径」，实际容易发现一处就报一处，
  同一函数里其余没被覆盖的分支留在报告外。现在 `anglePrompt` 统一追加「全量枚举协议」：先从变更摘要列出被改函数
  （摘要只有文件时按文件内全部导出函数算），再按固定矩阵逐格判定——输入形态（带引号引用 / 普通引用 / 未引用）、
  字符集（ASCII / Unicode）、路径形态（正斜杠 / 反斜杠 / UNC / 盘根 / 相对路径 / 混合分隔符）、长度（空串 / 单字符 /
  典型值 / 正好上限 / 上限 + 1 / 远超上限）与 null、空白、尾随分隔符、`.` / `..`、大小写等边界；每格标
  covered / missing / n/a 并给 file:line，输出前自检格子总数守恒。全部 missing 一次性写进 findings，
  一条一个分支，summary 以 `[函数 · 分支]` 开头；findings 不设条数上限，禁止合并、省略或按严重度分批。
  `flowgate_review` 的工具描述同步要求手动提交也遵守同一协议。
  `test/subagents.test.mjs` 增加断言：正确性角度的提示词必须包含全量枚举、三种引用形态、Unicode、UNC、盘根与长度上限。

- **四阶段工作区规则统一编辑**：需求分析、开发规则、评审角度、测试方向共用一个草稿弹窗。区分内置、已自定义内置与新增条目，可对照内置原文、逐项或逐阶段恢复；保存时原子提交全部修改，取消不落盘。配置版本 2 兼容原有 S2 默认，部分恢复保留其他阶段；状态、分析提示与评审/测试执行统一使用有效配置，测试写权限仍单独授权；方向停用、删除或改为只读时撤销旧授权，重启后需重新勾选。
- **需求自动生成标题与整理稿**：输入后先提供基础标题与排版，停止输入后复用现有模型整理目标和要求；手动修改、过期响应与跨工作区草稿均有保护。整理失败可重试或直接启动。原文独立保留，进行中、详情与历史以整理稿展示，旧记录继续兼容。长中文需求的路径保真检查按完整候选扫描；模型准备、流读取与结果校验共用 12 秒期限，超期中止并回退本地稿。

- **兼容 DSH 0.2.2-rc.5：`engines.dsh` 改成版本范围**：原来写死精确版本 `0.2.2-rc.3`，宿主升到 rc.5 后准入判定不满足，preflight 把插件行标成 `disabled`，只在 stderr 留一句 `disabling profile plugin ...`——界面与工具全部消失，看起来像插件坏了。现在声明 `>=0.2.2-rc.3 <0.3.0-0`：接受 0.2.2 全系（含 rc.3、rc.5 与后续 0.2.x），挡住 0.1.x 与 0.3.0。下界保留 prerelease、上界写成 `-0` 都是必须的，否则会分别拒绝 rc 版本、放行 0.3.0-rc。
  `dsh.compatibility.dsh` 同步为同一范围，`dshReleases` 补记 rc.5。已按 rc.5 官方源码逐个核对用到的契约：`subagents.startActivation` / `getProvider` / `prepareContinuable` / `delivery`、`tools.guard`、`tools/pre-execute`、`agents.get` 与 `agent.followup`、`sidebar.panellist` 与 `main` 插槽、`uiWorkspace`（`pickDirectory` / `openSession` / `connectWorkspace`）、`workspaces.create({ path })` —— 签名与 rc.3 一致，无需改调用方式。
  `lib/index.js` 的子代理能力探测不再把宿主版本号写进报错，改为指出缺少哪个接口。`test/install.test.mjs` 内置一份最小 semver 判定，与宿主的 `semver.satisfies(..., { includePrerelease: true })` 同规则，把「必须是范围」「覆盖 0.2.2 全系」「挡住 0.1.x 与 0.3.0」「商城口径与引擎声明一致」钉成 4 项断言，防止以后又改回精确版本。

- **新增左侧栏「流程工作台」，从空名单起步**：此前只能进到某个会话里看那条流程，跨项目的情况得挨个会话翻。
  现在左侧图标列多一个入口，第一次打开是**空的**——面板不替你把磁盘上的项目翻一遍，只认你自己加过的那些。
  两个添加入口：**「添加目录…」** 调起宿主目录选择器（`ctx.uiWorkspace.pickDirectory()`），选中的目录若还不是工作区就用
  `workspaces.create({ path })` 自动登记（宿主侧幂等，重复选同一目录不会重复登记）；**「添加工作区」** 列出宿主里已有但还没加进名单的，点一个即可。
  添加的那一刻顺手把这个工作区的任务与规则读出来：**已添加：导入 3 条任务、2 条规则（含自定义 1 条）**。
  规则与任务仍留在各自工作区的 `.dsh-flowgate/`，面板只读来展示，**不复制、不改写**。
  名单是用户级的（不属于任何工作区），存 `<DSH_FLOWGATE_HOME | ~/.dsh-flowgate>/hub.json`，只记 `path` 与 `addedAt`；
  「移除」只从名单拿掉，不删任何流程或配置。
  新增三条路由：`POST /api/flowgate/hub/members`（读名单 + 每个成员的摘要）、`POST /hub/add`（校验绝对路径与存在性后登记）、
  `POST /hub/remove`；原有的 `POST /api/flowgate/hub`（body `{ paths: [dir] }`，按绝对路径去重、非法条目丢弃）改为详情态单目录使用。
  面板仍是**全局面板**，不绑定会话，但每条流程都带着 `sessionId`（来自磁盘快照），所以门禁确认、退回修复、改规则、追加范围这些按会话投递的动作
  面板自己就能发；要看对话本身时点 **「打开会话」**，调 `ctx.uiWorkspace.openSession(sessionId)` 跳过去。
  上一版曾在文档里断言「宿主没有跨插件打开会话的公共 API、`UiWorkspaceService` 是内部局部常量」，那是错的：
  `UiWorkspaceService` 构造函数里 `super(ctx, 'uiWorkspace')`，是公开的 cordis 服务，相关文档已更正。
  服务全部用 `ctx.get` 软取，不写进 `exports.inject`：本插件可能先于 `ui-workspace` 激活；缺 `workspaces` 时「添加工作区」没有候选（只剩「添加目录…」可用），
  缺 `uiWorkspace` 时选目录不弹、打开会话提示从左侧栏进入，插件其余部分照常工作。`workspaces.list` 改为在 `main` 的 inject factory
  首次运行时取（面板挂载时），避免 apply 阶段拿到空值。

  `test/client.test.mjs` 的面板测试按新交互重写（18 项）：空名单时工作台为空且不把宿主工作区摊出来、两个添加入口、
  「添加工作区」只列还没加过的、选中后登记进名单、添加后顺手导入任务与规则、详情列出任务并说明规则跟工作区走、
  展开详情、「打开会话」带上正确 sessionId、面板内写需求并启动、换不到会话时不发请求、选目录先登记成工作区再进名单、
  取消不登记、移除只改名单、名单读取失败有提示。
  `test/integration.test.mjs` 增加 3 项 hub 用例（拒绝非法路径、按工作区返回摘要、重复路径去重），路由断言改为 6 条。

- **入口收敛到左侧栏，会话区不再重复**：会话视图的「本次流程」标签与输入框上方的常驻状态条都已删除，`apply` 现在只注册
  `sidebar.panellist`（图标）与 `main`（面板本体）两个插槽。流程的全部操作（看产物、确认门禁、退回修复、改规则、开始新流程）搬进
  面板详情内嵌的同一个工作台组件——会话视图那个 `WorkbenchView` 改名为 `FlowDetail` 并去掉标题头与侧栏折叠，通过
  `exports.components.FlowDetail` 导出供单测直接渲染（面板里由 `HubPanel` 内嵌，不再有独立插槽）。
  宿主侧栏只有 264–420px，`.fg-hub-flow` 把原来三列（阶段导航 / 产物 / 门禁设置）压成单列：阶段导航横排、阶段名缩到 11px、
  门禁与设置依次向下，进度条加边框独立成块。同时删掉 `.fg-dock`、`.fg-welcome` 两组样式与对应的 dock 测试块。
  面板不属于任何会话，但**第一条流程也能在面板里开**：详情态把 `StartPanel` 的 `sessionId` 换成 `resolveSession`，
  点开始时才走 `hubActions.sessionForWorkspace(path)`——按 `path` 从 `workspaces.list` 找到 `workspaceId`，
  再用 `ctx.uiWorkspace.connectWorkspace(workspaceId)` 复用或新建该工作区的会话，拿到 `sessionId` 才发 `start`。
  换不到会话时只在面板里显示原因，不发请求；`connectWorkspace` 不做界面导航，用户留在面板里。
  测试：`test/client.test.mjs` 模块契约改为「只注册两个插槽」并新增「两个旧入口都不再注册」，删除滚动归属与 dock 两块共 6 项，
  全局把 `WorkbenchView` 换成 `FlowDetail`；面板详情断言改为「点任务展开详情，详情里就是完整工作台」（含闸门与阶段设置），
  并新增 5 项覆盖面板内启动：能写需求、先换会话再 `start`、`brief` 原文透传、成功后提示看列表、换不到会话时不发请求。

- **开发规则可跟工作区走**：此前每次新流程都回到内置五条，用户按项目定制的规则（例如「日志用结构化字段」）
  每条流程都要手动重勾一遍。现在设置面板新增「保存为工作区默认」/「清除工作区默认」，把当前生效的规则写进
  `<工作区>/.dsh-flowgate/config.json`；之后同工作区的新流程自动继承，顺序是内置默认 → 工作区默认 → 本次流程临时调整。
  `view` 新增 `ruleSource`（`flow` / `workspace` / `default`）与 `workspaceRules`（文件路径、是否已配置、保存的 id 与自定义条数），
  设置面板据此标出来源，避免用户误以为勾选已经持久化。保存后本次流程改为跟随默认，来源标签与行为一致。
  工作区配置只存规则（`rules.ids` + `rules.custom`），**不存 `writeGrants`、scope 或门禁决策**——这些是一次性授权与流程内状态，
  跨流程复用等于让授权永久有效；`config.json` 可提交，`flows/` 与 `flows.jsonl` 仍是本机运行记录。
  同时修掉两处与规则继承冲突的地方：`preset` 动作此前把 `overrides` 重置成 `{angles, directions}`，切档会静默丢掉用户勾选的规则
  （`upgrade` 早已保留，两处现在一致）；`toggleRule` / `addRule` 此前以 `DEFAULT_RULE_IDS` 为起点，改为以当前生效的一套为起点，
  否则在工作区默认之上取消一条规则会退回内置默认，把工作区里关掉的规则又打开。
  `test/host.test.mjs` 增加 9 项覆盖：来源默认值、只改本次不落盘、切档保留勾选、保存后 `config.json` 内容、配置里没有写权限、
  新宿主实例继承、自定义规则随工作区存下、新流程带出自定义规则、清除后回到内置默认。

- **适配新版子代理协议**：使用 `startActivation` / `getProvider('spawn')`、预留 `childId` 与 `delivery: 'caller'`，
  在执行前登记会话归属；移除对旧 `start` / `list` 和非协议字段 `toolFilter` 的依赖。当时兼容声明收窄到已核对源码的 DSH `0.2.2-rc.3`，现已改为版本范围（见上方 rc.5 条目）。
- **子代理只读由最终工具守卫执行**：通过 `tools.guard` 拒绝写工具和未知变更工具；默认 shell 仅允许精确的 `pwd`，Git 默认拒绝，
  `script_path`、解释器及包测试脚本无法证明只读时拒绝。S4 仅在方向 `needsWrite` 与用户 `writeGrants` 同时满足时允许变更性 shell，代码写工具仍拒绝。
- **取消释放已发布的 activation**：取消、超时和放弃时调用 `dispose`，停止后续角度 / 方向并拒收迟到聚合；启动无回执或清理失败时保留只读隔离、撤销写授权并报告子会话 ID。
  用户自行启动的其他任务仍需自行停止。能力探测区分服务、接口、provider、预留 ID 与最终守卫缺失；降级评审为 `advisory` / `MINOR`，测试为 `uncovered`。
- 子代理测试加入 `npm test`，验证记录区分官方源码核对、测试替身和重启后的实机验证；历史 `by: 'subagents'` 或聚合通过不再作为真实子代理成功的证据。
  本轮 `pnpm test` 275 项通过，另 1 个原有变更摘要用例因环境禁止 spawn git 跳过；语法与补丁检查通过。重启后的实机验证未执行；宿主代码通过现有 `link:` 安装加载，无需重装，需完全重启 DSH 才生效。

- **退回开发后旧产物不再自动作数**：退回 S2 / S3 会清掉被覆盖阶段留下的变更摘要、评审报告与测试结果，
  否则旧内容会让门禁提前变成可点，用户可能在 Agent 重做之前就把「完成开发」点掉。升档触发回退时，
  「发现落在 scope 之外」的结论仍随响应带出，界面照旧能解释为什么回到 S1；「上次的请求被中断」提示也改为
  只在这一轮确实请求过门禁之后才出现，产物刚落地、Agent 还没请求的窗口不再误报。

- **需求文档确认不再依赖 Agent 的那次调用**：此前「文档待批准」只存在 `GateHub` 的内存等待器里，`flowgate_doc` 一旦被中断
  （工具调用超时、宿主重启、用户打断），等待器就没了，界面退回「门禁未就绪：等 Agent 提交需求文档后……」——
  文档明明还在，却点不了「批准并冻结 scope」，用户只能放弃这次流程。现在待决状态改由持久化的 `flow.doc.pending` 表达：
  工具被中断时保留文档并返回 `decision: 'pending'`，`view.doc` 带上 `pending` / `interrupted`；界面在 `pending` 为真时
  照旧渲染三个按钮，并提示「上次的确认请求被中断……文档已保存，仍然可以直接确认」，门禁 action 走统一的文档决策
  （`approve` / `revise` / `skip`），有等待器时再通知它，重启后从快照恢复也照样能批准；已决策、已放弃的文档只作查看。
  等待器同时校验 entry 身份，结算时移除 `abort` 监听并清掉计时器，修掉新等待被旧 signal 误删、Promise 永不结算的问题。

- **S2 / S3 / S4 的门禁按钮同样与等待器解耦**：文档那条修好后，同一类问题在出口门禁上还在——`flowgate_gate` 的等待被中断后
  `view.waiting` 变 false，「完成开发」「通过评审」「验收通过」全部置灰，用户只能放弃流程。现在 `view.gate` 给出
  `pending`（产物已交、还没决策）与 `interrupted`（等待器已经不在了），客户端按 `pending` 启停按钮，中断时提示
  「你的决定仍然有效，点一下就会推进」；`gate` 动作统一走 `decideGate`，有等待器就通知它、没有就直接推进状态机，
  产物还没交时拒绝提前确认，同一阶段重复点击也不会跳过下一阶段。
- **状态条移到输入框正上方**：常驻条与宿主的【任务】【目标】条注册在同一个 `conversation.input.dock` 槽，
  槽内按 `order` 升序自上而下排（任务条 `0`、目标条 `10`、排队消息 `20`）。此前取 `order: 5`，
  于是有【任务】和【目标】时正好夹在两者中间。现在改为 `order: 15`，落在目标条之下、排队消息与输入框之上，
  视觉上紧贴输入框。

- **工作台实时显示进度**：此前提交需求后只有一个静止页面，看不出 Agent 在做什么。现在 `view` 新增三个字段：
`progress`（四阶段等权，`percent` 只由已发生的事实推出——文档交没交、`devChanges` 有没有、`review` / `test` 有没有）、
`activity`（最近一次工具动作，例如「正在读取文件：lib/client.js」）、`elapsedMs`。客户端沿用 1.5 秒轮询，在头部渲染成
「S2 开发 · 正在写入文件：lib/client.js」+ 进度条 + 百分比 + 已用时间；轮到你确认门禁时改成「门禁等你确认」。
活动摘要只放内存，阶段切换、Agent 空闲（订阅 `agent/status`）、流程结束或放弃后自动清掉，不会残留上一阶段那句「正在写入」。
- **流程结束后能直接开新流程**：结束或放弃后 `view` 仍是 `active: true`，而 dock 与工作台都用 `view.active` 判断空态，
  于是界面上只剩「流程已结束」，没有任何启动入口，用户只能去对话里叫 Agent。现在 dock 在 `view.finished` 时也走启动形态
  （保留阶段与跳过计数，右侧照旧给「开始需求分析」），工作台在已结束 / 已放弃的内容区底部追加一块「开始一次新流程」，
  复用 `StartPanel`，需求描述同样必填。宿主 `start()` 遇到已结束的旧流程本来就会新建，所以这里点下去是新的一条，不是续跑。
  门禁面板的结束态文案也随之改成指向这个入口。
- **需求描述改成必填，没写就先去填**：输入框上方的「开始需求分析」原来不带需求描述（`FlowgateDock` 只发 `{ preset }`），
  唤醒消息一边写「用户这次没有填写需求描述」一边仍要求「接着做 S1」，Agent 于是照着四个字自己编需求。
  现在 dock 未启动时点按钮不再直接建流程，而是就地展开需求输入框（Ctrl / Cmd + Enter 提交），填了才发 `start`；
  空描述时按钮禁用，`StartPanel` 同样拦住空描述并提示「先写一句这次要做什么」。
  唤醒消息也按有无 `brief` 分两支：有原文才附「需求原文：」并要求「已写清的不重复问」；没有时改为「用 `flowgate_ask` 只问一个问题：
  这次要做什么，不要自己假设目标、不要直接产出需求文档、不要写代码」，兜住 `flowgate_start` 等绕开界面的入口。
- **放弃流程后 Agent 不再继续追问**：此前只有 `flowgate_gate` 检查过 `flow.finished`，`flowgate_ask`、`flowgate_doc`、
  `flowgate_review`、`flowgate_test` 只校验阶段，于是用户点了「放弃这次流程」之后，Agent 仍能弹出新的追问卡片、
  继续提交文档，看起来像流程没结束。现在四个工具统一走 `requireRunning(flow)`，结束或放弃后直接报错，
  错误信息里带上放弃原因并提示「请让用户在工作台重新启动一条流程」。
  同时 `cancelFlow` 清空未答完的 `grill.pending`，`view` 在流程结束时不再渲染追问卡片与文档门禁。
- **界面启动会真正唤醒 Agent**：此前点「开始需求分析」只创建流程状态，Agent 毫不知情，S1 会一直停在「进行中」，
  用户必须自己在对话里再说一句才动。现在启动后宿主用 `ctx.get('agents')` 取到该会话的 live agent，
  通过 `followup` 投递一条 user 消息（档位 + 需求原文 + 「先 `flowgate_status`，再 `flowgate_ask` 一次一问，
  最后 `flowgate_doc` 提交」）。取不到 Agent 时启动照常成功，视图里带 `nudge` 失败原因，门禁面板直接提示
  「再点一次开始会重试，也可以回到对话发一句继续」。唤醒结果只放内存，不写进快照，重启后不会残留上次的失败提示。
- **唤醒失败可以重试**：重复点「开始需求分析」仍然幂等、不新建流程，但上次 `nudge.ok` 为 false 时会再唤醒一次，
  不必让用户以为按钮坏了。宿主用例补了「第一次拿不到、第二次拿得到」的路径。
- 修复主按钮悬停时普通按钮样式覆盖底色、导致文字与背景难以区分的问题；主按钮使用主题专用悬停色，普通按钮保留淡底色并加强边框，危险操作保留红色提示。

- 界面一键启动：空态直接给标题输入（可留空）+ 档位选择 + 「开始需求分析」，输入框上方的状态条在未启动时也提供启动按钮，不再必须先让 Agent 调 `flowgate_start`。
- `flowgate_start` 的 `title` 改为可选；界面启动由宿主用 `ctx.get('sessions')` 反查会话工作目录，重复点击是幂等的。
- 调整工作台标题栏、阶段导航和卡片层级，统一字号、间距、边框与状态徽标。
- 将出口门禁移到侧栏顶部；按工作台实际容器宽度切换三栏、双栏或单列布局，窄屏优先显示门禁操作。
- 评审发现和测试结果分行排版，长文件路径自动换行；设置分组并为自定义表单补齐可见标签。
- 改善连接提示、未启动状态、键盘焦点与减少动态效果适配，配色继续跟随 DSH 明暗主题。
- 输入框上方的状态条改成与输入框等宽：照 DSH 输入卡片的几何（列宽减去两侧 clearance，上限 `--dsh-composer-card-max-width`）计算，不再独占整行。
- 保持宿主状态机、接口请求、按钮操作与权限规则不变。
- **D1 变更摘要兜底采集**：`dsh-ops` 这类 profile 会退掉官方 `shell` 行（`retiredLegacyRow(ctx, 'shell')`），
  宿主内 `ctx.get('shell')` 为空，S2 的 `dev.summary` 只剩一条 error。改为优先 shell 服务、缺失时用
  `node:child_process` 直接跑 git（摘要带 `via` 字段），两条路都失败才写 `error`。
- **不再「切到工作台就被滚到最下面」**：根节点声明 `data-conversation-composer-overlay`，让 DSH 对话骨架
  把 `.viewArea` 收成 `flex: 1 1 0` 并把输入框改成浮层，滚动交给工作台自己；底部留白改读
  `--dsh-composer-height`，最后一张卡片滚到底不会被输入框遮住。窄屏下滚动容器是 `.fg-body`，留白同样按它算。
- **可以放弃流程了**：门禁面板底部提供「放弃这次流程」（二次确认才生效），没有挂起门禁时也能用。
  放弃会把流程标成已结束 + 已放弃、解冻 scope、清空写权限授权、写一条 `flow.cancelled` 审计事件，
  并唤醒所有挂起的门禁工具让它们立刻返回 `cancelled` 而不是等到超时；新增 `flowgate_cancel` 工具，
  语义与界面按钮一致。放弃 ≠ 跳过：跳过着眼于本阶段，放弃是整条流程作废。
- **空态换成需求描述输入框**：不再是「只能填一个标题」。填写的原文作为 `brief` 随启动提交，
  宿主用它派生标题（第一行、去 markdown 前缀与句末标点、超 40 字截断），`flowgate_status` 摘要里带上原文，
  Agent 在 S1 直接读需求提问而不用用户复述；`flowgate_start` 增加可选 `brief` 参数。
- 337 项测试：宿主状态机（128）、子代理协议（46）、假宿主集成（28）、客户端真渲染点击（118）、安装就绪度（17）。
- 实机验证 D4 的另一半：评审发现落在冻结 scope 外时点升档，实测回退到 S1（`upgrade-scope-overflow`）、
  scope 解冻（`scope.data: null`），重新批准时把越界文件补进 scope 后才继续开发。

## 0.1.0

首个版本。

- 四阶段状态机（S1 需求分析 → S2 开发 → S3 评审 → S4 测试），门禁软跳过、顺序硬约束。
- `scope.json` 冻结与越界守卫：`tools/pre-execute` 拦截白名单外的写工具调用。
- 按钮化 grill-me 追问卡片（2–4 个带权衡说明的选项 + 自定义输入）。
- 单文件 HTML 需求文档预览（`srcDoc` 沙箱 iframe）。
- 两档预设（小功能快速开发 / 大需求严格执行）与自定义角度、方向追加。
- S3 升档 + 评审发现问题时按发现落在哪决定回退深度：全在 scope 内 → 回退 S2 重做；
  有 CRITICAL / MAJOR 落在 scope 外 → 回退 S1 先调 scope（D4，两种情况 scope 都不自动扩充）。
- `flows.jsonl` 事件日志与跳过计数。
- 宿主驱动入口：`flowgate_review_run` / `flowgate_test_run` 为每个角度 / 方向 spawn 子代理并确定性聚合。
- 会话归属：评审、测试子代理的会话映射到父流程，写工具在工具层被拒绝。
- D2 写权限例外：测试方向可声明 `needsWrite`，用户在 S4 显式勾选后该方向的子代理才可跑变更性 shell；
  代码写工具仍硬拒绝，回退时授权自动清空（新增 `toggleWriteGrant` action）。
- 开发规则（PRD 4.5）：内置五条结构化规则，S2 作为检查清单、S3 的正确性与风格角度逐条核对；
  用户可通过 `toggleRule` / `addRule` 勾选或追加，内置规则不可删除。
- 追问卡片的「跳过」不推进不放行，只在卡片上说明必须做出选择；点「修改需求」后 S1 空态说明下一步。
- 回退到 S1 时解冻 scope：旧白名单不再放行，用户必须重新批准；落盘 scope.json 带
  `scope_frozen_without_doc_approval`（PRD 4.1.2 的跳过标记）。
- S3 门禁在存在 scope 外发现时显示「回到需求分析调整 scope」按钮（D4 的回退入口）。
- 升档回退的提示文案跟随实际回退目标（此前写死 S2，回退到 S1 时会误导 Agent 去改代码）。
- README 补「改客户端半 / 宿主半的生效范围」：客户端存盘自动 reload，宿主半必须重启进程。
- **界面颜色改为跟随 DSH 主题**：此前客户端用的 `--dsw-alias-text-primary` / `--dsw-alias-border-default` / `--dsw-alias-accent-primary` 等名字在 ui-theme 里并不存在，`var()` 取不到值就落到写死的 fallback，界面实际是固定色、完全不跟明暗主题。现全部换成 ui-theme 真实 token（`label-*` / `bg-layer-*` / `border-l*` / `brand-primary` / `state-*`），并删掉所有颜色字面量（状态徽标改用 `state-*` 语义色，主按钮前景改用 `label-primary-inverted`）。
- 集成测试补齐 AC-4：评审 / 测试子代理会话的写工具在工具层被拒绝，解绑后回到父流程判定。
- 安装就绪度检查：按 DSH 客户端模块扫描规则复核 profile 清单、软链、`dsh.client` 形状、bundle id 与宿主导出。
- 修正 S2 变更摘要采集：改用 `shell.run(shell.resolve({ workdir }))`，与 `ShellExecRequest` 的实际字段和
  `ShellExecutor` 的实际接口一致（此前用不存在的 `shell.exec({ cwd })`，采集会静默失败）。
- 变更摘要支持未跟踪文件：`git status --porcelain=v1` 的 `??` 行进 `untracked`，采集失败时把原因写进
  `error` 字段（采集不到不等于没有变更）。
- 实机验证发现并修复：变更性 shell 在 S2 被放行（`rm -rf` 真的执行了）。现在 S2 也拒绝，并指引改用
  `write` / `edit`；shell 工具名不再硬编码 `bash`，改为 `SHELL_TOOLS` 集合，`ops_bash` 等别名同样受管。
- 136 项测试：宿主状态机（51）、假宿主集成（23）、客户端真渲染点击（49）、安装就绪度（13）。
- 实机验证（桌面端 0.2.2-rc.3）：五条流程跑通 AC-1…AC-8，期间修掉三个真实缺陷——
  S2 放行变更性 shell、shell 工具名硬编码 `bash`、升档清空用户勾选的开发规则。
