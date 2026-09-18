package com.manao.poc4.kubernetes;

import java.util.ArrayList;
import java.util.List;

/**
 * Dual tunnel preflight: kubectl reachability, a Fabric8 /version probe, and every namespace
 * auth can-i (verb, resource) pair of the design's Role including subresources. A down tunnel
 * maps to dependency-unavailable semantics (503/RECOVERING); tokens never enter command args.
 */
public final class SshApiTunnelHealth {
    public interface CommandRunner {
        CommandResult run(List<String> command);

        record CommandResult(int exitCode, String stdout, String stderr) { }
    }

    /** Fabric8-side reachability probe of the same forwarded endpoint. */
    public interface Fabric8VersionProbe {
        boolean versionMatches();
    }

    public record VerbResource(String verb, String resource) { }

    /** The design Role, expressed as exact can-i checks (6A includes pods/portforward). */
    public static List<VerbResource> designVerbs(boolean includePortForward) {
        List<VerbResource> checks = new ArrayList<>(List.of(
            new VerbResource("get", "jobs"), new VerbResource("list", "jobs"), new VerbResource("watch", "jobs"),
            new VerbResource("create", "jobs"), new VerbResource("patch", "jobs"),
            new VerbResource("update", "jobs"), new VerbResource("delete", "jobs"),
            new VerbResource("get", "pods"), new VerbResource("list", "pods"), new VerbResource("watch", "pods"),
            new VerbResource("create", "pods"), new VerbResource("delete", "pods"),
            new VerbResource("get", "services"), new VerbResource("list", "services"),
            new VerbResource("create", "services"), new VerbResource("delete", "services"),
            new VerbResource("get", "persistentvolumeclaims"), new VerbResource("list", "persistentvolumeclaims"),
            new VerbResource("create", "persistentvolumeclaims"), new VerbResource("delete", "persistentvolumeclaims"),
            new VerbResource("list", "persistentvolumes"), new VerbResource("get", "storageclasses"),
            new VerbResource("get", "pods/log"), new VerbResource("create", "pods/exec"),
            new VerbResource("get", "events"), new VerbResource("list", "events"), new VerbResource("watch", "events")));
        if (includePortForward) {
            checks.add(new VerbResource("create", "pods/portforward"));
        }
        return List.copyOf(checks);
    }

    public record Result(boolean up, List<String> failures) { }

    private final CommandRunner runner;
    private final List<VerbResource> checks;
    private final Fabric8VersionProbe fabric8Probe;
    private final KubeconfigLoader kubeconfigLoader;

    public interface KubeconfigLoader {
        String load(String path);
    }

    public SshApiTunnelHealth(CommandRunner runner, List<VerbResource> checks) {
        this(runner, checks, null, path -> {
            try {
                return java.nio.file.Files.readString(java.nio.file.Path.of(path));
            } catch (java.io.IOException ex) {
                throw new IllegalStateException("kubeconfig is unreadable", ex);
            }
        });
    }

    public SshApiTunnelHealth(CommandRunner runner, List<VerbResource> checks, Fabric8VersionProbe fabric8Probe,
                              KubeconfigLoader kubeconfigLoader) {
        this.runner = runner;
        this.checks = List.copyOf(checks);
        this.fabric8Probe = fabric8Probe;
        this.kubeconfigLoader = kubeconfigLoader;
    }

    public Result check(String kubeconfigPath, String tlsServerName, String namespace) {
        List<String> failures = new ArrayList<>();
        String kubeconfig = "--kubeconfig=" + kubeconfigPath;
        CommandRunner.CommandResult version = runner.run(List.of("kubectl", kubeconfig, "version", "-o", "json"));
        if (version.exitCode() != 0) {
            failures.add("kubectl version failed through the forwarded endpoint: "
                + firstLine(version.stderr(), version.stdout()));
        }
        if (fabric8Probe != null && !fabric8Probe.versionMatches()) {
            failures.add("Fabric8 /version probe failed against the forwarded endpoint");
        }
        // The kubeconfig must carry the expected tls-server-name and stay structurally valid.
        try {
            KubeconfigTlsPreflight.Result preflight = KubeconfigTlsPreflight.validate(kubeconfigLoader.load(kubeconfigPath));
            if (!preflight.passed()) {
                failures.add("kubeconfig preflight failed: " + preflight.reason());
            } else if (tlsServerName != null && !tlsServerName.isBlank()
                && !tlsServerName.equals(preflight.tlsServerName())) {
                failures.add("tls-server-name mismatch: expected " + tlsServerName
                    + ", kubeconfig has " + preflight.tlsServerName());
            }
        } catch (RuntimeException ex) {
            failures.add("kubeconfig preflight failed: " + ex.getMessage());
        }
        for (VerbResource check : checks) {
            boolean clusterScoped = "persistentvolumes".equals(check.resource())
                || "storageclasses".equals(check.resource());
            List<String> command = new ArrayList<>(List.of("kubectl", kubeconfig, "auth", "can-i",
                check.verb(), check.resource()));
            command.addAll(clusterScoped ? List.of("--all-namespaces") : List.of("-n", namespace));
            CommandRunner.CommandResult canI = runner.run(command);
            if (canI.exitCode() != 0 || !canI.stdout().trim().equalsIgnoreCase("yes")) {
                failures.add("auth can-i " + check.verb() + " " + check.resource() + (clusterScoped ? " denied at cluster scope" : " denied in namespace " + namespace));
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
