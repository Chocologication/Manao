# AI 多会话与上下文切片：实施和验证记录

日期：2026-10-19。分支`codex/ai-integration`，实现起点`cb0793c`。§2–6保留本地实施/发布准备证据；随后用户授权发布集群并继续计划，三镜像及V13已部署，真实模型/浏览器主链round3通过1/1，§7记录全部实际结果和两轮失败。Git push/merge、既有项目删除未执行。本记录拥有本切片证据；[设计](../../../../docs/superpowers/specs/2026-10-19-ai-conversation-context-design.md)、[计划](../../../../docs/superpowers/plans/2026-10-19-ai-conversation-context-implementation-plan.md)与[发布手册](../../../deploy/ai-context/README.md)分别拥有接口、任务和操作步骤。

## 1. 交付与判定边界

已实施项目内多会话、同会话多轮 AgentTask、MySQL 原生历史、固定 1,048,576/786,432 窗口/阈值、Pi 原生自动压缩、空闲手动压缩及浏览器历史。不同会话只共享代码；完整历史不来自截断 progress；旧任务不自动续跑，旧工具不重新执行。运行/文件/工具 ledger 与原有项目互斥仍属原模块权威。Pi 三包仍锁定 1.2.0，预算仍为 1800s / 180 tools / 20 builds。

| 证据面 | 本轮结果及限制 |
| --- | --- |
| backend 相关八套 / 随机 disposable MySQL | 最终结果见 §4；不连接或 reset 运行 schema |
| 真实安装 Pi SDK + scripted provider | 最终 121/121；真实 SDK 时序和实际 provider context 捕获，未访问云模型 |
| frontend 组件/API/parser + typecheck/build | 165/165；局部 Vitest/MSW，不是实际浏览器 |
| V12→V13 additive 升级 | Store 测试通过，旧 task/tool 值保留、旧 task 的 conversation_id 为 null；新表及项目级 FK 回收在测试 schema 验证 |
| 精确旧代码 + V13 兼容预演 | 见 §5；不等于真实部署混合版本或可回滚保证 |
| 真实模型多轮/摘要质量 | round3实际通过本场景：同会话约束连续、独立B、手动原生摘要后约束保留；不是通用摘要质量保证，见§7.4 |
| 真实浏览器主链 | round1/2各FAILED；harness修复独立审查后，round3为1passed/0failed，38.4s，见§7 |
| 真实自动 75% 场景 | NOT_RUN；注入 usage 的 786431/786432/786433 边界不冒充云端长上下文 |
| 云端迁移、空闲 worker 重建、手动摘要 | V13成功；实际worker UID更换、重新登录恢复历史、原生摘要和最终模型验证通过 |
| 三镜像构建/push/rollout、备份恢复、内部大包 | 全部实际完成，digest/Pod/备份hash/5项边界见§7.1；未做运行环境回滚演练 |
| 既有项目/集群清理 | NOT_RUN，未删除；新验收项目及6会话留存，仅删除本轮随机恢复schema和无用本地临时文件 |

本切片约定的部署与多会话/上下文真实主链已通过，证据范围限本场景；真实云端75%自动触发仍NOT_RUN，没有为验证烧入786432 tokens。原Stage1真实`PI_STAGE1_CODE_TEST_LOOP_PASS`保留；Stage2仍PAUSED / NOT_GRANTED；Stage3由用户实际图书CRUD使用确认使命完成，未启动Stage4。

## 2. 顺序任务、RED/GREEN 与审查

以下是当时版本的局部证据，不把早期组合改称最终 HEAD。六项任务及整体改动均完成独立规格/质量审查；所有发现已关闭，最终Approved仅限本地实现/发布准备，详见[审查收尾](review.md)。Task4历史TDD顺序偏差保持披露。

Task6初审对`e8248e8`给出Changes requested，唯一Important I1：E2E仅检查回答包含bookId/marker，会将`{"id":7,"note":"the requested key was bookId","marker":"原标记"}`误判通过。修复轮1将同会话及压缩后两轮都约定为单个raw JSON，数值分别7/8，只有原约定书籍标识字段和marker；prompt不重新透露bookId拼写或原marker值。测试helper只JSON.parse并对精确`{ bookId, marker }`做deepEqual，拒绝解释文字、替代id、额外字段和错值；不是通用JSON提取器。修复提交和复审结论由主控登记，不追认初审通过。

| 任务 / 提交 | 有效 RED 摘要 | GREEN / 审查 |
| --- | --- | --- |
| 1 `585884d`，修复 `b9227a8` | 初始37项：1断言失败+1缺表错误，旧512KiB过滤器拦截600KiB新 context；后续合法长文本读取失败。评审修复7项中5断言失败+1真实冲突：RR旧快照错ACK/漏行、不可分页metadata超界、header时戳不一致 | 初始最终组合96/96，后续HTTP3/3；修复Store19/19，12:25:17+08:00，01:05。复审 PASS/Approved，I1/I2/M1关闭 |
| 2 `e61c0db` | worker 初始4 failed/17 passed：历史缺失、ACK未等待、末消息丢失、未配对工具无context_edit；分页对账、失败尾历史、错误安全码另有定向RED | worker93/93+build，12:41:48，5.79s；backend101/101，03:34；重建COMPLETED/FAILED/CLOSED增强case1/1，36.584s。PASS/Approved |
| 3 `d22e071` | 初始8 failed/31 passed：旧窗口、阈值、摘要失败和abort；idle取消2 failed/12 passed；停止期间ACK2 failed/16 skipped | worker111/111+build，12:54:35，9.07s；backend usage1/1，30.543s。PASS/Approved |
| 4 `5afa08e` | backend48项中1断言失败（缺compact route）；worker缺route2 failed/41 passed。后续固定原base、provider假no-op、status等待callback、callback409、no-op终态追加等均有修复前有效RED | worker120/120+build，13:12:56，9.17s；backend早期113/113，最终修复后Store+compact30/30及compact12/12（13:21:31，53.806s）。PASS/Approved，保留下面流程偏差 |
| 5 `72b75ed` | UI初始12 failed/118 passed；后续原task身份、刷新发现、异步A/B覆盖、旧任务遮盖和shell过期查询均有定向RED | 最终4文件146/146，13:42:46，52.81s；typecheck+build，Vite52.04s。PASS/Approved |

