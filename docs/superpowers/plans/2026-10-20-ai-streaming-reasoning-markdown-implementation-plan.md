# AI 流式展示、推理强度与 Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 当前 Manao 会话可实时显示并回看 DeepSeek 思考与正文，按轮选择真实生效的推理强度，正文以 Markdown 呈现。

**Architecture:** 保留 Pi/工具/任务/会话历史的既有执行链。新增与 ProgressChain 分离的有界快照通道，经内部 POST 和带 Bearer 的 SSE 传输，以已 ACK 历史水位切换草稿和持久化历史。档位绑定任务摘要，使用 Pi 公共方法记录原生历史。

**Tech Stack:** Java17 / Spring Boot3.5.9 MVC / MySQL / Flyway；Node>=22.19.0、Pi 三包1.2.0、TypeScript/Vitest；React19、TanStack Query、pnpm、react-markdown/remark-gfm、Playwright。

**Spec:** [设计](../specs/2026-10-20-ai-streaming-reasoning-markdown-design.md)。执行者先读设计和本计划；本文不授权立刻实施。

## Global Constraints

- 日期2026-10-20，基线 codex/ai-integration@7241c33，目录 D:/DeepLearning/MyProjects/Project_Manao/.worktree/ai-integration。开始前核对 branch、HEAD、git status，保留无关变化。
- 本轮产物是计划；产品实现、服务启动、真实模型、运行库/集群/镜像发布须有对应执行授权。Git push/merge和项目删除不由本计划授权。
- Pi三包保持1.2.0；maxTokens8192、contextWindow1,048,576、75%阈值786432、工具180/build20/任务1800s不变。
- 用户确认保留8192并明确截断；压缩沿用当前/最近一轮档位，不新增独立设置。
- 档位off/low/high/max；新会话默认high，旧任务NULL不能标成实际high。
- frontend使用pnpm，禁止npm。UTF-8无BOM，遵循.gitattributes；改旧文件前重读，Windows失败patch不盲重试。
- 单backend、单worker、单执行槽；不新增服务、中间件、逐token落库或SDK私有API。
- 流式只做展示；原terminal/ledger/锁/ACK屏障保留；浏览器断线不取消任务，不自动重跑。
- MySQL测试使用JdbcStoreTestSupport的disposable schema，禁止reset运行库。
- Stage2 PAUSED/NOT_GRANTED、Stage3用户确认、原75% NOT_RUN保持；不展开Stage4。

## 1. 文件责任与依赖

路径均相对当前工作树。只修改本功能相关段落，不创建空架构文件。表中 B= poc4/backend/src/main/java/com/manao/poc4/ai/，F= poc4/frontend/src/，W= poc4/pi-worker/src/；后文同名文件使用此根。

| 区域 | 文件与责任 |
| --- | --- |
| 唯一迁移 | poc4/backend/src/main/resources/db/migration/V14__agent_reasoning_effort.sql；task新增nullable列 |
| 后端原契约 | B/AgentContracts.java、AgentTaskController.java、AgentTaskService.java、AgentTaskStore.java、AgentConversationController.java、AgentConversationContracts.java、AgentConversationStore.java |
| worker原接缝 | W/pi-session.ts、server.ts、backend-client.ts、conversation-context.ts |
| worker新模块 | W/live-output.ts：快照类型、聚合、节流和有界发送 |
| 后端新模块 | B/AgentLiveOutput.java：DTO/有限缓存/订阅；B/AgentLiveOutputController.java：browser SSE；内部POST加AgentInternalController，装配加config/AiConfig |
| 前端共享显示 | F/features/ai/AssistantMarkdown.tsx、ThinkingBlock.tsx |
| 前端实时模块 | F/features/ai/agentLiveOutput.ts：校验/SSE解析/合并；useAgentLiveOutput.ts：订阅/取消 |
| 前端原接缝 | F/api/httpClient.ts、agentConversationApi.ts；F/contracts/agentTask.ts、agentConversation.ts；F/features/ai/AgentConversationPanel.tsx、AgentTaskPanel.tsx、ConversationHistory.tsx、agentConversationQueries.ts |
| 验收 | poc4/frontend/playwright.ai-output.config.ts、tests/e2e/ai-output.spec.ts；poc4/docs/evidence/ai-output/acceptance.md；发布追加poc4/deploy/ai-context/README.md |

