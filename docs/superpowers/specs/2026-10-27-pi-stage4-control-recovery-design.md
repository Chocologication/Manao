# Pi 阶段四：接管与手动继续设计

日期：2026-10-27。状态：**PI_STAGE4_CONTROL_RECOVERY_PASS**。本地测试与已授权云端验证边界由[阶段四验收](../../../poc4/docs/evidence/ai-stage4/acceptance.md)拥有；生产源码e3c06dd已发布，Stage2和原故障Task边界不变。

## 1. 用户决定与范围

本轮依据关联聊天“ai集成--bug修复及整理”的五项后续建议：第一项原故障 Task 恢复、第二项阶段二正式验收暂缓；第三项关键云端故障验证已完成；当前实现第四阶段。第三项实际边界由源 AI checkout 的 `poc4/docs/evidence/ai-terminal-settlement/cloud-faults-20261027.md` 拥有；该文件为其他会话未提交资料，仅只读核对，未复制到本分支，不能扩写成完整故障矩阵 PASS。阶段二仍为 PAUSED / NOT_GRANTED，原 Task 仍为 NOT_REPAIRED。

用户本轮明确接受：**同一会话内新建执行**。暂停后停止并结算旧 Task、交还编辑权；用户保存修改后，“继续”创建新的 Task，继承同一 conversation 的已持久化上下文，重新获得现有的 1800 秒、180 次工具、20 次构建预算。旧 Task 不复活、不续剩余预算、不重放旧工具。

阶段四交付：暂停接管、修改后继续、浏览器重进、服务异常核对后手动继续、执行资源清理的可验证闭环。继续沿用六个工具、固定 Maven goal 与只读副本构建；不开放自由 Shell，不添加语言适配、多 Agent、MCP/Skills、通用恢复框架或独立执行服务。

## 2. 现有能力与真实缺口

核对基线：`codex/ai-integration@1d410cd`，`.worktree/ai-integration`。该 checkout 已存在其他会话未提交的云端证据与文档整理，必须保留。后续实施应从包含本计划的最新 AI 分支建立独立 worktree，不从尚无 AI 实现的 master 起步。

| 接缝 | 当前实现 | 本阶段处理 |
| --- | --- | --- |
| 收尾 | `AgentTaskService.close` 保存意图；`AgentTaskSettlementService` / `AgentTaskReconciler` 核对 receipt、claim、Build、Run 后释放 | 增加暂停语义，复用同一收尾；不新建调度器 |
| 会话继续 | `ConversationContext.prepare` 恢复已确认历史、屏蔽不完整旧工具轮，插入当前 revision 与重读提示 | 复用，并补用户修改与中断回归；不实现 SDK 原执行续跑 |
| 长构建 | `AgentProjectTools.runBuild` 持有 live claim；`awaitSettlement` 等自然退出/预算；收尾遇到 claim 会等待 | 构建循环读取持久关闭意图并停止原 Job，自己完成核对后释放 claim |
| Worker 停止 | `stop()` 中止 SDK；现有 close 不使用返回值作为 Worker 完全退出证据 | 暂停与服务丢失恢复需核对执行退出，避免界面显示可继续但旧 slot 尚占用 |
| 服务异常 | 收据可跨 backend 重启；无收据且 Worker 丢失通常等到期限或 owner close | 在新任务有充分“旧执行实例已丢失”证据时提前进入同一安全收尾；不自动启动新 Task |
| 浏览器 | 已有 owner/project scoped current Task、会话历史与持久提交意图 | 增加暂停/继续展示，刷新继续读取权威状态 |
| 清理 | Build 原身份核对；关联 Run 清理；项目删除已有流程 | 补与接管直接相关的证据；不新建清理控制器 |

## 3. 选择最小方案

| 方案 | 代价 | 决定 |
| --- | --- | --- |
| 复活同一 Task，保存执行点、预算与多次 epoch | 改动终态不可逆、receipt、计时和历史写者协议 | 用户已选择不采用 |
| 会话内新 Task + 原收尾路径 | 增加薄控制入口、少量展示数据及构建停止检查 | **采用** |
| 新任务引擎、durable SDK、消息队列、执行池 | 新运维/持久化与兼容面，不能替代副作用核对 | 排除 |

保持现有 `QUEUED / RUNNING / NEEDS_ATTENTION / COMPLETED / FAILED` 数据状态，不加 `PAUSED / RESUMING` 或逻辑 Task 父表。暂停的是用户会话的连续工作；旧执行在安全结算后以 FAILED 及明确关闭原因记录中断。界面展示“已暂停”，不要将其显示为模型失败。后续扩展通过既有 conversation、Task、工具与执行器边界接入。

## 4. 控制接口与状态投影

新增唯一控制入口：

```http
POST /api/v1/projects/{projectId}/agent-tasks/{taskId}/pause
```

