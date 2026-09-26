package com.manao.poc4.workspace;

import java.util.List;
import java.util.Optional;

/**
 * The only workspace file API boundary used by the backend. Implementations transport capability
 * signed requests to the project workspace-agent; they never expose Kubernetes identifiers.
 */
public interface WorkspaceAgent {
    Tree tree(String projectId, String directory);

    FileMeta meta(String projectId, String path);

    Content content(String projectId, String path);

    Download download(String projectId, String path);

    MutationResult mutate(String projectId, Command command);

    Optional<FetchedReceipt> receipt(String projectId, String operationId);

    /**
     * Prepares a Python dependency change in the agent's scratch space; the workspace sources
     * are untouched and the response carries identity and digests only.
     */
    PreparedPythonDependencies prepare(String projectId, String operationId, String requestSha256,
                                       DependencyChange change);

    /** Commits the prepared two-file change under the backend-issued deterministic receipt. */
    PreparedPythonDependencies commit(String projectId, PythonDependencyCommit command);

    record Tree(String directory, List<TreeEntry> entries) { }

    record TreeEntry(String path, String name, String kind, boolean hidden, Long sizeBytes, Boolean hasChildren) { }

    record FileMeta(String path, String name, Long sizeBytes, String mediaType, String encoding,
                    String language, String renderMode, String blockReason, String sha256) { }

    record Content(String path, String content, String sha256) { }

    record Download(String path, String mediaType, byte[] bytes) { }

    record Command(String type, String path, String nextPath, String kind, String operationId, byte[] content,
                   String expectedBeforeSha256, String expectedAfterSha256,
                   String receiptJson, String expectedReceiptSha256) { }

    record MutationResult(String operationId, String path, String beforeSha256, String afterSha256,
                          String receiptPath, String receiptSha256) { }

    record FetchedReceipt(String operationId, String type, String path, String nextPath,
                          String beforeSha256, String afterSha256, String receiptSha256) { }

    /** Wire record of the requested change; the backend sends the normalized package name. */
    record DependencyChange(String action, String packageName, String version) { }

    /** Wire record of the prepare/commit summary: ids and digests only, never file contents. */
    record PreparedPythonDependencies(String operationId, String requestSha256,
                                      String beforeSha256, String afterSha256) { }

    /** Wire record for the commit request: the prepared summary plus the backend-issued receipt. */
    record PythonDependencyCommit(PreparedPythonDependencies prepared, String receiptJson, String receiptSha256) { }
}
