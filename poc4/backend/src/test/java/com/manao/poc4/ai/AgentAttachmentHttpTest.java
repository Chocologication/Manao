package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.*;
import static com.manao.poc4.ai.AgentAttachmentContracts.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.workspace.WorkspaceAgent;
import java.time.*;
import java.sql.Timestamp;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class AgentAttachmentHttpTest {
    @Test void uploadConfirmIsolationAndExpiryCrossHttpAndDurableStore() throws Exception {
        try(var db=JdbcStoreTestSupport.create()) {
            var jdbc=db.jdbc(); var time=new MutableClock();
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('image-owner','image-owner','unused',?)",Timestamp.from(time.instant()));
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('image-project','image-owner','images','READY',0,?,?)",Timestamp.from(time.instant()),Timestamp.from(time.instant()));
            var tasks=new AgentTaskStore(jdbc,new DataSourceTransactionManager(jdbc.getDataSource()),time);
            var conversations=new AgentConversationStore(jdbc,new DataSourceTransactionManager(jdbc.getDataSource()),time,tasks);
            String conversation=UUID.randomUUID().toString();
            conversations.create("image-owner","image-project",new AgentConversationContracts.CreateConversationRequest(conversation));
            WorkspaceAgent agent=org.mockito.Mockito.mock(WorkspaceAgent.class);
            Map<String,WorkspaceAgent.AttachmentMeta> disk=new HashMap<>();
            Map<String,byte[]> files=new HashMap<>();
            org.mockito.Mockito.when(agent.confirmAttachment(org.mockito.ArgumentMatchers.anyString(),org.mockito.ArgumentMatchers.anyString())).thenAnswer(inv->{
                var meta=disk.get(inv.getArgument(1));if(meta==null)throw new com.manao.poc4.workspace.WorkspaceAgentException(404,"ENTRY_NOT_FOUND","absent");return meta;
            });
            org.mockito.Mockito.when(agent.putAttachment(org.mockito.ArgumentMatchers.anyString(),org.mockito.ArgumentMatchers.anyString(),org.mockito.ArgumentMatchers.anyString(),org.mockito.ArgumentMatchers.anyLong(),org.mockito.ArgumentMatchers.any())).thenAnswer(inv->{
                String id=inv.getArgument(1);byte[] bytes=inv.getArgument(4);
                var meta=new WorkspaceAgent.AttachmentMeta(id,inv.getArgument(2),bytes.length,inv.getArgument(3));
                disk.put(id,meta);files.put(id,bytes);
                throw new com.manao.poc4.workspace.WorkspaceAgentException(503,"IO_ERROR","lost ACK");
            });
            org.mockito.Mockito.when(agent.openAttachment(org.mockito.ArgumentMatchers.anyString(),org.mockito.ArgumentMatchers.anyString(),org.mockito.ArgumentMatchers.anyString(),org.mockito.ArgumentMatchers.anyLong())).thenAnswer(inv->files.get(inv.getArgument(1)));
            var service=new AgentAttachmentService(new AgentAttachmentStore(jdbc,new DataSourceTransactionManager(jdbc.getDataSource()),time),agent,new ProjectLifecycleGate(),time);
            tasks=new AgentTaskStore(jdbc,new DataSourceTransactionManager(jdbc.getDataSource()),time,service);
            var mvc=MockMvcBuilders.standaloneSetup(new AgentAttachmentController(service)).build();
            String id=UUID.randomUUID().toString(),url="/api/v1/projects/image-project/conversations/"+conversation+"/attachments/"+id;
            byte[] bytes=new byte[10_000_000];
            mvc.perform(multipart(url).file(new MockMultipartFile("file","a.png","image/png",bytes)).with(req->{req.setMethod("PUT");req.setUserPrincipal(()->"image-owner");return req;})).andExpect(status().isOk()).andExpect(jsonPath("$.availability").value("READY"));
            var first=service.confirm(new Scope("image-owner","image-project",conversation),id);
            time.at=time.at.plusSeconds(23*3600);
            String taskId=UUID.randomUUID().toString();
            var mapper=new com.fasterxml.jackson.databind.ObjectMapper().disable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
            var request=mapper.convertValue(Map.of("taskId",taskId,"prompt","","expectedRevision",0,"attachmentIds",List.of(id)),AgentContracts.TaskRequest.class);
            var created=tasks.createTask("image-owner","image-project",request,conversation);
            assertThat(created.snapshot().state()).isEqualTo(AgentContracts.TaskState.QUEUED);
            assertThat(jdbc.queryForObject("SELECT prompt FROM agent_task WHERE id=?",String.class,taskId)).isEqualTo("请分析上传的图片");
            String history=jdbc.queryForObject("SELECT payload_json FROM agent_conversation_entry WHERE entry_id=?",String.class,taskId);
            assertThat(history).contains("manao_image_ref").contains(id).doesNotContain("data:image");
            // More than one page, including long escaped names. Every committed image remains discoverable.
            var expected=new HashSet<String>();expected.add(id);
            for(int n=0;n<70;n++) {
                String catalogId=UUID.randomUUID().toString();expected.add(catalogId);
                jdbc.update("INSERT INTO agent_attachment(id,project_id,conversation_id,task_id,file_name,mime_type,size_bytes,sha256,uploaded_at,expires_at,state) VALUES (?,'image-project',?,?,?,'image/png',1,?,?,?,'READY')",
                    catalogId,conversation,taskId,"中\\\"".repeat(80)+n,"b".repeat(64),Timestamp.from(time.at),Timestamp.from(time.at.plusSeconds(3600)));
            }
            var found=new HashSet<String>();String cursor=null;int pages=0;
            do {
                var page=service.catalog(taskId,cursor);pages++;
                assertThat(mapper.writeValueAsBytes(page).length).isLessThanOrEqualTo(16384);
                assertThat(page.items().size()).isLessThanOrEqualTo(50);
                for(var item:page.items())assertThat(found.add(item.attachmentId())).isTrue();
                cursor=page.nextCursor();
            }while(cursor!=null);
            assertThat(pages).isGreaterThan(1);assertThat(found).isEqualTo(expected);
            tasks.bindWorkerInstance(taskId,1,"image-worker");
            var internal=MockMvcBuilders.standaloneSetup(new AgentAttachmentInternalController(service,tasks))
                .setControllerAdvice(new com.manao.poc4.api.GlobalExceptionHandler()).build();
            String internalUrl="/internal/ai/tasks/"+taskId+"/attachments";
            internal.perform(get(internalUrl).header("X-Manao-Worker-Epoch","1").header("X-Manao-Worker-Instance","image-worker")).andExpect(status().isOk()).andExpect(jsonPath("$.items").isArray());
            internal.perform(get(internalUrl+"/"+id+"/content").header("X-Manao-Worker-Epoch","1").header("X-Manao-Worker-Instance","image-worker")).andExpect(status().isOk()).andExpect(content().bytes(bytes));
            internal.perform(get(internalUrl).header("X-Manao-Worker-Epoch","0").header("X-Manao-Worker-Instance","image-worker")).andExpect(status().isConflict());
            internal.perform(get(internalUrl).header("X-Manao-Worker-Epoch","1").header("X-Manao-Worker-Instance","stale-worker")).andExpect(status().isConflict());
            var workspaceStore=new com.manao.poc4.workspace.WorkspaceJdbcStore(jdbc,new DataSourceTransactionManager(jdbc.getDataSource()));
            var tools=new AgentProjectTools(tasks,workspaceStore,null,null,new ProjectLifecycleGate(),null,null,service);
            var readRequest=new AgentContracts.ToolRequest("read-image","read_image",0,mapper.valueToTree(Map.of("attachmentId",id)));
            assertThat(tools.invoke(taskId,readRequest).data().path("kind").asText()).isEqualTo("image_reference");
            var invalid=new AgentContracts.ToolRequest("bad-image","read_image",0,mapper.valueToTree(Map.of("attachmentId",id,"cursor","bad")));
            assertThat(tools.invoke(taskId,invalid).data().path("error").path("code").asText()).isEqualTo("VALIDATION_ERROR");
            assertThat(service.registerOrConfirm(new Scope("image-owner","image-project",conversation),id,"a.png","image/png",bytes).expiresAt()).isEqualTo(first.expiresAt());
            assertThat(service.open(new Scope("image-owner","image-project",conversation),id).bytes()).hasSize(10_000_000);
            assertThatThrownBy(()->service.open(new Scope("other","image-project",conversation),id)).isInstanceOfSatisfying(com.manao.poc4.api.ApiException.class,ex->assertThat(ex.status()).isEqualTo(404));
            assertThatThrownBy(()->service.open(new Scope("image-owner","image-project",UUID.randomUUID().toString()),id)).isInstanceOfSatisfying(com.manao.poc4.api.ApiException.class,ex->assertThat(ex.status()).isEqualTo(404));
            assertThatThrownBy(()->service.registerOrConfirm(new Scope("image-owner","image-project",conversation),id,"a.png","image/png",new byte[]{1})).isInstanceOfSatisfying(com.manao.poc4.api.ApiException.class,ex->assertThat(ex.status()).isEqualTo(409));
            assertThatThrownBy(()->service.registerOrConfirm(new Scope("image-owner","image-project",conversation),UUID.randomUUID().toString(),"big.png","image/png",new byte[10_000_001])).isInstanceOfSatisfying(com.manao.poc4.api.ApiException.class,ex->assertThat(ex.status()).isEqualTo(413));
            time.at=time.at.plusSeconds(3600);
            internal.perform(get(internalUrl+"/"+id+"/content").header("X-Manao-Worker-Epoch","1").header("X-Manao-Worker-Instance","image-worker")).andExpect(status().isGone());
            assertThat(tools.invoke(taskId,readRequest).data().path("kind").asText()).isEqualTo("image_reference");
            var expiredRead=new AgentContracts.ToolRequest("expired-image","read_image",0,mapper.valueToTree(Map.of("attachmentId",id)));
            assertThat(tools.invoke(taskId,expiredRead).data().path("error").path("code").asText()).isEqualTo("AI_ATTACHMENT_EXPIRED");
            assertThat(tasks.createTask("image-owner","image-project",request,conversation).created()).isFalse();
            assertThatThrownBy(()->service.open(new Scope("image-owner","image-project",conversation),id)).isInstanceOfSatisfying(com.manao.poc4.api.ApiException.class,ex->assertThat(ex.status()).isEqualTo(410));
            // READY and an incomplete unbound upload share exactly the same deadline/reaper.
            String pending=UUID.randomUUID().toString();
            jdbc.update("INSERT INTO agent_attachment(id,project_id,conversation_id,file_name,mime_type,size_bytes,sha256,uploaded_at,expires_at,state) VALUES (?,'image-project',?,'pending.png','image/png',1,?,?,?,'UPLOADING')",
                pending,conversation,"b".repeat(64),Timestamp.from(time.at.minusSeconds(86400)),Timestamp.from(time.at));
            org.mockito.Mockito.doThrow(new com.manao.poc4.workspace.WorkspaceAgentException(503,"IO_ERROR","storage unavailable")).doNothing().when(agent).deleteAttachment("image-project",id);
            var reaper=new AgentAttachmentReconciler(service);
            reaper.reconcile();
            assertThat(jdbc.queryForObject("SELECT state FROM agent_attachment WHERE id=?",String.class,id)).isEqualTo("DELETING");
            assertThat(jdbc.queryForObject("SELECT state FROM agent_attachment WHERE id=?",String.class,pending)).isEqualTo("DELETED");
            new AgentAttachmentReconciler(service).reconcile();
            assertThat(jdbc.queryForObject("SELECT state FROM agent_attachment WHERE id=?",String.class,id)).isEqualTo("DELETED");
            assertThat(jdbc.queryForObject("SELECT cleanup_failure_code FROM agent_attachment WHERE id=?",String.class,id)).isNull();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM agent_conversation_entry WHERE entry_id=?",Integer.class,taskId)).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT workspace_revision FROM project WHERE id='image-project'",Long.class)).isZero();
            tasks.applyTerminal(taskId,AgentContracts.TaskState.COMPLETED,"done",null);
            jdbc.update("UPDATE project SET state='DELETING' WHERE id='image-project'");
            assertThat(workspaceStore.deleteProject("image-owner","image-project")).isTrue();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM agent_attachment WHERE project_id='image-project'",Integer.class)).isZero();
        }
    }
    static final class MutableClock extends Clock {
        Instant at=Instant.parse("2026-11-02T00:00:00Z");
        public ZoneId getZone(){return ZoneOffset.UTC;} public Clock withZone(ZoneId zone){return this;}public Instant instant(){return at;}
    }
}
