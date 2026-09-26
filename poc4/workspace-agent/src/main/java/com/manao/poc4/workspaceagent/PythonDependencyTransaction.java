package com.manao.poc4.workspaceagent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.IntConsumer;
import java.util.function.Supplier;

/**
 * Durable two-file commit for Python dependency changes (design 6.2). The journal that
 * {@link PythonDependencyEditor} persists is the only authorization to replace
 * {@code pyproject.toml}/{@code uv.lock}; {@link #commit} validates the backend-issued command
 * and receipt against it, applies each file through temp+fsync+rename, verifies the combined
 * digest and records the receipt last. The first commit and any post-interruption retry enter
 * this same implementation, serialized by the same per-operation file lock — there is no
 * separate recover state machine. A receipt that already exists and matches is replayed as the
 * same result; a missing or damaged journal, a digest mismatch and any third file content keep
 * failing closed.
 */
public final class PythonDependencyTransaction {
    /** Internal journal directory under the agent-only {@code .manao} tree. */
    static final String JOURNAL_DIRECTORY = ".manao/python-dependencies";
    /** Per-file digest sentinel for a file that did not exist when the operation was prepared. */
    static final String ABSENT = "ABSENT";
    static final String STATE_PREPARED = "PREPARED";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final java.util.regex.Pattern REQUEST_SHA256 = java.util.regex.Pattern.compile("[0-9a-f]{64}");

    /**
     * One mutex per project root + operation id for the lifetime of this JVM. Dependency
     * operations are human-driven and rare, so the map stays small; entries are deliberately
     * never removed — a removal race could break the serialization the protocol depends on.
     */
    private static final ConcurrentHashMap<String, ReentrantLock> OPERATION_LOCKS = new ConcurrentHashMap<>();

    private final Path projectRoot;
    private final IntConsumer afterRename;

    public PythonDependencyTransaction(Path projectRoot) {
        this(projectRoot, null);
    }

    /**
     * Test-only constructor with a callback invoked after the nth applied file rename.
     * Fault injection must never be reachable from HTTP, so the production constructor does not
     * expose it.
     */
    PythonDependencyTransaction(Path projectRoot, IntConsumer afterRename) {
        this.projectRoot = projectRoot.normalize();
        this.afterRename = afterRename;
    }

    /** Wire record for the commit request: the prepared summary plus the backend-issued receipt. */
    public record PythonDependencyCommit(PythonDependencyEditor.PreparedPythonDependencies prepared,
                                         String receiptJson, String receiptSha256) { }

    record FileDigests(String before, String after) { }

    record JournalManifest(String operationId, String requestSha256, String state,
                           String beforeSha256, String afterSha256,
                           FileDigests pyproject, FileDigests uvLock) { }

    /**
     * Package-private staging of an already-resolved result: the only writer of the journal.
     * Idempotent for the same operation id + request digest; a different request for the same
     * id is rejected instead of being guessed about.
     */
    PythonDependencyEditor.PreparedPythonDependencies stage(String operationId, String requestSha256,
                                                            String pyprojectContent, String lockContent) {
        validateOperationId(operationId);
        validateRequestSha256(requestSha256);
        if (pyprojectContent == null || lockContent == null) {
            throw validation("prepared file contents are required");
        }
        return locked(operationId, () -> {
            PythonDependencyEditor.PreparedPythonDependencies existing = existingPrepared(operationId, requestSha256);
            if (existing != null) return existing;
            Path journal = journalDirectory(operationId);
            String pyprojectBefore = fileDigestOrAbsent(workspaceFile("pyproject.toml"));
            String lockBefore = fileDigestOrAbsent(workspaceFile("uv.lock"));
            String pyprojectAfter = sha256Hex(pyprojectContent.getBytes(StandardCharsets.UTF_8));
            String lockAfter = sha256Hex(lockContent.getBytes(StandardCharsets.UTF_8));
            String before = combinedDigest(pyprojectBefore, lockBefore);
            String after = combinedDigest(pyprojectAfter, lockAfter);
            JournalManifest manifest = new JournalManifest(operationId, requestSha256, STATE_PREPARED, before, after,
                new FileDigests(pyprojectBefore, pyprojectAfter), new FileDigests(lockBefore, lockAfter));
            try {
                Files.createDirectories(journal);
                // Journal-first durability: both target files and the manifest are fsynced before
                // the caller may respond; the manifest rename is the journal's commit point.
                writeAtomic(journal.resolve("pyproject.toml"), pyprojectContent.getBytes(StandardCharsets.UTF_8));
                writeAtomic(journal.resolve("uv.lock"), lockContent.getBytes(StandardCharsets.UTF_8));
                writeAtomic(journal.resolve("manifest.json"), JSON.writeValueAsBytes(manifest));
            } catch (IOException ex) {
                throw ioError("cannot persist the dependency journal");
            }
            return new PythonDependencyEditor.PreparedPythonDependencies(operationId, requestSha256, before, after);
        });
    }

