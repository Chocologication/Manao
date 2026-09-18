ALTER TABLE workspace_operation
    ADD CONSTRAINT ck_workspace_operation_receipt_present CHECK (receipt_sha256 IS NOT NULL),
    MODIFY COLUMN created_at TIMESTAMP(6) NOT NULL,
    MODIFY COLUMN receipt_sha256 CHAR(64) NOT NULL;

ALTER TABLE app_user
    MODIFY COLUMN created_at TIMESTAMP(6) NOT NULL;

ALTER TABLE project
    MODIFY COLUMN created_at TIMESTAMP(6) NOT NULL,
    MODIFY COLUMN updated_at TIMESTAMP(6) NOT NULL;

ALTER TABLE run
    MODIFY COLUMN updated_at TIMESTAMP(6) NOT NULL;

ALTER TABLE run_log_chunk
    MODIFY COLUMN created_at TIMESTAMP(6) NOT NULL;
