> **历史来源 / 2026-09-17 已被现行记录取代：** 当前 6A 范围、验收决定和证据以[唯一现行事实现状](../../../../../../docs/Stage6A-Current-Facts.md)为准。下文保留原时点的设计、计划和结果；其中“当前”、待实施、FAILED/不允许 6B 等只描述旧时点，不覆盖本次用户验收决定，也不自动授权重新执行。原始结果不改写。此链接指向主检出的单份文档，不复制第二份现状。

# 阶段六现状、证据保留与下一步（2026-09-10）

## 1. 当前结论与证据边界

- 代码基线（清理切片实现）：`f5b5037` 及后续 C01–C08/C08 重启/runner 修正。2026-09-13 cleanup invocation `8c7255f7`：Playwright 8/0/0（含 C08 重启 59.3s），独立 verifier 1/0/0/0，十条台账 `VERIFIED`。basic invocation `d7e6f809`：5/0/0，verifier 1/0/0/0，四条台账 `VERIFIED`。身份 `manao-6a-local`；诊断 `083b8efd` rv 仍为 15521700 / 14891340。压力/故障未跑。basic 第 4 项仍接受任一 Run 终态，不是 Maven 成功与 Run/Job 一致。详见 [cleanup-acceptance.md](cleanup-acceptance.md)。这不是 6A PASS，也不能开始 6B。
- **基础 real-backend E2E：用户报告集群重启后在沙箱外 5/5 PASS。** 已读取 `poc4/frontend/test-results/.last-run.json`：`status=passed`、`failedTests=[]`，文件修改时间为 2026-09-10 18:32:06 +08:00。该文件没有用例数量、耗时、集群身份或 Run 结果；这些细节不能从它独立证明。最新一次没有留存完整 JSON/list 报告，也不把 09:50 的旧报告冒充本次报告。
- **完整 6A Gate = FAILED（关键验收未闭环），6B 未开始，阶段六未完成。** 历史失败已经被解决的部分与待验收部分分开记录，不再把模板写入/Fabric8 RESET 列为当前已证实阻断。
- [只读快照](2026-09-10-readonly-snapshot.json) 固定了核验时间、代码 SHA、本地 JAR/spec 校验和、末次运行状态、节点状态和残留资源。磁盘 JAR 校验和不是“当前 JVM 加载了该 JAR”的证明。
- 原始阶段计划的 Task 9A 要求完整 Job/日志/PTY/audit、故障恢复和动态 bridge 证据；关键项 `SKIPPED` 或 `WAIVED_BY_USER` 不算 PASS。[实施计划](../../plans/2026-08-27-ensoai-stage-6-real-backend-kubernetes-implementation-plan.md)

## 2. 已落地的关键变化

| 变化 | 基线/证据 | 当前边界 |
|---|---|---|
| 6A 默认使用 kubectl Pod port-forward | `4766b43`；同一 Pod 的 Fabric8 RESET 与 kubectl 健康检查对照；后续项目 READY 通过 | Fabric8 仅作显式对照，不能将旧 RESET 推断为每次失败原因 |
| 运行库隔离、文件创建 HTTP 201、Job selector | `b61066b`；`FlywaySchemaTest` 使用 disposable schema；Job 不再手工设置 selector | 测试库 DDL 权限与运行库业务权限是不同问题 |
| 登录、owner 隔离、真实模板/文件保存/版本冲突、Run 创建与终态 | 用户最新 5/5；保留的历史机器报告 | 主要经 Playwright APIRequest 验证，不能替代完整编辑器、日志、PTY、audit UI 演示 |
| 项目清理 API 与基础套件 afterAll | `c974630`；owner-scoped DELETE、数据库关联记录清理、Kubernetes Job/Pod/Service/PVC 清理 | 正常路径通过，不代表失败/并发/中断路径可靠 |
| 每用户项目上限 8 | `f4c79f2` | CREATING/READY/FAILED 都计数；不是节点 CPU、namespace quota 或存储容量保证 |

历史 09:50 机器报告为 5 passed / 0 failed / 0 skipped、132.34 秒，使用临时管理员配置；它仅作为历史正常清理结果保留，**不能证明受限 RBAC 的完整 6A 验收**。

## 3. 本轮只读核验

