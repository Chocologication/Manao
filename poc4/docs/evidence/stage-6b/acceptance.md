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

**RBAC 修复（控制器已裁决）**：`poc4/deploy/6b/backend-rbac.yaml` 的 Role `manao-backend-workload` 对 `batch/jobs` 增加 `patch` 动词（原 get/list/watch/create/delete 保持不变，未添加其他资源），apply 生效（Role configured，RoleBinding/ClusterRole/ClusterRoleBinding unchanged）。实证：`kubectl auth can-i patch jobs.batch -n manao-stage6b --as=system:serviceaccount:manao-stage6b:manao-backend` → **yes**（get/list/watch/create/delete 逐项复测均 yes）。该修复直接消除 §4.3/§4.4（09-18 23:44 轮）记录的 Start run 即 START_FAILED 根因；该事件对后续 E2E 的影响见 §4.0。

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

## 4. Task 4 验收结果（阶段 B：真实公网 E2E 生命周期验收——两轮重跑均未通过）

- **结果：NOT PASSED（BLOCKED）。最近一轮（2026-09-19 00:23，事件处置与 RBAC 修复之后）：Playwright 实测 `1 failed / 5 did not run`（exit 1），失败根因为新实测缺陷——已验收镜像 `5708a4b7…` 的 jar 缺少 `workspace-template/.gitignore` 打包资源，项目 provisioning 必然失败（见 4.0）。此前一轮（2026-09-18 23:44）：`2 passed / 1 failed / 3 did not run`（13.9m），根因为 RBAC 缺 `patch`（已修复并验证，见 §2.1）。两轮均按规程如实记录、不掩盖、不放宽。**

### 4.0 事件处置后重跑（2026-09-19 00:23–00:33 +08:00）——当前唯一有效验收记录

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
- **处置：BLOCKED（待控制器裁决）**——修复路径：提交打包修复 → 本机构建并推送新 backend 镜像（本机 Docker daemon 实测可用，server 29.3.1）→ 部署新 digest → 从头重跑 6 test 场景（新项目名/新 run id）。按规程，未获授权不自行构建/推送/部署镜像。未知镜像事件见 §2.1；B1–B3 缺口见 §7。

### 4.1–4.5 前一轮记录（2026-09-18 23:44，RBAC 根因——已修复）

> 以下 4.1–4.5 为 09-18 23:44 轮的原始记录，保留作历史证据；其根因（Role 缺 `patch`）已于 09-19 修复并验证（§2.1），该轮遗留项目 `6839f32c…` 已于 09-19 00:22 经公网 API 删除（见 4.0 前置）。

- 记录时间：2026-09-18 23:59 (+08:00)；E2E 窗口 23:44:44–23:58:41 (+08:00)；残留清理窗口约 23:40–23:43 (+08:00)
- 执行者：Task 4 阶段 B 重跑（第一次 Task 4B 运行因集群问题被用户中断，本轮为如实重跑）

### 4.1 运行前环境与残留清理（实测）

- 公网入口：`GET http://1.12.245.235:30080/` → 200；登录探针（不存在用户）→ 401。本机 Vite/Spring Boot 未运行；本机 MySQL 保留运行（用户豁免，其他业务在用），E2E 全程仅浏览器 + 公网入口。
- 集群恢复观察（admin kubectl，只读）：backend/frontend/mysql-0 均 Running；**全部容器在 23:33 前后（+08:00）集体重启**（startup BackOff 后恢复，属集群重启恢复尾部），本轮 E2E 全程平台无再重启。
- **backend 镜像变更记录**：当前 backend Pod 镜像 `sha256:a57da658…defe314e`（Pod 约 19:13 +08:00 重建，即第一次中断运行期间/之后被重新部署），与 Task 2 记录的 `sha256:5708a4b7…edd5fa` 不同；frontend 仍为 Task 3 的 `887c2e9f…e2699e`。该变更为运行环境事实，本轮未改动。
- **中断残留清理（额外的一次真实 API 删除验证）**：第一次中断运行遗留两个 `stage6b-cloud-*` 项目（均 app_user 所有）：
  - `3bbc74ae-36b1-4fec-b5af-3fe7884990a9`（`stage6b-cloud-20260918094433-flhm`，state FAILED，集群内已无任何 workspace 资源）；
  - `ddaca1c0-f8fb-403a-8d4f-e53deeff70ea`（`stage6b-cloud-20260918111018-ax9s`，state READY，workspace Pod/Service Running、PVC Bound）。
  - 以 app_user 经真实公网 API 路径逐个 `DELETE /api/v1/projects/{id}` → **两个均 HTTP 204**；GET 列表 → `items: []`；GET 单项 → 404 `ENTRY_NOT_FOUND`。
  - admin kubectl 核对：`manao-ws-ddaca1c0-*` Pod/Service 消失、`manao-pvc-ddaca1c0-*` PVC 消失、对应 PV `pvc-11d48b0e-…` 已 NotFound（`manao-poc4-delete` Delete 回收策略实测生效）；无残留 Job。删除链路 API→DB→K8s→PV 全链路实测通过。
