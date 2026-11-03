# AI 图片输入：2026-11-03 集群发布记录

本记录是 2026-11-03 获得用户发布授权后的增量证据；[本地验收记录](acceptance.md)中的本地结果不自动等于真实模型、24 小时物理清理或用户验收。目标是 `kubernetes-admin@learn` / `manao-stage6b`，只经已批准的 `127.0.0.1:6443` 隧道操作。没有 Git push、master 合并或旧任务人工修复。

## 镜像与恢复点

- 工作树 `codex/ai-image-input`，HEAD `5e7d55d5e7f0c3238bdad95a3396c61b8a0b6170`；构建包含未提交源文件，源清单 SHA-256 `4f266e8a7d574a0e4d721f9bd8c2e4d5df816d9e1e680e7b5f2cca046e3f0c9d`。不能只用 HEAD 复现本轮镜像。四次标准 Dockerfile 构建和 `docker push` 均 exit 0；frontend 构建参数 `VITE_ENABLE_AI=true`。tag 后缀统一为 `ai-image-20261103-4f266e8a`。
- 四个 linux/amd64 子镜像（均为 `chocologic/manao_images_repository`）：backend `sha256:c86fda5f9ba39387c2b408accae031c4d41869f9890c5aa8c9f2da4a7355d9a4`；frontend `sha256:36e1e646c13805bb074b295684fe93af7a7880e1f40e18577bed5acd0c5ba611`；worker `sha256:5591d99fa38a85e1e304b80c52e669e1864da380e2838ac6128dea858ca54137`；workspace-agent `sha256:3fa3d472d86402f687ba97d93cce037bf4aeb115e57a0326a7d8593edbf1fc8d`。部署使用这些不可变 digest，而非可变 tag。
- 发布前 digest：backend `sha256:d560ec2ac2fd56060912ec6799422a9ed87e12434ad4db76aaa6690776ed2ca2`；frontend `sha256:74c5883059e8c99e1af1c4ede14d970a88a9ec674d8f050234418499ac58905c`；worker `sha256:696080571ba556d983aa578163be3d6494261057e960a9686b15f814e7d0c93e`；七个 workspace-agent `sha256:cc1ae046178ec5bbc605ceef20a1b4e336083342d614eb4a95c3417e71c731f5`。原副本数均为 1；backend/worker 策略 Recreate，frontend RollingUpdate。
- 运行库 `manao_poc4_6b` 的 V18→V19 前私有备份 2,259,290 bytes，SHA-256 `2a2ec0fd5993afaecb2e08a977758d6b55de87e2718b0734f7dbbea8a1142f7c6`，保存在仓库外的本机私有发布目录，未入 Git。一次性 `manao_ai_image_restore_20261103` schema 恢复后，17 张表的行数逐表一致，`mysqldump --no-create-info --skip-triggers --skip-extended-insert --order-by-primary --skip-comments --compact` 数据摘要两端同为 `e41d8d36e340b56c3f05eb20e3a5f7c835590964bbe29520bb7e2927b91cf360`；在该一次性 schema 应用 V19 SQL，新增表 14 列、0 行。没有重置运行库。

## 实际发布

发布窗口先核对 worker `/status` 空闲以及除已记录旧任务之外的 task/compaction/tool/Run 占用均为 0；frontend、backend、worker 短暂缩容为 0 阻止准入和运行，再按镜像/配置逐项恢复。backend 启动时 Flyway V19 成功 1 次，`agent_attachment` 初始 0 行。现有 `manao-backend-images` 仅更新 workspace-agent image digest；worker 的模型 Secret 加入 `image-input=true`，Deployment 从该 key 读取。未覆盖线上其他 env、资源或凭据。DeepSeek 官方 Vision 文档在发布前确认 `deepseek-flash` 支持 OpenAI-compatible `image_url`，上游请求体限 48 MiB；这不能代替真实模型调用验收。

