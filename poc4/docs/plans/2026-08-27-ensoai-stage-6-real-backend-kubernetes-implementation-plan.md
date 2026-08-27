# POC4 阶段六真实后端与 Kubernetes 集成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Every task uses TDD, a focused commit, and an explicit verification gate.

**目标：** 在不改变阶段五 REST/WebSocket 合同和 POC4 核心规则的前提下，交付可由本机或 Kubernetes Pod 运行的真实 Spring Boot 后端，并完成 6A 本机集成和 6B 集群 Pod 两轮验收。

**架构：** 后端采用模块化 Spring Boot 单体，业务状态、锁、ticket、日志和 audit 以 MySQL 为权威；项目文件只经 workspace Pod/Service 访问真实 RWX PVC；Job/Pod、日志和 PTY 事实由 Kubernetes API 提供。`local-cluster`（6A）使用本机 Spring Boot、本机 MySQL、SSH API 隧道和后端管理的 workspace `kubectl port-forward`；`cluster`（6B）使用同一构建产物的单副本 Deployment、集群 MySQL、ServiceAccount 和集群内 API。

**技术栈：** Java 17、Spring Boot 3.5.9、Maven、Spring Web/Validation/Security/WebSocket/Actuator/JDBC、Flyway、MySQL、Fabric8 Kubernetes Client 7.7.0、JUnit 5、MockMvc、WebSocket client、Fabric8 mock/受控 Kubernetes、React 19、TypeScript 5.9、Vite 7、pnpm 10、Playwright。新增依赖必须先更新设计并说明理由；前端包管理只使用 pnpm。

**规格依据：** [阶段六真实后端与 Kubernetes 集成设计](../2026-08-27-ensoai-stage-6-real-backend-kubernetes-design.md)。阶段五前端实现和证据仅作为浏览器合同输入，不能替代真实后端、MySQL、PVC、Fabric8、PTY 或集群证据。

## 全局硬约束

- 阶段六必须按 `6A -> 6B` 顺序执行；仅 6A 通过不能写阶段六完成。
- 浏览器只看到不透明业务 ID、状态和筛选内容；不得返回 PVC、Pod、Job、Namespace、ServiceAccount、容器名、集群地址或绝对路径。
- 后端不得直接挂载项目 PVC；文件正文只通过 workspace Service/Pod 访问；Job/PTY 对项目 PVC 的受控读写副作用必须记录为 POC 风险。
- Run locking states 为 `STARTING`、`RUNNING`、`STOPPING`、`RECOVERING`；终态为 `SUCCEEDED`、`FAILED`、`CANCELLED`、`TIMED_OUT`；单项目不得有两个活动 Run。
- Start 请求严格为 `{\"expectedWorkspaceRevision\":\"revision-from-client\"}`；命令固定为 `mvn clean test`，Java 17、Maven 3.9、`activeDeadlineSeconds: 1800`，资源上限为 8 CPU、16 GiB 内存、10 GiB ephemeral storage。
- 日志先持久化再推送，窗口最多 5 MiB，结束记录保留 7 天；日志通道与 terminal 通道完全隔离。
- 每个项目 PVC 容量固定为 10 GiB，StorageClass 必须为 `ReadWriteMany`；6A workspace bridge 的本地端口固定从 `18100-18199` 分配，workspace-agent Service 端口固定为 `8080`，API SSH 隧道不得占用该范围。
- workspace capability 线协议固定为 `X-Manao-Workspace-Capability: v1.<projectId>.<issuedAtEpochMs>.<nonceBase64Url>.<signatureBase64Url>`；签名算法为 Ed25519，签名输入固定为 `v1\\n<HTTP-method>\\n<request-path-and-query>\\n<SHA-256(request-body)>\\n<projectId>\\n<issuedAtEpochMs>\\n<nonceBase64Url>`，允许时钟偏差 +/-60 秒，nonce 缓存 120 秒；每个 workspace-agent 只接受自己的 projectId，私钥按 profile 隔离并外部注入。
- `workspace_revision` 的唯一权威是 MySQL；agent 只返回 operationId、前后 SHA-256 和同卷 receipt。文件写入必须经过 `workspace_operation=PENDING -> agent atomic write -> COMMITTED`，receipt 缺失或摘要不一致时 fail closed，不猜测覆盖或回滚。
- 项目创建必须先用 PVC 根挂载的 initializer Pod 创建并校验项目目录，再使用 `subPath` 启动 workspace Pod；`CREATING` 超过 10 分钟由启动恢复扫描，未能对账则补偿清理并置为 `FAILED`。
- HTTP 错误包的线协议字段必须使用阶段五前端合同要求的 `traceId`；设计示例中的 `requestId` 只能作为后端内部关联名，不得替代或额外暴露为响应字段。
- Terminal ticket 约 30 秒有效、单次消费、绑定 user/project/run；JWT 不进入 WebSocket URL、frame、DOM、截图或日志；旧 PTY 永不自动恢复。
- `RESERVED` ticket 每 10 秒按数据库时间扫描，过期条件更新为 `EXPIRED`；Terminal 输出 frame <=32 KiB、初始和最大 credit 256 KiB、输入 frame <=16 KiB、服务端输入队列 <=64 KiB，超限 fail closed。
- Maven Job、workspace-agent 和 initializer 镜像都必须使用 immutable digest；Maven Job PID 1 直接执行固定参数数组 `mvn clean test`，PTY 只能通过同一应用容器内独立 `pods/exec` 启动固定 root-owned wrapper/Bash。
- Maven Job PID 1 直接执行参数数组 `mvn clean test`；PTY 是同一应用容器内独立 `pods/exec` 启动的固定 root-owned wrapper/Bash，不是 Job entrypoint、sidecar 或用户可控 shell 的替代品。
- Terminal session 的活动状态固定为 `RESERVED`、`LIVE`；`CLOSED`、`EXPIRED`、`INTERRUPTED`、`FAILED` 为终态，活动状态按 Run 维度唯一。
- 6A kubeconfig 身份必须与 6B ServiceAccount 具备等价 namespace Role；SSH 只转发 Kubernetes API 并保留 CA/主机名校验；`pods/portforward` 仅用于 6A workspace bridge。
- 6B Deployment 为单副本，strategy 固定为 `Recreate`，并以数据库 instance lease/fencing token 防止旧 Pod 与新 Pod 同时执行恢复、watch、清理或写操作；同时满足 `runAsNonRoot`、禁止提权、丢弃 capabilities、RuntimeDefault seccomp、只读根文件系统、`/tmp` 使用 `emptyDir`。
- 真实证据报告区分 `PASS`、`WAIVED_BY_USER`、`SKIPPED`、`FAILED`；mock/Fabric8 stub 只能标为合同或适配证据。
- 不修改、不提交当前未跟踪的 `.grok/`；不在仓库写入 kubeconfig、SSH 私钥、token、密码、JWT 密钥、镜像 digest 或真实集群地址。
- Windows 文件保持 UTF-8 无 BOM；编辑前重新读取；小范围 `apply_patch`；最终执行 `git diff --check`。

---

## 文件与模块地图

计划新增或修改的文件按职责分组：

