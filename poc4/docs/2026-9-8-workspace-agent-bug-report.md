# Workspace-agent provisioning failure report

**日期：** 2026-09-08  
**范围：** Project_Manao POC4 Stage 6A 真实后端 / Kubernetes workspace provisioning  监听  
**工作树：** `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes`  
**相关提交：** `7692030 fix(poc4): repair stage6 workspace provisioning contract`

## 1. 当前结论

真实浏览器测试已经排除前端地址、后端端口、Kubernetes token 和基础 RBAC 作为本次失败的直接原因。

本次聚焦测试已经成功创建项目，并进入项目 `CREATING` 后的 provisioning 流程；失败发生在后端向 workspace-agent 发起第一条 workspace mutation 时：

```text
phase=MUTATE
httpStatus=503
agentCode=IO_ERROR
```

随后后端按 fail-closed 策略将项目标记为：

```text
state=FAILED
failureReason=WORKSPACE_RECONCILIATION_REQUIRED
```

因此，`WORKSPACE_RECONCILIATION_REQUIRED` 是当前传输失败后的保护性结果，不是最初的底层根因。

当前尚不能将 Stage 6A 判定为 PASS，也不能开始 6B。

## 2. 真实测试证据

### 2.1 测试环境预检

在运行聚焦测试前已确认：

```text
127.0.0.1:4173 前端：HTTP 200
127.0.0.1:18080/actuator/health：HTTP 200
127.0.0.1:6443 Kubernetes SSH 隧道：监听中
Kubernetes server：v1.31.13
受限 kubeconfig auth can-i get pods：yes
```

前端和后端均使用当前 Stage 6 工作树，未在测试前重启或修改数据库数据。

### 2.2 聚焦测试命令

```powershell
$env:STAGE6_GATE = '1'

pnpm exec playwright test `
  tests/e2e/stage6-real-backend.spec.ts `
  --project=stage6 `
  --workers=1 `
  --grep 'project creation reaches READY with template files through the real workspace' `
  --reporter=list
```

测试名称：

```text
project creation reaches READY with template files through the real workspace
```

测试结果：

```text
1 failed
```

失败断言：

```text
Expected: READY
Received: FAILED
```

### 2.3 项目和后端日志

失败项目：

```text
projectId=31d231c5-476b-4b8e-8fa6-87ee29fcf999
name=stage6-e2e-1788857525063
state=FAILED
failureReason=WORKSPACE_RECONCILIATION_REQUIRED
```

后端日志时间线：

```text
2026-09-08 16:49:06  Spring Boot started on port 18080
2026-09-08 16:52:20  workspace operation failed closed
2026-09-08 16:52:20  project provisioning failed and started label-scoped cleanup
2026-09-08 17:05:41  backend graceful shutdown
```

关键日志：

```text
workspace operation failed closed:
projectId=31d231c5-476b-4b8e-8fa6-87ee29fcf999
operationId=f46c0040-fceb-4efd-82d7-6cc2e36e37f3
phase=MUTATE
httpStatus=503
agentCode=IO_ERROR
```

后端堆栈显示失败调用链为：

```text
WorkspaceOperationService.apply
→ WorkspaceService.applyInternal
→ ProjectProvisioningService.writeTemplate
→ ProjectProvisioningService.provisionInternal
```

### 2.4 Kubernetes 清理结果

失败处理已执行资源清理。测试结束后查询本项目标签资源：

```text
No resources found in manao-stage6-test namespace.
```

因此，当前没有可直接读取的失败后 workspace Pod 或 workspace-agent Pod 资源；下次诊断必须在失败发生前观察资源，或先改进保留/采集诊断证据的方式。

## 3. 代码路径分析

### 3.1 后端 mutation 请求

第一条模板写入是目录创建：

```text
CREATE
path=<template directory>
kind=directory
```

当前客户端路径为：

```text
WorkspaceApiClient.mutate
→ sendJson(..., POST, /agent/v1/entries, JSON body)
```

当前代码已经修复以下 HTTP 合同：

- POST 使用 `application/json`；
- rename JSON body 包含 `nextPath`；
- DELETE 使用 `/agent/v1/entries?...`；
- receipt 使用 agent 返回的 `receiptSha256`；
- 模板目录按照父目录优先创建；
- 文件执行 `CREATE` 后再执行包含真实 UTF-8 内容的 `SAVE`。

这些合同已通过独立真实 HTTP/filter/controller/filesystem 检查，不足以解释本次真实集群中的 `MUTATE / 503 / IO_ERROR`。

### 3.2 当前错误包装边界

`WorkspaceApiClient.send()` 当前将 Java `HttpClient.send()` 抛出的异常统一包装为：

```java
new WorkspaceAgentException(503, "IO_ERROR", "workspace API is temporarily unavailable")
```

因此日志中的：

```text
httpStatus=503
agentCode=IO_ERROR
```

不一定表示 workspace-agent 实际返回了 HTTP 503。它也可能表示：

- loopback bridge 没有监听；
- bridge 监听端口连接被拒绝；
- workspace-agent 没有在 HTTP client 超时内响应；
- port-forward 连接建立后被重置；
- HTTP 响应读取失败。

由于当前安全日志没有记录异常类别，因此仅凭现有日志还不能区分上述情况。

### 3.3 当前未进入的阶段

本次失败发生在 `MUTATE`，所以尚未进入：

```text
verifyResult / mutation response 字段校验
receipt digest 校验
数据库 commitOperation
workspace revision 递增
项目 READY
模板文件树读取
```

这意味着本次证据不能说明 receipt 或数据库 revision 是根因。

## 4. 已排除和未排除事项

### 已排除或基本排除

```text
前端 127.0.0.1:4173 不可达
后端 127.0.0.1:18080 不可达
Kubernetes SSH API tunnel 完全不可达
Stage 6 kubeconfig token 过期
基础 pods RBAC 不足
项目数量上限导致的 HTTP 409
项目创建接口本身失败
```

### 尚未排除

```text
Fabric8 port-forward 没有真正建立可用 listener
workspace Pod 尚未可接受 agent HTTP 请求
workspace-agent 容器启动后立即退出或未监听 8080
backend 使用的 workspace Service/Pod endpoint 不正确
Kubernetes port-forward 在第一条 mutation 时连接中断
workspace-agent HTTP 请求响应超时
workspace-agent 返回内容导致 HTTP client 读取失败
```

## 5. 下一步最小诊断方案

不要先重复完整 5 个浏览器用例。继续只运行项目 provisioning 聚焦用例，以避免多个项目同时制造混杂证据。

### 步骤 1：增加安全的 transport exception 分类

在不记录原始消息、请求正文、token、capability、文件内容和路径的前提下，在 `WorkspaceApiClient.send()` 中记录有限分类：

```text
CONNECT
TIMEOUT
RESET
INTERRUPTED
OTHER
```

同时保留当前安全字段：

```text
projectId
operationId
phase
httpStatus
agentCode
```

分类依据只使用异常类型，不记录 `ex.getMessage()`。

推荐映射：

| Java 异常类别 | 安全分类 |
|---|---|
| `java.net.ConnectException` | `CONNECT` |
| `java.net.http.HttpTimeoutException` | `TIMEOUT` |
| `java.net.SocketException` | `RESET` |
| `java.lang.InterruptedException` | `INTERRUPTED` |
| 其他 `IOException` 或异常 | `OTHER` |

### 步骤 2：在 provisioning 失败前观察 Kubernetes 资源

重新启动后端并只执行聚焦测试。项目创建成功后，使用项目 ID 在另一个 PowerShell 窗口观察：

```powershell
$kubectl = 'D:\Docker\DockerDesktop\resources\bin\kubectl.exe'
$kubeconfig = 'D:\DeepLearning\MyProjects\Project_Manao_kubeconfig\stage6-6a-kubeconfig'
$namespace = 'manao-stage6-test'