- `master`、`node1`、`node2` 均 `Ready=True`；master 保留 control-plane NoSchedule 污点，两个 worker 无污点。节点查询使用操作者管理员身份，未授予后端 nodes 权限。
- 刷新后的受限 kubeconfig 可认证为 `system:serviceaccount:manao-stage6-test:manao-6a-local`；抽查 create jobs、delete pods、create pods/portforward 为 yes，get secrets/get nodes 为 no。这只是抽查，不是重新执行完整 26 项 preflight。
- `4173`、`18080`、`6443` 存在监听；不把“端口监听”当成完整 readiness 或业务健康证明。
- namespace 中仍有失败项目 `083b8efd-9f57-4cb4-aa6f-646b37bd6d57` 的 Succeeded initializer Pod 和 Bound PVC；数据库仍为 `FAILED / CREATION_FAILED`、revision 0、无 Run。另有原先的 `null-receipt` 诊断项目，未修改。
- 当前未看到其他 stage6 项目/标记资源，但这只是测试后的快照，不是本次运行逐项目、逐资源的前后差分审计。**不能宣称环境零残留。**

## 4. 未闭环问题与验收矩阵

| 项目 | 状态 | 必须补齐的证据/修复 |
|---|---|---|
| 五项基础 smoke/API E2E | PASS（用户报告，末次状态佐证） | 下轮固定 JSON/list 报告、SHA、身份与运行参数 |
| 模板初始化、文件保存与旧 revision 拒绝 | PASS（上述覆盖范围） | 完整浏览器编辑操作、receipt/recovery 与持久化内容仍按 Gate 检验 |
| 真实 Maven 成功、Run/Job 终态一致 | SKIPPED（未重新核验） | 第 4 项只要求 SUCCEEDED/FAILED/CANCELLED/TIMED_OUT 中任一终态；需成功样例的 Job/Pod exitCode=0、DB/API Run=SUCCEEDED、日志和解锁一致 |
| initializer 异常清理 | FAILED（源码缺陷及现场） | 删除与等待的 labels 范围一致；异常/未 READY 项目也删除 initializer，之后才删除 PVC/DB |
| 并发与中断清理 | SKIPPED（覆盖缺口） | CREATING/provisioning 与 DELETE 互斥；active Run 不可伪装成 404 清理成功；网络异常不能中止后续清理；创建响应丢失需状态核对 |
| 后端当前 SHA 的完整回归 | SKIPPED（未重跑） | 保留的 ProjectLimitTest 有 4 个失败，发生在 Flyway V3 / MySQL 1419；先配置隔离测试库适当权限，不能改运行库或用文件名 green 判断成功 |
| 真实 live/replay 日志、PTY、audit | SKIPPED（完整证据未提供） | 字节/sequence/结束帧、真实 Job 容器会话、resize/close、审计持久化/刷新可见 |
| 8 MiB 压力 | SKIPPED | `stage6-terminal-stress.spec.ts` 的两个测试真实执行并保存报告 |
| 动态 bridge 隔离与三类故障 | SKIPPED | `stage6-faults.spec.ts`；backend-restart、tunnel-loss、bridge-loss 分别执行，明确操作者身份/注入时间/恢复与 fail-closed 结果 |
| 独立 6A Gate | FAILED | 上述关键项无失败、无跳过，同 SHA、镜像 digest 和受限身份形成证据包 |
| 6B Task 10–12 | NOT_STARTED | 只在独立 6A PASS 后做集群内后端/数据库部署和复验 |

### 4.1 本次重启解决了什么，没有解决什么

2026-09-10 17:06:40 的调度事件明确为 CPU 不足、node1 unreachable、master control-plane 污点。第 4 项当时尚未启动 Run，不能归因为 MySQL 权限。重启后基础五项通过且节点已 Ready，说明这次调度阻断不再复现；node1 停止上报的底层原因未进一步诊断，不能宣称已永久解决。

失败清理则是独立源码问题：`ProjectProvisioningService` 在 workspace READY 后才删 initializer；`Fabric8KubernetesGateway.deleteProjectWorkloads()` 仅匹配 component=workspace，而 `waitForProjectWorkloadsGone()` 匹配所有项目组件。initializer 残留使 DELETE 等待 60 秒并返回 500，未进入 PVC 和 DB 删除。现场与先前 trace 的 60.18 秒吻合；未取得该请求的后端异常栈。重启不会修改这段代码。

