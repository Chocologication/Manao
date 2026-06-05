# POC2 Realtime Log Stream Design

## Goal

Create an independent `poc2` Spring Boot proof of concept that validates real-time Kubernetes Job logs over WebSocket.

## Scope

- Create a new Maven project under `poc2`.
- Keep POC1 unchanged.
- Accept Java source code over WebSocket at `/ws/run`.
- Create a Kubernetes ConfigMap and Job from the submitted code.
- Stream Pod logs line by line to the WebSocket client using Fabric8 `watchLog()`.
- Send a final `exit` message with the Job exit code.
- Provide both browser HTML and PowerShell verification clients.

## Architecture

The application exposes one WebSocket endpoint on port `8081`. When a client connects and sends a JSON payload containing `code`, the server starts a run session. The run session creates a ConfigMap, creates a Job, waits for the Job Pod, streams logs from that Pod, waits for Job completion, sends an `exit` event, and then optionally cleans up Kubernetes resources.

The implementation stays close to POC1's proven resource model: code is mounted from ConfigMap at `/code`, copied to writable `/workspace`, compiled with `javac`, and run with `java Main`.

## Message Contract

Client request:

```json
{"code":"public class Main { public static void main(String[] args) { System.out.println(\"Hello World\"); } }"}
```

Server events:

```json
{"type":"status","jobName":"java-run-abc123","message":"job-created"}
{"type":"log","jobName":"java-run-abc123","message":"Hello World"}
{"type":"exit","jobName":"java-run-abc123","code":0}
{"type":"error","jobName":"java-run-abc123","message":"..."}
```

## Configuration

- `server.port`: defaults to `8081`
- `MANAO_POC2_NAMESPACE`: defaults to `default`
- `MANAO_POC2_IMAGE`: defaults to `eclipse-temurin:17-jdk`
- `MANAO_POC2_TIMEOUT`: defaults to `180s`
- `MANAO_POC2_CLEANUP`: defaults to `true`

## Testing

Unit tests cover:

- WebSocket request validation.
- JSON event serialization.
- Log line splitting.
- Kubernetes ConfigMap and Job resource generation.
- Run service event ordering with fake dependencies.

Manual verification covers:

- `mvn test`
- `mvn -DskipTests compile`
- Start the app with `KUBECONFIG=C:\Users\shili\.kube\config`.
- Run the PowerShell WebSocket client and verify streamed `log` plus final `exit`.
- Open the HTML client and verify the same behavior.
