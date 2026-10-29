package com.manao.poc4.ai;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Independent single-thread scan; durable fairness/backoff and no browser/model replay. */
public final class AgentTaskReconciler implements AutoCloseable {
    private static final org.slf4j.Logger LOG=org.slf4j.LoggerFactory.getLogger(AgentTaskReconciler.class);
    private final AgentTaskStore tasks;
    private final AgentTaskSettlementService settlement;
    private final ScheduledExecutorService scheduler;
    private final AtomicBoolean running=new AtomicBoolean();
    public AgentTaskReconciler(AgentTaskStore tasks,AgentTaskSettlementService settlement) {
        this(tasks,settlement,Executors.newSingleThreadScheduledExecutor(r -> {
            Thread thread=new Thread(r,"ai-task-reconciler"); thread.setDaemon(true); return thread;
        }));
    }
    AgentTaskReconciler(AgentTaskStore tasks,AgentTaskSettlementService settlement,ScheduledExecutorService scheduler) {
        this.tasks=tasks; this.settlement=settlement; this.scheduler=scheduler;
    }
    public void start() { scheduler.scheduleWithFixedDelay(this::tick,5,5,TimeUnit.SECONDS); }
    public void tick() {
        if(!running.compareAndSet(false,true)) return;
        try {
            for(var candidate:tasks.dueReconciliations(10)) {
                long began=System.nanoTime();
                try { settlement.reconcile(candidate.taskId()); }
                catch(RuntimeException ex) {
                    String code=ex instanceof com.manao.poc4.api.ApiException api ? api.code() : "AI_RECONCILE_UNRESOLVED";
                    LOG.warn("taskId={} epoch={} kind=reconcile code={} elapsed={}",candidate.taskId(),candidate.epoch(),code,
                        TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-began));
                } finally { tasks.deferReconcile(candidate.taskId()); }
            }
        } catch(RuntimeException ex) { LOG.warn("kind=reconcile-scan code=AI_RECONCILE_UNRESOLVED"); }
        finally { running.set(false); }
    }
    @Override public void close() { scheduler.shutdownNow(); }
}
