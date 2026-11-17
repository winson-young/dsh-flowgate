# Changelog

## Unreleased

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
- 188 项测试：宿主状态机（80）、假宿主集成（23）、客户端真渲染点击（72）、安装就绪度（13）。
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
