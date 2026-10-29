package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.project.ProjectLifecycleGate;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

class AgentTaskReconcilerTest {
    private static final Instant NOW = Instant.parse("2026-10-26T00:00:00Z");
    @Test void changedInstancePrefixWithTheSameBootIsNotReplacementEvidence() {
        try(var h=new Harness()) {
            Mockito.when(h.worker.processStatus()).thenReturn(new AgentContracts.WorkerProcessStatus("boot","different-boot",null,null,null,true));
            Mockito.when(h.worker.status(h.id)).thenThrow(new com.manao.poc4.api.ApiException("AI_WORKER_NOT_FOUND",404,"missing"));
            h.settlement.reconcile(h.id);
            assertThat(h.reason()).isNull();
            assertThat(h.tasks.currentForOwner("owner","project")).isPresent();
        }
    }

    @Test void unknownSlowWorkerDoesNotStarveResourceFinishing() {
        try (var h = new Harness()) {
            h.tasks.beginPause(h.id);
            var cleaned = new java.util.concurrent.atomic.AtomicBoolean();
            Mockito.when(h.tools.finishForClose(h.id)).thenAnswer(call -> { cleaned.set(true); return true; });
            Mockito.when(h.tools.finishApplication(h.id)).thenReturn(true);
            Mockito.when(h.worker.processStatus()).thenAnswer(call -> {
                var wait = new java.util.concurrent.CountDownLatch(1);
                wait.await(2, java.util.concurrent.TimeUnit.SECONDS);
                throw new com.manao.poc4.api.ApiException("AI_WORKER_UNREACHABLE", 502, "unknown");
            });
            h.settlement.reconcile(h.id, new ReconcileWorkBudget(h.id,
                java.time.Duration.ofMillis(150), java.time.Duration.ofMillis(100)));
            assertThat(cleaned.get()).isTrue();
            assertThat(h.tasks.currentForOwner("owner", "project")).isPresent();
        }
    }

    @Test void stableReplacementBootAndAuthenticatedMissingTaskCloseWithoutReplay() {
        try (var h = new Harness()) {
            var replacement = new AgentContracts.WorkerProcessStatus("new", "worker-new", null, null, null, true);
            Mockito.when(h.worker.processStatus()).thenReturn(replacement);
            Mockito.when(h.worker.status(h.id)).thenThrow(new com.manao.poc4.api.ApiException("AI_WORKER_NOT_FOUND", 404, "missing"));
            h.settlement.reconcile(h.id);
            assertThat(h.reason()).isEqualTo("AI_WORKER_RESTARTED");
            assertThat(h.tasks.currentForOwner("owner", "project")).isPresent();
            Mockito.when(h.tools.finishForClose(h.id)).thenReturn(true);
            Mockito.when(h.tools.finishApplication(h.id)).thenReturn(true);
            Mockito.when(h.tools.applicationCanRelease(h.id, false)).thenReturn(true);
            h.settlement.reconcile(h.id);
            assertThat(h.state()).isEqualTo("FAILED");
            assertThat(h.tasks.currentForOwner("owner", "project")).isEmpty();
            Mockito.verify(h.worker, Mockito.never()).start(Mockito.any());
        }
    }

    @Test void missingTaskWithoutStableReplacementNeverCloses() {
        for (String code : new String[] {"AI_WORKER_NOT_FOUND", "AI_WORKER_UNREACHABLE", "AI_WORKER_UNAUTHORIZED", "AI_WORKER_BAD_RESPONSE"}) {
            try (var h = new Harness()) {
                Mockito.when(h.worker.processStatus()).thenReturn(
                    new AgentContracts.WorkerProcessStatus("boot", "worker-boot", null, null, null, true));
                Mockito.when(h.worker.status(h.id)).thenThrow(new com.manao.poc4.api.ApiException(code, 502, "unknown"));
                h.settlement.reconcile(h.id);
                assertThat(h.reason()).as(code).isNull();
                assertThat(h.state()).isEqualTo("RUNNING");
            }
        }
        try (var h = new Harness()) {
            Mockito.when(h.worker.processStatus()).thenReturn(
                new AgentContracts.WorkerProcessStatus("new", "worker-new", null, null, null, true),
                new AgentContracts.WorkerProcessStatus("newer", "worker-newer", null, null, null, true));
            Mockito.when(h.worker.status(h.id)).thenThrow(new com.manao.poc4.api.ApiException("AI_WORKER_NOT_FOUND", 404, "missing"));
            h.settlement.reconcile(h.id);
            assertThat(h.reason()).isNull();
        }
    }

