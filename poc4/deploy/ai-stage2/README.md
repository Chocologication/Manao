# Pi 第二阶段发布与验收准备

当前是可审阅发布清单，**没有执行第二阶段镜像构建、推送、配置更新或集群 rollout**。实际实现、测试与限制由 [Stage 2 acceptance](../../docs/evidence/ai-stage2/acceptance.md) 统一记录。第一阶段的真实 PASS 保留在原记录；现存模型 Secret 不构成本阶段发布授权。

## 1. 发布清单

| 组件 | 本轮发布状态 | 待登记的不可变引用 |
| --- | --- | --- |
| backend | NOT_BUILT / NOT_PUBLISHED | `chocologic/manao_images_repository@sha256:<backend-64-hex>` |
| pi-worker | NOT_BUILT / NOT_PUBLISHED | `chocologic/manao_images_repository@sha256:<worker-64-hex>` |
| frontend (`VITE_ENABLE_AI=true`) | NOT_BUILT / NOT_PUBLISHED | `chocologic/manao_images_repository@sha256:<frontend-64-hex>` |
| Maven runner | 无源码变化，复用已接受镜像 | `chocologic/manao_images_repository@sha256:59a83cb94ac271b24b837f6fe55a27a308cc6f67fee43a46ca628d03fdf85e98` |

这里的占位符没有被解析为真实 digest。本阶段没有新 migration、表、共用 NetworkPolicy、initializer 或 workspace-agent 变化；不为其重建镜像、重放 V11/V12 或重新应用第一阶段共用策略。

获得发布授权后，从最终审查提交构建并记录 commit、tag、push 输出和仓库 digest：

```powershell
docker build -t chocologic/manao_images_repository:ai-stage2-backend-<release> poc4/backend
docker build -t chocologic/manao_images_repository:ai-stage2-worker-<release> poc4/pi-worker
docker build --build-arg VITE_ENABLE_AI=true -t chocologic/manao_images_repository:ai-stage2-frontend-<release> poc4/frontend
# Push only those three exact tags; then resolve and record each RepoDigest.
docker push chocologic/manao_images_repository:ai-stage2-backend-<release>
docker push chocologic/manao_images_repository:ai-stage2-worker-<release>
docker push chocologic/manao_images_repository:ai-stage2-frontend-<release>
docker image inspect --format '{{index .RepoDigests 0}}' chocologic/manao_images_repository:ai-stage2-backend-<release>
docker image inspect --format '{{index .RepoDigests 0}}' chocologic/manao_images_repository:ai-stage2-worker-<release>
docker image inspect --format '{{index .RepoDigests 0}}' chocologic/manao_images_repository:ai-stage2-frontend-<release>
```

backend Dockerfile 必须保留 JVM 启动参数 `-Djdk.httpclient.redirects.retrylimit=1` 与 `-Djdk.httpclient.disableRetryConnect=true`。本地直接启动 jar 时也必须显式提供；PowerShell 的 `-D` 参数须整体加引号。确切 JRE 17.0.13 的丢响应单例已本地验证，完整新 backend 镜像构建/执行仍为 NOT_RUN。

## 2. 专用项目 bootstrap

先核对当前真实 context/namespace、凭据、节点和容量，以及操作者明确选择的 `30000–31000` 公网端口；冲突直接失败，禁止自动更换。项目为 Spring Boot、mysql=false、redis=false，不使用平台数据库作为用户项目数据。

只在已授权的运行环境执行：

```powershell
# Supply secrets through private environment configuration; never commit them.
$env:MANAO_AI_ACCEPTANCE_BASE_URL = '<frontend-origin>'
$env:MANAO_AI_ACCEPTANCE_USERNAME = '<owner>'
$env:MANAO_AI_ACCEPTANCE_PASSWORD = '<private-secret>'
$env:MANAO_AI_ACCEPTANCE_PUBLIC_PORT = '<explicit-free-30000-to-31000>'
node poc4/frontend/scripts/ai-stage2-bootstrap.mjs
```

脚本使用唯一 creationKey，逐层创建测试目录，receipt 写入两个固定 fixture、逐次读取 revision、字节回读后启动 R0 并等待权威 ready。未知 create 响应只读 creationKey 记录；未知 Run 响应只读原项目 active Run，不盲重发。失败会输出已知 project/run/creationKey 清单并标记 RETAINED，不自动删除。

保存其 `projectId`、`initialRevision`、`r0Id`、`endpoint` 与 `testFixtureSha256`。脚本不修改 backend 的 AI 专用项目配置。发布时必须在已有 backend 配置源把 `MANAO_AI_PROJECT_ID` 明确改为本轮新 projectId，保留此前值以便回滚；不要把旧第一阶段项目当成本轮项目。

## 3. 单实例更新与回滚

先清点当前 AgentTask/Run，等待或由 owner 正常停止并确认；未知副作用先核对原身份。保存当前三个 Deployment 的 image digest、replicas/strategy、AI projectId 与 JVM 参数；不输出 Secret 值。

获得授权后，沿用 [第一阶段发布方式](../ai-stage1/README.md) 与 [6B 维护方式](../6b/README.md)：worker 和 backend 各一个实例，新旧 Pod 不重叠。对两个 Deployment 使用已审查的 Recreate/停旧再启新顺序，确认旧 Pod 已结束后再启动新版本；更新 worker digest、backend digest/专用 projectId，再更新 frontend digest。模型配置只保留在 worker 侧，backend 只有内部 token。每步核对真实 Pod imageID、replica 数和健康，不以 apply 成功代替 rollout。

