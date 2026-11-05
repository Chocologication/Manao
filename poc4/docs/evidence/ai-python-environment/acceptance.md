# AI Python 环境与开发闭环验收

**当前结论（2026-11-05）：AI_PYTHON_CLOSED_LOOP_PASS。** 原设计E1–R1已由本地分层验证、两类Python真实模型闭环、八项依赖故障、回滚恢复，以及最后一组独立重启/真实自动压缩/图片/B2负面验证闭合，独立gate审查APPROVE。最新worker66d5968已部署，backend/agent/runner保持55f2067、UI保持f58581a；各组件身份和历史失败见[最终验证](final-verification-20261105.md)及[脱敏JSON](final-verification-20261105.json)。本标签限定本设计范围，不代表全平台压力/故障/全预算耗尽；下文日期明确的本地/首轮快照保留历史原意。

本地交付快照（2026-11-04）：分支 `codex/ai-python-environment`，最终实现提交 `b5b02fe`。本地实现、分层验证与全分支审查完成，授予范围限定的 **AI_PYTHON_LOCAL_PASS**。并发构建证据覆盖及反向时序残留已修复并独立复审批准，受影响回归149项通过。**当时**云端发布、迁移、真实模型与浏览器闭环均NOT_RUN、完整标签未授予；当前结论以上方最终更新为准。完整本地提交清单见[交付记录](delivery.md)。

