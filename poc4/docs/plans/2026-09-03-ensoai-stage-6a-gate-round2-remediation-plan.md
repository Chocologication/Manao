> **历史来源 / 2026-09-17 已被现行记录取代：** 当前 6A 范围、验收决定和证据以[唯一现行事实现状](../../../../../docs/Stage6A-Current-Facts.md)为准。下文保留原时点的设计、计划和结果；其中“当前”、待实施、FAILED/不允许 6B 等只描述旧时点，不覆盖本次用户验收决定，也不自动授权重新执行。原始结果不改写。此链接指向主检出的单份文档，不复制第二份现状。

# 阶段六 6A 决策门第二轮修复实施计划（探针冷启动 / bridge 监听 / E2E 覆盖 / 证据绑定）

> **面向 Agent 执行者：** 使用 superpower-subagent-driven-development 按任务逐项执行本计划（AgentTeams：implementer2=deepseek-v4-flash+max 实现，reviewer1=deepseek-v4-pro+max 评审，fixer1=deepseek-v4-pro+high 备用）。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 修复 6A gate 复跑审查确认的四项阻断（workspace-agent 探针冷启动误杀、bridge 无真实监听验证、证据 SHA 过期、真实 E2E 覆盖不足），并更新证据文档绑定新 HEAD。

**架构：** 两处后端修复（K8s 探针模板、bridge 存活语义）+ 两处前端测试资产（stress/faults spec）+ 一轮证据文档重写；全部为 6A 本机后端代码路径，不创建或部署任何 6B 资源。

**技术栈：** Java 17 / Spring Boot / Fabric8 Kubernetes Client、JUnit 5 + AssertJ、Playwright 1.62、pnpm。

**规格：**
- `poc4/docs/2026-08-27-ensoai-stage-6-real-backend-kubernetes-design.md`（§8.1 探针条款、§11/§12 E2E 验收）
- `poc4/docs/plans/2026-08-27-ensoai-stage-6-real-backend-kubernetes-implementation-plan.md`（Task 9A/10/11）
- 6A gate 复跑审查报告（四项阻断，已由三个只读子代理逐条核实）

## 全局约束

- 工作树：`D:DeepLearningMyProjectsProject_Manao.worktreeensoai-stage-6-real-backend-kubernetes`，分支 `codex/poc4-stage-6-real-backend-kubernetes`。
- **禁止提交**：`AGENTS.md`（用户自改）、`poc4/backend/fix13.py`（未跟踪临时文件）、`.grok/`。
- 所有新增/修改文本文件 UTF-8 无 BOM；提交前 `git diff --check` 必须干净。
- 后端测试用仓库 Maven：`C:Usersshili.m2wrapperdistsapache-maven-3.9.14ed7edd442f634ac1c1ef5ba2b61b6d690b5221091f1a8e1123f5fadcc967520dinmvn.cmd`（下文写作 `mvn`）。
- 不削弱任何既有安全约束：镜像必须 immutable digest、探针只打 `/agent/v1/healthz:8080`、bridge 端口仍限 18100–18199 loopback、服务名/端口仍仅服务端派生。
- 每个任务独立提交，提交信息按任务步骤给出。
- 不得运行 `pnpm install`/依赖变更；新增 package.json 脚本只允许追加，不得改动既有脚本。

---

## 背景：根因分析（systematic-debugging 阶段一至三结论）

三只读子代理核实（未改任何文件）确认审查报告四项描述属实；根因如下：

