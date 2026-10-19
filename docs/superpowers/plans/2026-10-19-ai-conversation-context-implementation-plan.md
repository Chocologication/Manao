# AI 多会话与上下文管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. 六任务本地交付之后用户另授权发布集群并继续计划：三镜像/V13已部署，真实模型/browser主链round3通过1/1，两轮harness失败保留，详见[Context acceptance](../../../poc4/docs/evidence/ai-context/acceptance.md)§7。Git push/merge、既有项目删除未执行，云端75%自动触发仍NOT_RUN；下文原本地阶段限制是历史边界。

**Goal:** 项目内多会话、同会话多轮 AgentTask 与完整历史持久化，并复用 Pi 实现固定 1M/75% 自动压缩和空闲手动压缩。

**Architecture:** MySQL 保存 Conversation 与 Pi 原生 entries，既有 AgentTask/tool ledger/Run 继续拥有执行事实。worker 每轮从外部 entries 重建内存 SessionManager，在可等待边界追加历史；Pi 负责有效上下文和压缩。浏览器读取安全投影，复用原任务结果和项目占用逻辑。

**Tech Stack:** Spring Boot/JDBC/Flyway/MySQL；Pi 三包 1.2.0、TypeScript/Node；React/TanStack Query/Vitest/Playwright；pnpm。

**Spec:** [2026-10-19-ai-conversation-context-design.md](../specs/2026-10-19-ai-conversation-context-design.md)。

## Global Constraints

- 同一会话可连续发送多个编程目标，每轮使用新的 AgentTask，共享该会话上下文。
- 不同会话只共享项目代码，不共享聊天历史；会话没有私有工作区。
- 手动压缩只在会话空闲时可用；同项目其他会话有占用任务时也不可用。
- 1M 固定取 1,048,576 tokens；75% 阈值为 786,432；不提供用户配置。
- Pi 三包保持 1.2.0；keepRecentTokens 为 20,000；maxTokens 为 8192。
- 原 1800s、180 次工具、20 次 build 预算不变；自动压缩计入任务时间。
- 原始历史保留至项目删除；不以截断 progress 回填完整历史，不逐 token 持久化。
- 一个项目一个占用 AgentTask、worker 一个执行槽；不加队列、池或自动续跑。
- 新增两张会话表和 agent_task 的 nullable conversation_id；不新增消息副本/JSONL 权威/向量库。
- 单 entry 2 MiB；context 协议页/批 4 MiB 且最多 32 条；浏览器投影页 512 KiB；既有 internal calls/progress 仍 512 KiB。
- 前端/worker 使用 pnpm，禁止 npm；UTF-8 无 BOM，遵守 .gitattributes，git diff --check 必须通过。
- 不自动 push/merge、发布镜像、迁移运行 schema、调用云模型或删除既有项目；旧 Stage 2 PAUSED / NOT_GRANTED 保留。

## 1. 执行目录、完成方式与文件职责

在 `D:/DeepLearning/MyProjects/Project_Manao/.worktree/ai-integration` 的 `codex/ai-integration` 执行，规划代码基线`c5a76fd`，实施起点`cb0793c`。先读实际AGENTS，检查以下命令；保留之后出现的无关改动，不再创建另一个实现分支。

```powershell
git status --short --branch
git log -6 --oneline
git merge-base --is-ancestor c5a76fd HEAD
```

所有相对路径都以这个检出为根。先按当前 CodeGraph 定位源码；其未覆盖的配置/文档使用 rg/直接读取。下面精确路径为计划修改面，避免重构整个 AI/Workbench/Run 模块。

| 文件 | 职责 |
| --- | --- |
| poc4/backend/src/main/resources/db/migration/V13__agent_conversations.sql（新） | 两表、索引、可空 task 关联；不改 V11/V12 |
| poc4/backend/src/main/java/com/manao/poc4/ai/AgentConversationContracts.java（新） | 唯一 DTO/命名定义 |
| 同目录 AgentConversationStore.java（新） | JDBC 追加、顺序/重放、分页、最小压缩请求记录 |
| 同目录 AgentConversationService.java（新） | owner/project 访问、空闲压缩准入与对账、安全投影 |
| 同目录 AgentConversationController.java、AgentConversationInternalController.java（新） | 浏览器与 worker 两条既有鉴权边界的 routes |
| 同目录 AgentTaskStore.java、AgentTaskService.java、AgentContracts.java | 原事务内绑定会话、透传身份、收尾兼容；不改工具语义 |
| 同目录 PiWorkerClient.java、HttpPiWorkerClient.java、InternalBodyLimitFilter.java | 仅增加摘要协议和按路由的 body 上限 |
| poc4/backend/src/main/java/com/manao/poc4/config/AiConfig.java | 组装 concrete 会话模块，复用原依赖 |
| poc4/pi-worker/src/conversation-context.ts（新） | 外部 entries 恢复、顺序 flush、固定压缩配置/usage；一个会话适配模块 |
| 同目录 pi-session.ts、project-tools.ts、backend-client.ts、server.ts | 等待式保存屏障、当前轮结果、上下文传输和同槽空闲压缩 |
| poc4/frontend/src/contracts/agentConversation.ts、api/agentConversationApi.ts、features/ai/agentConversationQueries.ts（新） | 类型解析、API、会话级缓存与分页 |
| poc4/frontend/src/features/ai/AgentConversationPanel.tsx、ConversationHistory.tsx（新） | 会话切换/输入与历史投影；复用原工具结果组件 |
| poc4/frontend/src/features/ai/AgentTaskPanel.tsx | 保留任务状态/close/真实结果职责，可导出已有结果组件 |
| poc4/frontend/src/contracts/agentTask.ts、components/shell/WorkbenchShell.tsx | 可空 conversationId；壳层保留项目级占用，AI 页换成会话容器 |
| poc4/frontend/tests/e2e/ai-context.spec.ts、playwright.ai-context.config.ts（新） | 一条有界会话主链，无额外业务 fixture 平台 |
| poc4/docs/evidence/ai-context/acceptance.md、poc4/deploy/ai-context/README.md（实施时新建） | 实际证据、发布/回滚准备；本轮不伪造实施记录 |

