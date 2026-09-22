# Java 项目运行时云端验收记录（acceptance.md）

本文件是「Java 项目运行环境升级」（`java-runtime-implementation` 计划）的唯一云端验收记录。

> **当前结论（2026-09-22，Task 8）：PREPARED —— 部署配置与独立云端验收入口已就绪，真实集群部署与验收尚未执行。** 本文件不含任何 PASS 结论。所有未执行项在第 4 节逐条列为 PENDING / NOT_REVERIFIED，待 Task 9 的部署轮执行并在此追加记录。既有 Stage 6B PASS（[stage-6b acceptance](../stage-6b/acceptance.md)）不因本计划改写。

- 记录时间：2026-09-22（+08:00）
- 记录者：Task 8（部署配置与 E2E 入口准备；集群核对全部为只读操作）
- 分支：`codex/java-runtime-implementation`（HEAD `0d90d2d` 之上叠加 Task 8 配置提交）
- 工作树：`D:/DeepLearning/MyProjects/Project_Manao/.worktree/java-runtime-implementation`
- 凭据边界：kubeconfig 与 env 文件位于私有目录；本文件只记录非敏感连接参数与已公开的镜像 digest，不记录密码、token、证书内容。

## 1. Task 8 交付范围

| 交付物 | 位置 | 状态 |
| --- | --- | --- |
| RBAC 增量（namespace Role） | `poc4/deploy/6b/backend-rbac.yaml` | 已改，未 apply（见 4.1） |
| `MANAO_PUBLIC_ENTRY_HOST` 部署配置说明 | `configmap.yaml` / `config.example.env` / README §6.1 | 已改（默认空，启用需两步接线） |
| 新 runtime-deps 配置契约（§6 表） | `poc4/deploy/6b/README.md` §6、§10 | 已记录 |
| 独立 E2E 配置（只收集新 spec、缺 baseURL fail-fast、workers=1、retries=0、无 webServer） | `poc4/frontend/playwright.java-runtime.config.ts` | 已建，收集/fail-fast 已实测（§5） |
| E2E spec（登录、创建、断言入口为实作；含两小时 bounded session 用例） | `poc4/frontend/tests/e2e/java-runtime-lifecycle.spec.ts` | 已建并过类型检查；真实运行 = Task 9 |
| npm script | `pnpm --dir poc4/frontend test:e2e:java-runtime` | 已加 |

`backend.yaml` 不在本任务允许修改的文件清单内；新增 env（`MANAO_RESERVED_PUBLIC_PORTS`、`MANAO_PUBLIC_ENTRY_HOST`、`MANAO_MYSQL_IMAGE_DIGEST`、`MANAO_REDIS_IMAGE_DIGEST`、`MANAO_MYSQL_STORAGE_CLASS`）尚未注入 Pod，README §6/§6.1/§10 明确记录了部署时的接线步骤。这是部署负责人的显式决策点，不是本任务的遗漏。

## 2. 已执行的构建验证（Task 8 实测，2026-09-22）

四条命令在本机全部执行，真实退出码：

| 命令 | 结果 |
| --- | --- |
| `mvn -q -f poc4/backend/pom.xml -DskipTests package` | exit 0（`-q` 静默无输出） |
| `pnpm --dir poc4/frontend typecheck` | exit 0 |
| `pnpm --dir poc4/frontend build` | exit 0，`✓ built in 41.97s`（既有 chunk >500 kB 提示，非本次引入） |
| `docker build -t manao-runner-java-runtime poc4/maven-runner` | exit 0，镜像 `docker.io/library/manao-runner-java-runtime:latest` 构建成功 |

本地 tag `manao-runner-java-runtime` **不是**生产 pin；发布与 digest pin 属 Task 9（见第 4 节第 1 项）。另外两项 Task 8 专项验证：

- `tsc --noEmit`（仓库 e2e spec 无既有 tsconfig 覆盖，与 stage6b spec 同惯例）：`tests/e2e/java-runtime-lifecycle.spec.ts` + `playwright.java-runtime.config.ts` 0 错误。
- Playwright 收集验证（§5）。

## 3. 已执行的部署前核对（Task 8 只读，kubectl/docker 实测）

本轮对集群的全部操作均为只读（get/describe/manifest inspect），无 apply/create/patch。

### 3.1 context 与 namespace — 实测通过

- 本机 kubectl v1.34.1，当前 context `kubernetes-admin@learn`，server `https://127.0.0.1:6443`（Xshell 6443 隧道，本轮在线）。
- 集群 3 节点 Ready：`master`（control-plane）、`node1`、`node2`，v1.31.13，containerd 1.7.13。
- `manao-stage6b` Active；现有工作负载 backend / frontend / mysql-0 均 Running。
- 现行部署镜像与部署 README §0 逐字一致：backend `…@sha256:ac88b11b…09cf`、frontend `…@sha256:a1915ebb…bf86`。

### 3.2 CNI 与 NetworkPolicy — 部分实测

- Calico 在装且健康：`calico-system` 下 `calico-node` 3/3 Ready。
- **PENDING**：NetworkPolicy 的实际执行行为（隔离是否生效）需 Task 9 在一次性 namespace 中实测，本轮不做任何写入。

### 3.3 存储类与数据库存储语义 — 部分实测

- `kubectl get sc`（实测）：`manao-poc4-delete`（nfs-subdir provisioner，Delete reclaim，Immediate）、`nfs-storage`（default，与平台 MySQL 同类）、`openebs-hostpath`（default）。
- 平台 MySQL PVC `data-mysql-0` 使用 `nfs-storage`（实测）。
- **PENDING（决策项）**：每项目 MySQL 数据声明的存储类——`MANAO_MYSQL_STORAGE_CLASS` 留空回退到 `manao-poc4-delete`（Delete reclaim），还是指定保留类；由部署负责人在 Task 9 决策并记录。

