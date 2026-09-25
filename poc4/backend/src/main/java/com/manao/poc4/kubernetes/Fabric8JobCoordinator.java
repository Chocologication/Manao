package com.manao.poc4.kubernetes;

import com.manao.poc4.kubernetes.JobCoordinator.JobObservation;
import com.manao.poc4.kubernetes.JobCoordinator.ObservationKind;
import com.manao.poc4.run.RunExecutionReceipt;
import com.manao.poc4.run.RunPolicy;
import com.manao.poc4.run.RunRecord;
import io.fabric8.kubernetes.api.model.ContainerStateTerminated;
import io.fabric8.kubernetes.api.model.EnvVar;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientException;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Fabric8-backed Job coordination; identity verification happens before any fact is reported.
 *
 * <p>Observation never guesses: a verified claimed Pod yields FOUND with facts and, for service
 * runs, the execution receipt — read via the fixed {@code cat /run-control/receipt.properties}
 * exec (bounded output and timeout) while the container lives, or from the container termination
 * message after it exits. Every read is bounded; a hung exec can never stall the loops.</p>
 */
public final class Fabric8JobCoordinator implements JobCoordinator {
    private static final long CREATE_TIMEOUT_SECONDS = 60;
    private static final long STOP_GRACE_PERIOD_SECONDS = 30;
    private static final Duration RECEIPT_READ_TIMEOUT = Duration.ofSeconds(10);
    private static final int RECEIPT_MAX_BYTES = 4096;
    private static final List<String> RECEIPT_COMMAND =
        List.of("cat", "/run-control/receipt.properties");

