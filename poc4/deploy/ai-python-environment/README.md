# AI Python 环境：发布、验收与回滚

2026-11-04：本页是可审阅发布手册。当前授权仅本地实现、测试、文档和本地提交；镜像发布、运行库迁移、云端故障注入和真实模型调用均 **NOT_RUN**。实际证据由[验收记录](../../docs/evidence/ai-python-environment/acceptance.md)维护。任何后续发布需使用该轮已审查提交及实时目标，不复用历史授权或旧 task。

## 1. 构建与不可变身份

四项运行时产物必须来自同一已审查源码：backend、pi-worker、workspace-agent、python-runner。Task 8 前端展示也需要单独构建/发布 frontend；它是配套 UI 产物，不能因“四产物”而遗漏。Java runner、initializer 和平台 MySQL 镜像保留原身份。

| 产物 | 构建入口 | 当前实际身份与边界 |
| --- | --- | --- |
| backend | `poc4/backend/Dockerfile` | 发布构建/digest NOT_RUN；含 additive V20 |
| pi-worker | `poc4/pi-worker/Dockerfile` | 发布构建/digest NOT_RUN；Pi 1.2.0，可信 environment 与精确 `version` 合同 |
| workspace-agent | `poc4/workspace-agent/Dockerfile` | 本地协议测试 image ID `sha256:89fce304654dd4a2cb1988c0ea89b9b4d29cfc51542e582661bf289d9f160810`，不是 registry RepoDigest；发布 NOT_RUN |
| python-runner | `poc4/python-runner/Dockerfile`，仓库根 context + seed named context | 本地最终测试 image ID `sha256:ba7752aab64e25edc8ae6d3541963f983dc1024a85fad90e54ad9c8799013879`，不是 registry RepoDigest；发布 NOT_RUN |
| frontend | `poc4/frontend/Dockerfile` | `VITE_ENABLE_AI=true`；发布构建/digest NOT_RUN |

获发布授权后从仓库根执行。`MANAO_RELEASE_REGISTRY` 和 `MANAO_RELEASE_ID` 必须由操作者设置，命令不回退到历史仓库或 release。先确认 checkout 干净且 HEAD 是该轮最终审查提交；保留 tag→source SHA→OCI index digest→平台 child digest→实际 Pod imageID 的完整映射。`docker image inspect .Id` 不能替代发布 RepoDigest。

```powershell
git branch --show-current
git status --short
git rev-parse HEAD
if (!$env:MANAO_RELEASE_REGISTRY -or !$env:MANAO_RELEASE_ID) { throw 'Missing MANAO_RELEASE_REGISTRY / MANAO_RELEASE_ID' }
$releaseRepo = $env:MANAO_RELEASE_REGISTRY
$releaseId = $env:MANAO_RELEASE_ID

# 真实 exporter 生成五个模板，包括共享文件和条件依赖；不手写 uv.lock。
$seedOutput = Join-Path (Get-Location) 'poc4/backend/target/python-seed-templates'
mvn -q -f poc4/backend/pom.xml -DskipTests test-compile org.codehaus.mojo:exec-maven-plugin:3.5.0:java '-Dexec.mainClass=com.manao.poc4.workspace.PythonSeedTemplateExporter' '-Dexec.classpathScope=test' "-Dmanao.seed.output=$seedOutput"
docker build -t "${releaseRepo}:ai-python-backend-${releaseId}" poc4/backend
docker build -t "${releaseRepo}:ai-python-worker-${releaseId}" poc4/pi-worker
docker build -t "${releaseRepo}:ai-python-workspace-agent-${releaseId}" poc4/workspace-agent
docker build -f poc4/python-runner/Dockerfile --build-context seed-templates=./poc4/backend/target/python-seed-templates -t "${releaseRepo}:ai-python-runner-${releaseId}" .
docker build --build-arg VITE_ENABLE_AI=true -t "${releaseRepo}:ai-python-frontend-${releaseId}" poc4/frontend
# 在授权发布窗口逐个 push 上述确切 tag，再逐个记录实际 RepoDigest。
```

生产 runner 使用 Dockerfile 默认的最终生产 stage，不发布 `runtime-test`。检查真实 Python 3.13.15 / uv 0.11.6、只读 root-owned helper 和 launcher；backend 保留原 USER/JRE、`-Djdk.httpclient.redirects.retrylimit=1` 与 `-Djdk.httpclient.disableRetryConnect=true`。镜像构建失败须记录真实失败，不能用旧 image ID 填补本次成功。

## 2. 核对目标、排空和 V20