& $kubectl --kubeconfig $kubeconfig -n $namespace get pods,pvc,svc -o wide --watch
```

需要记录但不要修改的状态包括：

```text
initializer Pod 是否 Succeeded
workspace Pod 是否 Running / Ready
workspace Service 是否存在
workspace-agent 容器是否监听 8080
Pod 是否发生重启
```

由于失败后 cleanup 会删除资源，必须在项目仍处于 `CREATING` 时观察。

### 步骤 3：如果 workspace Pod 存活，采集 agent 日志

仅在资源仍存在且不包含敏感配置时读取：

```powershell
& $kubectl --kubeconfig $kubeconfig -n $namespace logs <workspace-pod> --all-containers=true --timestamps
```

应重点检查：

```text
Spring Boot 是否启动完成
Tomcat 是否监听 8080
capability filter 是否拒绝请求
请求到达后是否发生文件系统异常
容器是否重启
```

不要输出 Secret、环境变量中的 key/token 或私钥。

### 步骤 4：检查 loopback bridge

在后端日志出现项目 bridge 分配后，确认对应 loopback 端口存在并可建立 TCP 连接。端口范围来自当前 Stage 6 配置：

```text
18100-18199
```

检查目标必须是后端为该 project 分配的端口，不能盲目扫描或连接其他项目端口。

### 步骤 5：根据分类决定根因方向

#### `CONNECT`

优先检查：

```text
Fabric8 port-forward 是否建立
bridge listener 是否真正监听
workspace Pod 是否 Ready
Service/Pod 名称和端口是否正确
```

#### `TIMEOUT`

优先检查：

```text
workspace-agent 是否完成启动
agent 是否卡在文件系统或 filter
Pod 是否存在但未真正提供 HTTP 服务
```

#### `RESET`

优先检查：

```text
workspace-agent Pod 重启
port-forward WebSocket 断开
容器进程异常退出
```

#### `OTHER`

根据异常类型继续收窄，但仍不得记录不安全的原始异常消息。

## 6. 当前运行和验收建议

当前后端在本次测试之后已经停止，前端是否继续运行应在下一次测试前重新确认。

下一轮推荐顺序：

```text
1. 增加安全 transport exception 分类
2. 启动 SSH 隧道并刷新/验证受限 kubeconfig
3. 启动后端
4. 确认 18080 health=200
5. 只运行 project creation 聚焦用例
6. 同时观察 workspace Pod、Service 和 bridge
7. 读取 agentCode + transportFailure + Pod 日志
8. 修复单一根因
9. 重新运行聚焦用例
10. 聚焦用例通过后再运行完整 5 个测试
```

在以下条件全部满足前，不得将 6A 标记为 PASS：

```text
真实项目 provisioning 到 READY
真实 workspace 模板写入
真实文件保存
真实 Run 执行
真实日志/PTY 或其他 Stage 6A 要求的浏览器与集群证据
压力和故障矩阵证据
```

## 7. 当前状态摘要

```text
代码合同回归测试：通过
本地 HTTP/filter/controller/filesystem 合同：通过
Backend 全量隔离 MySQL 测试：通过
workspace-agent 全量测试：通过
Frontend 单元测试和 typecheck：通过
真实前端/后端基础可达性：通过
真实项目创建：通过到 CREATING
真实 workspace-agent 第一条 mutation：失败
失败阶段：MUTATE
失败分类：503 / IO_ERROR
失败后状态：FAILED / WORKSPACE_RECONCILIATION_REQUIRED
Stage 6A：FAILED
6B：不得开始
```