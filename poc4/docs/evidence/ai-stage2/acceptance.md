# Pi Stage 2 implementation and acceptance record

日期：2026-10-16。实现分支 `codex/ai-integration`；规划代码基线 `b2c6ec3`，实际开工 HEAD `66b8742bf2113e88c70374089789346bd435eb76`、工作区 clean，已验证 `b2c6ec3` 为其 ancestor（exit0）。Task 5 起点 `186a634`，五项实现的最终提交 `559f998c8fa8287968b3504387f4917f4f52bdf9`。本文件拥有第二阶段实施与真实验收的当前结论；索引只链接本文件。PASS / FAILED / SKIPPED / WAIVED_BY_USER / NOT_REVERIFIED / NOT_RUN 不混用。

## 1. 当前结论

Tasks 1–5 均已实现、逐项审查修复并提交。最终整分支 `66b8742..559f998` 经独立 Sol 规格/质量复审 **Approved：0 Critical / 0 Important / 0 Minor**。随后用户授权镜像发布、cluster rollout、真实模型/browser/operator验收；当前已部署，前七轮主场景均保留失败记录，尚未通过完整验收，**`PI_STAGE2_APPLICATION_FEEDBACK_PASS` 为 NOT_GRANTED**。当前发布、失败与修复边界见§9；第一阶段真实验收与 revision-cache 后续限制仍由 [Stage 1 §8](../ai-stage1/acceptance.md) 拥有，本轮不改写。

以下表格及§2–8保留**云端发布前的本地交付快照**：其中 NOT_BUILT / NOT_PUBLISHED / NOT_RUN、没有云端资源等描述仅对应当时，不是当前发布状态；后续实际结果由§9补充，不删除历史失败和过程记录。

| 证据范围 | 实际状态 |
| --- | --- |
| Backend 整合回归（计划指定 10 类） | PASS：230 tests，0 failures/errors/skips，BUILD SUCCESS；同一 backend 源码 `e3d3039`，本轮只运行一次 |
| Worker 最新实现 | PASS：35/35 tests，build PASS；Task 4 记录，Task 5 未改源码，不重复 |
| Frontend 全套单测 | PASS：73 files / 1397 tests，0 failed；Task 5 只执行一次 |
| Frontend production typecheck/build | PASS：Task 4 最新实现的 `pnpm build`（含 typecheck）；Task 5 无生产源码变化，不重复构建 |
| Stage 2 纯判定器与 mysql cell 解析 | PASS：审查修复后66/66 tests（原61项与5项stop证据变体），0 failed/skipped；有效 assertion RED 在实现前保存 |
| 新 E2E/config 的 `pnpm typecheck:stage6` | PASS；首次发现原 Stage 1 缺 `Locator` type import，最小修正后通过，无 Stage 1 行为变化 |
| Playwright 用例发现 | PASS：`--list` 发现 1 file / 2 tests；这不是浏览器运行 |
| 固定 fixture 在真实 production runner 的测试/HTTP 特性 | PASS：原始测试成功、ready200、Pi500+标记；临时副本修复后测试成功、Pi200；细节见 §4 |
| 确切 backend JRE 17.0.13 丢响应重发单例 | PASS：默认 2 次 GET；指定启动参数 1 次；不是完整 backend 镜像测试，见 §5 |
| 第二阶段三个发布镜像 | NOT_BUILT / NOT_PUBLISHED，无伪造 digest |
| 第二阶段 cluster rollout / 专用 AI projectId 配置 | NOT_RUN，未获该轮发布授权 |
| 第二阶段真实 cloud-model 修复 | NOT_RUN，现有 Secret 不构成授权 |
| 真实浏览器 R0/R1/R2、revision 点击、运行锁/stop/close | NOT_RUN，仅已编写并静态验证入口 |
| 真实同任务 operator ledger + Service + 独立公开 HTTP | NOT_RUN，纯 rows 与本地容器不能替代 |
| 真实集群 Job/Pod/Service/PVC/DB 清理验收 | NOT_RUN；本轮未创建平台项目/集群资源 |
| `PI_STAGE2_APPLICATION_FEEDBACK_PASS` | NOT_GRANTED |

## 2. 交付和提交

| Task | 已审查提交 | 交付 |
| --- | --- | --- |
| 1 | `994f7e7` | Agent active-Run admission、稳定 start Run 身份、Run/文件/build 互斥与目标限定 |
| 2 | `ec5c375` | application start/status/stop/logs、已持久日志、close/FAILED claim 收尾 |
| 3 | `e3d3039` | 已验证 Service 内有界 HTTP GET、单次发送/超时/结果与 JVM 启动约束 |
| 4 | `186a634419f11c601c76532f2348c419b894f87a` | Pi 六工具/提示约束、浏览器真实结果和 Run 导航/只读边界 |
| 5 | `559f998c8fa8287968b3504387f4917f4f52bdf9` | 固定 fixture、bootstrap、纯 verifier+只读 operator CLI、两项串行 E2E、发布清单/本记录与索引；两项 Important 已修复并复审通过 |

Task 5 文件：`frontend/tests/fixtures/ai-stage2/` 固定测试和 seeded controller；`scripts/ai-stage2-bootstrap.mjs` 创建专用无 DB 项目并启动 R0；`scripts/ai-stage2-verify-ledger.mjs` 导出纯判定并提供只读 CLI；对应 `.test.mjs` 为反例；`playwright.ai-stage2.config.ts` 与 `tests/e2e/ai-stage2.spec.ts` 提供真实入口。package/tsconfig/.gitattributes 只接线；Stage 1 spec 仅补遗漏 type import。发布步骤在 [Stage 2 release README](../../../deploy/ai-stage2/README.md)。

## 3. RED/GREEN 与整合验证

实际本地日志保存在本轮 ignored SDD 目录 `.superpowers/sdd/2026-10-16-pi-stage2-implementation-plan/`，不得把该私有路径作为 master 文档链接。

```text
poc4/frontend:
node --test scripts/ai-stage2-verify-ledger.test.mjs
  RED: 1 pass / 59 fail, permissive TDD scaffold wrongly accepted adversarial evidence
  GREEN: 61 pass / 0 fail / 0 skipped after ledger + mysql escaping implementation
pnpm test
  PASS: 73 files / 1397 tests, 77.79s (once)
pnpm typecheck:stage6
  initial FAILED: inherited ai-stage1.spec.ts missing Locator type import
  PASS after the one type-only import correction
pnpm exec playwright test --config playwright.ai-stage2.config.ts --list
  PASS discovery: 2 tests in 1 file, fake discovery-only env, no request/browser/model
```

