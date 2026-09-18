> **历史来源 / 2026-09-17 已被现行记录取代：** 当前 6A 范围、验收决定和证据以[唯一现行事实现状](../../../../../docs/Stage6A-Current-Facts.md)为准。下文保留原时点的设计、计划和结果；其中“当前”、待实施、FAILED/不允许 6B 等只描述旧时点，不覆盖本次用户验收决定，也不自动授权重新执行。原始结果不改写。此链接指向主检出的单份文档，不复制第二份现状。

# Stage 6 可靠项目清理：设计规格

日期：2026-09-10
状态：核心行为已在本任务中确认；本文件用于实施前审阅，不代表执行授权或验收通过。

## 1. 基线与范围

- 工作树：`D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes`。
- 规划核验 HEAD：`a002b41bf4b969b05ec7220052d1654df959a101`；规划开始时无未提交改动。
- 需求来源：`poc4/docs/evidence/stage-6/2026-09-10-status-and-next-steps.md` 第 5 节第 1 点；引用任务“6A下一步方向”已读取。
- 上位规格：`poc4/docs/2026-08-27-ensoai-stage-6-real-backend-kubernetes-design.md`；原始实施计划和 `poc4/docs/evidence/stage-6/6a-gate.md` 的阶段门继续有效。
- 基础五项历史 PASS 不是完整 6A PASS。历史 Run/Job 不一致仍归下一步处理，不能用清理成功关闭该问题。
- 本切片只做可靠删除、失败清理、测试资源追踪及其回归。禁止顺带实施 6B、重写 Run 终态恢复、扩展生产多副本架构或增加项目删除 UI 操作入口。

## 2. 已确认的用户决策

**D1：不取消创建。** CREATING 项目的 DELETE 返回明确的 409，不修改状态，不删除资源。测试清理器有界读取状态，等待 provisioning/recovery 结束后再删；超时记录未完成，继续其他项目。

**D2：持久化删除意图。** READY/FAILED 项目满足删除前置条件后进入 DELETING。删除中不允许新增 Run、文件修改或重新 provisioning；失败及进程重启不得退回 READY。后续先核对状态，由明确的 DELETE 继续清理。确认相关资源消失后才删除数据库记录。

不引入全库自动清理任务、后台删除队列或对既有诊断的自动回收。

## 3. 可执行的不变量

| 编号 | 必须成立的约束 |
|---|---|
| I01 | owner 校验先于状态暴露和副作用；不存在与非 owner 均为 404，其他 owner 无资源或数据库变化。 |
| I02 | CREATING 的删除总是冲突；排队中的 provision、正在执行的 provision、stale recovery 与删除互斥。 |
| I03 | Run 创建、workspace mutation 登记与删除资格检查使用相同的 project 行作为数据库并发锚点。 |
| I04 | DELETING 是不可逆的删除意图；只有继续删除或最终删除记录，不恢复成 READY/FAILED。 |
| I05 | 同一项目的本地长操作与清理互斥；不同项目不使用全局生命周期锁。Kubernetes 等待期间不持有数据库事务。 |
| I06 | 先停止该项目本地生产者/连接，再清理 Job、所有所属 Pod 和 Service；确认 workload 消失后才删 PVC；确认 PVC 消失后才删关联 DB 行。 |
| I07 | 单资源错误不跳过同层其他资源，单项目错误不跳过其他项目；任何未知、Forbidden、timeout、remaining 都不是清理完成。 |
| I08 | 创建请求至多发送一次。响应丢失时只读取状态和精确身份；不把 0 个匹配立即解释成创建未生效，也不靠 POST 重试找回项目。 |
| I09 | DELETE 的 204/404 只是 API 侧结果，不等于 Kubernetes 和 DB 双重核验。清理验收须有独立只读验证。 |
| I10 | 每个用例及时释放；worker/套件结束保留兜底；进程被强制结束时仍有可显式续作的持久化台账。 |
| I11 | 默认不保留新诊断；显式开启时，本次 invocation 最多保留精确匹配的一份。既有诊断不属于本次自动清理集合。 |
| I12 | 不盲重放 workspace mutation 或可能已生效的删除；不输出 token、密码、kubeconfig 或浏览器原始 trace。 |

## 4. 状态与 HTTP 契约

```text
CREATING --provision/recovery--> READY / FAILED
CREATING --DELETE-------------> 409，保持 CREATING
READY/FAILED --取得删除资格----> DELETING
DELETING --资源清理未完成------> DELETING + 503
DELETING --明确续作 DELETE-----> 再核对、再尝试尚未完成的删除
DELETING --资源核验+DB事务成功-> 项目记录不存在 + 204
```

