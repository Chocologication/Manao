> **历史来源 / 2026-09-17 已被现行记录取代：** 当前 6A 范围、验收决定和证据以[唯一现行事实现状](../../../../docs/Stage6A-Current-Facts.md)为准。下文保留原时点的设计、计划和结果；其中“当前”、待实施、FAILED/不允许 6B 等只描述旧时点，不覆盖本次用户验收决定，也不自动授权重新执行。原始结果不改写。此链接指向主检出的单份文档，不复制第二份现状。

# 阶段六 6A 决策门（6A Gate）— 修复轮 + 真实集群联调轮

## 当前摘要（2026-09-10；优先于下方历史轮次）

- 当前代码基线 `c974630b2aa34f442deef72206259113460aed09`。用户报告重启集群后在沙箱外基础 real-backend E2E **5/5 PASS**；18:32:06 +08:00 的 `.last-run.json` 为 passed/无失败 ID，但不含用例数量、耗时和 Run 终态。
- **完整 GATE = FAILED（关键验收未闭环），6B 未开始。** 五项不等于完整 Gate：Run 断言允许任一终态；日志/PTY/audit、8 MiB 压力和三阶段故障矩阵未形成完整通过证据。
- kubectl 默认 bridge、模板写入、数据库测试隔离、文件创建 201、Job selector 和正常路径测试清理已经落地。当前节点全部 Ready，但历史失败项目的 initializer/PVC/DB 仍残留；异常清理源码缺陷尚未修复。
- 当前状况、优先级与保留证据以 [2026-09-10 状态与下一步](2026-09-10-status-and-next-steps.md) 和 [只读快照](2026-09-10-readonly-snapshot.json) 为准。下方“当前/本轮/尚未修复”等措辞均保留为对应日期的历史结论，不覆盖本摘要。

## 历史基线与历次记录（截至 2026-09-08）

- 日期：2026-09-02（历史联调）；证据更新 2026-09-04（第三轮 P0/P1 修复提交后的新鲜审查）
- 分支：codex/poc4-stage-6-real-backend-kubernetes
- 代码审查基线 HEAD：`052870bab80abd984f0478362060e04ac61d04bb`（第三轮 P0/P1 生产接线修复提交；本文为随后整理更新）
- 第二轮最后一个后端代码提交：`26331be5b57f9683401b26edbb2ec5f825293d5f`（stress 输入帧去死锁）。其后还有 `6475d88`、`1280571` 文档/收尾提交。三者不得混写为同一个 SHA。
- 本轮可复核测试（2026-09-04，HEAD `052870b`）：backend `mvn -B test` **234 tests, 0 failures, 0 errors, 1 skipped**（skipped = `Stage6aPreflightTest.realClusterPreflightRunsOnlyWhenEnabled`）；workspace-agent `mvn -B test` **23 tests, 0 failures, 0 errors**；frontend `pnpm test` **1124 tests, 0 failures**；`pnpm typecheck` 通过；Playwright `--list` **10 个用例 / 3 个 spec**；`git diff --check` 通过。
- Flyway 迁移基线：V1–V7
- 集群：3 节点 Kubernetes v1.31.13；namespace manao-stage6-test；受限 kubeconfig：D:\DeepLearning\MyProjects\Project_Manao_kubeconfig\stage6-6a-kubeconfig（SA manao-6a-local，Role manao-stage6-backend）

## 一、修复轮闭环（计划 Task 1–13）

| 包 | 内容 | 结论 |
|---|---|---|
| A | 真实 MySQL 测试底座 + fencing 续租 | PASS（全量 194/0/0 时点） |
| B | pod_ref 落库 + PTY 真实 Pod 名/握手核验 + 日志 watch 接入 | PASS |
| C | 日志 UTF-8 字节切分 + initializer fail-closed | PASS |
| D | preflight fail-closed + E2E 去 skip + shutdown 生命周期 | PASS（D1 合同缺陷经 d27fd03 修复后复评通过） |
| E | 恢复身份核验/保留 PVC + maven-runner 材料 + audit 真库测试 | PASS |

## 二、第二轮修复（2026-09-03/04，外部复跑前）

