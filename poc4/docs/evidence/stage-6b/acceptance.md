# Stage 6B 验收记录（acceptance.md）

本文件是 Stage 6B「单用户工作台迁云」的唯一阶段验收记录。

> **当前结论（2026-09-20）：STAGE6B_MVP_CLOUD_PASS，阶段已关闭。** 用户决定及证据边界见第 10 节；B6 版本记录闭环见第 9.5 节。6B 已通过合并提交 `860cdda` 纳入 master 并推送 origin/master，收尾提交为 `5059ab2`。部署及当前固定镜像以 [部署 README](../../../deploy/6b/README.md) 为准。
>
> **阅读顺序：** 第 10 节阶段结论 → 第 9 节当前受测版本的复测与后续 B6 闭环 → 第 8 节登录配置 → 第 1–7 节历史部署/验收轮次。第 9 节开头及原始 JSON 中的 B6 FAILED 是修正文档前的快照，后由第 9.5/10 节关闭。历史 BLOCKED、暂留项目和待办只代表其具名时点，不能当作当前状态或新的操作授权。

以下记录头描述 **Task 1 的 2026-09-18 起始快照**，不是当前 HEAD、工作树或环境状态：

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
- **G2 关闭（2026-09-18，Task 2 阶段 B 管理员身份实测）**：`kubectl get nodes -o wide`（admin）返回 3 节点全部 Ready——`master`（control-plane）、`node1`、`node2`，均为 Kubernetes v1.31.13 / containerd 1.7.13 / CentOS Linux 8，internal IP 172.16.0.5 / 172.16.0.13 / 172.16.0.4。同轮部署实测调度能力：`manao-stage6b` 的 backend Pod 调度到 node1、mysql-0 调度到 node2，均 Running（Task 1 的「3 节点」旧线索由 UNVERIFIED 转为实测确认）。
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
- **G1 补记（2026-09-18，Task 2 阶段 B）**：本地转发由用户经 Xshell 重建；本任务 16:20（+08:00）首次实测 `https://127.0.0.1:6443`（admin kubeconfig）可用。精确恢复起始时刻本任务未观测（转发在 16:20 前已建立），缺口按「16:20 前已恢复」记录。本轮执行全程（16:20–17:00）API 无中断，未触发等待重试逻辑。

## 2. Task 2 验收结果（2026-09-18，阶段 B：真实集群部署与验证）

- 记录时间：2026-09-18 17:00 (+08:00)；部署窗口 16:20–16:58（+08:00）
- 执行身份：管理员 kubeconfig（路径在私有目录，不记录于此）；全程未触碰 `manao-stage6-test` namespace 的任何资源（仅只读 get 核对，结果与 Task 1 清单一致），未删除任何旧资源。

- [x] StorageClass 决策与部署资产：项目 PVC 用 `manao-poc4-delete`（写入 ConfigMap `manao-backend-config`），MySQL PVC 用 `nfs-storage`（`data-mysql-0` 5Gi，apply 后约 10 秒 Bound）。部署资产为阶段 A 交付（`poc4/deploy/6b/` 全套），本轮无 YAML 修正。
- [x] 控制面（backend）Deployment/Service/RBAC：namespace `manao-stage6b` 于 16:20 创建（此前 NotFound 实测）；SA 3 个（`manao-backend` automount=true，`manao-workspace-agent`/`manao-maven-runner` automount=false）、Role/RoleBinding/ClusterRole（storage-reader）/ClusterRoleBinding 全部 created。Deployment `replicas=1`、`strategy=Recreate`、Service `backend` ClusterIP 8080。
- [ ] runner 镜像 Maven 版本差异修复实测：**NOT_REVERIFIED，本轮未实测**（属于 1.8 缺口，留给 Task 4 首次真实 Run 或一次性 Job 验证；与本项部署无阻塞关系）。
- [x] 结果：

**镜像**：`chocologic/manao_images_repository@sha256:5708a4b7383855826a6493a68a7f653be59db84502b82f05f045da23aaedd5fa`（tag `6b-backend-20260918`，非 root uid 10001）；MySQL `mysql:8.0.40`（tag 固定，digest 硬化留待运维按 README §mysql.yaml 注释执行）。Pod imageID 实测与上述 digest 一致。

**部署时序（kubectl 实测，+08:00）**：
1. 16:20 namespace/service-accounts/backend-rbac/configmap（ConfigMap 经 sed 注入 `MANAO_WS_EXTRA_ORIGIN: http://1.12.245.235:30080` 初值，仅集群内生效，仓库文件保持空占位——Task 3B 定稿公网入口后回填）/mysql 依次 apply。
2. 16:22 mysql-0 Ready（`statefulset.apps/mysql condition met`，约 1.5 分钟，调度至 node2）；PVC Bound。实测 MySQL 8.0.40，`log_bin_trust_function_creators=ON`，库 `manao_poc4_6b` 与用户 `manao` 自动创建。
3. 16:23 backend apply（sed 替换 digest 引用）→ 首次启动 CrashLoop：`workspace capability key pair is required`（见问题 1）。
4. 16:26 Secret `manao-backend-auth` 重建，rollout restart；16:27 Tomcat 8080 启动、Pod 1/1 Running（调度至 node1），readiness/liveness 均 `{"status":"UP"}`。
5. 16:33 `app_user` 创建（见问题 2/3）；16:43 集群内登录实测 HTTP 200。

**Flyway V1–V8**：后端日志 `Successfully validated 8 migrations` / `Current version of schema manao_poc4_6b: 8`；`flyway_schema_history` 实测 8 行全部 `success=1`（V1 initial schema … V8 project deleting state）；V3 trigger `workspace_operation_immutable_digest` 实测存在（BEFORE UPDATE ON workspace_operation，Definer `manao@%`，无 SUPER——binlog 旗标方案生效）。

**Pod 内验证（kubectl exec backend）**：
- 健康组：`/actuator/health/readiness` → `{"status":"UP","groups":["liveness","readiness"]}`；liveness UP。
- 集群 API（应用健康组 kubernetes）：以 SA token 请求 `GET /api/v1/namespaces/manao-stage6b/pods?limit=1` → 200；RBAC 实测 `persistentvolumes list` → 200、`storageclasses get` → 200、`secrets list` → 403（符合最小权限设计：无 Secret 读权限）。
- 集群 DNS：`mysql.manao-stage6b.svc.cluster.local` 与 `backend.manao-stage6b.svc.cluster.local` 均解析；DB FQDN 由 Flyway/Datasource 连接成功间接证实 TCP 3306 连通。
- 服务直连：`http://backend.manao-stage6b.svc.cluster.local:8080/actuator/health/liveness`（ClusterIP 经集群 DNS）→ 200。

**登录验证（集群内，经 backend Service）**：`POST http://backend:8080/api/v1/auth/login`（凭据经 stdin 进入 Pod 内临时文件、用后即删，未出现在命令行参数）→ **HTTP 200**，返回 `accessToken`（15m 有效期）、`expiresAt`、`user.username=app_user`。对照测试：错误密码 → 401 `UNAUTHENTICATED`（BCrypt 校验生效）。

**遇到的问题与修复**：
1. backend 首启 CrashLoop（`workspace capability key pair is required`）：生成 Ed25519 密钥对时 openssl 输出文件未落盘（临时目录变量为空），`--from-literal=CAPABILITY_...="$CAP_PRIV"` 注入了空值。修复：重新生成密钥对、按 Secret 键名重建 `manao-backend-auth`（实测 3 键均非空长度），rollout restart 后启动成功。属部署操作失误，非资产缺陷；README §2 命令本身正确。
2. `app_user` INSERT 首次失败 `Field 'created_at' doesn't have a default value`：README §3 的 SQL 早于实际 schema（V1 的 `app_user.created_at` 为 NOT NULL 无默认值）。修复：INSERT 增加 `created_at = CURRENT_TIMESTAMP(6)` 后成功；README 修正随本轮提交（资产修正）。
3. 登录 401 `Encoded password does not look like BCrypt`（存储哈希 40 字符、无 `$2b$12$` 前缀）：私有 env 文件值为未加引号形式，`source` 时 BCrypt 哈希中的 `$2`/`$12`/`$b` 被 shell 按位置参数展开，导致写入数据库的哈希被截断。修复：删除损坏行（该行本就不是有效 BCrypt 哈希，属损坏产物修复而非覆盖有效账号）、以 python 直接读文件重写参数化 SQL（不经 shell 变量展开）重新插入，实测存储哈希 60 字符 `$2b$12$` 前缀；env 文件值已全部单引号化防再发。登录随即 200。
4. `kubectl cp` 拉取 jar 用于诊断时 unexpected EOF（文件截断）：改用 Pod 内 grep 完成诊断，未影响部署。

**遗留项**：`MANAO_WS_EXTRA_ORIGIN` 为 NodePort 候选初值 `http://1.12.245.235:30080`，Task 3B 实测定稿后回填 ConfigMap 并 restart backend；MySQL 镜像 digest 硬化与 1.8 Maven 版本实测不在本轮范围。

### 2.1 安全事件处置与镜像回钉（2026-09-19 00:16–00:22 +08:00，Task 4 阶段 B 期间补记）

**事件**：backend Deployment 于 2026-09-18 约 19:09–19:13 (+08:00) 被重新部署为未知来源镜像 `sha256:a57da658…defe314e`（构建时间约 19:07，与已验收 `5708a4b7…` 相比 9 层中 2 层不同；用户确认非本人操作）。该镜像运行窗口（约 19:09–23:33，至 23:33 前后集群重启、容器集体重建为止）内 backend Pod env 可被读取，按凭据泄露处置。

