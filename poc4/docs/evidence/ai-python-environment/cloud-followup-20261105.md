# 2026-11-05 云端后续验证

本轮用户授权完成依赖故障矩阵、UI 重载问题与完整 FastAPI 重跑、正式回滚演练；独立意外重启、自动压缩、图片与其他兼容专项明确暂缓。按[后续计划](../../../../docs/superpowers/plans/2026-11-05-ai-python-cloud-followup-plan.md)执行，原失败记录保留，完整 AI_PYTHON_CLOSED_LOOP_PASS 不因本轮部分完成而授予。

## UI 修复及连续 FastAPI

直接 workspace reload GET 原先遇到后端独占项目读锁返回 PROJECT_BUSY 即永久失败，而普通 React Query 文件读已有有界重试。实现 f58581a 将重载各 GET 分支接入相同精确 409/PROJECT_BUSY、最多四次读取策略，并在每次请求前后检查当前项目；不重试 mutation、不吞真实错误。历史 attempt 5 没有失败 HTTP trace，不能断言其具体请求；本地行为缺陷及 RED 已确认。

本地 RED 8 个预期失败，GREEN 114/114；类型检查通过。独立复审另执行 reload/retry 28、shell 定向 8、类型检查通过，结论 APPROVE。

前端 build/push/rollout 实际成功：source f58581a897af239fad66aebffcbe20c7abda0e09，index sha256:d184ddf40124865cc551d78248eb4cb0cdadb7143fa599c302a31aff88f2457d，linux/amd64 和实际 Pod imageID 均 sha256:12f2f70f9bc94a43126bae09f3ac8ba262fb73fc8227950c8de2c550cd46445c。其他产品镜像保持上一轮 55f2067 发布。

专用账号八项目均保留；复用已有 30081 项目 2bd14295-9ae0-4816-8508-80a9950816c6。先私有归档当前文件，真实模型准备任务 1676de8a-57a4-4b13-b091-7ed4411d9161 经受控工具 remove main humanize/test httpx/pytest；仅重置专用源码/测试 fixture，不手写托管文件。以准备后的 revision 32 和五文件精确 hash 准入，替代首次运行的 pristine template seed；原连续场景的全部业务、工具、revision、保留测试和资源断言不变。

完整连续 Playwright 1/1 PASS，156856ms；不重新进入页面。第一轮 53d00c6a-5fce-4a2f-84b8-e4359eeff946，revision 36；手动 compact 后第二轮 5c95e31f-2922-4b7d-a3ac-a18056d43f25，revision 38；conversation 87e4cfd9-8b80-4614-b4b9-9bc9c42d1ddd。真实 fail-first、main/test 依赖、syntax/pytest、READY/日志/同 Run GET 和第二轮均通过。公网 30081/api/demo 独立 GET 200，total=2,000。结构化工具结果及文件摘要见[JSON](cloud-followup-20261105.json)。最后 Run 0b13ff1a-ef40-4383-b905-869dd77979bb 已在验证后由 owner stop，以串行执行故障/回滚；保留项目、PVC、Run 与 receipt 历史。

## 依赖故障矩阵

进行中。仅 fault project bf51c6ac-be04-4274-9c73-43a15ea9d470；使用与实际 JAR LineNumberTable 对齐的操作者 JDI 单线程门闩，不改产品 class、数据库结果或生产默认测试开关。临时调试仅 Pod loopback，通过本机 port-forward 连接，结束恢复。场景逐项结果待补齐。

## 回滚

兼容门禁已执行，正式集群切换待故障矩阵收尾。私有当前库备份 3567603 bytes，SHA256 4AEFE09C0E1F29292242C8E0A5429AE6E55F7FB16BADEDD761649D70B2A3F2CF，恢复至独立 schema。真实旧 backend c86fda5f… 自带 Flyway 11.7.2 接受 V20，validate/migrate PASS、migrations=0、全表前后 SHA256 00d26e63886f8df3888a44aa498f57704ace0d1087f97c853fc426dfd3484e0d。

旧 runner 对真实新 main/test 锁文件副本：console exit 0 输出 10、FastAPI readiness/demo 200 且 total=2,000，全部源/依赖文件摘要不变。旧镜像 pytest build 入口不存在(exit127)；旧 agent 合法签名 GET 200、prepare-scoped test 404。正式演练因此限定旧 Java 功能维护窗口，Python/AI 不开放，随后恢复新版；不能记成旧 Python AI/test 全能力兼容。
