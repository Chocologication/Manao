package com.manao.poc4.ai.studio;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import static com.manao.poc4.ai.studio.StudioContracts.*;
import com.manao.poc4.ai.*;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.workspace.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

class StudioCoreTest {
    static String id() { return UUID.randomUUID().toString(); }
    static class Harness implements AutoCloseable {
        final JdbcStoreTestSupport db = JdbcStoreTestSupport.create();
        final org.springframework.jdbc.core.JdbcTemplate jdbc = db.jdbc();
        final String owner = id(), other = id(), project = id(), conversation = id(), modelId = id(), turn = id();
        final Map<String, String> files = new HashMap<>();
        final Map<String, WorkspaceAgent.FetchedReceipt> receipts = new HashMap<>();
        boolean loseWriteResponse;
        final WorkspaceAgent agent = mock(WorkspaceAgent.class);
        final DevelopmentBuildExecutor builds = mock(DevelopmentBuildExecutor.class);
        final ProjectLifecycleGate gate = new ProjectLifecycleGate();
        final AgentTaskStore tasks;
        final WorkspaceService workspace;
        final AgentProjectTools tools;
        final StudioStore store;
        final StudioProposals proposals;
        final StudioAttachments attachments;
        final StudioApply apply;
        Harness() {
            var now = new Timestamp(System.currentTimeMillis()); var tx = new DataSourceTransactionManager(jdbc.getDataSource());
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES (?,?,?,?)", owner, "owner-" + owner, "unused", now);
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES (?,?,?,?)", other, "other-" + other, "unused", now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES (?,?,'studio','READY',7,?,?)", project, owner, now, now);
            tasks = new AgentTaskStore(jdbc, tx, Clock.systemUTC());
            var ws = new WorkspaceJdbcStore(jdbc, tx); var operations = new WorkspaceOperationService(ws, agent, gate);
            workspace = new WorkspaceService(ws, operations, agent, gate, tasks);
            tools = new AgentProjectTools(tasks, ws, workspace, operations, gate, builds);
            store = new StudioStore(jdbc, tx); store.create(owner, project, conversation);
            var models = new StudioModelStore(jdbc, new StudioSecrets(Base64.getEncoder().encodeToString(new byte[32])));
            proposals = new StudioProposals(jdbc, workspace, models); tools.setStudio(proposals);
            attachments = new StudioAttachments(store, jdbc); apply = new StudioApply(store, proposals, workspace, tasks, tools, gate);
            files.put("README.md", "old heading\nkeep one\nkeep two\nold ending\n");
            when(agent.meta(eq(project), anyString())).thenAnswer(inv -> {
                String p = inv.getArgument(1), content = files.get(p); return content == null ? null : new WorkspaceAgent.FileMeta(p, p, (long)content.getBytes(StandardCharsets.UTF_8).length, "text/plain", "UTF-8", "text", "MONACO_TEXT", null, StudioStore.hash(content));
            });
            when(agent.content(eq(project), anyString())).thenAnswer(inv -> { String p = inv.getArgument(1); if (!files.containsKey(p)) throw new WorkspaceAgentException(404, "ENTRY_NOT_FOUND", "absent"); return new WorkspaceAgent.Content(p, files.get(p), StudioStore.hash(files.get(p))); });
            when(agent.tree(eq(project), anyString())).thenReturn(new WorkspaceAgent.Tree("", List.of(new WorkspaceAgent.TreeEntry("README.md", "README.md", "file", false, 20L, null))));
            when(agent.mutate(eq(project), any())).thenAnswer(inv -> {
                WorkspaceAgent.Command c = inv.getArgument(1); files.put(c.path(), new String(c.content(), StandardCharsets.UTF_8));
                receipts.put(c.operationId(), new WorkspaceAgent.FetchedReceipt(c.operationId(), c.type(), c.path(), c.nextPath(), c.expectedBeforeSha256(), c.expectedAfterSha256(), c.expectedReceiptSha256()));
                if (loseWriteResponse) { loseWriteResponse = false; throw new WorkspaceAgentException(503, "UNAVAILABLE", "response lost after durable write", WorkspaceAgentException.TransportFailure.RESET); }
                return new WorkspaceAgent.MutationResult(c.operationId(), c.path(), c.expectedBeforeSha256(), c.expectedAfterSha256(), WorkspaceOperationService.RECEIPT_PATH_PREFIX + c.operationId() + ".json", c.expectedReceiptSha256());
            });
            when(agent.receipt(eq(project), anyString())).thenAnswer(inv -> Optional.ofNullable(receipts.get(inv.getArgument(1))));
            when(builds.build(any())).thenReturn(new AgentContracts.BuildResult(new AgentContracts.BuildIdentity("job", "uid", "pod"), 0, "Completed", "BUILD SUCCESS", false, List.of(), true));
        }
        TurnInput input(String mode) { return new TurnInput(turn, "explain and improve the current project", mode, "REVIEW", modelId, "7", List.of(), List.of()); }
        void prepare() {
            var environment = new AgentProjectEnvironment(1, "java-console", "java", "none", "task", "com.example.app.App",
                null, null, null, false, false, "java-v1", List.of("compile", "test", "package"), List.of(),
                List.of("list_files", "read_file", "write_file", "build", "application", "read_image"));
            prepare(environment);
        }
        void prepare(AgentProjectEnvironment environment) {
            store.start(owner, project, conversation, input("TASK"));
            tasks.createTask(owner, project, new AgentContracts.TaskRequest(turn, "Improve the current project", 7), null, () -> environment);
            proposals.prepare(owner, project, turn, modelId, "REVIEW", turn, 7);
        }
        AgentContracts.ToolResult write(String call, String path, String content, String sha) {
            var args = StudioStore.JSON.createObjectNode().put("path", path).put("content", content); if (sha != null) args.put("expectedSha256", sha);
            return tools.invoke(turn, new AgentContracts.ToolRequest(call, "write_file", 7, args));
        }
        void settle() { assertThat(tasks.applyTerminal(turn, AgentContracts.TaskState.COMPLETED, "Proposal ready", null)).isTrue(); }
        @Override public void close() { db.close(); }
    }
    @Test void encryptedSecretsBindOwnerAndModelAndNeverFallback() {
        var secrets = new StudioSecrets(Base64.getEncoder().encodeToString(new byte[32]));
        String cipher = secrets.encrypt("owner", "model", "example-key"); assertThat(cipher).doesNotContain("example-key");
        assertThat(secrets.decrypt("owner", "model", cipher)).isEqualTo("example-key");
        assertThatThrownBy(() -> secrets.decrypt("foreign", "model", cipher)).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> new StudioSecrets("").encrypt("o", "m", "k")).isInstanceOf(ApiException.class);
    }
    @Test void hunksSupportPartialAcceptanceAndFinalNewline() {
        var change = StudioDiff.change("src/Test.java", "old\na\nb\nc\nold tail\n", "new\na\nb\nc\nnew tail\n");
        assertThat(change.hunks()).hasSize(2);
        assertThat(StudioDiff.selected(change, Set.of(change.hunks().get(0).id()))).isEqualTo("new\na\nb\nc\nold tail\n");
        assertThat(StudioDiff.selected(StudioDiff.change("README.md", null, "new\n"), Set.of(StudioDiff.change("README.md", null, "new\n").hunks().get(0).id()))).isEqualTo("new\n");
        assertThat(StudioDiff.selected(change, Set.of())).isEqualTo(change.before());
    }
    @Test void privateAndMetadataAddressesAreRefused() throws Exception {
        for (String value : List.of("127.0.0.1", "10.1.1.1", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "::ffff:127.0.0.1"))
            assertThat(StudioModelStore.publicAddress(java.net.InetAddress.getByName(value))).isFalse();
        assertThat(StudioModelStore.publicAddress(java.net.InetAddress.getByName("8.8.8.8"))).isTrue();
        assertThatThrownBy(() -> StudioModelStore.validateAddress("http://example.com")).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> StudioModelStore.validateAddress("https://127.0.0.1/v1")).isInstanceOf(ApiException.class);
    }
    @Test void openAiSseParsesUnicodeReasoningAndSplitToolArguments() throws Exception {
        String events = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\",\"reasoning_content\":\"分析\",\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\r\n\r\n"
            + "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"README.md\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
        var result = StudioOpenAi.parse(new ByteArrayInputStream(events.getBytes(StandardCharsets.UTF_8)), new StudioOpenAi.Control(), ignored -> {});
        assertThat(result.text()).isEqualTo("你好"); assertThat(result.reasoning()).isEqualTo("分析"); assertThat(result.calls().get(0).arguments()).isEqualTo("{\"path\":\"README.md\"}");
        assertThatThrownBy(() -> StudioOpenAi.parse(new ByteArrayInputStream("data: {\"choices\":[]}\n\n".getBytes()), new StudioOpenAi.Control(), ignored -> {})).isInstanceOf(ApiException.class);
        var partial = new java.util.concurrent.atomic.AtomicReference<String>("");
        assertThatThrownBy(() -> StudioOpenAi.parse(new ByteArrayInputStream("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n".getBytes()), new StudioOpenAi.Control(), value -> partial.set(value.text()))).isInstanceOf(ApiException.class);
        assertThat(partial.get()).isEqualTo("partial");
    }
    @Test void chatUsesOnlyReadToolsAndHttpRoutesKeepOwnerBoundaries() throws Exception {
        try (var h = new Harness()) {
            var models = mock(StudioModelStore.class); var transport = mock(StudioOpenAi.class);
            var reads = new StudioReadTools(h.workspace, mock(com.manao.poc4.run.RunStore.class), mock(com.manao.poc4.log.RunLogService.class));
            var taskService = mock(AgentTaskService.class);
            when(models.resolve(h.owner, h.modelId)).thenReturn(new ModelSecret(h.modelId, "https://provider.invalid/v1", "mock", "test-secret", false, true));
            var called = new java.util.concurrent.atomic.AtomicInteger();
            when(transport.complete(any(), any(), any(), any())).thenAnswer(inv -> {
                java.util.function.Consumer<StudioOpenAi.Reply> update = inv.getArgument(3);
                var reply = called.getAndIncrement() == 0 ? new StudioOpenAi.Reply("Reading context.\n", "", List.of(new StudioOpenAi.Call("read", "read_file", "{\"path\":\"README.md\"}")))
                    : new StudioOpenAi.Reply("Project explained.", "", List.of());
                update.accept(reply); return reply;
            });
            try (var service = new StudioService(h.store, models, h.attachments, reads, transport, h.proposals, taskService, mock(AgentConversationService.class), h.gate);
                 var controller = new StudioController(h.store, service, models, h.attachments, h.apply, mock(com.manao.poc4.auth.UserStore.class))) {
                var mvc = org.springframework.test.web.servlet.setup.MockMvcBuilders.standaloneSetup(controller).setControllerAdvice(new com.manao.poc4.api.GlobalExceptionHandler()).build();
                var auth = new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(h.owner, "unused");
                var foreign = new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(h.other, "unused");
                String route = "/api/v1/projects/" + h.project + "/assistant/conversations/" + h.conversation + "/turns";
                mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(route).principal(auth).contentType("application/json").content(StudioStore.json(h.input("CHAT"))))
                    .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isOk());
                long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
                while (service.get(h.owner, h.project, h.turn).path("state").asText().equals("RUNNING") && System.nanoTime() < deadline) Thread.sleep(10);
                assertThat(service.get(h.owner, h.project, h.turn).path("state").asText()).isEqualTo("COMPLETED");
                assertThat(service.get(h.owner, h.project, h.turn).path("reply").asText()).contains("Project explained.");
                mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get(route).principal(foreign))
                    .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isNotFound());
                // Reconcile an already accepted request even if its model was later deleted.
                when(models.resolve(h.owner, h.modelId)).thenThrow(StudioStore.missing());
                mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(route).principal(auth).contentType("application/json").content(StudioStore.json(h.input("CHAT"))))
                    .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isOk());
                assertThat(called.get()).isEqualTo(2); verifyNoInteractions(taskService); verify(h.agent, never()).mutate(anyString(), any());
            }
        }
    }
    @Test void turnRequestsAreDurableIdempotentAndOwnerIsolated() {
        try (var h = new Harness()) {
            assertThat(h.store.start(h.owner, h.project, h.conversation, h.input("CHAT")).fresh()).isTrue();
            assertThat(h.store.start(h.owner, h.project, h.conversation, h.input("CHAT")).fresh()).isFalse();
            assertThatThrownBy(() -> h.store.turn(h.other, h.project, h.turn)).isInstanceOf(ApiException.class);
            var changed = new TurnInput(h.turn, "different goal", "CHAT", "REVIEW", h.modelId, "7", List.of(), List.of());
            assertThatThrownBy(() -> h.store.start(h.owner, h.project, h.conversation, changed)).isInstanceOf(ApiException.class);
            h.store.mutate(h.turn, t -> t.put("state", "STOPPING"));
            assertThatThrownBy(() -> h.store.start(h.owner, h.project, h.conversation, new TurnInput(id(), "another message", "CHAT", "REVIEW", h.modelId, "7", List.of(), List.of()))).isInstanceOf(ApiException.class);
        }
    }
    @Test void reviewWritesOnlyOverlayAndBuildReceivesIsolatedCandidate() {
        try (var h = new Harness()) {
            h.prepare(); String before = h.files.get("README.md"), after = before.replace("old heading", "new heading");
            assertThat(h.write("write-1", "README.md", after, StudioStore.hash(before)).data().path("staged").asBoolean()).isTrue();
            assertThat(h.files.get("README.md")).isEqualTo(before); assertThat(h.workspace.currentRevision(h.owner, h.project)).isEqualTo(7);
            var read = h.tools.invoke(h.turn, new AgentContracts.ToolRequest("read-1", "read_file", 7, StudioStore.JSON.createObjectNode().put("path", "README.md")));
            assertThat(read.data().path("content").asText()).isEqualTo(after);
            h.tools.invoke(h.turn, new AgentContracts.ToolRequest("build-1", "build", 7, StudioStore.JSON.createObjectNode().put("goal", "test")));
            verify(h.builds).build(argThat(request -> after.equals(request.overlay().get("README.md"))));
            verify(h.agent, never()).mutate(anyString(), any());
            var app = h.tools.invoke(h.turn, new AgentContracts.ToolRequest("app-1", "application", 7, StudioStore.JSON.createObjectNode().put("action", "start")));
            assertThat(app.data().path("error").path("code").asText()).isEqualTo("AI_REVIEW_ISOLATED");
            var dependency = h.tools.invoke(h.turn, new AgentContracts.ToolRequest("dependency-1", "python_dependencies", 7,
                StudioStore.JSON.createObjectNode().put("action", "add").put("packageName", "pytest").put("group", "test")));
            assertThat(dependency.data().path("error").path("code").asText()).isEqualTo("AI_REVIEW_ISOLATED");
        }
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.EnumSource(PythonBuildEvidence.VerificationStatus.class)
    void pythonApplicationInheritsAuthorityAndRequiresActualPassingTests(PythonBuildEvidence.VerificationStatus status) throws Exception {
        try (var h = new Harness()) {
            var environment = AgentProjectEnvironment.fromJson(java.nio.file.Files.readString(
                java.nio.file.Path.of("../fixtures/agent-project-environment/python-fastapi-web.json")));
            h.prepare(environment); String before = h.files.get("README.md");
            h.write("proposal", "README.md", "updated documentation\n", StudioStore.hash(before)); h.settle();
            var evidence = new PythonBuildEvidence("python", "pytest", status, null, List.of(),
                new PythonBuildEvidence.TestSummary(1, 0, 0, 0, true));
            when(h.builds.build(any())).thenReturn(new AgentContracts.BuildResult(
                new AgentContracts.BuildIdentity("job", "uid", "pod"), 0, "Completed", "controlled test evidence", false, List.of(), true, evidence));
            var input = new ApplyInput(id(), List.of(h.proposals.changes(h.turn).get(0).hunks().get(0).id()), "7");
            var result = h.apply.apply(h.owner, h.project, h.turn, input);
            assertThat(result.path("state").asText()).isEqualTo(status == PythonBuildEvidence.VerificationStatus.PASS ? "COMPLETED" : "VALIDATION_FAILED");
            assertThat(h.tasks.environmentOf(input.requestId())).isEqualTo(environment);
            verify(h.builds).build(argThat(request -> environment.equals(request.environment()) && request.overlay().isEmpty()));
        }
    }
    @Test void selectedHunksApplyOnceAndValidateActualAcceptedVersion() {
        try (var h = new Harness()) {
            h.prepare(); String before = h.files.get("README.md"); h.write("proposal", "README.md", before.replace("old heading", "new heading").replace("old ending", "new ending"), StudioStore.hash(before)); h.settle();
            var changes = h.proposals.changes(h.turn); assertThat(changes.get(0).hunks()).hasSize(2);
            var input = new ApplyInput(id(), List.of(changes.get(0).hunks().get(0).id()), "7");
            var first = h.apply.apply(h.owner, h.project, h.turn, input); assertThat(first.path("state").asText()).isEqualTo("COMPLETED");
            assertThat(h.files.get("README.md")).contains("new heading", "old ending").doesNotContain("new ending");
            assertThat(h.apply.apply(h.owner, h.project, h.turn, input).toString()).isEqualTo(first.toString());
            verify(h.agent, times(1)).mutate(anyString(), any()); verify(h.builds, times(1)).build(argThat(request -> request.overlay().isEmpty() && request.sourceRevision() == 8));
            assertThatThrownBy(() -> h.apply.apply(h.other, h.project, h.turn, input)).isInstanceOf(ApiException.class);
        }
    }
    @Test void changedBasePreventsAnyWriteAndAllRejectLeavesProjectUntouched() {
        try (var h = new Harness()) {
            h.prepare(); String before = h.files.get("README.md"); h.write("proposal", "README.md", "new content", StudioStore.hash(before)); h.settle();
            h.jdbc.update("UPDATE project SET workspace_revision=8 WHERE id=?", h.project);
            var input = new ApplyInput(id(), List.of(h.proposals.changes(h.turn).get(0).hunks().get(0).id()), "7");
            assertThatThrownBy(() -> h.apply.apply(h.owner, h.project, h.turn, input)).isInstanceOf(ApiException.class);
            verify(h.agent, never()).mutate(anyString(), any());
            h.jdbc.update("UPDATE project SET workspace_revision=7 WHERE id=?", h.project);
            assertThat(h.apply.apply(h.owner, h.project, h.turn, new ApplyInput(id(), List.of(), "7")).path("state").asText()).isEqualTo("REJECTED");
            verifyNoInteractions(h.builds);
        }
    }
    @Test void lostWriteResponseReconcilesOriginalReceiptWithoutSecondMutation() {
        try (var h = new Harness()) {
            h.prepare(); String before = h.files.get("README.md");
            h.write("proposal", "README.md", before.replace("old heading", "new heading"), StudioStore.hash(before)); h.settle();
            var input = new ApplyInput(id(), List.of(h.proposals.changes(h.turn).get(0).hunks().get(0).id()), "7");
            h.loseWriteResponse = true;
            assertThatThrownBy(() -> h.apply.apply(h.owner, h.project, h.turn, input)).isInstanceOf(ApiException.class);
            assertThat(h.tasks.findForOwner(h.owner, h.project, input.requestId()).orElseThrow().writesLocked()).isTrue();
            assertThat(h.files.get("README.md")).contains("new heading");
            // A new service instance proves the application journal survives process memory loss.
            var restarted = new StudioApply(h.store, h.proposals, h.workspace, h.tasks, h.tools, h.gate);
            assertThat(restarted.apply(h.owner, h.project, h.turn, input).path("state").asText()).isEqualTo("COMPLETED");
            verify(h.agent, times(1)).mutate(anyString(), any());
            verify(h.agent).receipt(eq(h.project), eq(h.receipts.keySet().iterator().next()));
            verify(h.builds, times(1)).build(any());
        }
    }
    @Test void unknownBuildCleanupKeepsOccupancyAndOnlyObservesOriginalBuildOnRetry() {
        try (var h = new Harness()) {
            h.prepare(); String before = h.files.get("README.md");
            h.write("proposal", "README.md", before.replace("old heading", "new heading"), StudioStore.hash(before)); h.settle();
            var identity = new AgentContracts.BuildIdentity("build-job", "job-uid", "pod-uid");
            when(h.builds.build(any())).thenReturn(new AgentContracts.BuildResult(identity, 0, "Completed", "BUILD SUCCESS", false, List.of(), false));
            when(h.builds.observe(any(), eq(identity))).thenReturn(new AgentContracts.BuildResult(identity, 0, "Completed", "BUILD SUCCESS", false, List.of(), true));
            var input = new ApplyInput(id(), List.of(h.proposals.changes(h.turn).get(0).hunks().get(0).id()), "7");
            assertThatThrownBy(() -> h.apply.apply(h.owner, h.project, h.turn, input)).isInstanceOf(IllegalStateException.class);
            assertThat(h.tasks.findForOwner(h.owner, h.project, input.requestId()).orElseThrow().writesLocked()).isTrue();
            assertThat(h.apply.apply(h.owner, h.project, h.turn, input).path("state").asText()).isEqualTo("COMPLETED");
            verify(h.builds, times(1)).build(any()); verify(h.builds, times(1)).observe(any(), eq(identity));
            verify(h.agent, times(1)).mutate(anyString(), any());
        }
    }
    @Test void stoppedTurnWithRunningToolDoesNotBlockNextTurn() {
        try (var h = new Harness()) {
            h.store.start(h.owner, h.project, h.conversation, h.input("CHAT"));
            h.store.mutate(h.turn, t -> { t.put("state", "STOPPED"); t.withArray("tools").addObject().put("state", "RUNNING"); });
            assertThat(h.store.start(h.owner, h.project, h.conversation, new TurnInput(id(), "continue", "CHAT", "REVIEW", h.modelId, "7", List.of(), List.of())).fresh()).isTrue();
        }
    }
    @Test void readOnlyChatRejectsWritesAndProtectsCredentialPaths() {
        var reads = new StudioReadTools(mock(WorkspaceService.class), mock(com.manao.poc4.run.RunStore.class), mock(com.manao.poc4.log.RunLogService.class));
        assertThatThrownBy(() -> reads.invoke("o", "p", "write_file", StudioStore.JSON.createObjectNode())).isInstanceOf(ApiException.class);
        for (String path : List.of("../secret", "/etc/passwd", ".git/config", "src/.env", "src/.env.production", "target/test.txt")) assertThatThrownBy(() -> StudioReadTools.requirePath(path)).isInstanceOf(ApiException.class);
    }
    @Test void extractsTextPdfAndDocxWithoutTrustingMimeAndIsolatesAttachments() throws Exception {
        try (var h = new Harness()) {
            var text = h.attachments.upload(h.owner, h.project, new Upload("log.txt", "image/png", Base64.getEncoder().encodeToString("错误日志".getBytes(StandardCharsets.UTF_8))));
            assertThat(text.mediaType()).isEqualTo("text/plain"); assertThat(h.attachments.get(h.owner, h.project, text.id()).text()).isEqualTo("错误日志");
            assertThatThrownBy(() -> h.attachments.get(h.other, h.project, text.id())).isInstanceOf(ApiException.class);
            var out = new ByteArrayOutputStream();
            try (var doc = new org.apache.poi.xwpf.usermodel.XWPFDocument()) { doc.createParagraph().createRun().setText("Word project requirement"); doc.write(out); }
            var word = h.attachments.upload(h.owner, h.project, new Upload("requirements.docx", "text/plain", Base64.getEncoder().encodeToString(out.toByteArray())));
            assertThat(h.attachments.get(h.owner, h.project, word.id()).text()).contains("Word project requirement");
            out.reset();
            try (var pdf = new org.apache.pdfbox.pdmodel.PDDocument()) { var page = new org.apache.pdfbox.pdmodel.PDPage(); pdf.addPage(page); try (var content = new org.apache.pdfbox.pdmodel.PDPageContentStream(pdf, page)) { content.beginText(); content.setFont(new org.apache.pdfbox.pdmodel.font.PDType1Font(org.apache.pdfbox.pdmodel.font.Standard14Fonts.FontName.HELVETICA), 12); content.newLineAtOffset(10, 700); content.showText("PDF project requirement"); content.endText(); } pdf.save(out); }
            var pdf = h.attachments.upload(h.owner, h.project, new Upload("requirements.pdf", "image/png", Base64.getEncoder().encodeToString(out.toByteArray())));
            assertThat(h.attachments.get(h.owner, h.project, pdf.id()).text()).contains("PDF project requirement");
            assertThatThrownBy(() -> h.attachments.upload(h.owner, h.project, new Upload("invalid.png", "image/png", Base64.getEncoder().encodeToString(new byte[]{(byte)137,80,78,71,0,0,0,0,0})))).isInstanceOf(ApiException.class);
        }
    }
}
