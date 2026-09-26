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

- 云端部署本身：`manao-stage6b` 未应用本增量的任何变更（backend/frontend/agent/runner 镜像均未重建推送，V10 未在真实 schema 上运行，真实 schema 仍为 version 9）。
- 独立 E2E 入口 `test:e2e:python-runtime`：仅完成收集验证（`--list`，python-runtime-cloud 单项目 **10 tests in 1 file**，2026-09-26 复测）；真实执行属 Task 11。
- `MANAO_RUNTIME_DEPENDENCY_PENDING_FAULT` 配套的后端故障注入尚未提供（Task 11 provisioning）；该用例无故障旗标时显式跳过并保持 NOT_REVERIFIED，不空转成 PASS。
- 真实浏览器全流程、公网端口业务探活、Python 项目云端删除回收、7200 秒正式用例、任何 Python 性能/启动时长指标（历史 Java 58s/7s 不是 Python 指标）。

## 5. 发布授权到位后的执行记录（预留）

本节由发布/验收轮（Task 11）追加：镜像 digest 成对记录（backend + Python runner，见部署 README §11.1/§11.5）、部署顺序与健康核对结果、E2E 各用例结果、删除回收核查、7200s 用例状态（PASS / FAILED / SKIPPED / WAIVED_BY_USER 原话与范围）。**在本节写入之前，不得将本阶段标记为已交付或云端验收通过。**