首次发布后 backend、frontend、worker 均为 1/1 Ready，实际 Pod imageID 与上述子 digest 相同；worker `/status` 返回 `modelConfigured=true`、`imageInput=true` 且空闲。七个现有 workspace Pod 原位只更新 agent 容器 image，逐个核对 Pod UID 未变、PVC claim 未变、Ready 与新 imageID；没有重建/删除 PVC。前端后续现场修复及最终镜像以文末为准；真实上传和模型路径已按下述场景通过。

历史遗留任务 `b3b32518-f0ed-411e-aa85-1ecef95fbdc5` 在发布后只读查询仍为 RUNNING，不将其算作本轮任务或修复。backend 自带后台 reconciliation，可独立更新其 `next_reconcile_at`；本轮没有人工 close、重放或 SQL 修改它。

## 验收边界与回退

| 验收项 | 目前状态 |
| --- | --- |
| 四端构建、推送、实际部署、V19、既有 workspace 原位升级 | PASS（上述集群直接证据） |
| 真实浏览器上传、首次识图、刷新预览、真实压缩后 read_image 重读 | PASS（单张合成图、下述固定身份场景） |
| worker 重建后定位同一附件、TTL 不续期、持久化引用 | PASS（同一场景，上传始终 1 条，TTL 86400 秒） |
| 真实会话隔离 | PASS（另一会话 read_image 被拒绝） |
| 真实多用户/跨项目、10 MB/多页目录/累计上游限额完整矩阵 | NOT_RUN；对应本地合同测试已有 PASS，不能替代现场矩阵 |
| 自然满 24 小时后的真实 PVC 原图清理与失效展示 | NOT_RUN；需到期后验证，不以可控时钟的本地测试替代 |
| 用户验收 | NOT_RUN |

发布初始阶段，旧验收账号凭据在公网入口登录返回 401，没有改变密码或绕开登录。用户随后在 Edge 完成登录；通过真实页面创建专用 `ai-image-acceptance-20261103` 项目，ID `812d9d77-74c7-400f-9f5f-5110c3a2714a`，运行库只读回查为 READY。首次自动文件选择器因扩展权限和浏览器控制限制而中断，当时附件表 0 行；随后由用户手动选择合成 PNG，继续发现并修复下面的 HTTP 选图缺陷。没有擅自放宽浏览器扩展权限。专用项目保留原图用于自然到期验收，占用该用户 1 个项目配额，验收后应核对归属再回收。

补充只读核对：公网 `/api/v1/auth/options` 返回 200；七个 workspace 的 Pod UID、PVC claim 与 Service selector 均一致。一次性恢复 schema 和 mysql-0 上的临时 dump 在核对本地备份 SHA-256 后实际删除；私有本地备份保留。回退只能在确认新 task/attachment/receipt/close 状态后按四端旧 digest 协调执行；不 down-migrate V19，不恢复会覆盖新业务数据的旧全库备份，也不把旧 backend 当作具备 24 小时图片清理能力。

## 公网 HTTP 选图缺陷与修复（2026-11-03 11:4x–11:5x，Asia/Shanghai）

用户完成手动选图后，真实页面没有生成本地图片卡片，原生文件输入却显示文件名。浏览器控制台直接记录 `TypeError: crypto.randomUUID is not a function`，堆栈位于 ImageAttachments.select/onChange。原因是正式入口为公网 HTTP，randomUUID 只在 secure context 提供；此前 localhost 浏览器夹具没有覆盖这个差异。本轮没有提交空文字任务来伪造识图成功。

先在 ImageAttachments.test.tsx 增加“无 randomUUID、保留 getRandomValues”的真实组件选图回归，`pnpm --dir poc4/frontend test -- src/features/ai/ImageAttachments.test.tsx` 实际 RED：1 failed / 5 passed，错误与公网相同。实现仅改为复用已有 generateAgentTaskId() 的 CSPRNG UUID v4；`pnpm --dir poc4/frontend test -- src/features/ai/ImageAttachments.test.tsx src/features/ai/AgentTaskPanel.test.tsx src/api/agentAttachmentApi.test.ts` GREEN：69 PASS；`pnpm --dir poc4/frontend build` 通过 typecheck 和 production build。

