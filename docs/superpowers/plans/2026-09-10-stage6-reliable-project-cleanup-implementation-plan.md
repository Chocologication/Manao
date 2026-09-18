> **历史来源 / 2026-09-17 已被现行记录取代：** 当前 6A 范围、验收决定和证据以[唯一现行事实现状](../../Stage6A-Current-Facts.md)为准。下文保留原时点的设计、计划和结果；其中“当前”、待实施、FAILED/不允许 6B 等只描述旧时点，不覆盖本次用户验收决定，也不自动授权重新执行。原始结果不改写。此链接指向主检出的单份文档，不复制第二份现状。

# Stage 6 Reliable Project Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. If the user explicitly authorizes sub-agents, superpowers:subagent-driven-development is an alternative. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Stage 6 下一步第 1 点：异常/并发/中断情况下可核验、可显式续作、严格 owner-scoped 的项目清理，以及三个真实测试套件的统一资源管理。

**Architecture:** 在短事务中持久化 DELETING；以同 project 行的事务检查和单实例 project 生命周期门闩阻止并发生产资源。Kubernetes 分层、逐项清理，数据库最后删除；测试侧用持久化 invocation 台账、逐用例 teardown、套件兜底和独立只读核验闭环。

**Tech Stack:** Java 17 / Spring Boot 3.5.9 / 现有 MySQL + Flyway / Fabric8 7.7.0；TypeScript / 现有 React、Vitest、Playwright；pnpm，Windows PowerShell；不新增依赖、不升级版本。

**Spec:** [设计规格](../specs/2026-09-10-stage6-reliable-project-cleanup-design.md)。实施者必须同时读取该规格、工作树 AGENTS.md 和 `poc4/docs/evidence/stage-6/2026-09-10-status-and-next-steps.md`。

**Status:** 待实施前审阅。此次只生成文档；下列代码是计划中的目标/测试片段，不是已经应用的实现。没有执行测试、迁移或资源删除。

**Baseline:** `a002b41bf4b969b05ec7220052d1654df959a101`。绝对工作树根目录为 `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes`。下文 Files 使用相对于这个根目录的路径，绝不指向主检出。

## Global Constraints

- CREATING 项目的 DELETE 返回明确的 409，不修改状态，不删除资源；有界等待，不取消创建。
- DELETING 是不可逆的删除意图；失败及进程重启不得退回 READY；仅明确 DELETE 续作，不自动扫历史项目。
- owner 校验先于状态暴露和副作用；不存在与非 owner 均为 404，其他 owner 无资源或数据库变化。
- 同一项目的本地长操作与清理互斥；不同项目不使用全局生命周期锁。Kubernetes 等待期间不持有数据库事务。
- 先停止该项目本地生产者/连接，再清理 Job、所有所属 Pod 和 Service；确认 workload 消失后才删 PVC；确认 PVC 消失后才删关联 DB 行。
- 单资源错误不跳过同层其他资源，单项目错误不跳过其他项目；任何未知、Forbidden、timeout、remaining 都不是清理完成。
- 创建请求至多发送一次。响应丢失时只读取状态和精确身份；不把 0 个匹配立即解释成创建未生效，也不靠 POST 重试找回项目。
- 默认不保留新诊断；显式开启时，本次 invocation 最多保留精确匹配的一份。既有诊断不属于本次自动清理集合。
- 不盲重放 workspace mutation 或可能已生效的删除；不输出 token、密码、kubeconfig 或浏览器原始 trace。
- 原始阶段顺序仍为 Task 1-9 -> 独立 6A Gate -> Task 10-12。下文 RC-1 至 RC-8 是本切片编号，不是原始 Stage 6 Task 编号。
- 沿用项目级 .worktree、pnpm、UTF-8 无 BOM；不使用 npm、git clean、mvn clean，不重置运行库。
- 所有数据库变更测试使用 disposable schema；真实验收的运行库只读核验必须使用单独的显式环境入口，不能误用 schema-reset 测试。

## 0. 执行边界、默认决策和依赖顺序

### 0.1 固定的额外默认决策

这些是本计划的具体化，不引入新的产品范围：

1. 删除 API 本身不取消 Run；测试只可显式停止已登记、本次 invocation 创建的 Run，先采证、后核对，不修复/伪造 Run 终态。
2. READY 且有 PENDING 写操作时为 409 PROJECT_BUSY；FAILED 的遗留 receipt 在明确删除全项目且执行端停止后，随最终 DB 事务清理。
3. 暂不增加 UI 删除按钮；只兼容 DELETING 显示、访问限制和安全错误。
4. 不实现定时全库 reaper；强制中断后的台账通过显式 resume 入口恢复。
5. 不改变现有 10 分钟 stale recovery 阈值、项目上限 8、Job policy 或 bridge 默认模式。
6. 测试失败不自动保留所有资源；精确 HOLD 为单槽，未知状态为 UNRESOLVED/失败，二者不能混为一谈。

### 0.2 顺序与检查点

```text
RC-1 状态迁移
  -> RC-2 生命周期门闩和事务屏障
  -> RC-3 分层 Kubernetes cleaner
  -> RC-4 DELETE 编排、本地句柄、HTTP 契约
  -> RC-5 前端 DELETING
  -> RC-6 台账与清理核心
  -> RC-7 三套 E2E 接入、兜底和显式续作
  -> RC-8 专项真实验收与独立残留核验
```

RC-1 至 RC-7 不要求操作真实 Kubernetes。RC-1/2/4 的真 MySQL 回归只针对 disposable schema。完成 RC-7 后先做代码与测试复核，得到操作者对服务启动及专项运行的明确授权，再进入 RC-8。不得把本文中的命令当成本轮已获授权执行。

### 0.3 统一操作约定

```powershell
$wt = 'D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes'
Set-Location -LiteralPath $wt
git rev-parse HEAD
git status --short
```

首次执行应与规划 SHA 匹配，或列出之后的文档提交/用户改动并重新核对。每次改文件前从磁盘重读；每个任务先 RED，再 GREEN，再提交。下文 `mvn` 必须是操作者已配置在 PATH 的 Maven，不自行更换 JDK/Maven 或下载安装依赖工具。

若 RED 是编译错误、认证失败、MySQL 1419 或 schema 无法创建，先修正测试脚手架/前置条件；不能把这些当成目标缺陷的 RED。新增接口可先放可编译的最小空实现，但功能实现必须等待预期断言失败。

---

## Task RC-1：增加 DELETING 状态迁移及数据库契约回归

**Files**
- Create: `poc4/backend/src/main/resources/db/migration/V8__project_deleting_state.sql`
- Create: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectDeletionStateMigrationTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/persistence/JdbcStoreTestSupport.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/persistence/FlywaySchemaTest.java`

**Interfaces**
- Consumes: 现有 V1-V7、`JdbcStoreTestSupport.create()`、`jdbc()`、`close()`。
- Produces: 可保存 DELETING 的 project 表；新增 `createAtVersion(String version)` 与 `migrateToLatest()`，仅用于一次性 schema 的升级回归。现有 `create()` 行为保持迁移到最新版本。

- [ ] **Step 1 — 写迁移失败测试。** 使用当前 `create()`，建 owner/project 后更新 DELETING，当前 V7 应因 CHECK 约束失败：

```java
@Test
void acceptsDeletingAndRejectsUnknownState() {
    try (var db = JdbcStoreTestSupport.create()) {
        var jdbc = db.jdbc();
        jdbc.update("INSERT INTO app_user(id,username,password_hash) VALUES (?,?,?)",
            "owner-a", "cleanup-a", "not-an-auth-credential");
        jdbc.update("INSERT INTO project(id,owner_id,name,state) VALUES (?,?,?,?)",
            "project-a", "owner-a", "cleanup-state", "READY");
        assertThatCode(() -> jdbc.update("UPDATE project SET state='DELETING' WHERE id=?",
            "project-a")).doesNotThrowAnyException();
        assertThatThrownBy(() -> jdbc.update("UPDATE project SET state='UNKNOWN' WHERE id=?",
            "project-a")).isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
    }
}
```

- [ ] **Step 2 — 运行 RED 并保存原因。**

```powershell
Set-Location -LiteralPath (Join-Path $wt 'poc4/backend')
mvn -B '-Dtest=ProjectDeletionStateMigrationTest' test
```

预期：失败指向 DELETING 不被 `ck_project_state` 接受，而不是测试库权限问题。

- [ ] **Step 3 — 新增 V8，不编辑旧迁移。**

```sql
ALTER TABLE project
    DROP CHECK ck_project_state,
    ADD CONSTRAINT ck_project_state
        CHECK (state IN ('CREATING', 'READY', 'FAILED', 'DELETING'));
```

- [ ] **Step 4 — 增加 V7 -> V8 升级测试。** 让 `createAtVersion("7")` 使用同一个隔离 schema 建立 V7；插入 READY、FAILED、CREATING 及关联 workspace_operation；记录行数/revision，再 `migrateToLatest()`。断言旧数据未变化、DELETING 可写、Flyway V8 成功。脚手架仍在 finally/close 中只删除自己生成的 schema。

```java
public void migrateToLatest() {
    org.flywaydb.core.Flyway.configure().dataSource(dataSource)
        .locations("classpath:db/migration").load().migrate();
}
```

`createAtVersion` 只接受测试指定的数字版本，工厂生成 schema 名，不接受外部传入删除目标。

- [ ] **Step 5 — GREEN 和小提交。**

```powershell
mvn -B '-Dtest=ProjectDeletionStateMigrationTest,FlywaySchemaTest' test
git diff --check
git add -- src/main/resources/db/migration/V8__project_deleting_state.sql src/test/java/com/manao/poc4/project/ProjectDeletionStateMigrationTest.java src/test/java/com/manao/poc4/persistence/JdbcStoreTestSupport.java src/test/java/com/manao/poc4/persistence/FlywaySchemaTest.java
git commit -m 'feat(stage6): persist project deleting state'
```

**完成条件：** 空库迁移、V7 升级、未知状态拒绝均通过；运行库未被改动。此时不启动真实后端自动执行迁移。

---

## Task RC-2：建立生命周期门闩，关闭删除与写入/Run/provision/recovery 的竞态

**Files**
- Create: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectLifecycleGate.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectLifecycleGateTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectMutationDeletionConcurrencyTest.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/WorkspaceConfig.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectProvisioningService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/recovery/ProjectRecoveryService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceOperationService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceJdbcStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/JdbcRunStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunObservationService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunRecoveryService.java`
- Tests: `poc4/backend/src/test/java/com/manao/poc4/run/RunObservationServiceTest.java`
- Tests: `poc4/backend/src/test/java/com/manao/poc4/run/RunRecoveryServiceTest.java`
- Tests: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectProvisioningServiceTest.java`
- Tests: `poc4/backend/src/test/java/com/manao/poc4/recovery/ProjectRecoveryServiceTest.java`
- Tests: `poc4/backend/src/test/java/com/manao/poc4/run/JdbcRunStoreTest.java`
- Tests: `poc4/backend/src/test/java/com/manao/poc4/workspace/WorkspaceControllerTest.java`
- Tests: `poc4/backend/src/test/java/com/manao/poc4/workspace/WorkspaceOperationDiagnosticsTest.java`

**Interfaces**

```java
// project/ProjectLifecycleGate.java
public Optional<Lease> tryAcquire(String projectId);
public interface Lease extends AutoCloseable {
    @Override public void close();
}

