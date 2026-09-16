package com.manao.poc4.run;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.persistence.RunState;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.Set;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

public class RunControllerTest {
    private static final String ALICE = "alice-id";
    private static final String PROJECT = "prj-1";
    private static final ObjectMapper JSON = new ObjectMapper();

    private FakeRunStore store;
    private StubCoordinator coordinator;
    private RunController controller;

    @BeforeEach
    void setUp() {
        store = new FakeRunStore();
        coordinator = new StubCoordinator();
        RunService service = new RunService(store, coordinator, RunControllerTest.policy());
        controller = new RunController(service);
        store.projects.put(PROJECT, "READY");
        store.projectOwners.put(PROJECT, ALICE);
        store.revision.put(PROJECT, 12L);
    }

    static RunPolicy policy() {
        return new RunPolicy("mvn -q -DskipTests compile exec:java", 17, 3, 1800,
            new RunPolicy.Resources(1000, 1L << 30, 1L << 30),
            new RunPolicy.Resources(8000, 16L << 30, 10L << 30));
    }

    private String serialized(Object response) throws Exception {
        String value = JSON.writeValueAsString(response);
        assertThat(value).doesNotContain("manao-run-", "jobRef", "podRef", "image", "env\"");
        return value;
    }

    @Nested
    class Start {
        @Test
        void startReturnsStartingRunWithFixedPolicySnapshot() throws Exception {
            RunSummary summary = controller.start(auth(ALICE), PROJECT,
                new RunController.StartRunRequest("12"));
            assertThat(summary.state()).isEqualTo("STARTING");
            assertThat(summary.startedAt()).isNull();
            assertThat(summary.finishedAt()).isNull();
            assertThat(summary.terminationReason()).isNull();
            assertThat(summary.exitCode()).isNull();
            assertThat(summary.requestedWorkspaceRevision()).isEqualTo("12");
            assertThat(coordinator.ensureJobCalls).hasSize(1);
            JsonNode policy = JSON.readTree(serialized(summary)).get("policy");
            assertThat(policy.has("image")).isFalse();
            assertThat(policy.has("env")).isFalse();
            assertThat(policy.get("command").asText()).isEqualTo("mvn -q -DskipTests compile exec:java");
            assertThat(policy.get("runtime").get("javaMajor").asInt()).isEqualTo(17);
            assertThat(policy.get("runtime").get("mavenMajor").asInt()).isEqualTo(3);
            assertThat(policy.get("timeoutSeconds").asInt()).isEqualTo(1800);
            assertThat(policy.get("resources").get("limits").get("cpuMillis").asLong()).isEqualTo(8000);
            assertThat(policy.get("resources").get("limits").get("memoryBytes").asLong()).isEqualTo(17179869184L);
            assertThat(policy.get("resources").get("limits").get("ephemeralStorageBytes").asLong()).isEqualTo(10737418240L);
            assertThat(policy.get("resources").get("requests").get("cpuMillis").asLong()).isEqualTo(1000);
            String full = serialized(summary);
            assertThat(full).contains("\"logTruncated\":false").contains("\"logEvictedBytes\":0")
                .contains("\"lastLogSeq\":null");
        }

