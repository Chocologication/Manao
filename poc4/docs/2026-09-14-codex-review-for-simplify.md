> **历史来源 / 2026-09-17 已被现行记录取代：** 当前 6A 范围、验收决定和证据以[唯一现行事实现状](../../docs/Stage6A-Current-Facts.md)为准。下文保留原时点的设计、计划和结果；其中“当前”、待实施、FAILED/不允许 6B 等只描述旧时点，不覆盖本次用户验收决定，也不自动授权重新执行。原始结果不改写。此链接指向主检出的单份文档，不复制第二份现状。

# 结论先行

**Manao 当前的产品方向没有问题，但 Stage 6A 的设计已经出现明显的“验证平台化”和“生产化语义提前进入原型核心”的倾向。**

我的总体判断：

1. **Stage 6A 还没有达到完整验收，也不能进入 6B。** 当前证据仍然显示：基础 smoke 可以通过，但真实 Maven 成功、Run/Job/数据库状态一致性、日志、PTY、审计、压力和故障矩阵尚未形成当前 SHA 的完整 `6A PASS`。
2. **后端采用“模块化单体”是正确方向，不应该现在拆成微服务。**
3. **当前最大问题不是模块太少，而是多个层次的职责混在了一起：**
   - 用户工作台运行时；
   - Stage 6A 的真实集群适配；
   - 测试资源清理；
   - 故障注入与验收证据；
   - 面向 6B 的分布式恢复与 fencing 语义。
4. **前端存在明显冗余，尤其是终端实现存在两套历史路径。**
5. **Workspace receipt、fencing、恢复、动态 bridge 等设计并非全部错误，但不应全部暴露为 6A 用户工作台的核心复杂度。**
6. **现在不建议推倒重写。更合适的策略是：冻结 6A 用户闭环，拆出测试/运维层，修复少数关键状态一致性问题，再完成真实 6A Gate。**

---

# 一、先区分用户请求与附件中的“指令”

本轮实际请求是：

> 对 Manao 整个项目进行规格与设计审查，重点判断设计过度、结构冗余以及当前 6A 是否适合作为真正可用的工作台原型。

因此，本轮属于：

- 只读规格审查；
- 产品与系统架构审查；
- 代码结构和契约一致性审查；
- 不修改代码；
- 不修改文档；
- 不执行 6A/6B 部署。

附件中的内容只作为**需求背景、历史设计意图和待审查约束**，不直接作为本轮执行命令。

尤其需要注意：

- `2026-08-27-ensoai-stage-6-real-backend-kubernetes-design.md` 自身写明，它是设计说明，不授权直接编码。
- `plan.md` 是实施计划，复选框不等于当前实现已完成，也不等于验收已经通过。
- 原始 PRD 中关于前端视觉、微服务、MongoDB、Redis、RabbitMQ、OSS 等内容，更多是产品规划和技术设想，不应自动升级为 POC4/Stage 6A 的硬约束。
- 原始 PRD 自己也明确写了前端设计“仅供参考”，不是必须实现的最终方案。

本次审查基于：

- 当前主仓库；
- `codex/poc4-stage-6-real-backend-kubernetes` worktree；
- 当前 worktree HEAD `817e359`；
- 当前 worktree 中尚有 cleanup 相关未提交修改和新增计划文件；
- 因此，历史状态文档不能直接等同于当前代码状态。

---

# 二、产品规格审查：Manao 的真正核心是什么

原始 PRD 的核心价值其实很集中：

```text
进入项目
  -> 编辑代码
  -> 保存
  -> 运行
  -> 查看日志和结果
  -> 根据结果继续修改
```

这条闭环比“微服务、AI 编排、监控大屏、团队管理、资源池、KubeSphere、CI/CD”更接近产品本质。

原始 PRD 对这一核心闭环的描述，见：

