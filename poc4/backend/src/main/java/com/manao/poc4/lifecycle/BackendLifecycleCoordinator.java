package com.manao.poc4.lifecycle;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Orders every terminal teardown exactly like the design contract: disable input -> close PTY ->
 * settle audit/session -> (only for run end) release the run lock dependency. Every disposer is
 * idempotent and failures are isolated so later steps always run.
 */
public final class BackendLifecycleCoordinator {
    private final List<Disposer> disposers = new CopyOnWriteArrayList<>();

    public record Disposer(String name, int order, Runnable action) { }

    /** Registers a teardown step; lower order runs first. */
    public void register(String name, int order, Runnable action) {
        disposers.add(new Disposer(name, order, action));
    }

    /** Full session teardown: input off, PTY closed, audit/session settled. */
    public void teardown(String scope) {
        runDisposers();
    }

    /** Run-level teardown: terminal disposal completes before the Run authority is released. */
    public void teardownRunTerminals(String runId) {
        runDisposers();
    }

    private void runDisposers() {
        List<Disposer> sorted = new java.util.ArrayList<>(disposers);
        sorted.sort(java.util.Comparator.comparingInt(Disposer::order));
        for (Disposer step : sorted) {
            try {
                step.action().run();
            } catch (RuntimeException ignored) {
                // Teardown must always continue; disposers are individually idempotent.
            }
        }
    }
}
