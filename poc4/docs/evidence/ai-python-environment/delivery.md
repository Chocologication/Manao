# AI Python 环境本地交付

2026-11-04，分支 `codex/ai-python-environment`。基线 `d0cf75f`，最终实现 `b5b02fe`；其后仅为本页等状态文档收口。Tasks 1–8 以及 Task 9 的本地验证、真实验收脚本、部署/回滚产物已交付。全分支审查及最后并发修复复审均批准，无剩余 Critical/Important，授予 **AI_PYTHON_LOCAL_PASS**。

**AI_PYTHON_CLOSED_LOOP_PASS 未授予。** 发布、运行库迁移、云 workspace 更新、真实模型/浏览器两类闭环和云故障仍 NOT_RUN。Task 9 Step 3 的部署故障矩阵和 Step 6 保留未勾选；[验收记录](acceptance.md)区分全部证据层级。

后续授权执行的当前结果见[云端记录](cloud-20261104.md)：五项发布、V20、两类 Python 核心流程与部分恢复专项已实际完成。上段是本地交付快照，完整云故障矩阵仍未闭合，闭环总标签继续未授予。

## 最新执行结果

| 范围 | 实际执行结果 |
| --- | --- |
| 最终构建、工具、存储、收尾回归 | 149 PASS，0 failure/error/skip；executor 48、project tools 45、task store 35、terminal settlement 21；在 `b5b02fe` 的最后实现上执行 |
| 兼容九套 | 86 PASS，0 failure/error/skip；真实 disposable MySQL，含调和器、会话/压缩、内部安全、worker HTTP、图片真实 Spring/Tomcat 装配/HTTP、live output HTTP；构建结算后续变更由上述 149 组覆盖 |
| Worker 全量与构建 | 266 PASS、1 SKIPPED，构建 PASS；跳过是原有 opt-in `local-terminal-harness`，未冒充通过；在最终 `version` 合同修正后执行，之后仅 backend 与文档变更 |
| Frontend | 四份相关 Vitest 155 PASS，typecheck PASS；七种 Python 状态的本地浏览器点击为 0 page errors，截图见[验收记录](acceptance.md) |
| Workspace-agent 与依赖合同 | Java 52 PASS、backend 79 PASS；真实签名 HTTP/uv 容器 35 checks PASS，涵盖 main/test 增删、旧协议、最后一项删除、不可安装和超时 |
| 依赖真实组合故障 | 1 PASS：AI services + MySQL + workspace-agent 真类/文件系统 + Docker uv；部分双文件提交和两次重建/丢回包后只解析一次、revision 只增一次；[完整证据](local-dependency-integration.md) |
| Python runner | 最终固定镜像 development 44 checks、复制竞争 2/2 PASS；未改 runtime/cache 层的前一镜像回归为 13/13、14/14，明确保留镜像边界 |
| 验收脚本 | 本地合同测试 6/6、独立 tsc PASS；真实配置没有执行，也没有用 `--list` 代替验收 |

各组有重叠，不能相加成一个测试总数；未运行全仓库所有业务测试。回归中出现过的失败及修复后重跑，均按最终通过的对应范围记录，原始日志保留于该工作树忽略的 `.superpowers/sdd/2026-11-04-ai-python-environment-implementation-plan/`。

普通 Python 和 FastAPI 均已验证到本地可信环境/工具合同、实际 uv 与锁定运行器、语法/pytest 真实失败与容器副本修复后通过、真实 MySQL 恢复、Pi SDK scripted provider 请求以及 UI fixture 层。FastAPI fixture 的健康端点测试与业务断言分别核对；仍未证明真实模型在部署系统内完成多轮编辑、启动、日志和业务 HTTP 的完整闭环。

## 本地提交清单

以下为本次实现和修复提交；未 push、merge 或部署。最后的文档收口提交在这些提交之后。

| 提交 | 内容 |
| --- | --- |
| `630bffe` | 保留已有设计、计划与导航 |
| `884db69` | Task 1，可信环境快照和启动合同 |
| `edbb74d` | Task 2，按语言的文件策略 |
| `a464736` | Task 3，受控 test 组协议与 uv |
| `4a4b0d3` | Task 4，AI 依赖工具生命周期 |
| `6e808a5` | Task 4，精确参数、durable 结果与 execution claim 修复 |
| `5b68540` | Task 5，隔离 copy/compile/pytest 运行器与真实容器验证 |
| `e06d341` | Task 6，按环境构建与 Python 证据 |
| `9edeb71` | 真实依赖双文件故障组合验证 |
| `22d2e29` | 清理恢复期间保存构建证据 |
| `6eb0559` | Task 7，worker 环境、工具、提示词与压缩 |
| `3aa73ef` | 补充迟到 Pod UID |
| `474bde7` | worker 精确 `version` 合同 |
| `5b6649c` | observe 删除前保存发现的 Pod UID |
| `7dae8c2` | Task 8，前端结果、刷新与业务投影 |
| `367a468` | 清理重试保持原终态事实 |
| `0f80538` | Task 9，真实验收、失败 fixture、发布手册 |
| `bfeb47e` | 图片装配 fixture 补齐新真实依赖 |
| `67feff6` | 验收要求同 Run 日志，修正 registry 端口示例 |
| `5a7778f` | 并发 build 的权威保存返回与首次完成 |
| `b5b02fe` | 原子完成时采用最新终态，覆盖反向交错 |

## 实施修正与下一步

构建清理会跨 drive/重启，因此增加删除前的 durable observation，并在原子完成边界选取当前终态；没有新增 schema 或通用任务框架。复审复现的正反交错均由真实 MySQL/Kubernetes mock latch 回归关闭。完成边界沿用当前单后端的 store 同步合同，不授予分布式多后端/HA 保证。

发布产物实际为四项运行时加 frontend，共五项；手册覆盖旧活动任务排空、V20 additive migration、新 scoped workspace-agent 协议、旧 Python workspace 更新、PVC 内容保留与回滚。实际执行需后续授权，入口为[发布手册](../../../deploy/ai-python-environment/README.md)和[独立 Playwright 配置](../../../frontend/playwright.ai-python.config.ts)。

清理已核对：无本次容器或新建卷残留，4173 本地 fixture 服务已关闭；剩余两个 disposable schema 的创建时间为 2026-10-29，已保留，未触碰共享或运行库。误路径生成的四个会话临时文件和空目录已删除；正式日志、截图、构建缓存及固定测试镜像保留供审阅。实施中一度误提交到主 checkout 的 runner 草稿已从 master 撤回并保存在恢复分支；master 回到 `d0cf75f`，原 `.gitignore` / `.zcode/config.json` 无关修改保留，最终实现均在指定工作树分支。