无请求体，复用 owner/project/task 校验及现有 close 的幂等特性，服务端固定原因 `AI_PAUSED_BY_OWNER`。不得接受调用者任意指定 failureCode。成功返回当前 TaskSnapshot；HTTP 200 只表示已记录/已查询，不承诺停止完成。gate 忙返回现有409。尚未绑定Worker的启动阶段返回409 `AI_TASK_STARTING`，不写暂停意图；界面显示“正在启动，稍后可暂停”，原结束入口继续可用。绑定后再接受暂停，避免为极短启动窗口新增身份补绑协议。重复请求不得改变首个关闭原因；已完成或失败任务保持原终态。

TaskSnapshot 加可空 `closeReasonCode`，取已有 `close_reason_code`，不新增列。旧 JSON 缺字段按 null 解析，Java 兼容构造器继续委托完整 record。旧 `/close` 行为保留：明确结束，不默认展示为暂停。

| 持久事实 | 用户展示/操作 |
| --- | --- |
| QUEUED且未绑定Worker | 正在启动，稍后可暂停；现有结束入口继续保留 |
| 已绑定、占用且未关闭 | 暂停并接管；现有结束入口继续保留 |
| 占用且 `closeReasonCode=AI_PAUSED_BY_OWNER` | 正在停止并核对；编辑/继续禁用，当前会话显示禁用的继续按钮 |
| 已释放且 `closeReasonCode=AI_PAUSED_BY_OWNER` | 已暂停；刷新项目事实后可编辑；当前会话可继续 |
| 已释放且 `closeReasonCode=AI_WORKER_RESTARTED` | 上次执行因服务重启中断，已完成核对；可手动继续 |
| 已释放且其他失败原因 | 保留原失败信息，可在同一会话提交修正任务 |
| Task 或 Run 权威未知 | 等待核对/重试读取；不允许写入或继续 |

所有展示由服务端 snapshot 与 Run authority 推导，不保存另一套暂停状态到 localStorage。`closeReasonCode` 和原 `failureCode` 分工明确：前者解释控制意图，后者保留已有失败事实；不得为了文案覆盖已确认的 provider/工具错误。

## 5. 暂停与释放的次序

1. 在原短 gate/事务协议下保存关闭意图，拒绝旧 Task 新工具、创建预约及新上下文写者。不重新设计锁序。
2. 原 reconciler 在 gate/事务/Task monitor 外先推进原资源 finish，再通知 Worker stop、读取退出证据，避免慢 Worker 查询反复耗尽共享预算而使资源清理饥饿。停止请求或 STOPPING 不是退出完成。
3. 对 `AI_PAUSED_BY_OWNER / AI_WORKER_RESTARTED`，用现有认证 `/status` 和 Task status 核对旧执行已终止且该 Task 已释放 Worker slot，或旧进程已被替换。终态交付的 `ACKED` 与 `CLOSING` 都是匹配报告已获确认的状态；CLOSING 不会再转成 ACKED。未知则维持占用并由原 reconciler 重试。旧 Worker 的终态投递继续走既有 CLOSING ACK，不能先要求 slot 空再允许 ACK 而造成死锁。未绑定实例的Task不能进入本次新增暂停路径。
4. 原执行线程响应关闭：构建主动结束 Job，文件写入按 receipt 核对，应用仅处理本 Task 已登记的原 start/stop 目标。不得重发不明文件 mutation 或 app HTTP。
5. 原收尾在最终短锁内复核：无 live claim、无未决写 receipt/call、原关联应用结束，以及必要的 Worker 退出证据仍对应同一 Task/epoch/实例；随后终态释放。未知任何一项都继续占用。Worker退出观测不得阻止本轮原资源核对推进，最终结合两类证明决定是否释放。
6. 前端失效并重取文件树、已打开文件和 workspace revision；保留用户尚未保存的草稿，出现冲突走原冲突流程。人工编辑仍受现有 Run 锁约束。

暂停会停止本次 Task 创建/已登记处理的应用 Run，以便接管；正常 COMPLETED 保留 READY 应用的行为不变。对未被该 Task 触碰的其他旧 Run，不扩大停止范围；UI 明示“AI 已暂停，应用仍运行，请先停止应用再编辑”，使用原 Run stop 入口。

## 6. 长构建的最小取消接缝

不能靠取消 Worker HTTP 等价推断 Java 请求线程或 Kubernetes Job 已停止。给 `Fabric8DevelopmentBuildExecutor` 增加窄的 `Predicate<BuildRequest> stopRequested` 注入；生产 `AiConfig` 使用 `AgentTaskStore.hasCloseIntent(tasks.settlementView(request.taskId()))`，保留现有构造器给旧测试使用。不要误用 `hasClosingIntent`：它把所有非QUEUED/RUNNING状态都看作禁止创建，不能区分等待成功收据与真正关闭。此处是事实查询，不是取消注册中心。

`awaitSettlement` 每次观察前检查 stopRequested；关闭已登记时，按原 commandId/Job UID/Pod owner 执行已有 cleanup，返回 `BUILD_CLOSED` 与真实 cleanupConfirmed。runBuild 保持 live claim，直到结果落库或记录 NEEDS_ATTENTION，才在原 finally 释放。创建前依旧使用原 creation fence；不因检查新增创建路径。后台收尾只处理没有 live claim 的重启遗留，两者不抢删。

