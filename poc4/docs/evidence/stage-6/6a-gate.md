# 阶段六 6A 决策门（6A Gate）— 修复轮 + 真实集群联调轮

- 日期：2026-09-02（本日联调；证据更新 2026-09-04 = 第二轮）
- 分支：codex/poc4-stage-6-real-backend-kubernetes
- 后端 Git SHA：26331be5b57f9683401b26edbb2ec5f825293d5f（后端代码 SHA；最终 HEAD 见 git log，含第一轮修复 + 第二轮探针/bridge/覆盖修复）
- 修复轮测试基线：backend 全量 221/0/0（1 skipped = real-mode 守卫，2026-09-04 第二轮复测）；workspace-agent 23/0/0、frontend pnpm test 1124/1124（第一轮基线，本轮未复测）；frontend typecheck 0（2026-09-04 第二轮复测）
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

> 本证据文档所属提交为最终 HEAD（见 git log），不在上列三个代码提交之内。

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
  [stage6] › stage6-faults.spec.ts:99:1 › channel disconnect fails closed then reconnects
  [stage6] › stage6-faults.spec.ts:158:1 › parallel projects keep isolated dynamic bridges
  [stage6] › stage6-faults.spec.ts:204:1 › fault phases: backend restart / tunnel loss / bridge loss
  [stage6] › stage6-terminal-stress.spec.ts:113:1 › PTY 8 MiB output in <=32 KiB frames conserves 256 KiB credit
  [stage6] › stage6-terminal-stress.spec.ts:309:1 › run log live then full replay matches byte conservation
  Total: 5 tests in 2 files
```

### 后端全量测试（本轮复测）

`mvn -B test`：221 tests, 0 failures, 0 errors, 1 skipped（skipped = real-mode 守卫
`Stage6aPreflightTest.realClusterPreflightRunsOnlyWhenEnabled`）。`pnpm typecheck`：0 错误。

## 三、6A 真实集群联调结果（本日实测）

> 本节为 2026-09-02 本日实测的旧记录，**待外部复跑刷新**；第二轮代码修复已提交（见第二节），
> 复跑步骤不变，未产生新的外部复跑结果。

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

## 四、模板写入失败的根因（环境性阻断，非代码逻辑）

本沙箱（DSH）对后台作业的进程树施加两类限制：
1. 后台作业中的 JVM 无法再创建新的监听 socket（后端 Tomcat 启动期绑定 18080 成功；运行期 Fabric8 LocalPortForward 声称 alive 但 18100 从未出现在 netstat）；
2. 后台作业中的 JVM 派生子进程（kubectl port-forward）静默死亡；
3. 操作者侧（captain pwsh）独立 bridge 监督进程同样被沙箱终止（exit 0xFFFFFFFF）。

由此 workspace 模板写入的 transport 在沙箱内无法建立，project 置 FAILED/WORKSPACE_RECONCILIATION_REQUIRED（fail-closed 行为本身正确）。
已为沙箱外环境交付两种可用 bridge 实现：Fabric8 进程内 port-forward（默认，绑定 127.0.0.1）与 MANAO_BRIDGE_MODE=supervised 确定性端口模式（供操作者在沙箱外运行监督进程）。

第二轮代码修复已提交（见第二节），复跑步骤不变；本节所述沙箱限制为环境性阻断，仍需沙箱外复跑验证。

## 五、结论

**GATE = FAILED（环境阻断）— 未进入 6B。**

- 代码修复全部完成并有真实证据（见第一节与提交历史）；第二轮修复（探针/bridge/覆盖）已提交（见第二节）。
- 沙箱外环境复跑步骤：设置 6A 环境变量（见 backend/config/local-cluster.example.env + MANAO_K8S_MASTER_URL）→ 启动后端 → `STAGE6_GATE=1 pnpm --dir poc4/frontend test:e2e:stage6`。
- 已知修复顺带产出：真实启动 Bean 接线修复（ActuatorConfig/WebSocketConfig/条件注解/双构造器/重复 Bean）、网关按授权动词合规（create/get + list-then-delete）、E2E spec 携带 Bearer token 与英文 UI 选择器、Vite 需绑定 127.0.0.1（--host 127.0.0.1）。
