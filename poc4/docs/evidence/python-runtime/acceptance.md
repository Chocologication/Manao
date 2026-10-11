# Python 项目运行时验收记录（acceptance.md）

本文件是「Python 运行时」（`2026-09-25-python-runtime-implementation` 计划）的唯一验收记录，对应设计 §9 的证据结构。按设计 §9 的边界：**本轮（实施 Tasks 1–10，分支 `codex/python-runtime`）只完成实现与本地/容器级验证；云端部署、真实浏览器生命周期与 7200 秒正式用例全部未执行，一律 NOT_REVERIFIED。** 本文件不预建任何 PASS；云端验收由授权后的发布/验收轮（计划 Task 11）补写。既有 6A/6B/Java 验收记录保持原始边界，不被本计划改写。

- 记录创建：2026-09-26（Task 10 发布准备轮）；后续轮次在本文末尾追加，不改写历史小节。
- 分支 / 工作树：`codex/python-runtime` / `D:/DeepLearning/MyProjects/Project_Manao/.worktree/python-runtime`（Task 10 基线 `869c34e`）。
- 状态词汇沿用既有验收口径：PASS / FAILED / SKIPPED / WAIVED_BY_USER / NOT_REVERIFIED，不混用。

## 1. 交付范围与执行 commit

| 计划任务 | 内容 | Commit |
| --- | --- | --- |
| Task 1 | 固定模板 id、兼容 run 策略与校验 | `ed2e10b`，fix `770122a` |
| Task 2 | 真实 uv 模板与锁文件、agent 编辑器元数据、seed 导出器 | `05c9337`，fix `066d190` |
| Task 3 | 共享监督器固定 profile 选择 + maven-runner 真实容器用例 | `b260dc2`，harness fixes `0ba4c46` `83e548e` `25d1c6b` `3b8c842` `32797ce` |
| Task 4 | Python runner 镜像、固定 launcher、uv 缓存 seed、容器用例 | `ba7dccb`，fix `419d211` |
| Task 5 | Run/Job/Service 接入、`MANAO_PYTHON_RUNNER_IMAGE`、日志/清理兼容 | `26c5b80`，fix `6e5d810` |
| Task 6 | 前端 Python 运行闭环 + 独立 E2E 入口（authored） | `67f2782` |
| Task 7 | agent prepare/commit 依赖编辑（真实 uv） | `df3427a`，fixes `d7ac6d3` `446bae3` `fb910da` |
| Task 8 | 依赖操作 ID、持久回执、统一核对、V10 | `899be11`，fixes `2e9f9e8` `7f00790` `0a10b7d` `1c9611b` |
| Task 9 | 浏览器依赖表单、刷新可达恢复入口 | `3b3b852`，fix `869c34e` |
| Task 10 | 发布准备、工具版本与镜像身份记录、部署清单（部署 README §11）、E2E 入口核对与本验收文件 | 创建本记录的 Task 10 提交（分支 HEAD；发布轮记录见第 5 节） |

## 2. 实际工具版本与可交付镜像身份（Task 10 recorded，2026-09-26）

工具链（与 Task 2/4 报告一致，Task 10 从重建后的镜像内重新读取验证）：

| 组件 | 实测值 | 证据 |
| --- | --- | --- |
| uv | `0.11.6`（Linux 镜像内 `x86_64-unknown-linux-musl`；锁文件由 Windows uv 0.11.6 生成） | 镜像内 `uv --version`（2026-09-26）；`ghcr.io/astral-sh/uv:0.11.6@sha256:b1e699368d24c57cda93c338a57a8c5a119009ba809305cc8e86986d4a006754` |
| CPython | 镜像内 `3.13.15`；锁文件生成解释器为 uv 提供的 `3.13.13`（Task 2） | 镜像内 `python3 -V`（2026-09-26）；`python:3.13.15-slim@sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0` |
| JRE | Debian trixie `default-jre-headless`（OpenJDK 21），runner 与 agent 镜像同源 | Task 4/7 构建；编译态 `default-jdk-headless` 同发行版 |
| uv 缓存 seed | `a3687aae7fe59204cd1a23454fd71ccb0c4e400a9200a52cb5e76a090c0295e5`（747 文件，~30 MB），2026-09-26 重建后原样复现 | 镜像内 `/opt/manao-python-seed/seed-id` 读取（2026-09-26） |
| 模板 lock hash | console `workspace-template-python/uv.lock` = `a96bbf8e0350626470f1f8e55b7cf8c2cf00166f25225b917954552675c399c8`；web `workspace-template-python-web/uv.lock` = `de8a8bb358d35ebfd2a250eb6e9903313e636a47a3a8f2232442f0302816d028` — 已提交锁文件字节的 SHA-256，取自 Task 10 准备提交 `11accb3`（工作树与 HEAD 一致；两锁自生成提交 `05c9337` 后未变，seed 与镜像构建消费的正是这两份锁） | `git show <commit>:<path> \| sha256sum` 与工作树 `sha256sum` 双向一致（2026-09-26 实测） |

本地构建身份（**本地 tag 不是生产 pin**；生产 digest 在发布轮填入，部署清单占位见 `poc4/deploy/6b/README.md` §11.1）：

