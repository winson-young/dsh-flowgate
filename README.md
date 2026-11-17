# dsh-flowgate

DSH 的**流程约束开发工作台**：把「需求分析 → 开发 → 评审 → 测试」做成一套带代码级门禁的固定流水线。

直接对话推进开发时，阶段顺序靠模型自觉，评审常常同一个 Agent 自批自过，scope 在开发过程中无声膨胀。这个插件用宿主端的门禁替代提示词纪律：

| 维度 | 直接对话 | dsh-flowgate |
| :--- | :--- | :--- |
| 流程顺序 | 提示词「建议」 | **硬顺序**：前序阶段没过门禁，后续阶段的写操作被拒绝 |
| 评审独立性 | 同 Agent 自审 | **只读子代理** + `toolFilter.deny` 剥离写工具 |
| Scope | 开发中口头约定 | **需求阶段冻结 `scope.json`**，越界即阻断 |
| 用户操作 | 大量文本输入 | **按钮化**：追问、门禁、验收全部点选 |

## 安装

```bash
# 开发期用 link:（改代码即时生效）；file: 是复制，改了不生效
dsh plugin --profile <profile> add link:D:/Projects/dsh-flowgate
```

装完**重启 DSH 进程**：客户端 bundle 元数据按包名缓存，不重启拿不到新的 `dsh.client` 声明。

装好之后，改代码的生效范围不一样：

| 改的是 | 要做什么 |
| :--- | :--- |
| `lib/client.js`（客户端半） | 存盘即可，浏览器收到 rebuild 帧自动 reload |
| `lib/index.js`（宿主半） | **必须重启 DSH 进程**——宿主模块 import 一次就缓存了 |

宿主半改了没重启，表现是「工具还是旧行为、界面还是旧字段」，而文件、测试、git 都是新的。`npm test` 跑的是文件，验不出这件事。

### 桌面端（desktop profile）

桌面端由 Electron 独占管理 profile，CLI 的 `dsh plugin` 装不进去，直接改 profile 清单：

```jsonc
// %USERPROFILE%\.dsh\profiles\desktop\package.json
{
  "dsh": { "profile": { "bundles": [ /* …原有条目… */, "dsh-flowgate" ] } },
  "dependencies": { "dsh-flowgate": "link:D:/Projects/dsh-flowgate" }
}
```

```bash
cd "$USERPROFILE/.dsh/profiles/desktop" && pnpm install --prefer-offline
```

然后完全退出并重启桌面端。装完用 `npm run test:install` 复核清单、软链、bundle 契约与宿主导出是否都对得上。

## 四阶段与门禁

| 阶段 | 产出 | 出口门禁 |
| :--- | :--- | :--- |
| S1 需求分析 | 单文件 HTML 需求文档、`scope.json`、档位选择 | 批准并冻结 scope / 跳过评审直接开发 |
| S2 开发 | 代码变更（对照 scope 白名单） | 完成开发 / 跳过 / 回到 S1 调整 scope |
| S3 评审 | 每角度结构化报告（`file:line` + severity） | 通过评审进入测试 / 退回开发修复 |
| S4 测试 | 方向 × 要点的结构化结果 | 验收通过结束流程 / 退回开发修复 |

「跳过」只发生在门禁处：跳过后该阶段记 `skipped_by_user`，工作台顶部台账单独计数「本流程有 N 个阶段被跳过」，但顺序本身不可绕过。

## 两条铁律

**scope 冻结。** S2 期间对 `in_scope.files_expected_to_change` 之外文件的任何 `write` / `edit` / `str_replace_editor` 都会被宿主端 `tools/pre-execute` 拦下，返回：

> 该文件不在冻结 scope 内。要修改它，必须先回到需求分析阶段更新 scope.json 并重新批准。

