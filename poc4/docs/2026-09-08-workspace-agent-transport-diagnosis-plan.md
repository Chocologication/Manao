# Workspace-agent HTTP mutation 故障诊断与修复方案

- **记录日期：** 2026-09-08
- **记录时工作树 HEAD：** `3255bb10ba6383832f6b481402222aa5f550c811`
- **工作树：** `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes`
- **来源：** 用户选中的前次回复第三至第六部分。
- **关联报告：** `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\docs\2026-9-8-workspace-agent-bug-report.md`
- **状态：** 待确认、待执行的诊断方案，不是根因已确认或修复已完成的报告。

> 本文记录用户所选内容，并整理 Markdown 层级、表格和代码块。正文中的“当前”、优先级、代码行号、测试结果和运行状态沿用前次调查语境，本次仅核对工作树 HEAD，未重新验证运行环境。下文命令及代码修改均为后续建议，不表示已执行，也不构成自动执行授权。章节编号保留原选中内容的第三至第六部分。

## 三、当前根因候选及优先级

### 候选 A：Fabric8 port-forward listener 存在，但真实 HTTP 通道不可用

**优先级：最高。**

可能表现：

```text
TCP 端口能 connect
但 POST /agent/v1/entries 连接失败或被 reset
```

检查重点：

- `LocalPortForward` 是否在第一次真实 HTTP 请求时断开；
- port-forward 是否确实转发到目标 Pod；
- Pod 名称是否正确；
- target port 是否确实为 `8080`；
- Service/Pod 创建后端是否有短暂重启；
- readiness condition 是否早于真正稳定可用；
- forward stream 是否被 Fabric8 关闭。

当前 Fabric8 启动代码位于：

```text
D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\backend\src\main\java\com\manao\poc4\config\LocalClusterConfig.java
```

约 `127–148` 行。

它通过 Pod 名称直接建立 port-forward：

```java
client.pods()
    .inNamespace(namespace)
    .withName(serviceName)
    .portForward(servicePort, loopback, localPort)
```

这里的设计假设是：

```text
workspace Service 名称 == workspace Pod 名称
```

当前工厂确实使用了相同名字，但下一轮必须用实际 Kubernetes 资源确认，而不能只信代码。

### 候选 B：workspace-agent Pod 在 readiness 之后发生重启或连接 reset

**优先级：高。**

可能表现：

```text
Pod Ready=True
→ backend 分配 bridge
→ agent JVM 或容器重启
→ mutation 请求收到 connection reset
```

需要观察：

```text
container restartCount
lastState.terminated
Pod events
kubectl logs --previous
```

由于当前失败后 cleanup 会删除资源，不能等失败之后再查。必须在 provisioning 还处于 `CREATING` 时观察。

### 候选 C：agent 已执行 mutation，但响应返回失败

**优先级：高，必须特别防止误判。**

可能链路：

```text
agent 收到 CREATE
→ agent 创建目录并写 receipt
→ response 写回过程中 bridge 中断
→ backend 收到 IOException
→ PENDING operation
```

这种情况下，真正的第一步不是重试，而是：

```text
通过 receipt endpoint 或 Pod 文件系统检查 operationId 对应 receipt
```

当前 operationId 已在后端 fail-closed 日志中记录，例如：

```text
f46c0040-fceb-4efd-82d7-6cc2e36e37f3
```

如果 receipt 存在并且 digest 匹配，则说明 mutation 可能已完成，只是 response 丢失。

### 候选 D：workspace-agent 内部文件系统异常

**优先级：中。**

包括：

- `/workspace` 没有正确挂载；
- `subPath` 指向错误目录；
- UID/GID 权限不正确；
- PVC mount 成功但目录不可写；
- agent 收到请求后 `Files.createDirectory()` 失败；
- receipt 目录创建失败；
- read-only root filesystem 对临时文件路径产生影响。

如果是这一类，并且异常被 Controller 正确处理，预期应看到：

```text
HTTP 4xx / 5xx
```

而不是后端 `HttpClient.send()` 抛出 IOException。

但是如果 agent 进程因未捕获异常退出，或者连接在 response 之前被 reset，就可能仍表现为 `IO_ERROR`。所以必须读取 Pod 日志和 restart 状态。

### 候选 E：HTTP 请求合同仍有问题

**优先级：较低，但不能完全跳过。**

当前本地真实合同测试已经通过：

- `application/json`；
- `/agent/v1/entries`；
- `nextPath`；
- receipt 字段；
- capability filter；
- 文件系统写入。

因此它不是当前最强候选。

但真实集群仍需确认：

