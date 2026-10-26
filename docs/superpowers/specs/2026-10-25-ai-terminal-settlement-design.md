# AI 任务可靠收尾修复设计

设计日期：2026-10-25。2026-10-26 状态：Task 1–8、本地验证及整分支独立审查完成，LOCAL_REPAIR_VERIFIED；生产修复代码终点为5739d1b。实际证据、已知限制与保留项见[验收记录](../../../poc4/docs/evidence/ai-terminal-settlement/acceptance.md)及[最终审查](../../../poc4/docs/evidence/ai-terminal-settlement/review.md)。该本地审查之后，用户另行授权并完成758aae6集群发布和一次最小真实模型收尾验证，DEPLOYED_SMOKE_VERIFIED，见验收第8节。完整云端故障矩阵NOT_RUN，原故障Task NOT_REPAIRED，Stage2 PAUSED/NOT_GRANTED；未Git push/merge。

## 1. 目标与事实

目标：短暂的项目锁竞争、回调丢失、后端或 Worker 重启，都不能让已结束的 AI 任务无限显示 RUNNING；同时，任何未知副作用都不能被当作已停止，从而提前释放项目写权限。

依据：[调查报告](../../../poc4/docs/evidence/ai-output/terminal-settlement-20261025.md)、[隔离实验](../../../poc4/docs/evidence/ai-output/terminal-settlement-race-safe.json)。故障机制已复现，历史 binlog 强烈支持恢复巡检锁竞争；历史 HTTP 409 没有抓包记录，不将推断升级为已观测事实。

- `AgentTaskService.applyProgress` 与 Run 巡检争抢 `ProjectLifecycleGate`。
- `ProgressChain` 立即重试一次后吞异常，最后消息和终态都可能丢失。
- `RuntimeMaintenanceLoop` 每15秒调用 `recoverRuns`，正常 RUNNING 反复进入 RECOVERING。
- 浏览器只轮询数据库；1800s Worker 计时器在模型结束后撤销，无法清理数据库残留。
- Java应用Run已经按7200s寿命结束；AI Task与Run是两种独立生命周期。

## 2. 方案选择

| 方案 | 效果与限制 | 决策 |
| --- | --- | --- |
| 仅增加进度重试和退避 | 能缓解80ms级竞争；Worker重启、终态前缺号、后端收尾中断仍可能卡住 | 不足以作为完整修复 |
| 独立终态收据 + 数据库确认 + 有界后台收尾 | 不依赖展示进度连续性；后端重启后能继续；复用现有工具/Run核对规则 | 本轮采用 |
| MQ、通用工作流引擎、持久Worker会话平台 | 复杂度远超当前单Worker/单实例MVP | 不引入 |

核心区分：Worker得到“终态收据已保存”的ACK，只证明后台能够继续收尾；只有副作用核对通过、后端提交最终状态，才释放项目占用。

## 3. 范围与固定约束

- 现有 Spring Boot 单体、MySQL、Pi Worker 架构；Pi固定1.2.0，Worker Node >=22.19.0、Java17、pnpm；不升级框架或引入消息系统。
- 保持AI执行预算1800s、180次工具调用、20次构建；Web服务从首次就绪起7200s。新增收尾退避参数属于本修复的工程选择，不是已有产品事实。
- AI任务现有状态集合不变：QUEUED/RUNNING/NEEDS_ATTENTION占用，COMPLETED/FAILED释放。使用既有NEEDS_ATTENTION表示收尾中或需要核对。
- 正常成功完成保留该任务已就绪的应用Run；用户结束任务、预算超时或失败沿已有close语义清理该任务关联的副作用。不得停止其他任务或未被本任务触碰的Run。
- 不凭聊天文本、Worker一句COMPLETED、一个404或时间到期直接解锁。
- 本轮计划实施到本地验证、发布准备；集群发布、付费模型调用、处理原故障项目由后续明确授权。
- 不绕过此前自动审批拒绝的临时文件删除，不把旧临时目录当成执行前提。

## 4. 后端持久收据

在下一未占用迁移版本（当前为V15）给 `agent_task` 增加：

