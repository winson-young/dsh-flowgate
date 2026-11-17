# 验证记录

[返回使用指南](../README.md) · [开发与维护](development.md#测试)

以下记录迁自原使用说明，保留当时的环境与结果，不代表本次文档修改重新执行了这些测试。表中的 AC / D 编号沿用当时验收项编号。当前操作方法以[使用指南](../README.md)为准，测试命令见[开发与维护](development.md#测试)。

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

- **变更性 shell 在 S2 被放行**：`rm -rf src/api` 真的执行了。现在 S2 也拒绝，并指引改用 `write` / `edit`。
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
