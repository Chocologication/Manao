package com.manao.poc2.run;

import io.fabric8.kubernetes.api.model.ConfigMap;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PodList;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.client.KubernetesClient;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Component;

@Component
public class Fabric8KubernetesRunClient implements KubernetesRunClient {

    private final KubernetesClient client;

    public Fabric8KubernetesRunClient(KubernetesClient client) {
        this.client = client;
    }

    @Override
    public void createConfigMap(ConfigMap configMap) {
        client.configMaps()
            .inNamespace(configMap.getMetadata().getNamespace())
            .resource(configMap)
            .create();
    }

    @Override
    public void createJob(Job job) {
        client.batch()
            .v1()
            .jobs()
            .inNamespace(job.getMetadata().getNamespace())
            .resource(job)
            .create();
    }

    @Override
    public String findJobPodName(String namespace, String runName, Duration timeout) {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            PodList podList = client.pods()
                .inNamespace(namespace)
                .withLabel(KubernetesRunResourceFactory.RUN_ID_LABEL, runName)
                .list();
            List<Pod> pods = podList.getItems();
            if (!pods.isEmpty() && pods.get(0).getMetadata() != null) {
                return pods.get(0).getMetadata().getName();
            }
            sleep();
        }
        throw new RunFailedException("Kubernetes job pod not found: " + runName);
    }

    @Override
    public void waitForPodRunning(String namespace, String podName, Duration timeout) {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            Pod pod = client.pods().inNamespace(namespace).withName(podName).get();
            if (pod != null && pod.getStatus() != null) {
                String phase = pod.getStatus().getPhase();
                if ("Running".equals(phase) || "Succeeded".equals(phase) || "Failed".equals(phase)) {
                    return;
                }
            }
            sleep();
        }
        throw new RunFailedException("Kubernetes job pod did not start: " + podName);
    }

    @Override
    public Job waitForJob(String namespace, String runName, Duration timeout) {
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

    @Override
    public void deleteJob(String namespace, String runName) {
        client.batch().v1().jobs().inNamespace(namespace).withName(runName).delete();
    }

    @Override
    public void deleteConfigMap(String namespace, String configMapName) {
        client.configMaps().inNamespace(namespace).withName(configMapName).delete();
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

    private void sleep() {
        try {
            TimeUnit.MILLISECONDS.sleep(500);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RunFailedException("Interrupted while waiting for Kubernetes pod", e);
        }
    }
}
