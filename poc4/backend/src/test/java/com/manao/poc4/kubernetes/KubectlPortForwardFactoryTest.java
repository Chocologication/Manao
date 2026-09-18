package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

class KubectlPortForwardFactoryTest {
    @Test
    void startsLoopbackPodForwardWithServerDerivedArguments() {
        Process process = mock(Process.class);
        when(process.isAlive()).thenReturn(true);
        RecordingStarter starter = new RecordingStarter(process);
        KubectlPortForwardFactory factory = new KubectlPortForwardFactory(
            "kubectl.exe", Path.of("C:/tmp/stage6-kubeconfig"), starter);

        WorkspacePortForwardManager.PortForwardProcess forward =
            factory.start("manao-stage6-test", "manao-ws-project-1", 8080, 18123);

        assertThat(starter.command()).containsExactly(
            "kubectl.exe", "--kubeconfig", Path.of("C:/tmp/stage6-kubeconfig").toString(),
            "--namespace", "manao-stage6-test", "port-forward",
            "pod/manao-ws-project-1", "--address=127.0.0.1", "18123:8080");
        assertThat(forward.isAlive()).isTrue();
        when(process.pid()).thenReturn(4242L);
        assertThat(forward.pid()).hasValue(4242L);
        forward.kill();
        verify(process).destroy();
    }

    static final class RecordingStarter implements KubectlPortForwardFactory.ProcessStarter {
        private final Process process;
        private List<String> command;

        RecordingStarter(Process process) { this.process = process; }

        @Override public Process start(List<String> command) {
            this.command = List.copyOf(command);
            return process;
        }

        List<String> command() { return command; }
    }
}