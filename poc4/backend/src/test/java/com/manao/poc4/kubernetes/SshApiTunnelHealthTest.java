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
        runner.kubeconfig = Stage6KubeconfigFixture.VALID;
        health = new SshApiTunnelHealth(runner, SshApiTunnelHealth.designVerbs(true),
            () -> true, path -> Stage6KubeconfigFixture.VALID);
    }

    @Test
    void dualPreflightChecksKubectlFabric8AndEveryDesignVerb() {
        runner.respond("version", 0, "{\"major\":\"1\",\"minor\":\"31\"}");
        runner.respond("can-i", 0, "yes");

        SshApiTunnelHealth.Result result = health.check("kubeconfig", "localhost", "manao-test");

        assertThat(result.up()).isTrue();
        assertThat(result.failures()).isEmpty();
        assertThat(runner.commands.stream().filter(kind -> kind.equals("version"))).hasSize(1);
        // jobs(7) + pods(5) + services(4) + pvcs(4) + pods/log(1) + pods/exec(1) + portforward(1) + events(3)
        assertThat(runner.commands.stream().filter(kind -> kind.equals("can-i"))).hasSize(26);
    }

    @Test
    void tunnelLossIsReportedDownAndMapsToRecovering() {
        runner.respond("version", 1, "The connection to the server localhost:6443 was refused");

        SshApiTunnelHealth.Result result = health.check("kubeconfig", "localhost", "manao-test");

        assertThat(result.up()).isFalse();
        assertThat(result.failures()).anySatisfy(failure -> assertThat(failure).contains("version"));
        assertThat(SshApiTunnelHealth.mapsToDependencyUnavailable(result)).isTrue();
    }

    @Test
    void deniedNamespaceVerbsBlockStartup() {
        runner.respond("version", 0, "{}");
        runner.respond("can-i", 0, "no");

        SshApiTunnelHealth.Result result = health.check("kubeconfig", "localhost", "manao-test");

        assertThat(result.up()).isFalse();
        assertThat(result.failures().size()).isGreaterThanOrEqualTo(26);
    }

    @Test
    void fabric8ProbeFailureFailsThePreflight() {
        runner.respond("version", 0, "{}");
        runner.respond("can-i", 0, "yes");
        health = new SshApiTunnelHealth(runner, SshApiTunnelHealth.designVerbs(true),
            () -> false, path -> Stage6KubeconfigFixture.VALID);

        SshApiTunnelHealth.Result result = health.check("kubeconfig", "localhost", "manao-test");

        assertThat(result.up()).isFalse();
        assertThat(result.failures()).anySatisfy(failure -> assertThat(failure).contains("Fabric8"));
    }

    @Test
    void tlsServerNameMismatchFailsThePreflight() {
        runner.respond("version", 0, "{}");
        runner.respond("can-i", 0, "yes");

        SshApiTunnelHealth.Result result = health.check("kubeconfig", "wrong.san.local", "manao-test");

        assertThat(result.up()).isFalse();
        assertThat(result.failures()).anySatisfy(failure -> assertThat(failure).contains("tls-server-name mismatch"));
    }

    @Test
    void tokensAndPrivateKeysNeverEnterCommandArguments() {
        runner.respond("version", 0, "{}");
        runner.respond("can-i", 0, "yes");

        health.check("kubeconfig", "localhost", "manao-test");

        for (List<String> command : runner.rawCommands) {
            assertThat(command).noneMatch(argument -> argument.toLowerCase().contains("token=")
                || argument.toLowerCase().contains("password="));
        }
    }

    static final class Stage6KubeconfigFixture {
        static final String VALID = """
            apiVersion: v1
            kind: Config
            clusters:
            - name: stage6
              cluster:
                server: https://127.0.0.1:6443
                tls-server-name: localhost
                certificate-authority-data: Zm9vLWJhcg==
            contexts:
            - name: stage6
              context: {cluster: stage6, user: stage6}
            current-context: stage6
            users:
            - name: stage6
              user: {token: test}
            """;
    }

    static final class StubCommandRunner implements SshApiTunnelHealth.CommandRunner {
        final List<String> commands = new java.util.ArrayList<>();
        final List<List<String>> rawCommands = new java.util.ArrayList<>();
        String kubeconfig;
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
