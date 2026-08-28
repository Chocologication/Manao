package com.manao.poc4.config;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.ConstructorBinding;

@ConfigurationProperties(prefix = "manao.poc4.backend", ignoreUnknownFields = false)
public final class BackendProperties {
    private final BackendProfile profile;
    private final String javaVersion;
    private final String mavenVersion;
    private final Duration timeout;
    private final Kubernetes kubernetes;
    private final Workspace workspace;
    private final Logging logging;

    @ConstructorBinding
    public BackendProperties(BackendProfile profile, String javaVersion, String mavenVersion,
                             Duration timeout, Kubernetes kubernetes, Workspace workspace, Logging logging) {
        this.profile = profile;
        this.javaVersion = javaVersion;
        this.mavenVersion = mavenVersion;
        this.timeout = timeout;
        this.kubernetes = kubernetes;
        this.workspace = workspace;
        this.logging = logging;
    }

    public BackendProfile profile() { return profile; }
    public String fixedCommand() { return "mvn -q -DskipTests package"; }
    public String javaVersion() { return javaVersion; }
    public String mavenVersion() { return mavenVersion; }
    public Duration timeout() { return timeout; }
    public Kubernetes kubernetes() { return kubernetes; }
    public Workspace workspace() { return workspace; }
    public Logging logging() { return logging; }

    public record Kubernetes(String masterUrl, String namespace) {}
    public record Workspace(String bridgeMode, String pvcName) {}
    public record Logging(boolean redactSecrets) {}
}
