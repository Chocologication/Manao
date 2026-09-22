# Java 项目运行环境升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use superpowers:subagent-driven-development only if the user explicitly requests delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户能创建普通 Java 或限时 Web 项目，手填公网端口、按需连接独立 MySQL/Redis，完成编辑—运行—访问—停止/到期—再次运行，并保留数据、完整删除项目。

**Architecture:** 保留现有单体、Job + Service、Run/日志/工作区锁，不新增用户应用 Deployment 或自动拉起。项目拥有配置和依赖，Run 拥有一次执行及不可变寿命；容器内 PID 1 运行器强制到期，后端核对真实事实再释放锁。清理扩展到数据库独立卷，不构建通用 Operator。

**Tech Stack:** Java 17、现有 Spring Boot 3.5.9、Fabric8 7.7.0、MySQL/Flyway；现有 React/Vite/Vitest/Playwright、pnpm 10.33.0。Maven runner 增加仅使用 JDK 标准库的小型运行器，不新增运行时语言或框架。

**Spec:** [收敛后的设计](../specs/2026-09-21-java-project-runtime-design.md)；先读 [codebase-design 模块审查](../specs/2026-09-21-java-runtime-module-review.md)。

**Status / baseline:** 原计划于 2026-09-21 基于 `e9c702e` 编写。2026-09-22 检查实施分支 `codex/java-runtime-implementation` 的 `ec14339`，已有原任务代码与 Task 8 准备记录；实际部署/验收以[运行时记录](../../../poc4/docs/evidence/java-runtime/acceptance.md)为准，不以本文尚未勾选的历史步骤推断任务未执行。实施前检查最新分支/未提交改动；文件路径相对于实际实施检出，不在 master 或已完成的 6B 工作树直接写实现。

**2026-09-22 已批准补充：** 按[Maven 缓存补充计划](2026-09-22-java-maven-cache-implementation-plan.md)实施镜像预置模板依赖与现有 workspace PVC 内的项目缓存。C1/C2 在 Task 9 之前完成，C3 并入 Task 9；不重新执行已完成的 Task 1–8，不新增依赖缓存 PVC。本次文档更新未实现或验收缓存。

## Global Constraints

- 应用异常退出后报告失败与日志，由用户手动再次运行；同一 Run 不自动拉起、不重新发额度。
- Web 首次成功启动后 7200 秒到期；初始启动预算 1800 秒；原普通 Java 保留 1800 秒总时限。请求、刷新、后端重启不续期。
- MySQL 使用独立 PVC，外加现有 workspace PVC 共两份；正常停止/超时/应用失败不删数据，明确删除项目才回收。
- publicPort 必须用户手填，整数 30000–31000；保留集合至少含 30080。无自动补值、选号或冲突换号。
- targetPort 为整数 1–65535，无人为低端口或 18081 禁区。TCP、最多3条映射仍沿用设计默认值。
- MySQL/Redis 不公开、不复用平台数据库；Redis 是非持久缓存。应用停止不等于暂停或删除依赖。
- Maven 缓存遵守设计 §7.5：镜像 seed 初始化、项目卷独立目录、后续按需下载；创建工作区不等待 Maven；不改变启动/运行期限，MySQL 仍使用独立卷。
- Unknown/Forbidden 不等于 Missing；不确定进程停止时保留锁。未知变更按稳定身份核对，不换 ID 盲重放。
- pnpm，禁止 npm；UTF-8 无 BOM；Windows 既有文件先读再改，Shell/Docker 入口 LF。不重置 `manao_poc4` / `manao_poc4_6b`，不执行宽泛 clean。
- 不增加 AI、其他语言实现、热更新、任意执行命令、自动休眠、数据库重置 UI、Redis 持久化、HA、完整 PTY/压力矩阵。
- 各任务先做范围内失败测试再最小实现；文档检查不写复述实现的测试。Mock 和配置存在不能替代公网/存储/进程验证。

## 1. 先确定模块和协议

### 1.1 模块职责与测试位置

| Module / Interface | 保留入口 | 必要新增 | 测试面 |
| --- | --- | --- | --- |
| 项目配置与创建 | ProjectService / Controller / ProvisioningService | RuntimeSpec、RuntimeStore（JDBC+测试） | 值对象、HTTP创建、一次性schema |
| 精确端口申请 | 项目/运行模块调用，不直接暴露给浏览器 | PublicEndpointGateway（Fabric8+测试） | manifest、冲突、超时核对 |
| 项目依赖 | ProjectProvisioningService / RunService | ProjectDependencies、DependencyResourceFactory | 选择四组合、凭据/PVC复用 |
| 单次执行与寿命 | JobCoordinator、RunService/Observation/Recovery、现有日志 | ExecutionReceipt、小型运行器 | Run契约＋真实子进程 |
| 清理 | ProjectCleanupService → ProjectResourceCleaner | 最小存储绑定记录 | 工作区修复/永久删除分别验证 |
| 前端 | CreateProjectForm、RunPanel、既有contracts/query | 必要端口行视图及测试 | 用户输入、错误、运行结果 |

不新增通用 WorkloadCoordinator、DatabaseProvider SPI、端口选号服务、第二套日志/WebSocket。纯值对象直接测方法；只有生产与测试确需替代的外部调用才设置接口。保留当前 Java record 风格，不引入 Lombok/新 ORM。

### 1.2 创建协议

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

- `POST /api/v1/projects` 保留；新表单每次明确创建尝试生成 creationKey，结果未知时保留 key 与相同请求。旧 name-only 请求映射 console/无依赖/无端口。
- `(owner_id, creation_key)` 唯一并存规范化请求摘要。同 key/同摘要返回同项目并核对状态；同 key/异摘要返回 `409 CREATE_REQUEST_MISMATCH`。用户修改明确被拒绝的请求后才换 key；不自动重试 POST。
- 新增 `GET /api/v1/projects/creation/{creationKey}`，仅按当前 owner 查询；单次404不能证明仍在处理的POST没有副作用。用户可显式继续同 key 的幂等申请，不能换 key 重放未知创建。
- 校验与端口申请在 PVC/Secret/依赖初始化之前。确定冲突且副作用排除后删除临时项目行/释放配额并返回409；Unknown保留CREATING与稳定身份，不累积半成品后还自动再建。
- 项目视图增加 runtime、endpointState、dependencies、endpoints（不含凭据/资源名）。READY仍表示工作区可编辑，依赖未ready禁止启动，不禁止看文件。
- Run启动请求不变，仍只有 expectedWorkspaceRevision；主端口取第一项targetPort，无公开映射时8080。额外监听器由应用代码实现。