// workspace/WorkspaceStore.java，保留原两参数构造器以兼容现有 test doubles
record BeginResult(boolean started, boolean revisionConflict, boolean projectLocked) {
    public BeginResult(boolean started, boolean revisionConflict) {
        this(started, revisionConflict, false);
    }
}

// run/RunStore.java
// 保留现有值，增加明确的事务内拒绝结果
// INSERTED, ACTIVE_RUN_EXISTS, PROJECT_LOCKED, PROJECT_NOT_FOUND, REVISION_CONFLICT
```

门闩可重入，close 幂等；使用稳定 Cell + 引用计数，不能在仍被其他调用引用时删除 map 项。固定锁顺序为 project gate -> project 行 -> 必要的 dependent 行；不在 bridge manager synchronized 区域里反向获取 project gate。

- [ ] **Step 1 — 先写确定性并发测试。** 使用 CountDownLatch/CompletableFuture 的有限超时，不用 sleep 伪造并发。必须覆盖：同项目排他、同线程嵌套可重入、不同项目并行、异常释放，以及 release/reacquire 不生成两把有效锁。

```java
@Test
void rejectsAnotherThreadButAllowsAnotherProject() throws Exception {
    var gate = new ProjectLifecycleGate();
    try (var held = gate.tryAcquire("p1").orElseThrow()) {
        var executor = java.util.concurrent.Executors.newSingleThreadExecutor();
        try {
            assertThat(executor.submit(() -> gate.tryAcquire("p1").isEmpty())
                .get(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            assertThat(executor.submit(() -> {
                try (var other = gate.tryAcquire("p2").orElseThrow()) { return true; }
            }).get(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        } finally { executor.shutdownNow(); }
    }
    try (var again = gate.tryAcquire("p1").orElseThrow()) {
        assertThat(again).isNotNull();
    }
}
```

- [ ] **Step 2 — 增加真 MySQL 的迟到写入 RED。** 同一个 disposable schema，两个连接/事务，用 latch 固定交错；复用现有 JdbcRunStoreTest 的 RunRecord 夹具。矩阵：
  - 删除事务先把项目置 DELETING，迟到 insertRun 返回 PROJECT_LOCKED，零 Run、零 Job 调用。
  - insertRun 先提交 STARTING，删除资格检查必须看到 active_run_marker=1。
  - beginPending 先登记成功，READY 删除返回 busy；DELETING 先提交则不能新建 PENDING。
  - DELETING 后 commitOperation 返回 false，operation 状态/revision 均不变化。
  - markProjectReady / markProjectFailed 对 DELETING 不产生变化。
  - recovery 持有旧 CREATING 快照时，重读已变化状态，不再创建、删资源或推进 READY。

```powershell
mvn -B '-Dtest=ProjectLifecycleGateTest,ProjectMutationDeletionConcurrencyTest' test
```

- [ ] **Step 3 — 接入门闩并复核数据库状态。** 所有生产 Bean 注入同一个 gate；测试构造器不能悄悄为同一场景创建多个 gate。普通 workspace 入口覆盖完整的读/写调用，内部 apply/reconcile 也持有门闩，避免 digest 读取和懒加载 bridge 在删除中复活。

```java
try (var lease = lifecycle.tryAcquire(projectId).orElseThrow(
        () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
    // 在此重新读项目并校验 owner/state；不是使用进入 gate 之前的快照。
    // 执行现有单项目操作；Kubernetes/agent I/O 不置于 SQL transaction 回调内。
}
```

事务内插入 Run 之前必须锁住 project 主键行并校验 READY 与 requested_revision，保留现有 active-run 唯一约束作为第二道防线。不要把 PROJECT_LOCKED 错误解释为 ACTIVE_RUN_EXISTS。

```sql
SELECT id, state, workspace_revision FROM project WHERE id = ? FOR UPDATE;
-- 仅 READY 且 revision 匹配后，在同一事务 INSERT run。
```

workspace 的 beginPending 在现有 project 行锁内核对状态和 active Run。返回 `projectLocked=true` 时，WorkspaceOperationService 立即返回固定 PROJECT_LOCKED，不走 reconcile/retry，更不能访问 agent。commitOperation 先锁 project、核对允许状态与 revision，再更新 operation/revision；任何失败都回滚。

- [ ] **Step 4 — recovery/provision 与 resolver 接线。** provision/recovery 在取得门闩后重新读取 CREATING；繁忙项目跳过本轮 recovery，其他项目继续。resolver 在 allocate 前重新读项目，拒绝 DELETING/不存在，确保在删除后的旧请求不能重建 bridge。保留合法的 provisioning CREATING 和失败 receipt 取证路径。

RunObservationService/RunRecoveryService 的每个 Run 处理也取得同一 project gate，重新读取 Run/project 后才 attach watch、settle 和调用 completionListener。源码中观察器在 markRunning 返回后仍可能 ensureWatch，不能让删除前的扫描快照在清理后重新创建 watch；以 latch 固定

- [ ] **Step 5 — GREEN，检查当前例外路径没有被破坏。**

```powershell
mvn -B '-Dtest=ProjectLifecycleGateTest,ProjectMutationDeletionConcurrencyTest,ProjectProvisioningServiceTest,ProjectRecoveryServiceTest,JdbcRunStoreTest,RunObservationServiceTest,RunRecoveryServiceTest,WorkspaceControllerTest,WorkspaceOperationDiagnosticsTest' test
git diff --check
```

- [ ] **Step 6 — 逐文件审阅后提交本任务文件。**

```powershell
git diff --stat
git diff -- src/main/java/com/manao/poc4/project src/main/java/com/manao/poc4/workspace src/main/java/com/manao/poc4/run src/main/java/com/manao/poc4/recovery src/main/java/com/manao/poc4/config/WorkspaceConfig.java
git add -- src/main/java/com/manao/poc4/project/ProjectLifecycleGate.java src/main/java/com/manao/poc4/config/WorkspaceConfig.java src/main/java/com/manao/poc4/project/ProjectProvisioningService.java src/main/java/com/manao/poc4/recovery/ProjectRecoveryService.java src/main/java/com/manao/poc4/workspace/WorkspaceService.java src/main/java/com/manao/poc4/workspace/WorkspaceOperationService.java src/main/java/com/manao/poc4/workspace/WorkspaceStore.java src/main/java/com/manao/poc4/workspace/WorkspaceJdbcStore.java src/main/java/com/manao/poc4/run/RunStore.java src/main/java/com/manao/poc4/run/JdbcRunStore.java src/main/java/com/manao/poc4/run/RunService.java src/main/java/com/manao/poc4/run/RunObservationService.java src/main/java/com/manao/poc4/run/RunRecoveryService.java src/test/java/com/manao/poc4/run/RunObservationServiceTest.java src/test/java/com/manao/poc4/run/RunRecoveryServiceTest.java src/test/java/com/manao/poc4/project/ProjectLifecycleGateTest.java src/test/java/com/manao/poc4/project/ProjectMutationDeletionConcurrencyTest.java src/test/java/com/manao/poc4/project/ProjectProvisioningServiceTest.java src/test/java/com/manao/poc4/recovery/ProjectRecoveryServiceTest.java src/test/java/com/manao/poc4/run/JdbcRunStoreTest.java src/test/java/com/manao/poc4/workspace/WorkspaceControllerTest.java src/test/java/com/manao/poc4/workspace/WorkspaceOperationDiagnosticsTest.java
git commit -m 'fix(stage6): serialize project deletion against lifecycle writers'
```

**完成条件：** 竞态由确定性单测与真 MySQL 交错测试证明；没有修改 Run 终态恢复算法、lease 策略或项目创建超时。

---

## Task RC-3：实现统一、逐项容错、分层确认的 Kubernetes cleaner

**Files**
- Create: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/ProjectResourceCleaner.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/ProjectResourceCleanupException.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/ProjectResourceCleanerTest.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/Fabric8KubernetesGateway.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/Fabric8KubernetesGatewayTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/FakeKubernetesGateway.java`

**Interfaces**

```java
public record ResourceRef(String kind, String namespace, String name, String uid) {}
public record Issue(String phase, ResourceRef resource, String category) {}
public record CleanupReport(boolean workloadsAbsent, boolean storageAbsent,
                            java.util.List<ResourceRef> remaining,
                            java.util.List<Issue> issues) {
    public boolean complete() {
        return workloadsAbsent && storageAbsent && remaining.isEmpty() && issues.isEmpty();
    }
}
// ProjectResourceCleaner：构造参数为 client、namespace、预算/轮询参数。
public CleanupReport clean(String projectId);
// gateway 的既有 void deleteProjectResources(String) 保持接口兼容：
// clean -> report.complete 为 false 时抛出携带内部 report 的 typed exception。
```

测试使用 Fabric8 mock server 的实际 selector/list/delete 行为，不用“FakeGateway 一次性清空集合”代替 adapter 证明。时钟/轮询注入允许测试立即超时，不等待 90 秒。

- [ ] **Step 1 — 增加当前漏删缺陷的 RED。** 创建同项目、不同 component 的 initializer/workspace/Job Pods、Service、Job、PVC；额外创建另一个 project 的相同类型资源。调用现有 gateway 全量清理，断言 initializer 消失且其他项目不变。

```java
// 在现有 mock-server fixture 中使用 client/factory/gateway；projectId 为 p1。
var initializer = factory.createInitializerPod("p1");
client.pods().inNamespace(namespace).resource(initializer).create();
assertThat(initializer.getMetadata().getLabels().get("manao.poc4/component"))
    .isEqualTo("initializer");
gateway.deleteProjectResources("p1");
assertThat(client.pods().inNamespace(namespace)
    .withLabels(WorkspaceResourceFactory.projectResourceLabels("p1"))
    .list().getItems()).isEmpty();
```

其他资源的 seed 使用现有工厂和 JobResourceFactory，不能在测试里手写错误的标签来迁就实现。

- [ ] **Step 2 — 补逐项容错/层级顺序 RED。** mock server 的 request log 必须证明：
  - 第一项 Job DELETE 500/连接断开后，其他 Job、Pod、Service 仍被尝试。
  - initializer Failed/Succeeded/Pending 均进入删除范围；不存在对象按已消失处理。
  - Job 或 Pod list=403，或任意 workload 仍在 Terminating：绝不发送 PVC DELETE。
  - 第一个 PVC 删除失败，其他 PVC 仍被尝试；报告不 complete。
  - 每次等待使用同一个 projectResourceLabels；只允许 list + 按名称删除，无 deletecollection。
  - 到期/中断返回不完整报告；保留 interrupt 标记，不继续发新请求；重复清理安全。

```powershell
mvn -B '-Dtest=ProjectResourceCleanerTest,Fabric8KubernetesGatewayTest' test
```

- [ ] **Step 3 — 实现分层算法。** 每个资源调用包围独立 try/catch；类级方法固定为 `inventory`、`deleteWorkloads`、`awaitWorkloadsAbsent`、`deletePvcs`、`awaitAllAbsent`，均只接受从服务端 projectId 构造出的标签和同一个 deadline。

```java
var labels = WorkspaceResourceFactory.projectResourceLabels(projectId);
// Jobs 采用 foreground；每项异常加入 issues，继续同层其他项。
client.batch().v1().jobs().inNamespace(namespace).withName(jobName)
    .withPropagationPolicy(io.fabric8.kubernetes.api.model.DeletionPropagation.FOREGROUND)
    .delete();
// 所有 component 的 Pods 使用同一 labels，包括 initializer。
var pods = client.pods().inNamespace(namespace).withLabels(labels).list().getItems();
```

不要把一次 DELETE 的返回对象列表当作删除已完成。重新 list 必须确认成功且为空；一旦类型读取失败，将该类型标记未知。Workload 阶段未确认时只返回报告，不执行存储阶段。确保每个请求有 5 秒上限且总预算 90 秒；本地 7.7.0 的具体 request-timeout 接线必须通过编译及“服务端永不返回”的回归，不能只设置轮询 deadline。

- [ ] **Step 4 — 保留 reconciliation 的 PVC 保护。** `deleteProjectWorkloads` 与 full cleaner 不合并成一个含隐式默认参数的危险方法。其 Pod/Service selector 可以覆盖 initializer，但测试必须断言从不删除 PVC、DB 或无关 Job。更新 provision/recovery 的失败报告，使某一项目 cleanup 异常不吞掉其他项目的恢复。

- [ ] **Step 5 — GREEN 和提交。**

```powershell
mvn -B '-Dtest=ProjectResourceCleanerTest,Fabric8KubernetesGatewayTest,ProjectProvisioningServiceTest,ProjectRecoveryServiceTest' test
git diff --check
git add -- src/main/java/com/manao/poc4/kubernetes/ProjectResourceCleaner.java src/main/java/com/manao/poc4/kubernetes/ProjectResourceCleanupException.java src/main/java/com/manao/poc4/kubernetes/Fabric8KubernetesGateway.java src/test/java/com/manao/poc4/kubernetes/ProjectResourceCleanerTest.java src/test/java/com/manao/poc4/kubernetes/Fabric8KubernetesGatewayTest.java src/test/java/com/manao/poc4/kubernetes/FakeKubernetesGateway.java
git commit -m 'fix(stage6): clean every project resource with phased verification'
```

**完成条件：** 真实 Fabric8 adapter 的 mock-server 测试证明 initializer 覆盖、逐项容错、顺序保护和 selector 一致；没有扩大 RBAC。

---

## Task RC-4：接通 owner-scoped DELETE、持久化续作、本地句柄关闭与最终 DB 删除

**Files**
- Create: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectDeletionRepository.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectCleanupService.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectRuntimeCleaner.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/project/ProvisioningDiagnosticHold.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectDeletionRepositoryTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectCleanupServiceTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectDeleteHttpContractTest.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectController.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectProvisioningService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceJdbcStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspacePortForwardManager.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/KubectlPortForwardFactory.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/log/RunLogIngestor.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/log/RunLogService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/log/RunLogWebSocketHandler.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/log/LogTicketService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/terminal/TerminalSessionService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/terminal/TerminalWebSocketHandler.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/WorkspaceConfig.java`
- Tests: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectProvisioningServiceTest.java`
- Tests: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectAuthorizationTest.java`
- Tests: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/WorkspacePortForwardManagerTest.java`
- Tests: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/KubectlPortForwardFactoryTest.java`
- Tests: `poc4/backend/src/test/java/com/manao/poc4/log/RunLogWebSocketTest.java`
- Tests: `poc4/backend/src/test/java/com/manao/poc4/terminal/TerminalWebSocketTest.java`

**Interfaces**

```java
// 以下为跨文件方法契约，不是独立的 Java 编译单元。
// ProjectDeletionRepository
public enum BeginDeletion { STARTED, RESUMED, NOT_FOUND, CREATING, ACTIVE_RUN, BUSY }
public BeginDeletion begin(String ownerId, String projectId);
public java.util.List<String> runIds(String ownerId, String projectId);
// ProjectCleanupService
public void delete(String ownerId, String projectId);
// ProjectRuntimeCleaner
public void closeProject(String projectId, java.util.List<String> runIds);
// WorkspacePortForwardManager：显式删除项目，忽略残留引用数；失败保留句柄
public void closeProject(String projectId);
// RunLogWebSocketHandler / TerminalWebSocketHandler
public void closeRun(String runId);
// RunLogService
public void forgetRun(String runId);
```

`WorkspaceStore.deleteProject(ownerId, projectId)` 保留为最终 DB 事务接口，但必须要求当前 state=DELETING；不能再被作为裸删除入口。移除 ProjectProvisioningService 中旧的 boolean delete 编排，Controller 只委托 ProjectCleanupService。所有生产路径必须经同一 gate 与 beginDeletion。

- [ ] **Step 1 — HTTP 状态和副作用 RED。** 新测试固定规格第 4 节全部状态；特别断言 active Run 返回 409，而非 404。MockMvc 测试使用已认证的 TestingAuthenticationToken，真实执行 Controller + advice；与服务测试配合，不让 mock 的固定返回码替代所有者校验。

```java
mockMvc.perform(delete("/api/v1/projects/p1")
        .principal(new org.springframework.security.authentication.TestingAuthenticationToken(
            "owner-a", "unused")))
    .andExpect(status().isConflict())
    .andExpect(jsonPath("$.code").value("RUN_ALREADY_ACTIVE"))
    .andExpect(jsonPath("$.message").value("A run is already active"));
```

同时验证非 owner 请求对 gateway、runtimeCleaner、DB DELETE 全部零调用。给内部异常注入包含 kubeconfig/token/namespace 的诱饵字符串，HTTP 只能输出固定 message 和 traceId，不能泄露诱饵。

- [ ] **Step 2 — 真 MySQL 资格与最终事务 RED。** 新 repository 测试复用 RC-1 的隔离 schema：
  - READY/FAILED -> STARTED，DELETING -> RESUMED；CREATING/非 owner/active Run 无状态变更。
  - READY + PENDING -> BUSY；FAILED + 遗留 PENDING 可以进入 DELETING。
  - 最终 deleteProject 仅删除当前 owner 的 DELETING 项目及七类相关记录；其他 owner、同 owner 的其他项目不变。
  - 任一关联表删除失败时整笔事务回滚，所有追踪行保留；不把失败当作 404。
  - 使用两个连接固定“新 Run 与 beginDeletion 竞争”的顺序，补充 RC-2 的双向竞态证明。

```powershell
mvn -B '-Dtest=ProjectDeletionRepositoryTest,ProjectCleanupServiceTest,ProjectDeleteHttpContractTest' test
```

- [ ] **Step 3 — 实现短事务资格取得。** repository 的项目查询采用主键行锁，不使用 COUNT(*) 冒充状态快照。

```java
return transaction.execute(status -> {
    var rows = jdbc.query("SELECT id, owner_id, state FROM project WHERE id=? FOR UPDATE",
        (rs, n) -> new String[] { rs.getString(1), rs.getString(2), rs.getString(3) }, projectId);
    if (rows.isEmpty() || !ownerId.equals(rows.get(0)[1])) return BeginDeletion.NOT_FOUND;
    String state = rows.get(0)[2];
    if ("CREATING".equals(state)) return BeginDeletion.CREATING;
    if (jdbc.queryForObject("SELECT COUNT(*) FROM run WHERE project_id=? AND active_run_marker=1",
            Integer.class, projectId) > 0) return BeginDeletion.ACTIVE_RUN;
    if ("READY".equals(state) && jdbc.queryForObject(
            "SELECT COUNT(*) FROM workspace_operation WHERE project_id=? AND state='PENDING'",
            Integer.class, projectId) > 0) return BeginDeletion.BUSY;
    if ("DELETING".equals(state)) return BeginDeletion.RESUMED;
    if (!java.util.Set.of("READY", "FAILED").contains(state)) return BeginDeletion.BUSY;
    jdbc.update("UPDATE project SET state='DELETING', updated_at=CURRENT_TIMESTAMP(6) WHERE id=?",
        projectId);
    return BeginDeletion.STARTED;
});
```

`runIds` 只读取经 owner 校验的 DELETING 项目；不使用客户端指定的 Run 列表决定后端删除范围。

- [ ] **Step 4 — 编排 runtime -> Kubernetes -> DB。** 先做无副作用 owner/CREATING 预检查，保证正在创建时不是泛化 PROJECT_BUSY；随后取得 gate 并由 repository 再次权威检查。BEGIN 成功后，任何后续失败均保持 DELETING 并返回 503 PROJECT_CLEANUP_INCOMPLETE。

```java
// 位于持有同项目 Lease 的 try 块内；begin 结果先映射规格中的 HTTP 契约。
runtime.closeProject(projectId, deletions.runIds(ownerId, projectId));
gateway.deleteProjectResources(projectId);
if (!store.deleteProject(ownerId, projectId)) {
    throw new ApiException("PROJECT_CLEANUP_INCOMPLETE", 503, "Project cleanup is incomplete");
}
```

runtimeCleaner 逐 Run 尝试 detach watch -> 关闭 log/PTY session -> 移除监听器和缓存，最后关闭项目 bridge；每项独立收集失败，全部尝试后统一抛出安全异常。未完成时不得继续 PVC/DB 阶段。关闭与迟到 publish 同步：先禁止新的回调进入，再等待已有回调退出，最后移除对应缓存；已删除 Run 的缓存不得被重建或再次写库，也不无限积累删除 tombstone。等待超时保持 DELETING，不能继续 DB 删除。

为了核验本地 bridge，给 PortForwardProcess 增加默认返回 OptionalLong.empty() 的 pid()；KubectlPortForwardFactory 返回真实 Process.pid()，不为 Fabric8/supervised 伪造 PID。ProjectRuntimeCleaner 输出固定 allowlist 的结构化本地报告（attemptId、projectId、bridge PID、持有/关闭前后数量、时间和安全结果），不暴露新浏览器端点。RC-8 从本次后端日志中提取此记录并独立查询该 PID；未取得报告或 PID 身份不匹配时不可确认本地句柄已清空。

复用现有 session teardown 的审计/exec 关闭顺序，只增加按 Run 范围过滤；禁止调用 teardownAllSessions/shutdown 影响其他项目。WebSocket 关闭后删除连接映射，失败保留可继续清理的句柄。

票据签发/terminal reservation 也持有项目 gate 并重新核对 DELETING；WebSocket 握手在消费 ticket 获得 projectId 后、创建 exec/注册 listener 之前获取同一 gate，重读项目和 Run。若 DELETE 已取得资格就关闭连接，不发 exec、不注册新 listener；若握手先取得 gate，删除必须等其注册结束后由 runtimeCleaner 统一关闭。增加

- [ ] **Step 5 — 修正最终 DB 删除。** 在现有 WorkspaceJdbcStore.deleteProject 事务中锁定实际项目行，校验 owner + DELETING + 无 active Run，再依原 FK 顺序删除。保留 app_user、其他项目及任何未包含在该 projectId 下的行。对单表故障使用测试专用事务/SQL 拦截，不对运行库加 trigger。

- [ ] **Step 6 — crash/partial cleanup 回归。** 用同一 disposable DB 重建 service/gate 实例模拟进程重启；旧 DELETING 必须仍拒绝 Run/写入，新的显式 DELETE 可续作。模拟 Kubernetes 部分删除、bridge 关闭失败、DB 提交失败、响应在成功后丢失；第二次尝试先检查权威状态，不重复 provision，不复活 bridge。

```powershell
mvn -B '-Dtest=ProjectDeletionRepositoryTest,ProjectCleanupServiceTest,ProjectDeleteHttpContractTest,ProjectAuthorizationTest,ProjectProvisioningServiceTest,WorkspacePortForwardManagerTest,RunLogWebSocketTest,TerminalWebSocketTest' test
mvn -B test
git diff --check
```

全量测试里的默认 preflight SKIPPED 必须单独报告，不能声称真实集群已验收。测试库权限问题先阻断环境修复，不重置运行库。

- [ ] **Step 7 — 按本任务 Files 显式暂存实际改动并提交。** 检查 git diff 中没有 RunStateReducer/RunRecoveryService 的终态算法改动，没有部署 YAML 或 Role 权限扩展。

```powershell
git diff --stat
git add -- src/main/java/com/manao/poc4/project/ProjectDeletionRepository.java src/main/java/com/manao/poc4/project/ProjectCleanupService.java src/main/java/com/manao/poc4/project/ProjectRuntimeCleaner.java src/main/java/com/manao/poc4/project/ProvisioningDiagnosticHold.java src/main/java/com/manao/poc4/project/ProjectController.java src/main/java/com/manao/poc4/project/ProjectProvisioningService.java src/main/java/com/manao/poc4/workspace/WorkspaceJdbcStore.java src/main/java/com/manao/poc4/kubernetes/WorkspacePortForwardManager.java src/main/java/com/manao/poc4/kubernetes/KubectlPortForwardFactory.java src/main/java/com/manao/poc4/log/RunLogIngestor.java src/main/java/com/manao/poc4/log/RunLogService.java src/main/java/com/manao/poc4/log/RunLogWebSocketHandler.java src/main/java/com/manao/poc4/log/LogTicketService.java src/main/java/com/manao/poc4/terminal/TerminalSessionService.java src/main/java/com/manao/poc4/terminal/TerminalWebSocketHandler.java src/main/java/com/manao/poc4/config/WorkspaceConfig.java src/test/java/com/manao/poc4/project/ProjectDeletionRepositoryTest.java src/test/java/com/manao/poc4/project/ProjectCleanupServiceTest.java src/test/java/com/manao/poc4/project/ProjectDeleteHttpContractTest.java src/test/java/com/manao/poc4/project/ProjectAuthorizationTest.java src/test/java/com/manao/poc4/project/ProjectProvisioningServiceTest.java src/test/java/com/manao/poc4/kubernetes/WorkspacePortForwardManagerTest.java src/test/java/com/manao/poc4/kubernetes/KubectlPortForwardFactoryTest.java src/test/java/com/manao/poc4/log/RunLogWebSocketTest.java src/test/java/com/manao/poc4/terminal/TerminalWebSocketTest.java
git commit -m 'fix(stage6): make project deletion explicit resumable and owner scoped'
```

诊断选择器只接受完整 ownerId + exact projectName（可另加精确 projectId）；本切片真实测试禁用宽 prefix 选择。默认后端 HOLD 关闭；如需保留一次失败 provisioning，操作者在启动前将同一个预登记名称配置到后端 selector 和 invocation 单槽，二者必须一致。重启后不能重新通过宽 prefix 选中第二个项目；显式 DELETE 仍可回收该目标，不受诊断 predicate 阻止。ProjectProvisioningServiceTest 补缺少 owner、仅 prefix、第二个名称、重启后不同 ID 不被意外保留的回归。

**完成条件：** 删除不再依赖 boolean/404 推断；部分失败及模拟重启可继续清理；现有后端回归结果有完整失败/跳过统计。

---

## Task RC-5：前端兼容 DELETING，禁止误开工作台及不安全错误展示

**Files**
- Modify: `poc4/frontend/src/contracts/project.ts`
- Modify: `poc4/frontend/src/contracts/api.ts`
- Modify: `poc4/frontend/src/api/httpClient.ts`
- Modify: `poc4/frontend/src/features/projects/ProjectCard.tsx`
- Modify: `poc4/frontend/src/features/projects/ProjectRoutePage.tsx`
- Modify: `poc4/frontend/src/features/projects/projectQueries.ts`
- Modify: `poc4/frontend/src/features/projects/ProjectsPage.test.tsx`
- Modify: `poc4/frontend/src/features/projects/ProjectCard.test.tsx`
- Modify: `poc4/frontend/src/api/httpClient.test.ts`

**Interfaces**

```ts
export type ProjectState = 'CREATING' | 'READY' | 'FAILED' | 'DELETING';
// ApiErrorCode / API_ERROR_CODES 同时新增：
// PROJECT_CREATING, PROJECT_BUSY, PROJECT_CLEANUP_INCOMPLETE
```

- [ ] **Step 1 — 写 UI 和解码 RED。** 复用 ProjectsPage.test.tsx 的 router/mock 场景，给列表、详情和已经打开的工作台推送 DELETING。断言没有 Workbench、Open/Run/Save 入口，不清除 dirty buffer；显示 Deleting/Project is being deleted 和回到列表链接。新增错误码通过 allowlist，但未知 code/raw message 仍受现有保护。

```ts
it('keeps polling a deleting project without opening a workbench', () => {
  const project: ProjectSummary = {
    id: 'p1', name: 'Deleting project', state: 'DELETING',
    createdAt: '2026-09-10T00:00:00Z', failureReason: null,
  };
  expect(projectDetailRefetchInterval({ state: { data: project } })).toBe(1000);
  expect(projectsRefetchInterval({ state: { data: { items: [project], limit: 8 } } }))
    .toBe(1000);
});
```

- [ ] **Step 2 — 执行 RED。**

```powershell
Set-Location -LiteralPath (Join-Path $wt 'poc4/frontend')
pnpm exec vitest run src/features/projects/ProjectsPage.test.tsx src/features/projects/ProjectCard.test.tsx src/api/httpClient.test.ts
```

- [ ] **Step 3 — 实现显式状态分支。** 不能只在类型中加字符串而让路由继续落入原默认 READY 分支。

```tsx
if (project.state === 'DELETING') {
  return (
    <AppChrome title={project.name}>
      <div role="status">Project is being deleted</div>
      <Link to="/projects">Back to projects</Link>
    </AppChrome>
  );
}
// WorkbenchRoute 只在显式 state === 'READY' 时挂载。
```

将轮询条件改为 CREATING 或 DELETING；DELETING 不自动重试 DELETE。详情变 404 时回到“项目不可用”的安全视图，不再次读取 files/Run/terminal。未保存缓冲区保留到用户按现有明确丢弃流程处理；若现有组件卸载会清空缓冲区，必须先补这一路径的失败回归再作局部修复。

- [ ] **Step 4 — GREEN、类型检查及提交。**

```powershell
pnpm exec vitest run src/features/projects/ProjectsPage.test.tsx src/features/projects/ProjectCard.test.tsx src/api/httpClient.test.ts
pnpm typecheck
pnpm test
git diff --check
git add -- src/contracts/project.ts src/contracts/api.ts src/api/httpClient.ts src/features/projects/ProjectCard.tsx src/features/projects/ProjectRoutePage.tsx src/features/projects/projectQueries.ts src/features/projects/ProjectsPage.test.tsx src/features/projects/ProjectCard.test.tsx src/api/httpClient.test.ts
git commit -m 'feat(stage6): render deleting projects as unavailable'
```

**完成条件：** DELETING 不会误开工作台；quota 仍按列表中全部项目计数；没有新增删除按钮或改变现有编辑/Run 协议。

---

## Task RC-6：持久化测试台账、创建响应核对与逐项目清理核心

**Files**
- Create: `poc4/frontend/tests/support/stage6-cleanup/contracts.ts`
- Create: `poc4/frontend/tests/support/stage6-cleanup/ledger.ts`
- Create: `poc4/frontend/tests/support/stage6-cleanup/engine.ts`
- Create: `poc4/frontend/tests/support/stage6-cleanup/http-transport.ts`
- Create: `poc4/frontend/tests/unit/stage6-cleanup-ledger.test.ts`
- Create: `poc4/frontend/tests/unit/stage6-cleanup-engine.test.ts`
- Create: `poc4/frontend/vitest.stage6-cleanup.config.ts`
- Create: `poc4/frontend/tsconfig.stage6.json`
- Modify: `poc4/frontend/package.json`

**Interfaces**

```ts
export type CleanupState = 'PREPARED' | 'OWNED' | 'CREATE_UNCERTAIN'
  | 'API_CLEANED' | 'HELD' | 'UNRESOLVED' | 'VERIFIED';
export type CleanupEntry = {
  schemaVersion: 1; invocationId: string; testId: string; attempt: number; workerKey: string;
  entryId: string; ownerId: string; ownerKey: string; exactName: string;
  preparedAt: string; projectId: string | null; runIds: string[];
  state: CleanupState; issueCodes: string[];
};
export interface CleanupLedger {
  write(entry: CleanupEntry): Promise<void>;
  readAll(): Promise<CleanupEntry[]>;
}
export type ProjectView = {
  id: string; name: string; state: 'CREATING' | 'READY' | 'FAILED' | 'DELETING';
  createdAt: string;
};
export type ReadProject = { status: 200; project: ProjectView } | { status: 404 };
export type DeleteProject = { status: 204 | 404 | 409 | 503; code?: string };
export interface CleanupTransport {
  verifyOwner(ownerKey: string, expectedOwnerId: string): Promise<void>;
  createProject(ownerKey: string, exactName: string): Promise<ProjectView>;
  listProjects(ownerKey: string): Promise<ProjectView[]>;
  getProject(ownerKey: string, projectId: string): Promise<ReadProject>;
  deleteProject(ownerKey: string, projectId: string, timeoutMs: number): Promise<DeleteProject>;
  getActiveRun(ownerKey: string, projectId: string): Promise<{ id: string; state: string } | null>;
  stopRun(ownerKey: string, projectId: string, runId: string): Promise<void>;
}
export interface CleanupClock { now(): number; sleep(ms: number): Promise<void>; }
export type CleanupPolicy = {
  createResolveMs: number; creatingWaitMs: number; projectDeadlineMs: number;
  deleteRequestMs: number; allowStopRecordedRuns: boolean;
};
export type SweepReport = { entries: CleanupEntry[]; issues: { entryId: string; code: string }[] };
export declare class Stage6CleanupEngine {
  constructor(ledger: CleanupLedger, transport: CleanupTransport,
              clock: CleanupClock, policy: CleanupPolicy);
  createRegistered(entry: CleanupEntry): Promise<ProjectView>;
  cleanupOne(entry: CleanupEntry): Promise<CleanupEntry>;
  sweep(): Promise<SweepReport>;
}
```

此签名块是实现契约；实现文件应提供完整方法体。实际 ownerId 必须来自登录返回的 user.id，不从未经验证的 JWT 文本猜测。HTTP adapter 在内存中取新 token；认证错误抛出安全分类，禁止把 401 当 404。

- [ ] **Step 1 — 写 ledger RED。** 使用操作系统临时目录，覆盖：落盘后新实例读回、异常条目不丢失、两个不同测试文件并行写入、路径穿越/reparse/其他 invocation 拒绝、HOLD 单槽原子竞争、保存内容无 token/密码。测试只删除自己创建且路径核验通过的临时目录。

- [ ] **Step 2 — 写 engine RED。** Vitest fake transport + 可推进的 clock，断言调用次数而不是只检查终态。核心“响应丢失只 POST 一次”示例：

```ts
it('reconciles a lost create response without another POST', async () => {
  const entry: CleanupEntry = {
    schemaVersion: 1, invocationId: 'inv-1', testId: 'case-1', attempt: 0, workerKey: 'worker-1',
    entryId: 'entry-1', ownerId: 'owner-a', ownerKey: 'alice',
    exactName: 'stage6-inv-1-case-1', preparedAt: '2026-09-10T00:00:00Z',
    projectId: null, runIds: [], state: 'PREPARED', issueCodes: [],
  };
  const project: ProjectView = { id: 'p1', name: entry.exactName,
    state: 'CREATING', createdAt: entry.preparedAt };
  const saved: CleanupEntry[] = [];
  const ledger: CleanupLedger = {
    write: async value => { saved.push(structuredClone(value)); },
    readAll: async () => saved.slice(-1),
  };
  const transport: CleanupTransport = {
    verifyOwner: vi.fn().mockResolvedValue(undefined),
    createProject: vi.fn().mockRejectedValue(new Error('TRANSPORT_UNCERTAIN')),
    listProjects: vi.fn().mockResolvedValue([project]),
    getProject: vi.fn(), deleteProject: vi.fn(), getActiveRun: vi.fn(), stopRun: vi.fn(),
  };
  const clock: CleanupClock = { now: () => Date.parse(entry.preparedAt), sleep: async () => {} };
  const engine = new Stage6CleanupEngine(ledger, transport, clock, {
    createResolveMs: 30000, creatingWaitMs: 180000, projectDeadlineMs: 300000,
    deleteRequestMs: 110000, allowStopRecordedRuns: true,
  });
  expect((await engine.createRegistered(entry)).id).toBe('p1');
  expect(transport.createProject).toHaveBeenCalledTimes(1);
  expect(saved[0].state).toBe('PREPARED');
  expect(saved.at(-1)?.projectId).toBe('p1');
});
```

矩阵还必须包括：列表先空后出现、多个精确匹配、不匹配 owner/name/时间窗、持续 401/timeout；DELETE 丢响应后 GET=DELETING/404；第一个项目异常仍处理第二个；CREATING 到期不取消；未知 active Run 不停止；HELD 不删除；API_CLEANED 不直接标 VERIFIED。

- [ ] **Step 3 — 独立 Node 环境测试配置并运行 RED。** 不改变现有全应用 Vitest 的 jsdom/排除规则，也不依赖未声明的 tsx。

```ts
// vitest.stage6-cleanup.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  environment: 'node', include: ['tests/unit/stage6-cleanup-*.test.ts'],
  restoreMocks: true,
} });
```

```powershell
pnpm exec vitest run --config vitest.stage6-cleanup.config.ts
```

- [ ] **Step 4 — 实现 createRegistered 和完整的只读 reconciliation。** 在 `engine.ts` 实现以下方法和 helper；先验证登录身份与台账 ownerId 一致，落盘失败时不得 POST。

```ts
async createRegistered(entry: CleanupEntry): Promise<ProjectView> {
  await this.transport.verifyOwner(entry.ownerKey, entry.ownerId);
  await this.ledger.write(entry);
  let project: ProjectView;
  try {
    project = await this.transport.createProject(entry.ownerKey, entry.exactName);
  } catch {
    await this.ledger.write({ ...entry, state: 'CREATE_UNCERTAIN',
      issueCodes: [...entry.issueCodes, 'CREATE_RESPONSE_UNCERTAIN'] });
    return reconcileCreatedProject(entry, this.ledger, this.transport,
      this.clock, this.policy.createResolveMs);
  }
  await this.ledger.write({ ...entry, projectId: project.id, state: 'OWNED' });
  return project;
}

async function reconcileCreatedProject(
  entry: CleanupEntry, ledger: CleanupLedger, transport: CleanupTransport,
  clock: CleanupClock, resolveMs: number,
): Promise<ProjectView> {
  const deadline = clock.now() + resolveMs;
  const earliest = Date.parse(entry.preparedAt) - 5000;
  let unavailable = false;
  while (clock.now() < deadline) {
    await transport.verifyOwner(entry.ownerKey, entry.ownerId);
    let projects: ProjectView[];
    try {
      projects = await transport.listProjects(entry.ownerKey);
    } catch {
      unavailable = true;
      await clock.sleep(Math.min(250, Math.max(0, deadline - clock.now())));
      continue;
    }
    const matches = projects.filter(p => p.name === entry.exactName
      && Date.parse(p.createdAt) >= earliest
      && Date.parse(p.createdAt) <= clock.now() + 5000);
    if (matches.length > 1) {
      await ledger.write({ ...entry, state: 'UNRESOLVED',
        issueCodes: [...entry.issueCodes, 'CREATE_IDENTITY_AMBIGUOUS'] });
      throw new Error('CREATE_IDENTITY_AMBIGUOUS');
    }
    if (matches.length === 1) {
      const project = matches[0];
      await ledger.write({ ...entry, projectId: project.id, state: 'OWNED' });
      return project;
    }
    await clock.sleep(Math.min(250, Math.max(0, deadline - clock.now())));
  }
  const code = unavailable ? 'CREATE_RECONCILIATION_UNAVAILABLE' : 'CREATE_IDENTITY_UNRESOLVED';
  await ledger.write({ ...entry, state: 'UNRESOLVED', issueCodes: [...entry.issueCodes, code] });
  throw new Error(code);
}
```

owner/name/invocation 字段在 ledger 读取时严格校验，exactName 必须由当前 invocation 生成；以上核对只接受 5 秒的时间偏差，preflight 若发现更大时钟偏差则停止核对，不静默扩大窗口。账号认证失败由上层 sweep 保留 UNRESOLVED；没有第二次项目 POST。明确的业务拒绝可以由 adapter 记录安全 code，但也不得生成新的创建请求。

- [ ] **Step 5 — 实现 cleanupOne 和真正逐项容错的 sweep。** `cleanupOne` 先跳过 HELD/VERIFIED；对 projectId=null 的意图仅调用同一个只读 reconciliation helper。重新验证 owner，读取当前项目状态并按规格有界处理；只有 DELETE/GET 证实 API 不存在时标记 API_CLEANED。READY/FAILED/DELETING、CREATING、active Run、401/403、网络不确定、截止时间各自返回明确结果。

```ts
async sweep(): Promise<SweepReport> {
  const snapshot = await this.ledger.readAll(); // 无法读取范围时，在任何 DELETE 前失败。
  const entries: CleanupEntry[] = [];
  const issues: SweepReport['issues'] = [];
  for (const entry of snapshot) {
    try {
      entries.push(await this.cleanupOne(entry));
    } catch {
      let latest = entry;
      try {
        latest = (await this.ledger.readAll()).find(e => e.entryId === entry.entryId) ?? entry;
      } catch { issues.push({ entryId: entry.entryId, code: 'LEDGER_READ_FAILED' }); }
      const failed: CleanupEntry = { ...latest, state: 'UNRESOLVED',
        issueCodes: [...latest.issueCodes, 'CLEANUP_REQUEST_FAILED'] };
      entries.push(failed);
      try { await this.ledger.write(failed); }
      catch { issues.push({ entryId: entry.entryId, code: 'LEDGER_WRITE_FAILED' }); }
    }
  }
  return { entries, issues };
}
```

不能用旧 snapshot 覆盖在 cleanupOne 中刚核对出的 projectId。ledger 写失败仍在 SweepReport 记录，使 suite 失败；其他已登记项目继续处理。每项使用同一个截止时间，剩余预算不足时不再新发 DELETE；不盲重发 stopRun，先 GET Run 状态核对。以 API_CLEANED 结束的条目必须继续交给 RC-8 verifier。

- [ ] **Step 6 — GREEN 与类型检查。** `tsconfig.stage6.json` 采用现有 ESNext/Bundler 配置、noEmit=true，显式包含 tests/support、tests/unit、stage6 E2E、Playwright 工具 config；types 包含 node，lib 包含 DOM 以支持 page.evaluate。不能声称原 `pnpm typecheck` 已覆盖被现有 tsconfig 排除的 E2E。

```powershell
pnpm exec vitest run --config vitest.stage6-cleanup.config.ts
pnpm exec tsc -p tsconfig.stage6.json --noEmit
pnpm typecheck
git diff --check
```

新增 package scripts：`test:stage6:cleanup:unit` 对应上述 Vitest 命令，`typecheck:stage6` 对应新 tsc 命令。

- [ ] **Step 7 — 逐项暂存新 helper/config 与 package.json 后提交。**

```powershell
git add -- tests/support/stage6-cleanup/contracts.ts tests/support/stage6-cleanup/ledger.ts tests/support/stage6-cleanup/engine.ts tests/support/stage6-cleanup/http-transport.ts tests/unit/stage6-cleanup-ledger.test.ts tests/unit/stage6-cleanup-engine.test.ts vitest.stage6-cleanup.config.ts tsconfig.stage6.json package.json
git commit -m 'test(stage6): persist cleanup ownership and reconcile uncertain requests'
```

**完成条件：** 创建不确定场景没有第二次 POST；失败项目不会从台账消失；helper 的真实类型检查和 Node 环境测试通过，没有新增依赖。

---

## Task RC-7：三个 E2E 套件接入逐项清理、worker/套件兜底和显式 resume

**Files**
- Create: `poc4/frontend/tests/support/stage6-cleanup/fixtures.ts`
- Create: `poc4/frontend/tests/support/stage6-cleanup/global-setup.ts`
- Create: `poc4/frontend/tests/support/stage6-cleanup/global-teardown.ts`
- Create: `poc4/frontend/tests/unit/stage6-cleanup-fixtures.test.ts`
- Create: `poc4/frontend/tests/tools/stage6-cleanup-resume.spec.ts`
- Create: `poc4/frontend/playwright.stage6-tools.config.ts`
- Modify: `poc4/frontend/tests/e2e/stage6-real-backend.spec.ts`
- Modify: `poc4/frontend/tests/e2e/stage6-terminal-stress.spec.ts`
- Modify: `poc4/frontend/tests/e2e/stage6-faults.spec.ts`
- Modify: `poc4/frontend/playwright.config.ts`
- Modify: `poc4/frontend/package.json`
- Modify: `poc4/frontend/tsconfig.stage6.json`

**Interfaces**

```ts
// fixtures.ts
export interface Stage6Resources {
  createProject(ownerKey: string, caseKey: string): Promise<ProjectView>;
  recordRun(projectId: string, runId: string): Promise<void>;
  finish(): Promise<SweepReport>;
}
// 导出扩展后的 test 与 expect，三个 spec 必须统一从此文件导入。
// global-setup/global-teardown：export default async function (config: FullConfig): Promise<void>
```

每个测试使用只暴露本 testId/attempt/workerKey 条目的 scoped ledger；worker teardown 只处理自己的 workerKey。只有 global teardown 在所有 worker 结束后才能读整个 invocation。不能让一个用例的 sweep 删除另一个正在运行用例的项目。

- [ ] **Step 1 — fixture 范围、HOLD 和 resume 的 RED。** 用内存 transport/临时 ledger 测试：
  - 第一个测试 finish 不碰第二个测试的项目；同一个测试创建两个项目时均被释放。
  - 测试 body 已失败时，cleanup 失败只追加独立错误报告，不抹掉原始失败。
  - 新 worker 实例能从旧 worker 的持久台账找到未完成项；global teardown 负责最终兜底。
  - 模拟终止 hook 未执行，resume inspect 模式零网络/零 DELETE；Apply 只处理指定 invocation。
  - 两个 worker 同时请求 HOLD，只有精确匹配者成功占用单槽；既有诊断和其他 invocation 不被扫描。

```powershell
pnpm exec vitest run --config vitest.stage6-cleanup.config.ts
```

- [ ] **Step 2 — global setup 生成唯一 invocation 和报告目录。** setup 在主进程生成 ID，并通过环境传给 worker；不得由每个 worker 各自生成一个“本次套件”ID。已有目录只允许恢复，不允许静默覆盖。manifest 记录 schemaVersion、invocationId、codeSha、case 集合、创建时间及只读模式，不含凭据。

```ts
// 目录必须先经过 ledger 的 workspace/报告根路径验证。
const invocationId = process.env.STAGE6_INVOCATION_ID ?? crypto.randomUUID();
process.env.STAGE6_INVOCATION_ID = invocationId;
// STAGE6_CLEANUP_LEDGER_DIR 指向该 invocation 的唯一 ledger 子目录。
```

只有 STAGE6_GATE=1 时 shared config 挂载 setup/teardown；Stage 0-5 和 mock 测试不触发本机制。Stage 6 默认 workers=1、retries=0，降低真实节点压力；helper 单测仍验证多 worker 的隔离能力。

- [ ] **Step 3 — 自动 test fixture 及独立 request context。** `fixtures.ts` 中定义 `createResources(testInfo)`，创建本测试 scoped ledger、RC-6 engine 和独立 APIRequestContext；`finish()` 在 finally 中关闭该 context。

```ts
// fixture 核心时序；createResources 在本文件实现，使用 RC-6 的四个 helper 文件。
resources: [async ({}, use, testInfo) => {
  const resources = await createResources(testInfo);
  try {
    await use(resources);
  } finally {
    const report = await resources.finish();
    const entries = report.entries;
    await testInfo.attach('stage6-cleanup.json', {
      body: Buffer.from(JSON.stringify(report, null, 2)), contentType: 'application/json',
    });
    const incomplete = report.issues.length > 0
      || entries.some(e => e.state === 'UNRESOLVED' || e.state === 'HELD');
    if (incomplete && testInfo.status === testInfo.expectedStatus) {
      throw new Error('STAGE6_CLEANUP_INCOMPLETE');
    }
  }
}, { auto: true, timeout: 660000 }]
```

worker fixture 和 global teardown 使用独立的新 request context，不复用已经销毁的 page.request。先保存脱敏结果再抛错，列表中不得拼接 raw response.text()。

- [ ] **Step 4 — 替换三个 spec 的项目创建 helper。** 删除基础套件的模块级 `createdProjectIds` 及旧 afterAll；所有 createProject 改为 resources.createProject。所有成功取得 Run ID 的位置立即 await resources.recordRun。业务断言、Run 终态允许集合、8 MiB/credit/字节断言、故障注入与恢复判据保持原样。

```ts
import { expect, test } from '../support/stage6-cleanup/fixtures';

// 既有测试体只调整资源获得与登记，不放宽任何验收条件。
const project = await resources.createProject('alice', 'owner-isolation');
// Run 创建响应解析后：await resources.recordRun(project.id, run.id);
```

不要通过注册 resources fixture 却继续直接 page.request.post('/projects') 的方式漏掉资源台账。增加静态边界检查：三个 spec 不得残留裸项目 POST 或直接项目 DELETE；这类调用只允许存在于受测 HTTP adapter。

- [ ] **Step 5 — suite 兜底与不确定请求处理。** global teardown 扫完整 invocation；失败项目继续留在台账，响应 404 只置 API_CLEANED。backend/tunnel 尚未恢复时，记录 UNRESOLVED 并使套件最终失败；不得自动改用管理员 kubeconfig、跳过清理或无界重试。

```ts
const report = await engine.sweep();
const incomplete = report.entries.filter(e => !['API_CLEANED', 'VERIFIED'].includes(e.state));
await writeSummary(report); // 本文件实现：校验输出目录后以 UTF-8 写入完整 report。
if (report.issues.length > 0 || incomplete.length > 0) {
  throw new Error('STAGE6_CLEANUP_INCOMPLETE');
}
```

后续 RC-8 独立核验成功前，套件报告只能写 API_CLEANED，不能自称“环境零残留”。

- [ ] **Step 6 — 独立、默认只读的 resume 工具。** Playwright tools config 只包含 `tests/tools/stage6-cleanup-resume.spec.ts`，不注册自动 cleanup fixtures 或 global teardown。inspect 只读取/校验 manifest 和输出精确操作清单；Apply 才登录原 owner、查询状态并续作。为避免引入 tsx，使用现有 Playwright TypeScript loader 运行这个工具。

```ts
// playwright.stage6-tools.config.ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/tools', testMatch: 'stage6-cleanup-resume.spec.ts',
  workers: 1, retries: 0, reporter: 'list', timeout: 660000,
});
```

入口参数固定为环境变量：
- `STAGE6_CLEANUP_LEDGER_DIR`：现有 invocation 的绝对目录，必填。
- `STAGE6_INVOCATION_ID`：必须与 manifest 一致，必填。
- `STAGE6_CLEANUP_APPLY=1`：明确启用副作用；默认只读。
- `STAGE6_RELEASE_HOLD_PROJECT_ID`：可选，只能解除该 invocation 中精确匹配的单项 HOLD，且须同时 Apply。

```powershell
# 以下为实施后的人工入口；本次没有运行。
$env:STAGE6_CLEANUP_APPLY = '0'
pnpm exec playwright test --config playwright.stage6-tools.config.ts
# 审阅清单后，操作者可明确改为 Apply；认证信息仍只从私有配置读取。
$env:STAGE6_CLEANUP_APPLY = '1'
pnpm exec playwright test --config playwright.stage6-tools.config.ts
Remove-Item Env:STAGE6_CLEANUP_APPLY
```

禁止提供 `--all-projects`、按宽 name prefix 扫描删除或以任意 JSON projectId 列表跳过 owner/来源校验。历史项目不在 manifest 时只能报告不在范围内。

- [ ] **Step 7 — 本地 GREEN、真实接线前停止。**

```powershell
pnpm exec vitest run --config vitest.stage6-cleanup.config.ts
pnpm exec tsc -p tsconfig.stage6.json --noEmit
pnpm typecheck
pnpm test
pnpm exec playwright test --project=stage6 --list
git diff --check
```

这里 `--list` 仅证明发现/装配，不记作 E2E PASS。实际三套业务矩阵不在本步运行。

- [ ] **Step 8 — 显式暂存并提交。**

```powershell
git add -- tests/support/stage6-cleanup/fixtures.ts tests/support/stage6-cleanup/global-setup.ts tests/support/stage6-cleanup/global-teardown.ts tests/unit/stage6-cleanup-fixtures.test.ts tests/tools/stage6-cleanup-resume.spec.ts playwright.stage6-tools.config.ts tests/e2e/stage6-real-backend.spec.ts tests/e2e/stage6-terminal-stress.spec.ts tests/e2e/stage6-faults.spec.ts playwright.config.ts package.json tsconfig.stage6.json
git commit -m 'test(stage6): unify per-test cleanup and explicit recovery across suites'
```

**完成条件：** 三个套件全接入；worker/套件兜底可测；工具默认只读；业务断言无放宽，尚不声称真实 E2E 通过。

---

## Task RC-8：受限身份的真实清理专项、基础回归及独立残留核验

**Files**
- Create: `poc4/frontend/tests/e2e/stage6-cleanup.spec.ts`
- Create: `poc4/frontend/scripts/run-stage6-cleanup.ps1`
- Create: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectCleanupEvidenceTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectCleanupEvidenceParserTest.java`
- Modify: `poc4/frontend/playwright.config.ts`
- Modify: `poc4/frontend/package.json`
- Create: `poc4/docs/evidence/stage-6/cleanup-acceptance.md`
- Modify only after measured results: `poc4/docs/evidence/stage-6/2026-09-10-status-and-next-steps.md`

