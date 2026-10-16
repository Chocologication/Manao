# Pi Stage 2 implementation and acceptance record

日期：2026-10-16。实现分支 `codex/ai-integration`；第二阶段代码基线 `b2c6ec3`，Task 5 起点 `186a634`。本文件拥有第二阶段实施与真实验收的当前结论；索引只链接本文件。PASS / FAILED / SKIPPED / WAIVED_BY_USER / NOT_REVERIFIED / NOT_RUN 不混用。

## 1. 当前结论

Tasks 1–4 已实现、审查并提交；Task 5 验收资产与本地验证已完成，等待本轮独立审查/提交。**没有进行第二阶段云端发布、真实模型修复或浏览器运行，`PI_STAGE2_APPLICATION_FEEDBACK_PASS` 为 NOT_GRANTED。** 第一阶段真实验收与 revision-cache 后续限制仍由 [Stage 1 §8](../ai-stage1/acceptance.md) 拥有，本轮不改写。

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
| 5 | PENDING_REVIEW_COMMIT | 固定 fixture、bootstrap、纯 verifier+只读 operator CLI、两项串行 E2E、发布清单/本记录与索引 |

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

## 4. 独立本地 Linux fixture 演练

root 在本轮独立执行，overall exit0。使用已接受 production runner `chocologic/manao_images_repository@sha256:59a83cb94ac271b24b837f6fe55a27a308cc6f67fee43a46ca628d03fdf85e98`，UID10001、只读 root、只读 `/source`、network none 执行原 `manao-dev-build copy`，实际复制 4 files / 1238 bytes。scratch 才覆盖既有 Stage 1 `acceptance-pom.xml`，不复制新工具链、不改用户/仓库 pom。

1. 原始 `test` 和 `package` 均 exit0，各自 Surefire **tests=1, failures=0, errors=0, skipped=0**，log-tail state=ok/truncated=0。
2. 启动原 jar，actuator readiness HTTP200；GET `/api/demo?name=Pi` 实际 **HTTP500**，日志含 `stage2-seeded-handler-failure`；独立期待200契约 **RED**。
3. 停止并确认旧本地容器后，在另一个临时 scratch 副本移除 seeded exception。其 `test` 和 `package` 均 exit0，各自 Surefire **1/0/0/0**；ready200，同 GET **HTTP200**，JSON `{"message":"Hello Pi"}`。
4. 固定测试 SHA256 `a7663e44983b9487ffe196ea5601b6aabe5d0e6f32a6488946ec2cea3296bf2c`；controller SHA256 `6b040a65b9659802d60e09955c172af70e6c8ae4af9c133591b943d274350ebb`。原完整 source fingerprint 与 fixture 字节前后不变。

这段修复由 operator 在临时副本控制完成，**不是 Pi 自主修复**。直接 jar 的 actuator readiness 不证明生产 `/health/ready`、Run supervisor、Service retarget 或云端环境。实际日志/HTTP body/image/清理结果已保留最小本地证据；Docker stop 的 `--time` 弃用提示不影响 exit0。

## 5. 确切 backend JRE 单例

`eclipse-temurin:17.0.13_11-jre`，实际 pulled digest `sha256:38e0afc86a10bf4cadbf1586fb617b3a9a4d09c9a0be882e29ada4ed0895fc84`。本地 javac `--release 17` 编译的单一 raw ServerSocket fixture 完整读取 GET headers 后无响应断开；客户端只调用一次 sendAsync、HTTP1.1、Redirect.NEVER。

- 默认 JVM：java=17.0.13，receivedGET=2，responseUnknown=true，期望2断言 exit0。
- 两项启动参数：`-Djdk.httpclient.redirects.retrylimit=1`、`-Djdk.httpclient.disableRetryConnect=true`，receivedGET=1，responseUnknown=true，期望1断言 exit0。
- 首次 PowerShell 未完整引用 `-D` 导致 main-class 解析错误；修正引用后才通过，不伪称首次执行成功。

这只证明确切 JRE 在该响应丢失场景没有隐式重发；不证明完整 backend 镜像、所有网络故障或 exactly-once HTTP。真实镜像发布仍需保留启动参数并核对运行命令。

## 6. 实际清理与外部边界

本地 fixture 专用 prefix `ai-stage2-local-62fa61a68d624ed8bdb7003bc9feda9a`：两个应用容器已删除，构建容器 `--rm`，最终 prefix inventory **0**；唯一 temp root 与私有 Maven cache 已删，loopback **38082 free**。原始仓库文件未改。确切 JRE 两个专用 `--rm` 容器的最终 name-filter inventory 为空。

root 的专用测试 MySQL 容器 `manao-ai-stage2-local-mysql-20261016`（ID `cfd6466e...`）：backend 测试后 disposable `manao_stage6_` schema **0**，精确 `docker rm -f -v` exit0，最终 name-filter inventory 空、匿名测试 data volume 移除。runtime schemas、local3306、cloud 未触碰。

本轮没有平台项目、R0/R1/R2、集群 Job/Pod/Service/PVC 或新 NetworkPolicy，平台/集群删除数为 **0 created / 0 deleted**；不能据此授予真实项目资源回收 PASS。以后真实验收的项目未获删除授权时记录 RETAINED 与清单；owner stop/close、资源核对和最终删除按 release README 记录实际结果。

## 7. 范围与过度工程化复核

复用既有两张 Agent 表、Run/log/receipt authority、原 Job+Service、owner API/Run 面板和已有 MySQL CLI；Task 5 没有新生产 Module、table、migration、数据库驱动、SDK 升级、provider registry、HTTP代理或新依赖。六工具由 Tasks 1–4 实现，本阶段只有固定 GET 和日志 tail，不扩展 Shell、CRUD/MySQL、完整故障矩阵或两小时重跑。

验收代码只分纯判定、薄 CLI 采集和浏览器场景；脱敏失败与严格时间/身份检查直接服务 false-pass 风险。临时受控修复没有进入 bootstrap 或真实模型提示，不提供模型答案。后续必须完成的真实授权与证据缺项已逐项保留 NOT_RUN；不因本地通过自动发布、push、merge 或授予阶段 PASS。
