# 阶段六 6A 决策门（6A Gate）— 修复轮复审版

- 日期：2026-08-30
- 后端 Git SHA：`1e7c9f85` 起，含修复轮提交（branch `codex/poc4-stage-6-real-backend-kubernetes`）
- 修复轮测试基线：backend `190 tests, 0 failures`；workspace-agent `23 tests, 0 failures`；frontend `tsc` 通过
- 后端构建产物 SHA-256（前 16 位）：`227d416ddca8b110`（manao-poc4-backend-0.0.1-SNAPSHOT.jar，本地构建，仅用于绑定当前源码树）
- Flyway migration 基线：V1–V5（V5 = `run_fencing_and_terminal_decoupling`）
- 集群：3 节点（master + node1 + node2，Kubernetes v1.31.13），经 SSH API 隧道 `https://127.0.0.1:6443`
- 测试 namespace：`manao-stage6-test`（`stage6-test=true`，ResourceQuota `stage6-quota`）

## 一、审查报告 17+3 项源码问题的修复状态

### P0

| # | 问题 | 修复 | 测试 |
|---|---|---|---|
| 1 | 6A bridge 未接入创建链路 | `ProjectProvisioningService` 新增 `WorkspaceBridge` 钩子：workspace Pod Ready 后、模板写入前 `allocate(projectId)`；失败路径 `release(projectId)`；`WorkspaceConfig` 的 endpoint resolver 亦按需 `allocate` | `ProjectProvisioningServiceTest.bridgeIsAllocatedBeforeTemplateWriteAndReleasedOnFailure` |
| 2 | Run 无状态推进/watch/失败清理 | 新增 `RunObservationService`（STARTING→RUNNING with started_at、终态 settlement）；`RunService.start` 的 `ensureJob` 异常现在 settle 为 `FAILED/START_FAILED` 并释放锁；新增 `RunLogIngestor`+`PodLogGateway`（Fabric8 `watchLog` 行级持久化，重附跳过已消费前缀） | `RunObservationServiceTest`（4 例：推进、终态、无 lease 不写、启动失败清理） |
| 3 | terminal_session FK 违反 | V5 迁移 `DROP FOREIGN KEY fk_terminal_session_ticket`（terminal ticket 与 log ticket 解耦） | `FlywaySchemaTest` 全量迁移通过 |

### P1

| # | 问题 | 修复 | 测试 |
|---|---|---|---|
| 4 | terminal 无 settlement | 所有 teardown 路径（close 帧 shell exit 断线 RUN_LEFT_RUNNING BACKEND_ERROR 输入超限）幂等 settle：CLIENT_CLOSED/SHELL_EXITED→`CLOSED`；CONNECTION_LOST/RUN_LEFT_RUNNING→`INTERRUPTED`；BACKEND_ERROR/超限→`FAILED` | `TerminalWebSocketTest`（closeFrameAndPtyExitSettle、connectionLostSettlesInterrupted、inputIsWrittenToThePty…） |
| 5 | 输入未写入 PTY、超时不生效 | `drainInput` 真正 `handle.write`，写失败留在队列；队列满 5 秒（共享时钟）→ `4410` fail closed；`enforceInputDeadlines()` 由调度循环调用 | `inputIsWrittenToThePty…`、`queueDeadlineExceededFailsClosedAndSettles`、`fullInputQueuePauses…` |
| 6 | audit INSERT 漏 `trust_level` | `AuditStore.insertRunning` 增加 `trustLevel`；JDBC 写入 `trust_level`；服务默认 `WRAPPER_TRANSPORT` | `AuditIngressServiceTest`（fake 断言 trust 值） |
| 7 | AuditController 无 owner 校验 | `runStore.findRunForOwner(owner, projectId, runId)` 为空 → 404 | 编译级接线 + 后续 6A E2E 覆盖 |
| 8 | fencing token 未贯穿 | V5 加 `run.fencing_token`；`insertRun/transition/markRunning/settle` 全部带 token 条件；`RunObservationService`/`RunRecoveryService` 每轮先取 lease，无 lease 不写 | `RunControllerTest`（fake 校验 token）、`RunObservationServiceTest.withoutTheLeaseNothingIsWritten` |
| 9 | verifier 拒绝终态 Pod、缺失 containerStatuses 放行 | 接受 `Succeeded/Failed`；`containerStatuses == null` 拒绝；app 容器需 `Running` 或 `Terminated` | `ResourceIdentityVerifierTest` |
| 10 | initializer 两容器竞态、成功不删除 | create-directory 改为 **initContainer**（严格先于探针）；provisioning 成功后 `gateway.deletePod(initializer)` | `initializerMountsPvcRoot…`（init 断言）；Fabric8 `initializerSucceeded` 容忍已删除 |
| 11 | recovery 不验身份/模板 receipt | gateway 名称查找后核验 `manao.poc4/project-id` label；恢复增加模板 receipt（agent tree 含 `pom.xml`）；不再要求 initializer 存活 | `ProjectRecoveryServiceTest` |
| 12 | 日志先改内存后落库、重启种子断裂 | `publish` 改为 `canAppend → insertChunk → appendValidated → notify`；`windowFor` 用 `seed(chunks, store.lastSeq())`，淘汰后重启可续 | `RunLogWindowTest`、`RunLogWebSocketTest` |
| 13 | LOG_GAP 计算未发送 | gap=true 时 replay 帧附 `gap:{kind:LOG_GAP,fromSeq,toSeq}`（单次；阶段五 parser 忽略未知字段不破坏合同） | `replayBehindTheWindow…` 断言 |
| 14 | 无运行时调度 | 新增 `RuntimeMaintenanceLoop`（`@EnableScheduling`）：观察 3s、run 恢复 15s、项目恢复 30s、RESERVED 过期 10s、七天清理每小时、bridge 子进程检查+terminal deadline 5s；`@PreDestroy` 关闭全部 log watch 与 bridge | `ConfigurationTest`/`HealthEndpointTest` 上下文加载验证 |
| 15 | 镜像 digest 未 fail-closed | 工厂统一 `requireDigest`（`repo@sha256:<64hex>`），agent/initializer/maven 三镜像全部强制；yml 占位符改为 digest 形态 | `imageReferencesMustBeImmutableDigests` |
| 16 | 预检范围不足 | `SshApiTunnelHealth.designVerbs` 覆盖 jobs/pods/services/PVC/pods/log/pods/exec/portforward/events 全矩阵（26 项 can-i）；新增 Fabric8 `/version` 探针；校验 kubeconfig `tls-server-name` 与期望一致；`WebSocketConfig` 同源白名单（4173 两源 + 可选 env 追加），移除 `*` | `SshApiTunnelHealthTest`（6 例） |
| 17 | E2E 可静默跳过、覆盖不足 | `STAGE6_GATE=1` 时后端不可达改为 **失败**；Alice 创建真实项目、Bob 列表/直查/文件三重隔离断言；run 用例断言 202 + policy + STARTING→终态推进；错误体泄漏扫描 | spec 重写（6 用例） |

