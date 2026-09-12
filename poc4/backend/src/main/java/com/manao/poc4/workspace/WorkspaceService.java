package com.manao.poc4.workspace;

import com.manao.poc4.api.ApiException;
import com.manao.poc4.project.ProjectLifecycleGate;
import java.nio.charset.StandardCharsets;

/**
 * Browser-facing workspace orchestration: owner/project checks, run-lock enforcement, size
 * policy and mapping of agent responses onto the stage-five file contract.
 */
public final class WorkspaceService {
    private static final long TEXT_LIMIT_BYTES = 20L * 1024 * 1024;
    private static final long MARKDOWN_LIMIT_BYTES = 50L * 1024 * 1024;

    private final WorkspaceStore store;
    private final WorkspaceOperationService operations;
    private final WorkspaceAgent agent;
    private final ProjectLifecycleGate lifecycle;

    public WorkspaceService(WorkspaceStore store, WorkspaceOperationService operations, WorkspaceAgent agent) {
        this(store, operations, agent, new ProjectLifecycleGate());
    }

    public WorkspaceService(WorkspaceStore store, WorkspaceOperationService operations, WorkspaceAgent agent,
                            ProjectLifecycleGate lifecycle) {
        this.store = store;
        this.operations = operations;
        this.agent = agent;
        this.lifecycle = lifecycle;
    }

    public WorkspaceAgent.Tree tree(String ownerId, String projectId, String directory) {
        return gated(projectId, () -> {
            requireReadyProject(store.findProjectForOwner(ownerId, projectId));
            return agentCall(() -> agent.tree(projectId, validDirectory(directory)));
        });
    }

    public WorkspaceAgent.FileMeta meta(String ownerId, String projectId, String path) {
        return gated(projectId, () -> {
            requireReadyProject(store.findProjectForOwner(ownerId, projectId));
            return agentCall(() -> agent.meta(projectId, validPath(path)));
        });
    }

    public WorkspaceAgent.Content content(String ownerId, String projectId, String path) {
        return gated(projectId, () -> {
            requireReadyProject(store.findProjectForOwner(ownerId, projectId));
            return agentCall(() -> agent.content(projectId, validPath(path)));
        });
    }

    public WorkspaceAgent.Download download(String ownerId, String projectId, String path) {
        return gated(projectId, () -> {
            requireReadyProject(store.findProjectForOwner(ownerId, projectId));
            return agentCall(() -> agent.download(projectId, validPath(path)));
        });
    }

    /** Maps agent-side errors on read paths onto the browser error contract. */
    private <T> T agentCall(java.util.function.Supplier<T> call) {
        try {
            return call.get();
        } catch (WorkspaceAgentException ex) {
            if ("ENTRY_NOT_FOUND".equals(ex.code())) {
                throw new ApiException("ENTRY_NOT_FOUND", 404, "Entry does not exist");
            }
            if ("FILE_TOO_LARGE".equals(ex.code()) || "SIZE_LIMIT_EXCEEDED".equals(ex.code())) {
                throw new ApiException("FILE_TOO_LARGE", 422, "File exceeds the size limit");
            }
            if ("BINARY_FILE".equals(ex.code())) {
                throw new ApiException("BINARY_FILE", 422, "Binary content is not supported");
            }
            if ("UNSUPPORTED_ENCODING".equals(ex.code())) {
                throw new ApiException("UNSUPPORTED_ENCODING", 422, "File encoding is not supported");
            }
            if ("INVALID_PATH".equals(ex.code()) || "VALIDATION_ERROR".equals(ex.code())) {
                throw new ApiException("INVALID_PATH", 422, "Invalid file path");
            }
            throw new ApiException("INTERNAL_ERROR", 503, "Workspace is temporarily unavailable");
        }
    }

    public long save(String ownerId, String projectId, String path, String content, String expectedRevision) {
        return gated(projectId, () -> {
            WorkspaceStore.ProjectRecord project = requireReadyProject(store.findProjectForOwner(ownerId, projectId));
            requireWritable(projectId);
            String validPath = validPath(path);
            byte[] bytes = content == null ? new byte[0] : content.getBytes(StandardCharsets.UTF_8);
            requireSaveSize(validPath, bytes.length);
            long revision = parseRevision(expectedRevision, project.workspaceRevision());
            return operations.apply(projectId, "SAVE", validPath, null, null, bytes, revision);
        });
    }

