# AI 第一阶段部署资产（poc4/deploy/ai-stage1）——仅发布准备

本目录存放 AI 第一阶段验收（pi-stage1 计划 Task 6）的已审阅发布准备：待构建镜像、V11 迁移、开发构建网络策略与回滚路径。**这里的每个执行步骤都等待用户明确授权。** 本轮没有任何内容应用到 `manao-stage6b`、其数据库或任何共享集群；本文件不修改任何现有 6B 资源或私有配置。

文件：

| 文件 | 用途 |
| --- | --- |
| `README.md` | 本发布准备：镜像、迁移、上线顺序、回滚、验收操作手册 |
| `pi-worker.yaml` | 可审阅的 worker Deployment + Service，带占位符（digest、token、模型 Secret）；单实例、Recreate、worker 私有 emptyDir、无 SA token——仅在获授权后应用 |
| `development-network-policy.yaml` | 开发构建 Pod 的 manifest 层出口隔离（仅 DNS + 公网 HTTP/HTTPS）。真实 CNI enforcement 在本轮获得集群授权前为 NOT_RUN |

状态（2026-10-14）：源码 Tasks 1–5 已实现并本地验证；harness、fixture 与发布准备已编写并通过静态检查。真实模型闭环、集群 rollout、CNI enforcement 实测与浏览器 E2E 为 NOT_RUN——确切缺失条件见
[poc4/docs/evidence/ai-stage1/acceptance.md](../../docs/evidence/ai-stage1/acceptance.md)。`PI_STAGE1_CODE_TEST_LOOP_PASS` 为 NOT_GRANTED。

## 1. 前置条件（每项都必须在本轮开始前真实存在）

| 要求 | 说明 |
| --- | --- |
| 云端模型 provider 配置 | `MANAO_AI_PROVIDER` / `MANAO_AI_API_TYPE` / `MANAO_AI_BASE_URL` / `MANAO_AI_MODEL` / `MANAO_AI_API_KEY`，只在 **worker 侧**。截至本轮不存在真实密钥；本轮不得编造密钥、不得换 mock、不得自行选择付费 provider |
| 操作者机器上的 Docker | 本轮已确认可用（29.8.1），用于隔离本地检查 |
| 本地演练用 disposable MySQL | 本地 MySQL 可用；仅用 disposable schema——禁止重置 `manao_poc4` 或 `manao_poc4_6b` |
| 验收 K8s context/namespace | 集群操作（rollout、策略应用、enforcement 实测）是另一项需用户单独授权的操作 |
| 验收账号 | 验收部署的用户名/密码（私有 env 文件，绝不提交） |

配置检查只允许核实必要字段非空；绝不打印秘密。

## 2. 待构建与发布的镜像（digest 在发布时记录）

从承载已验收第一阶段代码的检出（`codex/ai-integration`）构建；把每个 `...@sha256:<64 hex>` digest 记入私有 env 文件与验收记录。本地测试 tag 不是发布引用——绝不部署浮动 tag。

```bash
# 2.1 Backend (contains the V11 Flyway migration; applied at startup, section 3)
mvn -q -f poc4/backend/pom.xml -DskipTests package
docker build -t chocologic/manao_images_repository:ai-stage1-backend-<yyyymmdd> poc4/backend
docker push chocologic/manao_images_repository:ai-stage1-backend-<yyyymmdd>
docker inspect --format '{{index .RepoDigests 0}}' chocologic/manao_images_repository:ai-stage1-backend-<yyyymmdd>

# 2.2 Frontend — MUST be built with the AI panel switch on (build-arg added in
#     poc4/frontend/Dockerfile; the accepted default stays false for other rounds)
docker build --build-arg VITE_ENABLE_AI=true \
  -t chocologic/manao_images_repository:ai-stage1-frontend-<yyyymmdd> poc4/frontend
docker push chocologic/manao_images_repository:ai-stage1-frontend-<yyyymmdd>
docker inspect --format '{{index .RepoDigests 0}}' chocologic/manao_images_repository:ai-stage1-frontend-<yyyymmdd>

# 2.3 Pi worker (model key arrives only through the runtime environment, never the image)
docker build -t chocologic/manao_images_repository:ai-stage1-pi-worker-<yyyymmdd> poc4/pi-worker
docker push chocologic/manao_images_repository:ai-stage1-pi-worker-<yyyymmdd>
docker inspect --format '{{index .RepoDigests 0}}' chocologic/manao_images_repository:ai-stage1-pi-worker-<yyyymmdd>

# 2.4 Maven runner (adds the root-owned manao-dev-build launcher; unchanged since Task 3)
mvn -q -f poc4/backend/pom.xml -DskipTests test-compile \
  org.codehaus.mojo:exec-maven-plugin:3.5.0:java \
  -Dexec.mainClass=com.manao.poc4.workspace.MavenSeedTemplateExporter -Dexec.classpathScope=test \
  "-Dmanao.seed.output=<abs path>/maven-seed-templates"
docker build --build-context "seed-templates=<abs path>/maven-seed-templates" \
  -t chocologic/manao_images_repository:ai-stage1-runner-<yyyymmdd> poc4/maven-runner
docker push chocologic/manao_images_repository:ai-stage1-runner-<yyyymmdd>
docker inspect --format '{{index .RepoDigests 0}}' chocologic/manao_images_repository:ai-stage1-runner-<yyyymmdd>
```

