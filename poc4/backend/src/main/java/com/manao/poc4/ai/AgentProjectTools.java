package com.manao.poc4.ai;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.workspace.WorkspaceAgent;
import com.manao.poc4.workspace.WorkspaceOperationService;
import com.manao.poc4.workspace.WorkspacePathPolicy;
import com.manao.poc4.workspace.WorkspaceService;
import com.manao.poc4.workspace.WorkspaceStore;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * The real project file tools (stage one, design section 4): {@code list_files}, {@code
 * read_file} and {@code write_file}. Every invocation is one durable (taskId, toolCallId) row —
 * the request digest covers taskId, tool name, expected revision and canonical (key-sorted)
 * args, so a replayed call answers its original result and a foreign reuse of the id is refused
 * without touching the stored answer. Writes pre-allocate a stable workspace operationId and
 * settle through the receipt-backed two-phase protocol ({@code
 * WorkspaceOperationService#applyAgentSave}); a lost first response resumes from the durable
 * receipt without a second mutation, and an ambiguous outcome turns the call NEEDS_ATTENTION and
 * keeps the project occupied instead of guessing. Deterministic, side-effect-free rejections
 * (path rules, size limits, sha/revision conflicts) settle COMPLETED with a persisted
 * {@code data.error} that Pi can read and retry from — an ordinary conflict never stays a
 * pending lock. The build name drives the {@link DevelopmentBuildExecutor}: the fixed goal
 * argument is validated here, the executor runs OUTSIDE the shared gate (no thread lock across
 * the cluster wait), its verified identity is bound to the ledger row and the call settles only
 * on a cleanup-confirmed result — an unconfirmed cleanup keeps the project occupied.
 */
public final class AgentProjectTools {
    /** Design section 3/4 bounds: 128 KiB file content, 192 KiB result JSON, 200 entries per listing. */
    static final int MAX_FILE_BYTES = 128 * 1024;
    static final int MAX_RESULT_BYTES = 192 * 1024;
    static final int MAX_LIST_ENTRIES = 200;

    private static final ObjectMapper JSON = new ObjectMapper();
    /** Key-sorted serialization: the canonical form the request digest is computed over. */
    private static final ObjectMapper CANONICAL = new ObjectMapper()
        .configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);
    private static final Set<String> KNOWN_TOOLS = Set.of("list_files", "read_file", "write_file", "build");
    /** Tools that register a durable side effect and are blocked while another call is unsettled. */
    private static final Set<String> SIDE_EFFECT_TOOLS = Set.of("write_file", "build");
    private static final String BUILD_TOOL = "build";
    private static final Set<String> FILE_WRITES = Set.of("write_file");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");

    /**
     * Stage-one tool allowlist denial set (design section 4): repository internals, any target
     * directory and credential files — fixed here in trusted code, never loaded from project
     * configuration or prompts, and never applied to the browser's own file features.
     */
    private static final Set<String> DENIED_SEGMENTS = Set.of(".git", "target");
    private static final Set<String> CREDENTIAL_FILES = Set.of(
        ".env", ".npmrc", ".netrc", ".git-credentials", ".htpasswd", ".pgpass",
        "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials.json");
    private static final List<String> CREDENTIAL_SUFFIXES = List.of(
        ".pem", ".key", ".p12", ".jks", ".keystore", ".kdbx");

    private final AgentTaskStore tasks;
    private final WorkspaceStore store;
    private final WorkspaceService workspace;
    private final WorkspaceOperationService operations;
    private final ProjectLifecycleGate lifecycle;
    /** The isolated development build executor: read-only source copy, real exit, proven cleanup. */
    private final DevelopmentBuildExecutor builds;

    public AgentProjectTools(AgentTaskStore tasks, WorkspaceStore store, WorkspaceService workspace,
                             WorkspaceOperationService operations, ProjectLifecycleGate lifecycle,
                             DevelopmentBuildExecutor builds) {
        this.tasks = tasks;
        this.store = store;
        this.workspace = workspace;
        this.operations = operations;
        this.lifecycle = lifecycle;
        this.builds = builds;
    }

    /**
     * Invokes one project tool for the task. Identity comes from the durable task row, never
     * from the call itself; the shared gate serializes the occupancy check, the ledger
     * registration and the (short) execution exactly like every other project write entry.
     * A build waits up to minutes for the cluster, so its dispatch is validated inside the
     * gate but executed OUTSIDE it — the durable REGISTERED/RUNNING row already blocks every
     * other side-effect call meanwhile, and no project transaction or thread gate is held
     * across the cluster wait.
     */
    public AgentContracts.ToolResult invoke(String taskId, AgentContracts.ToolRequest request) {
        requireRequestShape(request);
        AgentTaskStore.TaskOwner owner = tasks.taskOwner(taskId);
        AgentTaskStore.ToolCallRow row;
        AgentContracts.ToolResult result = null;
        AgentContracts.BuildGoal buildGoal = null;
        try (ProjectLifecycleGate.Lease lease = lifecycle.tryAcquire(owner.projectId()).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            tasks.requireTaskWritable(taskId, owner.projectId());
            boolean sideEffect = SIDE_EFFECT_TOOLS.contains(request.name());
            // A brand-new call must not register while an earlier one is unresolved; replays of
            // a known call always pass so their settled answer stays reachable.
            if (sideEffect && tasks.findToolCall(taskId, request.toolCallId()).isEmpty()
                && tasks.hasUnsettledCallOtherThan(taskId, request.toolCallId())) {
                throw new ApiException("AI_CALL_UNSETTLED", 409,
                    "An earlier tool call has not settled; resolve it before writing");
            }
            row = tasks.registerToolCall(taskId, request.toolCallId(),
                callDigest(taskId, request), request.name(), canonicalArgsJson(request.args()),
                request.expectedRevision(),
                sideEffect ? UUID.randomUUID().toString() : null);
            if ("COMPLETED".equals(row.state())) {
                return storedResult(row);
            }
            if ("NEEDS_ATTENTION".equals(row.state())) {
                throw new ApiException("AI_CALL_NEEDS_ATTENTION", 409,
                    "The call outcome is unknown; it needs attention before further writes");
            }
            // Only execution failures become persisted rejections; every refusal before the
            // registration (occupancy, id reuse) propagates to the caller unchanged.
            try {
                if (BUILD_TOOL.equals(request.name())) {
                    buildGoal = buildGoal(request);
                } else {
                    result = execute(owner, row, request);
                }
            } catch (ApiException ex) {
                if ("WORKSPACE_RECONCILIATION_REQUIRED".equals(ex.code())) {
                    tasks.markToolCallNeedsAttention(taskId, request.toolCallId());
                    throw ex;
                }
                result = rejected(request.toolCallId(), owner.projectId(), ex);
            } catch (RuntimeException ex) {
                tasks.markToolCallNeedsAttention(taskId, request.toolCallId());
                throw ex;
            }
        }
        if (buildGoal != null) {
            result = runBuild(owner, row, request, buildGoal);
        }
        AgentContracts.ToolResult settled = boundedResult(result);
        tasks.completeToolCall(taskId, request.toolCallId(), jsonOf(settled));
        return settled;
    }

    /** Read-only ledger lookup: answers the persisted result, never re-drives anything. */
    public Optional<AgentContracts.ToolResult> getCall(String taskId, String toolCallId) {
        return tasks.findToolCall(taskId, toolCallId)
            .filter(row -> "COMPLETED".equals(row.state()) && row.resultJson() != null)
            .map(AgentProjectTools::storedResult);
    }

    /** The call identity: SHA-256 over taskId, tool name, expected revision and canonical args. */
    static String callDigest(String taskId, AgentContracts.ToolRequest request) {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("taskId", taskId);
        fields.put("name", request.name());
        fields.put("expectedRevision", request.expectedRevision());
        fields.put("args", canonicalArgs(request.args()));
        try {
            return sha256Hex(CANONICAL.writeValueAsBytes(fields));
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("cannot serialize the tool call digest", ex);
        }
    }

    /** The canonical args JSON: key-sorted, re-serialized — the stored and digested form. */
    static String canonicalArgsJson(JsonNode args) {
        try {
            return CANONICAL.writeValueAsString(canonicalArgs(args));
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("cannot serialize the tool call arguments", ex);
        }
    }

    private static Map<String, Object> canonicalArgs(JsonNode args) {
        try {
            JsonNode source = args == null || args.isNull() || args.isMissingNode()
                ? JSON.createObjectNode() : args;
            return JSON.convertValue(source, new TypeReference<Map<String, Object>>() { });
        } catch (IllegalArgumentException ex) {
            throw new ApiException("VALIDATION_ERROR", 422, "Tool arguments are not a JSON object");
        }
    }

    private AgentContracts.ToolResult execute(AgentTaskStore.TaskOwner owner, AgentTaskStore.ToolCallRow row,
                                              AgentContracts.ToolRequest request) {
        return switch (request.name()) {
            case "list_files" -> listFiles(owner, request);
            case "read_file" -> readFile(owner, request);
            case "write_file" -> writeFile(owner, row, request);
            default -> throw new IllegalStateException("unsupported tool: " + request.name());
        };
    }

    private AgentContracts.ToolResult listFiles(AgentTaskStore.TaskOwner owner, AgentContracts.ToolRequest request) {
        String directory = toolDirectory(request.args().path("directory").asText(""));
        WorkspaceAgent.Tree tree = workspace.tree(owner.ownerId(), owner.projectId(), directory);
        // The listing may only show what a read of the same path would answer: every entry is
        // filtered through the policy + allowlist gate BEFORE the entry and byte caps apply.
        List<WorkspaceAgent.TreeEntry> visible = tree.entries().stream()
            .filter(entry -> toolReadable(entry.path()))
            .toList();
        boolean hasMore = visible.size() > MAX_LIST_ENTRIES;
        ObjectNode data = JSON.createObjectNode();
        data.put("directory", directory);
        data.set("entries", (ArrayNode) JSON.valueToTree(visible));
        data.put("hasMore", hasMore);
        return fittedListResult(new AgentContracts.ToolResult(request.toolCallId(),
            revisionOf(owner.projectId()), data, hasMore));
    }

    /** Caps the listing at 200 entries and trims further until the result fits the 192 KiB envelope. */
    private AgentContracts.ToolResult fittedListResult(AgentContracts.ToolResult result) {
        ObjectNode data = (ObjectNode) result.data();
        ArrayNode entries = (ArrayNode) data.withArray("entries");
        boolean truncated = false;
        while (entries.size() > MAX_LIST_ENTRIES
            || (!entries.isEmpty() && utf8JsonBytes(result) > MAX_RESULT_BYTES)) {
            entries.remove(entries.size() - 1);
            data.put("hasMore", true);
            truncated = true;
        }
        return new AgentContracts.ToolResult(result.toolCallId(), result.workspaceRevision(), data, truncated);
    }

    private AgentContracts.ToolResult readFile(AgentTaskStore.TaskOwner owner, AgentContracts.ToolRequest request) {
        String path = toolPath(request);
        WorkspaceAgent.FileMeta meta = workspace.meta(owner.ownerId(), owner.projectId(), path);
        if (meta == null) {
            throw new ApiException("ENTRY_NOT_FOUND", 404, "Entry does not exist");
        }
        if (meta.sizeBytes() != null && meta.sizeBytes() > MAX_FILE_BYTES) {
            throw new ApiException("FILE_TOO_LARGE", 422, "File exceeds the 128 KiB tool limit");
        }
        WorkspaceAgent.Content content = workspace.content(owner.ownerId(), owner.projectId(), path);
        if (content.content().getBytes(StandardCharsets.UTF_8).length > MAX_FILE_BYTES) {
            throw new ApiException("FILE_TOO_LARGE", 422, "File exceeds the 128 KiB tool limit");
        }
        ObjectNode data = JSON.createObjectNode()
            .put("path", path)
            .put("content", content.content())
            .put("sha256", content.sha256());
        AgentContracts.ToolResult result = new AgentContracts.ToolResult(request.toolCallId(),
            revisionOf(owner.projectId()), data, false);
        if (utf8JsonBytes(result) > MAX_RESULT_BYTES) {
            throw new ApiException("AI_RESULT_TOO_LARGE", 422,
                "The file content does not fit the bounded tool result");
        }
        return result;
    }

    private AgentContracts.ToolResult writeFile(AgentTaskStore.TaskOwner owner, AgentTaskStore.ToolCallRow row,
                                                AgentContracts.ToolRequest request) {
        String path = toolPath(request);
        JsonNode contentNode = request.args().get("content");
        if (contentNode == null || !contentNode.isTextual()) {
            throw new ApiException("VALIDATION_ERROR", 422, "write_file requires textual content");
        }
        byte[] bytes = contentNode.textValue().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_FILE_BYTES) {
            throw new ApiException("FILE_TOO_LARGE", 422, "File content exceeds the 128 KiB tool limit");
        }
        ObjectNode data = JSON.createObjectNode().put("path", path).put("sha256", sha256Hex(bytes));
        // The write result is fully determined by (path, sha256, post-write revision): the same
        // UTF-8 byte gate runs BEFORE the mutate, probed with the revision the success answer
        // will carry (current + 1 — under the project gate nothing else moves the revision), so
        // a probe that fits guarantees the stored answer fits and a boundary like "9"→"10"
        // cannot turn into an applied write whose result must be swapped for an error.
        long nextRevision = currentRevision(owner.projectId()) + 1;
        if (utf8JsonBytes(new AgentContracts.ToolResult(request.toolCallId(),
                Long.toString(nextRevision), data, false)) > MAX_RESULT_BYTES) {
            throw new ApiException("AI_RESULT_TOO_LARGE", 422,
                "The write result does not fit the bounded tool result");
        }
        long revision = operations.applyAgentSave(owner.projectId(), row.workspaceOperationId(), path, bytes,
            request.expectedRevision(), expectedSha256(request.args()));
        return new AgentContracts.ToolResult(request.toolCallId(), Long.toString(revision), data, false);
    }

    /**
     * The build goal argument: exactly {@code compile}, {@code test} or {@code package} — there
     * is no arbitrary argv, environment, image or shell string anywhere on the build path, so a
     * goal like {@code "test;rm -rf"} is a persisted rejection that never reaches the executor.
     */
    private static AgentContracts.BuildGoal buildGoal(AgentContracts.ToolRequest request) {
        JsonNode node = request.args().get("goal");
        if (node == null || !node.isTextual()) {
            throw new ApiException("VALIDATION_ERROR", 422, "build requires a textual goal");
        }
        return switch (node.textValue()) {
            case "compile" -> AgentContracts.BuildGoal.COMPILE;
            case "test" -> AgentContracts.BuildGoal.TEST;
            case "package" -> AgentContracts.BuildGoal.PACKAGE;
            default -> throw new ApiException("VALIDATION_ERROR", 422,
                "build goal must be compile, test or package");
        };
    }

    /**
     * Drives one development build against the saved sources. The executor works on a read-only
     * copy, so the workspace revision never moves; the verified Job/Pod identity is bound to the
     * ledger row backend-side only, and the call settles COMPLETED only when the build's cleanup
     * is confirmed — an unconfirmed cleanup or any executor failure stays NEEDS_ATTENTION and
     * keeps the project occupied instead of letting the next write race the build pod. A call
     * whose execution has never started (REGISTERED, no recorded identity) goes through build
     * after being marked RUNNING; any call that already carries a recorded identity is a
     * recovery that only observes it — evidence that has vanished stays unsettled and the build
     * is never executed a second time.
     */
    private AgentContracts.ToolResult runBuild(AgentTaskStore.TaskOwner owner, AgentTaskStore.ToolCallRow row,
                                               AgentContracts.ToolRequest request,
                                               AgentContracts.BuildGoal goal) {
        if (row.workspaceOperationId() == null) {
            throw new IllegalStateException("a build call row must carry its stable command id");
        }
        AgentContracts.BuildRequest buildRequest = new AgentContracts.BuildRequest(row.taskId(),
            row.toolCallId(), owner.projectId(), row.workspaceOperationId(),
            currentRevision(owner.projectId()), goal);
        AgentContracts.BuildResult built;
        try {
            AgentContracts.BuildIdentity recorded = tasks.boundBuildIdentity(row.taskId(), row.toolCallId())
                .orElse(null);
            if (recorded != null) {
                // Recovery: this call already started under its recorded identity. It is only
                // observed — never rebuilt, never re-executed.
                built = builds.observe(buildRequest, recorded);
            } else if ("RUNNING".equals(row.state())) {
                // Started before the identity binding landed: adopt by the deterministic name,
                // still never create.
                built = builds.observe(buildRequest, new AgentContracts.BuildIdentity(null, null, null));
            } else {
                // First execution: mark RUNNING before the cluster is touched, so any later
                // replay can only recover, never re-execute.
                tasks.markToolCallRunning(row.taskId(), row.toolCallId());
                built = builds.build(buildRequest);
            }
        } catch (RuntimeException ex) {
            tasks.markToolCallNeedsAttention(row.taskId(), row.toolCallId());
            throw ex;
        }
        tasks.bindToolCallIdentity(row.taskId(), row.toolCallId(), built.identity().jobName(),
            built.identity().jobUid(), built.identity().podUid());
        if (!built.cleanupConfirmed()) {
            tasks.markToolCallNeedsAttention(row.taskId(), row.toolCallId());
            throw new IllegalStateException("the build cleanup was not confirmed; the call stays needs-attention");
        }
        return fittedBuildResult(new AgentContracts.ToolResult(request.toolCallId(),
            Long.toString(currentRevision(owner.projectId())), buildData(buildRequest, built),
            built.truncated()));
    }

    /** The durable build answer: real exit facts, bounded output and parsed report summaries. */
    private static ObjectNode buildData(AgentContracts.BuildRequest request, AgentContracts.BuildResult built) {
        ObjectNode data = JSON.createObjectNode()
            .put("goal", request.goal().name().toLowerCase(Locale.ROOT))
            .put("sourceRevision", Long.toString(request.sourceRevision()))
            .put("terminationReason", built.terminationReason())
            .put("output", built.output())
            .put("cleanupConfirmed", built.cleanupConfirmed());
        if (built.exitCode() == null) {
            data.putNull("exitCode");
        } else {
            data.put("exitCode", built.exitCode());
        }
        data.set("testReports", JSON.valueToTree(built.testReports()));
        return data;
    }

    /**
     * The 192 KiB result envelope still holds for a build: the output keeps its TAIL (the
     * failure summary and the report markers live there) and only after the output is empty do
     * report summaries get dropped — both facts are visible as truncated/reportsDropped, and a
     * real build failure is never masked by the fit.
     */
    private AgentContracts.ToolResult fittedBuildResult(AgentContracts.ToolResult result) {
        ObjectNode data = (ObjectNode) result.data();
        boolean truncated = result.truncated();
        while (utf8JsonBytes(result) > MAX_RESULT_BYTES && data.path("output").asText().length() > 0) {
            String output = data.path("output").asText();
            data.put("output", output.substring(output.length() / 2));
            truncated = true;
        }
        while (utf8JsonBytes(result) > MAX_RESULT_BYTES && data.withArray("testReports").size() > 0) {
            ArrayNode reports = (ArrayNode) data.withArray("testReports");
            reports.remove(reports.size() - 1);
            data.put("reportsDropped", true);
        }
        return new AgentContracts.ToolResult(result.toolCallId(), result.workspaceRevision(), data, truncated);
    }

    /**
     * The one gate every persisted result passes (defense in depth behind the per-tool bounds):
     * no tool result may exceed the 192 KiB JSON envelope in UTF-8 bytes. read_file and
     * list_files reject or trim upstream, and write_file pre-checks its deterministic result
     * before the mutate, so reaching here with an oversized result means an unmapped path — the
     * bounded error envelope keeps the ledger invariant absolute instead of storing overflow.
     */
    private AgentContracts.ToolResult boundedResult(AgentContracts.ToolResult result) {
        if (utf8JsonBytes(result) <= MAX_RESULT_BYTES) {
            return result;
        }
        ObjectNode error = JSON.createObjectNode()
            .put("code", "AI_RESULT_TOO_LARGE")
            .put("message", "The tool result exceeded the bounded size");
        ObjectNode data = JSON.createObjectNode();
        data.set("error", error);
        return new AgentContracts.ToolResult(result.toolCallId(), result.workspaceRevision(), data, false);
    }

    /** Persists a deterministic, side-effect-free rejection as the call's durable answer. */
    private AgentContracts.ToolResult rejected(String toolCallId, String projectId, ApiException ex) {
        ObjectNode error = JSON.createObjectNode().put("code", ex.code()).put("message", ex.getMessage());
        ObjectNode data = JSON.createObjectNode();
        data.set("error", error);
        return new AgentContracts.ToolResult(toolCallId, revisionOf(projectId), data, false);
    }

    private static void requireRequestShape(AgentContracts.ToolRequest request) {
        if (request == null || request.toolCallId() == null
            || request.toolCallId().isBlank() || request.toolCallId().length() > 64
            || request.name() == null || !KNOWN_TOOLS.contains(request.name())
            || request.expectedRevision() < 0
            || request.args() == null || !request.args().isObject()) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
    }

    /** Policy validation plus the fixed stage-one allowlist, applied to a file path argument. */
    private static String toolPath(AgentContracts.ToolRequest request) {
        JsonNode node = request.args().get("path");
        if (node == null || !node.isTextual()) {
            throw new ApiException("VALIDATION_ERROR", 422, request.name() + " requires a textual path");
        }
        String path = node.textValue();
        try {
            WorkspacePathPolicy.validateRelativePath(path);
        } catch (WorkspacePathPolicy.InvalidPathException ex) {
            throw new ApiException("INVALID_PATH", 422, "Invalid file path");
        }
        if (!toolAllowlist(path)) {
            throw new ApiException("PATH_FORBIDDEN", 422, "Path is outside the agent tool allowlist");
        }
        return path;
    }

    /** Policy validation plus the fixed stage-one allowlist, applied to a directory argument. */
    private static String toolDirectory(String directory) {
        if (directory.isEmpty()) {
            return "";
        }
        try {
            WorkspacePathPolicy.validateDirectoryPath(directory);
        } catch (WorkspacePathPolicy.InvalidPathException ex) {
            throw new ApiException("INVALID_PATH", 422, "Invalid file path");
        }
        if (!toolAllowlist(directory)) {
            throw new ApiException("PATH_FORBIDDEN", 422, "Path is outside the agent tool allowlist");
        }
        return directory;
    }

    /** One gate for "may the tools access this project-relative path at all": policy + allowlist. */
    static boolean toolReadable(String path) {
        try {
            WorkspacePathPolicy.validateRelativePath(path);
        } catch (WorkspacePathPolicy.InvalidPathException ex) {
            return false;
        }
        return toolAllowlist(path);
    }

    /**
     * The stage-one tool allowlist, fixed in trusted code (design section 4): build scripts,
     * sources and ordinary top-level text documents. Beyond the allowlist it denies the
     * repository internals and credential files the tools must never touch.
     */
    static boolean toolAllowlist(String path) {
        String[] segments = path.split("/");
        for (String segment : segments) {
            String lower = segment.toLowerCase(Locale.ROOT);
            if (DENIED_SEGMENTS.contains(lower) || lower.startsWith(".manao")) {
                return false;
            }
            if (CREDENTIAL_FILES.contains(lower)
                || CREDENTIAL_SUFFIXES.stream().anyMatch(lower::endsWith)) {
                return false;
            }
        }
        String first = segments[0].toLowerCase(Locale.ROOT);
        if (first.equals("pom.xml") || first.equals("src")) {
            return true;
        }
        return segments.length == 1 && isTextDocument(first);
    }

    private static boolean isTextDocument(String lowerName) {
        return lowerName.endsWith(".md") || lowerName.endsWith(".txt")
            || lowerName.endsWith(".adoc") || lowerName.endsWith(".rst");
    }

    /** null means "create a new file"; otherwise a sha-256 digest of the version being replaced. */
    private static String expectedSha256(JsonNode args) {
        JsonNode node = args.get("expectedSha256");
        if (node == null || node.isNull()) {
            return null;
        }
        if (!node.isTextual() || !SHA256.matcher(node.textValue()).matches()) {
            throw new ApiException("VALIDATION_ERROR", 422,
                "expectedSha256 must be null or a sha-256 digest");
        }
        return node.textValue();
    }

    private static AgentContracts.ToolResult storedResult(AgentTaskStore.ToolCallRow row) {
        try {
            return JSON.readValue(row.resultJson(), AgentContracts.ToolResult.class);
        } catch (IOException ex) {
            throw new IllegalStateException("stored tool call result is unreadable", ex);
        }
    }

    private long currentRevision(String projectId) {
        WorkspaceStore.ProjectRecord project = store.findProject(projectId);
        return project == null ? 0 : project.workspaceRevision();
    }

    private String revisionOf(String projectId) {
        return Long.toString(currentRevision(projectId));
    }

    private static String jsonOf(AgentContracts.ToolResult result) {
        try {
            return JSON.writeValueAsString(result);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("cannot serialize the tool result", ex);
        }
    }

    /** The 192 KiB bound is on the stored JSON's UTF-8 bytes, not its UTF-16 length. */
    private static int utf8JsonBytes(AgentContracts.ToolResult result) {
        return jsonOf(result).getBytes(StandardCharsets.UTF_8).length;
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            StringBuilder builder = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) {
                builder.append(String.format("%02x", b));
            }
            return builder.toString();
        } catch (Exception ex) {
            throw new IllegalStateException("SHA-256 is unavailable", ex);
        }
    }
}
