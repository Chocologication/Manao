package com.manao.poc4.ai;

import static com.manao.poc4.ai.AgentAttachmentContracts.*;
import com.manao.poc4.api.ApiException;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Internal durable implementation of Attachment lifecycle. No disk/network IO inside its transactions. */
public final class AgentAttachmentStore {
    final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final Clock clock;
    record Row(String id, String projectId, String conversationId, String taskId, String fileName, String mimeType,
               long sizeBytes, String sha256, Instant uploadedAt, Instant expiresAt, String state) { }
    public AgentAttachmentStore(JdbcTemplate jdbc, PlatformTransactionManager transactions, Clock clock) {
        this.jdbc = jdbc; this.tx = new TransactionTemplate(transactions); this.clock = clock;
        this.tx.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_READ_COMMITTED);
    }
    void authorize(Scope scope, boolean lock) {
        var rows = jdbc.query("SELECT p.state FROM project p JOIN agent_conversation c ON c.project_id=p.id WHERE p.id=? AND p.owner_id=? AND c.id=?" + (lock ? " FOR UPDATE" : ""),
            (rs,i) -> rs.getString(1), scope.projectId(), scope.ownerId(), scope.conversationId());
        if (rows.isEmpty()) throw missing();
        if ("DELETING".equals(rows.get(0))) throw new ApiException("PROJECT_DELETING", 409, "Project is being deleted");
        if (lock && !"READY".equals(rows.get(0))) throw new ApiException("PROJECT_NOT_READY", 409, "Project is not ready");
    }
    Row register(Scope scope, String id, String name, String mime, long size, String sha) {
        return tx.execute(s -> {
            authorize(scope, true);
            var existing = find(id, true);
            if (existing != null) {
                sameScope(scope, existing);
                if (existing.sizeBytes()!=size || !existing.sha256().equals(sha) || !existing.fileName().equals(name) || !existing.mimeType().equals(mime)) throw conflict();
                return existing;
            }
            Instant now = clock.instant().truncatedTo(java.time.temporal.ChronoUnit.MILLIS);
            jdbc.update("INSERT INTO agent_attachment(id,project_id,conversation_id,file_name,mime_type,size_bytes,sha256,uploaded_at,expires_at,state) VALUES (?,?,?,?,?,?,?,?,?,'UPLOADING')",
                id, scope.projectId(), scope.conversationId(), name, mime, size, sha, Timestamp.from(now), Timestamp.from(now.plus(Duration.ofHours(24))));
            return find(id, true);
        });
    }
    Row owned(Scope scope, String id) { authorize(scope,false); Row r=find(id,false); if(r==null)throw missing(); sameScope(scope,r); return r; }
    Row find(String id, boolean lock) {
        var rows=jdbc.query("SELECT * FROM agent_attachment WHERE id=?"+(lock?" FOR UPDATE":""), (rs,i)->row(rs),id);
        return rows.isEmpty()?null:rows.get(0);
    }
    void ready(Row row) { jdbc.update("UPDATE agent_attachment SET state='READY' WHERE id=? AND state='UPLOADING' AND expires_at>?",row.id(),Timestamp.from(clock.instant())); }
    Row row(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new Row(rs.getString("id"),rs.getString("project_id"),rs.getString("conversation_id"),rs.getString("task_id"),rs.getString("file_name"),rs.getString("mime_type"),rs.getLong("size_bytes"),rs.getString("sha256"),rs.getTimestamp("uploaded_at").toInstant(),rs.getTimestamp("expires_at").toInstant(),rs.getString("state"));
    }
    static void sameScope(Scope scope,Row r) { if(!scope.projectId().equals(r.projectId())||!scope.conversationId().equals(r.conversationId()))throw missing(); }
    static ApiException missing(){return new ApiException("AI_ATTACHMENT_NOT_FOUND",404,"Image not found");}
    static ApiException conflict(){return new ApiException("AI_ATTACHMENT_CONFLICT",409,"Image upload is incomplete or conflicts with its original content");}
}
