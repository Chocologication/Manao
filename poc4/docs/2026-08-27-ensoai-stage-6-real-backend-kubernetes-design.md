# POC4 阶段六真实后端与 Kubernetes 集成设计

## 1. 文档状态

- 状态：设计已在对话中确认，采用本机优先双 profile；本文修订待用户审阅
- 日期：2026-08-27
- 基线：`master@521b4ec`，阶段五 active-job terminal 已完成
- 前端参考：`D:\DeepLearning\MyProjects\Enso_AI@5aa294a`
- 本阶段结论目标：先验证 6A 本机后端/本机数据库/本机前端经 SSH 隧道使用真实 Kubernetes 的链路，再验证 6B 同一后端以 Pod 部署；不把 mock 证据或单元测试写成生产级安全结论

本文是阶段六的设计说明，不授权直接编码。用户审阅通过后，另行编写逐任务实施计划；实施必须在从阶段五基线创建的隔离工作树中进行。

## 2. 目标与第一性原则

### 2.1 目标

在不破坏 POC4 已确认规则的前提下，交付并验证一个真实的 Spring Boot 后端。阶段六按两个 profile 顺序执行：

1. **6A 本机集成 profile**：Spring Boot 后端、本机 MySQL 和 Vite 前端都运行在开发机；后端的 Fabric8 Client 通过 SSH 本地端口转发访问真实 Kubernetes API，真实创建/观察 Job、读取日志并建立 PTY。项目文件通过后端管理的 `kubectl port-forward` 访问集群内 workspace Service，最终仍落到真实 RWX PVC。
2. **6B 集群部署 profile**：将同一后端构建产物以 Kubernetes `Deployment` 单 Pod 运行，切换到集群内 MySQL/Service，复用同一 REST/WebSocket 合同和状态语义，完成集群内后端验收。
3. 两个 profile 都使用真实 JWT、MySQL、RWX PVC 和 Fabric8 Kubernetes Client；6A 与 6B 的数据库不是自动互相复制的故障转移对。
4. 浏览器通过阶段五已经实现的 REST/WebSocket 合同访问后端；后端创建并管理 Maven Job，读取项目 PVC 中的源码，提供独立日志流和活动 Job PTY 终端。
5. 本机进程/Pod 重启、WebSocket 断开、SSH 或 workspace port-forward 中断、Job/Pod 状态变化和短暂依赖故障不会产生双活 Run、可复用旧 terminal session 或错误解锁编辑器。
6. 本阶段不部署前端静态 Pod 或 Ingress。6A 是首次真实部署入口，6B 是阶段六结束前必须完成的后端 Pod 部署验证。

### 2.2 权威事实分层

系统存在三个事实来源，任何模块都不能把其中一个冒充另一个：

| 事实 | 权威来源 | 允许缓存 | 不允许的推断 |
|---|---|---|---|
| 用户、项目、Run 业务状态、ticket、终端审计 | MySQL | 前端 Query、后端短期内存索引 | 不能仅凭 URL、浏览器状态或资源名授权 |
| 项目文件正文 | RWX PVC 的项目目录 | 前端编辑器模型 | 不能把 MySQL 内容当作文件正文 |
| Job/Pod 运行、日志和 exec 状态 | Kubernetes API 与 Pod 流 | 后端状态缓存、日志持久化窗口 | 不能把数据库 `RUNNING` 当作 Pod 仍然运行 |

浏览器只能看到不透明业务 ID、状态和经过筛选的内容。PVC 名、Pod 名、Job 名、Namespace、容器名、ServiceAccount、集群地址和绝对路径属于服务端内部事实，不能返回到浏览器。

## 3. 范围与硬边界

### 3.1 包含

- `poc4/backend` Spring Boot 模块化单体。
- 6A 本机 profile：本机 Spring Boot + 本机 MySQL + 本机 Vite；6B 集群 profile：同一后端镜像 + 集群 MySQL/Service。
- JWT 登录、用户所有权检查、统一 HTTP 错误包。
- MySQL Flyway migration、项目/Run/日志/ticket/terminal/audit 持久化。
- 通过内部 workspace API 操作 RWX PVC 上的文件树、内容、保存、创建、重命名、删除和 revision 校验。
- 固定 Java 17 + Maven 3.9 的 `mvn clean test` Job。
- Pod 日志持久化、最近 5 MiB 窗口、replay/live WebSocket 和七天清理。
- 当前活动 Maven Job 应用容器的 Fabric8 `pods/exec` PTY。
- 一次性日志/终端 ticket、单 live terminal session、resize、二进制输入输出、credit/ack 和关闭销毁。
- 结构化 terminal audit 的后端产生、分页、事务 settlement 和七天清理。
- 后端 Deployment、内部 workspace Pod/Service 模板、6A 本机 kubeconfig/RBAC 接入、6B ServiceAccount、namespace 级 Role/RoleBinding、Service、Secret/ConfigMap 引用、探针和镜像构建。
- 6A 本机 Vite 直连本机后端，并经 SSH API 隧道和 workspace port-forward 使用真实集群；6B 本机 Vite 经后端 Service port-forward 访问集群后端的真实浏览器 E2E。
- MySQL、Fabric8 mock/集成测试和受控 Kubernetes 集群验收。

### 3.2 明确不包含

- 前端静态 Pod、Ingress、域名证书或完整前端发布流水线。
- 多副本后端、高可用终端网关、Redis、消息队列或跨实例 session 协调。
- 工作区 Pod 对外暴露 Service/Ingress，或浏览器直接访问 PVC、Pod、Job、Kubernetes API。
- 用户提交 shell、command、cwd、env、image、container、Pod、PVC 或资源配置。
- 工作区 Pod Shell、非活动 Run Shell、Run 结束后的 Shell、任意容器选择。
- AI 能力、Git/Worktree、上传、拖拽、多人编辑、项目删除、计费和生产级恶意代码沙箱。
- 通过解析浏览器按键流伪造命令审计；无法由真实 wrapper 证明的命令边界不能标记为已审计。

## 4. 总体架构

```text
本机 Chrome/Edge
    |
    | http://localhost:4173/api/v1/*
    | ws://localhost:4173/api/v1/ws/*
    v
本机 Vite dev server
    |
    | 6A：Vite proxy -> 127.0.0.1:18080 -> 本机 Spring Boot
    | 6B：Vite proxy -> 127.0.0.1:18080 -> backend Service port-forward
    v
后端业务边界（6A 本机进程；6B backend Deployment，replicas=1）
    |-- Spring Security JWT / owner authorization
    |-- REST controllers + WebSocket handlers
    |-- MySQL datasource + Flyway
    |       |-- 6A：本机 MySQL
    |       `-- 6B：集群 MySQL Service
    |-- workspace Pod/Service coordinator
    |-- Fabric8 Kubernetes Client
    |       |-- 6A：SSH API tunnel -> Kubernetes API
    |       |-- 6B：集群内 Kubernetes API
    |       |-- Maven Job / Pod watch
    |       |-- Pod log follow
    |       `-- selected application-container exec PTY
    |-- 6A：workspace port-forward -> workspace ClusterIP Service
    |-- 6B：workspace ClusterIP Service -> workspace Pod -> RWX PVC（项目文件正文）
    `-- Maven Job Pod -> same project PVC（受控读写、/tmp 可写、无 K8s API）
