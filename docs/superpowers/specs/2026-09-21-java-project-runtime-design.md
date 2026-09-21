# Java 项目运行环境升级设计

**日期：** 2026-09-21
**状态：** 用户已确认异常退出后手动再次运行、不自动拉起。产品范围与最小 Job + Service 方案已收敛，可编写实施计划；尚未实施或运行验收。
**代码基线：** `e9c702e`，包含已验收的 POC4 / Stage 6B 基线 `860cdda`。
**范围：** 多语言适配前的 Java 运行环境升级；不重新编号历史 POC，不改变 6A/6B 的验收结论。

**计划前审查结论：** [模块职责、接口和测试位置审查](2026-09-21-java-runtime-module-review.md)已完成，用户在 2026-09-21 同意应用异常后手动再次运行。首版复用现有 Job、Run 和日志流程，不增加用户应用 Deployment 或自动重试机制；MySQL/Redis 的项目级生命周期不受影响。具体步骤见[实施计划](../plans/2026-09-21-java-project-runtime-implementation-plan.md)。

## 1. 目标、已确认要求与默认选择

用户可以创建普通 Java 或 Spring Boot Web 项目，选择应用公网端口及项目专属 MySQL、Redis，完成编辑、启动、访问、查看日志、停止、修改、再次启动的循环。

已确认的要求：

- 多语言适配优先于 AI 验证；首先补充当前 Java 项目能力。
- 创建时可选择是否公开一个或多个应用端口。
- 创建时可独立选择 MySQL、Redis；它们服务于用户项目，与 Manao 平台数据库分开。
- 用户已明确确认：停止应用、修改代码、再次运行后，MySQL 数据仍保留。
- 用户同意沿上一轮推荐方向继续：应用与项目依赖分别管理，不要求同 Pod/Job。
- 用户再次明确选择：MySQL 使用独立数据 PVC，与代码工作区 PVC 分开；不改为共用卷。
- 应用成功启动后最多运行 2 小时，到期必须终止本次应用进程，不因仍有请求或后台工作而续期。
- 用户明确同意：用户应用异常退出后报告失败与日志，由用户手动再次运行；平台不自动拉起、重建同一次应用执行或续期。
- 用户确认公网侧 NodePort 必须为 30000–31000（含两端），且每个公开端口必须由用户手动填写；平台不得自动选择、补齐或因冲突更换端口。
- 与平台保留端口（含当前部署的 30080）或已占用端口冲突时，提示用户修改端口号，不抢占、不覆盖已有服务。
- 容器内部 targetPort 不设额外业务范围限制；只接受合法、确定的 TCP 端口整数 1–65535，0 不是可转发的确定端口。不再限定为 1024 起，也不保留 18081 等业务不可选端口。

下表是本设计提出的首版默认值，不作为用户逐项作出的独立决定：

| 事项 | 首版设计默认值 | 理由 |
| --- | --- | --- |
| 工作负载 | 普通 Java 与 Web 均复用 Job；Web 增加就绪与两小时寿命 | 异常后手动重跑已确认，无需应用 Deployment |
| 数据库控制器 | 每项目独立 MySQL StatefulSet；独立 PVC 已由用户确认，不再是待选项 | 数据归属项目，不随应用 Run 删除 |
| Redis | 每项目独立缓存实例；首版不提供持久化模式 | 避免把缓存和 MySQL 数据保留承诺混为一谈 |
| 停止应用 | 保留依赖实例、凭据、数据和应用端点地址 | 修改后重启不重新初始化环境 |
| 公网入口 | 使用用户必填的公网端口原值申请 NodePort，不自动选端口 | 手工填写、范围与冲突提示已确认 |
| 端口限制 | 每个 Web 项目 0–3 个公开 TCP 端口 | 支持多个端口且控制资源占用；属于可调整默认值 |
| 数据销毁 | 首版只由明确的项目删除流程回收平台管理的数据卷 | 数据库重置界面留待单独设计 |
| 修改流程 | 停止 → 确认停止完成 → 编辑保存 → 再启动 | 沿用保存版本与运行锁，不引入运行中编辑 |

MySQL 保留表示平台不会因停止、应用失败或重启主动清空数据库；不限制用户程序自行修改数据，也不承诺存储介质丢失后的灾难恢复。Redis 缓存仍可能因 TTL、逐出或 Redis 自身重建失效。

## 2. 当前代码事实与受影响位置