```text
poc4/backend/
├─ pom.xml
├─ src/main/java/com/manao/poc4/
│  ├─ Poc4BackendApplication.java
│  ├─ config/                 profile、属性、Actuator、WebSocket、安全过滤器
│  ├─ api/                    DTO、错误包、异常映射、REST controllers
│  ├─ auth/                   用户、密码哈希、JWT、owner context
│  ├─ project/                项目元数据和创建编排
│  ├─ workspace/              workspace API client、路径策略、文件 CRUD
│  ├─ run/                    Run 状态机、锁、Job coordinator
│  ├─ log/                    Pod log persistence、窗口、ticket、WebSocket
│  ├─ terminal/               session ticket、PTY bridge、流控、关闭
│  ├─ audit/                  wrapper ingress、settlement、分页、清理
│  ├─ kubernetes/             Fabric8 适配、资源身份、watch、exec、port-forward
│  └─ recovery/               CREATING/Run 对账、instance lease、fencing
├─ src/main/resources/
│  ├─ application.yml
│  ├─ application-local-cluster.yml
│  ├─ application-cluster.yml
│  └─ db/migration/V1__initial_schema.sql、V2__indexes_and_constraints.sql
├─ src/test/java/com/manao/poc4/{config,persistence,auth,project,workspace,run,log,terminal,audit,deploy}/
├─ Dockerfile、.dockerignore、README.md
└─ deploy/
   ├─ namespace-role.yaml
   ├─ local-cluster-role.example.yaml
   ├─ service-account.yaml
   ├─ backend-deployment.yaml
   ├─ backend-service.yaml
   ├─ config.example.env
   └─ test-operator-role.example.yaml

poc4/workspace-agent/
├─ pom.xml
├─ src/main/java/com/manao/poc4/workspaceagent/WorkspaceAgentApplication.java
├─ src/main/java/com/manao/poc4/workspaceagent/WorkspaceAgentController.java
├─ src/main/java/com/manao/poc4/workspaceagent/WorkspacePathPolicy.java
├─ src/main/java/com/manao/poc4/workspaceagent/WorkspaceFileService.java
├─ src/main/java/com/manao/poc4/workspaceagent/WorkspaceCapabilityVerifier.java
├─ src/main/java/com/manao/poc4/workspaceagent/WorkspaceReceiptStore.java
├─ src/test/java/com/manao/poc4/workspaceagent/WorkspaceFileServiceTest.java
├─ Dockerfile
└─ deploy/workspace-agent.yaml

poc4/frontend/
├─ src/api/、src/contracts/、src/features/、src/mocks/（仅替换真实连接配置，不改阶段五合同）
├─ .env.local-cluster.example
├─ .env.cluster.example
└─ playwright.config.ts、README.md

poc4/docs/evidence/stage-6/
├─ 6a-gate.md
├─ 6a-local-cluster-result.md
├─ 6b-cluster-pod-result.md
└─ final-result.md
```

前端已有类型解析器和 API 路径是后端合同的消费者；计划中后端 DTO 必须逐项对齐现有 `poc4/frontend/src/contracts/`，不得另起一套字段名。

## 阶段顺序与决策门

```text
Task 1 后端骨架/合同/配置
        |
Task 2 MySQL schema/Flyway/事务基础
        |
Task 3 认证、项目、统一错误和 owner 授权
        |
Task 4 workspace Pod/Service、PVC 文件 API、安全路径
        |
Task 5 Run 状态机、Job 创建/停止/恢复
        |
Task 6 日志持久化、replay/live、log ticket
        |
Task 7 terminal session、Fabric8 exec PTY、流控
        |
Task 8 wrapper audit、清理、恢复和跨模块并发
        |
Task 9 6A 本机 profile、SSH API tunnel、workspace bridge
        |
Task 9A 6A 决策门：本机 Spring Boot + 本机 MySQL + 真实集群 E2E（独立记录）
        |
Task 10 仅在 6A Gate PASS 后执行：6B Deployment、RBAC、Secret、探针和镜像
        |
Task 11 6B 集群 E2E、故障/压力和证据包
        |
Task 12 阶段六最终报告与 READY_FOR_STAGE_7_PLAN
```

6A 决策门失败时只进入修复，不开始 6B。6B 任何安全、恢复或真实 E2E 门失败时，结论为 `STAGE_6_REMEDIATION_REQUIRED`，不得用 mock 结果补齐。

## Task 1：建立后端骨架、合同类型与双 profile 配置

**Files:**

- Create: `poc4/backend/pom.xml`
- Create: `poc4/backend/src/main/java/com/manao/poc4/Poc4BackendApplication.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/config/BackendProperties.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/config/BackendProfile.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/config/WebSocketConfig.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/config/ActuatorConfig.java`
- Create: `poc4/backend/src/main/resources/application.yml`
- Create: `poc4/backend/src/main/resources/application-local-cluster.yml`
- Create: `poc4/backend/src/main/resources/application-cluster.yml`
- Create: `poc4/backend/src/test/java/com/manao/poc4/config/ConfigurationTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/config/HealthEndpointTest.java`

**Interfaces:**

- Produces `BackendProperties` containing profile, namespace, fixed command, Java/Maven versions, timeout, resource ceilings, workspace bridge settings and redacted logging policy.
- Produces `/actuator/health/liveness` and `/actuator/health/readiness`; liveness is process-only, readiness includes MySQL and Kubernetes client availability.
- Consumes only environment/config values for credentials and endpoints; no secret is committed.

- [ ] **Step 1: Write failing profile and health tests**

Assert `local-cluster` and `cluster` load distinct datasource/Kubernetes settings, fixed policy values cannot be overridden by browser fields, liveness remains UP when a dependency is unavailable, and readiness becomes unavailable. Assert unknown profile properties fail startup rather than silently changing policy.

- [ ] **Step 2: Run tests to verify failure**

Run from `poc4/backend`: `mvn -q -Dtest=ConfigurationTest,HealthEndpointTest test`.
Expected: FAIL because the Spring Boot module and configuration classes do not yet exist.

- [ ] **Step 3: Add minimal Spring Boot module and configuration**

Use Spring Boot `3.5.9`, Java 17, Fabric8 `7.7.0`, validation, web, websocket, security, actuator, JDBC, Flyway, MySQL connector and test dependencies. Load `application-{profile}.yml`; expose only fixed server policy as read-only `BackendProperties`. Enable liveness/readiness groups using the documented Actuator endpoints and keep dependency health out of liveness.

- [ ] **Step 4: Run focused tests and compile**

Run: `mvn -q -Dtest=ConfigurationTest,HealthEndpointTest test` and `mvn -q -DskipTests compile`.
Expected: PASS and Java 17 compilation succeeds.

- [ ] **Step 5: Commit**

```powershell
git add poc4/backend
git commit -m "feat(poc4): bootstrap stage 6 backend profiles"
```

## Task 2：实现 Flyway schema、repository 和事务原子性基础

**Files:**

- Create: `poc4/backend/src/main/resources/db/migration/V1__initial_schema.sql`
- Create: `poc4/backend/src/main/resources/db/migration/V2__indexes_and_constraints.sql`
- Create: `poc4/backend/src/main/java/com/manao/poc4/persistence/DatabaseClock.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/persistence/RunState.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/persistence/TerminalSessionState.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/persistence/WorkspaceOperationState.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/persistence/InstanceLeaseRepository.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/persistence/Repositories.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/persistence/WorkspaceOperationRepository.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/persistence/FlywaySchemaTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/persistence/AtomicTransitionTest.java`
- Modify: `poc4/backend/pom.xml`

**Interfaces:**

