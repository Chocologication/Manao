package com.manao.poc4.workspaceagent;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.util.HexFormat;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantLock;

/** Attachment-only disk protocol. Never touches workspace revisions or ordinary file receipts. */
public final class WorkspaceAttachmentService {
    public static final int MAX_BYTES = 10_000_000;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ReentrantLock[] LOCKS = new ReentrantLock[128];
    static { for (int i = 0; i < LOCKS.length; i++) LOCKS[i] = new ReentrantLock(); }
    private final Path root;
    private final Clock clock;
    public WorkspaceAttachmentService(Path root, Clock clock) { this.root = root.toAbsolutePath().normalize(); this.clock = clock; }
    public record Meta(String attachmentId, String sha256, long sizeBytes, long expiresAt) { }
    public static final class Failure extends RuntimeException {
        public final int status; public final String code;
        Failure(int status, String code) { super(code); this.status = status; this.code = code; }
    }
    public Meta put(String id, String digest, long expiresAt, byte[] bytes) {
        validId(id);
        if (bytes.length > MAX_BYTES) throw fail(413, "AI_ATTACHMENT_TOO_LARGE");
        if (digest == null || !digest.matches("[0-9a-f]{64}") || !sha(bytes).equals(digest)) throw fail(409, "AI_ATTACHMENT_CONFLICT");
        return locked(id, dir -> {
            active(expiresAt);
            if (Files.exists(dir.resolve(id + ".deleted"), LinkOption.NOFOLLOW_LINKS)) throw fail(410, "AI_ATTACHMENT_EXPIRED");
            Path file = safe(dir.resolve(id));
            Path manifest = safe(dir.resolve(id + ".json"));
            Meta meta = new Meta(id, digest, bytes.length, expiresAt);
            if (Files.exists(manifest, LinkOption.NOFOLLOW_LINKS)) {
                Meta previous = JSON.readValue(Files.readAllBytes(manifest), Meta.class);
                if (!previous.equals(meta)) throw fail(409, "AI_ATTACHMENT_CONFLICT");
            } else writeAtomic(manifest, JSON.writeValueAsBytes(meta));
            if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
                verify(file, meta);
                return meta;
            }
            Path part = safe(dir.resolve(id + ".part"));
            try {
                Files.write(part, bytes, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, LinkOption.NOFOLLOW_LINKS);
                try (var channel = FileChannel.open(part, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) { channel.force(true); }
                active(expiresAt); // A slow upload must not rename after its immutable deadline.
                Files.move(part, file, StandardCopyOption.ATOMIC_MOVE);
                active(expiresAt);
                return meta;
            } catch (Failure ex) { Files.deleteIfExists(file); throw ex; }
            finally { Files.deleteIfExists(part); }
        });
    }
    public Meta confirm(String id) { return locked(id, dir -> {
        Meta meta = meta(dir, id); active(meta.expiresAt()); verify(safe(dir.resolve(id)), meta); return meta;
    }); }
    public byte[] open(String id, String digest, long expiresAt) { return locked(id, dir -> {
        active(expiresAt);
        Meta meta = meta(dir, id);
        if (!meta.sha256().equals(digest) || meta.expiresAt() != expiresAt) throw fail(503, "AI_ATTACHMENT_UNAVAILABLE");
        byte[] bytes = verify(safe(dir.resolve(id)), meta);
        active(expiresAt); return bytes;
    }); }
    public void delete(String id) { locked(id, dir -> {
        // Durable tombstone plus the cross-process ID lock prevents a delayed upload resurrecting it.
        Path tombstone = safe(dir.resolve(id + ".deleted"));
        if (!Files.exists(tombstone, LinkOption.NOFOLLOW_LINKS)) writeAtomic(tombstone, new byte[0]);
        Files.deleteIfExists(safe(dir.resolve(id)));
        Files.deleteIfExists(safe(dir.resolve(id + ".part")));
        Files.deleteIfExists(safe(dir.resolve(id + ".json.part")));
        Files.deleteIfExists(safe(dir.resolve(id + ".json")));
        return null;
    }); }
    private Meta meta(Path dir, String id) throws IOException {
        if (Files.exists(safe(dir.resolve(id + ".deleted")), LinkOption.NOFOLLOW_LINKS)) throw fail(410, "AI_ATTACHMENT_EXPIRED");
        Path path = safe(dir.resolve(id + ".json"));
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) throw fail(404, "AI_ATTACHMENT_NOT_FOUND");
        return JSON.readValue(Files.readAllBytes(path), Meta.class);
    }
    private byte[] verify(Path path, Meta meta) throws IOException {
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.size(path) != meta.sizeBytes() || Files.size(path) > MAX_BYTES) throw fail(503, "AI_ATTACHMENT_UNAVAILABLE");
        byte[] bytes;
        try (var in = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) { bytes = in.readNBytes(MAX_BYTES + 1); }
        if (bytes.length != meta.sizeBytes() || !sha(bytes).equals(meta.sha256())) throw fail(503, "AI_ATTACHMENT_UNAVAILABLE");
        return bytes;
    }
    private Path directory() throws IOException {
        Path dir = root;
        safe(root);
        for (String name : new String[]{".manao", "attachments"}) {
            dir = safe(dir.resolve(name));
            try { Files.createDirectory(dir); } catch (FileAlreadyExistsException ignored) { }
            if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) throw fail(503, "AI_ATTACHMENT_UNAVAILABLE");
        }
        return dir;
    }
    private static Path safe(Path path) {
        for (Path p = path; p != null; p = p.getParent()) if (Files.isSymbolicLink(p)) throw fail(503, "AI_ATTACHMENT_UNAVAILABLE");
        return path;
    }
    private <T> T locked(String id, DiskAction<T> action) {
        validId(id);
        ReentrantLock mutex = LOCKS[(id.hashCode() & Integer.MAX_VALUE) % LOCKS.length];
        mutex.lock();
        try {
            Path dir = directory();
            try (var channel = FileChannel.open(safe(dir.resolve(id + ".lock")), StandardOpenOption.CREATE, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
                 var lock = channel.lock()) { return action.run(dir); }
        } catch (Failure ex) { throw ex; }
        catch (Exception ex) { throw fail(503, "AI_ATTACHMENT_UNAVAILABLE"); }
        finally { mutex.unlock(); }
    }
    private static void writeAtomic(Path target, byte[] bytes) throws IOException {
        Path part = safe(target.resolveSibling(target.getFileName() + ".part"));
        Files.write(part, bytes, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, LinkOption.NOFOLLOW_LINKS);
        try (var channel = FileChannel.open(part, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) { channel.force(true); }
        Files.move(part, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }
    private void active(long expiresAt) { if (!clock.instant().isBefore(Instant.ofEpochMilli(expiresAt))) throw fail(410, "AI_ATTACHMENT_EXPIRED"); }
    private static void validId(String id) { try { if (!UUID.fromString(id).toString().equals(id)) throw new IllegalArgumentException(); } catch (Exception ex) { throw fail(422, "VALIDATION_ERROR"); } }
    private static String sha(byte[] bytes) { try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); } catch (Exception ex) { throw new IllegalStateException(ex); } }
    private static Failure fail(int status, String code) { return new Failure(status, code); }
    @FunctionalInterface private interface DiskAction<T> { T run(Path dir) throws Exception; }
}
