package com.manao.poc4.project;

import com.manao.poc4.config.SecurityConfig;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Conditional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Component
@Conditional(SecurityConfig.BackendAuthCondition.class)
public class ProjectDeletionRepository {
    public enum BeginDeletion { STARTED, RESUMED, NOT_FOUND, CREATING, ACTIVE_RUN, BUSY }

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;

    @Autowired
    public ProjectDeletionRepository(JdbcTemplate jdbc, PlatformTransactionManager transactions) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactions);
    }

    ProjectDeletionRepository() {
        this.jdbc = null;
        this.transaction = null;
    }

    public BeginDeletion inspect(String ownerId, String projectId) {
        requireConnected();
        BeginDeletion result = evaluate(ownerId, projectId, false);
        return result == null ? BeginDeletion.BUSY : result;
    }

    public BeginDeletion begin(String ownerId, String projectId) {
        requireConnected();
        BeginDeletion result = evaluate(ownerId, projectId, true);
        return result == null ? BeginDeletion.BUSY : result;
    }

    private void requireConnected() {
        if (jdbc == null || transaction == null) {
            throw new IllegalStateException("project deletion repository is not connected");
        }
    }

    public List<String> runIds(String ownerId, String projectId) {
        return jdbc.query(
            """
            SELECT r.id FROM run r INNER JOIN project p ON p.id = r.project_id
            WHERE r.project_id = ? AND p.owner_id = ? AND p.state = 'DELETING'
            ORDER BY r.created_at
            """,
            (rs, row) -> rs.getString(1), projectId, ownerId);
    }

    private BeginDeletion evaluate(String ownerId, String projectId, boolean mutate) {
        return transaction.execute(status -> {
            List<String> states = jdbc.query(
                "SELECT state FROM project WHERE id = ? AND owner_id = ? FOR UPDATE",
                (rs, row) -> rs.getString(1), projectId, ownerId);
            if (states.isEmpty()) {
                return BeginDeletion.NOT_FOUND;
            }
            String state = states.get(0);
            if ("CREATING".equals(state)) {
                return BeginDeletion.CREATING;
            }
            if ("DELETING".equals(state)) {
                return BeginDeletion.RESUMED;
            }
            if ("READY".equals(state)) {
                if (hasActiveRun(projectId)) {
                    return BeginDeletion.ACTIVE_RUN;
                }
                if (hasPendingOperation(projectId)) {
                    return BeginDeletion.BUSY;
                }
                if (mutate) {
                    stampDeleting(projectId);
                }
                return BeginDeletion.STARTED;
            }
            if ("FAILED".equals(state)) {
                if (hasActiveRun(projectId)) {
                    return BeginDeletion.ACTIVE_RUN;
                }
                if (mutate) {
                    stampDeleting(projectId);
                }
                return BeginDeletion.STARTED;
            }
            return BeginDeletion.BUSY;
        });
    }

    private boolean hasActiveRun(String projectId) {
        Integer count = jdbc.queryForObject(
            "SELECT COUNT(*) FROM run WHERE project_id = ? AND active_run_marker = 1",
            Integer.class, projectId);
        return count != null && count > 0;
    }

    private boolean hasPendingOperation(String projectId) {
        Integer count = jdbc.queryForObject(
            "SELECT COUNT(*) FROM workspace_operation WHERE project_id = ? AND state = 'PENDING'",
            Integer.class, projectId);
        return count != null && count > 0;
    }

    private void stampDeleting(String projectId) {
        jdbc.update("UPDATE project SET state = 'DELETING', updated_at = ? WHERE id = ?",
            Timestamp.from(Instant.now()), projectId);
    }
}
