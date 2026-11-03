# AI 图片输入与 24 小时清理：本地实施证据

日期：2026-11-02。分支：codex/ai-image-input；实施基线 HEAD：5e7d55d。

2026-11-03 更新：四端已发布，真实首次识图、压缩及 worker 恢复后重读、刷新预览和会话隔离已按固定场景通过；自然 24 小时真实清理和用户完整验收仍待验证。最新线上镜像及证据以[集群发布记录](cloud-release-20261103.md)为准。下方本地测试和首次 NOT_RUN 表保留为 2026-11-02 的阶段快照。

本地业务实现覆盖 Task 1–5。本文分别记录本地证据和仍未执行的真实环境验收，不将离线 provider、浏览器夹具或临时目录等同于真实模型、PVC 或部署验收。

## 实现范围

| Module | 已接入的行为 |
| --- | --- |
| Attachment lifecycle | 单图 10_000_000 bytes；owner/project/conversation 授权；先登记固定 24 小时期限；同 ID/digest 确认；同事务绑定 task 和历史；目录分页、读图、到期回收 |
| Image context | 在原 Pi hooks 后投影受控引用；实际 OpenAI-compatible image_url；只在单次出站持有 Base64；目录和 read_image 重读；大小、token、授权和每次发送期限检查 |
| Image attachments | 文件选择/粘贴/拖放；发送时上传；丢失响应确认；认证 Blob 历史预览；作用域取消；到期撤销 Object URL |

原图仍位于项目已有 PVC 的 /workspace/.manao/attachments/。不增加 PVC、对象存储、Files API、转码、缩放、图片张数/像素/尺寸/项目容量限制，数据库与原生历史不保存 Base64。任务请求只有有序附件 ID，历史和工具结果保存受控引用。普通文件 API 拒绝内部目录及其符号链接别名。

上传登记时固定 uploadedAt 和 expiresAt；绑定、重试、读取和压缩均不续期。READY 且当前时间早于期限才可读取；到期内容端点立即 410。清理依次确认原图与 .part 删除，再记 DELETED；轻量 .deleted/.lock 文件是持久防重现标记，不是原图副本。已有回复保留。

## 本地验证

| 范围 | 状态与直接证据 |
| --- | --- |
| Workspace-agent 文件和 HTTP | PASS：10 MB/超出 1 byte、UUID、静态符号链接、SHA-256 损坏、同 ID 重试/冲突、确认、删除、慢上传与删除交错、到期后迟到写入；真实 Spring/filter；未知 Content-Length 和编码/path parameter 变体预限 |
| Backend 附件 HTTP/store | PASS：disposable MySQL schema；写入成功但 ACK 丢失后确认；23 小时绑定不续期；到期 410；已有 task 到期后确认；内部 epoch/instance；工具 ledger；事务回滚；分页与长文件名 |
| Backend 生产装配 | PASS：实际 AiConfig、SecurityConfig、multipart、Controller、生命周期、历史和调度 bean；真实 loopback HTTP 接受 10 MB；另一账号 404；浏览器 JWT 不能访问内部端点 |
| WorkspaceAgent Adapter | PASS：真实 WorkspaceApiClient 发出 10 MB 二进制；对实际 method/path/query/body 验证 capability 签名；确认/内容/删除也走签名 Adapter |
| Pi 请求与压缩 | PASS：锁定 Pi 1.2.0；实际 provider 编码为 image_url；worker 恢复后两次真实 compact；摘要请求不读二进制；read_image 后再次发送原图；持久化 JSON 无 Base64 |
| Pi 预算与失效 | PASS：自动压缩前计入图片预算；多张合法 10 MB 累计超限在二进制读取前拒绝；完整旧工具回执过期重放；maxRetries=1 的实际 provider 重试；多图异步校验后的最终同步期限检查；损坏/缺失/不可达明确失败；stop 中断取图 |
| 前端组件与 HTTP | PASS：134 项相关测试；StrictMode；纯图片默认目标；上传 UPLOADING 后同 ID 确认 READY；scope cleanup 释放 pending；账号切换迟到 Blob 丢弃；服务器时钟偏差；typecheck 和 production build |
| 本地 Chromium | PASS：真实 composer/history 组件；选择不上传、发送只上传一次、刷新仍预览、24 小时撤销预览、刷新后失效、已有回复保留；接口使用离线夹具 |
| 任务、历史与现有工具回归 | PASS：AgentTaskStoreTest 35、AgentConversationStoreTest 21、AgentProjectToolsTest 36，以及 worker 文本/thinking/工具/暂停继续/收尾相关既有测试 |
| 清理与项目删除 | PASS（本地）：未绑定与已绑定附件同一期限；失败后 DELETING、下次确认 DELETED；100 条失败不饿死后续健康记录；项目删除不被新外键阻断；本地临时目录原图/.part 确认不存在 |

