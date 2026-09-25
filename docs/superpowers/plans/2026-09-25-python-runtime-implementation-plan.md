# Python Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 顺序执行，不自动派生子代理；实施开始前重新读取本检出的 AGENTS.md。

**Goal:** 在已交付 Java 运行环境上增加 Python 普通程序、FastAPI Web 服务及最小 uv 依赖增删入口，完成浏览器编辑、执行、反馈、再次修改和项目回收闭环。

**Architecture:** 复用项目配置、工作区 receipt、Run/Job、日志、端口、依赖和清理模块。固定模板决定语言差异；Python 使用独立运行镜像、项目私有 uv 下载缓存和每 Run 隔离 venv，服务运行复用现有监督器。依赖增删采用临时解析及可恢复的双文件提交，不引入通用插件或后台任务平台。

**Tech Stack:** 既有 Java 17/Spring Boot/Fabric8/MySQL 后端与 workspace-agent；React/TypeScript/pnpm 前端；Python 3.13、uv、FastAPI、Uvicorn；Kubernetes Job + Service + PVC；JUnit、Vitest、真实 Linux 容器及 Playwright。

**Spec:** [Python Runtime Design](../specs/2026-09-25-python-runtime-design.md)。

**Status:** 计划已编写，Task 1–10 均未执行。用户已确认“普通 Python + FastAPI”和“最小 uv add/remove 入口”；具体实现以本文与设计共同评审。当前任务不授权实际发布或集群变更。

**Base:** `06e8133820867cc9d200ab63913d1a282d2dedf6`，已包含 `ef1b5bb`。工作树 `.worktree/python-runtime`，分支 `codex/python-runtime`。所有 Files 路径相对于实施检出。

## Global Constraints

- 本轮功能范围仅 Python；Java 继续可用，Go、TypeScript、AI 分开规划；不重新执行已完成的 Java Tasks 1–9 或历史 6A/6B gate。
- Python 固定为 3.13 系列；Python 补丁版、uv 精确版本及基础镜像 digest 通过 Task 2/6 的构建记录固定；agent 与 runner 的 Python/uv 必须一致。版本值必须来自实际分发物，不能填写假 digest。
- 依赖增删只用 `uv add/remove`；Run 使用 `uv sync --locked --no-dev --no-build`。不得用 pip、uv pip、全局可写 venv，亦不得用 `--frozen` 掩盖锁过期。
- 普通程序固定入口 `main.py`；FastAPI 固定入口 `app.main:app`，单 Uvicorn 进程，不 reload。展示命令与执行参数分开，禁止自由 shell/image/env 输入。
- TASK 1800 秒总预算；SERVICE 启动 1800 秒，首次 readiness 后 7200 秒；手动再次运行，既有 claim、Pod UID、receipt 和进程终止规则继续成立。
- MySQL 仍是独立项目 PVC；Redis 仍是非持久缓存。公网端口用户手填 `30000–31000`，冲突要求修改，容器端口 `1–65535`，最多三条 TCP 映射。
- 缓存位于 workspace PVC 的 `.manao-cache/python`，在代码 subPath 外；不新增缓存 PVC或跨项目可写缓存；删除项目才回收。
- 未知 transport 结果先核对持久化 receipt；Forbidden/Unknown/timeout 不能当 NotFound；双文件提交不能用两个无关联 SAVE 伪装为原子操作。
- 代码改动先写有行为意义的失败测试，再最小实现、定向验证和聚焦提交；不为文档文字或内部字段重复写低价值测试。测试数据库使用 disposable schema，不重置 runtime schema。
- 前端只用 pnpm。UTF-8 无 BOM，shell/Docker 入口 LF；对新目录扩展 `.gitattributes`。Windows 编辑前重新读取当前文件。
- 仅清理本任务明确拥有的临时目录/测试资源；保留既有 DELETING 诊断、私有配置和 unrelated changes。每个执行任务结束运行 `git diff --check`。

## 1. Module、Interface 与任务边界

| Module | Interface / 责任 | 任务 |
| --- | --- | --- |
| 固定模板与 Run 策略 | 模板 ID →语言、TASK/SERVICE、固定命令、默认端口；旧快照兼容 | 1 |
| Python 模板 | `WorkspaceTemplate.directories/files(spec)` 返回真实资源，锁文件由 uv 生成 | 2 |
| agent 依赖编辑 | 临时解析、两个固定文件的持久化 journal、确定性完成/核对 | 3 |
| 后端依赖操作 | 所有权、revision、单活动操作、组合摘要、receipt 和一次 revision 提交 | 4 |
| 服务监督 | 有限 profile →固定子命令及 readiness 路径；共享寿命实现 | 5 |
| Python 运行镜像 | uv 安装、缓存 seed、隔离 venv、固定进程入口及真实容器验证 | 6 |
| Run/Job 接入 | 从持久化快照选择镜像和挂载，保持恢复/日志/端口/清理身份 | 7 |
| 浏览器闭环 | 模板选择、依赖操作、Python Run 解析与展示、编辑锁和重载 | 8 |
| 发布准备 | agent/runner/backend/frontend 一致构建、digest、部署与回滚说明 | 9 |
| 独立验收 | 云端 Python 生命周期与 Java 回归、存储清理、时限证据 | 10 |

### 1.1 固定类型约定

Task 1 新增内部枚举，后续任务不得另起一个 provider/registry：

```java
// package com.manao.poc4.project
public enum RuntimeTemplate {
    JAVA_CONSOLE, JAVA_SPRING_BOOT_WEB, PYTHON_CONSOLE, PYTHON_FASTAPI_WEB;

    // 以下方法在 Task 1 实现；id 是外部字符串，枚举名不直接出现在 HTTP 中。
    public static RuntimeTemplate fromId(String id); // unknown -> VALIDATION_ERROR
    public String id();
    public String language();                       // java | python
    public boolean isService();
    public int defaultPort();                       // Java 8080, Python web 8000
    public String displayCommand();
}
```

以上为 Interface 清单，不是可直接编译的 enum 文件。RunPolicy 的公开方法统一为 `forProject(ProjectRuntimeSpec spec)`、`template()`、`isService()`、`toJson()`、`fromJson(String)`；嵌套 `RuntimeInfo` 负责两种语言的 JSON，避免 Python 使用假 javaMajor 值。旧 `fromProperties` 仍提供 Java console 默认策略；保留原 Java 构造函数和 `forService()` 的委托兼容入口，以免将无关测试重构混入本任务。

