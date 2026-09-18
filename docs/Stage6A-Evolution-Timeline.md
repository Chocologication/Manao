# Stage 6A 演变记录

记录日期：2026-09-17（Asia/Shanghai）。范围：POC4 定义、前端阶段、6A 设计/修复/MVP 收敛、项目删除与本次阶段验收决定。

## 1. 结论与阅读规则

**演变主线：完整工作台设计 → 前端合同验证 → 真实后端与集群联调 → 修复跨系统一致性 → 收敛为可重复的 MVP 开发闭环 → 补齐用户主动删除 → 用户宣布 6A 通过、准备 6B。**

本文件回答“为什么变成现在这样”，不是现行验收证据。唯一现行 6A 事实现状和验收结论见 [Stage6A-Current-Facts.md](Stage6A-Current-Facts.md)。旧计划中的勾选、待执行任务和旧报告中的“当前”只属于其记录时点。

- 决策、实现和验证分别记载；提出过的简化建议不自动算作已经实现。
- 日期优先取文档标注与任务消息时间；提交日期只代表落库时间。尤其 9 月 15–16 日的多项修改集中在提交 `125daa3`，不能解释为同一时刻的一项修改。
- 历史证据保留，不把旧 FAILED/SKIPPED 改成 PASS。9 月 17 日的阶段通过是新的用户验收决定，并非倒写旧工程门禁结果。

## 2. 时间线

