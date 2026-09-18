package com.manao.poc4.workspace;

import java.util.regex.Pattern;

/**
 * Backend-side syntax validation of project-relative paths. Filesystem containment (symlinks,
 * real paths) is enforced by the workspace-agent; the backend rejects malformed or reserved
 * paths before any request leaves the process.
 */
public final class WorkspacePathPolicy {
    public static final String INTERNAL_DIRECTORY = ".manao";

    private static final Pattern WINDOWS_DRIVE_PREFIX = Pattern.compile("^[A-Za-z]:");

    private WorkspacePathPolicy() { }

    public static String validateRelativePath(String relativePath) {
        if (relativePath == null || relativePath.isEmpty()) {
            throw new InvalidPathException();
        }
        if (relativePath.startsWith("/") || relativePath.contains("\\") || relativePath.contains("\0")
            || WINDOWS_DRIVE_PREFIX.matcher(relativePath).find()) {
            throw new InvalidPathException();
        }
        for (int i = 0; i < relativePath.length(); i++) {
            char c = relativePath.charAt(i);
            if (c < 0x20 || c == 0x7f) {
                throw new InvalidPathException();
            }
        }
        String[] segments = relativePath.split("/", -1);
        for (String segment : segments) {
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) {
                throw new InvalidPathException();
            }
            // Defense in depth against double-encoding: traversal payloads must never travel
            // through any layer still percent-encoded.
            String lower = segment.toLowerCase();
            if (lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c")) {
                throw new InvalidPathException();
            }
        }
        if (segments[0].equals(INTERNAL_DIRECTORY)) {
            throw new InvalidPathException();
        }
        return relativePath;
    }

    public static String validateDirectoryPath(String relativePath) {
        if (relativePath == null || relativePath.isEmpty()) return "";
        return validateRelativePath(relativePath);
    }

    public static final class InvalidPathException extends RuntimeException {
        public InvalidPathException() { super("project-relative path required"); }
    }
}
