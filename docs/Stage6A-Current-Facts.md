# Stage 6A 当前事实现状与验收记录

更新日期：2026-09-17（Asia/Shanghai）
性质：**当前 6A 阶段唯一现行证据文档**。历史报告和原始 JSON/截图只作为本文件引用的来源附件，不再各自发布当前阶段结论。决策演变见 [时间线](Stage6A-Evolution-Timeline.md)。

## 1. 阶段结论

**Stage 6A：PASS。依据是用户在 2026-09-17 明确确认真实浏览器的 MVP 全生命周期已经可用，并决定宣布通过、准备进入 6B。**

验收对象为：

~~~text
登录 → 创建项目 → 编辑文件 → 显式保存 → 运行
     → 查看日志和结果 → 修改代码 → 保存 → 再运行 → 手动删除项目
~~~

| 结论项 | 当前记录 |
| --- | --- |
| 6A 阶段验收 | **PASS（用户按当前 MVP 生命周期验收）** |
| 用户确认 | 本次明确报告上述真实浏览器操作已可完成，包括删除 |
| 已留档运行依据 | 具名真实失败/成功 Run、重登录持久化、终态重载/Retry、删除失败不假成功和显式续作；见第 5 节 |
| 本次核查 | 源码、Git、四个任务、历史文档、留存原始收据及存储类配置文件；没有重新跑生命周期、测试套件或查询运行 DB/集群 |
| 旧完整工程门禁 | 历史记录未形成全部 PASS；本次不把 PTY/审计、压力、三类故障矩阵、全量回归等未证明项改记 PASS |
| 6B | **准备开始；本次未实施、未部署、未验收** |

这次变化是**验收口径和阶段决策的明确更新**：以可重复的 MVP 生命周期作为当前 6A 通过依据，不再让早期完整工程矩阵充当当前阶段的唯一决策规则。未证明的工程项保留其实际状态，不逐项虚构为用户豁免，也不因旧文件仍写 FAILED 而撤销本次用户决定。部署能力、旧存储迁移和全量回归情况仍须按下述事实理解。

## 2. 代码基线和取证方式

### 2.1 实际实现位置

- 主检出：`D:/DeepLearning/MyProjects/Project_Manao`，分支 `master`，HEAD `a3268aa70fe5b02767e3bab99985879e9e8b46e3`。
- **实现工作树：** `D:/DeepLearning/MyProjects/Project_Manao/.worktree/ensoai-stage-6-real-backend-kubernetes`。
- 实现分支：`codex/poc4-stage-6-real-backend-kubernetes`。
- 核查 HEAD：`361985bac52f2a99e014c50e64ef3ee1adfbf04f`（2026-09-17 20:34:41 +08:00）。
- 最近实现提交：`125daa3`（Run/MVP/重载相关）、`22148ad` / `c6ece43`（打开时恢复）、`888fbcc` / `361985b`（删除及测试）。Stage 6 实现没有合并到 master。

**本次基线是“HEAD + 当前磁盘中的未跟踪文件”，不是一个可以仅凭 SHA 完整重建的干净交付版本。** 核查开始时实现工作树没有 tracked diff，但以下两个文件仍未跟踪：

| 文件 | 影响 |
| --- | --- |
| [DeleteProjectDialog.tsx](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/frontend/src/features/projects/DeleteProjectDialog.tsx) | 被 ProjectsPage 实际导入的生产组件；仅 checkout HEAD 会缺失该文件 |
| [playwright.project-deletion.config.ts](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/frontend/playwright.project-deletion.config.ts) | package.json 的删除 UI 测试脚本引用它；该套件使用拦截 API，不是实集群验收 |

此外，清理/MVP 计划、9 月 14–17 日多份记录及删除原始附件仍未跟踪。文件现存不代表已提交。本次不代为 stage/commit/merge。第 9 节记录关键文件 SHA-256；打包 6B 时应保留完整实际源文件并另行记录构建基线，不能把本次文档当成干净构建证明。

### 2.2 证据类别