| 时间 | 当时问题 / 决策 | 实现、验证与今天的含义 | 可追溯来源 |
| --- | --- | --- | --- |
| 2026-08-19 | 从运行代码的 POC 演进为浏览器工作台：固定账号、Java/Maven、PVC、文件编辑、Job、日志、活动 Job Shell。 | 原始 POC4 已把 Run 固定为 `mvn clean test`；它是当时定义的执行内容，不是“执行用户 main 前必须先测试”的独立步骤。项目删除、AI、Git 不在当时范围。 | `bcbc749` 的 `poc4/docs/plan.md` 历史版本；[现存计划（已被后续修改）](../poc4/docs/plan.md) |
| 2026-08-20 | 选择性复用 EnsoAI，而非整体移植桌面应用。 | 保留浏览器展示组件；重写文件/Run/日志/终端访问层。不移植 Electron、IPC、node-pty、Git/worktree/Agent。 | [前端复用设计](../poc4/docs/2026-08-20-ensoai-frontend-reuse-design.md) |
| 2026-08-20–21 | Stage 0 先验证纯浏览器迁移是否可行。 | Spike 结论为继续选择性迁移；证据是浏览器、mock 文件与 echo WebSocket，不是真实 Kubernetes。 | [Stage 0 计划](../poc4/docs/plans/2026-08-20-ensoai-stage-0-spike-implementation-plan.md)；[结果](../poc4/docs/evidence/stage-0/result.md) |
| 2026-08-21–22 | Stage 1 建立应用入口、认证合同、项目列表和创建状态；Stage 2 建立只读工作台。 | 路由、文件树、Monaco、文件大小分级、下载与生命周期先在受控前端环境验证。 | [Stage 1 计划](../poc4/docs/plans/2026-08-21-ensoai-stage-1-frontend-foundation-implementation-plan.md) / [结果](../poc4/docs/evidence/stage-1/result.md)；[Stage 2 计划](../poc4/docs/plans/2026-08-22-ensoai-stage-2-readonly-workbench-implementation-plan.md) / [结果](../poc4/docs/evidence/stage-2/result.md) |
| 2026-08-23–24 | Stage 3 增加显式保存、版本冲突和文件 CRUD；Stage 4 接入 Run/日志合同。 | 建立 dirty buffer、保存 revision、运行时锁定、终态重新加载、历史与日志 replay/live。此时不能证明真实 PVC/Job。 | [Stage 3 计划](../poc4/docs/plans/2026-08-23-ensoai-stage-3-writable-workbench-implementation-plan.md) / [结果](../poc4/docs/evidence/stage-3/result.md)；[Stage 4 计划](../poc4/docs/plans/2026-08-24-ensoai-stage-4-run-logs-implementation-plan.md) / [结果](../poc4/docs/evidence/stage-4/result.md) |
| 2026-08-25–26 | Stage 5 交付活动 Job Terminal 的浏览器合同。 | xterm、ticket、PTY 协议、流控和审计 UI；退出为 15 PASS / 2 WAIVED_BY_USER，仅允许进入 Stage 6 计划。放弃验证不等于通过。 | [Stage 5 计划](../poc4/docs/plans/2026-08-25-ensoai-stage-5-active-job-terminal-implementation-plan.md)；[最终结果](../poc4/docs/evidence/stage-5/result.md) |
| 2026-08-27 | Stage 6 拆为 6A 本地控制面联调、6B 集群部署；先验收 6A，再执行 Tasks 10–12。 | Spring Boot 模块化单体 + MySQL/Flyway + workspace-agent/PVC + Kubernetes Job；原 6A 工程门禁包含真实日志、PTY/审计、压力和完整故障矩阵。 | [Stage 6 设计](../poc4/docs/2026-08-27-ensoai-stage-6-real-backend-kubernetes-design.md)；[实施计划](../poc4/docs/plans/2026-08-27-ensoai-stage-6-real-backend-kubernetes-implementation-plan.md)；`652d51a` |
| 2026-08-29–09-04 | 初次真实联调暴露“有代码但生产路径未接通”的问题。 | 修复真实 Pod 引用、fencing、日志 watch、审计接线、initializer、preflight、shutdown、MySQL 验证等；第二轮处理 startupProbe、bridge 监听、故障/压力测试合同与证据 SHA。离线通过不代替实集群验收。 | [第一轮修复计划](../poc4/docs/plans/2026-09-01-ensoai-stage-6-remediation-implementation-plan.md)；[第二轮计划](../poc4/docs/plans/2026-09-03-ensoai-stage-6a-gate-round2-remediation-plan.md) / [台账](../poc4/docs/plans/2026-09-03-ensoai-stage-6a-gate-round2-ledger.md)；[旧门禁记录](../poc4/docs/evidence/stage-6/6a-gate.md) |
| 2026-09-08–09 | 项目初始化的 workspace-agent HTTP mutation 失败，需要区分 agent 与转发链路故障。 | 先形成诊断计划，再比较同一 Pod 的传输路径；9 月 9 日 `4766b43` 将 local-cluster 默认 bridge 改为 kubectl，Fabric8 保留作显式比较。项目上限已调整为每 owner 8 个。 | [故障报告](../poc4/docs/2026-9-8-workspace-agent-bug-report.md)；[诊断计划](../poc4/docs/2026-09-08-workspace-agent-transport-diagnosis-plan.md)；[后续汇总](../poc4/docs/evidence/stage-6/2026-09-10-status-and-next-steps.md) |
| 2026-09-10 | 基础 5/5 与完整 6A 被混淆；失败项目清理不完整。 | 保留“任意终态不证明成功”的边界；下一步聚焦可靠清理。决定 CREATING 返回 409、持久化 DELETING、显式续作、先清集群后删 DB、owner 范围与独立核验。此时删除仍是测试/运维能力，不是产品 UI。 | [清理设计](../docs/superpowers/specs/2026-09-10-stage6-reliable-project-cleanup-design.md)；[RC-1–RC-8 计划](../docs/superpowers/plans/2026-09-10-stage6-reliable-project-cleanup-implementation-plan.md) |
| 2026-09-12–13 | 落实异常/并发/重启后的清理，避免 afterAll 成功掩盖残留。 | 实现生命周期互斥、initializer/工作负载/PVC 分层清理、关联 DB 事务、资源台账与只读 verifier；修复 JDBC 注入等实测问题。9 月 13 日记录 C01–C08 8/8 与 basic 5/5；仍非旧完整 6A 门禁通过。 | [清理验收历史](../poc4/docs/evidence/stage-6/cleanup-acceptance.md)；`817e359` |
| 2026-09-14 | 用户指出设计复杂度妨碍 MVP 交付，要求回到第一性原理。 | 核心改为“编辑 → 保存 → 真实运行 → 日志/结果 → 修改 → 再运行”；区分产品运行时、本地集群适配和测试运维层。讨论删 receipt/fencing/Terminal 等属于建议，不代表源码已删除。 | [简化审查](../poc4/docs/2026-09-14-codex-review-for-simplify.md)；任务“明确 POC4 核心闭环目标” |
| 2026-09-15 | 不推倒重写，只修断点，先交付闭环。 | 修正 Run 结果持久化/历史分页，接通 WebSocket；Terminal 默认退出主路径；严格验证失败后修正成功、重登录文件/历史保留。当时报告 MVP PASS，但不宣称 6A PASS，全量后端仍有失败。 | [MVP 规格](../docs/superpowers/specs/2026-09-15-poc4-mvp-loop-design.md)；[MVP 计划](../docs/superpowers/plans/2026-09-15-poc4-mvp-core-loop-implementation-plan.md)；[当时证据](../poc4/docs/2026-09-15-poc4-mvp-core-loop-evidence.md) |
| 2026-09-15–16 | 用户追问为何 Run 执行测试，而不是自己的 Java 程序；决定最小修改。 | Job、策略、模板和前端合同改为 `mvn -q -DskipTests compile exec:java`；默认 main 为 `com.example.app.App`。9 月 16 日提交 `125daa3` 同时收纳多项 MVP/重载修改。 | 任务“查找运行前 Maven 决策”；[当前 Job 命令](../poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobResourceFactory.java)；[模板入口](../poc4/backend/src/main/resources/workspace-template/pom.xml) |
| 2026-09-16 | 旧项目显示 READY，但 workspace Pod 已不在，文件无法打开。 | owner 校验后的项目详情 GET 按需恢复 Pod/Service，复用原 PVC；不重写模板。PVC 确实缺失才记 WORKSPACE_STORAGE_MISSING；传输错误返回 503。 | [恢复记录](../poc4/docs/evidence/stage-6/2026-09-16-workspace-open-recovery.md)；`22148ad`、`c6ece43` |
| 2026-09-16 | Run 结束后重载失败，Retry 仍不能解锁。 | 先按目录检查路径，避免把目录当文件解析；重载时暂停 UI 自动文件查询并卸载编辑器，防止竞争读触发 PROJECT_BUSY；读成功后再解锁。真实成功/失败 Run 后均有 Retry + Save 200 记录。 | [重载修复记录](../poc4/docs/evidence/stage-6/2026-09-16-workspace-reload-retry.md) |
| 2026-09-16 | 用户将“手动删除项目”加入最小完整生命周期。 | 复用删除服务，增加永久删除确认与 Continue deletion；不乐观移除、不自动重放 DELETE。补充 PV/NFS 策略核查；不引入后台清扫、队列或新删除任务系统。历史删除测试的 6 failures / 1 error 经测试替身补齐 inspect 后修正；定向回归通过。 | 删除任务；[删除实现记录](../poc4/docs/evidence/stage-6/2026-09-16-project-deletion-mvp.md) |
| 2026-09-17 16:43–17:09 | 验证新项目真实删除，以及资源清不完时不能假成功。 | 专用 `manao-poc4-delete` StorageClass 下验证失败 Run → 修正成功 → 删除；临时阻塞 PVC 后保留 DELETING，刷新后显式续作。留存 DB、Job/Pod/Service/PVC/PV、NFS 原/归档目录对账。CLI 断言通过但退出异常，与独立浏览器正常退出分开记录。 | [运行记录](../poc4/docs/evidence/stage-6/2026-09-17-project-deletion-runtime.md)；[原始流程收据](../poc4/docs/evidence/stage-6/2026-09-17-project-deletion/live-ui-receipt.json)；[最终存储核验](../poc4/docs/evidence/stage-6/2026-09-17-project-deletion/all-test-projects-final-storage.json) |
| 2026-09-17 19:11–19:21 | 用户日常环境删除仍未完成，说明专用测试配置不能代表所有使用方式。 | 任务定位到日常 env 仍选旧 `nfs-storage`，两个项目处于 DELETING；提出统一配置、逐卷处理旧策略、补诊断方案。可读取的该轮结论只报告 dry-run，没有迁移完成证据；本次查文件仍有两份不同 StorageClass 配置。 | 删除任务后续诊断；[当前事实第 7 节](Stage6A-Current-Facts.md) |
| 2026-09-17（本次任务） | 用户确认已可在真实浏览器完成全部生命周期，宣布 6A 通过、准备 6B。 | **Stage 6A = PASS（用户按当前 MVP 生命周期验收）；Stage 6B = 准备开始，本轮未实施。** 旧完整工程门禁不被伪造为全绿；以当前代码与具名证据建立唯一现行事实文档。 | 本次用户指令；[唯一现行事实](Stage6A-Current-Facts.md) |

