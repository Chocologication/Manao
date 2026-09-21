package com.manao.poc4.kubernetes;

import com.manao.poc4.project.ProjectRuntimeSpec;
import java.util.List;

/**
 * Applies the user's exact public port group as one project Service. Never substitutes,
 * completes or re-rolls ports: a deterministic allocation conflict is CONFLICT, anything the
 * gateway cannot judge (transport errors, non-port 422s, foreign resources) stays UNKNOWN.
 */
public interface PublicEndpointGateway {
    ApplyResult ensure(String projectId, List<ProjectRuntimeSpec.Port> ports);

    /** Points the stable project Service selector at one concrete application run. */
    void routeToRun(String projectId, String runId, String podUid);

    /** Detaches the Service from any run without deleting the port allocation. */
    void withdraw(String projectId);

    enum ApplyResult { CONFIRMED, CONFLICT, UNKNOWN }
}