**变更性 shell 在 S2 也被拦。** shell 命令没法逐条核对 scope，放行等于给 scope 边界开后门，所以
`rm` / `mv` / `sed -i` / `git checkout` / 重定向写文件这类命令在 S2 同样被拒绝，指引改用 `write` / `edit`。
只读命令（`git diff`、`git status`、`grep`…）不受影响。

**评审只读。** 评审子代理 spawn 时带 `toolFilter.deny`，把 `write` / `edit` / `str_replace_editor` / `subagent` / `send_message` 等工具从它的工具集里彻底剥离，它只能读 diff、读文件、跑只读 shell。

> shell 工具名按集合识别（`bash` / `shell` / `exec` / `ops_bash` / `powershell`…），不硬编码某一个名字——
> 不同 profile 装的 shell 插件不一样，只认一个名字等于给自己留后门。

## 档位

同一套流程引擎的两组预设参数，不是两条流程：

| 参数 | 小功能快速开发（默认） | 大需求严格执行 |
| :--- | :--- | :--- |
| 评审角度 | 2（正确性、测试质量） | 4（安全、正确性、测试质量、风格） |
| 测试方向 | 1（冒烟验证） | 3（功能正确性、边界与异常、回归影响） |
| 追问深度 | 较浅 | 较深 |

用户可以在右侧「阶段设置」里勾选或追加角度/方向——追加只在内置集合上加条目，不替换内置项。中途升档只作用于尚未进行的阶段。

升档只改**执行深度**，不改**范围**（D4）。S3 点升档时按评审发现落在哪决定回退深度：

| 评审发现 | 回退到 | 理由 |
| :--- | :--- | :--- |
| 全在冻结 scope 内 | S2 | 重做开发就能修 |
| 有 CRITICAL / MAJOR 落在 scope 外 | S1 | 重做 S2 修不了，得先更新 scope.json 并重新批准 |

两种情况 scope 都**不会自动扩充**；评审卡片会列出落在 scope 外的那几条。

## 开发规则

开发规则是**结构化检查清单**，不是提示词里的一句「请遵守项目规范」。内置五条：只改 scope 内的文件、不引入未声明的依赖、错误路径显式处理、不留调试残留、与既有代码风格一致。

- S2 里规则清单以卡片形式出现在主区，Agent 通过 `flowgate_status` 拿到的也是同一份逐条清单；
- S3 的**正确性**与**风格**角度会把规则逐条写进子代理 prompt，未遵守的作为 finding 报出来；
- 用户可以在右侧「阶段设置 → 开发规则」里勾选或追加自定义规则——追加只在内置集合上加条目，内置规则不可删除。

## S4 的写权限例外（D2）

评审与测试默认都是只读的。v1 里唯一的例外是**测试方向声明需要写权限**：某些方向必须跑变更性命令
（例如迁移后回滚），只读 shell 无法覆盖。

例外走三步，缺一步都不生效：

1. 追加自定义测试方向时勾选「这个方向需要写权限」，条目带上 `needsWrite`；
2. 进入 S4 后，在右侧「阶段设置」里对该方向**显式勾选**「授权执行变更性命令」；
3. 宿主端把这次授权记进 `writeGrants`，只对该方向当次 spawn 的测试子代理生效。

授权只覆盖**变更性 shell**。`write` / `edit` / `str_replace_editor` 对这些子代理仍然硬拒绝——
允许跑迁移，不等于允许改代码。流程一旦回退（`rollbackTo`），`writeGrants` 立即清空，重做后要重新授权。

## 工具

| 工具 | 用途 |
| :--- | :--- |
| `flowgate_start` | 启动四阶段流程（可在对话里让 Agent 调） |
| `flowgate_ask` | S1 提出一个决策问题，等用户点选 |
| `flowgate_doc` | 提交需求文档 HTML + scope，挂起等门禁 |
| `flowgate_gate` | 请求当前阶段的出口门禁 |
| `flowgate_review` | 提交 S3 评审报告（报告由当前 Agent 产出） |
| `flowgate_review_run` | 由宿主端为每个评审角度 spawn 只读子代理，聚合后挂起等门禁 |
| `flowgate_test` | 提交 S4 测试报告（报告由当前 Agent 产出） |
| `flowgate_test_run` | 由宿主端为每个测试方向 spawn 执行单元，聚合后挂起等门禁 |
| `flowgate_status` | 读取当前流程状态 |

