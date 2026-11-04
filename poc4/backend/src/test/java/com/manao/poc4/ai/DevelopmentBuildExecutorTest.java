package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.ai.AgentContracts.BuildGoal;
import com.manao.poc4.ai.AgentContracts.BuildIdentity;
import com.manao.poc4.ai.AgentContracts.BuildRequest;
import com.manao.poc4.ai.AgentContracts.BuildResult;
import com.manao.poc4.ai.AgentContracts.TestReport;
import com.manao.poc4.kubernetes.JobResourceFactory;
import com.manao.poc4.kubernetes.WorkspaceResourceFactory;
import io.fabric8.kubernetes.api.model.ContainerStatusBuilder;
import io.fabric8.kubernetes.api.model.OwnerReferenceBuilder;
import io.fabric8.kubernetes.api.model.PersistentVolumeBuilder;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaimBuilder;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PodBuilder;
import io.fabric8.kubernetes.api.model.PodStatusBuilder;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientException;
import io.fabric8.kubernetes.client.server.mock.KubernetesCrudDispatcher;
import io.fabric8.kubernetes.client.server.mock.KubernetesMockServer;
import io.fabric8.kubernetes.client.utils.Serialization;
import io.fabric8.mockwebserver.Context;
import io.fabric8.mockwebserver.MockWebServer;
import io.fabric8.mockwebserver.http.MockResponse;
import io.fabric8.mockwebserver.http.RecordedRequest;
import java.io.IOException;
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
    private static final String WORKSPACE_PV = "manao-pv-" + PROJECT;
    private static final JobResourceFactory.DevelopmentSourceVolume SOURCE =
        new JobResourceFactory.DevelopmentSourceVolume("nfs.example", "/export/manao-workspaces");

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
         * When set, DELETEs for this job are answered with a persistent 409 conflict and the
         * delete request bodies are recorded for the precondition assertion: a delete that
         * never stops conflicting is an unconfirmed cleanup, never a success.
         */
        String conflictJobDelete;
        /** Keep the original terminal Pod observable while cleanup retries are pending. */
        String conflictPodDelete;
        /**
         * When set, the FIRST delete for this job is answered with a 409 conflict and the
         * next one goes through to the store. Before the 409 is answered the stored job's
         * resourceVersion is bumped — the benign case: the job controller's own status write
         * bumped the resourceVersion between the executor's read and its delete.
         */
        String conflictJobDeleteOnce;
        /**
         * When set, the FIRST delete for this job is answered with a 409 conflict and the
         * stored job is same-name replaced with a different uid before the 409 is answered —
         * the hostile case: the job was deleted and recreated between the executor's read
         * and its delete, so the post-conflict re-read observes a replacement.
         */
        String conflictThenReplaceJob;
        /**
         * When set, the FIRST delete for this pod is answered with a 409 conflict and the
         * stored pod's resourceVersion is bumped before the 409 is answered; the next delete
         * goes through to the store.
         */
        String conflictPodDeleteOnce;
        /** When set, the body of every DELETE for a path ending in this suffix is recorded. */
        String recordDeleteBodiesFor;
        final List<String> jobDeleteBodies = new ArrayList<>();
        final List<String> recordedDeleteBodies = new ArrayList<>();

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
            if ("DELETE".equals(request.getMethod()) && request.getPath() != null) {
                String path = request.getPath();
                if (recordDeleteBodiesFor != null && path.endsWith(recordDeleteBodiesFor)) {
                    recordedDeleteBodies.add(request.getBody().readUtf8());
                }
                if (conflictJobDelete != null && path.endsWith("/jobs/" + conflictJobDelete)) {
                    jobDeleteBodies.add(request.getBody().readUtf8());
                    return new MockResponse().setResponseCode(409);
                }
                if (conflictPodDelete != null && path.endsWith("/pods/" + conflictPodDelete)) {
                    return new MockResponse().setResponseCode(409);
                }
                if (conflictJobDeleteOnce != null && path.endsWith("/jobs/" + conflictJobDeleteOnce)) {
                    String jobName = conflictJobDeleteOnce;
                    conflictJobDeleteOnce = null;
                    mutateStoredResource("/apis/batch/v1/namespaces/" + NS + "/jobs/" + jobName, null);
                    return new MockResponse().setResponseCode(409);
                }
                if (conflictThenReplaceJob != null && path.endsWith("/jobs/" + conflictThenReplaceJob)) {
                    String jobName = conflictThenReplaceJob;
                    conflictThenReplaceJob = null;
                    mutateStoredResource("/apis/batch/v1/namespaces/" + NS + "/jobs/" + jobName, "replaced-job-uid");
                    return new MockResponse().setResponseCode(409);
                }
                if (conflictPodDeleteOnce != null && path.endsWith("/pods/" + conflictPodDeleteOnce)) {
                    String podName = conflictPodDeleteOnce;
                    conflictPodDeleteOnce = null;
                    mutateStoredResource("/api/v1/namespaces/" + NS + "/pods/" + podName, null);
                    return new MockResponse().setResponseCode(409);
                }
            }
            return super.dispatch(request);
        }

        /**
         * Mutates the stored resource the way the object's own controller would: bumps its
         * resourceVersion and, when a replacement uid is given, rewrites the identity in
         * place — a same-name replacement.
         */
        private void mutateStoredResource(String path, String replacementUid) {
            try {
                var key = getKey(path);
                var entry = findResource(key);
                if (entry == null) {
                    return;
                }
                ObjectNode resource = (ObjectNode) Serialization.jsonMapper().readTree(entry.getValue());
                ObjectNode metadata = (ObjectNode) resource.get("metadata");
                if (replacementUid != null) {
                    metadata.put("uid", replacementUid);
                }
                metadata.put("resourceVersion", String.valueOf(requestResourceVersion()));
                synchronized (map) {
                    map.put(entry.getKey(), resource.toString());
                }
            } catch (IOException ex) {
                throw new IllegalStateException(ex);
            }
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
            (request, create) -> create.get(), Clock.systemUTC(), 10, 5, 5);
        seedNfsWorkspaceVolume();
    }

    /** The project's workspace volume as this stage's cluster binds it: an NFS-backed PV. */
    private void seedNfsWorkspaceVolume() {
        client.persistentVolumes().resource(new PersistentVolumeBuilder()
            .withNewMetadata().withName(WORKSPACE_PV).endMetadata()
            .withNewSpec()
            .withNewNfs().withServer(SOURCE.nfsServer()).withPath(SOURCE.nfsPath())
                .withReadOnly(false).endNfs()
            .endSpec()
            .build()).create();
        client.persistentVolumeClaims().inNamespace(NS).resource(new PersistentVolumeClaimBuilder()
            .withNewMetadata().withName(WorkspaceResourceFactory.pvcName(PROJECT)).endMetadata()
            .withNewSpec().withVolumeName(WORKSPACE_PV).endSpec()
            .build()).create();
    }

    @AfterEach
    void tearDown() {
        server.destroy();
    }

    private static BuildRequest request() {
        return new BuildRequest(TASK, CALL, PROJECT, COMMAND, 7L, BuildGoal.TEST, javaEnvironment());
    }

    private static AgentProjectEnvironment javaEnvironment() {
        return new AgentProjectEnvironment(1, "java-console", "java", "none", "task", "com.example.app.App",
            null, null, null, false, false, "java-v1", List.of("compile", "test", "package"), List.of(),
            List.of("list_files", "read_file", "write_file", "build", "application", "read_image"));
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"build", "observe", "close", "closeStep"})
    void pythonEvidenceSurvivesEveryTerminalAndClosePath(String path) throws Exception {
        var environment = AgentProjectEnvironment.fromJson(java.nio.file.Files.readString(java.nio.file.Path.of("../fixtures/agent-project-environment/python-fastapi-web.json")));
        var request = new BuildRequest(TASK, CALL, PROJECT, COMMAND, 7, BuildGoal.TEST, environment);
        Job manifest = factory.createDevelopmentJob(request, SOURCE);
        client.batch().v1().jobs().inNamespace(NS).resource(manifest).create();
        Job job = client.batch().v1().jobs().inNamespace(NS).withName(manifest.getMetadata().getName()).get();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 0, "Completed");
        seedLog(pod.getMetadata().getName(), PythonBuildEvidenceTest.report("<testsuite tests='2' failures='0' errors='0' skipped='0'/>"));
        var identity = new BuildIdentity(job.getMetadata().getName(), job.getMetadata().getUid(), pod.getMetadata().getUid());
        BuildResult result = switch (path) {
            case "build" -> executor.build(request);
            case "observe" -> executor.observe(request, identity);
            case "close" -> executor.close(request, identity);
            default -> executor.closeStep(request, identity);
        };
        assertThat(result.identity().jobUid()).isEqualTo(identity.jobUid());
        assertThat(result.evidence()).isNotNull();
        assertThat(result.evidence().verificationStatus()).hasToString("PASS");
        assertThat(result.evidence().testSummary().tests()).isEqualTo(2);
        assertThat(result.cleanupConfirmed()).isTrue();
        assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).isEmpty();
        assertThat(client.pods().inNamespace(NS).list().getItems()).isEmpty();
    }

    @Test void missingEnvironmentIsRejectedBeforeAnyNewBuild() {
        assertThatThrownBy(() -> executor.build(new BuildRequest(TASK, CALL, PROJECT, COMMAND, 7, BuildGoal.TEST)))
            .isInstanceOf(IllegalArgumentException.class);
        assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).isEmpty();
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"close-bound", "close-unbound", "normal-pending", "close-late-pod", "observe-late-pod"})
    void pendingPythonEvidenceIsDurableBeforeDeleteAndSurvivesANewStore(String recovery) throws Exception {
        try (var db = com.manao.poc4.persistence.JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            var now = new java.sql.Timestamp(System.currentTimeMillis());
            String taskId = java.util.UUID.randomUUID().toString();
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('evidence-owner','evidence-owner','unused',?)", now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES (?,'evidence-owner','evidence','READY',7,?,?)", PROJECT, now, now);
            var environment = AgentProjectEnvironment.fromJson(java.nio.file.Files.readString(java.nio.file.Path.of("../fixtures/agent-project-environment/python-fastapi-web.json")));
            var tasks = new AgentTaskStore(jdbc, new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource()), Clock.systemUTC());
            tasks.createTask("evidence-owner", PROJECT, new AgentContracts.TaskRequest(taskId, "verify", 7), null, () -> environment);
            tasks.registerToolCall(taskId, CALL, "a".repeat(64), "build", "{\"goal\":\"test\"}", 7, COMMAND);
            tasks.markToolCallRunning(taskId, CALL);
            var request = new BuildRequest(taskId, CALL, PROJECT, COMMAND, 7, BuildGoal.TEST, environment);
            var job = client.batch().v1().jobs().inNamespace(NS).resource(factory.createDevelopmentJob(request, SOURCE)).create();
            boolean latePod = recovery.endsWith("late-pod");
            Pod pod = latePod ? null : seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 0, "Completed");
            var identity = new BuildIdentity(job.getMetadata().getName(), job.getMetadata().getUid(), pod == null ? null : pod.getMetadata().getUid());
            tasks.bindToolCallIdentity(taskId, CALL, identity.jobName(), identity.jobUid(),
                "close-unbound".equals(recovery) ? null : identity.podUid());
            if (pod != null) seedLog(pod.getMetadata().getName(), PythonBuildEvidenceTest.report("<testsuite tests='1' failures='0' errors='0' skipped='0'/>"));
            dispatcher.conflictJobDelete = identity.jobName();
            var first = new Fabric8DevelopmentBuildExecutor(client, factory, NS, null, (r, create) -> create.get(), r -> false,
                tasks::savePendingBuildEvidence, tasks::loadPendingBuildEvidence, Clock.systemUTC(), 1, 1, 1);
            if ("normal-pending".equals(recovery)) assertThat(first.build(request).cleanupConfirmed()).isFalse();
            else assertThatThrownBy(() -> first.closeStep(request, "close-unbound".equals(recovery)
                ? new BuildIdentity(identity.jobName(), identity.jobUid(), null) : identity)).isInstanceOf(KubernetesClientException.class);
            if (latePod) {
                assertThat(tasks.loadPendingBuildEvidence(request).evidence().verificationStatus()).hasToString("UNKNOWN");
                var runningPod = seedPod(identity.jobName(), identity.jobUid(), null, null);
                var observedUid = runningPod.getMetadata().getUid();
                seedLog(runningPod.getMetadata().getName(), "still running");
                if ("observe-late-pod".equals(recovery)) assertThat(first.observe(request, identity).cleanupConfirmed()).isFalse();
                else assertThatThrownBy(() -> first.closeStep(request, identity)).isInstanceOf(KubernetesClientException.class);
                var restarted = new AgentTaskStore(jdbc, new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource()), Clock.systemUTC());
                assertThat(restarted.boundBuildIdentity(taskId, CALL).orElseThrow().podUid()).isEqualTo(observedUid);
                assertThat(restarted.loadPendingBuildEvidence(request).identity().podUid()).isEqualTo(observedUid);
                assertThat(restarted.loadPendingBuildEvidence(request).evidence().verificationStatus()).hasToString("UNKNOWN");
                assertThat(restarted.findToolCall(taskId, CALL).orElseThrow().state()).isEqualTo("RUNNING");
                dispatcher.conflictJobDelete = null;
                var second = new Fabric8DevelopmentBuildExecutor(client, factory, NS, null, (r, create) -> { throw new AssertionError("no second Job"); }, r -> false,
                    restarted::savePendingBuildEvidence, restarted::loadPendingBuildEvidence, Clock.systemUTC(), 1, 1, 1);
                var closed = second.closeStep(request, new BuildIdentity(identity.jobName(), identity.jobUid(), observedUid));
                assertThat(closed.cleanupConfirmed()).isTrue();
                assertThat(closed.identity().podUid()).isEqualTo(observedUid);
                tasks.releaseBuildClaim(taskId, CALL);
                return;
            }
            assertThat(tasks.findToolCall(taskId, CALL).orElseThrow().state()).isEqualTo("RUNNING");
            assertThat(tasks.findToolCall(taskId, CALL).orElseThrow().resultJson()).contains("pendingBuildEvidence");
            assertThat(tasks.loadPendingBuildEvidence(request).evidence().verificationStatus()).hasToString("PASS");
            assertThat(tasks.boundBuildIdentity(taskId, CALL).orElseThrow().podUid()).isEqualTo(identity.podUid());
            var restarted = new AgentTaskStore(jdbc, new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource()), Clock.systemUTC());
            var second = new Fabric8DevelopmentBuildExecutor(client, factory, NS, null, (r, create) -> { throw new AssertionError("no second Job"); }, r -> false,
                restarted::savePendingBuildEvidence, restarted::loadPendingBuildEvidence, Clock.systemUTC(), 1, 1, 1);
            assertThatThrownBy(() -> second.closeStep(request, new BuildIdentity(identity.jobName(), identity.jobUid(), "different-pod-uid")))
                .isInstanceOf(IllegalStateException.class);
            if ("normal-pending".equals(recovery)) {
                assertThat(client.pods().inNamespace(NS).list().getItems()).isEmpty();
                assertThat(client.batch().v1().jobs().inNamespace(NS).withName(identity.jobName()).get()).isNotNull();
                var pending = second.observe(request, identity);
                assertThat(pending.cleanupConfirmed()).isFalse();
                assertThat(pending.evidence().verificationStatus()).hasToString("PASS");
                assertThat(pending.exitCode()).isZero();
                assertThat(pending.terminationReason()).isEqualTo("Completed");
                assertThat(restarted.findToolCall(taskId, CALL).orElseThrow().state()).isEqualTo("RUNNING");
            }
            dispatcher.conflictJobDelete = null;
            if (!"normal-pending".equals(recovery)) client.batch().v1().jobs().inNamespace(NS).withName(identity.jobName()).delete();
            var result = "normal-pending".equals(recovery) ? second.observe(request, identity) : second.closeStep(request, identity);
            assertThat(result.cleanupConfirmed()).isTrue();
            assertThat(result.identity()).isEqualTo(identity);
            assertThat(result.evidence().testSummary().tests()).isEqualTo(1);
            assertThat(result.exitCode()).isZero();
            var weaker = new BuildResult(identity, null, "BUILD_WAIT_BUDGET_EXCEEDED", "", false, List.of(), false,
                PythonBuildEvidence.from(BuildGoal.TEST, null, "", false));
            restarted.savePendingBuildEvidence(request, weaker);
            assertThat(restarted.loadPendingBuildEvidence(request).evidence().verificationStatus()).hasToString("PASS");
            assertThat(restarted.loadPendingBuildEvidence(request).exitCode()).isZero();
            assertThatThrownBy(() -> restarted.loadPendingBuildEvidence(new BuildRequest(taskId, CALL, PROJECT, COMMAND, 9, BuildGoal.TEST, environment))).isInstanceOf(IllegalStateException.class);
            tasks.releaseBuildClaim(taskId, CALL);
        }
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"observe", "close", "closeStep"})
    void savedTerminalFactsSurviveRetainedPodWithDegradedLogs(String recovery) throws Exception {
        try (var db = com.manao.poc4.persistence.JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            var now = new java.sql.Timestamp(System.currentTimeMillis());
            String taskId = java.util.UUID.randomUUID().toString();
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('evidence-owner','evidence-owner','unused',?)", now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES (?,'evidence-owner','evidence','READY',7,?,?)", PROJECT, now, now);
            var environment = AgentProjectEnvironment.fromJson(java.nio.file.Files.readString(java.nio.file.Path.of("../fixtures/agent-project-environment/python-fastapi-web.json")));
            var transactions = new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource());
            var tasks = new AgentTaskStore(jdbc, transactions, Clock.systemUTC());
            tasks.createTask("evidence-owner", PROJECT, new AgentContracts.TaskRequest(taskId, "verify", 7), null, () -> environment);
            var json = new com.fasterxml.jackson.databind.ObjectMapper();
            var toolRequest = new AgentContracts.ToolRequest(CALL, "build", 7, json.createObjectNode().put("goal", "test"));
            tasks.registerToolCall(taskId, CALL, AgentProjectTools.callDigest(taskId, toolRequest), "build", "{\"goal\":\"test\"}", 7, COMMAND);
            tasks.markToolCallRunning(taskId, CALL);
            var request = new BuildRequest(taskId, CALL, PROJECT, COMMAND, 7, BuildGoal.TEST, environment);
            var job = client.batch().v1().jobs().inNamespace(NS).resource(factory.createDevelopmentJob(request, SOURCE)).create();
            var pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 0, "Completed");
            var identity = new BuildIdentity(job.getMetadata().getName(), job.getMetadata().getUid(), pod.getMetadata().getUid());
            tasks.bindToolCallIdentity(taskId, CALL, identity.jobName(), identity.jobUid(), identity.podUid());
            String originalOutput = PythonBuildEvidenceTest.report("<testsuite tests='2' failures='0' errors='0' skipped='0'/>");
            seedLog(pod.getMetadata().getName(), originalOutput);
            dispatcher.conflictPodDelete = pod.getMetadata().getName();
            var first = new Fabric8DevelopmentBuildExecutor(client, factory, NS, null, (r, create) -> create.get(), r -> false,
                tasks::savePendingBuildEvidence, tasks::loadPendingBuildEvidence, Clock.systemUTC(), 1, 1, 1);
            var original = first.build(request);
            assertThat(original.cleanupConfirmed()).isFalse();
            assertThat(original.evidence().verificationStatus()).hasToString("PASS");
            assertThat(original.terminationReason()).isEqualTo("Completed");
            assertThat(client.pods().inNamespace(NS).withName(pod.getMetadata().getName()).get()).isNotNull();
            assertThat(client.batch().v1().jobs().inNamespace(NS).withName(identity.jobName()).get()).isNotNull();
            assertThat(tasks.findToolCall(taskId, CALL).orElseThrow().state()).isEqualTo("RUNNING");
            tasks.releaseBuildClaim(taskId, CALL);

            seedLog(pod.getMetadata().getName(), switch (recovery) {
                case "observe" -> "";
                case "close" -> "x".repeat(Fabric8DevelopmentBuildExecutor.MAX_OUTPUT_BYTES + 1);
                default -> "MANAO-PYTEST-REPORT-BEGIN\n<testsuite";
            });
            var restarted = new AgentTaskStore(jdbc, transactions, Clock.systemUTC());
            var second = new Fabric8DevelopmentBuildExecutor(client, factory, NS, null, (r, create) -> { throw new AssertionError("no second Job"); }, r -> false,
                restarted::savePendingBuildEvidence, restarted::loadPendingBuildEvidence, Clock.systemUTC(), 1, 1, 1);
            dispatcher.conflictPodDelete = null;
            var recovered = switch (recovery) {
                case "observe" -> second.observe(request, identity);
                case "close" -> second.close(request, identity);
                default -> second.closeStep(request, identity);
            };
            assertThat(recovered.cleanupConfirmed()).isTrue();
            assertThat(client.pods().inNamespace(NS).list().getItems()).isEmpty();
            assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).isEmpty();
            assertThat(recovered).usingRecursiveComparison().ignoringFields("cleanupConfirmed").isEqualTo(original);
            assertThat(restarted.loadPendingBuildEvidence(request)).isEqualTo(original);

            var tools = new AgentProjectTools(restarted, new com.manao.poc4.workspace.WorkspaceJdbcStore(jdbc, transactions),
                null, null, new com.manao.poc4.project.ProjectLifecycleGate(), second);
            var completed = tools.invoke(taskId, toolRequest);
            assertThat(completed.data().path("exitCode").asInt(-1)).isZero();
            assertThat(completed.data().path("terminationReason").asText()).isEqualTo("Completed");
            assertThat(completed.data().path("output").asText()).isEqualTo(originalOutput);
            assertThat(completed.data().path("verificationStatus").asText()).isEqualTo("PASS");
            var row = restarted.findToolCall(taskId, CALL).orElseThrow();
            assertThat(row.state()).isEqualTo("COMPLETED");
            assertThat(json.readTree(row.resultJson())).isEqualTo(json.valueToTree(completed));
        }
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans = {false, true})
    void concurrentTerminalObserversReturnTheFirstDurableEvidenceAfterLateCleanup(boolean saveAfterCompletion) throws Exception {
        try (var db = com.manao.poc4.persistence.JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            var now = new java.sql.Timestamp(System.currentTimeMillis());
            String taskId = java.util.UUID.randomUUID().toString();
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('evidence-owner','evidence-owner','unused',?)", now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES (?,'evidence-owner','evidence','READY',7,?,?)", PROJECT, now, now);
            var environment = AgentProjectEnvironment.fromJson(java.nio.file.Files.readString(java.nio.file.Path.of("../fixtures/agent-project-environment/python-fastapi-web.json")));
            var transactions = new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource());
            var tasks = new AgentTaskStore(jdbc, transactions, Clock.systemUTC());
            tasks.createTask("evidence-owner", PROJECT, new AgentContracts.TaskRequest(taskId, "verify", 7), null, () -> environment);
            var json = new com.fasterxml.jackson.databind.ObjectMapper();
            var toolRequest = new AgentContracts.ToolRequest(CALL, "build", 7, json.createObjectNode().put("goal", "test"));
            tasks.registerToolCall(taskId, CALL, AgentProjectTools.callDigest(taskId, toolRequest), "build", "{\"goal\":\"test\"}", 7, COMMAND);
            var firstPolling = new java.util.concurrent.CountDownLatch(1);
            var replayPolling = new java.util.concurrent.CountDownLatch(1);
            var passSaved = new java.util.concurrent.CountDownLatch(1);
            var weakSaved = new java.util.concurrent.CountDownLatch(1);
            var releaseFirstCleanup = new java.util.concurrent.CountDownLatch(1);
            var releaseReplayCleanup = new java.util.concurrent.CountDownLatch(1);
            var creations = new java.util.concurrent.atomic.AtomicInteger();
            var original = new AtomicReference<BuildResult>();
            var replayObservation = new AtomicReference<BuildResult>();
            String output = PythonBuildEvidenceTest.report("<testsuite tests='2' failures='0' errors='0' skipped='0'/>");
            var podName = new AtomicReference<String>();
            var first = new Fabric8DevelopmentBuildExecutor(client, factory, NS, (r, identity) -> {
                tasks.bindToolCallIdentity(taskId, CALL, identity.jobName(), identity.jobUid(), identity.podUid());
                if (identity.podUid() == null) {
                    firstPolling.countDown();
                    awaitLatch(replayPolling);
                }
            }, (r, create) -> {
                creations.incrementAndGet();
                Job job = create.get();
                Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 0, "Completed");
                podName.set(pod.getMetadata().getName());
                seedLog(podName.get(), output);
                return job;
            }, r -> false, (r, evidence) -> {
                original.set(evidence);
                var canonical = tasks.savePendingBuildEvidence(r, evidence);
                seedLog(podName.get(), "");
                passSaved.countDown();
                awaitLatch(releaseFirstCleanup);
                return canonical;
            }, tasks::loadPendingBuildEvidence, Clock.systemUTC(), 1, 10, 1);
            var replay = new Fabric8DevelopmentBuildExecutor(client, factory, NS, (r, identity) -> {
                tasks.bindToolCallIdentity(taskId, CALL, identity.jobName(), identity.jobUid(), identity.podUid());
                replayPolling.countDown();
                awaitLatch(passSaved);
            }, (r, create) -> { throw new AssertionError("replay must not create a second Job"); }, r -> false,
                (r, evidence) -> {
                    replayObservation.set(evidence);
                    var canonical = saveAfterCompletion ? null : tasks.savePendingBuildEvidence(r, evidence);
                    weakSaved.countDown();
                    awaitLatch(releaseReplayCleanup);
                    return saveAfterCompletion ? tasks.savePendingBuildEvidence(r, evidence) : canonical;
                }, tasks::loadPendingBuildEvidence, Clock.systemUTC(), 1, 10, 1);
            var gate = new com.manao.poc4.project.ProjectLifecycleGate();
            var workspace = new com.manao.poc4.workspace.WorkspaceJdbcStore(jdbc, transactions);
            var firstTools = new AgentProjectTools(tasks, workspace, null, null, gate, first);
            var returnedEvidence = new AtomicReference<BuildResult>();
            var capturedReplay = org.mockito.Mockito.spy(replay);
            org.mockito.Mockito.doAnswer(invocation -> {
                BuildResult result = (BuildResult) invocation.callRealMethod();
                returnedEvidence.set(result);
                return result;
            }).when(capturedReplay).observe(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
            var replayTools = new AgentProjectTools(tasks, workspace, null, null, gate, capturedReplay);
            var pool = java.util.concurrent.Executors.newFixedThreadPool(2);
            try {
                var a = pool.submit(() -> firstTools.invoke(taskId, toolRequest));
                awaitLatch(firstPolling);
                var b = pool.submit(() -> replayTools.invoke(taskId, toolRequest));
                awaitLatch(weakSaved);
                assertThat(original.get().evidence().verificationStatus()).hasToString("PASS");
                assertThat(replayObservation.get().evidence().verificationStatus()).hasToString("UNKNOWN");
                assertThat(original.get().identity()).isEqualTo(replayObservation.get().identity());
                var request = new BuildRequest(taskId, CALL, PROJECT, COMMAND, 7, BuildGoal.TEST, environment);
                assertThat(tasks.loadPendingBuildEvidence(request)).isEqualTo(original.get());
                assertThat(original.get().cleanupConfirmed()).isFalse();
                assertThat(client.pods().inNamespace(NS).list().getItems()).hasSize(1);
                assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).hasSize(1);
                assertThat(tasks.findToolCall(taskId, CALL).orElseThrow().state()).isEqualTo("RUNNING");
                releaseFirstCleanup.countDown();
                var winner = a.get(20, TimeUnit.SECONDS);
                assertThat(winner.data().path("verificationStatus").asText()).isEqualTo("PASS");
                assertThat(winner.data().path("testSummary").path("tests").asInt()).isEqualTo(2);
                assertThat(winner.data().path("sourceRevision").asText()).isEqualTo("7");
                assertThat(winner.data().path("cleanupConfirmed").asBoolean()).isTrue();
                assertThat(client.pods().inNamespace(NS).list().getItems()).isEmpty();
                assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).isEmpty();
                releaseReplayCleanup.countDown();
                assertThat(b.get(20, TimeUnit.SECONDS)).isEqualTo(winner);
                assertThat(returnedEvidence.get()).usingRecursiveComparison().ignoringFields("cleanupConfirmed").isEqualTo(original.get());
                var restarted = new AgentTaskStore(jdbc, transactions, Clock.systemUTC());
                var laterTools = new AgentProjectTools(restarted, workspace, null, null, gate, replay);
                assertThat(laterTools.invoke(taskId, toolRequest)).isEqualTo(winner);
                assertThat(json.readTree(restarted.findToolCall(taskId, CALL).orElseThrow().resultJson()))
                    .isEqualTo(json.valueToTree(winner));
                assertThat(restarted.loadPendingBuildEvidence(request)).isEqualTo(original.get());
                var foreignUid = new BuildResult(new BuildIdentity(original.get().identity().jobName(), "foreign-job", "foreign-pod"),
                    0, "Completed", "", false, List.of(), false);
                assertThatThrownBy(() -> restarted.savePendingBuildEvidence(request, foreignUid))
                    .isInstanceOf(IllegalStateException.class);
                assertThatThrownBy(() -> restarted.loadPendingBuildEvidence(new BuildRequest(taskId, CALL, PROJECT, COMMAND, 8, BuildGoal.TEST, environment)))
                    .isInstanceOf(IllegalStateException.class);
                assertThatThrownBy(() -> restarted.loadPendingBuildEvidence(new BuildRequest(taskId, CALL, PROJECT, COMMAND, 7, BuildGoal.TEST)))
                    .isInstanceOf(IllegalStateException.class);
                assertThat(creations.get()).isEqualTo(1);
            } finally {
                releaseFirstCleanup.countDown();
                releaseReplayCleanup.countDown();
                pool.shutdownNow();
                assertThat(pool.awaitTermination(20, TimeUnit.SECONDS)).isTrue();
            }
        }
    }

    private static void awaitLatch(java.util.concurrent.CountDownLatch latch) {
        try {
            if (!latch.await(15, TimeUnit.SECONDS)) throw new AssertionError("build observation barrier timed out");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError(interrupted);
        }
    }

    private Job seedJob() {
        Job job = factory.createDevelopmentJob(request(), SOURCE);
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

    @Test void cooperativeCloseStopsTheOriginalJobWithoutWaitingForBuildDeadline() throws Exception {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), null, null);
        var reads = new java.util.concurrent.atomic.AtomicInteger();
        var controlled = new Fabric8DevelopmentBuildExecutor(client, factory, NS,
            (java.util.function.BiConsumer<BuildRequest, BuildIdentity>) (r, i) -> boundIdentities.add(i),
            (Fabric8DevelopmentBuildExecutor.BuildCreation) (r, create) -> create.get(),
            (java.util.function.Predicate<BuildRequest>) r -> reads.incrementAndGet() >= 2,
            Clock.systemUTC(), 10L, 600L, 1L);
        BuildResult result = controlled.build(request());
        assertThat(result.terminationReason()).isEqualTo("BUILD_CLOSED");
        assertThat(result.exitCode()).isNull();
        assertThat(result.cleanupConfirmed()).isTrue();
        assertThat(result.identity().jobUid()).isEqualTo(job.getMetadata().getUid());
        assertThat(client.pods().inNamespace(NS).withName(pod.getMetadata().getName()).get()).isNull();
        assertThat(client.batch().v1().jobs().inNamespace(NS).withName(job.getMetadata().getName()).get()).isNull();
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
    void aNonNfsWorkspaceVolumeFailsClosedBeforeAnyJobIsCreated() {
        // Replace the seeded NFS volume with a PV that carries no NFS spec at all: stage one
        // runs on NFS-backed workspaces only, and an unresolvable read-only source must
        // refuse the build instead of starting it.
        client.persistentVolumes().withName(WORKSPACE_PV).delete();
        client.persistentVolumes().resource(new PersistentVolumeBuilder()
            .withNewMetadata().withName(WORKSPACE_PV).endMetadata()
            .withNewSpec().endSpec()
            .build()).create();

        assertThatThrownBy(() -> executor.build(request()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("development build requires an NFS-backed workspace volume");
        assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).isEmpty();
        assertThat(client.pods().inNamespace(NS).list().getItems()).isEmpty();
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
            (request, create) -> create.get(), Clock.systemUTC(), 10, 1, 1);

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
        }, (request, create) -> create.get(), Clock.systemUTC(), 200, 60, 5);
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
                .resource(factory.createDevelopmentJob(request(), SOURCE)).create();
        }, (request, create) -> create.get(), Clock.systemUTC(), 10, 30, 5);

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
    void closeStepDeletesOnceAndConfirmsAbsenceInTheSameDrive() {
        Job job=seedJob();
        Pod pod=seedPod(job.getMetadata().getName(),job.getMetadata().getUid(),1,"Error");
        var identity=new BuildIdentity(job.getMetadata().getName(),job.getMetadata().getUid(),pod.getMetadata().getUid());
        BuildResult first=executor.closeStep(request(),identity);
        assertThat(first.cleanupConfirmed()).isTrue();
        assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).isEmpty();
        assertThat(client.pods().inNamespace(NS).list().getItems()).isEmpty();
        assertThat(executor.closeStep(request(),identity).cleanupConfirmed()).isTrue();
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
    void aBenignStatusBumpOnTheJobDeleteIsRetriedWithTheReverifiedIdentity() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 0, "Completed");
        seedLog(pod.getMetadata().getName(), "[INFO] BUILD SUCCESS\n");
        // The job controller's own status write (Failed/Complete conditions) bumps the job's
        // resourceVersion between the executor's read and its delete: the first delete
        // conflicts, but the re-read observes the SAME uid and the retried delete — carrying
        // the freshly re-read resourceVersion — confirms the cleanup instead of dropping the
        // real build result.
        dispatcher.recordDeleteBodiesFor = "/jobs/" + job.getMetadata().getName();
        dispatcher.conflictJobDeleteOnce = job.getMetadata().getName();

        BuildResult result = executor.build(request());

        assertThat(result.exitCode()).isZero();
        assertThat(result.cleanupConfirmed()).isTrue();
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get()).isNull();
        assertThat(client.pods().inNamespace(NS).withLabel(JobResourceFactory.LABEL_TOOL_CALL_ID, COMMAND)
            .list().getItems()).isEmpty();
        // The first attempt carried the verified (stale) resourceVersion; the retried delete
        // carried the freshly re-read one.
        assertThat(dispatcher.recordedDeleteBodies).hasSize(2);
        assertThat(dispatcher.recordedDeleteBodies.get(0))
            .contains("\"resourceVersion\":\"" + job.getMetadata().getResourceVersion() + "\"");
        assertThat(dispatcher.recordedDeleteBodies.get(1))
            .contains("\"resourceVersion\":")
            .doesNotContain("\"resourceVersion\":\"" + job.getMetadata().getResourceVersion() + "\"");
    }

    @Test
    void aJobReplacedBetweenTheConflictedDeleteAndTheRereadIsRefused() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 0, "Completed");
        seedLog(pod.getMetadata().getName(), "[INFO] BUILD SUCCESS\n");
        // The first delete conflicts and the job was deleted-and-recreated under the same
        // name before the executor's re-read: the re-verified identity catches the
        // replacement, the cleanup stays unconfirmed and the replacement is never deleted.
        dispatcher.conflictThenReplaceJob = job.getMetadata().getName();

        BuildResult result = executor.build(request());

        assertThat(result.exitCode()).isZero();
        assertThat(result.cleanupConfirmed()).isFalse();
        Job survivor = client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get();
        assertThat(survivor).isNotNull();
        assertThat(survivor.getMetadata().getUid()).isEqualTo("replaced-job-uid");
        // Our own pod, owned by the verified job, was legitimately deleted first.
        assertThat(client.pods().inNamespace(NS).withName(pod.getMetadata().getName()).get()).isNull();
    }

    @Test
    void aStatusBumpOnAPodDeleteIsRetriedWithTheReverifiedOwnership() {
        Job job = seedJob();
        Pod pod = seedPod(job.getMetadata().getName(), job.getMetadata().getUid(), 1, "Error");
        seedLog(pod.getMetadata().getName(), buildLog(SUREFIRE_XML));
        // The pod's own status write bumps its resourceVersion between the executor's list
        // and its delete: the first delete conflicts, the re-read still finds the pod owned
        // by the verified job and the retried delete confirms the cleanup.
        dispatcher.recordDeleteBodiesFor = "/pods/" + pod.getMetadata().getName();
        dispatcher.conflictPodDeleteOnce = pod.getMetadata().getName();

        BuildResult result = executor.build(request());

        assertThat(result.exitCode()).isEqualTo(1);
        assertThat(result.cleanupConfirmed()).isTrue();
        assertThat(client.batch().v1().jobs().inNamespace(NS)
            .withName(job.getMetadata().getName()).get()).isNull();
        assertThat(client.pods().inNamespace(NS).withName(pod.getMetadata().getName()).get()).isNull();
        assertThat(dispatcher.recordedDeleteBodies).hasSize(2);
        assertThat(dispatcher.recordedDeleteBodies.get(0))
            .contains("\"resourceVersion\":\"" + pod.getMetadata().getResourceVersion() + "\"");
        assertThat(dispatcher.recordedDeleteBodies.get(1))
            .contains("\"resourceVersion\":")
            .doesNotContain("\"resourceVersion\":\"" + pod.getMetadata().getResourceVersion() + "\"");
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
    void anEarlierAllowedReadCannotAuthorizeCreationAfterCloseOrTerminal() throws Exception {
        try (var db = com.manao.poc4.persistence.JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            var now = new java.sql.Timestamp(System.currentTimeMillis());
            String taskId = java.util.UUID.randomUUID().toString();
            jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES ('build-owner', 'build-owner', 'unused', ?)", now);
            jdbc.update("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) VALUES (?, 'build-owner', 'build', 'READY', 7, ?, ?)", PROJECT, now, now);
            var tasks = new AgentTaskStore(jdbc,
                new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource()), Clock.systemUTC());
            tasks.create("build-owner", PROJECT, new AgentContracts.TaskRequest(taskId, "build", 7));
            tasks.registerToolCall(taskId, CALL, "a".repeat(64), "build", "{\"goal\":\"test\"}", 7, COMMAND);
            assertThat(tasks.markToolCallRunning(taskId, CALL)).isTrue();
            BuildRequest request = new BuildRequest(taskId, CALL, PROJECT, COMMAND, 7, BuildGoal.TEST, javaEnvironment());
            var readAllowed = new java.util.concurrent.CountDownLatch(1);
            var resume = new java.util.concurrent.CountDownLatch(1);
            executor = new Fabric8DevelopmentBuildExecutor(client, factory, NS, (ignored, identity) -> {},
                (candidate, create) -> {
                    boolean allowed = !tasks.hasClosingIntent(taskId);
                    readAllowed.countDown();
                    try {
                        assertThat(resume.await(10, TimeUnit.SECONDS)).isTrue();
                    } catch (InterruptedException ex) {
                        throw new IllegalStateException(ex);
                    }
                    assertThat(allowed).isTrue();
                    return tasks.createBuildIfAllowed(candidate, create);
                }, Clock.systemUTC(), 10, 0, 1);
            var pool = java.util.concurrent.Executors.newSingleThreadExecutor();
            try {
                var pending = pool.submit(() -> executor.build(request));
                assertThat(readAllowed.await(5, TimeUnit.SECONDS)).isTrue();
                tasks.beginClose(taskId);
                resume.countDown();
                assertThat(pending.get(10, TimeUnit.SECONDS).terminationReason()).isEqualTo("BUILD_CLOSING_ABORTED");
                // The tool layer releases the live execution claim in its finally once the
                // build call has returned (AgentProjectTools); this test drives the executor
                // directly, so it reproduces that release here. The close flow's finish step
                // must then be able to settle a task whose execution is provably over —
                // never one whose execution thread is still live.
                tasks.releaseBuildClaim(taskId, CALL);
                // The same late execution is refused even after the close marker is gone.
                tasks.markToolCallNeedsAttention(taskId, CALL);
                assertThat(tasks.failClosedTask(taskId, "AI_CLOSED", "closed")).isTrue();
                assertThat(tasks.hasClosingIntent(taskId)).isTrue();
                executor = new Fabric8DevelopmentBuildExecutor(client, factory, NS,
                    (ignored, identity) -> boundIdentities.add(identity), tasks::createBuildIfAllowed,
                    Clock.systemUTC(), 10, 0, 1);
                assertThat(executor.build(request).terminationReason()).isEqualTo("BUILD_CLOSING_ABORTED");
                assertThat(boundIdentities).isEmpty();
                assertThat(client.batch().v1().jobs().inNamespace(NS).list().getItems()).isEmpty();
            } finally {
                resume.countDown();
                pool.shutdownNow();
            }
        }
    }

    @Test
    void theClosingFenceForbidsJobCreationAndSettlesWithoutSideEffects() {
        // A build claimed before the close but paused before its create: the executor
        // re-evaluates the fence at the LAST point and must not create any Job.
        executor = new Fabric8DevelopmentBuildExecutor(client, factory, NS,
            (ignored, identity) -> boundIdentities.add(identity),
            (request, create) -> null, Clock.systemUTC(), 10, 5, 5);

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