**Interfaces**
- `run-stage6-cleanup.ps1 -Suite cleanup|basic -EvidenceDir $evidenceDir`：顺序执行明确选择的套件与独立核验，不启动/停止服务，不隐式注入故障。
- `ProjectCleanupEvidenceTest`：只有 `-Dmanao.stage6.cleanup.verify=true` 时执行；只读，禁止 Spring 应用启动、迁移、JdbcStoreTestSupport、SQL DELETE/DROP/UPDATE 和 Kubernetes create/delete。
- 输入：`STAGE6_CLEANUP_LEDGER_DIR`、`STAGE6_VERIFY_DB_URL/USERNAME/PASSWORD`、`KUBECONFIG`、`MANAO_K8S_NAMESPACE`；全部显式配置，不回退到生产/管理员默认值。
- 输出：每个登记项目的资源数量、DB 数量、读取错误、前后差分和受保护诊断比对；敏感变量值不进入报告。

### 8.1 先实现离线证据核验测试

- [ ] **Step 1 — verifier 的 RED。** 在 ProjectCleanupEvidenceParserTest.java 增加 parser/匹配测试：陌生 invocation、未知 owner、非法路径、缺少 Run ID 前快照、资源读取 Forbidden、API 404 但 Pod/PVC/DB 仍在均不能 VERIFIED。单元部分不连接真实集群，以 `mvn -B '-Dtest=ProjectCleanupEvidenceParserTest' test` 观察 RED/GREEN；真实 verifier 使用 EnabledIfSystemProperty 显式 gating，普通构建中的跳过必须计数。