**处置（admin kubectl，全部实测）**：
1. **镜像回钉**：`kubectl set image deploy/backend backend=chocologic/manao_images_repository@sha256:5708a4b7383855826a6493a68a7f653be59db84502b82f05f045da23aaedd5fa`（与 Task 2 验收 digest 逐字一致）→ rollout 成功（00:17:13），1/1 Ready。
2. **凭据轮换**（覆盖泄露窗口）：重新生成 JWT secret（64 字符，≥32 要求）、Ed25519 capability 密钥对（raw 32 字节 base64，README §2 openssl 方法）、`app_user` 新密码（48 字符随机，BCrypt(12) 存储）。
   - Secret `manao-backend-auth` 三键（JWT_SECRET / CAPABILITY_PRIVATE_KEY / CAPABILITY_PUBLIC_KEY）经 `--from-file` 全量更新（openssl 输出的 CRLF 先经规范化，避免换行进入 Secret 值），解码长度实测 64/44/44；
   - 私有 env 文件 `stage6-6b.env` 同步全部新值（并追加 `MANAO_6B_USERNAME` / `MANAO_6B_PASSWORD` E2E 别名），权限保持 0600；
   - DB `manao_poc4_6b.app_user` 仅改密码：参数化 SQL 文件（经 stdin 进入 mysql-0；root 密码取自容器 env，不出现在命令行）+ 用户变量 + `WHERE username = @u` 限定，实测 `updated_rows=1`、全表 `total_rows=1`（未触及其他行），存储哈希 60 字符、`$2b$12$` 前缀；
   - `rollout restart deploy/backend` → 00:21:20 Ready。
3. **验证**：Pod 内 `/actuator/health/readiness` 与 `/actuator/health/liveness` 均 `{"status":"UP"}`；公网入口以新凭据登录 **HTTP 200**（accessToken 签发，`user.username=app_user`），错误密码对照 **401**。
4. **边界**：旧 JWT / capability 签名失效为预期（单用户，重新登录即可）；mysql root 密码未暴露给 backend Pod，不轮换；全部新凭据值未进入任何报告、提交或控制台输出。

**RBAC 修复（控制器已裁决）**：`poc4/deploy/6b/backend-rbac.yaml` 的 Role `manao-backend-workload` 对 `batch/jobs` 增加 `patch` 动词（原 get/list/watch/create/delete 保持不变，未添加其他资源），apply 生效（Role configured，RoleBinding/ClusterRole/ClusterRoleBinding unchanged）。实证：`kubectl auth can-i patch jobs.batch -n manao-stage6b --as=system:serviceaccount:manao-stage6b:manao-backend` → **yes**（get/list/watch/create/delete 逐项复测均 yes）。该修复直接消除 §4.2.c/§4.2.d（09-18 23:44 轮）记录的 Start run 即 START_FAILED 根因；该事件对后续 E2E 的影响见 §4.0。

### 2.2 打包缺陷修复与新镜像部署（2026-09-19 00:45–01:25 +08:00，Task 4 阶段 B）

**红绿回归测试（先补复现测试再修复，计划要求）**：新增 `poc4/backend/src/test/java/com/manao/poc4/workspace/WorkspaceTemplateClasspathResourceTest.java`——对 `WorkspaceTemplate.FILES` 全部 5 个清单条目，经生产加载机制（`files()` → `ClassPathResource`）断言每个模板资源经 classpath 可读且非空（正对应 provisioning 的 `FileNotFoundException`）。

- 执行环境：本机无 mvn，红绿验证在 Docker `maven:3.9.9-eclipse-temurin-17`（与 Dockerfile 构建层同镜像）内挂载工作树执行，`.m2` 命名卷缓存依赖。
- **RED**（暂将 `addDefaultExcludes` 还原默认，`git stash`）：test 层 `mvn -B -Dtest=WorkspaceTemplateClasspathResourceTest clean test` → `Tests run: 1, Failures: 0`（未复现）。实测原因：`maven-jar-plugin` 默认排除只作用于打包 jar，测试 classpath 是 `target/classes`，`maven-resources-plugin` 仍会复制 `workspace-template/.gitignore`（36 字节）。**artefact 层复现**：同 RED 状态 `mvn -B -DskipTests clean package` → fat jar `BOOT-INF/classes/workspace-template/` 实测含 `pom.xml`/`README.md`/`App.java`/`AppTest.java` 而**缺 `.gitignore`**——与 §4.1 生产事故逐字一致（`FileNotFoundException: class path resource [workspace-template/.gitignore]`）。
- **GREEN**（恢复修复）：test `Tests run: 1, Failures: 0, Errors: 0, Skipped: 0`；同状态 `package` → jar 实测含 `BOOT-INF/classes/workspace-template/.gitignore`（另两资源一并确认）。
- `.dockerignore` 层（构建上下文缺资源）的实证即事故本身：`5708a4b7` 构建时使用未锚定 `.dockerignore`，运行时实测缺资源（§4.1 根因链）；本轮不重复构建坏镜像验证。
- 结论：打包缺陷在 jar 构建层（maven-jar-plugin 默认排除）与构建上下文层（`.dockerignore` 未锚定）双根因，两层修复均已提交并以 artefact 层红绿验证闭环。

**提交与镜像**：commit `d1fad6d`（`fix(stage6b): package workspace template resources and add regression test`：pom.xml + .dockerignore + 回归测试）。本机 Docker daemon 构建 `chocologic/manao_images_repository:6b-backend-20260918c`，构建后镜内冒烟（JRE 镜像无 jar 工具，经 `docker cp` 取出 jar 本机校验）：`BOOT-INF/classes/workspace-template/.gitignore|pom.xml|README.md` 均在 → push → **digest `sha256:ac88b11b38096da9fd3056f264782fecd18f3d5a560f5cf3a4ddd670dd5609cf`**。

**溯源记录（重要）**：本轮构建前，本地同名 tag `6b-backend-20260918c` 恰好指向未知事件镜像 `a57da658…`（`docker inspect` created=2026-09-18T11:07:13Z ≙ 19:07 +08:00，与 §2.1 事件时间线吻合——即该未知镜像当初在本机以同一 tag 构建，后未再使用）。本轮授权构建使该 tag 重新指向可溯源的新镜像；集群引用一律使用 digest 钉定，不使用 tag。

**私有 env**：`stage6-6b.env` 的 `BACKEND_IMAGE` 原地更新为新 digest 引用（不经 shell 变量展开，python 直读直写；文件 ACL 沿用私有目录继承权限，未放宽）。

**部署与验证（admin kubectl）**：01:24:19 `kubectl set image deploy/backend backend=chocologic/manao_images_repository@sha256:ac88b11b…` → rollout 成功；Pod `backend-7488cdbb56-hqfqn` 1/1 Running，Pod `image`/`imageID` 与 digest 逐字一致；Pod 内 `/actuator/health/readiness` 与 `/actuator/health/liveness` 均 `{"status":"UP"}`。frontend（`887c2e9f…`）与 mysql-0 未动。

## 3. Task 3 验收结果（2026-09-18，阶段 B：前端真实部署与公网入口验证）

- 记录时间：2026-09-18 17:30 (+08:00)；部署/验证窗口 17:05–17:20（+08:00）
- 执行身份：管理员 kubeconfig（路径在私有目录，不记录于此）；全程仅操作 `manao-stage6b` namespace
- [x] 前端部署资产与 PUBLIC_ORIGIN 实测：

**公网入口定稿**：`PUBLIC_ORIGIN = http://1.12.245.235:30080`（HTTP 明文；NodePort 直达，无 TLS 终止。按计划第 4 节边界记录：单用户工作台 MVP 阶段接受 HTTP 明文传输限制，登录凭据与 JWT 随公网明文传输；HTTPS 待复用既有服务器入口后再启用，届时同步更新 MANAO_WS_EXTRA_ORIGIN 为 HTTPS origin，浏览器自动改用 wss）。服务器无既有可复用入口（Task 1 实测 all-accept-no-service），故 frontend.yaml 的 Service 定稿为 `type: NodePort, nodePort: 30080`（仓库文件同步改为 NodePort 版本，ClusterIP 作为注释备选保留）。

**镜像**：`chocologic/manao_images_repository@sha256:887c2e9f9b9594d08c96a90d2e1fa4175bd6431e22479b647453583eb2e2699e`（tag `6b-frontend-20260918b`）。初版镜像 digest `d29ff0e8…93e7`（tag `6b-frontend-20260918`）部署即 CrashLoop（见问题 1），已由修正版取代；修正仅 nginx.conf 一行 upstream（资产修正，前端构建产物 dist 不变）。

**部署时序（kubectl 实测，+08:00）**：
1. 17:05 apply frontend.yaml（sed 注入 digest）→ Service `frontend` NodePort 8080/30080 created，Deployment created。
2. 初版镜像 Pod CrashLoopBackOff：nginx `[emerg] host not found in upstream "manao-backend"`。根因：backend Service 实际名为 `backend`（backend.yaml），而镜像内 nginx.conf 写的是 `manao-backend`——该主机名不存在，nginx 启动解析失败退出。修复：`poc4/frontend/deploy/nginx.conf` 的 `proxy_pass` 改为 `backend.manao-stage6b.svc.cluster.local:8080`（FQDN，理由同 MANAO_DB_URL 的可审计性决策），重建并推送镜像 `6b-frontend-20260918b`，17:18 重新 apply。
3. 17:19 rollout status `deployment "frontend" successfully rolled out`；Pod 1/1 Running（调度至 node2）。实测 `get svc frontend` → NodePort 30080（分配值与指定值一致）。集群内既有 backend/mysql-0 未受影响（backend Pod 仍为部署时创建的实例，未 restart——ConfigMap `MANAO_WS_EXTRA_ORIGIN=http://1.12.245.235:30080` 与定稿 PUBLIC_ORIGIN 一致，无需改动与重启）。
4. 17:20 Pod 内 `kubectl exec deploy/frontend -- nginx -t` → `nginx: the configuration file /etc/nginx/nginx.conf test is successful`。

**公网真实验证（本机直接 curl `http://1.12.245.235:30080`，非 localhost/隧道/集群内路径）**：