执行按 Task 1→6 顺序，每项都有自己的 RED/GREEN 与规格/质量复核。后续若采用 SDD，审查只围绕当前任务交付，沿用用户“非必要不用 Astra”的偏好。规划自检由编写者直接完成，不以派发子代理代替思考。

## 2. 固定跨任务接口

以下嵌套 records 定义在 AgentConversationContracts。Java 的 entry 用 JsonNode，worker 对应 Pi 的 SessionEntry；内部类型不能直接成为浏览器 DTO。空值严格使用 null。

```java
record CreateConversationRequest(String conversationId) {}
record CompactRequest(String requestId, long expectedHeadSeq) {}
record ContextUsage(Long tokens, long contextWindow, Double percent) {}
record StoredEntry(long seq, String sourceTaskId, String writerId, JsonNode entry) {}
record ContextPage(JsonNode header, long headSeq, List<StoredEntry> entries, Long nextAfterSeq) {}
record ContextAppend(long expectedHeadSeq, JsonNode header, List<JsonNode> entries, ContextUsage usage) {}
record ContextAck(long headSeq) {}
record CompactResult(long expectedHeadSeq, List<JsonNode> entries, ContextUsage usage, String failureCode) {}
record ConversationView(String conversationId, String title, long headSeq,
                        String lastTaskId, String activeTaskId, ContextUsage usage,
                        String compactRequestId, String compactState, String compactFailureCode) {}
record ConversationPage(List<ConversationView> items, String nextCursor) {}
record HistoryItem(long seq, String taskId, String kind, String text, String toolCallId, int textOffset) {}
record HistoryPage(List<HistoryItem> items, Long nextBeforeSeq, Integer nextBeforeOffset) {}
record CompactStart(String conversationId, String requestId, long expectedHeadSeq) {}
record CompactStatus(String conversationId, String requestId, String instanceId, String state) {}
```

TaskSnapshot/WorkerStart 仅追加 nullable conversationId；保留原构造重载和旧请求路径，避免大范围改写旧测试。新增 service 重载 `submit(ownerId, projectId, TaskRequest, conversationId)` 和 Store 重载 `createTask(ownerId, projectId, TaskRequest, conversationId)`；原三参数方法传 null。worker 的 WorkerStartBody 对应可空字段。

```typescript
// conversation-context.ts；FileEntry/SessionEntry/AgentSession 从锁定 Pi 包导入。
export const CONTEXT_WINDOW = 1_048_576;
export const COMPACTION_THRESHOLD = 786_432;
export const COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: CONTEXT_WINDOW - COMPACTION_THRESHOLD + 1,
  keepRecentTokens: 20_000,
};
export class ConversationContext {
  // 内部只持有 BackendClient、身份、已确认 head/entries；不持有平台文件或 credentials。
  static load(backend: BackendClient, taskId: string, conversationId: string): Promise<ConversationContext>;
  readonly fileEntries: FileEntry[];
  prepare(manager: SessionManager, revision: string): void;
  flush(session: AgentSession): Promise<void>;
  static loadForCompaction(backend: BackendClient, start: CompactStart): Promise<ConversationContext>;
  compactionResult(session: AgentSession): CompactResult;
}
```

空闲压缩复用同模块的loadForCompaction/compactionResult；只GET固定baseSeq历史，完整suffix与usage/终态只POST result原子提交，不POST context；不要为两种身份再建 ContextProvider/StorageAdapter 接口层。source_task_id/writer_id 在后端由已验证 task/request 推导，不能信任 payload 声明。

## Task 1：持久会话、原子绑定与有界读取

**Files:** 新增 V13、五个 AgentConversation Java 文件及 `poc4/backend/src/test/java/com/manao/poc4/ai/AgentConversationStoreTest.java`、`AgentConversationHttpContractTest.java`；修改 AgentTaskStore/Service/Contracts、AiConfig、InternalBodyLimitFilter、AgentInternalSecurityTest/AgentTaskStoreTest。

**Consumes:** 原 JdbcStoreTestSupport、project-row 事务、ProjectLifecycleGate、worker epoch/instance、owner JWT 与内部 token。

**Produces:** §2 DTO；浏览器创建/list/detail/history/tasks 与任务 context GET/POST；后续使用的 `AgentConversationStore.appendForTask(taskId, instanceId, epoch, ContextAppend)`、`readForTask(taskId, instanceId, epoch, afterSeq, throughSeq)`。`throughSeq` 固定首次返回 head，避免分页读取漂移。

