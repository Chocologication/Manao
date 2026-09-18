> **历史来源 / 2026-09-17 已被现行记录取代：** 当前 6A 范围、验收决定和证据以[唯一现行事实现状](../../../../../docs/Stage6A-Current-Facts.md)为准。下文保留原时点的设计、计划和结果；其中“当前”、待实施、FAILED/不允许 6B 等只描述旧时点，不覆盖本次用户验收决定，也不自动授权重新执行。原始结果不改写。此链接指向主检出的单份文档，不复制第二份现状。

# POC4 MVP Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Make the real POC4 browser loop reliable: login, create, edit, save, run a saved revision, view logs/result, edit again, and run again.

**Architecture:** Reuse the existing modular Spring Boot backend, MySQL stores, workspace agent/PVC, Kubernetes Job coordinator, and React workbench. Change only contracts and composition that directly affect the loop; keep Terminal, audit, cleanup, and fault tooling out of the default product path without deleting their implementations.

**Tech Stack:** Java 17, Spring Boot 3.5, JDBC/Flyway, Fabric8 Kubernetes client, React 19, TypeScript, TanStack Query, Monaco, Vitest, Playwright, Maven, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-15-poc4-mvp-loop-design.md`

## Global Constraints

- Use the existing isolated worktree `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes`.
- Use `pnpm`; never use npm.
- Before editing an existing file, reread its current contents and preserve the repository line-ending policy.
- Write UTF-8 without BOM for generated text files.
- Use TDD for behavior changes: write one failing test, observe the expected failure, then implement the smallest fix.
- Do not add Redis, MongoDB, RabbitMQ, OSS, Git, AI, multi-language support, or 6B deployment work.
- Do not call mock/unit evidence full Stage 6A acceptance.
- Do not modify or delete the existing unrelated cleanup-test changes in the worktree.

---

### Task 1: Make Run history pagination real

**Files:**
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/JdbcRunStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunController.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/run/RunControllerTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/run/JdbcRunStoreTest.java`

**Interfaces:**
- `RunStore.listForOwner(String ownerId, String projectId, RunCursor cursor, int limit)` returns a `RunPage` containing at most `limit` records and `hasMore`.
- `RunStore.RunCursor` contains the exclusive boundary `Instant createdAt` and `String id`.
- `RunService.list(String ownerId, String projectId, String encodedCursor, int limit)` decodes and validates the opaque cursor, delegates it to the store, and emits the next cursor only when `hasMore` is true.

- [ ] **Step 1: Add a failing controller/service test**

Create a test with enough terminal fake runs to require two pages. Call `controller.list(..., null, 2)`, then call the second page with the returned cursor. Assert that the second page contains no ID from the first page and that an invalid cursor raises `VALIDATION_ERROR`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run from `poc4/backend`:

```powershell
& 'D:\DeepLearning\Java\IntelliJ IDEA 2025.2.3\plugins\maven\lib\maven3\bin\mvn.cmd' -q -Dtest=RunControllerTest test
```

Expected: compilation failure because the current store/service contract ignores the controller cursor.

- [ ] **Step 3: Implement the minimal cursor contract**

Use the existing descending `(created_at, id)` order. Decode Base64 UTF-8 text in the form `<Instant>|<runId>`; reject missing separators, invalid timestamps, empty IDs, and malformed Base64 with `ApiException("VALIDATION_ERROR", 422, ...)`. Query one extra row and use that row only to set `hasMore`; apply the exclusive SQL boundary:

```sql
AND (created_at < ? OR (created_at = ? AND id < ?))
ORDER BY created_at DESC, id DESC
LIMIT ?
```

Do not expose database or Kubernetes identifiers in the HTTP response.

- [ ] **Step 4: Run focused backend tests**

```powershell
& 'D:\DeepLearning\Java\IntelliJ IDEA 2025.2.3\plugins\maven\lib\maven3\bin\mvn.cmd' -q -Dtest=RunControllerTest,JdbcRunStoreTest test
```

Expected: PASS.

- [ ] **Step 5: Run `git diff --check` and inspect the changed files**

Confirm no whitespace errors and that only pagination behavior changed in this task.

---

### Task 2: Make terminal Run settlement unlock the editor reliably

