package com.manao.poc4.audit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class AuditIngressServiceTest {
    private static final String SESSION = "sess-1";
    private static final String PROJECT = "prj-1";
    private static final String RUN = "run-1";
    private static final String USER = "alice-id";
    private static final byte[] MAC_KEY = new byte[32];
    static {
        new java.security.SecureRandom().nextBytes(MAC_KEY);
    }

    private FakeAuditStore store;
    private AuditIngressService service;

    @BeforeEach
    void setUp() {
        store = new FakeAuditStore();
        service = new AuditIngressService(store);
        service.bindSession(SESSION, PROJECT, RUN, USER, MAC_KEY);
    }

    private static String canonical(long seq, String command, Integer exitCode, String state) {
        return AuditIngressService.canonicalJson(
            new AuditIngressService.WrapperEvent(SESSION, seq, command, exitCode, state, null));
    }

    private static String mac(String payload) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(MAC_KEY, "HmacSHA256"));
            return Base64.getEncoder().encodeToString(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    private String event(long seq, String command, Integer exitCode, String state, String withMac) {
        String payload = canonical(seq, command, exitCode, state);
        return payload.substring(0, payload.length() - 1) + ",\"mac\":\"" + withMac + "\"}";
    }

    private boolean ingest(long seq, String command, Integer exitCode, String state) {
        return service.ingest(new AuditIngressService.WrapperEvent(SESSION, seq, command, exitCode, state,
            mac(canonical(seq, command, exitCode, state))));
    }

    @Test
    void acceptsMonotonicSignedEventsAndRedactsSensitiveCommands() {
        assertThat(ingest(1, "mvn clean test", null, "RUNNING")).isTrue();
        assertThat(ingest(2, "curl https://user:secret@example.com", null, "RUNNING")).isTrue();
        assertThat(ingest(3, "mvn clean test", 0, "SUCCEEDED")).isTrue();

        assertThat(store.audits).hasSize(3);
        AuditStore.AuditRecord second = store.audits.get(1);
        assertThat(second.command()).doesNotContain("secret");
        assertThat(second.sensitiveDetected()).isTrue();
        assertThat(store.audits.get(0).sensitiveDetected()).isFalse();
        assertThat(store.audits.get(2).state()).isEqualTo("SUCCEEDED");
        assertThat(store.audits.get(2).exitCode()).isZero();
    }

    @Test
    void rejectsWrongMacDuplicateSeqAndOutOfRangeSequence() {
        assertThat(ingest(1, "ls", null, "RUNNING")).isTrue();
        // Wrong MAC
        assertThat(service.ingest(new AuditIngressService.WrapperEvent(SESSION, 2, "fake", null, "RUNNING", "bad-mac")))
            .isFalse();
        // Session mismatch
        assertThat(service.ingest(new AuditIngressService.WrapperEvent("other", 2, "fake", null, "RUNNING",
            mac(canonical(2, "fake", null, "RUNNING")).replace(SESSION, "other")))).isFalse();
        // Duplicate seq
        assertThat(ingest(1, "ls", null, "RUNNING")).isFalse();
        // Out of order (gap)
        assertThat(ingest(5, "ls", null, "RUNNING")).isFalse();
        assertThat(store.audits).hasSize(1);
    }

    @Test
    void shellIntegrationEventsCoverBackspaceCompletionMultilineAndSignals() {
        assertThat(ingest(1, "ma\u0008vn clean test", null, "RUNNING")).isTrue();
        assertThat(ingest(2, "mvn cl\t", null, "RUNNING")).isTrue();
        assertThat(ingest(3, "echo one \\\n two", null, "RUNNING")).isTrue();
        assertThat(ingest(4, "top", null, "RUNNING")).isTrue();
        assertThat(ingest(5, "top", 130, "FAILED")).isTrue(); // Ctrl-C
        assertThat(ingest(6, "", 0, "INTERRUPTED")).isTrue(); // shell exit

        assertThat(store.audits).extracting(AuditStore.AuditRecord::seq)
            .containsExactly(1L, 2L, 3L, 4L, 5L, 6L);
        assertThat(store.audits.get(4).state()).isEqualTo("FAILED");
        assertThat(store.audits.get(5).state()).isEqualTo("INTERRUPTED");
    }

    @Test
    void redactorMasksPasswordsTokensAuthorizationEnvAssignmentsAndUrlCredentials() {
        assertThat(CommandRedactor.redact("mysql -u root --password=hunter2", new boolean[1]))
            .isEqualTo("mysql -u root --password=***");
        assertThat(CommandRedactor.redact("deploy --token=abc123", new boolean[1])).isEqualTo("deploy --token=***");
        assertThat(CommandRedactor.redact("curl -H 'Authorization: Bearer xyz'", new boolean[1]))
            .isEqualTo("curl -H 'Authorization: ***'");
        assertThat(CommandRedactor.redact("AWS_SECRET_ACCESS_KEY=wow curl", new boolean[1]))
            .isEqualTo("AWS_SECRET_ACCESS_KEY=*** curl");
        assertThat(CommandRedactor.redact("git push https://user:pw@host/repo", new boolean[1]))
            .isEqualTo("git push https://***@host/repo");
    }

    @Test
    void settlementHappensExactlyOnce() {
        ingest(1, "mvn clean test", null, "RUNNING");
        String auditId = store.audits.get(0).id();
        assertThat(service.settle(SESSION, 1, "SUCCEEDED", 0)).isTrue();
        assertThat(service.settle(SESSION, 1, "FAILED", 1)).isFalse();
        assertThat(store.audits.get(0).state()).isEqualTo("SUCCEEDED");
        assertThat(store.audits.get(0).exitCode()).isZero();
    }

    static final class FakeAuditStore implements AuditStore {
        final List<AuditRecord> audits = new ArrayList<>();
        final Map<String, Boolean> settled = new HashMap<>();

        @Override public String insertRunning(String sessionId, String projectId, String runId, String userId,
                                              long seq, String command, boolean sensitiveDetected, String trustLevel,
                                              Instant startedAt) {
            assertThat(trustLevel).isEqualTo(AuditIngressService.TRUST_LEVEL_WRAPPER_TRANSPORT);
            String id = "audit-" + seq;
            audits.add(new AuditRecord(id, sessionId, seq, command, "RUNNING", startedAt, null, null, sensitiveDetected));
            return id;
        }

        @Override public boolean settle(String auditId, String state, Integer exitCode, Instant finishedAt) {
            if (settled.put(auditId, true) != null) return false;
            for (int i = 0; i < audits.size(); i++) {
                AuditRecord record = audits.get(i);
                if (record.id().equals(auditId)) {
                    audits.set(i, new AuditRecord(record.id(), record.sessionId(), record.seq(), record.command(),
                        state, record.startedAt(), finishedAt, exitCode, record.sensitiveDetected()));
                    return true;
                }
            }
            return false;
        }

        @Override public List<AuditRecord> list(String runId, int limit) {
            return audits.stream().filter(record -> record.sessionId() != null).limit(limit).toList();
        }

        @Override public int deleteExpiredBefore(Instant cutoff) {
            return 0;
        }

        @Override public java.util.List<AuditRecord> listBefore(String runId, Instant startedAt, String idExclusive, int limit) {
            return java.util.List.of();
        }
    }
}