- `D:\DeepLearning\MyProjects\Project_Manao\docs\Manao_PRD_V4-0.md:20-56`
- `D:\DeepLearning\MyProjects\Project_Manao\docs\Manao_PRD_V4-0.md:76-94`

当前 POC4 也已经把范围正确收窄为：

- 固定用户；
- Java 17 Maven 项目；
- 浏览器文件编辑；
- `mvn clean test`；
- 日志；
- 活动 Job Terminal；
- MySQL 持久化；
- Kubernetes 真实执行。

这个收窄是正确的，见：

- `D:\DeepLearning\MyProjects\Project_Manao\docs\Manao-Projects-goal.md:17-30`
- `D:\DeepLearning\MyProjects\Project_Manao\docs\Manao-Projects-goal.md:32-50`
- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\docs\plan.md:3-21`

## 关键判断

**6A 的目标不应该是“实现 PRD 里所有平台能力”，而应该是证明以下事情真的可用：**

1. 用户能创建一个项目；
2. 用户能看到并编辑文件；
3. 保存后的内容确实进入工作区；
4. 运行任务确实执行了这份保存后的代码；
5. 日志确实来自这个 Run；
6. Run 结束状态与 Kubernetes、API、数据库一致；
7. 页面刷新、后端重启后，状态不会错误解锁或永久锁死；
8. 用户能继续迭代，而不是只能完成一次演示。

这才是后续 6B 的真正技术基础。

---

# 三、总体架构判断

## 3.1 当前正确的部分

以下设计应该保留：

### 1. 模块化 Spring Boot 单体

当前设计没有真正拆成多个独立微服务，而是在一个 Spring Boot 应用内划分：

- `auth`
- `project`
- `workspace`
- `run`
- `log`
- `terminal`
- `audit`
- `kubernetes`
- `recovery`
- `persistence`

这是目前最合理的选择。

原始 PRD 提议了用户服务、项目服务、AI 服务、任务调度服务、容器运行服务、日志服务、评测服务、管理服务等多微服务：

- `D:\DeepLearning\MyProjects\Project_Manao\docs\Manao_PRD_V4-0.md:530-546`

但对于当前只有一个固定语言、一个运行命令、一个测试集群、一个后端 Deployment 的 POC，拆成微服务会增加：

- 网络调用；
- 配置中心；
- 服务发现；
- 分布式事务；
- 独立部署；
- 版本兼容；
- 观测与故障面。

**当前的模块化单体不是妥协，而是正确的架构决策。**

### 2. 权威事实分层

Stage 6 设计中明确区分：

- MySQL：用户、项目、Run 业务状态、ticket、审计；
- PVC：项目文件正文；
- Kubernetes：Job、Pod、运行事实、exec 状态。

见：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\docs\2026-08-27-ensoai-stage-6-real-backend-kubernetes-design.md:26-36`

这个分层是必要的。尤其是不能：

- 只相信浏览器里的 Run 状态；
- 只相信数据库里的 `RUNNING`；
- 让浏览器直接提交 Pod/PVC/Job 名称；
- 把 MySQL 当作文件正文数据库。

### 3. 浏览器不直接接触 Kubernetes 和 PVC

这条边界是正确的：

```text
Browser
  -> Main Backend
    -> Workspace Agent / Kubernetes
```

而不是：

```text
Browser
  -> Kubernetes API
Browser
  -> PVC
Browser
  -> Workspace Pod
```

这一点应该继续作为长期产品边界。

---

## 3.2 当前过度设计最集中的地方

### 过度点一：把“产品运行时”和“验收基础设施”混成了一个系统

当前 Stage 6 代码和计划同时包含：

- 项目创建；
- workspace agent；
- PVC；
- Job；
- Pod 日志；
- PTY；
- terminal audit；
- receipt；
- revision；
- reconciliation；
- instance lease；
- fencing token；
- SSH API tunnel；
- workspace port-forward；
- 动态端口池；
- project cleanup；
- C08 cleanup；
- cleanup ledger；
- fault operator；
- 独立 verifier；
- stress test；
- startup recovery；
- 受限 RBAC；
- 6B Deployment；
- probe；
- Secret；
- image digest；
- 证据包。

