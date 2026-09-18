package com.manao.poc4.terminal;

import java.time.Clock;
import java.time.Duration;

/**
 * Server-side terminal flow control: 32 KiB output frames, 256 KiB initial output credit,
 * 16 KiB input frames, a 64 KiB input queue that pauses reading for at most 5 seconds before
 * failing closed, and monotonic resize generations.
 */
public final class TerminalFlowController {
    public static final int MAX_OUTPUT_FRAME_BYTES = 32 * 1024;
    public static final int MAX_INPUT_FRAME_BYTES = 16 * 1024;
    public static final int INITIAL_CREDIT_BYTES = 256 * 1024;
    public static final int MAX_INPUT_QUEUE_BYTES = 64 * 1024;
    private static final Duration QUEUE_OVERFLOW_GRACE = Duration.ofSeconds(5);
    private static final int MAX_COLS = 500;
    private static final int MAX_ROWS = 200;

    public enum AckResult { ACCEPTED, IGNORED, VIOLATION }

    private final Clock clock;
    private int credit = INITIAL_CREDIT_BYTES;
    private int outstanding;
    private int queuedBytes;
    private long resizeGeneration;
    private int cols;
    private int rows;
    private java.time.Instant overflowDeadline;

    public TerminalFlowController() {
        this(Clock.systemUTC());
    }

    public TerminalFlowController(Clock clock) {
        this.clock = clock;
    }

    public Clock clock() { return clock; }

    public int creditAvailable() { return credit; }

    public int outstanding() { return outstanding; }

    public int queuedBytes() { return queuedBytes; }

    public int cols() { return cols; }

    public int rows() { return rows; }

    public boolean canSend(int bytes) {
        return bytes > 0 && bytes <= MAX_OUTPUT_FRAME_BYTES && bytes <= credit;
    }

    public void sent(int bytes) {
        credit -= bytes;
        outstanding += bytes;
    }

    public boolean grantCredit(int bytes) {
        if (bytes <= 0 || credit + bytes > INITIAL_CREDIT_BYTES) return false;
        credit += bytes;
        return true;
    }

    public AckResult ack(int bytes) {
        if (bytes <= 0 || bytes > outstanding) return AckResult.VIOLATION;
        outstanding -= bytes;
        credit += bytes;
        return AckResult.ACCEPTED;
    }

    public boolean canQueueInput(int bytes) {
        return bytes > 0 && bytes <= MAX_INPUT_FRAME_BYTES && queuedBytes + bytes <= MAX_INPUT_QUEUE_BYTES;
    }

    public void queueInput(int bytes) {
        queuedBytes += bytes;
        if (queuedBytes >= MAX_INPUT_QUEUE_BYTES && overflowDeadline == null) {
            overflowDeadline = clock.instant().plus(QUEUE_OVERFLOW_GRACE);
        }
    }

    public void consumeInput(int bytes) {
        queuedBytes = Math.max(0, queuedBytes - bytes);
        if (queuedBytes < MAX_INPUT_QUEUE_BYTES) overflowDeadline = null;
    }

    public boolean shouldPauseReading() {
        return queuedBytes >= MAX_INPUT_QUEUE_BYTES;
    }

    public boolean queueOverflowDeadlineExceeded() {
        return overflowDeadline != null && !clock.instant().isBefore(overflowDeadline);
    }

    public boolean acceptResize(long generation, int newCols, int newRows) {
        validateDimension(newCols, 1, MAX_COLS, "cols");
        validateDimension(newRows, 1, MAX_ROWS, "rows");
        if (generation <= resizeGeneration) return false;
        resizeGeneration = generation;
        cols = newCols;
        rows = newRows;
        return true;
    }

    private static void validateDimension(int value, int min, int max, String name) {
        if (value < min || value > max) throw new IllegalArgumentException(name + " out of range");
    }
}
