package com.manao.poc4.kubernetes;

import com.manao.poc4.project.ProjectRuntimeSpec;
import io.fabric8.kubernetes.api.model.IntOrString;
import io.fabric8.kubernetes.api.model.Service;
import io.fabric8.kubernetes.api.model.ServiceBuilder;
import io.fabric8.kubernetes.api.model.ServicePort;
import io.fabric8.kubernetes.api.model.ServicePortBuilder;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Fabric8-backed application of the exact user-selected public ports. One Service
 * (manao-app-&lt;projectId&gt;) carries the whole port group in a single transaction; the
 * initial selector matches nothing (run-id=stopped) until a run is routed. Only the user
 * application is exposed here; the workspace Service is never touched.
 */
public final class Fabric8PublicEndpointGateway implements PublicEndpointGateway {
    static final String LABEL_RUN_ID = "manao.poc4/run-id";
    static final String LABEL_PROJECT_ID = "manao.poc4/project-id";
    static final String INITIAL_RUN_SELECTOR = "stopped";
    private static final String NODEPORT_FIELD_PREFIX = "spec.ports[";
    // The apiserver field path is spec.ports[<index>].nodePort; the closing bracket belongs to
    // the index, so the field itself ends with ".nodePort".
    private static final String NODEPORT_FIELD_SUFFIX = ".nodePort";
    private static final String CAUSE_FIELD_VALUE_INVALID = "FieldValueInvalid";
    private static final String CAUSE_MESSAGE_ALREADY_ALLOCATED = "Provided port is already allocated";

    private final KubernetesClient client;
    private final String namespace;

    public Fabric8PublicEndpointGateway(KubernetesClient client, String namespace) {
        this.client = client;
        this.namespace = namespace;
    }

    public static String serviceName(String projectId) { return "manao-app-" + projectId; }

    @Override public ApplyResult ensure(String projectId, List<ProjectRuntimeSpec.Port> ports) {
        String name = serviceName(projectId);
        Service existing = client.services().inNamespace(namespace).withName(name).get();
        if (existing != null) {
            return verifyExisting(existing, projectId, ports);
        }
        Service service = new ServiceBuilder()
            .withNewMetadata()
            .withName(name)
            .withNamespace(namespace)
            .withLabels(Map.of(
                LABEL_PROJECT_ID, projectId,
                "app.kubernetes.io/managed-by", "manao-poc4-backend"))
            .endMetadata()
            .withNewSpec()
            .withType("NodePort")
            .withSelector(Map.of(LABEL_RUN_ID, INITIAL_RUN_SELECTOR))
            .withPorts(servicePorts(ports))
            .endSpec()
            .build();
        try {
            client.services().inNamespace(namespace).resource(service).create();
            return ApplyResult.CONFIRMED;
        } catch (KubernetesClientException ex) {
            return classify(ex, projectId, ports);
        }
    }

    @Override public void routeToRun(String projectId, String runId, String podUid) {
        // Task 5 wires run routing; the stable Service keeps its allocation meanwhile.
    }

    @Override public void withdraw(String projectId) {
        // Task 5 wires stop/withdraw semantics; the allocation itself is project-scoped.
    }

    /** An existing Service is only reused when identity AND the whole port group match exactly. */
    private ApplyResult verifyExisting(Service existing, String projectId, List<ProjectRuntimeSpec.Port> ports) {
        Map<String, String> labels = existing.getMetadata() == null ? null : existing.getMetadata().getLabels();
        if (labels == null || !projectId.equals(labels.get(LABEL_PROJECT_ID))) {
            return ApplyResult.UNKNOWN;
        }
        List<ServicePort> actual = existing.getSpec() == null ? null : existing.getSpec().getPorts();
        if (actual == null || actual.size() != ports.size()) {
            return ApplyResult.UNKNOWN;
        }
        for (int index = 0; index < ports.size(); index++) {
            ServicePort port = actual.get(index);
            ProjectRuntimeSpec.Port expected = ports.get(index);
            Integer nodePort = port.getNodePort();
            if (!expected.name().equals(port.getName()) || nodePort == null
                || nodePort != expected.publicPort() || port.getPort() == null
                || port.getPort() != expected.targetPort()) {
                return ApplyResult.UNKNOWN;
            }
        }
        return ApplyResult.CONFIRMED;
    }

    private static List<ServicePort> servicePorts(List<ProjectRuntimeSpec.Port> ports) {
        List<ServicePort> mappings = new ArrayList<>();
        for (ProjectRuntimeSpec.Port mapping : ports) {
            mappings.add(new ServicePortBuilder()
                .withName(mapping.name())
                .withProtocol("TCP")
                .withPort(mapping.targetPort())
                .withTargetPort(new IntOrString(mapping.targetPort()))
                .withNodePort(mapping.publicPort())
                .build());
        }
        return mappings;
    }

    /**
     * Only an explicit NodePort allocation field cause is a deterministic conflict. Any other
     * 422 (range rejections, unsupported type, foreign resources) is UNKNOWN, never CONFLICT,
     * so the caller never substitutes a different port based on a wrong guess.
     */
    private ApplyResult classify(KubernetesClientException ex, String projectId,
                                 List<ProjectRuntimeSpec.Port> ports) {
        if (!isNodePortAllocationConflict(ex)) {
            return ApplyResult.UNKNOWN;
        }
        // Deterministic conflict: only safe to cancel when no Service was left behind.
        String name = serviceName(projectId);
        Service after = client.services().inNamespace(namespace).withName(name).get();
        if (after == null) {
            return ApplyResult.CONFLICT;
        }
        return verifyExisting(after, projectId, ports) == ApplyResult.CONFIRMED
            ? ApplyResult.CONFIRMED : ApplyResult.UNKNOWN;
    }

    static boolean isNodePortAllocationConflict(KubernetesClientException ex) {
        if (ex.getStatus() == null || ex.getStatus().getDetails() == null
            || ex.getStatus().getDetails().getCauses() == null) {
            return false;
        }
        return ex.getStatus().getDetails().getCauses().stream().anyMatch(cause ->
            CAUSE_FIELD_VALUE_INVALID.equals(cause.getReason())
                && cause.getField() != null && cause.getField().startsWith(NODEPORT_FIELD_PREFIX)
                && cause.getField().endsWith(NODEPORT_FIELD_SUFFIX)
                && CAUSE_MESSAGE_ALREADY_ALLOCATED.equals(cause.getMessage()));
    }
}