复跑审查确认四项阻断（workspace-agent 探针冷启动误杀、bridge 无真实监听验证、证据 SHA 过期、
真实 E2E 覆盖不足），本轮为三处代码/测试提交 + 本证据文档提交。三个代码提交完整 SHA：

- R2-1 探针 startupProbe：`65b411bb1b6fbb7b194e68867afd0a634bc208b4`
- R2-2 bridge 监听语义：`293d0c08eab0215f90506ee65937808b9231d2cb`、`42c466bc7788b6be2e84aeec5a729d86ac887f57`
- R2-3 stress/faults spec：`bfb0d55c43fba258305cf5a156b7dd111affa683`、`5ba34433ac6dce468a5e1fffcf2180e036427eb2`、`26331be5b57f9683401b26edbb2ec5f825293d5f`

> 本证据文档随第三轮修复后的整理提交更新；上列 SHA 仅用于区分第二轮代码历史，不代表当前 Gate 已通过。

### 探针 startupProbe（R2-1）

workspace Pod 补写 startupProbe 条款，避免 JVM 冷启动被 liveness 误杀。设计 §8.1 新增条款：
HTTP GET `/agent/v1/healthz`（8080），initialDelaySeconds 5、periodSeconds 5、failureThreshold 24、
timeoutSeconds 2；liveness/readiness 在 startupProbe 成功后才开始判定；liveness 只判断进程不可恢复
失活，readiness 反映 HTTP 服务可用。落点：`WorkspaceResourceFactory` 的 workspace Pod 模板 +
`poc4/workspace-agent/deploy/workspace-agent.yaml`；回归测试
`WorkspaceResourceFactoryTest.workspacePodProbesSurviveJavaColdStart` 断言三探针数值。

### bridge 监听语义（R2-2）

`WorkspacePortForwardManager.PortForwardProcess` 新增 `isListening()`：在进程句柄 alive 之外，
对 loopback 端口做 TCP connect 探活（250ms 超时），区分「句柄仍报 alive」与「转发端口真的在监听」。
`allocate`/`checkChildren` 在 `!isAlive() || !isListening()` 时先 kill 旧句柄再于原端口重建；
supervised 模式（factory==null）改为从真实监听状态上报存活，不再假设常活。回归测试
`WorkspacePortForwardManagerTest` 新增三例：alive-but-non-listening 重建、listener 丢失后 allocate
重建、supervised 确定性端口单桥存活。

### 两个新 E2E spec（R2-3）

新增 `poc4/frontend/tests/e2e/stage6-faults.spec.ts`（通道断开 fail-closed 后重连 / 并行项目隔离
动态桥 / backend 重启-tunnel 丢失-bridge 丢失三阶段故障）与
`poc4/frontend/tests/e2e/stage6-terminal-stress.spec.ts`（8 MiB 输出 ≤32 KiB 帧的 256 KiB credit 守恒 /
日志 live+全量回放字节守恒）；操作者注入型故障经 `STAGE6_FAULT` 环境变量分阶段门控（未设置→skip）。
`--list` 验证：

```text
$ pnpm exec playwright test tests/e2e/stage6-terminal-stress.spec.ts tests/e2e/stage6-faults.spec.ts --project=stage6 --list
  [stage6] › stage6-faults.spec.ts:100:1 › channel disconnect fails closed then reconnects
  [stage6] › stage6-faults.spec.ts:159:1 › parallel projects keep isolated dynamic bridges
  [stage6] › stage6-faults.spec.ts:205:1 › fault phases: backend restart / tunnel loss / bridge loss
  [stage6] › stage6-real-backend.spec.ts:67:1 › login and Alice/Bob owner isolation on the real backend
  [stage6] › stage6-real-backend.spec.ts:86:1 › project creation reaches READY with template files through the real workspace
  [stage6] › stage6-real-backend.spec.ts:99:1 › file save advances the workspace revision and rejects stale revisions
  [stage6] › stage6-real-backend.spec.ts:127:1 › start run produces a policy-constrained run that progresses on the real cluster
  [stage6] › stage6-real-backend.spec.ts:153:1 › error responses never leak cluster identifiers
  [stage6] › stage6-terminal-stress.spec.ts:113:1 › PTY 8 MiB output in <=32 KiB frames conserves 256 KiB credit
  [stage6] › stage6-terminal-stress.spec.ts:311:1 › run log live then full replay matches byte conservation
  Total: 10 tests in 3 files
```

