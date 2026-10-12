package com.manao.runtime;

import java.util.List;

/**
 * Fixed service profiles of the shared single-run web supervisor. A profile pins both
 * the supervised child command and the loopback readiness path that {@code run} and
 * {@code probe} poll; there is no free-form health URL and no environment or argv
 * override of either value.
 *
 * <p>Only the explicitly enumerated profiles exist: {@link #fromId(String)} fails
 * immediately on anything else. {@code run} and {@code probe} resolve their profile
 * through the same mapping, so the two modes can never disagree for the same
 * invocation; omitting the profile argument keeps the legacy Java default for
 * already-created resources.</p>
 */
public enum RunProfile {

    /**
     * Spring Boot web application: the fixed root-owned Maven wrapper initializes the
     * project's persistent Maven cache (inside the startup budget) and then execs
     * {@code mvn -q -DskipTests spring-boot:run}; readiness is the actuator readiness
     * group on the primary port.
     */
    JAVA_SPRING_BOOT_WEB(
            "java-spring-boot-web",
            List.of("/usr/local/bin/manao-maven", "-q", "-DskipTests", "spring-boot:run"),
            "/actuator/health/readiness"),

    /**
     * FastAPI web application: the fixed Python launcher (installed by the Python
     * runner image) starts the prepared application; readiness is the launcher's
     * {@code /health/ready} endpoint on the primary port.
     */
    PYTHON_FASTAPI_WEB(
            "python-fastapi-web",
            List.of("/usr/local/bin/manao-python", "web"),
            "/health/ready");

    private final String id;
    private final List<String> command;
    private final String readinessPath;

    RunProfile(String id, List<String> command, String readinessPath) {
        this.id = id;
        this.command = List.copyOf(command);
        this.readinessPath = readinessPath;
    }

    /** The fixed supervised child command; never derived from the environment. */
    public List<String> command() {
        return command;
    }

    /** The fixed readiness path polled on the loopback primary port. */
    public String readinessPath() {
        return readinessPath;
    }

    /**
     * Resolves an explicitly enumerated profile id. Unknown or null ids fail
     * immediately — the supervisor must never fall back silently.
     */
    public static RunProfile fromId(String id) {
        for (RunProfile profile : values()) {
            if (profile.id.equals(id)) {
                return profile;
            }
        }
        throw new IllegalArgumentException("unknown service profile: " + id);
    }
}