设计合同：[设计 §9–10](../../../../docs/superpowers/specs/2026-11-04-ai-python-environment-design.md#9-验收与交付边界)；实施：[九任务计划](../../../../docs/superpowers/plans/2026-11-04-ai-python-environment-implementation-plan.md)；发布：[操作与回滚手册](../../../deploy/ai-python-environment/README.md)。

**首轮授权更新（2026-11-04）**：本地NOT_RUN之后，实际完成五项发布、V20、普通Python两轮、FastAPI分段继续、Java两模板及pytest暂停/继续，见[首轮记录](cloud-20261104.md)及[JSON](cloud-20261104.json)。该轮完整矩阵尚未闭合、未授予完整标签；本页旧表保留历史证据，不将其倒填为首轮全部PASS。

**2026-11-05中间交付**：UI reload修复/完整FastAPI、八项依赖故障及旧Java维护窗口回滚/恢复PASS，见[后续记录](cloud-followup-20261105.md)、[故障](dependency-faults-20261105.json)、[回滚](rollback-20261105.json)。当时用户暂缓的独立重启/自动压缩/图片等仍NOT_RUN，未授予完整标签；这些专项现已按最后授权完成。

## 1. 本地证据与范围

以下为本次各任务实际记录，保留不同提交/修复后定向重跑的边界；不是把重叠用例相加的总数，也不是 Task 9 重新全量运行。原始开发日志/报告保留在本地 `.superpowers/sdd/2026-11-04-ai-python-environment-implementation-plan/`；长期源码入口如下。

| 检查 | 实际结果 | 源码/记录与限制 |
| --- | --- | --- |
| Task 1：四模板可信环境、持久化快照/hash、同请求重试、V20/旧 NULL 兼容 | PASS：环境+task service 72；受影响迁移/会话 36，均 0 failure/error/skip | [AgentProjectEnvironmentTest](../../../backend/src/test/java/com/manao/poc4/ai/AgentProjectEnvironmentTest.java)、[AgentTaskServiceTest](../../../backend/src/test/java/com/manao/poc4/ai/AgentTaskServiceTest.java)；本地 disposable MySQL，非运行库迁移 |
| Task 2：Python 文件策略及真实嵌套路径保存 | PASS：backend 48；workspace-agent 25 actual testcase nodes，均 0 failure/error/skip | [AgentFilePolicyTest](../../../backend/src/test/java/com/manao/poc4/ai/AgentFilePolicyTest.java)、[WorkspaceFileServiceTest](../../../workspace-agent/src/test/java/com/manao/poc4/workspaceagent/WorkspaceFileServiceTest.java)；nested suite 外层 tests=0 不能漏算 |
| Task 3：main/test 协议、签名 HTTP、真实 uv 与 test 依赖 | PASS：agent Java 52；backend 79；最终容器 35 behavioral checks（含 test 组 13），均 0 failure/error/skip | [WorkspaceApiClientTest](../../../backend/src/test/java/com/manao/poc4/kubernetes/WorkspaceApiClientTest.java)、[dependency-editor.sh](../../../python-runner/tests/dependency-editor.sh)；真实 scoped endpoint、旧组件拒绝、add/remove/last removal/冲突/超时 |
| Task 4：durable claims、operation identity、重启/取消边界、结果原子提交及占用释放 | PASS：初始 116；修复矩阵 17；受影响回归 227；最终 claim lookup 修复后定向 19，均 0 failure/error/skip | [AgentPythonDependencyToolsTest](../../../backend/src/test/java/com/manao/poc4/ai/AgentPythonDependencyToolsTest.java)；227 在最后小修复前，不标成最后源码的完整重跑 |
| Task 4 双文件真实部分写入、重建恢复与 commit 回包丢失组合 | PASS：1 test / 0 failure/error/skip | [详细组合证据](local-dependency-integration.md)，真实 AI service + workspace-agent classes/FS + Docker uv + disposable MySQL；未经过 HTTP/worker/model |
| Task 5：固定 copy/compile/test launcher、语法与 pytest 状态、取消/复制竞争 | PASS：最终镜像 development 44 checks；真实复制竞争 2/2；初始镜像 runtime 13、cache 14 | [development-build.sh](../../../python-runner/tests/development-build.sh)、[source-copy-race.py](../../../python-runner/tests/source-copy-race.py)；runtime/cache 复用未改层历史证据，未说成最终镜像全量重跑 |
| Task 6：Python manifest/executor/parser/终态事实持久化/UID 收尾 | PASS：完整 brief 96；后续 39；复审受影响 84；saved identity 定向 41；observe identity 中间定向 42；最终终态事实保留修复后 executor 45 | [DevelopmentBuildExecutorTest](../../../backend/src/test/java/com/manao/poc4/ai/DevelopmentBuildExecutorTest.java)、[PythonBuildEvidenceTest](../../../backend/src/test/java/com/manao/poc4/ai/PythonBuildEvidenceTest.java)；最终修正 `367a468` 独立复审 APPROVE；不同修复后定向验证，不合成一次全量 |
| 全分支 P2：同一 build 并发观测及迟到完成不能覆盖原终态 | PASS：初次 RED 3 failed → GREEN 3 passed、回归 148；复审反向时序 RED 1 failed / 2 passed → 定向 GREEN 4 passed；最终四组 149 passed（executor 48、project tools 45、task store 35、terminal settlement 21），0 failure/error/skip | [并发执行器回归](../../../backend/src/test/java/com/manao/poc4/ai/DevelopmentBuildExecutorTest.java)、[首次完成合同](../../../backend/src/test/java/com/manao/poc4/ai/AgentProjectToolsTest.java)；真实 disposable MySQL + Kubernetes mock，同 command/UID/source/environment，无第二 Job；覆盖强后弱、完成后弱保存，以及 timeout UNKNOWN 先保存、terminal PASS 后保存但 timeout 先完成的反向时序；结算锁内选取最新终态，两响应及重启重放保留 PASS，只在资源缺席后确认 cleanup；最终独立复审 APPROVE |
| Task 7：四模板真实 Pi SDK provider-stream 边界、loadout、历史/自动/手动 compact、工具参数 | PASS：一次 worker 全量 260 passed / 1 skipped；后续 prompt 定向 115；精确 version 合同修正后三文件 96 passed + tsc exit 0 | [project-environment.test.ts](../../../pi-worker/test/project-environment.test.ts)、[project-tools.test.ts](../../../pi-worker/test/project-tools.test.ts)；最终修正 `474bde7`；SKIPPED 为既有 local-terminal-harness opt-in；本地 scripted provider，不是真实模型 |
| Task 8：Python 依赖/语法/pytest/应用反馈 UI 与旧 Java 展示 | PASS：Vitest 155；backend 45（均 0 failure/error/skip）；frontend typecheck exit 0；浏览器七个状态实际点击，0 page error / 0 model calls | [ToolResultView.test.tsx](../../../frontend/src/features/ai/ToolResultView.test.tsx)、[AgentTaskPanel.test.tsx](../../../frontend/src/features/ai/AgentTaskPanel.test.tsx)；提交 `7dae8c2`，独立复审无 findings；fixture UI 不计云闭环 |
| Task 9：环境拒绝、专用项目写前保护、证据判定 | PASS：初始 RED 5 failed / 0 passed → GREEN 5 passed；复审补 FastAPI 日志回归 RED 1 failed / 5 passed → 最终 GREEN 6 passed，0 skip；独立 tsc exit 0 | [纯函数合同测试](../../../frontend/scripts/ai-python-contract.test.ts)，直接调用同一验收函数，无源字符串断言、无服务/模型 |
| Task 9：console/FastAPI 初始 fixture 可诊断性 | PASS：console 实际 pytest exit=1，1 test/1 failure/0 error；FastAPI exit=1，2 tests/1 failure/0 error，健康测试通过；容器副本修复后分别 exit=0，1/2 tests 全通过 | [fixture 检查脚本](../../../frontend/scripts/ai-python-fixture-check.py)；真实固定 launcher/uv，不是 Agent 自动修复证明 |
| 最终联合 worker / frontend 检查 | PASS：worker 全量 266 passed / 1 skipped + build；frontend 155 passed + typecheck | worker 跳过项为既有 opt-in local-terminal-harness，明确 SKIPPED；前端覆盖四份相关测试。均在最终版本参数修正之后执行，之后仅 backend 构建结算修复和文档变更 |
| 最终九套 backend 兼容检查 | PASS：86 tests，0 failure/error/skip | task store/reconciler、worker HTTP、内部安全、会话/压缩、图片真实装配/HTTP与 live output HTTP；首次装配 fixture 缺新 bean 导致 1 error，`bfeb47e` 仅补真实 fixture 注册，之后九套完整重跑 86/86；该兼容组之后的构建结算变更另由最终 149 组覆盖 |
| 发布 artifact、运行库 V20、云端旧 workspace 更新/备份/回滚 | NOT_RUN | [发布手册](../../../deploy/ai-python-environment/README.md)；本地 image ID 不是已发布 RepoDigest |

Task 9 的本地 fixture 实测 image ID 为 `sha256:ba7752aab64e25edc8ae6d3541963f983dc1024a85fad90e54ad9c8799013879`（Task 5 最终 runtime-test，Python 3.13.15 / uv 0.11.6）。console syntax 2 files；FastAPI syntax 3 files（真实模板的 `app/__init__.py` 在内）。使用 `uv add --group test pytest [httpx] --no-sync --no-build` 生成 lock，测试时真实 locked sync；没有手工编辑锁。该次输出 lock hash：console `87b756eb71dd55830cbc618553186bd5451a76ef702d56e4f1e5ef8bc9956c6a`；FastAPI `d74e58cbd3ee7a10d29d4fe0bee5f268e7c1606d9cfaee8ebce10ce2ffa0d2ab`。后续在线解析可能产生新版本/hash，应记录该轮真实值。

初次 harness 以默认非 root 用户 copytree 到 tmpfs 根时遇 chmod 权限错误；改为只在隔离容器的 tmpfs 中用 root 准备 fixture。首次 FastAPI 又因 Docker tmpfs 默认 noexec 无法映射 pydantic native wheel而 collection error；显式 `exec` 后实测产生业务断言失败，副本修正后全过。两次 harness 失败不算产品失败或 passing fixture 证据。源 fixture bind mount 始终 readonly，固定镜像/root-owned launcher 未改；无命名 volume。最终该 session label 容器 inventory 为 0。

Task 8 的实际本地浏览器截图：[syntax](ui/syntax.png)、[pytest](ui/pytest.png)、[failed](ui/failed.png)、[no tests](ui/no-tests.png)、[skipped](ui/skipped.png)、[unknown](ui/unknown.png)、[no source](ui/no-source.png)。它们来自七次真实 UI 点击，但 API 使用本地 fixture，未调用模型，不证明真实部署闭环。

## 2. 设计验收矩阵

当前逐项结论如下；再下方旧表是本地交付快照，不用旧NOT_RUN覆盖本轮已取得的证据。

| 编号 | 当前结论与定位 |
| --- | --- |
| E1 | PASS：四模板可信快照/权限/重试合同本地回归；四模板真实工具链及新任务环境实测 |
| E2 | PASS：新旧会话、手动compact、最新worker真实SDK threshold832959→34947后同task及新task继续 |
| F1 | PASS：两Python根/包/测试真实读改；托管文件及禁止路径后端策略回归，内部路径实测拒绝 |
| D1 | PASS：两闭环main/test依赖及增删往返，原操作两文件/revision/receipt对齐 |
| D2 | PASS：[八个限定依赖故障样本](dependency-faults-20261105.json)，保留计数窗口/claim间接证据限制 |
| B1 | PASS：真实Python固定launcher/image/cache/source只读；40源文件/fixture前后SHA、revision88不变 |
| B2 | PASS：真实语法失败/断言失败/NO_TESTS/SKIPPED/缺pytest/坏缺截断报告/自然601秒DeadlineExceeded/取消；UNKNOWN保持未知 |
| L1 | PASS：普通Python真实fail-first/修复/依赖/pytest/exit0输出6→10及再次运行 |
| L2 | PASS：FastAPI修复后完整连续两轮、READY/日志/同Run业务GET，当前保留Run公网200 |
| L3 | PASS：两场景main/test COMMITTED，验证sourceRevision与Run revision/锁摘要对齐 |
| R1 | PASS：最新Java两模板/图片上传重读/历史/接管继续/结束/receipt及资源闭合；预算完整耗尽未承诺 |

以下旧表为2026-11-04本地交付时的历史待办快照，当前状态见上表及最终证据。

| 编号 | 本地已证明 | 当时真实部署/模型仍需证明 | 当时真实状态 |
| --- | --- | --- | --- |
| E1 | 四模板事实、摘要/快照/重试、错误环境拒绝、可信工具权限 | 同一发布下新任务与旧历史的实际环境，记录 digest/source SHA | NOT_RUN |
| E2 | 实际 Pi SDK 请求边界含当前环境，历史 Java 和压缩不恢复旧 loadout | 两场景新会话、已有会话、一次实际 compact 后继续；自动压缩若未触发保持 NOT_RUN | NOT_RUN |
| F1 | Python 根目录/包/tests、hash/revision；托管文件只读、禁止路径拒绝 | 两场景原模板 seed、模型实际修改源码，第一轮测试字节不被弱化 | NOT_RUN |
| D1 | main/test add/remove、last removal、真实 uv lock/sync及 revision/changedPaths | L1/L2 各发生一次 main/test COMMITTED，运行与同一锁一致 | NOT_RUN |
| D2 | 真实双文件中断与丢回包组合；模拟传输下 prepare/PENDING/commit 边界 close/pause/restart 保留原身份 | 在专用项目实际中断/重启/取消，无重复解析、未决 operation 或残留 build Job/Pod | NOT_RUN |
| B1 | 真实固定 Python runner、manifest 隔离、源码字节不变、无 Maven | 同一发布 actual Job imageID/cache/mount/源码 hash | NOT_RUN |
| B2 | 语法错误、断言失败、NO_TESTS/SKIPPED、缺 pytest、坏/缺/截断报告、超时/取消；事实持久化后清理 | 实际部署故障与原 Job/Pod UID、终态证据/资源不存在核对 | NOT_RUN |
| L1 | 有真实可失败 console fixture 和严格验收脚本；无本地模型闭环声称 | 真实模型 fail-first → 修复 → test/main 依赖 → syntax/pytest → console exit=0/日志 → 第二轮 | NOT_RUN |
| L2 | 有真实 FastAPI fixture，health 保持，业务失败可诊断 | 真实模型同样闭环，firstReadyAt、实际 GET 200/精确 JSON → compact/第二轮新 Run | NOT_RUN |
| L3 | scoped uv 与 locked test/runtime 的本地真实证据 | 两场景各 main/test operation IDs、前后 TOML/lock摘要、验证 revision=Run revision | NOT_RUN |
| R1 | 本地 Java 兼容与 worker 图片/历史/预算/控制/receipt 回归，范围由各任务报告限定 | 同一发布 Java console/Spring Boot 的真实 smoke、图片与暂停/接管/结束、资源闭合 | NOT_RUN |

`PASS`只在对应层级和场景内有效；SKIPPED/NOT_RUN不补成PASS。`--list`只证明发现、tsc只证明类型、模型“完成”不证明运行成功。上述旧表记录时没有云端身份；当前真实release tuple、provider/model及task/tool/operation/Run身份在各轮JSON，不能倒填或捏造。

Task 9 复审修正：FastAPI 必须同时具备 start/status 的 ready Run、同 Run/同验证 revision 的成功 `application.logs`，以及该 Run 的业务 GET。日志文本非空且不超过 native 64 KiB，有效 first/last sequence，truncated 必须为明确布尔值；允许真实有界 tail 的 `truncated=true`，不把它说成完整历史。RUNNING 日志的 `complete=false` 是实际工具合同，不能要求终态完整日志。缺日志、错误 Run/revision、工具 error、失去源、坏游标/标志或超长文本均失败。部署手册的 image guard 同时允许 `registry.example:5000/repo@sha256:<64hex>`；本地 literal PowerShell 校验 3 个合法引用接受、4 个 URL/凭据/空白/浮动引用拒绝，未执行 rollout。

## 3. 已准备的真实验收脚本

[独立配置](../../../frontend/playwright.ai-python.config.ts) / [两场景 spec](../../../frontend/tests/e2e/ai-python.spec.ts)。五个环境变量全部必填：`MANAO_AI_ACCEPTANCE_BASE_URL/USERNAME/PASSWORD`、`MANAO_AI_PYTHON_CONSOLE_PROJECT_ID`、`MANAO_AI_PYTHON_FASTAPI_PROJECT_ID`。缺失在浏览器启动前 fail，只列 names，不回退 localhost/默认项目；无 webServer、自动重试或模型替代。

写前通过 owner API 检查指定 UUID、`ai-python-acceptance-*` 名称、READY、runtime template，无 current task/active Run/pending dependency，并对 exporter 的完整原模板文件集和字节做一致性检查。不满足就停止，避免覆盖共享或已经运行过的项目；脚本不重置项目、不删除资源。fixture 准备只走原 entries/content API；模型依赖只走 controlled python_dependencies。锁来自真实模板 exporter（已由固定 uv 生成），缺失则失败并先由操作者调查/bootstrap，不在验收中补写。

两场景先受控 seed 一个约 100 KiB 的无秘密 ASCII `.txt` 数据文件并要求模型完整读取，使 native compact 有超过近期保留尾部的历史。第一轮分别添加 `pytest` / `pytest+httpx` 到 test，实际得到断言 FAILED，再添加 `rich` / `humanize` main 依赖并修复、compile/test 后运行；第一轮测试必须与 fixture 完全一致。console 检查完整日志一行 `6`、SUCCEEDED 和 exit=0；FastAPI 检查同 Run 的 firstReadyAt 与 `/api/demo` 200 和精确 JSON。显式手动 compact COMPLETED，原会话历史不丢，再同会话新 Task 改成 `10` / `2,000` 并重跑。两轮实际点击历史工具结果检查 Python 语法/测试与依赖组展示，最终工作区 revision 必须与 pytest/Run 一致。证据附件含 identity/revision/hash 和有界 owner-safe tool 结果，关闭 trace/screenshot/video；provider 原始 trace/密钥不得归档。

局部合同检查：

```powershell
pnpm -C poc4/frontend test:ai-python:contract
pnpm -C poc4/frontend typecheck:ai-python
```

本地 fixture 检查需已有 Task 5 的固定 runtime-test 镜像，以下在仓库根执行；脚本只在容器 tmpfs 副本修复，仓库 fixture 不变：

```powershell
$fixtureRoot = Join-Path (Get-Location) 'poc4/frontend/tests/fixtures/ai-python'
$fixtureCheck = Join-Path (Get-Location) 'poc4/frontend/scripts/ai-python-fixture-check.py'
$fixtureImage = 'sha256:ba7752aab64e25edc8ae6d3541963f983dc1024a85fad90e54ad9c8799013879'
foreach ($fixtureKind in @('console','fastapi')) {
  docker run --rm --user 0 --label manao.session=ai-python-task9 --read-only --tmpfs /workspace:rw,exec,mode=1777 --tmpfs /tmp:rw,exec,mode=1777 --tmpfs /python-cache:rw,exec,mode=1777 --mount "type=bind,source=$fixtureRoot,target=/fixtures,readonly" --mount "type=bind,source=$fixtureCheck,target=/test.py,readonly" --entrypoint python3 $fixtureImage /test.py $fixtureKind
  if ($LASTEXITCODE -ne 0) { throw 'Fixture quality check failed' }
}
```

## 4. 真实非 happy-path 与回归清单（尚未执行）

这些步骤属于未来授权窗口，不能把本地故障 fixture 或老云端结果升级为本次真实 PASS。每项必须先记录 owner/project/task/tool/operation/Run、原请求 digest、文件前摘要、Pod/Job UID；不在未知 mutation 后重试写入，也不复制生产凭据。没有部署该 fault 的证据时保留 NOT_RUN，禁止添加测试专用生产默认行为来冒充实际故障。

| 场景 | 复现边界与收尾证据 | 当前 |
| --- | --- | --- |
| dependency commit 回包丢失 | 在专用项目真实 commit 已产生 receipt 后只丢响应；同 operation/digest 观察/恢复，不再次 uv prepare；revision 仅增一次，两个 changedPaths，task pending/claim 清零 | NOT_RUN；本地真实组合已 PASS |
| PENDING backend/agent 重启 | 先确认持久化 PENDING 和 journal/原身份，再受控重启；恢复原 operation，两个文件摘要匹配 receipt；不得创建第二次解析或直接解锁 | NOT_RUN；本地重建实例已 PASS |
| prepare / PENDING 注册 / commit 边界暂停/取消 | 每个独立 disposable task 的 latch/故障点单列；注册前不 commit，注册后对账原 receipt；端到端结算释放写锁，无 task pending | NOT_RUN；本地边界矩阵已 PASS |
| pytest 超时/取消及 Job DELETE 不确定 | 运行明确长测试，记录取消请求与实际期限；同 Job/Pod UID 观察，报告缺失 UNKNOWN，取消不可变 PASS；无原 task 的 build Job/Pod，再次新 task 可用 | NOT_RUN；本地容器取消/UID矩阵已 PASS |
| Java console 和 Spring Boot 两模板 smoke | 同发布的可信 Java tools/compile/test/package，console exit/日志；service readiness/业务 HTTP；不能由 Python 两场景替代 | NOT_RUN；[既有 Java E2E](../../../frontend/tests/e2e/java-runtime-lifecycle.spec.ts)仅为后续执行入口，其创建/端口/删除范围另核对授权 |
| 图片、历史、暂停/接管/结束 | 复用现有本地图片 UI/worker tests；真实场景记录同 build/provider 和 task，无需每个 Python 场景上传图片 | 本地旧回归范围见 Task 7/8；本次真实 NOT_RUN |
| 资源与数据 | owner/project 精确范围；无 pending/live claim/build Job/Pod；成功 FastAPI Run、项目/PVC、receipt 的保留与删除分别记录 | NOT_RUN；脚本刻意保留项目与 FastAPI Run供核对 |

最终授权发布后，在本页补同一 reviewed SHA、四运行产物与 frontend 的 registry/imageID、实际 namespace/schema/V20、旧 workspace 更新与 PVC 保留、真实 provider/model 非秘密标识、两 Python 场景附件、Java/恢复/清理结果；全部必需项闭合才写 `AI_PYTHON_CLOSED_LOOP_PASS`。当前不运行真实配置或外部模型，不向共享项目注入故障，不执行部署/迁移/回滚。
