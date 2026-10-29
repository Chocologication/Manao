package com.manao.poc4.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/** Ephemeral display output, independent of task execution and its durable progress. */
public final class AgentLiveOutput implements AutoCloseable {
    static final int MAX_JSON_BYTES = 256 * 1024;
    static final int MAX_SUBSCRIPTIONS = 4;
    static final int MAX_TASK_SUBSCRIPTIONS = 2;
    static final Duration TAIL_TTL = Duration.ofSeconds(60);
    static final Duration HEARTBEAT = Duration.ofSeconds(15);
    static final Duration SEND_DEADLINE = Duration.ofSeconds(2);
    static final Duration LIFETIME = Duration.ofMinutes(30);
    private static final ObjectMapper JSON = new ObjectMapper();
    private final AgentTaskStore tasks;
    private final Clock clock;
    private final Object monitor = new Object();
    private final Map<String, Snapshot> cache = new HashMap<>();
    private final Set<Subscription> subscriptions = new HashSet<>();
    private final ThreadPoolExecutor senders = new ThreadPoolExecutor(MAX_SUBSCRIPTIONS, MAX_SUBSCRIPTIONS,
        0, TimeUnit.MILLISECONDS, new SynchronousQueue<>(), runnable -> {
            var thread = new Thread(runnable, "ai-live-sender"); thread.setDaemon(true); return thread;
        }, new ThreadPoolExecutor.AbortPolicy());
    private final ScheduledExecutorService maintenance = Executors.newScheduledThreadPool(2, runnable -> {
        var thread = new Thread(runnable, "ai-live-maintenance"); thread.setDaemon(true); return thread;
    });
    private long entered;
    private long exited;
    private boolean closed;

    public AgentLiveOutput(AgentTaskStore tasks) { this(tasks, Clock.systemUTC()); }
    AgentLiveOutput(AgentTaskStore tasks, Clock clock) {
        this.tasks = tasks; this.clock = clock;
        maintenance.scheduleWithFixedDelay(this::watchdog, 100, 100, TimeUnit.MILLISECONDS);
        maintenance.scheduleWithFixedDelay(() -> {
            try { refresh(); } catch (RuntimeException ignored) { /* Never log snapshot or raw worker output. */ }
        }, 1, 1, TimeUnit.SECONDS);
    }

    /** Caller has already checked the durable bound worker identity. */
    public void accept(String taskId, JsonNode input) {
        if (input == null || !input.isObject()) throw invalid();
        if (!taskId.equals(input.path("taskId").asText())
                || !tasks.liveOutputConversation(taskId).equals(input.path("conversationId").asText()))
            throw new ApiException("AI_LIVE_MISMATCH", 409, "Live output identity does not match");
        Snapshot snapshot = snapshot(input);
        synchronized (monitor) {
            Map<String, AgentTaskStore.LiveTask> eligible = refreshLocked();
            if (!eligible.containsKey(taskId)) return;
            Snapshot previous = cache.get(taskId);
            if (previous != null && previous.revision >= snapshot.revision) {
                if (previous.revision == snapshot.revision && !previous.json.equals(snapshot.json))
                    throw new ApiException("AI_LIVE_REVISION_MISMATCH", 409, "Live revision already has different content");
                return;
            }
            cache.put(taskId, snapshot);
            for (var subscription : subscriptions)
                if (!subscription.detached && subscription.taskId.equals(taskId)) subscription.latest = snapshot;
            monitor.notifyAll();
        }
    }

    /** Caller has already checked owner/project/task. Null means history-only (204). */
    public SseEmitter subscribe(String taskId) {
        synchronized (monitor) {
            var eligible = refreshLocked();
            var task = eligible.get(taskId);
            if (task == null || (task.terminalAt() != null && !cache.containsKey(taskId))) return null;
            long logical = subscriptions.stream().filter(s -> !s.detached).count();
            long perTask = subscriptions.stream().filter(s -> !s.detached && s.taskId.equals(taskId)).count();
            if (logical >= MAX_SUBSCRIPTIONS || perTask >= MAX_TASK_SUBSCRIPTIONS)
                throw new ApiException("AI_LIVE_SUBSCRIPTION_LIMIT", 429, "Live subscription limit reached");
            if (closed || subscriptions.size() >= MAX_SUBSCRIPTIONS)
                throw new ApiException("AI_LIVE_SENDERS_BUSY", 503, "Live senders are busy");
            var subscription = new Subscription(taskId, cache.get(taskId));
            // Register before sending: Spring callbacks and send share the emitter write lock.
            subscription.emitter.onCompletion(() -> detach(subscription));
            subscription.emitter.onError(error -> detach(subscription));
            subscription.emitter.onTimeout(() -> detach(subscription));
            subscriptions.add(subscription);
            try { senders.execute(() -> run(subscription)); }
            catch (java.util.concurrent.RejectedExecutionException ex) {
                subscriptions.remove(subscription);
                throw new ApiException("AI_LIVE_SENDERS_BUSY", 503, "Live senders are busy");
            }
            return subscription.emitter;
        }
    }

    /** MVC calls this only after its emitter handler is initialized, avoiding early-send accumulation. */
    void ready(SseEmitter emitter) {
        synchronized (monitor) {
            for (var subscription : subscriptions) if (subscription.emitter == emitter) subscription.ready = true;
            monitor.notifyAll();
        }
    }