- admin kubectl 通道事实：用户侧 127.0.0.1:6443 本地转发本轮不可用；实测集群 API 公网端点 `https://1.12.245.235:6443` 可达（证书 SAN 含 127.0.0.1，不含公网 IP），在私有目录（不入库、不提交）建立 admin kubeconfig 副本以继续只读观察。

### 4.2 E2E 实测结果（`pnpm --dir poc4/frontend test:e2e:stage6b`，env 注入凭据）

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

### 4.3 失败根因（实测证据链）

1. UI 侧：点击 Start run 后 `POST /api/v1/projects/{id}/runs`（body `{"expectedWorkspaceRevision":"23"}`）→ **HTTP 503** `{"code":"INTERNAL_ERROR","message":"Request failed","traceId":"fcef2f71-2b7a-48dc-984e-51af4fc35fd1"}`（Playwright trace network 实录）。前端 `Run state` 状态元素停留在 "Idle"，测试等待 780s 后失败。
2. DB 侧（API 只读核对）：run `d2460769-…` 于 `15:45:12.225633Z` 创建、`15:45:12.266381Z` 即终态（**40ms**），`state=FAILED`、`terminationReason=START_FAILED`、无日志。revision 校验本身通过（23 匹配）——即 RunService 在 `ensureJob` 抛异常后 settle START_FAILED 并回 503 的路径。
3. K8s 侧：Job 从未创建（无对象、无事件）。
4. 后端日志：15:45:12Z 前后**零日志**——`RunService.startLocked` 的 catch 分支静默吞掉异常（无 LOG 语句），故障不可观测（伴生缺陷）。
5. 直接原因（实测）：`Fabric8JobCoordinator.ensureJob` 对 Job 使用 **`serverSideApply()`（PATCH）**（自 `301a8e6` 引入），而 6B Role `manao-backend-workload`（仓库 `poc4/deploy/6b/backend-rbac.yaml`，commit `b4e181c`，与集群 live 一致）对 `batch/jobs` 只授 `get,list,watch,create,delete`——**无 `patch`**。实证：`kubectl auth can-i patch jobs.batch --as=system:serviceaccount:manao-stage6b:manao-backend` → **no**（`create` → yes）。对照：workspace Pod/Service/PVC 走 `Fabric8KubernetesGateway` 的 `.create()`（create 动词）全部成功——与「创建 READY 正常、Start run 即败」的现象完全一致。
6. 为什么 6A 未暴露：6A 本地集群 SA 对 `jobs.batch` 为全权（含 patch）；6B 部署资产在收窄动词时未对账代码实际使用的 PATCH 传输。

### 4.4 缺陷定性（BLOCKED 待裁决）

- **业务/部署资产缺陷**（非测试资产缺陷，测试选择器与等待行为正常且如实反映了用户可见结果）：修复方向二选一，均需裁决且按 brief「先加能复现问题的回归再修复」：
  1. RBAC 侧：`poc4/deploy/6b/backend-rbac.yaml` 为 `batch/jobs` 增加 `patch`（若保留 serverSideApply 传输）；
  2. 代码侧：`Fabric8JobCoordinator.ensureJob` 改为 `.create()`（若维持最小 RBAC）。
  - 伴生问题（同批裁决）：`RunService` catch 路径无日志（故障静默）；START_FAILED 时前端 Run state 停留 "Idle"、用户得不到任何可见反馈（本次测试失败的直接表现）。
- 裁决与修复后需**从头重跑完整 6 test 场景**（新项目名、新 run id），本轮项目与记录不作为通过依据。

### 4.5 B1–B3 证据对应（Task 4 范围）

- **B1（无本机依赖、公网完成流程）**：部分成立——登录、创建、READY、编辑保存全部经公网入口真实 UI 完成（test 1/2 passed），本机应用依赖为零；「完整流程」因 B2 阻塞未完成，不宣称通过。
- **B2（同一界面完成创建/编辑保存/真实失败反馈/修复运行成功/再次编辑）**：**失败证据在案**——创建、编辑保存已过；「真实失败反馈」环节后端 Start run 即 START_FAILED（40ms、无 Job、503），前端无任何失败反馈（Run state 停留 Idle），后续修复运行/再次编辑均未执行。
- **B3（日志实时、终态与 Run/Job 一致、刷新与重登持久化）**：未执行（serial 中断），无证据。

## 5. Task 5 验收结果（占位）

- [ ] 结果：待填

## 6. Task 6 验收结果（占位）

- [ ] 结果：待填

## 7. B1-B6 缺口清单（占位）

- [ ] B1：部分成立（Task 4 §4.0/§4.5：两轮均实测登录/创建经公网真实 UI 完成；09-18 23:44 轮另实测 READY 与编辑保存；「完整流程」两轮均被后端缺陷阻塞，不宣称通过）
- [ ] B2：两轮未走通（09-18 23:44 轮：Start run 即 START_FAILED，前端无失败反馈——根因 RBAC 缺 `patch`，已修复验证（§2.1）；09-19 00:23 轮：项目 provisioning 即失败（§4.0），修复运行未执行）
- [ ] B3：未执行、无证据（两轮 serial 中断，Task 4 §4.0/§4.5）
- [ ] B4：
- [ ] B5：
- [ ] B6：
