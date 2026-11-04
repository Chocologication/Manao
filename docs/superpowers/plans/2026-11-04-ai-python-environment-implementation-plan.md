# AI 项目环境与 Python 开发闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本次已授权依序实施 Tasks 1–9、必要本地测试、文档更新和本地提交；push、merge、部署、外部模型调用及共享资源清理不在授权范围内。

后续授权更新：用户在本地交付后明确授权集群部署和下一阶段，已实际发布五项产物并执行真实模型核心流程；端口由用户确认为 FastAPI 30081、Spring Boot 30082。以下旧授权与 NOT_RUN 保留其本地阶段范围，当前结果见[云端记录](../../../poc4/docs/evidence/ai-python-environment/cloud-20261104.md)。Git push/merge 与共享资源删除未执行。

**Goal:** 让 Agent 根据四类项目的可信环境调用适用工具，并对普通 Python 与 FastAPI 完成源码编辑、自动依赖管理、语法/pytest 验证、运行反馈与再次修复。

**Architecture:** 后端将项目环境快照与摘要绑定到 AgentTask，worker 用现有 Pi resource loader 构造系统上下文和适用工具。Python 文件策略、test 组依赖及 Python build 分支复用 workspace receipt、构建 Job 与 Run 生命周期。新增依赖工具必须完整接入任务暂停、取消、重启和收尾。

**Tech Stack:** Java 17 / Spring Boot 3.5.9、MySQL/Flyway、Fabric8 7.7.0；TypeScript / Pi SDK 1.2.0；Python 3.13.15 / uv 0.11.6 / pytest；React、Vitest、Playwright、pnpm。

**Spec:** [设计文档](../specs/2026-11-04-ai-python-environment-design.md)。设计与实施计划共同评审后进入实施；各任务复选框记录完成情况，本地验证与部署后验收分别记录。

## Global Constraints

- 四类环境：`java-console`、`java-spring-boot-web`、`python-console`、`python-fastapi-web`；unknown 不猜为 Java。
- 用户已确认自动受控增删依赖；测试依赖按需加入专用 `test` 组。
- 普通 Python 沿用 `main.py` 非交互入口，FastAPI 沿用 `app.main:app` 及 `/health/ready`。
- Python 验证含语法检查、pytest、真实运行反馈；Python `package` 明确拒绝。
- 沿用 task 1800 秒、180 次工具、20 次 build、每 task 最多 4 次 application start；构建 Job 600 秒。
- 文件 128 KiB、工具结果 192 KiB、目录最多 200 项；构建副本 1000 文件/20 MiB；日志/报告继续有界。
- Python runner 固定 Python 3.13.15 / uv 0.11.6，依赖增删仅 uv add/remove，使用项目隔离 venv；禁止 pip、uv pip install/uninstall、任意 Shell。
- pnpm 管理前端和 worker；生成文件 UTF-8 无 BOM，Shell/Docker 入口 LF。
- 不手写 uv.lock；托管依赖文件由受控工具成对更新；同 operationId 不能重复解析、重复提交或递增两次 revision。
- schema 测试只用 `JdbcStoreTestSupport` 生成的 disposable schema；禁止重置 `manao_poc4` / `manao_poc4_6b`。
- 任务收尾必须等待 live claims、task 关联 receipt 和资源清理；模糊结果不能当失败重试或成功解锁。
- 不把本地测试、浏览器 fixture、`--list` 或助手报告当真实模型/集群验收。
- 改动前重读文件；不覆盖无关修改。本文相对路径均相对于实施 checkout。

## 0. 执行入口与验证层级

规划时分支 `codex/ai-python-environment` 从 `master@d0cf75f` 创建。开始实施前运行：

```powershell
git status --short --branch
git log -3 --oneline
git diff --check
pnpm --version
uv --version
java -version
```

先读设计文档、根 AGENTS.md、`docs/development-guide.md`。依赖安装仅在实施时执行：

```powershell
pnpm -C poc4/pi-worker install --frozen-lockfile
pnpm -C poc4/frontend install --frozen-lockfile
```

后端测试依赖可创建临时 schema 的 MySQL 账号，通过已有环境变量注入，不输出密码。环境缺失记 NOT_RUN 并说明阻塞，不能改为 H2 或连接运行库做 reset。容器测试使用固定镜像内 uv/Python；本机 Python 若用于辅助脚本，采用隔离 uv 环境。

| 验证层 | 证据 | 对应任务 |
| --- | --- | --- |
| 纯逻辑/合同 | JUnit、Vitest | 1–8 |
| 持久化与竞争 | 真实 disposable MySQL，多连接/闩锁测试 | 1、4、6 |
| 运行器 | 实际镜像内 uv、Python、pytest 和退出码 | 3、5、6 |
| UI | 结果组件与 fixture 浏览器测试 | 8 |
| 最终闭环 | 部署后真实模型、两个 Python 项目、多轮修复 | 9 |

## 1. 文件职责与任务依赖

