package com.manao.poc4.run;

/**
 * Notifies live observers after a Run has settled and the last persisted log window is complete.
 */
@FunctionalInterface
public interface RunCompletionListener {
    void onRunCompleted(String runId);
}
