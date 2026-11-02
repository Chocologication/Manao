# AI 图片输入与 24 小时清理实施计划

> **状态：调研后的实施讨论稿。** 本次只新增计划文档，没有修改业务代码、部署服务或调用付费模型。
> **For agentic workers:** 实施获得授权后，使用 `superpowers:executing-plans` 按任务执行；本文件中的步骤当前均未执行。

**Goal:** 用户在 AI 对话中上传图片，模型能实际读取并分析；图片从上传起 24 小时后失效并回收，压缩上下文不影响未过期原图的再次读取。

**Architecture:** 复用项目 workspace PVC、workspace-agent、后端鉴权与现有 Pi worker。图片二进制保存在 PVC，数据库和 Pi 原生历史只保存引用；首次随消息输入，后续可通过会话附件目录和受限 `read_image` 工具重读，图片字节仅在发送模型请求时装配。

**Tech Stack:** 现有 React/TypeScript、Spring Boot、MySQL/Flyway、Kubernetes workspace PVC、`@earendil-works/pi-*` 1.2.0、DeepSeek OpenAI-compatible Chat Completions。

**Spec:** 本文第 1–4 节为本轮需求与设计依据；与用户本轮答复冲突时，以用户答复为准。

## 1. 已确认需求与范围

### 用户已确认

- 用户上传图片，由大模型读取与分析。
- 所有上传统一保留 **24 小时**，不区分是否绑定消息。服务端首次接受上传时固定 `uploadedAt` 和 `expiresAt = uploadedAt + 24h`；发送、重试、读取和压缩均不续期。
- 到期后不给用户或模型继续读取原图；历史消息显示“图片已失效，请重新上传”。
- **不额外生成、存储 OCR 文本或图片摘要作为过期替代品。已经发送的聊天回复保留。**
- 图片失效后只能通过重新上传恢复图片输入；重新上传产生新的附件 ID 和新的期限。
- 图片未过期时，即使对应消息被压缩，用户仍能预览，AI 仍能重新读取原图；不能要求用户因压缩而重新上传。
- 上传限制只保留单张 **10 MB**。本文明确按 `10_000_000` bytes 执行；不另设每条张数、像素、尺寸或项目累计容量上限。
- 保持最小实现，不扩展成通用多模态平台。

### 本稿采用的工程默认值

这些是本轮建议值，不是已存在功能，也不是模型厂商限制；实现时集中成少量常量。

| 项目 | 第一版建议 |
| --- | --- |
| 上传检查 | 前后端只增加单张 10 MB 大小检查；不做缩放、转码、像素检测或额外图片格式白名单 |
| 生命周期 | 所有上传使用同一个 `uploadedAt + 24h`，与消息是否发送无关 |
| 清理执行 | 后端启动后及每 10 分钟分批清理；附件到期立即逻辑失效，不等定时清理 |
| 上游约束 | 沿用 DeepSeek 实际支持的格式、请求体与图片输入限制；遇到上游拒绝明确提示，不宣称单图不超过 10 MB 就必然可推理 |
| 上传入口 | 文件选择、粘贴截图、拖放复用一个处理函数；本地预览，点击发送才上传 |
| 纯图片消息 | 允许；服务端规范化为固定默认目标“请分析上传的图片”，然后参与原有幂等摘要 |

不增加：对象存储、新 PVC、缩略图服务、图片编辑器、独立 OCR 模型、跨项目附件库、跨用户去重、通用 provider 框架。新增的 `read_image` 只接受当前会话已发送附件的 ID，不接受任意文件路径或 URL。

## 2. 当前代码事实与外部能力

### 2.1 调研基线

2026-11-02 本地 checkout 为 `master`，HEAD 为 `e99b88e`（合并 `codex/multi-account`）。开始时已有 `.gitignore` 和 `.zcode/config.json` 的本地修改，本次不改动。这里是调研快照，未来实施应从当时最新 master 创建项目 `.worktree/` 下的新分支。

未检查当前集群 Secret、未启动服务、未重跑业务测试。仓库 2026-10-15 的 AI 验收记录记载模型为 `deepseek-flash`，它只能证明当时配置，不能替代实施时对实际配置的核对。

### 2.2 上游能力已具备，码瑙链路尚未接通

