-- V9: project runtime configuration, creation identity and storage bindings.
-- Backward compatible: legacy rows keep JSON NULL and read as console projects.
ALTER TABLE project
  ADD COLUMN runtime_spec_json JSON NULL,
  ADD COLUMN creation_key VARCHAR(36) NULL,
  ADD COLUMN creation_digest CHAR(64) NULL,
  ADD COLUMN endpoint_state VARCHAR(16) NOT NULL DEFAULT 'NONE',
  ADD UNIQUE INDEX uq_project_creation (owner_id, creation_key);

ALTER TABLE run
  ADD COLUMN first_ready_at TIMESTAMP(6) NULL,
  ADD COLUMN expires_at TIMESTAMP(6) NULL,
  ADD COLUMN execution_pod_uid VARCHAR(64) NULL,
  ADD COLUMN termination_intent VARCHAR(40) NULL;

CREATE TABLE project_storage_binding (
  project_id VARCHAR(64) NOT NULL,
  purpose VARCHAR(16) NOT NULL,
  pvc_name VARCHAR(255) NOT NULL,
  pvc_uid VARCHAR(64) NULL,
  pv_name VARCHAR(255) NULL,
  pv_uid VARCHAR(64) NULL,
  PRIMARY KEY (project_id, purpose),
  CONSTRAINT fk_runtime_storage_project FOREIGN KEY (project_id)
    REFERENCES project(id) ON DELETE CASCADE,
  CONSTRAINT ck_runtime_storage_purpose CHECK (purpose IN ('WORKSPACE','MYSQL'))
) ENGINE=InnoDB;
