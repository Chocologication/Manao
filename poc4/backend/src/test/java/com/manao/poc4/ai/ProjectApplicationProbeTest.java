package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.kubernetes.Fabric8PublicEndpointGateway;
import com.manao.poc4.persistence.RunState;
import com.manao.poc4.project.ProjectRuntimeSpec;
import com.manao.poc4.project.ProjectRuntimeStore;
import com.manao.poc4.run.RunRecord;
import com.sun.net.httpserver.HttpServer;
import io.fabric8.kubernetes.api.model.Service;
import io.fabric8.kubernetes.api.model.ServiceBuilder;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.server.mock.KubernetesMixedDispatcher;
import io.fabric8.kubernetes.client.server.mock.KubernetesMockServer;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

class ProjectApplicationProbeTest {
    KubernetesMockServer kubernetes;
    KubernetesClient client;
    HttpServer http;
    java.util.concurrent.ExecutorService executor;
    ProjectRuntimeStore runtime = Mockito.mock(ProjectRuntimeStore.class);
    AtomicInteger hits = new AtomicInteger();
    AtomicReference<String> query = new AtomicReference<>();
    RunRecord run = readyRun("project", "run", "uid");

    @BeforeEach void setUp() throws Exception {
        Map<io.fabric8.mockwebserver.ServerRequest, java.util.Queue<io.fabric8.mockwebserver.ServerResponse>> responses = new java.util.HashMap<>();
        kubernetes = new KubernetesMockServer(new io.fabric8.mockwebserver.Context(),
            new io.fabric8.mockwebserver.MockWebServer(), responses, new KubernetesMixedDispatcher(responses), false);
        kubernetes.init();
        client = kubernetes.createClient();
        http = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        executor = Executors.newCachedThreadPool();
        http.setExecutor(executor);
        http.createContext("/", exchange -> {
            hits.incrementAndGet();
            query.set(exchange.getRequestURI().toASCIIString());
            assertThat(exchange.getRequestMethod()).isEqualTo("GET");
            assertThat(exchange.getRequestHeaders().getFirst("Authorization")).isNull();
            assertThat(exchange.getRequestHeaders().getFirst("Cookie")).isNull();
            byte[] body = "{\"message\":\"Hello Pi\"}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(exchange.getRequestURI().getPath().equals("/fail") ? 500 : 200, body.length);
            try (var out = exchange.getResponseBody()) { out.write(body); }
        });
        http.start();
        seed(http.getAddress().getPort());
    }

    @AfterEach void tearDown() {
        http.stop(0);
        executor.shutdownNow();
        client.close();
        kubernetes.destroy();
    }

    ProjectApplicationProbe probe() { return new ProjectApplicationProbe(client, "test", runtime, ProjectApplicationProbe.httpClient()); }

    void seed(int port) {
        Mockito.when(runtime.loadSpec("project")).thenReturn(new ProjectRuntimeSpec("java-spring-boot-web", false, false,
            List.of(new ProjectRuntimeSpec.Port("web", port, 30081))));
        client.services().inNamespace("test").resource(new ServiceBuilder()
            .withNewMetadata().withName(Fabric8PublicEndpointGateway.serviceName("project"))
                .withLabels(Map.of("manao.poc4/project-id", "project", "app.kubernetes.io/managed-by", "manao-poc4-backend")).endMetadata()
            .withNewSpec().withType("NodePort").withClusterIP("127.0.0.1")
                .withSelector(Map.of("manao.poc4/project-id", "project", "manao.poc4/component", "maven-run",
                    "manao.poc4/run-id", "run", "manao.poc4/pod-uid", "uid"))
                .addNewPort().withName("web").withProtocol("TCP").withPort(port).withNewTargetPort(port).withNodePort(30081).endPort()
            .endSpec().build()).createOrReplace();
    }

    Service service() { return client.services().inNamespace("test").withName("manao-app-project").get(); }
    void replace(Service service) {
        service.getMetadata().setResourceVersion(service().getMetadata().getResourceVersion());
        client.services().inNamespace("test").resource(service).update();
    }

