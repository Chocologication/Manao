# Python 运行环境实施交接提示词

以下正文可直接交给实施 agent。对应 2026-09-25 自审修订版 r2；这是执行交接文本，本文件的编写不代表功能已实施。

---

你负责实施 Manao 的 Python 运行环境适配。请直接开展实现，遵循下面的目标和当前修订后的设计，不重新规划已经确定的产品范围。

## 目标

在已交付 Java 运行环境上增加 Python 普通程序、FastAPI Web 服务及最小 uv 依赖增删入口，完成浏览器编辑、执行、反馈、再次修改和项目回收闭环。

## 工作区和依据

使用已存在的专用工作树：

```text
D:\DeepLearning\MyProjects\Project_Manao\.worktree\python-runtime
```

分支：`codex/python-runtime`。代码基线为 `06e81338`，包含 Java 集成 `ef1b5bb`；初版文档提交为 `9b4f33f`，但它不是最新方案内容。以工作树磁盘上的 **r2 修订版**为准，不能只从旧提交读取计划。若 r2 文档尚未提交，保留这些已授权的输入，可先单独提交文档再实施；不要 reset、覆盖，或创建一个遗漏修订的新工作树。存在未说明的业务代码改动时先检查归属，避免覆盖。

开始前依次阅读以下文件，均相对于上述工作树：

1. `AGENTS.md`
2. `CONTEXT.md`
3. `docs/old_docs/superpowers/specs/2026-09-25-python-runtime-design.md`
4. `docs/old_docs/superpowers/plans/2026-09-25-python-runtime-implementation-plan.md`
5. `poc4/docs/evidence/java-runtime/acceptance.md` 的当前结论与限制

实施计划定义任务顺序与验证，设计定义产品行为和协议。用源码核对接口，不把历史报告当本轮测试结果。保留主目录以及其他工作树的无关改动。

## 必须采用的实施顺序

按 r2 的 **Task 1 → 2 → … → 11** 顺序实施，遵循superpower技能要求，也不并行修改共用文件。

- Task 1–6：先交付固定模板、兼容策略、公共监督器、Python runner、Run/Job 接入和运行页面闭环。
- Task 7–9：再交付 agent 依赖编辑、持久操作核对、浏览器增删和刷新后仍可达的恢复入口。
- Task 10–11：集中准备发布与独立云端验收。

增量 A 的实现和定向检查通过后继续增量 B，不把它变成额外的整套生产部署 gate。没有真实测试环境时记录对应 NOT_REVERIFIED，继续可独立完成的开发；不能用 mock 宣称真实浏览器闭环通过。

## 本次审查后确定的关键约束

1. **复用已有运行路径。** Java 与 Python 共用项目、Run/Job、日志、停止、到期、端口和清理模块；仅增加固定模板/profile 差异。不要新增 LanguageProvider 平台、第二套监督器、用户应用 Deployment 或自动重试框架。
2. **依赖操作只传必要摘要。** agent 只有 prepare/commit：生成结果持久化在 agent journal，prepare 只返回 operationId、请求摘要和前后摘要。commit 引用该结果；首次与中断后的核对共用同一实现，不把两文件正文发给后端再发回，不另造 apply/recover 流程。
3. **操作身份贯穿用户请求。** 浏览器在首次 POST 前生成并保留 operationId；同 ID 不同请求拒绝。COMMITTED 仍可查询，成功响应丢失不导致第二次 uv 或第二次 revision。无记录只能表示 UNCONFIRMED，不能自动重发原修改请求。
4. **恢复入口要真的可达。** 在 ProjectRoutePage 的指定失败状态页和项目卡提供入口，刷新后仍能核对原操作；不能把唯一恢复按钮藏在只有 READY 才能进入的工作台。其他失败原因及 DELETING 不得被这条恢复路径放开。
5. **复用现有锁和持久协议。** ProjectLifecycleGate 已可重入，读取已经 gated；只补未决操作检查。双文件 journal、PENDING、receipt 与一次 revision 提交必须保留。普通提交与核对提交共用事务代码，存储方法不接收 uv/包名等语言细节；不扩成通用批事务系统。
6. **兼容真实数据，不保留多余内部接口。** 旧项目、旧 Run JSON 和 Java 行为必须兼容；内部构造方法根据实际调用更新，不为少改测试永久保留两套 API。
7. **测试复用。** 公共监督器状态机用现有生命周期测试；Python 补真实 uv/Python 启动、readiness、日志、安装超时、停止和派生进程终止。不要复制第二份仅换语言名称的公共故障矩阵。
8. **缓存保持简单。** 模板依赖预置、项目私有下载缓存和每 Run 独立 venv 保留；首版只维护当前固定工具链/平台的 seed，不建设跨版本缓存升级框架。

