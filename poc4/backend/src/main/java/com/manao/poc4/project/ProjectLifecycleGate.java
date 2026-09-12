package com.manao.poc4.project;

import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Single-instance exclusive lease per projectId. Reentrant for the owning thread; non-blocking
 * for every other thread. Does not replace durable project state or provide a distributed lock.
 */
public final class ProjectLifecycleGate {
    private final ConcurrentHashMap<String, Cell> cells = new ConcurrentHashMap<>();

    public interface Lease extends AutoCloseable {
        @Override void close();
    }

    public Optional<Lease> tryAcquire(String projectId) {
        Objects.requireNonNull(projectId, "projectId");
        Thread current = Thread.currentThread();
        while (true) {
            Cell cell = cells.computeIfAbsent(projectId, ignored -> new Cell());
            synchronized (cell) {
                if (cell.retired) {
                    cells.remove(projectId, cell);
                    continue;
                }
                if (cell.owner == null || cell.owner == current) {
                    cell.owner = current;
                    cell.holdCount++;
                    cell.pins++;
                    return Optional.of(new HeldLease(projectId, cell));
                }
                return Optional.empty();
            }
        }
    }

    private void retireIfUnused(String projectId, Cell cell) {
        if (cell.holdCount == 0 && cell.pins == 0 && !cell.retired) {
            cell.retired = true;
            cells.remove(projectId, cell);
        }
    }

    private static final class Cell {
        private Thread owner;
        private int holdCount;
        private int pins;
        private boolean retired;
    }

    private final class HeldLease implements Lease {
        private final String projectId;
        private final Cell cell;
        private boolean closed;

        private HeldLease(String projectId, Cell cell) {
            this.projectId = projectId;
            this.cell = cell;
        }

        @Override public void close() {
            synchronized (cell) {
                if (closed) {
                    return;
                }
                closed = true;
                if (cell.owner != Thread.currentThread() || cell.holdCount <= 0 || cell.pins <= 0) {
                    throw new IllegalStateException("project lifecycle lease closed by a non-owner");
                }
                cell.holdCount--;
                cell.pins--;
                if (cell.holdCount == 0) {
                    cell.owner = null;
                }
                retireIfUnused(projectId, cell);
            }
        }
    }
}