### 1.3 数据与错误契约

新迁移 `V9__project_runtime.sql`：

```sql
ALTER TABLE project
  ADD COLUMN runtime_spec_json JSON NULL,
  ADD COLUMN creation_key VARCHAR(36) NULL,
  ADD COLUMN creation_digest CHAR(64) NULL,
  ADD COLUMN endpoint_state VARCHAR(16) NOT NULL DEFAULT 'NONE',
  ADD UNIQUE INDEX uq_project_creation (owner_id, creation_key);
ALTER TABLE run
  ADD COLUMN first_ready_at TIMESTAMP(6) NULL,
  ADD COLUMN expires_at TIMESTAMP(6) NULL,
  ADD COLUMN execution_pod_uid VARCHAR(64) NULL,
  ADD COLUMN termination_intent VARCHAR(40) NULL;
CREATE TABLE project_storage_binding (
  project_id VARCHAR(64) NOT NULL, purpose VARCHAR(16) NOT NULL,
  pvc_name VARCHAR(255) NOT NULL, pvc_uid VARCHAR(64) NULL,
  pv_name VARCHAR(255) NULL, pv_uid VARCHAR(64) NULL,
  PRIMARY KEY (project_id, purpose),
  CONSTRAINT fk_runtime_storage_project FOREIGN KEY (project_id)
    REFERENCES project(id) ON DELETE CASCADE,
  CONSTRAINT ck_runtime_storage_purpose CHECK (purpose IN ('WORKSPACE','MYSQL'))
) ENGINE=InnoDB;
```

JSON NULL按旧配置读取，不覆盖旧工作区。`policy_json`新增executionKind=TASK|SERVICE、startupTimeoutSeconds、serviceLifetimeSeconds；旧记录按TASK解释，不能混用原timeoutSeconds语义。storage_binding只记录两种已知卷，不扩成通用资源仓库。

API新增固定安全码：PUBLIC_PORT_RESERVED / PUBLIC_PORT_IN_USE / CREATE_REQUEST_MISMATCH（409）、DEPENDENCY_NOT_READY / DEPENDENCY_RECOVERY_REQUIRED（409）、PUBLIC_ENDPOINT_UNCONFIRMED（503）；输入不合法仍422 VALIDATION_ERROR。Run结果新增APPLICATION_EXITED、STARTUP_TIME_LIMIT_EXCEEDED，不混入API错误集合。错误文案是固定allowlist，不透传Kubernetes/数据库响应。

## Task 1：配置、迁移与旧项目兼容

**Files**
- Create: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectRuntimeSpec.java`, `poc4/backend/src/main/java/com/manao/poc4/project/ProjectRuntimeStore.java`, `poc4/backend/src/main/java/com/manao/poc4/project/JdbcProjectRuntimeStore.java`
- Create: `poc4/backend/src/main/resources/db/migration/V9__project_runtime.sql`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/BackendProperties.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectRuntimeSpecTest.java`, `poc4/backend/src/test/java/com/manao/poc4/project/ProjectRuntimeStoreTest.java`
- Modify test: `poc4/backend/src/test/java/com/manao/poc4/persistence/FlywaySchemaTest.java`

Files 中全部路径相对于实施检出根目录；新增文件在对应任务创建。测试新增端口名为小写DNS label（最多63字符、非空且唯一），创建key为UUID；规范化保持publicPorts顺序，因为第一项决定primaryPort。

**Interfaces**

```java
public record ProjectRuntimeSpec(String templateId, boolean mysql, boolean redis,
                                List<Port> publicPorts) {
    public record Port(String name, int targetPort, int publicPort) {}
    public static ProjectRuntimeSpec console();
    public boolean isService();
    public int primaryPort();
    public void validate(Set<Integer> reservedPublicPorts);
}
public interface ProjectRuntimeStore {
    ProjectRuntimeSpec loadSpec(String projectId);
    void setEndpointState(String projectId, String state);
    void rememberStorage(String projectId, StorageBinding binding);
    List<StorageBinding> storageBindings(String projectId);
    record StorageBinding(String purpose, String pvcName, String pvcUid,
                          String pvName, String pvUid) {}
}
```

这些是待实现声明，record需补方法体。创建key/配置在现有project INSERT事务内写入，不能先建项目后另存配置。配置增加保留端口（默认30080）、项目数据库镜像digest与StorageClass，只在选中对应依赖时强制存在，旧console不受影响。

- [ ] 写失败测试：合法内部端口1/80/8080/18081/65535、外部30000/31000、外部缺失/重复/越界、保留30080、console带端口、3条上限，以及V8→V9保留既有数据。

```java
@Test void acceptsInternalPort80ButRejectsReservedPublicPort() {
    var ok = new ProjectRuntimeSpec("java-spring-boot-web", false, false,
        List.of(new ProjectRuntimeSpec.Port("web", 80, 30081)));
    assertThatCode(() -> ok.validate(Set.of(30080))).doesNotThrowAnyException();
    var bad = new ProjectRuntimeSpec("java-spring-boot-web", false, false,
        List.of(new ProjectRuntimeSpec.Port("web", 8080, 30080)));
    assertThatThrownBy(() -> bad.validate(Set.of(30080)))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException)e).code()).isEqualTo("PUBLIC_PORT_RESERVED");
}
```

- [ ] 红灯命令（数据库权限/连接失败不是有效业务红灯）：

```powershell
mvn -q -f poc4/backend/pom.xml '-Dtest=ProjectRuntimeSpecTest,ProjectRuntimeStoreTest,FlywaySchemaTest' test
```

使用`JdbcStoreTestSupport.createAtVersion("8")`/`create()`随机schema，不reset运行库。

- [ ] 实现两个模板常量、规范化配置和摘要；迁移不改V1–V8。校验核心直接留在值对象，不引入通用validator注册器：

