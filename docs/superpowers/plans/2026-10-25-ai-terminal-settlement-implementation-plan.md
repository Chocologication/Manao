# AI 任务可靠收尾修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (when delegation is authorized) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. 默认使用 executing-plans；本文件本身不授权额外子Agent。

**Goal:** 消除Worker已完成但后端无限RUNNING的故障，使锁竞争、回调丢失、重启和期限到期均能安全收尾。

**Architecture:** 在现有MySQL任务行持久保存独立终态收据；Worker以同一报告身份投递，后端ACK后用有界后台收尾核对副作用。Run恢复区分启动/接管初始化和周期核对。成功保留就绪Run，失败或主动结束沿原close机制核对后释放。

**Tech Stack:** Java17、Spring Boot3.5.9、MySQL8、Flyway；TypeScript、Pi1.2.0、Node >=22.19.0、pnpm；现有React、Vitest、JUnit、真实MySQL测试工具。

**Spec:** [修复设计](../specs/2026-10-25-ai-terminal-settlement-design.md)；[调查报告](../../../poc4/docs/evidence/ai-output/terminal-settlement-20261025.md)；[交接提示词](2026-10-25-ai-terminal-settlement-agent-handoff.md)。

**2026-10-26 执行状态：** Task1–8逐项审查、整分支审查及lost-start限定修复复审完成，LOCAL_REPAIR_VERIFIED；生产代码终点5739d1b。实际browser8/8及晚到ACK补强1/1、Worker181、前端211、backend原962项失败与fixture60/60复验、最终修复65/65及清理拒绝残留归[验收记录](../../../poc4/docs/evidence/ai-terminal-settlement/acceptance.md)；[最终审查](../../../poc4/docs/evidence/ai-terminal-settlement/review.md)记录裁定及非阻塞项；发布与原Task dry-run归[手册](../../../poc4/deploy/ai-terminal-settlement/README.md)。不声称单次完整全绿。随后用户授权并完成758aae6集群发布及一次最小真实模型验证：DEPLOYED_SMOKE_VERIFIED，见验收第8节；完整云端故障矩阵NOT_RUN、原Task NOT_REPAIRED、Stage2 PAUSED/NOT_GRANTED，未Git push/merge。

## Global Constraints

- 原设计的PLANNED是2026-10-25快照；当前任务状态见执行记录。本地实现不等于部署、云端验收或原故障Task已修复。
- AI执行预算1800s、180次工具调用、20次构建；Web服务就绪起7200s。投递重试和重启不能延长deadline。
- Pi固定1.2.0、Node >=22.19.0、Java17、pnpm；不使用npm，不升级框架，不引入MQ/Worker PVC/通用工作流。
- 单实例后端、单Worker执行slot；不扩大为HA，不宣称多实例fencing。身份校验instance/epoch/requestSha必须保留。
- Worker结果不是解锁信号，收据ACK也不是副作用完成。释放前核对live claims、持久calls、workspace receipts、关联Run。
- 成功保留本Task已就绪应用；主动结束/失败/预算关闭只处理该Task关联资源，不删除平台或其他项目资源。
- 数据库测试只用JdbcStoreTestSupport建立临时MySQL schema；禁止重置manao_poc4/manao_poc4_6b，不用H2替代真实MySQL门禁。
- 中文说明、英文代码标识、UTF-8无BOM、遵守.gitattributes；编辑前读最新文件，补丁失败先重读。
- 本轮交接范围：本地实现、测试、发布准备。集群写操作、付费模型、原故障项目恢复、push/merge需后续明确授权。
- 旧清理拒绝不绕过；执行不依赖用户Temp中的原始binlog或编译输出。

## 0. 工作区与执行方式

文档所在地：D:/DeepLearning/MyProjects/Project_Manao/.worktree/ai-integration，基线codex/ai-integration@8d4c573。master@4c9fb89没有AI实现，禁止从master起步。

实施建议：D:/DeepLearning/MyProjects/Project_Manao/.worktree/ai-terminal-settlement，分支codex/fix-ai-terminal-settlement。先读using-git-worktrees技能；已有目录/分支先核对，不能强制覆盖。

~~~powershell
$repo = 'D:/DeepLearning/MyProjects/Project_Manao'
git -C $repo worktree list
git -C "$repo/.worktree/ai-integration" status --short
git -C "$repo/.worktree/ai-integration" rev-parse HEAD
# 仅在目标不存在、基线仍符合时执行：
git -C $repo worktree add .worktree/ai-terminal-settlement -b codex/fix-ai-terminal-settlement 8d4c573
~~~