| 镜像 | 本地 tag / image id（2026-09-26 重建） | 覆盖容器用例 |
| --- | --- | --- |
| Python runner（runtime-test 态） | `manao-python-runtime-test` id `5027b784050a` | `runtime-lifecycle.sh` 13/13；`python-cache.sh` 13/13 |
| Workspace agent（测试态，含 Python 依赖端点） | `manao-python-workspace-agent-test` id `cb90b3be95dd` | `dependency-editor.sh` 14/14 |
| Backend / frontend / Maven runner 生产镜像 | 本轮未构建（发布门禁内）；Maven runner 因共享监督器源码 `b260dc2` 变更需在发布轮重建重发 | — |

## 3. 设计 §9 验收项与当前证据状态

设计 §9 的六项必要证据，逐项记录已完成检查与未执行边界：

1. **Java 兼容 + Python 普通程序成功/失败/修改/再次运行、中文实时日志与回放** — 实现级证据：后端全量 615/615（含 run 策略/日志/清理兼容，`1c9611b` 轮实测）；容器级 `runtime-lifecycle.sh` 13/13（console 成功/退出码传播、中文 stdout/stderr、TERM 强制回收，重建镜像 2026-09-26）。前端新旧 Run JSON 解析 1287/1287（`869c34e`）。**云端真实浏览器全流程 NOT_REVERIFIED。**
2. **FastAPI 经选定公网端口响应业务请求；readiness 与依赖状态准确；停止后进程与访问结束；手动再次运行新 Run** — 实现级证据：容器级受监督 web run（ready、业务流量、TERM 停止 `USER_STOPPED`、短到期 124）与低特权端口 80 场景 13/13；后端 Service/NodePort 路径单元测试（`JobResourceFactoryTest` 等）。**真实集群公网 NodePort 探活、真实浏览器停止/再运行 NOT_REVERIFIED。**
3. **浏览器 uv 增删依赖可用；新增包首次下载、第二次复用、移除无残留；失败安装不启动应用** — 实现级证据：`dependency-editor.sh` 14/14（真实 `uv add/remove httpx`，下载/离线复用/无残留，预算超时杀树，重建 agent 镜像 2026-09-26）；`python-cache.sh` 13/13（download/reuse/remove 无残留）；后端回执/核对 615 全量内；Task 9 依赖表单/恢复为 MSW mock 级（21 项新测试 + 全量 1287）。**真实浏览器经公网入口的依赖编辑 NOT_REVERIFIED。**
4. **MySQL 项目数据停止/改码/再运行后保留；Python 项目删除独立验证 DB 行、Job/Pod/Service/Secret/PVC/PV 与缓存回收** — 实现级证据：后端 V10 迁移与删除状态迁移测试（一次性 schema，Task 8 实测）；Job/Service/PVC 资源构建与清理单元/契约测试（`26c5b80`/`6e5d810`）。**真实集群的 Python 项目删除资源回收验证 NOT_REVERIFIED。**
5. **公共监督器复用既有 Java 生命周期用例；Python 只补实际 uv/Python 进程链的 readiness、安装阻塞超时、短时到期、TERM/强制终止与日志** — 实现级证据：监督器固定 profile 选择重构（`b260dc2`）后 maven-runner 容器用例保持通过（Task 3 实测）；Python 侧补充场景见第 1 项/第 2 项容器用例；未复制第二份公共状态机故障矩阵（按设计）。**云端联合行为 NOT_REVERIFIED。**
6. **Python 正式 7200 秒云端用例单独记录** — **完全 NOT_REVERIFIED**：本轮无任何 7200s 执行。Java 的 `WAIVED_BY_USER` 不豁免 Python；短容器到期证据（6 s 场景）不构成完整时长 PASS。

## 4. NOT_REVERIFIED 汇总（截至本文创建）

> 2026-09-27 更新：本节为 Task 10 创建时的原始边界，发布轮结果见第 5 节；第 4 节不再改写，仅在此注明哪些项已被第 5 节的实测覆盖（E2E 全套、公网探活、删除回收、V10 迁移、部署本身）。仍 NOT_REVERIFIED 的项见第 5 节末尾。

- 云端部署本身：`manao-stage6b` 未应用本增量的任何变更（backend/frontend/agent/runner 镜像均未重建推送，V10 未在真实 schema 上运行，真实 schema 仍为 version 9）。
- 独立 E2E 入口 `test:e2e:python-runtime`：仅完成收集验证（`--list`，python-runtime-cloud 单项目 **10 tests in 1 file**，2026-09-26 复测）；真实执行属 Task 11。
- `MANAO_RUNTIME_DEPENDENCY_PENDING_FAULT` 配套的后端故障注入尚未提供（Task 11 provisioning）；该用例无故障旗标时显式跳过并保持 NOT_REVERIFIED，不空转成 PASS。
- 真实浏览器全流程、公网端口业务探活、Python 项目云端删除回收、7200 秒正式用例、任何 Python 性能/启动时长指标（历史 Java 58s/7s 不是 Python 指标）。

