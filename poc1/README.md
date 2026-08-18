# Manao POC1

POC1 verifies the core path from `HTTP POST /run` to a Kubernetes Job that compiles and runs user Java code.

## Run Locally

Prerequisites:

- JDK 17
- A reachable Kubernetes cluster from POC0
- `KUBECONFIG` pointing to the cluster config, or in-cluster Kubernetes credentials

Start the service:

```powershell
& 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.11-bin\6mqf5t809d9geo83kj4ttckcbc\apache-maven-3.9.11\bin\mvn.cmd' spring-boot:run
```

Call the API:

```powershell
$body = @{
  code = 'public class Main { public static void main(String[] args) { System.out.println("Hello World"); } }'
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri http://localhost:8080/run -ContentType 'application/json' -Body $body
```

Expected response:

```json
{
  "stdout": "Hello World\n",
  "stderr": "",
  "exitCode": 0,
  "jobName": "java-run-..."
}
```

## Configuration

Environment variables:

- `MANAO_POC1_NAMESPACE`: Kubernetes namespace, defaults to `default`
- `MANAO_POC1_IMAGE`: Java runner image, defaults to `eclipse-temurin:17-jdk`
- `MANAO_POC1_TIMEOUT`: Job wait timeout, defaults to `30s`
- `MANAO_POC1_CLEANUP`: whether to delete Job and ConfigMap after reading logs, defaults to `true`

## Validation Goal

POC1 is considered passed when a browser or HTTP client can call `/run` and receive `Hello World` stdout within 30 seconds.
