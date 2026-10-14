package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.ai.AgentContracts.BuildGoal;
import com.manao.poc4.ai.AgentContracts.BuildIdentity;
import com.manao.poc4.ai.AgentContracts.BuildRequest;
import com.manao.poc4.ai.AgentContracts.BuildResult;
import com.manao.poc4.ai.AgentContracts.TestReport;
import com.manao.poc4.kubernetes.JobResourceFactory;
import io.fabric8.kubernetes.api.model.ContainerStatusBuilder;
import io.fabric8.kubernetes.api.model.OwnerReferenceBuilder;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PodBuilder;
import io.fabric8.kubernetes.api.model.PodStatusBuilder;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientException;
import io.fabric8.kubernetes.client.server.mock.KubernetesCrudDispatcher;
import io.fabric8.kubernetes.client.server.mock.KubernetesMockServer;
import io.fabric8.mockwebserver.Context;
import io.fabric8.mockwebserver.MockWebServer;
import io.fabric8.mockwebserver.http.MockResponse;
import io.fabric8.mockwebserver.http.RecordedRequest;
import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Mock-server behavior of the Fabric8 development build executor: it creates or reuses exactly
 * one identity-verified Job per commandId, reports the real termination (never a fabricated
 * exit code), parses the bounded Surefire tail, and settles only after the Job and its Pods
 * are confirmed gone. Identity problems, Forbidden reads and unconfirmed cleanup never settle.
 */
class DevelopmentBuildExecutorTest {
    private static final String NS = "manao";
    private static final String TASK = "task-1";
    private static final String CALL = "call-1";
    private static final String PROJECT = "prj-1";
    private static final String COMMAND = "0f2b1c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
    private static final String IMAGE = "registry.example/manao/maven-runner@sha256:"
        + "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private static final String INIT_IMAGE = "registry.example/manao/busybox@sha256:"
        + "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    private static final Pattern POD_LOG = Pattern.compile("/pods/([^/]+)/log(\\?.*)?$");

    private static final String SUREFIRE_XML = """
        <?xml version="1.0" encoding="UTF-8"?>
        <testsuite name="com.example.app.AppTest" tests="1" failures="1" errors="0" skipped="0">
          <testcase name="greets" classname="com.example.app.AppTest">
            <failure message="expected Hello from Manao but was broken">at AppTest.greets</failure>
          </testcase>
        </testsuite>
        """;

    KubernetesMockServer server;
    KubernetesClient client;
    LogAwareCrudDispatcher dispatcher;
    List<BuildIdentity> boundIdentities;
    Fabric8DevelopmentBuildExecutor executor;
    JobResourceFactory factory;

    /** Serves the pod log endpoints the crud store does not know, including a stubbed 403. */
    private static final class LogAwareCrudDispatcher extends KubernetesCrudDispatcher {
        final Map<String, MockResponse> logs = new HashMap<>();
        /**
         * When set, DELETEs for this job are answered with a 409 conflict — the server-side
         * representation of "the verified object was replaced between the check and the
         * delete" — and the delete request bodies are recorded for the precondition
         * assertion.
         */
        String conflictJobDelete;
        final List<String> jobDeleteBodies = new ArrayList<>();

        @Override public MockResponse dispatch(RecordedRequest request) {
            if ("GET".equals(request.getMethod()) && request.getPath() != null) {
                Matcher matcher = POD_LOG.matcher(request.getPath());
                if (matcher.find()) {
                    String container = containerParam(matcher.group(2));
                    MockResponse response = logs.get(matcher.group(1) + "|" + container);
                    if (response != null) {
                        return response;
                    }
                }
            }
            if ("DELETE".equals(request.getMethod()) && request.getPath() != null
                && conflictJobDelete != null && request.getPath().endsWith("/jobs/" + conflictJobDelete)) {
                jobDeleteBodies.add(request.getBody().readUtf8());
                return new MockResponse().setResponseCode(409);
            }
            return super.dispatch(request);
        }

        private static String containerParam(String query) {
            if (query == null || query.isBlank()) {
                return "";
            }
            for (String param : query.replaceFirst("^\\?", "").split("&")) {
                if (param.startsWith("container=")) {
                    return param.substring("container=".length());
                }
            }
            return "";
        }
    }

