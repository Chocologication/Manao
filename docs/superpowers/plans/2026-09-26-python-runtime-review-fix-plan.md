# Python Runtime Review-Fix Implementation Plan (2026-09-26)

Authority: [Python Runtime Design](../specs/2026-09-25-python-runtime-design.md) (§6.1/6.2/6.3, §8) — this plan argues from it.
Baseline: branch `codex/python-runtime` at `b06b9da` (merge-base `06e8133`). The external review of `06e8133..b06b9da` confirmed 5 Important defects (1×P1, 4×P2); this plan fixes exactly those five. It does NOT open Task 11 (cloud acceptance), change deployment, or alter any NOT_REVERIFIED boundary.

## Global Constraints (bind every task and the reviewers)

1. TDD is mandatory: write the failing test first, watch it fail for the right reason, then implement minimally, then watch it pass. No production change without a failing test that names it.
2. Test execution is serial (project rule): backend `mvn -f poc4/backend/pom.xml test` and frontend `pnpm -C poc4/frontend test` never run concurrently. Backend test env: `MANAO_DB_USERNAME=root`, `MANAO_DB_PASSWORD=HAOhao2006.`; never set `MANAO_DB_URL`. Only disposable schemas; never reset `manao_poc4` / `manao_poc4_6b`. Frontend suite must end exit 0 with zero unhandled rejections; backend must end BUILD SUCCESS.
3. Multi-line Python/shell input goes through files written with the Write tool — never heredoc pipes through bash.
4. No cluster, deployment, image-rebuild or cloud changes. `poc4/docs/evidence/python-runtime/acceptance.md` NOT_REVERIFIED entries stay untouched. Completed Tasks 1–10 of the 2026-09-25 plan are never replayed.
5. Design fail-closed semantics are preserved: no new frameworks, no new lock service, no runtime RPC budget sync; uv 0.11.6 / CPython 3.13 identities unchanged; the helper never executes user build backends and never receives capability material.
6. Frontend mocks double-bump revision with a joined-string fingerprint (not real SHA-256): never assert revision arithmetic or byte-exact lock content against mocks.
7. Commit style: conventional commits scoped `fix(frontend): …` / `fix(backend): …` / `fix(agent): …` / `docs(python-runtime): …`. No credentials or unsanitized traces.
8. Every task ends with: targeted tests green, the module suite covering the touched code green, and a short report per the implementer contract.

## Controller rulings (binding; recorded 2026-09-26 before Task 1)

- R1 (design 6.1 enforceability): while a dependency operation is in flight (`submitting`/`reloading`) or its result is unconfirmed, workspace WRITES are locked in the shell. The unconfirmed state means the authoritative workspace content is unknown until checked; the reload paths (panel success, recovery) must therefore never run while dirty buffers exist, and the recovery Check is refused while dirty. Cost if wrong: a legitimate mid-check edit flow gets blocked — UX-only, fail-closed direction.
- R2 (wire honesty): the backend distinguishes "proven pre-flight rejection" from "a registered operation's result is unresolved". A new ApiError code `WORKSPACE_RECONCILIATION_REQUIRED` (HTTP 409) is emitted where the operation row/journal may exist and reconciliation has failed closed or is not currently drivable (`failClosed`, `requireReconcilableState`). `PROJECT_LOCKED` remains only for proven no-side-effect refusals of the request itself. The backend owns the phase knowledge; the frontend must not infer it from the error code. Cost if wrong: an operator-facing code rename — wire-only, additive.
- R3 (verification shape, design 6.3): the helper verifies installability for the TARGET interpreter/platform with the production install shape minus selected extras: `uv sync --locked --no-dev --no-build --no-config --no-python-downloads --dry-run` in the scratch. Extras are template-owned and validated at image seed build (`prepare-python-seed.sh` runs a real extras sync at build time); the browser UI can only edit base `[project]` dependencies. Cost if wrong: a template with a platform-specific extra could slip through — mitigated by the seed-build extras sync.
- R4 (budget integrity): ONE wall-clock deadline spans the helper's `uv add/remove` AND the verification step; the total stays within the configured budget so the cross-module ordering invariant (agent total wait = budget + 2 s, strictly below the backend prepare timeout = budget + 10 s) holds at every budget in 1..600.
- R5 (category passthrough, design 6.3 "具体类别"): `PYTHON_DEPENDENCY_NO_WHEEL` becomes a fixed end-to-end category: helper token → agent code → backend 422 pass-through → browser fixed message. No uv stderr ever reaches the browser.

