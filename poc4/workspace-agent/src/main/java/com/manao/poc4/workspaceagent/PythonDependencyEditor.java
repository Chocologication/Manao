package com.manao.poc4.workspaceagent;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Prepares Python dependency changes (design 6.2): it copies the two managed files into a fresh
 * scratch directory, lets the root-owned helper run the fixed {@code uv add/remove --no-sync}
 * argv there — or, for a batch import, the fixed {@code uv add -r} over a scratch-private
 * requirements file exactly once — the workspace sources are never touched — and persists the
 * result as a PREPARED journal through {@link PythonDependencyTransaction#stage}. Validation
 * failures, an already prepared same request, and fixed tool error categories are decided here
 * before anything is written; raw tool output never reaches the client.
 */
public final class PythonDependencyEditor {
    private static final Logger LOG = LoggerFactory.getLogger(PythonDependencyEditor.class);

    /** Wire record of the requested change; the backend normalizes the package name before sending. */
    public record DependencyChange(String action, String packageName, String version) { }

    /** Wire record of the prepare/commit summary: ids and digests only, never file contents. */
    public record PreparedPythonDependencies(String operationId, String requestSha256,
                                             String beforeSha256, String afterSha256) { }

    /** Package-private seam so tests can stand in for the container-only uv helper. */
    interface Resolver {
        void resolve(Path scratch, DependencyChange change);

        void resolveBatch(Path scratch, String requirementsText);
    }

    /**
     * Fixed scratch-private file the batch requirements text is staged into before the ONE
     * helper run: an agent-owned name inside the scratch, never a workspace path nor the
     * project-root requirements.txt, and never one of the two managed files.
     */
    static final String BATCH_REQUIREMENTS_NAME = "manao-batch-requirements.txt";

    private static final java.util.regex.Pattern ACTION = java.util.regex.Pattern.compile("ADD|REMOVE");
    /** Post-normalization package name: lowercase alnum at both ends, hyphens inside, 1–128 chars. */
    private static final java.util.regex.Pattern PACKAGE_NAME =
        java.util.regex.Pattern.compile("[a-z0-9]([a-z0-9-]{0,126}[a-z0-9])?");
    /** Exact versions only (no ranges, no wildcard matchers). */
    private static final java.util.regex.Pattern EXACT_VERSION =
        java.util.regex.Pattern.compile("[0-9A-Za-z][0-9A-Za-z.+!-]{0,127}");
    private static final java.util.regex.Pattern REQUEST_SHA256 =
        java.util.regex.Pattern.compile("[0-9a-f]{64}");

    /** Engineering bounds for the resolution budget: configurable, never unbounded. */
    static final long MIN_RESOLUTION_SECONDS = 1;
    static final long MAX_RESOLUTION_SECONDS = 600;
    /**
     * Bounded margin on top of the resolution budget covering the helper phase's ENTIRE wall
     * clock: the primary helper wait, the post-timeout kill wait and both diagnostic drains
     * combined (one shared deadline). Ordering invariant with the backend: this total
     * (budget + 2s) must stay STRICTLY below the backend's prepare request timeout
     * (budget + 10s, WorkspaceApiClient.PREPARE_MARGIN_SECONDS) at every budget in the 1..600
     * range, leaving ~8s for journal persistence and the HTTP return even when every wait is
     * consumed.
     */
    private static final long HELPER_MARGIN_SECONDS = 2;
    private static final int OUTPUT_LIMIT = 64 * 1024;
    /** Matches the workspace file service's text size limit; larger tool output is rejected. */
    private static final long SCRATCH_FILE_LIMIT = 20L * 1024 * 1024;

    private final Path projectRoot;
    private final PythonDependencyTransaction transaction;
    private final Resolver resolver;

    public PythonDependencyEditor(Path projectRoot, PythonDependencyTransaction transaction,
                                  String pythonExecutable, String helperPath, Duration resolutionBudget) {
        this(projectRoot, transaction, new HelperResolver(pythonExecutable, helperPath, resolutionBudget));
    }

    PythonDependencyEditor(Path projectRoot, PythonDependencyTransaction transaction, Resolver resolver) {
        this.projectRoot = projectRoot.normalize();
        this.transaction = transaction;
        this.resolver = resolver;
    }

    /**
     * Prepares one dependency change. An operation id already prepared with the same request
     * digest returns the stored summary without running the tool again; a different request for
     * the same id is rejected; every failure proven side-effect free (sources were never
     * touched) is a safe rejection.
     */
    public PreparedPythonDependencies prepare(String operationId, String requestSha256, DependencyChange change) {
        validateOperationId(operationId);
        validateRequestSha256(requestSha256);
        validateChange(change);
        return resolveAndStage(operationId, requestSha256, scratch -> resolver.resolve(scratch, change));
    }

    /**
     * Prepares one batch requirements import with exactly ONE resolution run for the whole
     * text — never a per-line loop — through the same scratch/journal protocol as
     * {@link #prepare}: the idempotency and mismatch rules, the copied sources, the staged
     * two-file journal and the safe rejections are identical. The requirements text is staged
     * into the scratch under {@link #BATCH_REQUIREMENTS_NAME}; the workspace sources are never
     * touched and the response carries identity and digests only.
     */
    public PreparedPythonDependencies prepareBatch(String operationId, String requestSha256, String requirementsText) {
        validateOperationId(operationId);
        validateRequestSha256(requestSha256);
        if (requirementsText == null) {
            throw new WorkspaceFileService.WorkspaceFileException("VALIDATION_ERROR",
                "requirements text is required");
        }
        return resolveAndStage(operationId, requestSha256,
            scratch -> resolver.resolveBatch(scratch, requirementsText));
    }

    /** The prepare skeleton both the single-change and the batch path share. */
    private PreparedPythonDependencies resolveAndStage(String operationId, String requestSha256,
                                                       java.util.function.Consumer<Path> resolution) {
        PreparedPythonDependencies existing = transaction.existingPrepared(operationId, requestSha256);
        if (existing != null) {
            return existing;
        }
        Path pyproject = WorkspacePathPolicy.resolve(projectRoot, "pyproject.toml");
        if (!Files.isRegularFile(pyproject, LinkOption.NOFOLLOW_LINKS)) {
            throw new WorkspaceFileService.WorkspaceFileException("VALIDATION_ERROR", "pyproject.toml does not exist");
        }
        Path scratch = createScratch();
        try {
            copyWorkspaceFileIntoScratch(scratch, "pyproject.toml");
            copyWorkspaceFileIntoScratch(scratch, "uv.lock");
            resolution.accept(scratch);
            String pyprojectContent = scratchOutput(scratch, "pyproject.toml");
            String lockContent = scratchOutput(scratch, "uv.lock");
            return transaction.stage(operationId, requestSha256, pyprojectContent, lockContent);
        } finally {
            deleteRecursively(scratch);
        }
    }

    private Path createScratch() {
        try {
            return Files.createTempDirectory("manao-python-dependencies-");
        } catch (IOException ex) {
            throw ioError("cannot create the resolution scratch directory");
        }
    }

    private void copyWorkspaceFileIntoScratch(Path scratch, String name) {
        Path source = WorkspacePathPolicy.resolve(projectRoot, name);
        if (!Files.exists(source, LinkOption.NOFOLLOW_LINKS)) {
            return; // uv.lock may legitimately be absent yet; pyproject.toml was checked before
        }
        if (Files.isSymbolicLink(source) || !Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)) {
            throw conflict("dependency source is not a regular file");
        }
        try {
            Files.write(scratch.resolve(name), Files.readAllBytes(source));
        } catch (IOException ex) {
            throw ioError("cannot copy " + name + " into the scratch directory");
        }
    }

    private String scratchOutput(Path scratch, String name) {
        Path file = scratch.resolve(name);
        if (!Files.isRegularFile(file)) {
            throw new WorkspaceFileService.WorkspaceFileException("PYTHON_DEPENDENCY_RESOLUTION_FAILED",
                "the resolution tool produced no " + name);
        }
        byte[] bytes;
        try {
            bytes = Files.readAllBytes(file);
        } catch (IOException ex) {
            throw ioError("cannot read the resolution result");
        }
        if (bytes.length > SCRATCH_FILE_LIMIT) {
            throw new WorkspaceFileService.WorkspaceFileException("PYTHON_DEPENDENCY_RESOLUTION_FAILED",
                "the resolution result exceeds the file size limit");
        }
        return new String(bytes, StandardCharsets.UTF_8);
    }

    private static void validateOperationId(String operationId) {
        if (!WorkspacePathPolicy.isValidOperationId(operationId)) {
            throw new WorkspaceFileService.WorkspaceFileException("VALIDATION_ERROR", "invalid operation id");
        }
    }

    private static void validateRequestSha256(String requestSha256) {
        if (requestSha256 == null || !REQUEST_SHA256.matcher(requestSha256).matches()) {
            throw new WorkspaceFileService.WorkspaceFileException("VALIDATION_ERROR", "invalid request digest");
        }
    }

    private static void validateChange(DependencyChange change) {
        if (change == null || change.action() == null || !ACTION.matcher(change.action()).matches()) {
            throw new WorkspaceFileService.WorkspaceFileException("VALIDATION_ERROR", "unsupported action");
        }
        if (change.packageName() == null || !PACKAGE_NAME.matcher(change.packageName()).matches()) {
            throw new WorkspaceFileService.WorkspaceFileException("VALIDATION_ERROR", "unsupported package name");
        }
        String version = change.version();
        if ("REMOVE".equals(change.action())) {
            if (version != null && !version.isBlank()) {
                throw new WorkspaceFileService.WorkspaceFileException("VALIDATION_ERROR",
                    "remove must not carry a version");
            }
            return;
        }
        if (version != null && !version.isBlank() && !EXACT_VERSION.matcher(version).matches()) {
            throw new WorkspaceFileService.WorkspaceFileException("VALIDATION_ERROR",
                "only exact versions are supported");
        }
    }

    /**
     * The helper phase's ENTIRE wall-clock bound for one resolution: the budget plus the small
     * bounded helper margin. This is the ONE deadline the primary helper wait, the post-timeout
     * kill settle and both diagnostic drains draw from ({@link #awaitHelper}); kept a derivation
     * (not an inline sum) so the cross-module ordering invariant against the backend's prepare
     * request timeout is testable on both sides.
     */
    static long helperWaitSeconds(long budgetSeconds) {
        return budgetSeconds + HELPER_MARGIN_SECONDS;
    }

    /**
     * Fixed helper argv: isolated interpreter, root-owned helper, scratch path, change and
     * budget. Never a shell line; the package name and version travel as single arguments.
     */
    static List<String> helperCommand(Path scratch, DependencyChange change,
                                      String pythonExecutable, String helperPath, long budgetSeconds) {
        return List.of(pythonExecutable, "-I", helperPath, scratch.toString(), change.action(),
            change.packageName(), change.version() == null || change.version().isBlank()
                ? "" : change.version(),
            Long.toString(budgetSeconds));
    }

    /**
     * Fixed batch helper argv: the same isolated interpreter and root-owned helper, the BATCH
     * action, the scratch-private requirements file path (already staged by the agent) and the
     * budget. Never a shell line; the requirements path travels as a single argument.
     */
    static List<String> helperBatchCommand(Path scratch, Path requirements,
                                           String pythonExecutable, String helperPath, long budgetSeconds) {
        return List.of(pythonExecutable, "-I", helperPath, scratch.toString(), "BATCH",
            requirements.toString(), Long.toString(budgetSeconds));
    }

    /** Maps the helper's fixed stdout token to the safe error code; anything unknown fails closed. */
    static String mapHelperOutcome(int exitCode, String helperStdout) {
        if (exitCode == 0) return null;
        String token = helperStdout == null ? "" : helperStdout.trim();
        if ("PYTHON_DEPENDENCY_UNSUPPORTED".equals(token)) return "PYTHON_DEPENDENCY_UNSUPPORTED";
        if ("PYTHON_DEPENDENCY_TIMEOUT".equals(token)) return "PYTHON_DEPENDENCY_TIMEOUT";
        if ("PYTHON_DEPENDENCY_NO_WHEEL".equals(token)) return "PYTHON_DEPENDENCY_NO_WHEEL";
        return "PYTHON_DEPENDENCY_RESOLUTION_FAILED";
    }

    /** Outcome of one helper run: whether the outer budget was overrun, plus capped diagnostics. */
    record HelperRun(boolean timedOut, int exitCode, byte[] stdout, byte[] stderr) { }

    /**
     * Waits for the helper within the bounded outer budget while reader threads drain both
     * pipes CONCURRENTLY: a helper that fills the OS pipe buffer with diagnostics could never
     * finish its write before a post-exit drain runs, so a fast resolution failure would hang
     * until the budget and be misreported as a timeout. On overrun the helper AND its whole
     * child tree are destroyed.
     *
     * <p>{@code timeoutSeconds} bounds the phase's ENTIRE wall clock: ONE deadline is taken at
     * entry and the primary wait, the post-timeout settle wait and both diagnostic drains draw
     * only the REMAINING time from it — never fresh per-call margins — so the total stays
     * strictly inside the caller's timeout (the production call site passes
     * {@link #helperWaitSeconds(long)}, budget + 2s, and the backend's prepare request timeout
     * is budget + 10s). The tree kill's own destroy polling is bounded mechanics, not
     * collection. When the deadline is exhausted the drains return whatever the concurrent
     * reader threads have already captured; on interrupt collection stops immediately.
     */
    static HelperRun awaitHelper(Process process, long timeoutSeconds) {
        long deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds);
        DrainReader stdout = new DrainReader(process.getInputStream());
        DrainReader stderr = new DrainReader(process.getErrorStream());
        boolean exited;
        try {
            exited = waitRemaining(process, deadlineNanos);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            killHelperTree(process);
            return new HelperRun(true, -1, stdout.captured(0L), stderr.captured(0L));
        }
        if (!exited) {
            killHelperTree(process);
            try {
                waitRemaining(process, deadlineNanos);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
            }
            return new HelperRun(true, process.isAlive() ? -1 : process.exitValue(),
                stdout.captured(deadlineNanos), stderr.captured(deadlineNanos));
        }
        return new HelperRun(false, process.exitValue(),
            stdout.captured(deadlineNanos), stderr.captured(deadlineNanos));
    }

    /**
     * Bounded wait that draws the REMAINING time from the phase's one deadline. A deadline
     * already in the past never waits ({@link Process#waitFor(long, TimeUnit)} with a
     * non-positive timeout is never risked).
     */
    private static boolean waitRemaining(Process process, long deadlineNanos) throws InterruptedException {
        long remainingNanos = Math.max(0L, deadlineNanos - System.nanoTime());
        if (remainingNanos == 0L) {
            return !process.isAlive();
        }
        return process.waitFor(remainingNanos, TimeUnit.NANOSECONDS);
    }

    /**
     * Destroys the helper and, best effort, everything below it. Java 17 exposes no process
     * group API, so the uv tree is killed through {@link ProcessHandle#descendants()} while
     * the helper is still discoverable — descendants first, because after the helper itself
     * dies they are reparented and can no longer be found through it.
     */
    static void killHelperTree(Process process) {
        ProcessHandle helper = process.toHandle();
        for (int round = 0; round < 5; round++) {
            List<ProcessHandle> descendants = helper.descendants().toList();
            if (descendants.isEmpty()) break;
            descendants.forEach(ProcessHandle::destroyForcibly);
            try {
                Thread.sleep(100);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        process.destroyForcibly();
    }

    /** Drains one child stream on its own daemon thread, retaining at most {@link #OUTPUT_LIMIT} bytes. */
    private static final class DrainReader {
        private final java.io.ByteArrayOutputStream kept = new java.io.ByteArrayOutputStream();
        private final Thread thread;

        DrainReader(java.io.InputStream stream) {
            this.thread = new Thread(() -> {
                byte[] buffer = new byte[8192];
                try {
                    int read;
                    while ((read = stream.read(buffer)) != -1) {
                        synchronized (kept) {
                            int room = OUTPUT_LIMIT - kept.size();
                            if (room > 0) {
                                kept.write(buffer, 0, Math.min(read, room));
                            }
                        }
                    }
                    stream.close();
                } catch (IOException ignored) {
                    // best-effort drain of an exited helper's stream
                }
            }, "python-dependency-drain");
            this.thread.setDaemon(true);
            this.thread.start();
        }

        /**
         * Waits for EOF only until the helper phase's ONE deadline is exhausted — a
         * still-running grandchild cannot block it past the shared deadline — and returns the
         * bytes retained so far. A zero/negative remaining never joins ({@link Thread#join(long)}
         * with zero would wait forever).
         */
        byte[] captured(long deadlineNanos) {
            long remainingMillis = TimeUnit.NANOSECONDS.toMillis(Math.max(0L, deadlineNanos - System.nanoTime()));
            if (remainingMillis > 0) {
                try {
                    thread.join(remainingMillis);
                } catch (InterruptedException ex) {
                    Thread.currentThread().interrupt();
                }
            }
            synchronized (kept) {
                return kept.toByteArray();
            }
        }
    }

    private static final class HelperResolver implements Resolver {
        private final String pythonExecutable;
        private final String helperPath;
        private final long budgetSeconds;

        HelperResolver(String pythonExecutable, String helperPath, Duration resolutionBudget) {
            long seconds = resolutionBudget.getSeconds();
            if (seconds < MIN_RESOLUTION_SECONDS || seconds > MAX_RESOLUTION_SECONDS) {
                throw new IllegalArgumentException("resolution budget must be between "
                    + MIN_RESOLUTION_SECONDS + " and " + MAX_RESOLUTION_SECONDS + " seconds");
            }
            this.pythonExecutable = pythonExecutable;
            this.helperPath = helperPath;
            this.budgetSeconds = seconds;
        }

        @Override
        public void resolve(Path scratch, DependencyChange change) {
            runHelper(helperCommand(scratch, change, pythonExecutable, helperPath, budgetSeconds), scratch);
        }

        @Override
        public void resolveBatch(Path scratch, String requirementsText) {
            Path requirements = scratch.resolve(BATCH_REQUIREMENTS_NAME);
            try {
                Files.writeString(requirements, requirementsText, StandardCharsets.UTF_8);
            } catch (IOException ex) {
                throw ioError("cannot write the batch requirements into the scratch directory");
            }
            runHelper(helperBatchCommand(scratch, requirements, pythonExecutable, helperPath, budgetSeconds),
                scratch);
        }

        private void runHelper(List<String> command, Path scratch) {
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.directory(scratch.toFile());
            // Explicitly minimal environment: never a wholesale inheritance, so capability
            // material and any project secrets cannot leak into the tool process.
            Map<String, String> env = builder.environment();
            env.clear();
            env.put("PATH", System.getenv().getOrDefault("PATH", "/usr/local/bin:/usr/bin:/bin"));
            env.put("HOME", System.getProperty("java.io.tmpdir", "/tmp"));
            env.put("TMPDIR", System.getProperty("java.io.tmpdir", "/tmp"));
            env.put("LANG", "C.UTF-8");
            Process process;
            try {
                process = builder.start();
            } catch (IOException ex) {
                throw resolutionFailed("cannot start the dependency helper");
            }
            HelperRun run = awaitHelper(process, helperWaitSeconds(budgetSeconds));
            if (run.timedOut()) {
                if (Thread.currentThread().isInterrupted()) {
                    throw resolutionFailed("interrupted while resolving dependencies");
                }
                // Capped diagnostics still go to the agent log only, never to the client.
                LOG.warn("python dependency resolution timed out diagnostics={}",
                    new String(run.stderr(), StandardCharsets.UTF_8));
                throw new WorkspaceFileService.WorkspaceFileException("PYTHON_DEPENDENCY_TIMEOUT",
                    "dependency resolution exceeded the configured budget");
            }
            if (run.exitCode() == 0) {
                return;
            }
            String code = mapHelperOutcome(run.exitCode(), new String(run.stdout(), StandardCharsets.UTF_8));
            // Fixed safe message for the client; capped diagnostics go to the agent log only.
            LOG.warn("python dependency resolution failed code={} diagnostics={}", code,
                new String(run.stderr(), StandardCharsets.UTF_8));
            throw new WorkspaceFileService.WorkspaceFileException(code, fixedMessage(code));
        }

        private static String fixedMessage(String code) {
            return switch (code) {
                case "PYTHON_DEPENDENCY_UNSUPPORTED" -> "the project or package is outside the supported dependency scope";
                case "PYTHON_DEPENDENCY_TIMEOUT" -> "dependency resolution exceeded the configured budget";
                case "PYTHON_DEPENDENCY_NO_WHEEL" -> "no compatible wheel is available for the requested package or version";
                default -> "dependency resolution failed";
            };
        }
    }

    private static WorkspaceFileService.WorkspaceFileException resolutionFailed(String message) {
        return new WorkspaceFileService.WorkspaceFileException("PYTHON_DEPENDENCY_RESOLUTION_FAILED", message);
    }

    private static WorkspaceFileService.WorkspaceFileException conflict(String message) {
        return new WorkspaceFileService.WorkspaceFileException("OPERATION_CONFLICT", message);
    }

    private static WorkspaceFileService.WorkspaceFileException ioError(String message) {
        return new WorkspaceFileService.WorkspaceFileException("IO_ERROR", message);
    }

    private static void deleteRecursively(Path directory) {
        try (var paths = Files.walk(directory)) {
            paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.delete(path);
                } catch (IOException ignored) {
                    // best-effort scratch cleanup under the system temp directory
                }
            });
        } catch (IOException ignored) {
            // the scratch directory lives under java.io.tmpdir and is swept with the pod
        }
    }
}
