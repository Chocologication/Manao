package com.manao.poc4.recovery;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.kubernetes.Fabric8PublicEndpointGateway;
import com.manao.poc4.kubernetes.PublicEndpointGateway;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.project.JdbcProjectRuntimeStore;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.project.ProjectRuntimeSpec;
import com.manao.poc4.project.ProjectService;
import io.fabric8.kubernetes.api.model.Service;
import io.fabric8.kubernetes.api.model.ServiceBuilder;
import io.fabric8.kubernetes.api.model.ServicePortBuilder;
import io.fabric8.kubernetes.api.model.Status;
import io.fabric8.kubernetes.api.model.StatusBuilder;
import io.fabric8.kubernetes.api.model.StatusCauseBuilder;
import io.fabric8.kubernetes.api.model.StatusDetailsBuilder;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.server.mock.KubernetesMixedDispatcher;
import io.fabric8.kubernetes.client.server.mock.KubernetesMockServer;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

/**
 * The startup recovery scan for creations whose endpoint application never reached a verdict
 * (CREATING rows left at endpoint_state UNKNOWN). Verification reuses the create path's
 * PublicEndpointGateway semantics: an existing Service is only accepted when the project label
 * and the whole port group match, a deterministic conflict with no Service left behind cancels
 * the temporary row, and anything still undecidable keeps waiting instead of being replayed.
 */
class CreationEndpointRecoveryServiceTest {
    private static final String NS = "manao-test";
    private static final String SERVICE_PATH = "/api/v1/namespaces/" + NS + "/services";

    JdbcStoreTestSupport db;
    JdbcTemplate jdbc;
    KubernetesMockServer server;
    KubernetesClient client;
    Fabric8PublicEndpointGateway gateway;
    ProjectService projects;
    JdbcProjectRuntimeStore runtimeStore;
    List<String> provisioningCalls;
    CreationEndpointRecoveryService scan;
    String ownerId;