- [x] **Step 1 — RED：** 用 disposable MySQL 测试创建/幂等、owner/project 隔离、同一事务绑定 task/用户目标、worker 未启动时输入仍在、nullable 旧任务、跨会话改用同 taskId 的 digest 冲突、顺序追加/相同批重放/异内容冲突、分页和 FK 回收。新测试用 JdbcStoreTestSupport，每次随机 schema；禁止运行库 reset。

第一条具体回归从数据库约束入手，类中使用真实现有 scaffold：

```java
@Test void conversationSchemaIsAdditiveAndProjectScoped() {
    try (var db = JdbcStoreTestSupport.create()) {
        var jdbc = db.jdbc();
        var now = Timestamp.from(Instant.parse("2026-10-19T00:00:00Z"));
        jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('ctx-owner','ctx-owner','unused',?)", now);
        jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('ctx-project','ctx-owner','ctx','READY',7,?,?)", now, now);
        jdbc.update("INSERT INTO agent_conversation(id,project_id,title,header_json,head_seq,created_at,updated_at) VALUES (?,?,?,?,0,?,?)",
            "00000000-0000-4000-8000-000000000001", "ctx-project", "新会话",
            "{\"type\":\"session\",\"version\":3,\"id\":\"00000000-0000-4000-8000-000000000001\",\"cwd\":\"manao-project\",\"timestamp\":\"2026-10-19T00:00:00Z\"}", now, now);
        assertThat(jdbc.queryForObject("SELECT head_seq FROM agent_conversation WHERE project_id='ctx-project'", Long.class)).isZero();
        jdbc.update("DELETE FROM project WHERE id='ctx-project'");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM agent_conversation", Integer.class)).isZero();
    }
}
```

- [x] **Step 2 — 运行并确认目标失败：** `mvn -Dtest=AgentConversationStoreTest,AgentConversationHttpContractTest,AgentTaskStoreTest,AgentInternalSecurityTest test`（cwd `poc4/backend`）。记录 schema/行为缺失的有效失败，凭据或编译夹具错误不能当作行为 RED。
- [x] **Step 3 — 最小实现：** V13 按 spec 字段创建，时间由应用 Clock 写入；会话唯一身份和 owner 查找均通过 project。创建会话同时存 Pi v3 header：type=session、version=3、id=conversationId、cwd=manao-project、timestamp=created_at。TaskStore 在原 `SELECT project ... FOR UPDATE` 事务内锁定会话、核对归属/压缩占用，插入 task 和以下原生用户目标条目并增加 head，不做检查后再跨事务写入。新会话参与新请求 digest，旧 null 路径 digest 兼容。

```json
{"type":"custom_message","id":"00000000-0000-4000-8000-000000000002","parentId":null,"timestamp":"2026-10-19T00:00:00Z","customType":"manao_user_request","content":"用户提交的目标原文","details":{"taskId":"00000000-0000-4000-8000-000000000002"},"display":true}
```

JSON 展示字段形状；实现必须使用本次 taskId、Clock 时间和当前末项 id（空会话才为 null），不能把示例字符串写入运行记录。title 仅在第一条目标时更新为原文前 40 个 Unicode 字符，使用 codePoints，不能截断 surrogate pair。请求重放不再次追加目标。

```sql
-- 核心追加规则；每批一个事务，不拆成先更新 head、后插 entries。
SELECT head_seq, header_json FROM agent_conversation WHERE id = ? FOR UPDATE;
-- 验证 writer、parent/firstKeptEntryId/targetId 和 expectedHeadSeq；相同整批已存在则返回原确认。
INSERT INTO agent_conversation_entry
  (conversation_id, seq, entry_id, source_task_id, writer_id, payload_json)
  VALUES (?, ?, ?, ?, ?, ?);
UPDATE agent_conversation SET head_seq = ?, updated_at = ? WHERE id = ?;
```

`parentId` 只能为 null、同会话已存在 entry 或本批前项；retain-none 的 firstKeptEntryId 可以等于 compaction 自己的 id。重复批次按 entry_id、顺序、writer 和 JsonNode.equals 验证；混合旧/新批次拒绝，worker 只发送互不重叠的原子批次。header 由后端创建，worker 只能核对/回传相同值。

context按4MiB/32条分批，过滤器仅对精确task context和manual result路由放宽；补声明长度、流式超限和单entry超限测试。浏览器projection用seq/textOffset组合游标与nextBeforeOffset/beforeOffset，读时64KiB UTF-8安全片段、UTF-16 offset不切code point，不另存历史。append ACK前检查完整不可分HistoryPage group（含最大cursor）≤512KiB；不新增任意identifier长度限制。每轮状态由原taskId的owner-scoped TaskSnapshot读取，不新增动态seq项；toolResult details不透传。ConversationStore独立READ_COMMITTED，保留project-first锁和旧TaskStore事务。