- 2026-11-02 查阅 DeepSeek 官方 Vision 文档：`deepseek-flash` 支持图片输入，现有 Chat Completions 协议可发送 `image_url` + Base64 data URL；无需切换 Responses API。当前官方请求体上限为 48 MiB，支持 JPEG/PNG/GIF/WebP；这些属于上游能力，不另做一套更严的上传限制。
- 项目声明并安装的 Pi SDK 均为 **1.2.0**。该版本支持 `ImageContent { type: 'image', data, mimeType }`、`session.prompt(text, { images })`，以及调用模型前的 `agent.transformContext`。第一版无须为此升级 SDK。
- 但 [`pi-session.ts`](../../../poc4/pi-worker/src/pi-session.ts) 的 `buildModelRuntime()` 把输入写死为 `input: ['text']`，运行时只执行 `session.prompt(prompt)`。已安装 SDK 会将不支持视觉的模型中的图片降级为文字占位，必须修正能力声明并验证实际请求。
- [`AgentTaskController.java`](../../../poc4/backend/src/main/java/com/manao/poc4/ai/AgentTaskController.java)、[`AgentContracts.java`](../../../poc4/backend/src/main/java/com/manao/poc4/ai/AgentContracts.java) 和前端任务接口目前没有附件字段。
- [`AgentConversationStore.java`](../../../poc4/backend/src/main/java/com/manao/poc4/ai/AgentConversationStore.java) 在创建任务的同一事务中记录 `manao_user_request`，浏览器历史是单独的投影；这是绑定图片的现有入口。
- [`conversation-context.ts`](../../../poc4/pi-worker/src/conversation-context.ts) 与后端均限制原生历史单条 2 MiB、上下文页 4 MiB；worker 的启动请求上限仅 64 KiB。图片 Base64 不应进入这些通道，也不应靠全局抬高限制解决。
- [`pi-worker.yaml`](../../../poc4/deploy/ai-stage1/pi-worker.yaml) 中 worker 只有自己的 `emptyDir`，没有项目 PVC；[`pi-session.ts`](../../../poc4/pi-worker/src/pi-session.ts) 禁用内置文件/Shell 工具。把 PVC 路径写进 prompt 不会让模型看到图片。
- [`WorkspaceResourceFactory.java`](../../../poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspaceResourceFactory.java) 已将项目目录挂载到 workspace-agent 的 `/workspace`；普通文件路径规则和 AI 工具拒绝 `.manao` 内部路径。
- [`httpClient.ts`](../../../poc4/frontend/src/api/httpClient.ts) 已有带账号隔离的认证发送逻辑和 `requestBlob()`，但普通 `request()` 只发送 JSON。上传需扩展二进制/表单发送方式，历史图片需走授权 Blob 读取。

### 2.3 DeepSeek Files API 的可行性

官方支持 `POST /files` 上传图片，字段为 `purpose=user_data`、`expires_after[anchor]=created_at`、`expires_after[seconds]=86400`。之后 Chat Completions 可以直接引用：

```json
{"type":"file","file_id":"file-api-..."}
```

但“只在码瑙保存 file_id”有一个尚未解决的产品缺口：官方 `GET /files/{file_id}` 只返回文件大小、文件名、创建和到期时间等 JSON 元数据，没有原图字节或下载 URL；本次未找到 `/content` 或预览 URL 的官方契约。因此不能据此承诺刷新后仍能预览原图，也不能把 OpenAI SDK 的通用方法当成 DeepSeek 已支持的接口。这是文档证据不足，不是断言服务绝对不支持下载。

另有三个具体边界：同一 DeepSeek 账号的所有 API keys 共享文件，码瑙仍须保留用户/项目/会话到 file_id 的授权映射；上传接口未公开幂等键或 digest，丢失响应不能宣称 exactly-once；24 小时到期不等于有证据证明该秒物理介质已完成擦除。`file_id` 是远端文件引用，不是用户登录凭据。

Pi 1.2.0 原生 `ImageContent` 仅含 Base64，没有 file_id 字段，但公开的 `onPayload` 可以替换最终请求。本轮零网络离线探针确认：使用安装包的 OpenAI adapter 加入上述 `file` 块后，mock fetch 收到原样 file_id，原始上下文未改变。这证明小型协议适配可行，不证明 DeepSeek 真实上传、推理或预览成功。

