-- V10: dependency operation identity. The existing operation id stays the only operation
-- identity; operation_kind separates the single-file protocol from Python dependency changes
-- and request_sha256 binds every dependency row to the exact request it was registered for.
-- Legacy FILE rows keep kind 'FILE' with a NULL request digest; committed rows are retained
-- until project deletion so a lost success response can still be answered.
ALTER TABLE workspace_operation
  ADD COLUMN operation_kind VARCHAR(32) NOT NULL DEFAULT 'FILE',
  ADD COLUMN request_sha256 CHAR(64) NULL,
  ADD CONSTRAINT ck_workspace_operation_kind
    CHECK (operation_kind IN ('FILE', 'PYTHON_DEPENDENCIES')),
  ADD CONSTRAINT ck_python_dependency_request
    CHECK (operation_kind = 'FILE' OR
      (request_sha256 IS NOT NULL AND REGEXP_LIKE(request_sha256, '^[0-9a-f]{64}$', 'c')));

-- Incremental trigger (V3's digest trigger stays untouched): the identity columns must never
-- be rewritten in place; the commit path changes state and timestamps only.
DELIMITER $$
CREATE TRIGGER workspace_operation_immutable_identity
BEFORE UPDATE ON workspace_operation
FOR EACH ROW
BEGIN
    IF NOT (NEW.operation_kind <=> OLD.operation_kind)
       OR NOT (NEW.request_sha256 <=> OLD.request_sha256) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'workspace operation identity is immutable';
    END IF;
END$$
DELIMITER ;