1. **探针冷启动误杀（P0）**：`WorkspaceResourceFactory.createWorkspacePod` 生成 liveness `initialDelaySeconds=5`、readiness `initialDelaySeconds=3` 且**无 startupProbe**。workspace-agent 是 Spring Boot JVM，冷启动超过 5 秒（集群事件实证：~3s readiness connection refused、~5s 被 liveness 杀掉；独立手工 Pod 用 readiness 30s/liveness 40s 成功 Ready 佐证）。K8s 语义：无 startupProbe 时 liveness 从容器启动即计时，Java 未起完即被判死。**修复方向**：加 startupProbe（窗口 5+5×24=125s）先行门控，liveness/readiness 在 startup 成功后才开始判定（与 design.md:320 条款同构；该条款虽位于 6B 后端小节，本计划将 workspace Pod 的等价要求补写入设计文档，消除范围错配）。
2. **bridge 无真实监听验证（P0）**：Fabric8 `LocalPortForward.isAlive()` 只反映对象状态，不验证本地端口真实监听（此前实测：alive=true 而 18100–18199 无监听）；supervised 模式 `ALWAYS_ALIVE` 占位恒真。design.md:330/373/409 与 plan.md:544 要求"进程退出即标记依赖不可用并重建原映射"。**修复方向**：`PortForwardProcess` 增加 `isListening()`（loopback TCP connect 探测）；`checkChildren()/allocate()` 对"存活但不监听"同样重建；supervised 模式用带端口的 supervisedProcess 如实上报监听状态。
3. **证据 SHA 过期（P1）**：`6a-gate.md` 标注 96810d2（HEAD），实际 HEAD=cd53a18（其后仅 gate 文档自身，无代码漂移）；`6a-local-cluster-result.md` 记录更旧 ce550660。**修复方向**：证据轮重写并绑定修复后新 HEAD。
4. **E2E 覆盖不足（P1）**：stage6 仅 5 个基础用例；计划 Task 11(:661-662) 要求 `stage6-terminal-stress.spec.ts`、`stage6-faults.spec.ts`（当前不存在）。**修复方向**：本轮补写两个 spec（代码资产），执行验证在 6A gate 外部复跑（沙箱无法承载真实 bridge transport，已实证）。

## 裁决记录（Rulings，记入台账）

- R1：设计文档 startupProbe 条款（design.md:320）位于 6B 后端小节；本计划将其等价值补写为 workspace Pod 条款，而非修改 6B 小节。— 消除审查报告论据的范围错配。代价：若评审认为设计不可改，需回退该文档修改。
- R2：supervised 模式 bridge 无法在本 JVM 内重建（无 factory），如实上报监听状态并保持 checkChildren 为 no-op；重建责任在外部操作者。代价：监督进程失联时依赖错误持续到操作者修复，与设计"重建原映射"在 supervised 下由外部承担。
- R3：plan Task 11 的 `test:e2e:stage6:channels` 脚本与 `.env.cluster.example`/README 等 6B 证据资产不在本轮范围（6B 资源未部署前不得执行 Task 11 步骤 2+）。代价：channels 脚本延后到 Task 11。
- R4：stress/faults spec 中依赖操作者动作的故障（backend 重启、SSH 隧道丢失、bridge 丢失）用 `STAGE6_FAULT` 环境变量分阶段门控（未设置→skip；设置→执行对应断言），与 plan Task 11 step 4 "6A-only faults 记入 6A 证据"一致。代价：纯自动复跑不含这些故障断言，需操作者按 evidence 文档步骤注入。
- R5：计划存放路径沿用项目惯例 `poc4/docs/plans/`（而非技能默认 `docs/superpowers/plans/`）。代价：无。

---

## 任务 R2-1：workspace-agent 探针冷启动修复

**文件：**
- 修改：`poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspaceResourceFactory.java:187-194`
- 修改：`poc4/backend/src/test/java/com/manao/poc4/kubernetes/WorkspaceResourceFactoryTest.java`
- 修改：`poc4/workspace-agent/deploy/workspace-agent.yaml:45-52`
- 修改：`poc4/docs/2026-08-27-ensoai-stage-6-real-backend-kubernetes-design.md`（workspace Pod 条款区，约 318-320 行之间插入一条）
- 若 `poc4/workspace-agent/src/test` 中存在断言探针的清单测试（grep `readinessProbe|startupProbe|livenessProbe`），一并修改该测试。

