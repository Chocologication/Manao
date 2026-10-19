# AI 多会话上下文：发布与验收准备

2026-10-19：仅本地实施/验证和发布准备。**未授权执行本轮模型调用、镜像push、运行库迁移、rollout/restart、Git push/merge或项目删除。** 下列命令均为后续获得明确授权后的模板，不是已执行结果。[本切片证据](../../docs/evidence/ai-context/acceptance.md)拥有实际结果，原[Stage2发布](../ai-stage2/README.md)拥有历史digest；历史镜像不能填入本次产物栏。

## 1. 构建和不变身份

| 组件 | 已验证源码 | 构建/发布状态 | 本切片digest |
| --- | --- | --- | --- |
| backend | `72b75ed`包含Task1–5；无后端后续变更，最终打包仍需记录最终提交 | NOT_BUILT / NOT_RUN | 未生成 |
| pi-worker | `7a7976d`包含deadline边界修复；Pi三包1.2.0 | NOT_BUILT / NOT_RUN | 未生成 |
| frontend | `72b75ed`包含UI；Task6仅补测试/入口，构建需 `VITE_ENABLE_AI=true` | NOT_BUILT / NOT_RUN | 未生成 |

runner、workspace-agent、initializer、共用NetworkPolicy没有本切片重建需求。发布者从最终审查的完整SHA构建，记录source SHA/tag/构建命令/测试报告/实际RepoDigest；tag不可代替digest。当前并未构建或推送三镜像。

```powershell
# cwd: repository root；先填最终已审查提交和release标识，不直接运行占位符
git rev-parse HEAD
git status --short
docker build -t chocologic/manao_images_repository:ai-context-backend-<release> poc4/backend
docker build -t chocologic/manao_images_repository:ai-context-worker-<release> poc4/pi-worker
docker build --build-arg VITE_ENABLE_AI=true -t chocologic/manao_images_repository:ai-context-frontend-<release> poc4/frontend
# 获授权后才push这三个确切tag，并逐个记录实际RepoDigest。
```

backend标准多阶段 `dependency:go-offline` 曾在历史发布未完成，不能借历史fallback声称本次成功。如确需fallback，另记jar SHA256/源码/已核查runtime digest、USER/ENTRYPOINT/JVM参数；必须保留 `-Djdk.httpclient.redirects.retrylimit=1` 与 `-Djdk.httpclient.disableRetryConnect=true`。

## 2. V12→V13 和回退前置条件

仅增加两表和nullable conversation_id。**运行库升级、备份恢复、包大小核验均NOT_RUN。** disposable升级/旧代码预演见证据§5，不冒充运行库。

1. 实时确认context/namespace、目标schema、当前migration history和真实imageID；不能依据旧快照。先完成备份及disposable恢复证明，保存V1–V12 history/checksum/schema与旧task/tool关键字段快照；核查迁移账户ALTER/CREATE/INDEX/FK权限、空间及实际Flyway配置。
2. 核对MySQL `max_allowed_packet` 覆盖2MiB UTF-8 entry参数、SQL和协议开销（建议核查8MiB或更高并以边界数据实测）；不自动改全局值。核对worker↔backend Service全链真实sidecar/proxy请求限制覆盖4MiB，旧calls/progress保持512KiB。浏览器512KiB响应上限和nginx请求body limit是不同限制。
3. 小维护窗口先阻止新task/compact准入，确认现有调用安全结算。`MANAO_AI_ENABLED=false`会关闭beans/internal routes，不是无损排空开关，不能直接破坏在途回调。保存三个Deployment的replicas/strategy/JVM参数及旧digest，不输出Secret。
4. backend/worker单实例Recreate，确认旧Pod退出，再部署配套新版本，frontend最后。核对实际Pod UID/imageID、单副本、健康和V13只应用一次；旧表值不变、旧task conversation_id为空。MySQL DDL非事务性，失败先查实际表/索引/history，禁止盲重试/repair。
5. 旧应用回退保留新增表/可空列和V13 history，不删会话/历史。Flyway11.7.2默认忽略future migration且validate开启，本地旧代码已预演；实际环境若覆盖ignore规则可能阻止启动，不能现场禁用validate掩盖。确认空闲后整体恢复原三个匹配digest与配置，再做旧task-only创建/读/工具/收尾smoke。未验证实际混合协议、恢复和发布条件前不承诺可回滚。

获得读取授权后核查，无凭据值进入输出：

```sql
SELECT version, description, script, checksum, success FROM flyway_schema_history ORDER BY installed_rank;
SELECT @@max_allowed_packet;
SELECT id,project_id,state FROM agent_task WHERE state IN ('QUEUED','RUNNING','NEEDS_ATTENTION');
-- 仅V13存在之后：
SELECT id,project_id,compact_request_id,compact_state FROM agent_conversation WHERE compact_state='RUNNING';
SELECT id,project_id,state FROM `run` WHERE state IN ('STARTING','RUNNING','STOPPING','RECOVERING');
```

