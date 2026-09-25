# Java 项目运行时云端验收记录（acceptance.md）

本文件是「Java 项目运行环境升级」（`java-runtime-implementation` 计划）的唯一云端验收记录。

> **当前结论（2026-09-22，Task 8 + C3 部署/验收轮）：集群部署与迁移完成；E2E 非 7200s 用例轮与 Maven 缓存专项验收 PASS（第 8 节）；正式 7200s 用例 WAIVED_BY_USER（用户自测，未执行）；一个验收遗留项 DELETING 待操作者处理（8.8）。** 既有 Stage 6B PASS（[stage-6b acceptance](../stage-6b/acceptance.md)）不因本计划改写。第 7 节为当日上午的服务器不可达记录（已恢复）。
>
> **2026-09-25 追加（第 9 节）：端口预检发布轮部署完成并通过 409 无副作用验证（PASS）；无 Actuator 的导入应用就绪限制记录为文档化限制（9.3，非通过项）。** 上述 2026-09-22 结论保持不变。

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

## 7. C3 / Task 9 部署轮（2026-09-22）——集群侧 BLOCKED

记录者：C3 实现轮（Maven 缓存补充计划的发布与集中运行验收，并入 Task 9 部署轮）。
本节区分：已完成并留证的事项（D完成）、集群侧被连通性阻塞的事项（BLOCKED）、因此全部未验证的事项（NOT_REVERIFIED）。无任何 PASS。

### 7.1 已完成（D完成，仓库与镜像层面，全部留证）

| 事项 | 结果 | 证据 |
| --- | --- | --- |
| runtime-deps env 仓库接线 | 提交 `2ce008f`（feat: wire runtime deps env into backend deployment）：backend.yaml 注入 5 个 runtime-deps 变量（configMapKeyRef）；configmap.yaml 增加 5 键（`MANAO_RESERVED_PUBLIC_PORTS=30080,30281,30282`、`MANAO_PUBLIC_ENTRY_HOST=1.12.245.235`、mysql/redis digest pin、`MANAO_MYSQL_STORAGE_CLASS=""`=回退 manao-poc4-delete 的操作者决策及理由）；config.example.env 与 deploy/6b、maven-runner README 同步 | YAML 解析验证通过（Service/Deployment/ConfigMap，20 个 env 名单核对）；`git diff --check` 干净 |
| backend 镜像重建推送 | tag `java-runtime-backend-20260922b` = `chocologic/manao_images_repository@sha256:88ebf51b2b46da1cc9f2cdd5b9975d3d899785c488db016805834f1da7ef99c0`（index digest，`docker buildx imagetools inspect` 与 push 输出一致） | host `mvn -DskipTests package` exit 0；docker build/push exit 0 |
| runner 镜像重建推送（seed 构建） | tag `java-runtime-runner-20260922b` = `chocologic/manao_images_repository@sha256:d0387b17ff42768aa864a340e9fb4b07d38d5d9b0c6caacf03e292e772fa2412`；seed-id 实测 `4ef64a46b63a89bb21b84031b2eebe9928fdadb01a93185fc271bfc64ba7fda8`；seed 仓库 158M / 3115 文件 | 从导出的真实模板经 named context `seed-templates` 构建（exporter exit 0，导出 5 变体）；镜像内 `cat /opt/manao-maven-seed/seed-id` 实读 |
| C2 审查遗留复核：commons-text 是否在 seed | **坐标 `org.apache.commons:commons-text:1.13.0` 确认不在 seed**（seed 内仅 1.12.0 与 1.3）；其依赖 commons-lang3 3.14.0 与 commons-parent 50 已在 seed → 该坐标是真实缺失，可直接用作"未预置依赖"验收用例 | 镜像内 `ls /opt/manao-maven-seed/repository/org/apache/commons/…` 实测 |
| 部署前置私有值 | 私有 env 文件（仓库外）`BACKEND_IMAGE`/`MANAO_MAVEN_RUNNER_IMAGE` 已更新为上述新 digest；凭据未接触 | 值仅写入仓库外私有文件 |
| 部署与验收脚本备妥 | `deploy-runbook.sh`（RBAC→secret→configmap→backend/frontend apply→rollout→V9 日志取证）与 `cache-acceptance.sh`（API 驱动的缓存验收步骤）已置于 gitignored 的 `.superpowers/sdd/2026-09-22-java-maven-cache-implementation-plan/`，供恢复后执行 | 文件存在；未提交（含流程不含凭据，但属临时工作文件） |

