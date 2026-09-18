# Stage 6B 验收记录（acceptance.md）

本文件是 Stage 6B「单用户工作台迁云」的唯一阶段验收记录。环境检查部分由 Task 1 填写；后续任务在同一文件追加各自验收结果。

- 记录时间：2026-09-18 13:48 (+08:00)
- 记录者：Task 1（只读环境核实），全部结论来自本轮实测命令输出
- 分支：`codex/poc4-stage-6b`，HEAD `0a7d8635bb0b1f83903c7ba1efb15ddf8bcede94`
- 工作树：`D:/DeepLearning/MyProjects/Project_Manao/.worktree/poc4-stage-6b`
- 工作树状态：无 tracked diff；唯一未跟踪文件为计划文档 `docs/superpowers/plans/2026-09-18-stage6b-cloud-workbench-implementation-plan.md`
- 凭据边界：kubeconfig 与 env 文件位于私有目录 `D:/DeepLearning/MyProjects/Project_Manao_kubeconfig/`，本文件只记录非敏感连接参数，不记录密码、token、证书内容。

## 1. 环境检查（Task 1，2026-09-18）

### 1.1 分支与构建基线 — 实测可用

- `git log -1`：HEAD `0a7d8635`（`docs(AGENTS.md): 更新项目文档结构和内容`），分支 `codex/poc4-stage-6b`。
- AGENTS.md（工作区级）与 `docs/Stage6A-Current-Facts.md`（2026-09-18 版，6A PASS 依据用户 09-17 全生命周期确认）已读取，作为本阶段输入。
- 注意：6A 现行事实指出 6A 交付为「HEAD + 未跟踪文件」基线；本 6B 工作树当前无未跟踪的源码文件（仅计划文档），干净程度优于 6A 交接时点。

### 1.2 集群版本与可达性 — 实测可用（但当前转发已断开，见缺口）

- kubectl 客户端 v1.34.1（`/d/Docker/DockerDesktop/resources/bin/kubectl`）。
- 本轮会话前段 `kubectl version` 返回 **Server Version: v1.31.13**（客户端 1.34 与服务端 1.31 超出 ±1 支持偏斜，kubectl 自身有告警；属已知事实，非本次失败）。
- kubeconfig（stage6-6a-kubeconfig）server 为 `https://127.0.0.1:6443`，context `stage6-6a`，`tls-server-name: localhost`，身份为 `system:serviceaccount:manao-stage6-test:manao-6a-local`。
- 本机无任何进程监听 6443（netstat 实测），API 可达依赖某个外部建立的本地转发/隧道。

### 1.3 当前身份 RBAC 边界 — 实测可用（`kubectl auth can-i --list`）

- 允许（namespace manao-stage6-test 内）：pods get/list/watch/create/delete、pods/exec create、pods/portforward create、pods/log get、services get/list/create/delete、persistentvolumeclaims get/list/create/delete、jobs.batch 全权、events get/list/watch、calico networkpolicies 全权。
- 允许（cluster scope 只读）：persistentvolumes list、storageclasses get、非资源 URL（/version、/healthz 等）。
- 不允许：nodes list、namespaces list、resourcequotas list。

### 1.4 namespace 与既有资源 — 实测可用（在 API 可达窗口内）

- namespace `manao-stage6-test` 存在且可读；既有 4 个 workspace Pod（Running）、1 个 initializer Pod（Completed）、4 个旧 run Pod（Error，41h/17h 前）、4 个 workspace Service（ClusterIP 8080/TCP）、10 个 manao-pvc-* PVC（全部 Bound，10Gi，RWX，nfs-storage）。
- 集群存在非 Manao 负载（kubesphere-*、xuexi 等 namespace 的 PV），确认这是共享集群，容量判断需预留余量。
- 资源配额（resourcequota）：本身份 Forbidden，**UNVERIFIED**；修复动作：由有权限身份（运维）确认 namespace 配额是否存在及其值，或沿用 6A 已验证的「8 项目上限」运行事实。
- 节点数：list nodes Forbidden。运行 Pod 实际调度到 node1 与 node2（`get pods -o wide`），证明至少 2 个可调度节点；「3 节点」旧线索 **UNVERIFIED**。修复动作：用管理员身份执行 `kubectl get nodes -o wide`。

### 1.5 可调度资源容量 — 部分实测，部分 UNVERIFIED

