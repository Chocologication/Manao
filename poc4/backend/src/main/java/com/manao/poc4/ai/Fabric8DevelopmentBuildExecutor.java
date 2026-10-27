package com.manao.poc4.ai;

import com.manao.poc4.kubernetes.JobResourceFactory;
import com.manao.poc4.kubernetes.ResourceIdentityVerifier;
import com.manao.poc4.kubernetes.WorkspaceResourceFactory;
import io.fabric8.kubernetes.api.model.ContainerStateTerminated;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientException;
import io.fabric8.kubernetes.client.dsl.internal.BaseOperation;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.function.BiConsumer;
import javax.xml.parsers.DocumentBuilderFactory;
import org.xml.sax.InputSource;

/**
 * Fabric8-backed executor of the isolated Maven development build (stage one, design section 5).
 * One build call drives exactly one identity-verified Job: the deterministic job name is derived
 * from the durable commandId, {@link #build} is reserved for a call whose execution has never
 * started, and {@link #observe} recovers a build already recorded under a durable identity — it
 * re-verifies the recorded Job/Pod UIDs, never creates anything and never re-executes the build,
 * so a replay after a crash can observe at most the very build that ran before. The executor
 * then observes the real termination — the container's own exit code and reason, never a
 * fabricated zero — reads a bounded log tail, parses the Surefire XML the fixed launcher
 * appended between markers (hardened parser: no DTD, no external entities; unreadable reports
 * stay missing instead of becoming passes), and only then deletes the Job and its Pods. The
 * result settles only when the Job and every associated Pod are confirmed 404, the job's UID
 * never changed during the wait, and the pod chain stayed owned by that job. {@link #close} and
 * the wait-budget/interrupt exits share one finish path: collect the still-observable log,
 * delete by the original identity, confirm everything 404. Identity mismatches, Forbidden reads
 * and unconfirmed cleanup never settle and keep the project occupied. Waiting holds no database
 * transaction and no thread gate — only short API reads and the identity listener callbacks.
 * Sources are never written: the build runs on the init container's read-only copy.
 */
public final class Fabric8DevelopmentBuildExecutor implements DevelopmentBuildExecutor {
    /** The fixed log markers the root-owned {@code manao-dev-build} launcher appends. */
    public static final String REPORT_BEGIN = "MANAO-SUREFIRE-REPORT-BEGIN";
    public static final String REPORT_END = "MANAO-SUREFIRE-REPORT-END";
    /** The bounded build output kept in memory and handed to the tools layer, in UTF-8 bytes. */
    static final int MAX_OUTPUT_BYTES = 128 * 1024;
    /** The transport-level log fetch bound (server-side limitBytes). */
    static final int LOG_FETCH_LIMIT_BYTES = 512 * 1024;

    private static final long DEFAULT_POLL_MILLIS = 2000;
    private static final long DEFAULT_WAIT_BUDGET_SECONDS = 720;   // 600s build deadline + 120s finish
    private static final long DEFAULT_CLEANUP_WAIT_SECONDS = 120;
    private static final String SOURCE_COPY_CONTAINER = "source-copy";
    /** Bounded retries after a delete conflict whose re-read re-verified the identity. */
    private static final int DELETE_CONFLICT_RETRIES = 5;

    private final KubernetesClient client;
    private final JobResourceFactory factory;
    private final String namespace;
    private final BiConsumer<AgentContracts.BuildRequest, AgentContracts.BuildIdentity> identityListener;
    private final Clock clock;
    private final long pollMillis;
    private final long waitBudgetSeconds;
    private final long cleanupWaitSeconds;
    /** Executes the actual create inside the authorization/close critical section. */
    @FunctionalInterface
    public interface BuildCreation {
        Job create(AgentContracts.BuildRequest request, java.util.function.Supplier<Job> create);
    }

    private final BuildCreation creation;
    private final java.util.function.Predicate<AgentContracts.BuildRequest> stopRequested;

    public Fabric8DevelopmentBuildExecutor(KubernetesClient client, JobResourceFactory factory, String namespace,
                                           BiConsumer<AgentContracts.BuildRequest, AgentContracts.BuildIdentity> identityListener,
                                           BuildCreation creation) {
        this(client, factory, namespace, identityListener, creation, Clock.systemUTC(),
            DEFAULT_POLL_MILLIS, DEFAULT_WAIT_BUDGET_SECONDS, DEFAULT_CLEANUP_WAIT_SECONDS);
    }

    Fabric8DevelopmentBuildExecutor(KubernetesClient client, JobResourceFactory factory, String namespace,
                                    BiConsumer<AgentContracts.BuildRequest, AgentContracts.BuildIdentity> identityListener,
                                    BuildCreation creation,
                                    Clock clock, long pollMillis, long waitBudgetSeconds, long cleanupWaitSeconds) {
        this(client, factory, namespace, identityListener, creation, request -> false, clock, pollMillis, waitBudgetSeconds, cleanupWaitSeconds);
    }

