package com.manao.poc4.project;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import javax.sql.DataSource;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
@org.springframework.context.annotation.Conditional(com.manao.poc4.config.SecurityConfig.BackendAuthCondition.class)
public final class ProjectService {
    private final Store store;

    public ProjectService(Store store) { this.store = store; }

    @Autowired
    public ProjectService(JdbcTemplate jdbc, PlatformTransactionManager transactions) {
        this.store = new JdbcStore(jdbc, transactions);
    }

    public List<Project> list(String ownerId) { return store.listForOwner(ownerId); }
    public java.util.Optional<Project> get(String ownerId, String projectId) {
        return java.util.Optional.ofNullable(store.findForOwner(ownerId, projectId));
    }
    public java.util.Optional<Project> create(String ownerId, String name) {
        String id = UUID.randomUUID().toString();
        return store.create(id, ownerId, name)
            ? java.util.Optional.ofNullable(store.findForOwner(ownerId, id))
            : java.util.Optional.empty();
    }

    public interface Store {
        List<Project> listForOwner(String ownerId);
        boolean create(String id, String ownerId, String name);
        Project findForOwner(String ownerId, String projectId);
    }

    public record Project(String id, String ownerId, String name, String state,
                          Instant createdAt, String failureReason) {}

    private static final class JdbcStore implements Store {
        private final JdbcTemplate jdbc;
        private final TransactionTemplate transaction;
        JdbcStore(JdbcTemplate jdbc, PlatformTransactionManager transactions) {
            this.jdbc = jdbc;
            this.transaction = new TransactionTemplate(transactions);
        }

        @Override public List<Project> listForOwner(String ownerId) {
            return jdbc.query("SELECT id, owner_id, name, state, created_at, failure_reason FROM project WHERE owner_id = ? ORDER BY created_at, id",
                (rs, row) -> map(rs.getString("id"), rs.getString("owner_id"), rs.getString("name"), rs.getString("state"), rs.getTimestamp("created_at"), rs.getString("failure_reason")), ownerId);
        }

        @Override public boolean create(String id, String ownerId, String name) {
            Boolean created = transaction.execute(status -> {
                List<String> owners = jdbc.query("SELECT id FROM app_user WHERE id = ? FOR UPDATE", (rs, row) -> rs.getString(1), ownerId);
                if (owners.isEmpty()) return false;
                Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM project WHERE owner_id = ?", Integer.class, ownerId);
                if (count != null && count >= 3) return false;
                Instant now = Instant.now();
                return jdbc.update("INSERT INTO project(id, owner_id, name, state, workspace_revision, failure_reason, created_at, updated_at) VALUES (?, ?, ?, 'CREATING', 0, NULL, ?, ?)",
                    id, ownerId, name, Timestamp.from(now), Timestamp.from(now)) == 1;
            });
            return Boolean.TRUE.equals(created);
        }

        @Override public Project findForOwner(String ownerId, String projectId) {
            List<Project> projects = jdbc.query("SELECT id, owner_id, name, state, created_at, failure_reason FROM project WHERE id = ? AND owner_id = ?",
                (rs, row) -> map(rs.getString("id"), rs.getString("owner_id"), rs.getString("name"), rs.getString("state"), rs.getTimestamp("created_at"), rs.getString("failure_reason")), projectId, ownerId);
            return projects.isEmpty() ? null : projects.get(0);
        }

        private static Project map(String id, String ownerId, String name, String state, Timestamp createdAt, String failureReason) {
            return new Project(id, ownerId, name, state, createdAt.toInstant(), failureReason);
        }
    }
}
