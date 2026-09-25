package com.manao.runtime;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;

/**
 * Monotonic single-run lifetime deadline.
 *
 * <p>The first {@link #ready} call fixes the expiry; later calls are ignored, so a
 * repeated readiness observation can never renew or extend the lifetime. Actual expiry
 * checks ({@link #expired}) use caller-supplied monotonic nanos only; the UTC instant
 * exists for receipts and display.</p>
 */
public final class RunDeadline {

    private boolean armed;
    private long deadlineNanos;
    private Instant expiresAtUtc;

    /**
     * Arms the deadline on first readiness. Repeated calls do not renew: the first
     * readiness fixes both the monotonic deadline and the UTC expiry.
     *
     * @param utcNow   wall-clock moment of the first readiness (receipts/display only)
     * @param nowNanos monotonic nanos taken at the same moment (System.nanoTime origin)
     * @param lifetime service lifetime measured from readiness; must be positive
     */
    public synchronized void ready(Instant utcNow, long nowNanos, Duration lifetime) {
        if (armed) {
            return;
        }
        Objects.requireNonNull(utcNow, "utcNow");
        Objects.requireNonNull(lifetime, "lifetime");
        if (lifetime.isNegative() || lifetime.isZero()) {
            throw new IllegalArgumentException("lifetime must be positive: " + lifetime);
        }
        armed = true;
        this.deadlineNanos = nowNanos + lifetime.toNanos();
        this.expiresAtUtc = utcNow.plus(lifetime);
    }

    /** True once armed and the monotonic deadline has been reached. Never armed means never expired. */
    public synchronized boolean expired(long nowNanos) {
        return armed && nowNanos >= deadlineNanos;
    }

    /** The fixed UTC expiry, or {@code null} while not armed. */
    public synchronized Instant expiresAt() {
        return expiresAtUtc;
    }

    /** True once the deadline has been armed by a first readiness. */
    public synchronized boolean armed() {
        return armed;
    }

    /** The monotonic deadline in nanos; meaningful only while {@link #armed()}. */
    public synchronized long monotonicDeadlineNanos() {
        return deadlineNanos;
    }
}