**Task 4 TDD 顺序偏差：** 最初真实双连接准入和 first-arrival identity matrix 是在第一版 store 实现之后补充，首次有效运行 GREEN。它们是回归证据，不是 test-first RED；缺路由 RED 不能替代这些接缝的失败证明。没有倒改历史或回滚制造 RED。其后修复 RED、独立审查和本轮整合覆盖不消除这个流程事实。其它实现后首次 GREEN 的补充测试同样只称回归。并发 Maven 同 target 的 NoClassDefFoundError、fixture缺Run列/rollback-only、shadowed URL 和负面fixture heap错误都不计产品RED。

## 3. 实施裁定、理由与错误成本

| 裁定 | 理由 / 若判断错误的成本 |
| --- | --- |
| 实施授权覆盖原 planning-only 状态，部署授权不外推 | 本轮明确实现/本地验证；错误会造成文档状态误报 |
| 原生 `context_edit` 使用 `replacement:null` | 安装的 Pi 1.2.0 declaration；错误会损坏中断轮投影修复 |
| 保留 prepareRequest ACK 并包装原始 streamFunction | 原生摘要绕过 prepareRequest；错误会在未保存历史时调用provider，需SDK时序回归 |
| 首轮 idle pre-prompt 检查新增目标/trigger/system/tools，再调用 public native compact | SDK首检以旧assistant usage为起点；错误会漏阈值或额外压缩；无私有SDK/小窗口开关 |
| `textOffset`、`nextBeforeOffset`、`beforeOffset` 与 seq 组成游标 | 2MiB合法entry不能由512KiB seq-only页完整展示；只读时64KiB UTF-8安全片段，UTF-16 offset不切code point；错误需API/前端分页返工 |
| 轮次状态读取 owner-scoped TaskSnapshot | TaskSnapshot拥有执行状态；动态task_state会破坏稳定原生seq/offset；错误需额外scoped读取调整 |
| ConversationStore独立READ_COMMITTED，保留project-first锁及旧TaskStore事务 | 真实双连接证明RR旧视图会错ACK/漏行；错误为一致性回归，无全局隔离变更 |
| append ACK前检查完整不可分HistoryPage group真实字节（含最大cursor） | 工具metadata不能再以textOffset拆分；保留2MiB entry和无损文本，不新增任意identifier长度限制；错误可能拒绝异常metadata或产生不可读ACK |
| 新错误加入既有ApiError固定allowlist | 真实HTTP原映射会把新404改INTERNAL_ERROR；错误为安全错误展示回归 |
| 空闲摘要context GET-only，POST result一次原子提交suffix/usage/终态 | 中间POST context违背一次事务摘要完成；保留32条/4MiB/单条2MiB，错误为internal调用适配返工 |
| 验收前置96–120KiB ASCII无秘密fixture，由操作者在disposable项目显式准备，A首轮仅read_file | 极短两轮低于Pi原生keepRecent20k会得到合法no-op，无法证明真实摘要；错误会使harness永远失败或误报摘要；不降低生产窗口、不创建填充模型循环、不由本轮写文件 |
| Task6补deadlineExpired事实标记 | 定时器已触发但now==deadline时旧`>`把到期报AI_ABORTED；错误为停止/预算分类回归，稳定时钟RED覆盖；不改变预算值 |

## 4. 本轮必要整合与 deadline 修复

命令按各自 cwd 执行；backend 使用 IntelliJ 捆绑 Maven 3.9.11 / JDK17.0.16完整路径，默认测试账号只创建 `manao_stage6_<uuid>`。没有加载私有集群环境或输出凭据。

```powershell
# cwd: poc4/backend
& 'D:/DeepLearning/Java/IntelliJ IDEA 2025.2.3/plugins/maven/lib/maven3/bin/mvn.cmd' '-Dtest=AgentConversationStoreTest,AgentConversationHttpContractTest,AgentConversationCompactionTest,AgentTaskStoreTest,AgentTaskServiceTest,AgentProjectToolsTest,AgentApplicationToolsTest,AgentInternalSecurityTest' test
# cwd: poc4/pi-worker
pnpm test
pnpm build
# cwd: poc4/frontend
pnpm test -- src/features/ai src/components/shell/WorkbenchShell.test.tsx src/api/agentConversationApi.test.ts src/contracts/agentConversation.test.ts
pnpm typecheck
pnpm build
pnpm test:e2e:ai-context
```

最终backend八套：163 executed / 0 failures / 0 errors / 0 skipped，BUILD SUCCESS，07:06，结束2026-10-19T13:59:26+08:00。分项Store19、HTTP3、compact12、TaskStore28、TaskService45、ProjectTools35、ApplicationTools12、InternalSecurity9。当前后端target与旧导出target隔离，没有并发操作同一target；后端通过后只有worker截止分类修复和测试/文档变化，无需再跑八套。旧Fabric8/unchecked/JVM sharing警告保留。