| 字段 | 类型/含义 |
| --- | --- |
| terminal_report_id | VARCHAR(64) NULL；同一执行唯一稳定标识 |
| terminal_report_json | JSON NULL；规范化的state/summary/failureCode及协议版本 |
| terminal_report_sha256 | CHAR(64) NULL；后端计算的规范内容摘要 |
| terminal_received_at | TIMESTAMP(6) NULL；后端接收时间 |
| deadline_at | TIMESTAMP(6) NULL；新任务创建时固定created_at+1800s |
| close_reason_code | VARCHAR(64) NULL；持久关闭原因，防止重启后丢失/被晚到结果覆盖 |
| next_reconcile_at | TIMESTAMP(6) NULL；下次自动核对时间 |
| reconcile_attempt | V16新增INT NOT NULL DEFAULT 0；独立持久退避计数，不以progress的updated_at推算 |

只迁移结构，不在Flyway里自动改变历史RUNNING状态。新任务写deadline_at；老任务保持NULL，默认不参加自动预算关闭，需由operator明确选定接管。新终态回调可接收旧任务的结果并建立收据。添加覆盖扫描所需索引，避免扫描所有历史任务。

新内部接口：`POST /internal/ai/tasks/{taskId}/terminal`，复用现有Worker token + instance + epoch鉴权。

```ts
type TerminalReport = {
  protocolVersion: 1;
  reportId: string;
  state: 'COMPLETED' | 'FAILED';
  summary: string;
  failureCode: string | null;
};
type TerminalAck = {
  reportId: string;
  reportSha256: string;
  disposition: 'RECORDED' | 'SETTLED' | 'CLOSING';
};
```

契约：

1. `recordTerminal(taskId, instanceId, epoch, report)` 无项目内存gate、无Kubernetes/Worker IO。短事务按统一顺序锁project行再task行，重新核验归属与执行身份；与claim注册/创建预约共享既有任务监视器保护。不得让“检查权限→后来执行创建”越过终态冻结。
2. 首次合法接收原子写收据，并把任务转 `NEEDS_ATTENTION / AI_TERMINAL_PENDING`，从而禁止新工具注册和新副作用创建；已有执行中的claim只能结算其原始结果。最终Context必须先保存，再提交终态。
3. 同reportId同规范内容重复请求始终可ACK，包括任务已结束之后；不同内容、不同执行身份返回409具体错误，不当成成功。比较内容时排除服务器时间；摘要规则跨语言测试覆盖Unicode和字段顺序。
4. 完整终态JSON限制8KiB，包含转义开销；复用fitSummary并保留足够空间。无凭证、原始模型请求或堆栈进入summary之外的诊断字段。
5. 已先进入CLOSING的任务：合法晚到报告返回CLOSING，不能使任务恢复COMPLETED或覆盖close_reason_code。已有相同收据的重放仍幂等。
6. deadline_at已到、且尚无收据/close意图时，接收过程使用后端时间原子记录预算关闭意图，返回CLOSING；不信任Worker提供的完成时间来追溯豁免。已在deadline前持久收到的成功报告可在deadline后完成核对。
7. 返回200表示上述持久决定已提交。不要继续使用“appendProgress成功”来代表终态收尾已完成。

旧协议兼容：现有 `/progress` 的 `kind=terminal` 在进入项目gate/seq检查之前转入同一 `recordTerminal` 入口，给旧执行生成稳定legacy reportId。它不受前面消息缺号影响；普通progress仍保持连续seq与摘要冲突检查，不伪造补齐消息。已存于progress中的老terminal在后台核对时按原身份提取为收据。

### 协议补充：身份、确认和关闭竞争

reportId固定为小写SHA-256(UTF-8(JSON数组[1,taskId,epoch,requestSha256,"terminal"]))；内容摘要固定为SHA-256(UTF-8(JSON数组[1,reportId,state,summary,failureCode]))。采用紧凑JSON、保留Unicode字符、不转义斜杠、null保留；以中文/emoji/引号/换行共享测试向量验证Java/TS一致。legacy报告也采用该算法，避免协议切换产生第二身份。

已关闭为FAILED且有close_reason_code的Task，合法晚到报告也返回CLOSING并保存拒绝逆转的报告身份/摘要，不覆盖此前不同报告；已有收据后来被owner close覆盖时，ACK disposition按当前关闭决定返回。

内部增加GET /internal/ai/tasks/{taskId}/terminal，复用执行鉴权，返回已存TerminalAck或明确NOT_FOUND。后端GET拉取补偿可能已保存报告，而Worker推送仍失败；Worker通过该接口按最长30s间隔确认同reportId/hash，确认收据或CLOSING后解除本机slot。不能因401/403/传输错误视为ACK。该接口只读取，不启动副作用。

