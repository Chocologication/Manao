# AI terminal settlement 本地验收记录

日期：2026-10-26。分支：`codex/fix-ai-terminal-settlement`。Task 1–7 基线：`3e9ffa0`。

当前状态：**LOCAL_REPAIR_VERIFIED / DEPLOYED_SMOKE_VERIFIED**。Task1–8及整分支审查通过；2026-10-26用户另行授权部署和一次最小真实模型验证，已从758aae6发布三组件并完成V15/V16迁移。生产修复代码终点5739d1b；实际发布证据见第8节。原故障Task仍NOT_REPAIRED，Stage2保持PAUSED/NOT_GRANTED，未Git push/merge。完整云端故障矩阵未执行；不声称最终源码单次完整962项全绿。

2026-10-27 用户授权的后续第三项已完成：真实provider失败、owner close、执行中backend重启、Worker收据前丢失及真实1800s期限关闭，四类专项场景PASS，标记 **KEY_CLOUD_FAULTS_VERIFIED**。实际结果及逐项边界见[本轮记录](cloud-faults-20261027.md)；前两项跳过，第四阶段不启动，不能将局部场景扩大为完整 A–N PASS。

## 1. 验收架构与证据边界

- 一次性真实 MySQL schema：`manao_terminal_<uuid>`。`LocalDisposableSchema` 只允许该命名且只连 `127.0.0.1`，创建/销毁本次 schema；从不重置旧固定名称库或运行库。
- Java 测试源 `TerminalSettlementLocalServer` 启动真实嵌入式 HTTP server，导入生产 SecurityConfig、Task/Conversation/Workspace/Run controllers、真实 JDBC stores、services、AgentProjectTools、settlement/reconciler。并非 MockMvc。
- Worker 使用生产 `createTaskServer`、`TerminalDelivery`、`createPiSession` 和实际 Pi SDK 1.2.0；复用 `test/scripted-session.ts` 的确定性模型流，工具真实通过 HTTP 写 ledger。生产 capability admission 所需的 provider 配置只作为测试身份；实际流由注入 adapter 提供，测试 fetch guard 拒绝任何非 `127.0.0.1` 请求。
- 专用浏览器页面挂载生产 `AgentConversationPanel`（含 `AgentTaskPanel`）、React Query 和 `RunToolbar`，使用真实 task/conversation/Run API。不是完整 WorkbenchShell，不含完整项目初始化、编辑器、Ingress 或 Kubernetes 验收。
- 外部 `WorkspaceAgent` 文件/receipt 事实、`JobCoordinator` 观察事实为受控测试适配器。任务收尾、owner close、Run STOPPING/最终观察使用生产状态转换；没有生产 fault 开关，未以 fixture 直接改任务最终状态。该边界不能证明真实集群删除或存储回收。
- 监听仅 loopback：18989 Worker、18990 受控 Worker 代理、18991 Java、18992 callback 代理、18993 Java 重建控制、18994 Worker 进程重建控制、4189 Vite。端口占用即失败，不复用既有服务。
- setup 只从显式 `MANAO_TERMINAL_TEST_DB_USERNAME/PASSWORD` 取得本地测试账号，子进程环境白名单，不继承集群/model 配置；测试日志不打印凭证。

## 2. 基线 fixture RED 与修复