- Metrics API 不可用（`kubectl top` 失败），无法实测节点负载。
- 容量事实：既有 Manao 负载为 2 个 Running workspace + 若干历史 Job；6A 期间同规模负载可完成真实闭环（RETAINED_RUNTIME 依据，非本轮实测）。
- 控制面（backend Deployment）、initializer、workspace、Job 同.namespace 并存的容量 **UNVERIFIED**（需节点可分配资源清单）。修复动作：管理员身份 `kubectl describe node node1 node2`（allocatable/allocated resources）。

### 1.6 StorageClass 与 PV 策略 — 实测可用

| StorageClass | provisioner | reclaimPolicy | 参数 |
| --- | --- | --- | --- |
| `nfs-storage` | k8s-sigs.io/nfs-subdir-external-provisioner | Delete | `archiveOnDelete: "true"` |
| `manao-poc4-delete` | k8s-sigs.io/nfs-subdir-external-provisioner | Delete | `archiveOnDelete: "false"`, `onDelete: "delete"` |

- 两个候选 StorageClass 均实测存在；`manao-poc4-delete` 的 onDelete=delete + reclaimPolicy=Delete 与 6A 记录一致，是 6B 项目存储的现行候选。
- 当前 namespace 内 10 个 PVC 全部使用 `nfs-storage`（含 6A 旧样例数据；本任务未迁移、未删除，符合只读约束）。
- `manao-poc4-delete` 当前无绑定 PVC（本轮清单内未见），尚无实际 provisioning 运行记录（本轮）。

### 1.7 镜像拉取路径与候选镜像 digest — 实测可用（集群内已验证）

运行中 Pod 的实际镜像（`kubectl get pods -o jsonpath`）与 env 声明逐字一致：

| 用途 | 镜像（digest 固定） | 实测证据 |
| --- | --- | --- |
| Maven runner（Job） | `chocologic/manao_images_repository@sha256:6c93d34b317a98736d553d6891626471ff02578317c7358fbc140cb5ac957f0c` | 4 个历史 run Pod 均用此镜像；34 分钟前事件显示「Container image … already present on machine」，Job completed |
| workspace agent | `chocologic/manao_images_repository@sha256:bb0dd43023e02ec50738c76656f9319d8949ef5911a8f8bf668d4bb007ae920c` | 2 个 Running workspace Pod 均用此镜像 |
| initializer | `busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662` | Completed initializer Pod 用此镜像 |

- 结论：集群节点能从默认 registry 路径拉取以上镜像（当前状态为已缓存；`chocologic/manao_images_repository` 为既有拉取路径）。
- 端口占用：workspace Service 统一 8080/TCP；代码端口预算为 agent 18100–18199 + 容器 8080（BackendProperties）。NodePort 候选端口尚未实测占用情况（见 1.9）。

### 1.8 runner 镜像 Java/Maven 版本 — 存在已声明的差异，实际内容 UNVERIFIED

- 源码事实：`poc4/maven-runner/Dockerfile` 基镜像为 `maven:3.9.9-eclipse-temurin-17`；`BackendProperties.FIXED_MAVEN_VERSION` 与 `application.yml` 均为 `3.9.11`。
- 实际镜像内容（digest 6c93d34b… 内的 Maven 版本）本轮未能检查：Docker daemon 关闭（`docker version` 实测连接失败），且集群内未创建任何临时容器（只读约束）。
- 修复动作（Task 2/3 执行其一）：启动 Docker Desktop 后 `docker pull` 同 digest 并 `mvn -version`；或部署后在 Job 内读取 `mvn -version` 实测。若确为 3.9.9，需决策「对齐代码策略升 3.9.11」或「修订策略值」，只修确有差异。
- Java 版本：Dockerfile 声明 temurin-17（build 与 runtime 均为 17 系），与代码策略 Java 17 一致；实际镜像内 Java 版本同上 UNVERIFIED。

### 1.9 Maven 出网 — UNVERIFIED（有保留证据）

- 只读约束下本轮未创建任何测试 Job/Pod，无法实测实时出网。
- 保留证据（本轮从集群现存对象读取，RETAINED_RUNTIME）：历史 run Pod 日志显示 exec-maven-plugin 3.6.4 被解析并执行（报错为 mainClass 参数问题，属业务模板问题而非依赖下载失败）；另一 Job 在 34 分钟前 completed。
- 修复动作：Task 2/3 首次真实 Run 即为实测点；如需提前验证，用一次性 Job 访问 `https://repo.maven.apache.org` 并记录结果。

### 1.10 公网入口路径与 PUBLIC_ORIGIN — UNVERIFIED