```java
// 在显式 real verifier 中使用只读连接；projectId 是已校验 manifest 数据，使用参数绑定。
try (var connection = java.sql.DriverManager.getConnection(url, username, password)) {
    connection.setReadOnly(true);
    try (var statement = connection.prepareStatement("SELECT COUNT(*) FROM project WHERE id=?")) {
        statement.setString(1, projectId);
        try (var result = statement.executeQuery()) {
            assertThat(result.next()).isTrue();
            assertThat(result.getLong(1)).isZero();
        }
    }
}
```

只读连接只是额外保护，不替代受限读取凭据与查询 allowlist。依次核验 project、workspace_operation、run、log_ticket、terminal_session、terminal_audit；run_log_chunk 使用删除前保存的 Run ID 集合，不能在 Run 已删后用空 join 假证为零。

- [ ] **Step 2 — Kubernetes/本地进程核验。** 使用受限客户端逐类型查询 managed-by + projectId + stage6-test；四类都成功且为空才合格。bridge PID/端口由删除前后精确项目快照匹配，不能仅凭某个端口无人监听或 JVM manager map 已清空断言进程不存在。无权限/证据缺失记录未核验，不视为空集合。

- [ ] **Step 3 — runner 保存所有退出码。** runner 使用 try/finally，业务测试失败仍执行安全的兜底/独立核验，最终退出码保留失败。禁止把最后一次成功命令的 `$LASTEXITCODE` 冒充整个运行结果。

