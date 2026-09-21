package com.manao.poc4.run;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.Test;

/**
 * The receipt is the single runtime-written evidence channel; parsing is strict so a tampered or
 * foreign file can never masquerade as run facts. Production validation never relaxes for
 * short-lived test receipts.
 */
class RunExecutionReceiptTest {

    @Test
    void acceptsOnlyFixedLifetimeInReadyReceipt() {
        String receipt = "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=READY\n"
            + "firstReadyAt=2026-09-21T10:05:00Z\nexpiresAt=2026-09-21T12:05:00Z\nreason=\n";
        var parsed = RunExecutionReceipt.parse(receipt);
        assertThat(Duration.between(parsed.firstReadyAt(), parsed.expiresAt())).isEqualTo(Duration.ofSeconds(7200));
        assertThatThrownBy(() -> RunExecutionReceipt.parse(receipt.replace("12:05:00", "13:05:00")))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void readyReceiptCarriesTheFullAllowlistIdentity() {
        var parsed = RunExecutionReceipt.parse("protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=READY\n"
            + "firstReadyAt=2026-09-21T10:05:00Z\nexpiresAt=2026-09-21T12:05:00Z\nreason=\n");
        assertThat(parsed.projectId()).isEqualTo("p1");
        assertThat(parsed.runId()).isEqualTo("r1");
        assertThat(parsed.podUid()).isEqualTo("u1");
        assertThat(parsed.state()).isEqualTo("READY");
        assertThat(parsed.reason()).isEmpty();
    }

    @Test
    void claimedReceiptHasNoLifetimeYet() {
        var parsed = RunExecutionReceipt.parse(
            "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=CLAIMED\nreason=\n");
        assertThat(parsed.state()).isEqualTo("CLAIMED");
        assertThat(parsed.firstReadyAt()).isNull();
        assertThat(parsed.expiresAt()).isNull();
        assertThatThrownBy(() -> RunExecutionReceipt.parse(
            "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=CLAIMED\n"
                + "firstReadyAt=2026-09-21T10:05:00Z\nexpiresAt=2026-09-21T12:05:00Z\nreason=\n"))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void terminalReceiptsKeepTheFixedLifetimeRule() {
        String timedOut = "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=TIMED_OUT\n"
            + "firstReadyAt=2026-09-21T10:05:00Z\nexpiresAt=2026-09-21T12:05:00Z\nreason=TIME_LIMIT_EXCEEDED\n";
        assertThat(RunExecutionReceipt.parse(timedOut).reason()).isEqualTo("TIME_LIMIT_EXCEEDED");
        assertThatThrownBy(() -> RunExecutionReceipt.parse(
            "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=STARTUP_TIMED_OUT\n"
                + "firstReadyAt=2026-09-21T10:05:00Z\nexpiresAt=2026-09-21T12:05:00Z\nreason=STARTUP_TIME_LIMIT_EXCEEDED\n"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThat(RunExecutionReceipt.parse(
            "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=STARTUP_TIMED_OUT\nreason=STARTUP_TIME_LIMIT_EXCEEDED\n")
            .state()).isEqualTo("STARTUP_TIMED_OUT");
    }

    @Test
    void exitedReceiptMayOrMayNotCarryTheLifetime() {
        assertThat(RunExecutionReceipt.parse(
            "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=EXITED\nreason=USER_STOPPED\n").state())
            .isEqualTo("EXITED");
        assertThat(RunExecutionReceipt.parse(
            "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=EXITED\n"
                + "firstReadyAt=2026-09-21T10:05:00Z\nexpiresAt=2026-09-21T12:05:00Z\nreason=APPLICATION_EXITED\n")
            .reason()).isEqualTo("APPLICATION_EXITED");
    }

    @Test
    void deniedReceiptParsesWithoutLifetime() {
        var parsed = RunExecutionReceipt.parse(
            "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=DENIED\nreason=RUN_ALREADY_CLAIMED\n");
        assertThat(parsed.state()).isEqualTo("DENIED");
        assertThat(parsed.firstReadyAt()).isNull();
    }

    @Test
    void rejectsUnknownProtocolFieldsStatesAndDuplicates() {
        assertThatThrownBy(() -> RunExecutionReceipt.parse("protocol=2\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=READY\n"
            + "firstReadyAt=2026-09-21T10:05:00Z\nexpiresAt=2026-09-21T12:05:00Z\nreason=\n"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> RunExecutionReceipt.parse(
            "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\ncommand=rm -rf /\nstate=READY\n"
                + "firstReadyAt=2026-09-21T10:05:00Z\nexpiresAt=2026-09-21T12:05:00Z\nreason=\n"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> RunExecutionReceipt.parse(
            "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=STOPPED\nreason=\n"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> RunExecutionReceipt.parse(
            "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=READY\nstate=READY\nreason=\n"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> RunExecutionReceipt.parse(
            "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=READY\n"
                + "firstReadyAt=not-a-time\nexpiresAt=2026-09-21T12:05:00Z\nreason=\n"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> RunExecutionReceipt.parse(
            "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=READY\n"
                + "firstReadyAt=2026-09-21T10:05:00Z\nreason=\n"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> RunExecutionReceipt.parse(
            "protocol=1\nprojectId=p1\nrunId=r1\npodUid=\nstate=READY\n"
                + "firstReadyAt=2026-09-21T10:05:00Z\nexpiresAt=2026-09-21T12:05:00Z\nreason=\n"))
            .isInstanceOf(IllegalArgumentException.class);
    }
}
