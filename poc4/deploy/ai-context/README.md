# AI 多会话上下文：发布与验收准备

2026-10-19：本地实现之后用户明确授权“发布到集群，然后继续按计划进行”。三镜像已构建/push并部署到`kubernetes-admin@learn`的`manao-stage6b`，运行库V13成功。round1/2的harness失败保留；修复独立审查后，round3真实主链1/1通过（38.4s），旧task-only真实冒烟和同请求重放通过。后续`13d8d1e`文件工具结果展示修复另行构建并发布frontend单镜像，digest=`sha256:738c3c73d4201cc2d2e67b9eb8e8209f5d63a0518fc88ab9e0292d8893c082cb`，原历史read_file/list_files在浏览器回放成功；不涉及模型、backend/worker、迁移或既有项目清理。云端75%自动触发仍NOT_RUN，不扩授Stage2/Stage4。Git push/merge和既有项目删除未执行。[本切片证据](../../docs/evidence/ai-context/acceptance.md)拥有实际结果；以下原发布模板与本次follow-up实际记录分开。

## 1. 构建和不变身份

| 组件 | 已验证源码 | 构建/发布状态 | 本切片digest |
| --- | --- | --- | --- |
| backend | `666bfa10d7d852dfefe8115cf149ba44fcf86b26`；标准Dockerfile完整成功，JRE17.0.13、USER10001及两项HTTP重试JVM参数保留 | BUILT / PUSHED / DEPLOYED | `sha256:bc23140a3130f5bd5c0e598c3edbd00d95f99d5f2135969e4f6b9d04242295ec` |
| pi-worker | 同`666bfa1`；Pi三包1.2.0、Node24.22.0、USERnode | BUILT / PUSHED / DEPLOYED | `sha256:8a933471e8b92bbd167ceda4b24ee4976d7150f48f7f1831f234fa90aa402971` |
| frontend | 同`666bfa1`；`VITE_ENABLE_AI=true`，USER101 | BUILT / PUSHED / DEPLOYED | `sha256:d337a613f6e60ecfd59eb7b5fe03e6eaa12b2ed536654aebf24dc91381b41e5a` |

runner、workspace-agent、initializer、共用NetworkPolicy未重建。三个tag分别为`ai-context-backend-666bfa1`、`ai-context-worker-666bfa1`、`ai-context-frontend-666bfa1`，repository均为`chocologic/manao_images_repository`；集群按上表OCI index digest固定，实际Pod imageID一致。linux/amd64 child分别为`843046ffbf8618865b5e178a4004c16b0c0f4c4f48faea92565799c8f3d720b0`、`ebf9bcd386e1ba984b2b09cfefb42a6e8eeffa25d666e7ebbeca867b06cea349`、`bb992df0ddc709cc03cd3fc3ecf65b029498bc31007311fd55e7b38a67069d10`。本轮后续harness-only修复不改变镜像源码身份。

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

仅增加两表和nullable conversation_id。运行库已从V12升V13（checksum1903213284，success1）；备份恢复与worker→backend大包路径已验证，详情见证据§7。原任务25条、工具616条保留，旧task关联均NULL。下面保留后续维护步骤；实际环境回滚演练未执行。

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

配置默认在browser启动前拒绝缺条件并标NOT_RUN。最初本地阶段只验证拒绝路径；另获授权后已执行真实主链，结果见证据§7。后续授权复验使用以下模板，不能直接重放旧任务或checkpoint：

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

## 4. 文件工具结果展示 follow-up

2026-10-19按提交`13d8d1e6afc2ead19a8e30ce8b2c0fc7ceb95345`只发布frontend，tag为`ai-tool-result-frontend-13d8d1e`、registry digest为`sha256:738c3c73d4201cc2d2e67b9eb8e8209f5d63a0518fc88ab9e0292d8893c082cb`。`manao-stage6b/frontend` rollout成功；新Pod为`frontend-6956975667-cxcdc`、UID=`8a1229de-c723-4b16-8a12-378edc67fb49`，实际imageID与digest一致。没有后端/worker/schema变更，不需要迁移或模型请求。

同一disposable项目`4a355478-0ec5-457c-9c73-fad09d98bf79`中，UI重新读取原持久化`list_files src/test/java`和`read_file AppTest.java`结果并按文本展示。原历史未重放工具。精确命令、测试和证据见[acceptance §8](../../docs/evidence/ai-context/acceptance.md)；可回滚frontend image digest为本切片先前的`sha256:d337a613f6e60ecfd59eb7b5fe03e6eaa12b2ed536654aebf24dc91381b41e5a`。

