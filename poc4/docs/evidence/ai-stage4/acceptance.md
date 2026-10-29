# Pi 阶段四实施与验收

日期：2026-10-27（Asia/Shanghai）。当前裁定：**PI_STAGE4_CONTROL_RECOVERY_PASS**。本地 **LOCAL_STAGE4_CONTROL_VERIFIED** 保留；用户后续授权发布和真实模型验证，实际结果见第7节。Stage2 保持 **PAUSED / NOT_GRANTED**，原故障 Task 保持 **NOT_REPAIRED**；不代表整个AI首版通过。

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


## 7. 2026-10-27 实际云端发布与阶段四验证

用户在本地交付后明确授权部署和模型调用。本节 supersedes 第1–6节的本地阶段 NOT_RUN；本地结果与当时清理拒绝仍保留历史。此次没有修改生产代码，发布源为 e3c06dde8fc02b3e00c80373be870e5dc413bb6f，production code截止9ff87fa。目标kubernetes-admin@learn / manao-stage6b，浏览器通过公共入口真实账号密码登录。脱敏结构化证据见[cloud-20261027.json](cloud-20261027.json)。

### 7.1 发布身份与恢复准备

- 标准Dockerfile构建、推送backend/frontend均exit0；frontend显式VITE_ENABLE_AI=true。backend先于frontend，最终Ready1/1；Worker继续原Pi1.2.0镜像，本次只为故障验证替换其Pod。无新迁移，V15/V16仍各成功一次。
- backend linux/amd64 digest：sha256:c0c56bc35ffc485350f42153f1833f94527c1cceda2f3ccba762c6654ba4eb56；frontend：sha256:120ebc30a2ab00a090ab89d7f1184ec402ae391bc0aced7a45ea72fea4c45ae1。源码label均e3c06dd完整SHA。部署generation分别45/27，Worker34；实际imageID匹配。
- 发布前私有全库备份3,235,900 bytes，SHA256=089e0ece51765758ee483cf91a2de98a86a548fb32d5bc669f293becf523e728；独立restore schema恢复后9表计数一致，restore schema已DROP确认，备份只保留仓库外。运行库未reset，模型密钥和应用凭据未修改。
- 回退tuple保留发布前backend 2b8d3d21e4af8a0cdf488fae4b785f41e675f63f6e08cd4147f864082dc5e695 / frontend 77ba0d19320ac238badf694a0bdd8eb6508d3c2aee6de50ed98f8192dc0ed708 / Worker 696080571ba556d983aa578163be3d6494261057e960a9686b15f814e7d0c93e；存在未完成pause/restart close时不能直接退旧backend。

### 7.2 三条真实链的结果

| 链 | 实际任务与证据 | 裁定 |
| --- | --- | --- |
| A 暂停接管/人工保存/继续 | caa8d794-ed6c-4dc9-8b6a-3dea7418bd75：真实长JUnit test打印marker且Maven/Surefire子进程存在后UI Pause；200/NEEDS_ATTENTION/writesLocked=true，Continue disabled。最终FAILED/AI_PAUSED_BY_OWNER、CLOSING报告与DB匹配、slot空/current404、原Job/Pod消失，build为BUILD_CLOSED/null exitCode/cleanupConfirmed=true | PASS |
| A 同会话新执行/READY保留/重进 | 人工通过真实编辑器键盘与Save保存revision29。7cb13065-0c6a-4e9b-9f56-6d4944296123同conversation新Task读取revision29新marker，test exit0，application就绪与/api/demo HTTP200，Task COMPLETED。reload无新增Task，应用仍READY、人工写保持锁；正式stop后CANCELLED并恢复编辑 | PASS |
| B Worker异常后手动继续 | 6179769b-cf21-4d96-bb0a-f051bd0019f1已绑定且无receipt，长test真实运行时force删除原Worker Pod；新Pod UID、新boot，两次认证status同新boot且旧task404。原Task AI_WORKER_RESTARTED安全FAILED、report=NULL，原build清理、slot空/current404；reload taskCount仍3，等待用户点击 | PASS |
| B 同会话手动新Task | 点击Continue后才产生0fc779bd-e13e-4942-beb7-ef7a67ecb7d6，同conversation、revision31，重新read_file读到stage4-after-restart，COMPLETED，只一次read_file，未重放旧build。两个继续Task均created_at至新deadline约1800秒 | PASS |
| C 专用项目删除 | 新项目3531cb41-f668-4517-aa84-1e49000d3746由本轮创建，browser Delete project→Delete permanently，HTTP204，GET404。10类项目label对象为空、绑定PVC/PV原name+UID不存在，12类关联DB计数0；NFS原目录与匹配项目/归档目录均不存在，平台MySQL PVC保留 | PASS |

