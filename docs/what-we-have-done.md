# Project Progress

Updated: 2026-10-19. Main checkout: `master` at `49eb632`, including Python merge `2ef32a5` (2026-10-12); the AI work described below is on `codex/ai-integration` and has not been merged. This index summarizes completed work; detailed acceptance belongs to the linked stage records.

## Current Status

On 2026-10-19 the user authorized implementation, local verification, sequential review and release preparation for project conversations on `codex/ai-integration`. The [context acceptance](../poc4/docs/evidence/ai-context/acceptance.md) owns the implemented multi-turn history, isolation, fixed 1M/75% native compaction and idle manual compaction, including backend163/163, worker121/121, frontend165/165, disposable old-code/V13 compatibility27/27 and the disclosed Task4 TDD-order deviation. The [design](superpowers/specs/2026-10-19-ai-conversation-context-design.md), [six-task plan](superpowers/plans/2026-10-19-ai-conversation-context-implementation-plan.md) and [release preparation](../poc4/deploy/ai-context/README.md) are aligned to actual interfaces. Real model/browser/restart/runtime migration remain NOT_RUN; three images are NOT_BUILT and no cloud PASS, deployment, push/merge or project deletion was authorized. There is no automatic task recovery; existing stage verdicts below remain unchanged.

On 2026-10-19 the user confirmed from actual use that book-data CRUD already works and **stage three has fulfilled its mission early**. The [stage-three user confirmation](../poc4/docs/evidence/ai-stage3/acceptance.md) records that completed mission. Stage two remains unpassed and paused; stage four remains future scope. These decisions are tracked independently.

The 2026-10-18 user-authorized AI task budget increase to 180 tool calls / 20 builds and worker release is recorded in the [task budget authority](../poc4/docs/evidence/ai-task-budget/acceptance.md). It retains the 1800s task deadline and does not resume the paused Stage 2 acceptance.

| Stage | Outcome | Authority |
| --- | --- | --- |
| AI stage 2 — application feedback | Implementation/deployment delivered; engineering acceptance unpassed, PAUSED / NOT_GRANTED | [Stage 2 record](../poc4/docs/evidence/ai-stage2/acceptance.md), sections 9.10–9.13 |
| AI stage 3 — book CRUD and user acceptance | Mission fulfilled early by explicit user acceptance on 2026-10-19, based on actual CRUD use; no separate implementation round is a default next task | [Stage 3 user confirmation](../poc4/docs/evidence/ai-stage3/acceptance.md) |
| 6A — real backend/Kubernetes MVP | PASS by user acceptance on 2026-09-17; merged on 2026-09-18 (`6dfb655`) | [6A facts](Stage6A-Current-Facts.md) |
| 6B — cloud single-user workbench | PASS, closed and merged on 2026-09-20 (`860cdda`) | [6B acceptance](../poc4/docs/evidence/stage-6b/acceptance.md), sections 9.5–10 |
| Java runtime slice | Deployed to `manao-stage6b` and accepted 2026-09-22: runtime deps, public ports, bounded web runs, Maven seed/cache. E2E non-7200s round 4/4 PASS; cache timings measured (first run 58s, warm 7s, per-dependency download/reuse evidenced). Formal 7200s run WAIVED_BY_USER (user self-test); one DELETING leftover awaits operator decision. Integrated to `master` by `ef1b5bb` (2026-09-25) | [Runtime acceptance](../poc4/docs/evidence/java-runtime/acceptance.md) sections 8, [cache plan](superpowers/plans/2026-09-22-java-maven-cache-implementation-plan.md) |
| Python runtime slice | Implementation Tasks 1–10 complete 2026-09-26 + review-fix round 2026-09-26/27 (5 external Important findings closed) on branch `codex/python-runtime`; deployed to `manao-stage6b` and cloud-accepted 2026-09-27: E2E 10/10 (incl. FAILED-reconciliation fault recovery), Java regression on the rebuilt Maven runner, deletion reclamation verified (Pods/Jobs/PVCs/PV/DB rows zero-residual). Formal 7200s case SKIPPED by user instruction — unclaimed. 2026-09-29 workbench/log repair round (transient PROJECT_BUSY pending retry + terminal-state log backfill) implemented, review-clean and deployed on the same branch with real-browser verification (acceptance section 6). 2026-10-11/12 dependency mirror + requirements.txt batch import round implemented, deployed and E2E-verified (acceptance sections 7–8; one E2E failure traced to a pre-existing dependency-panel silent-gate race, deferred per section 8.5). The user completed manual acceptance and the whole slice was merged to `master` by `2ef32a5` (2026-10-12, no fast-forward) | [Python acceptance](../poc4/docs/evidence/python-runtime/acceptance.md), [Python design](superpowers/specs/2026-09-25-python-runtime-design.md), release checklist in [deployment README](../poc4/deploy/6b/README.md) section 11 |

