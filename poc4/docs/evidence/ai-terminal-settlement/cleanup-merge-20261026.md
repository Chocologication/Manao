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

**已完成本地合并及合并后验证。** merge提交da46643295188808b3ac216ab58f5c53664b46a8，目标codex/ai-integration，双亲依次为原AI分支8d4c573a94194e8bb9aef8479ad7f2a2a8489c25和修复分支18d1247641d33b3ef120924d689f9f1601f5c20b。无冲突，修复分支完整可达。

合并树与源修复分支tree逐字一致，均为8d5d1f26dc80fbb9200a7502f6ade128372ae1f6；没有合并时临时改写产品代码。之后的本记录提交仅补文档。目标worktree验证前干净，原始8文件继续保存在私有备份及安全stash，不apply旧规划覆盖当前结果。

所有下列命令均在AI worktree执行，pnpm按锁文件安装，无依赖版本或manifest变化；backend只有一个Maven进程，数据库仅JdbcStoreTestSupport临时schema：

| 验证 | 实际结果 |
| --- | --- |
| Worker pnpm install --frozen-lockfile、test、build | 均exit0；181 passed、1个专用长驻harness显式opt-in skipped |
| 前端目标5组件首轮并行运行 | 210 passed、1 failed，exit1；既有Terminal懒加载后查找Job terminal region超时，不能称该轮全绿 |
| Terminal原失败用例单独复验 | 1 passed、81 skipped，exit0；没有改代码 |
| 同一5组件串行复验：vitest run --maxWorkers=1 --fileParallelism=false | 211/211、exit0，121.17s；未修改代码，符合异步等待在负载下超时的现象，不宣称已证明所有时序问题不存在 |
| 前端typecheck、test:boundary、build | 均exit0；boundary36/36，build成功，保留既有jsdom媒体、Vite大chunk警告 |
| backend Service全部52、Settlement选定7、Reconciler选定6 | 65/65、0 failures/errors/skipped，exit0，05:00，2026-10-26 13:37:23+08:00 |
| 临时schema只读精确核验 | 日志中74个唯一owned schema剩余0，mysql exit0；无额外删除 |
| Git结构、diff whitespace及编码 | 修复分支为目标祖先、merge双亲正确、源/合并tree一致，diff检查通过，更新文档UTF-8无BOM |

本轮未重跑最终源码全部backend测试或云端模型场景，不将定向回归称为单次全量全绿。日志保留在修复worktree的.superpowers/deploy/cleanup-merge-20261026，包含初次失败、单例复验及串行通过；未移除任何被拒绝删除的路径。

修复分支codex/fix-ai-terminal-settlement及其worktree保留，避免破坏仅本地证据和策略拒绝残留；未删除其他worktree或branch、未改master用户文件、未Git push。此前已部署镜像仍对应758aae6，这次本地merge及文档提交不重新部署集群。

既有LOCAL_REPAIR_VERIFIED及DEPLOYED_SMOKE_VERIFIED边界不变；原故障Task NOT_REPAIRED、Stage2 PAUSED/NOT_GRANTED。清理被拒绝不阻止完成独立的本地分支合并，但必须如实保留残留。
