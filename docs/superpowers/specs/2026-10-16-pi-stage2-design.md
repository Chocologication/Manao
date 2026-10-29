# Pi 第二阶段设计：应用运行与反馈

> 2026-10-18 用户明确将工具/构建预算改为 `180` / `20`，任务总时长仍为 `1800s`；该决定覆盖下文历史 `60` / `8` 值。实施、测试与发布证据见 [任务预算记录](../../../poc4/docs/evidence/ai-task-budget/acceptance.md)。其他约束保持原义，Stage 2 完整验收仍暂停且 NOT_GRANTED。

> 历史设计快照：下文的“尚未实现/仅规划”描述编写当时状态。后续授权的五项实现已审查提交至 `559f998`；当前测试、裁定、清理及真实验收缺项统一由 [Stage 2 实施记录](../../../poc4/docs/evidence/ai-stage2/acceptance.md) 拥有。原范围与规划历史保留，不能据本设计宣称云端阶段 PASS。

日期：2026-10-16。状态：设计与实施计划，尚未实现第二阶段。本轮仅授权规划与交接，不启动模型任务、不部署、不操作运行资源。

依据：[已确认决定](../../research/2026-10-13-ai-integration-framework-evaluation.md#10-最小集成设计的已确认决定2026-10-13)、[四阶段拆分](../../research/2026-10-13-pi-minimal-integration-implementation-slicing.md)。配套：[实施计划](../plans/2026-10-16-pi-stage2-implementation-plan.md)、[实施提示词](../plans/2026-10-16-pi-stage2-agent-handoff.md)。

## 1. 结论与范围

第二阶段只接通这条路径：已有应用运行 → Agent 取得项目写入占用 → 停止旧 Run 并确认退出 → 修改与构建 → 创建新 Run → 观察状态、日志和 HTTP → 根据真实错误修复并再次创建 Run。Pi 决定具体步骤；后端执行必要前置条件，不新增固定工作流。

第一阶段已经取得 `PI_STAGE1_CODE_TEST_LOOP_PASS`，证据由[第一阶段实施记录](../../../poc4/docs/evidence/ai-stage1/acceptance.md)第 8 节拥有；本次只核对记录，没有重新运行该验收。该记录的 §8.7 还记载了后续 revision-cache 修复：本地回归与部署完成，但部署后的浏览器点击路径未复验。这一限制不撤销此前闭环 PASS，也不能被写成新版本已获完整 PASS。

第二阶段不是书籍 CRUD/MySQL 业务验收，不提供 SQL、自由 Shell、暂停接管、手动续跑、多 Agent、MCP/Skills 平台。HTTP 首先只提供 GET；这是满足本阶段反馈目标的实现收敛，不是取消第三阶段写请求。

## 2. 工作基线

- 实际工作树：`.worktree/ai-integration`，分支 `codex/ai-integration`。第二阶段实施代码基线为 `b2c6ec384e2b0ed4af2019140504f74417147084`（短 SHA `b2c6ec3`，2026-10-16）。该提交已包含原有 revision-cache 修复、部署/验收文档及第二阶段规划；后续仅同步基线的文档提交不改变此代码基线。主检出 `master@49eb632` 没有第一阶段代码。
- 此前待提交的 AgentTaskPanel/fileQueries/workspaceReload 源码与测试、第一阶段部署/验收文档和 revision 修复计划均已纳入 `b2c6ec3`；实施时保留这些已提交能力，不再按未提交补丁搬运。
- 实施先记录实际 HEAD/diff，确认 HEAD 包含 `b2c6ec3`；如果届时又有新修改，保留并区分其范围。沿用该工作树，不从旧 master 重新实现 AI；如确需新工作树，按 using-git-worktrees 的规则从包含此代码基线及最新计划的提交创建。
- 第一阶段验收项目已删除，部署仍绑定旧 projectId。真实第二阶段验收需要新的专用 Spring Boot 项目和明确配置；不复用已删除 ID，不自动扩大到全部项目。

## 3. Global Constraints

下列值是本阶段统一约束，实施计划逐字引用。

- 仅一个显式启用的专用 Spring Boot 项目、单后端、单 Pi worker；任务直接修改真实项目，Agent 期间独占写入。
- Pi SDK 固定 `1.2.0`，Node `>=22.19.0`，pnpm `10.33.0`；Java `17`、Spring Boot `3.5.9`、Fabric8 `7.7.0`；不升级依赖，不引入新运行框架。
- 任务 `1800s`、最多 `60` 次工具调用、`8` 次构建；新增最多 `4` 次 application/start。每次 status/stop 等待 `0–10s`，轮询间隔 `2s`，不得跨等待持有 ProjectLifecycleGate。
- 沿用构建 `600s`、收尾 `120s`、文件 `128KiB`、工具结果 JSON `192KiB`、进度最近 `100` 项且每项 `8KiB` 的既有限额。
- 应用日志只返回最近 `64KiB` UTF-8 文本；HTTP path 最多 `2048` 字符，GET 连接 `3s`、请求/读取总计 `10s`、响应最多 `64KiB`，禁止自动重定向、自动重试、任意 host/port/header/body。
- 应用继续使用现有 Job + Service、原用户端口及 `7200s` ready 后寿命；不自动换端口、不引入 Deployment、不做基础设施自动重启。
- 不新增表、Flyway migration、任务状态、消息队列、事件总线、workflow/provider registry；复用 agent_task、agent_tool_call、run 和持久日志。
- 普通浏览器 start/stop、文件/依赖变更、删除继续受到 Agent 占用检查；文件写入和 build 在任何 active Run 存在时均拒绝。
- 模糊副作用先查询原 task/toolCall/run/receipt；不生成新身份重试。UNKNOWN、Forbidden、身份不匹配和超时不能证明应用已退出。
- 模型配置和密钥只在 worker；worker 不访问用户文件系统、不执行用户代码、不获取平台或集群凭据；保留现有受控资源加载与工具 allowlist。
- 后端数据库测试仅用 disposable schema，禁止重置 manao_poc4 或 manao_poc4_6b；前端/worker 只用 pnpm，生成文件 UTF-8 无 BOM，shell/Docker 入口 LF。

## 4. Module、Interface 与 seam

保留 `AgentProjectTools.invoke(taskId, ToolRequest)` 作为唯一工具 seam。增加 concrete `AgentApplicationTools`，把 Run 身份、调用结果、日志和收尾规则集中在一个 Module 中；`AgentProjectTools` 只负责既有登记/派发/有界结果。增加 concrete `ProjectApplicationProbe`，隐藏项目 Service 身份与受限 HTTP IO。

直接注入现有 `RunService`、`RunStore`、`RunLogService` 和 KubernetesClient/HttpClient；不为现有 Module 再各造一层只转发的 Adapter。已有 Fabric8 mock、真实 disposable MySQL 和本地 HTTP server 足以测试 seam。

`RunService` 新增可信的内部 agent start/stop Interface，复用原 Run 创建和停止 Implementation。公开浏览器 Interface 不接受 taskId、runId 选择器或跳过占用的 boolean。Agent 的授权必须核对持久 task/toolCall，而不是根据方法名默认信任调用者。

## 5. 六个模型工具

原有 `list_files/read_file/write_file/build` 保留；只增加以下两个工具，全部 sequential：

```typescript
type ApplicationArgs =
  | { action: 'status'; runId?: string; waitSeconds?: number }
  | { action: 'start' }
  | { action: 'stop'; runId: string; waitSeconds?: number }
  | { action: 'logs'; runId: string };
type AppHttpGetArgs = { runId: string; path: string };
```

`waitSeconds` 默认 0，整数 0–10；stop 默认 10。status 无 runId 时返回当前 active Run，空为 null；指定 ID 时可以读当前项目历史 Run。stop/logs 必须给出由先前结果得到的 runId，避免响应丢失后把目标悄悄换成另一 Run。模型不能指定 project/owner/revision/image/env/网络目标。

沿用 `ToolResult{toolCallId,workspaceRevision,data,truncated}`。data 固定形状：

```typescript
type ApplicationRunView = {
  id: string; state: string; requestedWorkspaceRevision: string;
  firstReadyAt: string | null; expiresAt: string | null;
  finishedAt: string | null; exitCode: number | null;
  terminationReason: string | null;
};
type ApplicationData = {
  kind: 'application'; action: 'start' | 'stop' | 'status' | 'logs';
  run: ApplicationRunView | null; activeRunId: string | null;
  stoppedConfirmed: boolean;
  logs: null | { text: string; firstSeq: number | null;
    lastSeq: number | null; truncated: boolean; complete: boolean };
};
type AppHttpGetData = {
  kind: 'app_http_get'; runId: string; path: string;
  statusCode: number | null; contentType: string | null;
  body: string; truncated: boolean;
  error: null | { code: string; message: string };
};
```

日志 firstSeq/lastSeq 是返回文本所覆盖 chunk 的序号范围；tail 在 chunk 中截断时设 truncated=true，不承诺可无损分页。complete 只表示 Run 已权威终态、既有历史补全已结算，不表示被截断的文本完整。空窗口、重启后 seq 缺口均不能伪装为完整日志。

启动返回 STARTING 是接受事实；RUNNING 也不等于 ready。HTTP 前要求 Run 仍是 active、state=RUNNING、firstReadyAt 非空，并核对 Service 路由；真实连接/500/404 仍原样作为结果反馈。`COMPLETED` 只表示本次 Agent 已结束，不代表产品/用户验收通过。

## 6. 任务占用与 Run 一致性

### 6.1 带旧 Run 接任务

删除 task.create 对 active Run 的拒绝，保留 READY、owner、revision、PENDING 和其他 AgentTask 检查。取得占用不自动停止应用；Pi 可以先读状态/日志/HTTP，再调用 stop。浏览器的 Run.start 与 Run.stop 都在共享 gate 内检查占用，不能在 Agent 期间改变执行对象。

所有 AI 文件写和 build 在共享 gate 内检查项目无 active Run；底层文件事务原有 active 检查保留。开发 build 从“登记/claim 到结果结算”都阻止 application/start；反向亦成立。复用现有未决调用、执行 claim 和 beginClose 互斥，不能只靠 worker sequential 规避并发。

### 6.2 稳定启动身份

application/start 预登记一个 side-effect UUID，沿用历史列 `agent_tool_call.workspace_operation_id`，作为新 Run 的 runId；该列没有 workspace_operation 外键，无需新表。注释明确它在此处是 Run identity，不把它交给文件 reconcile。

`RunService.startForAgent` 先验证持久 task、project、owner、toolCall、action=start、稳定 runId 和调用状态，再查询该 runId。已有匹配 Run 返回原结果，即使它已经 FAILED/终态；不存在才用最新已核对 revision 创建。已有 Run 的 project/revision 不符则拒绝。Kubernetes 调度仍使用原 ensureJob/RECOVERING 路径；响应丢失只查询原 runId，不发第二次 ensure/create。

call 登记到 Run 插入之间的进程异常：同进程活 claim 不得被 close 越过；重启后只观察原 Run/确定缺失，close 不重放 start。create 与 closing 持久标记使用同一短临界区，不存在“close 先释放后又插入 Run”的窗口。不得从 needs-attention 自动续跑模型。

### 6.3 stop 与等待

`stopForAgent` 只针对 task 所属项目的确切 runId，复用 STOPPING/termination intent。stop 调用最多等待 10 秒，随后返回当前真实状态；仍 STOPPING/RECOVERING 时 stoppedConfirmed=false，Pi 用新的 status 调用继续观察。重放同 toolCall 返回当时持久快照，不伪装成新的观察。

只有目标 Run 已终态且该项目没有 active Run，stoppedConfirmed 才为 true；现有 RunObservationService 已负责 Job/Pod 退出与历史日志补全。不复制状态机、不将停止 HTTP 200 或 Job 404 当作退出。无法确认时 write/build/start 继续拒绝。

### 6.4 结束和异常

- 正常 COMPLETED：所有调用/文件/开发 build 已结算；本任务最后一个应用 Run 若仍在 STARTING/STOPPING/RECOVERING，暂不释放占用，转 NEEDS_ATTENTION。稳定 ready 的当前 Run 可以保留供用户访问；它继续独立锁源码并遵守原寿命。没有创建应用的纯代码任务仍可正常完成。
- FAILED/owner close：先在短锁内持久拒绝新调用，锁外停止并确认**本任务 application/start 创建的 Run**，同时完成原文件/build 收尾，最后短锁重读并 CAS 释放；结果不明保留 NEEDS_ATTENTION 与占用。RunObservationService 需要同一项目锁，不能持锁等待它结算。
- 原应用从未被任务 stop/start 触碰，且启动/模型在前置阶段失败：不顺带终止原应用。任务已登记 stop 原应用时必须完成该 stop 的核对，但不额外创建或恢复旧应用。
- 收尾范围通过持久 application/start 的 UUID 和 stop 的 args.runId 得到，最多 4 个新 Run；不根据“当前 active”盲杀，不扩展到其他项目。
- 失败/close 终态迟到、start 正在插入、HTTP/stop 正在进行等并发，沿用同一 live-call claim/closing 检查；工具真实 IO 尚未退出时不得释放。浏览器断线不取消任务。
- FAILED 的原 terminal report 在已持久化 progress 中保留，closing 后拒绝追加，重试收尾仍读出原 failureCode/summary；不新增 intent 列、不把恢复所需事实只留在内存。

## 7. 日志与 HTTP

日志直接读取已鉴权 Run 的 `RunLogService.windowFor`，尾部限制 64KiB；不另开 worker WebSocket、不取 browser ticket、不直读绕过 UID 核对的 Pod 日志。

HTTP 只访问当前专用项目的主应用端口：从 runtimeSpec 第一条 publicPorts 映射读取端口名；从已验证归属的 `manao-app-<projectId>` Service 取得对应 servicePort/ClusterIP，并核对 selector 的 project/run/pod UID 与 Run.executionPodUid 一致。拒绝 ExternalName、headless/无 ClusterIP、selector 不符、端口不符或无执行 UID；不回退到 NodePort、用户 URL 或其他地址。模型只传相对 path。

path 必须以单个 `/` 开头，保留合法 query；用标准 URI parser 拒绝绝对 URI、authority、`//`、反斜线、fragment、控制字符及解析后改变 origin 的输入。构造最终 URI 后比较 scheme/host/port，不自建多轮解码或通用 URL 策略引擎。固定 GET、Accept 仅 application/json,text/plain,*/*，不转发 Cookie/Authorization，不跟随 Location、不自动重试。返回响应 body 的有界 UTF-8 文本和 content-type，不返回响应 cookie/header 集合。

请求头与 body 的读取共用一个 10s deadline，不能只给“等待响应头”设时限；超过 64KiB 立即关闭流，保留有界前缀并标截断。慢 body、无 Content-Length、超大 Content-Length、异常 UTF-8、TCP reset 都有直接回归。每次请求前后核对同一 Run 仍是 active；执行中停止则返回 `AI_APP_RUN_CHANGED`，不能给另一个 Run 的响应贴原 ID。

固定错误码：`AI_RUN_ACTIVE`（写/build被运行阻挡）、`AI_RUN_NOT_FOUND`（不存在或不属本项目）、`AI_RUN_NOT_READY`、`AI_APP_ROUTE_UNAVAILABLE`、`AI_APP_HTTP_TIMEOUT`、`AI_APP_HTTP_UNAVAILABLE`、`AI_APP_RUN_CHANGED`、`AI_APPLICATION_START_LIMIT`。HTTP 非 2xx 是带真实 statusCode/body 的普通结果；响应超限带 truncated=true。不得复制底层异常中的 URL、凭据或堆栈到模型/浏览器。

GET 在业务上未必无副作用，因此不宣传 exactly-once HTTP。后端对同 toolCall 仅一次发送并缓存；崩溃后 RUNNING 的请求不自动重发，close 等待/确认本地执行结束后结算未知结果。第三阶段非 GET 的幂等与业务核对另行设计。

## 8. 浏览器和真实验收

沿用两秒任务轮询和现有 RunPanel/RunLogTransport，任务占用期间允许查看，start/stop按钮禁用；AI 入口移除 active Run 拒绝，但仍要求已保存、版本已知、无 pending、无其他任务、无重载失败/未知 Run authority。显示 application/HTTP 的实际结果，不新增看板、任务状态或 SSE。

AI 面板按 tool_end 的 toolCallId 读取既有 owner-scoped tool result；扩展浏览器结果 allowlist，显式投影 Run 状态、日志、HTTP status/body/error/truncated，不把全部内部 data 直接穿透。body/log 按文本渲染，不使用 dangerouslySetInnerHTML。源码刷新沿用当前 revision-cache 修复；任务结束仍有 Run 时只读，不能因 Agent 释放就解锁编辑器。已有 Run history 选中规则保留，提供“查看此 Run”选择动作而不全局改写选择策略。

第二阶段验收名称：`PI_STAGE2_APPLICATION_FEEDBACK_PASS`。一条专用 Demo HTTP 场景即可：

1. 初始源码能通过 Maven 测试且旧 Run R0 ready；`/api/demo?name=Pi` 有确定可定位的 HTTP 500 与日志标记，普通 health 正常。
2. 浏览器提交任务，Pi 自动 stop R0；权威终态之后才 build/改代码。任务先不改源码，执行 build(test) 成功后创建 R1，实测 HTTP 500 并取得对应日志。
3. Pi stop R1，确认退出后修改并测试，创建新 R2；HTTP 200 且 JSON message=`Hello Pi`。Pi 自主生成修复代码，不提供修复脚本/预制正确答案。
4. 同 task 的持久工具/Run/receipt 记录证明停、写、构建无重叠，R1/R2 ID 不同且绑定当时最新保存版本。验收方从公开入口独立 GET，不能只相信 Pi 总结或工具 mock。
5. COMPLETED 后 R2 仍可访问，编辑仍受 Run 锁；测试方停止 R2 后编辑可恢复。无意外开发 Job，专用项目的最终删除/资源核对只在对应验收授权内执行。

其中自然语言要求先复现 HTTP 错误是验收条件；平台不把这套顺序写成自主编程工作流。纯容器/单测证明实现，真实 cloud model + cluster + browser + 独立 ledger/HTTP 共同授予阶段 PASS。缺条件时记录 NOT_RUN 和准确缺项，不能扩写成 CRUD、MySQL 或完整首版 PASS。
