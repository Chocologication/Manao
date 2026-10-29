# Python Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 顺序执行，不自动派生子代理；实施开始前重新读取本检出的 AGENTS.md。

**Goal:** 在已交付 Java 运行环境上增加 Python 普通程序、FastAPI Web 服务及最小 uv 依赖增删入口，完成浏览器编辑、执行、反馈、再次修改和项目回收闭环。

**Architecture:** 复用项目配置、工作区 receipt、Run/Job、日志、端口、依赖和清理模块。固定模板决定语言差异；Python 使用独立运行镜像、项目私有 uv 下载缓存和每 Run 隔离 venv，服务运行复用现有监督器。依赖增删采用临时解析及可恢复的双文件提交，不引入通用插件或后台任务平台。

**Tech Stack:** 既有 Java 17/Spring Boot/Fabric8/MySQL 后端与 workspace-agent；React/TypeScript/pnpm 前端；Python 3.13、uv、FastAPI、Uvicorn；Kubernetes Job + Service + PVC；JUnit、Vitest、真实 Linux 容器及 Playwright。

**Spec:** [Python Runtime Design](../specs/2026-09-25-python-runtime-design.md)。

**Status:** 2026-09-25 自审修订版 r2，用户同意按审查结果修改；Task 1–11 均未执行。已确认普通 Python + FastAPI、最小 uv add/remove 入口。本次只修订文档；其他 agent 收到实施交接后再开始执行。

**Base:** `06e8133820867cc9d200ab63913d1a282d2dedf6`，已包含 `ef1b5bb`。工作树 `.worktree/python-runtime`，分支 `codex/python-runtime`。所有 Files 路径相对于实施检出。

## Global Constraints

- 本轮功能范围仅 Python；Java 继续可用，Go、TypeScript、AI 分开规划；不重新执行已完成的 Java Tasks 1–9 或历史 6A/6B gate。
- Python 固定为 3.13 系列；Python 补丁版、uv 精确版本及基础镜像 digest 通过 Task 2/4 的构建记录固定；agent 与 runner 的 Python/uv 必须一致。版本值必须来自实际分发物，不能填写假 digest。
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
| 固定模板与策略 | 模板 → 语言、执行类型、命令；旧 JSON 兼容 | 1 |
| Python 模板 | 真实资源、uv lock、文件元数据 | 2 |
| 公共监督器 | 固定 profile，共享寿命与 receipt 实现 | 3 |
| Python runner | 固定入口、私有 cache、每 Run venv | 4 |
| Run/Job 接入 | 镜像、挂载、日志、端口与清理身份 | 5 |
| 运行浏览器闭环 | 创建、编辑、反馈、停止、再次运行、删除 | 6 |
| agent 依赖编辑 | scratch 解析、摘要响应、引用提交，commit 可重复核对 | 7 |
| 后端依赖操作 | 操作 ID、请求摘要、工作区锁/receipt/一次 revision | 8 |
| 依赖浏览器闭环 | 添加/删除、刷新后查询、失败页恢复入口 | 9 |
| 发布准备 | 配套镜像/迁移、独立 E2E 与回滚说明 | 10 |
| 集中验收 | Python 云端闭环、Java 回归、数据回收 | 11 |

增量 A 为 Task 1–6；增量 B 为 Task 7–9。先让运行路径可验证，再增加依赖管理。Task 10–11 集中发布和云端验收，不给每个开发任务新增一轮部署。

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

以上为 Interface 清单，不是可直接编译的 enum 文件。RunPolicy 的公开方法统一为 `forProject(ProjectRuntimeSpec spec)`、`template()`、`isService()`、`toJson()`、`fromJson(String)`；嵌套 `RuntimeInfo` 负责两种语言的 JSON，避免 Python 使用假 javaMajor 值。旧记录的 JSON 解析必须兼容；内部构造函数及 forService() 根据真实调用方统一调整，不仅为少改测试永久保留两套构造路径。跨任务仍有生产调用时可暂留委托；Task 5 完成调用迁移后删除不再需要的入口，并同步测试。fromProperties 仍提供 Java 默认资源与时限。

FastAPI 展示命令使用 `python -u -m uvicorn app.main:app`；实际 host/port 由固定 launcher 的验证后参数补齐。新 Java SERVICE 展示 `mvn -q -DskipTests spring-boot:run`；历史无 templateId 的旧 SERVICE console 命令按设计第 5 节兼容。

### 1.2 依赖操作约定

浏览器首次提交前生成 operationId（UUID），保留于用户/项目作用域。POST 请求含 `operationId, action, packageName, version, expectedWorkspaceRevision`；包名规范化为小写并将连续 `[-_.]` 折叠为 `-`。action 仅 ADD/REMOVE；包名首尾字母或数字、长度 1–128；version 可空，非空仅允许精确版本，REMOVE 必须为空。只处理当前两个固定文件，不发展任意批事务框架。