**接口：** 无对外接口变化；探针常量：startupProbe initialDelaySeconds=5、periodSeconds=5、failureThreshold=24、timeoutSeconds=2，路径 `/agent/v1/healthz`，端口 8080；liveness 5/10/3；readiness 3/5/3。

- [ ] **步骤 1：写失败测试**（`WorkspaceResourceFactoryTest` 新增方法，置于 `workspacePodMountsOnlyItsSubPathAndExposesNoPrivateKey` 之后）：

```java
    @Test
    void workspacePodProbesSurviveJavaColdStart() {
        Pod pod = factory.createWorkspacePod(PROJECT, "key");
        var container = pod.getSpec().getContainers().get(0);
        var startup = container.getStartupProbe();
        assertThat(startup).isNotNull();
        assertThat(startup.getHttpGet().getPath()).isEqualTo("/agent/v1/healthz");
        assertThat(startup.getHttpGet().getPort().getIntVal()).isEqualTo(8080);
        assertThat(startup.getInitialDelaySeconds()).isEqualTo(5);
        assertThat(startup.getPeriodSeconds()).isEqualTo(5);
        assertThat(startup.getFailureThreshold()).isEqualTo(24);
        assertThat(startup.getTimeoutSeconds()).isEqualTo(2);
        var liveness = container.getLivenessProbe();
        assertThat(liveness.getInitialDelaySeconds()).isEqualTo(5);
        assertThat(liveness.getPeriodSeconds()).isEqualTo(10);
        assertThat(liveness.getFailureThreshold()).isEqualTo(3);
        var readiness = container.getReadinessProbe();
        assertThat(readiness.getInitialDelaySeconds()).isEqualTo(3);
        assertThat(readiness.getPeriodSeconds()).isEqualTo(5);
        assertThat(readiness.getFailureThreshold()).isEqualTo(3);
    }
```

- [ ] **步骤 2：运行并确认失败**

运行：`mvn -B -Dtest=WorkspaceResourceFactoryTest test`（workdir `poc4/backend`）
预期：FAIL（`getStartupProbe()` 为 null 或字段断言失败）。

- [ ] **步骤 3：实现最小修复**（`WorkspaceResourceFactory.java` 将 187-194 行探针块整体替换为）：

```java
                .withNewStartupProbe()
                .withNewHttpGet().withPath("/agent/v1/healthz").withPort(new IntOrString(8080)).endHttpGet()
                .withInitialDelaySeconds(5).withPeriodSeconds(5).withFailureThreshold(24).withTimeoutSeconds(2)
                .endStartupProbe()
                .withNewLivenessProbe()
                .withNewHttpGet().withPath("/agent/v1/healthz").withPort(new IntOrString(8080)).endHttpGet()
                .withInitialDelaySeconds(5).withPeriodSeconds(10).withFailureThreshold(3)
                .endLivenessProbe()
                .withNewReadinessProbe()
                .withNewHttpGet().withPath("/agent/v1/healthz").withPort(new IntOrString(8080)).endHttpGet()
                .withInitialDelaySeconds(3).withPeriodSeconds(5).withFailureThreshold(3)
                .endReadinessProbe()
```

- [ ] **步骤 4：运行并确认通过**

运行：`mvn -B -Dtest=WorkspaceResourceFactoryTest test`（workdir `poc4/backend`）
预期：PASS（含既有 6 个用例）。

- [ ] **步骤 5：对齐参考清单**（`workspace-agent.yaml` 45-52 行替换为）：

```yaml
      startupProbe:
        httpGet:
          path: /agent/v1/healthz
          port: 8080
        initialDelaySeconds: 5
        periodSeconds: 5
        failureThreshold: 24
        timeoutSeconds: 2
      readinessProbe:
        httpGet:
          path: /agent/v1/healthz
          port: 8080
        initialDelaySeconds: 3
        periodSeconds: 5
        failureThreshold: 3
      livenessProbe:
        httpGet:
          path: /agent/v1/healthz
          port: 8080
        initialDelaySeconds: 5
        periodSeconds: 10
        failureThreshold: 3
```