    public long createEntry(String ownerId, String projectId, String kind, String path, String expectedRevision) {
        return gated(projectId, () -> {
            WorkspaceStore.ProjectRecord project = requireReadyProject(store.findProjectForOwner(ownerId, projectId));
            requireWritable(projectId);
            if (!"file".equals(kind) && !"directory".equals(kind)) {
                throw new ApiException("VALIDATION_ERROR", 422, "Unsupported entry kind");
            }
            String validPath = validPath(path);
            long revision = parseRevision(expectedRevision, project.workspaceRevision());
            return operations.apply(projectId, "CREATE", validPath, null, kind, new byte[0], revision);
        });
    }

    public long renameEntry(String ownerId, String projectId, String path, String nextPath, String expectedRevision) {
        return gated(projectId, () -> {
            WorkspaceStore.ProjectRecord project = requireReadyProject(store.findProjectForOwner(ownerId, projectId));
            requireWritable(projectId);
            String validPath = validPath(path);
            String validNextPath = validPath(nextPath);
            if (validPath.equals(validNextPath)) {
                throw new ApiException("VALIDATION_ERROR", 422, "Rename target must differ from the source");
            }
            long revision = parseRevision(expectedRevision, project.workspaceRevision());
            return operations.apply(projectId, "RENAME", validPath, validNextPath, null, new byte[0], revision);
        });
    }

    public long deleteEntry(String ownerId, String projectId, String path, String expectedRevision) {
        return gated(projectId, () -> {
            WorkspaceStore.ProjectRecord project = requireReadyProject(store.findProjectForOwner(ownerId, projectId));
            requireWritable(projectId);
            String validPath = validPath(path);
            long revision = parseRevision(expectedRevision, project.workspaceRevision());
            return operations.apply(projectId, "DELETE", validPath, null, null, new byte[0], revision);
        });
    }

    /** Internal mutation used by provisioning (template writes) while the project is CREATING. */
    public long applyInternal(String projectId, String type, String path, String nextPath, String kind,
                              byte[] content, long expectedRevision) {
        return gated(projectId, () -> operations.apply(projectId, type, path, nextPath, kind, content, expectedRevision));
    }

    public long currentRevision(String ownerId, String projectId) {
        return gated(projectId, () -> requireReadyProject(store.findProjectForOwner(ownerId, projectId)).workspaceRevision());
    }

    public WorkspaceAgent agent() {
        return agent;
    }

    private <T> T gated(String projectId, java.util.function.Supplier<T> action) {
        try (var lease = lifecycle.tryAcquire(projectId).orElseThrow(
                () -> new ApiException("PROJECT_BUSY", 409, "Project is busy"))) {
            return action.get();
        }
    }

    private WorkspaceStore.ProjectRecord requireReadyProject(WorkspaceStore.ProjectRecord project) {
        if (project == null) {
            throw new ApiException("ENTRY_NOT_FOUND", 404, "Project not found");
        }
        if (!"READY".equals(project.state())) {
            throw new ApiException("PROJECT_LOCKED", 409, "Project is locked");
        }
        return project;
    }

    private void requireWritable(String projectId) {
        if (store.hasActiveRun(projectId)) {
            throw new ApiException("PROJECT_LOCKED", 409, "Project is locked");
        }
    }

    private void requireSaveSize(String path, int length) {
        long limit = path.endsWith(".md") ? MARKDOWN_LIMIT_BYTES : TEXT_LIMIT_BYTES;
        if (length > limit) {
            throw new ApiException("FILE_TOO_LARGE", 422, "File exceeds the size limit");
        }
    }

    private long parseRevision(String expectedRevision, long current) {
        if (expectedRevision == null) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
        long revision;
        try {
            revision = Long.parseLong(expectedRevision);
        } catch (NumberFormatException ex) {
            throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
        }
        if (revision < 0 || revision != current) {
            throw new ApiException("WORKSPACE_REVISION_CONFLICT", 409, "The workspace changed; reload and retry.");
        }
        return revision;
    }

    private String validPath(String path) {
        try {
            return WorkspacePathPolicy.validateRelativePath(path);
        } catch (WorkspacePathPolicy.InvalidPathException ex) {
            throw new ApiException("INVALID_PATH", 422, "Invalid file path");
        }
    }

    private String validDirectory(String directory) {
        try {
            return WorkspacePathPolicy.validateDirectoryPath(directory);
        } catch (WorkspacePathPolicy.InvalidPathException ex) {
            throw new ApiException("INVALID_PATH", 422, "Invalid file path");
        }
    }
}
