package com.manao.poc4.kubernetes;

import java.util.ArrayList;
import java.util.List;

/**
 * Dual tunnel preflight: kubectl reachability (version) plus every namespace auth can-i verb of
 * the design's Role. A down tunnel maps to dependency-unavailable semantics (503/RECOVERING);
 * tokens and private keys never enter command arguments.
 */
public final class SshApiTunnelHealth {
    public interface CommandRunner {
        CommandResult run(List<String> command);

        record CommandResult(int exitCode, String stdout, String stderr) { }
    }

    public record Result(boolean up, List<String> failures) { }

    private final CommandRunner runner;
    private final List<String> requiredVerbs;

    public SshApiTunnelHealth(CommandRunner runner, List<String> requiredVerbs) {
        this.runner = runner;
        this.requiredVerbs = List.copyOf(requiredVerbs);
    }

    public Result check(String kubeconfigPath, String tlsServerName, String namespace) {
        List<String> failures = new ArrayList<>();
        String kubeconfig = "--kubeconfig=" + kubeconfigPath;
        CommandRunner.CommandResult version = runner.run(List.of("kubectl", kubeconfig, "version", "-o", "json"));
        if (version.exitCode() != 0) {
            failures.add("kubectl version failed through the forwarded endpoint: "
                + firstLine(version.stderr(), version.stdout()));
        }
        for (String verb : requiredVerbs) {
            CommandRunner.CommandResult canI = runner.run(
                List.of("kubectl", kubeconfig, "auth", "can-i", verb, "pods", "-n", namespace));
            if (canI.exitCode() != 0 || !canI.stdout().trim().equalsIgnoreCase("yes")) {
                failures.add("auth can-i " + verb + " pods denied in namespace " + namespace);
            }
        }
        return new Result(failures.isEmpty(), failures);
    }

    /** A down tunnel never settles runs; it maps to 503/RECOVERING dependency-unavailable semantics. */
    public static boolean mapsToDependencyUnavailable(Result result) {
        return !result.up();
    }

    private static String firstLine(String a, String b) {
        String value = a != null && !a.isBlank() ? a : b;
        if (value == null) return "unknown error";
        int newline = value.indexOf('\n');
        return newline == -1 ? value.trim() : value.substring(0, newline).trim();
    }
}
