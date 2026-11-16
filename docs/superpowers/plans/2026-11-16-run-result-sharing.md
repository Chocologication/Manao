# Run Result Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户能把已结束运行的服务端保留日志生成独立、免登录可查看、可撤销且固定 72 小时有效的分享。

**Architecture:** 现有 Spring Boot 后端新增分享模块，MySQL 一张表保存独立快照和生命周期。预览摘要校验保证发布内容与预览一致；前端新增分享弹窗、公开页面和账户下的“我的分享”，复用现有登录、路由和 HTTP client。

**Tech Stack:** Java 17、Spring Boot 3.5.9、JdbcTemplate / TransactionTemplate、MySQL / Flyway、React 19、现有 React Router / TanStack Query / Vitest / Playwright、pnpm；唯一新增前端直接依赖为 `qrcode.react`。

**Spec:** [运行结果分享设计](../specs/2026-11-16-run-result-sharing-design.md)。执行者先读设计，再读本计划。

## Global Constraints

- 只按所选 Run 判断；允许 `SUCCEEDED`、`FAILED`、`CANCELLED`、`TIMED_OUT`。
- 分享服务端数据库当前保留的全部日志；没有选行、浏览器窗口上传、补采或完整采集保证。
- 预览和接收页不增加截断、缺口、完整性提示，也不将内容标为“从头到尾完整日志”。
- 持链接免登录只读；预览、创建、管理、撤销需要创建者登录。
- 从成功生成链接起固定 72 小时，不因访问或重试延长。
- 源日志清理、删除原项目均不影响已经生成的分享。
- 空日志允许分享，显示“暂无可分享的日志”。
- 每个 Run 最多一个仍有效的链接；再次打开管理已有链接。
- 到期立即禁止服务端读取；每 2 小时清理一次到期正文，允许物理回收有调度延迟；撤销时同步清空正文。
- UTF-8 无 BOM；前端 pnpm；业务实现只在隔离工作树中进行，保留无关修改。
- MySQL 集成测试只能使用 disposable schema；禁止重置 `manao_poc4` / `manao_poc4_6b`。

---

## 执行说明与文件边界

本计划在 2026-11-16 的 `master` / `16022d2` 上调研，保存在 `codex/run-result-sharing-plan` 工作树。**Task 1–5 独立审查 PASS，最终整分支 READY、零未关闭发现；第三轮本地真实闭环及独立资源/服务/测试schema收尾 PASS。默认标题修正后的真实E2E NOT_RERUN，旧通过快照及前两轮失败保留，云端发布 NOT_RUN。** 当前迁移为加法 V22，历史 V1–V21 未修改。状态与证据以[验收记录](../../../poc4/docs/evidence/run-result-sharing/acceptance.md)为准。

只设五个任务，按 1 → 2 → 3 → 4 → 5 验收。任务 3 的接口冻结后，前端可与后端独立完成；不要为了并行提前扩充通用框架。

| 边界 | 文件与职责 |
| --- | --- |
| 数据合同 | `share/RunShareContracts.java`：本模块 records、状态、创建请求；不扩展整个 RunSummary |
| 数据访问 | `share/JdbcRunShareStore.java`：本模块 SQL、数据库时间、短事务、所有权、分页、回收 |
| 用例 | `share/RunShareService.java`：终态资格、快照、摘要、创建幂等、单有效链接、访问生命周期 |
| HTTP | `share/RunShareController.java` 与 `share/PublicRunShareController.java`：分别管理 owner 与匿名访问 |
| 装配 | `config/RunShareConfig.java`：复用现有 JdbcTemplate / RunStore，注册分享 bean；遵循现有 BackendAuthCondition |
| 维护与权限 | 现有 `RuntimeMaintenanceLoop.java` 增加每 2 小时一次的回收；`SecurityConfig.java` 只开放专用 public GET |
| 前端 | `contracts/runShare.ts`、`api/runShareApi.ts`、`features/shares/`；现有 RunPanel / AccountPanel / AppRouter 只接入口 |

上表后端路径以 `poc4/backend/src/main/java/com/manao/poc4/` 为根，前端以 `poc4/frontend/src/` 为根。后续任务列出其余文件的完整仓库相对路径。

## Task 1：独立表、固定 DTO 与迁移验证

**Files**