    @Test void legacyAndUnboundTasksNeverEnterReplacementRecovery() {
        for (String change : new String[] {"deadline_at=NULL", "worker_instance_id=NULL"}) {
            try (var h = new Harness()) {
                h.jdbc.update("UPDATE agent_task SET " + change + " WHERE id=?", h.id);
                Mockito.when(h.worker.processStatus()).thenReturn(
                    new AgentContracts.WorkerProcessStatus("new", "worker-new", null, null, null, true));
                Mockito.when(h.worker.status(h.id)).thenThrow(new com.manao.poc4.api.ApiException("AI_WORKER_NOT_FOUND", 404, "missing"));
                h.settlement.reconcile(h.id);
                assertThat(h.reason()).isNull();
                assertThat(h.tasks.currentForOwner("owner", "project")).isPresent();
            }
        }
    }

    @Test void receiptPersistedDuringReplacementObservationWinsTheCloseCas() {
        try (var h = new Harness()) {
            var replacement = new AgentContracts.WorkerProcessStatus("new", "worker-new", null, null, null, true);
            var reads = new java.util.concurrent.atomic.AtomicInteger();
            Mockito.when(h.worker.processStatus()).thenAnswer(call -> {
                if (reads.incrementAndGet() == 2) {
                    String reportId = AgentTaskStore.terminalReportId(h.id, 1, h.tasks.requestSha256Of(h.id));
                    h.tasks.recordTerminal(h.id, 1, "worker-boot", reportId,
                        "{\"state\":\"COMPLETED\",\"summary\":\"done\",\"failureCode\":null}",
                        AgentContracts.TaskState.COMPLETED, "done", null);
                }
                return replacement;
            });
            Mockito.when(h.worker.status(h.id)).thenThrow(new com.manao.poc4.api.ApiException("AI_WORKER_NOT_FOUND", 404, "missing"));
            Mockito.when(h.tools.applicationCanRelease(h.id, true)).thenReturn(true);
            h.settlement.reconcile(h.id);
            assertThat(h.reason()).isNull();
            assertThat(h.state()).isEqualTo("COMPLETED");
        }
    }

    @Test void armsTheBudgetAtTheExactDeadlineWithoutAReceipt() {
        try (Harness h = new Harness()) {
            h.jdbc.update("UPDATE agent_task SET deadline_at=? WHERE id=?", Timestamp.from(NOW), h.id);
            h.settlement.reconcile(h.id);
            assertThat(h.reason()).isEqualTo("AI_TASK_BUDGET_EXCEEDED");
            assertThat(h.state()).isEqualTo("NEEDS_ATTENTION");
            assertThat(h.tasks.currentForOwner("owner", "project")).isPresent();
        }
    }

    @Test void armsAnOverdueTaskWithoutWaitingForWorkerEvidence() {
        try (Harness h = new Harness()) {
            h.jdbc.update("UPDATE agent_task SET deadline_at=? WHERE id=?", Timestamp.from(NOW.minusSeconds(1)), h.id);
            h.settlement.reconcile(h.id);
            assertThat(h.reason()).isEqualTo("AI_TASK_BUDGET_EXCEEDED");
        }
    }

    @Test void neverBudgetClosesBeforeDeadlineOrWithLegacyNullDeadline() {
        try (Harness h = new Harness()) {
            h.jdbc.update("UPDATE agent_task SET deadline_at=? WHERE id=?", Timestamp.from(NOW.plusSeconds(1)), h.id);
            h.settlement.reconcile(h.id);
            assertThat(h.state()).isEqualTo("RUNNING");
            assertThat(h.reason()).isNull();
            h.jdbc.update("UPDATE agent_task SET deadline_at=NULL WHERE id=?", h.id);
            h.settlement.reconcile(h.id);
            assertThat(h.state()).isEqualTo("RUNNING");
            assertThat(h.reason()).isNull();
        }
    }

    @Test void importsTheAuthenticatedWorkersFrozenTerminalReportWithoutASecondModelStart() {
        try (Harness h = new Harness()) {
            String reportId=AgentTaskStore.terminalReportId(h.id,1,h.tasks.requestSha256Of(h.id));
            var report=new AgentContracts.TerminalReport(1,reportId,AgentContracts.TaskState.COMPLETED,"完成 ✅",null);
            Mockito.when(h.worker.processStatus()).thenReturn(new AgentContracts.WorkerProcessStatus("boot","worker-boot",null,null,null,true));
            Mockito.when(h.worker.status(h.id)).thenReturn(new AgentContracts.WorkerStatus(h.id,"worker-boot","COMPLETED",1,1L,
                h.tasks.requestSha256Of(h.id),"COMPLETED",new AgentContracts.WorkerTerminalDelivery("PENDING",reportId,
                AgentTaskStore.terminalContentSha256(reportId,report.state(),report.summary(),null),report)));
            Mockito.when(h.tools.applicationCanRelease(h.id,true)).thenReturn(true);
            h.settlement.reconcile(h.id);
            assertThat(h.state()).isEqualTo("COMPLETED");
            assertThat(h.tasks.storedTerminalReport(h.id).orElseThrow().summary()).isEqualTo("完成 ✅");
            Mockito.verify(h.worker,Mockito.never()).start(Mockito.any());
        }
    }