| 新增/扩展单元 | 职责 | Task |
| --- | --- | --- |
| `AgentProjectEnvironment` / `AgentProjectEnvironmentService` | 快照类型、规范化摘要、模板映射 | 1 |
| `AgentFilePolicy` | 按环境统一目录/读/写权限 | 2 |
| 既有 DependencyChange + helper | main/test 组和锁文件协议 | 3 |
| `AgentPythonDependencyTools` | task 身份、调用结果、依赖收尾 | 4 |
| `python-environment.sh` / `manao-python-dev-build` / `python-check.py` | 运行环境共享、隔离语法与测试 | 5 |
| `PythonBuildEvidence` | 有界报告解析与验证状态 | 6 |
| `project-environment.ts` | worker 验证环境与生成提示词 | 7 |
| 既有工具结果 UI | 依赖/Python 验证的可见证据 | 8 |
| 真实闭环 fixtures / 验收文档 | 可复现两类 Python 流程 | 9 |

按 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 顺序执行；每项先测试红灯、实现、绿灯、检查差异再提交。Task 9 的外部部署/模型执行依当前授权，不由计划文件自动授权。

## Task 1: 保存可信环境并扩展启动合同

**Files:**
- Create: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentProjectEnvironment.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentProjectEnvironmentService.java`
- Create: `poc4/backend/src/main/resources/db/migration/V20__agent_project_environment.sql`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentContracts.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/AiConfig.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentProjectEnvironmentTest.java` (new)
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentTaskServiceTest.java`

**Interfaces:**
- Consumes: `ProjectRuntimeStore.loadSpec(projectId)`、`RunPolicy.forProject(spec)`、task 创建事务。
- Produces: `AgentProjectEnvironment` 对应设计 §4 全字段；`AgentProjectEnvironmentService.forProject(String projectId)`、`AgentProjectEnvironment.canonicalJson()`、`sha256()`。
- Produces: `AgentTaskStore.environmentOf(String taskId)` 读取已持久化快照；WorkerStart 增加 `environment`、`environmentSha256`。

- [x] **Step 1 — 写行为测试。** 枚举四模板，核对 framework/执行类型/工具/goals；快照中不含凭据。真实 MySQL 测试覆盖重复 submit、恢复读取、V19 升级、null 历史记录。mock runtimeStore 在首次提交后改变配置，再次提交必须仍返回原 task/快照。
- [x] **Step 2 — 运行红灯。**

```powershell
mvn -q -f poc4/backend/pom.xml '-Dtest=AgentProjectEnvironmentTest,AgentTaskServiceTest' test
```

- [x] **Step 3 — 实现新增字段与快照写入。** 新迁移仅 additive；迁移编号冲突时使用实施 checkout 的下一号并同步文档，不改已存在迁移。首次插入 task 的事务保存两个字段，重试分支读取已存字段。环境有单一规范化序列化入口，Java/TS 跨语言测试使用同一 golden JSON。

```sql
ALTER TABLE agent_task
  ADD COLUMN environment_json JSON NULL,
  ADD COLUMN environment_sha256 CHAR(64) NULL;
```

```java
// 新执行在 driveStart 前读取，不从本次请求猜测或重新派生。
AgentProjectEnvironment environment = tasks.environmentOf(taskId);
WorkerStart start = new WorkerStart(taskId, prompt, workspaceRevision,
    tasks.requestSha256Of(taskId), epoch, conversationId, reasoningEffort,
    environment, environment.sha256());
```

- [x] **Step 4 — 验证兼容与绿灯。** 原 request digest/terminal identity 不变；null 环境历史 task 的收尾不用新执行入口；新执行明确拒绝 null。相同 user intent 重复提交不重取动态环境。运行 Step 2、迁移升级测试与 `git diff --check`。
- [x] **Step 5 — 提交。** `git commit -m "feat(ai): persist trusted project environment per task"`，只 stage 本任务文件。

## Task 2: 按语言接通源码和测试文件

**Files:**
- Create: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentFilePolicy.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentProjectTools.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentFilePolicyTest.java` (new)
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentProjectToolsTest.java`

**Interfaces:**
- Consumes: Task 1 `AgentProjectEnvironment`；既有 WorkspacePathPolicy 和 workspace 工具。
- Produces: `AgentFilePolicy.forEnvironment(environment)`，实例方法 `canList(String)`、`canRead(String)`、`canWrite(String)`；toolPath 分读写判断。

- [x] **Step 1 — 写拒绝/允许矩阵。** 覆盖 `main.py`、`app/main.py`、`mypkg/lib.py`、`tests/test_main.py`、JSON/CSV/模板；父目录可遍历。根托管文件只读，隐藏/credential/venv/越界拒绝，Python pom 拒绝；Java 原路径不变。拒绝必须发生在 workspace IO 前。

```java
// 测试使用 Task 1 的真实环境工厂构造 python-console/fastapi 环境。
assertThat(policy.canRead("pyproject.toml")).isTrue();
assertThat(policy.canWrite("pyproject.toml")).isFalse();
assertThat(policy.canList("mypkg")).isTrue();
assertThat(policy.canWrite("mypkg/lib.py")).isTrue();
assertThat(policy.canWrite("pom.xml")).isFalse();
assertThat(policy.canRead(".venv/lib/site.py")).isFalse();
```

- [x] **Step 2 — 运行红灯。**

```powershell
mvn -q -f poc4/backend/pom.xml '-Dtest=AgentFilePolicyTest,AgentProjectToolsTest' test
```

- [x] **Step 3 — 接入 list/read/write 同一策略。** 从 task 快照取语言，列表根据 entry 类型筛选；权限通过后继续原路径、大小、sha、revision、receipt 逻辑。拒绝托管文件普通写时返回 `AI_MANAGED_FILE_WRITE_FORBIDDEN`，固定信息指向依赖工具。禁止 Python `pom.xml` 返回 `PATH_FORBIDDEN`。超过 128 KiB 保留 FILE_TOO_LARGE。
- [x] **Step 4 — 验证绿灯。** 用真实 workspace-agent 文件测试证明首次写 `tests/test_main.py` 可建父目录，修改现有文件需最新 sha；预先存在错误 pom 不自动删除。运行 Step 2 和既有 WorkspaceFileServiceTest。
- [x] **Step 5 — 提交。** `git commit -m "feat(ai): support Python project file policies"`。

## Task 3: 在原依赖协议中支持 test 组

**Files:**
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceAgent.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/PythonDependencyService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspaceApiClient.java`
- Modify: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/PythonDependencyEditor.java`
- Modify: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/WorkspaceAgentController.java`
- Modify: `poc4/workspace-agent/src/main/resources/python-dependency-helper.py`
- Test: `poc4/backend/src/test/java/com/manao/poc4/workspace/PythonDependencyOperationTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/workspace/PythonDependencyHttpContractTest.java`
- Test: `poc4/workspace-agent/src/test/java/com/manao/poc4/workspaceagent/PythonDependencyEditorTest.java`
- Test: `poc4/workspace-agent/src/test/java/com/manao/poc4/workspaceagent/PythonDependencyTransactionTest.java`
- Test: `poc4/python-runner/tests/dependency-editor.sh`