仓库的[backend manifest](../6b/backend.yaml)当前写明 `manao-stage6b` namespace、`MANAO_DB_URL=jdbc:mysql://mysql.manao-stage6b.svc.cluster.local:3306/manao_poc4_6b`。这只是源码配置，不证明云端实时值。发布时从已加载 context、实际 Deployment 和已批准配置解析 namespace/schema；仅输出非秘密目标名称，不打印整个 env、Secret、连接凭据或 kubeconfig。`MANAO_WORKSPACE_AGENT_IMAGE` / `MANAO_PYTHON_RUNNER_IMAGE` 来自 Secret `manao-backend-images`，必须是 `repo@sha256:<64hex>`。`MANAO_AI_PROJECT_ID` 当前仅为兼容读取，不限制提交；不要发明两项目 allowlist 或清空新 gate。

1. 核对实际 namespace/context、目标 schema、当前 Flyway history、四运行产物及 frontend 的旧 digest、replicas/strategy；确认节点容量和私有备份/恢复路径。
2. 通过已批准维护入口停止新任务/compact 准入，等待旧 `QUEUED/RUNNING/NEEDS_ATTENTION` task、live claims、pending dependency/build、terminal receipt/ACK 全部对账。`MANAO_AI_ENABLED=false` 会关闭 beans/internal routes，**不能当作在途任务的排空开关**。浏览器 idle 不能替代全局 worker/持久化检查。历史 null environment 不恢复执行、不推断 Java；只按旧身份完成收尾。
3. 在 disposable schema 演练实际当前版本→V20，保存旧表/任务/操作/receipt 计数、文件摘要和 migration checksum；验证私有备份可恢复。正式运行库禁止 reset/drop。V20 只增加 `agent_task.environment_json JSON NULL` 与 `environment_sha256 CHAR(64) NULL`；历史行保持 NULL，不 backfill。当前运行库是否已到 V19 必须实时确认。
4. 无新准入、全部旧任务排空后执行新 backend 的 Flyway 迁移，确认 V20 success=1 且仅一次，旧 rows/receipts 不变。MySQL DDL 失败先核对真实 columns/history，再决定恢复，不盲目 repair/retry。

只读 SQL 由已授权私有数据库通道执行，不把密码放到参数或输出：

```sql
SELECT version, description, script, checksum, success FROM flyway_schema_history ORDER BY installed_rank;
SELECT id, project_id, state FROM agent_task WHERE state IN ('QUEUED','RUNNING','NEEDS_ATTENTION');
SELECT id, project_id, compact_state FROM agent_conversation WHERE compact_state='RUNNING';
SELECT id, project_id, state FROM `run` WHERE state IN ('STARTING','RUNNING','STOPPING','RECOVERING');
-- V20 成功后，仅统计历史 NULL，不填充：
SELECT COUNT(*) FROM agent_task WHERE environment_json IS NULL AND environment_sha256 IS NULL;
```

精确 dependency/tool/receipt 对账沿用[收尾维护手册](../ai-terminal-settlement/README.md)；不能把活动 Run 当成可自动删除的资源。

## 3. 兼容顺序与已有 Python workspace

在同一维护窗口执行：**排空旧任务 → additive schema → workspace-agent 新协议 → Python runner digest/config → 成套 backend/worker → 配套 frontend → 四模板验证**。迁移可在暂停新准入的新 backend 启动阶段进行；worker 不能提前接受带新 environment 的任务。backend/worker 保留单实例 Recreate，避免旧组件接手新 pending 调用。测试组依赖需要 scoped protocol 3；旧 agent 的 404 必须显式 `PYTHON_DEPENDENCY_PROTOCOL_UNSUPPORTED`，禁止降级 main 或重做 prepare。

更新 Secret 和 backend 只影响**以后创建**的 workspace Pod，已有 Python 项目必须逐项更新：

1. 列出受影响 owner/project、原 Pod UID/container imageID、PVC UID、volume claim、`project-<id>` subPath、源文件/pyproject/lock 摘要及 pending receipts；owner/project 必须来自实际登记，不用全 namespace selector 批量改动。保留 workspace PVC 私有 cache sibling 和项目 MySQL PVC。
2. 确认该 project 无 task/compact/Run 或未决操作，更新新 workspace-agent digest 配置并重启 backend 使配置生效。现有 Pod 通过精确 image 更新（容器重启）或经已批准的缺失 Pod 恢复路径重建；不能重跑项目初始化/模板写入覆盖既有源码。
3. 精确更新示例（仅获该项目维护授权后；全部变量取本轮核实结果）：

```powershell
if (!$env:MANAO_RELEASE_CONTEXT -or !$env:MANAO_RELEASE_NAMESPACE -or !$env:MANAO_RELEASE_PROJECT_ID -or !$env:MANAO_RELEASE_WORKSPACE_IMAGE) { throw 'Missing explicit workspace rollout target' }
$releaseProject = $env:MANAO_RELEASE_PROJECT_ID
if ($releaseProject -notmatch '^[0-9a-f-]{36}$' -or $env:MANAO_RELEASE_WORKSPACE_IMAGE -notmatch '^[a-z0-9._/-]+@sha256:[0-9a-f]{64}$') { throw 'Invalid project or immutable image' }
kubectl --context $env:MANAO_RELEASE_CONTEXT --namespace $env:MANAO_RELEASE_NAMESPACE set image "pod/manao-ws-${releaseProject}" "workspace-agent=$($env:MANAO_RELEASE_WORKSPACE_IMAGE)"
kubectl --context $env:MANAO_RELEASE_CONTEXT --namespace $env:MANAO_RELEASE_NAMESPACE wait --for=condition=Ready "pod/manao-ws-${releaseProject}" --timeout=180s
```