当前调查/计划未提交，不会随新worktree出现：将本设计、计划、handoff及四个terminal-settlement证据附件按相对路径复制；新worktree只补相关AGENTS索引，不能全覆盖。第一条文档提交记录来源SHA、复制清单。保留用户.zcode修改和讨论文本。

每Task执行RED→最小实现→GREEN→diff检查→任务级提交。RED必须是行为不满足，不能把数据库不可达或编译错误当作故障重现。普通实现细节自主解决；变更成功Run保留规则、扩大清理范围或增加基础设施需先报告设计偏离。

## 1. 文件分工与固定接口

后端目录简称B = poc4/backend/src/main/java/com/manao/poc4；测试目录BT = poc4/backend/src/test/java/com/manao/poc4。下文B/、BT/都是路径展开，不是待实现目录。

| 文件 | 职责 |
| --- | --- |
| poc4/backend/src/main/resources/db/migration/V15__agent_terminal_receipts.sql | 加法收据/期限/关闭原因/调度字段；先确认版本未占用 |
| B/ai/AgentContracts.java | TerminalReport、TerminalAck、内部Worker状态 |
| B/ai/AgentTaskStore.java | 收据幂等事务、候选查询、最终CAS；无外部IO |
| B/ai/AgentTaskService.java、AgentInternalController.java | 终态接收、旧协议兼容、close意图 |
| B/ai/AgentTaskSettlementService.java（新增） | 一个Task的一步副作用核对与收尾 |
| B/ai/AgentTaskReconciler.java（新增） | 有界独立调度、公平扫描、关停 |
| B/ai/HttpPiWorkerClient.java、PiWorkerClient.java | 状态与完整身份读取，区分404和未知 |
| poc4/pi-worker/src/terminal-delivery.ts（新增） | 唯一报告、ACK校验、退避、dispose |
| poc4/pi-worker/src/backend-client.ts、pi-session.ts、server.ts | HTTP契约、执行/交付拆分、slot及状态 |
| B/config/AiConfig.java | 条件装配与独立调度器生命周期 |
| B/config/RuntimeMaintenanceLoop.java、B/run/RunRecoveryService.java | 启动恢复和周期核对分离 |
| 前端AgentTaskPanel/agentTaskQueries/RunPanel/RunToolbar | 当前Task结束入口、收尾反馈与时限文案 |

新接口约定（以下接口已按本计划实现，当前证据见验收记录）：

~~~java
// AgentContracts中的嵌套record
record TerminalReport(int protocolVersion, String reportId, String state,
                      String summary, String failureCode) {}
record TerminalAck(String reportId, String reportSha256, String disposition) {}
// AgentTaskService
TerminalAck recordTerminal(String taskId, String instanceId, long epoch, TerminalReport report);
// AgentTaskSettlementService
void reconcile(String taskId);
// AgentTaskReconciler
void tick();
~~~

Store包级方法由Task2实现，后续只调用真实实现，不复制状态机。新建文件必须承担独立职责，不为一行转发再加抽象。

## Task 1：故障回归与受控并发夹具

**Files**
- Create: BT/ai/AgentTerminalSettlementTest.java
- Create: poc4/pi-worker/test/terminal-delivery.test.ts
- Read: poc4/docs/evidence/ai-output/terminal-settlement-diagnostic.java.txt、terminal-settlement-probe.mjs.txt
- Modify test only: BT/ai/AgentTaskServiceTest.java

**Consumes:** 当前TaskStore、ProjectLifecycleGate、RunRecoveryService、ProgressChain。
**Produces:** 可显式暂停/释放Kubernetes观察的真实MySQL夹具与命名RED案例。

- [x] 将已有诊断转换为真实DB夹具：只mock外部JobCoordinator，不能mockTaskStore/gate；Latch有超时及finally释放。
- [x] 添加terminalReportIsDurableWhileRunRecoveryHoldsTheProjectGate、terminalDeliveryFailureNeverClaimsAcknowledgement、missingDisplayProgressDoesNotBlockTerminalReceipt。
- [x] 两个线程制造竞争，禁止同线程重入。先记录36条，观察线程持锁，回传线程送最后消息/终态。
- [x] 在现有实现运行，记录lastSeq36、占用未释放、投递错误被吞的RED；Task2后用新收据入口使其GREEN。
- [x] 提交测试与失败证据，不能删断言只求绿。

