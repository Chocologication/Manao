package com.manao.poc2.run;

import com.manao.poc2.Poc2Properties;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.client.KubernetesClientException;
import java.util.Locale;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class KubernetesStreamingCodeRunner implements StreamingCodeRunner {

    private final KubernetesRunClient runClient;
    private final Poc2Properties properties;
    private final KubernetesRunResourceFactory resourceFactory;
    private final PodLogStreamer logStreamer;

    public KubernetesStreamingCodeRunner(
        KubernetesRunClient runClient,
        Poc2Properties properties,
        KubernetesRunResourceFactory resourceFactory,
        PodLogStreamer logStreamer
    ) {
        this.runClient = runClient;
        this.properties = properties;
        this.resourceFactory = resourceFactory;
        this.logStreamer = logStreamer;
    }

    @Override
    public void stream(String code, RunEventSink sink) {
        stream(newRunName(), code, sink);
    }

    void stream(String runName, String code, RunEventSink sink) {
        String namespace = properties.namespace();

        try {
            runClient.createConfigMap(resourceFactory.createConfigMap(runName, namespace, code));
            runClient.createJob(resourceFactory.createJob(runName, namespace, properties.image()));
            sink.send(RunEvent.status(runName, "job-created"));

            String podName = runClient.findJobPodName(namespace, runName, properties.timeout());
            sink.send(RunEvent.status(runName, "pod-found"));

            runClient.waitForPodRunning(namespace, podName, properties.timeout());
            logStreamer.streamLogs(namespace, podName, runName, sink);
            Job completedJob = runClient.waitForJob(namespace, runName, properties.timeout());
            sink.send(RunEvent.exit(runName, isJobSucceeded(completedJob) ? 0 : 1));
        } catch (KubernetesClientException | RunFailedException e) {
            sink.send(RunEvent.error(runName, e.getMessage()));
            throw e;
        } finally {
            if (properties.cleanup()) {
                runClient.deleteJob(namespace, runName);
                runClient.deleteConfigMap(namespace, resourceFactory.configMapName(runName));
            }
        }
    }

    private boolean isJobSucceeded(Job job) {
        Integer succeeded = job.getStatus() == null ? null : job.getStatus().getSucceeded();
        return succeeded != null && succeeded > 0;
    }

    private String newRunName() {
        return "java-run-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12).toLowerCase(Locale.ROOT);
    }
}
