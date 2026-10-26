# AI terminal settlement 发布准备与恢复程序

日期：2026-10-26。状态：本地发布准备，实际云端 `NOT_RUN`，没有发布授权。当前本地结果见[验收记录](../../docs/evidence/ai-terminal-settlement/acceptance.md)。

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