FastAPI 展示命令使用 `python -u -m uvicorn app.main:app`；实际 host/port 由固定 launcher 的验证后参数补齐。新 Java SERVICE 展示 `mvn -q -DskipTests spring-boot:run`；历史无 templateId 的旧 SERVICE console 命令按设计第 5 节兼容。

### 1.2 依赖操作约定

固定 DTO：`DependencyChange(action, packageName, version)`，action 只允许 `ADD`/`REMOVE`；包名为 1–128 个 ASCII 字母、数字、点、下划线和连字符，首尾必须字母或数字；version 可空，非空只接受单个精确版本且不能包含空白、斜杠、@ 或 CLI 选项。REMOVE 必须 version=null。

浏览器请求字段：`action`、`packageName`、`version`、`expectedWorkspaceRevision`；成功响应：`workspaceRevision`、`changedPaths=["pyproject.toml","uv.lock"]`。结果不明调用 `POST /api/v1/projects/{projectId}/python-dependencies/reconcile`，不得重发依赖命令。V10 仅在现有 workspace_operation 补不可变 operation_kind（FILE / PYTHON_DEPENDENCIES），不新增依赖数据库表。

agent 的专用记录（backend transport 与 agent DTO 结构一致）：

```java
record DependencyChange(String action, String packageName, String version) {}
record PreparedPythonDependencies(String operationId, String beforeSha256,
    String afterSha256, String pyprojectContent, String lockContent) {}
record PythonDependencyCommit(PreparedPythonDependencies prepared,
    String receiptJson, String receiptSha256) {}
```

agent endpoint：`POST /agent/v1/python-dependencies/prepare`、`/apply`、`/recover`，全部要求现有 capability 签名。recover 请求只允许 operationId 和后端已存储的 before/after/receipt 摘要，返回既有 `MutationResult`；不接受新的 package command。普通 receipt GET 保持只读。

固定错误：输入错误 `VALIDATION_ERROR`；不支持的 Python 声明 `PYTHON_DEPENDENCY_UNSUPPORTED`；uv 解析/包不存在 `PYTHON_DEPENDENCY_RESOLUTION_FAILED`；超时 `PYTHON_DEPENDENCY_TIMEOUT`。对应固定安全文本，不能回显 uv 原始 stderr。活动 Run、revision 冲突和 apply 结果不明使用既有锁/冲突/`WORKSPACE_RECONCILIATION_REQUIRED` 语义。

## Task 1：固定模板、Run 快照及旧 Java 兼容

**Files**
- Create: `poc4/backend/src/main/java/com/manao/poc4/project/RuntimeTemplate.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectRuntimeSpec.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunPolicy.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectRuntimeSpecTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectRuntimeStoreTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/run/RunPolicyTest.java`

**Interfaces:** 消费既有 ProjectRuntimeSpec、BackendProperties；产出 1.1 中的固定模板映射及新旧快照解析。新增字段放在已有 JSON 中，不创建语言表或修改旧 migration。

- [ ] **Step 1 — 写行为失败测试。** 新 Python console 不能带 MySQL/Redis 或公网端口；Python web 默认 8000、第一映射覆盖主端口；Java 默认保持 8080 和旧配置兼容。四模板 round-trip，未知模板拒绝；缺失语言的旧 Run 仍可读，新 Python 快照不能有假 Java 标识。

```java
@Test
void pythonServiceHasItsOwnPolicyAndLegacyJavaStillLoads() {
    var spec = new ProjectRuntimeSpec("python-fastapi-web", true, true, List.of());
    assertThat(spec.isService()).isTrue();
    assertThat(spec.primaryPort()).isEqualTo(8000);
    var policy = RunControllerTest.policy().forProject(spec);
    assertThat(policy.template()).isEqualTo(RuntimeTemplate.PYTHON_FASTAPI_WEB);
    assertThat(policy.toJson()).contains("\"language\":\"python\"")
        .doesNotContain("javaMajor");
    assertThat(RunPolicy.fromJson(policy.toJson())).isEqualTo(policy);
}
```

另放完整旧 TASK/SERVICE JSON fixture，验证 absence 与 unknown 是不同情况。ProjectRuntimeStoreTest 使用 disposable MySQL 验证 JSON 持久化，不把 mock 视作 store 证据。

- [ ] **Step 2 — 定向运行并确认因为缺少 Python 支持失败。**

```powershell
mvn -q -f poc4/backend/pom.xml '-Dtest=ProjectRuntimeSpecTest,RunPolicyTest' test
```

- [ ] **Step 3 — 实现固定分支。** `ProjectRuntimeSpec.isService/primaryPort` 委托枚举；`toJson/creationDigest` 不增加派生字段，保持旧创建摘要。RunPolicy 构造需要调整的既有测试调用点同时更新，不保留两个互相矛盾的 runtime 来源。

```java
public boolean isService() { return RuntimeTemplate.fromId(templateId).isService(); }
public int primaryPort() {
    return publicPorts.isEmpty() ? RuntimeTemplate.fromId(templateId).defaultPort()
        : publicPorts.get(0).targetPort();
}
```

- [ ] **Step 4 — 上述单测及真实 JSON store 定向测试通过。** `mvn -q -f poc4/backend/pom.xml '-Dtest=ProjectRuntimeStoreTest' test`；环境缺失记录 NOT_REVERIFIED，不重置运行库。
- [ ] **Step 5 — 差异/编码核对并聚焦提交。** 建议 `feat(runtime): add fixed Python templates and compatible run policies`。

## Task 2：实际 Python 模板、锁文件和编辑器元数据

**Files**
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceTemplate.java`
- Create: `poc4/backend/src/main/resources/workspace-template-python/pyproject.toml`
- Create: `poc4/backend/src/main/resources/workspace-template-python/uv.lock`
- Create: `poc4/backend/src/main/resources/workspace-template-python/.python-version`
- Create: `poc4/backend/src/main/resources/workspace-template-python/.gitignore`
- Create: `poc4/backend/src/main/resources/workspace-template-python/README.md`
- Create: `poc4/backend/src/main/resources/workspace-template-python/main.py`
- Create: `poc4/backend/src/main/resources/workspace-template-python-web/pyproject.toml`
- Create: `poc4/backend/src/main/resources/workspace-template-python-web/uv.lock`
- Create: `poc4/backend/src/main/resources/workspace-template-python-web/README.md`
- Create: `poc4/backend/src/main/resources/workspace-template-python-web/app/__init__.py`
- Create: `poc4/backend/src/main/resources/workspace-template-python-web/app/main.py`
- Create: `poc4/backend/src/test/java/com/manao/poc4/workspace/PythonSeedTemplateExporter.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/workspace/WorkspaceTemplateTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/workspace/WorkspaceTemplateClasspathResourceTest.java`
- Modify: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/WorkspaceFileService.java`
- Modify: `poc4/workspace-agent/src/test/java/com/manao/poc4/workspaceagent/WorkspaceFileServiceTest.java`