## 5. 发布轮执行记录（Task 11，2026-09-27）

发布授权：用户于 2026-09-27 明确指示「现在先不要合并，先进行task11的云端验收」（不合并 `codex/python-runtime` 到 `master`，在分支上执行云端部署与验收）。执行 commit：部署与验收基于 `7963512`（含 2026-09-26 外部审查修复轮 `e775c05..053f061` 与 Task 11a 故障注入 `a0db576`、e2e 校准 `7963512`）。

### 5.1 发布镜像（backend 与 Python runner 成对记录，见 §11.1/§11.5）

| 组件 | 生产 digest（`chocologic/manao_images_repository`，构建自 `a0db576`，tag `*-20260927`） |
| --- | --- |
| Backend | `sha256:e683442ccb1d0e1e2e5cc2a3c6824a359a05b2f0934c8786dfbd0d4aecd8d635` |
| Frontend | `sha256:161f0c36607443bcccce47b06df03365ccf3868b5ad76ea0af810376331a19a3` |
| Workspace agent | `sha256:e17920ed119382125701e65be01120785c7c165eaba317bcd42bd2d9698089d7` |
| Python runner | `sha256:c45b61098ce72ce62d1715f93c7beaa5e5ac0a6b8f8d7d9b8250c773a4c76536` |
| Maven runner（重建重发，含共享监督器 `b260dc2`） | `sha256:c7aabf876dd8e2caccb1e0775be9a778cfac184339f25ca93abb93735a8c3c67` |
| Workspace initializer | 不变（`busybox@sha256:73aaf090…1662`） |

镜像在 node1/node2 均经辅助 Pod 预拉成功（runner 146 MB / agent 156 MB，Pulled 事件为证）。 Secret `manao-backend-images` 补入 `MANAO_PYTHON_RUNNER_IMAGE` 并更新其余三个 digest；initializer 保持原值。工具链身份与 §2 一致（uv 0.11.6 / CPython 3.13.15）。

### 5.2 部署窗口（2026-09-27 05:38–06:05 UTC，全部 PASS）

1. 前检：集群 3 节点 Ready（用户当日手动重启过集群——重启痕迹为操作者行为）；真实 schema version 9；NodePort 30281/30282 空闲；`GET /api/v1/runs/active` 全局路由不存在（RunController 为项目级路由，部署 README §11.4 步骤 1 文档失准已记录），以集群侧零 RUNNING Run Pod 等效核验。
2. 前端先行（兼容前端）：新前端 + 旧后端下登录、项目列表、既有 Java 项目 Run 历史全部 200。
3. 后端滚动（Recreate）：Flyway 9→10「python dependency operations」迁移成功（日志与 DB `flyway_schema_history` 双确认，version 10 success=1）；登录正常。
4. 旧路径回归：既有 Java 项目 test3 新 Run `0ffc70e2` STARTING→RUNNING（firstReadyAt 05:56:10Z，expiresAt +2h），Run Pod 实际使用**新 Maven runner** digest，停止 → CANCELLED/USER_STOPPED。
5. Python 冒烟：新建 python-console 项目 `py-smoke-20260927135814`（`0206c58a`）约 20s READY（workspace Pod 使用新 agent digest）；Run `0d87420e` SUCCEEDED exit 0（Run Pod 使用新 Python runner digest；Pod 日志含 CPython 3.13.15、venv 创建、暖缓存解析与「Hello from Manao」）。
6. 故障注入武装：`kubectl set env deployment/backend MANAO_DEPENDENCY_PENDING_FAULT_PACKAGE=six`（验收轮专用；E2E 后已解除并滚动恢复）。

### 5.3 云端 E2E（`test:e2e:python-runtime`，run 10 全绿）— PASS

`MANAO_RUNTIME_BASE_URL=http://1.12.245.235:30080`，操作者指定端口 30281/30282，`MANAO_RUNTIME_DEPENDENCY_PENDING_FAULT=six`（金丝雀值契约）。**10 passed (3.9m)**，零 skip，日志存证 `e2e-run-20260927.txt`。覆盖：console 创建→成功→改失败（exit 3，TASK 分类的终止原因见 5.5 裁定）→修复→再成功；FastAPI 双公网端口创建、`/api/demo` 真实业务响应、UI 停止后端口回收、再运行新 Run 服务双端口；依赖表单添加 httpx→import 成功→移除→无残留；丢失响应后按同 operationId 刷新恢复、revision 不重复增加；**FAILED（WORKSPACE_RECONCILIATION_REQUIRED）页面经核对入口恢复**（金丝雀 `six` 触发：prepare+PENDING 登记后 fail-closed 409，失败页 Check→COMMITTED→项目恢复）；UI 删除两项目且卡片消失。E2E 过程中 9 次此前运行的失败均为 spec 校准（authored-only 用例首次真实执行），无产品缺陷：单独记录为 5.5。

### 5.4 Java 定向回归 — PASS

一次性项目 `java-reg-console-160302`（Run `682df895` SUCCEEDED exit 0 BUILD_SUCCEEDED，真实 Maven 编译输出）与 `java-reg-web-160302`（Run `dd7c6a00` RUNNING firstReadyAt 08:05:00Z → 停止 CANCELLED/USER_STOPPED）。既有历史（test3）可读。旧策略历史在 V10 后正常。