顺序：Task1档位合同 → Task2历史和共享显示 → Task3 worker快照 → Task4 backend SSE → Task5 browser实时 → Task6验证/发布准备。每项有效RED、最小GREEN、独立审查、局部提交；已通过且无新变化的测试不重复运行。

## 2. 公共合同

~~~typescript
export type ReasoningEffort = 'off' | 'low' | 'high' | 'max';
// SubmitTaskRequest/TaskRequest的reasoningEffort可缺省，保留到后端判重。
// 新WorkerStart必须带持久化档位；TaskSnapshot.reasoningEffort可null，指旧记录。
// ConversationView.nextReasoningEffort始终是合法档位。
export type LiveBlock = { contentIndex:number; kind:'thinking'|'text'; text:string };
export type LiveSnapshot = {
  revision:number; taskId:string; conversationId:string; durableHeadSeq:number;
  current:null | { messageOrdinal:number; phase:'generating'|'ended';
    blocks:LiveBlock[]; modelTruncated:boolean; displayTruncated:boolean };
  unavailable:boolean;
};
// HistoryItem追加contentIndex:number、modelTruncated:boolean，kind增加thinking。
~~~

新history字段必须由新服务输出；frontend缺省contentIndex0/modelTruncated false只为升级兼容，不能制造thinking。最终fixture改成真实新形状。SSE只有snapshot事件，data单行JSON，heartbeat注释；不引入event日志/Last-Event-ID。

## Task 1：真实生效、可恢复的推理强度

**Files:** §1迁移/后端原契约；W/pi-session.ts、server.ts；F/contracts两文件、AgentTaskPanel.tsx、AgentConversationPanel.tsx。Tests：原AgentTaskStoreTest、AgentTaskServiceTest、AgentConversationHttpContractTest、worker pi-session.test.ts/server.test.ts、前端Panel测试；新增poc4/pi-worker/test/reasoning-effort.test.ts。

**Interfaces:** Consumes原task UUID、owner/project/revision、摘要和session恢复。Produces档位DTO、V14列、nextReasoningEffort、WorkerStart持久档位、Pi thinking_level_change。

- [x] **Step 1 — RED：** 四档真实SDK请求体、max不能降high、high→off→max历史恢复；用本地fetch捕获真实安装Pi调用，不访问网络。最小传输fixture如下，测试由现有Manao session fixture接入：

~~~typescript
const payloads: Record<string, unknown>[] = [];
const fixtureFetch: typeof fetch = async (_url, init) => {
  payloads.push(JSON.parse(String(init?.body)));
  const chunk = {choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:'stop'}]};
  return new Response('data: '+JSON.stringify(chunk)+'\n\ndata: [DONE]\n\n',
    {headers:{'content-type':'text/event-stream'}});
};
// 发起真实SDK调用后，不直接手造以下请求体来通过测试：
expect(payloads.at(-1)).toMatchObject({stream:true,max_tokens:8192,
  thinking:{type:'enabled'},reasoning_effort:'max'});
~~~

DB测试：同ID同档位幂等，改档位409，旧NULL+缺省旧摘要通过，旧NULL+显式档位拒绝，非法档位拒绝，变化的会话默认不影响缺省请求摘要。UI测试dirty选择不被轮询覆盖、A/B隔离、丢POST响应只GET原ID。

- [x] **Step 2 — 运行RED：** backend cwd：mvn -Dtest=AgentTaskStoreTest,AgentTaskServiceTest,AgentConversationHttpContractTest test；worker cwd：pnpm test -- test/reasoning-effort.test.ts test/pi-session.test.ts test/server.test.ts；frontend cwd：pnpm test -- src/features/ai/AgentTaskPanel.test.tsx src/features/ai/AgentConversationPanel.test.tsx。记录缺行为失败，不把环境/编译问题充作业务RED。
- [x] **Step 3 — 最小实现：**

~~~sql
ALTER TABLE agent_task ADD COLUMN reasoning_effort VARCHAR(8) NULL;
~~~