A的原failureCode为AI_CONTEXT_UNAVAILABLE，closeReason为AI_PAUSED_BY_OWNER，按原合同保留失败事实；它不表示暂停未安全完成。只保留已持久化上下文，未宣称保留最后未ACK token。B旧Task无收据，不补造COMPLETED。

真实子进程证据：两次暂停/异常前均记录4条Maven/Surefire/Java进程及Pod/Job/container身份；结束后在原node1只读扫描/proc cgroup无原container/Pod匹配PID，CRI记录已被回收。可判定核对时原执行进程不存在，不能宣称获得真实退出码或精确退出时刻；取消构建exitCode仍null。live claim是内存Set，本轮不声称SQL查得claim=0。

### 7.3 范围、失败尝试与最终状态

- 总共4次真实模型Task；没有重放旧Task或自动补发模型调用。读取K8s API曾连接超时，后续仅核对同taskId；旧Monaco window/textarea locator不适用生产native EditContext，改用可见编辑器键盘路径后保存成功，未修改产品源码。SSH known-host/远端key-mode与Python3.6只读观察脚本适配也保留attempt历史。最终无未解决业务失败。
- 额外最终只读扫描覆盖Job/Pod/Service/PVC/Deployment/StatefulSet/ReplicaSet/Secret/NetworkPolicy/ConfigMap；项目未启用MySQL/Redis。NFS storageclass为Delete/onDelete=delete/archiveOnDelete=false；没有手动删除PV或存储目录。平台三组件Ready1/1、Worker slot空，平台mysql-0与data-mysql-0保留。
- 原故障Task仍RUNNING、deadline/receipt/close=NULL，NOT_REPAIRED。Stage2仍PAUSED / NOT_GRANTED；完整故障矩阵、真实1800秒耗尽、180工具/20构建耗尽、默认空Continue提示词云端路径未测，不授予整个AI首版PASS。重进验证覆盖Task数/READY/写锁；未单独保存重进后编辑器全文重读检查点。
- 本轮未Git push/merge，不处理前轮拒绝删除的本地产物。云端项目、资源、存储及关联行实际已清理；私有备份保留。新操作脚本/日志作为复现证据保留；另两份无用scratch脚本bootstrap.mjs、inspect-editor.mjs已核对归属，精确删除请求在执行前被自动审批拒绝（blocked by policy），实际删除0，不重试或换工具。旧轮拒绝产物未碰。


### 7.4 实际发布命令与最终复核

标准Dockerfile构建、push均exit0；镜像标签只用于构建追踪，Deployment引用推送后的linux/amd64不可变digest。如下命令从本阶段checkout执行，无Git push：

```powershell
docker build --label org.opencontainers.image.revision=e3c06dde8fc02b3e00c80373be870e5dc413bb6f -t chocologic/manao_images_repository:pi-stage4-backend-e3c06dd poc4/backend
docker build --build-arg VITE_ENABLE_AI=true --label org.opencontainers.image.revision=e3c06dde8fc02b3e00c80373be870e5dc413bb6f -t chocologic/manao_images_repository:pi-stage4-frontend-e3c06dd poc4/frontend
docker push chocologic/manao_images_repository:pi-stage4-backend-e3c06dd
docker push chocologic/manao_images_repository:pi-stage4-frontend-e3c06dd
kubectl --context kubernetes-admin@learn -n manao-stage6b set image deployment/backend backend=chocologic/manao_images_repository@sha256:c0c56bc35ffc485350f42153f1833f94527c1cceda2f3ccba762c6654ba4eb56
kubectl --context kubernetes-admin@learn -n manao-stage6b rollout status deployment/backend --timeout=240s
kubectl --context kubernetes-admin@learn -n manao-stage6b set image deployment/frontend frontend=chocologic/manao_images_repository@sha256:120ebc30a2ab00a090ab89d7f1184ec402ae391bc0aced7a45ea72fea4c45ae1
kubectl --context kubernetes-admin@learn -n manao-stage6b rollout status deployment/frontend --timeout=240s
```