Task6独立API/parser8项首次GREEN，覆盖原compact身份/单次POST、公共route及Bearer、组合游标0/取消信号、原文文本/字段剔除、内部kind拒绝、非法offset/未知usage。组件既有覆盖一并保留，未为文件名写空壳测试；body大小在backend真实过滤器及Store测试验证。

整合第一次worker为119 passed / 1 failed，13:52:19，11.88s：`cancels idle pre-prompt compaction honestly on deadline` 预期AI_BUDGET_EXCEEDED、实际AI_ABORTED。定向原case2/2重跑成功，未把它当修复。新增固定now=1000→1050、50ms真实deadline的稳定回归：

```powershell
# cwd: poc4/pi-worker；修复前、后相同命令
pnpm test -- test/context-compaction.test.ts -t 'exact clock boundary'
```

修复前1 failed/18 skipped（13:56:47，3.43s）；修复后1 passed/18 skipped（13:57:04，3.05s）。`7a7976d`仅让实际deadline timer先记expired，再调用原stop，预算结算读取该事实，保留普通用户stop分类。最终全worker121/121，7文件，13:58:14，6.84s，build退出0。两个原runner-failure fixture的stderr为预期诊断。

frontend相关7文件165/165，13:52:19，61.38s；typecheck退出0；Vite build49.73s，旧大chunk警告保留。独立strict `tsc --noEmit --target es2023 --module esnext --moduleResolution bundler --strict --skipLibCheck --types node playwright.ai-context.config.ts tests/e2e/ai-context.spec.ts` 退出0，证明harness可类型检查，不证明主链执行。

I1定向语义回归命令（cwd `poc4/frontend`）：`pnpm test -- tests/acceptance/ai-context-answer.test.ts`。先将两处原包含检查原样抽入helper，修复前有效RED为6 failed / 3 passed，14:17:21+08:00，3.93s：两轮id+note反例、散文、残缺JSON、错bookId和额外id均未抛错；正确JSON已通过。改为raw JSON精确对象断言后9/9，14:17:59，3.40s，0failed/skipped。helper不导入Playwright，unit不会注册E2E；原163/121/165组合未因harness-only修复重跑或改称174项。带helper及unit文件的strict tsc退出0，`pnpm test:e2e:ai-context`仍缺授权/env而exit1 NOT_RUN；未访问模型/browser/cluster。

E2E命令实际退出1并明确NOT_RUN：缺本轮model/restart/global-idle授权及BASE_URL/project/owner/Kubernetes目标/fixture路径。自检安装SDK的prepareCompaction发现短聊天会合法no-op，因此加入操作者预先准备的96–120KiB无秘密ASCII文件，A首轮只读一次；通过原owner文件API和原task的read_file安全结果比对sha/content/真实字节，禁止本轮自动写fixture。修订后只重跑harness strict类型检查和缺条件拒绝，均符合预期，不重跑已过165项。未设置假的授权env绕过配置，未调用kubectl，未启动browser/webServer。后续真实验收步骤见发布准备；不把discover/list/typecheck/guard视为E2E PASS。

### 整体终审 I1/M1 的局部修复

整体终审对 `505e316` 发现 Important I1（未知且未登记的 compactIntent 永久禁用项目）及 Minor M1（只筛 read_file result，遗漏额外工具）。`344ccb9`仅修这两个接缝；限定范围复审均为ADDRESSED，无新增Critical/Important或延期Minor，批准本地实现/发布准备，不改早期审查历史。

UI 保留“核对压缩状态”的 GET，另加用户显式“重试原压缩请求”：保存的 conversationId/requestId/baseSeq 原样 POST，刷新/切 B 仍作用原 A，不生成新身份或自动重发。GET null/不同请求或失败不单独清除；同 request 终态照原逻辑释放。retry 被 HTTP 拒绝后，仅成功 GET 证明 head 已变化、旧 base 不再可能准入才清除；same-head busy/权限拒绝仍保留，防止原 POST 尚在 gate 外 IO、稍后登记。原后端同 ID/base 幂等和迟到 callback fencing 不变，既有 backend163/worker121/旧代码27不重跑。

所有命令 cwd 为 `poc4/frontend`。UI 初始 RED：`pnpm test -- src/features/ai/AgentConversationPanel.test.tsx -t 'unregistered compact|original retry refusal'`，14:32:22+08:00，3 failed/16 skipped，5.86s；均因不存在显式重试入口失败。最小实现后同命令3 passed/16 skipped，14:34:03，5.52s。中途两项 fixture 误将现有 POST 的 conversationId 排除导致 MSW assertion，纠正为完整原 intent；此运行不记产品 RED。

补充直接关联的 in-flight 拒绝边界 RED：`pnpm test -- src/features/ai/AgentConversationPanel.test.tsx -t 'unchanged base can still be admitted'`，14:36:41，2 failed/19 skipped，7.01s；same-head retry409/403 错误清除了身份及按钮。仅显式 retry 的拒绝分支加旧 base 失效条件后，同命令2 passed/19 skipped，14:37:37，5.02s。保留初次明确拒绝处理和 A→B scope guard。

工具语义 helper 从原 E2E 的 read_result 筛选/计数原样抽出，后续无工具检查初始为空；单独 unit 不导入/注册 Playwright。`pnpm test -- tests/acceptance/ai-context-tools.test.ts` 有效 RED 为6 failed/4 passed，14:33:08，3.25s：正确 read 加 write、正确 JSON 加额外 call/result、缺 call/错 call ID/错工具名均被误接收。一次早期 table fixture 被 it.each 展开为单对象而非数组，已修正，未计入上述 RED。最小 helper 按原 task 检查全部工具项，首轮严格一对同名 read_file、非空且一致 call ID；后三轮（含压缩后）零工具。真实 E2E 四处使用它，并比对 owner-safe 原 task/result route 返回的 call ID；原 sha/content/bytes 验证保留。工具10/10 GREEN，14:33:47，3.36s。