最初 RED 日志输出路径写错，PowerShell 在 node 启动前拒绝重定向；不计为 RED。改成正确路径、显式 UTF-8 无 BOM 输出后，实际 59 个断言失败才是有效 RED。随后 mysql batch 转义新增用例先报缺少 parser 的失败，再实现 parser。node import 不读取环境、不连接数据库、不退出进程。判定器每个 PASS 都保留 `stagePassGranted=false`。

Backend 计划命令（root 已运行一次，不重复）：

```text
mvn -Dtest=AgentTaskStoreTest,AgentProjectToolsTest,AgentApplicationToolsTest,ProjectApplicationProbeTest,AgentTaskServiceTest,AgentInternalSecurityTest,RunControllerTest,RunObservationServiceTest,RunRecoveryServiceTest,RunLogIngestorTest test
230 tests, 0 failures/errors/skips, BUILD SUCCESS (17:54:36, 09:38)
```

RunController 外层报告 0 tests 是嵌套容器，实际 36 个 nested cases 已包含在 230；不把外层 0 tests 单独算 PASS。worker 的 35/35、build 和 frontend production build 来自 Task 4 最新已提交代码；本轮未变动这些生产源码。

纯判定检查全部项目 Run 的 created_at→finished_at 区间、工具 created_at→updated_at 与 start claim 区间；无法确定微秒先后或相等就 FAIL。R0 ready 与终态、停止确认、首 test0+实际 suite、同 R1 HTTP500/log marker、再次停止确认、COMMITTED FILE receipt与逐步 revision、末 test0、新 R2/200 都需真实行。stop 本身已证明目标终态、stoppedConfirmed=true且无active时可直接继续；否则需要后续新status。两种证据都必须与实际Run身份/revision/finished_at一致、先于下一次mutation，并核对当时全部项目Run无active，不强迫Pi冗余status。固定 fixture 的任何任务写入、额外未知 mutation、跨项目/伪 receipt、0 tests、skip、reportsDropped、unknown outcome、错路由/Pod UID、最终 body 不符都拒绝。

Task 5 审查修复：先新增正反stop变体，原判定器65项中2项正向断言失败；最小修正后65项通过。随后“另一Run覆盖stop观察时刻”反例先失败，再补全部Run的观察时刻核对；最终66/66通过。浏览器owner文件PUT在active Run时的既有契约是409 `PROJECT_LOCKED`，已精确纠正原错误断言，未更改后端。真实浏览器仍NOT_RUN。

operator CLI 只支持 canonical task/project UUID；SQL 显式按 task/project 限定，mysql CLI 直接 spawn，密码仅环境、错误只用固定脱敏代码。最终公开 URL 来自 owner API；读取 Service 的完整 selector 和主端口，独立 GET 前后核对 active Run/Service，随后重读全部 Run 防止跨时刻拼接。真实 CLI 采集本轮 NOT_RUN。

### 3.1 各任务有效失败、修复与通过证据

下列计数是不同阶段的执行样本，存在重叠，**不能相加成为唯一测试总数**；当前整合总数以 §1 的230 backend、35 worker、1397 frontend、66 verifier分别报告。以下摘要保存必要失败诊断，避免临时SDD清理后只留下“全绿”结论。

| Task | 有效RED与审查问题 | 修复后的实际验证/复审 |
| --- | --- | --- |
| 1 | `AgentProjectToolsTest#activeApplicationBlocksWriteAndBuildWithoutSideEffects` 与 `RunControllerTest$AgentRuns`：5 tests，4 failures/1 error，暴露缺互斥、browser stop未阻挡、Agent start走错授权路径；另completed-start授权case1 failure。首次审查2 Important：browser start解锁后late Job创建、Agent stop持锁等待IO | 三类回归88/88；受影响Store/Observation53/53；修复后Run边界8/8。Fabric8/endpoint新4case先2 failures/2 errors，最小requestStop/requestWithdraw实现后19/19与21/21通过。中途75-test组合有1个null log-ingestor测试装配error，不记组合PASS；补mock后最终8-case命令通过。两项Important均关闭，规格/质量复审Approved |
| 2 | terminal/close定向2 tests/2 assertion failures（FAILED过早释放、未进入目标stop）；日志authority2 failures；safe error allowlist1 failure。审查2 Important：误清理已拒绝的stop、并发build cleanup无claim；修复前定向2/2失败 | 原六类139/139；审查修复后受影响三类84/84（Application10+Tools33+Service41），0 failure/error/skip。completed validation拒绝stop不触旧Run；cleanup同一claim覆盖IO/结算。两项Important关闭，规格/质量复审Approved |
| 3 | 最小probe stub后网络8 tests/8 assertion failures；新HTTP工具3例被旧allowlist拒绝；orphan close1 assertion failure。最终78-test组合曾**FAILED：1 failure/1 error**（短body测试未真实reset、既有close竞态误假设单次抢锁必胜），不是通过 | probe/应用/HTTP边界25/25先通过。短body改真实ServerSocket reset，保留HTTP_UNAVAILABLE/null断言；close仅允许PROJECT_BUSY、registrar退出后同close重试一次。两项各自定向1/1通过；78组合仍保留历史FAILED，其余42 TaskService+11 Probe+23 Workspace cases当次通过。后来同一修正代码的计划10类整合**230/230通过**，没有遗留测试失败。规格/质量复审Approved |
| 4 | 纠正TDD流程后，worker8 failures/26 pass，frontend admission/result6 failures/30 pass；后续晚到结果、Run控制和prompt各有有效行为RED。审查1 Important：空/无效RunId结果导航抛出parser异常；修复前3 failures/110 skipped | worker35/35+build；frontend受影响范围192/192、最新panel36/36；导航修复定向7 pass/106 skipped（跳过为`-t`选择范围），最新production build含typecheck通过。Task5随后frontend全套1397/1397通过。审查Important关闭，规格/质量复审Approved |
| 5 | permissive判定器1 pass/59 assertion failures；mysql parser新增1 failure。审查2 Important：owner PUT错误码不符、confirmed stop仍被迫追加status。修复RED65例63 pass/2 fail；额外no-active反例66例65 pass/1 fail | 原61/61，审查修复后66/66，0 failure/skip；stage6 typecheck通过、Playwright仅发现2例。精确409 PROJECT_LOCKED；确认stop/新status两条证据均受实际Run/时间/项目无active约束。两项Important关闭，规格/质量复审PASS |

