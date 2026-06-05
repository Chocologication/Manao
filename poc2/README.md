# Manao POC2

POC2 verifies real-time Kubernetes Job logs over WebSocket.

## Prerequisites

- JDK 17
- Maven 3.9.x
- A reachable Kubernetes cluster
- `C:\Users\shili\.kube\config` or another valid kubeconfig

## Configuration

Environment variables:

- `KUBECONFIG`: Kubernetes config path
- `MANAO_POC2_NAMESPACE`: Kubernetes namespace, defaults to `default`
- `MANAO_POC2_IMAGE`: Java runner image, defaults to `eclipse-temurin:17-jdk`
- `MANAO_POC2_TIMEOUT`: Job wait timeout, defaults to `180s`
- `MANAO_POC2_CLEANUP`: whether to delete Job and ConfigMap after completion, defaults to `true`

The service listens on port `8081`.

## Start

```powershell
$env:KUBECONFIG = 'C:\Users\shili\.kube\config'
& 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.11-bin\6mqf5t809d9geo83kj4ttckcbc\apache-maven-3.9.11\bin\mvn.cmd' spring-boot:run
```

## Validate With PowerShell

In another PowerShell window:

```powershell
.\scripts\run-ws-client.ps1
```

Expected output includes ordered events similar to:

```json
{"type":"status","jobName":"java-run-...","message":"job-created"}
{"type":"status","jobName":"java-run-...","message":"pod-found"}
{"type":"log","jobName":"java-run-...","message":"Hello from POC2 1"}
{"type":"log","jobName":"java-run-...","message":"Hello from POC2 2"}
{"type":"log","jobName":"java-run-...","message":"Hello from POC2 3"}
{"type":"exit","jobName":"java-run-...","code":0}
```

## Validate With Browser

Open:

```text
src/test/resources/ws-client.html
```

Keep the default URL `ws://localhost:8081/ws/run`, edit the sample Java code if needed, and click `Run`.

## Build And Test

```powershell
& 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.11-bin\6mqf5t809d9geo83kj4ttckcbc\apache-maven-3.9.11\bin\mvn.cmd' test
& 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.11-bin\6mqf5t809d9geo83kj4ttckcbc\apache-maven-3.9.11\bin\mvn.cmd' -DskipTests compile
```

## Cleanup Check

When `MANAO_POC2_CLEANUP=true`, the app deletes its Job and ConfigMap after reading logs.

```powershell
kubectl --kubeconfig C:\Users\shili\.kube\config get jobs,pods,configmaps -n default --show-labels | Select-String java-run
```
