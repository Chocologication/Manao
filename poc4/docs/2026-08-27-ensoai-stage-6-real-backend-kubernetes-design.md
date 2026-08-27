# POC4 阶段六真实后端与 Kubernetes 集成设计

## 1. 文档状态

- 状态：设计已在对话中确认，本文待用户审阅
- 日期：2026-08-27
- 基线：`master@521b4ec`，阶段五 active-job terminal 已完成
- 前端参考：`D:\DeepLearning\MyProjects\Enso_AI@5aa294a`
- 本阶段结论目标：真实后端和真实集群链路可复核，但不把 mock 证据或单元测试写成生产级安全结论

本文是阶段六的设计说明，不授权直接编码。用户审阅通过后，另行编写逐任务实施计划；实施必须在从阶段五基线创建的隔离工作树中进行。

## 2. 目标与第一性原则

### 2.1 目标

在不破坏 POC4 已确认规则的前提下，交付并验证一个真实的 Spring Boot 后端：

1. 后端以 Kubernetes `Deployment` 的单个 Pod 运行。
2. 后端使用真实 JWT、MySQL、RWX PVC 和 Fabric8 Kubernetes Client。
3. 浏览器通过阶段五已经实现的 REST/WebSocket 合同访问后端。
4. 后端创建并管理 Maven Job，读取项目 PVC 中的源码，提供独立日志流和活动 Job PTY 终端。
5. 后端重启、WebSocket 断开、Job/Pod 状态变化和短暂依赖故障不会产生双活 Run、可复用旧 terminal session 或错误解锁编辑器。
6. 使用本机 Vite + SSH 隧道联调真实集群，不在本阶段部署前端静态 Pod 或 Ingress。

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
- JWT 登录、用户所有权检查、统一 HTTP 错误包。
- MySQL Flyway migration、项目/Run/日志/ticket/terminal/audit 持久化。
- 通过内部 workspace API 操作 RWX PVC 上的文件树、内容、保存、创建、重命名、删除和 revision 校验。
- 固定 Java 17 + Maven 3.9 的 `mvn clean test` Job。
- Pod 日志持久化、最近 5 MiB 窗口、replay/live WebSocket 和七天清理。
- 当前活动 Maven Job 应用容器的 Fabric8 `pods/exec` PTY。
- 一次性日志/终端 ticket、单 live terminal session、resize、二进制输入输出、credit/ack 和关闭销毁。
- 结构化 terminal audit 的后端产生、分页、事务 settlement 和七天清理。
- 后端 Deployment、内部 workspace Pod/Service 模板、ServiceAccount、namespace 级 Role/RoleBinding、Service、Secret/ConfigMap 引用、探针和镜像构建。
- 本机 Vite 经 SSH 隧道访问集群后端的真实浏览器 E2E。
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
    | SSH 隧道 + kubectl port-forward
    v
127.0.0.1:18080 -> backend Service:8080
    |
    v
backend Deployment（replicas=1，Spring Boot Pod）
    |-- Spring Security JWT / owner authorization
    |-- REST controllers + WebSocket handlers
    |-- MySQL datasource + Flyway
    |-- workspace Pod/Service coordinator
    |-- Fabric8 Kubernetes Client
    |       |-- Maven Job / Pod watch
    |       |-- Pod log follow
    |       `-- selected application-container exec PTY
    |
    |-- MySQL Service
    |-- workspace ClusterIP Service -> workspace Pod -> RWX PVC（项目文件正文）
    `-- Maven Job Pod -> same project PVC（受控读写、/tmp 可写、无 K8s API）