```java
if (port.targetPort() < 1 || port.targetPort() > 65535
    || port.publicPort() < 30000 || port.publicPort() > 31000) {
    throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
}
if (reservedPublicPorts.contains(port.publicPort())) {
    throw new ApiException("PUBLIC_PORT_RESERVED", 409, "Public port is reserved. Choose another port.");
}
```

测试JSON NULL兼容、同key竞争和两个存储绑定，不因代码写法而改变测试预期。
- [ ] 重跑同命令；`git diff --check`；逐个stage本任务文件并提交 `feat: add project runtime configuration and compatible schema`。

## Task 2：精确手填端口与创建结果核对

**Files**
- Create: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/PublicEndpointGateway.java`, `poc4/backend/src/main/java/com/manao/poc4/kubernetes/Fabric8PublicEndpointGateway.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectController.java`, `poc4/backend/src/main/java/com/manao/poc4/project/ProjectService.java`, `poc4/backend/src/main/java/com/manao/poc4/project/ProjectProvisioningService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/api/ApiError.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/WorkspaceConfig.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/PublicEndpointGatewayTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectCreateHttpContractTest.java`
- Modify test: `poc4/backend/src/test/java/com/manao/poc4/api/ErrorSanitizationTest.java`

**Interfaces**

```java
public interface PublicEndpointGateway {
    ApplyResult ensure(String projectId, List<ProjectRuntimeSpec.Port> ports);
    void routeToRun(String projectId, String runId, String podUid);
    void withdraw(String projectId);
    enum ApplyResult { CONFIRMED, CONFLICT, UNKNOWN }
}
// 扩展现有ProjectService；未知时保留CREATING项目身份。
Optional<ProjectService.Project> create(String ownerId, String name,
    String creationKey, ProjectRuntimeSpec runtime);
Optional<ProjectService.Project> findCreation(String ownerId, String creationKey);
```

Service名`manao-app-<projectId>`，初始selector为不匹配的`run-id=stopped`。一个Service包含整组映射，显式设置用户nodePort，不引入findNextFreePort；只公开用户应用，不修改workspace Service。

- [ ] 失败测试：HTTP 409保留端口/占用错误和零配额泄漏；注入Kubernetes明确的NodePort占用field cause，不能把任意422当冲突；同key/同摘要响应丢失不创建第二个项目；不同摘要拒绝。

```java
@Test void usesUserPortWithoutSubstitution() {
    var gateway = new Fabric8PublicEndpointGateway(client, "manao-test");
    var ports = List.of(new ProjectRuntimeSpec.Port("web", 80, 30081));
    assertThat(gateway.ensure("p1", ports)).isEqualTo(CONFIRMED);
    var service = client.services().inNamespace("manao-test").withName("manao-app-p1").get();
    assertThat(service.getSpec().getPorts().get(0).getNodePort()).isEqualTo(30081);
}
```

client/server fixture沿用`Fabric8JobCoordinatorTest`的官方mock server，静态导入ApplyResult.CONFIRMED；这是接口观察，不测私有helper。

- [ ] 运行红灯：

```powershell
mvn -q -f poc4/backend/pom.xml '-Dtest=PublicEndpointGatewayTest,ProjectCreateHttpContractTest,ErrorSanitizationTest' test
```

- [ ] 创建顺序：DB原子保存key/摘要/CREATING → ensure精确端口 → confirmed才异步建workspace/依赖。确定冲突且Service不存在则取消临时行/释放配额；Unknown保留记录并返回可查询状态。existing Service需验证project标签和整组端口，不覆盖他人资源。ServicePort构造核心：

```java
new ServicePortBuilder().withName(mapping.name()).withProtocol("TCP")
    .withPort(mapping.targetPort()).withTargetPort(new IntOrString(mapping.targetPort()))
    .withNodePort(mapping.publicPort()).build();
```

绝不在冲突catch中计算下一个端口；真正写入时所有映射同一Service事务申请。
- [ ] 创建查询/同key显式继续都复用稳定申请；后端恢复扫描CREATING/UNKNOWN核对，不在Controller无限重试。GET creation按owner隔离。端口错误同步加入ApiError固定集合/文案，避免被降级INTERNAL_ERROR。
- [ ] 绿灯、diff检查后提交 `feat: provision exact user-selected public ports`。Mock通过不意味着公网可达或集群竞争已经验收。

## Task 3：先修清理作用域，再创建新的依赖

**Files**
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/ProjectResourceCleaner.java`, `poc4/backend/src/main/java/com/manao/poc4/kubernetes/KubernetesGateway.java`, `poc4/backend/src/main/java/com/manao/poc4/kubernetes/Fabric8KubernetesGateway.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectCleanupService.java`, `poc4/backend/src/main/java/com/manao/poc4/project/ProjectProvisioningService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceJdbcStore.java`
- Modify tests: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/ProjectResourceCleanerTest.java`, `poc4/backend/src/test/java/com/manao/poc4/kubernetes/ProjectStorageReclamationTest.java`
- Modify tests: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectCleanupServiceTest.java`, `poc4/backend/src/test/java/com/manao/poc4/project/ProjectProvisioningServiceTest.java`

**Interfaces:** 保留`ProjectCleanupService.delete(ownerId, projectId)`。把含混的`deleteProjectWorkloads(projectId)`收窄并改名为`deleteWorkspaceWorkloads(projectId)`，更新所有调用点。完整cleaner消费Task 1的storageBindings，两种purpose有确定名称/UID，其他claim仍拒绝误删。

- [ ] 红灯场景：同项目标签的workspace/initializer、应用Service、MySQL/Redis并存；工作区修复只删除前两类。完整删除先控制器后Pod；两个PVC删除后重试还能凭已记住的PV/claim UID核对滞留卷。

```java
@Test void workspaceRepairKeepsOtherProjectComponents() {
    // 沿用ProjectResourceCleanerTest的manifest fixture，显式放入上述各component。
    cleaner.deleteWorkspaceWorkloads("p1");
    assertThat(client.services().inNamespace(NS).withName("manao-app-p1").get()).isNotNull();
    assertThat(client.pods().inNamespace(NS).withName("mysql-p1-0").get()).isNotNull();
}
```

- [ ] 测试命令：

```powershell
mvn -q -f poc4/backend/pom.xml '-Dtest=ProjectResourceCleanerTest,ProjectStorageReclamationTest,ProjectCleanupServiceTest,ProjectProvisioningServiceTest' test
```

