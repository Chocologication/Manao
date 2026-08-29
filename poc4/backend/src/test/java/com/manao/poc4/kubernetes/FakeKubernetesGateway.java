package com.manao.poc4.kubernetes;

import io.fabric8.kubernetes.api.model.HasMetadata;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PersistentVolumeClaim;
import io.fabric8.kubernetes.api.model.Service;
import java.util.HashSet;
import java.util.Set;

/**
 * Test double for the Kubernetes boundary: records created resources per project so ordering,
 * label scoping and cleanup behavior are observable.
 */
public class FakeKubernetesGateway implements KubernetesGateway {
    public final Set<String> created = new HashSet<>();
    public final Set<String> deletedProjects = new HashSet<>();
    public final Set<String> deletedPods = new HashSet<>();
    public boolean pvcMissing = false;
    public boolean serviceMissing = false;
    public boolean initializerFails = false;
    public boolean podReadyFails = false;

    @Override public boolean projectPvcExists(String projectId) {
        return !pvcMissing && created.contains("pvc:" + projectId);
    }

    @Override public boolean initializerSucceeded(String projectId) {
        return created.contains("init:" + projectId);
    }

    @Override public boolean workspacePodReady(String projectId) {
        return !podReadyFails && created.contains("pod:" + projectId);
    }

    @Override public boolean workspaceServiceExists(String projectId) {
        return !serviceMissing && created.contains("svc:" + projectId);
    }

    @Override public void createPvc(PersistentVolumeClaim pvc) {
        if (!pvcMissing) created.add("pvc:" + projectId(pvc));
    }

    @Override public void createPod(Pod pod) {
        String projectId = projectId(pod);
        if (pod.getMetadata().getName().startsWith("manao-ws-init-")) {
            if (!initializerFails) created.add("init:" + projectId);
        } else if (!podReadyFails) {
            created.add("pod:" + projectId);
        }
    }

    @Override public void createService(Service service) {
        if (!serviceMissing) created.add("svc:" + projectId(service));
    }

    @Override public void deletePod(String podName) {
        deletedPods.add(podName);
    }

    @Override public void deleteProjectResources(String projectId) {
        deletedProjects.add(projectId);
        created.removeAll(created.stream().filter(entry -> entry.endsWith(":" + projectId)).toList());
    }

    private static String projectId(HasMetadata resource) {
        String value = resource.getMetadata().getLabels().get("manao.poc4/project-id");
        if (value == null) throw new IllegalArgumentException("resource lacks the project label");
        return value;
    }
}