| 情况 | HTTP / code | 固定安全 message |
|---|---|---|
| 非 owner 或项目确实不存在 | 404 / ENTRY_NOT_FOUND | Project not found |
| CREATING | 409 / PROJECT_CREATING | Project is still being created |
| 存在 active_run_marker=1 | 409 / RUN_ALREADY_ACTIVE | A run is already active |
| 本地生命周期忙或 READY 存在 PENDING 写操作 | 409 / PROJECT_BUSY | Project is busy |
| DELETING 的其他业务入口 | 409 / PROJECT_LOCKED | Project is locked |
| 已进入 DELETING，但资源/本地句柄/DB 清理未完成 | 503 / PROJECT_CLEANUP_INCOMPLETE | Project cleanup is incomplete |
| 完成当前 owner 的整个删除协议 | 204，无 body | 不适用 |

DELETE 不会隐式停止 Run。测试 teardown 如需停止 Run，只能显式调用已登记且属于本次测试的 Run 停止接口，并先留证；不得改库强制终态，也不得把用例失败改成通过。

FAILED 项目遗留的 PENDING receipt 元数据可以在明确删除整个项目时随最终 DB 事务移除，但必须先确认相关执行进程/Pod 停止。该操作不是重放或伪造 receipt。受保护诊断必须先由操作者明确解除本次台账中的 HOLD。

## 5. 后端结构

### 5.1 短事务 + 同项目生命周期门闩

增加 `ProjectLifecycleGate`，提供可重入的、按 projectId 的非阻塞 Lease；实现引用计数安全回收，禁止移除仍有持有者/竞争者的锁对象。调用者在取得 Lease 后重新读取权威状态。

门闩覆盖 provisioning、stale project recovery、workspace 读写/receipt reconciliation、Run start/observation/recovery 的单 Run 处理，以及显式项目删除。Run 观察/恢复只增加排他与最新状态核对，不改变原有终态/fencing 算法；迟到的扫描不能重新 attach watch。它用于当前单后端实例的长操作排他，不代替持久化状态，也不宣称提供跨实例分布式锁。

删除资格由 `ProjectDeletionRepository.begin(ownerId, projectId)` 在事务内取得：

1. 按主键 `SELECT id, owner_id, state, workspace_revision FROM project WHERE id=? FOR UPDATE`。
2. 核对 owner；CREATING 返回冲突；active Run 返回冲突。
3. READY 且存在 PENDING workspace operation 返回 busy；FAILED 遗留 receipt 走显式全项目删除。
4. READY/FAILED 更新为 DELETING；已有 DELETING 返回可继续清理。
5. 提交短事务，再访问 Kubernetes。不得把网络调用放进事务回调。

Run 插入与 workspace PENDING 登记在同一个 project 行锁内复核状态。Run 只能 READY；内部模板写仅允许 CREATING，普通写只允许 READY。事务内拒绝 DELETING/不存在的项目，迟到的 commit 不能推进 revision 或留下半提交 operation。

`markProjectReady` / `markProjectFailed` 当前已有条件 UPDATE；保留条件并补 DELETING 回归，不把它们改成无条件更新。恢复循环每次取得门闩后重新确认 CREATING，单项目失败不阻断其他项目。

### 5.2 禁止 bridge 复活和迟到的本地写入

`WorkspaceConfig` 的 EndpointResolver 目前会懒加载 `manager.allocate(projectId)`。该入口也必须取得同项目门闩并复核可访问状态；DELETING/不存在时不得 allocate。

明确删除使用项目级 `closeProject` 而不是对全局 manager shutdown；它终止该项目 bridge，清掉引用和 hold 标记，并确认已停止。停止失败时保存句柄供下一次清理核对，不能先丢句柄后假装成功。maintenance 不得重建删除中的 bridge；锁顺序固定为 project gate -> bridge manager，不得反向获取。

票据签发和新 WebSocket/PTY 握手也在产生句柄前取得门闩并复核状态，防止清理扫描之后出现迟到连接。在删除关联 DB 行前，对记录在该项目下的 Run，停止 log watch、等待在途回调退出、关闭绑定 WebSocket/PTY、移除对应内存缓存/监听器。只清理该项目，不调用全局 teardown。关闭有失败时保留 DELETING，不继续删 PVC/DB。

### 5.3 Kubernetes 分层清理

新增 `ProjectResourceCleaner`，由 `Fabric8KubernetesGateway.deleteProjectResources` 委托。现有 provision/recovery 的失败清理共用它，避免两份实现漂移。

