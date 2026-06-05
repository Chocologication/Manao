package com.manao.poc2.run;

import io.fabric8.kubernetes.api.model.ConfigMap;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import java.time.Duration;

public interface KubernetesRunClient {

    void createConfigMap(ConfigMap configMap);

    void createJob(Job job);

    String findJobPodName(String namespace, String runName, Duration timeout);

    void waitForPodRunning(String namespace, String podName, Duration timeout);

    Job waitForJob(String namespace, String runName, Duration timeout);

    void deleteJob(String namespace, String runName);

    void deleteConfigMap(String namespace, String configMapName);
}