- [ ] 实现component限定；完整集合包含应用Job、MySQL StatefulSet、Redis Deployment/ReplicaSet、Pod、Service、Secret、NetworkPolicy和两个PVC。工作区修复只选择两个已知component：

```java
boolean workspaceRepairTarget(String component) {
    return "workspace".equals(component) || "initializer".equals(component);
}
```

在已经按project/owner校验的清单上再应用此条件；依赖Pod使用正常grace，不能套用workspace的gracePeriod=0，停止未确认前不删卷。
- [ ] 旧`reclaimsStorage`拒绝非workspace PVC的单卷断言改成两个已登记purpose；删除PVC前持久化UID/PV，删除后/后端重启仍可核对。权限错误保持DELETING与绑定记录，不移除finalizer/PV或无关namespace。
- [ ] `ProjectRuntimeCleaner`仍只关闭日志/socket/bridge句柄；不塞入数据库卷删除。provisioning若可能有已有数据则保留并核对，不在笼统catch中删全部环境；无依赖旧console初始化语义按定向回归保留。
- [ ] 最终project行删除才级联移除storageBindings。绿灯与diff检查后提交 `fix: scope workspace recovery and preserve project storage identity`。

## Task 4：独立MySQL/Redis和可以直接连接的模板

**Files**
- Create: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectDependencies.java`
- Create: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/DependencyResourceFactory.java`, `poc4/backend/src/main/java/com/manao/poc4/kubernetes/Fabric8ProjectDependencies.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/project/ProjectProvisioningService.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/workspace/WorkspaceTemplate.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/WorkspaceConfig.java`
- Create: `poc4/backend/src/main/resources/workspace-template-web/pom.xml`, `poc4/backend/src/main/resources/workspace-template-web/README.md`
- Create: `poc4/backend/src/main/resources/workspace-template-web/src/main/resources/application.yml`
- Create: `poc4/backend/src/main/resources/workspace-template-web/src/main/java/com/example/app/App.java`, `poc4/backend/src/main/resources/workspace-template-web/src/main/java/com/example/app/DemoController.java`
- Modify: `poc4/backend/src/main/resources/workspace-template/pom.xml`（按选择生成，不覆盖已有项目）
- Test: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectDependenciesTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/DependencyResourceFactoryTest.java`
- Modify tests: `poc4/backend/src/test/java/com/manao/poc4/workspace/WorkspaceTemplateTest.java`, `poc4/backend/src/test/java/com/manao/poc4/workspace/WorkspaceTemplateClasspathResourceTest.java`

**Interfaces**

```java
public interface ProjectDependencies {
    void ensure(String projectId, ProjectRuntimeSpec spec);
    DependencyStatus status(String projectId, ProjectRuntimeSpec spec);
    List<EnvVar> applicationEnvironment(String projectId, ProjectRuntimeSpec spec);
    record DependencyStatus(String mysql, String redis) {}
}
```

EnvVar只用于内部Job构建，内容为Secret引用而不是密码明文，不从Controller暴露。状态使用ABSENT/PROVISIONING/READY/UNAVAILABLE/RECOVERY_REQUIRED，未选项ABSENT；远程未知不能等同ABSENT。Factory构造参数为namespace、固定镜像digest、storageClass、资源规格；`mysqlClaim(projectId)`返回PVC，`mysql(projectId,spec)`返回StatefulSet。

- [ ] 红灯测试选择四组合、重复ensure不换密码、现存PVC而Secret丢失时RECOVERY_REQUIRED且不初始化；浏览器/RunPolicy无凭据；停止Run不删依赖：

```java
@Test void mysqlUsesItsOwnClaim() {
    var spec = new ProjectRuntimeSpec("java-spring-boot-web", true, true, List.of());
    assertThat(factory.mysqlClaim("p1").getMetadata().getName())
        .isEqualTo("manao-mysql-pvc-p1")
        .isNotEqualTo(WorkspaceResourceFactory.pvcName("p1"));
    assertThat(factory.mysql("p1", spec).getSpec().getReplicas()).isEqualTo(1);
}
```

- [ ] 运行：

```powershell
mvn -q -f poc4/backend/pom.xml '-Dtest=ProjectDependenciesTest,DependencyResourceFactoryTest,WorkspaceTemplateTest,WorkspaceTemplateClasspathResourceTest' test
```

- [ ] MySQL采用显式PVC `manao-mysql-pvc-<projectId>`，5Gi起始建议容量，不依赖自动删卷特性。非root应用账号随机凭据只初始化一次；数据目录权限按所选镜像实测，失败不能删卷重置。Redis独立单副本Deployment关闭AOF/RDB，凭据由Secret/文件注入，不放命令行/日志。MySQL请求250m/512Mi、限制1CPU/1Gi；Redis请求100m/128Mi、限制500m/256Mi是预检起点，不冒充测得容量。
- [ ] 固定镜像tag先选择与环境兼容的MySQL 8.0.40及Redis 7.4系列的一个明确patch，并在Task 8记录不可变digest后部署；不在代码中使用latest或`7.4`浮动tag。没有实测仓库信息时不伪造digest。
- [ ] 内部Service＋只允许同项目应用访问3306/6379的NetworkPolicy；允许实际探针/初始化所需流量，不做全平台网络改造。存储语义及策略执行能力在真实环境验收，不能拿平台MySQL的永久保留卷混用。
- [ ] 两模板按spec选择依赖；Web仅选中时加入JDBC/Redis starter，环境MANAO_MYSQL_*/MANAO_REDIS_*映射Spring属性；示例建表用`CREATE TABLE IF NOT EXISTS`，不DROP。console选中时加入对应客户端和连接示例，不选时不引入数据库启动依赖。Secret引用构造保持在内部：

```java
new EnvVarBuilder().withName("MANAO_MYSQL_PASSWORD")
    .withNewValueFrom().withNewSecretKeyRef()
    .withName("manao-mysql-auth-" + projectId).withKey("password")
    .endSecretKeyRef().endValueFrom().build();
