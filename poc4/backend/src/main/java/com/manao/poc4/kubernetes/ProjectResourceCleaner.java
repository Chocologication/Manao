package com.manao.poc4.kubernetes;

import io.fabric8.kubernetes.api.model.DeletionPropagation;
import io.fabric8.kubernetes.api.model.HasMetadata;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaim;
import io.fabric8.kubernetes.api.model.PersistentVolume;
import io.fabric8.kubernetes.api.model.Service;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientException;
import java.net.SocketTimeoutException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;

/**
 * Owner-scoped Kubernetes cleanup: Jobs, then every owned Pod (including initializer) and Service,
 * then PVC only after workloads are confirmed gone and its storage policy really deletes data.
 * Completion also waits for owned PV reclamation. Unknown or forbidden lists are never empty.
 */
public final class ProjectResourceCleaner {
    public record ResourceRef(String kind, String namespace, String name, String uid) {}
    public record Issue(String phase, ResourceRef resource, String category) {}
    public record CleanupReport(boolean workloadsAbsent, boolean storageAbsent,
                                List<ResourceRef> remaining, List<Issue> issues) {
        public boolean complete() {
            return workloadsAbsent && storageAbsent && remaining.isEmpty() && issues.isEmpty();
        }
    }

    public interface Sleeper {
        void sleep(Duration duration) throws InterruptedException;
    }

    private final KubernetesClient client;
    private final String namespace;
    private final Duration budget;
    private final Duration poll;
    private final Clock clock;
    private final Sleeper sleeper;
    private boolean stopped;

    public ProjectResourceCleaner(KubernetesClient client, String namespace) {
        this(client, namespace, Duration.ofSeconds(90), Duration.ofMillis(250), Clock.systemUTC(),
            Duration.ofSeconds(5), duration -> Thread.sleep(duration.toMillis()));
    }

    public ProjectResourceCleaner(KubernetesClient client, String namespace, Duration budget, Duration poll,
                                  Clock clock, Duration requestTimeout, Sleeper sleeper) {
        this.client = Objects.requireNonNull(client, "client");
        this.namespace = Objects.requireNonNull(namespace, "namespace");
        this.budget = budget == null ? Duration.ofSeconds(90) : budget;
        this.poll = poll == null || poll.isNegative() ? Duration.ofMillis(250) : poll;
        this.clock = clock == null ? Clock.systemUTC() : clock;
        this.sleeper = sleeper == null
            ? duration -> Thread.sleep(duration.toMillis())
            : sleeper;
        if (requestTimeout != null && client.getConfiguration() != null) {
            client.getConfiguration().setRequestTimeout((int) Math.max(1L, requestTimeout.toMillis()));
        }
    }

    public CleanupReport clean(String projectId) {
        Objects.requireNonNull(projectId, "projectId");
        Instant deadline = clock.instant().plus(budget);
        List<Issue> issues = new ArrayList<>();
        Map<String, String> labels = WorkspaceResourceFactory.projectResourceLabels(projectId);
        Inventory inventory = inventory(labels, issues, true);
        if (!hasTime(deadline)) {
            return toReport(inventory, issues);
        }
        deleteEach("job", inventory.jobs, issues, deadline, job ->
            client.batch().v1().jobs().inNamespace(namespace).withName(job.getMetadata().getName())
                .withPropagationPolicy(DeletionPropagation.FOREGROUND).delete());
        deleteEach("pod", inventory.pods, issues, deadline, pod ->
            client.pods().inNamespace(namespace).withName(pod.getMetadata().getName()).withGracePeriod(0).delete());
        deleteEach("service", inventory.services, issues, deadline, service ->
            client.services().inNamespace(namespace).withName(service.getMetadata().getName()).delete());
        awaitWorkloadsGone(labels, issues, deadline);
        Inventory afterWorkloads = inventory(labels, issues, true);
        if (!afterWorkloads.workloadsKnownEmpty() || !hasTime(deadline)
            || !reclaimsStorage(projectId, afterWorkloads, issues)) {
            return toReport(afterWorkloads, issues);
        }
        deleteEach("pvc", afterWorkloads.pvcs, issues, deadline, pvc ->
            client.persistentVolumeClaims().inNamespace(namespace).withName(pvc.getMetadata().getName()).delete());
        awaitStorageGone(labels, issues, deadline);
        return toReport(inventory(labels, issues, true), issues);
    }

