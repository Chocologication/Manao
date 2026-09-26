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
 * digest and records the receipt last. The FULL journal — both stored file bodies and every
 * manifest digest relationship — is validated before any rename, on the commit path and on the
 * same-request PREPARED fast path alike, so a damaged journal fails closed without a half
 * commit. Internal journal, lock and receipt paths are resolved without following links so a
 * pre-planted symlink under {@code .manao} cannot redirect I/O outside the project root. The
 * first commit and any post-interruption retry enter this same implementation, serialized by
 * the same per-operation file lock — there is no separate recover state machine. A receipt
 * that already exists and matches is replayed as the same result; a missing or damaged
 * journal, a digest mismatch and any third file content keep failing closed.
 */
public final class PythonDependencyTransaction {
    /** Internal journal directory under the agent-only {@code .manao} tree. */
    static final String JOURNAL_DIRECTORY = ".manao/python-dependencies";
    /** Per-file digest sentinel for a file that did not exist when the operation was prepared. */
    static final String ABSENT = "ABSENT";
    static final String STATE_PREPARED = "PREPARED";
    private static final ObjectMapper JSON = new ObjectMapper();
    /** Bounded run of zero-byte writes tolerated before a drain gives up fail-closed. */
    private static final int MAX_CONSECUTIVE_EMPTY_WRITES = 3;
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

    /** A journal whose manifest relationships and both stored file bodies are fully verified. */
    private record ValidatedJournal(JournalManifest manifest, byte[] pyprojectContent, byte[] lockContent) { }

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
     * Full journal validation, run before ANY workspace mutation and on the same-request PREPARED
     * fast path: the manifest's per-file digests must recombine to its combined digests, and both
     * journal file bodies must exist and hash to their per-file after digests. A damaged journal
     * fails closed here — before a single target file is touched — so a commit can never leave a
     * half-applied workspace whose previous content the journal cannot restore.
     */
    private ValidatedJournal validateJournal(String operationId) {
        Path manifestFile = internalPath(JOURNAL_DIRECTORY + "/" + operationId + "/manifest.json");
        if (!Files.isRegularFile(manifestFile, LinkOption.NOFOLLOW_LINKS)) {
            throw conflict("no prepared dependency journal for this operation id");
        }
        JournalManifest manifest = readManifest(manifestFile);
        if (!operationId.equals(manifest.operationId()) || !STATE_PREPARED.equals(manifest.state())) {
            throw ioError("dependency journal is in an unexpected state");
        }
        if (!combinedDigest(manifest.pyproject().before(), manifest.uvLock().before()).equals(manifest.beforeSha256())
            || !combinedDigest(manifest.pyproject().after(), manifest.uvLock().after()).equals(manifest.afterSha256())) {
            throw ioError("dependency journal manifest digests do not recombine");
        }
        byte[] pyproject = journalBody(internalPath(JOURNAL_DIRECTORY + "/" + operationId + "/pyproject.toml"),
            manifest.pyproject().after());
        byte[] lock = journalBody(internalPath(JOURNAL_DIRECTORY + "/" + operationId + "/uv.lock"),
            manifest.uvLock().after());
        return new ValidatedJournal(manifest, pyproject, lock);
    }

