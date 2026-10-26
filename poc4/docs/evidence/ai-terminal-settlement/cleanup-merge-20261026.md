# 2026-10-26 分批清理与合并记录

用户明确要求先分批清理本轮临时残留，再将修复分支合并回AI分支。目标为codex/ai-integration，不是master；不包含Git push或修改集群。

## 1. 清理实际结果

两批删除均在命令执行前被自动审批以blocked by policy拒绝，**实际删除0项、0文件、0bytes**。停止删除，不采用其他工具、git clean、重命名或移动方式绕过。

| 批次 | 已核对对象 | 结果 |
| --- | --- | --- |
| 1 | Temp中确属本轮的manao-pi-scratch-1xgQco、4Ui9z6、5CJwAK | 删除请求被拒绝，0删除；同类其余8个不再尝试 |
| 2 | 修复worktree内poc4/frontend/dist、poc4/pi-worker/dist、poc4/frontend/test-results | 已确认忽略目录、无tracked内容及reparse point；删除请求被拒绝，0删除 |

此前登记的11个Temp目录和browser-classes仍在，共68文件、312029bytes；根目录及其子项均无reparse point。完整路径沿用[验收记录第6节](acceptance.md#6-清理实际结果与保留项)。backend/target、node_modules和其余SDD材料未删除；后续合并验证会继续使用依赖。

保留数据库私有备份、回退基线、发布日志、核心RED/GREEN日志、审查报告和11项Rulings。修复worktree和分支保留，避免误删被拒绝目录及仅存本地的证据。此次不清理任何集群资源或数据库。

## 2. 合并前保护

- 修复分支起点9aa889a，目标AI分支8d4c573；AI分支是修复分支祖先。两个worktree分别核对，不切换或覆盖master上的用户修改。
- AI worktree有8项旧调查改动：AGENTS.md及7个未跟踪文档。7个文档Git blob与修复分支e6401cf最初导入版本逐一一致；AGENTS仅有原调查两条索引，blob也与该导入提交一致。没有额外未同步内容。
- 原始8文件已逐字备份至私有目录，并保存在Git安全stash1537cfd33e0a166ce7f541afcbfaa63b7c591e7a；备份hash逐一核对。stash只用于原始文档保护，不是删除被拒绝目录的替代手段。不要重新apply旧stash覆盖新文档。
- 目标worktree已干净，使用本地no-ff merge保留修复历史，不Git pull/push，不合入master。

## 3. 合并与验证

待本次实际合并后记录目标HEAD、双亲与内容一致性及验证结果。此处不预先宣称合并完成或测试通过。

既有LOCAL_REPAIR_VERIFIED及DEPLOYED_SMOKE_VERIFIED边界不变；原故障Task NOT_REPAIRED、Stage2 PAUSED/NOT_GRANTED。清理被拒绝不阻止完成独立的本地分支合并，但必须如实保留残留。