    @Test void realResponsesKeepStatusAndQueryWithoutForwardingCredentials() {
        var result = probe().get(run, "/api/demo?name=Pi%20%E6%B1%89&x=%2F");
        assertThat(result.statusCode()).isEqualTo(200);
        assertThat(result.body()).contains("Hello Pi");
        assertThat(result.contentType()).isEqualTo("application/json");
        assertThat(result.error()).isNull();
        assertThat(query.get()).isEqualTo("/api/demo?name=Pi%20%E6%B1%89&x=%2F");
        assertThat(probe().get(run, "/fail").statusCode()).isEqualTo(500);
        assertThat(hits.get()).isEqualTo(2);
    }

    @Test void invalidPathsNeverReachTheApplication() {
        for (String path : List.of("http://127.0.0.1/", "//host/a", "/a\\b", "/a#fragment", "/a\n", "/" + "x".repeat(2048))) {
            assertThat(probe().get(run, path).error().code()).isEqualTo("VALIDATION_ERROR");
        }
        assertThat(hits.get()).isZero();
    }

    @Test void wrongServiceIdentitiesAndMappingsNeverSend() {
        Service original = service();
        for (Service invalid : List.of(
            new ServiceBuilder(original).editMetadata().addToLabels("manao.poc4/project-id", "other").endMetadata().build(),
            new ServiceBuilder(original).editSpec().addToSelector("manao.poc4/run-id", "old").endSpec().build(),
            new ServiceBuilder(original).editSpec().addToSelector("manao.poc4/pod-uid", "old").endSpec().build(),
            new ServiceBuilder(original).editSpec().withClusterIP("None").endSpec().build(),
            new ServiceBuilder(original).editSpec().withClusterIP((String) null).endSpec().build(),
            new ServiceBuilder(original).editSpec().withType("ExternalName").withExternalName("example.com").endSpec().build(),
            new ServiceBuilder(original).editSpec().editFirstPort().withNodePort(30082).endPort().endSpec().build(),
            new ServiceBuilder(original).editSpec().editFirstPort().withNewTargetPort(9).endPort().endSpec().build())) {
            replace(invalid);
            assertThat(probe().get(run, "/").error().code()).isEqualTo("AI_APP_ROUTE_UNAVAILABLE");
        }
        assertThat(hits.get()).isZero();
    }

    @Test void redirectsAreReturnedWithoutContactingTheirLocation() throws Exception {
        var other = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicInteger otherHits = new AtomicInteger();
        other.createContext("/", exchange -> { otherHits.incrementAndGet(); exchange.close(); });
        other.start();
        try {
            http.createContext("/redirect", exchange -> {
                exchange.getResponseHeaders().set("Location", "http://127.0.0.1:" + other.getAddress().getPort() + "/");
                exchange.sendResponseHeaders(302, -1); exchange.close();
            });
            assertThat(probe().get(run, "/redirect").statusCode()).isEqualTo(302);
            assertThat(otherHits.get()).isZero();
        } finally { other.stop(0); }
    }

    @Test void largeChunkedAndMalformedBodiesStayBoundedAndUtf8Valid() {
        byte[] chinese = ("汉".repeat(21846)).getBytes(StandardCharsets.UTF_8);
        byte[] invalid = new byte[65537];
        java.util.Arrays.fill(invalid, (byte) 0xff);
        for (byte[] bytes : List.of(new byte[65536], new byte[65537], chinese, invalid)) {
            http.removeContext("/");
            http.createContext("/", exchange -> {
                exchange.sendResponseHeaders(200, 0);
                try (var out = exchange.getResponseBody()) { out.write(bytes); } catch (java.io.IOException ignored) { }
            });
            var result = probe().get(run, "/");
            assertThat(result.statusCode()).isEqualTo(200);
            assertThat(result.body().getBytes(StandardCharsets.UTF_8).length).isLessThanOrEqualTo(65536);
            assertThat(result.truncated()).isEqualTo(bytes.length > 65536 || bytes == invalid);
            if (bytes == chinese) assertThat(result.body()).doesNotContain("�").endsWith("汉");
        }
    }

    @Test void infiniteBodyIsCancelledAtTheLimit() throws Exception {
        CountDownLatch closed = new CountDownLatch(1);
        http.createContext("/infinite", exchange -> {
            exchange.sendResponseHeaders(200, 0);
            try (var out = exchange.getResponseBody()) {
                byte[] chunk = new byte[8192];
                while (true) { out.write(chunk); out.flush(); }
            } catch (java.io.IOException expected) { closed.countDown(); }
        });
        var result = probe().get(run, "/infinite");
        assertThat(result.statusCode()).isEqualTo(200);
        assertThat(result.truncated()).isTrue();
        assertThat(closed.await(3, TimeUnit.SECONDS)).isTrue();
    }