## 5. Worker执行结果与投递状态

新增小型 `terminal-delivery.ts` 管理每个Task唯一报告和投递，不另造通用队列：

```ts
type DeliveryState = 'PENDING' | 'ACKED' | 'CLOSING' | 'REJECTED';
interface TerminalDelivery {
  publish(report: TerminalReport): void; // 同一Task只接受同一个报告
  snapshot(): { report: TerminalReport | null; state: DeliveryState };
  dispose(): void;
}
```

- `DefaultPiTaskSession.run()`产出冻结的执行结果；server在模型/工具循环真正退出后保存outcome并开始投递。投递失败不能进入“创建另一个FAILED结果”的catch路径。
- 最后Context保存仍是完成前置条件。最后展示progress失败不能阻塞terminal发布；两者分别交付，终态不依赖progress seq。
- 瞬时错误（transport、408、429、5xx、PROJECT_BUSY）按250ms→500ms→1s→2s→4s→5s上限退避，20%抖动；单请求最多10s，只有一个在途请求。保留同reportId和相同字节，允许下次tick重试。
- 401/403、身份/epoch/report冲突和422永久错误停止自动重试并记录安全诊断，保持未确认状态，由后端关闭/人工核对；不得回报已交付。不能把任意409统一视为成功。
- 为保持单执行slot且限制内存积压，PENDING/REJECTED尚未有后端决定时不接收新任务；stop/GET仍可处理。ACKED/CLOSING且执行循环已停止后可释放slot。已ACK状态记录按明确保留上限清理。
- 不新增Worker PVC/磁盘outbox。本修复保证后台已接收收据后可跨重启继续；Worker在ACK前丢失且无法恢复收据时，只能安全失败关闭，不能保证保留COMPLETED。这一降级必须明示。
- Worker `/tasks/{id}` 的内部状态增加 `protocolVersion/taskId/instanceId/workerEpoch/requestSha256/executionState/terminalDelivery`；保留旧state字段兼容。只有执行循环退出才能报告COMPLETED/FAILED，abort已请求仅STOPPING。后端必须核对所有已存在的身份字段；缺字段的旧Worker响应不作为新协议终态证据。
- 提供已认证的GET `/status` 返回当前进程bootId和activeTaskId/执行状态，供诊断识别重启和slot；不暴露模型key或prompt。404由HTTP client保留为NOT_FOUND，不能统一改成502，也不能单凭404解锁。
- Task 5 协议补齐：已认证GET `/tasks/{id}` 的 `terminalDelivery.report` 返回冻结的完整TerminalReport，供后端拉取收据；`/status`不返回报告正文。

已确认的Worker记录最多保留100条/24小时，任一阈值到达可淘汰；PENDING/REJECTED不淘汰。淘汰导致的NOT_FOUND不会删除后端持久收据。stop发生在异步createPiSession期间时，TaskRecord保存取消意图；初始化完成后先检查取消，不能再prompt。对账比创建ACK更早发现记录时，绑定原taskId/epoch/requestSha，不按project匹配另一个执行。

## 6. 后端统一收尾与期限

新增 `AgentTaskSettlementService.reconcile(taskId)`，所有已接收报告、用户close、预算关闭均由它驱动到既有业务校验；浏览器GET保持读取语义。

收尾规则：

| 条件 | 行为 |
| --- | --- |
| 收据COMPLETED、无live claim、无未决工具/文件receipt，applicationCanRelease(true) | CAS完成；保留成功就绪Run |
| 收据COMPLETED但副作用未决 | 保持NEEDS_ATTENTION/AI_TERMINAL_PENDING，继续读取原receipt/原Job事实，绝不重跑工具 |
| 收据FAILED、用户close或期限关闭 | 先持久CLOSING及原因，阻止新增副作用；外部停止/原receipt/Job与Run清理；最后短锁复核后FAILED释放 |
| 没有收据，Worker返回合法同执行终态报告 | 走同一recordTerminal，再reconcile |
| 无收据且Worker仍RUNNING、deadline未到 | 等待，不能凭无进度判断模型失活 |
| 无收据且deadline到期 | CAS关闭意图AI_TASK_BUDGET_EXCEEDED，不再无限RUNNING；核对完成前保持占用 |
| Worker404/不可达且deadline未到 | 保存安全诊断与下次检查时间，不自动认定完成/安全停止 |
| 旧任务deadline=NULL | 不自动预算关闭；owner close和明确operator接管可进入同一收尾流程 |

