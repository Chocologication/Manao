package com.manao.poc4.ai;

import static com.manao.poc4.ai.AgentConversationContracts.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Project-scoped native conversation persistence. */
public final class AgentConversationStore {
    static final int ENTRY_LIMIT = 2 * 1024 * 1024;
    static final int CONTEXT_LIMIT = 4 * 1024 * 1024;
    static final int HISTORY_LIMIT = 512 * 1024;
    static final long CONTEXT_WINDOW = 1_048_576;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Set<String> TYPES = Set.of("message", "thinking_level_change", "model_change", "usage",
        "compaction", "branch_summary", "custom", "custom_message", "context_edit", "label", "session_info");
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final Clock clock;
    private final AgentTaskStore tasks;

    public AgentConversationStore(JdbcTemplate jdbc, PlatformTransactionManager transactions, Clock clock,
                                  AgentTaskStore tasks) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactions);
        // The routing lookup precedes the project lock. Its old read view must not
        // hide a binding or append committed while this transaction waited for that lock.
        this.transaction.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_READ_COMMITTED);
        this.clock = clock;
        this.tasks = tasks;
    }

    public ConversationView create(String ownerId, String projectId, CreateConversationRequest request) {
        if (request == null) throw invalid();
        requireUuid(request.conversationId());
        return transaction.execute(status -> {
            requireProject(ownerId, projectId, true);
            List<String> existing = jdbc.query("SELECT project_id FROM agent_conversation WHERE id=? FOR UPDATE",
                (rs, i) -> rs.getString(1), request.conversationId());
            if (!existing.isEmpty()) {
                if (!projectId.equals(existing.get(0))) throw missing();
                return detail(ownerId, projectId, request.conversationId());
            }
            var instant = clock.instant().truncatedTo(java.time.temporal.ChronoUnit.MICROS);
            var now = Timestamp.from(instant);
            var header = JSON.createObjectNode().put("type", "session").put("version", 3)
                .put("id", request.conversationId()).put("cwd", "manao-project").put("timestamp", instant.toString());
            jdbc.update("INSERT INTO agent_conversation(id,project_id,title,header_json,head_seq,created_at,updated_at) VALUES (?,?,?, ?,0,?,?)",
                request.conversationId(), projectId, "新会话", json(header), now, now);
            return detail(ownerId, projectId, request.conversationId());
        });
    }

    public ConversationView detail(String ownerId, String projectId, String conversationId) {
        requireProject(ownerId, projectId, false);
        List<ConversationView> rows = jdbc.query("SELECT * FROM agent_conversation WHERE id=? AND project_id=?",
            (rs, i) -> view(rs), conversationId, projectId);
        if (rows.isEmpty()) throw missing();
        return rows.get(0);
    }

    public ConversationPage list(String ownerId, String projectId, String before, int limit) {
        requireProject(ownerId, projectId, false);
        if (limit < 1 || limit > 50) throw invalid();
        List<Object> args = new ArrayList<>(List.of(projectId));
        String cursorCondition = "";
        if (before != null) {
            try {
                String[] cursor = new String(Base64.getUrlDecoder().decode(before), StandardCharsets.UTF_8).split("\\|", -1);
                if (cursor.length != 2) throw invalid();
                var time = Timestamp.valueOf(cursor[0]);
                requireUuid(cursor[1]);
                cursorCondition = " AND (updated_at < ? OR (updated_at = ? AND id < ?))";
                args.addAll(List.of(time, time, cursor[1]));
            } catch (IllegalArgumentException ex) { throw invalid(); }
        }
        args.add(limit + 1);
        var rows = jdbc.query("SELECT * FROM agent_conversation WHERE project_id=?" + cursorCondition
            + " ORDER BY updated_at DESC,id DESC LIMIT ?", (rs, i) -> new Listed(view(rs), rs.getTimestamp("updated_at")), args.toArray());
        String next = null;
        if (rows.size() > limit) {
            var last = rows.get(limit - 1);
            next = Base64.getUrlEncoder().withoutPadding().encodeToString(
                (last.updated() + "|" + last.view().conversationId()).getBytes(StandardCharsets.UTF_8));
        }
        return new ConversationPage(rows.stream().limit(limit).map(Listed::view).toList(), next);
    }

    public HistoryPage history(String ownerId, String projectId, String conversationId, Long beforeSeq, int limit) {
        return history(ownerId, projectId, conversationId, beforeSeq, null, limit);
    }

    public HistoryPage history(String ownerId, String projectId, String conversationId, Long beforeSeq, Integer beforeOffset, int limit) {
        var conversation = detail(ownerId, projectId, conversationId);
        if (limit < 1 || limit > 100 || (beforeSeq != null && beforeSeq < 1)
            || (beforeOffset != null && (beforeSeq == null || beforeOffset < 1))) throw invalid();
        long before = beforeSeq == null ? conversation.headSeq() + 1 : beforeSeq;
        var rows = entries(conversationId, beforeOffset == null ? "seq < ?" : "seq <= ?", before, limit + 1, "DESC");
        var items = new ArrayList<HistoryItem>();
        int groups = 0;
        Long next = null;
        Integer nextOffset = null;
        outer: for (int i = 0; i < rows.size(); i++) {
            var row = rows.get(i);
            var fragments = fragments(project(row));
            if (beforeOffset != null && row.seq() == before)
                fragments.removeIf(item -> item.textOffset() >= beforeOffset);
            fragments.sort(java.util.Comparator.comparingInt(HistoryItem::textOffset).reversed());
            for (int f = 0; f < fragments.size();) {
                var fragment = fragments.get(f);
                var group = new ArrayList<HistoryItem>();
                do { group.add(fragments.get(f++)); }
                while (f < fragments.size() && fragments.get(f).textOffset() == fragment.textOffset());
                var candidate = new ArrayList<>(items); candidate.addAll(group);
                if (groups == limit || bytes(new HistoryPage(candidate, row.seq(), fragment.textOffset())) > HISTORY_LIMIT) {
                    if (items.isEmpty()) throw tooLarge();
                    var earliest = items.get(items.size() - 1);
                    next = earliest.seq(); nextOffset = earliest.textOffset() == 0 ? null : earliest.textOffset();
                    break outer;
                }
                items.addAll(group); groups++;
            }
        }
        if (next == null && rows.size() == limit + 1 && !rows.isEmpty()) next = rows.get(rows.size() - 1).seq();
        items.sort(java.util.Comparator.comparingLong(HistoryItem::seq).thenComparingInt(HistoryItem::contentIndex).thenComparingInt(HistoryItem::textOffset));
        return new HistoryPage(List.copyOf(items), next, nextOffset);
    }

    public ContextPage readForTask(String taskId, String instanceId, long epoch, long afterSeq, Long throughSeq) {
        return transaction.execute(status -> {
            var identity = lockTaskConversation(taskId, instanceId, epoch, false);
            long head = identity.head();
            long through = throughSeq == null ? head : throughSeq;
            if (afterSeq < 0 || through < afterSeq || through > head) throw conflict();
            var rows = jdbc.query("SELECT seq,source_task_id,writer_id,payload_json FROM agent_conversation_entry "
                    + "WHERE conversation_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 33",
                (rs, i) -> stored(rs), identity.conversationId(), afterSeq, through);
            var page = new ArrayList<StoredEntry>();
            Long next = null;
            for (var row : rows) {
                var candidate = new ArrayList<>(page); candidate.add(row);
                if (page.size() == 32 || bytes(new ContextPage(identity.header(), through, candidate, row.seq())) > CONTEXT_LIMIT) {
                    if (page.isEmpty()) throw tooLarge();
                    next = page.get(page.size() - 1).seq(); break;
                }
                page.add(row);
            }
            return new ContextPage(identity.header(), through, List.copyOf(page), next);
        });
    }

    public ContextAck appendForTask(String taskId, String instanceId, long epoch, ContextAppend append) {
        if (append == null || append.entries() == null || append.entries().size() > 32 || append.expectedHeadSeq() < 0) throw invalid();
        if (bytes(append) > CONTEXT_LIMIT) throw tooLarge();
        validateUsage(append.usage());
        return transaction.execute(status -> {
            var identity = lockTaskConversation(taskId, instanceId, epoch, true);
            if (!identity.header().equals(append.header())) throw conflict();
            long head = appendBatch(identity.conversationId(), taskId, taskId, identity.head(), append);
            return new ContextAck(head);
        });
    }

    public record CompactionAdmission(ConversationView view, boolean created) { }
    public record PendingCompaction(String conversationId, String requestId, long baseSeq, String instanceId) { }

    public CompactionAdmission beginCompaction(String ownerId, String projectId, String conversationId, CompactRequest request) {
        if (request == null || request.expectedHeadSeq() < 0) throw invalid();
        requireUuid(request.requestId());
        return transaction.execute(status -> {
            requireProject(ownerId, projectId, true);
            var current = lockCompaction(conversationId, projectId);
            if (request.requestId().equals(current.requestId())) {
                if (request.expectedHeadSeq() != current.baseSeq()) throw conflict();
                return new CompactionAdmission(detail(ownerId, projectId, conversationId), false);
            }
            var old = jdbc.query("SELECT MIN(seq) FROM agent_conversation_entry WHERE conversation_id=? AND writer_id=? AND source_task_id IS NULL HAVING SUM(JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.type'))='compaction')=1",
                (rs, i) -> rs.getLong(1), conversationId, request.requestId());
            if (!old.isEmpty()) {
                if (old.get(0) - 1 != request.expectedHeadSeq()) throw conflict();
                var view = detail(ownerId, projectId, conversationId);
                return new CompactionAdmission(new ConversationView(view.conversationId(), view.title(), view.headSeq(), view.lastTaskId(),
                    view.activeTaskId(), view.usage(), request.requestId(), "COMPLETED", null, view.nextReasoningEffort()), false);
            }
            if (!"READY".equals(jdbc.queryForObject("SELECT state FROM project WHERE id=?", String.class, projectId))) throw busy();
            if (jdbc.queryForObject("SELECT COUNT(*) FROM agent_task WHERE project_id=? AND active_project IS NOT NULL", Integer.class, projectId) > 0) throw busy();
            requireNoCompaction(jdbc, projectId);
            if (current.head() != request.expectedHeadSeq()) throw conflict();
            jdbc.update("UPDATE agent_conversation SET compact_request_id=?,compact_base_seq=?,compact_state='RUNNING',compact_worker_instance=NULL,compact_failure_code=NULL,updated_at=? WHERE id=?",
                request.requestId(), request.expectedHeadSeq(), Timestamp.from(clock.instant()), conversationId);
            return new CompactionAdmission(detail(ownerId, projectId, conversationId), true);
        });
    }

    public List<PendingCompaction> pendingCompactions(String ownerId, String projectId) {
        requireProject(ownerId, projectId, false);
        return jdbc.query("SELECT id,compact_request_id,compact_base_seq,compact_worker_instance FROM agent_conversation WHERE project_id=? AND compact_state='RUNNING'",
            (rs, i) -> new PendingCompaction(rs.getString(1), rs.getString(2), rs.getLong(3), rs.getString(4)), projectId);
    }

    /** ACK, first context read and result may race; the same row CAS binds the first authenticated instance. */
    public void bindCompaction(String conversationId, String requestId, long baseSeq, String instanceId) {
        transaction.executeWithoutResult(status -> requireCompaction(conversationId, requestId, baseSeq, instanceId, false));
    }

    public ContextPage readForCompaction(String conversationId, String requestId, long baseSeq, String instanceId, long afterSeq, Long throughSeq) {
        return transaction.execute(status -> {
            var row = requireCompaction(conversationId, requestId, baseSeq, instanceId, false);
            long through = throughSeq == null ? baseSeq : throughSeq;
            if (through != baseSeq || afterSeq < 0 || afterSeq > through) throw conflict();
            var rows = entries(conversationId, "seq>? AND seq<=" + through, afterSeq, 33, "ASC");
            var page = new ArrayList<StoredEntry>();
            Long next = null;
            for (var item : rows) {
                var candidate = new ArrayList<>(page); candidate.add(item);
                if (page.size() == 32 || bytes(new ContextPage(row.header(), through, candidate, item.seq())) > CONTEXT_LIMIT) {
                    if (page.isEmpty()) throw tooLarge();
                    next = page.get(page.size() - 1).seq(); break;
                }
                page.add(item);
            }
            return new ContextPage(row.header(), through, List.copyOf(page), next);
        });
    }

    public ContextAck finishCompaction(String conversationId, String requestId, String instanceId, CompactResult result) {
        if (result == null || result.entries() == null || result.entries().size() > 32 || result.expectedHeadSeq() < 0) throw invalid();
        if (bytes(result) > CONTEXT_LIMIT) throw tooLarge();
        validateUsage(result.usage());
        if (result.failureCode() != null && (!"AI_CONTEXT_COMPACTION_FAILED".equals(result.failureCode()) || !result.entries().isEmpty())) throw invalid();
        return transaction.execute(status -> {
            var row = requireCompaction(conversationId, requestId, result.expectedHeadSeq(), instanceId, true);
            if ("FAILED".equals(row.state())) throw conflict();
            long head = row.head();
            if ("COMPLETED".equals(row.state())) {
                if (result.failureCode() != null) throw conflict();
                int saved = jdbc.queryForObject("SELECT COUNT(*) FROM agent_conversation_entry WHERE conversation_id=? AND writer_id=? AND source_task_id IS NULL",
                    Integer.class, conversationId, requestId);
                if (saved != result.entries().size()) throw conflict();
                if (result.entries().isEmpty()) return new ContextAck(result.expectedHeadSeq());
                return new ContextAck(appendBatch(conversationId, null, requestId, head,
                    new ContextAppend(result.expectedHeadSeq(), row.header(), result.entries(), result.usage())));
            }
            if (head != result.expectedHeadSeq()) throw conflict();
            if (result.failureCode() == null && !result.entries().isEmpty()) {
                long summaries = result.entries().stream().filter(e -> "compaction".equals(e.path("type").asText())).count();
                if (summaries != 1 || result.entries().stream().anyMatch(e -> !Set.of("compaction", "model_change", "thinking_level_change").contains(e.path("type").asText()))) throw conflict();
                head = appendBatch(conversationId, null, requestId, head,
                    new ContextAppend(result.expectedHeadSeq(), row.header(), result.entries(), result.usage()));
            }
            jdbc.update("UPDATE agent_conversation SET compact_state=?,compact_failure_code=?,updated_at=? WHERE id=?",
                result.failureCode() == null ? "COMPLETED" : "FAILED", result.failureCode(), Timestamp.from(clock.instant()), conversationId);
            return new ContextAck(head);
        });
    }

    /** A definite rejection/replaced instance fences callbacks; transport uncertainty does not call this. */
    public void failCompaction(PendingCompaction pending) {
        transaction.executeWithoutResult(status -> {
            var row = lockCompaction(pending.conversationId(), null);
            if ("RUNNING".equals(row.state()) && pending.requestId().equals(row.requestId()) && pending.baseSeq() == row.baseSeq())
                jdbc.update("UPDATE agent_conversation SET compact_state='FAILED',compact_failure_code='AI_CONTEXT_COMPACTION_FAILED',updated_at=? WHERE id=?",
                    Timestamp.from(clock.instant()), pending.conversationId());
        });
    }

    private CompactRow requireCompaction(String conversationId, String requestId, long baseSeq, String instanceId, boolean terminalAllowed) {
        if (instanceId == null || instanceId.isBlank() || instanceId.length() > 64) throw invalid();
        var row = lockCompaction(conversationId, null);
        if (!requestId.equals(row.requestId()) || baseSeq != row.baseSeq() || (!terminalAllowed && !"RUNNING".equals(row.state()))
            || (row.instanceId() != null && !instanceId.equals(row.instanceId()))) throw conflict();
        if (row.instanceId() == null) {
            if (!"RUNNING".equals(row.state())) throw conflict();
            jdbc.update("UPDATE agent_conversation SET compact_worker_instance=? WHERE id=? AND compact_worker_instance IS NULL", instanceId, conversationId);
        }
        return row;
    }

    private CompactRow lockCompaction(String conversationId, String expectedProject) {
        var projects = jdbc.query("SELECT project_id FROM agent_conversation WHERE id=?", (rs, i) -> rs.getString(1), conversationId);
        if (projects.isEmpty() || (expectedProject != null && !expectedProject.equals(projects.get(0)))) throw missing();
        jdbc.queryForObject("SELECT id FROM project WHERE id=? FOR UPDATE", String.class, projects.get(0));
        return jdbc.queryForObject("SELECT head_seq,header_json,compact_request_id,compact_base_seq,compact_state,compact_worker_instance FROM agent_conversation WHERE id=? FOR UPDATE",
            (rs, i) -> new CompactRow(rs.getLong(1), parse(rs.getString(2)), rs.getString(3), rs.getLong(4), rs.getString(5), rs.getString(6)), conversationId);
    }
    private record CompactRow(long head, JsonNode header, String requestId, long baseSeq, String state, String instanceId) { }

    /** Called only inside TaskStore's existing project-row transaction. */
    static void bindTaskGoal(JdbcTemplate jdbc, Clock clock, String projectId, String conversationId, AgentContracts.TaskRequest request) {
        requireUuid(conversationId);
        var rows = jdbc.query("SELECT head_seq FROM agent_conversation WHERE id=? AND project_id=? FOR UPDATE",
            (rs, i) -> rs.getLong(1), conversationId, projectId);
        if (rows.isEmpty()) throw missing();
        long head = rows.get(0);
        String parent = head == 0 ? null : jdbc.queryForObject(
            "SELECT entry_id FROM agent_conversation_entry WHERE conversation_id=? AND seq=?", String.class, conversationId, head);
        var goal = JSON.createObjectNode().put("type", "custom_message").put("id", request.taskId())
            .put("parentId", parent).put("timestamp", clock.instant().toString()).put("customType", "manao_user_request")
            .put("content", request.prompt()).put("display", true);
        goal.putObject("details").put("taskId", request.taskId());
        jdbc.update("INSERT INTO agent_conversation_entry(conversation_id,seq,entry_id,source_task_id,writer_id,payload_json) VALUES (?,?,?,?,?,?)",
            conversationId, head + 1, request.taskId(), request.taskId(), request.taskId(), json(goal));
        String title = new String(request.prompt().codePoints().limit(40).toArray(), 0, Math.min(40, request.prompt().codePointCount(0, request.prompt().length())));
        jdbc.update("UPDATE agent_conversation SET title=CASE WHEN head_seq=0 THEN ? ELSE title END,head_seq=?,updated_at=? WHERE id=?",
            title, head + 1, Timestamp.from(clock.instant()), conversationId);
    }

    /** Task and compact admission both call this while holding the project row. */
    static void requireNoCompaction(JdbcTemplate jdbc, String projectId) {
        if (!jdbc.query("SELECT id FROM agent_conversation WHERE project_id=? AND compact_state='RUNNING' FOR UPDATE",
                (rs, i) -> rs.getString(1), projectId).isEmpty()) throw busy();
    }

    private long appendBatch(String conversationId, String sourceTaskId, String writerId, long head, ContextAppend append) {
        Set<String> known = new HashSet<>(jdbc.query("SELECT entry_id FROM agent_conversation_entry WHERE conversation_id=?",
            (rs, i) -> rs.getString(1), conversationId));
        Set<String> batch = new HashSet<>();
        int old = 0;
        long checkedSeq = append.expectedHeadSeq();
        for (var entry : append.entries()) {
            validateEntry(entry);
            validateBrowsable(new StoredEntry(++checkedSeq, sourceTaskId, writerId, entry));
            String id = entry.path("id").asText();
            if (!batch.add(id)) throw conflict();
            if (known.contains(id)) old++;
        }
        if (old > 0) {
            if (old != append.entries().size()) throw conflict();
            for (int i = 0; i < append.entries().size(); i++) {
                var entry = append.entries().get(i);
                var saved = jdbc.query("SELECT seq,source_task_id,writer_id,payload_json FROM agent_conversation_entry WHERE conversation_id=? AND entry_id=?",
                    (rs, n) -> stored(rs), conversationId, entry.path("id").asText()).get(0);
                if (saved.seq() != append.expectedHeadSeq() + i + 1 || !writerId.equals(saved.writerId())
                    || !java.util.Objects.equals(sourceTaskId, saved.sourceTaskId()) || !entry.equals(saved.entry())) throw conflict();
            }
            return append.expectedHeadSeq() + append.entries().size();
        }
        if (head != append.expectedHeadSeq()) throw conflict();
        for (var entry : append.entries()) {
            String id = entry.path("id").asText();
            requireReference(entry, "parentId", known, null, true);
            if ("compaction".equals(entry.path("type").asText())) requireReference(entry, "firstKeptEntryId", known, id, false);
            if ("context_edit".equals(entry.path("type").asText()) || "label".equals(entry.path("type").asText()))
                requireReference(entry, "targetId", known, null, false);
            if ("branch_summary".equals(entry.path("type").asText())) requireReference(entry, "fromId", known, null, false);
            jdbc.update("INSERT INTO agent_conversation_entry(conversation_id,seq,entry_id,source_task_id,writer_id,payload_json) VALUES (?,?,?,?,?,?)",
                conversationId, ++head, id, sourceTaskId, writerId, json(entry));
            known.add(id);
        }
        var usage = append.usage();
        jdbc.update("UPDATE agent_conversation SET head_seq=?,context_tokens=?,usage_head_seq=?,updated_at=? WHERE id=?",
            head, usage == null ? null : usage.tokens(), usage == null ? null : head, Timestamp.from(clock.instant()), conversationId);
        return head;
    }

    private Identity lockTaskConversation(String taskId, String instanceId, long epoch, boolean writing) {
        if (instanceId == null || instanceId.isBlank() || instanceId.length() > 64 || epoch < 0) throw invalid();
        var projects = jdbc.query("SELECT project_id FROM agent_task WHERE id=?", (rs, i) -> rs.getString(1), taskId);
        if (projects.isEmpty()) throw missing();
        String projectId = projects.get(0);
        jdbc.queryForObject("SELECT id FROM project WHERE id=? FOR UPDATE", String.class, projectId);
        var taskRows = jdbc.query("SELECT conversation_id,state FROM agent_task WHERE id=?", (rs, i) -> new String[] {rs.getString(1),rs.getString(2)}, taskId);
        String conversationId = taskRows.get(0)[0];
        if (conversationId == null) throw new ApiException("AI_CONTEXT_UNAVAILABLE", 409, "Task has no conversation");
        var rows = jdbc.query("SELECT head_seq,header_json,compact_state FROM agent_conversation WHERE id=? AND project_id=? FOR UPDATE",
            (rs, i) -> new Identity(conversationId, rs.getLong(1), parse(rs.getString(2)), rs.getString(3)), conversationId, projectId);
        if (rows.isEmpty()) throw missing();
        String state = jdbc.queryForObject("SELECT state FROM agent_task WHERE id=? FOR UPDATE", String.class, taskId);
        tasks.requireWorkerIdentity(taskId, epoch, instanceId);
        if (writing && (!Set.of("QUEUED", "RUNNING").contains(state) || "RUNNING".equals(rows.get(0).compactState()))) throw conflict();
        return rows.get(0);
    }

    private void requireProject(String ownerId, String projectId, boolean lock) {
        var owners = jdbc.query("SELECT owner_id FROM project WHERE id=?" + (lock ? " FOR UPDATE" : ""),
            (rs, i) -> rs.getString(1), projectId);
        if (owners.isEmpty() || !ownerId.equals(owners.get(0))) throw missing();
    }

    private ConversationView view(java.sql.ResultSet rs) throws java.sql.SQLException {
        String id = rs.getString("id");
        var last = jdbc.query("SELECT id,reasoning_effort FROM agent_task WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
            (r, i) -> new String[] {r.getString(1), r.getString(2)}, id);
        var active = jdbc.query("SELECT id FROM agent_task WHERE conversation_id=? AND active_project IS NOT NULL", (r, i) -> r.getString(1), id);
        Long tokens = (Long) rs.getObject("context_tokens");
        Long usageHead = (Long) rs.getObject("usage_head_seq");
        long head = rs.getLong("head_seq");
        ContextUsage usage = usageHead == null ? null : new ContextUsage(java.util.Objects.equals(usageHead, head) ? tokens : null,
            CONTEXT_WINDOW, tokens != null && usageHead == head ? tokens * 100.0 / CONTEXT_WINDOW : null);
        return new ConversationView(id, rs.getString("title"), head, last.isEmpty() ? null : last.get(0)[0],
            active.isEmpty() ? null : active.get(0), usage, rs.getString("compact_request_id"), rs.getString("compact_state"), rs.getString("compact_failure_code"),
            last.isEmpty() || last.get(0)[1] == null ? "high" : last.get(0)[1]);
    }

    private List<StoredEntry> entries(String id, String condition, long cursor, int limit, String direction) {
        return jdbc.query("SELECT seq,source_task_id,writer_id,payload_json FROM agent_conversation_entry WHERE conversation_id=? AND "
            + condition + " ORDER BY seq " + direction + " LIMIT ?", (rs, i) -> stored(rs), id, cursor, limit);
    }
    private StoredEntry stored(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new StoredEntry(rs.getLong(1), rs.getString(2), rs.getString(3), parse(rs.getString(4)));
    }
    private List<HistoryItem> project(StoredEntry row) {
        var entry = row.entry(); String type = entry.path("type").asText();
        if ("custom_message".equals(type) && "manao_user_request".equals(entry.path("customType").asText()))
            return List.of(new HistoryItem(row.seq(), row.sourceTaskId(), "user", text(entry.path("content")), null));
        if ("compaction".equals(type)) return List.of(new HistoryItem(row.seq(), row.sourceTaskId(), "compaction", "上下文已压缩", null));
        if (!"message".equals(type)) return List.of();
        var message = entry.path("message"); String role = message.path("role").asText();
        var items = new ArrayList<HistoryItem>();
        if ("assistant".equals(role)) {
            boolean truncated = "length".equals(message.path("stopReason").asText());
            var content = message.path("content");
            if (content.isTextual()) items.add(new HistoryItem(row.seq(), row.sourceTaskId(), "assistant", content.textValue(), null, 0, 0, truncated));
            if (content.isArray()) for (int index = 0; index < content.size(); index++) {
                var part = content.get(index); String kind = part.path("type").asText();
                if ("text".equals(kind)) items.add(new HistoryItem(row.seq(), row.sourceTaskId(), "assistant", part.path("text").asText(), null, 0, index, truncated));
                else if ("toolCall".equals(kind)) items.add(new HistoryItem(row.seq(), row.sourceTaskId(), "tool_call", part.path("name").asText(), part.path("id").asText(), 0, index, truncated));
                else if ("thinking".equals(kind) || "redacted_thinking".equals(kind) || "encrypted_thinking".equals(kind)) {
                    String thinking = "thinking".equals(kind) && !part.path("redacted").asBoolean() && !part.has("encrypted") && part.path("thinking").isTextual()
                        ? part.path("thinking").textValue() : "该段推理未提供可展示文本";
                    items.add(new HistoryItem(row.seq(), row.sourceTaskId(), "thinking", thinking, null, 0, index, truncated));
                }
            }
        } else if ("toolResult".equals(role)) items.add(new HistoryItem(row.seq(), row.sourceTaskId(), "tool_result", message.path("toolName").asText(), message.path("toolCallId").asText()));
        return items;
    }
    private static String text(JsonNode content) {
        if (content.isTextual()) return content.textValue();
        var text = new StringBuilder();
        if (content.isArray()) for (var part : content) if ("text".equals(part.path("type").asText())) text.append(part.path("text").asText());
        return text.toString();
    }
    /** Every accepted offset group must remain readable without clipping metadata. */
    private void validateBrowsable(StoredEntry row) {
        var groups = new java.util.HashMap<Integer, List<HistoryItem>>();
        for (var item : fragments(project(row)))
            groups.computeIfAbsent(item.textOffset(), ignored -> new ArrayList<>()).add(item);
        for (var group : groups.values()) {
            // Reserve the largest legal cursor envelope, including JSON escaping and
            // repeated tool IDs, before inserting any entry in the atomic batch.
            if (bytes(new HistoryPage(group, Long.MAX_VALUE, Integer.MAX_VALUE)) > HISTORY_LIMIT) throw tooLarge();
        }
    }
    /** UTF-16 offsets always land on complete code points; fragments are bounded before JSON escaping. */
    private static ArrayList<HistoryItem> fragments(List<HistoryItem> projected) {
        var fragments = new ArrayList<HistoryItem>();
        for (var item : projected) {
            String text = item.text();
            if (text.isEmpty()) { fragments.add(item); continue; }
            int start = 0, cursor = 0, utf8 = 0;
            while (cursor < text.length()) {
                int point = text.codePointAt(cursor);
                int size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
                if (utf8 + size > 64 * 1024) {
                    fragments.add(new HistoryItem(item.seq(), item.taskId(), item.kind(), text.substring(start, cursor), item.toolCallId(), start, item.contentIndex(), item.modelTruncated()));
                    start = cursor; utf8 = 0;
                }
                cursor += Character.charCount(point); utf8 += size;
            }
            fragments.add(new HistoryItem(item.seq(), item.taskId(), item.kind(), text.substring(start), item.toolCallId(), start, item.contentIndex(), item.modelTruncated()));
        }
        return fragments;
    }
    private static void validateEntry(JsonNode entry) {
        if (entry == null || !entry.isObject() || !TYPES.contains(entry.path("type").asText())
            || !entry.path("id").isTextual() || entry.path("id").asText().isBlank() || entry.path("id").asText().length() > 64
            || !entry.has("parentId") || !(entry.get("parentId").isNull() || entry.get("parentId").isTextual())
            || !entry.path("timestamp").isTextual()) throw conflict();
        if (bytes(entry) > ENTRY_LIMIT) throw tooLarge();
    }
    private static void requireReference(JsonNode entry, String field, Set<String> known, String self, boolean nullable) {
        var ref = entry.get(field);
        if (ref == null || (ref.isNull() && !nullable) || (!ref.isNull() && (!ref.isTextual()
            || (!known.contains(ref.asText()) && !ref.asText().equals(self))))) throw conflict();
    }
    private static void validateUsage(ContextUsage usage) {
        if (usage != null && (usage.contextWindow() != CONTEXT_WINDOW || (usage.tokens() != null && usage.tokens() < 0)
            || (usage.percent() != null && (!Double.isFinite(usage.percent()) || usage.percent() < 0)))) throw invalid();
    }
    static void requireUuid(String value) {
        if (value == null || !value.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) throw invalid();
    }
    private static JsonNode parse(String value) {
        try { return JSON.readTree(value); } catch (Exception ex) { throw new IllegalStateException("Stored conversation is unreadable", ex); }
    }
    private static String json(Object value) {
        try { return JSON.writeValueAsString(value); } catch (Exception ex) { throw invalid(); }
    }
    private static int bytes(Object value) { return json(value).getBytes(StandardCharsets.UTF_8).length; }
    static ApiException missing() { return new ApiException("AI_CONVERSATION_NOT_FOUND", 404, "Conversation not found"); }
    static ApiException conflict() { return new ApiException("AI_CONTEXT_CONFLICT", 409, "Conversation context changed"); }
    static ApiException busy() { return new ApiException("AI_CONTEXT_BUSY", 409, "Conversation context is busy"); }
    static ApiException invalid() { return new ApiException("VALIDATION_ERROR", 422, "Request validation failed"); }
    static ApiException tooLarge() { return new ApiException("AI_REQUEST_TOO_LARGE", 413, "The request body exceeds the bounded size"); }
    private record Identity(String conversationId, long head, JsonNode header, String compactState) { }
    private record Listed(ConversationView view, Timestamp updated) { }
}