### 7.2 BLOCKED：服务器自本机全面不可达（2026-09-22 约 16:53–17:38 持续实测）

诊断过程与证据（全部为只读网络探测，无凭据输出）：

1. 默认 kubeconfig 走 `https://127.0.0.1:6443`（Xshell 隧道，Task 8 同路径）：本机 6443 无监听（`netstat` 实测），即 Xshell 隧道断开。Xshell.exe 进程在运行但其隧道未转发。
2. 公网 API server `https://1.12.245.235:6443`（私有目录 stage6b-admin-public.yaml）：TCP 可建连但 TLS 握手无响应（curl 000 / kubectl "EOF→deadline"）。
3. SSH `root@1.12.245.235:22`（三把本机密钥逐一尝试）：TCP 建连后在 SSH banner 交换前被对端关闭（`kex_exchange_identification: Connection closed by remote host`），无法重建隧道。
4. 公网入口 `http://1.12.245.235:30080`：TCP 建连后空回复/超时（HTTP 000），约 45 分钟内 20+ 次轮询全部失败。
5. 排除本机代理因素：本机 FlClash（TUN/fake-ip）在运行，但 baidu.com / cloud.tencent.com 等同路由目标均正常（200，亚秒），仅该服务器 IP 不可达 → 结论为服务器侧/安全组/公网 IP 状态问题，非本机网络或代理配置问题。

**结论：所有集群写入与验证操作无法执行。** 按红线"任何环境核对/验收不能执行就如实记 NOT_REVERIFIED/BLOCKED"，本节以下各项记 BLOCKED，不猜测、不代执行。

### 7.3 BLOCKED 清单（恢复连通后按备妥脚本执行）

| 事项 | 状态 | 恢复后动作 |
| --- | --- | --- |
| backend-rbac.yaml re-apply、manao-backend-images secret 重建、configmap/backend.yaml/frontend apply、rollout | BLOCKED | `deploy-runbook.sh`（§7.1 已备妥），含 V9 迁移日志取证与旧项目列表核对 |
| runner 镜像预拉（node1/node2 一次性 Job） | BLOCKED | 部署完成后按 dispatch 计划执行；无法预拉则如实记录冷镜像条件 |
| E2E 非 7200s 用例轮（`--grep-invert "whole lifetime"` 排除两小时用例；BASE_URL/30281/30282 + 私有凭据） | BLOCKED | 恢复后执行并回填 |
| Maven 缓存专项验收（三类耗时、缓存命中文件/传输证据、commons-text 1.13.0 首次下载与复用、旧 PVC 补建、跨项目隔离、停止保留、删除回收） | BLOCKED | `cache-acceptance.sh` + kubectl 独立事实检查（Job 日志分段计时、debug pod 只读清点缓存目录） |
| 验收项目/辅助项目清理与逐类回收核对 | BLOCKED | 随验收轮执行；不触碰平台 MySQL 卷与 30080 入口 |
| 正式 7200 秒用例 | WAIVED_BY_USER（用户本人执行，本计划不代跑） | 用户自测后由用户/后续轮记录 |

### 7.4 状态分类汇总（本节）

- D完成（留证）：§7.1 六项。
- BLOCKED：§7.3 前五项（全部集群侧）。
- WAIVED_BY_USER：正式 7200 秒用例（尚未执行，等待用户自测结果）。
- NOT_REVERIFIED：全部云端验证结论（V9 迁移、E2E、缓存命中、回收核对等）——在 §7.3 完成前本功能不得声称任何云端 PASS。

## 8. C3 部署与验收结果（2026-09-22 下午，集群恢复后完成）

记录者：C3 实现轮。服务器连通性恢复后，全部集群操作按部署 README 执行；每项操作均有命令级证据。状态分类见 8.9。

### 8.1 部署（PASS）

