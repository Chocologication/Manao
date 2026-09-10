# What We Have Done

Status reviewed on 2026-09-10 against Stage 6 code, retained reports, the user-reported rerun and read-only Kubernetes/MySQL checks. This documentation task did not rerun tests, restart services or change runtime data. Stage 0-5 records below remain historical.

## Stage 0 — Browser Foundation Spike

Completed the EnsoAI selective-reuse feasibility spike. The pure Vite browser application demonstrated the migrated visual system, editor tabs, Monaco workers and model lifecycle, xterm transport, panel switching, and disposal behavior in Chromium, Chrome, and Edge. The decision was `CONTINUE_SELECTIVE_MIGRATION`.

Evidence boundary: this stage used mock files and a local WebSocket echo server; it did not validate the real backend, Kubernetes, PVCs, or production terminal execution.

## Stage 1 — Frontend Application Foundation

Implemented the browser routing shell, fixed test-account login, in-memory short-lived JWT handling, project listing, project creation states, polling, ownership-oriented UI states, and centralized error handling. The frontend contract was exercised with controlled HTTP mocks and browser workflows.

Evidence boundary: authentication and ownership behavior at this stage are mock-contract evidence, not proof of real Spring Security, signed JWT verification, MySQL persistence, or Kubernetes authorization.

## Stage 2 — Read-Only Workbench

Implemented lazy file-tree loading, metadata-first file access, read-only Monaco tabs, relative-path contracts, 20/50 MiB size policies, binary and oversized-file blocking, authenticated downloads, and browser cleanup behavior.

Evidence boundary: the file API and safety behavior were validated against mocks; real PVC access, server-side path normalization, symlink protection, and workspace-agent behavior remained outside the stage.

## Stage 3 — Writable Workbench

Implemented controlled Monaco and plain-text editing, explicit Save and `Ctrl+S`, dirty-state tracking, workspace revisions, file and directory creation, same-directory rename, confirmed deletion, navigation/logout guards, and stale-revision handling.

Evidence boundary: the write protocol and revision state machine were validated with mocks and browser tests; real atomic PVC writes, cross-process locking, and Kubernetes workspace behavior were not yet proven.

## Stage 4 — Run and Logs

Implemented authoritative Run state handling, start/stop coordination, edit locking during execution, terminal-state reload, recent-run history, persisted log windows, replay followed by live delivery, sequence de-duplication, reconnect recovery, and the 5 MiB rolling log policy.

Evidence boundary: the browser and mock backend contract passed its stage tests, but the evidence did not prove real Maven Jobs, Pod logs, MySQL transactions, or backend restart recovery.

## Stage 5 — Active Job Terminal

Implemented the browser terminal flow for an active Maven Run, including one-time tickets, same-origin WebSocket transport, xterm input/output, resize, search, WebGL fallback, credit/ack flow control, bounded input handling, disconnect cleanup, new-session behavior, and audit display.

The stage decision was `READY_FOR_STAGE_6_PLAN`. Its acceptance record reports 15 gates as `PASS` and 2 as `WAIVED_BY_USER`; the waived items are not equivalent to passing evidence.

Evidence boundary: Stage 5 primarily established browser/MSW protocol and lifecycle behavior. It did not prove Fabric8 exec against a real Job container, real PTY destruction, MySQL audit persistence, or Kubernetes isolation.

## Stage 6 — Real Backend and Kubernetes Integration

The real backend foundation is largely implemented as a modular Spring Boot application with MySQL/Flyway persistence, JWT and owner authorization, workspace PVC and Pod coordination, Maven Job control, persisted/live logs, terminal PTY bridging, audit lifecycle handling, recovery logic, and a `local-cluster` integration profile.

The implementation and diagnostic documents below belong to the isolated `.worktree/ensoai-stage-6-real-backend-kubernetes` checkout, whose HEAD at this review is `d3f2857c04e7282337d2b383c10d2e39046a4ebd`. This status summary does not imply those changes have been merged into the main checkout.

The most recent recorded verification results from 2026-09-08 are:

- Backend: 251 tests, 0 failures, 0 errors, 1 skipped; MySQL tests used disposable schemas that were removed afterward.
- Workspace agent: 24 tests, 0 failures, 0 errors.
- Frontend: 1,125 tests passed across 61 files; TypeScript typecheck passed.
- Local real-HTTP/filter/controller/filesystem contract check: template initialization, UTF-8 save, rename/delete, receipt reconciliation, unsigned-request rejection, and mismatched-receipt fail-closed behavior passed. The check substituted test stores for MySQL and Kubernetes; it did not exercise the real Fabric8 bridge or cluster.

The earlier Stage 6 Playwright inventory contained 10 tests in 3 specifications; inventory alone is not execution or acceptance evidence.

The code-level remediation rounds also added startup-probe protection, bridge listener checks, non-blocking PTY input draining, stricter WebSocket field validation, workspace ServiceAccount labeling, monotonic resize generations, and gated stress/fault specifications.

### Changes Recorded on 2026-09-08

- Commit `7692030` fixed workspace-agent request/response contracts: JSON POST content type, rename destination, DELETE route, and use of the persisted receipt digest. Template initialization now creates 11 directories in parent-first order and creates then saves each of 5 files, producing 21 committed operations in the local contract check.
- That commit also included the `18080` backend port contract, Windows kubectl resolution, complete terminal protocol error frames, and sanitized mutation-stage/status/code logging. Supervised bridges retain externally owned deterministic listeners; managed bridges still check OS port availability. Transport exception classification remains planned, not implemented by those logs.
- Commit `f4c79f2` raised the per-user project cap from 3 to 8 across backend enforcement, the API, frontend defaults, and mocks. CREATING, READY, and FAILED projects all count toward the cap; the ninth creation is rejected, including under concurrent requests. This does not increase or validate Kubernetes capacity.
- The user-authorized cleanup removed 3 specific failed Alice test projects and their 3 workspace operations after a local backup; accounts and the unrelated `null-receipt` diagnostic project were preserved. Alice/Bob had zero projects immediately after that cleanup, not necessarily after later tests. Raising the cap and clearing leftovers did not fix the underlying provisioning failure.

## Progress on 2026-09-09 and 2026-09-10

- `4766b43` changed the 6A default workspace bridge to kubectl port-forward after a same-Pod comparison isolated the observed Fabric8 RESET. Real project creation and template initialization subsequently passed. Earlier notes that template writing had never passed are superseded.
- `b61066b` isolated destructive Flyway tests from the runtime database, corrected file creation to HTTP 201 and removed the manually supplied Kubernetes Job selector. Fixed test accounts were restored; the earlier account/schema damage is distinct from later scheduling failures.
- `c974630` added owner-scoped project DELETE and E2E afterAll cleanup across Kubernetes and database records. Normal-path cleanup passed; failure-path cleanup remains incomplete.
- The user reports five real-backend tests passing outside the sandbox after restarting the cluster on 2026-09-10. The latest `.last-run.json`, modified at 18:32:06 +08:00, says `passed` with no failed IDs. That file does not independently prove the test count, duration, execution identity or actual Run outcome; a full report for this latest rerun was not retained.
- The previous 09:50 machine-readable report records 5 passed / 0 failed / 0 skipped in 132.34 seconds using temporary admin configuration. It is retained as historical evidence, not substituted for the latest rerun or restricted-RBAC gate acceptance.

## Current Gate Status

**Basic five-test suite: PASS as reported by the user, corroborated by the latest run-status file. Full Stage 6A gate: FAILED because critical acceptance remains incomplete. Stage 6B: NOT_STARTED. Stage 6: not complete.**

| Area | Current evidence boundary |
|---|---|
| Login, ownership, real template/file operations and stale revisions | Covered by the basic suite; not a complete editor/log/terminal UI walkthrough |
| Run creation and terminal transition | Covered, but the fourth test accepts SUCCEEDED, FAILED, CANCELLED or TIMED_OUT; it does not prove successful Maven execution |
| Actual Maven success and Run/Job agreement | Still requires verification; retained 2026-09-09 evidence shows Job/Pod success with DB Run FAILED / RECOVERY_FAILED |
| Runtime environment after restart | All three nodes currently Ready; restricted identity and selected allow/deny checks succeeded; these are read-only spot checks, not a full preflight rerun |
| Cleanup | Normal path passed; initializer deletion and concurrent/interrupted cleanup still need remediation |
| Live/replay logs, PTY, audit, 8 MiB stress, dynamic bridges and three fault phases | No complete current-SHA real-system PASS evidence; required before 6A acceptance |
| Backend full regression at current SHA | Not rerun; retained ProjectLimitTest failures at MySQL/Flyway Error 1419 must not be hidden by the browser result |

