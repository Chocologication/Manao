# AI task budget increase — 2026-10-18

The user explicitly requested 180 tool calls, 20 builds, a rebuilt worker image and cluster publication. Work starts from `2632f7e` on `codex/ai-integration` in `.worktree/ai-integration`. Prior uncommitted Stage 2 harness/documents are preserved separately; Stage 2 acceptance remains paused and NOT_GRANTED.

## Change and validation

Both production `loadWorkerConfig` and the optional session fallback now allow 180 SDK tool attempts, including at most 20 build attempts. Tool 181 and build 21 abort before backend invocation. The 1800-second task limit, existing application/start limit of four, per-build/cleanup deadlines, SDK 1.2.0 and lockfile are unchanged. No new configuration surface, dependency, database field or module was added.

TDD RED: `pnpm exec vitest run test/pi-session.test.ts -t 'raised budget'` ran six target tests against the old code; all six failed for the intended limits (60 instead of 180, 8 instead of 20, or premature FAILED). Ten unrelated tests were deselected by the test filter.

GREEN: `pnpm test` passed 72/72 tests in three files. Six new tests use the real Pi SDK loop and scripted local model/backend boundaries, with both production configuration and the omitted-budget fallback: exactly 180 tools including 20 builds can complete; tool 181 is refused after exactly 180 backend invocations; build 21 is refused after exactly 20. These are local behavioral tests, not cloud-model or project-application acceptance. `pnpm build` passed. Existing test stderr for an intentionally thrown runner error is expected test evidence.

## Review and release

Independent specification/code review: Approved, no blocking or important findings. Source commit: `aa7f2821fd839356929b41bd50203ed205670ec5`.

Preflight: `kubernetes-admin@learn`, namespace `manao-stage6b`; all three nodes Ready; worker Deployment has one replica and Recreate strategy. No QUEUED/RUNNING/NEEDS_ATTENTION AgentTask existed at the initial read. Previous worker digest (rollback reference): `sha256:242369ef1c159e1f4e4a7bfd8f10eab0b878f6ce977571208bfde72dec651c50`.

Only the worker image is in this release. Existing failed tasks are not resumed automatically, and no new model task is submitted. Git push/merge, runtime-schema reset and project/resource deletion are outside this task.

## Published and deployed

Standard worker Dockerfile build succeeded with the existing pnpm frozen lockfile and Pi 1.2.0. Tag `chocologic/manao_images_repository:ai-task-budget-20261018-aa7f282` was pushed successfully; registry digest `sha256:33c98b8a95d818d87f02638b64d0b93f69bc796d83802a233c5f964ca2e79a6b` was used in the Deployment. The upload took several minutes; a read-only manifest lookup made just before upload completion returned not-found, then push completed successfully. No image/content retry or fallback was used.

Immediately before rollout, a fresh read confirmed zero occupying AI tasks. `kubectl set image` changed only `manao-pi-worker` / container `pi-worker`; Recreate rollout completed. Pod `manao-pi-worker-7499578849-6r2db`, UID `4cdc1142-377f-4d5f-a886-d3b033709fe3`, was Running/Ready with zero restarts and matching imageID. No user application Run was started or stopped.

Both a disposable local image inspection and an import of the compiled modules inside the actual new Pod returned `configured={wallClockSeconds:1800,toolCalls:180,builds:20}` and identical session defaults. This inspection did not create a session or call a model. [Sanitized release evidence](release-20261018.json) records the source, immutable image, Pod and runtime values. Previous worker digest above remains the rollback target and restores the old 60/8 limits.

`git diff --check` and UTF-8 without BOM checks passed; worker sources/tests retain LF per `.gitattributes`. This round's redundant GREEN log and transient early manifest-probe log were deleted after verification; the RED failure log plus build/push logs are retained as minimal local diagnostics. The disposable image-inspection container was removed by `docker run --rm`; no temporary build context or cloud project resource was created. Stage 2 acceptance remains paused and NOT_GRANTED.