## 3. 关键决策最后落在哪里

| 主题 | 历史选择 | 截至 2026-09-17 的落点 |
| --- | --- | --- |
| 产品目标 | 工作台 + Shell/审计等完整合同 | 可重复开发闭环 + 用户主动永久删除；不扩展成完整云 IDE 平台 |
| Run | 固定 `mvn clean test` | 固定 Maven 启动参数，编译并运行项目入口；不是任意浏览器 shell 命令 |
| Terminal | 旧工程门禁必验 | 实验开关默认关闭；源码/后端支持保留，不在本次 MVP 通过依据中 |
| 文件版本 | receipt/reconciliation + DB revision | 未改成“无 receipt 的直接写”；仍保留两阶段持久化、回执核对和运行写锁 |
| Run 恢复 | fencing / RECOVERING | 源码仍存在；没有实现“所有网络错误直接 FAILED”的建议 |
| 文件持久化 | PVC 共享给 agent 和 Job | 仍是共享可写工作区，不是每次 Run 的不可变源码快照 |
| 工作区恢复 | 创建时初始化，打开依赖已有 Pod | 增加打开时恢复运行资源，不重新初始化已有文件 |
| 项目删除 | 不做 → 测试清理 API | 正式加入列表 UI；失败保留 DELETING，用户明确继续 |
| 删除完成 | 工作负载/PVC，再 DB | 增加 PV/可回收策略；具名案例额外核验物理 NFS 路径 |
| 基础 smoke | 5 项通过，允许任意终态 | 旧 smoke 仍非充分证明；新增 MVP 严格断言失败/成功、exit code 和输出 |
| 6A→6B | 原 Task 9A 全工程门禁通过后继续 | 本次按 MVP 生命周期宣布 6A PASS；交接读当前事实，不再将旧文件作现行否决结论 |