```

6A 的本机后端不以 Pod 形式运行，但必须使用与 6B 相同的 namespace、标签、资源身份校验和业务合同。6B 后端固定为单副本，因为阶段六的目标是先证明状态和终端生命周期正确。Deployment 扩容不是本阶段能力；任何需要第二副本的发现都必须在 Stage 6 报告中记录为后续工作，而不能静默改变锁语义。

### 4.1 后端模块

```text
poc4/backend/src/main/java/com/manao/poc4/
├─ auth/          登录、密码哈希、JWT、当前用户
├─ project/       owner 校验、项目上限、项目状态
├─ workspace/     workspace Pod API、路径策略、文件 CRUD、revision
├─ run/           Run 状态机、项目锁、Maven Job 协调
├─ log/           Pod 日志窗口、seq、ticket、replay/live
├─ terminal/      ticket、单活 session、PTY、控制帧、关闭
├─ audit/         结构化命令审计、分页、settlement、清理
├─ kubernetes/    Fabric8 的唯一适配边界
├─ recovery/      启动扫描、DB/Kubernetes 对账、孤儿处理
├─ config/        配置绑定、Secret、健康组
└─ web/           REST、WebSocket、错误响应、requestId
```

Controller 只负责认证上下文、输入解析和响应映射。它不能直接调用 Fabric8、拼接 PVC 路径或写 MySQL 状态。所有跨模块操作通过服务接口和显式事务完成。`workspace` 服务只调用内部 workspace API；后端 Deployment 不挂载项目 PVC。

workspace Pod 只监听 namespace 内部 ClusterIP，不提供外部入口。后端到 workspace API 的每个请求携带 `X-Manao-Workspace-Capability`：`v1.<projectId>.<issuedAtEpochMs>.<nonceBase64Url>.<signatureBase64Url>`。签名算法固定为 Ed25519，签名输入为 `v1\\n<HTTP-method>\\n<request-path-and-query>\\n<SHA-256(request-body)>\\n<projectId>\\n<issuedAtEpochMs>\\n<nonceBase64Url>`；后端持有环境级私钥，workspace-agent 只注入公钥和自己的服务端项目 ID。agent 拒绝缺失/格式错误/项目不匹配/签名错误的 capability，允许的时钟偏差为 +/-60 秒，nonce 使用有界缓存保存 120 秒并拒绝重放。每次请求使用新的 128-bit CSPRNG nonce；私钥按 6A/6B 环境隔离并从受控 Secret 注入，绝不写入日志或浏览器。浏览器永远不能生成或看到该 capability。

项目创建顺序固定为：先在 MySQL 写入 `CREATING`，再创建项目专属 RWX PVC；随后用一次性 initializer Pod 以 PVC 根挂载创建服务端派生的项目目录、设置固定 UID/GID 和 `fsGroup`，等待 initializer `Succeeded` 后删除它；只有目录存在且权限检查通过，才创建带 `subPath` 的 workspace Pod 和 ClusterIP Service，等待 workspace Pod Ready 后调用内部 API 写入 Java 17/Maven 模板，最后将项目置为 `READY`。任一步骤失败，项目置为 `FAILED` 并记录脱敏原因；只删除本次创建且带有本项目标签、未被其他 Run 引用的资源，不提供用户侧项目删除入口。后端启动时扫描超时的 `CREATING` 项目：若资源身份完整且模板已写入则补偿为 `READY`，否则按同一标签执行幂等清理并置为 `FAILED`；`CREATING` 状态禁止文件、Run 和 terminal 操作。

### 4.2 技术基线

- Java 17。
- Spring Boot 3.5.9，与现有 `poc1/poc2` 基线一致。
- Spring Web MVC + `spring-boot-starter-websocket`，保持现有 POC2 的 WebSocket 运行模型。
- Spring Security，用服务器端密码哈希和 JWT 签发/验证。
- Spring Data JDBC，业务 SQL 和状态转换显式可见。
- Flyway，migration 从空 MySQL schema 可重复执行。
- Fabric8 Kubernetes Client 7.7.0，与现有 POC1/P2 基线一致；POC1/POC2 代码只作为 API 参考，不直接复用旧业务协议。
- 前端继续使用现有锁定依赖和 `pnpm`；阶段六不新增或升级 xterm 包。
- 6A 使用 Spring profile `local-cluster`：本机 MySQL、外部化 JWT/内部 capability 配置，以及指向 SSH 本地转发端口的 Fabric8 kubeconfig；6B 使用 `cluster` profile：集群内 MySQL、Secret 和后端 ServiceAccount。
- 6A 与 6B 的配置文件不提交凭据；仅提交 `.example` 配置和可审计的启动检查，真实路径、token、密钥和端口通过本机环境注入。

Spring Boot Actuator 提供 liveness/readiness health groups。Kubernetes 探针分别使用 `/actuator/health/liveness` 和 `/actuator/health/readiness`；liveness 不因 MySQL 或 Kubernetes API 临时故障触发重启，readiness 在关键依赖不可用时摘除 Service 流量。健康响应不得包含连接串、资源名或堆栈。

## 5. 数据模型与事务

### 5.1 表和关键字段

字段名以实现计划中的 migration 为准，以下字段是业务设计约束：

| 表 | 关键字段 | 约束/用途 |
|---|---|---|
| `app_user` | `id`, `username`, `password_hash`, `enabled`, `created_at` | `username` 唯一；不存明文密码 |
| `project` | `id`, `owner_id`, `name`, `state`, `workspace_revision`, `created_at`, `updated_at`, `failure_reason` | `state` 仅为 `CREATING/READY/FAILED`；每次查询带 `owner_id`；每用户最多 3 个项目；失败原因使用有限枚举，`WORKSPACE_RECONCILIATION_REQUIRED` 不与 state 拼接 |
| `workspace_operation` | `id`, `project_id`, `expected_revision`, `before_sha256`, `after_sha256`, `receipt_path`, `state`, `created_at`, `committed_at` | 文件写入两阶段凭据；`receipt_path` 只能是 agent 项目根下的固定相对路径，禁止绝对路径；`PENDING` 操作阻止新的写入，重启时与 agent receipt 对账 |
| `run` | `id`, `project_id`, `requested_revision`, `state`, `policy_json`, `job_ref`, `pod_ref`, `started_at`, `finished_at`, `exit_code`, `termination_reason`, `version` | locking state 单项目唯一；保存策略快照 |
| `run_log_chunk` | `run_id`, `seq`, `text_utf8`, `byte_length`, `created_at` | `(run_id, seq)` 唯一；总窗口不超过 5 MiB |
| `log_ticket` | `ticket_hash`, `user_id`, `project_id`, `run_id`, `expires_at`, `consumed_at` | 哈希存储；单次消费 |
| `terminal_session` | `id`, `project_id`, `run_id`, `user_id`, `state`, `ticket_hash`, `expires_at`, `consumed_at`, `pod_ref`, `container_ref`, `started_at`, `finished_at`, `exit_code`, `close_reason`, `version` | 单 Run 单 live session；资源引用只在服务端 |
| `terminal_audit` | `id`, `session_id`, `project_id`, `run_id`, `user_id`, `command`, `state`, `started_at`, `finished_at`, `exit_code`, `sensitive_detected`, `trust_level` | 结构化审计；不存 PTY 输出；命令敏感字段先遮蔽，可信度明确记录 |
| `instance_lease` | `id`, `holder_id`, `fencing_token`, `expires_at` | 单后端 authority；恢复/watch/清理/写操作必须携带当前 fencing token |

`job_ref`、`pod_ref`、`container_ref` 可以作为后端恢复所需的内部引用，但任何 DTO、错误、日志、HTML、截图或 WebSocket frame 都不得返回它们。资源引用必须由后端标签、ownerReference、固定容器名和数据库 Run 记录交叉确认后才能使用。

### 5.2 状态与原子性

Run locking states 为 `STARTING`、`RUNNING`、`STOPPING`、`RECOVERING`；这些状态都禁止编辑并阻止第二个 Run。终态为 `SUCCEEDED`、`FAILED`、`CANCELLED`、`TIMED_OUT`。

状态转换使用带版本或状态条件的更新：

```sql
UPDATE run
SET state = :next_state, version = version + 1, updated_at = CURRENT_TIMESTAMP
WHERE id = :run_id
  AND project_id = :project_id
  AND version = :expected_version
  AND state IN (:allowed_states);