### 2.4 Thinkrail 可借鉴什么

只读审阅用户指定参考仓库的 `2ce6ccb7`，同样使用 Pi 1.2.0：

| 参考代码（参考仓库内路径） | 已确认行为 | 对码瑙的取舍 |
| --- | --- | --- |
| `apps/web/src/chat/imageAttachment.ts:52`、`ChatView.tsx:502` | 浏览器转成 Base64 ImageContent，经 WS 直接交给 Pi；包含缩放/压缩 | 借鉴选图、粘贴与展示；不照搬缩放和大小规则 |
| `packages/server/src/agent/agentSessionManager.ts:560,2051` | SessionManager 保存原生会话，prompt 接收 images | 不照搬将图片字节留在原生历史的方案，否则删文件不能清除图片副本 |
| 同文件 `:753,2140`、`packages/server/src/agent/SPEC.md:277` | UI 读取 Pi 当前上下文；压缩后重新同步，已总结的旧消息连同图片展示移除 | 没有现成的压缩后附件恢复能力可直接复用 |
| `apps/web/src/chat/turns.tsx:184`、`e2e/tool-result-images.spec.ts:19` | 支持图片消息和带图片工具结果的预览 | 借鉴“工具重读图片后仍作为图片交给模型”的交互 |

未发现稳定附件索引、按历史附件 ID 重读或 24 小时清理机制。参考仓库的图片工具 E2E 是手工写入 JSONL 后验证展示，不证明真实工具调用或压缩后找回；本轮未运行其测试。码瑙应保留自己的完整历史，并补上独立于压缩的附件引用与读取工具。

### 2.5 参考资料

