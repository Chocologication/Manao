> **历史来源 / 2026-09-17 已被现行记录取代：** 当前 6A 范围、验收决定和证据以[唯一现行事实现状](../../../../../../docs/Stage6A-Current-Facts.md)为准。下文保留原时点的设计、计划和结果；其中“当前”、待实施、FAILED/不允许 6B 等只描述旧时点，不覆盖本次用户验收决定，也不自动授权重新执行。原始结果不改写。此链接指向主检出的单份文档，不复制第二份现状。

# Workspace reload / Retry fix — 2026-09-16

## Scope

Restore the existing loop: terminal Run -> workspace reload -> editable files. If a read fails, Retry must reload successfully once the read service is available. No backend, database schema, Run state machine, or automatic retry mechanism was changed.

## Root causes and correction

1. Reload checked expanded/selected directories through the file metadata parser. Real directory metadata has null size/encoding; the parser rejects it as `Invalid file response`. Check directory listings first, falling back to file metadata only for a missing/non-directory path.
2. Removing file queries while their UI subscribers remained active started background reads alongside the explicit reload. The real backend's per-project gate rejected competing reads with `409 PROJECT_BUSY`. Pause automatic file queries during `RELOADING_WORKSPACE` and `RELOAD_FAILED`; unmount the editor while its models are disposed. Cache the reloaded directory listings before resuming the UI, then use the existing `completeReload()` to unlock. Tabs and expanded paths remain in workspace session state.

A read failure still does not unlock the editor. Retry repeats the reads; it does not start another Run or replay a write.

## Verification

- Regression tests first reproduced the directory parsing failure and competing reads.
- 90 tests passed across `workspaceReload`, `WorkbenchShell`, `RunAuthorityCoordinator`, and `fileQueries`.
- TypeScript build/typecheck and scoped `git diff --check` passed.
- Real browser used the running frontend on 4173 and backend on 18080, with actual workspace files and Kubernetes Runs. Source directories remained expanded and `App.java` was open.
- For each final check, the browser deliberately aborted the root-directory GET after starting the Run. After `RELOAD_FAILED`, the interception was removed and Retry was clicked once. Subsequent reload requests reached the real backend; no successful responses were mocked.

| Run | Actual terminal state | Retry result |
| --- | --- | --- |
| `ce0c750d-2a1b-4370-af99-e63264567881` | `SUCCEEDED` | Error cleared; editor accepted text; Save returned HTTP 200; `src` stayed expanded. |
| `ecacebec-e7ad-4ead-aeaa-be41efa3ebf7` | `FAILED` after removing a Java semicolon | Error cleared; editor accepted corrected source; Save returned HTTP 200; `src` stayed expanded. |

This verifies the requested Retry/edit/save behavior, not full POC4 or Stage 6A acceptance. Initial project navigation also encountered `PROJECT_BUSY`; retrying that tree read succeeded. General concurrent-read handling outside the reload flow was not changed.

## Cleanup

Only the disposable project `reload-retry-check-20260916` (`97a6e6c1-e40c-4e02-a878-f49de4cd8b36`) was deleted through the project API after confirming no active Run. Follow-up GET returned 404. Project-labelled Pods, Services, Jobs and PVCs were absent; project, workspace_operation, run, log_ticket, terminal_session, terminal_audit and the four test Runs' run_log_chunk rows all counted zero. Existing user projects were not edited or deleted.