Backend 装配测试的 WorkspaceAgent 是有状态 Adapter 替身，cluster/Run 是无外部副作用替身；workspace-agent 本身另有真实 Spring 与文件 IO 测试，签名 transport 另有真实 HTTP 测试。浏览器夹具只证明浏览器链路；没有把这些结果称为四端真实环境整体验收。

### 已执行命令

本机 Maven 入口为 IDEA 随附 mvn.cmd；下面的 mvn 代表该入口。所有数据库测试使用 JdbcStoreTestSupport 创建并关闭独立 manao_stage6_UUID schema，不重置运行库。

    mvn -f poc4/workspace-agent/pom.xml -Dtest=WorkspaceAttachmentServiceTest,WorkspaceAttachmentControllerTest,WorkspaceAttachmentFilterTest,WorkspaceFileServiceTest test
    mvn -f poc4/backend/pom.xml -Dtest=AgentAttachmentStoreTest,AgentAttachmentHttpTest,AgentAttachmentAssemblyTest,AgentConversationHttpContractTest,WorkspaceApiClientTest,WorkspaceApiClientTransportTest test
    mvn -f poc4/backend/pom.xml -Dtest=AgentAttachmentHttpTest,AgentConversationStoreTest,AgentProjectToolsTest,WorkspaceApiClientTest,WorkspaceApiClientTransportTest test
    mvn -f poc4/backend/pom.xml -Dtest=AgentAttachmentHttpTest,AgentTaskStoreTest test
    mvn -f poc4/backend/pom.xml -Dtest=AgentAttachmentStoreTest,AgentAttachmentHttpTest,AgentAttachmentAssemblyTest,FlywaySchemaTest,AccountSchemaTest,ProjectDeletionStateMigrationTest test
    mvn -f poc4/backend/pom.xml -Dtest=AgentAttachmentStoreTest,AgentAttachmentHttpTest,AgentAttachmentAssemblyTest,AgentConversationStoreTest,AgentConversationHttpContractTest test
    mvn -f poc4/backend/pom.xml -Dtest=AgentAttachmentStoreTest test
    mvn -f poc4/backend/pom.xml -DskipTests package
    mvn -f poc4/workspace-agent/pom.xml -DskipTests package
    pnpm --dir poc4/pi-worker test
    pnpm --dir poc4/pi-worker build
    pnpm --dir poc4/frontend test -- src/features/ai/ImageAttachments.test.tsx src/features/ai/AgentTaskPanel.test.tsx src/features/ai/ConversationHistory.test.tsx src/api/httpClient.test.ts src/api/agentAttachmentApi.test.ts
    pnpm --dir poc4/frontend build
    pnpm --dir poc4/frontend exec playwright test --config playwright.ai-image-input.config.ts
    git diff --check

Worker 全套：195 PASS / 1 SKIPPED（最后使用 pnpm test -- --reporter=dot）。SKIPPED 是需专门启用的旧 local-terminal-harness 常驻服务测试，不能记作通过，也不是本轮真实模型验收。

最终保留报告的实际 testcase 节点：backend 146、workspace-agent 30，均无 failure/error（分批执行的相关测试，不是全量 backend suite 声明）。Frontend 相关测试 134 PASS；本地 Chromium 1 PASS；四端本地构建/编译通过。最新图片用例 13 PASS，其中包含只替换网络 fetch、使用生产默认 createAgentSession/ModelRuntime 的实际请求路径。单独核对本轮日志中的 165 个 disposable schema，剩余 0；本地浏览器测试端口已关闭。

构建会报告既有大 bundle 提示；未为本增量改动代码分包。

## 独立只读复核与修复

