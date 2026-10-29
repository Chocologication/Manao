# 项目进度

更新：2026-10-29。按用户要求，将 `codex/ai-integration@e1da794` 的实现、验收记录及文档归档以单父提交同步到 `master`，保留 master 原有 IDEA 配置；不创建 merge 提交，AI 分支和工作树继续保留。以下是已记录的交付结论，不是本次重新执行的集群检查。

## 当前结论

- 云工作台、Java 和 Python 已按各自验收范围交付；旧 6A/6B gate 和已完成计划不再是默认待办。
- AI 已交付代码修改/构建测试、应用反馈、多轮会话、上下文压缩及展示改进。阶段一已通过；阶段二工程验收仍为 **PAUSED / NOT_GRANTED**；阶段三由用户确认实际 CRUD 使用已完成使命。
- 2026-10-26 收尾修复已本地审查、实际部署并完成一次最小真实模型/浏览器验证：**LOCAL_REPAIR_VERIFIED / DEPLOYED_SMOKE_VERIFIED**。修复分支先合回 AI 分支，现随 AI 集成内容同步到 master；原发布和验证边界保持不变。
- 阶段四本地实现及已授权云端发布、真实模型验证完成，授予 **PI_STAGE4_CONTROL_RECOVERY_PASS**：暂停后安全接管、保存修改后同 conversation 新 Task、浏览器重进及 Worker 异常核对后手动继续通过。范围见[阶段四验收](../poc4/docs/evidence/ai-stage4/acceptance.md)。
- 原故障 Task 仍为 **NOT_REPAIRED**，其处理与阶段二验收按用户决定暂缓。2026-10-27 关键云端故障专项已完成；这些结果不授予阶段二、完整云端故障矩阵或整个 AI 首版 PASS。

## AI 专题交付

每行只保留结论和一个证据入口；精确提交、测试数量、失败轮次、镜像、任务身份与后续操作见对应记录。

| 专题 | 已记录结果与边界 | 证据入口 |
| --- | --- | --- |
| 阶段一：代码/测试修复闭环 | 2026-10-15 真实模型、浏览器与集群验收通过，授予 `PI_STAGE1_CODE_TEST_LOOP_PASS`；后续 revision-cache 修复的验证边界单列于 §8.7 | [阶段一记录](../poc4/docs/evidence/ai-stage1/acceptance.md) |
| 阶段二：应用反馈 | 已实现并部署；历史主场景失败、浏览器 main/close 与独立资源证据未闭合，验收暂停。后续 operator 样本不能替代原失败 | [阶段二记录](../poc4/docs/evidence/ai-stage2/acceptance.md) |
| 阶段三：书籍 CRUD | 2026-10-19 用户依据实际 CRUD 使用确认使命完成；不默认再安排独立实现轮次，不替代阶段二工程验收 | [用户确认](../poc4/docs/evidence/ai-stage3/acceptance.md) |
| AI 任务收尾修复 | 2026-10-26 发布三组件及 V15/V16，一次最小真实任务完成、回执/ACK 对齐并释放写占用；完整云端 A–N 故障矩阵未执行，原故障 Task 未修复 | [收尾验收](../poc4/docs/evidence/ai-terminal-settlement/acceptance.md) |
| 关键云端故障专项 | 2026-10-27失败、手动结束、backend重启及Worker丢失/真实期限四类场景PASS，KEY_CLOUD_FAULTS_VERIFIED；不代表完整矩阵 | [专项记录](../poc4/docs/evidence/ai-terminal-settlement/cloud-faults-20261027.md) |
| 阶段四：接管与手动继续 | 本地实现、定向测试及已授权云端三条链完成，PI_STAGE4_CONTROL_RECOVERY_PASS；继续使用同会话新 Task、新预算和最新已保存 revision | [阶段四验收](../poc4/docs/evidence/ai-stage4/acceptance.md) |
| 多轮会话、压缩、工具结果与用量显示 | 已实现、审查、部署；真实多轮/隔离/手动压缩通过，工具结果与用量圈经既有历史回放验证；云端 75% 自动压缩触发仍 NOT_RUN | [上下文记录](../poc4/docs/evidence/ai-context/acceptance.md) |
| 流式输出、思考强度与 Markdown | 已发布并验证四档实际 provider 参数；high/off 检查点和有界 max 续跑通过，组合 round2 仍 FAILED，low 流式时序 UNVERIFIED | [输出记录](../poc4/docs/evidence/ai-output/acceptance.md) |
| 项目准入 | 已移除单项目试点限制；保留 owner/READY/revision/occupancy 检查，不改变阶段二结论 | [项目准入记录](../poc4/docs/evidence/ai-project-access/acceptance.md) |
| AI 工具预算 | 已发布 180 次工具调用 / 20 次构建上限，1800s 任务期限不变；不等于应用寿命 | [预算记录](../poc4/docs/evidence/ai-task-budget/acceptance.md) |
| Cloud IDE 与 AI 展示 | master UI 已同步进 AI 分支；ThinkRail、用量圈及 2026-10-21 登录/洞察文案已按记录发布，详细回归和发布入口归前端文档 | [前端记录](../poc4/frontend/README.md) |

