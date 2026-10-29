-- Persist retry accounting separately from display progress and receipt timestamps.
-- Existing active tasks resume at 5s; no historical state/deadline is changed.
ALTER TABLE agent_task ADD COLUMN reconcile_attempt INT NOT NULL DEFAULT 0 AFTER next_reconcile_at;
