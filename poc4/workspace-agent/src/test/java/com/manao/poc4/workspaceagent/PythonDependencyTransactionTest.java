package com.manao.poc4.workspaceagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Commit-protocol tests for the two-file Python dependency transaction, using real temporary
 * workspace files. The fault-injection constructor (IntConsumer afterRename) is the only
 * test seam: production never takes it, and every scenario exercises the same commit entry
 * the HTTP layer exposes — first commit, post-interruption retry and receipt replay.
 */
class PythonDependencyTransactionTest {
    private static final String OPERATION_ID = "11111111-1111-4111-8111-111111111111";
    private static final String REQUEST_SHA256 = "a".repeat(64);
    private static final String BEFORE_PYPROJECT = "[project]\nname='demo'\n";
    private static final String BEFORE_LOCK = "version = 1\n";
    private static final String AFTER_PYPROJECT = "[project]\nname='updated'\n";
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

    /** Independent re-derivation of the design's combined digest formula. */
    static String combinedDigest(String pyprojectShaOrAbsent, String lockShaOrAbsent) {
        String payload = "python-dependencies-v1\npyproject.toml\n" + pyprojectShaOrAbsent
            + "\nuv.lock\n" + lockShaOrAbsent + "\n";
        return sha256Hex(payload.getBytes(StandardCharsets.UTF_8));
    }

    static String receiptJson(String operationId, String beforeSha256, String afterSha256) {
        return "{\"operationId\":\"" + operationId + "\",\"type\":\"PYTHON_DEPENDENCIES\","
            + "\"path\":\"pyproject.toml\",\"nextPath\":\"uv.lock\","
            + "\"beforeSha256\":\"" + beforeSha256 + "\",\"afterSha256\":\"" + afterSha256 + "\"}";
    }

    static String receiptSha256(String receiptJson) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(receiptJson.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    private PythonDependencyEditor.PreparedPythonDependencies stage(Path root) {
        return new PythonDependencyTransaction(root).stage(OPERATION_ID, REQUEST_SHA256, AFTER_PYPROJECT, AFTER_LOCK);
    }

    private PythonDependencyTransaction.PythonDependencyCommit commitCommand(
        PythonDependencyEditor.PreparedPythonDependencies prepared) {
        String receipt = receiptJson(prepared.operationId(), prepared.beforeSha256(), prepared.afterSha256());
        return new PythonDependencyTransaction.PythonDependencyCommit(prepared, receipt, receiptSha256(receipt));
    }

    @Test
    void theSameCommitCompletesAfterRestart(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        var tx = new PythonDependencyTransaction(root, renamed -> {
            if (renamed == 1) throw new IllegalStateException("simulated crash");
        });
        var prepared = tx.stage(OPERATION_ID, REQUEST_SHA256, AFTER_PYPROJECT, AFTER_LOCK);
        String receipt = "{\"operationId\":\"%s\",\"type\":\"PYTHON_DEPENDENCIES\","
            + "\"path\":\"pyproject.toml\",\"nextPath\":\"uv.lock\","
            + "\"beforeSha256\":\"%s\",\"afterSha256\":\"%s\"}";
        receipt = receipt.formatted(prepared.operationId(), prepared.beforeSha256(), prepared.afterSha256());
        String receiptSha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
            .digest(receipt.getBytes(StandardCharsets.UTF_8)));
        var command = new PythonDependencyTransaction.PythonDependencyCommit(prepared, receipt, receiptSha);
        assertThatThrownBy(() -> tx.commit(command)).isInstanceOf(IllegalStateException.class);
        var result = new PythonDependencyTransaction(root).commit(command);
        assertThat(result.afterSha256()).isEqualTo(prepared.afterSha256());
        assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo(AFTER_LOCK);
    }

    @Test
    void stageReturnsCombinedBeforeAndAfterDigestsMatchingTheDesignFormula(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);

        var prepared = stage(root);