### 5.5 执行期裁定与发现

- **TASK 终止原因裁定**：spec 期望 console 失败为 `APPLICATION_EXITED`，实测为 `BUILD_FAILED`。`RunStateReducer` 对非 service（TASK）Run 的失败分类是共享逻辑、先于 Python 轮并已被 Java 验收接受；设计 §7 禁止按语言改共享分类。裁定：修 spec 期望（exit code 才是承载失败事实的断言），不改产品。若错：未来可能一致化所有语言的任务失败文案——需独立立项。
- **RELOAD_FAILED 竞态为设计行为**：终止 Run 后工作区自动重载与并发保存竞态时 fail-closed（`PendingProjectAuthorityMutationError` → 重试横幅 + 写闸关闭），修复轮保护在真实集群按设计生效；e2e 以重试就绪助手处理。
- **认证为内存态**：整页刷新即登出；e2e 全部改用应用内导航。
- 部署 README §11.4 步骤 1 的全局 `/api/v1/runs/active` 路由不存在（项目级路由）；记录为文档失准，未改产品。

### 5.6 删除回收核查（Step 6）— PASS

API 删除 4 个本轮一次性项目（py-smoke、py-7200、java-reg-console、java-reg-web，各 204 → 404）后独立核验：Pod/Job/Service/StatefulSet/Deployment **零残留**；workspace PVC/PV **零残留**（Python 缓存随 workspace PVC 一并回收）；DB `project`/`run`/`workspace_operation` 三表按项目 ID 查询 **0 行**。历史 DELETING 项目 `java-runtime-…-96pj` 与用户既有 test0/test2/test3 未触碰。

### 5.7 7200 秒正式用例 — SKIPPED（用户指示）

用户原话（2026-09-27）：「7200s的测试用例先跳过吧，这个时间太长了后面再做，先继续后面的工作」。范围：本轮不产出 7200 秒 PASS；Python 的该正式用例保持未完成（等同 NOT_REVERIFIED，不因跳过变 PASS）。跳过前已捕获的局部证据：web Run `d011e846`（项目 `py-7200-20260927075609`，公网 30281）firstReadyAt 07:58:58Z / expiresAt 09:58:58Z（精确 +7200s），`/api/demo` 经 30281 返回 200；**受控后端重启后 firstReadyAt/expiresAt 不变且公网仍 200**（恢复不变量实测）；随后按用户指示停止（CANCELLED/USER_STOPPED，端口回收连接拒绝）。未测行为：完整 7200 秒到期终止、到期 receipt 与容器实际终止核对。

### 5.8 剩余 NOT_REVERIFIED（本节之后）

- Python 正式 7200 秒云端用例（用户指示跳过，见 5.7）；真实浏览器下的人工深度探索（E2E 覆盖之外）。
- 任何 Python 性能/启动时长承诺（本轮采样仅记录不承诺：workspace 创建 ~20s、冷镜像已预拉、uv 暖缓存解析毫秒级）。
- `master` 合并与 Task 11 之外的发布后续（用户指示本轮不合并）。

## 6. 工作台与日志修复轮发布记录（2026-09-29）

发布授权：用户于 2026-09-29 明确指示「本轮修改后的代码是否部署上线？没有则现在进行部署」。分支仍**未合并**到 `master`；本轮部署与验收基于分支 `codex/python-runtime` HEAD `78beafc`（含修复提交 `5a3fef5`、`7d5efa2`、`d119465`、`86e65a0` 与文档提交）。部署范围仅 backend/frontend 两个镜像；runner/agent/initializer 与 Secret 全部保持 §5 的既有值（无新迁移，无 RBAC 变化）。

### 6.1 发布镜像（tag `*-20260929`，构建自 `78beafc`）

| 组件 | 生产 digest |
| --- | --- |
| Backend | `chocologic/manao_images_repository@sha256:8432747459756156d5dd2ec0c313af3725cce1a597ccfd94557c40d8de8b773e` |
| Frontend | `chocologic/manao_images_repository@sha256:26a57cf3389e77c61fd7b22cd5dc4930b33cecdc03b41e8cf426f93e3ac1f862` |
| Workspace agent / Python runner / Maven runner / initializer | 不变（§5.1 值） |

### 6.2 部署窗口（2026-09-29 13:45–13:47 UTC 滚动，全部 PASS）

1. 预检：集群 3 节点 Ready；集群侧零活动 Run（无 Active Job）；本地 Docker 引擎按需启动；registry 已登录。
2. 前端先行：`deployment/frontend` 滚至新 digest，公共 SPA 200。
3. 后端滚动（Recreate）：`readyReplicas=1`，Flyway「Schema `manao_poc4_6b` is up to date」（version 10，无新迁移），`/actuator/health/readiness` 200，公共入口错误凭据 401（nginx→backend 链路正常）。

### 6.3 修复验证（真实浏览器 + 真实集群）— PASS