| 当前事实 | 源码 | 必要变化 |
| --- | --- | --- |
| 创建请求仅有 `name`，模板固定 Java/Maven | [ProjectController](../../../poc4/backend/src/main/java/com/manao/poc4/project/ProjectController.java)、[WorkspaceTemplate](../../../poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceTemplate.java) | 增加受控模板、端口和依赖配置 |
| 固定 Maven 命令、Job、1800 秒上限 | [JobResourceFactory](../../../poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobResourceFactory.java)、[BackendProperties](../../../poc4/backend/src/main/java/com/manao/poc4/config/BackendProperties.java) | 保留任务路径；服务路径使用不同运行策略 |
| 活动 Run 阻止文件写入 | [WorkspaceJdbcStore](../../../poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceJdbcStore.java) | 保留约束；停止必须以实际工作负载退出为依据 |
| workspace Service:8080 指向文件管理 agent | [WorkspaceResourceFactory](../../../poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspaceResourceFactory.java) | 新建应用 Service，不公开或复用 workspace Service |
| 运行观察和身份核验已支持 Job，固定容器名 `maven` | [RunObservationService](../../../poc4/backend/src/main/java/com/manao/poc4/run/RunObservationService.java)、[ResourceIdentityVerifier](../../../poc4/backend/src/main/java/com/manao/poc4/kubernetes/ResourceIdentityVerifier.java) | 复用 Job 身份链，补充 UID、就绪、期限及未知事实分类 |
| 日志 watch 按 Run 复用，重接时跳过已有日志前缀 | [RunLogIngestor](../../../poc4/backend/src/main/java/com/manao/poc4/log/RunLogIngestor.java) | 增加 Pod/container 实例维度，防止重建后跳错新日志 |
| 工作区恢复删除按项目标签选中的 Pod/Service | [ProjectResourceCleaner](../../../poc4/backend/src/main/java/com/manao/poc4/kubernetes/ProjectResourceCleaner.java) | 恢复必须限定 workspace/initializer，不能误删依赖或应用 |
| 完整清理以 Job/Pod/Service/PVC 为中心，PV 关联偏向单个 workspace PVC | 同上 | 纳入新控制器、Secret、策略和每个数据卷的完整清单 |
| 当前 Role 不含 Deployment、StatefulSet、Secret、NetworkPolicy 等写权限 | [backend-rbac.yaml](../../../poc4/deploy/6b/backend-rbac.yaml) | 在新功能部署中声明所需的命名空间权限；不是凭据刷新即可解决 |
| 前端 RunPolicy/原因码严格限定当前 Maven 流程 | [run.ts](../../../poc4/frontend/src/contracts/run.ts) | 联合类型识别任务/服务，保留旧记录兼容 |

以上是代码检查，不是新能力已经可用的证据。当前集群容量、网络规则和策略执行能力没有在本轮实测。

## 3. 产品概念与生命周期

产品术语见 [CONTEXT.md](../../../CONTEXT.md)。项目包含工作区、环境配置、项目依赖和多次 Run。每个项目仍最多有一个活动 Run；任务型与服务型执行共享这条约束。

| 用户操作或事件 | 应用与工作区 | MySQL | Redis 缓存 | 公开端点 |
| --- | --- | --- | --- | --- |
| 创建项目 | 生成工作区与模板；应用默认停止 | 选中则创建并初始化一次 | 选中则创建 | 选中则分配地址，显示“已分配，应用未启动” |
| 启动应用 | 校验保存版本；锁定编辑；等待依赖；启动 | 复用同一实例/数据卷/凭据 | 复用实例 | 就绪后才显示可访问 |
| 停止应用 | 持久化停止意图；清理本次执行；确认退出后解锁 | 不删除、不清空 | 不主动停止或清空 | 保留 Service 与地址，无活动应用流量 |
| 修改后再次启动 | 新 Run；读取新保存版本 | 原有表和数据保留 | 实例未重建时自然保留缓存，仍受 TTL/逐出影响 | 使用同一分配地址 |
| Java 应用启动失败 | 有限预算后报告失败；确认无残余应用后解锁 | 不删除 | 不删除 | 不报告在线 |
| 成功启动满 2 小时 | 终止本次应用进程，禁止该 Run 自动拉起；核对退出后记超时并解锁 | 不删除、不清空 | 不主动停止或清空 | 保留分配，停止对该 Run 转发 |
| MySQL Pod 正常重建 | 应用可临时不可用 | 挂载同一 PVC，恢复已有数据 | 不受平台主动影响 | 根据应用就绪情况显示 |
| Manao 后端重启 | 读取已有意图并核对运行事实 | 不初始化、不换密码、不删卷 | 不主动重建 | 沿用已有 Service 分配 |
| 删除项目 | 要求先停止活动 Run；进入 DELETING 后回收 | 删除该项目实例、凭据、卷 | 删除该项目实例与凭据 | 删除并释放外部端口 |

