# 验证记录

[返回使用指南](../README.md) · [开发与维护](development.md#测试)

以下记录迁自原使用说明，保留当时的环境与结果，不代表本次文档修改重新执行了这些测试。表中的 AC / D 编号沿用当时验收项编号。当前操作方法以[使用指南](../README.md)为准，测试命令见[开发与维护](development.md#测试)。

历史记录中的 `by: 'subagents'` 仅表明调用了子代理聚合入口；聚合报告通过、`blocking: 0` 或流程走完，均不能证明真实子代理成功执行并返回有效报告。下文原有结论保留，其证据范围受此限定。

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