- **CODE_VERIFIED：** 本次直接读取的当前源码/配置，可证明当前实现，不独自证明运行成功。
- **RETAINED_RUNTIME：** 读取了既有原始收据/JSON/日志，证明其具名时点与项目范围；本次没有重跑。
- **HISTORICAL_REPORT：** 已有任务/报告记载的测试或运行结论，未在本次复测；不当成当前 HEAD 全量通过。
- **USER_CONFIRMED：** 用户本次使用结果与验收决定；未附新的项目 ID、配置、截图或测试报告。
- **NOT_REVERIFIED：** 本次未重验或现有材料不足；不等同 FAILED，也不等同 PASS。

## 3. 当前架构与边界（CODE_VERIFIED）

~~~text
浏览器工作台（React / Monaco）
  → Vite :4173，同源 /api HTTP + WebSocket
  → 本机 Spring Boot :18080，local-cluster profile
      ├─ MySQL：身份、项目、revision、Run、日志、操作回执元数据、终端/审计
      ├─ Kubernetes API：创建/观察/删除项目资源与 Maven Job
      └─ 默认 kubectl port-forward → workspace-agent HTTP → 项目 PVC 文件

真实集群：initializer / workspace Pod + Service + PVC
                                      └─ Maven Job 挂载同一项目目录
~~~

- 前端代理目标是 `127.0.0.1:18080`；MSW 仅在 `VITE_ENABLE_MOCK_API=true` 时启动。真实记录使用非 mock 路径。依据：[Vite 配置](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/frontend/vite.config.ts)、[启动入口](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/frontend/src/main.tsx)。
- 后端是模块化单体，不是微服务平台。项目声明 Java 17 / Spring Boot 3.5.9 / Fabric8 7.7.0；这是仓库版本，不是“最新版本”判断。依据：[后端依赖](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/pom.xml)。
- MySQL 保存元数据和权威 revision；PVC 保存文件正文；Kubernetes 提供 Job/Pod 运行事实。迁移文件 V1–V8 存在；最后一次运行报告记 Flyway v8，本次未查实际数据库版本。依据：[初始表](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/resources/db/migration/V1__initial_schema.sql)、[DELETING 迁移](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/resources/db/migration/V8__project_deleting_state.sql)。
- local-cluster 默认 kubectl bridge；Fabric8/supervised 是可选路径。没有把它简化成写死单个 workspace Service。依据：[本地适配配置](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/config/LocalClusterConfig.java)。
- `ProjectLifecycleGate` 是**单实例**、每项目互斥门，不是分布式锁。instance lease/fencing 仍存在；不能据此推断已经支持多副本高可用。依据：[生命周期互斥](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/project/ProjectLifecycleGate.java)、[Run 服务](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/run/RunService.java)。

## 4. 当前产品行为与源码依据

