package com.manao.poc4.workspaceagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Editor tests with real temporary workspace files and a counting scratch resolver standing in
 * for the container-only uv helper. The resolver seam exists so the tests can prove the fixed
 * behaviours the production helper guarantees: sources stay untouched on failure, an already
 * PREPARED journal is returned without running the tool again, and request mismatches are
 * rejected before any resolution.
 */
class PythonDependencyEditorTest {
    private static final String OPERATION_ID = "22222222-2222-4222-8222-222222222222";
    private static final String REQUEST_SHA256 = "b".repeat(64);
    private static final String BEFORE_PYPROJECT = "[project]\nname='demo'\n";
    private static final String BEFORE_LOCK = "version = 1\n";
    private static final String AFTER_PYPROJECT = "[project]\nname='demo'\ndependencies = [\"httpx>=0.28.1\"]\n";
    private static final String AFTER_LOCK = "version = 1\nrevision = 3\n";
    /** One batch requirements text: exact pin, version range, whole-line comment and blank line. */
    private static final String BATCH_REQUIREMENTS = "# batch import probe\nhttpx==0.28.1\n\nidna>=3.7\n";

    static String sha256Hex(byte[] bytes) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) builder.append(String.format("%02x", b));
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    static String combinedDigest(String pyprojectShaOrAbsent, String lockShaOrAbsent) {
        String payload = "python-dependencies-v1\npyproject.toml\n" + pyprojectShaOrAbsent
            + "\nuv.lock\n" + lockShaOrAbsent + "\n";
        return sha256Hex(payload.getBytes(StandardCharsets.UTF_8));
    }

    /** Package-private resolver seam: stands in for the container-only uv helper. */
    private static final class CountingResolver implements PythonDependencyEditor.Resolver {
        int calls;
        int batchCalls;
        String batchRequirementsText;
        String pyprojectContent = AFTER_PYPROJECT;
        String lockContent = AFTER_LOCK;
        boolean deleteLock; // simulates a tool that produced no uv.lock at all
        RuntimeException failure;

        @Override
        public void resolve(Path scratch, PythonDependencyEditor.DependencyChange change) {
            calls++;
            applyResult(scratch);
        }

        @Override
        public void resolveBatch(Path scratch, String requirementsText) {
            batchCalls++;
            this.batchRequirementsText = requirementsText;
            applyResult(scratch);
        }

        private void applyResult(Path scratch) {
            if (failure != null) throw failure;
            try {
                if (pyprojectContent != null) {
                    Files.writeString(scratch.resolve("pyproject.toml"), pyprojectContent);
                }
                if (deleteLock) {
                    Files.deleteIfExists(scratch.resolve("uv.lock"));
                } else if (lockContent != null) {
                    Files.writeString(scratch.resolve("uv.lock"), lockContent);
                }
            } catch (IOException ex) {
                throw new IllegalStateException(ex);
            }
        }
    }

    private static PythonDependencyEditor editor(Path root, PythonDependencyEditor.Resolver resolver) {
        return new PythonDependencyEditor(root, new PythonDependencyTransaction(root), resolver);
    }

    private static Path seedWorkspace(Path root) throws IOException {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        return root;
    }

    @Test
    void helperWaitStaysStrictlyBelowTheBackendPrepareTimeout() {
        // Cross-module ordering invariant: the backend derives its prepare request timeout as
        // budget + 10s (WorkspaceApiClient.PREPARE_MARGIN_SECONDS = 10, mirrored here on
        // purpose — changing either side without the other fails one of these tests).
        // helperWaitSeconds is the helper phase's ENTIRE wall clock: ONE deadline covering the
        // primary wait, the post-timeout kill settle and BOTH diagnostic drains combined
        // (behavioural proof below: everyWaitInsideAwaitHelperDrawsFromTheOneDeadline...).
        // Worst case — every wait consumed — budget + 2s stays strictly below budget + 10s at
        // every budget in the 1..600 range, leaving ~8s for journal persistence and the HTTP
        // return instead of being truncated.
        assertThat(PythonDependencyEditor.helperWaitSeconds(20)).isEqualTo(22);
        assertThat(PythonDependencyEditor.helperWaitSeconds(1)).isEqualTo(3);
        assertThat(PythonDependencyEditor.helperWaitSeconds(600)).isEqualTo(602);
        assertThat(PythonDependencyEditor.helperWaitSeconds(20)).isLessThan(20 + 10);
        assertThat(PythonDependencyEditor.helperWaitSeconds(1)).isLessThan(1 + 10);
        assertThat(PythonDependencyEditor.helperWaitSeconds(600)).isLessThan(600 + 10);
    }

    @Test
    void prepareResolvesInScratchPersistsTheJournalAndLeavesSourcesUntouched(@TempDir Path root) throws Exception {
        seedWorkspace(root);
        CountingResolver resolver = new CountingResolver();

        PythonDependencyEditor.PreparedPythonDependencies prepared =
            editor(root, resolver).prepare(OPERATION_ID, REQUEST_SHA256,
                new PythonDependencyEditor.DependencyChange("ADD", "httpx", "0.28.1"));

        assertThat(resolver.calls).isEqualTo(1);
        assertThat(prepared.operationId()).isEqualTo(OPERATION_ID);
        assertThat(prepared.requestSha256()).isEqualTo(REQUEST_SHA256);
        // Combined digest formula holds for both ends of the operation.
        assertThat(prepared.beforeSha256()).isEqualTo(combinedDigest(
            sha256Hex(BEFORE_PYPROJECT.getBytes(StandardCharsets.UTF_8)),
            sha256Hex(BEFORE_LOCK.getBytes(StandardCharsets.UTF_8))));
        assertThat(prepared.afterSha256()).isEqualTo(combinedDigest(
            sha256Hex(AFTER_PYPROJECT.getBytes(StandardCharsets.UTF_8)),
            sha256Hex(AFTER_LOCK.getBytes(StandardCharsets.UTF_8))));
        // The workspace sources are unchanged; only the journal holds the resolution result.
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(BEFORE_PYPROJECT);
        assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo(BEFORE_LOCK);
        Path journal = root.resolve(".manao/python-dependencies").resolve(OPERATION_ID);
        assertThat(Files.readString(journal.resolve("pyproject.toml"))).isEqualTo(AFTER_PYPROJECT);
        assertThat(Files.readString(journal.resolve("uv.lock"))).isEqualTo(AFTER_LOCK);
    }

    @Test
    void prepareWithAnAlreadyPreparedSameRequestReturnsTheSameSummaryWithoutResolvingAgain(@TempDir Path root) throws Exception {
        seedWorkspace(root);
        CountingResolver resolver = new CountingResolver();
        PythonDependencyEditor editor = editor(root, resolver);
        PythonDependencyEditor.DependencyChange change = new PythonDependencyEditor.DependencyChange("ADD", "httpx", "0.28.1");
        PythonDependencyEditor.PreparedPythonDependencies first = editor.prepare(OPERATION_ID, REQUEST_SHA256, change);

        PythonDependencyEditor.PreparedPythonDependencies second = editor.prepare(OPERATION_ID, REQUEST_SHA256, change);

        assertThat(second).isEqualTo(first);
        assertThat(resolver.calls).isEqualTo(1);
    }

    @Test
    void preparedFastPathRefusesADamagedJournalInsteadOfReturningSummaries(@TempDir Path root) throws Exception {
        seedWorkspace(root);
        CountingResolver resolver = new CountingResolver();
        PythonDependencyEditor editor = editor(root, resolver);
        PythonDependencyEditor.DependencyChange change =
            new PythonDependencyEditor.DependencyChange("ADD", "httpx", "0.28.1");
        editor.prepare(OPERATION_ID, REQUEST_SHA256, change);
        // The same-request fast path returns persisted digests; it must not trust a journal
        // whose stored content no longer matches its manifest.
        Files.writeString(root.resolve(".manao/python-dependencies/" + OPERATION_ID + "/uv.lock"), "damaged\n");

        assertThatThrownBy(() -> editor.prepare(OPERATION_ID, REQUEST_SHA256, change))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("IO_ERROR"));
        assertThat(resolver.calls).isEqualTo(1);
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(BEFORE_PYPROJECT);
    }

    @Test
    void prepareWithADifferentRequestForTheSameOperationIdIsRejectedWithoutResolving(@TempDir Path root) throws Exception {
        seedWorkspace(root);
        CountingResolver resolver = new CountingResolver();
        PythonDependencyEditor editor = editor(root, resolver);
        editor.prepare(OPERATION_ID, REQUEST_SHA256, new PythonDependencyEditor.DependencyChange("ADD", "httpx", "0.28.1"));

        assertThatThrownBy(() -> editor.prepare(OPERATION_ID, "c".repeat(64),
            new PythonDependencyEditor.DependencyChange("ADD", "httpx", "0.29.0")))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("DEPENDENCY_REQUEST_MISMATCH"));
        assertThat(resolver.calls).isEqualTo(1);
    }

    @Test
    void batchPrepareResolvesOncePersistsTheJournalAndLeavesSourcesUntouched(@TempDir Path root) throws Exception {
        seedWorkspace(root);
        CountingResolver resolver = new CountingResolver();

        PythonDependencyEditor.PreparedPythonDependencies prepared =
            editor(root, resolver).prepareBatch(OPERATION_ID, REQUEST_SHA256, BATCH_REQUIREMENTS);

        // ONE resolver invocation for the whole batch — never a per-line loop.
        assertThat(resolver.batchCalls).isEqualTo(1);
        assertThat(resolver.calls).isZero();
        assertThat(resolver.batchRequirementsText).isEqualTo(BATCH_REQUIREMENTS);
        assertThat(prepared.operationId()).isEqualTo(OPERATION_ID);
        assertThat(prepared.requestSha256()).isEqualTo(REQUEST_SHA256);
        assertThat(prepared.beforeSha256()).isEqualTo(combinedDigest(
            sha256Hex(BEFORE_PYPROJECT.getBytes(StandardCharsets.UTF_8)),
            sha256Hex(BEFORE_LOCK.getBytes(StandardCharsets.UTF_8))));
        assertThat(prepared.afterSha256()).isEqualTo(combinedDigest(
            sha256Hex(AFTER_PYPROJECT.getBytes(StandardCharsets.UTF_8)),
            sha256Hex(AFTER_LOCK.getBytes(StandardCharsets.UTF_8))));
        // The workspace sources are unchanged; the journal still holds exactly the two managed
        // files plus its manifest — a batch never introduces a third managed file.
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(BEFORE_PYPROJECT);
        assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo(BEFORE_LOCK);
        try (var files = Files.list(root.resolve(".manao/python-dependencies").resolve(OPERATION_ID))) {
            assertThat(files.map(path -> path.getFileName().toString()))
                .containsExactlyInAnyOrder("pyproject.toml", "uv.lock", "manifest.json");
        }
    }

    @Test
    void batchPrepareWithAnAlreadyPreparedSameRequestReturnsTheSameSummaryWithoutResolvingAgain(@TempDir Path root) throws Exception {
        seedWorkspace(root);
        CountingResolver resolver = new CountingResolver();
        PythonDependencyEditor editor = editor(root, resolver);
        PythonDependencyEditor.PreparedPythonDependencies first =
            editor.prepareBatch(OPERATION_ID, REQUEST_SHA256, BATCH_REQUIREMENTS);

        PythonDependencyEditor.PreparedPythonDependencies second =
            editor.prepareBatch(OPERATION_ID, REQUEST_SHA256, BATCH_REQUIREMENTS);

        assertThat(second).isEqualTo(first);
        assertThat(resolver.batchCalls).isEqualTo(1);
    }

    @Test
    void batchPrepareWithADifferentRequestForTheSameOperationIdIsRejectedWithoutResolving(@TempDir Path root) throws Exception {
        seedWorkspace(root);
        CountingResolver resolver = new CountingResolver();
        PythonDependencyEditor editor = editor(root, resolver);
        editor.prepareBatch(OPERATION_ID, REQUEST_SHA256, BATCH_REQUIREMENTS);

        assertThatThrownBy(() -> editor.prepareBatch(OPERATION_ID, "c".repeat(64), BATCH_REQUIREMENTS))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("DEPENDENCY_REQUEST_MISMATCH"));
        assertThat(resolver.batchCalls).isEqualTo(1);
    }

    @Test
    void batchPrepareRejectsAMissingRequirementsTextBeforeAnyResolution(@TempDir Path root) throws Exception {
        seedWorkspace(root);
        CountingResolver resolver = new CountingResolver();

        assertThatThrownBy(() -> editor(root, resolver).prepareBatch(OPERATION_ID, REQUEST_SHA256, null))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        assertThat(resolver.batchCalls).isZero();
    }

    @Test
    void failedBatchResolutionLeavesSourcesAndJournalUntouched(@TempDir Path root) throws Exception {
        seedWorkspace(root);
        CountingResolver resolver = new CountingResolver();
        resolver.failure = new WorkspaceFileService.WorkspaceFileException(
            "PYTHON_DEPENDENCY_RESOLUTION_FAILED", "uv failed");

        assertThatThrownBy(() -> editor(root, resolver).prepareBatch(OPERATION_ID, REQUEST_SHA256,
            BATCH_REQUIREMENTS))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("PYTHON_DEPENDENCY_RESOLUTION_FAILED"));
        assertThat(resolver.batchCalls).isEqualTo(1);
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(BEFORE_PYPROJECT);
        assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo(BEFORE_LOCK);
        assertThat(Files.exists(root.resolve(".manao/python-dependencies").resolve(OPERATION_ID))).isFalse();
    }

    @Test
    void helperBatchCommandIsFixedAndNeverAShellLine(@TempDir Path root) {
        // The private requirements file lives inside the scratch under a fixed agent-owned name
        // that is neither a workspace path nor the project-root requirements.txt.
        Path requirements = root.resolve(PythonDependencyEditor.BATCH_REQUIREMENTS_NAME);
        assertThat(PythonDependencyEditor.BATCH_REQUIREMENTS_NAME)
            .isNotEqualTo("pyproject.toml").isNotEqualTo("uv.lock").isNotEqualTo("requirements.txt");

        List<String> argv = PythonDependencyEditor.helperBatchCommand(root, requirements,
            "/usr/local/bin/python3", "/opt/manao-python/dependency_helper.py", 20);

        assertThat(argv).containsExactly("/usr/local/bin/python3", "-I",
            "/opt/manao-python/dependency_helper.py", root.toString(), "BATCH",
            requirements.toString(), "20");
    }

    @Test
    void failedResolutionLeavesSourcesAndJournalUntouched(@TempDir Path root) throws Exception {
        seedWorkspace(root);
        CountingResolver resolver = new CountingResolver();
        resolver.failure = new WorkspaceFileService.WorkspaceFileException(
            "PYTHON_DEPENDENCY_RESOLUTION_FAILED", "uv failed");

        assertThatThrownBy(() -> editor(root, resolver).prepare(OPERATION_ID, REQUEST_SHA256,
            new PythonDependencyEditor.DependencyChange("ADD", "httpx", "0.28.1")))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("PYTHON_DEPENDENCY_RESOLUTION_FAILED"));
        assertThat(resolver.calls).isEqualTo(1);
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(BEFORE_PYPROJECT);
        assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo(BEFORE_LOCK);
        assertThat(Files.exists(root.resolve(".manao/python-dependencies").resolve(OPERATION_ID))).isFalse();
    }

    @Test
    void resolutionResultMissingAScratchFileIsRejected(@TempDir Path root) throws Exception {
        seedWorkspace(root);
        CountingResolver resolver = new CountingResolver();
        resolver.deleteLock = true; // the tool exited but produced no uv.lock

        // The editor copies the current workspace into scratch, so the only faithful simulation
        // of "no result" is a resolver that removes its target: post-resolution both managed
        // files must exist, otherwise the prepare fails closed without staging a journal.
        assertThatThrownBy(() -> editor(root, resolver).prepare(OPERATION_ID, REQUEST_SHA256,
            new PythonDependencyEditor.DependencyChange("ADD", "httpx", "0.28.1")))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("PYTHON_DEPENDENCY_RESOLUTION_FAILED"));
        assertThat(Files.exists(root.resolve(".manao/python-dependencies").resolve(OPERATION_ID))).isFalse();
    }

    @Test
    void invalidRequestsAreRejectedBeforeAnyResolution(@TempDir Path root) throws Exception {
        seedWorkspace(root);
        CountingResolver resolver = new CountingResolver();
        PythonDependencyEditor editor = editor(root, resolver);
        PythonDependencyEditor.DependencyChange valid = new PythonDependencyEditor.DependencyChange("ADD", "httpx", "0.28.1");

        assertThatThrownBy(() -> editor.prepare("bad id", REQUEST_SHA256, valid))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        assertThatThrownBy(() -> editor.prepare(OPERATION_ID, "XYZ", valid))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        assertThatThrownBy(() -> editor.prepare(OPERATION_ID, REQUEST_SHA256,
            new PythonDependencyEditor.DependencyChange("SYNC", "httpx", null)))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        assertThatThrownBy(() -> editor.prepare(OPERATION_ID, REQUEST_SHA256,
            new PythonDependencyEditor.DependencyChange("ADD", "Httpx", null)))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        assertThatThrownBy(() -> editor.prepare(OPERATION_ID, REQUEST_SHA256,
            new PythonDependencyEditor.DependencyChange("ADD", "-httpx", null)))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        assertThatThrownBy(() -> editor.prepare(OPERATION_ID, REQUEST_SHA256,
            new PythonDependencyEditor.DependencyChange("ADD", "a".repeat(129), null)))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        assertThatThrownBy(() -> editor.prepare(OPERATION_ID, REQUEST_SHA256,
            new PythonDependencyEditor.DependencyChange("ADD", "httpx", ">=0.28")))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        assertThatThrownBy(() -> editor.prepare(OPERATION_ID, REQUEST_SHA256,
            new PythonDependencyEditor.DependencyChange("REMOVE", "httpx", "0.28.1")))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        assertThat(resolver.calls).isZero();
    }

    @Test
    void prepareWithoutAProjectFileIsRejected(@TempDir Path root) throws Exception {
        CountingResolver resolver = new CountingResolver();

        assertThatThrownBy(() -> editor(root, resolver).prepare(OPERATION_ID, REQUEST_SHA256,
            new PythonDependencyEditor.DependencyChange("ADD", "httpx", "0.28.1")))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        assertThat(resolver.calls).isZero();
    }

    @Test
    void prepareRejectsSymlinkEscapeOnTheManagedFiles(@TempDir Path root, @TempDir Path outside) throws Exception {
        seedWorkspace(root);
        Files.writeString(outside.resolve("outside.lock"), "controlled\n");
        CountingResolver resolver = new CountingResolver();
        try {
            Files.delete(root.resolve("uv.lock"));
            Files.createSymbolicLink(root.resolve("uv.lock"), outside.resolve("outside.lock"));
        } catch (UnsupportedOperationException | IOException ex) {
            return; // platform cannot create symlinks; the policy test covers containment
        }

        assertThatThrownBy(() -> editor(root, resolver).prepare(OPERATION_ID, REQUEST_SHA256,
            new PythonDependencyEditor.DependencyChange("ADD", "httpx", "0.28.1")))
            .isInstanceOf(RuntimeException.class);
        assertThat(resolver.calls).isZero();
    }

    @Test
    void helperCommandIsFixedAndNeverAShellLine(@TempDir Path root) {
        List<String> argv = PythonDependencyEditor.helperCommand(root,
            new PythonDependencyEditor.DependencyChange("ADD", "httpx", "0.28.1"),
            "/usr/local/bin/python3", "/opt/manao-python/dependency_helper.py", 20);

        assertThat(argv).containsExactly("/usr/local/bin/python3", "-I",
            "/opt/manao-python/dependency_helper.py", root.toString(), "ADD", "httpx", "0.28.1", "20");
        List<String> removeWithoutVersion = PythonDependencyEditor.helperCommand(root,
            new PythonDependencyEditor.DependencyChange("REMOVE", "httpx", null),
            "/usr/local/bin/python3", "/opt/manao-python/dependency_helper.py", 20);
        assertThat(removeWithoutVersion).containsExactly("/usr/local/bin/python3", "-I",
            "/opt/manao-python/dependency_helper.py", root.toString(), "REMOVE", "httpx", "", "20");
    }

    @Test
    void helperTokensMapToFixedSafeErrorCodes() {
        assertThat(PythonDependencyEditor.mapHelperOutcome(0, "")).isNull();
        assertThat(PythonDependencyEditor.mapHelperOutcome(3, "PYTHON_DEPENDENCY_UNSUPPORTED\n"))
            .isEqualTo("PYTHON_DEPENDENCY_UNSUPPORTED");
        assertThat(PythonDependencyEditor.mapHelperOutcome(4, "PYTHON_DEPENDENCY_TIMEOUT\n"))
            .isEqualTo("PYTHON_DEPENDENCY_TIMEOUT");
        assertThat(PythonDependencyEditor.mapHelperOutcome(5, "PYTHON_DEPENDENCY_RESOLUTION_FAILED\n"))
            .isEqualTo("PYTHON_DEPENDENCY_RESOLUTION_FAILED");
        // A registry that cannot provide a usable wheel for the request is its own fixed
        // safe category, not a generic resolution failure.
        assertThat(PythonDependencyEditor.mapHelperOutcome(6, "PYTHON_DEPENDENCY_NO_WHEEL\n"))
            .isEqualTo("PYTHON_DEPENDENCY_NO_WHEEL");
        // Unknown or empty output fails closed as a resolution failure.
        assertThat(PythonDependencyEditor.mapHelperOutcome(1, "something unexpected"))
            .isEqualTo("PYTHON_DEPENDENCY_RESOLUTION_FAILED");
        assertThat(PythonDependencyEditor.mapHelperOutcome(1, "")).isEqualTo("PYTHON_DEPENDENCY_RESOLUTION_FAILED");
    }

    @Test
    void aFastHelperFailureIsNotMisreportedAsTimeoutEvenWhenItFillsThePipe() throws Exception {
        Process process = new ProcessBuilder(javaBin(), "-cp", System.getProperty("java.class.path"),
            StubNoisyProcess.class.getName()).start();
        long startedNanos = System.nanoTime();

        PythonDependencyEditor.HelperRun run = PythonDependencyEditor.awaitHelper(process, 30);
        long elapsedMillis = (System.nanoTime() - startedNanos) / 1_000_000;

        assertThat(run.timedOut()).isFalse();
        assertThat(run.exitCode()).isEqualTo(3);
        assertThat(run.stderr()).hasSize(64 * 1024); // drained concurrently while waiting, capped
        assertThat(elapsedMillis).as("a fast failing helper must not wait out the whole budget")
            .isLessThan(10_000);
    }

    @Test
    void everyWaitInsideAwaitHelperDrawsFromTheOneDeadlineSoTheTotalWallClockIsBounded() throws Exception {
        // TOTAL-bound cross-module invariant, behavioural form: the backend's prepare request
        // timeout (budget + 10s) must survive the agent's WORST helper phase. Here the helper
        // exits fast but an orphaned grandchild keeps BOTH pipes open, so the primary wait has
        // long returned while both diagnostic drains would block forever. With fresh per-call
        // margins that is 2 x 10s of drains beyond the helper's exit; the production call site
        // passes ONE deadline of helperWaitSeconds(budget) for the primary wait, the post-kill
        // settle and both drains COMBINED, so the total must stay inside that deadline
        // (budget 6 -> 8s) at any budget, including the 1s and 600s overrides.
        Path pidFile = Files.createTempFile("manao-orphan-pid-", ".txt");
        Process helper = new ProcessBuilder(javaBin(), "-cp", System.getProperty("java.class.path"),
            StubOrphanPipeHolder.class.getName(), pidFile.toString()).start();
        long startedNanos = System.nanoTime();
        try {
            PythonDependencyEditor.awaitHelper(helper, PythonDependencyEditor.helperWaitSeconds(6));

            long elapsedMillis = (System.nanoTime() - startedNanos) / 1_000_000;
            // The strict bound is 8s; the slack covers kill/destroy mechanics only. The old
            // fresh per-drain margins alone would spend >= 20s after the helper's exit.
            assertThat(elapsedMillis)
                .as("the total helper wall clock must stay inside the one deadline")
                .isLessThan(15_000);
        } finally {
            PythonDependencyEditor.killHelperTree(helper);
            Files.readString(pidFile).lines().findFirst().map(Long::parseLong)
                .flatMap(ProcessHandle::of).ifPresent(ProcessHandle::destroyForcibly);
            Files.deleteIfExists(pidFile);
        }
    }

    @Test
    void theOuterTimeoutKillsTheHelperAndItsWholeChildTree() throws Exception {
        Process helper = new ProcessBuilder(javaBin(), "-cp", System.getProperty("java.class.path"),
            StubHangingProcessTree.class.getName()).start();
        try {
            ProcessHandle handle = helper.toHandle();
            long deadline = System.currentTimeMillis() + 30_000;
            while (handle.descendants().findAny().isEmpty() && System.currentTimeMillis() < deadline) {
                Thread.sleep(50);
            }
            assertThat(handle.descendants().findAny()).as("stub grandchild spawned").isPresent();

            PythonDependencyEditor.killHelperTree(helper);

            assertThat(helper.waitFor(15, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            long settle = System.currentTimeMillis() + 10_000;
            while (handle.descendants().findAny().isPresent() && System.currentTimeMillis() < settle) {
                Thread.sleep(50);
            }
            assertThat(handle.descendants().findAny()).as("no descendant survives the tree kill").isEmpty();
        } finally {
            PythonDependencyEditor.killHelperTree(helper);
        }
    }

    /** Spawned as a process: floods stderr past any OS pipe capacity, then exits nonzero fast. */
    public static final class StubNoisyProcess {
        public static void main(String[] args) throws Exception {
            byte[] chunk = new byte[8192];
            java.util.Arrays.fill(chunk, (byte) 'x');
            for (int i = 0; i < 32; i++) {
                System.err.write(chunk);
            }
            System.err.flush();
            System.exit(3);
        }
    }

    /** Spawned as a process: spawns a sleeping grandchild, then hangs like a stuck helper. */
    public static final class StubHangingProcessTree {
        public static void main(String[] args) throws Exception {
            if (args.length > 0 && "sleep".equals(args[0])) {
                Thread.sleep(120_000);
                return;
            }
            new ProcessBuilder(javaBin(), "-cp", System.getProperty("java.class.path"),
                StubHangingProcessTree.class.getName(), "sleep").inheritIO().start();
            Thread.sleep(120_000);
        }
    }

    /** Spawned as a process: exits immediately but leaves a sleeping child holding both pipes open. */
    public static final class StubOrphanPipeHolder {
        public static void main(String[] args) throws Exception {
            if (args.length > 0 && "sleep".equals(args[0])) {
                Thread.sleep(30_000);
                return;
            }
            Process child = new ProcessBuilder(javaBin(), "-cp", System.getProperty("java.class.path"),
                StubOrphanPipeHolder.class.getName(), "sleep").inheritIO().start();
            Files.writeString(Path.of(args[0]), Long.toString(child.pid()));
            // Exit at once; the sleeping child keeps stdout/stderr open for the caller's drains.
        }
    }

    private static String javaBin() {
        boolean windows = System.getProperty("os.name").toLowerCase(java.util.Locale.ROOT).contains("win");
        return Path.of(System.getProperty("java.home"), "bin", windows ? "java.exe" : "java").toString();
    }

    @Test
    void productionConstructorRejectsAnUnboundedResolutionBudget(@TempDir Path root) {
        assertThatThrownBy(() -> new PythonDependencyEditor(root, new PythonDependencyTransaction(root),
            "/usr/local/bin/python3", "/opt/manao-python/dependency_helper.py", java.time.Duration.ofSeconds(0)))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PythonDependencyEditor(root, new PythonDependencyTransaction(root),
            "/usr/local/bin/python3", "/opt/manao-python/dependency_helper.py", java.time.Duration.ofSeconds(601)))
            .isInstanceOf(IllegalArgumentException.class);
    }
}