若 `poc4/workspace-agent/src/test` 的清单测试断言了探针字段，先补 startupProbe 断言（TDD），再运行 `mvn -B -f poc4/workspace-agent/pom.xml test` 确认全绿。

- [ ] **步骤 6：补写设计条款**（design.md 在 workspace Pod 条款（约 318-320 行，含 `automountServiceAccountToken: false` 与 startupProbe 两条之间）插入一条，保持其前后文不动）：

```markdown
- workspace Pod 通过 startupProbe 避免冷启动误判：HTTP GET `/agent/v1/healthz`（8080），initialDelaySeconds 5、periodSeconds 5、failureThreshold 24、timeoutSeconds 2；liveness 只判断进程不可恢复失活，readiness 反映 HTTP 服务可用；liveness/readiness 在 startupProbe 成功后才开始判定。
```

- [ ] **步骤 7：提交**

```powershell
git add poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspaceResourceFactory.java poc4/backend/src/test/java/com/manao/poc4/kubernetes/WorkspaceResourceFactoryTest.java poc4/workspace-agent/deploy/workspace-agent.yaml poc4/docs/2026-08-27-ensoai-stage-6-real-backend-kubernetes-design.md
git commit -m "fix(poc4): gate workspace-agent probes behind startupProbe"
```

（若步骤 5 涉及 workspace-agent 测试文件，一并 `git add`。）

---

## 任务 R2-2：bridge 真实监听验证与重建

**文件：**
- 修改：`poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspacePortForwardManager.java`
- 修改：`poc4/backend/src/main/java/com/manao/poc4/config/LocalClusterConfig.java:131-140`
- 修改：`poc4/backend/src/test/java/com/manao/poc4/kubernetes/WorkspacePortForwardManagerTest.java`

**接口：** `PortForwardProcess` 新增 `boolean isListening()`；新增 `public static boolean isPortListening(int port)`（供 LocalClusterConfig 复用）；supervised 占位由 `ALWAYS_ALIVE` 常量改为 `supervisedProcess(int port)` 工厂方法（内部实现，不对外）。

- [ ] **步骤 1：写失败测试**（`WorkspacePortForwardManagerTest`：FakeProcess 增加 `listening` 字段，新增三个测试方法）：

```java
    static final class FakeProcess implements WorkspacePortForwardManager.PortForwardProcess {
        private final Runnable onKill;
        private volatile boolean alive = true;
        private volatile boolean listening = true;
        FakeProcess(Runnable onKill) { this.onKill = onKill; }
        void fail() { alive = false; }
        void stopListening() { listening = false; }
        @Override public boolean isAlive() { return alive; }
        @Override public boolean isListening() { return listening; }
        @Override public void kill() {
            if (alive) onKill.run();
            alive = false;
        }
    }
```

```java
    @Test
    void aliveButNonListeningProcessIsDetectedAndRecreated() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, factory);
        int port = manager.allocate("prj-a");
        factory.processes.get("manao-ws-prj-a:" + port).stopListening();

        manager.checkChildren();

        assertThat(factory.started).hasSize(2);
        assertThat(factory.started.get(1).localPort()).isEqualTo(port);
        assertThat(factory.started.get(1).serviceName()).isEqualTo("manao-ws-prj-a");
    }

    @Test
    void allocateRecreatesABridgeWhoseListenerWasLost() {
        RecordingFactory factory = new RecordingFactory();
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, factory);
        int port = manager.allocate("prj-a");
        factory.processes.get("manao-ws-prj-a:" + port).stopListening();

        assertThat(manager.allocate("prj-a")).isEqualTo(port);
        assertThat(factory.started).hasSize(2);
    }

    @Test
    void supervisedModeUsesDeterministicPortsAndKeepsOneBridgePerProject() {
        WorkspacePortForwardManager manager = new WorkspacePortForwardManager("manao-test", 18100, 18199, null);
        int port = manager.allocate("prj-a");
        assertThat(port).isBetween(18100, 18199);
        WorkspacePortForwardManager second = new WorkspacePortForwardManager("manao-test", 18100, 18199, null);
        assertThat(second.allocate("prj-a")).isEqualTo(port);
        manager.checkChildren();
        assertThat(manager.activeBridges()).isEqualTo(1);
        manager.shutdown();
        assertThat(manager.activeBridges()).isZero();
    }
```

