package com.manao.poc4.log;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Attaches one persistence-first log watch per RUNNING run. Lines map 1:1 to seqs; on re-attach
 * the already-ingested prefix of the stream is skipped so seq continuity is never broken.
 */
public final class RunLogIngestor {
    private final PodLogGateway gateway;
    private final RunLogService logs;
    private final Map<String, Handle> watches = new ConcurrentHashMap<>();

    private static final class Handle {
        PodLogGateway.LogWatchHandle watch;
        long nextSeq;
        long skipLines;
    }

    private final String namespace;

    public RunLogIngestor(PodLogGateway gateway, RunLogService logs, String namespace) {
        this.gateway = gateway;
        this.logs = logs;
        this.namespace = namespace;
    }

    /** Idempotently attaches the log watch for a run; the stream is tailed from the start. */
    public synchronized void ensureWatch(String runId, String podName) {
        if (watches.containsKey(runId) || podName == null || podName.isBlank()) return;
        long lastSeq = logs.windowFor(runId).meta().lastAvailableSeq() == null
            ? 0 : logs.windowFor(runId).meta().lastAvailableSeq();
        Handle handle = new Handle();
        handle.nextSeq = lastSeq + 1;
        handle.skipLines = lastSeq;
        handle.watch = gateway.watchLogs(this.namespace, podName, line -> ingest(runId, handle, line));
        watches.put(runId, handle);
    }

    public synchronized void detach(String runId) {
        Handle handle = watches.remove(runId);
        if (handle != null && handle.watch != null) handle.watch.close();
    }

    /** Backend shutdown: every watch is closed; old sessions are never resumed. */
    public synchronized void detachAll() {
        for (String runId : watches.keySet().toArray(new String[0])) {
            detach(runId);
        }
    }

    private void ingest(String runId, Handle handle, String line) {
        if (handle.skipLines > 0) {
            handle.skipLines--;
            return;
        }
        long seq = handle.nextSeq;
        String text = line + "\n";
        // Split pathological over-long lines into <= 64 KiB chunks under one seq each.
        while (!text.isEmpty()) {
            String piece = text.length() > RunLogWindow.MAX_CHUNK_BYTES
                ? text.substring(0, RunLogWindow.MAX_CHUNK_BYTES) : text;
            text = text.length() > RunLogWindow.MAX_CHUNK_BYTES ? text.substring(RunLogWindow.MAX_CHUNK_BYTES) : "";
            if (!logs.publish(runId, seq, piece)) {
                return; // storage refused; do not advance the seq cursor
            }
            seq++;
        }
        handle.nextSeq = seq;
    }
}
