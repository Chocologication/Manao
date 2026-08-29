package com.manao.poc4.workspaceagent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Performs project-relative file operations on the workspace volume. Mutations write data first
 * (temp file, fsync, atomic rename) and record a deterministic backend-issued receipt last, so a
 * crash anywhere before the receipt leaves the operation re-runnable and a receipt always proves
 * the data write completed.
 */
public final class WorkspaceFileService {
    public static final String RECEIPTS_DIRECTORY = ".manao/receipts";
    private static final long TEXT_LIMIT_BYTES = 20L * 1024 * 1024;
    private static final long MARKDOWN_LIMIT_BYTES = 50L * 1024 * 1024;
    private static final long DOWNLOAD_LIMIT_BYTES = 50L * 1024 * 1024;
    private static final ObjectMapper JSON = new ObjectMapper();

    private final Path projectRoot;

    public WorkspaceFileService(Path projectRoot) {
        this.projectRoot = projectRoot.normalize();
    }

    public record Tree(String directory, List<TreeEntry> entries) { }
    public record TreeEntry(String path, String name, String kind, boolean hidden, Long sizeBytes, Boolean hasChildren) { }
    public record FileMeta(String path, String name, Long sizeBytes, String mediaType, String encoding,
                           String language, String renderMode, String blockReason, String sha256) { }
    public record Content(String path, String content, String sha256) { }
    public record Download(String path, String mediaType, byte[] bytes) { }
    public record Command(String type, String path, String nextPath, String kind, String operationId, byte[] content,
                          String expectedBeforeSha256, String expectedAfterSha256,
                          String receiptJson, String expectedReceiptSha256) { }
    public record MutationResult(String operationId, String path, String beforeSha256, String afterSha256,
                                 String receiptPath, String receiptSha256) { }
    public record FetchedReceipt(String operationId, String type, String path, String nextPath,
                                 String beforeSha256, String afterSha256, String receiptSha256) { }

    public static final class WorkspaceFileException extends RuntimeException {
        private final String code;
        public WorkspaceFileException(String code, String message) {
            super(message);
            this.code = code;
        }
        public String code() { return code; }
    }

