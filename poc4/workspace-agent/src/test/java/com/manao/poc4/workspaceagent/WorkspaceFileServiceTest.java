package com.manao.poc4.workspaceagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class WorkspaceFileServiceTest {
    private static final String PROJECT_ID = "0f2b1c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
    private static final Instant NOW = Instant.parse("2026-08-29T00:00:00Z");

    static KeyPair newKeyPair() throws Exception {
        return KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
    }

    static String sha256Hex(byte[] bytes) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) builder.append(String.format("%02x", b));
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    /** Mirrors the digest scheme both sides agree on: kind \n path [\n contentSha256]. */
    static String entryDigest(String kind, String path, String contentSha256) {
        String payload = kind + "\n" + path + (contentSha256 == null ? "" : "\n" + contentSha256);
        return sha256Hex(payload.getBytes(StandardCharsets.UTF_8));
    }

    static String digestOfState(Path root, String path) throws Exception {
        Path resolved = root.resolve(path);
        if (!Files.exists(resolved)) return entryDigest("absent", path, null);
        if (Files.isDirectory(resolved)) return entryDigest("directory", path, null);
        return entryDigest("file", path, sha256Hex(Files.readAllBytes(resolved)));
    }

    static String canonical(String method, String pathAndQuery, byte[] body, long issuedAt, String nonce) {
        return "v1\n" + method + "\n" + pathAndQuery + "\n" + sha256Hex(body) + "\n" + PROJECT_ID + "\n" + issuedAt + "\n" + nonce;
    }

    static String sign(KeyPair pair, String canonical) throws Exception {
        Signature signature = Signature.getInstance("Ed25519");
        signature.initSign(pair.getPrivate());
        signature.update(canonical.getBytes(StandardCharsets.UTF_8));
        return Base64.getUrlEncoder().withoutPadding().encodeToString(signature.sign());
    }

    static String header(KeyPair pair, String method, String pathAndQuery, byte[] body, long issuedAt, String nonce) throws Exception {
        String signature = sign(pair, canonical(method, pathAndQuery, body, issuedAt, nonce));
        return "v1." + PROJECT_ID + "." + issuedAt + "." + nonce + "." + signature;
    }

    static String receiptJson(String operationId, String type, String path, String nextPath, String beforeSha256, String afterSha256) {
        return "{\"operationId\":\"" + operationId + "\",\"type\":\"" + type + "\",\"path\":\"" + path
            + "\",\"nextPath\":\"" + nextPath + "\",\"beforeSha256\":\"" + beforeSha256
            + "\",\"afterSha256\":\"" + afterSha256 + "\"}";
    }

    static WorkspaceFileService.Command saveCommand(Path root, String path, String operationId, byte[] content) throws Exception {
        String before = Files.exists(root.resolve(path)) ? digestOfState(root, path) : entryDigest("absent", path, null);
        String after = entryDigest("file", path, sha256Hex(content));
        return command("SAVE", path, "", null, operationId, content, before, after);
    }

    static WorkspaceFileService.Command createCommand(Path root, String path, String operationId, String kind) throws Exception {
        String before = digestOfState(root, path);
        String after = "file".equals(kind) ? entryDigest("file", path, sha256Hex(new byte[0])) : entryDigest("directory", path, null);
        return command("CREATE", path, "", kind, operationId, new byte[0], before, after);
    }

    static WorkspaceFileService.Command renameCommand(Path root, String path, String nextPath, String operationId) throws Exception {
        String before = digestOfState(root, path);
        String kind = Files.isDirectory(root.resolve(path)) ? "directory" : "file";
        String contentSha = kind.equals("file") ? sha256Hex(Files.readAllBytes(root.resolve(path))) : null;
        String after = entryDigest(kind, nextPath, contentSha);
        return command("RENAME", path, nextPath, null, operationId, new byte[0], before, after);
    }

    static WorkspaceFileService.Command deleteCommand(Path root, String path, String operationId) throws Exception {
        String before = digestOfState(root, path);
        String after = entryDigest("absent", path, null);
        return command("DELETE", path, "", null, operationId, new byte[0], before, after);
    }

    private static WorkspaceFileService.Command command(String type, String path, String nextPath, String kind,
                                                        String operationId, byte[] content,
                                                        String before, String after) {
        String receipt = receiptJson(operationId, type, path, nextPath, before, after);
        return new WorkspaceFileService.Command(type, path, nextPath, kind, operationId, content,
            before, after, receipt, sha256Hex(receipt.getBytes(StandardCharsets.UTF_8)));
    }

    @Nested
    class CapabilityVerification {
        @Test
        void acceptsExactCanonicalSignature() throws Exception {
            KeyPair pair = newKeyPair();
            WorkspaceCapabilityVerifier verifier = new WorkspaceCapabilityVerifier(PROJECT_ID, rawPublicOf(pair), fixedClock());
            byte[] body = "hello".getBytes(StandardCharsets.UTF_8);
            String nonce = nonce(1);
            WorkspaceCapabilityVerifier.Verification verification =
                verifier.verify(header(pair, "PUT", "/agent/v1/content?path=a.txt", body, NOW.toEpochMilli(), nonce), "PUT", "/agent/v1/content?path=a.txt", body);
            assertThat(verification.projectId()).isEqualTo(PROJECT_ID);
        }

        @Test
        void rejectsWrongProjectScope() throws Exception {
            KeyPair pair = newKeyPair();
            WorkspaceCapabilityVerifier verifier = new WorkspaceCapabilityVerifier("other-project", rawPublicOf(pair), fixedClock());
            String capability = header(pair, "GET", "/agent/v1/tree?path=", new byte[0], NOW.toEpochMilli(), nonce(2));
            assertThatThrownBy(() -> verifier.verify(capability, "GET", "/agent/v1/tree?path=", new byte[0]))
                .isInstanceOf(WorkspaceCapabilityVerifier.RejectedException.class);
        }

        @Test
        void rejectsTamperedBodyHash() throws Exception {
            KeyPair pair = newKeyPair();
            WorkspaceCapabilityVerifier verifier = new WorkspaceCapabilityVerifier(PROJECT_ID, rawPublicOf(pair), fixedClock());
            String capability = header(pair, "PUT", "/agent/v1/content?path=a.txt", "real".getBytes(StandardCharsets.UTF_8), NOW.toEpochMilli(), nonce(3));
            assertThatThrownBy(() -> verifier.verify(capability, "PUT", "/agent/v1/content?path=a.txt", "fake".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(WorkspaceCapabilityVerifier.RejectedException.class);
        }

        @Test
        void rejectsClockSkewBeyondSixtySeconds() throws Exception {
            KeyPair pair = newKeyPair();
            WorkspaceCapabilityVerifier verifier = new WorkspaceCapabilityVerifier(PROJECT_ID, rawPublicOf(pair), fixedClock());
            verifier.verify(header(pair, "GET", "/agent/v1/tree?path=", new byte[0], NOW.minusSeconds(59).toEpochMilli(), nonce(4)), "GET", "/agent/v1/tree?path=", new byte[0]);
            assertThatThrownBy(() -> verifier.verify(header(pair, "GET", "/agent/v1/tree?path=", new byte[0], NOW.minusSeconds(61).toEpochMilli(), nonce(5)), "GET", "/agent/v1/tree?path=", new byte[0]))
                .isInstanceOf(WorkspaceCapabilityVerifier.RejectedException.class);
            assertThatThrownBy(() -> verifier.verify(header(pair, "GET", "/agent/v1/tree?path=", new byte[0], NOW.plusSeconds(61).toEpochMilli(), nonce(6)), "GET", "/agent/v1/tree?path=", new byte[0]))
                .isInstanceOf(WorkspaceCapabilityVerifier.RejectedException.class);
        }

        @Test
        void rejectsReplayedNonce() throws Exception {
            KeyPair pair = newKeyPair();
            WorkspaceCapabilityVerifier verifier = new WorkspaceCapabilityVerifier(PROJECT_ID, rawPublicOf(pair), fixedClock());
            String capability = header(pair, "GET", "/agent/v1/tree?path=", new byte[0], NOW.toEpochMilli(), nonce(7));
            verifier.verify(capability, "GET", "/agent/v1/tree?path=", new byte[0]);
            assertThatThrownBy(() -> verifier.verify(capability, "GET", "/agent/v1/tree?path=", new byte[0]))
                .isInstanceOf(WorkspaceCapabilityVerifier.RejectedException.class);
        }

        @Test
        void rejectsMalformedHeader() throws Exception {
            KeyPair pair = newKeyPair();
            WorkspaceCapabilityVerifier verifier = new WorkspaceCapabilityVerifier(PROJECT_ID, rawPublicOf(pair), fixedClock());
            assertThatThrownBy(() -> verifier.verify("garbage", "GET", "/agent/v1/tree?path=", new byte[0]))
                .isInstanceOf(WorkspaceCapabilityVerifier.RejectedException.class);
            assertThatThrownBy(() -> verifier.verify(null, "GET", "/agent/v1/tree?path=", new byte[0]))
                .isInstanceOf(WorkspaceCapabilityVerifier.RejectedException.class);
        }

        @Test
        void nonceCacheIsBoundedAndExpires() throws Exception {
            KeyPair pair = newKeyPair();
            MutableClock clock = new MutableClock(NOW);
            WorkspaceCapabilityVerifier verifier = new WorkspaceCapabilityVerifier(PROJECT_ID, rawPublicOf(pair), clock);
            String nonce = nonce(8);
            verifier.verify(header(pair, "GET", "/agent/v1/tree?path=", new byte[0], NOW.toEpochMilli(), nonce), "GET", "/agent/v1/tree?path=", new byte[0]);
            clock.advance(Duration.ofSeconds(121));
            // Re-signed capability reusing the nonce after its retention window must be accepted again.
            verifier.verify(header(pair, "GET", "/agent/v1/tree?path=", new byte[0], NOW.plusSeconds(121).toEpochMilli(), nonce), "GET", "/agent/v1/tree?path=", new byte[0]);
        }
    }

    @Nested
    class PathContainment {
        @Test
        void resolvesValidRelativePathUnderRoot(@TempDir Path root) throws Exception {
            Files.createDirectories(root.resolve("src/main/java"));
            assertThat(WorkspacePathPolicy.resolve(root, "src/main/java/App.java"))
                .isEqualTo(root.toRealPath().resolve("src/main/java/App.java"));
        }

        @Test
        void rejectsAbsolutePathTraversalAndReservedPrefix(@TempDir Path root) {
            assertThatThrownBy(() -> WorkspacePathPolicy.resolve(root, "/etc/passwd")).isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
            assertThatThrownBy(() -> WorkspacePathPolicy.resolve(root, "../escape")).isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
            assertThatThrownBy(() -> WorkspacePathPolicy.resolve(root, "src/../../escape")).isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
            assertThatThrownBy(() -> WorkspacePathPolicy.resolve(root, "a\\b.txt")).isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
            assertThatThrownBy(() -> WorkspacePathPolicy.resolve(root, "C:/temp/a.txt")).isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
            assertThatThrownBy(() -> WorkspacePathPolicy.resolve(root, "")).isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
            assertThatThrownBy(() -> WorkspacePathPolicy.resolve(root, "src//App.java")).isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
            assertThatThrownBy(() -> WorkspacePathPolicy.resolve(root, "src/./App.java")).isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
            assertThatThrownBy(() -> WorkspacePathPolicy.resolve(root, ".manao/receipts/x.json")).isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
            assertThatThrownBy(() -> WorkspacePathPolicy.resolve(root, ".manao")).isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        }

        @Test
        void rejectsSymlinkEscape(@TempDir Path root, @TempDir Path outside) throws Exception {
            Files.createDirectories(root.resolve("link"));
            Files.writeString(outside.resolve("secret.txt"), "secret");
            try {
                Files.createSymbolicLink(root.resolve("link/out"), outside);
            } catch (UnsupportedOperationException | java.io.IOException ex) {
                return;
            }
            assertThatThrownBy(() -> WorkspacePathPolicy.resolve(root, "link/out/secret.txt"))
                .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        }
    }

    @Nested
    class Reads {
        @Test
        void treeListsImmediateChildrenWithHiddenFlagAndExcludesInternalDirectory(@TempDir Path root) throws Exception {
            WorkspaceFileService service = new WorkspaceFileService(root);
            Files.createDirectories(root.resolve("src/main"));
            Files.writeString(root.resolve("src/App.java"), "class App {}");
            Files.writeString(root.resolve(".hidden"), "x");
            Files.createDirectories(root.resolve(".manao/receipts"));
            Files.writeString(root.resolve(".manao/receipts/a.json"), "{}");

            WorkspaceFileService.Tree tree = service.tree("");

            assertThat(tree.directory()).isEmpty();
            assertThat(tree.entries()).extracting(WorkspaceFileService.TreeEntry::path)
                .containsExactlyInAnyOrder(".hidden", "src");
            WorkspaceFileService.TreeEntry src = tree.entries().stream().filter(e -> e.path().equals("src")).findFirst().orElseThrow();
            assertThat(src.kind()).isEqualTo("directory");
            assertThat(src.hasChildren()).isTrue();
            assertThat(src.sizeBytes()).isNull();
            assertThat(src.hidden()).isFalse();
            WorkspaceFileService.TreeEntry nested = service.tree("src").entries().get(0);
            assertThat(nested.kind()).isEqualTo("file");
            assertThat(nested.hasChildren()).isNull();
            assertThat(nested.sizeBytes()).isEqualTo("class App {}".getBytes(StandardCharsets.UTF_8).length);
            assertThat(nested.name()).isEqualTo("App.java");
        }

        @Test
        void metaClassifiesTextBinaryAndEncoding(@TempDir Path root) throws Exception {
            WorkspaceFileService service = new WorkspaceFileService(root);
            Files.writeString(root.resolve("App.java"), "class App {}");
            Files.writeString(root.resolve("notes.md"), "# notes");
            Files.write(root.resolve("logo.png"), new byte[]{(byte) 0x89, 'P', 'N', 'G', 0x00, 0x01});
            Files.write(root.resolve("legacy.txt"), new byte[]{'c', 'a', 'f', (byte) 0xe9, '\n'});

            WorkspaceFileService.FileMeta java = service.meta("App.java");
            assertThat(java.renderMode()).isEqualTo("MONACO_TEXT");
            assertThat(java.language()).isEqualTo("java");
            assertThat(java.mediaType()).isEqualTo("text/plain");
            assertThat(java.encoding()).isEqualTo("UTF-8");
            assertThat(java.blockReason()).isNull();
            assertThat(java.sha256()).isEqualTo(sha256Hex("class App {}".getBytes(StandardCharsets.UTF_8)));
            assertThat(java.name()).isEqualTo("App.java");

            assertThat(service.meta("notes.md").mediaType()).isEqualTo("text/markdown");
            WorkspaceFileService.FileMeta png = service.meta("logo.png");
            assertThat(png.renderMode()).isEqualTo("BLOCKED");
            assertThat(png.blockReason()).isEqualTo("BINARY_FILE");
            assertThat(png.encoding()).isNull();
            WorkspaceFileService.FileMeta legacy = service.meta("legacy.txt");
            assertThat(legacy.renderMode()).isEqualTo("BLOCKED");
            assertThat(legacy.blockReason()).isEqualTo("UNSUPPORTED_ENCODING");
        }

        @Test
        void metaBlocksOversizedFilesByExtension(@TempDir Path root) throws Exception {
            WorkspaceFileService service = new WorkspaceFileService(root);
            byte[] large = new byte[20 * 1024 * 1024 + 1];
            java.util.Arrays.fill(large, (byte) 'a');
            Files.write(root.resolve("Big.java"), large);
            Files.write(root.resolve("big.md"), large);
            assertThat(service.meta("Big.java").blockReason()).isEqualTo("FILE_TOO_LARGE");
            assertThat(service.meta("big.md").renderMode()).isEqualTo("PLAIN_TEXT");
            assertThat(service.meta("big.md").blockReason()).isNull();
            byte[] markdown = new byte[50 * 1024 * 1024];
            java.util.Arrays.fill(markdown, (byte) 'a');
            Files.write(root.resolve("notes.md"), markdown);
            WorkspaceFileService.FileMeta meta = service.meta("notes.md");
            assertThat(meta.renderMode()).isEqualTo("PLAIN_TEXT");
            assertThat(meta.blockReason()).isNull();
        }

        @Test
        void contentReturnsTextAndRejectsBlockedFiles(@TempDir Path root) throws Exception {
            WorkspaceFileService service = new WorkspaceFileService(root);
            Files.writeString(root.resolve("App.java"), "class App {}");
            Files.write(root.resolve("logo.png"), new byte[]{0x00, 0x01, 0x02});
            assertThat(service.content("App.java").content()).isEqualTo("class App {}");
            assertThatThrownBy(() -> service.content("logo.png"))
                .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                    ex -> assertThat(ex.code()).isEqualTo("BINARY_FILE"));
            assertThatThrownBy(() -> service.content("missing.txt"))
                .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class,
                    ex -> assertThat(ex.code()).isEqualTo("ENTRY_NOT_FOUND"));
        }
    }

    @Nested
    class MutationsAndReceipts {
        @Test
        void saveWritesAtomicallyAndReturnsVerifiedReceipt(@TempDir Path root) throws Exception {
            WorkspaceFileService service = new WorkspaceFileService(root);
            Files.writeString(root.resolve("App.java"), "old");
            WorkspaceFileService.Command command = saveCommand(root, "App.java", "op-1", "new".getBytes(StandardCharsets.UTF_8));

            WorkspaceFileService.MutationResult result = service.save(command);

            assertThat(Files.readString(root.resolve("App.java"))).isEqualTo("new");
            assertThat(result.receiptPath()).isEqualTo(".manao/receipts/op-1.json");
            assertThat(result.receiptSha256()).isEqualTo(command.expectedReceiptSha256());
            assertThat(result.beforeSha256()).isEqualTo(command.expectedBeforeSha256());
            assertThat(result.afterSha256()).isEqualTo(command.expectedAfterSha256());
            assertThat(Files.readString(root.resolve(".manao/receipts/op-1.json"))).isEqualTo(command.receiptJson());
        }

        @Test
        void saveRejectsStaleBeforeDigestWithoutWriting(@TempDir Path root) throws Exception {
            WorkspaceFileService service = new WorkspaceFileService(root);
            Files.writeString(root.resolve("App.java"), "current");
            WorkspaceFileService.Command command = saveCommand(root, "App.java", "op-1", "x".getBytes(StandardCharsets.UTF_8));
            WorkspaceFileService.Command stale = new WorkspaceFileService.Command(command.type(), command.path(), command.nextPath(),
                command.kind(), command.operationId(), command.content(),
                entryDigest("file", "App.java", sha256Hex("different".getBytes(StandardCharsets.UTF_8))),
                command.expectedAfterSha256(), command.receiptJson(), command.expectedReceiptSha256());
            assertThatThrownBy(() -> service.save(stale))
                .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class, ex -> assertThat(ex.code()).isEqualTo("OPERATION_CONFLICT"));
            assertThat(Files.readString(root.resolve("App.java"))).isEqualTo("current");
            assertThat(service.receipt("op-1")).isEmpty();
        }

        @Test
        void saveReplayWithSameOperationIdIsIdempotent(@TempDir Path root) throws Exception {
            WorkspaceFileService service = new WorkspaceFileService(root);
            WorkspaceFileService.Command command = saveCommand(root, "App.java", "op-1", "x".getBytes(StandardCharsets.UTF_8));
            WorkspaceFileService.MutationResult first = service.save(command);
            WorkspaceFileService.MutationResult replay = service.save(command);
            assertThat(replay.receiptSha256()).isEqualTo(first.receiptSha256());
            assertThat(replay.afterSha256()).isEqualTo(first.afterSha256());
            assertThat(Files.readString(root.resolve("App.java"))).isEqualTo("x");
        }

        @Test
        void saveReplayWithDifferentReceiptForSameOperationIdFailsClosed(@TempDir Path root) throws Exception {
            WorkspaceFileService service = new WorkspaceFileService(root);
            service.save(saveCommand(root, "App.java", "op-1", "x".getBytes(StandardCharsets.UTF_8)));
            String tamperedReceipt = receiptJson("op-1", "SAVE", "App.java", "", "b".repeat(64), "c".repeat(64));
            WorkspaceFileService.Command tampered = new WorkspaceFileService.Command("SAVE", "App.java", "", null, "op-1",
                "x".getBytes(StandardCharsets.UTF_8), "a".repeat(64), "c".repeat(64), tamperedReceipt,
                sha256Hex(tamperedReceipt.getBytes(StandardCharsets.UTF_8)));
            assertThatThrownBy(() -> service.save(tampered))
                .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class, ex -> assertThat(ex.code()).isEqualTo("OPERATION_CONFLICT"));
        }

        @Test
        void createFileAndDirectoryRecordReceipts(@TempDir Path root) throws Exception {
            WorkspaceFileService service = new WorkspaceFileService(root);
            Files.createDirectories(root.resolve("src"));
            WorkspaceFileService.MutationResult fileResult = service.create(createCommand(root, "src/App.java", "op-1", "file"));
            assertThat(Files.exists(root.resolve("src/App.java"))).isTrue();
            assertThat(fileResult.afterSha256()).isNotNull();
            service.create(createCommand(root, "docs", "op-2", "directory"));
            assertThat(Files.isDirectory(root.resolve("docs"))).isTrue();
            assertThatThrownBy(() -> service.create(createCommand(root, "src/App.java", "op-3", "file")))
                .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class, ex -> assertThat(ex.code()).isEqualTo("ENTRY_ALREADY_EXISTS"));
            assertThatThrownBy(() -> service.create(createCommand(root, "missing/dir/App.java", "op-4", "file")))
                .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class, ex -> assertThat(ex.code()).isEqualTo("ENTRY_NOT_FOUND"));
        }

        @Test
        void renameMovesEntriesAndRejectsExistingTargets(@TempDir Path root) throws Exception {
            WorkspaceFileService service = new WorkspaceFileService(root);
            Files.createDirectories(root.resolve("src"));
            Files.writeString(root.resolve("src/App.java"), "class App {}");
            Files.writeString(root.resolve("src/Other.java"), "class Other {}");
            service.rename(renameCommand(root, "src/App.java", "src/Renamed.java", "op-1"));
            assertThat(Files.exists(root.resolve("src/App.java"))).isFalse();
            assertThat(Files.readString(root.resolve("src/Renamed.java"))).isEqualTo("class App {}");
            assertThatThrownBy(() -> service.rename(renameCommand(root, "src/Renamed.java", "src/Other.java", "op-2")))
                .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class, ex -> assertThat(ex.code()).isEqualTo("ENTRY_ALREADY_EXISTS"));
            assertThatThrownBy(() -> service.rename(renameCommand(root, "", "other", "op-3")))
                .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
        }

        @Test
        void deleteRequiresEmptyDirectoriesAndExistingEntries(@TempDir Path root) throws Exception {
            WorkspaceFileService service = new WorkspaceFileService(root);
            Files.createDirectories(root.resolve("src/main"));
            Files.writeString(root.resolve("src/main/App.java"), "class App {}");
            assertThatThrownBy(() -> service.delete(deleteCommand(root, "src", "op-1")))
                .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class, ex -> assertThat(ex.code()).isEqualTo("DIRECTORY_NOT_EMPTY"));
            service.delete(deleteCommand(root, "src/main/App.java", "op-2"));
            assertThat(Files.exists(root.resolve("src/main/App.java"))).isFalse();
            service.delete(deleteCommand(root, "src/main", "op-3"));
            assertThatThrownBy(() -> service.delete(deleteCommand(root, "src/main", "op-4")))
                .isInstanceOfSatisfying(WorkspaceFileService.WorkspaceFileException.class, ex -> assertThat(ex.code()).isEqualTo("ENTRY_NOT_FOUND"));
        }

        @Test
        void receiptSurvivesAgentRestartAndMissingReceiptIsReportedAbsent(@TempDir Path root) throws Exception {
            WorkspaceFileService first = new WorkspaceFileService(root);
            first.save(saveCommand(root, "App.java", "op-1", "x".getBytes(StandardCharsets.UTF_8)));
            WorkspaceFileService restarted = new WorkspaceFileService(root);
            assertThat(restarted.receipt("op-1")).isPresent();
            assertThat(restarted.receipt("op-unknown")).isEmpty();
        }

        @Test
        void dataFileWrittenBeforeReceiptIsRecoveredOnRetry(@TempDir Path root) throws Exception {
            WorkspaceFileService service = new WorkspaceFileService(root);
            WorkspaceFileService.Command command = saveCommand(root, "App.java", "op-1", "written".getBytes(StandardCharsets.UTF_8));
            service.save(command);
            Files.delete(root.resolve(".manao/receipts/op-1.json"));
            WorkspaceFileService.MutationResult recovered = service.save(command);
            assertThat(recovered.receiptSha256()).isEqualTo(command.expectedReceiptSha256());
            assertThat(Files.readString(root.resolve("App.java"))).isEqualTo("written");
            assertThat(Files.readString(root.resolve(".manao/receipts/op-1.json"))).isEqualTo(command.receiptJson());
        }
    }

    private static String nonce(int seed) {
        byte[] bytes = new byte[16];
        bytes[0] = (byte) seed;
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static byte[] rawPublicOf(KeyPair pair) {
        return Ed25519Keys.rawPublicFromX509(pair.getPublic().getEncoded());
    }

    private static Clock fixedClock() {
        return Clock.fixed(NOW, ZoneOffset.UTC);
    }

    private static final class MutableClock extends Clock {
        private Instant instant;
        MutableClock(Instant instant) { this.instant = instant; }
        void advance(Duration duration) { instant = instant.plus(duration); }
        @Override public ZoneOffset getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return instant; }
    }
}