    @Test void importsStoredLegacyTerminalWithoutCallingTheWorker() {
        try (Harness h = new Harness()) {
            h.jdbc.update("UPDATE agent_task SET deadline_at=NULL, progress_json=? WHERE id=?",
                "{\"items\":[{\"seq\":4,\"kind\":\"terminal\",\"text\":\"{\\\"state\\\":\\\"COMPLETED\\\",\\\"summary\\\":\\\"legacy\\\",\\\"failureCode\\\":null}\",\"truncated\":false}],\"lastSeq\":4}",h.id);
            Mockito.when(h.tools.applicationCanRelease(h.id,true)).thenReturn(true);
            h.settlement.reconcile(h.id);
            assertThat(h.state()).isEqualTo("COMPLETED");
            Mockito.verifyNoInteractions(h.worker);
        }
    }

    @Test void backoffSurvivesProgressWritesAndARebuiltStore() {
        try(Harness h=new Harness()) {
            for(int seconds:new int[]{5,10,20,30,30}) {
                var rebuilt=new AgentTaskStore(h.jdbc,new DataSourceTransactionManager(h.jdbc.getDataSource()),h.clock);
                rebuilt.deferReconcile(h.id);
                assertThat(h.jdbc.queryForObject("SELECT next_reconcile_at FROM agent_task WHERE id=?",Timestamp.class,h.id).toInstant())
                    .isEqualTo(NOW.plusSeconds(seconds));
                h.jdbc.update("UPDATE agent_task SET updated_at=? WHERE id=?",Timestamp.from(NOW.plusSeconds(99)),h.id);
            }
        }
    }

    @Test void receiptPersistedBeforeDeadlineCompletesAfterAServiceRestartAndDeadline() {
        try(Harness h=new Harness()) {
            String reportId=AgentTaskStore.terminalReportId(h.id,1,h.tasks.requestSha256Of(h.id));
            h.tasks.recordTerminal(h.id,1,"worker-boot",reportId,"{\"state\":\"COMPLETED\",\"summary\":\"durable\",\"failureCode\":null}",
                AgentContracts.TaskState.COMPLETED,"durable",null);
            h.jdbc.update("UPDATE agent_task SET deadline_at=? WHERE id=?",Timestamp.from(NOW.minusSeconds(1)),h.id);
            var rebuiltTasks=new AgentTaskStore(h.jdbc,new DataSourceTransactionManager(h.jdbc.getDataSource()),h.clock);
            Mockito.when(h.tools.applicationCanRelease(h.id,true)).thenReturn(true);
            new AgentTaskSettlementService(rebuiltTasks,h.gate,h.worker,h.tools).reconcile(h.id);
            assertThat(h.state()).isEqualTo("COMPLETED"); assertThat(h.reason()).isNull();
            Mockito.verifyNoInteractions(h.worker);
        }
    }

    @Test void aCloseCommittedWhileWorkerIoIsOutsideLocksCannotBeOverwritten() {
        try(Harness h=new Harness()) {
            Mockito.when(h.worker.processStatus()).thenAnswer(call -> {
                assertThat(Thread.holdsLock(h.tasks)).isFalse();
                try(var lease=h.gate.tryAcquire("project").orElseThrow()) { h.tasks.beginClose(h.id,"AI_OWNER_CLOSED"); }
                return new AgentContracts.WorkerProcessStatus("boot","worker-boot",null,null,null,true);
            });
            String reportId=AgentTaskStore.terminalReportId(h.id,1,h.tasks.requestSha256Of(h.id));
            var report=new AgentContracts.TerminalReport(1,reportId,AgentContracts.TaskState.COMPLETED,"late",null);
            Mockito.when(h.worker.status(h.id)).thenReturn(new AgentContracts.WorkerStatus(h.id,"worker-boot","COMPLETED",1,1L,
                h.tasks.requestSha256Of(h.id),"COMPLETED",new AgentContracts.WorkerTerminalDelivery("PENDING",reportId,
                AgentTaskStore.terminalContentSha256(reportId,report.state(),report.summary(),null),report)));
            h.settlement.reconcile(h.id);
            assertThat(h.state()).isEqualTo("NEEDS_ATTENTION"); assertThat(h.reason()).isEqualTo("AI_OWNER_CLOSED");
        }
    }

