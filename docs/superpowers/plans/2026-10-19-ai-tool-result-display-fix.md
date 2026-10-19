# 文件工具结果展示修复

## 范围与约束

用户实际浏览器发现 `read_file` / `list_files` 展开后显示 `Result unavailable`。已有 owner-scoped 结果请求成功，历史复用了只支持 application/app_http_get/build 的展示器；文件工具成功和错误都被兜底文案遮住。

修复复用现有安全结果 API，按字段展示 `read_file` 的 path/content/sha256、`list_files` 的 directory/entries/hasMore 和同一遗漏分支的 `write_file` path/sha256。代码、路径及工具错误按文本展示；仅消费明确字段，未知附加字段不透传。空内容/空目录有明确状态，列表截断和畸形结果不能伪装成功。保留现有 application/HTTP/build 展示、原 task 身份、会话作用域及异步隔离；不新增接口、依赖、持久化或模型调用。

## Task 1：测试、最小修复与独立审查

1. 先增加真实组件回归测试，覆盖文件读取的中文/HTML字面量、目录项目/空目录/hasMore、写入确认、已结算工具错误及畸形结果；历史入口覆盖原 task 详情读取。运行确认期望内容缺失的行为 RED，不能以编译/夹具错误代替。
2. 最小实现文件工具展示及错误状态。优先在现有 ToolResultView 内实现；仅在实际可读性需要时提取小组件。展示明确的字段，不直接 stringify 整个结果。
3. 运行新增测试及现有相关 AI 组件/契约整合回归一次，执行 `pnpm build`（含 typecheck）、`git diff --check` 和 UTF-8 无 BOM 检查。无代码变化/疑点不反复扩测。
4. 独立规格与质量审查，修复并复验受影响范围后提交；保留有效 RED/GREEN 命令、计数、审查结论。

## Task 2：前端发布与真实历史验证

沿用用户本会话的集群发布授权，核对实时 context/namespace/镜像，只重建/push/rollout frontend；backend/worker/数据库无需变更。不 Git push/merge、不删除项目、不发模型请求。

发布后在用户指定项目的既有会话展开 read_file/list_files，确认返回内容可见而非 unavailable；保存不含凭据的截图。更新 AGENTS、Progress、context acceptance/review 和 release guide，区分本地测试、浏览器、镜像发布、迁移/重启（本轮不需要）与清理状态。

## Outcome (2026-10-19)

- Task 1: complete; commit 13d8d1e; RED 18 failed / 8 passed, GREEN 26/26, related regression 111/111, pnpm build passed; independent spec/quality review Approved with zero findings.
- Task 2: complete; frontend digest sha256:738c3c73d4201cc2d2e67b9eb8e8209f5d63a0518fc88ab9e0292d8893c082cb rolled out to manao-stage6b; original list_files and read_file results displayed from persisted history after reload.
- No backend/worker/schema changes or model calls. No migration was needed. Existing project and resources retained; no Git push/merge.
