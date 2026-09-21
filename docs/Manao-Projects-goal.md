# Manao Project Goal

Updated: 2026-09-20. This document defines product scope, not live infrastructure health. Stage acceptance and measured results are linked below.

## Product Vision

Manao is an AI cloud development laboratory intended to connect learning code, configuring an environment, editing, running, reading errors and improving an implementation in one browser-based workflow.

The broader product direction includes reusable environment templates, code and execution analysis, AI-assisted improvements, and teaching/team/administration capabilities. These are product intentions, not a list of delivered features. See the [Manao PRD v4.0](Manao_PRD_V4-0.md) for the broader requirements.

## Delivered POC4 Slice

POC4 is a deliberately narrowed single-user Java/Maven workbench. Its accepted MVP loop is:

```text
Sign in -> Create project -> Open files -> Edit -> Explicitly save
        -> Run -> Read logs/results -> Fix or improve -> Save -> Run again
        -> Reopen/re-login with saved data -> Manually delete the project
```

- An initialized account owns private projects; the browser never chooses a Kubernetes resource as its authorization boundary.
- Each project has a workspace agent and persistent files on a 10 GiB RWX PVC. File access goes through the backend and agent, not directly from the browser to storage or Kubernetes.
- Save uses workspace revisions and durable operation receipts. Starting a Run validates the expected revision and uses a fixed server-side command: `mvn -q -DskipTests compile exec:java`. It compiles and executes the configured project entry point; it is not the old `mvn clean test` flow or arbitrary browser-supplied shell execution.
- MySQL owns user/project/Run/revision/log/operation metadata; PVCs store file contents; Kubernetes supplies Job/Pod execution facts. A revision on shared writable storage is not an immutable per-Run source snapshot.
- Run history and saved logs remain available after re-login. The accepted 6B maintenance tests separately rebuilt the backend and MySQL, retained saved data, and successfully ran again.
- Project deletion is delivered through the UI. It permanently reclaims project records and scoped resources; incomplete deletion must not report success and can be explicitly continued. Archive, undo and recoverable deletion are not delivered.
- Terminal/PTY/audit implementation exists, but the cloud frontend disables the experimental terminal by default. The accepted MVP does not require the historical full terminal/stress/fault matrix.

Implementation anchors: [Job command](../poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobResourceFactory.java), [file operations](../poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceOperationService.java), [deletion UI](../poc4/frontend/src/features/projects/DeleteProjectDialog.tsx), [cloud frontend build](../poc4/frontend/Dockerfile).

## Stage Status and Evidence

- **6A PASS:** user acceptance of the real MVP lifecycle on 2026-09-17; merged on 2026-09-18. [6A facts and evidence](Stage6A-Current-Facts.md).
- **6B PASS / closed:** cloud lifecycle, persistence and cleanup verified; version-documentation gap closed; user confirmed completion on 2026-09-20. Merged and pushed to `master` as `860cdda`. [6B acceptance](../poc4/docs/evidence/stage-6b/acceptance.md), section 10.
- Deployment and maintenance: [6B README](../poc4/deploy/6b/README.md). Stage summaries and next-work boundary: [Progress](what-we-have-done.md#next-work).

## Not Delivered by This Acceptance

- AI context retrieval, generated patches and user-confirmed AI write workflows.
- Multi-language execution, Git integration, uploads/drag-and-drop/batch operations and collaborative editing.
- Team, teaching and administration platforms, billing or multi-replica high availability.
- Production-grade malicious-code isolation, egress allowlists, archival or recoverable deletion.
- Seamless continuation of an active Run across every maintenance or infrastructure failure.

The accepted public entry uses HTTP; HTTPS and production hardening are not established by this MVP acceptance. Details remain in the deployment/acceptance documents rather than becoming additional implied deliverables here.

POC4 is not the complete Manao product. The next product slice has not been approved in the current task; neither AI work nor a new engineering gate starts automatically because 6B is closed.
