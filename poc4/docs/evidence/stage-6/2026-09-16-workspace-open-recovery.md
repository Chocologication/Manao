> **历史来源 / 2026-09-17 已被现行记录取代：** 当前 6A 范围、验收决定和证据以[唯一现行事实现状](../../../../docs/Stage6A-Current-Facts.md)为准。下文保留原时点的设计、计划和结果；其中“当前”、待实施、FAILED/不允许 6B 等只描述旧时点，不覆盖本次用户验收决定，也不自动授权重新执行。原始结果不改写。此链接指向主检出的单份文档，不复制第二份现状。

# Existing workspace recovery on open — 2026-09-16

## Scope and behavior

Only two production files changed: `ProjectController` and `ProjectProvisioningService`. Owner-authorized project detail GET checks existing READY projects. It reuses the project lifecycle gate and idempotent resource creation; there is no new scheduler, state machine, database schema, or frontend API.

- Existing PVC, missing workspace Pod/Service: restore runtime resources using that PVC; wait for readiness and reconnect the local bridge. No initializer, template writes, PVC creation, or cleanup on recovery failure.
- Missing PVC: persist FAILED / WORKSPACE_STORAGE_MISSING and return the fixed public message `Workspace storage is missing. Existing files cannot be accessed.` The existing project UI displays the reason without opening the editor.
- Kubernetes errors or readiness timeout: return retryable HTTP 503; do not label transport uncertainty as lost storage or delete existing resources.
- Healthy workspace: no recreation. Unauthorized and non-READY projects do not enter recovery. Existing non-ready Pods are not deleted/replaced by this patch.
- This is on-demand recovery when opening a project, not continuous synchronization of every card in the project list.

## Verification

- New `ProjectWorkspaceRecoveryTest`: 10 passed. Before implementation, 6 of these failed because opening a project did not inspect/restore resources or report missing storage.
- `ProjectAuthorizationTest`: 2 passed; `Fabric8KubernetesGatewayTest`: 4 passed; `WorkspaceResourceFactoryTest`: 7 passed.
- Existing `ProjectProvisioningServiceTest`: 6 passed, 2 deletion-path cases did not pass (`deletingProjectReleasesKubernetesResourcesAndRemovesProject`, `deletingProjectWithActiveRunDoesNotTouchResourcesOrDatabase`). These call ProjectCleanupService, not the new recovery method. They remain unresolved; this is not a claim of a green full backend suite.
- Existing frontend project page/card tests: 24 passed. No frontend production code changed.
- UTF-8 without BOM and scoped `git diff --check` verified.

### Real project repair

A temporary opt-in harness invoked the changed controller through MockMvc with the real JDBC stores, Fabric8 gateway, resource factory and a separate local bridge. No second Spring application or background maintenance was started. The shared backend was not restarted.

Target: `114514`, project ID `0700496b-7ed7-46a7-b5e4-6186a84bbf1e`. Before: database READY, workspace Pod NotFound, original PVC Bound, no active Run. After:

- Workspace Pod 1/1 Running; original PVC UID and bound volume unchanged.
- Workspace revision remained 23; no calls to template/file-mutation services.
- Root listing and original `src/main/java/com/example/app/App.java` readable.
- Repeating project open reused the same Pod UID and returned the same file hash.
- App.java SHA-256 after recovery: `b45c2890f01488471c0d34920274543906441ce7392f2d12dcb24e0fffde418c`.
- Separate headless browser against the running frontend/backend opened the actual project, loaded App.java via HTTP 200, displayed the editor and enabled write controls. No edit, save or Run was issued.

The restored workspace is intentionally retained for the user. Temporary verification code/compiled classes/reports and the separate bridge were removed. New automatic-on-open behavior is implemented and tested but will be loaded by the shared backend only on its next restart; the current user's files are already accessible through the existing backend.