主链：UI创建A→read_file读取有界fixture并记住bookId和随机标记→新task遵守→UI创建B并检查历史隔离→确认A/B及项目无占用→固定worker重建→重新打开A→UI手动压缩→逐项原历史仍在→下一轮仍遵守。B真实模型不提及标记仅是补充，本地真实Pi scripted provider实际context捕获才证明上下文未带A。摘要是有损概括，真实模型质量仍需该轮结果；no-op摘要不能满足本主链的新增compaction标记。

新A轮和压缩后A轮只允许单个原始JSON对象，精确键为`bookId`/`marker`，书籍编号分别数值7/8，marker必须为最初记住的值；后续prompt不重新透露bookId字段拼写或原marker值，仍明确要求marker键。harness直接JSON.parse后精确比较整个对象，拒绝代码围栏、解释、id替代字段、额外字段和错值；仅提到bookId或marker不能通过。本地9项语义回归及本次round3两轮真实模型精确断言均通过，范围限此验收场景。

实际harness契约修复：公共files/content没有sha256，须从返回原始content按UTF8本地计算，与安全tool结果比对；刷新后按现有memory-only认证显式重新UI登录；首目标以唯一marker开头，使前40字符标题区别于留存旧轮次。均独立审查，未修改生产认证、历史或模型提示的后续约束信息。

harness 核对每轮原 task 的全部 tool_call/tool_result：首轮严格一个 read_file 调用和一个同名、同 call ID 的结果，并比对 owner-safe 原 task/result route 返回的 call ID；后续 A/B/压缩后 A 三轮不得出现任何工具项。额外 write_file/build/application 即使答案正确也失败；本地工具语义10项回归不替代真实主链。

压缩 POST 未知且 GET 未登记时保留项目级原身份；“核对压缩状态”仅 GET，“重试原压缩请求”仅由用户显式点击，复用保存的 conversationId/requestId/baseSeq（刷新/切 B 仍操作 A），后端原幂等准入保证至多一次摘要。retry 拒绝且 GET head 未变或查询失败时继续待对账；原终态或成功 GET 证明旧 base 已失效后才释放，不自动换身份或盲重试。

测试唯一集群写步骤是显式目标worker的 `kubectl --context … --namespace … rollout restart deployment/<worker>`，随后固定 `rollout status … --timeout=180s`；只读get Deployment/Pod JSON核对前后UID不同、replicas=1、Recreate、仅一个Ready且未deleting的Pod。没有任意shell脚本、kubeconfig打印、其它Deployment操作或自动回收。失败保留项目和诊断，禁止自动重试restart或模型任务。测试无trace/screenshot，防止owner凭据和项目原文进入自动附件；仅报告脱敏任务/会话/Pod身份。

`--list`、类型检查或缺条件拒绝仅证明harness装配/guard，不构成真实E2E PASS。自动75%不为验收烧入786432 tokens，真实未触发仍NOT_RUN。发布/主链完成后把各项实际计数、SHA、digest、imageID/UID、运行库版本、备份恢复与项目留存/回收结果写入证据，不改写Stage1真实PASS、Stage2 PAUSED/NOT_GRANTED和Stage3用户确认。


## 5. Streaming / reasoning / Markdown V14 release

2026-10-20: user authorized publication and continuation after final local review Approved. Source `a7d004119dd2439d09a4ef86890b2f8ab00658d7` is **BUILT / PUSHED / DEPLOYED** to `kubernetes-admin@learn` / `manao-stage6b`; runtime V14 applied once, private backup/disposable restore and old-artifact compatibility passed. [Output acceptance](../../docs/evidence/ai-output/acceptance.md) owns actual identities, data checks, failed real rounds and final real-model verdict. Real round1 FAILED at a reconnect checkpoint after its high task completed; subsequent harness-only `310fa9a` changes no deployed image. This section preserves preceding actual V13/context rollout; those old digests remain rollback references, not this output release.