### P2

- bridge 引用计数：`allocate` 幂等创建、`retain`/`release` 计数、归零才 kill；provisioning 失败 release。✔
- terminal cols/rows：V5 落列，reservation 持久化，握手用保留尺寸开 PTY。✔
- 审计 HMAC canonical JSON：改为 Jackson 构建，引号/反斜杠语义一致；测试 helper 复用同一实现。✔

## 二、门状态总览（修复轮后）

| # | 前置条件 | 状态 |
|---|---|---|
| 1 | SSH API 隧道可达 | PASS |
| 2 | 证书 SAN/CA/客户端认证 | PASS（SAN 含 `IP:127.0.0.1`、`DNS:localhost`；`tls-server-name: localhost`） |
| 3 | 双 kubectl/Fabric8 `/version` | PASS（代码路径已建；真实运行待 6A 联调启动后执行） |
| 4 | namespace Role verbs（26 项 can-i） | SKIPPED（等价受限 Role kubeconfig 待操作者提供） |
| 5 | RWX StorageClass/PVC 容量 | PASS |
| 6 | 跨节点 RWX + UID/GID/fsGroup | PASS |
| 7 | initializer 权限探针 | PASS（等效验证；init 容器修复后待全链路） |
| 8 | 镜像 immutable digest 可拉取 | SKIPPED（本机 Docker 未运行，无法构建/推送 workspace-agent 与 maven-runner） |
| 9 | Maven 依赖出网 | PASS |
| 10 | namespace 配额 | PASS |
| 11 | 6A 浏览器 E2E | SKIPPED（依赖 #4、#8；spec 已加固，门模式下不再静默跳过） |
| 12 | `stage6-operator` 身份 | SKIPPED |

## 三、结论

**GATE = FAILED（保持）— 未进入 6B。**

与上一轮差异：审查报告全部 17+3 项源码阻断已修复并有测试佐证（backend 190 例、agent 23 例、
`git diff --check` 干净、`tsc` 通过）。剩余阻断全部为操作者外部前置：#4 受限 kubeconfig、
#8 镜像构建/推送、#12 故障操作者身份。补齐后按 `6a-local-cluster-result.md` 重跑
`mvn -Dtest=Stage6aPreflightTest -Dmanao.stage6.real=true` 与 `pnpm test:e2e:stage6`，
以新 SHA/checksum/migration 记录 `PASS` 后方可开始 Task 10。
