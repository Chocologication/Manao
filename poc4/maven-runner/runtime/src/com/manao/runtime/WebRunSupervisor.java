package com.manao.runtime;

import java.io.File;
import java.io.IOException;
import java.io.Reader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * PID 1 supervisor for a single web run.
 *
 * <p>Production modes (the only entry points):</p>
 * <ul>
 *   <li>{@code run} — verifies it is PID 1, atomically claims
 *       {@code $MANAO_RUN_CONTROL_DIR/claim} (an existing claim means the run already
 *       started: exit 125 before any user code, and the claim is never cleared), spawns
 *       the fixed {@code manao-maven} wrapper child (cache initialization + exec
 *       {@code mvn -q -DskipTests spring-boot:run}) in /workspace with
 *       inherited stdout/stderr, polls the loopback primary-port readiness endpoint with
 *       bounded timeouts and, on the first UP, arms the monotonic lifetime deadline and
 *       then writes the run receipt. Exit codes: 0 user stop, 1 unexpected application
 *       exit, 2 configuration error, 3 persistence/internal failure, 124 lifetime
 *       expiry, 125 duplicate claim, 126 startup budget exhausted.</li>
 *   <li>{@code probe} — readiness-probe helper (exec child, no PID 1 requirement):
 *       checks the local ready marker, the receipt expiry and the current primary-port
 *       health; exit 0 only when all three hold.</li>
 * </ul>
 *
 * <p>Timing rules: the lifetime deadline is enforced by a dedicated thread that does
 * nothing but a monotonic check and {@link Runtime#halt(int)} — no network or disk wait
 * ever sits on that path, so derived processes are reaped with PID 1 even if they ignore
 * SIGTERM (independent PID namespace). Receipts on the possibly-NFS control directory
 * are written off the deadline thread with a bounded budget through temp-file + atomic
 * rename; if persistence fails the run is not published ready and ends fail-closed. A
 * SIGTERM stop stays inside a graceful window that never crosses the armed deadline.
 * Slightly before expiry the terminal TIMED_OUT evidence is pre-written; consumers must
 * verify the real exit facts and must not treat a pre-written message as proof of
 * exit.</p>
 *
 * <p>The receipt and termination-message protocol is a fixed allowlist
 * (protocol/projectId/runId/podUid/state/firstReadyAt/expiresAt/reason) with
 * state in {CLAIMED, READY, EXITED, TIMED_OUT, STARTUP_TIMED_OUT, DENIED}; no commands,
 * credentials or logs are recorded. Receipts on the shared control directory are only
 * written by the claim owner — a denied replacement container reports DENIED through its
 * container-local termination message only.</p>
 *
 * <p>{@link #runMode(List)} is a package-private seam used exclusively by the test
 * fixture compiled into the {@code runtime-test} image stage; the production main always
 * passes the fixed maven command and no command can be injected via the environment.</p>
 */
public final class WebRunSupervisor {

    static final String PROTOCOL = "1";
    static final String READINESS_PATH = "/actuator/health/readiness";
    /**
     * The supervised child is the root-owned fixed Maven wrapper: it initializes the
     * project's persistent Maven cache (inside the startup budget) and then execs
     * {@code mvn -q -DskipTests spring-boot:run}. Only the first item changed from the
     * former direct {@code mvn} spawn; stop, kill and deadline semantics are unchanged
     * because the wrapper execs Maven in the same process.
     */
    static final List<String> FIXED_RUN_COMMAND =
            List.of("/usr/local/bin/manao-maven", "-q", "-DskipTests", "spring-boot:run");
    static final String RUN_WORKING_DIR = "/workspace";

    static final String RECEIPT_FILE_NAME = "receipt.properties";
    static final String CLAIM_DIR_NAME = "claim";
    static final String CLAIM_OWNER_FILE_NAME = "owner";
    static final String LOCAL_PROBE_FILE = "/tmp/manao-runtime.properties";
    static final String TERMINATION_FILE = "/tmp/manao-termination.log";
    static final int TERMINATION_MAX_BYTES = 2048;

    static final String STATE_CLAIMED = "CLAIMED";
    static final String STATE_READY = "READY";
    static final String STATE_EXITED = "EXITED";
    static final String STATE_TIMED_OUT = "TIMED_OUT";
    static final String STATE_STARTUP_TIMED_OUT = "STARTUP_TIMED_OUT";
    static final String STATE_DENIED = "DENIED";

    static final String REASON_TIME_LIMIT_EXCEEDED = "TIME_LIMIT_EXCEEDED";
    static final String REASON_STARTUP_TIME_LIMIT_EXCEEDED = "STARTUP_TIME_LIMIT_EXCEEDED";
    static final String REASON_APPLICATION_EXITED = "APPLICATION_EXITED";
    static final String REASON_USER_STOPPED = "USER_STOPPED";
    static final String REASON_RUN_ALREADY_CLAIMED = "RUN_ALREADY_CLAIMED";
    static final String REASON_RECEIPT_WRITE_FAILED = "RECEIPT_WRITE_FAILED";
    static final String REASON_CLAIM_WRITE_FAILED = "CLAIM_WRITE_FAILED";
    static final String REASON_CLAIM_OWNER_WRITE_FAILED = "CLAIM_OWNER_WRITE_FAILED";
    static final String REASON_SPAWN_FAILED = "SPAWN_FAILED";
    static final String REASON_CONFIGURATION_ERROR = "CONFIGURATION_ERROR";
    static final String REASON_SUPERVISOR_NOT_PID1 = "SUPERVISOR_NOT_PID1";
    static final String REASON_SUPERVISOR_ERROR = "SUPERVISOR_ERROR";

    static final int EXIT_OK = 0;                    // graceful user stop
    static final int EXIT_APPLICATION_EXITED = 1;    // unexpected application exit
    static final int EXIT_CONFIGURATION = 2;         // not PID 1 / missing or invalid env
    static final int EXIT_PERSISTENCE = 3;           // claim/record I/O failure, fail-closed
    static final int EXIT_LIFETIME_EXPIRED = 124;
    static final int EXIT_CLAIM_DENIED = 125;
    static final int EXIT_STARTUP_EXPIRED = 126;

    static final Duration RECEIPT_WRITE_BUDGET = Duration.ofSeconds(5);
    static final Duration PREWRITE_RECEIPT_BUDGET = Duration.ofSeconds(1);
    static final Duration READINESS_POLL_INTERVAL = Duration.ofMillis(500);
    static final Duration READINESS_HTTP_TIMEOUT = Duration.ofMillis(900);
    static final Duration READINESS_CONNECT_TIMEOUT = Duration.ofMillis(500);
    static final Duration CHILD_TERM_GRACE = Duration.ofSeconds(10);
    static final Duration KILL_FOLLOWUP_WAIT = Duration.ofSeconds(1);
    static final Duration EXPIRY_PREWRITE_MARGIN = Duration.ofMillis(1500);
    static final Duration MONITOR_TICK = Duration.ofMillis(100);
    static final Duration DEADLINE_TICK = Duration.ofMillis(100);

    private static final HttpClient READY_HTTP = HttpClient.newBuilder()
            .connectTimeout(READINESS_CONNECT_TIMEOUT)
            .build();

    /** Bounded, single-writer executor for control-directory (possibly NFS) I/O. */
    private static final ExecutorService CONTROL_IO = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "manao-control-writer");
        thread.setDaemon(true);
        return thread;
    });

    private record Config(String projectId, String runId, String podUid, int primaryPort,
                          Instant startupDeadlineUtc, Duration lifetime, Path controlDir) {

        static Config fromEnv() {
            Map<String, String> env = System.getenv();
            String projectId = requiredEnv(env, "MANAO_PROJECT_ID");
            String runId = requiredEnv(env, "MANAO_RUN_ID");
            String podUid = requiredEnv(env, "MANAO_POD_UID");
            Instant startupDeadline =
                    Instant.parse(requiredEnv(env, "MANAO_RUN_STARTUP_DEADLINE"));
            int port = Integer.parseInt(requiredEnv(env, "MANAO_PRIMARY_PORT"));
            if (port < 1 || port > 65535) {
                throw new IllegalArgumentException("MANAO_PRIMARY_PORT out of range: " + port);
            }
            Duration lifetime = Duration.ofSeconds(
                    Long.parseLong(requiredEnv(env, "MANAO_SERVICE_LIFETIME_SECONDS")));
            if (lifetime.isNegative() || lifetime.isZero()) {
                throw new IllegalArgumentException("MANAO_SERVICE_LIFETIME_SECONDS must be positive");
            }
            Path controlDir = Path.of(env.getOrDefault("MANAO_RUN_CONTROL_DIR", "/run-control"));
            return new Config(projectId, runId, podUid, port, startupDeadline, lifetime, controlDir);
        }

        private static String requiredEnv(Map<String, String> env, String key) {
            String value = env.get(key);
            if (value == null || value.isBlank()) {
                throw new IllegalArgumentException("missing environment variable " + key);
            }
            return value.trim();
        }
    }

    private enum KillMode {
        /** SIGTERM, wait up to the caller's grace, then SIGKILL. */
        GRACEFUL,
        /** SIGKILL immediately (startup budget exhausted / internal failure). */
        IMMEDIATE
    }

    /** The spawned user-code child process and its bounded termination. */
    private static final class Child {
        private volatile Process process;

        void start(List<String> command) throws IOException {
            this.process = new ProcessBuilder(command)
                    .directory(new File(RUN_WORKING_DIR))
                    .inheritIO()
                    .start();
        }

        boolean alive() {
            Process p = process;
            return p != null && p.isAlive();
        }

        void killGracefully(Duration grace) {
            Process p = process;
            if (p == null || !p.isAlive()) {
                return;
            }
            p.destroy();
            waitForDeath(p, grace);
            if (p.isAlive()) {
                p.destroyForcibly();
                waitForDeath(p, KILL_FOLLOWUP_WAIT);
            }
        }

        void killImmediately() {
            Process p = process;
            if (p == null || !p.isAlive()) {
                return;
            }
            p.destroyForcibly();
            waitForDeath(p, KILL_FOLLOWUP_WAIT);
        }

        private static void waitForDeath(Process p, Duration budget) {
            long deadline = System.nanoTime() + budget.toNanos();
            while (p.isAlive() && System.nanoTime() < deadline) {
                sleepUnchecked(Duration.ofMillis(50));
            }
        }
    }

    private final Config cfg;
    private final RunDeadline deadline;
    private final Child child;
    private volatile Instant firstReadyAt;
    private volatile Instant expiresAt;
    private boolean finished;            // guarded by this
    private int finalExitCode = EXIT_OK; // guarded by this

    private WebRunSupervisor(Config cfg, RunDeadline deadline, Child child) {
        this.cfg = cfg;
        this.deadline = deadline;
        this.child = child;
    }

    public static void main(String[] args) {
        String mode = args.length == 0 ? "" : args[0];
        int code;
        if ("run".equals(mode)) {
            code = runMode(FIXED_RUN_COMMAND);
        } else if ("probe".equals(mode)) {
            code = probe();
        } else {
            System.err.println("usage: manao-run-supervisor run|probe");
            code = EXIT_CONFIGURATION;
        }
        System.exit(code);
    }

    // ------------------------------------------------------------------ run mode

    /**
     * Runs the full supervised lifecycle. Package-private seam: the production main
     * passes {@link #FIXED_RUN_COMMAND}; only the runtime-test fixture passes anything
     * else (this class is never invoked with a test command outside the test image).
     */
    static int runMode(List<String> childCommand) {
        Child child = new Child();
        Config cfg = null;
        try {
            if (ProcessHandle.current().pid() != 1) {
                writeLocalEvidence(null, null, null,
                        STATE_EXITED, REASON_SUPERVISOR_NOT_PID1, null, null);
                return EXIT_CONFIGURATION;
            }
            try {
                cfg = Config.fromEnv();
            } catch (RuntimeException e) {
                writeLocalEvidence(null, null, null,
                        STATE_EXITED, REASON_CONFIGURATION_ERROR, null, null);
                return EXIT_CONFIGURATION;
            }
            Integer claimFailure = claim(cfg);
            if (claimFailure != null) {
                return claimFailure;
            }
            WebRunSupervisor run = new WebRunSupervisor(cfg, new RunDeadline(), child);
            run.installShutdownHook();
            run.startDeadlineThread();
            return run.supervise(childCommand);
        } catch (Throwable t) {
            // Fail closed within a bounded budget; evidence is best-effort.
            child.killImmediately();
            writeLocalEvidence(
                    cfg == null ? null : cfg.projectId(),
                    cfg == null ? null : cfg.runId(),
                    cfg == null ? null : cfg.podUid(),
                    STATE_EXITED, REASON_SUPERVISOR_ERROR, null, null);
            return EXIT_PERSISTENCE;
        }
    }

    /**
     * Atomic claim + owner record + CLAIMED receipt. Everything here happens before any
     * user code can start. Returns the exit code to end with, or {@code null} when the
     * claim is fully held.
     */
    private static Integer claim(Config cfg) {
        Path claimDir = cfg.controlDir().resolve(CLAIM_DIR_NAME);
        try {
            Files.createDirectory(claimDir);
        } catch (FileAlreadyExistsException e) {
            // The run was already claimed (replacement pod or container restart): deny
            // before any user code starts. Never touch the shared receipt — the owner
            // may still be running; report DENIED via the local termination message.
            writeLocalEvidence(cfg.projectId(), cfg.runId(), cfg.podUid(),
                    STATE_DENIED, REASON_RUN_ALREADY_CLAIMED, null, null);
            return EXIT_CLAIM_DENIED;
        } catch (IOException e) {
            writeLocalEvidence(cfg.projectId(), cfg.runId(), cfg.podUid(),
                    STATE_EXITED, REASON_CLAIM_WRITE_FAILED, null, null);
            return EXIT_PERSISTENCE;
        }
        if (!boundedWrite(claimDir.resolve(CLAIM_OWNER_FILE_NAME),
                cfg.podUid() + "\n", RECEIPT_WRITE_BUDGET)) {
            // The claim stays (never cleared on failure) so no rerun can happen.
            writeLocalEvidence(cfg.projectId(), cfg.runId(), cfg.podUid(),
                    STATE_EXITED, REASON_CLAIM_OWNER_WRITE_FAILED, null, null);
            return EXIT_PERSISTENCE;
        }
        if (!writeReceipt(cfg.controlDir(), cfg.projectId(), cfg.runId(), cfg.podUid(),
                STATE_CLAIMED, null, null, "", RECEIPT_WRITE_BUDGET)) {
            writeLocalEvidence(cfg.projectId(), cfg.runId(), cfg.podUid(),
                    STATE_EXITED, REASON_RECEIPT_WRITE_FAILED, null, null);
            return EXIT_PERSISTENCE;
        }
        writeProbeState(cfg.projectId(), cfg.runId(), cfg.podUid(),
                STATE_CLAIMED, "", null, null);
        return null;
    }

    private int supervise(List<String> childCommand) {
        try {
            return superviseInner(childCommand);
        } catch (Throwable t) {
            return finishAndExit(STATE_EXITED, REASON_SUPERVISOR_ERROR,
                    EXIT_PERSISTENCE, KillMode.IMMEDIATE);
        }
    }

    private int superviseInner(List<String> childCommand) throws IOException {
        long startupDeadlineNanos = System.nanoTime()
                + Duration.between(Instant.now(), cfg.startupDeadlineUtc()).toNanos();
        if (System.nanoTime() >= startupDeadlineNanos) {
            // Startup budget from Run.createdAt is already spent: never start user code.
            return finishAndExit(STATE_STARTUP_TIMED_OUT, REASON_STARTUP_TIME_LIMIT_EXCEEDED,
                    EXIT_STARTUP_EXPIRED, KillMode.IMMEDIATE);
        }
        try {
            child.start(childCommand);
        } catch (IOException e) {
            return finishAndExit(STATE_EXITED, REASON_SPAWN_FAILED,
                    EXIT_PERSISTENCE, KillMode.IMMEDIATE);
        }

        // Readiness phase: bounded HTTP polls; child death and the startup deadline are
        // checked between polls.
        while (true) {
            if (!child.alive()) {
                return finishAndExit(STATE_EXITED, REASON_APPLICATION_EXITED,
                        EXIT_APPLICATION_EXITED, KillMode.GRACEFUL);
            }
            if (System.nanoTime() >= startupDeadlineNanos) {
                return finishAndExit(STATE_STARTUP_TIMED_OUT,
                        REASON_STARTUP_TIME_LIMIT_EXCEEDED, EXIT_STARTUP_EXPIRED,
                        KillMode.IMMEDIATE);
            }
            if (readinessUp(cfg.primaryPort())) {
                break;
            }
            sleepUnchecked(READINESS_POLL_INTERVAL);
        }

        // First UP: arm the deadline FIRST, then persist.
        Instant readyAt = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        deadline.ready(readyAt, System.nanoTime(), cfg.lifetime());
        firstReadyAt = readyAt;
        expiresAt = deadline.expiresAt();
        if (!writeReceipt(cfg.controlDir(), cfg.projectId(), cfg.runId(), cfg.podUid(),
                STATE_READY, readyAt, deadline.expiresAt(), "", RECEIPT_WRITE_BUDGET)) {
            // Never publish ready without persisted evidence; end fail-closed.
            return finishAndExit(STATE_EXITED, REASON_RECEIPT_WRITE_FAILED,
                    EXIT_PERSISTENCE, KillMode.GRACEFUL);
        }
        writeProbeState(cfg.projectId(), cfg.runId(), cfg.podUid(),
                STATE_READY, "", readyAt, deadline.expiresAt());

        // Lifetime phase.
        boolean expiryEvidenceWritten = false;
        while (true) {
            if (!child.alive()) {
                return finishAndExit(STATE_EXITED, REASON_APPLICATION_EXITED,
                        EXIT_APPLICATION_EXITED, KillMode.GRACEFUL);
            }
            long now = System.nanoTime();
            if (deadline.expired(now)) {
                Runtime.getRuntime().halt(EXIT_LIFETIME_EXPIRED);
            }
            if (!expiryEvidenceWritten
                    && now >= deadline.monotonicDeadlineNanos() - EXPIRY_PREWRITE_MARGIN.toNanos()) {
                prewriteExpiryEvidence();
                expiryEvidenceWritten = true;
            }
            sleepUnchecked(MONITOR_TICK);
        }
    }

    /** Pre-writes the terminal TIMED_OUT evidence just before the deadline hits. */
    private void prewriteExpiryEvidence() {
        synchronized (this) {
            if (finished) {
                return;
            }
            writeProbeState(cfg.projectId(), cfg.runId(), cfg.podUid(),
                    STATE_TIMED_OUT, REASON_TIME_LIMIT_EXCEEDED, firstReadyAt, expiresAt);
            writeTerminationMessage(cfg.projectId(), cfg.runId(), cfg.podUid(),
                    STATE_TIMED_OUT, REASON_TIME_LIMIT_EXCEEDED, firstReadyAt, expiresAt);
            writeReceipt(cfg.controlDir(), cfg.projectId(), cfg.runId(), cfg.podUid(),
                    STATE_TIMED_OUT, firstReadyAt, expiresAt, REASON_TIME_LIMIT_EXCEEDED,
                    PREWRITE_RECEIPT_BUDGET);
        }
    }

    /**
     * Records the terminal transition exactly once and returns its exit code, or -1 when
     * another thread already recorded it. All terminal evidence is written while holding
     * the monitor so concurrent transitions cannot interleave.
     */
    private synchronized int finish(String state, String reason, int exitCode, KillMode killMode) {
        if (finished) {
            return -1;
        }
        finished = true;
        finalExitCode = exitCode;
        if (killMode == KillMode.IMMEDIATE) {
            child.killImmediately();
        } else {
            child.killGracefully(gracefulStopGrace());
        }
        writeProbeState(cfg.projectId(), cfg.runId(), cfg.podUid(),
                state, reason, firstReadyAt, expiresAt);
        writeTerminationMessage(cfg.projectId(), cfg.runId(), cfg.podUid(),
                state, reason, firstReadyAt, expiresAt);
        writeReceipt(cfg.controlDir(), cfg.projectId(), cfg.runId(), cfg.podUid(),
                state, firstReadyAt, expiresAt, reason, RECEIPT_WRITE_BUDGET);
        return exitCode;
    }

    private int finishAndExit(String state, String reason, int exitCode, KillMode killMode) {
        int decided = finish(state, reason, exitCode, killMode);
        if (decided >= 0) {
            return decided; // caller System.exit()s it; the hook then halts with this code
        }
        parkUntilHalt(); // another thread owns the terminal transition and will halt
        return decided;  // unreachable
    }

    /** Graceful SIGTERM window, never crossing the armed lifetime deadline. */
    private Duration gracefulStopGrace() {
        if (!deadline.armed()) {
            return CHILD_TERM_GRACE;
        }
        long remaining = deadline.monotonicDeadlineNanos() - System.nanoTime();
        if (remaining <= 0) {
            return Duration.ZERO;
        }
        return remaining < CHILD_TERM_GRACE.toNanos()
                ? Duration.ofNanos(remaining)
                : CHILD_TERM_GRACE;
    }

    private void installShutdownHook() {
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            int decided = finish(STATE_EXITED, REASON_USER_STOPPED, EXIT_OK, KillMode.GRACEFUL);
            Runtime.getRuntime().halt(decided >= 0 ? decided : recordedExitCode());
        }, "manao-stop-hook"));
    }

    private synchronized int recordedExitCode() {
        return finished ? finalExitCode : EXIT_OK;
    }

    /**
     * Independent deadline thread: nothing but a monotonic check and halt — the core
     * time-limit path contains no network or disk wait and can never be blocked by
     * receipt I/O. Non-daemon so the lifetime stays enforced even if every other thread
     * died.
     */
    private void startDeadlineThread() {
        Thread thread = new Thread(() -> {
            while (true) {
                if (deadline.expired(System.nanoTime())) {
                    Runtime.getRuntime().halt(EXIT_LIFETIME_EXPIRED);
                }
                sleepUnchecked(DEADLINE_TICK);
            }
        }, "manao-lifetime-deadline");
        thread.setDaemon(false);
        thread.start();
    }

    /** Park until another thread's terminal transition halts the JVM. */
    private static void parkUntilHalt() {
        while (true) {
            sleepUnchecked(Duration.ofSeconds(1));
        }
    }

    // --------------------------------------------------------------------- probe

    /** Readiness-probe helper: ready marker + not expired + current primary port UP. */
    static int probe() {
        try {
            Properties local = new Properties();
            try (Reader reader = Files.newBufferedReader(Path.of(LOCAL_PROBE_FILE), StandardCharsets.UTF_8)) {
                local.load(reader);
            }
            if (!STATE_READY.equals(local.getProperty("state"))) {
                return 1;
            }
            Instant expiry = Instant.parse(local.getProperty("expiresAt"));
            if (!Instant.now().isBefore(expiry)) {
                return 1;
            }
            int port = Integer.parseInt(System.getenv().getOrDefault("MANAO_PRIMARY_PORT", "").trim());
            return readinessUp(port) ? 0 : 1;
        } catch (Exception e) {
            return 1;
        }
    }

    private static boolean readinessUp(int port) {
        try {
            HttpRequest request = HttpRequest
                    .newBuilder(URI.create("http://127.0.0.1:" + port + READINESS_PATH))
                    .timeout(READINESS_HTTP_TIMEOUT)
                    .GET()
                    .build();
            HttpResponse<Void> response =
                    READY_HTTP.send(request, HttpResponse.BodyHandlers.discarding());
            return response.statusCode() / 100 == 2;
        } catch (Exception e) {
            return false;
        }
    }

    // ------------------------------------------------------------------ evidence

    private static boolean writeReceipt(Path controlDir, String projectId, String runId,
                                        String podUid, String state, Instant firstReadyAt,
                                        Instant expiresAt, String reason, Duration budget) {
        String content = receiptContent(projectId, runId, podUid, state,
                firstReadyAt, expiresAt, reason);
        return boundedRenameWrite(controlDir.resolve(RECEIPT_FILE_NAME), content, budget);
    }

    /** Local (container filesystem) probe state file, mirrored from the run state. */
    private static void writeProbeState(String projectId, String runId, String podUid,
                                        String state, String reason, Instant firstReadyAt,
                                        Instant expiresAt) {
        writeSmallFile(LOCAL_PROBE_FILE, receiptContent(
                projectId, runId, podUid, state, firstReadyAt, expiresAt, reason));
    }

    /** Container-local termination message, same protocol, capped at 2 KiB. */
    private static void writeTerminationMessage(String projectId, String runId, String podUid,
                                                String state, String reason,
                                                Instant firstReadyAt, Instant expiresAt) {
        writeSmallFile(TERMINATION_FILE, receiptContent(
                projectId, runId, podUid, state, firstReadyAt, expiresAt, reason));
    }

    /** Best-effort local evidence for transitions that end before the supervisor starts. */
    private static void writeLocalEvidence(String projectId, String runId, String podUid,
                                           String state, String reason,
                                           Instant firstReadyAt, Instant expiresAt) {
        writeProbeState(projectId, runId, podUid, state, reason, firstReadyAt, expiresAt);
        writeTerminationMessage(projectId, runId, podUid, state, reason, firstReadyAt, expiresAt);
    }

    private static String receiptContent(String projectId, String runId, String podUid,
                                         String state, Instant firstReadyAt, Instant expiresAt,
                                         String reason) {
        StringBuilder sb = new StringBuilder(192);
        sb.append("protocol=").append(PROTOCOL).append('\n');
        sb.append("projectId=").append(safe(projectId)).append('\n');
        sb.append("runId=").append(safe(runId)).append('\n');
        sb.append("podUid=").append(safe(podUid)).append('\n');
        sb.append("state=").append(safe(state)).append('\n');
        if (firstReadyAt != null) {
            sb.append("firstReadyAt=").append(firstReadyAt).append('\n');
        }
        if (expiresAt != null) {
            sb.append("expiresAt=").append(expiresAt).append('\n');
        }
        sb.append("reason=").append(safe(reason)).append('\n');
        return sb.toString();
    }

    private static void writeSmallFile(String path, String content) {
        try {
            byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
            if (path.equals(TERMINATION_FILE) && bytes.length > TERMINATION_MAX_BYTES) {
                bytes = Arrays.copyOf(bytes, TERMINATION_MAX_BYTES);
            }
            Files.write(Path.of(path), bytes, StandardOpenOption.CREATE,
                    StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        } catch (Exception e) {
            // Local evidence is best-effort; the enforced exit path never depends on it.
        }
    }

    /** Bounded single-writer plain write used for the claim owner record. */
    private static boolean boundedWrite(Path target, String content, Duration budget) {
        Future<Boolean> future = CONTROL_IO.submit(() -> {
            Files.writeString(target, content, StandardCharsets.UTF_8);
            return true;
        });
        return awaitIo(future, budget);
    }

    /** Bounded temp-file + atomic-rename write; a stuck NFS never blocks the caller. */
    private static boolean boundedRenameWrite(Path target, String content, Duration budget) {
        Future<Boolean> future = CONTROL_IO.submit(() -> {
            Path tmp = Files.createTempFile(target.getParent(), ".receipt-", ".tmp");
            try {
                Files.write(tmp, content.getBytes(StandardCharsets.UTF_8),
                        StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
                try {
                    Files.move(tmp, target,
                            StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                } catch (UnsupportedOperationException | AtomicMoveNotSupportedException e) {
                    Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
                }
                return true;
            } finally {
                Files.deleteIfExists(tmp);
            }
        });
        return awaitIo(future, budget);
    }

    private static boolean awaitIo(Future<Boolean> future, Duration budget) {
        try {
            return future.get(budget.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException | ExecutionException e) {
            return false; // the daemon writer thread may stay stuck; the caller fails closed
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value.replaceAll("\\p{Cntrl}", " ").trim();
    }

    private static void sleepUnchecked(Duration duration) {
        try {
            Thread.sleep(duration.toMillis());
        } catch (InterruptedException e) {
            // Dedicated supervisor threads are never interrupted; enforcement continues.
        }
    }
}