```
- [ ] `SERVER_PORT=primaryPort`；health路径`/actuator/health/readiness`，只开放health、详情never；readiness包含选中db/redis，未选不引用不存在的indicator。绿灯后提交 `feat: add persistent project dependencies and web template`。

## Task 5：单次运行器——ready后计时、终止进程、拒绝重跑

**Files**
- Create: `poc4/maven-runner/runtime/src/com/manao/runtime/RunDeadline.java`, `poc4/maven-runner/runtime/src/com/manao/runtime/WebRunSupervisor.java`
- Create: `poc4/maven-runner/runtime/test/com/manao/runtime/RunDeadlineTestMain.java`, `poc4/maven-runner/runtime/test/com/manao/runtime/RuntimeFixtureMain.java`
- Create: `poc4/maven-runner/tests/runtime-lifecycle.sh`
- Modify: `poc4/maven-runner/Dockerfile`

**Interfaces / protocol**

生产只有`run`与`probe`模式；run固定执行`mvn -q -DskipTests spring-boot:run`。测试fixture可构造测试子进程，但仅编译进runtime-test stage，生产不能通过环境传入任意命令。

```text
MANAO_RUN_ID, MANAO_PROJECT_ID, MANAO_POD_UID
MANAO_RUN_STARTUP_DEADLINE        # UTC Run.createdAt + 1800 seconds
MANAO_PRIMARY_PORT
MANAO_RUN_CONTROL_DIR=/run-control
MANAO_SERVICE_LIFETIME_SECONDS=7200  # server-derived
```

workspace PVC根下新增`.manao-runs/<runId>`，与代码目录并列，agent不挂载这个目录。runner仅挂本Run子目录到`/run-control`。`Files.createDirectory(claim)`原子认领，已存在即在用户代码启动前退出；同Pod UID也不能重跑。认领记录owner Pod UID，失败不清除。

收据`/run-control/receipt.properties`用临时文件→atomic rename更新；本地探针读`/tmp/manao-runtime.properties`。Properties白名单字段：protocol、projectId、runId、podUid、state、firstReadyAt、expiresAt、reason。state=CLAIMED/READY/EXITED/TIMED_OUT/STARTUP_TIMED_OUT/DENIED；不包含命令/凭据/日志。termination message路径`/tmp/manao-termination.log`，同协议最多2KiB。

实际计时使用单调时钟，UTC只展示/恢复；NFS I/O不得阻塞deadline线程。后端校验Job/Pod身份再解析，不能从普通stdout识别控制消息。认领记录不构成恶意代码防绕过认证，仍遵循受控MVP范围。

- [ ] 纯规则红灯：RunDeadline公开`ready(Instant utc,long nanos,Duration lifetime)`、`expired(long nowNanos)`、`expiresAt()`；重复ready不能延长：

```java
var deadline = new RunDeadline();
var first = Instant.parse("2026-09-21T10:05:00Z");
deadline.ready(first, 1000L, Duration.ofSeconds(7200));
deadline.ready(first.plusSeconds(60), 2000L, Duration.ofSeconds(7200));
if (!deadline.expiresAt().equals(first.plusSeconds(7200))) throw new AssertionError("renewed");
if (deadline.expired(1000L + Duration.ofSeconds(7199).toNanos())) throw new AssertionError("early");
if (!deadline.expired(1000L + Duration.ofSeconds(7200).toNanos())) throw new AssertionError("late");
```

- [ ] 新增runtime-test镜像阶段编译test mains；最终stage只复制production classes。测试脚本LF，使用唯一前缀创建自己的容器/卷并按精确名称清理；不能删除共享资源。

```powershell
docker build --target runtime-test -t manao-runner-runtime-test poc4/maven-runner
```

具备Docker CLI的Linux/WSL shell运行：

```bash
bash poc4/maven-runner/tests/runtime-lifecycle.sh manao-runner-runtime-test
```

- [ ] 脚本的真实进程红灯覆盖：readiness才开始短时限；长请求/忽略TERM的派生进程随PID 1退出；应用提前exit 0/1不重跑；同control目录第二容器被拒绝；后端不可用不影响计时；收据写失败不能无限运行。以docker wait/inspect及子进程证据断言，不仅grep日志。
- [ ] 最小实现：run模式确认`ProcessHandle.current().pid()==1`（probe作为exec子进程不要求PID 1）；独立deadline线程；JDK HttpClient有限timeout检查loopback主端口；第一次UP立即安装期限，随后写ready收据/本地probe状态。生产不使用hostPID/shareProcessNamespace。
- [ ] 初始启动预算从Run创建时间计算，启动太晚则不启动用户代码。到期终止用`Runtime.halt`结束PID 1以收掉独立PID namespace内派生进程，不能无限等shutdown hook。退出码：ready后到期124、启动超时126、重复认领125、非预期应用退出1；主动TERM优雅窗口不越过deadline。核心时限路径不包含任何网络/磁盘等待：

```java
if (deadline.expired(System.nanoTime())) {
    Runtime.getRuntime().halt(124);
}
```

截止前可提前写将到期的本地termination信息，实际终止以exit/时间事实核对；不能把预写的消息当作已经退出。
- [ ] 写收据要有限预算且不占deadline线程；记录I/O失败则不发布Ready并结束。Runtime.halt之前不能同步卡在NFS。真实容器测试验证派生进程消失；单元层不冒充容器保证。
- [ ] 绿灯后提交 `feat: enforce single web-run execution and readiness-based lifetime`。正式7200秒仅在Task 9运行一次，短测试不替代它。

## Task 6：接入既有Job / Run / 日志，不自动复活应用

**Files**
- Create: `poc4/backend/src/main/java/com/manao/poc4/run/RunExecutionReceipt.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/run/RunPolicy.java`, `poc4/backend/src/main/java/com/manao/poc4/run/RunRecord.java`, `poc4/backend/src/main/java/com/manao/poc4/run/RunSummary.java`, `poc4/backend/src/main/java/com/manao/poc4/run/RunStore.java`, `poc4/backend/src/main/java/com/manao/poc4/run/JdbcRunStore.java`, `poc4/backend/src/main/java/com/manao/poc4/run/RunService.java`, `poc4/backend/src/main/java/com/manao/poc4/run/RunObservationService.java`, `poc4/backend/src/main/java/com/manao/poc4/run/RunRecoveryService.java`, `poc4/backend/src/main/java/com/manao/poc4/run/RunStateReducer.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobResourceFactory.java`, `poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobCoordinator.java`, `poc4/backend/src/main/java/com/manao/poc4/kubernetes/Fabric8JobCoordinator.java`, `poc4/backend/src/main/java/com/manao/poc4/kubernetes/ResourceIdentityVerifier.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/log/RunLogIngestor.java`, `poc4/backend/src/main/java/com/manao/poc4/log/PodLogGateway.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/Fabric8PodLogGateway.java`
- Modify test: `poc4/backend/src/test/java/com/manao/poc4/log/RunLogIngestorTest.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/WorkspaceConfig.java`
- Modify tests: `poc4/backend/src/test/java/com/manao/poc4/run/RunControllerTest.java`, `poc4/backend/src/test/java/com/manao/poc4/run/RunObservationServiceTest.java`, `poc4/backend/src/test/java/com/manao/poc4/run/RunRecoveryServiceTest.java`, `poc4/backend/src/test/java/com/manao/poc4/run/JdbcRunStoreTest.java`
- Modify tests: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/JobResourceFactoryTest.java`, `poc4/backend/src/test/java/com/manao/poc4/kubernetes/Fabric8JobCoordinatorTest.java`, `poc4/backend/src/test/java/com/manao/poc4/kubernetes/ResourceIdentityVerifierTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/run/RunExecutionReceiptTest.java`

