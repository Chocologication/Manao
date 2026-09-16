# POC4 MVP Core Loop Design

**Date:** 2026-09-15
**Status:** Approved for implementation

## 1. Goal

Deliver the smallest real POC4 product that lets one authenticated user repeatedly complete this browser workflow:

```text
login -> create project -> edit file -> save -> run -> read logs/result -> modify code -> run again
```

The product must use the existing real backend, MySQL persistence, workspace PVC/agent, and Kubernetes Maven Job path. A mock-only pass is not acceptance evidence.

## 2. First-principles scope

The loop requires only four product concerns:

1. **Identity:** a user can log in and only access their projects.
2. **Workspace:** a project has persistent files and a monotonically increasing workspace revision.
3. **Execution:** a saved revision is compiled and runs the project template entrypoint `com.example.app.App` in a Kubernetes Job; the browser cannot submit an arbitrary command.
4. **Feedback:** the browser can see the persisted/live log and a strict terminal result, then edit again.

The following remain outside the product golden path for this slice:

- interactive Terminal and PTY;
- audit UI;
- project cleanup UI;
- fault-injection scenarios;
- dynamic bridge selection as a product concept;
- multi-instance recovery design beyond what is necessary to avoid a false Run result;
- AI, Git, multi-language support, teams, billing, and 6B deployment.

Existing out-of-path code is not deleted in this slice. It must not prevent the core loop from working.

## 3. Product contracts

### 3.1 Project

- `POST /api/v1/projects` creates an owner-scoped project and returns `CREATING`.
- Provisioning creates the PVC, workspace resources, template files, and then marks the project `READY`.
- A failed cleanup of a one-shot initializer after the workspace is usable must not change a usable project back to `FAILED`.
- The browser may open the workbench only when the project is `READY`.

### 3.2 Workspace

- The browser accesses files through the backend; it never accesses Kubernetes or the PVC directly.
- File save requires the current workspace revision.
- A successful save returns the new revision and the saved file metadata/content needed by the client.
- A stale revision returns `409 WORKSPACE_REVISION_CONFLICT` and the client must reload rather than silently overwrite.
- A run request carries the revision currently displayed by the editor.
- While a Run is locking the project, file writes are rejected; after a terminal Run state, writes are accepted again.

### 3.3 Run

- `POST /api/v1/projects/{projectId}/runs` accepts the expected workspace revision and returns `202` with state `STARTING`.
- The Run executes the saved project code through the server-owned Maven `exec:java` entrypoint `com.example.app.App`; callers cannot supply a command, image, environment, or cluster reference.
- The Run stores the exact requested workspace revision at creation time.
- The public state model is:
  - active: `STARTING`, `RUNNING`;
  - terminal: `SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`.
- Internal recovery state may remain for transport reconciliation, but it must not be presented as success and must not permanently block editing.
- A successful Kubernetes Job settles the Run as `SUCCEEDED` with exit code `0` or the observed successful exit code.
- A failed Kubernetes Job settles the Run as `FAILED` with a non-success exit code when available.
- A deadline settles the Run as `TIMED_OUT`.
- A stopped Job settles the Run as `CANCELLED`.
- The API, database, Job/Pod observation and displayed logs must agree before the user can treat the result as final.
- `GET /runs` must honor its cursor when supplied and return a usable `nextCursor`.

### 3.4 Logs and feedback

- The browser can load logs for a selected Run after a page refresh.
- The browser can observe the active Run while it executes.
- The final result is visible without requiring the user to guess whether the Run completed.
- A failed Run displays the real compile or program failure output.
- A successful Run displays the program output from the project entrypoint.

## 4. UI behavior

The default workbench exposes only the core path:

- project file tree;
- editor;
- Save action;
- Run action;
- Run state and revision;
- log/result panel;
- project navigation and logout.

Save and Run are disabled while a Run is active. When the Run reaches a terminal state, the editor and Save action become available again. Terminal remains optional/out of path and must not control the ordinary editor lock.

## 5. Non-goals and simplification rule

Do not remove large subsystems merely to make the code look smaller. Prefer a narrow product composition over destructive refactoring:

- fix the existing core path;
- stop mounting out-of-scope UI in the default path;
- keep infrastructure adapters behind the existing interfaces;
- add no new persistence technology or service;
- add no abstraction unless a failing test demonstrates the need.

## 6. Acceptance scenario

Using a disposable user/project on the real local-cluster profile:

1. Log in.
2. Create a project and wait for `READY`.
3. Read the template files.
4. Make `App.java` fail compilation and save it.
5. Run the saved revision.
6. Observe an active state, receive Maven output, and verify final state `FAILED`.
7. Verify the editor becomes editable again.
8. Fix `App.java` and save it.
9. Run again.
10. Verify final state `SUCCEEDED`, exit code `0`, and success output.
11. Reload the browser.
12. Verify the corrected file and Run history remain available.

The acceptance result is `PASS` only when the complete sequence succeeds. Unit, mock, `--list`, or a test that accepts any terminal state is not sufficient evidence.

## 7. Evidence boundary

This slice does not claim full Stage 6A or Stage 6B acceptance. The implementation result must report separately:

- automated unit/frontend evidence;
- real browser/backend/Kubernetes loop evidence;
- skipped engineering experiments and why they are outside this MVP.