| 生命周期环节 | 当前实现事实 | 核查入口 |
| --- | --- | --- |
| 登录/归属 | 查询 app_user、校验密码、签发 JWT；项目查询/修改使用 owner 身份，不让浏览器指定集群资源作为授权依据 | [AuthController](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/auth/AuthController.java)；[ProjectController](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/project/ProjectController.java) |
| 创建项目 | 插入 CREATING，异步准备 PVC、initializer、workspace 资源与模板，然后 READY；每 owner 上限 8，非容量保证 | [ProjectService](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/project/ProjectService.java)；[Provisioning](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/project/ProjectProvisioningService.java)；[上限](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/project/ProjectLimits.java) |
| 打开项目 | owner 校验后的详情 GET 可恢复缺失 Pod/Service，使用原 PVC；不重写模板。PVC 明确缺失才 FAILED / WORKSPACE_STORAGE_MISSING；依赖不确定返回 503 | [详情入口](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/project/ProjectController.java)；[ensureWorkspaceAvailable](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/project/ProjectProvisioningService.java) |
| 编辑/保存 | 文件 CRUD 经主后端/agent；检查路径、revision 和活动 Run 锁。PENDING → agent 原子操作/receipt → 对账 → COMMITTED / revision 增长，仍然存在 | [WorkspaceService](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceService.java)；[操作协议](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceOperationService.java) |
| 启动 Run | 检查 owner、READY、expectedRevision、活动 Run；持久化 Run 的 revision 和策略，再创建 Job | [startLocked](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/run/RunService.java)；[Job 工厂](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobResourceFactory.java) |
| 运行结果 | 观察 Job 事实并结算数据库 Run；成功映射 SUCCEEDED，失败映射 FAILED，期限映射 TIMED_OUT；仍保留 STOPPING/RECOVERING | [Run 观察](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/run/RunObservationService.java)；[完整枚举](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/persistence/RunState.java) |
| 日志/历史 | 真实 Pod 日志先落库再通知订阅者；支持历史窗口、ticket WebSocket、replay/live；Run history 处理 cursor | [采集](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/log/RunLogIngestor.java)；[持久化](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/log/RunLogService.java)；[WebSocket 注册](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/config/WebSocketConfig.java)；[历史查询](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/run/RunService.java) |
| 修改再运行 | Run 终态后重载文件；重载期暂停自动文件查询、卸载编辑器，恢复目录/标签状态。读失败进入 RELOAD_FAILED，Retry 成功再解锁，不重放写入/Run | [工作台](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/frontend/src/components/shell/WorkbenchShell.tsx)；[重载](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/frontend/src/features/runs/workspaceReload.ts)；[权限状态协调](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/frontend/src/features/runs/RunAuthorityCoordinator.ts) |
| 删除入口 | 列表卡片确认永久删除；DELETING 保留卡片、不可打开、可 Continue deletion；不乐观移除、不自动重放 DELETE | [ProjectsPage](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/frontend/src/features/projects/ProjectsPage.tsx)；[卡片](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/frontend/src/features/projects/ProjectCard.tsx)；[请求和缓存](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/frontend/src/features/projects/projectQueries.ts) |

### 4.1 Run 的准确语义

当前命令是：

~~~text
mvn -q -DskipTests compile exec:java
~~~

默认模板由 exec-maven-plugin 3.5.0 执行 `com.example.app.App`，用户代码在 `src/main/java/com/example/app/App.java`，项目 pom.xml 可配置入口。不是 `mvn clean test`，也不是先 test 再运行 main。浏览器不能传任意 command/image/env；不等于用户 pom.xml/程序无法执行逻辑。

Job 在 /workspace 挂载同一项目 PVC 子目录，**readOnly=false**；保存 revision 与 Run 绑定、运行中 API 写锁并不等于不可变快照，也不限制程序自身修改可写文件。当前模板和普通显式保存路径是验收对象，未实现 Git/快照隔离。

代码策略为 Java 17、Maven 3.9.11、1800 秒超时；请求 1 CPU / 1 GiB memory / 1 GiB ephemeral，限制 8 CPU / 16 GiB / 10 GiB；backoffLimit=0。Job 使用专用 ServiceAccount 名称且不挂载 token。以上是工厂/策略值，不是本次实时 Pod 检查或生产隔离认证。

来源：[固定策略](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/config/BackendProperties.java)、[请求/限制](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/run/RunPolicy.java)、[命令/挂载](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobResourceFactory.java)、[模板 pom.xml](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/resources/workspace-template/pom.xml)。

### 4.2 删除完成的准确语义

1. owner 校验后 inspect/begin；CREATING 返回 409，READY/FAILED 的活动 Run 拒绝，READY 的 pending workspace operation 返回忙；DELETING 是可续作的删除意图。
2. 持有项目生命周期互斥，持久化 DELETING，关闭本地运行连接/句柄。
3. 按项目归属删除 Jobs、所有所属 Pods（包括 initializer）与 Services；确认工作负载消失。
4. 检查 PVC/PV 绑定、Delete reclaim policy；对 NFS 校验受支持 provisioner 和实际删除参数。未知/Forbidden/保留策略不是成功。
5. 删除 PVC，等待对应 PV 消失；后端不强删 PV、不剥离 finalizer。
6. 在事务中删除 terminal_audit、terminal_session、log_ticket、run_log_chunk、run、workspace_operation，最后删除 project；事务失败不返回完成。
7. API 返回 204 后，前端仍以当前身份重新读取项目列表确认不存在，再清该项目缓存/编辑缓冲并提示删除。DELETE 响应丢失只触发读状态；401/403 或无法确认列表不当作成功。

