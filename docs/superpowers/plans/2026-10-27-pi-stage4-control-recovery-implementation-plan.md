# Pi Stage 4 Control and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use superpowers:subagent-driven-development only when the user explicitly chooses delegated implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现暂停接管、用户修改后同会话新执行、服务异常核对后手动继续，以及执行资源的可验证收尾。

**Architecture:** 复用 AgentTask close/receipt/reconciler、conversation 历史和项目 revision/SHA 保护。增加薄 pause 入口、构建协作停止、确定 Worker 重启后的安全收尾和继续操作；不复活旧 Task，不另建任务引擎。

**Tech Stack:** Java 17 / Spring Boot / MySQL / 既有 Fabric8；Node >=22.19.0 / Pi SDK 1.2.0 / TypeScript；React / pnpm / Vitest / Playwright。

**Spec:** [接管与手动继续设计](../specs/2026-10-27-pi-stage4-control-recovery-design.md)。

**Status:** PI_STAGE4_CONTROL_RECOVERY_PASS。日期：2026-10-27。实施和证据以[阶段四验收](../../../poc4/docs/evidence/ai-stage4/acceptance.md)为准；勾选框只跟踪本地步骤；用户后续授权的云端PASS由验收第7节独立记录。

## Global Constraints

- 用户确认同一会话内新建执行：新 taskId、新1800秒/180工具/20构建预算；旧执行终态不可逆，禁止重放旧工具。
- 原故障Task `b3b32518-f0ed-411e-aa85-1ecef95fbdc5` 处理与Stage2验收暂缓；Stage2保持 PAUSED / NOT_GRANTED。第三项仅 KEY_CLOUD_FAULTS_VERIFIED，不冒充完整矩阵。
- 原实施范围为本地实现/定向测试/文档/本地提交；用户后续明确授权集群发布和真实模型验证，结果另记验收第7节。Git push/merge与历史资源处理仍不在范围。
- 沿用六个mediated tools与固定Maven goal/只读副本构建；无自由Shell、语言适配、多Agent产品能力、MCP/Skills平台或MQ。
- 预期零迁移、零新表、零新依赖、零新生产服务；复用close_reason_code和现有任务/收据/对账字段。
- 保持原锁序与创建fence；外部I/O不放在事务、project gate或TaskStore monitor里；未决副作用或存活Pod不能解锁。
- 测试只用disposable schema，不重置manao_poc4或manao_poc4_6b；清理限定owner/project，保留其他会话改动和证据。
- pnpm，UTF-8无BOM，修改前重读；遵守实施checkout的AGENTS及行尾规则。不得git add .、stash/reset/clean整个树。

## 基线与任务顺序

规划基线：`.worktree/ai-integration` / `codex/ai-integration@1d410cd`。该checkout有其他会话未提交的云端证据与文档整理。实施使用 `superpowers:using-git-worktrees`，从执行时核对的最新AI分支建立 `.worktree/pi-stage4-control-recovery` / `codex/pi-stage4-control-recovery`，不能从尚无AI代码的master开始。

```powershell
git -C D:/DeepLearning/MyProjects/Project_Manao/.worktree/ai-integration status --short
git -C D:/DeepLearning/MyProjects/Project_Manao/.worktree/ai-integration rev-parse HEAD
git -C D:/DeepLearning/MyProjects/Project_Manao worktree list
git -C D:/DeepLearning/MyProjects/Project_Manao worktree add .worktree/pi-stage4-control-recovery -b codex/pi-stage4-control-recovery codex/ai-integration
```

目标已存在时核对后复用，不删重建。三份规划文档若尚未提交，逐字复制到新worktree并核对SHA256；只为当前规则/证据读取源checkout的AGENTS、导航和专项记录，不整体复制未提交树。相对路径从实际实施checkout解析。

五项任务按1→2→3→4→5推进；共享后端文件多，不并行写同一区域。每任务具备独立测试闭环，不单列脚手架、文档或全库重构任务。

## Task 1：持久暂停意图与可信停止证据