Pod 镜像更新通常保留 Pod UID；必须核对新 containerID/imageID 和重新 Ready，不能仅凭 wait 在旧 Ready 状态上返回成功。若采用精确 Pod 重建，还需确认新 Pod UID、旧 Pod 已退出且原 PVC UID/subPath 相同。两种方式均须核对真实 test-group prepare/commit、原源码/锁/receipt 摘要与 PVC 内容未变；再开放该项目。不要删除 PVC、Service、数据库或未解决的 receipt。

最后配置 `MANAO_PYTHON_RUNNER_IMAGE` 新 RepoDigest，协调新 backend/worker 与 frontend；确认健康、实际镜像及 V20，先 Java console/Spring Boot 原工具链，再 Python console/FastAPI。Python build Job 要使用 Python image 和 `/python-cache`，不得出现 Maven image/goals/cache。记录实际更新过的旧 Python workspace 清单，不能只更新模板镜像就关闭发布步骤。

## 4. 真实模型闭环入口

获得对应发布和模型授权后，操作者新建两个专用 owner-owned READY 项目，名称必须为 `ai-python-acceptance-*`，模板分别 `python-console` / `python-fastapi-web`，MySQL/Redis 均不选择。必须是当前 exporter 原模板、无应用 Run/占用/未决操作；脚本会逐文件比对后才 seed 故障 fixture，拒绝覆盖共享项目或已跑过场景。先完成 §1 exporter；初始 lock 来自真实 uv 模板，后续变更全经 `python_dependencies`，不手工补模型结果。

五个必填变量无默认值，缺失只报变量名；不同项目身份、HTTP(S) origin 无嵌入凭据。凭据仅通过私有环境输入：

```powershell
# 从仓库根；本轮真实目标/私有凭据已由操作者注入，不在日志中打印。
# MANAO_AI_ACCEPTANCE_BASE_URL
# MANAO_AI_ACCEPTANCE_USERNAME
# MANAO_AI_ACCEPTANCE_PASSWORD
# MANAO_AI_PYTHON_CONSOLE_PROJECT_ID
# MANAO_AI_PYTHON_FASTAPI_PROJECT_ID
pnpm -C poc4/frontend exec playwright test --config playwright.ai-python.config.ts
```

该配置没有 webServer、模型 mock 或自动重试，且关闭 trace/screenshot/video 防止凭据进入附件。两场景各验证 test 组 uv 依赖→真实断言失败→main 组依赖→修复→syntax/pytest→当前 Run 事实；第一轮不得改写测试。手动 compact 后同会话第二轮修改、重新验证并运行；FastAPI 使用 `/health/ready` 与 `/api/demo`，console 比对完整日志独立输出行。采集 task/tool/operation/Run 身份、前后 revision/hash 和 owner-safe 结果；真实 provider/model 配置标识及 imageID 由操作者脱敏附录，绝不保存密钥。

脚本不删除项目，FastAPI 成功 Run 保留用于核查；失败不自动重放 mutation/模型请求。实际清理必须另按 owner/project/task 限定核对：无 pending operation/live claim、同 task 的 build Job/Pod 确实不存在、终态和占用释放；应用 Run 与项目 PVC 的保留/停止/删除分别记录。完成本脚本仍须补[验收矩阵](../../docs/evidence/ai-python-environment/acceptance.md)的云故障、Java、图片和资源证据，才可授予闭环标签。

## 5. 回滚

先关闭新能力准入，收尾并对账所有新增 dependency/build/Run 操作；不能让旧 worker/agent 接管未决新协议调用。保存最终 receipt 与原 operation/task identity，未知结果保持占用直到证据闭合。确认全局空闲后恢复配套旧 backend/worker/frontend digest、runner 配置及已更新 Python workspace 的旧 agent digest；每个旧 workspace 仍核对 PVC UID/subPath、文件摘要和新 containerID。新 test-group 项目回退前须验证旧 runner 对其 lock/groups 的兼容，不假设旧镜像可运行。

保留 additive V20、历史 NULL、新 task 快照、锁文件、journal/receipt 和所有 PVC；不删除列、不重置 schema、不删平台 MySQL PVC。旧版本 Flyway 的 future migration/validate 行为必须在 disposable schema 用真实旧产物验证，不能现场关闭 validate 掩盖不兼容。回退后只在专用 disposable 项目验证旧 Java 路径，恢复用户入口前记录真实结果。当前发布、旧产物兼容演练、备份恢复、正式回滚均 **NOT_RUN**。
