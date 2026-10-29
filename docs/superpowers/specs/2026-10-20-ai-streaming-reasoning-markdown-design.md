# AI 流式展示、DeepSeek 推理强度与 Markdown 设计

日期：2026-10-20。状态：实现计划配套设计，尚未实施或部署。基线：`codex/ai-integration@7241c33`，工作树 `.worktree/ai-integration`。本轮授权为调查、设计、计划和审查；不包含产品实现、真实模型调用、集群发布或 Git push/merge。

## 1. 从用户结果推导最小范围

用户要在当前编程会话中看到模型正在输出的内容、控制这一轮推理强度，并读到格式清楚的回答。因此需要三个能力：
1. 同一会话实时展示 DeepSeek 返回的思考文本及正文，思考可折叠，工具轮次顺序可辨。
2. 每轮发送前选择 `off/low/high/max`；选择真实进入模型请求，并能从任务记录核对。
3. 正文按 Markdown 渲染；生成结束、刷新和历史回看呈现一致。

模型调用、项目写锁、工具 ledger、任务终态、会话原生历史已经存在。新增的是展示和配置，不是第二套 Agent 执行系统。流式展示失败不能启动、停止、重跑或宣告任务成功。

用户在本轮明确确认：
- 展示 API 实际返回的思考文本，不声称它是模型全部内部计算过程；思考实时可见、可折叠，已保存回复可回看。
- 保留每次模型响应 `maxTokens=8192`，明确提示截断，通过实测再决定是否调整。
- 自动/手动压缩沿用当前/最近一轮档位，不增加独立压缩设置。

实施默认值：新会话默认 high；已有会话下一轮默认最近任务的已记录档位。生成时思考展开、完成后默认折叠，用户主动开关优先。思考保留换行按文本显示，正文用 Markdown。流式半条消息不承诺在 worker 崩溃后恢复。

## 2. 当前事实与不变边界

- 三个 Pi 包锁定1.2.0；模型定义 reasoning:true、1,048,576 tokens窗口、8192输出上限。SDK已使用stream:true；Manao目前仅处理message_end。
- ProgressChain是任务进度/终态链，100项、每项8KiB，不能当token流存储。
- 原生 agent_conversation_entry.payload_json 已保存thinking/text/toolCall等；浏览器目前只投影text。思考历史展示无需迁移原数据。
- Pi先通知message_end，后append原生message；现有ConversationContext.flush在请求/工具前及final等待ACK，继续保留该屏障。
- backend/worker单副本、worker一个执行槽；nginx已有proxy_buffering off。
- Stage2保持PAUSED/NOT_GRANTED；Stage3是用户确认使命完成；不启动Stage4。原上下文75%真实触发仍NOT_RUN。

不新增：消息中间件、逐token表、分布式replay、SDK fork/升级、多模型路由平台、完整请求intent重放系统、思考摘要生成器、动态token预算、Markdown编辑器、Mermaid/数学公式/代码执行。工具输出/文件继续按原组件显示。

## 3. 方案取舍

| 方案 | 判断 |
| --- | --- |
| 提高轮询频率、旧progress写delta | 不选；挤占100项队列、增加DB更新并拖延终态 |
| 有界当前消息快照 + 内部POST + 浏览器SSE | 采用；满足实时可见并复用已有历史和鉴权 |
| 持久化每个delta + 双向WS/消息中间件 | 不选；本轮不要求跨进程逐事件恢复 |

Pi仍逐段接收模型数据；worker合并为当前消息最新快照，每250ms最多发布一次。浏览器用fetch读取SSE并复用Bearer/401处理。250ms为工程默认值，不是网络性能承诺。

## 4. 推理强度契约

公开枚举 `reasoningEffort: 'off' | 'low' | 'high' | 'max'`，对应UI关闭/低/高/最高。off发送thinking.disabled；其它发送thinking.enabled及同名reasoning_effort。

