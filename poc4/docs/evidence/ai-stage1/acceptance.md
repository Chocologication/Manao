# AI Stage One Implementation Record (pi-stage1 plan, Tasks 1–6)

Date: 2026-10-14/15. Branch `codex/ai-integration`, worktree `.worktree/ai-integration`.
This record owns the real execution results of the stage-one implementation round:
what ran, what passed, what was NOT_RUN, and exactly which external condition is
missing for each NOT_RUN item.措辞遵循 PASS / FAILED / SKIPPED / WAIVED_BY_USER /
NOT_REVERIFIED / NOT_RUN 的严格区分；缺什么条件就记什么，不合并成模糊的“已完成”。

## 1. Verdict summary

| Claim | Status |
| --- | --- |
| Stage-one source Tasks 1–5 implemented on `codex/ai-integration` | DONE (commits in section 2) |
| Unit / component verification of Tasks 1–5 (backend 101/101, worker 21/21, frontend 1367/1367, container suites) | PASS (latest rounds; Task 6 re-ran the worker and frontend suites, section 3) |
| Task 6 acceptance harness, fixtures, release preparation authored | DONE (statically checked only — section 3.1) |
| Independent acceptance-fixture build re-verification (Docker Maven, error→fix) | PASS (real run, section 3.2) |
| Component drill: disposable MySQL + backend + worker, model-key-missing refusal | PASS (real run, section 3.3; local mock API endpoint labeled below) |
| Operator ledger verification script (`ai-stage1-verify-ledger.mjs`) authored and exercised | PASS (real runs against fixture ledger rows, section 7) |
| Independent re-verification script (`ai-stage1-independent-reverify.mjs`, same read-only-copy executor path + pom overlay) authored and exercised | PASS (real runs, broken→FAIL and repaired→PASS, section 7) |
| Worker Deployment/Service manifest (`pi-worker.yaml`) with placeholders | DONE (review-only; applied only with authorization) |
| Real model coding-and-repair loop in a browser against a real deployment | NOT_RUN |
| Cluster rollout (V11 on the runtime schema, images, worker manifest, network policy apply) | NOT_RUN — needs explicit user authorization |
| CNI enforcement measurement of the development network policy | NOT_RUN |
| `PI_STAGE1_CODE_TEST_LOOP_PASS` | **NOT_GRANTED** — the real loop never ran; nothing in this record claims it |