    public Fabric8DevelopmentBuildExecutor(KubernetesClient client, JobResourceFactory factory, String namespace,
            BiConsumer<AgentContracts.BuildRequest, AgentContracts.BuildIdentity> identityListener,
            BuildCreation creation, java.util.function.Predicate<AgentContracts.BuildRequest> stopRequested) {
        this(client, factory, namespace, identityListener, creation, stopRequested, Clock.systemUTC(),
            DEFAULT_POLL_MILLIS, DEFAULT_WAIT_BUDGET_SECONDS, DEFAULT_CLEANUP_WAIT_SECONDS);
    }

    Fabric8DevelopmentBuildExecutor(KubernetesClient client, JobResourceFactory factory, String namespace,
            BiConsumer<AgentContracts.BuildRequest, AgentContracts.BuildIdentity> identityListener,
            BuildCreation creation, java.util.function.Predicate<AgentContracts.BuildRequest> stopRequested,
            Clock clock, long pollMillis, long waitBudgetSeconds, long cleanupWaitSeconds) {
        this.client = Objects.requireNonNull(client, "client");
        this.factory = Objects.requireNonNull(factory, "factory");
        this.namespace = Objects.requireNonNull(namespace, "namespace");
        this.identityListener = identityListener;
        this.creation = Objects.requireNonNull(creation, "creation");
        this.stopRequested = Objects.requireNonNull(stopRequested, "stopRequested");
        this.clock = clock == null ? Clock.systemUTC() : clock;
        this.pollMillis = pollMillis;
        this.waitBudgetSeconds = waitBudgetSeconds;
        this.cleanupWaitSeconds = cleanupWaitSeconds;
    }

    private record Observation(Integer exitCode, String terminationReason, String output,
                               boolean truncated, List<AgentContracts.TestReport> reports) { }

    private record BoundedText(String text, boolean truncated) { }

    /** Carries an interrupted wait out of the polling loop so the shared finish path still runs. */
    private static final class WaitInterruptedException extends RuntimeException {
        WaitInterruptedException(InterruptedException cause) {
            super(cause);
        }
    }