## Delivered Cloud Workbench

The accepted flow is login, create, edit/save, real compilation failure and feedback, fix/run successfully, reopen saved files/history/logs, and manually delete the project. Frontend, backend and MySQL run in the cloud deployment; everyday browser use does not require local application services or a tunnel.

The 2026-09-20 recheck recorded:

- Public lifecycle E2E: **6/6 passed**.
- Backend and MySQL each normally rebuilt once; saved files/history/logs survived and a new Run succeeded after each rebuild.
- UI deletion followed by independent project-scoped Kubernetes, database, PV and NFS-directory checks; no test-project residue, MySQL volume retained.
- Targeted frontend regression: **137 tests passed** across 5 files; typecheck passed. These counts are dated evidence, not a fresh full-suite result for every future commit.
- The frontend image-record mismatch was closed before integration. Original FAILED snapshots remain historical, not the current stage verdict.

For exact image digests, project/Run IDs, commands and evidence boundaries, use the [acceptance record](../poc4/docs/evidence/stage-6b/acceptance.md). For setup, account initialization, fixed images and maintenance, use the [deployment README](../poc4/deploy/6b/README.md). Environment identities and dated observations are summarized in [Infrastructure Status](Stage6-Infrastructure-Status.md).

## Earlier Stages

| Stage | Delivered slice | Evidence boundary |
| --- | --- | --- |
| 0 | Selective EnsoAI browser migration, Monaco/xterm presentation and lifecycle | Mock files and local WebSocket echo, not real Kubernetes |
| 1 | Routing, login contract, projects and centralized errors | Browser/MSW contract validation |
| 2 | Lazy file tree, metadata-first read-only editor, download and size policies | Mock file API, not real PVC validation |
| 3 | Explicit save, revisions, file CRUD and dirty-buffer guards | Mock write protocol before real backend integration |
| 4 | Run control, edit locking, history and replay/live logs | Browser protocol/state validation |
| 5 | Experimental active-Job terminal, transport, resize and audit display | Recorded 15 PASS and 2 WAIVED_BY_USER; no implied full real-cluster PTY acceptance |
| 6A | Real backend/agent/PVC/Job loop, workspace recovery and permanent project deletion | MVP acceptance, not the original full engineering matrix |
| 6B | Cloud frontend/backend/MySQL, public entry, repeatable maintenance and lifecycle | Single-user MVP; conditional faults and broader hardening remain bounded |

Historical stage detail and decision changes: [Evolution Timeline](Stage6A-Evolution-Timeline.md). Old reports saying 6A FAILED or 6B NOT_STARTED are dated records, not current gates.

## Known Boundaries

- Experimental terminal is off by default. Full PTY/audit/stress/fault matrices were not converted into PASS by stage closure.
- Workspace-Pod deletion and deletion fault injection were SKIPPED in the 6B recheck because their trigger conditions were not met.
- After selecting a historical Run, starting another Run leaves that historical record selected; manually selecting the new record displays its state/logs correctly. This observation is retained in acceptance section 9.3; it was not fixed during closeout.
- The acceptance record still distinguishes the reported focus-refetch fix from a native Alt-Tab retest not performed in this review.
- HTTP public transport, single-backend operation and the lack of immutable per-Run file snapshots remain explicit limits.

## Next Work

The [Pi implementation slicing proposal](research/2026-10-13-pi-minimal-integration-implementation-slicing.md) defines four increments: code editing/build/test, application runtime feedback, book CRUD with human acceptance, and takeover/recovery. Stage one is implemented on `codex/ai-integration`; the [Stage 1 Implementation Record](../poc4/docs/evidence/ai-stage1/acceptance.md), section 8, owns the real 2026-10-15 model/browser/cluster round and the granted `PI_STAGE1_CODE_TEST_LOOP_PASS`. Section 8.7 separately records the later revision-cache repair deployment and its missing post-rollout browser click-path verification. The stage-one pass does not establish CRUD/MySQL or the full AI product.