Task 4 曾在新测试前修改7个生产文件，违反本轮严格TDD。控制者要求把全部Task4自有生产改动从HEAD原字节恢复，删除临时备份、不保留修复参考patch；保留并补强行为测试，实际取得RED后重新做最小实现。旧四工具数量/旧RUN_ACTIVE期望的失败不冒充新行为RED。此流程错误与纠正明确保留，不回写成“从未违反”。初始日志路径错误、无效测试UUID、数据库环境变量拼写错误、Fabric8 stale resourceVersion等装配/设置失败也未算作有效行为RED或PASS。

主要复现入口（均为已执行记录，本次文档收口不重跑）：

```text
# poc4/backend: Task1初次三类GREEN；最终整合命令见§3
mvn -Dtest=AgentTaskStoreTest,AgentProjectToolsTest,RunControllerTest test
# Task1最后锁/目标边界GREEN（PowerShell参数整体引用）
mvn '-Dtest=RunControllerTest$RunCreationProtection,RunControllerTest$AgentRuns' test
# Task2审查修复后受影响范围84/84
mvn -Dtest=AgentApplicationToolsTest,AgentProjectToolsTest,AgentTaskServiceTest test
# Task3修正后的真实body-loss单例1/1
mvn -Dtest=ProjectApplicationProbeTest#enormousContentLengthDoesNotAllocateItAndEarlyBodyLossNeverPretendsToBe200 test
# poc4/pi-worker: 最新35/35与build
pnpm test
pnpm build
# poc4/frontend: 最新1397/1397、66/66、入口编译/发现
pnpm test
node --test scripts/ai-stage2-verify-ledger.test.mjs
pnpm typecheck:stage6
pnpm exec playwright test --config playwright.ai-stage2.config.ts --list
```

最终独立整分支复审审阅 `66b8742bf2113e88c70374089789346bd435eb76..559f998c8fa8287968b3504387f4917f4f52bdf9`，确认tracked工作区clean，规格/质量均Approved，0 Critical/Important/Minor。复审没有发现需重跑测试的新增风险，未重复suite或外部操作；复审批准的是本地交付，不授予真实阶段PASS。

## 4. 独立本地 Linux fixture 演练

root 在本轮独立执行，overall exit0。使用已接受 production runner `chocologic/manao_images_repository@sha256:59a83cb94ac271b24b837f6fe55a27a308cc6f67fee43a46ca628d03fdf85e98`，UID10001、只读 root、只读 `/source`、network none 执行原 `manao-dev-build copy`，实际复制 4 files / 1238 bytes。scratch 才覆盖既有 Stage 1 `acceptance-pom.xml`，不复制新工具链、不改用户/仓库 pom。

1. 原始 `test` 和 `package` 均 exit0，各自 Surefire **tests=1, failures=0, errors=0, skipped=0**，log-tail state=ok/truncated=0。
2. 启动原 jar，actuator readiness HTTP200；GET `/api/demo?name=Pi` 实际 **HTTP500**，日志含 `stage2-seeded-handler-failure`；独立期待200契约 **RED**。
3. 停止并确认旧本地容器后，在另一个临时 scratch 副本移除 seeded exception。其 `test` 和 `package` 均 exit0，各自 Surefire **1/0/0/0**；ready200，同 GET **HTTP200**，JSON `{"message":"Hello Pi"}`。
4. 固定测试 SHA256 `a7663e44983b9487ffe196ea5601b6aabe5d0e6f32a6488946ec2cea3296bf2c`；controller SHA256 `6b040a65b9659802d60e09955c172af70e6c8ae4af9c133591b943d274350ebb`。原完整 source fingerprint 与 fixture 字节前后不变。

这段修复由 operator 在临时副本控制完成，**不是 Pi 自主修复**。直接 jar 的 actuator readiness 不证明生产 `/health/ready`、Run supervisor、Service retarget 或云端环境。本记录保留实际HTTP、镜像、清理结果及必要失败诊断；临时原始输出完成核对后清理。Docker stop 的 `--time` 弃用提示不影响 exit0。

## 5. 确切 backend JRE 单例

`eclipse-temurin:17.0.13_11-jre`，实际 pulled digest `sha256:38e0afc86a10bf4cadbf1586fb617b3a9a4d09c9a0be882e29ada4ed0895fc84`。本地 javac `--release 17` 编译的单一 raw ServerSocket fixture 完整读取 GET headers 后无响应断开；客户端只调用一次 sendAsync、HTTP1.1、Redirect.NEVER。

- 默认 JVM：java=17.0.13，receivedGET=2，responseUnknown=true，期望2断言 exit0。
- 两项启动参数：`-Djdk.httpclient.redirects.retrylimit=1`、`-Djdk.httpclient.disableRetryConnect=true`，receivedGET=1，responseUnknown=true，期望1断言 exit0。
- 首次 PowerShell 未完整引用 `-D` 导致 main-class 解析错误；修正引用后才通过，不伪称首次执行成功。

这只证明确切 JRE 在该响应丢失场景没有隐式重发；不证明完整 backend 镜像、所有网络故障或 exactly-once HTTP。真实镜像发布仍需保留启动参数并核对运行命令。

## 6. 实际清理与外部边界

本地 fixture 专用 prefix `ai-stage2-local-62fa61a68d624ed8bdb7003bc9feda9a`：两个应用容器已删除，构建容器 `--rm`，最终 prefix inventory **0**；唯一 temp root 与私有 Maven cache 已删，loopback **38082 free**。原始仓库文件未改。确切 JRE 两个专用 `--rm` 容器的最终 name-filter inventory 为空。

root 的专用测试 MySQL 容器 `manao-ai-stage2-local-mysql-20261016`（ID `cfd6466e...`）：backend 测试后 disposable `manao_stage6_` schema **0**，精确 `docker rm -f -v` exit0，最终 name-filter inventory 空、匿名测试 data volume 移除。runtime schemas、local3306、cloud 未触碰。