**Interfaces:** `WorkspaceTemplate.directories/files(spec)` 按模板 ID 分派，Web 复用普通模板的 `.python-version/.gitignore`；exporter 经相同公开入口导出实际两个模板及依赖组合，输出仅可在自有 `target/python-seed-templates`。

- [ ] **Step 1 — 测试实际 Python 资源的路径、父目录、UTF-8、锁存在、四种 dependency selection 以及旧 Java 文件不变化。** agent meta 对 `.py` 返回 `language=python`，`.toml/uv.lock` 可读为普通文本。

```java
@Test
void pythonTemplateIsNotRenderedAsJava() {
    var spec = new ProjectRuntimeSpec("python-console", false, false, List.of());
    var files = new WorkspaceTemplate().files(spec);
    assertThat(files).containsKeys("main.py", "pyproject.toml", "uv.lock")
        .doesNotContainKeys("pom.xml");
    assertThat(files.get("main.py")).contains("Hello from Manao");
}
```

- [ ] **Step 2 — 确认失败。** `mvn -q -f poc4/backend/pom.xml '-Dtest=WorkspaceTemplateTest,WorkspaceTemplateClasspathResourceTest' test`。
- [ ] **Step 3 — 创建模板。** console `main.py` 输出欢迎语；Web 根路由和 readiness 使用设计第 6 节契约。就绪检查对数据库只读、有限超时，失败返回固定 503，不输出异常连接信息。

```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/api/demo")
def demo():
    return {"message": "Hello from Manao"}
```

在拥有独立 `.venv` 的临时模板项目使用 `uv add fastapi uvicorn`、`uv add --optional mysql 'PyMySQL[rsa]'`、`uv add --optional redis redis` 生成 Web 声明及 lock；普通模板使用空 dependencies 并运行 `uv lock`。记录实际 uv 版本，模板 `requires-python = ">=3.13,<3.14"`。模板条件代码消费 `MANAO_MYSQL_* / MANAO_REDIS_*`，勾选通过受控 env/模板条件决定，不要求用户提供数据库密码。

- [ ] **Step 4 — 导出并执行真实模板验证。** 测试模板 `uv sync --locked`，console 正常退出，Web `/api/demo` 为 200；MySQL/Redis 选中却未提供服务时 readiness 为 503，未选中不连接。Task 6 将在最终镜像复跑全部依赖组合。agent：`mvn -q -f poc4/workspace-agent/pom.xml '-Dtest=WorkspaceFileServiceTest' test`。
- [ ] **Step 5 — 清理自有临时 venv/export，保留模板及 lock，差异检查并提交。** 建议 `feat(workspace): add uv-managed Python templates`。

## Task 3：agent 临时解析和可恢复双文件提交

**Files**
- Create: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/PythonDependencyEditor.java`
- Create: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/PythonDependencyTransaction.java`
- Create: `poc4/workspace-agent/src/main/resources/python-dependency-helper.py`
- Modify: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/WorkspaceAgentController.java`
- Modify: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/WorkspaceAgentConfig.java`
- Modify: `poc4/workspace-agent/Dockerfile`
- Create: `poc4/workspace-agent/src/test/java/com/manao/poc4/workspaceagent/PythonDependencyEditorTest.java`
- Create: `poc4/workspace-agent/src/test/java/com/manao/poc4/workspaceagent/PythonDependencyTransactionTest.java`
- Modify: `poc4/workspace-agent/src/test/java/com/manao/poc4/workspaceagent/WorkspaceAgentApplicationTest.java`

**Interfaces:** 对应 1.2 的 prepare/apply/recover。Editor 负责 scratch 内 uv，并调用 Transaction 持久化生成结果后才返回；Transaction 只处理两路径的 journal、组合摘要、写入和 receipt。二者不持有用户身份，也不自行修改 MySQL revision。agent DTO 为 PythonDependencyEditor 的嵌套 record；backend DTO 为 WorkspaceAgent 的嵌套 record。

Transaction 提供 `stage(String operationId, String pyprojectContent, String lockContent)` 返回 PreparedPythonDependencies、`apply(PythonDependencyCommit)` 和 `recover(String operationId, String beforeSha256, String afterSha256, String receiptSha256)` 返回 MutationResult。生产构造 `PythonDependencyTransaction(Path root)`；测试构造增加 `IntConsumer afterRename` 作为包内故障注入点，不能通过 HTTP 配置。

- [ ] **Step 1 — 注入临时目录、进程执行器和一次崩溃点，先验证外部可观察结果。** prepare 失败源文件不变；改第一文件后中断，重建 Transaction 从磁盘 manifest 完成第二文件；重复 recover 结果相同；第三种内容不覆盖；没有 receipt 不声称已提交；symlink escape 拒绝。

```java
@Test
void recoversTheSamePairAfterInterruptionBetweenFiles(@TempDir Path root) throws Exception {
    Files.writeString(root.resolve("pyproject.toml"), "[project]\nname='demo'\n");
    Files.writeString(root.resolve("uv.lock"), "version = 1\n");
    var tx = new PythonDependencyTransaction(root, completed -> {
        if (completed == 1) throw new IllegalStateException("simulated crash");
    });
    var prepared = tx.stage("11111111-1111-4111-8111-111111111111",
        "[project]\nname='updated'\n", "version = 1\nrevision = 3\n");
    String receipt = "{\"operationId\":\"%s\",\"type\":\"PYTHON_DEPENDENCIES\","
        + "\"path\":\"pyproject.toml\",\"nextPath\":\"uv.lock\","
        + "\"beforeSha256\":\"%s\",\"afterSha256\":\"%s\"}";
    receipt = receipt.formatted(prepared.operationId(), prepared.beforeSha256(), prepared.afterSha256());
    String receiptSha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
        .digest(receipt.getBytes(StandardCharsets.UTF_8)));
    var commit = new PythonDependencyCommit(prepared, receipt, receiptSha);
    assertThatThrownBy(() -> tx.apply(commit)).isInstanceOf(IllegalStateException.class);
    var recovered = new PythonDependencyTransaction(root).recover(prepared.operationId(),
        prepared.beforeSha256(), prepared.afterSha256(), receiptSha);
    assertThat(recovered.afterSha256()).isEqualTo(prepared.afterSha256());
    assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(prepared.pyprojectContent());
    assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo(prepared.lockContent());
}
```

