# 2026-11-05 云端后续验证

本轮用户授权完成依赖故障矩阵、UI 重载问题与完整 FastAPI 重跑、正式回滚演练；独立意外重启、自动压缩、图片与其他兼容专项明确暂缓。按[后续计划](../../../../docs/superpowers/plans/2026-11-05-ai-python-cloud-followup-plan.md)执行，原失败记录保留，完整 AI_PYTHON_CLOSED_LOOP_PASS 不因本轮部分完成而授予。

## UI 修复及连续 FastAPI

直接 workspace reload GET 原先遇到后端独占项目读锁返回 PROJECT_BUSY 即永久失败，而普通 React Query 文件读已有有界重试。实现 f58581a 将重载各 GET 分支接入相同精确 409/PROJECT_BUSY、最多四次读取策略，并在每次请求前后检查当前项目；不重试 mutation、不吞真实错误。历史 attempt 5 没有失败 HTTP trace，不能断言其具体请求；本地行为缺陷及 RED 已确认。

本地 RED 8 个预期失败，GREEN 114/114；类型检查通过。独立复审另执行 reload/retry 28、shell 定向 8、类型检查通过，结论 APPROVE。

前端 build/push/rollout 实际成功：source f58581a897af239fad66aebffcbe20c7abda0e09，index sha256:d184ddf40124865cc551d78248eb4cb0cdadb7143fa599c302a31aff88f2457d，linux/amd64 和实际 Pod imageID 均 sha256:12f2f70f9bc94a43126bae09f3ac8ba262fb73fc8227950c8de2c550cd46445c。其他产品镜像保持上一轮 55f2067 发布。

专用账号八项目均保留；复用已有 30081 项目 2bd14295-9ae0-4816-8508-80a9950816c6。先私有归档当前文件，真实模型准备任务 1676de8a-57a4-4b13-b091-7ed4411d9161 经受控工具 remove main humanize/test httpx/pytest；仅重置专用源码/测试 fixture，不手写托管文件。以准备后的 revision 32 和五文件精确 hash 准入，替代首次运行的 pristine template seed；原连续场景的全部业务、工具、revision、保留测试和资源断言不变。

完整连续 Playwright 1/1 PASS，156856ms；不重新进入页面。第一轮 53d00c6a-5fce-4a2f-84b8-e4359eeff946，revision 36；手动 compact 后第二轮 5c95e31f-2922-4b7d-a3ac-a18056d43f25，revision 38；conversation 87e4cfd9-8b80-4614-b4b9-9bc9c42d1ddd。真实 fail-first、main/test 依赖、syntax/pytest、READY/日志/同 Run GET 和第二轮均通过。公网 30081/api/demo 独立 GET 200，total=2,000。结构化工具结果及文件摘要见[JSON](cloud-followup-20261105.json)。最后 Run 0b13ff1a-ef40-4383-b905-869dd77979bb 已在验证后由 owner stop，以串行执行故障/回滚；保留项目、PVC、Run 与 receipt 历史。

## 依赖故障矩阵

八个限定样本 PASS，独立离线审查 APPROVE；结构化原身份、文件对、journal、receipt、真实时间与证据限制见[故障 JSON](dependency-faults-20261105.json)。仅 fault project bf51c6ac-be04-4274-9c73-43a15ea9d470；使用与实际 JAR LineNumberTable 对齐的操作者 JDI 单线程门闩，不改产品 class、数据库结果或生产默认测试开关。临时调试仅 Pod loopback，通过本机 port-forward 连接；矩阵结束已恢复 backend 和该 agent 的生产参数。

| 样本 | 真实边界和结果 | Revision |
| --- | --- | --- |
| c-prepared | prepare 已生成完整 journal、PENDING 前 pause；原文件不动、无登记/receipt，安全释放 | 19→19 |
| c-prepare-inflight | 真实 helper 已启动时 pause；未登记、不提交，原文件不动 | 21→21 |
| c-pending | PENDING 登记后、commit 前 pause；保持占用，原操作提交后终结 | 19→20 |
| c-commit | pyproject 已 durable rename、lock 尚 before 时 pause；不提前解锁、原操作完成 | 20→21 |
| d-partial-restart | 同一真实部分提交点退出 agent JVM；同 Pod/PVC 新 container 从原 journal 恢复，第一文件 mtime 不变 | 22→23 |
| r-agent-pending | PENDING、源文件 before 时退出该 agent；同 Pod/PVC 重启，原操作正常完成 | 23→24 |
| r-backend-pending | PENDING 后退出 backend JVM；同 Pod 新 container，owner close 沿原 operation 收尾 | 24→25 |
| d-lost-response-repeat | 两文件及 receipt 持久后中断原 backend HTTP 请求；实际 IO_ERROR/INTERRUPTED、仍 PENDING/占用，receipt replay 后释放 | 25→26 |

已核对原 request/operation/digest、receipt SHA、源两文件的 before/after、journal bytes/mtime 未变、登记后 revision 只 +1、登记前取消不变；各任务最终释放、无未决 workspace operation。每个 scoped prepare 或 helper 断点在覆盖 durable call completion 的有界观察窗口内记录一次。重启样本的存活端观察器分别证明未重新 prepare（agent 部分提交重启）或未再启动 helper（backend 重启）；不声称已直接计数重启后全部入口。live claim 释放由真实收尾通过生产 hasLiveCalls 门禁间接证明，没有内存计数 dump。