临时SDD工作目录中的 **134个ignored文件为RETAINED**：按用户要求清理时，两次删除调用均在执行前被工具自动审批策略拒绝，未删除任何文件；返回仅说明 blocked by policy，未提供具体原因。必要失败事实与六项裁定已转入§3.1/§8。该未完成项是本地临时文档/日志清理，不是运行资源清理失败；上述Docker、临时fixture目录/cache/端口及专用MySQL清理结果仍为PASS。

本地交付时没有平台项目、R0/R1/R2、集群 Job/Pod/Service/PVC 或新 NetworkPolicy，平台/集群删除数为 **0 created / 0 deleted**；不能据此授予真实项目资源回收 PASS。后续授权云端发布创建的项目及保留状态见§9；owner stop/close、资源核对和最终删除按 release README 记录实际结果。

## 7. 范围与过度工程化复核

复用既有两张 Agent 表、Run/log/receipt authority、原 Job+Service、owner API/Run 面板和已有 MySQL CLI；Task 5 没有新生产 Module、table、migration、数据库驱动、SDK 升级、provider registry、HTTP代理或新依赖。六工具由 Tasks 1–4 实现，本阶段只有固定 GET 和日志 tail，不扩展 Shell、CRUD/MySQL、完整故障矩阵或两小时重跑。

验收代码只分纯判定、薄 CLI 采集和浏览器场景；脱敏失败与严格时间/身份检查直接服务 false-pass 风险。临时受控修复没有进入 bootstrap 或真实模型提示，不提供模型答案。后续必须完成的真实授权与证据缺项已逐项保留 NOT_RUN；不因本地通过自动发布、push、merge 或授予阶段 PASS。

## 8. 控制者六项实施裁定

按本轮作出顺序保存裁定、理由和错判代价；这些是已实现并复审的边界，不是新增待做框架。

| 顺序 | 裁定（what） | 依据（why） | 错判代价/所需约束（cost if wrong） |
| --- | --- | --- | --- |
| 1 | 保留既有occupancy接口，由外层application调用持有原live claim，跨RunService/ensureJob直到持久结果结算；Task1短锁内原子鉴权/插入，Task2完成claim/close seam。不新增通用release/callback接口 | 设计已把工具调用生命周期交给AgentProjectTools/AgentApplicationTools，RunService不拥有模型结果结算 | 若claim提前释放，close可越过late ensureJob，造成已释放任务又创建Run；必须保留阻塞IO与结算窗口的竞态回归，若边界不成立才重新评估接口 |
| 2 | JVM启动时设置retrylimit=1、disableRetryConnect=true，启动校验与测试使用相同参数；不在运行中System.setProperty | 默认JDK17一次sendAsync已复现两次GET，单靠Redirect.NEVER不禁止隐式重发；§5确切JRE样本补证1次 | JVM全局影响其他HttpClient路径，瞬态网络错误会更显式；已有worker/Workspace相关回归必须通过，且不承诺所有故障exactly-once |
| 3 | browser start保留原完整gate；仅为Agent在原JobCoordinator增requestStop，以短锁准备持久stop后在锁外发非等待删除请求 | 旧stop可等待60秒，持gate/monitor会阻断所需有界异步stop和观察；browser没有工具live claim保护late launch | 改动共享coordinator契约可能破坏旧caller；必须保留browser launch保护与定向回归，application live claim覆盖晚到IO；删除接受不等于退出确认 |
| 4 | 在原endpoint接口/Fabric8增加有界条件requestWithdraw(projectId,runId)，保留其他caller的原withdraw | 旧owned GET+edit重试/超时无此约束；锁外晚到withdraw不得撤掉更新Run路由 | UID/resourceVersion/selector变化可能使撤路由被拒绝；用条件patch与mock验证，失败记NOT_CONFIRMED并阻挡后续写/build，不能转为盲patch |
| 5 | build claim维持REGISTERED-only；application orphan RUNNING仅用窄命名Store入口回收观察/结果结算，复用同一live-claim set | 放宽既有build claim可重播已持久副作用；application重启恢复只需观察原身份 | 可能需要manual close/attention而无法自动重做缺失动作；这是fail-closed代价，不用重播换取表面进展，不造第二套claim registry |
| 6 | 修正既有close/registration竞态测试：phase3仅允许PROJECT_BUSY，竞争registrar结束后只重试同task的close一次；保留FAILED、行数上界、无执行、有界完成断言 | shared gate刻意tryAcquire，旧测试错误假定并发close一次必胜；Task3未改变该生产close路径 | 若放宽过度会掩盖持续锁泄漏；不允许无界retry或其他异常，最终release与原安全断言仍必须成立。历史78-test失败和后续230整合通过见§3.1 |

原临时SDD ledger/报告可在必要事实转移后由控制者精确清理；本文件保留裁定、有效失败、修复、最终结果与证据限制。临时日志存在或被清理均不扩大模型、集群、浏览器、业务验收结论。

## 9. 2026-10-16 授权云端发布与真实验收

### 9.1 当前判定、授权与环境

**`PI_STAGE2_APPLICATION_FEEDBACK_PASS`：NOT_GRANTED。** 前七轮主场景保留失败：第一轮provider拒绝schema，第二轮预算耗尽，第三轮operator拒绝，第四轮progress工具详情404，第五轮模型修改固定验收测试、被fixture字节不变检查正确拒绝，第六轮operator正确拒绝AMBIGUOUS_TOOL_ORDER、已确认worker提前unknown后继续后台build的生产缺陷，第七轮COLLECTION_RUN_CHANGED首次快照未留存、原因UNKNOWN且调查已暂停（§9.10/9.13）。判定器修复`77fe238`及harness修复`668eb0c`均独立Approved 0 findings，相关104/104及stage6 typecheck通过；第三轮后续operator单独PASS且`stagePassGranted=false`不补齐browser main/close。提示词已澄清并完成fixture/controller恢复；第六轮失败不据此放宽工具时间顺序判定。

