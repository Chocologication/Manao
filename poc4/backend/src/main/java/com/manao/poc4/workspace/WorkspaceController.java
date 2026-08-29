package com.manao.poc4.workspace;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.manao.poc4.api.ApiException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Browser-facing file endpoints from the stage-five contract. Responses carry opaque business
 * identifiers only; Kubernetes facts and absolute paths never leave this boundary.
 */
@RestController
@ConditionalOnBean({WorkspaceService.class, org.springframework.jdbc.core.JdbcTemplate.class})
@RequestMapping("/api/v1/projects/{projectId}")
public final class WorkspaceController {
    private final WorkspaceService workspace;

    public WorkspaceController(WorkspaceService workspace) { this.workspace = workspace; }

    @GetMapping("/files/tree")
    public TreeResponse tree(Authentication authentication, @PathVariable String projectId,
                             @RequestParam(name = "path", required = false, defaultValue = "") String path) {
        String ownerId = authentication.getName();
        WorkspaceAgent.Tree tree = workspace.tree(ownerId, projectId, path);
        return new TreeResponse(tree.directory(), tree.entries().stream().map(WorkspaceController::view).toList(),
            Long.toString(workspace.currentRevision(ownerId, projectId)));
    }

    @GetMapping("/files/meta")
    public MetaResponse meta(Authentication authentication, @PathVariable String projectId,
                             @RequestParam("path") String path) {
        return view(workspace.meta(authentication.getName(), projectId, path));
    }

    @GetMapping("/files/content")
    public ContentResponse content(Authentication authentication, @PathVariable String projectId,
                                   @RequestParam("path") String path) {
        String ownerId = authentication.getName();
        WorkspaceAgent.Content content = workspace.content(ownerId, projectId, path);
        return new ContentResponse(content.path(), content.content(),
            Long.toString(workspace.currentRevision(ownerId, projectId)));
    }

    @GetMapping(value = "/files/download", produces = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public byte[] download(Authentication authentication, @PathVariable String projectId,
                           @RequestParam("path") String path) {
        return workspace.download(authentication.getName(), projectId, path).bytes();
    }

    @PutMapping("/files/content")
    public SaveResponse save(Authentication authentication, @PathVariable String projectId,
                             @RequestParam("path") String path, @Valid @RequestBody SaveFileRequest request) {
        String ownerId = authentication.getName();
        long newRevision = workspace.save(ownerId, projectId, path, request.content(),
            request.expectedWorkspaceRevision());
        return new SaveResponse(view(workspace.meta(ownerId, projectId, path)), Long.toString(newRevision));
    }

    @PostMapping("/entries")
    public CreateResponse createEntry(Authentication authentication, @PathVariable String projectId,
                                      @Valid @RequestBody CreateEntryRequest request) {
        String ownerId = authentication.getName();
        long newRevision = workspace.createEntry(ownerId, projectId, request.kind(), request.path(),
            request.expectedWorkspaceRevision());
        WorkspaceAgent.FileMeta meta = "file".equals(request.kind())
            ? workspace.meta(ownerId, projectId, request.path()) : null;
        return new CreateResponse(entry(request.path(), request.kind(), meta), meta == null ? null : view(meta),
            Long.toString(newRevision));
    }

    @PostMapping("/entries/rename")
    public RenameResponse renameEntry(Authentication authentication, @PathVariable String projectId,
                                      @Valid @RequestBody RenameEntryRequest request) {
        String ownerId = authentication.getName();
        long newRevision = workspace.renameEntry(ownerId, projectId, request.path(), request.nextPath(),
            request.expectedWorkspaceRevision());
        WorkspaceAgent.FileMeta meta = workspace.meta(ownerId, projectId, request.nextPath());
        boolean directory = "inode/directory".equals(meta.mediaType());
        return new RenameResponse(request.path(), request.nextPath(),
            entry(request.nextPath(), directory ? "directory" : "file", directory ? null : meta),
            directory ? null : view(meta), Long.toString(newRevision));
    }

    @DeleteMapping("/entries")
    public DeleteResponse deleteEntry(Authentication authentication, @PathVariable String projectId,
                                      @RequestParam("path") String path,
                                      @Valid @RequestBody DeleteEntryRequest request) {
        long newRevision = workspace.deleteEntry(authentication.getName(), projectId, path,
            request.expectedWorkspaceRevision());
        return new DeleteResponse(path, Long.toString(newRevision));
    }

    private static TreeEntryResponse entry(String path, String kind, WorkspaceAgent.FileMeta meta) {
        String name = path.substring(path.lastIndexOf('/') + 1);
        boolean directory = "directory".equals(kind);
        return new TreeEntryResponse(path, name, kind, name.startsWith("."),
            directory ? null : meta == null ? null : meta.sizeBytes(),
            directory ? Boolean.FALSE : null);
    }

    private static TreeEntryResponse view(WorkspaceAgent.TreeEntry entry) {
        return new TreeEntryResponse(entry.path(), entry.name(), entry.kind(), entry.hidden(),
            entry.sizeBytes(), entry.hasChildren());
    }

    private static MetaResponse view(WorkspaceAgent.FileMeta meta) {
        return new MetaResponse(meta.path(), meta.name(), meta.sizeBytes(), meta.mediaType(), meta.encoding(),
            meta.language(), meta.renderMode(), meta.blockReason());
    }

    public record TreeResponse(String directory, java.util.List<TreeEntryResponse> entries, String workspaceRevision) { }
    public record TreeEntryResponse(String path, String name, String kind, boolean hidden, Long sizeBytes,
                                    Boolean hasChildren) { }
    public record MetaResponse(String path, String name, Long sizeBytes, String mediaType, String encoding,
                               String language, String renderMode, String blockReason) { }
    public record ContentResponse(String path, String content, String workspaceRevision) { }
    public record SaveResponse(MetaResponse file, String workspaceRevision) { }
    public record CreateResponse(TreeEntryResponse entry, MetaResponse file, String workspaceRevision) { }
    public record RenameResponse(String path, String nextPath, TreeEntryResponse entry, MetaResponse file,
                                 String workspaceRevision) { }
    public record DeleteResponse(String path, String workspaceRevision) { }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record SaveFileRequest(@NotBlank String content, @NotBlank String expectedWorkspaceRevision) { }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record CreateEntryRequest(@NotBlank String kind, @NotBlank String path,
                                     @NotBlank String expectedWorkspaceRevision) { }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record RenameEntryRequest(@NotBlank String path, @NotBlank String nextPath,
                                     @NotBlank String expectedWorkspaceRevision) { }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record DeleteEntryRequest(@NotBlank String expectedWorkspaceRevision) { }
}
