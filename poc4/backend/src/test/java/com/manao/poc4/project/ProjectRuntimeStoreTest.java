package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

class ProjectRuntimeStoreTest {
    private static final Instant NOW = Instant.parse("2026-09-21T00:00:00Z");
    private static final Set<Integer> RESERVED = Set.of(30080);

    private static void insertOwner(JdbcTemplate jdbc, String ownerId) {
        jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, 'hash', ?)",
            ownerId, "runtime-owner-" + ownerId, Timestamp.from(NOW));
    }

    private static void insertLegacyProject(JdbcTemplate jdbc, String projectId, String ownerId) {
        jdbc.update("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at)"
                + " VALUES (?, ?, 'legacy', 'READY', 0, ?, ?)",
            projectId, ownerId, Timestamp.from(NOW), Timestamp.from(NOW));
    }

    private static ProjectRuntimeSpec webSpec() {
        return new ProjectRuntimeSpec(ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, true, false, List.of(
            new ProjectRuntimeSpec.Port("web", 8080, 30081),
            new ProjectRuntimeSpec.Port("api2", 9090, 30082)));
    }

    @Test
    void legacyNullJsonReadsAsConsoleWithoutDependenciesOrPorts() {
        try (var db = JdbcStoreTestSupport.create()) {
            JdbcTemplate jdbc = db.jdbc();
            String ownerId = UUID.randomUUID().toString();
            String projectId = UUID.randomUUID().toString();
            insertOwner(jdbc, ownerId);
            insertLegacyProject(jdbc, projectId, ownerId);
            var store = new JdbcProjectRuntimeStore(jdbc);
            assertThat(store.loadSpec(projectId)).isEqualTo(ProjectRuntimeSpec.console());
            assertThat(store.loadSpec("missing-project")).isEqualTo(ProjectRuntimeSpec.console());
        }
    }

    @Test
    void savedSpecRoundTripsPreservingPortOrderAndDependencies() {
        try (var db = JdbcStoreTestSupport.create()) {
            JdbcTemplate jdbc = db.jdbc();
            String ownerId = UUID.randomUUID().toString();
            insertOwner(jdbc, ownerId);
            var service = new ProjectService(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()));
            var runtime = webSpec();
            String creationKey = UUID.randomUUID().toString();
            var created = service.create(ownerId, "orders-demo", creationKey, runtime);
            assertThat(created).isPresent();
            String projectId = created.get().id();
            assertThat(jdbc.queryForObject(
                "SELECT creation_key FROM project WHERE id = ?", String.class, projectId)).isEqualTo(creationKey);
            assertThat(jdbc.queryForObject(
                "SELECT creation_digest FROM project WHERE id = ?", String.class, projectId))
                .isEqualTo(runtime.creationDigest());
            assertThat(jdbc.queryForObject(
                "SELECT endpoint_state FROM project WHERE id = ?", String.class, projectId)).isEqualTo("NONE");

            var store = new JdbcProjectRuntimeStore(jdbc);
            ProjectRuntimeSpec loaded = store.loadSpec(projectId);
            assertThat(loaded).isEqualTo(runtime);
            assertThat(loaded.publicPorts()).containsExactlyElementsOf(runtime.publicPorts());
            assertThat(loaded.primaryPort()).isEqualTo(8080);
            assertThat(loaded.mysql()).isTrue();
            assertThat(loaded.redis()).isFalse();
        }
    }

    @Test
    void sameCreationKeyCannotCreateSecondProjectForSameOwner() {
        try (var db = JdbcStoreTestSupport.create()) {
            JdbcTemplate jdbc = db.jdbc();
            String ownerId = UUID.randomUUID().toString();
            insertOwner(jdbc, ownerId);
            var service = new ProjectService(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()));
            String creationKey = UUID.randomUUID().toString();
            assertThat(service.create(ownerId, "first", creationKey, webSpec())).isPresent();
            assertThat(service.create(ownerId, "second", creationKey, webSpec())).isEmpty();
            assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM project WHERE owner_id = ?", Integer.class, ownerId)).isEqualTo(1);
            // The unique index is owner-scoped: another owner may reuse the same creation key.
            String otherOwner = UUID.randomUUID().toString();
            insertOwner(jdbc, otherOwner);
            assertThat(service.create(otherOwner, "other", creationKey, webSpec())).isPresent();
        }
    }

    @Test
    void legacyNameOnlyCreationStillWorks() {
        try (var db = JdbcStoreTestSupport.create()) {
            JdbcTemplate jdbc = db.jdbc();
            String ownerId = UUID.randomUUID().toString();
            insertOwner(jdbc, ownerId);
            var service = new ProjectService(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()));
            assertThat(service.create(ownerId, "plain")).isPresent();
        }
    }

    @Test
    void updatesEndpointState() {
        try (var db = JdbcStoreTestSupport.create()) {
            JdbcTemplate jdbc = db.jdbc();
            String ownerId = UUID.randomUUID().toString();
            String projectId = UUID.randomUUID().toString();
            insertOwner(jdbc, ownerId);
            insertLegacyProject(jdbc, projectId, ownerId);
            var store = new JdbcProjectRuntimeStore(jdbc);
            assertThat(jdbc.queryForObject(
                "SELECT endpoint_state FROM project WHERE id = ?", String.class, projectId)).isEqualTo("NONE");
            store.setEndpointState(projectId, "ASSIGNED");
            assertThat(jdbc.queryForObject(
                "SELECT endpoint_state FROM project WHERE id = ?", String.class, projectId)).isEqualTo("ASSIGNED");
        }
    }

    @Test
    void remembersWorkspaceAndMysqlBindingsWithoutDuplication() {
        try (var db = JdbcStoreTestSupport.create()) {
            JdbcTemplate jdbc = db.jdbc();
            String ownerId = UUID.randomUUID().toString();
            String projectId = UUID.randomUUID().toString();
            insertOwner(jdbc, ownerId);
            insertLegacyProject(jdbc, projectId, ownerId);
            var store = new JdbcProjectRuntimeStore(jdbc);
            store.rememberStorage(projectId,
                new ProjectRuntimeStore.StorageBinding("WORKSPACE", "manao-ws-pvc-" + projectId, "uid-ws", "pv-ws", "pvuid-ws"));
            store.rememberStorage(projectId,
                new ProjectRuntimeStore.StorageBinding("MYSQL", "manao-mysql-pvc-" + projectId, "uid-mysql", "pv-mysql", "pvuid-mysql"));
            assertThat(store.storageBindings(projectId)).hasSize(2);
            assertThat(store.storageBindings(projectId))
                .extracting(ProjectRuntimeStore.StorageBinding::purpose)
                .containsExactly("MYSQL", "WORKSPACE");
            // Remembering the same purpose again updates the binding instead of failing.
            store.rememberStorage(projectId,
                new ProjectRuntimeStore.StorageBinding("WORKSPACE", "manao-ws-pvc-" + projectId, "uid-ws-2", "pv-ws-2", "pvuid-ws-2"));
            assertThat(store.storageBindings(projectId)).hasSize(2);
            assertThat(store.storageBindings(projectId))
                .filteredOn(binding -> "WORKSPACE".equals(binding.purpose()))
                .allSatisfy(binding -> {
                    assertThat(binding.pvcUid()).isEqualTo("uid-ws-2");
                    assertThat(binding.pvName()).isEqualTo("pv-ws-2");
                });
            assertThatThrownBy(() -> jdbc.update(
                "INSERT INTO project_storage_binding(project_id, purpose, pvc_name) VALUES (?, 'REDIS', 'x')", projectId))
                .isInstanceOfAny(SQLException.class, DataAccessException.class);
        }
    }

    @Test
    void bindingsAreDeletedWithTheirProject() {
        try (var db = JdbcStoreTestSupport.create()) {
            JdbcTemplate jdbc = db.jdbc();
            String ownerId = UUID.randomUUID().toString();
            String projectId = UUID.randomUUID().toString();
            insertOwner(jdbc, ownerId);
            insertLegacyProject(jdbc, projectId, ownerId);
            var store = new JdbcProjectRuntimeStore(jdbc);
            store.rememberStorage(projectId,
                new ProjectRuntimeStore.StorageBinding("WORKSPACE", "manao-ws-pvc-" + projectId, "uid-ws", "pv-ws", "pvuid-ws"));
            jdbc.update("DELETE FROM project WHERE id = ?", projectId);
            assertThat(store.storageBindings(projectId)).isEmpty();
        }
    }
}
