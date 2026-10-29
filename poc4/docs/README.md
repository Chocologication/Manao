# POC4 文档导航

当前产品交付结论由[项目进度](../../docs/what-we-have-done.md)汇总，设计、开发和维护入口见[项目文档导航](../../docs/README.md)。本页只索引验收专题及附件，不维护第二份状态矩阵。

## 验收与专题证据

| 主题 | 入口 |
| --- | --- |
| AI 阶段一：代码修改与构建测试 | [验收记录](evidence/ai-stage1/acceptance.md) |
| AI 阶段二：应用反馈及失败诊断 | [验收记录](evidence/ai-stage2/acceptance.md)、[既有诊断归档](evidence/ai-stage2/archive-20261016/README.md) |
| AI 阶段三：实际 CRUD 使命确认 | [用户确认](evidence/ai-stage3/acceptance.md) |
| AI 阶段四：暂停接管与手动继续 | [验收记录](evidence/ai-stage4/acceptance.md) |
| AI 任务收尾、关闭、恢复与故障专项 | [验收记录](evidence/ai-terminal-settlement/acceptance.md)、[关键云端故障](evidence/ai-terminal-settlement/cloud-faults-20261027.md) |
| AI 多轮会话、上下文压缩及用量 | [验收记录](evidence/ai-context/acceptance.md) |
| AI 流式输出、思考强度与 Markdown | [验收记录](evidence/ai-output/acceptance.md) |
| AI 项目准入 | [验收记录](evidence/ai-project-access/acceptance.md) |
| AI 工具与构建预算 | [验收记录](evidence/ai-task-budget/acceptance.md) |
| AI 界面、截图与发布附件 | [附件目录](evidence/ai-ui/)、[前端记录](../frontend/README.md) |
| Java 运行时与 Maven 缓存 | [验收记录](evidence/java-runtime/acceptance.md) |
| Python 运行时、恢复与依赖编辑 | [验收记录](evidence/python-runtime/acceptance.md) |
| 6B 云工作台 | [验收记录](evidence/stage-6b/acceptance.md) |

各专题记录中的 PASS、FAILED、SKIPPED、WAIVED_BY_USER、NOT_RUN 和 NOT_REVERIFIED 保留原有范围。附件的日期、镜像、Task/Run 身份与验收时点一起解读，不能把历史结果视为当前部署实测。

## 早期工作台历史资料

2026-10-29 将128个早期文件归档到 `docs/old_docs/poc4/`，文件名与相对层级保持一致：

| 归档范围 | 入口 |
| --- | --- |
| 原根目录7份设计、调查与MVP结果 | [历史资料](../../docs/old_docs/poc4/) |
| 原 `plans/` 下10份阶段0–6实施与修复计划 | [历史计划](../../docs/old_docs/poc4/plans/) |
| 原 `evidence/stage-0` 至 `stage-6` 的111份结果、截图、日志与收据 | [历史证据](../../docs/old_docs/poc4/evidence/) |

历史6A结果的现行汇总仍是[6A当前事实](../../docs/Stage6A-Current-Facts.md)，阶段决策演变见[时间线](../../docs/Stage6A-Evolution-Timeline.md)。原始成功、失败和未验证边界不因归档改变；旧计划不是新任务授权。

## 新测试产物

早期浏览器测试 `spike.spec.ts`、`stage1.spec.ts` 至 `stage5.spec.ts` 的新截图使用 `testInfo.outputPath(...)`，写入本次测试独立输出目录（默认 `poc4/frontend/test-results/`），不写回历史证据目录。需要长期留存时按实际场景审核后归档，不自动覆盖已有验收附件。