源码：[删除前置检查](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/project/ProjectDeletionRepository.java)、[删除编排](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/project/ProjectCleanupService.java)、[集群/存储核查](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/kubernetes/ProjectResourceCleaner.java)、[关联记录事务](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceJdbcStore.java)、[前端最终确认](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/frontend/src/features/projects/projectQueries.ts)。

**DELETING 不代表后台始终在清理。** 失败/重启后由用户明确继续；没有新增队列、后台 reaper、启动扫描、强制停止后删除、回收站或批量删除。后端代码检查策略和 PVC/PV 消失；它没有在每次产品删除时直接扫描 NFS 物理目录。物理路径不存在是第 5 节具名案例的额外运行取证，不能泛化成每次删除的底层字节证明。

### 4.3 保留但不属于当前 MVP 验收的能力

Terminal/PTY、终端审计、fencing/lease、receipt/reconciliation、测试清理台账、故障/压力工具仍在源码中。Terminal 只有 `VITE_ENABLE_EXPERIMENTAL_TERMINAL=true` 时进入工作台，默认关闭。没有依据称上述子系统已全部删除、全部重新验证或全部生产可用。

AI、Git、多语言、协作、管理员平台、多副本高可用、生产级恶意代码隔离和计费不在本次 6A 通过范围。

## 5. 留存的真实运行事实

### 5.1 2026-09-17 新项目完整生命周期与删除续作（RETAINED_RUNTIME）

| 项目 | 留存值 |
| --- | --- |
| project | `2f4b29a5-5170-41f4-9ea4-75bc6aa51516`，deletion-live-ui-20260917 |
| 错误代码保存 | revision 22 |
| 失败 Run | `c2182fff-4576-4b21-adb8-380984469ea6`；FAILED；输出 missingSymbol |
| 修正保存 | revision 23 |
| 成功 Run | `db44b6cb-f14d-4e68-a06c-3ba90ca10048`；SUCCEEDED；输出 Deletion lifecycle verified |
| 删除故障 | 临时 PVC finalizer 阻塞；DELETE 503 / PROJECT_CLEANUP_INCOMPLETE；数据库 DELETING，PVC/PV/NFS 路径仍在，前端未假成功 |
| 刷新/续作 | 刷新后保留 DELETING / Continue deletion；解除该测试标记，用户点击继续，最终删除且重新登录仍不存在 |
| 完成收据 | 2026-09-17 17:04:52 +08:00，USER_LIFECYCLE_AND_RESUME_PASS |
| 运行方式 | 真实前后端，无 API 拦截；代码写入已加载 Monaco model，保存/运行/删除使用 UI 按钮；任务记录独立驱动正常退出 0 |

原始附件：[生命周期收据](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/live-ui-receipt.json)、[最终驱动日志](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/live-ui-resume4-run.log)、[未完成状态证据](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/live-ui-incomplete-proof.json)、[失败截图](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/live-ui-failed.png)、[成功截图](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/live-ui-succeeded.png)、[刷新截图](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/live-ui-incomplete-after-reload.png)、[删除截图](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/live-ui-deleted.png)。

收据也保留了之前的文件树 PROJECT_BUSY 和测试驱动操作失败；最终是复用同一项目继续完成，**不是第一次尝试全程无错误**。留档成功适用于专用删除存储类，不证明旧存储项目已迁移。

### 5.2 正常删除的自动化场景与 Windows runner（RETAINED_RUNTIME）