- 实际请求 URI；
- 实际请求 method；
- 实际 Content-Type；
- 实际请求 body 是否完整；
- capability canonical path 是否与服务端看到的一致；
- URL query 是否被 bridge 或 HTTP client 重新编码；
- 服务端是否收到完整 body。

如果请求到达 agent 但签名失败，应得到：

```text
401 CAPABILITY_REJECTED
```

若实际仍是 `IO_ERROR`，则继续回到网络/bridge/Pod 生命周期方向。

## 四、建议的具体诊断方案

### 阶段 0：保留当前状态，不做代码修改

当前先保持：

```text
后端停止
前端状态待确认
数据库不清理
集群不修改
工作树不修改
```

确认：

```text
git status
18080 是否释放
4173 是否仍在监听
6443 SSH tunnel 是否仍在监听
kubeconfig 是否仍有效
```

这一阶段只确认环境，不运行 provisioning。

### 阶段 1：先增加最小、安全的传输异常分类

这是唯一建议先做的代码改动，但本轮不执行。

修改范围建议限定为：

```text
poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspaceApiClient.java
poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceAgentException.java
poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceOperationService.java
```

以上相对路径均以本文开头记录的工作树为根目录。

目标不是暴露原始异常，而是把现在笼统的：

```text
503 IO_ERROR
```

区分为：

```text
CONNECT
TIMEOUT
RESET
INTERRUPTED
OTHER
```

建议映射：

| 异常 | 安全分类 |
| --- | --- |
| `ConnectException` | `CONNECT` |
| `HttpConnectTimeoutException` | `CONNECT_TIMEOUT` |
| `HttpTimeoutException` | `TIMEOUT` |
| `SocketException` | `RESET` |
| `InterruptedException` | `INTERRUPTED` |
| 其他 IOException | `OTHER` |

日志只允许包含：

```text
projectId
operationId
phase=MUTATE
method
safeEndpointClass=LOOPBACK
transportFailure
```

不允许记录：

```text
原始异常 message
请求 URL 全量 query
receiptJson
文件内容
capability header
token
private key
```

#### 必须先写的回归测试

在修改生产代码前新增以下测试：

1. 未监听 loopback 端口：

   ```text
   => CONNECT
   ```

2. 接受连接但不返回 HTTP：

   ```text
   => TIMEOUT
   ```

3. 建立连接后立即关闭：

   ```text
   => RESET
   ```

4. 线程中断：

   ```text
   => INTERRUPTED
   ```

5. 普通 HTTP 401/409/503 响应：

   ```text
   => 不进入 transportFailure
   => 保留真实 status/code 映射
   ```

这样可以先确认 `IO_ERROR` 的真实底层类型，而不是继续盲目修改 bridge 或 agent。

### 阶段 2：重新启动环境并只运行一个聚焦用例

不要立即运行完整 5 个用例。

只运行：

```text
project creation reaches READY with template files through the real workspace
```

启动前确认：

```text
127.0.0.1:6443 可达
受限 kubeconfig auth can-i get pods 返回 yes
MySQL 可连接
数据库中 Alice 没有残留项目
```

后端启动后确认：

```text
127.0.0.1:18080/actuator/health = 200
```

前端如果仍运行，只刷新，不要同时启动第二个 Vite。

### 阶段 3：在项目进入 CREATING 后同步观察 Kubernetes

发现新 `projectId` 后立即执行：

```powershell
$kubectl = 'D:\Docker\DockerDesktop\resources\bin\kubectl.exe'
$kubeconfig = 'D:\DeepLearning\MyProjects\Project_Manao_kubeconfig\stage6-6a-kubeconfig'
$namespace = 'manao-stage6-test'

& $kubectl `
  --kubeconfig $kubeconfig `
  -n $namespace `
  get pods,pvc,svc `
  -l "manao.poc4/project-id=<PROJECT_ID>" `
  -o wide `
  --watch
```

同时记录：

```text
initializer Pod:
- phase
- exit code
- restart count

workspace Pod:
- phase
- Ready condition
- restart count
- container state
- last termination reason

workspace Service:
- cluster IP
- port 8080
- selector
- endpoints 是否存在
```

不要等 backend cleanup 完成后才检查。

### 阶段 4：在 bridge 建立后增加两类外部观察

#### 4.1 观察 loopback 端口

端口来自后端实际日志，不盲目扫描：

```powershell
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -eq <ACTUAL_BRIDGE_PORT> }
```

只观察：

```text
端口是否监听
监听进程是否仍存在
第一次 mutation 发生时端口是否消失
```

#### 4.2 通过实际 bridge 做 health 请求

不能只验证 TCP connect，应该验证：

```text
GET http://127.0.0.1:<ACTUAL_BRIDGE_PORT>/agent/v1/healthz
```