initializer 与 workspace-agent 镜像无需重建（Task 6 约束："初始化cache和workspace-agent镜像不需重构"）。

## 3. V11 迁移（`V11__agent_tasks.sql`，随 backend 镜像携带）

纯新增：两张新表（`agent_task`、`agent_tool_call`）、项目外键、以及限制每项目一个占用任务的生成列 `active_project` 唯一索引。不修改任何现有表、行或列。新 backend 针对 `manao_poc4_6b` 启动时 Flyway 自动应用 V11。

- 应用它会触碰运行库——这正是 rollout 需要用户明确授权的原因。
- 回滚（仅当无进行中任务，且仅在获授权时）：`DROP TABLE agent_tool_call; DROP TABLE agent_task;`——两张表是纯新增；删除它们不会影响 project/run/workspace 数据。
- V12（`V12__agent_task_verified_writes.sql`，审查修复 I1）以同样方式携带：`agent_task` 上两个可空列（`settled_revision`、`changed_paths_json`），记录最新已核实写入 revision 与去重后的修改路径。修复后 backend 首次启动时 Flyway 会与 V11 一起应用；除随上述两张表一起删除外，无需其他回滚。

## 4. Worker 配置契约（模型密钥只在这里）

| 变量 | 含义 |
| --- | --- |
| `MANAO_AI_WORKER_PORT` | HTTP 端口（默认 18090） |
| `MANAO_AI_WORKER_TOKEN` | backend 访问 `/tasks/*` 时出示的共享密钥；为空则所有路由关闭 |
| `MANAO_AI_INSTANCE_ID` | 稳定实例标识（可选） |
| `MANAO_AI_BACKEND_BASE_URL` / `MANAO_AI_BACKEND_TOKEN` | backend 内部路由 + 内部 token |
| `MANAO_AI_SCRATCH_DIR` / `MANAO_AI_AGENT_DIR` / `MANAO_AI_SESSION_DIR` | worker 私有路径；绝不是用户项目，绝不是共享卷 |
| `MANAO_AI_PROVIDER` / `MANAO_AI_API_TYPE` / `MANAO_AI_BASE_URL` / `MANAO_AI_MODEL` / `MANAO_AI_API_KEY` | 真实云端模型配置；截至本轮无真实值 |

已核实的 worker 行为（组件演练，验收记录第 4 节）：任一模型字段缺失时，worker 仍能启动供健康检查，但**拒绝一切任务启动，固定返回 503 `AI_WORKER_NOT_CONFIGURED`**，backend 将其转为任务启动前的显式失败。任务启动绝不静默 mock。

backend 侧（`manao.poc4.ai.*` / env）：`MANAO_AI_ENABLED=true`、`MANAO_AI_PROJECT_ID=<bootstrap id>`、`MANAO_AI_WORKER_BASE_URL`、`MANAO_AI_WORKER_TOKEN`、`MANAO_AI_INTERNAL_TOKEN`（后两个是秘密）。backend 永远收不到模型密钥。

## 5. 上线顺序（单 worker、单 backend——更新不重叠）

仅在获授权后执行；涉及的所有 Deployment 均为 `Recreate`（replicas 1），新旧永不重叠：

1. 把 `development-network-policy.yaml` 应用到验收 namespace，然后完成其头部注明的操作者职责（公网管理面排除项），并规划 CNI enforcement 实测——仅策略资源本身不是证据。
2. 把新 runner digest 发布进镜像 Secret（`manao-backend-images`），让下一次开发构建用上 `manao-dev-build`。
3. 应用 `pi-worker.yaml`（Deployment + Service，占位符已填：发布的 worker digest、按第 4 节填写的 Secret 值——`manao-pi-worker-secrets` 与 `manao-pi-worker-model`）。核实恰好一个 worker pod，且 backend 能连通 `manao-pi-worker:18090`。部署期验证项（审查修复 I5）：pod 运行后，证明 UID 1000 下对 `/work/agent` 的真实首次写入（例如 `kubectl exec` 一次已配模型密钥的启动并确认 `models.json` 出现）——manifest 的 `fsGroup: 1000` 在这里只是静态检查；挂载目录可写性只有在集群上观察到才是真的。
4. 更新 backend Deployment（新镜像；按第 4 节补充 env）。启动时执行 Flyway V11（第 3 节）。核实恰好一个 backend pod。
5. 用 `VITE_ENABLE_AI=true` 镜像更新 frontend Deployment。核实工作台出现 AI tab。