- project：`7a5f80e6-7e5f-4f57-93e9-f321cb0d39fd`。
- 失败 Run：`e1a9ceef-88d3-401b-be04-15a59a664b60`；成功 Run：`07d575a3-41da-4e99-a67f-1efa700b575c`。
- Playwright JSON：expected=1、unexpected=0、skipped=0，122.5 秒；严格 FAILED/SUCCEEDED、成功 exit code 0、真实编译错误及 Hello from Manao，之后用户删除、404 和资源不存在。
- **断言 PASS，CLI 进程 FAILED：** Node v24.12.0 在报告写完后出现 UV_HANDLE_CLOSING，退出 -1073740791，不能称为干净 runner 全绿。

附件：[测试 JSON](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/attempt-3-results.json)、[独立核验/退出状态](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/attempt-3-independent-verification.json)。当前测试源码 [stage6-real-backend.spec.ts](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/frontend/tests/e2e/stage6-real-backend.spec.ts) 中，旧基础 Run 场景仍允许任意终态，但新增 MVP 场景严格断言；不能把二者混写成“所有旧 smoke 都已严格化”。

### 5.3 删除后的独立对账（RETAINED_RUNTIME）

2026-09-17 17:09:23 +08:00 的最终存储记录覆盖四个一次性项目：

~~~text
0613bf08-c6e0-4f41-9b0f-2e1131abcd82
55b62271-dbca-465b-9d09-94b1f1790c21
7a5f80e6-7e5f-4f57-93e9-f321cb0d39fd
2f4b29a5-5170-41f4-9ea4-75bc6aa51516
~~~

- 对这些项目，namespaceResources=0，remainingPVs=0，NFS 原目录/归档路径 ABSENT。
- 对账 TSV 中 project、run、workspace_operation、run_log_chunk、terminal_audit、terminal_session、log_ticket 七类关联记录均为 0；范围是这些项目/五个记录 Run，不是整个运行库清空。
- baseline 比较为原 71 个对象缺失 0；当时原 7 个数据库项目仍 READY。**这是 17 点时点的结果，不是对今天稍后所有项目的零残留保证。**

附件：[资源/物理存储](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/all-test-projects-final-storage.json)、[数据库对账](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/database-after.tsv)、[既有对象保留](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/existing-resources-after.json)。读取本地 TSV 只是证据读取，本次没有连接运行数据库。

### 5.4 更早的已记录闭环（HISTORICAL_REPORT）

| 日期 | 记录 | 证据范围 |
| --- | --- | --- |
| 09-13 | C01–C08 8/8 + basic 5/5，包含后端重启续作 | [清理历史](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/cleanup-acceptance.md)；旧版本/旧存储核查边界，不等于当前完整重跑 |
| 09-15 | project a8eebcbb-8490-4de7-b7f1-aa87dcb4721d，失败 Run 后修正成功，重新登录文件/日志/历史保留 | [MVP 历史](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/2026-09-15-poc4-mvp-core-loop-evidence.md)；发生在 Run 命令改成 exec:java 之前 |
| 09-16 | 原 PVC 存在、workspace Pod 缺失时恢复，并读到原 App.java | [打开恢复](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-16-workspace-open-recovery.md)；当时用临时 opt-in harness 验证，新自动行为待共享后端重启加载，不能倒写为当时已加载 |
| 09-16 | ce0c750d-2a1b-4370-af99-e63264567881 成功、ecacebec-e7ad-4ead-aeaa-be41efa3ebf7 失败后，撤销只读 GET 故障并 Retry；编辑恢复、Save 200 | [重载记录](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-16-workspace-reload-retry.md)；真实后端，故障注入只中止读取，不 mock 成功响应 |

## 6. 已有测试记录与本次核查的区别