| New component | Release identity | Execution |
| --- | --- | --- |
| backend |a7d0041; OCI sha256:726c095f15d4866fbcea48146c90faf2fb1a6d680f02629f6ea893e49f694af1 |BUILT / PUSHED / DEPLOYED |
| pi-worker |a7d0041; OCI sha256:dd06e4148d466127914ebf0bc04e27b5f078d4061f4485f1c0b4221831e269f8; actual Pi packages1.2.0 |BUILT / PUSHED / DEPLOYED |
| frontend |a7d0041; OCI sha256:8d90abdf44f5e2af50c61810b8640e532e1e8b95bffdd9172f017f929e82b89a; VITE_ENABLE_AI=true |BUILT / PUSHED / DEPLOYED |

The following was the authorized release sequence; future reruns still require their own current authorization. Actual results supersede the original NOT_RUN preparation statements within the steps:

1. Recheck context/namespace and global task/compact/Run occupancy, worker single slot; idle/short maintenance; preserve matching old digests/replicas/Recreate. Section2 drain safeguards apply; MANAO_AI_ENABLED=false is not graceful drain. Active Run does not authorize stop/delete.
2. Private backup plus disposable restore and V13→V14 rehearsal. V14__agent_reasoning_effort.sql adds nullable reasoning_effort; preserve legacyNULL and task/tool/history/receipts. Verify actual old image ignores new column and Flyway futureV14 compatibility; new-code local tests do not prove old image. Backup/restore/compatibility NOT_RUN. DDL failure requires actual schema/history reconciliation before retry; no reset/drop/repair blindly.
3. Build three matching images with section1 Dockerfiles and final reviewed SHA/tag/actual OCI digest/platform child/imageID. Retain backend JRE/USER and -Djdk.httpclient.redirects.retrylimit=1 / -Djdk.httpclient.disableRetryConnect=true. Frontend VITE_ENABLE_AI=true. No runner/workspace-agent/initializer changes. Build/push NOT_RUN, no fabricated digest.
4. Existing single-replica backend/worker Recreate; old Pod exits, matching new versions, frontend last. Verify UID/imageID/health, V14 applied once, old/new task/history intact. Rollback old matched images/config while **retaining nullable column and V14 history**, no drop/reset. Deployment/rollback NOT_RUN.
5. Separate real-model authorization then pnpm test:e2e:ai-output (cwd poc4/frontend): existing owner-owned READY project, <=16KiB secret-free README.md; four short read-only high/off/low/max tasks plus read_file. Live DOM before end, thinking/Markdown, disconnect/reconnect, refresh/relogin/history/effort. No local webServer/restart/code edit/app start/project deletion; no8192/75% stress burn. Too short UNVERIFIED; length FAILED/AI_LENGTH_LIMIT.

Private required environment: MANAO_AI_ACCEPTANCE_BASE_URL explicitHTTPorigin, MANAO_AI_ACCEPTANCE_PROJECT_ID canonicalUUID, MANAO_AI_ACCEPTANCE_USERNAME/PASSWORD, current MANAO_AI_OUTPUT_MODEL_AUTHORIZED=true only after authorization. Missing conditions refuseNOT_RUN beforebrowser;workers1/retries0. Browser does not capture providerwire: separately preserve authorizedboundary whitelist thinking/reasoning_effort/stream/max_tokens and compare task effort. No key/prompt/thinking/rawpubliclogs. Guard/--list is not realPASS. Stage2 PAUSED/NOT_GRANTED,Stage3 confirmation,75%NOT_RUN unchanged.

### 5.1 Actual 2026-10-20 closeout (supersedes preparation status in steps above)

