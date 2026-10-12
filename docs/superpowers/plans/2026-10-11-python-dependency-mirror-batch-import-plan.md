# Python 依赖镜像源与批量导入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本文件只描述计划；当前未实施、未提交、未部署。

**Goal:** 在现有 Python `uv add/remove` 可靠操作协议上，将新依赖解析默认切换到阿里云 PyPI 镜像，并增加一个把根目录 `requirements.txt` 批量导入合并为一次事务的入口。

**Architecture:** 依赖操作仍然是一次“解析暂存 → 后端登记 PENDING → 两个受管文件原子提交 → workspace revision +1”的状态转换；批量导入不循环调用单包接口。镜像源只改变 `uv` 的解析与新锁文件生成，不自动改写用户已有的 `uv.lock`；运行时继续以锁文件中的来源和哈希为准，避免在每次 Run 中隐式修改用户工作区。前端首版只提供根目录 `requirements.txt` 导入，进入同一个 batch API，agent 只执行一次受限的 `uv add -r`。

**Tech Stack:** Java 17/Spring Boot/Fabric8 workspace-agent；React/TypeScript/pnpm；Python 3.13、uv 0.11.6；Kubernetes workspace PVC；JUnit、Vitest、真实容器脚本和可授权的云端浏览器验收。

**Spec:** [Python Runtime Design](../specs/2026-09-25-python-runtime-design.md)；本计划补充其中原先明确排除的镜像源与批量依赖提升点。

**Status:** 2026-10-11 规划阶段。基于分支 `codex/python-runtime` 当前已完成的 Python 运行时、工作台红字重试和终态日志补采实现；不包含部署授权。

## Global Constraints

- 本轮首选且唯一默认解析源为阿里云公共 PyPI simple index；不新增用户可选源、不自动在阿里云/清华/中科大/PyPI 之间故障切换，不支持私有索引、Git、URL、path、editable、`--extra-index-url`、`-r` 嵌套和 `--find-links`。
- 镜像候选地址固定写入受控运行组件和测试：`https://mirrors.aliyun.com/pypi/simple/`；实施前必须用实际 `uv 0.11.6`、CPython 3.13 Linux 容器验证索引、当前模板依赖和至少一个新增包，不能只凭字符串替换判断可用。
- `uv.lock` 是运行时事实来源。本轮只验证新模板和本次依赖操作生成的锁使用镜像；历史项目及其锁迁移不在范围内。
- 单包 ADD/REMOVE 的现有 HTTP 协议、operationId、receipt、PENDING/COMMITTED/UNCONFIRMED、workspace revision 和恢复语义保持兼容；batch ADD 使用同一套持久化协议，一次 batch 只产生一次 revision。
- batch 输入使用 UTF-8 文本，最多 64 KiB、最多 50 条非空 requirement；空行和整行 `#` 注释允许。每个有效行必须是当前 helper 已支持的 plain public-PyPI PEP 508 requirement，允许 extras、版本比较符和环境 marker；不接受索引/源/文件路径等选项。
- 批量解析预算继续复用现有的 20 秒默认值和单调 deadline；不按包启动多个 uv、不引入后台队列、不增加新依赖任务表。若整体解析超时，保持现有 `PYTHON_DEPENDENCY_TIMEOUT` 语义。
- 前端只使用 pnpm；Python 依赖只通过受控 `uv add/remove` 流程修改，禁止 pip 和 `uv pip install/uninstall`。
- 不修改 Java 运行时、Python Run/日志链路、项目数据依赖、数据库迁移表结构或工作区锁的全局策略；不在本轮部署到线上。
- 所有新建或改写文本文件 UTF-8 无 BOM；每个任务结束执行 `git diff --check`，保留现有无关改动和历史验收证据。

---

## 现状结论与关键取舍