### 后端全量测试（第三轮新鲜复测）

第二轮文档曾写 `221`；独立执行记录出现过 `222/0/0/1`。当前 HEAD 的新鲜复测为 **234/0/0/1**，workspace-agent 为 **23/0/0**。

## 三、6A 真实集群联调结果（历史记录，待刷新）

> 本节是 2026-09-02 的历史前置记录；下方第四节和第五节补充了 2026-09-04
> 新鲜审查中实际复现的接线与环境阻断。真实集群 happy-path、压力和故障矩阵仍未形成 PASS 证据。

| # | 前置/门项 | 状态 | 证据 |
|---|---|---|---|
| 1 | SSH API 隧道可达 | PASS | kubectl /version v1.31 |
| 2 | 证书 SAN/CA/客户端认证 | PASS | tls-server-name=localhost 生效 |
| 3 | 真模式 preflight（26 项 can-i + 双 /version） | PASS | Stage6aPreflightTest 4/4 exit 0（受限 kubeconfig） |
| 4 | RWX StorageClass/PVC | PASS | nfs-storage，PVC Bound（10Gi RWX） |
| 5 | workspace-agent / maven-runner 镜像 immutable digest | PASS | 已推 Docker Hub：agent bb0dd430...，runner 6c93d34b... |
| 6 | 真实项目创建（PVC/initializer/workspace Pod/Service） | PASS | 集群实测 PVC Bound + Pod 1/1 Running + Service |
| 7 | workspace 模板写入（经 6A bridge） | FAILED（环境） | 见第四节 |
| 8 | 浏览器 E2E（owner 隔离/文件/日志/PTY/audit） | FAILED（环境） | 见第四节 |

## 四、2026-09-04 新鲜审查阻断

### 4.1 本机后端端口接线缺口（代码/脚本）

仓库启动脚本和 Vite 代理约定后端为 `127.0.0.1:18080`，但 `application.yml` 未设置
`server.port`。按启动脚本实际执行时，Spring Boot 监听 `8080`，导致浏览器通过 Vite
代理访问 `/api/v1/projects` 收到 `ECONNREFUSED 127.0.0.1:18080`，5 个 real-backend
用例全部在可达性守卫处失败。审查中仅用临时 `--server.port=18080` 验证后续链路，
未修改配置，故该缺口仍待修复。

### 4.2 共享测试数据库达到项目上限（环境/数据）

临时将后端监听到 18080 后，真实浏览器成功登录并进入 `/projects`；安全脱敏用例通过，
其余 4 个项目用例在 `POST /api/v1/projects` 收到固定 `409 PROJECT_LIMIT_REACHED`。
MySQL `manao_poc4.project` 显示 Alice、Bob 各有 3 条历史
`FAILED/WORKSPACE_RECONCILIATION_REQUIRED` 项目；服务端按总行数执行每用户 3 项上限，
失败项目保留用于诊断且继续占额。审查未删除或清空这些记录。

### 4.3 沙箱 bridge 限制（环境性阻断，非代码逻辑）

本沙箱（DSH）对后台作业的进程树施加两类限制：
1. 后台作业中的 JVM 无法再创建新的监听 socket（后端 Tomcat 启动期绑定 18080 成功；运行期 Fabric8 LocalPortForward 声称 alive 但 18100 从未出现在 netstat）；
2. 后台作业中的 JVM 派生子进程（kubectl port-forward）静默死亡；
3. 操作者侧（captain pwsh）独立 bridge 监督进程同样被沙箱终止（exit 0xFFFFFFFF）。

由此 workspace 模板写入的 transport 在沙箱内无法建立，project 置 FAILED/WORKSPACE_RECONCILIATION_REQUIRED（fail-closed 行为本身正确）。
已为沙箱外环境交付两种可用 bridge 实现：Fabric8 进程内 port-forward（默认，绑定 127.0.0.1）与 MANAO_BRIDGE_MODE=supervised 确定性端口模式（供操作者在沙箱外运行监督进程）。

第二轮代码修复已提交（见第二节），复跑步骤不变；本节所述沙箱限制为环境性阻断，仍需沙箱外复跑验证。