**Interfaces:**
- Consumes: 现有 prepare/commit/receipt 与 pinned uv helper。
- Produces: `DependencyChange(action, packageName, version, group)`，group 缺失为 main；保留三参数构造用于旧 main 调用。
- Produces: test 单包 protocol 3 摘要；main protocol 1、batch protocol 2 保持原字节。
- Produces: workspace-agent 新入口 `/agent/v1/python-dependencies/prepare-scoped`，只处理 test 单包变更，复用既有 editor 和 commit；WorkspaceApiClient.prepare 按 group 选固定入口，旧组件 404 映射 `PYTHON_DEPENDENCY_PROTOCOL_UNSUPPORTED`，不回退 main。

- [x] **Step 1 — 添加合同测试。** add/remove test，省略 group 等价 main，非法 group 拒绝；同 ID 改 group 拒绝；旧 digest fixtures 不变；失败不写 journal；删除最后测试依赖成功；main 变更后的 test 组仍验证可安装。旧 workspace-agent 不识别 scoped 路径时，不调用 main prepare；新 scoped 入口仍通过原 capability 签名过滤器。
- [x] **Step 2 — 运行红灯。**

```powershell
mvn -q -f poc4/workspace-agent/pom.xml '-Dtest=PythonDependencyEditorTest,PythonDependencyTransactionTest' test
mvn -q -f poc4/backend/pom.xml '-Dtest=PythonDependencyOperationTest,PythonDependencyHttpContractTest' test
```

- [x] **Step 3 — 扩展 wire 与固定 helper argv。** WorkspaceApiClient 现在手工组装 change JSON，必须显式增加 group，不能只改 record。helper 兼容旧参数形状；新增组仅接受 main/test，不允许任意 `--group` 字符串。目标 argv 形状：

```text
uv add --no-sync --no-build --no-sources --no-config --no-python-downloads --python /usr/local/bin/python3 --default-index https://mirrors.aliyun.com/pypi/simple/ --group test pytest
uv remove --no-sync --no-build --no-sources --no-config --no-python-downloads --python /usr/local/bin/python3 --default-index https://mirrors.aliyun.com/pypi/simple/ --group test pytest
uv sync --locked --no-dev --no-build --no-config --no-python-downloads --python /usr/local/bin/python3 --dry-run --group test
```

main 不传 group；dry-run 只在结果 TOML 实际有 test 组时加该固定参数。两次 uv 调用共享原 deadline；保留安全错误分类、scrubbed_env 和 source/build 限制。
- [x] **Step 4 — 验证实际 uv 0.11.6。** 沿用 dependency-editor.sh 的实际容器 fixture，确认新增/删除后 lock 由 uv 生成且 `uv sync --locked` 成功；test 组 missing/empty、包冲突、无 wheel、超时均有真实结果。运行 Step 2。不能用相近版本 Context7 文档代替镜像测试。
- [x] **Step 5 — 提交。** `git commit -m "feat(python): support managed test dependency group"`。

## Task 4: AI 依赖调用及可恢复收尾