| 步骤 | 结果 |
| --- | --- |
| backend-rbac.yaml re-apply | configured；Role 新增 statefulsets/deployments/replicasets/secrets/networkpolicies、services patch/update、pods patch |
| manao-backend-images secret 重建 | BACKEND_IMAGE=20260922d digest、MANAO_MAVEN_RUNNER_IMAGE=20260922b digest（base64 解码核对）；agent/initializer digest 未变 |
| configmap apply | 7 键齐备（§6 表）；reserved ports = 30080（见 8.7 修正记录） |
| backend apply + rollout | `chocologic/manao_images_repository@sha256:0cae66130092bd44118d3ed13d8a6b1d49047f14f926fddf7035eb6143b2691c`（tag `java-runtime-backend-20260922d`），rollout success |
| frontend apply + rollout | `chocologic/manao_images_repository@sha256:eb220fb290e91612758310c79ecbc6d9b3f444ba886bf4582fbecd249352363d`（tag `java-runtime-frontend-20260922c`），rollout success；30080 返回 200 |
| V9 迁移 | `Migrating schema manao_poc4_6b to version "9 - project runtime"` → `now at version v9 (execution time 00:00.311s)`；后端重启后 `Schema is up to date`；迁移前后 project/run 行数完好（迁移前 0 行） |
| 旧项目列表 | API 返回正常（app_user 名下 0 个旧项目；DB 0 行，无数据丢失面） |
| runner 镜像预拉 | node1/node2 各一个一次性 Job（pin `sha256:d0387b17…2412`）成功；node2 事件实测 `Successfully pulled image … in 22.316s, Image size: 357419877 bytes`，node1 Job 25s 完成；两节点镜像就绪后清理 Job |

### 8.2 E2E 非 7200s 用例轮（PASS，4/4）

命令：`MANAO_RUNTIME_BASE_URL=http://1.12.245.235:30080 MANAO_RUNTIME_PUBLIC_PORT_1=30281 MANAO_RUNTIME_PUBLIC_PORT_2=30282 pnpm --dir poc4/frontend test:e2e:java-runtime --grep-invert "whole lifetime"`（凭据经环境变量注入，两小时用例按计划排除）。

| 用例 | 结果 |
| --- | --- |
| 登录 + 运行时工作台 | PASS（0.8–1.1s） |
| 创建 web 项目（MySQL+Redis+端口 30281/30282） | PASS（热镜像下 23.1s 到 READY，MySQL/Redis 均 READY，端口按输入精确分配） |
| 启动 bounded web run，双公网端口各返回 demo | PASS（run 全程 1.3m：含首跑 seed+编译+启动；`firstReadyAt` 武装、`expiresAt`=+7200s、SERVICE kind、双端口 `/api/demo` 200） |
| 停止遗留 run + UI 删除项目 + 卡片消失 | PASS（1.4m；删除后 API 列表为空、PVC 即时回收） |

完整 4/4 于 2026-09-22 22:31–22:34(+08:00)（attempt 15）。此前 attempt 12 的同轮前 3 用例亦 PASS。

### 8.3 Maven 缓存专项验收（PASS）

专用主项目（web 模板、无依赖、无公网端口；API 驱动创建/编辑/启停/删除，K8s/存储检查为独立事实）。运行镜像 seed-id=`4ef64a46b63a89bb21b84031b2eebe9928fdadb01a93185fc271bfc64ba7fda8`（158M / 3115 文件）。

| Run | 缓存前置 | start (Z) | firstReadyAt (Z) | 耗时 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 首跑 | 空 | 14:43:39 | 14:44:37 | **58s** | 容器 14:43:42 起；App Started 14:44:36.8（JVM 内 2.1s）；seed 复制+编译合并段 ≈52s（`-q` 无中间日志，不强行拆分） |
| 2 复用 | 3115 文件+marker | 14:47:54 | 14:48:01 | **7s** | marker 命中 → 无复制；App 1.6s |
| 3 加 commons-text:1.13.0 首下 | 3115 | 14:49:02 | 14:49:10 | 8s | pom 经文件 API 编辑；新增 8 个文件（见下） |
| 4 复用 1.13.0 | 3123 | 14:51:02 | 14:51:09 | 7s | 文件清单与 mtime 集合与 run 3 后完全一致 → 无重下 |
| 5 旧 PVC 补建（模拟：删除 `.manao-cache/maven` 目录） | 空 | 14:58:25 | 14:59:23 | **58s** | 目录重建+全量补种+1.13.0 按需重新获取（pom 仍声明） |

