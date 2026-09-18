package com.manao.poc4.kubernetes;

import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaim;
import io.fabric8.kubernetes.api.model.Service;

/** Narrow Kubernetes boundary used by provisioning and recovery; implementations are label-scoped. */
public interface KubernetesGateway {
    boolean projectPvcExists(String projectId);

    boolean initializerSucceeded(String projectId);

    boolean workspacePodReady(String projectId);

    boolean workspaceServiceExists(String projectId);

    void createPvc(PersistentVolumeClaim pvc);

    void createPod(Pod pod);

    void deletePod(String podName);

    void createService(Service service);

    /** Deletes only pods, services and PVCs carrying this project's server-generated labels. */
    void deleteProjectResources(String projectId);

    /** Deletes only the project workloads (Pods/Services) and PRESERVES the PVC (file truth). */
    void deleteProjectWorkloads(String projectId);
}