用户在本地交付后授权实际镜像发布、cluster rollout、真实模型及browser/operator测试，指定公网端口**30003**；明确禁止Git push/merge，未改变。发布开工HEAD=`3b58568539e8db0d85318cf951c4170db21e3336`、tracked工作区clean；context=`kubernetes-admin@learn`，namespace=`manao-stage6b`，浏览器入口`http://1.12.245.235:30080`。使用现有worker模型Secret，不输出/提交凭据；V12已存在，无新migration，runner不变。授权不包含删除既有项目或共享资源。

### 9.2 实际镜像、源码与部署身份

镜像仓库前缀均为`chocologic/manao_images_repository@sha256:`，以下是2026-10-16验收轮次的实际push历史快照；当时使用backend、工具ID修复frontend、settlement-r5 worker及原runner。后续2026-10-17/18的backend和worker替换见§9.13；后续源码修复不会自动改变已部署镜像。

| 组件/轮次 | 源码边界 | 实际digest |
| --- | --- | --- |
| backend runtime，后续已替换 | `3b58568`生产backend源码 | `28e709556a56eb6c6c2a110735479d17504c9f90b10850e995cfaabeeb2948a6` |
| frontend初轮，已替换 | `3b58568`及Docker/corepack修正`2b89840` | `0b275310c472845ae2b7e194b57c84e521034b2565fa3e42f836de4bc14563f6` |
| frontend工具ID修复，当前 | `0589a765edf1b1f6dd246cf1c7814dbd40baff95` | `6f803accccd627b9b565507068482e70d0c3c4175566d407d180923536a8e532` |
| worker初轮，已替换 | `3b58568` | `16c5c6ab4b53cda1da58a0349ab5002c3f5af4c59ac6f297ecf1cbc2ca3c84f5` |
| worker schema修复，已替换 | `1abf696` | `8c3ef5b9c560632f302bdd77b4e63fefeb0474706173b7a02e8e617502719d94` |
| worker安全诊断，已替换 | `a9dab89bd3d1aba86ea138f643965c18198520d3` | `8d2ffe150317b4b6b2feb0847750750148f0d0624e6798e65ad22bc5481847f1` |
| worker bounded busy修复（busy-r4），已替换 | `3bd334a1eef61d09965ade454cf9358f363d24c5` | `8630742428e8dbaafcb035213200b20db2cf353f47c0e70c25046216cb5ee3c5` |
| worker settlement/fatal修复（settlement-r5），后续已替换 | `70c09851a894feab5847d19208b61e020d409552` | `242369ef1c159e1f4e4a7bfd8f10eab0b878f6ce977571208bfde72dec651c50` |
| accepted Maven runner，未改 | 本阶段无源码变化 | `59a83cb94ac271b24b837f6fe55a27a308cc6f67fee43a46ca628d03fdf85e98` |

backend标准多阶段构建的`dependency:go-offline`未完成；实际使用本地缓存Maven打包的jar复制到确切runtime层，不记为原多阶段Docker完整构建PASS。package为BUILD SUCCESS、7.181s（2026-10-16T22:44:20+08:00），jar SHA256=`e7c4d55a6696fc2b0b7fbf3e8021c66c4cbd6fc2994ddbcb16bd6fbd8b11ec88`；runtime=`eclipse-temurin:17.0.13_11-jre@sha256:38e0afc86a10bf4cadbf1586fb617b3a9a4d09c9a0be882e29ada4ed0895fc84`，保留§5两项JVM参数。

backend/worker按单实例停旧再启新，无新旧重叠。采集的backend Pod=`backend-558874c8d-kmr22`、UID=`c964d004-a4eb-4137-815e-74691ee4b4b7`；frontend Pod=`frontend-695668885d-ngdr5`、UID=`c50ef83a-7425-4509-aefb-18a3d15a04a7`；busy-r4 worker Pod=`manao-pi-worker-5bbcf4b96b-g6cjr`、UID=`66ee2f76-f666-42e1-9378-8ce4ac15fa7c`，均已实际ready并核对对应镜像。诊断版旧Pod/旧identity文件不能当busy-r4部署证明。

随后settlement-r5已实际push/rollout，当时worker Pod=`manao-pi-worker-5fcff5cd77-68kwf`、UID=`8165f493-0e17-4f8c-a14d-e7a5e50deb92`，ready及imageID与上表对应digest核对通过；该轮backend/frontend不变。settlement-r5与busy-r4身份均只保留历史用途，最新已记录替换见§9.13。

### 9.3 专用项目与固定fixture

projectId=`905da5ae-40ef-469e-ba2b-5c0fd202070a`，name=`ai-stage2-7a11c73d`，creationKey=`03277d78-aabb-4f1b-bfbf-ccc6b09fdce3`，mysql=false、redis=false，端口30003→8080，endpoint=`http://1.12.245.235:30003/`。固定suite SHA256=`a7663e44983b9487ffe196ea5601b6aabe5d0e6f32a6488946ec2cea3296bf2c`，不得修改/删除suite。

初轮seed revision28、R0=`191bc472-ddaf-4554-bafe-23b1536db039`。第二轮失败后恢复seeded故障controller并保留suite；第三轮seed revision30、R0=`215f05c0-f6e8-4f10-b169-1fa7e8d584d4`，真实readyAt=`2026-10-16T15:11:44.0000000Z`。bootstrap summary已纠正为`R0_READY_AFTER_FAILED_ROUND`，不沿用初轮旧readyAt。

### 9.4 首轮失败及schema/工具ID修复

task=`65910d8a-6830-4cae-8c5d-5e71746e474d`：FAILED/AI_PROVIDER_ERROR、ledger工具调用0；browser主场景FAILED、close NOT_RUN。持久assistant错误明确provider HTTP400：application顶层union缺object type。R0未被任务修改。提交`1abf696`改为顶层Type.Object，保留action enum及optional runId/waitSeconds、additionalProperties=false，backend严格action校验不变；有效TDD **2 failures/34 pass→36/36+build PASS**，独立审查通过。

真实provider ID含`call_...`，旧UI/E2E正则漏underscore。提交`0589a76`把既有parser移入contracts供Panel/E2E共用，兼容underscore、长度上限64并保留原导出。MSW精确owner GET、结果点击与Run导航有效RED **3 failures/38 skipped**，GREEN Panel **41/41**、RunPanel **42/42**、stage6 typecheck/build PASS；独立审查通过，未重复1397全套。这些本地修复不能替代真实模型验收。

### 9.5 第二轮失败、只读诊断与bounded busy修复

