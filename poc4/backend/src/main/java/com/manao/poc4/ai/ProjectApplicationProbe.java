package com.manao.poc4.ai;

import static com.manao.poc4.kubernetes.Fabric8PublicEndpointGateway.*;

import com.manao.poc4.project.ProjectRuntimeStore;
import com.manao.poc4.run.RunRecord;
import io.fabric8.kubernetes.client.KubernetesClient;
import java.net.URI;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.SocketAddress;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.charset.CodingErrorAction;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** HTTP feedback from one verified application Service. */
public final class ProjectApplicationProbe {
    private static final int BODY_BYTES = 64 * 1024;
    private final KubernetesClient client;
    private final String namespace;
    private final ProjectRuntimeStore runtime;
    private final HttpClient http;
    private final Duration budget;

    public ProjectApplicationProbe(KubernetesClient client, String namespace, ProjectRuntimeStore runtime, HttpClient http) {
        this(client, namespace, runtime, http, Duration.ofSeconds(10));
    }

    ProjectApplicationProbe(KubernetesClient client, String namespace, ProjectRuntimeStore runtime, HttpClient http, Duration budget) {
        if (http.followRedirects() != HttpClient.Redirect.NEVER || http.cookieHandler().isPresent()
            || http.authenticator().isPresent()) throw new IllegalArgumentException("Probe client must not redirect or authenticate");
        this.client = client;
        this.namespace = namespace;
        this.runtime = runtime;
        this.http = http;
        this.budget = budget;
    }

    /** Check actual launch arguments, not mutable System properties read after client initialization. */
    public static void requireStartupConfiguration() {
        var args = java.lang.management.ManagementFactory.getRuntimeMXBean().getInputArguments();
        if (!args.contains("-Djdk.httpclient.redirects.retrylimit=1")
            || !args.contains("-Djdk.httpclient.disableRetryConnect=true")
            || !"1".equals(System.getProperty("jdk.httpclient.redirects.retrylimit"))
            || !"true".equals(System.getProperty("jdk.httpclient.disableRetryConnect"))) {
            throw new IllegalStateException("AI HTTP requires JVM startup options: -Djdk.httpclient.redirects.retrylimit=1 -Djdk.httpclient.disableRetryConnect=true");
        }
    }