验收算法：
~~~text
given RUNNING task with progress 1..36
and recovery thread paused in coordinator.observe holding project gate
when another thread submits an authenticated terminal report
then ACK reflects a persisted receipt without waiting for that gate
and new tool admission is blocked
and writes remain locked until original effects are verified
when recovery resumes and checks pass
then one terminal decision releases occupancy
~~~

## Task 2：持久终态收据与幂等ACK

**Files:** 新建V15__agent_terminal_receipts.sql；修改B/ai/AgentContracts.java、AgentTaskStore.java、AgentTaskService.java、AgentInternalController.java；测试BT/ai/AgentTerminalSettlementTest.java、AgentTaskStoreTest.java、AgentInternalSecurityTest.java。

**Consumes:** Task1夹具与当前owner/instance/epoch校验。
**Produces:** recordTerminal/TerminalAck、加法迁移、新任务deadline。

- [x] 先测同report同内容并发、丢ACK重发、终态后重发、同ID不同内容、错身份、Unicode、8KiB完整JSON上限。
- [x] 按设计添加terminal_report_id/json/sha256/received_at、deadline_at、close_reason_code、next_reconcile_at；旧deadline=NULL，新任务同一Clock赋created_at+1800s。
- [x] 无project gate的短事务保存报告并冻结新工具/新创建；统一project row→task row锁顺序，沿用任务监视器保护并测死锁/并发。reportId/摘要按设计固定数组计算，添加Java/TS共享Unicode测试向量。
- [x] 最后副作用创建授权点（build create、application预约、write操作）检查receipt/close冻结；覆盖已读到许可但尚未创建资源的竞态。
- [x] 旧progress terminal在gate/seq前转入recordTerminal，legacy reportId稳定；普通message仍按seq检查，缺号不伪造。
- [x] 到deadline的新报告遵守关闭优先；已close或关闭后FAILED的合法晚到结果ACK CLOSING，不覆盖原因；已结束同报告仍幂等ACK。增加terminal GET查询已存ACK，继续校验执行身份。
- [x] 运行迁移/安全/收据测试，GREEN后提交fix(ai): persist terminal receipts before settlement。

事务顺序：
~~~text
lock project row -> lock task row -> recheck execution identity
same receipt: ACK same receipt
conflict: reject explicitly
close intent already stored: ACK CLOSING
deadline reached without earlier receipt: persist budget close, ACK CLOSING
else store report + NEEDS_ATTENTION/AI_TERMINAL_PENDING atomically
commit before ACK; zero Kubernetes/Worker IO here
~~~

## Task 3：统一副作用收尾与快速close

**Files:** 新建B/ai/AgentTaskSettlementService.java；修改B/ai/AgentTaskService.java、AgentTaskStore.java、AgentTaskController.java、AgentProjectTools.java、AgentApplicationTools.java；测试BT/ai/AgentTerminalSettlementTest.java、AgentTaskServiceTest.java、AgentApplicationToolsTest.java、AgentProjectToolsTest.java。

**Consumes:** 收据、冻结状态、原工具/receipt/Run清理规则。
**Produces:** reconcile(taskId)与持久close意图快速响应。

- [x] RED覆盖保存报告后进程中断、重建服务继续收尾、重复reconcile不重复副作用。
- [x] 新增只匹配receipt身份/摘要且无close意图的完成CAS；旧applyTerminal仅允许QUEUED/RUNNING，不能原样用于NEEDS_ATTENTION。
- [x] 成功路径核对live claims、持久未决calls、PENDING receipts、applicationCanRelease(true)，保留READY应用。
- [x] 失败/结束先持久close_reason_code和冻结，再锁外单步清理；将120s等待改成未决即返回、下轮续核对。不得重放结果未知的工具。
- [x] close Controller快速返回当前snapshot；NEEDS_ATTENTION表示已受理但未确认结束。重复close不改原因、最终任务no-op。
- [x] 测试REGISTERED/RUNNING/NEEDS_ATTENTION call、PENDING receipt、live claim竞态、不同owner、Run身份更换、Stop未知、close胜过晚到结果。
- [x] 运行对应测试，提交fix(ai): reconcile receipts through verified task settlement。