关闭工作台、退出登录或应用停止，都不等于删除项目，也不重置 2 小时计时。时限针对一次服务型应用 Run，不是项目生存期或数据库保留期；普通任务继续遵守原有 30 分钟总时限，提前结束不补足 2 小时。首版不增加“暂停整个环境”或数据库重置按钮。依赖在项目存续期间占用资源，容量预算必须包含它们。

## 4. 资源组织与方案取舍

```text
用户项目
├─ 工作区：现有 workspace agent + workspace PVC + 内部 Service
├─ 应用：每次 Run 的单次执行 Job（普通 Java 或限时 Web）
│  └─ 项目级应用 Service：ClusterIP；选择公开端口时使用 NodePort
├─ 可选 MySQL：单副本 StatefulSet + 内部 Service + 独立 PVC + 独立 Secret
└─ 可选 Redis：单副本 Deployment + 内部 Service + 独立 Secret（缓存）
```

应用到依赖使用集群内部地址。MySQL PVC 不属于应用 Job/Pod，也不挂载给 workspace agent；用户不能通过文件树编辑数据库内部文件。应用和依赖没有 Kubernetes 管理凭据。

初版沿用配置指定的工作负载 namespace，以后端生成的 owner/project/component 标签和持久化资源引用定位对象。它是受控 MVP 的资源组织，不把 namespace 或标签本身称为完整租户安全边界。

考虑过的替代方案：

- **同 Pod/Job 的应用和数据库：** 技术可行，连接可走 localhost，但应用重建与数据库生命周期耦合，普通常驻容器还影响 Job 完成。适合整套销毁的临时环境，本次不选。
- **多个项目共享一个 MySQL/Redis：** 资源较省，但增加权限划分、重置和删除归属问题。当前选择独立实例，避免把平台数据库也卷入此模型。
- **每个公网项目单独 LoadBalancer 或统一域名入口：** 可以作为后续接入方式；本次 NodePort 验证通过即可，不同时建设通用网关。
- **用户应用 Deployment：** 前期用于持续服务的候选；在用户明确两小时会话与异常后手动重跑后取消。Redis 依赖仍可用 Deployment，它不是用户应用运行。

MySQL 使用保留型卷生命周期：正常缩容、Pod 重建不删除 PVC；不依赖新版本的自动删卷特性。显式项目删除经过清理模块删除 PVC，再根据真实存储回收策略核对 PV/实际存储。

## 5. 创建配置、模板与连接信息

创建表单增加模板、依赖与公开端口映射。每项填写容器端口 targetPort 和公网端口 publicPort，publicPort 无自动默认值，留空不能提交。该公开端口是允许的产品配置，不接受任意镜像、Shell 命令、资源名或 Kubernetes YAML。

创建请求结构（与实施计划一致）：

```json
{
  "name": "orders-demo",
  "creationKey": "2a59d944-0bf2-453d-9410-d3cae7298ab8",
  "runtime": {
    "templateId": "java-spring-boot-web", "mysql": true, "redis": true,
    "publicPorts": [
      { "name": "web", "targetPort": 8080, "publicPort": 30081 },
      { "name": "api2", "targetPort": 9090, "publicPort": 30082 }
    ]
  }
}
```

creationKey 是一次明确创建尝试的稳定标识，不是授权边界。请求结果未知时保留同一 key 和规范化配置，通过 owner-scoped 查询核对；不同内容不能复用同一 key，不另换 key 盲重放。端口确定拒绝且没有副作用后，用户改号才开始新尝试。
模板首版为 `java-console` 和 `java-spring-boot-web`，Java 17。旧请求只提交 name 时保持 console/无依赖/无公开端口；已有项目按相同值迁移，禁止重新生成或覆盖旧工作区。

两种模板都可选择依赖。只有 Web 模板提供公网端口配置；console 若提交公开端口则明确拒绝，界面说明需选择持续服务模板。创建后首版配置固定，变更模板、依赖或端口留待单独设计，代码仍可正常编辑。

Web 模板使用固定 Spring Boot 3.5.9 作为与现有后端一致的起点，固定 Maven 插件版本和服务端执行命令；实现阶段完成实际构建验证，不将此版本称为最新版本。选中 MySQL/Redis 时才生成相应依赖与示例配置。示例只做可重复的非破坏性初始化，不能每次启动 DROP/重建现有库表。

