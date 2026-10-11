# Project Progress

Updated: 2026-09-26. Current integrated baseline: `master`, merge `860cdda` (6B) plus the Java runtime integration `ef1b5bb` (2026-09-25), pushed to `origin/master`. This index summarizes completed work; detailed acceptance belongs to the linked stage records.

## Current Status

| Stage | Outcome | Authority |
| --- | --- | --- |
| 6A — real backend/Kubernetes MVP | PASS by user acceptance on 2026-09-17; merged on 2026-09-18 (`6dfb655`) | [6A facts](Stage6A-Current-Facts.md) |
| 6B — cloud single-user workbench | PASS, closed and merged on 2026-09-20 (`860cdda`) | [6B acceptance](../poc4/docs/evidence/stage-6b/acceptance.md), sections 9.5–10 |
| Java runtime slice | Deployed to `manao-stage6b` and accepted 2026-09-22: runtime deps, public ports, bounded web runs, Maven seed/cache. E2E non-7200s round 4/4 PASS; cache timings measured (first run 58s, warm 7s, per-dependency download/reuse evidenced). Formal 7200s run WAIVED_BY_USER (user self-test); one DELETING leftover awaits operator decision. Integrated to `master` by `ef1b5bb` (2026-09-25) | [Runtime acceptance](../poc4/docs/evidence/java-runtime/acceptance.md) sections 8, [cache plan](superpowers/plans/2026-09-22-java-maven-cache-implementation-plan.md) |
| Python runtime slice | Implementation Tasks 1–10 complete 2026-09-26 + review-fix round 2026-09-26/27 (5 external Important findings closed) on branch `codex/python-runtime` (NOT merged); deployed to `manao-stage6b` and cloud-accepted 2026-09-27: E2E 10/10 (incl. FAILED-reconciliation fault recovery), Java regression on the rebuilt Maven runner, deletion reclamation verified (Pods/Jobs/PVCs/PV/DB rows zero-residual). Formal 7200s case SKIPPED by user instruction — unclaimed. 2026-09-29 workbench/log repair round (transient PROJECT_BUSY pending retry + terminal-state log backfill) implemented, review-clean and deployed on the same branch with real-browser verification (acceptance section 6) — still NOT merged | [Python acceptance](../poc4/docs/evidence/python-runtime/acceptance.md), [Python design](superpowers/specs/2026-09-25-python-runtime-design.md), release checklist in [deployment README](../poc4/deploy/6b/README.md) section 11 |

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

Stage 6B is finished. No mandatory “finish 6A, then begin 6B” checklist remains; do not restart old Tasks 10–12 or expand the full engineering matrix merely because an old plan still contains unchecked boxes.

On 2026-09-25 Python became the next scoped planning slice. A new worktree, `.worktree/python-runtime` on `codex/python-runtime`, starts from `06e81338`. The user confirmed ordinary Python programs, FastAPI web services and a minimal `uv add/remove` browser entry. The reviewed r2 [design](superpowers/specs/2026-09-25-python-runtime-design.md) and [eleven-task implementation plan](superpowers/plans/2026-09-25-python-runtime-implementation-plan.md) put the Run workflow before dependency editing, reduce the agent protocol to prepare/commit, and include stable operation IDs and recovery reachable after a failed-project refresh. The [implementation handoff](superpowers/plans/2026-09-25-python-runtime-agent-handoff.md) names the exact worktree and execution boundaries. As of 2026-09-26, implementation Tasks 1–10 are complete on that branch (toolchain: uv 0.11.6 / CPython 3.13.15, seeded uv cache `a3687aae…`, E2E entry authored and collectable via `test:e2e:python-runtime`); the Task 11 cloud acceptance round executed 2026-09-27 under the user's without-merge authorization: all five images republished with digests recorded in the [deployment README](../poc4/deploy/6b/README.md) section 11, V10 applied on the live schema, the E2E suite passed 10/10 (including the operator-provisioned `MANAO_DEPENDENCY_PENDING_FAULT_PACKAGE` FAILED-reconciliation case), Java regression passed on the rebuilt Maven runner image, and deletion reclamation was independently verified; the formal 7200s case was SKIPPED by user instruction ("7200s的测试用例先跳过吧…") and its evidence boundary stays in the [Python acceptance record](../poc4/docs/evidence/python-runtime/acceptance.md) section 5. On 2026-09-29 the user-confirmed workbench/log repair round (transient PROJECT_BUSY read retry for the pending-discovery GET, and terminal-state historical log backfill through the shared ingest path when no watch was ever established) was implemented on this branch, review-clean, and deployed to `manao-stage6b` the same day; its delivery boundary and the real-browser evidence are owned by the [Python acceptance record](../poc4/docs/evidence/python-runtime/acceptance.md) section 6. Nothing from this branch is merged to `master`; Go, TypeScript and AI are later work.

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
