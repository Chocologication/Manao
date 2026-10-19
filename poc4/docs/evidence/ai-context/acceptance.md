# AI 多会话与上下文切片：实施和验证记录

日期：2026-10-19。分支 `codex/ai-integration`，实现起点 `cb0793c`；本轮获授权实施、本地验证、顺序独立评审和发布准备，未获授权调用云模型、发布镜像、部署/重启服务、迁移运行库、Git push/merge 或删除既有项目。本记录拥有本切片证据；[设计](../../../../docs/superpowers/specs/2026-10-19-ai-conversation-context-design.md)、[计划](../../../../docs/superpowers/plans/2026-10-19-ai-conversation-context-implementation-plan.md) 与[发布准备](../../../deploy/ai-context/README.md)分别拥有接口、任务和操作步骤。

## 1. 交付与判定边界

已实施项目内多会话、同会话多轮 AgentTask、MySQL 原生历史、固定 1,048,576/786,432 窗口/阈值、Pi 原生自动压缩、空闲手动压缩及浏览器历史。不同会话只共享代码；完整历史不来自截断 progress；旧任务不自动续跑，旧工具不重新执行。运行/文件/工具 ledger 与原有项目互斥仍属原模块权威。Pi 三包仍锁定 1.2.0，预算仍为 1800s / 180 tools / 20 builds。

| 证据面 | 本轮结果及限制 |
| --- | --- |
| backend 相关八套 / 随机 disposable MySQL | 最终结果见 §4；不连接或 reset 运行 schema |
| 真实安装 Pi SDK + scripted provider | 最终 121/121；真实 SDK 时序和实际 provider context 捕获，未访问云模型 |
| frontend 组件/API/parser + typecheck/build | 165/165；局部 Vitest/MSW，不是实际浏览器 |
| V12→V13 additive 升级 | Store 测试通过，旧 task/tool 值保留、旧 task 的 conversation_id 为 null；新表及项目级 FK 回收在测试 schema 验证 |
| 精确旧代码 + V13 兼容预演 | 见 §5；不等于真实部署混合版本或可回滚保证 |
| 真实模型多轮/摘要质量 | NOT_RUN，未获本轮模型调用授权，服务端凭据未加载 |
| 真实浏览器主链 | NOT_RUN；入口在 config 缺授权/环境时退出1，没有启动浏览器、服务或模型 |
| 真实自动 75% 场景 | NOT_RUN；注入 usage 的 786431/786432/786433 边界不冒充云端长上下文 |
| 云端迁移、空闲 worker 重建、手动摘要 | NOT_RUN；仅本地恢复/互斥/原生摘要合同证据 |
| 三镜像构建/push/rollout、备份恢复、内部大包 | NOT_BUILT / NOT_RUN，见发布准备；无本切片 digest |
| 既有项目/集群清理 | NOT_RUN，未授权；本轮只回收自己的随机测试 schema 和本地临时导出 |

本切片没有云端 PASS。原 Stage 1 的真实 `PI_STAGE1_CODE_TEST_LOOP_PASS` 保留；Stage 2 仍 PAUSED / NOT_GRANTED；Stage 3 由用户实际图书 CRUD 使用确认使命提前完成，未据此启动 Stage 4。

## 2. 顺序任务、RED/GREEN 与审查

以下是当时版本的局部证据，不把早期组合改称最终 HEAD。每项完成后由主控派发独立规格/质量审查；Task 1 的 Important/Minor 已关闭，Task 2–5 最终无未解决功能发现。Task 6 和整体分支的最终审查由主控另行记录。

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

旧完整源码SHA为`cb0793c74fe76c2aa862560d59e62f467f5c30d8`；本轮唯一生产修复SHA为`7a7976da9d1791676860fa3fb73cbb6fb4894c05`。本地兼容仅证明默认 `ignoreMigrationPatterns=["*:future"]` 和当前MySQL/JDK/Flyway；真实部署配置可以覆盖它，混合worker/backend/frontend协议、实际迁移权限、大包及备份恢复均未证明。保留新增表/列/V13 history，不能删历史来“回滚”。

## 6. 保留证据和清理

本记录保留各任务有效失败、GREEN、评审结论和全部裁定，忽略目录中的SDD原始报告无需作为唯一长期依据。Surefire报告留在既有ignored target；短期导出和运行日志在提取计数/失败后清理。清理只在核对过的本轮临时目录使用LiteralPath，不删除既有项目/集群资源或私有配置。最终提交/整体验收状态由主控在最终审查后登记；此处不自授整体PASS。

实际已清理：核对临时导出绝对路径位于本轮SDD目录、全部子项均在其内且0个reparse point后，按LiteralPath逐文件删除849项、从深到浅删除151个目录（含导出根），未使用跨shell删除；另删除8个具名Task6运行日志。逐项确认导出根和8日志均不存在。旧导出265个未修改文件的hash复核在删除前完成；失败最小片段和计数已保存在本记录及Task6报告。当前测试的ignored target/dist为仍有用的本地验证产物，未做广泛clean。
