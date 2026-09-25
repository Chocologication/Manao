package com.manao.poc4.project;

import com.manao.poc4.api.ApiException;
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

    /** Legacy name-only creation maps to the console template without dependencies or ports. */
    public java.util.Optional<Project> create(String ownerId, String name) {
        return create(ownerId, name, null, ProjectRuntimeSpec.console());
    }

    /**
     * Creation key, digest and runtime config are written inside the existing project INSERT
     * transaction; the configuration is never saved as a second, separate step. The same key
     * with the same digest replays the same project (a lost response is retried); the same key
     * with a different digest is a {@code CREATE_REQUEST_MISMATCH}.
     */
    public java.util.Optional<Project> create(String ownerId, String name, String creationKey,
                                              ProjectRuntimeSpec runtime) {
        if (creationKey != null) {
            Project replayed = findCreation(ownerId, creationKey).orElse(null);
            if (replayed != null) {
                if (store instanceof RuntimeStore runtimeStore
                    && !runtimeStore.matchesDigest(ownerId, creationKey, runtime.creationDigest())) {
                    throw new ApiException("CREATE_REQUEST_MISMATCH", 409,
                        "Creation request does not match the original request");
                }
                return java.util.Optional.of(replayed);
            }
        }
        String id = UUID.randomUUID().toString();
        if (store instanceof RuntimeStore runtimeStore) {
            return runtimeStore.create(id, ownerId, name, creationKey, runtime)
                ? java.util.Optional.ofNullable(store.findForOwner(ownerId, id))
                : java.util.Optional.empty();
        }
        return store.create(id, ownerId, name)
            ? java.util.Optional.ofNullable(store.findForOwner(ownerId, id))
            : java.util.Optional.empty();
    }

    /** Owner-scoped lookup of a keyed creation attempt; other owners' keys are invisible. */
    public java.util.Optional<Project> findCreation(String ownerId, String creationKey) {
        if (store instanceof RuntimeStore runtimeStore) {
            return runtimeStore.findCreation(ownerId, creationKey);
        }
        return java.util.Optional.empty();
    }

    /**
     * Cancels a rejected creation attempt by removing its temporary row. Only succeeds for the
     * owning user and only for the caller-verified project identity; returns false when the
     * row is already gone or not owned by this user.
     */
    public boolean deleteProjectRow(String ownerId, String projectId) {
        if (store instanceof RuntimeStore runtimeStore) {
            return runtimeStore.deleteProjectRow(ownerId, projectId);
        }
        return false;
    }

    public interface Store {
        List<Project> listForOwner(String ownerId);
        boolean create(String id, String ownerId, String name);
        Project findForOwner(String ownerId, String projectId);
    }

    /** Store with runtime-aware creation; used by the JDBC implementation. */
    public interface RuntimeStore extends Store {
        boolean create(String id, String ownerId, String name, String creationKey, ProjectRuntimeSpec runtime);

        boolean matchesDigest(String ownerId, String creationKey, String digest);

        java.util.Optional<Project> findCreation(String ownerId, String creationKey);

        /** Removes one owner-scoped temporary creation row; false when absent or foreign. */
        boolean deleteProjectRow(String ownerId, String projectId);
    }

    public record Project(String id, String ownerId, String name, String state,
                          Instant createdAt, String failureReason) {}

    private static final class JdbcStore implements RuntimeStore {
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
            return create(id, ownerId, name, null, ProjectRuntimeSpec.console());
        }

        @Override public boolean create(String id, String ownerId, String name, String creationKey, ProjectRuntimeSpec runtime) {
            Boolean created = transaction.execute(status -> {
                List<String> owners = jdbc.query("SELECT id FROM app_user WHERE id = ? FOR UPDATE", (rs, row) -> rs.getString(1), ownerId);
                if (owners.isEmpty()) return false;
                Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM project WHERE owner_id = ?", Integer.class, ownerId);
                if (count != null && count >= ProjectLimits.MAX_PROJECTS_PER_OWNER) return false;
                Instant now = Instant.now();
                if (creationKey == null) {
                    return jdbc.update("INSERT INTO project(id, owner_id, name, state, workspace_revision, failure_reason, created_at, updated_at) VALUES (?, ?, ?, 'CREATING', 0, NULL, ?, ?)",
                        id, ownerId, name, Timestamp.from(now), Timestamp.from(now)) == 1;
                }
                // A duplicate (owner_id, creation_key) violates uq_project_creation and fails atomically.
                try {
                    return jdbc.update("INSERT INTO project(id, owner_id, name, state, workspace_revision, failure_reason, runtime_spec_json, creation_key, creation_digest, endpoint_state, created_at, updated_at) VALUES (?, ?, ?, 'CREATING', 0, NULL, ?, ?, ?, 'NONE', ?, ?)",
                        id, ownerId, name, runtime.toJson(), creationKey, runtime.creationDigest(),
                        Timestamp.from(now), Timestamp.from(now)) == 1;
                } catch (org.springframework.dao.DuplicateKeyException ex) {
                    return false;
                }
            });
            return Boolean.TRUE.equals(created);
        }

        @Override public boolean matchesDigest(String ownerId, String creationKey, String digest) {
            List<String> digests = jdbc.query(
                "SELECT creation_digest FROM project WHERE owner_id = ? AND creation_key = ?",
                (rs, row) -> rs.getString(1), ownerId, creationKey);
            return digests.isEmpty() || digest.equals(digests.get(0));
        }

        @Override public java.util.Optional<Project> findCreation(String ownerId, String creationKey) {
            List<Project> projects = jdbc.query(
                "SELECT id, owner_id, name, state, created_at, failure_reason FROM project WHERE owner_id = ? AND creation_key = ?",
                (rs, row) -> map(rs.getString("id"), rs.getString("owner_id"), rs.getString("name"), rs.getString("state"), rs.getTimestamp("created_at"), rs.getString("failure_reason")),
                ownerId, creationKey);
            return projects.isEmpty() ? java.util.Optional.empty() : java.util.Optional.of(projects.get(0));
        }

        @Override public boolean deleteProjectRow(String ownerId, String projectId) {
            return jdbc.update("DELETE FROM project WHERE id = ? AND owner_id = ?",
                projectId, ownerId) == 1;
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
