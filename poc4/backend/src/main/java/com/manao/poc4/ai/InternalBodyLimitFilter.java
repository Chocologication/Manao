package com.manao.poc4.ai;

import com.manao.poc4.api.ApiError;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * The internal worker routes' request-body bound. The body is pre-read against the
 * fixed limit HERE — before any handler runs — so an oversized request is refused
 * with the fixed safe error {@code AI_REQUEST_TOO_LARGE} (413) whether its
 * Content-Length declared the size honestly, lied, or was absent entirely: counting
 * by the actual bytes read (never by the declaration or by read-call counts) closes
 * the "valid JSON followed by padding" bypass. No header, endpoint or internal
 * detail is ever echoed, and the pre-read bound (well above the 192 KiB tool
 * envelope) keeps the buffered body small.
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
        long requestLimit = request.getRequestURI().matches("/internal/ai/tasks/[^/]+/context")
            || request.getRequestURI().matches("/internal/ai/conversations/[^/]+/compactions/[^/]+/result")
            ? AgentConversationStore.CONTEXT_LIMIT : limitBytes;
        String declared = request.getHeader("Content-Length");
        if (declared != null) {
            try {
                if (Long.parseLong(declared) > requestLimit) {
                    writeTooLarge(response);
                    return;
                }
            } catch (NumberFormatException ignored) {
                // A lying or unreadable declaration changes nothing: the streamed
                // pre-read below counts the real bytes.
            }
        }
        // Pre-read against the bound. null means the real bytes exceeded the limit:
        // refuse immediately, before the request reaches any handler.
        byte[] body = readBounded(request.getInputStream(), requestLimit);
        if (body == null) {
            writeTooLarge(response);
            return;
        }
        chain.doFilter(new CachedBodyRequest(request, body), response);
    }

    private void writeTooLarge(HttpServletResponse response) throws IOException {
        response.setStatus(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
        response.setContentType("application/json");
        response.getWriter().write(JSON.writeValueAsString(
            new ApiError("AI_REQUEST_TOO_LARGE", "The request body exceeds the bounded size", null).toMap()));
    }

    /** The exact body bytes, or null once the real byte count exceeded the bound. */
    private byte[] readBounded(jakarta.servlet.ServletInputStream source, long requestLimit) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        long total = 0;
        int read;
        while ((read = source.read(chunk)) != -1) {
            total += read;
            if (total > requestLimit) {
                return null;
            }
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }

    /** Serves the pre-read, bounded body; every consumer sees the same bytes. */
    private static final class CachedBodyRequest extends HttpServletRequestWrapper {
        private final byte[] body;

        private CachedBodyRequest(HttpServletRequest delegate, byte[] body) {
            super(delegate);
            this.body = body;
        }

        @Override public int getContentLength() {
            return body.length;
        }

        @Override public long getContentLengthLong() {
            return body.length;
        }

        @Override public ServletInputStream getInputStream() {
            ByteArrayInputStream source = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override public boolean isFinished() {
                    return source.available() == 0;
                }

                @Override public boolean isReady() {
                    return true;
                }

                @Override public void setReadListener(ReadListener listener) {
                    throw new IllegalStateException("async reads are not supported on the internal routes");
                }

                @Override public int read() {
                    return source.read();
                }
            };
        }
    }
}
