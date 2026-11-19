# 验证记录

[返回使用指南](../README.md) · [开发与维护](development.md#测试)

以下记录迁自原使用说明，保留当时的环境与结果，不代表本次文档修改重新执行了这些测试。表中的 AC / D 编号沿用当时验收项编号。当前操作方法以[使用指南](../README.md)为准，测试命令见[开发与维护](development.md#测试)。

历史记录中的 `by: 'subagents'` 仅表明调用了子代理聚合入口；聚合报告通过、`blocking: 0` 或流程走完，均不能证明真实子代理成功执行并返回有效报告。下文原有结论保留，其证据范围受此限定。

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