| 项 | 命令（脱敏） | 实测结果 |
| --- | --- | --- |
| a. 静态页面 | `curl http://1.12.245.235:30080/` | HTTP 200 `text/html`（403 B），HTML 含 `<div id="root">`（React 挂载点）与 `src="/assets/index-D18AvTFx.js"` |
| b. 静态资源 | `curl http://1.12.245.235:30080/assets/index-D18AvTFx.js` | HTTP 200 `application/javascript`（393 KB），`Cache-Control: public, max-age=31536000, immutable` |
| c. SPA 路由回退 | `curl http://1.12.245.235:30080/login` | HTTP 200 `text/html`（403 B），与 `/` 返回逐字节相同（`diff` 实测一致，回退到 index.html） |
| d. 同源 API 代理 | `curl -X POST http://1.12.245.235:30080/api/v1/auth/login -d '{"username":"probe-no-such-user",...}'` | HTTP 401，响应为 backend Spring Security JSON `{"code":"UNAUTHENTICATED","message":"Authentication required","traceId":"052af1cc-…"}` 及 backend 安全响应头（X-Frame-Options: DENY 等）——该 JSON 与响应头不可能由 nginx 自身产生，证明请求穿过 nginx 到达 backend（nginx 侧仅添加 `Server: nginx/1.27.5`）。backend 为 ClusterIP，公网无直达路径，此为唯一同源代理链路的实测证据 |
| e. WebSocket 升级路径 | `curl` 向 `/api/v1/ws/run-logs` 发 Upgrade 请求（Origin: http://1.12.245.235:30080，带 Sec-WebSocket-Key/Version） | **HTTP 101 Switching Protocols**（Sec-WebSocket-Accept 正确），升级后 backend 推送 `log ticket rejected`（无 ticket 的预期拒绝）；对照：同路径无 Upgrade 头 GET → HTTP 400。证明 nginx 正确转发 Upgrade/Connection 且 backend 的 WS origin 白名单接受 PUBLIC_ORIGIN。真正的日志握手与传输随 Task 4 的 Run 验证（本轮不建 Run） |

**结论**：浏览器可从公网地址加载页面与静态资源，同源 `/api/` REST 代理与 WebSocket 升级链路均实测连通。浏览器登录操作本身随 Task 4 E2E 验证。

**遇到的问题与修复**：
1. 初版前端镜像 CrashLoop（`host not found in upstream "manao-backend"`）：阶段 A 按 brief 示例配置写死了 `manao-backend` 主机名，但 Task 2 实际部署的 backend Service 名为 `backend`——两份资产间的名称假设未经对账，属阶段 A 资产缺陷而非部署操作失误。修复：nginx.conf upstream 改为 backend Service FQDN，重建镜像 `6b-frontend-20260918b`（digest `887c2e9f…e2699e`），重新 apply 后正常。frontend.yaml/README/nginx.conf 已同步修正（随本轮提交）。
2. CrashLoopBackOff 期间容器秒级退出导致 `kubectl exec` 持续报 `unable to upgrade connection: container not found`，Pod 内 DNS 诊断一度受阻；改由 mysql-0（同 namespace）`getent hosts backend.manao-stage6b.svc.cluster.local` 实测 DNS 解析正常（返回 ClusterIP 10.233.53.222），定位到 upstream 名称本身不存在。

**遗留项**：浏览器端登录/编辑/运行/日志全链路随 Task 4；HTTP 明文边界如上记录；backend Service 若重建需 `rollout restart deploy/frontend`（nginx 静态 upstream 解析，已写入 README §8.2）。

## 4. Task 4 验收结果（阶段 B：真实公网 E2E 生命周期验收——最终 6/6 通过）

- **结果：PASSED。2026-09-19 01:39:24–01:42:14 (+08:00) 最终轮完整重跑实测 Playwright 报告 `6 passed (2.8m)`（报告正文核对：无 skip、无 did not run）。达成路径：打包缺陷修复并构建部署新镜像 `sha256:ac88b11b…`（§2.2，红绿验证）+ 两处测试资产缺陷修正（4.0 末）。此前各失败轮（09-18 23:44 RBAC 根因、09-19 00:23 打包缺陷根因）均按规程如实记录，保留为历史（4.1、4.2），不作为通过依据。**

### 4.0 Task 4 最终验收轮（2026-09-19 01:39:24–01:42:14 +08:00；后续复测见第 9 节）

- **前置（全部完成）**：backend 新镜像 `sha256:ac88b11b…` 于 01:24:19 部署、rollout 成功、健康组 UP（§2.2）；Role 已含 `jobs.batch patch`（§2.1）。
- **残留清理（前置，实测）**：历史缺陷证据项目 `049b4aa6-9478-43db-a815-cf54adc7b671`（FAILED，4.1 轮遗留，无集群资源、仅 DB 行占配额）以轮换后新凭据经真实公网 API `DELETE /api/v1/projects/{id}` → **HTTP 204**；GET 列表 → `items: []`、单项 → **404 `ENTRY_NOT_FOUND`**；admin kubectl 核对命名空间内无任何 workspace/Job/PVC 资源。配额回到 0/8。
- **运行环境**：公网入口 `GET http://1.12.245.235:30080/` → 200、错误凭据登录探针 → 401；本机 Vite/Spring Boot 未运行（netstat 核对无 5173/18080 监听）。
- **E2E 实测**（`pnpm --dir poc4/frontend test:e2e:stage6b`，env 私有注入；窗口 01:39:24–01:42:14 +08:00，**exit 与报告一致 6 passed**）：

| # | test | 结果 | 用时 |
|---|---|---|---|
| 1 | 登录、创建标记项目、等待 READY、取 projectId | **ok** | 18.7s |
| 2 | 编辑 App.java、显式保存、revision 前进 | **ok** | 3.2s |
| 3 | 保存可复现编译错误、运行、观察 FAILED 与编译反馈 | **ok** | 1.8m |
| 4 | 修复、保存、再运行、观察 SUCCEEDED | **ok** | 28.6s |
| 5 | 终态后仍可编辑保存 | **ok** | 2.8s |
| 6 | 刷新/退出重登持久化 | **ok** | 5.1s |

- **最终项目（保留供 Task 5）**：`stage6b-cloud-20260918173926-c6bn`，projectId **`da577551-0ee9-4d95-8f03-16225625c589`**；broken run **`8ee1a7f5-a913-42f3-8b88-7e1c9067a372`**（FAILED，Run logs 含 `cannot find symbol` 与 `missingSymbol`）、fixed run **`1776cb9b-de9f-46a3-927d-3119f2ac47c3`**（SUCCEEDED，Run logs 含 `Hello from Manao`）。测试 console `[stage6b]` 行与 `stage6b-project.json`/`stage6b-broken-run.json`/`stage6b-fixed-run.json` 附件字段一致（list reporter 下 buffer 附件不落盘，交接数据以 console 行提取，内容相同）。
- **佐证（公网 API + admin kubectl 只读，运行中与结束后实测）**：项目 `state=READY`；GET runs → `SUCCEEDED`/`BUILD_SUCCEEDED` 与 `FAILED`/`BUILD_FAILED` 两条记录；Job `manao-run-1776cb9b…` **Complete 1/1**、`manao-run-8ee1a7f5…` **Failed 0/1**（终态与 Run/Job 一致）；workspace Pod/Service `manao-ws-da577551…` Running、PVC `manao-pvc-da577551…` 10Gi RWX Bound → 新 PV `pvc-89121e22…`（`manao-poc4-delete`）。运行期间无重启、无异常事件。
- **B1–B3 证据对应**：
  - **B1（无本机依赖、公网完成完整流程）**：成立——6 test 全程仅浏览器 + 公网入口 `http://1.12.245.235:30080`，创建→编辑→两次真实运行→持久化复核全部经真实 UI 完成。
  - **B2（同一界面完成创建/编辑保存/真实失败反馈/修复运行成功/再次编辑）**：成立——test 3 给出真实编译错误文本反馈（FAILED + `cannot find symbol`/`missingSymbol`），test 4 同界面修复运行 SUCCEEDED 并见成功输出，test 5 终态后再次编辑保存。
  - **B3（日志实时、终态与 Run/Job 一致、刷新与重登持久化）**：成立——Run logs 实时展示编译错误与成功输出；终态与 API 记录、集群 Job 状态三方一致（上表佐证）；test 6 刷新（重登）与退出重登后项目/文件 final marker/两条 run 历史/revision 全部保留。
- **本轮前两次 5/6 轮（测试资产缺陷，如实修正后重跑；均为真实公网环境）**：
  1. 01:25:21–01:28:11：`5 passed / 1 failed`——test 6 假设 reload 后会话仍有效；实际前端 token 为内存态（`authSession.test.ts` 设计：不写 localStorage/sessionStorage），reload 落在登录页。属测试资产假设与既有安全设计不符（应用行为正确，stage4 spec reload 后同样重新登录）。修复（commit `81211b7`）：reload 后重新登录再复核。遗留项目 `2a39726e…`（READY，两次终态 run）经公网 API DELETE → 204、列表空、404，集群无残留、PV `pvc-29ec5a5e…` 已回收。
  2. 01:33:59–01:37:00：`5 passed / 1 failed`——reload 后重新登录被 returnTo 深链直接带回 `/projects/{id}`（`RequireAuth` `state.from` → `resolvePostLoginPath`，应用行为正确且属既有设计），signIn 辅助函数只断言列表页 URL 过严。修复（commit `c545442`）：signIn 接受列表/深链两种落点，深链场景在项目页内直接断言。遗留项目 `5d192f57…`（READY，两次终态 run）经公网 API DELETE → 204，列表空。
  - 两轮失败工件：attempt 1/2 的 trace/video 因后续重跑按 Playwright outputDir 机制清空，失败原因以测试输出与 error-context 记录为准（本节），不影响最终判定。

### 4.1 历史轮二（09-19 00:23，打包缺陷根因——已修复，见 §2.2）

> 本节为 09-19 00:23 轮的原始记录，保留作历史证据；其根因（已验收镜像 jar 缺 `workspace-template/.gitignore`）已由 §2.2 的打包修复 + 新镜像 `sha256:ac88b11b…` 修复，遗留项目 `049b4aa6…` 已在最终轮前置清理中删除。

- **前置（全部完成，见 §2.1）**：backend 镜像回钉至已验收 `sha256:5708a4b7…`；JWT/capability/app_user 凭据全量轮换并实测（健康组 UP、新凭据公网登录 200）；Role 已授 `jobs.batch patch`（can-i → yes）。
- **残留清理（前置）**：09-18 23:44 轮遗留项目 `6839f32c-ec9f-46b4-a9f6-2e4f1d6dfa52`（`stage6b-cloud-20260918154446-rfp1`）以轮换后新凭据经真实公网 API `DELETE /api/v1/projects/{id}` → **HTTP 204**；GET 列表 → `items: []`、单项 → **404 `ENTRY_NOT_FOUND`**；admin kubectl 核对 `manao-ws-6839f32c-*` Pod/Service、`manao-pvc-6839f32c-*` PVC 消失，PV `pvc-3d0c413c-…` **NotFound**（`manao-poc4-delete` Delete 回收实测生效），无 Job 残留。项目配额回到 0/8。
- **运行环境**：公网入口 `GET http://1.12.245.235:30080/` → 200；本机 Vite/Spring Boot 未运行；本机 MySQL 保留（用户豁免）；集群 09-18 23:33 前后集体重启的容器本轮全程运行稳定。
- **E2E 实测**（`pnpm --dir poc4/frontend test:e2e:stage6b`，env 注入轮换后新凭据；窗口 00:23:20–00:33:48 +08:00，exit 1）：

