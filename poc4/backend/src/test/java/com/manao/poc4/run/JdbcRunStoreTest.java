package com.manao.poc4.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.persistence.DatabaseClock;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.persistence.RunState;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Real-MySQL behavioural tests for {@link JdbcRunStore} fencing/lease semantics. */
class JdbcRunStoreTest {
    static JdbcStoreTestSupport db;
    static MutableClock clock = new MutableClock(Instant.parse("2026-09-01T00:00:00Z"));
    JdbcRunStore store;

    @BeforeAll
    static void up() {
        db = JdbcStoreTestSupport.create();
    }

    @BeforeEach
    void seedStore() {
        store = new JdbcRunStore(db.jdbc(), new DatabaseClock(clock));
    }

    @AfterAll
    static void down() {
        db.close();
    }

    @Test
    void acquireReturnsSameTokenWhileSameHolderRenews() {
        long first = store.acquireFencingToken().orElseThrow();
        clock.advance(Duration.ofSeconds(30));          // 仍在 60s TTL 内
        long second = store.acquireFencingToken().orElseThrow();
        assertThat(second).isEqualTo(first);            // 当前实现：0 行续租 -> token 意外变化
    }

    @Test
    void sameHolderRenewalNeverBumpsTokenEvenAfterGap() {
        long token = store.acquireFencingToken().orElseThrow();
        clock.advance(Duration.ofSeconds(61));          // 越过 TTL；holder 未变
        long again = store.acquireFencingToken().orElseThrow();
        assertThat(again).isEqualTo(token);             // 缺陷：holder 不变却 bump，令正常 Run 卡死
    }

    @Test
    void runSettlesCorrectlyAcrossLeaseRenewals() {
        String projectId = seedProject("p1");
        String runId = "r1-" + UUID.randomUUID();
        long token = store.acquireFencingToken().orElseThrow();
        store.insertRun(run(runId, projectId, 0L), token);
        clock.advance(Duration.ofSeconds(30));
        assertThat(store.acquireFencingToken()).isPresent();
        clock.advance(Duration.ofSeconds(30));              // 累计 60s，旧 TTL 边界
        assertThat(store.acquireFencingToken()).isPresent();
        assertThat(store.markRunning(runId, projectId, 0L)).isTrue();   // 旧实现：fencing_token 不匹配 -> false
        clock.advance(Duration.ofMinutes(10));
        assertThat(store.settle(runId, RunState.SUCCEEDED, "BUILD_SUCCEEDED", 0)).isTrue();
        assertThat(store.findActiveRun(projectId)).isEmpty();
    }

    @Test
    void listUsesExclusiveCursorAndReportsHasMore() {
        String projectId = seedProject("paged");
        String ownerId = "owner-" + projectId;
        long token = store.acquireFencingToken().orElseThrow();
        Instant newest = Instant.parse("2026-09-01T00:03:00Z");
        Instant middle = Instant.parse("2026-09-01T00:02:00Z");
        Instant oldest = Instant.parse("2026-09-01T00:01:00Z");
        store.insertRun(run("paged-new", projectId, newest), token);
        store.insertRun(run("paged-middle", projectId, middle), token);
        store.insertRun(run("paged-old", projectId, oldest), token);

        RunStore.RunPage first = store.listForOwner(ownerId, projectId, null, 2);
        assertThat(first.items()).extracting(RunRecord::id)
            .containsExactly("paged-new", "paged-middle");
        assertThat(first.hasMore()).isTrue();

        RunRecord boundary = first.items().get(1);
        RunStore.RunPage second = store.listForOwner(ownerId, projectId,
            new RunStore.RunCursor(boundary.createdAt(), boundary.id()), 2);
        assertThat(second.items()).extracting(RunRecord::id).containsExactly("paged-old");
        assertThat(second.hasMore()).isFalse();
    }

    @Test
    void takeoverBumpsTokenAndRestampsActiveRuns() {
        String projectId = seedProject("p2");
        String runId = "r2-" + UUID.randomUUID();
        long token = store.acquireFencingToken().orElseThrow();
        store.insertRun(run(runId, projectId, 0L), token);
        String previousInstance = System.getProperty("manao.instance.id");
        try {
            System.setProperty("manao.instance.id", "after-takeover-" + UUID.randomUUID()); // 模拟新实例接管
            long bumped = store.acquireFencingToken().orElseThrow();
            assertThat(bumped).isGreaterThan(token);
            // 接管后活动 Run 必须被重盖为新 token，恢复流程才能推进（否则永久卡 RECOVERING）
            assertThat(store.findRun(runId).orElseThrow().fencingToken()).isEqualTo(bumped);
            assertThat(store.markRunning(runId, projectId, 0L)).isTrue();
        } finally {
            if (previousInstance == null) {
                System.clearProperty("manao.instance.id");
            } else {
                System.setProperty("manao.instance.id", previousInstance);
            }
        }
    }