```powershell
$e2eExit = 1
$verifyExit = 1
try {
    pnpm exec playwright test $spec --project=stage6 --workers=1 --reporter=list,json
    $e2eExit = $LASTEXITCODE
}
finally {
    Push-Location -LiteralPath $backendDir
    try {
        mvn -B '-Dtest=ProjectCleanupEvidenceTest' '-Dmanao.stage6.cleanup.verify=true' test
        $verifyExit = $LASTEXITCODE
    }
    finally { Pop-Location }
}
if ($e2eExit -ne 0 -or $verifyExit -ne 0) { exit 1 }
```

`$spec` 由 Suite 的固定 allowlist 转换，只允许 cleanup 或 basic；`$backendDir` 从经过核验的工作树计算。runner 生成唯一证据目录、设置 JSON reporter 输出路径，保存 SHA/checksum/身份/参数和两个退出码。EvidenceDir 由已创建并核验的 `$evidenceDir` 变量传入。

### 8.2 真实运行前置门（必须取得运行授权）

- [ ] **Step 4 — 记录前置事实。** 复核当前 SHA、工作树改动、backend 构建 checksum、实际启动构建、前端 MSW 关闭、4173 -> 18080、restricted SA 身份、节点可调度容量、quota 与剩余项目名额。只读盘点历史诊断但不删除；本次 test project 名/ID 不得匹配既有诊断。
- [ ] **Step 5 — 运行明确启用的 preflight。**