- Create: `poc4/backend/src/main/resources/db/migration/V22__run_shares.sql`
- Create: `poc4/backend/src/main/java/com/manao/poc4/share/RunShareContracts.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/share/JdbcRunShareStore.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/share/JdbcRunShareStoreTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/persistence/RunShareUpgradeMigrationTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/persistence/StudioUpgradeMigrationTest.java`

**Interfaces**

`RunShareContracts` 内使用下列固定 records；时间均为 UTC `Instant`，JSON 为 ISO 8601。`Preview.kind` 仅 `PREVIEW` / `EXISTING`，前者只设置 snapshot/digest，后者只设置 share。公开 DTO 不复用整个 RunPolicy。

```java
public record RunSnapshot(String state, Integer exitCode, Instant createdAt,
    Instant startedAt, Instant finishedAt, String language, String runtimeLabel) {}
public record SnapshotContent(RunSnapshot run, String logText) {}
public record PublishRequest(String requestId, String snapshotDigest,
    String title, String description) {}
public record OwnerShare(String id, String title, String sourceProjectName,
    Instant createdAt, Instant expiresAt, String status, String sharePath) {}
public record Preview(String kind, SnapshotContent snapshot,
    String snapshotDigest, OwnerShare share) {}
public record PublishOutcome(boolean created, OwnerShare share) {}
public record PublicShare(String title, String description,
    Instant createdAt, Instant expiresAt, SnapshotContent snapshot) {}
public record SharePage(List<OwnerShare> items, String nextCursor) {}
```

`JdbcRunShareStore(JdbcTemplate jdbc)` 提供本模块所需的数据库访问；用同一个 DataSource 建立 TransactionTemplate。生命周期不借用项目日志的保留时间。数据访问方法按本模块用例命名，不新增通用 repository 抽象或第二张快照表。

- [x] **1.1 先写迁移与数据容量的失败测试。** 复用 `JdbcStoreTestSupport.createAtVersion("21")`，在迁移前保存既有用户/项目/Run/日志行，`migrateToLatest()` 后要求旧行一致、新表为空。`JdbcRunShareStoreTest` 验证大小写不同 token 不相等、同 owner/requestId 唯一、日志原样保存且 `''` 与 `NULL` 有区别。

```java
try (var db = JdbcStoreTestSupport.createAtVersion("21")) {
    var before = db.jdbc().queryForList("SELECT version,checksum FROM flyway_schema_history ORDER BY installed_rank");
    db.migrateToLatest();
    assertThat(db.jdbc().queryForList("SELECT version,checksum FROM flyway_schema_history WHERE CAST(version AS UNSIGNED) <= 21 ORDER BY installed_rank"))
        .isEqualTo(before);
    assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM run_share", Integer.class)).isZero();
}
```

运行 `mvn -f poc4/backend/pom.xml -Dtest=RunShareUpgradeMigrationTest,JdbcRunShareStoreTest test`。预期先因表/新类不存在失败；数据库不可连接是环境阻塞，不是预期红灯。

- [x] **1.2 实现加法迁移和存储合同。** 不修改历史 migration，不增加 project/run 外键。以下为字段和索引基准：

```sql
CREATE TABLE run_share (
    id CHAR(36) PRIMARY KEY,
    owner_id VARCHAR(64) NOT NULL,
    source_project_id VARCHAR(64) NOT NULL,
    source_run_id VARCHAR(64) NOT NULL,
    source_project_name VARCHAR(255) NOT NULL,
    token CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    title VARCHAR(100) NOT NULL,
    description TEXT NULL,
    run_snapshot_json JSON NULL,
    log_text LONGTEXT NULL,
    created_at DATETIME(6) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    revoked_at DATETIME(6) NULL,
    request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    UNIQUE KEY uq_run_share_token (token),
    UNIQUE KEY uq_run_share_request (owner_id, request_id),
    KEY ix_run_share_owner (owner_id, created_at, id),
    KEY ix_run_share_source (owner_id, source_run_id, expires_at),
    KEY ix_run_share_expiry (expires_at)
) CHARACTER SET utf8mb4;
```

