package com.manao.poc1.run;

import static org.assertj.core.api.Assertions.assertThat;

import io.fabric8.kubernetes.api.model.ConfigMap;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class KubernetesRunResourceFactoryTest {

    private final KubernetesRunResourceFactory factory = new KubernetesRunResourceFactory();

    @Test
    @DisplayName("creates ConfigMap containing Main.java")
    void createConfigMap_containsMainJava() {
        ConfigMap configMap = factory.createConfigMap("run-abc", "default", "public class Main {}");

        assertThat(configMap.getMetadata().getName()).isEqualTo("run-abc-code");
        assertThat(configMap.getData()).containsEntry("Main.java", "public class Main {}");
    }

    @Test
    @DisplayName("creates Job that copies read-only ConfigMap code into writable workspace")
    void createJob_copiesConfigMapCodeIntoWorkspace() {
        Job job = factory.createJob("run-abc", "default", "eclipse-temurin:17-jdk");

        assertThat(job.getMetadata().getName()).isEqualTo("run-abc");
        assertThat(job.getSpec().getTemplate().getSpec().getRestartPolicy()).isEqualTo("Never");
        assertThat(job.getSpec().getTemplate().getSpec().getContainers()).hasSize(1);
        assertThat(job.getSpec().getTemplate().getSpec().getContainers().get(0).getImage())
            .isEqualTo("eclipse-temurin:17-jdk");
        assertThat(job.getSpec().getTemplate().getSpec().getContainers().get(0).getCommand())
            .containsExactly("sh", "-c", "cp /code/Main.java /workspace/Main.java && cd /workspace && javac Main.java && java Main");
        assertThat(job.getSpec().getTemplate().getSpec().getVolumes().get(0).getName())
            .isEqualTo("source-code");
        assertThat(job.getSpec().getTemplate().getSpec().getVolumes().get(0).getConfigMap().getName())
            .isEqualTo("run-abc-code");
        assertThat(job.getSpec().getTemplate().getSpec().getVolumes().get(1).getName())
            .isEqualTo("workspace");
        assertThat(job.getSpec().getTemplate().getSpec().getVolumes().get(1).getEmptyDir())
            .isNotNull();
    }
}