用户应用获得通用 `MANAO_MYSQL_*` / `MANAO_REDIS_*` 连接环境变量；Web 模板可同时映射到 Spring datasource/Redis 属性。凭据经 Kubernetes Secret 引用注入，不写入源码、模板、平台日志、普通项目响应或 RunPolicy 快照。平台数据库仅存资源引用和非敏感配置。

MySQL 为每项目创建独立数据库、非 root 应用账号和随机密码；Redis 使用独立凭据。初始化只发生在新卷/新实例，重试或恢复必须复用凭据。若发现已有 MySQL PVC 却缺少原凭据或持久化身份不一致，停止并报告恢复问题，不能生成新密码后假装恢复成功，也不能重置数据。

## 6. 公网端口与可访问状态

- 每项目一个独立应用 Service；Service selector 必须同时匹配项目、应用组件及当前 Run，不能只用项目标签。
- 首版建议最多 3 个公开 TCP 端口；不公开时为空列表。每项名称、targetPort、publicPort 在该请求中分别唯一；targetPort 为整数 1–65535，publicPort 必填且为整数 30000–31000。例如公网 30081 → 应用 8080，二者不能混用。
- 公网端口由用户逐项手填；服务端把 publicPort 原值设置为 nodePort，缺失或不合法直接拒绝。无随机端口、候选端口池、自动补齐、冲突改选、自动改写请求；前端不得以初始值替用户选择公网端口。
- 30000–31000 共 1001 个整数端口，不代表全部可用。后端维护与部署配置一致的明确保留集合，当前包含 30080；平台临时下线也不得借出保留端口。其他项目或 namespace 已占用的 NodePort 同样拒绝；Kubernetes 创建 Service 的冲突结果是并发竞争的最后裁决，预检查不代表已占用成功。
- 确定的保留端口/占用冲突返回 HTTP 409 与固定安全错误码（建议 PUBLIC_PORT_RESERVED / PUBLIC_PORT_IN_USE），界面保留已填写配置并提示用户修改公网端口后重新提交；返回错误不能泄漏另一个项目的身份、资源名或 Kubernetes 原始响应。
- 使用稳定的项目 Service 身份申请用户填写的整组端口。创建超时/连接中断先核对同一 Service，不能换端口、换项目 ID 盲重放；并发冲突的失败方也只能提示用户改号。保持完整映射结果，不报告半套端口成功。
- 首版 Web 模板主端口默认 8080，但不保留独立的 18081 管理端口；健康检查复用主业务 HTTP 监听器的最小 readiness 路径，不公开其他管理端点。targetPort=18081 或低端口都不能被业务白名单拒绝。非 root 运行环境必须实际验证低端口绑定，不能只在表单中放行。配置额外端口只是转发，不自动让用户代码多启动监听器。
- 端口项返回名称、targetPort、已分配外部端口和访问地址；额外应用监听端口未开放时显示未就绪，不因为主端口可用就声称全部端口通过。
- 用户代码需监听 Pod 可达地址（模板使用 `0.0.0.0`），只监听 loopback 不能由 Service 转发。
- 采用 NodePort 不等于已公网可达。部署前核对集群配置的 NodePort 范围包含 30000–31000，并验证这个范围内实际分配端口的公网路由与防火墙；此需求只限制 Manao 接受的用户填写值，不授权修改集群全局端口范围或其他服务。当前平台的单个 NodePort 可达不能证明新分配端口也可达。
- 分开记录“地址已分配”“应用就绪”“公网访问实测通过”；平台不把公网探测结果冒充每一时刻的可用性保证。
- 停止应用时保留用户指定的 Service/NodePort，不再有活动端点。重新启动使用新的 Run selector；Service 意外丢失时只能核对并重新申请原值，若已被占用则报告不可用，不能自动换成另一个公网端口。
- MySQL、Redis 的 Service 均为内部服务；公开应用端口不改变这一点。workspace-agent 和平台后端接口不由此功能公开。应用自己的最小 readiness 路径可随其业务端口访问，但不携带敏感细节，也不额外暴露管理接口。

公网数据通道直接进入用户应用，不自动继承 Manao 登录权限；公开示例不含真实敏感业务数据，业务认证由应用实现。首版承接现有 HTTP/TCP 入口，HTTPS 与域名路由不在此切片内。

## 7. 任务与服务的运行契约

### 7.1 共同约束

沿用保存版本校验、一个活动 Run、租约/停止意图、Job 身份和现有日志。前端不携带镜像、Shell 或数据库密码，不选择 Kubernetes 控制器。新增模板/执行类型与寿命快照；旧 Run 按任务型读取，不构建通用 WorkloadCoordinator。

