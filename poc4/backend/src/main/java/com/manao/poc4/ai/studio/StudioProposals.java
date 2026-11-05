package com.manao.poc4.ai.studio;

import static com.manao.poc4.ai.studio.StudioContracts.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.ai.AgentContracts;
import com.manao.poc4.ai.AgentTaskStore;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.workspace.WorkspaceAgent;
import com.manao.poc4.workspace.WorkspaceService;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;

/** Called under the existing project gate; REVIEW never touches the source volume. */
public final class StudioProposals {
    private final JdbcTemplate jdbc;
    private final WorkspaceService workspace;
    private final StudioModelStore models;
    public StudioProposals(JdbcTemplate jdbc, WorkspaceService workspace, StudioModelStore models) {
        this.jdbc = jdbc; this.workspace = workspace; this.models = models;
    }
    public void prepare(String owner, String project, String task, String model, String policy, String turn, long revision) {
        var existing = options(task);
        if (existing != null) {
            if (!existing.owner().equals(owner) || !existing.project().equals(project) || !existing.turn().equals(turn)
                || !existing.model().equals(model) || !existing.policy().equals(policy)) throw StudioStore.invalid();
            return;
        }
        jdbc.update("INSERT INTO assistant_task_options(task_id,owner_id,project_id,model_id,apply_policy,turn_id,base_revision,files_json,apply_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            task, owner, project, model, policy, turn, revision, "{}", "{}", Timestamp.from(Instant.now()));
    }
    public record Options(String owner, String project, String model, String policy, String turn, long revision, ObjectNode files, ObjectNode apply) { }
    public Options options(String task) {
        var rows = jdbc.query("SELECT * FROM assistant_task_options WHERE task_id=?", (rs, i) ->
            new Options(rs.getString("owner_id"), rs.getString("project_id"), rs.getString("model_id"), rs.getString("apply_policy"),
                rs.getString("turn_id"), rs.getLong("base_revision"), StudioStore.parse(rs.getString("files_json")), StudioStore.parse(rs.getString("apply_json"))), task);
        return rows.isEmpty() ? null : rows.get(0);
    }
    public boolean review(String task) { var o = options(task); return o != null && "REVIEW".equals(o.policy()); }
    public AgentContracts.WorkerModel workerModel(String task) {
        var o = options(task);
        if (o == null || "VALIDATION".equals(o.policy())) return null;
        var m = models.resolve(o.owner(), o.model());
        StudioModelStore.validateAddress(m.baseUrl());
        return new AgentContracts.WorkerModel("manao-user", "openai-completions", m.baseUrl(), m.model(), m.apiKey(), m.vision());
    }
    public WorkspaceAgent.Content overlay(String task, String path) {
        var o = options(task);
        if (o == null || !"REVIEW".equals(o.policy()) || !o.files().has(path)) return null;
        String content = o.files().path(path).path("after").asText();
        return new WorkspaceAgent.Content(path, content, StudioStore.hash(content));
    }
    public List<AgentContracts.WorkerImage> workerImages(String task) {
        var o = options(task); if (o == null) return List.of();
        var rows = jdbc.query("SELECT data_json FROM assistant_turn WHERE id=?", (rs, i) -> StudioStore.parse(rs.getString(1)), o.turn());
        if (rows.isEmpty()) return List.of();
        var result = new java.util.ArrayList<AgentContracts.WorkerImage>();
        for (var id : rows.get(0).path("attachmentIds")) result.addAll(jdbc.query("SELECT media_type,body FROM assistant_attachment WHERE id=? AND owner_id=? AND project_id=? AND media_type LIKE 'image/%'",
            (rs, i) -> new AgentContracts.WorkerImage("image", java.util.Base64.getEncoder().encodeToString(rs.getBytes("body")), rs.getString("media_type")), id.asText(), o.owner(), o.project()));
        return result;
    }
    public Map<String, String> overlay(String task) {
        var o = options(task); var result = new LinkedHashMap<String, String>();
        if (o != null && "REVIEW".equals(o.policy())) o.files().fields().forEachRemaining(e -> result.put(e.getKey(), e.getValue().path("after").asText()));
        return result;
    }
    public void capture(String task, String path) {
        var o = options(task); if (o == null || o.files().has(path)) return;
        if (o.files().size() >= 64) throw new ApiException("FILE_TOO_LARGE", 422, "Task changes exceed the 64 file limit");
        String before = null;
        try { before = workspace.content(o.owner(), o.project(), path).content(); }
        catch (ApiException ex) { if (!"ENTRY_NOT_FOUND".equals(ex.code())) throw ex; }
        ObjectNode file = o.files().putObject(path);
        if (before == null) file.putNull("before"); else file.put("before", before);
        file.put("after", before == null ? "" : before);
        saveFiles(task, o.files());
    }
    public String stage(String task, String call, String path, String content, String expectedSha) {
        capture(task, path); var o = options(task); var file = (ObjectNode) o.files().path(path);
        if (call.equals(file.path("lastCall").asText())) {
            if (!content.equals(file.path("after").asText())) throw StudioStore.invalid();
            return StudioStore.hash(content);
        }
        String current = file.has("lastCall") ? StudioStore.hash(file.path("after").asText())
            : file.path("before").isNull() ? null : StudioStore.hash(file.path("before").asText());
        if (!java.util.Objects.equals(current, expectedSha)) throw new ApiException("WORKSPACE_CONFLICT", 409, "Proposal file has changed");
        file.put("after", content).put("lastCall", call);
        saveFiles(task, o.files()); return StudioStore.hash(content);
    }
    public void applied(String task, String path, String content) {
        var o = options(task); if (o == null || !o.files().has(path)) return;
        ((ObjectNode)o.files().path(path)).put("after", content); saveFiles(task, o.files());
    }
    public void validateApplied(String task, String path, String content) {
        var o = options(task); if (o == null || !o.files().has(path)) return;
        var prospective = o.files().deepCopy(); ((ObjectNode)prospective.path(path)).put("after", content);
        checkSize(prospective);
    }
    private void saveFiles(String task, ObjectNode files) {
        checkSize(files);
        jdbc.update("UPDATE assistant_task_options SET files_json=? WHERE task_id=?", StudioStore.json(files), task);
    }
    private void checkSize(ObjectNode files) {
        if (StudioStore.json(files).getBytes(StandardCharsets.UTF_8).length > 512 * 1024)
            throw new ApiException("FILE_TOO_LARGE", 422, "Task changes exceed the 512 KiB review limit");
    }
    public List<FileChange> changes(String task) {
        var o = options(task); if (o == null) return List.of();
        var result = new java.util.ArrayList<FileChange>();
        o.files().fields().forEachRemaining(e -> {
            var f = e.getValue();
            var change = StudioDiff.change(e.getKey(), f.path("before").isNull() ? null : f.path("before").asText(), f.path("after").asText());
            if (!change.hunks().isEmpty()) result.add(change);
        }); return result;
    }
    public void journal(String task, ObjectNode journal) {
        jdbc.update("UPDATE assistant_task_options SET apply_json=? WHERE task_id=?", StudioStore.json(journal), task);
    }
    public List<String> pendingApplications(String owner, String project) {
        return jdbc.query("SELECT turn_id FROM assistant_task_options WHERE owner_id=? AND project_id=? AND JSON_UNQUOTE(JSON_EXTRACT(apply_json,'$.state')) IN ('APPLYING','VALIDATING') ORDER BY created_at LIMIT 10", (rs, i) -> rs.getString(1), owner, project);
    }
}