这已经不是单纯的“工作台原型”，而是：

> 一个带有测试资源管理器、故障实验平台和部署验收系统的工作台。

这些能力各自都有理由，但它们不应该全部和用户工作台处于同一个抽象层次。

当前后端生产代码约为：

- `poc4/backend/src/main/java`：103 个 Java 文件，约 7,802 行；
- `poc4/workspace-agent/src/main/java`：8 个 Java 文件，约 868 行；
- 前端 `src`：178 个 TypeScript/TSX 文件，约 42,595 行，其中包含测试文件。

代码量本身不是问题，但它说明当前 POC 的复杂度已经主要来自**生命周期和验证语义**，而不是来自用户功能。

### 建议的分层

应该明确拆成三个概念层：

```text
A. Workbench Runtime
   登录、项目、文件、保存、Run、日志、Terminal

B. Stage 6A Adapter
   local-cluster、SSH tunnel、workspace port-forward、Fabric8、kubectl

C. Stage 6 Operator
   测试项目登记、资源清理、故障注入、残留验证、证据台账
```

不一定要马上拆成三个 Maven/Node 项目，但至少要在包、接口和文档上形成边界。

尤其是这些内容不应该继续侵入普通产品路径：

- `C01-C08` cleanup 流程；
- 测试台账；
- operator 身份；
- 故障注入；
- 独立 verifier；
- 证据报告生成；
- diagnostic hold。

`ProjectCleanupService` 目前已经进入正式后端 API：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\backend\src\main\java\com\manao\poc4\project\ProjectCleanupService.java:31-62`
- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\backend\src\main\java\com\manao\poc4\project\ProjectController.java:63-70`

这可以作为测试环境的内部能力保留，但不要把它继续发展为当前产品的用户删除体系。

---

# 四、关键规格不一致

这是当前最需要优先处理的文档问题。

## 4.1 项目数量上限不一致

`plan.md` 写的是每个用户最多 3 个项目：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\docs\plan.md:13-20`
- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\docs\plan.md:60-66`

但当前代码和后续设计已经改成最多 8 个：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\backend\src\main\java\com\manao\poc4\project\ProjectLimits.java:3-6`
- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\docs\2026-08-27-ensoai-stage-6-real-backend-kubernetes-design.md:143-147`

这不是小问题，因为它影响：

- API 返回的 `limit`；
- 前端默认值；
- 并发创建测试；
- namespace 资源容量；
- 测试清理数量；
- 6A 验收前置条件。

**建议：将项目上限定义为单一配置源，并在 PRD、plan、design、backend、frontend、E2E 中统一。**

目前 8 并不一定是错误，但它不是“真正可用工作台”的核心能力，也不能被当成 Kubernetes 容量证明。

## 4.2 项目删除不一致

`plan.md` 将项目删除列为不包含：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\docs\plan.md:23-28`

但当前后端已有：

```text
DELETE /api/v1/projects/{projectId}
```

同时总体目标文档又把它解释成 Stage 6 的测试环境生命周期支持：

- `D:\DeepLearning\MyProjects\Project_Manao\docs\Manao-Projects-goal.md:38-46`

这个解释是合理的，但文档应明确区分：

```text
Project DELETE
= E2E/test-environment reclamation API

不是：

