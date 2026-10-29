package com.manao.poc4.ai;

import com.manao.poc4.api.ApiException;
import java.time.Duration;
import java.util.concurrent.Executors;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/** One shared external-work seat. A timed-out adapter keeps its seat/claims until it really exits. */
public final class ReconcileWorkBudget {
    private static final AtomicReference<String> IN_FLIGHT = new AtomicReference<>();
    private static final java.util.concurrent.ExecutorService IO = Executors.newSingleThreadExecutor(r -> {
        Thread thread=new Thread(r,"ai-reconcile-io"); thread.setDaemon(true); return thread;
    });
    private static final ThreadLocal<ReconcileWorkBudget> CURRENT = new ThreadLocal<>();
    private final String taskId;
    private final long deadlineNanos;
    private final long ioNanos;

    ReconcileWorkBudget(String taskId) { this(taskId,Duration.ofSeconds(5),Duration.ofSeconds(2)); }
    ReconcileWorkBudget(String taskId,Duration total,Duration io) {
        this.taskId=taskId; this.deadlineNanos=System.nanoTime()+total.toNanos(); this.ioNanos=io.toNanos();
    }
    static boolean inFlight(String taskId) { return taskId.equals(IN_FLIGHT.get()); }
    public static void check() {
        ReconcileWorkBudget budget=CURRENT.get();
        if (Thread.currentThread().isInterrupted() || budget!=null && budget.remaining()<=0) throw unavailable();
    }
    public static boolean active() { return CURRENT.get()!=null; }
    public static Duration requestTimeout(Duration original) {
        ReconcileWorkBudget budget=CURRENT.get();
        if(budget==null) return original;
        check(); return Duration.ofNanos(Math.max(1,Math.min(original.toNanos(),Math.min(budget.ioNanos,budget.remaining()))));
    }
    public static <T> T boundary(Supplier<T> work) { check(); T value=work.get(); check(); return value; }
    private long remaining() { return deadlineNanos-System.nanoTime(); }
    <T> T io(Supplier<T> work) {
        if(remaining()<=0 || !IN_FLIGHT.compareAndSet(null,taskId)) throw unavailable();
        java.util.concurrent.atomic.AtomicBoolean entered=new java.util.concurrent.atomic.AtomicBoolean();
        FutureTask<T> future=new FutureTask<T>(() -> {
            entered.set(true);
            CURRENT.set(this);
            try { check(); return work.get(); } finally { CURRENT.remove(); IN_FLIGHT.compareAndSet(taskId,null); }
        }) { @Override public void run() { try { super.run(); } finally { if(!entered.get()) IN_FLIGHT.compareAndSet(taskId,null); } } };
        try { IO.execute(future); }
        catch(java.util.concurrent.RejectedExecutionException ex) { IN_FLIGHT.compareAndSet(taskId,null); throw unavailable(); }
        try { return future.get(Math.max(1,Math.min(ioNanos,remaining())),TimeUnit.NANOSECONDS); }
        catch(java.util.concurrent.TimeoutException ex) { future.cancel(true); throw unavailable(); }
        catch(InterruptedException ex) { Thread.currentThread().interrupt(); future.cancel(true); throw unavailable(); }
        catch(java.util.concurrent.ExecutionException ex) {
            if(ex.getCause() instanceof RuntimeException cause) throw cause;
            throw unavailable();
        }
    }
    private static ApiException unavailable() { return new ApiException("AI_RECONCILE_DEFERRED",503,"Task evidence remains unresolved"); }
}