最终 `pnpm test -- src/features/ai/AgentConversationPanel.test.tsx tests/acceptance/ai-context-answer.test.ts tests/acceptance/ai-context-tools.test.ts`：3文件40/40，0失败/跳过，14:38:42，8.82s（Panel21、精确 JSON9、工具10），保留已登记丢 ACK、迟到 A/B、原文和旧 task-only 回归。harness strict tsc（含 helper、两份 acceptance unit）退出0。最终 `pnpm build` 的 typecheck/Vite 均退出0，3805 modules、48.44s，保留旧大 chunk 警告；此前50.61s构建之后有生产修改，故不作为最终构建。真实 E2E/model/browser/cluster/restart/migration 仍 NOT_RUN；未执行真实入口、未设置授权变量。

## 5. 旧代码 / V13 disposable 兼容预演

旧源码基线为 `cb0793c`，隔离临时导出266个backend文件；使用 `git cat-file blob cb0793c:<path>` 保存原始字节，对每个文件计算Git blob SHA1并与 `git rev-parse cb0793c:<path>`核对。首次git archive的工作树换行转换导致raw hash不符，未执行测试；随后全部改用blob字节导出。旧生产源、pom、旧V1–V12 migration及AgentTaskStoreTest保持原样，只改该导出内的 `JdbcStoreTestSupport` 测试scaffold。预演后再次验证其余265文件的原始Git blob hash，确认没有旧生产补丁或migration替换。

scaffold每项新建随机schema，先以本分支V1–V13的filesystem resources迁移，再以旧classpath V1–V12、Flyway11.7.2默认配置执行validate/migrate；断言13行完整history（含checksum/installed_rank）前后相等且migrationsExecuted=0。没有repair、clean、改运行库或关闭validate。随后运行精确旧 `AgentTaskStoreTest`，覆盖真实旧task-only创建/幂等、owner读、tool登记/结果、终态/close/锁/并发和FK回收。旧代码的SQL通过新增nullable列且不需要conversation实体。

预演命令（cwd为隔离导出内poc4/backend）：

```powershell
& 'D:/DeepLearning/Java/IntelliJ IDEA 2025.2.3/plugins/maven/lib/maven3/bin/mvn.cmd' '-Dtest=AgentTaskStoreTest' test
```

结果27 executed / 0 failures / 0 errors / 0 skipped，BUILD SUCCESS，01:53，结束2026-10-19T14:02:06+08:00；27次`OLD_CODE_V13_DEFAULT_FLYWAY: validate/migrate no-op; history13 unchanged`。预期warning为`Schema ... has a version (13) that is newer than the latest available migration (12)`，随后`No migration necessary`，没有关闭validate或补旧代码生产补丁。27项测试退出时scaffold.close删除各自随机schema，没有删除运行schema。

复现scaffold的唯一适配点，在原`var flyway = ...locations("classpath:db/migration")`之前执行当前resources的迁移并保存history，原migration调用换为以下核验：

```java
Flyway.configure().dataSource(schemaUrl, user, pass)
    .locations("filesystem:<current-checkout>/poc4/backend/src/main/resources/db/migration").load().migrate();
var auditJdbc = new JdbcTemplate(new DriverManagerDataSource(schemaUrl, user, pass));
var historyBefore = auditJdbc.queryForList("SELECT * FROM flyway_schema_history ORDER BY installed_rank");
// oldFlyway: 原cb0793c配置的classpath V1-V12，未覆盖ignoreMigrationPatterns/validate。
oldFlyway.validate();
if (oldFlyway.migrate().migrationsExecuted != 0) throw new AssertionError("old code replayed migrations");
if (historyBefore.size() != 13 || !historyBefore.equals(
        auditJdbc.queryForList("SELECT * FROM flyway_schema_history ORDER BY installed_rank")))
    throw new AssertionError("history changed");
```

旧完整源码SHA为`cb0793c74fe76c2aa862560d59e62f467f5c30d8`；该整合阶段worker生产修复SHA为`7a7976da9d1791676860fa3fb73cbb6fb4894c05`，后续前端终审修复为`344ccb9`。本地兼容仅证明默认 `ignoreMigrationPatterns=["*:future"]` 和当前MySQL/JDK/Flyway；真实部署配置可以覆盖它，混合worker/backend/frontend协议、实际迁移权限、大包及备份恢复均未证明。保留新增表/列/V13 history，不能删历史来“回滚”。

## 6. 保留证据和清理

本记录及[审查收尾](review.md)保留各任务有效失败、GREEN、评审结论和全部裁定，SDD原始报告不再是唯一长期依据。Surefire报告留在既有ignored target；短期导出、运行日志及本计划临时SDD包在提取必要证据后清理。清理只在核对过的本轮目录使用LiteralPath，不删除既有项目/集群资源或私有配置。最终功能源码`344ccb9`已获本地实现/发布准备Approved，外部主链仍NOT_RUN。

实际已清理：核对临时导出绝对路径位于本轮SDD目录、全部子项均在其内且0个reparse point后，按LiteralPath逐文件删除849项、从深到浅删除151个目录（含导出根），未使用跨shell删除；另删除8个具名Task6运行日志。逐项确认导出根和8日志均不存在。旧导出265个未修改文件的hash复核在删除前完成；失败最小片段和计数已保存在本记录及Task6报告。当前测试的ignored target/dist为仍有用的本地验证产物，未做广泛clean。

