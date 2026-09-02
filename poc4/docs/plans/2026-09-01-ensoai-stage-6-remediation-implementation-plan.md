# 阶段六审查缺陷修复实施计划

> **面向 Agent 执行者：** 必需子技能：使用 superpower-subagent-driven-development（推荐）或 superpower-executing-plans 按任务逐项执行本计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 修复 2026-08-30 阶段六审查报告与 2026-09-01 复核确认的全部阻断缺陷（P0×5、P1×7 及复核新增 6 项），使 6A 真实链路具备可运行性，且 6A Gate 的测试/预检不再可被错误点亮；不改变阶段五浏览器合同。

**架构：** 保持“模块化 Spring Boot 单体 + workspace-agent + MySQL 权威”不动。本计划只做修复性变更：(1) 让 fencing/lease 有续租且 Run 行随权威 token 结算；(2) 让 PTY 使用真实 Pod 名并在握手前做身份核验；(3) 让日志 watch 真正接入并修正字节/行边界；(4) 让 initializer 与 6A 预检 fail-closed；(5) 补上 JDBC 层真实 MySQL 测试底座；(6) 补全 maven-runner 镜像材料、shutdown 生命周期与项目恢复身份校验。

**技术栈：** Java 17、Spring Boot 3.5.9、Spring JDBC、Flyway、MySQL 8（STRICT_TRANS_TABLES）、Fabric8 7.7.0、JUnit 5、AssertJ、Playwright（E2E 仅改 spec 断言）、pnpm、Docker（仅 Task 12 本地构建）。

**规格依据：**
- 设计：`poc4/docs/2026-08-27-ensoai-stage-6-real-backend-kubernetes-design.md`
- 实施计划：`poc4/docs/plans/2026-08-27-ensoai-stage-6-real-backend-kubernetes-implementation-plan.md`
- 修复对象清单（经 2026-09-01 逐行复核）：P0-1 PTY 用 Job 名当 Pod 名；P0-2 fencing token 60s 后失效且无续租；P0-3 审计链路无生产接线；P0-4 maven-runner 镜像材料缺失；P0-5 日志 watch 从未启动；P1-6 `trust_level` VARCHAR(16) 装不下 `WRAPPER_TRANSPORT`；P1-7 initializer 不存在被当作成功；P1-8 真实 preflight 可错误退出 0 且真模式永远无法 PASS；P1-9 E2E 内部 skip/return；P1-10 shutdown 生命周期未接线；P1-11 项目恢复身份校验不足 + labels NPE；P1-12 日志按字符切分/按字节限制。复核新增：N1 JDBC 层零真实 MySQL 测试；N2 Terminal 握手无资源身份核验；N3 Stop 在 token 失配时静默不停 Job（并入 P0-2）；N4 两套 lease 实现并存（并入 P0-2）；N5 reconciliation 失败删除 PVC 违背“保留现场”（并入 P1-11）；N6 `run.fencing_token` NULLABLE 使历史行无法结算（并入 P0-2）。

## 全局约束

- 阶段五 REST/WebSocket 合同（字段、枚举、close code、流控上限）不允许变化；本计划不新增/不升级任何前端依赖。
- 浏览器不得收到 PVC/Pod/Job/Namespace/容器名/集群地址/绝对路径；错误包只暴露有限 `code`、安全 `message`、`traceId`。
- `workspace_revision` 唯一权威是 MySQL；`workspace_operation` 两阶段写入不变。
- Run 锁定态 `STARTING/RUNNING/STOPPING/RECOVERING`，终态 `SUCCEEDED/FAILED/CANCELLED/TIMED_OUT`；所有状态迁移用带版本/状态条件的 UPDATE，0 行必须重读权威状态，禁止用旧状态重试。
- Job 约束不变：`mvn clean test`、Java 17/Maven 3.9、`backoffLimit:0`、`activeDeadlineSeconds:1800`、≤8C/16Gi/10Gi ephemeral、无 RBAC ServiceAccount。
- 日志先持久化再推送，窗口 ≤5 MiB；terminal 通道与日志通道隔离；旧 PTY 永不自动恢复。
- 镜像必须 immutable digest；6A kubeconfig 保留 CA/TLS server name 校验，禁止 `insecure-skip-tls-verify`。
- 6A Gate 未全量 `PASS` 前禁止创建任何 6B Deployment/Secret/Role 资源（本计划不含 6B 内容）。
- Windows 文件 UTF-8 无 BOM；编辑前重读；每次修改后 `git diff --check`；提交信息沿用 `fix(poc4): <摘要>`。
- 不修改、不提交 `.grok/` 与未跟踪文件 `poc4/backend/fix13.py`。
- 测试执行需要真实 MySQL：`MANAO_DB_URL`、`MANAO_DB_USERNAME`、`MANAO_DB_PASSWORD` 环境变量（凭据不进仓库）。

---

## 文件与模块地图（本计划新增/修改）

```text
poc4/backend/src/main/java/com/manao/poc4/
├─ run/JdbcRunStore.java                      [改] fencing 续租、markRunning/settle 去 token、updateJobFacts 写 pod_ref
├─ run/RunStore.java                          [改] 接口同步
├─ run/RunRecord.java                         [改] 携带 fencingToken
├─ run/RunService.java / RunObservationService.java / RunRecoveryService.java   [改] 调用点同步
├─ kubernetes/JobCoordinator.java             [改] + findLivePod
├─ kubernetes/Fabric8JobCoordinator.java      [改] 实现 findLivePod（复用 verifier）
├─ kubernetes/Fabric8KubernetesGateway.java   [改] initializer 不存在=fail、matchesProject 防 NPE、组件标签核验、保留 PVC 清理
├─ terminal/TerminalWebSocketHandler.java     [改] 握手前 LivePodResolver 身份核验、teardownAllSessions
├─ terminal/TerminalStore.java / JdbcTerminalStore.java    [改] + updateLiveRefs
├─ config/WebSocketConfig.java / WorkspaceConfig.java     [改] handler Bean 与 LivePodResolver 接线
├─ config/RuntimeMaintenanceLoop.java         [改] 日志 watch 接入 + lifecycle 接线
├─ log/RunLogIngestor.java                    [改] 挂载计数、字节级切分
├─ log/Utf8ChunkSplitter.java                 [新] 纯函数：按 UTF-8 字节且不切断码点切分
├─ project/ProjectProvisioningService.java    [改] initializer 轮询语义配合
├─ recovery/ProjectRecoveryService.java       [改] 组件标签核验 + 保留 PVC
├─ lifecycle/BackendLifecycleCoordinator.java [改] 作用域化 disposer（按 runId/sessionId）
├─ audit/（本计划仅信任级测试，wrapper/FIFO 接线另立计划见 Task 12 说明）
├─ persistence/JdbcInstanceLeaseRepository.java [改] 标记 @Deprecated（生产已不使用）
└─ src/main/resources/db/migration/V6__remediation_fencing_and_audit.sql   [新]

poc4/backend/src/test/java/com/manao/poc4/
├─ persistence/JdbcStoreTestSupport.java      [新] 真实 MySQL schema 测试底座
├─ run/JdbcRunStoreTest.java                  [新] fencing 续租/过期/takeover 全真实 SQL
├─ kubernetes/Fabric8JobCoordinatorTest.java  [新] findLivePod mock-server
├─ kubernetes/Fabric8KubernetesGatewayTest.java [新] initializer fail-closed/标签 NPE
├─ log/RunLogIngestorTest.java                [改] 字节切分+挂载计数
├─ log/Utf8ChunkSplitterTest.java             [新]
├─ terminal/TerminalWebSocketTest.java        [改] 解析器注入/身份失败 4410/teardownAll
├─ audit/JdbcAuditStoreTest.java              [新] trust_level 真实 MySQL 写入
├─ deploy/Stage6aPreflightTest.java           [改] 真模式 fail-closed + kubeconfigLoader
└─ lifecycle/BackendLifecycleCoordinatorTest.java [改] 作用域 disposer

poc4/frontend/tests/e2e/stage6-real-backend.spec.ts  [改] 去除内部 skip/return

poc4/maven-runner/                            [新]
├─ Dockerfile                                 [新] JDK17+Maven3.9+manao-pty-wrapper(占位)+shell-hook
├─ manao-pty-wrapper                          [新] root-owned 0555 占位 wrapper（审计事件留待审计接线计划）
├─ manao-shell-hook.sh                        [新] bash 集成 hook 占位
└─ README.md                                  [新] 构建/digest 说明与可信度边界声明

poc4/docs/evidence/stage-6/6a-gate.md         [改] 修复轮后更新（在 Task 14 执行）
```