范围统一为 `WorkspaceResourceFactory.projectResourceLabels(projectId)`：managed-by + projectId + stage6-test；不附加 component=workspace。逐项核对命名空间、标签和观察到的 UID，不得接受客户端传入资源名称或 selector。

执行顺序：

1. 盘点同标签 Jobs/Pods/Services/PVC，记录各类型是否成功读取。
2. 逐项删除 Jobs（foreground）、所有所属 Pods（包括 initializer、workspace、Job Pod）、Services；一个失败仍尝试同层其他项。
3. 重新读取 Jobs/Pods/Services。只有三类均成功读取且为空，才进入存储阶段。
4. 逐项删除 PVC，再复查四类资源全空。
5. 汇总失败/未尝试/仍存在项；只在本地句柄与资源都确认清空后允许最终 DB 删除。

返回结构化内部报告，不把原始 Kubernetes 异常文本返回浏览器。已有的 `deleteProjectWorkloads` 是“保留 PVC 的 reconciliation 现场处理”，保持独立方法：可覆盖 initializer + workspace workload，但不删除 PVC/DB、不把它升级成全量清理。

Kubernetes 请求成功不证明对象已消失；finalizer 和异步级联删除必须通过复查判定。[S3]

## 6. 数据库与前端兼容

- 仅新增 `V8__project_deleting_state.sql`，扩展 `ck_project_state`；不编辑 V1-V7，不清库、不回写历史状态。
- 项目 quota 继续统计全部项目行，DELETING 也占用名额，直到最终删除完成。
- 最终短事务顺序：terminal_audit -> terminal_session -> log_ticket -> run_log_chunk（按已锁定项目的 Run）-> run -> workspace_operation -> project。
- 最终事务必须再次核对 owner、state=DELETING、无 active Run；任一失败全部回滚并保留追踪记录。
- 前端 `ProjectState` 增加 DELETING；Card 显示“Deleting”，不提供 Open。路由显式显示删除中页面，不能落入当前默认 READY 的 Workbench 分支。
- 删除中详情/列表可轮询读取，但不自动发送 DELETE。已打开的工作台收到 DELETING/404 时停止新请求并保留未保存缓冲区，提示项目不可用；不得悄悄丢弃编辑内容。
- 新错误码加入类型与安全 allowlist，保留未知错误的 opaque fallback；不增加新的用户删除按钮。

## 7. 测试资源台账与统一清理器

### 7.1 身份与持久性

每次 suite invocation 生成独立 ID 和唯一报告目录；每项创建之前先落盘意图：invocationId、testId、attempt、workerKey、ownerId、ownerKey、精确 name、创建时间窗、projectId（初始 null）、已知 runIds、状态和安全错误类别。禁止存储登录密码/token。

每个测试/attempt 独立文件，避免多 worker 修改同一 JSON；写入临时文件后在同一已验证目录内替换。Windows 路径必须先校验位于当前 invocation 目录内且不穿越 reparse point。

状态集合：PREPARED、OWNED、CREATE_UNCERTAIN、API_CLEANED、HELD、UNRESOLVED、VERIFIED。只有独立 DB + Kubernetes 核验器能把 API_CLEANED 改成 VERIFIED。不得在 finally 中清空未完成条目。

创建响应丢失时使用同一 owner 的列表，按精确 name、预登记时间窗（允许 5 秒时钟偏差）和 invocation 唯一标识核对；唯一匹配才绑定 ID。零匹配继续有界读取；多个匹配、认证失败或持续网络故障记 UNRESOLVED，不模糊匹配、不补发 POST。

### 7.2 逐项清理与兜底

- 自动 test fixture 在每项结束后，先采集必要且脱敏的失败证据，再处理该项的项目，逆序释放。
- fixture 拥有独立 APIRequestContext，不依赖已被销毁的 page/request。Playwright 的 test/worker fixture 生命周期和失败 worker 重建是设计依据。[S1][S2]
- 每个项目独立 try/catch；保留业务失败和 cleanup 失败两个结果，不互相覆盖。
- CREATING：按 D1 有界等待；active Run：只停止台账明确登记的测试 Run，核对停止结果后再 DELETE；陌生活动 Run 直接留待人工核对。
- DELETE 网络异常：先 GET 同一 project，再决定是否继续同一个删除；404 仍只标记 API_CLEANED，等待独立验证。
- worker 结束及整个 suite global teardown 都扫本次 invocation 的未完成台账；每次只处理它登记的项目。
- 强制结束进程不保证 hook 执行。提供默认只读的 resume 入口；显式 Apply 后才对所选 invocation 续作，仍走原 owner API，不直接执行 SQL DELETE/kubectl delete。