`PI_STAGE1_CODE_TEST_LOOP_PASS` may only be claimed by the real acceptance round
(real cloud model, real cluster, browser E2E plus the independent re-verification
of the SAME task's build). No mock, no simulated provider output and no component
drill in this record substitutes for it.

## 2. Implemented work and commits

Stage-one commits on `codex/ai-integration` (Tasks 1–5 and their fix rounds,
baseline `ef852b7`):

- `1f2298e` feat(ai): persist stage-one task ownership (Task 1)
- `c5fe549` feat(ai): expose receipt-backed project file tools (Task 2)
- `9eb54e7` feat(ai): add isolated Maven build tool (Task 3)
- `92b1a15`, `d30fb33`, `1a78404` feat(ai): connect Pi to project tools and task lifecycle (Task 4 + fixes)
- `8aafdb3`, `9f93dce`, `46eaae0`, `7ef0760` fix(ai): close/fencing/hardening rounds
- `f499a7f` feat(ai): add minimal browser task panel (Task 5)
- `d0952b4` fix(ai): gate workspace release on the settled task snapshot and share the reload lock with the panel

Task 6 deliverables (this commit, `test(ai): verify stage-one coding and repair loop`):

| File | Purpose |
| --- | --- |
| `poc4/frontend/tests/fixtures/ai-stage1/DemoControllerAcceptanceTest.java` | Verbatim acceptance fixture (plan Task 6 item 1); sha256 `78ffdfc166210ca204e0e1a2e23d36b9148f293fdc134ce4c6791ab57714bf84` |
| `poc4/frontend/tests/fixtures/ai-stage1/acceptance-pom.xml` | Acceptance-controlled pom (Boot 3.5.9 / Java 17 / web+actuator+test; `skipTests=false`, `skip=false`, surefire includes fixed to the fixture); sha256 `7c34a1a8235d09761814ab638418359e33c4e87ab91ef4c59d5d416e6002f2cb` |
| `poc4/frontend/playwright.ai-stage1.config.ts` + `tests/e2e/ai-stage1.spec.ts` | Browser acceptance: bootstrap id accepted via `MANAO_AI_ACCEPTANCE_PROJECT_ID`, exact prompt, occupancy/409 refusals, reload continuity, settle watch, repaired-source + unchanged-fixture + loop-shape assertions, editor display, release check |
| `poc4/frontend/scripts/ai-stage1-bootstrap.mjs` | Bootstrap: unique dedicated project (creationKey replay-safe), seeds the broken `DemoController` (`Instant.nwo()`) and the verbatim fixture, prints projectId/initial revision/fixture sha256 |
| `poc4/frontend/scripts/ai-stage1-verify-ledger.mjs` | Fix round 1: MANDATORY operator-side verdict step — read-only check of the durable ledger for the settled taskId (section 7); the browser never holds these credentials |
| `poc4/frontend/scripts/ai-stage1-independent-reverify.mjs` | Fix round 1: MANDATORY operator-side verdict step — independent acceptance build over the SAVED source through the same read-only-copy executor container path with the operator pom overlay and the Surefire report assertion (section 7) |
| `poc4/deploy/ai-stage1/README.md`, `pi-worker.yaml` + `development-network-policy.yaml` | Release preparation (images, V11, rollout order, rollback, runbook with the two mandatory verdict steps), the review-ready worker Deployment/Service manifest with placeholders, and the development egress policy manifest — all review-only, nothing applied |
| `poc4/frontend/package.json` (`test:e2e:ai-stage1`), `tsconfig.stage6.json` (spec/config typecheck include), frontend `Dockerfile` (`ARG VITE_ENABLE_AI=false`), `.gitattributes` (fixture LF) | Wiring for the above |
| `poc4/pi-worker/src/server.ts` | Fix found by the drill: production boot main was missing (section 3.4) |

## 3. Real commands and results (this round)

### 3.1 Static checks on the Task 6 deliverables

```text
poc4/frontend: pnpm typecheck:stage6   PASS (ai-stage1.spec.ts + playwright.ai-stage1.config.ts compile clean)
poc4/frontend: pnpm exec eslint playwright.ai-stage1.config.ts tests/e2e/ai-stage1.spec.ts   PASS (no findings)
poc4/frontend: node --check scripts/ai-stage1-bootstrap.mjs   PASS
poc4/frontend: pnpm typecheck   PASS (full project build check)
poc4/frontend: pnpm test        PASS 73 files / 1367 tests (whole suite; includes src/features/ai, WorkbenchShell, RunPanel)
poc4/pi-worker: pnpm exec tsc --noEmit   PASS
poc4/pi-worker: pnpm test       PASS 3 files / 21 tests (after the section 3.4 fix)
poc4/pi-worker: pnpm build      PASS
```

Backend code is unchanged by Task 6 (the drill consumed the built jar); the last
full backend verification remains the Task 5 round (five suites, 101/101, green).

### 3.2 Independent acceptance-fixture re-verification (real, isolated Docker)

Environment: Docker 29.8.1; image `maven:3.9-eclipse-temurin-17`
(`sha256:1a352420f7aba21f5ad08df31bab55f74c013fb491f1ae8ab1dd7ff9ed698584`); a
unique temp workspace `ai-stage1-reverify-*` holding the acceptance pom verbatim,
the template `App.java`, the fixture at
`src/test/java/com/example/app/DemoControllerAcceptanceTest.java`, and a
`DemoController` seeded with the plan's locateable compile error. Maven used the
host repository mounted read-write at `/m2` (cache only; no cluster, no platform).

1. RED — `mvn -B -ntp test` with the broken source:
   **exit 1**, and the ONLY compilation error is
   `DemoController.java:[14,52] cannot find symbol: method nwo() location: class java.time.Instant`
   — exactly the seeded, locateable error a real loop must read and repair.
2. GREEN — after replacing the source with the repaired controller
   (`Instant.now()`, message `Hello from Pi`): **exit 0**,
   `Tests run: 1, Failures: 0, Errors: 0, Skipped: 0` and the Surefire XML exists
   at the fixed path `target/surefire-reports/TEST-com.example.app.DemoControllerAcceptanceTest.xml`
   with `tests="1" errors="0" skipped="0" failures="0"` — the path and shape the
   `manao-dev-build` log-tail collector reads.
3. Fixture integrity — after the round the seeded fixture still hashes to
   `78ffdfc166210ca204e0e1a2e23d36b9148f293fdc134ce4c6791ab57714bf84`.
4. Skip-flag resistance (the "不受用户pom中的skip/excludes影响" requirement) —
   running `mvn surefire:test -DskipTests=true -Dmaven.test.skip=true` against the
   acceptance pom STILL executed the fixture (`Tests run: 1`): the pom's forced
   `skipTests=false` / `skip=false` plugin configuration overrides the CLI
   properties, so a skip flag can never produce a fake pass.

This proves the fixture + acceptance-pom pair compiles, fails and passes for real,
and produces the Surefire evidence the acceptance contract requires. It is a
fixture/pom verification — NOT a model-loop result.

### 3.3 Component drill: disposable MySQL + backend + worker (real, local only)

Purpose: verify the worker↔backend↔database chain and the "model key missing →
explicit pre-start failure" behavior end to end WITHOUT any cluster and WITHOUT
any model. Everything used unique `ai-stage1-drill-*` names and was torn down and
independently checked at the end (no listeners left on 18080/18090/16443/33306;
container removed; temp dirs removed).

- MySQL: `mysql:8.0.40` container `ai-stage1-drill-20261014-mysql`, disposable
  schema `manao_ai_drill` on host port 33306 (runtime schemas never touched).
- Backend: the built jar (`manao-poc4-backend-0.0.1-SNAPSHOT`) with
  `MANAO_AI_ENABLED=true`, `MANAO_AI_PROJECT_ID=drill-project-0001`, worker route
  and internal tokens set, and **no model configuration anywhere** (the backend
  never receives one). Local-cluster profile boot requirements were satisfied with
  a throwaway Ed25519 capability pair, digest-form runner image references
  (`manao-pi-stage1-runner:test`, image id `sha256:00e979284f82…7b69f8`, local
  test tag only) and a placeholder kubeconfig pointing at
  `https://127.0.0.1:16443`. Because the local-cluster preflight fail-closed on a
  dead endpoint (by design), a tiny LOCAL mock HTTPS server answered the two
  preflight calls (`/version`, self-subject access reviews) on that loopback port.
  **Labeling: the mock API server is component-connectivity plumbing only — it is
  not a Kubernetes cluster, not a model, and not PI_STAGE1 evidence.**
- Worker: built from source (`pnpm build`) and run with every non-model field set
  and NO model fields (`MANAO_AI_PROVIDER/_API_TYPE/_BASE_URL/_MODEL/_API_KEY`
  all absent).

Real results:

1. **Flyway V11 applied on the disposable schema**: schema version reached 11 with
   `agent_task` and `agent_tool_call` created (`Successfully validated 11 migrations`).
2. **Worker boot without model config**: the worker boots for health/reconciliation
   (per `.env.example` contract) and **refuses every task start**:
   `POST /tasks/{id}/start` → **HTTP 503 `{"error":"AI_WORKER_NOT_CONFIGURED"}`**;
   wrong worker token → **HTTP 401**; reconciliation GET → `task not found`.
3. **Full chain, explicit pre-start failure**: browser-API task submit (minted
   drill JWT for user `drill-owner`, project `drill-project-0001` READY at
   revision 7) → snapshot `QUEUED`, `writesLocked=true` → backend called
   `worker.start`, received the 503, and settled the task itself:
   `state=FAILED`, `failureCode=AI_WORKER_NOT_CONFIGURED`,
   `summary="the worker has no model configuration"`, `writesLocked=false`;
   `GET .../agent-tasks/current` then returns 404 (occupancy released); the
   `agent_task` row carries `worker_epoch=1`, `worker_instance_id=NULL`,
   `failure_code=AI_WORKER_NOT_CONFIGURED`.
4. **Internal fencing (live)**: the same browser JWT on
   `POST /internal/ai/tasks/{id}/calls/{toolCallId}` → **401** (a browser JWT can
   never reach worker routes).
5. A task id that is not a canonical UUID is rejected `VALIDATION_ERROR` (the
   browser contract generates the UUID) — recorded because the drill hit it.
6. Known drill artifact: file/tree APIs for the drilled project return 500 — the
   project has no real workspace-agent behind the mock endpoint; irrelevant to the
   AI chain under test and not a defect claim.

Teardown, stated in layers (corrected in fix round 1; the original "killed by PID,
nothing shared touched" wording was broader than what actually happened):

- Precisely identified and removed: the `mysql:8.0.40` container
  `ai-stage1-drill-20261014-mysql` (`docker rm -f`), all `ai-stage1-*` temp
  directories (worker scratch, kubeconfig/CA dir, mock script, drill logs), the
  backend JVM by the PID listening on 18080, and the two drill node processes by
  the PIDs listening on 16443 and 18090.
- Batch-terminated, NOT PID-precise: before the PID kills, one
  `taskkill /F /IM node.exe` with the filter `WINDOWTITLE ne zcode*` ran on the
  Windows host (it reported terminating node PID 30836). Known objects: the drill's
  own node processes. NOT confirmable from this record: whether any OTHER
  window-title-less node process existed on the machine at that moment; the four
  drill ports being free afterwards proves nothing about unrelated processes.
  Follow-up local diagnostics for that uncertainty are arranged by the controller
  outside this record — this document does not defer the confirmation to the user.
- Port/container/temp verification after teardown: no listener on
  18080/18090/16443/33306, no `ai-stage1-*` container, no leftover temp dir —
  these checks are real and scoped to the drill's own resources only.

### 3.4 Defect found and fixed by the drill

The Task 4 worker had **no production boot path**: `dist/server.js` exported
`createTaskServer` but nothing read the environment, validated the configuration
or called `listen()` — `node dist/server.js` (the Dockerfile CMD) exited
immediately (observed: empty log, exit 0, port never bound), and
`loadWorkerConfig`/`ConfigError` were never invoked anywhere. Unit tests could not
catch it because they construct the server directly.

Fix (this commit): a guarded module entry in `src/server.ts` — when invoked
directly it runs `loadWorkerConfig(process.env)` (fail-fast, every missing field
listed, exit code 78/EX_CONFIG), creates and listens on the task server, and
installs SIGTERM/SIGINT close handlers; imported as a module it does nothing.
Re-verified: `tsc --noEmit`, 21/21 worker tests, and the live drill behaviors in
section 3.3 (503/401 refusals, full-chain FAILED verdict) came from this boot path.

## 4. Versions and identities (this round)

| Item | Value |
| --- | --- |
| Pi SDK | `@earendil-works/pi-coding-agent@1.2.0` (reference snapshot `7d75a0e3`) — locked by Task 4; no model was contacted this round |
| Node / pnpm | Node v24.12.0 (host) / pnpm 10.33.0; worker image base `node:24-bookworm-slim` |
| Java / Spring Boot | Temurin 17.0.16; backend Spring Boot 3.5.9; template and acceptance pom both Boot 3.5.9 / Java 17 |
| Maven runner image | local test tag `manao-pi-stage1-runner:test` (image id `sha256:00e979284f82d6ab6c934b08e08313e694056adf4ac13f5317bfce78d97b69f8`) — NOT a release digest |
| Drill images | `mysql:8.0.40` (`sha256:d58ac933…da2b7ff`), `maven:3.9-eclipse-temurin-17` (`sha256:1a352420…698584`) |
| Model provider / API type / baseUrl / model / key | **none exists** — nothing was configured, invented or billed; the real provider configuration is a user decision recorded in the deploy README prerequisites |
| Released image digests | **none yet** — publishing is part of the user-authorized rollout (deploy README section 2; digests recorded at that time) |

## 5. NOT_RUN / BLOCKED register

| Item | Status | Missing condition (exact) |
| --- | --- | --- |
| Real model coding-and-repair loop (the acceptance scene of `ai-stage1.spec.ts`) | NOT_RUN | (a) a real cloud provider configuration on the worker: `MANAO_AI_PROVIDER`/`MANAO_AI_API_TYPE`/`MANAO_AI_BASE_URL`/`MANAO_AI_MODEL`/`MANAO_AI_API_KEY` — no such key exists and none may be invented; (b) the user-authorized acceptance deployment (backend `MANAO_AI_ENABLED=true` + `MANAO_AI_PROJECT_ID`, worker, frontend built with `VITE_ENABLE_AI=true`); (c) Playwright browser binaries for the acceptance run (not installed on this machine; not force-installed) |
| Cloud rollout: V11 on `manao_poc4_6b`, new backend/worker/frontend/runner images, worker manifest, network policy apply | NOT_RUN | Explicit user authorization for touching the existing cloud deployment; the prepared, reviewable content is in `poc4/deploy/ai-stage1/README.md`. Nothing was applied to `manao-stage6b` or its database |
| CNI enforcement measurement of `development-network-policy.yaml` | NOT_RUN | A real cluster authorized for the round; a policy resource alone is not evidence (manifest header records the operator duties and the measurement requirement) |
| Single-worker/single-backend no-overlap update verification | NOT_RUN | Same authorization; the rollout order (Recreate strategy, one replica each) is prepared in the deploy README |
| Post-E2E dedicated-project deletion and leftover reconciliation | NOT_RUN | Follows the real E2E round; the runbook step is in the deploy README section 7 |
| `PI_STAGE1_CODE_TEST_LOOP_PASS` | **NOT_GRANTED** | The real loop above never ran; component drills and the fixture verification do not substitute for it |

Nothing in this round was SKIPPED silently: every check that could run locally
ran and passed; everything else is listed here with its missing condition.

## 6. Evidence contract for the real round (what must be recorded)

When the authorized acceptance round runs, this file gains a dated section with:
the bootstrap JSON summary (projectId, initial revision, fixture sha256), the
submitted taskId and prompt, SDK/provider/model identity, the failing and passing
build toolCallIds with real exit codes and Job/Pod identities from the backend
tool ledger, the cleanup confirmations, the successful build's Surefire XML counts
(tests>=1, failures=0, errors=0, skipped=0) taken before pod cleanup, the
independent re-verification result of the SAME task's build, the initial→final
revision pair, changed paths, resource cleanup results, and any unresolved
diagnostics. Only that section may carry `PI_STAGE1_CODE_TEST_LOOP_PASS`.

The verdict REQUIRES both operator-side scripts to PASS on the same taskId (in
addition to the browser scene): `ai-stage1-verify-ledger.mjs` (ledger: first build
real non-zero exit → receipted DemoController write → later goal=test build exit 0
with cleanupConfirmed and Job identity → acceptance Surefire report tests>=1,
failures=errors=skipped=0) and `ai-stage1-independent-reverify.mjs` (same
read-only-copy executor path over the saved source with the operator pom overlay
and the report assertion). A browser scene that is green without these two steps
is not an accepted round.

## 7. Fix round 1 (2026-10-15): operator evidence verification and honest teardown

Review findings addressed: (1) the browser-only tool_end shape could not prove
real exits, the repaired file, or the test report — two operator-run verdict steps
now close that gap; (2) the independent re-verification had no executable path;
(3) the worker manifest was deferred; (4) the teardown wording over-claimed.

New deliverables (this fix commit):

- `poc4/frontend/scripts/ai-stage1-verify-ledger.mjs` — operator-side, read-only
  ledger verification (SELECTs only) over the durable `agent_task` /
  `agent_tool_call` rows for one taskId. It fails unless: the task is COMPLETED;
  EVERY tool call is COMPLETED (any unsettled row fails); the first build has a
  real non-null non-zero exitCode; a receipted write to
  `src/main/java/com/example/app/DemoController.java` happened after it; a later
  `goal=test` build exited 0 with `cleanupConfirmed=true` and full Job identity
  (job/uid/pod); the acceptance test's Surefire report shows tests>=1 with
  failures=errors=skipped=0 — a missing report or `reportsDropped=true` fails.
  Transport: a MySQL client command (default `mysql`, or a container client via
  `MANAO_AI_VERIFY_MYSQL_CMD`); password via `MYSQL_PWD` env or, for container
  transports, `-p` argv with `MANAO_AI_VERIFY_MYSQL_PASSWORD_MODE=arg`. It is run
  by the acceptance operator; the browser never holds these credentials.
- `poc4/frontend/scripts/ai-stage1-independent-reverify.mjs` — the independent
  re-verification with the SAME read-only-copy executor semantics the cluster
  build uses: the fixed `manao-dev-build copy` on a read-only `/source` bind
  mount (same UID 10001, read-only rootfs, tmpfs /tmp, no network), then the
  operator-controlled `acceptance-pom.xml` overlaid as the SCRATCH copy's pom
  only, then `manao-dev-build run test` in a container that mounts ONLY the
  scratch, the maven cache and /tmp — never /source. The verdict requires copy
  exit 0, run exit 0, the Surefire report read from the fixed
  `MANAO-SUREFIRE-REPORT-BEGIN/END` log-tail markers with tests>=1 and
  failures=errors=skipped=0, an unchanged source fingerprint, and name-filtered
  container cleanup. Source modes: `--source <dir>` (isolated local drill) and
  `--api` (exports the SAVED, model-modified project through the owner file API —
  the real round's path; NOT_RUN here, no deployment exists).
- `poc4/deploy/ai-stage1/pi-worker.yaml` — review-ready worker Deployment +
  Service with placeholders: single replica Recreate, runAsNonRoot uid 1000,
  dropped capabilities, read-only rootfs, worker-private emptyDirs only (scratch,
  agent dir, session dir, tmp), no ServiceAccount token, TCP probes (the worker
  has no HTTP health route), model fields from a dedicated Secret with no real
  values. Applied only with user authorization.

Real executions this round (all local, unique prefixes, cleaned up):

1. Independent re-verification script, `--source` mode, image
   `manao-pi-stage1-runner:test` (local test tag):
   - BROKEN source (`Instant.nwo()`): **FAIL, exit 1** — "manao-dev-build run test
     exited 1" + "no Surefire suite for
     com.example.app.DemoControllerAcceptanceTest"; copy exited 0, pom overlaid,
     source fingerprint unchanged, no containers left, temp tree deleted.
   - REPAIRED source (Hello from Pi): **PASS, exit 0** — copy 0, run 0, report
     `tests=1 failures=0 errors=0 skipped=0` parsed from the log-tail markers,
     fingerprint unchanged, cleanup confirmed.
2. Ledger verification script against fixture rows in a disposable MySQL schema
   (`ai-stage1-verify-mysql`, container removed after; the rows are
   fixture-shaped, NOT a real loop, and prove only the script's verdict logic):
   - positive loop fixture (build exit 1 → receipted write → test build exit 0
     with passing report): **PASS, exit 0** (20 checks OK);
   - compile-only trap (task COMPLETED with a single exit-0 `compile` build):
     **FAIL, exit 1** — exactly the "model only ran compile" case the review
     demanded be caught;
   - empty/FAILED task: **FAIL, exit 1**.
   The fixture run also surfaced a real verifier fragility — with identical
   `created_at` stamps the loop-shape order would be guessed from the random
   tool_call_id — fixed: order comes from `created_at` only and non-distinct
   timestamps now FAIL the verdict ("ambiguous tool-call order") instead of
   guessing. The `--api` source mode of the re-verify script and both scripts'
   use against a REAL deployment remain NOT_RUN (no acceptance deployment, no
   real model; conditions in section 5).

Rerun checks after the fix: `pnpm typecheck:stage6`, eslint on the touched
spec/scripts, full `pnpm test` (1367/1367), `pnpm build`, `pnpm exec tsc
--noEmit` (worker unchanged this round; no backend code change).

### Fix round 2 (2026-10-15): failure-code assertion and nested --api export

Review findings addressed: (1) the ledger verifier checked `state=COMPLETED` but
not `failure_code IS NULL`, and did not reject a verification build carrying a
persisted rejection; (2) the `--api` export would crash on the first nested file
(no parent-directory creation).

- `ai-stage1-verify-ledger.mjs` now FAILS when the task row is COMPLETED with any
  `failure_code` (the rule fires first, before the tool-call rules), and a
  verification build carrying `data.error` cannot be the verification run.
- `ai-stage1-independent-reverify.mjs`: the export walk is now the exported
  `exportProjectTree` function with `mkdirSync(recursive)` parent creation on
  every nested file; the CLI flow moved under a direct-invocation guard, so the
  unit test imports the module without executing anything.
- New `scripts/ai-stage1-independent-reverify.test.mjs` (`pnpm
  test:ai-stage1:scripts`, node --test): a stubbed fetch serves a nested
  workspace tree (pom.xml + src/main/java/com/example/app/*) and the SAME
  exported function the CLI uses must land every file with its parents created;
  a second case asserts HTTP failures surface as rejections. 2/2 PASS.

Real executions this round (disposable MySQL container removed afterwards; all
fixture rows are ledger-shaped, NOT a real loop):

- positive loop fixture: PASS (exit 0);
- COMPLETED task WITH `failure_code=AI_PROVIDER_ERROR`: **FAIL** — "task carries
  failure_code=AI_PROVIDER_ERROR; COMPLETED with a failure code cannot pass";
- synthetic verification build carrying `data.error` alongside a passing report:
  **FAIL** — "verification build#call-build-2 carries a persisted rejection…";
- compile-only trap and empty/FAILED task: FAIL (unchanged from fix round 1);
- re-verify CLI `--source` mode re-run after the refactor: PASS, report
  tests=1/failures=0/errors=0/skipped=0 (no regression);
- unit test 2/2; eslint on the three touched scripts clean; `pnpm test` 1367/1367;
  `pnpm typecheck:stage6` clean.
- `--api` full-chain against a real deployment remains NOT_RUN (no acceptance
  deployment, no real model; conditions in section 5).