    @Test void dueScanCapsTenAndKeepsStableOrderAndFreshTaskSchedule() {
        try(Harness h=new Harness()) {
            assertThat(h.tasks.reconcileCandidate(h.id).nextReconcileAt()).isEqualTo(NOW);
            for(int i=0;i<11;i++) {
                String project="project-"+i;
                h.jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES (?,'owner',?,'READY',7,?,?)",project,project,Timestamp.from(NOW),Timestamp.from(NOW));
                h.tasks.create("owner",project,new AgentContracts.TaskRequest(UUID.randomUUID().toString(),"original task for fairness",7));
            }
            var first=h.tasks.dueReconciliations(100);
            assertThat(first).hasSize(10);
            assertThat(first.stream().map(AgentTaskStore.ReconcileCandidate::taskId).toList()).isSorted();
            first.forEach(candidate -> h.tasks.deferReconcile(candidate.taskId()));
            var next=h.tasks.dueReconciliations(10);
            assertThat(next).hasSize(2);
            assertThat(next.stream().map(AgentTaskStore.ReconcileCandidate::taskId).toList())
                .doesNotContainAnyElementsOf(first.stream().map(AgentTaskStore.ReconcileCandidate::taskId).toList());
        }
    }

    @Test void rejectsEachForeignWorkerIdentityAndPreservesOccupancyOn404AndTransport() {
        try(Harness h=new Harness()) {
            Mockito.when(h.worker.processStatus()).thenReturn(new AgentContracts.WorkerProcessStatus("boot","worker-boot",null,null,null,true));
            for(int field=0;field<6;field++) {
                Mockito.when(h.worker.status(h.id)).thenReturn(new AgentContracts.WorkerStatus(field==0?"other":h.id,
                    field==1?"foreign":"worker-boot","COMPLETED",field==2?null:1,field==3?2L:1L,
                    field==4?"f".repeat(64):h.tasks.requestSha256Of(h.id),field==5?"RUNNING":"COMPLETED",null));
                h.settlement.reconcile(h.id); assertThat(h.state()).isEqualTo("RUNNING");
                assertThat(h.tasks.storedTerminalReport(h.id)).isEmpty();
            }
            for(String code:new String[]{"AI_WORKER_NOT_FOUND","AI_WORKER_UNREACHABLE","AI_WORKER_UNAUTHORIZED","AI_WORKER_BAD_RESPONSE"}) {
                Mockito.doThrow(new com.manao.poc4.api.ApiException(code,502,"safe")).when(h.worker).status(h.id);
                h.settlement.reconcile(h.id); assertThat(h.state()).isEqualTo("RUNNING");
                assertThat(h.tasks.currentForOwner("owner","project")).isPresent();
            }
        }
    }

    @Test void recordsOnlySafeClassifiedDiagnosticsForEveryUnresolvedWorkerPull() {
        var logger=(ch.qos.logback.classic.Logger)org.slf4j.LoggerFactory.getLogger(AgentTaskSettlementService.class);
        var capture=new ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent>();
        capture.start(); logger.addAppender(capture);
        try(Harness h=new Harness()) {
            Mockito.when(h.worker.processStatus()).thenReturn(new AgentContracts.WorkerProcessStatus("boot","worker-boot",null,null,null,true));
            for(String code:new String[]{"AI_WORKER_NOT_FOUND","AI_WORKER_UNAUTHORIZED","AI_WORKER_BAD_RESPONSE","AI_WORKER_UNREACHABLE","raw-token-model-response"}) {
                capture.list.clear();
                Mockito.doThrow(new com.manao.poc4.api.ApiException(code,502,"private-token raw-response model-content")).when(h.worker).status(h.id);
                h.settlement.reconcile(h.id);
                String expected=code.equals("raw-token-model-response") ? "AI_RECONCILE_UNRESOLVED" : code;
                assertThat(capture.list).singleElement().satisfies(event -> {
                    assertThat(event.getFormattedMessage()).isEqualTo("taskId="+h.id+" kind=worker-reconcile code="+expected);
                    assertThat(event.getThrowableProxy()).isNull();
                });
                assertThat(h.state()).isEqualTo("RUNNING");
                assertThat(h.tasks.currentForOwner("owner","project")).isPresent();
                assertThat(h.tasks.reconcileCandidate(h.id).nextReconcileAt()).isEqualTo(NOW.plusSeconds(5));
            }
            capture.list.clear();
            Mockito.doReturn(new AgentContracts.WorkerStatus("foreign-task","worker-boot","RUNNING",1,1L,
                h.tasks.requestSha256Of(h.id),"RUNNING",null)).when(h.worker).status(h.id);
            h.settlement.reconcile(h.id);
            assertThat(capture.list).singleElement().satisfies(event -> {
                assertThat(event.getFormattedMessage()).isEqualTo("taskId="+h.id+" kind=worker-reconcile code=AI_WORKER_IDENTITY_MISMATCH");
                assertThat(event.getThrowableProxy()).isNull();
            });
            assertThat(h.state()).isEqualTo("RUNNING");
            assertThat(h.tasks.storedTerminalReport(h.id)).isEmpty();
        } finally { logger.detachAppender(capture); capture.stop(); }
    }