- [x] **Step 4 — GREEN/复核：** 重新运行 Step 2；检查断言实际执行数，补并发两个连接的 task/compact 准入测试接口（Task 4 完成具体压缩准入）。与原 TaskStore 测试一起确认仍只有一个占用任务。使用真实 schema 从 V12 升到 V13，确认既有 task/tool rows 未改写。
- [x] **Step 5 — 审查并提交：** 重点审查锁顺序 project→conversation→entries、数据隔离/重放和 body 限制；提交 `feat(ai): persist project conversations and native entries`。

## Task 2：多轮恢复和必须等待的保存屏障

**Files:** 新增 worker `conversation-context.ts`、`test/conversation-context.test.ts`、`test/pi-session-context.test.ts`；修改 pi-session.ts、project-tools.ts、backend-client.ts、server.ts、已有 backend-client/pi-session/server 测试；修改 WorkerStart 透传与相应后端服务测试。

**Consumes:** Task 1 context 协议与可空 conversationId，Pi 1.2.0。

**Produces:** §2 ConversationContext；ProjectToolDeps 新增 `beforeInvoke?: () => Promise<void>`；每轮新的 PiTaskSession 从同一 conversation 的 FileEntry[] 创建，无本地历史副本。

- [x] **Step 1 — RED：** 先加以下 SDK 恢复合同测试，再在现有 scriptedSessionFactory 附近扩展模型 context 捕获，不另造 fake AgentSession。覆盖同会话第二轮含旧目标、独立会话不含旧目标、消息超过 8 KiB、中文/结构化工具调用保真、旧 toolCall 不执行、当前轮结果不误用旧 assistant。

```typescript
it("restores a native user request from external entries", () => {
  const original = SessionManager.inMemory("/scratch", { id: "conversation-a" });
  original.appendCustomMessageEntry("manao_user_request", "保留约束：响应字段名为 bookId", true,
    { taskId: "00000000-0000-4000-8000-000000000002" });
  const restored = SessionManager.inMemory("/scratch", { id: "conversation-a" }, [
    original.getHeader()!, ...original.getEntries(),
  ]);
  expect(restored.getEntries()).toEqual(original.getEntries());
  expect(restored.buildSessionContext().messages).toEqual(original.buildSessionContext().messages);
});
```

在 scripted stream 的第二次 provider 请求处断言之前的 toolResult 已收到后端 ACK；用未 resolve 的保存 Promise 证明 backend.invoke/model stream 都不会提前调用。最后一条 assistant 保存失败时，terminal 不能是 COMPLETED。测试 Event listener 先通知后 append 的实际顺序。

- [x] **Step 2 — 运行 RED：** `pnpm test -- test/conversation-context.test.ts test/pi-session-context.test.ts test/pi-session.test.ts test/project-tools.test.ts test/server.test.ts`（cwd `poc4/pi-worker`）。记录有效行为失败。
- [x] **Step 3 — 最小实现：** context 分页固定 throughSeq；还原 `[header,...entries]`，注入 `SessionManager.inMemory`。绑定新会话 id，核对后端 header。新会话路径 `session.prompt` 发送固定触发文本 `Execute the user's most recent programming goal recorded above. Use the current workspace revision; re-read relevant files before changes.`；真实用户目标已存在于原生 custom_message，不再重复发送正文。旧 task-only 路径继续原 prompt 行为。每次只 flush 未确认 entries 的后缀；网络不确定只核对原 batch IDs/head，不分配新 IDs。

```typescript
const previousPrepare = session.agent.prepareRequest;
session.agent.prepareRequest = async (request, signal) => {
  const prepared = await previousPrepare?.(request, signal);
  await context.flush(session);
  return prepared;
};
// 还包装原streamFunction：native compact绕过prepareRequest，原stream前必须await ACK并检查abort signal。
// createProjectTools 的 runToolCall 中、backend.invoke 之前：
await deps.beforeInvoke?.();
// DefaultPiTaskSession.run 中、sendTerminal 之前：
await context.flush(session);
```

以上 context 仅在新会话路径存在；旧路径不需要空壳实现。flush 串行且有界，不能吞异常。保存失败在本轮设置固定 fatal code，停止后续模型/工具，并经原 FAILED/close 逻辑结算。历史进度仍可截断，完整消息只走 context 协议。

`settle()` 改为本轮 message_end 观察到的最后 assistant，不能从恢复后全部消息 reverse().find 取旧回答；压缩改变 message 数组长度，因此也不能只记一个旧数组下标。新一轮添加包含当前 revision/上轮中断提示的 SDK custom context note，要求重新读相关文件。

如果旧任务已关闭但尾部 toolCall 不完整，只对该未完成工具轮追加 Pi `context_edit(replacement:null)`（appendContextEdit(targetId, null)，在创建AgentSession前prepare），再追加明确中断说明；两者先持久化。不得删除原 row、伪造成功 toolResult、执行旧 call 或恢复原 task。未关闭 NEEDS_ATTENTION 仍由旧任务占用，不能靠开新会话绕开。

- [x] **Step 4 — GREEN/复核：** Step 2 全通过，`pnpm build`；后端运行 `mvn -Dtest=AgentConversationStoreTest,AgentTaskStoreTest,AgentTaskServiceTest,AgentInternalSecurityTest test`。补服务重建后从 DB 恢复的组件测试，确认成功、失败和 close 均能展示真实历史且没有旧工具调用。
- [x] **Step 5 — 审查并提交：** 重点检查所有 provider/tool/terminal 边界以及旧 task-only 兼容；提交 `feat(ai): restore conversation context and await durable history`。

