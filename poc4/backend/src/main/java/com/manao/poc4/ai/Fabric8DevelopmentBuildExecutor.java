package com.manao.poc4.ai;

import com.manao.poc4.kubernetes.JobResourceFactory;
import com.manao.poc4.kubernetes.ResourceIdentityVerifier;
import com.manao.poc4.kubernetes.WorkspaceResourceFactory;
import io.fabric8.kubernetes.api.model.ContainerStateTerminated;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientException;
import java.io.StringReader;
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
 * from the durable commandId, an existing job is only ever queried and reused (a fuzzy create
 * never produces a second job), and a fresh commandId creates it. The executor then observes the
 * real termination — the container's own exit code and reason, never a fabricated zero — reads a
 * bounded log tail, parses the Surefire XML the fixed launcher appended between markers (hardened
 * parser: no DTD, no external entities; unreadable reports stay missing instead of becoming
 * passes), and only then deletes the Job and its Pods. The result settles only when the Job and
 * every associated Pod are confirmed 404; identity mismatches, Forbidden reads and unconfirmed
 * cleanup never settle and keep the project occupied for the close path. Waiting holds no
 * database transaction and no thread gate — only short API reads and the identity listener
 * callbacks. Sources are never written: the build runs on the init container's read-only copy.
 */
public final class Fabric8DevelopmentBuildExecutor implements DevelopmentBuildExecutor {
    /** The fixed log markers the root-owned {@code manao-dev-build} launcher appends. */
    public static final String REPORT_BEGIN = "MANAO-SUREFIRE-REPORT-BEGIN";
    public static final String REPORT_END = "MANAO-SUREFIRE-REPORT-END";
    /** The bounded build output kept in memory and handed to the tools layer. */
    static final int MAX_OUTPUT_CHARS = 128 * 1024;
    /** The transport-level log fetch bound (server-side limitBytes). */
    static final int LOG_FETCH_LIMIT_BYTES = 512 * 1024;

    private static final long DEFAULT_POLL_MILLIS = 2000;
    private static final long DEFAULT_WAIT_BUDGET_SECONDS = 720;   // 600s build deadline + 120s finish
    private static final long DEFAULT_CLEANUP_WAIT_SECONDS = 120;
    private static final String SOURCE_COPY_CONTAINER = "source-copy";

    private final KubernetesClient client;
    private final JobResourceFactory factory;
    private final String namespace;
    private final BiConsumer<AgentContracts.BuildRequest, AgentContracts.BuildIdentity> identityListener;
    private final Clock clock;
    private final long pollMillis;
    private final long waitBudgetSeconds;
    private final long cleanupWaitSeconds;

    public Fabric8DevelopmentBuildExecutor(KubernetesClient client, JobResourceFactory factory, String namespace,
                                           BiConsumer<AgentContracts.BuildRequest, AgentContracts.BuildIdentity> identityListener) {
        this(client, factory, namespace, identityListener, Clock.systemUTC(),
            DEFAULT_POLL_MILLIS, DEFAULT_WAIT_BUDGET_SECONDS, DEFAULT_CLEANUP_WAIT_SECONDS);
    }

    Fabric8DevelopmentBuildExecutor(KubernetesClient client, JobResourceFactory factory, String namespace,
                                    BiConsumer<AgentContracts.BuildRequest, AgentContracts.BuildIdentity> identityListener,
                                    Clock clock, long pollMillis, long waitBudgetSeconds, long cleanupWaitSeconds) {
        this.client = Objects.requireNonNull(client, "client");
        this.factory = Objects.requireNonNull(factory, "factory");
        this.namespace = Objects.requireNonNull(namespace, "namespace");
        this.identityListener = identityListener;
        this.clock = clock == null ? Clock.systemUTC() : clock;
        this.pollMillis = pollMillis;
        this.waitBudgetSeconds = waitBudgetSeconds;
        this.cleanupWaitSeconds = cleanupWaitSeconds;
    }

    private record Observation(Integer exitCode, String terminationReason, String output,
                               boolean truncated, List<AgentContracts.TestReport> reports) { }

    private record BoundedText(String text, boolean truncated) { }