缓存命中/传输证据（只读 debug pod 清点，挂载工作区 PVC）：

- Run 1 后：`seeded-4ef64a46…` marker 存在，3115 文件，**0 个文件晚于 marker**。
- Run 3 后：3115→3123；晚于 marker 的文件恰为 `commons-text/1.13.0/{jar.sha1,pom.sha1,_remote.repositories}` + `commons-parent/78/{pom.sha1,_remote.repositories}` —— 精确的最小下载集（1.13.0 的 parent POM 版本 78 未在 seed，seed 内为 50）。
- Run 4 后：文件数与"晚于 marker 集合"与 Run 3 后逐项一致 → 无重复下载。
- Run 5 后：3123 文件齐备，1.13.0 按需重新获取，marker 重新发布。
- C2 审查遗留复核：`commons-text:1.13.0` 确认不在 seed（仅 1.12.0/1.3），依赖 commons-lang3 3.14.0、commons-parent 50 在 seed。

跨项目隔离：辅助项目独立运行后其缓存为 3115 文件（自身 marker），`commons-text/` 仅含 1.12.0/1.3 —— **不含主项目新增的 1.13.0**，跨项目缓存隔离成立。

创建到可编辑（同一验收项目 cache-main-224249 / c60f6218）：14:42:49Z 创建（POST 返回 201/CREATING），14:43:11Z 首次状态轮询已 READY → 耗时 ≤22s（5s 轮询间隔，精确值落在创建与首次轮询之间；含工作区 agent 启动与模板写入全链路）。

预期业务响应：各 Run 的就绪由平台服务端就绪验证确认（supervisor probe 通过 → receipt state=READY → firstReadyAt 武装）。显式 HTTP 业务断言在同轮 E2E 用例 "start the bounded web run and serve the demo app through both assigned ports"（attempt 15）实测：两公网端口 GET /api/demo 均 200 且响应体含 "Hello from Manao"（spec 断言 DEMO_GREETING，expectPortServesDemo 辅助函数）。cache-main 项目自身未做直连业务端点探活（无公网端口、未使用 port-forward）——该直连探活记 NOT_REVERIFIED，其功能面由同模板 E2E 业务断言与平台就绪验证覆盖。

停止后缓存保留：Run 1→2、2→3、3→4 均经 stop→新 run，各次盘点显示缓存持续存在且未被清理。

镜像拉取与运行启动分离：runner digest 已预拉至两 worker（8.1），Run 时无拉取开销；冷拉取成本以预拉事件（22.3s/357MB）单独记录。

### 8.4 删除与资源回收（PASS，含一处遗留）

- E2E 项目（9b258d43…，含 MySQL/Redis 独立 PVC）：删除 204，`manao-mysql-pvc-*` 与 `manao-pvc-*` 即时回收，MySQL 数据 PVC 契约不变（独立 PVC、Delete 回收）。
- 验收主项目/重复项目/辅助项目：删除 204，各自 workspace PVC 回收；删除后集群仅剩平台 3 pod（backend/frontend/mysql-0）、平台 `data-mysql-0`，无残留 run Job/pod。
- SQL 核对：删除后 `project` 行仅剩遗留项 1 行、`project_storage_binding` 1 行（对应遗留项）。
- 平台入口 30080 与平台 MySQL 卷全程未受影响。

### 8.5 正式 7200 秒用例：WAIVED_BY_USER

按计划由用户本人执行新镜像下的完整两小时用例；本计划不代跑。E2E 轮已验证的相邻事实：SERVICE run 的 readiness 武装、`expiresAt`=+7200s 不可变、停止→CANCELLED、到期语义未在本轮复验（用户自测覆盖）。

### 8.6 验收过程中发现并修复的缺陷（全部 TDD/提交）

