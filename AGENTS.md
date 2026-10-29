# Manao Agent Guidance

## 基本约定

- 用户叙述默认简体中文；代码、命令和技术标识保留英文。先说明影响与结论，再给必要证据。
- 修改前核对当前 checkout、分支和本地改动，保留不相关修改；新实现分支放在 `.worktree/`。以当前任务指定的分支为准，不使用固定 SHA 作为永久基线。
- 前端使用 pnpm，禁止 npm；Python 使用项目隔离环境与 uv，增删依赖只用 `uv add/remove`。
- 编辑前重读文件；使用 UTF-8 无 BOM，遵守 `.editorconfig` / `.gitattributes`。patch 失败后先重读，再缩小修改或定点重写。

## 按需读取

- [项目文档导航](docs/README.md)：按问题查产品、进度、设计、证据和部署入口。
- [协作与验证指南](docs/development-guide.md)：涉及运行时/AI 合同、测试、集群操作或清理时，读取对应章节。

只读取与当前任务相关的资料；不需要启动时遍历所有链接。

## 文档维护

- 可记录的变更更新所属文档；本文件只保留通用规则和少数入口，不追加提交历史、测试数量、镜像、逐项验收或发布流水。
- 当前结论由对应验收记录负责，进度页只作摘要；新阶段和范围扩展按本次任务约定，旧计划和历史授权不自动成为当前指令。
- 文档链接使用仓库内相对路径，不能依赖私人配置或特定 `.worktree` 绝对路径。

## 操作边界

- Workspace 写操作结果不确定时，先核对 durable receipt、operation ID 和 digest，再决定是否重试。
- schema-reset 测试只用 disposable schema，禁止重置 `manao_poc4` / `manao_poc4_6b`；运行资源清理必须限定 project 和 owner，不能删除平台 MySQL PVC。
- 不提交密码、token、私钥、原始 kubeconfig 或未脱敏 trace；清理先核对路径与归属，保留未解决问题的必要证据。
- 验证与修改范围相称；区分实现、局部测试、部署和用户验收，保留 PASS / FAILED / SKIPPED / WAIVED_BY_USER / NOT_RUN / NOT_REVERIFIED 的原意。

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
