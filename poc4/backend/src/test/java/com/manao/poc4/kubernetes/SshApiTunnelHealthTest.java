package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class SshApiTunnelHealthTest {
    private StubCommandRunner runner;
    private SshApiTunnelHealth health;

    @BeforeEach
    void setUp() {
        runner = new StubCommandRunner();
        health = new SshApiTunnelHealth(runner, List.of("get", "list", "watch", "create", "delete"));
    }

    @Test
    void dualPreflightChecksKubectlAndAuthCanI() {
        runner.respond("version", 0, "{\"major\":\"1\",\"minor\":\"31\"}");
        runner.respond("can-i", 0, "yes");

        SshApiTunnelHealth.Result result = health.check("kubeconfig", "kubernetes.svc.cluster.local", "manao-test");

        assertThat(result.up()).isTrue();
        assertThat(result.failures()).isEmpty();
        // kubectl version was called once through the forwarded endpoint with the kubeconfig.
        assertThat(runner.commands.stream().filter(command -> command.contains("version"))).hasSize(1);
        assertThat(runner.commands.stream().filter(kind -> kind.equals("can-i"))).hasSize(5);
    }

    @Test
    void tunnelLossIsReportedDownAndMapsToRecovering() {
        runner.respond("version", 1, "The connection to the server localhost:6443 was refused");

        SshApiTunnelHealth.Result result = health.check("kubeconfig", "kubernetes.svc.cluster.local", "manao-test");

        assertThat(result.up()).isFalse();
        assertThat(result.failures()).anySatisfy(failure -> assertThat(failure).contains("version"));
        // A down tunnel maps to the dependency-unavailable semantics (503/RECOVERING), never to a terminal run state.
        assertThat(SshApiTunnelHealth.mapsToDependencyUnavailable(result)).isTrue();
    }

    @Test
    void missingNamespaceVerbsBlockStartup() {
        runner.respond("version", 0, "{}");
        runner.respond("can-i", 0, "no");

        SshApiTunnelHealth.Result result = health.check("kubeconfig", "kubernetes.svc.cluster.local", "manao-test");

        assertThat(result.up()).isFalse();
        assertThat(result.failures()).anySatisfy(failure -> assertThat(failure).contains("can-i"));
    }

    @Test
    void tokensAndPrivateKeysNeverEnterCommandArguments() {
        runner.respond("version", 0, "{}");
        runner.respond("can-i", 0, "yes");

        health.check("kubeconfig", "kubernetes.svc.cluster.local", "manao-test");

        for (List<String> command : runner.rawCommands) {
            assertThat(command).noneMatch(argument -> argument.toLowerCase().contains("token=")
                || argument.toLowerCase().contains("password="));
        }
    }

    static final class StubCommandRunner implements SshApiTunnelHealth.CommandRunner {
        final List<String> commands = new java.util.ArrayList<>();
        final List<List<String>> rawCommands = new java.util.ArrayList<>();
        private final java.util.Map<String, int[]> exitByKind = new java.util.HashMap<>();
        private final java.util.Map<String, String> outputByKind = new java.util.HashMap<>();

        void respond(String kind, int exitCode, String output) {
            exitByKind.put(kind, new int[]{exitCode});
            outputByKind.put(kind, output);
        }

        @Override public SshApiTunnelHealth.CommandRunner.CommandResult run(List<String> command) {
            rawCommands.add(command);
            String kind = command.contains("version") ? "version" : "can-i";
            commands.add(kind);
            int exit = exitByKind.getOrDefault(kind, new int[]{0})[0];
            return new SshApiTunnelHealth.CommandRunner.CommandResult(exit, outputByKind.getOrDefault(kind, ""), "");
        }
    }
}
