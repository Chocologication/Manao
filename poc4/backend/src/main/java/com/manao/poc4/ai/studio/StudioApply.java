package com.manao.poc4.ai.studio;

import static com.manao.poc4.ai.studio.StudioContracts.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.ai.*;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.workspace.WorkspaceService;
import java.util.HashSet;
import java.util.List;
import java.util.UUID;

/** Durable application journal: retries reconcile the original calls, never invent new writes. */
public final class StudioApply {
    private final StudioStore store;
    private final StudioProposals proposals;
    private final WorkspaceService workspace;
    private final AgentTaskStore tasks;
    private final AgentProjectTools tools;
    private final ProjectLifecycleGate gate;
    private final java.util.Set<String> executing = java.util.concurrent.ConcurrentHashMap.newKeySet();
    public StudioApply(StudioStore store, StudioProposals proposals, WorkspaceService workspace, AgentTaskStore tasks, AgentProjectTools tools, ProjectLifecycleGate gate) {
        this.store = store; this.proposals = proposals; this.workspace = workspace; this.tasks = tasks; this.tools = tools; this.gate = gate;
    }
    public ObjectNode apply(String owner, String project, String turnId, ApplyInput input) {
        if (!executing.add(turnId)) throw new ApiException("AI_BUSY", 409, "The original application is still in progress");
        try { return drive(owner, project, turnId, input); } finally { executing.remove(turnId); }
    }
    private ObjectNode drive(String owner, String project, String turnId, ApplyInput input) {
        store.turn(owner, project, turnId);
        if (input == null || input.hunkIds() == null || input.hunkIds().size() > 2000) throw StudioStore.invalid();
        StudioStore.uuid(input.requestId());
        String digest = StudioStore.hash(StudioStore.json(input));
        ObjectNode journal;
        try (var lease = acquire(project)) {
            var options = proposals.options(turnId);
            if (options == null || !"REVIEW".equals(options.policy())) throw StudioStore.invalid();
            var original = tasks.findForOwner(owner, project, turnId).orElseThrow(StudioStore::missing);
            if (original.writesLocked()) throw new ApiException("AI_TASK_ACTIVE", 409, "Wait until task cleanup is confirmed");
            journal = options.apply();
            if (!journal.isEmpty()) {
                if (!digest.equals(journal.path("digest").asText())) throw new ApiException("AI_APPLY_MISMATCH", 409, "Continue the original application request");
                if (List.of("COMPLETED", "REJECTED", "VALIDATION_FAILED").contains(journal.path("state").asText())) return publicJournal(journal);
            } else {
                long revision = StudioService.revision(input.expectedRevision());
                if (revision != options.revision() || workspace.currentRevision(owner, project) != revision)
                    throw new ApiException("WORKSPACE_REVISION_CONFLICT", 409, "Project changed after proposal creation; regenerate the proposal");
                var changes = proposals.changes(turnId); var selected = new HashSet<>(input.hunkIds());
                var known = changes.stream().flatMap(f -> f.hunks().stream()).map(Hunk::id).collect(java.util.stream.Collectors.toSet());
                if (!known.containsAll(selected) || selected.size() != input.hunkIds().size()) throw StudioStore.invalid();
                journal.put("requestId", input.requestId()).put("digest", digest).put("state", "APPLYING").put("baseRevision", revision).put("taskId", input.requestId());
                journal.set("hunkIds", StudioStore.JSON.valueToTree(input.hunkIds()));
                var files = journal.putArray("files");
                for (var change : changes) {
                    if (change.hunks().stream().noneMatch(h -> selected.contains(h.id()))) continue;
                    String actual = null;
                    try { actual = workspace.content(owner, project, change.path()).sha256(); }
                    catch (ApiException ex) { if (!"ENTRY_NOT_FOUND".equals(ex.code())) throw ex; }
                    if (!java.util.Objects.equals(actual, change.beforeSha256())) throw new ApiException("WORKSPACE_REVISION_CONFLICT", 409, "A proposed file has changed");
                    var file = files.addObject().put("path", change.path()).put("content", StudioDiff.selected(change, selected))
                        .put("callId", UUID.randomUUID().toString()).put("revision", revision + files.size() - 1);
                    if (change.beforeSha256() == null) file.putNull("beforeSha256"); else file.put("beforeSha256", change.beforeSha256());
                }
                journal.put("buildCallId", UUID.randomUUID().toString());
                if (files.isEmpty()) journal.put("state", "REJECTED");
                proposals.journal(turnId, journal); // Commit stable identities before any external mutation.
            }
            if ("REJECTED".equals(journal.path("state").asText())) return publicJournal(journal);
            var request = new AgentContracts.TaskRequest(input.requestId(), "Apply selected assistant changes " + digest, journal.path("baseRevision").asLong(), "off");
            // Application inherits the reviewed task's trusted environment, never browser input.
            var creation = tasks.createTask(owner, project, request, null, () -> tasks.environmentOf(turnId));
            if (!creation.snapshot().writesLocked() && !"VALIDATING".equals(journal.path("state").asText()))
                throw new ApiException("AI_APPLY_INTERRUPTED", 409, "The application task has closed; inspect applied files before starting another task");
        }
        try {
            for (var file : journal.withArray("files")) {
                var args = StudioStore.JSON.createObjectNode().put("path", file.path("path").asText()).put("content", file.path("content").asText());
                args.set("expectedSha256", file.path("beforeSha256"));
                var result = tools.resumeStudioCall(input.requestId(), new AgentContracts.ToolRequest(file.path("callId").asText(), "write_file", file.path("revision").asLong(), args));
                if (result.data().has("error")) throw new ApiException("AI_APPLY_CONFLICT", 409, "A selected file could not be applied; inspect the original application task");
            }
            journal.put("state", "VALIDATING"); proposals.journal(turnId, journal);
            long current = journal.path("baseRevision").asLong() + journal.withArray("files").size();
            var result = tools.resumeStudioCall(input.requestId(), new AgentContracts.ToolRequest(journal.path("buildCallId").asText(), "build", current,
                StudioStore.JSON.createObjectNode().put("goal", "test")));
            journal.set("validation", result.data()); journal.put("workspaceRevision", result.workspaceRevision());
            boolean pass = !result.data().has("error") && result.data().path("exitCode").isInt() && result.data().path("exitCode").asInt() == 0
                && result.data().path("cleanupConfirmed").asBoolean();
            if ("python".equals(tasks.environmentOf(input.requestId()).language())) {
                var data = result.data(); var summary = data.path("testSummary");
                pass = pass && "pytest".equals(data.path("checkKind").asText())
                    && "PASS".equals(data.path("verificationStatus").asText())
                    && summary.path("reportComplete").asBoolean() && summary.path("tests").asInt() > 0
                    && summary.path("failures").asInt() == 0 && summary.path("errors").asInt() == 0;
            }
            try (var lease = acquire(project)) {
                tasks.applyTerminal(input.requestId(), pass ? AgentContracts.TaskState.COMPLETED : AgentContracts.TaskState.FAILED,
                    pass ? "Selected changes applied and tests passed" : "Selected changes applied; validation did not pass", pass ? null : "AI_VALIDATION_FAILED");
            }
            journal.put("state", pass ? "COMPLETED" : "VALIDATION_FAILED"); proposals.journal(turnId, journal);
            return publicJournal(journal);
        } catch (RuntimeException ex) {
            // Keep call ids and occupancy: transport failure does not prove a write/build failed.
            journal.put("error", ex instanceof ApiException api ? api.code() : "AI_APPLY_UNCONFIRMED"); proposals.journal(turnId, journal);
            throw ex;
        }
    }
    public ObjectNode status(String owner, String project, String turn) { store.turn(owner, project, turn); var options = proposals.options(turn); return options == null ? StudioStore.JSON.createObjectNode() : publicJournal(options.apply()); }
    public List<ObjectNode> pending(String owner, String project) {
        store.requireProject(owner, project);
        return proposals.pendingApplications(owner, project).stream().map(id -> publicJournal(proposals.options(id).apply()).put("turnId", id)).toList();
    }
    private ObjectNode publicJournal(ObjectNode journal) {
        var result = journal.deepCopy();
        if (result.has("files")) for (var file : result.withArray("files")) ((ObjectNode)file).remove(List.of("content", "beforeSha256", "callId", "revision"));
        return result;
    }
    private ProjectLifecycleGate.Lease acquire(String project) { return gate.tryAcquire(project).orElseThrow(() -> new ApiException("PROJECT_BUSY", 409, "Project is busy")); }
}