1. 当前 agent helper 的固定 `UV_ARGV_PREFIX` 使用 `--default-index https://pypi.org/simple`；`poc4/python-runner/prepare-python-seed.sh` 的冷缓存 seed 也没有切换到国内源。故真正要改的是“锁生成/依赖解析”和 seed 构建链路，而不是只改前端提示。
2. 当前运行 launcher 执行 `uv sync --locked`，锁文件记录的 registry 与 artifact URL 决定实际安装来源。因此本轮只处理新模板和新依赖操作生成的锁，不改运行时启动协议，也不引入隐式重锁。
3. 当前单包依赖操作的安全性和可靠性来自 prepare/commit 两阶段。批量导入必须扩展同一协议，而不能让前端循环调用 10 次单包 POST；否则会产生多次 revision、多个 uv 解析、部分成功和恢复困难。
4. `uv add -r requirements.txt` 已是 uv 的原生导入形式，但用户文件中的索引选项、嵌套引用和直接 URL 会突破平台固定源边界。因此 agent 在 scratch 中先按既有 plain requirement 规则过滤，再只执行一次受控的 `uv add -r`。

## 任务 0：镜像与锁文件兼容性预检

**目的：** 在修改模板锁前，用现有容器工具链证明阿里云索引能解析当前 Python 3.13 模板依赖和至少一个新增包。本任务不新增长期维护的预检脚本。

**Files:**
- Read-only inputs: `poc4/backend/src/main/resources/workspace-template-python/pyproject.toml`
- Read-only inputs: `poc4/backend/src/main/resources/workspace-template-python-web/pyproject.toml`
- Read-only inputs: corresponding `uv.lock` files

- [ ] **Step 1: 在 disposable scratch 中执行真实预检。**

复制模板到临时目录，用与 runner/agent 一致的 uv 0.11.6、CPython 3.13 Linux 环境执行带固定阿里云 `--default-index` 的 lock/add/sync；至少覆盖 fastapi、uvicorn、pymysql[rsa]、redis 和一个新增包，并检查生成锁中的 registry/artifact 来源。

- [ ] **Step 2: 记录预检结果并清理 scratch。**

Expected: 当前模板依赖可以解析，新增包可以加入，生成的锁可在相同容器内 `uv sync --locked`。若 artifact 实际仍指向外部 host，只记录事实，不把索引响应更快写成所有文件都从阿里云下载。预检失败时停止，不继续修改模板锁。

**独立验收：** 预检不改仓库文件、不触碰历史项目或运行时 PVC，并得到可供任务 1 使用的实际来源结论。

## 任务 1：切换受控依赖解析源并重建 Python seed

**Files:**
- Modify: `poc4/workspace-agent/src/main/resources/python-dependency-helper.py:56-92`
- Modify: `poc4/python-runner/prepare-python-seed.sh:50-90`
- Modify: `poc4/backend/src/main/resources/workspace-template-python/uv.lock`（由 uv 重新生成，不手工替换 URL）
- Modify: `poc4/backend/src/main/resources/workspace-template-python-web/uv.lock`（由 uv 重新生成，不手工替换 URL）
- Modify: `poc4/python-runner/README.md` 的 toolchain、cache 和 dependency-editing 约定
- Test: `poc4/python-runner/tests/dependency-editor.sh`
- Test: `poc4/python-runner/tests/python-cache.sh`

**Interfaces:**
- Consumes: 任务 0 已验证的 `INDEX_URL` 和当前 uv 0.11.6。
- Produces: 新模板锁、agent prepare、seed 构建使用同一个默认解析源；runner 仍只消费锁，不读取用户级 uv 配置。

- [ ] **Step 1: 先为 helper 增加失败测试。**

测试需要证明：

```text
- 固定 uv argv 包含 --default-index https://mirrors.aliyun.com/pypi/simple/；
- [tool.uv] 中不是该允许源的配置仍返回 PYTHON_DEPENDENCY_UNSUPPORTED；
- 用户环境中的 UV_DEFAULT_INDEX、UV_INDEX 和 uv 配置文件不能覆盖平台固定源；
- prepare 失败不会创建 PREPARED journal。
```

- [ ] **Step 2: 修改 helper 的固定 argv。**

把 `DEFAULT_INDEX_URL` 改为阿里云地址，并让 `UV_ARGV_PREFIX` 在 `--no-config`、`--no-sources`、`--no-python-downloads` 约束下显式传入 `--default-index`。保留现有安全分类、输出封顶、超时和平台 wheel 检查；不增加 PyPI fallback。

- [ ] **Step 3: 修改 seed 构建命令。**

在 `prepare-python-seed.sh` 的每个联网 `uv sync --locked`/必要的锁生成命令中显式传入同一 `--default-index`；offline verification 不联网且不添加 fallback。重新导出模板并用实际 uv 生成两个 `uv.lock`，禁止对 lock 文件做大范围字符串替换。