| # | 缺陷 | 修复/提交 | 验证 |
| --- | --- | --- | --- |
| 1 | 前端创建表单依赖 `crypto.randomUUID`（仅 secure context），HTTP 公网入口上 submit 前抛错、无任何请求 | getRandomValues 回退实现 + 单测（ef660d4） | 单测 RED→GREEN；部署后探针确认 POST 发出 |
| 2 | `MANAO_RESERVED_PUBLIC_PORTS` 首次接线误含验收测试端口 30281/30282 → 创建被 409 拒绝 | 改为仅 30080 + README 修正（cae9254） | API 探针：30080 → 409 PUBLIC_PORT_RESERVED 且无行残留 |
| 3 | NodePort 冲突分类大小写 bug：v1.31 返回小写 `provided port is already allocated`，确定性冲突被降级为 UNKNOWN | equalsIgnoreCase + 单测（fd4bf21） | 单测 RED→GREEN 12/12 |
| 4 | ClusterRole 缺 `persistentvolumes get`：PVC 绑定后 `rememberMysqlClaim` 403 → provisioning 失败 | 授 get+list（bd892b4） | apply 后 provisioning 成功；previously unbound-PVC 的静默路径同时关闭 |
| 5 | fabric8 HTTP/2 下 websocket exec 立即失败（ opaque handshake rejection） | 两处客户端构造 `setHttp2Disable(true)` + 单测（fde4737） | 单测 RED→GREEN；注：此修复非该卡点最终根因（见 #6），保留为加固 |
| 6 | **pods/exec 仅授 create（SPDY 时代动词）；websocket exec 是 GET+upgrade → 全部 403 → run 卡 STARTING** | 授 get pods/exec（71422c1） | 集群内 SA 探针：改前 403、改后 101；run `firstReadyAt` 即刻武装 |
| 7 | 前端 Run 详情一次性获取：服务端武装 readiness 后工具条永远停在 STARTING | 非终态 run detail 按 active-run 节奏轮询 + 单测（fb469ff） | 单测 RED→GREEN；E2E att.15 工具条正确显示 RUNNING |
| 8 | E2E spec：第二公网端口也映射 8080 —— 一个 Service 不能声明两个相同 service port（apiserver 422 Duplicate value） | 端口 2 映射 9090 并经文件 API 让示例代码真实监听 9090（原 Task 9 计划即为此设计）；依赖就绪等待预算提高（无独立提交，随 fb469ff） | E2E att.15 通过；日志证实 `Tomcat started on ports 8080 (http), 9090 (http)` |

后端全量套件两次运行 509/510、510 通过，唯一失败均为既知负载敏感 flake（`WorkspaceApiClientTransportTest.classifiesAConnectionClosedWithResetAsReset`，隔离运行稳定通过，与本轮改动无关——如实记录）。

### 8.7 配置修正记录

`MANAO_RESERVED_PUBLIC_PORTS` 语义 = 项目**永不**可占用的平台保留端口（30080）。2026-09-22 上午首版接线曾含 `30080,30281,30282`（当时按 README 旧文案理解），导致验收项目自身创建被拒；已修正为 `30080` 并同步 configmap 注释、config.example.env、README §6/§10.4。操作者指定的验收端口由项目创建时占用、由 API server 的 NodePort 冲突检查（fail-closed）保护，不进入该列表。

`MANAO_MYSQL_STORAGE_CLASS` 留空 = 回退 `manao-poc4-delete`（Delete reclaim）的操作者决策维持不变。

### 8.8 遗留项（未自动回收，保持 DELETING）

项目 `java-runtime-20260922120102-96pj`（id `ec03f997-…`）处于 DELETING：其 provisioning 曾因 #4 的 403 失败，MySQL PVC 未能在 store 注册，fail-closed 清理器按设计拒绝删除未注册声明（防误删数据），故清理无法自动完成，2 个 PVC（workspace + mysql）与数据保留。**需操作者决策**：确认该 PVC 归属后手动处置，或等待后续任务提供修复路径。不 force-delete、不伪造回收。

### 8.9 状态分类汇总（C3 最终）