| # | test | 结果 | 用时 |
|---|---|---|---|
| 1 | 登录、创建标记项目、等待 READY | **failed**（项目卡状态 **FAILED**，等待 READY 600s 超时） | 10.4m |
| 2 | 编辑 App.java、显式保存、revision 前进 | did not run（serial 中断） | — |
| 3 | 编译错误运行、观察 FAILED 反馈 | did not run（serial 中断） | — |
| 4 | 修复运行、观察 SUCCEEDED | did not run（serial 中断） | — |
| 5 | 终态后仍可编辑保存 | did not run（serial 中断） | — |
| 6 | 刷新/退出重登持久化 | did not run（serial 中断） | — |

- 新项目：**`stage6b-cloud-20260918162324-fnzk`**，projectId **`049b4aa6-9478-43db-a815-cf54adc7b671`**；公网 API 实测 `state=FAILED`；无任何 run 创建；**集群内无残留资源**（provisioning 失败后 label-scoped 自动清理实测生效），DB 行保留作缺陷证据（占配额 1/8）。
- **失败根因（实测证据链）**：
  1. backend 日志（16:23:41Z = 00:23:41 +08:00）：`ProjectProvisioningService` — `provisioning failed; cleaning up label-scoped resources`；`java.io.UncheckedIOException: cannot load workspace template resource workspace-template/.gitignore`；`Caused by: java.io.FileNotFoundException: class path resource [workspace-template/.gitignore] cannot be opened because it does not exist`。
  2. K8s 侧：workspace Pod/PVC 曾短暂创建后被清理，最终 namespace 内无任何 `049b4aa6` 相关资源（实测）。
  3. UI 侧：项目卡状态 FAILED（API 实测一致），测试等待 READY 超时——测试资产按设计如实暴露用户可见故障，无测试资产缺陷。
  4. **定性**：已验收镜像 `5708a4b7…` 内 jar 缺少 `workspace-template/.gitignore` 类路径资源（Maven jar 默认排除 `**/.gitignore` 所致），项目 provisioning 在该镜像上必然失败。工作树内**未提交**的 `poc4/backend/pom.xml`（maven-jar-plugin `addDefaultExcludes=false`）与 `poc4/backend/.dockerignore`（锚定 `/.gitignore`、`/*.md`，保留模板资源）正是该缺陷的修复，尚未构建进任何可溯源镜像。
  5. 历史旁证：09-18 17:44 在 `5708a4b7` 上创建的 `3bbc74ae…` 即 state FAILED（同因）；未知镜像 `a57da658` 上线后创建的 `ddaca1c0…`（19:10）与 `6839f32c…`（23:44）均 READY——未知镜像很可能包含上述打包修复，但来源未验证，不作为任何通过依据。
- **失败资产保留（不删除）**：`poc4/frontend/test-results/stage6b-cloud-lifecycle-st-31f1b--project-and-wait-for-READY-stage6b-cloud/`（trace.zip、video.webm、test-failed-1.png、error-context.md）。
- **处置：BLOCKED（当时待控制器裁决）——修复路径：提交打包修复 → 本机构建并推送新 backend 镜像 → 部署新 digest → 从头重跑 6 test 场景。该路径已由 §2.2 全部完成（commit `d1fad6d`、镜像 `sha256:ac88b11b…`、最终轮 6/6），此行仅作历史记录。未知镜像事件见 §2.1；B1–B3 缺口见 §7。**

### 4.2 历史轮一（09-18 23:44，RBAC 根因——已修复，见 §2.1）

> 以下小节（4.2.a–4.2.e）为 09-18 23:44 轮的原始记录，保留作历史证据；原编号 4.1–4.5 与顶层 §4.1/§4.2 重号，已于 Task 6（2026-09-19）改为带前缀编号。其根因（Role 缺 `patch`）已于 09-19 修复并验证（§2.1），该轮遗留项目 `6839f32c…` 已于 09-19 00:22 经公网 API 删除（见 §4.1 前置）。

- 记录时间：2026-09-18 23:59 (+08:00)；E2E 窗口 23:44:44–23:58:41 (+08:00)；残留清理窗口约 23:40–23:43 (+08:00)
- 执行者：Task 4 阶段 B 重跑（第一次 Task 4B 运行因集群问题被用户中断，本轮为如实重跑）

### 4.2.a 运行前环境与残留清理（实测）

- 公网入口：`GET http://1.12.245.235:30080/` → 200；登录探针（不存在用户）→ 401。本机 Vite/Spring Boot 未运行；本机 MySQL 保留运行（用户豁免，其他业务在用），E2E 全程仅浏览器 + 公网入口。
- 集群恢复观察（admin kubectl，只读）：backend/frontend/mysql-0 均 Running；**全部容器在 23:33 前后（+08:00）集体重启**（startup BackOff 后恢复，属集群重启恢复尾部），本轮 E2E 全程平台无再重启。
- **backend 镜像变更记录**：当前 backend Pod 镜像 `sha256:a57da658…defe314e`（Pod 约 19:13 +08:00 重建，即第一次中断运行期间/之后被重新部署），与 Task 2 记录的 `sha256:5708a4b7…edd5fa` 不同；frontend 仍为 Task 3 的 `887c2e9f…e2699e`。该变更为运行环境事实，本轮未改动。
- **中断残留清理（额外的一次真实 API 删除验证）**：第一次中断运行遗留两个 `stage6b-cloud-*` 项目（均 app_user 所有）：
  - `3bbc74ae-36b1-4fec-b5af-3fe7884990a9`（`stage6b-cloud-20260918094433-flhm`，state FAILED，集群内已无任何 workspace 资源）；
  - `ddaca1c0-f8fb-403a-8d4f-e53deeff70ea`（`stage6b-cloud-20260918111018-ax9s`，state READY，workspace Pod/Service Running、PVC Bound）。
  - 以 app_user 经真实公网 API 路径逐个 `DELETE /api/v1/projects/{id}` → **两个均 HTTP 204**；GET 列表 → `items: []`；GET 单项 → 404 `ENTRY_NOT_FOUND`。
  - admin kubectl 核对：`manao-ws-ddaca1c0-*` Pod/Service 消失、`manao-pvc-ddaca1c0-*` PVC 消失、对应 PV `pvc-11d48b0e-…` 已 NotFound（`manao-poc4-delete` Delete 回收策略实测生效）；无残留 Job。删除链路 API→DB→K8s→PV 全链路实测通过。
- admin kubectl 通道事实：用户侧 127.0.0.1:6443 本地转发本轮不可用；实测集群 API 公网端点 `https://1.12.245.235:6443` 可达（证书 SAN 含 127.0.0.1，不含公网 IP），在私有目录（不入库、不提交）建立 admin kubeconfig 副本以继续只读观察。

### 4.2.b E2E 实测结果（`pnpm --dir poc4/frontend test:e2e:stage6b`，env 注入凭据）

| # | test | 结果 | 用时 |
|---|---|---|---|
| 1 | 登录、创建标记项目、等待 READY、取 projectId | **ok** | 18.8s |
| 2 | 编辑 App.java、显式保存、revision 前进 | **ok** | 3.3s |
| 3 | 保存可复现编译错误、运行、观察 FAILED 与编译反馈 | **failed**（780s 超时，`Run state` 始终为 "Idle"，1533 次轮询） | 13.5m |
| 4 | 修复、保存、再运行、观察 SUCCEEDED | did not run（serial 中断） | — |
| 5 | 终态后仍可编辑保存 | did not run（serial 中断） | — |
| 6 | 刷新/退出重登持久化 | did not run（serial 中断） | — |

- 本次新项目：**`stage6b-cloud-20260918154446-rfp1`**，projectId **`6839f32c-ec9f-46b4-a9f6-2e4f1d6dfa52`**。broken run id **`d2460769-ba49-40b2-9ccd-db655b7f10ae`**（FAILED / START_FAILED）；**无 fixed run**（未执行到）。项目连同其 workspace 与该 run 记录**暂时保留**作为缺陷证据，待裁决后处理（8 项目限额当前占用 1）。
- 失败工件保留（不删除）：`poc4/frontend/test-results/stage6b-cloud-lifecycle-st-9f761-ILED-with-compiler-feedback-stage6b-cloud/`（trace.zip、video.webm、test-failed-1.png、error-context.md）。
- 集群佐证（admin kubectl，只读）：workspace `manao-ws-6839f32c-…` Pod/Service 创建并 Running（node1），PVC `manao-pvc-6839f32c-…`（10Gi RWX，`manao-poc4-delete`）Bound → 新 PV `pvc-3d0c413c-…`；initializer `manao-ws-init-…`（busybox probe-permissions）Completed。**运行 Job `manao-run-d2460769-…` 自始至终不存在**，无任何 run Pod/Job 事件。

### 4.2.c 失败根因（实测证据链）