## 6. 回滚

| 步骤 | 动作 |
| --- | --- |
| 最快行为回滚 | backend 设 `MANAO_AI_ENABLED=false`（AI beans、浏览器路由与内部路由直接消失）；worker 缩到 0 |
| Backend 镜像 | 重新部署上一个已记录 digest；frontend 继续工作——AI tab 只在 frontend 一并回滚时才消失 |
| Frontend 镜像 | 重新部署上一个已记录 digest（面板消失；项目数据不动） |
| Worker | 删除 worker Deployment/Service（没有其他组件依赖它） |
| V11 表 | 第 3 节回滚，仅当无进行中任务且仅在获授权时 |
| Runner digest | 恢复 `manao-backend-images` 的上一个 runner 值；新构建 pod 中 `manao-dev-build` 消失 |

任何回滚步骤都不删除项目数据；task 与 tool 行是纯新增。

## 7. 验收操作手册（授权之后）

```bash
# 1. Bootstrap the dedicated project against the running acceptance backend
node poc4/frontend/scripts/ai-stage1-bootstrap.mjs
#    (records projectId + initial revision + fixture sha256 in its JSON summary)

# 2. (Re)start the acceptance backend with MANAO_AI_ENABLED=true and
#    MANAO_AI_PROJECT_ID=<recorded id>; start the worker with REAL provider values.

# 3. Run the browser acceptance
cd poc4/frontend
MANAO_AI_ACCEPTANCE_BASE_URL=<entry url> \
MANAO_AI_ACCEPTANCE_USERNAME=<acc user> \
MANAO_AI_ACCEPTANCE_PASSWORD=<acc password> \
MANAO_AI_ACCEPTANCE_PROJECT_ID=<recorded id> \
pnpm test:e2e:ai-stage1

# 4. MANDATORY operator evidence verification (the browser cannot see the ledger;
#    this step is part of the verdict, not optional corroboration). Read-only DB
#    access for the operator; the script issues SELECTs only and the browser never
#    holds these credentials.
MANAO_AI_ACCEPTANCE_TASK_ID=<taskId> MANAO_AI_ACCEPTANCE_PROJECT_ID=<recorded id> \
MANAO_AI_ACCEPTANCE_INITIAL_REVISION=<recorded initial revision> \
MANAO_AI_VERIFY_DB_HOST=<db host> MANAO_AI_VERIFY_DB_PORT=3306 \
MANAO_AI_VERIFY_DB_NAME=<schema> MANAO_AI_VERIFY_DB_USER=<readonly user> \
MANAO_AI_VERIFY_DB_PASSWORD=<secret> \
[MANAO_AI_VERIFY_MYSQL_CMD="docker run --rm -i mysql:8.0.40 mysql"] \
node scripts/ai-stage1-verify-ledger.mjs
#    PASS requires: task COMPLETED; EVERY tool call COMPLETED; the first build with
#    a real non-zero exit; a receipted write to DemoController after it; a later
#    goal=test build exit 0 with cleanupConfirmed and full Job identity; the
#    DemoControllerAcceptanceTest Surefire report tests>=1 / failures=errors=
#    skipped=0 (missing report or reportsDropped fails).

# 5. MANDATORY independent re-verification of the SAME task's saved source through
#    the same read-only-copy executor path (manao-dev-build copy on a read-only
#    /source mount, operator pom overlay on the scratch only, manao-dev-build run
#    test with NO /source mount), asserting the Surefire report from the fixed
#    log-tail markers:
node scripts/ai-stage1-independent-reverify.mjs --api \
  --image chocologic/manao_images_repository@sha256:<runner release digest>
#    (the isolated local drill uses --source <dir> instead of --api; both modes
#    are the operator's container-equivalent path of DevelopmentBuildExecutor)

# 6. Delete the round's dedicated project (UI/API) and verify leftovers
#    independently (resources, rows); record everything in the acceptance record.
```

独立验收构建复验（fixture + `acceptance-pom.xml` 经只读-copy executor，Surefire XML 要求 tests>=1 且 failures/errors/skipped=0）属于本轮证据的一部分；fixture 与 pom 已在隔离本地演练中真实跑过（验收记录第 3 节）。
