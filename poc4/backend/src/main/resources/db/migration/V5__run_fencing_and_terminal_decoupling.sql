-- Stage 6 remediation: decouple terminal tickets from log tickets, carry the run fencing
-- token on the run row, and persist requested terminal dimensions for the PTY handshake.
ALTER TABLE terminal_session DROP FOREIGN KEY fk_terminal_session_ticket;

ALTER TABLE run ADD COLUMN fencing_token BIGINT NULL AFTER version;

ALTER TABLE terminal_session
    ADD COLUMN cols INT NULL AFTER close_reason,
    ADD COLUMN `rows` INT NULL AFTER cols;
