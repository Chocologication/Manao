package com.manao.poc4.workspaceagent;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.regex.Pattern;

/**
 * Enforces that every resolved path stays inside the derived project directory the agent serves.
 * The project root is the PVC {@code subPath} mount, so even a symlink escape cannot leave it.
 */
public final class WorkspacePathPolicy {
    /** Internal receipt directory; users can never read or write it through the file API. */
    public static final String INTERNAL_DIRECTORY = ".manao";

    private static final Pattern WINDOWS_DRIVE_PREFIX = Pattern.compile("^[A-Za-z]:");
    private static final Pattern OPERATION_ID = Pattern.compile("[A-Za-z0-9-]{1,64}");

    private WorkspacePathPolicy() { }

    public static boolean isAbsoluteOrMalformed(String relativePath) {
        return relativePath.startsWith("/") || relativePath.contains("\\") || relativePath.contains("\0")
            || WINDOWS_DRIVE_PREFIX.matcher(relativePath).find();
    }

    public static Path resolve(Path projectRoot, String relativePath) {
        Path root = projectRoot.normalize();
        if (!Files.isDirectory(root)) throw new InvalidPathException("project directory is unavailable");
        if (relativePath == null || relativePath.isEmpty()) throw new InvalidPathException("project-relative path required");
        if (isAbsoluteOrMalformed(relativePath)) throw new InvalidPathException("project-relative path required");
        String[] segments = relativePath.split("/", -1);
        for (String segment : segments) {
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) {
                throw new InvalidPathException("project-relative path required");
            }
        }
        if (segments[0].equals(INTERNAL_DIRECTORY)) {
            throw new InvalidPathException("path is internal to the workspace service");
        }
        try {
            Path resolved = root.toRealPath();
            Path realRoot = resolved;
            for (String segment : segments) {
                resolved = resolved.resolve(segment);
                if (Files.exists(resolved, LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(resolved)) {
                    if (!resolved.toRealPath().startsWith(realRoot)) {
                        throw new InvalidPathException("path escapes the project directory");
                    }
                } else if (Files.isSymbolicLink(resolved)) {
                    if (!resolved.toRealPath().startsWith(realRoot)) {
                        throw new InvalidPathException("path escapes the project directory");
                    }
                }
            }
            return resolved;
        } catch (IOException ex) {
            throw new InvalidPathException("path cannot be resolved safely");
        }
    }

    /** Directory variant that treats the empty string as the project root. */
    public static Path resolveDirectory(Path projectRoot, String relativePath) {
        if (relativePath == null || relativePath.isEmpty()) return projectRoot.normalize();
        return resolve(projectRoot, relativePath);
    }

    public static boolean isValidOperationId(String operationId) {
        return operationId != null && OPERATION_ID.matcher(operationId).matches();
    }

    public static final class InvalidPathException extends RuntimeException {
        public InvalidPathException(String message) { super(message); }
    }
}
