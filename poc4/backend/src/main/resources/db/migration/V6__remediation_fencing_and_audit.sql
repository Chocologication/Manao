-- V6__remediation_fencing_and_audit.sql
-- Stage 6 remediation: backfill a fencing token for every historical run row (N6/P0-2) and
-- widen terminal_audit.trust_level so WRAPPER_TRANSPORT fits (P1-6).
-- Active rows take the current authority token; terminal rows take 1 (never updated again).
UPDATE run r LEFT JOIN instance_lease l ON l.id = 'backend'
SET r.fencing_token = COALESCE(l.fencing_token, 1)
WHERE r.fencing_token IS NULL;

ALTER TABLE run MODIFY COLUMN fencing_token BIGINT NOT NULL;

ALTER TABLE terminal_audit MODIFY COLUMN trust_level VARCHAR(32) NOT NULL;
