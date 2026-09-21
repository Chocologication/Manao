# Java 运行环境：实施计划前的模块审查

**日期：** 2026-09-21
**基线：** 业务代码 `e9c702e`，上一轮设计 `4818bf3`；本轮尚未实施业务代码。
**方法：** codebase-design：先从用户结果反推 Module（模块）职责，再检查 Interface（调用方必须知道的契约）、Seam（可替换位置）、Adapter（实际实现），不按 Kubernetes 资源种类拆业务模块。
**关联规格：** [Java 项目运行环境升级设计](2026-09-21-java-project-runtime-design.md)。本记录不复制一套产品需求或验收矩阵。

## 1. 结论与一个待确认的产品行为

需要交付的是一次开发会话：创建环境 → 编辑 → 启动 Web 应用 → 从指定公网端口访问 → 停止/到期 → 修改后重新运行，数据库数据保留。不是通用应用托管、自动伸缩或多租户数据库平台。

已经可以直接落实的简化：

- 用户手填公网端口，所以删除“候选端口池、自动分配、冲突换号”设计，只做原值校验和准确申请。
- 容器端口只受 1–65535 的技术合法性约束，不增加平台保留业务端口；移除独立 18081 管理端口，复用主业务 HTTP readiness 路径。
- 延用现有单体、项目状态、Run 记录、工作区写锁、日志持久化与删除入口，不建设新的控制面服务、事件总线、Operator 或语言插件平台。
- 不把“任务型/服务型”产品概念强制映射成“Job/Deployment”两个控制器种类。当前新增的硬性 2 小时寿命，使复用 Job 成为值得优先考虑的更小方案。

**需要用户确认：应用进程异常退出后，首版是否可以报告失败，由用户手动再次运行，不自动恢复应用？**

若同意，推荐复用 Job + 应用 Service；若要求同一 Run 自动恢复，则保留 Deployment 方案并承担多代 Pod、剩余寿命、自动恢复与手动停止竞态等额外实现。此问题影响用户行为，不能仅以“技术优化”为由默默删掉恢复能力。

这里的“不自动恢复”只指用户应用进程；不取消 Manao 后端重启后的观察恢复，不取消 MySQL 数据保留或数据库自身控制器恢复，不取消对请求结果未知的核对。网络不可达不是“已失败/已退出”的证据。

在用户确认前不编写绑定某一执行方案的完整实施计划，也不把原草案里的 Deployment 写成已确认要求。

## 2. 仓库事实与复用收益

| 源码事实 | 对本次设计的影响 |
| --- | --- |
| [ProjectService](../../../poc4/backend/src/main/java/com/manao/poc4/project/ProjectService.java) 约 83 行，提供 owner-scoped create/list/get；[ProjectController](../../../poc4/backend/src/main/java/com/manao/poc4/project/ProjectController.java) 在创建后触发异步初始化 | 不需要仅为转发多建一层通用 ProjectManager；在创建入口统一配置契约，把 Kubernetes 副作用留在初始化内部 |
| [ProjectProvisioningService](../../../poc4/backend/src/main/java/com/manao/poc4/project/ProjectProvisioningService.java) 先建 PVC、initializer、workspace，写模板后 READY；失败会调用整个项目资源清理 | 增加数据库前必须明确“初次创建失败”与“已有数据的恢复失败”，不能沿用笼统 catch 后删除全部资源 |
| [RunService](../../../poc4/backend/src/main/java/com/manao/poc4/run/RunService.java) 已包含 revision、单活动 Run、租约及 start/stop；[JobCoordinator](../../../poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobCoordinator.java) 已提供 ensure/facts/stop | 若复用 Job，只需扩展模板/运行策略/就绪/到期，无需先发明通用 WorkloadCoordinator 和两条平行运行流程 |
| [JobResourceFactory](../../../poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobResourceFactory.java) 使用 `restartPolicy: Never`、`backoffLimit: 0`，当前时限从 Job 开始计算 | 适合显式启动的一次运行；但不能直接改成 activeDeadlineSeconds=7200 便声称满足“首次成功启动后 2 小时” |
| [RunObservationService](../../../poc4/backend/src/main/java/com/manao/poc4/run/RunObservationService.java) 与 [RunRecoveryService](../../../poc4/backend/src/main/java/com/manao/poc4/run/RunRecoveryService.java) 已观察现有 Job 并恢复状态 | 两条路径必须共用同一寿命/终态规则；后端恢复不是自动再次执行用户代码 |
| [RunLogIngestor](../../../poc4/backend/src/main/java/com/manao/poc4/log/RunLogIngestor.java) 已复用持久化序号和重接 | 不新增第二套日志存储或 WebSocket 通道；日志来源变化仍需准确识别，不把旧来源行号用于跳过新日志 |
| [ProjectResourceCleaner](../../../poc4/backend/src/main/java/com/manao/poc4/kubernetes/ProjectResourceCleaner.java) 的 deleteWorkloads 选择整个项目 Pod/Service；PV 查询依赖当前 PVC 列表和固定 workspace PVC 名称 | 工作区修复要缩小选择范围；多个 PVC 被删后仍需识别其历史绑定 PV，不能只增加一行创建 MySQL PVC |
| [ApiError](../../../poc4/backend/src/main/java/com/manao/poc4/api/ApiError.java) 有固定错误码与安全文案；[CreateProjectForm](../../../poc4/frontend/src/features/projects/CreateProjectForm.tsx) 当前只区分项目数上限和通用失败 | 端口冲突需要前后端一起增加有限错误码，否则会降级成“Request failed”，无法让用户改端口 |