## Task 3：原生自动压缩、1M 配置与真实占用

**Files:** 修改 conversation-context.ts、pi-session.ts；新增 `poc4/pi-worker/test/context-compaction.test.ts`；扩展原模型 runtime/config 测试与 Task 1 usage 保存测试。

**Consumes:** Task 2 的恢复、prepareRequest/工具保存屏障；Pi 原生 compaction/usage。

**Produces:** §2 固定常量、COMPACTION_SETTINGS；ContextUsage 持久化，压缩后的原始历史不变。

- [x] **Step 1 — RED：** 运行真实锁定 SDK 的边界测试，覆盖 786431/786432/786433、摘要+recent 投影、多次压缩和工具结果增长跨阈值。首次请求前与工具循环后都要触发；以 injected usage/脚本化摘要实现，不发真实 75% 长请求。

```typescript
it("uses the fixed 1M window and inclusive 75 percent boundary", () => {
  expect(CONTEXT_WINDOW).toBe(1_048_576);
  expect(COMPACTION_THRESHOLD).toBe(786_432);
  expect(COMPACTION_SETTINGS.reserveTokens).toBe(262_145);
  expect(COMPACTION_SETTINGS.keepRecentTokens).toBe(20_000);
});
```

此常量断言不能单独证明自动压缩：同一测试文件必须通过真实 AgentSession 与 scripted provider 捕获实际摘要请求和后续压缩投影，证明等号触发及 toolCall/result 没被分开。

- [x] **Step 2 — 运行 RED：** `pnpm test -- test/context-compaction.test.ts test/pi-session-context.test.ts test/pi-session.test.ts`。
- [x] **Step 3 — 最小实现：** model runtime使用CONTEXT_WINDOW；SettingsManager.inMemory显式注入COMPACTION_SETTINGS；首轮idle/pre-prompt计算新目标、pending trigger和初始system/tools，必要时public compact，活动hook只fail-closed；不加自己的切分/摘要生成器。compaction_end 标记结果，由原保存屏障追加 SDK 已生成的 compaction/usage entries。usage 可空；保存时记对应 usage_head_seq，新增内容后以估算/未知标识，不能显示旧值为精确当前值。

摘要输入保留六工具实际消息，不依赖原生 read/write/edit 文件提取列表。用目标、明确约束、文件变化、build/HTTP 真结果、下一步的样例验证前后 context；模型摘要质量只有后续真实验收才能证明。

自动摘要失败后，若下一请求仍在阈值上方，设置 AI_CONTEXT_COMPACTION_FAILED 并终止后续 provider 请求，保留原 entries；不能从 listener 中异步抛错指望 SDK 等待。stop 和 1800s deadline 同时调用公开的 session.abortCompaction() 与原 agent.abort()，否则原有仅 abort agent 的代码不能终止独立摘要请求；加真实 SDK 的 abort signal 测试。SDK 原生自动重试受此预算控制，不增加 Manao 重试循环。压缩后的 tokens=null 显示未知，不能回填成 0。断言 ACK 失败不进入压缩后的下一请求。

- [x] **Step 4 — GREEN/复核：** Step 2 与 `pnpm build` 通过；保存失败和中断的 Task 2 测试复验。核对 package/lock 没有升级，预算仍 1800/180/20。不要为本地阈值测试添加生产可调窗口。
- [x] **Step 5 — 审查并提交：** 重点审查阈值等号、累计 usage 误用和旧 summary 边界；提交 `feat(ai): compact active context at the fixed 75 percent threshold`。

## Task 4：同一执行槽中的空闲手动压缩

**Files:** 修改 AgentConversationStore/Service/两 Controller、PiWorkerClient/HttpPiWorkerClient、AgentTaskStore、AiConfig；修改 worker server.ts/conversation-context.ts/backend-client.ts；新增 `AgentConversationCompactionTest.java`、worker `test/manual-compaction.test.ts`，扩展 server.test.ts。

**Consumes:** 已持久历史、Pi compact、Task 3 设置；project-row 事务与 worker 单槽。

实施结论：功能已完成并独立Approved；最初真实双连接准入/first-instance matrix测试在实现后首次GREEN，未完成其test-first要求。缺路由和后续修复有有效RED，详见acceptance§2，不追认替代。

**Produces:** 浏览器 compact route；§2 CompactStart/Status/Result；worker start/status 与内部 context/result routes。Store 具体方法 `beginCompaction(ownerId, projectId, conversationId, CompactRequest)`、`finishCompaction(conversationId, requestId, instanceId, CompactResult)`；Service 负责锁外派发和只读核对。

- [ ] **Step 1 — RED（流程偏差，未全量test-first）：** 测试同项目 task/compact 并发准入只接受一个；不同会话运行也拒绝 compact；其它项目占 worker 时明确忙；重复 request/丢 ACK 只查原状态；摘要成功但 callback 响应丢失不再摘要；baseSeq 已变/旧 instance/失败后的迟到回调全部拒绝。空会话/无可压缩新增内容返回 COMPLETED no-op，不调用模型。

SDK 侧额外用 spy 断言手动入口只在 active slot 空闲后调用 compact，且从不调用 prompt 或六工具；不把 `compact()` 的 abort 行为当作“暂停后恢复”。

