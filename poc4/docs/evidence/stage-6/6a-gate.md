# 阶段六 6A 决策门（6A Gate）— 修复轮 + 真实集群联调轮

- 日期：2026-09-02（本日联调）
- 分支：codex/poc4-stage-6-real-backend-kubernetes
- 后端 Git SHA：96810d2（HEAD，含全部修复轮提交）
- 修复轮测试基线：backend 全量 217/0/0（1 skipped = real-mode 守卫）；workspace-agent 23/0/0；frontend pnpm test 1124/1124、typecheck 0
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

## 二、6A 真实集群联调结果（本日实测）

| # | 前置/门项 | 状态 | 证据 |
|---|---|---|---|
| 1 | SSH API 隧道可达 | PASS | kubectl /version v1.31 |
| 2 | 证书 SAN/CA/客户端认证 | PASS | tls-server-name=localhost 生效 |
| 3 | 真模式 preflight（26 项 can-i + 双 /version） | PASS | Stage6aPreflightTest 4/4 exit 0（受限 kubeconfig） |
| 4 | RWX StorageClass/PVC | PASS | nfs-storage，PVC Bound（10Gi RWX） |
| 5 | workspace-agent / maven-runner 镜像 immutable digest | PASS | 已推 Docker Hub：agent bb0dd430...，runner 6c93d34b... |
| 6 | 真实项目创建（PVC/initializer/workspace Pod/Service） | PASS | 集群实测 PVC Bound + Pod 1/1 Running + Service |
| 7 | workspace 模板写入（经 6A bridge） | FAILED（环境） | 见第三节 |
| 8 | 浏览器 E2E（owner 隔离/文件/日志/PTY/audit） | FAILED（环境） | 见第三节 |

## 三、模板写入失败的根因（环境性阻断，非代码逻辑）

本沙箱（DSH）对后台作业的进程树施加两类限制：
1. 后台作业中的 JVM 无法再创建新的监听 socket（后端 Tomcat 启动期绑定 18080 成功；运行期 Fabric8 LocalPortForward 声称 alive 但 18100 从未出现在 netstat）；
2. 后台作业中的 JVM 派生子进程（kubectl port-forward）静默死亡；
3. 操作者侧（captain pwsh）独立 bridge 监督进程同样被沙箱终止（exit 0xFFFFFFFF）。

由此 workspace 模板写入的 transport 在沙箱内无法建立，project 置 FAILED/WORKSPACE_RECONCILIATION_REQUIRED（fail-closed 行为本身正确）。
已为沙箱外环境交付两种可用 bridge 实现：Fabric8 进程内 port-forward（默认，绑定 127.0.0.1）与 MANAO_BRIDGE_MODE=supervised 确定性端口模式（供操作者在沙箱外运行监督进程）。

## 四、结论

**GATE = FAILED（环境阻断）— 未进入 6B。**

- 代码修复全部完成并有真实证据（见第一节与提交历史）。
- 沙箱外环境复跑步骤：设置 6A 环境变量（见 backend/config/local-cluster.example.env + MANAO_K8S_MASTER_URL）→ 启动后端 → `STAGE6_GATE=1 pnpm --dir poc4/frontend test:e2e:stage6`。
- 已知修复顺带产出：真实启动 Bean 接线修复（ActuatorConfig/WebSocketConfig/条件注解/双构造器/重复 Bean）、网关按授权动词合规（create/get + list-then-delete）、E2E spec 携带 Bearer token 与英文 UI 选择器、Vite 需绑定 127.0.0.1（--host 127.0.0.1）。