```powershell
Set-Location -LiteralPath (Join-Path $wt 'poc4/backend')
mvn -B '-Dtest=Stage6aPreflightTest' '-Dmanao.stage6.real=true' test
```

必须确认实际执行 real 路径，且 KUBECONFIG 与 MANAO_K8S_NAMESPACE 正确；不能只看 Java 测试返回 0 或其中 pure tests PASS。后端使用受限身份，容量检查若需管理员只读身份则单独标注，不更换后端身份。

前置不满足时停止：不启动应用去碰迁移权限，不降低 RBAC 断言，不扩大 namespace quota，不修改 runtime schema 去修测试。节点状态和 token 有时效性，历史快照不能代替此项。

### 8.3 专项矩阵与证据层级

| ID | 场景 | 强制证据 |
|---|---|---|
| C01 | owner 与其他项目隔离，重复删除 | 正确 owner 204；非 owner 404且零副作用；重复请求核对后确认不存在；其他项目快照不变。 |
| C02 | initializer 遗留、混合 workload 清理 | Fabric8 adapter 自动回归必须覆盖 Failed/Succeeded/Pending initializer；真实专项使用本次一次性项目的真实 initializer/Pod/PVC 快照确认全删。 |
| C03 | CREATING 并发 DELETE | 观察到 CREATING 后 DELETE=409，Pod/PVC 不被此 DELETE 改动；创建继续，最终正常清理。 |
| C04 | active Run 冲突 | Run 处于 active 时 DELETE=409/RUN_ALREADY_ACTIVE；先留证，再显式停止台账中该 Run；核对终态后清理。 |
| C05 | 创建响应丢失 | HTTP adapter 在真实 POST 生效后丢弃响应；只发一次 POST，列表精确绑定 ID，最后无残留。这是客户端响应边界注入，不冒充真实隧道故障。 |
| C06 | DELETE 响应丢失 | 真实 DELETE 后丢弃响应；GET 核对后转 API_CLEANED，独立 verifier 检查零残留。 |
| C07 | 单项失败与后续继续 | mock-server/JDBC 确定性测试证明单资源故障；adapter 注入第一个项目的异常，第二个真实项目仍完成清理；第一个保留精确台账再显式恢复。 |
| C08 | 中断后显式续作 | 单测重建服务/worker 必须通过；另经单独授权对本次 DELETING 项目执行一次后端重启或测试进程中断，恢复后用原台账续作并核验。 |

