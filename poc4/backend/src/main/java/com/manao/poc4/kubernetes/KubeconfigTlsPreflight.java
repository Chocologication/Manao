package com.manao.poc4.kubernetes;

import java.util.List;
import java.util.Map;
import org.yaml.snakeyaml.Yaml;

/**
 * Structural preflight of the 6A temporary kubeconfig: HTTPS server, CA material present,
 * explicit tls-server-name (a SAN actually served by the remote certificate) and a hard
 * rejection of insecure-skip-tls-verify in any form.
 */
public final class KubeconfigTlsPreflight {
    private KubeconfigTlsPreflight() { }

    public record Result(boolean passed, String reason, String server, String tlsServerName) { }

    @SuppressWarnings("unchecked")
    public static Result validate(String kubeconfigYaml) {
        Map<String, Object> root;
        try {
            root = new Yaml().load(kubeconfigYaml);
        } catch (RuntimeException ex) {
            return new Result(false, "kubeconfig is not valid YAML", null, null);
        }
        if (root == null || !(root.get("clusters") instanceof List<?> clusters) || clusters.isEmpty()) {
            return new Result(false, "kubeconfig declares no clusters", null, null);
        }
        if (!(root.get("users") instanceof List<?> users) || users.isEmpty()) {
            return new Result(false, "kubeconfig declares no users", null, null);
        }
        Map<String, Object> cluster = (Map<String, Object>) ((Map<String, Object>) clusters.get(0)).get("cluster");
        if (cluster == null) {
            return new Result(false, "cluster entry is missing", null, null);
        }
        Object server = cluster.get("server");
        if (!(server instanceof String serverValue) || !serverValue.startsWith("https://")) {
            return new Result(false, "cluster server must use https", server instanceof String s ? s : null, null);
        }
        if (Boolean.TRUE.equals(cluster.get("insecure-skip-tls-verify"))) {
            return new Result(false, "insecure-skip-tls-verify is forbidden; keep CA and hostname verification enabled",
                serverValue, null);
        }
        Object tlsServerName = cluster.get("tls-server-name");
        if (!(tlsServerName instanceof String san) || san.isBlank()) {
            return new Result(false, "tls-server-name with a real certificate SAN is required", serverValue, null);
        }
        boolean hasCa = cluster.get("certificate-authority-data") != null || cluster.get("certificate-authority") != null;
        if (!hasCa) {
            return new Result(false, "certificate-authority material is required", serverValue, san);
        }
        return new Result(true, null, serverValue, san);
    }

    public static void requireValid(String kubeconfigYaml) {
        Result result = validate(kubeconfigYaml);
        if (!result.passed()) {
            throw new IllegalStateException("kubeconfig preflight failed: " + result.reason());
        }
    }
}