## 工作台与语言运行时

| 专题 | 已记录结果与边界 | 证据入口 |
| --- | --- | --- |
| 6A：真实后端/Kubernetes MVP | 用户于 2026-09-17 验收，2026-09-18 合入 master；MVP PASS 不包含原完整 PTY/audit/stress/fault matrix | [6A 事实](Stage6A-Current-Facts.md) |
| 6B：单用户云工作台 | 2026-09-20 验收、关闭并合入 master；云端生命周期、持久化、维护与定向删除通过，条件未触发的故障项仍为 SKIPPED | [6B 验收](../poc4/docs/evidence/stage-6b/acceptance.md) |
| Java 运行时与 Maven 缓存 | 已部署验收，2026-09-25 合入 master；正式 7200s 案例 WAIVED_BY_USER，历史 DELETING 留项待操作决策，不能由旧记录推断当前残留 | [Java 验收](../poc4/docs/evidence/java-runtime/acceptance.md) |
| Python、依赖恢复、镜像源与批量导入 | 2026-09-27 初始云验收通过，后续修复/镜像源/批量导入已发布，2026-10-12 经用户验收合入 master；7200s 案例 SKIPPED，镜像源轮保留既有依赖面板竞态和 deferred minors | [Python 验收](../poc4/docs/evidence/python-runtime/acceptance.md) |

早期 0–5 阶段和 6A 方案调整仅作历史来源，不重新作为当前执行步骤；从文档导航的“基础云环境与历史阶段”按需查阅。

## 最近一次整合与清理

2026-10-29，用户授权将 AI 集成内容同步到 master 并推送远端。内容来源 `e1da794a94166ddd7ca0abdeed5f1a30cbb607bd`，master 父提交 `77f543e8f659267e8a6902ddf811cdb1b44b3cc2`；采用普通单父提交保留 master 历史和独有 `.zcode/config.json` 配置，不导入 AI 分支提交拓扑。另清除一处源脚本尾随空格并更新本页当前状态；实际 Git 推送结果独立核验，不以源码同步扩大阶段验收结论。

2026-10-29，按用户要求将 `codex/pi-stage4-control-recovery@2423fa6` 整合到 AI 分支；先逐字备份原文档，仅对6份重叠文件提交保护快照，保留导航整理与第三项故障证据。阶段四旧临时产物重试删除成功：53文件、4,066,190 bytes及4个目录；必要云端日志、备份和源 worktree 保留。合并与本次回归由[阶段四记录第8节](../poc4/docs/evidence/ai-stage4/acceptance.md#8-2026-10-29-本地清理重试与-ai-分支整合)负责；未 Git push 或合入 master。

2026-10-26，`codex/fix-ai-terminal-settlement` 通过 `da46643` 合并到 `codex/ai-integration`，源/合并树一致，定向合并后回归通过。最初一次前端异步超时和后续串行通过均保留，不能称单次全量全绿。

两批本地删除请求均在执行前被策略拒绝，实际删除 **0 项 / 0 文件 / 0 bytes**；修复 worktree、分支和必要诊断证据保留，旧保护 stash 不应重新 apply 覆盖当前结果。准确路径、验证与保护措施见[整合及清理记录](../poc4/docs/evidence/ai-terminal-settlement/cleanup-merge-20261026.md)。该次本地整合没有重新部署集群，也未恢复原任务或删除运行资源。

<a id="next-work"></a>

## 后续工作的边界

- 阶段四已按验收范围完成；本次将已有实现同步到 master 并按授权推送，不重新部署或调用模型。原故障 Task 恢复、阶段二验收继续暂缓，新语言/功能按后续明确范围执行。
- 不自动重跑已完成的阶段三，不由一次收尾冒烟推断阶段二 PASS；Go/TypeScript 不是 AI 的前置任务。
- 产品目标、领域术语、设计/计划和发布维护入口统一从文档导航查找；精确操作遵循对应发布手册，不重放旧 continuation 身份或可能已应用的写操作。
