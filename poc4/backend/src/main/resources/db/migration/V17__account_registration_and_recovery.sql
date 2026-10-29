-- V17: multi-account identity and one-time challenge storage (design section 6).
-- Purely additive. Legacy accounts keep their ids, BCrypt hashes, projects and owners
-- untouched: email and email_verified_at stay NULL, auth_version defaults to 0, and no fake
-- email is backfilled. All rows are written with explicit timestamps (V4 convention); the new
-- table has no database clock defaults.

ALTER TABLE app_user
    ADD COLUMN email VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    ADD COLUMN email_verified_at TIMESTAMP(6) NULL,
    ADD COLUMN auth_version BIGINT NOT NULL DEFAULT 0,
    ADD UNIQUE KEY uq_app_user_email (email);

-- The single one-time challenge table shared by the image captcha, the registration email
-- code and the password-reset email code. UNIQUE(purpose, email) reserves one send slot per
-- purpose and address (CAPTCHA rows carry a NULL email and therefore never collide).
-- answer_mac stores only lowercase hex HMAC-SHA256 over id|purpose|email|answer; the answer
-- itself is never persisted. RESET_PASSWORD rows bind user_id and the issuing auth_version,
-- so any later password change invalidates a stale reset code.
CREATE TABLE auth_challenge (
    id VARCHAR(64) NOT NULL,
    purpose VARCHAR(32) NOT NULL,
    email VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    user_id VARCHAR(64) NULL,
    auth_version_snapshot BIGINT NULL,
    answer_mac CHAR(64) NOT NULL,
    state VARCHAR(16) NOT NULL,
    expires_at TIMESTAMP(6) NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    next_send_at TIMESTAMP(6) NULL,
    window_started_at TIMESTAMP(6) NULL,
    window_send_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP(6) NOT NULL,
    updated_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_auth_challenge_purpose_email (purpose, email),
    KEY ix_auth_challenge_expires_at (expires_at),
    CONSTRAINT fk_auth_challenge_user FOREIGN KEY (user_id) REFERENCES app_user(id),
    CONSTRAINT ck_auth_challenge_purpose
        CHECK (purpose IN ('CAPTCHA', 'REGISTER_EMAIL', 'RESET_PASSWORD')),
    CONSTRAINT ck_auth_challenge_state
        CHECK (state IN ('SENDING', 'ACTIVE', 'CONSUMED', 'FAILED')),
    CONSTRAINT ck_auth_challenge_attempts CHECK (attempts >= 0),
    CONSTRAINT ck_auth_challenge_window_sends CHECK (window_send_count >= 0),
    CONSTRAINT ck_auth_challenge_answer_mac
        CHECK (REGEXP_LIKE(answer_mac, '^[0-9a-f]{64}$', 'c'))
) ENGINE=InnoDB;

-- Ticket version binding (design section 8.1): tickets issued after V17 carry the
-- auth_version of the authenticated request; pre-V17 tickets stay NULL and consumers must
-- refuse a NULL version instead of treating it as current. Rows are not rewritten here.
ALTER TABLE log_ticket ADD COLUMN auth_version BIGINT NULL;

ALTER TABLE terminal_session ADD COLUMN auth_version BIGINT NULL;