DeepSeek自定义模型增加 `thinkingLevelMap:{minimal:null,low:'low',medium:null,high:'high',max:'max'}`；保持8192、现有contextWindow、鉴权与工具。当前省略map时max被SDK降为high，本地探针已证实，必须验证最终请求体。首版限定当前DeepSeek组合；所有新任务若服务端配置为非DeepSeek，在worker创建session前固定AI_REASONING_UNSUPPORTED拒绝。WorkerStart已归一档位，不再区分原请求显式/缺省，不另加来源字段或capability服务。

### 4.1 任务记录与幂等

仅新增V14__agent_reasoning_effort.sql：agent_task.reasoning_effort VARCHAR(8) NULL。NULL专指旧记录，不能回填假定档位；新任务必存合法值。执行前确认编号未被新提交占用。

- 两条提交API、TaskRequest/TaskSnapshot/WorkerStart、frontend types及worker start贯通档位。controller保留缺省信息到store判重；非法字符串拒绝。
- 新任务省略字段固定归一high；新摘要在原固定字段末尾加入规范化reasoningEffort；同ID改档位409 AI_TASK_MISMATCH。
- 已有NULL行：只接受未带档位且匹配旧摘要的旧请求，显式档位不得用旧摘要通过。已有非NULL行使用新算法；不用digest_version列。
- driveStart从持久化记录取档位，不取重试请求或变化后的会话默认。
- ConversationView追加nextReasoningEffort，由最近task档位派生，NULL/无task回退high；TaskSnapshot旧记录仍返回null。无需会话设置表。
- UI仅初始化/切换会话时填默认，轮询不覆盖未提交选择；提交快照档位并在准入未定时禁改。丢POST响应继续GET原taskId，不新增完整intent持久化。

### 4.2 Pi恢复与压缩

先按既有方式createAgentSession恢复历史，不提前在options覆盖本轮档位；再于任何prompt/flush/provider前调用公开 `session.setThinkingLevel(effort,{persist:false})`。该方法在变化时追加thinking_level_change；只在创建参数覆盖会遗漏变更历史。persist:false只关闭全局settings写入，session entry仍保留。

自动压缩继承本轮；空闲手动压缩恢复最近持久化档位，无独立覆盖器。普通与summary均受8192上限约束；summary length保持失败，不能记录成功压缩。最终回答length沿用FAILED/AI_LENGTH_LIMIT，并显示“模型响应达到输出上限，本条内容可能不完整”。

## 5. 实时展示通道

### 5.1 唯一快照形状

```typescript
type LiveBlock = { contentIndex: number; kind: 'thinking' | 'text'; text: string };
type LiveSnapshot = {
  revision: number; taskId: string; conversationId: string; durableHeadSeq: number;
  current: null | {
    messageOrdinal: number; phase: 'generating' | 'ended'; blocks: LiveBlock[];
    modelTruncated: boolean; displayTruncated: boolean;
  };
  unavailable: boolean;
};
```

- 内部POST /internal/ai/tasks/{taskId}/live-output，复用worker token头，但以只读查询核对已绑定instance、epoch及task/conversation关联；不得调用会把QUEUED改为RUNNING的requireWorkerIdentity。绑定尚未完成的首帧409丢弃，后续2秒脉冲恢复，展示不负责绑定。204仅是展示接收；相同revision同内容幂等、异内容409、旧revision忽略，允许跳号。空缓存也先查数据库身份再接收；缓存不是鉴权源。
- 浏览器GET /api/v1/projects/{projectId}/agent-tasks/{taskId}/live-output，owner/project/task鉴权，text/event-stream；事件仅snapshot，15秒comment heartbeat。无缓存时显示同步中，不影响读历史。
- 实时保证针对默认conversation路径。旧task-only API/progress继续兼容且正文共享Markdown；旧任务未存thinking不可补造，不另建遗留实时协议/存储。
- 该通道不承担terminal、工具结果、占用解除或执行重试。任一可见状态改变（blocks/phase/C/current/unavailable/截断）revision递增；latest/inflight均为不可变快照，2秒脉冲复发同revision同payload，不能共享仍在修改的blocks数组。

### 5.2 与持久化历史的切换

durableHeadSeq=C为ACK成功的历史切割点；current至多一条，位于C之后。revision是快照版本，不是DB seq。