- [x] **Step 2 — 运行 RED：** 后端 `mvn -Dtest=AgentConversationCompactionTest,AgentConversationStoreTest,AgentTaskStoreTest test`；worker `pnpm test -- test/manual-compaction.test.ts test/server.test.ts`。
- [x] **Step 3 — 最小实现：** 短锁登记 RUNNING→锁外发送 CompactStart→worker 以同槽异步 compact、120s abort→单事务提交 entries+head+COMPLETED，失败不写摘要、记固定错误。worker 同槽状态使用简单 task/compact 判别联合，不建立工作队列。

```typescript
// server.ts 的共享占用表达，替代仅能记录 TaskRecord 的 active；不是执行池。
type ActiveWork =
  | { kind: "task"; taskId: string }
  | { kind: "compact"; conversationId: string; requestId: string };
```

HttpPiWorkerClient 保留原 task 方法，增加 `startCompaction(CompactStart)`、`compactionStatus(conversationId, requestId)`；接受请求不等待模型完成，所以沿用短 HTTP transport timeout，120s 是 worker 工作预算。内部结果提交复用原 token 但按 request/baseSeq/instance 校验；禁止收到任意 conversation id 就生成摘要。

初始 ACK、首次 context GET 和最终结果都可能最先到达；在已有预登记 request/baseSeq 匹配时，用同一个原子 CAS 首次绑定 instance，后续只核对、不覆盖终态。这个绑定仍由内部 token 链认证。worker 已知同 request 返回状态，不重复 compact；120s 到时调用 session.abortCompaction()，等待 compact 拒绝后回报失败，清除 timer。

同实例在途继续等待；原 worker 实例确认更换或明确失败时将旧请求置 FAILED 并封住写入。连接超时保持待对账，不猜作失败；查询或下次准入时核对，不开后台扫描器。显式再次点击创建新 requestId；已成功旧 request 可按原 writer_id 查得。无摘要历史的 no-op 从最近请求状态答复。

- [x] **Step 4 — GREEN/复核：** 运行 Step 2 与 worker build；扩展测试证明手动摘要不停止原 ready Run、不授予源码写权限、backend 重建不永久卡死会话、取消/超时不覆盖旧 context。不额外测试无关完整 Run 故障矩阵。
- [x] **Step 5 — 审查并提交：** 重点审查慢 IO 不持 gate、两个入口同事务互斥、迟到提交封锁；提交 `feat(ai): support idle conversation compaction in the existing worker slot`。

## Task 5：项目内多会话界面与历史回放

**Files:** 新增 §1 frontend 的 contracts/API/queries/两个组件及同目录测试；修改 agentTask.ts、AgentTaskPanel.tsx/test、WorkbenchShell.tsx/test；补已有 MSW AI handlers 以覆盖新 routes，不改 mock 为验收事实。

**Consumes:** ConversationView/HistoryPage、可空 conversationId 与原工具 result route、项目级 occupying task query。

**Produces:** AI 页的会话列表、新建/切换、历史分页、多轮输入、约占用、空闲压缩按钮和状态；原任务关闭/Run 查看继续可用。

- [x] **Step 1 — RED：** 先在 API/解析和组件测试中覆盖新建不调用模型、A/B 切换不串历史、异步 A 响应不覆盖 B、刷新从后端恢复、新轮提交到当前会话、旧 task-only 数据兼容、长文本按原文显示、压缩原文保留。运行中的会话可查看但所有编程新提交仍受项目级占用禁止。

前端条件的具体回归可以先使用组件现有 testing-library 风格：

```tsx
expect(screen.getByRole('button', { name: '压缩上下文' })).toBeDisabled();
// 将 occupying task 从 RUNNING 更新为已结算后：
expect(screen.getByRole('button', { name: '压缩上下文' })).toBeEnabled();
// 仅压缩后没有新的 usage 时：
expect(screen.getByText('占用暂不可用')).toBeInTheDocument();
```

上述断言放在各测试实际 render/更新 props 或 MSW query 之后；测试 fixture 复用现有 WorkbenchShell/AgentTaskPanel 的 provider wrapper，不增加生产状态机来配合测试。

- [x] **Step 2 — 运行 RED：** `pnpm test -- src/features/ai/AgentConversationPanel.test.tsx src/features/ai/ConversationHistory.test.tsx src/features/ai/AgentTaskPanel.test.tsx src/components/shell/WorkbenchShell.test.tsx`（cwd `poc4/frontend`）。
- [x] **Step 3 — 最小实现：** 查询 key 含 user/project/conversation；历史游标与响应有 scope guard。会话选择可保存为 UI 偏好，真实历史/activeTask 始终读后端。发送任务先生成原 taskId，再保存该 taskId+conversationId 绑定；丢响应查原 task，不能因切换会话生成替代任务。

复用原 TaskPanel 的占用、close、Run/HTTP/build 结果展示，只做必要的组件导出；完整消息在 ConversationHistory 展示，不再重复显示同一条截断 progress。用户目标只投影 customType=manao_user_request，隐藏 SDK 内部触发 user message；pending 或启动前失败的目标也已在 entries 中。active task 属于另一个会话时显示可导航的“项目有任务运行中”。

