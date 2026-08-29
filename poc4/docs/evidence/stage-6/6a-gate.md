# 阶段六 6A 决策门（6A Gate）

- 日期：2026-08-29
- 后端 Git SHA：`ce550660e90fe2f432aae9bc8509b232afd2e792`（branch `codex/poc4-stage-6-real-backend-kubernetes`）
- 集群：3 节点（master + node1 + node2，Kubernetes v1.31.13，KubeSphere 环境），经 SSH API 隧道 `https://127.0.0.1:6443` 访问
- 测试 namespace：`manao-stage6-test`（标签 `stage6-test=true`，已绑定 ResourceQuota `stage6-quota`：6 PVC / 60Gi / 12 pods）

## 门状态总览

| # | 前置条件 | 状态 | 证据 |
|---|---|---|---|
| 1 | SSH API 隧道可达 | PASS | `kubectl version` 经 127.0.0.1:6443 成功；测试 namespace/PVC/Pod 创建均走该端点 |
| 2 | 远端证书 SAN / CA / 客户端认证 | PASS | API 证书 SAN 含 `IP:127.0.0.1`、`DNS:localhost`、`DNS:master` 等；kubeconfig 含 `certificate-authority-data` 且无 `insecure-skip-tls-verify`；`tls-server-name: localhost` 可用 |
| 3 | 双 `kubectl` / Fabric8 `/version` 预检 | SKIPPED | kubectl 侧已验证；Fabric8 `/version` 需本机后端以 `local-cluster` profile 启动（依赖镜像前置） |
| 4 | namespace Role verbs（auth can-i） | SKIPPED | 当前操作者 kubeconfig 为集群管理员（超出设计 Role）；等价 namespace Role 绑定的受限 kubeconfig 尚未由操作者提供 |
| 5 | RWX StorageClass / PVC 容量 | PASS | `nfs-storage`（k8s-sigs.io/nfs-subdir-external-provisioner）；RWX 10Gi PVC `rwx-verify` Bound |
| 6 | 跨节点 RWX + 固定 UID/GID/fsGroup | PASS | node1 写入 `probe.txt`（root），node2 以 `runAsUser/fsGroup=10001` 成功读取并创建 `probe2.txt`（属主 10001:10001） |
| 7 | initializer/workspace Pod 权限探针 | PASS（等效验证） | 上述跨节点探针等价于 initializer 的写/读权限探针；完整 initializer Pod 流程依赖镜像与后端联调 |
| 8 | 镜像可由受控 registry 以 immutable digest 拉取 | SKIPPED | 集群可从公网 registry 拉取（busybox:1.36 / eclipse-temurin:17-jre / maven:3.9-eclipse-temurin-17 均 Pulled）；本机 Docker daemon 未运行，workspace-agent 与 maven-runner（含 root-owned wrapper）镜像无法构建/推送 |
| 9 | Maven 依赖出网 | PASS | 集群内 `maven:3.9-eclipse-temurin-17` 运行 `mvn -q dependency:get -Dartifact=junit:junit:4.13.2` → `EXIT=0` |
| 10 | namespace 配额 | PASS | `stage6-quota`（pods=12, pvc=6, requests.storage=60Gi）已创建并生效 |
| 11 | 6A 浏览器 E2E（登录/隔离/项目/文件/Job/日志/PTY/audit） | SKIPPED | 依赖镜像前置（#8）与后端真实启动（#3、#4） |
| 12 | 故障测试操作者身份 `stage6-operator` | SKIPPED | 尚未由集群管理员单独提供 |

## 结论

**GATE = FAILED（阻断项存在，未达可重复 PASS）**

按实施计划 Task 9A Step 2：存在 SKIPPED 的关键项（镜像发布 #8、受限 namespace Role #4、
Fabric8 双预检 #3、6A 浏览器 E2E #11、stage6-operator #12），不得开始任何 6B
Deployment/Secret/Role 工作；Task 10-12 保持阻塞。

### 有界修复清单（解除阻断所需）

1. **镜像发布（#8）**：操作者启动本机 Docker daemon 或提供受控 registry 凭据；
   构建 `manao/maven-runner`（FROM maven:3.9-eclipse-temurin-17 + root-owned
   `/usr/local/bin/manao-pty-wrapper` + shell hook）与 `manao/workspace-agent`，
   以 immutable digest 推送，并设置 `MANAO_MAVEN_RUNNER_IMAGE`。
2. **受限身份（#4）**：在 `manao-stage6-test`（生产则为 `manao`）namespace 创建等价
   namespace Role/RoleBinding（jobs/pods/services/pvcs/pods-log/pods-exec + 仅 6A 的
   pods/portforward），绑定独立用户，生成受限 kubeconfig（保留 CA 校验 +
   `tls-server-name: localhost`）。
3. **双预检与 E2E（#3、#11）**：以受限 kubeconfig + 环境变量启动本机后端
   （`backend/scripts/start-local-cluster.ps1`），运行 `mvn -Dtest=Stage6aPreflightTest
   -Dmanao.stage6.real=true` 与 `pnpm test:e2e:stage6`（STAGE6_GATE=1）。
4. **stage6-operator（#12）**：集群管理员在一次性 namespace 内提供仅限
   `get/list/watch/delete` pods 与 `get/list/watch` jobs 的测试身份。

上述四项完成后，重跑本门并刷新 `6a-local-cluster-result.md`。证据原始快照
（kubectl 输出、RWX 探针、Maven 出网探针）见 `6a-local-cluster-result.md`；
测试资源保留于 `manao-stage6-test`（标签 `stage6-test=true`），证据采集完成后销毁。