## 五、第三轮 P0/P1 代码修复（2026-09-04，已提交，无真实 E2E）

审查认定第二轮“全部修复完成”不成立：live `log.complete` 未接线、bridge 未等监听、PTY 在 WS 线程上阻塞写入等会阻断真实联调。本轮修复这些代码缺口并补回归测试，提交为当前 HEAD `052870b`；仍**没有**浏览器/集群 E2E 证据，因此不能把本节写成 Gate PASS。

| 项 | 落点 | 本轮证据 |
|---|---|---|
| live `log.complete` | `RunObservationService` 终态 settle 后 `RunLogIngestor.finish` 再 `RunLogWebSocketHandler.publishComplete` | `RunLogWebSocketTest.liveSubscriberReceivesCompleteAfterTheLastPersistedChunk`；`RunObservationServiceTest.terminalSettlementFinishesTheLogWatchAfterTheLastPersist` |
| bridge listener-ready + 端口占用/冲突 | `allocate`/`checkChildren` 等待 `isListening()`；`findFreePort` 检查 OS bind；supervised 线性探测避免 hash 碰撞 | `WorkspacePortForwardManagerTest` 新增 5 例（含 kill-then-start 事件序） |
| PTY 非阻塞 drain | `ExecPtyClient` 独立 writer 线程 + `onWritable`；handler 不再同步 `OutputStream.write` | `ExecPtyClientTest.writeDoesNotBlockTheCallerWhenStdinIsBackpressured`；`TerminalWebSocketTest.pausedInputResumesWhenThePtyBecomesWritable` |
| WS 严格白名单 | `StrictWsFrame`；terminal/log 未知字段与非整数 bytes/`lastSeq` 拒绝 | `RunLogWebSocketTest.subscribeRejectsUnknownFieldsAndNonIntegerLastSeq`；`TerminalWebSocketTest.controlFramesRejectUnknownFieldsAndNonIntegerBytes` |
| workspace 专用 SA | factory `serviceAccountName=manao-workspace-agent` + `stage6-test=true` | `WorkspaceResourceFactoryTest`；Job 标签同步 |
| 单调 resize generation | 连接内 `AtomicLong`，不用墙钟毫秒 | `TerminalWebSocketTest.resizeGenerationIsMonotonicAndDimensionsAreValidated` |
| 故障 spec | READY 前置、固定 `INTERNAL_ERROR` 文案、operator 证据（身份/时间/targetHash/result） | `stage6-faults.spec.ts` + `stage6-operator.ts`；注入脚本 `poc4/backend/scripts/inject-stage6-fault.ps1` |
| 压力 spec | 不再把 pause/resume 当成所有正常 PTY 的必然条件；pause 一旦出现必须 resume | `stage6-terminal-stress.spec.ts` |

集群前置：namespace 必须已有 `manao-workspace-agent` ServiceAccount（参考 `poc4/workspace-agent/deploy/workspace-agent.yaml`），否则带专用 SA 的 workspace Pod 会无法调度。

## 六、当前审查发现（尚未修复）

以下问题是在当前 HEAD 的真实启动/浏览器复跑中发现的，不能用单元测试结果覆盖：

| 优先级 | 问题 | 证据/影响 |
|---|---|---|
| P0 | 6A 后端端口未接线 | 启动脚本和 Vite 代理使用 `127.0.0.1:18080`，但 Spring Boot 默认监听 `8080`；未额外传入 `--server.port=18080` 时，5 个 real-backend 用例均在可达性守卫失败。 |
| P1 | supervised bridge 未检查真实 OS 端口占用 | `findUniqueSupervisedPort()` 只检查内部 bridge 映射，外部进程已占用候选端口时仍可能返回该端口；现有回归只覆盖 Fabric8 `findFreePort()` 的 bind 检查。 |
| P1 | 未知 terminal 控制帧的错误响应不完整 | `TerminalWebSocketHandler` 的 default 分支发送 `{type: terminal.error}`，缺少前端合同要求的 `code` 与 `retryable:false`；现有测试只断言关闭码，未断言该帧可被严格解析。 |

这些问题应在下一轮修复中分别增加失败回归测试，并在真实浏览器/集群复跑后刷新本 Gate。