Run归属另核对；发现活动Run不是自动停止/删除授权。旧task-only smoke使用一个明确disposable项目，不接续Stage2旧失败任务，不删除旧验收项目。原调用身份和副作用不确定时先对账，不盲重发。

## 3. 一条真实浏览器主链

入口 `pnpm test:e2e:ai-context` 不启动本地webServer、不创建或删除项目。操作者先准备一个明确disposable、owner-owned READY项目和已配置云模型的本切片部署；保持全局worker槽与所有项目准入在受控空闲窗口，查**全局**AgentTask/compact占用和worker状态，不能只看当前页面idle。测试期间禁止其它入口抢占worker。确认无重要数据、无活动Run和未决副作用，填入本轮项目身份；项目回收需另行授权、独立核查。

操作者通过现有工作区编辑/receipt路径在该disposable项目预先保存一个顶层`.txt`文件（例如`ai-context-fixture.txt`）：96–120KiB UTF-8、无BOM的无秘密ASCII纯文本，建议100KiB中性说明/编号行，内容不是指令或业务数据。选择ASCII使Pi估算超过原生20,000-token近期保留量，同时低于read_file的128KiB和192KiB结果JSON上限；不要使用需要大量JSON转义的文本。harness只读文件，不创建它；会核对实际UTF-8字节、ASCII范围、owner文件sha/content与原task的settled read_file安全结果完全相同，拒绝截断。A第一轮仅允许读取此文件，后续轮不调用工具。

配置默认在browser启动前拒绝缺条件并标NOT_RUN。本轮未设置这些授权变量，只验证了拒绝路径；未启动真实主链。后续明确授权时：

```powershell
# cwd: poc4/frontend；所有值均来自本轮真实目标，凭据仅保存在私有环境
$env:MANAO_AI_ACCEPTANCE_BASE_URL = '<frontend-http-origin>'
$env:MANAO_AI_ACCEPTANCE_PROJECT_ID = '<disposable-project-uuid>'
$env:MANAO_AI_ACCEPTANCE_USERNAME = '<owner>'
$env:MANAO_AI_ACCEPTANCE_PASSWORD = '<private-secret>'
$env:MANAO_AI_CONTEXT_KUBE_CONTEXT = '<explicit-context>'
$env:MANAO_AI_CONTEXT_NAMESPACE = '<explicit-namespace>'
$env:MANAO_AI_CONTEXT_WORKER_DEPLOYMENT = '<explicit-worker-deployment>'
$env:MANAO_AI_CONTEXT_FIXTURE_PATH = 'ai-context-fixture.txt'
# 可选单个kubectl可执行路径；不是命令/参数插件
$env:MANAO_AI_CONTEXT_KUBECTL = '<kubectl-executable>'
# 只有已取得该轮模型和空闲worker重建授权，并核查全局空闲后才设置：
$env:MANAO_AI_CONTEXT_MODEL_AUTHORIZED = 'true'
$env:MANAO_AI_CONTEXT_RESTART_AUTHORIZED = 'true'
$env:MANAO_AI_CONTEXT_GLOBAL_IDLE_CONFIRMED = 'true'
pnpm test:e2e:ai-context
```

主链：UI创建A→read_file读取有界fixture并记住bookId和随机标记→新task遵守→UI创建B并检查历史隔离→确认A/B及项目无占用→固定worker重建→重新打开A→UI手动压缩→逐项原历史仍在→下一轮仍遵守。B真实模型不提及标记仅是补充，本地真实Pi scripted provider实际context捕获才证明上下文未带A。摘要是有损概括，真实模型质量仍需该轮结果；no-op摘要不能满足本主链的新增compaction标记。

新A轮和压缩后A轮只允许单个原始JSON对象，精确键为`bookId`/`marker`，书籍编号分别数值7/8，marker必须为最初记住的值；prompt只引用原字段约束，不重新透露字段拼写或marker。harness直接JSON.parse后精确比较整个对象，拒绝代码围栏、解释、id替代字段、额外字段和错值；仅提到bookId或marker不能通过。该断言本地9项语义回归通过，真实模型输出仍NOT_RUN。

测试唯一集群写步骤是显式目标worker的 `kubectl --context … --namespace … rollout restart deployment/<worker>`，随后固定 `rollout status … --timeout=180s`；只读get Deployment/Pod JSON核对前后UID不同、replicas=1、Recreate、仅一个Ready且未deleting的Pod。没有任意shell脚本、kubeconfig打印、其它Deployment操作或自动回收。失败保留项目和诊断，禁止自动重试restart或模型任务。测试无trace/screenshot，防止owner凭据和项目原文进入自动附件；仅报告脱敏任务/会话/Pod身份。

`--list`、类型检查或缺条件拒绝仅证明harness装配/guard，不构成真实E2E PASS。自动75%不为验收烧入786432 tokens，真实未触发仍NOT_RUN。发布/主链完成后把各项实际计数、SHA、digest、imageID/UID、运行库版本、备份恢复与项目留存/回收结果写入证据，不改写Stage1真实PASS、Stage2 PAUSED/NOT_GRANTED和Stage3用户确认。
