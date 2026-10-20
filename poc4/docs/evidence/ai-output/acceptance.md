# AI streaming / reasoning / Markdown acceptance

Updated 2026-10-20. Branch codex/ai-integration. Final product-suite baseline adb63f64d16e22b74b0d1fb818a44a53abf69489. This is the unique actual-status authority. [Design](../../../../docs/superpowers/specs/2026-10-20-ai-streaming-reasoning-markdown-design.md), [plan](../../../../docs/superpowers/plans/2026-10-20-ai-streaming-reasoning-markdown-implementation-plan.md), [release guide](../../../deploy/ai-context/README.md) own contracts/preparation.

## Verdict

Required local combination PASS. All six tasks are complete within the authorized local implementation / verification / release-preparation scope. Independent final scoped rereview at `c68c773` confirms I1 late-authoritative-ACK precedence, I2 cross-message/cross-round harness evidence and M1 malformed worker effort arrays ADDRESSED, with no new Critical/Important finding. Task6 Spec COMPLIANT / Quality Approved; whole feature **Approved for local implementation completion**. The earlier Needs fixes verdicts are retained as review history, not the current local verdict.

The preceding local verdict is unchanged. On 2026-10-20 the user separately authorized cluster publication and continuing the confirmed plan. Three images from `a7d0041` are BUILT / PUSHED / DEPLOYED and runtime V14 applied once; private backup/disposable restore and actual-old-image artifact compatibility checks passed. **Publication PASS; combined real acceptance remains FAILED / low streaming coverage UNVERIFIED.** All four persisted efforts and actual provider whitelist parameters are verified, including max not downgraded; high/off browser checkpoints and the bounded max continuation passed. Failed round1/round2 remain retained. The temporary wire probe and disposable restore schema have been removed, final replicas/health verified. Runtime reset, existing project/resource deletion, Git push/merge and Stage2/Stage4 expansion remain unperformed; Stage2 stays PAUSED/NOT_GRANTED and original real-provider75% NOT_RUN.

## Actual final local combination

| Command (component cwd) | Result 2026-10-20 |
| --- | --- |
| backend: mvn -Dtest=AgentTaskStoreTest,AgentTaskServiceTest,AgentConversationStoreTest,AgentConversationHttpContractTest,AgentConversationCompactionTest,AgentInternalSecurityTest,AgentLiveOutputTest,AgentLiveOutputHttpTest test | exit0;127 tests,0 failures/errors/skipped;BUILD SUCCESS;4:56 |
| pi-worker: pnpm test | exit0;9files147/147;17.36s |
| pi-worker: pnpm build | exit0 |
| frontend: pnpm test -- src/features/ai src/contracts/agentConversation.test.ts src/api/httpClient.test.ts src/api/agentConversationApi.test.ts src/components/shell/WorkbenchShell.test.tsx | exit0;13files282/282;57.56s |
| frontend: pnpm typecheck; pnpm build | both exit0;4066modules;48.32s;inherited >500kB warning |
| frontend: node --test scripts/ai-output-harness.test.mjs |3/3 guard/history assembly |
| frontend: pnpm exec tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --strict --skipLibCheck tests/e2e/ai-output.spec.ts playwright.ai-output.config.ts | exit0 |

Backend used process-local approved credentials loaded silently, explicit jdbc:mysql://127.0.0.1:3306/manao_poc4_test and JdbcStoreTestSupport unique disposable schemas created/migrated/dropped by tests. No runtime URL/config imported. V14 exists locally; runtime migration NOT_RUN. [Raw summary](local-verification.txt) retains class counts/results; ignored SDD logs retain detail. Existing Maven/bundle warnings remain.

## SDK / browser evidence