        assertThat(prepared.operationId()).isEqualTo(OPERATION_ID);
        assertThat(prepared.requestSha256()).isEqualTo(REQUEST_SHA256);
        assertThat(prepared.beforeSha256()).isEqualTo(combinedDigest(
            sha256Hex(BEFORE_PYPROJECT.getBytes(StandardCharsets.UTF_8)),
            sha256Hex(BEFORE_LOCK.getBytes(StandardCharsets.UTF_8))));
        assertThat(prepared.afterSha256()).isEqualTo(combinedDigest(
            sha256Hex(AFTER_PYPROJECT.getBytes(StandardCharsets.UTF_8)),
            sha256Hex(AFTER_LOCK.getBytes(StandardCharsets.UTF_8))));
    }

    @Test
    void stageTreatsAMissingWorkspaceLockAsAbsentInTheCombinedDigest(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);

        var prepared = stage(root);

        assertThat(prepared.beforeSha256()).isEqualTo(combinedDigest(
            sha256Hex(BEFORE_PYPROJECT.getBytes(StandardCharsets.UTF_8)), "ABSENT"));
        assertThat(Files.exists(root.resolve("uv.lock"))).isFalse();
    }

    @Test
    void stagePersistsTheJournalBeforeResponding(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);

        var prepared = stage(root);

        Path journal = root.resolve(".manao/python-dependencies").resolve(OPERATION_ID);
        assertThat(Files.readString(journal.resolve("pyproject.toml"))).isEqualTo(AFTER_PYPROJECT);
        assertThat(Files.readString(journal.resolve("uv.lock"))).isEqualTo(AFTER_LOCK);
        String manifest = Files.readString(journal.resolve("manifest.json"));
        assertThat(manifest).contains("\"operationId\":\"" + OPERATION_ID + "\"");
        assertThat(manifest).contains("\"requestSha256\":\"" + REQUEST_SHA256 + "\"");
        assertThat(manifest).contains("\"state\":\"PREPARED\"");
        assertThat(manifest).contains(prepared.afterSha256());
    }

    @Test
    void stageTwiceWithTheSameRequestReturnsTheSameSummaryAndKeepsTheJournal(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        var first = new PythonDependencyTransaction(root).stage(OPERATION_ID, REQUEST_SHA256, AFTER_PYPROJECT, AFTER_LOCK);
        Path journalPyproject = root.resolve(".manao/python-dependencies/" + OPERATION_ID + "/pyproject.toml");
        Object originalStamp = Files.getAttribute(journalPyproject, "basic:lastModifiedTime");

        var second = new PythonDependencyTransaction(root).stage(OPERATION_ID, REQUEST_SHA256, AFTER_PYPROJECT, AFTER_LOCK);

        assertThat(second).isEqualTo(first);
        assertThat(Files.getAttribute(journalPyproject, "basic:lastModifiedTime")).isEqualTo(originalStamp);
    }

    @Test
    void stageWithADifferentRequestForTheSameOperationIdIsRejected(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        stage(root);

        assertThatThrownBy(() -> new PythonDependencyTransaction(root)
            .stage(OPERATION_ID, "b".repeat(64), AFTER_PYPROJECT, AFTER_LOCK))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("DEPENDENCY_REQUEST_MISMATCH"));
    }

    @Test
    void stageRejectsMalformedOperationIdRequestDigestOrContents(@TempDir Path root) {
        var tx = new PythonDependencyTransaction(root);
        assertThatThrownBy(() -> tx.stage("../escape", REQUEST_SHA256, AFTER_PYPROJECT, AFTER_LOCK))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        assertThatThrownBy(() -> tx.stage(OPERATION_ID, "zzz", AFTER_PYPROJECT, AFTER_LOCK))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
        assertThatThrownBy(() -> tx.stage(OPERATION_ID, REQUEST_SHA256, null, AFTER_LOCK))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("VALIDATION_ERROR"));
    }

    @Test
    void commitRejectsAMissingJournalWithoutTouchingSources(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        var prepared = new PythonDependencyEditor.PreparedPythonDependencies(
            OPERATION_ID, REQUEST_SHA256, "c".repeat(64), "d".repeat(64));

        assertThatThrownBy(() -> new PythonDependencyTransaction(root).commit(commitCommand(prepared)))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("OPERATION_CONFLICT"));
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(BEFORE_PYPROJECT);
        assertThat(Files.exists(root.resolve(".manao/receipts/" + OPERATION_ID + ".json"))).isFalse();
    }

    @Test
    void commitRejectsDigestsThatDivergeFromTheJournal(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        var prepared = stage(root);
        var wrongBefore = new PythonDependencyEditor.PreparedPythonDependencies(
            prepared.operationId(), prepared.requestSha256(), "e".repeat(64), prepared.afterSha256());
        var wrongRequest = new PythonDependencyEditor.PreparedPythonDependencies(
            prepared.operationId(), "b".repeat(64), prepared.beforeSha256(), prepared.afterSha256());

        assertThatThrownBy(() -> new PythonDependencyTransaction(root).commit(commitCommand(wrongBefore)))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("OPERATION_CONFLICT"));
        assertThatThrownBy(() -> new PythonDependencyTransaction(root).commit(commitCommand(wrongRequest)))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("DEPENDENCY_REQUEST_MISMATCH"));
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(BEFORE_PYPROJECT);
        assertThat(Files.exists(root.resolve(".manao/receipts/" + OPERATION_ID + ".json"))).isFalse();
    }

    @Test
    void commitRejectsAReceiptThatDoesNotMatchTheJournal(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        var prepared = stage(root);
        String tamperedReceipt = receiptJson(OPERATION_ID, prepared.beforeSha256(), "f".repeat(64));
        var wrongDigestSha = new PythonDependencyTransaction.PythonDependencyCommit(
            prepared, prepared.afterSha256(), prepared.afterSha256());
        var wrongDigestReceipt = new PythonDependencyTransaction.PythonDependencyCommit(
            prepared, prepared.afterSha256(), receiptSha256(prepared.afterSha256()));
        var correctShaWrongContent = new PythonDependencyTransaction.PythonDependencyCommit(
            prepared, tamperedReceipt, receiptSha256(tamperedReceipt));

        assertThatThrownBy(() -> new PythonDependencyTransaction(root).commit(wrongDigestSha))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("OPERATION_CONFLICT"));
        assertThatThrownBy(() -> new PythonDependencyTransaction(root).commit(wrongDigestReceipt))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("OPERATION_CONFLICT"));
        assertThatThrownBy(() -> new PythonDependencyTransaction(root).commit(correctShaWrongContent))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("OPERATION_CONFLICT"));
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(BEFORE_PYPROJECT);
        assertThat(Files.exists(root.resolve(".manao/receipts/" + OPERATION_ID + ".json"))).isFalse();
    }

    @Test
    void commitRejectsThirdFileContentAndKeepsTheUserChange(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        var prepared = stage(root);
        String userEdit = "version = 1\n# user edited between prepare and commit\n";
        Files.writeString(root.resolve("uv.lock"), userEdit);

        assertThatThrownBy(() -> new PythonDependencyTransaction(root).commit(commitCommand(prepared)))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("OPERATION_CONFLICT"));
        assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo(userEdit);
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(BEFORE_PYPROJECT);
        assertThat(Files.exists(root.resolve(".manao/receipts/" + OPERATION_ID + ".json"))).isFalse();
    }

    @Test
    void commitRejectsSymlinkedTargets(@TempDir Path root, @TempDir Path outside) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        Files.writeString(outside.resolve("evil.lock"), "controlled\n");
        var prepared = stage(root);
        try {
            Files.delete(root.resolve("uv.lock"));
            Files.createSymbolicLink(root.resolve("uv.lock"), outside.resolve("evil.lock"));
        } catch (UnsupportedOperationException | java.io.IOException ex) {
            return; // platform cannot create symlinks; the policy test covers containment
        }

        assertThatThrownBy(() -> new PythonDependencyTransaction(root).commit(commitCommand(prepared)))
            .isInstanceOf(RuntimeException.class);
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(BEFORE_PYPROJECT);
        assertThat(Files.exists(root.resolve(".manao/receipts/" + OPERATION_ID + ".json"))).isFalse();
    }

    @Test
    void commitAppliesBothFilesAndRecordsTheReceiptLast(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        var prepared = stage(root);
        var command = commitCommand(prepared);

        var result = new PythonDependencyTransaction(root).commit(command);

        assertThat(result.operationId()).isEqualTo(OPERATION_ID);
        assertThat(result.requestSha256()).isEqualTo(REQUEST_SHA256);
        assertThat(result.beforeSha256()).isEqualTo(prepared.beforeSha256());
        assertThat(result.afterSha256()).isEqualTo(prepared.afterSha256());
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(AFTER_PYPROJECT);
        assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo(AFTER_LOCK);
        assertThat(Files.readString(root.resolve(".manao/receipts/" + OPERATION_ID + ".json")))
            .isEqualTo(command.receiptJson());
    }

    @Test
    void commitReplayWithTheSameReceiptReturnsTheSameResultWithoutRewriting(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        var prepared = stage(root);
        var command = commitCommand(prepared);
        var first = new PythonDependencyTransaction(root).commit(command);
        Path lock = root.resolve("uv.lock");
        Object stamp = Files.getAttribute(lock, "basic:lastModifiedTime");

        var replay = new PythonDependencyTransaction(root).commit(command);

        assertThat(replay).isEqualTo(first);
        assertThat(Files.getAttribute(lock, "basic:lastModifiedTime")).isEqualTo(stamp);
        assertThat(Files.readString(lock)).isEqualTo(AFTER_LOCK);
    }

    @Test
    void commitReplayWithADifferentReceiptForTheSameOperationIdFailsClosed(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        var prepared = stage(root);
        new PythonDependencyTransaction(root).commit(commitCommand(prepared));
        String tampered = receiptJson(OPERATION_ID, prepared.beforeSha256(), "f".repeat(64));

        assertThatThrownBy(() -> new PythonDependencyTransaction(root).commit(
            new PythonDependencyTransaction.PythonDependencyCommit(prepared, tampered, receiptSha256(tampered))))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("OPERATION_CONFLICT"));
        assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo(AFTER_LOCK);
    }

    @Test
    void commitRefusesADamagedJournalBodyBeforeTouchingAnyTarget(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        var prepared = stage(root);
        // A damaged second journal body must fail the commit before the first target is renamed,
        // otherwise the workspace is left half-applied with its previous content unrecoverable.
        Files.writeString(root.resolve(".manao/python-dependencies/" + OPERATION_ID + "/uv.lock"), "damaged\n");

        assertThatThrownBy(() -> new PythonDependencyTransaction(root).commit(commitCommand(prepared)))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("IO_ERROR"));
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(BEFORE_PYPROJECT);
        assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo(BEFORE_LOCK);
        assertThat(Files.exists(root.resolve(".manao/receipts/" + OPERATION_ID + ".json"))).isFalse();
    }

    @Test
    void commitRefusesAManifestWhoseCombinedDigestsDoNotRecombine(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        var prepared = stage(root);
        // Keep every per-file digest intact but break the manifest's combined digest, so only
        // the digest RELATIONSHIP is damaged — the commit must still refuse before any rename.
        Path manifestFile = root.resolve(".manao/python-dependencies/" + OPERATION_ID + "/manifest.json");
        String tampered = Files.readString(manifestFile)
            .replace("\"beforeSha256\":\"" + prepared.beforeSha256() + "\"", "\"beforeSha256\":\"" + "9".repeat(64) + "\"");
        Files.writeString(manifestFile, tampered);
        var fromTamperedManifest = new PythonDependencyEditor.PreparedPythonDependencies(
            prepared.operationId(), prepared.requestSha256(), "9".repeat(64), prepared.afterSha256());

        assertThatThrownBy(() -> new PythonDependencyTransaction(root).commit(commitCommand(fromTamperedManifest)))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("IO_ERROR"));
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(BEFORE_PYPROJECT);
        assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo(BEFORE_LOCK);
        assertThat(Files.exists(root.resolve(".manao/receipts/" + OPERATION_ID + ".json"))).isFalse();
    }

    @Test
    void stageRefusesASymlinkedJournalDirectory(@TempDir Path root, @TempDir Path outside) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        Files.createDirectories(root.resolve(".manao/python-dependencies"));
        Files.createDirectories(outside.resolve("planted-journal"));
        try {
            Files.createSymbolicLink(root.resolve(".manao/python-dependencies/" + OPERATION_ID),
                outside.resolve("planted-journal"));
        } catch (UnsupportedOperationException | java.io.IOException ex) {
            return; // platform cannot create symlinks; the policy tests cover containment
        }

        assertThatThrownBy(() -> stage(root))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("IO_ERROR"));
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(BEFORE_PYPROJECT);
        assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo(BEFORE_LOCK);
        try (var planted = Files.list(outside.resolve("planted-journal"))) {
            assertThat(planted.findAny()).as("nothing may be written through the internal symlink").isEmpty();
        }
    }

    @Test
    void stageRefusesASymlinkedOperationLockFile(@TempDir Path root, @TempDir Path outside) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        Files.createDirectories(root.resolve(".manao/python-dependencies"));
        Files.writeString(outside.resolve("planted.lock"), "planted\n");
        try {
            Files.createSymbolicLink(root.resolve(".manao/python-dependencies/" + OPERATION_ID + ".lock"),
                outside.resolve("planted.lock"));
        } catch (UnsupportedOperationException | java.io.IOException ex) {
            return; // platform cannot create symlinks; the policy tests cover containment
        }

        assertThatThrownBy(() -> stage(root))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("IO_ERROR"));
        assertThat(Files.readString(outside.resolve("planted.lock"))).isEqualTo("planted\n");
        assertThat(Files.exists(root.resolve(".manao/python-dependencies/" + OPERATION_ID + "/manifest.json"))).isFalse();
    }

    @Test
    void commitRefusesASymlinkedReceiptsDirectory(@TempDir Path root, @TempDir Path outside) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        var prepared = stage(root);
        Files.createDirectories(outside.resolve("planted-receipts"));
        try {
            Files.createSymbolicLink(root.resolve(".manao/receipts"), outside.resolve("planted-receipts"));
        } catch (UnsupportedOperationException | java.io.IOException ex) {
            return; // platform cannot create symlinks; the policy tests cover containment
        }

        assertThatThrownBy(() -> new PythonDependencyTransaction(root).commit(commitCommand(prepared)))
            .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                ex -> assertThat(ex.code()).isEqualTo("IO_ERROR"));
        assertThat(Files.readString(root.resolve("pyproject.toml"))).isEqualTo(BEFORE_PYPROJECT);
        assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo(BEFORE_LOCK);
        try (var planted = Files.list(outside.resolve("planted-receipts"))) {
            assertThat(planted.findAny()).as("no receipt may be written through the internal symlink").isEmpty();
        }
    }

    @Test
    void commitAfterAFailedAttemptCompletesThroughTheSameEntry(@TempDir Path root) throws Exception {
        Files.writeString(root.resolve("pyproject.toml"), BEFORE_PYPROJECT);
        Files.writeString(root.resolve("uv.lock"), BEFORE_LOCK);
        var prepared = stage(root);
        var command = commitCommand(prepared);
        // The fault injection fires after the first rename of every commit attempt; the retry
        // through a fresh transaction object is the same public commit entry, not a recover path.
        var crashing = new PythonDependencyTransaction(root, renamed -> {
            throw new IllegalStateException("simulated crash");
        });
        assertThatThrownBy(() -> crashing.commit(command)).isInstanceOf(IllegalStateException.class);
        assertThat(Files.exists(root.resolve(".manao/receipts/" + OPERATION_ID + ".json"))).isFalse();

        var result = new PythonDependencyTransaction(root).commit(command);

        assertThat(result.afterSha256()).isEqualTo(prepared.afterSha256());
        assertThat(Files.readString(root.resolve("uv.lock"))).isEqualTo(AFTER_LOCK);
        assertThat(Files.readString(root.resolve(".manao/receipts/" + OPERATION_ID + ".json")))
            .isEqualTo(command.receiptJson());
    }
}
