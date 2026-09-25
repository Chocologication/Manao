package com.manao.poc4.log;

import java.util.function.Consumer;

/**
 * Raw pod log streaming boundary; implementations deliver lines as they appear. The container is
 * explicit so a watch can only ever follow the verified application container, never an init or
 * replacement container.
 */
public interface PodLogGateway {
    LogWatchHandle watchLogs(String namespace, String podName, String container, Consumer<String> lineConsumer);

    interface LogWatchHandle {
        void close();

        /** False once the underlying stream ended (transport loss or pod exit); callers use it
         * to mark a log gap and re-attach to the same source instead of losing lines silently. */
        boolean isAlive();
    }
}
