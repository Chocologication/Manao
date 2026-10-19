# AI streaming / reasoning / Markdown acceptance

Updated 2026-10-20. Branch codex/ai-integration. Final product-suite baseline adb63f64d16e22b74b0d1fb818a44a53abf69489. This is the unique actual-status authority. [Design](../../../../docs/superpowers/specs/2026-10-20-ai-streaming-reasoning-markdown-design.md), [plan](../../../../docs/superpowers/plans/2026-10-20-ai-streaming-reasoning-markdown-implementation-plan.md), [release guide](../../../deploy/ai-context/README.md) own contracts/preparation.

## Verdict

Required local combination PASS. All six tasks are complete within the authorized local implementation / verification / release-preparation scope. Independent final scoped rereview at `c68c773` confirms I1 late-authoritative-ACK precedence, I2 cross-message/cross-round harness evidence and M1 malformed worker effort arrays ADDRESSED, with no new Critical/Important finding. Task6 Spec COMPLIANT / Quality Approved; whole feature **Approved for local implementation completion**. The earlier Needs fixes verdicts are retained as review history, not the current local verdict.

Paid provider/real deployment acceptance, runtime V14 migration/reset, backup/restore and old-image compatibility rehearsal, image build/push/digests, rollout and resource changes/deletion **NOT_RUN**. Release PREPARED only. Stage2 PAUSED/NOT_GRANTED, Stage3 user-confirmed and original real-provider75% NOT_RUN unchanged. No push/merge.

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

## Real entry: PREPARED / NOT_RUN

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

The plan's Task6 Step4 remains NOT_RUN / separately authorized. Actual DeepSeek/provider-wire acceptance, production migration, image publication, deployment and user acceptance of this new feature have not been obtained. The branch and isolated worktree are retained; no push or merge. Useful RED/failure logs and independent review reports remain in this plan's ignored SDD directory. Only regenerable review packages and byte-identical browser artifact duplicates are eligible for local cleanup.

Local temporary cleanup is BLOCKED: automatic approval review rejected the targeted removal of those regenerable packages/duplicate files with `blocked by policy`. The command did not execute, no alternate deletion method was attempted and no files were removed. The exact current-plan inventory and blocked outcome remain in ignored SDD `cleanup-inventory.md` / `cleanup-results.md`. This artifact-cleanup limit does not change the completed local feature verdict.
