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
            List<RunLogWindow.Chunk> persisted = store.loadChunks(id);
            long lastSeq = 0;
            for (RunLogWindow.Chunk chunk : persisted) {
                window.append(chunk.seq(), chunk.text());
                lastSeq = chunk.seq();
            }
            return window;
        });
    }

    /**
     * Appends and persists one chunk, then notifies listeners. Returns false when the seq is not
     * the next one (duplicate or out-of-order), which callers must treat as already-delivered.
     */
    public boolean publish(String runId, long seq, String text) {
        RunLogWindow window = windowFor(runId);
        RunLogWindow.AppendResult result;
        try {
            result = window.append(seq, text);
        } catch (IllegalArgumentException ex) {
            return false;
        }
        store.insertChunk(runId, result.chunk());
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

    /** Clock hook for deterministic tests and ISO timestamps in frames. */
    java.time.Instant now() {
        return clock.instant();
    }
}