- [ ] **Step 4: 执行镜像/缓存定向验证。**

Run:

```bash
bash poc4/python-runner/tests/dependency-editor.sh <workspace-agent-test-image>
bash poc4/python-runner/tests/python-cache.sh <python-runner-test-image>
git diff --check
```

Expected: 单包 ADD/REMOVE、prepare/commit、无 wheel、超时和冷/暖 cache 继续通过；新锁的 registry/artifact 来源与预检结论一致。

## 任务 2：把 agent prepare 扩展为一次 batch requirements 解析

**Files:**
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceAgent.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspaceApiClient.java`
- Modify: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/WorkspaceAgentController.java`
- Modify: `poc4/workspace-agent/src/main/java/com/manao/poc4/workspaceagent/PythonDependencyEditor.java`
- Modify: `poc4/workspace-agent/src/main/resources/python-dependency-helper.py`
- Test: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/WorkspaceApiClientTest.java`
- Test: `poc4/workspace-agent/src/test/java/com/manao/poc4/workspaceagent/PythonDependencyEditorTest.java`
- Test: `poc4/python-runner/tests/dependency-editor.sh`

**Interfaces:**
- Existing: `prepare(projectId, operationId, requestSha256, DependencyChange)` remains for single ADD/REMOVE。
- New: `prepareBatch(projectId, operationId, requestSha256, String requirementsText)`；返回仍为 `PreparedPythonDependencies`，不携带文件内容。
- Agent HTTP: 新增 `/agent/v1/python-dependencies/prepare-batch`，请求只包含 `operationId`、`requestSha256`、`requirementsText`。

- [ ] **Step 1: 写 batch prepare 的失败测试。**

覆盖：

```text
- 多行 requirements 只调用一次 resolver/uv，workspace 源文件保持不变；
- 空行和整行注释被接受；
- -r、--index-url、--extra-index-url、--find-links、-e、git+、http(s) URL、file/path 被拒绝；
- batch prepare 的同 operationId + 同 requestSha256 返回同一摘要，不再次解析；
- batch 结果仍写入既有两文件 journal，commit 仍只能改 pyproject.toml 与 uv.lock。
```

- [ ] **Step 2: 增加 batch wire record 和 client transport。**

新增明确的 batch record，不把多行文本塞进现有 `packageName` 字段。`WorkspaceApiClient` 使用现有签名请求、超时和错误映射；请求 body 只传文本和摘要，不传 shell 命令、index URL 或任意环境变量。

- [ ] **Step 3: 复用 scratch 与 PythonDependencyTransaction。**

`PythonDependencyEditor.prepareBatch` 复制当前 `pyproject.toml`/`uv.lock` 到 scratch，把要求文本写成 agent 私有的固定文件名，调用一次 helper；成功后继续调用已有 `transaction.stage`。不改 `PythonDependencyTransaction` 的 journal schema，不增加第三个受管文件。

- [ ] **Step 4: 在 helper 中做唯一的文件语法过滤和一次 uv 导入。**

helper 在执行 uv 前逐行处理 UTF-8 文本：去除空行/整行注释，限制每行 plain requirement，拒绝所有源切换和嵌套文件选项，然后以固定 argv 执行一次：

```text
uv --no-sync --no-build --no-sources --no-config --no-python-downloads
   --python /usr/local/bin/python3
   --default-index <固定阿里云地址>
   add -r <agent 私有 requirements 文件>
```

后续 installability verification 仍使用同一 deadline。不要在 Java 或前端再实现一份 PEP 508 解析器。

- [ ] **Step 5: 跑 agent 定向测试。**

Run:

```powershell
mvn -q -f poc4/workspace-agent/pom.xml test
mvn -q -f poc4/backend/pom.xml -Dtest=WorkspaceApiClientTest test
bash poc4/python-runner/tests/dependency-editor.sh <workspace-agent-test-image>
```

Expected: 原单包路径不变；批量路径一次解析、一次 prepare journal、一次 commit；不支持输入在写入前安全失败。

## 任务 3：在后端复用同一 operation/receipt 协议，增加 batch API

**Files:**
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/PythonDependencyController.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/PythonDependencyService.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/workspace/PythonDependencyOperationTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/workspace/PythonDependencyHttpContractTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/api/ErrorSanitizationTest.java`（若新增固定错误映射）

