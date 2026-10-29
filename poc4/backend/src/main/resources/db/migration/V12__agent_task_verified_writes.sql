-- V12: the verified write ledger of one agent task (stage-one review fix I1).
-- A settled write_file tool call records its verified revision and changed path on
-- the task row, so the browser snapshot can carry the LATEST verified workspace
-- revision and the accumulated changed paths. The creation-time workspace_revision
-- column is preserved untouched: it stays the initial version the submission was
-- made against and the start command carried. Both columns stay NULL until the
-- first verified write settles; a task that only read or built keeps its creation
-- snapshot. Timestamps follow the V4 explicit-database-clock convention.
ALTER TABLE agent_task
    ADD COLUMN settled_revision BIGINT NULL AFTER workspace_revision,
    ADD COLUMN changed_paths_json JSON NULL AFTER settled_revision;
