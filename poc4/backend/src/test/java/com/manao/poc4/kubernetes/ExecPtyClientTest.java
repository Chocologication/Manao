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
        long deadline = System.currentTimeMillis() + 5000;
        while (received.get() == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(10);
        }
        assertThat(received.get()).containsExactly(payload);
        handle.close();
        while (exitCode.get() == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(10);
        }
        assertThat(exitCode.get()).isZero();
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
        long deadline = System.currentTimeMillis() + 2000;
        while (process.stdinCapture.size() == 0 && System.currentTimeMillis() < deadline) {
            Thread.sleep(10);
        }
        assertThat(process.stdinCapture.toByteArray()).isEqualTo("ls\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        handle.resize(120, 40);
        assertThat(process.resizes).containsExactly("120x40");
    }

    @Test
    void writeDoesNotBlockTheCallerWhenStdinIsBackpressured() throws Exception {
        java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicInteger writables = new java.util.concurrent.atomic.AtomicInteger();
        OutputStream blocking = new OutputStream() {
            @Override public void write(int ignored) { }
            @Override public void write(byte[] bytes, int off, int len) {
                entered.countDown();
                try {
                    if (!release.await(5, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("stdin was never released");
                    }
                } catch (InterruptedException ex) {
                    Thread.currentThread().interrupt();
                }
            }
        };
        FakeProcess process = new FakeProcess(new byte[0], 0, blocking);
        ExecPtyClient client = new ExecPtyClient(new FakeTransport(process), List.of("wrapper"));
        PtyBridge.PtyHandle handle = client.open("pod", "maven", 80, 24, new PtyBridge.PtyListener() {
            @Override public void onOutput(byte[] bytes) { }
            @Override public void onExit(Integer code) { }
            @Override public void onWritable() { writables.incrementAndGet(); }
        });
        byte[] frame = new byte[16];
        assertThat(handle.write(frame)).isTrue();
        assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(handle.write(frame)).isTrue();
        long started = System.nanoTime();
        assertThat(handle.write(frame)).isFalse();
        assertThat(System.nanoTime() - started).isLessThan(TimeUnit.MILLISECONDS.toNanos(200));
        release.countDown();
        long writableDeadline = System.currentTimeMillis() + 2000;
        while (writables.get() == 0 && System.currentTimeMillis() < writableDeadline) {
            Thread.sleep(10);
        }
        assertThat(writables.get()).isGreaterThanOrEqualTo(1);
        handle.close();
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
        private volatile boolean completed;
        private final InputStream stdout = new InputStream() {
            private int position;
            @Override public synchronized int read() {
                byte[] one = new byte[1];
                int n = read(one, 0, 1);
                return n <= 0 ? -1 : (one[0] & 0xff);
            }
            @Override public synchronized int read(byte[] buffer, int offset, int length) {
                if (position < output.length) {
                    int n = Math.min(length, output.length - position);
                    System.arraycopy(output, position, buffer, offset, n);
                    position += n;
                    return n;
                }
                while (!completed) {
                    try {
                        wait(50);
                    } catch (InterruptedException ex) {
                        Thread.currentThread().interrupt();
                        return -1;
                    }
                }
                return -1;
            }
        };

        private final OutputStream stdin;

        FakeProcess(byte[] output, int exitCode) {
            this(output, exitCode, null);
        }

        FakeProcess(byte[] output, int exitCode, OutputStream stdin) {
            this.output = output;
            this.exitCode = exitCode;
            this.stdin = stdin;
        }

        void complete() {
            completed = true;
            synchronized (stdout) { stdout.notifyAll(); }
        }

        @Override public OutputStream stdin() { return stdin == null ? stdinCapture : stdin; }
        @Override public InputStream stdout() { return stdout; }
        @Override public InputStream stderr() { return new ByteArrayInputStream(new byte[0]); }
        @Override public void resize(int cols, int rows) { resizes.add(cols + "x" + rows); }
        @Override public void close() {
            completed = true;
            synchronized (stdout) { stdout.notifyAll(); }
        }
        @Override public Integer waitFor(long timeout, TimeUnit unit) {
            return completed ? exitCode : null;
        }
    }
}
