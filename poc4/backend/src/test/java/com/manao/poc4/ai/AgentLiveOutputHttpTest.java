package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.GlobalExceptionHandler;
import com.manao.poc4.auth.JwtService;
import com.manao.poc4.config.SecurityConfig;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.autoconfigure.http.HttpMessageConvertersAutoConfiguration;
import org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration;
import org.springframework.boot.autoconfigure.security.servlet.SecurityAutoConfiguration;
import org.springframework.boot.autoconfigure.security.servlet.SecurityFilterAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.DispatcherServletAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.ServletWebServerFactoryAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.web.servlet.context.AnnotationConfigServletWebServerApplicationContext;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.security.web.FilterChainProxy;

class AgentLiveOutputHttpTest {
    @Configuration(proxyBeanMethods = false)
    @ImportAutoConfiguration({ServletWebServerFactoryAutoConfiguration.class, DispatcherServletAutoConfiguration.class,
        WebMvcAutoConfiguration.class, JacksonAutoConfiguration.class, HttpMessageConvertersAutoConfiguration.class,
        SecurityAutoConfiguration.class, SecurityFilterAutoConfiguration.class})
    @Import({SecurityConfig.class, GlobalExceptionHandler.class, AgentInternalController.class, AgentLiveOutputController.class})
    static class WebConfig { }