> **关于 P0-3/P0-4 中“审计 wrapper/FIFO 生产接线”的范围界定：** 本计划交付 maven-runner 镜像材料与 wrapper/hook **占位实现**（Task 12），使镜像可构建、digest 可固定；wrapper 的 HMAC 事件/FIFO 消费流/后端 `AuditIngressService` 接线是独立于本批“卡死 6A 真链路”缺陷的功能缺口，单独立项为后续“审计链路实现计划”（Task 14 步骤 6 只要求其在证据中明确标记 `SKIPPED`，不得冒充 PASS）。执行者不得在本计划内顺手实现半个审计协议。

---

## Task 1：为 JdbcRunStore 建立真实 MySQL 测试底座（支撑 P0-2 修复）

**文件：**
- 新建：`poc4/backend/src/test/java/com/manao/poc4/persistence/JdbcStoreTestSupport.java`
- 新建：`poc4/backend/src/test/java/com/manao/poc4/run/JdbcRunStoreTest.java`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/run/JdbcRunStore.java:20-27`（暴露测试时钟）

**接口：**
- 依赖输入：现有 Flyway 迁移 V1–V5；环境变量 `MANAO_DB_URL`（默认 `jdbc:mysql://127.0.0.1:3306/manao_poc4_test`）、`MANAO_DB_USERNAME`、`MANAO_DB_PASSWORD`。
- 对外产出：`JdbcStoreTestSupport.create()` 创建唯一 schema（`manao_stage6_<uuid>`）并执行 Flyway，`close()` 删除 schema；`JdbcRunStore` 新增包私有构造器 `JdbcRunStore(JdbcTemplate, DatabaseClock)`。后续 Task 2/5/6/13 的持久层测试全部复用。

- [ ] **步骤 1：编写失败的测试底座**

```java
// JdbcStoreTestSupport.java（要点，完整版按 FlywaySchemaTest 现有模式扩展）
public final class JdbcStoreTestSupport implements AutoCloseable {
    private final String schema;
    private final DataSource dataSource;
    public static JdbcStoreTestSupport create() {
        String url = System.getenv().getOrDefault("MANAO_DB_URL", "jdbc:mysql://127.0.0.1:3306/manao_poc4_test");
        String user = System.getenv().getOrDefault("MANAO_DB_USERNAME", "manao");
        String pass = System.getenv().getOrDefault("MANAO_DB_PASSWORD", "");
        // 拒绝非 MySQL URL：REAL_MYSQL_REQUIRED（照抄 FlywaySchemaTest:31-32 的守卫）
        // 创建唯一 schema：manao_stage6_<uuid>；Flyway migrate；失败即 AssertionError("REAL_MYSQL_BLOCKED: ...")
        // close(): DROP SCHEMA
    }
    public JdbcTemplate jdbc() { ... }
}

// JdbcRunStoreTest.java
class JdbcRunStoreTest {
    static JdbcStoreTestSupport db;
    static MutableClock clock = new MutableClock(Instant.parse("2026-09-01T00:00:00Z"));
    JdbcRunStore store;
    @BeforeAll static void up() { db = JdbcStoreTestSupport.create(); }
    @BeforeEach void seed() { store = new JdbcRunStore(db.jdbc(), new DatabaseClock(clock)); }
    @AfterAll static void down() { db.close(); }

    @Test void acquireReturnsSameTokenWhileSameHolderRenews() {
        long first = store.acquireFencingToken().orElseThrow();
        clock.advance(Duration.ofSeconds(30));          // 仍在 60s TTL 内
        long second = store.acquireFencingToken().orElseThrow();
        assertThat(second).isEqualTo(first);            // 当前实现：0 行续租 -> token 意外变化
    }
}
```

- [ ] **步骤 2：运行测试并确认其失败**

运行（backend 目录，环境变量指向真实 MySQL）：
```powershell
$mvn = (Get-ChildItem "$env:USERPROFILE\.m2\wrapper\dists\apache-maven-3.9.14" -Filter 'mvn.cmd' -Recurse | Select-Object -First 1).FullName
& $mvn -B '-Dtest=JdbcRunStoreTest' test
```
预期：FAIL——`acquireReturnsSameTokenWhileSameHolderRenews` 断言失败（第二次 acquire 使 token 递增）。

- [ ] **步骤 3：编写最小实现（仅暴露测试时钟，不改租约语义）**

```java
// JdbcRunStore.java 构造器部分
public JdbcRunStore(JdbcTemplate jdbc) { this(jdbc, new DatabaseClock()); }
JdbcRunStore(JdbcTemplate jdbc, DatabaseClock clock) { this.jdbc = jdbc; this.clock = clock; }
// 将第 40/45/49/53 行的 Instant.now() 替换为 clock.now()
```

- [ ] **步骤 4：运行测试确认“失败的是租约语义”而非测试设施**

预期：`acquireReturnsSameTokenWhileSameHolderRenews` 仍 FAIL（证明底座可用、缺陷可被观测）；运行 `git diff --check` 通过。

- [ ] **步骤 5：提交**

```powershell
git add poc4/backend/src/test/java/com/manao/poc4/persistence/JdbcStoreTestSupport.java poc4/backend/src/test/java/com/manao/poc4/run/JdbcRunStoreTest.java poc4/backend/src/main/java/com/manao/poc4/run/JdbcRunStore.java
git commit -m "test(poc4): add real-mysql store test foundation"
```

## Task 2：修复 fencing 租约续租与 Run 结算（P0-2 + N3 + N4 + N6）

**文件：**
- 新建：`poc4/backend/src/main/resources/db/migration/V6__remediation_fencing_and_audit.sql`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/run/JdbcRunStore.java:39-119`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/run/RunStore.java`、`RunRecord.java`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/run/RunService.java`、`RunObservationService.java`、`RunRecoveryService.java`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/persistence/JdbcInstanceLeaseRepository.java`（标记 @Deprecated + Javadoc 指向 JdbcRunStore，最小改动）
- 修改：`poc4/backend/src/test/java/com/manao/poc4/run/JdbcRunStoreTest.java`、`RunControllerTest.java`、`RunObservationServiceTest.java`、`RunRecoveryServiceTest.java`

