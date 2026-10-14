-- V11: persistent AI agent tasks and their project tool-call records (stage one).
-- agent_task.id is the browser-generated UUID submitted before the first write; the
-- request_sha256 binds every row to the exact request it was created for, so a same-id
-- retry answers the original task and a different request is refused. The generated
-- active_project column plus its unique index let at most one task own a project's writes:
-- QUEUED/RUNNING/NEEDS_ATTENTION keep the occupancy, COMPLETED/FAILED release it.
-- The column stays VIRTUAL: MySQL refuses a foreign key on the base column of a STORED
-- generated column (errno 1215), and the project FK must hold; the unique index still
-- materializes the computed values for both enforcement and lookups. Timestamps follow the
-- V4 explicit-database-clock convention: no database defaults, writers bind the clock.
CREATE TABLE agent_task (
    id VARCHAR(36) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    request_sha256 CHAR(64) NOT NULL,
    prompt TEXT NOT NULL,
    state VARCHAR(16) NOT NULL,
    worker_instance_id VARCHAR(64) NULL,
    worker_epoch BIGINT NOT NULL DEFAULT 0,
    workspace_revision BIGINT NOT NULL,
    progress_json JSON NULL,
    summary TEXT NULL,
    failure_code VARCHAR(64) NULL,
    created_at TIMESTAMP(6) NOT NULL,
    updated_at TIMESTAMP(6) NOT NULL,
    active_project VARCHAR(64) GENERATED ALWAYS AS (
        CASE WHEN state IN ('QUEUED', 'RUNNING', 'NEEDS_ATTENTION') THEN project_id ELSE NULL END) VIRTUAL,
    PRIMARY KEY (id),
    CONSTRAINT fk_agent_task_project FOREIGN KEY (project_id)
      REFERENCES project(id) ON DELETE CASCADE,
    CONSTRAINT fk_agent_task_owner FOREIGN KEY (owner_id) REFERENCES app_user(id),
    CONSTRAINT ck_agent_task_state
      CHECK (state IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'NEEDS_ATTENTION')),
    CONSTRAINT ck_agent_task_revision CHECK (workspace_revision >= 0),
    CONSTRAINT ck_agent_task_request
      CHECK (REGEXP_LIKE(request_sha256, '^[0-9a-f]{64}$', 'c'))
) ENGINE=InnoDB;

CREATE UNIQUE INDEX uq_agent_task_project_active ON agent_task (active_project);

-- Tool-call records: the structure exists from stage one; the file/build tool tasks own the
-- semantics. (task_id, tool_call_id) is the stable call identity — a replayed call reuses its
-- row, operation id and derived Job identity instead of generating a second side effect.
CREATE TABLE agent_tool_call (
    task_id VARCHAR(36) NOT NULL,
    tool_call_id VARCHAR(64) NOT NULL,
    request_sha256 CHAR(64) NOT NULL,
    tool_name VARCHAR(64) NOT NULL,
    args_json JSON NULL,
    state VARCHAR(16) NOT NULL,
    workspace_operation_id VARCHAR(64) NULL,
    expected_revision BIGINT NOT NULL,
    result_json JSON NULL,
    job_name VARCHAR(255) NULL,
    job_uid VARCHAR(64) NULL,
    pod_uid VARCHAR(64) NULL,
    created_at TIMESTAMP(6) NOT NULL,
    updated_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (task_id, tool_call_id),
    CONSTRAINT fk_agent_tool_call_task FOREIGN KEY (task_id)
      REFERENCES agent_task(id) ON DELETE CASCADE,
    CONSTRAINT ck_agent_tool_call_state
      CHECK (state IN ('REGISTERED', 'RUNNING', 'COMPLETED', 'NEEDS_ATTENTION')),
    CONSTRAINT ck_agent_tool_call_request
      CHECK (REGEXP_LIKE(request_sha256, '^[0-9a-f]{64}$', 'c'))
) ENGINE=InnoDB;