## 7. 2026-10-19 授权发布与真实验收

用户在本地交付后明确授权“发布到集群，然后继续按计划进行”，后续再次要求继续；覆盖本切片镜像push、V13运行库升级、三组件rollout、空闲worker重建和真实模型/浏览器主链。未执行Git push/merge或既有项目删除，Stage2仍PAUSED / NOT_GRANTED。

### 7.1 实际发布、备份与迁移

发布源码`666bfa10d7d852dfefe8115cf149ba44fcf86b26`，工作树当时clean。Context=`kubernetes-admin@learn`，namespace=`manao-stage6b`，三节点Ready。原backend/worker/frontend digest分别为`2472a61595c4a9b4f8b27ecf646dbd7f16788e9c935b0090c57f41ac907ba395`、`33c98b8a95d818d87f02638b64d0b93f69bc796d83802a233c5f964ca2e79a6b`、`6f803accccd627b9b565507068482e70d0c3c4175566d407d180923536a8e532`；repository均`chocologic/manao_images_repository`。新digest和tag由[发布手册](../../../deploy/ai-context/README.md)§1记录。标准backend Dockerfile完整成功，go-offline418.6s、package21.6s；无fallback。worker/frontend标准构建及push成功，具体原始耗时未捕获，不推测。

迁移前全局占用AgentTask0、活动Run0、FlywayV1–V12、项目5/任务25/工具616。`max_allowed_packet=67108864`。私有pre-V13 dump 3,445,056字节、SHA256=`d6701c5c5a24a59997a9067f2fa8daa183ce6042fa62ef0a2cf0b8b7f95e3c75`，路径`C:/Users/shili/AppData/Local/Temp/manao-ai-context-pre-v13-20261019.sql`，不入Git。恢复到唯一临时schema`manao_ctx_restore_20261019_bce3c07330dd`，核对项目5/任务25/工具616/history12后删除该schema；只清本轮恢复样本。dump为UTF8无BOM；完整敏感数据不进入证据附件。

维护顺序：frontend scale0并确认旧Pod删除→重查全局task/run0→backend/worker scale0并确认旧实例退出→只更新BACKEND_IMAGE Secret字段及三个Deployment的image→backend scale1并等待健康/V13→worker scale1→frontend scale1。backend/worker保持Recreate，始终单执行槽，无新旧执行实例重叠。一次Windows `/dev/stdin` patch文件读取失败发生在请求前，无集群修改；改用无BOM具体文件后成功。

backend日志09:13:45Z开始V13、09:13:46Z成功一次迁移，checksum1903213284；V1–V12checksum保持。旧任务25/工具616未变，全部旧task conversation_id NULL、会话表初始0。用户、project、run、tool表checksum前后分别为3707932250/1856844206/1324680815/3861662206。backend readiness UP，frontend入口HTTP200。实际Pod如下：

| 组件 | Pod / UID | imageID |
| --- | --- | --- |
| backend | `backend-79bdd5d9cc-cplqc` / `2764df0f-e178-46b7-8c3f-51945ead0eac` | 本轮backend index digest一致 |
| worker发布后 | `manao-pi-worker-66f5dbc644-bfxfc` / `89c1a1d3-631f-4957-8f28-4dc23fcc84c4` | 本轮worker index digest一致 |
| frontend | `frontend-8678d4cdd5-44dtp` / `5d491fef-b9f3-4ccc-a70d-e2796a3dad2b` | 本轮frontend index digest一致 |

worker内实测Pi三包1.2.0，Node24.22.0，模型key已配置（不输出值）。经真实worker→backend Service请求5/5边界通过：614400字节context和4193280字节chunked context到业务404；4194305字节context返回413/AI_REQUEST_TOO_LARGE；614400字节旧progress仍413；4193280字节compact result到业务404。均使用不存在UUID，没有持久写入；这是传输/过滤器证据，不冒充2MiB原生entry真实持久化。一次probe脚本语法错误未发请求，不计产品失败。

### 7.2 真实验收 round1：FAILED，保留已完成检查点

用户提供既有私有env路径后，仅进程内加载owner keys，实际登录成功，不输出密码/token。新建独立`java-console`项目`4a355478-0ec5-457c-9c73-fad09d98bf79`，creationKey=`68321486-5407-457e-bd7e-6b2dd6c145a0`，name=`ai-context-20261019-11b27a`，无publicPorts/MySQL/Redis/Run。项目Ready后通过原entries/content接口保存顶层fixture，104000字节无秘密ASCII；SHA256=`d9f9f3e50f77e8fcdc373c4cd960974c6d56a9f748e01768691b8e1c357b9766`，回读原文一致，revision23。项目与fixture留存。

模型前预检发现公共ContentResponse无sha256字段；`f3ff508`修复harness从原始content本地计算SHA256，保持path/toolID/content/bytes/truncated精确断言。有效RED2失败/17通过，修复后answer/tools29/29、strict tsc成功，独立审查PASS；仅harness，无镜像变更。

`pnpm test:e2e:ai-context`实际运行1项，56.7s，1failed/0passed；失败点刷新后AI tab不存在，错误页面只有Username/Password/Sign in。此前已完成真实A首轮一次read_file、A第二轮精确bookId7/marker、独立B无工具/无A标记；3task均COMPLETED且revision23未变：

