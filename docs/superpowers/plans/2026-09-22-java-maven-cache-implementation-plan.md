# Java Maven 预置依赖与项目缓存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans，按 C1 → C2 → C3 顺序执行。业务变更使用 TDD；不默认派生子 agent，不重新执行已完成的原计划任务。步骤使用复选框记录真实结果。

**Goal:** 标准 Spring Boot 模板首次运行复用镜像中已准备的依赖；同项目后续运行复用 workspace PVC 中的 Maven 缓存，新增依赖按需下载，不增加依赖缓存 PVC。

**Architecture:** 运行镜像提供只读预置仓库；每个项目在现有 workspace PVC 的独立 subPath 拥有可写仓库。一个小型固定 Maven 启动包装器完成幂等初始化后 `exec mvn`，Web 仍由现有 PID 1 监督进程先认领、再启动受控子进程。

**Tech Stack:** 当前 Java 17、Maven runner 的 Maven 3.9.9、Spring Boot 3.5.9；现有 Bash、Docker BuildKit、Fabric8、JUnit。此切片不升级工具链、不引入新运行时。

**Spec:** [设计 §7.5](../specs/2026-09-21-java-project-runtime-design.md#75-maven-预置依赖与项目缓存2026-09-22-补充)；实施前读[模块审查 §3.6](../specs/2026-09-21-java-runtime-module-review.md#36-maven-预置与缓存2026-09-22-补充)。

**Status / baseline:** 2026-09-22 用户已确认方案。本文件基于实施分支 `codex/java-runtime-implementation`、`ec14339` 的代码检查编写；仅完成文档，缓存实现、镜像发布和提速测量尚未执行。原计划 Task 8 已有准备记录，云端结果以[运行时验收记录](../../../poc4/docs/evidence/java-runtime/acceptance.md)为准，不能把旧 6B PASS 当成本功能验收。

## Global Constraints

- 当前实施检出为仓库内 `.worktree/java-runtime-implementation`；先检查分支、最新 HEAD 和未提交改动，保留其他 agent 的工作。本文链接均按仓库相对路径解析。
- 不新增 PVC、数据库表、storage binding、前端选项或缓存服务。MySQL 数据继续使用独立 PVC。
- 预置模板依赖与插件，不下载全部 Spring 生态；用户项目依赖仍由其 POM 决定。
- 创建工作区只准备必要目录，不拉取 Maven 依赖、不复制大仓库、不等待 Maven 构建。优化对象是首次和后续 Run。
- 初始启动预算 1800 秒、Web 首次 Ready 后 7200 秒、console 总时限 1800 秒保持不变。失败后手动新 Run，既有认领、停止、写锁及日志契约保持不变。
- pnpm，禁止 npm；UTF-8 无 BOM，Markdown 保持检出行尾，Shell/Docker 入口 LF。缓存初始化不能把应用容器改为 root。
- 不复用宿主机整个 `.m2` 作为镜像输入；预置仓库不包含私有依赖、settings 凭据、密码或运行收据。Docker 构建上下文限于 runner 和明确导出的模板。
- Python/Go 仅保留相同的项目缓存生命周期原则；本次不实现多语言缓存框架、共享卷、Nexus、自动清扫或缓存管理 UI。
- 当前没有实测首跑或复跑秒数。60 秒/30 秒只可作为后续讨论的参考目标，不是本次已经承诺或通过的门槛。

## 1. 文件职责与内部契约

| 文件 | 改动与职责 |
| --- | --- |
| `poc4/backend/src/test/java/com/manao/poc4/workspace/MavenSeedTemplateExporter.java`（新增） | 仅构建/测试用入口，调用真实 `WorkspaceTemplate.files(spec)` 导出五份模板；不复制模板渲染逻辑 |
| `poc4/maven-runner/prepare-maven-seed.sh`（新增） | 镜像构建时准备这些模板的仓库，产生预置内容版本；不接触用户项目 |
| `poc4/maven-runner/Dockerfile` | 独立 seed 构建层、拷贝预置仓库与固定包装器，生产/runtime-test 使用相同预置内容 |
| `poc4/maven-runner/manao-maven`（新增） | 初始化/补齐项目缓存并执行 Maven；固定镜像内程序，root 所有且不可由用户修改 |
| `poc4/backend/src/main/java/com/manao/poc4/kubernetes/WorkspaceResourceFactory.java` | 统一缓存 subPath 常量，新项目创建空目录及所需权限 |
| `poc4/backend/src/main/java/com/manao/poc4/kubernetes/JobResourceFactory.java` | 两种 Job 的缓存挂载、旧项目目录补建、固定包装器/本地仓库参数 |
| `poc4/maven-runner/runtime/src/com/manao/runtime/WebRunSupervisor.java` | 固定子命令改用包装器；认领和监督顺序保持原样，不在认领前执行用户构建 |
| 既有 `WorkspaceResourceFactoryTest` / `JobResourceFactoryTest` | 验证实际生成 manifest 的挂载、身份、命令与兼容性 |
| `poc4/maven-runner/tests/maven-cache.sh`（新增） | Linux Docker 中验证复制、离线运行、增量依赖与跨容器复用；所有临时资源按本次精确名称清理 |
| 既有 `runtime-lifecycle.sh` 与 `java-runtime-lifecycle.spec.ts` | 保留 PID 1/认领/停止/到期回归；云端性能取证并入原生命周期 |

文件路径均相对于实际实施检出。不增加 CacheService/Provider/Gateway，也不改项目创建 HTTP 契约。现有 `RunService.start(ownerId, projectId, expectedRevision)` 无需知道缓存实现。

### 1.1 固定路径

```text
运行镜像
  /opt/manao-maven-seed/repository/   预置仓库，只读
  /opt/manao-maven-seed/seed-id       基于模板/工具版本和预置文件内容生成

每项目 workspace PVC 根目录
  project-<projectId>/               原代码目录
  .manao-cache/maven/
    repository/                     此项目可写的 Maven 本地仓库
    seeded-<seed-id>                 完整初始化后才原子写入的完成标记

Run 容器
  /workspace                        原代码 subPath
  /maven-cache                      .manao-cache/maven subPath
```

`.manao-runs` 的归属和认领协议沿用原设计，缓存不能存入或清理其目录。workspace agent 不挂载缓存，文件 API/编辑器不出现该目录。代码和缓存共享现有卷容量，不以 PVC 声明大小推断存储实际强制配额。

### 1.2 执行顺序

```text
Run 目录准备 init container（只建缓存目录/权限，不运行 Maven）
  -> console: manao-maven -> exec mvn -q -DskipTests compile exec:java
  -> Web: supervisor 作为 PID 1 -> claim -> 受监督的 manao-maven
          -> exec mvn -q -DskipTests spring-boot:run
```

包装器显式将 Maven 本地仓库指向 `/maven-cache/repository`，例如在固定命令中传入 `-Dmaven.repo.local=/maven-cache/repository`；不能仅设置 `HOME`/`MAVEN_CONFIG` 后假定 Maven 会使用该目录。生产参数仍由平台固定生成，不开放浏览器命令输入。

新项目 initializer 可以提前建空缓存目录；两种 Run 的轻量目录准备仍须兼容未拥有该目录的旧 PVC。按既有 initializer 模式给目标目录 `WORKSPACE_UID/GID=10001` 的权限，不递归 `chown` 全卷/全仓库、不放宽主应用身份。只建缓存目录的 init 过程由原 Job/启动预算约束；未知或失败不应回退到 `/tmp` 后报告成功。

### 1.3 初始化算法

1. 检查镜像预置仓库和项目缓存可用、可读/可写；错误输出有限、无凭据的诊断并失败。
2. 当前 `seed-id` 完成标记存在则跳过扫描/复制；标记不是本次 Run 的执行许可，不触碰 Run claim。
3. 缺少标记时，只补齐仓库中缺少的文件；不覆盖用户已经缓存/安装的文件。先复制到同目录临时文件，成功后原子发布为目标文件，防止中断留下半个最终 JAR/POM。
4. 全部完成才原子发布标记；失败不写标记，下次用户明确发起的新 Run 可继续补齐。镜像更新时使用新的内容版本，不能用永久 `.initialized` 跳过新增预置依赖。
5. `exec mvn` 执行原目标，缺少的新依赖由 Maven 正常下载；允许元数据/SNAPSHOT 更新，不默认使用 `-o`、`--offline` 或 `-U`。

沿用每项目一个活动 Run 和 Web 先认领后启动，不增加全局锁服务。复制失败、磁盘满或权限不符走现有 Run 失败/停止流程，不能宣称命中缓存或自动清空项目。复制/构建时间属于启动预算；监督进程停止或超时也必须结束包装器与复制子进程。

## C1：从真实模板构建可验证的预置仓库

**Files:** 新增模板导出入口与 `prepare-maven-seed.sh`；修改 runner Dockerfile；新增 `tests/maven-cache.sh` 的 `seed` 模式；复用 `WorkspaceTemplateTest`。

**Interface:** 导出器从 `-Dmanao.seed.output=<绝对构建目录>` 读取输出位置；五个目录为 `console`、`web`、`web-mysql`、`web-redis`、`web-mysql-redis`。Docker 使用命名上下文 `seed-templates` 读取导出目录。测试脚本参数为 `maven-cache.sh IMAGE TEMPLATES MODE`，MODE 支持 `seed`、`lifecycle`、`all`。

- [ ] **先写可失败的 seed 验证。** 检查镜像预置仓库非空且包含固定模板所需文件；在全新容器中使用预置副本与 `--network none` 执行 console、四种 Web 配置的 Maven 编译。原镜像应因没有预置仓库/缺少依赖失败，不能靠宿主机 `.m2` 通过。
- [ ] **实现模板导出。** 导出器放在 test classpath，`main(String[] args)` 调用真实模板，使用 UTF-8 写入；不访问数据库/集群、不启动 Spring 上下文。以下是固定输入和写文件主体，输出目录必须来自所述显式属性：

```java
var specs = new java.util.LinkedHashMap<String, ProjectRuntimeSpec>();
specs.put("console", ProjectRuntimeSpec.console());
specs.put("web", new ProjectRuntimeSpec("java-spring-boot-web", false, false, java.util.List.of()));
specs.put("web-mysql", new ProjectRuntimeSpec("java-spring-boot-web", true, false, java.util.List.of()));
specs.put("web-redis", new ProjectRuntimeSpec("java-spring-boot-web", false, true, java.util.List.of()));
specs.put("web-mysql-redis", new ProjectRuntimeSpec("java-spring-boot-web", true, true, java.util.List.of()));
String output = System.getProperty("manao.seed.output");
if (output == null || output.isBlank()) throw new IllegalArgumentException("manao.seed.output is required");
var root = java.nio.file.Path.of(output).toAbsolutePath().normalize();
var template = new WorkspaceTemplate();
for (var variant : specs.entrySet()) {
    for (var file : template.files(variant.getValue()).entrySet()) {
        var destination = root.resolve(variant.getKey()).resolve(file.getKey());
        java.nio.file.Files.createDirectories(destination.getParent());
        java.nio.file.Files.writeString(destination, file.getValue(), java.nio.charset.StandardCharsets.UTF_8);
    }
}
```

- [ ] **构建 seed 层。** Dockerfile 用 `COPY --from=seed-templates / /seed-projects/` 获取输入，固定版本的 Maven 目标预取依赖和插件；`dependency:go-offline` 可以作为准备步骤，但单独成功不是完整性证明。至少真正执行 Web 无数据库模板的 `spring-boot:run` 并观察主监听器就绪，再正常停止；其他选择的编译覆盖依赖解析。数据库连接正确性留在已有云端生命周期验证，不在镜像构建时创建用户数据库。
- [ ] **限制最终镜像内容。** 最终镜像仅带预置仓库、内容版本和生产运行程序；不包含生成示例源码/构建输出、测试依赖的额外工具或构建凭据。runtime-test 镜像额外保留既有测试程序即可。构建与运行仓库配置/ID应兼容，避免已有文件因来源元数据不匹配再次下载。
- [ ] **验证实际离线运行。** `seed` 模式还需让无数据库 Web 模板使用原目标在网络禁用的容器中启动，经容器内 HTTP 请求确认业务响应及 readiness；设置有限等待和明确清理。容器需要复制时使用仓库内置工具，不依赖临时在线安装测试工具。

在实施检出根目录执行以下构建流程（完成导出器及 Dockerfile 后才可使用）：

```powershell
$seedTemplates = Join-Path (Get-Location) 'poc4/backend/target/maven-seed-templates'
mvn -q -f poc4/backend/pom.xml -DskipTests test-compile org.codehaus.mojo:exec-maven-plugin:3.5.0:java -Dexec.mainClass=com.manao.poc4.workspace.MavenSeedTemplateExporter -Dexec.classpathScope=test "-Dmanao.seed.output=$seedTemplates"
docker build --build-context "seed-templates=$seedTemplates" -t manao-runner-maven-cache poc4/maven-runner
docker build --build-context "seed-templates=$seedTemplates" --target runtime-test -t manao-runner-maven-cache-test poc4/maven-runner
```

```bash
bash poc4/maven-runner/tests/maven-cache.sh manao-runner-maven-cache poc4/backend/target/maven-seed-templates seed
```

本地 tag 仅用于开发验证；镜像最终发布使用实测 digest。测试命令需要 Linux Docker daemon；Windows Git Bash 使用脚本内现有路径转换惯例，不把宿主机路径错误当成运行逻辑失败。导出目录不能携带旧变体遗留文件；只清理该工具拥有的构建输出，路径检查后处理。

- [ ] seed 验证通过、diff 检查后按任务提交，不打包其他 agent 的文件。

## C2：接入项目缓存，保持现有运行控制

**Files:** 新增 `manao-maven`；修改两个 ResourceFactory、`WebRunSupervisor`、Dockerfile；扩展相应测试及 `maven-cache.sh lifecycle` 模式。

**Interface:** `WorkspaceResourceFactory.MAVEN_CACHE_DIRECTORY = ".manao-cache/maven"`；Run 挂载为 `/maven-cache`。console 固定 command 首项改为 `/usr/local/bin/manao-maven`；Web 的 Job command 仍为 `/usr/local/bin/manao-run-supervisor run`，仅监督器固定子命令首项改为包装器。包装器最终 `exec mvn -Dmaven.repo.local=/maven-cache/repository "$@"`。

- [ ] **先写失败 manifest 测试。** 同时覆盖两种 Job、相同 workspace claim 的缓存挂载、代码 subPath 不变、无第三个 PVC。检查 init 目录准备与非 root 可写身份；workspace-agent 没有缓存挂载。示例在现有 `JobResourceFactoryTest` 的 factory/PROJECT/RUN 常量上扩展：

```java
@Test
void bothRunKindsUseTheProjectCacheWithoutAnExtraClaim() {
    for (Job job : List.of(
            factory.createMavenJob(RUN, PROJECT, List.of()),
            factory.createServiceJob(RUN, PROJECT, Instant.parse("2026-09-22T00:30:00Z"), 7200, 8080, List.of()))) {
        var pod = job.getSpec().getTemplate().getSpec();
        assertThat(pod.getVolumes().stream().filter(v -> v.getPersistentVolumeClaim() != null).toList())
            .singleElement().satisfies(v -> assertThat(v.getPersistentVolumeClaim().getClaimName())
                .isEqualTo(WorkspaceResourceFactory.pvcName(PROJECT)));
        assertThat(pod.getContainers().get(0).getVolumeMounts()).anySatisfy(mount -> {
            assertThat(mount.getName()).isEqualTo("workspace");
            assertThat(mount.getMountPath()).isEqualTo("/maven-cache");
            assertThat(mount.getSubPath()).isEqualTo(".manao-cache/maven");
            assertThat(mount.getReadOnly()).isFalse();
        });
    }
}
```

- [ ] **实现目录与挂载。** 先用 init container 根挂载同一 workspace PVC，仅创建/校验缓存目录；主应用只挂载代码/缓存/本 Run 控制目录，不获得全卷根挂载。为已有项目补建目录不能调用会覆盖模板的初始化流程。更改主容器前，实测 UID/GID 10001 对目录可写；不要沿用已有 Docker 测试中的 1001 而漏掉集群身份。
- [ ] **实现包装器和监督接线。** 包装器 root 所有、0555、LF，执行 §1.3 的算法；所有固定目标从现有平台代码传入。Web 先 claim、再以受监督子进程执行包装器，包含复制时间的启动预算保持生效；不在外层 shell 后台启动监督器、不另起 sidecar。console 用 `exec` 保留进程停止与退出码。
- [ ] **容器内验证真实生命周期。** 用真实 UID 10001、只读根文件系统、可写 `/tmp` 与持久缓存卷，检查首次 seed；第二容器复用同一卷；加入预置仓库没有的固定版本 `org.apache.commons:commons-text:1.13.0` 并在业务代码实际调用，第一次允许下载、第二次离线执行成功。先确认此坐标确实不在 seed 中，若已成为传递依赖则在报告中注明并选择另一个实测缺失的固定版本。
- [ ] **覆盖失败与更新。** 测试中断复制未留下半个最终 artifact、未写完成标记；下一次显式运行可补齐。预置内容版本变化能补缺，已有项目文件不被覆盖。只读/空间不足按失败处理，不回退临时仓库；使用可控注入或有限测试卷，不填满宿主机/真实项目存储。非 root 测试断言第二次同版本运行不重复复制，并保留用户新增 artifact。
- [ ] **运行既有监督器回归。** 替代 Pod/重复 claim 拒绝再次执行，停止及短期限结束 Maven/复制子进程，Web PID 1 不变。测试支持注入受控慢复制子进程仅限测试镜像，生产不开放任意命令输入。

```powershell
mvn -q -f poc4/backend/pom.xml '-Dtest=WorkspaceResourceFactoryTest,JobResourceFactoryTest,WorkspaceTemplateTest' test
git diff --check
```

```bash
bash poc4/maven-runner/tests/maven-cache.sh manao-runner-maven-cache poc4/backend/target/maven-seed-templates lifecycle
bash poc4/maven-runner/tests/runtime-lifecycle.sh manao-runner-maven-cache-test
```

C2 修改了包装器/镜像后，先用 C1 命令重建两个测试 tag，再跑上述容器验证；不能测试旧镜像。生命周期脚本只删除自己创建且明确命名的容器/卷。无关网络或数据库环境错误不能冒充预期红灯。

- [ ] 聚焦测试通过、diff 检查后提交本任务。

## C3：发布与集中运行验收

**Files:** 更新 `poc4/maven-runner/README.md`、`poc4/deploy/6b/README.md` 的真实构建与发布方式；必要时补充现有云端 spec 的测量；结果只记录到 `poc4/docs/evidence/java-runtime/acceptance.md`，索引链接结果。

**Interface:** 沿用已授权部署环境、镜像仓库和 `MANAO_MAVEN_RUNNER_IMAGE` digest pin。C1/C2 在原计划 Task 9 之前完成，C3 并入 Task 9；已经完成的 Task 1–8 不因新增本文而从头执行。

- [ ] 对将调度 Run 的节点预拉实际发布 digest，分别记录镜像首次拉取成本与镜像已在节点的启动时间。沿用现有运维流程，不引入常驻预热服务；无法预拉则如实记录冷镜像条件。
- [ ] 在同一个验收项目记录：创建到可编辑；新缓存首跑的镜像准备、seed、Maven、readiness、预期业务响应；停止/修改后第二 Run；加一项未预置依赖后的首次与后续 Run。三类耗时分开，不能把新镜像拉取或数据库等待统称为 Maven 下载。
- [ ] 比较相同模板、资源和节点条件下的前后实测；若没有可信旧数据，记录优化后实测和机制证据，不虚构“原来 10 分钟”或提速倍数。`-q` 无下载日志本身不证明命中缓存，使用离线验证、仓库请求或明确文件/传输证据。
- [ ] 验证旧 PVC 第一次运行可补建缓存；一个新项目不会读到另一个项目新增的 artifact。复用已有最小辅助项目，结束后独立核对回收。
- [ ] 原正式 7200 秒运行采用新镜像并保留进程终止证据；缓存检查并入该轮，不另开第二次两小时测试，也不用短缓存测试替代正式到期验收。
- [ ] 删除测试项目后确认缓存随 workspace PVC/实际存储回收；MySQL 仍按原独立 PVC 删除/保留契约处理，不增加第三个卷或宽泛清理。
- [ ] 更新实际构建命令、镜像 digest、模板版本/seed-id、首跑/复跑/新增依赖数据、测试结论及未验证项。区分 PASS、FAILED、SKIPPED、WAIVED_BY_USER、NOT_REVERIFIED、BLOCKED；不把文档完成写成功能完成。

## 2. 实施交付与自检

- 规格 §7.5 的镜像来源、私有缓存、旧项目兼容、原时限、删除和范围限制分别由 C1、C2、C3 覆盖。
- 缓存只增加现有运行镜像与 Job 的内部实现；浏览器/业务调用入口保持原契约。
- 依赖镜像变大、seed 文件复制及 NFS 小文件读取可能成为新的耗时，报告中据实拆分；有测量结果后再决定是否需要后续存储优化。
- 对 GLM 的交付说明应列出：实际改动文件与提交、运行过的命令及结果、发布 digest、启动数据、缓存命中证据、清理结果、未完成项。不能只汇报“已加缓存”。

官方依据：[Maven 仓库](https://maven.apache.org/guides/introduction/introduction-to-repositories.html)、[Maven 设置](https://maven.apache.org/settings.html)、[Docker 命名构建上下文](https://docs.docker.com/build/building/context/#named-contexts)。实施时核对所用工具版本，不依赖镜像默认 ENTRYPOINT 自动复制仓库：当前 Job 显式设置 command，会覆盖镜像入口。
