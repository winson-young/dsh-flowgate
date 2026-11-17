# Changelog

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