| 证据 | 记录结果 | 不可扩大解释为 |
| --- | --- | --- |
| 09-16 删除定向后端 | 56 passed，无失败/错误/跳过 | 当前所有后端测试全绿 |
| 09-16 独立 MySQL schema 测试 | 9 passed；关联表、回滚、owner、DELETING；16 个临时 schema 后续核查不存在 | 运行库可被 reset 或所有运行数据已清空 |
| 09-16 前端 Vitest | 66 files / 1175 passed；最后窄缓存修改后 35 个受影响测试通过 | 最后修改后再次完整跑 1175 |
| 09-16 删除浏览器合同 | 4 passed，API 拦截 | 真实 Kubernetes/PV/NFS 通过 |
| 09-16 浏览器边界 | 36 passed；构建/类型和生产 mock 边界检查通过 | 压力、PTY 或全部集成验收通过 |
| 09-16 重载修复 | 90 个相关测试通过，类型检查通过 | 全部前后端回归通过 |
| 本次文档核查 | 检查来源/链接/编码/差异，固定源码/附件哈希；不执行产品测试 | 新鲜真实 E2E 或当前 HEAD 全量 PASS |

测试数来源：[删除实现历史](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-16-project-deletion-mvp.md)、[重载历史](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-16-workspace-reload-retry.md)。9 月 15 日 cleanup 的 6 failures / 1 error 后续在定向范围修正；Maven 决策任务还报告过全量 332 tests / 7 failures / 2 errors，涉及 transport、端口与清理。没有一份已核查材料能证明当前 361985b 加未跟踪文件的全量后端重新全绿，故当前全量状态为 **NOT_REVERIFIED**，不是沿用旧失败数，也不是宣称已全过。

## 7. 现有边界与6B交接事项

### 7.1 两份启动配置仍不同，旧存储迁移未获证实

本次只读提取外部 env 的 `MANAO_WORKSPACE_STORAGE_CLASS` 一项，未输出凭据：

| 配置文件（目录：D:/DeepLearning/MyProjects/Project_Manao_kubeconfig） | 本次读取值 |
| --- | --- |
| stage6-6a-local-cluster.env | nfs-storage |
| stage6-6a-project-deletion.env | manao-poc4-delete |

9 月 17 日真实验收使用后一配置。留档中旧 nfs-storage 为 archiveOnDelete=true；独立 manao-poc4-delete 为 onDelete=delete、archiveOnDelete=false、reclaimPolicy=Delete，并给后端身份增加 list persistentvolumes / get storageclasses 的只读权限。来源：[当时前置资源清单](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/6a-deletion-runtime-prerequisites.json)。

删除任务 19:21 的最后可读取诊断指出 browser-mvp-manual-20260915 与 test4 仍 DELETING，旧策略导致继续删除无效；其方案只 dry-run，没有实际迁移完成证据。本次用户随后报告全生命周期可用，**按用户结果记录通过，但没有足够材料将其解释为“旧项目全部迁移、两份配置已统一”**。源码仍只输出清理异常类名，未见该轮提出的详细原因日志改动。

本次未读取运行进程环境、未查询集群/PV、未迁移或删除任何资源；因此不判断当前运行服务究竟加载了哪份 env，也不把 19:21 的两个项目状态当成现在仍然存在的实时事实。

### 7.2 其他已知边界

| 项目 | 当前事实 | 交接含义 |
| --- | --- | --- |
| 文件树 PROJECT_BUSY | 真实记录仍观察到首次打开偶发 409，现有 Retry 可恢复 | 不宣称完全消除并发读争用 |
| Windows CLI 退出异常 | 成功断言之后 UV_HANDLE_CLOSING；独立浏览器流程另有正常完成记录 | 产品通过与 runner 退出失败并存 |
| 当前源码的完整回归 | 本次未跑，历史有失败且后续只有部分定向通过 | 不制造当前全套绿色徽章 |
| 旧完整工程矩阵 | PTY/审计、8 MiB 压力、三类适配故障没有当前基线完整证据 | 保留为未完成的历史工程范围，不伪装为本次 MVP 已验收 |
| 重启后的删除 | 09-13 旧清理切片和 09-16 本地测试有记录；09-17 新存储真实场景未再注入后端重启 | 不把浏览器刷新当作后端重启证明 |
| 源码可重建性 | 删除 UI 组件/测试配置和多份记录未跟踪 | 打包前记录完整实际源；仅 checkout HEAD 不够 |
| 文件版本保证 | 共享可写 PVC + revision/锁，无不可变快照 | 保持真实语义，不承诺任意程序改文件后的强快照保证 |
| 6B 实现资产 | 当前有 cluster profile 和 agent/runner 镜像材料，但未发现原 Task 10 的 backend/Dockerfile、backend/deploy 部署资产 | 不能称控制面已经部署进集群 |

