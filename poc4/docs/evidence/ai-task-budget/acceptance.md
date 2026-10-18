# AI task budget increase — 2026-10-18

The user explicitly requested 180 tool calls, 20 builds, a rebuilt worker image and cluster publication. Work starts from `2632f7e` on `codex/ai-integration` in `.worktree/ai-integration`. Prior uncommitted Stage 2 harness/documents are preserved separately; Stage 2 acceptance remains paused and NOT_GRANTED.

## Change and validation

Both production `loadWorkerConfig` and the optional session fallback now allow 180 SDK tool attempts, including at most 20 build attempts. Tool 181 and build 21 abort before backend invocation. The 1800-second task limit, existing application/start limit of four, per-build/cleanup deadlines, SDK 1.2.0 and lockfile are unchanged. No new configuration surface, dependency, database field or module was added.

TDD RED: `pnpm exec vitest run test/pi-session.test.ts -t 'raised budget'` ran six target tests against the old code; all six failed for the intended limits (60 instead of 180, 8 instead of 20, or premature FAILED). Ten unrelated tests were deselected by the test filter.

GREEN: `pnpm test` passed 72/72 tests in three files. Six new tests use the real Pi SDK loop and scripted local model/backend boundaries, with both production configuration and the omitted-budget fallback: exactly 180 tools including 20 builds can complete; tool 181 is refused after exactly 180 backend invocations; build 21 is refused after exactly 20. These are local behavioral tests, not cloud-model or project-application acceptance. `pnpm build` passed. Existing test stderr for an intentionally thrown runner error is expected test evidence.

## Review and release

Independent specification/code review: Approved, no blocking or important findings. Source commit, pushed image digest, rollout/Pod identity and runtime budget inspection: pending.

Preflight: `kubernetes-admin@learn`, namespace `manao-stage6b`; all three nodes Ready; worker Deployment has one replica and Recreate strategy. No QUEUED/RUNNING/NEEDS_ATTENTION AgentTask existed at the initial read. Previous worker digest (rollback reference): `sha256:242369ef1c159e1f4e4a7bfd8f10eab0b878f6ce977571208bfde72dec651c50`.

Only the worker image is in this release. Existing failed tasks are not resumed automatically, and no new model task is submitted. Git push/merge, runtime-schema reset and project/resource deletion are outside this task.
