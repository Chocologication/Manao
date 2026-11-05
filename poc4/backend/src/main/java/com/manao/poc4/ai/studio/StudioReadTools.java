package com.manao.poc4.ai.studio;

import com.fasterxml.jackson.databind.JsonNode;
import com.manao.poc4.ai.AgentProjectTools;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.workspace.WorkspaceService;
import com.manao.poc4.log.RunLogService;
import com.manao.poc4.run.RunStore;

/** Deliberately has no mutation, terminal, application-control or build dependency. */
public final class StudioReadTools {
    private final WorkspaceService workspace;
    private final RunStore runs;
    private final RunLogService logs;
    public StudioReadTools(WorkspaceService workspace, RunStore runs, RunLogService logs) {
        this.workspace = workspace; this.runs = runs; this.logs = logs;
    }
    public JsonNode invoke(String owner, String project, String name, JsonNode args) {
        return switch (name) {
            case "list_files" -> {
                String directory = args.path("directory").asText("");
                if (!directory.isEmpty()) requirePath(directory);
                var entries = workspace.tree(owner, project, directory).entries().stream()
                    .filter(e -> AgentProjectTools.toolReadable(e.path())).limit(200).toList();
                yield StudioStore.JSON.valueToTree(entries);
            }
            case "read_file" -> {
                String path = args.path("path").asText(); requirePath(path);
                var meta = workspace.meta(owner, project, path);
                if (meta == null) throw StudioStore.missing();
                if (meta.sizeBytes() != null && meta.sizeBytes() > 128 * 1024) throw new ApiException("FILE_TOO_LARGE", 422, "Read limit exceeded");
                var file = workspace.content(owner, project, path);
                yield StudioStore.JSON.createObjectNode().put("path", path).put("sha256", file.sha256()).put("content", bounded(file.content(), 16000)).put("truncated", file.content().length() > 16000);
            }
            case "read_logs" -> {
                String id = args.path("runId").asText();
                if (id.isBlank()) id = runs.findActiveRun(project).map(r -> r.id()).orElseThrow(StudioStore::missing);
                runs.findRunForOwner(owner, project, id).orElseThrow(StudioStore::missing);
                var chunks = logs.windowFor(id).chunksAfter(0);
                var text = new StringBuilder();
                for (int i = chunks.size() - 1; i >= 0 && text.length() < 16000; i--) text.insert(0, chunks.get(i).text());
                yield StudioStore.JSON.createObjectNode().put("runId", id).put("text", text.length() > 16000 ? text.substring(text.length() - 16000) : text.toString()).put("truncated", true);
            }
            default -> throw new ApiException("AI_READ_ONLY", 422, "Chat permits only list_files, read_file and read_logs");
        };
    }
    public static void requirePath(String path) {
        if (path == null || !AgentProjectTools.toolReadable(path)) throw new ApiException("PATH_FORBIDDEN", 422, "Path is outside the assistant read policy");
    }
    public static String bounded(String text, int limit) { return text.length() > limit ? text.substring(0, limit) : text; }
}