~~~typescript
// DeepSeek模型定义增加：
thinkingLevelMap: {minimal:null,low:'low',medium:null,high:'high',max:'max'}
// 先正常恢复session；不先在createAgentSession options覆盖为新档位。
session.setThinkingLevel(requestedEffort, {persist:false});
~~~

store先取得已有行再按NULL选择摘要；新行缺省high，摘要末尾加入规范化档位。controller不提前补high；新start从落库值构造。首版所有新任务在服务端非DeepSeek配置时于worker创建session前固定AI_REASONING_UNSUPPORTED拒绝；不增加显式/缺省来源字段，不透传内部配置。UI旧NULL如实未记录；不扩大sessionStorage intent。

- [x] **Step 4 — GREEN：** Step2、worker pnpm build、frontend pnpm typecheck。真实SDK三轮后manual compact恢复max；自动摘要继承当前值、manual/auto max_tokens<=8192；summary length失败不推进成功压缩。最终length保留AI_LENGTH_LIMIT并准确显示。
- [x] **Step 5 — 评审/提交：** 查一列迁移、旧摘要、wire字段和原生历史一致；git diff --check，只stage本任务确切文件。建议提交 feat(ai): persist and apply DeepSeek reasoning effort。

## Task 2：有序思考历史与共享 Markdown

**Files:** B/AgentConversationContracts.java、AgentConversationStore.java；F/contracts/agentConversation.ts、ConversationHistory.tsx、AgentTaskPanel.tsx；新增AssistantMarkdown.tsx、ThinkingBlock.tsx及测试；frontend package.json/pnpm-lock.yaml。补AgentConversationStoreTest、AgentConversationHttpContractTest、contracts/agentConversation.test.ts、ConversationHistory.test.tsx。

**Interfaces:** Consumes原生content数组/stopReason。ProducescontentIndex/modelTruncated，AssistantMarkdown({text})、ThinkingBlock({text,active,incomplete?})；保留history cursor。

- [x] **Step 1 — RED：** fixture [thinking(a),text(b),thinking(c),toolCall(t),text(d)]保留0..4顺序，签名/system/encrypted不出DTO。同offset多block、不同长度跨页、emoji、大代码围栏跨页重组正确，模型中间/最终length均有标记。具体渲染断言：

~~~tsx
render(<AssistantMarkdown text={'# 完成\n\n- 已验证\n\n~~~java\nclass A {}\n~~~'} />);
expect(screen.getByRole('heading',{name:'完成'})).toBeVisible();
expect(screen.getByRole('list')).toBeVisible();
expect(screen.getByText('class A {}')).toBeVisible();
~~~

补script/raw HTML、危险URL不能执行；thinking折叠不删除内容；工具文件结果仍按原文本展示。

- [x] **Step 2 — 运行RED：** backend mvn -Dtest=AgentConversationStoreTest,AgentConversationHttpContractTest test；frontend pnpm test -- src/contracts/agentConversation.test.ts src/features/ai/ConversationHistory.test.tsx src/features/ai/AssistantMarkdown.test.tsx src/features/ai/ThinkingBlock.test.tsx。
- [x] **Step 3 — 实现：** frontend pnpm add react-markdown remark-gfm；不加高亮/Mermaid/编辑器。

~~~tsx
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
export function AssistantMarkdown({text}:{text:string}) {
  return <div className="ai-markdown min-w-0 break-words">
    <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
  </div>;
}
~~~

补限定ai-markdown内的段落/列表/代码/表格样式，不改全站pre。Java逐content block投影；fragments传contentIndex；frontend合并键加该索引，按seq/contentIndex排序。继续同offset分组分页及512KiB验证。redacted只固定占位。正文拼接后交Markdown，用户/工具继续原样。

- [x] **Step 4 — GREEN/视觉：** Step2、typecheck；本地fixture检查窄/宽屏、代码/表格滚动、未闭合围栏、思考开关及分页。无需真实模型/集群；不能只查Markdown源字符串存在。
- [x] **Step 5 — 评审/提交：** 不加历史表/cursor，不混淆模型length与展示裁切。建议 feat(ai): render ordered thinking history and Markdown answers。