~~~text
COMPLETED report + verified effects -> COMPLETED; READY application survives
COMPLETED report + unresolved effect -> NEEDS_ATTENTION; retain occupancy
close intent + verified cessation -> FAILED; release occupancy
close intent + unknown receipt/job/claim -> NEEDS_ATTENTION; retry later
~~~

## Task 4：Worker独立投递、状态与身份

**Files:** 新建poc4/pi-worker/src/terminal-delivery.ts；修改backend-client.ts、pi-session.ts、server.ts、config.ts；测试terminal-delivery.test.ts、server.test.ts、pi-session.test.ts、pi-session-context.test.ts、live-output.test.ts。

**Consumes:** Task2 terminal契约和Task3 CLOSING语义。
**Produces:** TerminalDelivery、完整状态查询、boot身份、冻结报告重复发送。

- [x] 用可控fetch和fake timers写RED：PROJECT_BUSY/transport/5xx、丢ACK、永久身份冲突；每次reportId及JSON字节相同、最多一个在途。
- [x] 普通progress保留具体code，有界退避同seq；GAP范围有限；MISMATCH不能谎报同一内容已送达。
- [x] 最终Context先持久化，再冻结outcome；progress drain失败不挡terminal。Context失败明确FAILED/AI_CONTEXT_UNAVAILABLE。
- [x] 按250/500/1000/2000/4000/5000ms上限+20%jitter投递，单请求<=10s；只有匹配reportId/hash的ACK才确认，dispose清timer/订阅。
- [x] server区分执行异常与交付异常；发送失败不生成第二个FAILED覆盖COMPLETED。PENDING/REJECTED不接新模型任务，但GET/stop可用。
- [x] 新进程boot身份不能是固定instance字符串；任务/compaction鉴权一致使用该身份。任务GET返回epoch/requestSha/executionState/报告；GET /status返回bootId和activeTaskId，不带prompt/密钥。
- [x] abort请求仅STOPPING；循环真正退出才执行终态。stop发生在createPiSession未完成时记录取消，初始化后不再prompt。ACK前重启允许结果丢失，后端安全失败关闭兜底，不承诺恢复COMPLETED、不新增磁盘outbox。
- [x] 推送永久拒绝后可用terminal GET确认后端拉取补偿已接收/关闭；匹配身份才释放slot。已确认记录最多100条/24h，PENDING/REJECTED不淘汰。
- [x] worker全部测试+build，提交fix(worker): separate terminal delivery from model execution。

测试用例步骤必须实际实现以下序列，不使用固定sleep碰运气：
~~~text
publish report R
fetch #1 -> 409 PROJECT_BUSY
advance fake clock 250ms plus injected deterministic jitter
fetch #2 -> server records R but response is lost
advance next retry
fetch #3 -> ACK with R.id and canonical hash
assert pending,pending,acked; same body; one inflight; execution outcome unchanged
~~~

## Task 5：后台对账、期限与重启

**Files:** 新建B/ai/AgentTaskReconciler.java；修改B/ai/AgentTaskSettlementService.java、AgentTaskStore.java、HttpPiWorkerClient.java、PiWorkerClient.java、AgentContracts.java及B/config/AiConfig.java；新增BT/ai/AgentTaskReconcilerTest.java、HttpPiWorkerClientTest.java。

**Consumes:** Task2–4的收据、单步收尾及Worker状态协议。
**Produces:** 无浏览器依赖的有界对账、服务器期限及持久调度。

- [x] RED矩阵：DB RUNNING/Worker有报告；收据后backend重启；Worker404；不可达；deadline前/等于/之后；历史deadline=NULL；坏Task不饿死后项。
- [x] 将404、鉴权失败、错误JSON、身份不匹配、transport分开；所有网络在锁外，回来重新读Task并CAS，不能用旧snapshot覆盖新close。
- [x] 有报告走recordTerminal；deadline到期且无已接收报告时持久预算close。不能根据无进度认定模型死掉，不能每次更新deadline。
- [x] 独立单线程每5s选至多10个到期候选、无重入；按next_reconcile_at/id公平排序。单IO<=2s、单任务工作预算5s；未决退避5s至30s。
- [x] 新Task/receipt/close初始化next时间；backend重启从DB恢复。旧progress已存terminal可导入receipt，历史无deadline不得自动停止。
- [x] 诊断只保留taskId/reportId/epoch/seq/kind/status/code/attempt/elapsed/nextRetryAt，不记录响应原文、token、模型内容。
- [x] 不可达仍NEEDS_ATTENTION且占用是有效安全状态；有结束/重试入口，禁止为全自动解锁而跳过证据。
- [x] GREEN后提交fix(ai): reconcile pending task outcomes and enforce deadlines。