- Publication PASS: all three standard images above are deployed, Ready/single replica; actual imageIDs match OCI digests. Backend/worker Recreate preserved. Runtime V14 checksum1063954255 succeeded once;38 legacy efforts remainNULL and six tables' original columns retain equal ordered SHA256. Private pre-V14 backup retained, random disposable restore matched and was migrated using the actual new artifact; actual previous backend artifact validated futureV14 and read all38 tasks. Full old app startup/write/real-cluster rollback was not exercised. Rollback image tuple remains previous backend `bc23140a3130f5bd5c0e598c3edbd00d95f99d5f2135969e4f6b9d04242295ec`, worker `8a933471e8b92bbd167ceda4b24ee4976d7150f48f7f1831f234fa90aa402971`, frontend `738c3c73d4201cc2d2e67b9eb8e8209f5d63a0518fc88ab9e0292d8893c082cb`; retain V14 column/history, never drop/reset to roll back.
- Real acceptance is partial, not a combined PASS. Round1 FAILED at late reconnect checkpoint; reviewed harness-only `310fa9a` fixes display abort timing. Round2 high/off browser checkpoints passed, low task COMPLETED but streaming timing UNVERIFIED; no precise missing-condition diagnosis is claimed. A fixed-identity max-only continuation passed1/1, verified prior histories and refreshed max history/default, and made exactly one new max task. All four task efforts and actual provider whitelist are verified, all max_tokens8192/max unchanged. The earlier failed matrix remains FAILED. No repeated whole paid run was used to force a pass.
- The temporary worker-only request whitelist preload was removed at global idle; final worker Pod `manao-pi-worker-56fc457bf-g87q9`, UID `216e83c1-63b8-4ec2-a709-20ed58b15ea9`, same digest/Ready/restart0. NODE_OPTIONS/mount/volume absent, dedicated ConfigMap count0. Disposable restore schema dropped1→0; private backup kept. Verification port-forward closed. No project/application/diagnostic resources were deleted.
- Final global task/compact/Run occupancy0/0/0, project remains READY/revision23, all five new paid tasks COMPLETED. Actual Pi three packages1.2.0, readiness200/UP/public200. Source images remain `a7d0041`; later `310fa9a` only changes the local real-acceptance harness. See [unique acceptance](../../docs/evidence/ai-output/acceptance.md) and [sanitized evidence](../../docs/evidence/ai-output/real-release-safe.json) for task IDs, timings and final identities. No Git push/merge, Stage2 remains PAUSED/NOT_GRANTED; user acceptance is not inferred.

### 5.2 Context usage ring: authorized frontend release (2026-10-20)

[Context acceptance section 9](../../docs/evidence/ai-context/acceptance.md) owns local verification and the subsequently authorized publication. Source1f41cf575014d70aa83212b26cca45b00cd801a5 was committed before building the standard frontend image with VITE_ENABLE_AI=true. Tag=chocologic/manao_images_repository:ai-context-usage-frontend-1f41cf5; BUILT/PUSHED/DEPLOYED, OCI index=sha256:7149afb9cd7feed8c9a5d0ff1ea5048f54103e93a8974a957ea094309b6bf37c, linux/amd64 child=sha256:42acac365dc5eae8ac161055b5b59e4ec4b7ec40d5ab92e792a30d5b1524250d; USER101. Scope is frontend only.

On kubernetes-admin@learn / manao-stage6b, set image deployment/frontend container frontend to the new OCI index digest. Rollout succeeded; Pod=frontend-94bd6cff9-bxg86, UID=c42b3cba-3316-46ba-8229-d597b43cd7a6, imageID matches the index digest, generation/observed21, Ready1/1/restart0. Previous frontend digest8d90abdf44f5e2af50c61810b8640e532e1e8b95bffdd9172f017f929e82b89a remains the rollback target. Backend and worker images/Pod identities unchanged; no migration or data cleanup.

Public root200 now references index-0JstDDrj.js / index-dST7lErr.css. Actual browser login and owner-scoped existing-history replay PASS: measured2,633/1,048,576 tokens displays0.3%, correct75% threshold and20px ring, zero page errors/unexpected API mutations. No task/tool/compaction/model execution. Unknown/failed-refresh usage keeps the existing null semantics and two-second polling. No Git push/merge; later release-documentation commit does not change image source. Stop-button request withdrawn; Stage4 not started.

### 5.3 ThinkRail 界面实际前端发布（2026-10-20）

用户在本地 mock 展示与独立审查后明确授权集群发布。本次 frontend 单镜像已 **BUILT / PUSHED / DEPLOYED**；源码 `b3a1b8ef28f883b577280c2bf06589edeb54f6bd`，tag `chocologic/manao_images_repository:ai-thinkrail-frontend-b3a1b8e`，OCI index `sha256:a45d8c0ad6abf7e138b31a3ac43e79937fc33cddac109e943ea15e2789b5fca2`，linux/amd64 child `sha256:a0daaaa8f6b3ed30d4864c8f50c3dd1ac0e996c656561d2d22b66738c37d1b3b`，USER101。使用标准 Dockerfile、`--build-arg VITE_ENABLE_AI=true` 与 `--label org.opencontainers.image.revision=b3a1b8ef28f883b577280c2bf06589edeb54f6bd`；frozen lockfile 安装、typecheck、Vite build exit0，保留已知 chunk 大小警告。push 与 registry digest inspect 成功。