## Task 3：worker有界快照与ACK水位

**Files:** W/live-output.ts、poc4/pi-worker/test/live-output.test.ts；修改W/pi-session.ts、backend-client.ts、conversation-context.ts、server.ts；补test/pi-session-context.test.ts。

**Interfaces:** Consumes AgentSessionEvent、原message引用、已ACK原始entry切片/headSeq。Produces LiveSnapshot、BackendClient.liveOutput(taskId,snapshot):Promise<void>（2秒超时）；LiveOutput.observe(event)、checkpoint(acknowledgedEntries,headSeq)、dispose()。entry沿用Pi类型，headSeq不是timestamp。

- [x] **Step 1 — RED：** 真实Pi scripted provider发thinking/text/工具续轮；message_end不能清草稿，ACK涵盖原message后才清并推进C；flush失败合成新错误消息不覆盖旧草稿。慢/失败POST不阻塞工具/terminal；队列最多inflight+latest、revision允许跳号。关键观察断言：

~~~typescript
expect(sentBeforeAck.current?.phase).toBe('ended');
expect(sentBeforeAck.durableHeadSeq).toBe(originalHead);
expect(sentAfterAck.current).toBeNull();
expect(sentAfterAck.durableHeadSeq).toBe(acknowledgedHead);
expect(terminalWasDeliveredWhileLivePostStalled).toBe(true);
~~~

由fixture真实事件/ACK生成上述观察值，不能模拟写入预期结果。补JSON转义后256KiB、emoji、长thinking不挤正文、两种截断标记、无delta2秒重发。

- [x] **Step 2 — 运行RED：** worker pnpm test -- test/live-output.test.ts test/pi-session-context.test.ts test/pi-session.test.ts。
- [x] **Step 3 — 实现：** 仅conversation任务启用；observe同步提取，不在subscribe异步保存。记录message_end原引用；flush追加可选onAcknowledged(acknowledgedEntries,headSeq)，仅ACK比对成功后传递这一批已确认的原始entry切片，不能传POST的structuredClone或整个尚未确认entries。通知只更新内存，不反向破坏成功ACK。

~~~typescript
// 原flush的ACK检查后，先保留旧head以截取原引用：
const acknowledgedEntries = entries.slice(this.headSeq, expected);
this.headSeq = expected;
onAcknowledged?.(acknowledgedEntries, this.headSeq);
// checkpoint确认这批entries中message===pendingCompletedMessage，
// 才清current；不读取/制造Pi私有entry ID。
~~~

BackendClient复用headers发白名单JSON，250ms合并、2秒脉冲/请求超时；失败不进ProgressChain，不await drain。blocks/phase/C/current/unavailable/截断任一可见变化递增revision；latest/inflight不可变，脉冲复发同revision同payload，测试覆盖ended/ACK/重复脉冲，不能因共享可变block导致409。dispose清timer/取消遗留请求；结束best-effort最新发布但不增加终态阻塞。原本context保存失败仍按既有规则失败，不能因直播容错吞掉它。

- [x] **Step 4 — GREEN：** Step2、pnpm build；复验原上下文停止、压缩重试、stop/abort、终态顺序。检查无每token文件/DB写、无unbounded Promise链。
- [x] **Step 5 — 评审/提交：** 关注event→append→ACK与timer清理。建议 feat(ai): publish bounded live reasoning and answer snapshots。

## Task 4：后端鉴权SSE与有限缓存

**Files:** 新增B/AgentLiveOutput.java、AgentLiveOutputController.java；新增poc4/backend/src/test/java/com/manao/poc4/ai/AgentLiveOutputTest.java、AgentLiveOutputHttpTest.java；修改AgentTaskStore.java、AgentInternalController.java、config/AiConfig.java。SecurityConfig仅在实际async测试需要时调整；InternalBodyLimitFilter现有512KiB足够，不扩大。

**Interfaces:** Consumes§2 snapshot及已持久化的worker identity/owner查询。Produces内部POST204/409/413、browser SSE snapshot/heartbeat或终态无实时内容204；AgentLiveOutput.accept(taskId,snapshot)、subscribe(taskId):SseEmitter只在只读验证后调用。AgentTaskStore新增只读requireBoundWorkerIdentity(taskId,epoch,instanceId)，拒绝未绑定/不匹配，不调用有绑定副作用的requireWorkerIdentity；缓存不充当鉴权源。

