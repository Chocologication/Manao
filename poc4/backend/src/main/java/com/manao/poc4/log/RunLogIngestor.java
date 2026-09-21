package com.manao.poc4.log;

import com.manao.poc4.kubernetes.ResourceIdentityVerifier;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Attaches one persistence-first log watch per RUNNING run, bound to the claimed execution Pod
 * UID. Lines map 1:1 to seqs; a same-source re-attach skips the already-ingested prefix so seq
 * continuity is never broken. A different Pod (e.g. a replacement that was denied the claim) is
 * never adopted as the source, and history is never cleared to make a new source look complete.
 */
public final class RunLogIngestor {
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
    }

    private final String namespace;

    public RunLogIngestor(PodLogGateway gateway, RunLogService logs, String namespace) {
        this.gateway = gateway;
        this.logs = logs;
        this.namespace = namespace;
    }

    /**
     * Idempotently attaches the log watch for a run to the claimed pod; the stream is tailed from
     * the start. Once a source is bound, no other pod can silently replace it.
     */
    public synchronized void ensureWatch(String runId, String podName, String podUid) {
        if (watches.containsKey(runId) || podName == null || podName.isBlank()
            || podUid == null || podUid.isBlank()) {
            return;
        }
        long lastSeq = logs.windowFor(runId).lastSeq();
        Handle handle = new Handle();
        handle.nextSeq = lastSeq + 1;
        handle.skipChunks = lastSeq;
        handle.podUid = podUid;
        handle.watch = gateway.watchLogs(this.namespace, podName, ResourceIdentityVerifier.APPLICATION_CONTAINER,
            line -> ingest(runId, handle, line));
        watches.put(runId, handle);
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
