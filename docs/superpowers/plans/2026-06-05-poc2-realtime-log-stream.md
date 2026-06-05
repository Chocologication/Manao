# POC2 Realtime Log Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independent `poc2` Spring Boot app that streams Kubernetes Job logs over WebSocket.

**Architecture:** The app accepts one WebSocket message containing Java source code, creates a Kubernetes Job, follows Pod logs with Fabric8 `watchLog()`, and emits JSON events to the WebSocket session. Verification is available through README instructions, an HTML client, and a PowerShell client.

**Tech Stack:** Java 17, Maven, Spring Boot 3.5.9, Spring WebSocket, Fabric8 Kubernetes Client 7.7.0, JUnit 5, Mockito.

---

### Task 1: Project Skeleton

**Files:**
- Create: `poc2/pom.xml`
- Create: `poc2/src/main/java/com/manao/poc2/Poc2Application.java`
- Create: `poc2/src/main/java/com/manao/poc2/Poc2Properties.java`
- Create: `poc2/src/main/resources/application.yml`

- [ ] **Step 1: Create Maven project files**

Use Spring Boot parent `3.5.9`, Java `17`, Fabric8 `7.7.0`, and dependencies: validation, web, websocket, kubernetes-client, starter-test.

- [ ] **Step 2: Create application and properties classes**

Use `@SpringBootApplication`, `@EnableConfigurationProperties(Poc2Properties.class)`, and a `record Poc2Properties(String namespace, String image, Duration timeout, boolean cleanup)`.

- [ ] **Step 3: Run compile**

Run: `& 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.11-bin\6mqf5t809d9geo83kj4ttckcbc\apache-maven-3.9.11\bin\mvn.cmd' -q -DskipTests compile`

Expected: exit code 0.

### Task 2: Event and Request Model

**Files:**
- Create: `poc2/src/main/java/com/manao/poc2/run/RunRequest.java`
- Create: `poc2/src/main/java/com/manao/poc2/run/RunEvent.java`
- Create: `poc2/src/main/java/com/manao/poc2/run/RunEventJson.java`
- Test: `poc2/src/test/java/com/manao/poc2/run/RunEventJsonTest.java`

- [ ] **Step 1: Write failing serialization tests**

Test that `log`, `exit`, and `error` events serialize to stable JSON fields.

- [ ] **Step 2: Run test and verify RED**

Run: `mvn -q -Dtest=RunEventJsonTest test`

Expected: compilation failure because classes do not exist.

- [ ] **Step 3: Implement request and event records**

`RunRequest` has `@NotBlank String code`. `RunEvent` has `type`, `jobName`, `message`, and `Integer code`, with static factories.

- [ ] **Step 4: Implement JSON serializer**

Use Jackson `ObjectMapper.writeValueAsString`.

- [ ] **Step 5: Run test and verify GREEN**

Run: `mvn -q -Dtest=RunEventJsonTest test`

Expected: pass.

### Task 3: Kubernetes Resource Factory

**Files:**
- Create: `poc2/src/main/java/com/manao/poc2/run/KubernetesRunResourceFactory.java`
- Test: `poc2/src/test/java/com/manao/poc2/run/KubernetesRunResourceFactoryTest.java`

- [ ] **Step 1: Write failing resource tests**

Test ConfigMap contains `Main.java`; Job uses label `manao.dev/run-id`, restart policy `Never`, image from config, command copies code to workspace and runs `javac Main.java && java Main`, and has TTL 300.

- [ ] **Step 2: Run test and verify RED**

Run: `mvn -q -Dtest=KubernetesRunResourceFactoryTest test`

Expected: compilation failure because factory does not exist.

- [ ] **Step 3: Implement factory**

Port POC1's factory into package `com.manao.poc2.run`.

- [ ] **Step 4: Run test and verify GREEN**

Run: `mvn -q -Dtest=KubernetesRunResourceFactoryTest test`

Expected: pass.

### Task 4: Log Streaming Abstractions

**Files:**
- Create: `poc2/src/main/java/com/manao/poc2/run/RunEventSink.java`
- Create: `poc2/src/main/java/com/manao/poc2/run/PodLogStreamer.java`
- Create: `poc2/src/main/java/com/manao/poc2/run/Fabric8PodLogStreamer.java`
- Create: `poc2/src/main/java/com/manao/poc2/run/LogLineEmitter.java`
- Test: `poc2/src/test/java/com/manao/poc2/run/LogLineEmitterTest.java`

- [ ] **Step 1: Write failing log splitting tests**

Test that mixed `\n` and `\r\n` logs emit non-empty ordered lines and ignore trailing empty lines.

- [ ] **Step 2: Run test and verify RED**

Run: `mvn -q -Dtest=LogLineEmitterTest test`

