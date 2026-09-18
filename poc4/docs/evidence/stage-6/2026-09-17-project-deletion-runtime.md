> **历史来源 / 2026-09-17 已被现行记录取代：** 当前 6A 范围、验收决定和证据以[唯一现行事实现状](../../../../docs/Stage6A-Current-Facts.md)为准。下文保留原时点的设计、计划和结果；其中“当前”、待实施、FAILED/不允许 6B 等只描述旧时点，不覆盖本次用户验收决定，也不自动授权重新执行。原始结果不改写。此链接指向主检出的单份文档，不复制第二份现状。

# POC4 project deletion: real runtime verification

Date: 2026-09-17 (Asia/Shanghai)
Code base: c6ece43 plus the existing uncommitted MVP deletion changes and the test-only adjustments described below.

## Conclusion

- Frontend and backend are running with MSW disabled: 127.0.0.1:4173 -> 127.0.0.1:18080 -> the real Kubernetes cluster.
- New-project deletion using the dedicated deleting StorageClass passed the real lifecycle and independent resource/database/storage reconciliation.
- Real incomplete deletion, reload, and explicit continuation passed. A storage resource deliberately kept present was never reported as successfully deleted.
- This is a focused MVP deletion result, NOT full Stage 6A acceptance. No Stage 6B application resources were introduced.
- Existing projects on the shared archival StorageClass were not migrated or deleted; their permanent storage deletion remains outside this verified path.

## Runtime preparation

The original private environment was located outside the repository at:

~~~text
D:\DeepLearning\MyProjects\Project_Manao_kubeconfig\stage6-6a-local-cluster.env
~~~

A private copy was created at the same directory as stage6-6a-project-deletion.env, changing only MANAO_WORKSPACE_STORAGE_CLASS to manao-poc4-delete. Existing credentials and restricted kubeconfig were reused, not copied into tracked files.

Live checks confirmed:

- API tunnel at 127.0.0.1:6443 works; all three nodes are Ready.
- Backend Kubernetes identity: system:serviceaccount:manao-stage6-test:manao-6a-local.
- Existing shared nfs-storage has archiveOnDelete=true despite reclaimPolicy=Delete. It was left unchanged.
- Added dedicated StorageClass manao-poc4-delete, using the existing NFS provisioner with onDelete=delete, archiveOnDelete=false, reclaimPolicy=Delete.
- Added ClusterRole and ClusterRoleBinding manao-poc4-storage-observer: only list persistentvolumes and get storageclasses, bound to the existing backend service account.
- Restricted checks: the two required reads return yes; delete persistentvolumes and get secrets return no. The backend still runs with its restricted identity, not administrator credentials.
- Backend startup validated Flyway v8 without a migration or runtime table reset, then passed preflight.

The three supporting resources are intentionally retained for new-project deletion. They are not disposable test residue. Their exact manifest is in [6a-deletion-runtime-prerequisites.json](2026-09-17-project-deletion/6a-deletion-runtime-prerequisites.json).

## First focused real test: results and corrective test changes

Only the existing MVP core-loop scenario was selected, not the entire Stage 6 suite.

1. Attempt 1 reached a real failed compilation but the old test expected BUILD FAILURE. The current runner is mvn -q -DskipTests compile exec:java, so the quieted Maven banner is not an appropriate assertion. The actual compiler diagnostic was cannot find symbol / missingSymbol. Cleanup was independently reconciled for this attempt.
2. Attempt 2 exposed an existing test helper issue: it read an error body as a ProjectSummary and returned undefined. Opening/reading a READY project can overlap the lifecycle lease. The helper now accepts only HTTP 200 project states, boundedly retries read-only PROJECT_BUSY (409) / dependency-unavailable (503), and fails explicitly on other statuses. No POST or DELETE is automatically replayed.
3. Attempt 3 passed every scenario assertion: real failed Run, corrected successful Run (exit code 0), real persisted logs and history, user-clicked Delete, API 404, browser absence, no Job/Pod/Service/PVC/PV. Quiet-mode log assertions now require the actual compiler diagnostic and the application output Hello from Manao; strict FAILED/SUCCEEDED/exit-code assertions were preserved.

Attempt 3 identifiers:

~~~text
project: 7a5f80e6-7e5f-4f57-93e9-f321cb0d39fd
failed run: e1a9ceef-88d3-401b-be04-15a59a664b60
successful run: 07d575a3-41da-4e99-a67f-1efa700b575c
~~~

The Playwright JSON reports expected=1, unexpected=0, skipped=0 in 122.5 seconds. However Node v24.12.0 hit UV_HANDLE_CLOSING after writing its completed report and exited -1073740791. Therefore test assertions PASS and process exit FAILED are deliberately separate; this invocation is not called a clean runner success.

The initial failed browser trace, which could include authentication payloads, was removed. Sanitized failure text, exact cleanup receipts and JSON results were retained.

## Browser lifecycle plus real failure/continuation

A separate direct Playwright browser check (without the test CLI runner) used one new project and exited normally with code 0. It used the actual frontend and backend, no API interception. Source text was inserted into the loaded Monaco model; saving, running, deleting and continuing deletion were actual UI button actions.

