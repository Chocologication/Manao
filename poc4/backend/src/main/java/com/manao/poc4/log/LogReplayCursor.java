package com.manao.poc4.log;

/**
 * Connection-level replay planning and seq de-duplication. When the client cursor sits before the
 * window start, the replay resumes at firstAvailableSeq and reports the single gap marker; the
 * client derives the visible LOG_GAP indicator from that marker plus the window metadata.
 */
public final class LogReplayCursor {
    private long highWater;

    public record ReplayPlan(Long startSeq, boolean gap) { }

    public static ReplayPlan plan(Long clientLastSeq, RunLogWindow.WindowMeta meta) {
        if (meta.firstAvailableSeq() == null) {
            return new ReplayPlan(null, false);
        }
        if (clientLastSeq == null) {
            return new ReplayPlan(meta.firstAvailableSeq(), false);
        }
        if (clientLastSeq < meta.firstAvailableSeq() - 1) {
            return new ReplayPlan(meta.firstAvailableSeq(), true);
        }
        if (clientLastSeq >= meta.lastAvailableSeq()) {
            return new ReplayPlan(null, false);
        }
        return new ReplayPlan(clientLastSeq + 1, false);
    }

    public static LogReplayCursor forConnection() {
        return new LogReplayCursor();
    }

    /** Accepts only strictly increasing seqs; overlaps and regressions are dropped. */
    public boolean accept(long seq) {
        if (seq <= highWater) return false;
        highWater = seq;
        return true;
    }
}