**Files**
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskController.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskSettlementService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentContracts.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentTaskServiceTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentTaskStoreTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentTerminalSettlementTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentConversationHttpContractTest.java`

**Interfaces**
- Consumes: `close(taskId, failureCode, summary)`、`beginClose`、`settlementView`、`PiWorkerClient.stop/status/processStatus`。
- Produces: `void AgentTaskService.pause(String taskId)`；`POST /api/v1/projects/{projectId}/agent-tasks/{taskId}/pause -> TaskSnapshot`；TaskSnapshot末尾可空 `String closeReasonCode`。
- 复用已有Worker绑定；新增暂停不处理未绑定的启动窗口，返回409 `AI_TASK_STARTING`，不增加补绑协议。

- [x] **1. 写RED与竞争测试。** 在现有真实MySQL Harness中保留默认STOPPING fake：

```java
@Test void pauseDoesNotReleaseWhileWorkerStillStopping() {
    try (var h = new Harness()) {
        h.submit();
        h.service.pause(h.taskId);
        var snapshot = h.tasks.findForOwner(OWNER, PROJECT, h.taskId).orElseThrow();
        assertThat(snapshot.writesLocked()).isTrue();
        assertThat(snapshot.closeReasonCode()).isEqualTo("AI_PAUSED_BY_OWNER");
        assertThat(h.worker.starts).hasSize(1);
    }
}
```

使用当前测试类已有fixture字段，必要时扩展fixture，不增加生产测试入口。还需：STOPPING→合法终态/ACK/slot释放→解锁；超时/401/坏身份锁住；pause→close保持首因；终态先赢不逆转；deadline先赢；外owner/project404；gate409后可重试；启动ACK晚到不复活。

- [x] **2. 运行RED。**

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=AgentTaskServiceTest,AgentTaskStoreTest,AgentTerminalSettlementTest,AgentConversationHttpContractTest' test
```

新增行为缺失应失败；数据库权限/连接错误不算业务RED。

- [x] **3. 最小实现。** pause只存固定 `AI_PAUSED_BY_OWNER` 并安排原reconciler；不等待网络/集群后才返回。入口形状：

```java
@PostMapping("/{taskId}/pause")
public AgentContracts.TaskSnapshot pause(Authentication authentication,
        @PathVariable String projectId, @PathVariable String taskId) {
    requireOwnedTask(authentication.getName(), projectId, taskId);
    tasks.pause(taskId);
    return requireOwnedTask(authentication.getName(), projectId, taskId);
}
```

无请求体，客户端不能指定原因。HTTP200不表示停止完成，gate忙继续原409。pause在同一短保护区先检查原预算关闭，再保存控制意图；first-wins来自持久close原因，不能被后续调用参数改写。TaskRow查询/mapper/snapshot透出已有close_reason_code，旧构造器默认null，不增加N+1读取。

严格停止门槛只用于新pause/worker-restart控制：原instance完整Task身份、合法终态report/hash、CLOSING/ACKED确认、认证status的activeTaskId不再是原Task，或Task2定义的确定旧进程被替换。CLOSING ACK必须可在最终释放前返回，否则slot和结算会互等。记录被原100条/24h规则淘汰时，只有后端已有匹配receipt、同boot认证status不占旧Task且明确task404才可补充退出证据。其他404一律未知。

退出观测不能成为阻止finishForClose/finishApplication推进的前置return：实施时先推进原资源finish，再读取Worker退出证据，防止慢查询耗尽每轮预算。最终同时检查两类证据再释放；三种校验（Worker身份/资源身份/最终CAS）保持各自原职责。

**启动窗口采用最小限制。** 在短gate内检查尚未绑定instance的非终态Task，返回409 `AI_TASK_STARTING`且不改行；前端QUEUED显示“正在启动，稍后可暂停”，仍提供原结束入口。Worker绑定后可以正常暂停；用测试覆盖请求与ACK并发，不新增bindClosingWorker或修改原绑定状态机。已终态先返回原snapshot；已关闭的重复请求不被启动限制错误拦住。

- [x] **4. GREEN。** 复跑Step2；验证旧snapshot/构造器兼容、GET仍纯读、重复pause不增加worker.start、原失败事实不被控制文案覆盖。
- [x] **5. 提交本任务明确文件。** 建议 `feat(ai): add safe pause intent and stop verification`。

## Task 2：Worker确定丢失后核对，等待手动继续

