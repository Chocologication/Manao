# Pi Stage 2 Application Feedback Implementation Plan

> 历史实施计划：后续授权的 Tasks 1–5 已逐项实现、审查修复并提交至 `559f998`，最终整分支复审 Approved。当前交付、有效 RED/GREEN、六项裁定及 NOT_RUN 边界以 [Stage 2 实施记录](../../../poc4/docs/evidence/ai-stage2/acceptance.md) 为准；下文原步骤/复选框保留规划历史，不是重新执行指令，也不代表真实模型/集群验收 PASS。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 每个任务先读本计划和设计，再做失败测试、最小实现与两阶段审查；只读研究可并行，共享文件的实现顺序进行。

**Goal:** Pi 自动停止已有应用、等待退出后改测代码、创建新 Run，并依据真实状态、日志与项目 HTTP GET 反馈完成修复。

**Architecture:** 扩展第一阶段同一个工具 seam 和 ledger；原四工具之外只新增 application 与 app_http_get。现有 Run/日志 Module 继续拥有运行事实，新增两个 concrete Module 隐藏应用工具语义和受限 HTTP IO；不复制 Run 状态机或自建编排。

**Tech Stack:** Java 17 / Spring Boot 3.5.9 / Fabric8 7.7.0 / MySQL；React / TypeScript / pnpm 10.33.0；Node >=22.19.0 / Pi SDK 1.2.0；JUnit、Mockito、Fabric8 mock、Vitest、Playwright。