    /**
     * The single public entry: first commit, post-interruption retry and receipt replay all go
     * through here. Returns the committed summary; the response never carries file contents.
     */
    public PythonDependencyEditor.PreparedPythonDependencies commit(PythonDependencyCommit command) {
        if (command == null || command.prepared() == null) {
            throw validation("prepared summary is required");
        }
        validateOperationId(command.prepared().operationId());
        validateRequestSha256(command.prepared().requestSha256());
        if (command.receiptJson() == null || command.receiptJson().isBlank()
            || command.receiptSha256() == null || !REQUEST_SHA256.matcher(command.receiptSha256()).matches()) {
            throw validation("receipt and its digest are required");
        }
        String operationId = command.prepared().operationId();
        return locked(operationId, () -> {
            Path receiptFile = receiptFile(operationId);
            if (Files.isRegularFile(receiptFile)) {
                byte[] existing = readBytes(receiptFile);
                if (command.receiptJson().equals(new String(existing, StandardCharsets.UTF_8))
                    && sha256Hex(existing).equals(command.receiptSha256())) {
                    // The final receipt already exists and matches: return the same result
                    // without touching any file again.
                    verifyReceipt(command.receiptJson(), command.receiptSha256(), operationId,
                        command.prepared().beforeSha256(), command.prepared().afterSha256());
                    return command.prepared();
                }
                throw conflict("operation id was already committed with a different receipt");
            }
            JournalManifest manifest = readJournal(operationId);
            if (!command.prepared().requestSha256().equals(manifest.requestSha256())) {
                throw new WorkspaceFileService.WorkspaceFileException("DEPENDENCY_REQUEST_MISMATCH",
                    "operation id was prepared for a different request");
            }
            if (!command.prepared().beforeSha256().equals(manifest.beforeSha256())
                || !command.prepared().afterSha256().equals(manifest.afterSha256())) {
                throw conflict("prepared digests do not match the journal");
            }
            verifyReceipt(command.receiptJson(), command.receiptSha256(), operationId,
                manifest.beforeSha256(), manifest.afterSha256());
            applyPreparedFiles(manifest);
            verifyCombinedAfter(manifest);
            writeReceipt(receiptFile, command.receiptJson(), command.receiptSha256());
            return new PythonDependencyEditor.PreparedPythonDependencies(operationId,
                command.prepared().requestSha256(), manifest.beforeSha256(), manifest.afterSha256());
        });
    }

    /**
     * Fast-path lookup for the editor: returns the stored summary when this operation id was
     * already prepared with the same request digest, throws DEPENDENCY_REQUEST_MISMATCH for a
     * different request and fails closed on an unreadable journal. Safe without the operation
     * lock because the manifest is published by atomic rename.
     */
    PythonDependencyEditor.PreparedPythonDependencies existingPrepared(String operationId, String requestSha256) {
        Path manifest = journalDirectory(operationId).resolve("manifest.json");
        if (!Files.isRegularFile(manifest)) return null;
        JournalManifest parsed = readManifest(manifest);
        if (!operationId.equals(parsed.operationId()) || !STATE_PREPARED.equals(parsed.state())) {
            throw ioError("dependency journal is in an unexpected state");
        }
        if (!requestSha256.equals(parsed.requestSha256())) {
            throw new WorkspaceFileService.WorkspaceFileException("DEPENDENCY_REQUEST_MISMATCH",
                "operation id was prepared for a different request");
        }
        return new PythonDependencyEditor.PreparedPythonDependencies(parsed.operationId(),
            parsed.requestSha256(), parsed.beforeSha256(), parsed.afterSha256());
    }