**Files**
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskSettlementService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskStore.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentTaskReconcilerTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentTerminalSettlementTest.java`

**Interfaces**
- Consumes: Task1关闭协议、`WorkerProcessStatus`、`ReconcileCandidate`、`ReconcileWorkBudget`。
- Produces: `boolean AgentTaskStore.beginWorkerRestartClose(String taskId, long epoch, String expectedInstanceId)`；没有新resume/recover API或scheduler。

- [x] **1. 写RED事实矩阵。**

| 输入 | 期待 |
| --- | --- |
| 同boot同身份RUNNING，backend重建 | 原Task/期限保持，start仍一次 |
| 新boot稳定两次+原task认证404+无receipt+新任务 | AI_WORKER_RESTARTED；核对前锁，核对后释放 |
| 单404、boot变化、不可达、401/403、坏JSON、无绑定 | 保留占用，无新模型/工具 |
| deadline=NULL历史行 | 不自动接管 |
| receipt先赢CAS | 原receipt结算，成功Run保留 |
| 关闭先赢、晚到成功 | CLOSING不逆转 |
| deadline已到 | 保留原预算原因 |

AgentTaskReconcilerTest现有Harness已创建并绑定worker-boot，可直接增加：

```java
@Test void workerRestartCloseIsDurableAndIdempotent() {
    try (Harness h = new Harness()) {
        assertThat(h.tasks.beginWorkerRestartClose(h.id, 1L, "worker-boot")).isTrue();
        assertThat(h.tasks.beginWorkerRestartClose(h.id, 1L, "worker-boot")).isFalse();
        assertThat(h.reason()).isEqualTo("AI_WORKER_RESTARTED");
        assertThat(h.state()).isEqualTo("NEEDS_ATTENTION");
    }
}
```

- [x] **2. RED。**

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=AgentTaskReconcilerTest,AgentTerminalSettlementTest' test
```

- [x] **3. 最小实现。** 原importTerminal的404分支执行status→task404→status，认证且两次稳定新boot、与已绑定旧instance不同；共享原5秒预算，未读全就下一轮。随后短gate中调用CAS：

```sql
UPDATE agent_task
SET state='NEEDS_ATTENTION', failure_code='AI_CLOSING',
    close_reason_code='AI_WORKER_RESTARTED', next_reconcile_at=?,
    updated_at=?, reconcile_attempt=0
WHERE id=? AND worker_epoch=? AND worker_instance_id=?
  AND deadline_at IS NOT NULL AND deadline_at>?
  AND state IN ('QUEUED','RUNNING','NEEDS_ATTENTION')
  AND terminal_report_id IS NULL AND close_reason_code IS NULL
  AND (failure_code IS NULL OR failure_code<>'AI_CLOSING');
```

沿用Clock/锁序；CAS只存意图，不做网络或释放。失败重读，不覆盖新receipt/关闭原因；成功交原settleCloseIntent。多Worker并发/滚动重叠不是现有单Worker假设，不在本轮建设分布式恢复。
- [x] **4. GREEN。** 复跑Step2；核对无自动新Task/工具、epoch/deadline未重置。
- [x] **5. 提交。** 建议 `feat(ai): reconcile lost worker executions before manual continuation`。

## Task 3：长构建主动停止，保留原资源证明

**Files**
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/Fabric8DevelopmentBuildExecutor.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/AiConfig.java`
- Modify only if regression proves necessary: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentProjectTools.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/DevelopmentBuildExecutorTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentProjectToolsTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentTerminalSettlementTest.java`

**Interfaces**
- Consumes: 原BuildRequest/BuildResult/creation fence、`AgentTaskStore.hasCloseIntent(SettlementView)`。
- Produces: 构造注入 `Predicate<AgentContracts.BuildRequest> stopRequested`；BuildResult沿用 `BUILD_CLOSED`、未知exitCode=null及真实cleanupConfirmed。

- [x] **1. RED。** 在原Fabric8 mock server测试夹具中创建尚未退出的Job，给executor增加谓词构造参数；测试内部AtomicBoolean初始false，确认Job/Pod已出现后设true，不推进600秒deadline。用Future获取真实BuildResult并断言：

```java
BuildResult result = runningBuild.get(10, TimeUnit.SECONDS);
assertThat(result.terminationReason()).isEqualTo("BUILD_CLOSED");
assertThat(result.exitCode()).isNull();
assertThat(result.cleanupConfirmed()).isTrue();
assertThat(client.batch().v1().jobs().inNamespace(NS)
    .withName(result.identity().jobName()).get()).isNull();
assertThat(client.pods().inNamespace(NS).withLabel(
    JobResourceFactory.LABEL_TOOL_CALL_ID, COMMAND).list().getItems()).isEmpty();
```

