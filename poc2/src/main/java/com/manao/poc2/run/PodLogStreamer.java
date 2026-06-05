package com.manao.poc2.run;

public interface PodLogStreamer {

    void streamLogs(String namespace, String podName, String jobName, RunEventSink sink);
}
