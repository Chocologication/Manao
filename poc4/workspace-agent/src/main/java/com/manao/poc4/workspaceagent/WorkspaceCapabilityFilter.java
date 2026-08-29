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
        CachedBodyRequestWrapper wrapped = new CachedBodyRequestWrapper(request);
        byte[] body = StreamUtils.copyToByteArray(wrapped.getInputStream());
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

    private static final class CachedBodyRequestWrapper extends jakarta.servlet.http.HttpServletRequestWrapper {
        private final byte[] cached;

        CachedBodyRequestWrapper(HttpServletRequest request) throws IOException {
            super(request);
            this.cached = StreamUtils.copyToByteArray(request.getInputStream());
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