已有CLOSING原因优先，重复close不能覆盖；同一Task完成与close竞争由数据库CAS决定。成功报告已接收但用户随后主动结束，可切换CLOSING清理；晚到成功不能逆转。释放之前同时检查task身份/版本、任务冻结状态、live claims、持久未决calls/receipts、所有原始关联Run。

定时器采用独立单线程有界调度，不占用Run巡检scheduler：每5s选取至多10个到期候选（next_reconcile_at,id稳定排序并避免一个卡住任务饿死后项），不重入；每个任务只发起有界观察/停止请求，单次IO最多2s，单任务工作预算5s，到期留待下轮。将现有close中的120s等待改为可重入单步，既有工具claim仍在时先退出；不在数据库事务、project gate或tasks monitor内等待网络。该参数只是本轮工程默认，测试注入Clock/调度器，无实际1800s等待。

长期UNKNOWN可能仍保持NEEDS_ATTENTION；这是明确的未决状态，UI应支持重试结束并说明原因。不会为了“所有情况都释放”而绕过副作用核对。

## 7. Run恢复语义

将启动/authority takeover的“把未完成Run转RECOVERING”与周期性“核对已RECOVERING项”分离：初始化/新fencing token时执行一次mark，常规15s只检查RECOVERING项；正常RUNNING由3s observation跟踪。保留STOPPING、原有USER_STOPPED意图和fencing CAS。通过正常完成、Job暂缺/未知、backend启动及跨实例token变化测试证明不丢恢复覆盖。

本轮不整体重写Run调度和Kubernetes适配器。终态收据入口脱离project gate使其不再受长IO锁阻断；后续如果要把普通Run observation的所有IO搬到锁外，应另做身份/版本重读设计，不以删除现有锁代替。

首次恢复标记因gate忙跳过的Run必须留在待初始化集合，下轮重查；不能只因循环结束就宣布初始化完成。初始化后新建Run由普通observation处理，不重复mark。

## 8. UI与用户控制

- 保留AI占用期间禁止直接Stop run，以免人工控制与Agent工具冲突；按钮提示改为“AI任务正在控制应用，请先结束AI任务”。提供到AI面板的明确入口。
- “结束AI任务”面向当前占用Task，跨历史会话选择仍能看到；运行、收尾中、NEEDS_ATTENTION均可提交同一幂等close。仅当前close HTTP在途时暂时禁用；错误后恢复并显示安全错误，不永远loading。
- close先保存意图后快速返回当前snapshot；轮询展示“正在收尾/等待确认”，直到后台真的释放；再按现有Run authority恢复人工操作。
- SERVICE展示“启动上限1800s；就绪后7200s；实际expiresAt”，TASK展示其执行timeout；AI预算另行标注，避免再混用timeout 1800s。
- 不增加新状态枚举、不改整套聊天UI、不把本轮范围扩展为暂停/恢复Agent。

## 9. 发布与历史故障项目

发布顺序：备份与可恢复性验证→加法迁移→兼容后端→新Worker→前端。新后端需兼容旧progress terminal；新Worker不向旧后端启用terminal接口。旧后端回滚到不认识收据的版本会失去后台收尾，不能在有pending receipt/close时直接回滚；维护窗口内先核对清空新任务，再停发新任务、按已测步骤回滚。迁移不DROP字段。

原故障Task `b3b32518-f0ed-411e-aa85-1ecef95fbdc5` 先dry-run输出任务/工具/receipt/Run/资源身份与建议。因为Worker已重启且旧终态没有可靠收据，不能从对话最终回答推断COMPLETED。用户授权后使用owner-scoped现有close接口，完成核对后以明确关闭原因结束；禁止直接SQL改状态和重新执行原模型任务。

## 10. 完成标准

短暂锁竞争、丢ACK、前序progress缺号、后端收据后重启、Worker收据前重启、期限到期、close与terminal竞争均有确定性测试；原始一Task场景使用独立MySQL和本地HTTP完整重放，不需付费模型。成功路径Run保留；失败/结束仅清理本Task关联资源；未知状态不误放写权限。证据区分本地PASS、云端NOT_RUN和原问题仍未处理。