`runningBuild`是该fixture调用executor.build的Future，复用原request()/Pod/UID创建辅助函数。还要让mock删除持续409或Pod仍存在，断言cleanupConfirmed=false；UID替换不得删除；close与create竞争不得新建；claim未释放仍不能写。
- [x] **2. 执行RED。**

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=DevelopmentBuildExecutorTest,AgentProjectToolsTest,AgentTerminalSettlementTest' test
```

- [x] **3. 最小实现。** 保留旧构造器委托默认false，生产AiConfig明确注入：

```java
request -> AgentTaskStore.hasCloseIntent(tasks.settlementView(request.taskId()))
```

不要用较宽的hasClosingIntent，它将成功receipt待核对也视为禁止创建，不能当停止信号。awaitSettlement每轮检查持久控制意图，并使用原cleanup：

```java
if (stopRequested.test(request)) {
    boolean confirmed = cleanup(jobName, jobUid, request.commandId());
    return new AgentContracts.BuildResult(
        new AgentContracts.BuildIdentity(jobName, jobUid, podUid),
        null, "BUILD_CLOSED", "", false, List.of(), confirmed);
}
```

查询异常/删除不确定走既有NEEDS_ATTENTION，不伪造成功。runBuild保持claim直到落库或记录未知，finally才释放；后台close不能提前清claim抢删。保留原有有界日志，不能为日志等自然构建完成。不引入取消注册中心、Future表、线程强杀或新执行池。
- [x] **4. GREEN。** 复跑Step2并核对原commandId只创建一次、Pod/UID证明、原成功构建与READY应用保留回归。实际响应受原轮询和I/O边界约束，不承诺集群异常时固定秒数解锁。
- [x] **5. 提交。** 建议 `fix(ai): stop active builds cooperatively during takeover`。

## Task 4：暂停、接管与同会话继续的浏览器体验

**Files**
- Modify: `poc4/frontend/src/contracts/agentTask.ts`
- Modify: `poc4/frontend/src/api/agentTaskApi.ts`
- Modify: `poc4/frontend/src/features/ai/agentTaskQueries.ts`
- Modify: `poc4/frontend/src/features/ai/AgentTaskPanel.tsx`
- Modify: `poc4/frontend/src/features/ai/AgentConversationPanel.tsx`
- Create: `poc4/frontend/src/features/ai/agentTaskControl.ts`
- Create/Test: `poc4/frontend/src/features/ai/agentTaskControl.test.ts`
- Test: `poc4/frontend/src/features/ai/AgentTaskPanel.test.tsx`, `AgentConversationPanel.test.tsx`, `agentTaskPreconditions.test.ts`（同目录）
- Test: `poc4/pi-worker/test/conversation-context.test.ts`, `pi-session-context.test.ts`, `server.test.ts`（同目录）
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentProjectToolsTest.java`
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.tsx`，沿useCloseAgentTaskMutation和runAgentReload接线，不能以历史选中Task作为控制目标。
- Test: `poc4/frontend/src/components/shell/WorkbenchShell.test.tsx`，覆盖dirty文档、Run锁及解除占用后的reload。

**Interfaces**
- Consumes: `closeReasonCode`、pause HTTP、`submitConversationTask`、原resolveAgentTaskPreconditions和持久提交intent。
- Produces: `pauseAgentTask(projectId: string, taskId: string): Promise<AgentTaskSnapshot>`、`usePauseAgentTaskMutation(projectId: string)`、纯函数 `canContinueTask(task: AgentTaskSnapshot | null, conversationId: string | undefined): boolean`、`CONTINUE_TASK_PROMPT`。
- canContinueTask仅表达历史最新执行的语义资格，最终按钮还须满足原canStart/dirty/writePending/Run authority/revision/compaction/占用限制。

- [x] **1. RED组件和协议测试。** 用当前完整snapshot fixture检查：

```typescript
expect(canContinueTask({ ...snapshot, writesLocked: true,
  closeReasonCode: 'AI_PAUSED_BY_OWNER' }, snapshot.conversationId!)).toBe(false);
