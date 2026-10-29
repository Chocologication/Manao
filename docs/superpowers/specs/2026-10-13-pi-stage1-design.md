# Pi 第一阶段设计：真实读改测与失败修复

日期：2026-10-13 编制，2026-10-14 自审修订。状态（2026-10-15 整分支审查修复后更新）：本文件是第一阶段实施计划的**设计基线**（编制时的"未实现、未部署、未验收"为历史快照，不再描述当前状态）。当前实施状态：Tasks 1–6 已在 `codex/ai-integration` 实现并通过任务级审查；最终整分支审查发现的跨接缝问题（1 Critical + 10 Important + 1 Minor）已修复并提交。真实验收状态：真实模型闭环、浏览器 E2E、云端 rollout 与 CNI enforcement 均 NOT_RUN，`PI_STAGE1_CODE_TEST_LOOP_PASS` 未授予。实施与验收边界以[实施计划](../plans/2026-10-13-pi-stage1-implementation-plan.md)与[实施记录](../../../poc4/docs/evidence/ai-stage1/acceptance.md)为准。

依据：[已确认决定](../../research/2026-10-13-ai-integration-framework-evaluation.md#10-最小集成设计的已确认决定2026-10-13)、[四阶段拆分](../../research/2026-10-13-pi-minimal-integration-implementation-slicing.md)。工作目录 `.worktree/ai-integration`，分支 `codex/ai-integration`，当前代码基线 `ef852b7`；未提交的拆分文档与索引属于本轮规划，应保留。

## 1. 交付目标与阶段范围

用户在浏览器输入一个 Spring Boot 项目修改目标，Pi 通过真实文件工具修改当前项目、运行 Maven 构建测试、读取失败结果并继续修复。用户看到实际修改的文件、构建结果及 Pi 总结。

本阶段采用一个没有重要既有数据的专用验收项目、单 Agent、单后端实例、单 Pi worker，不新增调度队列。后端配置明确启用的验收项目 ID，其他项目不开放任务入口。任务开始要求项目 READY、无 active Run、无 PENDING 文件／依赖操作、已保存且前端没有未保存内容。前端条件只是体验保护，后端仍独立校验可核实的状态及保存版本。

新增代码的实施语言可以是 TypeScript；此前跳过的是 Go/TS **用户项目运行时适配**，不禁止 Pi worker 使用 Node.js/TypeScript。

本阶段不提供应用 Run 自动停启、HTTP CRUD 验证、数据库工具、自由 Shell、删除／重命名工具、暂停后接管、异常后继续任务。它们分别属于后续阶段；不是取消已确认的最终目标。遇到 active Run 提示用户先停止。普通源码读写及固定构建命令自动；未提供的高风险操作直接拒绝，不为首阶段建设审批平台。

## 2. 最小 Module 与 Interface

| Module | 对调用者的 Interface | 隐藏的 Implementation |
| --- | --- | --- |
| `AgentTaskService` | 创建、查询、结束任务；接收 worker 已完成消息和终态 | owner/project 校验、任务占用、worker 启动结果核对、限额、持久进度、结束前收尾 |
| `AgentProjectTools` | `invoke(taskId, toolCallId, name, args)` / `getCall(taskId, toolCallId)` | 当前版本、路径规则、去重、文件 receipt 与构建执行；模型不指定 owner/project |
| `DevelopmentBuildExecutor` | `execute(BuildRequest)` / `observe(BuildRequest, BuildIdentity)` / `close(BuildRequest, BuildIdentity)` | 只读源码复制、Job 身份、真实退出结果、受限日志、Pod 清理；提供 Fabric8 Adapter 与测试 Adapter |
| Pi worker | `start(task)` / `status(taskId)` / `stop(taskId)` | SDK 会话、受控资源加载、自定义工具、发送进度；不运行用户 Shell 或 classpath |

不新增通用 provider registry、workflow、审批微服务、消息队列或事件总线。任务和项目工具可以各有少量内部文件，但不为每一步模型思考建立 Module。文件保存继续复用 `WorkspaceOperationService`。

## 3. 任务与操作记录

仅新增 Flyway V11 中两张表：

- `agent_task`：`id, project_id, owner_id, request_sha256, prompt, state, worker_instance_id, worker_epoch, workspace_revision, progress_json, summary, failure_code, created_at, updated_at`。`id` 是浏览器首次提交前产生的 UUID；同 ID 同请求返回原任务，同 ID 异请求返回 409。生成列 `active_project` 在 QUEUED/RUNNING/NEEDS_ATTENTION 时为 project_id，其他为 NULL，加唯一索引限制一个项目一个任务。
- `agent_tool_call`：`task_id, tool_call_id, request_sha256, tool_name, args_json, state, workspace_operation_id, expected_revision, result_json, job_name, job_uid, pod_uid, created_at, updated_at`。主键 `(task_id, tool_call_id)`；结果和参数均有大小限制。文件写入预先分配 UUID operationId，构建 Job 名由该行的稳定身份推导。

状态只有 QUEUED、RUNNING、COMPLETED、FAILED、NEEDS_ATTENTION。COMPLETED 表示 Pi 本次执行结束且工具已收尾，不代表完整 CRUD 或用户验收通过。编译／测试 exit!=0 是工具结果，正常返回 Pi 修复，不立即把任务 FAILED。预算耗尽或模型明确失败记 FAILED，前提是远端执行和文件操作均已确认结束。结果不明记 NEEDS_ATTENTION 并保留占用。

工具记录状态 REGISTERED、RUNNING、COMPLETED、NEEDS_ATTENTION。重复同 ID 先比较请求摘要：已完成返回原结果，未决先查询既有执行；不能重新生成 operationId 或 Job。异参返回 `AI_CALL_MISMATCH`。已登记调用遇到确定无副作用的 sha/revision 冲突或参数拒绝，记 COMPLETED 并持久化 `data.error={code,message}`；worker 将该错误反馈 Pi，允许下一调用重读，不把确定拒绝留成未决锁。重放文件写入必须先查既有 workspace_operation 再计算 before digest，避免把已经应用的修改当作新写入。

任务进度仅保存完整消息、工具开始／结束和终态，保留最近 100 项，每项最多 8 KiB，并返回截断标记；完整对话写到 worker 私有会话目录。progress_json 同时保留独立 lastSeq/lastPayloadSha，不随显示裁剪丢失。同 seq 同内容幂等，异内容拒绝，序号缺口返回期望 seq，不丢弃事件。工具结果 JSON 最多 192 KiB，其中构建输出最多 128 KiB，文件内容最多 128 KiB；构建输出截断不能误报为完整日志。不逐 token 写数据库。

## 4. 四个项目工具

所有工具 `executionMode=sequential`，worker 同时设置全局串行工具执行。工具入参只表达项目操作，taskId、当前保存版本、内部凭据由 worker 注入，不能由模型任意改写。

```typescript
type ToolName = 'list_files' | 'read_file' | 'write_file' | 'build';
type ToolArgs =
  | { directory: string }
  | { path: string }
  | { path: string; content: string; expectedSha256: string | null }
  | { goal: 'compile' | 'test' | 'package' };
type ToolResult = {
  toolCallId: string;
  workspaceRevision: string;
  data: unknown;
  truncated: boolean;
};
```

- `list_files` 复用目录接口，单次最多 200 条，返回 `hasMore`；Pi 可分目录浏览，不新增全文索引。
- `read_file` 返回 UTF-8 内容与 sha256，最多 128 KiB；拒绝二进制、内部目录、超限文件。
- `write_file` 直接保存真实项目文件，最多 128 KiB。已有文件要求 expectedSha256 匹配读到的版本，新文件传 NULL 并校验不存在。workspace-agent 的 `SAVE` 可创建文件及父目录；后端现有 digest 计算遇到 meta 404 会拒绝，需要在 AI 保存入口明确支持“已核对不存在”的 absent digest，不改变普通文件接口的既有语义，不先 CREATE 空文件再 SAVE。返回新 revision 和 sha256。同文件旧 sha256 冲突返回可解释错误供 Pi 重读。
- `build` 只接受上述三个 goal，无任意 argv、环境、镜像、工作目录或 Shell 字符串。服务端生成 `/usr/local/bin/manao-maven -B -ntp <goal>`。返回 goal、源 revision、exitCode、terminationReason、输出、truncated、cleanupConfirmed。没有 exitCode 时不得填 0。

工具层复用现有路径规则，并额外禁止访问 `.git`、`.manao*`、任何 `target`、凭据文件及工作区外路径。阶段验收只使用 `pom.xml`、`src/**`、普通文本说明文件；允许列表由可信代码固定，不从项目配置或提示词加载。该限制不修改普通浏览器文件功能。

## 5. 直接改源码，只读源码副本构建

Pi 始终通过文件工具修改当前项目。这一选择不改变用户已确认的直接修改体验。**临时目录只用于一次构建**，不是 Agent 工作副本，不存在差异回写。

新增可信、root-owned 的 `manao-dev-build` 到现有 Maven runner 镜像：

1. 固定 init container 只读挂当前项目源码 subPath 到 `/source`，临时 emptyDir 挂 `/workspace`。复制普通文件／目录，排除所有 `.manao*`、`.git`、`target`；拒绝 symlink、FIFO、设备文件等，限制 1000 个文件、20 MiB 源码总量。不执行项目内复制脚本。
2. 执行 container 只挂 `/workspace` emptyDir、项目私有 `/maven-cache` 与 `/tmp`，**不挂 `/source` 或源码 PVC 根目录**；复用原缓存准备与 `manao-maven`，固定 UID/GID 10001、安全上下文及资源限制。
3. Job `Never`、`backoffLimit=0`、parallelism/completions=1，禁 ServiceAccount token、无 hostPath/socket/平台凭据／模型密钥。阶段 1 不注入项目数据库凭据。用户 Maven 插件和测试只能在执行 container 中运行。
4. 构建代码即使写文件也仅影响 emptyDir 和项目缓存，不修改保存源码，revision 不变。下一次构建重新复制最新保存版本。
5. root-owned launcher 保留 Maven 真实退出码，在退出前将有界 Surefire XML 以固定标记附到日志尾部；后端从尾部解析报告摘要（总量最多 64 KiB，禁外部实体），与构建输出分开保留。报告缺失为缺失，不能推算通过。这样即使 Pod 已完成，也无需对终止容器 exec 取文件。先核对 Job/Pod 身份、收集退出结果、报告和受限日志，再删除 Job；确认 Job 不存在且关联 Pod 全部不存在，才将调用结算并允许下一次文件写入／构建。失败退出也执行清理。Unknown/Forbidden/身份不匹配不作为删除完成。

开发 Job 必须有项目及 toolCall 对应身份标签，使用专用 `development-build` component 值，不伪造应用 Run。加入项目资源清理识别。执行网络仅允许 DNS 与构建依赖下载所需的公网 HTTP/HTTPS；拒绝平台、worker、Kubernetes 管理面、其他项目及私有／元数据网段。以实际 CNI NetworkPolicy 执行能力验证，不能只以清单存在记隔离通过；本阶段无需开发网络策略引擎。

默认 task 1800 秒、单 build 600 秒、收尾 120 秒、最多 60 次工具调用／8 次构建。服务器可以降低上限；不允许模型增加上限。资源复用已有 Java runner 服务器策略。源码复制或挂载失败属于工具失败，明确报告，不在空目录中继续并误报成功。

2026-10-18 预算补充：用户明确授权将工具/构建次数提高至 `180` / `20`，覆盖上一段历史次数；task/build/收尾时限不变。当前实施、测试与发布由 [任务预算记录](../../../poc4/docs/evidence/ai-task-budget/acceptance.md) 拥有，模型仍不能自行提高预算。

## 6. 占用、通信与异常

现有 `ProjectLifecycleGate` 仍只保护短操作。持久任务占用不能通过长时间持有线程锁实现。提交任务、注册文件写／构建及其他项目写入口，在同一个共享 gate 的短临界区读取同一持久占用。`AgentTaskService` 必须持该 gate 才调用 store.create，不能只给旧写入口加检查；数据库事务同时锁项目行，串行化任务登记与其他写入登记。

至少覆盖普通文件四种 mutation、Python 依赖 change/changeBatch/reconcile、Run.start、项目删除及适用的恢复写入口。只读接口仍可用，PENDING 文件操作沿用现有拒读行为。AI 文件写入带可信 taskId 身份，不能为绕锁开放无鉴权 `applyInternal`。阶段 1 active Run 拒绝任务，任务占用期间 Run.start 拒绝。

浏览器接口：

```text
POST /api/v1/projects/{projectId}/agent-tasks
  { taskId, prompt, expectedWorkspaceRevision }
GET  /api/v1/projects/{projectId}/agent-tasks/current
GET  /api/v1/projects/{projectId}/agent-tasks/{taskId}
POST /api/v1/projects/{projectId}/agent-tasks/{taskId}/close
```

`close` 仅结束当前任务并清理开发执行，保留实际源码修改；不自动恢复旧代码、不等同阶段 4 的暂停与继续。先在后端共享 gate 内持久转 NEEDS_ATTENTION/AI_CLOSING，保留占用并拒绝新调用登记；已登记调用只允许核对／收尾。随后令 worker 停止，已有构建 Pod 消失且文件回执核对完成后，CAS 到 FAILED/AI_CLOSED 并释放占用。迟到的 start ACK、进度终态不能覆盖 closing 或抢先释放。文件状态仍不明时保留 NEEDS_ATTENTION；本阶段不假设现有通用 reconcile 能解除所有 FAILED 文件场景。

Spring 向 worker 发 `POST /tasks/{taskId}/start`，worker 立即接受后异步 `session.prompt`；重复同 ID 同请求幂等，已有其他任务返回 409。`GET /tasks/{taskId}` 用于启动响应丢失的核对，`POST /tasks/{taskId}/stop` 中止 SDK，不单凭 abort 结果释放占用。

worker 通过后端 `/internal/ai/tasks/{taskId}/calls/{toolCallId}` 提交／查询工具，通过 `/internal/ai/tasks/{taskId}/progress` 提交单调 seq 的完整消息及终态。发送 start 前先持久 worker epoch；带正确 token/epoch 的首个 callback 或 start ACK 原子绑定 instance，后续必须一致；callback 可以早于 ACK，迟到 ACK 不得倒退任务状态。后端从 task 反查 owner/project，不信任模型入参。内部路由必须有独立 SecurityFilterChain 且未配 token 时关闭，不能简单放进 permitAll；浏览器 JWT 不能调用内部工具。

浏览器断开不会取消任务。单实例更新避免新旧 worker 重叠；后端／worker 重启后，未决任务保留或转 NEEDS_ATTENTION，禁止自动重新调用模型或执行工具。用户可查询并请求 close 核对收尾；手动继续同一任务留到阶段 4。模型密钥未配置时任务不进入运行；具体 provider/baseUrl/model 通过服务器配置，真实验收前必须明确。

## 7. Pi 与浏览器接入

worker 使用 `@earendil-works/pi-coding-agent@1.2.0`，参考快照 `7d75a0e3`，Node `>=22.19.0`，pnpm `10.33.0`。首次安装先验证该发行版可解析，锁定依赖；包分发不可用时报告而不静默换 SDK。

使用 `ModelRuntime`、`createAgentSession`、`SessionManager.create(workerScratch, privateSessionDir)`、`SettingsManager.inMemory()`。显式受控 ResourceLoader：禁项目扩展、Skills、MCP、AGENTS/SYSTEM/APPEND_SYSTEM 自动发现。worker 不挂用户项目或 Manao 仓库；自定义工具显式 allowlist，禁内置文件与 bash 工具。服务端固定说明目标、工具能力、限制和完成证据，不预写改代码／重试步骤。密钥仅在 worker 环境和 runtime 中。

SDK subscribe 回调不等待异步 listener；worker 用一个 promise 串行链发送持久进度，终态发送前 drain，不能直接在每个 listener 中并行 await HTTP。prompt resolve/agent_settled 后仍检查最终 assistant stopReason、provider error、aborted、预算和工具收尾，错误正常 settle 也应记 FAILED，不能记成功执行。

浏览器在 `WorkbenchShell` 增加 AI 面板，输入目标、启动、进度／构建输出、修改路径、结束任务。先 2 秒轮询后端任务快照，不增加 WebSocket／SSE。启动前 dirty=0 且无 pending mutation；收到任务占用后立即只读。将占用同时传到编辑器、文件树、Run 启动等入口。

文件 revision 增加后在安全节点刷新文件树与已打开内容，复用 `reloadWorkspaceAfterTerminalRun`，正确销毁 Monaco/buffer；刷新期间暂停文件读并卸载编辑器，失败保持只读并允许重试。仅 invalidate query 不足以刷新编辑器模型。切换项目时旧任务响应不得写入新项目 UI。启动 HTTP 响应丢失时用原 taskId 查询，不生成第二任务。

## 8. 验证与完成标准

测试从 Module 的 Interface 观察行为，避免为每层转发各写一套重复测试。后端真实 MySQL 测试使用现有 `JdbcStoreTestSupport` 的 disposable schema，Fabric8 用已有 mock server，runner 用真实 Linux 容器，worker 模型用注入的测试 Adapter；真实云端验收单列。

专用项目只需模板 `DemoController`。独立预置一个 JUnit 测试，直接调用 `demo().message()` 并断言期望消息，不启动 Spring Context，不访问数据库；另设可定位编译错误。自然语言任务要求“先执行测试，修复失败并将 demo 消息修改为约定值，再重新测试”。Pi 必须产生至少一次非零真实 Maven 结果、随后修改源码并取得零退出结果。验收保护预置测试摘要，若 Pi 删除／弱化测试不能记为通过。

阶段 1 完成证据：浏览器提交的目标、taskId、Pi/provider/model/SDK 版本、初末 revision、修改路径及摘要、失败和成功的构建 toolCallId、真实 exitCode／日志／Job-Pod 身份及清理确认、编辑器显示新代码。成功构建和独立复验均须取得验收测试的 Surefire XML，断言 tests>=1、failures/errors/skipped=0；文件缺失不能通过。报告在删除构建 Pod 前取得，独立复验使用验收方控制的测试配置及同一只读-copy executor，避免 pom 改为跳过测试得到假成功。不得以 mocked SDK、编译通过但未跑测试、Pi 总结或测试列表冒充真实闭环。

此证据仅称 `PI_STAGE1_CODE_TEST_LOOP_PASS`；不称 CRUD、MySQL 持久化、完整 AI 首版或用户业务验收通过。模型配置、Docker、MySQL 或集群不可用时分别记录 BLOCKED/NOT_RUN，并完成不依赖它们的实现和本地验证。发布现有云环境属于单独操作，先准备清单和证据，不自动修改现有部署。