Project deletion product feature
Project archival
Recoverable deletion
Production storage lifecycle
```

## 4.3 证据文档未绑定当前代码

当前 Stage 6 worktree HEAD 是 `817e359`，但已有状态文档仍然引用更早的 SHA，例如：

- `D:\DeepLearning\MyProjects\Project_Manao\docs\what-we-have-done.md:45-54`

同时当前 worktree 还有未提交 cleanup 修改。

因此，所有当前结论都应标记为：

- 历史证据；
- 用户报告；
- 当前 SHA 静态代码；
- 当前 SHA 实测；
- 未绑定当前 SHA。

这也是为什么不能仅根据已有“5/5”报告宣布 6A 完成。

---

# 五、后端设计审查

## 5.1 Run 状态设计存在一个重要实现/设计张力

设计要求：

> Kubernetes API 短暂不可用时，保留数据库锁，不要直接把未确认状态改成终态。

见：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\docs\2026-08-27-ensoai-stage-6-real-backend-kubernetes-design.md:402-411`

但 `RunService.start()` 当前逻辑是：

```java
try {
    String jobRef = coordinator.ensureJob(...);
    ...
} catch (RuntimeException ex) {
    store.settle(runId, RunState.FAILED, "START_FAILED", null);
    throw ...
}
```

见：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\backend\src\main\java\com\manao\poc4\run\RunService.java:84-92`

这里存在一个典型的跨系统不确定性：

```text
数据库已写入 STARTING
Kubernetes create 可能已经成功
但 HTTP 响应可能在返回前丢失
后端把 DB 直接改成 FAILED
实际 Job 可能仍存在
```

这会造成：

- 数据库 Run = FAILED；
- Kubernetes Job = 真实存在或继续运行；
- 后续重试可能产生重复或孤儿资源；
- cleanup 需要额外猜测。

### 建议

将错误分成两类：

```text
确定性拒绝：
  Kubernetes 明确返回 400/403/422
  -> START_FAILED

传输不确定：
  timeout/reset/connection lost
  -> RECOVERING
  -> 通过 server-derived Job identity 查询
  -> 只有确认不存在后才能失败
```

这是当前最重要的后端状态一致性问题之一。

---

## 5.2 Workspace receipt 设计有价值，但不应该扩散到整个业务层

当前两阶段 workspace 写入协议是：

```text
MySQL PENDING
  -> agent 原子写
  -> receipt
  -> MySQL COMMITTED
  -> workspace_revision + 1
```

见：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\backend\src\main\java\com\manao\poc4\workspace\WorkspaceOperationService.java:13-17`
- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\backend\src\main\java\com\manao\poc4\workspace\WorkspaceOperationService.java:41-102`

这套设计并非无意义。它解决的是：

> 后端不知道远端写入到底成功还是失败时，不能盲目覆盖或重试。

对于真实 PVC 和网络桥接，这个问题确实存在。

但是当前设计的问题是：

- 普通保存也被迫进入复杂 receipt 语义；
- 模板初始化产生大量操作；
- `WorkspaceOperationService` 需要理解多种 mutation；
- recovery、project state、revision、agent receipt 互相耦合；
- 业务代码很难区分“正常保存”和“异常恢复”。

### 建议

保留它，但藏在一个边界接口后面：

```text
WorkspaceMutationPort
  - save
  - create
  - rename
  - delete
```

只有这个 adapter 负责：

- operationId；
- PENDING；
- receipt；
- digest；
- reconciliation。

上层 `WorkspaceService` 只看到：

```text
save(path, content, expectedRevision)
-> committed revision
-> revision conflict
-> reconciliation required
```

不要让项目、Run、前端协议都感知 receipt 细节。

另外，当前 receipt JSON 是手工字符串拼接：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\backend\src\main\java\com\manao\poc4\workspace\WorkspaceOperationService.java:287-296`

而路径策略没有禁止双引号。对于包含特殊字符的合法文件名，这可能产生无效 JSON 或错误 reconciliation。这里应当作为一个明确的技术风险记录。

---

## 5.3 Run/Terminal 对 PVC 的写权限与“显式保存”原则冲突

当前设计明确允许：

- Maven Job 写 PVC；
- Terminal 写 PVC；
- Shell 副作用保留；
- Run 结束后强制 reload。

