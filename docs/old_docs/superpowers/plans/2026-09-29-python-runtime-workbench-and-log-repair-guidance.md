# Python 工作台与运行日志修复指导（调查结论）

> 日期：2026-09-29
>
> 状态：调查完成；两项修复已于 2026-09-29 在分支 `codex/python-runtime` 按 SDD 实现（提交
> `5a3fef5` 前端 pending 重试、`7d5efa2`+`d119465` 终态日志补采、`86e65a0` 补采状态保留），
> 经任务级与整分支审查及控制器裁定 R1–R5（裁定记录在 SDD ledger，见本仓库
> `.superpowers/sdd/` 工作区，不入库）。第 5.3 节的推荐顺序按裁定 R1 调整为"先关闭并排空
> 既有 watch 再补采"，其硬性约束（去重、补采先于 log.complete、不丢内容）全部保持。
> 已于 2026-09-29 经用户授权部署到 `manao-stage6b`（backend/frontend 镜像重建，runner 镜像
> 不变），修复经真实浏览器与集群验证通过（验收证据见
> [Python Acceptance](../../../../poc4/docs/evidence/python-runtime/acceptance.md) 第 6 节）；分支已于 2026-10-12
> 由 `2ef32a5` 合并到 `master`。
>
> 适用分支：`codex/python-runtime`，工作树：`.worktree/python-runtime`。
>
> 证据边界：本轮只读检查了源码、现有测试、已部署运行记录、Kubernetes Pod 日志和真实浏览器请求；没有修改代码、项目文件、数据库或部署。

## 1. 用户目标

当前优先目标只有两个：

1. 尽量降低用户进入 Python 工作台时出现红色错误提示的频率，同时保留真正错误的可见性。
2. 让 Python，尤其是 FastAPI 快速失败时的运行日志稳定进入运行历史，避免用户只能看到 `FAILED`。

本轮不处理镜像源、批量依赖或 `requirements.txt` 导入；这些属于后续改造。

## 2. 已确认的工作台红字根因

工作台打开时会并发读取文件树、Run 信息和 Python pending dependency 状态。`/files/tree` 和 `/python-dependencies/pending` 都会竞争同一个项目级 `ProjectLifecycleGate`：

- `ProjectLifecycleGate.tryAcquire()` 是立即失败的非阻塞获取；
- 竞争失败后后端返回 `409 PROJECT_BUSY`；
- 文件树查询已经复用前端的 `PROJECT_BUSY` 有限退避重试；
- `WorkbenchShell` 的 pending discovery 当前只请求一次，任何异常都会直接设置 `pendingDiscovery = failed` 并显示红色横幅。

真实浏览器复现过以下互斥结果：

```text
进入工作台 A：pending = 200，files/tree = 409 PROJECT_BUSY
进入工作台 B：files/tree = 200，pending = 409 PROJECT_BUSY
```

因此截图中的提示在该场景表示一次短暂读竞争，不表示数据库中一定存在未确认的依赖操作。后端的 pending 查询在失败时没有返回“无 pending”，所以前端不能把失败当作空结果；但前端也不应把可恢复的短暂 `PROJECT_BUSY` 立即呈现为持久故障。

相关代码：

- `poc4/backend/src/main/java/com/manao/poc4/project/ProjectLifecycleGate.java`
- `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceService.java`
- `poc4/backend/src/main/java/com/manao/poc4/workspace/PythonDependencyService.java`
- `poc4/frontend/src/components/shell/WorkbenchShell.tsx`
- `poc4/frontend/src/api/projectBusyRetry.ts`
- `poc4/frontend/src/features/files/fileQueries.ts`

## 3. 红字问题的最小修复建议

### 3.1 第一优先级：复用现有只读退避重试

为 `listPendingPythonDependencies()` 的工作台 discovery 增加和文件树一致的有限重试：

```text
仅当错误是 409 + code=PROJECT_BUSY 时重试
最多 3 次额外请求
使用现有的指数退避和随机抖动
最终成功：正常处理 pending 结果，不显示红字
最终失败：保留红字和 Retry 按钮
```

建议复用 `projectBusyRetry.ts` 的判定和延迟策略，不新增第二套退避常量。

必须保持以下边界：

- 只读 GET 可以重试；
- 依赖变更 POST 不自动重试；
- reconcile POST 不自动重试；
- 不能把查询失败伪装成“没有 pending 操作”；
- 非 `PROJECT_BUSY` 的 409、认证失败、权限失败和网络失败继续按真实错误处理。

