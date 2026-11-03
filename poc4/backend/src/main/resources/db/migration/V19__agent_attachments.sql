-- Binary data lives only in the project's existing PVC. Times never change after admission.
CREATE TABLE agent_attachment (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL,
    conversation_id VARCHAR(36) NOT NULL,
    task_id VARCHAR(36) NULL,
    file_name TEXT NOT NULL,
    mime_type VARCHAR(255) NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    uploaded_at TIMESTAMP(6) NOT NULL,
    expires_at TIMESTAMP(6) NOT NULL,
    state VARCHAR(16) NOT NULL,
    deleted_at TIMESTAMP(6) NULL,
    cleanup_failure_code VARCHAR(64) NULL,
    cleanup_attempted_at TIMESTAMP(6) NULL,
    CONSTRAINT fk_attachment_project FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE,
    CONSTRAINT fk_attachment_conversation FOREIGN KEY(conversation_id) REFERENCES agent_conversation(id) ON DELETE CASCADE,
    CONSTRAINT fk_attachment_task FOREIGN KEY(task_id) REFERENCES agent_task(id) ON DELETE SET NULL,
    CONSTRAINT ck_attachment_size CHECK(size_bytes >= 0 AND size_bytes <= 10000000),
    CONSTRAINT ck_attachment_state CHECK(state IN ('UPLOADING','READY','DELETING','DELETED')),
    INDEX ix_attachment_expiry(state, expires_at, id),
    INDEX ix_attachment_catalog(conversation_id, uploaded_at, id)
) ENGINE=InnoDB;