- [ ] **步骤 2：运行并确认失败**

运行：`mvn -B -Dtest=WorkspacePortForwardManagerTest test`（workdir `poc4/backend`）
预期：编译失败（接口缺 `isListening()`）或断言失败。

- [ ] **步骤 3：实现**（`WorkspacePortForwardManager.java`）：

3a. 接口与 import（新增 `java.io.IOException`、`java.net.InetAddress`、`java.net.InetSocketAddress`、`java.net.Socket`；已有 `java.net.URI` 保留）：

```java
    public interface PortForwardProcess {
        /** Process handle still alive; does not guarantee the forwarded port accepts connections. */
        boolean isAlive();

        /** The forwarded loopback port actually accepts TCP connections right now. */
        boolean isListening();

        void kill();
    }
```

3b. 静态探测方法（加在 `allocate` 之前）：

```java
    /**
     * Best-effort loopback TCP connect probe: true only when the port accepts connections.
     * Distinguishes a live port-forward socket from a handle that merely reports alive.
     */
    public static boolean isPortListening(int port) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 250);
            return true;
        } catch (IOException ex) {
            return false;
        }
    }
```

3c. `allocate()` 既有桥分支（68-71 行）改为：

```java
        if (existing != null) {
            if (factory != null && (!existing.process.isAlive() || !existing.process.isListening())) {
                existing.process = factory.start(namespace, existing.serviceName, servicePort, existing.localPort);
            }
            return existing.localPort;
        }
```

3d. 第 77 行改为：

```java
        PortForwardProcess process = factory == null ? supervisedProcess(port) : factory.start(namespace, serviceName, servicePort, port);
```

3e. `ALWAYS_ALIVE` 常量（88-91 行）替换为：

```java
    /**
     * Supervised mode (factory == null): an operator-managed bridge outside this JVM serves the
     * deterministic port. Liveness is reported from the real listener, never assumed.
     */
    private static PortForwardProcess supervisedProcess(int port) {
        return new PortForwardProcess() {
            @Override public boolean isAlive() { return isPortListening(port); }
            @Override public boolean isListening() { return isPortListening(port); }
            @Override public void kill() { }
        };
    }
```

3f. `checkChildren()`（94-101 行）改为：

```java
    /** Recreates dead or listener-less bridges on their original ports (called by the dependency monitor). */
    public synchronized void checkChildren() {
        if (factory == null) return; // supervised: the external operator owns the bridge
        for (Bridge bridge : bridges.values()) {
            if (!bridge.process.isAlive() || !bridge.process.isListening()) {
                bridge.process = factory.start(namespace, bridge.serviceName, servicePort, bridge.localPort);
            }
        }
    }
```

3g. 类 javadoc 第 10 行 "Child exit is detected" 改为 "Child exit or loss of the forwarded listener is detected"。

- [ ] **步骤 4：改 LocalClusterConfig 包装**（131-140 行）：

```java
        return new WorkspacePortForwardManager.PortForwardProcess() {
            @Override public boolean isAlive() { return forward.isAlive(); }
            @Override public boolean isListening() {
                return forward.isAlive() && WorkspacePortForwardManager.isPortListening(localPort);
            }
            @Override public void kill() {
                try {
                    forward.close();
                } catch (java.io.IOException ex) {
                    throw new IllegalStateException("cannot close workspace bridge", ex);
                }
            }
        };
```

- [ ] **步骤 5：运行并确认通过**

