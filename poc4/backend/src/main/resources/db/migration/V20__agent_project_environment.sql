-- Additive task snapshot: historical tasks retain NULL and are never inferred as Java.
ALTER TABLE agent_task
    ADD COLUMN environment_json JSON NULL,
    ADD COLUMN environment_sha256 CHAR(64) NULL;