存储读写使用 UTC：DATETIME 通过 JDBC `LocalDateTime` 读写，再以 `ZoneOffset.UTC` 转换 `Instant`，不依赖 JVM 本地时区。`created_at` 从数据库时间获取一次，`expires_at` 为其加 72h；活性读取也使用数据库时间。保留行的请求摘要是重试收据，回收正文不能删除它。

- [x] **1.3 修正旧升级测试的边界并验证。** `StudioUpgradeMigrationTest` 当前用 `version <> '21'` 过滤“旧历史”，新增 V22 会破坏该假设；改为 `CAST(version AS UNSIGNED) <= 20`，保留原 V21 成功断言和旧业务数据断言。运行三个目标测试，要求迁移、容量、旧数据兼容均通过。

```powershell
mvn -f poc4/backend/pom.xml -Dtest=RunShareUpgradeMigrationTest,JdbcRunShareStoreTest,StudioUpgradeMigrationTest test
git diff --check
```

- [x] **1.4 独立提交本任务。** `git add` 只加入本任务 Files，提交 `feat: add independent run share storage`。

## Task 2：服务端预览、快照发布与重复请求

**Files**

- Create: `poc4/backend/src/main/java/com/manao/poc4/share/RunShareService.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/config/RunShareConfig.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/share/JdbcRunShareStore.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/share/RunShareServiceTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/share/RunShareTestFixtures.java`

**Interfaces**

构造函数为 `RunShareService(JdbcRunShareStore shares, RunStore runs, JdbcLogStore logs, ObjectMapper json)`；依赖使用同一数据源。生产 ObjectMapper 复用 Spring 配置。此任务交付：

```java
Preview preview(String ownerId, String projectId, String runId);
PublishOutcome publish(String ownerId, String projectId, String runId, PublishRequest request);
```

`RunShareTestFixtures.seedFinishedRun(JdbcTemplate jdbc, String text)` 只向本测试 disposable schema 插入固定 `owner/project/run`，state=SUCCEEDED、exit_code=0、termination_reason=BUILD_SUCCEEDED、有效起止时间，policy 使用 `{"runtime":{"javaMajor":17,"mavenMajor":3},"executionKind":"TASK"}`。日志用 `JdbcLogStore.insertChunk` 和 `RunLogWindow.Chunk` 写入，UTF-8 字节长度由原文本计算。每个测试独立 schema，不能用 `{}` 伪造合法 policy。

- [x] **2.1 先写业务边界失败测试。** 参数化覆盖全部八种 RunState；终态成功、非终态固定 409。另测跨 owner 404、空日志、中文/emoji/换行、历史 Java/Python/JavaScript/TypeScript 环境来自 Run policy、其他活跃 Run 不阻止已结束 Run。

下面的关键回归要求预览变化不产生分享；使用本任务定义的 fixture、Task 1 DTO 和本任务构造函数，不需要另建测试 DSL：

```java
try (var db = JdbcStoreTestSupport.create()) {
    RunShareTestFixtures.seedFinishedRun(db.jdbc(), "first\n");
    var service = new RunShareService(new JdbcRunShareStore(db.jdbc()),
        new JdbcRunStore(db.jdbc()), new JdbcLogStore(db.jdbc()),
        new ObjectMapper().findAndRegisterModules());
    var preview = service.preview("owner", "project", "run");
    db.jdbc().update("DELETE FROM run_log_chunk WHERE run_id = ?", "run");
    var request = new PublishRequest(UUID.randomUUID().toString(),
        preview.snapshotDigest(), "运行结果", "");
    assertThatThrownBy(() -> service.publish("owner", "project", "run", request))
        .isInstanceOfSatisfying(ApiException.class,
            error -> assertThat(error.code()).isEqualTo("RUN_SHARE_PREVIEW_CHANGED"));
    assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM run_share", Integer.class)).isZero();
}
```

异常断言使用现有 ApiException 的结构化 code，错误码不能只存在于内部 exception 文本。运行 `mvn -f poc4/backend/pom.xml -Dtest=RunShareServiceTest test`，先确认预期失败。

- [x] **2.2 实现快照与摘要。** 终态复用 `RunStateReducer.isTerminal`，权限使用 `RunStore.findRunForOwner`。日志直接 `JdbcLogStore.loadChunks`，不用 `RunLogService.windowFor`、WebSocket replay 或前端 evidence。Java 17 使用 `instanceof` 提取 RuntimeInfo.Java/Python/Node；旧 Java policy 由 `RunPolicy.fromJson` 处理，损坏策略固定报错，不猜环境。