expect(canContinueTask({ ...snapshot, state: 'FAILED', writesLocked: false,
  closeReasonCode: 'AI_PAUSED_BY_OWNER' }, snapshot.conversationId!)).toBe(true);
expect(canContinueTask({ ...snapshot, state: 'FAILED', writesLocked: false,
  closeReasonCode: 'AI_PAUSED_BY_OWNER' }, 'another-conversation')).toBe(false);
```

组件点击/网络断言必须覆盖：pause200但锁true仍不可写；失败后按钮恢复；QUEUED提示启动且End task仍可用；历史会话中可暂停project current；最新Task才能继续；新Task同conversation/不同taskId/最新revision；响应丢失核对同id；reload不发start/pause；dirty保留并阻止继续；其他Run仍活跃时编辑保持锁。旧JSON缺closeReasonCode按null。

Worker回归经真实SDK scripted session：历史未完成工具轮不重放、新prompt有当前revision。用户将文件SHA A改成B，新Task使用新revision但旧SHA A写入应拒绝；模型重读得到B后可正常写入。省略SHA只能创建不存在文件。复用原校验，不新增读取凭证Map。
- [x] **2. RED。**

```powershell
pnpm --dir poc4/frontend exec vitest run src/features/ai/agentTaskControl.test.ts src/features/ai/AgentTaskPanel.test.tsx src/features/ai/AgentConversationPanel.test.tsx src/features/ai/agentTaskPreconditions.test.ts
pnpm --dir poc4/pi-worker exec vitest run test/conversation-context.test.ts test/pi-session-context.test.ts test/server.test.ts
mvn -f poc4/backend/pom.xml '-Dtest=AgentProjectToolsTest' test
```

- [x] **3. 最小实现。** 实施时保留唯一handleStart提交/探测路径：同一表单根据最新Task资格展示Start或Continue，空目标使用默认继续prompt；无需再提取只有单一调用点的submitPrompt。两种提交共用原request-id核对。纯函数模块只容纳继续资格与默认prompt：

```typescript
export const CONTINUE_TASK_PROMPT =
  '继续这个会话中尚未完成的工作。先读取当前项目相关文件并核对应用状态，' +
  '基于当前已保存版本继续；不要重放上一次未确认的工具操作。';

