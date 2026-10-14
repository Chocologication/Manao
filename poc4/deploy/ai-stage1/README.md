# AI Stage One Deployment Assets (poc4/deploy/ai-stage1) — release preparation only

This directory holds the reviewed release preparation for the AI stage-one
acceptance (pi-stage1 plan Task 6): the images to build, the V11 migration, the
development-build network policy and the rollback path. **Every execution step
here is pending the user's explicit authorization.** Nothing in this round has
been applied to `manao-stage6b`, its database, or any shared cluster; this file
does not modify any existing 6B resource or private configuration.

Files:

| File | Purpose |
| --- | --- |
| `README.md` | This release preparation: images, migration, rollout order, rollback, acceptance runbook |
| `development-network-policy.yaml` | Manifest-level egress isolation for development build pods (DNS + public HTTP/HTTPS only). Actual CNI enforcement is NOT_RUN until a real cluster is authorized for the round |

Status (2026-10-14): source Tasks 1–5 implemented and locally verified; the
harness, fixtures and release preparation are authored and statically checked.
The real model loop, cluster rollout, CNI enforcement measurement and browser
E2E are NOT_RUN — see
[poc4/docs/evidence/ai-stage1/acceptance.md](../../docs/evidence/ai-stage1/acceptance.md)
for the exact missing conditions. `PI_STAGE1_CODE_TEST_LOOP_PASS` is NOT_GRANTED.

## 1. Prerequisites (every one must genuinely exist before the round)

| Requirement | Notes |
| --- | --- |
| Cloud model provider configuration | `MANAO_AI_PROVIDER` / `MANAO_AI_API_TYPE` / `MANAO_AI_BASE_URL` / `MANAO_AI_MODEL` / `MANAO_AI_API_KEY` on the **worker only**. As of this round no real key exists; the round must not invent one, switch to a mock, or choose a paid provider on its own |
| Docker on the operator machine | Verified available this round (29.8.1) for the isolated local checks |
| Disposable MySQL for local drills | Local MySQL is available; disposable schemas only — never reset `manao_poc4` or `manao_poc4_6b` |
| Acceptance K8s context/namespace | Cluster work (rollout, policy apply, enforcement measurement) is a separate user-authorized operation |
| Acceptance account | Username/password for the acceptance deployment (private env file, never committed) |

Configuration checks may verify only that the necessary fields are non-empty;
they must never print secrets.

## 2. Images to build and publish (digests recorded at release time)

Build from the checkout that carries the accepted stage-one code
(`codex/ai-integration`); record every `...@sha256:<64 hex>` digest in the
private env file and in the acceptance record. Local test tags are not release
references — never deploy a floating tag.

```bash
# 2.1 Backend (contains the V11 Flyway migration; applied at startup, section 3)
mvn -q -f poc4/backend/pom.xml -DskipTests package
docker build -t chocologic/manao_images_repository:ai-stage1-backend-<yyyymmdd> poc4/backend
docker push chocologic/manao_images_repository:ai-stage1-backend-<yyyymmdd>
docker inspect --format '{{index .RepoDigests 0}}' chocologic/manao_images_repository:ai-stage1-backend-<yyyymmdd>

# 2.2 Frontend — MUST be built with the AI panel switch on (build-arg added in
#     poc4/frontend/Dockerfile; the accepted default stays false for other rounds)
docker build --build-arg VITE_ENABLE_AI=true \
  -t chocologic/manao_images_repository:ai-stage1-frontend-<yyyymmdd> poc4/frontend
docker push chocologic/manao_images_repository:ai-stage1-frontend-<yyyymmdd>
docker inspect --format '{{index .RepoDigests 0}}' chocologic/manao_images_repository:ai-stage1-frontend-<yyyymmdd>

# 2.3 Pi worker (model key arrives only through the runtime environment, never the image)
docker build -t chocologic/manao_images_repository:ai-stage1-pi-worker-<yyyymmdd> poc4/pi-worker
docker push chocologic/manao_images_repository:ai-stage1-pi-worker-<yyyymmdd>
docker inspect --format '{{index .RepoDigests 0}}' chocologic/manao_images_repository:ai-stage1-pi-worker-<yyyymmdd>

# 2.4 Maven runner (adds the root-owned manao-dev-build launcher; unchanged since Task 3)
mvn -q -f poc4/backend/pom.xml -DskipTests test-compile \
  org.codehaus.mojo:exec-maven-plugin:3.5.0:java \
  -Dexec.mainClass=com.manao.poc4.workspace.MavenSeedTemplateExporter -Dexec.classpathScope=test \
  "-Dmanao.seed.output=<abs path>/maven-seed-templates"
docker build --build-context "seed-templates=<abs path>/maven-seed-templates" \
  -t chocologic/manao_images_repository:ai-stage1-runner-<yyyymmdd> poc4/maven-runner
docker push chocologic/manao_images_repository:ai-stage1-runner-<yyyymmdd>
docker inspect --format '{{index .RepoDigests 0}}' chocologic/manao_images_repository:ai-stage1-runner-<yyyymmdd>
```

No rebuild is needed for the initializer and workspace-agent images (Task 6
constraint: "初始化cache和workspace-agent镜像不需重构").

## 3. V11 migration (`V11__agent_tasks.sql`, ships inside the backend image)