见：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\docs\plan.md:99-103`

问题在于，工作台的核心交互又强调：

```text
用户编辑
  -> 显式 Save
  -> revision 增长
  -> Run 使用已保存版本
```

但 Terminal 或 Job 可以绕过 `workspace_operation` 直接修改源文件。

这会导致：

```text
MySQL revision = 10
PVC 源文件已经被 Shell 改了
前端模型仍认为 revision = 10
Run/Save 的一致性被破坏
```

当前设计试图通过扫描和 reconciliation 处理，但这会让用户看到：

- 保存没有问题；
- Terminal 也能写文件；
- 运行结束后突然进入 `WORKSPACE_RECONCILIATION_REQUIRED`；
- 工作区被锁住，需要 reload 或人工处理。

这对“真正可用”的工作台体验非常不友好。

### 我建议的 6A 方案

优先采用：

```text
项目源文件：只读挂载
Maven target / 临时产物：emptyDir 或 /tmp
Terminal：可以调试进程，但不能直接修改项目源文件
```

或者：

```text
Terminal 修改源文件时，必须显式标记为外部变更；
下次打开工作区时显示“检测到外部修改”，要求用户 reload。
```

对于 6A，第一种更适合。

**如果保留 Job/PTY 对源文件的写权限，当前 revision 体系会持续变复杂。**

---

## 5.4 Initializer 删除不应该阻塞项目进入 READY

当前创建流程：

```text
PVC
  -> initializer Pod
  -> workspace Pod
  -> Service
  -> 等待 Ready
  -> 删除 initializer
  -> 写模板
  -> READY
```

见：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\backend\src\main\java\com\manao\poc4\project\ProjectProvisioningService.java:137-155`

Initializer 删除本质上属于：

```text
one-shot cleanup
```

而不是：

```text
workspace readiness
```

如果 initializer 删除失败，不应该让一个已经可以工作的 workspace 重新变成创建失败。否则会出现：

- workspace Pod 已经 Ready；
- PVC 可用；
- 但由于删除辅助 Pod 失败，整个项目被标记为 FAILED；
- 后续 cleanup 又要处理一个“实际上已经可用”的项目。

### 建议

拆成：

```text
核心路径：
  PVC -> initializer succeeded -> workspace Ready -> template written -> READY

后台清理：
  删除 initializer
  删除失败记录为 cleanup_pending
  不阻塞 READY
```

这会显著降低项目创建失败率。

---

## 5.5 Run history 的 cursor 合同目前没有真正兑现

`RunController` 接收了 `cursor`：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\backend\src\main\java\com\manao\poc4\run\RunController.java:52-60`

但 `RunService.list()` 没有使用传入 cursor，而是每次从头查询：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\backend\src\main\java\com\manao\poc4\run\RunService.java:139-150`

这会使：

- 前端“加载更多”看起来有 cursor；
- 后端实际上可能重复返回同一页；
- 运行历史较多时无法真正分页。

这不是架构级问题，但属于“可用工作台”应该尽早修正的契约问题。

---

# 六、Workspace bridge 和 6A/6B 双 profile 审查

## 6.1 双 profile 作为验证策略是合理的

6A：

```text
本机 Vite
  -> 本机 Spring Boot
    -> 本机 MySQL
      -> SSH API tunnel
        -> 真实 Kubernetes
```

6B：

```text
本机 Vite
  -> backend Service port-forward
    -> 集群内 backend
      -> 集群 MySQL
      -> 集群 Kubernetes API
```

这个顺序对于排查问题很有价值：

- 6A 可以先隔离后端代码、数据库、Kubernetes 适配问题；
- 6B 再验证部署身份、ServiceAccount、Secret、探针和集群内访问。

因此，双 profile 不需要删除。

## 6.2 但 bridge 不应该成为产品领域对象

当前 `WorkspacePortForwardManager` 负责：

- 端口分配；
- 进程启动；
- listener 探测；
- 子进程重启；
- 引用计数；
- bridge hold；
- bridge release；
- shutdown；
- project 与本地端口映射。