export function canContinueTask(
  task: AgentTaskSnapshot | null, conversationId: string | undefined,
): boolean {
  return !!task && !!conversationId && task.conversationId === conversationId
    && !task.writesLocked && task.state === 'FAILED'
    && ['AI_PAUSED_BY_OWNER', 'AI_WORKER_RESTARTED'].includes(task.closeReasonCode ?? '');
}
```

调用方只传所选conversation最新Task；占用始终以project current为准。按钮 `Pause & take over` / `Continue task`，帮助文本明确同一会话新一轮执行（最多30分钟），沿用现有界面语言。用户可在输入框补充/替换默认目标。End task保留。

同conversation最新Task处于暂停收尾中时展示禁用的Continue task，明确等待核对；已释放后再按canStart启用。历史旧Task不显示继续。只在QUEUED启动窗口禁用Pause并提示稍后再试，不能把所有NEEDS_ATTENTION一律隐藏控制入口。

pause mutation走原close invalidate/reload路径；最终释放后刷新树、打开文件、revision、Run authority。dirty内容不丢，读取失败不允许编辑。历史会话控制项目当前占用Task，提供跳回当前会话；不能停止displayTask。没有conversation的历史任务只保留结束/接管，不静默创建会话搬历史。其他失败沿用输入框提交修正，不自动重试模型。
- [x] **4. GREEN与类型构建。** 复跑Step2，再运行：

```powershell
pnpm --dir poc4/frontend typecheck
pnpm --dir poc4/frontend build
pnpm --dir poc4/pi-worker build
```

Worker生产代码默认不改，只在红测证明缺口时小改原context/session/server。
- [x] **5. 提交。** 建议 `feat(ai-ui): add takeover and same-conversation continuation`。

## Task 5：精简端到端验证与交付

**Files**
- Create: `poc4/frontend/tests/e2e/ai-stage4.spec.ts`
- Create: `poc4/frontend/playwright.ai-stage4.config.ts`
- Modify: `poc4/frontend/package.json`，增加test:e2e:ai-stage4
- Modify: `poc4/frontend/tests/fixtures/ai-terminal-settlement/setup.ts`, `page.tsx`（同目录）
- Modify: `poc4/backend/src/test/java/com/manao/poc4/ai/TerminalSettlementLocalServer.java`
- Modify: `poc4/pi-worker/test/local-terminal-harness.test.ts`
- Create: `poc4/docs/evidence/ai-stage4/acceptance.md`
- Modify: `poc4/frontend/README.md`, `poc4/deploy/ai-terminal-settlement/README.md`, `docs/what-we-have-done.md`
- Regression: `poc4/backend/src/test/java/com/manao/poc4/run/RunControllerTest.java`, `poc4/backend/src/test/java/com/manao/poc4/ai/AgentApplicationToolsTest.java`

**Interfaces**
- Consumes: Tasks1–4、原local terminal真实HTTP/MySQL/scripted-provider夹具。
- Produces: 有证据的 `LOCAL_STAGE4_CONTROL_VERIFIED` 或失败/阻塞结论；取得后续发布授权并真实通过后才记 `PI_STAGE4_CONTROL_RECOVERY_PASS`。

- [x] **1. 复用原夹具，增加本阶段控制点。** setup新增可选 `MANAO_AI_LOCAL_EVIDENCE_DIR`，默认保留旧证据目录，本阶段传新目录；不建立通用配置框架。继续端口占用即失败，同一时间只运行一个local套件。scripted场景增加“等待暂停、下一轮读取用户修改文件”，保存走生产workspace API，控制route只存在test Spring上下文。

```typescript
import { defineConfig } from '@playwright/test';
import base from './playwright.ai-terminal-settlement.config';
export default defineConfig({
  ...base, testMatch: 'ai-stage4.spec.ts',
  outputDir: 'test-results/ai-stage4',
});
```

原page.tsx只加载AI面板，不能把它称为完整Workbench验收。局部浏览器测试核对按钮/HTTP/持久事实；编辑器保存与Run锁联动由原组件集成测试覆盖，完整工作台留到授权后的云端场景。不复制完整前端或另建集群来补夹具。

- [x] **2. 三条端到端链先RED后GREEN。**

| 用例 | 必须观察的事实 |
| --- | --- |
| A 接管/修改/继续/刷新 | 浏览器建conversation并提交→暂停200仍锁→停止/receipt/claim核对后解锁→真实保存修改→继续同conversation新Task→读到修改→reload仍同Task，无额外start |
| B 服务异常 | backend重建同Worker继续且不重复prompt；Worker换boot后旧Task核对收尾→只在点击继续时新建一次；未知timeout保持锁 |
| C 应用/清理 | 本Task应用/开发执行未退出不能编辑；正常COMPLETED保留READY；其他Run不误停；占用时项目删除拒绝，安全收尾后走原删除 |

本地资源侧使用mock，不能记录真实Pod/子进程PASS。C的完整项目删除部分放已有RunControllerTest/清理回归；不为local fixture复制全平台。使用真实SDK scripted provider，不调用付费模型。

示例浏览器核心断言使用生产按钮与后台current，不靠测试页自造成功标签：

```typescript
await page.getByRole('button', { name: 'Pause & take over' }).click();
await expect(page.getByRole('button', { name: 'Continue task' })).toBeDisabled();
await expect.poll(async () =>
  (await request.get(api + '/agent-tasks/current', { headers })).status()
).toBe(404);
await expect(page.getByRole('button', { name: 'Continue task' })).toBeEnabled();
```

api/headers复用原spec的auth辅助；用测试latch保持一段STOPPING，确保能观察禁用状态，不能用任意sleep避免竞争。继续前保存、读取newTaskId及比对conversation/revision仍为必需断言。

```powershell
mvn -f poc4/backend/pom.xml test-compile dependency:build-classpath '-Dmdep.outputFile=target/terminal-local-classpath.txt'
$env:MANAO_AI_LOCAL_EVIDENCE_DIR = Join-Path (Get-Location) '.superpowers/ai-stage4-local'
pnpm --dir poc4/frontend test:e2e:ai-stage4
Remove-Item Env:MANAO_AI_LOCAL_EVIDENCE_DIR
```

使用现有 `MANAO_TERMINAL_TEST_DB_USERNAME/PASSWORD`，只连本机disposable schema，不从云端env推导或输出凭据。

- [x] **3. 必要汇总回归一次。**

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=AgentTaskServiceTest,AgentTaskStoreTest,AgentTerminalSettlementTest,AgentTaskReconcilerTest,AgentConversationHttpContractTest,AgentProjectToolsTest,AgentApplicationToolsTest,DevelopmentBuildExecutorTest,RunControllerTest' test
pnpm --dir poc4/pi-worker test
pnpm --dir poc4/frontend exec vitest run src/features/ai src/components/shell/WorkbenchShell.test.tsx src/api/agentConversationApi.test.ts src/contracts/agentConversation.test.ts
pnpm --dir poc4/frontend typecheck
git diff --check
```

