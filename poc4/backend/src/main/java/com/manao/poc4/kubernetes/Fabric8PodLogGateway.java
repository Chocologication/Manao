package com.manao.poc4.kubernetes;

import com.manao.poc4.log.PodLogGateway;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.dsl.LogWatch;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Fabric8 watchLog-backed gateway; lines are pumped on a daemon thread. */
public final class Fabric8PodLogGateway implements PodLogGateway {
    private final KubernetesClient client;
    private final ExecutorService pumpExecutor = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "manao-log-pump");
        thread.setDaemon(true);
        return thread;
    });

    public Fabric8PodLogGateway(KubernetesClient client) {
        this.client = client;
    }

    @Override
    public LogWatchHandle watchLogs(String namespace, String podName, java.util.function.Consumer<String> lineConsumer) {
        LogWatch watch = client.pods().inNamespace(namespace).withName(podName).watchLog();
        pumpExecutor.submit(() -> {
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(watch.getOutput(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    lineConsumer.accept(line);
                }
            } catch (java.io.IOException ignored) {
                // Stream closed; the lifecycle owner re-attaches on the next scan if needed.
            }
        });
        return watch::close;
    }
}