    private void applyPreparedFiles(JournalManifest manifest) {
        // Validate both targets before touching anything, so a rejected commit is side-effect
        // free; any drift appearing between validation and application is caught by the final
        // combined digest verification.
        String pyprojectCurrent = fileDigestOrAbsent(workspaceFile("pyproject.toml"));
        String lockCurrent = fileDigestOrAbsent(workspaceFile("uv.lock"));
        validateCurrentState("pyproject.toml", manifest.pyproject(), pyprojectCurrent);
        validateCurrentState("uv.lock", manifest.uvLock(), lockCurrent);
        int[] renames = {0};
        applyPreparedFile(manifest, "pyproject.toml", manifest.pyproject(), pyprojectCurrent, renames);
        applyPreparedFile(manifest, "uv.lock", manifest.uvLock(), lockCurrent, renames);
    }

    private void validateCurrentState(String name, FileDigests digests, String current) {
        if (!digests.before().equals(current) && !digests.after().equals(current)) {
            // A third content means the workspace moved underneath the operation.
            throw conflict(name + " changed since the operation was prepared");
        }
    }

    private void applyPreparedFile(JournalManifest manifest, String name, FileDigests digests,
                                   String current, int[] renames) {
        if (digests.after().equals(current)) {
            return; // this file was already replaced by the interrupted attempt
        }
        byte[] content = journalFileBytes(manifest.operationId(), name, digests.after());
        writeAtomic(workspaceFile(name), content);
        renames[0]++;
        if (afterRename != null) {
            afterRename.accept(renames[0]);
        }
    }

    private void verifyCombinedAfter(JournalManifest manifest) {
        String current = combinedDigest(fileDigestOrAbsent(workspaceFile("pyproject.toml")),
            fileDigestOrAbsent(workspaceFile("uv.lock")));
        if (!current.equals(manifest.afterSha256())) {
            throw conflict("committed files do not match the prepared digest");
        }
    }

    private void verifyReceipt(String receiptJson, String receiptSha256, String operationId,
                               String beforeSha256, String afterSha256) {
        if (!sha256Hex(receiptJson.getBytes(StandardCharsets.UTF_8)).equals(receiptSha256)) {
            throw conflict("receipt digest does not match the receipt content");
        }
        JsonNode receipt;
        try {
            receipt = JSON.readTree(receiptJson);
        } catch (Exception ex) {
            throw conflict("receipt is not valid JSON");
        }
        boolean matches = operationId.equals(text(receipt, "operationId"))
            && "PYTHON_DEPENDENCIES".equals(text(receipt, "type"))
            && "pyproject.toml".equals(text(receipt, "path"))
            && "uv.lock".equals(text(receipt, "nextPath"))
            && beforeSha256.equals(text(receipt, "beforeSha256"))
            && afterSha256.equals(text(receipt, "afterSha256"));
        if (!matches) {
            throw conflict("receipt does not match the prepared operation");
        }
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null ? null : value.asText();
    }

    private byte[] journalFileBytes(String operationId, String name, String expectedSha256) {
        Path file = journalDirectory(operationId).resolve(name);
        if (!Files.isRegularFile(file)) {
            throw ioError("dependency journal is incomplete");
        }
        byte[] bytes = readBytes(file);
        if (!sha256Hex(bytes).equals(expectedSha256)) {
            throw ioError("dependency journal content does not match its manifest");
        }
        return bytes;
    }

    private JournalManifest readJournal(String operationId) {
        Path manifest = journalDirectory(operationId).resolve("manifest.json");
        if (!Files.isRegularFile(manifest)) {
            throw conflict("no prepared dependency journal for this operation id");
        }
        return readManifest(manifest);
    }

    private JournalManifest readManifest(Path manifest) {
        try {
            JournalManifest parsed = JSON.readValue(readBytes(manifest), JournalManifest.class);
            if (parsed.operationId() == null || parsed.requestSha256() == null || parsed.state() == null
                || parsed.beforeSha256() == null || parsed.afterSha256() == null
                || parsed.pyproject() == null || parsed.uvLock() == null
                || parsed.pyproject().before() == null || parsed.pyproject().after() == null
                || parsed.uvLock().before() == null || parsed.uvLock().after() == null) {
                throw ioError("dependency journal manifest is incomplete");
            }
            return parsed;
        } catch (IOException ex) {
            throw ioError("dependency journal manifest is unreadable");
        }
    }