发布前对实际镜像 HTML/assets/sourcemap 做 `grep -r -l -E` 扫描，无 fixture/session/mock 标记（status1）；mock SW 文件不存在。最初使用的 `grep --include` 在 BusyBox 不支持，该次扫描无效，已丢弃并以上述有效扫描重验。3 个 Node 均 Ready、无 Pending Pod，node1 无 pressure，request CPU57%/memory58%；Metrics API 不可用，这些 request 比率不是实时利用率。

[集群安全记录](../../docs/evidence/ai-ui/cluster-release-safe.json)拥有前后 Deployment/Pod 身份：`kubernetes-admin@learn` / `manao-stage6b`，frontend generation/observed 21→22，Ready1/1，Pod `frontend-844c8f768-2wtcb`，UID `be2f3587-8684-4997-98aa-55983add65d3`，restart0、imageID 与新 OCI index 一致。backend generation39、Pod UID `a5851be2-d432-4cbc-8c4d-3e5fb1d653f9`、restart5、digest `726c095f15d4866fbcea48146c90faf2fb1a6d680f02629f6ea893e49f694af1`；worker generation29、Pod UID `216e83c1-63b8-4ec2-a709-20ed58b15ea9`、restart2、digest `dd06e4148d466127914ebf0bc04e27b5f078d4061f4485f1c0b4221831e269f8`，均与发布前一致。没有 backend/worker 部署或重启、迁移、数据修改或资源清理。

本次前端切换对应的可复用命令（运行时仅替换 frontend）：

```powershell
kubectl --context kubernetes-admin@learn -n manao-stage6b set image deployment/frontend frontend=chocologic/manao_images_repository@sha256:a45d8c0ad6abf7e138b31a3ac43e79937fc33cddac109e943ea15e2789b5fca2
kubectl --context kubernetes-admin@learn -n manao-stage6b rollout status deployment/frontend --timeout=180s
```

回滚目标是发布前 frontend OCI index `sha256:7149afb9cd7feed8c9a5d0ff1ea5048f54103e93a8974a957ea094309b6bf37c`（§5.2），未实际执行回滚：

```powershell
kubectl --context kubernetes-admin@learn -n manao-stage6b set image deployment/frontend frontend=chocologic/manao_images_repository@sha256:7149afb9cd7feed8c9a5d0ff1ea5048f54103e93a8974a957ea094309b6bf37c
kubectl --context kubernetes-admin@learn -n manao-stage6b rollout status deployment/frontend --timeout=180s
```

公网 `http://1.12.245.235:30080/` HTTP200，引用 `index-Be3JTCfu.js` / `index-CiiA_nSb.css`；这两项和 `WorkbenchPage-Um_W5ZqW.js` / `WorkbenchPage-BRSegDPZ.css` 均 HTTP200。[公网安全回放记录](../../docs/evidence/ai-ui/public-release-safe.json)记录真实登录后的既有项目 `4a355478-0ec5-457c-9c73-fad09d98bf79` 前后均 READY、10 个既有会话；选中 `6328bc93-fb38-4da3-a305-dad64b825f69`，head26、history12，上下文 2,633/1,048,576（0.251102%）。四档滑块只改变本地值、未 Submit；侧栏显隐保留选择，切到 File 恢复 Run Insights，回到 AI 恢复会话侧栏，打开一个既有工具结果 GET。page errors/API5xx/意外 mutation 均0，无 mock SW、无页面横向溢出。浏览器拦截除登录外的非 GET；task submission/model call/compaction 均0。未保留凭据、原始用户内容、截图或 trace。