**Interfaces**

```java
public record RunExecutionReceipt(String projectId, String runId, String podUid,
                                  String state, Instant firstReadyAt,
                                  Instant expiresAt, String reason) {
    public static RunExecutionReceipt parse(String text);
}
// 挂在已有JobCoordinator，替代混用Optional.empty的观察接口。
record JobObservation(ObservationKind kind, JobFacts facts, RunExecutionReceipt receipt) {}
enum ObservationKind { FOUND, MISSING, UNKNOWN, IDENTITY_MISMATCH }
JobObservation observe(RunRecord run);
// RunStore新增；CAS/租约规则沿用既有写入模式。
boolean recordFirstReady(String runId, String podUid, Instant readyAt, Instant expiresAt);
boolean requestStop(String runId, String reason, long fencingToken);
```

JobFacts补应用ready/terminated、Pod UID、deadline和exit事实。任务内迁移全部facts调用点，不保留两套不同的unknown语义。requestStop原子写STOPPING和原因，不能重启后丢失用户停止/到期意图。RunSummary对TASK的firstReadyAt/expiresAt为null。

- [ ] 写收据/观察/恢复红灯：不合法寿命、错误Run/Pod UID、Job Failed＋DeadlineExceeded、Web exit0、后端在STOPPING时重启、Forbidden、重复ready、替代Pod DENIED，以及日志源不切到拒绝执行的容器。

```java
@Test void acceptsOnlyFixedLifetimeInReadyReceipt() {
    String receipt = "protocol=1\nprojectId=p1\nrunId=r1\npodUid=u1\nstate=READY\n"
        + "firstReadyAt=2026-09-21T10:05:00Z\nexpiresAt=2026-09-21T12:05:00Z\nreason=\n";
    var parsed = RunExecutionReceipt.parse(receipt);
    assertThat(Duration.between(parsed.firstReadyAt(), parsed.expiresAt())).isEqualTo(Duration.ofSeconds(7200));
    assertThatThrownBy(() -> RunExecutionReceipt.parse(receipt.replace("12:05:00", "13:05:00")))
        .isInstanceOf(IllegalArgumentException.class);
}
```

归属检查在coordinator验证完整Job/Pod链后对比run/receipt，不因parse成功就信任来源。测试模式短期限不能放宽生产receipt验证。

- [ ] 红灯/绿灯同命令：

```powershell
mvn -q -f poc4/backend/pom.xml '-Dtest=RunControllerTest,RunObservationServiceTest,RunRecoveryServiceTest,JdbcRunStoreTest,JobResourceFactoryTest,Fabric8JobCoordinatorTest,ResourceIdentityVerifierTest,RunExecutionReceiptTest,RunLogIngestorTest' test
```

- [ ] Web Job manifest：parallelism/completions=1、Never/0、activeDeadlineSeconds=9000；startupDeadline由Run.createdAt+1800派生。initContainer仅创建本run-control目录，不删旧claim；容器名仍`maven`，command为Supervisor，挂原代码subPath、单独control subPath和/tmp。普通console保留原命令/1800。
- [ ] 低端口使用Pod-scoped `net.ipv4.ip_unprivileged_port_start=0`，目标Linux不支持时真实测试明确失败，不能改成root规避。readinessProbe运行Supervisor probe检查ready marker、期限、当前主端口health，不额外占端口；terminationMessagePath指向/tmp的固定文件。
- [ ] 活跃时coordinator在验证过的Pod/container内执行固定`cat /run-control/receipt.properties`，有限输出/timeout；终止后读termination message。禁止浏览器选择路径、命令或Pod。Job/Pod与ownerReference均校验UID，不仅名称；记录认领Pod UID后只读该应用日志。
- [ ] 启动前确认选中依赖READY，否则DEPENDENCY_NOT_READY且不创建Run。Kubernetes写入超时按稳定Job身份核对，不重建第二个执行。后端验证/持久化ready时间，给认领Pod补server-side身份标签后routeToRun；Service selector匹配project/component/run/认领Pod。额外Pod即使出现也在claim阶段拒绝执行，不做自动恢复。
- [ ] DeadlineExceeded匹配Kubernetes Job condition的`type=Failed, reason=DeadlineExceeded`，分类优先于普通failed；Web ready后进程退出用APPLICATION_EXITED，startup时限用STARTUP_TIME_LIMIT_EXCEEDED，ready后124用TIME_LIMIT_EXCEEDED。观察与恢复共享这组规则，不复制两套分支。
- [ ] 手动停止前台删除Job、grace最多30秒不越deadline，stop不能无条件true。记录原UID与意图，核对原应用已终止且无其他活跃匹配Pod后才解锁；单独Job404不够。Unknown/Forbidden保留STOPPING；observation覆盖STOPPING，recovery不能把它变回RUNNING，不能ensureJob复活丢失应用。
- [ ] 日志只绑定认领Pod/容器，同源重接才跳已存前缀；拒绝执行的替代Pod不切换为新源。日志确实缺失时明确标记，历史不清空。绿灯和diff检查后提交 `feat: integrate bounded web sessions into existing runs`。