只重建/推送/部署 frontend，其他三端保持原 digest。修复 tag `frontend-ai-image-http-0444e1d4`，frontend 未提交源文件清单 SHA-256 `0444e1d475af82265ac5757acb257bace9f3ca33c323fab6615a681f6a828284`，OCI index `sha256:4658963e6a5f23992a746a774cc5be446973ea18ff4e40538953f92d330eb419`，实际部署 linux/amd64 子 digest `sha256:ad5fca5d6c7def26ec44db08645cb4ebe77eac77fb4ef2133a8d1941a5de51d2`，rollout exit 0，Ready 1/1。刷新加载该版本使 memory-only 登录会话结束，已请求用户重新登录并选图；真实模型测试随后继续，不能把此前选图失败算作上传通过。

## 压缩合同、原任务确认修复与最终前端

首次真实识图成功后，手动压缩请求返回 422。CDP 只读取该请求 body/安全错误，确认前端将本地 CompactIntent 的 conversationId 连同 requestId、expectedHeadSeq 一起发送；后端 strict CompactRequest 只接受后两项。先将 API 回归输入改为含 conversationId 的真实 runtime intent，实际 RED 1 failed / 1 passed，再在 API 出站层明确投影两字段。两条既有 panel 夹具错误地预期 conversationId 进入请求体，同步修正其断言；本地完整意图、URL 会话和原请求重试保持不变。

相关测试还复现既有“切到 B 后继续确认 A 的不确定提交”失败。图片取消信号被错误地用于已提交任务的确认，cleanup 提前释放父层 pending。修复后，上传阶段切会话仍取消并释放；已持久化 task ID 的 probe/POST 依父层账号/项目 scope 继续核对，同项目切会话保留 B 草稿，换账号/项目停止旧结果进入页面。独立复核再发现 submitted 标志跨轮残留，新增“首轮完成→下一轮上传取消”用例实际 RED 1 failed / 62 passed；每轮开始复位后通过。没有修改 backend 任务收尾或多账号机制。

最终命令：`pnpm --dir poc4/frontend test -- src/api/agentConversationApi.test.ts src/features/ai/AgentConversationPanel.test.tsx src/features/ai/AgentTaskPanel.test.tsx src/features/ai/ImageAttachments.test.tsx`：**100 PASS**（4 文件）。标准 frontend Dockerfile 内 `pnpm build`（含 typecheck）通过，保留 VITE_ENABLE_AI=true。HTTP UUID、压缩字段、上传取消/任务确认三处最终实现均经独立只读复核；非断言式模拟请求及 StrictMode 探针作为补充，不替代真实场景。

最终 frontend tag `frontend-ai-image-final-ac28004c`，22 个变更/新增前端文件的精确私有清单 SHA-256 `ac28004c255ea535a07fc093f0a853e464fcd06851952fe966319b1c196a9caa`；OCI index `sha256:485397224710b87ad1cfc4a825f99f32fbb42fee65c739dfb1398a6fee2c2a25`，linux/amd64 子 digest **`sha256:0275df40c76abd9a0fd8c3102018cd88341b8c2c26c0c19566f68b57b750e479`**。实际 rollout exit 0，Ready 1/1；其余三端 digest 与初始发布一致。两个中间本地候选镜像未推送/未部署，不把其身份算作线上版本。

## 真实模型与浏览器场景（最终状态）

固定项目 `812d9d77-74c7-400f-9f5f-5110c3a2714a`，原会话 `32c9c961-0a6f-4aeb-a40e-8a34fc0acdd9`。合成图 vision-fixture.png 为 13,203 bytes，原图 SHA-256 `9afd9ea268758c5715ffeaa8e30d10768f7515c67970d7613c03c47d2aecfb31`；文件名和 prompt 均不透露待读取的字符。没有上传到 Files API。

