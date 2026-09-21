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
        watches.put(runId, attach(runId, podName, podUid));
    }

    /** Marks the unrecoverable gap once, then re-attaches the same claimed source. */
    private void reconnectLostSource(String runId, Handle existing) {
        if (!existing.gapMarked) {
            String marker = GAP_MARKER_PREFIX + " at " + logs.now()
                + ": lines emitted while the source was unavailable are missing from this history.";
            if (logs.publish(runId, existing.nextSeq, marker + "\n")) {
                existing.nextSeq++;
            }
            existing.gapMarked = true;
        }
        try {
            Handle reattached = attach(runId, existing.podName, existing.podUid);
            watches.put(runId, reattached);
        } catch (RuntimeException ex) {
            // Retry on the next scan; the gap marker is not repeated for the same loss event.
            LOG.warn("log source re-attach failed; the next scan retries: runId={}", runId, ex);
        }
    }

    /** Builds a fresh handle bound to the claimed pod; tails from the start and skips persisted chunks. */
    private Handle attach(String runId, String podName, String podUid) {
        long lastSeq = logs.windowFor(runId).lastSeq();
        Handle handle = new Handle();
        handle.nextSeq = lastSeq + 1;
        handle.skipChunks = lastSeq;
        handle.podUid = podUid;
        handle.podName = podName;
        handle.watch = gateway.watchLogs(this.namespace, podName, ResourceIdentityVerifier.APPLICATION_CONTAINER,
            line -> ingest(runId, handle, line));
        return handle;
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
        }
        handle.nextSeq = seq;
    }
}