The 2026-09-10 17:06:40 project-creation failure was directly explained by Kubernetes scheduling: insufficient CPU, an unreachable worker and a tainted control-plane node. It was not a runtime MySQL permission failure. The cluster now reports healthy nodes and the rerun passed, but the underlying cause of the worker losing status updates was not investigated.

There is still one preserved failed test project (`083b8efd-9f57-4cb4-aa6f-646b37bd6d57`) with an initializer Pod, PVC and FAILED database row; the unrelated `null-receipt` diagnostic is also preserved. Do not claim an empty environment. File cleanup in this review does not delete cluster or database diagnostics.

The remaining initializer exposes a deterministic code defect: deletion selects only workspace-component Pods while its completion check waits for all project components. A failed-to-ready workspace therefore leaves the initializer, causing a 60-second DELETE timeout before PVC/database deletion. Restarting the cluster does not repair this logic.

## Next Work

1. **Make test-resource lifecycle reliable first.** Add regression coverage for initializer cleanup, CREATING/deletion races, active-Run conflicts and network exceptions; clean each test's owned resources promptly, retaining a suite-level fallback and a narrowly selected diagnostic hold. Apply the same lifecycle policy to stress/fault suites before expanding them.
2. **Verify the actual execution loop, not only green status.** Require Maven success, matching Job/Pod/API/database outcomes, complete logs and correct workspace unlock/reload. Diagnose the retained Run/Job mismatch with fresh correlated evidence; test failed/cancelled/timed-out runs separately.
3. **Close the full 6A matrix.** Real browser edit/save/run/logs/PTY/audit, both stress tests, concurrent bridges and backend-restart/tunnel-loss/bridge-loss phases; record exact SHA, artifact checksum, image digests, restricted identity, exit codes, skipped items and cleanup results. Use authorized disposable MySQL test schemas rather than runtime-schema reset or broad privilege relaxation.
4. **Obtain independent 6A PASS before 6B.** Only then execute Tasks 10-12: single-replica Recreate backend, cluster MySQL, least-privilege ServiceAccount/Role, Secret/probes, fencing and the equivalent cluster-side acceptance matrix. Neither local unit tests nor user-waived gate items can replace real acceptance.
5. **After Stage 6/POC4, design the next product slice.** Prioritize a minimal AI-assisted loop over selected files and run logs with user-confirmed patches. Languages, Git, teams/teaching/admin and billing remain separately scoped. Review execution isolation, credentials, egress and resource abuse before exposing the POC to untrusted users.

## Artifact Cleanup Review

The obsolete-file inventory contained five superseded report directories and two older logs: 16 files, 158,089 bytes. Path boundaries, reparse points, Git tracking and checksums were rechecked. After user authorization, **all 16 inventoried files were deleted and the 5 emptied report directories were removed**, reclaiming 158,089 bytes. The manifest now records status `DELETED`. Latest useful reports, unresolved-failure evidence, runtime configurations, other-stage evidence and all Kubernetes/database diagnostics were preserved.

## Supporting Stage 6 Records

These links intentionally point into the isolated implementation worktree; they are local working-copy links, not proof that its backend has been merged to `master`.

- [Current status, acceptance matrix, open issues and next steps](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-10-status-and-next-steps.md).
- [Read-only snapshot and latest-run evidence boundary](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-10-readonly-snapshot.json).
- [6A gate and historical remediation results](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/6a-gate.md).
- [Artifact cleanup manifest](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-10-artifact-cleanup.json).
- [Historical workspace-agent failure report](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/2026-9-8-workspace-agent-bug-report.md) and [transport diagnosis plan](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/2026-09-08-workspace-agent-transport-diagnosis-plan.md); their old pending/blocked status is superseded by the later kubectl bridge evidence, not deleted.