    @BeforeEach
    void setUp() {
        db = JdbcStoreTestSupport.create();
        jdbc = db.jdbc();
        // Same shared-responses-map fixture as PublicEndpointGatewayTest: the mixed dispatcher
        // serves injected expectations first and forwards everything else to the CRUD store.
        Map<io.fabric8.mockwebserver.ServerRequest, Queue<io.fabric8.mockwebserver.ServerResponse>>
            responses = new java.util.HashMap<>();
        server = new KubernetesMockServer(new io.fabric8.mockwebserver.Context(),
            new io.fabric8.mockwebserver.MockWebServer(), responses,
            new KubernetesMixedDispatcher(responses), false);
        server.init();
        client = server.createClient();
        gateway = new Fabric8PublicEndpointGateway(client, NS);
        projects = new ProjectService(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()));
        runtimeStore = new JdbcProjectRuntimeStore(jdbc);
        provisioningCalls = new ArrayList<>();
        scan = new CreationEndpointRecoveryService(runtimeStore, gateway, projects,
            provisioningCalls::add, new ProjectLifecycleGate());
        ownerId = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, 'hash', ?)",
            ownerId, "recovery-owner-" + ownerId, Timestamp.from(Instant.parse("2026-09-21T00:00:00Z")));
    }

    @AfterEach
    void tearDown() {
        server.destroy();
        db.close();
    }

    @Test
    void anUnresolvedCreationIsVerifiedAgainstTheRealPortsAndContinuesProvisioning() {
        String projectId = stuckProject("key-1", List.of(new ProjectRuntimeSpec.Port("web", 80, 30081)));

        CreationEndpointRecoveryService.ScanReport report = scan.recoverUnresolvedEndpoints();

        // The stable identity keeps its single record: verified, assigned, provisioning continues.
        assertThat(report.confirmed()).containsExactly(projectId);
        assertThat(endpointState(projectId)).isEqualTo("ASSIGNED");
        assertThat(projectCount()).isEqualTo(1);
        assertThat(projects.get(ownerId, projectId)).isPresent();
        assertThat(provisioningCalls).containsExactly(projectId);
        Service service = client.services().inNamespace(NS).withName("manao-app-" + projectId).get();
        assertThat(service).isNotNull();
        assertThat(service.getSpec().getPorts().get(0).getNodePort()).isEqualTo(30081);
    }

    @Test
    void anAlreadyAppliedServiceIsVerifiedNotReapplied() {
        String projectId = stuckProject("key-1", List.of(new ProjectRuntimeSpec.Port("web", 80, 30081)));
        List<ProjectRuntimeSpec.Port> ports = List.of(new ProjectRuntimeSpec.Port("web", 80, 30081));
        // The apply succeeded back then but the verdict was lost; the Service is already there.
        assertThat(gateway.ensure(projectId, ports)).isEqualTo(PublicEndpointGateway.ApplyResult.CONFIRMED);
        // Canary: any re-application attempt (POST) would fail and defer the row, while reuse
        // (GET plus whole-group check) never touches it.
        server.expect().post().withPath(SERVICE_PATH)
            .andReturn(500, new StatusBuilder().withCode(500).withMessage("replay canary").build()).always();

        CreationEndpointRecoveryService.ScanReport report = scan.recoverUnresolvedEndpoints();

        assertThat(report.confirmed()).containsExactly(projectId);
        assertThat(endpointState(projectId)).isEqualTo("ASSIGNED");
        assertThat(client.services().inNamespace(NS).list().getItems()).hasSize(1);
        assertThat(client.services().inNamespace(NS).withName("manao-app-" + projectId).get()
            .getSpec().getPorts().get(0).getNodePort()).isEqualTo(30081);
    }

    @Test
    void aDeterministicConflictWithNoSideEffectsCancelsTheRowAndReleasesQuota() {
        String projectId = stuckProject("key-1", List.of(new ProjectRuntimeSpec.Port("web", 80, 30081)));
        server.expect().post().withPath(SERVICE_PATH).andReturn(422, nodePortConflictStatus()).always();

        CreationEndpointRecoveryService.ScanReport report = scan.recoverUnresolvedEndpoints();

        // The port is genuinely taken and no Service was left behind, and without a confirmed
        // endpoint no workspace resource can exist: the temporary row is cancelled exactly like
        // the create path does, so the attempt does not leak quota.
        assertThat(report.cancelled()).containsExactly(projectId);
        assertThat(projectCount()).isZero();
        assertThat(client.services().inNamespace(NS).list().getItems()).isEmpty();
        assertThat(provisioningCalls).isEmpty();
        assertThat(projects.create(ownerId, "again", "key-2",
            new ProjectRuntimeSpec(ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, false, false,
                List.of(new ProjectRuntimeSpec.Port("web", 80, 30082))))).isPresent();
    }

    @Test
    void anUncertainOutcomeKeepsTheRowWaitingForTheNextScan() {
        String projectId = stuckProject("key-1", List.of(new ProjectRuntimeSpec.Port("web", 80, 30081)));
        // A foreign Service at the application name cannot be judged: never touched, never replaced.
        client.services().inNamespace(NS).resource(new ServiceBuilder()
                .withNewMetadata().withName("manao-app-" + projectId).withNamespace(NS).endMetadata()
                .withNewSpec().withType("NodePort")
                .withPorts(new ServicePortBuilder().withName("other").withPort(1).withNodePort(30099).build())
                .endSpec().build())
            .create();

        CreationEndpointRecoveryService.ScanReport report = scan.recoverUnresolvedEndpoints();

        // Still undecidable: the row keeps waiting as CREATING/UNKNOWN for the next scan and
        // nothing was replayed, provisioned or deleted.
        assertThat(report.deferred()).containsExactly(projectId);
        assertThat(endpointState(projectId)).isEqualTo("UNKNOWN");
        assertThat(projects.get(ownerId, projectId)).isPresent();
        assertThat(jdbc.queryForObject("SELECT state FROM project WHERE id = ?", String.class, projectId))
            .isEqualTo("CREATING");
        assertThat(provisioningCalls).isEmpty();
        assertThat(client.services().inNamespace(NS).withName("manao-app-" + projectId).get()
            .getSpec().getPorts().get(0).getNodePort()).isEqualTo(30099);
    }

    @Test
    void anAlreadyAssignedCreationIsNotScannedAgain() {
        String settledId = stuckProject("key-1", List.of(new ProjectRuntimeSpec.Port("web", 80, 30081)));
        runtimeStore.setEndpointState(settledId, "ASSIGNED");
        String stuckId = stuckProject("key-2", List.of(new ProjectRuntimeSpec.Port("web", 8080, 30082)));

        CreationEndpointRecoveryService.ScanReport report = scan.recoverUnresolvedEndpoints();

        // Only the unresolved row is reconciled; the settled one never gets a second Service.
        assertThat(report.confirmed()).containsExactly(stuckId);
        assertThat(provisioningCalls).containsExactly(stuckId);
        assertThat(client.services().inNamespace(NS).list().getItems()).hasSize(1);
        assertThat(endpointState(settledId)).isEqualTo("ASSIGNED");
    }

    @Test
    void aCreationWithoutPublicPortsIsNotScanned() {
        String projectId = stuckProject("key-1", List.of());

        CreationEndpointRecoveryService.ScanReport report = scan.recoverUnresolvedEndpoints();

        // Nothing to verify for a creation without an endpoint application.
        assertThat(report.confirmed()).isEmpty();
        assertThat(report.cancelled()).isEmpty();
        assertThat(report.deferred()).isEmpty();
        assertThat(provisioningCalls).isEmpty();
        assertThat(client.services().inNamespace(NS).list().getItems()).isEmpty();
    }

    @Test
    void aTransportFailureDefersTheRowWithoutFailingTheScan() {
        String projectId = stuckProject("key-1", List.of(new ProjectRuntimeSpec.Port("web", 80, 30081)));
        server.expect().get().withPath(SERVICE_PATH + "/manao-app-" + projectId)
            .andReturn(500, new StatusBuilder().withCode(500).withMessage("apiserver down").build()).always();

        CreationEndpointRecoveryService.ScanReport report = scan.recoverUnresolvedEndpoints();

        // The verification itself failed: nothing was mutated and the row waits for the next scan.
        assertThat(report.deferred()).containsExactly(projectId);
        assertThat(endpointState(projectId)).isEqualTo("UNKNOWN");
        assertThat(projects.get(ownerId, projectId)).isPresent();
        assertThat(provisioningCalls).isEmpty();
        assertThat(client.services().inNamespace(NS).list().getItems()).isEmpty();
    }

    /** Creates a keyed web-template creation and leaves it at the unresolved UNKNOWN verdict. */
    private String stuckProject(String creationKey, List<ProjectRuntimeSpec.Port> ports) {
        ProjectRuntimeSpec spec = new ProjectRuntimeSpec(
            ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, false, false, ports);
        // The name is derived from the key: (owner_id, name) is unique too (uq_project_owner_name).
        ProjectService.Project project = projects.create(ownerId, "orders-demo-" + creationKey, creationKey, spec)
            .orElseThrow();
        runtimeStore.setEndpointState(project.id(), "UNKNOWN");
        return project.id();
    }

    private String endpointState(String projectId) {
        return jdbc.queryForObject("SELECT endpoint_state FROM project WHERE id = ?", String.class, projectId);
    }

    private int projectCount() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM project", Integer.class);
    }

    /** The exact NodePort allocation cause the real apiserver sends for a taken port. */
    private static Status nodePortConflictStatus() {
        return new StatusBuilder()
            .withCode(422).withReason("Invalid").withMessage("Service \"manao-app-x\" is invalid")
            .withDetails(new StatusDetailsBuilder().withName("manao-app-x").withKind("Service")
                .withCauses(new StatusCauseBuilder().withField("spec.ports[0].nodePort")
                    .withMessage("Provided port is already allocated").withReason("FieldValueInvalid").build())
                .build())
            .build();
    }
}