```

更新影响行数为 0 时必须重新读取权威状态；不能靠重试同一个旧状态继续创建 Job、PTY 或审计记录。

创建终端 session 分两步：

1. 在事务内校验 JWT owner、项目 `READY`、当前 active Run 是同一项目且为 `RUNNING`，并以唯一约束拒绝第二个 live reservation；只写 ticket reservation，不创建 exec。
2. WebSocket 握手中以 ticket 哈希执行 `consumed_at IS NULL AND expires_at > now()` 的原子更新。只有更新成功才能通过 Fabric8 创建 exec；成功后写入 `terminal_audit(RUNNING)` 和 live session 状态。

Close、shell exit、Run stop、Run 离开 `RUNNING`、logout/401 清理都必须幂等。audit 只允许从 `RUNNING` 进入一个终态；重复 settlement 不改写第一次的结束时间和退出码。

### 5.3 日志窗口和清理

Pod 日志先写入 `run_log_chunk`，事务提交或明确持久化成功后才能推送给客户端。每次追加后淘汰最早 chunk，使保留窗口不超过 5 MiB，并累计 `evicted_bytes`。七天清理删除已过期的 log chunk、log ticket 和 terminal audit，不删除项目文件和仍有恢复引用的 Run 元数据。

## 6. REST 与 WebSocket 合同

### 6.1 REST 路径

后端实现以下阶段五既有路径，路径参数是 URL 编码的不透明业务 ID：

```text
POST   /api/v1/auth/login
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/{projectId}

GET    /api/v1/projects/{projectId}/files/tree
GET    /api/v1/projects/{projectId}/files/meta
GET    /api/v1/projects/{projectId}/files/content
PUT    /api/v1/projects/{projectId}/files/content
GET    /api/v1/projects/{projectId}/files/download
POST   /api/v1/projects/{projectId}/entries
POST   /api/v1/projects/{projectId}/entries/rename
DELETE /api/v1/projects/{projectId}/entries

