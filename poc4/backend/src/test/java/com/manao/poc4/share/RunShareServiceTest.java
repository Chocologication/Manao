package com.manao.poc4.share;

import static com.manao.poc4.share.RunShareContracts.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.log.JdbcLogStore;
import com.manao.poc4.log.RunLogWindow;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.run.JdbcRunStore;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

class RunShareServiceTest {
    private static RunShareService service(JdbcTemplate jdbc) {
        return service(jdbc, new JdbcRunShareStore(jdbc));
    }

    private static RunShareService service(JdbcTemplate jdbc, JdbcRunShareStore shares) {
        return new RunShareService(shares, new JdbcRunStore(jdbc), new JdbcLogStore(jdbc),
            new ObjectMapper().findAndRegisterModules());
    }

    private static PublishRequest request(Preview preview) {
        return new PublishRequest(UUID.randomUUID().toString(), preview.snapshotDigest(), "运行结果", "");
    }

    private static void error(Runnable action, String code, int status) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.code()).isEqualTo(code);
            assertThat(e.status()).isEqualTo(status);
        });
    }

    @ParameterizedTest @EnumSource(RunState.class)
    void onlySelectedTerminalRunsCanBePreviewedAndPublished(RunState state) {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "日志\n");
            db.jdbc().update("UPDATE run SET state=? WHERE id='run'", state.name());
            var service = service(db.jdbc());
            if (List.of(RunState.SUCCEEDED, RunState.FAILED, RunState.CANCELLED, RunState.TIMED_OUT).contains(state)) {
                var preview = service.preview("owner", "project", "run");
                assertThat(preview.snapshot().run().state()).isEqualTo(state.name());
                assertThat(service.publish("owner", "project", "run", request(preview)).created()).isTrue();
            } else {
                error(() -> service.preview("owner", "project", "run"), "RUN_SHARE_NOT_TERMINAL", 409);
                error(() -> service.publish("owner", "project", "run",
                    new PublishRequest(UUID.randomUUID().toString(), "d".repeat(64), "标题", "")), "RUN_SHARE_NOT_TERMINAL", 409);
            }
        }
    }

    @Test void previewAndPersistenceUseEveryRawDatabaseChunkInSequence() {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), " 中文😀\r\n");
            String tail = "尾部\n\t ";
            new JdbcLogStore(db.jdbc()).insertChunk("run", new RunLogWindow.Chunk(3, tail,
                tail.getBytes(StandardCharsets.UTF_8).length, Instant.now()));
            db.jdbc().update("UPDATE run SET exit_code=NULL,started_at=NULL WHERE id='run'");
            db.jdbc().update("INSERT INTO run(id,project_id,requested_revision,state,policy_json,created_at,updated_at,fencing_token) "
                + "VALUES ('active','project',0,'RUNNING','{}',UTC_TIMESTAMP(6),UTC_TIMESTAMP(6),1)");
            var service = service(db.jdbc());
            var preview = service.preview("owner", "project", "run");
            assertThat(preview.kind()).isEqualTo("PREVIEW");
            assertThat(preview.share()).isNull();
            assertThat(preview.snapshot().logText()).isEqualTo(" 中文😀\r\n尾部\n\t ");
            assertThat(preview.snapshot().run().exitCode()).isNull();
            assertThat(preview.snapshot().run().startedAt()).isNull();
            assertThat(preview.snapshot().run().createdAt()).isEqualTo(Instant.parse("2026-01-01T00:00:00Z"));
            assertThat(preview.snapshotDigest()).matches("[0-9a-f]{64}");
            assertThat(service.preview("owner", "project", "run").snapshotDigest()).isEqualTo(preview.snapshotDigest());
            var result = service.publish("owner", "project", "run", request(preview));
            assertThat(db.jdbc().queryForObject("SELECT log_text FROM run_share", String.class)).isEqualTo(preview.snapshot().logText());
            assertThat(result.share().sharePath()).matches("/shares/[A-Za-z0-9_-]{43}");
            var existing = service.preview("owner", "project", "run");
            assertThat(existing.kind()).isEqualTo("EXISTING");
            assertThat(existing.snapshot()).isNull();
            assertThat(existing.snapshotDigest()).isNull();
            assertThat(existing.share()).isEqualTo(result.share());
        }
    }

    @Test void emptyLogsArePublishableAndDifferentFromChangedPreview() {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "first\n");
            var service = service(db.jdbc());
            var old = service.preview("owner", "project", "run");
            db.jdbc().update("DELETE FROM run_log_chunk WHERE run_id='run'");
            error(() -> service.publish("owner", "project", "run", request(old)), "RUN_SHARE_PREVIEW_CHANGED", 409);
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM run_share", Integer.class)).isZero();
            var empty = service.preview("owner", "project", "run");
            assertThat(empty.snapshot().logText()).isEmpty();
            service.publish("owner", "project", "run", request(empty));
            assertThat(db.jdbc().queryForObject("SELECT log_text FROM run_share", String.class)).isEmpty();
        }
    }

    @ParameterizedTest @ValueSource(strings={"java", "python", "javascript", "typescript"})
    void runtimeComesFromStoredRunPolicy(String language) {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "");
            String policy = switch (language) {
                case "java" -> "{\"runtime\":{\"javaMajor\":11,\"mavenMajor\":3}}";
                case "python" -> "{\"templateId\":\"python-console\",\"command\":\"python -u main.py\",\"runtime\":{\"language\":\"python\",\"pythonVersion\":\"3.12\",\"packageManager\":\"uv\"}}";
                default -> "{\"templateId\":\"node-" + language + "-console\",\"command\":\"pnpm start\",\"runtime\":{\"language\":\"" + language + "\",\"nodeMajor\":24,\"packageManager\":\"pnpm\",\"pnpmMajor\":10}}";
            };
            db.jdbc().update("UPDATE run SET policy_json=? WHERE id='run'", policy);
            var run = service(db.jdbc()).preview("owner", "project", "run").snapshot().run();
            assertThat(run.language()).isEqualTo(language);
            assertThat(run.runtimeLabel()).isEqualTo(switch (language) {
                case "java" -> "Java 11 / Maven 3";
                case "python" -> "Python 3.12 / uv";
                default -> "Node.js 24 / pnpm 10";
            });
        }
    }

    @Test void ownershipMissingProjectDeletingProjectAndCorruptPolicyFailClosed() {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "");
            var service = service(db.jdbc());
            error(() -> service.preview("other", "project", "run"), "RUN_NOT_FOUND", 404);
            error(() -> service.publish("other", "project", "run", new PublishRequest(UUID.randomUUID().toString(), "a".repeat(64), "标题", "")), "RUN_NOT_FOUND", 404);
            error(() -> service.preview("owner", "missing", "run"), "RUN_NOT_FOUND", 404);
            error(() -> service.preview("owner", "project", "missing"), "RUN_NOT_FOUND", 404);
            db.jdbc().update("UPDATE project SET state='DELETING'");
            error(() -> service.preview("owner", "project", "run"), "PROJECT_LOCKED", 409);
            error(() -> service.publish("owner", "project", "run", new PublishRequest(UUID.randomUUID().toString(), "a".repeat(64), "标题", "")), "PROJECT_LOCKED", 409);
            db.jdbc().update("UPDATE project SET state='READY'");
            db.jdbc().update("UPDATE run SET policy_json='{}'");
            error(() -> service.preview("owner", "project", "run"), "INTERNAL_ERROR", 500);
        }
    }

    @Test void sameRequestRecoversOriginalIdentityAfterSourceDeletionAndDoesNotExtendExpiry() {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "data");
            var service = service(db.jdbc());
            var preview = service.preview("owner", "project", "run");
            var request = new PublishRequest(UUID.randomUUID().toString(), preview.snapshotDigest(), " 标题 ", " 说明 ");
            var first = service.publish("owner", "project", "run", request);
            assertThat(first.share().title()).isEqualTo("标题");
            assertThat(db.jdbc().queryForObject("SELECT description FROM run_share", String.class)).isEqualTo("说明");
            deleteSource(db.jdbc());
            var again = service.publish("owner", "project", "run", new PublishRequest(request.requestId(), request.snapshotDigest(), "标题", "说明"));
            assertThat(again.created()).isFalse();
            assertThat(again.share()).isEqualTo(first.share());
            error(() -> service.publish("owner", "project", "run", new PublishRequest(request.requestId(), request.snapshotDigest(), "不同", "说明")), "RUN_SHARE_REQUEST_MISMATCH", 409);
            error(() -> service.publish("owner", "different-project", "run", request), "RUN_SHARE_REQUEST_MISMATCH", 409);
            error(() -> service.publish("owner", "project", "different-run", request), "RUN_SHARE_REQUEST_MISMATCH", 409);
            error(() -> service.publish("owner", "project", "run", new PublishRequest(request.requestId(), "f".repeat(64), "标题", "说明")), "RUN_SHARE_REQUEST_MISMATCH", 409);
            error(() -> service.publish("owner", "project", "run", new PublishRequest(request.requestId(), request.snapshotDigest(), "标题", "不同说明")), "RUN_SHARE_REQUEST_MISMATCH", 409);
            db.jdbc().update("UPDATE run_share SET expires_at=UTC_TIMESTAMP(6)");
            db.jdbc().update("UPDATE run_share SET log_text=NULL,description=NULL,run_snapshot_json=NULL");
            assertThat(service.publish("owner", "project", "run", request).share().status()).isEqualTo("EXPIRED");
            assertThat(service.publish("owner", "project", "run", request).share().sharePath()).isNull();
            db.jdbc().update("UPDATE run_share SET expires_at=UTC_TIMESTAMP(6)+INTERVAL 1 HOUR,revoked_at=UTC_TIMESTAMP(6)");
            assertThat(service.publish("owner", "project", "run", request).share().status()).isEqualTo("REVOKED");
        }
    }

    @Test void retryOfPreviouslyRevokedShareRemainsRevokedAfterItsOriginalExpiry() {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "");
            var service = service(db.jdbc());
            var request = request(service.preview("owner", "project", "run"));
            service.publish("owner", "project", "run", request);
            db.jdbc().update("UPDATE run_share SET created_at=UTC_TIMESTAMP(6)-INTERVAL 73 HOUR,"
                + "revoked_at=UTC_TIMESTAMP(6)-INTERVAL 72 HOUR,expires_at=UTC_TIMESTAMP(6)-INTERVAL 1 HOUR,"
                + "log_text=NULL,description=NULL,run_snapshot_json=NULL");
            deleteSource(db.jdbc());
            var retry = service.publish("owner", "project", "run", request);
            assertThat(retry.created()).isFalse();
            assertThat(retry.share().status()).isEqualTo("REVOKED");
            assertThat(retry.share().sharePath()).isNull();
        }
    }

    @Test void differentRequestDoesNotOverwriteActiveShareButExpiredOrRevokedAllowsNewShare() {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "");
            var service = service(db.jdbc());
            var preview = service.preview("owner", "project", "run");
            service.publish("owner", "project", "run", request(preview));
            error(() -> service.publish("owner", "project", "run", request(preview)), "RUN_SHARE_ALREADY_ACTIVE", 409);
            db.jdbc().update("UPDATE run_share SET expires_at=UTC_TIMESTAMP(6)");
            assertThat(service.preview("owner", "project", "run").kind()).isEqualTo("PREVIEW");
            service.publish("owner", "project", "run", request(preview));
            db.jdbc().update("UPDATE run_share SET revoked_at=UTC_TIMESTAMP(6)");
            service.publish("owner", "project", "run", request(preview));
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM run_share", Integer.class)).isEqualTo(3);
        }
    }

    @Test void invalidRequestsNeverWriteShares() {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "");
            var service = service(db.jdbc());
            String id = UUID.randomUUID().toString(), digest = "a".repeat(64);
            for (PublishRequest invalid : List.of(new PublishRequest("1-1-1-1-1", digest, "ok", ""),
                new PublishRequest(id, "A".repeat(64), "ok", ""), new PublishRequest(id, digest, " ", ""),
                new PublishRequest(id, digest, "😀".repeat(51), ""), new PublishRequest(id, digest, "ok", "x".repeat(2001)))) {
                error(() -> service.publish("owner", "project", "run", invalid), "VALIDATION_ERROR", 422);
            }
            error(() -> service.publish("owner", "project", "run", null), "VALIDATION_ERROR", 422);
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM run_share", Integer.class)).isZero();
        }
    }

    @Test void parallelDifferentRequestsCreateExactlyOneActiveShare() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "");
            var service = service(db.jdbc());
            var preview = service.preview("owner", "project", "run");
            var start = new CyclicBarrier(2);
            List<Object> results = concurrently(() -> { start.await(10, TimeUnit.SECONDS); return capture(() -> service.publish("owner", "project", "run", request(preview))); },
                () -> { start.await(10, TimeUnit.SECONDS); return capture(() -> service.publish("owner", "project", "run", request(preview))); });
            assertThat(results.stream().filter(PublishOutcome.class::isInstance).count()).isEqualTo(1);
            assertThat(results.stream().filter(ApiException.class::isInstance).map(ApiException.class::cast).map(ApiException::code)).containsExactly("RUN_SHARE_ALREADY_ACTIVE");
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM run_share WHERE revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(6)", Integer.class)).isEqualTo(1);
        }
    }

    @Test void sameKeyAcrossProjectsReconcilesUniqueConflictOutsideFailedTransaction() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "");
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "owner", "project2", "run2", "");
            var shares = spy(new JdbcRunShareStore(db.jdbc()));
            var service = service(db.jdbc(), shares);
            var barrier = new CyclicBarrier(2);
            doAnswer(call -> { barrier.await(10, TimeUnit.SECONDS); return call.callRealMethod(); }).when(shares).insert(any());
            var reconciliationOutside = new AtomicBoolean();
            var lookups = new ConcurrentHashMap<Long, AtomicInteger>();
            doAnswer(call -> {
                int count = lookups.computeIfAbsent(Thread.currentThread().getId(), key -> new AtomicInteger()).incrementAndGet();
                if (count >= 3 && !TransactionSynchronizationManager.isActualTransactionActive()) reconciliationOutside.set(true);
                return call.callRealMethod();
            }).when(shares).findReceiptByRequest(anyString(), anyString());
            String requestId = UUID.randomUUID().toString();
            var one = new PublishRequest(requestId, service.preview("owner", "project", "run").snapshotDigest(), "title", "");
            var two = new PublishRequest(requestId, service.preview("owner", "project2", "run2").snapshotDigest(), "title", "");
            List<Object> results = concurrently(() -> capture(() -> service.publish("owner", "project", "run", one)),
                () -> capture(() -> service.publish("owner", "project2", "run2", two)));
            assertThat(results.stream().filter(PublishOutcome.class::isInstance).count()).isEqualTo(1);
            assertThat(results.stream().filter(ApiException.class::isInstance).map(ApiException.class::cast).map(ApiException::code)).containsExactly("RUN_SHARE_REQUEST_MISMATCH");
            assertThat(reconciliationOutside).isTrue();
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM run_share", Integer.class)).isEqualTo(1);
        }
    }

    @Test void concurrentSameRequestReturnsIdenticalLinkWithoutExtendingExpiry() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "");
            var service = service(db.jdbc());
            var request = request(service.preview("owner", "project", "run"));
            var barrier = new CyclicBarrier(2);
            var results = concurrently(
                () -> { barrier.await(10, TimeUnit.SECONDS); return service.publish("owner", "project", "run", request); },
                () -> { barrier.await(10, TimeUnit.SECONDS); return service.publish("owner", "project", "run", request); });
            var first = (PublishOutcome) results.get(0);
            var second = (PublishOutcome) results.get(1);
            assertThat(first.created()).isNotEqualTo(second.created());
            assertThat(first.share()).isEqualTo(second.share());
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM run_share", Integer.class)).isEqualTo(1);
        }
    }

    @Test void publishPersistsTheSnapshotAlreadyCheckedEvenIfSourceChangesAfterLogRead() {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "original\n");
            var preview = service(db.jdbc()).preview("owner", "project", "run");
            var logs = spy(new JdbcLogStore(db.jdbc()));
            doAnswer(call -> {
                Object chunks = call.callRealMethod();
                db.jdbc().update("UPDATE run_log_chunk SET text_utf8='changed' WHERE run_id='run'");
                return chunks;
            }).when(logs).loadChunks("run");
            var service = new RunShareService(new JdbcRunShareStore(db.jdbc()), new JdbcRunStore(db.jdbc()),
                logs, new ObjectMapper().findAndRegisterModules());
            service.publish("owner", "project", "run", request(preview));
            assertThat(db.jdbc().queryForObject("SELECT log_text FROM run_share", String.class)).isEqualTo("original\n");
            assertThat(db.jdbc().queryForObject("SELECT text_utf8 FROM run_log_chunk", String.class)).isEqualTo("changed");
        }
    }

    @Test void projectTransactionProvidesReadCommittedAndRollsBackTheWholeCreation() {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "");
            var shares = new JdbcRunShareStore(db.jdbc());
            shares.inProjectTransaction("owner", "project", project -> {
                assertThat(project.orElseThrow().id()).isEqualTo("project");
                assertThat(db.jdbc().queryForObject("SELECT @@transaction_isolation", String.class)).isEqualTo("READ-COMMITTED");
                return null;
            });
            var failure = new IllegalStateException("abort after insert");
            assertThatThrownBy(() -> shares.inProjectTransaction("owner", "project", project -> {
                shares.insert(new JdbcRunShareStore.NewShare(UUID.randomUUID().toString(), "owner", "project", "run",
                    "name", "A".repeat(43), "title", "", "{}", "", UUID.randomUUID().toString(), "a".repeat(64)));
                throw failure;
            })).isSameAs(failure);
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM run_share", Integer.class)).isZero();
            shares.inProjectTransaction("other", "project", project -> { assertThat(project).isEmpty(); return null; });
        }
    }

    @Test void sameRequestIdIsIndependentAcrossOwners() {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "");
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "owner2", "project2", "run2", "");
            var service = service(db.jdbc());
            String id = UUID.randomUUID().toString();
            var first = service.publish("owner", "project", "run", new PublishRequest(id, service.preview("owner", "project", "run").snapshotDigest(), "title", ""));
            var second = service.publish("owner2", "project2", "run2", new PublishRequest(id, service.preview("owner2", "project2", "run2").snapshotDigest(), "title", ""));
            assertThat(second.share().id()).isNotEqualTo(first.share().id());
        }
    }

    @Test void receiptIsRecheckedWhenProjectDisappearsAfterInitialMiss() throws Exception {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "data");
            var regular = service(db.jdbc());
            var req = request(regular.preview("owner", "project", "run"));
            var shares = spy(new JdbcRunShareStore(db.jdbc()));
            var missed = new CountDownLatch(1);
            var resume = new CountDownLatch(1);
            var firstLookup = new AtomicBoolean(true);
            doAnswer(call -> {
                Object found = call.callRealMethod();
                if (firstLookup.getAndSet(false)) { missed.countDown(); assertThat(resume.await(10, TimeUnit.SECONDS)).isTrue(); }
                return found;
            }).when(shares).findReceiptByRequest("owner", req.requestId());
            var executor = Executors.newSingleThreadExecutor();
            try {
                var retry = executor.submit(() -> service(db.jdbc(), shares).publish("owner", "project", "run", req));
                assertThat(missed.await(10, TimeUnit.SECONDS)).isTrue();
                var original = regular.publish("owner", "project", "run", req);
                deleteSource(db.jdbc());
                resume.countDown();
                assertThat(retry.get(10, TimeUnit.SECONDS).share()).isEqualTo(original.share());
            } finally { resume.countDown(); executor.shutdownNow(); }
        }
    }

    @Test void tokenConflictsAndOtherDatabaseFailuresAreNeverReconciledAsSuccess() {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "");
            for (RuntimeException failure : List.of(new DuplicateKeyException("token collision", new SQLException("Duplicate entry for key 'run_share.uq_run_share_token'", "23000", 1062)),
                new DataAccessResourceFailureException("connection unavailable"))) {
                var shares = spy(new JdbcRunShareStore(db.jdbc()));
                doThrow(failure).when(shares).insert(any());
                var service = service(db.jdbc(), shares);
                assertThatThrownBy(() -> service.publish("owner", "project", "run", request(service.preview("owner", "project", "run")))).isSameAs(failure);
            }
            assertThat(db.jdbc().queryForObject("SELECT COUNT(*) FROM run_share", Integer.class)).isZero();
        }
    }

    private static void deleteSource(JdbcTemplate jdbc) {
        jdbc.update("DELETE FROM run WHERE project_id='project'");
        jdbc.update("DELETE FROM project WHERE id='project'");
    }

    private static Object capture(Callable<PublishOutcome> action) throws Exception {
        try { return action.call(); } catch (ApiException e) { return e; }
    }

    private static List<Object> concurrently(Callable<Object> one, Callable<Object> two) throws Exception {
        var executor = Executors.newFixedThreadPool(2);
        try {
            var first = executor.submit(one);
            var second = executor.submit(two);
            return List.of(first.get(20, TimeUnit.SECONDS), second.get(20, TimeUnit.SECONDS));
        } finally { executor.shutdownNow(); }
    }
}
