package com.manao.poc2.run;

import io.fabric8.kubernetes.api.model.ConfigMap;
import io.fabric8.kubernetes.api.model.ConfigMapBuilder;
import io.fabric8.kubernetes.api.model.Quantity;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.batch.v1.JobBuilder;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public class KubernetesRunResourceFactory {

    static final String RUN_ID_LABEL = "manao.dev/run-id";
    private static final String CONTAINER_NAME = "java-runner";
    private static final String CODE_FILE_NAME = "Main.java";
    private static final String CODE_MOUNT_PATH = "/code";
    private static final String WORKSPACE_MOUNT_PATH = "/workspace";

    ConfigMap createConfigMap(String runName, String namespace, String code) {
        return new ConfigMapBuilder()
            .withNewMetadata()
                .withName(configMapName(runName))
                .withNamespace(namespace)
                .addToLabels(RUN_ID_LABEL, runName)
            .endMetadata()
            .addToData(CODE_FILE_NAME, code)
            .build();
    }

    Job createJob(String runName, String namespace, String image) {
        Map<String, String> labels = Map.of(RUN_ID_LABEL, runName);

        return new JobBuilder()
            .withNewMetadata()
                .withName(runName)
                .withNamespace(namespace)
                .addToLabels(labels)
            .endMetadata()
            .withNewSpec()
                .withBackoffLimit(0)
                .withTtlSecondsAfterFinished(300)
                .withNewTemplate()
                    .withNewMetadata()
                        .addToLabels(labels)
                    .endMetadata()
                    .withNewSpec()
                        .withRestartPolicy("Never")
                        .addNewContainer()
                            .withName(CONTAINER_NAME)
                            .withImage(image)
                            .withCommand("sh", "-c", "cp /code/Main.java /workspace/Main.java && cd /workspace && javac Main.java && java Main")
                            .withNewResources()
                                .addToRequests("cpu", new Quantity("100m"))
                                .addToRequests("memory", new Quantity("128Mi"))
                                .addToLimits("cpu", new Quantity("500m"))
                                .addToLimits("memory", new Quantity("512Mi"))
                            .endResources()
                            .addNewVolumeMount()
                                .withName("source-code")
                                .withMountPath(CODE_MOUNT_PATH)
                            .endVolumeMount()
                            .addNewVolumeMount()
                                .withName("workspace")
                                .withMountPath(WORKSPACE_MOUNT_PATH)
                            .endVolumeMount()
                        .endContainer()
                        .addNewVolume()
                            .withName("source-code")
                            .withNewConfigMap()
                                .withName(configMapName(runName))
                            .endConfigMap()
                        .endVolume()
                        .addNewVolume()
                            .withName("workspace")
                            .withNewEmptyDir()
                            .endEmptyDir()
                        .endVolume()
                    .endSpec()
                .endTemplate()
            .endSpec()
            .build();
    }

    String configMapName(String runName) {
        return runName + "-code";
    }
}