| 发现 | 修复与回归 |
| --- | --- |
| 内部目录别名及编码路由可绕开入口策略 | canonical path 拒绝内部子树；filter 复用 Spring 路径匹配；真实 HTTP + 限量读取测试 |
| task 外键阻塞既有项目删除 | task FK 使用 ON DELETE SET NULL；最终项目外键仍级联回收；真实 MySQL 删除回归 |
| StrictMode 提前 abort，切会话 pending 不释放 | 重建 controller、动态 signal、作用域成对释放 pending；StrictMode/取消测试 |
| UPLOADING 被错误缓存为成功上传 | 仅 READY 写入已确认记录；后续按同 ID 查询恢复；不因待定结果要求新 ID |
| 能力关闭后旧引用静默丢图 | 当前引用明确拒绝、工具返回安全禁用错误；旧纯文字路径保持可用 |
| 原 provider 重试用例没有开启重试 | 显式 maxRetries=1；期限拒绝保留安全 failureCode |
| 校验后一张图片期间前图到期 | 全部异步授权结束后，紧贴 transport 再同步检查全部期限 |
| 最早失败批次阻塞后续过期记录 | cleanup_attempted_at 持久化公平排序；100 条失败后健康条目仍被处理 |
| 接受的历史可能超传输预算，或到期后状态变长超限 | 同事务校验完整 native/history，并预留最长 availability；超限整体回滚及临界到期回归 |
| 旧迁移测试将 latest 固定为 V18 | 只更新 latest 断言为 V19；历史版本升级断言保留 |
| 合法大 JSON 历史触发 MySQL 1038 排序内存不足 | browser/native 分页使用已有 PRIMARY 会话/序号顺序；临界预算的到期历史和会话回归通过；不改运行库参数 |

## 配置与真实环境待验项

Worker 默认关闭图片输入。只有确认部署模型支持视觉后，设置 MANAO_AI_IMAGE_INPUT=true；部署模板通过已有 manao-pi-worker-model Secret 的可选 image-input 字段绑定。后端和浏览器从 worker /status 的同一事实取得能力，不另设前端开关。此变更只编辑模板，未应用。

| 验收项 | 状态 |
| --- | --- |
| 真实付费模型首次识图、压缩后读取未回答的图片细节 | NOT_RUN |
| 真实项目 PVC 上到期原图与临时文件删除 | NOT_RUN |
| backend/frontend/pi-worker/workspace-agent 四端镜像发布与兼容部署 | NOT_RUN |
| 既有 workspace Pod 受控升级且保留 PVC | NOT_RUN |
| 云端浏览器与多账号实际环境验收 | NOT_RUN |
| 用户验收 | NOT_RUN |

真实部署需四端配套；worker 不挂项目 PVC。已存在的 workspace Pod 不会因为模板换镜像自动升级，必须在额外授权的发布阶段受控处理。不能将逻辑 EXPIRED 当作原图已物理删除，也不承诺撤回已交给厂商的在途请求。

当前交付保留本地分支与工作树，不自动合并 master 或推送。详细实施依据见[计划](../../../../docs/superpowers/plans/2026-11-02-ai-image-input-implementation-plan.md)。


## 2026-11-03 获授权后的集群发布增量

四端镜像已构建、推送并以 linux/amd64 digest 部署，运行库 V19 success=1；七个既有 workspace 原位升级，Pod UID/PVC/Service selector 保持一致。专用验收项目 READY。真实模型首次识图 4827、真实压缩后经新 worker 目录/read_image 重读 K9R4、刷新预览、真实会话隔离均 PASS；四个新 task 全部 COMPLETED/terminal receipt 已落库。上传始终 1 条，TTL 86400 秒且未续期，原会话 23 条 native entry 无 Base64。自然 24 小时 PVC 清理和用户完整验收仍 NOT_RUN。完整发布身份、恢复演练、独立复核和范围边界见[集群发布记录](cloud-release-20261103.md)。此前表格是 2026-11-02 本地阶段快照，本节为后续增量。


现场发现并修复 HTTP randomUUID 缺失、压缩请求多发 conversationId 导致 422、切会话取消已提交任务的原 ID 确认（包括下一轮上传标志复位）。均有实际 RED→GREEN 证据与独立只读复核。最终相关 4 文件 100 PASS，标准 Dockerfile 内 pnpm build/typecheck 通过。最终 frontend amd64 digest 0275df40c76abd9a0fd8c3102018cd88341b8c2c26c0c19566f68b57b750e479，Ready 1/1；其他三端沿用本轮初始发布。自然到期为 2026-11-04 12:03:33.653（Asia/Shanghai），到期 410、失效展示和真实 PVC 删除须届时再核验；当前不授予完整功能验收 PASS。


2026-11-03 13:2x（Asia/Shanghai）后续：用户要求提交并清空当前测试账号项目。业务提交 a27d77a 已完成；app_user 账号执行时剩余 3 个项目已全部删除，项目/关联数据/5 个 PVC/PV/NFS 目录核验无残留，其他账号与平台资源保留。原图片 fixture 随项目删除，自然 24 小时到期验收仍 NOT_RUN，需新上传才可补验。详见集群发布记录最后的清理章节。
