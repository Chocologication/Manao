# AI 任务终态回传调查（2026-10-25）

## 结论与证据边界

故障机制已验证：Run 恢复巡检持有项目级 `ProjectLifecycleGate` 时，AI 的最终消息与终态回调会被 `409 PROJECT_BUSY` 拒绝。Worker 紧接着重试一次，失败后吞掉异常并返回；随后既没有持久终态补投，也没有后端持续对账。结果是 Worker 已完成，`agent_task` 仍为 `RUNNING`、保留项目占用，前端继续禁止人工停止应用。

这比上一轮“网络异常或锁竞争尚不能判断”的结论更具体：**历史 binlog 与隔离复现共同强烈指向恢复巡检锁竞争**。但 2026-10-22 原始 HTTP 失败响应没有保留，不能把本次复现得到的 `409` 冒充为历史抓包；不能证明当时全部请求均为 409，也不能绝对排除同时发生的传输异常。

本轮没有产品代码修复、集群发布、模型调用、线上状态修复或项目停止。既有 Stage 2 PAUSED / NOT_GRANTED 不变。

## 身份与新鲜状态

- 项目：`bdddc018-f472-4fb9-a636-f164ed37b0cc`，`java-web`。
- AI Task：`b3b32518-f0ed-411e-aa85-1ecef95fbdc5`；Conversation：`fc2ec3b4-3c01-4289-911d-4cd355ad84e6`。
- 应用 Run：`b352f5b7-f6a7-4e9b-9ac1-be4ca3b4fc6b`。
- 集群：`kubernetes-admin@learn` / `manao-stage6b`；运行库：`manao_poc4_6b`。
- 2026-10-25 13:53:12 +08:00 重新读取：AI Task 仍为 `RUNNING`，进度 lastSeq=36，updated_at=`2026-10-22T10:32:05.008673Z`。
- Run 已在 `2026-10-22T12:31:56.257454Z`（北京时间 20:31:56）结束为 `TIMED_OUT`。应用超时生效，残留的是独立的 AI Task 占用。
- Worker 在上轮 2026-10-22 查询为 `COMPLETED`；本轮因容器后来重启，原 Task 查询已为 404。不能把本轮 404解释成“原任务从未执行”。

部署身份未变：backend OCI digest `sha256:726c095f15d4866fbcea48146c90faf2fb1a6d680f02629f6ea893e49f694af1`；worker OCI digest `sha256:dd06e4148d466127914ebf0bc04e27b5f078d4061f4485f1c0b4221831e269f8`，对应已记录的 `a7d0041` 发布源码。调查 checkout 为 `codex/ai-integration@8d4c573`；以下相关 Java/TypeScript 实现与该发布源码 `git diff` 无差异。

## 历史 binlog 时间线

通过 MySQL 只读文件读取取得 `binlog.000033`（16,948,834 bytes），使用 mysqlbinlog 解码、仅提取相关项目/Task/Run 的事务字段；没有回放 SQL。以下是服务器事务提交时间，精确到微秒，均为 **2026-10-22 北京时间**：

| 提交时间 | 历史事实 |
| --- | --- |
| 18:32:05.008673（应用绑定时间） | AI 进度写入到第 36 条，此后该 Task 没有新进度提交 |
| 18:32:09.718714 | 同一 Run 由 `RUNNING` 变为 `RECOVERING`；binlog position 13768025 对应 Run row event |
| 18:32:09.738274 | 最终 assistant 回答写入 Conversation，第 113 → 114 条；entry row event position 13769888 |
| 18:32:09.799732 | 同一 Run 由 `RECOVERING` 恢复 `RUNNING`；Run row event position 13775598 |

第一条的 updated_at 是应用 Clock 字段，后三条是 `original_committed_timestamp`；没有混为一种时钟。`RECOVERING` 两次提交间隔 81.018ms，最终回答提交位于期间。`recoverRuns()` 第二段在持有相同 project gate 的情况下调用 `coordinator.observe()`，因此恢复动作与回传具有直接争用条件。binlog 能证明已提交状态与时序，不能记录未提交的 HTTP 409。

最终回答 text 使用 UTF-8 传输，经本地 Windows 终端解码得到 2,087 bytes，terminal JSON 2,169 bytes，均远低于 8 KiB；这个排除检查不依赖将聊天文本写入报告。14 次工具调用均已 COMPLETED，相关文件操作 COMMITTED。上下文落库成功而 progress 未落库，与两条路径的锁边界不同相符：Context 使用数据库事务，不获取项目内存 gate；Progress 获取 gate，竞争时直接拒绝。

## 可重复的隔离实验

本次实验没有调用线上回调，所有 HTTP 目标均为 `127.0.0.1` 临时端口：

1. 从当前线上 worker **只读**取得 `/app/dist/backend-client.js`，SHA-256=`f3e401e62b8792fb634ca660b27bf646e7dc98708bf00807f52d66063d78b69f`。在本地 VM 中原样运行其中 `BackendClient` / `ProgressChain`；非相关模块只提供字节上限常量。
2. 使用真实 Java `RunRecoveryService`、`AgentTaskService`、`ProjectLifecycleGate`、`AgentTaskStore`、`JdbcRunStore`，数据库使用本机独立的 `manao_stage6_<uuid>` 临时 MySQL schema，执行 V1–V14。
3. 仅将 Kubernetes `JobCoordinator.observe()` 替换为 latch，控制观察持锁窗口；应用工具终态检查返回“已确认可释放”，排除工具未收尾造成的阻挡。HTTP 适配器直接调用真实 `applyProgress`，将其 `ApiException(PROJECT_BUSY)` 映射为409；它不是完整 Spring MVC/鉴权集成测试。
4. 先成功发送36条，再让真实恢复流程进入观察并持锁；使用生产 Worker 逻辑发送37号最终消息和38号终态。

