package com.manao.poc2.run;

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
        assertThat(configMap.getMetadata().getNamespace()).isEqualTo("default");
        assertThat(configMap.getMetadata().getLabels()).containsEntry(KubernetesRunResourceFactory.RUN_ID_LABEL, "run-abc");
        assertThat(configMap.getData()).containsEntry("Main.java", "public class Main {}");
    }

    @Test
    @DisplayName("creates Job that compiles and runs Java code from ConfigMap")
    void createJob_compilesAndRunsJavaCode() {
        Job job = factory.createJob("run-abc", "default", "eclipse-temurin:17-jdk");

        assertThat(job.getMetadata().getName()).isEqualTo("run-abc");
        assertThat(job.getMetadata().getNamespace()).isEqualTo("default");
        assertThat(job.getSpec().getBackoffLimit()).isZero();
        assertThat(job.getSpec().getTtlSecondsAfterFinished()).isEqualTo(300);
        assertThat(job.getSpec().getTemplate().getMetadata().getLabels())
            .containsEntry(KubernetesRunResourceFactory.RUN_ID_LABEL, "run-abc");
        assertThat(job.getSpec().getTemplate().getSpec().getRestartPolicy()).isEqualTo("Never");
        assertThat(job.getSpec().getTemplate().getSpec().getContainers()).hasSize(1);
        assertThat(job.getSpec().getTemplate().getSpec().getContainers().get(0).getName()).isEqualTo("java-runner");
        assertThat(job.getSpec().getTemplate().getSpec().getContainers().get(0).getImage())
            .isEqualTo("eclipse-temurin:17-jdk");
        assertThat(job.getSpec().getTemplate().getSpec().getContainers().get(0).getCommand())
            .containsExactly("sh", "-c", "cp /code/Main.java /workspace/Main.java && cd /workspace && javac Main.java && java Main");
        assertThat(job.getSpec().getTemplate().getSpec().getVolumes().get(0).getConfigMap().getName())
            .isEqualTo("run-abc-code");
        assertThat(job.getSpec().getTemplate().getSpec().getVolumes().get(1).getEmptyDir())
            .isNotNull();
    }
}