凭据处置（如实记录，含更正）：验证过程中一度误报「凭据漂移」——后经用户指出其浏览器可用 env 凭据正常登录，复核定位为**验证方解析错误**：`stage6-6b.env` 的值以**单引号**包裹（如 `APP_USERNAME='app_user'`），早期解析把引号当成了值的一部分（当时只检查了双引号），导致比对与登录请求都带着字面引号而 401。按单引号剥离后复核：env 的 APP_USERNAME 即线上 `app_user` 行、APP_PASSWORD 与线上 bcrypt **MATCH**、公共入口真实登录 **200**——**凭据从未漂移，无需同步**。此前的验证窗口内仍按当时认知插入过一次性账号 `deploy-verify-temp`（随机口令）完成浏览器回归，完成后已 DELETE，`app_user` 恢复为原有 1 行；原账号全程未触碰。

1. **连续打开工作台（问题 A）**：以临时账号连续打开 python-fastapi-web 工作台 3 次，浏览器 console 记录 4 次短暂 409（`/python-dependencies/pending` ×2、项目详情 GET ×2）——即真实锁竞争复现；3 次打开红字「Could not check for a pending dependency change.」出现 **0 次**，文件树均正常加载。pending 只读重试在真实环境按设计生效。
2. **FastAPI 快速失败（问题 B）**：编辑 `app/main.py` 首行注入 `import deploy_verify_nonexistent_xyz`（PUT 200），启动 Run `c2335795`：约 6 秒终态 **FAILED / APPLICATION_EXITED / exit 1**（uvicorn 导入失败即容器退出）。`run_log_chunk` 持久化 **64 chunk / 3020 字节，seq 1..64 连续**：第 1 行起（uv 解释器/venv/依赖安装）直到完整 `Traceback` 与 `ModuleNotFoundError: No module named 'deploy_verify_nonexistent_xyz'`（seq 63-64 为注入行与异常行）；**「log source lost」gap marker 0 条**。修复前该场景为 0 chunk（test5 证据）。UI Run 面板渲染完整 Traceback，日志连接状态 Complete（log.complete 在补采之后发布）。
3. **Java 旧路径回归**：新建 java-console 项目 Run **SUCCEEDED / BUILD_SUCCEEDED / exit 0**（57 秒），旧路径无回归。

### 6.4 删除回收核查 — PASS

两个一次性验证项目 API 删除（各 204 → 404）后独立核验：Pod/Job/PVC **零残留**；`run_log_chunk` 等依赖行随删除流程清零；历史数据与其他用户数据未触碰。

### 6.6 随轮推迟的质量小项（收编自各轮 SDD 台账；台账工作区删除后本清单为唯一在库记录）

以下各项均已逐轮裁定为不阻塞交付的 Minor/观察项，汇总于此防止散佚（2026-09-29 收编）：

1. 工具链升级检查单：镜像内 `seeded-<旧id>` 标记清理与前端 Python 版本钉死必须成对变更（Task 1–10 轮终审）。
2. WorkspaceFileService 临时名符号链接加固（既有代码，非 Python 轮引入）。
3. T2 storage-ref 加固（存储被禁环境下的引用语义）。
4. `fileMutations` 对新 409 码 `WORKSPACE_RECONCILIATION_REQUIRED` 的专属文案（09-27 审查修复轮终审）。
5. mock 依赖面板对 active-Run 门的应答（`RUN_ALREADY_ACTIVE`）与后端（`PROJECT_LOCKED`）的既有分歧。
6. 既有前端 flake 两例（T1/T4）。
7. 终态日志补采在维护循环线程同步执行（有 HTTP 客户端超时 + 每 Run 3 次预算兜底；一次慢读取会拖延该轮扫描并短暂持有项目门租约）——09-29 修复轮终审裁定接受。
8. fabric8 `getLogReader` 内部每次尝试附加一次 `waitUntilReadyOrTerminal(0)` 短往返（信息性开销）。
9. 依赖变更 POST / reconcile POST 无新增专项防回归测试（结构性守护：重试 helper 仅包裹 pending GET 单一调用点，且 `fileMutations.test.ts` 既有写入不重试用例继续生效）。
10. 项目详情 GET（`/api/v1/projects/{id}`）同样参与 `ProjectLifecycleGate` 竞争（瞬时 409，前端自行恢复）；其重试策略不在 09-29 修复轮授权范围，留作独立评估（见 6.5）。
### 6.5 本轮观察（非缺陷，留档）

- 项目详情 GET（`/api/v1/projects/{id}`）也参与同一 `ProjectLifecycleGate` 竞争，真实打开中两次瞬时 409；工作台均自行恢复、无可见错误。该读取面的重试策略**不在本轮授权范围**，留作后续独立评估。
- namespace 中存在两个额外 StatefulSet `manao-mysql-5b3fde39-*`（4d11h）与 `manao-mysql-dda3a01b-*`（28h），本轮部署**未触碰**，来源待运维确认。
- 本地（单测）与云端（浏览器+集群）边界已在本节分开记录；7200 秒正式用例维持 §5.7 的 SKIPPED 状态，本轮未改变。

## 7. 依赖镜像切换与批量导入轮验证记录（2026-10-11）