实际结果见 [隔离实验安全结果](terminal-settlement-race-safe.json)：

| 阶段 | 结果 |
| --- | --- |
| 无锁竞争的前36条 | lastSeq=36，Task RUNNING |
| 巡检持锁时37号最终消息，两次发送 | 均 HTTP409 / PROJECT_BUSY |
| 巡检持锁时38号终态，两次发送 | 均 HTTP409 / PROJECT_BUSY |
| Worker `sendTerminal` 返回 | 正常 resolve；内部只保留 `AI_PROGRESS_REJECTED` 错误，Task仍 RUNNING |
| 巡检释放锁后 | Run恢复 RUNNING；Task仍 RUNNING、lastSeq36、writesLocked=true |
| 人工重放**原37/38号相同载荷**到本地实验端口 | lastSeq38，Task COMPLETED，writesLocked=false |

这是生产投递代码配合真实后端业务方法和真实 MySQL 的受控并发复现，证明短暂项目锁竞争足以产生整个故障；不是历史 HTTP 请求的重新抓取，不是修复验收。四次本地响应耗时29.49/31.53/36.09/31.74ms只是本机样本，不能当成当时集群的延迟。

保留的实验源码：[Java诊断适配器](terminal-settlement-diagnostic.java.txt)、[Worker投递探针](terminal-settlement-probe.mjs.txt)。它们作为调查附件，不是产品源码或自动执行入口。复现时将文件复制到独立临时目录并分别命名为 `TerminalRaceDiagnostic.java` / `probe.mjs`；先编译backend及test依赖，编译适配器和现有 `JdbcStoreTestSupport`，以已有本机MySQL测试账户启动适配器，读取其临时端口，再设置 `MANAO_DIAGNOSTIC_DIR` 并运行 `node --experimental-vm-modules probe.mjs <port>`。适配器只监听loopback，创建并清理独立schema；探针只通过kubectl读取worker模块，HTTP仅发往本机适配器。不可将探针路径替换为线上业务接口。

## 具体代码链

- `poc4/backend/src/main/java/com/manao/poc4/config/RuntimeMaintenanceLoop.java:56`：每15s调用恢复，虽然类注释称 Startup recovery，实际并非只在启动运行。
- `poc4/backend/src/main/java/com/manao/poc4/run/RunRecoveryService.java:68`：每轮把 STARTING/RUNNING/STOPPING 转 RECOVERING；`:77` 再持项目 gate 调用 `recoverOne`，其中包含 Kubernetes IO。
- `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskService.java:182`：回调在 gate 竞争时立即抛 `PROJECT_BUSY`，尚未 appendProgress。
- `poc4/pi-worker/src/backend-client.ts:205`：非 GAP/MISMATCH 的409统一变为 `AI_PROGRESS_REJECTED`，丢失 PROJECT_BUSY 细分类别。
- `poc4/pi-worker/src/backend-client.ts:484`：无等待的紧接一次重试，第二次失败被吞掉；`:471` 的终态投递沿用同一逻辑。
- `poc4/pi-worker/src/pi-session.ts:419`：模型执行完成就清除1800s计时器；`:427` 的终态投递没有持久确认后的补偿。
- `poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskService.java:94`：浏览器 current读取数据库，不向 Worker 持续对账；实际维护循环也没有 AI Task 对账。
- `poc4/frontend/src/components/runs/RunPanel.tsx:228`：AI占用时禁用 `Stop run`；残留Task使禁用持续。

## 历史证据的实际限制

- 2026-10-25 backend restart15、worker restart6；node1 的 Pod 日志目录只保留 backend14/15.log、worker5/6.log，10月22日对应代次已不存在。当前/previous日志不能恢复那次回调。
- `/app/logs`为空。集群 Vector aggregator 配置只有 API/data_dir，没有可查询的应用日志归档 sink。
- MySQL general_log/slow_query_log 为 OFF，statements_history_long未启用，无法从中还原拒绝请求。
- 主节点 `/var/log/audit` 是 Linux auditd 格式，不是 Kubernetes API审计，更不是业务HTTP访问日志；未将其误用为应用请求证据。
- 后续容器重启与10月25日启动时的 DNS错误是不同日期事件，不作为10月22日故障原因。

## 修复方向与本轮边界

后续应先以本次复现建立回归，再处理：终态独立的持久确认/幂等补投与后端对账、PROJECT_BUSY有界退避且不丢序列、缩短巡检持锁IO并核对周期性恢复语义、保留taskId/seq/kind/status/code的安全投递诊断。不能通过跳过身份/副作用核对、直接释放项目占用来修复。

本轮只新增调查材料和索引。编译通过；隔离复现完成；两个本地临时MySQL schema均已删除且按精确schema名复查不存在。本轮未重放或修复线上Task，未停止线上应用，未部署、重启或删除任何集群资源。

临时文件清理实际结果：已盘点两个本轮专用临时目录（一个为空，另一个9文件/17,236,008 bytes）及本轮新建backend/target（425文件/1,835,055 bytes），路径核对通过且无reparse points；自动审批在执行前拒绝精确限定的PowerShell Remove-Item，返回 `blocked by policy`。因此**没有删除任何本地文件，也没有换工具绕过**。原始binlog和解码全文没有进入仓库，但仍保留在用户本机临时目录 `C:/Users/shili/AppData/Local/Temp/manao-terminal-diagnostic-usZ84O`；空目录为同级 `manao-terminal-diagnostic-7faKcU`；backend/target是可再生编译输出。它们不属于已验证清理完成的两个本地MySQL schema。