该例只测试磁盘提交协议，示例 TOML 不承担 uv 有效项目验证；真实 uv 项目验证在 Editor 和 Task 6。恢复实例不能共享首次对象的内存，必须另覆盖 apply 尚未到达时从 PREPARED 完成、重复 recover、迟到 apply 与 recover 的串行化。

- [ ] **Step 2 — 运行并确认正确失败。** `mvn -q -f poc4/workspace-agent/pom.xml '-Dtest=PythonDependencyEditorTest,PythonDependencyTransactionTest' test`。
- [ ] **Step 3 — 实现有限 uv 执行。** helper 以 Python 标准库 `tomllib` 检查当前声明，拒绝非支持的 URL/path/workspace/index 来源，不执行项目源码。用 argv 和环境允许列表启动，不拼接 shell；只复制两个 manifest，`uv.toml`/用户启动脚本不带入 scratch。

```text
uv add --no-sync --no-build --no-sources --no-config --no-python-downloads --python /usr/local/bin/python3 --default-index https://pypi.org/simple httpx==0.28.1
uv remove --no-sync --no-build --no-sources --no-config --no-python-downloads --python /usr/local/bin/python3 --default-index https://pypi.org/simple httpx
```

以 20 秒进程预算和 64 KiB 输出上限捕获结果；错误只映射固定 code/message。scratch 的 `UV_PROJECT_ENVIRONMENT` 为该临时项目自己的 `.venv`；`--no-sync` 不安装它。Dockerfile 将 helper 复制到 root-owned `/opt/manao-python/dependency_helper.py`，通过 `/usr/local/bin/python3 -I` 执行，不从用户项目 import 管理代码。安装 Python/uv 的 image stage 与 Task 6 一致，最终镜像仍以平台指定非 root UID 运行。

- [ ] **Step 4 — 实现 journal。** prepare 响应前将目标文件、before/after 单文件与组合摘要、operationId 先 fsync 为 PREPARED；后端登记 PENDING 后 apply 才持久化预期 receipt 并进入 APPLYING。每文件 temp+fsync+rename，最终验证组合摘要并写 receipt。recover 从持久文件重建标准 receipt 并核对后端预存 hash；apply/recover 共用同一项目依赖 journal 的文件锁，不跑 uv、不删除别的 journal。失去 journal 不能通过观察瞬间的 before 状态自动解锁；无对应 PENDING 的 PREPARED 不会被自动执行。完成后可回收 staged 内容，receipt 按既有保留规则留下。
- [ ] **Step 5 — 所有定向测试及 capability HTTP 验证通过后提交。** 缺真实 Linux Python/uv 时单测不能取代工具集成证据，实际镜像验证放 Task 6/9。建议 `feat(agent): support recoverable Python dependency edits`。

## Task 4：依赖 HTTP、所有权和既有工作区 receipt 接入

**Files**
- Create: `poc4/backend/src/main/java/com/manao/poc4/workspace/PythonDependencyController.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/workspace/PythonDependencyService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceAgent.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceOperationService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspaceApiClient.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/WorkspaceConfig.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/api/ApiError.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceJdbcStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/persistence/WorkspaceOperationRepository.java`
- Create: `poc4/backend/src/main/resources/db/migration/V10__python_dependency_operation_kind.sql`
- Create: `poc4/backend/src/test/java/com/manao/poc4/workspace/PythonDependencyHttpContractTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/workspace/PythonDependencyOperationTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/WorkspaceApiClientTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/api/ErrorSanitizationTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/persistence/FlywaySchemaTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/persistence/AtomicTransitionTest.java`

**Interfaces:** `PythonDependencyService.change(ownerId, projectId, change, expectedRevision)` 返回新 revision，`reconcile(ownerId, projectId)` 核对已有操作并返回权威 revision；`WorkspaceOperationService.changePythonDependencies(projectId, change, long expectedRevision)` 只取得一次 lifecycle lease，复用 store 的 PENDING。WorkspaceAgent 新增 prepare/apply/recover 方法。OperationRecord 新增 operationKind，旧构造委托 FILE；WorkspaceStore 新增 `commitReconciledPythonDependency(operationId, projectId, expectedRevision)`，其专用事务仅可解除同操作产生的 reconciliation 失败。

- [ ] **Step 1 — 写失败测试。** 非 owner 404、Java 项目拒绝、非法包名/选项拒绝；活动 Run 和冲突 revision 时 agent 不被调用；成功两个文件只增一次 revision。丢失 apply 响应保持 PENDING，再用同 operationId recover/receipt 完成，调用 uv 次数仍为 1。未决 paired operation 不能通过文件读取看到并被当作已保存一致状态，也不能开始 Run。

复用 WorkspaceControllerTest 已有公开 FakeStore/StubAgent 扩展 HTTP 定向测试，真实持久化另用 JdbcStoreTestSupport.create()。迁移后必须断言旧操作 kind=FILE，新 PYTHON_DEPENDENCIES 重建 service 后仍能被正确选择；未知 kind 和原地修改 kind 都失败。

```sql
ALTER TABLE workspace_operation
  ADD COLUMN operation_kind VARCHAR(32) NOT NULL DEFAULT 'FILE',
  ADD CONSTRAINT ck_workspace_operation_kind
    CHECK (operation_kind IN ('FILE', 'PYTHON_DEPENDENCIES'));
```

V10 还要仿照 V3 的 immutable trigger 方式保护该列，不能修改已生效的 V3。增量迁移在一次性 V9 schema 上执行并验证旧行，不能通过清空表回避兼容性。

- [ ] **Step 2 — 运行失败测试。** `mvn -q -f poc4/backend/pom.xml '-Dtest=PythonDependencyHttpContractTest,PythonDependencyOperationTest' test`。
- [ ] **Step 3 — 复用二阶段写入流程。** lease 内完成 revision/Run/pending 检查 → prepare → 记录固定组合 digest 与 receipt → apply → receipt 校验 → commit revision。lease 必须位于同一处，不能 service 与 operation service 嵌套获取不可重入锁。prepare 结果未落 PENDING 前没有代码副作用；已有未决操作先 reconcile。

```text
before digest + durable PREPARED pair
  -> workspace_operation PENDING
  -> agent paired apply / final receipt
  -> verify operationId, before, after, receiptSha256
  -> commit existing workspace revision once
```

