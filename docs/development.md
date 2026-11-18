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

S1 批准或跳过文档批准后，宿主冻结 scope。S2 对已识别的文件写入 / 编辑工具，按 `in_scope.files_expected_to_change` 核对路径；名单使用相对项目根的具体文件路径，按精确路径匹配，不支持目录或 glob 授权。越界时返回调整 scope 的指引。修改磁盘上的范围文件不会直接更新运行中的授权，应回 S1 重新提交并批准。

S2 同时拒绝被识别为变更性的 shell 命令，如 `rm`、`mv`、`sed -i`、`git checkout` 和重定向写文件，避免通过 shell 绕过文件清单。只读命令可执行。守卫按已知工具名称、参数及命令分类工作，覆盖范围以[宿主实现](../lib/index.js)为准，不能代替文件系统沙箱。

评审与默认测试子代理在执行前按预留的 `childId` 登记到父流程，并由 `tools.guard` 最终工具守卫强制只读。写入 / 编辑工具及未知的变更工具默认拒绝；未经写授权的 shell 仅允许精确的 `pwd`；Git 可能刷新索引或执行仓库配置的外部程序，因此也拒绝。`script_path`、解释器和包测试脚本默认拒绝。读取通过结构化工具完成，`run_code` 仅接受一个工具调用与严格 JSON 参数，不能执行任意 JavaScript。需要修复代码时，回退到 S2 由开发阶段处理；这层守卫仍需配合宿主文件系统沙箱。

### 测试方向的写权限例外

迁移后回滚等测试可能需要执行变更性命令。授权要满足以下条件：

1. 新增自定义测试方向时，勾选「这个方向需要写权限」（`needsWrite`）。
2. 进入 S4 后，在「阶段设置」对该方向显式勾选「授权执行变更性命令」。
3. 宿主记录 `writeGrants`，每次启动该方向的测试子代理时读取授权。

只有 S4 中同时满足该方向 `needsWrite` 与用户 `writeGrants` 授权时，才允许该方向子代理执行变更性 shell；代码写入 / 编辑工具仍拒绝。授权不会在一次执行后自动消耗；取消勾选、流程回退、放弃或本次调用取消时立即失效。启动或释放失败、无法确认子代理已停止时，保留只读隔离并撤销该子会话的变更命令权限。

## 升档与回退

升档调整检查深度，不自动扩大 scope。S3 升档时，回退位置取决于已有评审结果：

| 情况 | 结果 |
| :--- | :--- |
| 没有阻断发现 | 使用严格档继续当前流程 |
| 有阻断发现，但没有落在 scope 外的 CRITICAL / MAJOR | 回到 S2 修复 |
| 有 CRITICAL / MAJOR 落在 scope 外 | 回到 S1，先更新范围并重新批准 |