### 3.2 第二优先级：评估后端 pending 查询是否需要轻量化

`pending()` 只做所有权校验和数据库 pending 状态读取，不访问 workspace-agent，也不执行文件变更。可以单独评估让它不占本地项目生命周期锁，但这不是第一修复的前置条件。

如果进行该优化，仍必须保留：

- owner 校验；
- 项目不存在和删除中的状态保护；
- pending 状态的数据库一致性；
- 与依赖变更、删除、恢复之间的明确语义。

不建议把整个 `ProjectLifecycleGate` 改成阻塞等待。它还保护 Run、workspace mutation、dependency change、日志 ticket、删除和恢复等流程；全局阻塞会扩大请求等待和死锁风险，也不能替代跨实例分布式锁。

## 4. 已确认的 Python 日志根因

当前运行日志链路是：

```text
RuntimeMaintenanceLoop（每 3 秒）
  -> RunObservationService.observe()
  -> JobCoordinator.observe()
  -> 仅当 Pod 仍被判断为运行中时调用 RunLogIngestor.ensureWatch()
  -> Fabric8 watchLog()
  -> 持久化 run_log_chunk
```

`RunObservationService` 的关键逻辑是：

```java
if (job.running() && job.podName() != null) {
    if (!job.applicationTerminated()) {
        logIngestor.ensureWatch(...);
    }
}
```

因此存在一个明确窗口：

```text
Pod 启动
  -> FastAPI 在约 2 秒内启动失败并退出
  -> 第一次 3 秒观察发生时，容器已经终止
  -> 从未建立 watch
  -> settleAndComplete() 只关闭已有 watch，不补采历史日志
  -> Run 是 FAILED，但 run_log_chunk 为 0
```

线上 `test5` 已观察到两次该结果：

- 容器日志包含完整 `Traceback`、`ConnectionRefusedError`、`pymysql.err.OperationalError` 和 `Application startup failed`；
- 对应数据库 Run 的 `run_log_chunk` 数量均为 0。

这证明问题在 Kubernetes 日志到 Manao 持久化之间，不是 Python 没有输出，也不是单纯前端渲染问题。

相关代码：

- `poc4/backend/src/main/java/com/manao/poc4/config/RuntimeMaintenanceLoop.java`
- `poc4/backend/src/main/java/com/manao/poc4/run/RunObservationService.java`
- `poc4/backend/src/main/java/com/manao/poc4/run/RunRecoveryService.java`
- `poc4/backend/src/main/java/com/manao/poc4/log/RunLogIngestor.java`
- `poc4/backend/src/main/java/com/manao/poc4/log/PodLogGateway.java`
- `poc4/backend/src/main/java/com/manao/poc4/kubernetes/Fabric8PodLogGateway.java`
- `poc4/backend/src/main/java/com/manao/poc4/kubernetes/Fabric8JobCoordinator.java`

## 5. 日志问题的不过度工程化修复建议

### 5.1 保留当前实时路径

继续在运行期间使用现有 `watchLog()` 实时持久化日志。不要替换为新的消息队列、独立日志服务或 Python 专用日志路径。

必须保留当前安全边界：

- 日志绑定经过 `JobCoordinator` 验证的 Pod；
- 使用 Pod UID，而不是只使用 Pod 名；
- 固定应用容器名；
- 持久化优先于 WebSocket 通知；
- 现有序号和重连去重逻辑继续有效。

### 5.2 增加终态历史补采

为 `PodLogGateway` 增加一个明确的非 follow 历史读取能力，例如：

```java
readLogs(namespace, podName, container, lineConsumer)
```

Fabric8 实现使用同一个经过验证的 Pod 和应用容器，通过 Kubernetes Pod logs 的非 follow 读取获取完整历史内容。

补采必须复用 `RunLogIngestor` 的相同 ingest、UTF-8 分块、序号和去重路径，不能一次性绕过日志窗口直接写数据库。

### 5.3 终态处理顺序

推荐顺序：

```text
JobCoordinator 确认同一个 Pod/容器已经终止
  -> 对同一 Pod 执行一次历史日志补采
  -> 关闭实时 watch，等待已有缓冲内容排空
  -> 持久化 Run 终态
  -> 发布 log.complete
```

不能在补采前发布 `log.complete`。否则浏览器会收到“日志完成”后，后端才补写日志，产生可见顺序错误。