## 七、本轮修复与真实联调记录（2026-09-05）

本轮在同一 Stage 6 工作树补齐了上一轮审查发现的三个代码缺口，并先以回归测试锁定：

- `application-local-cluster.yml` 明确配置 `server.port: 18080`，使启动脚本、Vite proxy 与 Spring Boot 使用同一入口；
- supervised bridge 的确定性端口选择同时检查内部映射和真实 loopback OS bind 可用性；
- 未知 terminal 控制帧返回完整的 `terminal.error`：`code=PROTOCOL_ERROR`、`retryable=false`，随后按协议关闭。

测试先行结果：目标回归组 `ConfigurationTest,WorkspacePortForwardManagerTest,TerminalWebSocketTest` 为 **41 tests, 0 failures, 0 errors, 0 skipped**。

真实启动结果：使用仓库外的临时 6A 环境文件启动后，日志确认 MySQL 连接成功、Flyway 7 个迁移已验证且 schema 为最新、Spring Boot 监听 `127.0.0.1:18080`。首次启动因临时 kubeconfig 中 ServiceAccount token 过期/无效而由 fail-closed preflight 退出；随后以管理员 kubeconfig 为 `manao-6a-local` 重新签发 24 小时 token，独立验证 `kubectl version` 为集群 `v1.31.13` 且 `auth can-i get pods` 为 `yes`。

刷新 token 后重新启动，Spring Boot 在 `18080` 保持运行，说明本地启动时的 kubeconfig 结构、kubectl `/version`、Fabric8 `/version` 与 26 项 RBAC preflight 已越过启动门；本轮仍未重新执行完整浏览器 E2E，因此项目创建、RWX workspace、日志和 PTY 全链路没有形成 PASS 证据。该剩余状态记为 **SKIPPED/FAILED（浏览器/集群证据未闭环）**，不能据此宣称 6A Gate PASS。

## 七、结论

**GATE = FAILED — 未进入 6B。**

失败原因同时包括：（1）本轮仍无沙箱外真实 6A happy-path / 压力 / 三阶段故障的浏览器+集群证据；（2）在本轮代码落地之前，生产接线缺口本身就会阻断联调。本节**不**声称“代码修复全部完成并有真实证据”。

本轮可复核的是静态/单元/集成测试，不是 6A Gate PASS：

- backend：234 tests, 0 failures, 0 errors, 1 skipped（2026-09-04 基于上述代码审查基线执行 `mvn -B test`）。
- workspace-agent：23 tests, 0 failures, 0 errors；frontend：`pnpm test` 1124 tests, 0 failures；`pnpm typecheck` 通过；`--list` 发现 10 个 stage6 用例 / 3 个 spec。
- `git diff --check`：无 whitespace 错误。
- 真实浏览器：登录与项目列表可用；因 18080 接线缺口首次 5/5 在可达性守卫失败；临时指定 18080 后，1/5 通过，4/5 因共享数据库 Alice/Bob 各达到 3 项历史失败项目上限而返回 `409 PROJECT_LIMIT_REACHED`。
- 真实集群 happy-path、压力和三阶段故障：仍未形成 PASS，记 `SKIPPED/FAILED`，不得进入 6B。

沙箱外复跑（PowerShell）：

```powershell
$env:STAGE6_GATE = '1'
pnpm --dir poc4/frontend test:e2e:stage6
pnpm --dir poc4/frontend test:e2e:stage6:stress
$env:STAGE6_FAULT = 'backend-restart'   # 或 tunnel-loss / bridge-loss
$env:STAGE6_OPERATOR_ID = 'stage6-operator'
$env:STAGE6_FAULT_EVIDENCE = '<evidence.json>'
# bridge-loss 可另设 STAGE6_OPERATOR_KUBECONFIG；restart/tunnel 设对应 CMD
pnpm --dir poc4/frontend test:e2e:stage6:faults
```

不要写 `STAGE6_GATE=1 pnpm ...`：那不是可靠的 PowerShell 环境变量语法。

## 八、本轮修复与本地合同验证（2026-09-08）

本轮针对上一轮真实 provisioning 在 workspace-agent 首条模板 operation 失败且原始错误不可见的问题完成了代码修复。修复内容包括：