    public void deleteWorkloads(String projectId) {
        Objects.requireNonNull(projectId, "projectId");
        Instant deadline = clock.instant().plus(budget);
        List<Issue> issues = new ArrayList<>();
        Map<String, String> labels = WorkspaceResourceFactory.projectResourceLabels(projectId);
        Inventory inventory = inventory(labels, issues);
        deleteEach("pod", inventory.pods, issues, deadline, pod ->
            client.pods().inNamespace(namespace).withName(pod.getMetadata().getName()).withGracePeriod(0).delete());
        deleteEach("service", inventory.services, issues, deadline, service ->
            client.services().inNamespace(namespace).withName(service.getMetadata().getName()).delete());
        if (!issues.isEmpty()) {
            throw new ProjectResourceCleanupException(toReport(inventory(labels, issues), issues));
        }
    }

    private Inventory inventory(Map<String, String> labels, List<Issue> issues) {
        return inventory(labels, issues, false);
    }

    private Inventory inventory(Map<String, String> labels, List<Issue> issues, boolean includeVolumes) {
        Inventory inventory = new Inventory();
        inventory.jobs = list("job", () -> client.batch().v1().jobs().inNamespace(namespace).withLabels(labels).list().getItems(),
            issues, known -> inventory.jobsKnown = known);
        inventory.pods = list("pod", () -> client.pods().inNamespace(namespace).withLabels(labels).list().getItems(),
            issues, known -> inventory.podsKnown = known);
        inventory.services = list("service", () -> client.services().inNamespace(namespace).withLabels(labels).list().getItems(),
            issues, known -> inventory.servicesKnown = known);
        inventory.pvcs = list("pvc", () -> client.persistentVolumeClaims().inNamespace(namespace).withLabels(labels).list().getItems(),
            issues, known -> inventory.pvcsKnown = known);
        if (includeVolumes) {
            String claimName = WorkspaceResourceFactory.pvcName(labels.get(WorkspaceResourceFactory.LABEL_PROJECT_ID));
            inventory.pvs = list("pv", () -> client.persistentVolumes().list().getItems().stream()
                .filter(pv -> pv.getSpec() != null && pv.getSpec().getClaimRef() != null)
                .filter(pv -> namespace.equals(pv.getSpec().getClaimRef().getNamespace()))
                .filter(pv -> claimName.equals(pv.getSpec().getClaimRef().getName())
                    || inventory.pvcs.stream().anyMatch(pvc -> pvc.getMetadata().getName()
                        .equals(pv.getSpec().getClaimRef().getName())))
                .toList(), issues, known -> inventory.pvsKnown = known);
        }
        return inventory;
    }

    /** Preserve the claim on an unsupported/retaining policy; never force-delete PVs or finalizers. */
    private boolean reclaimsStorage(String projectId, Inventory inventory, List<Issue> issues) {
        if (!inventory.pvcsKnown || !inventory.pvsKnown) return false;
        boolean allowed = true;
        for (PersistentVolumeClaim claim : inventory.pvcs) {
            // The MVP owns one deterministic claim. Preserve anomalies rather than lose PV identity on retry.
            if (!WorkspaceResourceFactory.pvcName(projectId).equals(claim.getMetadata().getName())) {
                issues.add(new Issue("storage-policy", ref("pvc", claim), "UNEXPECTED_STORAGE_CLAIM"));
                allowed = false;
            }
            String boundVolume = claim.getSpec() == null ? null : claim.getSpec().getVolumeName();
            if (boundVolume != null && !boundVolume.isBlank()
                && inventory.pvs.stream().noneMatch(pv -> boundVolume.equals(pv.getMetadata().getName()))) {
                issues.add(new Issue("storage-policy", ref("pvc", claim), "STORAGE_POLICY_UNVERIFIED"));
                allowed = false;
            }
        }
        for (PersistentVolume pv : inventory.pvs) {
            try {
                if (!"Delete".equals(pv.getSpec().getPersistentVolumeReclaimPolicy())) {
                    issues.add(new Issue("storage-policy", ref("pv", pv), "STORAGE_RETAINED"));
                    allowed = false;
                    continue;
                }
                if (pv.getSpec().getNfs() != null) {
                    var storageClass = client.storage().v1().storageClasses()
                        .withName(pv.getSpec().getStorageClassName()).get();
                    Map<String, String> parameters = storageClass == null || storageClass.getParameters() == null
                        ? Map.of() : storageClass.getParameters();
                    String onDelete = parameters.get("onDelete");
                    boolean deletesData = "delete".equals(onDelete)
                        || (!"retain".equals(onDelete) && "false".equalsIgnoreCase(parameters.get("archiveOnDelete")));
                    if (storageClass == null || storageClass.getProvisioner() == null
                        || !storageClass.getProvisioner().endsWith("/nfs-subdir-external-provisioner") || !deletesData) {
                        issues.add(new Issue("storage-policy", ref("pv", pv), "STORAGE_POLICY_UNVERIFIED"));
                        allowed = false;
                    }
                }
            } catch (RuntimeException ex) {
                issues.add(new Issue("storage-policy", ref("pv", pv), category(ex)));
                allowed = false;
            }
        }
        return allowed;
    }

