package com.manao.poc4.recovery;

import com.manao.poc4.kubernetes.PublicEndpointGateway;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.project.ProjectRuntimeStore;
import com.manao.poc4.project.ProjectService;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;

/**
 * One startup scan for creations whose public endpoint application never reached a verdict
 * (CREATING rows left at endpoint_state UNKNOWN by a lost response, a transport failure or a
 * failed rollback). Each row is verified through the same {@link PublicEndpointGateway#ensure}
 * semantics as the create path — an existing Service is only reused when the project label and
 * the whole port group match — and advanced exactly once:
 *
 * <ul>
 *   <li>CONFIRMED: the stable identity keeps its Service; the endpoint state becomes ASSIGNED
 *       and the provisioning path continues under the same lifecycle lease — never a second
 *       project for the same attempt.</li>
 *   <li>CONFLICT: a deterministic allocation conflict with no Service left behind and, without
 *       a confirmed endpoint, no workspace side effects; the temporary row is cancelled and the
 *       quota released, exactly like the create path.</li>
 *   <li>UNKNOWN: still undecidable (transport failure, foreign Service); the row stays
 *       CREATING/UNKNOWN for the next startup scan. Nothing is blindly replayed and no loop
 *       ever retries inside the controller.</li>
 * </ul>
 */
public final class CreationEndpointRecoveryService implements ApplicationListener<ApplicationReadyEvent> {
    private static final Logger LOG = LoggerFactory.getLogger(CreationEndpointRecoveryService.class);
    private static final String ENDPOINT_ASSIGNED = "ASSIGNED";
    private static final String STATE_CREATING = "CREATING";

    /** Continues the fixed provisioning path; invoked under the scan's own lifecycle lease. */
    public interface ProvisioningContinuation {
        void provision(String projectId);
    }

    public record ScanReport(List<String> confirmed, List<String> cancelled, List<String> deferred) {}

    private final ProjectRuntimeStore store;
    private final PublicEndpointGateway endpoints;
    private final ProjectService projects;
    private final ProvisioningContinuation provisioning;
    private final ProjectLifecycleGate lifecycle;

    public CreationEndpointRecoveryService(ProjectRuntimeStore store, PublicEndpointGateway endpoints,
                                           ProjectService projects, ProvisioningContinuation provisioning,
                                           ProjectLifecycleGate lifecycle) {
        this.store = store;
        this.endpoints = endpoints;
        this.projects = projects;
        this.provisioning = provisioning;
        this.lifecycle = lifecycle;
    }

    /** Startup hook: one scan, fully guarded so a failing scan never breaks the startup. */
    @Override public void onApplicationEvent(ApplicationReadyEvent event) {
        try {
            recoverUnresolvedEndpoints();
        } catch (RuntimeException ex) {
            LOG.warn("startup creation-endpoint scan failed; unresolved rows wait for the next startup", ex);
        }
    }

    public ScanReport recoverUnresolvedEndpoints() {
        List<String> confirmed = new ArrayList<>();
        List<String> cancelled = new ArrayList<>();
        List<String> deferred = new ArrayList<>();
        for (ProjectRuntimeStore.PendingEndpoint pending : store.projectsWithUnknownEndpoint()) {
            if (pending.spec().publicPorts().isEmpty()) {
                continue; // no endpoint application to verify; plain creations are not this scan's scope
            }
            try (var lease = lifecycle.tryAcquire(pending.projectId()).orElse(null)) {
                if (lease == null) {
                    deferred.add(pending.projectId()); // busy: another holder owns the outcome
                    continue;
                }
                if (!isStillCreating(pending)) {
                    continue; // resolved elsewhere between listing and the lease; nothing to reconcile
                }
                advance(pending, confirmed, cancelled, deferred);
            } catch (RuntimeException ex) {
                LOG.warn("creation-endpoint recovery failed for one project; it stays unknown: projectId={}",
                    pending.projectId(), ex);
                deferred.add(pending.projectId());
            }
        }
        if (!confirmed.isEmpty() || !cancelled.isEmpty() || !deferred.isEmpty()) {
            LOG.info("creation endpoint recovery: confirmed={} cancelled={} deferred={}",
                confirmed, cancelled, deferred);
        }
        return new ScanReport(List.copyOf(confirmed), List.copyOf(cancelled), List.copyOf(deferred));
    }

    /** Re-reads under the lease: another recovery loop or the user may have settled the row. */
    private boolean isStillCreating(ProjectRuntimeStore.PendingEndpoint pending) {
        ProjectService.Project current = projects.get(pending.ownerId(), pending.projectId()).orElse(null);
        return current != null && STATE_CREATING.equals(current.state());
    }

    private void advance(ProjectRuntimeStore.PendingEndpoint pending, List<String> confirmed,
                         List<String> cancelled, List<String> deferred) {
        String projectId = pending.projectId();
        PublicEndpointGateway.ApplyResult result = endpoints.ensure(projectId, pending.spec().publicPorts());
        if (result == PublicEndpointGateway.ApplyResult.CONFLICT) {
            // Deterministic conflict and no Service left behind: like the create path, the
            // rejected attempt's temporary row goes away and the quota is free again.
            if (projects.deleteProjectRow(pending.ownerId(), projectId)) {
                cancelled.add(projectId);
            } else {
                LOG.info("creation row already gone during conflict cancellation: projectId={}", projectId);
            }
            return;
        }
        if (result == PublicEndpointGateway.ApplyResult.CONFIRMED) {
            store.setEndpointState(projectId, ENDPOINT_ASSIGNED);
            // Same-thread lease reentrancy: provisioning runs while this scan holds the lease,
            // so no other recovery loop can fail-and-clean the row behind the scan's back.
            provisioning.provision(projectId);
            confirmed.add(projectId);
            return;
        }
        deferred.add(projectId); // UNKNOWN: the row keeps waiting for the next startup scan
    }
}