    @BeforeEach
    void setUp() {
        dispatcher = new LogAwareCrudDispatcher();
        server = new KubernetesMockServer(new Context(), new MockWebServer(), new HashMap<>(), dispatcher, false);
        server.init();
        client = server.createClient();
        boundIdentities = new ArrayList<>();
        factory = new JobResourceFactory(NS, 1800, INIT_IMAGE,
            new JobResourceFactory.RunResources(500, 1024L * 1024 * 1024, 1024L * 1024 * 1024),
            new JobResourceFactory.RunResources(8000, 16L * 1024 * 1024 * 1024, 10L * 1024 * 1024 * 1024),
            IMAGE, "registry.example/manao/python-runner@sha256:" + "b".repeat(64));
        executor = new Fabric8DevelopmentBuildExecutor(client, factory, NS, (ignored, identity) -> boundIdentities.add(identity),
            request -> true, Clock.systemUTC(), 10, 5, 5);
    }

    @AfterEach
    void tearDown() {
        server.destroy();
    }

    private static BuildRequest request() {
        return new BuildRequest(TASK, CALL, PROJECT, COMMAND, 7L, BuildGoal.TEST);
    }

    private Job seedJob() {
        Job job = factory.createDevelopmentJob(request());
        client.batch().v1().jobs().inNamespace(NS).resource(job).create();
        return client.batch().v1().jobs().inNamespace(NS).withName(job.getMetadata().getName()).get();
    }

    private Pod seedPod(String jobName, String jobUid, Integer exitCode, String reason) {
        var pod = new PodBuilder().withNewMetadata()
            .withName(jobName + "-pod")
            .withLabels(Map.of(JobResourceFactory.LABEL_TOOL_CALL_ID, COMMAND,
                "manao.poc4/project-id", PROJECT))
            .withOwnerReferences(new OwnerReferenceBuilder().withApiVersion("batch/v1").withKind("Job")
                .withName(jobName).withUid(jobUid).withController(true).build())
            .endMetadata()
            .withNewSpec().endSpec()
            .build();
        if (exitCode != null) {
            pod.setStatus(new PodStatusBuilder().withPhase("Failed")
                .withContainerStatuses(new ContainerStatusBuilder().withName("maven")
                    .withNewState().withNewTerminated().withExitCode(exitCode).withReason(reason)
                    .withFinishedAt("2026-10-13T00:01:00Z").endTerminated().endState()
                    .build())
                .build());
        } else {
            pod.setStatus(new PodStatusBuilder().withPhase("Pending").build());
        }
        client.pods().inNamespace(NS).resource(pod).create();
        return client.pods().inNamespace(NS).withName(pod.getMetadata().getName()).get();
    }

    private void seedLog(String podName, String log) {
        seedLog(podName, "maven", log);
    }

    private void seedLog(String podName, String container, String log) {
        dispatcher.logs.put(podName + "|" + container, new MockResponse().setResponseCode(200).setBody(log));
    }

    private static String buildLog(String surefire) {
        return "[INFO] Scanning for projects...\n[ERROR] BUILD FAILURE\n"
            + Fabric8DevelopmentBuildExecutor.REPORT_BEGIN + "\n" + surefire
            + Fabric8DevelopmentBuildExecutor.REPORT_END + " truncated=0 files=1\n";
    }