    @Test void stalledIoKeepsItsSeatButDoesNotStarveTheNextTasksDeadline() throws Exception {
        try(Harness h=new Harness()) {
            String other=UUID.randomUUID().toString();
            h.jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('project2','owner','project2','READY',7,?,?)",Timestamp.from(NOW),Timestamp.from(NOW));
            h.tasks.create("owner","project2",new AgentContracts.TaskRequest(other,"close this original task",7));
            h.jdbc.update("UPDATE agent_task SET next_reconcile_at=?,deadline_at=? WHERE id=?",Timestamp.from(NOW.minusSeconds(1)),Timestamp.from(NOW),other);
            var entered=new java.util.concurrent.CountDownLatch(1); var release=new java.util.concurrent.CountDownLatch(1);
            Mockito.when(h.worker.processStatus()).thenAnswer(call -> {
                entered.countDown();
                while(release.getCount()>0) { try {release.await();} catch(InterruptedException ignored) { } }
                return new AgentContracts.WorkerProcessStatus("boot","worker-boot",null,null,null,true);
            });
            try(var scanner=new AgentTaskReconciler(h.tasks,h.settlement)) {
                // First row stalls. It keeps the only external seat even after timeout.
                h.jdbc.update("UPDATE agent_task SET next_reconcile_at=? WHERE id=?",Timestamp.from(NOW.minusSeconds(2)),h.id);
                long began=System.nanoTime(); scanner.tick();
                assertThat(java.time.Duration.ofNanos(System.nanoTime()-began)).isLessThan(java.time.Duration.ofSeconds(5));
                assertThat(entered.getCount()).isZero();
                assertThat(ReconcileWorkBudget.inFlight(h.id)).isTrue();
                assertThat(h.jdbc.queryForObject("SELECT close_reason_code FROM agent_task WHERE id=?",String.class,other)).isEqualTo("AI_TASK_BUDGET_EXCEEDED");
                assertThat(h.state()).isEqualTo("RUNNING");
                h.settlement.reconcile(h.id);
                Mockito.verify(h.worker,Mockito.times(1)).processStatus();
            } finally { release.countDown(); }
            long until=System.nanoTime()+java.time.Duration.ofSeconds(2).toNanos();
            while(ReconcileWorkBudget.inFlight(h.id) && System.nanoTime()<until) Thread.onSpinWait();
            assertThat(ReconcileWorkBudget.inFlight(h.id)).isFalse();
        }
    }

    static final class Harness implements AutoCloseable {
        final JdbcStoreTestSupport db = JdbcStoreTestSupport.create();
        final JdbcTemplate jdbc = db.jdbc();
        final Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);
        final String id = UUID.randomUUID().toString();
        final AgentTaskStore tasks = new AgentTaskStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()), clock);
        final ProjectLifecycleGate gate = new ProjectLifecycleGate();
        final PiWorkerClient worker = Mockito.mock(PiWorkerClient.class);
        final AgentProjectTools tools = Mockito.mock(AgentProjectTools.class);
        final AgentTaskSettlementService settlement = new AgentTaskSettlementService(tasks, gate, worker, tools);
        Harness() {
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES ('owner','owner','unused',?)", Timestamp.from(NOW));
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,created_at,updated_at) VALUES ('project','owner','project','READY',7,?,?)", Timestamp.from(NOW),Timestamp.from(NOW));
            tasks.create("owner", "project", new AgentContracts.TaskRequest(id, "reconcile the original execution",7));
            tasks.bindWorkerInstance(id,1,"worker-boot");
        }
        String state() { return jdbc.queryForObject("SELECT state FROM agent_task WHERE id=?",String.class,id); }
        String reason() { return jdbc.queryForObject("SELECT close_reason_code FROM agent_task WHERE id=?",String.class,id); }
        @Override public void close() { db.close(); }
    }
}