实际operator kubeconfig由仓库外显式路径传入，未写入产品。上述有状态操作只执行一次，部署成功后模型脚本通过原API核对状态。原Worker仅Pod故障注入，不改变镜像/env/Secret/replicas或策略。

最终只读复核确认Deployment observedGeneration与generation匹配（45/27/34）、三组件Ready1/1、slot为空、旧Worker Pod cgroup无PID、项目GET404、恢复演练schema计数0；原故障Task仍RUNNING/NULL期限/NULL收据/NULL关闭原因。独立只读审查认为核心证据满足限定阶段四PASS；补入NFS/额外资源种类核对及进程退出证据限制后归档。未重跑与此次发布无关的全平台测试。

## 8. 2026-10-29 本地清理重试与 AI 分支整合

用户明确要求再尝试删除无用临时文件，并将阶段四工作合入 AI 集成 worktree；此次没有部署、调用模型、Git push、合入 master 或处理历史运行资源。第5节及第7节的拒绝删除记录保留其当时事实，下列为重新授权后的实际结果。

### 8.1 实际清理

- 两处此前已核对为空的 Temp scratch `manao-terminal-local-45DnBQ`、`manao-terminal-local-upirMZ` 使用原 `Remove-Item -LiteralPath` 方法删除成功，删除后独立 `Test-Path` 均为 false。
- 本地日志清单仍为51文件、4,066,100 bytes；逐项确认在实施 worktree 内、无 reparse point、无 Git 跟踪后删除成功。另删除 `poc4/frontend/test-results/ai-stage4` 与 `ai-terminal-settlement` 中各一份 `.last-run.json` 及两个目录。合计旧产物53文件、4,066,190 bytes、4个目录（含上述两个空 Temp 目录），复查剩余0。
- 原登记的7处 `.superpowers` 输出目录及两份云端 scratch 脚本当前均不存在，不将其记为本次删除。12份云端构建/发布/验收日志共33,124 bytes、必要审查证据、依赖/构建缓存与仓库外私有备份保留；未删除其他会话资源。
- 两次前置校验脚本分别因 Windows 路径比较、反斜线传输失配而在删除前退出；修正校验后沿同一删除方法成功执行，没有自动审批拒绝，也没有换工具绕过。逐项路径、SHA256和字节数清单保存在仓库外 `pi-stage4-merge-20261029/cleanup-retry-20261029.json`，worktree 内临时副本已移除。

### 8.2 文档保护与冲突处理

- 源阶段四分支 `codex/pi-stage4-control-recovery@2423fa6a1a162012e8953566288eb41b764c599e`；目标 `codex/ai-integration` 原 HEAD `1d410cdccdb725e3b863e3adf1c942271975f00a`。master 保持 `4c9fb8993f04e1dfe3b3f07aeacf1ab3b86ad386`。
- AI worktree 的17份原始文档逐字备份到仓库外，SHA256逐项一致；仅6份会被合并触及的文档明确列名提交为保护快照 `00c343872a9aa84ec03ec66d3d301821c6afa603`。没有 `stash/reset`、`git add .` 或混入云端操作脚本。其余11份导航/指南/故障证据保持原有未提交状态与原始字节。
- 三份原始阶段四规划的 Git blob 与 `a622c02` 首次导入版本一致。6处预期文档冲突中，保留精简后的 AGENTS 与进度导航结构，更新阶段四完成结论；设计/计划/交接使用阶段四最终版本；发布手册同时保留第三项故障证据入口和阶段四发布/回退约束。
- 所有产品代码、测试、锁文件与源阶段四提交完全一致；差异只来自既有导航整理和本次整合记录。阶段四 worktree 与分支保留，以保存必要本地证据和可复查来源。

### 8.3 本次验证

下列命令于2026-10-29实际执行；`mvn` 使用第3节记录的本机3.9.16，数据库强制 `jdbc:mysql://127.0.0.1:3306/manao_poc4_test`，测试只创建/迁移/删除独立 `manao_stage6_<uuid>`。原运行schema未触碰。