**Files:**
- Create: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentPythonDependencyTools.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentProjectTools.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/project/AgentTaskOccupancy.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/PythonDependencyService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceOperationService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspaceApiClient.java`（reconcile 的单次请求服从剩余预算）
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/AiConfig.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentPythonDependencyToolsTest.java` (new)
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentTaskServiceTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/workspace/PythonDependencyOperationTest.java`

**Interfaces:**
- Consumes: durable ToolCallRow、Task 1 环境、Task 3 group 及依赖服务。
- Produces: `AgentPythonDependencyTools.invoke(String taskId, ToolCallRow row, ToolRequest request)` → ToolResult；`finishForClose(String taskId, ToolCallRow row)` → boolean。
- Produces: `PythonDependencyService.changeForAgent(String taskId, String toolCallId)` → Status，参数与 owner/project/operation/revision 从已登记调用读取；`reconcileForAgent(String taskId, String toolCallId)` 只核对原登记操作。
- Produces: `AgentTaskOccupancy.requireAgentDependencyCall(taskId, projectId, toolCallId, operationId)`；测试 no-op occupancy 实现同步补齐。

- [x] **Step 1 — 写 durable 竞争测试。** 扩展 AgentProjectToolsTest 的 disposable schema/StubAgent fixture 模式。用 CountDownLatch 在 prepare 完成前、PENDING 前、commit 后回包前暂停；分别发送 close，断言未授权新提交被阻止、已登记提交可完成、live claim 未释放前任务不可结束。
- [x] **Step 2 — 运行红灯。**

```powershell
mvn -q -f poc4/backend/pom.xml '-Dtest=AgentPythonDependencyToolsTest,PythonDependencyOperationTest,AgentTaskServiceTest' test
```

- [x] **Step 3 — 接入工具与受控入口。** 新工具加入 KNOWN_TOOLS、SIDE_EFFECT_TOOLS，并在 Java task 下后端拒绝。CAS 取得 claim，耗时依赖 IO 在 invoke 的项目 gate 外调度，由 service 保持现有项目操作同步；禁止长 IO 持有 AgentTaskStore monitor。首次登记 PENDING 与 task 状态锁定校验在同一事务内，不能靠不具备原子性的 callback 前置检查。

```text
REGISTERED → claim RUNNING → prepare
  → lock task row / verify same task+call+operation and accepting state
  → register PENDING / commit transaction
  → commit existing prepared journal → verify receipt
  → record both paths and revision → persist tool result → release claim
```

- [x] **Step 4 — 实现只核对原操作的恢复。** 新增依赖收尾分支及 cleanup claim；PENDING 继续同一 journal commit，COMMITTED 重建成功结果，无记录且已无执行只能退休原调用，绝不重新 prepare。每次 reconcile 服从 ReconcileWorkBudget；单次 IO timeout 不得超出剩余预算，不得用 browser reconcile 绕回 requireBrowserWritable。保持原 hasPendingReceipts 覆盖依赖行。
- [x] **Step 5 — 覆盖失败矩阵并绿灯。** 双文件部分写入/receipt 缺失/摘要不符继续占用；登记后响应丢失重试不增第二次 revision；completed 重放不碰 uv；跨 task/owner/project 拒绝；暂停后可通过新 task 继续；结束时无 task 所属 PENDING。两条 changedPaths 与 revision 必须在同一 task 更新事务记录，恢复路径也记录。运行 Step 2 与既有收尾测试。

  审查修复的既有矩阵与收尾测试记录保留原范围；2026-11-04 新增真实 AI service + workspace-agent 类/文件系统 + Docker uv + disposable MySQL 组合测试 1/1 PASS，补齐双文件部分写入、重建恢复及真实 receipt 后丢回包证据。该测试不经过 HTTP，Task 3 签名协议证据独立保留；不代表 Task 9 的模型/浏览器闭环已验收。见 [本地依赖组合证据](../../../poc4/docs/evidence/ai-python-environment/local-dependency-integration.md)。
- [x] **Step 6 — 提交。** `git commit -m "feat(ai): add durable Python dependency tool lifecycle"`。

## Task 5: 固定 Python 验证运行器

**Files:**
- Create: `poc4/python-runner/python-environment.sh`
- Create: `poc4/python-runner/manao-python-dev-build`
- Create: `poc4/python-runner/python-check.py`
- Modify: `poc4/python-runner/manao-python`
- Modify: `poc4/python-runner/Dockerfile`
- Modify: `poc4/python-runner/README.md`
- Create: `poc4/python-runner/tests/development-build.sh`
- Test: `poc4/python-runner/tests/runtime-lifecycle.sh`
- Test: `poc4/python-runner/tests/python-cache.sh`

**Interfaces:**
- Consumes: Python runner 固定解释器/uv/seed、workspace copy、test 组。
- Produces: root-owned `/usr/local/bin/manao-python-dev-build copy|compile|test`；固定路径 `/opt/manao-python/python-check.py`。
- Produces: `python-environment.sh` 函数 `manao_prepare_python_environment(mode)`，mode 只接受 runtime/test，共享 seed/cache/venv/extras；source 本身不执行用户代码。

- [x] **Step 1 — 写黑盒容器用例。** 成功语法、语法错、无源码、不 import 带副作用模块；pytest 成功/失败/无测试/全跳过/缺依赖；锁不匹配拒绝；main Runtime 不装 test；源码 hash 不变；副本超限、symlink、venv 排除、停止和 deadline。

```python
# compile 必须只检查该文件的语法，不能执行这条语句。
raise RuntimeError("SYNTAX_CHECK_MUST_NOT_IMPORT")
```

```python
# pytest 失败 fixture；修复前后应产生不同真实退出码。
def test_total():
    assert 2 + 2 == 5