New installed-Pi controlled-fetch integration restores one conversation high→off→low→max, invokes read_file once, captures each actual SDK request and asserts stream=true/max_tokens=8192 plus thinking disabled for off, enabled with unchanged reasoning_effort otherwise. Native thinking_level_change order and multiple delayed thinking/text snapshots while generating are asserted. Max controlled length remains FAILED/AI_LENGTH_LIMIT. Focused1/1 (8 filtered skipped), then full147/147. Supplemental assertion passed existing behavior: no new product TDD claim, no paid DeepSeek. Existing SDK cases cover manual/auto compaction/length summaries.

Loopback Vite/Chromium fixture exercises real HttpClient/parser/hook/ConversationHistory plus legacy Panel. Actual HTTP SSE multiple thinking/text snapshots, UTF8 codepoint split, close→second authenticated GET; generating DOM before ended; thinking fold/upward read/history single promotion/choice transfer/scope switch pass. Model length warning distinct from display clipping. API GET-only,closeCalls0,pageerrors[]; owned4190 closed. [Metadata](local-browser-results.json), [reviewed screenshot](local-browser.png). Full-panel browser lock/close not proven: component evidence only. No cloud/proxy/provider/relogin or new late-ACK race proof.

## Original real-entry preparation snapshot (superseded by authorized release below)

pnpm test:e2e:ai-output uses playwright.ai-output.config.ts/tests/e2e/ai-output.spec.ts. Config requires four MANAO_AI_ACCEPTANCE_BASE_URL/PROJECT_ID/USERNAME/PASSWORD variables and current MANAO_AI_OUTPUT_MODEL_AUTHORIZED exactly true before browser launch; explicit origin/canonical UUID, no webServer,workers1/retries0,trace/video/screenshots off. Missing-env --list exit1 NOT_RUN; test-only loopback/fake-env discovery1 test, no browser/model. These are not real-model PASS.

Separately authorized run: existing owner-owned READY project and <=16KiB secret-free README.md; new conversation four short read-only high/off/low/max tasks. First only read_file and safe original result/path/content/hash; others no tools. Observe DOM/frame timing before click, multiple generating text snapshots and thinking/text before ended/ACK; disconnect/reconnect GET, refresh→explicit UI login→same history/effort, Markdown/folding and no resubmit. Too short fails UNVERIFIED; max length FAILED/AI_LENGTH_LIMIT fails acceptance. No code edits/app/create/delete/restart. Provider wire NOT_CAPTURED_BY_BROWSER; operator separately captures only thinking/reasoning_effort/stream/max_tokens at authorized boundary. No invented endpoint or key/prompt/thinking/raw logs.

## Commits / TDD / reviews

Task1 1d09f04..ea32755; Task2 d3ea5c7; Task3 356e492..8a1f182; Task4 fca63d2; Task5 b9853f4..adb63f6 (including b51c91e). Independent task gates passed after fixes. Task1 supplementary assertions and Task4 later capacity assertions followed core implementation; task reports disclose this, core behavioral RED observed. Task5 races RED/repair/rereview. Task6 identity is commit containing this record; controller task-6-report records SHA after commit. Guard/history stub RED3→GREEN3; initial missing-module setup failure not RED. SDK assertion passed existing behavior; reused browser fixture passed once; no production mutation. Harness quoting/patch/Python newline setup errors corrected, not behavioral RED.

Final scoped independent rereview passed at `c68c773`. Deferred nonblocking: isolated third-per-task subscription/cache-loss-next-pulse assertions absent; full-panel browser lock/close unproven; inherited warnings. No extra coverage claim or new external acceptance.

## Final scoped fix wave (2026-10-20)

- I1: newer accepted ACK cuts take precedence after bounded history covers the old cut. Terminal late C6/current=null promotes the fuller answer exactly once; malformed/disconnect races retain old output while loading and promote the newest pending draft. Lost-ACK mismatch handling remains conservative; fold choices transfer. Three real History/HttpClient/parser/hook DOM cases failed before repair. A removed extra no-warning assertion incorrectly forbade the legitimate new unconfirmed draft warning under fallback; this oracle correction is not additional product RED.
- I2: local fixture executes the same extracted browser observer as the real entry. taskId/messageOrdinal scope timing; the last answer-bearing native history group selects the answer ordinal/seq. Own ended/ACK is awaited, ignoring prior tool-only completion; current answer group scopes Markdown, folding and restored text. Three behavior REDs (tool-only false failure, earlier preamble false timing pass, prior-round Markdown false pass) became GREEN. Attachments retain identities/timestamps/revisions only, no model text. Authorization remains before browser launch.
- M1: actual worker HTTP start rejected malformed effort array after string-type validation. RED was 200 versus expected422; no runner created after repair.