**Files:**
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunObservationService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunStore.java` only if required by the test contract
- Test: `poc4/backend/src/test/java/com/manao/poc4/run/RunObservationServiceTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/run/RunControllerTest.java`

**Interfaces:**
- A Job with `succeeded=true` settles exactly once as `SUCCEEDED` and completes log ingestion.
- A Job with `failed=true` settles exactly once as `FAILED` and completes log ingestion.
- A terminal Run is no longer returned by `findActiveRun`, so the workspace write path accepts the next save.
- Transport uncertainty is not treated as a successful Run; if the Job cannot be proven absent, the Run stays observable until a later observation can settle it.

- [ ] **Step 1: Add failing observation tests for strict success/failure mapping and completion**

Cover success with an observed exit code of `0`, failure with a non-zero exit code, and a second observation after settlement. Assert the persisted state/reason and that `finish`/completion are called once.

- [ ] **Step 2: Run the focused tests and verify the regression behavior**

```powershell
& 'D:\DeepLearning\Java\IntelliJ IDEA 2025.2.3\plugins\maven\lib\maven3\bin\mvn.cmd' -q -Dtest=RunObservationServiceTest,RunControllerTest test
```

Expected: the new strict assertions fail if the current fake store or observation path leaves an active marker/does not complete the run.

- [ ] **Step 3: Implement only the settlement/unlock correction**

Keep the existing fixed `mvn clean test` policy and existing resource identity verification. Ensure settlement writes the terminal state before invoking the log completion listener, and make the observation path refetch the current Run after any `STARTING -> RUNNING` transition. Do not add a new recovery subsystem or make `RECOVERING` a public success state.

- [ ] **Step 4: Run focused and full backend tests**

```powershell
& 'D:\DeepLearning\Java\IntelliJ IDEA 2025.2.3\plugins\maven\lib\maven3\bin\mvn.cmd' -q -Dtest=RunObservationServiceTest,RunControllerTest,JdbcRunStoreTest test
```

Expected: PASS.

---

### Task 3: Keep the default workbench focused on editor, Run, and logs

**Files:**
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.tsx`
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.test.tsx`
- Modify: `poc4/frontend/src/components/runs/RunPanel.tsx` only if needed to make terminal state irrelevant to editor locking
- Test: `poc4/frontend/src/components/shell/WorkbenchShell.test.tsx`
- Test: `poc4/frontend/src/components/runs/RunPanel.test.tsx`

**Interfaces:**
- The default workbench presents File and Run surfaces; Terminal is not part of the core workflow.
- `writesLocked` is derived only from the Run authority state.
- A terminal Run causes the editor and Save action to become available after workspace reload succeeds; Terminal loading/opening cannot keep the editor locked.

- [ ] **Step 1: Add a failing UI test for the default surface**

Render the workbench with the normal runtime and assert that File and Run are available, the default view does not expose Terminal as a core action, and a terminal Run does not make the Save action depend on Terminal authority.

- [ ] **Step 2: Run the focused Vitest test and verify it fails**

Use the already-installed local Vitest binary so pnpm does not recreate dependencies:

```powershell
& 'C:\Users\shili\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'node_modules/vitest/vitest.mjs' run src/components/shell/WorkbenchShell.test.tsx
```

Expected: failure against the current default Terminal tab/authority behavior.

- [ ] **Step 3: Implement the smallest composition change**

Remove Terminal from the default tab list and default render path, or gate it behind an explicit `VITE_ENABLE_EXPERIMENTAL_TERMINAL=true` flag whose default is false. Keep the Terminal source files intact. Do not change the Run API or workspace revision contract in this task.

- [ ] **Step 4: Run focused UI tests and typecheck**

```powershell
& 'C:\Users\shili\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'node_modules/vitest/vitest.mjs' run src/components/shell/WorkbenchShell.test.tsx src/components/runs/RunPanel.test.tsx
& 'C:\Users\shili\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'node_modules/typescript/bin/tsc' -b --pretty false
```

Expected: PASS.

---

### Task 4: Add one real MVP browser scenario and verify the repository

**Files:**
- Modify: `poc4/frontend/tests/e2e/stage6-real-backend.spec.ts`
- Modify: `poc4/frontend/tests/e2e/stage6-operator.ts` only if the existing disposable-resource helper cannot express the scenario
- Test: the new Playwright test in `stage6-real-backend.spec.ts`
- Documentation: `poc4/docs/2026-09-15-poc4-mvp-loop-evidence.md`

**Interfaces:**
- The scenario uses the existing real-backend `stage6` Playwright project and disposable resource cleanup.
- It must assert exact `FAILED` then exact `SUCCEEDED`, not any terminal state.

- [ ] **Step 1: Add the failing real-loop scenario**

Create one test that logs in, provisions a disposable project, saves a compile-breaking `App.java`, runs and asserts `FAILED` with a Maven error marker, fixes and saves the file, runs again, asserts `SUCCEEDED` with exit code `0`, reloads, and verifies corrected content plus history.

- [ ] **Step 2: Run the test before implementation completion**

```powershell
& 'C:\Users\shili\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'node_modules/@playwright/test/cli.js' test tests/e2e/stage6-real-backend.spec.ts --project=stage6 --grep "MVP core loop"
```

Expected: failure identifies the first real blocker, with no claim of acceptance.

- [ ] **Step 3: Fix only the blocker demonstrated by the real test**

Correlate the API Run state, Job/Pod facts, log output, workspace revision, and editor lock before changing code. Preserve any failed disposable diagnostic resource required to explain a transport or cleanup problem; do not delete unrelated cluster resources.

- [ ] **Step 4: Rerun the exact scenario and capture evidence**

Save sanitized evidence with date, Git SHA, test name, exact Run states, revision values, log markers, and browser result. Do not include passwords, tokens, kubeconfigs, or raw traces.

- [ ] **Step 5: Run repository verification**

```powershell
& 'C:\Users\shili\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'node_modules/vitest/vitest.mjs' run
& 'C:\Users\shili\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'node_modules/typescript/bin/tsc' -b --pretty false
& 'D:\DeepLearning\Java\IntelliJ IDEA 2025.2.3\plugins\maven\lib\maven3\bin\mvn.cmd' -q test
& 'C:\Program Files\Git\bin\git.exe' diff --check
```

Report separately: automated evidence, real-loop evidence, and skipped full Stage 6A/6B engineering evidence.