    private String fileDigestOrAbsent(Path target) {
        if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) return ABSENT;
        if (Files.isSymbolicLink(target) || !Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)) {
            throw conflict("dependency target is not a regular file");
        }
        return sha256Hex(readBytes(target));
    }

    /** Resolves the two managed file names through the shared path policy: containment, no escape. */
    private Path workspaceFile(String name) {
        return WorkspacePathPolicy.resolve(projectRoot, name);
    }

    private Path journalDirectory(String operationId) {
        return projectRoot.resolve(JOURNAL_DIRECTORY).resolve(operationId);
    }

    private Path receiptFile(String operationId) {
        return projectRoot.resolve(WorkspaceFileService.RECEIPTS_DIRECTORY).resolve(operationId + ".json");
    }

    private void writeReceipt(Path receiptFile, String receiptJson, String expectedReceiptSha256) {
        if (!sha256Hex(receiptJson.getBytes(StandardCharsets.UTF_8)).equals(expectedReceiptSha256)) {
            throw conflict("receipt digest does not match the receipt content");
        }
        writeAtomic(receiptFile, receiptJson.getBytes(StandardCharsets.UTF_8));
    }

    private <T> T locked(String operationId, Supplier<T> body) {
        ReentrantLock mutex = OPERATION_LOCKS.computeIfAbsent(lockKey(operationId), key -> new ReentrantLock());
        mutex.lock();
        try {
            Path lockDirectory = projectRoot.resolve(JOURNAL_DIRECTORY);
            Files.createDirectories(lockDirectory);
            try (FileChannel channel = FileChannel.open(lockDirectory.resolve(operationId + ".lock"),
                StandardOpenOption.CREATE, StandardOpenOption.WRITE)) {
                FileLock fileLock = channel.lock();
                try {
                    return body.get();
                } finally {
                    fileLock.release();
                }
            }
        } catch (IOException ex) {
            throw ioError("cannot lock the dependency operation");
        } finally {
            mutex.unlock();
        }
    }

    private String lockKey(String operationId) {
        return projectRoot + "\n" + operationId;
    }

    private void writeAtomic(Path target, byte[] content) {
        try {
            Files.createDirectories(target.getParent());
            Path temp = target.resolveSibling("." + target.getFileName() + ".python-deps-tmp");
            Files.write(temp, content, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING,
                StandardOpenOption.CREATE);
            force(temp);
            try {
                Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ex) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            }
            forceDirectory(target.getParent());
        } catch (IOException ex) {
            throw ioError("cannot write file");
        }
    }

    private static void force(Path file) throws IOException {
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.WRITE)) {
            channel.force(true);
        }
    }

    private static void forceDirectory(Path directory) {
        // Directory fsync is unsupported on some platforms (e.g. Windows); the file fsyncs carry the durability proof.
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) {
            channel.force(true);
        } catch (IOException ignored) { }
    }

    private static byte[] readBytes(Path file) {
        try {
            return Files.readAllBytes(file);
        } catch (IOException ex) {
            throw ioError("cannot read file");
        }
    }

    private static void validateOperationId(String operationId) {
        if (!WorkspacePathPolicy.isValidOperationId(operationId)) {
            throw validation("invalid operation id");
        }
    }

    private static void validateRequestSha256(String requestSha256) {
        if (requestSha256 == null || !REQUEST_SHA256.matcher(requestSha256).matches()) {
            throw validation("invalid request digest");
        }
    }

    /** Fixed combined digest: UTF-8 SHA-256 over the two fixed paths in fixed order, ABSENT when missing. */
    static String combinedDigest(String pyprojectShaOrAbsent, String lockShaOrAbsent) {
        String payload = "python-dependencies-v1\npyproject.toml\n" + pyprojectShaOrAbsent
            + "\nuv.lock\n" + lockShaOrAbsent + "\n";
        return sha256Hex(payload.getBytes(StandardCharsets.UTF_8));
    }

    private static WorkspaceFileService.WorkspaceFileException validation(String message) {
        return new WorkspaceFileService.WorkspaceFileException("VALIDATION_ERROR", message);
    }

    private static WorkspaceFileService.WorkspaceFileException conflict(String message) {
        return new WorkspaceFileService.WorkspaceFileException("OPERATION_CONFLICT", message);
    }

    private static WorkspaceFileService.WorkspaceFileException ioError(String message) {
        return new WorkspaceFileService.WorkspaceFileException("IO_ERROR", message);
    }

    static String sha256Hex(byte[] bytes) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : java.security.MessageDigest.getInstance("SHA-256").digest(bytes)) {
                builder.append(String.format("%02x", b));
            }
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }
}