手动请求先生成并保留 requestId/baseSeq，POST 不确定读会话原请求状态；GET 未登记不清身份、不自动重发。刷新或切换会话后仍可由用户显式“重试原压缩请求”，复用原 conversationId/requestId/baseSeq，不产生新身份。retry 遇拒绝只有原终态或成功 GET 证明 head 已变化、旧 base 不再可能准入时才释放；同 head 的 busy/鉴权拒绝和查询失败继续保留待对账，迟到 A 响应不污染 B。明确失败后用户再次点击普通压缩才新建 request。没有完整 usage 时不显示虚构百分比。文本/代码按文本，工具详情从已有安全 route 读取，隐藏内部 entries 与 thinking。

- [x] **Step 4 — GREEN/复核：** Step 2、`pnpm typecheck`、`pnpm build`；测试浏览器/项目切换时请求失效和原 revision-cache 修复。确保切换会话不释放 Agent/Run 锁、不主动 close、不清空别的会话消息。
- [x] **Step 5 — 审查并提交：** 重点审查缓存隔离、原 taskId 对账、raw payload 泄露与重复消息；提交 `feat(ai): add persistent conversations to the project AI panel`。

## Task 6：整合验证、发布准备与证据

**Files:** 新增 §1 的 Playwright 入口、acceptance/release README；修改 frontend/package.json 增加 `test:e2e:ai-context`、AGENTS.md、docs/what-we-have-done.md、CONTEXT.md 中会话术语（按 domain-modeling skill 执行）。不另建通用 operator 平台。

**Consumes:** Task 1–5 已通过的局部交付。

**Produces:** 可运行的最小主链、一次必要集成回归、明确未执行的外部验收与逐项发布清单。

实际本地整合：backend163/163、worker最终121/121+build、frontend165/165+typecheck/build，精确cb0793c旧代码在V13 disposable schema的27/27。Task6发现deadline timer已触发但now==deadline时误报AI_ABORTED；稳定deps.now回归先RED，再以deadlineExpired事实标记最小修复（7a7976d），只重跑受影响worker。真实E2E缺授权/env在config退出1并标NOT_RUN，未调用模型或kubectl。三镜像NOT_BUILT。完整命令/计数/时间/裁定见acceptance。

整体终审修复 I1/M1：`344ccb9`补原身份显式 retry 与安全拒绝对账；主链按原 task 核对全部 tool_call/tool_result，首轮仅一个 read_file 调用及配对结果，其余三轮零工具。最终定向40/40及build通过；限定范围复审I1/M1均ADDRESSED，无新增阻断项，批准本地实现/发布准备。六项任务已完成，严格TDD的Task4历史偏差不追认通过；详见[审查收尾](../../../poc4/docs/evidence/ai-context/review.md)。

- [x] **Step 1 — 验收入口（真实主链NOT_RUN）：** Playwright 按既有 AI config 的 auth/env 检查搭建当前入口；缺必要外部条件时标 NOT_RUN，不能以 mock E2E 冒充真实主链。操作者先在disposable项目准备96–120KiB无秘密ASCII顶层txt，A首轮只read_file一次，harness比对owner文件sha/content与原task的安全settled工具结果，以原生20k保留量产生真实摘要而非no-op；不降低窗口、不由本轮写文件。主链为A记住字段约束→同会话新 task 遵守→创建 B 并核实上下文未带 A→空闲重建 worker→重开 A→手动压缩→原文仍在且下一轮仍遵守约束。会话隔离同时在 scripted provider 的实际 context 捕获处断言，不能只凭真实模型“没有提到约束”判断。

```json
"test:e2e:ai-context": "playwright test --config playwright.ai-context.config.ts"
```

空闲 worker 重建是后续部署/验收步骤，执行前必须已获该轮授权；本轮实施/本地验证不会重启它。不复用 Stage 2 未完成场景要求删除旧项目，验收用一个明确 disposable 项目；项目回收仍需执行授权并独立核查。

- [x] **Step 2 — 必要整合回归：** Task 1–5 定向测试通过后运行一次下列相关组合，逐项记录执行数/失败/跳过与报告。不因单纯文档变更重复全部测试。

```powershell
# cwd: poc4/backend；测试账户仅允许 disposable schemas，禁止指向运行 schema reset。
mvn -Dtest=AgentConversationStoreTest,AgentConversationHttpContractTest,AgentConversationCompactionTest,AgentTaskStoreTest,AgentTaskServiceTest,AgentProjectToolsTest,AgentApplicationToolsTest,AgentInternalSecurityTest test
# cwd: poc4/pi-worker
pnpm test
pnpm build
# cwd: poc4/frontend
pnpm test -- src/features/ai src/components/shell/WorkbenchShell.test.tsx src/api/agentConversationApi.test.ts src/contracts/agentConversation.test.ts
pnpm typecheck
pnpm build
pnpm test:e2e:ai-context
```

这些 cwd 是逐条切换目录的说明，不把三组命令在一个错误目录直接连续执行。后端测试使用现有 JdbcStoreTestSupport 的配置，不打印配置值；缺测试库条件先完成其余验证，缺项如实记录。

