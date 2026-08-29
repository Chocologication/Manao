package com.manao.poc4.kubernetes;

import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.dsl.ExecWatch;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Fabric8 pods/exec transport for the PTY bridge; the wrapper command is fixed server-side. */
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
        ExecWatch watch = client.pods().inNamespace(namespace).withName(podName)
            .redirectingInput()
            .redirectingOutput()
            .redirectingError()
            .withTTY()
            .exec(command.toArray(new String[0]));
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