`requestSha256` 是固定字段顺序 JSON（protocol=1、projectId、action、规范化 packageName、version、expectedRevision）的 SHA-256；同 ID 不同请求返回 409 DEPENDENCY_REQUEST_MISMATCH。ID 在 DB、agent journal、浏览器回执与状态查询中相同，不能在 prepare 内换成另一个 UUID。

浏览器接口：

```text
POST /api/v1/projects/{projectId}/python-dependencies
GET  /api/v1/projects/{projectId}/python-dependencies/{operationId}
POST /api/v1/projects/{projectId}/python-dependencies/{operationId}/reconcile
GET  /api/v1/projects/{projectId}/python-dependencies/pending
```

状态响应为 `{operationId, state, resultWorkspaceRevision}`，state 为 PENDING/COMMITTED/UNCONFIRMED；未决列表仅返回该 owner/project 的唯一 Python 依赖操作摘要。无记录仅 UNCONFIRMED，不以此自动重发。COMMITTED 包含该操作的 expectedRevision+1；重载文件时仍读取当前权威 revision。reconcile 只依据指定操作的已登记结果推进，不运行 uv；COMMITTED 直接返回。

agent 只公开 `POST /agent/v1/python-dependencies/prepare` 和 `/commit`。共用以下 wire 记录，正文只留 agent 的 journal：

```java
record DependencyChange(String action, String packageName, String version) {}
record PreparedPythonDependencies(String operationId, String requestSha256,
    String beforeSha256, String afterSha256) {}
record PythonDependencyCommit(PreparedPythonDependencies prepared,
    String receiptJson, String receiptSha256) {}
```

prepare 接收 operationId、requestSha256、DependencyChange；commit 用摘要引用已准备内容，首次提交和中断后核对共用同一方法。普通 receipt GET 保持只读。数据库仍用 workspace_operation；V10 添加 operation_kind 与 request_sha256，COMMITTED 行必须可查询到项目删除。

固定错误：VALIDATION_ERROR；PYTHON_DEPENDENCY_UNSUPPORTED；PYTHON_DEPENDENCY_RESOLUTION_FAILED；PYTHON_DEPENDENCY_TIMEOUT；DEPENDENCY_REQUEST_MISMATCH。只有已证明未改源文件的解析/校验错误可当作无副作用失败。提交结果不明的原语义继续为项目失败原因 WORKSPACE_RECONCILIATION_REQUIRED，不直接回显 uv stderr。

20 秒解析、64 KiB 工具输出上限是初始工程配置，不是用户指定或已实测指标。解析预算可配置，prepare 的单次请求超时随预算加有界 I/O/传输余量；不要把所有工作区请求超时全局提高。公共 PyPI wheel、主依赖、可选精确版本是首版明确支持边界；不因该边界扩展出包管理平台。

## Task 1：固定模板、Run 快照及旧 Java 兼容

**Files**
- Create: `poc4/backend/src/main/java/com/manao/poc4/project/RuntimeTemplate.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectRuntimeSpec.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunPolicy.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectRuntimeSpecTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectRuntimeStoreTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/run/RunPolicyTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/run/RunControllerTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectDependenciesTest.java`

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

- [ ] **Step 4 — 导出并执行真实模板验证。** 测试模板 `uv sync --locked`，console 正常退出，Web `/api/demo` 为 200；MySQL/Redis 选中却未提供服务时 readiness 为 503，未选中不连接。Task 4 只补最终镜像的启动/导入检查，共同模板逻辑不重复维护一套测试。agent：`mvn -q -f poc4/workspace-agent/pom.xml '-Dtest=WorkspaceFileServiceTest' test`。
- [ ] **Step 5 — 清理自有临时 venv/export，保留模板及 lock，差异检查并提交。** 建议 `feat(workspace): add uv-managed Python templates`。

## Task 3：公共服务监督器增加固定 Python profile

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
- [ ] **Step 4 — 用现有 Linux 容器测试运行 Java 全部寿命场景。** 保留忽略 TERM、重复 claim、receipt 失败等断言；Python 真实进程测试在 Task 4。

```powershell
$javaSeed = Join-Path (Get-Location) 'poc4/backend/target/maven-seed-templates'
mvn -q -f poc4/backend/pom.xml -DskipTests test-compile org.codehaus.mojo:exec-maven-plugin:3.5.0:java '-Dexec.mainClass=com.manao.poc4.workspace.MavenSeedTemplateExporter' '-Dexec.classpathScope=test' "-Dmanao.seed.output=$javaSeed"
docker build --build-context "seed-templates=$javaSeed" --target runtime-test -t manao-java-runtime-test poc4/maven-runner
docker run --rm manao-java-runtime-test java -ea -cp /opt/manao-runner/classes:/opt/manao-runner/test-classes com.manao.runtime.RunProfileTestMain
bash poc4/maven-runner/tests/runtime-lifecycle.sh manao-java-runtime-test
```
- [ ] **Step 5 — 差异核对并提交。** 建议 `refactor(runner): select fixed service profiles in shared supervisor`。