- Tables: `app_user`, `project`, `workspace_operation`, `run`, `run_log_chunk`, `log_ticket`, `terminal_session`, `terminal_audit`, `instance_lease`.
- Repository methods must support owner-scoped lookups, active Run unique enforcement, version/state conditional updates, single-use ticket consumption, audit settlement, `PENDING` workspace operation reconciliation and a single fenced instance lease.
- `DatabaseClock` is injectable so expiry and seven-day cleanup tests do not depend on wall-clock sleeps.

- [ ] **Step 1: Write failing schema and concurrency tests**

Test Flyway from empty MySQL schema, unique username, maximum three projects at service level, `(run.project_id, locking-state)` uniqueness strategy, `(run_id, seq)` uniqueness, ticket hash uniqueness, one live terminal reservation, version-conditional Run update, `workspace_operation` pending/commit/reconciliation, single instance lease fencing and idempotent audit settlement.

- [ ] **Step 2: Run integration tests to verify failure**

Run: `mvn -q -Dtest=FlywaySchemaTest,AtomicTransitionTest test` with the documented isolated MySQL test URL. Expected: FAIL because migrations and repositories are absent.

- [ ] **Step 3: Add migrations and repository SQL**

Use UTC timestamps, opaque string IDs, bounded text/blob columns, foreign keys and indexes for owner/project/run queries. Add `workspace_operation` states `PENDING/COMMITTED/FAILED` with unique `(project_id, state=PENDING)` marker and immutable before/after SHA-256 fields. Add `instance_lease(id, holder_id, fencing_token, expires_at)` with one row and conditional acquire/renew; every recovery/watch/cleanup/write operation must carry the current fencing token. In MySQL, add stored nullable generated markers `active_run_marker = CASE WHEN state IN ('STARTING','RUNNING','STOPPING','RECOVERING') THEN 1 ELSE NULL END` and `active_terminal_marker = CASE WHEN state IN ('RESERVED','LIVE') THEN 1 ELSE NULL END`, then unique-index `(project_id, active_run_marker)` on `run` and `(run_id, active_terminal_marker)` on `terminal_session`; NULL permits any number of terminal rows while allowing at most one active row. Use conditional `UPDATE run SET state = :nextState, version = version + 1 WHERE id = :runId AND project_id = :projectId AND version = :expectedVersion AND state IN (:allowedStates)` and inspect affected rows before any Kubernetes side effect.

- [ ] **Step 4: Run focused tests and inspect schema**

Run the focused Maven tests plus `mvn -q flyway:info` against an empty test schema. Expected: all constraints pass, duplicate inserts are rejected, and migrations are repeatable only through forward migration.

- [ ] **Step 5: Commit**

```powershell
git add poc4/backend/pom.xml poc4/backend/src/main poc4/backend/src/test
git commit -m "feat(poc4): add backend persistence schema"
```

## Task 3：实现 JWT 认证、项目服务和统一错误合同

**Files:**

- Create: `poc4/backend/src/main/java/com/manao/poc4/auth/JwtAuthenticationFilter.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/auth/JwtService.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/auth/PasswordService.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/auth/AuthController.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectService.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectController.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/api/ApiError.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/api/GlobalExceptionHandler.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/config/SecurityConfig.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/auth/AuthControllerTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectAuthorizationTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/api/ErrorSanitizationTest.java`

**Interfaces:**

- `POST /api/v1/auth/login` returns the existing `accessToken`, `expiresAt`, `user` shape.
- `GET/POST /api/v1/projects` and `GET /api/v1/projects/{projectId}` use owner-scoped service methods; unknown/non-owned project existence is hidden with the agreed error semantics.
- `ApiError` serializes only finite `code`, safe `message`, and opaque `traceId`; no stack, token, resource name, path or command.
- `traceId` is the only correlation field returned to the browser; `requestId` may be emitted only in redacted server logs and is never part of a DTO, error body, frame, DOM or screenshot.

- [ ] **Step 1: Write failing auth/owner/error tests**

Cover valid login, wrong password, expired/malformed JWT, Alice/Bob owner isolation, three-project limit, unknown fields, and response-body scans for JWT/password/PVC/Pod/Job/path/command leakage.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `mvn -q -Dtest=AuthControllerTest,ProjectAuthorizationTest,ErrorSanitizationTest test`.
Expected: FAIL because controllers, filters and DTOs do not exist.

- [ ] **Step 3: Implement minimal auth and project boundary**

Use BCrypt/Argon2-compatible password hashing without plaintext storage, JWT claims containing only opaque user identity and expiry, constructor-injected services, `@Valid` request DTOs and strict JSON field allowlists. Keep secrets externalized with startup failure when required secret values are missing.

- [ ] **Step 4: Run tests and verify browser contract shape**

Run the focused tests and a small MockMvc contract suite that compares field names/enums against `poc4/frontend/src/contracts/auth.ts`, `project.ts`, and `api.ts`. Expected: all pass and no internal identifier appears in body or logs.

- [ ] **Step 5: Commit**

```powershell
git add poc4/backend/src/main poc4/backend/src/test
git commit -m "feat(poc4): add jwt and project ownership"
```

## Task 4：实现 workspace-agent、workspace Pod/Service、PVC 文件代理和路径安全

**Files:**