- PASS（限 C3 计划内执行且留证的验证项）：部署与 rollout、V9 迁移、预拉、E2E 非 7200s 用例轮（4/4）、Maven 缓存专项验收（8.3 全部子项，含创建到可编辑与业务响应证据）、删除回收（8.4）。
- WAIVED_BY_USER：正式 7200s 用例（用户自测）。
- BLOCKED→已解决：服务器不可达（第 7 节，已于当日下午恢复）。
- 遗留 DELETING：8.8 一项（待操作者）。
- NOT_REVERIFIED（Task 8 遗留、本轮未执行，维持 PENDING 归属）：
  - §3.2 NetworkPolicy 隔离执行行为：per-project NetworkPolicy 资源随项目生命周期创建/删除已在验收中发生，但其隔离是否实际生效未以注入流量方式在真实集群实测——本轮验收未包含该实验。
  - §3.6 容量余量判定：未做并发项目数 × 每项目资源请求（MySQL 250m/512Mi、Redis 100m/128Mi、run Job）对节点 allocatable 的余量实测——本轮为单项目串行验收，不构成并发容量结论。

## 9. 端口预检发布与部署轮（2026-09-25）

记录者：port-preflight 发布轮。部署对象为审查通过的提交 `95c8c15`（创建时只读集群级 NodePort 占用预检）+ `b6dfc03`（占用判定前的 keyed 身份复核）。全部集群改动按部署 README 顺序执行；既有 Stage 6B PASS 与第 8 节 C3 结论均不改写。

### 9.1 部署（PASS）

前置核对（全部实测，任一不符即中止）：工作树干净（分支 `codex/java-runtime-implementation`，HEAD `b6dfc03`）；context `kubernetes-admin@learn`；namespace `manao-stage6b`；3 节点 Ready（master/node1/node2，v1.31.13）；无活动 Run/Job（3 个既有 Job 均 Failed、无 active，无 Running run pod）；部署中 backend digest 为 `…@sha256:0cae6613…2691c`（与 8.1 一致，作为回滚 pin 保留）。平台资源（MySQL PVC、既有 Service/NodePort 30001/30002/30080）全程未触碰。

| 步骤 | 结果 |
| --- | --- |
| 构建 | `mvn -q -f poc4/backend/pom.xml -DskipTests package` exit 0（本机，Maven wrapper 发行版 3.9.16） |
| 镜像 | `docker build`/`push` tag `java-runtime-backend-20260925-preflight` → **`chocologic/manao_images_repository@sha256:95f254ed201044069e412d5d20b4bb8bc35cbf377e94ca09169a0a23de079a2c`**（push 输出 digest 与 `docker inspect RepoDigests` 一致；Deployment 以 digest 引用，不用 tag）。构建源提交 `b6dfc03` |
| RBAC | 先 `kubectl diff -f poc4/deploy/6b/backend-rbac.yaml`：唯一增量 = ClusterRole `manao-stage6b-storage-reader` 追加 core `services` `list`（Role/RoleBinding/ClusterRoleBinding 无 diff）。apply 后 `kubectl auth can-i list services --all-namespaces --as=system:serviceaccount:manao-stage6b:manao-backend` = **yes**；对照 `create services --all-namespaces` = no。仍无任何跨 namespace 写、PV 写或 cluster-admin |
| rollout | `kubectl -n manao-stage6b set image deployment/backend backend=<新 digest>`（2026-09-25T05:39:53Z）→ Recreate 短暂中断 → rollout success；pod 1/1 Ready（readiness probe 含 db/kubernetes 组通过）。启动日志实测：`Successfully validated 9 migrations`、`Current version of schema 'manao_poc4_6b': 9`、`Schema is up to date. No migration necessary.` —— V9 保持现行，无新增迁移 |
| 私有 env | 仓库外私有 env 文件 `BACKEND_IMAGE` 更新为新 digest（单引号格式不变，其余各行未动；凭据未接触、未输出） |

### 9.2 占用端口 409 预检验证（PASS）

经公网入口 `http://1.12.245.235:30080`（nginx→backend 链路实测 200/401 正常）以既有测试账号登录执行（凭据经私有 env 注入 stdin/环境，未出现在命令行、进程参数或本记录中）。时间 2026-09-25T05:44:48–05:44:50Z。