运行：`mvn -B -Dtest=WorkspacePortForwardManagerTest test` 后运行 `mvn -B -Dtest=WorkspacePortForwardManagerTest,WorkspaceResourceFactoryTest test`（workdir `poc4/backend`）
预期：两测试类全 PASS（R2-1 的测试仍绿）。

- [ ] **步骤 6：提交**

```powershell
git add poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspacePortForwardManager.java poc4/backend/src/main/java/com/manao/poc4/config/LocalClusterConfig.java poc4/backend/src/test/java/com/manao/poc4/kubernetes/WorkspacePortForwardManagerTest.java
git commit -m "fix(poc4): verify workspace bridge listeners and recreate lost ones"
```

---

## 任务 R2-3：stage6 压力/故障 E2E spec 资产

**文件：**
- 新建：`poc4/frontend/tests/e2e/stage6-terminal-stress.spec.ts`
- 新建：`poc4/frontend/tests/e2e/stage6-faults.spec.ts`
- 修改：`poc4/frontend/playwright.config.ts:36-40`（stage6 项目）
- 修改：`poc4/frontend/package.json`（scripts 追加两条，不动既有脚本）

**接口：** 两个 spec 必须复用 `stage6-real-backend.spec.ts` 的既有约定：`GATE_MODE = process.env.STAGE6_GATE === '1'` 的 `beforeEach` 可达性守卫（不可达时 gate 模式失败、非 gate 模式 skip）、`login()/apiToken()/authHeaders()/createProject()/awaitReady()` 同名助手（从该文件逐字复制）、用户名 alice/bob 与密码 `stage6-alice-pass`/`stage6-bob-pass`。终端 UI 锚点（已核实存在）：`data-testid="job-terminal-viewport"`（`src/components/terminal/JobTerminalPanel.tsx:367`）、`data-testid="terminal-last-output"`（`src/components/terminal/TerminalPanel.tsx:212`）。WS 端点：`/api/v1/ws/terminals?ticket=<ticket>` 与 `/api/v1/ws/run-logs?ticket=<ticket>`（ticket 由创建会话 REST 接口返回；REST 路径从 `poc4/frontend/src/contracts/terminal.ts`、`poc4/frontend/src/contracts/run.ts` 的解析函数与 `src/features/terminal/JobTerminalTransport.ts`、`src/features/logs/RunLogTransport.ts` 中读取，必须与之一致，不得自造路径）。协议帧/credit/ack/resize 字段名以 `poc4/frontend/src/terminal/WebSocketTerminalTransport.ts` 与 `src/features/logs/logProtocol.ts` 为准。

**stage6-terminal-stress.spec.ts 必含用例（断言逐字如下）：**
1. `PTY 8 MiB output in <=32 KiB frames conserves 256 KiB credit`：创建项目→awaitReady→start run→创建 terminal 会话取得 ticket→`page.evaluate` 内 `new WebSocket(ws://127.0.0.1:4173/api/v1/ws/terminals?ticket=...)`（注意页面已打开，直接用 `location.host` 拼 `ws(s)://` 前缀）→发送输入帧：每条 ≤16 KiB（断言 `eachInputFrame <= 16384`）→通过输入令远端输出 ≥8 MiB（例如 shell 命令 `head -c 8388608 /dev/zero | tr '\0' 'x'`，命令本身 <16 KiB）→收集输出帧：断言 `everyOutputFrame <= 32768`、`totalDelivered >= 8388608`、ack 制 `maxOutstanding <= 262144`（256 KiB credit）、无 ack 前不发超 credit 输入；发送 ≥100 次 resize 事件并断言 `resizeGeneration >= 100`（字段名以 transport 协议为准）。测试内 `test.setTimeout(600_000)`。
2. `run log live then full replay matches byte conservation`：start run→获取 run-logs ticket→WS 收 live 帧累计 `liveBytes`→等 run 终态（复用 `awaitReady` 同款轮询模式，终态不含 RUNNING；60×2s 上限）→GET 日志 REST（路径按 contracts/run.ts 解析函数）→断言 `replayBytes === liveBytes` 且 `replayBytes > 0`。