## 3. 模块职责、调用接口和测试位置

### 3.1 项目创建与配置

**职责：** 接受用户意图，验证权限/配额/模板/端口/依赖选择，持久化一次创建的归属与配置，返回可观察项目。调用方不需要知道 PVC、Secret、Service 的创建顺序。

**保留：** `ProjectService`、`ProjectProvisioningService` 与 `ProjectLifecycleGate`；新的配置值对象留在 `project` 包内，不建通用配置框架。

建议接口形状（设计建议，不是已存在的方法）：

```java
record PublicPortMapping(String name, int targetPort, int publicPort) {}
record ProjectRuntimeSpec(String templateId, boolean mysql, boolean redis,
                          List<PublicPortMapping> publicPorts) {}

// 在现有 ProjectService 内扩展，旧 name-only 请求映射到原有默认配置。
Optional<Project> create(String ownerId, String name, ProjectRuntimeSpec runtime);
```

`Optional.empty` 继续表示现有配额/用户创建失败约定；端口/配置不合法和明确冲突用固定错误码。不要在浏览器、Controller、ResourceFactory 各自维护一套不同的规则。

**测试位置：** 扩展 [ProjectAuthorizationTest](../../../poc4/backend/src/test/java/com/manao/poc4/project/ProjectAuthorizationTest.java)、[ProjectProvisioningServiceTest](../../../poc4/backend/src/test/java/com/manao/poc4/project/ProjectProvisioningServiceTest.java)；新增 `project/ProjectRuntimeSpecTest.java` 验证配置值对象、`project/ProjectCreateHttpContractTest.java` 验证请求/响应和端口失败回到表单。持久化与迁移测试继续使用 [JdbcStoreTestSupport](../../../poc4/backend/src/test/java/com/manao/poc4/persistence/JdbcStoreTestSupport.java) 创建一次性 schema，不重置运行库。

### 3.2 公网端点

**职责：** 使用用户提交的精确端口建立/核对映射，切换所指向的当前 Run，停止转发但保留地址；不为用户选择替代端口。

只需要一个位于 `kubernetes` 包内的窄适配位置，让项目/运行模块得到 `CONFIRMED`、`CONFLICT` 或 `UNKNOWN` 等可操作结果；不能把 Fabric8 的任意异常透传成“端口占用”，也不能把 null 混为不存在/无权限/请求超时。实现方法可以表达为 `ensure(projectId, mappings)`、`routeToRun(projectId, runId)`、`withdraw(projectId)`，而不是暴露几十个 Kubernetes CRUD 调用。

生产使用已有 Fabric8 客户端，测试使用 fake/官方 mock server；不新增独立端口分配服务、端口租约数据库或候选端口扫描器。Kubernetes 的实际 Service 创建负责最终冲突仲裁，预校验只用于尽早反馈。

**创建失败必须闭环：**

- 请求内重复、越界、空值或平台保留端口，创建任何环境资源前拒绝；保留原输入。
- 可先做占用预检查，但不能据此保证随后的申请成功；真正申请安排在数据库依赖/数据卷初始化之前，以免普通端口冲突留下整套环境。
- 用户原值申请明确被拒绝时，只有证实没有该申请的 Service/环境副作用后，才可取消临时创建记录/释放本次配额并返回 409，让用户改号再提交；禁止失败项目不断累积占配额。
- 若请求结果未知，保留稳定项目/申请身份并核对，不自动新建第二个项目、不自动改号。实施计划需把这个状态纳入已有项目查询与创建结果恢复，不另建通用分布式事务平台。

