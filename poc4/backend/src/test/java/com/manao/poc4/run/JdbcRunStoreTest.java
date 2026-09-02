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