- [DeepSeek Vision](https://api-docs.deepseek.com/guides/vision/)
- [DeepSeek Files API](https://api-docs.deepseek.com/guides/files_api)、[Upload File](https://api-docs.deepseek.com/api/create-file)、[Retrieve File](https://api-docs.deepseek.com/api/retrieve-file)、[Delete File](https://api-docs.deepseek.com/api/delete-file)
- [Pi 1.2.0 RPC 图片输入](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/rpc-commands.md)
- [Pi 1.2.0 SDK](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/sdk.md)
- 本地安装包进一步核对了 `agent-session`、`agent-loop`、`transform-messages`、`compaction` 的实际实现，未仅依赖最新版本文档。

## 3. 方案选择与数据流

| 方案 | 判断 |
| --- | --- |
| Base64 放任务 JSON 或会话数据库 | 表面改动少，但触碰现有限额，放大会话恢复流量，也难在 24 小时后清除所有副本，不采用 |
| 项目 PVC 保存文件，历史保存引用，模型请求时读取 | **推荐**；复用既有项目隔离和生命周期，增加一条受限附件链路 |
| 只用 DeepSeek Files API | 上传一次、24 小时自动过期、发送 file_id 很方便；但目前缺少原图下载/预览的公开契约，暂不能完整满足历史预览 |
| PVC + DeepSeek Files API | 可保留预览并减少给模型重复传图，但同时维护两份文件和两套期限；第一版不采用 |

流程：浏览器本地选图和预览 → 点击发送 → 后端校验 owner/project/conversation → workspace-agent 将图片落到 PVC → 返回附件 ID → 原任务提交绑定这些 ID → Pi 从后端取图并在请求中加入图片块 → DeepSeek 读取图片 → 原有流式回答与持久化流程继续工作。

### 3.1 存储与授权

- 文件根目录：`/workspace/.manao/attachments/`，以服务端认可的 UUID 构造固定路径；原文件名仅用于展示，不参与路径拼接。普通文件 API 继续拒绝 `.manao`。
- 此目录是现有项目挂载的一部分，同项目运行容器可能接触到它；它不是与项目代码隔离的秘密存储。读取前验证实际文件、禁止符号链接并校验 SHA-256，文件被修改则报不可用，不能给模型换图。
- 新增一张 `agent_attachment` 表：项目、会话、附件 ID、可空 task ID、文件名、MIME、大小、SHA-256、上传/到期时间、上传完成状态、清理确认时间。关联 task 只用于消息归属和幂等，不参与计时；不保存尺寸或容量预留。
- 先登记上传 ID 和固定期限，再写文件；临时写入、原子 rename、结果确认后才允许发送。相同上传 ID + 相同文件返回原记录和原期限；相同 ID + 不同文件返回冲突。
- 上传响应丢失时按 ID 查询状态和 digest，复用既有“先确认再重试”的原则；不能换 ID 盲目重复上传。服务端不把尚未确认写完的文件返回为可发送附件。
- 浏览器入口沿用登录身份与项目 owner 校验；所有 ID 必须属于同一项目、同一会话。其他用户读取或猜测附件 ID 返回 404。
- worker 仍只访问后端；图片内部读取必须校验 task、worker epoch/instance 和会话归属。后端到 workspace-agent 复用按 project、method、path 和 body digest 签名的 capability。
- 不给 worker 挂 PVC；不暴露公共图片 URL；不把访问 token 放进图片 URL；不通过模型提供的文件路径定位附件。

### 3.2 最小接口变化

浏览器附件资源统一放在 `/api/v1/projects/{projectId}/conversations/{conversationId}/attachments/{attachmentId}`：

- `PUT`：单图片 multipart 上传，客户端预生成 UUID，服务端返回元数据和状态。
- `GET`：读取元数据/上传结果，包含 `expiresAt`、`availability`，用于响应丢失后的确认。
- `GET .../content`：读取已授权且未到期的二进制；已到期返回 `410 AI_ATTACHMENT_EXPIRED`。
- 任务提交增加可选、有序 `attachmentIds` 数组；省略或空数组完全保持旧文本请求行为。
- 内部增加 task 作用域下的会话附件目录/内容读取；目录仅包含当前会话已发送图片，含 ID、文件名、上传时间、所属消息和期限，无 OCR 或图片摘要。worker start 继续只传小型元数据，不接受浏览器自报的存储路径。
- 第一版图片只接入现有会话式任务；遗留无 conversation 的纯文本任务保持兼容。

任务创建事务内同时完成：验证附件已上传、未过期且属于当前会话 → 关联 task → 记录含引用的 `manao_user_request`。**不修改到期时间。** 请求摘要纳入有序附件 ID 和服务端 digest；无附件请求保持原摘要算法。已存在任务先按持久化请求比较并返回，不能因附件后来过期而让相同请求的确认失败。

附件写入不属于源代码变更，不递增 workspace revision，也不因清理附件触发构建/运行锁；上传准入仍检查项目可用且未进入删除。任务提交继续遵守现有写占用规则。

### 3.3 Pi 输入与历史

- 为确认支持视觉的部署配置显式开启 image capability，默认保持关闭；由同一配置生成模型声明及前端能力提示，避免前端允许上传、worker 又静默丢图。
- `manao_user_request.details.attachments` 保存不可变引用及期限；`content` 保留用户文字和简短附件标识，不放 Base64、OCR 或图片摘要。浏览器历史投影增加附件元数据。
- 首次用户带图直接让模型看到图片。在 `agent.transformContext` 上包装原有转换函数：先运行原函数，再深拷贝需要变更的消息，将有效的用户附件引用或 `read_image` 结果引用装配为 SDK `ImageContent`。返回的图片块不写回 Agent state、SessionManager 或数据库。
- 同一个请求中按附件 ID 去重读取；转换缓冲仅属于该次请求，不建立跨轮或跨用户的图片缓存。新一轮模型请求重新判断有效期，过期引用只输出失效提示。
- 模型请求按 DeepSeek 真实的整体请求上限处理，多图累计超限与“单张上传过大”区分提示，不额外限制张数，不静默丢图。Pi 1.2.0 的 provider 层会重试同一份编码 payload；含图片请求通过已有 `fetch` 注入点在每次实际发送（包括重试）前核对期限，到期拒绝重发。已经发出的在途请求不追溯撤回。
- 有效图片因 workspace 不可达、文件损坏等读取失败时明确报错，不能当成过期或悄悄按纯文本执行。已过期的历史图片可显示失效提示后继续普通文字讨论；要求重新核验原图时提示重新上传。
- token 估算需要计入将投影出来的图片，不能仅估算 prompt 字符；沿用该 Pi 版本的图片估算并以响应 usage 校准，Base64 大小另按字节预算检查。

### 3.4 压缩后的图片重读

压缩只缩短模型当前上下文，不删除附件，也不决定原图是否可用：

1. 后端保留当前会话的附件目录，与 Pi 的压缩摘要分开。模型请求前提供轻量目录，含所属消息 ID、顺序/时间、文件名、附件 ID 和期限；必要的定位文本只取用户原文的简短片段，不重放整条历史，不生成 OCR 或图片摘要。目录不包含图片字节，不需要模型从摘要猜 ID。
2. 增加一个只读工具 `read_image({ attachmentId })`。用户说“再看一下之前那张图”时，AI 从目录选取对应图片；后端校验当前 task 的 owner/project/conversation、附件已发送且未过期后返回受控引用，随后出站转换才读取图片字节，避免工具与转换阶段重复读图。
3. 工具的持久化结果仍只有附件引用和可用性。出站转换才加入图片内容块，防止工具结果把 Base64 再写进原生历史。重读不改变 workspace revision，不重置 TTL，不触发上传。
4. 每次模型请求依据当前有效期重建目录和图片投影；压缩摘要是否提及图片、worker 是否重启都不影响发现和读取。手动压缩本身不执行图片读取工具。
5. 图片到期后工具返回明确失效结果；只有这时要求重新上传。存储故障与文件损坏显示不可用，不能伪装过期。

这只增加一个受限工具和一份现有附件表的元数据投影，不建设检索系统，也不每轮把整个历史的图片重新发送。正常会话摘要仍可能保留已发聊天回复中的分析结论；不另建图片摘要缓存。

## 4. 失效与清理合同

| 时点 | 用户/模型行为 | 文件处理 |
| --- | --- | --- |
| 只选择图片，未点发送 | 本地缩略预览，可移除 | 不上传；切换账号/项目/会话或卸载时撤销 Object URL |
| 上传被服务端接受 | 固定 `uploadedAt` 与到期时间；未发送的图片不进入 AI 目录 | 无论后来是否发送，均在上传起 24 小时到期 |
| 图片已发送且未到期 | 历史可预览，模型可读取 | 文件保留，回复结束不删除 |
| 未到期但被压缩移出上下文 | 历史仍可预览；AI 通过附件目录和 `read_image` 重读，无需重新上传 | 原期限不变 |
| 上传满 24 小时 | 内容端点立即 410；显示失效提示；`read_image` 和后续模型请求不能取原图 | 加入统一待清理集合，不检查绑定状态、不续期 |
| 到期后的清理周期 | 失效状态保持 | 删除原图及本附件残留 `.part`；确认不存在后标记已清理 |
| 清理失败/服务停机 | 不恢复图片访问；不把未删除标为已删除 | 记录失败，下一周期重试；恢复后补清 |
| 删除项目 | 沿用原项目删除合同 | 已有项目 PVC 清理负责文件，新增表随项目外键清理 |

- 逻辑可用性由服务端时钟和 `expiresAt` 决定，不能靠文件还在不在或定时任务是否执行来判断。正常运行时物理删除延迟最多一个调度周期加批次处理时间；服务/存储不可用时不保证整点删除。
- 清理只按 `expiresAt <= now` 且未确认删除选取，幂等删除原图和 `.part`，确认不存在后记删除结果；所有上传共用这一条规则。
- 上传有有限超时，不允许到期后迟到写入重新产生文件。读取/发送并发撞上到期时返回失效或重新确认，不能悄悄执行纯文本请求。
- 轻量附件元数据保留用于失效展示；清理原图不删除聊天回复、任务记录或用户代码。
- 后端定时循环只查本表到期索引、分批处理，不递归扫描整块 PVC，也不依赖用户下次访问触发。首版不增设 Kubernetes CronJob。
- 浏览器图片经现有认证 `requestBlob()` 读取，响应使用 `Cache-Control: private, no-store`；到期计时器撤销已载入的 Object URL，页面重新可见时重核状态。响应读取/图片解码完成时再次核对期限，迟到的过期响应不能新建预览。账号切换取消请求、丢弃迟到结果并清空图片内存。
- 24 小时合同约束码瑙管理的存储与展示；已经下载的副本、项目程序主动复制的文件和厂商已收到的请求无法通过本地附件清理追溯删除。第一版不添加“保留到项目代码”的入口。

## 5. 实施步骤

### Task 1：完成受限附件上传、读取与存储

**文件：** 新增后端 `ai/AgentAttachmentController.java`、`AgentAttachmentService.java`、`AgentAttachmentStore.java`、`AgentAttachmentContracts.java`；新增 workspace-agent `WorkspaceAttachmentService.java` 与对应 controller；扩展 `WorkspaceAgent.java`、`WorkspaceApiClient.java`；新增下一编号 Flyway migration（当前应为 `V19__agent_attachments.sql`，实施时先核对）。

- [ ] 先写单张 10 MB 边界、跨 owner/project/conversation、UUID 路径、符号链接、相同 ID 重试和不同 digest 冲突的失败测试。
- [ ] 实现上传登记时固定 24 小时期限、二进制读写、原子落盘和结果确认；不添加转码、尺寸检测或容量预留。
- [ ] 对附件路由在读入内存前限制单文件大小；现有 capability filter 会全量缓存请求，新增入口须先约束读取量。multipart 和 nginx body 限制需容纳 10 MB 文件及表单开销，不把合法的上限文件误拒绝。
- [ ] 交付验证：新图片经 owner 可读，另一用户不可读；响应丢失后同 ID 可确认且期限不变；原文件 API 不能进入内部附件目录。

### Task 2：把附件纳入原任务幂等与历史合同

**文件：** 修改 `AgentContracts.java`、`AgentTaskController.java`、`AgentConversationController.java`、`AgentTaskStore.java`、`AgentConversationStore.java`、`AgentConversationContracts.java` 及相应测试。

- [ ] 先验证附件未上传完成、错误会话、已过期、已绑定另一任务均不能创建新任务。
- [ ] 将附件关联和用户请求历史放进现有任务创建事务，固定附件顺序和内容 digest；验证发送晚于上传也不会延长 24 小时期限。
- [ ] 扩展历史投影返回附件 ID/文件名/MIME/期限/当前可用性；不向浏览器暴露内部路径。
- [ ] 交付验证：丢失提交响应后查询原任务可恢复；重复提交不重复绑定、不延长期限；无附件的历史请求摘要保持兼容；worker 启动前失败仍能显示用户已发送的图片消息。

### Task 3：让 Pi 读图，并在压缩后仍能重读

**文件：** 新增 `poc4/pi-worker/src/image-context.ts` 及测试；修改 `pi-session.ts`、`project-tools.ts`、`backend-client.ts`、`config.ts`、必要的 worker 能力接口，以及后端内部附件目录/读取入口和 `AgentProjectTools.java` 的受限工具分派。

- [ ] 用锁定的 Pi 1.2.0 和可控 stream/provider mock 先验证投影：最终请求有正确 `image_url`，原生 history/state 没有 Base64；覆盖下一轮恢复和工具调用后的再次模型请求。
- [ ] 实现图片能力配置、会话附件目录、`read_image({ attachmentId })`、不可变出站图片转换与发送前有效期检查。目录不含未发送附件，工具拒绝其他会话/项目附件，结果只持久化引用。
- [ ] 构造一次真实 Pi 压缩，把最早图片消息移出上下文；随后用目录 ID 调用 `read_image`，验证 mock provider 仍收到原图，未重新上传。再覆盖 worker 恢复、重复压缩和工具结果重新投影，保持 2 MiB 原生历史限制。
- [ ] 覆盖图片 token 估算、上游整体请求超限、24 小时后无图片、未知 ID/损坏/网络故障不伪装成功；工具读取与任务提交都不续期。
- [ ] 验证 callback 顺序不破坏原 `transformContext`，测试重试与 abort/dispose 能释放图片缓冲；确认文本流、thinking、工具回执和任务收尾行为未改变。

### Task 4：接入前端选择、发送和失效展示

**文件：** 新增 `src/features/ai/ImageAttachments.tsx`、`src/api/agentAttachmentApi.ts` 及测试；修改 `httpClient.ts`、`contracts/agentTask.ts`、`contracts/agentConversation.ts`、`AgentTaskPanel.tsx`、`ConversationHistory.tsx`、相关样式及测试。

- [ ] 在一个组件中实现选择/粘贴/拖放、本地预览、移除；点击发送后逐张上传并收集 ID，再按原 task ID 提交。取消或切换作用域时终止待发流程。
- [ ] 上传失败保留本地选图与已确认 ID，可重试；任务响应不确定先核对原 ID，不自动新建任务。不要把图片或 Bearer token 写入 localStorage。
- [ ] 图片经认证 Blob 显示；对刷新、到期、页面恢复可见、账号切换、迟到响应做状态处理；所有 Object URL 有对应 revoke。
- [ ] 图片能力关闭时不给用户发送图片入口；纯图片消息用明确默认目标。历史到期显示失效占位，不再保留可点开的旧预览。
- [ ] 交付验证：刷新或压缩后有效图仍可显示；用户要求重看时无需再次选图上传；上传满 24 小时后失效；切换账号后无图片闪现或旧结果写入新会话。

### Task 5：清理与端到端验收

**文件：** 新增后端 `AgentAttachmentReconciler.java` 及测试，接入现有调度配置；补充 workspace-agent 删除测试、前后端附件集成测试及 `poc4/docs/evidence/ai-image-input/acceptance.md`。

- [ ] 使用可控 Clock 验证所有上传均在 `uploadedAt + 24h` 失效，未发送和已发送使用相同清理；覆盖读取/删除竞争、慢上传、清理失败重试、进程恢复补清和项目删除。
- [ ] 对纯文本、带图、多图、继续会话、暂停/继续、压缩、刷新和跨账号访问做有限的合同回归；不重跑无关完整集群测试矩阵。
- [ ] 实施获部署授权后核对实际 DeepSeek 模型配置，真实模型先识图，再压缩并提问此前未回答的另一处图片细节，确认调用 `read_image` 后正确作答且没有重新上传。测试图片细节不写入 prompt，旧文字答案不能作为重读证据。
- [ ] 在可控测试时钟下经过真实浏览器路径验证 24 小时边界、410、失效占位和模型请求无图片；普通聊天回复保留。
- [ ] 部署需覆盖 backend、frontend、pi-worker、workspace-agent 四端兼容；已存在 workspace Pod 不会因配置换镜像自行升级，必须安排按项目受控更新并保留 PVC，验证现有项目也能上传。不把这一步误记为已执行。
- [ ] 验收记录分别标记本地合同测试、真实模型读取、实际存储清理、云端部署结果；未执行项写 `NOT_RUN`。

## 6. 验证方式与完成标准

实施中按实际测试文件选择最小集合；下面命令是计划，不是本轮执行结果：

```powershell
# Workspace-agent：附件 IO、路径约束与清理
mvn -f poc4/workspace-agent/pom.xml -Dtest=WorkspaceAttachmentServiceTest,WorkspaceAttachmentControllerTest test

# Backend：只使用 disposable schema 的相关合同测试
mvn -f poc4/backend/pom.xml -Dtest=AgentAttachmentStoreTest,AgentAttachmentHttpTest,AgentAttachmentReconcilerTest,AgentTaskStoreTest,AgentConversationStoreTest test

# Worker：投影、历史与模型请求
pnpm --dir poc4/pi-worker test -- test/image-context.test.ts test/project-tools.test.ts test/pi-session-context.test.ts test/pi-session.test.ts
pnpm --dir poc4/pi-worker build

# Frontend：新组件及修改过的合同
pnpm --dir poc4/frontend test -- src/features/ai/ImageAttachments.test.tsx src/features/ai/AgentTaskPanel.test.tsx src/features/ai/ConversationHistory.test.tsx src/api/httpClient.test.ts
pnpm --dir poc4/frontend typecheck
git diff --check
```

满足以下条件才算本增量完成：

1. 真实模型能读出图片中特定信息；压缩后还能重读未过期原图，用户无需重新上传。文字输入、thinking、原工具和收尾仍正常。
2. 图片不会进入任务启动 JSON、持久化会话 Base64、日志或跨用户缓存。
3. 每张不超过 10 MB；所有上传均从上传起算 24 小时，到期后原图对浏览器和后续模型请求不可用，已有聊天回复不删除。
4. 正常运行的清理循环确认删除原图及临时文件；失败有记录和后续重试，不能把“已失效”当作“已删除”。
5. 未发送垃圾、上传/提交响应丢失、跨用户访问、worker 重启和既有 workspace 升级均有直接证据。

本轮完成代码/官方文档调研、Pi file_id 出站适配的零网络离线探针及计划检查。以上附件功能、真实模型识图、压缩后重读和清理验收仍均 **NOT_RUN / 尚未实现**。