### 7.3 6B 从哪里开始

用户已经决定进入下一阶段准备，不需要用旧 6a-gate.md 的 FAILED 再否决一次。6B 应以本文件描述的**现有 MVP**为输入：将控制面部署到集群，保持同一登录/文件/运行/日志/再运行/删除合同，并记录部署后的实测结果。本文件不是 6B 部署方案或部署完成证明。

原 Tasks 10–12 仅是历史计划，进入实施时需要按当前基线修订：

1. 门禁引用改为本文件及本次用户决定，不要求回写旧 gate 为全工程 PASS。
2. 使用当前 compile + exec:java 语义和默认关闭的 Terminal，不回退到 clean test 或自动把 Terminal 全矩阵塞回 MVP。
3. 选择可实际回收的项目存储策略；保留当前确有需要的 PV/StorageClass 只读观察权限。原计划“任何 PV 权限都禁止”已不匹配删除代码，不应机械照搬。
4. local-cluster 的本机 bridge 与 cluster profile 分清；单实例门闩不代表可扩到多副本。旧存储项目是否迁移与新部署存储配置分别处理。
5. 这次只整理文档，不创建 6B Deployment、Secret、RBAC 或数据库资源。

## 8. 唯一现行文档规则

- 当前 6A 的状态、已知限制、代码基线和证据只在本文件维护；其他索引只链接到此。
- 历史设计/计划/旧 gate/cleanup/MVP/删除报告保留原文与日期，标为历史来源，不与本文件争夺现行结论。
- 原始 JSON/日志/截图保留原文件与哈希；本文件将其作为来源附件，不产生第二套验收结论。
- 如实际代码、配置或用户范围发生变化，应更新本文件相应条目并在时间线追加事件；不能因为标题有“唯一证据”就忽略后续真实失败。

## 9. 关键来源 SHA-256

以下哈希于本次从磁盘读取，固定所引用的当前组件与原始收据版本；不是源码全仓库或运行镜像的校验和。

| 来源 | SHA-256 |
| --- | --- |
| [DeleteProjectDialog.tsx](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/frontend/src/features/projects/DeleteProjectDialog.tsx) | `e3f7b7f5f63b19c5acfb181a5127853f5453b8f55ab3c09164d539f388f79dd0` |
| [playwright.project-deletion.config.ts](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/frontend/playwright.project-deletion.config.ts) | `783e404f79418eb6c088e99941c5447fa09e95b74cc43f514ecc689c1cb40d89` |
| [live-ui-receipt.json](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/live-ui-receipt.json) | `a3827d15ae4fc90ea6803a1c39852c73bfa950d6bfa5ee9ad4d86fe5ea3a7204` |
| [live-ui-incomplete-proof.json](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/live-ui-incomplete-proof.json) | `dfed2162126acbab992c02276840abae34d7b3d12e312935fe3082ee514d4fcc` |
| [all-test-projects-final-storage.json](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/all-test-projects-final-storage.json) | `f782e5e1c785d7d06dca19e4ab8258415d3325e0c61411fbd9daaf53fc0e22d5` |
| [database-after.tsv](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/database-after.tsv) | `8b51d9500e36893f32ed53ac7db51e52b7b242af132cf7a1d686f6c371877771` |
| [attempt-3-independent-verification.json](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-17-project-deletion/attempt-3-independent-verification.json) | `e23ebb588f8033fa17044426aad26c3b6fa8144586c21bcce5794443720f8058` |

## 10. 本次工作范围

完成源码/历史核查、时间线和现行事实整合，并在主索引及实现工作树的历史入口声明替代关系。没有修改业务代码、测试代码或私有配置，没有启动/停止服务、运行真实测试、操作数据库/集群、提交或合并代码。文档检查的实际执行结果随本次交付报告提供，不把文档检查计作产品验收测试。
