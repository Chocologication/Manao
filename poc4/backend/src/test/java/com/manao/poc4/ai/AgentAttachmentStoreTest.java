package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.*;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.workspace.*;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

class AgentAttachmentStoreTest {
    @Test void taskAdmissionRejectsOtherScopesExpiredAndPreviouslyBoundImages() {
        try(var h=new Harness()){
            var tx=new DataSourceTransactionManager(h.jdbc.getDataSource());
            var conversations=new AgentConversationStore(h.jdbc,tx,Clock.fixed(h.now,ZoneOffset.UTC),h.tasks,h.service);
            String otherConversation=UUID.randomUUID().toString();
            conversations.create("owner","project",new AgentConversationContracts.CreateConversationRequest(otherConversation));
            String id=h.insert("READY","ready.png",0),expired=h.insert("READY","expired.png",-86400);
            assertThatThrownBy(()->h.tasks.createTask("owner","project",h.request(UUID.randomUUID().toString(),List.of(id)),otherConversation))
                .isInstanceOfSatisfying(com.manao.poc4.api.ApiException.class,ex->assertThat(ex.status()).isEqualTo(404));
            assertThatThrownBy(()->h.tasks.createTask("owner","project",h.request(UUID.randomUUID().toString(),List.of(expired)),h.conversation))
                .isInstanceOfSatisfying(com.manao.poc4.api.ApiException.class,ex->assertThat(ex.status()).isEqualTo(410));
            String first=UUID.randomUUID().toString();h.tasks.createTask("owner","project",h.request(first,List.of(id)),h.conversation);
            h.tasks.applyTerminal(first,AgentContracts.TaskState.COMPLETED,"done",null);
            String second=UUID.randomUUID().toString();
            assertThatThrownBy(()->h.tasks.createTask("owner","project",h.request(second,List.of(id)),h.conversation))
                .isInstanceOfSatisfying(com.manao.poc4.api.ApiException.class,ex->assertThat(ex.status()).isEqualTo(409));
            assertThat(h.jdbc.queryForObject("SELECT COUNT(*) FROM agent_task WHERE id=?",Integer.class,second)).isZero();
            h.jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('other-project','owner','other','READY',0,?,?)",Timestamp.from(h.now),Timestamp.from(h.now));
            String foreignConversation=UUID.randomUUID().toString();
            conversations.create("owner","other-project",new AgentConversationContracts.CreateConversationRequest(foreignConversation));
            assertThatThrownBy(()->h.service.open(new AgentAttachmentContracts.Scope("owner","other-project",foreignConversation),id))
                .isInstanceOfSatisfying(com.manao.poc4.api.ApiException.class,ex->assertThat(ex.status()).isEqualTo(404));
        }
    }
    @Test void historyBudgetReservesGrowthFromReadyToExpiredAndKeepsRepliesReadable() throws Exception {
        try(var h=new Harness()){
            var json=new com.fasterxml.jackson.databind.ObjectMapper();String task=UUID.randomUUID().toString();
            var ids=new ArrayList<String>();for(int n=0;n<100;n++)ids.add(h.insert("READY","x",0));
            var scope=new AgentAttachmentContracts.Scope("owner","project",h.conversation);
            var refs=new ArrayList<AgentAttachmentContracts.AttachmentRef>();
            for(String id:ids){var r=h.service.confirm(scope,id);refs.add(new AgentAttachmentContracts.AttachmentRef(r.kind(),r.version(),r.attachmentId(),r.fileName(),r.mimeType(),r.sizeBytes(),r.sha256(),r.uploadedAt(),r.expiresAt(),task,"READY"));}
            var item=new AgentConversationContracts.HistoryItem(Long.MAX_VALUE,task,"user","inspect",null,0,0,false,refs);
            int room=524288-json.writeValueAsBytes(new AgentConversationContracts.HistoryPage(List.of(item),Long.MAX_VALUE,Integer.MAX_VALUE)).length;
            for(String id:ids){int add=Math.min(59_999,room);h.jdbc.update("UPDATE agent_attachment SET file_name=? WHERE id=?","x".repeat(add+1),id);room-=add;}
            assertThat(room).isZero();
            assertThatThrownBy(()->h.tasks.createTask("owner","project",h.request(task,ids),h.conversation))
                .isInstanceOfSatisfying(com.manao.poc4.api.ApiException.class,ex->assertThat(ex.status()).isEqualTo(413));
            assertThat(h.jdbc.queryForObject("SELECT head_seq FROM agent_conversation WHERE id=?",Long.class,h.conversation)).isZero();
            h.jdbc.update("UPDATE agent_attachment SET file_name=LEFT(file_name,CHAR_LENGTH(file_name)-1000) WHERE id=?",ids.get(0));
            h.tasks.createTask("owner","project",h.request(task,ids),h.conversation);
            var expiredClock=Clock.fixed(h.now.plusSeconds(86400),ZoneOffset.UTC);
            var tx=new DataSourceTransactionManager(h.jdbc.getDataSource());
            var expired=new AgentAttachmentService(new AgentAttachmentStore(h.jdbc,tx,expiredClock),h.agent,new ProjectLifecycleGate(),expiredClock);
            var history=new AgentConversationStore(h.jdbc,tx,expiredClock,h.tasks,expired).history("owner","project",h.conversation,null,null,50);
            assertThat(history.items().get(0).attachments()).hasSize(100).allMatch(ref->"EXPIRED".equals(ref.availability()));
            assertThat(json.writeValueAsBytes(history).length).isLessThanOrEqualTo(524288);
        }
    }
    @Test void taskBindingRollsBackTogetherWithHistoryAndRejectsTransportOverflowWithoutCountLimit() {
        try(var h=new Harness()) {
            String good=h.insert("READY","good.png",0),pending=h.insert("UPLOADING","pending.png",0);
            String task=UUID.randomUUID().toString();
            assertThatThrownBy(()->h.tasks.createTask("owner","project",h.request(task,List.of(good,pending)),h.conversation))
                .isInstanceOfSatisfying(com.manao.poc4.api.ApiException.class,ex->assertThat(ex.status()).isEqualTo(409));
            assertThat(h.jdbc.queryForObject("SELECT task_id FROM agent_attachment WHERE id=?",String.class,good)).isNull();
            assertThat(h.jdbc.queryForObject("SELECT COUNT(*) FROM agent_task WHERE id=?",Integer.class,task)).isZero();
            assertThat(h.jdbc.queryForObject("SELECT head_seq FROM agent_conversation WHERE id=?",Long.class,h.conversation)).isZero();
            // Bytes, rather than a fixed image count, define the existing history transport budget.
            var many=new ArrayList<String>();
            for(int n=0;n<12;n++)many.add(h.insert("READY","x".repeat(60_000)+n,0));
            String large=UUID.randomUUID().toString();
            assertThatThrownBy(()->h.tasks.createTask("owner","project",h.request(large,many),h.conversation))
                .isInstanceOfSatisfying(com.manao.poc4.api.ApiException.class,ex->assertThat(ex.code()).isEqualTo("AI_REQUEST_TOO_LARGE"));
            assertThat(h.jdbc.queryForObject("SELECT COUNT(*) FROM agent_attachment WHERE task_id=?",Integer.class,large)).isZero();
            assertThat(h.jdbc.queryForObject("SELECT COUNT(*) FROM agent_task WHERE id=?",Integer.class,large)).isZero();
        }
    }
    @Test void cleanupMovesPastAnEntireFailedBatchToReachOtherExpiredImages() {
        try(var h=new Harness()) {
            for(int n=0;n<100;n++)h.insert("READY","failed.png",-172800);
            String healthy=h.insert("READY","healthy.png",-86400);
            org.mockito.Mockito.doAnswer(inv->{
                if(!healthy.equals(inv.getArgument(1)))throw new WorkspaceAgentException(503,"IO_ERROR","unavailable");
                return null;
            }).when(h.agent).deleteAttachment(org.mockito.ArgumentMatchers.anyString(),org.mockito.ArgumentMatchers.anyString());
            assertThat(h.service.reapExpired(100).failed()).isEqualTo(100);
            assertThat(h.service.reapExpired(100).deleted()).isEqualTo(1);
            assertThat(h.jdbc.queryForObject("SELECT state FROM agent_attachment WHERE id=?",String.class,healthy)).isEqualTo("DELETED");
        }
    }
    static final class Harness implements AutoCloseable {
        final JdbcStoreTestSupport db=JdbcStoreTestSupport.create();
        final org.springframework.jdbc.core.JdbcTemplate jdbc=db.jdbc();
        final String conversation=UUID.randomUUID().toString();
        final Instant now=Instant.parse("2026-11-02T00:00:00Z");
        final WorkspaceAgent agent=org.mockito.Mockito.mock(WorkspaceAgent.class);
        final AgentAttachmentService service;
        final AgentTaskStore tasks;
        Harness(){
            var tx=new DataSourceTransactionManager(jdbc.getDataSource());var clock=Clock.fixed(now,ZoneOffset.UTC);
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('owner','owner','unused',?)",Timestamp.from(now));
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('project','owner','project','READY',0,?,?)",Timestamp.from(now),Timestamp.from(now));
            service=new AgentAttachmentService(new AgentAttachmentStore(jdbc,tx,clock),agent,new ProjectLifecycleGate(),clock);
            tasks=new AgentTaskStore(jdbc,tx,clock,service);
            new AgentConversationStore(jdbc,tx,clock,tasks,service).create("owner","project",new AgentConversationContracts.CreateConversationRequest(conversation));
        }
        String insert(String state,String name,long uploadedOffset){
            String id=UUID.randomUUID().toString();
            jdbc.update("INSERT INTO agent_attachment(id,project_id,conversation_id,file_name,mime_type,size_bytes,sha256,uploaded_at,expires_at,state) VALUES (?,'project',?,?,'image/png',1,?,?,?,?)",
                id,conversation,name,"a".repeat(64),Timestamp.from(now.plusSeconds(uploadedOffset)),Timestamp.from(now.plusSeconds(uploadedOffset+86400)),state);
            return id;
        }
        AgentContracts.TaskRequest request(String id,List<String> images){return new AgentContracts.TaskRequest(id,"inspect",0,null,images);}
        public void close(){db.close();}
    }
}
