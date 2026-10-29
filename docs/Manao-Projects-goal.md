# Manao Project Goal

Updated: 2026-10-13. Current integrated baseline: `master` at `5e08a9e`, including the Python slice merged by `2ef32a5` (2026-10-12). This document defines product scope, not live infrastructure health. Stage acceptance and measured results are linked below.

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

## Delivered Extension: Java Runtime

The user chose multi-language adaptation before AI verification, beginning with Java projects that can optionally expose application ports and use project-specific MySQL/Redis. On 2026-09-21 the user confirmed persistent MySQL data across application stop, edits and reruns, and a separate MySQL PVC rather than sharing the workspace PVC. The user also set a two-hour lifetime after successful application startup, mandatory manual entry of external ports in 30000–31000, and no additional product range restriction for valid container ports. Port conflicts must ask the user to change the number, never silently select another.

The [Java Runtime Design](old_docs/superpowers/specs/2026-09-21-java-project-runtime-design.md) records confirmed requirements, proposed defaults, lifecycle contracts and acceptance scenarios. It separates project-owned dependencies/data from each application Run. The [module review](old_docs/superpowers/specs/2026-09-21-java-runtime-module-review.md) maps responsibilities, interfaces and tests. The user confirmed manual rerun after application failure; the [implementation plan](old_docs/superpowers/plans/2026-09-21-java-project-runtime-implementation-plan.md) therefore reuses Job + Service without application auto-recovery. The Java runtime is implemented and integrated to `master` (`ef1b5bb`, 2026-09-25); its deployment and verification status is recorded in the [runtime acceptance record](../poc4/docs/evidence/java-runtime/acceptance.md). [Domain terms](../CONTEXT.md) distinguish project, workspace, Run and project dependency.

On 2026-09-22 the user approved preloading standard template dependencies/plugins in the Java runner image and retaining each project's Maven cache in a separate directory on its existing workspace PVC. This improves first and repeated application Runs; workspace creation does not wait for Maven. No extra cache PVC is introduced. The [Maven cache supplement](old_docs/superpowers/plans/2026-09-22-java-maven-cache-implementation-plan.md) was implemented (C1/C2), and C3 deployed it with the dedicated cache acceptance completed the same day, recorded in the [runtime acceptance record](../poc4/docs/evidence/java-runtime/acceptance.md) section 8; that round's 58s first-run and 7s cache-reuse timings are measured samples, not a general performance promise. The formal 7200s run remains WAIVED_BY_USER and one DELETING leftover awaits an operator decision. Future language support may reuse the project-cache lifecycle without adding a general cache framework now.

The original POC4 acceptance remains the baseline evidence for that MVP. Java and Python extensions have their own acceptance records. That original POC4 acceptance does not establish AI acceptance; current AI delivery and stage boundaries are recorded below. Historical stage numbers and completed gates are not being rewritten.

## Delivered Extension: Python Runtime

On 2026-09-25 the user requested Python adaptation after Java integration. The delivered scope includes ordinary programs, FastAPI web services, browser `uv add/remove`, dependency recovery, the workbench/log repair, the dependency mirror and requirements.txt batch import. Project ports, MySQL/Redis ownership and bounded Run lifetimes reuse the Java runtime contract.

The slice was deployed and cloud-accepted on `codex/python-runtime`, then merged to `master` by `2ef32a5` (2026-10-12, no fast-forward) after the user's manual acceptance. The [Python acceptance record](../poc4/docs/evidence/python-runtime/acceptance.md), sections 5–8, owns the dated results and limits: the initial cloud E2E passed 10/10; the mirror/batch round recorded 6 passed / 1 failed / 3 not run, with the pre-existing dependency-panel race and deferred minors retained. The formal 7200s case remains SKIPPED by user instruction. The [design](old_docs/superpowers/specs/2026-09-25-python-runtime-design.md), [implementation plan](old_docs/superpowers/plans/2026-09-25-python-runtime-implementation-plan.md) and [handoff](old_docs/superpowers/plans/2026-09-25-python-runtime-agent-handoff.md) remain historical execution records, not a new task queue.

## Next Agreed Direction: Autonomous Coding Agent

On 2026-10-13 the user chose to skip Go/TypeScript adaptation and enter AI integration selection and design directly. Those language slices are no longer prerequisites. The target is an autonomous coding Agent: after receiving a task, it reads and writes code, manages dependencies, uses Shell, runs the application and repairs failures within the current user's project. Ordinary project operations run automatically; destructive or otherwise high-risk operations require confirmation. The Agent must not operate on the Manao platform itself. Only cloud model APIs are in scope; local model inference is excluded. Future expansion prioritizes coding-oriented MCP/Skills, multiple Agents, project tools and more complex tasks.

Selection prioritizes open-source options: Vercel AI SDK, Pi, DeerFlow and LiteRT-LM were evaluated, with self-built orchestration as the last fallback. The user agreed with the Pi SDK recommendation. The [framework evaluation](research/2026-10-13-ai-integration-framework-evaluation.md), section 10, owns confirmed choices: direct project modification, exclusive Agent write access, user editing after pausing and confirming execution has stopped, and automatic application stop/start within the programming task. The initial acceptance goal was book CRUD with REST endpoints and project MySQL persistence in a dedicated Spring Boot acceptance project without important existing data. All operations within that project's database are automatic; database confirmation rules for projects with important existing data remain deferred. The goal covers code/dependency changes, build/tests, application startup and failure repair, followed by Python expansion.

On 2026-10-19 the user confirmed that actual use of the deployed AI integration already supports book-data CRUD and that stage three has fulfilled its mission ahead of a separate implementation round. The [stage-three user acceptance record](../poc4/docs/evidence/ai-stage3/acceptance.md) owns that completion decision. Stage two remains unpassed and paused under its [engineering acceptance record](../poc4/docs/evidence/ai-stage2/acceptance.md); the user's stage-three decision does not replace those outstanding checks or claim a complete AI first release. Stage-four takeover and recovery remain future scope. This update records the user's result; it adds no product implementation or deployment.