| 会话 | task | 状态 |
| --- | --- | --- |
| A `5c44320a-dc7a-4ac4-940f-26c45e02d149` | `aa90f116-f860-422a-a1be-0ac6873d2e0e` | COMPLETED，配对一次read_file及完整真实结果 |
| A | `28e0e016-2d00-40f2-84b5-9fc785500b72` | COMPLETED，精确JSON/零工具断言已过 |
| B `52635e21-e61a-4d6b-8a05-66c6aeb1678e` | `14842ac9-78cb-4cdd-88a8-2cf3471327a8` | COMPLETED，独立回复/零工具/历史无A标记 |

worker空闲重建已成功，UID从`89c1a1d3-631f-4957-8f28-4dc23fcc84c4`变为`1b89c53c-ead7-4a47-b7c5-5e59b5a69003`（Pod`manao-pi-worker-c4dc6b489-dd7gk`），单副本Ready。之后page.reload使既有memory-only auth回匿名，harness未重新登录而等待AI标签30s；这是确定的验收登录接缝错误，不修改生产认证/不声称持久JWT。A13/13原entries、B6/6留存，无活动task/compact。手动压缩和压缩后模型尚NOT_RUN，本轮FAILED不由后续结果覆盖。

### 7.3 真实验收 round2：FAILED，重复标题定位

`cb2c8b8`仅抽取现有UI登录为共用helper，初始和刷新后均执行，检查HTTP200/非空token/原项目URL；独立审查PASS、strict tsc成功，不改生产认证。相同fixture/project开展明确新一轮，无旧任务重放。`pnpm test:e2e:ai-context`实际1failed/0passed，24.3s；A首轮task=`1ddd84e3-fb54-4c28-9283-733b7cc14b7c`、第二轮=`4d135a5a-8495-49b3-be0f-4a6ea83ce487`，会话A=`1f024689-9082-4694-b93b-03a0d2a65acc`；Btask=`ec43edfa-d211-495b-a159-67f9fc43155e`，会话B=`5280bf87-f1bf-4c71-a062-09d303cb4957`。三task均COMPLETED，严格JSON/工具/隔离断言通过。

worker从UID`1b89c53c-ead7-4a47-b7c5-5e59b5a69003`重建为`1a814039-bcc6-4729-9638-e517b443248c`（Pod`manao-pi-worker-574ccd445d-2675x`），单副本Ready；重新登录已成功。随后按title精确选择A时，round1保留A和新A的前40字符相同，strict locator解析为两个按钮，压缩尚未调用。修复仅在首目标前加入本轮唯一marker前缀，保留精确API标题定位/原UUID/原文与后续prompt不透露约束；未删除历史或以nth绕过，strict tsc和独立限定审查PASS。该真实失败作为RED保留，不宣称本地语义测试已证明真实链路GREEN。

### 7.4 真实验收 round3：PASS，1/1

`1ec80fac28217f8edafb22187d622d5a8440d217`为已独立审查的唯一标题harness修复；`f3ff508`/`cb2c8b8`/`1ec80fa`三次均仅harness，不需要重建镜像。最终`pnpm test:e2e:ai-context`实际1passed/0failed/0skipped，test37.5s、总38.4s。不是`--list`、mock或scripted provider。整个运行使用实际部署、云模型和浏览器，无自动retry；两轮历史FAILED保留。

| 检查点 | 身份 / 实际断言 |
| --- | --- |
| A首轮 | conversation=`0bf75b06-cc6e-491a-9ef6-71e107dadfd9`，task=`4eef5634-85b7-4304-a8e3-ccf11fff0b69`；一次read_file及完整104000字节真实tool result，path/hash/content/callID/非截断逐项匹配 |
| A第二轮 | task=`285576ff-ad10-40e2-9e63-173f3c3e6b1e`；精确原始JSON对象bookId=7和最初marker，无额外字段，无工具 |
| B隔离 | conversation=`7857d6ec-ce56-4940-86ee-01244713b3eb`，task=`ad287324-43d0-47f4-a32e-d8923b5cb88e`；NEW_CONVERSATION、无工具、历史无A marker。此非提及检查为补充，本地SDK实际provider context隔离证据仍单列 |
| 空闲worker重建 / 重新登录 | UID`1a814039-bcc6-4729-9638-e517b443248c`→`cd932d39-14e3-459d-b015-1caa3e1571e8`，新Pod`manao-pi-worker-59bbf74f68-4d58l`，单副本Recreate/Ready；刷新后真实UI重新登录，再打开原A并显示最初完整目标 |
| 手动真实摘要 | request=`1dece225-65e7-4901-92c2-3d6e4b8a8d44`，base13→head14；原生compaction entry=`cb31d480`，seq14，writer=request、source_task_id NULL，7740字节；COMPLETED，无失败码。不是no-op |
| 压缩原文保留 | 压缩前每个安全HistoryItem在after中逐项存在；原13条entries未删，手动压缩追加1条 |
| 压缩后A新轮 | task=`fb955078-5991-4fdd-89f1-2efc8285de9d`，精确原始JSON bookId=8/原marker，零工具，COMPLETED；A最终head19、19rows |

四task均COMPLETED、writesLocked=false，project revision始终23，无应用Run/源码修改。最终A测量context_tokens2229、usage_head_seq19；这是新assistant测量，未把压缩后的未知误记成0。真实摘要质量仅证明本场景约束保留，仍是有损概括。所有原始entries在MySQL，浏览器只读取安全投影。

### 7.5 旧路径冒烟与最终状态

在相同新disposable项目通过原`POST /agent-tasks`提交task=`1155e47e-d5fd-4fc7-ad8b-d7b4c81239e0`，只要求固定`LEGACY_CONTEXT_SMOKE_OK`回复，无工具/文件/Run动作。实际COMPLETED、writesLocked=false、conversationId NULL、工具0。随后字节相同原请求POST重放仍返回同taskId/COMPLETED，没有新会话或重新执行。这是实际模型/旧路由冒烟，不替代原Run/receipt完整矩阵。