## Task 4：Python 镜像、固定 launcher、缓存 seed 与真实进程测试

**Files**
- Create: `poc4/python-runner/Dockerfile`
- Create: `poc4/python-runner/manao-python`
- Create: `poc4/python-runner/prepare-python-seed.sh`
- Create: `poc4/python-runner/tests/runtime-lifecycle.sh`
- Create: `poc4/python-runner/tests/python-cache.sh`
- Create: `poc4/python-runner/tests/fixtures/child_process.py`
- Create: `poc4/python-runner/README.md`
- Modify: `.gitattributes`

**Interfaces:** `/usr/local/bin/manao-python console|web`；只接收两个 mode。cache 挂载 `/python-cache`；venv `/tmp/manao-python/.venv`；`MANAO_PYTHON_MYSQL`、`MANAO_PYTHON_REDIS` 是服务端布尔值，用于固定 `--extra` 参数，不是任意参数数组。监督器继续使用现有 `MANAO_*` 身份/时限变量。

- [ ] **Step 1 — 先写黑盒容器测试。** 空项目 cache 禁网启动默认模板；暖 cache 用第二个新 Pod/venv；通过 uv add/remove 预生成的测试 manifest 验证包下载/复用及移除后新 venv 不残留；真实浏览器增删在 Task 9/11 验证。修改 pyproject 不更新 lock 必须失败且不能启动应用。两个项目 cache 不能互见，缺目录可补齐，seed 中断不留下完成标记。
- [ ] **Step 2 — 验证失败是镜像/launcher 未交付，然后构建最小实现。** 从仓库根构建，Dockerfile 明确 COPY 同一份 `poc4/maven-runner/runtime/src` 与启动器、真实模板命名 context，不复制监督器源码到新目录。

```powershell
$pythonSeed = Join-Path (Get-Location) 'poc4/backend/target/python-seed-templates'
mvn -q -f poc4/backend/pom.xml -DskipTests test-compile org.codehaus.mojo:exec-maven-plugin:3.5.0:java '-Dexec.mainClass=com.manao.poc4.workspace.PythonSeedTemplateExporter' '-Dexec.classpathScope=test' "-Dmanao.seed.output=$pythonSeed"
docker build -f poc4/python-runner/Dockerfile --build-context "seed-templates=$pythonSeed" --target runtime-test -t manao-python-runtime-test .
```

Dockerfile 的 `runtime-test` 及 production 使用同一 Python/uv/JRE 分发和 seed。Task 2 已记录 uv 版本；初版规划记录了本机 uv `0.11.6`，可用作候选，实施仍需核对 Linux 分发和所需 flags 后固定版本。基础 Python 使用实际可拉取的 3.13 补丁 tag 再解析 digest，写入构建记录及最终 Dockerfile；部署禁止未解析值。

