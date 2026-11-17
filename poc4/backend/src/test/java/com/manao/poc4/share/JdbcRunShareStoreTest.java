package com.manao.poc4.share;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.time.Duration;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.TimeZone;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;

class JdbcRunShareStoreTest {
    @Test
    void tokensAreCaseSensitiveAndUnique() {
        try (var db = JdbcStoreTestSupport.create()) {
            insert(db.jdbc(), "owner", UUID.randomUUID().toString(), "A".repeat(43), "first");
            insert(db.jdbc(), "owner", UUID.randomUUID().toString(), "a".repeat(43), "second");
            assertThat(db.jdbc().queryForObject("SELECT log_text FROM run_share WHERE token=?", String.class, "A".repeat(43))).isEqualTo("first");
            assertThatThrownBy(() -> insert(db.jdbc(), "other", UUID.randomUUID().toString(), "A".repeat(43), "duplicate"))
                .isInstanceOf(DuplicateKeyException.class);
        }
    }

    @Test
    void requestIdIsUniqueWithinOwnerOnly() {
        try (var db = JdbcStoreTestSupport.create()) {
            String request = UUID.randomUUID().toString();
            insert(db.jdbc(), "owner", request, "A".repeat(43), "first");
            assertThatThrownBy(() -> insert(db.jdbc(), "owner", request, "B".repeat(43), "duplicate"))
                .isInstanceOf(DuplicateKeyException.class);
            insert(db.jdbc(), "other", request, "C".repeat(43), "allowed");
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM run_share", Integer.class)).isEqualTo(2);
        }
    }

    @Test
    void nearFiveMiBLogRemainsExactAndEmptyLogDiffersFromReclaimedNull() {
        try (var db = JdbcStoreTestSupport.create()) {
            // Backslashes, quotes and control characters also exercise JDBC packet escaping.
            String text = " 中文😀\r\n\t\\\"\u001b[31m ".repeat(230_000);
            assertThat(text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length).isBetween(4_500_000, 5_242_880);
            insert(db.jdbc(), "owner", UUID.randomUUID().toString(), "A".repeat(43), text);
            insert(db.jdbc(), "owner", UUID.randomUUID().toString(), "B".repeat(43), "");
            insert(db.jdbc(), "owner", UUID.randomUUID().toString(), "C".repeat(43), null);
            assertThat(db.jdbc().queryForObject("SELECT log_text FROM run_share WHERE token=?", String.class, "A".repeat(43))).isEqualTo(text);
            assertThat(db.jdbc().queryForObject("SELECT log_text FROM run_share WHERE token=?", String.class, "B".repeat(43))).isEmpty();
            assertThat(db.jdbc().queryForObject("SELECT log_text FROM run_share WHERE token=?", String.class, "C".repeat(43))).isNull();
        }
    }

    private static void insert(JdbcTemplate jdbc, String owner, String request, String token, String text) {
        var store = new JdbcRunShareStore(jdbc);
        store.insert(new JdbcRunShareStore.NewShare(UUID.randomUUID().toString(), owner,
            "deleted-project", "deleted-run", "原项目", token, "运行结果", "说明", "{}", text,
            request, "d".repeat(64)));
        assertThat(store.findByRequest(owner, request).orElseThrow().logText()).isEqualTo(text);
    }

    @Test
    void databaseUtcTimeDefinesSeventyTwoHoursEvenWithNonUtcJvmTimezone() {
        TimeZone original = TimeZone.getDefault();
        TimeZone.setDefault(TimeZone.getTimeZone("America/Los_Angeles"));
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            var store = new JdbcRunShareStore(jdbc);
            var before = jdbc.queryForObject("SELECT UTC_TIMESTAMP(6)", LocalDateTime.class).toInstant(ZoneOffset.UTC);
            String request = UUID.randomUUID().toString();
            insert(jdbc, "owner", request, "A".repeat(43), "原样\r\n");
            var row = store.findByRequest("owner", request).orElseThrow();
            var after = jdbc.queryForObject("SELECT UTC_TIMESTAMP(6)", LocalDateTime.class).toInstant(ZoneOffset.UTC);
            assertThat(row.createdAt()).isBetween(before, after);
            assertThat(Duration.between(row.createdAt(), row.expiresAt())).isEqualTo(Duration.ofHours(72));
            assertThat(jdbc.queryForObject("SELECT created_at FROM run_share WHERE id=?", LocalDateTime.class, row.id()))
                .isEqualTo(LocalDateTime.ofInstant(row.createdAt(), ZoneOffset.UTC));
            assertThat(row.requestDigest()).isEqualTo("d".repeat(64));
            assertThat(row.sourceProjectId()).isEqualTo("deleted-project");
            assertThat(row.sourceRunId()).isEqualTo("deleted-run");
            assertThat(row.revokedAt()).isNull();
            assertThat(store.findByRequest("other", request)).isEmpty();
        } finally {
            TimeZone.setDefault(original);
        }
    }
}