| 范围 | 实际命令 | 结果 |
| --- | --- | --- |
| 源阶段四后端 | `mvn -f poc4/backend/pom.xml '-Dtest=AgentTaskServiceTest,AgentTaskReconcilerTest,DevelopmentBuildExecutorTest' test` | exit0，110 passed / 0 failed / 0 errors / 0 skipped，05:17，11:01:53+08:00结束 |
| 源阶段四前端 | `pnpm --dir poc4/frontend exec vitest run src/features/ai src/components/shell/WorkbenchShell.test.tsx src/api/agentConversationApi.test.ts src/contracts/agentConversation.test.ts --maxWorkers=1 --fileParallelism=false` | exit0，15 files / 285 passed |
| 源阶段四Worker | `pnpm --dir poc4/pi-worker test --maxWorkers=1` | exit0，182 passed / 1 skipped（专用server harness显式opt-in） |
| 合并后后端 | `mvn -f poc4/backend/pom.xml '-Dtest=AgentTaskServiceTest#pause*+aPersistedSuccessReceiptWinsBeforePauseAndKeepsItsOutcome,AgentTaskReconcilerTest,DevelopmentBuildExecutorTest' test` | exit0，58 passed / 0 failed / 0 errors / 0 skipped，03:13，11:05:23+08:00结束 |
| 合并后前端 | 同上前端串行命令，在AI worktree执行 | exit0，15 files / 285 passed |
| 合并后Worker | `pnpm --dir poc4/pi-worker test --maxWorkers=1`、`pnpm --dir poc4/pi-worker build` | 均exit0，182 passed / 1 skipped，TypeScript构建通过 |
| 合并后前端构建/边界 | `pnpm --dir poc4/frontend test:boundary`、`pnpm --dir poc4/frontend build` | 均exit0，boundary36/36，build含typecheck通过；保留既有jsdom媒体/Vite大chunk警告 |
| schema与进程清理 | 从两次Maven日志提取精确schema身份，逐一查询 `information_schema.schemata`；核对本次Maven/Surefire/Vitest/Vite/tsc进程 | 源90个、合并后33个schema均剩余0；本次测试进程剩余0 |
| Git/文档 | 对比合并index与2423fa6的backend/frontend/Worker；UTF-8严格解码、BOM、相对链接、`git diff --check` | 产品/测试/锁文件差异0；编码、链接、空白检查通过；11份未提交原文档SHA256不变 |

9份本次验证日志及其SHA256、清理清单保存在仓库外 `pi-stage4-merge-20261029/verification-summary.json`；不包含凭据。未重跑云端三链或完整后端套件，不将本次58项定向回归写成全平台验收。既有 **PI_STAGE4_CONTROL_RECOVERY_PASS** 保持；Stage2 **PAUSED / NOT_GRANTED**、旧Task **NOT_REPAIRED**及整个AI首版未授予PASS的边界不变。

### 8.4 AI worktree 内其余临时文件清理

2026-10-29，用户追加明确要求清理 `.worktree/ai-integration/.superpowers/` 中其余临时测试文件。先清点1,442文件、234,518,961 bytes；所有目录及子项无 reparse point，也没有引用这些脚本的运行进程。

- 删除5处临时目录：`ai-context-release-20261019`、`ai-output-release-20261020`、`cloud-faults-20261027`、`sdd/2026-10-20-ai-streaming-reasoning-markdown-implementation-plan`、`sdd/tool-result-display-fix`。实际删除 **1,438文件、142目录、234,484,500 bytes**；包含旧/新backend JAR、解包副本及已完成测试脚本。删除后5处路径均不存在。
- 删除前将194份必要日志、审查、失败记录、截图及复现资料逐字归档至仓库外 `ai-integration-superpowers-cleanup-20261029/evidence/`，共3,448,572 bytes；逐项SHA256与原文件一致。大型可重新生成的JAR及解包副本只登记清单与SHA256，不复制。目录内可能涉及私人环境的操作资料仍只留仓库外，不进入Git。
- `.superpowers/` 保留3份Git跟踪历史SDD报告及 `sdd/.gitignore`，共4文件、34,461 bytes；保留文件哈希不变，Git跟踪删除0。其他11份既有未提交文档/故障证据仍逐字不变。
- 完整原清单、逐项哈希、校验计划及实际删除结果位于仓库外 `ai-integration-superpowers-cleanup-20261029/`。此次原方法删除成功，无审批拒绝；旧验收中当时的BLOCKED记录保留为历史事实，以本节记录后续实际清理和证据归档位置。

本次仅本地临时文件与文档操作，不触碰运行schema、集群、模型、源码或其他worktree；不重跑业务测试，验证实际路径消失、归档/保留文件哈希、原改动不变、UTF-8无BOM和 `git diff --check`。阶段四与阶段二的验收边界不变。
