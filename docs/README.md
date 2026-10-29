# 项目文档导航

先按问题选择一个入口，只阅读与当前任务相关的章节。无需把下面所有文档作为启动上下文。

## 常用入口

| 要解决的问题 | 从这里开始 |
| --- | --- |
| 当前交付到哪一步、还有哪些未完成或暂停项 | [项目进度](what-we-have-done.md) |
| 产品目标、已交付范围与非目标 | [项目目标](Manao-Projects-goal.md) |
| Project、Run、AgentTask 等术语的含义 | [领域术语](../CONTEXT.md) |
| 修改、测试、运行环境与清理的约定 | [协作与验证指南](development-guide.md) |
| 前端启动、回归与界面变更记录 | [Frontend README](../poc4/frontend/README.md) |
| POC4 验收专题、附件与早期工作台归档 | [POC4 文档导航](../poc4/docs/README.md) |
| 最近一次 AI 收尾修复的发布、回滚与旧任务处理 | [AI 收尾维护手册](../poc4/deploy/ai-terminal-settlement/README.md) |

## 专题资料（按需展开）

<details>
<summary>AI 设计与后续修改</summary>

- 选型、已确认需求与原始分期：[AI 方案评估](research/2026-10-13-ai-integration-framework-evaluation.md)。这是设计来源，当前交付状态看项目进度。
- 任务收尾、持久化回执、Run 恢复与用户结束控制：[收尾修复设计](superpowers/specs/2026-10-25-ai-terminal-settlement-design.md)。
- 阶段四暂停接管、同会话手动继续：[控制与恢复设计](superpowers/specs/2026-10-27-pi-stage4-control-recovery-design.md)，其末尾链接五任务实施计划和Agent交接；实现与已授权云端验证已完成，范围见[阶段四验收](../poc4/docs/evidence/ai-stage4/acceptance.md)。
- 多轮会话与压缩：[会话上下文设计](superpowers/specs/2026-10-19-ai-conversation-context-design.md)。
- 流式输出、思考强度与 Markdown：[输出设计](superpowers/specs/2026-10-20-ai-streaming-reasoning-markdown-design.md)。

只在执行对应任务时再读[AI 执行计划与交接目录](superpowers/plans/)中同主题、同日期的文档；该目录保留 AI 各阶段、会话上下文、流式输出、ThinkRail 及收尾修复等资料，不逐项增加导航。阶段验收、复审及实际发布证据由项目进度中的对应专题记录负责；已完成计划不作为默认待办队列。

</details>

<details>
<summary>Java / Python 运行时</summary>

- 项目端口、MySQL/Redis、应用寿命与 Maven 缓存：[Java 运行时设计](old_docs/superpowers/specs/2026-09-21-java-project-runtime-design.md)。
- Python console / FastAPI、uv 依赖编辑与恢复：[Python 运行时设计](old_docs/superpowers/specs/2026-09-25-python-runtime-design.md)。

设计、审查、实施计划与交接归档在 `old_docs/superpowers/` 下；实际结果见[Java 验收](../poc4/docs/evidence/java-runtime/acceptance.md)和[Python 验收](../poc4/docs/evidence/python-runtime/acceptance.md)。归档保留设计合同与历史边界，修改对应运行时时仍应按需查阅。

</details>

<details>
<summary>基础云环境与历史阶段</summary>

- 云环境初始化、基础组件与维护：[6B 部署手册](../poc4/deploy/6b/README.md)。
- 云端与本地联调的环境边界：[基础设施说明](Stage6-Infrastructure-Status.md)。
- 已接受的 6A 基线：[6A 当前事实](Stage6A-Current-Facts.md)；旧方案为何调整：[阶段演进记录](Stage6A-Evolution-Timeline.md)。
- AI 集成前的 POC2、POC4、6A/6B 及 Java/Python 资料：[历史计划与交接](old_docs/superpowers/plans/)、[历史设计与审查](old_docs/superpowers/specs/)。以 2026-10-13 AI 集成开始为分界归档此前的17份文档，文件名和历史结论保留；这些资料用于追溯，不作为当前执行指令。
- 早期 POC4 / EnsoAI 工作台资料：[设计与调查](old_docs/poc4/)、[实施计划](old_docs/poc4/plans/)、[阶段0–6证据](old_docs/poc4/evidence/)。共128个历史文件按原相对层级归档，验收结论、截图和原始收据保留；AI、Java、Python与6B验收仍从[POC4 文档导航](../poc4/docs/README.md)进入。

后续 AI 发布是基础环境之上的增量；具体镜像、迁移和回滚读该次发布手册，不能只重放旧的 6B 部署步骤。旧 gate、旧 FAIL 和历史环境快照都不代表当前状态。

</details>

## 文档职责与维护

| 位置 | 只记录什么 |
| --- | --- |
| 根目录 `AGENTS.md` | 每次任务都需要的少量规则，以及文档入口 |
| 本页 | 按问题导航，不复制验收或发布流水 |
| `what-we-have-done.md` | 当前交付结论、待定事项及对应证据入口 |
| `Manao-Projects-goal.md` / `CONTEXT.md` | 产品范围 / 领域定义 |
| `development-guide.md` | 按操作场景查阅的长期工作约定 |
| `research/` / `superpowers/specs/` / `superpowers/plans/` | 方案评估 / AI 设计合同 / AI 执行计划与交接 |
| `old_docs/superpowers/specs/` / `old_docs/superpowers/plans/` | AI 集成前的历史设计、审查、实施计划与交接；按主题追溯 |
| `old_docs/poc4/` | 早期 POC4 工作台设计、调查、计划及阶段0–6历史证据 |
| `../poc4/docs/README.md` | 保留的验收专题与历史资料入口，不复制验收状态矩阵 |
| `../poc4/docs/evidence/<topic>/` | 日期、验证范围、失败与实际结果 |
| `../poc4/deploy/<topic>/` | 发布身份、操作命令、迁移与回滚 |

- 可记录的变更更新其所属文档；只有入口、长期规则或职责变化才修改 `AGENTS.md`。
- 当前结论只维护在所属验收记录，进度页仅作简短摘要；测试数量、镜像 digest、任务 ID、逐次审查及清理清单留在专题记录。
- 新资料优先放入已有专题。仅当新增了常用查找问题时才补充导航，不为每次提交增加一个入口或一份状态文档。
- 链接使用相对当前文件的位置，保持随分支合并后可用；不得链接到私人配置或某个 `.worktree` 的绝对路径。