**Spec:** [Pi 第二阶段设计](../specs/2026-10-16-pi-stage2-design.md)。范围来源：[四阶段拆分 §2/§4](../../research/2026-10-13-pi-minimal-integration-implementation-slicing.md)、[已确认选择 §10](../../research/2026-10-13-ai-integration-framework-evaluation.md#10-最小集成设计的已确认决定2026-10-13)。

## Global Constraints

- 仅一个显式启用的专用 Spring Boot 项目、单后端、单 Pi worker；任务直接修改真实项目，Agent 期间独占写入。
- Pi SDK 固定 `1.2.0`，Node `>=22.19.0`，pnpm `10.33.0`；Java `17`、Spring Boot `3.5.9`、Fabric8 `7.7.0`；不升级依赖，不引入新运行框架。
- 任务 `1800s`、最多 `60` 次工具调用、`8` 次构建；新增最多 `4` 次 application/start。每次 status/stop 等待 `0–10s`，轮询间隔 `2s`，不得跨等待持有 ProjectLifecycleGate。
- 沿用构建 `600s`、收尾 `120s`、文件 `128KiB`、工具结果 JSON `192KiB`、进度最近 `100` 项且每项 `8KiB` 的既有限额。
- 应用日志只返回最近 `64KiB` UTF-8 文本；HTTP path 最多 `2048` 字符，GET 连接 `3s`、请求/读取总计 `10s`、响应最多 `64KiB`，禁止自动重定向、自动重试、任意 host/port/header/body。
- 应用继续使用现有 Job + Service、原用户端口及 `7200s` ready 后寿命；不自动换端口、不引入 Deployment、不做基础设施自动重启。
- 不新增表、Flyway migration、任务状态、消息队列、事件总线、workflow/provider registry；复用 agent_task、agent_tool_call、run 和持久日志。
- 普通浏览器 start/stop、文件/依赖变更、删除继续受到 Agent 占用检查；文件写入和 build 在任何 active Run 存在时均拒绝。
- 模糊副作用先查询原 task/toolCall/run/receipt；不生成新身份重试。UNKNOWN、Forbidden、身份不匹配和超时不能证明应用已退出。
- 模型配置和密钥只在 worker；worker 不访问用户文件系统、不执行用户代码、不获取平台或集群凭据；保留现有受控资源加载与工具 allowlist。
- 后端数据库测试仅用 disposable schema，禁止重置 manao_poc4 或 manao_poc4_6b；前端/worker 只用 pnpm，生成文件 UTF-8 无 BOM，shell/Docker 入口 LF。

---

## 1. 基线与执行顺序

本计划所有文件路径相对实际 checkout `.worktree/ai-integration`，分支 `codex/ai-integration`。第二阶段实施代码基线为 `b2c6ec384e2b0ed4af2019140504f74417147084`（短 SHA `b2c6ec3`，2026-10-16）；该提交已收录 revision-cache 修复、部署/验收文档及第二阶段规划。后续仅同步基线的文档提交不改变此代码基线；实施应使用包含该提交和最新计划的 HEAD。主检出 `master@49eb632` 无 AI 源码，不能在那边直接执行这些任务。

第一阶段真实验收由 [acceptance §8](../../../poc4/docs/evidence/ai-stage1/acceptance.md) 拥有；旧第一阶段 spec/plan 的 NOT_RUN 段落是历史快照。本计划不重跑第一阶段全套验收，也不把第二阶段记成已实现。

此前待提交的 AgentTaskPanel/fileQueries/workspaceReload 六个源码/测试文件、部署 README、acceptance 及 [revision 修复计划](2026-10-15-ai-revision-availability-fix-plan.md) 均已纳入 `b2c6ec3`。实施前记录实际 HEAD/status，并用 `git merge-base --is-ancestor b2c6ec3 HEAD` 确认包含该基线；若出现新的未提交修改则保留并区分范围。新建实现工作树只在确有隔离需要时按 using-git-worktrees 从包含该基线及最新计划的提交创建。

顺序：Task 1 → Task 2 → Task 3 → Task 4 → Task 5。Task 3 的网络实现可在 Task 2 审查时只读研究。五项均有可独立拒绝/接受的行为交付，不设置单独的脚手架、配置或文档任务。

## 2. 先固定 Interface 与文件职责

### 2.1 文件地图

| 文件（poc4/ 下） | 职责和处理方式 |
| --- | --- |
| backend/src/main/java/com/manao/poc4/project/AgentTaskOccupancy.java | 在现有 Interface 增加 agent Run 的持久授权检查；禁用实现默认拒绝 |
| backend/src/main/java/com/manao/poc4/ai/AgentTaskStore.java | admission、Run 调用授权、最多 4 次 start、执行 claim、从 ledger 枚举任务 Run |
| backend/src/main/java/com/manao/poc4/run/RunService.java | 小幅抽取共同 start/stop Implementation，接受稳定 Run 身份；浏览器继续检查占用 |
| backend/src/main/java/com/manao/poc4/ai/AgentApplicationTools.java（新） | application 四 action、日志 tail、工具结果投影、停止与收尾；不拥有新运行状态机 |
| backend/src/main/java/com/manao/poc4/ai/ProjectApplicationProbe.java（新） | 校验项目 Service 路由/端口，受限 GET、deadline、截断和固定错误 |
| backend/src/main/java/com/manao/poc4/ai/AgentProjectTools.java | 两个新工具登记/派发，写/build互斥、结果与浏览器 allowlist |
| backend/src/main/java/com/manao/poc4/ai/AgentTaskService.java | 终态和 close 的三段收尾，FAILED 不得直接释放 |
| backend/src/main/java/com/manao/poc4/config/AiConfig.java | 注入两个 concrete Module；使用已有 RunStore/RunService/RunLogService |
| pi-worker/src/project-tools.ts、pi-session.ts | 六工具 schema/allowlist、目标与证据说明；Pi 自行决定工具顺序 |
| frontend/src/features/ai/agentTaskPreconditions.ts、AgentTaskPanel.tsx | 运行中可以提交目标，显示应用工具真实结果 |
| frontend/src/contracts/agentTask.ts、api/agentTaskApi.ts | 沿用 ToolResult owner route，解析新 data.kind；不扩展 TaskSnapshot |
| frontend/src/components/shell/WorkbenchShell.tsx、components/runs/RunPanel.tsx | Agent/Run 只读合并，查看指定 Run；沿用日志传输 |
| frontend/tests/fixtures/ai-stage2/、tests/e2e/ai-stage2.spec.ts、scripts/ai-stage2-*.mjs | 一条真实 HTTP 失败修复的 fixture、独立判定与可复现入口 |
| deploy/ai-stage2/README.md、docs/evidence/ai-stage2/acceptance.md | 发布准备/执行证据，分开 implementation PASS 与真实阶段 PASS |

相应测试与源码同名、沿用既有目录，不移动旧文件、不拆整个 Run Module。若实际文件名有变化，先核对当前 checkout 并在执行记录注明具体替代路径。

### 2.2 后端新增/扩展 Interface

```java
// project.AgentTaskOccupancy；保留 @FunctionalInterface 及现有lambda实现，新增default拒绝。
default void requireAgentRunCall(String taskId, String projectId, String toolCallId,
                                String action, String runId) {
    throw new com.manao.poc4.api.ApiException("AI_TASK_NOT_ACTIVE", 409, "Task is not active");
}

// run.RunService；仅供后端 Module 调用，无新增浏览器/internal HTTP route。
RunSummary startForAgent(String ownerId, String projectId, String taskId,
                         String toolCallId, String runId, String expectedRevision);
RunSummary stopForAgent(String ownerId, String projectId, String taskId,
                        String toolCallId, String runId);

// ai.AgentTaskStore；仍为 concrete JDBC Module。
void requireNoActiveRun(String projectId);
List<ToolCallRow> applicationCalls(String taskId);

// ai.AgentApplicationTools；调用者已完成 ledger 登记，方法内部复核授权。
ToolResult invoke(String taskId, ToolCallRow row, ToolRequest request);
boolean finish(String taskId); // 只核对/停止已登记的任务执行，不创建应用

// ai.ProjectApplicationProbe；RunRecord 含后端执行 UID，不返回给模型。
AgentContracts.AppHttpGetData get(RunRecord run, String path);
```

`ToolCallRow` 是 `AgentTaskStore.ToolCallRow`，`ToolRequest/ToolResult` 来自 `AgentContracts`；RunRecord/RunSummary 沿用 run package。`AppHttpGetData` 为本任务新增嵌套 record，字段与 spec §5 的同名类型逐项一致。application data 可以使用 ObjectNode，但字段必须与 spec 一致；禁止再造一套 RunDTO。

`AgentApplicationTools.invoke` 接受两个名字 application/app_http_get；后者在 Task 3 注入 probe 后启用。具体构造器按上述实际依赖注入，不新增 RunControl/LogReader/HTTP provider 的空壳 Interface。

### 2.3 ledger 和生命周期规则

- application/start：既有 workspace_operation_id 存稳定 UUID 并作为 run.id；application/stop：args.runId 固定目标。status/logs 不伪造 workspace operation。
- 只在 `isSideEffect(request)` 中判断 write_file、build、application 的 start/stop；不能把所有 application action 放进 SIDE_EFFECT_TOOLS，阻断本应可用的 status/logs。
- 慢 IO 在 gate 外；按现有 build claim 思路扩展同一个 live-call 集合，使并发重放只执行一次且 close 看得到在途调用。不要新建通用 executor 框架。
- 并发 start：在 gate + 持久授权短临界区检查 closing/未决build、登记 RUNNING claim、核对/插入稳定 runId。网络 ensureJob 不作为第二次创建入口；已存在 Run 只返回/观察。
- stop/status 等待结束但仍正常 STARTING/STOPPING，持久 COMPLETED 的工具结果可表示尚未 ready/stopped。10s 是观察预算，不是把正常异步 Run 自动判 UNKNOWN 的依据。
- close/FAILED：短锁标记 closing → **锁外** stop/等待与 build/file 收尾 → 短锁重读 calls/live claim/run 后 CAS 释放。禁止在当前 close 的 gate+synchronized(tasks) 内等待 RunObservationService。
- 正常 terminal COMPLETED 保留稳定 ready 的最终应用；transition/未知执行阻止释放。FAILED 也走收尾，保留原 failureCode；未触碰的原应用不被误停。

## Task 1: 让 Agent 安全取得有应用的项目，并稳定创建 Run

**Files:**
- Modify: `poc4/backend/src/main/java/com/manao/poc4/project/AgentTaskOccupancy.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskStore.java`（createTask、调用授权与 claim）
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunService.java`（startLocked/stop）
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentProjectTools.java`（write/build 前置检查）
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentTaskStoreTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentProjectToolsTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/run/RunControllerTest.java`

**Interfaces:**
- Consumes: `createTask(owner, project, TaskRequest)`、`registerToolCall(...)`、`RunStore.insertRun/findRunForOwner/findActiveRun`、`JobCoordinator.ensureJob/observe`。
- Produces: §2.2 的 requireAgentRunCall、requireNoActiveRun、applicationCalls、startForAgent、stopForAgent；浏览器 start/stop 仍用原 Interface。

- [ ] **Step 1: 写 admission/互斥的失败测试。** 修改已有 `anActiveRunBlocksTaskRegistration`，继续使用该类现有 seed/store/insertRun helper；它现在应证明 task 可以取得占用而写和 build 不能执行。

```java
// AgentProjectToolsTest：使用本类既有 Harness/JSON/PROJECT。
@Test
void activeApplicationBlocksBuildWithoutCallingTheExecutor() {
    try (var h = new Harness()) {
        Timestamp now = new Timestamp(System.currentTimeMillis());
        h.jdbc.update("INSERT INTO run(id,project_id,requested_revision,state,policy_json,version,"
            + "created_at,updated_at,fencing_token) VALUES (?, ?, 7, 'STARTING', '{}', 0, ?, ?, 1)",
            UUID.randomUUID().toString(), PROJECT, now, now);
        ToolResult result = h.tools.invoke(h.taskId, new ToolRequest(
            "build-with-live-app", "build", 7, JSON.createObjectNode().put("goal", "test")));
        assertThat(result.data().path("error").path("code").asText()).isEqualTo("AI_RUN_ACTIVE");
        verifyNoInteractions(h.builds);
    }
}
```

另加行为矩阵：READY+active→task成功；PENDING/foreign/其他task仍拒；STOPPING 与 RECOVERING 同样阻止 write/build；无 active 时四个旧工具回归仍通过。

- [ ] **Step 2: 运行 RED，记录预期失败。** 从 `poc4/backend`：

```powershell
mvn -Dtest=AgentTaskStoreTest,AgentProjectToolsTest,RunControllerTest test
```

预期：新 admission 断言因 RUN_ALREADY_ACTIVE 失败；build 断言因执行器被调用或缺少 AI_RUN_ACTIVE 失败。数据库连接失败不是有效 RED；先用 JdbcStoreTestSupport 既有 disposable 配置。

- [ ] **Step 3: 最小实现 admission/稳定启动和 agent 授权。**

```java
// AgentTaskStore：现有 hasActiveRun SQL 继续使用，不复制查询到 worker。
public void requireNoActiveRun(String projectId) {
    if (hasActiveRun(projectId)) {
        throw new ApiException("AI_RUN_ACTIVE", 409, "Stop the application before editing or building");
    }
}
```

从 createTask 去掉 active 拒绝；保留其余事务检查。AgentProjectTools 注册调用之后、任何 write/build副作用之前，在同一 gate 内调用 requireNoActiveRun，使确定拒绝作为可读 `data.error` 结算。

`requireAgentRunCall` 查询 task+tool row，检查 owner/project 关联、toolName=application、args.action、持久 state。action=start：runId等于workspace_operation_id且task正在接调用；action=stop：task正常时要求原row的args.action=stop且args.runId等于目标，task处于closing时额外允许原row的args.action=start且workspace_operation_id等于目标，用于只停该任务创建的Run。closing永不批准start。taskId/callId不存在或外项目时固定拒绝。AI关闭时的NO_AGENT_TASKS实现默认拒绝agent方法，避免no-op获权。

startForAgent 先授权，再 owner-scoped 查询原 runId；存在则核对 project/revision 并返回（包括终态），不存在才按既有 READY/revision/dependencies/active/fencing 逻辑插入指定 runId。原 start 生成 UUID 后走相同私有 Implementation，但始终 requireBrowserWritable；stop 也在共享 gate 内加这一检查，agent走独立授权入口。无任何 bypass boolean 或模型传入 owner。

- [ ] **Step 4: 增加稳定身份/丢响应/close竞争测试并 GREEN。** 在 RunControllerTest 的现有 FakeRunStore/StubCoordinator 上增加：同稳定runId两次→一行一次ensureJob；已FAILED原Run重放仍返回该Run；异项目/版本/伪造call拒绝；ensureJob 已生效后抛异常→查原Run RECOVERING，不创建另一Run；普通browser start/stop被AI_TASK_ACTIVE拒；close登记先赢→agent start不插入；start正在插入→close不能先释放。

```powershell
mvn -Dtest=AgentTaskStoreTest,AgentProjectToolsTest,RunControllerTest,RunObservationServiceTest test
git diff --check
```

这些测试从 Module Interface 观察行数/Run身份/执行次数，不测试私有 helper 实现细节。

- [ ] **Step 5: 审查后提交本任务文件。**

```powershell
git add poc4/backend/src/main/java/com/manao/poc4/project/AgentTaskOccupancy.java poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskStore.java poc4/backend/src/main/java/com/manao/poc4/run/RunService.java poc4/backend/src/main/java/com/manao/poc4/ai/AgentProjectTools.java poc4/backend/src/test/java/com/manao/poc4/ai/AgentTaskStoreTest.java poc4/backend/src/test/java/com/manao/poc4/ai/AgentProjectToolsTest.java poc4/backend/src/test/java/com/manao/poc4/run/RunControllerTest.java
git commit -m "feat(ai): authorize stable application runs within agent tasks"
```

交付：应用运行时可以安全取得任务占用；未停机不能写/构建；可信调用可复用一个稳定 Run，浏览器不能绕锁。

## Task 2: 接入 application 工具、持久日志和正确收尾

**Files:**
- Create: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentApplicationTools.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentProjectTools.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/AiConfig.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentProjectToolsTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentTaskServiceTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentApplicationToolsTest.java`（新）

**Interfaces:**
- Consumes: Task 1 的稳定 startForAgent/stopForAgent/授权与互斥；RunService.get/active；RunLogService.windowFor/chunksAfter/meta。
- Produces: `AgentApplicationTools.invoke/finish` 和 spec §5 ApplicationData；AgentProjectTools 支持 application，browser tool view 仅返回显式安全投影。

- [ ] **Step 1: 在现有 Harness 注入真实 AgentApplicationTools 和 mock RunService/RunStore/RunLogService，写失败测试。** 仅扩展旧 Harness，保留旧四工具测试。新调用采用既有 ToolRequest，不造第二套测试DSL。

```java
// AgentProjectToolsTest 内，Harness 增加 runs=mock(RunService.class)、runStore、logs、application，
// 构造器把 application 注入 AgentProjectTools；所有使用该扩展的测试在本任务一起更改。
@Test
void aStopReplayReturnsTheRecordedSnapshotAndNeverChangesItsTarget() {
    try (var h = new Harness()) {
        ToolRequest request = new ToolRequest("stop-original", "application", 7,
            JSON.createObjectNode().put("action", "stop").put("runId", "run-0").put("waitSeconds", 0));
        // 不存在的 run 也是确定拒绝，缓存后重放不得再次调用 RunService。
        when(h.runs.get(OWNER, PROJECT, "run-0"))
            .thenThrow(new ApiException("RUN_NOT_FOUND", 404, "Run not found"));
        ToolResult first = h.tools.invoke(h.taskId, request);
        ToolResult replay = h.tools.invoke(h.taskId, request);
        assertThat(replay).isEqualTo(first);
        assertThat(first.data().path("error").path("code").asText()).isEqualTo("AI_RUN_NOT_FOUND");
        verify(h.runs, times(1)).get(OWNER, PROJECT, "run-0");
    }
}
```

AgentApplicationToolsTest 直接 mock 已有 Module 的 Interface，不再写 RunControl/LogReader Adapter。通过真实 RunLogWindow 和 in-memory ChunkStore 验证 tail、UTF-8 byte limit、空窗口、缺口和终态 complete；不模拟第二条 Pod 日志路径。

- [ ] **Step 2: RED。**

```powershell
mvn -Dtest=AgentApplicationToolsTest,AgentProjectToolsTest,AgentTaskServiceTest test
```

预期新 Module 缺失/工具名拒绝/当前失败收尾直接释放等行为失败；记录具体断言。

- [ ] **Step 3: 实现四 action 的最小路径和有界结果。** action校验用允许列表，拒绝额外字段和 action 不匹配的参数。

```java
// AgentProjectTools 中替代按整个名字判副作用；未知/缺 action 在登记后的校验中固定拒绝。
private static boolean isSideEffect(AgentContracts.ToolRequest request) {
    return "write_file".equals(request.name()) || "build".equals(request.name())
        || ("application".equals(request.name())
            && java.util.Set.of("start", "stop").contains(request.args().path("action").asText("")));
}
```

start 使用 row.workspaceOperationId 及 row.expectedRevision 调用 startForAgent；先查原runId，已存在只核对它的project/requestedRevision与持久row一致并返回，即使当前项目后来已是新revision也不拒绝原结果。仅原Run不存在且首次创建时匹配当前保存版本；4 次限制在登记新 start 的持久临界区按 task 查询，重放不计数。status/stop 按 waitSeconds 在锁外最多每2秒读一次现有Run，立即终态即返回；stop返回不作ready猜测。logs 读取本项目确切runId的窗口，tail截断保留UTF-8边界。application data不含policy/env/Job/Pod/namespace。

为网络/等待调用复用已有 claim：新调用只允许一个执行线程，重放查既有状态；`GET call` 不重新发送控制命令。status/logs 可以在已有 Run 正常启动/停止期间读。所有结果均经过现有 192KiB JSON gate；日志限额之后还要计入 JSON 转义开销。

- [ ] **Step 4: 把终态与 close 改为三段收尾，补并发失败测试。**

```text
1. gate 内：持久 closing / terminal intent；禁止新副作用；保留原 failureCode。
2. gate 外：worker stop（失败/close）、已有 build/file 收尾、本任务 Run stop 与 bounded wait。
3. gate 内：重读全部 application/start 与 stop、未决calls/live claims，复核无新执行；CAS终态。
```

保留现有build收尾的create/close原子约束；不要把等待塞进原 `synchronized(tasks)`。FAILED terminal 复用同一路径，不能直接 tasks.applyTerminal(FAILED)。原terminal report已由appendProgress持久保存；在同一短临界区登记closing后拒绝追加进度，收尾从这条持久terminal读取目标FAILED/原failureCode/summary，不另加intent列，也不只存在方法局部变量中。owner close没有terminal report时使用AI_CLOSED。applicationCalls 查询全部相关行，包含已COMPLETED的start，不只unsettled或最近progress；start最多4个，stop同属60次总工具预算。原应用未被工具触碰则不自动停。正常COMPLETED只允许ready稳定应用保留；STARTING/STOPPING/RECOVERING/未决调用保留NEEDS_ATTENTION。close重试只观察和停止原身份，不start。

必须覆盖：stop10秒后仍STOPPING→工具已结算、status仍可读、write/build拒绝；日志缺口/截断；异项目Run拒绝；start同call并发只有一次；同ID异参409；close等待时RunObservation能取得gate并结算；FAILED停已COMPLETED start创建的Run；迟到terminal不能越过closing；创建中/HTTP中/停止未确认均不能先释放；未触碰原应用且provider失败→原应用保留；COMPLETED后ready Run保留。

- [ ] **Step 5: GREEN 与提交。**

```powershell
mvn -Dtest=AgentTaskStoreTest,AgentApplicationToolsTest,AgentProjectToolsTest,AgentTaskServiceTest,RunControllerTest,RunObservationServiceTest,RunRecoveryServiceTest,RunLogIngestorTest test
git diff --check
git add poc4/backend/src/main/java/com/manao/poc4/ai/AgentApplicationTools.java poc4/backend/src/main/java/com/manao/poc4/ai/AgentProjectTools.java poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskStore.java poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskService.java poc4/backend/src/main/java/com/manao/poc4/config/AiConfig.java poc4/backend/src/test/java/com/manao/poc4/ai/AgentApplicationToolsTest.java poc4/backend/src/test/java/com/manao/poc4/ai/AgentProjectToolsTest.java poc4/backend/src/test/java/com/manao/poc4/ai/AgentTaskServiceTest.java
git commit -m "feat(ai): connect application control and persisted feedback"
```

交付：通过后端真实Run/ledger可验证应用停启/日志；收尾不会死锁、漏停或误停原应用。此时模型工具尚在Task4启用。

## Task 3: 只向当前 Run 的主应用端口发送有界 GET

**Files:**
- Create: `poc4/backend/src/main/java/com/manao/poc4/ai/ProjectApplicationProbe.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentContracts.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentApplicationTools.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentProjectTools.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/AiConfig.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/ProjectApplicationProbeTest.java`（新）
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentApplicationToolsTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentProjectToolsTest.java`

**Interfaces:**
- Consumes: owner/task鉴权后的 RunRecord、ProjectRuntimeStore.loadSpec、现有项目Service及selector身份。
- Produces: `ProjectApplicationProbe.get(RunRecord,String)->AppHttpGetData`，字段完整见spec §5；不接受用户URI或自定义headers。

- [ ] **Step 1: 用真实本地 HTTP server + Fabric8 mock 写失败测试。** 在新测试类中使用现有 Fabric8 mock 测试模式。将已归属的 Service.clusterIP 设置为 loopback、对应 servicePort 设置为本地 server 随机端口；这是测试 Adapter 的数据，不新增生产test-mode开关。用生产 get Interface 观察到达请求次数与结果，不只测 URI 字符串。

```java
// 本地HTTP fixture：测试类中原样建立/关闭；test handler可按场景替换。
var hits = new java.util.concurrent.atomic.AtomicInteger();
var server = com.sun.net.httpserver.HttpServer.create(
    new java.net.InetSocketAddress("127.0.0.1", 0), 0);
server.createContext("/api/demo", exchange -> {
    hits.incrementAndGet();
    byte[] bytes = "{\"message\":\"Hello Pi\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "application/json");
    exchange.sendResponseHeaders(200, bytes.length);
    try (var out = exchange.getResponseBody()) { out.write(bytes); }
});
server.start();
// try/finally server.stop(0)；所有请求通过ProjectApplicationProbe.get。
```

测试需提供真实字段的 RunRecord（RUNNING、firstReadyAt和executionPodUid）及拥有正确labels/selector/primary servicePort的Service。复用 `poc4/backend/src/test/java/com/manao/poc4/kubernetes/PublicEndpointGatewayTest.java` 的项目Service样例，不手写不同命名契约。

覆盖矩阵：正常200/实际500；非ready/历史Run/跨项目/路由到旧Pod/无ClusterIP/ExternalName/端口不匹配→hits=0；绝对URL、`//host`、反斜线、控制符、fragment→hits=0；合法query原样到达；302指向第二个server→第二server hits=0；64KiB+1与分块无限体截断；响应头后慢body仍在10s预算内结束；reset不伪造status200；前后Run变化返回AI_APP_RUN_CHANGED。

- [ ] **Step 2: RED。**

```powershell
mvn -Dtest=ProjectApplicationProbeTest,AgentApplicationToolsTest,AgentProjectToolsTest test
```

预期 Module/record尚不存在或新的app_http_get未被接受。超时测试使用可注入的更短Duration构造值，生产值固定3s/10s，不让模型指定。

- [ ] **Step 3: 实现最小HTTP Module并接入原ledger。**

```java
// AgentContracts 的嵌套record，与spec逐字段一致。
public record AppHttpGetData(String kind, String runId, String path,
    Integer statusCode, String contentType, String body, boolean truncated,
    ToolError error) { }
public record ToolError(String code, String message) { }
```

当前AgentContracts没有ToolError，此处新增一次。ProjectApplicationProbe注入KubernetesClient、namespace、ProjectRuntimeStore与HttpClient；使用现有Service命名/labels常量。先查Run事实与selector一致，再仅取主应用service port和ClusterIP构造http origin；解析/规范化相对path后复核origin不变。JDK client固定Redirect.NEVER，不传任何凭据。不改变PublicEndpointGateway接口或创建第二个应用Service。

```java
var client = java.net.http.HttpClient.newBuilder()
    .connectTimeout(java.time.Duration.ofSeconds(3))
    .followRedirects(java.net.http.HttpClient.Redirect.NEVER)
    .build();
```

在ProjectApplicationProbe内部实现一个private有界BodySubscriber，用sendAsync及同一个10s completion deadline；读取到65537字节立即cancel subscription，只保留65536字节的有效UTF-8前缀，deadline触发时cancel future/subscription。不要另建顶级transport/线程池Module，也禁止先BodyHandlers.ofString再substring。异常只映射spec固定错误。真实3xx/4xx/5xx返回原status/body；网络错误无确定HTTP响应时statusCode=null。

AgentApplicationTools在请求前后核对同Run仍active；app_http_get的同toolCall先claim后仅发送一次，已结算返回缓存，进程异常后的未决请求不重发。browser投影只保留spec字段。URI、ClusterIP、namespace、PodUID只在后端诊断，不入返回JSON。

- [ ] **Step 4: GREEN 并核对工具结果大小。** 除上面矩阵，再测JSON转义膨胀、中文截断不生成破损字符、status/body/error安全投影及未结算请求阻止terminal释放。

```powershell
mvn -Dtest=ProjectApplicationProbeTest,AgentApplicationToolsTest,AgentProjectToolsTest,AgentTaskServiceTest test
git diff --check
```

- [ ] **Step 5: 审查并提交。**

```powershell
git add poc4/backend/src/main/java/com/manao/poc4/ai/ProjectApplicationProbe.java poc4/backend/src/main/java/com/manao/poc4/ai/AgentContracts.java poc4/backend/src/main/java/com/manao/poc4/ai/AgentApplicationTools.java poc4/backend/src/main/java/com/manao/poc4/ai/AgentProjectTools.java poc4/backend/src/main/java/com/manao/poc4/config/AiConfig.java poc4/backend/src/test/java/com/manao/poc4/ai/ProjectApplicationProbeTest.java poc4/backend/src/test/java/com/manao/poc4/ai/AgentApplicationToolsTest.java poc4/backend/src/test/java/com/manao/poc4/ai/AgentProjectToolsTest.java
git commit -m "feat(ai): probe the verified project application over bounded HTTP"
```

交付：实际网络请求可以读取同Run响应；无模型任意网络入口，不需通用HTTP代理或新网络策略引擎。

## Task 4: Pi 六工具接入与浏览器真实结果展示

**Files:**
- Modify: `poc4/pi-worker/src/project-tools.ts`、`poc4/pi-worker/src/pi-session.ts`、`poc4/pi-worker/package.json`（仅描述）
- Test: `poc4/pi-worker/test/project-tools.test.ts`、`poc4/pi-worker/test/pi-session.test.ts`
- Modify: `poc4/frontend/src/features/ai/agentTaskPreconditions.ts`、`poc4/frontend/src/features/ai/AgentTaskPanel.tsx`
- Modify: `poc4/frontend/src/contracts/agentTask.ts`
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.tsx`、`poc4/frontend/src/components/runs/RunPanel.tsx`
- Test: `poc4/frontend/src/features/ai/agentTaskPreconditions.test.ts`、`poc4/frontend/src/features/ai/AgentTaskPanel.test.tsx`
- Test: `poc4/frontend/src/components/shell/WorkbenchShell.test.tsx`、`poc4/frontend/src/components/runs/RunPanel.test.tsx`
- 解析覆盖放到现有AgentTaskPanel测试中，不为机械解析另建重复测试层。

**Interfaces:**
- Consumes: 原 ToolRequest/ToolResult route、spec §5 两工具schema/data、owner工具详情查询、既有Run summary/query/coordinator。
- Produces: `TOOL_NAMES=['list_files','read_file','write_file','build','application','app_http_get']`；browser显示application/HTTP结果，TaskSnapshot不变。

- [ ] **Step 1: worker与UI失败测试。**

```typescript
// project-tools.test.ts：直接沿用本类backendStub，不另写SDK适配层。
it('registers the six mediated sequential tools', () => {
  const backend = backendStub();
  const tools = createProjectTools({ backend: backend as never, taskId: 'task-1', getRevision: () => '7' });
  expect(tools.map(tool => tool.name)).toEqual([
    'list_files', 'read_file', 'write_file', 'build', 'application', 'app_http_get',
  ]);
  expect(tools.every(tool => tool.executionMode === 'sequential')).toBe(true);
});
```

UI更新旧RUN_ACTIVE拒绝测试：已保存、已知revision、无pending/重载/其他task、Run authority已知时可以提交。新增：task占用时普通start/stop禁用但日志可查看；taskCOMPLETED且Run仍active→仍只读；收到应用/HTTP工具结果显示实际ID/status/error/truncated而非只显示模型文字。沿用已有revision-cache回归，不能删掉useWorkspaceRevision。

- [ ] **Step 2: RED。** 分别在 `poc4/pi-worker`、`poc4/frontend`：

```powershell
pnpm test
```

预期四工具数量、RUN_ACTIVE gating和新结果展示断言失败；保留既有测试的其他保护。

- [ ] **Step 3: 实现TypeBox union和既有backend.invoke转发。**

```typescript
const applicationArgs = Type.Union([
  Type.Object({ action: Type.Literal('start') }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('status'), runId: Type.Optional(Type.String()),
    waitSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('stop'), runId: Type.String(),
    waitSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('logs'), runId: Type.String() }, { additionalProperties: false }),
]);
const appHttpGetArgs = Type.Object({
  runId: Type.String(), path: Type.String({ maxLength: 2048 }),
}, { additionalProperties: false });
```

在createProjectTools的同一个return数组中加入以下ToolDefinition，复用invoke闭包（仍注入worker跟踪的revision、toolCallId）：

```typescript
{
  name: 'application', label: 'Control project application',
  description: 'Starts, stops or observes this project application and reads its persisted log tail. Stop must be confirmed before editing or building.',
  parameters: applicationArgs, executionMode: 'sequential',
  async execute(toolCallId, params: Static<typeof applicationArgs>, signal) {
    return await invoke(toolCallId, 'application', params, signal);
  },
},
{
  name: 'app_http_get', label: 'Check project HTTP endpoint',
  description: 'GET a relative path on the current ready project application. Returns the real HTTP status and bounded body; no arbitrary network target.',
  parameters: appHttpGetArgs, executionMode: 'sequential',
  async execute(toolCallId, params: Static<typeof appHttpGetArgs>, signal) {
    return await invoke(toolCallId, 'app_http_get', params, signal);
  },
},
```

TypeBox实际写法以锁定1.3.27分发物和tsc为准，不改SDK版本。新增application/start上限必须以后端持久检查为权威，worker可提前提示但不是唯一限制。

SYSTEM_PROMPT更新为六工具能力和完成证据，说明start accepted不等于ready、stop等待确认、当前应用GET、终态保留ready应用、源码和build与Run互斥；不能写死“先读A文件再写B类”的流程。不启用builtin bash/read/write、不加载项目扩展/MCP/Skills、不加新的模型包。

- [ ] **Step 4: 实现UI最小展示。**

把buildToolCallId收敛为接受build/application/app_http_get的tool_end解析，仍用既有 `GET agent-tasks/{taskId}/tools/{toolCallId}`。结果按kind分支：build保留原view；application显示ID/state/revision/readiness/stoppedConfirmed/log tail；HTTP显示path/status/body/error/truncated。RunPanel的selectedRunId目前是内部状态，在shell中添加requestRunSelection `{runId,seq}`，AgentTaskPanel通过 `onViewRun(runId)` 增加seq并切到run面板，RunPanel用该输入触发现有onSelect；不全局改变历史选择策略。复用RunLogTransport和project已配置公开入口。所有body/log用React文本/pre渲染，不使用dangerouslySetInnerHTML。

移除AI precondition的RUN_ACTIVE拒绝，不移除dirty/pending/revision/Run authority unknown/reload保护。shell的写锁必须取AI与Run两种权威的并集；Agent结束后的workspace reload不因active Run卡成可写或无限reload。切换project/task时取消或忽略旧工具请求结果，避免旧call覆盖新页面。代码基线 `b2c6ec3` 中的前端 revision 修复须完整保留。

- [ ] **Step 5: 定向 GREEN、构建并提交本轮 hunks。**

```powershell
# poc4/pi-worker
pnpm test
pnpm build
# poc4/frontend
pnpm exec vitest run src/features/ai src/components/shell/WorkbenchShell.test.tsx src/components/runs/RunPanel.test.tsx src/features/files/fileQueries.test.ts src/features/runs/workspaceReload.test.ts
pnpm typecheck
pnpm build
git diff --check
```

原 revision 修复已在代码基线 `b2c6ec3` 中；本任务仅提交基于它新增的第二阶段改动。若实施时存在额外未提交修改，用 `git add -p` 区分本任务范围，不混入他人改动。提交消息：`feat(ai): expose application feedback in Pi and the workbench`。

交付：浏览器从正在运行的项目启动Agent，模型实际调用六工具，用户可以查看真实Run/日志/HTTP结果；没有新看板或传输协议。

## Task 5: 一条真实 HTTP 失败修复验收与交付证据

**Files:**
- Create: `poc4/frontend/tests/fixtures/ai-stage2/DemoController.java`
- Create: `poc4/frontend/tests/fixtures/ai-stage2/DemoControllerAcceptanceTest.java`
- Create: `poc4/frontend/scripts/ai-stage2-bootstrap.mjs`
- Create: `poc4/frontend/scripts/ai-stage2-verify-ledger.mjs`
- Create: `poc4/frontend/scripts/ai-stage2-verify-ledger.test.mjs`
- Create: `poc4/frontend/playwright.ai-stage2.config.ts`、`tests/e2e/ai-stage2.spec.ts`
- Modify: `poc4/frontend/package.json`、`tsconfig.stage6.json`、`.gitattributes`
- Create: `poc4/deploy/ai-stage2/README.md`、`poc4/docs/evidence/ai-stage2/acceptance.md`
- Modify: `AGENTS.md`、`docs/what-we-have-done.md`（本任务记录实施后真实状态）

**Interfaces:**
- Consumes: 已实现六工具、浏览器工作台、现有Stage1 bootstrap/login与disposable cleanup模式；固定public endpoint由项目配置取得。
- Produces: `pnpm test:e2e:ai-stage2`；`node scripts/ai-stage2-verify-ledger.mjs --task-id <uuid>`（环境提供operator只读DB配置）；唯一阶段结论`PI_STAGE2_APPLICATION_FEEDBACK_PASS`及未执行登记。

- [ ] **Step 1: 写确定可重现的HTTP错误fixture和独立判定RED。**

```java
package com.example.app;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class DemoController {
    @GetMapping("/api/demo")
    public Map<String, String> demo(@RequestParam(name = "name", defaultValue = "guest") String name) {
        if ("Pi".equals(name)) {
            throw new IllegalStateException("stage2-seeded-handler-failure");
        }
        return Map.of("message", "Hello " + name);
    }
}
```

```java
package com.example.app;