- [x] **Step 3 — 发布准备：** README 按现有 Stage 2 发布方式列 backend/worker/frontend 三镜像、源码 SHA、实际 digest 与构建执行状态、V12→V13 备份/迁移前置检查、max_allowed_packet/内部 proxy body limit、旧 task-only 冒烟、发布前无运行 task/compact 的确认命令。发布前条件未满足写 NOT_RUN，镜像未构建写 NOT_BUILT，不杜撰 digest。

升级是 additive V13；短维护窗口允许，先停新任务/摘要入口并确认现有任务结算再部署。回滚旧应用代码可保留新增表/可空列，不能为回滚删除历史；验证旧代码在 V13 schema 上的 task-only 路径，并遵守现有 Flyway 对未来版本的实际配置，未验证前不承诺可回滚。没有授权时只写准备，不执行发布。

- [x] **Step 4 — 证据与最小清理：** acceptance 分开记录代码/本地 SDK、真实模型、浏览器、迁移/重启、自动阈值、手动摘要、清理；本地注入 usage 不等于真实云端 75% 场景。真实未触发自动压缩填 NOT_RUN；真实摘要仍保留有损概括的限制。删除本轮无用本地临时文件，保留最小必要失败记录，不删除已有项目资源或重置运行库。
- [x] **Step 5 — 最终审查/提交：** `e8248e8`提交验证/证据；Task6 I1由`505e316`修复并复审；整体终审I1/M1由`344ccb9`修复并限定范围复审Approved。规格/质量、BOM/链接、git diff --check通过，长期记录见审查收尾。没有真实全链证据，不授予云端PASS，不改旧阶段边界。

## 3. 规划自检与过度工程化专项复核（2026-10-19）

以下保留规划时的设计自检；当时未运行功能测试。实施期六项任务及整体规格/质量审查已完成，真实SDK/随机schema/组件证据见acceptance；Task4最初准入/first-instance测试首次GREEN的TDD偏差明确保留。Task6真实外部主链仍NOT_RUN；最终Approved仅限本地实现/发布准备。

| 需求或实际接缝 | 落点 | 最小性判断 |
| --- | --- | --- |
| 项目内多会话、同会话多轮、归属与 task 关联 | Task 1/2/5 | 会话是新增产品实体；保留原任务，不把会话做成另一个执行状态机 |
| 完整原生历史、工具结构、压缩原文保留 | Task 1/2 | 只有两张新表，浏览器按需投影，不另存 Message/摘要副本 |
| SDK listener 不 await，进度会截断 | Task 2 | 只增加真实执行边界上的 flush；删去逐 token 写入和全量 session 快照 |
| 中断后打开历史，不重复执行工具 | Task 2/6 | 既有 ledger/close + 原生 context_edit；不做 checkpoint 续跑或旧任务重启 |
| 1M/75%、运行中工具循环、重复压缩 | Task 3 | Pi 原生算法/摘要，固定配置；只修严格大于与含等号的映射 |
| 空闲手动压缩、网络不确定与重启 | Task 4 | 同槽 + 当前请求最小记录；删去运行中排队/中断续跑、后台 reaper、通用 operation 表 |
| 浏览器实际历史/约占用/原结果入口 | Task 5 | 不改造整个聊天产品，不加附件/分叉/搜索/分享/重命名 |
| 原工具/Run/预算和旧验收兼容 | Task 1/2/4/6 | 旧 nullable 路径保留；不要求重跑 Stage 2 完整旧故障矩阵 |
| 验收与发布证据 | Task 6 | 一条小主链 + 直接相关错误/互斥测试；不为了阈值消耗真实 75% 窗口 |

自检修正的具体问题：

1. 将“跨任务”澄清为同会话多轮，避免误做只限一个 AgentTask 的上下文。
2. 经用户确认移除运行中手动压缩，省去请求排队和 compact 中止后的续跑。
3. 不把原 progress 当完整历史；不直接透传原生 entries 给浏览器。
4. 保存从异步 event listener 移到可以 await 的 provider/tool/terminal 边界。
5. 恢复旧历史后只用本轮 assistant 判定结果，防止误报上一轮答案为本轮完成。
6. 自动压缩精确边界按 Pi 1.2.0 的严格 `>` 修正；压缩后 usage 的 null 保持未知。
7. 未配对工具轮只影响有效投影，不产生伪造成功结果，不进入第四阶段自动恢复。
8. 手动压缩与任务准入同 project-row 事务；慢模型 IO 全部锁外，旧回调不能覆盖新历史。
9. 移除预先设计的 checkpoint/向量检索/独立消息表/worker JSONL 权威及完整旧数据迁移；首版恢复全部 entries 的成本保留为可测限制。
10. 用户目标改为准入事务内的原生 custom_message，既参与模型上下文又支持统一 seq 分页，避免启动前失败的输入只有 task.prompt、历史无法完整列出的缺口；不增加第三张表。

自检结论：六个任务足以覆盖已确认范围。必要复杂度集中在持久保存时序、跨轮执行身份和空闲摘要互斥；没有引入新的 Agent 平台。实际实现时若 SDK 合同测试否定某个接缝，先给出该项最小调整及证据，不静默升级 Pi 或扩展产品范围。原最大未验证点（保存屏障/自动压缩SDK时序）已由Task2/3真实锁定SDK scripted-provider测试补证；真实云模型质量、浏览器/重启、运行库迁移及发布仍未验证。
