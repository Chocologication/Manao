# AI 对话工作台与 Node.js 整合验收（2026-11-05）

本轮在 `master@6473e9a17634ee3177105fdd8f43e3e0945f9154` 上整合新版 Studio、中文界面和 Node.js runtime，保留上游 Python 环境、依赖工具、图片附件与上下文压缩能力。交付分支为 `codex/studio-node-compatibility`，通过 fork 向 `Chocologication/Manao:master` 提交 PR；不部署、不合并 PR。原开发 worktree 的 1246 个源码文件及 Git 状态保持不变。

此前基于 `d0cf75f` 的 HTTP/浏览器兼容性结果见[历史记录](2026-11-05-compatibility.md)，不能计作当前组合已重新执行的真实集成验收。

## 交付行为

- 同一会话发送前选择聊天/任务，支持主区域与右侧面板切换、增量消息、Markdown、停止生成及草稿保留；工具过程默认折叠，结果展示变更与验证。
- 代码审阅默认按文件接受/拒绝，展开后可逐块选择；支持切换自动应用。聊天只开放目录、文件和日志读取。
- 用户可配置个人 OpenAI 兼容 API 地址、Key 和模型；Key 在 backend 加密保存，响应脱敏，Worker 使用本次任务的模型配置。
- 增加 JavaScript / TypeScript 控制台和 Web 四种 Node.js 24 模板，模板安装、编译、测试、运行和打包使用 pnpm 10.33；保留 Java、Python 模板。
- backend/worker 的可信环境协议支持八模板，持久化环境及 SHA256；Node 使用独立 `node-v1` 文件策略、镜像和项目缓存，保留 Python managed files 保护。
- Studio 应用任务继承原任务的可信环境；审阅模式禁止直接调用 `python_dependencies` 修改项目。构建 overlay 按当前语言检查路径，拒绝跨语言文件和 Python managed files。
- Python 应用验证要求真实 `pytest` PASS、完整报告及有效测试，不能仅凭进程 exit 0 标记验证通过。

## 迁移与兼容

已发布的 V1–V20 Git 内容保持不变，包括上游 `V20__agent_project_environment.sql`。未发布的 Studio migration 调整为 `V21__assistant_studio.sql`。升级测试覆盖官方 V20→V21，保留账号、项目、旧会话、会话条目、图片附件、任务环境 JSON/hash 及旧 migration checksum。

曾执行本地 V19/V20 Studio 草稿的数据库不在本轮迁移范围内，不能直接连接新 backend。未来部署前需备份数据库及稳定的 `MANAO_AI_CREDENTIAL_KEY`，核对 Flyway history；Node runner 使用 `MANAO_NODE_RUNNER_IMAGE` 的固定 digest。配置与启动见[Studio](../../assistant-studio.md)及[Node.js](../../node-runtime.md)。

## 当前分支验证

| 检查 | 结果与范围 |
| --- | --- |
| backend 默认 Maven test 类 | PASS：116 类完整覆盖，各类最终 XML 合计 1101 passed、2 skipped、0 failures/errors；分批运行，非一次完整运行全绿 |
| V20→V21 MySQL 升级与环境保留 | PASS：`StudioUpgradeMigrationTest`，包含已发布 migration checksum 与环境 JSON/hash 保留 |
| frontend 完整 Vitest | PASS：105 files，1816 passed |
| frontend build/typecheck、生产 boundary | PASS；保留 bundle size 提示 |
| Studio 桌面浏览器 | PASS：Edge，7 条 mock 流程；模型与 Workspace 受控 |
| pi-worker build / 完整测试 | PASS：297 passed，1 skipped |
| workspace-agent 完整 Maven test | PASS：61 passed，2 skipped |
| Node 原生 runner | PASS：11 passed；真实安装、编译、运行、HTTP、停止及打包 |
| Python 验收脚本 contract / typecheck | PASS：9 项 contract；新版入口适配 typecheck 通过，真实云流程未运行 |
| `AgentTaskPanel` lint 与 master 对比 | FAILED：1 error / 2 warnings，与 master 相同；不声明全量 lint 通过 |
| 提交范围审计 | PASS：无冲突标记、可疑明文凭据、BOM、生成/私密目录及 diff whitespace 问题；原源码/状态未改 |

backend 最初完整运行被用户暂停，已完成 92 个类；恢复后补跑未完成类并复测最终修改，共运行 36 个类，exit 0。两处旧断言分别补齐 V20 新增 nullable 环境列，以及已确认 cleanup 后 ledger COMPLETED 的合同（任务仍 FAILED、exitCode 仍 null）。最终 116 类报告无遗漏，36 个最终复测报告均来自恢复后的运行；不将暂停前的失败或未完成结果记作 PASS。

backend 使用本地 MySQL 8.4 的随机 disposable schema，不连接或重置平台运行库；Flyway 保留高于其已测试 MySQL 版本的提示。backend 默认套件不包含单独启用的 `*IT` 集成测试。workspace-agent 两项 symlink 测试因 Windows 跳过，worker 的本地终端 harness 未启用；skipped 不计为通过。

浏览器覆盖增量消息/Markdown/草稿、两种布局、按文件及逐块接受/拒绝、停止生成、模型配置/附件和自动应用后继续聊天。与 backend 的单元/HTTP 测试分开计量，不将 mock 工具调用记为真实集群执行。

## 保留的验证边界

当前组合的真实模型、SMTP 投递、Linux 镜像、Kubernetes Node 执行及完整真实任务读写/收尾为 **NOT_RUN**。上游 Python 云验收按其[原记录](../ai-python-environment/final-verification-20261105.md)保留历史结论，不扩大到当前 Studio/Node 组合。发布顺序、运行库迁移、滚动升级与回滚需在后续明确授权的部署阶段验证。