On 2026-10-16 all five stage-two implementation tasks were reviewed and committed through `559f998`, with an Approved final whole-branch review. The user subsequently authorized image publication, cluster rollout and real model/browser/operator verification on port 30003; Git push/merge and project deletion remain prohibited. The [Stage 2 implementation record](../poc4/docs/evidence/ai-stage2/acceptance.md), section 9, owns deployed digests/identities, seven failed main scenes and a confirmed worker defect with a reviewed fix deployed as settlement-r5. The third Agent task completed with real HTTP200 but its browser suite failed at operator verification; round four failed on a progress ID without a durable result; round five correctly failed because the model appended to the immutable acceptance fixture; round six preserved that fixture but operator rejected AMBIGUOUS_TOOL_ORDER, correctly detecting a production worker defect: an early unknown result let a background build overlap a later status call. Worker fix `70c0985` is independently Approved with 66/66 and build PASS; settlement-r5 was published and rolled out with digest/Pod identity verified; the seventh round failed at COLLECTION_RUN_CHANGED despite unchanged fixture and real target500→200; its original snapshot difference remains unknown and the investigation is paused, and close did not run. Independently Approved harness fixes `77fe238`/`668eb0c` passed 104/104 and stage6 typecheck, without an image rollout. Later standalone operator PASS does not complete browser main/close; `PI_STAGE2_APPLICATION_FEEDBACK_PASS` remains NOT_GRANTED pending complete browser main/close and independent resource evidence. Sections 2–8 preserve local baselines, RED/GREEN/process corrections, six controller rulings and cleanup as dated snapshots; their original NOT_BUILT/NOT_RUN statements are historical. The [release guide](../poc4/deploy/ai-stage2/README.md) records actual digests, backend build fallback and maintenance/rollback/acceptance commands. The [historical design](superpowers/specs/2026-10-16-pi-stage2-design.md), [five-task plan](superpowers/plans/2026-10-16-pi-stage2-implementation-plan.md) and [implementer prompt](superpowers/plans/2026-10-16-pi-stage2-agent-handoff.md) preserve stop/wait/start, status/logs and bounded GET over existing ledger/Run authority. No new table, migration or workflow framework was added. CRUD/MySQL and takeover/recovery were originally assigned to stages three and four; the stage-three mission has since been accepted by the user as completed (2026-10-19), while stage four remains future scope.

On 2026-10-17 Stage 2 acceptance was paused for a new frontend `Unable to load run authority/history` case (HTTP 200 with `RUNNING` and `startedAt=null`). The [Stage 2 implementation record](../poc4/docs/evidence/ai-stage2/acceptance.md) section 9.12 owns unresolved `COLLECTION_RUN_CHANGED`, null-safe `evidenceDiff` review and remaining browser/owner-close/resource evidence; [Run recovery repair](superpowers/plans/2026-10-17-run-recovery-contract-fix.md) owns the root cause, TDD, independent review and focused backend repair release under the earlier explicit deployment authorization. Stage PASS remains NOT_GRANTED; the original model/cluster acceptance stays paused and project deletion remains prohibited.

