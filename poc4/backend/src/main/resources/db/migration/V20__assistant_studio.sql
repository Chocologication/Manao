-- V19 belongs to the released agent attachment migration; Studio is additive at V20.
CREATE TABLE assistant_model (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    owner_id VARCHAR(64) NOT NULL,
    label VARCHAR(80) NOT NULL,
    base_url VARCHAR(1024) NOT NULL,
    model_name VARCHAR(160) NOT NULL,
    encrypted_key TEXT NOT NULL,
    vision BOOLEAN NOT NULL DEFAULT FALSE,
    tools BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP(6) NOT NULL,
    INDEX idx_assistant_model_owner (owner_id, updated_at)
);
CREATE TABLE assistant_conversation (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL,
    title VARCHAR(160) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL,
    updated_at TIMESTAMP(6) NOT NULL,
    CONSTRAINT fk_assistant_conversation_project FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE,
    INDEX idx_assistant_conversation_project (project_id, updated_at)
);
CREATE TABLE assistant_turn (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    conversation_id VARCHAR(36) NOT NULL,
    request_digest VARCHAR(64) NOT NULL,
    version BIGINT NOT NULL DEFAULT 0,
    data_json MEDIUMTEXT NOT NULL,
    created_at TIMESTAMP(6) NOT NULL,
    CONSTRAINT fk_assistant_turn_conversation FOREIGN KEY (conversation_id) REFERENCES assistant_conversation(id) ON DELETE CASCADE,
    INDEX idx_assistant_turn_conversation (conversation_id, created_at)
);
CREATE TABLE assistant_attachment (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    owner_id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    media_type VARCHAR(120) NOT NULL,
    body MEDIUMBLOB NOT NULL,
    extracted_text MEDIUMTEXT NOT NULL,
    truncated BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP(6) NOT NULL,
    CONSTRAINT fk_assistant_attachment_project FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE,
    INDEX idx_assistant_attachment_owner (owner_id, project_id)
);
CREATE TABLE assistant_task_options (
    task_id VARCHAR(36) NOT NULL PRIMARY KEY,
    owner_id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    model_id VARCHAR(36) NOT NULL,
    apply_policy VARCHAR(16) NOT NULL,
    turn_id VARCHAR(36) NOT NULL,
    base_revision BIGINT NOT NULL,
    files_json MEDIUMTEXT NOT NULL,
    apply_json MEDIUMTEXT NOT NULL,
    created_at TIMESTAMP(6) NOT NULL,
    CONSTRAINT fk_assistant_task_project FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE,
    INDEX idx_assistant_task_turn (turn_id)
);