真实 C02 若需要补一个遗留 initializer，只能使用当前 factory/固定镜像 digest 在**已登记的一次性项目**下构造同名同标签资源，先核验 owner/UID/PVC。不得复用历史 `083b8efd...`，不得改全局配额或生产镜像。它证明真实清理覆盖；异常 provisioning 的各分支仍由服务和 adapter 回归分别证明。

C03/C04 必须实际观察到所需状态；如果状态已推进、未取得预条件，记录该项未获得证据并停止该专项，不放宽成接受任意状态，不无限创建新项目重试。先调整经过授权的单项目夹具/观察时序再重新运行。

C08 的实际重启/进程终止需要明确目标 PID、启动方式、健康恢复步骤和操作者授权；脚本不猜测命令、不扫描/杀死所有 Java/Node 进程。未获授权时该项保持未执行，不能给出完整 CLEANUP_SLICE_PASS。

C08 实施补充（显式续作语义，不是启动扫描）：

1. C08 的 resume 使用有限预算内的状态核对和显式续作，而不是假设一次 DELETE 必然成功。重启后先 GET：已 404 则进入集群核验；仍为 DELETING 则通过 owner-scoped DELETE 续作；503 / 传输不确定则在 `projectDeadlineMs` 内再次 GET 后决定是否再 DELETE；非 DELETING 失败。不得把 DELETING 本身当作通过。
2. Job 查询的 Forbidden/timeout 不能被当作空列表。集群快照必须区分“成功读到零个 Job”和“Job 盘点未知”；未知时 C08 失败。
3. C08 测试体必须在 fixture teardown 之前自行完成最终 404 和集群空快照核验。不得把 Job/Pod/initializer/Service/PVC 清空或最终 404 推迟到 `finish()` / sweep。

