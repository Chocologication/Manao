package com.manao.poc4.log;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Persistence-first log pipeline: every chunk is stored (and evicted rows removed) before any
 * live listener is notified. Windows are rebuilt from persisted chunks on first access so a
 * backend restart does not resurrect evicted bytes.
 */
public class RunLogService {
    private final Map<String, RunLogWindow> windows = new ConcurrentHashMap<>();
    private final Map<String, List<LogListener>> listeners = new ConcurrentHashMap<>();
    private final ChunkStore store;
    private final Clock clock;

    public interface ChunkStore {
        void insertChunk(String runId, RunLogWindow.Chunk chunk);

        List<RunLogWindow.Chunk> loadChunks(String runId);

        void deleteBefore(String runId, long seqExclusive);

        /** Highest seq ever persisted for the run, even when every chunk was evicted. */
        java.util.OptionalLong lastSeq(String runId);
    }

    public interface LogListener {
        void onAppend(RunLogWindow.Chunk chunk, RunLogWindow.WindowMeta meta);
    }

    public RunLogService(ChunkStore store) {
        this(store, Clock.systemUTC());
    }

    RunLogService(ChunkStore store, Clock clock) {
        this.store = store;
        this.clock = clock;
    }

    /** Returns the per-Run window, seeded from persisted chunks on first access. */
    public RunLogWindow windowFor(String runId) {
        return windows.computeIfAbsent(runId, id -> {
            RunLogWindow window = new RunLogWindow();
            window.seed(store.loadChunks(id), store.lastSeq(id).orElse(0));
            return window;
        });
    }

    /**
     * Appends and persists one chunk, then notifies listeners. Returns false when the seq is not
     * the next one (duplicate or out-of-order), which callers must treat as already-delivered.
     */
    public boolean publish(String runId, long seq, String text) {
        RunLogWindow window = windowFor(runId);
        if (!window.canAppend(seq)) {
            return false; // duplicate or out-of-order: already delivered or protocol error upstream
        }
        byte[] bytes = text.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (bytes.length > RunLogWindow.MAX_CHUNK_BYTES) {
            return false;
        }
        RunLogWindow.Chunk chunk = new RunLogWindow.Chunk(seq, text, bytes.length, clock.instant());
        // Persistence first: a storage failure must never advance the in-memory window.
        store.insertChunk(runId, chunk);
        RunLogWindow.AppendResult result = window.appendValidated(chunk);
        RunLogWindow.WindowMeta meta = window.meta();
        if (meta.firstAvailableSeq() != null) {
            store.deleteBefore(runId, meta.firstAvailableSeq());
        }
        for (LogListener listener : listeners.getOrDefault(runId, List.of())) {
            listener.onAppend(result.chunk(), meta);
        }
        return true;
    }

    public void addListener(String runId, LogListener listener) {
        listeners.computeIfAbsent(runId, id -> new CopyOnWriteArrayList<>()).add(listener);
    }

    public void removeListener(String runId, LogListener listener) {
        List<LogListener> runListeners = listeners.get(runId);
        if (runListeners != null) runListeners.remove(listener);
    }

    public void forgetRun(String runId) {
        windows.remove(runId);
        listeners.remove(runId);
    }

    /** Clock hook for deterministic tests and ISO timestamps in frames. */
    java.time.Instant now() {
        return clock.instant();
    }
}