`flowgate_review_run` / `flowgate_test_run` 只在宿主提供 `subagents` 服务时可用（视图里的 `canSpawn` 会告诉客户端）；
不提供时用 `flowgate_review` / `flowgate_test` 由当前 Agent 直接产出结构化报告，门禁语义完全一致。

所有等待门禁的工具调用会**挂起**直到用户在面板上点击，所以 Agent 不会替你拍板。

## 测试

```bash
npm test              # 四套全跑
npm run test:host     # 状态机 / scope 守卫 / 规则清单 / 门禁流转（纯 node，无需 DSH）
npm run test:integration  # 假宿主跑真实 apply()：工具注册、pre-execute 守卫、HTTP 路由、挂起-唤醒
npm run test:client   # 用 react-test-renderer 真渲染客户端并点击按钮
npm run test:install  # 静态核对 profile 清单、软链、bundle 契约（需先装进 profile）
```

`test:install` 按 DSH 的客户端模块扫描规则复核：`dsh.client` 字段形状、`exports["./client"]` 是否指向真实文件、
bundle 的 `__ModuleLoader__.load` id 是否等于包名、宿主半有没有跨包值导入。这些错了宿主只会静默跳过该插件，
提前用一条命令查出来比在界面里找不到入口好排查。

## 验证

### 不开 DSH 就能验的

```bash
npm test          # 136 项：状态机 / 假宿主集成 / 客户端真渲染点击 / 安装就绪度
npm run test:install  # 装进 profile 后的清单、软链、bundle 契约
```

`test:client` 用 react-test-renderer 真渲染客户端并模拟点击，断言的是「点这个按钮会发出哪条 RPC」；
`test:integration` 用假宿主跑真实 `apply()`，断言的是「那条 RPC 到达宿主后会怎样」。两者之间没有手工台阶。

### 重启桌面端后的手测

装完必须**完全退出**桌面端再启动（客户端 bundle 元数据按包名缓存）。重启后按顺序走一遍，每步对应 PRD 的一条验收标准：

| 步 | 操作 | 期望 | 对应 |
| :--- | :--- | :--- | :--- |
| 1 | 对话视图顶部看标签 | 多出「流程工作台」；输入框上方有常驻状态条 | 加载成功 |
| 2 | 让 Agent 调 `flowgate_start` | 左侧 S1 高亮，主区出现追问卡片 | — |
| 3 | S1 阶段直接让 Agent 写文件 | 被拒绝，提示「要先通过 S1 门禁」 | AC-1 |
| 4 | 在追问卡片点推荐项 | 立即回答、下一张卡片出现，不用打字 | AC-5 |
| 5 | 点「批准并冻结 scope」 | 进入 S2，scope 三色清单可见 | — |
| 6 | 改一个 scope 外文件 | 被拒绝，返回路径 + 「回到需求分析调整 scope」按钮 | AC-3 |
| 7 | 点「完成开发」 | 进 S3，变更摘要带 `+N/-M` 行数 | D1 |
| 8 | S3 让评审子代理试 `write` | 工具层 deny，reason 含「只读」 | AC-4 |
| 9 | S3 点「升档到大需求严格执行」 | 只切 S3/S4 参数，S2 记录不变 | AC-6 |
| 10 | S3 有阻断项时点「升档」 | 回退到 S2 重做，评审发现作为输入 | AC-7 |
| 10b | 阻断项落在 scope 外的文件上，再点「升档」 | 回退到 S1 调 scope，评审卡片列出 scope 外的发现 | D4 |
| 11 | S4 点「验收通过，结束流程」 | 顶部台账显示完成；`.dsh-flowgate/flows.jsonl` 落盘 | AC-8 |
| 12 | 在任一门禁点「跳过」 | 该阶段标「已跳过」，台账计数 +1，后续阶段仍可推进 | AC-2 / D3 |