本轮（`2026-10-11-python-dependency-mirror-batch-import-plan` 计划 Tasks 0–5，分支 `codex/python-runtime`，执行 commit 范围 `f2fee94`..`32d2b27` 加本节所在提交）只完成实现与本地/容器级验证：**未部署、未合并、无任何云端操作**；云端浏览器 E2E、7200 秒正式用例与历史项目真实行为一律 NOT_REVERIFIED。既有 1–6 节不改写。

### 7.1 任务 0 预检摘要（2026-10-11，完整记录见该轮 SDD 台账 task-0-report.md）

一次性容器（`python:3.13.15-slim` + `uv 0.11.6` 逐字 digest，与 runner/agent Dockerfile 一致）内完成，仓库零改动：两个模板在阿里云 default index 下 lock/add/sync 全链路 PASS，`uv sync --locked` 四次消费成功；**19 个包的 wheel 下载实测全部来自 `https://mirrors.aliyun.com/pypi/packages/…`（No cache entry + fresh GET 各 19 条、共 38 条 URL 记录，0 次 pypi.org / files.pythonhosted.org）**，生成锁的 registry 与 artifact URL 全部为 mirrors.aliyun.com。简报给定的 verbatim `uv add -r` argv 因 uv 0.11.6 旗标位置失败（exit 2，解析期、无改动），修正形状（旗标置于 `add` 之后）两模板 PASS 并据此固定 helper/seed/锁再生成 argv；同时记录：`uv add -r` 会把仅存在于 extras 的包同时写入主 dependencies（extras 保留），`--default-index` 被 add 持久化为 pyproject 的 `[[tool.uv.index]]`。

### 7.2 实现与验证 commit

| 任务 | 内容 | Commit |
| --- | --- | --- |
| Task 1 | helper/seed/锁再生成固定阿里云 index | `f2fee94` |
| Task 2 | agent 一次 `uv add -r` 批量 prepare | `72b0a67` |
| Task 3 | backend 批量端点（共享操作协议、协议 2 digest、≤50 行/≤64 KiB） | `06a3c8e` |
| Task 4 | 前端 Import requirements.txt 入口 | `7f54798` + `32d2b27` |
| Task 5 | 容器场景扩充、回归验收与文档边界 | 本节所在提交 |

### 7.3 容器级证据（本地 Docker 29.8.1，Linux 容器）

镜像：agent 测试镜像 `docker build -t manao-python-workspace-agent-test poc4/workspace-agent`（exit 0）；runner 测试镜像按 README 命令导出模板并构建（exit 0；镜像内 seed-id `8026436feb6507c93380e3452b4a3f447e597187df093f2a17b717b0ec7c7b63`、800 files，与 Task 1 记录逐字节一致）。

`bash poc4/python-runner/tests/dependency-editor.sh manao-python-workspace-agent-test` — **exit 0，23 passed / 0 failed**。既有 20 个场景全部保持通过；本轮新增 3 个：

- `batch-commit`：批量 prepare 后真实 commit——两个受管文件由一次事务替换（工作区摘要 = journal after 摘要），工作区根无批量残留，durable receipt 绑定提交摘要，`uv lock --check` 一致，**批量生成锁只记录 pinned mirror（registry 逐字相等 + artifacts 全部 `mirrors.aliyun.com/pypi/packages/`，15 个不同 URL）**。
- `batch-idempotent`：同 operationId 重放 batch prepare 返回既有 summary 且 uv add 运行数保持 1（replay 502ms vs first 1388ms）；重放后 commit 结果与 prepared 逐字相同；commit 丢失响应重放不改写（lock mtime 不变）。
- `batch-unsupported`（source-policy 补全至九类）：-r、--index-url、--extra-index-url、--find-links、-e、裸 http(s) URL、file:// URL、git+、本地路径全部在 uv 运行前 422 `PYTHON_DEPENDENCY_UNSUPPORTED`、无 journal、源不变。

另有本轮升级的 `helper-env-override` 直测（两段断言，发现见 7.5 之 2）。

`bash poc4/python-runner/tests/python-cache.sh manao-python-runtime-test` — **exit 1，11 passed / 3 failed**。通过 11 项含本轮升级的 `template-locks-mirror`（全 URL 强度：registry 逐字相等 + artifacts 全部 `mirrors.aliyun.com/pypi/packages/`，5 把导出锁）与加 `--default-index` 夹具（`uv_manifest_setup`）下的 download/reuse/remove 全链路、lock-mismatch、跨项目隔离、wipe/dirless/interrupted 修复。**真实失败 3 项**：`cold-cache-offline-web`、`warm-cache-reuse`、`extras-offline`——均为"仅凭镜像 seed + 断网启动 web 模板"的场景，机制与裁定见 7.5 之 1，如实记录为 FAILED、不以任何方式掩盖。

