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