**接口：**
- 依赖输入：Task 1 的测试底座与测试时钟。
- 对外产出：`RunStore` 语义变更——`markRunning(String runId, String projectId, long expectedVersion)` 与 `settle(String runId, RunState, String, Integer)` **不再接收 fencingToken**（租约在方法内部续租校验）；`RunRecord` 增加 `long fencingToken()`。

- [ ] **步骤 1：编写失败的测试**

```java
// JdbcRunStoreTest 追加（project p1/p2 种子行复用 FlywaySchemaTest 的既有写法）
@Test void runSettlesCorrectlyAcrossLeaseRenewals() {
    long token = store.acquireFencingToken().orElseThrow();
    store.insertRun(run("r1", "p1", 0L), token);
    clock.advance(Duration.ofSeconds(30));
    assertThat(store.acquireFencingToken()).isPresent();
    clock.advance(Duration.ofSeconds(30));              // 累计 60s，旧 TTL 边界
    assertThat(store.acquireFencingToken()).isPresent();
    assertThat(store.markRunning("r1", "p1", 0L)).isTrue();   // 旧实现：fencing_token 不匹配 -> false
    clock.advance(Duration.ofMinutes(10));
    assertThat(store.settle("r1", RunState.SUCCEEDED, "BUILD_SUCCEEDED", 0)).isTrue();
    assertThat(store.findActiveRun("p1")).isEmpty();
}

@Test void sameHolderRenewalNeverBumpsTokenEvenAfterGap() {
    long token = store.acquireFencingToken().orElseThrow();
    clock.advance(Duration.ofSeconds(61));               // 越过 TTL；holder 未变
    long again = store.acquireFencingToken().orElseThrow();
    assertThat(again).isEqualTo(token);                  // 缺陷：holder 不变却 bump，令正常 Run 卡死
}

@Test void takeoverBumpsTokenAndRestampsActiveRuns() {
    long token = store.acquireFencingToken().orElseThrow();
    store.insertRun(run("r2", "p2", 0L), token);
    System.setProperty("manao.instance.id", "after-takeover");   // 模拟新实例接管
    long bumped = store.acquireFencingToken().orElseThrow();
    assertThat(bumped).isGreaterThan(token);
    // 接管后活动 Run 必须被重盖为新 token，恢复流程才能推进（否则永久卡 RECOVERING）
    assertThat(store.findRun("r2").orElseThrow().fencingToken()).isEqualTo(bumped);
    assertThat(store.markRunning("r2", "p2", 0L)).isTrue();
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：`& $mvn -B '-Dtest=JdbcRunStoreTest' test`
预期：FAIL——第一个测试在 `markRunning` 断言失败。

- [ ] **步骤 3：编写最小实现——JdbcRunStore 重写 acquire/markRunning/settle**

```java
// JdbcRunStore.java：acquireFencingToken 替换为“同 holder 续租不 bump；holder 变更才 bump 并重盖活动 Run”
@Override public OptionalLong acquireFencingToken() {
    Instant now = clock.now();
    // 步骤 A：upsert 租约。仅当 holder 变化（真实接管）才 bump；同一 holder 只延长过期。
    jdbc.update(
        "INSERT INTO instance_lease(id, holder_id, fencing_token, expires_at) VALUES (?, ?, 1, ?) " +
        "ON DUPLICATE KEY UPDATE holder_id = VALUES(holder_id), " +
        "fencing_token = IF(holder_id <> VALUES(holder_id), fencing_token + 1, fencing_token), " +
        "expires_at = VALUES(expires_at)",
        LEASE_ID, holder(), Timestamp.from(now.plus(LEASE_TTL)));
    List<Long> tokens = jdbc.query(
        "SELECT fencing_token FROM instance_lease WHERE id = ? AND holder_id = ? AND expires_at >= ?",
        (rs, row) -> rs.getLong(1), LEASE_ID, holder(), Timestamp.from(now));
    if (tokens.isEmpty()) return OptionalLong.empty();
    long token = tokens.get(0);
    // 步骤 B：接管重盖。活动 Run 行的 fencing_token 与当前权威 token 对齐；
    //         同 holder 续租时 token 未变，此 UPDATE 实际写回同值（幂等，行数少）。
    jdbc.update("UPDATE run SET fencing_token = ? WHERE active_run_marker = 1 AND fencing_token <> ?",
        token, token);
    return OptionalLong.of(token);
}

// markRunning/settle：方法内先 renewLease（返回当前 token，失败返回 empty），再以该 token 做条件更新。
// 接管后 acquire 已重盖活动 Run 的 token，因此这里的 token 条件不再误伤同实例正常续租的 Run。
@Override public boolean markRunning(String runId, String projectId, long expectedVersion) {
    OptionalLong token = renewLease();
    if (token.isEmpty()) return false;
    return jdbc.update("UPDATE run SET state='RUNNING', started_at=?, version=version+1, updated_at=? " +
        "WHERE id=? AND project_id=? AND version=? AND state='STARTING' AND fencing_token=?",
        Timestamp.from(clock.now()), Timestamp.from(clock.now()), runId, projectId, expectedVersion,
        token.getAsLong()) == 1;
}

@Override public boolean settle(String runId, RunState state, String terminationReason, Integer exitCode) {
    OptionalLong token = renewLease();
    if (token.isEmpty()) return false;
    return jdbc.update("UPDATE run SET state=?, finished_at=?, exit_code=?, termination_reason=?, version=version+1 " +
        "WHERE id=? AND active_run_marker=1 AND state<>? AND fencing_token=?",
        state.name(), Timestamp.from(clock.now()), exitCode, terminationReason, runId, state.name(),
        token.getAsLong()) == 1;
}

private OptionalLong renewLease() {
    int renewed = jdbc.update(
        "UPDATE instance_lease SET expires_at = ? WHERE id = ? AND holder_id = ? AND expires_at >= ?",
        Timestamp.from(clock.now().plus(LEASE_TTL)), LEASE_ID, holder(), Timestamp.from(clock.now()));
    if (renewed != 1) return OptionalLong.empty();
    List<Long> tokens = jdbc.query(
        "SELECT fencing_token FROM instance_lease WHERE id = ? AND holder_id = ?",
        (rs, row) -> rs.getLong(1), LEASE_ID, holder());
    return tokens.isEmpty() ? OptionalLong.empty() : OptionalLong.of(tokens.get(0));
}
```

- [ ] **步骤 4：同步 RunStore 接口、RunRecord 与全部调用点**

```java
// RunStore.java：markRunning/settle 移除 fencingToken 参数；RunRecord 增加 fencingToken 字段
// RunService.java:64  store.settle(runId, RunState.FAILED, "START_FAILED", null);
// RunService.java:84  transition 保留 token 校验不变（STOPPING 转移仍带 token）
// RunObservationService.java:23-41  保留 observe() 的 acquire 用于 transition；markRunning/settle 换新签名
// RunRecoveryService.java:38-63  同上
```

- [ ] **步骤 5：V6 迁移——backfill fencing_token 并扩容 trust_level**

```sql
-- V6__remediation_fencing_and_audit.sql
UPDATE run r LEFT JOIN instance_lease l ON l.id = 'backend'
SET r.fencing_token = COALESCE(l.fencing_token, 1)
WHERE r.fencing_token IS NULL;   -- 覆盖全部历史行：活动行取当前 token，终态行取 1（不再被更新）