- [x] **Step 1 — RED：** 无token、browser token访问internal、跨owner/project/task/conversation、旧instance/epoch拒绝；未绑定首帧409且任务仍QUEUED，原start绑定后脉冲可恢复。旧revision不回退、同revision异内容409、最终JSON256KiB边界。最多2份缓存，每task2个/全局4订阅，超限429；任意旧task不能凭空heartbeat占连接，尾部TTL不随脉冲延长。真实随机端口HTTP读首个frame，证明不用等待连接结束：

~~~java
var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofInputStream());
assertThat(response.statusCode()).isEqualTo(200);
assertThat(response.headers().firstValue("content-type").orElse("")).contains("text/event-stream");
// 带截止时间的future读取到空行结束的首frame；不要readAllBytes等待流结束。
~~~

慢读取/断开测试要求内部POST仍及时返回、缓存和发送队列不随帧数增长、回收后发送资源可复用；只mock emitter不足以证明Servlet行为。

- [x] **Step 2 — 运行RED：** backend mvn -Dtest=AgentLiveOutputTest,AgentLiveOutputHttpTest,AgentInternalSecurityTest test。
- [x] **Step 3 — 实现：** Spring MVC SSE、Cache-Control:no-store、15秒注释、30分钟订阅生命周期。全局4个sender线程，无无限队列；每订阅一份inflight和latest，heartbeat也走同槽。内部POST只校验/替换/调度。2秒watchdog仅标detached/清latest，不能同步complete（Spring send/complete共用writeLock）；实际sender退出后再complete并归还额度，不假回收/补线程。额度耗尽503，frontend退history/轮询。常量集中AgentLiveOutput中。

~~~java
emitter.send(SseEmitter.event().name("snapshot").data(snapshot));
emitter.send(SseEmitter.event().comment("heartbeat"));
// 回调做幂等逻辑detach；实际发送资源只在sender退出后归还。
~~~

2秒/30分钟都不承诺强制中断同步socket写。真实Servlet测试必须证明慢读→客户端关闭→sender退出→新订阅恢复；还未退出时保留实际额度，饱和503而不是阻塞任务。无需新增Servlet非阻塞栈。SSE不改变task状态；仅当前任务空缓存可heartbeat等worker脉冲，旧task不能占位。无conversation旧task route明确不支持，原查询可用。nginx已关闭buffering，验证无缺口则不改。

- [x] **Step 4 — GREEN：** Step2；中途断开、第3连接拒绝、空缓存heartbeat、清空缓存后下一脉冲恢复。验证Spring async错误分派不制造401，终态后缓存TTL清理，后端无原始thinking日志。
- [x] **Step 5 — 评审/提交：** owner隔离、有限内存/线程、POST/terminal不受慢客户端拖累。建议 feat(ai): serve authenticated live output snapshots over SSE。

## Task 5：浏览器实时、重连与历史切换

**Files:** 新增F/features/ai/agentLiveOutput.ts、useAgentLiveOutput.ts及test；修改api/httpClient.ts、agentConversationApi.ts、features/ai/agentConversationQueries.ts、AgentConversationPanel.tsx、ConversationHistory.tsx；补HttpClient/Panel/History测试和现有MSW fixtures。

**Interfaces:** Consumes§2/SSE/TaskSnapshot与history旧cursor。ProducesHttpClient.requestStream(url,{signal}):Promise<Response>、parseLiveSnapshot(unknown):LiveSnapshot、useAgentLiveOutput({userId,projectId,conversationId,taskId})返回latest/connectionState/retry。历史切换由ConversationHistory组合层管理，hook不触发模型/任务。

- [x] **Step 1 — RED：** 字节跨chunk UTF-8、SSE多行data/CRLF/注释/多帧、未知事件忽略；JSON data最多256KiB，单frame/未完成解析buffer最多260KiB，非法frame提示并退history。正好256KiB合法JSON加SSE开销必须通过。有效fixture在中文UTF-8字节中间切开，最终恰好一份：

