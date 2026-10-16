# Pi 第二阶段实施 Agent 提示词

下面分隔线之后的正文可直接复制给实施 Agent。它授权实施、本地验证和发布准备；部署、真实模型/集群验收仍以接收该提示词时用户明确给出的范围为准。

---

请实现 Manao AI 集成第二阶段“应用运行与反馈”，持续推进到五项任务的代码、必要本地测试、审查、文档与发布准备完成。不要停在再次输出计划。

请使用 `codebase-design` 和 `superpowers:subagent-driven-development`（如果环境不可用，则使用 `superpowers:executing-plans` 并保留逐任务审查）。设计和计划已经准备好：

1. `docs/superpowers/specs/2026-10-16-pi-stage2-design.md`
2. `docs/superpowers/plans/2026-10-16-pi-stage2-implementation-plan.md`

实施目录：`D:/DeepLearning/MyProjects/Project_Manao/.worktree/ai-integration`，分支 `codex/ai-integration`；第二阶段实施代码基线 `b2c6ec384e2b0ed4af2019140504f74417147084`（短 SHA `b2c6ec3`，2026-10-16）。该提交已收录 revision-cache 修复、部署/验收文档和第二阶段规划；后续仅同步基线的文档提交不改变代码基线。主检出 `master@49eb632` 没有第一阶段实现。先读取实际目录的 AGENTS.md、git status/log 和上述两份文档，并执行 `git merge-base --is-ancestor b2c6ec3 HEAD` 确认当前 HEAD 包含基线；使用包含该提交及最新计划的 HEAD 实施，不重写已交付能力。

第一阶段已真实云端验收，`PI_STAGE1_CODE_TEST_LOOP_PASS` 已授予。证据权威是 `poc4/docs/evidence/ai-stage1/acceptance.md` 第8节；第一阶段旧spec/plan的NOT_RUN段落是历史快照。第8.7节的revision-cache修复已部署且本地回归通过，但部署后的浏览器点击路径没有完成复验，不得把它说成新版本完整PASS。

以下原有修改已提交在 `b2c6ec3`，属于实施基线，保留其行为：

- `poc4/frontend/src/features/ai/AgentTaskPanel.tsx` 及测试。
- `poc4/frontend/src/features/files/fileQueries.ts` 及测试。
- `poc4/frontend/src/features/runs/workspaceReload.ts` 及测试。
- `poc4/deploy/ai-stage1/README.md`、`poc4/docs/evidence/ai-stage1/acceptance.md`。
- `docs/superpowers/plans/2026-10-15-ai-revision-availability-fix-plan.md`。
- 第二阶段设计/计划/提示词及其索引修改。

开始前记录实际 HEAD/status；原有修改已提交，不再按未提交补丁搬运。若届时又有新的未提交改动，保留并区分范围，不能reset、覆盖或混入本任务提交。接触前端原修复时重读最新文件；使用小patch，失败一次先重读。仅按任务提交新增的第二阶段代码。

第二阶段目标是：

> 旧应用运行时接到目标 → Agent取得项目写入占用 → 停止确切旧Run并确认退出 → 读改与构建 → 最新保存版本新Run → 实际状态/日志/HTTP GET → 根据错误修复并再次新Run。

按计划顺序执行：

1. active Run admission、Agent内部授权、稳定Run身份和写/构建互斥。
2. application工具、持久日志、正常/失败/close的正确收尾。
3. 当前Run主应用Service的有界HTTP GET。
4. Pi六工具和浏览器实际结果展示。
5. HTTP500→修复→HTTP200的真实验收harness、独立判定器及发布准备。

保持设计收敛：

- 原四工具只加 `application`（start/stop/status/logs）与 `app_http_get`，总共六工具；taskId/project/owner/revision不由模型决定。
- 新生产Module只有concrete `AgentApplicationTools`、`ProjectApplicationProbe`；直接复用RunService/RunStore/RunLogService，不加空壳RunControl/LogReader/provider Adapter。
- 不新增表/migration/Agent状态/消息队列/工作流引擎。application/start沿用ledger历史列workspace_operation_id存稳定runId，不创建二次映射平台。
- HTTP只GET、相对path、同项目当前Run主端口；日志只64KiB tail。第三阶段再扩CRUD/MySQL写请求，第四阶段再做暂停/接管/异常后手动继续。
- 不加自由Shell、SQL、Python适配、多Agent、MCP/Skills平台、执行池、自动续跑或通用审批系统。