此镜像相对先前线上 `1f41cf5` 也包含 `94c8047` 合入的 Cloud IDE 视觉变化（登录、项目、主题、工作台、日志 UI），以及本轮 AI 样式；没有 API/业务合同变化。本地证据保留在 [Frontend README](../../frontend/README.md#ai-界面本地交付2026-10-20)，本节只证明实际前端发布与现有历史只读回放，不建立新的模型/工程阶段 PASS。Stage2 仍 PAUSED / NOT_GRANTED；Stage3 用户确认使命完成；Stage4 未开始。Git push/merge 未执行。

### 5.4 AI 界面文案与洞察收敛（2026-10-21）

本次仅更新 frontend：源码改动为登录页文案/placeholder 和 `RunInsights` 的未接入 AI 占位卡移除；认证值、AI 任务、Run/日志、API、backend、worker、数据库和用户项目资源均未改动。发布前本地针对性 Vitest 3 files / 98 tests、`typecheck:stage6`、生产 `pnpm build` 均通过；mock smoke 结果保存在 `../../docs/evidence/ai-ui/copy-20261021/local-smoke-safe.json`，截图在同目录。

本轮发布需先将源码提交后的标准 frontend 镜像按以下形式构建并取得实际 OCI index digest；不要把 tag 当作部署身份：

```powershell
docker build --build-arg VITE_ENABLE_AI=true --label org.opencontainers.image.revision=<fullSHA> -t chocologic/manao_images_repository:ai-copy-frontend-<shortSHA> poc4/frontend
docker push chocologic/manao_images_repository:ai-copy-frontend-<shortSHA>
docker buildx imagetools inspect chocologic/manao_images_repository:ai-copy-frontend-<shortSHA>
docker run --rm --entrypoint sh chocologic/manao_images_repository:ai-copy-frontend-<shortSHA> -c 'test ! -e /usr/share/nginx/html/mockServiceWorker.js && ! grep -r -l -E "AI_UI_VISUAL_FIXTURE_ONLY|ui-conversation-reading|ui-task-completed|prj-alice-notebook|mockServiceWorker|Mock Service Worker" /usr/share/nginx/html'
```

使用 `D:/DeepLearning/MyProjects/Project_Manao_kubeconfig/stage6b-admin-public.yaml`、context `kubernetes-admin@learn`、namespace `manao-stage6b`，只更新 `frontend`：

```powershell
kubectl --kubeconfig D:/DeepLearning/MyProjects/Project_Manao_kubeconfig/stage6b-admin-public.yaml --context kubernetes-admin@learn -n manao-stage6b set image deployment/frontend frontend=chocologic/manao_images_repository@<new-index-digest>
kubectl --kubeconfig D:/DeepLearning/MyProjects/Project_Manao_kubeconfig/stage6b-admin-public.yaml --context kubernetes-admin@learn -n manao-stage6b rollout status deployment/frontend --timeout=180s
```

回滚目标为本轮发布前实际 frontend OCI index `sha256:a45d8c0ad6abf7e138b31a3ac43e79937fc33cddac109e943ea15e2789b5fca2`。发布后重新核对 frontend Ready1/1、imageID、generation、restart，以及 backend/worker generation、Pod UID、digest、restart 未改变；不执行真实模型请求、数据库迁移或资源清理。

实际执行结果：源码 `9e0c831ebda0762b10ef21a2b6721a2bbb692366`，tag `chocologic/manao_images_repository:ai-copy-frontend-9e0c831`，OCI index `sha256:297a81e47cc421223b552562acee5d99920aeda20bc5b5190dadbd1991059698`，linux/amd64 child `sha256:d45066a454f728fa781a3a203329f2319f55e02c2c9b45aebb1c09e5e52d9a54`，USER101。镜像 fixture/MSW 扫描无匹配。`kubernetes-admin@learn` / `manao-stage6b` rollout 成功，frontend generation/observed 23、Ready1/1、restart0、Pod UID `50513a22-0b12-4c13-9c79-ce2adb5b84d7`；backend generation39 / Pod UID `a5851be2-d432-4cbc-8c4d-3e5fb1d653f9` / restart8 / digest `726c095f15d4866fbcea48146c90faf2fb1a6d680f02629f6ea893e49f694af1`，worker generation29 / Pod UID `216e83c1-63b8-4ec2-a709-20ed58b15ea9` / restart3 / digest `dd06e4148d466127914ebf0bc04e27b5f078d4061f4485f1c0b4221831e269f8`，均未滚动。公网 `/login` HTTP200；最终真实只读回放验证登录文案 PASS、Run Insights AI 占位卡 ABSENT、AI 入口及切回 File 恢复洞察 PASS，page errors/API5xx/意外写请求均0。早期脚本误用 mock 会话标题不构成真实数据缺失证据；最终不依赖 mock 标题，也不提交模型任务或压缩。安全记录见 `../../docs/evidence/ai-ui/copy-20261021/public-smoke-safe.json`；本地10/10专项与4/4标注检查、最终生产build及36/36边界结果见 Frontend README。阶段验收结论保持原样。
