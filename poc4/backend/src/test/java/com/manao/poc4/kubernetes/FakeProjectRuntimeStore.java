package com.manao.poc4.kubernetes;

import com.manao.poc4.project.ProjectRuntimeSpec;
import com.manao.poc4.project.ProjectRuntimeStore;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** In-memory test double for the project runtime persistence boundary. */
public class FakeProjectRuntimeStore implements ProjectRuntimeStore {
    private final Map<String, ProjectRuntimeSpec> specs = new HashMap<>();
    private final Map<String, String> endpointStates = new HashMap<>();
    private final Map<String, List<StorageBinding>> bindings = new HashMap<>();

    @Override public ProjectRuntimeSpec loadSpec(String projectId) {
        ProjectRuntimeSpec spec = specs.get(projectId);
        return spec == null ? ProjectRuntimeSpec.console() : spec;
    }

    /** Seeds a runtime spec for a project, as creation would have persisted it. */
    public void putSpec(String projectId, ProjectRuntimeSpec spec) {
        specs.put(projectId, spec);
    }

    @Override public void setEndpointState(String projectId, String state) {
        endpointStates.put(projectId, state);
    }

    @Override public List<PendingEndpoint> projectsWithUnknownEndpoint() {
        return List.of();
    }

    @Override public void rememberStorage(String projectId, StorageBinding binding) {
        List<StorageBinding> projectBindings = bindings.computeIfAbsent(projectId, key -> new ArrayList<>());
        projectBindings.removeIf(existing -> existing.purpose().equals(binding.purpose()));
        projectBindings.add(binding);
    }

    /** The database orders bindings by purpose; the double mirrors that for deterministic reads. */
    @Override public List<StorageBinding> storageBindings(String projectId) {
        List<StorageBinding> projectBindings = bindings.get(projectId);
        if (projectBindings == null) return List.of();
        return projectBindings.stream()
            .sorted(Comparator.comparing(StorageBinding::purpose))
            .toList();
    }

    /** Simulates the database FK cascade: bindings vanish only with the project row. */
    public void clearBindings(String projectId) {
        bindings.remove(projectId);
    }
}
