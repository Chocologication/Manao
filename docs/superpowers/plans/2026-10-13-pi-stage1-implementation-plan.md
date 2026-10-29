# Pi Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` task-by-task. Steps use checkbox (`- [ ]`) syntax. 先重新读取当前检出的 AGENTS.md；相关任务顺序执行，只读研究／独立审查可以并行。

**Goal:** 浏览器向 Pi 下达 Spring Boot 修改目标，Pi 通过真实项目文件工具和 Maven 构建测试结果完成修改与失败修复。

**Architecture:** 新增一个 Node Pi worker；现有后端增加任务控制和项目工具，复用文件 receipt、现有数据库、Java runner 和项目缓存。源码由文件工具直接修改；固定 Maven goal 在只读源码复制出的临时目录构建，不回写，不引入自由 Shell 源码事务。

**Tech Stack:** Java 17 / Spring Boot 3.5.9 / Fabric8 7.7.0 / MySQL 8；React 19 / TypeScript / pnpm 10.33.0；Node >=22.19.0 / `@earendil-works/pi-coding-agent@1.2.0`；JUnit、Vitest、Linux 容器、Playwright。

**Spec:** [Pi 第一阶段设计](../specs/2026-10-13-pi-stage1-design.md)。[完整目标与已确认决定](../../research/2026-10-13-ai-integration-framework-evaluation.md#10-最小集成设计的已确认决定2026-10-13)。

**Status:** 2026-10-13 编制、2026-10-14 自审修订。Tasks 1–5 已实现并测试通过（`codex/ai-integration`，提交 `1f2298e`…`d0952b4`）；Task 6 已交付验收 fixture/harness、bootstrap 脚本、发布准备与[实施记录](../../../poc4/docs/evidence/ai-stage1/acceptance.md)（提交 `test(ai): verify stage-one coding and repair loop`）。2026-10-15 最终整分支审查（`ef852b7..8898c95`）判定 Needs fixes，其全部发现（1 Critical + 10 Important + 1 Minor，逐字记录于 `.superpowers/sdd/2026-10-13-pi-stage1-implementation-plan/final-review-findings.md`）已修复并提交，修复证据见同目录 `final-review-fix-report.md`。本轮已验证：frontend 1370/1370 + typecheck、worker 27/27、后端 AI 定向套件（store/tools/executor/service/security/factory）全绿、Docker Maven fixture 独立复验（错误→修复→Surefire XML）、组件演练（disposable MySQL + V11/V12 + 缺模型 key 时 worker 503 拒启/后端显式 FAILED）。真实模型闭环、浏览器 E2E、云端 rollout 与 CNI enforcement 均 NOT_RUN（缺失条件见实施记录第 5 节）；`PI_STAGE1_CODE_TEST_LOOP_PASS` NOT_GRANTED。

**Base:** `.worktree/ai-integration` / `codex/ai-integration`，代码基线 `ef852b7`。当前规划文件及索引可能未提交，实施前保留并记录最新 HEAD。下文 Files 路径相对于该工作树，不使用主 checkout 实施。

## Global Constraints

- 第一阶段仅“Pi 理解目标 → 读改代码 → Maven 构建测试 → 依据结果修复”；不实现第二阶段 Run 自动停启／HTTP、第三阶段 CRUD／数据库验证、第四阶段暂停接管／手动续跑。
- 专用验收项目没有重要既有数据；后端显式启用该 projectId，项目数据库全自动规则不扩展到平台或其他项目。阶段 1 构建不需要数据库凭据。
- Agent 直接修改真实项目，任务期间独占写入。源码构建 scratch 只用于执行构建、从不回写；不改为任务副本合并模式。
- 文件工具 `list_files/read_file/write_file`，构建工具 `build` 只接受 `compile|test|package`；没有 delete/rename/free-shell/Run/SQL 工具。不开放未实现的高风险操作，不新增审批平台。
- 第一次真实写入就有持久 taskId、项目占用、稳定 toolCallId/operationId、结果核对；模糊副作用不盲目重放。
- 单后端与单 worker，发布／更新不重叠执行；没有自动 requeue、自动续跑或分布式租约框架。浏览器断开不停止任务，服务异常保留占用并核对收尾。
- task 1800 秒、build 600 秒、收尾 120 秒、最多 60 次工具调用／8 次构建；文件工具 128 KiB，构建日志 128 KiB，复制源码 1000 文件／20 MiB。日志截断与未知退出结果必须显式显示。
- Pi SDK 固定 1.2.0（参考快照 `7d75a0e3`），Node >=22.19.0，pnpm 10.33.0；首次安装验证实际分发物，不能静默升级／回退。Manao 用户 Go/TS 适配仍跳过。
- 模型密钥／会话只在 worker；用户代码只在开发 Job 中运行；不加载用户项目扩展，不把工作区、平台目录、DB/集群凭据挂到 worker。
- 开发 Job 不挂平台权限；实际验证项目限定、执行网络和源码只读，不以提示词、cwd 或 YAML 存在替代隔离证据。
- 后端真实数据库测试只使用 disposable schema，复用 `JdbcStoreTestSupport`，禁止重置 `manao_poc4` 或 `manao_poc4_6b`。
- 行为改动先失败测试再最小实现；文档与机械转发不堆重复测试。每任务定向验证和 `git diff --check`，通过后聚焦提交，保留 unrelated changes。
- 前端／worker 用 pnpm，禁止 npm；生成文件 UTF-8 无 BOM，shell/Docker 入口 LF，遵守 `.gitattributes`。Python 依赖规则沿用 uv，不在本阶段修改 Python 工具链。

## 1. 固定 Interface 与文件布局

以下 Interface 名称与状态是跨任务契约；内部私有方法可按实际代码收敛，不能另起一套 task/workflow 抽象。

```java
// com.manao.poc4.ai.AgentContracts，嵌套 records/enums
enum TaskState { QUEUED, RUNNING, COMPLETED, FAILED, NEEDS_ATTENTION }
enum CallState { REGISTERED, RUNNING, COMPLETED, NEEDS_ATTENTION }
enum BuildGoal { COMPILE, TEST, PACKAGE }
record TaskRequest(String taskId, String prompt, long expectedRevision) {}
record TaskSnapshot(String taskId, TaskState state, String workspaceRevision,
                    boolean writesLocked, List<ProgressItem> progress,
                    List<String> changedPaths, String summary, String failureCode) {}
record ProgressItem(long seq, String kind, String text, boolean truncated) {}
record ToolRequest(String toolCallId, String name, long expectedRevision, JsonNode args) {}
record ToolResult(String toolCallId, String workspaceRevision, JsonNode data, boolean truncated) {}
record BuildRequest(String taskId, String toolCallId, String projectId,
                    String commandId, long sourceRevision, BuildGoal goal) {}
record BuildIdentity(String jobName, String jobUid, String podUid) {}
record TestReport(String testClass, int tests, int failures, int errors, int skipped,
                  String sha256) {}
record BuildResult(BuildIdentity identity, Integer exitCode, String terminationReason,
                   String output, boolean truncated, List<TestReport> testReports,
                   boolean cleanupConfirmed) {}
```

`JsonNode` 来自 Jackson，`List` 来自 java.util。所有浏览器 DTO 不包含内部 namespace/Pod/Secret/绝对挂载路径或 token。`BuildResult.identity` 只供后端工具记录／脱敏证据，模型和浏览器只看到命令编号、revision、退出结果和输出。

```java
// 新增具体 JDBC Module，无多实现 registry
AgentTaskStore(JdbcTemplate jdbc, PlatformTransactionManager tx, Clock clock);
TaskSnapshot create(String ownerId, String projectId, TaskRequest request);
Optional<TaskSnapshot> findForOwner(String ownerId, String projectId, String taskId);
Optional<TaskSnapshot> currentForOwner(String ownerId, String projectId);
void requireBrowserWritable(String projectId);
void requireTaskWritable(String taskId, String projectId);

// store 的调用登记／完成方法以 ToolRequest、ToolResult 和稳定 identity 为参数；
// 核心行为：同请求返回既有行，异参 409；具体内部 row record 保持私有。

AgentProjectTools(AgentTaskStore tasks, WorkspaceStore workspace,
                  WorkspaceOperationService files, WorkspaceAgent agent,
                  DevelopmentBuildExecutor builds, ProjectLifecycleGate gate);
ToolResult invoke(String taskId, ToolRequest request);
Optional<ToolResult> getCall(String taskId, String toolCallId);

interface DevelopmentBuildExecutor {
    BuildResult execute(BuildRequest request);
    BuildResult observe(BuildRequest request, BuildIdentity identity);
    BuildResult close(BuildRequest request, BuildIdentity identity);
}

interface PiWorkerClient {
    WorkerStatus start(WorkerStart request);
    WorkerStatus status(String taskId);
    WorkerStatus stop(String taskId);
}
// WorkerStart/Status 在 AgentContracts 定义：taskId、prompt、workspaceRevision、
// requestSha256、workerEpoch；Status 再有 instanceId/state，不携带 project owner。
```

Pi worker 的工具参数与后端 `ToolRequest.args` 一致：

```typescript
type ProjectTools = {
  list_files: { directory: string };
  read_file: { path: string };
  write_file: { path: string; content: string; expectedSha256: string | null };
  build: { goal: 'compile' | 'test' | 'package' };
};
```

文件布局按真正行为分开：`poc4/backend/.../ai` 放任务、工具与构建执行；SDK 专属代码在 `poc4/pi-worker`；不拆 tasks/files/builds 微服务。Fabric8 build 与测试 Adapter 构成真实 Seam，Pi HTTP 与测试 Adapter 构成真实 Seam，其余只有一个 Implementation 的对象不用额外套 interface。

## Task 1: 持久任务占用与生命周期互斥

**Files — Create:**

- `poc4/backend/src/main/resources/db/migration/V11__agent_tasks.sql`
- `poc4/backend/src/main/java/com/manao/poc4/ai/AgentContracts.java`
- `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskStore.java`
- `poc4/backend/src/test/java/com/manao/poc4/ai/AgentTaskStoreTest.java`

**Files — Modify:** `workspace/WorkspaceService.java`、`workspace/PythonDependencyService.java`、`run/RunService.java`、`project/ProjectDeletionRepository.java`、`config/WorkspaceConfig.java`（均在 backend Java package 下）；检查 `recovery/ProjectRecoveryService.java` 和 `CreationEndpointRecoveryService.java` 的状态条件，只有能触达已 READY 任务项目的写路径才加 guard，不改历史 CREATING 恢复流程。

**Consumes:** 现有 project/run/workspace_operation 状态、ProjectLifecycleGate、JdbcTemplate。**Produces:** 两张表、TaskRequest/Snapshot、共享持久写入检查。工具表此时只有结构，由 Task 2/3 使用。

- [x] **1. 写失败测试：** 用现有 disposable schema scaffold，在同一 projectId 上创建两个不同任务，只能第一个取得占用；同 taskId/目标/版本重试返回原任务，异目标拒绝；Run/PENDING/DELETING 拒绝登记。示例测试直接从 store Interface 观察，不断言内部 SQL 字符串：

```java
@Test void oneProjectCannotAcquireTwoTasks() {
    try (var db = JdbcStoreTestSupport.create()) {
        var jdbc = db.jdbc();
        jdbc.update("INSERT INTO app_user(id,username,password_hash) VALUES ('ai-owner','ai-owner','unused')");
        jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision) VALUES ('ai-project','ai-owner','ai-project','READY',7)");
        var store = new AgentTaskStore(jdbc,
            new DataSourceTransactionManager(jdbc.getDataSource()), Clock.systemUTC());
        var first = new TaskRequest(UUID.randomUUID().toString(), "change demo", 7);
        assertThat(store.create("ai-owner", "ai-project", first).writesLocked()).isTrue();
        assertThat(store.create("ai-owner", "ai-project", first).taskId()).isEqualTo(first.taskId());
        var second = new TaskRequest(UUID.randomUUID().toString(), "change again", 7);
        assertThatThrownBy(() -> store.create("ai-owner", "ai-project", second))
            .isInstanceOfSatisfying(ApiException.class,
                ex -> assertThat(ex.code()).isEqualTo("AI_TASK_ACTIVE"));
    }
}
```

导入现有 `JdbcStoreTestSupport`、JUnit、AssertJ、Clock、UUID、DataSourceTransactionManager 与 AgentContracts 嵌套类型；测试自身不依赖 runtime DB schema。

- [x] **2. 运行确认失败：** 在 `poc4/backend` 执行 `mvn -Dtest=AgentTaskStoreTest test`；未实现时应因类／方法缺失失败。数据库不可用属于测试 BLOCKED，不能当作预期 RED。
- [x] **3. 最小实现：** 迁移精确定义 spec 第 3 节字段、主键、外键与 active_project 唯一生成列。占用登记锁 project 行，核对 owner、READY、revision、无 active Run、无 pending。projectId 由鉴权路径获得。taskId UUID、prompt 1–8000 字符；请求摘要固定字段顺序 UTF-8 SHA256。COMPLETED/FAILED 才清 active_project，NEEDS_ATTENTION 保留。
- [x] **4. 接入其他写入口：** 在其现有短 gate 内调用同一个 guard；浏览器文件 mutation、Python 依赖变更／核对、Run.start、删除都拒绝任务占用。任务登记调用方也必须持有同一个共享 ProjectLifecycleGate 再执行 store.create（Task4的AgentTaskService必须遵守），否则guard通过后task可抢占。补“旧保存通过guard但尚未登记PENDING时提交task”的并发回归，禁止两者同时通过。删除判断在 project row lock 内检查，避免先检查再竞态。只读保持可用。适配旧测试构造函数时给测试注入明确的 no-active 查询，不把生产 guard 默认为绕过。
- [x] **5. 定向验证与提交：** 执行 `mvn -Dtest=AgentTaskStoreTest,WorkspaceControllerTest,PythonDependencyOperationTest,RunControllerTest,ProjectCleanupServiceTest test`，补充占用下拒绝/未占用旧路径可用的行为断言。`git diff --check`；提交 `feat(ai): persist stage-one task ownership`。不增加任务 controller 空壳，不启用任何产品任务。

## Task 2: 真实文件工具与同调用去重

**Files — Create:** `ai/AgentProjectTools.java`、`ai/DevelopmentBuildExecutor.java`、`ai/AgentProjectToolsTest.java`（test 在 test package）。Task2先定义上文build Interface以便注入测试Adapter，真实Fabric8实现由Task3提供。**Modify:** `ai/AgentTaskStore.java`、`workspace/WorkspaceOperationService.java`、`workspace/WorkspaceJdbcStore.java`、`persistence/WorkspaceJdbcStoreTest.java`。

**Consumes:** Task 1 持久占用、现有 WorkspaceAgent。**Produces:** list/read/write 三个工具及稳定 workspace operationId；build 分支 Task 3 接入，未接入时不对 worker 暴露。

- [x] **1. 失败测试：** 用 stub WorkspaceAgent 记录 mutate 次数、通过真实 store 登记已占用 task；对同 ToolRequest 连续 invoke 两次，断言只保存一次、revision 7→8、原结果可查询；同 toolCallId 换 content 返回 `AI_CALL_MISMATCH`。再模拟 agent 已写完且 receipt 可取、首次 HTTP 结果丢失，第二次只核对 receipt，不再 mutate。

```java
ToolRequest request = new ToolRequest("call-1", "write_file", 7,
    JSON.readTree("{\"path\":\"src/main/java/com/example/app/DemoController.java\",\"content\":\"new content\",\"expectedSha256\":\"" + beforeSha + "\"}"));
ToolResult first = tools.invoke(taskId, request);
ToolResult repeated = tools.invoke(taskId, request);
assertThat(repeated).isEqualTo(first);
assertThat(first.workspaceRevision()).isEqualTo("8");
verify(agent, times(1)).mutate(eq(projectId), any(WorkspaceAgent.Command.class));
```

该段嵌入 `AgentProjectToolsTest` 的测试方法；在 setUp 中用 Task 1 store seed task、Mockito mock WorkspaceAgent、真实 WorkspaceOperationService、DevelopmentBuildExecutor mock 和共享 gate 构造 tools。beforeSha 为内容 UTF-8 的 SHA256；projectId/taskId 取 seeded project/task；JSON 为 `new ObjectMapper()`。不调用公网模型。

- [x] **2. 运行确认失败：** `mvn -Dtest=AgentProjectToolsTest test`。
- [x] **3. 最小实现：** ToolRequest 摘要覆盖 taskId/name/expectedRevision/规范化 args；在首次执行前写 agent_tool_call 和 operationId；同 ID 先查询旧记录。文件白名单按 spec，检查内容上限、existing sha256 或确认 absent；read/list 用现有接口，不增加文件搜索系统。
- [x] **4. 扩展已有文件 Module：** 增加 `applyAgentSave(projectId, operationId, path, bytes, expectedRevision, expectedSha256)`。同 operationId 已 COMMITTED 时返回原 revision；PENDING 只核对已有 receipt，未登记的首次调用才计算 before/after。新文件 meta 404 显式转换 absent digest，使用现有 workspace-agent SAVE 原子发布与创建父目录能力。普通 `apply` 语义保持，不能偷偷放宽浏览器 SAVE。agent_tool_call 与 workspace_operation 不要求跨网络原子事务；以稳定 ID 链接并核对两端。
- [x] **5. 补齐错误行为：** 旧 sha/revision冲突由 Pi 重读；非法路径/其他项目拒绝。已登记调用确定无副作用的拒绝，持久记 COMPLETED＋`data.error={code,message}`，worker反馈给Pi且允许下一调用；不能把普通冲突留成未决锁。未知 transport 或 receipt 不匹配才转 NEEDS_ATTENTION。工具未结算禁止后续写/build。`getCall` 不执行副作用。FAILED 项目没有通用文件恢复保证，不能仿造成功 receipt 释放占用。
- [x] **6. 验证与提交：** `mvn -Dtest=AgentProjectToolsTest,WorkspaceControllerTest,WorkspaceJdbcStoreTest test`；检查新文件只需一次 revision、重试只一次、正常浏览器旧路径无回归。提交 `feat(ai): expose receipt-backed project file tools`。

## Task 3: 只读源码的真实 Maven 构建工具

**Files — Create:**

- `poc4/maven-runner/manao-dev-build`
- `poc4/maven-runner/tests/development-build.sh`
- backend `ai/Fabric8DevelopmentBuildExecutor.java`（复用Task2定义的DevelopmentBuildExecutor）
- backend tests `ai/DevelopmentBuildExecutorTest.java`、`kubernetes/DevelopmentJobResourceFactoryTest.java`

**Modify:** `poc4/maven-runner/Dockerfile`；backend `kubernetes/JobResourceFactory.java`、`ai/AgentProjectTools.java`、`ai/AgentTaskStore.java`、`workspace/WorkspaceJdbcStore.java`，必要时 `kubernetes/Fabric8KubernetesGateway.java` 的项目清理识别。不修改应用 Run 固定命令／状态机，不建立第三张 command 表。

**Consumes:** build Interface、tool row 稳定 UUID、当前保存版本、既有 Java runner 与 cache。**Produces:** `build` 工具，真实 exitCode/输出、Job/Pod 身份及收尾证明；源码不被构建修改。

- [x] **1. 失败测试：** Fabric8 mock server 验证合法 goal 的 argv、只读/source init 与 scratch-only main、无 SA token；拒绝 `test;rm -rf` 或任意 args；同 commandId 模糊 create 只查询原 Job，不能再创建第二个。Pod UID不匹配和Forbidden不结算。编译 exit1 输出返回 Pi，清理确认后才可再次 write。测试 Job 消失但 Pod 仍存在，cleanupConfirmed 必须 false。

```java
assertThat(job.getSpec().getBackoffLimit()).isZero();
assertThat(job.getSpec().getTemplate().getSpec().getAutomountServiceAccountToken()).isFalse();
var main = job.getSpec().getTemplate().getSpec().getContainers().get(0);
assertThat(main.getVolumeMounts()).extracting(m -> m.getMountPath()).doesNotContain("/source");
assertThat(main.getCommand()).containsExactly("/usr/local/bin/manao-dev-build", "run", "test");
```

`job` 由新 `JobResourceFactory.createDevelopmentJob(BuildRequest)` 产生；构造沿用 `JobResourceFactoryTest` 现有固定 digest/资源样例。

- [x] **2. 运行确认失败：** `mvn -Dtest=DevelopmentBuildExecutorTest,DevelopmentJobResourceFactoryTest test`。
- [x] **3. 实现固定 launcher 与 manifest：** launcher 子命令 `copy` 和 `run <goal>`，copy 排除内部/target/git，拒绝链接和特殊文件；统计文件/字节超限即失败。main 固定运行 `manao-maven -B -ntp <goal>`，保留真实rc，退出前把有界Surefire XML以固定标记附到日志尾部（报告总量64KiB、限目标路径、拒绝链接），再以原rc退出；不能exec替换launcher后失去报告收集。报告缺失/截断明确显示，不抹掉Maven失败。原 Dockerfile COPY/chmod 0555；无 runtime 动态安装。main UID10001、readonly root、临时/tmp、项目cache可写，init 使用同镜像固定复制程序。复制阶段与 main 分离，main 不拿源码挂载。
- [x] **4. 实现 executor：** 登记 tool row 与确定 Job 名后 ensure/query，绑定真实 Job/Pod UID；读取上限输出、尾部报告标记和真实termination，报告XML禁DTD/外部实体后生成TestReport摘要，保留未知；不能依赖exec已终止容器取文件。等待收尾不能持 project DB事务或长线程 gate。收日志/报告后删除，确认 Job及关联Pods全部404才结束。build 不推进workspace revision。close/timeout走同一收尾。工具层在 REGISTERED/RUNNING 时拒绝其他工具副作用。
- [x] **5. 真实容器验证：** 新脚本作为宿主Docker harness，参考现有 `tests/maven-cache.sh`，创建专属source目录与scratch/cache volumes，先copy容器再main容器；同UID10001、readonly-root和tmpfs，main不挂source。先故意失败测试得exit1，再外部更新源码重新copy/run得exit0；通过copy容器的真实ro挂载确认写source失败，main改scratch不影响源码；验证隐藏receipt未复制、symlink被拒绝、Maven cache跨次复用。无需Docker-in-Docker或挂daemon socket到runner。命令：

```powershell
# 在工作树根；先按现有模板导出器生成必须的命名构建上下文
$stage1SeedPath = Join-Path (Get-Location) 'poc4/backend/target/maven-seed-templates'
mvn -q -f poc4/backend/pom.xml -DskipTests test-compile org.codehaus.mojo:exec-maven-plugin:3.5.0:java -Dexec.mainClass=com.manao.poc4.workspace.MavenSeedTemplateExporter -Dexec.classpathScope=test "-Dmanao.seed.output=$stage1SeedPath"
docker build --build-context "seed-templates=$stage1SeedPath" -t manao-pi-stage1-runner:test poc4/maven-runner
# 在有Bash与Docker CLI的Linux/WSL宿主中运行（路径按该宿主checkout解析）
bash poc4/maven-runner/tests/development-build.sh manao-pi-stage1-runner:test poc4/backend/target/maven-seed-templates
```

脚本用每次运行的唯一前缀创建容器/volume/临时目录，退出时按精确名称清理；不能删除共享资源。只读源码行为须通过真实ro挂载验证，不能用chmod或privileged/root写保护试验冒充。容器套件stdout给每项PASS/FAIL和总计，不能跳过核心断言。
- [x] **6. 验证与提交：** Maven 定向测试与容器套件通过；补项目删除时新表数据及开发 Job 的清理（阻止占用期删除、正常结束后可删除）。提交 `feat(ai): add isolated Maven build tool`。不要对现有镜像 digest 填猜测值；本地 tag只用于测试，发布 digest留真实构建记录。

## Task 4: Pi worker 与最小任务 Interface

**Files — Create:**

- `poc4/pi-worker/package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`Dockerfile`、`.env.example`、`README.md`
- `poc4/pi-worker/src/config.ts`、`src/server.ts`、`src/pi-session.ts`、`src/project-tools.ts`、`src/backend-client.ts`
- `poc4/pi-worker/test/pi-session.test.ts`、`test/project-tools.test.ts`、`test/server.test.ts`
- backend `ai/PiWorkerClient.java`、`ai/HttpPiWorkerClient.java`、`ai/AgentTaskService.java`、`ai/AgentTaskController.java`、`ai/AgentInternalController.java`、`config/AiConfig.java`
- backend tests `ai/AgentTaskServiceTest.java`、`ai/AgentInternalSecurityTest.java`

**Modify:** backend `config/SecurityConfig.java`、`config/WorkspaceConfig.java`、配置文件 `application-local-cluster.yml` 与 `application-cluster.yml`；`.gitattributes` 为新 Docker/入口约束 LF。AI 默认关闭，配置用独立 `@ConfigurationProperties("manao.poc4.ai")`，不扩散到现有大型 BackendProperties 构造函数。

**Consumes:** Task1–3 tool/task Interface。**Produces:** 浏览器 task endpoints、内部调用/progress endpoints、worker start/status/stop，真实 SDK loop。

- [x] **1. 失败测试：** 模型 Adapter 返回读→写→build失败→修复写→build成功的 tool calls，SDK 自己运行循环，fake project tool仅提供实际返回。断言注册工具只有四个、同请求重传复用编号、build非零诊断进入下一轮、worker不会调用本机fs/child_process操作用户代码。server同task重复start只启动一次、第二任务409、非幂等progress seq不重复追加；完整消息事件落库而非每token。

```typescript
import { it, expect, vi } from 'vitest';
import { BackendClient } from '../src/backend-client.js';
it('queries the original call after a lost POST response', async () => {
  const done = { toolCallId: 'call-1', workspaceRevision: '8', data: {}, truncated: false };
  const transport = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('response lost'))
    .mockResolvedValueOnce(new Response(JSON.stringify(done), { status: 200 }));
  const client = new BackendClient({ baseUrl: 'http://backend.invalid', token: 'test-only',
    instanceId: 'worker-1', epoch: 'epoch-1', fetch: transport });
  const result = await client.invoke('task-1', { toolCallId: 'call-1', name: 'build',
    expectedRevision: 7, args: { goal: 'test' } });
  expect(result).toEqual(done);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[0][1]?.method).toBe('POST');
  expect(transport.mock.calls[1][1]?.method).toBe('GET');
});
```

`BackendClient` 的构造和invoke签名按测试实现，保留原ToolRequest用于查询，不在客户端另建请求摘要权威；摘要只由后端固定规范计算。再加后端测试：浏览器 JWT 无权访问内部路由；错误 token/epoch 不触发工具；模型 key缺失在启动前明确失败。
- [x] **2. 锁 SDK 依赖并运行 RED：** `pnpm view @earendil-works/pi-coding-agent@1.2.0 version engines --json` 只核对公共分发元数据。使用独立package与pnpm lock，SDK依赖精确1.2.0；测试用现有仓库同系列 TypeScript 5.9.3 / Vitest 3.2.7，不复制Pi仓库npm脚本。`pnpm test`、后端 `mvn -Dtest=AgentTaskServiceTest,AgentInternalSecurityTest test` 应先因未实现行为失败。
- [x] **3. SDK最小装配：**

```typescript
const { session } = await createAgentSession({
  cwd: workerScratch,
  agentDir: privateAgentDir,
  modelRuntime,
  model,
  settingsManager: SettingsManager.inMemory(),
  sessionManager: SessionManager.create(workerScratch, privateSessionDir),
  resourceLoader: controlledResources,
  noTools: 'builtin',
  tools: ['list_files', 'read_file', 'write_file', 'build'],
  customTools,
});
session.agent.toolExecution = 'sequential';
await session.prompt(prompt);
```

这些变量在 `createPiSession` 的配置/依赖参数中定义；controlledResources 实现固定空ResourceLoader或显式禁发现的loader，所有路径是worker私有路径。每 customTool `executionMode:'sequential'`。setRuntimeApiKey 和 provider注册使用本轮Context7及固定快照 `ModelRuntime` API，不套旧AuthStorage/modelRegistry参数。订阅message_end、tool_execution_*及最终settlement；`agent_end`可能willRetry，不能提前结算。服务端HTTP use Node内置http/fetch，避免为3条路由添加框架。
- [x] **4. 任务生命周期：** 在共享gate内创建task及持久epoch后才调用worker。首个正确token/epoch callback或start ACK原子绑定instance并QUEUED→RUNNING，允许callback先于ACK；迟到ACK不得覆盖终态。start响应丢失先GET原task，不能以新ID重试。worker不依赖浏览器请求连接持续运行。工具HTTP响应丢失先GET原call；未确定不调用下一个副作用。`subscribe` listener不被SDK await，进度发送使用worker内promise串行链，终态前drain；progress_json保留lastSeq/lastPayloadSha，同seq同payload幂等、异payload409、缺口返回期望seq。prompt结束还要检查最终assistant stopReason/provider error/aborted/预算及工具终态，不能把正常settle的provider错误记COMPLETED。close先在后端gate内持久NEEDS_ATTENTION/AI_CLOSING并拒绝新调用，再stop worker/收尾Job和file receipt，最后CAS到FAILED/AI_CLOSED释放；迟到终态不能抢先释放。加close与tool-register竞态、回调早于ACK、progress乱序及provider错误正常settle测试。
- [x] **5. 配置与权限：** README列 `MANAO_AI_ENABLED=false`、`MANAO_AI_PROJECT_ID`、worker内部地址/token、`MANAO_AI_PROVIDER`、`MANAO_AI_API_TYPE`、`MANAO_AI_BASE_URL`、`MANAO_AI_MODEL`、`MANAO_AI_API_KEY`、私有会话目录。后端只需要worker路由/token和项目开关，不得到模型key。秘密字段`.env.example`为空，无真实值。内部路由独立token SecurityFilterChain，缺配置关闭；public同现有ownerJWT；限制body和输出，固定safe错误不回传headers/endpoint/secret。
- [x] **6. 验证与提交：** worker `pnpm test`、`pnpm exec tsc --noEmit`、`pnpm build`；后端两个新测试与既有 auth/controller定向回归。真实provider不参与unit tests。提交 `feat(ai): connect Pi to project tools and task lifecycle`。

## Task 5: 最薄浏览器任务入口与实际代码刷新

**Files — Create:**

- `poc4/frontend/src/contracts/agentTask.ts`
- `poc4/frontend/src/api/agentTaskApi.ts`
- `poc4/frontend/src/features/ai/agentTaskQueries.ts`
- `poc4/frontend/src/features/ai/AgentTaskPanel.tsx`
- `poc4/frontend/src/features/ai/AgentTaskPanel.test.tsx`
- `poc4/frontend/src/features/ai/agentTaskPreconditions.ts`、`agentTaskPreconditions.test.ts`

**Modify:** `components/shell/WorkbenchShell.tsx`/test、`components/runs/RunPanel.tsx`/test、`features/editor/runPreconditions.ts`/test、`features/runs/workspaceReload.ts`（只在提取共享名称确有复用价值时改，不为改名重写）；沿用现有httpClient和query作用域。

**Consumes:** 后端TaskSnapshot四条浏览器Interface。**Produces:** 浏览器目标输入、2s轮询进度/结果、任务只读、已保存代码刷新、结束当前任务。没有聊天产品、复杂看板或流式协议。

- [x] **1. 失败测试：** dirty、pending save/依赖、activeRun、未知revision或正在reload时禁止提交；同task启动响应丢失查询原ID；任务占用后禁编辑与Run；断开/切项目不调用close；终态刷新失败仍只读，Retry成功后才编辑。为纯条件函数写表驱动测试：

```typescript
expect(resolveAgentTaskPreconditions({
  dirtyCount: 1, writePending: false, hasActiveRun: false,
  workspaceRevision: '7', taskWritesLocked: false, reloading: false,
})).toEqual({ canStart: false, reason: 'DIRTY_FILES' });
```

该函数返回 `{canStart:boolean, reason:string|null}`，在panel和shell共用，不新造全局状态框架。
- [x] **2. 运行 RED：** `pnpm test -- src/features/ai/agentTaskPreconditions.test.ts src/features/ai/AgentTaskPanel.test.tsx`。
- [x] **3. 最小实现：** AI tab/panel包含textarea、开始、结束任务、状态、完整消息／工具结果、修改路径；开始前UUID持久保存在用户/项目作用域，复用现有pending operation存储风格，不从pathname猜owner。2秒poll GET current/task，浏览器只访问后端同源/api。默认功能关闭时不显示面板。
- [x] **4. 占用与刷新：** task state与backend writesLocked为权威；RunPanel当前不自动继承shell锁，需要显式补传。Agent写入revision变化在工具完成节点刷新，旧异步响应核对projectId，使用workspaceReload正确dispose Monaco/buffer。列表poll并发不得重复reload；no-dirty开始后Agent独占。不要在只读编辑器中覆盖dirtybuffer；若启动与本地输入竞态，阻止替换并显示需处理，不静默丢弃。
- [x] **5. 验证与提交：** `pnpm test -- src/features/ai src/components/shell/WorkbenchShell.test.tsx src/components/runs/RunPanel.test.tsx src/features/editor/runPreconditions.test.ts`、`pnpm typecheck`、`pnpm build`。提交 `feat(ai): add minimal browser task panel`。

## Task 6: 第一阶段真实验收与实施记录

**Files — Create:**

- `poc4/frontend/playwright.ai-stage1.config.ts`
- `poc4/frontend/tests/e2e/ai-stage1.spec.ts`
- `poc4/frontend/tests/fixtures/ai-stage1/DemoControllerAcceptanceTest.java`
- `poc4/frontend/tests/fixtures/ai-stage1/acceptance-pom.xml`
- `poc4/frontend/scripts/ai-stage1-bootstrap.mjs`
- `poc4/deploy/ai-stage1/README.md`、`development-network-policy.yaml`
- `poc4/docs/evidence/ai-stage1/acceptance.md`

**Modify:** frontend package.json 增加 `test:e2e:ai-stage1`；AGENTS.md、进度和本计划状态，只写已验证结果。部署README先写发布准备与回滚，不自动修改现有6B资源或私有配置。

**Consumes:** Tasks1–5完整链路。**Produces:** 可复现的第一阶段验收、限制、模型与镜像版本、实际结果记录，后续阶段能直接沿用工具。

- [x] **1. 定义独立验收fixture：**

```java
package com.example.app;
import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;
class DemoControllerAcceptanceTest {
    @Test void returnsRequestedMessage() {
        assertEquals("Hello from Pi", new DemoController().demo().message());
    }
}
```

验收人员在专用项目的 `src/test/java/com/example/app/` 预置该文件，并在DemoController设置一个可定位编译错误（如 `Instant.nwo()`）。测试只调用Java对象，不启动应用／DB。记录fixture sha256；结束后文件必须未被弱化或删除，独立测试再次通过。acceptance-pom使用模板同一Spring Boot 3.5.9与Java17、web/actuator/test依赖，可信配置固定执行该验收测试，显式skipTests=false和maven.test.skip=false。仅独立验收构建scratch覆盖pom，不改用户项目pom、不开放给模型。
- [x] **2. 浏览器验收脚本：** 分bootstrap与验收两步：先用现有登录/创建项目fixture创建唯一专用项目并预置源码/测试，记录ID；再为独立验收后端配置 `MANAO_AI_PROJECT_ID=<实际ID>` 并启动，Playwright通过 `MANAO_AI_ACCEPTANCE_PROJECT_ID` 接受这个已存在ID，校验owner/READY/无Run。不新增热配置功能，不让浏览器测试创建新ID后假定服务器自动开放它。提交自然语言：`先执行测试确认当前错误；修复项目，并让 /api/demo 的 message 为 Hello from Pi；保留现有验收测试，重新运行测试并报告结果。` 脚本只预置输入和断言结果，不写Pi修复代码、不在平台端硬编码工具顺序。
- [x] **3. 核心断言：** 同task里有真实build exit!=0、之后至少一次write和build exit=0；真实文件为目标消息；初末revision正确；所有开发Job/Pod收尾确认；保存fixture摘要一致。成功build和独立复验都要在清理Pod前取得指定测试的Surefire XML，tests>=1、failures/errors/skipped=0，报告缺失/跳过即失败。独立复验通过同一只读-copy executor＋验收方控制的测试配置执行，不受用户pom中的skip/excludes影响，不启动应用Run。浏览器刷新或关闭重进任务仍可查询，同task未重复；编辑器显示新源码；任务结束前普通写／Run被拒绝。不要将SDK模型mock测试冒充这轮结果。
- [x] **4. 执行所需配置：** 实际云provider/API type/baseUrl/model/key、Docker、disposable MySQL、验收K8s context/namespace需真实存在；读配置只查必要字段是否具备，不输出秘密。未具备时完成所有源码、unit/container checks、发布准备，记录对应NOT_RUN/BLOCKED和缺失项；不换mock宣布PASS。触达现有云部署需用户明确授权，先交付可审阅镜像/迁移/manifest/回滚内容。
- [ ] **5. 隔离与发布检查：** dev main无源码RW挂载、无模型/platform凭据；实际网络策略阻止worker/backend/platformDB/K8s及其他项目访问，保留依赖下载。记录实际CNI enforcement，不只看policy资源。初始化cache和workspace-agent镜像不需重构；发布新runner与worker/backend/frontend时记录真实digest，验证单worker/单backend更新无重叠。
- [ ] **6. 执行命令与记录：**

```powershell
# 各自目录运行
# poc4/backend
mvn -Dtest=AgentTaskStoreTest,AgentProjectToolsTest,DevelopmentBuildExecutorTest,DevelopmentJobResourceFactoryTest,AgentTaskServiceTest,AgentInternalSecurityTest,WorkspaceControllerTest,RunControllerTest,PythonDependencyOperationTest,ProjectCleanupServiceTest,WorkspaceJdbcStoreTest test
# poc4/pi-worker
pnpm test
pnpm exec tsc --noEmit
pnpm build
# poc4/frontend
pnpm typecheck
pnpm test -- src/features/ai src/components/shell/WorkbenchShell.test.tsx src/components/runs/RunPanel.test.tsx
pnpm test:e2e:ai-stage1
```

将task/project/toolCall/operation/Job-Pod标识、SDK/provider/model、时间、初末revision、失败成功结果、输出截断、资源清理写入acceptance。仅真实闭环及独立复验通过记 `PI_STAGE1_CODE_TEST_LOOP_PASS`；未运行项目分别NOT_RUN。端到端之后删除仅本轮专用项目并独立核对残留，保留未解诊断，不用广泛清理。
- [ ] **7. 审查与交付：** 独立审查重点为文件重试、源码只读、任务占用入口、worker资源发现、前端dirtybuffer、未知Pod状态和证据边界。修复具体问题后重跑受影响检查。提交 `test(ai): verify stage-one coding and repair loop`，更新文档状态；不自动进入Task2阶段（应用Run集成）。

## 2. 自审覆盖与执行停止点

| 设计要求 | 任务 |
| --- | --- |
| 持久占用、owner、普通写／Run／删除互斥 | 1、2 |
| 模糊写不重放、稳定编号、新文件保存 | 2 |
| 真实构建反馈、只读源码、缓存串行、Pod确认收尾 | 3 |
| SDK自主循环、云API、内部鉴权、断连继续、close安全 | 4 |
| 浏览器输入／进度／实际源码、dirty保护 | 5 |
| 独立失败修复、镜像/配置/网络、证据与残留 | 6 |

Tasks1–5为可完成的实现与本地检查；Task6包含真实模型和环境验证。缺外部条件只阻塞依赖它的验收，不阻塞已授权的实现。源码完成、测试通过、模型实测、发布和用户验收分别报告，禁止合并成一个模糊“已完成”。

实施提示词见 [Agent Handoff](2026-10-13-pi-stage1-agent-handoff.md)。用户需要的是可直接转交的文本，不应在当前规划会话自动创建新Agent任务或发送给其他聊天。
