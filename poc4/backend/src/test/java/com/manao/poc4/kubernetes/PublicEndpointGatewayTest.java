package com.manao.poc4.kubernetes;

import static com.manao.poc4.kubernetes.PublicEndpointGateway.ApplyResult.CONFIRMED;
import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.project.ProjectRuntimeSpec;
import io.fabric8.kubernetes.api.model.IntOrString;
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
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Fabric8 mock-server coverage for the exact user-selected public port application. The
 * NodePort conflict is only ever recognized from an explicit Kubernetes field cause; this is
 * interface observation, not private helper testing.
 */
class PublicEndpointGatewayTest {
    private static final String NS = "manao-test";
    private static final String SERVICE_PATH = "/api/v1/namespaces/" + NS + "/services";

    KubernetesMockServer server;
    KubernetesClient client;
    Fabric8PublicEndpointGateway gateway;

    @BeforeEach
    void setUp() {
        // The mixed dispatcher serves recorded expectations first and forwards the rest to the
        // CRUD store, so injected 422 statuses coexist with real object persistence. Both the
        // server and the dispatcher must share ONE responses map: expect() registers into the
        // constructor-passed map, and the dispatcher looks requests up in exactly that map.
        java.util.Map<io.fabric8.mockwebserver.ServerRequest,
            java.util.Queue<io.fabric8.mockwebserver.ServerResponse>> responses =
            new java.util.HashMap<>();
        server = new KubernetesMockServer(new io.fabric8.mockwebserver.Context(),
            new io.fabric8.mockwebserver.MockWebServer(), responses,
            new KubernetesMixedDispatcher(responses),
            false);
        server.init();
        client = server.createClient();
        gateway = new Fabric8PublicEndpointGateway(client, NS);
    }

    @AfterEach
    void tearDown() {
        server.destroy();
    }

    @Test
    void usesUserPortWithoutSubstitution() {
        var ports = List.of(new ProjectRuntimeSpec.Port("web", 80, 30081));
        assertThat(gateway.ensure("p1", ports)).isEqualTo(CONFIRMED);
        var service = client.services().inNamespace(NS).withName("manao-app-p1").get();
        assertThat(service).isNotNull();
        assertThat(service.getSpec().getPorts().get(0).getNodePort()).isEqualTo(30081);
        assertThat(service.getSpec().getPorts().get(0).getPort()).isEqualTo(80);
        assertThat(service.getSpec().getPorts().get(0).getName()).isEqualTo("web");
        // The initial selector must not match any pod: routing to a run happens explicitly later.
        assertThat(service.getSpec().getSelector())
            .containsEntry("manao.poc4/run-id", "stopped")
            .doesNotContainKey("manao.poc4/project-id");
    }

    @Test
    void appliesTheWholePortGroupInOneService() {
        var ports = List.of(new ProjectRuntimeSpec.Port("web", 8080, 30081),
            new ProjectRuntimeSpec.Port("metrics", 9090, 30090));
        assertThat(gateway.ensure("p1", ports)).isEqualTo(CONFIRMED);
        var service = client.services().inNamespace(NS).withName("manao-app-p1").get();
        assertThat(service.getSpec().getPorts()).hasSize(2);
        assertThat(service.getSpec().getPorts())
            .extracting(io.fabric8.kubernetes.api.model.ServicePort::getNodePort)
            .containsExactly(30081, 30090);
    }

    @Test
    void aLostResponseRetryReusesTheSameStableApplication() {
        var ports = List.of(new ProjectRuntimeSpec.Port("web", 80, 30081));
        assertThat(gateway.ensure("p1", ports)).isEqualTo(CONFIRMED);
        assertThat(gateway.ensure("p1", ports)).isEqualTo(CONFIRMED);
        assertThat(client.services().inNamespace(NS).withName("manao-app-p1").get()).isNotNull();
        assertThat(client.services().inNamespace(NS).list().getItems()).hasSize(1);
    }

