package com.manao.poc4.project;

import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;

/** JDBC implementation backed by the V9 runtime columns and project_storage_binding table. */
public final class JdbcProjectRuntimeStore implements ProjectRuntimeStore {
    private static final String ENDPOINT_NONE = "NONE";
    private final JdbcTemplate jdbc;

    public JdbcProjectRuntimeStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override public ProjectRuntimeSpec loadSpec(String projectId) {
        List<String> specs = jdbc.query(
            "SELECT runtime_spec_json FROM project WHERE id = ?",
            (rs, row) -> rs.getString("runtime_spec_json"), projectId);
        if (specs.isEmpty()) {
            return ProjectRuntimeSpec.console();
        }
        return ProjectRuntimeSpec.parse(specs.get(0));
    }

    @Override public void setEndpointState(String projectId, String state) {
        jdbc.update("UPDATE project SET endpoint_state = ? WHERE id = ?", state, projectId);
    }

    /** Current endpoint application state for a project; NULL/absent reads as NONE. */
    public String endpointState(String projectId) {
        List<String> states = jdbc.query(
            "SELECT endpoint_state FROM project WHERE id = ?",
            (rs, row) -> rs.getString(1), projectId);
        return states.isEmpty() || states.get(0) == null || states.get(0).isBlank()
            ? "NONE" : states.get(0);
    }

    @Override public List<PendingEndpoint> projectsWithUnknownEndpoint() {
        return jdbc.query("""
                SELECT id, owner_id, runtime_spec_json FROM project
                WHERE state = 'CREATING' AND endpoint_state = 'UNKNOWN'
                ORDER BY created_at, id
                """,
            (rs, row) -> new PendingEndpoint(rs.getString("id"), rs.getString("owner_id"),
                ProjectRuntimeSpec.parse(rs.getString("runtime_spec_json"))));
    }

    @Override public void rememberStorage(String projectId, StorageBinding binding) {
        jdbc.update("""
                INSERT INTO project_storage_binding(project_id, purpose, pvc_name, pvc_uid, pv_name, pv_uid)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE pvc_name = VALUES(pvc_name), pvc_uid = VALUES(pvc_uid),
                    pv_name = VALUES(pv_name), pv_uid = VALUES(pv_uid)
                """,
            projectId, binding.purpose(), binding.pvcName(), binding.pvcUid(),
            binding.pvName(), binding.pvUid());
    }

    @Override public List<StorageBinding> storageBindings(String projectId) {
        return jdbc.query("""
                SELECT purpose, pvc_name, pvc_uid, pv_name, pv_uid
                FROM project_storage_binding WHERE project_id = ? ORDER BY purpose
                """,
            (rs, row) -> new StorageBinding(rs.getString("purpose"), rs.getString("pvc_name"),
                rs.getString("pvc_uid"), rs.getString("pv_name"), rs.getString("pv_uid")),
            projectId);
    }
}