    public Tree tree(String directory) {
        Path dir = WorkspacePathPolicy.resolveDirectory(projectRoot, directory);
        if (!Files.isDirectory(dir)) throw new WorkspaceFileException("ENTRY_NOT_FOUND", "directory does not exist");
        List<TreeEntry> entries = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
            for (Path child : stream) {
                String name = child.getFileName().toString();
                String relative = joinPath(directory, name);
                boolean hidden = name.startsWith(".");
                if (WorkspacePathPolicy.INTERNAL_DIRECTORY.equals(name)) continue;
                if (Files.isDirectory(child)) {
                    entries.add(new TreeEntry(relative, name, "directory", hidden, null, hasChildren(child)));
                } else if (Files.isRegularFile(child, LinkOption.NOFOLLOW_LINKS)) {
                    entries.add(new TreeEntry(relative, name, "file", hidden, safeSize(child), null));
                }
            }
        } catch (IOException ex) {
            throw new WorkspaceFileException("IO_ERROR", "cannot list directory");
        }
        entries.sort((left, right) -> left.path().compareTo(right.path()));
        return new Tree(directory == null ? "" : directory, entries);
    }

    public FileMeta meta(String path) {
        Path resolved = WorkspacePathPolicy.resolve(projectRoot, path);
        if (!Files.exists(resolved, LinkOption.NOFOLLOW_LINKS)) {
            throw new WorkspaceFileException("ENTRY_NOT_FOUND", "entry does not exist");
        }
        return buildMeta(path, resolved);
    }

    public Content content(String path) {
        Path resolved = WorkspacePathPolicy.resolve(projectRoot, path);
        if (!Files.isRegularFile(resolved, LinkOption.NOFOLLOW_LINKS)) {
            throw new WorkspaceFileException("ENTRY_NOT_FOUND", "file does not exist");
        }
        byte[] bytes = readAll(resolved);
        FileMeta meta = classify(path, bytes);
        if (!"UTF-8".equals(meta.encoding())) {
            throw new WorkspaceFileException(meta.blockReason(), "file content is not served as text");
        }
        return new Content(path, new String(bytes, StandardCharsets.UTF_8), meta.sha256());
    }

    public Download download(String path) {
        Path resolved = WorkspacePathPolicy.resolve(projectRoot, path);
        if (!Files.isRegularFile(resolved, LinkOption.NOFOLLOW_LINKS)) {
            throw new WorkspaceFileException("ENTRY_NOT_FOUND", "file does not exist");
        }
        byte[] bytes = readAll(resolved);
        if (bytes.length > DOWNLOAD_LIMIT_BYTES) {
            throw new WorkspaceFileException("FILE_TOO_LARGE", "file exceeds the download size limit");
        }
        return new Download(path, classify(path, bytes).mediaType(), bytes);
    }

    public MutationResult save(Command command) {
        Path target = WorkspacePathPolicy.resolve(projectRoot, command.path());
        if (Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)) {
            throw new WorkspaceFileException("ENTRY_ALREADY_EXISTS", "a directory exists at this path");
        }
        byte[] content = command.content() == null ? new byte[0] : command.content();
        if (content.length > saveLimit(command.path())) {
            throw new WorkspaceFileException("FILE_TOO_LARGE", "content exceeds the save size limit");
        }
        EntryState state = state(target);
        String before = digestOf(state, command.path());
        String after = entryDigest("file", command.path(), sha256Hex(content));
        return execute(command, () -> {
            if (!after.equals(command.expectedAfterSha256())) {
                throw new WorkspaceFileException("OPERATION_CONFLICT", "workspace changed during the operation");
            }
            if (before.equals(after)) {
                return; // data write already completed (receipt lost); only the receipt is missing
            }
            if (!before.equals(command.expectedBeforeSha256())) {
                throw new WorkspaceFileException("OPERATION_CONFLICT", "workspace changed during the operation");
            }
            writeAtomic(target, content);
        }, before, after);
    }

    public MutationResult create(Command command) {
        if (!"file".equals(command.kind()) && !"directory".equals(command.kind())) {
            throw new WorkspaceFileException("VALIDATION_ERROR", "unsupported entry kind");
        }
        Path target = WorkspacePathPolicy.resolve(projectRoot, command.path());
        EntryState state = state(target);
        String before = digestOf(state, command.path());
        String after = "file".equals(command.kind())
            ? entryDigest("file", command.path(), sha256Hex(new byte[0]))
            : entryDigest("directory", command.path(), null);
        return execute(command, () -> {
            if (!after.equals(command.expectedAfterSha256())) {
                throw new WorkspaceFileException("OPERATION_CONFLICT", "workspace changed during the operation");
            }
            if (state.exists()) {
                // Ambiguity (own earlier create vs. foreign entry) is resolved by the backend via meta
                // verification; the agent reports the definite rejection.
                throw new WorkspaceFileException("ENTRY_ALREADY_EXISTS", "entry already exists");
            }
            Path parent = target.getParent();
            if (parent == null || !Files.isDirectory(parent)) {
                throw new WorkspaceFileException("ENTRY_NOT_FOUND", "parent directory does not exist");
            }
            if (!before.equals(command.expectedBeforeSha256())) {
                throw new WorkspaceFileException("OPERATION_CONFLICT", "workspace changed during the operation");
            }
            if ("file".equals(command.kind())) {
                writeAtomic(target, new byte[0]);
            } else {
                createDirectory(target);
            }
        }, before, after);
    }

    public MutationResult rename(Command command) {
        Path source = WorkspacePathPolicy.resolve(projectRoot, command.path());
        Path target = WorkspacePathPolicy.resolve(projectRoot, command.nextPath());
        EntryState sourceState = state(source);
        EntryState targetState = state(target);
        boolean directory = sourceState.exists() && sourceState.directory();
        String contentSha = sourceState.exists() && !directory ? sha256Hex(readAll(source)) : null;
        String before = sourceState.exists()
            ? (directory ? entryDigest("directory", command.path(), null) : entryDigest("file", command.path(), contentSha))
            : entryDigest("absent", command.path(), null);
        String after = directory ? entryDigest("directory", command.nextPath(), null)
            : entryDigest("file", command.nextPath(), contentSha);
        return execute(command, () -> {
            if (!after.equals(command.expectedAfterSha256())) {
                throw new WorkspaceFileException("OPERATION_CONFLICT", "workspace changed during the operation");
            }
            if (!sourceState.exists() && targetState.exists()) {
                String targetDigest = targetState.directory()
                    ? entryDigest("directory", command.nextPath(), null)
                    : entryDigest("file", command.nextPath(), sha256Hex(readAll(target)));
                if (targetDigest.equals(after)) {
                    return; // move already completed (receipt lost)
                }
                throw new WorkspaceFileException("OPERATION_CONFLICT", "workspace changed during the operation");
            }
            if (!sourceState.exists()) {
                throw new WorkspaceFileException("ENTRY_NOT_FOUND", "entry does not exist");
            }
            if (targetState.exists()) {
                throw new WorkspaceFileException("ENTRY_ALREADY_EXISTS", "target already exists");
            }
            if (!before.equals(command.expectedBeforeSha256())) {
                throw new WorkspaceFileException("OPERATION_CONFLICT", "workspace changed during the operation");
            }
            moveAtomic(source, target);
        }, before, after);
    }

    public MutationResult delete(Command command) {
        Path target = WorkspacePathPolicy.resolve(projectRoot, command.path());
        EntryState state = state(target);
        boolean directory = state.exists() && state.directory();
        String contentSha = state.exists() && !directory ? sha256Hex(readAll(target)) : null;
        String before = state.exists()
            ? (directory ? entryDigest("directory", command.path(), null) : entryDigest("file", command.path(), contentSha))
            : entryDigest("absent", command.path(), null);
        String after = entryDigest("absent", command.path(), null);
        return execute(command, () -> {
            if (!after.equals(command.expectedAfterSha256())) {
                throw new WorkspaceFileException("OPERATION_CONFLICT", "workspace changed during the operation");
            }
            if (!state.exists()) {
                throw new WorkspaceFileException("ENTRY_NOT_FOUND", "entry does not exist");
            }
            if (directory && hasChildren(target)) {
                throw new WorkspaceFileException("DIRECTORY_NOT_EMPTY", "directory is not empty");
            }
            if (!before.equals(command.expectedBeforeSha256())) {
                throw new WorkspaceFileException("OPERATION_CONFLICT", "workspace changed during the operation");
            }
            try {
                Files.delete(target);
            } catch (IOException ex) {
                throw new WorkspaceFileException("IO_ERROR", "cannot delete entry");
            }
        }, before, after);
    }

    public Optional<FetchedReceipt> receipt(String operationId) {
        if (!WorkspacePathPolicy.isValidOperationId(operationId)) {
            throw new WorkspaceFileException("VALIDATION_ERROR", "invalid operation id");
        }
        Path receipt = projectRoot.resolve(RECEIPTS_DIRECTORY).resolve(operationId + ".json");
        if (!Files.isRegularFile(receipt)) return Optional.empty();
        byte[] bytes = readAll(receipt);
        String receiptSha256 = sha256Hex(bytes);
        try {
            JsonNode node = JSON.readTree(new String(bytes, StandardCharsets.UTF_8));
            return Optional.of(new FetchedReceipt(node.get("operationId").asText(), node.get("type").asText(),
                node.get("path").asText(), node.get("nextPath").asText(),
                node.get("beforeSha256").asText(), node.get("afterSha256").asText(), receiptSha256));
        } catch (Exception ex) {
            throw new WorkspaceFileException("IO_ERROR", "receipt is unreadable");
        }
    }

    private interface Body {
        void run();
    }

    /** Shared mutation pipeline: idempotent receipt replay, reality checks, body, then receipt write. */
    private MutationResult execute(Command command, Body body, String before, String after) {
        if (!WorkspacePathPolicy.isValidOperationId(command.operationId())) {
            throw new WorkspaceFileException("VALIDATION_ERROR", "invalid operation id");
        }
        Path receiptFile = projectRoot.resolve(RECEIPTS_DIRECTORY).resolve(command.operationId() + ".json");
        if (Files.isRegularFile(receiptFile)) {
            byte[] existing = readAll(receiptFile);
            String existingJson = new String(existing, StandardCharsets.UTF_8);
            if (existingJson.equals(command.receiptJson())
                && sha256Hex(existing).equals(command.expectedReceiptSha256())) {
                return new MutationResult(command.operationId(), command.path(), before, after,
                    RECEIPTS_DIRECTORY + "/" + command.operationId() + ".json", command.expectedReceiptSha256());
            }
            throw new WorkspaceFileException("OPERATION_CONFLICT", "operation id was already used with different parameters");
        }
        body.run();
        writeReceipt(receiptFile, command.receiptJson(), command.expectedReceiptSha256());
        return new MutationResult(command.operationId(), command.path(), before, after,
            RECEIPTS_DIRECTORY + "/" + command.operationId() + ".json", sha256Hex(command.receiptJson().getBytes(StandardCharsets.UTF_8)));
    }

    private void writeReceipt(Path receiptFile, String receiptJson, String expectedReceiptSha256) {
        String actual = sha256Hex(receiptJson.getBytes(StandardCharsets.UTF_8));
        if (!actual.equals(expectedReceiptSha256)) {
            throw new WorkspaceFileException("OPERATION_CONFLICT", "receipt digest does not match the receipt content");
        }
        try {
            Files.createDirectories(receiptFile.getParent());
            Path temp = receiptFile.resolveSibling(receiptFile.getFileName() + ".tmp");
            Files.write(temp, receiptJson.getBytes(StandardCharsets.UTF_8),
                StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.CREATE);
            force(temp);
            moveAtomic(temp, receiptFile);
        } catch (IOException ex) {
            throw new WorkspaceFileException("IO_ERROR", "cannot record operation receipt");
        }
    }

    private void writeAtomic(Path target, byte[] content) {
        try {
            Files.createDirectories(target.getParent());
            Path temp = target.resolveSibling("." + target.getFileName() + ".manao-tmp");
            Files.write(temp, content, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.CREATE);
            force(temp);
            moveAtomic(temp, target);
        } catch (IOException ex) {
            throw new WorkspaceFileException("IO_ERROR", "cannot write file");
        }
    }

    private void createDirectory(Path target) {
        try {
            // mkdir -p semantics: the requested leaf directory is the operation's entry.
            Files.createDirectories(target);
            forceDirectory(target.getParent());
        } catch (IOException ex) {
            throw new WorkspaceFileException("IO_ERROR", "cannot create directory");
        }
    }

    private void moveAtomic(Path source, Path target) {
        try {
            try {
                Files.move(source, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ex) {
                Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);
            }
            forceDirectory(target.getParent());
        } catch (IOException ex) {
            throw new WorkspaceFileException("IO_ERROR", "cannot move entry");
        }
    }

    private static void force(Path file) throws IOException {
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.WRITE)) {
            channel.force(true);
        }
    }

    private static void forceDirectory(Path directory) {
        // Directory fsync is unsupported on some platforms (e.g. Windows); the receipt fsync carries the durability proof.
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) {
            channel.force(true);
        } catch (IOException ignored) { }
    }

    private FileMeta buildMeta(String path, Path resolved) {
        if (Files.isDirectory(resolved, LinkOption.NOFOLLOW_LINKS)) {
            return new FileMeta(path, nameOf(path), null, "inode/directory", null, "", "MONACO_TEXT", null, null);
        }
        return classify(path, readAll(resolved));
    }

    private FileMeta classify(String path, byte[] bytes) {
        String name = nameOf(path);
        boolean binary = isBinary(bytes);
        String encoding;
        String blockReason;
        String renderMode;
        if (binary) {
            encoding = null;
            renderMode = "BLOCKED";
            blockReason = "BINARY_FILE";
        } else if (!isValidUtf8(bytes)) {
            encoding = null;
            renderMode = "BLOCKED";
            blockReason = "UNSUPPORTED_ENCODING";
        } else if (bytes.length > sizeLimit(path)) {
            encoding = "UTF-8";
            renderMode = "BLOCKED";
            blockReason = "FILE_TOO_LARGE";
        } else {
            encoding = "UTF-8";
            blockReason = null;
            renderMode = isMarkdown(name) && bytes.length > TEXT_LIMIT_BYTES ? "PLAIN_TEXT" : "MONACO_TEXT";
        }
        return new FileMeta(path, name, (long) bytes.length, mediaTypeFor(name), encoding,
            languageFor(name), renderMode, blockReason, "UTF-8".equals(encoding) ? sha256Hex(bytes) : null);
    }

    private static long sizeLimit(String path) {
        return isMarkdown(nameOf(path)) ? MARKDOWN_LIMIT_BYTES : TEXT_LIMIT_BYTES;
    }

    private static long saveLimit(String path) {
        return sizeLimit(path);
    }

    private static boolean isMarkdown(String name) { return name.endsWith(".md"); }

    private static boolean isBinary(byte[] bytes) {
        int sample = Math.min(bytes.length, 8192);
        for (int i = 0; i < sample; i++) {
            if (bytes[i] == 0) return true;
        }
        return false;
    }

    private static boolean isValidUtf8(byte[] bytes) {
        try {
            java.nio.charset.CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
            decoder.decode(java.nio.ByteBuffer.wrap(bytes));
            return true;
        } catch (CharacterCodingException ex) {
            return false;
        }
    }

    private static String languageFor(String name) {
        if (name.endsWith(".java")) return "java";
        if (name.endsWith(".xml")) return "xml";
        if (name.endsWith(".md")) return "markdown";
        if (name.equals(".gitignore")) return "ignore";
        if (name.endsWith(".png")) return "";
        return "plaintext";
    }

    private static String mediaTypeFor(String name) {
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".xml")) return "application/xml";
        if (name.endsWith(".md")) return "text/markdown";
        if (name.endsWith(".csv")) return "text/csv";
        return "text/plain";
    }

    private record EntryState(boolean exists, boolean directory, String contentSha) { }

    private EntryState state(Path path) {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return new EntryState(false, false, null);
        boolean directory = Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS);
        return new EntryState(true, directory, directory ? null : sha256Hex(readAll(path)));
    }

    private String digestOf(EntryState state, String path) {
        if (!state.exists()) return entryDigest("absent", path, null);
        return state.directory() ? entryDigest("directory", path, null) : entryDigest("file", path, state.contentSha());
    }

    private static boolean hasChildren(Path directory) {
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(directory)) {
            return stream.iterator().hasNext();
        } catch (IOException ex) {
            return false;
        }
    }

    private static Long safeSize(Path file) {
        try {
            return Files.size(file);
        } catch (IOException ex) {
            return null;
        }
    }

    private static byte[] readAll(Path file) {
        try {
            return Files.readAllBytes(file);
        } catch (IOException ex) {
            throw new WorkspaceFileException("IO_ERROR", "cannot read file");
        }
    }

    private static String nameOf(String path) {
        int index = path.lastIndexOf('/');
        return index == -1 ? path : path.substring(index + 1);
    }

    private static String joinPath(String directory, String name) {
        return directory == null || directory.isEmpty() ? name : directory + "/" + name;
    }

    static String entryDigest(String kind, String path, String contentSha256) {
        String payload = kind + "\n" + path + (contentSha256 == null ? "" : "\n" + contentSha256);
        return sha256Hex(payload.getBytes(StandardCharsets.UTF_8));
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
