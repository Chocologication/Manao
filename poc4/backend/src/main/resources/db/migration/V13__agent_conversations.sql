-- Additive conversation history. All timestamps are supplied by the application Clock.
CREATE TABLE agent_conversation (
    id VARCHAR(36) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    title VARCHAR(160) NOT NULL,
    header_json JSON NOT NULL,
    head_seq BIGINT NOT NULL DEFAULT 0,
    context_tokens BIGINT NULL,
    usage_head_seq BIGINT NULL,
    compact_request_id VARCHAR(36) NULL,
    compact_base_seq BIGINT NULL,
    compact_state VARCHAR(16) NULL,
    compact_worker_instance VARCHAR(64) NULL,
    compact_failure_code VARCHAR(64) NULL,
    created_at TIMESTAMP(6) NOT NULL,
    updated_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_agent_conversation_project FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE,
    CONSTRAINT ck_agent_conversation_head CHECK (head_seq >= 0),
    CONSTRAINT ck_agent_conversation_usage CHECK (context_tokens IS NULL OR context_tokens >= 0),
    CONSTRAINT ck_agent_conversation_compact CHECK (compact_state IS NULL OR compact_state IN ('RUNNING','COMPLETED','FAILED')),
    INDEX ix_agent_conversation_project_updated (project_id, updated_at, id)
) ENGINE=InnoDB;

CREATE TABLE agent_conversation_entry (
    conversation_id VARCHAR(36) NOT NULL,
    seq BIGINT NOT NULL,
    entry_id VARCHAR(64) NOT NULL,
    source_task_id VARCHAR(36) NULL,
    writer_id VARCHAR(64) NOT NULL,
    payload_json JSON NOT NULL,
    PRIMARY KEY (conversation_id, seq),
    UNIQUE KEY uq_agent_conversation_entry_id (conversation_id, entry_id),
    CONSTRAINT fk_agent_conversation_entry FOREIGN KEY (conversation_id) REFERENCES agent_conversation(id) ON DELETE CASCADE,
    CONSTRAINT ck_agent_conversation_entry_seq CHECK (seq > 0)
) ENGINE=InnoDB;

ALTER TABLE agent_task ADD COLUMN conversation_id VARCHAR(36) NULL,
    ADD CONSTRAINT fk_agent_task_conversation FOREIGN KEY (conversation_id) REFERENCES agent_conversation(id) ON DELETE SET NULL,
    ADD INDEX ix_agent_task_conversation (conversation_id, created_at, id);
