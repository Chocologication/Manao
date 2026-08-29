package com.manao.poc4.log;

import java.util.function.Consumer;

/** Raw pod log streaming boundary; implementations deliver lines as they appear. */
public interface PodLogGateway {
    LogWatchHandle watchLogs(String namespace, String podName, Consumer<String> lineConsumer);

    interface LogWatchHandle {
        void close();
    }
}