```

- [x] **Step 2 — 运行红灯。** 在带生产限制的实际容器中执行 development-build.sh，缺 launcher 应明确失败，不标记 skip。复用 tests/lib.sh 的 UID、只读根、tmp/cache 卷及精确清理方式。
- [x] **Step 3 — 实现 launcher。** copy 固定 1000 文件/20 MiB、无特殊文件/credential/cache；compile 的 Python helper 逐文件编译为代码对象但不执行，不生成项目 pyc；test 初始化隔离 venv、锁定同步后执行固定 pytest。保留 pytest 原退出码，即使报告采集失败也不能覆盖为 0。

```python
# python-check.py 的语法检查核心；路径枚举遵守副本策略。
with tokenize.open(path) as source_file:
    compile(source_file.read(), relative_path, "exec")
```

```text
/tmp/manao-python/.venv/bin/python -m pytest -q -o addopts= --junitxml=/tmp/manao-python-tests.xml
```

- [x] **Step 4 — 加有界报告出口。** 用 `MANAO-PYTEST-REPORT-BEGIN/END` 包裹最多 64 KiB JUnit；结束标志含完整/缺失/截断状态。syntax 输出固定 JSON 结果（filesChecked/errors），上限 64 KiB；超限明确 unknown。SIGTERM/timeout 不能产生伪成功；清理受固定目录约束。
- [x] **Step 5 — 构建并验证。** 使用 README 既有 PythonSeedTemplateExporter 导出真实模板，Docker build `--target runtime-test`；测试 fixture 通过 uv add --group test pytest 生成锁，不修改默认项目模板增加测试依赖。精确命令：

```powershell
$taskSeedOutput = Join-Path (Get-Location).Path 'poc4/backend/target/python-seed-templates'
mvn -q -f poc4/backend/pom.xml -DskipTests test-compile org.codehaus.mojo:exec-maven-plugin:3.5.0:java '-Dexec.mainClass=com.manao.poc4.workspace.PythonSeedTemplateExporter' '-Dexec.classpathScope=test' "-Dmanao.seed.output=$taskSeedOutput"
docker build -f poc4/python-runner/Dockerfile --build-context seed-templates=./poc4/backend/target/python-seed-templates --target runtime-test -t manao-python-ai-runtime-test .
```

```bash
bash poc4/python-runner/tests/development-build.sh manao-python-ai-runtime-test
bash poc4/python-runner/tests/runtime-lifecycle.sh manao-python-ai-runtime-test
bash poc4/python-runner/tests/python-cache.sh manao-python-ai-runtime-test
```

Windows 使用已有 Bash/WSL 容器测试环境，路径按该环境解析；不为运行计划安装另一套工具链。记录真实版本与结果，测试后移除本任务临时容器/卷。
- [x] **Step 6 — 提交。** `git commit -m "feat(python): add isolated syntax and pytest runner"`。

## Task 6: 构建 Job 按环境分派并返回真实证据

**Files:**
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentContracts.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentProjectTools.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskStore.java` (删除前持久化有界观察，收尾确认后结算)
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/AiConfig.java` (注入 observation sink/loader)
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/Fabric8DevelopmentBuildExecutor.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobResourceFactory.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/ai/PythonBuildEvidence.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/DevelopmentJobResourceFactoryTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/DevelopmentBuildExecutorTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/PythonBuildEvidenceTest.java` (new)
- Test: `poc4/backend/src/test/java/com/manao/poc4/ai/AgentProjectToolsTest.java`

**Interfaces:**
- Consumes: task 环境、Task 5 launcher/report，既有 BuildRequest/BuildResult/BuildIdentity。
- Produces: BuildRequest 扩展 `AgentProjectEnvironment environment`；BuildResult 增加可空 `PythonBuildEvidence evidence`，Java 旧构造兼容。
- Produces: `PythonBuildEvidence.from(BuildGoal goal, Integer exitCode, String output, boolean truncated)`；record 字段按设计 §7 及以下枚举。

```java
enum VerificationStatus { PASS, FAILED, NO_TESTS, SKIPPED, UNKNOWN, NO_SOURCE }
```

- [x] **Step 1 — 添加分派与结果测试。** Java Job 与现有 manifest 保持等价；两 Python 模板 compile/test 选择 Python 镜像、cache、固定命令，package/未知语言在创建资源前拒绝。环境来自任务快照，模型不能传镜像/命令。parser 测 testsuites 嵌套、失败、collection error、全部 skipped、空报告、XXE、截断和非零返回。

```java
assertThat(PythonBuildEvidence.from(BuildGoal.TEST, 5, "", false).verificationStatus())
    .isEqualTo(VerificationStatus.NO_TESTS);
assertThat(PythonBuildEvidence.from(BuildGoal.TEST, 0, "", false).verificationStatus())
    .isEqualTo(VerificationStatus.UNKNOWN);
```

- [x] **Step 2 — 运行红灯。**

```powershell
mvn -q -f poc4/backend/pom.xml '-Dtest=DevelopmentJobResourceFactoryTest,DevelopmentBuildExecutorTest,PythonBuildEvidenceTest,AgentProjectToolsTest' test
```

