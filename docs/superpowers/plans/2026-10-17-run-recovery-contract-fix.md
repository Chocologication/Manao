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

Independent specification/code review: Approved after the stop-intent fix, no remaining findings. No new production module, field, migration, dependency or frontend behavior was added; the fix is limited to Run persistence/observation. Repair commit: `16e030da3f9b6ef2ae5b3dfe53f7766c4868a55c`.

## Focused release and browser verification

- Tested jar SHA256: `7bcbf3c132aaea4fe878c45b404a47c95acef610e413e5281a4f1fbd427e62bb`.
- Published tag: `chocologic/manao_images_repository:ai-run-recovery-20261017-16e030d`; pushed/rollout digest: `sha256:6d255a093f503c435efc13fcad70daa5cc2bc97f40a930a8df5ee14817eb9846`.
- Build used the existing accepted runtime image as a pinned parent (`sha256:28e709556a56eb6c6c2a110735479d17504c9f90b10850e995cfaabeeb2948a6`) and copied only the tested jar with UID/GID 10001. USER, ENTRYPOINT and both HTTP retry JVM properties were inspected and preserved. Standard multi-stage dependency resolution was not re-claimed as PASS. This parent digest is also the rollback target; rollback reintroduces the known timestamp defect.
- Context `kubernetes-admin@learn`, namespace `manao-stage6b`; three nodes Ready; existing `backend` Deployment Recreate rollout succeeded. New Pod `backend-7486f8675b-h7gld`, UID `befebca5-aa9e-4ac9-9275-dc687c0f8aaf`, ready=true; imageID matched the pushed digest. Only the backend image was changed.
- At `2026-10-17T08:39:23.261Z` (16:39 Asia/Shanghai), authenticated browser check passed: active/history GET 200, 20 history entries, both load warnings absent and Stop run enabled. The same Run/revision remained active, `startedAt` became `2026-10-17T06:52:10Z`, with original firstReady/expiry unchanged. Existing ready evidence supplied the missing first running observation; no manual SQL repair was used.
- [Sanitized browser evidence](../../../poc4/docs/evidence/ai-stage2/run-recovery-20261017/browser.json) and [screenshot](../../../poc4/docs/evidence/ai-stage2/run-recovery-20261017/run-authority-restored.png) retain this bounded check. Logs showed Reconnecting in the screenshot; log-stream health was outside this check and is not claimed PASS.
- The user's Edge tab needed login after refresh. The first automated browser attempt also lost its in-memory auth when it performed a full navigation after login and timed out looking for Run. The corrected check used the existing project's login redirect and passed; this harness navigation error is not reported as an application regression.
- Cleanup: disposable MySQL container `manao-run-recovery-mysql-20261017` (`8c3a3f01...`) had zero `manao_stage6_` schemas, then its exact ID and anonymous volume were removed; final name-filter inventory was empty. The frontend verification log was deleted. Automatic approval review rejected the later batch recursive deletion of the temporary browser script, image build context, duplicate evidence directory and intermediate logs with `blocked by policy`; those files are RETAINED, not deleted. The script has only the private configuration path, no embedded credentials, and must not be committed. No runtime-schema reset or project resource deletion occurred.

The original Stage 2 model/browser-main/close acceptance remains paused and NOT_GRANTED. No cloud-model request, new Agent task, application start/stop, user-source edit, Git merge or Git push was performed in this repair round. Prior uncommitted Stage 2 documents, verifier changes and continuation files remain separate from the repair commit.
