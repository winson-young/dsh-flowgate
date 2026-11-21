# 验证记录

[返回使用指南](../README.md) · [开发与维护](development.md#测试)

以下记录迁自原使用说明，保留当时的环境与结果，不代表本次文档修改重新执行了这些测试。表中的 AC / D 编号沿用当时验收项编号。当前操作方法以[使用指南](../README.md)为准，测试命令见[开发与维护](development.md#测试)。

历史记录中的 `by: 'subagents'` 仅表明调用了子代理聚合入口；聚合报告通过、`blocking: 0` 或流程走完，均不能证明真实子代理成功执行并返回有效报告。下文原有结论保留，其证据范围受此限定。

## 门禁模式与命令清单（2026-11-21）

需求：用户原文（m00001）「我觉得现在的需求开发的流程有点麻烦了，还要勾选什么权限，这些都不能自动获取权限吗？……最好用户最多点通过就好了」。追问答疑后确认为两部分：门禁能否「没有阻塞项就直接通过」且模式随时可切（m00044）；权限清单应由 S1 分析项目推导，要「适合」而不是过多或过少（m00044）。方案经用户「确认」（m00117）后实施。

方案：
- 流程级字段 `gateMode: 'auto' | 'manual'`，任何阶段可切，fast 档默认 `auto`、strict 档默认 `manual`。自动通过只跳过「点通过」这个动作，**不放开任何权限**：不代替用户勾 shell 授权、不代替用户接受验收方案缺口，判定口径与手动通过共用 `gateValidation`。
- 四处门禁统一走 `awaitGate`（`flowgate_doc` / `flowgate_gate` / `waitReviewGate` / `waitTestGate`）：auto 且 `gateBlockers` 为空则放行并记 `autoPassed`，否则把原因写进 `gateBlockers` 后挂起；挂起期间切模式会以 `mode-changed` 唤醒并重判。
- `scope.commands` 改为从项目推导（`package.json` scripts、测试框架配置、`tsconfig`、`Makefile`），新增可选 `command_sources` 标注来源与对应 AC；`scopeReadiness` 增加过少与过多两侧的检查。
- S4 缺口分类：`excluded`（环境受限）不再算缺口；`rollbackTo` 加打回预算，同一缺口指纹连续退回超过 2 次改回 S1。

改动范围：`lib/index.js`（`gateBlockers`、`awaitGate`、`gapSignature`、`projectProfile`、`gateValidation` 的缺口口径、`rollbackTo` 预算、`setGateMode` 接口、`view()` 的 `gateMode` / `gateBlockers` / `autoPassed`、`flowgate_doc` 参数描述与 `flowgate_status` 文案）、`lib/acceptance.js`（`excluded` 状态、`scopeReadiness` 的 `options.commandSources` / `options.project` 与七类风险码）、`lib/client.js`（`GateModeToggle`、门禁卡 `modeBar`、命令来源渲染）、`test/gatemode.test.mjs`（新增 10 条）、`test/host.test.mjs` / `test/integration.test.mjs` / `test/subagents.test.mjs`（夹具改为启动后显式切 manual）、`test/acceptance.test.mjs`（`counts` 补 `excluded`）、`package.json`（`test:gatemode` 并入 `test`）、`docs/development.md`、`docs/verification.md`。

| 验收项 | 状态 | 证据与限制 |
| :--- | :--- | :--- |
| AC-1 fast 档默认自动通过、strict 档默认每步确认 | 通过 | `test/gatemode.test.mjs`「fast 档默认自动通过」断言 `state.gateMode === 'auto'`；「strict 档默认每步确认」断言 `'manual'` |
| AC-2 自动通过下 S1 体检干净直接冻结，不等用户 | 通过 | 同文件「自动通过模式下 S1 体检干净就直接冻结，不等用户」：`flowgate_doc` 直接返回 `decision: 'approve'`、`frozen: true`，`state.stage === 'S2'`、`autoPassed.S1` 存在、`gateBlockers` 为 null |
| AC-3 有阻塞项时停下并说明原因 | 通过 | 同文件「自动通过模式下 S1 有缺口就停下并说明原因」：`commands: []` 时 `gateBlockers.items` 非空且匹配 `/命令\|测试/`，`doc.pending === true`；显式接受缺口后仍可冻结 |
| AC-4 全部 AC 声明人工核验时自动通过会停下 | 通过 | 同文件「全部 AC 声明人工核验时自动通过会停下」：`gateBlockers.items` 含「人工核验」说明，接受缺口后冻结成功 |
| AC-5 自动通过下 S2 快照完整直接进入 S3 | 通过 | 同文件「自动通过模式下 S2 快照完整就直接进入 S3」：`flowgate_gate` 返回 `decision: 'pass'`、`next: 'S3'`，`autoPassed.S2` 存在 |
| AC-6 挂起时切到自动通过当场放行 | 通过 | 同文件「每步确认下挂起，切成自动通过后当场放行」：先切 manual 挂起，`setGateMode auto` 返回 200 后原 `pending` 直接解析为 `frozen: true` |
| AC-7 自动通过因阻塞停下后切回手动仍然等用户 | 通过 | 同文件「自动通过因阻塞项停下后切回每步确认仍然等用户」：切 manual 后 `doc.pending` 仍为 true，用户点批准才冻结 |
| AC-8 非法模式被拒绝、重复设置幂等 | 通过 | 同文件「非法门禁模式被拒绝且不改流程」（409 且模式不变）与「同一模式重复设置是幂等的」 |
| AC-9 缺口口径不再把 excluded 算作缺口 | 通过 | `lib/index.js` 的 `gateValidation` 改为 `unpassedPoints = fail + uncovered`、`gaps = total - pass - excluded`；`lib/acceptance.js` 的 `counts` 增加 `excluded`；`test/acceptance.test.mjs` 断言补 `excluded: 0` |
| AC-10 打回预算生效 | 通过 | `lib/index.js` 的 `rollbackTo` 按 `gapSignature` 计数，超过 2 次改写目标阶段并记 `flow.rollback.redirected`；既有「S4 退回」用例仍通过（首次退回仍是 S2） |
| AC-11 无回归 | 通过 | 逐入口实跑：内容快照 20、验收账本 30、运行版本 18、宿主 349、门禁模式 10、子代理 82、集成 33、客户端 240、安装 17，合计 799 项全通过 |

### 执行环境与方式

本机 `PATH` 里没有 `node` / `npm`，实测用运行时自带可执行文件逐个跑入口：

```
"C:/Users/lenovo/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" test/<entry>.test.mjs
```

覆盖 `npm test` 的全部九个入口。`npm run check` 的 `stamp-revisions.mjs --check` 在本机受沙箱限制无法写盘，改为只读计算六个模块的 `moduleSourceRevision`（CRLF→LF 规范化、抹掉 `FLOWGATE_MODULE_REVISION` 字面量后取 sha256）再手工更新字面量，结果与脚本口径一致。

### 已知未通过项

无。过程中修过两处自身写法问题：`test/gatemode.test.mjs` 起初所有用例共用一个工作目录，触发「该工作区已有流程在进行」；S2 用例的 shell 桩返回空输出，被判定为「git 没正常返回」导致快照不完整、自动通过不生效——补上 `---numstat---` 段后通过。另把 `BROAD_COMMAND` 收窄，`npm run *` 不再算超宽（它只能在 `package.json` scripts 里选，且插件一直支持该前缀通配）。

### 真实视觉未覆盖

`GateModeToggle` 与 `gateBlockers` 原因列表只在客户端渲染断言层面核对（按钮文案、`act('setGateMode')` 载荷、样式字符串），没有在真实 DSH 工作台里加载看过：模式切换条在四个阶段卡片里的实际位置、窄屏换行、阻塞原因多行时的撑高都没在真实宿主里量过。本机没有可用 CDP 接入，按既有约定记为未覆盖。

## 会话内快捷作答 S1 决策问题（2026-11-21）

需求：S1 需求分析阶段 Agent 提问时，会话界面没有快捷回答入口，只能切到左侧栏「流程工作台」的拍板卡片作答。需求原文：「需求分析阶段如果要回答问题，会话界面没有快捷回答的按钮，要加一下，至于怎么加用户体验最好你来决定」。

方案：在 `conversation.input.dock` 的阶段提示里新增 `HintAnswer`，独占整行排在阶段流转按钮下面——点一下选项即提交，需要写自己的答案时展开「其他答案…」，按 `Ctrl/Cmd + Enter` 或「提交答案」提交。按用户确认，点选快捷答案只投递一条 `answer`，不额外发送用户发言（不引入「发送用户消息」依赖，只走既有 `/api/flowgate/action` 通道）。宿主侧协议、`GrillCard` 与门禁语义都不改。

改动范围：`lib/client.js`（新增 `HintAnswer` 与 `waitingWhy`，`HintActions` 尾部挂载回答区，`.fg-hint-answer` 样式系列与 ≤640px 竖排规则，`fg-hint-why` 按 `waitingKind` 分流）、`test/client.test.mjs`（8 条用例 + `grillView` / `answerButtons` 两个辅助）、`docs/development.md`、`README.md`、`docs/verification.md`。

| 验收项 | 状态 | 证据与限制 |
| :--- | :--- | :--- |
| AC-1 dock 渲染回答区，选项与 `pending.options` 一一对应，推荐项用主色并标「（推荐）」 | 通过 | `test/client.test.mjs`「阶段提示：S1 决策问题在 dock 里直接作答，选项与推荐项同源」断言 `.fg-hint-answer` 存在、显示「问：…」与 `context`、两条选项文案带「（推荐）」、`opts[0].props.className` 含 `fg-hint-btn-primary`、`.fg-hint-answer-opt-note` 的文本等于 `tradeoff` 且按钮不再挂 `title`，且 `.fg-hint-actions` 里仍是 `['放弃这次流程']`（既有按钮集合不变） |
| AC-2 点选项只投递一次 `answer`，载荷为 `{choiceIndex, customText: ''}` | 通过 | 同文件「点一下快捷答案只投递一次 answer」断言 `posted.length === 1`、`action === 'answer'`、`payload` 深等于 `{ choiceIndex: 1, customText: '' }` |
| AC-3 允许自定义时可提交 `{choiceIndex: -1, customText}`，`allowCustom === false` 时完全不出现自定义入口 | 通过 | 同文件「自定义答案 Ctrl+Enter 与按钮同源，禁用时不出现入口」：空草稿时「提交答案」`disabled`，填入后 `Ctrl+Enter` 返回 1 并提交 `{ choiceIndex: -1, customText: '按我的方案来' }`；`allowCustom: false` 时既无「其他答案…」也无 `textarea` |
| AC-4 在飞时按钮置灰显示「提交中…」，失败给出可读报错 | 通过 | 同文件「提交中锁住答案按钮，失败给出可读报错」：`fetch` 替身挂起后 `posted.length` 保持 1、选项与「提交答案」`disabled`、出现「提交中…」；返回 500 `{error: '宿主正忙，请稍后再试'}` 后出现 `.fg-hint-err` 且 `role === 'alert'` |
| AC-5 问题被答掉后回答区随轮询消失，不残留答案按钮 | 通过 | 同文件「问题被答掉后回答区随轮询消失，不残留答案按钮」：把 `grill.pending` 置空并等过一轮 1.5 秒轮询后 `.fg-hint-answer` 为 `null` |
| AC-6 等待说明按 `waitingKind` 分流，`doc` / `gate` 保持原文 | 通过 | 同文件「等待说明按 waitingKind 分流，只有可作答时才指向快捷答案」断言四种文案：可作答的 `answer` 为「点上面的快捷答案，或到「流程工作台」回答」、不可作答的 `answer` 为「到左侧栏「流程工作台」回答这个问题」、`doc` 与 `gate` 仍为「在左侧栏「流程工作台」确认后才继续」 |
| AC-7 回答区整行铺满、窄屏单列，不改 dock 宽度契约 | 通过 | 同文件「回答区整行铺满、窄屏单列（样式契约）」对样式文本断言 `.fg-hint-answer` 含 `grid-column: 1 / -1`、`display: flex`、`flex-wrap: wrap`，`.fg-hint-answer-opts` 含 `flex-wrap: wrap`，`@media (max-width: 640px)` 内含 `.fg-hint-answer-opts > button { flex: 1 1 100%; text-align: left; }`；逐行断言 `.fg-hint-answer*` 规则里没有 `width: <像素>px`；`.fg-hint` 的 `width` / `max-width` calc 公式原样保留 |
| AC-8 无回归 | 通过 | 八个入口逐个实跑：内容快照 20、验收账本 30、运行版本 18、宿主 349、子代理 82、集成 33、客户端 240、安装 17，合计 789 项全通过。语法与指纹：`stamp-revisions.mjs --check` 输出 `Module revisions verified (6 modules).`，`lib/index.js` / `lib/client.js` / `lib/provenance.js` / `lib/acceptance.js` / `lib/runtime.js` / `lib/revisions.js` / `docs/verify-layout.mjs` 七个文件 `node --check` 全部通过。既有「阶段提示」用例一条未改，新增 7 条全通过 |

### 执行环境与方式

本机 `PATH` 里没有 `node` / `npm`，`npm test` 与 `npm run check` 无法直接执行。实测是用运行时自带的可执行文件逐个跑同一批入口：

```
"C:/Users/lenovo/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" test/<entry>.test.mjs
```

覆盖 `npm test` 的全部八个入口，外加 `stamp-revisions.mjs --check` 与七个文件的 `node --check`，即 `npm run check` 的全部内容。命令语义与 npm 脚本一致，但**不是**通过 `npm` 发起的：npm 脚本自己的环境变量与钩子未参与。

### 已知未通过项

无。首次实跑时 AC-3 那条用例失败过一次（`FAIL 阶段提示：自定义答案 Ctrl+Enter 与按钮同源，禁用时不出现入口 → 找不到按钮：其他答案…`）：断言「按钮不存在」时误用了 `buttonByText`，而它在找不到时会自己抛错，于是 `allowCustom: false` 分支永远过不了。改成用 `buttons(tree).some(...) === false` 直接找，重跑后 239 项全通过（之后又补了第 8 条用例，现为 240 项，见下方「评审后修复」）。这是用例本身的写法错误，不是实现缺陷——但它恰好说明测试阶段的价值：S2 / S3 阶段把这一条记成「静态核对无误」时，那个断言其实是错的。

### 真实视觉未覆盖

dock 回答区只在组件树与样式字符串层面核对（文案、`disabled` 状态、提交载荷、CSS 声明），没有在真实 DSH 会话界面里加载量过——整行铺满是否与输入框对齐、窄屏竖排的换行位置、长选项（≤120 字符）与长问题（≤500 字符）的实际折行都没在真实宿主里看过。本机没有可用的 CDP 接入或插件诊断通道，按既有约定记为未覆盖。

### 评审后修复（2026-11-21）

S3 评审留下 6 条非阻塞发现，其中两条是实现缺陷，按用户「直接改」的授权在流程结项后修掉；另外四条是测试写法与既有模式延伸，保持原样。

| 缺陷 | 位置 | 修法 | 验证 |
| :--- | :--- | :--- | :--- |
| 取舍说明只挂在 `title` 上，触屏、键盘与读屏都拿不到，而它正是「点之前判断选哪个」的唯一依据 | `lib/client.js` 选项按钮 | 取舍改成选项按钮里的第二行 `.fg-hint-answer-opt-note`，按钮内部改为 `display: flex; flex-direction: column`，去掉 `title`；推荐项副行用前景色并降透明度 | AC-1 用例改为断言 `.fg-hint-answer-opt-label` / `.fg-hint-answer-opt-note` 的文本，并断言按钮不再挂 `title` |
| 换问题时只重置草稿、展开态与报错，`busy` 与 `sending.current` 不重置；旧问题还在飞时换上新问题，新问题的按钮会被锁死 | `lib/client.js` `HintAnswer` 的 `useEffect([questionId])` | 一并清 `busy` 与 `sending`；另加 `asking` ref，回包晚到而题目已换时直接返回，不拿上一道题的结果改这一道的状态 | 新增用例「阶段提示：换问题不继承上一条的提交态与回包」：旧请求挂在 `fetch` 替身上时把 `pending.id` 换成新问题，断言「提交中…」消失、按钮恢复可点；旧回包随后才到时断言不出现 `.fg-hint-err`、按钮仍可点。`test/client.test.mjs` 240 项全通过 |

修完重跑八个入口，合计 789 项全通过（内容快照 20、验收账本 30、运行版本 18、宿主 349、子代理 82、集成 33、客户端 240、安装 17），`stamp-revisions.mjs --check` 仍输出 `Module revisions verified (6 modules).`。文档同步改了 `docs/development.md`（取舍不再挂 `title`）与 `README.md`（不用悬停也能比较）。

## 冻结前验收方案体检（2026-11-21）

需求：冻结 scope 与验收方法、验证命令之间缺少一致性检查。AC 可以声明「集成测试」而 scope 里既没有测试文件也没有测试命令，验证步骤可以点名 scope 之外的文件，视觉验收可以完全不写怎么量——这些在 S1 都能静态看出苗头，但当时没人拦。等 S4 交证据时才暴露「方法对不上证据」，只剩两条路：带缺口结项，或整轮退回重做。

改动范围：`lib/acceptance.js`（新增 `scopeReadiness` 与 `scopeCovers` / `procedureOutsideScope` 两个内部函数，`TEST_FILE` / `TEST_COMMAND` / `MEASURE_HINT` / `PATH_HINT` 常量）、`lib/index.js`（`flowgate_doc` 提交时体检、`decideDoc` 冻结前重算并要求 `acceptScopeRisks`（原因可选）、`scope.risks_accepted` 事件、视图 `doc.pendingScopeRisks` 与顶层 `scopeRisksAccepted`、`flowgate_status` 摘要、`pendingScopeRisks` 流程字段）、`lib/client.js`（`DocGate` 的缺口确认区与两步批准、`ScopeBlock` 的「验收方案缺口」区块）、`test/acceptance.test.mjs`、`test/host.test.mjs`、`test/client.test.mjs`、`test/integration.test.mjs`、`docs/development.md`。

| 验收项 | 状态 | 证据与限制 |
| :--- | :--- | :--- |
| AC-1 验收标准缺 `id` 或 `id` 重复直接拒收 | 通过 | `test/acceptance.test.mjs`「id 缺失或重复是硬阻塞，不是风险」断言 `blockers` 依次为 `['missing-id','duplicate-id']`；`flowgate_doc` 提交时 `blockers` 非空即抛错，不进入待批准状态 |
| AC-2 声明可执行验证却没有测试命令时给出缺口 | 通过 | 同文件「冻结前的验收方案体检：集成验收缺测试文件与命令时给出缺口，不拦截」断言 `risks` 的 `code` 依次为 `['no-test-command','integration-without-test-file']`；「清单里已经有测试文件时不再报『没有测试文件』」与「补全命令与测试文件后体检无缺口」两条反向用例证明它不会一律报缺口 |
| AC-3 验证步骤点名 scope 之外的文件时给出缺口 | 通过 | 同文件「验证步骤点名 scope 外的文件时给出缺口…」：`procedure` 提到 `test/fixtures/session.ts` 而 scope 只含 `test/host.test.mjs` 时报 `procedure-file-outside-scope`，把 `test/` 加进 scope 后缺口消失；`manual` 方法不被误伤。目录级覆盖算覆盖，所以列了 `test/` 就不再逐文件报 |
| AC-4 视觉验收没写测量方式时给出缺口 | 通过 | 同文件「视觉验收没写测量方式时给出缺口，写了就不再提示」：`method: 'visual'` 且 `procedure` 不含测量类词汇时报 `visual-without-measurement`，写上 `getBoundingClientRect` 后消失 |
| AC-5 有缺口不能一键冻结，必须显式接受 | 通过 | `test/host.test.mjs` 的 `sess-scope-risk` 组：只带 `decision: 'approve'` 返回 409 并匹配 `/验收方案缺口/` 与 `/acceptScopeRisks/`；带 `acceptScopeRisks: true` 后 200（原因改为可选，见本节末尾的后续调整） |
| AC-6 接受结果落盘且可追溯 | 通过 | 同组断言 `scope.data.scope_risks.accepted === true`、`scopeRisksAccepted.accepted === true`、`flows.jsonl` 有 `scope.risks_accepted` 事件（带 `codes` / `acs` / `decision`），`flowgate_status` 摘要含「验收方案缺口（用户已明确接受 1 条）」与「S4 仍严格按每条验收标准声明的方法核验证据」；用户主动写原因时另有「用户补充的接受原因：…」 |
| AC-7 工作台在批准前摊开缺口，不让人盲签 | 通过 | `test/client.test.mjs` 的 S1 组：主按钮变「批准并冻结 scope（需确认缺口）」，点它只展开确认区（`posted.length === 0`），确认按钮直接可用且确认区内没有任何「接受原因」输入框，点它提交 `acceptScopeRisks: true` 且不带 `scopeRiskNote`；取消后回到普通入口且缺口仍摆着。S2 组断言冻结后显示「验收方案缺口（用户已接受）」 |
| AC-8 补上缺口后可以直接冻结，不残留旧缺口 | 通过 | `test/host.test.mjs` 同组最后一条：退回 S1 把 `test/fixtures/session.ts` 加进 scope 后 `pendingScopeRisks` 为空，`decision: 'approve'` 不带任何额外字段即 200，且 `scope_risks` 为 `undefined` |
| AC-9 无回归 | 通过 | 八个测试入口整组通过：内容快照 20、验收账本 30、运行版本 18、宿主 350、子代理 82、集成 33、客户端 232、安装 17，合计 782 项；`scripts/stamp-revisions.mjs --check` 输出 `Module revisions verified (6 modules).` |

### 后续调整：接受原因改为可选（2026-11-21）

按用户要求去掉两处必填的「接受原因」输入框（验收方案缺口确认区、例外结项确认区）：接受靠「看清清单再点确认」这个动作区分，不再靠用户打一段字。后端同步删除两道必填校验（`decideDoc` 的 `scopeRiskNote`、`gateValidation` 的 `acceptanceNote`），`scope.data.scope_risks.note`、`gate.gapAcceptance.note`、`scope.risks_accepted` 事件的 `note` 与 `flow.closure.note` 都改为「用户写了才出现」，不再留「未填写」占位；展示文案统一为「用户补充的接受原因：…」。

验证：`test/client.test.mjs` 两条用例改为断言确认按钮直接可用、确认区内无 `textarea`、提交载荷不带 `scopeRiskNote` / `acceptanceNote`；`test/host.test.mjs` 的 `sess-scope-risk` 组改为「带 `acceptScopeRisks: true` 即 200 且 `note` 为 `undefined`」，并新增「用户主动写的接受原因仍会随缺口一起落盘」；八个入口合计 782 项通过。

### 已知未通过项

无。

### 真实视觉未覆盖

`DocGate` 的缺口确认区、`ScopeBlock` 的缺口区块都只在组件树层面核对（文案、disabled 状态、提交的 payload），没有在真实 DSH 工作台里加载看过。缺口的四种风险各自都有单测与宿主测试，但「真实模型写出一个既有测试文件又有测试命令、验证步骤却不越界的 scope」这条干净路径没有端到端跑过——本机 `.dsh-flowgate/flows` 里没有任何流程记录过 `scope_risks`，因为这条体检是本次新加的，历史数据全在它之前。

## 评审子代理读取口径与并行读取记账（2026-11-21）

需求：核查「评审子代理读取能力与提示不一致」——提示要求子代理直接调用 `tools.ops_read_files`，但该工具在按需 SDK 环境里可能尚未加载；历史评审报告记录过 `TypeError: tools.ops_read_files is not a function`，子代理没读源码却提交 `verdict: pass`、空 findings；测试夹具预置了该工具，没有模拟真实加载。要求提示改用默认可用的读取工具或给出按需加载路径，保持只读守卫边界，读取失败或未检查目标文件时角度必须标未完成 / 未覆盖，不得因 findings 为空判通过。

核查结论：提示与降级路径已由提交 `ad26580`（2026-11-21 01:19）修掉——提示改为「优先直接使用默认可用的 `read`」，`readAttempts` 采集实际读过的路径，`runAngle` 在读取失败、缺痕迹、内容证据对不上时一律降级成 `uncovered`，S3 门禁随之拒绝通过。本轮补的是同一族里的一个残留缺陷：`childDenial` 记录读取痕迹时只调 `parseSingleToolCall`，`Promise.all` 并行读取（提示词明确鼓励的写法）不会被记账，`runAngle` 的 `attempted.has(file)` 校验会把「并行读到了」误判成「没尝试读」，把本该通过的角度降级成未覆盖。

改动范围：`lib/index.js`（新增 `recordReadAttempts`，同时处理单调用与 `Promise.all` 并行调用；`childDenial` 改为调用它；`anglePrompt` / `directionPrompt` 补 `ops_*` 默认未加载与 `ops_load_sdk` 的自救路径；`shellDenial` 与 `runCodeDenial` 的拒绝文案把 `ops_read_files` 改成 `read`）、`test/subagents.test.mjs`、`docs/development.md`。

| 验收项 | 状态 | 证据与限制 |
| :--- | :--- | :--- |
| AC-1 `Promise.all` 并行读取也计入读取痕迹 | 通过 | `test/subagents.test.mjs` 的「并行读取也算读过：Promise.all 读到目标文件后不判未覆盖」：子代理用 `return await Promise.all([tools.read({...session.ts}), tools.read({...other.ts})])` 读取，断言该角度 `coverage !== 'uncovered'` 且评审门禁能推进到 S4。反向验证：把 `recordReadAttempts` 里的 `parseParallelCalls` 分支临时改成 `null`，该用例立刻失败，说明新用例真的卡住了这个缺陷 |
| AC-2 并行读取没碰到目标文件时仍判未覆盖 | 通过 | 同文件「并行读取没碰到目标文件时仍判未覆盖」：并行只读 `other.ts` 与 `third.ts`，报告却声称检查了 `session.ts`，断言角度 `coverage === 'uncovered'` 且 `verdict !== 'pass'`，门禁 `pass` 请求返回 409 并匹配 `/读取失败|未检查/`。记账放宽不等于放水：读过的文件才算读过 |
| AC-3 提示给出按需加载路径 | 通过 | 「初始 SDK 未加载 ops_read_files：默认 read 与按需加载均通过只读守卫」新增两条断言 `/先调 ops_load_sdk/` 与 `/下一轮才能用/`；同一用例还断言 `ops_load_sdk({tools:['write_file']})` 被拒、加载后 `ops_read_files` 可用 |
| AC-4 提示不再要求直接调用未加载的工具 | 通过 | 既有断言 `doesNotMatch(/直接调用 tools\.ops_read_files/)`；`lib/index.js` 全文 grep 不到「直接调用 tools.ops_read_files」，两处拒绝文案也不再点名 `ops_read_files` |
| AC-5 读取失败或未检查目标文件不得生成评审通过 | 通过 | 既有六种失败形态（读取失败、读取失败且报告谎称已读、读取成功但报告遗漏内容证据、未读取目标文件、子代理主动报告未覆盖、报告伪称已读取但无调用）全部断言 `coverage === 'uncovered'` 且 `verdict !== 'pass'`，门禁 `pass` 返回 409 |
| AC-6 初始 SDK 不含 `ops_read_files` 时仍能完成授权读取 | 通过 | `test/integration.test.mjs` 断言 `sdk.ops_read_files === undefined`（初始不预加载）；`test/subagents.test.mjs` 的夹具在未加载时抛 `TypeError('tools.ops_read_files is not a function')`，复现真实失败形态而不是预置成功 |
| AC-7 无回归 | 通过 | 八个测试入口整组通过：内容快照 20、验收账本 24、运行版本 18、宿主 343、子代理 82、集成 33、客户端 226、安装 17，合计 763 项；`scripts/stamp-revisions.mjs --check` 输出 `Module revisions verified (6 modules).` |

### 已知未通过项

无。

### 真实视觉未覆盖

本轮改动集中在提示词与守卫判定，没有界面改动。未在真实模型驱动下端到端跑通「并行读取 → 角度通过 → S3 门禁通过」这条路径，验证只到组件与宿主黑盒层面。本机 `.dsh-flowgate/flows` 里 7 个有评审记录的流程，每个角度的 `checkedFiles` 都是 0，且评审时间全部早于 `ad26580`（2026-11-21 01:19），无法用真实数据证明修复后的读取痕迹确实落盘；唯一一条读取相关痕迹是 `f_b838f9eb-b9a` 的「正确性」角度记录了 `子代理未正常结束（error）`，它被降级成 `advisory` 而没有变成 `pass`，说明降级路径在真实数据里生效过一次。
## 例外结项与正常验收的状态语义分离（2026-11-21）

需求：最近多次流程以「带缺口」方式结束，AC 大量未覆盖、几乎没有通过，但结项逻辑仍然写 `gate.passed` 与 `flow.finished`；工作台门禁按钮与 dock 快捷按钮点击时自动附带 `acceptUncovered: true`，接受说明可以为空；另有流程测试提交 `failed: 0`，而 AC 实际是 0 通过 / 3 未覆盖（`failed` 只统计测试要点里的失败项）。要求把「测试要点失败数」「AC 通过/失败/未覆盖数」「流程结束方式」分开统计与展示，带缺口结项要独立确认、列出缺口、记录接受原因，不得在汇总、按钮或对外状态中等同于全部验收通过，同时保留用户接受风险并结束流程的能力。

改动范围：`lib/index.js`（`gateValidation` 的 `acceptUncovered` 与 `acceptanceNote` 双门槛、新增 `countPointResults` / `gapSentence` / `closureSentence`、`passGate` 的三分阶段记录与 `flow.closure`、`gate.accepted_with_gaps` 事件、视图 `closure` 字段、`flowgate_status` 摘要与 `hubFlowSummary`）、`lib/client.js`（新增 `gapLedger` / `CLOSURE_TEXT` / `closureOf`、门禁卡的验收账本行与「例外结项确认」两步流程、结束态徽标与缺口明细、dock 不再一键结束、`.fg-warn` 样式）、`test/host.test.mjs`、`test/client.test.mjs`、`test/integration.test.mjs`、`test/subagents.test.mjs`、`docs/development.md`。

| 验收项 | 状态 | 证据与限制 |
| :--- | :--- | :--- |
| AC-1 全部通过时仍是一步结束，且不发送例外许可 | 通过 | `test/client.test.mjs` 的「S4全部通过时沿用原按钮且不发送例外许可」：点「验收通过，结束流程」后 `payload.acceptUncovered === undefined`。`test/host.test.mjs` 的既有门禁用例断言 `acceptanceDecision.status === 'passed'`、`gate.passed` 事件、`flow.closure.kind === 'passed'` |
| AC-2 存在未覆盖项时不得读作全部通过 | 通过 | 客户端「S4未全通过时使用明确结束文案，两步确认后才提交例外说明」断言没有「验收通过，结束流程」按钮、主按钮为「接受未覆盖并结束（需确认）」；「流程以带缺口方式结束后，门禁卡显示缺口而不是绿色已完成」断言结束态门禁卡文案不含「流程已结束」与「已完成」，只报「带缺口结束」与缺口明细 |
| AC-3 存在未通过项时缺口逐条列出且原因必填 | 通过 | 「S4 点例外按钮先展开缺口清单，不直接投递」：第一次点击 `posted.length === 0`，展开「这些项目不会被标记为通过」「未通过的测试要点（2 个）」并逐条列出方向 · 要点 · 状态，未填原因时确认按钮 `disabled === true`；「S4 写明接受原因后才提交带缺口结项」断言 `acceptanceNote` 原样提交。宿主侧 `gateValidation` 对空白原因返回 409（`test/host.test.mjs` 的 `acceptanceNote` 相关用例、`test/integration.test.mjs:481`） |
| AC-4 测试要点 `failed: 0` 但 AC 零通过时两套账分别显示 | 通过 | 「测试要点 failed: 0 但 AC 一条没过时，两套账分别显示」：断言「验收标准：通过 0 · 未通过 0 · 未覆盖 3 · 待验证 0（共 3 条）」与「测试要点：通过 0 · 失败 0 · 未覆盖 1 · 环境受限 0（共 1 个）」同时出现，且不提供「验收通过，结束流程」 |
| AC-5 快捷入口不能绕开例外确认 | 通过 | 「阶段提示：放弃要两次确认，S4 带缺口时不提供一键结束」：dock 不渲染「接受未通过项并结束」与「接受未覆盖并结束」，只留「退回开发修复」，并给出「验收标准通过 0 / 1」与「带缺口结束要在『出口门禁』里看清缺口并写明原因」，且不投递任何请求 |
| AC-6 持久化状态与事件区分结束方式 | 通过 | `test/host.test.mjs` 与 `test/integration.test.mjs` 的例外结项用例断言 `acceptanceDecision.status === 'accepted-with-gaps'`、`flow.closure.kind === 'accepted_with_gaps'`、阶段 `gate: 'accepted_with_gaps'` 与 `gate.accepted_with_gaps` 事件；`test/integration.test.mjs` 的 flows.jsonl 事件用例确认事件类型与 `closure` 字段落盘 |
| AC-7 无回归 | 通过 | 八个测试入口整组退出码 0：内容快照 20、验收账本 24、运行版本 18、宿主 343、子代理 80、集成 33、客户端 226、安装 17，合计 761 项；`scripts/stamp-revisions.mjs --check` 输出 `Module revisions verified (6 modules).`，八个文件 `node --check` 通过 |

### 已知未通过项

无。

### 真实视觉未覆盖

门禁卡的「验收账本」行、「例外结项确认」区块与结束态「带缺口结束」徽标只在 `test/client.test.mjs` 的组件树层面核对文案、置灰与提交载荷，未在真实 DSH 工作台加载确认排版（尤其缺口清单较长时的换行与高度）；`.fg-warn` 只用了主题里已定义的 `state-warn-secondary` / `state-warn-label`，实际观感未取色测量。宿主侧的三分结束方式均有直接断言，但未在真实模型驱动的一次完整流程里端到端跑通「展开缺口 → 填原因 → 结束」这条路径。

## 只读边界放宽与例外入口（2026-11-21）

需求：把「命令执行范围限制」放宽到不阻碍评审与测试，同时不放弃默认拒绝。六条：内置测试方向可声明写权限；只读子代理可用只读 Git；scope 命令清单的无效条目在 S1 就报错；已授权命令放行 `2>&1` / `| tail` 这类无害收尾；只读子代理的 `run_code` 允许 `Promise.all` 并行只读；未登记的只读工具可由用户声明豁免。

改动范围：`lib/index.js`（`SHELL_HARMLESS_SUFFIX` 与 `stripHarmlessSuffixes`、`SHELL_READONLY` 的 Git 分支、`readonlyDenial` 的 shell 与 `run_code` 分支、`PARALLEL_CALL` / `parseParallelCalls`、`normalizePendingScope` 的 `commandErrors`、`TOOL_ALLOW_*` / `normalizeToolAllowlist` / `isToolAllowlisted`、`declareDirectionWrite` / `setToolAllowlist` 动作与视图字段 `writeDeclared` / `toolAllowlist`）、`lib/client.js`（内置方向的写权限声明与撤销入口、「只读豁免」设置组）、`test/host.test.mjs`、`test/client.test.mjs`、`test/subagents.test.mjs`、`test/integration.test.mjs`、`README.md`、`docs/development.md`。

| 验收项 | 状态 | 证据与限制 |
| :--- | :--- | :--- |
| AC-1 内置方向可声明写权限，撤销时连带撤销授权 | 通过 | `test/host.test.mjs` 的「内置方向也能声明写权限并在撤销时连带撤回授权」：`declareDirectionWrite` 后 `needsWrite === true`，`toggleWriteGrant` 后 `writeGrants` 含该 id，撤销声明后不再包含；未知 id 返回 409。`test/host.test.mjs` 另断言声明同时进入 `stageConfigs.S4.catalog`（设置弹窗读的是这份目录，不是 `directions`，两处不同步时界面看不出声明已生效）。`test/client.test.mjs` 覆盖声明入口是按钮而非勾选框（勾选框的 `checked` 写死会表现为「勾不动」）、点击提交 `enabled: true`、目录滞后时按 `view.directions` 实时状态渲染、面板直接显示流程里的原始声明列表（`directionWriteDeclared`），以及按钮「撤销写权限声明」提交的 `enabled: false` |
| AC-2 只读子代理可用只读 Git，写 Git 仍拒 | 通过 | `test/subagents.test.mjs` 的「最终守卫默认拒绝未知、写入、任意 JS 与后台任务」断言 `git diff --stat` / `git status` / `git log --oneline -5` 放行；`test/integration.test.mjs` 的 AC-4 用例断言 `git push` / `git commit` / `git checkout` / `git diff \| tee out.txt` / `node -e` 仍拒 |
| AC-3 scope 命令清单的无效条目在提交时报错 | 通过 | `test/host.test.mjs` 的「无法生效的命令条目在提交时就拒绝，不留待批准文档」：空条目、超 300 字、含解释器内联、超 20 条四类均 `assert.rejects`，且失败后 `stage === 'S1'`、`doc.pending === false` |
| AC-4 无害输出后缀放行，真管道仍拒 | 通过 | `test/host.test.mjs` 的「无害输出后缀不算逃逸，剥掉后缀后仍按原命令判定」：`npm test 2>&1` / `npm test \| tail -n 20` / `npm test > /dev/null` 放行；`npm publish 2>&1` / `npm test \| rm -rf src` / `npm test 2>&1; touch x` 仍拒 |
| AC-5 子代理 `run_code` 支持 `Promise.all` 并行只读 | 通过 | `test/subagents.test.mjs` 允许单行与多行两种 `Promise.all` 形状；拒绝夹写工具、夹 `run_code`、非严格 JSON、`.then` 链、先赋值再 `return` 五种形状 |
| AC-6 未登记只读工具可由用户声明豁免，写工具与 shell 不可豁免 | 通过 | `test/host.test.mjs` 的「未登记工具默认拒，用户声明只读后放行」：`unlag_refresh` 默认拒、声明后放行；`write` 仍按 scope 判（S2 写 scope 内放行、越界拒）；S1 声明 `str_replace_editor` 仍拒；`ops_bash` 带豁免跑 `npm publish` 仍拒。`setToolAllowlist` 对 `write` / `ops_bash` / `run_code` / 非法名字返回 409，重复项去重后存一条。`test/client.test.mjs` 覆盖「只读豁免」面板的文案、初值与按行提交 |
| AC-7 无回归 | 通过 | 八个测试入口整组退出码 0：内容快照 20、验收账本 24、运行版本 18、宿主 343、子代理 80、集成 33、客户端 226、安装 17，合计 761 项；`scripts/stamp-revisions.mjs --check` 输出 `Module revisions verified (6 modules).`，八个文件 `node --check` 通过 |

### 已知未通过项

无。

### 真实视觉未覆盖

客户端新增的「撤销写权限声明」按钮与「只读豁免」设置组只在 `test/client.test.mjs` 的组件树层面核对文案、初值与提交载荷，未在真实 DSH 工作台加载验证，不构成真实视觉通过证据。宿主侧的六条判定均有直接断言，但未在真实模型驱动的一次完整流程里端到端跑通。

真机反馈一条已修：用户点「声明该方向需要写权限」时看不到任何反应。原因是该入口原本是 `checked: false` 写死的勾选框，提交成功后同一行立刻换成「已声明」状态，视觉上等于勾上就弹回；数据其实已经写入（`directionWriteDeclared` 与 `write.declared` 事件都在）。现改为按钮，并在非 S4 阶段不再摆灰着的「授权执行变更性命令」勾选框，只报「已声明需要写权限」状态。

真机反馈第二条已修（更深的一层）：改完按钮后用户仍报「点了没反应也不消失」。真正原因在读取侧——设置弹窗读的是视图的 `stageConfigs.S4.catalog`，而该字段由裸 `stageConfig` 生成，没有合并 `flow.directionWriteDeclared`；只有 `view.directions` 与 `view.directionCatalog` 走了 `withDirectionWriteDeclared`。于是声明确实写进了流程（`f_08a11e91-55a` 的 `directionWriteDeclared: ["smoke"]` 与 `write.declared` 事件都在），弹窗那一行却永远显示「未声明」。修复：`lib/index.js:2428` 起 S4 的 `catalog` 与 `items` 都套 `withDirectionWriteDeclared`；`lib/client.js` 的目录映射同时合并 `needsWrite` / `writeDeclared`；并在「测试方向」面板顶部直接显示 `directionWriteDeclared` 原始列表，让用户能分清「数据没写进去」与「界面没刷新」。修复后客户端 223 项、全量 758 项通过，仍需用户在重启后的工作台重新点一次确认。

## dock 阶段流转按钮（2026-11-20）

需求：输入框上方那一行（dock）要按当前阶段给出各自的流转按钮，文案与置灰样式跟左侧栏「流程工作台」一致；需求分析（S1）一旦开始，「开始需求分析」入口必须消失；流程开始后常驻的只能是结束入口；四个阶段可查看与可操作的按钮各不相同。

改动范围：`lib/client.js`（新增 `HintActions` 组件与 `.fg-hint-actions` / `.fg-hint-btn` 系列样式，dock 渲染段改为按流程状态分流）、`test/client.test.mjs`（改写与新行为冲突的旧断言，新增五条）。`lib/index.js` 未改：dock 只复用了既有的 `act()` 与 `finalGateLabel()`，没有新增宿主接口。

| 验收项 | 状态 | 证据与限制 |
| :--- | :--- | :--- |
| AC-1 活动流程时不再出现启动入口 | 通过 | `test/client.test.mjs` 的「阶段提示：工作区摘要优先…」断言按钮数 0 且没有「开始需求分析」；「阶段提示：没有流程、已结束或已放弃时仅保留快捷入口」保证无流程时入口仍在 |
| AC-2 S1 只在文档待裁决时给三键 | 通过 | 「阶段提示：dock 给出本阶段的流转按钮，四个阶段各不相同」断言 S1 为「批准并冻结 scope / 修改需求 / 跳过评审，直接开发 / 放弃这次流程」；「S1 未交文档只留放弃」覆盖 `doc.pending` 为假的情形 |
| AC-3 S2 三键与就绪态 | 通过 | 同上用例断言 S2 按钮集合；「流转按钮的置灰与门禁就绪同源」分别覆盖未就绪（disabled 为真）、`waiting` 为真、`gate.pending` 为真三种情形，并断言「回到需求分析调整 scope」带危险色 class、主按钮带主色 class |
| AC-4 S3 有 scope 外发现时先让回需求分析 | 通过 | 「S1 未交文档只留放弃，S3 有 scope 外发现时先让回需求分析」断言追加按钮的位置在「退回开发修复」之前，且同时显示越界原因和数量 |
| AC-5 S4 主按钮取 `finalGateLabel`；有缺口时 dock 不给一键例外结束 | 通过（口径已更新） | 原断言为「点击『接受未通过项并结束』后 `payload.acceptUncovered === true`」。该行为已按「例外结项与正常验收的状态语义分离」改掉：dock 在有缺口时不再提供例外结束按钮，只保留「退回开发修复」并指向出口门禁。现断言见「阶段提示：放弃要两次确认，S4 带缺口时不提供一键结束」 |
| AC-6 结束流程入口常驻且需两次确认 | 通过 | 同一用例断言首次点击不发请求、`再想想` 回到原按钮、确认后投递 `cancel` 且带 `reason`；「投递失败要留下可诊断的错误行」验证 HTTP 500 时出现 `role=alert` 与宿主错误文案 |
| AC-7 四阶段按钮集合两两不同 | 通过 | 「dock 给出本阶段的流转按钮，四个阶段各不相同」用 `Set` 比对四组文案；无效 stage 的按钮兜底与工作台一致 |
| AC-8 新增按钮不破坏 dock 宽度契约 | 未覆盖真实视觉 | `.fg-hint` 的 `width` / `max-width` 公式未改，既有「阶段提示样式：沿用宿主宽度变量和居中规则」仍通过；按钮组自带 `flex-wrap: wrap` 与 `min-width: 0`，文字可换行 |
| AC-9 无回归 | 部分通过 | `node test/client.test.mjs` 203 项全通过；`npm run check`（六模块版本标记 + 七个文件语法检查）退出码 0；`npm test` 在 `test/provenance.test.mjs` 的既有用例 14「external directory junction is rejected before reading its target」上失败，见下 |

### 已知未通过项

`npm test` 三次均在 `test/provenance.test.mjs:211` 失败，首轮报错 `ENOTEMPTY: directory not empty, rmdir 'C:\\Users\\lonsdor\\AppData\\Local\\Temp\\dsh-U05QNJ\\flowgate-provenance-jemCK5\\workspace'`，抛出点在 `test/provenance.test.mjs:32` 的 `fixture` 收尾 `fs.rmSync(home, { recursive: true, force: true })`。该文件与本轮 dock 改动无关（`lib/client.js` 未被它引入），是 junction 用例清理临时目录时的 Windows 竞态；其余 19 项在该文件内通过，后续七组测试因 `npm test` 用 `&&` 串联而未执行。本轮未修该文件（不在冻结 scope 内），如实记为未通过。

### 真实视觉未覆盖

当前验证环境没有可用的已认证桌面页面接入或 CDP，无法采集真实参照矩形，未启动浏览器或新服务，也未用 file 预览代替。AC-8 的宽度契约只按静态 CSS 断言与既有用例核对，不构成真实视觉通过证据。

## 本轮证据契约与布局脚本验证（2026-11-19）

本轮分别记录实现、验证、运行生效，不能用其中一项替代另一项。已使用捆绑 Node 的绝对路径执行标准测试清单的全部八组测试：内容快照 20、验收账本 24、运行版本 18、宿主 299、子代理 71、集成 33、客户端 190、安装契约 17，合计 672 项通过；另有七个生产与诊断文件语法检查、六模块版本标记核验及下表脚本自检通过。标准包管理器入口因宿主 Windows 子进程 PATH 找不到 `node` 未能直接运行，以上结果来自同一清单逐组执行，未把启动失败计作通过。最终差异复核补上的硬上限省略项严重度边界回归已纳入宿主 299 项并通过，以下记录布局脚本的具体范围。

| 层次 | 状态 | 证据与限制 |
| :--- | :--- | :--- |
| 文档与取证脚本实现 | 已完成 | 使用指南、开发契约与变更记录说明内容哈希整轮失效、逐 AC 证据、MINOR 独立计数、退回清单、运行版本核对和真实视觉未覆盖口径 |
| 脚本语法 | 通过 | 捆绑 Node 执行 `node --check docs/verify-layout.mjs`，退出码 0 |
| 中文帮助 | 通过 | `node docs/verify-layout.mjs --help`，退出码 0，明确已有地址、页面、会话与两条真实参照必填 |
| 脚本纯函数边界 | 通过 | `--self-test` 25 项断言（含参照 selector 规范为名称、版本 mismatch、页面身份/视口缺失或不一致、宿主回执 ID/内容版本缺失）：缺参、未知参数、无效容差、相同参照、file 预览、无唯一 target、版本未核对/缺失/不匹配、测量缺失/无效及超容差；不连接 CDP |
| 真实桌面端视觉校验 | 未覆盖 | 当前验证环境没有可用的已认证桌面页面接入或 CDP，无法采集真实参照矩形；未启动浏览器或新服务，未使用 file 预览代替 |
| 当前运行版本已生效 | 未核对 | 尝试工作台刷新工具返回 blocked，提示“在右键菜单里打开 Agent 可以自己刷新”；未实际完成刷新，尚无运行宿主、磁盘宿主、实际执行客户端工厂与磁盘工厂四个 SHA256 一致的运行证据 |

每条 AC 的记录需包含 `method`、`procedure`、`status`、`evidence`、`version`。内容指纹变化后旧轮证据不可复用。MINOR 计数与 AC 验证结果独立，零阻断也不能视为全 AC 通过。缺少认证、CDP 或插件 API 的真实视觉项记录 `uncovered`；用户显式接受例外只表示接受这项限制，不把结果变为通过。运行诊断中 `mismatch` 与 `unverified` 均不构成生效证据，布局取证应记 `uncovered`，而非布局失败。页面身份或视口证据缺失或不一致同样未覆盖。

当前自动视觉采集器只证明左右边界对齐；颜色、主题等其它视觉要求缺少对应可信采集器时保持 `uncovered`，非空截图路径字符串不能据此变成 `pass`。布局回执只关联本机受支持客户端的采集链路，不能宣称它能够抵抗有权限主动伪造 HTTP 请求或脚本的行为，也不能把该关联当作安全证明。本轮真实 GUI 仍未覆盖。

## DSH 0.2.2-rc.5 兼容核对（2026-11-18）

| 核对项 | 结果 | 依据 |
| :--- | :--- | :--- |
| 宿主准入（导致「插件不兼容」的直接原因） | 已修复 | 原 `engines.dsh` 是精确版本 `0.2.2-rc.3`，宿主升到 rc.5 后 preflight 判定不满足，把插件行标成 `disabled`，界面与工具全部消失。改为范围 `>=0.2.2-rc.3 <0.3.0-0` |
| `subagents` 协议 | 未变 | rc.5 源码中 `startActivation` / `getProvider` / `SubagentActivationSpec`（含 `delivery`、预留 `childId`）/ `SubagentActivation` / `prepareContinuable` 签名与 rc.3 一致 |
| 工具侧契约 | 未变 | `tools.register`、`tools.guard`、`tools/pre-execute`（`PreToolDecision`）均在 rc.5 存在 |
| 会话与唤醒 | 未变 | `agents` 服务的 `get(id)`、`agent.followup(message)` 仍在 |
| 客户端契约 | 未变 | `dsh.client` 只认 `platform` / `inject` / `external` / `immediately`；`sidebar.panellist`、`main` 插槽与 `uiWorkspace`（`pickDirectory` / `openSession` / `connectWorkspace`）、`workspaces.create({ path })` 均在 rc.5 存在 |
| 自动化验证 | `pnpm test` 全通过 | 宿主 128、子代理 46、集成 28、客户端 118、安装 17；其中安装就绪度新增 4 项把兼容范围钉成断言 |
| 重启后实机验证 | 未执行 | 需要完全退出并重启 DSH 后才载入新清单；本轮在运行中的宿主里无法完成 |

准入判定用与宿主相同的规则复刻在 [`test/install.test.mjs`](../test/install.test.mjs)：宿主只看 `engines.dsh`（存在时忽略 `peerDependencies`），并按 `semver.satisfies(..., { includePrerelease: true })` 判定。

## 新版子代理修复验证（2026-11-18，DSH 0.2.2-rc.3）

| 验证层次 | 当前状态 | 范围与限制 |
| :--- | :--- | :--- |
| 官方源码契约核对 | 已核对 DSH `0.2.2-rc.3` | `startActivation`、`getProvider('spawn')`、预留 `childId`、`delivery: 'caller'`、`{ childId, name, messageId, result, dispose }`；旧 `start` / `list` 与 `toolFilter` 不属于新版契约 |
| 自动化与测试替身验证 | `pnpm test` 通过，275 项通过，另 1 个环境跳过项 | host 105、subagents 46、integration 23、client 88、install 13；新增用例核验执行前只读登记、最终工具守卫、S4 写授权、取消清理、降级与报告有效性。原有 child_process 采集变更摘要用例因环境禁止 spawn git 跳过，不计作通过 |
| 语法与补丁检查 | `pnpm run check`、`git diff --check` 通过 | 对宿主和客户端入口执行语法检查；本轮未修改客户端 |
| 重启后的实机验证 | 未执行 | 仍需核实真实 activation 执行、有效报告、最终守卫拒写和取消清理；历史聚合结果不能代替本轮证据 |

兼容元数据当时声明的是上述已核对的精确版本；此后已改为范围 `>=0.2.2-rc.3 <0.3.0-0`（见[开发与维护](development.md#dsh-版本兼容声明)），因为精确版本会让宿主在每次小版本升级时静默禁用插件。Node `>=20` 要求不变。默认只读 shell 仅接受精确的 `pwd`；Git、`script_path`、解释器和包测试脚本默认拒绝，变更性 shell 仅在 S4 对应方向的 `needsWrite` 与用户 `writeGrants` 同时满足时放行，代码写工具仍拒绝。

当前 desktop profile 使用 `link:D:/Projects/dsh-flowgate`。本轮仅改宿主 JavaScript 时无需重新安装，也无需客户端改动；完全退出并重启 DSH 后才加载新模块，浏览器刷新无效。本会话不重启，实机结果待实际验证后补记。

## 实机验证记录（2026-11-17，桌面端 0.2.2-rc.3）

五条流程在真实桌面端跑通，每条都是「用户点按钮 → 宿主状态机推进」，Agent 只在中间调工具：

| 流程 | 验到的 | 结论 |
| :--- | :--- | :--- |
| 会话过期返回 401 | AC-1 / AC-3 / AC-5 / AC-8 | S1 写操作被拒；两次追问卡片点选完成；越界写被拒并给出回退指引；16 条事件落盘 |
| 跳过与升档 | AC-2 / D3 | 门禁点「跳过评审直接开发」后 scope 仍冻结、S1 记 `skipped_by_user`、台账计数 1，S2 可进入 |
| 评审升档回退 | AC-6 / AC-7 | fast 起步 → S3 评审 2 角度发现 1 个 CRITICAL（落在 scope 内）→ 点升档 → 回退 S2 → 重做后评审 4 角度、测试 3 方向；scope 始终 1 个文件（未扩充） |
| 严格档全流程 | AC-6 | S1 门禁直接选严格档，评审 4 角度、测试 3 方向，含 `fail` / `uncovered` 结果正常聚合 |
| 升档后重做 | D1 | 两次 S2 都不需要用户贴 diff，摘要由宿主自动采集（本轮实测暴露采集根因，见下） |
| D4 实机：越界发现升档 | D4 | S3 一条 CRITICAL 落在 `src/config/secrets.ts`（scope 外）→ 点升档 → `flow.rollback {"to":"S1","reason":"upgrade-scope-overflow"}`、`scopeFrozen:false`、`scope.data:null`；重新批准时把该文件补进 scope（2 → 3 个文件）后才继续 |

实机验证期间发现并修掉的真实缺陷：

- **变更性 shell 在 S2 被放行**：`rm -rf src/api` 真的执行了。现在 S2 默认只允许只读 shell，变更性命令需要用户在「开发变更」卡片里显式勾选「允许执行构建/测试命令」；重定向、管道与解释器内联执行在任何阶段都拒绝。
- **shell 工具名硬编码 `bash`**：本 profile 装的是 dsh-ops，真名 `ops_bash`，守卫对真实 shell 完全失效。
  改为 `SHELL_TOOLS` 集合后 `ops_bash` / `powershell` 等别名同样受管。
- **升档清空开发规则**：`flow.overrides` 整体重置会把用户勾选的规则一起丢掉，现在只重置角度与方向。
- **D1 在 dsh-ops profile 下采集不到变更**：`collectChanges` 读 `ctx.get('shell')`，而桌面端装的是 dsh-ops，
  它的 shell 组件开头就是 `if (retiredLegacyRow(ctx, 'shell')) return;` —— 官方 `shell` 服务根本没注册，
  两次 S2 的 `dev.summary` 都是 `files: []` 加一条 `error`。现在改成三级降级：优先宿主 shell 服务，
  没有就用 `node:child_process` 直接跑 `git status --porcelain=v1` / `git diff --numstat`（摘要带 `via` 标明来源），
  两条路都失败才把原因写进 `error`。

D4 的两半现在都有实机证据：发现全在 scope 内时回退 S2（「评审升档回退」那条），发现落在 scope 外时回退 S1
并在重新批准时扩充 scope（「D4 实机」那条）。`test/host.test.mjs` 的「D4 升档遇到 scope 外发现时回退 S1
而不是 S2」用例把同一判定钉在单测里：回退目标、`reviewOutsideScope` 内容、scope 不自动扩充、旧白名单不再放行。