ALTER TABLE run MODIFY COLUMN fencing_token BIGINT NOT NULL;

ALTER TABLE terminal_audit MODIFY COLUMN trust_level VARCHAR(32) NOT NULL;
```

- [ ] **步骤 6：运行聚焦测试与全量后端测试**

运行：`& $mvn -B '-Dtest=JdbcRunStoreTest,RunControllerTest,RunObservationServiceTest,RunRecoveryServiceTest' test`，再 `& $mvn -B test`。
预期：全部 PASS（需要真实 MySQL + 正确凭据环境变量）；`git diff --check` 干净。

- [ ] **步骤 7：提交**

```powershell
git add poc4/backend
git commit -m "fix(poc4): renew instance lease without bumping fencing"
```

## Task 3：Run 持久化真实 pod_ref 并新增 findLivePod（P0-1 基础）

**文件：**
- 修改：`poc4/backend/src/main/java/com/manao/poc4/run/RunStore.java:32`、`JdbcRunStore.java:111-113`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/run/RunService.java:60-61`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobCoordinator.java`、`Fabric8JobCoordinator.java`
- 新建：`poc4/backend/src/test/java/com/manao/poc4/kubernetes/Fabric8JobCoordinatorTest.java`
- 修改：`poc4/backend/src/test/java/com/manao/poc4/run/RunControllerTest.java:284`（Fake 同步）

**接口：**
- 依赖输入：`JobCoordinator.JobFacts` 现有 `podName()`。
- 对外产出：`RunStore.updateJobFacts(String runId, String jobRef, String podRef)`；`JobCoordinator.findLivePod(String runId)` 返回 `Optional<LivePod>`，`record LivePod(String podName, String containerName)`（容器名固定 `ResourceIdentityVerifier.APPLICATION_CONTAINER`）。

- [ ] **步骤 1：编写失败的测试**

```java
// Fabric8JobCoordinatorTest.java（Fabric8 mock server；Job/Pod 构造抄 ResourceIdentityVerifierTest:22-41 的既有写法）
@Test void findLivePodReturnsVerifiedPodForRunningPod() { /* pod phase=Running + 容器 Running + 正确 labels/ownerRef -> Optional 有值 */ }
@Test void findLivePodEmptyForMissingOrMismatchedPod() { /* 无 pod / label 错误 / 容器终止 -> empty */ }
```

- [ ] **步骤 2：运行测试确认失败**

运行：`& $mvn -B '-Dtest=Fabric8JobCoordinatorTest' test`
预期：FAIL——接口尚无 `findLivePod`。

- [ ] **步骤 3：编写最小实现**

```java
// Fabric8JobCoordinator.java
@Override public Optional<LivePod> findLivePod(String runId) {
    List<Pod> pods = client.pods().inNamespace(namespace)
        .withLabel(ResourceIdentityVerifier.LABEL_RUN_ID, runId).list().getItems();
    if (pods.size() != 1) return Optional.empty();
    Pod pod = pods.get(0);
    Job job = client.batch().v1().jobs().inNamespace(namespace)
        .withName(JobResourceFactory.jobName(runId)).get();
    if (job == null) return Optional.empty();
    // verifier.verify 需要 RunRecord：由 job 标签重建最小记录（runId/projectId）
    if (!verifier.verify(runRecordFrom(job), job, pod)) return Optional.empty();
    boolean containerRunning = pod.getStatus() != null && pod.getStatus().getContainerStatuses() != null
        && pod.getStatus().getContainerStatuses().stream().anyMatch(s ->
            ResourceIdentityVerifier.APPLICATION_CONTAINER.equals(s.getName())
            && s.getState() != null && s.getState().getRunning() != null);
    if (!containerRunning) return Optional.empty();
    return Optional.of(new LivePod(pod.getMetadata().getName(), ResourceIdentityVerifier.APPLICATION_CONTAINER));
}
```

- [ ] **步骤 4：写入 pod_ref（start 时与观察循环两处）**

```java
// RunStore 增加：void updatePodRef(String runId, String podRef);
// JdbcRunStore 实现：UPDATE run SET pod_ref = ? WHERE id = ?

// RunService.start：ensureJob 之后（此时 Pod 通常尚未出现，写入 null 亦可）
String jobRef = coordinator.ensureJob(persisted, projectId);
String podRef = coordinator.findLivePod(runId).map(JobCoordinator.LivePod::podName).orElse(null);
store.updateJobFacts(runId, jobRef, podRef);   // updateJobFacts 同时写 job_ref 与 pod_ref

// RunObservationService.observe()：facts 带 podName 且与既有 pod_ref 不同时
if (job.podName() != null && !job.podName().equals(run.podRef())) {
    store.updatePodRef(run.id(), job.podName());   // Pod 出现/重建后落库（6B 恢复与 PTY 依据）
}
```

- [ ] **步骤 5：运行测试确认通过**

运行：`& $mvn -B '-Dtest=Fabric8JobCoordinatorTest,RunControllerTest' test`
预期：PASS；`RunControllerTest` 的 Fake 记录 podRef 并新增断言 `fake.podRefs` 非空。

- [ ] **步骤 6：提交**

```powershell
git add poc4/backend/src/main poc4/backend/src/test
git commit -m "feat(poc4): resolve live pod identity for runs"
```

## Task 4：PTY 使用真实 Pod 名 + 握手身份核验（P0-1 + N2）

**文件：**
- 修改：`poc4/backend/src/main/java/com/manao/poc4/terminal/TerminalWebSocketHandler.java`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/config/WebSocketConfig.java:54-59`
- 修改：`poc4/backend/src/test/java/com/manao/poc4/terminal/TerminalWebSocketTest.java`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/terminal/TerminalStore.java`、`JdbcTerminalStore.java`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/terminal/PtyBridge.java`、`kubernetes/ExecPtyClient.java:31-32`

**接口：**
- 依赖输入：Task 3 的 `JobCoordinator.findLivePod`。
- 对外产出：`PtyBridge.open(String podName, String containerName, int cols, int rows, PtyListener)`；`TerminalWebSocketHandler(TerminalSessionService, PtyBridge, Function<String,RunSummary>, Clock, Function<String,Optional<JobCoordinator.LivePod>>)`；`TerminalStore.updateLiveRefs(String sessionId, String podRef, String containerRef)`。

- [ ] **步骤 1：编写失败的测试**

