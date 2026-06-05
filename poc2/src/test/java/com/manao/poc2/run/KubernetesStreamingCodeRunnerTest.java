package com.manao.poc2.run;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.manao.poc2.Poc2Properties;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.batch.v1.JobBuilder;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

class KubernetesStreamingCodeRunnerTest {

    private final KubernetesRunClient runClient = org.mockito.Mockito.mock(KubernetesRunClient.class);
    private final PodLogStreamer logStreamer = org.mockito.Mockito.mock(PodLogStreamer.class);
    private final KubernetesRunResourceFactory resourceFactory = new KubernetesRunResourceFactory();
    private final Poc2Properties properties = new Poc2Properties("default", "eclipse-temurin:17-jdk", Duration.ofSeconds(30), true);
    private final KubernetesStreamingCodeRunner runner = new KubernetesStreamingCodeRunner(
        runClient,
        properties,
        resourceFactory,
        logStreamer
    );

    @Test
    @DisplayName("streams log events and sends exit event after successful Job")
    void stream_whenJobSucceeds_sendsLogAndExitEvents() {
        List<RunEvent> events = new ArrayList<>();
        when(runClient.findJobPodName("default", "java-run-test", Duration.ofSeconds(30))).thenReturn("java-run-test-pod");
        when(runClient.waitForJob("default", "java-run-test", Duration.ofSeconds(30))).thenReturn(succeededJob());
        doAnswer(invocation -> {
            RunEventSink sink = invocation.getArgument(3);
            sink.send(RunEvent.log("java-run-test", "Hello from POC2"));
            return null;
        }).when(logStreamer).streamLogs(
            org.mockito.ArgumentMatchers.eq("default"),
            org.mockito.ArgumentMatchers.eq("java-run-test-pod"),
            org.mockito.ArgumentMatchers.eq("java-run-test"),
            any(RunEventSink.class)
        );

        runner.stream("java-run-test", "public class Main {}", events::add);

        assertThat(events)
            .extracting(RunEvent::type)
            .containsExactly("status", "status", "log", "exit");
        assertThat(events.get(0).message()).isEqualTo("job-created");
        assertThat(events.get(1).message()).isEqualTo("pod-found");
        assertThat(events.get(2).message()).isEqualTo("Hello from POC2");
        assertThat(events.get(3).code()).isZero();
        verify(runClient).waitForPodRunning("default", "java-run-test-pod", Duration.ofSeconds(30));
        verify(runClient).deleteJob("default", "java-run-test");
        verify(runClient).deleteConfigMap("default", "java-run-test-code");
    }

    @Test
    @DisplayName("creates Kubernetes resources using submitted code")
    void stream_whenCalled_createsConfigMapAndJob() {
        List<RunEvent> events = new ArrayList<>();
        when(runClient.findJobPodName(any(), any(), any())).thenReturn("java-run-test-pod");
        when(runClient.waitForJob(any(), any(), any())).thenReturn(succeededJob());

        runner.stream("java-run-test", "public class Main {}", events::add);

        ArgumentCaptor<io.fabric8.kubernetes.api.model.ConfigMap> configMapCaptor =
            ArgumentCaptor.forClass(io.fabric8.kubernetes.api.model.ConfigMap.class);
        ArgumentCaptor<Job> jobCaptor = ArgumentCaptor.forClass(Job.class);
        verify(runClient).createConfigMap(configMapCaptor.capture());
        verify(runClient).createJob(jobCaptor.capture());
        assertThat(configMapCaptor.getValue().getData()).containsEntry("Main.java", "public class Main {}");
        assertThat(jobCaptor.getValue().getMetadata().getName()).isEqualTo("java-run-test");
    }

    private Job succeededJob() {
        return new JobBuilder()
            .withNewStatus()
                .withSucceeded(1)
            .endStatus()
            .build();
    }
}