Additive only: two new tables (`agent_task`, `agent_tool_call`), the project
foreign keys, and the generated `active_project` unique index that limits one
occupying task per project. No existing table, row or column is changed. Flyway
applies V11 automatically when the new backend starts against `manao_poc4_6b`.

- Applying it touches the runtime schema — that is exactly why the rollout needs
  the user's explicit authorization.
- Rollback (only with no in-flight tasks, and only with authorization):
  `DROP TABLE agent_tool_call; DROP TABLE agent_task;` — the tables are pure
  additions; dropping them cannot affect project/run/workspace data.

## 4. Worker configuration contract (the model key lives only here)

| Variable | Meaning |
| --- | --- |
| `MANAO_AI_WORKER_PORT` | HTTP surface (default 18090) |
| `MANAO_AI_WORKER_TOKEN` | Shared secret the backend presents on `/tasks/*`; empty disables every route |
| `MANAO_AI_INSTANCE_ID` | Stable instance identity (optional) |
| `MANAO_AI_BACKEND_BASE_URL` / `MANAO_AI_BACKEND_TOKEN` | Backend internal routes + internal token |
| `MANAO_AI_SCRATCH_DIR` / `MANAO_AI_AGENT_DIR` / `MANAO_AI_SESSION_DIR` | Worker-private paths; never a user project, never a shared volume |
| `MANAO_AI_PROVIDER` / `MANAO_AI_API_TYPE` / `MANAO_AI_BASE_URL` / `MANAO_AI_MODEL` / `MANAO_AI_API_KEY` | Real cloud model configuration; no real value exists as of this round |

Verified worker behavior (component drill, acceptance record section 4): while
any model field is missing, the worker still boots for health but **refuses every
task start with a fixed 503 `AI_WORKER_NOT_CONFIGURED`**, which the backend turns
into an explicit pre-start task failure. Starts are never silently mocked.

Backend side (`manao.poc4.ai.*` / env): `MANAO_AI_ENABLED=true`,
`MANAO_AI_PROJECT_ID=<bootstrap id>`, `MANAO_AI_WORKER_BASE_URL`,
`MANAO_AI_WORKER_TOKEN`, `MANAO_AI_INTERNAL_TOKEN` (the last two are secrets).
The backend never receives the model key.

## 5. Rollout order (single worker, single backend — no overlapping updates)

Execute only with authorization; every Deployment involved uses `Recreate`
(replicas 1) so old and new never overlap:

1. Apply `development-network-policy.yaml` to the acceptance namespace, then
   complete the operator duties in its header (public management-plane excludes)
   and plan the CNI enforcement measurement — the policy resource alone is not
   evidence.
2. Publish the new runner digest into the images Secret
   (`manao-backend-images`) so the next development build uses `manao-dev-build`.
3. Create the worker Deployment + Service from the section 4 contract
   (Deployment manifest is authored at deploy time; model fields come from a
   Secret). Verify exactly one worker pod.
4. Update the backend Deployment (new image; env additions per section 4).
   Startup runs Flyway V11 (section 3). Verify exactly one backend pod.
5. Update the frontend Deployment with the `VITE_ENABLE_AI=true` image. Verify
   the AI tab exists in the workbench.

## 6. Rollback

| Step | Action |
| --- | --- |
| Fastest behavior rollback | `MANAO_AI_ENABLED=false` on the backend (AI beans, browser routes and internal routes simply cease to exist); scale the worker to 0 |
| Backend image | Redeploy the previous recorded digest; the frontend keeps working — the AI tab disappears with the old panel only if the frontend is also rolled back |
| Frontend image | Redeploy the previous recorded digest (panel gone; project data untouched) |
| Worker | Delete the worker Deployment/Service (no other component depends on it) |
| V11 tables | Section 3 rollback, only with no in-flight tasks and only with authorization |
| Runner digest | Restore the previous `manao-backend-images` runner value; `manao-dev-build` disappears from new build pods |

No rollback step deletes project data; tasks and tool rows are additive.

## 7. Acceptance runbook (after authorization)

```bash
# 1. Bootstrap the dedicated project against the running acceptance backend
node poc4/frontend/scripts/ai-stage1-bootstrap.mjs
#    (records projectId + initial revision + fixture sha256 in its JSON summary)

# 2. (Re)start the acceptance backend with MANAO_AI_ENABLED=true and
#    MANAO_AI_PROJECT_ID=<recorded id>; start the worker with REAL provider values.

# 3. Run the browser acceptance
cd poc4/frontend
MANAO_AI_ACCEPTANCE_BASE_URL=<entry url> \
MANAO_AI_ACCEPTANCE_USERNAME=<acc user> \
MANAO_AI_ACCEPTANCE_PASSWORD=<acc password> \
MANAO_AI_ACCEPTANCE_PROJECT_ID=<recorded id> \
pnpm test:e2e:ai-stage1

# 4. Delete the round's dedicated project (UI/API) and verify leftovers
#    independently (resources, rows); record everything in the acceptance record.
```

The independent acceptance-build re-verification (fixture + `acceptance-pom.xml`
through the read-only-copy executor, Surefire XML with tests>=1 and
failures/errors/skipped=0) is part of the round's evidence; the fixture and pom
were already exercised for real in the isolated local drill (acceptance record
section 3).