- [x] **Step 3 — 扩展固定分派。** Java 使用原 launcher；Python source-copy 也使用 Python image 与新 launcher，cache 路径为 `/python-cache`。按快照 mysql/redis 传固定 extras 布尔值，验证 Job 不传数据库 Secret。Job 名/labels/UID 验证、source 只读 + emptyDir、安全上下文、预算、清理机制沿用。
- [x] **Step 4 — 接入结果与恢复。** 在 terminal observation/closeStep/close 的同一结果解析路径保留 Python evidence，禁止只正常执行有证据、取消恢复丢失。`buildRequestOf` 使用 row.expectedRevision；task 快照决定语言。旧 null 环境调用仅为历史 Maven 收尾建立显式 legacy build 描述，不能让新执行静默默认 Java。
- [x] **Step 5 — 绿灯及清理证明。** 四类定向测试 96/0/0；修复 NEEDS_ATTENTION 收尾结算后受影响 39/0/0。原 UID/commandId、409 删除后新 Store 恢复、cleanupConfirmed 门禁已验证。Task 5 runner 字节未改，按本轮协调指令不重复容器测试；Task 5 自身证据仍归 Task 5。真实集群/模型 NOT_RUN。
- [x] **Step 6 — 提交。** `git commit -m "feat(ai): dispatch builds by project runtime"`。

Task 6 本地修正：原 closeStep 删除前不读取日志，异步清理/重启会丢报告。增加最小 write-ahead `pendingBuildEvidence` wrapper，沿用 tool-call `result_json`，不改变未决调用状态；验证 commandId/sourceRevision/environment hash/UID 后，仅在资源确认为空时结算。无 schema 扩展。

Task 6 复审修正 I1/I2：原 Job 存在但 Pod 已删除时，observe 从持久化终态继续原 UID 清理，不再重新等待构建；Store 保留第一次已知退出与报告，拒绝弱化覆盖。首次 close 发现的真实 Pod UID 随观察在删除前持久化；与既有绑定冲突时拒绝操作。

## Task 7: worker 环境注入、工具裁剪与 Python 工作规则

**Files:**
- Create: `poc4/pi-worker/src/project-environment.ts`
- Modify: `poc4/pi-worker/src/server.ts`
- Modify: `poc4/pi-worker/src/pi-session.ts`
- Modify: `poc4/pi-worker/src/project-tools.ts`
- Modify: `poc4/pi-worker/src/prompts.ts`
- Modify: `poc4/pi-worker/README.md`
- Test: `poc4/pi-worker/test/project-environment.test.ts` (new)
- Test: `poc4/pi-worker/test/server.test.ts`
- Test: `poc4/pi-worker/test/project-tools.test.ts`
- Test: `poc4/pi-worker/test/pi-session.test.ts`
- Test: `poc4/pi-worker/test/pi-session-context.test.ts`
- Test: `poc4/pi-worker/test/context-compaction.test.ts`
- Test: `poc4/pi-worker/test/manual-compaction.test.ts`

**Interfaces:**
- Consumes: Task 1 environment JSON/hash，Task 4 python_dependencies，Task 6 build 语义。
- Produces: `parseProjectEnvironment(value: unknown): ProjectEnvironment`、`environmentSha256(environment)`、`buildSystemPrompt(environment): string`。
- Produces: `createProjectTools(deps, environment): ToolDefinition[]`；Pi session 使用实际返回工具名，禁止另存一份失真的固定数量。

- [x] **Step 1 — 写模型请求级测试。** 四模板、缺字段、组合冲突、摘要不符、重复 start 变环境拒绝；工具 schema 中 Python build 没 package，Java 没依赖工具，console 没 HTTP。准备含旧 Spring Boot 摘要的 Python 会话，捕获实际 provider 请求验证当前 Python system 与 tools。
- [x] **Step 2 — 运行红灯。**

```powershell
pnpm -C poc4/pi-worker exec vitest run test/project-environment.test.ts test/server.test.ts test/project-tools.test.ts test/pi-session.test.ts test/pi-session-context.test.ts test/context-compaction.test.ts test/manual-compaction.test.ts
```

- [x] **Step 3 — 生成固定规则加可信环境。** 资源加载仍禁止磁盘自动扩展。环境合法性和摘要校验发生在创建会话前。新增依赖参数 schema 为 strict object，不允许 owner/project/revision/operationId；worker 从自身 revision 状态注入 expectedRevision。依赖 unknown 与既有 AI_CALL_NEEDS_ATTENTION 一样终止继续写入。

```typescript
const customTools = createProjectTools(toolDeps, environment);
const loader = new DefaultResourceLoader({
  cwd: paths.scratchDir, agentDir: paths.agentDir, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true,
  noThemes: true, noContextFiles: true,
  systemPrompt: buildSystemPrompt(environment), appendSystemPrompt: [],
});
// createAgentSession 的 tools 使用 customTools.map(tool => tool.name)。
```

- [x] **Step 4 — 更新闭环与压缩规则。** console 等待终态/exit/log；service 等 ready/log/HTTP；测试可先失败再修复；syntax 不等于通过测试；缺测试依赖自动调用 test 组 add；不靠手写 pyproject/lock 解决。任务前、SDK 自动、手动压缩后下次请求均保留环境，实际工具不被历史 transcript 恢复成旧 loadout；继续保持 ACK-before-provider、图片复读、取消和预算。
- [x] **Step 5 — 绿灯与回归。** 先 Step 2，再一次 worker 全量测试与构建：

```powershell
pnpm -C poc4/pi-worker test
pnpm -C poc4/pi-worker build
```

- [x] **Step 6 — 提交。** `git commit -m "feat(ai): inject environment and expose matching Python tools"`。

## Task 8: 在工作台展示依赖与 Python 验证结果

