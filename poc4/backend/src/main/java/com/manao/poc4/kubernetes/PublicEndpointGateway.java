package com.manao.poc4.kubernetes;

import com.manao.poc4.project.ProjectRuntimeSpec;
import java.util.List;

/**
 * Applies the user's exact public port group as one project Service. Never substitutes,
 * completes or re-rolls ports: a deterministic allocation conflict is CONFLICT, anything the
 * gateway cannot judge (transport errors, non-port 422s, foreign resources) stays UNKNOWN.
 */
public interface PublicEndpointGateway {

    /**
     * Read-only, best-effort occupancy check across every namespace, run BEFORE a project row
     * exists. It is only a courtesy rejection: the Service create below stays the authoritative
     * final judge of a race, and an uncertain answer (Forbidden, timeout, network error, null
     * result) is UNKNOWN — never "free" and never a conflict claim.
     */
    PreflightResult checkNodePortsAvailable(List<ProjectRuntimeSpec.Port> ports);

    ApplyResult ensure(String projectId, List<ProjectRuntimeSpec.Port> ports);

    /** Points the stable project Service selector at one concrete application run. */
    void routeToRun(String projectId, String runId, String podUid);

    /** Detaches the Service from any run without deleting the port allocation. */
    void withdraw(String projectId);

    enum ApplyResult { CONFIRMED, CONFLICT, UNKNOWN }

    enum PreflightResult { AVAILABLE, IN_USE, UNKNOWN }
}