## 产品及实现边界

- 首版模板为 `python-console` 和 `python-fastapi-web`；固定入口 `main.py` 与 `app.main:app`，Python 3.13、uv、单 Uvicorn 进程，不 reload。
- 普通程序总预算 1800 秒；Web 启动预算 1800 秒，首次 ready 后 7200 秒。异常后由用户手动启动新 Run，不能自动续期或重跑。
- MySQL 使用项目独立 PVC，停止/失败/再次运行保留数据；Redis 保持非持久缓存语义。公网端口用户手填 30000–31000，冲突要求用户修改，不自动换号；容器端口只限制为合法的 1–65535。
- Python 依赖只用 uv add/remove；运行按 lock 同步到隔离 venv。前端用 pnpm，不用 npm；不使用 pip 或 uv pip。
- 公共 PyPI wheel、主依赖包名和可选精确版本是首版支持边界。20 秒解析预算是可配置的工程初值，按真实测量与传输预算协调调整，不当成已确认性能承诺。
- Go、TypeScript、AI、Notebook、GPU、任意命令/镜像和新终端能力不属于本次实现。

## 工作方法和验证

逐任务阅读当前源码 → 写有行为意义的失败测试 → 运行确认失败原因 → 最小实现 → 定向验证 → `git diff --check` 与编码检查 → 聚焦提交。文档使用 UTF-8 无 BOM，shell/Docker 入口遵循 LF 策略；编辑前重新读取当前文件。

API/工具用法需要时通过 Context7 核对当前资料。遵循 Superpowers executing-plans、TDD 和 verification-before-completion；不要把流程变成每个小步骤都重新征求批准。遇到真实阻塞先说明影响和证据，并完成不受阻塞的已授权工作。

数据库测试只使用一次性 schema，不重置 `manao_poc4` 或 `manao_poc4_6b`。不打印密码、token、私有配置或原始敏感日志。资源回收按本次 owner/project 精确核实；不处置历史 DELETING 诊断，不以 Forbidden/Unknown 当作不存在。

本提示词授权实施与必要的开发验证。发布或共享集群变更沿用实施会话已有授权；如果尚无授权，先完成镜像、迁移和可审查部署清单，在最终发布步骤说明具体动作后再请求确认。不要仅因读到旧 Java/6B 的授权记录就推断本轮已经允许发布。

正式 Python 7200 秒验收单独记录，历史 Java 的 WAIVED_BY_USER 不自动沿用。真实云端验收通过公网浏览器路径，记录实际 commit、镜像、Run/项目身份和回收结果；未测、失败、跳过、用户豁免明确区分。

## 第一项动作与交付

先执行只读工作区核对：

```powershell
Set-Location 'D:\DeepLearning\MyProjects\Project_Manao\.worktree\python-runtime'
git status --short --branch
git log -3 --oneline
git diff --stat
```

核对计划包含 r2 标识和 Task 1–11 后，从 Task 1 的失败测试开始。不要停留在复述计划。

最终交付实现及聚焦提交、执行过的定向检查、版本与部署清单、真实验收记录或明确未执行项，以及本次测试资源的实际回收/保留情况。未完成的验证不能改写为 PASS；未得到完整证据时不能宣布 Python 阶段全部完成。