## 4. 文档的现行效力

1. **当前事实和验收：** 仅 [Stage6A-Current-Facts.md](Stage6A-Current-Facts.md)。未来变化更新它，不新增并列的“最新 6A 状态”。
2. **决策来龙去脉：** 本记录；新决策按时间追加，不抹掉旧判断。
3. **历史设计与计划：** 以上旧设计、修复/MVP 计划解释意图，不独立定义现行 6A 范围，也不授权重新执行。
4. **历史报告与附件：** 旧 gate、cleanup、MVP、恢复、删除报告和 JSON/截图保留为来源附件；当前事实文档汇总并标注日期/范围。
5. **6B 计划：** 原 Tasks 10–12 只作历史输入。“消费旧 6a-gate.md”、旧 Run 命令、禁止任何 PV 读取、必验 Terminal 等与当前基线已有差异，不能原样机械执行。

## 5. 本次直接核查的四个任务

| 任务名称（原题） | 任务 ID | 使用内容 |
| --- | --- | --- |
| 明确 POC4 核心闭环目标 | `01a09f71-1dcb-73d2-a743-55bce59e50bd` | 第一性原理目标、简化建议与范围冲突 |
| 交付 POC4 核心闭环 MVP | `01a0a398-daf6-7613-a140-e0cc640efe1e` | MVP 实施、真实失败/修正成功、原全量后端失败边界 |
| 查找运行前 Maven 决策 | `01a0a4d2-3c19-7661-8659-de177673f267` | Run 改为执行入口类、工作区恢复与重载后续 |
| 我想为当前poc4再补全一个项目的生命周期，我的目标是：用户可以选择删除项目，删除之后要确保集群资源、数据库、前端都能… | `01a0aa2d-5bf0-7bc0-b152-4f9dfe5935d0` | 删除范围、实现、真实对账、日常配置遗漏与修正方案 |

读取任务接口后，对部分空条目用对应本地任务记录和落盘源码/证据补充；未恢复出的消息不作推测。本次用户的最终使用结果独立记为“用户确认”，不冒充本次重新运行的自动化证据。


## 6. 2026-09-18：6A 集成与 6B 分支准备

按用户要求，补齐并提交 6A 源码与验收附件（`b555c69`），使用 `--no-ff` 合并到 master，从合并结果创建 `codex/poc4-stage-6b`。同步保留两边操作指引并修复交接文档链接；本次不扩展 6A 验收范围，也不实施 6B 部署。验证范围见[当前事实](Stage6A-Current-Facts.md)。