1. UI 侧：点击 Start run 后 `POST /api/v1/projects/{id}/runs`（body `{"expectedWorkspaceRevision":"23"}`）→ **HTTP 503** `{"code":"INTERNAL_ERROR","message":"Request failed","traceId":"fcef2f71-2b7a-48dc-984e-51af4fc35fd1"}`（Playwright trace network 实录）。前端 `Run state` 状态元素停留在 "Idle"，测试等待 780s 后失败。
2. DB 侧（API 只读核对）：run `d2460769-…` 于 `15:45:12.225633Z` 创建、`15:45:12.266381Z` 即终态（**40ms**），`state=FAILED`、`terminationReason=START_FAILED`、无日志。revision 校验本身通过（23 匹配）——即 RunService 在 `ensureJob` 抛异常后 settle START_FAILED 并回 503 的路径。
3. K8s 侧：Job 从未创建（无对象、无事件）。
4. 后端日志：15:45:12Z 前后**零日志**——`RunService.startLocked` 的 catch 分支静默吞掉异常（无 LOG 语句），故障不可观测（伴生缺陷）。
5. 直接原因（实测）：`Fabric8JobCoordinator.ensureJob` 对 Job 使用 **`serverSideApply()`（PATCH）**（自 `301a8e6` 引入），而 6B Role `manao-backend-workload`（仓库 `poc4/deploy/6b/backend-rbac.yaml`，commit `b4e181c`，与集群 live 一致）对 `batch/jobs` 只授 `get,list,watch,create,delete`——**无 `patch`**。实证：`kubectl auth can-i patch jobs.batch --as=system:serviceaccount:manao-stage6b:manao-backend` → **no**（`create` → yes）。对照：workspace Pod/Service/PVC 走 `Fabric8KubernetesGateway` 的 `.create()`（create 动词）全部成功——与「创建 READY 正常、Start run 即败」的现象完全一致。
6. 为什么 6A 未暴露：6A 本地集群 SA 对 `jobs.batch` 为全权（含 patch）；6B 部署资产在收窄动词时未对账代码实际使用的 PATCH 传输。

### 4.2.d 历史缺陷定性（当时 BLOCKED；修复见第 2.1–2.2 节）

- **业务/部署资产缺陷**（非测试资产缺陷，测试选择器与等待行为正常且如实反映了用户可见结果）：修复方向二选一，均需裁决且按 brief「先加能复现问题的回归再修复」：
  1. RBAC 侧：`poc4/deploy/6b/backend-rbac.yaml` 为 `batch/jobs` 增加 `patch`（若保留 serverSideApply 传输）；
  2. 代码侧：`Fabric8JobCoordinator.ensureJob` 改为 `.create()`（若维持最小 RBAC）。
  - 伴生问题（同批裁决）：`RunService` catch 路径无日志（故障静默）；START_FAILED 时前端 Run state 停留 "Idle"、用户得不到任何可见反馈（本次测试失败的直接表现）。
- 裁决与修复后需**从头重跑完整 6 test 场景**（新项目名、新 run id），本轮项目与记录不作为通过依据。

### 4.2.e B1–B3 证据对应（Task 4 范围）

- **B1（无本机依赖、公网完成流程）**：部分成立——登录、创建、READY、编辑保存全部经公网入口真实 UI 完成（test 1/2 passed），本机应用依赖为零；「完整流程」因 B2 阻塞未完成，不宣称通过。
- **B2（同一界面完成创建/编辑保存/真实失败反馈/修复运行成功/再次编辑）**：**失败证据在案**——创建、编辑保存已过；「真实失败反馈」环节后端 Start run 即 START_FAILED（40ms、无 Job、503），前端无任何失败反馈（Run state 停留 Idle），后续修复运行/再次编辑均未执行。
- **B3（日志实时、终态与 Run/Job 一致、刷新与重登持久化）**：未执行（serial 中断），无证据。

## 5. Task 5 验收结果（2026-09-19 01:57–02:12 +08:00，阶段 B：持久化验证与最终删除；结束时间原记 02:10，Task 6 按 task-5 报告核对统一为 02:12）

- **结果：PASSED。沿用 Task 4 §4.0 验收项目 `da577551-0ee9-4d95-8f03-16225625c589`（`stage6b-cloud-20260918173926-c6bn`）完成后端维护重启与 MySQL 正常重建的持久化验证（各再真实运行一次到终态），最后经浏览器 UI 手动删除并独立核对集群/存储/DB 全链路清理。全程正式部署身份（app_user 经公网入口 `http://1.12.245.235:30080` 登录），无本机应用依赖。**
- 执行身份与边界：业务操作（登录、验证、删除）全部经公网入口 `http://1.12.245.235:30080` 与 app_user；kubectl admin 仅用于运维动作（scale/delete/exec 只读查询）与资源观察，未触业务 API 路径。本机 Vite/Spring Boot 未运行（开窗 netstat 实测无 5173/18080 监听），本机 MySQL 保留（用户豁免，未参与云端链路）。凭据仅从私有 env 读取，未入报告/提交/命令行参数。
- 测试方法：临时 Playwright 脚本（`.superpowers/sdd/2026-09-18-stage6b-cloud-workbench-implementation-plan/tmp/`，gitignored，不入库）复用 Task 4 spec 的登录/项目卡/树/Run 面板选择器；凭据只经环境变量注入。

### 5.1 基线快照（01:57–01:59，实测）

- 公网 API：GET /projects → 仅 `da577551…`（READY）；GET 详情 state=READY 无 failureReason；GET files/tree → **workspaceRevision=25**，条目 `.gitignore`、`?`（PVC 内实际存在的一个名为 `?` 的目录，如实记录，未触碰）、README.md、pom.xml、src、target；GET App.java 内容含 `// stage6b-final-edit` 与 `return "Hello from Manao";`。
- GET /runs → 两条历史：`8ee1a7f5…`（FAILED/BUILD_FAILED，revision 23，17:39:51Z→17:41:33Z）、`1776cb9b…`（SUCCEEDED/BUILD_SUCCEEDED，revision 24，17:41:40Z→17:42:03Z），与 Task 4 §4.0 一致。
- admin kubectl 只读：workspace Pod/Service `manao-ws-da577551…` Running、Job `manao-run-1776cb9b…` Complete 1/1 与 `manao-run-8ee1a7f5…` Failed 0/1、PVC `manao-pvc-da577551…` Bound → PV `pvc-89121e22…`；Job pod 日志摘要（fixed `Hello from Manao`，broken `cannot find symbol`/`missingSymbol`）与 Task 4 记录一致。配额占用 1/8。

### 5.2 后端维护重启（B5 之一，仅此一次；02:00–02:05，实测）

- 前置：GET /runs/active → `{"run": null}`（无活动 Run）；deployment `replicas=1, strategy=Recreate` 实测记录。
- 时序（admin kubectl）：02:01:20 `scale deploy/backend --replicas=0` → **02:01:22 backend Pod 完全消失**（Recreate，约 2s）；02:01:30–02:02:00 观察 30 秒（轮询确认副本为 0、无 Pod 残留）→ 02:02:00 `--replicas=1` → **02:02:17 deployment available**（约 17s）。旧进程结束到恢复总窗口约 **57 秒**。
- 新 Pod `backend-7488cdbb56-46tfs`（同一 ReplicaSet，非重部署）：imageID 实测仍为已验收 `sha256:ac88b11b…`；Pod 内 readiness `{"status":"UP"}`。
- 重启后公网验证：重新登录 200；项目 READY、**revision 仍 25**、App.java 内容（final marker + greeting）不变；两条 run 历史及状态不变。
- **再次运行（既有代码路径 POST /runs，expectedWorkspaceRevision=25）**：新 run `dbeff9c3-84ff-4c1a-98fa-68282173b577` → **SUCCEEDED/BUILD_SUCCEEDED**（发起到终态约 13.5s）。重启后运行能力可用，新 run 记录在案。
- UI 验证（02:05:21，临时脚本）：深链 `/projects/{id}` → 落登录页（token 内存态设计）→ 重新登录回到项目 → 文件树展开 App.java 内容含 final marker → Run 页历史 **3 条**（`dbeff9c3`/`1776cb9b`/`8ee1a7f5`）逐条点击：已落库日志可读（`Hello from Manao` ×2、`cannot find symbol` ×1）。

### 5.3 MySQL 正常重建（B5 之二；02:05–02:08，实测）

- 前置：上一步新 run 已终态（SUCCEEDED）。
- 时序（admin kubectl）：02:05:42 `delete pod mysql-0` → 02:05:47 旧 Pod 消失（5s）→ **02:06:17 StatefulSet 自动重建的新 mysql-0 Ready**（删除到 Ready 约 35s）；**PVC `data-mysql-0` 保持 Bound**（PV `pvc-d6b6bc54…` 不变，nfs-storage 5Gi）。
- 重建后公网验证：重新登录 200（DB 数据完好）；项目 READY、revision 仍 25、App.java 内容不变；run 历史 3 条全在；**再运行一次**：`5f129f49-8d5c-420c-be97-f2b4df813307`（POST /runs，revision 25）→ **SUCCEEDED/BUILD_SUCCEEDED**（约 18.9s）。
- UI 验证（02:07:29）：项目 + 文件内容 + **4 条 run 历史** + 已落库日志全部可读。无活动 Run 意外，无需「中断续接」表态。

### 5.4 条件测试裁决（均 SKIPPED，controller 已裁，如实记录）

| 条件测试 | 触发条件 | 本轮判定 |
| --- | --- | --- |
| workspace Pod 主动删除（验证 PVC 文件不重置） | 仅当工作区恢复相关代码变化，或观察到恢复异常 | **SKIPPED**：6B 未改工作区恢复代码；09-18 23:33 集群集体重启已自然验证恢复（Pod 自动回来，Task 4 §4.1 实测）。触发条件未满足，不主动执行 |
| 删除故障注入（DELETING、不假成功、显式续作） | 仅当删除代码/存储回收策略变化，或实际删除异常 | **SKIPPED**：6B 未改删除代码；四轮真实 API 删除（`6839f32c`/`ddaca1c0`/`2a39726e`/`5d192f57`，含 PV 回收）全部干净回收无异常。触发条件未满足；显式续作按钮（DELETING → Continue deletion）保留在 UI 代码中未回退 |

### 5.5 最终手动删除（B4；02:08:07–02:08:38，浏览器 UI 路径实测）

- 路径：临时 Playwright 脚本复用 spec 选择器——登录 → 项目列表找到 `stage6b-cloud-20260918173926-c6bn` 卡片 → 点 **Delete project** → 原生确认对话框 **"Delete project?"**（显示项目名与「Files, run history and logs will be permanently removed. This cannot be undone.」）→ 点 **Delete permanently** → 实测捕获 `DELETE /api/v1/projects/da577551…` → **HTTP 204** → 卡片从列表消失，**reload 后仍不显示**（总耗时约 31s）。
- 观察记录：删除为同步完成，未出现 DELETING 卡片/"Continue deletion" 续作窗口（该路径 UI 代码保留、未回退，本轮未触发生成场景——如实记录，不宣称已再验证续作行为）。
- API 复核（公网）：GET /projects → `items: []`；GET 单项 → **404 `ENTRY_NOT_FOUND`**；GET 该项目 /runs → `items: []`。

