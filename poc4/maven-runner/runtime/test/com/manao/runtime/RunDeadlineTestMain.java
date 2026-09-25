package com.manao.runtime;

import java.time.Duration;
import java.time.Instant;

/**
 * Pure-rule test for {@link RunDeadline} (Task 5). No framework, JDK standard library
 * only, so it can run both on the host and inside the runtime-test image stage.
 * Exits non-zero (uncaught AssertionError) on any violated rule.
 */
public final class RunDeadlineTestMain {

    private RunDeadlineTestMain() {
    }

    public static void main(String[] args) {
        var deadline = new RunDeadline();
        var first = Instant.parse("2026-09-21T10:05:00Z");
        deadline.ready(first, 1000L, Duration.ofSeconds(7200));
        deadline.ready(first.plusSeconds(60), 2000L, Duration.ofSeconds(7200));
        if (!deadline.expiresAt().equals(first.plusSeconds(7200))) throw new AssertionError("renewed");
        if (deadline.expired(1000L + Duration.ofSeconds(7199).toNanos())) throw new AssertionError("early");
        if (!deadline.expired(1000L + Duration.ofSeconds(7200).toNanos())) throw new AssertionError("late");
        System.out.println("run-deadline rules ok");
    }
}