**测试位置：** 新增 `kubernetes/PublicEndpointGatewayTest.java`，对 mock server 注入冲突/超时/已存在同一资源，观察 Service nodePort 始终等于用户输入；扩展 [ErrorSanitizationTest](../../../poc4/backend/src/test/java/com/manao/poc4/api/ErrorSanitizationTest.java) 和前端表单测试。不能在普通 mock CRUD 能创建对象后就声称真实集群端口冲突行为已验证。

### 3.3 应用执行与寿命

**职责：** 基于保存版本启动一次 Run；统一主动停止、失败、到期的状态、日志和写锁。保持现有 `RunService.start(ownerId, projectId, expectedRevision)` / `stop(ownerId, projectId, runId)` 的调用概念，不要求前端选择 Kubernetes 控制器。

真实差异是模板命令、成功判据和时限起点，不一定是控制器种类。普通 Java 的正常退出为成功；Web 服务的正常工作表现是就绪并接受请求，到期则是 TIMED_OUT。

**若采用推荐的无自动恢复方案：** 复用 `JobCoordinator`、`Fabric8JobCoordinator` 和身份校验；新增配置化 Web 命令及小型进程寿命执行器。`Clock` 注入现有运行逻辑用于确定性测试，不为计时单独搭调度平台。需要扩展 `RunPolicy` / `RunRecord` / `RunSummary` 的寿命和就绪字段，但不用因想象中的其他语言提前注册 Adapter。

2 小时执行器仍不可省：从首次 readiness 建立期限，控制 JVM/子进程；Manao 后端重启不能续时。Job 总期限可作额外兜底，但不能替代 readiness 起点的限制。`restartPolicy: Never` / `backoffLimit: 0` 也不是“任意故障下绝不补建 Pod”的绝对保证；若集群出现替代 Pod，原 Run 期限仍必须有效，无法核对则不启动用户代码。

**若保留自动恢复方案：** Job/Deployment 才是真正的两种 Adapter，届时再抽出共享的运行接口；不要现在把两套实现全部列入计划后再决定选哪一种。

**测试位置：** [RunControllerTest](../../../poc4/backend/src/test/java/com/manao/poc4/run/RunControllerTest.java)、[RunObservationServiceTest](../../../poc4/backend/src/test/java/com/manao/poc4/run/RunObservationServiceTest.java)、[RunRecoveryServiceTest](../../../poc4/backend/src/test/java/com/manao/poc4/run/RunRecoveryServiceTest.java)、[JobResourceFactoryTest](../../../poc4/backend/src/test/java/com/manao/poc4/kubernetes/JobResourceFactoryTest.java)、[Fabric8JobCoordinatorTest](../../../poc4/backend/src/test/java/com/manao/poc4/kubernetes/Fabric8JobCoordinatorTest.java)；新增寿命执行器的真实子进程测试位于 `poc4/maven-runner/tests/`。单元层用受控时钟，进程层验证确实退出，最后集中做一次正式 7200 秒验证，不在每层都等两小时。

### 3.4 项目依赖与清理

**职责：** 按选择创建或核对 MySQL/Redis，返回就绪状态与供运行模块使用的配置；停止应用不销毁数据；明确删除项目才回收全部归属资源。

保留项目级独立 MySQL PVC。依赖类型首版固定两个，使用一份 `ProjectDependencies` 配置与有限实现即可，不做 DatabaseProvider SPI、版本市场或任意 YAML 执行器。凭据与 Kubernetes 对象保持在实现内部，不进入浏览器 DTO。

清理复用 `ProjectCleanupService` → `ProjectResourceCleaner`，内部区分工作区修复与永久删除。`ProjectRuntimeCleaner` 当前负责关闭日志/socket/bridge 句柄，不因名称相近而塞入数据库卷删除逻辑。资源清单应是这个生命周期内部需要的最小持久化事实，不把一次 E2E 的证据台账变成通用产品模块。

**测试位置：** 扩展 [ProjectResourceCleanerTest](../../../poc4/backend/src/test/java/com/manao/poc4/kubernetes/ProjectResourceCleanerTest.java)、[ProjectStorageReclamationTest](../../../poc4/backend/src/test/java/com/manao/poc4/kubernetes/ProjectStorageReclamationTest.java)、[ProjectCleanupServiceTest](../../../poc4/backend/src/test/java/com/manao/poc4/project/ProjectCleanupServiceTest.java)；新增 `project/ProjectDependenciesTest.java` 测选择/恢复/凭据复用。正常替换数据库 Pod 的数据保留只由真实数据库与存储验证，不用一个 Mockito 返回 true 代替。

### 3.5 前端界面与契约