task=`13157eca-5f3f-413a-a1cf-ef60f71e8921`：**FAILED/AI_BUDGET_EXCEEDED**，SDK61次工具尝试、ledger29行。R1=`63842e3f-2a3e-4b61-9cb5-0c1878eed70b`真实500，模型修复后R2=`3357d5d1-b18c-4a7b-b58e-0a7f7882dcbd`真实200；任务仍FAILED，不能凭500→200授予PASS。失败收尾R2 CANCELLED、无active、unsettled call0。旧SDK仅记录`tool call was refused (409)`，不能追认全部为PROJECT_BUSY。

提交`a9dab89`仅把固定allowlist code加入安全错误message，不输出rawbody/凭据、不增加retry；有效TDD **12 failures/36 pass→48/48+build PASS**、独立审查通过。随后只读task=`5739cbcb-87c4-4750-a0c8-4204fb518413`仅做10次application/status waitSeconds0，无write/build/start/stop；COMPLETED，10个SDK结果中6个明确409 PROJECT_BUSY、4条ledger，独立确认当时短锁争用。

提交`3bd334a`只处理exact409 PROJECT_BUSY：最多10s admission，先查询原task/call，唯fresh404可用相同URL/body/身份重发；已注册后仍用原720s settlement，lost replay保持AI_CALL_UNKNOWN。原60工具/8构建/1800s预算不变。有效RED **8 failures/46 pass**，另transport剩余timeout与lost-outcome各先1 failure；最终worker **56/56+build PASS**，独立审查Approved 0 findings，已实际发布busy-r4。

### 9.6 第三轮：task完成，browser主场景失败

task=`909de4e0-ca53-480e-8eed-c38ffd9def58`最终COMPLETED、failure=null；35条ledger：appHTTP3/application12/write1/read7/list8/build4。R1=`a7308dff-3881-492f-93c5-5c1455266324`、revision30，真实HTTP500及对应logs后CANCELLED；模型通过receipt修改源码并运行修复test。R2=`7f84a232-5443-441d-b314-525fc23c9358`、revision31、readyAt=`2026-10-16T15:31:32Z`，采集时RUNNING；后续已由owner正常stop、确认停止并恢复seed，不能把此历史采集状态当当前active Run。

浏览器真实取得200/`Hello Pi`并通过`View run`导航，但当时operator以**UNKNOWN_TOOL_RESULT**拒绝，browser E2E实际为**1 failed / 1 not run**，close NOT_RUN。task COMPLETED、局部浏览器成功及后续operator重验均不覆盖这次失败。

判定器随后先修正确定无副作用的stop拒绝结果，**78/78**通过；再补目标HTTP子链、严格验证全部extra HTTP调用，**92/92**通过。独立review又指出既有判定仅检查mutation/Run，缺少全项目Run/Run区间排斥检查，属于Important；有效RED为**93 pass / 3 failures→96/96 PASS**，最终独立Approved并提交`77fe238`。最终判定器对同一run3重新采集operator为PASS、`stagePassGranted=false`（`operator-run3-final-verifier.json`）；旧operator PASS不授予阶段PASS，也不覆盖该轮browser失败。

### 9.7 第四轮失败与harness结果采集修复

第四轮task（ID前缀`5079867a`）COMPLETED。R1=`99971d3a-53ec-45ed-acb4-bca08baf3f3a`、revision32、CANCELLED；R2=`3d1efbab-a55b-44a3-93f7-53d68b6d0c42`、revision33、readyAt=`2026-10-16T15:50:23Z`，采集时RUNNING。browser读取progress `tool_end`的`call_00_gpBp50CIFnXKWTMLJSoo7558`详情，owner route返回404 ENTRY_NOT_FOUND，主场景**1 failed / 1 not run**、close未触发。

调查确认该ID在DB中0行，worker记录登记前409 AI_CALL_UNSETTLED；SDK的tool_end包含失败尝试，不能推定每个progress ID都有持久结果。harness修复只把404记为missingIds；独立operator要求missingIds与已严格验证的durable ledger IDs不相交，所有已登记unknown/unsettled/error仍拒绝，不把404豁免成成功。手工operator原采集先后留下INDEPENDENT_ACTIVE_CHANGED和OWNER_API_FAILED；后续两份仅增加安全诊断的副本重采PASS不抹除原失败，也不授予阶段PASS。

修复提交`668eb0c`已独立Approved 0 findings，**104/104（8 helper+96 verifier）及stage6 typecheck PASS**。首次helper缺模块失败不是有效行为RED；透明纠正为丢弃过早实现、用最小stub取得实际**0 pass / 8 assertion failures**，再重写GREEN。`77fe238`/`668eb0c`均仅harness，无需镜像rollout；当前backend/frontend/worker仍为§9.2的已部署digest。

第四轮R2后续已owner-stop、确认停止并恢复seed。第五轮R0=`651e01f1-3654-46f0-995d-5608212d192b`、revision34，readyAt=`2026-10-16T16:01:27Z`（北京时间已10月17日）。

### 9.8 第五轮：模型修改固定fixture，主场景正确失败

第五轮task=`bbbc69f9-7eaf-4082-8537-201adab5c466`最终COMPLETED、failure=null；R1=`bcbcfd16-3da8-44fe-8b8a-312c788722e5`、revision34、CANCELLED，R2=`5e69066d-ad79-4bef-afe4-f090bec5e6d7`、revision36、readyAt=`2026-10-16T16:04:09Z`，采集时RUNNING。模型进行了两次write，其中向固定`DemoControllerAcceptanceTest.java`追加`greetsPi`，违反固定fixture字节不变要求；browser `fixtureUnchanged`检查正确FAILED，实际**1 failed / 1 not run**，close未运行。

固定fixture写入receipt=`99b6039c-fdb6-42b3-9cba-9d5131a9ef15`，变更后SHA256=`283eb2f16bd07d6195c7eb32b9dddd9325a1f0cdeef65c84d55d6855fd340f5c`，与§9.3原suite digest不同；controller变更后SHA256=`dc4baa88270d5485dc5259db449da316802a735d7d6a1215632492170e039e44`。该轮实际HTTP依次为目标500→目标200→guest200，仍因固定fixture被改而FAILED；这些运行结果不能覆盖测试完整性要求。

