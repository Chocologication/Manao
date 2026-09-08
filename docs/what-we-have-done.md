# What We Have Done

Status reviewed on 2026-09-08 against the conversation and recorded POC4 worktree evidence. Tests and live infrastructure were not rerun for this documentation update.

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

## Current Gate Status

Stage 6A is still `FAILED`, and Stage 6B has not started.

The cluster-side prerequisites that have been measured include API tunnel and TLS validation, restricted namespace RBAC preflight, NFS `ReadWriteMany` storage, immutable image availability, and basic PVC/initializer/workspace resource creation. However, the decisive real-system evidence is still incomplete:

- Real workspace template writing through the 6A bridge has not produced a passing result.
- The complete real-browser flow for project creation, file operations, Run, logs, PTY, and audit has not passed as a reproducible matrix.
- The 8 MiB terminal/log stress evidence and the operator-injected backend/tunnel/bridge fault matrix have not been completed outside the constrained sandbox.
- Earlier browser attempts were blocked by local port wiring and the old three-project cap. Those code/data issues were addressed as recorded above, but the user still reported 4 failed / 1 passed in the real browser suite. A later focused project-creation test also failed with `Expected: READY; Received: FAILED`.
- The 2026-09-08 failure report records working frontend/backend health endpoints and Kubernetes tunnel/token/basic RBAC prerequisites for that run, followed by the first template directory mutation failing at `phase=MUTATE`, `httpStatus=503`, `agentCode=IO_ERROR`. `WORKSPACE_RECONCILIATION_REQUIRED` is the protective consequence, not the underlying root cause. The generic error wrapping does not establish an actual agent HTTP 503 or distinguish transport failure from response decoding failure; the precise cause remains unconfirmed.

Because the 6A gate is not a pass, no 6B Deployment, Secret, or production-style backend Role should be introduced under the project’s sequencing rules.

## Next Work

The failure report records backend shutdown at 17:05:41 on 2026-09-08 and cleanup of the failed project's cluster resources. These are run-specific observations, not a fresh check of current process state. The transport diagnosis plan was documented in commit `d3f2857`; its implementation and service restart remain pending user confirmation.

1. After approval, add test-first, sanitized diagnostics that distinguish transport exceptions, actual HTTP error responses, and invalid responses without exposing request bodies, credentials, or raw exception messages. Preserve the existing fail-closed policy.
2. Revalidate the tunnel, restricted kubeconfig, service availability, and available test quota without automatically deleting diagnostic data. Restart services only as needed for the approved run.
3. Run only the focused project-creation browser test while observing the exact project's Pod readiness/restarts, agent logs, actual bridge endpoint, and HTTP health before cleanup removes the evidence. Check for a durable receipt if the mutation response was lost; do not blindly retry the write.
4. Fix the single demonstrated root cause and prove focused provisioning reaches READY with correct template contents, receipts, and revision. Only then rerun the full 6A happy-path, stress, and fault matrix.
5. Refresh the 6A evidence with the exact code SHA, image digests, test outputs, and distinct `PASS`, `FAILED`, `SKIPPED`, and `WAIVED_BY_USER` classifications. Only after a reproducible 6A `PASS`, implement and validate 6B Deployment, RBAC, Secret, probes, restart behavior, and cluster-side E2E.
6. After Stage 6, plan the deferred product work: AI assistance, additional languages, team/admin features, and production security hardening.

## Supporting Stage 6 Records

These links point into the isolated Stage 6 implementation worktree:

- [6A gate evidence and dated remediation/cleanup results](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/6a-gate.md).
- [Workspace-agent provisioning failure report](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/2026-9-8-workspace-agent-bug-report.md), recorded in commit `3255bb1`.
- [Workspace-agent HTTP transport diagnosis plan](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/2026-09-08-workspace-agent-transport-diagnosis-plan.md), recorded in commit `d3f2857`; this is a pending plan, not evidence of an implemented fix or a 6A pass.