按持久化 operation_kind 选择恢复流程。Python reconcile 先发专门 recover，再只读核对 receipt；journal 丢失/不确定继续锁定，不通过删除 PENDING 假装回滚。现有 commitOperation 拒绝 FAILED 项目，因此专用 commitReconciledPythonDependency 必须在同一事务锁 project/op 两行，核对 owner scope、kind、PENDING、revision、无活动 Run、失败原因恰为 WORKSPACE_RECONCILIATION_REQUIRED，再同时提交操作、增加 revision、恢复 READY。任何条件不符整个事务回滚；不得先独立调用 markProjectReady 再赌 commit 成功。常规单文件流程保持原行为。

新错误 code 在 ApiError 使用固定 allowlist；URL、stdout、stderr、Secret 不进入浏览器异常。两个 manifest 的读取也须取得同一项目 lease 并检查 PENDING，避免读取请求与 paired apply 交错；其他既有文件协议不重写。面板 reconcile 成功后获取权威 revision，两文件重载完成才恢复写入。既有 WORKSPACE_RECONCILIATION_REQUIRED 是项目 failureReason，不能假设所有异常响应已有同名 code；UI 通过项目权威状态决定恢复入口。

- [ ] **Step 4 — 运行上述测试、WorkspaceApiClientTest、ErrorSanitizationTest、FlywaySchemaTest、AtomicTransitionTest 及既有工作区并发/恢复测试。** 必测原 FAILED+reconciliation 可恢复、其他 FAILED/DELETING 不可恢复、提交中间失败全部回滚。只扩大到受影响模块；不修改旧单文件 receipt 格式。
- [ ] **Step 5 — 差异核对并提交。** 建议 `feat(workspace): expose uv dependency edits with durable receipts`。

## Task 5：公共服务监督器增加固定 Python profile

**Files**
- Modify: `poc4/maven-runner/runtime/src/com/manao/runtime/WebRunSupervisor.java`
- Create: `poc4/maven-runner/runtime/src/com/manao/runtime/RunProfile.java`
- Modify: `poc4/maven-runner/runtime/test/com/manao/runtime/RuntimeFixtureMain.java`
- Create: `poc4/maven-runner/runtime/test/com/manao/runtime/RunProfileTestMain.java`
- Modify: `poc4/maven-runner/manao-run-supervisor`
- Modify: `poc4/maven-runner/tests/runtime-lifecycle.sh`

**Interfaces:** `RunProfile.fromId(String)` 只接受 `java-spring-boot-web` 与 `python-fastapi-web`，返回 `command()` 与 `readinessPath()`。监督器 main 接受 `run|probe [profile]`，省略 profile 保持 Java。原 claim/receipt/deadline 继续共用。

- [ ] **Step 1 — 失败测试覆盖 profile 分派和真实探针。** Java 路径保持 actuator，Python 路径 `/health/ready`；未知或多余参数拒绝；run 和 probe 必须使用同一 profile，不能只有主启动改成 Python。

```java
assert RunProfile.fromId("python-fastapi-web").command()
    .equals(List.of("/usr/local/bin/manao-python", "web"));
assert RunProfile.fromId("python-fastapi-web").readinessPath().equals("/health/ready");
assert RunProfile.fromId("java-spring-boot-web").readinessPath()
    .equals("/actuator/health/readiness");
```

- [ ] **Step 2 — 在 Linux runner-test 构建中运行 assertions（必须 `java -ea`），确认缺失 profile 支持失败。** 现有 runtime-test stage 已编译测试类；不能只运行编译后声称行为通过。
- [ ] **Step 3 — 以私有 profile 参数替换固定 command/readinessPath。** `runMode` 与 `probe` 接受同一 RunProfile；测试入口允许 fixture command，但生产不接受环境变量/argv 传入任意命令。共享 RunDeadline 不另造计时器。
- [ ] **Step 4 — 用现有 Linux 容器测试运行 Java 全部寿命场景。** 保留忽略 TERM、重复 claim、receipt 失败等断言；Python 真实进程测试在 Task 6。

```powershell
$javaSeed = Join-Path (Get-Location) 'poc4/backend/target/maven-seed-templates'
mvn -q -f poc4/backend/pom.xml -DskipTests test-compile org.codehaus.mojo:exec-maven-plugin:3.5.0:java '-Dexec.mainClass=com.manao.poc4.workspace.MavenSeedTemplateExporter' '-Dexec.classpathScope=test' "-Dmanao.seed.output=$javaSeed"
docker build --build-context "seed-templates=$javaSeed" --target runtime-test -t manao-java-runtime-test poc4/maven-runner
docker run --rm manao-java-runtime-test java -ea -cp /opt/manao-runner/classes:/opt/manao-runner/test-classes com.manao.runtime.RunProfileTestMain
bash poc4/maven-runner/tests/runtime-lifecycle.sh manao-java-runtime-test
```
- [ ] **Step 5 — 差异核对并提交。** 建议 `refactor(runner): select fixed service profiles in shared supervisor`。

## Task 6：Python 镜像、固定 launcher、缓存 seed 与真实进程测试

**Files**
- Create: `poc4/python-runner/Dockerfile`
- Create: `poc4/python-runner/manao-python`
- Create: `poc4/python-runner/prepare-python-seed.sh`
- Create: `poc4/python-runner/tests/runtime-lifecycle.sh`
- Create: `poc4/python-runner/tests/python-cache.sh`
- Create: `poc4/python-runner/tests/dependency-editor.sh`
- Create: `poc4/python-runner/tests/fixtures/child_process.py`
- Create: `poc4/python-runner/README.md`
- Modify: `.gitattributes`

**Interfaces:** `/usr/local/bin/manao-python console|web`；只接收两个 mode。cache 挂载 `/python-cache`；venv `/tmp/manao-python/.venv`；`MANAO_PYTHON_MYSQL`、`MANAO_PYTHON_REDIS` 是服务端布尔值，用于固定 `--extra` 参数，不是任意参数数组。监督器继续使用现有 `MANAO_*` 身份/时限变量。

- [ ] **Step 1 — 先写黑盒容器测试。** 空项目 cache 禁网启动默认模板；暖 cache 用第二个新 Pod/venv；增加 httpx 后确实可 import，第二次禁网复用；移除后新的 venv 不能 import。修改 pyproject 不更新 lock 必须失败且不能启动应用。两个项目 cache 不能互见，缺目录可补齐，seed 中断不留下完成标记。
- [ ] **Step 2 — 验证失败是镜像/launcher 未交付，然后构建最小实现。** 从仓库根构建，Dockerfile 明确 COPY 同一份 `poc4/maven-runner/runtime/src` 与启动器、真实模板命名 context，不复制监督器源码到新目录。