- 修正 workspace-agent HTTP 合同：POST 使用 `application/json`，rename 发送 `nextPath`，DELETE 使用 `/agent/v1/entries` 路径，receipt 校验使用 agent 返回的已持久化 receipt 摘要；
- 将空 workspace 模板初始化改为父目录先行，并对每个模板文件执行 `CREATE` 后再执行包含 UTF-8 内容的 `SAVE`；
- fail-closed 日志增加脱敏的 `phase`、HTTP 状态和固定 allowlist 错误码，不记录 agent 原始消息、路径、文件内容、capability 或凭据；
- 修正 supervised bridge：外部操作者已占用的确定性端口可被复用；仅由 JVM 托管的 bridge 继续检查真实 OS 端口占用，并补充后端重启复用测试。

本轮新鲜验证结果：

- backend 全量 Maven：`248 tests, 0 failures, 0 errors, 1 skipped`，使用随机 disposable MySQL schema，测试结束后已删除；
- workspace-agent 全量 Maven：`24 tests, 0 failures, 0 errors`；
- frontend：`pnpm test` 为 `1124 tests passed`，`pnpm typecheck` 通过；
- 独立真实 HTTP/filter/controller/filesystem 合同检查通过：模板 21 次提交操作、5 个非空 UTF-8 文件、rename/delete、receipt reconciliation、未签名请求 401、错误 receipt fail-closed；
- `git diff --check` 通过，新增和修改文件已检查为 UTF-8 无 BOM。

仍未形成 6A PASS：当前只读 Stage 6 kubeconfig 在 2026-09-08 的预检返回 `Unauthorized`，因此没有启动前后端或执行真实浏览器/Kubernetes happy path、压力和故障矩阵。6A 继续记为 **FAILED**，6B 不得开始。
## 九、测试数据清理与项目上限调整（2026-09-08）

用户再次运行真实浏览器测试后仍报告 4 failed / 1 passed，随后明确要求先清理残留测试条目，再将每用户项目上限从 3 调整为 8。本轮按该范围执行，未将额度调整视为 provisioning 根因修复。

### 数据清理

- 已核对 `manao_poc4`：Alice 有 3 个 `stage6-*` FAILED 项目，每个项目有 1 条 workspace operation；Bob 无项目；这些项目没有 Run、terminal session、audit 或 log ticket 记录。
- 使用固定的 3 个 project ID，并校验 owner、名称前缀、FAILED 状态及关联记录数量；事务内删除 3 个项目和 3 条 operation，前后核验其他项目及账号未变化。
- 删除前备份保存在本机被 Git 忽略的 `poc4/backend/target/cleanup-backups/stage6-residue-20260908-160248.json`。没有提交备份或凭据。
- 清理后 Alice/Bob 的项目数均为 0；原有 `null-receipt` 诊断项目和所有账号保留。未修改集群资源。

### 上限合同

- 后端 `ProjectLimits.MAX_PROJECTS_PER_OWNER = 8`，API 返回值、业务服务和 JDBC repository 共用该限制；原有 owner 行锁及事务不变。
- 前端使用 API 返回的数值上限，默认值与 mock 统一为 8；更新缓存、页面测试及 Stage 1 mock E2E 用例。
- 保留原有计数规则：CREATING、READY、FAILED 均计入项目总数；第 9 个项目返回 409 / PROJECT_LIMIT_REACHED。
- 本轮不调整 Kubernetes ResourceQuota，不证明集群具备同时承载 8 个项目的容量。

### 新鲜验证与生效条件

- 新增测试先在旧值下失败，随后在随机隔离 MySQL schema 验证第 8 个可创建、第 9 个被拒绝、所有状态计数、owner 隔离及并发最后名额。
- 后端全量：251 tests、0 failures、0 errors、1 skipped；随机测试 schema 已清理。
- 前端全量：61 files / 1125 tests passed；`pnpm typecheck` 通过。
- 没有重新运行真实浏览器 / Kubernetes E2E，也没有重启或中断用户正在运行的前后端。后端需要重启后才能加载新的上限；前端需要刷新以获取新的列表额度。
- **6A 仍为 FAILED；本轮不能证明此前 4 个浏览器失败用例已修复，不进入 6B。**