- Create: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceService.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceController.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspacePathPolicy.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceCapabilitySigner.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceOperationService.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspaceResourceFactory.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspaceInitializerFactory.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspaceApiClient.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/recovery/ProjectRecoveryService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectController.java`
- Create: `poc4/workspace-agent/pom.xml`
- Create: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/WorkspaceAgentApplication.java`
- Create: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/WorkspaceAgentController.java`
- Create: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/WorkspacePathPolicy.java`
- Create: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/WorkspaceFileService.java`
- Create: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/WorkspaceCapabilityVerifier.java`
- Create: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/WorkspaceReceiptStore.java`
- Create: `poc4/workspace-agent/src/test/java/com/manao/poc4/workspaceagent/WorkspaceFileServiceTest.java`
- Create: `poc4/workspace-agent/Dockerfile`
- Create: `poc4/workspace-agent/deploy/workspace-agent.yaml`
- Create: `poc4/backend/src/test/java/com/manao/poc4/workspace/WorkspacePathPolicyTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/workspace/WorkspaceControllerTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/WorkspaceResourceFactoryTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/recovery/ProjectRecoveryServiceTest.java`

**Interfaces:**

- Implements all file endpoints from the design: tree/meta/content/download, save, create, rename, delete. Project creation writes `CREATING`, creates the PVC, runs a root-mounted one-shot initializer Pod that creates the derived project directory with fixed UID/GID/`fsGroup`, and only then creates the `subPath` workspace Pod and ClusterIP Service. It waits for readiness, writes the fixed Java 17/Maven template through the internal workspace API, then marks the project `READY`; any partial failure records `FAILED` and cleans only resources with the matching server labels created by that request.
- `WorkspacePathPolicy.resolve(projectRoot, relativePath)` rejects absolute paths, empty misuse, `..`, symlink escapes and root escapes; final real path must remain below the derived project directory.
- `WorkspaceApiClient` is the only boundary allowed to touch workspace Pod file APIs; controllers never accept PVC/Pod/Service names.
- `WorkspaceOperationService.save(projectId, expectedRevision, content)` persists `workspace_operation(PENDING)`, calls the agent with the same operation ID, verifies the atomic receipt, then conditionally commits the operation and increments the MySQL revision. Agent-local counters are never authorization inputs; recovery either commits a matching receipt or sets `project.state=FAILED` and `failure_reason=WORKSPACE_RECONCILIATION_REQUIRED`.
- `workspace-agent` is a separate minimal process: it mounts only its project PVC `subPath`, listens only on a namespace-internal ClusterIP, verifies the exact Ed25519 capability header and project scope, performs final real-path containment and atomic file operations, records an idempotent same-volume receipt, and has no Kubernetes API client, capability private key or ServiceAccount token.
- `ProjectRecoveryService` scans `CREATING` projects older than 10 minutes and verifies the initializer/PVC/Pod/Service/template receipt. It may complete a uniquely matching project to `READY`; otherwise it performs label-scoped idempotent cleanup and sets `FAILED` without touching other project resources.

- [ ] **Step 1: Write failing path, revision and file contract tests**

Test absolute/UNC/drive paths, URL-encoded traversal, symlink escape, root rename/delete rejection, 20 MiB code and 50 MiB Markdown limits, binary/unsupported encoding, atomic save revision conflict, project lock rejection and CRUD response shape. Add capability tests for exact header/canonical request, wrong project, body hash, +/-60-second boundary, replayed 128-bit nonce and public-key-only agent. Add crash-window tests for atomic write before DB commit, receipt recovery, agent restart and mismatched receipt.

- [ ] **Step 2: Run focused tests to verify failure**

From `poc4/backend`, run `mvn -q -Dtest=WorkspacePathPolicyTest,WorkspaceControllerTest,WorkspaceResourceFactoryTest,ProjectRecoveryServiceTest test`; from the repository root, run `mvn -q -f poc4/workspace-agent/pom.xml test`.
Expected: FAIL because workspace boundary is absent.

- [ ] **Step 3: Implement workspace-agent and path policy**

Build the workspace-agent first. It accepts only project-relative file requests plus `X-Manao-Workspace-Capability`, verifies Ed25519 over the canonical method/path/query/body hash/project/timestamp/nonce input, enforces its injected project ID, +/-60-second clock skew and a 120-second bounded nonce cache. It rejects absolute/UNC/drive/`..` paths and symlink escapes, and uses temp file, `fsync`, atomic rename and an idempotent same-volume receipt keyed by operation ID. It never exposes Kubernetes metadata, maintains no authoritative revision, holds a signing private key or reads a ServiceAccount token.

- [ ] **Step 4: Implement backend workspace coordinator**

Create server-derived namespace resource names and labels. Create a per-project RWX PVC, then an initializer Pod that mounts the PVC root and creates the derived directory with fixed UID/GID/`fsGroup`; require its `Succeeded` state and a write/read permission probe before creating the workspace Pod with `subPath`. Create the ClusterIP Service, set `automountServiceAccountToken: false`, wait for readiness, call only the workspace-agent internal API, and roll back only resources carrying this request's identity. Add startup recovery for stale `CREATING` and `PENDING` workspace operations.

- [ ] **Step 5: Run tests with Fabric8 mock and filesystem fixtures**

Run `mvn -q -Dtest=*Workspace*,ProjectRecoveryServiceTest test` from `poc4/backend`, then run `mvn -q -f poc4/workspace-agent/pom.xml test` from the repository root. Expected: empty PVC bootstrap succeeds before any `subPath` mount, path/capability/resource tests pass, stale `CREATING` cleanup is label-scoped, workspace API never exposes Kubernetes identifiers, and every revision either commits once or blocks for explicit reconciliation.

- [ ] **Step 6: Commit**

```powershell
git add poc4/backend/src/main poc4/backend/src/test poc4/workspace-agent
git commit -m "feat(poc4): add isolated workspace file service"
```

## Task 5：实现 Run 状态机、Maven Job 协调和恢复扫描

**Files:**

- Create: `poc4/backend/src/main/java/com/manao/poc4/run/RunService.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/run/RunController.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/run/RunStateReducer.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobResourceFactory.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobCoordinator.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/ResourceIdentityVerifier.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/run/RunRecoveryService.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/run/RunStateReducerTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/run/RunControllerTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/JobResourceFactoryTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/run/RunRecoveryServiceTest.java`

**Interfaces:**

- Implements active/list/get/start/stop endpoints and exact Run DTO shape used by `poc4/frontend/src/contracts/run.ts`.
- `JobResourceFactory.create(run, project)` produces an application container whose PID 1 directly execs argument array `mvn clean test` from `/workspace`; the immutable image contains Java 17, Maven 3.9, Bash and the fixed root-owned wrapper. It sets `restartPolicy: Never`, `backoffLimit: 0`, 1800-second deadline, bounded resources, the already initialized `/workspace` PVC subPath and `/tmp` emptyDir.
- `ResourceIdentityVerifier.verify(run, job, pod, container)` requires DB reference, ownerReference, labels and fixed application container name/state to match.

- [ ] **Step 1: Write failing state, idempotency and manifest tests**

Cover dirty/PENDING revision rejection, duplicate Start, Stop idempotency, every locking/terminal state transition, affected-row zero refetch, exact PID 1 command array and fixed image contents, initialized subPath precondition, no browser policy fields, no K8s token in Job Pod, fencing-token loss and resource mismatch refusal.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `mvn -q -Dtest=RunStateReducerTest,RunControllerTest,JobResourceFactoryTest,RunRecoveryServiceTest test`.
Expected: FAIL because the Run and Job modules are absent.

- [ ] **Step 3: Implement state reducer and Job coordinator**

Create Run in `STARTING` only after owner/project/revision checks and after acquiring the current instance fencing token; persist policy snapshot before creating the Job; make Job creation idempotent by deterministic server-derived identity and database state; watch Job/Pod status; stop by server-owned Job reference; retain lock through `STOPPING` until Kubernetes confirms termination. PID 1 must be the fixed Maven command; interactive PTY later uses a separate `pods/exec` and cannot replace that process. On startup, only the fenced lease holder may mark unfinished Runs `RECOVERING`, scan by labels and settle or fail closed.

- [ ] **Step 4: Run tests and Fabric8 mock inspection**

Run focused tests and inspect serialized Job/Pod objects for forbidden user-provided fields. Also assert that a Job/PTY write cannot silently advance `workspace_revision`: compare only the editable source manifest (exclude `target/**` and declared temporary paths), and on a mismatch set `project.state=FAILED` and `failure_reason=WORKSPACE_RECONCILIATION_REQUIRED`, then keep the project locked until an explicit reload. Expected: all state and manifest assertions pass, duplicate Start never creates a second Job, and recovery never attaches a mismatched resource.

- [ ] **Step 5: Commit**

```powershell
git add poc4/backend/src/main poc4/backend/src/test
git commit -m "feat(poc4): coordinate constrained maven runs"
```

## Task 6：实现日志持久化窗口、ticket 和 replay/live WebSocket

**Files:**

- Create: `poc4/backend/src/main/java/com/manao/poc4/log/RunLogService.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/log/RunLogController.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/log/RunLogWebSocketHandler.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/log/LogTicketService.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/log/RunLogWindow.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/log/LogReplayCursor.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/log/RunLogWindowTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/log/LogTicketServiceTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/log/RunLogWebSocketTest.java`

**Interfaces:**

- Implements `POST /log-ticket` and same-origin `/api/v1/ws/run-logs?ticket=opaque-log-ticket` with replay from `lastSeq` then live stream.
- `RunLogWindow.append(seq, utf8Bytes)` persists before publish, evicts oldest chunks to <= 5 MiB and updates `evictedBytes`/`firstAvailableSeq`; `LogReplayCursor` emits one `LOG_GAP` marker when `lastSeq < firstAvailableSeq - 1`, resumes at `firstAvailableSeq`, and de-duplicates seq across reconnect/live overlap.
- Ticket consumption is atomic on hash, owner, project, run, expiry and `consumed_at IS NULL`.

- [ ] **Step 1: Write failing window/ticket/protocol tests**

Cover UTF-8 byte length, duplicate/乱序 seq, 5 MiB eviction, replay gaps and single `LOG_GAP` marker, reconnect overlap de-duplication, expired/reused/wrong-owner tickets, 401/403/404/503 mapping, heartbeat and close behavior, and no terminal frames on log socket.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `mvn -q -Dtest=RunLogWindowTest,LogTicketServiceTest,RunLogWebSocketTest test`.
Expected: FAIL because log persistence and handlers are absent.

- [ ] **Step 3: Implement persistence-first log pipeline**

Consume Fabric8 `watchLog()` output, assign monotonic sequence in the Run scope, persist chunk and window metadata transactionally, publish only after persistence succeeds, then serve replay/live. On disconnect, close the watch without unlocking Run. Keep log ticket and terminal ticket tables/handlers separate.

- [ ] **Step 4: Run 6 MiB local stream test**

Run focused tests plus a deterministic 6 MiB synthetic stream. Expected: retained bytes <= 5 MiB, latest marker appears once after reconnect, `evictedBytes` matches persisted metadata, and no terminal channel receives log frames.

- [ ] **Step 5: Commit**

```powershell
git add poc4/backend/src/main poc4/backend/src/test
git commit -m "feat(poc4): persist and stream run logs"
```

## Task 7：实现 Terminal session、Fabric8 exec PTY 和协议流控

**Files:**

- Create: `poc4/backend/src/main/java/com/manao/poc4/terminal/TerminalSessionService.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/terminal/TerminalWebSocketHandler.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/terminal/TerminalFlowController.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/terminal/PtyBridge.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/terminal/TerminalTicketService.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/ExecPtyClient.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/terminal/TerminalSessionServiceTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/terminal/TerminalWebSocketTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/terminal/TerminalFlowControllerTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/ExecPtyClientTest.java`

**Interfaces:**

- Implements `POST /terminal-sessions`, same-origin `/api/v1/ws/terminals?ticket=opaque-terminal-ticket`, and exact stage-five control/binary protocol.
- `TerminalSessionService.reserve(cols, rows, user, project, run)` creates one opaque reservation only for `READY` project and active `RUNNING` Run.
- `TerminalFlowController` enforces server output frames <= 32 KiB, initial 256 KiB credit, ACK after xterm write completion, input frames <= 16 KiB and bounded input queue.

- [ ] **Step 1: Write failing terminal/auth/flow tests**

Cover exact request fields `cols/rows`, dimension bounds, single-use ticket, one live session, owner/run checks, ready/session match, 4401/4409/4410 close codes, binary byte preservation, resize generation ordering, close, output credit/ack (duplicate/over-credit ACK), input pause/resume, 64 KiB queue overflow and 5-second fail-closed timeout, and no JWT in URL/frame/logs.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `mvn -q -Dtest=TerminalSessionServiceTest,TerminalWebSocketTest,TerminalFlowControllerTest,ExecPtyClientTest test`.
Expected: FAIL because the terminal bridge is absent.

- [ ] **Step 3: Implement ticket-to-exec bridge**

Atomically consume ticket, re-check Run/project/user state, verify Job ownerReference/labels/Pod/container identity, require `Running` application container, then create Fabric8 PTY exec. Bridge binary input/output and JSON control frames without mixing log/audit data. On close, Run state change, Pod exit or backend teardown, close exec and settle session/audit idempotently; never auto-reconnect.

- [ ] **Step 4: Run protocol and mock exec tests**

Run focused tests plus a generated 8 MiB frame stream. Expected: byte conservation, max outstanding <= 256 KiB, input queue overflow ends the session without unbounded growth, resize is deduplicated and old generations are ignored.

- [ ] **Step 5: Commit**

```powershell
git add poc4/backend/src/main poc4/backend/src/test
git commit -m "feat(poc4): bridge terminal sessions to kubernetes exec"
```

## Task 8：实现命令审计、定时清理和跨模块恢复/关闭语义

**Files:**

- Create: `poc4/backend/src/main/java/com/manao/poc4/audit/AuditIngressService.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/audit/AuditService.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/audit/AuditController.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/audit/RetentionCleanupJob.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/terminal/PtyWrapperCommand.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/lifecycle/BackendLifecycleCoordinator.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/audit/CommandRedactor.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/audit/AuditIngressServiceTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/audit/RetentionCleanupJobTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/lifecycle/BackendLifecycleCoordinatorTest.java`

**Interfaces:**

- Implements `GET /terminal-audits` cursor pagination and structured states `RUNNING/SUCCEEDED/FAILED/INTERRUPTED`.
- `AuditIngressService` consumes the wrapper's session-bound MACed FIFO through a separate non-PTY exec stream; it accepts only nonce-valid, monotonic, non-duplicate wrapper events and persists redacted command text plus `sensitiveDetected`. PTY output is never parsed by the browser or appended as audit. The wrapper is root-owned/0555; shell users may still alter command behavior, so evidence is limited to transport integrity, not malicious-code isolation.
- `BackendLifecycleCoordinator` orders cleanup: disable input -> close PTY -> settle audit/session -> preserve Run lock or reload dependency; every disposer is idempotent.

- [ ] **Step 1: Write failing audit/cleanup/recovery tests**

Cover shell integration events for backspace, completion, multiline, interactive program, Ctrl-C, shell exit and command exit; reject wrong nonce/MAC, duplicate/out-of-order event and fake command. Cover redaction of password/token/Authorization/env-assignment/URL-credential patterns, seven-day cleanup, `RESERVED -> EXPIRED` every 10 seconds, backend shutdown, MySQL/Kubernetes unavailable, SSH/bridge loss, `CREATING` reconciliation and Run end ordering.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `mvn -q -Dtest=AuditIngressServiceTest,RetentionCleanupJobTest,BackendLifecycleCoordinatorTest test`.
Expected: FAIL because audit and lifecycle modules are absent.

- [ ] **Step 3: Implement wrapper ingress and cleanup coordinator**

Start a fixed root-owned/0555 Bash wrapper and shell hook in the immutable Maven image. Send events through a random 0600 FIFO and consume them using a separate non-PTY `pods/exec cat` stream; validate session nonce/MAC/time/settlement before database write, redact sensitive command fields, and mark the transport trust level. Add scheduled deletion of expired log chunks, tickets and terminal audits plus `RESERVED -> EXPIRED` scanning every 10 seconds while preserving project files and recovery Run metadata. Keep Run authority separate from terminal close.

- [ ] **Step 4: Run cross-module lifecycle tests**

Run focused tests plus `mvn -q test`. Expected: all terminal close paths settle once, old PTY is never reusable, Run unlock waits for authoritative Job state, and cleanup never deletes active recovery metadata.

- [ ] **Step 5: Commit**

```powershell
git add poc4/backend/src/main poc4/backend/src/test
git commit -m "feat(poc4): add command audit and lifecycle cleanup"
```

## Task 9：实现 6A 本机集成 profile、SSH API tunnel 和 workspace bridge

**Files:**

- Create: `poc4/backend/src/main/java/com/manao/poc4/config/LocalClusterConfig.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/SshApiTunnelHealth.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspacePortForwardManager.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/KubeconfigTlsPreflight.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/WorkspacePortForwardManagerTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/SshApiTunnelHealthTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/KubeconfigTlsPreflightTest.java`
- Create: `poc4/backend/scripts/start-local-cluster.ps1`
- Create: `poc4/backend/scripts/stop-local-cluster.ps1`
- Create: `poc4/backend/config/local-cluster.example.env`
- Create: `poc4/frontend/.env.local-cluster.example`
- Modify: `poc4/frontend/vite.config.ts`
- Modify: `poc4/frontend/README.md`

**Interfaces:**

- 6A Vite proxy sends HTTP/WS to local Spring Boot only; local backend uses local MySQL.
- Fabric8 reads a temporary kubeconfig whose API `server` is the SSH-forwarded local endpoint and whose cluster entry explicitly sets `tls-server-name` to a SAN present in the remote API certificate; CA, client certificate/token and hostname verification remain enabled. Startup runs both `kubectl` and Fabric8 `/version` preflights plus every namespace `auth can-i`; no token or private key enters command arguments.
- `WorkspacePortForwardManager` accepts only server-derived namespace/service/service-port values, allocates a project-specific loopback port from a bounded range, keeps one process/refcount per project, binds loopback, monitors child exit, recreates the original mapping after dependency recovery and kills all children during backend shutdown.

- [ ] **Step 1: Write failing local-profile and process-lifecycle tests**

Cover profile startup without cluster Secret reads, rejected absolute/undeclared Service values, dynamic concurrent project port allocation, loopback-only port-forward command, child process exit detection/recreation, shutdown cleanup, TLS SAN mismatch and insecure-skip rejection, tunnel loss mapping to 503/RECOVERING, and Vite proxy preserving same-origin WebSocket paths.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `mvn -q -Dtest=WorkspacePortForwardManagerTest,SshApiTunnelHealthTest test` and `pnpm --dir poc4/frontend typecheck`.
Expected: FAIL because the local bridge and proxy profile are absent.

- [ ] **Step 3: Implement 6A profile and scripts**

Use untracked environment values for namespace, SSH local API port, TLS server name, API CA/auth material and the bounded workspace loopback port range. Do not use a global `MANAO_WORKSPACE_SERVICE` or fixed local workspace port: the backend derives each project Service and allocates its own loopback port. Start SSH separately under operator control for the API endpoint; backend runs the dual kubectl/Fabric8 TLS/RBAC preflight and manages one port-forward per project. Refuse `insecure-skip-tls-verify`, direct PVC access, browser-supplied Service names/ports and replacement ports.

- [ ] **Step 4: Run local integration smoke checks**

Run: `mvn -q -Dspring-boot.run.profiles=local-cluster spring-boot:run`, start local MySQL and the documented SSH API tunnel, then run `pnpm --dir poc4/frontend dev`. Verify login, project list, workspace tree and same-origin WS through `127.0.0.1:18080`; do not record credentials or cluster addresses.

- [ ] **Step 5: Commit**

```powershell
git add poc4/backend/src/main poc4/backend/src/test poc4/backend/scripts poc4/backend/config poc4/frontend/vite.config.ts poc4/frontend/README.md poc4/frontend/.env.local-cluster.example
git commit -m "feat(poc4): add local cluster integration profile"
```

## Task 9A：执行 6A 决策门并固定进入 6B 的构建基线

**Files:**

- Create: `poc4/docs/evidence/stage-6/6a-gate.md`
- Create: `poc4/docs/evidence/stage-6/6a-local-cluster-result.md`
- Create: `poc4/backend/src/test/java/com/manao/poc4/deploy/Stage6aPreflightTest.java`
- Create: `poc4/frontend/tests/e2e/stage6-real-backend.spec.ts`
- Modify: `poc4/frontend/playwright.config.ts`
- Modify: `poc4/frontend/package.json`
- Modify: `poc4/frontend/README.md`

**Interfaces:**

- Produces one explicit `PASS` or `FAILED` 6A gate. A `WAIVED_BY_USER` or `SKIPPED` item cannot satisfy the gate.
- Captures the exact backend Git SHA, Maven artifact checksum, migration version, sanitized profile name, Kubernetes API TLS SAN verification, namespace `auth can-i` results, dynamic project bridge mappings (hashed project IDs and ports only), and real Job/Pod/PVC/log/PTY outcomes.

- [ ] **Step 1: Run the 6A preflight before any 6B deployment work**

Verify SSH API tunnel reachability, remote certificate SAN against `tls-server-name`, CA/client auth, dual `kubectl`/Fabric8 `/version`, every namespace Role verb, RWX StorageClass/PVC capacity, workspace initializer permissions, image pullability and Maven dependency egress. Add `test:e2e:stage6` for the MSW-disabled 6A browser flow and run login, Alice/Bob owner isolation, project creation, revision/recovery, real Job/log/PTY/audit, dynamic bridge concurrency and cleanup. Record details in `6a-local-cluster-result.md` and summarize the blocking status in `6a-gate.md`.

- [ ] **Step 2: Record the gate and stop on non-PASS**

Write `poc4/docs/evidence/stage-6/6a-gate.md` with separate statuses. If any critical item is `FAILED` or `SKIPPED`, stop before creating any 6B Deployment/Secret/Role resources and record bounded remediation. Only a reproducible `PASS` permits Task 10.

- [ ] **Step 3: Commit the gate evidence**

```powershell
git add poc4/docs/evidence/stage-6/6a-gate.md poc4/docs/evidence/stage-6/6a-local-cluster-result.md poc4/backend/src/test/java/com/manao/poc4/deploy/Stage6aPreflightTest.java poc4/frontend/tests/e2e/stage6-real-backend.spec.ts poc4/frontend/package.json poc4/frontend/playwright.config.ts poc4/frontend/README.md
git commit -m "test(poc4): establish stage 6a decision gate"
```

## Task 10：实现 6B Kubernetes Deployment、RBAC、Secret、探针和镜像

**Files:**

- Create: `poc4/backend/Dockerfile`
- Create: `poc4/backend/deploy/namespace-role.yaml`
- Create: `poc4/backend/deploy/local-cluster-role.example.yaml`
- Create: `poc4/backend/deploy/service-account.yaml`
- Create: `poc4/backend/deploy/backend-deployment.yaml`
- Create: `poc4/backend/deploy/backend-service.yaml`
- Create: `poc4/backend/deploy/config.example.env`
- Create: `poc4/backend/deploy/test-operator-role.example.yaml`
- Create: `poc4/backend/src/test/java/com/manao/poc4/deploy/ManifestSecurityTest.java`
- Modify: `poc4/backend/pom.xml`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspaceResourceFactory.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/WorkspaceResourceFactoryTest.java`
- Create: `poc4/workspace-agent/.dockerignore`
- Modify: `poc4/workspace-agent/Dockerfile`
- Modify: `poc4/workspace-agent/deploy/workspace-agent.yaml`
- Modify: `poc4/workspace-agent/pom.xml`
- Create: `poc4/workspace-agent/src/test/java/com/manao/poc4/workspaceagent/WorkspaceAgentManifestTest.java`

**Interfaces:**

- Deployment uses `replicas: 1`, strategy `Recreate`, database instance lease/fencing, dedicated ServiceAccount, namespace Role/RoleBinding, ClusterIP Service, Secret-backed environment values, startup/liveness/readiness probes and no kubeconfig/PVC mount.
- The 6B Role includes only jobs, pods, services, PVCs, pods/log, pods/exec and events with the exact verbs from the design; it excludes `pods/portforward`. The separate `local-cluster-role.example.yaml` documents the equivalent 6A user Role with `pods/portforward` added only for the workspace bridge; `test-operator-role.example.yaml` is a separate test-only identity limited to named test Pod/Job operations and sanitized status reads. Neither backend/local Role grants secrets/nodes/PVs/cluster/other namespace access.
- Container runs non-root, no privilege escalation, drops all capabilities, RuntimeDefault seccomp, read-only root filesystem and writable `/tmp` emptyDir.
- The workspace-agent image is built and published separately from the backend, and every workspace Pod template references its immutable digest; the agent image also has a `.dockerignore`, non-root/read-only-rootfs policy, no ServiceAccount token and no Kubernetes client dependency.

- [ ] **Step 1: Write failing manifest/security tests**

Parse YAML and assert backend and workspace-agent Deployment/ServiceAccount/Role/Service fields, immutable digest requirements for both images, the workspace Pod factory's agent image digest, `Recreate` strategy, probes, resource bounds, no project PVC or kubeconfig mount in the backend, no default ServiceAccount, correct `automountServiceAccountToken` settings, forbidden RBAC resources absent, no `pods/portforward` in the 6B Role, and exactly one 6A-only `pods/portforward` rule in `local-cluster-role.example.yaml`. Verify RWX StorageClass/capacity and image pull secret as environment preconditions, not silently substituted.

- [ ] **Step 2: Run tests to verify failure**

From `poc4/backend`, run `mvn -q -Dtest=ManifestSecurityTest test`; from the repository root, run `mvn -q -f poc4/workspace-agent/pom.xml -Dtest=WorkspaceAgentManifestTest test`.
Expected: FAIL because deployment manifests, Dockerfiles and workspace-agent manifest tests are absent.

- [ ] **Step 3: Add hardened image and manifests**

Build the same backend application artifact used in 6A and build the workspace-agent artifact separately. Set fixed non-root UIDs, read-only roots, `/tmp` emptyDirs, probes on Actuator endpoints, Secret references without API read permission, and ClusterIP Services. Publish both images with immutable digests and use the workspace-agent digest in the workspace Pod factory; keep image tags/digests and namespace values supplied only by deployment environment.

Write `test-operator-role.example.yaml` as a namespaced Role bound only in the dedicated disposable Stage 6 test namespace, with `get/list/watch/delete` on `pods` and `get/list/watch` on `jobs`; because Kubernetes RBAC cannot restrict delete by label, the fault runner must refuse targets without the fixed `stage6-test=true` label and the namespace must contain no unrelated workloads. It must not grant `patch` on Deployment, access to Secrets, nodes, PVs, or any other namespace. MySQL network interruption is injected outside Kubernetes RBAC by the test operator's controlled process/firewall action and is recorded separately.

- [ ] **Step 4: Run manifest tests and image build**

Run `mvn -q -Dtest=ManifestSecurityTest test` from `poc4/backend`; from the repository root run `mvn -q -f poc4/workspace-agent/pom.xml -Dtest=WorkspaceAgentManifestTest test`; run `mvn -q package` in both Maven modules; then build both images with the repository-approved container builder. Before applying manifests, verify a bound RWX StorageClass, aggregate namespace quota for at least three project PVCs plus one Job/initializer per project, `fsGroup` write access across at least two schedulable nodes, image registry pull credentials, Bash/Maven availability in the immutable image, and Maven dependency egress or an approved internal mirror. Expected: all security assertions pass and both images have reproducible digests referenced by the manifests and workspace Pod template. Any missing prerequisite is `SKIPPED`/`FAILED`, never silently substituted with hostPath, root, floating tags or disabled TLS.

- [ ] **Step 5: Commit**

```powershell
git add poc4/backend/Dockerfile poc4/backend/deploy poc4/backend/pom.xml poc4/backend/src/test poc4/workspace-agent/.dockerignore poc4/workspace-agent/Dockerfile poc4/workspace-agent/deploy poc4/workspace-agent/pom.xml poc4/workspace-agent/src/test
git commit -m "feat(poc4): package backend for kubernetes"
```

## Task 11：执行 6B 集群 E2E、故障/压力测试并形成证据

**Files:**

- Create: `poc4/frontend/tests/e2e/stage6-terminal-stress.spec.ts`
- Create: `poc4/frontend/tests/e2e/stage6-faults.spec.ts`
- Create: `poc4/frontend/.env.cluster.example`
- Modify: `poc4/frontend/playwright.config.ts`
- Modify: `poc4/frontend/package.json`
- Modify: `poc4/frontend/README.md`
- Create: `poc4/docs/evidence/stage-6/6b-cluster-pod-result.md`

**Interfaces:**

- Task 11 consumes the committed Task 9A `6a-gate.md`; if it is absent or not `PASS`, Task 11 must stop without deploying 6B.
- 6B evidence must identify same backend SHA/image digest, cluster MySQL, Deployment Pod, ServiceAccount/RBAC/probes and backend Service port-forward.
- Playwright runs with MSW disabled; all evidence redacts credentials, ticket/session values, resource names, absolute paths and cluster endpoints.
- Fault injection uses the separate test-only `stage6-operator` identity bound only in the disposable test namespace; it may `get/list/watch/delete` Pods and `get/list/watch` Jobs there, while the runner refuses any target without `stage6-test=true`. It may toggle the test MySQL network outside Kubernetes RBAC and read sanitized resource status. The backend ServiceAccount, 6A kubeconfig identity, Alice and Bob must fail these operations.

- [ ] **Step 1: Write E2E assertions and evidence schema**

Add package scripts `test:e2e:stage6`, `test:e2e:stage6:channels`, `test:e2e:stage6:stress` and `test:e2e:stage6:faults`; each runs only the named Stage 6 specs with MSW disabled and an externally supplied backend profile. Define JSON/Markdown evidence fields for profile, Git SHA, image digest, migration, command, HTTP/WS result, resource snapshot hash, metrics, screenshots, and status. Add assertions for login, owner isolation, project/PVC files, revision/lock, Job/log replay/live/stop/timeout, terminal PTY/resize/credit/ack/close, audit, restart, reconnect, `CREATING` recovery, `RESERVED -> EXPIRED`, dynamic per-project bridge mappings, and no-secret leakage.

- [ ] **Step 2: Verify the immutable 6A gate and deploy 6B**

Verify `6a-gate.md` is `PASS` and that its Git SHA/artifact checksum match the build being packaged. Deploy 6B only after that check, use the backend Service loopback `kubectl port-forward`, and record mismatch/failure as `FAILED` or `SKIPPED`; never recompute or overwrite the 6A gate inside Task 11.

- [ ] **Step 3: Fix implementation issues using focused tests**

Correct only contract, state, security or operational defects demonstrated by evidence. Never weaken owner checks, RBAC, resource limits, TLS validation, ticket binding, output credit or cleanup ordering to make E2E pass.

- [ ] **Step 4: Run 6B pressure and fault matrix after the 6A gate**

After the recorded 6A `PASS`, run the 6B deployment and at least 8 MiB PTY output in <=32 KiB frames, 256 KiB output credit, <=16 KiB input frames, <=64 KiB input queue, 100+ resize events, backend Pod restart, MySQL short outage, backend-Service port-forward loss, Job Pod recreation and cross-node scheduling. Keep 6A-only faults (local backend restart, SSH tunnel loss and workspace bridge loss) in the 6A evidence. Capture byte conservation, max outstanding, input queue, resize generation count, dynamic bridge process cleanup, disconnect time and responsiveness for each profile.

- [ ] **Step 5: Commit evidence**

```powershell
git add poc4/frontend/tests poc4/frontend/package.json poc4/frontend/playwright.config.ts poc4/frontend/README.md poc4/frontend/.env.cluster.example poc4/docs/evidence/stage-6
git commit -m "test(poc4): verify real backend profiles"
```

## Task 12：阶段六最终验证、报告和退出决策

**Files:**

- Create: `poc4/docs/evidence/stage-6/final-result.md`
- Modify: `poc4/frontend/README.md`
- Modify: `poc4/backend/README.md`

- [ ] **Step 1: Run complete local test matrix**

From `poc4/backend`: `mvn -q test`, `mvn -q verify`, `mvn -q package`. From `poc4/workspace-agent`: `mvn -q test`, `mvn -q package`. From `poc4/frontend`: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e:stage6`, `pnpm test:e2e:stage6:channels`, `pnpm test:e2e:stage6:stress` and `pnpm test:e2e:stage6:faults`. Run `git diff --check` and strict UTF-8/BOM/CR scan.

- [ ] **Step 2: Reconcile every stage-six exit gate**

For each of the 12 design gates, record separate 6A and 6B statuses. Confirm 6A local migration/SSH/workspace lifecycle evidence and 6B Deployment/ServiceAccount/Secret/probe/RBAC/Pod restart evidence are both present. Preserve `WAIVED_BY_USER`, `SKIPPED`, `FAILED` distinctly.

- [ ] **Step 3: Scan boundary and secret leakage**

Scan browser-visible output (HTTP/WS responses, DOM and screenshots), backend/frontend logs and evidence metadata for JWTs, passwords, tokens, ticket/session raw values, PVC/Pod/Job names, absolute paths, kubeconfig, SSH private key, `insecure-skip-tls-verify`, mock worker and stage-five mock-only endpoints. Scan manifests and source separately for secret material, kubeconfig/private-key content and forbidden TLS settings; explicitly marked evidence attachments may contain脱敏 Kubernetes resource snapshots, but must not contain credentials or unredacted endpoints. Any finding blocks completion.

- [ ] **Step 4: Make the decision**

Write exactly one outcome:

```text
READY_FOR_STAGE_7_PLAN
```

only when all 6A and 6B gates pass with reproducible evidence. Otherwise write:

```text
STAGE_6_REMEDIATION_REQUIRED
```

and list each failed/skipped gate and the next bounded remediation; do not start Stage 7 planning.

- [ ] **Step 5: Commit final report**

```powershell
git add poc4/docs/evidence/stage-6 poc4/frontend/README.md poc4/backend/README.md
git commit -m "docs(poc4): record stage 6 real backend result"
```

## 验证矩阵

| 层 | 必须证据 |
|---|---|
| 后端构建 | Java 17、Spring Boot、可重复 Maven package、镜像 digest |
| 配置 | `local-cluster`/`cluster` profile、外部 Secret、Actuator liveness/readiness |
| 认证 | JWT 签名/过期、owner 隔离、401/403/404、错误脱敏 |
| 数据库 | Flyway 空库升级、事务、版本条件更新、ticket 单次消费、7 日清理 |
| workspace | Pod/Service/PVC、路径/symlink、原子写、revision、20/50 MiB |
| Run/Job | 单活动 Run、固定命令/资源、Stop/timeout、恢复和最终一致 |
| 日志 | 先持久化、5 MiB、seq/replay/live、断线和后端重启 |
| Terminal | ticket、真实应用容器 exec、二进制、resize、credit/ack、关闭销毁 |
| Audit | wrapper 来源、命令边界、退出归因、分页、settlement、清理 |
| 6A | 本机后端/MySQL、SSH API tunnel、workspace bridge、退出清理 |
| 6B | Deployment 单 Pod、RBAC、Secret、探针、Service、Pod 重启 |
| 真实 E2E | MSW 关闭、浏览器流程、Alice/Bob、断线、重启、资源身份 |
| 压力/故障 | 8 MiB、帧/credit/input/resize 上限、短断、Pod 重建、跨节点 |
| 证据卫生 | SHA、migration、digest、脱敏快照、HTTP/WS、截图、状态分类 |

## 回滚边界

- Task 1-3 失败：保留阶段五前端，后端目录回退到未接入状态；不改浏览器合同。
- Task 4 失败：停止 workspace 资源创建；不放宽路径、owner 或内部 capability 检查。
- Task 5-6 失败：拒绝新 Run/ticket，保留现场用于诊断；不把数据库状态强行改为终态。
- Task 7-8 失败：关闭 exec、settle audit/session、保持 Run 锁；不自动重连旧 PTY。
- Task 9 失败：只保留本机 profile 修复；不提前部署 6B，也不将 6A 称为阶段完成。
- Task 10-11 失败：停止集群放量，保留 MySQL/PVC/Job；必要时 `kubectl rollout undo`，不删除恢复证据。
- Task 12 发现证据缺失：结论只能是 `SKIPPED` 或 `STAGE_6_REMEDIATION_REQUIRED`。
- 同一问题最多进行四轮有证据修复；重复失败后停止扩展范围并记录阻塞原因。

## 执行前置条件

1. 当前 `master` 已包含阶段五完成基线和阶段六设计提交 `0df5144`。
2. 本计划提交到 `master` 并由用户确认。
3. 实施时从阶段五基线创建隔离工作树，例如 `.worktree/ensoai-stage-6-real-backend`，不得直接在 `master` 编码。
4. 6A 真实联调所需 SSH 隧道、受控 kubeconfig、等价 namespace Role 和本机 MySQL 由操作者在仓库外提供；workspace Service/PVC/Pod 由后端按固定模板创建和管理，计划不替用户猜测地址、端口或凭据。
5. 6B 使用与 6A 相同的后端构建产物；集群 Secret、MySQL Service、namespace 和镜像 digest 只在受控环境注入。
6. 阶段六执行期间不修改或提交 `.grok/`，不把真实集群资源名写入源代码、前端 bundle、截图或报告。
7. 执行顺序固定为 Task 1-9 -> Task 9A 6A 决策门 -> Task 10-12；没有 6A `PASS` 证据不能创建或部署任何 6B Deployment/Secret/Role 资源。
8. 集群前置条件必须在 Task 9A 记录：目标 namespace 已存在且配额允许至少三个项目 PVC、initializer/workspace Pod 和一个 Maven Job；存在并已验证 `ReadWriteMany` StorageClass；至少两个可调度节点能以固定 UID/GID/`fsGroup` 读写同一 PVC；workspace-agent、backend 和 Maven 镜像可由受控 registry 以 immutable digest 拉取；Maven 镜像包含 Java 17、Maven 3.9、Bash、固定 wrapper，且依赖可访问或已配置批准的内部镜像；MySQL 实例可从空库运行 Flyway；故障测试操作者身份和临时 Role 已由集群管理员单独提供。
9. 任何前置条件无法验证都必须写为 `SKIPPED` 或 `FAILED`，并阻断对应阶段；不得用 hostPath、root、浮动 tag、关闭 TLS、管理员 kubeconfig 或后端扩大 RBAC 绕过。