这里需要注意：

- `healthz` 当前不要求 capability；
- 不应使用 mutation 请求替代 health probe；
- health probe 必须发生在第一条 mutation 之前；
- health probe 失败时不应继续写模板。

如果：

```text
TCP 成功
healthz 失败
```

根因集中在：

```text
port-forward 到 Pod 的 HTTP 通道
Pod 内 8080
workspace-agent 进程
```

如果：

```text
healthz 成功
mutation 失败
```

则继续比较真实 mutation 请求和 capability filter。

### 阶段 5：按 transport 分类分支处理

#### 分支 A：CONNECT

检查：

```text
bridge listener 是否实际存在
Fabric8 port-forward 是否启动成功
Pod 是否已被删除或重启
Pod 名称是否正确
目标端口是否为 8080
port-forward 是否连接到正确 namespace
```

优先查看：

```text
backend bridge 日志
Pod events
workspace Pod 状态
```

#### 分支 B：CONNECT_TIMEOUT 或 TIMEOUT

检查：

```text
workspace-agent 是否卡在启动
Pod readiness 是否虚假或过早
HTTP server 是否真正监听 8080
容器是否 CPU / memory throttled
port-forward stream 是否建立但无数据
```

#### 分支 C：RESET

检查：

```text
Pod restartCount
lastState.terminated
kubectl logs --previous
Fabric8 LocalPortForward 是否关闭
Kubernetes Pod 是否被 cleanup 或重建
```

#### 分支 D：返回 HTTP 401

说明请求已经到达 agent，重点检查：

```text
canonical path/query
Content-Type
body hash
projectId
capability public key
agent clock
```

这时才进入 capability 合同排查，不再优先怀疑网络。

#### 分支 E：返回 HTTP 4xx/5xx

说明请求已经到达 Controller 或异常处理器，重点检查：

```text
WorkspaceFileService.create()
/workspace 挂载
UID/GID
目录权限
receipt 目录写入
agent 日志
```

#### 分支 F：response 读取失败但 receipt 存在

这是最危险的 ambiguous case：

```text
agent mutation 可能已成功
backend 未收到 response
```

处理顺序必须是：

```text
查询 receipt
验证 operationId
验证 beforeSha256
验证 afterSha256
验证 receiptSha256
决定 reconcile 或 fail-closed
```

禁止直接重试同一个 CREATE。

## 五、我建议的实际修复顺序

在获得用户对方案的确认后，按下面顺序执行。

### 第 1 个小提交：只做 transport 可观测性

包含：

- 异常分类；
- 安全日志；
- operationId 关联；
- 单元测试；
- 不改变重试、fail-closed 和业务状态逻辑。

目标：

```text
下一次真实测试能回答“是 connect、timeout、reset 还是 agent HTTP 响应问题”
```

### 第 2 个小提交：修复实际观测到的单一根因

根据第 1 次真实聚焦测试结果，只修一个边界：

- bridge 建立问题；
- Pod readiness/启动问题；
- agent 文件系统问题；
- capability 请求问题；
- response/receipt 丢失问题。

不在证据不足时同时改 bridge、agent、receipt 和 provisioning。

### 第 3 个小提交：补充真实边界回归

至少覆盖：

```text
healthz through bridge
mutation through bridge
agent restart
bridge reset
response lost after mutation
receipt reconciliation
```

### 第 4 步：重新运行单一聚焦浏览器测试

只有在：

```text
单一 provisioning 用例稳定 READY
模板文件内容正确
receipt 和 revision 正确
```

之后，才运行完整 5 个 Stage 6A 基础测试。

### 第 5 步：重新评估 6A

仍需要：

```text
真实 happy path
真实 workspace 文件保存
Run
日志 / PTY
压力测试
故障矩阵
```

在这些证据完整之前：

```text
6A = FAILED
6B 不得开始
```

## 六、当前结论

目前最准确的根因描述是：

> 后端的第一条 workspace mutation 没有完成一次可用的 HTTP 请求-响应交换；当前日志中的 `503 / IO_ERROR` 是 `WorkspaceApiClient.send()` 对底层 Java 异常的统一包装。现有证据还不足以证明是 workspace-agent 文件操作本身失败，更不能排除 mutation 已执行但响应丢失。

当前最优先的调查边界是：

```text
Fabric8 port-forward / loopback bridge / workspace Pod 8080
```

而不是先修改：

```text
WorkspaceFileService
receipt 逻辑
模板内容
前端
数据库
```

用户确认这个方案后，下一步才会开始第 1 个小提交：**只增加安全 transport exception 分类和对应测试，然后重启环境执行一次聚焦 provisioning 测试。**
