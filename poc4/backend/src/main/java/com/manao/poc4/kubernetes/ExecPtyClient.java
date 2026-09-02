package com.manao.poc4.kubernetes;

import com.manao.poc4.terminal.PtyBridge;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Fabric8-backed PTY bridge: an independent {@code pods/exec} into the run's fixed application
 * container executing the fixed root-owned wrapper. Binary bytes are bridged 1:1; the exec is
 * closed and never reattached once the session ends.
 */
public final class ExecPtyClient implements PtyBridge {
    private final ExecTransport transport;
    private final List<String> command;
    private final ExecutorService pumpExecutor = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "manao-pty-pump");
        thread.setDaemon(true);
        return thread;
    });

    public ExecPtyClient(ExecTransport transport, List<String> command) {
        this.transport = transport;
        this.command = List.copyOf(command);
    }

    @Override
    public PtyHandle open(String podName, String containerName, int cols, int rows, PtyListener listener) {
        ExecTransport.ExecProcess process = transport.exec(podName, containerName, command, cols, rows, true);
        AtomicBoolean closed = new AtomicBoolean(false);
        pumpExecutor.submit(() -> pump(process, listener, closed));
        return new PtyHandle() {
            @Override public boolean write(byte[] bytes) {
                if (closed.get()) return false;
                try {
                    process.stdin().write(bytes);
                    process.stdin().flush();
                    return true;
                } catch (IOException ex) {
                    return false;
                }
            }

            @Override public void resize(int newCols, int newRows) {
                process.resize(newCols, newRows);
            }

            @Override public void close() {
                if (closed.compareAndSet(false, true)) {
                    process.close();
                }
            }
        };
    }

    private void pump(ExecTransport.ExecProcess process, PtyListener listener, AtomicBoolean closed) {
        try (InputStream stdout = process.stdout()) {
            byte[] buffer = new byte[8192];
            int read;
            while (!closed.get() && (read = stdout.read(buffer)) != -1) {
                if (read > 0) {
                    listener.onOutput(java.util.Arrays.copyOfRange(buffer, 0, read));
                }
            }
        } catch (IOException ignored) {
            // The exec stream ended; fall through to exit reporting.
        } finally {
            closed.set(true);
            listener.onExit(process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS));
        }
    }
}