如果补采遇到暂时性 Kubernetes API 错误：

- 不要重新执行应用；
- 不要重复创建 Job；
- 不要盲目把日志标成完整；
- 允许下一轮观察有限重试；
- 超过明确预算后，再按现有日志缺口语义写入安全的 gap marker 并完成 Run。

第一版可以只做一次终态补采加下一轮重试，不需要引入复杂的后台任务系统。

### 5.4 去重要求

终态补采通常会从日志头重新读取，因此必须保证：

- 已由实时 watch 持久化的来源 chunk 不重复写入；
- 从未建立 watch 时，从 0 个已持久化来源 chunk 开始补采全部日志；
- 实时路径和补采路径使用相同的行切分及 UTF-8 字节限制；
- 不能用不同的 chunk 计数规则导致后续日志被错误跳过。

现有 `RunLogIngestor` 的 `lastSeq`、`sourceChunks`、`skipChunks` 和 `RunLogWindow.canAppend()` 可以作为实现基础，但需要先补测试确认终态补采的计数语义。

## 6. 必须新增或调整的测试

### 6.1 工作台 pending discovery

至少覆盖：

1. 第一次 pending 请求返回 `409 PROJECT_BUSY`，第二次返回 `200`：最终不显示红色错误并正确处理结果。
2. 连续达到重试上限后仍为 `PROJECT_BUSY`：显示错误和 Retry 按钮，且请求次数有上限。
3. 非 `PROJECT_BUSY` 的错误：不走忙碌重试，不伪造 pending 为空。
4. 依赖变更 POST 和 reconcile POST：确认没有被全局 GET 重试逻辑误伤。

参考现有测试：

- `poc4/frontend/src/components/shell/WorkbenchShell.test.tsx`
- `poc4/frontend/src/features/files/fileQueries.test.ts`
- `poc4/frontend/src/api/projectBusyRetry.ts`

### 6.2 日志采集

至少覆盖：

1. **快速失败且从未建立 watch**：终态历史日志被补采，Run 日志非空。
2. **watch 已采集部分日志后终态补采**：已有 chunk 不重复，遗漏内容被补齐。
3. **Pod phase 滞后但应用容器已终止**：不产生错误 gap，终态补采仍执行。
4. **补采 API 暂时失败**：不提前发布 `log.complete`，后续可重试或最终明确标记缺口。
5. **Java 与 Python 共用路径**：至少保留一个 Java 运行日志回归用例，证明没有 Python 专用分叉导致回归。

参考现有测试：

- `poc4/backend/src/test/java/com/manao/poc4/log/RunLogIngestorTest.java`
- `poc4/backend/src/test/java/com/manao/poc4/run/RunObservationServiceTest.java`
- `poc4/backend/src/test/java/com/manao/poc4/run/RunRecoveryServiceTest.java`
- `poc4/backend/src/test/java/com/manao/poc4/kubernetes/Fabric8JobCoordinatorTest.java`

## 7. 非目标与禁止事项

本轮修复不要：

- 修改 Python runner 的启动等待来掩盖日志采集缺口；
- 为 Python 单独复制一套 Run/Log 处理；
- 把全局项目锁改成无限或长时间阻塞锁；
- 对可能已经应用的依赖 POST 自动重试；
- 对可能已经创建 Job 的 Run POST 自动重试；
- 引入 Kafka、RabbitMQ、Redis Streams 或独立日志服务；
- 通过前端隐藏红色提示来替代后端状态核对；
- 重做 `run_log_chunk` 表结构；
- 顺便实现镜像源、批量依赖、requirements 导入或其他 Python 功能。

## 8. 实现 agent 的验收要求

实现 agent 完成后，必须分别提供：

1. 修改文件列表和每个文件的职责；
2. 红字重试的单元／组件测试结果；
3. 日志补采相关的后端测试结果；
4. `git diff --check` 结果；
5. 编码检查结果，新增或改写文件必须是 UTF-8 无 BOM；
6. 若进行了云端部署，记录实际镜像 digest、部署时间和运行验证证据；
7. 明确区分本地测试、容器测试、真实浏览器测试和真实 Kubernetes 测试；
8. 说明任何未验证的边界，不能把局部测试写成完整 Stage 6B 或 Python 全量 PASS。

实现 agent 不得仅凭测试通过声称日志问题已解决，必须至少验证一个“快速失败且原先会产生 0 条日志”的真实或等价回归场景。