**Files:**
- Modify: `poc4/frontend/src/contracts/agentTask.ts`
- Modify: `poc4/frontend/src/features/ai/AgentTaskPanel.tsx`
- Modify: `poc4/frontend/src/features/ai/AgentConversationPanel.tsx`
- Test: `poc4/frontend/src/features/ai/ToolResultView.test.tsx`
- Test: `poc4/frontend/src/features/ai/AgentTaskPanel.test.tsx`
- Test: `poc4/frontend/src/features/ai/AgentConversationPanel.test.tsx`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/ai/AgentProjectTools.java` 的 browser 投影

**Interfaces:**
- Consumes: 已 settle ToolResult 和 task changedPaths/revision。
- Produces: `pythonDependencyData(result)`、`pythonBuildData(result)` 返回校验后的可空结构；扩展现有 buildToolCallId 识别依赖工具，保留旧导出兼容。

- [x] **Step 1 — 写 UI 结果测试。** 依赖提交显示包/组/状态/两条路径；Python compile/test 显示检查种类、真实 exit、计数、报告完整性；NO_TESTS/SKIPPED/UNKNOWN/NO_SOURCE 不渲染为 PASS；Java 旧结果可读。
- [x] **Step 2 — 运行红灯。**

```powershell
pnpm -C poc4/frontend exec vitest run src/features/ai/ToolResultView.test.tsx src/features/ai/AgentTaskPanel.test.tsx src/features/ai/AgentConversationPanel.test.tsx
```

- [x] **Step 3 — 实现解析与展示。** browser 投影只公开业务结果，不返回 namespace/Pod/镜像挂载细节。复用当前工具结果入口，文案区分依赖变更/语法检查/测试。已确认 changedPaths 触发现有文件刷新链路；两文件更新与 revision 同步，切换项目或接管后旧响应不能覆盖当前编辑内容。

```typescript
// 展示只消费明确状态；未拿到结构化证据时保持未知。
const label = data.verificationStatus === 'NO_TESTS'
  ? '未发现测试'
  : data.verificationStatus === 'SKIPPED'
    ? '全部测试跳过'
    : data.verificationStatus === 'UNKNOWN'
      ? '验证证据不完整'
      : data.verificationStatus;
```

- [x] **Step 4 — 绿灯与类型检查。** Step 2、`pnpm -C poc4/frontend typecheck`。UI 变更使用既有 fixture 页做一次浏览器检查；fixture 结果不计入真实模型验收。
- [x] **Step 5 — 提交。** `git commit -m "feat(frontend): show Python verification and dependency results"`。

## Task 9: 两类 Python 闭环验收、部署手册与交付

实施核对：设计 §10 的四产物指 backend、pi-worker、workspace-agent、python-runner 四项运行时产物；Task 8 同时修改 frontend，发布必须再构建并部署配套 UI 产物，共五项，不遗漏界面交付。该补充只修正发布清单，不授权当前执行发布或真实模型调用；Step 6 保持 NOT_RUN。

**Files:**
- Create: `poc4/frontend/playwright.ai-python.config.ts`
- Create: `poc4/frontend/tests/e2e/ai-python.spec.ts`
- Create: `poc4/frontend/tests/fixtures/ai-python/console/main.py`
- Create: `poc4/frontend/tests/fixtures/ai-python/console/tests/test_main.py`
- Create: `poc4/frontend/tests/fixtures/ai-python/fastapi/app/main.py`
- Create: `poc4/frontend/tests/fixtures/ai-python/fastapi/tests/test_api.py`
- Create: `poc4/docs/evidence/ai-python-environment/acceptance.md`
- Create: `poc4/deploy/ai-python-environment/README.md`
- Modify: `poc4/frontend/package.json` 增加 `test:e2e:ai-python`
- Modify: `.gitattributes` 为新增 fixture 目录固定 LF
- Modify: `docs/README.md`、`poc4/docs/README.md`、`docs/what-we-have-done.md`（只记录真实阶段状态及入口）

**Interfaces:**
- Consumes: Tasks 1–8，现有真实 ai-stage1 与 python-runtime 验收机制。
- Produces: 设计 E1–R1 的逐项证据；标签 `AI_PYTHON_LOCAL_PASS` 与 `AI_PYTHON_CLOSED_LOOP_PASS` 分开。
- Produces: 配置变量 `MANAO_AI_ACCEPTANCE_BASE_URL/USERNAME/PASSWORD` 复用；新增 `MANAO_AI_PYTHON_CONSOLE_PROJECT_ID`、`MANAO_AI_PYTHON_FASTAPI_PROJECT_ID`。缺变量时脚本 fail with missing names，不能输出值、静默 skip 或连接默认生产项目。

- [x] **Step 1 — 建立两个可诊断失败场景。** console 有错误结果函数及断言；FastAPI 有错误业务响应，保留固定健康端点。fixture 不带凭据。seed 原模板后，通过受控接口准备 fixture，初始 lock 由 uv 生成；验收不手工补模型漏掉的结果。固定容器中分别实际 exit=1/断言失败；仅容器副本修正后 exit=0，详见验收记录。

```python
# console/main.py：初始错误为可重复证据。
def total(values):
    return sum(values) + 1

if __name__ == '__main__':
    print(total([1, 2, 3]))
```

```python
# console/tests/test_main.py
from main import total

def test_total():
    assert total([1, 2, 3]) == 6
