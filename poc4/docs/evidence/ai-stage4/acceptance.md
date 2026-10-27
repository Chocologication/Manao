# Pi 阶段四本地实施与验收

日期：2026-10-27（Asia/Shanghai）。当前裁定：**LOCAL_STAGE4_CONTROL_VERIFIED**。云端为 **NOT_RUN**，未授予 `PI_STAGE4_CONTROL_RECOVERY_PASS`。Stage2 保持 **PAUSED / NOT_GRANTED**，原故障 Task `b3b32518-f0ed-411e-aa85-1ecef95fbdc5` 保持 **NOT_REPAIRED**。

## 1. 工作区与身份

- 实施分支：`codex/pi-stage4-control-recovery`，从执行时复核的 `codex/ai-integration@1d410cdccdb725e3b863e3adf1c942271975f00a` 建立；使用项目 `.worktree/pi-stage4-control-recovery`，未从 master 起步。
- 生产代码截止提交：`9ff87fa03c861e439e060f5683a768d3a90a913b`。Task1 `a622c02`、Task2 `a482e2f`、Task3 `d4ce885`、Task4 `9ff87fa`；本记录随 Task5 测试/文档提交，不把自己的提交 SHA 写成循环占位。
- 源 checkout 的未提交文档、云端证据与 `.superpowers/cloud-faults-20261027/` 保留，未 stash/reset/整体复制。只复制三份规划文件，复制时 SHA256 分别为：设计 `F50225F282CEBA4F13D7DAB398383AD71EC73B266806166E9DD82743769765A4`；计划 `E1D83FD932FC9A99C9B79389198F2DD3AC6301ABFFCFE25614492E3B236E653F`；交接 `F1281ACC7C47B25A615D00C2B4CA925D8AF7F231EC2500BB63FFDD5B17870464`。原样版本保存在 `a622c02`；后续仅更新本分支状态和实施说明。
- CodeGraph 已用于定位；目标分支索引覆盖不足时使用目标 checkout 磁盘源码。Context7 查询 Pi 文档并核对安装的 1.2.0 声明，未升级依赖。

## 2. 五项交付

| 任务 | 实现与证据 |
| --- | --- |
| 1 暂停控制 | 无 body 的 owner/project scoped `/agent-tasks/{taskId}/pause`，固定 `AI_PAUSED_BY_OWNER`，投影已有 `close_reason_code`；未绑定启动窗口409 `AI_TASK_STARTING`。HTTP200仍锁，CLOSING先确认，ACKED/CLOSING报告匹配且slot释放、资源核对完成后才解锁 |
| 2 服务异常 | 认证status→旧task404→status，稳定且真正不同boot；短gate内epoch/instance/receipt/close/deadline CAS。单404、401/坏JSON/超时、仅instance前缀变化、未绑定、deadline=NULL不作为死亡证据；不自动新建任务 |
| 3 长构建 | 窄 `Predicate<BuildRequest>` 查询真实close intent；原UID/owner/commandId cleanup。保留live claim直至结果落库/未知记录；不新增Future表、线程强杀或执行池。Kubernetes mock验证不等600秒自然退出及未知清理不解锁 |
| 4 前端接管与继续 | 项目current控制与历史display分离；同conversation最新已释放Task可继续，新taskId、新1800秒/180工具/20构建预算。重进与同revision释放均重读文件/Run事实，dirty保留、未知闭锁；丢响应核对任意FOUND即返回，不隐式开启第二轮 |
| 5 本地交付 | 三条浏览器链、旧夹具8项兼容、真实MySQL定向测试、真实SDK scripted provider、组件/构建、发布增量和清理记录。没有发布集群、付费模型或Git push/merge |

无新迁移、表、数据状态、第三方依赖、生产服务或scheduler。Worker生产代码未改，仍固定Pi1.2.0。`Paused` 是安全结束加原因的展示；原失败事实不被覆盖。正常COMPLETED保留READY应用；暂停/失败只处理本Task登记的目标，其他Run继续受原锁约束。

## 3. 实际命令与结果

