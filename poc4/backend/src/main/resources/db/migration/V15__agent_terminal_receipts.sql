-- V15: durable terminal receipts and the budget deadline for AI tasks (repair design
-- section 4). Purely additive: history rows keep every new column NULL — no RUNNING row
-- is reclassified here, and old tasks (deadline_at NULL) never enter the automatic budget
-- close until an operator explicitly takes them over. terminal_report_id is the stable
-- per-execution identity (lowercase SHA-256 over the compact JSON array
-- [1, taskId, workerEpoch, requestSha256, "terminal"]), terminal_report_sha256 is the
-- backend-computed canonical content digest, and close_reason_code is the durable close
-- reason that survives restarts and can never be overwritten by a late report or a
-- repeated close. The indexes cover the reconcile/deadline candidate scans so they never
-- sweep all historical tasks. Timestamps follow the V4 explicit-database-clock convention:
-- no database defaults, writers bind the clock.
ALTER TABLE agent_task
    ADD COLUMN terminal_report_id VARCHAR(64) NULL AFTER failure_code,
    ADD COLUMN terminal_report_json JSON NULL AFTER terminal_report_id,
    ADD COLUMN terminal_report_sha256 CHAR(64) NULL AFTER terminal_report_json,
    ADD COLUMN terminal_received_at TIMESTAMP(6) NULL AFTER terminal_report_sha256,
    ADD COLUMN deadline_at TIMESTAMP(6) NULL AFTER terminal_received_at,
    ADD COLUMN close_reason_code VARCHAR(64) NULL AFTER deadline_at,
    ADD COLUMN next_reconcile_at TIMESTAMP(6) NULL AFTER close_reason_code,
    ADD CONSTRAINT ck_agent_task_report_id
      CHECK (REGEXP_LIKE(terminal_report_id, '^[0-9a-f]{64}$', 'c')),
    ADD CONSTRAINT ck_agent_task_report_sha
      CHECK (REGEXP_LIKE(terminal_report_sha256, '^[0-9a-f]{64}$', 'c'));

CREATE INDEX idx_agent_task_reconcile ON agent_task (next_reconcile_at, id);

CREATE INDEX idx_agent_task_deadline ON agent_task (deadline_at, id);