| Focused command (component cwd) | Fresh result |
| --- | --- |
| frontend: pnpm exec vitest run src/features/ai/ConversationHistory.test.tsx src/features/ai/useAgentLiveOutput.test.tsx src/features/ai/AgentConversationPanel.test.tsx | exit0;3files71/71 (35+13+23) |
| frontend: node --test scripts/ai-output-harness.test.mjs | exit0;6/6 (3 retained guard/history +3 oracle regressions) |
| frontend: scoped tsc command in the baseline table | reported exit0 on final spec; report/summary evidence only, named raw log was not retained |
| frontend: pnpm typecheck; pnpm build | exit0;4066modules;46.21s;inherited bundle warning |
| pi-worker: pnpm exec vitest run test/server.test.ts; pnpm build | exit0;47/47;build exit0;expected fixed-error test stderr |
| frontend: pnpm test:e2e:ai-output --list with authorization unset | expected exit1 NOT_RUN before browser |

Task6 backend127/worker147/frontend282 above remain the earlier combination baseline, not rerun totals. No backend/full suite, real model/browser/cloud/runtime migration/image action was performed in this fix wave. Local DOM fixture evidence does not add HTTP-browser or provider acceptance. Raw focused logs and final-fix-report live beside the local SDD review artifacts; the commit carrying this section owns the repair delta.

## Final independent closeout

The [independent final rereview](review.md) checked the exact `3a2b194..c68c773` repair, the original findings and focused RED/GREEN evidence. I1/I2/M1 are ADDRESSED; no new Critical/Important finding. Fresh focused results are frontend71/71, worker47/47 and harness6/6, with the corresponding builds/typecheck passing; these supplement, rather than replace or inflate, the earlier127/147/282 combination. The absent `final-fix-harness-tsc.log` is a Minor evidence bookkeeping issue: the command was silent and its successful execution result was not saved as a raw log. Exit0 is supported by the implementer report and tracked summary, rather than independently inspected raw output. No validation run was invented or repeated to conceal it.

At this local-only closeout checkpoint, Task6 Step4 was NOT_RUN / separately authorized. The later explicit authorization and actual publication/model results are recorded in the dated release section below and supersede this historical not-executed snapshot. The branch and isolated worktree remain retained, with no Git push/merge; user acceptance has not been granted. Useful RED/failure logs and independent review reports remain in ignored local evidence.

Local temporary cleanup is BLOCKED: automatic approval review rejected the targeted removal of those regenerable packages/duplicate files with `blocked by policy`. The command did not execute, no alternate deletion method was attempted and no files were removed. The exact current-plan inventory and blocked outcome remain in ignored SDD `cleanup-inventory.md` / `cleanup-results.md`. This artifact-cleanup limit does not change the completed local feature verdict.

## Authorized cluster publication and real acceptance (2026-10-20)

The user authorized publication and continuation of Task6 after local closeout, and requested future subagents avoid Astra. This release uses Sol subagents. Source `a7d004119dd2439d09a4ef86890b2f8ab00658d7` was clean; context `kubernetes-admin@learn`, namespace `manao-stage6b`, all three nodes Ready. Before maintenance: global occupying tasks0, running compactions0, active Runs0; projects6/tasks38/tools631/conversations7/entries92. No existing project was modified or deleted for release.

### Images and deployment

Repository: `chocologic/manao_images_repository`. Standard Dockerfiles succeeded (backend go-offline reused its valid cached layer); no runtime fallback. Frontend built with `VITE_ENABLE_AI=true`, mock/experimental flags false.