回滚先拒绝新 AI 任务（`MANAO_AI_ENABLED=false`），处理已登记 Run 的安全收尾；worker 缩至 0 并确认退出，再依次恢复已保存 backend/worker/frontend digest、专用 projectId、JVM 参数与单实例配置。重新启用前核对原任务和 Run。无新 migration 可回滚；不删除 Agent 表、项目 PVC 或第一阶段共用 egress policy。项目数据清理是另一项明确授权。

## 4. 浏览器与独立 operator 验收

```powershell
Set-Location poc4/frontend
$env:MANAO_AI_ACCEPTANCE_PROJECT_ID = '<bootstrap-projectId>'
$env:MANAO_AI_ACCEPTANCE_R0_ID = '<bootstrap-r0Id>'
$env:MANAO_AI_ACCEPTANCE_INITIAL_REVISION = '<bootstrap-initialRevision>'
# BASE_URL/USERNAME/PASSWORD from the owner bootstrap configuration remain required.
```

operator 子进程额外需要以下只读访问。浏览器不获得这些凭据；CLI 只输出脱敏判定 JSON：

| 环境变量 | 约定 |
| --- | --- |
| `MANAO_AI_VERIFY_MYSQL_CMD` | 默认 `mysql`；简单空格分割后直接 spawn，无 shell。优先本机 mysql CLI；容器前缀须由操作者明确把 `MYSQL_PWD` 环境传入容器。不是通用 quoted-command parser |
| `MANAO_AI_VERIFY_DB_HOST/PORT` | operator 数据库入口，默认 `127.0.0.1:3306`；不写入配置 |
| `MANAO_AI_VERIFY_DB_NAME/USER/PASSWORD` | 明确只读账号/目标库；密码仅子进程 `MYSQL_PWD`，禁止 argv/`-p`/arg 模式，不打印原始 stderr |
| `MANAO_AI_VERIFY_KUBECTL` | 默认 `kubectl`，单个可执行文件路径，无 shell |
| `MANAO_AI_VERIFY_KUBE_CONTEXT` | 必须显式提供，只执行该 context 的读取 |
| `MANAO_AI_VERIFY_KUBE_NAMESPACE` | 必须显式提供，只读本轮项目 Service |

```powershell
pnpm test:e2e:ai-stage2
# The first browser scene automatically invokes this SAME-task operator verifier
# BEFORE stopping R2. Standalone use is valid only while its R2 is still active:
node scripts/ai-stage2-verify-ledger.mjs --task-id <canonical-lowercase-task-uuid>
```

两项串行浏览器场景分别验证 HTTP 失败修复链和 owner close 收尾。主场景用既定自然语言任务，不提供修复代码；保留 R0→停止并确认→test0→R1→真实500+日志→停止并确认→receipt写→test0→不同R2→真实200。stop 已返回目标终态且 stoppedConfirmed=true、无 active Run 时可直接继续；尚未确认时才需后续新 status，不强制冗余查询。重载后重新登录并查询同 taskId；真实点击文件树确认修复后的编辑器内容，R2 在运行时尝试编辑被阻止，owner 文件 PUT 精确断言409 PROJECT_LOCKED，正常 stop 后编辑恢复。operator 在 R2 仍 active 时读取 task/tools/全部项目 Runs/receipts/日志，以微秒时间戳判先后，并用 owner API 的 endpoint URL 独立公开 GET；GET 前后核对 active Run、Service labels/完整 selector/主端口/Pod UID。无重定向、无鉴权头转发、无自行选择 URL。

close 场景对同一专用项目创建第二任务，由任务创建一个新 Run，点击 End task，确认该 Run 终态、项目无 active、历史 R2 未被修改。失败若未到达指定触发点，应记录 FAILED/未触发，不能用普通正常停止替代。`--list` 仅发现用例；纯 rows 单测与受控临时修复不构成真实模型证据。

operator `PASS` 也显式带 `stagePassGranted=false`。只有真实模型、正确部署、浏览器两场景、同 task 的独立 ledger/HTTP 与资源核对都具备后，才由 authority 记录授予 `PI_STAGE2_APPLICATION_FEEDBACK_PASS`；不扩展为 CRUD/MySQL 或完整产品验收。

## 5. 清理与证据收口

浏览器正常 stop 和 close 只停止本轮 Run，不删除项目。即使数据库 Run 终态，也必须在获授权的真实验收中独立清点该项目的 development/application Jobs/Pods、稳定 Service 路由、相关 DB 行及无意外 active Run；记录失败/close 场景的真实资源结果。资源归属用 project/task/Run 与 owner 核对，不能按“当前 active”盲删。

项目最终删除只在验收授权包含清理时由 owner API/UI 执行，先停再删并确认最终 404；随后核对 initializer/workspace/Job/Pod/Service/PVC、实际关联 PV/storage residue、关联数据库行，以及本轮确实创建且归属该项目的 NetworkPolicy。第二阶段不新增共用 policy，不删除第一阶段共用 egress。未获删除授权则保留 project/run 清单并记 RETAINED；“0 deleted”和“已验证删除”必须分开。

将发布 commit/digests、bootstrap summary、task/R0/R1/R2、browser attachments、operator JSON、HTTP/日志及实际清理结果写入 [acceptance](../../docs/evidence/ai-stage2/acceptance.md)。剔除 token、password、raw kubeconfig 和不必要临时输出。
