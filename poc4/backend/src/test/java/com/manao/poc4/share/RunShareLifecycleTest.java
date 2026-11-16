package com.manao.poc4.share;

import static com.manao.poc4.share.RunShareContracts.*;
import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.log.JdbcLogStore;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.run.JdbcRunStore;
import com.manao.poc4.workspace.WorkspaceJdbcStore;
import java.time.Instant;
import java.util.ArrayList;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

class RunShareLifecycleTest {
    static RunShareService service(JdbcTemplate jdbc) {
        return new RunShareService(new JdbcRunShareStore(jdbc), new JdbcRunStore(jdbc),
            new JdbcLogStore(jdbc), new ObjectMapper().findAndRegisterModules());
    }

    static PublishRequest request(RunShareService service, String project, String run) {
        return new PublishRequest(UUID.randomUUID().toString(),
            service.preview("owner", project, run).snapshotDigest(), "标题", "说明");
    }

    static String token(OwnerShare share) { return share.sharePath().substring("/shares/".length()); }

    @Test
    void expiredSnapshotIsGoneBeforePhysicalPurgeRuns() {
        try(var db=JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(),"日志");
            var service=service(db.jdbc());var share=service.publish("owner","project","run",request(service,"project","run")).share();
            db.jdbc().update("UPDATE run_share SET expires_at=UTC_TIMESTAMP(6) WHERE id=?",share.id());
            assertThat(db.jdbc().queryForObject("SELECT log_text FROM run_share WHERE id=?",String.class,share.id())).isEqualTo("日志");
            assertError(service,token(share),"RUN_SHARE_EXPIRED");
        }
    }

    @Test
    void sourceLogCleanupAndActualProjectDeletionSurviveServiceRebuildAndOwnerRevocation() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            RunShareTestFixtures.seedFinishedRun(jdbc, "原样\n\"\\🙂");
            var service = service(jdbc);
            var request = request(service, "project", "run");
            var share = service.publish("owner", "project", "run", request).share();
            var before = service.readPublic(token(share));
            jdbc.update("DELETE FROM run_log_chunk WHERE run_id='run'");
            var source = new WorkspaceJdbcStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()));
            jdbc.update("UPDATE project SET state='DELETING' WHERE id='project'");
            assertThat(source.deleteProject("owner", "project")).isTrue();
            var rebuilt = service(jdbc);
            assertThat(rebuilt.readPublic(token(share))).isEqualTo(before);
            assertThat(rebuilt.listMine("owner", 20, null).items()).containsExactly(share);
            assertThatThrownBy(() -> rebuilt.revoke("other", share.id()))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.code()).isEqualTo("RUN_SHARE_NOT_FOUND"));
            rebuilt.revoke("owner", share.id());
            rebuilt.revoke("owner", share.id());
            assertError(rebuilt, token(share), "RUN_SHARE_REVOKED");
            assertBodyCleared(jdbc, share.id());
            assertThat(rebuilt.publish("owner", "project", "run", request).share().status()).isEqualTo("REVOKED");
            jdbc.update("UPDATE run_share SET expires_at=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 SECOND) WHERE id=?", share.id());
            assertError(rebuilt, token(share), "RUN_SHARE_REVOKED");
        }
    }

    @Test
    void expiryRejectsImmediatelyBeforePurgeAndRetainsReceiptAndExpiredRevokeReason() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            RunShareTestFixtures.seedFinishedRun(jdbc, "日志");
            var service = service(jdbc);
            var request = request(service, "project", "run");
            var share = service.publish("owner", "project", "run", request).share();
            assertThat(service.readPublic(token(share)).snapshot().logText()).isEqualTo("日志");
            jdbc.update("UPDATE run_share SET expires_at=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 SECOND) WHERE id=?", share.id());
            assertError(service, token(share), "RUN_SHARE_EXPIRED");
            var deniedRow=new JdbcRunShareStore(jdbc).findPublic(token(share)).orElseThrow();
            assertThat(deniedRow.logText()).isNull();assertThat(deniedRow.description()).isNull();assertThat(deniedRow.runSnapshotJson()).isNull();
            assertThat(jdbc.queryForObject("SELECT log_text FROM run_share WHERE id=?", String.class, share.id())).isEqualTo("日志");
            assertThat(service(jdbc).purgeExpiredContent()).isEqualTo(1);
            assertThat(service(jdbc).purgeExpiredContent()).isZero();
            assertBodyCleared(jdbc, share.id());
            service.revoke("owner", share.id());
            assertThat(jdbc.queryForObject("SELECT revoked_at FROM run_share WHERE id=?", Object.class, share.id())).isNull();
            assertThat(service.publish("owner", "project", "run", request).share().status()).isEqualTo("EXPIRED");
            assertThat(service.listMine("owner", 20, null).items().get(0).sharePath()).isNull();
        }
    }

    @Test
    void expiredRevocationClearsBodyWithoutChangingReasonEvenBeforePurge() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc=db.jdbc(); RunShareTestFixtures.seedFinishedRun(jdbc, "text");
            var service=service(jdbc); var share=service.publish("owner", "project", "run", request(service,"project","run")).share();
            jdbc.update("UPDATE run_share SET expires_at=UTC_TIMESTAMP(6) WHERE id=?",share.id());
            service.revoke("owner",share.id()); assertBodyCleared(jdbc,share.id());
            assertThat(jdbc.queryForObject("SELECT revoked_at FROM run_share WHERE id=?",Object.class,share.id())).isNull();
            assertError(service,token(share),"RUN_SHARE_EXPIRED");
        }
    }

    @Test
    void exactExpiryBoundaryAndRevocationPriorityAreExplicit() {
        Instant end = Instant.parse("2026-11-19T00:00:00Z");
        assertThat(RunShareService.statusAt(end.minusNanos(1), end, null)).isEqualTo("ACTIVE");
        assertThat(RunShareService.statusAt(end, end, null)).isEqualTo("EXPIRED");
        assertThat(RunShareService.statusAt(end.plusSeconds(1), end, end.minusSeconds(1))).isEqualTo("REVOKED");
    }

    @Test
    void paginationUsesStableTiesOwnerScopeMaxLimitAndImmutableSummaryItems() {
        try (var db = JdbcStoreTestSupport.create()) {
            var jdbc=db.jdbc(); RunShareTestFixtures.seedFinishedRun(jdbc, "text");
            var service=service(jdbc); var share=service.publish("owner","project","run",request(service,"project","run")).share();
            // Clones are independent receipts; all share a creation timestamp to exercise the id tie-breaker.
            for (int i=0;i<52;i++) {
                jdbc.update("INSERT INTO run_share SELECT ?,owner_id,source_project_id,source_run_id,source_project_name,?,title,description,run_snapshot_json,log_text,created_at,expires_at,revoked_at,?,request_digest FROM run_share WHERE id=?",
                    String.format("clone-%03d",i), String.format("%043d",i),UUID.randomUUID().toString(),share.id());
            }
            var page=service.listMine("owner",50,null);
            assertThat(page.items()).hasSize(50); assertThat(page.nextCursor()).isNotBlank();
            var next=service.listMine("owner",50,page.nextCursor()); assertThat(next.items()).hasSize(3);
            assertThat(next.items()).doesNotContainAnyElementsOf(page.items()); assertThat(next.nextCursor()).isNull();
            assertThat(service.listMine("other",50,page.nextCursor()).items()).isEmpty();
            assertThatThrownBy(() -> page.items().clear()).isInstanceOf(UnsupportedOperationException.class);
            assertThatThrownBy(() -> service.listMine("owner",51,null)).isInstanceOf(ApiException.class);
            assertThatThrownBy(() -> service.listMine("owner",0,null)).isInstanceOf(ApiException.class);
            assertThatThrownBy(() -> service.listMine("owner",20,"bad cursor")).isInstanceOf(ApiException.class);
            var list=new ArrayList<OwnerShare>();list.add(share);var copy=new SharePage(list,null);list.clear();
            assertThat(copy.items()).containsExactly(share);
        }
    }

    private static void assertError(RunShareService service,String token,String code) {
        assertThatThrownBy(() -> service.readPublic(token)).isInstanceOfSatisfying(ApiException.class,
            e -> {assertThat(e.code()).isEqualTo(code);assertThat(e.status()).isEqualTo(410);});
    }
    private static void assertBodyCleared(JdbcTemplate jdbc,String id) {
        assertThat(jdbc.queryForMap("SELECT log_text,description,run_snapshot_json FROM run_share WHERE id=?",id).values())
            .containsOnlyNulls();
    }
}