| Component / tag | OCI index digest | linux/amd64 child digest | Published Pod / UID |
| --- | --- | --- | --- |
| backend / ai-output-backend-a7d0041 | sha256:726c095f15d4866fbcea48146c90faf2fb1a6d680f02629f6ea893e49f694af1 | sha256:ad14237076c79a99269d365522ff8562c8439ce4aea47645f219621415217fbc | backend-7498788bdd-ktdhn / a5851be2-d432-4cbc-8c4d-3e5fb1d653f9 |
| pi-worker / ai-output-worker-a7d0041 | sha256:dd06e4148d466127914ebf0bc04e27b5f078d4061f4485f1c0b4221831e269f8 | sha256:6014b4f22ea0e6a8b4a107986a0c7f4b907724cd787c0f29917fb2d159f91d76 | manao-pi-worker-9c5c7f94-h4ln9 / 5b6832f8-3d65-484f-a145-aae218a5d91f |
| frontend / ai-output-frontend-a7d0041 | sha256:8d90abdf44f5e2af50c61810b8640e532e1e8b95bffdd9172f017f929e82b89a | sha256:274e05e3b149727e6955fe98f08ebb314ea50724dcc7bbcf2927da3371943114 | frontend-54f498b688-gcrs4 / d20fb23d-b2b9-45bb-b015-bf5146aa1337 |

All actual Pod imageIDs match the index digests, one Ready each, restart0 at publication. Backend/worker retain Recreate and one execution slot. Maintenance: frontend0 and old Pod exit; global idle recheck; backend/worker0 and old Pods exit; update matching images and BACKEND_IMAGE reference; backend1 and V14/readiness; worker1; frontend1. Backend JRE17.0.13, USER10001 and both HTTP retry JVM flags preserved; actual worker Pi packages all1.2.0. Public frontend200 and backend readiness200/UP verified. Later worker instrumentation removal will change only its Pod UID and is recorded separately.

### Backup, disposable rehearsal and V14

Private pre-V14 dump retained outside Git:4,492,169 bytes, SHA256 `e1bba6d8b9276279ffd6051f019693aaf500f7785c98ee9fc81180420add3484`, UTF8/noBOM. Restore into unique `manao_output_restore_20261020_4cd010e2056f` matched V13 history/counts/table checksums. Actual new image artifact migrated that copy once; actual previous backend image artifact then ran its own Flyway11.7.2 with default validation/future behavior, migrations0, and all38 owner-scoped task reads succeeded while all efforts stayedNULL. This is isolated Flyway/store compatibility, not full old application startup, old writes or a real-cluster rollback rehearsal. No reconciliation scheduler or second backend was started. An initial standalone validate-before-migrate probe rejected pending14; it was corrected to the real migrate(validate-on-migrate) then validate order and is not a runtime migration failure.

Runtime V14 applied once at03:29:11.982Z–03:29:12.183Z, checksum1063954255/success1; original V1–V13 checksums unchanged. Column is nullable varchar(8), all38 existing tasksNULL. Six tables project/task/tool/conversation/entry/run, ordered SHA256 over every original column (excluding only the new effort column), match before/after exactly. No runtime reset/drop/repair. Restored disposable sample cleanup remains pending and must be reported by actual result.

### Real round1: FAILED, retained

Existing owner-owned READY project `4a355478-0ec5-457c-9c73-fad09d98bf79`, README.md271bytes, revision23, was read-only prechecked. New conversation `2553598f-15e8-4506-902c-51ddd839316d`, high task `57731c5c-67f5-473f-b339-fd555fd640cd` completed at03:32:48.487827Z–03:32:51.387114Z; exactly one settled read_file, no changed paths/Run. Real browser test1failed,34.8s: line60 expected successful live GET count>=2 after offline500ms, received1. It had waited until body text before disconnect; task settlement/terminal reconciliation can legitimately close the display subscription. This is not a four-effort PASS and no old task was replayed. Off/low/max were not reached.