| 操作 | 直接证据 |
| --- | --- |
| 首次只读左上角橙色区数字 | Task `f1a8559b-5ef1-4579-a262-118fafd84c9c` COMPLETED，精确答案 4827，无工具调用，terminal receipt 已落库；[截图](first-image-cloud.png) |
| 固定上传期限 | 附件 `1ab4dc74-6ee1-425c-92cb-e633b665bc0a`，uploadedAt 2026-11-03T04:03:33.653Z，expiresAt 2026-11-04T04:03:33.653Z，差值 86400 秒；实际 PVC 原图 sha256 匹配，无 .part |
| 形成可压缩上下文 | 真实 UI 创建并保存 image-context-padding.txt（中性 ASCII 文本；编辑器使用 CRLF，102,300 bytes）；Task `ca982a22-5a17-4f09-98c9-e60a55ace92f` 单次 read_file 后只答 READY，COMPLETED。未修改业务代码或启动应用 |
| 真实手动压缩 | request `27d488be-985b-4b1f-b756-cafe7329e27d` COMPLETED，新增 seq14 compaction；firstKeptEntryId 7f6aa948 对应 seq13，因此 seq1–6 的原图片消息确实移出后续模型上下文；摘要不含右下角 K9R4 |
| worker 恢复 | 确认空闲后 Recreate rollout restart；旧 boot 3166bc0d-4c2b-4ebc-b24f-412b9981bc36，新 boot 69c1f3e1-96a9-4238-acb7-8af59eb20fb4，Pod UID beb6a78d-19f5-4284-8950-a65b28cc0034；Ready/imageInput true |
| 目录及原图重读 | Task `c46bcaf2-1855-4aa3-aebc-b31f459dad99` 先 read_image({})，后 read_image({attachmentId})；两条 ledger COMPLETED，工具持久化只有 catalog/reference。答案精确 K9R4，任务 COMPLETED/receipt 已记录；[截图](compacted-reread-cloud.png) |
| 不重复上传、不续期 | 压缩、worker 重建、重读、切会话后始终只有 1 条上传记录，uploadedAt/expiresAt/sha256 不变。23 条原会话 native entries 的 data:image 与 base64 匹配数均 0；对话使用 in-memory Pi session，持久化源为 DB 引用 |
| 刷新与预览 | 最终前端刷新重新登录后，未重新上传也能显示原图。metadata/content 的实际 HTTP 响应均 200 + Cache-Control private, no-store；压缩和重建后预览仍在 |
| 会话隔离 | 新会话 9c16199b-b7d4-42df-b5d0-060cd1f13b7a，Task `ec4ea2ed-f969-49e9-9534-4e93ab49291f` 对原 ID 只调用一次 read_image，实际 ledger 返回 data.error.code=AI_ATTACHMENT_NOT_FOUND，模型只回此 code；COMPLETED/receipt 已落库；[截图](conversation-isolation-cloud.png) |

脱敏身份及只读查询结果见 [cloud-safe-20261103.json](cloud-safe-20261103.json)。最终四个新 Task 全部 COMPLETED，没有新增活动 task/compaction/Run；worker 空闲。历史 b3b32518-f0ed-411e-aa85-1ecef95fbdc5 仍 RUNNING，不将其当作新占用或本轮修复。页面保留原图片会话，专用项目/中性文件/附件保留用于自然到期核验。

自然 24 小时到期为 **2026-11-04 12:03:33.653（Asia/Shanghai）**。届时须再观察认证内容 410、页面失效占位、read_image/旧成功回执不能重新发图，以及清理周期后实际 PVC 原图和 .part 不存在。此轮没有修改运行库 expiresAt、服务端时钟或线上 TTL 来提前证明清理；这些现场到期项仍 **NOT_RUN**，本地可控时钟测试的 PASS 不能代替它们。用户完整功能验收仍 **NOT_RUN**。
