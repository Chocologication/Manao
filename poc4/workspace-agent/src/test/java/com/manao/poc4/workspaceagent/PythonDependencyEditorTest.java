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
        String pyprojectContent = AFTER_PYPROJECT;
        String lockContent = AFTER_LOCK;
        boolean deleteLock; // simulates a tool that produced no uv.lock at all
        RuntimeException failure;

        @Override
        public void resolve(Path scratch, PythonDependencyEditor.DependencyChange change) {
            calls++;
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
        // Unknown or empty output fails closed as a resolution failure.
        assertThat(PythonDependencyEditor.mapHelperOutcome(1, "something unexpected"))
            .isEqualTo("PYTHON_DEPENDENCY_RESOLUTION_FAILED");
        assertThat(PythonDependencyEditor.mapHelperOutcome(1, "")).isEqualTo("PYTHON_DEPENDENCY_RESOLUTION_FAILED");
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