~~~typescript
expect(decodedSnapshots).toEqual([snapshot]);
expect(decodedSnapshots[0].current?.blocks[0].text).toBe('思考中文🙂');
~~~

测试C推进而history未返回保留旧组合、新history到达原子切换、旧promise不能覆盖新pendingLatest、跳revision/丢terminal帧、A/B切换/logout、刷新订阅不重跑任务。不得只用JSON字符串存在代替可见DOM。

- [x] **Step 2 — 运行RED：** frontend pnpm test -- src/features/ai/agentLiveOutput.test.ts src/features/ai/useAgentLiveOutput.test.tsx src/features/ai/AgentConversationPanel.test.tsx src/features/ai/ConversationHistory.test.tsx src/api/httpClient.test.ts。
- [x] **Step 3 — 实现：** requestStream复用private send的Bearer/401/relative URL约束，设置Accept:text/event-stream返回Response。TextDecoder以stream:true解码，保留残行直到SSE空行，frame完成才JSON.parse/校验。

~~~typescript
const response = await getHttpClient().requestStream(url, {signal});
const reader = response.body!.getReader();
const decoder = new TextDecoder();
// decoder.decode(chunk,{stream:true})；finally cancel/release reader。
// Abort只关展示，绝不调用closeAgentTask。
~~~

history首次在C上界请求beforeSeq=C+1，其后沿原cursor；query key含user/project/conversation/C。无快照显示已有history+同步中；C变化先取新history再切换，只留visible组合与pendingLatest，不能因2秒detail更新产生重影。最后ACK快照丢失时，终态history需分页覆盖草稿C边界，按同task首个assistant消息组且块索引/类型/文本（裁切时前缀）一致关联，明确对应才替换；不完整保持同步中，不对应保留“实时预览未确认保存”。测试禁止只凭head增长清草稿。重连1/2/5秒封顶，429不忙循环重试、204转history、401走原退出登录流程。

ThinkingBlock与AssistantMarkdown按contentIndex显示；活动时展开、完成后折叠但尊重用户选择。草稿提升到对应history时迁移本条折叠状态，测试delta→ended→history后用户选择仍保留，不建永久映射。沿用工具history renderer，长thinking不挤正文，模型length和临时展示裁切分别提示。用户向上滚动不强制跳回底部。

- [x] **Step 4 — GREEN/本地浏览器：** Step2、pnpm typecheck、pnpm build；真实HTTP SSE fixture观察生成中DOM、thinking开关、代码/表格、断开重连及切换，旧task-only正常Markdown，写锁/close不变。
- [x] **Step 5 — 评审/提交：** 无重复模型发起、串会话、重影、dirty档位覆盖。建议 feat(ai): display live thinking and Markdown with history reconciliation。

## Task 6：集中验证、证据与发布准备

**Files:** 新增frontend/playwright.ai-output.config.ts、tests/e2e/ai-output.spec.ts；package.json增加test:e2e:ai-output；新增poc4/docs/evidence/ai-output/acceptance.md；发布追加poc4/deploy/ai-context/README.md；更新AGENTS.md和docs/what-we-have-done.md真实状态。

**Interfaces:** ConsumesTasks1–5；Produces本地证据、明确NOT_RUN外部项、可另获授权执行的集中验收。不要另建第二份release README或通用operator平台。

- [x] **Step 1 — 集成断言：** 同会话high→off→low→max，至少一次read_file；刷新/断网后思考与正文历史一致，四档task记录与白名单wire一致。local fixture强制多个thinking/text chunk与length；云端不烧满8192或75%窗口来证明边界。
- [x] **Step 2 — 最终本地组合：**

~~~powershell
# cwd poc4/backend，disposable测试schema
mvn -Dtest=AgentTaskStoreTest,AgentTaskServiceTest,AgentConversationStoreTest,AgentConversationHttpContractTest,AgentConversationCompactionTest,AgentInternalSecurityTest,AgentLiveOutputTest,AgentLiveOutputHttpTest test
# cwd poc4/pi-worker
pnpm test
pnpm build
# cwd poc4/frontend
pnpm test -- src/features/ai src/contracts/agentConversation.test.ts src/api/httpClient.test.ts src/api/agentConversationApi.test.ts src/components/shell/WorkbenchShell.test.tsx
pnpm typecheck
pnpm build
~~~