- 受控创建请求：唯一名 `preflight-409-5c201ffb`，creationKey `78590a41-c7bd-49a0-8e95-4ff9d0daffc8`，`java-spring-boot-web`，publicPort **30001**（已知被 test0 的 Service 占用）。
- **结果：HTTP 409，响应体 `{"code":"PUBLIC_PORT_IN_USE","message":"Public port is already in use. Choose another port.","traceId":"9368b193-d89c-459f-9f86-2ec151f858bf"}`** —— 预检在任何项目行写入之前拒绝。
- 无副作用独立对账（API/集群/DB 三个面互相独立）：
  - `GET /api/v1/projects/creation/{key}` → 404 ENTRY_NOT_FOUND（key 未落库）；
  - 项目计数 3 → 3（limit 8）：无配额泄漏；
  - MySQL `project` 表按该 creation_key/名称查询 = 0 行（总数 3 不变：test0、test2、8.8 遗留 DELETING 行）；
  - 集群 Service 清单（跨 namespace 实读）：30001 仍仅由既有 `manao-app-3959c629…`（test0）持有，30002 仅由既有 `manao-app-5b3fde39…`（test2）持有——无任何新建 Service，test0 占用保持。
- 30002 的占用仅以只读清单核验（恰好一个持有者），按计划未发起第二次 POST。

### 9.3 记录的限制：无 Actuator 的导入应用无法通过平台就绪验证（文档化限制，非通过项）

- 用户导入的自定义应用 **test2**（Spring Boot 4.0.8，未引入 Actuator）：8080 端口在监听、MySQL 连接正常，但平台固定就绪探测路径 `/actuator/health/readiness`（运行器 supervisor 固定轮询主端口，`WebRunSupervisor.READINESS_PATH`）始终无 2xx。
- 后果（DB + 集群只读实读佐证，2026-09-25 复核）：Run `4c03e3c5-f4a7-4ec0-80a5-40c15cc768a1` 于 `2026-09-25T02:56:22.134060Z` 创建，**1800 秒启动预算到期**（startup deadline = 创建 + 1800s = `2026-09-25T03:26:22.134060Z`）时被终止：运行容器 `maven` 的 `finishedAt` 实读 `2026-09-25T03:26:22Z`（exitCode 126，Job `completions=1`/`backoffLimit=0`/`activeDeadlineSeconds=9000` 兜底），与启动预算到期时刻一致；Run 终态 `TIMED_OUT` / `STARTUP_TIME_LIMIT_EXCEEDED`，`first_ready_at` 为 NULL（从未就绪武装）——**7200 秒 first-ready 期限从未开始计时**（`expiresAt = firstReadyAt + 7200s` 只在首次就绪时安装；首次就绪始终未到达，运行已被启动预算终止）。项目 Service selector 保持 `manao.poc4/run-id: stopped`，不向未就绪 run 转发——fail-closed 符合设计 §7.3，不是缺陷。（该 Run 执行于本轮镜像更新前的后端，就绪机制在两个镜像间无差异。）
- 结论：**仅 TCP 端口打开不足以作为依赖型应用的就绪证据**。现实现固定探测主端口 `/actuator/health/readiness`，该路径不可配置、无自动 TCP 回退；导入应用必须让这一固定路径返回 2xx（Spring Boot Actuator 原生满足；自定义等价实现同样必须在该固定路径上返回 2xx）才能完成 bounded web run 的就绪武装。
- 用户决定：暂不为任意应用健康检查单独立项/另行实现设计；平台**不引入自动 TCP 回退**，启动预算与 `expiresAt = firstReadyAt + 7200s` 语义维持不变。

### 9.4 状态分类汇总（本节）

- PASS：9.1 部署（构建/推送/RBAC/rollout/V9 校验/私有 env）、9.2 占用端口 409 预检与无副作用对账。
- NOT_REVERIFIED：**生产 503 `PUBLIC_PORT_PREFLIGHT_UNAVAILABLE` fail-closed 分支**（集群清单不可读/Forbidden/传输失败时的拒绝路径）——按红线不得向生产集群注入 RBAC 或传输故障，该分支维持测试层验证（单测），不因未实测而计入 PASS。
- NOT_REVERIFIED：**浏览器实机 UI 对 409 的展示与输入保留**——本轮验证止于 API 层与既有单测（`CreateProjectForm.test.tsx` 模拟 409 断言错误呈现与输入保留）；实机浏览器验证未执行，因浏览器自动化需在自动化通道处理明文凭据，与凭据边界冲突。后续有条件时以不落凭据的方式补验。
- 维持不变：8.8 DELETING 遗留项、8.5 正式 7200s 用例 WAIVED_BY_USER、8.9 两项 NOT_REVERIFIED。