    @Override public AgentContracts.BuildResult build(AgentContracts.BuildRequest request) {
        String jobName = JobResourceFactory.developmentJobName(request.commandId());
        Job job = verifiedJob(jobName, request);
        if (job == null && !buildPods(request.commandId()).isEmpty()) {
            // Lingering pod evidence without its job: the identity chain cannot be verified, so
            // no second job is created and the evidence stays in place for reconciliation.
            return new AgentContracts.BuildResult(
                new AgentContracts.BuildIdentity(jobName, null, null), null,
                "BUILD_IDENTITY_UNVERIFIABLE", "", false, List.of(), false);
        }
        if (job == null) {
            job = createJob(request);
        }
        String jobUid = uid(job);
        bindIdentity(request, jobName, jobUid, null);
        String podUid = null;

        Instant waitDeadline = clock.instant().plusSeconds(waitBudgetSeconds);
        while (true) {
            job = currentJob(jobName, request);
            if (job == null) {
                // The job is gone: evidence can only be trusted while a verified pod chain remains.
                List<Pod> pods = buildPods(request.commandId());
                if (pods.isEmpty()) {
                    return new AgentContracts.BuildResult(
                        new AgentContracts.BuildIdentity(jobName, jobUid, podUid), null,
                        "BUILD_EVIDENCE_UNAVAILABLE", "", false, List.of(), true);
                }
                return new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity(jobName, jobUid, podUid), null,
                    "BUILD_IDENTITY_UNVERIFIABLE", "", false, List.of(), false);
            }
            Pod pod = claimedPod(buildPods(request.commandId()), jobUid, podUid);
            if (pod != null) {
                if (podUid == null) {
                    podUid = uid(pod);
                    bindIdentity(request, jobName, jobUid, podUid);
                }
                Observation observed = terminalObservation(job, pod);
                if (observed != null) {
                    boolean cleanupConfirmed = cleanup(jobName, request.commandId());
                    return new AgentContracts.BuildResult(
                        new AgentContracts.BuildIdentity(jobName, jobUid, podUid),
                        observed.exitCode(), observed.terminationReason(), observed.output(),
                        observed.truncated(), observed.reports(), cleanupConfirmed);
                }
            }
            if (!clock.instant().isBefore(waitDeadline)) {
                // Unobservable build: the job stays in place for the close path, never settled.
                return new AgentContracts.BuildResult(
                    new AgentContracts.BuildIdentity(jobName, jobUid, podUid), null,
                    "BUILD_WAIT_BUDGET_EXCEEDED", "", false, List.of(), false);
            }
            sleep();
        }
    }

    /**
     * Creates the development job once; a create race (409) is re-verified instead of retried
     * blindly, so a fuzzy create can never produce a second job for the same commandId.
     */
    private Job createJob(AgentContracts.BuildRequest request) {
        String jobName = JobResourceFactory.developmentJobName(request.commandId());
        try {
            client.batch().v1().jobs().inNamespace(namespace)
                .resource(factory.createDevelopmentJob(request)).create();
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

    private Job currentJob(String jobName, AgentContracts.BuildRequest request) {
        return verifiedJob(jobName, request);
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
        boolean owned = pod.getMetadata() != null && pod.getMetadata().getOwnerReferences() != null
            && pod.getMetadata().getOwnerReferences().stream()
                .anyMatch(owner -> jobUid.equals(owner.getUid()));
        if (!owned) {
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
     * Deletes the job and every pod carrying the tool-call identity, then confirms both are 404.
     * Anything less — a delete error, a pod stuck terminating — is reported as unconfirmed and
     * never treated as a finished cleanup.
     */
    private boolean cleanup(String jobName, String commandId) {
        try {
            client.batch().v1().jobs().inNamespace(namespace).withName(jobName).delete();
            client.pods().inNamespace(namespace)
                .withLabel(JobResourceFactory.LABEL_TOOL_CALL_ID, commandId).delete();
            Instant deadline = clock.instant().plusSeconds(cleanupWaitSeconds);
            while (clock.instant().isBefore(deadline)) {
                if (client.batch().v1().jobs().inNamespace(namespace).withName(jobName).get() == null
                    && buildPods(commandId).isEmpty()) {
                    return true;
                }
                sleep();
            }
            return false;
        } catch (RuntimeException ex) {
            return false;
        }
    }

    private List<Pod> buildPods(String commandId) {
        List<Pod> pods = client.pods().inNamespace(namespace)
            .withLabel(JobResourceFactory.LABEL_TOOL_CALL_ID, commandId).list().getItems();
        return pods == null ? List.of() : pods;
    }

    private BoundedText boundedLog(String podName, String container) {
        // The transport read is byte-bounded (limitBytes) and the kept text is additionally
        // capped at the output limit: a huge Maven log can never reach the backend unbounded.
        String log = client.pods().inNamespace(namespace).withName(podName)
            .inContainer(container)
            .limitBytes(LOG_FETCH_LIMIT_BYTES)
            .getLog();
        boolean truncated = log.length() > MAX_OUTPUT_CHARS;
        if (truncated) {
            log = log.substring(log.length() - MAX_OUTPUT_CHARS);
        }
        return new BoundedText(log, truncated);
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
            throw new IllegalStateException("interrupted while waiting for the development build", ex);
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
                .digest(content.getBytes(java.nio.charset.StandardCharsets.UTF_8))) {
                builder.append(String.format("%02x", b));
            }
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException("SHA-256 is unavailable", ex);
        }
    }
}
