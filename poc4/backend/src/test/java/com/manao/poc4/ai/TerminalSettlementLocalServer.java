package com.manao.poc4.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.GlobalExceptionHandler;
import com.manao.poc4.auth.JwtService;
import com.manao.poc4.config.SecurityConfig;
import com.manao.poc4.kubernetes.JobCoordinator;
import com.manao.poc4.persistence.DatabaseClock;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.run.*;
import com.manao.poc4.workspace.*;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import javax.sql.DataSource;
import org.mockito.Mockito;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.web.bind.annotation.*;

/** Test-source HTTP boot: actual controllers/stores/services; only workspace/Job facts are controlled. */
@Configuration(proxyBeanMethods=false)
@Profile("terminal-settlement-local")
@EnableAutoConfiguration
@Import({SecurityConfig.class, GlobalExceptionHandler.class, AgentTaskController.class,
    AgentInternalController.class, AgentConversationController.class, AgentConversationInternalController.class,
    WorkspaceController.class, RunController.class,AgentLiveOutputController.class})
public class TerminalSettlementLocalServer {
    static final String PROJECT="terminal-project", OWNER="terminal-owner";
    final ProjectLifecycleGate gate=new ProjectLifecycleGate();
    final AtomicLong seconds=new AtomicLong();
    final Clock clock=new Clock() {
        public ZoneId getZone(){return ZoneOffset.UTC;}
        public Clock withZone(ZoneId zone){return this;}
        public Instant instant(){return Instant.now().plusSeconds(seconds.get());}
    };
    final CountDownLatch gateRelease=new CountDownLatch(1);
    volatile CountDownLatch heldRelease;
    final ScheduledExecutorService executor=Executors.newSingleThreadScheduledExecutor();
    volatile boolean reconcile=true;