Temporary worker-only preload observes the exact provider POST boundary and emits only timestamp/sequence, thinking.type, reasoning_effort, stream and max_tokens. It forwards original fetch exactly once; no headers, model text, raw thinking, prompt or response are logged. Round1 actual two provider requests both enabled/high/streamtrue/max_tokens8192. Native metadata: seq6 assistant/toolUse with thinking+toolCall, seq8 assistant/stop text only. Thinking is therefore checked on its actual assistant message independently from final-answer text timing. A local effective-RED reconnect harness repair and independent review are in progress before a new real round; local fixture results will not replace provider evidence. Temporary probe removal is pending at global idle.

### Harness reconnect repair and real round2: FAILED, partial checkpoints retained

Harness-only commit `310fa9a61727796323308d5644fac7edf9a49044` fixes the late offline checkpoint: a high-only observer-owned AbortController interrupts the first real browser fetch once generating API thinking and same-message DOM are both observed. The original caller signal, provider/task execution and response bytes remain untouched; the product must issue its own second GET. The real test immediately GETs the same task and requires RUNNING at reconnect. Thinking is checked task-scoped on the actual thinking message; final answer still requires own ordinal, DOM before own end and at least two generating revisions. No prompt or token-budget increase.

Effective local RED6pass/1fail (reader still reading), then7/7; task-thinking oracle RED7pass/2fail, then9/9. Scoped TypeScript, diff and UTF8 checks passed. Independent Sol review Spec COMPLIANT / Quality APPROVED, no Critical/Important. The local fixture manually issues a second GET only to test cancellation; it is not product retry/provider evidence. No production source/image changed.

New real round2 ran1failed/0passed in12.3s, conversation `6328bc93-fb38-4da3-a305-dad64b825f69`. No old task was replayed:

| Effort | Task | Actual outcome / completed checkpoints |
| --- | --- | --- |
| high | 1ca1b911-2742-4a1f-986d-5d0f676751d9 | COMPLETED,03:47:43.126680Z–03:47:45.724135Z; one read_file; all prior assertions passed: actual GET reconnect while RUNNING, same-message API thinking/DOM, streamed final body, Markdown, fold, refresh/relogin/history/default and no resubmit |
| off | 8ed0fa3b-89e9-47bb-a03d-bca8ca87d22b | COMPLETED,03:47:48.393985Z–03:47:49.529668Z; zero tools; streamed answer/Markdown/refresh/history/default checkpoints passed |
| low | 15282f92-b37a-40f7-b55e-4201903eb482 | COMPLETED,03:47:52.513820Z–03:47:53.574019Z; zero tools; FAILED composite answer-stream oracle, therefore UNVERIFIED streaming coverage |
| max | not submitted | Not reached by this failed sequential test |

Round2 actual provider whitelist: high enabled/high twice; off disabled/effort absent once; low enabled/low once; all stream=true/max_tokens=8192. No write/application/Run and project remains READY/revision23; global task/compact/Run0. The low oracle can fail for audit error, absent/late DOM, missing boundary or fewer than two generating revisions. Its1.06s execution alone does not prove the exact cause. The list reporter did not persist testInfo attachment bodies, so no precise low timing was fabricated. A separately bounded max-only continuation will retain sanitized metadata directly and check existing history before its one new task; it will not turn the earlier failed four-round run into PASS.

### Bounded max-only continuation: PASS, without erasing round2 failure

An ignored, fixed-identity operator entry reused the same owner/project/conversation and existing observer. It first read all three known tasks and their original histories, verified tool/result and refreshed/relogged in without submitting anything. Immediately before its single max Start it re-read conversation lastTaskId=known low, activeTaskIdNULL, no RUNNING compact, and fresh history without extra tasks. An initial stale-history-only guard was independently rejected and corrected before execution; Sol re-review GO/APPROVED. Config workers1/retries0, no webServer/trace/video/screenshots, current model authorization plus explicit CONTINUE_MAX flag. Discovery/typecheck were preparation only. This is one-off bounded continuation, not a generic replay/resume protocol.