    @Test
    void recordFirstReadyIsCasOnTheClaimedPodUidAndPersistsTheFixedLifetime() {
        String projectId = seedProject("p3");
        String runId = "r3-" + UUID.randomUUID();
        long token = store.acquireFencingToken().orElseThrow();
        store.insertRun(run(runId, projectId, 0L), token);
        Instant readyAt = clock.instant();
        Instant expiresAt = readyAt.plusSeconds(7200);

        assertThat(store.recordFirstReady(runId, "pod-uid-a", readyAt, expiresAt)).isTrue();
        RunRecord recorded = store.findRun(runId).orElseThrow();
        assertThat(recorded.firstReadyAt()).isEqualTo(readyAt);
        assertThat(recorded.expiresAt()).isEqualTo(expiresAt);
        assertThat(recorded.executionPodUid()).isEqualTo("pod-uid-a");

        // A different Pod can never re-claim the recorded lifetime (replacement Pod CAS denial).
        assertThat(store.recordFirstReady(runId, "pod-uid-b", readyAt.plusSeconds(30),
            readyAt.plusSeconds(30).plusSeconds(7200))).isFalse();
        // The same claimed Pod is idempotent (re-observation must not move the lifetime).
        assertThat(store.recordFirstReady(runId, "pod-uid-a", readyAt.plusSeconds(30),
            readyAt.plusSeconds(30).plusSeconds(7200))).isTrue();
        RunRecord unchanged = store.findRun(runId).orElseThrow();
        assertThat(unchanged.firstReadyAt()).isEqualTo(readyAt);
        assertThat(unchanged.expiresAt()).isEqualTo(expiresAt);
    }

    @Test
    void recordFirstReadyRefusesTerminalRuns() {
        String projectId = seedProject("p4");
        String runId = "r4-" + UUID.randomUUID();
        long token = store.acquireFencingToken().orElseThrow();
        store.insertRun(run(runId, projectId, 0L), token);
        Instant readyAt = clock.instant();
        store.settle(runId, RunState.FAILED, "BUILD_FAILED", 1);
        assertThat(store.recordFirstReady(runId, "pod-uid-a", readyAt, readyAt.plusSeconds(7200))).isFalse();
        assertThat(store.findRun(runId).orElseThrow().firstReadyAt()).isNull();
        assertThat(store.findRun(runId).orElseThrow().executionPodUid()).isNull();
    }

    @Test
    void requestStopAtomicallyPersistsStoppingAndTheIntent() {
        String projectId = seedProject("p6");
        String runId = "r6-" + UUID.randomUUID();
        long token = store.acquireFencingToken().orElseThrow();
        store.insertRun(run(runId, projectId, 0L), token);

        assertThat(store.requestStop(runId, "USER_STOPPED", token)).isTrue();
        RunRecord stopped = store.findRun(runId).orElseThrow();
        assertThat(stopped.state()).isEqualTo(RunState.STOPPING);
        assertThat(stopped.terminationIntent()).isEqualTo("USER_STOPPED");

        // Already STOPPING: not a STARTING/RUNNING transition any more.
        assertThat(store.requestStop(runId, "USER_STOPPED", token)).isFalse();
        // A stale fencing token never writes.
        assertThat(store.requestStop(runId, "USER_STOPPED", token + 999)).isFalse();
        assertThat(store.findRun(runId).orElseThrow().version()).isEqualTo(stopped.version());
    }

    @Test
    void requestStopSurvivesLeaseRenewalsLikeEveryOtherWrite() {
        String projectId = seedProject("p7");
        String runId = "r7-" + UUID.randomUUID();
        long token = store.acquireFencingToken().orElseThrow();
        store.insertRun(run(runId, projectId, 0L), token);
        clock.advance(Duration.ofSeconds(61));
        store.acquireFencingToken(); // renew with the same holder; token unchanged
        assertThat(store.requestStop(runId, "USER_STOPPED", token)).isTrue();
        assertThat(store.findRun(runId).orElseThrow().terminationIntent()).isEqualTo("USER_STOPPED");
    }

    /** Seeds the FK chain (app_user -> project) a Run row needs; ids stay unique per call. */
    private String seedProject(String prefix) {
        String projectId = prefix + "-" + UUID.randomUUID();
        String ownerId = "owner-" + projectId;
        Instant now = clock.instant();
        db.jdbc().update("INSERT INTO app_user(id, username, password_hash, enabled, created_at) VALUES (?, ?, 'hash', TRUE, ?)",
            ownerId, ownerId, now);
        db.jdbc().update("INSERT INTO project(id, owner_id, name, state, workspace_revision, created_at, updated_at) VALUES (?, ?, 'demo', 'READY', 0, ?, ?)",
            projectId, ownerId, now, now);
        return projectId;
    }

    private RunRecord run(String id, String projectId, long version) {
        return new RunRecord(id, projectId, 0L, RunState.STARTING, "{}", null, null, null, null, null, null,
            version, Instant.parse("2026-09-01T00:00:00Z"), 0L);
    }

    private RunRecord run(String id, String projectId, Instant createdAt) {
        return new RunRecord(id, projectId, 0L, RunState.SUCCEEDED, "{}", null, null, null, createdAt, 0,
            "BUILD_SUCCEEDED", 0L, createdAt, 0L);
    }

    /** Hand-rolled mutable clock so lease tests do not depend on wall-clock time. */
    static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant now) {
            this.now = now;
        }

        void advance(Duration duration) {
            now = now.plus(duration);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return Clock.fixed(now, zone);
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
