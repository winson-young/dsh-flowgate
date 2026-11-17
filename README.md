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

**评审只读。** 评审子代理 spawn 时带 `toolFilter.deny`，把 `write` / `edit` / `str_replace_editor` / `subagent` / `send_message` 等工具从它的工具集里彻底剥离，它只能读 diff、读文件、跑只读 shell。

## 档位

同一套流程引擎的两组预设参数，不是两条流程：

| 参数 | 小功能快速开发（默认） | 大需求严格执行 |
| :--- | :--- | :--- |
| 评审角度 | 2（正确性、测试质量） | 4（安全、正确性、测试质量、风格） |
| 测试方向 | 1（冒烟验证） | 3（功能正确性、边界与异常、回归影响） |
| 追问深度 | 较浅 | 较深 |

用户可以在右侧「阶段设置」里勾选或追加角度/方向——追加只在内置集合上加条目，不替换内置项。中途升档只作用于尚未进行的阶段；S3 升档且评审已发现 scope 内问题时，流程回到 S2 按升档参数重做，但 **scope 不会自动扩充**。

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
npm test              # 三套全跑
npm run test:host     # 状态机 / scope 守卫 / 门禁流转（纯 node，无需 DSH）
npm run test:integration  # 假宿主跑真实 apply()：工具注册、pre-execute 守卫、HTTP 路由、挂起-唤醒
npm run test:client   # 用 react-test-renderer 真渲染客户端并点击按钮
```

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
- **中间**当前阶段内容：追问卡片 / 需求文档预览 / 开发变更 / 评审报告 / 测试报告。
- **右侧**可收起面板：阶段设置与出口门禁。

对话视图在「流程工作台」标签下；输入框上方另有一条常驻状态条，显示当前阶段与门禁是否在等你。

## 许可

MIT
