package com.manao.poc4.project;

import java.util.List;

/** Persistence for project runtime configuration and remembered storage identity. */
public interface ProjectRuntimeStore {
    /** Missing or legacy NULL JSON reads as the console spec; unknown projects do too. */
    ProjectRuntimeSpec loadSpec(String projectId);

    void setEndpointState(String projectId, String state);

    /**
     * Creations whose public endpoint application never reached a verdict: rows still CREATING
     * with endpoint_state UNKNOWN (a lost response, a transport failure or a failed rollback).
     */
    List<PendingEndpoint> projectsWithUnknownEndpoint();

    /** One CREATING row awaiting endpoint verification; the spec carries the exact requested ports. */
    record PendingEndpoint(String projectId, String ownerId, ProjectRuntimeSpec spec) {}

    /** Only WORKSPACE and MYSQL purposes exist; same-purpose writes update the binding. */
    void rememberStorage(String projectId, StorageBinding binding);

    List<StorageBinding> storageBindings(String projectId);

    record StorageBinding(String purpose, String pvcName, String pvcUid,
                          String pvName, String pvUid) {}
}
