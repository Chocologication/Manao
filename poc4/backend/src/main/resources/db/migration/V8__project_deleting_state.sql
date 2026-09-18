ALTER TABLE project
    DROP CHECK ck_project_state,
    ADD CONSTRAINT ck_project_state
        CHECK (state IN ('CREATING', 'READY', 'FAILED', 'DELETING'));