    private final KubernetesClient client;
    private final JobResourceFactory factory;
    private final ResourceIdentityVerifier verifier;
    private final String namespace;
    private final ExecTransport exec;
    private final ExecutorService receiptReader = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "manao-receipt-reader");
        thread.setDaemon(true);
        return thread;
    });

    public Fabric8JobCoordinator(KubernetesClient client, JobResourceFactory factory,
                                 ResourceIdentityVerifier verifier, String namespace, ExecTransport exec) {
        this.client = client;
        this.factory = factory;
        this.verifier = verifier;
        this.namespace = namespace;
        this.exec = exec;
    }

    @Override public String ensureJob(RunRecord run, String projectId, int primaryPort,
                                      List<EnvVar> applicationEnvironment) {
        String jobName = JobResourceFactory.jobName(run.id());
        Job existing = client.batch().v1().jobs().inNamespace(namespace).withName(jobName).get();
        if (existing != null) {
            // Idempotent recreation: reuse only when the existing job carries this run's identity.
            var labels = existing.getMetadata() == null ? null : existing.getMetadata().getLabels();
            if (labels != null && run.id().equals(labels.get(ResourceIdentityVerifier.LABEL_RUN_ID))
                && run.projectId().equals(labels.get(ResourceIdentityVerifier.LABEL_PROJECT_ID))) {
                return jobName;
            }
            throw new IllegalStateException("existing job does not match the run identity");
        }
        RunPolicy policy = RunPolicy.fromJson(run.policyJson());
        Job job = policy.isService()
            ? factory.createServiceJob(run.id(), projectId,
                run.createdAt().plusSeconds(policy.startupTimeoutSeconds()),
                policy.serviceLifetimeSeconds(), primaryPort, applicationEnvironment)
            : factory.createMavenJob(run.id(), projectId, applicationEnvironment);
        client.batch().v1().jobs().inNamespace(namespace).resource(job).serverSideApply();
        return jobName;
    }

    @Override public JobObservation observe(RunRecord run) {
        try {
            Job job = client.batch().v1().jobs().inNamespace(namespace)
                .withName(JobResourceFactory.jobName(run.id())).get();
            List<Pod> pods = client.pods().inNamespace(namespace)
                .withLabel(ResourceIdentityVerifier.LABEL_RUN_ID, run.id()).list().getItems();
            if (job == null) {
                boolean activePod = pods.stream().anyMatch(pod -> hasActiveContainer(pod));
                return activePod ? new JobObservation(ObservationKind.UNKNOWN, null, null)
                    : new JobObservation(ObservationKind.MISSING, null, null);
            }
            Pod claimed = selectClaimedPod(run, pods);
            if (claimed == null) {
                return pods.isEmpty()
                    ? new JobObservation(ObservationKind.UNKNOWN, null, null) // workload not observable yet
                    : new JobObservation(ObservationKind.IDENTITY_MISMATCH, null, null);
            }
            if (!verifier.verifyOwnership(run, job, claimed)) {
                return new JobObservation(ObservationKind.IDENTITY_MISMATCH, null, null);
            }
            if (!verifier.verify(run, job, claimed)) {
                // Owned by this Job but not observable yet (e.g. still Pending): no facts exist.
                return new JobObservation(ObservationKind.UNKNOWN, null, null);
            }
            RunExecutionReceipt receipt = readReceipt(run, claimed);
            return new JobObservation(ObservationKind.FOUND, factsFrom(job, claimed, receipt), receipt);
        } catch (KubernetesClientException ex) {
            // Transport failure, Forbidden or any other API error is never "missing".
            return new JobObservation(ObservationKind.UNKNOWN, null, null);
        }
    }

    /**
     * The claimed Pod is the recorded execution Pod UID; before a claim is recorded there must be
     * exactly one matching Pod. A replacement Pod never becomes the observed application.
     */
    private Pod selectClaimedPod(RunRecord run, List<Pod> pods) {
        if (run.executionPodUid() != null) {
            return pods.stream()
                .filter(pod -> run.executionPodUid().equals(uid(pod)))
                .findFirst().orElse(null);
        }
        return pods.size() == 1 ? pods.get(0) : null;
    }

    private JobCoordinator.JobFacts factsFrom(Job job, Pod claimed, RunExecutionReceipt receipt) {
        var status = job.getStatus();
        boolean succeeded = status != null && status.getSucceeded() != null && status.getSucceeded() >= 1;
        boolean failed = status != null && status.getFailed() != null && status.getFailed() >= 1;
        boolean deadlineExceeded = status != null && status.getConditions() != null
            && status.getConditions().stream().anyMatch(condition ->
                "Failed".equals(condition.getType()) && "DeadlineExceeded".equals(condition.getReason())
                    && "True".equals(condition.getStatus()));
        Integer exitCode = containerTerminated(claimed)
            .map(ContainerStateTerminated::getExitCode).orElse(null);
        boolean running = !succeeded && !failed && !deadlineExceeded
            && claimed.getStatus() != null && "Running".equals(claimed.getStatus().getPhase());
        boolean applicationReady = receipt != null && receipt.state() != null
            && RunExecutionReceipt.STATE_READY.equals(receipt.state());
        boolean applicationTerminated = containerTerminated(claimed).isPresent();
        return new JobCoordinator.JobFacts(running, succeeded, failed, deadlineExceeded, exitCode,
            claimed.getMetadata() == null ? null : claimed.getMetadata().getName(), uid(claimed),
            applicationReady, applicationTerminated);
    }

    private Optional<ContainerStateTerminated> containerTerminated(Pod pod) {
        if (pod.getStatus() == null || pod.getStatus().getContainerStatuses() == null) {
            return Optional.empty();
        }
        return pod.getStatus().getContainerStatuses().stream()
            .filter(status -> ResourceIdentityVerifier.APPLICATION_CONTAINER.equals(status.getName()))
            .map(status -> status.getState() == null ? null : status.getState().getTerminated())
            .filter(terminated -> terminated != null)
            .findFirst();
    }

    private RunExecutionReceipt readReceipt(RunRecord run, Pod claimed) {
        String podUid = uid(claimed);
        String text;
        var terminated = containerTerminated(claimed);
        if (terminated.isPresent()) {
            text = terminated.get().getMessage();
        } else {
            text = execReceipt(claimed.getMetadata().getName());
        }
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            RunExecutionReceipt receipt = RunExecutionReceipt.parse(text);
            // The chain was verified first; the receipt must belong to exactly this run and Pod.
            if (!run.projectId().equals(receipt.projectId()) || !run.id().equals(receipt.runId())
                || !podUid.equals(receipt.podUid())) {
                return null;
            }
            return receipt;
        } catch (IllegalArgumentException ex) {
            // Foreign or malformed evidence is never promoted to run facts.
            return null;
        }
    }

    /** Fixed command, verified pod/container, bounded output and bounded wait. */
    private String execReceipt(String podName) {
        try {
            ExecTransport.ExecProcess process = exec.exec(podName, ResourceIdentityVerifier.APPLICATION_CONTAINER,
                RECEIPT_COMMAND, 0, 0, false);
            Future<byte[]> read = receiptReader.submit(() -> readBounded(process.stdout(), RECEIPT_MAX_BYTES));
            try {
                byte[] bytes = read.get(RECEIPT_READ_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
                Integer exit = process.waitFor(RECEIPT_READ_TIMEOUT.getSeconds(), TimeUnit.SECONDS);
                return exit != null && exit == 0 ? new String(bytes, StandardCharsets.UTF_8) : null;
            } catch (TimeoutException ex) {
                read.cancel(true);
                return null;
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                read.cancel(true);
                return null;
            } catch (java.util.concurrent.ExecutionException ex) {
                return null;
            } finally {
                process.close();
            }
        } catch (RuntimeException ex) {
            // Exec unavailable (transport error, container gone between list and exec): unknown receipt.
            return null;
        }
    }

    private static byte[] readBounded(InputStream stream, int maxBytes) throws java.io.IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(maxBytes);
        byte[] chunk = new byte[512];
        int read;
        while (buffer.size() < maxBytes && (read = stream.read(chunk)) != -1) {
            buffer.write(chunk, 0, Math.min(read, maxBytes - buffer.size()));
        }
        return buffer.toByteArray();
    }

    private static String uid(Pod pod) {
        return pod.getMetadata() == null ? null : pod.getMetadata().getUid();
    }

    private static boolean hasActiveContainer(Pod pod) {
        return pod.getStatus() != null && ("Running".equals(pod.getStatus().getPhase())
            || "Pending".equals(pod.getStatus().getPhase()));
    }

    @Override public Optional<LivePod> findLivePod(String runId) {
        List<Pod> pods = client.pods().inNamespace(namespace)
            .withLabel(ResourceIdentityVerifier.LABEL_RUN_ID, runId).list().getItems();
        if (pods.size() != 1) return Optional.empty();
        Pod pod = pods.get(0);
        Job job = client.batch().v1().jobs().inNamespace(namespace)
            .withName(JobResourceFactory.jobName(runId)).get();
        if (job == null || job.getMetadata() == null || job.getMetadata().getLabels() == null) {
            return Optional.empty();
        }
        if (!verifier.verify(runRecordFrom(job), job, pod)) return Optional.empty();
        boolean containerRunning = pod.getStatus() != null && pod.getStatus().getContainerStatuses() != null
            && pod.getStatus().getContainerStatuses().stream().anyMatch(status ->
                ResourceIdentityVerifier.APPLICATION_CONTAINER.equals(status.getName())
                && status.getState() != null && status.getState().getRunning() != null);
        if (!containerRunning) return Optional.empty();
        return Optional.of(new LivePod(pod.getMetadata().getName(), ResourceIdentityVerifier.APPLICATION_CONTAINER));
    }

    /** Minimal RunRecord rebuilt from server labels so the shared verifier can check ownership. */
    private RunRecord runRecordFrom(Job job) {
        var labels = job.getMetadata().getLabels();
        return new RunRecord(labels.get(ResourceIdentityVerifier.LABEL_RUN_ID),
            labels.get(ResourceIdentityVerifier.LABEL_PROJECT_ID), 0L, com.manao.poc4.persistence.RunState.RUNNING,
            "{}", null, null, null, null, null, null, 0L, null, 0L);
    }

    @Override public boolean stop(String jobName) {
        var resource = client.batch().v1().jobs().inNamespace(namespace).withName(jobName);
        if (resource.get() == null) return true;
        resource.withGracePeriod(STOP_GRACE_PERIOD_SECONDS).delete();
        try {
            resource.waitUntilCondition(java.util.Objects::isNull, CREATE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (RuntimeException ignored) {
            // Deletion confirmation is re-checked by the observation loop before any unlock.
        }
        return resource.get() == null;
    }
}
