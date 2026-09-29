package com.manao.poc4.log;

import com.manao.poc4.kubernetes.ResourceIdentityVerifier;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Attaches one persistence-first log watch per RUNNING run, bound to the claimed execution Pod
 * UID. Lines map 1:1 to seqs; a same-source re-attach skips the already-ingested prefix so seq
 * continuity is never broken. A different Pod (e.g. a replacement that was denied the claim) is
 * never adopted as the source, and history is never cleared to make a new source look complete.
 *
 * <p>When a watch's stream ends while the run is still live, the loss is marked explicitly with
 * a persisted system line (the missing lines are unrecoverable from that pod), and the same
 * source is re-attached on the spot. A reconnect that keeps failing marks the gap once and
 * retries quietly on every scan; a loss after a successful reconnect is a new gap and is marked
 * again.</p>
 *
 * <p>When a run settles, {@link #backfillHistoryBeforeFinish} replays the pod's full non-follow
 * history through the same ingest path, so a run that terminated before its first observation
 * still gets its log persisted.</p>
 */
public final class RunLogIngestor {
    private static final Logger LOG = LoggerFactory.getLogger(RunLogIngestor.class);
    static final String GAP_MARKER_PREFIX = "[manao] log source lost";

    private final PodLogGateway gateway;
    private final RunLogService logs;
    private final Map<String, Handle> watches = new ConcurrentHashMap<>();

    private static final class Handle {
        PodLogGateway.LogWatchHandle watch;
        long nextSeq;
        /** Already-persisted chunks; re-attach skips chunk-by-chunk, never line-by-line. */
        long skipChunks;
        /**
         * Chunks that came from the pod source itself (gap markers excluded). The reconnect
         * replay skips exactly this many chunks: the re-attached stream never contains markers,
         * so counting them here would silently drop one application line per loss event.
         */
        long sourceChunks;
        /** The claimed Pod UID this source is bound to; identity, not just a name. */
        String podUid;
        String podName;
        /** Set once per loss event so a failing reconnect never spams duplicate markers. */
        boolean gapMarked;
    }

    private final String namespace;

    public RunLogIngestor(PodLogGateway gateway, RunLogService logs, String namespace) {
        this.gateway = gateway;
        this.logs = logs;
        this.namespace = namespace;
    }

    /**
     * Idempotently attaches the log watch for a run to the claimed pod; the stream is tailed from
     * the start. Once a source is bound, no other pod can silently replace it; a lost watch is
     * marked and re-attached to the same source instead.
     */
    public synchronized void ensureWatch(String runId, String podName, String podUid) {
        Handle existing = watches.get(runId);
        if (existing != null) {
            if (existing.watch.isAlive()) {
                return; // the bound source is still live
            }
            reconnectLostSource(runId, existing);
            return;
        }
        if (podName == null || podName.isBlank() || podUid == null || podUid.isBlank()) {
            return;
        }
        watches.put(runId, attach(runId, podName, podUid, logs.windowFor(runId).lastSeq()));
    }

    /** Marks the unrecoverable gap once, then re-attaches the same claimed source. */
    private void reconnectLostSource(String runId, Handle existing) {
        if (!existing.gapMarked) {
            String marker = GAP_MARKER_PREFIX + " at " + logs.now()
                + ": lines emitted while the source was unavailable are missing from this history.";
            if (logs.publish(runId, existing.nextSeq, marker + "\n")) {
                existing.nextSeq++;
                // Only a persisted marker counts as marked; a refused one is retried next scan.
                existing.gapMarked = true;
            }
        }
        try {
            // The replay skips exactly the pod-source chunks: the re-attached stream does not
            // contain the marker, so the marker seq must not enter the skip count.
            Handle reattached = attach(runId, existing.podName, existing.podUid, existing.sourceChunks);
            watches.put(runId, reattached);
        } catch (RuntimeException ex) {
            // Retry on the next scan; the gap marker is not repeated for the same loss event.
            LOG.warn("log source re-attach failed; the next scan retries: runId={}", runId, ex);
        }
    }

    /** Builds a fresh handle bound to the claimed pod; tails from the start and skips the given
     * number of already-persisted pod-source chunks. */
    private Handle attach(String runId, String podName, String podUid, long sourceChunksToSkip) {
        long lastSeq = logs.windowFor(runId).lastSeq();
        Handle handle = new Handle();
        handle.nextSeq = lastSeq + 1;
        handle.skipChunks = sourceChunksToSkip;
        handle.sourceChunks = sourceChunksToSkip;
        handle.podUid = podUid;
        handle.podName = podName;
        handle.watch = gateway.watchLogs(this.namespace, podName, ResourceIdentityVerifier.APPLICATION_CONTAINER,
            line -> ingest(runId, handle, line));
        return handle;
    }

    /** Outcome of one terminal history backfill attempt. */
    public enum TerminalBackfill { COMPLETED, DEFERRED, GAPPED }

    /** Read attempts one run may consume before its terminal backfill reports a gap instead. */
    private static final int BACKFILL_ATTEMPT_BUDGET = 3;

    /** Skip cursor and attempt count of the terminal backfill; kept across deferred attempts. */
    private record TerminalBackfillState(long skipChunks, int attempts) { }

    private final Map<String, TerminalBackfillState> terminalBackfills = new ConcurrentHashMap<>();

    /**
     * Backfills the pod's full non-follow log history through the SAME ingest path the watch
     * uses, right before a terminal run settles. Any bound watch is closed and drained first so
     * the skip cursor is quiescent, and its persisted chunk count is carried over: a partial
     * watch is never duplicated and a never-attached run gets the full history. Blank identity
     * settles with today's semantics; a bound watch with a different pod uid is never replaced
     * by a second source. A failed read defers settlement to the next scan; after the attempt
     * budget one best-effort gap marker is published and the caller settles anyway.
     */
    public synchronized TerminalBackfill backfillHistoryBeforeFinish(String runId, String podName, String podUid) {
        if (podName == null || podName.isBlank() || podUid == null || podUid.isBlank()) {
            return TerminalBackfill.COMPLETED; // no verifiable identity; settlement proceeds unchanged
        }
        Handle bound = watches.get(runId);
        if (bound != null && !podUid.equals(bound.podUid)) {
            LOG.warn("terminal log backfill refused: a different pod uid is bound for the run: runId={}", runId);
            return TerminalBackfill.COMPLETED;
        }
        // Quiesce first: close + drain, so the pump thread is done and nothing races the cursor.
        detach(runId);
        TerminalBackfillState state = terminalBackfills.computeIfAbsent(runId,
            id -> new TerminalBackfillState(bound == null ? 0 : bound.sourceChunks, 0));
        // The cursor is deliberately NOT registered in watches: after terminal facts the watch
        // can never re-attach, so the backfill is the run's last log source.
        Handle cursor = new Handle();
        cursor.nextSeq = logs.windowFor(runId).lastSeq() + 1;
        cursor.skipChunks = state.skipChunks();
        cursor.sourceChunks = state.skipChunks();
        cursor.podUid = podUid;
        cursor.podName = podName;
        try {
            gateway.readLogs(namespace, podName, ResourceIdentityVerifier.APPLICATION_CONTAINER,
                line -> ingest(runId, cursor, line));
            // The advanced skip cursor is kept so a repeat backfill for the same run can never
            // re-publish the history it already persisted.
            terminalBackfills.put(runId, new TerminalBackfillState(cursor.sourceChunks, state.attempts()));
            return TerminalBackfill.COMPLETED;
        } catch (RuntimeException ex) {
            int attempts = state.attempts() + 1;
            if (attempts < BACKFILL_ATTEMPT_BUDGET) {
                // cursor.sourceChunks is the advanced total (original skip + chunks persisted
                // this attempt), so a partial read is never re-published from its start.
                terminalBackfills.put(runId, new TerminalBackfillState(cursor.sourceChunks, attempts));
                LOG.warn("terminal log backfill failed; settlement is deferred to the next scan: runId={}", runId, ex);
                return TerminalBackfill.DEFERRED;
            }
            terminalBackfills.remove(runId);
            String marker = GAP_MARKER_PREFIX + " at " + logs.now()
                + ": the terminal history backfill failed after " + BACKFILL_ATTEMPT_BUDGET
                + " attempts; the remaining lines are missing from this history.";
            logs.publish(runId, cursor.nextSeq, marker + "\n"); // best effort
            return TerminalBackfill.GAPPED;
        }
    }

    public synchronized void detach(String runId) {
        Handle handle = watches.remove(runId);
        if (handle != null && handle.watch != null) handle.watch.close();
    }

    /**
     * Closes the live watch and waits for the pump to deliver any already-buffered lines so the
     * last persisted seq is known before {@code log.complete} is published.
     */
    public synchronized void finish(String runId) {
        detach(runId);
    }

    /** Backend shutdown: every watch is closed; old sessions are never resumed. */
    public synchronized void detachAll() {
        for (String runId : watches.keySet().toArray(new String[0])) {
            detach(runId);
        }
    }

    private void ingest(String runId, Handle handle, String line) {
        java.util.List<String> pieces = Utf8ChunkSplitter.split(line + "\n", RunLogWindow.MAX_CHUNK_BYTES);
        if (handle.skipChunks > 0) {
            if (pieces.size() <= handle.skipChunks) {
                handle.skipChunks -= pieces.size();
                return;
            }
            pieces = pieces.subList((int) handle.skipChunks, pieces.size());
            handle.skipChunks = 0;
        }
        long seq = handle.nextSeq;
        for (String piece : pieces) {
            if (!logs.publish(runId, seq, piece)) {
                return; // storage refused; do not advance the seq cursor
            }
            seq++;
            handle.sourceChunks++;
        }
        handle.nextSeq = seq;
    }
}