记录真实失败/跳过/修复后通过，不复制旧数量。通过且无新改动后不为凑证据重跑全项目。

- [x] **Step 3 — 真实入口与发布准备：** config无webServer、retries0、workers1。缺MANAO_AI_ACCEPTANCE_BASE_URL/PROJECT_ID/USERNAME/PASSWORD或本轮MANAO_AI_OUTPUT_MODEL_AUTHORIZED=true时浏览器启动前报NOT_RUN。不要求worker重启许可，因为本场景不重启资源。复用原登录，刷新后重新登录，不假设JWT持久化。

~~~json
"test:e2e:ai-output": "playwright test --config playwright.ai-output.config.ts"
~~~

发布步骤：空闲/短维护检查→备份及disposable迁移验证→构建三镜像记录digest→按既有Recreate部署→健康检查→集中真实入口。V14为additive，回滚镜像保留该列，不drop或reset历史；验证旧代码忽略新列。真实验收无需改用户代码、启应用或删项目。

- [x] **Step 4 — 真实验收（另获授权后）：** pnpm test:e2e:ai-output；四个短只读任务，记录首thinking/text可见时间与结束时间，验证首段先于message_end、Markdown DOM、思考折叠/回看、档位、工具循环、重连。输出过短无法观察中途多帧就诚实记未覆盖；最高档length如实FAILED/AI_LENGTH_LIMIT。mock/--list/打字动画均不是流式PASS。白名单记录effort/stream/max_tokens，不记录key/prompt/thinking到公共日志。**执行状态：本轮另获授权并实际执行，勾选不代表全通过；round1/round2 FAILED 保留，high/off 检查点和单次 max 补验通过，low 流式时序 UNVERIFIED。四档真实参数/持久化均已核实。**
- [x] **Step 5 — 收尾：** 更新唯一acceptance、索引、本计划勾选；清本轮无用临时文件、保留最小失败证据。建议提交 test(ai): verify streaming effort and Markdown delivery，不push/merge。

## 3. 完成标准与需求覆盖

| 用户结果 | 任务 | 必须证据 |
| --- | --- | --- |
| 思考/正文实时 | 3/4/5/6 | SDK增量、真实HTTP中途帧、browser完成前可见 |
| 思考折叠/历史 | 2/5 | 原生投影、刷新/分页一致、签名不出DTO |
| 真实推理强度 | 1/6 | 四档wire、max不降档、task记录和摘要 |
| Markdown | 2/5 | heading/list/table/code DOM与视觉检查 |
| 8192与截断 | 1/2/3 | 不提高max_tokens，length与展示裁切分离 |
| 压缩继承档位 | 1 | 真实SDK多轮变更及manual/auto恢复 |
| 保持执行权威 | 3/4/5 | 慢客户端/丢帧不改变task/ledger/锁 |

## 4. 自检与过度工程审查

作者自检检查需求覆盖、字段/方法名一致、文件真实存在或明确新增、测试针对用户可观察行为；工程默认值集中在设计。

已删除：token日志、跨进程重放、永久message映射表、会话settings表、digest_version、独立压缩策略、多provider平台、高亮/编辑器、重跑Stage2或75%大窗口验收。

保留：档位摘要确保同请求不变意图；contentIndex防错拼；ACK水位防草稿/历史重影；有界发送防慢客户端拖Agent。新增服务、持久化流事件或修改任务生命周期必须先说明当前最小方案为何不能满足此需求。

2026-10-20完成stream、档位/历史两项定向只读审查及一次独立整体审查，作者另做覆盖、一致性和YAGNI自检。已采纳以下最小修订：
- 一列迁移、新旧摘要分流、公开setter记录档位历史；无settings表或独立压缩适配。
- ACK传原始已确认entry切片，直播仅只读校验worker身份，不推动QUEUED→RUNNING。
- 终态丢最后帧时保守关联原history，未确认草稿不静默清除。
- JSON256KiB/frame260KiB分离，active/tail范围、4订阅/4 sender及不可变revision明确。
- watchdog不在阻塞send期间同步complete；sender实际退出才还额度，饱和503退history，不承诺强行中断socket。
- 用户折叠状态跨实时/历史保留；非DeepSeek首版新任务统一拒绝，避免增加来源字段。

