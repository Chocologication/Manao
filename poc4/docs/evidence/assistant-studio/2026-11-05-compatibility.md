# 2026-11-05 本地兼容性检查

本页是 `d0cf75f` 基线的历史快照，包含当时未提交及 Studio V20 的状态。当前 PR 基于 `6473e9a`，保留官方 V20、将 Studio 调整为 V21；最新范围和验证见[PR 整合验收](2026-11-05-pr-integration.md)。下文历史结果不改写。

## 结论与范围

基线为本轮 fetch 得到的 `origin/master`：`d0cf75f71155553afe965bb7b39cabfd177c9960`。组合分支为 `codex/compatibility-20261105`，在该基线上保留新版 Studio、中文界面、Node.js runtime，并整合上游多账号、图片附件与上下文压缩实现。原开发分支保持原样，未 commit、push 或部署。

| 检查项 | 新前端 + 组合后端 | 新前端 + 原仓库后端 |
| --- | --- | --- |
| 登录、身份与项目列表 | PASS | PASS |
| 跨账号访问拒绝、Cookie-only 请求拒绝 | PASS | PASS |
| 旧会话 API | PASS | PASS |
| 日志 WebSocket、单次 ticket、Origin 拒绝 | PASS | PASS |
| Studio 模型保存、Key 脱敏与账号隔离 | PASS | FAILED：接口不存在，实际返回 500 |
| Studio 历史消息与 SSE 历史快照 | PASS | NOT_RUN：无 Studio 接口 |
| 桌面浏览器真实 API 登录与工作台 | PASS | PASS：新版功能不可用，需手动切回旧版会话 |
| Node.js 模板 | 本地合同与原生 runner 验证 PASS | FAILED：创建请求返回 422 |
| 真实模型生成、Kubernetes 执行与 SMTP 投递 | NOT_RUN | NOT_RUN |

浏览器使用 Edge，通过真实 Spring controller/security/store 与隔离 MySQL；没有 API 拦截，没有启动 MSW。外部 workspace 读取和集群就绪状态由受控 adapter 提供，所以该结果只证明本地应用层集成，不能替代容器、集群、真实文件修改和模型端到端验收。SSE 实测为已持久化消息的快照；增量解析另由受控流测试覆盖。

## 修复

- 本地 Studio 草稿与上游图片附件同时占用 Flyway V19：保留上游 V1–V19，将未发布的 Studio 草稿调整为 `V20__assistant_studio.sql`。
- 组合保留 `AgentAttachmentService`、`read_image`、图片上下文与 compaction prompt，同时接入 Studio proposal 和个人模型 transport；transport 与图片上下文分别释放。
- `AiConfig` 对 Studio 的强制依赖使旧 AI 模块独立装配失败：`AgentProjectTools` 和 `AgentTaskService` 改用可选 `ObjectProvider`，已有图片附件装配测试复测通过。
- SSE async dispatch 丢失鉴权上下文及响应头设置时序不当：保留初次请求的鉴权，补全对应 async/error dispatch 与提前响应头；真实 HTTP 验证 401、404、SSE Content-Type、no-store 和关闭缓冲。
- 验证码清理的 `REQUIRES_NEW` 事务可能等待被挂起调用方持有的锁：存在调用方事务时跳过本轮机会性清理，由后续独立请求清理。补充事务组合与延后清理验证。
- 模型保存请求误带只用于响应的 `keyConfigured`：显式构造 request DTO，避免严格 JSON 后端拒绝编辑模型。
- 新增 Studio 与图片错误码未进入后端白名单，被降为 `INTERNAL_ERROR`：补全固定错误码与脱敏消息，并补齐前端解析和中文提示。验证 23 种错误经过 HTTP handler 后保持 code，且不回传原始模型响应。
- 对齐中文界面与合并后的测试、fixture，修正浏览器历史会话选择器包含日期的问题。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 原仓库 backend Maven test | PASS；XML 汇总 985 项，2 skipped |
| 组合 backend 完整 Maven test | FAILED：唯一失败为旧 AI 装配缺少 Studio bean |
| 装配与错误码修复后的定向复测 | PASS；装配、HTTP 错误契约、错误脱敏及 SSE HTTP 共 4 类、18 项测试 |
| 组合 backend 各类最近一次 XML 汇总 | 1011 passed，2 skipped；跨多次运行汇总，不能标记为一次完整回归全部通过 |
| StudioCoreTest | 14 passed；模型 transport 使用受控服务 |
| V19→V20 MySQL 升级 | PASS；保留账号、项目、旧会话、会话条目、图片附件及旧 migration checksum |
| workspace-agent Maven test | PASS；58 passed，2 skipped |
| pi-worker build / test | PASS；208 passed，1 skipped |
| frontend 完整 Vitest | PASS；1768 passed |
| 最后错误码修改的前端复测 | PASS；37 passed，包含新增契约测试 |
| 最终 frontend build | PASS；包含 TypeScript 检查；保留 bundle 大小提示 |
| stage6 typecheck / 最终生产 boundary | PASS；boundary 36 passed |
| Node 原生 runner | PASS；11 passed，真实安装、编译、控制台退出、HTTP、停止和打包 |
| 全量 frontend lint | FAILED；36 errors、17 warnings；逐文件与上游比较，新增 error 数为 0 |
| 本轮最后修改的前端文件 lint | PASS |

