package com.manao.poc2.run;

import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.dsl.LogWatch;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import org.springframework.stereotype.Component;

@Component
public class Fabric8PodLogStreamer implements PodLogStreamer {

    private final KubernetesClient client;
    private final LogLineEmitter lineEmitter;

    public Fabric8PodLogStreamer(KubernetesClient client, LogLineEmitter lineEmitter) {
        this.client = client;
        this.lineEmitter = lineEmitter;
    }

    @Override
    public void streamLogs(String namespace, String podName, String jobName, RunEventSink sink) {
        try (LogWatch watch = client.pods().inNamespace(namespace).withName(podName).watchLog();
             BufferedReader reader = new BufferedReader(new InputStreamReader(watch.getOutput(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                lineEmitter.emitLines(jobName, line, sink);
            }
        } catch (IOException e) {
            throw new RunFailedException("Failed to stream pod logs: " + podName, e);
        }
    }
}
