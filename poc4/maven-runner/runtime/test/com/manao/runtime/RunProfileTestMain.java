package com.manao.runtime;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Rules test for the fixed service profiles (Task 3). No framework, JDK standard
 * library only, so it runs inside the runtime-test image stage with real assertions:
 * {@code java -ea -cp /opt/manao-runner/classes:/opt/manao-runner/test-classes
 * com.manao.runtime.RunProfileTestMain}. Exits non-zero on any violated rule.
 *
 * <p>Covers the fixed profile mapping (command + readiness path), immediate rejection
 * of unknown profiles, extra arguments and unknown modes, the shared run/probe dispatch
 * (legacy Java default when the profile is omitted, identical profile for both modes),
 * and a real loopback HTTP probe proving that the profile's readiness path is the one
 * actually polled — not a free-form URL and never the other profile's path.</p>
 */
public final class RunProfileTestMain {

    private RunProfileTestMain() {
    }

    public static void main(String[] args) throws Exception {
        boolean assertionsEnabled = false;
        assert assertionsEnabled = true;
        if (!assertionsEnabled) {
            throw new IllegalStateException("this test must run with assertions: java -ea");
        }

        // Fixed mapping: the Python profile starts the launcher's web subcommand and
        // probes /health/ready; the Java profile keeps the fixed Maven wrapper and the
        // actuator readiness group.
        assert RunProfile.fromId("python-fastapi-web").command()
                .equals(List.of("/usr/local/bin/manao-python", "web"));
        assert RunProfile.fromId("python-fastapi-web").readinessPath().equals("/health/ready");
        assert RunProfile.fromId("java-spring-boot-web").readinessPath()
                .equals("/actuator/health/readiness");
        assert RunProfile.fromId("java-spring-boot-web").command()
                .equals(List.of("/usr/local/bin/manao-maven", "-q", "-DskipTests", "spring-boot:run"));

        // Only the explicitly enumerated profiles exist; anything else fails immediately.
        String[] unknownIds = {"", "java", "python", "web", "JAVA_SPRING_BOOT_WEB",
                "Python-FastAPI-Web", "java-spring-boot-web ", null};
        for (String bad : unknownIds) {
            try {
                RunProfile.fromId(bad);
                throw new AssertionError("unknown profile accepted: " + bad);
            } catch (IllegalArgumentException expected) {
                // the only allowed outcome besides the explicit failure above
            }
        }

        // Dispatch: no profile argument keeps the legacy Java default for both modes.
        assert WebRunSupervisor.requestedProfile("run", new String[0])
                == RunProfile.JAVA_SPRING_BOOT_WEB;
        assert WebRunSupervisor.requestedProfile("probe", new String[0])
                == RunProfile.JAVA_SPRING_BOOT_WEB;

        // run and probe must resolve the SAME profile for the same argument.
        assert WebRunSupervisor.requestedProfile("run", new String[] {"python-fastapi-web"})
                == RunProfile.PYTHON_FASTAPI_WEB;
        assert WebRunSupervisor.requestedProfile("run", new String[] {"python-fastapi-web"})
                == WebRunSupervisor.requestedProfile("probe", new String[] {"python-fastapi-web"});
        assert WebRunSupervisor.requestedProfile("run", new String[] {"java-spring-boot-web"})
                == WebRunSupervisor.requestedProfile("probe", new String[] {"java-spring-boot-web"});

        // Unknown profile ids, extra arguments and unknown modes fail immediately.
        expectRejected("run", "unknown-profile");
        expectRejected("probe", "unknown-profile");
        expectRejected("run", "python-fastapi-web", "extra");
        expectRejected("run", "java-spring-boot-web", "web", "more");
        expectRejected("probe", "java-spring-boot-web", "web");
        expectRejected("restart");
        expectRejected("");
        expectRejected(null);

        // Real probe: the profile decides which readiness path is actually polled on the
        // loopback primary port. The server answers only on /health/ready, so the Python
        // profile must succeed and the Java actuator path must not.
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        byte[] body = "OK".getBytes(StandardCharsets.UTF_8);
        server.createContext("/health/ready", exchange -> {
            exchange.getResponseHeaders().add("Content-Type", "text/plain");
            exchange.sendResponseHeaders(200, body.length);
            try (var out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        try {
            int port = server.getAddress().getPort();
            assert WebRunSupervisor.readinessUp(port, RunProfile.PYTHON_FASTAPI_WEB)
                    : "python profile must probe /health/ready";
            assert !WebRunSupervisor.readinessUp(port, RunProfile.JAVA_SPRING_BOOT_WEB)
                    : "java profile must probe the actuator path, not /health/ready";
        } finally {
            server.stop(0);
        }
        // With the server stopped, the same port must report not-ready (real failure path).
        assert !WebRunSupervisor.readinessUp(server.getAddress().getPort(),
                RunProfile.PYTHON_FASTAPI_WEB) : "closed port must not report ready";

        System.out.println("run-profile rules ok");
    }

    private static void expectRejected(String mode, String... profileArgs) {
        try {
            WebRunSupervisor.requestedProfile(mode, profileArgs);
            throw new AssertionError("rejected arguments accepted: mode=" + mode
                    + " args=" + List.of(profileArgs));
        } catch (IllegalArgumentException expected) {
            // required outcome
        }
    }
}