## Task 6：Run恢复的周期语义

**Files:** 修改B/run/RunRecoveryService.java、B/config/RuntimeMaintenanceLoop.java；测试BT/run/RunRecoveryServiceTest.java、RunObservationServiceTest.java、JdbcRunStoreTest.java；新增或扩展BT/config/RuntimeMaintenanceLoopTest.java。

**Consumes:** 现有RunStore、fencing token、observation。
**Produces:** 正常RUNNING不再每15s进入RECOVERING，启动/接管完整恢复。

- [x] RED：同token连续两轮不会再次mark健康RUNNING；首次启动/新token会mark；无token不做恢复写入。
- [x] 分离一次性初始化与周期RECOVERING核对；初始化完整完成后才标记，中断重试。gate忙跳过的原Run留待下轮，初始化后新Run不重复mark。不靠单一内存boolean判断跨实例权威。
- [x] 保留STOPPING/USER_STOPPED意图、UNKNOWN/MISSING/Pod身份核对、token CAS。3s普通observation继续追踪健康Run。
- [x] 不整体搬动普通observation的锁外IO；关键保护来自独立terminal入口。Task1仍可主动制造锁竞争，不能靠不执行巡检让测试变绿。
- [x] GREEN后提交fix(run): separate startup recovery from periodic reconciliation。

## Task 7：结束入口与超时展示

**Files:** 修改poc4/frontend/src/features/ai/AgentTaskPanel.tsx、AgentConversationPanel.tsx、agentTaskQueries.ts；修改src/components/shell/WorkbenchShell.tsx、src/components/runs/RunPanel.tsx、RunToolbar.tsx；扩展其现有test.tsx，新增RunToolbar.test.tsx若缺失。

**Consumes:** TaskSnapshot现有状态、close快速响应及安全failureCode。
**Produces:** 当前Task始终可结束/重试、收尾可见、两类时限不混淆。

- [x] RED：选中历史会话仍能结束当前占用Task；NEEDS_ATTENTION可重试；HTTP失败后按钮恢复；未释放时编辑与Start仍禁用。
- [x] close针对当前taskId，不用displayTaskId；文案“结束AI任务可能停止其启动的应用”。本轮不加暂停/恢复。
- [x] Stop run因AI占用禁用时给出说明及切换AI入口；成功释放且Run仍活跃时恢复Stop，Run已超时时保持合理禁用。
- [x] SERVICE显示启动上限1800s、就绪后7200s及expiresAt；TASK显示自己的timeout；AI预算另行说明，不能全局把1800替换7200。
- [x] 目标组件测试、typecheck、build、boundary通过后提交fix(ui): clarify task settlement and application stop controls。

## Task 8：完整验证、发布准备与存量恢复手册

执行结果：本地8场景全部通过、相关fixture60/60复验通过；完整backend原次962中4F7E已逐项定位并修复测试夹具，未声称单次full全绿。独立审查待完成；实际证据和清理拒绝见验收记录。

**Files:** 新建poc4/docs/evidence/ai-terminal-settlement/acceptance.md、poc4/deploy/ai-terminal-settlement/README.md、poc4/frontend/tests/e2e/ai-terminal-settlement.spec.ts、poc4/frontend/playwright.ai-terminal-settlement.config.ts；修改frontend/package.json增加专用test:e2e脚本、AGENTS.md及本计划状态。

**Consumes:** Task1–7。
**Produces:** 一组可复核本地证据、兼容发布/回滚说明、原Task处理程序。

- [x] 本地真实MySQL、后端HTTP、Worker scripted provider重放：持锁、37号缺失、丢ACK、backend重启、Worker重启、close竞争、deadline。测试故障注入仅测试夹具可用，生产不能用公网参数触发。
- [x] 浏览器链：AI执行→收尾→完成→写入/新任务恢复，READY Run保留；结束链：End task→收尾等待→确认停止→解锁；刷新/重登仍依据DB。
- [x] 明确断言报告一次落库、结果不逆转、无第二次模型/工具副作用、owner隔离、无敏感日志。
- [x] 执行验证命令并记录计数/退出码；原full失败与最终targeted复验分别记录，不冒充单次full全绿。
- [x] 准备加法迁移→兼容后端→新Worker→前端，实际发布未授权。pending收据/close未清空时，不能回退不认识收据的旧后端；回滚不DROP字段。
- [x] 原故障Task仅编写dry-run程序，未访问原Task；后续授权用owner close关闭，不直接SQL改状态，不重跑原模型任务。
- [x] 文档标云端NOT_RUN/原Task NOT_REPAIRED，保留Stage2 PAUSED/NOT_GRANTED；新owned服务/schema已清理，旧11目录+隔离classes删除被策略拒绝，已记准确保留清单，不绕过。
- [x] 竞态矩阵、兼容、release与report已准备；提交test(ai): verify terminal settlement recovery and release boundaries；独立审查待controller执行。