```java
String logText = logs.loadChunks(runId).stream()
    .map(RunLogWindow.Chunk::text).collect(Collectors.joining());
// SnapshotEnvelope 为本服务 private record，字段顺序固定；不带时钟或随机值。
record SnapshotEnvelope(String projectId, String runId, SnapshotContent snapshot) {}
byte[] bytes = json.writeValueAsBytes(new SnapshotEnvelope(projectId, runId, snapshot));
String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
```

此处 `snapshot` 为本次读取的 `SnapshotContent(runSnapshot, logText)`。给 ObjectMapper 的固定 record 不包含无序 map。预览和发布调用同一个构造方法，避免两套字段列表漂移。日志内容为空合法，不推断其原因。

- [x] **2.3 实现短事务与幂等。** 为 `JdbcRunShareStore` 增加 `<T> T inProjectTransaction(String ownerId, String projectId, Function<Optional<LockedProject>, T> action)`，以及本模块内部 record `LockedProject(String id, String name, String state)`。TransactionTemplate 使用 `ISOLATION_READ_COMMITTED`；第一步尝试按 id+owner 对 project 行 `FOR UPDATE`，把结果交给 action，缺失/DELETING 此时不提前抛错。发布 action 先复查 requestId，再拒绝缺失/DELETING 项目；预览 action 直接检查项目。禁止在持锁期间做网络操作。

发布顺序固定为：事务外先查 owner/requestId → 同请求返回原状态 → project 行锁 → 锁内复查 requestId → 校验项目/Run → 查 ACTIVE → 构造一次快照 → 比较摘要 → INSERT。摘要比较和 INSERT 使用同一对象，不再次读日志。ACTIVE 查询条件如下：

```sql
SELECT id FROM run_share
WHERE owner_id = ? AND source_run_id = ?
  AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(6)
LIMIT 1;
```

已有有效链接返回 `RUN_SHARE_ALREADY_ACTIVE`，不能重新插入或改写旧内容。对同 owner/requestId 的唯一约束竞争，在失败事务结束后重新读取已提交结果并比较 request_digest；不同参数返回 `RUN_SHARE_REQUEST_MISMATCH`。`request_digest` 覆盖 source IDs、snapshotDigest、规范化 title/description。只对该唯一键冲突做结果核对，其他数据库错误不伪装成成功。

随机 token 在本服务中由 SecureRandom 生成 32 字节并 Base64URL 无 padding 编码，数据库唯一约束兜底。请求只接受 UUID 格式 requestId、64 位小写十六进制摘要及约定标题说明；拒绝客户端提交日志/有效期等合同外字段。

- [x] **2.4 验证重复和竞态后提交。** 测试同键同参返回同 id、同 token、同 expiresAt；同键异参 409；不同键同时创建只有一个 ACTIVE；数据库变更快照后发布 409；删除 project 后同键能找回原结果。额外控制交错顺序“重试首次查收据未命中 → 原发布提交 → 项目删除 → 重试尝试行锁”，要求仍返回原分享；不得在锁后查收据前因为项目缺失而失败。用 latch/barrier 控制并发顺序，不依赖长 sleep。

```powershell
mvn -f poc4/backend/pom.xml -Dtest=RunShareServiceTest,JdbcRunShareStoreTest test
git diff --check
```

只提交此任务 Files，提交 `feat: create run shares from server log snapshots`。

## Task 3：匿名读取、owner 管理和 72h 生命周期

**Files**

- Create: `poc4/backend/src/main/java/com/manao/poc4/share/RunShareController.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/share/PublicRunShareController.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/api/ApiError.java`（固定安全消息白名单；补全原 Files 遗漏）
- Modify: `poc4/backend/src/main/java/com/manao/poc4/share/RunShareService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/share/JdbcRunShareStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/RunShareConfig.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/SecurityConfig.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/RuntimeMaintenanceLoop.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/share/RunShareHttpContractTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/share/RunShareLifecycleTest.java`
- Modify/Test: `poc4/backend/src/test/java/com/manao/poc4/config/RuntimeMaintenanceLoopTest.java`

**Interfaces**