应用依赖尚未就绪时，创建页/工作台显示依赖状态；启动接口返回明确的 DEPENDENCY_NOT_READY，不创建一个长期等待依赖的 Run。依赖恢复后用户可再次点击启动；这不是自动执行用户代码。

### 7.2 任务型

保留 `mvn -q -DskipTests compile exec:java`、1800 秒总时限、退出结果和日志流程。选中依赖时注入连接配置，任务结束不删除依赖。

### 7.3 服务型：单次 Job + Service

- 一个显式启动对应一个 Run 和 Job，`completions=1`、`parallelism=1`、`restartPolicy=Never`、`backoffLimit=0`。应用异常退出、Pod 丢失或编译失败后不主动重建相同 Run 的应用；用户确认旧执行结束后手动新建 Run。
- 保留容器名 `maven` 和现有 Job 观察接口；Web 容器 PID 1 使用小型受控运行器，启动固定 `mvn -q -DskipTests spring-boot:run` 子进程并继承 stdout/stderr。不另起调度服务或 sidecar。
- 初始启动预算为从 Run 创建起 1800 秒，覆盖调度、拉镜像、构建和就绪；Job 总时限 9000 秒仅是 1800+7200 的兜底，不代替就绪后计时。未成功启动的应用仍受启动预算限制。
- 首次通过主业务端口 readiness 时，运行器立即安装单调时钟期限并写入独立运行收据。收据中的 `firstReadyAt` 表示这个首次成功时刻，`expiresAt = firstReadyAt + 7200s`。后端核对收据后持久化并报告成功，不能把后端稍后读到收据的时间当成新的起点。
- 工作区 PVC 中新增与代码目录并列的 `.manao-runs/<runId>` 控制目录，工作区编辑器和 Java 的 `/workspace` 均不包含它；不增加第三个 PVC。原子认领保证这个 Run 的用户程序只启动一次，失败后保留认领。它不是数据库数据目录；MySQL 仍使用独立 PVC。
- 收据必须由运行器固定格式写入，不从用户 stdout 解析；后端先核对 project/run/Job/Pod UID，再读取固定路径的收据或容器 termination message。终态收据不能用来复活已结束的 Run。
- 收到请求、空闲、就绪波动、浏览器刷新或后端重启不暂停/重置计时。例如 10:05 首次就绪，该 Run 12:05 到期；若 11:00 应用崩溃则结束为失败，不自动重启。用户之后明确启动的新 Run 才获得新的额度。
- `RUNNING` 表示应用进程存在；附加 `STARTING / READY / UNAVAILABLE` 表示服务可用性。主端口为第一项公开映射的 targetPort，没有公开端口时为 8080；模板以同一端口配置 SERVER_PORT 和 readiness，无额外保留管理端口。
- readiness 覆盖主监听器和选中的依赖；只开放最小 health 路径，不开放 env/config。Pod 不 Ready 时不发布服务端点；额外端口是否真实监听另行观察，配置转发不等于 Java 自动打开监听器。
- 已经 Ready 的应用若临时不可用，停止转发、显示 UNAVAILABLE，但不重启进程或重置寿命；用户可提前停止，最终仍受原到期时间限制。
- 未请求停止而服务进程退出（即使 exit code 0）是 FAILED / APPLICATION_EXITED，不是 BUILD_SUCCEEDED。用户停止为 CANCELLED / USER_STOPPED；到期为 TIMED_OUT / TIME_LIMIT_EXCEEDED；启动超时使用 TIMED_OUT / STARTUP_TIME_LIMIT_EXCEEDED。

### 7.3.1 到期终止与单次执行

2 小时是进程执行上限，不是到时才再给 30 秒，也不是只关闭 Service。运行器先准备截止前的优雅结束，截止时用不可阻塞的终止路径结束容器 PID 1；默认独立 PID namespace 下覆盖仍存活的 JVM 与派生进程。运行器检查自己确为 PID 1，禁止 hostPID/shareProcessNamespace；具体 Linux 容器行为必须由真实子进程测试验证。

运行器使用镜像中的固定代码和 JDK 标准库，独立于浏览器、Manao 后端是否在线。单调时钟用于实际计时，UTC 时间用于收据、审计和后端展示；收据写入阻塞不能卡住已安装的期限线程。认领或持久化失败则不对外就绪，按有限预算终止，不留下无期限应用。