Expected: compilation failure because `LogLineEmitter` does not exist.

- [ ] **Step 3: Implement sink and line emitter**

`RunEventSink` has `send(RunEvent event)`. `LogLineEmitter.emitLines(jobName, chunk, sink)` splits lines.

- [ ] **Step 4: Implement Fabric8 streamer**

Use `client.pods().inNamespace(namespace).withName(podName).watchLog()`, read `watch.getOutput()` with `BufferedReader`, and emit `log` events per line. Use try-with-resources to close `LogWatch`.

- [ ] **Step 5: Run test and verify GREEN**

Run: `mvn -q -Dtest=LogLineEmitterTest test`

Expected: pass.

### Task 5: Run Orchestration Service

**Files:**
- Create: `poc2/src/main/java/com/manao/poc2/run/RunFailedException.java`
- Create: `poc2/src/main/java/com/manao/poc2/run/StreamingCodeRunner.java`
- Create: `poc2/src/main/java/com/manao/poc2/run/KubernetesStreamingCodeRunner.java`
- Create: `poc2/src/main/java/com/manao/poc2/run/KubernetesClientConfig.java`
- Test: `poc2/src/test/java/com/manao/poc2/run/KubernetesStreamingCodeRunnerTest.java`

- [ ] **Step 1: Write failing orchestration test**

Use Mockito to verify the runner sends `status(job-created)`, streams logs through `PodLogStreamer`, sends `exit` code 0 when Job succeeded, and calls cleanup when enabled.

- [ ] **Step 2: Run test and verify RED**

Run: `mvn -q -Dtest=KubernetesStreamingCodeRunnerTest test`

Expected: compilation failure because runner does not exist.

- [ ] **Step 3: Implement runner**

Create ConfigMap and Job, find the Pod by run label, stream logs, wait for completion, derive exit code from Job status, send final `exit`, catch Kubernetes exceptions into `error` event and `RunFailedException`, cleanup in `finally`.

- [ ] **Step 4: Run test and verify GREEN**

Run: `mvn -q -Dtest=KubernetesStreamingCodeRunnerTest test`

Expected: pass.

### Task 6: WebSocket Endpoint

**Files:**
- Create: `poc2/src/main/java/com/manao/poc2/ws/RunWebSocketConfig.java`
- Create: `poc2/src/main/java/com/manao/poc2/ws/RunWebSocketHandler.java`
- Test: `poc2/src/test/java/com/manao/poc2/ws/RunWebSocketHandlerTest.java`

- [ ] **Step 1: Write failing WebSocket handler tests**

Test blank code sends `error`; valid code delegates to `StreamingCodeRunner`; malformed JSON sends `error`.

- [ ] **Step 2: Run test and verify RED**

Run: `mvn -q -Dtest=RunWebSocketHandlerTest test`

Expected: compilation failure because handler does not exist.

- [ ] **Step 3: Implement handler and config**

Register `/ws/run` with allowed origins `*`. Parse request JSON with Jackson. Run the blocking Kubernetes work on a single `TaskExecutor` so WebSocket I/O thread is not blocked.

- [ ] **Step 4: Run test and verify GREEN**

Run: `mvn -q -Dtest=RunWebSocketHandlerTest test`

Expected: pass.

### Task 7: Verification Clients and README

**Files:**
- Create: `poc2/src/test/resources/ws-client.html`
- Create: `poc2/scripts/run-ws-client.ps1`
- Create: `poc2/README.md`

- [ ] **Step 1: Create HTML client**

The page connects to `ws://localhost:8081/ws/run`, sends sample Java code, appends each event to a `<pre>`, and supports editing the code before run.

- [ ] **Step 2: Create PowerShell client**

Use `System.Net.WebSockets.ClientWebSocket` to connect, send sample code, and print incoming messages until `type` is `exit` or `error`.

- [ ] **Step 3: Create README**

Document prerequisites, config, start command, HTML validation, PowerShell validation, expected event sequence, and cleanup behavior.

### Task 8: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run all tests**

Run: `mvn -q test`

Expected: all tests pass.

- [ ] **Step 2: Compile**

Run: `mvn -q -DskipTests compile`

Expected: exit code 0.

- [ ] **Step 3: Start app and run PowerShell validation**

Set `KUBECONFIG=C:\Users\shili\.kube\config`, start Spring Boot on 8081, run `scripts/run-ws-client.ps1`, and verify at least one `log` event containing `Hello from POC2` and a final `exit` event with `code: 0`.

- [ ] **Step 4: Verify cleanup**

Run `kubectl --kubeconfig C:\Users\shili\.kube\config get jobs,pods,configmaps -n default --show-labels | Select-String java-run`.

Expected: no POC2 `java-run` resources remain when cleanup is true.