## Task 1: Workspace write lock for in-flight and unconfirmed dependency operations (review finding 1, P1)

Defect: `PythonDependenciesPanel.tsx` reloads the whole workspace after a committed dependency change while the editor stays writable during the request; edits made during `submitting` (or between a lost response and a Check) are destroyed silently by `reloadWorkspaceAfterTerminalRun` (buffer/model disposal).

Required behavior:
1. The shell computes its write gate as: run-derived `writesLocked` OR dependency-operation-in-flight OR unconfirmed operation present. The gate drives the same plumbing today's `writesLocked` drives (`EditorWorkspace`, `FileTree`) — no new lock mechanism, no second coordinator.
2. `PythonDependenciesPanel` reports its busy state (any phase ≠ `idle`) upward via a new callback prop so the lock holds regardless of which panel tab is visible; the busy state ends exactly when the phase returns to `idle` (success, safe rejection, or reported lost response).
3. With `unconfirmedOperationId !== null` (session-restore or reported lost response) the write gate is closed from the moment the shell knows, including on first mount from sessionStorage.
4. `PythonDependencyRecovery` (ready variant) refuses Check while the workspace session is dirty and shows the same reason text the panel uses ("Save or discard file changes first"); after save/discard the Check is enabled. The failed variant is unaffected (no editor mounted).
5. Guard the reload side: if a reload-after-commit or reload-after-recovery would run while dirty buffers exist, it must not destroy them — with items 1–4 this is unreachable; add one belt-and-braces test proving the panel's success reload is not reached from a dirty state (lock asserted), not a silent-skip path in the reload function.

Tests (RED first, `PythonDependenciesPanel.test.tsx`, `WorkbenchShell.test.tsx`, `PythonDependencyRecovery.test.tsx`): at minimum —
- during `submitting`, the write gate is closed (assert the same observable the existing run-lock tests assert); it reopens after a safe rejection and after success;
- with an unconfirmed id present at mount, the write gate is closed;
- Check is disabled while dirty (ready variant) with the visible reason, enabled after the dirty state clears;
- existing suite stays green (some existing tests may assert the opposite — update them to the new contract, never delete coverage).

Files: `poc4/frontend/src/components/shell/WorkbenchShell.tsx`, `poc4/frontend/src/features/dependencies/PythonDependenciesPanel.tsx`, `poc4/frontend/src/features/dependencies/PythonDependencyRecovery.tsx`, their tests. Verify: targeted vitest run of the three files, then full `pnpm -C poc4/frontend test` (exit 0).

## Task 2: READY page discovers server-pending dependency operations (review finding 2, P2)

Defect: `WorkbenchShell.tsx` only learns an unconfirmed operation from sessionStorage. After a restart with READY + PENDING, a new browser session has no id: reads are gated by the durable PENDING, the revision never loads, Add stays disabled, and no Check entry exists — a dead end.

Required behavior:
1. On a Python workbench for an authenticated user with NO unconfirmed operation known, the shell queries `GET /python-dependencies/pending` once (`listPendingPythonDependencies`). When a pending operation is returned, it stores the operation id (`storePythonDependencyOperationId`) and adopts it as the unconfirmed operation — the existing recovery entry and Task 1's write gate engage.
2. Design 6.1 constraint "该查询不能覆盖客户端已保存的另一操作 ID": before adopting a discovered id, re-check the stored id; if one appeared while the query was in flight, ignore the discovery result entirely.
3. A failed discovery query must not fabricate absence: show a small retry affordance (banner with a Retry button, same visual family as the existing recovery banners). A retry that finds nothing renders nothing. Do not poll.
4. Non-Python projects never issue the query. The query is not issued when an unconfirmed operation is already known (state or storage).
5. Backend changes: none — `GET /python-dependencies/pending` exists, owner-scoped, PROJECT_BUSY under lease contention; the retry affordance covers the transient 409/network cases.