1. message_start建草稿；update提取text_delta/thinking_delta按contentIndex归并，不发送raw partial/签名/system。
2. message_end仅标ended/modelTruncated并记录message引用，不能认定已保存。
3. flush ACK后，通知聚合器此次已确认的原始entry切片及对应headSeq；不是用于POST的structuredClone，也不是尚未全ACK的整个entries数组。确认该message引用在已确认切片后再清current推进C。锁定SDK的append保留message引用行为需合同测试，不调用私有方法。
4. 前端显示“history seq<=C + current”。使用现有beforeSeq=C+1固定历史上界；推进C/换messageOrdinal时先取得新历史，再原子替换。等待时保留旧组合和一个pendingLatest。
5. detail轮询不得绕过切割点叠加新历史/旧草稿；继续按需分页，不建立全历史镜像。
6. POST丢失/跳号：新快照自包含，跳过的已完成消息从历史恢复，不需要delta日志或永久映射。
7. 终态轮询兜底不能无条件清草稿。固定该草稿的C，在最终history中分页覆盖到C后，按同task的首个assistant原生消息组关联；必须核对可见块索引/类型/已显示文本与该组对应（裁切文本只作前缀比较）。对应明确则用history替换；读到完整边界仍无对应内容，保留并标“实时预览未确认保存”；历史不完整则继续显示同步中。正常ACK切换无需此补救，不新增永久ID映射。
8. flush失败后SDK可能直接生成合成message_start；若旧草稿未ACK，不覆盖它，设unavailable并按任务终态/历史对账，不新增多草稿队列。

### 5.3 有界发送和恢复

- worker只有一份原message引用、一个inflight和一个latest；250ms合并、请求超时2秒，失败丢旧快照。每2秒重发最新revision，含长工具阶段；重复revision不重复渲染。结束时发布非阻塞最后快照，不能拖住terminal。
- 单快照最终JSON UTF-8最多256KiB；JSON转义后校验、完整Unicode code point裁剪；thinking/text分别有预算，text至少32KiB。前端JSON data也是256KiB，SSE单frame/未完成解析缓冲上限260KiB，留4KiB协议开销；超大无意义注释同样拒绝。仅临时展示截短，displayTruncated提示完成后看历史；不得裁剪native context。
- backend内存最多当前活跃任务+最近完成任务2份，尾部60秒从任务终态时间计算，不由脉冲延长。仅这两类任务可订阅，每task最多2个、全局4个；第3/全局超限429。其它终态task返回204，frontend转history。淘汰缓存同时逻辑取消所属订阅，迟到旧task不能挤掉活跃task。UI明确提示并继续history/轮询。
- SSE使用全局4个sender线程、无无限等待队列；每订阅单inflight+latest，heartbeat与snapshot共用串行槽。2秒watchdog只标记detached并清latest，不在watchdog同步emitter.complete：Spring send/complete共用writeLock，会连带阻塞。实际sender返回后再complete并归还额度；未实际退出不能假回收或补新线程。额度耗尽时新连接503并退history/轮询，内部POST和任务执行仍可继续。30分钟是订阅生命周期，不保证底层同步写在该刻被中断。真实Servlet最低验收为慢读→客户端关闭→sender实际退出→后续订阅恢复，不能用回调/mock代替资源释放证据；不为强制中断另建传输栈。
- 前端重连退避1/2/5秒封顶；logout/切会话/切项目/终态对账后Abort订阅，不close任务；旧scope迟到帧丢弃。
- backend重启靠worker脉冲重建缓存；worker重启不保证半条消息，已ACK历史可见，任务状态由原逻辑决定；断流不得重跑模型或工具。

## 6. 历史与渲染

HistoryItem增加contentIndex:number、modelTruncated:boolean，kind增加thinking。assistant按原content数组逐块投影thinking/text/toolCall；其它条目用contentIndex0。redacted/encrypted块不作为可读思考输出，只显示固定“该段推理未提供可展示文本”；签名不出DTO。