这是实际模型失败，保留FAILED，不调整fixture要求或替模型修复。自然语言prompt现已澄清固定测试完整路径不得改、删或追加，可另建其他测试，不提供修复代码；独立Approved 0 findings，提交`7949823`，未新增仅检查字符串的测试，也未放宽fixture判定。第五轮R2已owner-stop并确认停止，固定fixture恢复§9.3原SHA、controller恢复seeded故障版本。

第六轮fresh R0=`70c79a09-57c7-4fb4-96db-8aeedc78aa30`、revision38、readyAt=`2026-10-16T16:07:43Z`，已实际ready。prompt/harness修正无需镜像rollout，生产镜像仍为§9.2记录；第六轮失败见§9.9。

### 9.9 第六轮：operator拒绝工具时间顺序

task=`e4771c7e-a43a-468b-a472-0f38d7b2f761`最终COMPLETED；R1=`b8887b91-7390-4e28-b4ca-e428da9ce5ca`、revision38、CANCELLED；R2=`3b66c34c-49a0-49d3-8d5a-5d4a73316a96`、revision40、readyAt=`2026-10-16T16:10:23Z`，采集时RUNNING。模型修改controller并另建`DemoControllerHttpContractTest.java`，固定fixture未改；operator以**AMBIGUOUS_TOOL_ORDER**拒绝，browser实际**1 failed / 1 not run**，close未运行。

证据中一条application工具区间与前一build的持久updated_at存在约1秒重叠。独立只读调查已实证确认**worker生产缺陷**：SDK顺序执行生效，但build工具在10秒时报unknown，后台build继续；后续status与后台build真实重叠，因此validator正确拒绝，不是时间戳误判。

busy-r4把可能已登记的replay POST错误地套用10秒admission预算，在查询原GET身份前退出；普通工具error又可被SDK吞下，继续执行后续工具。修复`70c09851a894feab5847d19208b61e020d409552`已独立Approved 0 findings：known-busy admission仍限10秒、不产生新身份POST；unknown POST之后查询原identity并沿用原720秒settlement，已登记长build正常等待结算。真正unknown的三个固定code在任务内先设置fatal latch，再调用`agent.abort()`而不等待；结算优先返回安全fatal失败，阻止后续副作用。普通参数错误及build非零仍可继续修复，不新增状态或framework。

有效client RED **4 failures/35 pass→39/39 PASS**；fatal路径有效RED **6 failures/21 pass**，最终worker **66/66及build PASS**。backend、SDK、migration均不变，10秒admission、720秒settlement及60工具/8构建预算不提高。`settlement-r5`镜像已实际push/rollout，digest及当前Pod身份见§9.2；第七轮未复现旧unknown错误但在采样一致性检查处FAILED（§9.10），代码GREEN和rollout不授予阶段PASS。

### 9.10 第七轮：operator采样一致性失败

第七轮准备已完成：第六轮R2 exact owner-stop并确认，原fixed fixture SHA不变；核验第六轮Pi新增extra test的路径/完整SHA并备份诊断后，单次owner DELETE成功，再恢复seed controller。新R0=`61d9e696-9546-478e-b4a5-a64f27f415e6`、revision42、readyAt=`2026-10-16T16:25:16Z`，已实际ready。仅清理失败轮次的新增测试，不扩大为生产项目资源删除授权。

task=`3d9d9bdb-0995-45a5-9bab-113a2d821fc8`最终COMPLETED、failure=null、settledRevision44；26条ledger均COMPLETED（build2/application9/HTTP3/list4/read6/write2）。R1=`acf23f88-a2f2-4581-9f69-185631be7c69`、revision42、CANCELLED；R2=`8c0b2926-edce-4f32-a85e-0fef26f20ad2`、revision44、readyAt=`2026-10-16T16:27:10Z`，采集时RUNNING。固定fixture不变、取得真实目标500→200，但operator以**COLLECTION_RUN_CHANGED**拒绝，browser实际**1 failed / 1 not run**，close未触发。

第七轮首次失败的前后完整快照未保存，具体差异无法追溯。后续只读诊断读取18条Run，九个字段值和对象键顺序一致，原严格比较通过，没有证据认定JSON键顺序是首次失败原因。随后同task/R2的三次独立operator采集均PASS、`stagePassGranted=false`，各自保留[结果1](archive-20261016/operator-run7-independent-1.json)、[结果2](archive-20261016/operator-run7-independent-2.json)、[结果3](archive-20261016/operator-run7-independent-3.json)；它们是后续观察，不替代原[browser-run7失败](archive-20261016/browser-run7.txt)，不补齐close。诊断报告和后续采样由[归档清单](archive-20261016/manifest.json)定位。

首次原因仍为UNKNOWN，原轮次保持FAILED；调查与原模型验收已按用户要求暂停。第七轮未复现第六轮提前unknown旧错误，但不能据此宣布完整真实验收通过。后续授权worker预算发布保留settlement修复行为，见§9.13。

### 9.11 待补证据、资源与清理边界

当前保持**NOT_GRANTED**。先查明第七轮采样一致性失败根因；完整browser主场景（reload同task、真实editor内容、运行只读/精确409 PROJECT_LOCKED、正常stop后可编辑）、第二个owner-close场景与历史Run不变、同task的完整Run/工具时间/receipt/suite/Service/独立公开HTTP及资源核对仍需有效结果。未运行或未到达触发点的项逐项记NOT_RUN/FAILED，不能以独立operator旧PASS补close。

项目及workspace/PVC/稳定Service **RETAINED**，第三至六轮R2均已owner-stop并恢复seed，第七轮R2采集时RUNNING、后续状态待证；不删除既有项目、共享policy或资源，也不声称项目删除/0residual PASS。后续owner stop/close须记录实际Run及Job/Pod/Service结果。项目最终删除仍需明确owner授权。

§6原134个ignored文件的两次自动审批删除拒绝仍为历史RETAINED，不重试绕过，也不把134当成当前文件总数。本次新增release evidence为必要发布/失败/复验依据，保留；私有loader、rollback和原始凭据不进入提交。没有Git push/merge。

### 9.12 2026-10-17 暂停原验收收口：前端 Run authority/history 故障

