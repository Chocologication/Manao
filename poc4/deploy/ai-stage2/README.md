# Pi 第二阶段发布与验收

2026-10-16用户已授权本阶段镜像发布、配置更新、cluster rollout及真实模型/browser/operator验收，指定端口30003；**当前已发布，阶段PASS仍为NOT_GRANTED**。实际发布、前七轮失败、已审查修复及后续复验边界由 [Stage 2 acceptance §9](../../docs/evidence/ai-stage2/acceptance.md#9-2026-10-16-授权云端发布与真实验收) 统一记录。原发布前NOT_BUILT/NOT_RUN描述是历史快照，当前状态以下表为准。第一阶段真实PASS保留；未授权Git push/merge或项目删除。

## 1. 发布清单

| 组件 | 当前发布状态/源码 | 实际不可变引用 |
| --- | --- | --- |
| backend | 2026-10-18 项目准入`2446ca2`已发布/部署；16/16、本地打包及test1/test2准入对照通过，保留Run recovery修复 | `chocologic/manao_images_repository@sha256:2472a61595c4a9b4f8b27ecf646dbd7f16788e9c935b0090c57f41ac907ba395` |
| pi-worker | 2026-10-18预算`180 tools / 20 builds`已发布/部署；`aa7f282`，72/72+build、独立审查及实际Pod预算核对通过 | `chocologic/manao_images_repository@sha256:33c98b8a95d818d87f02638b64d0b93f69bc796d83802a233c5f964ca2e79a6b` |
| frontend (`VITE_ENABLE_AI=true`) | 已发布/部署工具ID修复；`0589a765edf1b1f6dd246cf1c7814dbd40baff95` | `chocologic/manao_images_repository@sha256:6f803accccd627b9b565507068482e70d0c3c4175566d407d180923536a8e532` |
| Maven runner | 无源码变化，复用已接受镜像 | `chocologic/manao_images_repository@sha256:59a83cb94ac271b24b837f6fe55a27a308cc6f67fee43a46ca628d03fdf85e98` |

以上是各次发布当时已核对的仓库digest及ready Pod身份，最近记录分别为2026-10-18 backend项目准入与worker预算发布。本轮整理的集群API复核timeout/EOF，未取得新实时快照；不把历史发布记录当作本轮实时健康检查。各轮历史镜像、Pod UID及失败记录见acceptance §9.2，后续变更汇总见§9.13。本阶段没有新migration、表、共用NetworkPolicy、initializer或workspace-agent变化；运行库已有V12，不重放V11/V12或重新应用第一阶段共用策略。

2026-10-18 用户明确将工具/构建次数改为180/20，并授权重建镜像推送集群，worker已完成标准构建、push与rollout；实际源码、digest、Pod预算及回退目标由[任务预算记录](../../docs/evidence/ai-task-budget/acceptance.md)拥有。任务总时长仍1800s，不自动续跑旧FAILED任务，不启动模型验收。下文settlement-r5及其Pod是历史发布快照，已由本次新worker替换；其修复行为保留，原Stage 2完整验收继续暂停且NOT_GRANTED。

2026-10-18 用户明确授权后，取消单项目限制的backend已发布，详情由[项目准入记录](../../docs/evidence/ai-project-access/acceptance.md)及其JSON证据拥有。仅backend镜像变化，旧`MANAO_AI_PROJECT_ID`保留但不再生效；其他当前用户拥有且READY的项目沿用revision和互斥校验。回退镜像为`sha256:6d255a093f503c435efc13fcad70daa5cc2bc97f40a930a8df5ee14817eb9846`，回退会恢复单项目限制。原Stage 2完整验收继续暂停，不授予阶段PASS。

2026-10-17 原Stage 2验收收口已暂停，红字故障已独立修复；发布源码/测试/镜像/Pod/浏览器证据与回退引用见 [Run recovery修复记录](../../../docs/superpowers/plans/2026-10-17-run-recovery-contract-fix.md)。该轮只替换backend镜像，未启动模型任务或stop/start应用。以下`3b58568`的原jar/runtime fallback是2026-10-16历史发布；10月17日修复镜像以该旧backend不可变digest为runtime父层，替换已测试jar，保持原USER/ENTRYPOINT/JVM参数。原digest只属于10月17日修复发布的回退目标，回退会重新引入已知恢复缺陷；10月18日准入发布的回退目标见上段，不混用；阶段PASS仍NOT_GRANTED。

历史worker修复`70c09851a894feab5847d19208b61e020d409552`已独立Approved、66/66及build PASS，`settlement-r5`当时实际push/rollout。旧Pod=`manao-pi-worker-5fcff5cd77-68kwf`、UID=`8165f493-0e17-4f8c-a14d-e7a5e50deb92`的ready/imageID核对仅证明当时`242369ef…`发布，已被上表预算镜像替换。该修复分离10秒admission与原720秒settlement，对真实unknown复用任务abort/fatal失败，当时不提高预算、不改backend/SDK/migration；第七轮operator COLLECTION_RUN_CHANGED导致1 failed / 1 not run、close未触发，首次快照未留存、原因UNKNOWN，原验收调查已暂停；后续三次operator PASS不覆盖原失败（acceptance §9.10/9.13）。不回退旧worker或放宽判定。

后续判定器`77fe238`及harness collector `668eb0c`已独立Approved，104/104（8 helper+96 verifier）及stage6 typecheck通过；它们仅改变验收harness，无需镜像rollout，不将分支新HEAD误记为镜像源码。progress工具详情404单独记录为missingIds，须由独立ledger验证其与已登记ID不相交；不能忽略已登记的unknown结果。

实际backend标准多阶段构建停在`dependency:go-offline`，未完整成功；本轮使用本地缓存Maven package产物（BUILD SUCCESS、7.181s），jar SHA256=`e7c4d55a6696fc2b0b7fbf3e8021c66c4cbd6fc2994ddbcb16bd6fbd8b11ec88`，复制到`eclipse-temurin:17.0.13_11-jre@sha256:38e0afc86a10bf4cadbf1586fb617b3a9a4d09c9a0be882e29ada4ed0895fc84` runtime层后构建/push。原Docker多阶段路径不记PASS；维护时须保留artifact/source/runtime对应关系和两项JVM参数，不用相同tag代替digest核对。

以下保留标准构建入口供后续已授权发布使用，`<release>`为命令模板，不是当前digest记录；本次backend实际采用上文fallback。每次从最终审查提交记录commit、tag、push输出和仓库digest：

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

backend Dockerfile及fallback runtime必须保留JVM启动参数`-Djdk.httpclient.redirects.retrylimit=1`与`-Djdk.httpclient.disableRetryConnect=true`。本地直接启动jar时也必须显式提供；PowerShell的`-D`参数须整体加引号。确切JRE 17.0.13的丢响应单例已本地验证，本次runtime镜像已部署执行；这不把未完成的标准多阶段构建记为PASS。

## 2. 专用项目 bootstrap

本次实际context=`kubernetes-admin@learn`、namespace=`manao-stage6b`，frontend=`http://1.12.245.235:30080`；专用projectId=`905da5ae-40ef-469e-ba2b-5c0fd202070a`，端口30003→8080，endpoint=`http://1.12.245.235:30003/`。各轮seed revision/R0及Run见acceptance §9.3/§9.6–9.11；第三至六轮R2已owner-stop/确认/reseed，第七轮fresh R0=`61d9e696-9546-478e-b4a5-a64f27f415e6`、revision42、readyAt=`2026-10-16T16:25:16Z`。不得把旧轮R0当作后续复验环境变量。本项目RETAINED，未授权删除。

第五轮修改固定fixture的真实模型失败保持FAILED；prompt澄清`7949823`已独立Approved，只明确固定测试完整路径不可改删追加、可另建测试，未提供修复代码或放宽判定。已恢复原fixture SHA及seed controller，第六轮固定fixture未改，但operator以AMBIGUOUS_TOOL_ORDER拒绝，实际1 failed / 1 not run、close未跑；已确认worker在10秒提前unknown、后台build继续而与后续status重叠，validator正确拒绝。修复`70c0985`已GREEN、独立Approved并部署settlement-r5，第七轮保留COLLECTION_RUN_CHANGED失败，原因待查。第六轮新增extra test经路径/SHA核验及诊断备份后单次owner DELETE成功，固定fixture原SHA保留、controller已恢复；不扩大项目资源删除授权。

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

保存其 `projectId`、`initialRevision`、`r0Id`、`endpoint` 与 `testFixtureSha256`。2026-10-18 的[项目准入修改](../../docs/evidence/ai-project-access/acceptance.md)已授权发布：`MANAO_AI_PROJECT_ID` 仅兼容读取，不再限制提交，不需随 bootstrap 切换。验收脚本仍须明确使用本轮项目身份，不能复用旧第一阶段项目；旧镜像依然遵守原单项目限制。

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
