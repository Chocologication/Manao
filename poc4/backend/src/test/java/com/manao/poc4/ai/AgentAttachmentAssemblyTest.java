package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.GlobalExceptionHandler;
import com.manao.poc4.auth.*;
import com.manao.poc4.config.*;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.workspace.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.autoconfigure.http.HttpMessageConvertersAutoConfiguration;
import org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration;
import org.springframework.boot.autoconfigure.security.servlet.*;
import org.springframework.boot.autoconfigure.web.servlet.*;
import org.springframework.boot.web.servlet.context.AnnotationConfigServletWebServerApplicationContext;
import org.springframework.context.annotation.*;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

/** Real AiConfig + security + multipart HTTP; only unrelated cluster/Run adapters are mocked. */
class AgentAttachmentAssemblyTest {
    @Configuration(proxyBeanMethods=false)
    @org.springframework.scheduling.annotation.EnableScheduling
    @ImportAutoConfiguration({ServletWebServerFactoryAutoConfiguration.class,DispatcherServletAutoConfiguration.class,
        WebMvcAutoConfiguration.class,JacksonAutoConfiguration.class,HttpMessageConvertersAutoConfiguration.class,
        SecurityAutoConfiguration.class,SecurityFilterAutoConfiguration.class,
        org.springframework.boot.autoconfigure.web.servlet.MultipartAutoConfiguration.class})
    @Import({AiConfig.class,SecurityConfig.class,GlobalExceptionHandler.class,AgentAttachmentController.class,
        AgentAttachmentInternalController.class,AgentImageCapabilitiesController.class,AgentConversationController.class})
    static class WebConfig { }