Job 的 Never/0 不是对任意集群异常下零补建 Pod 的绝对承诺。新 Pod/容器若发现同 Run 已被认领，必须在启动用户代码前退出；不能凭同一个 Pod UID 允许容器重启后再次执行。后端核对持有认领的原 Pod，替代 Pod 的拒绝退出不能误伤仍在运行的原进程，也不能造成日志串源。

手动停止先持久化停止原因与 STOPPING，撤销转发，正常前台删除 Job 并核对原应用进程及全部本次 Run 的 Pod 已终止，再收尾日志、解锁。优雅预算最多 30 秒且不越过 expiresAt；观察预算 120 秒。未知、Forbidden 或节点失联不能当不存在，保留 STOPPING/RECOVERING 与写锁供继续核对。

到期本地执行器负责终止，后端核对收据和真实容器终态再报告 TIMED_OUT；不因后端晚读取几秒而重新发放寿命。不得把强制删除 API 对象或已发送删除请求当作进程已经退出。方案不承诺执行节点/内核完全失效时的硬实时行为，也不允许因业务仍忙而正常延期。

### 7.4 后端恢复与日志

- 后端重启恢复的是观察和控制意图，不重建已失败/丢失的应用执行；先核对 firstReadyAt/expiresAt、停止原因、认领收据和 Job/Pod UID。
- 普通观察与启动恢复共享同一终态判定：持久化停止原因、就绪后到期证据、Job DeadlineExceeded、应用退出。DeadlineExceeded 必须先于普通 Job failed 分类，不能把超时误报为 BUILD_FAILED。
- 明确的资源不存在与身份不符、API 不可用分别表示，不能继续使用一个 Optional.empty 同时代表这些事实。身份不符/多个未知 Pod 保持 RECOVERING，不释放编辑锁。
- 日志仍沿用现有持久化、重放与实时通道。对认领的 Pod UID 重接可去重；拒绝执行的替代 Pod 不成为用户日志源。原日志确实丢失时标记缺口，不靠新的 Pod 日志拼出“完整”历史。


## 8. 项目依赖、存储与隔离

依赖具有独立的期望配置和观察状态 `PROVISIONING` / `READY` / `UNAVAILABLE` / `DELETING`。工作区已可用不意味着所有依赖都 Ready；依赖失败不阻止查看和编辑代码，但启动应用需要其选中依赖就绪。

用户已明确选定 MySQL 使用一实例一 PVC，数据挂载与工作区分离：启用 MySQL 的项目拥有一个代码工作区 PVC 和一个 MySQL 数据 PVC。正常替换 Pod、重启应用、应用满 2 小时结束或后端恢复，都保留同一 MySQL PVC 和凭据；控制器缩容不触发删卷。存储类必须支持 MySQL 文件语义并在目标环境验证；旧 workspace 存储验证不能代替数据库写入及恢复验证。

Redis 首版明确是非持久缓存：应用停止不重建 Redis；Redis Pod/进程重建可以丢缓存。模板、界面和验收均使用这一语义。若后续需要持久化，需同时引入 PVC 与 Redis AOF/RDB 策略及其丢失窗口，不能只挂卷就声称已持久化。

每个依赖使用不同凭据与项目标签。ClusterIP 只表示不直接公网暴露，不提供项目间网络隔离；新增依赖的入站策略仅允许同项目应用 Pod 访问数据库端口，策略在依赖上线前生效。实现时验证 CNI 执行以及是否有其他叠加 allow 规则；不支持时明确报告该隔离项未满足，不默默当成成功。

工作负载不挂载平台数据库凭据；依赖凭据仅发给其项目应用。创建 Secrets/控制器所需权限在部署 Role 中明确限定 namespace 和资源种类。RBAC 不按标签限制 Secret 权限，因此仍需服务端归属验证，不能声称后端在 namespace 内只具有某一项目的 Secret 访问权。

资源预算包含 workspace、编译/应用、MySQL、Redis 与全部卷。资源规格和镜像 digest 在实现部署预检时确定并固定；尚未执行容量测量，不以“每用户最多 8 项目”推导可同时运行 8 套数据库环境。

## 9. 模块接口与持久化调整

保持现有单体与数据权威：MySQL 记录项目配置/意图/Run/日志/资源清单，PVC 保存对应数据，Kubernetes 提供真实工作负载和网络状态。

| 模块 | 对调用方提供的能力 | 模块内部承担的复杂性 |
| --- | --- | --- |
| 项目环境 | 创建配置、查询依赖与端点、核对环境 | 模板选择、依赖初始化、资源清单、凭据引用和一致性恢复 |
| 应用运行 | 启动、停止、观察某个 Run | 同一 Job 流程内的模板策略、就绪、寿命、身份核对和日志 |
| 项目清理 | 继续清理一个已进入 DELETING 的项目 | 控制器、子资源、数据卷、PV/存储、数据库行的有序清理与失败证据 |