Tests (RED first, `WorkbenchShell.test.tsx`): pending found → recovery entry rendered + sessionStorage written + write gate closed; pending empty → nothing; query error → retry affordance, retry succeeds; id stored mid-flight → discovery ignored (design constraint); Java project → no request issued. Verify: targeted files then full frontend suite (exit 0).

## Task 3: Honest wire code for unresolved workspace operations (review finding 3, P2)

Defect: the panel lists `PROJECT_LOCKED` as a proven no-side-effect rejection and deletes the stored operation id. The backend also returns `PROJECT_LOCKED` from `WorkspaceOperationService.failClosed` (commit/receipt-verification failure scenes — a registered PENDING row may exist and files may already be applied) and from `PythonDependencyService.requireReconcilableState` (a registered PENDING is not currently drivable). The frontend then hides the recovery entry, re-enables Add and tells the user to stop a Run — wrong on all counts.

Required behavior:
1. Backend (ruling R2): add `WORKSPACE_RECONCILIATION_REQUIRED` to `ApiError.CODES` and `safeMessage` ("Workspace needs reconciliation; the operation result is not confirmed"). `WorkspaceOperationService.failClosed(...)` throws it (was `PROJECT_LOCKED`; it still marks the project FAILED with the `WORKSPACE_RECONCILIATION_REQUIRED` reason — unchanged). `PythonDependencyService.requireReconcilableState` throws it.
2. Backend classification test (required by ruling R2): walk EVERY `ApiException("PROJECT_LOCKED", …)` reachable from the dependency POST path and pin down, with a test, that the remaining sites (`changeLocked` active-Run gate; `registerPending`/`beginWithRecovery` project-state refusals) answer only scenes where no operation row was registered for the request and no workspace mutation was applied. If any site cannot be proven side-effect-free, it moves to the new code — record which in the report.
3. Frontend: `PROJECT_LOCKED` stays in `NO_SIDE_EFFECT_CODES` (proven pre-flight). Add `WORKSPACE_RECONCILIATION_REQUIRED` to the result-unknown path: keep the stored id, call `onResponseLost(operationId)` (recovery entry engages, Task 1's write gate closes) and show the fixed message "The result of the dependency change is unknown. Check it before making another change." — never "stop the Run".
4. Mocks/handlers that simulate these scenes must be updated to the new code with realistic semantics (see Global Constraint 6 for what mocks may not claim).

Tests (RED first): backend — `WorkspaceOperationServiceTest`/`PythonDependencyOperationTest` for both re-mapped sites (new code, row still PENDING, project FAILED(reason) where failClosed runs), a test pinning the active-Run rejection as still `PROJECT_LOCKED`, and the HTTP contract test asserting the new code on the wire; frontend — panel test for the new code (id kept, `onResponseLost` called, message) and for `PROJECT_LOCKED` (id cleared, existing message). Verify: backend targeted (`-Dtest=` the touched classes) then full backend suite BUILD SUCCESS; frontend targeted then full suite exit 0.

## Task 4: Persist the recovery-discovered operation identity (review finding 4, P2)

Defect: `PythonDependencyRecovery.check` keeps a pending-list-discovered id in a local variable only. If the reconcile request committed server-side but its response was lost, the next Check finds an empty pending list, never queries the original (now COMMITTED) operation, and the unconfirmed entry is stuck forever.

Required behavior:
1. When Check discovers the target through the pending list, it persists it (`storePythonDependencyOperationId(userId, projectId, target)`) BEFORE issuing the status/reconcile requests, and adopts it in component state so every subsequent Check queries the SAME operation.
2. The controlled variant (READY page, id passed by the shell) is unchanged — the shell already persists.
3. Success still clears the stored id exactly once; failure paths keep it.

Tests (RED first, `PythonDependencyRecovery.test.tsx`): first Check — pending query returns the id, reconcile response lost (network failure); second Check — MUST query `GET /{operationId}` (assert the URL), reach COMMITTED, call `onRecovered`, clear storage; the pending list is not consulted again. Also: UNCONFIRMED status still keeps the entry (existing contract). Verify: targeted file then full frontend suite (exit 0).

## Task 5: Verify target-platform installability before PREPARED (review finding 5, P2)

Defect: `python-dependency-helper.py` treats a successful `uv add/remove --no-sync --no-build` as preparation success. Real-container verification: adding `pywin32` succeeds, then the production `uv sync --locked --no-dev --no-build` fails at application start (no Linux wheel) — the app can never start, violating design 6.3's fixed "缺 wheel" category.

Required behavior:
1. Helper (rulings R3/R4): after a successful ADD/REMOVE uv run in the scratch, run the verification `uv sync --locked --no-dev --no-build --no-config --no-python-downloads --python /usr/local/bin/python3 --dry-run` in the same scratch (note: WITHOUT `--no-sync`; extras are out of scope per R3). ONE monotonic deadline covers both invocations; whichever phase exhausts it fails `PYTHON_DEPENDENCY_TIMEOUT`. A non-zero verification result maps through the existing collapsed-text markers: a no-usable-wheel phrase → `PYTHON_DEPENDENCY_NO_WHEEL`, anything else → `PYTHON_DEPENDENCY_RESOLUTION_FAILED`; the exact observed uv phrasing for the platform-wheel case must be captured in the container test and, if not already matched, added to `NO_WHEEL_MARKERS` minimally. Failure of the verification means NO journal (`stage` stays unreachable) and workspace sources untouched (already the flow).
2. Backend (ruling R5): `PythonDependencyService.prepareFailure` passes agent code `PYTHON_DEPENDENCY_NO_WHEEL` through as 422 with its own fixed message (register the code in `ApiError.CODES` + `safeMessage`).
3. Frontend: add `PYTHON_DEPENDENCY_NO_WHEEL` to `NO_SIDE_EFFECT_CODES` with the fixed message "No compatible wheel is available for the requested package or version." (proven no-side-effect: prepare failed before any journal/row).
4. Container test (the RED proof for the helper): new scenario in `poc4/python-runner/tests/dependency-editor.sh` — prepare an ADD of a package that resolves but has no wheel for the Linux target (use `pywin32` with a pinned exact version; confirm the exact behavior with real uv first) → agent answers 422 `PYTHON_DEPENDENCY_NO_WHEEL`, no journal exists, workspace digests unchanged. Record the scenario timing. Re-run the FULL dependency-editor suite (all existing scenarios must stay green — `prepare-add`/`prepare-remove-commit` now exercise the verification; their timing reflects it).
5. Docs: update the helper module docstring, and one line each in `poc4/python-runner/README.md` (prepare verification next to the documented install argv) and the design doc §6.2/§6.3 (prepare = fixed add/remove PLUS the fixed dry-run installability verification; the `PYTHON_DEPENDENCY_NO_WHEEL` category is end-to-end).

Tests: container scenario (above) is the behavioral gate; backend targeted tests for the new pass-through mapping and ApiError registration; frontend panel test for the new safe rejection message; helper syntax check (`python3 -m py_compile` or equivalent inside the container). Verify: workspace-agent module tests, backend targeted + full suite, frontend targeted + full suite, and the full dependency-editor container suite (needs Docker daemon up and network to pypi.org — record both preconditions in the report; if Docker is unavailable, report BLOCKED with evidence, do not fake it).

## Verification matrix (controller)

| Task | RED proof | Module gates |
| --- | --- | --- |
| 1 | new lock/Check-gate tests fail | frontend 3 files + full suite exit 0 |
| 2 | discovery tests fail | WorkbenchShell tests + full suite exit 0 |
| 3 | new-code tests fail both sides | backend full BUILD SUCCESS + frontend full exit 0 |
| 4 | stuck-entry test fails | recovery tests + full suite exit 0 |
| 5 | container scenario fails on current helper | agent module + backend full + frontend full + dependency-editor suite green |