### 5.6 独立清理核对表（B4 核心；删除后 admin kubectl + DB 实测，独立于应用 API）

| 资源/记录 | 核对命令（脱敏） | 结果 |
| --- | --- | --- |
| workspace Pod `manao-ws-da577551-*` | `kubectl get all,pvc -n manao-stage6b` | **消失**（命名空间仅剩 backend/frontend/mysql 平台资源） |
| workspace Service `manao-ws-da577551-*` | 同上 | **消失** |
| initializer Pod（`manao-ws-init-*`） | 同上 | **消失**（无任何 init/run 类 Pod 残留） |
| run Job `manao-run-1776cb9b/8ee1a7f5/…`（含 Pod） | 同上 + name grep | **消失**（对 da577551/1776cb9b/8ee1a7f5/5f129f49/dbeff9c3 全部无匹配） |
| PVC `manao-pvc-da577551-*` | 同上 | **消失** |
| 绑定 PV `pvc-89121e22-13f9-4c37-a6ad-981d079612e2` | `kubectl get pv` grep | **NotFound（已回收；`manao-poc4-delete` reclaimPolicy=Delete + onDelete=delete）** |
| NFS 存储目录直查 | busybox 临时 Pod 挂载 NFS export（Task 6 有界诊断补查，见 §5.8） | **对应子目录 ABSENT（真删除、未归档）**，详见 §5.8 |
| DB `project` 行（manao_poc4_6b） | exec mysql-0 逐表 SELECT COUNT | **0**（且 project 全表 0 行，配额回到 0/8） |
| DB `run` 行 | 同上 | **0** |
| DB `run_log_chunk`（经 run JOIN） | 同上 | **0** |
| DB `workspace_operation` | 同上 | **0** |
| DB `log_ticket` | 同上 | **0** |
| DB `terminal_audit` | 同上 | **0** |
| DB `terminal_session` | 同上 | **0** |
| MySQL PVC/卷 `data-mysql-0` → `pvc-d6b6bc54…` | `kubectl get pvc` | **保持 Bound（5Gi nfs-storage，未删除）**；重建后登录/查询正常证明数据完好 |

- DB 查询方式：admin exec 进 mysql-0，DB 凭据取自容器 env（与私有 env 部署值同源），凭据不出现在命令行/输出。

### 5.7 B4/B5 证据对应（B6 留 Task 6）

- **B4（最后手动删除确实回收同一验收项目的应用记录和资源）**：成立——删除经真实浏览器 UI 完成（对话框确认 + DELETE 204 + 列表消失），5.6 独立核对表显示集群资源、PV、DB 关联行全部回收，MySQL 卷保留。「不假成功与显式续作」行为保留在代码中，故障注入按 5.4 裁决 SKIPPED。
- **B5（后端与 MySQL 各正常重建一次后数据可用、可再运行）**：成立——5.2 后端 scale 0→1（约 57s 窗口）与 5.3 mysql-0 重建（PVC 保留）后，文件/revision/历史/已落库日志全部保留，各再真实运行一次到 SUCCEEDED 终态。workspace 主动重建按 5.4 裁决 SKIPPED；未遇活动 Run 中断场景。

### 5.8 NFS 目录直查补记（2026-09-19，Task 6 有界诊断，controller 已批准）

- 背景：§5.6 原记录「NFS 存储目录直查未直接执行」（provisioner 镜像无 shell 可 exec），以 PV 对象 NotFound + 同 StorageClass 历史删除为替代依据。本节为 Task 6 的有界补查，关闭该缺口。
- 方法（命令摘要，admin kubectl）：在 `manao-stage6b` 创建一次性 busybox Pod（`manao-6b-nfs-check`，镜像 `busybox@sha256:73aaf090…1662` 与 §1.7 initializer 同源，节点已缓存无新拉取），挂载 NFS export 后仅执行只读 `ls`，随即删除 Pod（实测确认已消失，未触碰任何文件）。NFS server/path 取自 provisioner 部署 `default/nfs-client-provisioner` 的 env（`NFS_SERVER=172.16.0.5`、`NFS_PATH=/nfs/data`）——`manao-poc4-delete` StorageClass 本身不带 server/path 参数，provisioner 级配置为准。
- 命令要点：`ls -1 /check | wc -l`（220 个条目）+ 按 PV uid 前缀对 5 个目标 grep：`89121e22`（验收项目 PV `pvc-89121e22-13f9-4c37-a6ad-981d079612e2`）、`d6b6bc54`（在卷 data-mysql-0，阳性对照）、`3d0c413c`（已删 6839f32c）、`11d48b0e`（已删 ddaca1c0）、`29ec5a5e`（已删 2a39726e）。
- **结论**：验收项目 PV `pvc-89121e22…` 对应子目录在 NFS export 中 **ABSENT（hits=0）**，且无 `archived-…pvc-89121e22…` 归档条目——`manao-poc4-delete`（`onDelete: delete` + `reclaimPolicy: Delete`）在 NFS 文件系统层面为真删除、无归档残留。阳性对照成立：在卷 PV `pvc-d6b6bc54…` 目录存在（`manao-stage6b-data-mysql-0-pvc-d6b6bc54-…`）；另三个已删项目 PV（`3d0c413c`/`11d48b0e`/`29ec5a5e`）均 ABSENT（hits=0）。export 根条目命名形如 `<namespace>-<pvcName>-<pvName>`（nfs-storage 类的删除归档条目带 `archived-` 前缀，与两 SC 参数差异一致）。

## 6. Task 6 验收结果（2026-09-19，文档定稿与阶段汇总）

- [x] 结果：PASS。交付/定稿两份正文文档并建立入口链接（索引只链接、不复制正文）：
  - **`poc4/deploy/6b/README.md`（部署与维护）**：新增 §0「已验收版本基线」（分支/构建 commit、backend `sha256:ac88b11b…`（tag `6b-backend-20260918c`）/frontend `sha256:887c2e9f…`（tag `6b-frontend-20260918b`）/MySQL 8.0.40/三个平台镜像 digest/namespace/公网入口）；新增 §9「Day-2 运维」（执行位置说明、后端维护重启 scale 0→1 约 57s、mysql-0 StatefulSet 重建保留 PVC 约 35s、项目 UI 删除与 DELETING → Continue deletion 续作、数据位置表）；§4 修正 MySQL PVC 名（`data-mysql-0`，原笔误 `mysql-data`）并补公网入口冒烟检查（200/401 实测值）；Files 表修正 frontend.yaml 实为 NodePort 30080、configmap.yaml 说明。配套资产修正：`configmap.yaml` 按其自身注释回填定稿值 `MANAO_WS_EXTRA_ORIGIN: http://1.12.245.235:30080`（与集群 live 一致，消除空占位导致重部署不可复现的缺口）。凭据不出现在任何文档。
  - **`poc4/docs/evidence/stage-6b/acceptance.md`（本文件）**：§4 子节重编号消除 4.1/4.2 重号（原 §4.2 下保留的 4.1–4.5 改为 4.2.a–4.2.e，§2.1 交叉引用同步）；§5 结束时间按 task-5 报告统一为 01:57–02:12；§5.6 NFS 直查行由「未直接执行」改为引用 §5.8 补查结论；§5.8 新增 NFS 目录直查补记；本节与 §7 阶段汇总。
  - **入口链接**：`poc4/frontend/README.md` 与 `docs/what-we-have-done.md` 各新增 6B 状态小节，链向上述两份文档（仓库内相对路径）；不重复部署步骤或验收明细，6A 历史事实原文保留。
- [x] 临时文件清理（gitignored 路径，先盘点后删除，无运行时资源被删）：
  - 删除 `.superpowers/sdd/2026-09-18-stage6b-cloud-workbench-implementation-plan/tmp/t5-verify-ui.cjs`、`tmp/t5-delete-ui.cjs`（Task 5 临时 Playwright 脚本；方法与选择器策略已记录于 §5/§5.5 及 task-5-report.md，无未解决失败需要脚本佐证）。
  - 删除 `poc4/frontend/test-results/`（内容为 `.last-run.json`（status=passed）+ 3 个空目录；§4.1/§4.2 所列失败工件实际已被后续重跑的 Playwright outputDir 机制清空（§4.0 已记录），无未解决失败证据需要保留）。
  - 保留不动：`.superpowers/sdd/…/` 下的 task brief/report、review diff、未知镜像诊断 JSON（a57*/b57*，§2.1 事件原始记录）、progress.md；`.superpowers/sdd/2026-08-27-*/` 旧计划目录。
- [x] NFS 目录直查补查（controller 批准的有界诊断）：结论与命令摘要见 §5.8——验收项目 PV 子目录在 NFS export 中 ABSENT，§5.6 该项缺口关闭。

## 7. 阶段验收汇总（B1–B6）与 STAGE6B_MVP_CLOUD_PASS

### 7.1 逐项状态

| 编号 | 状态 | 证据（本文件小节） |
| --- | --- | --- |
| B1 无本机运行依赖，从公网 IP 登录并完成完整流程 | **PASS** | §4.0（E2E 6 test 全程仅浏览器 + `http://1.12.245.235:30080`；创建→编辑→两次真实运行→持久化复核；开窗 netstat 实测本机无 5173/18080 监听） |
| B2 同一界面完成创建、编辑保存、真实失败反馈、修复运行成功、再次编辑 | **PASS** | §4.0 test 3–5（真实 FAILED + `cannot find symbol`/`missingSymbol` 编译反馈 → 修复运行 SUCCEEDED + 成功输出 → 终态后再次编辑保存） |
| B3 日志实时到达，终态与真实 Run/Job 一致；刷新或重新登录可查看持久化内容 | **PASS** | §4.0（Run logs 实时；终态与 API 记录、集群 Job `Complete 1/1`/`Failed 0/1` 三方一致；test 6 刷新与退出重登后项目/文件/run 历史/revision 全部保留）；§5.2/§5.3 重启后已落库日志可读 |
| B4 最后手动删除回收同一验收项目的应用记录和资源；不假成功与显式续作；故障验证按触发条件执行 | **PASS** | §5.5（浏览器 UI 删除，DELETE 204、列表消失、reload 不复现）+ §5.6 独立核对表 + §5.8 NFS 目录直查（子目录 ABSENT、未归档）。删除故障注入测试 **SKIPPED**（触发条件未满足，§5.4）；「不假成功/Continue deletion」行为保留在代码中（6A 已验收），本轮未再触发 |
| B5 分别正常重建一次后端和 MySQL 后，已保存数据仍可用且能再次运行 | **PASS** | §5.2（scale 0→1 约 57s；run `dbeff9c3` SUCCEEDED）+ §5.3（mysql-0 重建约 35s、PVC 保留；run `5f129f49` SUCCEEDED）。workspace Pod 主动删除测试 **SKIPPED**（触发条件未满足，§5.4；09-18 23:33 集群集体重启已自然验证工作区恢复）；不承诺活动 Run 中断无损续接 |
| B6 单用户可按文档完成部署和维护；固定版本、账号初始化、存储与入口限制记录完整 | **PASS** | §6（本任务）：`poc4/deploy/6b/README.md` 给出镜像构建/发布（§1/§8.1）、私有配置与账号初始化（§2/§3）、应用顺序与健康检查（§4/§8.2）、公网地址（§0/§8.3）、停止/恢复与 Day-2 运维（§9）、数据位置（§4/§9.4）、入口限制（HTTP 明文，§0/§8.3）；固定版本基线见 §7.2；凭据不入库不入报告 |

