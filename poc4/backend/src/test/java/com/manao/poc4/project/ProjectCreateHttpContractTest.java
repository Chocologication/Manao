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
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
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
        endpoints.result = PublicEndpointGateway.ApplyResult.CONFLICT;
        mvc().perform(post("/api/v1/projects").principal(owner())
                .contentType("application/json")
                .content(request("key-1", 30081)))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("PUBLIC_PORT_IN_USE"))
            .andExpect(jsonPath("$.message").value("Public port is already in use. Choose another port."));
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

    /** Scriptable gateway fake recording every application attempt. */
    private static final class FakePublicEndpoints implements PublicEndpointGateway {
        ApplyResult result = ApplyResult.CONFIRMED;
        final List<String> projectIds = new ArrayList<>();
        final List<List<ProjectRuntimeSpec.Port>> calls = new ArrayList<>();

        @Override public ApplyResult ensure(String projectId, List<ProjectRuntimeSpec.Port> ports) {
            projectIds.add(projectId);
            calls.add(ports);
            return result;
        }

        @Override public void routeToRun(String projectId, String runId, String podUid) { }

        @Override public void withdraw(String projectId) { }
    }
}
