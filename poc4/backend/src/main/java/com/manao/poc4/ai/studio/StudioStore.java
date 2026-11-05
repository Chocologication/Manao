package com.manao.poc4.ai.studio;

import static com.manao.poc4.ai.studio.StudioContracts.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.api.ApiException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Owner checks precede every conversation/turn read; JSON updates lock the durable turn. */
public final class StudioStore {
    public static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    public StudioStore(JdbcTemplate jdbc, PlatformTransactionManager transactions) {
        this.jdbc = jdbc; tx = new TransactionTemplate(transactions);
    }
    public void requireProject(String owner, String project) {
        if (!Boolean.TRUE.equals(jdbc.queryForObject("SELECT COUNT(*)>0 FROM project WHERE id=? AND owner_id=?", Boolean.class, project, owner))) throw missing();
    }
    public List<Conversation> conversations(String owner, String project) {
        requireProject(owner, project);
        return jdbc.query("SELECT id,title,updated_at FROM assistant_conversation WHERE project_id=? ORDER BY updated_at DESC,id LIMIT 100",
            (rs, i) -> new Conversation(rs.getString(1), rs.getString(2), rs.getTimestamp(3).toInstant().toString()), project);
    }
    public Conversation create(String owner, String project, String id) {
        requireProject(owner, project); uuid(id);
        var found = jdbc.query("SELECT id FROM assistant_conversation WHERE id=?", (rs, i) -> rs.getString(1), id);
        if (!found.isEmpty()) { requireConversation(owner, project, id); return conversations(owner, project).stream().filter(c -> c.id().equals(id)).findFirst().orElseThrow(StudioStore::missing); }
        var now = Timestamp.from(Instant.now());
        jdbc.update("INSERT INTO assistant_conversation(id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)", id, project, "新会话", now, now);
        return new Conversation(id, "新会话", now.toInstant().toString());
    }
    public void requireConversation(String owner, String project, String conversation) {
        requireProject(owner, project);
        if (!Boolean.TRUE.equals(jdbc.queryForObject("SELECT COUNT(*)>0 FROM assistant_conversation WHERE id=? AND project_id=?", Boolean.class, conversation, project))) throw missing();
    }
    public List<ObjectNode> turns(String owner, String project, String conversation) {
        requireConversation(owner, project, conversation);
        return jdbc.query("SELECT id,version,data_json FROM (SELECT * FROM assistant_turn WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 100) t ORDER BY created_at,id",
            (rs, i) -> parse(rs.getString(3)).put("version", rs.getLong(2)), conversation);
    }
    public ObjectNode turn(String owner, String project, String id) {
        requireProject(owner, project);
        var rows = jdbc.query("SELECT t.data_json,t.version FROM assistant_turn t JOIN assistant_conversation c ON c.id=t.conversation_id WHERE t.id=? AND c.project_id=?",
            (rs, i) -> parse(rs.getString(1)).put("version", rs.getLong(2)), id, project);
        if (rows.isEmpty()) throw missing();
        return rows.get(0);
    }
    public record Created(ObjectNode turn, boolean fresh) { }
    public ObjectNode existingRequest(String owner, String project, String conversation, TurnInput input) {
        requireConversation(owner, project, conversation); uuid(input.id());
        var rows = jdbc.query("SELECT conversation_id,request_digest,data_json,version FROM assistant_turn WHERE id=?", (rs, i) -> {
            if (!conversation.equals(rs.getString(1)) || !hash(json(input)).equals(rs.getString(2))) throw new ApiException("AI_TASK_MISMATCH", 409, "The original request differs");
            return parse(rs.getString(3)).put("version", rs.getLong(4));
        }, input.id());
        return rows.isEmpty() ? null : rows.get(0);
    }
    public Created start(String owner, String project, String conversation, TurnInput input) {
        requireConversation(owner, project, conversation);
        if (input == null) throw invalid();
        uuid(input.id()); bounded(input.prompt(), 24000); uuid(input.modelId());
        if (!List.of("CHAT", "TASK").contains(input.mode()) || !List.of("AUTO", "REVIEW").contains(input.applyPolicy())) throw invalid();
        if (input.attachmentIds() == null || input.attachmentIds().size() > 8 || input.references() == null || input.references().size() > 12) throw invalid();
        for (var reference : input.references()) {
            if (reference == null || !List.of("file", "code", "logs").contains(reference.kind()) || reference.path() == null || reference.path().length() > 1024
                || reference.text() != null && reference.text().length() > 32000) throw invalid();
        }
        String digest = hash(json(JSON.valueToTree(input)));
        return tx.execute(status -> {
            jdbc.queryForObject("SELECT id FROM assistant_conversation WHERE id=? FOR UPDATE", String.class, conversation);
            var existing = jdbc.query("SELECT request_digest,data_json FROM assistant_turn WHERE id=?", (rs, i) -> new String[]{rs.getString(1), rs.getString(2)}, input.id());
            if (!existing.isEmpty()) {
                ObjectNode previous = parse(existing.get(0)[1]);
                if (!conversation.equals(previous.path("conversationId").asText()) || !digest.equals(existing.get(0)[0])) throw new ApiException("AI_TASK_MISMATCH", 409, "The original request differs");
                return new Created(previous, false);
            }
            int active = jdbc.queryForObject("SELECT COUNT(*) FROM assistant_turn WHERE conversation_id=? AND JSON_UNQUOTE(JSON_EXTRACT(data_json,'$.state')) IN ('RUNNING','STOPPING','ATTENTION')", Integer.class, conversation);
            if (active > 0) throw new ApiException("AI_TASK_ACTIVE", 409, "A reply is still running");
            ObjectNode data = JSON.createObjectNode().put("id", input.id()).put("conversationId", conversation)
                .put("mode", input.mode()).put("applyPolicy", input.applyPolicy()).put("modelId", input.modelId())
                .put("prompt", input.prompt()).put("reply", "").put("state", "RUNNING").put("createdAt", Instant.now().toString())
                .put("expectedRevision", input.expectedRevision() == null ? "0" : input.expectedRevision()).put("version", 0);
            data.set("attachmentIds", JSON.valueToTree(input.attachmentIds())); data.set("references", JSON.valueToTree(input.references()));
            data.putArray("tools"); data.putArray("files");
            jdbc.update("INSERT INTO assistant_turn(id,conversation_id,request_digest,data_json,created_at) VALUES (?,?,?,?,?)", input.id(), conversation, digest, json(data), Timestamp.from(Instant.now()));
            jdbc.update("UPDATE assistant_conversation SET title=CASE WHEN title='新会话' THEN ? ELSE title END,updated_at=? WHERE id=?",
                input.prompt().substring(0, Math.min(60, input.prompt().length())), Timestamp.from(Instant.now()), conversation);
            return new Created(data, true);
        });
    }
    public ObjectNode mutate(String id, Consumer<ObjectNode> change) {
        return tx.execute(status -> {
            var rows = jdbc.query("SELECT data_json,version FROM assistant_turn WHERE id=? FOR UPDATE", (rs, i) -> parse(rs.getString(1)).put("version", rs.getLong(2)), id);
            if (rows.isEmpty()) throw missing();
            var data = rows.get(0); change.accept(data);
            data.put("version", data.path("version").asLong() + 1);
            if (json(data).getBytes(StandardCharsets.UTF_8).length > 4 * 1024 * 1024) throw new ApiException("FILE_TOO_LARGE", 422, "Conversation turn exceeds its size limit");
            jdbc.update("UPDATE assistant_turn SET data_json=?,version=? WHERE id=?", json(data), data.path("version").asLong(), id);
            return data;
        });
    }
    public List<String> interruptedChats() {
        return jdbc.query("SELECT id FROM assistant_turn WHERE JSON_UNQUOTE(JSON_EXTRACT(data_json,'$.mode'))='CHAT' AND JSON_UNQUOTE(JSON_EXTRACT(data_json,'$.state')) IN ('RUNNING','STOPPING')", (rs, i) -> rs.getString(1));
    }
    public static ObjectNode parse(String text) { try { return (ObjectNode) JSON.readTree(text); } catch (Exception ex) { throw new IllegalStateException("Unreadable assistant data", ex); } }
    public static String json(Object value) { try { return JSON.writeValueAsString(value); } catch (Exception ex) { throw new IllegalStateException(ex); } }
    public static String uuid(String id) { try { if (!UUID.fromString(id).toString().equals(id)) throw invalid(); return id; } catch (RuntimeException ex) { throw invalid(); } }
    public static String bounded(String value, int limit) { if (value == null || value.isBlank() || value.length() > limit) throw invalid(); return value.trim(); }
    public static String hash(String text) { try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8))); } catch (Exception ex) { throw new IllegalStateException(ex); } }
    public static ApiException invalid() { return new ApiException("VALIDATION_ERROR", 422, "Invalid assistant request"); }
    public static ApiException missing() { return new ApiException("ENTRY_NOT_FOUND", 404, "Assistant resource not found"); }
}