```

后端固定为单副本，因为阶段六的目标是先证明状态和终端生命周期正确。Deployment 扩容不是本阶段能力；任何需要第二副本的发现都必须在 Stage 6 报告中记录为后续工作，而不能静默改变锁语义。

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

workspace Pod 只监听 namespace 内部 ClusterIP，不提供外部入口。后端到 workspace API 的每个请求携带服务端生成的项目 capability：项目不透明 ID、请求时间、随机 nonce 和 HMAC 签名；workspace Pod 校验签名、时间窗口、nonce 重放和 capability 中的项目范围，再执行路径策略。浏览器永远不能生成或看到该 capability。

项目创建顺序固定为：先在 MySQL 写入 `CREATING`，再创建项目专属 RWX PVC、workspace Pod 和 ClusterIP Service，等待 workspace Pod Ready 后调用内部 API 写入 Java 17/Maven 模板，最后将项目置为 `READY`。任一步骤失败，项目置为 `FAILED` 并记录脱敏原因；只删除本次创建且未被其他 Run 引用的资源，不提供用户侧项目删除入口。

### 4.2 技术基线

- Java 17。
- Spring Boot 3.5.9，与现有 `poc1/poc2` 基线一致。
- Spring Web MVC + `spring-boot-starter-websocket`，保持现有 POC2 的 WebSocket 运行模型。
- Spring Security，用服务器端密码哈希和 JWT 签发/验证。
- Spring Data JDBC，业务 SQL 和状态转换显式可见。
- Flyway，migration 从空 MySQL schema 可重复执行。
- Fabric8 Kubernetes Client 7.7.0，与现有 POC1/P2 基线一致；POC1/POC2 代码只作为 API 参考，不直接复用旧业务协议。
- 前端继续使用现有锁定依赖和 `pnpm`；阶段六不新增或升级 xterm 包。

Spring Boot Actuator 提供 liveness/readiness health groups。Kubernetes 探针分别使用 `/actuator/health/liveness` 和 `/actuator/health/readiness`；liveness 不因 MySQL 或 Kubernetes API 临时故障触发重启，readiness 在关键依赖不可用时摘除 Service 流量。健康响应不得包含连接串、资源名或堆栈。

## 5. 数据模型与事务

### 5.1 表和关键字段

字段名以实现计划中的 migration 为准，以下字段是业务设计约束：

| 表 | 关键字段 | 约束/用途 |
|---|---|---|
| `app_user` | `id`, `username`, `password_hash`, `enabled`, `created_at` | `username` 唯一；不存明文密码 |
| `project` | `id`, `owner_id`, `name`, `state`, `workspace_revision`, `created_at`, `updated_at`, `failure_reason` | 每次查询带 `owner_id`；每用户最多 3 个项目 |
| `run` | `id`, `project_id`, `requested_revision`, `state`, `policy_json`, `job_ref`, `pod_ref`, `started_at`, `finished_at`, `exit_code`, `termination_reason`, `version` | locking state 单项目唯一；保存策略快照 |
| `run_log_chunk` | `run_id`, `seq`, `text_utf8`, `byte_length`, `created_at` | `(run_id, seq)` 唯一；总窗口不超过 5 MiB |
| `log_ticket` | `ticket_hash`, `user_id`, `project_id`, `run_id`, `expires_at`, `consumed_at` | 哈希存储；单次消费 |
| `terminal_session` | `id`, `project_id`, `run_id`, `user_id`, `state`, `ticket_hash`, `expires_at`, `consumed_at`, `pod_ref`, `container_ref`, `started_at`, `finished_at`, `exit_code`, `close_reason`, `version` | 单 Run 单 live session；资源引用只在服务端 |
| `terminal_audit` | `id`, `session_id`, `project_id`, `run_id`, `user_id`, `command`, `state`, `started_at`, `finished_at`, `exit_code` | 结构化审计；不存 PTY 输出 |

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
- 写入采用临时文件、`fsync` 和原子 rename，再递增 `workspace_revision`。
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
- 项目 PVC 的对应 `subPath` 以受控读写方式挂载到 `/workspace`，`workingDir=/workspace`；Maven 产物和临时文件优先写 `/tmp`，但活动 Job/PTY 对 PVC 的副作用是本 POC 已接受并必须在验收中记录的风险。
- `/tmp` 使用独立 `emptyDir`，设置 `TMPDIR=/tmp`、`HOME=/tmp`。
- Job 使用 `automountServiceAccountToken: false` 的无 RBAC ServiceAccount。

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

日志 ticket 通过带 Bearer 的 HTTP 请求取得，约 30 秒有效、单次消费并绑定 user/project/run。WebSocket 只使用同源 `/api/v1/ws/run-logs?ticket=...`；握手后客户端提交 `lastSeq`，后端先补发持久化缺口，再进入 live 推送。日志通道独立于 terminal，断线不能解锁 Run。

### 6.6 Terminal WebSocket

终端 ticket 通过带 Bearer 的 `POST terminal-sessions` 取得，请求正文严格只有 `cols` 和 `rows`。WebSocket 固定为同源 `/api/v1/ws/terminals?ticket=...`，JWT 不进入 URL、frame、DOM 或截图。

后端在 ticket 原子消费后：

1. 根据数据库 Run 和服务器派生标签找到 Job 所属 Pod。
2. 要求 Job ownerReference、Run/project 标签、Pod 状态和固定应用容器名全部匹配。
3. 仅当应用容器为 `Running` 时，使用 Fabric8 对该容器建立 PTY exec。
4. 将 PTY 二进制输入/输出和阶段五 control frame 双向桥接。
5. 在 socket close、Run 离开 `RUNNING`、Pod/container 退出或后端 authority teardown 时关闭 exec 并 settlement；旧 session 不恢复。

服务端输出 frame 不超过 32 KiB，初始 credit 为 256 KiB；客户端仅在 xterm `write` callback 完成后 ACK 并返还等量 credit。服务端必须维护未确认窗口，不能用 xterm 内部 discard watermark 代替应用流控。输入分帧不超过 16 KiB，客户端 bufferedAmount 高低水位和服务端 pause/resume 规则保持阶段五合同。

## 7. 命令审计设计

浏览器按键流不具备可靠命令边界：退格、补全、多行输入、信号和交互式程序都会使前端推断失真。因此前端只渲染后端结构化审计，不执行 tokenizer、不从 PTY output 追加 audit。

真实后端统一使用服务器拥有的 PTY wrapper 作为审计来源。wrapper 启动固定的 Bash shell，注入受控 shell integration hook，在命令开始/结束、信号和 shell exit 时通过独立的 session-bound audit ingress 发送结构化事件；事件绝不写入 PTY stdout。无法可靠识别的输入必须记录为不可归因的非成功 settlement，不能伪造为命令。

wrapper 事件至少包含 `sessionId`、命令文本、开始时间、结束时间、退出码和 settlement 状态。后端必须拒绝错误 session nonce、重复事件、倒序时间和与 terminal session 不一致的事件。无法可靠识别的输入不能被伪造为命令；应以明确的非成功状态记录并保留原因。实现和真实集群验收必须覆盖退格、补全、多行、交互程序、Ctrl-C、shell exit 和命令退出归因。

## 8. Kubernetes 部署与安全边界

### 8.1 后端 Deployment

- `replicas: 1`，配套 ClusterIP Service。
- 使用专用后端 ServiceAccount，不使用 `default`。
- `runAsNonRoot: true`、`allowPrivilegeEscalation: false`、丢弃 capabilities、RuntimeDefault seccomp。
- 根文件系统只读；`/tmp` 使用 `emptyDir`。
- 后端 Deployment 不挂载项目 PVC；项目文件只经内部 workspace Service 访问。不挂载 kubeconfig。
- 每个 workspace Pod 只挂载其项目的 RWX PVC `subPath`，只监听 ClusterIP 内部地址；workspace Pod 使用专用 ServiceAccount 并设置 `automountServiceAccountToken: false`。
- 数据库 URL、用户名、密码、JWT 签名密钥、内部 wrapper nonce 配置来自 Kubernetes Secret 或受控环境注入。
- 通过 startupProbe 避免冷启动误判；liveness 只判断进程不可恢复失活；readiness 反映数据库和 Kubernetes 客户端是否可用。
- 日志默认只输出 requestId、业务状态和脱敏错误，不输出 JWT、ticket 原文、密码、PVC 绝对路径或资源内部引用。

### 8.2 最小 namespace Role

后端 ServiceAccount 只在目标 namespace 绑定 Role：

| 资源 | verbs | 用途 |
|---|---|---|
| `jobs` | `get/list/watch/create/patch/update/delete` | Maven Job 创建、状态、停止、清理 |
| `pods` | `get/list/watch/create/delete` | 创建/回收 workspace Pod，查找 Job Pod、确认状态和容器 |
| `services` | `get/list/create/delete` | 为 workspace Pod 提供 namespace 内部稳定地址 |
| `persistentvolumeclaims` | `get/list/create/delete` | 创建/回收每项目 RWX PVC |
| `pods/log` | `get` | 日志 follow/replay |
| `pods/exec` | `create` | 对已确认应用容器建立 PTY |
| `events` | `get/list/watch` | 失败诊断 |

不得授予 `secrets`、`nodes`、`persistentvolumes`、集群级资源或其他 namespace 权限。后端 Deployment 和 workspace Pod 通过已存在 Secret 的 `envFrom` 引用共享内部 API 根密钥，后端不读取 Secret 内容。后端创建 workspace Pod/PVC/Service 时只能使用服务端生成的名称和模板。若实现需要额外权限，必须先更新设计、说明用途并新增越权测试，不能在集群中临时放宽。

Job 使用无 RBAC ServiceAccount 并设置 `automountServiceAccountToken: false`。后端通过 Deployment 环境注入 Secret，不通过 Kubernetes API 读取 Secret。

### 8.3 资源身份确认

资源名由服务端基于不透明 UUID 和固定前缀派生，用户输入不直接拼入名称。Job/Pod 标签使用固定 schema 和不可逆业务标识；恢复时必须同时检查：

1. 数据库 Run/project 引用；
2. Job/Pod ownerReference；
3. 后端生成的标签；
4. 固定应用容器名及容器状态。

任一检查不一致即停止创建或 attach，记录 `RECOVERY_FAILED`/`PTY_EXEC_FAILED`，不尝试“猜一个相近资源”。

## 9. 本机联调与 SSH 隧道

阶段六不部署前端。真实浏览器仍运行本机 Vite，所有 API 使用相对 `/api/v1/*` 路径；Vite 开发代理把 HTTP 和 WebSocket 转发到本机端口 `18080`。SSH 隧道或 `kubectl port-forward` 将 `127.0.0.1:18080` 映射到后端 Service，例如：

```powershell
$MANAO_NAMESPACE = $env:MANAO_TEST_NAMESPACE
kubectl -n $MANAO_NAMESPACE port-forward svc/manao-poc4-backend 18080:8080
```

实际 Namespace、集群地址、SSH 参数、镜像 digest 和 Secret 值只在本机受控环境提供，不写入 Git、前端 bundle、截图或报告。Vite 代理不改变浏览器看到的同源 WebSocket URL，因此阶段五的 ticket-only 和 JWT 隔离规则保持不变。

## 10. 恢复、故障与并发语义

### 10.1 后端启动恢复

启动时先将未完成的 `STARTING/RUNNING/STOPPING` Run 标记为 `RECOVERING`，暂停文件写入和终端创建；随后按 Run 标签查询 Job/Pod：

- 找到唯一且身份一致的活动 Job/Pod：重新建立状态观察，恢复为 `RUNNING` 或依据 Job 事实进入终态。
- Job 已终止：读取最终状态和日志尾部，settle Run，触发前端工作区 reload。
- 找不到、重复或身份不一致：关闭相关 terminal reservation，Run 进入 `FAILED` 且终止原因 `RECOVERY_FAILED`，释放编辑锁前先完成 workspace reload。

恢复不能自动恢复旧 PTY；所有旧 terminal session 进入 `INTERRUPTED`，用户必须显式 Open 取得新的 ticket/session。

### 10.2 断线和状态竞态

- 浏览器或代理断线：后端关闭对应 Fabric8 exec，settle terminal audit 为 `INTERRUPTED`；不自动创建新 exec。
- Run 进入 `STOPPING` 或终态：先禁用和关闭 terminal，再停止/确认 Job，最后通知前端 reload。
- MySQL 短暂不可用：readiness 失败，停止新 Run/ticket/session；不重复提交已有 Job。
- Kubernetes API 短暂不可用：保留数据库锁并进入恢复观察；不将未确认状态直接改成终态。
- Pod 被重建或调度到另一节点：重新通过 ownerReference/标签查找唯一 Job Pod；旧 PTY 不迁移，用户显式创建新 session。
- SSH 隧道短断只影响浏览器连接；后端 Run 和日志事实继续由集群内服务维护。

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

使用隔离 MySQL schema 或一次性 MySQL 测试实例执行 Flyway，并通过 MockMvc/WebSocket client 验证：

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

关闭 MSW，使用本机 Vite 代理和 SSH 隧道，沿用阶段五 Playwright 流程覆盖：

1. 真实登录和 token 过期；
2. 项目创建、PVC 文件树、保存、revision 冲突和运行期锁；
3. Start、真实 Job、Pod 日志 replay/live、停止、超时和终态 reload；
4. terminal ticket、真实应用容器 PTY、Unicode/二进制、resize、credit/ack、Close；
5. 断线销毁、后端重启、Job Pod 重建和显式新 session；
6. structured audit 分页、settlement、七天清理和三通道 marker 隔离；
7. Alice/Bob 越权、伪造/过期/重复 ticket、资源标识和 Secret 泄漏探测。

所有真实集群证据必须记录 Git SHA、镜像 digest、migration 版本、脱敏 Kubernetes 资源快照、后端日志摘要、HTTP/WS 结果、截图和失败/豁免状态。测试报告必须区分 `PASS`、`WAIVED_BY_USER`、`SKIPPED` 和 `FAILED`。

### 11.5 压力与故障测试

真实链路重复阶段五的关键压力：至少 8 MiB PTY 输出、32 KiB 输出帧、256 KiB credit、16 KiB 输入帧、有界输入队列和 100+ resize；记录实际吞吐、最大 outstanding、bufferedAmount、断线时延、错误计数和终端响应时间。另行执行后端 Pod 重启、MySQL 短断、WebSocket/SSH 短断、Job Pod 重建和跨节点调度。

阶段五的两个用户豁免项（stale Alice terminal 401 竞态、完整键盘工作流）不能被历史 mock 结果替代。阶段六若执行它们，必须产生新的真实后端证据；否则继续标记 `WAIVED_BY_USER`。

## 12. 阶段六退出门

阶段六只有以下条件全部满足才能写成 `READY_FOR_STAGE_7_PLAN` 或最终完成结论；任一关键门失败则写成 `STAGE_6_REMEDIATION_REQUIRED`：

1. `poc4/backend` 可重复构建；Flyway 可从空库升级，Java 单元和集成测试通过。
2. 后端 Deployment 在真实集群 Ready；Secret 注入、liveness/readiness、Service 和 Vite/SSH 联调通过。
3. JWT、owner 隔离、历史/non-RUNNING Run 拒绝、严格请求白名单和脱敏错误包在真实后端通过。
4. PVC 文件树、读写、revision 冲突、相对路径/symlink 拒绝和 20/50 MiB 限制在真实 PVC 通过。
5. 每次 Start 只产生一个受策略约束的 Job；日志、Stop、超时、失败、清理和 DB/Kubernetes 最终一致通过。
6. 日志 replay/live、5 MiB 保留、断线恢复和后端重启恢复通过，并与 PTY 完全隔离。
7. terminal ticket 单次消费、真实 Job 应用容器 `pods/exec`、Unicode/二进制、resize、credit/ack、Close 和断线销毁通过。
8. terminal audit 的 wrapper/后端来源、事务、分页、退出归因、七天清理和重启恢复通过；没有前端按键 tokenizer。
9. 后端 Pod 重启、MySQL 短断、WebSocket/SSH 短断、Job Pod 重建和跨节点调度不产生双活 Run 或可复用旧 session。
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
2. 前端继续本机 Vite，通过 SSH 隧道和 `kubectl port-forward` 访问集群后端，不把前端部署复杂度混入本阶段。
3. MySQL 是业务状态和审计权威，RWX PVC 是文件正文权威，Kubernetes 是 Job/Pod 执行事实权威。
4. 终端 ticket、PTY、日志和 audit 都是独立通道；旧 terminal session 永不自动恢复。
5. POC1/POC2 只提供 Fabric8 API 参考；不复制其无 POC4 owner/ticket/状态机边界的实现。
6. 阶段六完成的最小可信结论是“当前受控集群中的真实后端合同已验证”；不是生产级多副本、高安全沙箱或跨集群 SLA。