```java
PublicShare readPublic(String token);
SharePage listMine(String ownerId, int limit, String before);
void revoke(String ownerId, String shareId);
int purgeExpiredContent();
```

上述方法归于 RunShareService；SQL 在 JdbcRunShareStore。接口路径、响应码及 OwnerShare 字段严格按设计第 4 节。`status` 从 revokedAt / expiresAt 推导，不新增可漂移的数据库状态列。

- [x] **3.1 写权限、持久化与过期失败测试。** HTTP 测试使用真实安全过滤链，不仅 standalone controller。验证匿名 GET 成功、未登录创建/列表/撤销 401、其他 owner 管理 404、public 的 POST/DELETE 没有开放权限；数据库错误不能返回正常空日志。公开字段白名单断言排除 owner/source IDs、policy/env、截断字段。

生命周期核心回归为：创建后直接删源日志，再通过现有项目删除存储路径删 Run/project，重建分享服务后匿名读取内容仍相同；owner 列表和撤销仍成功。已清理、已过期的原 requestId 再次提交仍返回原失效状态。

```java
// 在已创建分享的 disposable schema 中，先到期但不运行维护任务。
jdbc.update("UPDATE run_share SET expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE id = ?", shareId);
assertThatThrownBy(() -> service.readPublic(token))
    .isInstanceOfSatisfying(ApiException.class,
        error -> assertThat(error.code()).isEqualTo("RUN_SHARE_EXPIRED"));
assertThat(jdbc.queryForObject("SELECT log_text FROM run_share WHERE id = ?", String.class, shareId))
    .isNotNull();
service.purgeExpiredContent();
assertThat(jdbc.queryForObject("SELECT log_text FROM run_share WHERE id = ?", String.class, shareId))
    .isNull();
```

这里的 `jdbc/service/shareId/token` 来自同一测试中通过 Task 2 fixture、preview/publish 建立的记录。状态映射函数 `statusAt(Instant now, Instant expiresAt, Instant revokedAt)` 测试 `now == expiresAt` 为 EXPIRED；生产传入公开 SELECT 同句返回的数据库时间。另通过数据库集成测试验证到期前可读、到期后不可读，不用浏览器时钟控制权限。

- [x] **3.2 实现公开接口和 owner 管理。** 公开 SELECT 用同一语句的数据库时间判断状态，只有有效分支才返回大字段；撤销优先判为 REVOKED，未撤销且 `now >= expiresAt` 为 EXPIRED。失效 410，不存在 404；预览、公开成功与错误响应均 `Cache-Control: no-store`。SecurityConfig 只加入下面的 GET 放行规则，其他匹配仍认证：

```java
.requestMatchers(HttpMethod.GET, "/api/v1/public/run-shares/*").permitAll()
```

owner 列表用 `(created_at,id)` 游标、默认 20/最多 50，查询只 SELECT 摘要字段；sharePath 仅 ACTIVE 返回。游标编码固定字段并校验格式，owner 条件不来自游标。撤销按 id+owner 获取记录，在同一事务清正文；已撤销重复操作 204，已过期也清正文但不改为“已撤销”。原项目无需存在。

- [x] **3.3 接入每 2 小时一次的正文回收。** 在 RuntimeMaintenanceLoop 增加 `@Scheduled(fixedDelay = 7200000)`，沿用 `safe(...)` 隔离失败；调用 `purgeExpiredContent()`。固定延迟从上次执行完成后计算，72 小时到期拒读不等待该任务。回收 SQL 保留请求收据：

```sql
UPDATE run_share
SET log_text = NULL, description = NULL, run_snapshot_json = NULL
WHERE expires_at <= UTC_TIMESTAMP(6)
  AND (log_text IS NOT NULL OR description IS NOT NULL OR run_snapshot_json IS NOT NULL);
```

撤销立即运行同类清空操作并记录 revoked_at；到期记录撤销时仍清空正文。验证回收调度间隔为 7200000 ms，并直接调用回收方法测试内容清空，不实际等待 2 小时。测试维护失败不阻断其他维护循环、重启后继续回收；不引入新 worker/队列。`RuntimeMaintenanceLoopTest` 如构造参数增加，更新其 provider fixture。

- [x] **3.4 运行针对性回归并提交。** 特别验证“服务重建 + 源项目删除 + 后续撤销”和“过期但清理未执行仍拒读”。

