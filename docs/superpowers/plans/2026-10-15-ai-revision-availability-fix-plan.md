# AI Revision Availability Fix (2026-10-15)

## Observed symptom

After a Pi task settles, the AI panel can remain disabled with
`REVISION_UNAVAILABLE`, even though the file tree is visible and file reads still
return a workspace revision.

## Confirmed cause

The frontend writes workspace revisions into the TanStack Query key
`project-files/<projectId>/revision` from file-read responses. The AI panel used
`QueryClient.getQueryData()` to read that key, which is a non-reactive lookup.
The revision query had no observer and therefore used the default five-minute
inactive-query garbage-collection timer. The tree queries remained observed, so
the UI could show a healthy tree while the separate revision query was gone.

The live workbench reproduced this state: root and nested tree responses were
HTTP 200 with revision `19`, `agent-tasks/current` returned 404 (no active task),
and the revision query had no data and zero observers. A file-tree refresh
repopulated the revision and immediately made the task button usable after a
panel render.

## Fix boundary

- Add a disabled `useWorkspaceRevision` observer. It performs no network request
  and makes cache updates reactive while the workbench is mounted.
- During the authoritative workspace reload, reset the revision query and keep
  its query instance/observer; remove only tree, metadata, and content queries.
  The next root read remains the source of the authoritative revision.
- Preserve the existing fail-closed checks for dirty buffers, active runs/tasks,
  reload failures, and unknown revisions.

## Verification

- Regression test proves a missing revision becomes usable when a file read
  restores it.
- Regression test proves the disabled observer receives cache updates without a
  revision request and stays attached across workspace reload.
- Frontend unit suite: 1374 tests passed.
- Frontend TypeScript build and Vite production build passed.

This fix is implemented in the `codex/ai-integration` worktree and is not a
cloud deployment or a new stage-one acceptance claim until an authorized rollout
and browser re-verification are completed.