```java
// TerminalWebSocketTest.java（现有 Fake 基础上）
@Test void opensPtyWithResolvedPodNameNotJobName() {
    handler = handlerWithResolver(runId -> Optional.of(new JobCoordinator.LivePod("manao-run-1-abcde", "maven")));
    // 握手后断言 fakeBridge.podName == "manao-run-1-abcde"（现实现恒为 "manao-run-1"）
}
@Test void refusesHandshakeWhenNoLivePodIsVerified() {
    handler = handlerWithResolver(runId -> Optional.empty());
    // 断言 4410 close，且 fakeBridge.open 从未被调用
}
@Test void persistsPodAndContainerRefsAfterOpen() {
    // fakeStore 断言 updateLiveRefs(sessionId, "manao-run-1-abcde", "maven") 被调用
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：`& $mvn -B '-Dtest=TerminalWebSocketTest' test`
预期：FAIL（当前无 resolver，且断言失败）。

- [ ] **步骤 3：编写最小实现**

```java
// TerminalWebSocketHandler.java
private final Function<String, Optional<JobCoordinator.LivePod>> livePodResolver;
// afterConnectionEstablished 中，RUNNING 校验之后：
Optional<JobCoordinator.LivePod> live = livePodResolver.apply(record.runId());
if (live.isEmpty()) { settleAndClose(bound, "RUN_LEFT_RUNNING", "INTERRUPTED", null, TICKET_REJECTED); return; }
JobCoordinator.LivePod pod = live.get();
bound.handle = bridge.open(pod.podName(), pod.containerName(),
    Math.max(record.cols(), 1), Math.max(record.rows(), 1), new PtyListenerAdapter(bound));