数据库检查失败、Kubernetes 超时、身份不符、删除仅被接受而 Pod 仍存在，都不得返回 cleanupConfirmed=true。停止响应以原轮询与有界 I/O 推进；无需等600秒构建期限，也不承诺集群异常时固定秒数解锁。不要引入线程强杀、通用 Future 取消表或新执行池。

## 7. 服务异常与继续

backend 重启且原 Worker 仍执行：继续原 Task，保留原 deadline、身份和 receipt，不额外停止或重复 prompt。浏览器重连同理。

新 Task 无收据且 Worker 确定重启：在原 importTerminal 路径获取 `/status` → 原 task 查询 → `/status`。只有两次有效 status 同一个新 boot、与已绑定旧 instance 不同、旧 task 返回认证后的明确 404，且短锁重读仍无收据/关闭意图、同 epoch/instance 时，才 CAS 登记 `AI_WORKER_RESTARTED` 并进入原收尾。关闭前已有合法收据优先按收据处理；关闭后晚到报告不得逆转。三次观察共享原5秒工作预算，第三次未完成则保留占用后重试，不增加后台线程/诊断持久化。已到deadline时仍由既有预算CAS先裁定。

单个404、超时、401/403、坏JSON、同boot找不到Task、未绑定实例均属未知；不推断旧执行死亡。当前部署模板 `poc4/deploy/ai-stage1/pi-worker.yaml` 明确 `replicas: 1 / strategy: Recreate`；发布时重新确认该合同，多副本或滚动重叠需另行设计。`deadline_at=NULL` 的历史任务不自动应用本次新恢复策略，尤其不触碰原故障 Task。

“继续”复用现有 conversation task 提交，使用最新已保存 revision 和当前 reasoning effort，生成一次新 taskId。默认 prompt 为“继续这个会话中尚未完成的工作。先读取当前项目相关文件并核对应用状态，基于当前已保存版本继续；不要重放上一次未确认的工具操作。”用户可用输入框补充/替换目标。请求丢失依旧核对相同新 taskId，未知不再创建第二个。多标签页竞争由原唯一占用约束裁定。

新任务 `ConversationContext.prepare` 使用已 ACK 的历史、过滤未完成工具轮、加入当前 revision。模型先读取相关文件；已有文件继续依靠 `expectedSha256` 和 revision 校验，旧SHA不能覆盖用户修改；省略SHA仍只允许创建不存在的新文件。测试必须覆盖“新任务提交使用新revision，但模型携带旧SHA”的拒绝与重读修复。不额外增加Worker读取凭证Map或新错误码：它重复已有乐观并发保护且扩大所有文件工具测试面。语义上是否读全相关文件仍由模型决定，平台只保证旧内容不能绕过版本校验覆盖新内容。

只保留已持久化的上下文，不承诺恢复 Worker 被终止时尚未 ACK 的最后几个 token；绝不把截断的输出拼造成成功工具结果。

## 8. 资源与验证边界

继续沿用既有 Build、Run 与项目删除流程。暂停/异常恢复后核对该 Task 开发 Job/Pod 已退出且不存在、原 receipt 已确定、关联应用已处理；项目 workspace/PVC、项目数据库及缓存保留，只有用户明确删除项目才走原项目删除语义。项目删除回归检查 AI 占用时拒绝，安全接管后才能进行，最终无本项目开发执行残留。

本地必测：实际 MySQL 持久状态与并发CAS、真实本地 HTTP/Worker 协议、scripted provider 经真实 SDK、前端组件与浏览器；资源侧 mock 不冒充真实 Kubernetes。后续发布授权后只跑阶段四的精简云端链路：长构建暂停→确认子进程/Pod退出→保存用户修改→同会话新Task读到修改→刷新恢复；再覆盖Worker重启核对和专用项目删除。无需为本阶段重跑已完成的整个收尾A–N矩阵或真实1800秒等待。阶段二验收仍暂缓。

## 9. 自检与维护性

- 删除候选：新状态机、逻辑Task父表、暂停剩余预算、自动重放、单独恢复API/恢复scheduler、通用取消总线、健康诊断历史表、额外Worker PVC。
- 必须保留：持久控制原因、原身份/receipt核对、执行结束后才释放、用户修改后重新读取、提交幂等、实际资源清理证明。它们分别防止旧执行串写、覆盖修改、重复模型/工具或资源泄漏。
- 预期无数据库迁移、无新依赖、无新增生产服务；后端薄入口和既有收尾/执行器扩展，前端只抽取有实际复用的提交逻辑与状态文案。
- 已有近1700行TaskStore不因本次全部拆分；仅增加具名的小查询/CAS方法。新职责确需独立文件时先说明具体复用和测试收益。
- Context7已查询Pi官方资料；当前文档可能更新，实际接口核对以本地锁定1.2.0声明为准：`abort(): Promise<void>`、`SessionManager.inMemory(cwd?, options?, entries?)`。不以SDK abort代替远端清理，不升级SDK。

实施细节与逐任务验收见[实施计划](../plans/2026-10-27-pi-stage4-control-recovery-implementation-plan.md)，执行授权边界见[Agent交接](../plans/2026-10-27-pi-stage4-control-recovery-agent-handoff.md)。
