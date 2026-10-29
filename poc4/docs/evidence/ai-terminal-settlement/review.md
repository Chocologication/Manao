# AI 任务可靠收尾：最终审查与交付裁定

日期：2026-10-26。基线 `8d4c573`，生产代码终点 `5739d1b`，分支 `codex/fix-ai-terminal-settlement`。之后的状态对齐提交只修改文档。

## 1. 最终结论

**LOCAL_REPAIR_VERIFIED / Ready for local delivery: Yes。** Task1–8逐项规范与质量审查完成；整分支审查发现0 Critical、1 Important，经唯一修复波次及限定复审确认ADDRESSED、无新增Critical/Important。此前Minor按实际影响分级后保留，不宣称不存在所有缺陷。

此处LOCAL结论是发布前审查。随后用户另行授权集群部署和一次最小真实模型任务，2026-10-26已取得DEPLOYED_SMOKE_VERIFIED，详见[验收第8节](acceptance.md#8-2026-10-26-实际集群部署与最小真实验证)。完整云端故障矩阵NOT_RUN，原故障Task NOT_REPAIRED、Stage2 PAUSED/NOT_GRANTED不变；未Git push/merge。发布身份、备份与回退边界见[手册](../../../deploy/ai-terminal-settlement/README.md)。

## 2. 审查经过

- Task4 legacy MISMATCH假ACK修复复审通过；Task5安全诊断Important修复复审通过；Task6恢复调度和Task7当前任务结束入口均Approved。
- Task8实际MySQL/HTTP/生产Worker/Pi SDK/生产组件页面8/8；审查发现晚到终态断言存在异步空窗，补强为等待同task/report/hash的真实CLOSING ACK及slot释放，再断言DB结果不可逆；限定I用例1/1通过，独立复审Approved。
- 整分支唯一Important：丢失start ACK后只根据Worker终态调用beginClose，会关闭合法成功收据并停止READY应用。提交5739d1b改用统一settlement.reconcile。RED5项中4失败；GREEN5/5；Service52+Settlement7+Reconciler6共65/65、exit0。原审查者复审确认ADDRESSED、无新问题。

## 3. 验证与边界

- Worker181 passed、1个专用长驻harness显式opt-in skipped；目标前端211/211；typecheck/build/harness tsc和boundary36/36通过。
- 完整backend实际运行962项，原结果4 failures /7 errors /2 skipped，不能写成全绿。失败均为测试配置污染、迁移字段投影和旧DROP夹具；全部失败类及相关迁移夹具最终60/60复验通过。最后生产修复另有65/65覆盖回归。没有最终源码单次完整962项全绿结果。
- 浏览器是生产任务/会话/Run组件页面，不是完整Workbench/Ingress/真实Kubernetes验收；WorkspaceAgent/JobCoordinator外部事实受控，1800秒使用注入Clock，未真实等待1800/7200秒。
- 不响应中断的外部调用可能继续运行；唯一seat、claim及项目占用保持至实际退出。这是已知liveness限制，不承诺2秒内物理停止或HA。
- 共享target的并发Maven诊断批次及中止批次未作为PASS；实际命令、失败、顺序复验与协调差错均在验收记录中保留。
- 最终owned服务/schema及新scratch已清理。11个早期本轮Temp目录与隔离browser-classes删除被自动策略拒绝，确切清单已保留；未重试或换工具绕过。SDD日志与裁定保留用于追溯，不声称临时文件全部清空。

## 4. 非阻塞项

整分支审查确认下列为Minor或已披露liveness限制，本轮不追加平台重构：

1. 8KiB检查与存储envelope约20B差异、deadline零行UPDATE防御、两个size错误码；正常Worker完整wire限长和身份ACK未见假确认。
2. 重复close的展示failureCode可采用caller值，持久close_reason_code保持预算原因；不逆转终态或扩大清理。
3. malformed200重推、pull GET外层abort、dispose后诊断、pull错误静默、instance前缀长度及部分直接覆盖。
4. 静态IO executor跨Spring context生命周期、非合作IO保留全局seat，保持fail-closed但存在liveness边界。
5. cleanup await返回值、重复harness、owner vacuous断言、transition(false)重试与cadence专项测试缺口；关键行为另有直接覆盖。
6. 既有JVM/弃用API、jsdom媒体、颜色环境和Vite chunk警告；日志已披露，不称pristine。

## 5. Rulings I made

按账本出现顺序列出全部11条裁定和判断错误的代价；原始账本仍保留。

| # | 裁定 | 若判断错误的代价 |
| --- | --- | --- |
| 1 | 按实际空闲迁移号使用V15，后续计数另加V16 | 版本错误会阻塞Flyway升级，需修订未发布迁移 |
| 2 | Task1直接驱动fresh recovery竞争；Task6保留启动/接管恢复 | 若夹具未触达真实锁，会削弱证据；原夹具已复验 |
| 3 | Task4仅创建计划要求的缺失测试文件 | 若文件对应行为遗漏，需要补测试 |
| 4 | Task1的Modify test only按许可范围解释，允许独立fixture | 重复harness可能随构造器漂移，维护成本增加 |
| 5 | 接受parked-row fail-closed、既有build fixture修正、QUEUED GET身份绑定鉴权写 | GET不完全只读，审计或兼容预期可能需要调整 |
| 6 | Task3复用既有tool-side finish，无行为缺口时不强制改列出的文件 | 可能遗漏隐含tool-side缺口，由行为测试及终审缓解 |
| 7 | Task5在authenticated Worker GET补冻结report正文 | 内部响应增长，必须限长并保持不进入诊断日志 |
| 8 | 允许小型单调预算及step-only adapter，receipt查询锁外执行 | adapter表面增加，非合作调用仍有liveness限制 |
| 9 | Task8修复旧固定schema/DROP及版本断言，改一次性数据库 | 额外测试变更需迁移回归，不能掩盖产品失败 |
| 10 | V16 reconcile_attempt独立计数，避免updated_at进度更新破坏退避 | 增加一个加法迁移/字段，发布回滚需考虑V15/V16 |
| 11 | Task7顺带修复服务倒计时参数顺序 | toolbar展示可能回归，服务端寿命不变，固定Clock测试覆盖 |

### 原始Ruling记录

原始文字按顺序附于本节，避免裁定仅留在临时账本。

| T2/T5 vs migrations | V15 additive fields | Plan says "下一未占用迁移版本（当前为V15）" — must verify actual next free version in db/migration before implementing; ruling: use the actual next free number, update doc references if it is not V15. |

| T6 vs T1 | T6 reduces periodic recovery frequency; T1 race fixture requires recovery to still contend the gate | Potential conflict. Ruling: T1 fixture drives `recoverRuns()` directly (as the diagnostic does), so the test remains valid regardless of RuntimeMaintenanceLoop cadence; T6 keeps startup/takeover marking. Both hold. |

| T4 self-check | terminal-delivery.ts new + pi-session/server/backend-client edits | Plan names test files (terminal-delivery.test.ts etc.) that may not all exist yet; implementer creates missing ones. Ruling: create only the files the task lists as missing (per plan Task 4 wording "新增terminal-delivery.test.ts" implied; extend existing where present). |

- Ruling: brief line "Modify test only: BT/ai/AgentTaskServiceTest.java" is interpreted as a permission-scope qualifier (if that file is touched, only test changes are allowed), not an implementation mandate. Task 1's fixture is intentionally self-contained (SettlementHarness mirrors AgentTaskServiceTest's harness); acceptance is met by the two created files. Cost if wrong: production-constructor drift could desync the two harnesses silently — deferred to final review to triage consolidation.