    private byte[] journalBody(Path file, String expectedSha256) {
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            throw ioError("dependency journal is incomplete");
        }
        byte[] bytes = readBytes(file);
        if (!sha256Hex(bytes).equals(expectedSha256)) {
            throw ioError("dependency journal content does not match its manifest");
        }
        return bytes;
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
            if (Files.isRegularFile(receiptFile, LinkOption.NOFOLLOW_LINKS)) {
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
            // Validate the FULL journal — both file bodies and all manifest digest
            // relationships — before any rename, so a damaged journal fails closed without a
            // half commit whose previous workspace content is unrecoverable.
            ValidatedJournal journal = validateJournal(operationId);
            JournalManifest manifest = journal.manifest();
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
            applyPreparedFiles(manifest, journal.pyprojectContent(), journal.lockContent());
            verifyCombinedAfter(manifest);
            writeReceipt(receiptFile, command.receiptJson(), command.receiptSha256());
            return new PythonDependencyEditor.PreparedPythonDependencies(operationId,
                command.prepared().requestSha256(), manifest.beforeSha256(), manifest.afterSha256());
        });
    }

    /**
     * Fast-path lookup for the editor: returns the stored summary when this operation id was
     * already prepared with the same request digest, throws DEPENDENCY_REQUEST_MISMATCH for a
     * different request and fails closed on a missing, unreadable or damaged journal — the same
     * full validation a commit performs, because the returned digests are only trustworthy if
     * the stored journal content still matches them. Safe without the operation lock because
     * the manifest is published by atomic rename after its file bodies.
     */
    PythonDependencyEditor.PreparedPythonDependencies existingPrepared(String operationId, String requestSha256) {
        Path manifest = internalPath(JOURNAL_DIRECTORY + "/" + operationId + "/manifest.json");
        if (!Files.isRegularFile(manifest, LinkOption.NOFOLLOW_LINKS)) return null;
        JournalManifest parsed = validateJournal(operationId).manifest();
        if (!requestSha256.equals(parsed.requestSha256())) {
            throw new WorkspaceFileService.WorkspaceFileException("DEPENDENCY_REQUEST_MISMATCH",
                "operation id was prepared for a different request");
        }
        return new PythonDependencyEditor.PreparedPythonDependencies(parsed.operationId(),
            parsed.requestSha256(), parsed.beforeSha256(), parsed.afterSha256());
    }

    private void applyPreparedFiles(JournalManifest manifest, byte[] pyprojectContent, byte[] lockContent) {
        // Validate both targets before touching anything, so a rejected commit is side-effect
        // free; any drift appearing between validation and application is caught by the final
        // combined digest verification. The journal bodies were fully validated before this.
        String pyprojectCurrent = fileDigestOrAbsent(workspaceFile("pyproject.toml"));
        String lockCurrent = fileDigestOrAbsent(workspaceFile("uv.lock"));
        validateCurrentState("pyproject.toml", manifest.pyproject(), pyprojectCurrent);
        validateCurrentState("uv.lock", manifest.uvLock(), lockCurrent);
        int[] renames = {0};
        applyPreparedFile("pyproject.toml", manifest.pyproject(), pyprojectCurrent, pyprojectContent, renames);
        applyPreparedFile("uv.lock", manifest.uvLock(), lockCurrent, lockContent, renames);
    }

    private void validateCurrentState(String name, FileDigests digests, String current) {
        if (!digests.before().equals(current) && !digests.after().equals(current)) {
            // A third content means the workspace moved underneath the operation.
            throw conflict(name + " changed since the operation was prepared");
        }
    }

    private void applyPreparedFile(String name, FileDigests digests, String current,
                                   byte[] content, int[] renames) {
        if (digests.after().equals(current)) {
            return; // this file was already replaced by the interrupted attempt
        }
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
        return internalPath(JOURNAL_DIRECTORY + "/" + operationId);
    }

    /** Receipt paths are agent-internal constants plus the validated operation id. */
    private Path receiptFile(String operationId) {
        return internalPath(WorkspaceFileService.RECEIPTS_DIRECTORY + "/" + operationId + ".json");
    }

    /**
     * Resolves an agent-internal path under the project root WITHOUT following links. The
     * {@code .manao} tree shares the project PVC with user-visible files, so a pre-planted
     * symlink on an internal directory or file must never redirect journal, lock or receipt
     * I/O outside the project root: every existing segment must be a real directory (the last
     * segment may also be a to-be-created file), and no segment may be a symlink. Unlike the
     * workspace policy this does not consult {@code toRealPath()} on the target itself — the
     * no-follow walk is the containment proof.
     */
    private Path internalPath(String relativePath) {
        Path current;
        try {
            current = projectRoot.toRealPath();
        } catch (IOException ex) {
            throw ioError("project directory is unavailable");
        }
        String[] segments = relativePath.split("/");
        for (int index = 0; index < segments.length; index++) {
            String segment = segments[index];
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) {
                throw ioError("agent-internal path is malformed");
            }
            Path next = current.resolve(segment);
            if (Files.isSymbolicLink(next)) {
                throw ioError("agent-internal path must not be a symbolic link");
            }
            if (index < segments.length - 1 && Files.exists(next, LinkOption.NOFOLLOW_LINKS)
                && !Files.isDirectory(next, LinkOption.NOFOLLOW_LINKS)) {
                throw ioError("agent-internal path segment is not a directory");
            }
            current = next;
        }
        return current;
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
            Path lockDirectory = internalPath(JOURNAL_DIRECTORY);
            Files.createDirectories(lockDirectory);
            // NOFOLLOW: a pre-planted lock symlink must not redirect the advisory lock outside
            // the project root; internalPath has already rejected an existing symlinked name.
            Path lockFile = internalPath(JOURNAL_DIRECTORY + "/" + operationId + ".lock");
            try (FileChannel channel = FileChannel.open(lockFile, StandardOpenOption.CREATE,
                StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
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

    /**
     * The single write chokepoint for every managed path (journal bodies, manifest, workspace
     * targets, receipt): the parent chain, the exact FINAL name and the exact TEMP name are all
     * checked WITHOUT following links, and the temp file is opened NOFOLLOW — so a pre-planted
     * symlink at any of these names, including the fixed temp file name, fails closed before
     * any content is written through it. The rename itself never traverses a symlink.
     */
    private void writeAtomic(Path target, byte[] content) {
        try {
            Files.createDirectories(target.getParent());
            Path temp = target.resolveSibling("." + target.getFileName() + ".python-deps-tmp");
            validateWritePath(target, temp);
            try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE,
                StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.CREATE,
                LinkOption.NOFOLLOW_LINKS)) {
                writeFully(channel, content);
                channel.force(true);
            }
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

    /**
     * Writes the whole buffer before the caller fsyncs and renames: a single {@code write()}
     * call is not guaranteed to drain the buffer, and a short write published through the
     * rename would be a truncated journal or workspace file that no retry can restore.
     */
    static void writeFully(java.nio.channels.WritableByteChannel channel, byte[] content) throws IOException {
        java.nio.ByteBuffer buffer = java.nio.ByteBuffer.wrap(content);
        int emptyWrites = 0;
        while (buffer.hasRemaining()) {
            int written = channel.write(buffer);
            if (written > 0) {
                emptyWrites = 0;
            } else if (++emptyWrites > MAX_CONSECUTIVE_EMPTY_WRITES) {
                // The channel contract permits zero-byte writes; a bounded run of them with
                // bytes still remaining is failure, not something to spin on.
                throw ioError("short write while persisting the managed file");
            }
        }
    }

    /**
     * No-follow write-path validation: every existing parent segment must be a real directory,
     * and the exact final and temp names must be absent or regular files — a planted symlink
     * at any of them rejects the write before content touches the disk.
     */
    private void validateWritePath(Path finalPath, Path tempPath) {
        Path current;
        try {
            current = projectRoot.toRealPath();
        } catch (IOException ex) {
            throw ioError("project directory is unavailable");
        }
        for (Path segment : projectRoot.relativize(finalPath.getParent().normalize())) {
            Path next = current.resolve(segment.toString());
            if (Files.isSymbolicLink(next)
                || (Files.exists(next, LinkOption.NOFOLLOW_LINKS)
                    && !Files.isDirectory(next, LinkOption.NOFOLLOW_LINKS))) {
                throw ioError("managed write path must not traverse a symbolic link");
            }
            current = next;
        }
        validateNoFollowRegular(finalPath);
        validateNoFollowRegular(tempPath);
    }

    private static void validateNoFollowRegular(Path path) {
        if (Files.isSymbolicLink(path)
            || (Files.exists(path, LinkOption.NOFOLLOW_LINKS)
                && !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))) {
            throw ioError("managed write path must not be a symbolic link");
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