```powershell
$pythonSeed = Join-Path (Get-Location) 'poc4/backend/target/python-seed-templates'
mvn -q -f poc4/backend/pom.xml -DskipTests test-compile org.codehaus.mojo:exec-maven-plugin:3.5.0:java '-Dexec.mainClass=com.manao.poc4.workspace.PythonSeedTemplateExporter' '-Dexec.classpathScope=test' "-Dmanao.seed.output=$pythonSeed"
docker build -f poc4/python-runner/Dockerfile --build-context "seed-templates=$pythonSeed" --target runtime-test -t manao-python-runtime-test .
```

Dockerfile 的 `runtime-test` 及 production 使用同一 Python/uv/JRE 分发和 seed。Task 2 已记录 uv 版本；本机本轮核实有 uv `0.11.6`，可用作候选，实施仍需核对 Linux 分发和所需 flags 后固定版本。基础 Python 使用实际可拉取的 3.13 补丁 tag 再解析 digest，写入构建记录及最终 Dockerfile；部署禁止未解析值。

- [ ] **Step 3 — launcher 设置明确环境并安装固定锁。** shell 入口 `set -euo pipefail`；只向未存在的版本化 cache 目录整体 seed，使用临时同卷目录与 rename，完成标记最后写。存在目录绝不用 copy 覆盖活跃缓存。

```bash
export UV_PROJECT_ENVIRONMENT=/tmp/manao-python/.venv
export UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
export PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
# UV_CACHE_DIR 由镜像中固定 uv/Python/平台兼容键决定，落在 /python-cache 内。
extras=()
if [[ "${MANAO_PYTHON_MYSQL:-false}" == true ]]; then extras+=(--extra mysql); fi
if [[ "${MANAO_PYTHON_REDIS:-false}" == true ]]; then extras+=(--extra redis); fi
uv sync --locked --no-dev --no-build --no-config --python /usr/local/bin/python3 "${extras[@]}"
case "${1:-}" in
  console) exec /tmp/manao-python/.venv/bin/python -u main.py ;;
  web) exec /tmp/manao-python/.venv/bin/python -u -m uvicorn app.main:app \
    --host 0.0.0.0 --port "$MANAO_PRIMARY_PORT" ;;
  *) exit 2 ;;
esac
```

脚本实际分支必须处理 install 失败并立即非零退出。公开 Web 的包准备在 supervisor claim 后执行，不能移到 claim 前。依赖解析/同步阶段日志与应用日志进入同一 stdout/stderr 管道，不打印环境和凭据。

- [ ] **Step 4 — 真实生命周期与工具集成验证。**

```powershell
bash poc4/python-runner/tests/runtime-lifecycle.sh manao-python-runtime-test
bash poc4/python-runner/tests/python-cache.sh manao-python-runtime-test
# 参数为本任务构建的 workspace-agent 测试镜像，脚本在隔离容器中验证 uv 与 helper：
docker build -t manao-python-workspace-agent-test poc4/workspace-agent
bash poc4/python-runner/tests/dependency-editor.sh manao-python-workspace-agent-test
```

生命周期脚本覆盖：TASK exit 0/1、无缓冲中文日志、SERVICE readiness 后短时计时、readiness 503、安装阻塞启动超时、长请求跨 deadline、派生进程忽略 TERM、重复 claim、receipt 写失败、80 低端口。必须通过容器 exit/进程与 receipt 实际核对，不能只匹配成功日志。

agent 集成用例至少一次真实 `uv add --no-sync` 和 `uv remove --no-sync`，检查源文件未在 prepare 时改动、两文件提交和锁一致性、20 秒进程终止。PyPI 不可达时如实报告，不以进程 mock 顶替。

- [ ] **Step 5 — 记录解释器/uv/seed 身份，清理自有容器和卷，检查新脚本 LF 并提交。** 建议 `feat(runner): add isolated Python execution and seeded uv cache`。

## Task 7：Run、Job、镜像配置与日志/清理兼容接入

**Files**
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobResourceFactory.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/Fabric8JobCoordinator.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/WorkspaceConfig.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/Fabric8ProjectDependencies.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/JobResourceFactoryTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/Fabric8JobCoordinatorTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/run/RunControllerTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/run/RunRecoveryServiceTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectDependenciesTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/ProjectResourceCleanerTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/config/ConfigurationTest.java`

**Interfaces:** factory 新增统一 `createJob(RunRecord run, String projectId, int primaryPort, List<EnvVar> env)`，内部选择既有 TASK/SERVICE 构建逻辑；constructor 新增已验证 Python image。coordinator 对外接口不变，按 Run 快照派发。RunService 使用 `policy.forProject(spec)`。

- [ ] **Step 1 — 写失败测试。** Python TASK/SERVICE 使用 Python image 和 cache，无 Maven 挂载；Java 仍使用原 image/cache。primaryPort/extras/env 来源正确；历史 component/container/SA 标识一致。依赖失败或配置缺失不能启动用户程序。

```java
var job = factory.createJob(pythonServiceRun, projectId, 8000, environment);
var container = job.getSpec().getTemplate().getSpec().getContainers().get(0);
assertThat(container.getImage()).isEqualTo(pythonImageDigest);
assertThat(container.getCommand()).containsExactly(
    "/usr/local/bin/manao-run-supervisor", "run", "python-fastapi-web");
assertThat(container.getReadinessProbe().getExec().getCommand()).containsExactly(
    "/usr/local/bin/manao-run-supervisor", "probe", "python-fastapi-web");