        @Test
        void startWithStaleRevisionConflictsWithoutCreatingAJob() {
            assertThatThrownBy(() -> controller.start(auth(ALICE), PROJECT, new RunController.StartRunRequest("11")))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("WORKSPACE_REVISION_CONFLICT");
                    assertThat(ex.status()).isEqualTo(409);
                });
            assertThat(coordinator.ensureJobCalls).isEmpty();
            assertThat(store.runs).isEmpty();
        }

        @Test
        void startWithDuplicateActiveRunConflicts() {
            controller.start(auth(ALICE), PROJECT, new RunController.StartRunRequest("12"));
            assertThatThrownBy(() -> controller.start(auth(ALICE), PROJECT, new RunController.StartRunRequest("12")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("RUN_ALREADY_ACTIVE"));
            assertThat(coordinator.ensureJobCalls).hasSize(1);
        }

        @Test
        void concurrentStartFallsBackToRefetchedActiveRun() {
            store.failNextInsert = true;
            assertThatThrownBy(() -> controller.start(auth(ALICE), PROJECT, new RunController.StartRunRequest("12")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("RUN_ALREADY_ACTIVE"));
            assertThat(coordinator.ensureJobCalls).isEmpty();
        }

        @Test
        void startWithoutFencingTokenFailsClosed() {
            store.fencingToken = OptionalLong.empty();
            assertThatThrownBy(() -> controller.start(auth(ALICE), PROJECT, new RunController.StartRunRequest("12")))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.status()).isEqualTo(503);
                    assertThat(ex.code()).isEqualTo("INTERNAL_ERROR");
                });
            assertThat(coordinator.ensureJobCalls).isEmpty();
            assertThat(store.runs).isEmpty();
        }

        @Test
        void startOnNonReadyOrUnknownProjectIsRejected() {
            store.projects.put(PROJECT, "CREATING");
            assertThatThrownBy(() -> controller.start(auth(ALICE), PROJECT, new RunController.StartRunRequest("12")))
                .isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo("PROJECT_LOCKED"));
            store.projects.put(PROJECT, "READY");
            assertThatThrownBy(() -> controller.start(auth("bob-id"), PROJECT, new RunController.StartRunRequest("12")))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("ENTRY_NOT_FOUND");
                    assertThat(ex.status()).isEqualTo(404);
                });
        }
    }

    @Nested
    class Stop {
        @Test
        void stopTransitionsToStoppingAndStopsTheJob() {
            RunSummary started = controller.start(auth(ALICE), PROJECT, new RunController.StartRunRequest("12"));
            RunSummary stopped = controller.stop(auth(ALICE), PROJECT, started.id());
            assertThat(stopped.state()).isEqualTo("STOPPING");
            assertThat(stopped.finishedAt()).isNull();
            assertThat(coordinator.stopCalls).containsExactly("manao-run-" + started.id());
            // Lock is retained: the run is still active.
            assertThat(controller.active(auth(ALICE), PROJECT).run()).isNotNull();
        }

        @Test
        void stopIsIdempotentForActiveAndTerminalRuns() {
            RunSummary started = controller.start(auth(ALICE), PROJECT, new RunController.StartRunRequest("12"));
            assertThat(controller.stop(auth(ALICE), PROJECT, started.id()).state()).isEqualTo("STOPPING");
            assertThat(controller.stop(auth(ALICE), PROJECT, started.id()).state()).isEqualTo("STOPPING");
            assertThat(coordinator.stopCalls).hasSize(2);
            // Terminal runs settle without any further Kubernetes interaction.
            store.runs.get(started.id()).state = RunState.CANCELLED.name();
            RunSummary settled = controller.stop(auth(ALICE), PROJECT, started.id());
            assertThat(settled.state()).isEqualTo("CANCELLED");
            assertThat(coordinator.stopCalls).hasSize(2);
        }

        @Test
        void stopUnknownRunHidesExistence() {
            assertThatThrownBy(() -> controller.stop(auth(ALICE), PROJECT, "missing"))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("RUN_NOT_FOUND");
                    assertThat(ex.status()).isEqualTo(404);
                });
        }
    }

    @Nested
    class Reads {
        @Test
        void activeReturnsNullWithoutActiveRun() {
            assertThat(controller.active(auth(ALICE), PROJECT).run()).isNull();
            controller.start(auth(ALICE), PROJECT, new RunController.StartRunRequest("12"));
            assertThat(controller.active(auth(ALICE), PROJECT).run().state()).isEqualTo("STARTING");
        }

        @Test
        void listReturnsNewestFirstWithCursor() throws Exception {
            controller.start(auth(ALICE), PROJECT, new RunController.StartRunRequest("12"));
            RunController.RunListResponse response = controller.list(auth(ALICE), PROJECT, null, 20);
            assertThat(response.items()).hasSize(1);
            assertThat(response.nextCursor()).isNull();
            assertThat(serialized(response)).contains("\"items\"");
        }

        @Test
        void listUsesCursorForSecondPageAndRejectsMalformedCursor() {
            addTerminalRun("run-new", Instant.parse("2026-08-29T12:03:00Z"));
            addTerminalRun("run-middle", Instant.parse("2026-08-29T12:02:00Z"));
            addTerminalRun("run-old", Instant.parse("2026-08-29T12:01:00Z"));

            RunController.RunListResponse first = controller.list(auth(ALICE), PROJECT, null, 2);
            assertThat(first.items()).extracting(RunSummary::id)
                .containsExactly("run-new", "run-middle");
            assertThat(first.nextCursor()).isNotNull();

            RunController.RunListResponse second = controller.list(auth(ALICE), PROJECT, first.nextCursor(), 2);
            assertThat(second.items()).extracting(RunSummary::id).containsExactly("run-old");
            assertThat(second.nextCursor()).isNull();

            assertThatThrownBy(() -> controller.list(auth(ALICE), PROJECT, "not-a-valid-cursor", 2))
                .isInstanceOfSatisfying(ApiException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("VALIDATION_ERROR");
                    assertThat(ex.status()).isEqualTo(422);
                });
        }

        private void addTerminalRun(String id, Instant createdAt) {
            store.runs.put(id, new FakeRun(new RunRecord(id, PROJECT, 12, RunState.SUCCEEDED, "{}",
                null, null, null, createdAt, 0, "BUILD_SUCCEEDED", 0L, createdAt, 1L)));
        }

        @Test
        void getReturnsSingleSummary() {
            RunSummary started = controller.start(auth(ALICE), PROJECT, new RunController.StartRunRequest("12"));
            assertThat(controller.get(auth(ALICE), PROJECT, started.id()).id()).isEqualTo(started.id());
        }
    }

    public static org.springframework.security.core.Authentication auth(String userId) {
        return new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(userId, "n/a");
    }

    public static class FakeRunStore implements RunStore {
        public final Map<String, String> projects = new LinkedHashMap<>();
        public final Map<String, Long> revision = new LinkedHashMap<>();
        public final Map<String, FakeRun> runs = new LinkedHashMap<>();
        public final Set<String> activeRuns = new java.util.HashSet<>();
        public OptionalLong fencingToken = OptionalLong.of(7L);
        public boolean failNextInsert;

        public final Map<String, String> projectOwners = new HashMap<>();

        @Override public ProjectRecord findProjectForOwner(String ownerId, String projectId) {
            String state = projects.get(projectId);
            if (state == null || !ownerId.equals(projectOwners.get(projectId))) return null;
            return new ProjectRecord(projectId, ownerId, state, revision.getOrDefault(projectId, 0L));
        }

        @Override public ProjectRecord findProject(String projectId) {
            String state = projects.get(projectId);
            if (state == null) return null;
            return new ProjectRecord(projectId, projectOwners.getOrDefault(projectId, ""), state,
                revision.getOrDefault(projectId, 0L));
        }

        @Override public OptionalLong acquireFencingToken() { return fencingToken; }

        @Override public InsertResult insertRun(RunRecord record, long fencingToken) {
            String state = projects.get(record.projectId());
            if (state == null) return InsertResult.PROJECT_NOT_FOUND;
            if (!"READY".equals(state)) return InsertResult.PROJECT_LOCKED;
            if (revision.getOrDefault(record.projectId(), 0L) != record.requestedRevision()) {
                return InsertResult.REVISION_CONFLICT;
            }
            if (fencingToken != currentFencing()) return InsertResult.ACTIVE_RUN_EXISTS;
            if (failNextInsert) {
                failNextInsert = false;
                // Simulate the racing request that won the unique active-run marker.
                FakeRun winner = new FakeRun(new RunRecord("winner-run", record.projectId(), record.requestedRevision(),
                    RunState.RUNNING, "{}", null, null, null, null, null, null, 0L,
                    Instant.parse("2026-08-29T11:30:00Z"), 0L));
                runs.put(winner.id, winner);
                return InsertResult.ACTIVE_RUN_EXISTS;
            }
            runs.put(record.id(), new FakeRun(record));
            activeRuns.add(record.projectId());
            return InsertResult.INSERTED;
        }

        @Override public Optional<RunRecord> findActiveRun(String projectId) {
            return runs.values().stream()
                .filter(run -> run.projectId.equals(projectId))
                .filter(run -> java.util.Set.of("STARTING", "RUNNING", "STOPPING", "RECOVERING").contains(run.state))
                .findFirst().map(FakeRun::toRecord);
        }

        @Override public Optional<RunRecord> findRun(String runId) {
            return Optional.ofNullable(runs.get(runId)).map(FakeRun::toRecord);
        }

        @Override public Optional<RunRecord> findRunForOwner(String ownerId, String projectId, String runId) {
            FakeRun run = runs.get(runId);
            if (run == null || !run.projectId.equals(projectId) || !ownerId.equals(projectOwners.get(projectId))) {
                return Optional.empty();
            }
            return Optional.of(run.toRecord());
        }

        @Override public RunStore.RunPage listForOwner(String ownerId, String projectId, RunStore.RunCursor cursor, int limit) {
            List<RunRecord> records = runs.values().stream()
                .map(FakeRun::toRecord)
                .filter(run -> run.projectId().equals(projectId))
                .filter(run -> ownerId.equals(projectOwners.get(projectId)))
                .sorted((left, right) -> {
                    int byCreated = right.createdAt().compareTo(left.createdAt());
                    return byCreated != 0 ? byCreated : right.id().compareTo(left.id());
                })
                .filter(run -> cursor == null
                    || run.createdAt().isBefore(cursor.createdAt())
                    || (run.createdAt().equals(cursor.createdAt()) && run.id().compareTo(cursor.id()) < 0))
                .toList();
            boolean hasMore = records.size() > limit;
            if (hasMore) records = records.subList(0, limit);
            return new RunStore.RunPage(records, hasMore);
        }

        @Override public boolean transition(String runId, String projectId, long expectedVersion, RunState next,
                                            long fencingToken, RunState... allowed) {
            FakeRun run = runs.get(runId);
            if (run == null || fencingToken != currentFencing()
                || !java.util.Set.of(allowed).contains(RunState.valueOf(run.state)) || run.version != expectedVersion) {
                return false;
            }
            run.state = next.name();
            run.version++;
            return true;
        }

        @Override public boolean markRunning(String runId, String projectId, long expectedVersion) {
            FakeRun run = runs.get(runId);
            if (run == null || !fencingToken.isPresent() || run.version != expectedVersion
                || !"STARTING".equals(run.state)) {
                return false;
            }
            run.state = RunState.RUNNING.name();
            run.startedAt = Instant.now();
            run.version++;
            return true;
        }

        @Override public void updateJobFacts(String runId, String jobRef, String podRef) {
            FakeRun run = runs.get(runId);
            if (run != null) { run.jobRef = jobRef; run.podRef = podRef; }
        }

        @Override public void updatePodRef(String runId, String podRef) {
            FakeRun run = runs.get(runId);
            if (run != null) run.podRef = podRef;
        }

        @Override public boolean settle(String runId, RunState state, String terminationReason, Integer exitCode) {
            FakeRun run = runs.get(runId);
            if (run == null || !fencingToken.isPresent()) return false;
            run.state = state.name();
            run.terminationReason = terminationReason;
            run.exitCode = exitCode;
            run.finishedAt = Instant.parse("2026-08-29T12:00:00Z");
            run.version++;
            activeRuns.remove(run.projectId);
            return true;
        }

        @Override public List<RunRecord> findRunsInState(RunState... states) {
            Set<String> wanted = new java.util.HashSet<>();
            for (RunState state : states) wanted.add(state.name());
            return runs.values().stream().filter(run -> wanted.contains(run.state)).map(FakeRun::toRecord).toList();
        }

        private long currentFencing() { return fencingToken.isPresent() ? fencingToken.getAsLong() : -1; }
    }

    public static final class FakeRun {
        public String id;
        public String projectId;
        public long requestedRevision;
        public String state;
        public String policyJson;
        public String jobRef;
        public String podRef;
        public long version;
        public String terminationReason;
        public Integer exitCode;
        public Instant finishedAt;
        public Instant startedAt;
        public Instant createdAt = Instant.parse("2026-08-29T11:00:00Z");
        public long fencingToken;

        public FakeRun(RunRecord record) {
            this.id = record.id();
            this.projectId = record.projectId();
            this.requestedRevision = record.requestedRevision();
            this.state = record.state().name();
            this.policyJson = record.policyJson();
            this.version = record.version();
            this.createdAt = record.createdAt();
            this.fencingToken = record.fencingToken();
            this.podRef = record.podRef();
        }

        RunRecord toRecord() {
            return new RunRecord(id, projectId, requestedRevision, RunState.valueOf(state), policyJson, jobRef,
                podRef, startedAt, finishedAt, exitCode, terminationReason, version, createdAt, fencingToken);
        }
    }

    public static final class StubCoordinator implements JobCoordinator {
        public final List<String> ensureJobCalls = new ArrayList<>();
        public final List<String> stopCalls = new ArrayList<>();
        public final Map<String, JobCoordinator.JobFacts> factsByRun = new HashMap<>();
        public final Map<String, JobCoordinator.LivePod> livePods = new HashMap<>();
        public JobCoordinator.JobFacts nextFacts;
        public RuntimeException ensureJobFailure;

        @Override public String ensureJob(RunRecord run, String projectId) {
            if (ensureJobFailure != null) throw ensureJobFailure;
            ensureJobCalls.add(run.id());
            return "manao-run-" + run.id();
        }

        @Override public Optional<JobCoordinator.JobFacts> facts(RunRecord run) {
            JobCoordinator.JobFacts facts = factsByRun.containsKey(run.id()) ? factsByRun.get(run.id()) : nextFacts;
            return Optional.ofNullable(facts);
        }

        @Override public Optional<JobCoordinator.LivePod> findLivePod(String runId) {
            return Optional.ofNullable(livePods.get(runId));
        }

        @Override public boolean stop(String jobName) {
            stopCalls.add(jobName);
            return true;
        }
    }
}