最终平台项目6（新增1）、任务36（25旧+10会话轮次+1旧路径）、工具619（616旧+3次fixture只读）、原生entry63、会话6。全局活动AgentTask0、RUNNING compact0，新项目revision23、无活动Run；所有验收项目/会话/原历史留存。发布后backend/frontend Pod不再变化，worker因三轮计划checkpoint共重建三次，最终digest不变。无Git push/merge、无既有项目资源删除。

剩余未执行：真实云端75%自动触发（本地固定1M边界和tool-loop合同已通过，禁止烧入真实窗口）；运行集群回滚演练；更广模型/语言/故障矩阵和Stage2暂停项。本轮按计划不扩测，不以当前主链覆盖Stage2/Stage4。

### 7.6 发布审查、文档与清理边界

独立发布审查核对远端镜像/最终PodUID、V13、三轮日志及显式只读SQL后为APPROVED，无未决发现；唯一Minor提示“marker键仍被提示，只有原marker值未透露”，已准确修正文案并复核关闭。三个harness修复均在提交前独立审查；后续生产源码相对发布`666bfa1`无变化。文档117个实际Markdown链接、10个本轮改动文件UTF8无BOM、git diff --check通过；链接验证剔除fenced/inline代码，避免把`[header,...entries]`代码错认链接。

本轮release临时目录`.superpowers/ai-context-release-20261019`已清点29文件、0子目录、0reparse point，长期证据已提取。自动审批先拒绝整段清理命令，再拒绝具名文件删除命令，均报`blocked by policy`，未执行删除；因此29临时文件仍保留，不能声称清理完成。未继续绕过此拒绝。私有pre-V13备份刻意保留；项目、会话、数据库历史和既有集群资源均未删除。随机restore schema已实际删除并SQL确认0。

## 8. 文件工具详情展示修复（2026-10-19）

用户在实际项目历史发现 `read_file` / `list_files` 展开显示 `Result unavailable`。已确认历史按原 task 读取 settled 结果，但共享展示器只处理 application/app_http_get/build，文件工具成功结果及确定性错误均落到兜底；该文案不能用来判断工具执行成败。修复计划见[文件工具展示](../../../../docs/superpowers/plans/2026-10-19-ai-tool-result-display-fix.md)。

线上只读复现：项目`4a355478-0ec5-457c-9c73-fad09d98bf79`、task`1c69d7c0-9dcd-4927-aec6-1b241eab8ec6`、call`call_01_ET_ddNOLR16C14mWMUxfQZi6651`的详情 GET HTTP200；toolName=list_files，directory=`src/test/java`，entries=1，hasMore=false，无error，页面仍显示兜底。没有重执行工具或调用模型。

本地 TDD：新增文件工具组件测试和原 task 历史入口测试，生产改动前实际运行18 failed / 8 passed，失败为期望内容缺失且DOM只有`Result unavailable`；随后最小实现，同一范围26/26通过。修复仅展示既有安全结果的明确字段，区分空内容/空目录、截断、业务错误及畸形结果，不透传未知字段。write_file 复用同一遗漏分支，一并展示既有path/sha256确认；未增加API、依赖、表、状态或模型调用。

执行目录`poc4/frontend`，实际命令：

- `pnpm test src/features/ai/ToolResultView.test.tsx src/features/ai/ConversationHistory.test.tsx --reporter=dot`：RED18 failed/8 passed；GREEN26 passed/0 failed/0 skipped。
- `pnpm test src/features/ai src/contracts/agentConversation.test.ts src/api/agentConversationApi.test.ts --reporter=dot`：7 files、111 passed/0 failed/0 skipped，10.58s；这是同轮相关整合，不与定向数虚加。
- `pnpm build`：typecheck与Vite构建通过，3805 modules，45.06s；保留已有bundle大小提示，不影响构建，未声称零警告。
- `git diff --check`及三个前端文件UTF-8无BOM检查通过；Git提示现有core.autocrlf会转换LF/CRLF，不是diff空白错误。

独立审查规格和质量均Approved，0 findings。父任务审查包最初由PowerShell数组错误生成，审查员改以实际只读diff核对，主控重建完整包并检查后才完成评审；完整长期结论见[审查记录](review.md) §6。

真实浏览器/发布：frontend镜像`chocologic/manao_images_repository:ai-tool-result-frontend-13d8d1e`按提交`13d8d1e6afc2ead19a8e30ce8b2c0fc7ceb95345`标准Dockerfile构建成功（pnpm typecheck/Vite通过，有既有chunk-size warning），push digest=`sha256:738c3c73d4201cc2d2e67b9eb8e8209f5d63a0518fc88ab9e0292d8893c082cb`。`kubernetes-admin@learn` / `manao-stage6b` 的 frontend Deployment rollout成功，replicas/Ready=1；新Pod`frontend-6956975667-cxcdc` UID=`8a1229de-c723-4b16-8a12-378edc67fb49`，container imageID与该digest一致。旧frontend Pod按RollingUpdate正常退出。未改backend、worker、数据库或schema，未调用模型。

发布后重新登录同一保留项目并打开原会话，无需重执行工具：原`list_files`调用`call_01_ET_ddNOLR16C14mWMUxfQZi6651`（task=`1c69d7c0-9dcd-4927-aec6-1b241eab8ec6`）现在显示目录`src/test/java`和`src/test/java/com`；原`read_file`结果显示`src/test/java/com/example/app/AppTest.java`全文及SHA-256=`ee9cd3fcb1c8695a490df5b37dd52e4faa14bde502a0d24c48d8d1b4c404c321`。二者此前展开均为`Result unavailable`。不含凭据的截图仅保留于本机忽略证据目录，作为本轮浏览器检查留档。