~~~text
project name: deletion-live-ui-20260917
project: 2f4b29a5-5170-41f4-9ea4-75bc6aa51516
failed run: c2182fff-4576-4b21-adb8-380984469ea6
successful run: db44b6cb-f14d-4e68-a06c-3ba90ca10048
~~~

Observed sequence:

1. Login and create through the browser. Record the resulting project ID before further work.
2. Open App.java, change it to reference missingSymbol, Save -> revision 22, Start run -> FAILED; compiler feedback is visible.
3. Correct the source to print Deletion lifecycle verified, Save -> revision 23, Start run -> SUCCEEDED; that exact output is visible.
4. Return to the project list. Add only the session-owned finalizer manao.poc4/deletion-verification-hold to this exact test PVC, protected by UID and resourceVersion checks.
5. Click Delete project and confirm. After bounded cleanup, DELETE returns 503 / PROJECT_CLEANUP_INCOMPLETE. Jobs, Pods and Services are absent, but the held PVC, PV and real NFS directory remain. The authenticated project state is DELETING; the card and Continue deletion remain. Project deleted is not shown.
6. Reload/re-login. The same DELETING card and Continue deletion remain, without automatic DELETE replay.
7. Remove only the session-added finalizer, preserving any other finalizers. Click Continue deletion. DELETE returns 204 and the card disappears. Re-login confirms absence; an existing other project remains visible.
8. Independently verify zero dependent database rows, no test resources/PV, and no original or archived NFS project directory.

This browser check initially encountered a recoverable existing file-tree PROJECT_BUSY 409 on opening the workspace; using the existing Retry action recovered. Test-driver input handling was corrected without creating replacement projects or blindly replaying mutations. The same recorded project was resumed throughout. These preliminary failures are retained in the receipt and are not represented as an uninterrupted first-attempt pass.

Evidence:

- [Lifecycle receipt](2026-09-17-project-deletion/live-ui-receipt.json)
- [Successful driver output](2026-09-17-project-deletion/live-ui-resume4-run.log)
- [Incomplete state proof](2026-09-17-project-deletion/live-ui-incomplete-proof.json)
- [Storage before deletion](2026-09-17-project-deletion/live-ui-storage-before.json)
- [Failed Run screenshot](2026-09-17-project-deletion/live-ui-failed.png)
- [Successful Run screenshot](2026-09-17-project-deletion/live-ui-succeeded.png)
- [Incomplete deletion after reload](2026-09-17-project-deletion/live-ui-incomplete-after-reload.png)
- [Deletion confirmed in frontend](2026-09-17-project-deletion/live-ui-deleted.png)

## Independent reconciliation and cleanup

All four disposable projects created in this session were reconciled, including failed attempts:

~~~text
0613bf08-c6e0-4f41-9b0f-2e1131abcd82
55b62271-dbca-465b-9d09-94b1f1790c21
7a5f80e6-7e5f-4f57-93e9-f321cb0d39fd
2f4b29a5-5170-41f4-9ea4-75bc6aa51516
~~~

- Namespace inventory: no associated Job, Pod, Service or PVC.
- Cluster storage inventory: no PV bound to any of their exact claim names.
- Database: zero project, run, workspace_operation, log_ticket, terminal_session and terminal_audit rows for these projects, and zero run_log_chunk rows for all five recorded Run IDs. See [database-after.tsv](2026-09-17-project-deletion/database-after.tsv).
- Physical NFS: both original and archived project paths absent. A narrowly scoped temporary probe mounted the existing NFS root read-only; no filesystem deletion was performed by the probe. See [final storage check](2026-09-17-project-deletion/all-test-projects-final-storage.json).
- The read-only probe Pod was deleted and absence checked after verification. The session-added PVC finalizer was removed before continuation; it does not remain on any test object.
- All 71 original cluster object UIDs remain; all seven original database projects remain READY. No old diagnostic resource was cleaned. See [baseline comparison](2026-09-17-project-deletion/existing-resources-after.json).
- Temporary UI-driver scripts and signal files were removed after use. Useful screenshots, sanitized logs and receipts remain.

## Remaining boundaries

1. Existing shared nfs-storage projects use archiveOnDelete=true. The cleaner intentionally leaves them DELETING rather than claim permanent deletion if that policy prevents actual reclamation. This session did not change the shared class or migrate existing PVCs. The measured successful lifecycle applies to projects created with manao-poc4-delete.
2. Opening a workspace can produce a transient file-tree PROJECT_BUSY response; Retry restores access. This unrelated existing behavior was observed, not fixed here.
3. The test CLI has a Windows Node teardown assertion after reporting success. The independent browser lifecycle/continuation process exited 0, but the CLI issue remains recorded.
4. Backend restart continuation was not re-injected in this runtime session; the real fault check covered storage deletion failure and browser reload/explicit continuation.
5. Full Stage 6A and Stage 6B status is unchanged.

## Current services

At verification closeout, backend health and readiness are UP. The frontend and backend are intentionally left running for the user. Launcher logs remain under poc4/backend/target and poc4/frontend (ignored by Git). No credentials are stored in this evidence directory, and no changes were committed or merged.
