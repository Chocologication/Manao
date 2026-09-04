# What We Have Done

Status summarized from the current POC4 worktree and evidence records, last reviewed on 2026-09-04.

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

The latest local verification recorded:

- Backend: 234 tests, 0 failures, 0 errors, 1 skipped.
- Workspace agent: 23 tests, 0 failures, 0 errors.
- Frontend: 1,124 tests, 0 failures; TypeScript typecheck passed.
- Stage 6 Playwright inventory: 10 tests in 3 specifications.

The code-level remediation rounds also added startup-probe protection, bridge listener checks, non-blocking PTY input draining, stricter WebSocket field validation, workspace ServiceAccount labeling, monotonic resize generations, and gated stress/fault specifications.

## Current Gate Status

Stage 6A is still `FAILED`, and Stage 6B has not started.

The cluster-side prerequisites that have been measured include API tunnel and TLS validation, restricted namespace RBAC preflight, NFS `ReadWriteMany` storage, immutable image availability, and basic PVC/initializer/workspace resource creation. However, the decisive real-system evidence is still incomplete:

- Real workspace template writing through the 6A bridge has not produced a passing result.
- The complete real-browser flow for project creation, file operations, Run, logs, PTY, and audit has not passed as a reproducible matrix.
- The 8 MiB terminal/log stress evidence and the operator-injected backend/tunnel/bridge fault matrix have not been completed outside the constrained sandbox.
- A local backend port-wiring issue and shared test-data project limits also blocked the latest browser rerun; these must be resolved before a meaningful external rerun.

Because the 6A gate is not a pass, no 6B Deployment, Secret, or production-style backend Role should be introduced under the project’s sequencing rules.

## Next Work

1. Close the remaining local wiring and test-data blockers.
2. Run the full 6A happy-path, stress, and fault matrix in an environment that permits the workspace bridge and operator actions.
3. Refresh the 6A evidence with the exact code SHA, image digests, test outputs, and distinct `PASS`, `FAILED`, `SKIPPED`, and `WAIVED_BY_USER` classifications.
4. Only after a reproducible 6A `PASS`, implement and validate the 6B cluster Deployment, RBAC, Secret, probes, restart behavior, and cluster-side E2E.
5. After Stage 6, plan the deferred product work: AI assistance, additional languages, team/admin features, and production security hardening.