- [ ] **Step 3 — launcher 设置明确环境并安装固定锁。** shell 入口 `set -euo pipefail`；仅对当前固定工具链与平台维护一个 seed；只向未存在的私有 cache 目录整体 seed，使用临时同卷目录与 rename，完成标记最后写。存在目录绝不用 copy 覆盖活跃缓存。

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
```

Python 脚本只覆盖真实 uv/Python 启动链：TASK exit 0/1、中文日志、FastAPI readiness、安装阻塞启动超时、短时到期和 TERM/强制终止 Python 派生进程、80 低端口。公共 claim、receipt 写失败、时钟和重复认领等状态机规则已在 Task 3 复用原测试验证，不复制第二份矩阵；若发现 Python profile 特有差异，再增加对应单个回归。使用实际容器状态和 receipt 核对，不只匹配日志。

不实现跨 Python/uv/平台的缓存迁移或自动回填。模板预置与冷/暖缓存检查保留，agent 的真实依赖编辑验证在 Task 7。

- [ ] **Step 5 — 记录解释器/uv/seed 身份，清理自有容器和卷，检查新脚本 LF 并提交。** 建议 `feat(runner): add isolated Python execution and seeded uv cache`。

## Task 5：Run、Job、镜像配置与日志/清理兼容接入

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

## Task 6：先完成运行路径的浏览器闭环

**Files**
- Modify: `poc4/frontend/src/contracts/project.ts`
- Modify: `poc4/frontend/src/contracts/run.ts`
- Modify: `poc4/frontend/src/contracts/run.test.ts`
- Modify: `poc4/frontend/src/features/projects/CreateProjectForm.tsx`
- Modify: `poc4/frontend/src/features/projects/CreateProjectForm.test.tsx`
- Modify: `poc4/frontend/src/features/projects/ProjectCard.tsx`
- Modify: `poc4/frontend/src/features/projects/ProjectCard.test.tsx`
- Modify: `poc4/frontend/src/components/runs/RunPanel.tsx`
- Modify: `poc4/frontend/src/components/runs/RunPanel.test.tsx`
- Modify: `poc4/frontend/src/components/runs/RunToolbar.tsx`
- Modify: `poc4/frontend/src/components/runs/StopRunDialog.tsx`
- Modify: `poc4/frontend/src/components/terminal/CloseTerminalDialog.tsx`
- Modify: `poc4/frontend/src/mocks/handlers.ts`
- Modify: `poc4/frontend/src/mocks/runFixtures.ts`
- Modify: `poc4/frontend/package.json`
- Create: `poc4/frontend/playwright.python-runtime.config.ts`
- Create: `poc4/frontend/tests/e2e/python-runtime-lifecycle.spec.ts`

**Interfaces:** 新模板及 RunPolicy union 与 Task 1 一致；现有 RunAuthorityCoordinator、保存/重载、端口反馈及删除流程继续使用。本任务不依赖尚未交付的依赖编辑 HTTP。

- [ ] **Step 1 — 先写交互红测。** FastAPI 默认 targetPort=8000、publicPort 空白；console 隐藏 Web 选项；Python policy 可解析、旧 Java 可读、混搭策略拒绝；所选历史 Run 的展示不被当前模板覆盖。

```tsx
await user.selectOptions(screen.getByLabelText('Template'), 'python-fastapi-web');
await user.click(screen.getByRole('checkbox', { name: /public/i }));
expect(screen.getByLabelText(/container port/i)).toHaveValue('8000');
expect(screen.getByLabelText(/public port/i)).toHaveValue('');
```

- [ ] **Step 2 — 运行红测。**

```powershell
pnpm -C poc4/frontend test -- src/contracts/run.test.ts src/features/projects/CreateProjectForm.test.tsx src/components/runs/RunPanel.test.tsx
```

- [ ] **Step 3 — 实现固定 union 与展示。** 沿用现有表单，只增加两个选项与按模板推导的服务能力；RunToolbar 读取实际策略，无 Run 时读取项目模板。Stop 文案采用 Run；Mock handler 同步，但 mock 不证明 Python 运行。
- [ ] **Step 4 — 创建最小 E2E 主路径并完成增量 A 核对。** 独立 config 使用真实 MANAO_RUNTIME_BASE_URL、workers=1/retries=0，不自动启动本地服务或扫描端口。先写 console 成功→编辑为失败→修复、FastAPI 公网请求→停止→再次运行、UI 删除的用例；package.json 加 test:e2e:python-runtime。具备本版本可用且已授权的隔离环境时做一次真实浏览器烟测。缺环境记录 NOT_REVERIFIED，继续独立开发 Task 7–9，不把缺环境变成新生产部署 gate；完整云端证据统一在 Task 11。
- [ ] **Step 5 — 定向 UI、类型和构建检查通过，提交增量。**

```powershell
pnpm -C poc4/frontend test -- src/contracts/run.test.ts src/features/projects/CreateProjectForm.test.tsx src/features/projects/ProjectCard.test.tsx src/components/runs/RunPanel.test.tsx
pnpm -C poc4/frontend build
pnpm -C poc4/frontend test:boundary
```

建议提交 `feat(frontend): complete Python run workflow`。通过的实现测试与未执行的云端场景分别记录；不在这里宣布整个 Python 阶段完成。

## Task 7：agent 依赖编辑，只公开 prepare/commit

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
- Create: `poc4/python-runner/tests/dependency-editor.sh`

**Interfaces:** Editor.prepare(operationId, requestSha256, change) 负责 scratch 解析并持久化 PREPARED 后返回 1.2 的摘要 DTO。Transaction 的公开入口仅 commit(PythonDependencyCommit)，首次和中断后的再次调用共用它；stage(operationId, requestSha256, pyprojectContent, lockContent) 是仅供 Editor 使用的包内方法。文件正文不进入 HTTP DTO。

- [ ] **Step 1 — 用真实临时文件写失败测试。** prepare 失败不改源文件；同 ID/请求已 PREPARED 时不再次 uv；改第一文件后中断，重建对象再次 commit 完成第二文件；相同最终 receipt 直接返回；不同摘要、第三种内容、symlink escape 拒绝。

```java
@Test
void theSameCommitCompletesAfterRestart(@TempDir Path root) throws Exception {
    Files.writeString(root.resolve("pyproject.toml"), "[project]\nname='demo'\n");
    Files.writeString(root.resolve("uv.lock"), "version = 1\n");
    var tx = new PythonDependencyTransaction(root, renamed -> {
        if (renamed == 1) throw new IllegalStateException("simulated crash");
    });
    var prepared = tx.stage("11111111-1111-4111-8111-111111111111", "a".repeat(64),
        "[project]\nname='updated'\n", "version = 1\nrevision = 3\n");
    String receipt = "{\"operationId\":\"%s\",\"type\":\"PYTHON_DEPENDENCIES\","
        + "\"path\":\"pyproject.toml\",\"nextPath\":\"uv.lock\","
        + "\"beforeSha256\":\"%s\",\"afterSha256\":\"%s\"}";
    receipt = receipt.formatted(prepared.operationId(), prepared.beforeSha256(), prepared.afterSha256());
    String receiptSha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
        .digest(receipt.getBytes(StandardCharsets.UTF_8)));
    var command = new PythonDependencyCommit(prepared, receipt, receiptSha);
    assertThatThrownBy(() -> tx.commit(command)).isInstanceOf(IllegalStateException.class);
    var result = new PythonDependencyTransaction(root).commit(command);
    assertThat(result.afterSha256()).isEqualTo(prepared.afterSha256());
    assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo("version = 1\nrevision = 3\n");
}
```

生产构造只接收 Path；测试包内构造可额外接收 IntConsumer afterRename，不把故障注入开放到 HTTP。例子验证提交协议，真实 uv 项目有效性另测。

- [ ] **Step 2 — 运行并确认正确失败。** `mvn -q -f poc4/workspace-agent/pom.xml '-Dtest=PythonDependencyEditorTest,PythonDependencyTransactionTest' test`。
- [ ] **Step 3 — 最小工具实现。** Python/uv 版本复用 Task 4 固定值。helper 用标准库 tomllib 检查支持范围，以固定 argv 在 scratch 执行；root-owned helper 由 `/usr/local/bin/python3 -I /opt/manao-python/dependency_helper.py` 启动，不能从用户项目 import 管理代码。

```text
uv add --no-sync --no-build --no-sources --no-config --no-python-downloads --python /usr/local/bin/python3 --default-index https://pypi.org/simple httpx==0.28.1
uv remove --no-sync --no-build --no-sources --no-config --no-python-downloads --python /usr/local/bin/python3 --default-index https://pypi.org/simple httpx
```

解析预算初始 20 秒，允许部署配置且必须有界；测量代表性包后与 Task 8 prepare timeout 对齐，超时终止子进程树，输出最多 64 KiB，错误返回固定安全信息。禁用 shell 拼接、用户来源配置与构建后端执行。
- [ ] **Step 4 — journal 与同一 commit 实现。** prepare 响应前 fsync 两目标文件和 manifest；commit 核对 ID/request/before/after、持久化 receipt 后逐文件原子替换，最终写 receipt。首次提交和核对通过同一文件锁串行化，不另写 recover 状态机。无 PENDING 授权不提交，缺 journal 保持失败；只读 receipt 不推进写入。
- [ ] **Step 5 — 定向测试与真实 uv 工具测试通过后提交。**

```powershell
mvn -q -f poc4/workspace-agent/pom.xml '-Dtest=PythonDependencyEditorTest,PythonDependencyTransactionTest,WorkspaceAgentApplicationTest' test
docker build -t manao-python-workspace-agent-test poc4/workspace-agent
bash poc4/python-runner/tests/dependency-editor.sh manao-python-workspace-agent-test
```

至少一次真实 uv add/remove、prepare 源文件不变、commit 锁一致、丢响应再 commit 不重解析；记录解析耗时和超时/终止结果。建议提交 `feat(agent): prepare and commit Python dependency changes`。

## Task 8：依赖操作 ID、持久回执与统一核对

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
- Create: `poc4/backend/src/main/resources/db/migration/V10__python_dependency_operations.sql`
- Create: `poc4/backend/src/test/java/com/manao/poc4/workspace/PythonDependencyHttpContractTest.java`
- Create: `poc4/backend/src/test/java/com/manao/poc4/workspace/PythonDependencyOperationTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/WorkspaceApiClientTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/api/ErrorSanitizationTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/persistence/FlywaySchemaTest.java`
- Modify: `poc4/backend/src/test/java/com/manao/poc4/persistence/AtomicTransitionTest.java`

**Interfaces:** PythonDependencyService 的 change(ownerId, projectId, operationId, change, expectedRevision)、status(ownerId, projectId, operationId)、pending(ownerId, projectId)、reconcile(ownerId, projectId, operationId) 对应 1.2。它负责 Python 请求规则，WorkspaceOperationService 负责锁、receipt、持久状态与 revision；WorkspaceStore 不接受包名或 uv 命令。

Store 新增按 projectId/operationId 查询 PENDING 与 COMMITTED 行的 findOperation；OperationRecord 携带 operationKind/requestSha256。核对提交使用 commitReconciledOperation(operationId, projectId, expectedRevision)，与原 commitOperation 共享私有事务实现，避免复制一份 SQL 状态机。当前只对经验证的 PYTHON_DEPENDENCIES 开放 reconciliation 失败恢复，不借此重写旧单文件协议。

- [ ] **Step 1 — 写失败测试。** 非 owner 404、Java 拒绝、输入注入拒绝；Run/revision/pending 冲突时不 prepare。成功丢响应后 status 返回同 ID 的 COMMITTED；同 ID 同请求不二次 uv，同 ID 不同请求 409；多标签页只核对各自 ID。PENDING 丢 commit 响应用同一 commit 完成，revision 只增一次。未记录操作返回 UNCONFIRMED，不自动重发。
- [ ] **Step 2 — 核对 disposable MySQL 的持久性和 V9 升级。**

```sql
ALTER TABLE workspace_operation
  ADD COLUMN operation_kind VARCHAR(32) NOT NULL DEFAULT 'FILE',
  ADD COLUMN request_sha256 CHAR(64) NULL,
  ADD CONSTRAINT ck_workspace_operation_kind
    CHECK (operation_kind IN ('FILE', 'PYTHON_DEPENDENCIES')),
  ADD CONSTRAINT ck_python_dependency_request
    CHECK (operation_kind = 'FILE' OR
      (request_sha256 IS NOT NULL AND REGEXP_LIKE(request_sha256, '^[0-9a-f]{64}$', 'c')));