**职责：** 收集模板、依赖和双端口输入，显示字段错误、运行/就绪/剩余时间和访问地址；不承担保留端口权威、最终冲突判断、杀进程或重试未知变更。

延用 `CreateProjectForm` / `projectApi` / `projectQueries` / `contracts/project.ts`；每行明确“容器端口”和“公网端口”。只增加一个小型端口行视图（如果 JSX 复杂度确有必要），不建设动态表单框架。端口原值随请求提交，无自动补值。错误码同步修改 [ApiError](../../../poc4/backend/src/main/java/com/manao/poc4/api/ApiError.java) 和 [contracts/api.ts](../../../poc4/frontend/src/contracts/api.ts)，使用固定可理解文案。

继续使用 [RunPanel](../../../poc4/frontend/src/components/runs/RunPanel.tsx)、[RunToolbar](../../../poc4/frontend/src/components/runs/RunToolbar.tsx) 和现有日志通道。倒计时只展示 expiresAt 与当前时间差，浏览器关闭不影响执行时限。

**测试位置：** 在 [ProjectsPage.test.tsx](../../../poc4/frontend/src/features/projects/ProjectsPage.test.tsx) 覆盖创建流程；必要时新增 `CreateProjectForm.test.tsx` 承载输入组合，避免在两个文件重复同一断言。扩展 [RunPanel.test.tsx](../../../poc4/frontend/src/components/runs/RunPanel.test.tsx)、[contracts/run.test.ts](../../../poc4/frontend/src/contracts/run.test.ts)。一条新增的 `tests/e2e/java-runtime-lifecycle.spec.ts` 承担公网双端口、MySQL 数据保留、停止/到期与最终删除，复用现有 E2E 登录、Run 和 cleanup 工具。

## 4. 内部端口不设业务限制的具体影响

1. 请求接受 1–65535 的整数，不把 80 或 18081 特别禁止；拒绝 0、65536、非整数是协议合法性，不是新的产品范围限制。
2. 当前运行容器使用非 root 且丢弃能力，低端口是否能绑定取决于运行环境。实现时采用 Pod 范围的最小配置或经验证的等效方案，不为支持 80 把整个用户容器改成特权/root。
3. Kubernetes 官方将 `net.ipv4.ip_unprivileged_port_start` 列为安全 sysctl；可以作为 Linux Pod 内允许非 root 绑定低端口的候选。仍需实际验证目标运行环境，不能只凭表单通过宣告全部端口可用。
4. 不新增固定管理监听端口以抢占用户端口。readiness 使用 Spring Boot 主业务监听器上的最小检查路径；同 Pod 内两个用户进程抢同一端口仍是应用配置错误，不是平台自动替换端口的理由。

## 5. 测试接口纪律与停止扩张

- 纯配置/时间规则直接测函数与值对象；不为它们再造 Gateway。
- 数据持久化沿用真实 MySQL 一次性 schema 工具；不运行旧的运行库重置脚本。
- Kubernetes 调用留在 Adapter 内，用现有 Fabric8 mock server 测 manifest/错误映射，真实网络/存储行为由一次集中运行验收补足。
- 断言 observable 结果：用户端口不被改写、冲突可修改、进程到期退出、编辑锁只在停止被证实后释放、MySQL 数据保留与删除完整。不要断言私有 helper 的调用顺序来复述实现。
- 不因为新增此切片就重跑或补齐历史 PTY/压力/故障全矩阵。新增定向失败场景确实影响这些路径时再扩展。
- 只在新接口测试完整替代原有覆盖时删除重复测试；不能以简化为由移除不同失败模式的回归保护。

## 6. 下一步与证据边界

模块、调用契约、测试位置已经检查；手填公网端口及内部端口范围已同步规格。只剩“应用异常退出是否需要自动恢复”这一项产品行为会实质改变控制器与实现规模。

若用户同意手动重启，先同步规格为复用 Job 的最小方案，再用 Superpowers writing-plans 编写一个可逐项执行的计划；若用户要求自动恢复，再保留 Deployment 并明确额外测试。两种方向都保留 MySQL 双 PVC、成功启动后 2 小时硬性寿命与手工公网端口原值。

本轮未运行测试、未访问运行数据库、未启动/部署任何新工作负载；源码检查与官方资料核对不等于实施验证。

参考资料：

- [Kubernetes Job：期限、失败与重试](https://kubernetes.io/docs/concepts/workloads/controllers/job/)
- [Kubernetes Service：用户指定 NodePort 和端口冲突](https://kubernetes.io/docs/concepts/services-networking/service/)
- [Pod 安全 sysctl](https://kubernetes.io/docs/tasks/administer-cluster/sysctl-cluster/)
