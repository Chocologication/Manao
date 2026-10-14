package com.manao.poc4.ai;

/**
 * A progress submission skipped ahead of the durable sequence: the answer names the
 * seq the backend expects next, so the sender can replay its buffered range. The
 * internal controller turns this into the 409 body {@code {code, expectedSeq}}.
 */
public final class ProgressGapException extends RuntimeException {
    private final long expectedSeq;

    public ProgressGapException(long expectedSeq) {
        super("AI_PROGRESS_GAP", null, false, false);
        this.expectedSeq = expectedSeq;
    }

    public long expectedSeq() {
        return expectedSeq;
    }
}
