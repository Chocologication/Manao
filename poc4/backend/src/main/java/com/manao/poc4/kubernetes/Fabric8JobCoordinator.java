package com.manao.poc4.kubernetes;

import com.manao.poc4.run.RunRecord;
import io.fabric8.kubernetes.api.model.Job;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.client.KubernetesClient;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/** Fabric8-backed Job coordination; identity verification happens before any fact is reported. */
public final class Fabric8JobCoordinator implements JobCoordinator {
    private static final long CREATE_TIMEOUT_SECONDS = 60;

    private final KubernetesClient client;
    private final JobResourceFactory factory;
    private final ResourceIdentityVerifier verifier;
    private final String namespace;

    public Fabric8JobCoordinator(KubernetesClient client, JobResourceFactory factory,
                                 ResourceIdentityVerifier verifier, String namespace) {
        this.client = client;
        this.factory = factory;
        this.verifier = verifier;
        this.namespace = namespace;
    }

    @Override public String ensureJob(RunRecord run, String projectId) {
        String jobName = JobResourceFactory.jobName(run.id());
        Job existing = client.jobs().inNamespace(namespace).withName(jobName).get();
        if (existing != null) {
            // Idempotent recreation: reuse only when the existing job carries this run's identity.
            var labels = existing.getMetadata() == null ? null : existing.getMetadata().getLabels();
            if (labels != null && run.id().equals(labels.get(ResourceIdentityVerifier.LABEL_RUN_ID))
                && run.projectId().equals(labels.get(ResourceIdentityVerifier.LABEL_PROJECT_ID))) {
                return jobName;
            }
            throw new IllegalStateException("existing job does not match the run identity");
        }
        client.jobs().inNamespace(namespace).resource(factory.createMavenJob(run.id(), projectId))
            .serverSideApply();
        return jobName;
    }

    @Override public Optional<JobFacts> facts(RunRecord run) {
        Job job = client.jobs().inNamespace(namespace).withName(JobResourceFactory.jobName(run.id())).get();
        if (job == null) return Optional.empty();
        List<Pod> pods = client.pods().inNamespace(namespace)
            .withLabel(ResourceIdentityVerifier.LABEL_RUN_ID, run.id()).list().getItems();
        if (pods.size() != 1) return Optional.empty();
        Pod pod = pods.get(0);
        if (!verifier.verify(run, job, pod)) return Optional.empty();
        if (job.getStatus() == null) return Optional.empty();
        boolean succeeded = job.getStatus().getSucceeded() != null && job.getStatus().getSucceeded() >= 1;
        boolean failed = job.getStatus().getFailed() != null && job.getStatus().getFailed() >= 1;
        boolean deadlineExceeded = job.getStatus().getConditions() != null && job.getStatus().getConditions().stream()
            .anyMatch(condition -> "DeadlineExceeded".equals(condition.getType())
                && "True".equals(condition.getStatus()));
        Integer exitCode = pod.getStatus() == null || pod.getStatus().getContainerStatuses() == null ? null
            : pod.getStatus().getContainerStatuses().stream()
                .filter(status -> ResourceIdentityVerifier.APPLICATION_CONTAINER.equals(status.getName()))
                .map(status -> status.getState() == null || status.getState().getTerminated() == null
                    ? null : status.getState().getTerminated().getExitCode())
                .filter(code -> code != null)
                .findFirst().orElse(null);
        boolean running = !succeeded && !failed && !deadlineExceeded && pod.getStatus() != null
            && "Running".equals(pod.getStatus().getPhase());
        return Optional.of(new JobFacts(running, succeeded, failed, deadlineExceeded, exitCode));
    }

    @Override public boolean stop(String jobName) {
        var resource = client.jobs().inNamespace(namespace).withName(jobName);
        if (resource.get() == null) return true;
        resource.withGracePeriod(0).delete();
        try {
            resource.waitUntilCondition(java.util.Objects::isNull, CREATE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (RuntimeException ignored) {
            // Termination confirmation is re-checked by the next recovery scan.
        }
        return true;
    }
}