```powershell
mvn -f poc4/backend/pom.xml -Dtest=RunShareHttpContractTest,RunShareLifecycleTest,RunShareServiceTest,RuntimeMaintenanceLoopTest,JwtAuthenticationFilterTest test
git diff --check
```

只提交此任务 Files，提交 `feat: expose expiring public run shares and owner controls`。

## Task 4：分享弹窗、公共页与我的分享

**Files**

- Create: `poc4/frontend/src/contracts/runShare.ts`、同目录 `runShare.test.ts`
- Create: `poc4/frontend/src/api/runShareApi.ts`、同目录 `runShareApi.test.ts`
- Create: `poc4/frontend/src/features/shares/runShareQueries.ts`
- Create: `poc4/frontend/src/features/shares/RunShareDialog.tsx`
- Create: `poc4/frontend/src/features/shares/RunShareContent.tsx`
- Create: `poc4/frontend/src/features/shares/ShareLinkPanel.tsx`
- Create: `poc4/frontend/src/features/shares/PublicRunSharePage.tsx`
- Create: `poc4/frontend/src/features/shares/MyRunSharesPage.tsx`
- Test: `poc4/frontend/src/features/shares/RunShareDialog.test.tsx`
- Test: `poc4/frontend/src/features/shares/PublicRunSharePage.test.tsx`
- Test: `poc4/frontend/src/features/shares/MyRunSharesPage.test.tsx`
- Modify: `poc4/frontend/src/components/runs/RunPanel.tsx`、同目录 `RunPanel.test.tsx`
- Modify: `poc4/frontend/src/components/shell/AccountPanel.tsx`
- Modify: `poc4/frontend/src/app/AppRouter.tsx`
- Modify: `poc4/frontend/src/contracts/api.ts`、`poc4/frontend/src/api/httpClient.ts`（业务错误码 allowlist）
- Modify: `poc4/frontend/package.json`、`poc4/frontend/pnpm-lock.yaml`

**Interfaces**

TypeScript DTO 与 Task 1 同名字段，时间改为 ISO string；Preview 使用可辨识 union：

```typescript
type RunSharePreview =
  | { kind: 'PREVIEW'; snapshot: SnapshotContent; snapshotDigest: string; share: null }
  | { kind: 'EXISTING'; snapshot: null; snapshotDigest: null; share: OwnerShare };
type RunShareStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';
type RunShareDialogProps = { projectId: string; runId: string; onClose: () => void };
type RunShareContentProps = { title: string; description: string; snapshot: SnapshotContent };
type ShareLinkPanelProps = { url: string; expiresAt: string };
```

在 `runShareApi.ts` 提供 `getRunSharePreview(projectId, runId)`、`createRunShare(projectId, runId, request: PublishRequest)`、`getPublicRunShare(token)`、`listMyRunShares(before?: string)`、`revokeRunShare(shareId)`。create 返回 OwnerShare；201 与同请求 200 均解析同一响应 body。接口均使用现有 HttpClient，不新建第二套 fetch 客户端。

- [x] **4.1 先写交互与合同失败测试。** 使用已有 Vitest/Testing Library fixture：历史终态可分享、当前非终态不能；生成请求无日志/owner/有效期；EXISTING 进入管理态；输入保留；PREVIEW_CHANGED 必须重新确认；退出码 null 不显示为 0。API 测试断言匿名访问 `auth:false` 且不带 Authorization，过期不会清除登录用户会话。

测试请求形状至少包含如下断言，`body` 是测试 spy 捕获的生成请求 body：

```typescript
expect(Object.keys(body).sort()).toEqual(
  ['description', 'requestId', 'snapshotDigest', 'title'],
);
expect(body).not.toHaveProperty('logText');
expect(body).not.toHaveProperty('expiresAt');
```

运行 `pnpm --dir poc4/frontend exec vitest run src/contracts/runShare.test.ts src/api/runShareApi.test.ts src/features/shares src/components/runs/RunPanel.test.tsx`，先确认预期失败。

- [x] **4.2 实现最小数据流与入口。** RunPanel 按 `selectedRun && isRunTerminalState(selectedRun.state)` 开启按钮，弹窗打开时固定 projectId/runId。创建前分配一个 requestId，提交中禁用按钮；传输不确定时保留同一 requestId 和请求体，手动重试找回原结果。只有明确收到未创建的 4xx 并完成新的预览/编辑，才开始新的提交尝试；不能超时后自动生成新键。