**stage6-faults.spec.ts 必含用例：**
1. `channel disconnect fails closed then reconnects`：创建项目→打开 run-logs 或 terminal WS→收集到首个帧后 `socket.close()`→断言 UI 展示固定依赖错误文案（文案取自 `src/features/logs`/`src/features/terminal` 的断开态渲染，精确匹配实际文本）→重新获取 ticket 重连→断言再次收到帧。
2. `parallel projects keep isolated dynamic bridges`：Alice 创建两个项目→awaitReady→并发对两个项目写文件（REST 路径与请求体按 `stage6-real-backend.spec.ts` 的 `文件保存/版本冲突` 用例同款 API 调用改写为并发 Promise.all）→断言两项目各自写入 200、内容互不串扰、且两份响应可用于区分 bridge 映射（若响应含端点/无则仅断言内容隔离）。
3. `fault phases: backend restart / tunnel loss / bridge loss`：`const FAULT = process.env.STAGE6_FAULT`；未设置时 `test.skip(true, 'STAGE6_FAULT not set; operator-injected fault phase')`；`FAULT==='backend-restart'`：断言登录可用 + 存在 `CREATING` 项目时轮询至终态（READY 或 FAILED/WORKSPACE_RECONCILIATION_REQUIRED，两者均须可读且失败原因已脱敏：不含 `kubeconfig`/`token`/`password` 字样）；`FAULT==='tunnel-loss'`：断言创建项目接口返回固定依赖错误（4xx/5xx 且响应体无堆栈）；`FAULT==='bridge-loss'`：断言文件 API 返回固定依赖错误、UI 无崩溃（页面可继续登录）。三个分支断言按 plan Task 11 step 4 的 6A-only 故障集合。

**playwright.config.ts：** stage6 项目改为：

```ts
    {
      name: 'stage6',
      testMatch: /stage6-(real-backend|terminal-stress|faults)\.spec\.ts/,
      timeout: 600_000,
      use: { ...devices['Desktop Chrome'] },
    },
```

**package.json：** `"test:e2e:stage6"` 行之后追加：

```json
    "test:e2e:stage6:stress": "playwright test tests/e2e/stage6-terminal-stress.spec.ts --project=stage6",
    "test:e2e:stage6:faults": "playwright test tests/e2e/stage6-faults.spec.ts --project=stage6",
```

- [ ] **步骤 1：逐字读取参照**：`stage6-real-backend.spec.ts` 全文、`src/contracts/terminal.ts`、`src/contracts/run.ts`、`src/features/terminal/JobTerminalTransport.ts`、`src/features/logs/RunLogTransport.ts`、`src/terminal/WebSocketTerminalTransport.ts`、`src/features/logs/logProtocol.ts`、`stage5-terminal-stress.spec.ts` 的测量助手写法。任何协议字段/端点与上述路径冲突时以源码为准，并把差异写进报告。
- [ ] **步骤 2：按"必含用例"清单编写两个 spec**（助手函数自 stage6-real-backend.spec.ts 复制；UI 选择器只用已核实的 data-testid；不断言未在前端源码出现的文案）。
- [ ] **步骤 3：配置与脚本修改**（playwright.config.ts、package.json 按上文逐字）。
- [ ] **步骤 4：验证（沙箱可执行的全部验证）**

运行（workdir `poc4/frontend`）：
```powershell
pnpm typecheck
pnpm exec playwright test tests/e2e/stage6-terminal-stress.spec.ts --project=stage6 --list
pnpm exec playwright test tests/e2e/stage6-faults.spec.ts --project=stage6 --list
```
预期：typecheck 0 错误；两个 `--list` 均列出全部用例且不报错（spec 可注册、可编译；**不执行**真实运行）。
另运行 `git diff --check`（workdir 工作树根）须干净。

