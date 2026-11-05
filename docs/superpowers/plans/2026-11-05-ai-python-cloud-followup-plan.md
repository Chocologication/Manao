# AI Python 云端后续验证计划

范围：用户授权完成上一轮剩余事项 1、3、4；第 2 项（独立 backend/worker 意外重启、自动压缩、图片与其他兼容专项）明确不执行。依据既有环境设计、实施 Task 9 和 cloud-20261104 记录。允许本地提交、镜像发布、专用项目受控故障验证和正式回滚演练；不合并、不推送 Git、不删除共享资源或 PVC，不恢复覆盖运行库。

## Task 1: UI 文件重载修复与 FastAPI 连续验收

- [x] 追踪真实错误、重载调用链和并发读取合同，确定根因。直接重载 GET 缺少已有的 PROJECT_BUSY 有界重试；历史失败 HTTP 未留 trace，具体历史请求归因仍为推断。
- [x] 先添加有意义的失败回归，再做最小修复；保留 scope、接管和写锁保护。RED 8 failed，GREEN 114 passed。
- [x] 运行受影响测试和类型检查，独立审查并本地提交。实现 f58581a，独立复审 APPROVE。
- [x] 发布配套产物，在专用项目连续完成 FastAPI 全部原场景断言，保留失败尝试和真实模型/operation/Run 身份。复用已归档的专用项目，经受控 remove 准备失败 fixture，以完整文件摘要准入替代初次 pristine seed；核心场景断言原样保留，连续两轮 1/1 PASS，156856ms。

## Task 2: 依赖操作真实集群故障矩阵

- [x] 设计可审阅、限定 project/task/operation 的注入脚本；测试控制仅在操作者侧，不加入生产默认开关。0074355/311ca5e；JDI 真实 JVM 自测 11 组和独立复审通过。
- [x] 覆盖 commit 回包丢失、双文件部分提交、prepare/PENDING/commit 边界取消、PENDING backend/workspace-agent 重启。八个限定集群样本通过，保留首次失败注入；回包丢失传输类别为 INTERRUPTED，不声称 RESET。
- [x] 逐项核对原身份、digest、receipt、解析次数、revision、文件对及锁；禁止重放不确定 mutation。计数限定实际有界 prepare/helper 观察窗口；原 journal 摘要/mtime 保持，claim 为真实收尾门禁间接证据。
- [x] 确认最终无未决操作、占用及该任务 build Job/Pod，独立审查证据并提交。全局 occupying/PENDING=0、development Job/Pod=0；依赖任务未调用 build，不能当构建 cleanup 故障通过。

## Task 3: 正式回滚及恢复演练

- [x] 核对原 rollback tuple，备份当前库；在 disposable schema 用真实旧产物验证 V20 兼容及新依赖文件兼容。最新旧 Flyway validate/migrate0及数据摘要不变；旧 Python runtime PASS，新增 build/protocol 不支持已明确。
- [x] 检查全局空闲，关闭新入口，按手册回退配套镜像/config，保留 additive schema、文件、receipt 和 PVC。三个平台及五个专用 Python workspace 实际回退，维护只允许指定 Java 项目。
- [x] 用专用 Java 项目验证旧工具链；恢复最新发布，再检查健康和数据/文件/receipt 保留。旧 Java compile/test/package/Run PASS，恢复后八工作区及原 durable 摘要、12PVC保持；新版Python syntax/pytest和FastAPI GET PASS。
- [x] 记录每个阶段真实 digest、状态与保留资源，独立审查并提交。回滚/恢复实际imageID、旧能力限制、维护入口和比较范围见 cloud-followup/rollback-20261105；独立只读审查通过。

回滚兼容实测补充：真实旧 backend Flyway 11.7.2 在当前库的 disposable 副本上 validate/migrate PASS，执行迁移 0、全表摘要不变。旧 runner 对新锁文件的 console/FastAPI runtime PASS；旧 pytest build 入口缺失(exit 127)，旧 agent scoped test prepare 404。因此正式演练限定旧 Java 能力维护窗口，Python/AI 准入保持关闭，不将旧版本描述为支持新能力；结束恢复新版并验证。

## 验证边界

本轮完成不自动授予 AI_PYTHON_CLOSED_LOOP_PASS；被用户暂缓的第 2 类专项保持 NOT_RUN。每项结果分别记录 PASS / FAILED / NOT_RUN，不能用本地替代集群证据。保持当前成功与失败样本；专用账号已到八项目时优先复用已核对、无占用的专用项目，不删除项目以腾额度。

## 调度与交接

UI 修复可委派单独 implementer；回滚或故障准备仅做独立只读调查。所有集群 mutation 由主会话串行执行。任务共享发布身份：UI 产物先固定，故障场景结束并对账后才回滚；回滚结束恢复同一最终版本。
