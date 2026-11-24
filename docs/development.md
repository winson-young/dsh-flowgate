# 开发与维护

[返回使用指南](../README.md) · [验证记录](verification.md)

## 桌面端安装

桌面端由 Electron 管理 `desktop` profile，原有 CLI 安装命令不适用于这个 profile。先完全退出桌面端，备份 `%USERPROFILE%\.dsh\profiles\desktop\package.json`，再在已有配置中**合并**下面两项，保留其他条目：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [ /* 保留原有条目，在末尾追加 */ "dsh-flowgate" ]
    }
  },
  "dependencies": {
    /* 保留原有依赖 */
    "dsh-flowgate": "link:D:/Projects/dsh-flowgate"
  }
}
```

将路径换成本项目的实际位置。在 Bash / Git Bash 中执行：

```bash
cd "$USERPROFILE/.dsh/profiles/desktop"
pnpm install --prefer-offline
```

重新启动桌面端。在本项目目录运行 `npm run test:install`，核对 profile 清单、软链和 bundle 契约。该检查需对应的 profile 已安装插件，详见下方测试说明。

## 修改范围与只读边界

S1 批准或跳过文档批准后，宿主冻结 scope。S2 对写入 / 编辑 / 删除 / 移动 / 复制 / 批量这类会落盘的工具，按 `in_scope.files_expected_to_change` 核对路径；名单使用相对项目根的具体文件路径，按精确路径匹配，不支持目录或 glob 授权。`ops_replace` 也必须显式提供与清单文件精确相等的 `path`，不能用目录、`.` 或清单文件的后代路径替代；批量替换应拆为逐文件调用。越界时返回调整 scope 的指引。修改磁盘上的范围文件不会直接更新运行中的授权，应回 S1 重新提交并批准。

冻结前还有一道**验收方案体检**（`scopeReadiness`）：能在静态确认的矛盾直接拒收，只能推断的风险则必须让用户看见。硬阻塞两种——验收标准缺 `id`（S4 无法把执行证据挂到它身上，它永远是未覆盖）、`id` 重复（同一条证据能同时顶两条 AC）。风险四种——声明了可执行验证（`unit` / `integration`）却没有能识别的测试命令、集成验收但 scope 里没有任何测试文件、验证步骤点名了 scope 之外的文件（目录级覆盖也算覆盖，`manual` 方法不检查）、视觉验收没写测量方式。风险不拦流程，但也不留给用户替 Agent 收拾：`flowgate_doc` 提交时若体检报出风险，直接退回给 Agent 补齐，不挂门禁，也不摆到「批准并冻结 scope」前面。退回按缺口签名（缺口 `code` 去重排序拼成的串）计数，同一批缺口连续出现三次就 `cancelFlow` 结束这条流程——否则 Agent 会一直重交同一份 scope，用户等一个永远等不到的按钮。计数与上一轮的缺口原文分别存在 `flow.scopeRiskStrikes` / `flow.scopeRiskLast`，视图对应 `doc.scopeRiskStrikes` / `doc.scopeRiskLast`，工作台与 dock 都能就地摊开看；提交成功、或从冻结态退回 S1 补命令清单时，两者一起归零。`decideDoc` 仍保留 `acceptScopeRisks: true` 这条显式接受的路径（冻结落盘写 `scope.data.scope_risks` 与 `scope.risks_accepted` 事件），但正常流程走不到它：缺口在提交时就已经退回去了。接受缺口只表示「知道方法对不上、仍然先走」，不表示缺口算通过：S4 仍按每条 AC 声明的方法核验证据，`unit` 证据顶不了 `integration`。体检放在冻结前而不是 S4，是因为方法对不上证据到 S4 才发现，只剩带缺口结项或整轮退回两条路。缺口清单一律以服务端重算结果为准，界面不自己推断；客户端在操作失败后补拉一次 `/state`，避免服务端已经改口而界面还摆着旧结论。

守卫按**只读白名单**工作：只有显式登记为无磁盘副作用的工具（读取、检索、任务调度、上下文管理、flowgate 自身）直接放行，其余工具一律进入路径核对；没有登记的工具按拒绝处理。这样宿主新增一个写工具时不会静默放行，代价是漏登记的工具会被误拒。漏登记有两个出口：插件侧把它登记进 `PASSIVE_TOOLS`，或用户在工作台「阶段设置 → 只读豁免」里声明（`toolAllowlist`，最多 12 条）。豁免只对既不是写工具、也不是 shell、也不是 flowgate 自身状态工具的未知工具生效：写工具照旧按 scope 核对路径，shell 照旧按自己的命令规则判定，豁免名单不会变成后门。

目标表 `TOOL_TARGETS` 逐项声明正式参数名、是否必填、能否枚举。`write` / `edit` 只取 `file_path`，`str_replace_editor` 与 OPS 单文件工具只取 `path`，移动和复制必须同时提供 `path` / `to`，不猜测 `dest`、`file`、`filename`、`source` 等别名。结果分为明确无写入、完整目标列表和无法核对；缺目标、空白、错误类型不能用空数组冒充无写入，必须明确拒绝。

五条额外边界：

- **scope 条目在提交时规范化**：`flowgate_doc` 收到的 `files_expected_to_change` 里，绝对路径与项目根之外的条目会被剔除，剔除结果通过 `droppedScopeEntries` 回给界面，并在工作台「待冻结 scope」卡片里列出。批准前用户看到的就是最终放行的清单。`commands` 清单同样在提交时收敛：去空白、去重；空条目、超过 300 字、含重定向 / 管道 / 解释器内联（这类条目在判定顺序上永远排不到放行）、含换行、方括号目录后缀不是流程根之内的相对目录、总条数超过 20 条，都直接报错拒收而不是安静存下——清单长到没人逐条看，或者存着一条永远不生效的命令，都等于又一个空白授权。
- **流程数据目录不对外开放**：`.dsh-flowgate/` 由插件自身维护，任何工具对它的写入都被拒绝（含 S2）。判断按路径段匹配，`../.dsh-flowgate/x` 与 `D:/任何目录/.dsh-flowgate/x` 同样命中；否则 Agent 可以改写自己的 scope 与规则。
- **`run_code` 只转发工具调用**：程序里出现 `import(`、`require(`、`node:fs`、`child_process`、`fs.`、`writeFile`、`eval(`、`Function(` 等痕迹即拒绝——判定前先剥掉字符串字面量与注释，否则 `ops_bash({ command: 'rmdir .tmp-x' })` 这种正常清理命令、以及 `// 清理 rmdir 残留` 这种说明文字，都会被当成 Node IO 整条拒掉；能解析成 `await tools.x(严格 JSON)` 的单次调用时，按被调用的那个工具再判一次（单调用开头/结尾的注释不算程序内容，`// plan: …` 这类必填的首行说明不会让解析失败）；解析不出来但程序里提到了需要核对 scope 的工具名（含 `tools['x']` 括号访问）也拒绝，因为多语句程序取不到真实参数（shell 工具除外：它的命令文本会被嵌套调用自己的守卫再判一次）。
- **执行批量操作必须内联**：`ops_batch` 的 `action: 'run'` 必须显式提供 `operations`，每项声明 `op: 'copy' | 'move' | 'remove'` 及完整正式目标；`root` 参与所有目标的路径解析（`root: 'D:/'` + `path: 'evil.txt'` 不会被当成项目内文件）。显式空数组表示无文件变更；`action: 'plan'` 仅生成无效应审计计划，走专用只读判定。`resume` 的历史计划及执行时的 `operationsRef` 无法静态核对，直接拒绝。
- **带写盘的上下文工具同样过守卫**：`decompress` 省略 `toFile` 的普通上下文恢复、`imageRef: 'list'` 可以只读放行；显式提供的 `toFile` 必须是有效且获批的精确路径。恢复具体图片会自行选择落盘路径，无法静态核对，拒绝执行。

S2 的 shell 默认只允许只读命令（`pwd`、`ls`、`cat`、`git status/diff/log/branch --list` 等），重定向、管道、子 shell、`--output` 与解释器内联执行（`node -e`、`python -c`、`npx`）在任何阶段都拒绝——授权之后也拒绝，因为这类命令的写目标是运行时算出来的。判定前会先剥掉尾部纯收尾的输出后缀：`2>&1`、`> /dev/null`、`| tail -n 20`、`| head -50`，可以多层叠加（`npm test 2>&1 | tail -5`）。它们既不写盘也不换执行体，卡住它们只会让已授权的测试命令永远跑不了。只剥末尾且形状固定：`npm test | tee out.txt`、`npm test | rm -rf src` 剥不动，照旧拒绝。命令必须单行，这一条在入口单独判：`shellDenial` 拿到命令后先看有没有换行或回车，命中就直接拒绝并写一条 `multiline` 审计事件——换行与 `;`、`|` 一样是命令分隔符，审查只看到第一行、shell 执行全部内容，所以不能等它落到后面的分支再判。只读白名单的尾部同样只接受空格与制表符，两层都不放过换行夹带：`pwd\nrm -rf src` 既不会被当成 `pwd`，也不会被当成 `pwd` 加一个无害收尾。子代理通道的 `readonlyDenial` 用同一条断言，理由文案也点名换行。需要跑构建或测试时只有一条通道：把命令写进需求文档的 `scope.commands` 清单，由用户在 S1 批准 scope 时一并过目。清单命中的命令在 S2 / S4 直接执行，没有别的开关。放行仍按阶段判定——S1 与 S3 里即使命令在清单中也只接受只读命令。`shellDenial` 的判定顺序是：换行（进入下面这条顺序之前先判）→ 逃逸痕迹（重定向 / 管道 / 解释器内联）→ 只读白名单 → 纯解析命令（仅生态表逐条声明的安全固定参数与位置文件；例如 `node --check` 后接一个明确文件，任何阶段都可免授权）→ scope 命令清单（`in_scope.commands`，随需求文档一起批准，`S2` / `S4` 命中即放行，末尾 `*` 只做前缀通配）。清单命中还要对上**执行目录**：条目可以带方括号后缀 `npm run build [packages/web]`，没带后缀的等价于 `[.]`，只认流程根，子目录要另写一条（精确匹配，不给目录前缀覆盖留口子）。判定用的目录取自 shell 工具自己的 `workdir`（`ops_bash({ command, workdir })`），缺省才回落到会话 `header.cwd`——只看 `header.cwd` 等于把目录绑定交回给调用方，带一个 `workdir` 就能在子目录里跑另一个同名程序。清单匹配与 S2 / S4 的换目录请求都会核对文件系统中的真实目录，拒绝根外路径、无法确认的目录和实际位置与请求不一致的目录链接。审计事件和待补条目都写入相对目录 `dir` 与绝对路径 `cwd`——只记相对路径的话，事后还得翻流程快照里的 `flow.cwd` 才能还原到底在哪儿跑的；补进清单时按 `dir` 拼回后缀。这是唯一通道，清单外的变更性命令一律拒绝；S2 / S4 中，被拒的清单候选按命令和执行目录记进待补队列。用户可以选中可补录的条目，退回 S1 预填后重新审批。补录会复核目录，无法确认时工作台显示原因。每条 shell 判定都写进 `flows.jsonl` 的 `shell.allowed` / `shell.denied` 事件，`detail` 带命令原文（截断到 200 字并标 `truncated`）、`outcome` 与 `reason`，事后能查这一轮到底跑了哪些命令、依据哪条规则。守卫按已知工具名称、参数及命令分类工作，覆盖范围以[宿主实现](../lib/index.js)为准，不能代替文件系统沙箱。

评审与默认测试子代理在执行前按预留的 `childId` 登记到父流程，并由 `tools.guard` 最终工具守卫强制只读。写入 / 编辑工具及未知的变更工具默认拒绝；shell 走同一套只读白名单：`pwd`、`ls`、`cat`、`git status/diff/log/show/rev-parse/ls-files`、`git branch --list` 与严格纯解析形式放行。只读 Git 是特意开的——子代理核不了 diff 时，评审只能按文件正文猜改了什么，测试也查不出工作区多出多余改动。`git push`、`git commit`、`git checkout` 这类改变仓库状态的命令仍然拒绝，管道与解释器内联同样拒绝，换行也在入口单独拒掉（理由文案点名换行，不混进「重定向 / 管道」里）。执行目录同样受限：子代理通道的 `childDenial` 把子会话的 `header.cwd` 一并带进 `scopeCommandMatches`，并且同样读 shell 工具自己的 `workdir`——与主 Agent 走同一套 cwd 规则，清单条目没带 `[目录]` 后缀就只认流程根，换个目录（`cd` 过去或带 `workdir`）跑同名命令一样被拒。子代理的直接 shell 调用由前置拒绝或最终守卫写入目录审计。`script_path`、解释器和包测试脚本默认拒绝。读取通过结构化工具完成，`run_code` 只接受一个工具调用或 `Promise.all` 里的一批只读调用（参数必须是严格 JSON），不能执行任意 JavaScript；并行只读是为了让子代理一次取回多个文件或多次检索，而不是逐条等一轮。需要修复代码时，回退到 S2 由开发阶段处理；这层守卫仍需配合宿主文件系统沙箱。

评审角度的读取痕迹按同一口径记账：单次读取与 `Promise.all` 里的每一路读取都算「读过这个文件」，目标文件少一条痕迹、读取失败、或者报告里的首尾行与磁盘内容对不上，该角度一律标成未覆盖（`verdict` 也不会是 `pass`），S3 门禁随后拒绝通过评审。提示词让子代理优先用默认可用的 `read`，并写明 `ops_*` 系列默认没有加载、需要时先调 `ops_load_sdk({"tools":["read_files"]})` 下一轮才能用——否则子代理会照提示直接调用未加载的 `tools.ops_read_files`，报 `not a function`，然后在没读到源码的情况下交一份空 findings 的「通过」。

纯解析、版本探测和内联执行分别声明边界，不能共享任意尾参或跨解释器标志并集。`node --check` 的文件前后都不能夹带 `--require`、`--import`、`--loader`；`php -l -r`、`bash -n -c`、`bash -n +n` 不属于免授权纯解析。`tsc --noEmit` / `deno check` 可能隐式读取配置或写缓存，统一要求 S2 / S4 匹配批准命令。版本通道只允许逐条声明的完整安全参数。`mvnw` / `gradlew` 是项目提供的包装脚本，版本查询也要走批准清单。`python -E` 是忽略环境变量，可作为普通命令批准执行；`perl -E` 是内联执行，仍拒绝。守卫字段从严匹配，体检的测试命令、生态及依赖识别继续采用各自的宽松字段。

### 命令清单是唯一的执行权限

测试可能需要跑构建、迁移、回滚等变更性命令。它们只有一条通道：写进需求文档的 `scope.commands` 清单，由用户在 S1 批准 scope 时一并过目。清单命中的命令在 S2 / S4 直接执行；清单外的变更性命令一律拒绝，没有「本次授权」「方向级写权限」之类的补丁开关。

用户不该被要求勾选权限：勾选框摆在开发卡或测试卡上，用户看不懂该勾什么，Agent 说一句「需要授权」他也会照勾，勾完的责任却落在他身上。批准 scope 是一次真正的、有上下文的授权——那时清单和验收标准摆在一起，用户能判断这些命令要不要跑。所以权限只在那一次批准里产生。

写漏了怎么办：拒绝时宿主把命令原文记进 `flow.pendingCommands` 队列（去重、按 `SCOPE_COMMAND_MAX` 封顶、跨阶段保留），到门禁时二选一——「补进清单并重新批准」或「不补，继续」。补会退回 S1、把被拒的命令预填进清单草稿、按新清单重算验收方案缺口，用户重新批准 scope 后从 S2 继续；代价是本轮评审与测试要重跑，这句写在按钮旁边，不能让人以为只是补个字段。不补则记进 `flow.declinedCommands`、清空队列、照常推进，这些命令之后仍然被拒，依赖它们的验收标准在 S3/S4 账本里记成未覆盖。

补清单没有旁路：`reopenScopeForCommands` 只接受待补队列里的命令原文（`resolveChosenCommands` 逐条核对），传一条队列里没有的命令会被拒。开发或测试途中「顺手往清单里加一条」的路已经删掉——那正是原来任何阶段都能加、加了也不经用户过目的来源。auto 档位下「补」不会把用户的选择悄悄改回 manual：命令照旧追加进 `pendingScope`，若重算后没有缺口就直接冻结并记 `auto: true`，有缺口则自然挂在 S1 门禁上等用户。

权限不落在流程里：`shellGrant`、`writeGrants`、`needsWrite`、`directionWriteDeclared` 这些字段已从数据模型删除。旧快照里的残留字段在读盘时被 `repairFlow` 清洗，`hydrate` 再把清洗结果写回磁盘，避免文件里留着 `shellGrant: true` 让人分不清它还算不算数。因此冷恢复不涉及任何「重新授权」：能跑什么，始终只由那份已批准的清单决定。

测试子代理受同一套约束：它按预留的 `childId` 登记到父流程，`childDenial` 用当前流程的 `scope.commands` 判定 shell，写工具与未知变更工具一律拒绝。方向配置被改动、子代理执行失败、无法确认已停止时，一律回到只读隔离，不会因为某个方向「声明过需要写权限」而放宽。

## 结项方式

S4 出口门禁有三种结束方式，状态、事件与界面文案各不相同，不能互相顶替：

| 结束方式 | 触发条件 | 阶段记录 | 事件 | `flow.closure.kind` |
| :--- | :--- | :--- | :--- | :--- |
| 全部验收通过 | AC 与测试要点全部 `pass` | `status: 'passed'`、`gate: 'passed'` | `gate.passed` | `passed` |
| 带缺口结束 | 存在未通过 / 未覆盖项，用户显式接受 | `status: 'accepted_with_gaps'`、`gate: 'accepted_with_gaps'`、`gapAcceptance` | `gate.accepted_with_gaps` | `accepted_with_gaps` |
| 跳过验收门禁 | 用户选 `skip` | `status: 'skipped_by_user'`、`gate: 'skipped'` | `gate.skipped` | `skipped` |

`skip` 不是免检通道：S4 的跳过和通过走同一套 `gateValidation`，有缺口时同样要求 `acceptUncovered: true`，只是阶段记录成 `skipped_by_user`、缺口原样留在账本里。此前跳过反而比通过更容易过，点一下就绕开了缺口确认。

带缺口结束要过一道：`acceptUncovered: true`（明确承认有缺口），只点普通「通过」会被拒。接受靠的是这个动作本身，不靠用户打一段说明——必填说明只会让人随手打「ok」，而缺口清单、计数与结束方式才是事后能核的东西。用户想写原因时 `acceptanceNote` 仍然会被记录，留空则 `note` 字段不出现，界面也不会摆一个「接受原因：未填写」的空位。AC 账本本身不会被改写：未覆盖的仍是未覆盖，`accepted-with-gaps` 只记录「用户看过并接受了」，不是「改判为通过」。

三套数字分别统计、分别展示：测试要点失败数（`fail`，只数 `result === 'fail'`）、AC 通过 / 未通过 / 未覆盖数、测试要点通过 / 失败 / 未覆盖 / 环境受限数。`failed: 0` 只说明没有测试要点判失败，不代表 AC 通过了——AC 一条没过而测试要点零失败是完全可能的组合，界面上两套账并排显示。

界面上带缺口结束不是一键操作：出口门禁先展开缺口清单（逐条列出未通过的 AC 与测试要点），看清之后才出现「确认结束流程」，点它即接受，不再要求填说明。dock 快捷入口同样不给人盲签：有缺口时给「结束流程（需确认）」与「退回开发修复」，点前者在提示条下方就地摊开逐条缺口，看清后再确认才提交 `acceptUncovered: true`；没有缺口时只留「结束流程」——没有要修的东西，退回开发修复只会多绕一圈。结束后的状态徽标是橙色「带缺口结束」，不是绿色「已完成」；`flowgate_status` 的摘要与 hub 摘要都走 `closureSentence()`，读作「流程已结束：带缺口结束（用户明确接受未通过/未覆盖项）——验收标准 … 测试要点 …」，用户补过原因时追加「；用户补充的接受原因：…」。

放弃流程是终态，但**不抹掉验收账本**：`cancelFlow` 只清 `frozen`、`frozenAt`、`withoutDocApproval` 与各项授权，保留 `scope.data`。原因是一旦连 `scope.data` 一起重置成 `null`，`acceptance_criteria` 随之消失，`acceptanceLedger` 按零条计数，一条「12 项全未覆盖」的流程在放弃后反而显示成「0 条 · 验收通过」。账本反映的是这条流程做过什么，放弃不等于没发生过。

## 升档与回退

升档调整检查深度，不自动扩大 scope。S3 升档时，回退位置取决于已有评审结果：

| 情况 | 结果 |
| :--- | :--- |
| 没有阻断发现 | 使用严格档继续当前流程 |
| 有阻断发现，但没有落在 scope 外的 CRITICAL / MAJOR | 回到 S2 修复 |
| 有 CRITICAL / MAJOR 落在 scope 外 | 回到 S1，先更新范围并重新批准 |

「阻断发现」的口径收在冻结 scope 上：一条发现要同时满足三条才算——严重度不是 `MINOR`、挂得上 `acceptance_criteria` 里的某个验收标准 id（`ac` 字段）、且文件在 `in_scope.files_expected_to_change` 内。挂不上验收标准或落在 scope 外的发现照样列在评审报告里，但只作提示、不进 S2 的重做清单（它们证明的是范围没划够，不是这一次开发做错了）。这条口径同时约束 `flowgate_review` 与 `flowgate_review_run`，界面上对应的徽标是「未归属验收标准」与「scope 外文件」。`fast` 档只减少默认评审角度与测试方向，界面可折叠展示前三条，底层普通发现不按三条截断。每角度仍有 200 条存储安全上限；超出时 `omittedCounts` 单独保留收到的完整严重度与阻断计数，不能伪造一条 MINOR 代替多条原始发现。`MINOR` 的完整计数与 AC 结果独立：仅有 MINOR 不自动令 AC 失败，零阻断也不能自动令 AC 通过。

工作区默认规则记录在 `.dsh-flowgate/config.json`，与流程快照分开；规则继承顺序见[四阶段规则](#四阶段规则)。

回退会重置目标阶段及后续门禁；已有代码保留，不会恢复 Git 状态。回到 S1 另清除当前有效范围和需求文档，需要重新提交并批准。升档重置评审角度和测试方向，保留开发规则选择。回退到 S2 时保存上一轮结论供追溯，但复用必须核对内容哈希：本轮与上一轮的内容指纹只要变化，就整轮重评、重测；文件名集合相同、旧 finding 所在文件未改，都不能证明影响未扩散。指纹缺失或采集不完整时同样不得复用。`reusedAngles`、`reusedDirections` 与自动复用入口只接受已核对内容未变且规则仍适用的上一轮结论，`reuse: false` 强制全量重跑。同一轮不能既复用又重报。

工作台会记住上次停留的位置：切到别的会话再点侧栏进入时，面板按 `localStorage` 里的 `dsh-flowgate.hub.memory.v1` 恢复到上次的工作区目录、展开的流程详情与流程记录分页。
恢复顺序是先按目录进工作区页，再在列表里按 `sessionId` 找回那条流程；记忆里的目录已经从名单移除时回首页，避免停在「目录不可用」；主动点「工作区列表」时记忆一并清到首页。
存储不可用（隐私模式、被策略禁用、配额已满）时读写都静默失效，面板照常显示，只是不再记忆。

退回只生效一次：同一目标阶段在 10 秒内重复触发时只记一条 `flow.rollback.skipped` 事件，不再二次重置刚重做的阶段产物——门禁工具被中断后宿主补发的排队消息与工具自身返回值可能各带回一次退回，第二次不应把 Agent 刚改好的东西清掉。判定同时要求当前阶段已在目标阶段，推进到后续阶段后的正常回退不受影响。补发消息是状态通知而非新指令：明确当前阶段，并要求不要再次回退、不要重新提交上一个门禁的产物。退回前先保存本轮修复清单，退回返回值和唤醒消息携带同一份重做输入：评审位置、严重度、AC 与问题描述，以及测试失败、未覆盖或环境受限的要点及原因。只作建议的发现与阻断修复分开说明，不能把 scope 外事项偷偷变成开发授权。

S3 与 S4 的「更多操作」里都有「回到需求分析调整 scope」，点它直接退到 S1（服务端按 `to === 'S1' ? 'S1' : 'S2'` 映射，不经 S2 中转），代价是本轮评审与测试全部作废。只想补被拒的命令时不用点这个：命令被拒的那一刻已进待补队列，门禁卡上会给出二选一，选「补」同样保留已写好的文档，只把命令追加进清单再重新批准。

## 四阶段规则

工作区规则统一包含 S1 分析检查项、S2 开发规则、S3 评审角度、S4 测试方向。S2 仍保留五条内置规则：只改 scope 内文件、不引入未声明依赖、显式处理错误路径、不留调试残留、遵循既有代码风格。

工作区页的「工作区规则 → 编辑规则」无需需求或会话。四阶段导航保留各自草稿；内置条目可启停、自定义内容、对照原文与恢复，新增条目可增删改。预览档位只决定默认启用项，内容自定义与条目启用分别保存。全部修改在点击「保存规则」时一次落盘，取消、Esc 或关闭不保存；单项恢复与阶段恢复也只修改草稿。

各阶段在状态、界面清单与实际执行时使用同一份有效配置：S1 注入分析提示，S2 展示开发清单，S3/S4 按启用角度或方向组织子代理；主会话降级执行时，状态清单也逐项提供有效条目的 ID、名称、检查要点与来源。S3 的状态清单同时提供有效开发规则，供主会话正确性与风格评审逐条核对。除修改范围守卫外，规则依靠检查与评审执行，不代表每一条都有独立的自动阻断机制。测试方向只决定验证什么，不决定能执行什么：测试子代理始终只能跑 scope 清单里的命令，代码写工具一律拒绝，方向级没有单独的权限开关。S3 评审子代理还会按固定边界矩阵（输入形态、字符集、路径形态、长度、其他边界）对被改函数逐维度枚举，一次性报全全部 missing 分支，summary 带「[函数 · 分支]」前缀，不按发现顺序增量上报。测试要点除 `pass` / `fail` / `uncovered` 外还可标 `excluded`：当前环境确实测不了（例如需要真实网络或宿主能力），必须同时给出 `excludeReason`；只标 excluded 不给原因按未覆盖处理。`excluded` 是带原因的环境受限记录，必须与失败、未覆盖分别展示；用户显式接受例外也不把该验证变成 `pass`。缺少已认证的真实桌面端接入时，视觉验证应记录为未覆盖，并说明缺少哪项接入证据。

每条冻结 AC 都维护 `method`、`procedure`、`status`、`evidence`、`version`：方法说明用自动化、人工或真实视觉校验，步骤必须可复现，状态反映实际验证结果，证据能定位输出或记录，版本标明实际验证的内容指纹（由工具在提交时盖戳）。运行版本可信度由 `runtime.status` 单独报告，刻意不参与内容指纹：重载插件、重新生成模块 revision 这些与代码无关的动作不该让全部证据判成版本不一致。方法或步骤空缺、无证据或版本未核对时，不得从零阻断、MINOR 数量、门禁已走完推导出 AC 通过。实现完成、验证完成和运行生效是三项独立结论，交付记录逐项写明。

### 规则跟工作区走

工作区页保存的默认规则写入下列文件。流程内单独调整则保存在流程快照中；选择「保存为工作区默认」后，该流程也恢复跟随默认。未单独设置规则的流程（包括已有流程）会使用当前工作区默认：

```text
<工作区>/.dsh-flowgate/config.json
```

生效顺序是三层，后者覆盖前者：

| 层 | 存在哪里 | 何时失效 |
| :--- | :--- | :--- |
| 内置默认 | 插件代码 | 不会 |
| 工作区默认 | `.dsh-flowgate/config.json` | 保存恢复后的内置默认，或在流程设置中清除默认 |
| 本次流程临时调整 | 流程快照中的阶段选择与自定义条目 | 当前阶段选择恢复跟随默认，或 S2 保存为工作区默认；不用于其他流程 |

工作区配置版本为 `2`，`stages.S1` 至 `stages.S4` 各保存 `null` 或 `{ ids, custom, edits }`：`null` 跟随内置，`ids: null` 按当前档位选择，空数组明确禁用全部；`custom` 保存新增条目，`edits` 保存同 ID 内置条目的内容替换，内置原文始终保留。旧版本的 `rules` 仍映射为 S2，兼容写入也只更新 S2；恢复某阶段不会删除其他阶段配置。

工作区默认**不存 scope、不存门禁决策**。这些都是一次性授权或流程内状态。规则配置可提交进版本库；流程快照、事件日志与冻结范围属于运行记录，应当忽略。

界面会明确标出当前来源（内置默认 / 工作区默认 / 本次流程临时调整），保存后本次流程也改为跟随默认，不会出现「标签说跟随默认、实际还是旧配置」的不一致。切换档位只重置评审角度与测试方向，不动规则选择。

## 门禁模式：自动通过 / 每步确认

流程级字段 `gateMode` 决定每个阶段出口是自动放行还是等用户点按钮，**任何阶段都能切**，切换立即生效：

| 模式 | 行为 | 默认 |
| :--- | :--- | :--- |
| `auto` 自动通过 | 体检没有阻塞项就直接进入下一阶段；有阻塞项就停下来，并在门禁卡上列出原因 | fast 档 |
| `manual` 每步确认 | 每个阶段出口都等用户点按钮，与旧行为一致 | strict 档 |

自动通过**不放开任何权限**：它只跳过「点通过」这个动作，不代替用户批准 scope 命令清单、不代替用户接受验收方案缺口。判定口径与手动通过完全一致（S3/S4 直接复用 `gateValidation`），所以自动通过不可能放过手动通过不允许的东西。

各阶段的阻塞条件：

| 阶段 | 自动放行的条件 |
| :--- | :--- |
| S1 | scope 体检的 `blockers` 与 `risks` 都为空；且验收标准不是全部声明为人工核验 |
| S2 | 开发快照完整（`snapshot.complete`） |
| S3 | `gateValidation` 通过：无阻塞发现、角度均已覆盖、快照一致 |
| S4 | `gateValidation` 通过：无失败要点，验收账本无缺口（`excluded` 不算缺口） |

自动放行会记进流程：`autoPassed[阶段] = { at, snapshot }`，并写 `gate.auto_passed` 事件；没自动放行时把原因写进 `gateBlockers`，界面据此回答「这一关为什么没自动过」。模式切换写 `gate.mode.changed`，并唤醒正在等待的门禁重新判定——所以挂起时切到自动通过会当场放行。

**按钮可点 ≠ Agent 还在等。** 门禁等待挂在工具调用上，工具超时、宿主重启或被新的等待取代时等待器就没了（`GateHub.wait` 收到 abort 会 `finish({ kind: 'aborted' })`），但产物已经落地，所以按钮继续可点、`gate.interrupted` 为真——这是为了不剥夺用户的批准权，不是允许 Agent 自己往下做。两边必须同时成立：

- **Agent 侧**：中断时工具返回的是「停下来等确认」，明确要求不要继续做后续阶段的工作、也不要假设已经通过；用户点按钮后宿主补一条唤醒消息，Agent 从 `flowgate_status` 接着走。
- **宿主侧**：`awaitGate` 在挂起前核对阶段与门禁状态（`expectedStage` 与 `record.gate !== 'pending'`），发现用户已经在窗口里确认过就直接返回 `stale`，不再挂到一个按钮永远不会再出现的阶段上；S2 采集变更摘要最长有 10 秒窗口，返回后若阶段已经变了就丢弃这次摘要，不往新阶段里写上一阶段的事实。门禁工具在挂起前还会看本阶段有没有产物：S3 要评审报告、S4 要测试报告才会亮按钮，没有就当场返回 `stale` 并说清该先交什么，而不是挂到一个不会来的按钮上。

少了任何一边都会变成「用户自顾自批准、Agent 自顾自干活」。

## 命令清单要「合适」

`scope.commands` 是 S2 构建、S4 测试的唯一放行依据：命中清单的命令直接执行，界面上没有任何别的开关。清单为空等于把执行范围收窄到只读命令，跑到一半才发现命令没批准，就只能等门禁上的待补决定。因此 S1 提交 scope 时要求：

- **命令从项目读出来**：`package.json` 的 `scripts`、测试框架配置、`tsconfig`、`Makefile`。凭印象编的脚本名会在 S2 第一次跑构建时炸。
- **标注来源与对应 AC**：`command_sources: [{ command, from, acs }]`。它不进冻结的 `scope.json`，只用于界面标注和体检依据。
- **不要过少也不要过多**：过少 → 执行时被拒、门禁上多一道待补决定；过多 → 批准了一堆用不上的权限。

`scopeReadiness` 现在同时检查过少与过多，风险码如下：

| 风险码 | 含义 | 后果 |
| :--- | :--- | :--- |
| `no-test-command` | 有可执行验收标准，但清单里没有测试命令 | 缺口，需显式接受 |
| `ac-without-command` | 某条可执行 AC 没有任何命令对应（需 `command_sources` 才逐条判） | 缺口，需显式接受 |
| `integration-without-test-file` | 声明集成验证但没有测试文件 | 缺口，需显式接受 |
| `procedure-file-outside-scope` | 验证步骤点名了 scope 之外的文件 | 缺口，需显式接受 |
| `visual-without-measurement` | 视觉验收没写明怎么测 | 缺口，需显式接受 |
| `over-broad-command` | 出现 `npm *`、`node *`、`*` 这类通配（带 `[目录]` 后缀的同样算：`BROAD_COMMAND` 先剥后缀再判，加个目录洗不成合规条目），或条目数超过 `max(8, 可执行 AC 数 × 2)` | 缺口，需显式接受 |
| `command-not-applicable` | `npm run <script>` 的脚本在 `package.json` 里不存在 | 缺口，需显式接受 |
| `command-runtime-missing` | 命令用到的可执行体在当前 PATH 上找不到（`node`、`php`、`cargo`…），或者它本身在、它依赖的解释器不在（`npm` 在而 `node` 不在） | 缺口，需显式接受 |
| `command-without-ac` | 命令没挂任何 AC（可能用于构建或静态检查） | 只提示，不阻塞 |

`npm run *` 不算超宽：它只能在 `package.json` 的 `scripts` 里选，范围本身有限，插件一直支持这种前缀通配。

### 解释器与生态登记表

`lib/ecosystems.js` 是宿主判定 shell 命令时唯一的事实来源。它把此前各自为政的四份名单收成一张表：只读白名单、纯解析命令、逃逸检查里的解释器内联名单、验收体检里的测试命令识别与超宽判定。表里每条生态记录解释器名（`runtimes`）、包管理器名（`managers`）、标志文件（`markers`）、内联执行标志（`inline`）、纯解析标志（`parse`）、版本探测参数（`version`）与测试命令正则片段（`test`）。

为什么要收敛：这四份名单原本是四段写死的正则，加一个语言要改四处，改漏一处不会有任何报错。实测就是这样——`php -r 'unlink(...)'` 能执行任意代码，却因为 php 根本不在名单里而一路放行。现在新增生态只改 `lib/ecosystems.js` 一处，由插件代码维护，不暴露成用户配置项：用户不知道「本项目的解释器该不该算登记过」，让他勾选只会变成另一种照勾。

表里已登记 Node.js、Deno、Python、PHP、Go、Rust、Java、.NET、Ruby、Elixir、Perl、Lua、Shell、PowerShell、Windows 命令解释器、Make / CMake。任何一项写错只会收紧或放宽「识别」，不会放宽「写盘检查」：逃逸字符那部分与这张表无关。

两条派生规则值得单独说明：

- **只读命令不再只认 node**。`node --version` 之外，登记过的生态都能跑自己的版本探测（`php --version`、`python -V`、`cargo --version`），也能跑纯解析命令（`node --check`、`php -l`、`bash -n`、`tsc --noEmit`）。非 JS 项目在 S1 连 `php --version` 都跑不了的日子结束了。
- **解释器身份归一化**。清单里写 `node test/host.test.mjs`、实际执行时是 `C:\...\node.exe test/host.test.mjs`，这是同一条命令，只因为路径写法不同不该被判成「清单外」。`scopeCommandMatches` 按登记过的可执行名归一化后再比参数；没登记的名字仍按原文精确比较，否则任意同名脚本都能借用清单里的授权。

### 可执行性体检

清单写对不等于跑得起来。`projectProfile` 会读 `package.json` 的 `scripts`、`tsconfig`、`Makefile` 与各测试框架配置，据此判断命令「该不该存在」；但很长一段时间里，没有任何一处判断这个可执行文件「这台机器上有没有」。于是裸 `node test/x.mjs` 一路通过 S1 体检、在 S1 门禁上被批准，到 S2 才被 shell 自己以 127 拒绝——那时用户已经批过 scope 了。

现在 S1 提交 scope 时多一道 `command-runtime-missing`：对清单里每条命令取首个 token，若该名字属于登记表、且仓库里确实声明了对应生态（`markers` 命中），就用宿主进程的 PATH 与 `PATHEXT` 解析它是否存在（带目录的写法直接 `existsSync`：绝对路径原样查，`./gradlew`、`tools/node` 这类相对路径相对仓库根解析，不按宿主进程的 cwd）。找不到就记一条缺口，提示把绝对路径写进清单或先装好它。

只查第一个 token 有个明显的洞：`npm` 本身就是个 node 程序，`composer` 是个 php 程序，`prove` 是个 perl 程序——包管理器在、解释器不在的机器上，首 token 查得到，命令照样跑不起来。所以登记表每条生态多一个 `needs` 字段，写清「这个名字必须先有谁才能跑起来」（`npm` / `pnpm` / `yarn` / `npx` / `corepack` → `node`，`composer` → `php`，`pip` 家族 → `python` / `python3` / `py`，`bundle` 家族 → `ruby`，`mvn` 家族 → `java`，`prove` / `cpanm` / `carton` → `perl`，`luarocks` → `lua`，`cargo` → `rustc`，`mix` → `elixir`；`go`、`dotnet`、`deno`、shell、PowerShell、`cmd`、`make` 是自包含的，留空）。体检顺着查一层，缺了就并进同一条缺口，并在文案里点名缺的是哪一层：「`npm` 在，但它需要的 `node` 不在」。

依赖写成候选列表而不是单一名字，是因为同一个东西有多个叫法：`python` / `python3` / `py`、`lua` / `luajit`。**任一存在即算通过**——Windows 上只有 `py` 启动器的机器不该被判成缺依赖。未登记的名字一律返回空列表，不猜。

刻意收窄的两处：只核对「仓库里声明了这个生态」的命令，空目录里写 `node test/x.mjs` 无从判断，跳过比误报有用；只往下查一层依赖，`npm` 拉起的 `node` 里再 `require` 了什么、`mvn` 要的 JDK 版本够不够，静态都看不出来。

静态体检管不到的那半，交给 S1 的版本探测：`node --version`、`php --version` 这类命令属于只读白名单，任何阶段都放行，提交 scope 前对清单里每个工具跑一次，跑不通就把绝对路径或替代方案写进清单。这一步是 `flowgate_doc` 工具描述里的硬要求，不是可选建议——文件在不在能查，跑起来报不报错只有真跑一次才知道。绝对路径的探测（`C:/…/node.exe --version`）不在只读白名单里，S1 会被拒；所以探测要用裸名，报「找不到」恰好说明该把绝对路径写进清单，交给 S2 按清单放行。

用风险码而不是阻塞项，是因为它不该由用户拍板接受：缺命令、缺测试文件、步骤越界都是 Agent 该补齐的东西，让用户点「接受」等于把返工责任转给不懂的人。所以风险在提交时就退回，两种档位一致——`fast` 档不再把它算进门禁项停在门禁卡上，因为它根本走不到门禁。

## 打回预算

S4 退回只有 S2 一个目标，所以「AC 本身测不了」的缺口回 S2 改代码永远修不好。同一批 AC 以同样状态连续退回超过 2 次时，`rollbackTo` 把目标改成 S1（写 `flow.rollback.redirected` 事件）：要么改 scope 换验证方式，要么显式接受缺口。

缺口指纹是「未通过且未标 excluded 的 AC + 状态」排序后拼接，所以真改了代码、状态变了，指纹就变，预算重新计数。

## 左侧栏面板（先选工作区）

插件注册三个插槽：`sidebar.panellist` 放一个图标入口、`main` 放对应面板，两者的 id 都必须是 `flowgate-hub`（侧栏条目 id 与 `main` 的 key 同名才会打开面板，这是宿主的导航约定）；第三个是会话输入框卡片上方的 `conversation.input.dock`，见本节末尾。

面板是**全局面板**，不绑定会话，因此拿不到 `sessionId`。它维护的是一份**用户自己添加的成员名单**，不是宿主工作区全集——没加过任何东西时面板是空的。名单存在用户级目录，不在任何工作区里：

```text
<DSH_FLOWGATE_HOME | ~/.dsh-flowgate>/hub.json
  { version, updatedAt, members: [{ path, addedAt }] }
```

只存绝对路径与添加时间。任务与规则仍留在各自工作区的 `.dsh-flowgate/`，添加时按需读出展示，**不复制、不改写**——那个工作区里改了规则，面板下次读就跟着变。面板有三态：

- **空名单**：读取用户级名单后，显示 **「添加目录…」** 与 **「添加工作区」** 两个入口。
- **成员列表**：`POST /api/flowgate/hub/members` 只返回工作区摘要（流程总数、进行中 / 待确认计数、规则概况与目录状态），不返回全量 `flows`。
- **详情**：工作区概览主列优先显示开始或继续流程的入口。没有进行中流程时，「开始新流程」是直接展开的 `section`；有进行中流程时，主列仅显示当前标题、阶段和「继续流程」按钮。「工作区规则」位于 `aside`，窄屏依次排列；「流程记录」在概览与所选流程详情之后，以默认收起的 `details` 展示，仍按更新时间倒序、每页 10 条请求。头部可返回工作区列表或移除名单条目，移除不删磁盘记录。

分页减少响应中的流程数量，不代表没有磁盘扫描；服务端仍需读取或刷新磁盘摘要以统计和排序。兼容接口 `POST /api/flowgate/hub`（`{ paths: [dir] }`）保留流程与规则概况。

点开某条流程后内嵌 `FlowDetail`（`lib/client.js` 里那个完整工作台，同时从 `exports.components.FlowDetail` 导出供单测直接渲染）：它在面板里用 `useEntry(sessionId)` 按 1.5 秒轮询取实时状态，门禁确认、退回修复、改规则、追加范围都在面板内完成。宿主侧栏只有 264–420px，`.fg-hub-flow` 把会话页的三列布局压成单列（阶段导航横排、门禁与设置依次向下）。

**输入框上方的阶段提示**是第三个插槽 `conversation.input.dock`：宿主把这一行留给任务条、目标条、排队消息这类独占整行、带散文的内容（order 0 / 10 / 20），插件取 30，落在排队消息之下、输入框之上。`StageHint` 显示 `S{序号} {阶段名}`、当前该做什么、为什么停着与已用时长；`waitingKind` 为 `answer` / `doc` 时用对应文案，为 `gate` 时按阶段回退到出口按钮名（文案与面板按钮一字不差），两处都没有才说「等你确认后继续」。所有有效会话都显示「开始需求分析」按钮，包括没有流程、已结束或已放弃的状态；没有有效会话 ID 时返回 `null`。点击按钮打开浏览器顶层快捷弹窗，填写需求原文与执行档位，支持按钮或 Ctrl/Cmd+Enter 提交。弹窗复用现有 `StartPanel` 与启动协议，不新增门禁通道，阶段确认仍在工作台里完成；数据与面板共用同一份 `useEntry` 订阅，不新增轮询。宿主版本没有这个座位时注册静默不生效，面板不受影响。

**S1 的决策问题在 dock 里直接作答**：`view.grill.pending` 非空时，按钮组下面多出一块 `.fg-hint-answer`（`grid-column: 1 / -1` 独占整行），问题、选项与自定义答案各占一行。选项和推荐项取自同一个 `pending.options` / `pending.recommended`，推荐项用主色并带「（推荐）」，取舍说明排在选项标签下面（`.fg-hint-answer-opt-note`），触屏、键盘与读屏都拿得到，不靠悬停。点一下即投递一次 `act('answer', { choiceIndex, customText: '' })`；`allowCustom !== false` 时还有「其他答案…」，展开后是 textarea 加「提交答案」/「取消」，Ctrl / ⌘ + Enter 提交 `{ choiceIndex: -1, customText }`，Esc 收起。投递期间整块按钮置灰并显示「提交中…」，`sending` ref 挡住 1.5 秒轮询窗口里的连点；失败按 `.fg-hint-err`（`role="alert"`）就地显示原因。`pending` 变成 `null` 后整块随下一次轮询消失，不残留答案按钮。这里只复用既有的 `answer` 动作与宿主等待逻辑，不新增通道；工作台的 `GrillCard` 只同步推荐标记的呈现方式（改成标签后缀、去掉独立徽标），选项与自定义答案的交互不变。换问题（`pending.id` 变化）时会一并清掉草稿、展开态、报错与提交态：旧问题还在飞时换上新问题，新问题的按钮不会被旧请求锁死；回包晚到而题目已换时直接丢弃，不拿上一道题的结果改这一道的状态。回答区只在 `liveFlow` 时渲染——跨会话摘要没有 `grill` 字段，那里既看不到问题也提交不了。选项在任何视口都竖排、左对齐、一行一个：`.fg-hint-answer-opts` 是 `flex-direction: column` 且每项 `width: 100%`，宽屏下也不并排，因此不会出现「一行两个、第二行只剩一个」；窄屏不再单独声明布局，宽窄屏行为一致。「（推荐）」只有一个来源：标签只写文本，渲染层按 `recommended` 追加一次，标签里自带的「（推荐）」不会再被拼一遍；工作台的 `GrillCard` 同样改成文字后缀，不再挂独立徽标。

快捷弹窗的草稿、提交锁和启动失败原因在当前页面内按会话隔离保存；关闭或切换会话不丢草稿，成功启动后清空。工作区已有流程或状态尚未确认时可先编辑需求，但不能提交或替换原流程；需求原文保留 20000 字符上限，超长不截断。弹窗打开后聚焦原文，Tab 在弹窗内循环，Esc、关闭按钮或遮罩可关闭并将焦点返回入口；提交等待期间禁用关闭和重复提交。提示条可换行，弹窗随视口收缩并内部滚动；真实宿主的版本、遮挡与宽窄屏测量仍需独立执行下文的布局取证。

阶段提示条宽度沿用宿主任务条和目标条的契约：`width = 100% - 2 × --dsh-composer-side-clearance - 4 × --dsh-composer-dock-inset`，`max-width = --dsh-composer-card-max-width - 4 × --dsh-composer-dock-inset`，配合 `margin: 0 auto` 与 `flex: none` 居中。宿主插槽本身不收窄条目，因此只设 `width: 100%` 无法对齐。变量缺失时两种留白回退为零、卡片上限回退为可用宽度，保持旧宿主兼容；不写死屏幕宽度。参考同版本 [conversation 构件](https://unpkg.com/@deepseek-ai/dsh-client-ui-conversation@0.2.2-rc.5/lib/client.js) 的任务条和 [goal 构件](https://unpkg.com/@deepseek-ai/dsh-client-ui-goal@0.2.2-rc.5/lib/client.js) 的目标条；这是布局契约核对，不代表当前 GUI 的实测通过。

[只读定位脚本](probe-stage-width.mjs) 可通过 `--resources <现有GUI地址>` 检查可访问构件，或通过 `--cdp <现有CDP地址> --page-url <已有页面完整URL>` 查看阶段提示与祖先的矩形。其普通 DOM 输出只辅助定位，验收仍使用下文 `inspectLayout` 的真实宿主测量及回执。当前环境直接请求现有 GUI 返回 HTTP 401，已有默认 CDP 地址连接被拒绝；未取得真实页面版本和边界时，左右对齐及宽窄窗口长内容验证必须记为未覆盖。

**面板里也能开第一条流程**：面板没有 `sessionId`，所以工作区主区域的「开始新流程」把 `StartPanel` 的 `sessionId` 换成 `resolveSession`——点「开始需求分析」时才向宿主换会话，链路由 `hubActions.sessionForWorkspace(path)` 提供。入口由 `/hub/flows` 的 `currentFlow` 决定，不从当前历史页推断：完成或放弃后返回 `null`，即恢复新流程表单。内嵌 `FlowDetail` 禁用重新开始入口，避免历史详情出现第二张新需求表单。

新需求草稿在当前工作台面板内按目录保留原始需求、自动生成的标题、执行档位；保存规则、历史翻页、数据刷新或返回列表后仍可继续编辑，成功启动时只清空对应目录的草稿。宿主重启后，详情接口会按会话目录恢复进行中流程，无需先调用状态工具。流程目录、文件签名或快照读取发生权限等 I/O 错误时返回失败，客户端保留重试入口并隐藏新建表单；已确认损坏的 JSON 仍按原约定跳过。

**启动表单只要求填需求原文**：表单里只有需求原文与执行档位，标题在点击「开始需求分析」时才生成，输入过程中不发标题请求、也不展示标题、预览、重新生成按钮或状态文案。生成结果直接随 `start` 请求提交，由进入流程后的详情页与工作区当前流程卡片展示。标题按 DSH 会话标题的口径生成：模型只输出一个 `title` 字段，提示词要求写成 4 到 12 字的名词短语（如「会话过期检测」「导出报表」），单行、不超过 24 字、不带标点引号编号，不复述首句；模型返回后统一经 `sanitizeTitle` 收口（去 Markdown 前缀与引号书名号、去句末标点、折叠空白、超长截断）。标题只为了让列表和详情读起来更友好，**S1 到 S4 的分析始终以 `brief` 原文为唯一依据**，标题既不替代原文，也不得据它增删目标、约束或验收标准，两者不一致时一律以原文为准（这条同时写进了 S1 唤醒消息和 `flowgate_status` 的输出）。生成走 6 秒期限的一次 `/hub/prepare` 调用（宿主端 `lib/requirements.js` 的 `TIMEOUT_MS`），客户端等待 9 秒（多留 3 秒让宿主先自己收网并给出降级结果），请求带可中止的 `signal`，换不到会话时立刻收掉在飞请求；超时或失败时静默回落到需求原文首个非空行派生的标题，照常启动、不报错、按钮不卡，降级原因只写进 `console.warn` 便于排查。模型调用只复用现有服务，不增加凭据或依赖、不开放工具调用。快照只保存 `brief` 原文与 `title`；旧记录里残留的 `summary` 字段在读盘时一律丢弃，界面只展示需求原文，正文以纯文本渲染。

启动链路：

1. 从 `ctx.get('workspaces').list.getSnapshot().items` 里按 `path` 找到 `workspaceId`；
2. `ctx.uiWorkspace.connectWorkspace(workspaceId)` 复用该工作区已连接的会话，没有就新建一个 blank 会话，返回其 `sessionId`；
3. 用这个 `sessionId` 发 `POST /api/flowgate/action` 的 `start`，成功后 `onStarted` 递增 tick，面板重新读盘就能看到新流程。

任一步失败（目录已不是宿主的 workspace、宿主缺 `uiWorkspace`）都在面板里就地显示原因，**不发 `start`**——宁可不启动，也不要落到别的目录上。换会话不会把用户从面板拽走：`connectWorkspace` 不在 UI 上做导航。

**工作区接口**（均在 `routes()` 中，不要求 `sessionId`）：

| 路由 | body | 行为 |
| :--- | :--- | :--- |
| `POST /api/flowgate/hub/members` | — | 返回 `{ members, file }`，成员含路径、名称、目录状态、流程计数、更新时间与规则概况，不含 `flows`。 |
| `POST /api/flowgate/hub/flows` | `{ path, page, pageSize }` | 返回 `{ flows, currentFlow, total, page, pageSize, totalPages }`；`currentFlow` 从全量摘要按当前排序返回第一条满足 `!finished && !cancelled` 的流程摘要，没有则为 `null`，独立于当前历史页，并附完整 `brief`；历史行仍保留 200 字符摘要，详情读完整视图。默认每页 10 条，上限 50，按更新时间倒序，越界页归到最后一页。 |
| `POST /api/flowgate/hub/rules` | `{ path }` 或 `{ path, stages }` | 读取或原子保存四阶段配置；返回 `{ rules }`，其中 `stages` 包含内置目录、内容替换、新增条目、保存选择与两档默认。旧 `{ path, rules }` 只更新 S2，`rules: null` 也只恢复 S2。 |
| `POST /api/flowgate/hub/prepare` | `{ path, brief }` | 不创建会话；读取已有会话或默认模型，返回 `{ title, status, message? }`，标题只用于界面显示。缺能力、超时或无效结果均返回可启动的原文派生标题。 |
| `POST /api/flowgate/hub/add` | `{ path }` | 路径必须是现存的绝对目录（否则 400 `需要一个绝对目录路径` / `工作区必须是现存目录：<path>`）；已登记则不重复写。返回 `{ member, created, imported }`，`imported` 是这次「顺手导入」的数量（`flows` / `rules` / `customRules`）。 |
| `POST /api/flowgate/hub/remove` | `{ path }` | 只从名单移除，返回 `{ removed, path }`。不删任何流程或配置。 |

**标题期限与形式收口**：以单调时钟记录一次 6 秒的总期限（`lib/requirements.js` 的 `TIMEOUT_MS`），覆盖本地标题准备、模型准备、流读取与 JSON 解析；各阶段前后检查绝对期限，超期中止请求并返回本地派生的标题。模型只被要求输出一个 `title` 字段，返回后统一经 `sanitizeTitle` 收口：取首个非空行、去掉 Markdown 前缀与引号书名号、去掉句末标点、折叠空白，超过 24 字截断；结果为空、含控制字符或含「整理稿」字样时按无效结果处理，回落到本地标题。这里不再对标题做「用词必须出自原文」的抽取式保真校验：长需求里往往没有现成的短名词短语，抽取式校验会频繁降级回原文首行截断，反而退化成没有整理。原文保真由数据模型保证——`brief` 逐字保存用户输入，标题另存 `title`，分析只读 `brief`。

**「修改需求」必须带走一句话**：门禁面板上点「修改需求」只展开意见输入框，不直接提交；意见为空时拦下并提示，超过 2000 字（`REVISION_NOTE_MAX` / 宿主的 `REVISION_NOTE_LIMIT`）时提示删减，textarea 本身带 `maxLength`。提交后 `POST /api/flowgate/action` 的 `doc` 动作多带一个 `revisionNote`，宿主用 `clampText(payload.revisionNote, 2000)` 收口后写进 `flow.doc.revisionNote`，`doc.revised` 事件的 `detail.note` 存同一份原文（超限时另留 `truncated: true` 与 `noteLength`）。两种返回路径都要带上原文：工具正在挂起时直接把备注拼进 `flowgate_doc` 的返回值；工具已被打断时由唤醒消息（`docWakeText`）带出。没有备注时两边都明说「用户这次没有填写修改意见」，让 Agent 先问清要改什么，而不是自己猜。

**目录自动登记**：在面板里点 **「添加目录…」** 走 `ctx.uiWorkspace.pickDirectory()`（原生对话框或应用内浏览，取决于装了哪个 directory-picker 实现），取消返回 `null` 就什么都不做；选中后先 `ctx.get('workspaces').create({ path })` 把它登记成工作区（宿主侧幂等，重复选同一目录不会重复登记），再 `POST /hub/add` 加进名单。`create` 失败时把 `WorkspaceCreateError` 的 message 显示在面板里，不加入名单。

**门禁是会话级的工具调用，但不必回会话去点**：门禁本质是一个会话级工具调用在等待（`GateHub` 按 `sessionId` 索引），`/api/flowgate/action` 也要求 `sessionId`。面板本身不绑定会话，但详情里每条流程都带着 `sessionId`（来自磁盘上的流程快照），所以面板能自己发 `/action`：确认、退回、改规则、追加范围都在面板里做完，数据和原来会话视图里那套是同一份。只有要看对话本身时才点 **「打开会话」**，调 `ctx.uiWorkspace.openSession(sessionId)`。`UiWorkspaceService` 是公开的 cordis 服务（构造函数里 `super(ctx, 'uiWorkspace')`），可以直接用。

服务一律 `ctx.get(name)` 软取，不写进 `exports.inject`：本插件可能先于 `ui-workspace` 激活，且缺服务时插件其余部分必须照常工作。缺 `workspaces` 时「添加工作区」没有候选（只剩「添加目录…」可用）、登记会报错；缺 `uiWorkspace` 时目录选择器不弹（返回 `null`）、「打开会话」提示从左侧栏进入。`workspaces.list` 传给面板的时机也推迟到 `main` 的 inject factory 首次运行（面板挂载时），避免在插件 apply 阶段拿到 `undefined`。

## 工具索引

普通使用只需操作工作台，以下供 Agent 集成和开发时查阅：

| 工具 | 用途 |
| :--- | :--- |
| `flowgate_start` | 启动流程；`brief` 是分析依据，`title` 可省略且只用于界面显示，`preset` 选择档位 |
| `flowgate_status` | 读取阶段、范围、规则和等待状态 |
| `flowgate_ask` | S1 提出决策问题，等待用户点选 |
| `flowgate_doc` | 提交需求 HTML、scope 和档位建议，等待批准；`commands` 要从项目里读出来并配 `command_sources` |
| `flowgate_gate` | 请求当前阶段出口门禁 |
| `flowgate_review_run` | 宿主按评审角度启动只读子代理并汇总报告 |
| `flowgate_review` | 当前 Agent 提交结构化评审报告 |
| `flowgate_test_run` | 宿主按测试方向启动子代理并汇总结果 |
| `flowgate_test` | 当前 Agent 提交结构化测试报告 |
| `flowgate_cancel` | 放弃流程、解冻 scope、记录事件并通知当前等待门禁 |

`*_run` 入口要求宿主具备下述协议与守卫能力；条件不满足时返回带原因的降级结果，也可由当前 Agent 使用直接提交报告的工具。等待门禁的调用会挂起，直到用户在工作台确认、退回、跳过或放弃。

### 宿主子代理协议

已按 DSH `0.2.2-rc.5` 官方源码核对契约，`startActivation` / `getProvider` / `prepareContinuable` / `delivery` / `dispose` 的签名与 rc.3 一致。使用 `subagents.startActivation` 与 `getProvider('spawn')`，不再支持旧的 `start` / `list`。启动前预留 `childId` 并登记会话归属和只读限制，使用 `delivery: 'caller'`；返回值为 `{ childId, name, messageId, result, dispose }`。新版协议没有 `toolFilter` 字段，不能依靠它剥离写工具。

能力探测区分服务缺失、接口不匹配、`spawn` provider 缺失、不支持预留 `childId`、`tools.guard` 最终守卫缺失；任一条件不满足时，`canSpawn` 为 `false`，启动入口报告具体原因并且不启动子代理。执行失败或报告无效同样保留原因，评审降级为 `advisory` / `MINOR`，测试记为 `uncovered`。`by: 'subagents'` 仅表示调用路径，不能证明子代理执行或报告成功。

启动信号只控制 activation 发布前的取消；已发布的 activation 在取消、超时或放弃时必须调用 `dispose` 停止并释放。取消后不再启动后续角度或方向，也不写入迟到的聚合结果。确认 `dispose` 成功后才解除子会话守卫；启动无回执或释放失败时，错误包含子会话 ID，并保留只读隔离、撤销变更命令权限。宿主的启动 reject 可能发生在消息已经投递之后，不能当作未执行的证明。用户自行启动的其他任务仍需自行停止。

### DSH 版本兼容声明

`engines.dsh` 是宿主唯一读取的准入字段：宿主 preflight 一旦发现它存在，就**只**按它判定，`peerDependencies` 被忽略；判定方式是 `semver.satisfies(运行时版本, 范围, { includePrerelease: true })`。

因此 `engines.dsh` 必须写成**范围**，不能写精确版本。写成 `0.2.2-rc.3` 的后果不是「提示版本不符」，而是宿主在启动时把这一行标成 `disabled`，只在 stderr 留一句 `disabling profile plugin ...`：插件界面和工具全部消失，看起来像插件坏了。

当前声明为 `>=0.2.2-rc.3 <0.3.0-0`，要点两条：

- 下界必须带 prerelease（`>=0.2.2-rc.3`）。写成 `>=0.2.2` 会拒绝 rc.3、rc.5 这些预发布版本。
- 上界必须写 `<0.3.0-0`。写成 `<0.3.0` 仍会放行 `0.3.0-rc.1` 这类预发布版本。

`dsh.compatibility.*` 只是商城口径，宿主不读，但必须与 `engines.dsh` 保持一致，否则商城显示与实际准入会打架。`dshReleases` 逐版本记录已核对源码的宿主版本。

`test/install.test.mjs` 内置一份最小 semver 判定，把「`engines.dsh` 是范围」「范围接受 0.2.2 全系、拒绝 0.1.x 与 0.3.0」「商城口径与之一致」钉成断言。以后升级 DSH 时：核对新版本契约 → 在 `dshReleases` 补一条 → 确认断言里的版本清单仍然成立。

## 修改代码后如何生效

本地开发使用 `link:` 安装；`file:` 安装为复制内容，不会同步源码改动。

| 修改位置 | 生效方式 |
| :--- | :--- |
| [客户端](../lib/client.js) | 确认同一 DSH checkout 的 `pnpm run dev:web` 构建监听器在运行，才可依赖客户端重建与热更新；否则需按宿主方式重建 Web 产物并刷新 |
| [宿主端](../lib/index.js) | 完全重启 DSH 进程，清除模块导入缓存 |
| 包中的客户端声明或导出 | 重启 DSH，重新加载 bundle 元数据 |

desktop profile 使用 `link:D:/Projects/dsh-flowgate` 时会直接指向本项目。仅修改宿主 JavaScript 无需重新安装，但必须完全退出并重启 DSH 才加载新模块；之后刷新原有 GUI 地址，客户端产物也需按上表重建。只刷新浏览器不会更新宿主模块。不要仅凭源码、预览或单测已更新就认定当前运行的 DSH 已加载新代码。

### 运行版本核对

客户端版本使用实际执行的**具名 factory** 的 `factory.toString()` 字串计算 SHA256，与宿主从磁盘读取的同一具名工厂字串 SHA256 对比；宿主版本另比较模块加载时的 SHA256 与当前磁盘宿主版本。四个值都需提供完整 64 位十六进制摘要。构建改写函数、宿主尚未重启、客户端尚未加载或任一摘要缺失，都不能仅凭文件时间或版本标签宣称已生效。

运行信息包含 `hostRevision`、`diskHostRevision`、`expectedClientRevision`、`clientRevision`，以及 `status: verified | mismatch | unverified` 和 `reason`。只有运行宿主等于磁盘宿主、执行工厂等于磁盘工厂且所有版本均已核对，才是 `verified`；不匹配与未核对都不能报告运行生效。

宿主已加载模块不是通过当前磁盘扫描来冒充：六个宿主模块各自导出 `FLOWGATE_MODULE_REVISION` 的 64hex 字面量，加载时登记该字面量；内容摘要统一 LF 并排除标记自身。修改 `lib/index.js`、`lib/runtime.js`、`lib/provenance.js`、`lib/acceptance.js`、`lib/requirements.js` 或 `lib/revisions.js` 后，在项目根先运行 `node scripts/stamp-revisions.mjs` 更新指纹，再运行 `node scripts/stamp-revisions.mjs --check` 只读核验，之后才按宿主方式重载插件并由当前页上报实际工厂指纹。未 stamp、旧 ESM 缓存或运行/磁盘不一致时不可报告 `verified`。维护工具的 `--root` 仅用于隔离 fixture 核验。

### 真实桌面端布局取证

[布局取证脚本](verify-layout.mjs) 复用[截图脚本](capture-ui.mjs) 的 CDP 连接及异步求值基础，只连接用户明确提供的**已有、已认证 DSH 桌面端页面**。脚本要求 Node >=22 的内置 WebSocket；插件运行要求仍是 Node >=20，无新增依赖。请从该桌面端现有开发者工具取得实际调试地址、完整页面 URL、会话 ID、任务条与目标条的唯一真实选择器，不要求另行启动 `dsh web` 或提供不存在的启动链接。

调试地址通常得自己开。桌面端默认不监听 CDP，用[启动脚本](../scripts/start-cdp.mjs)起一个带调试端口的独立实例（独立用户目录，不影响日常窗口）：

```bash
node scripts/start-cdp.mjs --port 9222
```

脚本会先探测端口，已就绪就只报告不重复启动。关键一步是启动子进程前**删掉 `ELECTRON_RUN_AS_NODE`**：该变量一旦存在，Electron 二进制会退化成纯 Node 解释器，`--remote-debugging-port` 被当成 Node 的非法参数，进程报 `bad option` 后立刻退出。脚本同时清掉 `DSH_NODE_EXECUTABLE` 与 `ELECTRON_NO_ATTACH_CONSOLE`。安装目录里可执行文件名带方括号，脚本按 `.exe` 后缀加排除 `uninstall` 的方式查找，不要用通配符直接拼路径。

先运行 `node docs/verify-layout.mjs --help` 查看中文参数说明，再使用实际值替换以下占位符：

```bash
node docs/verify-layout.mjs --cdp '<已有CDP HTTP(S)地址>' --page-url '<已有真实页面完整URL>' --session-id '<会话ID>' --task-selector '<真实任务条CSS选择器>' --goal-selector '<真实目标条CSS选择器>' --out '<JSON证据输出文件>'
```

`--element` 默认 `.fg-hint`，可显式提供当前会话提示条的唯一选择器；`--tolerance-px` 默认 1 CSS 像素。任务条与目标条参数必填，脚本不猜私有类。脚本只从 CDP `/json/list` 选择 URL 精确匹配的唯一已有 page target，不新建窗口、不导航、不刷新、不修改视口或样式，也不提供认证绕过。`file:` 配图预览不能作为真实验证。

已有客户端 API 为异步调用：

```js
await window.__DSH_FLOWGATE_DIAGNOSTICS__.inspectLayout({
  sessionId,
  element: '.fg-hint',
  references: [{ name: '任务条', selector: taskSelector }, { name: '目标条', selector: goalSelector }],
  tolerancePx: 1,
})
```

返回 `{ pageId, evidenceId, version, clientRevision, runtime, viewport, measurements, status, reason }`，其中 `viewport = { width, height }`；每条 measurement 是 `{ element, reference, left, right, referenceLeft, referenceRight }`，`reference` 保留参照的 `name`。`runtime` 使用上一节的版本结构；布局 `status` 为 `pass | fail | uncovered`。诊断 API 统一核对元素挂载根、会话归属与可见性，脚本再检查两个参照的左右边界与完整版本证据，版本不符绝不能 `pass`。`runtime.pageId` 与 `runtime.viewport` 也必须存在；脚本在本次页面读取只读 `api.pageId` 和实际 `window.innerWidth / innerHeight`，记录为 `pageEvidence`，要求顶层与运行时页面身份一致、实际/测量/运行时视口宽高一致，取证过程中不能切页或改变视口。任何身份或视口缺失、不一致均为 `uncovered`，JSON 保留这些原始证据。API 将已核对的实测结果通过 `action: layout-evidence` 登记到宿主，提交 `{ version, pageId, clientRevision, viewport, measurements }`；只有宿主返回绑定该内容版本和页面的回执，结果才带有 `evidenceId` 与 `version`。脚本要求有效 `pass / fail` 都有这两个字段并原样保留；回执失败或缺失只能记 `uncovered`。

JSON 默认输出到标准输出，`--out` 可额外写入指定文件。没有 CDP、认证、插件 API、唯一可见元素或有效版本证据时为 `uncovered`，表示当前取证未覆盖，不等于代码修改失败；版本未核对或不匹配同样为 `uncovered`，仅在版本已核对的情况下测得边界超容差才为 `fail`。退出码 0 表示布局通过（或帮助/脚本自检完成），1 表示测得不符，2 表示未覆盖或取证参数错误。`--self-test` 只检查参数、target 选择及证据判定，不连接真实 GUI。

当前自动视觉采集器只证明左右边界对齐；颜色、主题等其它视觉要求缺少对应可信采集器时保持 `uncovered`，非空截图路径字符串不能据此变成 `pass`。布局回执只关联本机受支持客户端的采集链路，不能宣称它能够抵抗有权限主动伪造 HTTP 请求或脚本的行为，也不能把该关联当作安全证明。

### 维护说明插图

README 的界面图使用真实插件组件与示例数据；[预览页](ui-preview.html) 以 `file:` 加载组件，不代表真实 DSH 已部署或加载新代码。[截图脚本](capture-ui.mjs) 更新 [工作区截图](images/workspace.png) 与 [规则截图](images/rules.png)，其他界面仅验证，不覆盖已有图片。使用现有开发依赖与 Node 22 或更新版本（需要内置 WebSocket）：

1. 准备一个带调试端口的浏览器。首选桌面端自己：`node scripts/start-cdp.mjs`（默认 9222）。需要无头环境时用独立 Chrome：`--headless=new --remote-debugging-port=9229 --allow-file-access-from-files --user-data-dir=<独立临时目录>`，不要使用日常浏览器的用户目录。
2. 在项目根运行 `npm run ui`；只验证、不改图片时运行 `npm run ui:verify`。调试地址通过 `FLOWGATE_CDP` 覆盖（默认 `http://127.0.0.1:9229`）。脚本优先新建独立标签，完成后关闭，保留原有标签与页面；浏览器不支持新建标签时（Electron 的 `PUT /json/new` 返回 HTTP 500 / `Not supported`）自动改为复用已有页面，并在结束时导航回原地址——复用模式会丢掉那个窗口里未保存的输入，所以只指向 `scripts/start-cdp.mjs` 起的临时实例。整套用例接近 5 分钟，前台运行容易撞上工具超时，长跑请放到后台。
3. 脚本在 264 / 320 / 390 / 768 / 1280 像素、明暗主题下检查空闲但有已结束历史、进行中、完成后与放弃后的布局，同时验证历史展开/收起、每页 10 条分页，以及键盘启动、继续和历史操作。预览可用 `?stage=workspace&state=idle|active|finished|cancelled&theme=light|dark` 切换；进行中样例位于历史第三页，用于检查主入口独立于分页。
4. 同时验证四阶段规则切换、默认原文对照、恢复与统一保存、Esc 取消，以及标题和整理稿自动生成、迟到响应隔离与失败重试。人工核对生成的两张图；真实 DSH 仍需按宿主方式构建并刷新其原有 GUI 地址，再单独验证。

**历史回归验证**（非本轮重跑）：源码语法检查及宿主、子代理、集成、客户端、安装五套测试全部通过。新增覆盖无工具预热的宿主重启恢复、目录扫描/文件签名/快照读取错误的连续重试与恢复，以及规则保存、分页、刷新、目录切换后的需求草稿保留和成功启动清理。

**主入口改造验证记录**：使用 Node 24.21.0、Chrome 157.0.8103.51，78 个场景、138 次布局快照、296 项检查全部通过，无脚本异常、横向溢出或布局检查失败。覆盖 1280 / 768 / 390 像素与明暗主题，包含空闲但有已结束历史、进行中、完成后、放弃后，以及其他既有页面；验证了键盘启动与继续、历史 Enter/Space 开合、每页 10 条分页、历史详情无重启表单、完成或放弃后恢复主表单。仅更新 [工作区截图](images/workspace.png)，原有浏览器标签与页面保持不变。

以上结果来自 `file:` 预览加载源码组件与模拟接口，不证明真实 DSH 已加载改动。对 [原有 GUI](http://127.0.0.1:52902) 的只读检查返回 `dsh web authentication required`；独立浏览器会话没有原会话认证信息，因此真实 GUI 的部署加载、运行宿主的新接口与实际门禁交互未覆盖，需另行验证。

**四阶段规则与需求整理的界面验证记录**：本轮使用 Node 24.21.0 和 Chrome 157.0.8103.51，运行更新后的真实组件预览：78 个场景、156 次布局快照、404 项检查全部通过，无脚本异常、横向溢出或失败检查。覆盖 390 / 768 / 1280 像素、明暗主题、四阶段草稿、内置原文对照、单项与阶段恢复、统一保存与保存期间的焦点隔离、Esc 取消、标题与整理稿自动生成、手工编辑保护、迟到响应、失败重试及键盘启动。已更新 [工作区截图](images/workspace.png) 与 [规则截图](images/rules.png)，专用预览标签已关闭，原有标签保持不变。早先的 Windows `OpenProcess` 与浏览器配置目录访问拒绝，在运行策略更新后通过独立临时浏览器重试解决。上述结果来自 `file:` 预览和模拟接口；对[本轮原有 GUI](http://127.0.0.1:53164) 的只读请求仍返回 `401 Unauthorized`，未替用户重启 DSH，真实宿主新接口、真实模型请求和实际门禁交互仍需加载新版本后验证。

最终冻结版自动化验证使用捆绑的 Node 24.21.0 绝对路径，按包脚本原有顺序执行五套入口，整组退出码为 0：宿主 202 项、子代理 58 项、集成 29 项、客户端 143 项、安装 17 项，共 449 项通过。除普通引用句中的 URL、ASCII 与 Unicode 路径保真、双侧歧义降级、原子配置失败及授权生命周期回归外，新增五条长中文/多目录引用路径性能用例、八条统一期限边界和六条未知冒号路径用例。假模型立即返回时，五条性能用例整次调用实测约 2.33 / 1.41 / 2.30 / 2.44 / 0.44ms，均严格检查成功、完整整理稿及低于2000ms；这些数字不代表真实模型耗时。逻辑期限用例通过阶段事件推进单调时钟，在定时器不执行的情况下验证11999ms成功、12000ms准备/流创建/片段/结束/JSON成功或抛错/保真校验均超时回退，并恢复所有全局替身。运行策略更新后，原先因禁止 `spawn git` 跳过的真实 Git 子进程采集场景也已实际通过。宿主、客户端、需求整理模块、截图脚本语法检查及 `git diff --check` 均通过；真实GUI加载和真实模型请求仍以上一段的未覆盖范围为准。

**布局优化验证记录**：本轮保持业务逻辑与交互入口一致，调整工作台密度、快捷台主次、窄容器验收表与固定弹窗的响应方式。`npm test`、`npm run check` 与最终客户端 237 项回归均通过；Chrome 157.0.8103.79 下的组件预览覆盖 264 / 320 / 390 / 768 / 1280 像素、明暗主题，共 130 个场景、260 次布局快照、692 项检查，无失败、脚本异常或横向溢出；隔离复核确认原有浏览器标签与页面保持不变。历史分页新增真实矩形与滚动可达性检查；另外 47 项快捷台、窄宿主验收表、弹窗和历史滚动检查通过。已更新 [工作区截图](images/workspace.png)、[规则截图](images/rules.png)，并补充 [快捷台截图](images/quick-panel.png)。以上为源码组件与模拟接口验证；对[本轮原有 GUI](http://127.0.0.1:60160) 的只读请求返回 `401 Unauthorized`，真实宿主加载版本与实际门禁交互未覆盖。

**折叠控件现代化验证记录**：统一内置原文、技术诊断、其余发现、更多操作、流程记录及按钮式展开入口的视觉反馈与内容间距，保留原生开合和既有业务行为。客户端 237 项回归与 `npm run check` 通过；Chrome 157.0.8103.79 下的组件预览覆盖 264 / 320 / 390 / 768 / 1280 像素和明暗主题，130 个场景、260 次布局快照、712 项检查通过，无失败、脚本异常或横向溢出，原有浏览器标签保持不变。另 140 项专项检查验证诊断长文本、其余发现、全文开合、快捷台 scope / 修改需求状态、向上浮层与减少动画偏好；修复了 264px 下更多操作按钮换行后菜单向左越界的问题。截图前将展开原文滚入可视区域，便于查看标题与正文。验证使用源码组件和模拟接口，真实宿主加载及实际门禁交互仍未覆盖。

**轻量折叠改版验证记录**：根据轻量融入正文的方向，移除普通展开入口的整行边框与底色，使用左侧小箭头、紧凑文字和正文细竖线；原名未变时不重复显示标题，改名后仍保留内置原名。首轮五种宽度与明暗主题检查覆盖 130 个场景、260 次布局快照、712 项检查，均通过；随后专项发现长评审说明被原双列布局挤压，改成可换行的无框正文列表。最终客户端 237 项、折叠专项 140 项、语法与版本检查全部通过。更新 [规则截图](images/rules.png)，新增 [正常鼠标状态的展开近景](images/disclosure.png)。测试来自源码组件与模拟接口，不代表真实宿主已经加载。

流程示意图由 [render_images.py](render_images.py) 单独生成。安装 Python 3 和 Pillow 后运行 `python docs/render_images.py`；默认使用 Windows 微软雅黑，其他系统可用 `FLOWGATE_DOC_FONT` 和 `FLOWGATE_DOC_FONT_BOLD` 指定字体。该脚本不会覆盖界面截图。

### 界面主题与布局

界面颜色来自 DSH 的 `--dsw-alias-*` 主题变量，跟随明暗主题。正文用 `label-primary` 等文字变量，背景用 `bg-base` / `bg-layer-1`，主按钮用 `brand-primary`，状态用 `state-*`。客户端测试会检查颜色字面量和未知变量名。

工作台根节点声明 `data-conversation-composer-overlay`，由自身容器滚动；底部使用 `--dsh-composer-height` 为输入框留白。修改布局时保留这一契约，避免切换标签后滚动位置异常或内容被遮挡。

左侧栏面板没有浮层输入框，由 `.fg-hub > .fg-main` 覆盖为常规内边距，不沿用会话页那段留白。该元素始终保持可滚动，窄屏展开历史列表后仍能到达分页按钮。

工作台采用紧凑间距，需求、规则与历史保持清晰分组；会话快捷台优先展示当前待办，流程标题与计时作为辅助信息。快捷答案维持全宽竖排，并完整展示选项取舍。固定规则弹窗按浏览器视口切换导航布局；验收表按自身容器宽度切换为带字段标签的纵向列表，因此窄侧栏与窄浏览器视口可以分别适配。

折叠区域使用专用 `.fg-disclosure` / `.fg-disclosure-body` 样式，保留原生 `details` / `summary` 的键盘与开合语义。普通入口采用小字与左侧箭头，不铺满边框或底色；展开内容以留白和左侧细竖线组织，内置名称与当前名称相同时省略重复标题，改过名称时保留原名称供对照。流程记录沿用区块标题，快捷菜单保留浮层边界与向上定位。按钮式展开入口通过 `aria-expanded` 同步箭头状态；全文保留 `aria-controls`。快捷台不在 `.fg-root` 内，相关样式需同时覆盖。减少动画偏好下关闭箭头过渡。

## 测试

在项目目录安装开发依赖后运行：

```bash
pnpm install --frozen-lockfile
npm run check             # 宿主与客户端语法检查
npm test                  # 以下各套测试顺序执行
npm run test:host          # 状态机、scope 守卫、规则与门禁流转
npm run test:gatemode      # 门禁模式：自动通过、随时切换、阻塞原因
npm run test:subagents     # 新版 activation、最终守卫、取消与降级的测试替身
npm run test:integration   # 假宿主运行真实 apply()，检查工具、路由与挂起唤醒
npm run test:client        # React 渲染与按钮行为、布局契约、主题变量
npm run test:install       # profile 清单、软链、bundle 与导出契约
```

以上测试都不需启动 DSH；子代理测试使用测试替身，不能证明真实宿主执行成功。`test:install` 依赖本地安装环境，默认检查 `~/.dsh/profiles/desktop`。检查其他 profile 时，先设置环境变量 `FLOWGATE_PROFILE_DIR` 为其绝对路径，再运行该命令。自动化通过后仍需在真实 DSH 中确认入口、门禁按钮、回退和窄屏布局。

## 排障

| 现象 | 先检查什么 |
| :--- | :--- |
| 没有「流程工作台」标签 | 当前 profile 是否安装；是否完全重启 DSH；运行 `test:install` |
| 标签出现但加载失败 | 在开发者工具查看 `/api/flowgate/state`：401 检查桌面端鉴权，404 检查宿主插件加载日志 |
| 门禁按钮不可用 | 是否已提交当前阶段产物，并请求对应门禁 |
| 点击后等待工具仍未返回 | 是否操作了工具正在等待的那类门禁；问题卡片和阶段门禁不是同一个入口 |
| 开发摘要为空 | 区分没有变更和采集失败；检查摘要中的 `error`，以及工作目录是否为 Git 仓库 |
| 修改源码后仍是旧行为 | 宿主端重启；客户端检查构建监听器及实际加载产物 |

变更摘要在 Agent 请求 S2 门禁时采集，早于用户点击「完成开发」。优先用宿主 shell 服务，缺失时用 Node 子进程；采集来源记在 `via`，失败原因记在 `error`。文件列表来自整个工作区的 `git status`，行数来自 `git diff --numstat`，不含暂存区和未跟踪文件的增删行数，因此只作检查线索。