### 7.3 预算（本计划默认值，实施中以测试验证而不是无限延长）

| 项目 | 上限 |
|---|---|
| 普通状态读取请求 | 10 秒 |
| 创建身份丢失的核对窗口 | 30 秒，不重发 POST |
| CREATING 等待 | 180 秒，不修改当前 10 分钟 stale recovery 阈值 |
| 后端一次资源清理总预算 | 90 秒；单次 Kubernetes 请求 5 秒；轮询 250 毫秒 |
| 客户端一次 DELETE 请求 | 110 秒，且不得超过当前项目剩余预算 |
| 单项目 teardown 总预算 | 300 秒；各阶段共享截止时间 |
| 单用例 fixture | 660 秒，覆盖当前最多两个项目的测试 |
| suite 兜底每项目 | 120 秒；仍未完成则失败并保留台账 |

预算到期必须停止本项的新副作用、记录未完成，再继续下一项；不会将 CREATING 强制改成 FAILED，也不会降低既有用例断言。

## 8. 诊断保留与恢复边界

- 新 invocation 默认 HOLD 关闭；开启时需精确 ownerId + projectId（创建前可用预登记的完整 name），并使用单槽持久标记避免多个 worker 各保留一份。
- 保护已有失败项目 `083b8efd-9f57-4cb4-aa6f-646b37bd6d57` 及历史 null-receipt 诊断；它们不属于新台账，不能被本切片测试或 resume 自动回收。
- 采证后操作者对精确条目执行 ReleaseHold + Apply；随后正常清理。没有解除 HOLD 就只能报告 HELD，不能给出零残留 PASS。
- UNRESOLVED 是失败而不是“允许保留第二份诊断”；遇到身份/认证问题可能有多个未完成项，必须完整报告，不能为了凑保留上限冒险删除。
- DELETING 项目在后端重启后只可显式继续删除；不自动扫历史 READY/FAILED/DELETING。

## 9. 验收与非目标

验收分四层：纯 Java/前端单测 -> disposable MySQL 并发与事务测试 -> 受限身份的真实 cleanup 专项与基础五项 -> 独立资源/DB/进程只读核验。

压力与故障 spec 必须统一接入清理机制；完整 8 MiB 压力和三类故障的业务验收仍属后续 Stage 6 工作。此切片只单独验证其清理接线、worker 更换及故障恢复后的续作，不把未执行的业务矩阵标成 PASS。

必须固定代码 SHA、JAR checksum、镜像 digest、Flyway 版本、受限身份、节点可调度性、退出码、skipped 数量和每个项目的前后清单。专项通过只能标记 CLEANUP_SLICE_PASS，不等于 6A PASS。

本次规划不操作真实环境；实施时真实测试另行确认启动/故障注入边界。测试数据库使用独立 schema；MySQL 1419/DDL 权限错误必须如实报环境阻断，禁止改运行库或临时使用管理员身份凑绿。

## 10. 文档核对依据

当前工具未暴露 Context7 的 resolve/query 接口（资源列表也为空），因此仅就框架语义核对官方资料，不声称执行过 Context7 请求。没有升级依赖：Java 17、Spring Boot 3.5.9、Fabric8 7.7.0、Playwright 声明 ^1.62.1、Vitest 声明 ^3.2.7；执行前仍以 lockfile 和实际解析版本固定证据。

- [S1] Playwright Fixtures：`https://playwright.dev/docs/test-fixtures`，2026-09-10 核对；用于 fixture 作用域、生命周期和独立超时。
- [S2] Playwright Retries：`https://playwright.dev/docs/test-retries`，2026-09-10 核对；用于失败 worker 更换及持久台账理由，不启用测试重试。
- [S3] Kubernetes Garbage Collection：`https://kubernetes.io/docs/concepts/architecture/garbage-collection/`，2026-09-10 核对；用于异步删除与 finalizer 证据边界。
- [S4] MySQL Locking Reads：`https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html`，2026-09-10 核对；用于同 project 行的事务内状态复核。实际服务器版本由实施前 preflight 记录。
- [S5] Spring programmatic transactions：`https://docs.spring.io/spring-framework/reference/data-access/transaction/programmatic.html`，2026-09-10 核对；沿用现有 TransactionTemplate，不引入长事务。
- [S6] Fabric8 官方示例：`https://github.com/fabric8io/kubernetes-client/blob/main/doc/CHEATSHEET.md`，2026-09-10 核对；仅参考删除策略，方法签名最终须由本地 7.7.0 编译与 mock-server 回归验证。