首次 lost-response 注入尝试保留 FAILED_INJECTION：standalone debugger 全线程读取超出外部 15s 预算，门闩自动恢复、原 task/operation 正常完成，未重放。操作者工具 311ca5e 以同连接原 HIT 线程绑定修正；先 RED 后 11 组真实 JVM 自测 PASS，并独立复审，再以新 task 执行成功样本。此为真实 HTTP INTERRUPTED，不是 TCP RESET。实际 backend failed-closed 日志在旧 Pod 删除前由工具输出捕获，JSON 明确标记该 provenance，没有冒充新 Pod 日志。

这些依赖专用任务均未调用 build（各 buildCalls=0），不把 Job 缺席说成构建 cleanup 故障验收。矩阵结束全局 occupying=0、PENDING=0，development Job/Pod=0。项目/PVC/journal/receipt 均保留。独立 backend/worker 意外重启、自动压缩与图片专项仍按用户要求 NOT_RUN。

## 回滚

正式回滚和恢复演练已完成，结果为 **PASS（旧 Java 维护窗口范围）**，详见[回滚 JSON](rollback-20261105.json)。初次备份兼容门禁通过后，在关闭新准入且全局 task/operation/compact/Run 均空闲时再次备份当前库：4384124 bytes，SHA256 057c9f6e78bb9a82235ad30bfb3ea61d9257791a87a9a8c317a931ddf901a430。最新备份恢复至独立 schema；真实旧 backend c86fda5f… 自带 Flyway 11.7.2 接受 V20，validate/migrate PASS、migrations=0、全表前后 SHA256 391026757fac0359361ac934a3a6e2f2d0d1122641b1147e702804e0ac2a80ff。未恢复覆盖运行库。

旧 runner 对真实新 main/test 锁文件副本：console exit 0 输出 10、FastAPI readiness/demo 200 且 total=2,000，全部源/依赖文件摘要不变。旧镜像 pytest build 入口不存在(exit127)；旧 agent 合法签名 GET 200、prepare-scoped test 404。正式演练因此限定旧 Java 功能维护窗口，Python/AI 不开放，随后恢复新版；不能记成旧 Python AI/test 全能力兼容。

公网维护配置仅允许登录及一个专用 Java 项目，其他准入返回 503；三个平台真实切旧 digest、五个专用 Python workspace 同 Pod 更新旧 agent 并确认新 containerID，配置切回旧 runner/agent。旧 Java 真实模型 task 6f5f1476-0759-4195-9830-bf03ed8edd43 COMPLETED，changedPaths=[]；原 Maven compile/test/package exit0 且 cleanupConfirmed，应用 SUCCEEDED/exit0/真实 Hello from Manao 日志。

随后平台恢复 backend/worker/runner/agent 的上一轮正式 digest，以及本轮修复前端 12f2f70f…；五个 workspace 恢复当前 agent，Pod/PVC UID 均不变。backend/worker 在确认排空及维护准入关闭后同时启动，均 Ready；不描述成未决操作恢复或独立意外重启验收。恢复后再实测 Python task/compact/dependency/Run/file PUT 五类公网入口均503，完成核对后撤除维护配置。

独立逐项比较：八个专用工作区所有常规文件路径及摘要完全相同，原 task28/operation256/tool248 行的身份与摘要全部保留；旧 Java 烟测仅新增一个 task及其17个tool。Flyway/project 行不变，12个 PVC 身份保留，平台 image Secret 所有键精确恢复。当前 claim/subPath/PV 映射已记录；挂载不变同时依据 workspace 同 Pod UID、PVC 同 UID 的不可变性。conversation/Run/ACK 全行及 symlink 元信息未单独制作 baseline，不声称这些表做过全量逐列比较。

撤维护后页面200正常 HTML；新 Python task 2c1fab9e-4833-410d-ba91-5bd325a07e52 在 revision26 完成 syntax/pytest（1 test、0 skipped）并确认 cleanup，无源码改动。FastAPI 新 Run 13d9275b-7fe7-4c9e-8cb7-7570490198a6 使用 revision38、已 READY，公网30081返回200/total=2,000，按约保留。

## 收尾

最终核对：backend/frontend/worker 均1/1 Ready；占用task、未决operation、运行中compact、development Job/Pod均0；一个活动Run为上述保留FastAPI。V20仍唯一成功、checksum1710106007；两个本轮disposable schema已DROP，未重置运行库。JDWP环境参数和维护ConfigMap/mount均已撤除，自有13306/15005/15006转发均停止且无监听。共享6443连接未动。项目/PVC删除均0，主目录既有.gitignore与.zcode配置修改保留。

原始凭据、备份、失败注入与操作者日志保存在仓库外；临时重复Playwright文件已按hash归档后移除。当前分支本地提交保留，Git push/merge未执行。本轮三项选定范围完成；用户暂缓的第二类专项保持NOT_RUN，AI_PYTHON_CLOSED_LOOP_PASS仍未授予。