**Interfaces:**
- New HTTP: `POST /api/v1/projects/{projectId}/python-dependencies/batch`
- Request:

```json
{
  "operationId": "<opaque id>",
  "requirementsText": "httpx==0.28.1\nfastapi>=0.141.1\n",
  "expectedWorkspaceRevision": "7"
}
```

- Response/status/reconcile: 继续使用既有 `StatusResponse`、`/{operationId}`、`/{operationId}/reconcile` 和 `/pending`。

- [ ] **Step 1: 先测试共享状态转换。**

至少覆盖：

```text
- batch 解析成功 -> PENDING -> COMMITTED，workspace revision 只增加 1；
- prepare 失败不注册 operation；
- commit 过程中丢响应后使用同 operationId 查询/恢复，不重复 uv；
- 同 operationId 不同 requirementsText 返回 DEPENDENCY_REQUEST_MISMATCH；
- 运行中、revision 过期、已有未核对 operation 时拒绝 batch；
- 单包 ADD/REMOVE 的旧断言继续通过。
```

- [ ] **Step 2: 让单包和 batch 进入同一内部请求模型。**

把单包请求转换为只有一项的内部 change/batch，batch 请求只做 line-ending、BOM、总字节数和条数上限检查，不在后端复制完整 requirement parser。request digest 必须包含协议版本、操作模式、规范化后的 requirements 文本和 expected revision；operationId 先查再比较 digest，保持现有丢响应语义。

- [ ] **Step 3: 复用既有锁、receipt、恢复和安全错误。**

batch 使用现有 `requirePythonTemplate`、active Run 检查、unresolved operation 检查、`registerPending`、`commitNewPythonDependency` 和 `reconcilePythonDependency`。若 acceptance fault 仍按包名触发，使用 batch 的第一条规范化 requirement 作为测试标签，不把 fault 机制扩展成第二套状态机。

- [ ] **Step 4: 跑后端定向回归。**

Run:

```powershell
mvn -q -f poc4/backend/pom.xml -Dtest=PythonDependencyOperationTest,PythonDependencyHttpContractTest test
git diff --check
```

Expected: 无 migration、无新任务表、无第二份依赖提交协议。

## 任务 4：前端增加根目录 requirements.txt 批量导入入口

**Files:**
- Modify: `poc4/frontend/src/api/pythonDependencyApi.ts`
- Modify: `poc4/frontend/src/features/dependencies/PythonDependenciesPanel.tsx`
- Modify: `poc4/frontend/src/mocks/handlers.ts`
- Modify: `poc4/frontend/src/mocks/state.ts`
- Test: `poc4/frontend/src/features/dependencies/PythonDependenciesPanel.test.tsx`

**Interfaces:**
- New client function: `changePythonDependencyBatch(projectId, { operationId, requirementsText, expectedWorkspaceRevision })`。
- Existing `changePythonDependencies`、recovery entry、operation storage and reload behavior remain unchanged。

- [ ] **Step 1: 写最小 UI 失败测试。**

覆盖：

```text
- 点击“Import requirements.txt”读取固定根目录文件并提交一次 batch POST；
- 一个含三行的文件只产生一个 batch POST，不产生三个单包 POST；
- batch 成功后只 reload workspace 一次，成功时清理 operationId；
- 网络丢响应、PROJECT_BUSY、失败项目恢复仍保留原 operationId；
- 空文件、超过限制或 agent 固定错误显示安全提示，不伪造成功。
```

- [ ] **Step 2: 复用现有 file API 读取固定路径。**

按钮调用既有 `getFileContent(projectId, 'requirements.txt')`，不新增上传服务、不让用户指定任意路径；读取成功后把原文直接交给 batch API。读取到的 `workspaceRevision` 作为提交依据，文件不存在或读取冲突使用现有文件错误展示。本轮不增加自由文本批量编辑器。

- [ ] **Step 3: 复用现有 operation 生命周期。**

批量提交生成并存储一个 operationId；提交中沿用 `onBusyChange` 锁定编辑写入；成功后沿用 `reloadWorkspaceAfterTerminalRun`，只做一次受管文件刷新。前端不实现 authoritative PEP 508 parser，后端/helper 负责校验。

- [ ] **Step 4: 更新 mock contract 并执行前端定向测试。**

mock 端增加 batch route，模拟一次 revision 增加和一次 COMMITTED；保留原单包 mock 和 recovery 场景。