- 本轮未在私有配置（env/kubeconfig/笔记）中找到服务器公网 IP 记录；SSH config 无可用条目；未发现存活的隧道进程。
- kubeconfig server 指向 `127.0.0.1:6443`，意味着管理面依赖本地转发；前端 Service 的公网直达路径不存在现成证据。
- 结论：**无可复用公网入口的实测证据**。修复动作（按序）：
  1. 向运维/既有隧道配置获取服务器公网 IP，实测 `curl http://<IP>:<port>` 能否直达前端 Service（优先复用现有入口）；
  2. 若无直达路径，采用 NodePort：由管理员核实候选端口（避开 1.7 已见占用）未占用且防火墙放行，实测公网可达；
  3. `PUBLIC_ORIGIN`（完整协议+IP+端口）在上述实测通过后填入本节，本轮不预填。
- HTTP 用于首轮连通性验证；HTTPS 复用已有入口，不为此安装整套 Ingress 平台（协议限制按第 4 节边界记录）。

### 1.11 Docker 本地构建能力 — 实测当前不可用

- `docker version`：client 29.3.1 可用，daemon 连接失败（Docker Desktop Linux engine 管道不存在），即 daemon 关闭。
- 修复动作：需要本地构建/校验镜像时启动 Docker Desktop；不影响仅使用既有 digest 的部署。

### 1.12 操作者位置与关键配置清单（为 Task 2-6 预留）

| 项目 | 位置/值 |
| --- | --- |
| 运维身份 kubeconfig | `D:/DeepLearning/MyProjects/Project_Manao_kubeconfig/stage6-6a-kubeconfig`（context `stage6-6a`） |
| 启动 env（两份，storage class 不同） | 同目录 `stage6-6a-local-cluster.env`（nfs-storage）、`stage6-6a-project-deletion.env`（manao-poc4-delete） |
| namespace | `manao-stage6-test` |
| DB schema | `manao_poc4`（jdbc:mysql://127.0.0.1:3306/manao_poc4；schema-reset 测试必须用一次性 schema，永不 reset manao_poc4） |
| 镜像 digest | 见 1.7 表（runner/agent/initializer 三个固定 digest） |
| 存储用途 1：项目文件 | PVC（RWX 10Gi，候选 `manao-poc4-delete`），workspace Pod 与 Maven Job 共挂 |
| 存储用途 2：待定第二用途（控制面/元数据或归档） | Task 2 决策后回填 |
| 资源预算 | 代码策略：Job 请求 1 CPU/1Gi/1Gi ephemeral、限 8 CPU/16Gi/10Gi；控制面预算 Task 2 决策后回填 |
| 入口（PUBLIC_ORIGIN） | 待 1.10 修复动作完成后回填 |
| 部署命令操作者位置 | Task 2 起：在 6B 工作树（本目录）执行，凭据仅从私有目录读取，不入库 |
| 恢复/清理命令操作者位置 | 同上；清理必须 project- and owner-scoped，遵循 AGENTS.md 清理规则 |

### 1.13 本轮窗口内 API 可达性异常记录

- 本轮 13:30 前后 10 分钟窗口内 `https://127.0.0.1:6443` 实测可达（完成 1.2–1.7 全部读取）；随后同一端点 `connectex: No connection could be made`（connection refused），且 netstat 无本地 6443 监听、tasklist 无 ssh/frp/隧道类进程。
- 判读：期间存在某个非本任务建立、随后停止的本地转发。本任务未启动、未干预任何隧道（符合约束）。
- 影响：1.4/1.6/1.7 的数据全部取自该实测窗口；1.9/1.10 需要后续窗口或修复动作完成。**后续任务执行前须先确认 6443 本地转发重新建立。**

## 2. Task 2 验收结果（占位）

- [ ] StorageClass 决策与部署资产
- [ ] 控制面（backend）Deployment/Service/RBAC
- [ ] runner 镜像 Maven 版本差异修复实测
- [ ] 结果：待填

## 3. Task 3 验收结果（占位）

- [ ] 前端部署资产与 PUBLIC_ORIGIN 实测
- [ ] 结果：待填

## 4. Task 4 验收结果（占位）

- [ ] 结果：待填

## 5. Task 5 验收结果（占位）

- [ ] 结果：待填

## 6. Task 6 验收结果（占位）

- [ ] 结果：待填

## 7. B1-B6 缺口清单（占位）

- [ ] B1：
- [ ] B2：
- [ ] B3：
- [ ] B4：
- [ ] B5：
- [ ] B6：
