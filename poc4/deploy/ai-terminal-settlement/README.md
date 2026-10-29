# AI terminal settlement 发布准备与恢复程序

日期：2026-10-26。当前状态：**DEPLOYED_SMOKE_VERIFIED**；用户已授权并实际发布三组件及V15/V16迁移，一次最小真实模型与浏览器收尾通过。实际证据见[验收记录第8节](../../docs/evidence/ai-terminal-settlement/acceptance.md#8-2026-10-26-实际集群部署与最小真实验证)与[脱敏发布身份](../../docs/evidence/ai-terminal-settlement/cloud-release-20261026.json)。完整云端故障矩阵未执行；原Task NOT_REPAIRED，Stage2 PAUSED/NOT_GRANTED。下文发布步骤作为后续维护契约保留。

2026-10-27 补充完成失败、手动结束、执行中backend重启、Worker收据前丢失及真实1800s期限关闭，四类专项场景PASS（KEY_CLOUD_FAULTS_VERIFIED），沿用相同镜像。该轮故障注入、配置恢复及最终结果见[关键云端故障记录](../../docs/evidence/ai-terminal-settlement/cloud-faults-20261027.md)；不启动第四阶段，不授予完整A–N矩阵PASS。

## 阶段四增量发布准备（2026-10-27）

用户后续明确授权后已完成阶段四发布与真实模型验证：**PI_STAGE4_CONTROL_RECOVERY_PASS**。实际证据见[阶段四验收第7节](../../docs/evidence/ai-stage4/acceptance.md#7-2026-10-27-实际云端发布与阶段四验证)及[脱敏发布身份](../../docs/evidence/ai-stage4/cloud-20261027.json)。

实际linux/amd64 digest：backend sha256:c0c56bc35ffc485350f42153f1833f94527c1cceda2f3ccba762c6654ba4eb56；frontend sha256:120ebc30a2ab00a090ab89d7f1184ec402ae391bc0aced7a45ea72fea4c45ae1；Worker仍sha256:696080571ba556d983aa578163be3d6494261057e960a9686b15f814e7d0c93e。源码e3c06dde8fc02b3e00c80373be870e5dc413bb6f，generation45/27/34，三组件Ready1/1；V15/V16未新增执行。发布前回退tuple与私有备份恢复演练在验收第7节；本轮未Git push/merge，原故障Task未恢复。以下兼容/回退约束继续有效。

- 无新增迁移/表/依赖；沿用已存在的V15/V16。新backend兼容旧frontend，新增 `closeReasonCode` 可被旧客户端忽略；先部署backend，再部署frontend。
- Worker生产代码没有本阶段改动，继续Pi1.2.0，不为测试夹具重发Worker镜像；发布前重新核对 `replicas: 1 / strategy: Recreate`，禁止并发新旧Worker实例。
- 暂停/重启收尾仍占用时不得回退到不认识严格退出门槛的backend。先停止新Task预约，保留兼容backend结清 `AI_PAUSED_BY_OWNER / AI_WORKER_RESTARTED`、pending receipt、live claim、Run/Job；未知证据不能SQL清状态。结清后才按现场确认的镜像身份回退，不DROP列或覆盖数据。
- 后续仅三条专用项目云端链：①真实长构建暂停→核对本Task Job/Pod与子进程退出→人工保存→同conversation新Task读到修改→完整Workbench重进；②Worker真实新boot/Pod UID与旧Task404→核对后手动继续，无旧工具重放；③用户明确删除专用项目→核对Job/Pod/Service/PVC/适用PV及DB行，保留平台资源。正常COMPLETED保留READY应用作为同链控制断言。
- 不重跑已完成的关键故障整矩阵或真实1800秒等待，不恢复原故障Task。通过真实云端验证后才考虑 `PI_STAGE4_CONTROL_RECOVERY_PASS`，不连带授予Stage2或整个AI首版PASS。

## 1. 发布前提与顺序

后续取得明确发布授权后才执行：

1. 核对当时context/namespace/backend/Worker/frontend镜像digest、运行库schema、节点健康和容量；2026-10-25的调查不是当前环境证明。禁止输出token、raw kubeconfig、model key或私有连接配置。
2. 暂停新任务预约并观察现有task/claim/receipt/Run；对目标运行库做私有备份，记录备份身份及恢复演练结果。备份不进Git。恢复验证使用独立新schema，绝不 reset 运行库。
3. 先应用加法迁移 **V15**（terminal receipt、deadline、close reason、reconcile scheduling/index）和 **V16**（durable reconcile_attempt）。校验Flyway历史及列/index，迁移不能自动停止历史应用、改变旧Task状态或删除字段。
4. 部署兼容后端，确认旧 `/progress kind=terminal` 与新 `/terminal` 都可接受，且后台收尾独立运行。
5. 再部署新Worker，然后前端。新Worker不得对尚不支持terminal接口的旧后端启用新协议。逐一记录source SHA、构建信息、不可变image digest和实际Ready证据。
6. 执行独立云端测试，覆盖锁竞争、缺号、ACK、重建、deadline、close、owner隔离以及真实资源确认；只有实际通过的场景才写PASS。

## 2. 兼容与回滚

- V15/V16只加列/索引；旧数据的deadline为NULL，不自动预算关闭。旧Worker的terminal进度先转入同一receipt入口，不受展示seq连续性限制。
- 正常成功必须保留任务已就绪的Run；用户close/失败/预算只核对并清理本Task关联副作用，不能停止其他Task或未触碰的Run。
- **存在pending receipt、未完成close、live claim或未知副作用时，不得回退到不认识收据的旧后端。** 先停止新任务，使用兼容后端完成核对；不能用SQL强行清状态。
- 回滚先停止新Worker接受新任务，确认task/receipt/close全部清空并记录；再按已验证的兼容组合切换Worker/backend/frontend。精确镜像digest与命令需取得发布授权后根据当时环境填写。
- 回滚不DROP V15/V16列或索引，不修改Flyway历史，不恢复会覆盖新业务数据的旧全库备份；数据恢复需单独明确授权与数据损失评估。
- Worker没有磁盘outbox。receipt落库前Worker丢失且原结果不可恢复时，只能在期限/owner close核对后安全失败关闭，不能声称已成功完成。

## 3. 原故障 Task dry-run 程序

目标原故障Task：`b3b32518-f0ed-411e-aa85-1ecef95fbdc5`。本轮没有连接、修改或恢复该Task，状态 **NOT_REPAIRED**。

后续先取得只读诊断授权；以owner/project/task三者联合核对：

1. 当前task行身份、state、worker instance/epoch/request digest、deadline、close reason、terminal report id/hash/time。仅输出安全业务身份和摘要，不输出prompt或token。
2. 逐个ledger call核对state、operationId/RunId、request digest、claim是否实际存活。检查对应workspace receipt的原始身份与digest，未知保持占用。
3. 核对所有关联Run、Job/Pod UID/owner链、Service路由、PVC/PV归属和已确认停止事实；禁止仅凭一个404、结束时间或聊天答案解锁。
4. 核对当前Worker boot与task响应身份；旧Worker已重启且没有可靠terminal receipt，不从最终回答拼造COMPLETED，不重新prompt原模型任务，不重新执行原工具。
5. dry-run输出逐项已证实/未知、建议owner close与预计会停止的Task关联应用；不执行变更。
6. 用户随后明确授权关闭时，使用owner-scoped `POST /api/v1/projects/{projectId}/agent-tasks/{taskId}/close`，先保存关闭意图；持续核对直到生产后台确认停止并释放。保留未知项的NEEDS_ATTENTION，不能直接SQL UPDATE状态。

Stage2既有验收仍 `PAUSED / NOT_GRANTED`；本轮修复不替代历史失败验收，也不启动Stage4。

## 4. 本地测试使用

先在进程环境配置 `MANAO_TERMINAL_TEST_DB_USERNAME` 和 `MANAO_TERMINAL_TEST_DB_PASSWORD`（具备本机一次性schema CREATE/DROP权限），准备Java测试classpath，然后运行专用命令：

```powershell
mvn -f poc4/backend/pom.xml test-compile dependency:build-classpath '-Dmdep.outputFile=target/terminal-local-classpath.txt'
pnpm --dir poc4/frontend test:e2e:ai-terminal-settlement
```

不复用AI-stage1/stage2云端配置，不读集群env，不调用付费模型。端口占用即退出；setup teardown只终止本轮拥有的PID树并销毁本轮新schema。若自动审批拒绝清理，记录拒绝与残留路径，不能换工具绕过。

## 5. 本次发布与回退基线

源码758aae6，生产修复5739d1b，context=kubernetes-admin@learn，namespace=manao-stage6b。实际新镜像及Pod见验收第8节；标准Dockerfile构建成功，没有fallback替换jar。Maven/Python runner、workspace-agent、initializer及模型Secret未变更。

发布前保存的回退镜像（同仓库chocologic/manao_images_repository）：

- backend：sha256:726c095f15d4866fbcea48146c90faf2fb1a6d680f02629f6ea893e49f694af1。
- Worker：sha256:dd06e4148d466127914ebf0bc04e27b5f078d4061f4485f1c0b4221831e269f8。
- frontend：sha256:297a81e47cc421223b552562acee5d99920aeda20bc5b5190dadbd1991059698。

这些仅是回退身份，不允许忽略pending receipt/close。旧后端不认识收据，仍须遵守第2节；V15/V16字段及Flyway历史不DROP。私有备份已恢复演练，9张关键表行数匹配；恢复库与远端临时SQL已清理，私有副本保留。

验证项目caafbc12-9831-4ff7-a411-0eb0f1c7ef75保留；只运行真实模型Task978cddbb-5d51-45f3-9b3b-475a4c33791e，一次list_files，自动COMPLETED/ACKED并释放写锁。原故障项目未关闭或恢复。账号密码登录、完整云端故障矩阵、应用启动/停止/保留不属于此次冒烟通过范围。