Actual continuation1passed/0failed, test6.2s/total7.2s. New max task `1a33f7b3-0dc2-4543-a315-a35333925150`, same conversation,03:55:58.499144Z–03:56:00.167081Z, COMPLETED/failureNULL, zero tools/changed paths. Own answer seq26/ordinal1 has thinking index0 and text index1; observed API thinking2285.7ms, DOM thinking/text2296.7ms, own ended2714.3ms on the same browser performance clock, generating revisions59 and111. Thus thinking/text were visible about417.6ms before this message ended. Heading/list/table/code DOM and refresh/relogin/history/default=max passed; prior high/off/low saved histories also matched after refresh. Metadata persisted at each checkpoint/finally, no model text.

The real provider emitted sequence7 at03:55:58.610Z: enabled/max/streamtrue/max_tokens8192. No SDK downgrade. [Sanitized release evidence](real-release-safe.json) retains task intervals, all seven actual request whitelists, fixed identities and max timing. Correlation uses the global single execution slot and each database task created/updated interval: high sequences3/4, off5, low6, max7. Provider bodies do not contain task IDs; no identity was guessed from prompts. Sequences1/2 belong to failed round1 high. All requests remain8192; no attempt was made to force length or75% boundaries.

### Final state, cleanup and evidence limits

Final project remains READY/revision23. Total tasks43=38old+5new, legacyNULL38, tools633=631old+two read_file, conversations9, entries126. All five new tasks COMPLETED, no application/build/write or new Run, global occupying task/compact/Run0. All projects, conversations and history are retained.

At global idle the worker-only NODE_OPTIONS probe, read-only mount and volume were removed through Recreate; one initially rejected strategic patch lacked volumeMount merge key and made no change, then the corrected mountPath patch succeeded. Final worker Pod `manao-pi-worker-56fc457bf-g87q9`, UID `216e83c1-63b8-4ec2-a709-20ed58b15ea9`, Ready/restart0, same immutable worker digest. Dedicated ConfigMap `manao-ai-output-wire-audit` deleted and absence verified. Backend/frontend publication Pod identities stayed unchanged. Actual Pi packages still1.2.0, backend readiness200/UP. Restored disposable schema exact-name/prefix checked then dropped, metadata count1→0; runtime schema untouched. Private backup remains deliberately retained. No existing project/diagnostic resources were deleted.

One read-only Kubernetes API check timed out transiently after max; subsequent fresh read succeeded before any mutation. Earlier frontend readiness login attempt failed before rollout finished, then actual public200/login succeeded. These are retained operation observations, not model failures or grounds for replay.

No combined four-effort E2E PASS or user acceptance is granted. Low saved output, effort and provider parameters are verified, but its real incremental-DOM timing is UNVERIFIED; no speculative product fix or repeated paid run was used to turn it green. High reconnect while RUNNING, high/off checkpoints, max live timing and four-effort wire/persistence are separate positive evidence. Full old app startup/write/cluster rollback, broader fault/endurance coverage and75% real compaction remain NOT_RUN. Existing Stage2 PAUSED/NOT_GRANTED remains unchanged.

Independent Sol release closeout: Publication PASS; real acceptance PARTIAL / combined FAILED-low UNVERIFIED, no Critical/Important evidence mismatch. Fresh read-only checks confirm three Ready/restart0 Pods and exact digests, probe absence, global0/0/0 and restored schema absent. [Review closeout](review.md) preserves the verdict and scope.

Local artifact cleanup was inventoried: two extracted jars plus two extraction directories,1,242 files/~231MB, no reparse points, all inside this release's ignored directory. Automatic approval review rejected the targeted Remove-Item command with `blocked by policy` before execution. No file was deleted and no alternate deletion was attempted; these regenerable copies remain, alongside deliberately retained logs, reviews and private backup. This differs from the successfully removed disposable database sample and temporary ConfigMap described above.