    @Override public AgentContracts.BuildResult build(AgentContracts.BuildRequest request) {
        String jobName = JobResourceFactory.developmentJobName(request.commandId());
        Job job = verifiedJob(jobName, request);
        if (job == null && !buildPods(request.commandId()).isEmpty()) {
            // Lingering pod evidence without its job: the identity chain cannot be verified, so
            // no second job is created and the evidence stays in place for reconciliation.
            return unresolved(jobName, null, null, "BUILD_IDENTITY_UNVERIFIABLE");
        }
        if (job == null) {
            // The read-only source volume is resolved from the bound workspace PV before the
            // creation critical section: a workspace the manifest cannot be built for fails
            // closed before anything is created.
            JobResourceFactory.DevelopmentSourceVolume source = developmentSourceVolume(request.projectId());
            job = creation.create(request, () -> createJob(request, source));
            if (job == null) {
                return new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity(jobName, null, null),
                    null, "BUILD_CLOSING_ABORTED", "", false, List.of(), true);
            }
        }
        return awaitSettlement(request, jobName, uid(job), null);
    }

    @Override public AgentContracts.BuildResult observe(AgentContracts.BuildRequest request,
                                                        AgentContracts.BuildIdentity identity) {
        String jobName = identity.jobName() == null
            ? JobResourceFactory.developmentJobName(request.commandId()) : identity.jobName();
        Job job = verifiedJob(jobName, request);
        if (job == null) {
            // Recovery never rebuilds: a recorded build without any live evidence has an
            // unknowable outcome and stays unsettled, and pod evidence without its job can
            // never be verified at all.
            if (buildPods(request.commandId()).isEmpty()) {
                return new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity(jobName, identity.jobUid(), identity.podUid()),
                    null, "BUILD_EVIDENCE_UNAVAILABLE", "", false, List.of(), false);
            }
            return unresolved(jobName, identity.jobUid(), identity.podUid(), "BUILD_IDENTITY_UNVERIFIABLE");
        }
        if (identity.jobUid() != null && !identity.jobUid().equals(uid(job))) {
            throw new IllegalStateException("the recorded build job was replaced by a different uid");
        }
        return awaitSettlement(request, jobName, uid(job), identity.podUid());
    }

    @Override public AgentContracts.BuildResult close(AgentContracts.BuildRequest request,
                                                      AgentContracts.BuildIdentity identity) {
        String jobName = identity.jobName() == null
            ? JobResourceFactory.developmentJobName(request.commandId()) : identity.jobName();
        Job job = verifiedJob(jobName, request);
        if (job != null && identity.jobUid() != null && !identity.jobUid().equals(uid(job))) {
            throw new IllegalStateException("the build job to close does not match the recorded uid");
        }
        String jobUid = job == null ? identity.jobUid() : uid(job);
        BoundedText log = collectRemainingLog(request, jobName, jobUid, identity.podUid());
        boolean cleanupConfirmed = cleanup(jobName, jobUid, request.commandId());
        return new AgentContracts.BuildResult(
            new AgentContracts.BuildIdentity(jobName, jobUid, identity.podUid()),
            null, "BUILD_CLOSED", log.text(), log.truncated(), parseReports(log.text()), cleanupConfirmed);
    }

    /**
     * The negative proof the close flow needs for a call whose identity was never bound:
     * a successful query under the deterministic job name plus the commandId pod sweep
     * that finds NOTHING proves the build was never created. A found Job, a vanished
     * witness, or any API failure answers true — an unclear answer never releases.
     */
    @Override public boolean hasRecordedSideEffect(AgentContracts.BuildRequest request) {
        String jobName = JobResourceFactory.developmentJobName(request.commandId());
        try {
            KubernetesClient bounded=client.newClient(new io.fabric8.kubernetes.client.RequestConfigBuilder()
                .withRequestTimeout((int)ReconcileWorkBudget.requestTimeout(java.time.Duration.ofSeconds(2)).toMillis())
                .withRequestRetryBackoffLimit(0).build()).adapt(KubernetesClient.class);
            if (ReconcileWorkBudget.boundary(() -> bounded.batch().v1().jobs().inNamespace(namespace).withName(jobName).get()) != null) {
                return true;
            }
            return !ReconcileWorkBudget.boundary(() -> bounded.pods().inNamespace(namespace)
                .withLabel(JobResourceFactory.LABEL_TOOL_CALL_ID,request.commandId()).list().getItems()).isEmpty();
        } catch (KubernetesClientException apiFailure) {
            return true;
        }
    }

    /** No polling or conflict retry: one original-identity cleanup observation per scheduler drive. */
    @Override public AgentContracts.BuildResult closeStep(AgentContracts.BuildRequest request,AgentContracts.BuildIdentity identity) {
        KubernetesClient bounded=client.newClient(new io.fabric8.kubernetes.client.RequestConfigBuilder()
            .withRequestTimeout((int)ReconcileWorkBudget.requestTimeout(java.time.Duration.ofSeconds(2)).toMillis())
            .withRequestRetryBackoffLimit(0).build()).adapt(KubernetesClient.class);
        String name=identity.jobName()==null ? JobResourceFactory.developmentJobName(request.commandId()) : identity.jobName();
        Job job=ReconcileWorkBudget.boundary(() -> bounded.batch().v1().jobs().inNamespace(namespace).withName(name).get());
        if(job!=null) {
            var labels=job.getMetadata()==null ? null : job.getMetadata().getLabels();
            if(labels==null || !request.projectId().equals(labels.get(WorkspaceResourceFactory.LABEL_PROJECT_ID))
                || !request.commandId().equals(labels.get(JobResourceFactory.LABEL_TOOL_CALL_ID))
                || !JobResourceFactory.COMPONENT_DEVELOPMENT_BUILD.equals(labels.get(JobResourceFactory.LABEL_COMPONENT)))
                throw new IllegalStateException("build identity mismatch");
            if(identity.jobUid()!=null && !identity.jobUid().equals(uid(job))) throw new IllegalStateException("build identity mismatch");
        }
        String jobUid=job==null ? identity.jobUid() : uid(job);
        List<Pod> pods=ReconcileWorkBudget.boundary(() -> bounded.pods().inNamespace(namespace)
            .withLabel(JobResourceFactory.LABEL_TOOL_CALL_ID,request.commandId()).list().getItems());
        if(pods==null) pods=List.of();
        boolean absent=job==null && pods.isEmpty();
        for(Pod pod:pods) {
            if(jobUid==null || !ownedByJob(pod,jobUid)) return unresolved(name,jobUid,identity.podUid(),"BUILD_CLEANUP_UNKNOWN");
            ReconcileWorkBudget.check();
            @SuppressWarnings({"unchecked","rawtypes"}) BaseOperation<Pod,?,?> operation=(BaseOperation)bounded.pods().inNamespace(namespace).withName(podName(pod));
            ReconcileWorkBudget.boundary(() -> operation.withResourceVersion(resourceVersion(pod)).delete());
        }
        if(job!=null) {
            @SuppressWarnings({"unchecked","rawtypes"}) BaseOperation<Job,?,?> operation=(BaseOperation)bounded.batch().v1().jobs().inNamespace(namespace).withName(name);
            ReconcileWorkBudget.boundary(() -> operation.withResourceVersion(resourceVersion(job)).delete());
        }
        return new AgentContracts.BuildResult(new AgentContracts.BuildIdentity(name,jobUid,identity.podUid()),null,
            "BUILD_CLOSED","",false,List.of(),absent);
    }

    private static AgentContracts.BuildResult unresolved(String jobName, String jobUid, String podUid,
                                                         String reason) {
        return new AgentContracts.BuildResult(
            new AgentContracts.BuildIdentity(jobName, jobUid, podUid), null, reason, "", false,
            List.of(), false);
    }

    /**
     * The one polling loop behind build and observe. It re-verifies the job identity (labels and
     * UID) on every read, binds the observed pod once, settles only on a real termination with a
     * confirmed cleanup, and finishes through the shared close path when the wait budget is
     * exhausted or the caller is interrupted — the job never outlives the executor call.
     */
    private AgentContracts.BuildResult awaitSettlement(AgentContracts.BuildRequest request,
                                                       String jobName, String jobUid, String boundPodUid) {
        bindIdentity(request, jobName, jobUid, boundPodUid);
        String podUid = boundPodUid;
        try {
            Instant waitDeadline = clock.instant().plusSeconds(waitBudgetSeconds);
            while (true) {
                if (stopRequested.test(request)) {
                    boolean confirmed = cleanup(jobName, jobUid, request.commandId());
                    return new AgentContracts.BuildResult(new AgentContracts.BuildIdentity(jobName, jobUid, podUid),
                        null, "BUILD_CLOSED", "", false, List.of(), confirmed);
                }
                Job job = currentJob(jobName, jobUid, request);
                if (job == null) {
                    // The verified job vanished mid-wait: the evidence is gone and can never be
                    // trusted again, so the outcome stays unsettled for reconciliation.
                    if (buildPods(request.commandId()).isEmpty()) {
                        return new AgentContracts.BuildResult(
                            new AgentContracts.BuildIdentity(jobName, jobUid, podUid), null,
                            "BUILD_EVIDENCE_UNAVAILABLE", "", false, List.of(), false);
                    }
                    return unresolved(jobName, jobUid, podUid, "BUILD_IDENTITY_UNVERIFIABLE");
                }
                Pod pod = claimedPod(buildPods(request.commandId()), jobUid, podUid);
                if (pod != null) {
                    if (podUid == null) {
                        podUid = uid(pod);
                        bindIdentity(request, jobName, jobUid, podUid);
                    }
                    Observation observed = terminalObservation(job, pod);
                    if (observed != null) {
                        boolean cleanupConfirmed = cleanup(jobName, jobUid, request.commandId());
                        return new AgentContracts.BuildResult(
                            new AgentContracts.BuildIdentity(jobName, jobUid, podUid),
                            observed.exitCode(), observed.terminationReason(), observed.output(),
                            observed.truncated(), observed.reports(), cleanupConfirmed);
                    }
                }
                if (!clock.instant().isBefore(waitDeadline)) {
                    // Budget exhausted: the same finish path as close — collect the observable
                    // log, delete by the original identity, confirm everything is 404. No exit
                    // code is invented for a build whose termination was never observed.
                    BoundedText log = collectRemainingLog(request, jobName, jobUid, podUid);
                    boolean cleanupConfirmed = cleanup(jobName, jobUid, request.commandId());
                    return new AgentContracts.BuildResult(
                        new AgentContracts.BuildIdentity(jobName, jobUid, podUid), null,
                        "BUILD_WAIT_BUDGET_EXCEEDED", log.text(), log.truncated(),
                        parseReports(log.text()), cleanupConfirmed);
                }
                sleep();
            }
        } catch (WaitInterruptedException interrupted) {
            finishAfterInterrupt(request, jobName, jobUid, podUid);
            throw new IllegalStateException("interrupted while waiting for the development build", interrupted);
        } catch (KubernetesClientException apiFailure) {
            if (!Thread.currentThread().isInterrupted()) {
                throw apiFailure;
            }
            // The wait was interrupted while an API read was in flight and the client aborted
            // the call: the finish path must still run before the interruption propagates.
            finishAfterInterrupt(request, jobName, jobUid, podUid);
            throw new IllegalStateException("interrupted while waiting for the development build", apiFailure);
        }
    }

    /**
     * Best-effort shared finish for a dead caller: the observable log is collected BEFORE
     * anything is deleted, then the build is finished by its original identity. The still-
     * pending interrupt flag is cleared for the finish path's own API calls and waits, and
     * restored afterwards.
     */
    private void finishAfterInterrupt(AgentContracts.BuildRequest request, String jobName,
                                      String jobUid, String podUid) {
        boolean pending = Thread.interrupted();
        try {
            collectRemainingLog(request, jobName, jobUid, podUid);
            cleanup(jobName, jobUid, request.commandId());
        } finally {
            if (pending) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /**
     * Resolves the workspace volume this project's PVC binds to and requires it to be an NFS
     * volume: the development build reads its source through a dedicated NFS volume because
     * this stage's cluster cannot mix a read-only and a read-write mount of one PVC, and its
     * workspaces are NFS-backed. Anything else — a missing claim, a claim without a bound
     * volume, a vanished PV or a non-NFS PV — fails closed: the build never starts on a
     * source this manifest cannot mount read-only.
     */
    private JobResourceFactory.DevelopmentSourceVolume developmentSourceVolume(String projectId) {
        String claimName = WorkspaceResourceFactory.pvcName(projectId);
        var pvc = client.persistentVolumeClaims().inNamespace(namespace).withName(claimName).get();
        String volumeName = pvc == null || pvc.getSpec() == null ? null : pvc.getSpec().getVolumeName();
        if (volumeName == null || volumeName.isBlank()) {
            throw new IllegalStateException("development build requires an NFS-backed workspace volume: "
                + claimName + " has no bound volume");
        }
        var pv = client.persistentVolumes().withName(volumeName).get();
        if (pv == null || pv.getSpec() == null || pv.getSpec().getNfs() == null) {
            throw new IllegalStateException("development build requires an NFS-backed workspace volume: "
                + claimName + " is bound to " + volumeName + ", which is not NFS-backed");
        }
        return new JobResourceFactory.DevelopmentSourceVolume(
            pv.getSpec().getNfs().getServer(), pv.getSpec().getNfs().getPath());
    }

    /**
     * Creates the development job once; a create race (409) is re-verified instead of retried
     * blindly, so a fuzzy create can never produce a second job for the same commandId.
     */
    private Job createJob(AgentContracts.BuildRequest request, JobResourceFactory.DevelopmentSourceVolume source) {
        String jobName = JobResourceFactory.developmentJobName(request.commandId());
        try {
            client.batch().v1().jobs().inNamespace(namespace)
                .resource(factory.createDevelopmentJob(request, source)).create();
        } catch (KubernetesClientException ex) {
            if (ex.getCode() != 409) {
                throw ex;
            }
        }
        Job job = verifiedJob(jobName, request);
        if (job == null) {
            throw new IllegalStateException("development build job could not be ensured");
        }
        return job;
    }

    /** Re-reads the job every poll; its labels must still match and its UID must never change. */
    private Job currentJob(String jobName, String expectedUid, AgentContracts.BuildRequest request) {
        Job job = verifiedJob(jobName, request);
        if (job != null && expectedUid != null && !expectedUid.equals(uid(job))) {
            // A recreated job under the same name is a different build: its evidence can never
            // settle this call.
            throw new IllegalStateException("the build job identity changed during the wait");
        }
        return job;
    }

    /** An existing job is reused only when every identity label matches this build request. */
    private Job verifiedJob(String jobName, AgentContracts.BuildRequest request) {
        Job job = client.batch().v1().jobs().inNamespace(namespace).withName(jobName).get();
        if (job == null) {
            return null;
        }
        var labels = job.getMetadata() == null ? null : job.getMetadata().getLabels();
        if (labels == null
            || !request.projectId().equals(labels.get(WorkspaceResourceFactory.LABEL_PROJECT_ID))
            || !request.commandId().equals(labels.get(JobResourceFactory.LABEL_TOOL_CALL_ID))
            || !JobResourceFactory.COMPONENT_DEVELOPMENT_BUILD.equals(labels.get(JobResourceFactory.LABEL_COMPONENT))) {
            throw new IllegalStateException("existing job does not match the build identity");
        }
        return job;
    }

    /**
     * The claimed pod is the verified single pod of this build: owned by the verified job and,
     * once a pod UID is bound, exactly that pod — a replacement pod is an identity failure that
     * never settles.
     */
    private Pod claimedPod(List<Pod> pods, String jobUid, String boundPodUid) {
        if (boundPodUid != null) {
            return pods.stream()
                .filter(pod -> boundPodUid.equals(uid(pod)))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("the bound build pod is no longer observable"));
        }
        if (pods.isEmpty()) {
            return null;
        }
        if (pods.size() > 1) {
            throw new IllegalStateException("ambiguous build pods for one tool call");
        }
        Pod pod = pods.get(0);
        if (!ownedByJob(pod, jobUid)) {
            throw new IllegalStateException("build pod is not owned by the verified build job");
        }
        return pod;
    }

    private Observation terminalObservation(Job job, Pod pod) {
        Optional<ContainerStateTerminated> init = terminated(pod, true, SOURCE_COPY_CONTAINER);
        if (init.isPresent() && init.get().getExitCode() != null && init.get().getExitCode() != 0) {
            BoundedText log = boundedLog(podName(pod), SOURCE_COPY_CONTAINER);
            return new Observation(init.get().getExitCode(), "SourceCopyFailed",
                log.text(), log.truncated(), List.of());
        }
        Optional<ContainerStateTerminated> main = terminated(pod, false, ResourceIdentityVerifier.APPLICATION_CONTAINER);
        if (main.isPresent()) {
            BoundedText log = boundedLog(podName(pod), ResourceIdentityVerifier.APPLICATION_CONTAINER);
            boolean deadlineExceeded = deadlineExceeded(job);
            String reason = deadlineExceeded ? "DeadlineExceeded"
                : (main.get().getReason() == null || main.get().getReason().isBlank()
                    ? "Completed" : main.get().getReason());
            return new Observation(main.get().getExitCode(), reason,
                log.text(), log.truncated(), parseReports(log.text()));
        }
        if (deadlineExceeded(job)) {
            // The deadline killed the build before the container reported a termination.
            return new Observation(null, "DeadlineExceeded", "", false, List.of());
        }
        return null;
    }

    /**
     * Deletes this build's pods and job, then confirms both are 404. Every delete is bound to
     * the identity verified in the same breath: the job is deleted through a request carrying
     * the verified object's resourceVersion as a server-side delete precondition, and only
     * pods still owned by the verified job are deleted at all. A 409 conflict from a delete
     * is retried a bounded number of times on a freshly re-read object whose identity is
     * re-verified first: the job and pod controllers' own status writes bump the
     * resourceVersion between the read and the delete, and those benign conflicts retry
     * through with the new version, while a same-name replacement (a different uid on
     * re-read) is refused untouched. Anything less than a fully confirmed 404 — a persistent
     * conflict, a delete error, a pod stuck terminating, a replacement appearing — is
     * reported unconfirmed. Package-private so the precondition contract is directly
     * testable.
     */
    boolean cleanup(String jobName, String jobUid, String commandId) {
        try {
            Job job = client.batch().v1().jobs().inNamespace(namespace).withName(jobName).get();
            if (job != null && (jobUid == null || !jobUid.equals(uid(job)))) {
                // A live job that does not carry the recorded UID belongs to a different
                // build: this call refuses to touch it and stays unconfirmed.
                return false;
            }
            deleteOwnedPods(jobUid, commandId);
            if (job != null && !deleteVerifiedJob(jobName, jobUid, job)) {
                return false;
            }
            Instant deadline = clock.instant().plusSeconds(cleanupWaitSeconds);
            while (clock.instant().isBefore(deadline)) {
                Job current = client.batch().v1().jobs().inNamespace(namespace).withName(jobName).get();
                if (current != null) {
                    if (jobUid == null || !jobUid.equals(uid(current))) {
                        return false;
                    }
                    // Our own job is still terminating; keep waiting for its 404.
                } else if (buildPods(commandId).isEmpty()) {
                    return true;
                }
                sleep();
            }
            return false;
        } catch (RuntimeException ex) {
            return false;
        }
    }

    /**
     * Deletes the verified job through a request carrying its resourceVersion as a
     * server-side delete precondition. A 409 conflict does not by itself mean the job was
     * replaced: the job controller's own status writes (Failed/Complete conditions) bump the
     * resourceVersion between the read above and this delete. Every conflict is therefore
     * retried a bounded number of times on a freshly re-read object — and the re-read
     * re-verifies the UID before the retry, so a same-name replacement (a different UID) is
     * refused instead of retried while the job's own benign status writes retry through with
     * the new resourceVersion. A job that vanished before the re-read is left to the 404
     * confirmation loop in {@link #cleanup}.
     */
    private boolean deleteVerifiedJob(String jobName, String jobUid, Job verified) {
        Job current = verified;
        for (int attempt = 0; attempt <= DELETE_CONFLICT_RETRIES; attempt++) {
            if (attempt > 0) {
                sleep();
            }
            try {
                jobOperation(jobName).withResourceVersion(resourceVersion(current)).delete();
                return true;
            } catch (KubernetesClientException ex) {
                if (ex.getCode() != 409) {
                    return false;
                }
                current = client.batch().v1().jobs().inNamespace(namespace).withName(jobName).get();
                if (current == null) {
                    return true;
                }
                if (jobUid == null || !jobUid.equals(uid(current))) {
                    return false;
                }
            }
        }
        return false;
    }

    /**
     * Deletes exactly the pods still owned by the verified job, each through a request
     * carrying that pod's own resourceVersion as a server-side delete precondition (a 409
     * conflict is retried after a re-read re-verifies the ownership — see
     * {@link #deleteVerifiedOwnedPod}). A pod carrying this build's tool-call label but owned
     * by a different job is another build's evidence and is never touched; with no recorded
     * UID nothing is attributable and nothing is deleted (fail closed).
     */
    private void deleteOwnedPods(String jobUid, String commandId) {
        for (Pod pod : buildPods(commandId)) {
            if (jobUid == null || !ownedByJob(pod, jobUid)) {
                continue;
            }
            deleteVerifiedOwnedPod(pod, jobUid);
        }
    }

    /**
     * Deletes one owned pod through a request carrying its resourceVersion as a server-side
     * delete precondition. A 409 conflict is retried the way the job delete is: the pod's
     * own status writes (terminal states, deletion progress) bump the resourceVersion
     * between the list and this delete, so every retry first re-reads the pod and re-verifies
     * it is still owned by the verified job. A pod that vanished before the re-read is
     * already gone; a pod the re-read no longer attributes to this job is refused — the
     * failure propagates so {@link #cleanup} reports the cleanup unconfirmed.
     */
    private void deleteVerifiedOwnedPod(Pod verified, String jobUid) {
        Pod current = verified;
        for (int attempt = 0; attempt <= DELETE_CONFLICT_RETRIES; attempt++) {
            if (attempt > 0) {
                sleep();
            }
            try {
                podOperation(podName(current)).withResourceVersion(resourceVersion(current)).delete();
                return;
            } catch (KubernetesClientException ex) {
                if (ex.getCode() != 409) {
                    throw ex;
                }
                current = client.pods().inNamespace(namespace).withName(podName(current)).get();
                if (current == null) {
                    return;
                }
                if (!ownedByJob(current, jobUid)) {
                    throw new IllegalStateException("build pod is not owned by the verified build job");
                }
            }
        }
        throw new IllegalStateException("the owned build pod delete stayed in conflict");
    }

    /**
     * The concrete job operation for one name: only the implementation class exposes
     * {@code withResourceVersion}, which the delete needs to carry the verified object's
     * resourceVersion as a server-side delete precondition.
     */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private BaseOperation<Job, ?, ?> jobOperation(String jobName) {
        return (BaseOperation) client.batch().v1().jobs().inNamespace(namespace).withName(jobName);
    }

    /** The concrete pod operation for one name; see {@link #jobOperation(String)}. */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private BaseOperation<Pod, ?, ?> podOperation(String podName) {
        return (BaseOperation) client.pods().inNamespace(namespace).withName(podName);
    }

    private static boolean ownedByJob(Pod pod, String jobUid) {
        return pod.getMetadata() != null && pod.getMetadata().getOwnerReferences() != null
            && pod.getMetadata().getOwnerReferences().stream()
                .anyMatch(owner -> jobUid.equals(owner.getUid()));
    }

    private static String resourceVersion(io.fabric8.kubernetes.api.model.HasMetadata resource) {
        return resource.getMetadata() == null ? null : resource.getMetadata().getResourceVersion();
    }

    /**
     * Best-effort log collection for the shared finish path: whatever the main container still
     * shows is taken bounded; any failure leaves the tail empty and never blocks the cleanup.
     */
    private BoundedText collectRemainingLog(AgentContracts.BuildRequest request, String jobName,
                                            String jobUid, String podUid) {
        try {
            Pod pod = observablePod(buildPods(request.commandId()), jobUid, podUid);
            if (pod == null) {
                return new BoundedText("", false);
            }
            return boundedLog(podName(pod), ResourceIdentityVerifier.APPLICATION_CONTAINER);
        } catch (RuntimeException ex) {
            return new BoundedText("", false);
        }
    }

    /** The pod whose log the finish path may still collect, or null when none is trustworthy. */
    private Pod observablePod(List<Pod> pods, String jobUid, String podUid) {
        if (pods.isEmpty()) {
            return null;
        }
        if (podUid != null) {
            return pods.stream().filter(pod -> podUid.equals(uid(pod))).findFirst().orElse(null);
        }
        if (pods.size() > 1) {
            return null;
        }
        Pod pod = pods.get(0);
        boolean owned = pod.getMetadata() != null && pod.getMetadata().getOwnerReferences() != null
            && pod.getMetadata().getOwnerReferences().stream()
                .anyMatch(owner -> jobUid == null || jobUid.equals(owner.getUid()));
        return owned ? pod : null;
    }

    private List<Pod> buildPods(String commandId) {
        List<Pod> pods = client.pods().inNamespace(namespace)
            .withLabel(JobResourceFactory.LABEL_TOOL_CALL_ID, commandId).list().getItems();
        return pods == null ? List.of() : pods;
    }

    private BoundedText boundedLog(String podName, String container) {
        // The transport read is byte-bounded (limitBytes) and the kept text is additionally
        // capped at the output limit in UTF-8 bytes: a huge Maven log can never reach the
        // backend unbounded, and the cut never splits a multi-byte character.
        String log = client.pods().inNamespace(namespace).withName(podName)
            .inContainer(container)
            .limitBytes(LOG_FETCH_LIMIT_BYTES)
            .getLog();
        return boundedTail(log);
    }

    /** Keeps the tail of the log within the UTF-8 byte budget, cut on a character boundary. */
    static BoundedText boundedTail(String log) {
        byte[] bytes = log.getBytes(StandardCharsets.UTF_8);
        if (bytes.length <= MAX_OUTPUT_BYTES) {
            return new BoundedText(log, false);
        }
        int start = bytes.length - MAX_OUTPUT_BYTES;
        while (start < bytes.length && isUtf8Continuation(bytes[start])) {
            start++;
        }
        return new BoundedText(new String(bytes, start, bytes.length - start, StandardCharsets.UTF_8), true);
    }

    private static boolean isUtf8Continuation(byte b) {
        return (b & 0xC0) == 0x80;
    }

    /**
     * Parses the bounded Surefire XML the launcher appended between the fixed markers. The
     * parser refuses DTDs and external entities; a document that cannot be parsed stays absent
     * from the report list — a missing report is never read as a passing one.
     */
    static List<AgentContracts.TestReport> parseReports(String output) {
        if (output == null) {
            return List.of();
        }
        int begin = output.lastIndexOf(REPORT_BEGIN);
        if (begin < 0) {
            return List.of();
        }
        int end = output.indexOf(REPORT_END, begin);
        if (end < 0) {
            return List.of();
        }
        List<AgentContracts.TestReport> reports = new ArrayList<>();
        for (String document : xmlDocuments(output.substring(begin + REPORT_BEGIN.length(), end))) {
            try {
                reports.add(toReport(document));
            } catch (Exception ignored) {
                // Unknown evidence stays unknown; the real exit code is reported unchanged.
            }
        }
        return List.copyOf(reports);
    }

    /** Splits the concatenated Surefire documents on their XML declarations. */
    private static List<String> xmlDocuments(String segment) {
        List<String> documents = new ArrayList<>();
        int index = segment.indexOf("<?xml");
        while (index >= 0) {
            int next = segment.indexOf("<?xml", index + 1);
            String document = segment.substring(index, next < 0 ? segment.length() : next);
            if (document.endsWith("\n")) {
                document = document.substring(0, document.length() - 1);
            }
            documents.add(document);
            index = next;
        }
        if (documents.isEmpty() && !segment.isBlank()) {
            documents.add(segment.strip());
        }
        return documents;
    }

    private static AgentContracts.TestReport toReport(String document) throws Exception {
        DocumentBuilderFactory builderFactory = DocumentBuilderFactory.newInstance();
        builderFactory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        builderFactory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        builderFactory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        builderFactory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        builderFactory.setXIncludeAware(false);
        builderFactory.setExpandEntityReferences(false);
        var root = builderFactory.newDocumentBuilder()
            .parse(new InputSource(new StringReader(document))).getDocumentElement();
        if (!"testsuite".equals(root.getTagName())) {
            throw new IllegalArgumentException("not a surefire testsuite document");
        }
        String testClass = root.getAttribute("name");
        if (testClass == null || testClass.isBlank()) {
            throw new IllegalArgumentException("surefire testsuite without a class name");
        }
        return new AgentContracts.TestReport(testClass,
            intAttribute(root, "tests"), intAttribute(root, "failures"),
            intAttribute(root, "errors"), intAttribute(root, "skipped"), sha256Hex(document));
    }

    private static int intAttribute(org.w3c.dom.Element element, String name) {
        String value = element.getAttribute(name);
        if (value == null || value.isBlank()) {
            return 0;
        }
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException ex) {
            throw new IllegalArgumentException("surefire attribute " + name + " is not a number");
        }
    }

    private static Optional<ContainerStateTerminated> terminated(Pod pod, boolean initContainer, String containerName) {
        if (pod.getStatus() == null) {
            return Optional.empty();
        }
        var statuses = initContainer
            ? pod.getStatus().getInitContainerStatuses()
            : pod.getStatus().getContainerStatuses();
        if (statuses == null) {
            return Optional.empty();
        }
        return statuses.stream()
            .filter(status -> containerName.equals(status.getName()))
            .map(status -> status.getState() == null ? null : status.getState().getTerminated())
            .filter(Objects::nonNull)
            .findFirst();
    }

    private static boolean deadlineExceeded(Job job) {
        var status = job.getStatus();
        return status != null && status.getConditions() != null && status.getConditions().stream()
            .anyMatch(condition -> "Failed".equals(condition.getType())
                && "DeadlineExceeded".equals(condition.getReason())
                && "True".equals(condition.getStatus()));
    }

    private void bindIdentity(AgentContracts.BuildRequest request, String jobName, String jobUid, String podUid) {
        if (identityListener != null) {
            identityListener.accept(request, new AgentContracts.BuildIdentity(jobName, jobUid, podUid));
        }
    }

    private void sleep() {
        try {
            Thread.sleep(pollMillis);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new WaitInterruptedException(ex);
        }
    }

    private static String podName(Pod pod) {
        return pod.getMetadata() == null ? null : pod.getMetadata().getName();
    }

    private static String uid(Job job) {
        return job.getMetadata() == null ? null : job.getMetadata().getUid();
    }

    private static String uid(Pod pod) {
        return pod.getMetadata() == null ? null : pod.getMetadata().getUid();
    }

    private static String sha256Hex(String content) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256")
                .digest(content.getBytes(StandardCharsets.UTF_8))) {
                builder.append(String.format("%02x", b));
            }
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException("SHA-256 is unavailable", ex);
        }
    }
}