- [ ] **Step 6 — 实际执行专项，再执行原五项。** 脚本中设置 STAGE6_GATE=1、retries=0、workers=1，固定同一代码/构建身份；报告目录每轮不同。

```powershell
Set-Location -LiteralPath (Join-Path $wt 'poc4/frontend')
$env:STAGE6_GATE = '1'
$runId = [Guid]::NewGuid().ToString('N')
$env:STAGE6_INVOCATION_ID = $runId
$evidenceDir = Join-Path $PWD.Path ('playwright-report/stage6-cleanup-' + $runId)
.\scripts\run-stage6-cleanup.ps1 -Suite cleanup -EvidenceDir $evidenceDir
# 专项通过且残留核验完成后，原五项使用新的 runId/证据目录再运行 -Suite basic。
```

上面的真实命令只用于实施阶段；新增专项需在 playwright.config.ts 的 stage6 testMatch 中显式加入 cleanup。`--list` 仅记录发现数量，不计入任何 C01-C08 PASS。

- [ ] **Step 7 — 校验压力/故障套件接线，不越界宣布业务验收。** RC-7 的单元和装配检查证明它们使用统一 fixture。完整 stress 和 backend-restart/tunnel-loss/bridge-loss 三种业务矩阵仍按原步骤 3 另行授权运行；在本切片证据表中写 NOT_RUN_IN_THIS_SLICE，而不是 PASS 或隐去 skip。

### 8.4 最终交付与判定

- [ ] **Step 8 — 保存并审阅证据包。** 至少包含：

```text
stage6-cleanup-<invocationId>/
  invocation.json
  list.log
  results.json
  exit-codes.json
  build-and-identity.json
  ledger/<workerKey>/<entryId>.json
  before.json
  cleanup-api-summary.json
  after-kubernetes.json
  after-database.json
  after-local-handles.json
  protected-diagnostics-diff.json
  verification-summary.json
```

每个 API_CLEANED 条目有资源、DB、本地句柄三方证明后才标 VERIFIED。HELD/UNRESOLVED/未执行关键项均阻止 CLEANUP_SLICE_PASS。没有必要提交原始浏览器 trace；任何 trace 保留都必须先敏感信息审查，摘要报告只包含 allowlist 字段。

- [ ] **Step 9 — 文档回填和提交。** `cleanup-acceptance.md` 记录实际 SHA、命令、退出码、测试总数、failed/skipped 和残留；只更新状态文档第 1 点对应条目，继续保留 6A FAILED 和第 2-5 点未闭环状态。

```powershell
Set-Location -LiteralPath $wt
git diff --check
git diff -- AGENTS.md
# 本切片不需要改 AGENTS.md；若 diff 非空，先核对是否混入了用户改动。
git add -- poc4/frontend/tests/e2e/stage6-cleanup.spec.ts poc4/frontend/scripts/run-stage6-cleanup.ps1 poc4/frontend/playwright.config.ts poc4/frontend/package.json poc4/backend/src/test/java/com/manao/poc4/project/ProjectCleanupEvidenceTest.java poc4/backend/src/test/java/com/manao/poc4/project/ProjectCleanupEvidenceParserTest.java poc4/docs/evidence/stage-6/cleanup-acceptance.md poc4/docs/evidence/stage-6/2026-09-10-status-and-next-steps.md
git commit -m 'test(stage6): verify cleanup against scoped cluster and database evidence'
```

**完成条件：** RC-1 至 RC-8 的目标回归通过；专项和原五项均有真实报告、明确退出码、零关键跳过；本次所有条目 VERIFIED，既有诊断和其他 owner 不变。若只完成本地回归，结论只能是 CLEANUP_IMPLEMENTED_REAL_ACCEPTANCE_PENDING。

---

## 9. 需求覆盖与审阅清单

| 需求 | 实现任务 | 必须看的负向证据 |
|---|---|---|
| 异常 initializer 全覆盖 | RC-3、RC-8 C02 | selector 不再排除 initializer；等待集合与删除集合一致。 |
| CREATING 不取消、并发互斥 | RC-2、RC-4、RC-6、RC-8 C03 | 创建继续、409 无副作用、recovery stale 快照不覆盖 DELETING。 |
| active Run 明确冲突 | RC-2、RC-4、RC-8 C04 | 409 非 404；并发 insertRun 与删除不能同时成功。 |
| DELETING 持久化及显式续作 | RC-1、RC-2、RC-4、RC-8 C08 | 模拟/真实中断后不复活 bridge、不允许写入、不自动扫库。 |
| 逐资源/逐项目容错 | RC-3、RC-4、RC-6、RC-8 C07 | 第一个失败不阻止第二个，PVC/DB 层级保护仍有效。 |
| 每项释放、套件兜底 | RC-6、RC-7 | 多 worker 隔离、进程更换、失败后清单不丢失。 |
| 创建响应丢失先核对 | RC-6、RC-8 C05 | POST 调用次数=1，0/多匹配不会误删或重复创建。 |
| 精确保留一份并显式回收 | RC-6、RC-7 | 单槽竞争、HOLD 解除条件、旧诊断始终不在作用域。 |
| 压力/故障套件统一策略 | RC-7 | 三套无裸项目 POST/DELETE，业务断言未改。 |
| 资源与 DB 独立核验 | RC-8 | Forbidden/缺少权限不是零；Run 删除后不能靠空 join 验日志。 |
| 前端不误开删除中项目 | RC-5 | DELETING 路由不默认进入 Workbench，dirty buffer 不静默丢弃。 |
| 编码、权限、凭据和阶段门 | 全部 | UTF-8 无 BOM、无运行库 reset、无权限扩大、无 6B 文件。 |

## 10. 风险、停止条件与恢复方式

1. **MySQL 迁移/隔离 schema 权限不足：** 停在本地验证前置；由操作者配置测试/迁移角色，不对运行库删表，不替换为内存库。
2. **现有 Run/Job 不一致导致清理前 active 状态无法稳定：** 保存同一 Run 的事实并报告；不在本切片修终态或改断言。清理只能依据明确 owner/台账、当前权威状态和已授权停止操作。
3. **Kubernetes finalizer/RBAC/隧道阻断：** 保留 DELETING 和结构化报告；不手动移除 finalizer、不改为管理员 client；恢复依赖后显式续作。
4. **本地进程/handle 关闭失败：** 保留引用，不删库，不杀全局进程；精确 owner/project/PID 核对后重试。
5. **尚有 DELETING 时回退旧后端：** 旧代码不了解该状态，禁止直接降级运行；先停止流量、盘点这些项目并由支持 V8 的构建完成/处理显式清理，不修改旧 migration checksum，也不强改回 READY。
6. **进程强制退出时 hook 不执行：** 使用已落盘意图而不是内存集合；恢复默认 inspect，再显式 Apply。若连台账都未成功落盘，createRegistered 必须没有发送 POST。
7. **与用户并行改动冲突：** 重新读取文件和 git diff，保留用户改动；不要 reset/clean 整个工作树。
8. **真实运行授权尚缺：** RC-1 至 RC-7 可按另行批准的实施任务进行；RC-8 不自行启动服务或注入故障。缺授权保持真实验收未完成，不伪造 PASS。

## 11. 计划自检记录

本次仅进行了文档和当前源码核对，未实施。实施前审阅重点：

- 规格 I01-I12 与上方覆盖表逐项对应；不存在用 afterAll 通过替代资源核验的步骤。
- 新状态只增加 DELETING，不增加取消创建、自动后台删除或多副本一致性承诺。
- 原始 Run 成功/日志/PTY/audit/压力/故障验收和 6B 阶段门未被本切片合并或弱化。
- 所有新文件均标为 Create，现有落点须按当前磁盘内容小步修改；执行前重新核对 SHA 和构造器调用点。
- 本计划中的预算是有限默认值，任何超时必须留存失败，不允许靠无限扩大超时凑绿。
- 自检完成后仍需实施者按 TDD 观察 RED/GREEN 和实际运行证据；文档不充当测试报告。
