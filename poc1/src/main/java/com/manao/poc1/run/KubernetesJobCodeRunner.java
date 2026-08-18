package com.manao.poc1.run;

import com.manao.poc1.Poc1Properties;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PodList;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientException;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Service;

@Service
public class KubernetesJobCodeRunner implements CodeRunner {

    private final KubernetesClient client;
    private final Poc1Properties properties;
    private final KubernetesRunResourceFactory resourceFactory;

    public KubernetesJobCodeRunner(
        KubernetesClient client,
        Poc1Properties properties,
        KubernetesRunResourceFactory resourceFactory
    ) {
        this.client = client;
        this.properties = properties;
        this.resourceFactory = resourceFactory;
    }

    @Override
    public RunResult run(String code) {
        String runName = "java-run-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12).toLowerCase(Locale.ROOT);
        String namespace = properties.namespace();

        try {
            client.configMaps()
                .inNamespace(namespace)
                .resource(resourceFactory.createConfigMap(runName, namespace, code))
                .create();
            client.batch()
                .v1()
                .jobs()
                .inNamespace(namespace)
                .resource(resourceFactory.createJob(runName, namespace, properties.image()))
                .create();

            Job completedJob = waitForJob(runName, namespace, properties.timeout());
            Pod pod = findJobPod(runName, namespace);
            String logs = client.pods()
                .inNamespace(namespace)
                .withName(pod.getMetadata().getName())
                .getLog();
            int exitCode = isJobSucceeded(completedJob) ? 0 : 1;
            return new RunResult(logs == null ? "" : logs, "", exitCode, runName);
        } catch (KubernetesClientException e) {
            throw new RunFailedException("Kubernetes run failed: " + e.getMessage(), e);
        } finally {
            if (properties.cleanup()) {
                cleanup(runName, namespace);
            }
        }
    }

    private Job waitForJob(String runName, String namespace, Duration timeout) {
        long timeoutSeconds = Math.max(1, timeout.toSeconds());
        Job job = client.batch()
            .v1()
            .jobs()
            .inNamespace(namespace)
            .withName(runName)
            .waitUntilCondition(this::isJobFinished, timeoutSeconds, TimeUnit.SECONDS);

        if (job == null || !isJobFinished(job)) {
            throw new RunFailedException("Kubernetes job timed out: " + runName);
        }
        return job;
    }

    private boolean isJobFinished(Job job) {
        return isJobSucceeded(job) || hasFailed(job);
    }

    private boolean isJobSucceeded(Job job) {
        Integer succeeded = job.getStatus() == null ? null : job.getStatus().getSucceeded();
        return succeeded != null && succeeded > 0;
    }

    private boolean hasFailed(Job job) {
        Integer failed = job.getStatus() == null ? null : job.getStatus().getFailed();
        return failed != null && failed > 0;
    }

    private Pod findJobPod(String runName, String namespace) {
        PodList podList = client.pods()
            .inNamespace(namespace)
            .withLabel(KubernetesRunResourceFactory.RUN_ID_LABEL, runName)
            .list();
        List<Pod> pods = podList.getItems();
        if (pods.isEmpty()) {
            throw new RunFailedException("Kubernetes job pod not found: " + runName);
        }
        return pods.get(0);
    }

    private void cleanup(String runName, String namespace) {
        client.batch().v1().jobs().inNamespace(namespace).withName(runName).delete();
        client.configMaps().inNamespace(namespace).withName(resourceFactory.configMapName(runName)).delete();
    }
}