必须通过测试落实的接缝：

1. **停止不是瞬时完成。** STOPPING/RECOVERING仍禁止源码写和build；短等待返回尚未确认，Pi能继续status，不因正常10s等待就锁死为NEEDS_ATTENTION。
2. **启动只执行一次。** toolCall→stable runId在副作用之前持久化；丢响应查原Run，终态Run也不能用相同call重新创建。禁止简单调用每次随机UUID的普通Run.start。
3. **互斥由后端保证。** write/build与任何activeRun互斥；application/start与未决开发build互斥；不以SDK sequential代替后端并发保护。
4. **close不得持锁等观察器。** 短锁标closing→锁外停止/核对→短锁CAS释放；当前RunObservationService也需project gate，持锁等待会阻塞结算。
5. **FAILED也要收尾。** 不能沿用terminal直接applyTerminal(FAILED)释放；从全部持久application/start rows（含COMPLETED）核对本任务新Run，stop后等退出。未触碰的原应用不误停。原failureCode/summary可从已持久terminal进度重读。
6. **成功保留应用。** 结束Agent后保留稳定ready的最终Run供查看，它继续锁源码并遵守原7200s寿命；Agent结束不等于用户验收或编辑可写。
7. **HTTP真实且有限。** 核对Service归属、project/run/podUID selector、主端口、Run active/ready。禁止任意URL/header/凭据/重定向/重试；64KiB限制在读取中执行，10s覆盖响应body，不能先无限读完再截断；浏览器按文本渲染body。
8. **真实反馈回到Pi和用户。** Run RUNNING不代表ready；firstReadyAt也不单独证明Service路由成功。返回真实HTTP status、body、错误及截断；owner工具详情route使用显式安全投影，不暴露集群身份/模型或数据库凭据。

每任务行为修改先写失败测试，运行确认是目标行为失败，再写最小实现。使用已有disposable MySQL、Fabric8 mock、真实JDK HTTP本地server、Vitest/Playwright；不要用实现镜像式测试或重复层层转发测试。每任务规格审查和代码审查通过后提交，问题修复后重验受影响范围。集成必要回归运行一次，通过后不无理由反复扩测。

Java/SDK/CLI具体用法需要新查时使用Context7；Pi保持1.2.0与当前锁文件，不因最新文档差异静默升级。前端/worker使用pnpm，禁止npm；Python仅在确实涉及项目时沿用uv规则，本阶段没有Python依赖任务。输出UTF-8无BOM，遵守.gitattributes；git diff --check必须通过。

本轮默认执行范围：代码、测试、独立本地容器验证、审查、文档、可检查的发布准备。不要因为上阶段Secret/部署仍在就自动发布、调用云模型、修改manao-stage6b配置、重置运行schema或删除已有资源。若用户在本次实施消息中另有明确部署/验收授权，按该授权继续；无需重复询问已授权动作。当前缺少外部条件时继续完成所有不依赖它的代码和测试，并将对应项准确记NOT_RUN，不能mock冒充真实PASS。

真实验收由专用新Spring Boot项目完成：R0 ready→停R0→不改源码test0并启动R1→实际GET500+日志→停R1→Pi自主修复/test0→不同R2→GET200与Hello Pi。独立operator核对同task的Run/ledger/receipt和不重叠区间，独立公开入口GET；Surefire必须实际运行且fixture不被删改。只有完整真实cloud model+cluster+browser+independent ledger/HTTP才能授予`PI_STAGE2_APPLICATION_FEEDBACK_PASS`。这不代表CRUD/MySQL、完整AI首版或用户业务验收通过。

结束时提供：实际HEAD/提交、每任务结果、测试命令与执行数、修改目的、过度工程化复查、真实验收/部署/清理各自状态、准确未完成项与下一步。更新AGENTS和Progress索引到权威记录。删除本轮无用临时文件，保留最小必要失败诊断；不自动merge或push。
