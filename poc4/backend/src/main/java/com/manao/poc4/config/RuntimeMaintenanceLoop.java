package com.manao.poc4.config;

import com.manao.poc4.audit.RetentionCleanupJob;
import com.manao.poc4.kubernetes.WorkspacePortForwardManager;
import com.manao.poc4.log.RunLogIngestor;
import com.manao.poc4.recovery.ProjectRecoveryService;
import com.manao.poc4.run.RunObservationService;
import com.manao.poc4.run.RunRecoveryService;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Conditional;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The runtime heartbeat: without these loops the recovery/cleanup/watch code would exist but
 * never run. Every task is individually guarded so one failure never cancels the schedule.
 */
@Component
@Conditional(SecurityConfig.BackendAuthCondition.class)
public class RuntimeMaintenanceLoop {
    private static final Logger LOG = LoggerFactory.getLogger(RuntimeMaintenanceLoop.class);

    private final ObjectProvider<RunObservationService> runObservation;
    private final ObjectProvider<RunRecoveryService> runRecovery;
    private final ObjectProvider<ProjectRecoveryService> projectRecovery;
    private final ObjectProvider<RetentionCleanupJob> retention;
    private final ObjectProvider<WorkspacePortForwardManager> bridges;
    private final ObjectProvider<RunLogIngestor> logIngestor;
    private final ObjectProvider<com.manao.poc4.terminal.TerminalWebSocketHandler> terminalHandler;

    public RuntimeMaintenanceLoop(ObjectProvider<RunObservationService> runObservation,
                                  ObjectProvider<RunRecoveryService> runRecovery,
                                  ObjectProvider<ProjectRecoveryService> projectRecovery,
                                  ObjectProvider<RetentionCleanupJob> retention,
                                  ObjectProvider<WorkspacePortForwardManager> bridges,
                                  ObjectProvider<RunLogIngestor> logIngestor,
                                  ObjectProvider<com.manao.poc4.terminal.TerminalWebSocketHandler> terminalHandler) {
        this.runObservation = runObservation;
        this.runRecovery = runRecovery;
        this.projectRecovery = projectRecovery;
        this.retention = retention;
        this.bridges = bridges;
        this.logIngestor = logIngestor;
        this.terminalHandler = terminalHandler;
    }

    @Scheduled(fixedDelay = 3000)
    public void observeRuns() {
        safe("run observation", () -> { var service = runObservation.getIfAvailable(); if (service != null) service.observe(); });
    }

    @Scheduled(fixedDelay = 15000)
    public void recoverRuns() {
        safe("run recovery", () -> { var service = runRecovery.getIfAvailable(); if (service != null) service.recoverRuns(); });
    }

    @Scheduled(fixedDelay = 30000)
    public void recoverCreatingProjects() {
        safe("project recovery", () -> { var service = projectRecovery.getIfAvailable(); if (service != null) service.recoverStaleCreatingProjects(); });
    }

    @Scheduled(fixedDelay = 10000)
    public void expireStaleReservations() {
        safe("reservation expiry", () -> { var service = retention.getIfAvailable(); if (service != null) service.expireStaleReservations(); });
    }

    @Scheduled(cron = "0 7 * * * *")
    public void cleanupExpired() {
        safe("seven-day cleanup", () -> { var service = retention.getIfAvailable(); if (service != null) service.cleanupExpired(); });
    }

    @Scheduled(fixedDelay = 5000)
    public void maintainBridgesAndTerminal() {
        safe("bridge child check", () -> { var manager = bridges.getIfAvailable(); if (manager != null) manager.checkChildren(); });
        safe("terminal input deadlines", () -> { var handler = terminalHandler.getIfAvailable(); if (handler != null) handler.enforceInputDeadlines(); });
    }

    @PreDestroy
    public void shutdown() {
        safe("terminal teardown", () -> { var handler = terminalHandler.getIfAvailable(); if (handler != null) handler.teardownAllSessions(); });
        safe("log watch detach", () -> { var ingestor = logIngestor.getIfAvailable(); if (ingestor != null) ingestor.detachAll(); });
        safe("bridge shutdown", () -> { var manager = bridges.getIfAvailable(); if (manager != null) manager.shutdown(); });
    }

    private void safe(String name, Runnable task) {
        try {
            task.run();
        } catch (RuntimeException ex) {
            LOG.warn("maintenance task '{}' failed; the schedule continues", name, ex);
        }
    }
}