    private void run(Subscription subscription) {
        boolean ioFailure = false;
        try {
            while (true) {
                Snapshot next;
                synchronized (monitor) {
                    while (!subscription.detached && (!subscription.ready
                            || (subscription.latest == null && System.nanoTime() < subscription.nextHeartbeat)))
                        monitor.wait(100);
                    if (subscription.detached) return;
                    next = subscription.latest;
                    subscription.latest = null;
                    subscription.sendingSince = System.nanoTime();
                    entered++;
                }
                try {
                    if (next == null) subscription.emitter.send(SseEmitter.event().comment("heartbeat"));
                    else subscription.emitter.send(SseEmitter.event().name("snapshot").data(next.json));
                } finally {
                    synchronized (monitor) {
                        subscription.sendingSince = 0;
                        subscription.nextHeartbeat = System.nanoTime() + HEARTBEAT.toNanos();
                        exited++;
                    }
                }
            }
        } catch (IOException ex) { ioFailure = true; }
        catch (InterruptedException ex) { Thread.currentThread().interrupt(); }
        catch (RuntimeException ignored) { ioFailure = true; /* Container owns a failed/closed response. */ }
        finally {
            detach(subscription);
            try {
                // IOException belongs to Spring/container error cleanup; never race completeWithError.
                if (!ioFailure) subscription.emitter.complete();
            } finally {
                synchronized (monitor) { subscriptions.remove(subscription); monitor.notifyAll(); }
            }
        }
    }

    private void detach(Subscription subscription) {
        synchronized (monitor) {
            subscription.detached = true; subscription.latest = null; monitor.notifyAll();
        }
    }
    private void watchdog() {
        synchronized (monitor) {
            long now = System.nanoTime();
            for (var subscription : subscriptions)
                if (now - subscription.created >= LIFETIME.toNanos()
                        || (subscription.sendingSince != 0 && now - subscription.sendingSince >= SEND_DEADLINE.toNanos()))
                    detach(subscription);
        }
    }
    void refresh() { synchronized (monitor) { refreshLocked(); } }
    private Map<String, AgentTaskStore.LiveTask> refreshLocked() {
        Map<String, AgentTaskStore.LiveTask> eligible = new HashMap<>();
        for (var task : tasks.liveOutputTasks())
            if (task.terminalAt() == null || clock.instant().isBefore(task.terminalAt().plus(TAIL_TTL)))
                eligible.put(task.taskId(), task);
        cache.keySet().removeIf(id -> !eligible.containsKey(id));
        for (var subscription : subscriptions) if (!eligible.containsKey(subscription.taskId)) detach(subscription);
        return eligible;
    }

    private static Snapshot snapshot(JsonNode input) {
        fields(input, Set.of("revision", "taskId", "conversationId", "durableHeadSeq", "current", "unavailable"));
        positive(input.get("revision"), 0); positive(input.get("durableHeadSeq"), 0);
        if (!input.get("unavailable").isBoolean()) throw invalid();
        var current = input.get("current");
        if (!current.isNull()) {
            fields(current, Set.of("messageOrdinal", "phase", "blocks", "modelTruncated", "displayTruncated"));
            positive(current.get("messageOrdinal"), 1);
            if (!Set.of("generating", "ended").contains(current.get("phase").asText())
                    || !current.get("modelTruncated").isBoolean() || !current.get("displayTruncated").isBoolean()
                    || !current.get("blocks").isArray()) throw invalid();
            long previous = -1;
            for (var block : current.get("blocks")) {
                fields(block, Set.of("contentIndex", "kind", "text"));
                positive(block.get("contentIndex"), 0);
                long index = block.get("contentIndex").asLong();
                if (index <= previous || !Set.of("thinking", "text").contains(block.get("kind").asText())
                        || !block.get("text").isTextual()) throw invalid();
                previous = index;
            }
        }
        try {
            byte[] bytes = JSON.writeValueAsBytes(input);
            if (bytes.length > MAX_JSON_BYTES) throw new ApiException("AI_LIVE_TOO_LARGE", 413, "Live snapshot is too large");
            return new Snapshot(input.get("revision").asLong(), new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) { throw invalid(); }
    }
    private static void fields(JsonNode value, Set<String> names) {
        if (value == null || !value.isObject() || value.size() != names.size()) throw invalid();
        var fields = value.fieldNames();
        while (fields.hasNext()) if (!names.contains(fields.next())) throw invalid();
    }
    private static void positive(JsonNode value, long minimum) {
        if (!value.isIntegralNumber() || !value.canConvertToLong() || value.asLong() < minimum
                || value.asLong() > 9007199254740991L) throw invalid();
    }
    private static ApiException invalid() { return new ApiException("VALIDATION_ERROR", 422, "Request validation failed"); }
    record Diagnostics(int cachedTasks, int subscriptions, int resources, int pending, int sending, int detached, long entered, long exited) { }
    Diagnostics diagnostics() {
        synchronized (monitor) {
            return new Diagnostics(cache.size(), (int) subscriptions.stream().filter(s -> !s.detached).count(),
                subscriptions.size(), (int) subscriptions.stream().filter(s -> s.latest != null).count(),
                (int) subscriptions.stream().filter(s -> s.sendingSince != 0).count(),
                (int) subscriptions.stream().filter(s -> s.detached).count(), entered, exited);
        }
    }
    private record Snapshot(long revision, String json) { }
    private static final class Subscription {
        final String taskId;
        final SseEmitter emitter = new SseEmitter(LIFETIME.toMillis());
        final long created = System.nanoTime();
        Snapshot latest;
        boolean ready;
        boolean detached;
        long sendingSince;
        long nextHeartbeat;
        Subscription(String taskId, Snapshot initial) { this.taskId = taskId; this.latest = initial; }
    }
    @Override public void close() {
        synchronized (monitor) { closed = true; for (var subscription : subscriptions) detach(subscription); }
        maintenance.shutdownNow();
        // A blocked socket retains its actual thread; no replacement or fictitious release.
        senders.shutdown();
    }
}