条件测试汇总：workspace Pod 主动删除、删除故障注入均 **SKIPPED**（触发条件未满足，§5.4），不计作 PASS；按计划 §6.2 不阻塞本轮交付。

### 7.2 构建与验收标识汇总

| 项 | 值 |
| --- | --- |
| 分支 | `codex/poc4-stage-6b` |
| 验收记录基线 commit | `7706a15`（Task 5 收尾；backend 镜像源码 commit `d1fad6d`，§2.2；Task 6 文档定稿随本提交） |
| backend 镜像 | `chocologic/manao_images_repository@sha256:ac88b11b38096da9fd3056f264782fecd18f3d5a560f5cf3a4ddd670dd5609cf`（tag `6b-backend-20260918c`） |
| frontend 镜像 | `chocologic/manao_images_repository@sha256:887c2e9f9b9594d08c96a90d2e1fa4175bd6431e22479b647453583eb2e2699e`（tag `6b-frontend-20260918b`） |
| MySQL | `mysql:8.0.40`（tag 固定；digest 硬化留运维执行，README §mysql.yaml 注释） |
| 平台镜像（digest 钉定） | workspace agent `sha256:bb0dd43023e02ec50738c76656f9319d8949ef5911a8f8bf668d4bb007ae920c`、maven runner `sha256:6c93d34b317a98736d553d6891626471ff02578317c7358fbc140cb5ac957f0c`、initializer `sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662`（§1.7） |
| PUBLIC_ORIGIN | `http://1.12.245.235:30080`（NodePort，HTTP 明文——传输限制单独记录，见 §3「公网入口定稿」与 §7.3） |
| 验收项目 | `stage6b-cloud-20260918173926-c6bn`（projectId `da577551-0ee9-4d95-8f03-16225625c589`，已删除） |
| broken / fixed run | `8ee1a7f5-a913-42f3-8b88-7e1c9067a372`（FAILED/BUILD_FAILED）/ `1776cb9b-de9f-46a3-927d-3119f2ac47c3`（SUCCEEDED/BUILD_SUCCEEDED），§4.0 |
| 持久化验证 run | `dbeff9c3-84ff-4c1a-98fa-68282173b577`、`5f129f49-8d5c-420c-be97-f2b4df813307` 均 SUCCEEDED（§5.2/§5.3，随项目删除一并回收） |
| 时间线（+08:00） | Task 1 环境检查 09-18 13:48 起 → Task 2 部署 16:20–16:58（记录 17:00）→ Task 3 17:05–17:20（记录 17:30）→ Task 4 最终轮 09-19 01:39:24–01:42:14（历史轮 23:44 / 00:23 / 01:25 / 01:33 见 §4.2/§4.1/§4.0）→ Task 5 01:57–02:12 → Task 6 09-19 文档定稿 |
| 实际清理结果 | 验收项目及全部临时项目（`6839f32c`/`ddaca1c0`/`2a39726e`/`5d192f57`/`049b4aa6`）经真实 API/UI 删除：workspace Pod/Service/initializer/Job/PVC 消失、PV 对象回收，其中 4 个 PV 在 NFS export 层直查 ABSENT（§5.8）、DB 七张关联表逐表 COUNT=0、project 全表 0 行（配额 0/8）；MySQL 卷 `data-mysql-0` 保留 Bound；`manao-stage6-test` 旧资源未触碰 |

### 7.3 STAGE6B_MVP_CLOUD_PASS

**STAGE6B_MVP_CLOUD_PASS**（2026-09-19，Task 6 记录）：

- B1–B6 全部 **PASS**（§7.1），必需项与已触发条件项均有当前部署的通过证据；两项条件测试 **SKIPPED**（触发条件未满足，§5.4），按计划 §6.2 不阻塞交付、不宣称通过。
- 边界（如实记录，不虚构安全或可用性认证）：公网入口为 **HTTP 明文**（NodePort 30080，无 TLS 终止），登录凭据与 JWT 随公网明文传输——HTTP 明文传输限制单独记录于 §3「公网入口定稿」；HTTPS 待复用既有服务器入口后启用，届时同步更新 `MANAO_WS_EXTRA_ORIGIN`。资源配额沿用 6A「8 项目」运行事实（本轮配额读数身份 Forbidden，§1.4/§1.5）；kubectl 客户端 1.34 对服务端 1.31 的偏斜告警为已知事实（§1.2）。
- 停止扩张规则（计划 §6.2）：首次闭环已达成，后续仅修 B1–B6 违例；无新失败证据不扩展全量故障矩阵、PTY 压力、自动清理器、多副本或新平台组件。

## 8. 登录有效期配置更新（2026-09-20）

- 用户要求：将当前 6B 登录过期自动退出时间改为 24 小时。
- 修改前实测：公网登录接口签发的 JWT 有效期为 900 秒（15 分钟）；Deployment 未设置 `MANAO_JWT_LIFETIME`，采用后端默认值。
- 配置变更：`poc4/deploy/6b/backend.yaml` 显式设置 `MANAO_JWT_LIFETIME=24h`，配置模板与 README 同步；沿用现有后端镜像和签名密钥。
- 部署：仅更新 `manao-stage6b` 的 `deployment/backend` 对应环境变量，经 Recreate 完成替换；generation/observedGeneration 均为 9，readyReplicas=1。修改前项目列表为空，未发现活动 Job。
- 公网核验：2026-09-20T05:20:38Z 的登录响应为 HTTP 200，`expiresAt=2026-09-21T05:20:38.913402377Z`；JWT `exp` 与响应到期时间一致，有效期 86,400 秒；新令牌访问项目列表为 HTTP 200。
- 本地验证：`pnpm exec vitest run src/features/auth/authSession.test.ts src/features/auth/LoginPage.test.tsx`，2 个测试文件、19 项测试通过；部署清单 client dry-run 和环境变量 server dry-run 通过。
- 生效语义：从重新登录时起算绝对 24 小时，不是闲置超时；旧令牌保持原到期时间。浏览器继续使用内存会话，刷新或关闭页面后仍需重新登录。
- 证据边界：本次仅验证配置加载、实际签发期限、鉴权访问和现有登录回归；未等待真实 24 小时，也未重跑完整 B1–B6 验收。此前验收记录保持原证据范围。

## 9. 2026-09-20 当前部署复测（13:43–13:54 +08:00）

**本次结论：B1–B5 核心功能复测通过；B6 当前版本与交付文档不一致，记为 FAILED（文档版本一致性），暂不为当前部署重新签发 `STAGE6B_MVP_CLOUD_PASS`。** §7 的 2026-09-19 验收作为历史事实保留，不把旧镜像的验收记录直接当作本次部署的完整证据。未修改业务实现或替换镜像。

### 9.1 范围、基线与结果

- 本地分支 `codex/poc4-stage-6b`，HEAD `e47b0500397aae54b263debd654054daa23178b7`。开始前已有 README/backend.yaml/config.example.env/本文件的 24h 登录配置改动及未跟踪计划文档；均原样保留。本次仅追加验收记录与脱敏证据。
- 公网业务入口仍为 `http://1.12.245.235:30080`；测试前后本机 4173/5173/18080/6443 无监听。没有启动本地前后端或桥接，管理检查直接使用私有 kubeconfig。节点 master/node1/node2 均 Ready，集群前端、后端、MySQL 均 Ready。
- 开始时当前账号项目列表为空。仅新建下述一个项目；重启前核对无活动 Run/Job；后端 scale 0→旧 Pod 消失→scale 1 **仅一次**，MySQL 保留 PVC 正常重建 **仅一次**。

| 检查 | 本次实测结果 |
| --- | --- |
| B1/B2 公网完整开发生命周期 | **PASS**：现有 `pnpm --dir poc4/frontend test:e2e:stage6b`，6/6 通过，约 1.9 分钟；创建 READY、编辑保存、真实编译失败、修复成功、终态再次编辑、刷新/重登持久化全部完成 |
| B3 状态、日志和持久化 | **PASS（按同一个选中 Run 核对）**：编译失败/成功 UI 与 API、Job Failed/Complete 对应；重启后逐条打开历史日志可读；补充浏览器验证收到 WebSocket 帧，HTTP 请求仅访问公网 origin。历史选择后的新运行不自动切换，见 §9.3，不把旧 Run 的 SUCCEEDED 当作新 Run 成功 |
| B4 UI 删除和独立清理 | **PASS**：Delete project → Delete permanently → HTTP 204，刷新重登后卡片消失，GET 项目 404；该项目 initializer/workspace/Job/Service/PVC 无残留，PV 已不存在；七张关联表 scoped COUNT 均为 0；NFS 对应 PV 目录及归档匹配均为 0，MySQL 目录阳性对照存在 |
| B5 后端/MySQL 重建 | **PASS**：后端约 21.5 秒、MySQL 约 33.4 秒；UID 变化、revision=25 和文件 SHA-256 不变、既有历史及日志保留；两次维护后分别从 UI 启动一次新 Run，均 SUCCEEDED / Job Complete；MySQL PVC UID/PV 不变 |
| B6 部署文档与当前版本 | **FAILED（版本记录不一致）**：README §0 和本文件 §7.2 的前端 digest 为 `887c2e9f…2699e`，live Deployment 为 `a1915ebb…fbf86`；交付记录未包含当前前端镜像的构建 SHA 对应关系。不能声称按现有 README 能重建本次受测前端。后端 digest 与文档一致 |
| 最新前端修改的本地回归 | **PASS**：5 文件 / 137 测试；`pnpm typecheck` 通过。仅证明本地 HEAD 对应测试，不把它当作 live 镜像源码映射证明 |
| workspace Pod 主动删除 / 删除故障注入 | **SKIPPED**：相应后端恢复/删除代码与存储策略未变化，本次无恢复/删除异常，不触发条件测试；不计作 PASS |
| 全量后端/前端测试、PTY 压力及完整故障矩阵 | **NOT_REVERIFIED**：不属于本次必需验收范围，没有扩大执行 |

