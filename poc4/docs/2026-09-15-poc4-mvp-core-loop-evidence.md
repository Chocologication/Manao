> **历史来源 / 2026-09-17 已被现行记录取代：** 当前 6A 范围、验收决定和证据以[唯一现行事实现状](../../docs/Stage6A-Current-Facts.md)为准。下文保留原时点的设计、计划和结果；其中“当前”、待实施、FAILED/不允许 6B 等只描述旧时点，不覆盖本次用户验收决定，也不自动授权重新执行。原始结果不改写。此链接指向主检出的单份文档，不复制第二份现状。

# POC4 MVP Core Loop Evidence

**Date:** 2026-09-15
**Scope:** MVP product loop only; this is not a full Stage 6A or Stage 6B acceptance report.

## Result

The approved real-browser MVP scenario passed on the local-cluster profile:

```text
login -> create project -> wait for READY -> save broken Java revision
      -> run -> FAILED with Maven failure output
      -> re-login -> reopen project -> edit/save corrected revision
      -> run -> SUCCEEDED with exit code 0 and Maven success output
      -> re-login -> reopen project -> verify history and corrected file
```

## Real execution evidence

- Playwright test: `MVP core loop: failed revision, corrected revision, and persistent history`
- Invocation: `mvp-loop-20260915-r6`
- Base Git commit before working-tree changes: `1208b5f2f9443a271ba92913c50977f3ec43be38`
- Disposable project: `a8eebcbb-8490-4de7-b7f1-aa87dcb4721d`
- First Run: `69d2546c-6ae9-444f-89f6-f521774874b3`
  - final state: `FAILED`
  - termination reason: `BUILD_FAILED`
  - non-zero exit code observed
  - Maven failure output visible in the log panel
- Second Run: `8af4ad9e-13b9-4579-83f6-8183ea7724a9`
  - final state: `SUCCEEDED`
  - exit code: `0`
  - Maven success output visible in the log panel
- Browser verification after re-login:
  - terminal Run result visible;
  - log panel replayed persisted output;
  - corrected source remained available;
  - Run history contained the exact `SUCCEEDED` then `FAILED` sequence.
- Cleanup: both Run IDs and the disposable project reached `API_CLEANED`; cleanup report contained no issues.

## Automated verification

- Frontend Vitest: `65` test files, `1161` tests passed.
- Frontend TypeScript build check: passed.
- Frontend production build: passed.
- Affected backend tests after a clean compile: `36` tests passed in:
  - `RunControllerTest`;
  - `JdbcRunStoreTest`;
  - `RunObservationServiceTest`;
  - `RunLogWebSocketTest`;
  - `SecurityConfigTest`.
- Backend clean compile: passed.
- `git diff --check`: passed.

## Changes included in this MVP slice

1. Run history cursor is now exclusive and real; the JDBC query uses the supplied cursor and returns `nextCursor` only when another page exists.
2. Run observation regression coverage verifies strict success/failure settlement and that terminal Runs no longer remain active.
3. Terminal is hidden from the default workbench and can be enabled only with `VITE_ENABLE_EXPERIMENTAL_TERMINAL=true`; its source remains available for later work.
4. WebSocket registration is enabled with `@EnableWebSocket`, and the log/terminal handshake paths are permitted through Spring Security so ticket validation remains the channel boundary.
5. The real MVP Playwright scenario asserts exact `FAILED` followed by exact `SUCCEEDED`, rather than accepting any terminal state.

## Known non-MVP status

The full backend test suite was run after the MVP changes and is not green in the current worktree. The observed result was six failures and one error, all in the existing project-cleanup contract tests:

- `ProjectDeleteHttpContractTest.activeRunIsConflictNotNotFound`;
- `ProjectDeleteHttpContractTest.creatingIsConflictWithoutSideEffects`;
- `ProjectDeleteHttpContractTest.missingOwnerIsNotFoundWithNoSideEffects`;
- `ProjectDeleteHttpContractTest.pendingReadyIsBusyWithoutSideEffects`;
- `ProjectDeleteHttpContractTest.successfulDeleteReturnsNoContent`;
- `ProjectProvisioningServiceTest.deletingProjectWithActiveRunDoesNotTouchResourcesOrDatabase`;
- error: `ProjectProvisioningServiceTest.deletingProjectReleasesKubernetesResourcesAndRemovesProject`.

These failures are outside the approved MVP core-loop change and were not modified. The affected MVP backend tests listed above passed independently. Therefore:

```text
POC4 MVP core loop: PASS
Full backend suite: FAILED (unrelated existing cleanup/transport tests)
Stage 6A: not claimed
Stage 6B: not started
```

## Environment notes

- Real backend: Spring Boot on `127.0.0.1:18080`.
- Frontend: Vite dev server on `127.0.0.1:4173` using the local-cluster environment.
- Kubernetes access used the external restricted kubeconfig; credentials and private configuration were not copied into the repository or this evidence file.
- The Windows Node process emitted a `UV_HANDLE_CLOSING` assertion while Playwright exited after a passing test. The test result itself was `1 passed`; this process-exit issue is recorded separately and is not treated as product-loop evidence.