Run:

```powershell
pnpm -C poc4/frontend test -- src/features/dependencies/PythonDependenciesPanel.test.tsx
pnpm -C poc4/frontend exec tsc -b --pretty false
```

Expected: 旧单包、恢复、锁定和刷新测试保持通过；新增导入场景明确断言请求次数为 1。

## 任务 5：真实容器与回归验收

**Files:**
- Modify: `poc4/python-runner/tests/dependency-editor.sh`
- Modify: `poc4/python-runner/tests/python-cache.sh`（只增加 source/lock 断言）
- Modify: `poc4/python-runner/README.md`
- Modify: `poc4/docs/evidence/python-runtime/acceptance.md`（只有真实证据产生后更新）
- Modify: `AGENTS.md`（更新当前计划的权威链接和状态）

- [ ] **Step 1: 增加 agent 真实 batch 场景。**

在现有 dependency-editor harness 中加入：

```text
- prepare-batch: httpx==0.28.1 与一个带版本范围的包一次解析；
- source-policy: requirements 中的 --index-url、-r、URL、git、path 被固定错误拒绝；
- batch-commit: 两个受管文件只替换一次，uv.lock 一致，revision/receipt 关系不变；
- batch-idempotent: 同 operationId 重放不再执行 uv，commit 结果相同；
- mirror-observed: 记录 lock registry/artifact 来源与预检一致。
```

- [ ] **Step 2: 保留 Java 和单包 Python 回归。**

Run backend/workspace-agent 全量定向测试、frontend 相关测试和既有 Java runtime 回归；不把镜像源或 batch 改动带入 Run/日志修复实现。

- [ ] **Step 3: 真实浏览器验证（需单独授权部署）。**

在一次 disposable Python 项目上：创建项目 → 编辑根目录 `requirements.txt` → 打开依赖面板 → 导入 → 一次提交三条依赖 → 观察只生成一个 operation/revision → Run 并确认依赖可 import → 重复 Run 使用已生成锁 → 删除项目并核对资源回收。单包 ADD/REMOVE 由既有回归测试覆盖，不另增加一套云端场景。

禁止直接修改现有 `test4`/`test5` 或清理历史诊断资源；若不部署，只报告本地/容器证据，不写云端 PASS。

- [ ] **Step 4: 更新文档并记录边界。**

README 和 acceptance 必须明确：

```text
- 默认解析源为阿里云；没有自动 fallback；
- 本轮只覆盖新模板和新依赖操作生成的镜像锁，历史项目不在范围；
- requirements.txt 只支持根目录、纯 public-PyPI requirement 行；
- batch 是一次事务，不提供逐包进度；
- 本轮没有新增依赖任务表、源选择器、后台队列或全量锁迁移。
```

## 执行顺序与完成定义

严格顺序：`任务 0 → 任务 1 → 任务 2 → 任务 3 → 任务 4 → 任务 5`。每个任务结束后先完成其定向测试，再进入下一个任务；任何镜像兼容性或锁来源疑点先停止在任务 0，不通过猜测继续改运行时。

本轮“实现完成”必须同时满足：

1. 阿里云镜像在真实 uv 0.11.6/CPython 3.13 Linux 容器中完成当前模板和新增包预检；
2. agent、seed、模板锁的解析源行为一致，现有单包流程保持通过；
3. batch/requirements 导入只有一个 HTTP operation、一次 uv 解析、一次两文件 commit、一次 revision 增量；
4. unsupported requirement、超时、丢响应和恢复仍 fail-closed；
5. 前端测试、后端测试、agent 容器测试和 `git diff --check` 有实际输出；
6. 云端部署和线上切换仍是后续单独授权，不从本地/容器测试推导为已部署。

## 明确非目标

- 不做清华/中科大/PyPI 自动 fallback 或用户选择器；
- 不做任意 requirements 语法、嵌套 requirements、constraints 文件、私有源、认证源或本地 wheel；
- 历史项目及其 `uv.lock` 不纳入本轮改造；
- 不做逐包并发下载、队列、实时进度流、取消/暂停控制；
- 不重做依赖状态机、日志采集、Run 生命周期、数据库 schema 或项目删除协议；
- 不借本轮提升点顺便支持 Go、TypeScript、Conda、pip、Notebook 或 GPU。