在专属 `manao_terminal_a48035e1f18641b2a91e8314e78cd961` schema 执行旧测试，不触碰 `manao_poc4_atomic_test`：

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=AtomicTransitionTest,FlywaySchemaTest,ProjectDeletionStateMigrationTest' test
```

RED：26 tests，4 failures（latest 断言 11，实际 16），10 errors（Atomic 的固定 DROP 列表遗漏新增 conversation 外键），exit 1。该 owned schema 已销毁。日志：`.superpowers/sdd/2026-10-25-ai-terminal-settlement-implementation-plan/task-8-fixture-red.log`。

修复仅测试夹具：Atomic 改为 `JdbcStoreTestSupport.create()` + `AfterEach.close()`；latest 断言更新为 V16；Flyway legacy-null升级用新的version3 disposable schema，去掉旧DROP表列表；conversation升级断言显式验证V16默认attempt=0；HTTP测试配置/控制器只在专用profile生效。生产源码和迁移没有修改。最终六个相关类60/60通过，exit0。

## 3. A–N 竞态矩阵

| Case | 本地证据与状态 | 边界 |
| --- | --- | --- |
| A 原故障锁竞争 | dedicated HTTP case 已执行通过；gate 持有时 receipt=1、NEEDS_ATTENTION、写拒绝；释放后后台完成，model2/tool1/start1 | controlled gate，真实 DB/HTTP |
| B progress37 缺失 | PASS；actual ProgressChain + BackendClient真实HTTP prelude持久1..36，transport丢37，实际Pi循环后独立receipt1、call1、COMPLETED | 断言lastSeq36、有36、无37；未改DB进度 |
| C ACK 丢失 | dedicated HTTP case 已执行通过；第一次 POST 提交后 transport 丢ACK；同report重投，receipt1、tool1、model2 | 没有第二个 start |
| D backend 重建 | dedicated HTTP case 已执行通过；gate 下 receipt 持久后杀死实际 Java 进程并重启，同DB继续完成 | 未重跑模型/工具 |
| E Worker 收据前消失 | focused physical process restart 已执行通过；新 boot 丢内存记录，仍RUNNING不猜成功，到期FAILED | Worker 无 durable outbox；不保证保留成功答案 |
| F budget | PASS；E使用注入Clock前进1801s，生产budget close后FAILED，close_reason=AI_TASK_BUDGET_EXCEEDED，无receipt不能伪造成功 | 未实际等待1800s |
| G 未决副作用 | PASS；AgentTerminalSettlementTest21、AgentProjectToolsTest35、AgentApplicationToolsTest12均0失败；实际I在RunSTOPPING时保持占用，生产观察确认后才释放 | 不解锁未知claim/receipt/Run |
| H 成功保持应用 | PASS；实际HTTP/浏览器验证COMPLETED时Run仍RUNNING且firstReadyAt存在、Stop恢复；新任务完成后用户Stop，经生产观察CANCELLED后写入201 | 受控已就绪Job事实，非真实应用 |
| I close 竞争 | PASS；End→NEEDS_ATTENTION→Job观察确认→FAILED→解锁；审查补强后等待同task/report/hash的真实Worker delivery=CLOSING且slot为空，再断言DB仍FAILED、原close_reason/failure不变、唯一receipt匹配且model2/start1/calls不变；刷新仍FAILED | 生产 RunObservation + controlled MISSING；实际ACK后断言，不以释放transport后立即读代替 |
| J 身份/摘要 | PASS；实际browser foreign owner404；AgentInternalSecurityTest10、AgentTaskStoreTest35、HttpPiWorkerClientTest2，以及Worker181检查instance/epoch/report摘要 | 不使用跨owner fixture成功冒充鉴权 |
| K 周期恢复 | PASS；RunRecoveryServiceTest21、RunObservationServiceTest28均0失败，保留启动/接管/STOPPING与token CAS覆盖 | 原始6A/6B不重验 |
| L 兼容 | PASS；Flyway14、conversation21最终复验0失败；legacy terminal在Settlement21/TaskService48中覆盖；V15/V16保持加法及旧任务NULL deadline | 未实际发布/旧集群切换 |
| M 调度/日志 | PASS；Reconciler12、ReconcileWorkBudget2、Worker181；实际HTTP afterAll检查日志不含prompt/token/model key且terminal诊断只含9个允许字段；external fetch=0 | 压力/长期云端故障矩阵NOT_RUN |
| N UI | PASS；实际End→wait→confirmed→unlock、刷新/重登DB权威、新任务与写入201；目标生产组件211/211通过，typecheck/build/boundary36/36通过 | component page，不是完整云端Workbench |

## 4. 可复现命令

在本worktree执行；数据库凭证通过进程环境提供，不写命令、报告或日志。Java17、Node>=22.19.0、pnpm10.33.0；使用现有Maven3.9.11。

```powershell
# Java测试classpath只需准备一次；Maven必须串行
mvn -f poc4/backend/pom.xml test-compile dependency:build-classpath '-Dmdep.outputFile=target/terminal-local-classpath.txt'
pnpm --dir poc4/frontend test:e2e:ai-terminal-settlement
pnpm --dir poc4/pi-worker test
pnpm --dir poc4/pi-worker build
pnpm --dir poc4/frontend test -- src/features/ai/AgentTaskPanel.test.tsx src/features/ai/AgentConversationPanel.test.tsx src/components/shell/WorkbenchShell.test.tsx src/components/runs/RunPanel.test.tsx src/components/runs/RunToolbar.test.tsx
pnpm --dir poc4/frontend typecheck
pnpm --dir poc4/frontend build
pnpm --dir poc4/frontend test:boundary
mvn -f poc4/backend/pom.xml '-Dtest=AgentTerminalSettlementTest,AgentTaskReconcilerTest,HttpPiWorkerClientTest,AgentTaskStoreTest,AgentTaskServiceTest,AgentInternalSecurityTest,AgentApplicationToolsTest,AgentProjectToolsTest,RunRecoveryServiceTest,RunObservationServiceTest,JdbcRunStoreTest,RunControllerTest,RuntimeMaintenanceLoopTest' test
mvn -f poc4/backend/pom.xml '-Dtest=AgentConversationStoreTest,AgentConversationHttpContractTest,AgentConversationCompactionTest,AgentLiveOutputTest,AgentLiveOutputHttpTest,DevelopmentBuildExecutorTest' test
mvn -f poc4/backend/pom.xml test
git diff --check
```

## 5. 实际执行记录

- happy HTTP/SDK/browser首例：`task-8-browser-sixth.log`，1 passed，exit0，receipt1/call1/start1/model2；临时 schema `manao_terminal_2b94e8d47dc543e3b01992c6b6e23c29` 已销毁。
- matrix1：5 passed / 3 failed，exit1；失败为夹具缺号精确性、Run seed updated_at遗漏。保留诊断，不当最终PASS。
- matrix2：6 passed / 2 failed，exit1；I完成，失败为B未启用收尾scan、H seed started_at/compose remount。保留诊断，不当最终PASS。
- focused修正最终通过：B/H2/2，E/I/H3/3；均保留精确错误和修正过程，最终以normal-final8/8为准。
- 最终正常classpath专用浏览器：`pnpm --dir poc4/frontend test:e2e:ai-terminal-settlement`，**8/8，exit0，1.5m**，`task-8-browser-normal-final.log`。覆盖所有八个真实HTTP/浏览器场景，afterAll日志检查通过；没有`--list`替代执行。此前同内容隔离javac验证8/8仅诊断，最终命令没有classpath override。
- Worker：`pnpm --dir poc4/pi-worker test`，181 passed / 1 skipped（仅专用长驻harness为显式opt-in），exit0；build exit0。`task-8-worker-tests.log` / `task-8-worker-build.log`。
- 目标前端五组件：211/211，exit0；typecheck、build均exit0；boundary36/36 exit0；新增harness专用tsc exit0。日志分别为`task-8-frontend-tests.log`、`task-8-frontend-typecheck.log`、`task-8-frontend-build.log`、`task-8-frontend-boundary.log`、`task-8-harness-typecheck.log`。既有jsdom媒体提示与Vite大chunk警告保留。
- 原完整backend命令：`mvn -f poc4/backend/pom.xml test`，**962 tests，4 failures / 7 errors / 2 skipped，exit1，20:14**，`task-8-backend-full.log`，结束10:27:20。错误全部定位为测试夹具：V16投影1F、测试controller被component scan导致Configuration3F4E/Health2E、旧Flyway DROP外键1E。不能称该次完整命令全绿。生产核心类已在该次实际执行：Settlement21、Reconciler12、Store35、Service48、Security10、Application12、ProjectTools35、RunRecovery21、RunObservation28、JdbcRun15、WorkerClient2、DevelopmentBuild31，均0失败。
- 最终相关backend复验：`mvn -f poc4/backend/pom.xml '-Dtest=AgentConversationStoreTest,ConfigurationTest,HealthEndpointTest,FlywaySchemaTest,AtomicTransitionTest,ProjectDeletionStateMigrationTest' test`，**60/60，exit0，03:55**，`task-8-backend-fixtures-green.log`，结束10:34:43。计数21+11+2+14+10+2。所有此前失败类均复验通过；测试夹具修正后没有重跑完整962项，因此不声称单次完整全绿。
- 两条计划focused链被完整backend命令实际覆盖；最终只复验失败fixture类，没有重复运行相同完整集合。controller因延迟协调短暂启动重复Maven，已按PID49096终止；单数`task-8-backend-fixture-green.log`为中止诊断，**不作为PASS**。权威是复数`fixtures-green.log`。
- 生产实现源码基线`3e9ffa0`；本Task仅测试/文档。Task8提交SHA见本节后续提交记录及SDD报告。

### 5.1 Task8 review 修正：晚到报告实际ACK之后核对

review指出原I场景释放terminal代理后立即读FAILED，可能先于Worker下一次backoff POST；afterEach只等待空slot，缺少ACK之后的数据库断言。补充test-only安全delivery投影，内部通过token读取生产Worker `GET /tasks/{id}`，只暴露task/report/hash/outcome/delivery与slot，不包含token、summary或模型内容。

- RED：`pnpm --dir poc4/frontend test:e2e:ai-terminal-settlement --grep 'I owner'`，1 failed，exit1，`task-8-review-i-red.log`；立即读actualWorker确为PENDING且slot仍被当前task占用，证明原时间窗口。
- GREEN：同命令，**1 passed，exit0，38.1s**（用例6.0s），`task-8-review-i-green.log`。等待实际CLOSING ACK、同report/hash、slot为空后才核对DB，保存的仍是原FAILED/close_reason；晚到COMPLETED报告只保存一个receipt身份，不能逆转结果，model2/start1/calls不变，刷新/重登仍FAILED。实际Worker日志显示attempt5、status200、codeCLOSING。
- 新harness tsc exit0：`pnpm --dir poc4/frontend exec tsc --noEmit -p tests/fixtures/ai-terminal-settlement/tsconfig.json`，`task-8-review-i-typecheck.log`；无生产修改，无Maven或完整矩阵重复运行。
- 此轮owned schema `manao_terminal_ea0bc2f7f05d46c8b8fd22527ce4e6f8` 与新scratch清理成功，18989–18994无LISTEN；此前被拒绝目录完全未触碰。

### 5.2 整分支 review 修正：lost-start 保留原成功结果

整分支 review 发现唯一 Important：Worker 已接受 start、但 ACK 丢失后，旧恢复分支仅凭 `status.state=COMPLETED/FAILED` 就写入 `AI_CLOSING`，可能把已完成任务及 READY Run 误送入失败清理。该分支现复用 `AgentTaskSettlementService.reconcile`：已有收据按原裁定结算；无收据时核验进程 boot、task、instance、epoch、request digest 和冻结报告，再走统一 `recordTerminal` / CAS。state-only 旧响应及 foreign identity 不推断结果，保持未决占用；既有 owner close 决定仍优先。

- 真实 MySQL 定向 RED：5 tests，4 failures / 0 errors / 0 skipped，exit1；两条完整成功报告预期 `COMPLETED`、实际 `NEEDS_ATTENTION`，旧 state-only / foreign task 预期 `QUEUED`、实际 `NEEDS_ATTENTION`。`final-fix-red-confirmed.log`，41.154s，2026-10-26 11:32:09+08:00。最初测试误读 submit 返回的创建快照，已改为检查持久状态；该诊断运行不作为根因 RED 证据。
- 同一五条定向 GREEN：5/5，exit0，45.825s，2026-10-26 11:33:38+08:00，`final-fix-green.log`。覆盖无收据与 `AI_TERMINAL_PENDING` 已落盘两种 ACK 丢失窗口；最终成功、READY Run 不停、start1 / 原 call1、不重放工具或模型入口；不完整旧状态/foreign identity 保持占用，owner close 不被逆转。
- 最终串行直接相关复验：Service 全部52 + Settlement选定7 + Reconciler选定6，**65/65，0 failures/errors/skipped，exit0，02:45**，2026-10-26 11:37:02+08:00，`final-fix-regression.log`。GREEN实际重新编译143个生产源文件及100个测试源文件；此后只改文档。日志提取本轮87个唯一 `manao_stage6_*` schema，精确只读复核剩余0（mysql exit0）；未执行额外删除。
- 此轮只修改 lost-start 生产分支及测试；直接相关复验和自查结果见 SDD `final-fix-report.md`。不重复浏览器矩阵或完整962项，不把旧结果称为最终源码的完整重跑。整分支限定复审已确认I1 ADDRESSED、无新增Critical/Important，Ready for local delivery: Yes；据此授予 `LOCAL_REPAIR_VERIFIED`。云端、原故障Task和Stage2边界不变。

## 6. 清理实际结果与保留项

最终正常classpath运行的新schema `manao_terminal_254b1b30b9a94f1592ad4c614898b91d` 已销毁，其新owned scratch root已移除；监听端口18989–18994无LISTEN，旧PID50776不存在。此前所有专用browser teardown均销毁各自owned schema；最终setup只清理自己拥有的PID树、schema与scratch root。

旧调试harness使用`privateDirs()`后强制终止进程留下11个本轮目录，已通过本轮创建时间、固定local-task transcript标记和测试model配置验证归属。针对下列确切目录及隔离编译目录的清理请求被自动审批策略拒绝，**没有执行删除，没有换工具或重试绕过**；保留项：

```text
C:/Users/shili/AppData/Local/Temp/manao-pi-scratch-1xgQco
C:/Users/shili/AppData/Local/Temp/manao-pi-scratch-4Ui9z6
C:/Users/shili/AppData/Local/Temp/manao-pi-scratch-5CJwAK
C:/Users/shili/AppData/Local/Temp/manao-pi-scratch-602wTm
C:/Users/shili/AppData/Local/Temp/manao-pi-scratch-7f8XKh
C:/Users/shili/AppData/Local/Temp/manao-pi-scratch-foVSvm
C:/Users/shili/AppData/Local/Temp/manao-pi-scratch-HsCS0c
C:/Users/shili/AppData/Local/Temp/manao-pi-scratch-IrWgC0
C:/Users/shili/AppData/Local/Temp/manao-pi-scratch-JIQLBn
C:/Users/shili/AppData/Local/Temp/manao-pi-scratch-TQYWEf
C:/Users/shili/AppData/Local/Temp/manao-pi-scratch-xmWPG0
D:/DeepLearning/MyProjects/Project_Manao/.worktree/ai-terminal-settlement/.superpowers/sdd/2026-10-25-ai-terminal-settlement-implementation-plan/browser-classes
```

有用日志、审查rulings、初始失败与最终通过记录保留在SDD目录，未删。controller对重复中止Maven日志中的13个唯一schema作精确只读核对：12个已不存在，唯一残留`manao_stage6_15367f6af82d43718d61488fc68dd8ab`已按该精确身份DROP成功，复核剩余0；未触碰其他库。

## 7. 部署前的授权边界（历史快照，已被第8节本次授权更新）

云端镜像构建/推送/部署/数据库迁移：`NOT_RUN`。原故障Task：`NOT_REPAIRED`，仅[发布与恢复手册](../../../deploy/ai-terminal-settlement/README.md)中的dry-run程序。原Stage2验收保持 `PAUSED / NOT_GRANTED`。

## 8. 2026-10-26 实际集群部署与最小真实验证

结论：**DEPLOYED_SMOKE_VERIFIED**。用户先授权部署，随后明确授权一次最小真实AI任务，并仅在项目上限阻塞时允许清理较早项目。实际7/8项目，新建成功，未删除旧项目。源码758aae6（生产代码5739d1b），context=kubernetes-admin@learn，namespace=manao-stage6b，公共入口http://1.12.245.235:30080。[脱敏机器证据](cloud-release-20261026.json)记录完整digest、Pod UID及回退身份。

### 8.1 发布、备份与健康

- 三节点Ready；Metrics API不可用，改核对可调度状态和requests：node1 CPU65%/memory67%，node2 CPU63%/memory28%。这是当时请求量，不是实时利用率。
- 标准Dockerfile三组件build/push均exit0；frontend显式VITE_ENABLE_AI=true。backend/Worker保持单副本Recreate，先将frontend/Worker/backend缩至0并确认旧Pod消失，再依次启动兼容backend、Worker、frontend。未应用测试配置或fault hooks。
- 运行库manao_poc4_6b从V14升级至V15/V16，Flyway均success=1。私有备份6,207,643bytes，SHA256=0c06abfcf74963589658df46e6b419b46d05dea906688a537daca0b43282006f；独立恢复库验证9张关键表行数一致后删除。备份留私有目录、未入Git，远端临时SQL已精确删除。
- backend、Worker、frontend分别Ready1/1，最终restartCount均0；backend readiness HTTP200/UP，公共首页HTTP200。

| 组件 | 实际digest（仓库chocologic/manao_images_repository） | Pod |
| --- | --- | --- |
| backend | sha256:2b8d3d21e4af8a0cdf488fae4b785f41e675f63f6e08cd4147f864082dc5e695 | backend-75c4f446f5-qwtvs |
| Worker | sha256:696080571ba556d983aa578163be3d6494261057e960a9686b15f814e7d0c93e | manao-pi-worker-6b6b79574b-qwlfr |
| frontend | sha256:77ba0d19320ac238badf694a0bdd8eb6508d3c2aee6de50ed98f8192dc0ed708 | frontend-5f6fd7bf8c-86q5m |

### 8.2 一次真实模型与浏览器结果

项目caafbc12-9831-4ff7-a411-0eb0f1c7ef75，名称terminal-settlement-cloud-20261026，Java console、无MySQL/Redis/公网端口，保留供用户查看。只提交Task978cddbb-5d51-45f3-9b3b-475a4c33791e一次，要求list_files根目录后简短回答，不修改、构建或启动应用。

- 生产浏览器工作台提交HTTP200，QUEUED且writesLocked=true，End task可见；随后自动COMPLETED、failureCode=NULL、writesLocked=false，current查询404，Start task/New file恢复可用。
- 数据库只有1条list_files且COMPLETED；模型未改变revision21、没有Run。终态receipt唯一，reportId=192a5b229668bbd2d3309c5fdc700d9f52152937df2478470ed9f39f0116e3be，SHA256=fe53fb4a6a3767351ef78ee25452b140b55cdc61cf77604aea012ac5c6ea2226，与Worker ACKED逐项匹配，activeTaskId=NULL。
- UTC创建04:29:22.892231、收据04:29:25.487688、完成04:29:30.089421（北京时间12:29:22至12:29:30）。deadline04:59:22.892000固定，close_reason=NULL。Worker第一次投递HTTP200/RECORDED，elapsed23ms。
- 完成后owner API创建terminal-release-proof目录HTTP201，workspace_operation=COMMITTED，revision21→22；退出并重新进入后仍显示COMPLETED和可编辑。浏览器只在登录响应处引导短时operator签名owner JWT，其余项目/会话/任务/文件请求均真实，**未验证账号密码登录流程**。
- 初始浏览器导航/角色定位超时均发生在模型提交前；误查/workspace与ledger不存在列产生的诊断错误已改用实际API/表字段复验，不作为通过证据。

### 8.3 本轮不扩大的结论

这是实际发布与一次最小成功收尾冒烟，不等同完整云端A–N故障注入、强制重启、1800秒期限、失败/close/READY应用保留或资源删除验收。这些本轮云端NOT_RUN，已有本地证据保持原边界。没有重新启动Stage2验收或授予阶段PASS。

原故障Task b3b32518-f0ed-411e-aa85-1ecef95fbdc5发布后仍RUNNING、deadline=NULL、receipt=NULL、close_reason=NULL：**NOT_REPAIRED**。后台为历史占用更新对账时间，但未自动预算关闭、未发owner close、未重跑原模型/工具；若要恢复原项目，需另行处理该历史任务。

测试浏览器已关闭，恢复演练库和远端临时SQL已清理，私有备份、回退基线和脱敏证据保留。未触碰此前策略拒绝的临时目录；未Git push/merge。