`runShareQueries.ts` 中 owner 缓存 key 以当前 owner 身份为边界，登出/切换账号不显示上一个账号记录；不得纳入 project deletion 的缓存删除前缀。公共页使用独立组件状态或 `gcTime:0` 的非持久化查询，路由 token 改变/离开页面时清理正文引用，不展示上一 token 内容。

路由 `/shares/:token` 放在 RequireAuth 外；`/account/shares` 放在已有账户保护路由下。AccountPanel 加“我的分享”。管理页使用轻量账户页壳，不改工作台布局；公共页不使用需要项目和实时连接的 RunLogView。

- [x] **4.3 实现共用展示和本地二维码。** `RunShareContent` 同时供预览和公共页使用；React 文本节点显示标题/说明/日志，日志固定高度滚动，空日志显示约定文案，不使用 `dangerouslySetInnerHTML`。起止时间格式化只在显示层进行。公共页到期计时后隐藏正文；撤销无需轮询，后续请求或刷新显示失效。

```powershell
pnpm --dir poc4/frontend add qrcode.react
```

```tsx
<QRCodeSVG value={url} size={192} marginSize={4} title="运行结果分享二维码" />
```

`url = new URL(share.sharePath, window.location.origin).toString()`，sharePath 解析只接受本功能 `/shares/` 相对路径。页面给出可选中的链接文本、复制反馈及到期时间；剪贴板失败仍能手动复制。管理列表对 ACTIVE 显示复制/撤销，对 EXPIRED/REVOKED 显示原因，不提供续期。

- [x] **4.4 跑目标前端测试和构建后提交。** 添加 HTML 文本日志、空日志、5 MiB 文本、路由切换不串内容、匿名/已登录公共访问、source 删除后管理可达、复制失败、二维码同 URL、过期计时、网络错误可重试的组件覆盖。确认手机宽度可操作。

```powershell
pnpm --dir poc4/frontend exec vitest run src/contracts/runShare.test.ts src/api/runShareApi.test.ts src/features/shares src/components/runs/RunPanel.test.tsx
pnpm --dir poc4/frontend build
git diff --check
```

`build` 已包含 typecheck，不重复运行等价检查。只提交此任务 Files，提交 `feat: add run sharing and public result pages`。

## Task 5：真实闭环、部署前检查与交付记录

**Files**

- Create: `poc4/frontend/playwright.run-sharing.config.ts`
- Create: `poc4/frontend/tests/e2e/run-sharing.spec.ts`
- Create: `poc4/docs/run-result-sharing.md`
- Create: `poc4/docs/evidence/run-result-sharing/acceptance.md`
- Modify: `docs/README.md`（功能说明入口）
- Modify: `docs/what-we-have-done.md`（仅在实际实现及验证后记录对应状态）

**Interfaces**

E2E 使用 `MANAO_BASE_URL` 指向已经准备好的测试站点；凭据复用既有测试环境的私密注入，不写入源码或报告。配置缺少 base URL 直接失败，不默默启动 mock 或指向生产。一个 Chromium 项目，`workers:1`，`retries:0`，testMatch 只匹配本功能 spec，不更改既有 Stage 6 gate。

- [x] **5.1 写一条真实服务闭环验收。** 用专属测试账号创建 disposable 项目并完成一次正常运行；在浏览器生成分享，保存分享 ID 和到期时间。另建没有 storageState 的浏览器 context 打开公开 URL。通过已授权测试账号删除该源项目，等待原接口返回 404，再在匿名 context 刷新确认内容相同；最后从账户“我的分享”撤销，并确认匿名刷新显示已撤销。使用 `try/finally` 关闭 context，并按 owner/project 精确清理本测试产物。

该测试通过 UI 生成/撤销，通过真实后端读取；不得用路由拦截伪造源项目删除后内容仍存活。精确 TTL 与所有终态组合已由前面数据库/HTTP 测试负责，不在浏览器等待 72 小时。

