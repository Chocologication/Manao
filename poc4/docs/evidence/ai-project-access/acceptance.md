# AI project access — 2026-10-18

用户要求取消只有 `ai-stage2-7a11c73d` 项目可用 AI 的限制。初始回合在 `.worktree/ai-integration`、`codex/ai-integration`、HEAD `748d2ed` 上执行限定本地修改；随后用户在本侧对话明确授权集群发布并已完成（见下节），不继承主线程旧授权、不调用云模型、不改变 Stage 2 原验收暂停状态。

## 行为与最小改动

- `AiConfig.AiProperties` 不再强制要求 `project-id`；保留该历史配置字段以兼容现有严格配置绑定，值不再限制任务准入。全局 `MANAO_AI_ENABLED` 开关保持原义。
- `AgentTaskService.submit` 删除单项目白名单检查；其配置依赖随之移除。任务仍由真实 `AgentTaskStore.createTask` 校验当前用户归属、READY、revision、未决 workspace operation 和单项目 active task。
- 第二个项目使用自己的 task/project/owner 持久身份；工具、文件限制和现有 Run 互斥不变。开放提交范围不等于新增 Python 构建、CRUD/SQL 或其他工具。
- 前端无需改动。没有新增表、迁移、依赖、模块、执行池或授权框架。

## TDD 与验证

先调整原单项目约束测试，增加第二个真实项目提交和 foreign owner 拒绝回归。RED：3 个测试中 2 个目标断言失败（空 project-id 引发配置异常，第二个 READY 项目被白名单拒绝），0 errors；foreign owner 检查通过。随后删除两处限制并重跑。

GREEN 命令：

```text
mvn -Dtest=AgentTaskServiceTest#anEnabledStageDoesNotRequireASingleProjectId+anotherOwnedReadyProjectCanSubmit+removingThePilotRestrictionStillRejectsAForeignOwner,AgentInternalSecurityTest test
```

结果：11 tests，0 failures/errors/skips。使用真实 MySQL 8.0.40、每测试独立 `manao_stage6_` schema、真实 task store/service；worker 为既有 fake，不冒充真实模型执行。

保留边界检查和 package 命令：

```text
mvn -Dtest=AgentTaskStoreTest#oneProjectCannotAcquireTwoTasks+aPendingWorkspaceOperationBlocksTaskRegistration+foreignStatesAndOwnersRefuseRegistration+aStaleExpectedRevisionIsARevisionConflict+lookupsAreOwnerAndProjectScoped package
```

结果：5 tests，0 failures/errors/skips，BUILD SUCCESS；两组共 16/16。READY/owner、revision、未决写入、active task 和查询归属边界通过。`git diff --check` 与本轮文件 UTF-8 无 BOM 检查通过。

清理：专用 MySQL 容器 `manao-pilot-removal-mysql-20261018`（ID `c936f329da5288266725eb5b8a51b584cfb065cc92fa744fe6e2f3c1226d5178`）在删除前核对 `manao_stage6_` schema 计数为 0；按精确 ID 删除容器和匿名卷，最终 name-filter inventory 为空。运行 schema 和现有资源未触碰。`target/ai-project-access-{red,green,guards}.log` 保留为本轮最小测试诊断；测试后的 jar 留作后续发布准备。

## 发布边界

初始本地修改回合没有部署。2026-10-18 用户随后在本侧对话明确授权“现在你可以发布到集群了”，本次限定 backend 发布已完成，实际结果记录在下节。历史 `MANAO_AI_PROJECT_ID` 可留存但不再生效。Stage 2 专用验收项目仍用于既定验收，其脚本的项目定位变量应保留；不把取消项目白名单记为 `PI_STAGE2_APPLICATION_FEEDBACK_PASS`。

初始本地修改回合未提交、push 或 merge；后续发布仅提交本次代码/记录，主线程原有未提交验收文档、verifier 和 continuation 文件均保留。独立子代理审查未运行（侧对话禁止子代理）；本轮采用针对性自审和真实持久层回归。

## 授权发布（2026-10-18）

发布前：context=`kubernetes-admin@learn`，namespace=`manao-stage6b`，3 nodes Ready；backend 当前 digest=`sha256:6d255a093f503c435efc13fcad70daa5cc2bc97f40a930a8df5ee14817eb9846`、replicas=1、Recreate。owner 的 5 个现有项目均无 current AgentTask；其中 4 READY、1 DELETING。不停止用户应用、不修改其源码，不运行模型或原 Stage 2 完整验收。

发布产物沿用已测试本地 jar，SHA256=`e8fce0026d3a2ab299407b0ebdcba29435b3b24c415bdf1b482a5b88e47c50f6`；源与 16/16 测试后未变。构建仅基于上一 backend 的固定 digest 替换 jar，继承 USER、ENTRYPOINT 与 HTTP retry JVM 参数。旧 digest 留作回退（回退会恢复单项目限制）。

生产源码提交：`2446ca2e9a74c4f1e41fa3b3bb5d32cef378a084`。镜像 tag=`chocologic/manao_images_repository:ai-project-access-20261018-2446ca2`，push 与远端 manifest 核对 digest=`sha256:2472a61595c4a9b4f8b27ecf646dbd7f16788e9c935b0090c57f41ac907ba395`。首次上传曾数分钟没有新进度，随后完成；同内容再次 push 返回相同 digest，未改变产物。标准多阶段 dependency 构建未重新执行，不将其记为 PASS。

仅更新 backend Deployment 的 image，Recreate rollout 成功；新 Pod=`backend-746597654f-6mm4k`、UID=`ccf38553-d442-448e-9780-8200aac8ff1d`、ready=true，imageID 匹配上文 digest。worker/frontend 镜像与配置未变；没有迁移、手工 SQL 修补、用户项目启动/停止或删除。

2026-10-18 11:20:50（Asia/Shanghai）准入对照通过：`test1`（`20e4d296-5b67-43a5-8c6d-fa3adfe2b373`）、`test2`（`52c7b53e-3f08-4d83-aae7-dcdd7896967b`）发布前均 `404 AI_PROJECT_NOT_ENABLED`；发布后均 `409 WORKSPACE_REVISION_CONFLICT`。探针使用有效新任务 ID 和最大 long revision，故在准入后立即被 revision 校验拒绝；两次发布后请求均通过 taskId 与 current 查询确认为 404，没有创建任务或调用 worker/model。此结果证明单项目限制已移除、正常 revision 约束仍在，不是实际模型开发任务或完整业务验收。

完整无凭据的 [发布与准入 JSON 证据](release-20261018.json) 保留了前后响应、taskId 和 Pod 身份。本轮只提交自身代码/证据；原 Stage 2 验收仍暂停且 NOT_GRANTED，Git push/merge 未执行。路径核对后已逐个删除本轮临时 Docker context（jar副本、Dockerfile、空目录）、探针脚本和已归档JSON副本/远端manifest输出；保留发布push日志及最小测试诊断，不触碰此前其他任务的临时文件。