工作区默认规则记录在 `.dsh-flowgate/config.json`，与流程快照分开；规则继承顺序见[开发规则](#开发规则)。

回退会重置目标阶段及后续门禁，并清除测试写授权；已有代码保留，不会恢复 Git 状态。回到 S1 另清除当前有效范围和需求文档，需要重新提交并批准。升档重置评审角度和测试方向，保留开发规则选择。

当前版本的 S3「回到需求分析调整 scope」按钮实际会退到 S2。需要调整范围时，先退到 S2，再从 S2 回到 S1。

## 开发规则

内置五条规则：只改 scope 内文件、不引入未声明依赖、显式处理错误路径、不留调试残留、遵循既有代码风格。

S2 以卡片展示规则清单；`flowgate_status` 返回同一份清单。S3 的正确性和风格评审会将启用规则写入子代理任务，作为检查项。除修改范围守卫外，这些规则依靠检查与评审执行，不代表每一条都有独立的自动阻断机制。

工作区页的「工作区规则 → 编辑规则」可勾选内置规则，添加、编辑或移除自定义规则，无需需求或会话；内置规则不可删除。弹窗中的修改与「恢复内置默认」均在点击「保存规则」后落盘，取消不保存。流程内仍可通过「阶段设置 → 开发规则」单独调整。

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
| 本次流程临时调整 | `flows/<flowId>.json` 的 `overrides.rules` | 保存为工作区默认后恢复跟随；不用于其他流程 |

工作区默认只存规则（启用清单 + 自定义规则），**不存写权限、不存 scope、不存门禁决策**：这些都是一次性授权或流程内状态，跨流程复用等于让授权永久有效。`config.json` 只含 `version` / `updatedAt` / `rules`，可以提交进版本库；`flows/`、`flows.jsonl`、`scope.json` 是运行记录，应当忽略。

界面会明确标出当前来源（内置默认 / 工作区默认 / 本次流程临时调整），保存后本次流程也改为跟随默认，不会出现「标签说跟随默认、实际还是旧勾选」的不一致。切换档位只重置评审角度与测试方向，不动规则选择。

## 左侧栏面板（先选工作区）

插件在左侧栏注册了两个插槽：`sidebar.panellist` 放一个图标入口，`main` 放对应面板，两者的 id 都必须是 `flowgate-hub`（侧栏条目 id 与 `main` 的 key 同名才会打开面板，这是宿主的导航约定）。

面板是**全局面板**，不绑定会话，因此拿不到 `sessionId`。它维护的是一份**用户自己添加的成员名单**，不是宿主工作区全集——没加过任何东西时面板是空的。名单存在用户级目录，不在任何工作区里：

```text
<DSH_FLOWGATE_HOME | ~/.dsh-flowgate>/hub.json
  { version, updatedAt, members: [{ path, addedAt }] }
```

只存绝对路径与添加时间。任务与规则仍留在各自工作区的 `.dsh-flowgate/`，添加时按需读出展示，**不复制、不改写**——那个工作区里改了规则，面板下次读就跟着变。面板有三态：

- **空名单**：读取用户级名单后，显示 **「添加目录…」** 与 **「添加工作区」** 两个入口。
- **成员列表**：`POST /api/flowgate/hub/members` 只返回工作区摘要（流程总数、进行中 / 待确认计数、规则概况与目录状态），不返回全量 `flows`。
- **详情**：上方独立可折叠的「流程记录」卡片按更新时间倒序，每页 10 条，通过 `/hub/flows` 请求当前页；「工作区规则」独立读取与保存。头部可返回工作区列表或移除名单条目，移除不删磁盘记录。

分页减少响应中的流程数量，不代表没有磁盘扫描；服务端仍需读取或刷新磁盘摘要以统计和排序。兼容接口 `POST /api/flowgate/hub`（`{ paths: [dir] }`）保留流程与规则概况。

点开某条流程后内嵌 `FlowDetail`（`lib/client.js` 里那个完整工作台，同时从 `exports.components.FlowDetail` 导出供单测直接渲染）：它在面板里用 `useEntry(sessionId)` 按 1.5 秒轮询取实时状态，门禁确认、退回修复、改规则、追加范围都在面板内完成。宿主侧栏只有 264–420px，`.fg-hub-flow` 把会话页的三列布局压成单列（阶段导航横排、门禁与设置依次向下）。

**面板里也能开第一条流程**：面板没有 `sessionId`，所以详情态的「开始一次新流程」把 `StartPanel` 的 `sessionId` 换成 `resolveSession`——点「开始需求分析」时才向宿主换会话，链路由 `hubActions.sessionForWorkspace(path)` 提供：

1. 从 `ctx.get('workspaces').list.getSnapshot().items` 里按 `path` 找到 `workspaceId`；
2. `ctx.uiWorkspace.connectWorkspace(workspaceId)` 复用该工作区已连接的会话，没有就新建一个 blank 会话，返回其 `sessionId`；
3. 用这个 `sessionId` 发 `POST /api/flowgate/action` 的 `start`，成功后 `onStarted` 递增 tick，面板重新读盘就能看到新流程。

任一步失败（目录已不是宿主的 workspace、宿主缺 `uiWorkspace`）都在面板里就地显示原因，**不发 `start`**——宁可不启动，也不要落到别的目录上。换会话不会把用户从面板拽走：`connectWorkspace` 不在 UI 上做导航。

**工作区接口**（均在 `routes()` 中，不要求 `sessionId`）：

| 路由 | body | 行为 |
| :--- | :--- | :--- |
| `POST /api/flowgate/hub/members` | — | 返回 `{ members, file }`，成员含路径、名称、目录状态、流程计数、更新时间与规则概况，不含 `flows`。 |
| `POST /api/flowgate/hub/flows` | `{ path, page, pageSize }` | 返回 `{ flows, total, page, pageSize, totalPages }`；默认每页 10 条，上限 50，按更新时间倒序，越界页归到最后一页。 |
| `POST /api/flowgate/hub/rules` | `{ path }` 或 `{ path, rules }` | 省略 `rules` 时读取；传 `{ ids, custom }` 时保存工作区默认，传 `null` 时恢复内置默认；返回 `{ rules }`。 |
| `POST /api/flowgate/hub/add` | `{ path }` | 路径必须是现存的绝对目录（否则 400 `需要一个绝对目录路径` / `工作区必须是现存目录：<path>`）；已登记则不重复写。返回 `{ member, created, imported }`，`imported` 是这次「顺手导入」的数量（`flows` / `rules` / `customRules`）。 |
| `POST /api/flowgate/hub/remove` | `{ path }` | 只从名单移除，返回 `{ removed, path }`。不删任何流程或配置。 |

**目录自动登记**：在面板里点 **「添加目录…」** 走 `ctx.uiWorkspace.pickDirectory()`（原生对话框或应用内浏览，取决于装了哪个 directory-picker 实现），取消返回 `null` 就什么都不做；选中后先 `ctx.get('workspaces').create({ path })` 把它登记成工作区（宿主侧幂等，重复选同一目录不会重复登记），再 `POST /hub/add` 加进名单。`create` 失败时把 `WorkspaceCreateError` 的 message 显示在面板里，不加入名单。

**门禁是会话级的工具调用，但不必回会话去点**：门禁本质是一个会话级工具调用在等待（`GateHub` 按 `sessionId` 索引），`/api/flowgate/action` 也要求 `sessionId`。面板本身不绑定会话，但详情里每条流程都带着 `sessionId`（来自磁盘上的流程快照），所以面板能自己发 `/action`：确认、退回、改规则、追加范围都在面板里做完，数据和原来会话视图里那套是同一份。只有要看对话本身时才点 **「打开会话」**，调 `ctx.uiWorkspace.openSession(sessionId)`。`UiWorkspaceService` 是公开的 cordis 服务（构造函数里 `super(ctx, 'uiWorkspace')`），可以直接用。

服务一律 `ctx.get(name)` 软取，不写进 `exports.inject`：本插件可能先于 `ui-workspace` 激活，且缺服务时插件其余部分必须照常工作。缺 `workspaces` 时「添加工作区」没有候选（只剩「添加目录…」可用）、登记会报错；缺 `uiWorkspace` 时目录选择器不弹（返回 `null`）、「打开会话」提示从左侧栏进入。`workspaces.list` 传给面板的时机也推迟到 `main` 的 inject factory 首次运行（面板挂载时），避免在插件 apply 阶段拿到 `undefined`。

## 工具索引

普通使用只需操作工作台，以下供 Agent 集成和开发时查阅：

| 工具 | 用途 |
| :--- | :--- |
| `flowgate_start` | 启动流程；`title` / `brief` 可选，`preset` 选择档位 |
| `flowgate_status` | 读取阶段、范围、规则和等待状态 |
| `flowgate_ask` | S1 提出决策问题，等待用户点选 |
| `flowgate_doc` | 提交需求 HTML、scope 和档位建议，等待批准 |
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

启动信号只控制 activation 发布前的取消；已发布的 activation 在取消、超时或放弃时必须调用 `dispose` 停止并释放。取消后不再启动后续角度或方向，也不写入迟到的聚合结果。确认 `dispose` 成功后才解除子会话守卫；启动无回执或释放失败时，错误包含子会话 ID，并保留只读隔离、撤销写授权。宿主的启动 reject 可能发生在消息已经投递之后，不能当作未执行的证明。用户自行启动的其他任务仍需自行停止。

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

当前 desktop profile 已通过 `link:D:/Projects/dsh-flowgate` 指向本项目。仅修改宿主 JavaScript 无需重新安装，但必须完全退出并重启 DSH 才加载新模块，浏览器刷新不会生效。本次子代理修复无需客户端改动；本会话不执行重启，重启后的实机验证另行补记。不要仅凭源码或单测已更新就认定当前运行的 DSH 已加载新代码。

### 维护说明插图

README 的五张界面图使用真实插件组件与示例数据，通过 [预览页](ui-preview.html) 和 [截图脚本](capture-ui.mjs) 生成；无需启动 DSH。安装开发依赖后，用 Node 22 或更新版本运行截图脚本（需要内置 WebSocket）：

1. 启动独立 Chrome 调试实例，传入 `--headless=new --remote-debugging-port=9229 --allow-file-access-from-files --user-data-dir=<独立临时目录>`，不要使用日常浏览器的用户目录。
2. 在项目根运行 `node docs/capture-ui.mjs`。调试地址可通过 `FLOWGATE_CDP` 覆盖。
3. 脚本重拍首页、含分页卡片的工作区、工作区规则弹窗、拍板和评审详情，并检查 390 / 768 / 1280 像素下的明暗主题。仍应人工核对截图内容和真实 DSH 中的显示。

流程示意图由 [render_images.py](render_images.py) 单独生成。安装 Python 3 和 Pillow 后运行 `python docs/render_images.py`；默认使用 Windows 微软雅黑，其他系统可用 `FLOWGATE_DOC_FONT` 和 `FLOWGATE_DOC_FONT_BOLD` 指定字体。该脚本不会覆盖界面截图。

### 界面主题与布局

界面颜色来自 DSH 的 `--dsw-alias-*` 主题变量，跟随明暗主题。正文用 `label-primary` 等文字变量，背景用 `bg-base` / `bg-layer-1`，主按钮用 `brand-primary`，状态用 `state-*`。客户端测试会检查颜色字面量和未知变量名。

工作台根节点声明 `data-conversation-composer-overlay`，由自身容器滚动；底部使用 `--dsh-composer-height` 为输入框留白。修改布局时保留这一契约，避免切换标签后滚动位置异常或内容被遮挡。

左侧栏面板没有浮层输入框，由 `.fg-hub > .fg-main` 覆盖为常规内边距，不沿用会话页那段留白。

## 测试

在项目目录安装开发依赖后运行：

```bash
pnpm install --frozen-lockfile
npm run check             # 宿主与客户端语法检查
npm test                  # 以下五套测试顺序执行
npm run test:host          # 状态机、scope 守卫、规则与门禁流转
npm run test:subagents     # 新版 activation、最终守卫、取消与降级的测试替身
npm run test:integration   # 假宿主运行真实 apply()，检查工具、路由与挂起唤醒
npm run test:client        # React 渲染与按钮行为、布局契约、主题变量
npm run test:install       # profile 清单、软链、bundle 与导出契约
```

前四套测试不需启动 DSH；子代理测试使用测试替身，不能证明真实宿主执行成功。`test:install` 依赖本地安装环境，默认检查 `~/.dsh/profiles/desktop`。检查其他 profile 时，先设置环境变量 `FLOWGATE_PROFILE_DIR` 为其绝对路径，再运行该命令。自动化通过后仍需在真实 DSH 中确认入口、门禁按钮、回退和窄屏布局。

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