## 2. 验证命令

在实施worktree运行，mvn不在PATH则使用已有IDE的mvn.cmd。私有测试环境只选本机独立schema，不把集群变量载入测试shell，不打印密码。

~~~powershell
pnpm --dir poc4/pi-worker install --frozen-lockfile
pnpm --dir poc4/pi-worker test
pnpm --dir poc4/pi-worker build
pnpm --dir poc4/frontend install --frozen-lockfile
pnpm --dir poc4/frontend test -- src/features/ai/AgentTaskPanel.test.tsx src/features/ai/AgentConversationPanel.test.tsx src/components/shell/WorkbenchShell.test.tsx src/components/runs/RunPanel.test.tsx src/components/runs/RunToolbar.test.tsx
pnpm --dir poc4/frontend typecheck
pnpm --dir poc4/frontend build
pnpm --dir poc4/frontend test:boundary
mvn -f poc4/backend/pom.xml '-Dtest=AgentTerminalSettlementTest,AgentTaskReconcilerTest,HttpPiWorkerClientTest,AgentTaskStoreTest,AgentTaskServiceTest,AgentInternalSecurityTest,AgentApplicationToolsTest,AgentProjectToolsTest,RunRecoveryServiceTest,RunObservationServiceTest,JdbcRunStoreTest,RunControllerTest,RuntimeMaintenanceLoopTest' test
mvn -f poc4/backend/pom.xml '-Dtest=AgentConversationStoreTest,AgentConversationHttpContractTest,AgentConversationCompactionTest,AgentLiveOutputTest,AgentLiveOutputHttpTest,DevelopmentBuildExecutorTest' test
# Task8创建专用配置与package script后；只使用本地scripted provider：
pnpm --dir poc4/frontend test:e2e:ai-terminal-settlement
git diff --check
~~~

数据库权限/迁移阻塞必须记BLOCKED，不改用mock/H2谎称通过。相关检查全通过后，不无理由扩大或重复测试；新增改动/失败才补测。

## 3. 验收矩阵

| Case | 可观察结果 |
| --- | --- |
| A 原故障锁竞争 | terminal收据不受project gate阻塞；核对后释放 |
| B 展示progress缺号 | terminal独立落库，不伪造缺失消息 |
| C ACK丢失 | 同report重投，业务决定一次，无重复副作用 |
| D backend重启 | 从DB续收尾，不需浏览器、不重跑模型 |
| E Worker收据前消失 | 不捏造成功，期限/owner close后核对失败关闭 |
| F budget | 到期进入持久关闭；确认停止后FAILED，未知不解锁 |
| G 未决副作用 | calls/receipt/Job确认前不释放 |
| H 成功保持应用 | READY Run不断开，人工Stop恢复 |
| I close竞争 | 已持久close不被晚到COMPLETED覆盖 |
| J 身份/摘要 | 错owner/instance/epoch/report明确拒绝 |
| K 周期恢复 | 正常Run不抖动；启动/接管/STOPPING仍恢复 |
| L 兼容 | 新后端支持旧terminal；迁移不自动停历史应用 |
| M 调度/日志 | 有界IO、无饥饿、Run调度不阻塞、无敏感日志 |
| N UI | 当前任务结束始终可达，错误可重试，时限含义正确 |

## 4. 交付与后续授权

本地完成交付分支/SHA、提交列表、A–N逐项证据、迁移兼容/回滚说明、未验证项、原Task dry-run方案。未部署只能标LOCAL_REPAIR_VERIFIED；云端NOT_RUN；原Task未处理仍NOT_REPAIRED。Stage2既有状态不自动改变。

后续用户授权发布时，再核对当前context/namespace/images/资源/备份，实施发布与独立云端验证。2026-10-25的集群事实不能作为届时状态。