### 9.2 可追溯对象与当前镜像

- 项目：`stage6b-cloud-20260920054331-rk63`，`60ca4205-a333-486b-912e-51098126144d`（本次最终已删除）。
- 编译失败 Run：`2dd28ff7-88e5-45a2-821b-2d1094cc529e`，FAILED / BUILD_FAILED，revision 23。
- 修复成功 Run：`8a23d836-1052-426e-89db-91b0dfffb2d8`，SUCCEEDED / BUILD_SUCCEEDED，revision 24。
- 后端重启后 Run：`878e3440-3ddf-4aa7-8f5c-a5fc31f29fe5`；MySQL 重建后 Run：`211686da-9c7d-4857-ba43-3971ec8dea40`；均 SUCCEEDED / BUILD_SUCCEEDED，revision 25。
- live backend：`chocologic/manao_images_repository@sha256:ac88b11b38096da9fd3056f264782fecd18f3d5a560f5cf3a4ddd670dd5609cf`。
- live frontend：`chocologic/manao_images_repository@sha256:a1915ebbfbf17dd2b4e7e4f7bd4a65422021317ee199c4e8b3160bd7d5afbf86`。
- 已回收项目 PV：`pvc-95cbc27e-f24e-49a1-966c-4e799c922283`；保留 MySQL PVC `data-mysql-0` → `pvc-d6b6bc54-6e34-4bac-9897-436cf9e84cb3`。
- 关联表独立检查：`project`、`run`、`workspace_operation`、`log_ticket`、`terminal_audit`、`terminal_session` 按本项目 ID；`run_log_chunk` 按上述四个 Run ID；均 0。未重置 schema，未清理其他项目或已有资源。

### 9.3 新观察与测试过程异常

**历史 Run 选择后的显示行为：** 查看历史 Run 后再点 Start run，面板继续选中历史 Run，不自动跟随新 Run。本轮记录到新 Run `211686da…` 为 STARTING 时，面板选中的仍是历史 `8a23d836…`，其状态 SUCCEEDED；手动选择新记录后，状态、日志及最终结果均正常。此为显示/选择体验观察，不等同后端把新 Run 误记为成功；若产品预期 Start run 自动切到新运行，应单独修复并回归。代码位置为 `RunPanel.tsx` 的 `onSelect`/`followActiveRef` 与 `onStart`，本次未改。

补充验证脚本第一次在后端重启后将“当前选中的历史 UI 状态”与“最新 Run API 状态”跨 ID 对比，触发 `API run disagrees with UI`。核查已有 Run 和 Job 后确认该新 Run 实际成功，属于补充脚本断言对象错误，原失败保留在 runtime.json。随后改为绑定具体 Run ID，沿同一项目继续验证，**未重复后端重启、未重放该 Start 请求**。MySQL 阶段另记录上述选择行为，并显式选择新 Run 后检查 UI/API/Job。

### 9.4 命令、证据与收尾

本地新增变更针对性回归命令（在 `poc4/frontend`）：

```powershell
pnpm exec vitest run src/components/files/FileTree.test.tsx src/features/files/fileMutations.test.ts src/features/files/fileQueries.test.ts src/features/projects/ProjectsPage.test.tsx src/features/runs/workspaceReload.test.ts
pnpm typecheck
```

云端生命周期使用现有 `playwright.stage6b.config.ts`，从私有 env 注入 `MANAO_6B_USERNAME/MANAO_6B_PASSWORD`，显式设置公网 `MANAO_6B_BASE_URL`；维护/删除通过一次性脚本复用相同 UI 选择器并以 API、kubectl、只读 SQL 佐证。无凭据进入报告。

证据：[生命周期执行日志](recheck-20260920/lifecycle.log)、[维护及关联资源原始脱敏记录](recheck-20260920/runtime.json)、[NFS 只读直查](recheck-20260920/nfs-cleanup.json)、[本次结果汇总](recheck-20260920/summary.json)。

实际收尾：本次一个项目及四个 Run 的资源/记录已回收；只读 NFS 检查临时 Pod 已删除；平台前端/后端/MySQL 仍 Ready。本地一次性验证脚本与成功测试临时目录的删除命令被执行策略拦截，尚未移除；只残留私有目录 `Project_Manao_kubeconfig/verification-20260920-stage6b` 内的验证脚本、45 字节 `.last-run.json` 和空测试目录，不含本轮失败 trace。上列脱敏证据另行保留。未执行 commit/push，未改业务代码或更新部署 README 的镜像基线。

**下一步最小闭环：** 核实 `a1915ebb…fbf86` 的构建源码 SHA，并同步部署 README 和现行验收镜像记录，关闭 B6 文档差异；历史选择后启动新 Run 的交互行为单独处理，不以重跑整套测试代替修正文档。

### 9.5 B6 闭环：live 前端镜像的构建源码核实与文档同步（2026-09-20）

9.4 的最小闭环在本节完成（记录时间 2026-09-20 14:30 前后，+08:00）。

**a1915ebb 的构建源码 SHA 证据链（全部来自本仓库会话的操作记录与当次命令输出）：**

| 环节 | 证据 |
| --- | --- |
| 构建源码 | 分支 `codex/poc4-stage-6b`，构建时 HEAD `e47b0500397aae54b263debd654054daa23178b7`（commit 时间 2026-09-19 16:51:26 +08:00，"align busy-read retry with spec and surface exhausted-refresh errors"）；构建时工作树 tracked 文件干净（仅未跟踪的 6B 计划文档） |
| 构建时间与产物 | 镜像 config `created: 2026-09-19T08:58:07Z`（=16:58:07 +08:00），晚于 e47b050 提交 7 分钟；由控制器会话按 README §8 在本工作树 `docker build` 上下文 `poc4/frontend` 构建 |
| 发布与部署 | 2026-09-19 推送 tag `6b-frontend-20260919`；本日复核 Docker Hub：该 tag 的 `docker-content-digest` = `sha256:a1915ebbfbf17dd2b4e7e4f7bd4a65422021317ee199c4e8b3160bd7d5afbf86`，与集群 deployment/Pod 及 §9.1 live 记录逐字一致 |
| 行为一致性 | 公网 bundle `index-D_UcSSSm.js` 与本地同源构建（16:49，工作树同 HEAD）均含 e47b050 修复标记（`Project update failed`、`Project is no longer available`、`refetchOnWindowFocus:!1`）；本地/容器 bundle hash 不同属 Vite 内容寻址在不同构建环境下的正常差异（Task 3 曾披露同一现象） |
| 运行验证 | §9.1–9.2 的云端生命周期 6/6、backend/MySQL 重建持久化、删除与清理核对均在该前端版本上完成（`summary.json` head 字段 = `e47b0503…`） |

**结论：** `a1915ebb` 即源码 `e47b050` 的构建产物，本轮（2026-09-19）窗口切回风暴修复的部署版本。2026-09-18 基线中 frontend `887c2e9f…e2699e`（源码 `e948b1a`）的记录保留为其当时验收轮的历史事实，不再描述当前 live。文档同步：`poc4/deploy/6b/README.md` §0 已更新当前 live digest 并在 §8 部署命令后新增"发布新前端镜像后必须同步 §0 与验收记录"的要求；`backend.yaml`/`config.example.env` 固化 `MANAO_JWT_LIFETIME=24h`（与 live 运行配置一致的资产化）。B6 文档差异就此关闭；本轮修复的验收状态汇总为：本地 1193 测试 + 构建通过、部署生效、§9 云端生命周期通过；真实原生 Alt-Tab 复测仍待用户执行。

## 10. Stage 6B 阶段关闭与集成决定（2026-09-20）

**当前阶段结论：`STAGE6B_MVP_CLOUD_PASS`；用户已明确确认 6B 到此结束，授权将 `codex/poc4-stage-6b` 合并回 `master` 并推送。**

- 验收依据：§9 的本次 B1–B5 真实云端复测，加上 §9.5 的 B6 版本记录闭环。合并前再次只读查询 live frontend Deployment，其完整 digest 与已修正的 README §0 一致（`sha256:a1915ebbfbf17dd2b4e7e4f7bd4a65422021317ee199c4e8b3160bd7d5afbf86`）。源码构建对应关系沿用 §9.5 已留档证据，本次不重建镜像。
- §9 开头及 `recheck-20260920/summary.json`、`runtime.json` 的 B6 FAILED 是修正文档前的原始检查快照，保留不篡改；当前阶段判定以本节和 §9.5 为准。
- 本次集成前相对已复测源码 `e47b050` 的变化为文档、证据及已部署的 JWT 24h 配置资产化，没有新增业务代码，因此不重复生命周期、重启和全量测试；执行文档/digest 对账、证据编码与凭据检查、Git diff/合并完整性检查。
- 补充纳入版本控制的 `recheck-20260920/lifecycle.log` 是 §9 的既有脱敏 6/6 测试输出，此前被通用 `*.log` 规则忽略；不是新的测试运行。
- 历史 Run 选中后的新 Run 不自动切换、原生 Alt-Tab 复测等观察仍保持其原始证据范围，不把用户阶段关闭转换为这些项目技术测试通过。未触发条件测试仍为 SKIPPED，未复测工程项仍为 NOT_REVERIFIED。
- 集成已完成：收尾提交 `5059ab2`，合并提交 `860cdda`，已推送并核对 origin/master 与本地 SHA 一致；未修改运行部署或再次创建测试资源。6B 分支和工作树保留供历史追溯。
