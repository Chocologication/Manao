package com.manao.poc4.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.persistence.DatabaseClock;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
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
