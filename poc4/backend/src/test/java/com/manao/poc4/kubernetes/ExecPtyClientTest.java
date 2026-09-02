package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import com.manao.poc4.terminal.PtyBridge;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class ExecPtyClientTest {
    @Test
    void bridgesBinaryOutputWithBytePreservationAndReportsExit() throws Exception {
        byte[] payload = new byte[1024];
        for (int i = 0; i < payload.length; i++) payload[i] = (byte) (i % 251);
        FakeProcess process = new FakeProcess(payload, 0);
        FakeTransport transport = new FakeTransport(process);
        ExecPtyClient client = new ExecPtyClient(transport, List.of("/usr/local/bin/manao-pty-wrapper"));

        AtomicReference<byte[]> received = new AtomicReference<>();
        AtomicReference<Integer> exitCode = new AtomicReference<>();
        PtyBridge.PtyListener listener = new PtyBridge.PtyListener() {
            @Override public void onOutput(byte[] bytes) { received.set(bytes); }
            @Override public void onExit(Integer code) { exitCode.set(code); }
        };
        PtyBridge.PtyHandle handle = client.open("manao-run-1-pod", "maven", 80, 24, listener);

        assertThat(transport.podName).isEqualTo("manao-run-1-pod");
        assertThat(transport.containerName).isEqualTo("maven");
        assertThat(transport.command).containsExactly("/usr/local/bin/manao-pty-wrapper");
        process.complete();
        handle.close();
        long deadline = System.currentTimeMillis() + 5000;
        while (exitCode.get() == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(10);
        }
        assertThat(exitCode.get()).isZero();
        assertThat(received.get()).containsExactly(payload);
    }

    @Test
    void writesFlowToTheProcessStdin() throws Exception {
        FakeProcess process = new FakeProcess(new byte[0], 0);
        ExecPtyClient client = new ExecPtyClient(new FakeTransport(process), List.of("wrapper"));
        PtyBridge.PtyHandle handle = client.open("pod", "maven", 80, 24, new PtyBridge.PtyListener() {
            @Override public void onOutput(byte[] bytes) { }
            @Override public void onExit(Integer code) { }
        });
        handle.write("ls\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThat(process.stdinCapture.toByteArray()).isEqualTo("ls\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        handle.resize(120, 40);
        assertThat(process.resizes).containsExactly("120x40");
    }

    static final class FakeTransport implements ExecTransport {
        private final FakeProcess process;
        List<String> command;
        String podName;
        String containerName;

        FakeTransport(FakeProcess process) { this.process = process; }

        @Override public ExecProcess exec(String podName, String containerName, List<String> command,
                                          int cols, int rows, boolean pty) {
            this.podName = podName;
            this.containerName = containerName;
            this.command = List.copyOf(command);
            return process;
        }
    }

    static final class FakeProcess implements ExecTransport.ExecProcess {
        private final byte[] output;
        private final int exitCode;
        private final ByteArrayOutputStream stdinCapture = new ByteArrayOutputStream();
        private final List<String> resizes = new ArrayList<>();
        private volatile boolean completed = true;
        private final InputStream stdout = new InputStream() {
            private int position;
            @Override public int read() {
                if (!completed || position >= output.length) return -1;
                return output[position++] & 0xff;
            }
        };

        FakeProcess(byte[] output, int exitCode) {
            this.output = output;
            this.exitCode = exitCode;
        }

        void complete() { completed = true; }

        @Override public OutputStream stdin() { return stdinCapture; }
        @Override public InputStream stdout() { return stdout; }
        @Override public InputStream stderr() { return new ByteArrayInputStream(new byte[0]); }
        @Override public void resize(int cols, int rows) { resizes.add(cols + "x" + rows); }
        @Override public void close() { completed = true; }
        @Override public Integer waitFor(long timeout, TimeUnit unit) {
            return completed ? exitCode : null;
        }
    }
}