- Ruling: reviewer verified implementer's three concerns as sound (fail-closed parked-row fix + regression test; DevelopmentBuildExecutorTest fixture fix genuinely pre-existing-failure + fixture-level only; GET /terminal QUEUED instance binding is auth-write not business side effect, consistent with design's dual "reuse execution auth" + "read-only no side-effect" clauses).

- Ruling: brief Files listed AgentProjectTools.java/AgentProjectToolsTest.java but they are untouched — behavior (unsettled-receipt verification, identity close, no replay) is carried by existing finishForClose/applicationCanRelease with orchestration in the new service; accepted as implementation convergence with no behavioral gap. Cost if wrong: hidden gap in tool-side close behavior — mitigated by behavior-level tests pinning those paths.

- Ruling: Task 5 may add frozen terminalDelivery.report to authenticated Worker GET /tasks/{id} plus its tests — Task 4's response lacked the report body, making required pull recovery impossible. Keep /status and logs body-free. Cost if wrong: slightly larger internal status responses; bounded existing 8KiB report cap mitigates.

- Ruling: Task5 may add a scoped monotonic reconciliation budget helper and small step-only cleanup overloads for original build/receipt/Run boundaries — existing build close can poll120s, contradicting the accepted independent 5s scheduler and <=2s IO constraints. No shared runtime redesign, no broad resource cleanup. Cost if wrong: modest extra adapter surface requiring targeted tests; keep legacy API behavior for other callers.

- Ruling: Task8 includes the small existing persistence fixture repair before any whole-backend suite — AtomicTransitionTest still destructively resets a fixed-name schema and fails with V12 FK; latest version assertions still expect11. Use JdbcStoreTestSupport create/close and actual additive V15 expectations, keep production migrations untouched. Necessary for this repair's explicit disposable-schema-only testing contract and trustworthy complete verification. Cost if wrong: extra test-only changes require focused migration/atomic tests and final review.

- Ruling: approve new additive V16 reconcile_attempt counter after verifying free version — updated_at changes with progress and cannot durably encode retry attempts. Default0; atomic5/10/20/30s cap; genuinely new receipt/first close resets, duplicate delivery/repeated close does not reset. Cost if wrong: one extra additive migration/column; migration and restart tests required; release guide must include V15+V16, no destructive rollback.

- Ruling: include service countdown argument order fix within Task7 lifetime display — existing formatRunElapsed(expiresAt,nowMs) clamps remaining tozero. Fixedclock test required. Cost if wrong: toolbar-only presentation regression; no server lifespan changes.

## 6. 提交记录

- `e6401cf docs(ai): import terminal settlement investigation and repair plan`
- `b960f85 test(ai): add terminal settlement race regression fixtures`
- `0ecf771 fix(ai): persist terminal receipts before settlement`
- `9ce41ed fix(ai): persist terminal receipts before settlement (receipt entry)`
- `08f7ea4 fix(ai): persist terminal receipts before settlement (worker identity)`
- `a8ddfc1 fix(ai): reconcile receipts through verified task settlement`
- `e522d78 fix(worker): separate terminal delivery from model execution`
- `6a00120 fix(ai): reconcile pending task outcomes and enforce deadlines`
- `932f27e fix(run): separate startup recovery from periodic reconciliation`
- `3e9ffa0 fix(ui): clarify task settlement and application stop controls`
- `fc2bbd6 test(ai): verify terminal settlement recovery and release boundaries`
- `61a2859 test(ai): await late terminal acknowledgement before immutable verdict check`
- `5739d1b fix(ai): preserve successful outcomes during lost start recovery`