2026-10-20最终执行状态：六个任务本地完成并获独立 Approved；用户随后授权发布和真实验收。三镜像 `a7d0041` 已部署，V14 一次、备份恢复/旧 artifact 兼容及旧数据核对通过。Task6 Step4 已执行但未全通过：round1/round2 FAILED，high/off 检查点及单次 max 通过，low 流式时序 UNVERIFIED；四档真实 wire/任务记录均已核实。临时探针与恢复 schema 已撤除。实际状态由 poc4/docs/evidence/ai-output/acceptance.md 拥有；不授予完整真实 E2E 或用户验收 PASS，Stage2 仍 PAUSED/NOT_GRANTED。

## Execution record (2026-10-20)

The following Task1–5 entries are dated intermediate checkpoints; their then-pending task notes are historical. The final status above and the final Task6 closeout below own completion.

Task1 completed locally: 1d09f04 + ea32755; independent specification/quality review and scoped I1 rereview cleared. Backend78/78, worker79/79, frontend71/71, worker build/frontend typecheck passed. Core behavioral RED preceded implementation; supplementary legacy/HTTP assertions were characterization after core changes. No real cloud model/deployment accepted. Tasks2-6 pending.

Task2 completed locally: d3ea5c7; independent spec compliant / quality Approved, no Critical/Important. Backend24/24, frontend98/98, typecheck, real local Chromium360/1280 visual checks passed. Local fixtures are not real model acceptance. Tasks3-6 pending.

Task3 completed locally: 356e492 + 8a1f182. Independent spec/quality Approved after passive-clipping prefix fix. Scoped40/40+build, fix10/10+build; original ACK entries and nonblocking terminal verified with locked SDK scripted events, no cloud call. Tasks4-6 pending.

Task4 completed locally: fca63d2; independent spec compliant/quality Approved. Required16/16 plus package; real Servlet first-frame and blocked4→RST→actual0→GET200 evidence. Minor isolated per-task3rd and cache-loss pulse assertions deferred; no30minute endurance/process restart evidence. Tasks5-6 pending.

Task5 completed locally: b9853f4 + b51c91e + adb63f6. Independent spec/quality gate passed after active fallback and pendingLatest race repairs. Initial108/108, fix114/114, finalcover70/70; typecheck/buildpass, realHTTP Chromium fixture passed. FullPanel lock/close remains component evidence; fixture proves SSE/history/render/reconnect. Task6 local verification/release preparation next; paidmodel/deploy forbidden.

Task6 completed within local authorization: `3a2b194` prepared the guarded real entry, evidence and existing release-guide appendix. Required combination backend127/127, worker147/147 and frontend282/282 passed. Final scoped fix `c68c773` corrected late normal ACK, per-message acceptance timing/DOM oracles and malformed worker effort types; fresh frontend71/71, worker47/47 and harness6/6 plus builds/typecheck passed. Independent final rereview confirms all findings addressed and local completion Approved. The final harness-specific tsc raw log was not retained; its reported exit0 is distinguished from independently inspected raw evidence. Step4 remains unchecked / NOT_RUN. No paid model, runtime migration/reset, images, deployment, resource deletion, push or merge occurred.

Authorized release checkpoint supersedes that local-only snapshot: source `a7d0041` three images built/pushed/deployed, V14 migrated once, backup/disposable/actual old-artifact checks passed; all four real efforts completed in one retained conversation with provider whitelist unchanged8192/max. Harness-only `310fa9a` received independent review and9/9 local observer tests. Real round2 failed at low composite timing oracle; exact cause unknown because original attachment metadata was not retained. One max-only continuation passed with direct sanitized metadata and own-message timing. Prior failures remain, no paid repeat to force a green matrix; no combined E2E PASS. Probe/sample removed, final single worker Ready, no Git push/merge or existing project deletion.