backend skipped 为真实集群 preflight 与清理证据入口；workspace-agent 两项 symlink 测试因 Windows 环境跳过；worker 专用本地终端 harness 未启用。不得把 skipped 计为通过。本轮隔离 MySQL 使用 8.4，Flyway 保留“高于已测试 MySQL 版本”的提示；测试连接的锁等待上限设为 1 秒，未修改任何运行库。

## migration 与后续发布要求

V1–V19 与基线逐字节一致；V20 仅增加 Studio 表。数据升级测试只覆盖官方 V19→V20。如果某个本地库曾执行名为 `V19__assistant_studio.sql` 的草稿，其 history 与官方 V19 不同，本轮未迁移该库，也不能直接重命名后连接它。

以后发布时先备份数据库和凭据加密 key，核对 schema history；准备固定 digest 的 Node runner、workspace-agent、pi-worker 和 backend。Worker/agent 先具备新协议能力，再启动组合 backend 执行 V20，最后更新前端。真实环境的滚动升级和回滚尚未验证。

新增配置为稳定保存的 `MANAO_AI_CREDENTIAL_KEY`（32 bytes 的 Base64）和 `MANAO_NODE_RUNNER_IMAGE`（`@sha256:` digest）。缺少前者时模型 Key 保存返回 `AI_CREDENTIALS_UNAVAILABLE`，缺少后者时 Node 运行返回 `NODE_RUNTIME_NOT_CONFIGURED`。不能每次启动重新生成加密 key，否则旧凭据无法解密。

沿用 DB/JWT、workspace capability、backend↔worker 内部 token 和 SMTP 配置。前端构建按需设置 `VITE_ENABLE_AI=true`，不把模型 Key 放入 `VITE_*`；API/WS 保持同源代理，WebSocket Origin 与实际站点匹配，SSE 代理关闭缓冲。账号注册、邮件能力由 `/auth/options` 与后端开关决定。

Linux 镜像、Kubernetes 实际 Node 运行、真实模型、SMTP 投递及真实任务读写验收仍为 NOT_RUN。全量 lint 的既有问题也尚未处理。推送和部署分别需要后续明确授权；本记录没有授权任何远程写操作。

## 待提交范围

需要整体审阅 backend Studio 与 V20、AI wiring/security、Node 模板与运行器、workspace-agent、pi-worker transport、frontend UI/API/mock/tests/lockfile 及对应文档。新增目录尚未进入 Git 暂存区，仅提交已跟踪文件会丢失关键实现。

本地证据另保存待提交文件清单、SHA256 manifest、已跟踪文件 diff 和包含未跟踪源码的 review snapshot。凭据、MySQL datadir、node_modules、target、dist 与浏览器产物不属于提交范围。原开发源码 1246 个文件的 SHA256 和原 Git 状态核对未变化，原仓库测试副本保持 clean。