- [ ] **步骤 5：提交**

```powershell
git add poc4/frontend/tests/e2e/stage6-terminal-stress.spec.ts poc4/frontend/tests/e2e/stage6-faults.spec.ts poc4/frontend/playwright.config.ts poc4/frontend/package.json
git commit -m "test(poc4): add stage6 stress and fault e2e specs"
```

---

## 任务 R2-4：证据与文档更新（绑定新 HEAD）

**文件：**
- 修改：`poc4/docs/evidence/stage-6/6a-gate.md`
- 修改：`poc4/docs/evidence/stage-6/6a-local-cluster-result.md`（先读全文，仅更新 SHA 引用与追加"第二轮"小节；历史记录段落保持原样并注明被取代）
- 修改：`poc4/docs/plans/2026-09-01-ensoai-stage-6-remediation-implementation-plan.md`（文末追加"第二轮附录"一节，指向本计划文件与本轮四个提交）
- 修改：`poc4/docs/plans/2026-09-03-ensoai-stage-6a-gate-round2-ledger.md`（台账：追加 R2-1..R2-4 完成行与全部 Ruling 行）

**接口：** 无。

- [ ] **步骤 1：取新 HEAD**：`git rev-parse HEAD`、`git log --oneline -6` 记录本轮 4 个提交（R2-1..R2-3 加本任务）的完整 SHA。
- [ ] **步骤 2：收集本地验证证据**（若 captain 已跑全量则引用 captain 数字；否则自行跑）：workdir `poc4/backend` `mvn -B test`（预期 ≥220 全绿、1 skipped=real-mode 守卫）；workdir `poc4/frontend` `pnpm typecheck`。
- [ ] **步骤 3：重写 `6a-gate.md`**：更新"后端 Git SHA"为新 HEAD（标注"含第一轮修复 + 第二轮探针/bridge/覆盖修复"）；新增"第二轮修复（本次复跑前）"一节，逐项记录：探针 startupProbe 数值与设计条款、bridge isListening 语义与测试、两个新 spec 及 `--list` 验证、后端全量测试数字；保留第一轮修复表；**GATE 状态如实保持 FAILED**——第二节联调表维持旧记录并注明"待外部复跑刷新"，不得虚构复跑结果；第三节环境阻断说明保留并补一句"第二轮代码修复已提交，复跑步骤不变"。
- [ ] **步骤 4：更新 `6a-local-cluster-result.md`**：把过期 SHA 引用改为新 HEAD 并注明更新日期；追加"2026-09-03 第二轮：证据已被 6a-gate.md 第二轮小节取代"。
- [ ] **步骤 5：补写计划附录与台账**：`2026-09-01` 计划文末追加附录（指向本计划路径 + 四个提交 SHA）；台账追加完成行：`R2-1: complete (<sha1>)`、`R2-2: complete (<sha2>)`、`R2-3: complete (<sha3>)`、`R2-4: complete (<sha4>)` 及 R1–R5 Ruling 行。
- [ ] **步骤 6：提交**

```powershell
git add poc4/docs/evidence/stage-6/6a-gate.md poc4/docs/evidence/stage-6/6a-local-cluster-result.md poc4/docs/plans/2026-09-01-ensoai-stage-6-remediation-implementation-plan.md poc4/docs/plans/2026-09-03-ensoai-stage-6a-gate-round2-ledger.md
git commit -m "docs(poc4): bind stage 6a gate evidence to round-2 head"
```

---

## 退出条件

- 后端全量 `mvn -B test` 全绿（含 R2-1/R2-2 新增 4 个测试）；`git diff --check` 干净；UTF-8 无 BOM。
- 三个 spec 全部 `--list` 可注册；`pnpm typecheck` 0 错误。
- 证据文档 SHA 与最终 HEAD 一致；GATE 状态未被虚构。
- 未提交 `AGENTS.md`、`fix13.py`、`.grok/`。