    @Test void totalDeadlineIncludesTheBodyAndCancelsTheConnection() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch closed = new CountDownLatch(1);
        http.createContext("/slow", exchange -> {
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().write('a'); exchange.getResponseBody().flush();
            try { release.await(3, TimeUnit.SECONDS); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            try (var out = exchange.getResponseBody()) {
                while (true) { out.write(new byte[8192]); out.flush(); }
            } catch (java.io.IOException expected) { closed.countDown(); }
        });
        long start = System.nanoTime();
        try {
            var probe = new ProjectApplicationProbe(client, "test", runtime, ProjectApplicationProbe.httpClient(), Duration.ofMillis(200));
            var result = probe.get(run, "/slow");
            assertThat(result.error().code()).isEqualTo("AI_APP_HTTP_TIMEOUT");
            assertThat(result.statusCode()).isNull();
            assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(2));
        } finally { release.countDown(); }
        assertThat(closed.await(3, TimeUnit.SECONDS)).isTrue();
    }

    @Test void aGetWhoseHeadersArrivedBeforeResponseLossIsNeverRetried() throws Exception {
        try (ServerSocket socket = new ServerSocket(0, 10, java.net.InetAddress.getLoopbackAddress())) {
            socket.setSoTimeout(1200);
            AtomicInteger gets = new AtomicInteger();
            var serving = executor.submit(() -> {
                try {
                    while (true) {
                        try (var connection = socket.accept()) {
                            connection.setSoTimeout(1000);
                            StringBuilder headers = new StringBuilder();
                            int value;
                            while ((value = connection.getInputStream().read()) != -1) {
                                headers.append((char) value);
                                if (headers.toString().endsWith("\r\n\r\n")) break;
                            }
                            if (headers.toString().startsWith("GET ") && headers.toString().endsWith("\r\n\r\n")) gets.incrementAndGet();
                        }
                    }
                } catch (java.io.IOException expected) { }
            });
            seed(socket.getLocalPort());
            var result = probe().get(run, "/reset");
            assertThat(gets.get()).isEqualTo(1);
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> new HttpPiWorkerClient(
                "http://127.0.0.1:" + socket.getLocalPort(), "test-token", Duration.ofSeconds(1)).status("task"))
                .isInstanceOfSatisfying(com.manao.poc4.api.ApiException.class,
                    ex -> assertThat(ex.code()).isEqualTo("AI_WORKER_UNREACHABLE"));
            serving.get(3, TimeUnit.SECONDS);
            assertThat(result.error().code()).isEqualTo("AI_APP_HTTP_UNAVAILABLE");
            assertThat(result.statusCode()).isNull();
            assertThat(gets.get()).isEqualTo(2); // one Probe GET and one existing worker-client GET
        }
    }

    @Test void existingWorkerTransportStillPreservesSuccessfulAndUnconfiguredResponsesWithGlobalRetryDisabled() {
        http.createContext("/tasks/worker", exchange -> {
            assertThat(exchange.getRequestHeaders().getFirst("X-Manao-Worker-Token")).isEqualTo("worker-token");
            byte[] body = "{\"taskId\":\"worker\",\"instanceId\":\"instance\",\"state\":\"RUNNING\"}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(exchange.getRequestURI().getPath().endsWith("/stop") ? 503 : 200, body.length);
            try (var out = exchange.getResponseBody()) { out.write(body); }
        });
        var worker = new HttpPiWorkerClient("http://127.0.0.1:" + http.getAddress().getPort(), "worker-token", Duration.ofSeconds(1));
        assertThat(worker.status("worker").instanceId()).isEqualTo("instance");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> worker.stop("worker"))
            .isInstanceOfSatisfying(com.manao.poc4.api.ApiException.class,
                ex -> assertThat(ex.code()).isEqualTo("AI_WORKER_NOT_CONFIGURED"));
    }

    @Test void retrySettingsMustBePresentAtJvmLaunch() throws Exception {
        for (boolean configured : List.of(false, true)) {
            var command = new java.util.ArrayList<String>();
            command.add(java.nio.file.Path.of(System.getProperty("java.home"), "bin", "java").toString());
            if (configured) {
                command.add("-Djdk.httpclient.redirects.retrylimit=1");
                command.add("-Djdk.httpclient.disableRetryConnect=true");
            }
            command.addAll(List.of("-cp", System.getProperty("java.class.path"), StartupCheck.class.getName()));
            var builder = new ProcessBuilder(command).redirectErrorStream(true);
            for (String variable : List.of("JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS")) builder.environment().remove(variable);
            var process = builder.start();
            try {
                assertThat(process.waitFor(5, TimeUnit.SECONDS)).isTrue();
                assertThat(process.exitValue()).isEqualTo(configured ? 0 : 1);
            } finally { process.destroyForcibly(); }
        }
    }

    public static class StartupCheck {
        public static void main(String[] args) { ProjectApplicationProbe.requireStartupConfiguration(); }
    }

    @Test void enormousContentLengthDoesNotAllocateItAndEarlyBodyLossNeverPretendsToBe200() throws Exception {
        http.createContext("/huge", exchange -> {
            exchange.sendResponseHeaders(200, Long.MAX_VALUE);
            try (var out = exchange.getResponseBody()) { out.write(new byte[65537]); }
            catch (java.io.IOException expected) { }
        });
        var huge = probe().get(run, "/huge");
        assertThat(huge.statusCode()).isEqualTo(200);
        assertThat(huge.truncated()).isTrue();
        assertThat(huge.body().getBytes(StandardCharsets.UTF_8)).hasSize(65536);
        try (var socket = new ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
            socket.setSoTimeout(3000);
            var reset = executor.submit(() -> {
                try (var connection = socket.accept()) {
                    connection.setSoTimeout(2000);
                    var reader = new java.io.BufferedReader(new java.io.InputStreamReader(connection.getInputStream(), StandardCharsets.US_ASCII));
                    while (!reader.readLine().isEmpty()) { }
                    connection.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\na".getBytes(StandardCharsets.US_ASCII));
                    connection.getOutputStream().flush();
                    connection.setSoLinger(true, 0); // actual TCP reset, not HttpServer's short-write bookkeeping
                } catch (java.io.IOException ex) { throw new java.io.UncheckedIOException(ex); }
            });
            seed(socket.getLocalPort());
            var lost = probe().get(run, "/lost-body");
            reset.get(3, TimeUnit.SECONDS);
            assertThat(lost.statusCode()).isNull();
            assertThat(lost.error().code()).isEqualTo("AI_APP_HTTP_UNAVAILABLE");
        }
    }

    @Test void anActualHttp200IsDiscardedIfItsRunStopsDuringTheRequest() {
        var tasks = Mockito.mock(AgentTaskStore.class);
        var runs = Mockito.mock(com.manao.poc4.run.RunService.class);
        var store = Mockito.mock(com.manao.poc4.run.RunStore.class);
        var active = new AtomicReference<>(run);
        Mockito.when(tasks.taskOwner("task")).thenReturn(new AgentTaskStore.TaskOwner("owner", "project"));
        Mockito.when(store.findRunForOwner("owner", "project", "run")).thenReturn(java.util.Optional.of(run));
        Mockito.when(store.findActiveRun("project")).thenAnswer(call -> java.util.Optional.ofNullable(active.get()));
        http.createContext("/change", exchange -> {
            hits.incrementAndGet(); active.set(null);
            byte[] body = "success from old Run".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (var out = exchange.getResponseBody()) { out.write(body); }
        });
        var tools = new AgentApplicationTools(tasks, runs, store, Mockito.mock(com.manao.poc4.log.RunLogService.class),
            probe(), new com.manao.poc4.project.ProjectLifecycleGate());
        var args = new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode().put("runId", "run").put("path", "/change");
        var result = tools.invoke("task", new AgentTaskStore.ToolCallRow("task", "call", "sha", "app_http_get", args.toString(),
            "REGISTERED", null, 7, null, null, null, null), new AgentContracts.ToolRequest("call", "app_http_get", 7, args));
        assertThat(result.data().path("statusCode").isNull()).isTrue();
        assertThat(result.data().path("body").asText()).isEmpty();
        assertThat(result.data().path("error").path("code").asText()).isEqualTo("AI_APP_RUN_CHANGED");
        assertThat(hits.get()).isEqualTo(1);
    }

    static RunRecord readyRun(String project, String id, String uid) {
        Instant now = Instant.now();
        return new RunRecord(id, project, 7, RunState.RUNNING, "{}", "job", "pod", now, null, null,
            null, 1, now, 1, now, now.plusSeconds(7200), uid, null);
    }
}