    private <T> List<T> list(String kind, java.util.function.Supplier<List<T>> query, List<Issue> issues,
                             Consumer<Boolean> known) {
        try {
            List<T> items = query.get();
            known.accept(true);
            return items == null ? List.of() : items;
        } catch (RuntimeException ex) {
            known.accept(false);
            issues.add(new Issue("inventory", new ResourceRef(kind, namespace, "*", null), category(ex)));
            return List.of();
        }
    }

    private <T extends HasMetadata> void deleteEach(String kind, List<T> items, List<Issue> issues, Instant deadline,
                                                    Consumer<T> deleter) {
        for (T item : items) {
            if (!hasTime(deadline)) {
                return;
            }
            if (item == null || item.getMetadata() == null) {
                continue;
            }
            if (item.getMetadata().getNamespace() != null && !namespace.equals(item.getMetadata().getNamespace())) {
                continue;
            }
            try {
                deleter.accept(item);
            } catch (RuntimeException ex) {
                issues.add(new Issue("delete", ref(kind, item), category(ex)));
            }
        }
    }

    private void awaitWorkloadsGone(Map<String, String> labels, List<Issue> issues, Instant deadline) {
        while (hasTime(deadline)) {
            Inventory inventory = inventory(labels, issues);
            if (inventory.workloadsKnownEmpty()) {
                return;
            }
            pause(issues);
        }
    }

    private void awaitStorageGone(Map<String, String> labels, List<Issue> issues, Instant deadline) {
        while (hasTime(deadline)) {
            Inventory inventory = inventory(labels, issues, true);
            if (inventory.workloadsKnownEmpty() && inventory.storageKnownEmpty()) {
                return;
            }
            pause(issues);
        }
    }

    private void pause(List<Issue> issues) {
        try {
            sleeper.sleep(poll);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            stopped = true;
            issues.add(new Issue("wait", null, "INTERRUPTED"));
        }
    }

    private boolean hasTime(Instant deadline) {
        return !stopped && clock.instant().isBefore(deadline);
    }

    private CleanupReport toReport(Inventory inventory, List<Issue> issues) {
        List<ResourceRef> remaining = new ArrayList<>();
        if (inventory.jobsKnown) {
            inventory.jobs.forEach(item -> remaining.add(ref("job", item)));
        }
        if (inventory.podsKnown) {
            inventory.pods.forEach(item -> remaining.add(ref("pod", item)));
        }
        if (inventory.servicesKnown) {
            inventory.services.forEach(item -> remaining.add(ref("service", item)));
        }
        if (inventory.pvcsKnown) {
            inventory.pvcs.forEach(item -> remaining.add(ref("pvc", item)));
        }
        if (inventory.pvsKnown) {
            inventory.pvs.forEach(item -> remaining.add(ref("pv", item)));
        }
        return new CleanupReport(inventory.workloadsKnownEmpty(), inventory.storageKnownEmpty(),
            List.copyOf(remaining), List.copyOf(issues));
    }

    private static ResourceRef ref(String kind, HasMetadata resource) {
        if (resource == null || resource.getMetadata() == null) {
            return new ResourceRef(kind, null, null, null);
        }
        return new ResourceRef(kind, resource.getMetadata().getNamespace(), resource.getMetadata().getName(),
            resource.getMetadata().getUid());
    }

    static String category(Throwable thrown) {
        Throwable current = thrown;
        while (current != null) {
            if (current instanceof InterruptedException) {
                return "INTERRUPTED";
            }
            if (current instanceof KubernetesClientException exception) {
                if (exception.getCode() == 403) {
                    return "FORBIDDEN";
                }
                if (exception.getCode() == 408 || exception.getCode() == 504) {
                    return "TIMEOUT";
                }
            }
            if (current instanceof SocketTimeoutException || current instanceof TimeoutException) {
                return "TIMEOUT";
            }
            current = current.getCause();
        }
        return "UNKNOWN";
    }

    private static final class Inventory {
        private boolean jobsKnown;
        private boolean podsKnown;
        private boolean servicesKnown;
        private boolean pvcsKnown;
        private boolean pvsKnown;
        private List<PersistentVolume> pvs = List.of();
        private List<Job> jobs = List.of();
        private List<Pod> pods = List.of();
        private List<Service> services = List.of();
        private List<PersistentVolumeClaim> pvcs = List.of();

        private boolean workloadsKnownEmpty() {
            return jobsKnown && jobs.isEmpty() && podsKnown && pods.isEmpty() && servicesKnown && services.isEmpty();
        }

        private boolean storageKnownEmpty() {
            return pvcsKnown && pvcs.isEmpty() && pvsKnown && pvs.isEmpty();
        }
    }
}