```typescript
const anonymous = await browser.newContext();
try {
  const recipient = await anonymous.newPage();
  await recipient.goto(shareUrl);
  await expect(recipient.getByRole('heading', { name: title })).toBeVisible();
  expect(await recipient.getByTestId('run-share-log').textContent()).toBe(expectedLog);
  // source 删除并确认 404 后、撤销之前，必须再次执行这两条内容断言。
} finally {
  await anonymous.close();
}
```

`shareUrl/title/expectedLog` 必须来自本测试创建的运行和分享；`data-testid="run-share-log"` 由 Task 4 的共用展示组件提供。正文比较保留原换行，不能只检查“页面存在”。

- [x] **5.2 完成一次大内容和部署路径检查。** 用 JdbcStoreTestSupport 构造接近正常 5 MiB 窗口、包含控制字符和多字节文本的保留 chunks，验证 JDBC 写入、HTTP JSON、前端展示不裁剪；若 `max_allowed_packet` 等现有部署设置不足，记录实际错误并仅调整必要配置。通过测试站点的真实入口直接打开及刷新 `/shares/:token`，确认 SPA fallback 和 `/api/v1/public/run-shares/*` 工作，二维码使用同一公开 origin。

```powershell
mvn -f poc4/backend/pom.xml -Dtest=RunShareUpgradeMigrationTest,StudioUpgradeMigrationTest,JdbcRunShareStoreTest,RunShareServiceTest,RunShareHttpContractTest,RunShareLifecycleTest,RuntimeMaintenanceLoopTest test
pnpm --dir poc4/frontend exec vitest run src/contracts/runShare.test.ts src/api/runShareApi.test.ts src/features/shares src/components/runs/RunPanel.test.tsx
pnpm --dir poc4/frontend build
pnpm --dir poc4/frontend exec playwright test --config playwright.run-sharing.config.ts
```

此前目标检查已在同一最终代码通过、且没有后续相关修改时，直接复用结果，不机械重跑全部命令。真实测试环境未准备好就记录 `NOT_RUN`，不把组件模拟或 `--list` 当成功。

- [x] **5.3 记录必要交付证据与上线顺序。** 功能说明写用户流程和已确定限制；acceptance 按下表记录实际状态、源码 SHA、命令和证据路径。部署采用“加法迁移 → 后端 → 前端”，业务回滚时保留新表和旧分享数据，不通过删表回滚。部署行为仅在后续实现任务获得相应授权后执行，本计划不代表已部署。

| 验收项 | 必须证明的结果 |
| --- | --- |
| 资格 | 四种终态可分享，非终态不可；当前活跃 Run 不阻止历史终态 |
| 内容 | 服务端当前保留全部 chunks 原样复制；空日志合法；无截断提示；摘要变化拒绝发布 |
| 唯一与重试 | 每 Run 最多一个 ACTIVE；同键返回同结果；过期/撤销后的旧请求不复活 |
| 独立性 | 源日志清理、项目删除、后端服务重建后仍可访问原快照 |
| 生命周期 | createdAt +72h；到期立即拒读；到期正文每 2 小时回收一次，撤销同步清正文；保留重试收据 |
| 权限与展示 | 匿名只读、非 owner 不可管理；HTML 原样；响应无缓存；公开字段白名单 |
| 真实闭环 | 登录生成 → 匿名看 → 删除源项目后仍可看 → 账户撤销 → 匿名失效 |

- [x] **5.4 收尾提交。** 按 `verification-before-completion` 核对证据；检查 UTF-8 无 BOM、`git diff --check`、相对文档链接和改动范围。清理本次不再需要的临时文件；只删除明确属于本测试的运行资源。提交 `test: verify independent run share lifecycle`，报告真实 PASS / FAILED / NOT_RUN，不宣称整个系统重新验收通过。

## 本次计划交付的自检

- 用户已确认的资格、日志范围、空日志、独立生命周期、单有效链接和失效/回收语义均已映射到任务及验收项。
- 核心接口在 Task 1/2/3 固定，Task 4 只消费该合同；不存在草稿、实时推送或额外存储依赖。
- 迁移只增加新表；发现的旧 Studio 升级测试假设已纳入 Task 1。
- 实现、针对性 MySQL/HTTP/前端验证和第三轮本地真实闭环已有 PASS；前两轮失败及环境差异保留，未执行的云端部署保持 `NOT_RUN`，不从本次功能验收推导整个平台重新验收。
