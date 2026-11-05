package com.manao.poc4.ai;

import com.manao.poc4.workspace.WorkspacePathPolicy;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public final class AgentFilePolicy {
    private static final Set<String> CREDENTIAL_FILES = Set.of(
        ".env", ".npmrc", ".netrc", ".git-credentials", ".htpasswd", ".pgpass",
        "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials.json");
    private static final List<String> CREDENTIAL_SUFFIXES = List.of(
        ".pem", ".key", ".p12", ".jks", ".keystore", ".kdbx");
    private static final Set<String> PYTHON_DENIED_SEGMENTS = Set.of(
        "venv", "__pycache__", "node_modules", "target", "dist", "build", "pom.xml");
    private static final Set<String> MANAGED_FILES = Set.of("pyproject.toml", "uv.lock", ".python-version");
    private static final List<String> PYTHON_SUFFIXES = List.of(
        ".py", ".pyi", ".json", ".toml", ".yaml", ".yml", ".ini", ".cfg", ".txt", ".md",
        ".rst", ".adoc", ".csv", ".tsv", ".html", ".css", ".js", ".sql");
    private final boolean python;

    private AgentFilePolicy(boolean python) {
        this.python = python;
    }

    public static AgentFilePolicy forEnvironment(AgentProjectEnvironment environment) {
        if (environment == null) throw AgentProjectEnvironmentService.missing();
        return new AgentFilePolicy("python".equals(environment.language()));
    }

    public boolean canList(String path) {
        if (path == null || path.isEmpty()) return true;
        return allowedPath(path) && (python || javaPath(path));
    }

    public boolean canRead(String path) {
        if (python && ".python-version".equals(path)) return true;
        if (!allowedPath(path)) return false;
        if (!python) return javaPath(path);
        String lower = path.toLowerCase(Locale.ROOT);
        return isManagedFile(path) || PYTHON_SUFFIXES.stream().anyMatch(lower::endsWith);
    }

    public boolean canWrite(String path) {
        return canRead(path) && !isManagedFile(path);
    }

    boolean isManagedFile(String path) {
        return python && path != null && MANAGED_FILES.contains(path.toLowerCase(Locale.ROOT));
    }

    private boolean allowedPath(String path) {
        try {
            WorkspacePathPolicy.validateRelativePath(path);
        } catch (WorkspacePathPolicy.InvalidPathException ex) {
            return false;
        }
        for (String segment : path.split("/")) {
            String lower = segment.toLowerCase(Locale.ROOT);
            if (lower.equals(".git") || lower.equals("target") || lower.startsWith(".manao")
                    || CREDENTIAL_FILES.contains(lower)
                    || CREDENTIAL_SUFFIXES.stream().anyMatch(lower::endsWith)
                    || python && (lower.startsWith(".") || PYTHON_DENIED_SEGMENTS.contains(lower))) {
                return false;
            }
        }
        return true;
    }

    private boolean javaPath(String path) {
        String[] segments = path.toLowerCase(Locale.ROOT).split("/");
        String first = segments[0];
        return first.equals("pom.xml") || first.equals("src") || segments.length == 1
            && (first.endsWith(".md") || first.endsWith(".txt") || first.endsWith(".adoc") || first.endsWith(".rst"));
    }
}
