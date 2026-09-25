package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.api.GlobalExceptionHandler;
import com.manao.poc4.kubernetes.PublicEndpointGateway;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import io.fabric8.kubernetes.api.model.EnvVar;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/**
 * HTTP contract for keyed project creation: the exact user-selected public ports are applied
 * before any workspace work starts, deterministic conflicts cancel the temporary row, and a
 * lost response replayed with the same key never creates a second project.
 */
class ProjectCreateHttpContractTest {
    private static final Set<Integer> RESERVED = Set.of(30080);
    private static final Instant NOW = Instant.parse("2026-09-21T00:00:00Z");

    private JdbcStoreTestSupport db;
    private JdbcTemplate jdbc;
    private String ownerId;
    private FakePublicEndpoints endpoints;

    @BeforeEach
    void setUp() {
        db = JdbcStoreTestSupport.create();
        jdbc = db.jdbc();
        endpoints = new FakePublicEndpoints();
        ownerId = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, 'hash', ?)",
            ownerId, "create-owner-" + ownerId, Timestamp.from(NOW));
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void reservedPublicPortIsRejectedBeforeAnyRowIsWritten() throws Exception {
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30080)))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("PUBLIC_PORT_RESERVED"))
            .andExpect(jsonPath("$.message").value("Public port is reserved. Choose another port."));
        assertThat(endpoints.projectIds).isEmpty();
        assertThat(projectCount()).isZero();
        // The rejection freed nothing because nothing was consumed: the owner keeps full quota.
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-2", 30081)))
            .andExpect(status().isCreated());
        assertThat(projectCount()).isEqualTo(1);
    }

    @Test
    void deterministicPortConflictCancelsTheTemporaryRowAndReleasesQuota() throws Exception {
        // Preflight green, then the Service create hits the allocation conflict: the API
        // server stays the final judge of the race between the two steps.
        endpoints.result = PublicEndpointGateway.ApplyResult.CONFLICT;
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081)))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("PUBLIC_PORT_IN_USE"))
            .andExpect(jsonPath("$.message").value("Public port is already in use. Choose another port."));
        // The read-only preflight ran once, before the row; the conflict was still decided
        // only by the create attempt.
        assertThat(endpoints.preflightCalls).hasSize(1);
        // The user's exact ports were applied once; no substitution or retry with other ports.
        assertThat(endpoints.calls).hasSize(1);
        assertThat(endpoints.calls.get(0).get(0).publicPort()).isEqualTo(30081);
        assertThat(projectCount()).isZero();
        // Quota is available again: the cancelled attempt does not count against the limit.
        endpoints.result = PublicEndpointGateway.ApplyResult.CONFIRMED;
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-2", 30082)))
            .andExpect(status().isCreated());
    }

    @Test
    void anOccupiedNodePortIsRejectedBeforeAnyRowOrApplicationAttempt() throws Exception {
        endpoints.preflightResult = PublicEndpointGateway.PreflightResult.IN_USE;
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081)))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("PUBLIC_PORT_IN_USE"))
            .andExpect(jsonPath("$.message").value("Public port is already in use. Choose another port."));
        // The preflight observed the exact requested group once; no project row was inserted
        // and the Service application was never attempted.
        assertThat(endpoints.preflightCalls).hasSize(1);
        assertThat(endpoints.preflightCalls.get(0).get(0).publicPort()).isEqualTo(30081);
        assertThat(endpoints.calls).isEmpty();
        assertThat(projectCount()).isZero();
        // Nothing was consumed by the rejection: the owner keeps the full quota.
        endpoints.preflightResult = PublicEndpointGateway.PreflightResult.AVAILABLE;
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-2", 30082)))
            .andExpect(status().isCreated());
    }

    @Test
    void anUncertainPreflightFailsClosedBeforeTheInsertWithoutClaimingOccupancy() throws Exception {
        endpoints.preflightResult = PublicEndpointGateway.PreflightResult.UNKNOWN;
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081)))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("PUBLIC_PORT_PREFLIGHT_UNAVAILABLE"))
            .andExpect(jsonPath("$.message")
                .value("Public port availability cannot be verified right now. Try again later."));
        // Fail closed: no row, no Service create, no quota consumption, no occupancy claim.
        assertThat(endpoints.calls).isEmpty();
        assertThat(projectCount()).isZero();
    }

    @Test
    void aKeyedReplayNeverMistakesItsOwnServiceForANewConflict() throws Exception {
        String firstId = mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081)))
            .andExpect(status().isCreated())
            .andReturn().getResponse().getContentAsString();
        String projectId = new ObjectMapper().readTree(firstId).path("id").asText();

        // The project's own Service now occupies 30081, exactly what a naive cluster-wide
        // preflight would report. The replay resolves the keyed identity instead.
        endpoints.preflightResult = PublicEndpointGateway.PreflightResult.IN_USE;
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081)))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.id").value(projectId));
        // The only preflight ever run was the original creation's: the replay added none.
        assertThat(endpoints.preflightCalls).hasSize(1);
        assertThat(projectCount()).isEqualTo(1);
    }

    @Test
    void aKeyedReplayWithADifferentDigestStillReportsTheRequestMismatch() throws Exception {
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081)))
            .andExpect(status().isCreated());
        endpoints.preflightResult = PublicEndpointGateway.PreflightResult.IN_USE;
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30082)))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("CREATE_REQUEST_MISMATCH"));
        assertThat(projectCount()).isEqualTo(1);
    }

    @Test
    void aLostResponseRetriedWithTheSameKeyAndDigestKeepsOneProject() throws Exception {
        String firstId = mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081)))
            .andExpect(status().isCreated())
            .andReturn().getResponse().getContentAsString();
        String firstProjectId = new ObjectMapper().readTree(firstId).path("id").asText();

        String secondId = mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081)))
            .andExpect(status().isCreated())
            .andReturn().getResponse().getContentAsString();

        assertThat(new ObjectMapper().readTree(secondId).path("id").asText()).isEqualTo(firstProjectId);
        assertThat(projectCount()).isEqualTo(1);
        // The stable application is reused, never re-requested under a different identity.
        assertThat(endpoints.projectIds).containsOnly(firstProjectId);
    }

    @Test
    void sameKeyWithADifferentDigestIsRejected() throws Exception {
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081)))
            .andExpect(status().isCreated());
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30082)))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("CREATE_REQUEST_MISMATCH"));
        assertThat(projectCount()).isEqualTo(1);
    }

    @Test
    void anUnknownOutcomeKeepsTheCreatingRecordQueryable() throws Exception {
        endpoints.result = PublicEndpointGateway.ApplyResult.UNKNOWN;
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081)))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.state").value("CREATING"));
        assertThat(projectCount()).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT endpoint_state FROM project WHERE creation_key = ?", String.class, "key-1"))
            .isEqualTo("UNKNOWN");

        mvc().perform(get("/api/v1/projects/creation/key-1").principal(owner()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.state").value("CREATING"));
    }

    @Test
    void aConfirmedApplicationRecordsTheAssignedState() throws Exception {
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081)))
            .andExpect(status().isCreated());
        assertThat(jdbc.queryForObject(
            "SELECT endpoint_state FROM project WHERE creation_key = ?", String.class, "key-1"))
            .isEqualTo("ASSIGNED");
    }

    @Test
    void creationQueryIsOwnerScoped() throws Exception {
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081)))
            .andExpect(status().isCreated());
        mvc().perform(get("/api/v1/projects/creation/key-1")
                .principal(new TestingAuthenticationToken(UUID.randomUUID().toString(), "unused")))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("ENTRY_NOT_FOUND"));
    }

    @Test
    void legacyNameOnlyRequestMapsToTheConsoleTemplate() throws Exception {
        String body = mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json").content("{\"name\":\"plain\"}"))
            .andExpect(status().isCreated())
            .andReturn().getResponse().getContentAsString();
        String projectId = new ObjectMapper().readTree(body).path("id").asText();
        assertThat(endpoints.calls).isEmpty();
        // Legacy NULL JSON reads back as the console spec through the runtime store.
        assertThat(new JdbcProjectRuntimeStore(jdbc).loadSpec(projectId))
            .isEqualTo(ProjectRuntimeSpec.console());
    }

    @Test
    void aFailedRollbackStaysObservableAndIsHandedToTheRecoveryScan() throws Exception {
        ch.qos.logback.classic.Logger logger = (ch.qos.logback.classic.Logger)
            org.slf4j.LoggerFactory.getLogger(ProjectController.class);
        // The level must be set explicitly: an earlier context test can leave root at OFF, which
        // would silently swallow the event (same pattern as WorkspaceOperationDiagnosticsTest).
        ch.qos.logback.classic.Level previousLevel = logger.getLevel();
        logger.setLevel(ch.qos.logback.classic.Level.WARN);
        var logs = new ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent>();
        logs.start();
        logger.addAppender(logs);
        try {
            // The rollback itself is lost (the delete fails like a broken store): the user must
            // still get the conflict answer, and the surviving row must not hold quota silently.
            ProjectService failingRollback = new ProjectService(new FailingRollbackStore(jdbc));
            endpoints.result = PublicEndpointGateway.ApplyResult.CONFLICT;
            MockMvc mvc = MockMvcBuilders.standaloneSetup(
                    new ProjectController(failingRollback, null, null, endpoints,
                        new JdbcProjectRuntimeStore(jdbc), RESERVED))
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();

            mvc.perform(post("/api/v1/projects").principal(owner())
                    .contentType("application/json")
                    .content(request("key-1", 30081)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("PUBLIC_PORT_IN_USE"))
                .andExpect(jsonPath("$.message").value("Public port is already in use. Choose another port."));

            String projectId = jdbc.queryForObject(
                "SELECT id FROM project WHERE creation_key = ?", String.class, "key-1");
            assertThat(projectCount()).isEqualTo(1);
            // Endpoint-unknown puts the surviving row on the startup recovery scan's radar.
            assertThat(jdbc.queryForObject(
                "SELECT endpoint_state FROM project WHERE creation_key = ?", String.class, "key-1"))
                .isEqualTo("UNKNOWN");
            // The log names the stuck attempt so the dead-end is diagnosable before a restart.
            assertThat(logs.list).hasSize(1);
            assertThat(logs.list.get(0).getFormattedMessage())
                .contains("projectId=" + projectId, "creationKey=key-1");
        } finally {
            logger.detachAppender(logs);
            logs.stop();
            logger.setLevel(previousLevel);
        }
    }

    @Test
    void invalidInternalPortValuesNeverReachTheStore() throws Exception {
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081, 0)))
            .andExpect(status().isUnprocessableEntity())
            .andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        assertThat(projectCount()).isZero();
        assertThat(endpoints.calls).isEmpty();
    }

    private TestingAuthenticationToken owner() {
        return new TestingAuthenticationToken(ownerId, "unused");
    }

    /** Web template request with a single public mapping on the given nodePort. */
    private static String request(String creationKey, int publicPort) {
        return request(creationKey, publicPort, 8080);
    }

    private static String request(String creationKey, int publicPort, int targetPort) {
        ObjectNode root = new ObjectMapper().createObjectNode();
        root.put("name", "orders-demo");
        root.put("creationKey", creationKey);
        root.put("templateId", ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB);
        root.put("mysql", true);
        root.put("redis", false);
        ArrayNode ports = root.putArray("publicPorts");
        ObjectNode port = ports.addObject();
        port.put("name", "web");
        port.put("targetPort", targetPort);
        port.put("publicPort", publicPort);
        return root.toString();
    }

    private int projectCount() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM project", Integer.class);
    }

    private MockMvc mvc() {
        ProjectService projects = new ProjectService(jdbc,
            new DataSourceTransactionManager(jdbc.getDataSource()));
        return MockMvcBuilders.standaloneSetup(
                new ProjectController(projects, null, null, endpoints,
                    new JdbcProjectRuntimeStore(jdbc), RESERVED))
            .setControllerAdvice(new GlobalExceptionHandler())
            .build();
    }

    /** Runtime-aware controller: the browser view carries runtime, endpoint and dependency facts. */
    private MockMvc runtimeMvc(FakeProjectDependencies dependencies) {
        ProjectService projects = new ProjectService(jdbc,
            new DataSourceTransactionManager(jdbc.getDataSource()));
        return MockMvcBuilders.standaloneSetup(
                new ProjectController(projects, null, null, endpoints,
                    new JdbcProjectRuntimeStore(jdbc), dependencies, RESERVED, "entry.example"))
            .setControllerAdvice(new GlobalExceptionHandler())
            .build();
    }

    @Test
    void runtimeViewExposesRuntimeEndpointStateDependenciesAndEndpoints() throws Exception {
        FakeProjectDependencies dependencies = new FakeProjectDependencies();
        MockMvc mvc = runtimeMvc(dependencies);
        mvc.perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081)))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.runtime.templateId").value("java-spring-boot-web"))
            .andExpect(jsonPath("$.runtime.mysql").value(true))
            .andExpect(jsonPath("$.runtime.redis").value(false))
            .andExpect(jsonPath("$.runtime.publicPorts[0].name").value("web"))
            .andExpect(jsonPath("$.runtime.publicPorts[0].targetPort").value(8080))
            .andExpect(jsonPath("$.runtime.publicPorts[0].publicPort").value(30081))
            .andExpect(jsonPath("$.endpointState").value("ASSIGNED"))
            .andExpect(jsonPath("$.dependencies.mysql").value("PROVISIONING"))
            .andExpect(jsonPath("$.dependencies.redis").value("ABSENT"))
            .andExpect(jsonPath("$.endpoints[0].name").value("web"))
            .andExpect(jsonPath("$.endpoints[0].targetPort").value(8080))
            .andExpect(jsonPath("$.endpoints[0].publicPort").value(30081))
            .andExpect(jsonPath("$.endpoints[0].url").value("http://entry.example:30081"));

        // The detail view follows the live dependency status; the assigned endpoint stays stable.
        dependencies.mysql = ProjectDependencies.READY;
        mvc.perform(get("/api/v1/projects/creation/key-1").principal(owner()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.endpointState").value("ASSIGNED"))
            .andExpect(jsonPath("$.dependencies.mysql").value("READY"))
            .andExpect(jsonPath("$.dependencies.redis").value("ABSENT"))
            .andExpect(jsonPath("$.endpoints[0].url").value("http://entry.example:30081"));
        mvc.perform(get("/api/v1/projects/prj-lookup").principal(owner()))
            .andExpect(status().isNotFound());

        // The list view carries the same non-sensitive facts without leaking resources.
        String list = mvc.perform(get("/api/v1/projects").principal(owner()))
            .andExpect(status().isOk())
            .andReturn().getResponse().getContentAsString();
        assertThat(list).contains("\"endpointState\":\"ASSIGNED\"");
        assertThat(list).contains("\"dependencies\":{\"mysql\":\"READY\",\"redis\":\"ABSENT\"}");
        assertThat(list).contains("http://entry.example:30081");
        assertThat(list.toLowerCase())
            .doesNotContain("secret").doesNotContain("pvc").doesNotContain("statefulset");
        // The dependency status was resolved only for the project that selected dependencies.
        assertThat(dependencies.statusCalls).hasSize(1);
    }

    @Test
    void legacyConsoleViewHasNoRuntimeStateOrEndpoints() throws Exception {
        MockMvc mvc = runtimeMvc(new FakeProjectDependencies());
        mvc.perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content("{\"name\":\"plain-console\"}"))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.runtime.templateId").value("java-console"))
            .andExpect(jsonPath("$.runtime.mysql").value(false))
            .andExpect(jsonPath("$.runtime.redis").value(false))
            .andExpect(jsonPath("$.runtime.publicPorts").isEmpty())
            .andExpect(jsonPath("$.endpointState").value("NONE"))
            .andExpect(jsonPath("$.dependencies.mysql").value("ABSENT"))
            .andExpect(jsonPath("$.dependencies.redis").value("ABSENT"))
            .andExpect(jsonPath("$.endpoints").isEmpty());
    }

    /** Scriptable gateway fake recording every preflight and application attempt. */
    private static final class FakePublicEndpoints implements PublicEndpointGateway {
        ApplyResult result = ApplyResult.CONFIRMED;
        PublicEndpointGateway.PreflightResult preflightResult = PublicEndpointGateway.PreflightResult.AVAILABLE;
        final List<String> projectIds = new ArrayList<>();
        final List<List<ProjectRuntimeSpec.Port>> calls = new ArrayList<>();
        final List<List<ProjectRuntimeSpec.Port>> preflightCalls = new ArrayList<>();

        @Override public PublicEndpointGateway.PreflightResult checkNodePortsAvailable(
                List<ProjectRuntimeSpec.Port> ports) {
            preflightCalls.add(ports);
            return preflightResult;
        }

        @Override public ApplyResult ensure(String projectId, List<ProjectRuntimeSpec.Port> ports) {
            projectIds.add(projectId);
            calls.add(ports);
            return result;
        }

        @Override public void routeToRun(String projectId, String runId, String podUid) { }

        @Override public void withdraw(String projectId) { }
    }

    /** Scriptable dependency status: PROVISIONING until a test promotes the project. */
    private static final class FakeProjectDependencies implements ProjectDependencies {
        String mysql = ProjectDependencies.PROVISIONING;
        String redis = ProjectDependencies.ABSENT;
        final Set<String> statusCalls = new HashSet<>();

        @Override public void ensure(String projectId, ProjectRuntimeSpec spec) { }

        @Override public DependencyStatus status(String projectId, ProjectRuntimeSpec spec) {
            statusCalls.add(projectId);
            return new DependencyStatus(
                spec.mysql() ? mysql : ABSENT,
                spec.redis() ? redis : ABSENT);
        }

        @Override public List<EnvVar> applicationEnvironment(String projectId, ProjectRuntimeSpec spec) {
            return List.of();
        }
    }

    /**
     * JdbcStore mirror for the rollback scenario: creation works exactly like the real keyed
     * insert, but the row removal fails like a broken store would.
     */
    private static final class FailingRollbackStore implements ProjectService.RuntimeStore {
        private final JdbcTemplate jdbc;

        FailingRollbackStore(JdbcTemplate jdbc) { this.jdbc = jdbc; }

        @Override public List<ProjectService.Project> listForOwner(String ownerId) { return List.of(); }

        @Override public boolean create(String id, String ownerId, String name) {
            return create(id, ownerId, name, null, ProjectRuntimeSpec.console());
        }

        @Override public boolean create(String id, String ownerId, String name, String creationKey,
                                        ProjectRuntimeSpec runtime) {
            return jdbc.update("INSERT INTO project(id, owner_id, name, state, workspace_revision, "
                    + "failure_reason, runtime_spec_json, creation_key, creation_digest, endpoint_state, "
                    + "created_at, updated_at) VALUES (?, ?, ?, 'CREATING', 0, NULL, ?, ?, ?, 'NONE', ?, ?)",
                id, ownerId, name, runtime.toJson(), creationKey, runtime.creationDigest(),
                Timestamp.from(Instant.now()), Timestamp.from(Instant.now())) == 1;
        }

        @Override public boolean matchesDigest(String ownerId, String creationKey, String digest) {
            List<String> digests = jdbc.query(
                "SELECT creation_digest FROM project WHERE owner_id = ? AND creation_key = ?",
                (rs, row) -> rs.getString(1), ownerId, creationKey);
            return digests.isEmpty() || digest.equals(digests.get(0));
        }

        @Override public java.util.Optional<ProjectService.Project> findCreation(String ownerId, String creationKey) {
            List<ProjectService.Project> found = jdbc.query(
                "SELECT id, owner_id, name, state, created_at, failure_reason FROM project "
                    + "WHERE owner_id = ? AND creation_key = ?",
                (rs, row) -> new ProjectService.Project(rs.getString("id"), rs.getString("owner_id"),
                    rs.getString("name"), rs.getString("state"), rs.getTimestamp("created_at").toInstant(),
                    rs.getString("failure_reason")),
                ownerId, creationKey);
            return found.isEmpty() ? java.util.Optional.empty() : java.util.Optional.of(found.get(0));
        }

        @Override public boolean deleteProjectRow(String ownerId, String projectId) {
            throw new IllegalStateException("rollback lost");
        }

        @Override public ProjectService.Project findForOwner(String ownerId, String projectId) {
            List<ProjectService.Project> found = jdbc.query(
                "SELECT id, owner_id, name, state, created_at, failure_reason FROM project "
                    + "WHERE id = ? AND owner_id = ?",
                (rs, row) -> new ProjectService.Project(rs.getString("id"), rs.getString("owner_id"),
                    rs.getString("name"), rs.getString("state"), rs.getTimestamp("created_at").toInstant(),
                    rs.getString("failure_reason")),
                projectId, ownerId);
            return found.isEmpty() ? null : found.get(0);
        }
    }
}