最终状态：Task1/2完成；真实模型不在本次复验范围（无需新工具或任务），真实浏览器历史回放PASS；frontend镜像build/push/rollout PASS。数据库迁移NOT_NEEDED，后端/worker重启NOT_NEEDED，项目及集群资源清理NOT_RUN且不授权。Git push/merge未执行。原兜底文案不再遮蔽已返回的文件工具结果；请求失败和工具业务错误仍分别显示加载失败与返回错误。

## 9. 上下文占用圆环（2026-10-20，本地完成并获授权发布）

用户撤回停止按钮需求，授权直接实现现有占用展示的小改造并更新文档；不另建计划。ContextUsageIndicator 放在推理强度旁，以 SVG 圆环和百分比展示所选会话已有 usage；悬停原生 title 和辅助技术描述含 tokens/contextWindow、75% 自动压缩阈值和最近一次估算说明。沿用两秒会话查询，未新增依赖、API、token 计数器或逐 token 推送。

达到75%使用现有 warning 主题色；图形/ARIA范围限制在0–100，超限原始估算仍显示在文字。已测量0与未知明确区分；压缩后null、缺失usage或所选会话查询失败均不标0，也不继续把缓存值显示为有效测量。切换会话沿用已有owner/project/conversation查询隔离。旧task-only路径不添加无来源的占用估算。停止逻辑、窗口大小、压缩机制和原阶段结论均未修改。

验证：先运行新增组件测试得到缺失实现RED；组件GREEN后新增集成断言得到缺失progressbar RED。最终 pnpm test -- src/features/ai/ContextUsageIndicator.test.tsx src/features/ai/AgentConversationPanel.test.tsx src/features/ai/AgentTaskPanel.test.tsx 为77/77（3+24+50）；覆盖统计更新、0/null、超过100%、A/B切换、查询失败和既有压缩/任务回归。集成失败刷新断言等待React Query异步通知后通过。pnpm build（含typecheck）退出0，保留既有大chunk警告。

本地 Chromium fixture 使用实际 AgentTaskPanel 和项目样式，在1440px viewport内实测504px/320px面板无内部横向溢出、圆环20px、75%和token说明正确，切至未知后无aria-valuenow，pageerror为0；320px截图经人工查看。全局既有1280px最小页面宽度不变，不能把窄面板检查写成移动端页面验收。临时fixture早期因路由匹配/SPA fallback未加载，修正测试入口后通过；未修改产品路由。临时脚本、截图在核对后清理。

初次本地交付时镜像构建、push/rollout、真实云端浏览器/模型验证NOT_RUN，尚未Git提交；这是本地检查点。用户随后明确授权“提交git之后部署到集群”，实际执行与结果由下面9.1取代该检查点的未发布状态。

### 9.1 Git 提交、前端单镜像发布与真实浏览器核对

实现提交1f41cf575014d70aa83212b26cca45b00cd801a5（feat(ai): show conversation context usage ring），提交前重新运行三个定向测试文件77/77。标准frontend Dockerfile使用VITE_ENABLE_AI=true与该源码revision标签构建成功，包含typecheck/Vite；保留既有chunk-size warning，运行USER101、linux/amd64。镜像tag为chocologic/manao_images_repository:ai-context-usage-frontend-1f41cf5，实际push/registry确认OCI index sha256:7149afb9cd7feed8c9a5d0ff1ea5048f54103e93a8974a957ea094309b6bf37c，amd64 child sha256:42acac365dc5eae8ac161055b5b59e4ec4b7ec40d5ab92e792a30d5b1524250d。

实时确认context=kubernetes-admin@learn、namespace=manao-stage6b，三个节点Ready、三Deployment原Ready1/1。仅frontend从旧摘要8d90abdf44f5e2af50c61810b8640e532e1e8b95bffdd9172f017f929e82b89a更新至新index摘要；RollingUpdate成功，新Pod frontend-94bd6cff9-bxg86，UID=c42b3cba-3316-46ba-8229-d597b43cd7a6，imageID匹配新摘要，generation/observed21、updated/ready/replicas1，restart0。旧frontend Pod按滚动更新退出；backend与worker的Pod UID、generation、digest均与本次发布前一致，Ready1/1/restart0。未执行数据库迁移或项目/Run/集群诊断资源清理。

公网http://1.12.245.235:30080/返回200，新入口index-0JstDDrj.js和index-dST7lErr.css已生效。真实Chromium使用私有已有owner凭据通过正常登录页，打开保留READY项目4a355478-0ec5-457c-9c73-fad09d98bf79的已有会话6328bc93-fb38-4da3-a305-dad64b825f69（headSeq26）。DOM圆环20×20、显示“约0.3%”（页面实际含空格），ARIA原值0.2511024475097656；title显示2,633 / 1,048,576 tokens与75%阈值，逐项匹配owner会话GET。pageerror0；浏览器拦截并拒绝登录之外的非只读API，实际unexpectedMutations0。仅回放已有历史，没有新task、工具、压缩或模型请求，项目前后READY。临时浏览器验证脚本已清理，未留凭据或原始会话正文。

本次frontend镜像build/push/rollout与公网真实浏览器回放PASS；未知/超限/75%边界仍由前述本地测试证明，本次没有烧入真实上下文窗口或扩测。发布事实另作文档提交，镜像源码仍为1f41cf5，无须为文档重建。Git push/merge未执行；Stage2原暂停/未授予状态与Stage4范围不变。
