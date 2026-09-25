package com.manao.poc4.kubernetes;

import com.manao.poc4.project.ProjectRuntimeSpec;
import io.fabric8.kubernetes.api.model.IntOrString;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.Service;
import io.fabric8.kubernetes.api.model.ServiceBuilder;
import io.fabric8.kubernetes.api.model.ServicePort;
import io.fabric8.kubernetes.api.model.ServicePortBuilder;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Fabric8-backed application of the exact user-selected public ports. One Service
 * (manao-app-&lt;projectId&gt;) carries the whole port group in a single transaction; the
 * initial selector matches nothing (run-id=stopped) until a run is routed. Only the user
 * application is exposed here; the workspace Service is never touched.
 */
public final class Fabric8PublicEndpointGateway implements PublicEndpointGateway {
    private static final Logger LOG = LoggerFactory.getLogger(Fabric8PublicEndpointGateway.class);
    static final String LABEL_RUN_ID = "manao.poc4/run-id";
    static final String LABEL_PROJECT_ID = "manao.poc4/project-id";
    static final String LABEL_COMPONENT = "manao.poc4/component";
    static final String LABEL_POD_UID = "manao.poc4/pod-uid";
    static final String COMPONENT_VALUE = "maven-run";
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

    /**
     * Cluster-wide, label-blind read of every Service's nodePorts: any Service anywhere that
     * already holds a requested port makes the request reject before insertion, platform-owned
     * or not. A list that cannot be read (Forbidden, timeout, network error) or a null result
     * is UNKNOWN — never an empty cluster — so an unreadable state can never pass as "free".
     * The verdict is advisory only; the Service create below stays the final judge.
     */
    @Override public PreflightResult checkNodePortsAvailable(List<ProjectRuntimeSpec.Port> ports) {
        Set<Integer> requested = new HashSet<>();
        for (ProjectRuntimeSpec.Port port : ports) {
            requested.add(port.publicPort());
        }
        List<Service> services;
        try {
            services = client.services().inAnyNamespace().list().getItems();
        } catch (RuntimeException ex) {
            LOG.warn("public-port preflight could not list cluster Services; the requested "
                + "ports' availability is unknown", ex);
            return PreflightResult.UNKNOWN;
        }
        if (services == null) {
            LOG.warn("public-port preflight list returned no result; availability is unknown");
            return PreflightResult.UNKNOWN;
        }
        for (Service service : services) {
            List<ServicePort> servicePorts = service.getSpec() == null
                ? null : service.getSpec().getPorts();
            if (servicePorts == null) {
                continue;
            }
            for (ServicePort servicePort : servicePorts) {
                Integer nodePort = servicePort.getNodePort();
                if (nodePort != null && requested.contains(nodePort)) {
                    return PreflightResult.IN_USE;
                }
            }
        }
        return PreflightResult.AVAILABLE;
    }

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
        Service service = ownedService(projectId);
        Pod claimed = client.pods().inNamespace(namespace)
            .withLabel(LABEL_RUN_ID, runId).list().getItems().stream()
            .filter(pod -> podUid.equals(podUid(pod)))
            .findFirst()
            .orElseThrow(() -> new IllegalStateException(
                "the claimed pod for this run is not observable; refusing to route"));
        // The server-side identity label goes on first; only then can the selector match the pod.
        var labels = claimed.getMetadata().getLabels() == null
            ? new java.util.HashMap<String, String>() : new java.util.HashMap<>(claimed.getMetadata().getLabels());
        if (!podUid.equals(labels.get(LABEL_POD_UID))) {
            labels.put(LABEL_POD_UID, podUid);
            client.pods().inNamespace(namespace).withName(podName(claimed)).edit(pod ->
                new io.fabric8.kubernetes.api.model.PodBuilder(pod).editMetadata()
                    .addToLabels(LABEL_POD_UID, podUid).endMetadata().build());
        }
        Map<String, String> selector = Map.of(
            LABEL_PROJECT_ID, projectId,
            LABEL_COMPONENT, COMPONENT_VALUE,
            LABEL_RUN_ID, runId,
            LABEL_POD_UID, podUid);
        if (!selector.equals(service.getSpec() == null ? null : service.getSpec().getSelector())) {
            client.services().inNamespace(namespace).withName(serviceName(projectId)).edit(existing ->
                new ServiceBuilder(existing).editSpec().withSelector(selector).endSpec().build());
        }
    }

    @Override public void withdraw(String projectId) {
        Service service = ownedService(projectId);
        Map<String, String> initial = Map.of(LABEL_RUN_ID, INITIAL_RUN_SELECTOR);
        if (initial.equals(service.getSpec() == null ? null : service.getSpec().getSelector())) {
            return;
        }
        client.services().inNamespace(namespace).withName(serviceName(projectId)).edit(existing ->
            new ServiceBuilder(existing).editSpec().withSelector(initial).endSpec().build());
    }

    /** The Service is only ever touched when its project identity label matches exactly. */
    private Service ownedService(String projectId) {
        Service service = client.services().inNamespace(namespace).withName(serviceName(projectId)).get();
        if (service == null) {
            throw new IllegalStateException("the application service for this project does not exist");
        }
        var labels = service.getMetadata() == null ? null : service.getMetadata().getLabels();
        if (labels == null || !projectId.equals(labels.get(LABEL_PROJECT_ID))) {
            throw new IllegalStateException("refusing to route through a foreign service");
        }
        return service;
    }

    private static String podUid(Pod pod) {
        return pod.getMetadata() == null ? null : pod.getMetadata().getUid();
    }

    private static String podName(Pod pod) {
        return pod.getMetadata() == null ? null : pod.getMetadata().getName();
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
        // The allocation message casing moved across Kubernetes versions (v1.31 emits it
        // lowercase); classify on the message text, never on its case.
        return ex.getStatus().getDetails().getCauses().stream().anyMatch(cause ->
            CAUSE_FIELD_VALUE_INVALID.equals(cause.getReason())
                && cause.getField() != null && cause.getField().startsWith(NODEPORT_FIELD_PREFIX)
                && cause.getField().endsWith(NODEPORT_FIELD_SUFFIX)
                && cause.getMessage() != null
                && CAUSE_MESSAGE_ALREADY_ALLOCATED.equalsIgnoreCase(cause.getMessage()));
    }
}
