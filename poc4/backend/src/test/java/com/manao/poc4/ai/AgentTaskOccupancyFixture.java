package com.manao.poc4.ai;

import com.manao.poc4.ai.AgentContracts.TaskRequest;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.project.AgentTaskOccupancy;
import java.sql.Timestamp;
import java.time.Clock;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

/**
 * Real-store occupancy fixture for entry-point tests: the production {@link AgentTaskStore}
 * on a disposable schema, armed and released by registering and settling an actual task row.
 * Entry services wired with {@link #occupancy()} refuse their writes while the fixture holds
 * a task and work again after {@link #release} — so removing a production guard call makes
 * those tests fail instead of silently passing. This is never a bypass stand-in: the same
 * class implements the occupancy the production beans inject.
 */
public final class AgentTaskOccupancyFixture implements AutoCloseable {
    private final JdbcStoreTestSupport database;
    private final JdbcTemplate jdbc;
    private final AgentTaskStore store;
    private final String ownerId;
    private final String projectId;
    private final long revision;

    private AgentTaskOccupancyFixture(String projectId, String ownerId, long revision) {
        this.database = JdbcStoreTestSupport.create();
        this.jdbc = database.jdbc();
        this.ownerId = ownerId;
        this.projectId = projectId;
        this.revision = revision;
        Timestamp now = new Timestamp(System.currentTimeMillis());
        jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, 'unused', ?)",
            ownerId, "agent-occupancy-" + ownerId, now);
        jdbc.update("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at)"
                + " VALUES (?, ?, 'agent-occupancy-fixture', 'READY', ?, ?, ?)",
            projectId, ownerId, revision, now, now);
        this.store = new AgentTaskStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()), Clock.systemUTC());
    }

    public static AgentTaskOccupancyFixture open(String projectId, String ownerId, long revision) {
        return new AgentTaskOccupancyFixture(projectId, ownerId, revision);
    }

    /** The occupancy instance wired into the entry services under test. */
    public AgentTaskOccupancy occupancy() {
        return store;
    }

    /** Registers a real QUEUED task; the project's writes stay locked until release. */
    public String occupy(String prompt) {
        String taskId = UUID.randomUUID().toString();
        store.create(ownerId, projectId, new TaskRequest(taskId, prompt, revision));
        return taskId;
    }

    /** Settles the task COMPLETED so every entry point is writable again. */
    public void release(String taskId) {
        jdbc.update("UPDATE agent_task SET state = 'COMPLETED' WHERE id = ?", taskId);
    }

    @Override public void close() {
        database.close();
    }
}