    @Test
    void anExplicitNodePortAllocationCauseIsAConflict() {
        server.expect().post().withPath(SERVICE_PATH)
            .andReturn(422, nodePortConflictStatus("spec.ports[0].nodePort",
                "Provided port is already allocated", "FieldValueInvalid")).always();
        var ports = List.of(new ProjectRuntimeSpec.Port("web", 80, 30081));
        assertThat(gateway.ensure("p1", ports))
            .isEqualTo(PublicEndpointGateway.ApplyResult.CONFLICT);
        // A deterministic conflict never leaves a half-applied Service behind.
        assertThat(client.services().inNamespace(NS).withName("manao-app-p1").get()).isNull();
    }

    @Test
    void anArbitrary422IsNeverTreatedAsAPortConflict() {
        // An invalid-field cause that is not about nodePort is not evidence of a port conflict.
        server.expect().post().withPath(SERVICE_PATH)
            .andReturn(422, nodePortConflictStatus("spec.type", "Unsupported value", "FieldValueNotSupported")).always();
        var ports = List.of(new ProjectRuntimeSpec.Port("web", 80, 30081));
        assertThat(gateway.ensure("p1", ports)).isEqualTo(PublicEndpointGateway.ApplyResult.UNKNOWN);
    }

    @Test
    void aNodePortRangeRejectionIsNotAPortConflict() {
        // Same nodePort field, but the message proves it is a range validation failure.
        server.expect().post().withPath(SERVICE_PATH)
            .andReturn(422, nodePortConflictStatus("spec.ports[0].nodePort",
                "Provided port is not in the valid range", "FieldValueInvalid")).always();
        var ports = List.of(new ProjectRuntimeSpec.Port("web", 80, 30081));
        assertThat(gateway.ensure("p1", ports)).isEqualTo(PublicEndpointGateway.ApplyResult.UNKNOWN);
    }

    @Test
    void aForeignServiceAtTheApplicationNameIsNeverTouched() {
        Service foreign = new ServiceBuilder()
            .withNewMetadata().withName("manao-app-p1").withNamespace(NS)
            .endMetadata()
            .withNewSpec().withType("NodePort")
            .withPorts(new ServicePortBuilder().withName("other").withPort(1)
                .withNodePort(30099).build())
            .endSpec()
            .build();
        client.services().inNamespace(NS).resource(foreign).create();

        var ports = List.of(new ProjectRuntimeSpec.Port("web", 80, 30081));
        assertThat(gateway.ensure("p1", ports)).isEqualTo(PublicEndpointGateway.ApplyResult.UNKNOWN);
        Service untouched = client.services().inNamespace(NS).withName("manao-app-p1").get();
        assertThat(untouched.getSpec().getPorts().get(0).getNodePort()).isEqualTo(30099);
    }

    @Test
    void anExistingServiceWithADifferentPortGroupIsNotOverwritten() {
        var ports = List.of(new ProjectRuntimeSpec.Port("web", 80, 30081));
        assertThat(gateway.ensure("p1", ports)).isEqualTo(CONFIRMED);

        var changed = List.of(new ProjectRuntimeSpec.Port("web", 8080, 30082));
        assertThat(gateway.ensure("p1", changed)).isEqualTo(PublicEndpointGateway.ApplyResult.UNKNOWN);
        Service unchanged = client.services().inNamespace(NS).withName("manao-app-p1").get();
        assertThat(unchanged.getSpec().getPorts().get(0).getNodePort()).isEqualTo(30081);
    }

    private Status nodePortConflictStatus(String field, String message, String reason) {
        return new StatusBuilder()
            .withCode(422)
            .withReason("Invalid")
            .withMessage("Service \"manao-app-p1\" is invalid")
            .withDetails(new StatusDetailsBuilder()
                .withName("manao-app-p1")
                .withKind("Service")
                .withCauses(new StatusCauseBuilder()
                    .withField(field).withMessage(message).withReason(reason).build())
                .build())
            .build();
    }
}