    @Test void fourBlockedSocketsDetachWithoutFalseReleaseThenCloseRestoresActualSenderCapacity() throws Exception {
        try (var f = new Fixture()) {
            f.tasks.bindWorkerInstance(f.task, 1, "worker");
            assertThat(f.post(f.task, f.snapshot(1), true, "worker", "1").statusCode()).isEqualTo(204);
            f.tasks.applyTerminal(f.task, AgentContracts.TaskState.COMPLETED, "done", null);
            String active = UUID.randomUUID().toString();
            f.tasks.createTask("owner", "project", new AgentContracts.TaskRequest(active, "next", 7), f.conversation);
            f.tasks.bindWorkerInstance(active, 1, "worker");
            assertThat(f.post(active, f.snapshot(1).replace(f.task, active), true, "worker", "1").statusCode()).isEqualTo(204);
            var sockets = new java.util.ArrayList<java.net.Socket>();
            try {
                for (String id : new String[] {f.task, f.task, active, active}) {
                    var socket = new java.net.Socket(); sockets.add(socket);
                    socket.setReceiveBufferSize(1024); socket.setSoTimeout(3000);
                    socket.connect(new java.net.InetSocketAddress("127.0.0.1", f.port), 3000);
                    socket.getOutputStream().write(("GET " + f.livePath().replace(f.task, id) + " HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer " + f.token + "\r\nConnection: keep-alive\r\n\r\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII));
                    socket.getOutputStream().flush();
                    var bytes = new java.io.ByteArrayOutputStream();
                    while (!bytes.toString(java.nio.charset.StandardCharsets.UTF_8).contains("hello")) {
                        int value = socket.getInputStream().read();
                        if (value < 0 || bytes.size() > 4096) throw new AssertionError("First socket frame missing: " + bytes);
                        bytes.write(value);
                    }
                    assertThat(bytes.toString(java.nio.charset.StandardCharsets.UTF_8)).contains("200", "text/event-stream", "event:snapshot");
                }
                assertThat(f.get(f.livePath(), f.token).statusCode()).isEqualTo(429);
                long maximumPostMillis = 0;
                int revision = 2;
                for (; revision < 240 && f.live().diagnostics().detached() < 4; revision++) {
                    for (String id : new String[] {f.task, active}) {
                        String large = f.snapshot(revision).replace(f.task, id).replace("hello", "x".repeat(240 * 1024));
                        long start = System.nanoTime();
                        assertThat(f.post(id, large, true, "worker", "1").statusCode()).isEqualTo(204);
                        maximumPostMillis = Math.max(maximumPostMillis, TimeUnitMillis.elapsed(start));
                        assertThat(f.live().diagnostics().cachedTasks()).isLessThanOrEqualTo(2);
                        assertThat(f.live().diagnostics().pending()).isLessThanOrEqualTo(4);
                    }
                }
                await(() -> f.live().diagnostics().detached() == 4, Duration.ofSeconds(5));
                var blocked = f.live().diagnostics();
                assertThat(blocked.resources()).isEqualTo(4);
                assertThat(blocked.sending()).isEqualTo(4);
                assertThat(blocked.entered() - blocked.exited()).isEqualTo(4);
                assertThat(blocked.pending()).isZero();
                assertThat(maximumPostMillis).isLessThan(2000);
                assertThat(f.get(f.livePath().replace(f.task, active), f.token).statusCode()).isEqualTo(503);
                assertThat(f.tasks.findForOwner("owner", "project", active).orElseThrow().writesLocked()).isTrue();
                assertThat(f.db.jdbc().queryForObject("SELECT progress_json FROM agent_task WHERE id=?", String.class, active)).isNull();
                long terminalStart = System.nanoTime();
                assertThat(f.tasks.applyTerminal(active, AgentContracts.TaskState.COMPLETED, "done", null)).isTrue();
                assertThat(TimeUnitMillis.elapsed(terminalStart)).isLessThan(1000);
                for (var socket : sockets) { socket.setSoLinger(true, 0); socket.close(); }
                await(() -> f.live().diagnostics().resources() == 0, Duration.ofSeconds(5));
                var released = f.live().diagnostics();
                assertThat(released.entered()).isEqualTo(released.exited());
                var recovered = f.stream(f.livePath().replace(f.task, active));
                try (var body = recovered.body()) {
                    assertThat(recovered.statusCode()).isEqualTo(200);
                    assertThat(firstFrame(body)).contains("event:snapshot");
                }
                System.out.printf("TASK4_SOCKET_EVIDENCE revisions=%d postedBytesApprox=%d maxPostMs=%d blocked=%s released=%s recovery=200%n",
                    revision, (long) revision * 2 * 240 * 1024, maximumPostMillis, blocked, released);
            } finally { for (var socket : sockets) socket.close(); }
        }
    }

    static void await(java.util.function.BooleanSupplier condition, Duration budget) throws Exception {
        long deadline = System.nanoTime() + budget.toNanos();
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(10);
        assertThat(condition.getAsBoolean()).as("condition within " + budget).isTrue();
    }
    static final class TimeUnitMillis { static long elapsed(long start) { return java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start); } }

    @Test void ownedBrowserReadsFirstFrameBeforeStreamEndsAndOtherOwnersAreRefused() throws Exception {
        try (var f = new Fixture()) {
            f.tasks.bindWorkerInstance(f.task, 1, "worker");
            assertThat(f.post(f.task, f.snapshot(1), true, "worker", "1").statusCode()).isEqualTo(204);
            assertThat(f.get(f.livePath(), null).statusCode()).isEqualTo(401);
            assertThat(f.get(f.livePath(), "invalid").statusCode()).isEqualTo(401);
            assertThat(f.get(f.livePath(), f.app.getBean(JwtService.class).issue("foreign").accessToken()).statusCode()).isEqualTo(404);
            assertThat(f.get(f.livePath().replace("projects/project/", "projects/foreign/"), f.token).statusCode()).isEqualTo(404);
            var response = f.stream(f.livePath());
            try (var body = response.body()) {
                assertThat(response.statusCode()).isEqualTo(200);
                assertThat(response.headers().firstValue("content-type").orElse("")).contains("text/event-stream");
                assertThat(response.headers().firstValue("cache-control").orElse("")).isEqualTo("no-store");
                String frame = firstFrame(body);
                assertThat(frame).contains("event:snapshot", "data:{", "\"revision\":1");
                assertThat(frame.lines().filter(line -> line.startsWith("data:")).count()).isEqualTo(1);
                assertThat(f.tasks.findForOwner("owner", "project", f.task).orElseThrow().state().name()).isEqualTo("RUNNING");
            }
        }
    }

    static String firstFrame(java.io.InputStream body) throws Exception {
        var reader = java.util.concurrent.Executors.newSingleThreadExecutor();
        try {
            return reader.submit(() -> {
                var bytes = new java.io.ByteArrayOutputStream();
                int previous = -1;
                for (int value; (value = body.read()) != -1;) {
                    bytes.write(value);
                    if (value == '\n' && previous == '\n') return bytes.toString(java.nio.charset.StandardCharsets.UTF_8);
                    previous = value;
                }
                throw new AssertionError("Stream ended before first complete frame");
            }).get(3, java.util.concurrent.TimeUnit.SECONDS);
        } finally { reader.shutdownNow(); }
    }

    @Test void authenticatedSnapshotPostRejectsUnboundWorkerWithoutStartingTaskThenRecovers() throws Exception {
        try (var fixture = new Fixture()) {
            String task = fixture.task;
            assertThat(fixture.post(task, fixture.snapshot(1), false, null, null).statusCode()).isEqualTo(401);
            assertThat(fixture.post(task, fixture.snapshot(1), true, "worker", "1").statusCode()).isEqualTo(409);
            assertThat(fixture.tasks.findForOwner("owner", "project", task).orElseThrow().state().name()).isEqualTo("QUEUED");
            assertThat(fixture.db.jdbc().queryForObject("SELECT worker_instance_id FROM agent_task WHERE id=?", String.class, task)).isNull();
            fixture.tasks.bindWorkerInstance(task, 1, "worker");
            assertThat(fixture.post(task, fixture.snapshot(1), true, "worker", "1").statusCode()).isEqualTo(204);
        }
    }

    static final class Fixture implements AutoCloseable {
        final JdbcStoreTestSupport db = JdbcStoreTestSupport.create();
        final AgentTaskStore tasks;
        final AgentConversationStore conversations;
        final AnnotationConfigServletWebServerApplicationContext app;
        final HttpClient client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(3)).followRedirects(HttpClient.Redirect.NEVER).build();
        final String task = UUID.randomUUID().toString();
        final String conversation = UUID.randomUUID().toString();
        final String token;
        final int port;
        Fixture() {
            var jdbc = db.jdbc();
            var now = java.sql.Timestamp.from(java.time.Instant.now());
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('owner','owner','unused',?)", now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('project','owner','project','READY',7,?,?)", now, now);
            var tx = new DataSourceTransactionManager(jdbc.getDataSource());
            tasks = new AgentTaskStore(jdbc, tx, Clock.systemUTC());
            conversations = new AgentConversationStore(jdbc, tx, Clock.systemUTC(), tasks);
            conversations.create("owner", "project", new AgentConversationContracts.CreateConversationRequest(conversation));
            tasks.createTask("owner", "project", new AgentContracts.TaskRequest(task, "goal", 7), conversation);
            var application = new SpringApplication(WebConfig.class);
            application.setWebApplicationType(WebApplicationType.SERVLET);
            application.setDefaultProperties(Map.of("server.port", "0", "server.address", "127.0.0.1",
                "spring.config.location", "optional:classpath:/task4-no-runtime-config.yml",
                "spring.main.banner-mode", "off", "spring.flyway.enabled", "false",
                "manao.poc4.ai.enabled", "true", "MANAO_JWT_SECRET", "0123456789abcdef0123456789abcdef",
                "MANAO_AI_INTERNAL_TOKEN", "internal-token"));
            application.addInitializers(context -> {
                var web = (AnnotationConfigServletWebServerApplicationContext) context;
                web.registerBean(AgentTaskStore.class, () -> tasks);
                web.registerBean(AgentLiveOutput.class, () -> new AgentLiveOutput(tasks));
                web.registerBean(AgentTaskService.class, () -> new AgentTaskService(tasks,
                    new com.manao.poc4.project.ProjectLifecycleGate(), null, null));
            });
            app = (AnnotationConfigServletWebServerApplicationContext) application.run();
            assertThat(app.getBean(FilterChainProxy.class)).isNotNull();
            port = app.getWebServer().getPort();
            token = app.getBean(JwtService.class).issue("owner").accessToken();
        }
        String snapshot(long revision) {
            return "{\"revision\":" + revision + ",\"taskId\":\"" + task + "\",\"conversationId\":\"" + conversation
                + "\",\"durableHeadSeq\":1,\"current\":{\"messageOrdinal\":1,\"phase\":\"generating\",\"blocks\":[{\"contentIndex\":0,\"kind\":\"text\",\"text\":\"hello\"}],\"modelTruncated\":false,\"displayTruncated\":false},\"unavailable\":false}";
        }
        URI uri(String path) { return URI.create("http://127.0.0.1:" + port + path); }
        String livePath() { return "/api/v1/projects/project/agent-tasks/" + task + "/live-output"; }
        HttpResponse<String> get(String path, String bearer) throws Exception {
            var request = HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(3));
            if (bearer != null) request.header("Authorization", "Bearer " + bearer);
            return client.send(request.GET().build(), HttpResponse.BodyHandlers.ofString());
        }
        HttpResponse<java.io.InputStream> stream(String path) throws Exception {
            return client.send(HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(3))
                .header("Authorization", "Bearer " + token).GET().build(), HttpResponse.BodyHandlers.ofInputStream());
        }
        HttpResponse<String> post(String id, String body, boolean worker, String instance, String epoch) throws Exception {
            var request = HttpRequest.newBuilder(uri("/internal/ai/tasks/" + id + "/live-output"))
                .timeout(Duration.ofSeconds(3)).header("Content-Type", "application/json")
                .header(worker ? "X-Manao-Worker-Token" : "Authorization", worker ? "internal-token" : "Bearer " + token);
            if (instance != null) request.header("X-Manao-Worker-Instance", instance);
            if (epoch != null) request.header("X-Manao-Worker-Epoch", epoch);
            return client.send(request.POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
        }
        AgentLiveOutput live() { return app.getBean(AgentLiveOutput.class); }
        public void close() { live().close(); app.close(); db.close(); }
    }
}