见：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\backend\src\main\java\com\manao\poc4\kubernetes\WorkspacePortForwardManager.java:14-18`
- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\backend\src\main\java\com\manao\poc4\kubernetes\WorkspacePortForwardManager.java:114-149`
- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\backend\src\main\java\com\manao\poc4\kubernetes\WorkspacePortForwardManager.java:184-237`

这些是 6A 的部署适配问题，不应该出现在用户工作台模型中。

建议抽象为：

```text
WorkspaceEndpointResolver
```

产品层只需要知道：

```text
workspaceAgent.read(projectId, path)
workspaceAgent.write(projectId, ...)
```

而不是知道：

```text
bridge.allocate(projectId)
bridge.endpoint(projectId)
bridge.references(projectId)
bridge.hold(projectId)
```

---

# 七、前端设计审查：存在明确的结构冗余

当前生产工作台使用：

```text
WorkbenchShell
  -> EditorWorkspace
  -> RunPanel
  -> JobTerminalPanel
     -> JobTerminalController
     -> JobTerminalTransport
```

见：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\frontend\src\components\shell\WorkbenchShell.tsx:59-74`
- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\frontend\src\components\shell\WorkbenchShell.tsx:301-329`

但代码中还保留另一套终端路径：

```text
WorkbenchSpike
  -> TerminalPanel
     -> TerminalSession
     -> WebSocketTerminalTransport
```

当前 `TerminalPanel` 主要被 `WorkbenchSpike` 使用，而正式工作台使用的是 `JobTerminalPanel`。

相关文件包括：

- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\frontend\src\components\terminal\TerminalPanel.tsx`
- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\frontend\src\terminal\TerminalSession.ts`
- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\frontend\src\terminal\WebSocketTerminalTransport.ts`
- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\frontend\src\features\terminal\JobTerminalController.ts`
- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\frontend\src\features\terminal\JobTerminalTransport.ts`

## 判断

这里不是“抽象不足”，而是：

> Stage 0 Spike 的终端实现和 Stage 5/6 正式终端实现同时留在了生产源码树中。

建议：

1. 将 Spike 代码移动到明确的 `spike/` 或单独的 demo entry；
2. 正式路径只保留 `JobTerminalPanel -> JobTerminalController -> JobTerminalTransport`；
3. `TerminalSession` 和 `WebSocketTerminalTransport` 要么删除，要么明确标记为历史 Spike；
4. `ConnectionRegistry`、`WorkspaceResourceRegistry`、`appRuntime` 需要确认是否真的承担跨页面生命周期，否则可以合并为单一 `WorkbenchRuntimeRegistry`。

当前前端总体方向不需要重写，真正需要的是：

```text
清除历史路径
合并重复 transport
缩小全局 runtime 状态
```

而不是再增加新的 state manager 或新的 UI 层。

---

# 八、当前真正应该保留、简化和延期的内容

## 8.1 6A 必须保留

| 能力 | 判断 |
|---|---|
| JWT 登录和 owner authorization | 必须保留 |
| 项目创建和 READY/FAILED 状态 | 必须保留 |
| 文件树、读取、保存、创建、重命名、删除 | 必须保留 |
| 相对路径和 symlink containment | 必须保留 |
| workspace revision 冲突 | 必须保留 |
| 一个项目一个活动 Run | 必须保留 |
| 固定 Maven Job | 必须保留 |
| 真实日志 replay/live | 必须保留 |
| Stop、timeout、failed、succeeded | 必须保留 |
| 页面刷新和后端重启恢复 | 必须保留 |
| Terminal ticket 和旧 session 关闭 | 建议保留 |
| 基础 terminal audit | 建议保留 |
| 测试项目清理 | 必须保留，但应移到测试运维层 |

## 8.2 6A 可以保留，但不应阻塞黄金路径

