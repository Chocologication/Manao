package com.manao.poc4.terminal;

import java.util.List;

/** The only PTY transport boundary: a fixed root-owned wrapper executed inside the Job's pod. */
public interface PtyBridge {
    PtyHandle open(String podName, String containerName, int cols, int rows, PtyListener listener);

    interface PtyListener {
        void onOutput(byte[] bytes);

        void onExit(Integer exitCode);
    }

    interface PtyHandle {
        /** Writes bytes to the PTY stdin; false signals backpressure the caller must queue. */
        boolean write(byte[] bytes);

        void resize(int cols, int rows);

        void close();
    }
}