```

V10 增量 trigger 保护这两列不可原地改变；不修改旧 migration。既有 id 唯一性防重复，requestSha256 绑定意图。保留 COMMITTED 行以回答丢响应，不加独立请求表。HTTP 状态测试与真实 store 升级/重建测试各验证自己的职责。

```powershell
mvn -q -f poc4/backend/pom.xml '-Dtest=PythonDependencyHttpContractTest,PythonDependencyOperationTest' test
```

- [ ] **Step 3 — 实现并验证服务调用顺序。**

```text
owner/project validation + existing reentrant lifecycle lease
  -> if same ID exists: compare request digest, return/reconcile that operation
  -> validate current revision/no active Run/no unresolved operation
  -> agent prepare returns summary of durable PREPARED result
  -> DB PENDING(id, kind, requestSha, beforeSha, afterSha, receiptSha)
  -> agent commit(summary reference + deterministic receipt)
  -> verify receipt identity/digests
  -> one DB transaction commits operation and revision
```

先查已登记 ID，再用当前 revision 拒绝新请求，避免成功重试因 revision 已变被误判。返回提交成功前不删除操作记录。状态查询是只读，reconcile 对 COMMITTED 直接返回结果；对 PENDING 仅引用 DB 已登记摘要调用 Task 7 commit。

- [ ] **Step 4 — 复用现有 gate 与恢复事务。** ProjectLifecycleGate 已同线程可重入、WorkspaceService 读取已 gated；新增逻辑只保证 pending 检查、同一 gate 实例及重启后的持久状态核对。不得再建一套读锁。专用核对提交锁 project/op 两行，核对 kind、PENDING、revision、无活动 Run；允许 READY 或仅本次 WORKSPACE_RECONCILIATION_REQUIRED 的 FAILED，其余 FAILED/DELETING 拒绝。操作提交、revision 增加及该失败解除必须同事务，条件不符全部回滚。

已 commit 的操作再次核对不清除后来产生的其他失败。缺失/损坏 journal、摘要不匹配保持锁定；不能通过观察“当前两文件像旧内容”便删除 PENDING。ApiError 的新增 code 都对应固定安全 message，工具输出不进响应。
- [ ] **Step 5 — 跑定向测试后提交。**

```powershell
mvn -q -f poc4/backend/pom.xml '-Dtest=PythonDependencyHttpContractTest,PythonDependencyOperationTest,WorkspaceApiClientTest,ErrorSanitizationTest,FlywaySchemaTest,AtomicTransitionTest,WorkspaceControllerTest' test
```

条件回滚、读取/运行遇到 PENDING 拒绝、原单文件协议、COMMITTED 查询必须有断言。缺 MySQL 权限与业务失败区分记录。建议提交 `feat(workspace): track and reconcile dependency operation receipts`。

## Task 9：依赖表单及刷新后仍可达的恢复入口

**Files**
- Create: `poc4/frontend/src/api/pythonDependencyApi.ts`
- Create: `poc4/frontend/src/features/dependencies/PythonDependenciesPanel.tsx`
- Create: `poc4/frontend/src/features/dependencies/PythonDependenciesPanel.test.tsx`
- Create: `poc4/frontend/src/features/dependencies/PythonDependencyRecovery.tsx`
- Create: `poc4/frontend/src/features/dependencies/PythonDependencyRecovery.test.tsx`
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.tsx`
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.test.tsx`
- Modify: `poc4/frontend/src/features/projects/ProjectRoutePage.tsx`
- Create: `poc4/frontend/src/features/projects/ProjectRoutePage.test.tsx`
- Modify: `poc4/frontend/src/features/projects/ProjectCard.tsx`
- Modify: `poc4/frontend/src/features/projects/ProjectCard.test.tsx`
- Modify: `poc4/frontend/src/mocks/handlers.ts`
- Modify: `poc4/frontend/tests/e2e/python-runtime-lifecycle.spec.ts`

**Interfaces:** panel 消费 Task 8 的 change/status/reconcile。Recovery 是 READY/FAILED 页面共用的具体 UI；无新全局任务中心。首次 ID 在 POST 前按当前用户/项目存入 sessionStorage，完成重载或明确无副作用拒绝后移除；登出不让下一用户继承操作，清理用户本地缓存。服务端 owner-scoped pending 查询兜底新会话的 FAILED 恢复，不将别人的 ID 当作可访问凭证。

- [ ] **Step 1 — 红测覆盖真实用户路径。** 包名/可选版本输入，ADD/REMOVE；dirty/active Run/pending 时禁用。POST 已 COMMITTED 但响应丢失 → 刷新 → 以原 ID GET 得到 COMMITTED → 当前文件/revision 重载，POST 次数仍为 1。PENDING 导致项目 FAILED → 刷新项目 URL → 按钮仍在 → reconcile 原操作 → READY。

```tsx
// HTTP handler 在提交后模拟网络错误；原 operationId 保存在会话里。
expect(screen.getByRole('button', { name: 'Check dependency change' })).toBeEnabled();
await user.click(screen.getByRole('button', { name: 'Check dependency change' }));
// 断言 handler 捕获的 GET/reconcile 均携带首次 operationId，未发送第二个 ADD。
expect(screen.queryByText('Dependency change is unconfirmed')).not.toBeInTheDocument();
```

在 ProjectRoutePage.test 中以完整路由重挂载验证 FAILED，不能只渲染 Recovery 小组件就声称刷新后可达；另一种失败原因及 DELETING 不显示恢复操作。
- [ ] **Step 2 — 运行红测。**

```powershell
pnpm -C poc4/frontend test -- src/features/dependencies/PythonDependenciesPanel.test.tsx src/features/dependencies/PythonDependencyRecovery.test.tsx src/features/projects/ProjectRoutePage.test.tsx
```

- [ ] **Step 3 — 实现最小界面。** Python 工作台显示依赖表单；首次生成 ID 复用已有 crypto.getRandomValues 的 HTTP 安全上下文兼容方式，不假定公网 HTTP 有 randomUUID。提交后结果不明保留 ID，只允许查询/核对，不自动重发。COMMITTED 重载当前两文件/树/revision 后才解除前端写锁，不把历史 resultWorkspaceRevision 当最新版本。
- [ ] **Step 4 — 把恢复入口接到路由状态页。** ProjectRoutePage 的 FAILED 分支在确认为 Python+WORKSPACE_RECONCILIATION_REQUIRED 时渲染 Recovery。ProjectCard 为该失败增加“Check dependency change”链接进入状态页；不将 Open 按钮无条件开放给所有 FAILED 项目。READY 页面也能核对已保存但响应丢失的 ID。无本地 ID 时先读 pending；无记录只显示 UNCONFIRMED，不伪造成功或解锁未知操作。
- [ ] **Step 5 — 定向 UI、构建及 E2E 用例准备完成后提交。**

```powershell
pnpm -C poc4/frontend test -- src/features/dependencies/PythonDependenciesPanel.test.tsx src/features/dependencies/PythonDependencyRecovery.test.tsx src/features/projects/ProjectRoutePage.test.tsx src/features/projects/ProjectCard.test.tsx src/components/shell/WorkbenchShell.test.tsx
pnpm -C poc4/frontend build
pnpm -C poc4/frontend test:boundary
```

补入真实浏览器添加 httpx→import→移除→import 失败，以及丢响应/FAILED 刷新恢复用例；真实执行集中在 Task 11。建议提交 `feat(frontend): add uv dependency edits and reachable recovery`。

## Task 10：发布准备、实际工具版本及独立 E2E 入口

**Files**
- Modify: `poc4/deploy/6b/backend.yaml`
- Modify: `poc4/deploy/6b/README.md`
- Modify: `poc4/frontend/package.json`
- Modify: `poc4/frontend/playwright.python-runtime.config.ts`
- Modify: `poc4/frontend/tests/e2e/python-runtime-lifecycle.spec.ts`
- Create: `poc4/docs/evidence/python-runtime/acceptance.md`
- Modify: `poc4/python-runner/README.md`
- Modify: `AGENTS.md`
- Modify: `docs/what-we-have-done.md`

**Interfaces:** 运行配置新增 `MANAO_PYTHON_RUNNER_IMAGE`，按原 image Secret 注入模式交付；README 记录与之配套的 workspace-agent/backend/frontend/Java runner digest、Python/uv 版本及 seed ID。不把真实 Secret 明文写进版本库。

- [ ] **Step 1 — 核对 Task 6 已创建的独立真实云端测试 config。** 参考既有 Java config，但只收集 Python spec；`workers=1,retries=0,webServer=undefined`，不启动本地服务。沿用 `MANAO_RUNTIME_BASE_URL/USERNAME/PASSWORD/PUBLIC_PORT_1/PUBLIC_PORT_2`。缺值显式失败，不自动选端口，不输出密码。
- [ ] **Step 2 — 在 spec 写入 Task 11 的真实断言。** 先通过 `--list` 检查收集；这只证明入口可加载。核对 Task 6 已添加的脚本名 test:e2e:python-runtime，不另建重复入口。

```json
"test:e2e:python-runtime": "playwright test --config playwright.python-runtime.config.ts"
```

- [ ] **Step 3 — 构建并记录可交付版本。** 以执行 commit、镜像 ID/digest、模板 lock hash、seed ID 和工具实际 `--version` 为一组。修过源码就重新构建相应镜像并更新记录。agent 和 runner 的 uv/Python 验证版本一致；Java runtime-test 的 profile 变化也需对应新 Maven image。
- [ ] **Step 4 — 写出可核对的发布动作及回滚边界。** 沿用 deployment README 的目标 context/namespace、镜像 Secret、apply/rollout 命令。短维护窗内补新 digest 配置、发布兼容前端与 agent/backend，完成健康核对再开放创建。新 Python 项目应使用新 agent 镜像；既有 Java workspace 不强制重建。
- [ ] **Step 5 — 发布授权到位后执行该清单并留证；若任务只授权本地开发，则交付完整镜像/差异/部署清单等待发布决定。** 不以计划本文视为当前发布授权。验收文件初始只能写真实已做检查及其局限；不能直接标阶段 PASS。
- [ ] **Step 6 — 聚焦提交。** 建议 `chore(deploy): prepare Python runtime release and cloud acceptance`。

## Task 11：集中云端验收、Java 回归和收尾

**Files**
- Modify: `poc4/frontend/tests/e2e/python-runtime-lifecycle.spec.ts`
- Modify: `poc4/docs/evidence/python-runtime/acceptance.md`
- Modify: `poc4/deploy/6b/README.md`
- Modify: `AGENTS.md`
- Modify: `docs/Manao-Projects-goal.md`
- Modify: `docs/what-we-have-done.md`

**Interfaces:** 仅使用真实已部署公网浏览器入口及项目/Run API 驱动产品行为；资源和数据库查询负责独立核实结果，不替用户从集群直接改文件来伪造 UI 能力。

- [ ] **Step 1 — 实时前检和样本清单。** 确认目标 context、`manao-stage6b`、节点/容量、RBAC、存储、所有镜像 digest。新建唯一前缀且 owner 明确的 Python console、Python web 和必要的 Java 回归项目；记录项目/Run ID、端口、预期资源。不得复用或清理历史 DELETING 项目。
- [ ] **Step 2 — 普通 Python 与依赖闭环。** 浏览器创建、执行欢迎程序和中文日志；修改成异常并看见 FAILED/traceback，再修复成功；依赖面板添加 httpx，编辑源码 import 后成功；重复 Run 验证缓存；移除 httpx 后 import 应失败；改回基础程序成功。确保两文件及 revision 持久化，刷新/重新登录可见；注入一次提交成功后丢响应，按同 operationId 查询 COMMITTED，revision 不重复增加。再覆盖 FAILED 页刷新后仍能进入指定操作的核对，不通过重新 ADD 修复。
- [ ] **Step 3 — FastAPI 公网和数据闭环。** 用户预指定端口创建 Web + MySQL + Redis，真实 HTTP `/api/demo` 成功。测试通过浏览器编辑 `app/main.py` 加入最小读写用例，写入项目 MySQL/Redis 样本，停止、编辑响应、再次运行，MySQL 样本仍在；端口冲突保持原值且无第二项目。没有公网配置的路径由 Task 4 容器证据覆盖，除出现新疑点不再重复整套云端场景。
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

## 2. 执行顺序、覆盖与完成边界

顺序 `Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11`，不安排并行修改。

| 结果 | 任务 | 证据 |
| --- | --- | --- |
| 先得到 Python/FastAPI 运行路径，Java 继续可用 | 1–6 | 旧 JSON、真实模板/runner、Job 接入、UI 交互与可用环境的浏览器烟测 |
| 最小 uv 入口 | 7–9 | 真实 add/remove、两文件最终内容、浏览器 import 与移除 |
| 中断不盲目重试，成功丢响应可查 | 7–9 | 同 ID/request digest、一个 commit 实现、COMMITTED 查询和一次 revision |
| FAILED 后仍可继续用户流程 | 8–9 | 完整路由刷新到失败页、卡片入口、owner-scoped pending、原操作核对 |
| 时限和进程退出 | 3–5、11 | 公共监督器既有测试 + Python 真实进程链 + 独立正式 7200s 结果 |
| 缓存、数据和清理 | 2、4–6、11 | 固定 seed、私有 cache、新 venv、数据持久化及资源回收 |

用户已确定的模板、uv 入口、手填端口、寿命和手动重跑不反复询问。20 秒解析预算和公共 wheel 边界是明确的工程默认与首版支持范围；根据实际测量调整预算无需重启产品设计，但扩大来源/执行构建后端须先说明影响。

本地实现、定向测试和镜像构建完成不等于云端交付。缺环境或发布授权时完成可独立完成的工作，交付具体镜像/迁移/部署清单和未测项目；不能自动提高状态为 PASS，也不能扩大权限或处置历史诊断资源。
