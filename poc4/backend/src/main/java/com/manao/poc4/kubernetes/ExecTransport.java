package com.manao.poc4.kubernetes;

import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Low-level exec seam so the PTY adapter can be tested without a live cluster. */
public interface ExecTransport {
    ExecProcess exec(String podName, String containerName, List<String> command, int cols, int rows, boolean pty);

    interface ExecProcess {
        OutputStream stdin();

        InputStream stdout();

        InputStream stderr();

        void resize(int cols, int rows);

        void close();

        Integer waitFor(long timeout, TimeUnit unit);
    }
}