### 实机验证记录（2026-11-17，桌面端 0.2.2-rc.3）

五条流程在真实桌面端跑通，每条都是「用户点按钮 → 宿主状态机推进」，Agent 只在中间调工具：

| 流程 | 验到的 | 结论 |
| :--- | :--- | :--- |
| 会话过期返回 401 | AC-1 / AC-3 / AC-5 / AC-8 | S1 写操作被拒；两次追问卡片点选完成；越界写被拒并给出回退指引；16 条事件落盘 |
| 跳过与升档 | AC-2 / D3 | 门禁点「跳过评审直接开发」后 scope 仍冻结、S1 记 `skipped_by_user`、台账计数 1，S2 可进入 |
| 评审升档回退 | AC-6 / AC-7 | fast 起步 → S3 评审 2 角度发现 1 个 CRITICAL（落在 scope 内）→ 点升档 → 回退 S2 → 重做后评审 4 角度、测试 3 方向；scope 始终 1 个文件（未扩充） |
| 严格档全流程 | AC-6 | S1 门禁直接选严格档，评审 4 角度、测试 3 方向，含 `fail` / `uncovered` 结果正常聚合 |
| 升档后重做 | D1 | `dev.summary` 在两次 S2 里都自动采集，用户没贴过 diff |

实机验证期间发现并修掉的真实缺陷：

- **变更性 shell 在 S2 被放行**：`rm -rf src/api` 真的执行了。现在 S2 也拒绝，并指引改用 `write` / `edit`。
- **shell 工具名硬编码 `bash`**：本 profile 装的是 dsh-ops，真名 `ops_bash`，守卫对真实 shell 完全失效。
  改为 `SHELL_TOOLS` 集合后 `ops_bash` / `powershell` 等别名同样受管。
- **升档清空开发规则**：`flow.overrides` 整体重置会把用户勾选的规则一起丢掉，现在只重置角度与方向。

D4 的另一半（发现落在 scope 外 → 回退 S1）在实机上没有跑到，由 `test/host.test.mjs` 的「D4 升档遇到 scope
外发现时回退 S1 而不是 S2」用例覆盖：断言回退目标为 S1、`reviewOutsideScope` 列出该文件、scope 未被扩充。

### 出问题先看哪

- **标签没出现** → 跑 `npm run test:install`。它静态复核 DSH 的客户端模块扫描规则（`dsh.client` 形状、
  `exports["./client"]`、bundle 的 `__ModuleLoader__.load` id、宿主半有无跨包值导入）。这些错了宿主只会静默跳过。
- **标签在、点了没反应** → 打开开发者工具看 `/api/flowgate/state`：401 是桌面端鉴权，不是插件问题；
  404 说明宿主半没加载（看宿主日志里有没有 `flowgate` 行）。
- **门禁按钮点了不推进** → 确认是不是在等另一个门禁：门禁只认自己那一类结果，点错面板的按钮不会唤醒等待中的工具。

## 数据

流程快照与事件日志落在工作区的 `.dsh-flowgate/`：

```
.dsh-flowgate/
  scope.json            # 冻结的 scope
  flows/<flowId>.json   # 单条流程的完整快照
  flows.jsonl           # 追加式事件日志（门禁、跳过、回退、升档）
```

## 界面

- **左侧**阶段导航条：不可点击跳转，只能通过门禁推进或回退。
- **中间**当前阶段内容：追问卡片 / 需求文档预览 / 开发变更与规则清单 / 评审报告 / 测试报告。
- **右侧**可收起面板：阶段设置与出口门禁。

对话视图在「流程工作台」标签下；输入框上方另有一条常驻状态条，显示当前阶段与门禁是否在等你。

## 许可

MIT