用户要求先暂停 Stage 2 原验收收口，优先修复前端 `Unable to load run authority/history`：相关请求返回 HTTP 200，但 Run 响应为 `RUNNING`、`startedAt=null`。当前不推定它与第七轮采样失败具有同一根因。**`PI_STAGE2_APPLICATION_FEEDBACK_PASS` 仍为 NOT_GRANTED**；原 Stage 2 模型/集群验收继续暂停，禁止删除项目。本次故障的独立根因、TDD、审查和限定 backend 修复发布记录见 [Run recovery 修复记录](../../../../docs/superpowers/plans/2026-10-17-run-recovery-contract-fix.md)，沿用此前明确发布授权，修复验证不等于恢复原验收。

恢复原验收前仍需完成以下事项；本清单保存暂停时的未决状态，不把实现或局部结果改记为完整验收通过：

- 查明第七轮 `COLLECTION_RUN_CHANGED` 首次触发原因；目前原因不明，该轮 FAILED 不能改记为 PASS。
- 最新 null-safe `evidenceDiff` 已于2026-10-18完成独立复审及108/108本地回归；保留严格FAIL语义。归档及提交情况见§9.13。
- 旧续验config/spec从未执行，绑定R0 revision42、task `3d9d9bdb-0995-45a5-9bab-113a2d821fc8`、R2 `8c0b2926-edce-4f32-a85e-0fef26f20ad2` / revision44；后续用户Run/源码已变化，该绑定失效。本次独立审查确认通用检查已存在于受跟踪`ai-stage2.spec.ts`，撤回并清理这两份重复一次性文件；不将其记PASS，续验仍NOT_RUN。
- 补齐 browser HTTP 结果展示、active 编辑锁的精确 `409 PROJECT_LOCKED`、正常 stop 后恢复编辑的真实路径证据，并完成 §9.11 的其他 browser 主场景检查。
- owner-close 仅停止本任务新建的 Run，核对 start rows、无未决 call 及历史 Run 不变，记录实际 Job/Pod/Service 结果。
- 完成 project-scoped 数据库与 Kubernetes 资源核查，保留项目/workspace/PVC/稳定 Service，不把保留状态写为删除或零残留 PASS。
- 最后补齐权威文档和提交记录；Git push/merge 仍未授权。

### 9.13 2026-10-18 记录核查、后续变更与本地整理

用户要求核查并补全之前的阻碍与后续变更记录，清理本地工作区。开工HEAD `0f66834`；当时§9、AGENTS/Progress/发布README、诊断verifier/test及一次性续验文件仍未提交。此次不恢复真实模型验收、不部署、不改变任何运行项目或数据库。

| 后续工作 | 已落盘及提交的证据 | 本阶段影响 |
| --- | --- | --- |
| Run authority/history红字 | 修复`16e030d`、发布记录`748d2ed`；[修复权威记录](../../../../docs/superpowers/plans/2026-10-17-run-recovery-contract-fix.md)：93/93 backend、126/126 frontend、独立Approved、2026-10-17限定浏览器检查通过；同Run补齐startedAt，未延长expiry | 已修复并发布；日志流Reconnecting未获PASS，也未证明与首次采样变化同源 |
| 所有当前用户READY项目可提交AI任务 | `2446ca2`、`2632f7e`；[准入记录](../ai-project-access/acceptance.md)及release JSON：16/16、backend发布、test1/test2 revision拒绝对照且未创建任务；该轮自审，未运行独立子代理审查 | 已取消单项目白名单；不证明业务/模型任务完成 |
| 180次工具 / 20次build | `aa7f282`、`0f66834`；[预算记录](../ai-task-budget/acceptance.md)及release JSON：72/72、独立Approved、worker构建/push/rollout、实际Pod两预算入口核对 | 已发布；总时长仍1800s，旧FAILED任务不自动恢复 |
| 第七轮诊断verifier | `2f712e3`；保留完整排序JSON严格比较、原FAIL code/exit1，仅增加九字段安全差异投影和缺失active快照的null安全处理；原RED 96pass/2fail→106/106组合，修正RED 98pass/2fail→100/100 verifier，报告见归档 | 本轮最终独立Approved；`pnpm exec node --test scripts/ai-stage2-verify-ledger.test.mjs scripts/ai-stage2-tool-results.test.mjs` 108/108、0skip，两个mjs `node --check`及diff检查通过；无真实operator重跑 |

最近一次已验证的backend为 `sha256:2472a61595c4a9b4f8b27ecf646dbd7f16788e9c935b0090c57f41ac907ba395`，worker为 `sha256:33c98b8a95d818d87f02638b64d0b93f69bc796d83802a233c5f964ca2e79a6b`；完整源码/Pod/回退对应关系由各自权威记录和[发布README](../../../deploy/ai-stage2/README.md)拥有。本轮集群API只读复核因timeout/EOF未完成，未取得新Pod/预算快照，不把旧发布证据表述为本轮实时健康PASS。

三次后续operator和首次失败最小证据共16份已检查凭据后归档（源文件54,773字节；七份browser日志去掉14个行尾空格后为54,759字节，源/归档SHA256均见manifest）；旧trace、私有loader、重复构建context和审查副本不进入提交。本轮本地清理的逐文件清单、实际数量、保留边界和验证由[工作区整理记录](workspace-audit-20261018.md)拥有。§6及修复记录中先前审批拒绝是历史事实，本次用户重新明确授权清理，新增结果不改写当时状态。

**剩余原验收事项仍为PAUSED / NOT_GRANTED**：首次采样差异UNKNOWN；完整browser主场景、精确编辑锁/stop恢复编辑、owner-close/start rows/未决call/历史Run不变、独立项目资源核查均未补验。Run记录/源码已变化，恢复时须先核对真实环境和固定fixture，不能直接套用旧续验身份或把三次operator PASS改记整轮PASS。

### 9.14 2026-10-19 用户确认第三阶段使命提前完成，第二阶段仍未通过

用户依据实际使用当前AI已能实现书籍数据CRUD，明确认为第三阶段提前完成其使命；该用户验收决定由[第三阶段确认记录](../ai-stage3/acceptance.md)拥有。用户同时明确“二阶段依然不视为通过”，因此本记录的原FAILED、PAUSED / NOT_GRANTED及未补验事项均保留。第三阶段的使命完成与本阶段工程验收分别记账，本次仅更新文档，没有恢复验收或新增运行证据。