    public static void main(String[] args) {
        String url=System.getenv("MANAO_DB_URL");
        if(url==null || !url.matches("jdbc:mysql://127[.]0[.]0[.]1:[0-9]+/manao_(stage6_)?terminal_[0-9a-f]{32}.*"))
            throw new IllegalStateException("Owned loopback disposable MySQL required");
        var app=new SpringApplication(TerminalSettlementLocalServer.class);
        app.setDefaultProperties(Map.of("server.address","127.0.0.1","server.port","18991",
            "spring.datasource.url",url,"spring.datasource.username",System.getenv("MANAO_DB_USERNAME"),
            "spring.datasource.password",System.getenv("MANAO_DB_PASSWORD"),"manao.poc4.ai.enabled","true",
            "logging.level.root","WARN","spring.main.banner-mode","off"));
        app.run("--spring.profiles.active=terminal-settlement-local","--server.address=127.0.0.1","--server.port=18991","--manao.poc4.ai.enabled=true","--management.endpoint.health.validate-group-membership=false","--logging.level.org.springframework.boot.autoconfigure.security.servlet.UserDetailsServiceAutoConfiguration=ERROR");
    }
    @Bean ProjectLifecycleGate lifecycle(){return gate;}
    @Bean AgentTaskStore tasks(JdbcTemplate jdbc,DataSource source){
        var now=Timestamp.from(clock.instant());
        if(jdbc.queryForObject("SELECT COUNT(*) FROM app_user WHERE id=?",Integer.class,OWNER)==0) {
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES (?,?,'unused',?)",OWNER,OWNER,now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES (?,?,'terminal-local','READY',7,?,?)",PROJECT,OWNER,now,now);
        }
        return new AgentTaskStore(jdbc,new DataSourceTransactionManager(source),clock);
    }
    @Bean PiWorkerClient worker(){return new HttpPiWorkerClient("http://127.0.0.1:18990",System.getenv("MANAO_AI_WORKER_TOKEN"),Duration.ofSeconds(2));}
    @Bean AgentConversationStore conversations(JdbcTemplate jdbc,DataSource source,AgentTaskStore tasks){return new AgentConversationStore(jdbc,new DataSourceTransactionManager(source),clock,tasks);}
    @Bean AgentConversationService conversationService(AgentConversationStore store,PiWorkerClient worker){return new AgentConversationService(store,gate,worker);}
    @Bean WorkspaceJdbcStore workspaceStore(JdbcTemplate jdbc,DataSource source){return new WorkspaceJdbcStore(jdbc,new DataSourceTransactionManager(source));}
    @Bean WorkspaceAgent externalWorkspace(){
        WorkspaceAgent agent=Mockito.mock(WorkspaceAgent.class);
        Mockito.when(agent.tree(Mockito.anyString(),Mockito.anyString())).thenReturn(new WorkspaceAgent.Tree("",List.of()));
        var file = java.nio.file.Path.of(System.getenv("MANAO_TERMINAL_SCRATCH_ROOT"), "pom.xml");
        Mockito.when(agent.meta(Mockito.anyString(),Mockito.anyString())).thenAnswer(inv -> {
            String body = java.nio.file.Files.exists(file) ? java.nio.file.Files.readString(file) : "initial saved file";
            String sha = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(body.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            return new WorkspaceAgent.FileMeta(inv.getArgument(1),inv.getArgument(1),(long)body.getBytes(java.nio.charset.StandardCharsets.UTF_8).length,"text/plain","UTF-8","java","MONACO_TEXT",null,sha);
        });
        Mockito.when(agent.content(Mockito.anyString(),Mockito.eq("pom.xml"))).thenAnswer(inv -> {
            String body = java.nio.file.Files.exists(file) ? java.nio.file.Files.readString(file) : "initial saved file";
            return new WorkspaceAgent.Content("pom.xml",body,agent.meta(PROJECT,"pom.xml").sha256());
        });
        Mockito.when(agent.mutate(Mockito.anyString(),Mockito.any())).thenAnswer(inv -> {
            WorkspaceAgent.Command c=inv.getArgument(1);
            if ("SAVE".equals(c.type()) && "pom.xml".equals(c.path())) java.nio.file.Files.write(file,c.content());
            return new WorkspaceAgent.MutationResult(c.operationId(),c.path(),c.expectedBeforeSha256(),c.expectedAfterSha256(),".manao/receipts/"+c.operationId()+".json",c.expectedReceiptSha256());
        });
        return agent;
    }
    @Bean WorkspaceOperationService operations(WorkspaceJdbcStore store,WorkspaceAgent agent){return new WorkspaceOperationService(store,agent,gate);}
    @Bean WorkspaceService workspace(WorkspaceJdbcStore store,WorkspaceOperationService operations,WorkspaceAgent agent,AgentTaskStore tasks){return new WorkspaceService(store,operations,agent,gate,tasks);}
    @Bean JdbcRunStore runs(JdbcTemplate jdbc){return new JdbcRunStore(jdbc,new DatabaseClock(clock));}
    @Bean JobCoordinator jobs(){
        var jobs=Mockito.mock(JobCoordinator.class);
        Mockito.when(jobs.observe(Mockito.any())).thenReturn(new JobCoordinator.JobObservation(JobCoordinator.ObservationKind.UNKNOWN,null,null));
        return jobs;
    }
    @Bean RunService runService(JdbcRunStore store,AgentTaskStore tasks,JobCoordinator jobs){
        return new RunService(store,jobs,policy(),gate,tasks,null,null,null);
    }
    @Bean RunObservationService observation(JdbcRunStore store,JobCoordinator jobs){return new RunObservationService(store,jobs,Mockito.mock(com.manao.poc4.log.RunLogIngestor.class),null,gate,null);}
    @Bean org.springframework.security.web.SecurityFilterChain fixtureSecurity(org.springframework.security.config.annotation.web.builders.HttpSecurity http) throws Exception {
        return http.securityMatcher("/__fixture/**").csrf(c -> c.disable()).authorizeHttpRequests(a -> a.anyRequest().permitAll()).build();
    }
    @jakarta.annotation.PreDestroy void stop(){if(heldRelease!=null)heldRelease.countDown();executor.shutdownNow();}
    static RunPolicy policy(){var resource=new RunPolicy.Resources(1000,1073741824L,1073741824L);return new RunPolicy("java-spring-boot-web",new RunPolicy.RuntimeInfo.Java(17,3),"mvn -q -DskipTests spring-boot:run",1800,"SERVICE",1800,7200,resource,resource);}
    @Bean AgentProjectTools tools(AgentTaskStore tasks,WorkspaceJdbcStore store,WorkspaceService workspace,WorkspaceOperationService ops,RunService runs,JdbcRunStore runStore){
        return new AgentProjectTools(tasks,store,workspace,ops,gate,Mockito.mock(DevelopmentBuildExecutor.class),new AgentApplicationTools(tasks,runs,runStore,null,null,gate));
    }
    @Bean AgentTaskService service(AgentTaskStore tasks,PiWorkerClient worker,AgentProjectTools tools,AgentConversationService conversations){return new AgentTaskService(tasks,gate,worker,tools,conversations);}
    @Bean(destroyMethod="close") AgentLiveOutput live(AgentTaskStore tasks){return new AgentLiveOutput(tasks);}
    @Bean AgentTaskSettlementService settlement(AgentTaskStore tasks,PiWorkerClient worker,AgentProjectTools tools){return new AgentTaskSettlementService(tasks,gate,worker,tools);}
    @Bean(destroyMethod="close") AgentTaskReconciler reconciler(AgentTaskStore tasks,AgentTaskSettlementService settlement){
        var scanner=new AgentTaskReconciler(tasks,settlement);
        executor.scheduleWithFixedDelay(() -> {if(reconcile) scanner.tick();},200,200,TimeUnit.MILLISECONDS);
        return scanner;
    }
    @RestController @Profile("terminal-settlement-local") @RequestMapping("/__fixture")
    class Controls {
        final JdbcTemplate jdbc;final JwtService jwt;final AgentTaskStore tasks;final AgentTaskSettlementService settlement;final JobCoordinator jobs;final RunObservationService observation;
        Controls(JdbcTemplate jdbc,JwtService jwt,AgentTaskStore tasks,AgentTaskSettlementService settlement,JobCoordinator jobs,RunObservationService observation){this.jdbc=jdbc;this.jwt=jwt;this.tasks=tasks;this.settlement=settlement;this.jobs=jobs;this.observation=observation;}
        @GetMapping("/ready") Map<String,Object> ready(){return Map.of("ready",true,"projectId",PROJECT,"userId",OWNER,"pid",ProcessHandle.current().pid());}
        @PostMapping("/login") Object login(@RequestParam(defaultValue=OWNER) String owner){return jwt.issue(owner);}
        @PostMapping("/gate/hold") void hold() throws Exception {
            heldRelease=new CountDownLatch(1);var acquired=new CountDownLatch(1);
            new Thread(() -> {try(var lease=gate.tryAcquire(PROJECT).orElseThrow()){acquired.countDown();heldRelease.await(60,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}},"terminal-test-gate").start();
            if(!acquired.await(3,TimeUnit.SECONDS))throw new IllegalStateException("Gate not acquired");
        }
        @PostMapping("/gate/release") void release(){if(heldRelease!=null)heldRelease.countDown();}
        @PostMapping("/clock") void clock(@RequestParam long advance){seconds.addAndGet(advance);}
        @PostMapping("/reconcile") void reconcile(@RequestParam boolean enabled){reconcile=enabled;}
        @PostMapping("/tick/{id}") void tick(@PathVariable String id){settlement.reconcile(id);}
        @PostMapping("/legacy-task/{id}") void legacy(@PathVariable String id){jdbc.update("UPDATE agent_task SET deadline_at=NULL WHERE id=?",id);}
        @GetMapping("/rows/{id}") Object row(@PathVariable String id){
            var row=new LinkedHashMap<>(jdbc.queryForMap("SELECT id,state,failure_code,close_reason_code,terminal_report_id,terminal_report_sha256,terminal_received_at,progress_json,conversation_id,workspace_revision,created_at,deadline_at FROM agent_task WHERE id=?",id));
            row.put("receipts",jdbc.queryForObject("SELECT COUNT(*) FROM agent_task WHERE id=? AND terminal_report_id IS NOT NULL",Integer.class,id));
            row.put("calls",jdbc.queryForObject("SELECT COUNT(*) FROM agent_tool_call WHERE task_id=?",Integer.class,id));
            row.put("results",jdbc.queryForList("SELECT tool_name,result_json FROM agent_tool_call WHERE task_id=? ORDER BY created_at",id));return row;
        }
        @PostMapping("/ready-run/{id}") Object readyRun(@PathVariable String id,@RequestParam(defaultValue="true") boolean linked){
            String run=UUID.randomUUID().toString();var now=Timestamp.from(clock.instant());
            jdbc.update("INSERT INTO run(id,project_id,requested_revision,state,policy_json,version,created_at,updated_at,started_at,fencing_token,first_ready_at,expires_at,execution_pod_uid) VALUES (?, ?,7,'RUNNING',?,0,?,?,?,0,?,?,'fixture-pod-uid')",run,PROJECT,policy().toJson(),now,now,now,now,Timestamp.from(now.toInstant().plusSeconds(7200)));
            if(linked) jdbc.update("INSERT INTO agent_tool_call(task_id,tool_call_id,request_sha256,tool_name,args_json,state,workspace_operation_id,expected_revision,created_at,updated_at) VALUES (?,'fixture-ready-application',?,'application','{\"action\":\"start\"}','COMPLETED',?,7,?,?)",id,"a".repeat(64),run,now,now);
            return Map.of("runId",run);
        }
        @PostMapping("/job-stopped/{run}") void jobStopped(@PathVariable String run){
            Mockito.doReturn(new JobCoordinator.JobObservation(JobCoordinator.ObservationKind.MISSING,null,null))
                .when(jobs).observe(Mockito.argThat(r -> r != null && r.id().equals(run)));
            observation.observe();
        }
    }
}