### 4.2 历史 Run 不一致不能被五个 PASS 掩盖

2026-09-09 保留的 `verification-summary.json` 记录 Job succeeded、Pod Succeeded、exitCode=0，而数据库 Run 为 `FAILED / RECOVERY_FAILED`。该问题本次没有复验；当前五项测试允许 FAILED，不能关闭这个问题。下一轮应先收集同一 Run 的 Job/Pod/数据库/日志证据，再定位原因，不预设新的修复方案。

## 5. 下一步实施顺序（本轮不执行）

1. **先补可靠清理与回归**：异常 initializer、CREATING 并发、active Run 的明确冲突、清理逐项容错；基础用例改为每项结束及时释放，套件结束保留兜底。创建响应丢失时先查状态，不盲目重放写请求。失败诊断最多保留明确匹配的一份，采证后由明确清理操作回收。压力/故障套件也需统一清理策略。
2. **收紧 Run 验收并解决真实不一致**：成功样例必须验证 Maven 成功、Run/Job 一致、日志完整及文件解锁；失败/取消/超时分别验证，不能放宽断言凑绿。
3. **完成 6A 真实开发闭环**：浏览器登录、创建、编辑/保存、Run、live/replay 日志、活动 Job Shell、audit，再运行压力与三个独立故障阶段；记录退出码与 skipped，不能用 --list 替代执行。
4. **独立 6A 复核并固定基线**：代码 SHA、构建 checksum、镜像 digests、Flyway、受限 RBAC、节点调度容量、报告与资源/DB 清理结果都匹配。失败继续在 6A 修复。
5. **6A PASS 后执行 6B**：单副本 Recreate 后端、集群 MySQL、最小 ServiceAccount/Role、Secret/probes、安全上下文、实例 fencing，以及同一闭环/压力/故障的集群内复验。此后才判定 Stage 6 完成。
6. **POC4 完成后回到 Manao 产品规划**：优先单独设计最小 AI 辅助闭环（用户显式选择文件/运行日志 → 建议/补丁 → 用户确认 → 保存/运行反馈）。多语言、Git、团队/教学/管理、计费等另行拆阶段；面向不可信用户开放执行前，必须先完成隔离、凭据、网络和资源安全评审，不能把 POC 当作生产沙箱。

## 6. 证据保留与清理规则

本轮候选删除清单、文件 SHA-256、字节数和原报告统计记录于 [清理清单](2026-09-10-artifact-cleanup.json)：5 个过时报告目录与 2 份日志，共 16 文件 / 158,089 字节（154.38 KiB）。仅选择该 Stage 6 工作树内明确列出的旧日志/报告；已经核验绝对路径、reparse point、Git 跟踪状态与 checksum。**用户授权后已删除全部 16 个候选文件并移除 5 个空报告目录，释放 158,089 字节；清理状态为 DELETED。** 未使用 git clean 或 mvn clean。

保留：

- 最新末次运行状态，以及本次固定的只读快照；默认 test-results 可被下次测试覆盖，快照不可冒充完整报告。
- `poc4/frontend/playwright-report/stage6-real-backend-cleanup-verified-20260910-095027/`：最后一份完整正常清理报告（历史管理员身份）。
- `poc4/frontend/playwright-report/stage6-real-backend-fixed-20260909-210521/`：含 Maven 日志及 Job/Run 不一致证据。
- `poc4/backend/target/diagnostics-e2e-20260910-083b8efd/`：仍未修复的 initializer 清理问题。
- 最新 backend focused/unit 日志与 surefire 报告（包含真实失败，不按 green 文件名判断结果）。
- 已跟踪的设计/计划/故障报告、其他阶段证据、编译产物、node_modules、外部配置，以及用途未完全核实的临时配置文件。配置不是本次“无用日志”删除范围。
- 失败项目的数据库与 Kubernetes 现场；本轮文件清理不授权删除运行库或集群资源。

后续每次完整 Gate 应使用唯一目录，保存 list + JSON、退出码、SHA、身份、digest、必要的失败 trace 和清理核对；收集前做敏感信息筛选，原始 trace 可能含 token，不能直接提交。每种未解决故障保留一份最小证据；闭环后才用摘要替代重复原始文件。定期清理不得删正在写入的报告或当前服务所需配置。
