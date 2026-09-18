package com.manao.poc4.project;

import com.manao.poc4.kubernetes.WorkspacePortForwardManager;
import com.manao.poc4.log.RunLogIngestor;
import com.manao.poc4.log.RunLogService;
import com.manao.poc4.log.RunLogWebSocketHandler;
import com.manao.poc4.terminal.TerminalWebSocketHandler;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Closes this JVM's project-scoped producers before Kubernetes deletion. */
public class ProjectRuntimeCleaner {
    private static final Logger LOG = LoggerFactory.getLogger(ProjectRuntimeCleaner.class);

    private final WorkspacePortForwardManager bridges;
    private final RunLogIngestor logIngestor;
    private final RunLogService logService;
    private final RunLogWebSocketHandler logSockets;
    private final TerminalWebSocketHandler terminalSockets;

    public ProjectRuntimeCleaner(WorkspacePortForwardManager bridges, RunLogIngestor logIngestor,
                                 RunLogService logService, RunLogWebSocketHandler logSockets,
                                 TerminalWebSocketHandler terminalSockets) {
        this.bridges = bridges;
        this.logIngestor = logIngestor;
        this.logService = logService;
        this.logSockets = logSockets;
        this.terminalSockets = terminalSockets;
    }

    public void closeProject(String projectId, List<String> runIds) {
        RuntimeException failure = null;
        for (String runId : runIds) {
            if (logIngestor != null) {
                failure = first(failure, () -> logIngestor.finish(runId));
            }
            if (logSockets != null) {
                failure = first(failure, () -> logSockets.closeRun(runId));
            }
            if (terminalSockets != null) {
                failure = first(failure, () -> terminalSockets.closeRun(runId));
            }
            if (logService != null) {
                failure = first(failure, () -> logService.forgetRun(runId));
            }
        }
        if (bridges != null) {
            failure = first(failure, () -> bridges.closeProject(projectId));
        }
        if (failure != null) {
            throw failure;
        }
    }

    private static RuntimeException first(RuntimeException current, Runnable action) {
        try {
            action.run();
            return current;
        } catch (RuntimeException ex) {
            LOG.warn("project runtime handle close failed: {}", ex.getClass().getSimpleName());
            return current == null ? ex : current;
        }
    }
}