### 7.4 单元/回归证据（全部实测）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `mvn -f poc4/workspace-agent/pom.xml test` | Tests run: 76, Failures: 0, Errors: 0 | 0（BUILD SUCCESS） |
| `mvn -f poc4/backend/pom.xml -Dtest=PythonDependencyOperationTest,PythonDependencyHttpContractTest,WorkspaceApiClientTest test` | Tests run: 69（38+20+11）, Failures: 0 | 0（BUILD SUCCESS） |
| `pnpm -C poc4/frontend test -- src/features/dependencies/PythonDependenciesPanel.test.tsx`（vitest 实际执行全量） | Test Files 71 passed, Tests 1327 passed | 0 |
| `pnpm -C poc4/frontend exec tsc -b --pretty false` | 无输出 | 0 |
| `git diff --check` | 干净（仅 AGENTS.md 既有 LF/CRLF 提示） | 0 |

TDD 记录：`batchBoundaryOfExactly50ValidLinesIsAccepted`（恰好 50 条有效行必须被接受，注释/空行不计入）为回归守卫——加入后直接 GREEN，与既有 51 行拒绝测试构成边界对。未知字段断言先以真实 MockMvc converter 探针观察 RED（未知字段被共享 converter 静默忽略、请求穿过反序列化进入 service 层才失败——"Status expected:<422> but was:<503>"），据此按计划备选方案将两个测试改名为 record 反序列化范围并恢复原断言。Java runtime 回归：`git diff --name-only f6794b9..HEAD -- poc4/maven-runner poc4/java-runner` 为空——本轮未改动任何 Java runner/runtime 源文件。

### 7.5 本轮发现（真实缺陷与边界，非 PASS 项）

1. **seed 纯离线启动契约出现时间窗（真实回归，即 7.3 的 3 个 FAILED 的机制；已由同日修复轮解决，见 7.8 之 1）**：三个失败场景都是"仅凭镜像 seed + 断网启动 web 模板"。实测判定：同一 seed 缓存 `uv sync --offline --locked`（rc=0，完整安装 20 包）与 launcher 形态的在线模式离线运行（rc=1，逐 wheel "No cache entry" 回退网络下载）——缓存内容完整且键正确，差别在 uv 0.11.6 在线模式对 HTTP 缓存条目的新鲜度重验证；阿里云镜像对 wheel/index 返回 `Cache-Control: max-age=43200` 且 CDN `Age` 显著（实例实测 ~6.2h），使 seed 条目在构建后数小时内进入"过期需重验证"状态，断网即失败。pypi.org 时代 files.pythonhosted.org 为 `immutable` 语义，Task 4 的无条件离线契约因此成立；切换阿里云后该契约退化为"seed 构建后一个不超过 mirror 新鲜度窗口的时限内成立"。**生产（有网络）不受影响**：launcher 形态在线 sync rc=0（20 包安装成功）。修复选项（均未实施，超出本轮文件范围）：launcher 离线优先重试（先 `--offline --locked`、失败再网络重试）、seed 策略调整、或镜像源新鲜度评估——需独立裁定。
2. **helper 层环境变量防御缺口的精确定界（已由同日修复轮解决，见 7.8 之 2）**：`--default-index` CLI 参数在 uv 0.11.6 能覆盖 `UV_DEFAULT_INDEX`（锁生成的 add 阶段实测全部从 mirrors.aliyun.com 拉取，verbose 证据），但不能覆盖 `UV_INDEX`（additional-index 环境变量可引导 add 阶段）；`UV_DEFAULT_INDEX` 又会使无 index 参数的安装性验证阶段（`uv sync --locked --dry-run`）联系恶意域并失败。两种情形都 fail-closed（rc=5 `PYTHON_DEPENDENCY_RESOLUTION_FAILED`，无 journal、无锁产出、工作区源不变），**且在生产不可达**：agent 以仅 PATH/HOME/TMPDIR/LANG 的最小环境启动 helper（`fixed-index-argv` 场景本轮继续 PASS）。helper 自身未改（超出本轮文件范围）；建议后续为 `run_uv` 的子进程环境剥离 `UV_*` 或为 `VERIFY_ARGV` 固定 index。
3. **既有容器 harness 注册缺陷（记录，不在本轮修复）**：`start_agent` 经命令替换调用，其容器注册写入子 shell 内存数组后丢失，EXIT 清理只覆盖卷注册（文件型注册表）；容器泄漏为多轮既有行为。本轮实测清理：dependency-editor 泄漏容器 67 个 + 泄漏卷 182 个 + 更早会话遗留 `task5-final-*` 容器 3 个，全部按名删除并核对为 0 残留。共享 `tests/lib.sh` 不在本轮文件清单，未改动。

### 7.6 本轮边界（显式 SKIPPED / NOT_REVERIFIED）

