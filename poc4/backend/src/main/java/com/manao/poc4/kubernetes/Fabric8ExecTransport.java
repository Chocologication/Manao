package com.manao.poc4.kubernetes;

import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.dsl.ExecWatch;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Fabric8 pods/exec transport. The container is honored so every caller execs into exactly the
 * container it verified, and the pty flag decides between the TTY-wrapped PTY bridge and a clean
 * non-TTY stream (the bounded fixed-command reads must not get CRLF-mangled output).
 */
public final class Fabric8ExecTransport implements ExecTransport {
    private final KubernetesClient client;
    private final String namespace;

    public Fabric8ExecTransport(KubernetesClient client, String namespace) {
        this.client = client;
        this.namespace = namespace;
    }

    @Override
    public ExecProcess exec(String podName, String containerName, List<String> command, int cols, int rows,
                            boolean pty) {
        var exec = client.pods().inNamespace(namespace).withName(podName)
            .inContainer(containerName)
            .redirectingInput()
            .redirectingOutput()
            .redirectingError();
        ExecWatch watch = pty ? exec.withTTY().exec(command.toArray(new String[0]))
            : exec.exec(command.toArray(new String[0]));
        return new ExecProcess() {
            @Override public OutputStream stdin() { return watch.getInput(); }
            @Override public InputStream stdout() { return watch.getOutput(); }
            @Override public InputStream stderr() { return watch.getError(); }
            @Override public void resize(int newCols, int newRows) { watch.resize(newCols, newRows); }
            @Override public void close() { watch.close(); }
            @Override public Integer waitFor(long timeout, TimeUnit unit) {
                try {
                    return watch.exitCode().get(timeout, unit);
                } catch (Exception ex) {
                    return null;
                }
            }
        };
    }
}
