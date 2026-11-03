package com.manao.poc4.ai;

import static com.manao.poc4.ai.AgentAttachmentContracts.*;
import static com.manao.poc4.ai.AgentAttachmentStore.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.workspace.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Clock;
import java.util.*;

/** Sole lifecycle interface: authorization, immutable TTL, upload reconciliation, binding and deletion. */
public final class AgentAttachmentService {
    public static final int MAX_BYTES=10_000_000;
    private static final ObjectMapper JSON=new ObjectMapper();
    private final AgentAttachmentStore store;
    private final WorkspaceAgent agent;
    private final ProjectLifecycleGate gate;
    private final Clock clock;
    private final java.util.function.BooleanSupplier imageInput;
    public AgentAttachmentService(AgentAttachmentStore store, WorkspaceAgent agent, ProjectLifecycleGate gate, Clock clock) {
        this(store,agent,gate,clock,()->true);
    }
    public AgentAttachmentService(AgentAttachmentStore store, WorkspaceAgent agent, ProjectLifecycleGate gate, Clock clock,
        java.util.function.BooleanSupplier imageInput) {
        this.store=store;this.agent=agent;this.gate=gate;this.clock=clock;
        this.imageInput=imageInput;
    }
    public boolean imageInputEnabled(){return imageInput.getAsBoolean();}
    public long serverNow(){return clock.millis();}
    public void requireImageInput(){if(!imageInputEnabled())throw new ApiException("AI_IMAGE_INPUT_DISABLED",409,"Image input is unavailable for the configured model");}
    public AttachmentRef registerOrConfirm(Scope scope,String id,String name,String mime,byte[] bytes) {
        uuid(id);
        store.authorize(scope,false);
        requireImageInput();
        if(bytes.length>MAX_BYTES)throw new ApiException("AI_ATTACHMENT_TOO_LARGE",413,"Image exceeds 10000000 bytes");
        if(name==null||name.isBlank()||mime==null||mime.length()>255)throw new ApiException("VALIDATION_ERROR",422,"Invalid image metadata");
        try(var lease=gate.tryAcquire(scope.projectId()).orElseThrow(()->new ApiException("PROJECT_BUSY",409,"Project is busy"))) {
            Row row=store.register(scope,id,name,mime,bytes.length,sha(bytes));
            active(row);
            if("READY".equals(row.state()))return ref(row);
            // Confirm before repeating a write: the first response may have been lost after atomic rename.
            boolean present=confirmDisk(row);
            if(!present) {
                try { agent.putAttachment(row.projectId(),row.id(),row.sha256(),row.expiresAt().toEpochMilli(),bytes); }
                catch(WorkspaceAgentException ex) {
                    if(!confirmDisk(row))throw unavailable();
                }
                if(!confirmDisk(row))throw conflict();
            }
            store.ready(row);
            Row current=store.owned(scope,id); requireReady(current); return ref(current);
        }
    }
    public AttachmentRef confirm(Scope scope,String id) {
        uuid(id); Row row=store.owned(scope,id);
        if("UPLOADING".equals(row.state())&&clock.instant().isBefore(row.expiresAt())&&confirmDisk(row))store.ready(row);
        return ref(store.owned(scope,id));
    }
    private boolean confirmDisk(Row row) {
        try {
            var result=agent.confirmAttachment(row.projectId(),row.id());
            if(!result.sha256().equals(row.sha256())||result.sizeBytes()!=row.sizeBytes()||result.expiresAt()!=row.expiresAt().toEpochMilli())throw unavailable();
            return true;
        } catch(WorkspaceAgentException ex) {
            if(ex.status()==404)return false;
            if(ex.status()==410)throw expired();
            throw unavailable();
        }
    }
    public Opened open(Scope scope,String id) {
        uuid(id); Row row=store.owned(scope,id);requireReady(row);
        byte[] bytes;
        try { bytes=agent.openAttachment(row.projectId(),id,row.sha256(),row.expiresAt().toEpochMilli()); }
        catch(WorkspaceAgentException ex){if(ex.status()==410)throw expired();throw unavailable();}
        if(bytes.length!=row.sizeBytes()||!sha(bytes).equals(row.sha256()))throw unavailable();
        requireReady(store.owned(scope,id));return new Opened(ref(row),bytes);
    }
    public Scope taskScope(String taskId) {
        var rows=store.jdbc.query("SELECT owner_id,project_id,conversation_id FROM agent_task WHERE id=?",(rs,i)->new Scope(rs.getString(1),rs.getString(2),rs.getString(3)),taskId);
        if(rows.isEmpty()||rows.get(0).conversationId()==null)throw missing();return rows.get(0);
    }
    public Opened openForTask(String taskId,String id) { Scope scope=taskScope(taskId);Row row=store.owned(scope,id);if(row.taskId()==null)throw missing();return open(scope,id); }
    public AttachmentRef referenceForTask(String taskId,String id) { Scope scope=taskScope(taskId);Row row=store.owned(scope,id);if(row.taskId()==null)throw missing();requireReady(row);return ref(row); }
    public List<AttachmentRef> historyReferences(String taskId,com.fasterxml.jackson.databind.JsonNode refs) {
        if(!refs.isArray())return List.of();
        Scope scope=taskScope(taskId);List<AttachmentRef> result=new ArrayList<>();
        for(var reference:refs){Row row=store.owned(scope,reference.path("attachmentId").asText());if(!taskId.equals(row.taskId()))throw missing();result.add(ref(row));}
        return List.copyOf(result);
    }
    /** Joins the caller's existing project-row task transaction. No network IO. */
    public List<AttachmentRef> bindWithinTaskTransaction(String owner,String project,String conversation,String task,List<String> ids) {
        if(ids==null||ids.isEmpty())return List.of();
        Scope scope=new Scope(owner,project,conversation);store.authorize(scope,true);
        if(new HashSet<>(ids).size()!=ids.size())throw conflict();
        List<AttachmentRef> refs=new ArrayList<>();
        for(String id:ids){uuid(id);Row row=store.find(id,true);if(row==null)throw missing();sameScope(scope,row);requireReady(row);
            if(row.taskId()!=null&&!task.equals(row.taskId()))throw conflict();
            store.jdbc.update("UPDATE agent_attachment SET task_id=? WHERE id=?",task,id);
            refs.add(ref(store.find(id,false)));
        }return refs;
    }
    /** Immutable digest used even for an accepted task whose attachments have since expired. */
    public List<String> requestDigests(String owner,String project,String conversation,List<String> ids) {
        if(ids==null||ids.isEmpty())return List.of();Scope scope=new Scope(owner,project,conversation);store.authorize(scope,false);
        List<String> result=new ArrayList<>();for(String id:ids){uuid(id);result.add(store.owned(scope,id).sha256());}return result;
    }
    public AttachmentPage catalog(String taskId,String cursor) {
        Scope scope=taskScope(taskId);store.authorize(scope,false);
        List<Object> args=new ArrayList<>(List.of(scope.projectId(),scope.conversationId(),Timestamp.from(clock.instant())));
        String condition="";
        if(cursor!=null){
            try {String[] parts=new String(Base64.getUrlDecoder().decode(cursor),StandardCharsets.UTF_8).split("\\|",-1);
                if(parts.length!=3||!parts[0].equals(scope.conversationId()))throw new IllegalArgumentException();uuid(parts[2]);
                Timestamp at=Timestamp.from(java.time.Instant.parse(parts[1]));condition=" AND (uploaded_at<? OR (uploaded_at=? AND id<?))";args.addAll(List.of(at,at,parts[2]));
            }catch(Exception ex){throw new ApiException("VALIDATION_ERROR",422,"Invalid image catalog cursor");}
        }
        var rows=store.jdbc.query("SELECT * FROM agent_attachment WHERE project_id=? AND conversation_id=? AND task_id IS NOT NULL AND state='READY' AND expires_at>?"+condition+" ORDER BY uploaded_at DESC,id DESC LIMIT 51",(rs,i)->store.row(rs),args.toArray());
        List<AttachmentRef> page=new ArrayList<>();Row last=null;boolean more=false;
        for(Row row:rows){if(page.size()==50){more=true;break;}AttachmentRef full=ref(row);AttachmentRef item=new AttachmentRef(full.kind(),full.version(),full.attachmentId(),truncate(full.fileName(),80),full.mimeType(),full.sizeBytes(),full.sha256(),full.uploadedAt(),full.expiresAt(),full.taskId(),full.availability());
            page.add(item);if(encodedSize(page)>15_000){page.remove(page.size()-1);more=true;break;}last=row;
        }
        String next=more&&last!=null?Base64.getUrlEncoder().withoutPadding().encodeToString((scope.conversationId()+"|"+last.uploadedAt()+"|"+last.id()).getBytes(StandardCharsets.UTF_8)):null;
        return new AttachmentPage("image_catalog",List.copyOf(page),next);
    }
    public ReapResult reapExpired(int batchSize) {
        int deleted=0,failed=0;
        var rows=store.jdbc.query("SELECT * FROM agent_attachment WHERE state IN ('UPLOADING','READY','DELETING') AND expires_at<=? ORDER BY cleanup_attempted_at IS NOT NULL,cleanup_attempted_at,expires_at,id LIMIT ?",(rs,i)->store.row(rs),Timestamp.from(clock.instant()),batchSize);
        for(Row row:rows){store.jdbc.update("UPDATE agent_attachment SET state='DELETING',cleanup_attempted_at=? WHERE id=? AND state<>'DELETED'",Timestamp.from(clock.instant()),row.id());
            try {agent.deleteAttachment(row.projectId(),row.id());store.jdbc.update("UPDATE agent_attachment SET state='DELETED',deleted_at=?,cleanup_failure_code=NULL WHERE id=? AND state='DELETING'",Timestamp.from(clock.instant()),row.id());deleted++;}
            catch(RuntimeException ex){store.jdbc.update("UPDATE agent_attachment SET cleanup_failure_code='AI_ATTACHMENT_UNAVAILABLE' WHERE id=?",row.id());failed++;}
        }return new ReapResult(deleted,failed);
    }
    private AttachmentRef ref(Row row){return new AttachmentRef("manao_image_ref",1,row.id(),row.fileName(),row.mimeType(),row.sizeBytes(),row.sha256(),row.uploadedAt().toString(),row.expiresAt().toString(),row.taskId(),clock.instant().isBefore(row.expiresAt())?row.state():"EXPIRED");}
    private void active(Row row){if(!clock.instant().isBefore(row.expiresAt())||List.of("DELETING","DELETED").contains(row.state()))throw expired();}
    private void requireReady(Row row){active(row);if(!"READY".equals(row.state()))throw conflict();}
    public static void uuid(String id){try{if(!UUID.fromString(id).toString().equals(id))throw new IllegalArgumentException();}catch(Exception ex){throw new ApiException("VALIDATION_ERROR",422,"Invalid attachment ID");}}
    public static String sha(byte[] bytes){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}catch(Exception ex){throw new IllegalStateException(ex);}}
    private static int encodedSize(Object value){try{return JSON.writeValueAsBytes(value).length;}catch(Exception ex){throw new IllegalStateException(ex);}}
    private static String truncate(String value,int n){return value.codePoints().limit(n).collect(StringBuilder::new,StringBuilder::appendCodePoint,StringBuilder::append).toString();}
    static ApiException expired(){return new ApiException("AI_ATTACHMENT_EXPIRED",410,"Image expired; upload it again");}
    static ApiException unavailable(){return new ApiException("AI_ATTACHMENT_UNAVAILABLE",503,"Image is unavailable");}
}
