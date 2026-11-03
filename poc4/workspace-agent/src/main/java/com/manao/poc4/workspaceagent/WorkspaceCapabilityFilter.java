package com.manao.poc4.workspaceagent;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.springframework.http.HttpStatus;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.util.StreamUtils;

/**
 * Verifies the workspace capability header on every request except healthz and exposes the cached
 * request body so controllers and the verifier observe identical bytes.
 */
public final class WorkspaceCapabilityFilter extends OncePerRequestFilter {
    private final WorkspaceCapabilityVerifier verifier;

    public WorkspaceCapabilityFilter(WorkspaceCapabilityVerifier verifier) {
        this.verifier = verifier;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return request.getRequestURI().equals("/agent/v1/healthz");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
        throws ServletException, IOException {
        boolean attachment = org.springframework.web.util.pattern.PathPatternParser.defaultInstance
            .parse("/agent/v1/attachments/{*path}").matches(
                org.springframework.http.server.PathContainer.parsePath(request.getRequestURI()));
        int limit = attachment ? WorkspaceAttachmentService.MAX_BYTES : Integer.MAX_VALUE - 1;
        if (attachment && request.getContentLengthLong() > limit) { tooLarge(response); return; }
        byte[] cached = request.getInputStream().readNBytes(limit + 1);
        if (cached.length > limit) { tooLarge(response); return; }
        CachedBodyRequestWrapper wrapped = new CachedBodyRequestWrapper(request, cached);
        byte[] body = cached;
        String pathAndQuery = request.getRequestURI()
            + (request.getQueryString() == null ? "" : "?" + request.getQueryString());
        try {
            verifier.verify(request.getHeader("X-Manao-Workspace-Capability"),
                request.getMethod(), pathAndQuery, body);
        } catch (WorkspaceCapabilityVerifier.RejectedException ex) {
            response.setStatus(HttpStatus.UNAUTHORIZED.value());
            response.setContentType("application/json");
            response.setCharacterEncoding(StandardCharsets.UTF_8.name());
            response.getWriter().write("{\"code\":\"CAPABILITY_REJECTED\",\"message\":\"capability rejected\"}");
            return;
        }
        chain.doFilter(wrapped, response);
    }

    private static void tooLarge(HttpServletResponse response) throws IOException {
        response.setStatus(413);
        response.setContentType("application/json");
        response.getWriter().write("{\"code\":\"AI_ATTACHMENT_TOO_LARGE\",\"message\":\"Image exceeds 10000000 bytes\"}");
    }

    private static final class CachedBodyRequestWrapper extends jakarta.servlet.http.HttpServletRequestWrapper {
        private final byte[] cached;

        CachedBodyRequestWrapper(HttpServletRequest request, byte[] cached) throws IOException {
            super(request);
            this.cached = cached;
        }

        @Override
        public jakarta.servlet.ServletInputStream getInputStream() {
            java.io.ByteArrayInputStream buffer = new java.io.ByteArrayInputStream(cached);
            return new jakarta.servlet.ServletInputStream() {
                @Override public boolean isFinished() { return buffer.available() == 0; }
                @Override public boolean isReady() { return true; }
                @Override public void setReadListener(jakarta.servlet.ReadListener listener) { }
                @Override public int read() { return buffer.read(); }
            };
        }
    }
}
