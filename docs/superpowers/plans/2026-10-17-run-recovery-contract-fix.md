# Run recovery timestamp contract repair

Date: 2026-10-17. Worktree: `.worktree/ai-integration`; branch: `codex/ai-integration`; starting HEAD: `70c09851a894feab5847d19208b61e020d409552`.

## Scope and evidence

The user paused Stage 2 acceptance close-out and requested repair of `Unable to load run authority/history`. Remaining Stage 2 work is retained in [the authority record](../../../poc4/docs/evidence/ai-stage2/acceptance.md), section 9.12. Do not resume the model-driven acceptance scenario or reinterpret its failed seventh round as PASS. Earlier explicit cluster release authorization covers this focused backend repair and page verification.

Live owner API reads returned HTTP 200 for active/history on project `905da5ae-40ef-469e-ba2b-5c0fd202070a`. Run `97795a6c-4111-4add-9e3a-7f449d2ca344`, revision 63, was `RUNNING` with `startedAt=null`, `firstReadyAt=2026-10-17T06:52:10Z` and `expiresAt=2026-10-17T08:52:10Z`. The same invalid row is in history. Frontend state invariants correctly reject it, so both queries render generic load errors.

`RunRecoveryService` runs every 15 seconds, moves active Runs to RECOVERING, and restores a live Run using generic `transition(RUNNING)`. That SQL does not initialize `started_at`. A recovery scan before normal `markRunning` can therefore persist the observed invalid combination. The observation recovery path additionally moves an already-started Run through STARTING and overwrites its start time. No per-transition production log exists to identify the exact historical branch for the observed Run; backend start preceded this Run's creation. No evidence links this incident to `COLLECTION_RUN_CHANGED`.

## Minimal repair contract

- Keep frontend validation and fail-closed editing intact.
- Every conditional transition into RUNNING initializes `started_at` in the same SQL write, retaining any existing value. For a legacy ready row lacking a start, use its persisted `first_ready_at` as the earliest available confirmed-running observation; otherwise use the current observation time. This is not a reconstructed container start time.
- Observation restores a known-started or currently-running RECOVERING Run directly to RUNNING. A never-started, non-running Run may return to STARTING. Never expose STARTING with existing start/readiness facts.
- Retain version, project and fencing guards, stop intent, immutable first-ready/expiry and existing Run identity. No migration, new adapter, scheduler or frontend contract relaxation.

## Execution and review

1. RED: use disposable real MySQL and the real recovery/store path to prove missing starts; prove observation overwrites an existing start; cover legacy ready rows and repeated recovery.
2. GREEN: apply only the conditional atomic timestamp assignment and observation target-state correction.
3. Run targeted Run store/recovery/observation/controller regressions and frontend Run contract tests once, review independently, and fix any demonstrated gaps.
4. Record actual commands/counts and deployment limits here. Preserve earlier uncommitted Stage 2 harness/docs without including them in the repair commit. No Git merge/push, project deletion or runtime-schema reset.

## Results

RED confirmed: real recovery/store tests failed twice with null `startedAt` (fresh STARTING and existing ready invalid row); observation failed with the original start replaced by current time. The earlier direct-transition reproduction also failed with null start.

GREEN: `mvn -Dtest=JdbcRunStoreTest,RunObservationServiceTest,RunRecoveryServiceTest,RunControllerTest package`: final 93 run, 0 failures/errors/skips and BUILD SUCCESS, including real disposable MySQL 8.0.40 on loopback port 33317. The first 91-test attempt used the old test-double bytecode and failed one existing observation test; after synchronizing the double with the new RunStore contract and recompiling, all 92 passed. Independent review then identified a recovering stop-intent boundary: non-running but inconclusive FOUND facts must never restore RUNNING. Its new regression failed with expected STOPPING / actual RUNNING, then passed after stop intent always took precedence; final 93 tests/package include that change.

`pnpm exec vitest run src/contracts/run.test.ts src/api/runApi.test.ts`: 126/126 passed. Frontend production code and validation are unchanged.

Independent specification/code review: Approved after the stop-intent fix, no remaining findings. No new production module, field, migration, dependency or frontend behavior was added; the fix is limited to Run persistence/observation. Focused backend publication/page verification: pending. Stage 2 model-driven acceptance remains paused and NOT_GRANTED.