失败先定位本轮影响；不能跳过或放宽断言冒充PASS。无关基线失败单列，不扩成额外修复任务。若共享fixture改动，原ai-terminal-settlement local套件回归一次；不重做Stage2、完整A–N云端矩阵或1800秒真实等待。

- [x] **4. 写验收和发布增量。** acceptance列HEAD、日期、命令、退出码、范围与限制，区分mock资源/真实资源。维护手册新增阶段四兼容节：无迁移；兼容backend先于frontend；Worker仅生产代码改动才发布；旧frontend忽略新字段。回退前暂停新任务并结清pause/restart close，旧backend不能接管尚未完成的新严格门槛。镜像未构建就写NOT_RUN，不填占位digest。

云端后续只需专用项目三场景：①真实长构建暂停、确认其Job/Pod和子进程退出、人工保存、同会话继续、完整工作台刷新；②Worker真实换boot/Pod UID、旧执行不重放、手动继续；③删除该专用项目，核对项目Job/Pod/Service/PVC/PV及数据库行，保留平台资源。将正常COMPLETED保留READY Run作为同链控制断言。发布预检还要确认Worker `replicas: 1 / strategy: Recreate`，与当前部署清单一致。

- [x] **5. 清理与交付。** 实际核对本轮临时schema、PID、scratch删除结果；保留必要证据，不碰其他会话残留。无BOM/链接/diff检查后提交明确文件，建议 `test(ai): verify stage four takeover and recovery flows`。报告列实现、本地证据、云端NOT_RUN、未push/merge和真实遗留，不称整个AI首版已完成。

## 计划自检（2026-10-27）

| 检查 | 结果与取舍 |
| --- | --- |
| 范围覆盖 | 暂停/编辑/继续T1+T3+T4；异常T2；重进T4+T5；清理T3+T5；前两项延期不变 |
| 状态与预算 | 删除同Task复活、PAUSED状态、剩余预算、父Task表；用户已确认同会话新执行 |
| 恢复架构 | 删除新scheduler、恢复API、outbox/PVC、通用框架；复用receipt/reconciler |
| 重复防护 | 删除拟新增读取Map；保留原revision/SHA、重读提示和用户修改回归 |
| 启动窗口 | 删除草案中的补绑协议；未绑定时暂停409/稍后再试，旧结束入口仍可达 |
| 构建取消 | Predicate+原cleanup解决真实长构建阻塞；不建Future表、线程强杀或服务 |
| 必要竞争 | 保留CLOSING ACK与slot互等、receipt/close/deadline先后、UID/claim核对，防止串写与误清理 |
| 维护性 | 零新生产服务/依赖/表；前端最多一个纯函数模块；不全拆近1700行TaskStore |
| 扩展性 | conversation、Task、工具、执行器边界保持；未来Shell/MCP接入须继承同样占用/核对合同 |
| 测试成本 | 复用harness，三条E2E+定向套件，云端三场景；不重复全平台验收 |
| 类型一致 | pause、closeReasonCode与两原因码一致；继续使用conversation提交，无隐含resume API |
| 证据边界 | 本地结果见验收；云端NOT_RUN，Stage2和原Task结论保持 |

自检已删除两处不必要状态（读取Map、启动补绑），修正构建停止谓词误用风险，并明确本地夹具的完整Workbench/真实集群证据缺口。保留停止、receipt和版本检查，因为它们直接支撑接管正确性。

五项任务是可独立测试的交付单元，主要新增工作集中在Task1/2控制竞争和Task3取消接缝。当前无待定产品决策；实施中只有真实阻塞或改变已确认范围/体验的问题才再询问。
