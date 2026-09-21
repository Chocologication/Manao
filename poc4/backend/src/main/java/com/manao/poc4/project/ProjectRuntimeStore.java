package com.manao.poc4.project;

import java.util.List;

/** Persistence for project runtime configuration and remembered storage identity. */
public interface ProjectRuntimeStore {
    /** Missing or legacy NULL JSON reads as the console spec; unknown projects do too. */
    ProjectRuntimeSpec loadSpec(String projectId);

    void setEndpointState(String projectId, String state);

    /** Only WORKSPACE and MYSQL purposes exist; same-purpose writes update the binding. */
    void rememberStorage(String projectId, StorageBinding binding);

    List<StorageBinding> storageBindings(String projectId);

    record StorageBinding(String purpose, String pvcName, String pvcUid,
                          String pvName, String pvUid) {}
}