## Task 7：创建表单、冲突提示和运行寿命展示

**Files**
- Modify: `poc4/frontend/src/contracts/project.ts`, `poc4/frontend/src/contracts/api.ts`, `poc4/frontend/src/contracts/run.ts`, `poc4/frontend/src/contracts/run.test.ts`
- Modify: `poc4/frontend/src/api/projectApi.ts`
- Modify: `poc4/frontend/src/features/projects/CreateProjectForm.tsx`, `poc4/frontend/src/features/projects/projectQueries.ts`, `poc4/frontend/src/features/projects/ProjectCard.tsx`, `poc4/frontend/src/features/projects/WorkbenchPage.tsx`
- Modify: `poc4/frontend/src/components/runs/RunPanel.tsx`, `poc4/frontend/src/components/runs/RunToolbar.tsx`
- Modify: `poc4/frontend/src/mocks/state.ts`, `poc4/frontend/src/mocks/handlers.ts`, `poc4/frontend/src/mocks/runFixtures.ts`, `poc4/frontend/src/mocks/runHandlers.ts`（新契约fixture，不替代真实验收）
- Test: `poc4/frontend/src/features/projects/CreateProjectForm.test.tsx`
- Modify tests: `poc4/frontend/src/features/projects/ProjectsPage.test.tsx`, `poc4/frontend/src/features/projects/ProjectCard.test.tsx`
- Modify test: `poc4/frontend/src/components/runs/RunPanel.test.tsx`

**Interfaces:** 提交1.2节请求；ProjectSummary新增非敏感配置/状态；RunPolicy为TASK/SERVICE联合类型，旧payload按TASK兼容；RunSummary增加已验证firstReadyAt/expiresAt、availability。浏览器倒计时只展示，不是杀进程的权威。

- [ ] 红灯：公网空值不能提交；冲突409保留所有字段并提示改号、不自动换号；关公网提交空列表；container80/18081可填；响应丢失只查询/显式继续同creationKey，不能另起新key自动重试。测试通过userEvent操作，不直接改React状态。

```tsx
it('keeps the entered public port after conflict', async () => {
  server.use(http.post('/api/v1/projects', () => HttpResponse.json({
    code: 'PUBLIC_PORT_IN_USE', message: 'Public port is unavailable. Choose another port.',
    traceId: '00000000-0000-4000-8000-000000000001',
  }, { status: 409 })));
  renderApp({ initialEntries: ['/projects'] });
  await user.type(screen.getByLabelText('Project name'), 'demo');
  await user.selectOptions(screen.getByLabelText('Template'), 'java-spring-boot-web');
  await user.click(screen.getByLabelText('Public access'));
  await user.clear(screen.getByLabelText('Container port 1'));
  await user.type(screen.getByLabelText('Container port 1'), '8080');
  await user.type(screen.getByLabelText('Public port 1'), '30081');
  await user.click(screen.getByRole('button', { name: 'Create project' }));
  expect(await screen.findByText('Public port is unavailable. Choose another port.')).toBeVisible();
  expect(screen.getByLabelText('Public port 1')).toHaveValue(30081);
});
```

fixture沿用ProjectsPage.test.tsx登录及resetAppRuntime；user=userEvent.setup()。若复用UI库而不是原生select，则通过其可访问角色选择同一项，不为迎合测试改变产品行为。

- [ ] 红灯/绿灯与类型检查：

```powershell
pnpm --dir poc4/frontend test -- src/features/projects/CreateProjectForm.test.tsx src/features/projects/ProjectsPage.test.tsx src/components/runs/RunPanel.test.tsx src/contracts/run.test.ts
pnpm --dir poc4/frontend typecheck
```

- [ ] 复用既有控件；每行明确容器端口/公网端口，publicPort初值为空，placeholder不是value。成功后展示实际原值；确定拒绝并编辑后换creationKey，Unknown保留原请求并显示核对状态。新增错误码同步后端ApiError和前端contracts/api.ts。
- [ ] Web展示启动中/可访问/暂不可用/失败/已停止/达到两小时上限，区分地址存在与可访问；firstReady前不提前扣额度。reload不续期，后台终止与浏览器在线无关。保留Run写锁和未就绪依赖提示，不重写路由/编辑器。
- [ ] 不在前端自动重跑崩溃应用；不为端口行引入动态表单框架；避免CreateProjectForm与ProjectsPage重复同一测试。请求保留端口原值，不用 `|| fallback`：

```ts
const mapping = { name: `port-${index + 1}`, targetPort: Number(row.targetPort),
  publicPort: Number(row.publicPort) };
if (row.publicPort.trim() === '') return; // 阻止提交，不补默认公网号
```

联合类型解析仍校验有限状态/原因/时间范围，不以任意string替代原严格契约。绿灯后提交 `feat: expose manual ports dependencies and bounded run status`。

## Task 8：部署配置与独立的云端验收入口

**Files**
- Modify: `poc4/deploy/6b/backend-rbac.yaml`, `poc4/deploy/6b/configmap.yaml`, `poc4/deploy/6b/config.example.env`, `poc4/deploy/6b/README.md`
- Create: `poc4/frontend/playwright.java-runtime.config.ts`
- Create: `poc4/frontend/tests/e2e/java-runtime-lifecycle.spec.ts`
- Modify: `poc4/frontend/package.json`（增加test:e2e:java-runtime）
- Create during execution: `poc4/docs/evidence/java-runtime/acceptance.md`

**Interfaces:** 仅访问`MANAO_RUNTIME_BASE_URL`；账号来自私有环境MANAO_RUNTIME_USERNAME/PASSWORD。不启动本地服务。两条测试公网端口必须操作者通过MANAO_RUNTIME_PUBLIC_PORT_1/_2指定，不扫描空闲端口替用户选号。

- [ ] 配置不允许缺baseURL静默跳过；只有新spec、workers=1、retries=0、无webServer。不要修改旧stage6b config收集范围冒充旧阶段验收。

