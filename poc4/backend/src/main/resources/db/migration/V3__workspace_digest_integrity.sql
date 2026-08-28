ALTER TABLE workspace_operation ADD COLUMN receipt_sha256 CHAR(64) NULL AFTER receipt_path;
ALTER TABLE workspace_operation ADD CONSTRAINT ck_workspace_operation_sha CHECK (
    REGEXP_LIKE(before_sha256, '^[0-9a-f]{64}$', 'c')
    AND REGEXP_LIKE(after_sha256, '^[0-9a-f]{64}$', 'c')
    AND (receipt_sha256 IS NULL OR REGEXP_LIKE(receipt_sha256, '^[0-9a-f]{64}$', 'c'))
);

DELIMITER $$
CREATE TRIGGER workspace_operation_immutable_digest
BEFORE UPDATE ON workspace_operation
FOR EACH ROW
BEGIN
    IF NOT (NEW.before_sha256 <=> OLD.before_sha256)
       OR NOT (NEW.after_sha256 <=> OLD.after_sha256)
       OR NOT (NEW.receipt_path <=> OLD.receipt_path)
       OR NOT (NEW.receipt_sha256 <=> OLD.receipt_sha256) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'workspace operation digest is immutable';
    END IF;
END$$
DELIMITER ;