    public static HttpClient httpClient() {
        requireStartupConfiguration();
        return HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3))
            .followRedirects(HttpClient.Redirect.NEVER).version(HttpClient.Version.HTTP_1_1)
            .proxy(new ProxySelector() {
                public List<Proxy> select(URI uri) { return List.of(Proxy.NO_PROXY); }
                public void connectFailed(URI uri, SocketAddress address, java.io.IOException failure) { }
            }).build();
    }

    public AgentContracts.AppHttpGetData get(RunRecord run, String path) {
        URI relative;
        try { relative = relativePath(path); }
        catch (IllegalArgumentException ex) { return error(run, "", "VALIDATION_ERROR"); }
        if (!"RUNNING".equals(run.state().name()) || run.firstReadyAt() == null
            || run.executionPodUid() == null || run.executionPodUid().isBlank()) return error(run, path, "AI_RUN_NOT_READY");
        URI target;
        try {
            var spec = runtime.loadSpec(run.projectId());
            if (spec.publicPorts().isEmpty()) return error(run, path, "AI_APP_ROUTE_UNAVAILABLE");
            var primary = spec.publicPorts().get(0);
            var service = client.services().inNamespace(namespace).withName(serviceName(run.projectId())).get();
            if (service == null || service.getMetadata() == null || service.getSpec() == null
                || service.getMetadata().getLabels() == null
                || !run.projectId().equals(service.getMetadata().getLabels().get(LABEL_PROJECT_ID))
                || !"manao-poc4-backend".equals(service.getMetadata().getLabels().get("app.kubernetes.io/managed-by"))
                || !Map.of(LABEL_PROJECT_ID, run.projectId(), LABEL_RUN_ID, run.id(), LABEL_COMPONENT, COMPONENT_VALUE,
                    LABEL_POD_UID, run.executionPodUid()).equals(service.getSpec().getSelector())
                || "ExternalName".equals(service.getSpec().getType())) return error(run, path, "AI_APP_ROUTE_UNAVAILABLE");
            String ip = service.getSpec().getClusterIP();
            if (ip == null || ip.isBlank() || "None".equals(ip)) return error(run, path, "AI_APP_ROUTE_UNAVAILABLE");
            var ports = service.getSpec().getPorts();
            if (ports == null) return error(run, path, "AI_APP_ROUTE_UNAVAILABLE");
            var matches = ports.stream().filter(port -> primary.name().equals(port.getName())).toList();
            if (matches.size() != 1) return error(run, path, "AI_APP_ROUTE_UNAVAILABLE");
            var port = matches.get(0);
            if (!"TCP".equals(port.getProtocol()) || !Integer.valueOf(primary.targetPort()).equals(port.getPort())
                || !Integer.valueOf(primary.publicPort()).equals(port.getNodePort()) || port.getTargetPort() == null
                || !Integer.valueOf(primary.targetPort()).equals(port.getTargetPort().getIntVal())
                || port.getTargetPort().getStrVal() != null) return error(run, path, "AI_APP_ROUTE_UNAVAILABLE");
            // clusterIP is an IP literal from the trusted Service, never a model-supplied host.
            if (!(ip.matches("[0-9.]+") || ip.matches("[0-9a-fA-F:]+"))) return error(run, path, "AI_APP_ROUTE_UNAVAILABLE");
            URI origin = new URI("http", null, ip, port.getPort(), "/", null, null);
            target = origin.resolve(relative);
            if (!origin.getScheme().equals(target.getScheme()) || !origin.getHost().equals(target.getHost())
                || origin.getPort() != target.getPort()) return error(run, path, "VALIDATION_ERROR");
        } catch (Exception ex) { return error(run, path, "AI_APP_ROUTE_UNAVAILABLE"); }

        long deadline = System.nanoTime() + budget.toNanos();
        var subscriber = new BoundedSubscriber();
        CompletableFuture<HttpResponse<BoundedBody>> response = null;
        try {
            var request = HttpRequest.newBuilder(target).timeout(budget)
                .header("Accept", "application/json,text/plain,*/*").GET().build();
            response = http.sendAsync(request, info -> subscriber);
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) throw new TimeoutException();
            var received = response.get(remaining, TimeUnit.NANOSECONDS);
            return new AgentContracts.AppHttpGetData("app_http_get", run.id(), path, received.statusCode(),
                received.headers().firstValue("content-type").orElse(null), received.body().text(), received.body().truncated(), null);
        } catch (Exception ex) {
            if (ex instanceof InterruptedException) Thread.currentThread().interrupt();
            Throwable cause = ex instanceof java.util.concurrent.ExecutionException ? ex.getCause() : ex;
            return error(run, path, cause instanceof TimeoutException || cause instanceof java.net.http.HttpTimeoutException
                ? "AI_APP_HTTP_TIMEOUT" : "AI_APP_HTTP_UNAVAILABLE");
        } finally {
            subscriber.cancel();
            if (response != null && !response.isDone()) response.cancel(true);
        }
    }

    static URI relativePath(String path) {
        if (path == null || path.length() > 2048 || !path.startsWith("/") || path.startsWith("//")
            || path.indexOf('\\') >= 0 || path.chars().anyMatch(Character::isISOControl)) throw new IllegalArgumentException();
        try {
            URI parsed = new URI(path);
            if (parsed.isAbsolute() || parsed.isOpaque() || parsed.getRawAuthority() != null || parsed.getRawFragment() != null)
                throw new IllegalArgumentException();
            return parsed;
        } catch (java.net.URISyntaxException ex) { throw new IllegalArgumentException(); }
    }

    static AgentContracts.AppHttpGetData error(RunRecord run, String path, String code) {
        return new AgentContracts.AppHttpGetData("app_http_get", run.id(), path, null, null, "", false, safeError(code));
    }

    static AgentContracts.ToolError safeError(String code) {
        String message = switch (code) {
            case "VALIDATION_ERROR" -> "Invalid application HTTP arguments";
            case "AI_RUN_NOT_FOUND" -> "Run not found";
            case "AI_RUN_NOT_READY" -> "The application Run is not ready";
            case "AI_APP_ROUTE_UNAVAILABLE" -> "The application route is unavailable";
            case "AI_APP_HTTP_TIMEOUT" -> "Application HTTP timed out";
            case "AI_APP_RUN_CHANGED" -> "The application Run changed during the request";
            default -> { code = "AI_APP_HTTP_UNAVAILABLE"; yield "Application HTTP is unavailable"; }
        };
        return new AgentContracts.ToolError(code, message);
    }

    private record BoundedBody(String text, boolean truncated) { }

    /** Holds only the bounded prefix plus one sentinel; all terminal paths cancel the subscription. */
    private static final class BoundedSubscriber implements HttpResponse.BodySubscriber<BoundedBody> {
        private final CompletableFuture<BoundedBody> body = new CompletableFuture<>();
        private final byte[] bytes = new byte[BODY_BYTES + 1];
        private Flow.Subscription subscription;
        private int size;
        private boolean done;
        public CompletionStage<BoundedBody> getBody() { return body; }
        public synchronized void onSubscribe(Flow.Subscription next) {
            if (done || subscription != null) { next.cancel(); return; }
            subscription = next;
            next.request(1);
        }
        public synchronized void onNext(List<ByteBuffer> buffers) {
            if (done) return;
            for (ByteBuffer buffer : buffers) {
                int copy = Math.min(buffer.remaining(), bytes.length - size);
                buffer.get(bytes, size, copy);
                size += copy;
                if (size > BODY_BYTES) { finish(true); return; }
            }
            subscription.request(1);
        }
        public synchronized void onError(Throwable error) {
            if (done) return;
            done = true;
            body.completeExceptionally(error);
        }
        public synchronized void onComplete() { if (!done) finish(false); }
        private void finish(boolean truncated) {
            done = true;
            if (truncated && subscription != null) subscription.cancel();
            var decoder = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPLACE)
                .onUnmappableCharacter(CodingErrorAction.REPLACE);
            CharBuffer chars = CharBuffer.allocate(BODY_BYTES + 1);
            decoder.decode(ByteBuffer.wrap(bytes, 0, Math.min(size, BODY_BYTES)), chars, !truncated);
            chars.flip();
            String text = chars.toString();
            int end = 0, length = 0;
            while (end < text.length()) {
                int cp = text.codePointAt(end);
                int cost = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
                if (length + cost > BODY_BYTES) break;
                length += cost;
                end += Character.charCount(cp);
            }
            body.complete(new BoundedBody(text.substring(0, end), truncated || end < text.length()));
        }
        synchronized void cancel() {
            done = true;
            if (subscription != null) subscription.cancel();
            if (!body.isDone()) body.cancel(true);
        }
    }
}
