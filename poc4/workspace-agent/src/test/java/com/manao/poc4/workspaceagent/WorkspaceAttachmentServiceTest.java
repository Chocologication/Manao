package com.manao.poc4.workspaceagent;

import static org.assertj.core.api.Assertions.*;
import java.nio.file.*;
import java.time.*;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class WorkspaceAttachmentServiceTest {
    @TempDir Path root;
    @Test void attachmentIoRejectsNonUuidAndModifiedOriginals() throws Exception {
        var service=new WorkspaceAttachmentService(root,Clock.systemUTC());String id=UUID.randomUUID().toString();
        long deadline=Instant.now().plusSeconds(86400).toEpochMilli();byte[] bytes={1,2,3};
        assertThatThrownBy(()->service.put("../outside",sha(bytes),deadline,bytes)).isInstanceOfSatisfying(WorkspaceAttachmentService.Failure.class,ex->assertThat(ex.status).isEqualTo(422));
        service.put(id,sha(bytes),deadline,bytes);
        Files.write(root.resolve(".manao/attachments/"+id),new byte[]{3,2,1});
        assertThatThrownBy(()->service.open(id,sha(bytes),deadline)).isInstanceOfSatisfying(WorkspaceAttachmentService.Failure.class,ex->assertThat(ex.status).isEqualTo(503));
    }
    @Test void attachmentIoRejectsSymlinks() throws Exception {
        var service=new WorkspaceAttachmentService(root,Clock.systemUTC());
        long deadline=Instant.now().plusSeconds(86400).toEpochMilli();byte[] bytes={1,2,3};
        String linked=UUID.randomUUID().toString();Files.write(root.resolve("user.png"),bytes);
        Files.createDirectories(root.resolve(".manao/attachments"));
        createSymbolicLink(root.resolve(".manao/attachments/"+linked),root.resolve("user.png"));
        assertThatThrownBy(()->service.put(linked,sha(bytes),deadline,bytes)).isInstanceOfSatisfying(WorkspaceAttachmentService.Failure.class,ex->assertThat(ex.status).isEqualTo(503));
    }
    @Test void ordinaryFileApiCannotFollowAnAliasIntoInternalAttachments() throws Exception {
        Files.createDirectories(root.resolve(".manao/attachments"));
        Files.write(root.resolve(".manao/attachments/image"), new byte[]{7});
        createSymbolicLink(root.resolve("alias"), root.resolve(".manao"));
        assertThatThrownBy(()->new WorkspaceFileService(root).download("alias/attachments/image"))
            .isInstanceOf(WorkspacePathPolicy.InvalidPathException.class);
    }
    @Test void confirmedDeleteRejectsAStillValidLateUploadAcrossServiceInstances() {
        String id=UUID.randomUUID().toString();byte[] bytes={3,4};
        var service=new WorkspaceAttachmentService(root,Clock.systemUTC());
        service.delete(id);
        assertThatThrownBy(()->new WorkspaceAttachmentService(root,Clock.systemUTC())
            .put(id,sha(bytes),Instant.now().plusSeconds(86400).toEpochMilli(),bytes))
            .isInstanceOfSatisfying(WorkspaceAttachmentService.Failure.class,ex->assertThat(ex.status).isEqualTo(410));
        assertThat(Files.exists(root.resolve(".manao/attachments/"+id))).isFalse();
    }
    private static String sha(byte[] bytes){try{return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));}catch(Exception ex){throw new RuntimeException(ex);}}
    private static void createSymbolicLink(Path link, Path target) throws Exception {
        try {
            Files.createSymbolicLink(link, target);
        } catch (UnsupportedOperationException ex) {
            org.junit.jupiter.api.Assumptions.abort("Symbolic links are unsupported by this filesystem");
        } catch (FileSystemException ex) {
            // Windows requires a privilege unavailable to ordinary local test processes.
            String reason = String.valueOf(ex.getReason()).toLowerCase(java.util.Locale.ROOT);
            if (System.getProperty("os.name").startsWith("Windows")
                    && (reason.contains("privilege") || reason.contains("权限") || reason.contains("特权"))) {
                org.junit.jupiter.api.Assumptions.abort("Windows symbolic-link privilege unavailable");
            }
            throw ex;
        }
    }
    @Test void slowUploadAndDeletionSerializeAndCannotRenameAfterExpiry() throws Exception {
        String id=UUID.randomUUID().toString();byte[] bytes={8};
        var reachedRename=new java.util.concurrent.CountDownLatch(1);
        var release=new java.util.concurrent.CountDownLatch(1);
        Instant start=Instant.parse("2026-11-02T00:00:00Z");
        var current=new java.util.concurrent.atomic.AtomicReference<>(start);
        var reads=new java.util.concurrent.atomic.AtomicInteger();
        Clock clock=new Clock(){public ZoneId getZone(){return ZoneOffset.UTC;}public Clock withZone(ZoneId z){return this;}public Instant instant(){
            if(reads.incrementAndGet()==2){reachedRename.countDown();try{if(!release.await(5,java.util.concurrent.TimeUnit.SECONDS))throw new AssertionError("rename release timed out");}catch(InterruptedException ex){throw new RuntimeException(ex);}}
            return current.get();}};
        var pool=java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            var upload=pool.submit(()->new WorkspaceAttachmentService(root,clock).put(id,sha(bytes),start.plusSeconds(86400).toEpochMilli(),bytes));
            assertThat(reachedRename.await(5,java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            var deletion=pool.submit(()->new WorkspaceAttachmentService(root,clock).delete(id));
            current.set(start.plusSeconds(86400));release.countDown();
            assertThatThrownBy(()->upload.get(5,java.util.concurrent.TimeUnit.SECONDS)).hasCauseInstanceOf(WorkspaceAttachmentService.Failure.class);
            deletion.get(5,java.util.concurrent.TimeUnit.SECONDS);
            assertThat(Files.exists(root.resolve(".manao/attachments/"+id))).isFalse();
            assertThat(Files.exists(root.resolve(".manao/attachments/"+id+".part"))).isFalse();
        }finally{release.countDown();pool.shutdownNow();}
    }
}