sessions.updateLiveRefs(record.sessionId(), pod.podName(), pod.containerName());
```
同时修改 `PtyBridge.open` 签名与 `ExecPtyClient.java:31-32`（删除硬编码 Job 名，改为传入 podName/containerName）。

- [ ] **步骤 4：接线**

```java
// WebSocketConfig.java
@Bean @ConditionalOnBean({TerminalSessionService.class, PtyBridge.class, RunService.class, JobCoordinator.class})
TerminalWebSocketHandler terminalWebSocketHandler(TerminalSessionService sessions, PtyBridge bridge,
                                                 RunService runService, JobCoordinator coordinator) {
    return new TerminalWebSocketHandler(sessions, bridge, runService::findSummaryById, Clock.systemUTC(),
        runId -> coordinator.findLivePod(runId).map(p -> new JobCoordinator.LivePod(p.podName(), p.containerName())));
}
```

- [ ] **步骤 5：运行测试确认通过**

运行：`& $mvn -B '-Dtest=TerminalWebSocketTest,ExecPtyClientTest' test`
预期：PASS（ExecPtyClientTest 只断言 transport 参数传递）。

- [ ] **步骤 6：提交**

```powershell
git add poc4/backend/src/main poc4/backend/src/test
git commit -m "fix(poc4): exec pty against verified live pod"
```

## Task 5：日志 watch 接入观察循环（P0-5）

**文件：**
- 修改：`poc4/backend/src/main/java/com/manao/poc4/run/RunObservationService.java`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/log/RunLogIngestor.java`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/config/WorkspaceConfig.java:186-203`
- 修改：`poc4/backend/src/test/java/com/manao/poc4/run/RunObservationServiceTest.java`
- 新建：`poc4/backend/src/test/java/com/manao/poc4/log/RunLogIngestorTest.java`

**接口：**
- 依赖输入：Task 3 的 `JobFacts.podName()`。
- 对外产出：`RunObservationService(RunStore, JobCoordinator, RunLogIngestor)`；`RunLogIngestor.ensureWatch(String runId, String podName)` 改为 2 参数（namespace 由 ingestor 构造时内部持有），保持幂等（重复调用去重靠 `watches.containsKey`）。

- [ ] **步骤 1：编写失败的测试**

```java
// RunObservationServiceTest.java
@Test void attachesLogWatchWhenRunBecomesRunning() {
    // fake coordinator: facts -> running=true, podName="manao-run-1-abcde"
    // fake ingestor 记录 ensureWatch(runId, podName, ns) 调用
    service.observe();
    assertThat(fakeIngestor.calls).contains(new WatchCall("r1", "manao-run-1-abcde"));
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：`& $mvn -B '-Dtest=RunObservationServiceTest' test`
预期：FAIL——观察服务尚不持有 ingestor。

- [ ] **步骤 3：编写最小实现**

```java
// RunObservationService.observe()：facts 判定 running 之后
if (job.running()) {
    if (run.state() == RunState.STARTING) { /* markRunning 后 refetch */ }
    if (job.podName() != null) logIngestor.ensureWatch(run.id(), job.podName());
}
```

- [ ] **步骤 4：接线并运行测试**

```java
// WorkspaceConfig.runObservationService 增参 RunLogIngestor
```
运行：`& $mvn -B '-Dtest=RunObservationServiceTest' test`；再跑 `& $mvn -B test`。
预期：PASS。

- [ ] **步骤 5：提交**

```powershell
git add poc4/backend/src/main poc4/backend/src/test
git commit -m "fix(poc4): attach pod log watch from run observation"
```

## Task 6：日志行按 UTF-8 字节切分 + 重附按行计数（P1-12）

**文件：**
- 新建：`poc4/backend/src/main/java/com/manao/poc4/log/Utf8ChunkSplitter.java`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/log/RunLogIngestor.java:30-71`
- 新建：`poc4/backend/src/test/java/com/manao/poc4/log/Utf8ChunkSplitterTest.java`
- 修改：`poc4/backend/src/test/java/com/manao/poc4/log/RunLogIngestorTest.java`

**接口：**
- 对外产出：`Utf8ChunkSplitter.split(String text, int maxUtf8Bytes)` 返回 `List<String>`——每块 UTF-8 字节数 ≤ max，且不切断代理对（surrogate pair）。

- [ ] **步骤 1：编写失败的测试**

```java
// Utf8ChunkSplitterTest.java
@Test void splitsAsciiExactly() {
    assertThat(Utf8ChunkSplitter.split("a".repeat(100), 64))
        .containsExactly("a".repeat(64), "a".repeat(36));
}
@Test void neverSplitsMultibyteCodePoints() {
    String line = "中".repeat(100); // 每字符 3 字节
    for (String piece : Utf8ChunkSplitter.split(line, 64)) {
        assertThat(piece.getBytes(StandardCharsets.UTF_8).length).isLessThanOrEqualTo(64);
        assertThat(piece).doesNotEndWith("�");
    }
}
@Test void doesNotSplitSurrogatePairs() { /* "😀".repeat(50)，块边界不得落在低代理 */ }
```

- [ ] **步骤 2：运行测试确认失败**

运行：`& $mvn -B '-Dtest=Utf8ChunkSplitterTest' test`
预期：FAIL——类不存在。

- [ ] **步骤 3：编写最小实现**

```java
public final class Utf8ChunkSplitter {
    public static List<String> split(String text, int maxUtf8Bytes) {
        // 以 codePoint 为最小单元累加 UTF-8 字节数，达到上限时切块；
        // \n 保留在块内（publish 前由调用方追加）
    }
}
// RunLogIngestor.ingest：text = line + "\n";
// for (String piece : Utf8ChunkSplitter.split(text, RunLogWindow.MAX_CHUNK_BYTES)) { publish(runId, seq++, piece); }
// ensureWatch：handle.skipLines = lastSeq —— 每个 seq 对应一个已持久化块；
//   重附时行数与块数可能不一致 → Handle 改为按块计数（skipChunks），lineConsumer 收到一行时先按块对齐，
//   仅当 skipChunks 消耗到 0 才 publish 该行剩余块。
```

- [ ] **步骤 4：运行测试确认通过**

运行：`& $mvn -B '-Dtest=Utf8ChunkSplitterTest,RunLogIngestorTest' test`
预期：PASS（RunLogIngestorTest 增加“长行中文 + 重附不丢块”两例）。

- [ ] **步骤 5：提交**

```powershell
git add poc4/backend/src/main poc4/backend/src/test
git commit -m "fix(poc4): split log lines on utf8 boundaries"
```

## Task 7：initializer 不存在 = 失败（P1-7）

**文件：**
- 修改：`poc4/backend/src/main/java/com/manao/poc4/kubernetes/Fabric8KubernetesGateway.java:37-43`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/project/ProjectProvisioningService.java:95`
- 新建：`poc4/backend/src/test/java/com/manao/poc4/kubernetes/Fabric8KubernetesGatewayTest.java`

**接口：**
- 对外产出：`KubernetesGateway.initializerSucceeded(String projectId)` 语义变为“当前可见且 Succeeded 才返回 true”；provisioning 调用点改为 `if (!awaitInitializer(projectId))`（轮询 240×500ms 由 provision 完成，不依赖网关等待）。

- [ ] **步骤 1：编写失败的测试**

```java
// Fabric8KubernetesGatewayTest.java（Fabric8 mock server）
@Test void missingInitializerIsNotSuccess() {
    // mock：pods.withName(initializer).get() 返回 null
    assertThat(gateway.initializerSucceeded("p1")).isFalse();   // 现实现返回 true
}
@Test void succeededPodIsSuccess() { /* phase=Succeeded -> true */ }
@Test void failedPodIsNotSuccess() { /* phase=Failed -> false */ }
```

- [ ] **步骤 2：运行测试确认失败**

运行：`& $mvn -B '-Dtest=Fabric8KubernetesGatewayTest' test`
预期：FAIL——第一例断言失败。

- [ ] **步骤 3：编写最小实现**

```java
// Fabric8KubernetesGateway.java
@Override public boolean initializerSucceeded(String projectId) {
    Pod pod = client.pods().inNamespace(namespace)
        .withName(WorkspaceResourceFactory.initializerPodName(projectId)).get();
    if (pod == null) return false;   // 不存在/尚不可见：一律不视为成功
    return "Succeeded".equals(pod.getStatus() == null ? null : pod.getStatus().getPhase());
}
// ProjectProvisioningService.java:95
if (!awaitInitializer(projectId)) { throw new IllegalStateException("initializer did not succeed"); }
```

- [ ] **步骤 4：运行测试确认通过**

运行：`& $mvn -B '-Dtest=Fabric8KubernetesGatewayTest,ProjectProvisioningServiceTest' test`
预期：PASS（provisioning 测试按新轮询语义调整）。

- [ ] **步骤 5：提交**

```powershell
git add poc4/backend/src/main poc4/backend/src/test
git commit -m "fix(poc4): fail closed when initializer pod is absent"
```

## Task 8：6A 真实 preflight fail-closed（P1-8）

**文件：**
- 修改：`poc4/backend/src/test/java/com/manao/poc4/deploy/Stage6aPreflightTest.java:60-75`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/kubernetes/SshApiTunnelHealth.java:56-59`（补文件 loader 重载，去抛异常默认）

**接口：**
- 对外产出：`Stage6aPreflightTest.realClusterPreflightRunsOnlyWhenEnabled` 在 `manao.stage6.real=true` 且 KUBECONFIG 缺失/不可读时**使测试失败**（`REAL_MODE_KUBECONFIG_MISSING`），并改用真实 kubeconfigLoader + Fabric8 probe。

- [ ] **步骤 1：先让“真模式缺 KUBECONFIG 必红”**

```java
@Test void realClusterPreflightFailsWhenKubeconfigMissingInRealMode() {
    assumeTrue("true".equals(System.getProperty("manao.stage6.real", "false")));
    String kubeconfigPath = System.getenv("KUBECONFIG");
    assertThat(kubeconfigPath)
        .as("REAL_MODE_KUBECONFIG_MISSING: gate run requires KUBECONFIG")
        .isNotBlank();
    assertThat(Files.isReadable(Path.of(kubeconfigPath)))
        .as("REAL_MODE_KUBECONFIG_UNREADABLE")
        .isTrue();
}
```
原 `realClusterPreflightRunsOnlyWhenEnabled` 改为：非 real 模式 return；real 模式先做上述 fail-closed 断言，再用
`new SshApiTunnelHealth(realKubectl(), designVerbs(true), fabric8ProbeFromKubeconfig(path), path -> Files.readString(Path.of(path)))`
并断言 failures 为空。

- [ ] **步骤 2：运行测试确认失败（真模式无 KUBECONFIG）**

运行：`& $mvn -B '-Dtest=Stage6aPreflightTest' '-Dmanao.stage6.real=true' test`
预期：FAIL——`REAL_MODE_KUBECONFIG_MISSING`（此步即证明旧实现会假绿，新测试拦截）。

- [ ] **步骤 3：编写最小实现（fabric8ProbeFromKubeconfig 辅助）**

```java
private SshApiTunnelHealth.Fabric8VersionProbe fabric8ProbeFromKubeconfig(String path) {
    return () -> {
        try (var client = new io.fabric8.kubernetes.client.KubernetesClientBuilder()
                .withConfig(io.fabric8.kubernetes.client.Config.fromKubeconfig(null, Files.readString(Path.of(path)), null))
                .build()) {
            client.getApiVersion();
            return true;
        } catch (Exception ex) { return false; }
    };
}
```

- [ ] **步骤 4：运行测试确认通过（非 real 模式）**

运行：`& $mvn -B '-Dtest=Stage6aPreflightTest' test`
预期：PASS（3 个测试：纯断言 2 + real 模式守卫 1 走 return 分支）。**6A Gate 的实际 KUBECONFIG 运行留在 Task 14。**

- [ ] **步骤 5：提交**

```powershell
git add poc4/backend/src/test/java/com/manao/poc4/deploy/Stage6aPreflightTest.java poc4/backend/src/main/java/com/manao/poc4/kubernetes/SshApiTunnelHealth.java
git commit -m "fix(poc4): fail 6a preflight when gate inputs are missing"
```

## Task 9：E2E 去除内部 skip/return（P1-9）

**文件：**
- 修改：`poc4/frontend/tests/e2e/stage6-real-backend.spec.ts:57-76,115-140`

**接口：**
- 对外产出：gate 模式下各流程“硬断言”——provisioning 未 READY 时测试 FAIL，绝不 return/skip。

- [ ] **步骤 1：改断言（先让 spec 红）**

```typescript
// 第 61-62 行删除 `if (aliceState !== 'READY') return;`
expect(aliceState, 'owner isolation requires a READY project').toBe('READY');
// 第 119-120 行删除 test.skip 与 return，替换为：
expect(state, 'run test requires a READY project').toBe('READY');
// 第 139 行改为：终态必须出现（RUNNING 属于“卡死”症状，不得放行）
expect(['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT']).toContain(finalState);
```

- [ ] **步骤 2：运行 typecheck 确认编译**

运行：`pnpm --dir poc4/frontend typecheck`
预期：PASS。

- [ ] **步骤 3：提交（E2E 真跑在 Task 14）**

```powershell
git add poc4/frontend/tests/e2e/stage6-real-backend.spec.ts
git commit -m "test(poc4): make stage6 e2e assertions non-skippable"
```

## Task 10：shutdown 生命周期接线（P1-10）

**文件：**
- 修改：`poc4/backend/src/main/java/com/manao/poc4/terminal/TerminalWebSocketHandler.java`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/lifecycle/BackendLifecycleCoordinator.java`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/config/RuntimeMaintenanceLoop.java:82-86`
- 修改：`poc4/backend/src/test/java/com/manao/poc4/lifecycle/BackendLifecycleCoordinatorTest.java`、`TerminalWebSocketTest.java`

**接口：**
- 对外产出：`TerminalWebSocketHandler.teardownAllSessions()`（遍历 connections，幂等 settle `INTERRUPTED` + 关闭 handle + closeQuietly）；`BackendLifecycleCoordinator` 增加按 runId 注册的 disposer 并保持 order 语义。

- [ ] **步骤 1：编写失败的测试**

```java
@Test void teardownAllSessionsSettlesActivePtyAndNeverReattaches() {
    // 建立 live 连接后调用 handler.teardownAllSessions()
    // 断言 fakeStore 该 session 终态 INTERRUPTED 且 fakeBridge.handle.close 被调用；再次调用无副作用
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：`& $mvn -B '-Dtest=TerminalWebSocketTest' test`
预期：FAIL——方法不存在。

- [ ] **步骤 3：编写最小实现并接线**

```java
// TerminalWebSocketHandler.java
public void teardownAllSessions() {
    for (BoundSession bound : List.copyOf(connections.values())) {
        settleAndClose(bound, "BACKEND_SHUTDOWN", "INTERRUPTED", null, null);
    }
}
// RuntimeMaintenanceLoop.shutdown() 追加：
safe("terminal teardown", () -> { var h = terminalHandler.getIfAvailable(); if (h != null) h.teardownAllSessions(); });
```

- [ ] **步骤 4：运行测试确认通过**

运行：`& $mvn -B '-Dtest=TerminalWebSocketTest,BackendLifecycleCoordinatorTest' test`
预期：PASS。

- [ ] **步骤 5：提交**

```powershell
git add poc4/backend/src/main poc4/backend/src/test
git commit -m "fix(poc4): tear down terminals on backend shutdown"
```

## Task 11：项目恢复身份核验与保留 PVC（P1-11 + N5）

**文件：**
- 修改：`poc4/backend/src/main/java/com/manao/poc4/kubernetes/Fabric8KubernetesGateway.java:31-35`（防 NPE）
- 修改：`poc4/backend/src/main/java/com/manao/poc4/recovery/ProjectRecoveryService.java:50-63`
- 修改：`poc4/backend/src/test/java/com/manao/poc4/kubernetes/Fabric8KubernetesGatewayTest.java`、`ProjectRecoveryServiceTest.java`

**接口：**
- 对外产出：`matchesProject` 对 labels 为 null 返回 false 而非 NPE；恢复判定要求 PVC/Pod/Service 均带 `manao.poc4/project-id` **且** component 标签正确；`reconcilePending` 失败路径只删 Pod/Service，**保留 PVC**。

- [ ] **步骤 1：编写失败的测试**

```java
@Test void matchesProjectNeverNpesOnMissingLabels() { /* mock 资源 metadata 存在但 labels 为 null -> 返回 false 不抛 */ }
@Test void recoveryFailureKeepsPvcButRemovesPodsAndServices() { /* fake gateway 断言 deleteProjectWorkloads 被调用 */ }
```

- [ ] **步骤 2：运行测试确认失败**

预期：FAIL（NPE / 方法不存在）。

- [ ] **步骤 3：编写最小实现**

```java
// Fabric8KubernetesGateway.java
private static boolean matchesProject(HasMetadata resource, String projectId) {
    if (resource == null || resource.getMetadata() == null) return false;
    Map<String, String> labels = resource.getMetadata().getLabels();
    return labels != null && projectId.equals(labels.get(WorkspaceResourceFactory.LABEL_PROJECT_ID));
}
public void deleteProjectWorkloads(String projectId) {  // 保留 PVC
    Map<String,String> labels = WorkspaceResourceFactory.projectLabels(projectId);
    client.pods().inNamespace(namespace).withLabels(labels).withGracePeriod(0).delete();
    client.services().inNamespace(namespace).withLabels(labels).delete();
}
// ProjectRecoveryService.java:59-63 reconcile 失败路径改为 gateway.deleteProjectWorkloads(projectId)，
//   并在 markProjectFailed 使用 WORKSPACE_RECONCILIATION_REQUIRED（保留现场语义：仅删 Pod/Service，不删 PVC）
```

- [ ] **步骤 4：运行测试确认通过**

运行：`& $mvn -B '-Dtest=Fabric8KubernetesGatewayTest,ProjectRecoveryServiceTest' test`
预期：PASS。

- [ ] **步骤 5：提交**

```powershell
git add poc4/backend/src/main poc4/backend/src/test
git commit -m "fix(poc4): verify workspace identity and preserve pvc on recovery failure"
```

## Task 12：maven-runner 镜像材料与 wrapper/hook 占位（P0-4）

**文件：**
- 新建：`poc4/maven-runner/Dockerfile`
- 新建：`poc4/maven-runner/manao-pty-wrapper`
- 新建：`poc4/maven-runner/manao-shell-hook.sh`
- 新建：`poc4/maven-runner/README.md`
- 修改：`poc4/backend/config/local-cluster.example.env:18`（注释说明构建路径，不写真实 digest）

**接口：**
- 对外产出：可构建、可用 digest 引用的 runner 镜像；镜像内包含 Java 17、Maven 3.9、Bash、`/usr/local/bin/manao-pty-wrapper`（root-owned 0555）、`/usr/local/bin/manao-shell-hook`；`JobResourceFactory` 无需改动（`MANAO_MAVEN_RUNNER_IMAGE` 已是 digest 校验）。

- [ ] **步骤 1：编写 Dockerfile（完整内容）**

```dockerfile
# poc4/maven-runner/Dockerfile
FROM maven:3.9.9-eclipse-temurin-17
RUN useradd -r -u 1000 manao
COPY manao-pty-wrapper /usr/local/bin/manao-pty-wrapper
COPY manao-shell-hook.sh /usr/local/bin/manao-shell-hook
RUN chown root:root /usr/local/bin/manao-pty-wrapper /usr/local/bin/manao-shell-hook \
 && chmod 0555 /usr/local/bin/manao-pty-wrapper /usr/local/bin/manao-shell-hook
WORKDIR /workspace
ENV TMPDIR=/tmp HOME=/tmp
USER 1000
# Job PID 1 由 JobResourceFactory 指定为 ["mvn","clean","test"]；wrapper 仅作为 pods/exec 目标
```

- [ ] **步骤 2：编写 wrapper/hook 占位（行为明确标注“审计事件协议未实现”）**

```bash
#!/bin/bash
# manao-pty-wrapper（占位版 v0：仅 exec bash；HMAC/FIFO 审计事件在“审计链路实现计划”中交付）
exec /bin/bash -l
```
```bash
#!/bin/bash
# manao-shell-hook.sh（占位版 v0：仅导出占位标记；不伪造命令审计）
export MANAO_SHELL_HOOK_V0=1
```

- [ ] **步骤 3：本地构建验证（Docker 现已可用）**

运行：`docker build -t manao/maven-runner:stage6-remediation poc4/maven-runner`
预期：BUILD SUCCESS；`docker run --rm manao/maven-runner:stage6-remediation mvn -v` 输出 Maven 3.9 + JDK 17。

- [ ] **步骤 4：README 写明边界并提交**

README 记录：digest 固定方式（`docker push` + `docker inspect --format='{{index .RepoDigests 0}}'`）、wrapper 占位状态、可信度声明（“wrapper transport verified”不成立直至审计链路计划完成）。提交：

```powershell
git add poc4/maven-runner poc4/backend/config/local-cluster.example.env
git commit -m "feat(poc4): add maven runner image materials"
```

## Task 13：JdbcAuditStore 真实 MySQL 测试（P1-6 回归保护）

**文件：**
- 新建：`poc4/backend/src/test/java/com/manao/poc4/audit/JdbcAuditStoreTest.java`

**接口：**
- 依赖输入：V6 迁移（trust_level VARCHAR(32)）、Task 1 测试底座。
- 对外产出：真实 SQL 层测试——`insertRunning(..., "WRAPPER_TRANSPORT", ...)` 成功；`settle/list/listBefore/deleteExpiredBefore` 全链路可运行。

- [ ] **步骤 1：编写失败的测试**

```java
class JdbcAuditStoreTest {
    @Test void insertWrapperTransportTrustLevelFitsColumn() {
        String id = store.insertRunning("s1","p1","r1","u1",1,"echo hi",false,
            AuditIngressService.TRUST_LEVEL_WRAPPER_TRANSPORT, Instant.now());
        assertThat(id).isNotBlank();   // V6 前：Data too long for column 'trust_level'
    }
}
```

- [ ] **步骤 2：运行测试确认通过（V6 已由 Task 2 提交）**

运行：`& $mvn -B '-Dtest=JdbcAuditStoreTest' test`
预期：PASS；执行者必须额外用
`SELECT column_type FROM information_schema.columns WHERE table_name='terminal_audit' AND column_name='trust_level'` 确认 `varchar(32)`。

- [ ] **步骤 3：补充 store 层其余方法测试并确认全绿**

- [ ] **步骤 4：提交**

```powershell
git add poc4/backend/src/test/java/com/manao/poc4/audit/JdbcAuditStoreTest.java
git commit -m "test(poc4): cover audit store on real mysql"
```

## Task 14：全量回归 + 6A 门证据更新（含 E2E 与 preflight 真跑）

**文件：**
- 修改：`poc4/docs/evidence/stage-6/6a-gate.md`、`6a-local-cluster-result.md`

**接口：**
- 依赖输入：Task 1–13 全部提交；操作者提供三项外部前置：受限 Role 的 kubeconfig（等价 6B namespace Role + pods/portforward）、SSH API 隧道（127.0.0.1:6443）、可推送 runner/workspace-agent 镜像的 registry 与 `stage6-operator` 身份。
- 对外产出：全量测试绿灯 + 真实 6A E2E 证据 + 更新后的 `6a-gate.md`（完整 HEAD SHA、完整 digest、26 项 can-i、状态分类）。

- [ ] **步骤 1：后端全量（真实 MySQL）**：`& $mvn -B test`，预期全 PASS
- [ ] **步骤 2：workspace-agent**：`& $mvn -B test`（workspace-agent 目录），预期 23+ PASS
- [ ] **步骤 3：前端**：`pnpm --dir poc4/frontend typecheck`、`pnpm --dir poc4/frontend test`
- [ ] **步骤 4：构建并推送 workspace-agent 与 maven-runner 镜像，记录完整 digest；更新 backend 环境 `MANAO_MAVEN_RUNNER_IMAGE` 与 agent 镜像 digest**
- [ ] **步骤 5：真模式 preflight**：`& $mvn -B '-Dtest=Stage6aPreflightTest' '-Dmanao.stage6.real=true' test`（KUBECONFIG 指向受限 Role 临时 kubeconfig），预期 PASS 且 26 项 can-i 全 yes
- [ ] **步骤 6：6A 浏览器 E2E**：启动本机后端（local-cluster profile）+ 本机 MySQL + Vite + SSH 隧道，`STAGE6_GATE=1 pnpm --dir poc4/frontend test:e2e:stage6`，预期全 PASS；审计 wrapper 事件、FIFO 消费流项在证据中标记 `SKIPPED`（Task 12 占位边界）
- [ ] **步骤 7：更新证据文件并提交**

```powershell
git add poc4/docs/evidence/stage-6 poc4/backend/src/test/java/com/manao/poc4/deploy
git commit -m "test(poc4): record stage 6 remediation gate evidence"
```

---

## 验证矩阵

| 缺陷 | 修复任务 | 验收证据 |
|---|---|---|
| P0-1 PTY 用 Job 名 | Task 3/4 | `TerminalWebSocketTest` 断言 podName 为真实 Pod 名；握手无 live pod 得 4410 |
| P0-2 fencing 无续租 | Task 2 | `JdbcRunStoreTest` 跨 60s+ 的 markRunning/settle 全真 SQL PASS |
| P0-3 审计无接线 | 不在本计划（Task 12/13 仅材料+占位，证据标 SKIPPED） | 后续审计链路计划 |
| P0-4 runner 镜像缺失 | Task 12 | `docker build` 成功 + `mvn -v` 冒烟 |
| P0-5 日志 watch 未启动 | Task 5 | `RunObservationServiceTest` 断言 ensureWatch 调用 |
| P1-6 trust_level 长度 | Task 2(V6)/13 | 真实 MySQL 插入 WRAPPER_TRANSPORT 成功 |
| P1-7 initializer 假成功 | Task 7 | `Fabric8KubernetesGatewayTest` missing→false |
| P1-8 preflight 假绿 | Task 8 | 真模式缺 KUBECONFIG → FAIL |
| P1-9 E2E 内部跳过 | Task 9 | spec 无 skip/return，未 READY 必红 |
| P1-10 shutdown 未接线 | Task 10 | teardown 测试 + @PreDestroy 调用链 |
| P1-11 恢复身份/NPE | Task 11 | NPE 用例 + component 断言 + 保留 PVC 用例 |
| P1-12 日志字节边界 | Task 6 | `Utf8ChunkSplitterTest` 多字节/代理对用例 |
| N1 JDBC 零覆盖 | Task 1/13 | JdbcRunStoreTest/JdbcAuditStoreTest 真库全绿 |
| N2 握手无身份核验 | Task 4 | resolver 空 → 4410 用例 |
| N3 Stop 静默失效 | Task 2 | 租约续租后 stop transition 生效（RunControllerTest 回归） |
| N4 双 lease 实现 | Task 2 | JdbcInstanceLeaseRepository 标记 @Deprecated，生产仅走 JdbcRunStore |
| N5 恢复删 PVC | Task 11 | deleteProjectWorkloads 用例 |
| N6 fencing_token NULL | Task 2(V6) | 迁移 backfill + NOT NULL 约束 |

## 回滚边界

- Task 2 失败：回退 JdbcRunStore/RunStore 改动，保留 Task 1 底座；不发布任何真实集群。
- Task 4 失败：回退 handler/ExecPtyClient 签名，PTY 保持 fail-closed 拒绝；不放松身份核验。
- Task 12 失败：runner 镜像不构建；6A Gate 的镜像项保持 `SKIPPED`，不开始 6B。
- 任何任务不得以“让测试变绿”为由放宽 owner 校验、RBAC、TLS、ticket 绑定、流控上限或清理顺序。
- 同一问题最多四轮有证据修复；超过即停止扩范围并记录阻塞。