```

- [ ] **Step 2 — 确认定向失败。** `mvn -q -f poc4/backend/pom.xml '-Dtest=JobResourceFactoryTest,Fabric8JobCoordinatorTest,RunControllerTest' test`。
- [ ] **Step 3 — 最小接入。** 从 policy.template 选择 image、cache path 和 profile；共用资源限制/security/labels 构建。Python Run 的 init container 仅 mkdir/chown 自己的 `.manao-cache/python`，不重新写模板、不清理已有缓存、不扩大 workspace recovery 删除范围。

`MANAO_PYTHON_RUNNER_IMAGE` 经 `WorkspaceResourceFactory.requireDigest` 校验；部署先提供新配置再启新后端。Java 原 image 仍独立配置；不能用 Python 镜像替换原 Maven 配置。为 Python 注入固定布尔 extras，数据库密码仍 `secretKeyRef`。

- [ ] **Step 4 — 扩展已有恢复、日志、端点和清理测试为 Java/Python 两种快照。** 同 Pod UID/Run 身份校验，RUNNING 恢复不重建 Run，终态才解锁；缓存随 workspace PVC 回收。运行本任务文件中的定向测试及 `RunLogIngestorTest,ResourceIdentityVerifierTest,PublicEndpointGatewayTest`。
- [ ] **Step 5 — 通过后提交。** 建议 `feat(runtime): route Python runs through existing job lifecycle`。

## Task 8：模板、依赖表单和运行展示的浏览器闭环

**Files**
- Modify: `poc4/frontend/src/contracts/project.ts`
- Modify: `poc4/frontend/src/contracts/run.ts`
- Modify: `poc4/frontend/src/contracts/run.test.ts`
- Modify: `poc4/frontend/src/features/projects/CreateProjectForm.tsx`
- Modify: `poc4/frontend/src/features/projects/CreateProjectForm.test.tsx`
- Modify: `poc4/frontend/src/features/projects/ProjectCard.tsx`
- Modify: `poc4/frontend/src/features/projects/ProjectCard.test.tsx`
- Create: `poc4/frontend/src/api/pythonDependencyApi.ts`
- Create: `poc4/frontend/src/features/dependencies/PythonDependenciesPanel.tsx`
- Create: `poc4/frontend/src/features/dependencies/PythonDependenciesPanel.test.tsx`
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.tsx`
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.test.tsx`
- Modify: `poc4/frontend/src/components/runs/RunPanel.tsx`
- Modify: `poc4/frontend/src/components/runs/RunPanel.test.tsx`
- Modify: `poc4/frontend/src/components/runs/RunToolbar.tsx`
- Modify: `poc4/frontend/src/components/runs/StopRunDialog.tsx`
- Modify: `poc4/frontend/src/components/terminal/CloseTerminalDialog.tsx`
- Modify: `poc4/frontend/src/mocks/handlers.ts`
- Modify: `poc4/frontend/src/mocks/runFixtures.ts`

**Interfaces:** 新模板 ID 与 1.1 RunPolicy wire 对齐；新增 API 仅发送 1.2 DTO，禁止自动重试；UI 复用 dirty guard、RunAuthorityCoordinator 与 workspace reload。依赖面板只在 Python 项目显示，包名/可选版本两个输入、添加/删除按钮即可。

- [ ] **Step 1 — 失败用例以实际交互为准。** 选 FastAPI 显示 MySQL/Redis，默认 target=8000、public 为空；改回 console 隐藏配置不泄露到请求。新增依赖响应后两文件及 revision 刷新；未保存、活动 Run、提交中不可操作；断网不自动发第二请求。Run parser 接受 Python、拒绝未知/混搭策略，旧 Java fixture 继续通过。

```tsx
await user.selectOptions(screen.getByLabelText('Template'), 'python-fastapi-web');
await user.click(screen.getByRole('checkbox', { name: /public/i }));
expect(screen.getByLabelText(/container port/i)).toHaveValue('8000');
expect(screen.getByLabelText(/public port/i)).toHaveValue('');
```

标签应以现有可访问名称为准；不得为了示例改成不可访问的自定义 div。依赖面板测试拦截真实 DTO 并模拟 apply 响应不明，核对不会自动重试。

- [ ] **Step 2 — 运行红测。**

```powershell
pnpm -C poc4/frontend test -- src/contracts/run.test.ts src/features/projects/CreateProjectForm.test.tsx src/features/dependencies/PythonDependenciesPanel.test.tsx
```

- [ ] **Step 3 — 实现 union、表单和 authority 整合。** Java/Python runtime 为判别联合；legacy parser 分支仅处理无语言的旧 Java，不能宽松接受任意 command。RunPanel 向 Toolbar 提供无 Run 时的当前模板展示；有历史 Run 时以该 Run 策略为准。停止文案使用 Run，不固定 Maven。

依赖 mutation 开始前采用现有 editor authority 阻止并发写入和 Run；后端 PENDING 是最终权威。成功只在 manifest 重载完成后解锁；结果不明显示新增“核对依赖操作”按钮，调用专用 reconcile endpoint，不把按钮立即恢复为可以重发。项目卡和 MSW 同步，Mock 不算真实 Python PASS。

- [ ] **Step 4 — 跑受影响 UI 测试、typecheck/build 和边界检查。**

```powershell
pnpm -C poc4/frontend test -- src/contracts/run.test.ts src/features/projects/CreateProjectForm.test.tsx src/features/projects/ProjectCard.test.tsx src/features/dependencies/PythonDependenciesPanel.test.tsx src/components/shell/WorkbenchShell.test.tsx src/components/runs/RunPanel.test.tsx
pnpm -C poc4/frontend build
pnpm -C poc4/frontend test:boundary
```

- [ ] **Step 5 — 检查 Java 创建/历史文案回归并提交。** 建议 `feat(frontend): add Python projects and uv dependency controls`。

## Task 9：发布准备、实际工具版本及独立 E2E 入口

**Files**
- Modify: `poc4/deploy/6b/backend.yaml`
- Modify: `poc4/deploy/6b/README.md`
- Modify: `poc4/frontend/package.json`
- Create: `poc4/frontend/playwright.python-runtime.config.ts`
- Create: `poc4/frontend/tests/e2e/python-runtime-lifecycle.spec.ts`
- Create: `poc4/docs/evidence/python-runtime/acceptance.md`
- Modify: `poc4/python-runner/README.md`
- Modify: `AGENTS.md`
- Modify: `docs/what-we-have-done.md`

**Interfaces:** 运行配置新增 `MANAO_PYTHON_RUNNER_IMAGE`，按原 image Secret 注入模式交付；README 记录与之配套的 workspace-agent/backend/frontend/Java runner digest、Python/uv 版本及 seed ID。不把真实 Secret 明文写进版本库。

- [ ] **Step 1 — 创建独立真实云端测试 config。** 参考既有 Java config，但只收集 Python spec；`workers=1,retries=0,webServer=undefined`，不启动本地服务。沿用 `MANAO_RUNTIME_BASE_URL/USERNAME/PASSWORD/PUBLIC_PORT_1/PUBLIC_PORT_2`。缺值显式失败，不自动选端口，不输出密码。
- [ ] **Step 2 — 在 spec 写入 Task 10 的真实断言。** 先通过 `--list` 检查收集；这只证明入口可加载。将脚本名 `test:e2e:python-runtime` 加到 package.json。

```json
"test:e2e:python-runtime": "playwright test --config playwright.python-runtime.config.ts"
```

- [ ] **Step 3 — 构建并记录可交付版本。** 以执行 commit、镜像 ID/digest、模板 lock hash、seed ID 和工具实际 `--version` 为一组。修过源码就重新构建相应镜像并更新记录。agent 和 runner 的 uv/Python 验证版本一致；Java runtime-test 的 profile 变化也需对应新 Maven image。
- [ ] **Step 4 — 写出可核对的发布动作及回滚边界。** 沿用 deployment README 的目标 context/namespace、镜像 Secret、apply/rollout 命令。短维护窗内补新 digest 配置、发布兼容前端与 agent/backend，完成健康核对再开放创建。新 Python 项目应使用新 agent 镜像；既有 Java workspace 不强制重建。
- [ ] **Step 5 — 发布授权到位后执行该清单并留证；若任务只授权本地开发，则交付完整镜像/差异/部署清单等待发布决定。** 不以计划本文视为当前发布授权。验收文件初始只能写真实已做检查及其局限；不能直接标阶段 PASS。
- [ ] **Step 6 — 聚焦提交。** 建议 `chore(deploy): prepare Python runtime release and cloud acceptance`。

## Task 10：集中云端验收、Java 回归和收尾

**Files**
- Modify: `poc4/frontend/tests/e2e/python-runtime-lifecycle.spec.ts`
- Modify: `poc4/docs/evidence/python-runtime/acceptance.md`
- Modify: `poc4/deploy/6b/README.md`
- Modify: `AGENTS.md`
- Modify: `docs/Manao-Projects-goal.md`
- Modify: `docs/what-we-have-done.md`

**Interfaces:** 仅使用真实已部署公网浏览器入口及项目/Run API 驱动产品行为；资源和数据库查询负责独立核实结果，不替用户从集群直接改文件来伪造 UI 能力。

- [ ] **Step 1 — 实时前检和样本清单。** 确认目标 context、`manao-stage6b`、节点/容量、RBAC、存储、所有镜像 digest。新建唯一前缀且 owner 明确的 Python console、Python web 和必要的 Java 回归项目；记录项目/Run ID、端口、预期资源。不得复用或清理历史 DELETING 项目。
- [ ] **Step 2 — 普通 Python 与依赖闭环。** 浏览器创建、执行欢迎程序和中文日志；修改成异常并看见 FAILED/traceback，再修复成功；依赖面板添加 httpx，编辑源码 import 后成功；重复 Run 验证缓存；移除 httpx 后 import 应失败；改回基础程序成功。确保两文件及 revision 持久化，刷新/重新登录可见。
- [ ] **Step 3 — FastAPI 公网和数据闭环。** 用户预指定端口创建 Web + MySQL + Redis，真实 HTTP `/api/demo` 成功。测试通过浏览器编辑 `app/main.py` 加入最小读写用例，写入项目 MySQL/Redis 样本，停止、编辑响应、再次运行，MySQL 样本仍在；端口冲突保持原值且无第二项目。没有公网配置的路径由 Task 6 容器证据覆盖，除出现新疑点不再重复整套云端场景。
- [ ] **Step 4 — 验证恢复和 Python 时限。** 本次共享后端/监督器改动要求一次受控后端重启后恢复观察既有 Python Run，firstReadyAt/expiresAt 不变，历史日志可读。正式 7200 秒用例从首次 ready 计时，deadline 前后记录 receipt、Run 状态与容器实际终止，不能仅以公网断连当终止；长等待分段观察且可响应用户，不阻塞单次工具调用两小时。
- [ ] **Step 5 — Java 定向回归。** 既有旧策略历史可读；Java console 和 Spring Boot 至少各一次新 Run，真实输出/HTTP/停止正常。需要自有 disposable Java 项目时记录并同样清理，不删除用户已有项目。
- [ ] **Step 6 — 独立核对清理。** UI 删除本轮项目，最终 API 404；核实 owner/project 范围内的 DB 行、Job/initializer/workspace/依赖控制器/Pod/Service/Secret、workspace/MySQL PVC、对应 PV 和存储目录；Python cache 与 workspace 同步消失。Forbidden、Unknown 或 timeout 记失败/未核实，不能当清理完成。

```powershell
pnpm -C poc4/frontend test:e2e:python-runtime
git diff --check
git status --short --branch
```

只在已完成必要环境/授权前提后运行 E2E；不将上面的命令自动解释为本次规划会执行。

- [ ] **Step 7 — 记录实测结论。** acceptance 每项写 PASS/FAILED/SKIPPED/WAIVED_BY_USER/NOT_REVERIFIED、执行 commit、镜像、项目/Run 身份、实际回收数量及保留原因。冷镜像与暖镜像、首次包下载与缓存重用分开计时；没有用户确认的性能阈值，不写秒级承诺。
- [ ] **Step 8 — 索引更新和提交。** 仅在新证据支持时更新 Python 交付状态；不改历史 Java/6A/6B 结论。清理本轮不再需要的临时文件、构建导出目录和精确测试资源，保留必要脱敏报告。建议 `docs(runtime): record Python acceptance and delivery boundary`。

## 2. 执行顺序和覆盖核对

严格顺序 `Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10`。这些任务会交叠修改 workspace、runtime 和配置文件，本计划不安排并行实现。

| 用户结果 / 风险 | 实现任务 | 必须保留的证据 |
| --- | --- | --- |
| 旧 Java 继续工作，Python policy 不伪装 Java | 1、7、8 | 旧 JSON fixture、真实 store、浏览器 parser、Task 10 Java 回归 |
| Python / FastAPI 创建即有可运行模板 | 2、6、7、8 | 真实模板 lock、容器启动、浏览器创建/运行 |
| 浏览器 uv 增删依赖，无终端依赖 | 3、4、8 | 实际 uv add/remove、成对文件内容与 revision、真实浏览器 import |
| 双文件中断可核对，不重复执行 | 3、4 | 持久化 journal 重建测试、DB PENDING 恢复、同 operationId/摘要 |
| 缓存提速且不会残留移除的包 | 6、7 | 冷/暖缓存禁网安装、每 Run 新 venv、隔离和回收 |
| 就绪后两小时，不自动重启 | 5、6、7、10 | 短时真实进程证明 + 独立正式 7200 秒结果 |
| 端口冲突和项目数据沿用原契约 | 2、7、8、10 | 真实 HTTP、手填值保留、MySQL 持久化 |
| 完整项目删除，历史诊断不误删 | 7、10 | 资源/DB/PVC/PV/实际存储核对 |

所有产品选择已记录；实现中的版本解析、镜像拉取和集群前检是执行步骤，不是已完成证据。若出现会改变上述产品行为的真实限制，先给出具体受影响结果和可审查修改，再向用户确认；不要反复询问已确定的端口、寿命、手动重跑或 uv 入口。
