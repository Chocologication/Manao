CREATE TABLE app_user (
    id VARCHAR(64) NOT NULL,
    username VARCHAR(128) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_app_user_username (username)
) ENGINE=InnoDB;

CREATE TABLE project (
    id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    name VARCHAR(160) NOT NULL,
    state VARCHAR(16) NOT NULL,
    workspace_revision BIGINT NOT NULL DEFAULT 0,
    failure_reason VARCHAR(64) NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    CONSTRAINT fk_project_owner FOREIGN KEY (owner_id) REFERENCES app_user(id),
    CONSTRAINT ck_project_state CHECK (state IN ('CREATING', 'READY', 'FAILED')),
    CONSTRAINT ck_project_revision CHECK (workspace_revision >= 0)
) ENGINE=InnoDB;

CREATE TABLE workspace_operation (
    id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    expected_revision BIGINT NOT NULL,
    before_sha256 CHAR(64) NOT NULL,
    after_sha256 CHAR(64) NOT NULL,
    receipt_path VARCHAR(512) NOT NULL,
    state VARCHAR(16) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    committed_at TIMESTAMP(6) NULL,
    pending_marker TINYINT GENERATED ALWAYS AS (CASE WHEN state = 'PENDING' THEN 1 ELSE NULL END) STORED,
    PRIMARY KEY (id),
    CONSTRAINT fk_workspace_operation_project FOREIGN KEY (project_id) REFERENCES project(id),
    CONSTRAINT ck_workspace_operation_state CHECK (state IN ('PENDING', 'COMMITTED', 'FAILED')),
    CONSTRAINT ck_workspace_operation_revision CHECK (expected_revision >= 0),
    CONSTRAINT ck_workspace_operation_receipt CHECK (receipt_path NOT LIKE '/%' AND receipt_path NOT LIKE '%..%')
) ENGINE=InnoDB;

CREATE TABLE run (
    id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    requested_revision BIGINT NOT NULL,
    state VARCHAR(16) NOT NULL,
    policy_json JSON NOT NULL,
    job_ref VARCHAR(255) NULL,
    pod_ref VARCHAR(255) NULL,
    started_at TIMESTAMP(6) NULL,
    finished_at TIMESTAMP(6) NULL,
    exit_code INT NULL,
    termination_reason VARCHAR(64) NULL,
    version BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    CONSTRAINT fk_run_project FOREIGN KEY (project_id) REFERENCES project(id),
    CONSTRAINT ck_run_state CHECK (state IN ('STARTING', 'RUNNING', 'STOPPING', 'RECOVERING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')),
    CONSTRAINT ck_run_revision CHECK (requested_revision >= 0),
    CONSTRAINT ck_run_version CHECK (version >= 0)
) ENGINE=InnoDB;

CREATE TABLE run_log_chunk (
    run_id VARCHAR(64) NOT NULL,
    seq BIGINT NOT NULL,
    text_utf8 MEDIUMTEXT NOT NULL,
    byte_length INT NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (run_id, seq),
    CONSTRAINT fk_run_log_chunk_run FOREIGN KEY (run_id) REFERENCES run(id) ON DELETE CASCADE,
    CONSTRAINT ck_run_log_chunk_seq CHECK (seq >= 0),
    CONSTRAINT ck_run_log_chunk_length CHECK (byte_length >= 0)
) ENGINE=InnoDB;

CREATE TABLE log_ticket (
    ticket_hash CHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP(6) NOT NULL,
    consumed_at TIMESTAMP(6) NULL,
    PRIMARY KEY (ticket_hash),
    CONSTRAINT fk_log_ticket_user FOREIGN KEY (user_id) REFERENCES app_user(id),
    CONSTRAINT fk_log_ticket_project FOREIGN KEY (project_id) REFERENCES project(id),
    CONSTRAINT fk_log_ticket_run FOREIGN KEY (run_id) REFERENCES run(id)
) ENGINE=InnoDB;

CREATE TABLE terminal_session (
    id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    state VARCHAR(16) NOT NULL,
    ticket_hash CHAR(64) NOT NULL,
    expires_at TIMESTAMP(6) NOT NULL,
    consumed_at TIMESTAMP(6) NULL,
    pod_ref VARCHAR(255) NULL,
    container_ref VARCHAR(255) NULL,
    started_at TIMESTAMP(6) NULL,
    finished_at TIMESTAMP(6) NULL,
    exit_code INT NULL,
    close_reason VARCHAR(64) NULL,
    version BIGINT NOT NULL DEFAULT 0,
    active_terminal_marker TINYINT GENERATED ALWAYS AS (CASE WHEN state IN ('RESERVED', 'LIVE') THEN 1 ELSE NULL END) STORED,
    PRIMARY KEY (id),
    CONSTRAINT fk_terminal_session_project FOREIGN KEY (project_id) REFERENCES project(id),
    CONSTRAINT fk_terminal_session_run FOREIGN KEY (run_id) REFERENCES run(id),
    CONSTRAINT fk_terminal_session_user FOREIGN KEY (user_id) REFERENCES app_user(id),
    CONSTRAINT fk_terminal_session_ticket FOREIGN KEY (ticket_hash) REFERENCES log_ticket(ticket_hash),
    CONSTRAINT ck_terminal_session_state CHECK (state IN ('RESERVED', 'LIVE', 'EXPIRED', 'CLOSED', 'INTERRUPTED', 'FAILED'))
) ENGINE=InnoDB;

CREATE TABLE terminal_audit (
    id VARCHAR(64) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    command TEXT NOT NULL,
    state VARCHAR(16) NOT NULL,
    started_at TIMESTAMP(6) NOT NULL,
    finished_at TIMESTAMP(6) NULL,
    exit_code INT NULL,
    sensitive_detected BOOLEAN NOT NULL DEFAULT FALSE,
    trust_level VARCHAR(16) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_terminal_audit_session FOREIGN KEY (session_id) REFERENCES terminal_session(id),
    CONSTRAINT fk_terminal_audit_project FOREIGN KEY (project_id) REFERENCES project(id),
    CONSTRAINT fk_terminal_audit_run FOREIGN KEY (run_id) REFERENCES run(id),
    CONSTRAINT fk_terminal_audit_user FOREIGN KEY (user_id) REFERENCES app_user(id),
    CONSTRAINT ck_terminal_audit_state CHECK (state IN ('RUNNING', 'CLOSED', 'INTERRUPTED', 'FAILED'))
) ENGINE=InnoDB;

CREATE TABLE instance_lease (
    id VARCHAR(32) NOT NULL,
    holder_id VARCHAR(128) NOT NULL,
    fencing_token BIGINT NOT NULL,
    expires_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT ck_instance_lease_token CHECK (fencing_token > 0)
) ENGINE=InnoDB;