| 能力 | 建议 |
|---|---|
| Workspace receipt | 保留在 adapter 内，不扩散到业务层 |
| `RECOVERING` | 保留为内部状态，UI 显示为“恢复中” |
| 本地 bridge manager | 作为 6A adapter 保留 |
| fencing token | 作为 6B 准备能力保留，但不要在普通业务中继续扩张 |
| 5 MiB 日志窗口 | 可以保留，当前规模下 MySQL 足够 |
| 7 天 retention | 可以保留，但不是 6A 黄金路径阻断项 |
| terminal credit/ack | 作为独立压力测试，不应阻塞普通 Terminal 可用性 |

## 8.3 应该延期到 6B 或独立产品切片

- 集群内 backend Deployment；
- ServiceAccount、Role、Secret、probe；
- 多副本一致性；
- 更完整的 fencing；
- 多节点调度和跨节点 PVC；
- 生产级网络隔离；
- egress allowlist；
- 恶意代码沙箱；
- 多语言；
- Git；
- AI 上下文、补丁、确认写入；
- 团队、教师、管理员；
- 计费；
- MongoDB、Redis、RabbitMQ、OSS；
- Prometheus、Grafana、Loki、KubeSphere、CI/CD。

**特别不建议为了“对齐 PRD”现在引入 MongoDB、Redis、RabbitMQ 或微服务。**

当前 POC4 用 MySQL + PVC + Kubernetes 已经足够支撑目标闭环。

---

# 九、建议的目标架构

## 9.1 用户工作台运行时

```text
Browser
  |
  | HTTP / WebSocket
  v
Modular Spring Boot Backend
  |
  +-- Auth / Owner Authorization
  +-- Project Service
  +-- Workspace Service
  +-- Run Service
  +-- Log Service
  +-- Terminal Service
  |
  +-- MySQL
  |     project
  |     workspace_revision
  |     run
  |     log window
  |     terminal session
  |     audit
  |
  +-- Workspace Adapter
  |     6A: local bridge
  |     6B: in-cluster Service
  |
  +-- Kubernetes Adapter
        Job / Pod / logs / exec
```

## 9.2 测试与运维层

```text
Stage6 Operator
  |
  +-- create registered project
  +-- cleanup project
  +-- C01-C08
  +-- fault injection
  +-- residual verifier
  +-- evidence ledger
```

它可以继续和前端 E2E 放在同一个仓库，但不应该和正式产品服务共享太多领域抽象。

---

# 十、真正可用的 6A 原型验收标准

建议把 6A 拆成“用户闭环验收”和“工程故障验收”。

## A. 用户闭环必须先通过

使用一个全新的 disposable user/project，完整验证：

```text
Login
  -> Create project
  -> Project READY
  -> Read template
  -> Edit file
  -> Save
  -> Read back saved content
  -> Start Run with exact revision
  -> Observe STARTING/RUNNING
  -> Receive real log marker
  -> Maven exit 0
  -> API Run = SUCCEEDED
  -> DB Run = SUCCEEDED
  -> Job = Complete
  -> Log contains expected output
  -> Workspace reload succeeds
  -> Edit becomes available
```

对于失败情况，再单独验证：

```text
compile failure
manual stop
timeout
backend restart during Run
```

其中最关键的是：

> 不能只验证“Run 最终进入任意终态”。

当前状态文档已经明确指出，基础 Run 测试接受任一终态，因此不能作为完整成功证明：

- `D:\DeepLearning\MyProjects\Project_Manao\docs\what-we-have-done.md:75-87`
- `D:\DeepLearning\MyProjects\Project_Manao\.worktree\ensoai-stage-6-real-backend-kubernetes\poc4\docs\evidence\stage-6\2026-09-10-status-and-next-steps.md:3-9`

## B. 工程验收独立执行

再单独执行：