GET    /api/v1/projects/{projectId}/runs/active
GET    /api/v1/projects/{projectId}/runs
GET    /api/v1/projects/{projectId}/runs/{runId}
POST   /api/v1/projects/{projectId}/runs
POST   /api/v1/projects/{projectId}/runs/{runId}/stop
POST   /api/v1/projects/{projectId}/runs/{runId}/log-ticket
GET    /api/v1/projects/{projectId}/runs/{runId}/terminal-audits
POST   /api/v1/projects/{projectId}/runs/{runId}/terminal-sessions
```

接口必须与阶段五的 TypeScript parsers 对齐：字段名、枚举、时间格式、分页 cursor 和状态组合不能由后端随意扩展。所有未知输入字段按严格白名单拒绝。

### 6.2 文件规则

- 只接受项目内相对路径；拒绝绝对路径、`..`、空路径误用和符号链接逃逸。
- workspace Pod 在 `/workspace/{derived-project-directory}` 下进行规范化，并对最终 real path 做根目录校验；后端只传项目范围相对路径和内部 capability header。
- `workspace_revision` 是 MySQL 唯一业务权威；agent 不维护可授权的本地 revision，只返回 `operationId`、写入前后 SHA-256 和原子写 receipt。保存先在 MySQL 写入 `workspace_operation(PENDING)`，agent 在 PVC 上以临时文件、`fsync`、原子 rename 和同卷 receipt 完成写入，再由后端以版本条件事务把操作置为 `COMMITTED` 并递增 `workspace_revision`。数据库不可用时保留 `PENDING`，启动恢复按 receipt 重试提交；receipt 缺失、前后摘要不匹配或 revision 已被其他操作占用时，将项目置为 `state=FAILED, failure_reason=WORKSPACE_RECONCILIATION_REQUIRED`，阻止写入和 Run，不猜测覆盖或静默回滚。Run/PTY 开始前记录可编辑源文件清单摘要，结束后重新读取；该清单固定排除 Maven 生成的 `target/**` 和服务端明确声明的临时目录，避免正常构建产物制造假冲突。若 Job/PTY 在没有 `workspace_operation` 的情况下改动清单内文件，不自动递增 revision，置为同一 reconciliation failure 并要求显式 reload。
- 普通代码和 Markdown 小于等于 20 MiB；20--50 MiB Markdown 只能纯文本；二进制、超限正文和不支持编码返回元信息或固定错误。
- `RUNNING`、`STARTING`、`STOPPING`、`RECOVERING` 时文件写入返回 `409 PROJECT_LOCKED`。
- 后端不能接受浏览器提供的 PVC 名、Pod 名、Job 名或绝对路径。

### 6.3 Run 规则

Start 只接受：

```json
{"expectedWorkspaceRevision":"revision-from-client"}
```

命令、镜像、Java/Maven 版本、资源限制、环境变量、容器名和工作目录全部由服务端固定配置派生。后端创建 Job 后返回 `202` 和 `STARTING` Run；重复 Start 返回 `409 RUN_ALREADY_ACTIVE`。Stop 是幂等的，只对当前 owned active Run 生效；确认 Kubernetes Job 已终止或明确失败前不能解锁编辑。

Job 固定约束：

- `mvn clean test`。
- Java 17、Maven 3.9。
- `restartPolicy: Never`、`backoffLimit: 0`、`activeDeadlineSeconds: 1800`。
- CPU 不超过 8 cores，内存不超过 16 GiB，ephemeral storage 不超过 10 GiB。
- 项目 PVC 容量固定为 10 GiB，StorageClass 必须提供 `ReadWriteMany`；对应 `subPath` 以受控读写方式挂载到 `/workspace`，`workingDir=/workspace`；该目录必须由前置 initializer Pod 根挂载创建并通过 UID/GID/`fsGroup` 检查后才能被 Job/Pod 使用。Maven 产物和临时文件优先写 `/tmp`，但活动 Job/PTY 对 PVC 的副作用是本 POC 已接受并必须在验收中记录的风险。
- `/tmp` 使用独立 `emptyDir`，设置 `TMPDIR=/tmp`、`HOME=/tmp`。
- Job 使用 `automountServiceAccountToken: false` 的无 RBAC ServiceAccount。

Maven Job 的应用容器使用包含 JDK 17、Maven 3.9、Bash 和固定 wrapper 的不可变镜像；PID 1 直接执行参数数组 `mvn clean test`，不经过用户可控 shell。PTY 不是 Job entrypoint、sidecar 或 wrapper 替代品，而是对同一 `Running` 应用容器建立的独立 `pods/exec` 子进程：exec 启动固定路径的 root-owned、0555 `manao-pty-wrapper`，wrapper 再启动交互 Bash。Maven PID 1 的退出决定 Job 事实；PTY shell 的输入不能改变固定 Maven 命令，但对 PVC 的写入仍记录为 POC 风险。

### 6.4 错误语义

统一 HTTP 错误包：

```json
{
  "code":"WORKSPACE_REVISION_CONFLICT",
  "message":"The workspace changed; reload and retry.",
  "requestId":"opaque-request-id"
}
```

`code` 是有限枚举，前端按 code 分支；message 不能包含 Kubernetes 资源名、PVC 路径、连接串、堆栈、JWT、ticket 原文或用户输入命令。主要状态码：

| HTTP | 语义 |
|---:|---|
| 401 | 当前认证无效；前端只在 token 仍为当前 token 时清理会话 |
| 403 | 已知资源但无权操作 |
| 404 | 对存在性敏感的资源可统一隐藏为不存在 |
| 409 | revision、Run 锁或 terminal 单活冲突 |
| 422 | 字段、路径、尺寸或请求形状违反合同 |
| 503 | MySQL、PVC 或 Kubernetes 暂时不可用；不得重复创建资源 |

WebSocket 继续采用阶段五 close code：`4401` 未认证、`4409` 已有 live session、`4410` ticket 缺失/过期/重复/绑定不匹配/session 不可用；协议错误使用固定应用 code。close reason 为有限短字符串，不包含内部资源详情。

### 6.5 日志 WebSocket

日志 ticket 通过带 Bearer 的 HTTP 请求取得，约 30 秒有效、单次消费并绑定 user/project/run。WebSocket 只使用同源 `/api/v1/ws/run-logs?ticket=...`；握手后客户端提交非负 `lastSeq`，后端先补发 `seq > lastSeq` 的持久化缺口，再进入 live 推送。每个 Run 的 seq 由 MySQL 条件写入保证单调唯一；重连从客户端 lastSeq 与服务端 `firstAvailableSeq` 比较，若游标早于窗口则先发送固定 `LOG_GAP` marker，再从 `firstAvailableSeq` 继续，重复 seq 丢弃，断线不能解锁 Run。

### 6.6 Terminal WebSocket

终端 ticket 通过带 Bearer 的 `POST terminal-sessions` 取得，请求正文严格只有 `cols` 和 `rows`。WebSocket 固定为同源 `/api/v1/ws/terminals?ticket=...`，JWT 不进入 URL、frame、DOM 或截图。

后端在 ticket 原子消费后：

1. 根据数据库 Run 和服务器派生标签找到 Job 所属 Pod。
2. 要求 Job ownerReference、Run/project 标签、Pod 状态和固定应用容器名全部匹配。
3. 仅当应用容器为 `Running` 时，使用 Fabric8 对该容器建立 PTY exec。
4. 将 PTY 二进制输入/输出和阶段五 control frame 双向桥接。
5. 在 socket close、Run 离开 `RUNNING`、Pod/container 退出或后端 authority teardown 时关闭 exec 并 settlement；旧 session 不恢复。

服务端输出 frame 不超过 32 KiB，初始 credit 为 256 KiB；客户端仅在 xterm `write` callback 完成后 ACK 并返还等量 credit。服务端必须维护未确认窗口，不能用 xterm 内部 discard watermark 代替应用流控。重复或不增加的 ACK 忽略，超过 outstanding 的 ACK 关闭 `4409`，credit 总量不得超过 256 KiB；输入分帧不超过 16 KiB，服务端输入队列上限固定为 64 KiB，队列满时暂停读取，持续 5 秒仍未下降则以 `4410` fail closed。resize 仅接受 1..500 列、1..200 行，按单调 generation 去重，旧 generation 丢弃。客户端 bufferedAmount 高低水位和服务端 pause/resume 规则保持阶段五合同。

## 7. 命令审计设计

浏览器按键流不具备可靠命令边界：退格、补全、多行输入、信号和交互式程序都会使前端推断失真。因此前端只渲染后端结构化审计，不执行 tokenizer、不从 PTY output 追加 audit。

真实后端统一使用服务器拥有的 PTY wrapper 作为审计来源。wrapper 启动固定的 Bash shell，注入 root-owned、0555 的 shell integration hook；wrapper 通过同一容器内随机命名、0600 的 audit FIFO 写入结构化事件，后端为该 session 建立独立的非 PTY `pods/exec` `cat` 消费流。FIFO/审计流绝不合并到 PTY stdout，6A 和 6B 使用相同传输，不依赖后端从本机可达。每个 session 使用后端生成的 256-bit CSPRNG MAC key，wrapper 通过 exec 建立时的受控 stdin 一次性读取，不导出到 shell 环境；事件签名算法固定为 HMAC-SHA-256，签名输入为 canonical JSON。后端拒绝错误 nonce/MAC、重复/倒序事件和不匹配的 session。shell 用户可运行任意命令，因此审计可信度限定为“服务器 wrapper transport verified”，不能宣称恶意代码隔离；无法可靠识别的输入必须记录为不可归因的非成功 settlement，不能伪造为命令。

wrapper 事件至少包含 `sessionId`、命令文本、开始时间、结束时间、退出码和 settlement 状态。命令文本入库前按固定规则遮蔽 `--password`、`--token`、`Authorization`、环境变量凭据赋值和 URL 用户凭据，另存 `sensitiveDetected`；原始命令不写应用日志。无法可靠识别的输入不能被伪造为命令；应以明确的非成功状态记录并保留原因。实现和真实集群验收必须覆盖退格、补全、多行、交互程序、Ctrl-C、shell exit 和命令退出归因。

## 8. Kubernetes 部署与安全边界

### 8.0 两种后端运行 profile

| profile | 后端进程 | 业务数据库 | Kubernetes API | workspace API | 证据含义 |
|---|---|---|---|---|---|
| `local-cluster`（6A） | 本机 Spring Boot 进程 | 本机 MySQL | Fabric8 经 SSH 本地端口转发访问真实 API Server | 后端管理的 `kubectl port-forward` 到项目 workspace Service | 真实 Kubernetes/Job/PTY，开发机安全边界 |
| `cluster`（6B） | Kubernetes Deployment 单 Pod | 集群 MySQL Service | Pod 内 Fabric8 使用 ServiceAccount | 直接访问 namespace 内部 workspace Service | 集群内后端部署和权限证据 |

6A 不是 mock：Job、Pod、PVC、日志和 PTY 都是真实集群资源。但 6A 的本机进程权限、SSH 凭据、本机 MySQL 和 port-forward 子进程不具备 6B 的 Pod 安全边界。6A 完成后才能进入 6B；6A 单独不能写成阶段六最终完成。

### 8.1 6B 后端 Deployment

- `replicas: 1`，配套 ClusterIP Service，Deployment strategy 固定为 `Recreate`，并设置 `revisionHistoryLimit: 2`；启动时仍必须取得数据库 instance lease，所有恢复/watch/清理和写操作带 fencing token。这样即使旧 Pod 处于 Terminating，也不会有两个实例同时拥有业务 authority。
- 使用专用后端 ServiceAccount，不使用 `default`。
- `runAsNonRoot: true`、`allowPrivilegeEscalation: false`、丢弃 capabilities、RuntimeDefault seccomp。
- 根文件系统只读；`/tmp` 使用 `emptyDir`。
- 后端 Deployment 不挂载项目 PVC；项目文件只经内部 workspace Service 访问。不挂载 kubeconfig。
- 每个 workspace Pod 只挂载其项目的 RWX PVC `subPath`，只监听 ClusterIP 内部地址；workspace Pod 使用专用 ServiceAccount 并设置 `automountServiceAccountToken: false`。
- 数据库 URL、用户名、密码、JWT 签名密钥、capability 私钥和 wrapper MAC 根密钥来自 Kubernetes Secret 或受控环境注入；workspace-agent 只接收其项目的公开验证密钥、项目 ID 和服务端模板环境变量。
- 通过 startupProbe 避免冷启动误判；liveness 只判断进程不可恢复失活；readiness 反映数据库和 Kubernetes 客户端是否可用。
- 日志默认只输出 requestId、业务状态和脱敏错误，不输出 JWT、ticket 原文、密码、PVC 绝对路径或资源内部引用。

### 8.1A 6A 本机后端身份和进程边界

- 本机 Spring Boot 使用独立的 `local-cluster` profile 和专用 kubeconfig context；kubeconfig 路径只通过 `KUBECONFIG` 或外部配置提供，不复制到仓库。
- 该 kubeconfig 的 Kubernetes 用户身份必须绑定与 6B 后端 ServiceAccount 等价的 namespace Role；执行前用 `kubectl auth can-i` 逐项检查，不使用集群管理员身份。
- SSH 隧道只转发 Kubernetes API Server，必须保留 kubeconfig 的 CA/证书校验；禁止 `insecure-skip-tls-verify`、关闭 hostname 校验或把 API token 放进命令行历史。
- 本机后端不得直接读取集群 Secret；JWT、MySQL 密码和内部 capability 根密钥通过本机受控环境变量或未跟踪 Secret 文件提供。
- SSH API 隧道使用临时 kubeconfig：`server` 指向 `https://127.0.0.1:<localApiPort>`，但 cluster entry 必须显式设置 `tls-server-name: <certificate-SAN>`；该 SAN 必须由隧道目标 API 证书实际提供。6A 启动前同时用 `kubectl` 和 Fabric8 `/version` 预检 CA、client cert/token、TLS server name、namespace Role 和 API health；缺少 SAN、出现 `insecure-skip-tls-verify` 或仅修改 URL 绕过校验均阻断。API SSH forward 与 workspace bridge 使用不同本地端口。
- 本机 workspace bridge 按项目动态管理：服务端从数据库/固定派生规则得到 namespace、Service 名和 service port，为每个 project 分配受控 loopback 端口范围中的空闲端口，维护 `projectId -> process/localPort` 映射和引用计数；一个项目一个 port-forward，可并发多个项目，不接受浏览器提交的 Service 名或端口。进程退出即标记依赖不可用并重建原映射，项目失败清理或 backend shutdown 时杀死子进程并释放端口；单一 `MANAO_WORKSPACE_SERVICE` 配置不再存在。
- 本机后端退出或崩溃时，所有本地 port-forward 和 PTY ownership 都视为失效；旧 terminal session 必须 settlement 为 `INTERRUPTED`，不自动恢复。

### 8.2 最小 namespace Role

6B 后端 ServiceAccount 只在目标 namespace 绑定 Role；6A 本机 kubeconfig 用户必须绑定同等权限的 RoleBinding：

| 资源 | verbs | 用途 |
|---|---|---|
| `jobs` | `get/list/watch/create/patch/update/delete` | Maven Job 创建、状态、停止、清理 |
| `pods` | `get/list/watch/create/delete` | 创建/回收 workspace Pod，查找 Job Pod、确认状态和容器 |
| `services` | `get/list/create/delete` | 为 workspace Pod 提供 namespace 内部稳定地址 |
| `persistentvolumeclaims` | `get/list/create/delete` | 创建/回收每项目 RWX PVC |
| `pods/log` | `get` | 日志 follow/replay |
| `pods/exec` | `create` | 对已确认应用容器建立 PTY |
| `pods/portforward` | `create` | 仅 6A workspace bridge；6B 不使用 |
| `events` | `get/list/watch` | 失败诊断 |

不得授予 `secrets`、`nodes`、`persistentvolumes`、集群级资源或其他 namespace 权限。`pods/portforward` 只授予 6A 本机后端为服务端派生的 workspace Service 建立 loopback bridge；6B 后端在集群内直接访问 workspace Service，不需要该权限。后端 Deployment 的敏感配置由部署时 Secret 以环境变量注入；workspace Pod 不读取 Secret，而是由后端在创建 Pod 时注入该项目的公开 Ed25519 验证密钥、项目 ID 和固定 agent 配置。后端创建 workspace Pod/PVC/Service 时只能使用服务端生成的名称和模板。若实现需要额外权限，必须先更新设计、说明用途并新增越权测试，不能在集群中临时放宽。

Job 使用无 RBAC ServiceAccount 并设置 `automountServiceAccountToken: false`。后端通过 Deployment 环境注入 Secret，不通过 Kubernetes API 读取 Secret。

### 8.3 资源身份确认

资源名由服务端基于不透明 UUID 和固定前缀派生，用户输入不直接拼入名称。Job/Pod 标签使用固定 schema 和不可逆业务标识；恢复时必须同时检查：

1. 数据库 Run/project 引用；
2. Job/Pod ownerReference；
3. 后端生成的标签；
4. 固定应用容器名及容器状态。

任一检查不一致即停止创建或 attach，记录 `RECOVERY_FAILED`/`PTY_EXEC_FAILED`，不尝试“猜一个相近资源”。

### 8.4 真实集群实施前置条件

进入 6A 决策门前必须由测试操作者记录以下可验证事实：一次性测试 namespace 已存在且仅承载本轮带 `stage6-test=true` 标签的资源，ResourceQuota/LimitRange 能容纳至少三个项目 PVC、每项目 initializer/workspace Pod 以及一个 Maven Job；存在已绑定的 `ReadWriteMany` StorageClass，项目 PVC 容量固定为 10 GiB；至少两个可调度节点可挂载同一 PVC，并在固定 UID/GID 与 `fsGroup` 下完成写入、跨节点读取和原子 rename；backend、workspace-agent 和 Maven 镜像可从受控 registry 以 immutable digest 拉取，必要的 imagePullSecret 已由部署环境提供；Maven 镜像包含 Java 17、Maven 3.9、Bash、root-owned wrapper 和 shell hook，且依赖可访问或已配置批准的内部 Maven mirror；6A/6B MySQL 均能从空库运行 Flyway；故障测试 `stage6-operator` 的临时 namespace Role 已独立提供。

上述任何一项无法验证都将对应证据标为 `SKIPPED` 或 `FAILED` 并阻断对应阶段。禁止以 `hostPath`、浮动镜像 tag、root 运行、关闭 TLS 校验、集群管理员 kubeconfig、扩大后端 Role 或把 Maven 命令改成用户 shell 作为替代方案。

## 9. 本机联调与 SSH 隧道

阶段六不部署前端。真实浏览器始终运行本机 Vite，所有 API 使用相对 `/api/v1/*` 路径；Vite 开发代理把 HTTP 和 WebSocket 转发到本机端口 `18080`。6A 和 6B 的后端入口不同，不能用同一条 port-forward 命令描述两者：

- **6A 本机集成路径**：浏览器 -> 本机 Vite -> 本机 Spring Boot `127.0.0.1:18080`；本机后端使用本机 MySQL。Fabric8 的 kubeconfig `server` 指向 SSH 本地端口转发后的 Kubernetes API 地址，SSH 只转发 API Server 并保留 CA/证书和主机名校验。本机后端按数据库中的服务端派生 project Service 名称为每个项目动态分配受控 loopback 端口，并启动对应 workspace bridge；一个项目一个 port-forward，可并发多个项目，浏览器不能提交 Service 名或端口。该 bridge 由后端监控、重建和清理。
- **6B 集群部署路径**：后端以 Deployment Pod 运行，Fabric8 直接访问集群内 Kubernetes API、集群 MySQL 和 workspace Service。浏览器仍通过本机 Vite；仅用一次受控 `kubectl port-forward` 将后端 Service 映射到本机 `18080`：

```powershell
$MANAO_NAMESPACE = $env:MANAO_TEST_NAMESPACE
kubectl -n $MANAO_NAMESPACE port-forward service/manao-poc4-backend 18080:8080
```

实际 Namespace、集群地址、SSH 参数、API 本地端口、workspace Service 名称和端口、镜像 digest 以及 Secret 值只在本机受控环境提供，不写入 Git、前端 bundle、截图或报告。Vite 代理不改变浏览器看到的同源 WebSocket URL，因此阶段五的 ticket-only 和 JWT 隔离规则保持不变。

## 10. 恢复、故障与并发语义

### 10.1 后端启动恢复

启动时先将未完成的 `STARTING/RUNNING/STOPPING` Run 标记为 `RECOVERING`，暂停文件写入和终端创建；随后按 Run 标签查询 Job/Pod：

- 找到唯一且身份一致的活动 Job/Pod：重新建立状态观察，恢复为 `RUNNING` 或依据 Job 事实进入终态。
- Job 已终止：读取最终状态和日志尾部，settle Run，触发前端工作区 reload。
- 找不到、重复或身份不一致：关闭相关 terminal reservation，Run 进入 `FAILED` 且终止原因 `RECOVERY_FAILED`，释放编辑锁前先完成 workspace reload。

恢复不能自动恢复旧 PTY；所有旧 terminal session 进入 `INTERRUPTED`，用户必须显式 Open 取得新的 ticket/session。

项目恢复独立于 Run 恢复：启动时扫描 `CREATING` 项目，超过 10 分钟仍未完成的项目进入一次性 reconciliation。若 PVC、initializer、workspace Pod 和 Service 的服务端标签/ownerReference 均唯一且模板文件 receipt 可验证，则补偿写入 `READY`；若缺资源、重复资源、权限/目录校验失败或 receipt 不一致，则只删除本项目本次创建且带匹配标签的资源，置为 `state=FAILED` 并记录有限的 `failure_reason`，不删除其他项目资源。`CREATING` 或 `state=FAILED` 且 `failure_reason=WORKSPACE_RECONCILIATION_REQUIRED` 的项目禁止文件、Run、ticket 和 terminal 操作。

`RESERVED` terminal session 的 ticket TTL 固定为 30 秒。定时任务每 10 秒以数据库时间执行 `state=RESERVED AND expires_at<=now()` 的条件更新为 `EXPIRED`；启动恢复先执行同一扫描，再开放新的 reservation。WebSocket 握手成功后原子变更为 `LIVE`，任何旧 reservation 不得阻塞新的 session；`LIVE` 只允许幂等 settlement 为 `CLOSED/INTERRUPTED/FAILED`。

workspace 写入恢复遵循 `workspace_operation`：未完成 `PENDING` 操作逐项查询 agent receipt。receipt 与 expected revision/前后摘要一致则重试条件提交；receipt 缺失或不一致则把项目置为 `state=FAILED`、`failure_reason=WORKSPACE_RECONCILIATION_REQUIRED` 并保留现场，禁止自动覆盖、回滚或接受新的写入。该规则覆盖后端重启、数据库短断和 agent 重启。

### 10.2 断线和状态竞态

- 浏览器或代理断线：后端关闭对应 Fabric8 exec，settle terminal audit 为 `INTERRUPTED`；不自动创建新 exec。
- Run 进入 `STOPPING` 或终态：先禁用和关闭 terminal，再停止/确认 Job，最后通知前端 reload。
- MySQL 短暂不可用：readiness 失败，停止新 Run/ticket/session；不重复提交已有 Job。
- Kubernetes API 短暂不可用：保留数据库锁并进入恢复观察；不将未确认状态直接改成终态。
- Pod 被重建或调度到另一节点：重新通过 ownerReference/标签查找唯一 Job Pod；旧 PTY 不迁移，用户显式创建新 session。
- **6A SSH API 隧道断开**：本机后端不能创建或确认新的 Job/Pod/PTY，也不能把未确认的 Kubernetes 状态改成终态；保留数据库 Run 锁并进入 `RECOVERING`/依赖不可用状态，隧道恢复并重新完成身份确认后才能继续。已存在的集群资源不因浏览器重试而重复创建。
- **6A workspace port-forward 断开**：workspace 文件 API 暂时不可用；禁止绕过 bridge 直接读 PVC、直接访问 Pod 或接受浏览器提交的替代 Service/端口。后端报告固定依赖错误，恢复原 bridge 后再重试。
- **6B 后端 Service port-forward 断开**：只影响本机浏览器到集群后端的访问；集群内后端继续维护 Run、Job、日志和终端事实，浏览器重连后按既有 ticket/session 失效规则处理，不自动复用旧 PTY。

## 11. 测试与证据分层

### 11.1 Java 单元测试

- JWT claims、过期和 owner context。
- 路径规范化、符号链接逃逸和文件大小策略。
- workspace revision 原子写和 Run 状态 reducer。
- 单项目活动 Run/terminal 唯一约束的服务层行为。
- ticket 哈希、过期、重复消费和绑定校验。
- 日志 seq、5 MiB 淘汰、audit settlement 和 cursor 分页。
- REST 错误映射、WebSocket control frame parser、close code。

### 11.2 Spring 与 MySQL 集成测试

使用隔离 MySQL schema 或一次性 MySQL 测试实例执行 Flyway，并通过 MockMvc/WebSocket client 验证。测试固定创建 `alice`、`bob` 两个密码哈希用户；每轮使用唯一的 `manao_stage6_<runId>` schema 或一次性实例，结束后由测试操作者清理测试用户、schema、PVC、workspace Pod/Service、Job/Pod 和 terminal/log/audit 数据；完成 Job/Pod 默认保留 7 天，证据采集后才允许清理：

- Alice/Bob owner 隔离、401/403/404 语义。
- 严格请求字段白名单和错误包脱敏。
- 并发 Start、Stop、terminal reservation、ticket consume 和 audit settlement。
- 后端重启扫描、锁恢复、七天清理和事务回滚。
- 文件 CRUD、revision 冲突和路径/symlink 拒绝。

### 11.3 Fabric8 适配测试

使用 Fabric8 mock server 或等价受控 API stub 验证：

- Job 的固定命令、资源、deadline、标签、ownerReference 和 ServiceAccount。
- Pod 查找、固定应用容器选择和非匹配资源拒绝。
- LogWatch follow/close、Job 状态 watch、停止和清理。
- `pods/exec` PTY 的输入输出、resize、关闭和异常映射。

这些测试只证明 Kubernetes API 适配，不替代真实集群证据。

### 11.4 真实浏览器与真实集群 E2E

关闭 MSW，使用本机 Vite 代理，按 6A -> 6B 的顺序执行两轮真实 E2E；每轮单独记录 profile、后端运行位置、数据库位置、Kubernetes API 入口和 port-forward 进程，不得把两轮证据混写。

**6A 本机集成 E2E**：启动本机 Spring Boot、本机 MySQL、SSH API 隧道和由后端管理的 workspace port-forward，确认 Fabric8 经 API 隧道访问真实集群，并覆盖以下流程：

**6B 集群部署 E2E**：使用与 6A 相同的后端构建产物和配置合同，将后端部署为单 Pod Deployment，使用集群 MySQL、集群内 Kubernetes API 和 workspace Service；本机只为浏览器访问后端 Service 建立 loopback port-forward，再重复以下流程：

1. 真实登录和 token 过期；
2. 项目创建、PVC 文件树、保存、revision 冲突和运行期锁；
3. Start、真实 Job、Pod 日志 replay/live、停止、超时和终态 reload；
4. terminal ticket、真实应用容器 PTY、Unicode/二进制、resize、credit/ack、Close；
5. 断线销毁、后端重启、Job Pod 重建和显式新 session；
6. structured audit 分页、settlement、七天清理和三通道 marker 隔离；
7. Alice/Bob 越权、伪造/过期/重复 ticket、资源标识和 Secret 泄漏探测。

6A 还必须单独证明本机 MySQL migration、SSH API 隧道重连、workspace bridge 生命周期和本机后端退出清理；6B 还必须单独证明 Deployment/ServiceAccount/Secret/探针/RBAC 和 Pod 重启恢复。所有真实集群证据必须记录 Git SHA、镜像 digest、migration 版本、脱敏 Kubernetes 资源快照、后端日志摘要、HTTP/WS 结果、截图和失败/豁免状态。测试报告必须区分 `PASS`、`WAIVED_BY_USER`、`SKIPPED` 和 `FAILED`。

### 11.5 压力与故障测试

真实链路重复阶段五的关键压力：至少 8 MiB PTY 输出、32 KiB 输出帧、256 KiB credit、16 KiB 输入帧、有界输入队列和 100+ resize；记录实际吞吐、最大 outstanding、bufferedAmount、断线时延、错误计数和终端响应时间。另行执行后端 Pod 重启、MySQL 短断、WebSocket/SSH 短断、Job Pod 重建和跨节点调度。故障注入由独立 `stage6-operator` 测试身份执行，该身份仅绑定一次性测试 namespace 的 Role，允许 `get/list/watch/delete` 测试 namespace 内 Pod、`get/list/watch` Job，并允许读取脱敏状态；Kubernetes RBAC 本身不按 label 限制 delete，因此 fault runner 必须先拒绝所有不带固定 `stage6-test=true` 标签的目标，一次性 namespace 用后销毁。后端 ServiceAccount、6A kubeconfig 用户和普通 Alice/Bob 均不得拥有这些权限。MySQL 网络中断由该操作者在受控进程/防火墙层注入。每次故障操作记录操作者身份、开始/结束时间、目标的不可逆哈希和结果，不把该身份凭据写入仓库或证据。

阶段五的两个用户豁免项（stale Alice terminal 401 竞态、完整键盘工作流）不能被历史 mock 结果替代。阶段六若执行它们，必须产生新的真实后端证据；否则继续标记 `WAIVED_BY_USER`。

## 12. 阶段六退出门

阶段六只有 6A 和 6B 两轮都满足以下条件，才能写成 `READY_FOR_STAGE_7_PLAN` 或最终完成结论；仅 6A 通过只能写成“真实集群本机集成通过，待 6B 部署验证”，不能提前结束阶段六。任一关键门失败则写成 `STAGE_6_REMEDIATION_REQUIRED`：

1. `poc4/backend` 可重复构建；Flyway 在 6A 本机 MySQL 和 6B 集群 MySQL 上均可从空库升级，Java 单元和集成测试通过。
2. 6A 本机后端通过 SSH API 隧道和 workspace bridge 完成联调；6B 同一构建产物的后端 Deployment 在真实集群 Ready，Secret 注入、liveness/readiness、Service 和 Vite 联调通过。
3. JWT、owner 隔离、历史/non-RUNNING Run 拒绝、严格请求白名单和脱敏错误包在真实后端通过。
4. PVC 文件树、读写、revision 冲突、相对路径/symlink 拒绝和 20/50 MiB 限制在真实 PVC 通过。
5. 每次 Start 只产生一个受策略约束的 Job；日志、Stop、超时、失败、清理和 DB/Kubernetes 最终一致通过。
6. 日志 replay/live、5 MiB 保留、断线恢复和后端重启恢复通过，并与 PTY 完全隔离。
7. terminal ticket 单次消费、真实 Job 应用容器 `pods/exec`、Unicode/二进制、resize、credit/ack、Close 和断线销毁通过。
8. terminal audit 的 wrapper/后端来源、事务、分页、退出归因、七天清理和重启恢复通过；没有前端按键 tokenizer。
9. 6A 本机后端退出/重启、MySQL 短断、WebSocket/SSH/workspace bridge 短断，以及 6B 后端 Pod 重启、MySQL 短断、WebSocket、Job Pod 重建和跨节点调度，都不产生双活 Run 或可复用旧 session。
10. RBAC 越权、跨用户访问、伪造/过期/重复 ticket、资源标识泄漏和 Secret 泄漏探测通过。
11. 真实链路压力满足阶段五协议上限：输出字节守恒、未确认窗口不超过 256 KiB、输入队列溢出 fail closed、resize 去重，并有实际指标。
12. 证据包可复核：Git SHA、镜像 digest、migration、manifest、命令日志、脱敏响应/frame、截图和失败/豁免清单齐全。

退出门中的“通过”只表示当前 SHA、当前镜像和当前受控集群的证据。它不自动等价于生产级 HA、恶意代码隔离、任意出网控制或跨版本升级安全。

## 13. 失败回滚与停止条件

- 镜像发布失败：停止放量，保留 MySQL/PVC/Job 现场，使用 `kubectl rollout undo` 回到上一镜像；不删除恢复所需资源。
- Flyway 失败：Deployment 保持不可 Ready；只使用前向兼容 migration 修复，不执行未经验证的 destructive down migration。
- Run/PTY 语义失败：后端 fail closed，拒绝新 Run/terminal；先关闭 exec、settle audit，再回滚应用镜像。
- 前后端合同不兼容：切回 mock 或兼容代理；不在浏览器端偷偷修改安全合同。
- 权限不足或 PVC 不可用：停止创建 Job/PTY；不通过放宽 RBAC、关闭 owner 校验或改 hostPath 绕过。
- 真实集群证据缺失：结论只能写 `SKIPPED` 或 `STAGE_6_REMEDIATION_REQUIRED`，不能以 Fabric8 mock、阶段五截图或旧报告替代。
- 同一问题最多按仓库约束进行四轮有证据的修复尝试；重复失败后停止扩展范围并报告阻塞原因。

## 14. 阶段五证据的继承边界

阶段五已经证明浏览器/MSW 合同，包括 ticket 形状、前端授权协调、xterm 流控、生命周期和视觉布局；它没有证明：

1. Spring Boot JWT 签名和真实 owner 授权；
2. Fabric8 是否进入正确的 Maven Job 应用容器；
3. 真实 exec、shell 和子进程销毁；
4. MySQL audit 事务、分页、留存和后端重启恢复；
5. RWX PVC side effect、UID/GID、`fsGroup` 和跨节点可见性；
6. 真实代理/后端/集群上的 8 MiB 流控与 WebSocket SLA；
7. wrapper 的退格、补全、多行、交互程序、信号和退出归因。

因此，阶段六报告必须同时引用阶段五证据和新的真实证据，不能把 `mock contract verified` 改写成 Kubernetes、MySQL 或生产安全 `PASS`。

## 15. 决策摘要

1. 采用“模块化 Spring Boot 单体 + 单副本 Deployment + namespace 级最小 RBAC”的方案。
2. 6A 是首次真实集成入口：本机 Vite、本机 Spring Boot、本机 MySQL，通过 SSH API 隧道和后端管理的 workspace port-forward 使用真实 Kubernetes、Job、PVC 和 PTY。
3. 6B 是最终部署验证：把与 6A 相同的后端构建产物部署为集群单 Pod，使用集群 MySQL、集群内 API 和 workspace Service；只有 6A、6B 都通过，阶段六才算完成。
4. 本机开发环境不等于生产安全边界；6A 的本机权限、SSH 凭据、Secret 管理和 port-forward 生命周期必须单独记录，不能以 6A 证据替代 6B Pod 安全证据。
5. MySQL 是业务状态和审计权威，RWX PVC 是文件正文权威，Kubernetes 是 Job/Pod 执行事实权威。
6. 终端 ticket、PTY、日志和 audit 都是独立通道；旧 terminal session 永不自动恢复。
7. POC1/POC2 只提供 Fabric8 API 参考；不复制其无 POC4 owner/ticket/状态机边界的实现。
8. 阶段六完成的最小可信结论是“当前受控集群中的真实后端合同已验证”；不是生产级多副本、高安全沙箱或跨集群 SLA。
