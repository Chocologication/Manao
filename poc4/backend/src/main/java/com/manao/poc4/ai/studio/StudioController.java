package com.manao.poc4.ai.studio;

import static com.manao.poc4.ai.studio.StudioContracts.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.auth.AuthContracts;
import com.manao.poc4.auth.UserStore;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.List;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.context.annotation.Conditional;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.AsyncHandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@Conditional({com.manao.poc4.config.SecurityConfig.BackendAuthCondition.class, com.manao.poc4.config.AiConfig.AiEnabledCondition.class})
@RequestMapping("/api/v1")
public final class StudioController implements WebMvcConfigurer, AutoCloseable {
    private final StudioStore store;
    private final StudioService service;
    private final StudioModelStore models;
    private final StudioAttachments attachments;
    private final StudioApply apply;
    private final UserStore users;
    private final ThreadPoolExecutor streams = new ThreadPoolExecutor(0, 8, 30, TimeUnit.SECONDS, new SynchronousQueue<>(), r -> { var t = new Thread(r, "assistant-events"); t.setDaemon(true); return t; });
    private final java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicInteger> subscriptions = new java.util.concurrent.ConcurrentHashMap<>();
    private static final String READY = StudioController.class.getName() + ".ready";
    public StudioController(StudioStore store, StudioService service, StudioModelStore models, StudioAttachments attachments, StudioApply apply, UserStore users) {
        this.store = store; this.service = service; this.models = models; this.attachments = attachments; this.apply = apply; this.users = users;
    }
    @GetMapping("/assistant/models") public List<ModelView> models(Authentication auth) { return models.list(auth.getName()); }
    @PostMapping("/assistant/models") public ModelView save(Authentication auth, @RequestBody ModelInput input) { return models.save(auth.getName(), input); }
    @DeleteMapping("/assistant/models/{id}") public void delete(Authentication auth, @PathVariable String id) { models.delete(auth.getName(), id); }
    @GetMapping("/projects/{project}/assistant/conversations") public List<Conversation> conversations(Authentication auth, @PathVariable String project) { return store.conversations(auth.getName(), project); }
    @PostMapping("/projects/{project}/assistant/conversations/{conversation}") public Conversation create(Authentication auth, @PathVariable String project, @PathVariable String conversation) { return store.create(auth.getName(), project, conversation); }
    @GetMapping("/projects/{project}/assistant/conversations/{conversation}/turns") public List<ObjectNode> turns(Authentication auth, @PathVariable String project, @PathVariable String conversation) {
        var result = service.turns(auth.getName(), project, conversation);
        for (var turn : result) turn.set("application", apply.status(auth.getName(), project, turn.path("id").asText()));
        return result;
    }
    @PostMapping("/projects/{project}/assistant/conversations/{conversation}/turns") public ObjectNode start(Authentication auth, @PathVariable String project, @PathVariable String conversation, @RequestBody TurnInput input) { return service.start(auth.getName(), project, conversation, input); }
    @GetMapping("/projects/{project}/assistant/turns/{turn}") public ObjectNode turn(Authentication auth, @PathVariable String project, @PathVariable String turn) { return service.get(auth.getName(), project, turn).set("application", apply.status(auth.getName(), project, turn)); }
    @PostMapping("/projects/{project}/assistant/turns/{turn}/stop") public ObjectNode stop(Authentication auth, @PathVariable String project, @PathVariable String turn) { return service.stop(auth.getName(), project, turn); }
    @PostMapping("/projects/{project}/assistant/turns/{turn}/apply") public ObjectNode apply(Authentication auth, @PathVariable String project, @PathVariable String turn, @RequestBody ApplyInput input) { return apply.apply(auth.getName(), project, turn, input); }
    @GetMapping("/projects/{project}/assistant/applications/pending") public List<ObjectNode> pending(Authentication auth, @PathVariable String project) { return apply.pending(auth.getName(), project); }
    @PostMapping("/projects/{project}/assistant/attachments") public Attachment upload(Authentication auth, @PathVariable String project, @RequestBody Upload input) { return attachments.upload(auth.getName(), project, input); }
    @GetMapping("/projects/{project}/assistant/attachments/{id}") public ResponseEntity<byte[]> download(Authentication auth, @PathVariable String project, @PathVariable String id) {
        var data = attachments.get(auth.getName(), project, id);
        return ResponseEntity.ok().header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff")
            .header("Content-Disposition", org.springframework.http.ContentDisposition.attachment().filename(data.view().name(), java.nio.charset.StandardCharsets.UTF_8).build().toString())
            .contentType(org.springframework.http.MediaType.parseMediaType(data.view().mediaType())).body(data.body());
    }
    @GetMapping(value = "/projects/{project}/assistant/turns/{turn}/events", produces = "text/event-stream")
    public ResponseEntity<SseEmitter> events(Authentication auth, @PathVariable String project, @PathVariable String turn, HttpServletRequest request, HttpServletResponse response) {
        service.get(auth.getName(), project, turn);
        // The async interceptor flushes before ResponseEntity headers are applied.
        response.setContentType("text/event-stream;charset=UTF-8");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Accel-Buffering", "no");
        var identity = AuthContracts.identity(auth); var counter = subscriptions.computeIfAbsent(identity.userId(), ignored -> new java.util.concurrent.atomic.AtomicInteger());
        if (counter.incrementAndGet() > 2) { counter.decrementAndGet(); throw new ApiException("AI_BUSY", 429, "Too many live conversations"); }
        var emitter = new SseEmitter(30000L); var closed = new AtomicBoolean();
        Runnable cleanup = () -> { if (closed.compareAndSet(false, true)) counter.decrementAndGet(); };
        emitter.onCompletion(cleanup); emitter.onTimeout(cleanup); emitter.onError(ex -> cleanup.run());
        var ready = new java.util.concurrent.CountDownLatch(1); request.setAttribute(READY, ready);
        try { streams.execute(() -> {
            try {
                if (!ready.await(5, TimeUnit.SECONDS)) return;
                long version = -1; long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(25);
                while (!closed.get() && System.nanoTime() < until) {
                    var account = users.findById(identity.userId());
                    if (account.isEmpty() || !account.get().enabled() || account.get().authVersion() != identity.authVersion()) { emitter.send(SseEmitter.event().name("auth.revoked").data("{}")); break; }
                    var data = service.get(identity.userId(), project, turn);
                    if (data.path("version").asLong() != version) {
                        version = data.path("version").asLong(); emitter.send(SseEmitter.event().id(Long.toString(version)).name("snapshot").data(data));
                    }
                    if (!List.of("RUNNING", "STOPPING", "ATTENTION").contains(data.path("state").asText())) break;
                    Thread.sleep(250);
                }
                emitter.complete();
            } catch (Exception ex) { emitter.completeWithError(ex); }
            finally { cleanup.run(); }
        }); } catch (java.util.concurrent.RejectedExecutionException busy) { cleanup.run(); throw new ApiException("AI_BUSY", 503, "Live senders are busy"); }
        return ResponseEntity.ok().header("Cache-Control", "no-store").header("X-Accel-Buffering", "no").body(emitter);
    }
    @Override public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new AsyncHandlerInterceptor() {
            @Override public void afterConcurrentHandlingStarted(HttpServletRequest request, HttpServletResponse response, Object handler) throws java.io.IOException {
                if (request.getAttribute(READY) instanceof java.util.concurrent.CountDownLatch ready) { response.flushBuffer(); ready.countDown(); }
            }
        }).addPathPatterns("/api/v1/projects/*/assistant/turns/*/events");
    }
    @ExceptionHandler(org.springframework.web.context.request.async.AsyncRequestNotUsableException.class) public void disconnected() { }
    @Override public void close() { streams.shutdownNow(); }
}