保持beforeSeq/beforeOffset：同seq同textOffset所有block继续为一组。fragments复制contentIndex，frontend合并键包含该值，显示按seq/contentIndex排序。保留512KiB响应/64KiB片段上限，validateBrowsable与读取同规则。modelTruncated来自stopReason=length；不得与displayTruncated或旧8KiB progress.truncated混用。

共享AssistantMarkdown（react-markdown+remark-gfm）用于实时/历史assistant正文及旧task摘要；ThinkingBlock独立折叠文本。支持标题、列表、引用、链接、表格、行内代码和代码围栏。保留默认安全URL，raw HTML按文本处理，不启用rehype-raw/dangerouslySetInnerHTML，首版不加高亮依赖。代码/表格可横向滚动。

同block累积/历史片段拼接后再渲染，不能每delta单独解析；缺前缀保留现有“还有更早内容”。用户向上阅读不被强制滚到底部，原本接近底部才跟随。工具结果/文件/日志保持原文本组件。

## 7. 验收与交付

本地：真实Pi+受控fetch验证四档wire payload/工具续轮/压缩；disposable MySQL验证迁移/摘要/历史；真实HTTP/SSE与浏览器fixture验证断帧、重连、历史切换及慢客户端。mock不是DeepSeek实测。

另获准后集中云端验收一次：现有专用项目、新会话，实际DeepSeek按high/off/low/max四个短只读任务，至少一次read_file并生成标题/代码块/表格。记录思考/正文在message_end前出现、档位、刷新重连、历史一致、工具循环。无需改用户代码/启动应用/删项目/烧75%窗口；输出过短无法证明多帧则诚实记未覆盖。白名单记录effort/stream/max_tokens，不把key、prompt、thinking写进公开日志。

三个镜像按既有发布方式部署；新迁移先在disposable schema验证。计划阶段不执行。8192最高档耗时/截断只作样本，不作一般性能承诺。

## 8. 第一性原理及过度工程自检

| 保留的复杂度 | 直接目的 | 删除的扩展 |
| --- | --- | --- |
| 一列任务档位+摘要 | 可核对参数、同ID不变意图 | 设置表、digest_version、多模型平台 |
| 单草稿+持久化切割点 | 实时可见且历史不重影 | token日志、永久映射、分布式replay |
| block身份+原分页 | 思考/正文顺序与长消息正确 | 新历史库、新游标协议 |
| 有界发送/连接回收 | 慢浏览器不拖Agent | HA、消息总线、大规模压测 |
| 定向本地测试+一次真实主链 | 验证请求/时序/显示 | 重跑Stage2、完整故障矩阵 |

## 9. 依据

- [实施计划](../plans/2026-10-20-ai-streaming-reasoning-markdown-implementation-plan.md)。
- [既有上下文设计](2026-10-19-ai-conversation-context-design.md)：本切片实施后仅覆盖thinking不展示约定，原存储/压缩/占用保留。
- [上下文验收](../../../poc4/docs/evidence/ai-context/acceptance.md)、[Stage3确认](../../../poc4/docs/evidence/ai-stage3/acceptance.md)。
- DeepSeek：`https://api-docs.deepseek.com/guides/thinking_mode/`，2026-10-19本会话Context7/Firecrawl核对。
- Pi：`https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/README.md`；实现以本地锁定1.2.0源码/合同测试为准。
- Spring SSE：`https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-async.html`，2026-10-20 Context7核对heartbeat/async/连接失败。
- Markdown：`https://github.com/remarkjs/react-markdown/blob/main/readme.md`，2026-10-19 Context7核对GFM/安全URL/HTML行为。

2026-10-20 execution note: the opening status records the confirmed design's original planning authorization. Subsequent explicit user instructions authorized implementation/local commits and then cluster publication/real acceptance. The confirmed contract is retained; [output acceptance](../../../poc4/docs/evidence/ai-output/acceptance.md) owns local Approved at `c68c773`, three `a7d0041` images deployed, V14 once and four actual provider efforts verified. High/off checkpoints and max continuation passed, but combined round2 FAILED / low streaming timing UNVERIFIED; no whole real-E2E or user-acceptance PASS. Temporary instrumentation and disposable restore removed.