所有命令从实施checkout运行；`mvn` 实际使用本机 `C:/Users/shili/.m2/wrapper/dists/apache-maven-3.9.16/56ba1f9f/bin/mvn.cmd`。MySQL仅 `127.0.0.1:3306`，单元测试每次独立 `manao_stage6_<uuid>`；浏览器 `manao_stage6_terminal_<uuid>`。未重置运行schema。

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=AgentTaskServiceTest,AgentTaskStoreTest,AgentTerminalSettlementTest,AgentTaskReconcilerTest,AgentConversationHttpContractTest,AgentProjectToolsTest,AgentApplicationToolsTest,DevelopmentBuildExecutorTest,RunControllerTest,ProjectCleanupServiceTest,ProjectDeleteHttpContractTest' test
pnpm --dir poc4/pi-worker test
pnpm --dir poc4/frontend exec vitest run src/features/ai src/components/shell/WorkbenchShell.test.tsx src/api/agentConversationApi.test.ts src/contracts/agentConversation.test.ts --maxWorkers=1
pnpm --dir poc4/frontend build
pnpm --dir poc4/pi-worker build
pnpm --dir poc4/frontend typecheck
pnpm --dir poc4/frontend test:boundary
mvn -f poc4/backend/pom.xml test-compile dependency:build-classpath '-Dmdep.outputFile=target/terminal-local-classpath.txt'
pnpm --dir poc4/frontend test:e2e:ai-stage4
pnpm --dir poc4/frontend test:e2e:ai-terminal-settlement
git diff --check
```

浏览器通过子进程显式传入本机测试账号 `MANAO_TERMINAL_TEST_DB_USERNAME/PASSWORD` 与 `MANAO_AI_LOCAL_EVIDENCE_DIR`；账号可为已授权的空口令测试账号，必须显式传入。生产/模型/Kubernetes变量不继承。实际环境使用 `manao` 账号及其已有 `manao_stage6_*` 权限；未扩大权限。

| 验证 | 结果 |
| --- | --- |
| 后端最终汇总 | exit0，268 passed / 0 failed / 0 errors / 0 skipped；17:52:41结束，实际耗时8m07s |
| 前端定向汇总 | exit0，15 files / 285 passed，含Workbench 85项 |
| Worker | exit0，182 passed / 1 skipped（专用本地server harness仅由浏览器setup启动；浏览器运行时另有真实执行） |
| 阶段四浏览器 | exit0，3/3；真实HTTP/MySQL/SDK，synthetic provider，mock资源 |
| 原收尾浏览器兼容 | exit0，8/8；legacy空deadline不被新恢复策略接管，正常成功保留READY，停止应用后201写入 |
| 构建/类型 | frontend生产build、Worker build、frontend typecheck均exit0；Vite既有chunk size提示保留 |
| 浏览器边界 | exit0，36 tests passed，Browser boundary check passed |
| 原清理增量 | exit0，16项，包含安全暂停前删除拒绝、安全核对后原流程删除Task/项目行；资源为fake |

阶段四三条链：A浏览器建会话/提交→pause200仍锁→slot/receipt核对解锁→生产保存API持久revision8→同conversation新Task读到用户修改→reload无额外start；B实际本地backend PID替换而原Worker不重复prompt、deadline保持→未知读保持占用→Worker boot替换→旧Task核对失败关闭→只在用户点击后新Task；C本Task关联mock Run未结束保持锁→观察停止后继续→正常完成保留READY→其他Run不被误停，仍禁人工写。

## 4. RED/GREEN与修正

- pause缺路由的5项RED；最小入口/快照/严格停止实现后覆盖6项，后扩展ACKED/CLOSING、删除和receipt先赢。初轮116项的两失败是新错误码尚未加安全白名单、测试gate同线程重入；已修正，未将环境错误当RED。
- 稳定新boot/receipt竞争先RED；后端reconciler16项通过。只读审查再发现同boot前缀变化，新增用例RED→修复→18项通过。
- 长构建新增测试因取消接缝不存在失败；补Predicate后原构建套件通过。慢Worker导致finish饥饿的可控预算测试RED→先资源finish后Worker观测→GREEN，最终释放仍需两类证据。
- 前端pause/continue/旧JSON五项RED→GREEN；同revision释放必须重读、soft重进、Task权威未知闭锁、已完成丢响应核对不重启等均先失败后修复。旧goal在接受提交后清空，让默认继续提示可达；用户新输入仍可替换目标。
- 浏览器准备阶段两次schema权限失败不是业务RED：默认测试账号不允许旧 `manao_terminal_*` 前缀；从用户授权文件只读取候选数据库变量名/值、仅尝试本机后也未使用其云端连接。最终改用既有测试前缀，不改权限。早期A用白名单外Demo.java，生产正确PATH_FORBIDDEN；夹具改为pom.xml。B等待信号/PID判断补齐，C使用正式stop再观察才能退出READY锁；原套件断言同步为READY仍不可人工写。
- 最终前端套件曾因前一测试未等待创建mutation结束而晚写revision、污染下一测试失败；只读定位后让fixture等待创建与mutation归零，原revision缺失断言保留，最终285/285。没有放宽业务断言或修改无关产品功能。

## 5. 清理与证据边界

最终两次浏览器运行均确认schema DROP、scratch不存在、全部4个自有进程退出：`manao_stage6_terminal_2db7970093604f10a587df49ff65c70f` 和 `manao_stage6_terminal_febfc03aa97c4375a66f5eac2e45e6fd`。退出后4189、18989–18994无监听；独立MySQL查询无 `manao_stage6_terminal_*` schema，本轮日志记录的605个独立schema均不再存在。结构化摘要见[verification.json](verification.json)。

两处准备失败时留下的scratch已只读核对为空，但精确删除请求被自动审批拒绝（`blocked by policy`），实际删除 **0**，未重试或换工具：`C:/Users/shili/AppData/Local/Temp/manao-terminal-local-45DnBQ`、`C:/Users/shili/AppData/Local/Temp/manao-terminal-local-upirMZ`。

另一次独立的本地生成物清理请求也在执行前被拒绝，实际删除 **0**：实施checkout根目录51份日志（4,066,100 bytes）、7处本轮 `.superpowers` 输出目录和2处前端test-results目录（共33个文件，目录合计9处）。已核对全部位于实施workspace、无reparse、无根目录tracked日志；未换工具绕过。必要命令结果和日志SHA已压缩到verification摘要，原生成物保留、不进入本轮Git提交；其他会话历史残留未处理。

本地Job/Pod/进程身份来自mock或本机夹具，**不证明真实集群Pod、构建子进程停止或完整Workbench云验收**。无真实1800秒等待；预算由真实持久deadline与既有SDK边界测试证明，三条云端后续场景仍NOT_RUN。未恢复旧Task、未删除任何历史/云资源、未构建或发布镜像。整套AI首版未授予验收PASS。

## 6. 发布准备

增量发布顺序与回退见[维护手册](../../../deploy/ai-terminal-settlement/README.md#阶段四增量发布准备2026-10-27)。本阶段无新迁移；兼容backend先于frontend；Worker源码未变，无本阶段Worker镜像发布需求。部署前仍须重核单Worker `replicas: 1 / strategy: Recreate`、旧close/receipt/claim及原Run约束。三条云端目标仅在后续授权后执行。
