package com.manao.poc4.ai;

import com.manao.poc4.api.ApiError;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * The internal worker routes' request-body bound: a request whose declared body
 * exceeds the fixed limit is refused before any effect with the fixed safe error
 * {@code AI_REQUEST_TOO_LARGE} (413); a body that overruns while being streamed (no
 * usable Content-Length) reads as exhausted so the payload binding fails with the
 * fixed validation error instead of a handler crash. No header, endpoint or internal
 * detail is ever echoed.
 */
public final class InternalBodyLimitFilter extends jakarta.servlet.http.HttpFilter {

    /** Generous above the bounded tool envelope (192 KiB) and any 8 KiB progress item. */
    static final long DEFAULT_LIMIT_BYTES = 512L * 1024;

    private static final ObjectMapper JSON = new ObjectMapper();
    private final long limitBytes;

    public InternalBodyLimitFilter() {
        this(DEFAULT_LIMIT_BYTES);
    }

    InternalBodyLimitFilter(long limitBytes) {
        this.limitBytes = limitBytes;
    }

    @Override protected void doFilter(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
        throws IOException, ServletException {
        String declared = request.getHeader("Content-Length");
        if (declared != null) {
            try {
                if (Long.parseLong(declared) > limitBytes) {
                    writeTooLarge(response);
                    return;
                }
            } catch (NumberFormatException ignored) {
                // An unreadable length is handled by the container; the streaming
                // bound below still applies.
            }
        }
        chain.doFilter(new LimitedBodyRequest(request), response);
    }

    private void writeTooLarge(HttpServletResponse response) throws IOException {
        response.setStatus(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
        response.setContentType("application/json");
        response.getWriter().write(JSON.writeValueAsString(
            new ApiError("AI_REQUEST_TOO_LARGE", "The request body exceeds the bounded size", null).toMap()));
    }

    /** Counts streamed bytes against the bound; past it the body reads as exhausted. */
    private final class LimitedBodyRequest extends HttpServletRequestWrapper {

        private LimitedBodyRequest(HttpServletRequest delegate) {
            super(delegate);
        }

        @Override public ServletInputStream getInputStream() throws IOException {
            ServletInputStream source = super.getInputStream();
            return new CountingInputStream(source);
        }

        private final class CountingInputStream extends ServletInputStream {
            private final ServletInputStream source;
            private long remaining = limitBytes;
            private boolean overrun;

            private CountingInputStream(ServletInputStream source) {
                this.source = source;
            }

            @Override public boolean isFinished() {
                return overrun || source.isFinished();
            }

            @Override public boolean isReady() {
                return source.isReady();
            }

            @Override public void setReadListener(ReadListener listener) {
                source.setReadListener(listener);
            }

            @Override public int read() throws IOException {
                if (!spend()) {
                    return -1;
                }
                return source.read();
            }

            @Override public int read(byte[] buffer, int offset, int length) throws IOException {
                if (!spend()) {
                    return -1;
                }
                return source.read(buffer, offset, (int) Math.min(length, remaining));
            }

            /** False once the bound is hit: the body reads as exhausted from there on. */
            private boolean spend() {
                if (overrun) {
                    return false;
                }
                if (remaining == 0) {
                    overrun = true;
                    return false;
                }
                remaining--;
                return true;
            }
        }
    }
}