- 8 MiB PTY；
- 256 KiB credit；
- 32 KiB 输出帧；
- 16 KiB 输入帧；
- 100+ resize；
- log replay/live byte conservation；
- bridge loss；
- SSH tunnel loss；
- backend restart；
- cleanup C01-C08；
- restricted RBAC；
- no resource residue。

这些属于**工程可信性和验收证据**，不应该反过来污染普通用户路径。

---

# 十一、建议的执行顺序

## 第一优先级：冻结规格

建立一个唯一的 6A 当前规格源，至少统一：

- 项目上限到底是 3 还是 8；
- DELETE 是测试接口还是产品接口；
- 当前有效 Git SHA；
- 6A 与 6B 的边界；
- Terminal 是否允许修改源文件；
- Run 成功的严格判定；
- 哪些测试是 `PASS`、`SKIPPED`、`WAIVED_BY_USER`、`FAILED`。

## 第二优先级：修正真实可用性阻断

优先处理：

1. Run 创建过程中 Kubernetes transport uncertainty 不能直接改成 FAILED；
2. Maven Job 的真实成功必须与 API/DB/Pod/log 一致；
3. Terminal/Job 对源文件的写入策略必须明确；
4. initializer 删除不能阻塞 READY；
5. Run history cursor 必须真正分页；
6. receipt 使用结构化 JSON；
7. 正式终端和 Spike 终端只保留一条生产路径。

## 第三优先级：完成 6A 用户闭环

不要先扩大压力和故障范围，先证明：

```text
真实创建
真实编辑
真实保存
真实 Maven 成功
真实日志
真实终态
真实 reload
```

## 第四优先级：完成工程 6A Gate

再补齐：

- PTY；
- audit；
- restart；
- bridge/tunnel loss；
- stress；
- cleanup；
- restricted identity；
- evidence package。

## 第五优先级：独立进入 6B

只有当前 SHA 获得独立 `6A PASS` 后，才进入：

- backend Deployment；
- cluster MySQL；
- ServiceAccount；
- Role；
- Secret；
- probes；
- cluster-side restart；
- 6B E2E。

---

# 最终判断

## 产品层

**方向正确。**

Manao 的核心不是 AI 聊天，也不是 Kubernetes 管理面板，而是：

> 一个能把编辑、运行、日志、反馈和继续修改连起来的云端开发工作台。

当前 POC4 的范围收窄是正确的。

## 架构层

**模块化单体正确；微服务和多数据源暂时是过度设计。**

应该保留：

- MySQL；
- PVC；
- Kubernetes；
- 后端代理；
- Run/Log/Terminal 核心边界。

不应该现在引入：

- MongoDB；
- Redis；
- RabbitMQ；
- OSS；
- API Gateway；
- Nacos；
- 独立 AI 编排服务；
- Prometheus/Grafana/Loki 作为 6A 必需依赖。

## 代码层

**后端不是需要推倒重写，而是需要降低跨层耦合。**

重点是：

- Run 不确定状态；
- Job/PTY 对文件 revision 的破坏；
- provisioning cleanup 阻塞 READY；
- product runtime 与 test operator 混杂；
- composition root 过大；
- local lock、DB lock、fencing 多套语义重叠。

## 前端层

**存在明确冗余，尤其是终端和 Spike 路径。**

应做结构收敛，而不是继续添加抽象。

## Stage 6A 状态

截至 **2026 年 9 月 14 日**，根据当前工作区和保留证据，最准确的结论仍然是：

```text
Stage 6A: INCOMPLETE / FAILED
Stage 6B: NOT_STARTED
Manao POC4: 尚未形成当前 SHA 下的完整真实可用闭环
```

但这不意味着项目方向失败。更准确地说：

> Manao 已经具备一个可信的 Stage 6A 技术基础，但当前实现把“工作台原型”“真实集群适配”“故障实验平台”和“验收证据系统”做得过于紧密。下一步不是继续堆功能，而是缩小用户闭环、隔离验收基础设施、修复跨系统状态不确定性，然后完成一次严格的真实 6A 验收。