接口不暴露 Fabric8 对象或让前端编排 Kubernetes。复用 `JobCoordinator` 和已有存储/日志适配位置，不新增只有一个实现的通用 WorkloadCoordinator，不提前引入各语言空实现。

建议持久化类别：项目的 template/execution kind；用户填写的公网/容器端口映射、申请状态与实际 NodePort；每项依赖的选择、状态与凭据引用；两个已知 PVC 的名称/UID/PV 绑定及其他资源的确定名称和归属；Run 的工作负载引用、firstReadyAt、不可变 expiresAt、7200 秒寿命策略快照、服务可用性和日志来源。具体表拆分、索引和 API DTO 在实施计划中确定。

数据库迁移必须向后兼容已有项目/Run，不改写已有工作区；必须使用一次性 schema 验证，不能重置平台的两个运行 schema。前端在严格解析中增加新类型和原因码，不能通过放开任意字符串回避契约。

## 10. 创建失败、恢复与删除

创建流程先验证手填端口与平台保留集合，再持久化规范化配置及稳定项目身份；优先申请这组明确的应用 Service 端口，证实无冲突后才继续 workspace、凭据和依赖初始化，避免普通输入冲突留下整套数据库环境。确定冲突且确认没有副作用时，取消本次临时创建占用并让用户在保留输入的表单中修改；请求结果未知则保留身份并核对，禁止换 ID 盲重试，不能在响应丢失后重复申请 Service、数据库或新密码。

初次创建部分失败时，保存实际完成清单和可恢复状态。不能未经核对就销毁可能含数据的 PVC。重试、后端恢复和工作区恢复均复用确认过的资源身份。

工作区恢复只清理 workspace/initializer Pod 与 workspace Service，保留应用/依赖控制器、数据卷、Secrets 和公开 Service。必须修改当前宽泛的 project-wide `deleteWorkloads` 行为，否则新增资源会被误删或不断重建。

删除仍先要求活动 Run 已停止，沿用当前活动 Run 的 409 拒绝行为并给出可操作提示。用户明确删除后：

1. owner 校验、持久化 DELETING、禁止新启动或环境补建。
2. 停止/删除该项目应用 Job、Redis Deployment、MySQL StatefulSet，等待控制器及其子资源消失；没有用户应用 Deployment。仅删依赖 Pod 会被控制器重新创建。
3. 删除项目的应用与依赖 Service、Secret、NetworkPolicy 等附属资源。
4. 最后删除 workspace 与 MySQL 等全部项目 PVC；依据记录的 claim UID/PV 关联核对 PV 和适用的实际存储残留，不能继续只核对单个 workspace PVC。
5. 完成资源确认后删除相应项目配置、端口、依赖、资源清单及原有关联记录。权限错误、超时或未知结果保留 DELETING 和最小证据，可继续；不能返回已删除。

删除入口提示 MySQL 数据永久删除；首版无归档、备份恢复或撤销。日常应用停止绝不进入上述删除路径。数据库 Pod 先尝试正常终止，不能把原有 workspace 的 gracePeriod=0 直接套用于数据库日常操作。

## 11. 验收与必要验证

不重新展开历史全量 PTY/压力/故障矩阵。围绕新增行为分层验证，已有未变路径不反复重跑。

针对新增契约和资源生命周期的测试：

- 旧请求/旧项目兼容；两个模板及依赖四种选择；端口校验、凭据不进入源码/API/日志。
- 复用 Job 的状态/身份核验；应用失败不自动执行，原子认领拒绝同 Run 再启动；停止与创建/后端恢复竞态，未知运行事实不解锁，拒绝执行的 Pod 不污染原日志。
- workspace 恢复不会删除依赖；完整删除覆盖控制器、Secret、策略、所有 PVC/PV，拒绝把 Forbidden 当不存在。
- 用户必填 publicPort，测试公网边界 30000/31000、越界 29999/31001、保留 30080、重复值、跨项目/namespace 冲突、并发竞争及响应丢失核对。断言 Service 中 nodePort 与用户输入逐项相同，冲突绝不换号，表单保留输入并提示修改。targetPort 校验覆盖 1/80/8080/18081/65535 可接受，0/65536/非整数拒绝；实际运行验证低端口确实能监听。
- 首次 Ready 才建立 7200 秒寿命；启动等待不吃掉运行额度，Ready 波动、应用请求、后端重启与 Pod/容器替换不重置期限；提前手动停止、新 Run 的新额度、到期的状态/原因码均与数据保留契约一致。