import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;

class DemoControllerAcceptanceTest {
    @Test void keepsTheGuestContract() {
        assertEquals("Hello guest", new DemoController().demo("guest").get("message"));
    }
}
```

该fixture Maven测试通过，health可ready，指定HTTP请求必定500；不植入编译错误，不依赖MySQL。记录DemoControllerAcceptanceTest.java的testFixtureSha256并要求最终测试未删改，独立GET验证Pi参数分支，防止只改测试；DemoController.java本身允许Pi修改。可以复用Stage1受控pom，不复制出又一份Maven工具链。

ledger判定器先在离线fixture rows测试：完整链→PASS；缺少旧Run退出证据、构建非0/未真实执行测试、首次HTTP非500、日志缺标记、跨项目Run、R1/R2相同、写与Run区间重叠、未知结果、最终HTTPbody不符→FAIL。fixture row是判定器单测，不算真实模型证据。

- [ ] **Step 2: 执行RED并验证fixture性质。**

```powershell
# poc4/frontend
node --test scripts/ai-stage2-verify-ledger.test.mjs
pnpm typecheck:stage6
```

在独立Linux runner容器按Stage1 read-only-copy路径运行seeded fixture：Maven test真实exit0且Surefire tests>=1/failures=errors=skipped=0；启动Spring后`/api/demo?name=Pi`真实500和日志标记；未修复的独立HTTP验收FAIL。使用任务唯一临时容器/目录，记录清理结果。

- [ ] **Step 3: 完成bootstrap、browser scene和operator判定。**

bootstrap用唯一creationKey创建无DB/Redis的Spring Boot专用项目，要求操作者显式提供可用30000–31000端口，冲突直接失败；通过既有receipt写fixture，启动R0并等ready，输出projectId/revision/R0/testFixtureSha256。不能自动改平台AI projectId，发布README给出需更新的具体配置与回滚方式。

浏览器通过AI面板提交以下任务，保存taskId；该文本只固定验收顺序，不给修复代码：

> 先停止当前应用并确认退出。在不改源码的情况下执行现有测试并创建一次新 Run，实际 GET /api/demo?name=Pi，记录第一次 HTTP 结果及对应应用日志。然后修复这个接口，使同一请求返回 HTTP 200 和 JSON message="Hello Pi"；保留 guest 行为和现有验收测试。需要改代码或构建时先停应用并确认退出，测试通过后创建新 Run 再实际验证。完成后保持最终应用运行，报告修改路径、测试、Run 和 HTTP 结果。

断言R0终态→首次build(test)0→R1最新revision→HTTP500+该Run日志标记→R1终态→receipted写→build(test)0+Surefire→R2(不同ID)→HTTP200预期JSON。任何源码写入/开发build的执行区间都不得与activeRun区间重叠。开始和后续HTTP关联的Run/task/project逐一核对；不从Pi文字推断。独立operator SELECT ledger+run+workspace_operation；HTTP由验收进程对公开端口另发GET并与最新Run路由核对。

operator读取明确沿用现有 `scripts/ai-stage1-verify-ledger.mjs` 的mysql CLI传输和batch cell反转义规则，不加mysql2/数据库依赖/通用Adapter。配置继续用 `MANAO_AI_VERIFY_MYSQL_CMD`、`MANAO_AI_VERIFY_DB_HOST/PORT/NAME/USER/PASSWORD`，本脚本只支持env密码模式（子进程MYSQL_PWD），不接受密码argv、不输出原stderr。`--task-id`必须canonical UUID，projectId来自 `MANAO_AI_ACCEPTANCE_PROJECT_ID` 并同样校验；所有SELECT显式限定task/project，仅打印脱敏判定JSON。直接spawn无shell；只复制该小段稳定传输及cell解析，不顺带重构Stage1脚本。单测注入行数据到导出的纯 `verifyStage2Ledger` 判定函数，不需要任何真实密码。

当前工具 ledger 的 created_at/updated_at、Run.created_at/finished_at 与文件receipt用于证明顺序；若时间戳相同或证据不足以确定必要先后，判定FAIL/证据不足，不按随机ID排序猜测。无需新事件表；并发安全由Tasks1–3测试证明。浏览器重载只核对同一task继续，服务重启续跑不在本阶段。

- [ ] **Step 4: 浏览器生命周期与清理断言。**

COMPLETED后R2仍active且HTTP可访问、编辑器显示新代码但保持Run只读；通过正常stop确认结束后编辑可用。复核revision-cache修复后的实际点击路径，补到第二阶段记录，不改写第一阶段历史PASS。任务失败/close单独一项定向浏览器/后端场景证明只停任务Run且不漏资源，不扩展完整故障矩阵。

真实场景在对应部署/模型/集群授权到位后运行；当前实现轮只完成代码、必要本地验证、可审阅发布清单与NOT_RUN登记。已保留的模型Secret不等于第二阶段发布授权。README按现有cloud部署方式列backend/worker/frontend digest更新、单实例无重叠顺序、AI专用projectId、目标namespace/上下文前置与回滚；没有migration或runner源码改动就不增migration/重建runner。

资源清理仅针对本轮专用项目，先stop后通过owner删除并核对Job/Pod/Service/PVC、实际由本轮创建且关联该项目的NetworkPolicy与关联DB行。第二阶段没有新增共用policy，不删除第一阶段的共用开发egress策略。项目删除只有在该验收授权包含清理时执行；未授权时保留明确project/run清单并记RETAINED，不主动删除既有资源。

- [ ] **Step 5: 完成必要验证和提交证据。**

```powershell
# poc4/backend：整合后的必要回归，仅一次。
mvn -Dtest=AgentTaskStoreTest,AgentProjectToolsTest,AgentApplicationToolsTest,ProjectApplicationProbeTest,AgentTaskServiceTest,AgentInternalSecurityTest,RunControllerTest,RunObservationServiceTest,RunRecoveryServiceTest,RunLogIngestorTest test
# poc4/pi-worker
pnpm test
pnpm build
# poc4/frontend
node --test scripts/ai-stage2-verify-ledger.test.mjs
pnpm test
pnpm typecheck
pnpm typecheck:stage6
pnpm build
# 以下只在真实验收授权与条件齐备后运行。
pnpm test:e2e:ai-stage2
node scripts/ai-stage2-verify-ledger.mjs --task-id <本轮实际taskId>
```

`AgentInternalSecurityTest` 是当前内部鉴权测试的真实类名；所有测试核对执行数、失败数和实际报告，0 tests不能算通过。

`.gitattributes`追加`poc4/frontend/tests/fixtures/ai-stage2/** text=auto eol=lf`。记录implementation/tests/build、real model、cluster rollout、browser、independent ledger+HTTP、cleanup各自结果；缺项逐项NOT_RUN。只有真实全链证据授予`PI_STAGE2_APPLICATION_FEEDBACK_PASS`；不授予CRUD/MySQL/完整首版/用户业务验收。

```powershell
git diff --check
git status --short
```

精确暂存本任务新增文件及本轮hunks，审查后提交：`test(ai): verify application feedback and repair loop`。不自动merge、push、部署；删除本轮不需要的临时文件，保留最小必要失败证据。

## 3. 完成判定与自检记录（2026-10-16）

这是规划自检结果，不是实现测试结果。

| Spec要求 | 任务与验证落点 |
| --- | --- |
| 有旧Run时接任务；停确认后写/构建；最新revision新Run | Task1 admission/互斥/stable Run + Task2异步stop + Task5时序ledger |
| 状态/ready/日志/HTTP真实反馈；失败后新Run | Task2日志与状态 + Task3 probe + Task5 R0/R1/R2独立验收 |
| 丢响应不二次Run；close/FAILED不漏停/误停/死锁 | Task1身份/并发测试 + Task2三段收尾/已完成start枚举 |
| 项目限定、内部鉴权、端口/寿命不变、有界IO | Task1授权 + Task3真实IO回归 + Task5安全回归与部署清单 |
| 浏览器可启动/只读/真实结果/已有revision修复 | Task4 + Task5真实点击路径，TaskSnapshot不新增字段 |
| 阶段范围与诚实证据 | 五任务无SQL/CRUD/暂停恢复；Task5逐项状态，真实PASS单独授予 |

过度工程化专项结论：

- 工具从9个独立动作收敛成总共6个（新增2个）；HTTP限GET，日志限tail，不做写请求、分页或新stream。
- 新生产Module仅AgentApplicationTools和ProjectApplicationProbe；没有为Run/日志再包空壳Interface/Adapter，没有通用registry。
- 数据继续使用两张Agent表与原Run/log；没有新migration、映射表、事件表或外部队列。
- start身份/互斥/收尾不是预备框架：现有随机RunId、active admission、build无active检查、close持锁等待和FAILED直接释放均有实际代码依据。
- 仅为新增应用路径补claim和收尾，保留现有Run状态机/Job/Service/日志实现；不做全仓重构。
- 验收只一条Demo HTTP修复主链和直接相关失败/close定向覆盖，不提前做书籍CRUD/MySQL、两小时重跑或全故障矩阵。
- URL校验用标准parser与最终origin比较，删去无本阶段收益的多轮编码规范化要求；不建设HTTP代理或URL策略引擎。

已自查 spec覆盖、占位符、跨任务Interface/类型/工具名/错误码一致性；没有待产品选择项。真实模型、集群、发布和清理属于后续实施/验收条件，本轮未运行。计划编写完成不等于第二阶段实现授权。
