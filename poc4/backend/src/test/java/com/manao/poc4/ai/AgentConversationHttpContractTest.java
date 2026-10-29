package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class AgentConversationHttpContractTest {
    @Test void contextRoutesAndOldRoutesEnforceActualStreamAndDeclaredBounds() throws Exception {
        var filter = new InternalBodyLimitFilter();
        for (String route : new String[] {"/internal/ai/tasks/task/context", "/internal/ai/tasks/task/context/extra",
                "/internal/ai/tasks/task/progress", "/internal/ai/tasks/task/calls/call"}) {
            int bytes = route.endsWith("/context") ? 4 * 1024 * 1024 + 1 : 600 * 1024;
            for (boolean declare : new boolean[] {false, true}) {
                var request = new MockHttpServletRequest("POST", route);
                request.setContent(new byte[bytes]);
                if (declare) request.addHeader("Content-Length", bytes);
                var response = new MockHttpServletResponse();
                var reached = new AtomicBoolean();
                filter.doFilter(request, response, (req, res) -> reached.set(true));
                assertThat(response.getStatus()).as(route).isEqualTo(413);
                assertThat(reached).isFalse();
            }
        }
    }

    @Test void browserConversationRoutesExposeOnlyOwnedHistoryAndBindTaskSubmission() throws Exception {
        try (var db = com.manao.poc4.persistence.JdbcStoreTestSupport.create()) {
            var jdbc = db.jdbc();
            var now = java.sql.Timestamp.from(java.time.Instant.parse("2026-10-19T00:00:00Z"));
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('owner','owner','unused',?)", now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('project','owner','project','READY',7,?,?)", now, now);
            var clock = java.time.Clock.fixed(now.toInstant(), java.time.ZoneOffset.UTC);
            var tx = new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource());
            var tasks = new AgentTaskStore(jdbc, tx, clock);
            var store = new AgentConversationStore(jdbc, tx, clock, tasks);
            var starts = new java.util.ArrayList<AgentContracts.WorkerStart>();
            var worker = new PiWorkerClient() {
                public AgentContracts.WorkerStatus start(AgentContracts.WorkerStart start) {
                    starts.add(start); return new AgentContracts.WorkerStatus(start.taskId(), "worker", "RUNNING");
                }
                public AgentContracts.WorkerStatus status(String task) { throw new AssertionError("Unexpected status"); }
                public AgentContracts.WorkerStatus stop(String task) { throw new AssertionError("Unexpected stop"); }
            };
            var service = new AgentTaskService(tasks, new com.manao.poc4.project.ProjectLifecycleGate(), worker, null);
            var mvc = org.springframework.test.web.servlet.setup.MockMvcBuilders.standaloneSetup(
                new AgentConversationController(new AgentConversationService(store), service),
                new AgentConversationInternalController(store))
                .setControllerAdvice(new com.manao.poc4.api.GlobalExceptionHandler()).build();
            String id = java.util.UUID.randomUUID().toString();
            var created = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .post("/api/v1/projects/project/conversations").principal(() -> "owner")
                .contentType("application/json").content("{\"conversationId\":\"" + id + "\"}" )).andReturn();
            assertThat(created.getResponse().getStatus()).isEqualTo(200);
            assertThat(created.getResponse().getContentAsString()).contains("\"nextReasoningEffort\":\"high\"");
            assertThat(starts).isEmpty();
            var foreign = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .get("/api/v1/projects/project/conversations/" + id).principal(() -> "foreign")).andReturn();
            assertThat(foreign.getResponse().getStatus()).isEqualTo(404);
            assertThat(foreign.getResponse().getContentAsString()).contains("AI_CONVERSATION_NOT_FOUND");
            var entries = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .get("/api/v1/projects/project/conversations/" + id + "/entries").principal(() -> "owner")).andReturn();
            assertThat(entries.getResponse().getStatus()).isEqualTo(200);
            assertThat(entries.getResponse().getContentAsString()).contains("\"items\":[]").doesNotContain("header", "payload", "cwd");
            String task = java.util.UUID.randomUUID().toString();
            String body = "{\"taskId\":\"" + task + "\",\"prompt\":\"goal\",\"expectedWorkspaceRevision\":\"7\",\"reasoningEffort\":\"max\"}";
            for (int replay = 0; replay < 2; replay++) {
                var submitted = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                    .post("/api/v1/projects/project/conversations/" + id + "/tasks").principal(() -> "owner")
                    .contentType("application/json").content(body)).andReturn();
                assertThat(submitted.getResponse().getStatus()).isEqualTo(200);
                assertThat(submitted.getResponse().getContentAsString()).contains("\"conversationId\":\"" + id + "\"");
            }
            assertThat(starts).hasSize(1);
            assertThat(starts.get(0).conversationId()).isEqualTo(id);
            assertThat(starts.get(0).reasoningEffort()).isEqualTo("max");
            var detail = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .get("/api/v1/projects/project/conversations/" + id).principal(() -> "owner")).andReturn();
            assertThat(detail.getResponse().getContentAsString()).contains("\"nextReasoningEffort\":\"max\"");
            var foreignTask = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .post("/api/v1/projects/project/conversations/" + java.util.UUID.randomUUID() + "/tasks").principal(() -> "owner")
                .contentType("application/json").content(body.replace(task, java.util.UUID.randomUUID().toString()))).andReturn();
            assertThat(foreignTask.getResponse().getStatus()).isEqualTo(404);
            assertThat(foreignTask.getResponse().getContentAsString()).contains("AI_CONVERSATION_NOT_FOUND");
            var internal = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .get("/internal/ai/tasks/" + task + "/context").header("X-Manao-Worker-Instance", "worker")
                .header("X-Manao-Worker-Epoch", "1")).andReturn();
            assertThat(internal.getResponse().getStatus()).isEqualTo(200);
            var json = new com.fasterxml.jackson.databind.ObjectMapper();
            var context = json.readTree(internal.getResponse().getContentAsString());
            assertThat(context.path("entries").get(0).path("entry").path("content").asText()).isEqualTo("goal");
            var append = new AgentConversationContracts.ContextAppend(1, context.path("header"), java.util.List.of(json.readTree(
                "{\"type\":\"message\",\"id\":\"answer\",\"timestamp\":\"2026-10-19T00:00:00Z\",\"parentId\":\"" + task + "\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"answer\"},{\"type\":\"thinking\",\"thinking\":\"PRIVATE\"}],\"signature\":\"PRIVATE\"}}")), null);
            var appended = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .post("/internal/ai/tasks/" + task + "/context").header("X-Manao-Worker-Instance", "worker")
                .header("X-Manao-Worker-Epoch", "1").contentType("application/json").content(json.writeValueAsBytes(append))).andReturn();
            assertThat(appended.getResponse().getStatus()).isEqualTo(200);
            assertThat(appended.getResponse().getContentAsString()).contains("\"headSeq\":2");
            var history = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .get("/api/v1/projects/project/conversations/" + id + "/entries").principal(() -> "owner")).andReturn();
            var browserItems = json.readTree(history.getResponse().getContentAsString()).path("items");
            assertThat(browserItems.get(1).path("contentIndex").asInt(-1)).isZero();
            assertThat(browserItems.get(1).path("modelTruncated").isBoolean()).isTrue();
            assertThat(browserItems.get(2).path("contentIndex").asInt(-1)).isEqualTo(1);
            assertThat(browserItems.get(2).path("kind").asText()).isEqualTo("thinking");
            assertThat(browserItems.get(2).path("text").asText()).isEqualTo("PRIVATE");
            assertThat(history.getResponse().getContentAsString()).contains("answer", "goal").doesNotContain("header", "signature");
            var missingFence = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .get("/internal/ai/tasks/" + task + "/context")).andReturn();
            assertThat(missingFence.getResponse().getStatus()).isEqualTo(422);
        }
    }
    @Test void onlyExactContextRoutesAcceptLargerBodies() throws Exception {
        var filter = new InternalBodyLimitFilter();
        for (String route : new String[] {"/internal/ai/tasks/task/context",
                "/internal/ai/conversations/conversation/compactions/request/result"}) {
            var request = new MockHttpServletRequest("POST", route);
            request.setContent(new byte[600 * 1024]);
            var reached = new AtomicBoolean();
            filter.doFilter(request, new MockHttpServletResponse(), (req, res) -> reached.set(true));
            assertThat(reached).as(route).isTrue();
        }
        var unsupported = new MockHttpServletRequest("POST", "/internal/ai/conversations/conversation/compactions/request/context");
        unsupported.setContent(new byte[600 * 1024]);
        var response = new MockHttpServletResponse();
        filter.doFilter(unsupported, response, (req, res) -> { throw new AssertionError("Unsupported writes retain the old body limit"); });
        assertThat(response.getStatus()).isEqualTo(413);
    }
}