```ts
const baseURL = process.env.MANAO_RUNTIME_BASE_URL;
if (!baseURL) throw new Error('MANAO_RUNTIME_BASE_URL is required');
export default defineConfig({
  testDir: './tests/e2e', testMatch: /java-runtime-lifecycle\.spec\.ts/,
  workers: 1, retries: 0, webServer: undefined,
  timeout: 300_000, globalTimeout: 12_600_000,
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
```

最后两小时case单独`test.setTimeout(9_300_000)`，普通UI仍5分钟。只跑一次完整时限，不配置自动重试。

- [ ] Role只增实际namespace需求：statefulsets、Redis deployments/replicasets、secrets、networkpolicies、services patch/update、验证后Pod身份标签patch。既有pods/exec用于固定收据读取；跨namespace端口冲突由API裁决，不默认授予列全cluster Service、cluster-admin或PV删除。
- [ ] 实施部署前核对context/namespace、NodePort范围/公网规则、CNI策略执行、数据库存储语义/回收、镜像digest、CPU/内存预算。缺项记录真实阻断，不以八项目上限推断容量。本次计划编写不执行这些操作。
- [ ] 依现有维护流程构建/发布固定digest，不使用占位digest或浮动tag；实际仓库和MySQL/Redis版本解析结果记录在新acceptance与README。V9使用有权限的迁移身份，不换平台MySQL卷，切换期间不混跑不兼容后端。

```powershell
mvn -q -f poc4/backend/pom.xml -DskipTests package
pnpm --dir poc4/frontend typecheck
pnpm --dir poc4/frontend build
docker build -t manao-runner-java-runtime poc4/maven-runner
```

本地tag不是生产pin。发布命令沿用已验证部署README，以实际配置为准，不在本计划虚构registry地址/凭据。新版本的维护和接受结果记录到新文件，不提前修改旧6B PASS。

## Task 9：一条集中生命周期与正式两小时验证

**Files**
- Modify: `poc4/frontend/tests/e2e/java-runtime-lifecycle.spec.ts`
- Record: `poc4/docs/evidence/java-runtime/acceptance.md`
- Update after verified outcomes: `AGENTS.md`, `docs/Manao-Projects-goal.md`, `docs/what-we-have-done.md`, `poc4/deploy/6b/README.md`

**Interfaces:** UI是主操作面；Kubernetes/SQL/存储检查为独立事实，不直接改库绕过创建/停止/删除。

- [ ] 一个主项目启用MySQL+Redis、两条手填公网端口。先故意填30080，验证拒绝/保留输入/无配额泄漏，再改操作者指定值。第一容器端口80，另一端口9090由示例代码真实监听，两个公网请求各返回预期结果，不能仅检查Service对象。
- [ ] 通过应用写MySQL唯一记录与Redis键；停止→确认进程结束/可编辑→修改→再运行，核对代码变化、端口原值与数据仍在。一次编译失败或非预期exit后报告失败，确认没有自动再次执行；手动新Run才启动。
- [ ] 同项目正常重建一次MySQL Pod、一次Redis、一次后端，分别验证原卷原数据、缓存语义、只恢复观察不重跑应用。增加一个最小辅助项目检查凭据不通用与策略按项目生效，结束即清理，不变成全平台安全测试。
- [ ] 最后一个服务Run从首次Ready跑满正式7200秒；保留一个长请求/派生进程越过截止点来验证强制结束。记录firstReadyAt/expiresAt、本地执行器、真实容器exit、独立观察时间、两条端口和原数据。后端重启可并入本轮，不再重复。所有UI/API/DB/Job结果绑定同一个runId，不能把历史选中记录与最新Run混比。确认TIMED_OUT、不自动拉起、两个PVC和MySQL数据保留。
- [ ] 短时限测试、--list、页面倒计时或已发删除请求都不是两小时验收。失联/未知时保留最小同项目证据、不标PASS，不force-delete对象后声称进程已停；到期误差如实报告，业务仍忙不是续期理由。
- [ ] 最后UI删除主项目及辅助项目，逐类核对Job、workspace/initializer、MySQL StatefulSet、Redis Deployment/ReplicaSet、Pod/Service/Secret/NetworkPolicy、两个PVC/PV/实际存储、关联SQL行。平台MySQL卷/凭据和30080入口不得受影响。
- [ ] 原console跑一条定向兼容流程；结果记录PASS/FAILED/SKIPPED/NOT_REVERIFIED，不重启旧6A/6B门禁或全量PTY/压力套件。

```powershell
pnpm --dir poc4/frontend test:e2e:java-runtime
git diff --check
git status --short
```

仅在有新改动/失败/未解决疑点时扩展测试。按任务提交实现与脱敏证据；保留最新有用报告，只删本次不再需要且路径已检查的临时文件。不提交原始kubeconfig、密码、认证trace/录像，不宽泛git clean/mvn clean。

## 2. 自检映射与执行顺序

| 已确认要求 / 必要支撑 | 任务 |
| --- | --- |
| 手填公网端口、范围、容器合法值、绝不自动换号 | 1、2、6、7、9 |
| 冲突可修改、未知创建不重复占资源 | 1、2、7、9 |
| 独立MySQL PVC、凭据复用、停止后保留数据 | 3、4、9 |
| 无自动重跑、Job复用、ready后7200秒终止 | 5、6、9 |
| 初始启动失败/超时、Web退出不是成功 | 5、6、7、9 |
| 就绪/端口访问、用户日志与写锁 | 6、7、9 |
| 工作区修复不删依赖、完整永久删除 | 3、4、9 |
| 旧项目/旧Run兼容、运行库不重置 | 1、6、7、8、9 |
| 镜像预置依赖、项目 Maven 缓存、旧 PVC 兼容与提速证据 | 缓存补充 C1、C2、C3；C3 并入 9 |

原任务顺序：1→2→3→4→5→6→7→8→9；现有实施在 Task 9 前补充缓存 C1→C2，再合并执行 C3/Task 9。文件有交叠，不默认并行。每项包含自己的失败测试→最小实现→验证→提交，不为不变路径反复跑全套。部署容量、网络、镜像及存储事实需要实测，不能由文档代替。

**计划完成不等于实施完成。** 当前没有必需再次询问的产品选择；已公开的Redis缓存、3条端口上限等设计默认值不冒充新用户逐项确认。运行器控制目录复用workspace PVC的独立子目录，不增加第三个PVC，不等于MySQL与代码共用卷。