- **未部署**：无任何镜像推送、无 Kubernetes 操作、未触碰 test4/test5 与线上数据；`manao-stage6b` 未应用本轮任何变更。**未合并**：分支仍未合并到 `master`。
- 云端真实浏览器 E2E（创建项目 → 编辑 requirements.txt → 导入 → 一次提交多条 → Run → import 验证 → 删除回收）：**SKIPPED / NOT_REVERIFIED**（用户明确禁止部署）。
- 7200 秒正式用例：**NOT_REVERIFIED**（维持 §5.7 的 SKIPPED 基线）。
- 历史项目行为（含 2026-09-27 后执行过依赖操作、pyproject 持久化 `[tool.uv] index url=https://pypi.org/simple` 的项目在下一次依赖操作得到固定 `PYTHON_DEPENDENCY_UNSUPPORTED` 及其工作台手动恢复路径）：容器级由 `tooluva-policy` 场景覆盖（旧 index 与缺尾斜杠 URL 均被 422 拒绝、无 journal）；**真实云端历史项目行为 NOT_REVERIFIED**。
- seed 新鲜度窗口内/外的真实集群冷缓存行为（7.5 之 1）：**NOT_REVERIFIED**。

### 7.7 文档边界（本轮在 README 与本节写明）

- 默认解析源为阿里云 `https://mirrors.aliyun.com/pypi/simple/`；没有自动 fallback、没有用户可选源。
- 本轮只覆盖新模板和新依赖操作生成的镜像锁；历史项目及其 uv.lock 不迁移——特别地：2026-09-27 部署后执行过依赖操作的历史项目，其 pyproject.toml 中持久化的 `[tool.uv] index url=https://pypi.org/simple` 会让下一次依赖操作得到固定 `PYTHON_DEPENDENCY_UNSUPPORTED`（fail-closed）；恢复方式是用户在工作台文本编辑器中删除该 `[tool.uv]` index 段；这不是迁移机制。
- requirements.txt 只支持项目根目录、纯 public-PyPI requirement 行（UTF-8，≤64 KiB，≤50 条非空行，空行/整行 # 注释不计入）；`uv add -r` 会把仅在 extras 中出现的包加入主 dependencies。
- batch 是一次事务（一个 operationId、一次 uv 解析、一次两文件 commit、一次 revision 增量），不提供逐包进度。
- 本轮没有新增依赖任务表、源选择器、后台队列或全量锁迁移；未部署。

### 7.8 同日修复轮（2026-10-11，控制器裁定 1–3；运行时行为变更随本轮携带，仅在获得部署授权后才上线）

三项裁定全部实施为本地容器级修复，**仍未部署、未合并**。执行 commit：`006199f`（helper）、`c836daa`（launcher）、`092b4a3`（harness）加本小节所在文档提交。

1. **launcher 离线优先重试（恢复设计 §6 的无条件 seed 兼容性证明）——运行时行为变更，重点记录**：`poc4/python-runner/manao-python` 的锁定安装改为先 `uv sync --offline --locked …`、失败才以同一固定 argv（去掉 `--offline`）在线重试，两次尝试共享既有启动预算；锁内固定 artifact+哈希使过期索引元数据无法污染锁定安装，offline-first 成功集严格大于旧实现（陈旧缓存+断网现在可启动）。**这改变 Run 启动的安装行为（离线尝试先行、日志新增一行 retry 提示），随本轮代码携带，只有未来授权部署后才生效于集群。** 证据：重建 runner 测试镜像（exit 0；seed 阶段自带的 `--offline` 验证再次通过）后 `python-cache.sh` 全套 **14 passed / 0 failed（exit 0）**——`cold-cache-offline-web`、`warm-cache-reuse`、`extras-offline` 全部恢复 PASS，其余 11 项保持通过。§7.5 之 1 的时间窗边界文本已在 README 与本节替换为 offline-first 语义：seed 兼容性证明重新无条件成立、不再依赖 mirror 新鲜度策略。
2. **helper 子进程环境剥离 `UV_*`**：`python-dependency-helper.py` 新增 `scrubbed_env()`（`os.environ` 去除全部 `UV_` 前缀变量，大小写敏感，其余 PATH/HOME/LANG/SSL_* 原样保留），`run_uv` 两个阶段统一使用——固定 argv 成为唯一的 index 权威，不再依赖 agent 最小环境这一层。`helper-env-override` 场景升级为强契约：直调 helper 且 helper 自身环境带敌意 `UV_DEFAULT_INDEX`+`UV_INDEX` 时，批量 add **成功（rc=0）**、生成 pyproject+lock 只记录 pinned mirror（15 个不同 URL 全部 mirrors.aliyun.com）、敌意主机在文件与输出中零出现、工作区源不变。证据：重建 agent 测试镜像（exit 0）后 `dependency-editor.sh` 全套 **23 passed / 0 failed（exit 0）**（两轮：修复验证 + lib.sh 泄漏验证各一轮）。agent 单测 76/76 保持通过。
3. **harness 文件型容器注册表**：`tests/lib.sh` 新增 `register_container`（文件 `${PREFIX}-harness-containers-$$`，与卷注册表同机制）并在 `start_detached` 注册、EXIT 清理读取——命令替换内的注册不再丢失。证据：`dependency-editor.sh` 全套 23/23（exit 0）后泄漏检查：`docker ps -a --filter name=manao-py-dep-` 计数 **0**、`docker volume ls | grep manao-py-dep-` 计数 **0**、临时注册表文件 0 个——该轮零残留。两套件（dependency-editor/python-cache）行为一致；更早会话遗留的 7 个 Exited `task5-red/green/compile2` 容器按裁定保持不动（历史残留留档）。
