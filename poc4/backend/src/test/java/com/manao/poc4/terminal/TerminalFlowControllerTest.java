package com.manao.poc4.terminal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class TerminalFlowControllerTest {
    @Test
    void initialCreditIs256KiBAndOutputFramesNeverExceed32KiB() {
        TerminalFlowController controller = new TerminalFlowController();
        assertThat(controller.creditAvailable()).isEqualTo(TerminalFlowController.INITIAL_CREDIT_BYTES);
        assertThat(controller.canSend(32 * 1024)).isTrue();
        assertThat(controller.canSend(32 * 1024 + 1)).isFalse();
        controller.sent(32 * 1024);
        assertThat(controller.creditAvailable()).isEqualTo(TerminalFlowController.INITIAL_CREDIT_BYTES - 32 * 1024);
        assertThat(controller.outstanding()).isEqualTo(32 * 1024);
    }

    @Test
    void ackReturnsCreditAndIgnoresDuplicatesAndRegressions() {
        TerminalFlowController controller = new TerminalFlowController();
        controller.sent(1024);
        assertThat(controller.ack(512)).isEqualTo(TerminalFlowController.AckResult.ACCEPTED);
        assertThat(controller.ack(512)).isEqualTo(TerminalFlowController.AckResult.ACCEPTED);
        assertThat(controller.outstanding()).isZero();
        // Acknowledging more than outstanding violates the flow contract and must fail closed.
        controller.sent(1024);
        assertThat(controller.ack(2048)).isEqualTo(TerminalFlowController.AckResult.VIOLATION);
    }

    @Test
    void creditGrantsAreCappedAt256KiB() {
        TerminalFlowController controller = new TerminalFlowController();
        controller.sent(64 * 1024);
        assertThat(controller.grantCredit(64 * 1024)).isTrue();
        assertThat(controller.grantCredit(TerminalFlowController.INITIAL_CREDIT_BYTES)).isFalse();
        assertThat(controller.creditAvailable()).isEqualTo(TerminalFlowController.INITIAL_CREDIT_BYTES);
    }

    @Test
    void inputFramesAndQueueAreBounded() {
        TerminalFlowController controller = new TerminalFlowController();
        assertThat(controller.canQueueInput(16 * 1024)).isTrue();
        assertThat(controller.canQueueInput(16 * 1024 + 1)).isFalse();
        for (int i = 0; i < 4; i++) {
            assertThat(controller.canQueueInput(16 * 1024)).isTrue();
            controller.queueInput(16 * 1024);
        }
        assertThat(controller.queuedBytes()).isEqualTo(64 * 1024);
        // The queue is full: reading pauses and further input is refused.
        assertThat(controller.canQueueInput(1)).isFalse();
        assertThat(controller.shouldPauseReading()).isTrue();
        controller.consumeInput(32 * 1024);
        assertThat(controller.shouldPauseReading()).isFalse();
    }

    @Test
    void pauseHeldForFiveSecondsFailsClosed() {
        TerminalFlowController controller = new TerminalFlowController(new MutableClock());
        controller.queueInput(64 * 1024);
        assertThat(controller.shouldPauseReading()).isTrue();
        ((MutableClock) controller.clock()).advance(java.time.Duration.ofSeconds(4));
        assertThat(controller.queueOverflowDeadlineExceeded()).isFalse();
        ((MutableClock) controller.clock()).advance(java.time.Duration.ofSeconds(2));
        assertThat(controller.queueOverflowDeadlineExceeded()).isTrue();
    }

    static final class MutableClock extends java.time.Clock {
        private java.time.Instant instant = java.time.Instant.parse("2026-08-29T12:00:00Z");
        void advance(java.time.Duration duration) { instant = instant.plus(duration); }
        @Override public java.time.ZoneOffset getZone() { return java.time.ZoneOffset.UTC; }
        @Override public java.time.Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public java.time.Instant instant() { return instant; }
    }

    @Test
    void resizeGenerationsAreMonotonicAndOlderGenerationsAreIgnored() {
        TerminalFlowController controller = new TerminalFlowController();
        assertThat(controller.acceptResize(1, 80, 24)).isTrue();
        assertThat(controller.acceptResize(2, 100, 30)).isTrue();
        assertThat(controller.acceptResize(2, 100, 30)).isFalse();
        assertThat(controller.acceptResize(1, 50, 20)).isFalse();
        assertThatThrownBy(() -> controller.acceptResize(3, 0, 24)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> controller.acceptResize(3, 501, 24)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> controller.acceptResize(3, 80, 201)).isInstanceOf(IllegalArgumentException.class);
    }
}