The 2026-10-18 [record audit](../poc4/docs/evidence/ai-stage2/acceptance.md#913-2026-10-18-记录核查后续变更与本地整理) reconciles all follow-up changes and commits the previously uncommitted failure/pause records. The null-safe verifier is now independently Approved with 108/108 local tests; three archived later operator PASS samples do not replace round seven FAILED. Original browser/close/resource evidence remains missing. The [workspace audit](../poc4/docs/evidence/ai-stage2/workspace-audit-20261018.md) records exact local temporary-file deletion and retained diagnostics; live cluster recheck timed out and supplies no new acceptance evidence.

Stage 6B is finished. No mandatory “finish 6A, then begin 6B” checklist remains; do not restart old Tasks 10–12 or expand the full engineering matrix merely because an old plan still contains unchecked boxes.

On 2026-10-18 the user requested AI access for other projects and then explicitly authorized publication. The [AI project access record](../poc4/docs/evidence/ai-project-access/acceptance.md) owns source `2446ca2`, 16/16 tests, backend rollout and before/after admission checks on test1/test2. The single-project restriction is removed while owner/READY/revision/occupancy checks remain; Stage 2 acceptance stays paused and NOT_GRANTED.

The Python slice is complete and merged to `master` by `2ef32a5` (2026-10-12). Its [acceptance record](../poc4/docs/evidence/python-runtime/acceptance.md), sections 5–8, owns the 10/10 initial cloud E2E, workbench/log repair, dependency mirror and batch import results. The formal 7200s case remains SKIPPED by user instruction. The mirror/batch round recorded 6 passed / 1 failed / 3 not run; the pre-existing dependency-panel race and deferred minors remain documented. Completed plans and the retained Python worktree are historical records, not the next task queue.

On 2026-10-13 the user chose to skip Go/TypeScript adaptation and enter AI integration selection/design directly. The target is an autonomous coding Agent: it reads/writes code, manages dependencies, uses Shell, runs and repairs the current user's project after a task. Ordinary project operations run automatically; destructive or otherwise high-risk operations require confirmation. It must not operate on the Manao platform. The user confirmed cloud model APIs only, with future expansion focused on coding-oriented MCP/Skills, multiple Agents, project tools and complex tasks.

The [AI Framework Evaluation](research/2026-10-13-ai-integration-framework-evaluation.md) owns candidate comparison and confirmed choices in section 10: Pi, direct project modification, exclusive Agent write access, takeover after confirmed stopping, and automatic application stop/start within a programming task. The initial core-value goal was book REST CRUD with project MySQL in a dedicated acceptance project without important existing data; on 2026-10-19 the user confirmed that actual book-data CRUD use fulfills stage three's mission early. Database operations in that dedicated project remain automatic, while important existing data policy remains deferred. The stage-three user decision and the still-unpassed stage-two engineering record are separate authorities. Go/TypeScript are not prerequisites, and self-built orchestration remains the last fallback.

The Java project runtime is integrated to `master` by `ef1b5bb` (2026-09-25) and supplies the baseline for that Python plan. The [Java Runtime Design](superpowers/specs/2026-09-21-java-project-runtime-design.md) incorporates mandatory user-entered public ports in 30000–31000, conflict feedback without automatic replacement, and container ports without extra product range restrictions. Separate persistent MySQL storage, the two-hour application lifetime and manual rerun remain confirmed. The [module review](superpowers/specs/2026-09-21-java-runtime-module-review.md) and [implementation plan](superpowers/plans/2026-09-21-java-project-runtime-implementation-plan.md) define Job + Service, focused tests and one full two-hour acceptance run. The delivery boundary — the formal 7200s run WAIVED_BY_USER, the DELETING leftover and the NOT_REVERIFIED items — is owned by the [runtime acceptance record](../poc4/docs/evidence/java-runtime/acceptance.md).

The 2026-09-22 [Maven cache supplement](superpowers/plans/2026-09-22-java-maven-cache-implementation-plan.md) was implemented (C1/C2) and C3 combined deployment with the lifecycle acceptance on the same day: images published and digest-pinned, V9 migration applied, the E2E non-7200s round and the Maven cache acceptance (timings, download/reuse file evidence, isolation, backfill, reclamation) recorded PASS in the [acceptance record](../poc4/docs/evidence/java-runtime/acceptance.md) section 8. The formal 7200s run remains WAIVED_BY_USER; one DELETING leftover from a mid-round defect awaits an operator decision. No earlier stage PASS was rewritten.

For maintenance, follow the accepted deployment README, reconcile any ambiguous mutation before retrying, and use the actual failing scope to select verification. A new feature or new failure may justify additional tests; unchanged previously passed paths do not require repeated full-suite or cluster reruns.

## Historical Diagnostics

The old current-state paragraphs, outstanding cleanup claims and next-step lists from 2026-09-10 have been removed from this index because later implementation and acceptance superseded them. Their evidence is still available:

- [2026-09-10 status and next-steps report](../poc4/docs/evidence/stage-6/2026-09-10-status-and-next-steps.md).
- [Dated read-only snapshot](../poc4/docs/evidence/stage-6/2026-09-10-readonly-snapshot.json).
- [Historical gate report](../poc4/docs/evidence/stage-6/6a-gate.md).
- [Artifact cleanup manifest](../poc4/docs/evidence/stage-6/2026-09-10-artifact-cleanup.json).

These are repository-local source records, not instructions to revisit completed gates or delete resources that may no longer exist.