    @Test
    void reportsTheRealFailureThenConfirmsTheCleanup() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 1, "Error");
        seedLog(pod.getMetadata().getName(), buildLog(SUREFIRE_XML));

        BuildResult result = executor.build(request());

        assertThat(result.exitCode()).isEqualTo(1);
        assertThat(result.terminationReason()).isEqualTo("Error");
        assertThat(result.output()).contains("BUILD FAILURE").contains("MANAO-SUREFIRE-REPORT-BEGIN");
        assertThat(result.truncated()).isFalse();
        assertThat(result.testReports()).hasSize(1);
        TestReport report = result.testReports().get(0);
        assertThat(report.testClass()).isEqualTo("com.example.app.AppTest");
        assertThat(report.tests()).isEqualTo(1);
        assertThat(report.failures()).isEqualTo(1);
        assertThat(report.errors()).isZero();
        assertThat(report.skipped()).isZero();
        assertThat(report.sha256()).isEqualTo(sha256(SUREFIRE_XML.stripTrailing()));
        assertThat(result.cleanupConfirmed()).isTrue();
        assertThat(result.identity().jobUid()).isEqualTo(job.getMetadata().getUid());
        assertThat(result.identity().podUid()).isEqualTo(pod.getMetadata().getUid());
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get()).isNull();
        assertThat(client.pods().inNamespace(NS).withLabel(JobResourceFactory.LABEL_TOOL_CALL_ID, COMMAND)
            .list().getItems()).isEmpty();
        assertThat(boundIdentities).contains(result.identity());
    }

    @Test
    void aFreshCommandIdCreatesExactlyOneJobAndBindsItsIdentity() throws Exception {
        CompletableFuture<BuildResult> pending = CompletableFuture.supplyAsync(() -> executor.build(request()));
        String jobName = JobResourceFactory.developmentJobName(COMMAND);
        Job job = null;
        for (int i = 0; i < 300 && job == null; i++) {
            job = client.batch().v1().jobs().inNamespace(NS).withName(jobName).get();
            if (job == null) {
                Thread.sleep(20);
            }
        }
        assertThat(job).as("the executor must create the development job").isNotNull();
        Pod pod = seedPod(jobName, job.getMetadata().getUid(), 0, "Completed");
        seedLog(pod.getMetadata().getName(), "[INFO] BUILD SUCCESS\n"
            + Fabric8DevelopmentBuildExecutor.REPORT_BEGIN + "\n"
            + Fabric8DevelopmentBuildExecutor.REPORT_END + " truncated=0 files=0\n");

        BuildResult result = pending.get(30, TimeUnit.SECONDS);

        assertThat(result.exitCode()).isZero();
        assertThat(result.terminationReason()).isEqualTo("Completed");
        assertThat(result.testReports()).isEmpty();
        assertThat(result.cleanupConfirmed()).isTrue();
        assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).hasSize(0);
        assertThat(boundIdentities).contains(result.identity());
    }

    @Test
    void theSameCommandIdReusesTheExistingJobInsteadOfCreatingASecond() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 0, "Completed");
        seedLog(pod.getMetadata().getName(), "[INFO] BUILD SUCCESS\n");

        BuildResult result = executor.build(request());

        assertThat(result.exitCode()).isZero();
        assertThat(result.identity().jobUid()).isEqualTo(job.getMetadata().getUid());
        // The pre-existing job was queried and reused, never replaced by a second one.
        assertThat(boundIdentities).contains(result.identity());
        assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).isEmpty();
    }

    @Test
    void anOrphanedPodWithoutItsJobIsNeverSettledAsClean() {
        seedPod(JobResourceFactory.developmentJobName(COMMAND), "foreign-job-uid", 0, "Completed");

        BuildResult result = executor.build(request());

        // No Job means the identity chain cannot be verified: no exit code is invented and the
        // cleanup is reported unconfirmed while the evidence pod stays in place.
        assertThat(result.exitCode()).isNull();
        assertThat(result.cleanupConfirmed()).isFalse();
        assertThat(client.pods().inNamespace(NS).withLabel(JobResourceFactory.LABEL_TOOL_CALL_ID, COMMAND)
            .list().getItems()).hasSize(1);
        assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).isEmpty();
    }

    @Test
    void aPodNotOwnedByTheBuildJobIsRefusedWithoutAnyDeletion() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), "another-job-uid", 1, "Error");

        assertThatThrownBy(() -> executor.build(request())).isInstanceOf(IllegalStateException.class);
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get()).isNotNull();
        assertThat(client.pods().inNamespace(NS).withName(pod.getMetadata().getName()).get()).isNotNull();
        // The job identity may be bound, but the unverified pod identity never is.
        assertThat(boundIdentities).noneMatch(identity -> identity.podUid() != null);
    }

    @Test
    void aForbiddenLogReadNeverSettlesTheBuild() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 1, "Error");
        dispatcher.logs.put(pod.getMetadata().getName() + "|maven", new MockResponse().setResponseCode(403));

        assertThatThrownBy(() -> executor.build(request()))
            .isInstanceOf(KubernetesClientException.class);
        // Fail closed: the job was not touched because the evidence could not be collected.
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get()).isNotNull();
    }

    @Test
    void deadlineExceededNeverFillsAFakeExitCode() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), null, null);
        client.batch().v1().jobs().inNamespace(NS).withName(job.getMetadata().getName()).edit(current ->
            new io.fabric8.kubernetes.api.model.batch.v1.JobBuilder(current)
                .editOrNewStatus().addNewCondition().withType("Failed").withReason("DeadlineExceeded")
                .withStatus("True").endCondition().endStatus().build());

        BuildResult result = executor.build(request());

        assertThat(result.exitCode()).isNull();
        assertThat(result.terminationReason()).isEqualTo("DeadlineExceeded");
        assertThat(result.output()).isEmpty();
        assertThat(result.testReports()).isEmpty();
        assertThat(result.cleanupConfirmed()).isTrue();
        assertThat(client.pods().inNamespace(NS).withName(pod.getMetadata().getName()).get()).isNull();
    }

    @Test
    void truncatedOutputKeepsTheTailWithTheReportMarkers() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 1, "Error");
        seedLog(pod.getMetadata().getName(), "x".repeat(200 * 1024) + "\n" + buildLog(SUREFIRE_XML));

        BuildResult result = executor.build(request());

        assertThat(result.exitCode()).isEqualTo(1);
        assertThat(result.truncated()).isTrue();
        assertThat(result.output().length()).isLessThanOrEqualTo(128 * 1024);
        assertThat(result.output()).endsWith(Fabric8DevelopmentBuildExecutor.REPORT_END + " truncated=0 files=1\n");
        assertThat(result.testReports()).hasSize(1);
    }

    @Test
    void unreadableReportsStayMissingInsteadOfBecomingPasses() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 1, "Error");
        seedLog(pod.getMetadata().getName(), "[ERROR] BUILD FAILURE\n"
            + Fabric8DevelopmentBuildExecutor.REPORT_BEGIN + "\n"
            + "<testsuite name=\"broken\" tests=\"3><failure>unterminated attribute"
            + Fabric8DevelopmentBuildExecutor.REPORT_END + " truncated=0 files=1\n");

        BuildResult result = executor.build(request());

        assertThat(result.exitCode()).isEqualTo(1);
        assertThat(result.testReports()).isEmpty();
        assertThat(result.terminationReason()).isEqualTo("Error");
    }

    @Test
    void aBuildThatNeverSettlesInsideTheWaitBudgetIsFinishedLikeAClose() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), null, null);
        seedLog(pod.getMetadata().getName(), "[INFO] still compiling...\n");
        executor = new Fabric8DevelopmentBuildExecutor(client, factory, NS, (ignored, identity) -> boundIdentities.add(identity),
            request -> true, Clock.systemUTC(), 10, 1, 1);

        BuildResult result = executor.build(request());

        // Budget exhausted: the shared finish path ran — the observable log was collected, the
        // job and its pod were deleted by the original identity, and no exit code was invented.
        assertThat(result.exitCode()).isNull();
        assertThat(result.terminationReason()).isEqualTo("BUILD_WAIT_BUDGET_EXCEEDED");
        assertThat(result.output()).contains("still compiling");
        assertThat(result.cleanupConfirmed()).isTrue();
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get()).isNull();
        assertThat(client.pods().inNamespace(NS).withName(pod.getMetadata().getName()).get()).isNull();
    }

    @Test
    void aFailedSourceCopyIsReportedAsTheToolFailureItIs() {
        Job job = seedJob();
        var pod = new PodBuilder().withNewMetadata()
            .withName(job.getMetadata().getName() + "-pod")
            .withLabels(Map.of(JobResourceFactory.LABEL_TOOL_CALL_ID, COMMAND))
            .withOwnerReferences(new OwnerReferenceBuilder().withApiVersion("batch/v1").withKind("Job")
                .withName(job.getMetadata().getName()).withUid(job.getMetadata().getUid())
                .withController(true).build())
            .endMetadata()
            .withNewSpec().endSpec()
            .withStatus(new PodStatusBuilder().withPhase("Failed")
                .withInitContainerStatuses(new ContainerStatusBuilder().withName("source-copy")
                    .withNewState().withNewTerminated().withExitCode(1).withReason("Error")
                    .endTerminated().endState().build())
                .build())
            .build();
        client.pods().inNamespace(NS).resource(pod).create();
        String podName = pod.getMetadata().getName();
        seedLog(podName, "maven", "");
        seedLog(podName, "source-copy", "manao-dev-build: source exceeds the 20 MiB limit\n");

        BuildResult result = executor.build(request());

        assertThat(result.exitCode()).isEqualTo(1);
        assertThat(result.terminationReason()).isEqualTo("SourceCopyFailed");
        assertThat(result.output()).contains("source exceeds the 20 MiB limit");
        assertThat(result.testReports()).isEmpty();
        assertThat(result.cleanupConfirmed()).isTrue();
    }

    @Test
    void anInterruptedWaitStillFinishesTheBuildByTheOriginalIdentity() throws Exception {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), null, null);
        // The latch fires once the executor has bound the identity and entered its polling
        // loop, so the interruption cannot land before the wait it is supposed to interrupt.
        java.util.concurrent.CountDownLatch bound = new java.util.concurrent.CountDownLatch(1);
        executor = new Fabric8DevelopmentBuildExecutor(client, factory, NS, (ignored, identity) -> {
            boundIdentities.add(identity);
            bound.countDown();
            // A long poll keeps the wait inside its sleep when the interrupt arrives.
        }, request -> true, Clock.systemUTC(), 200, 60, 5);
        AtomicReference<Throwable> thrown = new AtomicReference<>();
        Thread waiter = new Thread(() -> {
            try {
                executor.build(request());
            } catch (Throwable ex) {
                thrown.set(ex);
            }
        });
        waiter.start();
        assertThat(bound.await(10, TimeUnit.SECONDS)).isTrue();
        Thread.sleep(50);
        waiter.interrupt();
        waiter.join(TimeUnit.SECONDS.toMillis(10));

        assertThat(thrown.get()).isInstanceOf(IllegalStateException.class);
        // The interrupted wait still ran the shared finish path: nothing was left behind.
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get()).isNull();
        assertThat(client.pods().inNamespace(NS).withName(pod.getMetadata().getName()).get()).isNull();
    }

    @Test
    void aReplayWithARecordedIdentityObservesThatBuildWithoutCreatingAnything() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 0, "Completed");
        seedLog(pod.getMetadata().getName(), "[INFO] BUILD SUCCESS\n"
            + Fabric8DevelopmentBuildExecutor.REPORT_BEGIN + "\n"
            + Fabric8DevelopmentBuildExecutor.REPORT_END + " truncated=0 files=0 state=ok\n");

        BuildResult result = executor.observe(request(), new BuildIdentity(
            job.getMetadata().getName(), job.getMetadata().getUid(), pod.getMetadata().getUid()));

        assertThat(result.exitCode()).isZero();
        assertThat(result.cleanupConfirmed()).isTrue();
        assertThat(result.identity().jobUid()).isEqualTo(job.getMetadata().getUid());
        assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).isEmpty();
        assertThat(boundIdentities).contains(result.identity());
    }

    @Test
    void aRecoveryWithoutARecordedUidAdoptsTheDeterministicJobByName() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 0, "Completed");
        seedLog(pod.getMetadata().getName(), "[INFO] BUILD SUCCESS\n");

        BuildResult result = executor.observe(request(), new BuildIdentity(null, null, null));

        assertThat(result.exitCode()).isZero();
        assertThat(result.cleanupConfirmed()).isTrue();
        assertThat(result.identity().jobUid()).isEqualTo(job.getMetadata().getUid());
        assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).isEmpty();
    }

    @Test
    void aReplayOverVanishedEvidenceNeverRebuildsTheJob() {
        BuildResult result = executor.observe(request(), new BuildIdentity(
            JobResourceFactory.developmentJobName(COMMAND), "gone-job-uid", "gone-pod-uid"));

        assertThat(result.exitCode()).isNull();
        assertThat(result.cleanupConfirmed()).isFalse();
        assertThat(result.identity().jobUid()).isEqualTo("gone-job-uid");
        // Nothing was rebuilt: the cluster stays exactly as the recovery found it.
        assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).isEmpty();
        assertThat(client.pods().inNamespace(NS).list().getItems()).isEmpty();
    }

    @Test
    void aRecordedJobIdentityThatWasReplacedUnderTheSameNameIsRefused() {
        Job job = seedJob();
        seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 0, "Completed");

        assertThatThrownBy(() -> executor.observe(request(), new BuildIdentity(
            job.getMetadata().getName(), "rotated-job-uid", null)))
            .isInstanceOf(IllegalStateException.class);
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get()).isNotNull();
    }

    @Test
    void aJobUidChangeDuringTheWaitNeverSettlesTheBuild() {
        Job job = seedJob();
        seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), null, null);
        // Replace the job under the same name the moment the executor binds its identity,
        // before the first poll: a recreated job is a different build and must never settle
        // this call.
        executor = new Fabric8DevelopmentBuildExecutor(client, factory, NS, (ignored, identity) -> {
            boundIdentities.add(identity);
            client.batch().v1().jobs().inNamespace(NS).withName(identity.jobName()).delete();
            client.batch().v1().jobs().inNamespace(NS)
                .resource(factory.createDevelopmentJob(request())).create();
        }, request -> true, Clock.systemUTC(), 10, 30, 5);

        assertThatThrownBy(() -> executor.build(request())).isInstanceOf(IllegalStateException.class);
        // The refused evidence was not destroyed.
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get()).isNotNull();
        assertThat(client.pods().inNamespace(NS)
            .withName(job.getMetadata().getName() + "-pod").get()).isNotNull();
    }

    @Test
    void closeFinishesByTheRecordedIdentityThroughTheSharedFinishPath() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 1, "Error");
        seedLog(pod.getMetadata().getName(), buildLog(SUREFIRE_XML));

        BuildResult closed = executor.close(request(), new BuildIdentity(
            job.getMetadata().getName(), job.getMetadata().getUid(), pod.getMetadata().getUid()));

        assertThat(closed.exitCode()).isNull();
        assertThat(closed.terminationReason()).isEqualTo("BUILD_CLOSED");
        assertThat(closed.output()).contains("BUILD FAILURE");
        assertThat(closed.cleanupConfirmed()).isTrue();
        assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).isEmpty();
        assertThat(client.pods().inNamespace(NS).list().getItems()).isEmpty();
    }

    @Test
    void closeConfirmsTheCleanupEvenWhenTheEvidenceIsAlreadyGone() {
        BuildResult closed = executor.close(request(), new BuildIdentity(
            JobResourceFactory.developmentJobName(COMMAND), "gone-job-uid", "gone-pod-uid"));

        assertThat(closed.exitCode()).isNull();
        assertThat(closed.cleanupConfirmed()).isTrue();
    }

    @Test
    void multiByteOutputIsBoundedByUtf8BytesAndKeepsAValidTail() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 1, "Error");
        // ~240k CJK characters are ~720k UTF-8 bytes: far over the 128 KiB byte budget, all
        // multi-byte, with the report markers at the very end of the log.
        seedLog(pod.getMetadata().getName(), "构建日志".repeat(60_000) + "\n" + buildLog(SUREFIRE_XML));

        BuildResult result = executor.build(request());

        assertThat(result.exitCode()).isEqualTo(1);
        assertThat(result.truncated()).isTrue();
        assertThat(result.output().getBytes(java.nio.charset.StandardCharsets.UTF_8).length)
            .isLessThanOrEqualTo(128 * 1024);
        assertThat(result.output()).endsWith(Fabric8DevelopmentBuildExecutor.REPORT_END + " truncated=0 files=1\n");
        assertThat(result.output()).contains("构建日志");
        assertThat(result.testReports()).hasSize(1);
    }

    @Test
    void aCloseAgainstAReplacedJobIdentityIsRefused() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 0, "Completed");

        assertThatThrownBy(() -> executor.close(request(), new BuildIdentity(
            job.getMetadata().getName(), "rotated-job-uid", null)))
            .isInstanceOf(IllegalStateException.class);
        // The refused evidence was not destroyed.
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get()).isNotNull();
        assertThat(client.pods().inNamespace(NS).withName(pod.getMetadata().getName()).get()).isNotNull();
    }

    @Test
    void aCleanupAgainstAJobThatWasReplacedUnderTheSameNameDeletesNothing() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 0, "Completed");

        // The delete precondition is the original identity: a live job that no longer carries
        // the recorded UID belongs to a different build and is never touched by this one.
        assertThat(executor.cleanup(job.getMetadata().getName(), "original-job-uid", COMMAND)).isFalse();
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get()).isNotNull();
        assertThat(client.pods().inNamespace(NS).withName(pod.getMetadata().getName()).get()).isNotNull();

        // With the matching original identity the same call deletes and confirms everything.
        assertThat(executor.cleanup(job.getMetadata().getName(), job.getMetadata().getUid(), COMMAND)).isTrue();
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get()).isNull();
        assertThat(client.pods().inNamespace(NS).withName(pod.getMetadata().getName()).get()).isNull();
    }

    @Test
    void aJobReplacedBetweenTheCheckAndTheDeleteIsNeverDeleted() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 0, "Completed");
        seedLog(pod.getMetadata().getName(), "[INFO] BUILD SUCCESS\n");
        // The stub 409 stands in for a precondition-enforcing server: between the executor's
        // identity check and its delete the job was deleted and same-name replaced, so the
        // delete carrying the verified resourceVersion must be refused with a conflict.
        dispatcher.conflictJobDelete = job.getMetadata().getName();

        BuildResult result = executor.build(request());

        assertThat(result.exitCode()).isZero();
        // The conflict is an unconfirmed cleanup, never a success.
        assertThat(result.cleanupConfirmed()).isFalse();
        // The server still holds a job under that name: the replacement was not deleted.
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get()).isNotNull();
        // Our own pod, owned by the verified job, was legitimately deleted first.
        assertThat(client.pods().inNamespace(NS).withName(pod.getMetadata().getName()).get()).isNull();
        // The delete was bound to the verified object: its resourceVersion rode along as the
        // server-side delete precondition.
        assertThat(dispatcher.jobDeleteBodies).isNotEmpty();
        assertThat(dispatcher.jobDeleteBodies.get(0)).contains(
            "\"resourceVersion\":\"" + job.getMetadata().getResourceVersion() + "\"");
    }

    @Test
    void aCleanupLeavesPodsOwnedByOtherBuildsUntouched() {
        Job job = seedJob();
        Pod ours = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 0, "Completed");
        // A second pod under the same tool-call label but owned by another incarnation's job:
        // evidence this build can never attribute to itself.
        var foreign = new PodBuilder().withNewMetadata()
            .withName(job.getMetadata().getName() + "-pod-foreign")
            .withLabels(Map.of(JobResourceFactory.LABEL_TOOL_CALL_ID, COMMAND))
            .withOwnerReferences(new OwnerReferenceBuilder().withApiVersion("batch/v1").withKind("Job")
                .withName(job.getMetadata().getName()).withUid("another-incarnation-uid")
                .withController(true).build())
            .endMetadata()
            .withNewSpec().endSpec()
            .build();
        client.pods().inNamespace(NS).resource(foreign).create();

        // The confirmed evidence is deleted; the unattributable pod keeps the cleanup from
        // ever being confirmed while it lingers.
        assertThat(executor.cleanup(job.getMetadata().getName(), job.getMetadata().getUid(), COMMAND)).isFalse();
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get()).isNull();
        assertThat(client.pods().inNamespace(NS).withName(ours.getMetadata().getName()).get()).isNull();
        assertThat(client.pods().inNamespace(NS).withName(foreign.getMetadata().getName()).get()).isNotNull();
    }

    private static String sha256(String content) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : java.security.MessageDigest.getInstance("SHA-256")
                .digest(content.getBytes(java.nio.charset.StandardCharsets.UTF_8))) {
                builder.append(String.format("%02x", b));
            }
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    @Test
    void theClosingFenceForbidsJobCreationAndSettlesWithoutSideEffects() {
        // A build claimed before the close but paused before its create: the executor
        // re-evaluates the fence at the LAST point and must not create any Job.
        executor = new Fabric8DevelopmentBuildExecutor(client, factory, NS,
            (ignored, identity) -> boundIdentities.add(identity),
            request -> false, Clock.systemUTC(), 10, 5, 5);

        BuildResult result = executor.build(request());

        assertThat(result.terminationReason()).isEqualTo("BUILD_CLOSING_ABORTED");
        assertThat(result.exitCode()).isNull();
        assertThat(result.cleanupConfirmed()).isTrue();
        assertThat(boundIdentities).isEmpty();
        // Nothing exists on the server: no Job was ever created.
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(JobResourceFactory.developmentJobName(COMMAND)).get()).isNull();
    }
}
