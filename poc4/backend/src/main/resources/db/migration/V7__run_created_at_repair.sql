-- V7__run_created_at_repair.sql
-- V1..V5 never defined run.created_at although RunRecord/JdbcRunStore (and the browser run
-- contract) require an immutable creation timestamp; the column is added here and backfilled
-- from updated_at for any legacy rows. JdbcRunStore.insertRun writes both explicitly.
ALTER TABLE run ADD COLUMN created_at TIMESTAMP(6) NULL AFTER updated_at;
UPDATE run SET created_at = updated_at WHERE created_at IS NULL;
ALTER TABLE run MODIFY COLUMN created_at TIMESTAMP(6) NOT NULL;
