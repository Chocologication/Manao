package com.manao.poc4.workspaceagent;

import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Internal namespace-only file API. Every request except healthz is verified by the capability
 * filter; controllers never see or return Kubernetes metadata.
 */
@RestController
@RequestMapping("/agent/v1")
public final class WorkspaceAgentController {
    private final WorkspaceFileService files;
    private final PythonDependencyEditor pythonDependencies;
    private final PythonDependencyTransaction dependencyTransactions;

    public WorkspaceAgentController(WorkspaceFileService files, PythonDependencyEditor pythonDependencies,
                                    PythonDependencyTransaction dependencyTransactions) {
        this.files = files;
        this.pythonDependencies = pythonDependencies;
        this.dependencyTransactions = dependencyTransactions;
    }

    @GetMapping("/healthz")
    public Health healthz() {
        return new Health("UP");
    }

    @GetMapping("/tree")
    public WorkspaceFileService.Tree tree(@RequestParam(name = "path", required = false, defaultValue = "") String path) {
        return files.tree(path);
    }

    @GetMapping("/meta")
    public WorkspaceFileService.FileMeta meta(@RequestParam("path") String path) {
        return files.meta(path);
    }

    @GetMapping("/content")
    public WorkspaceFileService.Content content(@RequestParam("path") String path) {
        return files.content(path);
    }

    @GetMapping("/download")
    public ResponseEntity<byte[]> download(@RequestParam("path") String path) {
        WorkspaceFileService.Download download = files.download(path);
        return ResponseEntity.ok()
            .contentType(MediaType.parseMediaType(download.mediaType()))
            .body(download.bytes());
    }

    @PutMapping("/content")
    public WorkspaceFileService.MutationResult save(
        @RequestParam("path") String path,
        @RequestParam("operationId") String operationId,
        @RequestParam("expectedBeforeSha256") String expectedBeforeSha256,
        @RequestParam("expectedAfterSha256") String expectedAfterSha256,
        @RequestParam("receiptJson") String receiptJson,
        @RequestParam("expectedReceiptSha256") String expectedReceiptSha256,
        @RequestBody(required = false) byte[] content) {
        return files.save(new WorkspaceFileService.Command("SAVE", path, "", null, operationId,
            content == null ? new byte[0] : content, expectedBeforeSha256, expectedAfterSha256,
            receiptJson, expectedReceiptSha256));
    }

    @PostMapping("/entries")
    public WorkspaceFileService.MutationResult create(@RequestBody CreateEntryRequest request) {
        return files.create(new WorkspaceFileService.Command("CREATE", request.path(), "", request.kind(),
            request.operationId(), new byte[0], request.expectedBeforeSha256(), request.expectedAfterSha256(),
            request.receiptJson(), request.expectedReceiptSha256()));
    }

    @PostMapping("/entries/rename")
    public WorkspaceFileService.MutationResult rename(@RequestBody RenameEntryRequest request) {
        return files.rename(new WorkspaceFileService.Command("RENAME", request.path(), request.nextPath(), null,
            request.operationId(), new byte[0], request.expectedBeforeSha256(), request.expectedAfterSha256(),
            request.receiptJson(), request.expectedReceiptSha256()));
    }

    @DeleteMapping("/entries")
    public WorkspaceFileService.MutationResult delete(
        @RequestParam("path") String path,
        @RequestParam("operationId") String operationId,
        @RequestParam("expectedBeforeSha256") String expectedBeforeSha256,
        @RequestParam("expectedAfterSha256") String expectedAfterSha256,
        @RequestParam("receiptJson") String receiptJson,
        @RequestParam("expectedReceiptSha256") String expectedReceiptSha256) {
        return files.delete(new WorkspaceFileService.Command("DELETE", path, "", null, operationId,
            new byte[0], expectedBeforeSha256, expectedAfterSha256, receiptJson, expectedReceiptSha256));
    }

    @GetMapping("/receipts/{operationId}")
    public ResponseEntity<WorkspaceFileService.FetchedReceipt> receipt(@PathVariable String operationId) {
        return files.receipt(operationId)
            .map(ResponseEntity::ok)
            .orElseThrow(() -> new WorkspaceFileService.WorkspaceFileException("ENTRY_NOT_FOUND", "receipt does not exist"));
    }

    /** Prepare only: resolution happens in scratch and the summary carries ids and digests. */
    @PostMapping("/python-dependencies/prepare")
    public PythonDependencyEditor.PreparedPythonDependencies prepareDependency(@RequestBody PrepareDependencyRequest request) {
        return pythonDependencies.prepare(request.operationId(), request.requestSha256(), request.change());
    }

    /** Batch prepare: ONE requirements-text resolution through the same scratch/journal protocol. */
    @PostMapping("/python-dependencies/prepare-batch")
    public PythonDependencyEditor.PreparedPythonDependencies prepareDependencyBatch(
        @RequestBody PrepareBatchDependencyRequest request) {
        return pythonDependencies.prepareBatch(request.operationId(), request.requestSha256(),
            request.requirementsText());
    }

    /** Commit only: first application and post-interruption retries share this single entry. */
    @PostMapping("/python-dependencies/commit")
    public PythonDependencyEditor.PreparedPythonDependencies commitDependency(
        @RequestBody PythonDependencyTransaction.PythonDependencyCommit command) {
        return dependencyTransactions.commit(command);
    }

    @ExceptionHandler(WorkspaceFileService.WorkspaceFileException.class)
    public ResponseEntity<ErrorBody> handleFileException(WorkspaceFileService.WorkspaceFileException ex) {
        return ResponseEntity.status(statusFor(ex.code())).body(new ErrorBody(ex.code(), ex.getMessage()));
    }

    @ExceptionHandler(WorkspacePathPolicy.InvalidPathException.class)
    public ResponseEntity<ErrorBody> handleInvalidPath(WorkspacePathPolicy.InvalidPathException ex) {
        return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY).body(new ErrorBody("INVALID_PATH", ex.getMessage()));
    }

    private static int statusFor(String code) {
        return switch (code) {
            case "ENTRY_NOT_FOUND" -> 404;
            case "ENTRY_ALREADY_EXISTS", "DIRECTORY_NOT_EMPTY", "OPERATION_CONFLICT", "DEPENDENCY_REQUEST_MISMATCH" -> 409;
            case "FILE_TOO_LARGE", "BINARY_FILE", "UNSUPPORTED_ENCODING", "VALIDATION_ERROR", "INVALID_PATH",
                 "PYTHON_DEPENDENCY_UNSUPPORTED", "PYTHON_DEPENDENCY_NO_WHEEL" -> 422;
            case "PYTHON_DEPENDENCY_TIMEOUT" -> 504;
            default -> 503; // IO_ERROR, PYTHON_DEPENDENCY_RESOLUTION_FAILED and unknown codes
        };
    }

    public record Health(String status) { }
    public record ErrorBody(String code, String message) { }
    public record CreateEntryRequest(String kind, String path, String operationId, String expectedBeforeSha256,
                                     String expectedAfterSha256, String receiptJson, String expectedReceiptSha256) { }
    public record RenameEntryRequest(String path, String nextPath, String operationId, String expectedBeforeSha256,
                                     String expectedAfterSha256, String receiptJson, String expectedReceiptSha256) { }
    public record PrepareDependencyRequest(String operationId, String requestSha256,
                                           PythonDependencyEditor.DependencyChange change) { }
    public record PrepareBatchDependencyRequest(String operationId, String requestSha256,
                                                String requirementsText) { }
}