    @Test void actualWiringAcceptsTenMbAndRejectsForeignAndStaleWorkerAccess() throws Exception {
        var json=new ObjectMapper();
        var worker=com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        worker.createContext("/",exchange->{
            byte[] body="{\"bootId\":\"offline\",\"instanceId\":\"offline-worker\",\"activeTaskId\":null,\"activeExecutionState\":null,\"activeKind\":null,\"modelConfigured\":true,\"imageInput\":true}".getBytes(StandardCharsets.UTF_8);
            exchange.getRequestBody().readAllBytes();exchange.getResponseHeaders().add("Content-Type","application/json");exchange.sendResponseHeaders(200,body.length);exchange.getResponseBody().write(body);exchange.close();
        });worker.start();
        try(var db=JdbcStoreTestSupport.create()){
            var jdbc=db.jdbc();var tx=new DataSourceTransactionManager(jdbc.getDataSource());
            var now=java.sql.Timestamp.from(Instant.now());
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('image-owner','image-owner','unused',?),('other-owner','other-owner','unused',?)",now,now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('image-project','image-owner','images','READY',0,?,?)",now,now);
            WorkspaceAgent agent=mock(WorkspaceAgent.class);
            Map<String,WorkspaceAgent.AttachmentMeta> disk=new HashMap<>();Map<String,byte[]> files=new HashMap<>();
            when(agent.confirmAttachment(anyString(),anyString())).thenAnswer(inv->{var m=disk.get(inv.getArgument(1));if(m==null)throw new WorkspaceAgentException(404,"ENTRY_NOT_FOUND","absent");return m;});
            when(agent.putAttachment(anyString(),anyString(),anyString(),anyLong(),any())).thenAnswer(inv->{String id=inv.getArgument(1);byte[] bytes=inv.getArgument(4);var m=new WorkspaceAgent.AttachmentMeta(id,inv.getArgument(2),bytes.length,inv.getArgument(3));disk.put(id,m);files.put(id,bytes);return m;});
            when(agent.openAttachment(anyString(),anyString(),anyString(),anyLong())).thenAnswer(inv->files.get(inv.getArgument(1)));
            var application=new SpringApplication(WebConfig.class);application.setWebApplicationType(WebApplicationType.SERVLET);
            application.setDefaultProperties(Map.ofEntries(
                Map.entry("server.port","0"),Map.entry("server.address","127.0.0.1"),
                Map.entry("spring.config.location","optional:classpath:/attachment-isolated-test.yml"),
                Map.entry("manao.poc4.ai.enabled","true"),Map.entry("manao.poc4.ai.worker.base-url","http://127.0.0.1:"+worker.getAddress().getPort()),
                Map.entry("manao.poc4.ai.worker.token","offline-worker-token"),Map.entry("MANAO_AI_INTERNAL_TOKEN","offline-internal-token"),
                Map.entry("MANAO_JWT_SECRET","0123456789abcdef0123456789abcdef"),
                Map.entry("spring.servlet.multipart.max-file-size","10000000B"),Map.entry("spring.servlet.multipart.max-request-size","11000000B"),Map.entry("spring.servlet.multipart.file-size-threshold","0B")));
            application.addInitializers(context->{
                var web=(AnnotationConfigServletWebServerApplicationContext)context;
                web.registerBean(org.springframework.jdbc.core.JdbcTemplate.class,()->jdbc);
                web.registerBean(org.springframework.transaction.PlatformTransactionManager.class,()->tx);
                web.registerBean(ProjectLifecycleGate.class,ProjectLifecycleGate::new);
                web.registerBean(WorkspaceAgent.class,()->agent);
                web.registerBean(WorkspaceStore.class,()->new WorkspaceJdbcStore(jdbc,tx));
                web.registerBean(AgentTaskStore.class,()->org.springframework.test.util.ReflectionTestUtils.invokeMethod(
                    new WorkspaceConfig(),"agentTaskStore",jdbc,tx,web.getBeanProvider(AgentAttachmentService.class)));
                web.registerBean(WorkspaceOperationService.class,()->new WorkspaceOperationService(web.getBean(WorkspaceStore.class),agent,web.getBean(ProjectLifecycleGate.class)));
                web.registerBean(WorkspaceService.class,()->new WorkspaceService(web.getBean(WorkspaceStore.class),web.getBean(WorkspaceOperationService.class),agent,web.getBean(ProjectLifecycleGate.class),web.getBean(AgentTaskStore.class)));
                web.registerBean(io.fabric8.kubernetes.client.KubernetesClient.class,()->mock(io.fabric8.kubernetes.client.KubernetesClient.class));
                web.registerBean(com.manao.poc4.kubernetes.JobResourceFactory.class,()->mock(com.manao.poc4.kubernetes.JobResourceFactory.class));
                web.registerBean(BackendProperties.class,()->{var props=mock(BackendProperties.class,RETURNS_DEEP_STUBS);when(props.kubernetes().namespace()).thenReturn("isolated-test");return props;});
                web.registerBean(com.manao.poc4.project.ProjectRuntimeStore.class,()->mock(com.manao.poc4.project.ProjectRuntimeStore.class));
                web.registerBean(com.manao.poc4.run.RunService.class,()->mock(com.manao.poc4.run.RunService.class));
                web.registerBean(com.manao.poc4.run.RunStore.class,()->mock(com.manao.poc4.run.RunStore.class));
                web.registerBean(com.manao.poc4.log.RunLogService.class,()->mock(com.manao.poc4.log.RunLogService.class));
                web.registerBean(UserSessionRevoker.class,UserSessionRevoker::new);
            });
            try(var app=(AnnotationConfigServletWebServerApplicationContext)application.run()){
                var conversations=app.getBean(AgentConversationStore.class);String conversation=UUID.randomUUID().toString();
                conversations.create("image-owner","image-project",new AgentConversationContracts.CreateConversationRequest(conversation));
                var jwt=app.getBean(JwtService.class);String token=jwt.issue("image-owner",0).accessToken(),foreign=jwt.issue("other-owner",0).accessToken();
                String id=UUID.randomUUID().toString(),path="/api/v1/projects/image-project/conversations/"+conversation+"/attachments/"+id;
                String base="http://127.0.0.1:"+app.getWebServer().getPort();
                var client=HttpClient.newHttpClient();
                byte[] prefix=("--image-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"sample.png\"\r\nContent-Type: image/png\r\n\r\n").getBytes(StandardCharsets.UTF_8);
                byte[] suffix="\r\n--image-boundary--\r\n".getBytes(StandardCharsets.UTF_8);
                byte[] bytes=new byte[10_000_000];
                var publisher=HttpRequest.BodyPublishers.concat(HttpRequest.BodyPublishers.ofByteArray(prefix),HttpRequest.BodyPublishers.ofByteArray(bytes),HttpRequest.BodyPublishers.ofByteArray(suffix));
                var uploaded=client.send(HttpRequest.newBuilder(URI.create(base+path)).header("Authorization","Bearer "+token).header("Content-Type","multipart/form-data; boundary=image-boundary").PUT(publisher).build(),HttpResponse.BodyHandlers.ofString());
                assertThat(uploaded.statusCode()).as(uploaded.body()).isEqualTo(200);
                assertThat(client.send(HttpRequest.newBuilder(URI.create(base+path+"/content")).header("Authorization","Bearer "+foreign).GET().build(),HttpResponse.BodyHandlers.discarding()).statusCode()).isEqualTo(404);
                var content=client.send(HttpRequest.newBuilder(URI.create(base+path+"/content")).header("Authorization","Bearer "+token).GET().build(),HttpResponse.BodyHandlers.ofByteArray());
                assertThat(content.statusCode()).isEqualTo(200);assertThat(content.body()).hasSize(10_000_000);
                assertThat(content.headers().firstValue("Cache-Control")).contains("private, no-store");
                String task=UUID.randomUUID().toString();
                app.getBean(AgentTaskStore.class).createTask("image-owner","image-project",new AgentContracts.TaskRequest(task,"",0,null,List.of(id)),conversation);
                app.getBean(AgentTaskStore.class).bindWorkerInstance(task,1,"offline-worker");
                String internal=base+"/internal/ai/tasks/"+task+"/attachments/"+id+"/content";
                assertThat(client.send(HttpRequest.newBuilder(URI.create(internal)).header("Authorization","Bearer "+token).GET().build(),HttpResponse.BodyHandlers.discarding()).statusCode()).isEqualTo(401);
                assertThat(client.send(HttpRequest.newBuilder(URI.create(internal)).header("X-Manao-Worker-Token","offline-internal-token").header("X-Manao-Worker-Instance","stale").header("X-Manao-Worker-Epoch","1").GET().build(),HttpResponse.BodyHandlers.discarding()).statusCode()).isEqualTo(409);
                assertThat(app.getBean(AgentAttachmentReconciler.class)).isNotNull();
                assertThat(conversations.history("image-owner","image-project",conversation,null,null,50).items().get(0).attachments()).hasSize(1);
            }
        }finally{worker.stop(0);}
    }
}
