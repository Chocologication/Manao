package com.manao.poc4.kubernetes;

import com.manao.poc4.project.ProjectRuntimeStore;
import io.fabric8.kubernetes.api.model.DeletionPropagation;
import io.fabric8.kubernetes.api.model.HasMetadata;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaim;
import io.fabric8.kubernetes.api.model.PersistentVolume;
import io.fabric8.kubernetes.api.model.Secret;
import io.fabric8.kubernetes.api.model.Service;
import io.fabric8.kubernetes.api.model.apps.Deployment;
import io.fabric8.kubernetes.api.model.apps.ReplicaSet;
import io.fabric8.kubernetes.api.model.apps.StatefulSet;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.networking.v1.NetworkPolicy;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientException;
import java.net.SocketTimeoutException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;

/**
 * Owner-scoped Kubernetes cleanup. Full deletion removes dependency controllers first (Jobs,
 * MySQL StatefulSets, Redis Deployments/ReplicaSets — deleting Pods alone would let the
 * controller recreate them), then every owned Pod, Service, Secret and NetworkPolicy, and only
 * after the workloads are confirmed gone the registered project claims (the deterministic
 * WORKSPACE claim and every purpose remembered in the runtime store). Claim UID and bound PV
 * identity are persisted BEFORE deletion so a retry or backend restart can still reconcile
 * leftover volumes; unregistered claims are never touched and PVs are never force-deleted.
 * Workspace recovery ({@link #deleteWorkspaceWorkloads}) touches only the workspace and
 * initializer components. Unknown or forbidden lists are never treated as empty.
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

    private static final String WORKSPACE_COMPONENT = "workspace";
    private static final String INITIALIZER_COMPONENT = "initializer";

    private final KubernetesClient client;
    private final String namespace;
    private final ProjectRuntimeStore runtimeStore;
    private final Duration budget;
    private final Duration poll;
    private final Clock clock;
    private final Sleeper sleeper;
    private boolean stopped;

    public ProjectResourceCleaner(KubernetesClient client, String namespace) {
        this(client, namespace, null);
    }

    /** A null runtime store keeps the legacy behavior: only the deterministic workspace claim is recognized, nothing is persisted. */
    public ProjectResourceCleaner(KubernetesClient client, String namespace, ProjectRuntimeStore runtimeStore) {
        this(client, namespace, Duration.ofSeconds(90), Duration.ofMillis(250), Clock.systemUTC(),
            Duration.ofSeconds(5), duration -> Thread.sleep(duration.toMillis()), runtimeStore);
    }

    public ProjectResourceCleaner(KubernetesClient client, String namespace, Duration budget, Duration poll,
                                  Clock clock, Duration requestTimeout, Sleeper sleeper) {
        this(client, namespace, budget, poll, clock, requestTimeout, sleeper, null);
    }

    public ProjectResourceCleaner(KubernetesClient client, String namespace, Duration budget, Duration poll,
                                  Clock clock, Duration requestTimeout, Sleeper sleeper,
                                  ProjectRuntimeStore runtimeStore) {
        this.client = Objects.requireNonNull(client, "client");
        this.namespace = Objects.requireNonNull(namespace, "namespace");
        this.runtimeStore = runtimeStore;
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
        List<ProjectRuntimeStore.StorageBinding> bindings = storageBindings(projectId, issues);
        Map<String, String> labels = WorkspaceResourceFactory.projectIdentityLabels(projectId);
        Inventory inventory = inventory(labels, bindings, issues, true);
        if (!hasTime(deadline)) {
            return toReport(inventory, issues);
        }
        // Controllers first: deleting Pods alone would let the StatefulSet or Deployment recreate them.
        deleteEach("job", inventory.jobs, issues, deadline, job ->
            client.batch().v1().jobs().inNamespace(namespace).withName(job.getMetadata().getName())
                .withPropagationPolicy(DeletionPropagation.FOREGROUND).delete());
        deleteEach("statefulset", inventory.statefulSets, issues, deadline, set ->
            client.apps().statefulSets().inNamespace(namespace).withName(set.getMetadata().getName())
                .withPropagationPolicy(DeletionPropagation.FOREGROUND).delete());
        deleteEach("deployment", inventory.deployments, issues, deadline, deployment ->
            client.apps().deployments().inNamespace(namespace).withName(deployment.getMetadata().getName())
                .withPropagationPolicy(DeletionPropagation.FOREGROUND).delete());
        deleteEach("replicaset", inventory.replicaSets, issues, deadline, replicaSet ->
            client.apps().replicaSets().inNamespace(namespace).withName(replicaSet.getMetadata().getName())
                .withPropagationPolicy(DeletionPropagation.FOREGROUND).delete());
        awaitControllersGone(labels, issues, deadline);
        deleteEach("pod", inventory.pods, issues, deadline, this::deletePod);
        deleteEach("service", inventory.services, issues, deadline, service ->
            client.services().inNamespace(namespace).withName(service.getMetadata().getName()).delete());
        deleteEach("secret", inventory.secrets, issues, deadline, secret ->
            client.secrets().inNamespace(namespace).withName(secret.getMetadata().getName()).delete());
        deleteEach("networkpolicy", inventory.networkPolicies, issues, deadline, policy ->
            client.network().networkPolicies().inNamespace(namespace).withName(policy.getMetadata().getName()).delete());
        awaitWorkloadsGone(labels, bindings, issues, deadline);
        Inventory afterWorkloads = inventory(labels, bindings, issues, true);
        if (!afterWorkloads.workloadsKnownEmpty() || !hasTime(deadline)
            || !reclaimsStorage(projectId, bindings, afterWorkloads, issues)) {
            return toReport(afterWorkloads, issues);
        }
        deleteEach("pvc", afterWorkloads.pvcs, issues, deadline, pvc ->
            client.persistentVolumeClaims().inNamespace(namespace).withName(pvc.getMetadata().getName()).delete());
        awaitStorageGone(labels, bindings, issues, deadline);
        return toReport(inventory(labels, bindings, issues, true), issues);
    }

    /**
     * Workspace repair path: on a label selection that is already scoped to this project, deletes
     * only the two known workspace components (workspace/initializer Pods and the workspace
     * Service). Application and dependency components, their Secrets, NetworkPolicies, Jobs and
     * both PVCs are never touched here.
     */
    public void deleteWorkspaceWorkloads(String projectId) {
        Objects.requireNonNull(projectId, "projectId");
        Instant deadline = clock.instant().plus(budget);
        List<Issue> issues = new ArrayList<>();
        Map<String, String> labels = WorkspaceResourceFactory.projectIdentityLabels(projectId);
        Inventory inventory = inventory(labels, List.of(), issues, false);
        List<Pod> pods = inventory.pods.stream()
            .filter(pod -> workspaceRepairTarget(component(pod)))
            .toList();
        List<Service> services = inventory.services.stream()
            .filter(service -> workspaceRepairTarget(component(service)))
            .toList();
        deleteEach("pod", pods, issues, deadline, pod ->
            client.pods().inNamespace(namespace).withName(pod.getMetadata().getName()).withGracePeriod(0).delete());
        deleteEach("service", services, issues, deadline, service ->
            client.services().inNamespace(namespace).withName(service.getMetadata().getName()).delete());
        if (!issues.isEmpty()) {
            throw new ProjectResourceCleanupException(toReport(inventory(labels, List.of(), issues, false), issues));
        }
    }

    /** Only these two components belong to workspace recovery; everything else survives it. */
    static boolean workspaceRepairTarget(String component) {
        return WORKSPACE_COMPONENT.equals(component) || INITIALIZER_COMPONENT.equals(component);
    }

    /** Workspace components keep the historical immediate removal; dependency Pods terminate with their normal grace period. */
    private void deletePod(Pod pod) {
        if (workspaceRepairTarget(component(pod))) {
            client.pods().inNamespace(namespace).withName(pod.getMetadata().getName()).withGracePeriod(0).delete();
            return;
        }
        client.pods().inNamespace(namespace).withName(pod.getMetadata().getName()).delete();
    }

    private static String component(HasMetadata resource) {
        if (resource == null || resource.getMetadata() == null || resource.getMetadata().getLabels() == null) {
            return null;
        }
        return resource.getMetadata().getLabels().get(WorkspaceResourceFactory.LABEL_COMPONENT);
    }

    private Inventory inventory(Map<String, String> labels, List<ProjectRuntimeStore.StorageBinding> bindings,
                                List<Issue> issues, boolean includeVolumes) {
        Inventory inventory = new Inventory();
        inventory.jobs = list("job", () -> client.batch().v1().jobs().inNamespace(namespace).withLabels(labels).list().getItems(),
            issues, known -> inventory.jobsKnown = known);
        inventory.statefulSets = list("statefulset",
            () -> client.apps().statefulSets().inNamespace(namespace).withLabels(labels).list().getItems(),
            issues, known -> inventory.statefulSetsKnown = known);
        inventory.deployments = list("deployment",
            () -> client.apps().deployments().inNamespace(namespace).withLabels(labels).list().getItems(),
            issues, known -> inventory.deploymentsKnown = known);
        inventory.replicaSets = list("replicaset",
            () -> client.apps().replicaSets().inNamespace(namespace).withLabels(labels).list().getItems(),
            issues, known -> inventory.replicaSetsKnown = known);
        inventory.pods = list("pod", () -> client.pods().inNamespace(namespace).withLabels(labels).list().getItems(),
            issues, known -> inventory.podsKnown = known);
        inventory.services = list("service", () -> client.services().inNamespace(namespace).withLabels(labels).list().getItems(),
            issues, known -> inventory.servicesKnown = known);
        inventory.secrets = list("secret", () -> client.secrets().inNamespace(namespace).withLabels(labels).list().getItems(),
            issues, known -> inventory.secretsKnown = known);
        inventory.networkPolicies = list("networkpolicy",
            () -> client.network().networkPolicies().inNamespace(namespace).withLabels(labels).list().getItems(),
            issues, known -> inventory.networkPoliciesKnown = known);
        inventory.pvcs = list("pvc", () -> client.persistentVolumeClaims().inNamespace(namespace).withLabels(labels).list().getItems(),
            issues, known -> inventory.pvcsKnown = known);
        if (includeVolumes) {
            inventory.pvs = list("pv", () -> projectVolumes(labels, bindings, inventory, issues),
                issues, known -> inventory.pvsKnown = known);
        }
        return inventory;
    }

    /**
     * Volumes still pointing at a remembered or live claim of this project. Matching by claim
     * reference or remembered PV name keeps working after the claims are gone; where a PV UID was
     * remembered and no longer matches, the volume stays in the inventory (blocking completion)
     * and is flagged, because its identity cannot be confirmed.
     */
    private List<PersistentVolume> projectVolumes(Map<String, String> labels,
                                                  List<ProjectRuntimeStore.StorageBinding> bindings,
                                                  Inventory inventory, List<Issue> issues) {
        Set<String> claimNames = new HashSet<>();
        String projectId = labels.get(WorkspaceResourceFactory.LABEL_PROJECT_ID);
        if (projectId != null) {
            claimNames.add(WorkspaceResourceFactory.pvcName(projectId));
        }
        for (ProjectRuntimeStore.StorageBinding binding : bindings) {
            if (binding.pvcName() != null) {
                claimNames.add(binding.pvcName());
            }
        }
        for (PersistentVolumeClaim claim : inventory.pvcs) {
            if (claim.getMetadata() != null && claim.getMetadata().getName() != null) {
                claimNames.add(claim.getMetadata().getName());
            }
        }
        Set<String> rememberedVolumeNames = new HashSet<>();
        for (ProjectRuntimeStore.StorageBinding binding : bindings) {
            if (binding.pvName() != null) {
                rememberedVolumeNames.add(binding.pvName());
            }
        }
        return client.persistentVolumes().list().getItems().stream()
            .filter(pv -> pv != null && pv.getMetadata() != null)
            .filter(pv -> ownedVolume(pv, claimNames, rememberedVolumeNames, bindings, issues))
            .toList();
    }

    private boolean ownedVolume(PersistentVolume pv, Set<String> claimNames, Set<String> rememberedVolumeNames,
                                List<ProjectRuntimeStore.StorageBinding> bindings, List<Issue> issues) {
        var claimRef = pv.getSpec() == null ? null : pv.getSpec().getClaimRef();
        boolean boundToRememberedClaim = claimRef != null && namespace.equals(claimRef.getNamespace())
            && claimNames.contains(claimRef.getName());
        if (!boundToRememberedClaim && !rememberedVolumeNames.contains(pv.getMetadata().getName())) {
            return false;
        }
        String uid = pv.getMetadata().getUid();
        boolean confirmed = bindings.stream()
            .filter(binding -> pv.getMetadata().getName().equals(binding.pvName()))
            .allMatch(binding -> binding.pvUid() == null || uid == null || binding.pvUid().equals(uid));
        if (!confirmed) {
            issues.add(new Issue("storage-policy", ref("pv", pv), "STORAGE_IDENTITY_UNCONFIRMED"));
        }
        return true;
    }

    /**
     * Verify the storage policy of every registered claim and its volume before any deletion.
     * Claims that match neither the deterministic workspace name nor a remembered WORKSPACE/MYSQL
     * binding are rejected: an unknown claim might belong to data the MVP does not own.
     */
    private boolean reclaimsStorage(String projectId, List<ProjectRuntimeStore.StorageBinding> bindings,
                                    Inventory inventory, List<Issue> issues) {
        if (!inventory.pvcsKnown || !inventory.pvsKnown) return false;
        boolean allowed = true;
        for (PersistentVolumeClaim claim : inventory.pvcs) {
            String boundVolume = claim.getSpec() == null ? null : claim.getSpec().getVolumeName();
            if (isRegisteredClaim(projectId, claim, bindings)) {
                rememberClaim(projectId, claim, boundVolume, bindings, inventory, issues);
            } else {
                issues.add(new Issue("storage-policy", ref("pvc", claim), "UNEXPECTED_STORAGE_CLAIM"));
                allowed = false;
            }
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

    private boolean isRegisteredClaim(String projectId, PersistentVolumeClaim claim,
                                      List<ProjectRuntimeStore.StorageBinding> bindings) {
        String name = claim.getMetadata() == null ? null : claim.getMetadata().getName();
        if (name == null) {
            return false;
        }
        // The workspace claim name is deterministic; legacy projects predate remembered bindings.
        if (WorkspaceResourceFactory.pvcName(projectId).equals(name)) {
            return true;
        }
        return bindings.stream().anyMatch(binding -> name.equals(binding.pvcName()));
    }

    /** Persist claim UID and bound PV identity BEFORE the claim is deleted, so a retry or backend restart can still reconcile the leftover volume. */
    private void rememberClaim(String projectId, PersistentVolumeClaim claim, String boundVolume,
                               List<ProjectRuntimeStore.StorageBinding> bindings, Inventory inventory,
                               List<Issue> issues) {
        if (runtimeStore == null) {
            return;
        }
        try {
            String name = claim.getMetadata().getName();
            String purpose = bindings.stream()
                .filter(binding -> name.equals(binding.pvcName()))
                .map(ProjectRuntimeStore.StorageBinding::purpose)
                .findFirst()
                .orElse("WORKSPACE");
            String volumeUid = inventory.pvs.stream()
                .filter(pv -> boundVolume != null && boundVolume.equals(pv.getMetadata().getName()))
                .map(pv -> pv.getMetadata().getUid())
                .findFirst()
                .orElse(null);
            runtimeStore.rememberStorage(projectId, new ProjectRuntimeStore.StorageBinding(purpose, name,
                claim.getMetadata().getUid(), boundVolume, volumeUid));
        } catch (RuntimeException ex) {
            issues.add(new Issue("storage-policy", ref("pvc", claim), category(ex)));
        }
    }

    private List<ProjectRuntimeStore.StorageBinding> storageBindings(String projectId, List<Issue> issues) {
        if (runtimeStore == null) {
            return List.of();
        }
        try {
            List<ProjectRuntimeStore.StorageBinding> bindings = runtimeStore.storageBindings(projectId);
            return bindings == null ? List.of() : bindings;
        } catch (RuntimeException ex) {
            issues.add(new Issue("inventory", new ResourceRef("storage-binding", null, projectId, null), category(ex)));
            return List.of();
        }
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

    private void awaitControllersGone(Map<String, String> labels, List<Issue> issues, Instant deadline) {
        while (hasTime(deadline)) {
            Inventory inventory = inventory(labels, List.of(), issues, false);
            if (inventory.controllersKnownEmpty()) {
                return;
            }
            pause(issues);
        }
    }

    private void awaitWorkloadsGone(Map<String, String> labels, List<ProjectRuntimeStore.StorageBinding> bindings,
                                    List<Issue> issues, Instant deadline) {
        while (hasTime(deadline)) {
            Inventory inventory = inventory(labels, bindings, issues, false);
            if (inventory.workloadsKnownEmpty()) {
                return;
            }
            pause(issues);
        }
    }

    private void awaitStorageGone(Map<String, String> labels, List<ProjectRuntimeStore.StorageBinding> bindings,
                                  List<Issue> issues, Instant deadline) {
        while (hasTime(deadline)) {
            Inventory inventory = inventory(labels, bindings, issues, true);
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
        if (inventory.statefulSetsKnown) {
            inventory.statefulSets.forEach(item -> remaining.add(ref("statefulset", item)));
        }
        if (inventory.deploymentsKnown) {
            inventory.deployments.forEach(item -> remaining.add(ref("deployment", item)));
        }
        if (inventory.replicaSetsKnown) {
            inventory.replicaSets.forEach(item -> remaining.add(ref("replicaset", item)));
        }
        if (inventory.podsKnown) {
            inventory.pods.forEach(item -> remaining.add(ref("pod", item)));
        }
        if (inventory.servicesKnown) {
            inventory.services.forEach(item -> remaining.add(ref("service", item)));
        }
        if (inventory.secretsKnown) {
            inventory.secrets.forEach(item -> remaining.add(ref("secret", item)));
        }
        if (inventory.networkPoliciesKnown) {
            inventory.networkPolicies.forEach(item -> remaining.add(ref("networkpolicy", item)));
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
        private boolean statefulSetsKnown;
        private boolean deploymentsKnown;
        private boolean replicaSetsKnown;
        private boolean podsKnown;
        private boolean servicesKnown;
        private boolean secretsKnown;
        private boolean networkPoliciesKnown;
        private boolean pvcsKnown;
        private boolean pvsKnown;
        private List<PersistentVolume> pvs = List.of();
        private List<Job> jobs = List.of();
        private List<StatefulSet> statefulSets = List.of();
        private List<Deployment> deployments = List.of();
        private List<ReplicaSet> replicaSets = List.of();
        private List<Pod> pods = List.of();
        private List<Service> services = List.of();
        private List<Secret> secrets = List.of();
        private List<NetworkPolicy> networkPolicies = List.of();
        private List<PersistentVolumeClaim> pvcs = List.of();

        private boolean controllersKnownEmpty() {
            return jobsKnown && jobs.isEmpty()
                && statefulSetsKnown && statefulSets.isEmpty()
                && deploymentsKnown && deployments.isEmpty()
                && replicaSetsKnown && replicaSets.isEmpty();
        }

        private boolean workloadsKnownEmpty() {
            return controllersKnownEmpty()
                && podsKnown && pods.isEmpty()
                && servicesKnown && services.isEmpty()
                && secretsKnown && secrets.isEmpty()
                && networkPoliciesKnown && networkPolicies.isEmpty();
        }

        private boolean storageKnownEmpty() {
            return pvcsKnown && pvcs.isEmpty() && pvsKnown && pvs.isEmpty();
        }
    }
}