```

- [x] **Step 2 — 编写真实验收，先验证能抓住失败。** Playwright 配置直接指向外部 baseURL，无 fixture webServer、无模型 mock。任务要求 Agent 先记录失败、修复、添加所需 main/test 依赖、验证、运行，再响应用户第二轮小修改完成重跑。console 最终核对输出与 exit=0；FastAPI 核对 firstReadyAt 和业务 GET 状态/内容。增删依赖两方向由 D1 集成测试覆盖，真实模型两场景各需发生 main/test 变更。验收合同本地 RED 5 failed → GREEN 5 passed，独立 tsc 通过；真实配置未执行，包括未运行 `--list`。
- [ ] **Step 3 — 验证非 happy-path。** 在 disposable 项目验证 dependency commit 响应丢失、PENDING 重启、prepare/commit 边界取消、pytest 超时取消；保留原身份和失败证据，最终确认该任务无未决操作、无构建 Job/Pod。已有会话继续与一次压缩后继续要看到当前环境；图片回归用已有图片测试，不要求模型在每个 Python 场景上传图片。
  本地实际组合、取消/重启/UID fixture 已收录；后续真实 pytest pause/安全收尾/同会话新任务已 PASS。真实 dependency 回包丢失、PENDING 重启与提交边界取消的完整云矩阵仍 NOT_RUN，本项保持未勾选。
- [x] **Step 4 — 本地联合回归。** backend/workspace-agent 相关套件、worker 全量、前端相关套件、Python 容器套件和全分支最终复审已完成，授予范围限定的 AI_PYTHON_LOCAL_PASS。最新构建结算 149/149、兼容组 86/86、worker 266 PASS / 1 SKIPPED、前端 155 PASS；各次验证源码边界、容器证据与未执行项见[验收记录](../../../poc4/docs/evidence/ai-python-environment/acceptance.md)，不合并重复用例总数。
- [x] **Step 5 — 完成可审阅部署手册。** 写明四运行产物及配套 frontend 的构建/digest、V20 迁移、旧 task 排空、旧 Python workspace Pod 更新、已有 PVC 保留、兼容顺序和回滚；从实际配置读取目标 namespace/schema，用户授权发布时再执行。不能只更新模板镜像而忽略已有 workspace Pod。
- [ ] **Step 6 — 获得对应授权后执行真实发布与闭环。** 记录同一构建 SHA、真实模型/provider 配置标识（无密钥）及工具/operation/Run 证据；运行：

```powershell
pnpm -C poc4/frontend exec playwright test --config playwright.ai-python.config.ts
```

后续已执行五项发布、V20、两个 Python 两轮核心流程、Java 两模板、main/test 增删往返与 pytest pause/继续。FastAPI 完整场景脚本曾在工作区 reload 失败后停止，重新进入同会话继续通过；全部故障矩阵仍未闭合，本项保持未勾选，不授予 AI_PYTHON_CLOSED_LOOP_PASS。详情与失败记录见[云端记录](../../../poc4/docs/evidence/ai-python-environment/cloud-20261104.md)。
- [x] **Step 7 — 文档自审与本地提交。** README 链接可解析、没有私有 worktree 路径或凭据；`git diff --check` 和编码检查通过；本次临时产物已清理，必要证据保留。产物提交 `0f80538` 及验收合同修复 `67feff6` 已完成；全分支最终复审批准，提交清单见[交付记录](../../../poc4/docs/evidence/ai-python-environment/delivery.md)。代码合并/push 不在当前授权内。

## 2. 需求到任务的覆盖检查

| 设计要求 | 实施任务 |
| --- | --- |
| E1 环境真实性、重试/历史兼容 | 1、6、7 |
| E2 会话与压缩 | 7、9 |
| F1 Python 路径与托管文件 | 2、7、8 |
| D1 自动 main/test 依赖 | 3、4、7、8 |
| D2 取消、重启、双文件核对 | 4、9 |
| B1 Python 执行和隔离 | 5、6 |
| B2 真实语法/pytest 状态 | 5、6、8 |
| L1 console 闭环 | 7、9 |
| L2 FastAPI 闭环 | 7、9 |
| L3 依赖与运行一致 | 3、5、9 |
| R1 Java/图片/任务控制回归 | 1、4、6、7、9 |
| 四产物发布、旧 workspace、回滚 | 9 |

## 3. 本规划的完成状态

- 已完成：设计与计划、Tasks 1–8 本地实现/分层验证、Task 4 真实依赖双文件故障组合、Task 9 失败 fixture/真实验收脚本/部署手册与证据导航。具体局部结果、修复后的重跑边界及 Task 9 检查见 [验收记录](../../../poc4/docs/evidence/ai-python-environment/acceptance.md)。
- 本地最终核对：Task 9 联合回归与全分支复审完成，`AI_PYTHON_LOCAL_PASS` 保持；后续授权的发布、V20、Python/FastAPI 两轮核心流程、Java 与 pause/继续已执行。
- 尚未执行：完整云 dependency/重启/提交故障矩阵、真实自动压缩、新图片模型输入专项及正式回滚。旧 Python workspace 更新为 SKIPPED（发布前无 Python 项目）；Step 3/6 保持未勾选，`AI_PYTHON_CLOSED_LOOP_PASS` 未授予。Git push/merge、共享资源删除均未执行。
- 技术边界已给出明确方案，无占位实施任务；设计评审如调整边界，应同步本文后再执行。