集中真实用户路径：

1. 建立一个同时选中 MySQL、Redis、两个应用监听端口的 Web 项目；确认 2 个不同外部 NodePort 正确返回各自预期内容。测试应用必须实际监听两个端口，不能只证明 Service 配置存在。
2. 通过应用写入 MySQL 一条可辨识记录，写入 Redis 缓存；停止应用，确认旧应用 Pod 已退出、编辑可用，MySQL PVC 与凭据身份不变。
3. 修改、保存、重新启动：新代码生效，两条端口映射仍可访问，MySQL 原记录保留，未重建 Redis 时不因应用重启主动丢缓存。
4. 同一项目制造一次编译失败后修复；数据、端口、日志和文件锁行为符合定义。
5. 正常重建一次该项目 MySQL Pod，确认同一卷和数据；正常重建 Redis，按缓存语义验证并准确展示结果。针对新增恢复行为做一次平台后端重启，核对不重置依赖、不盲重放运行。
6. 检查不同项目依赖凭据不通用、入站规则按项目生效；使用一个最小隔离验证项目，集中清理，不扩大成通用多租户安全测试。
7. 停止应用并删除主测试项目，逐类检查新旧资源、实际存储和平台关联记录；失败则保留该项目最小诊断。
8. 保留一个普通 Java 任务的针对性兼容验证，确认原有退出结果、停止、日志和编辑闭环仍成立。

时限额外验证集中在上述项目：

- 开发测试使用可控时钟/仅测试环境的短时限，验证截止前、截止时、截止后的状态与真实进程，覆盖长请求、拒绝优雅退出、异常替代 Pod 被拒绝执行和 Manao 后端不可用。缩短测试不改变正式 7200 秒策略，不能代替真实 2 小时验收。
- 正式验收保留一次按首次 Ready 计时的完整 7200 秒运行，记录 firstReadyAt/expiresAt、独立观测时间、进程实际退出时间、Pod/控制器状态、原数据与两个端口的结果。依赖和用户代码数据必须保留，到期后禁止该 Run 再执行用户代码；测试结束后按项目作用域清理。
- 容器/节点执行器与控制面的停止耗时、时钟误差如实记录；不能用“到期时后台任务已发出删除请求”冒充“应用进程已经退出”，不能把超期成功运行解释为宽限期。

实际报告区分 PASS、FAILED、SKIPPED、NOT_REVERIFIED；Mock、清单存在或 Service 创建成功均不等于公网访问和持久化验收成功。

## 12. 实施拆分与首版排除项

建议按同一产品切片分步落地：

1. 项目配置、模板及旧数据兼容；先收紧恢复/清理的组件选择，避免新增资源被旧逻辑误删。
2. 项目级 MySQL/Redis 与数据保留；数据库重建后仍可读是此步核心验证。
3. 服务型 Run、就绪/停止/日志恢复；保留现有任务型路径。
4. 多端口公网入口、创建表单及访问状态；再做一条集中真实生命周期验收。

本次不包含 AI、其他语言实现、用户应用自动恢复、热更新、运行中编辑、混合语言项目、自选镜像/命令、任意数据库版本、数据库公网连接、数据库重置产品功能、Redis 持久化模式、自动休眠、HA 或完整生产隔离认证。端口/运行/依赖配置保持语言无关，下一步增加语言时复用这些能力。

本设计已按用户确认收敛，配套[实施计划](../plans/2026-09-21-java-project-runtime-implementation-plan.md)给出接口、迁移、任务与验证步骤。设计/计划完成不等于业务实施、部署或新功能验收完成。

## 13. 资料与证据范围

本轮只读检查当前代码并查询官方资料，未启动服务、未操作运行 schema、未创建或删除集群资源。设计默认值不是实测容量或可用性承诺。

- [Kubernetes Service 与多端口/NodePort](https://kubernetes.io/docs/concepts/services-networking/service/)
- [Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Pod 终止与强制删除的区别](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)
- [StatefulSet 卷保留策略](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/#persistentvolumeclaim-retention)
- [删除 StatefulSet 与数据卷](https://kubernetes.io/docs/tasks/run-application/delete-stateful-set/)
- [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Spring Boot 3.5 外部配置](https://docs.spring.io/spring-boot/3.5/reference/features/external-config.html)
- [Spring Boot 3.5 Actuator probes](https://docs.spring.io/spring-boot/3.5/reference/actuator/endpoints.html#actuator.endpoints.kubernetes-probes)
- [Redis 持久化模式](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