### 3.4 NodePort 范围与占用 — 部分实测

- kube-apiserver 启动参数未显式覆盖 `service-node-port-range`（实测）→ kubeadm 默认 30000-32767。
- 当前已被占用的 NodePort（实测，跨全部 namespace）：30080（平台入口）、30180、30562、30880、30990、32601、32686。
- **PENDING（决策项）**：两条测试公网端口由操作者指定（`MANAO_RUNTIME_PUBLIC_PORT_1/_2`），须避开占用清单并写入 `MANAO_RESERVED_PUBLIC_PORTS`；后端在创建时由 API server 对冲突 fail-closed。
- **PENDING**：公网防火墙/安全组对这些 NodePort 的放行规则——本机无法核对，须在服务器侧实测。

### 3.5 镜像 digest 解析 — 实测解析（2026-09-22，docker.io）

`docker manifest inspect --verbose` 实测解析，并复验 digest 可作为拉取引用解析：

| 镜像 | tag | 解析结果（多架构 index digest） |
| --- | --- | --- |
| mysql | 8.0.40 | `mysql@sha256:ed04aca46b6fe0bdc192becc17d358b46eeb82762b81ee65b80feff3d0873e9d` |
| redis | 7.4.11（7.4 系列当前最新显式 patch，Docker Hub tags API 实测列表） | `redis@sha256:95acc00495ddacfec75111ba47021f903121a890311d49264c723b4423ac9601` |

形态约束（代码 `requirePinnedImage` 实读）：后端接受 `mysql:8.0.40`（显式 patch tag）或 `mysql@sha256:<64hex>`（不带 tag 的 digest）；`mysql:8.0.40@sha256:…` 组合形态会被拒绝。部署时可择一并在此追加最终采用值；tag→digest 映射的时点以本节为准，Task 9 部署时如重新解析须记录新值。**无占位/零 digest。**

### 3.6 CPU / 内存预算 — 实测容量数字，余量判定 PENDING

- 节点 allocatable（实测）：master 3600m / ~6.5Gi，node1 7600m / ~13.7Gi，node2 3600m / ~13.7Gi。
- 每项目新增依赖请求（代码常量实测读取）：MySQL requests 250m/512Mi（limits 1 CPU/1Gi），Redis requests 100m/128Mi（limits 500m/256Mi），另加 run Job（Maven）容量。
- **PENDING**：并发项目数 × 上述请求对节点余量的判定由 Task 9 完成；不以「八项目上限」推断容量。

### 3.7 现行集群 Role — 实测确认增量未应用

`kubectl -n manao-stage6b get role manao-backend-workload` 当前仍为旧规则（无 statefulsets/deployments/replicasets/secrets/networkpolicies/pods patch/services patch），与「本任务不执行部署」一致。RBAC apply 属 Task 9（README §10.1）。

## 4. PENDING / NOT_REVERIFIED（Task 9 执行面）

1. **部署执行**：RBAC re-apply；新后端镜像构建/推送/digest pin（`BACKEND_IMAGE`）；运行器镜像推送并解析 `MANAO_MAVEN_RUNNER_IMAGE` digest（§4.2 原则同）；runtime-deps env 注入 `backend.yaml` 的接线与决策；ConfigMap 更新；backend 滚动与 Flyway V9 迁移（迁移身份、不换平台 MySQL 卷、切换窗口不混跑不兼容后端）。
2. **E2E 真实运行**：`pnpm --dir poc4/frontend test:e2e:java-runtime` 全套（含两小时 bounded session 用例），结果与证据追加到本文件。
3. **CNI 策略执行实测**（3.2）；**公网规则实测**（3.4）；**测试端口选择与 reserved ports 配置**；**MySQL 存储类决策**（3.3）；**容量余量判定**（3.6）。
4. 以上任何一项完成前，本计划不得声称任何云端验收 PASS。

## 5. E2E 入口验证（Task 8 实测，未连真实环境）

- `MANAO_RUNTIME_BASE_URL=http://203.0.113.7:30080 pnpm exec playwright test --config playwright.java-runtime.config.ts --list`：收集 5 个用例、1 个 project（`java-runtime-cloud`），无其他 spec 混入。
- 缺 `MANAO_RUNTIME_BASE_URL` 时配置在加载期抛错（fail-fast，实测）；旧 stage6b 配置未改动。
- 默认 localhost 配置扫描本 spec 不抛错（模块级 load-safe gate 实测通过，15 个 collection 项）。
- 用例构成：登录与入口断言 → 创建 web 项目（MySQL+Redis+两条操作者指定公网端口）并等待双依赖 READY → 启动 bounded web run 并经两条端口访问 demo → **两小时用例**（`test.setTimeout(9_300_000)`，全生命周期持续探测、到期后断言停止服务）→ UI 删除项目。无空断言用例；缺凭据/端口在 `beforeAll` 显式抛错，不静默 skip。

## 6. 诚实性边界

- 本轮所有集群核对为只读；digest 解析只读；未执行任何部署动作。
- 3.5 的 digest 是 2026-09-22 的实测解析值，非 Task 9 部署凭据；最终 pin 以 Task 9 部署记录为准。
- 本文件在 Task 9 之前不存在 PASS/FAILED 结论；后续轮次在本文件追加，不回写既有 6B PASS 文档。
