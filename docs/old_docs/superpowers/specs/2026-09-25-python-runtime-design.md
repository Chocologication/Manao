# Python 运行环境适配设计

**日期：** 2026-09-25

**状态：** 2026-09-25 自审修订版 r2；用户同意按自审结果收紧方案，模板范围和 uv 入口已确认。后记：设计已按 r2 全部实施（2026-09-26/27），其后的工作台/日志修复轮（2026-09-29）与依赖镜像/批量导入轮（2026-10-11/12）记录于 [Python Acceptance](../../../../poc4/docs/evidence/python-runtime/acceptance.md) 第 5–8 节；整个分支已于 2026-10-12 由 `2ef32a5` 合并到 `master`。

**基线：** `06e8133820867cc9d200ab63913d1a282d2dedf6`，包含 Java 集成提交 `ef1b5bb`。

**实施检出：** `.worktree/python-runtime`，分支 `codex/python-runtime`。文档链接均相对于仓库，不依赖此工作树位置。

**实施计划：** [Python Runtime Implementation Plan](../plans/2026-09-25-python-runtime-implementation-plan.md)。

## 1. 目标、确认和边界

目标是让用户完全通过浏览器完成：创建 Python 项目 → 编辑并保存 → 运行 → 查看真实输出或访问 FastAPI → 停止/失败/到期 → 修改后再次运行 → 删除项目。

2026-09-25 用户确认：

- 在 Java 已交付的基础上逐个适配 Python、Go、TypeScript，合计四种语言；本次先规划 Python。
- Python 首版同时支持普通程序和 FastAPI Web 服务。
- 复用 Java 阶段的端口、项目 MySQL/Redis 和运行时限约定。
- 提供最小的浏览器添加/删除依赖入口，由服务器执行固定 `uv add/remove`。
- 本轮交付是新工作树及实施计划；功能开发、发布、集群验收属于后续执行。

技术默认值：Python `3.13` 系列、`uv` 项目管理、固定入口。Python 补丁版、uv 精确版本、FastAPI 等包版本在镜像任务中实际解析、验证并锁定；不凭空编造镜像 digest，也不使用浮动版本进行部署。选择 3.13 是首版兼容性取舍，不声称它是最新 Python。

本阶段不增加 Go/TypeScript 执行器、AI、Notebook、GPU、Conda、任意镜像/命令配置、热重载、自动恢复、通用语言插件框架或新的终端产品能力。Python 多版本选择及任意已有项目的自动识别也不在本次范围。

### 1.1 依赖入口的确认及实现边界

用户选择了最小 `uv add/remove` 入口。该选择需要对 `pyproject.toml` 与 `uv.lock` 成对提交，不把两个普通 SAVE 请求当作一次可靠操作。首版入口接收包名及可选精确版本，只操作主依赖列表；不扩展成私有索引、Git/path 依赖、操作系统包或任意终端。具体操作身份及双文件协议见 6.1–6.3。

## 2. 当前源码事实与复用位置

以下是本轮对基线的源码核对，不是新功能运行证据。

| Module | 当前 Interface / 限制 | 本阶段变化与验证位置 |
| --- | --- | --- |
| 项目运行配置 | `ProjectRuntimeSpec` 仅允许两个 Java 模板，`isService()` 判断 Spring Boot，默认端口 8080 | 固定模板表加入两个 Python 模板；原创建键、摘要、端口校验继续生效。测试放在项目配置和创建 HTTP 契约处 |
| 模板生成 | `WorkspaceTemplate.directories/files(spec)` 目前只按 TASK/SERVICE 选 Java 目录 | 按精确模板选目录和文件，父目录先创建；仅首次初始化写入。测试加载实际 classpath 资源 |
| Run 策略 | `RunPolicy` 只有 `javaMajor/mavenMajor`，`RunService` 从一个 Java 基础策略派生 | 根据项目模板创建服务端策略快照，旧 JSON 继续可读；未知模板不得降级成 Java |
| Job 编排 | `Fabric8JobCoordinator` 根据 executionKind 调用 Java Job factory | 仍由该 coordinator 管理所有 Run；factory 从持久化模板选择镜像、固定命令和缓存 |
| 服务寿命 | `WebRunSupervisor` 已有 claim、Pod UID、receipt、单调计时、停止及派生进程处理 | 仅增加固定 Python 服务配置，不复制第二套寿命协议；真实容器验证 Java 和 Python |
| 项目依赖 | `Fabric8ProjectDependencies` 已注入 `MANAO_MYSQL_*`、`MANAO_REDIS_*` 的 Secret 引用 | Python 模板消费既有变量，不新建数据库管理器；MySQL 数据仍在独立 PVC |
| 文件编辑 | 前端 `languageForFile.ts` 已支持 `.py`；agent `languageFor()` 尚不支持 | 补 agent 的 Python 元数据；TOML/lock 可按纯文本编辑，不引入编辑器插件项目 |
| 前端 Run | `contracts/run.ts` 只接受固定 Maven 命令；工具栏固定显示 Java/Maven | 严格支持新的 Python 分支并保留旧 Java 响应；显示实际 Run 策略 |

`runtime_spec_json`、`policy_json` 已可存储语言增量，不因增加两个模板就建立语言表或重写 V9 migration。新增依赖操作需要 V10 为既有 `workspace_operation` 增加不可变 `operation_kind` 和 `request_sha256`：前者识别恢复方式，后者约束同一浏览器操作 ID 的请求。旧操作默认 FILE，新增值 PYTHON_DEPENDENCIES；没有独立任务表。

## 3. 方案取舍

| 方案 | 成本和后果 | 决策 |
| --- | --- | --- |
| 复用 Run/Job/监督器，仅加入固定语言配置 | Python 镜像需携带小型 Java 运行时来执行已有监督器；生命周期协议和故障处理只有一份 | 推荐，纳入计划 |
| Python 单独编写完整监督器 | Python 镜像可少带 JRE，但需要重新证明 claim、进程树终止、时限和持久化失败行为 | 本次不选 |
| 通用 LanguageProvider/Runner SPI | 增加注册、配置、扩展接口和部署排列，当前只有 Java/Python 两个确定实现 | 本次不选 |

复用监督器是实现内部选择，用户界面仍显示 Python。`WebRunSupervisor` 暂留现有目录，Python 镜像从同一份源码构建；不复制源码、不为了命名移动整个 Maven runner。后续出现真实维护痛点再迁移公共目录。

## 4. 产品行为

| 模板 | 类型与入口 | 默认容器端口 | 时限 |
| --- | --- | --- | --- |
| `java-console` | 既有 Java task | 无 | 既有 1800 秒总预算 |
| `java-spring-boot-web` | 既有 Spring Boot service | 8080 | 启动预算 1800 秒；首次 ready 后 7200 秒 |
| `python-console` | `python -u main.py` | 无 | 1800 秒总预算，包含依赖准备 |
| `python-fastapi-web` | `python -u -m uvicorn app.main:app --host 0.0.0.0 --port <primaryPort>` | 8000 | 启动预算 1800 秒；首次 ready 后 7200 秒 |

`<primaryPort>` 由服务端验证过的第一条端口映射决定，未公开则使用模板默认端口；它不是浏览器提供的命令字符串。普通程序是执行入口，不把点击 Run 改成运行 pytest。

- 创建 UI 对普通程序不显示 MySQL/Redis 或公网端口选项；FastAPI 可选 MySQL、Redis、公网访问，与 Java 创建 UX 保持一致。新 Python console 请求包含 MySQL/Redis 或公网端口时拒绝；既有 Java console 的后端兼容规则保持。
- 公网端口用户手填，范围 `30000–31000`，保留 `30080` 等部署保留值；冲突必须由用户修正。容器端口只校验 `1–65535`。最多三条 TCP 映射，整组沿用既有规则。
- 模板只自动监听主端口。配置多个不同 targetPort 不会使单个 Uvicorn 自动启动多个监听器；用户代码须实际监听其声明的附加端口。相同 targetPort 的映射继续按已有规则处理。
- 每项目一个活动 Run；未保存缓冲区、待核对工作区操作、活动 Run 锁等继续阻止冲突操作。
- 普通程序 exit 0 为成功、非零为失败；服务进程提前退出仍按既有 SERVICE 语义处理，不因为 exit 0 自动声明完成。异常不会自动创建新 Run。
- FastAPI 使用一个 Uvicorn 进程，不启用 `--reload` 或多 worker。用户点击再次运行才采用新代码和新依赖。
- 不公开端口的 FastAPI 仍可运行并通过容器内 readiness；不会虚构一个浏览器可访问 URL。

## 5. 固定模板与快照契约

新增一个内部固定枚举 `RuntimeTemplate`，集中记录 `id`、`language`、`executionKind`、展示命令和默认主端口。外部创建请求仍只增加两个允许的 `templateId`，不新增自由命令、语言与模板相矛盾的双输入或镜像字段。

Run 新快照记录 `templateId` 与带语言判别的 `runtime`；Java 写入 Java/Maven 字段，Python 写入 Python/uv 字段，不在 Python 响应中伪造 Java 版本。示意：

```json
{
  "templateId": "python-console",
  "command": "python -u main.py",
  "runtime": {"language": "python", "pythonVersion": "3.13", "packageManager": "uv"},
  "executionKind": "TASK",
  "timeoutSeconds": 1800,
  "startupTimeoutSeconds": 1800,
  "serviceLifetimeSeconds": 0
}
```

资源 requests/limits 继续按现有快照写入；示例省略这些未变字段。`command` 是服务端展示值，Job 绝不把数据库文本交给 shell 解释执行。

兼容规则：

1. 旧项目缺少 runtime 配置仍是 `java-console`，不覆盖已有文件，不重算已有创建摘要。
2. 旧 Run 没有语言/模板但有 Java 17、Maven 3 字段时，按 executionKind 识别其历史 Java 语义；保持历史 JSON 可读，不批量改写历史记录。
3. 旧 Java SERVICE 快照展示的 console 命令是已存在行为；解析器仅对确认为旧格式的记录兼容它。新 Java SERVICE 快照展示真实 Spring Boot 命令。
4. 新格式必须核对模板、语言、类型和展示命令的一致性。未知或互相冲突的数据拒绝解析，不能兜底运行 Java。
5. 后端恢复观察依据已有 Run 快照与 Job 身份；不能用后来变更的默认模板重解释历史 Run。

## 6. 模板、依赖和环境

两个模板都含 `pyproject.toml`、`uv.lock`、`.python-version`、README、`.gitignore`；普通程序含 `main.py`，Web 含 `app/__init__.py`、`app/main.py`。模板开发者增删依赖使用 `uv add/remove`；本机验证使用项目级隔离环境，不使用 pip 或 uv pip。Web 的 mysql/redis 作为命名 extras 写入一个真实 lock，按项目勾选决定安装哪些 extras，避免手写四份锁文件。

Web 模板只包含 FastAPI、Uvicorn 及勾选依赖需要的客户端：MySQL 使用 `PyMySQL[rsa]`，Redis 使用 `redis`。不把 pandas、机器学习包或全部 Python Web 生态预装进镜像。锁文件必须由实际使用的 uv 生成，不能手写。

模板提供：

- `GET /api/demo`：返回固定欢迎信息，供公网业务验收。
- `GET /health/ready`：不启用依赖时返回 200；只检查已勾选的 MySQL/Redis，探测失败返回固定 503，响应和日志不输出连接凭据。MySQL/Redis 连接和读取设置有限超时，健康检查不创建业务数据。
- 验收通过浏览器写入最小 MySQL/Redis 读写代码，使用已有项目环境变量，观察停止、修改、再次运行后的 MySQL 数据保留；这些测试代码不扩展默认模板的产品接口。Redis 只承诺缓存语义。

运行隔离默认安排：

| 内容 | 位置与生命周期 |
| --- | --- |
| 用户源代码和依赖声明 | 既有项目代码 subPath，浏览器可编辑 |
| 下载缓存 | 同一 workspace PVC 的 `.manao-cache/python`，在代码 subPath 外，私有可写；删除项目时回收 |
| 每次运行的 Python venv | `/tmp/manao-python/.venv`，由 `UV_PROJECT_ENVIRONMENT` 指向，仅供当前项目的当前 Run；随 Pod 消失 |
| 镜像预置 seed | 镜像内只读模板依赖缓存，构建时生成；从不作为跨项目可写目录 |
| MySQL | 既有独立 MySQL PVC，停止 Run 不删除 |

每 Run 重建 venv 可以避免旧包残留及运行镜像升级后复用不兼容解释器；下载缓存负责避免重复下载。设置 `UV_LINK_MODE=copy`，明确指定镜像中的 Python，禁用运行时下载解释器。首次创建 workspace 不等待安装 Python 包。

首版仅维护已固定版本与目标平台的一份 seed；seed 身份记录精确 uv/Python、平台及实际模板依赖。首次只向尚不存在的缓存目录进行完整、原子初始化；已有缓存交给 uv 管理，不自行拼接内部缓存文件、不清空旧缓存。seed 兼容性必须由“空私有缓存 + 禁网 + 实际模板安装/启动”容器测试证明。本阶段不实现跨 uv/Python/平台的缓存升级或自动补齐框架；未来版本变更时再依据实际兼容问题处理。不能声称任意新依赖离线可用。

### 6.1 浏览器依赖操作：一个身份、一个确定结果

浏览器在首次提交前生成 UUID `operationId`，按当前用户/项目保留该 ID；刷新、丢失响应或进入失败页后仍查询同一操作。请求为 `POST /api/v1/projects/{projectId}/python-dependencies`：

```json
{"operationId":"11111111-1111-4111-8111-111111111111","action":"ADD","packageName":"httpx","version":"0.28.1","expectedWorkspaceRevision":"17"}
```

删除用 `REMOVE`、`version=null`；添加省略精确版本时由 uv 解析并写入 lock。服务端规范化包名，计算包含 projectId、action、packageName、version、expectedRevision 的固定顺序 JSON 的 `requestSha256`。同一 ID 不同请求返回 `DEPENDENCY_REQUEST_MISMATCH`，不得再次执行 uv。operationId 是不透明业务标识，不是资源路径或凭据。

浏览器接口保持用途明确：

- 首次 POST：校验 owner、Python 模板、revision、无活动 Run及未决操作，再准备并提交。
- `GET /python-dependencies/{operationId}`：只读查询该操作，返回 `operationId`、`state=PENDING|COMMITTED|UNCONFIRMED`、`resultWorkspaceRevision`（仅 COMMITTED 有值）。必须检查项目所有权，不能泄露其他项目操作。
- `POST /python-dependencies/{operationId}/reconcile`：核对该 ID 的已登记结果；COMMITTED 直接返回，PENDING 继续同一提交，绝不重新运行 uv。
- 无浏览器本地 ID 的失败页可用 `GET /python-dependencies/pending` 查询该项目的唯一未决依赖操作；该查询不能覆盖客户端已保存的另一操作 ID，不返回其他类型操作。

成功响应包含 `operationId`、`state=COMMITTED`、`resultWorkspaceRevision=expectedRevision+1`。UI 再读取当前工作区 revision 和两个文件，不能拿历史操作 revision 覆盖后来已保存的内容。仅找不到记录返回 UNCONFIRMED，不能把它解释成请求未到达或允许重发；明确的无副作用拒绝才允许修正后发新操作，结果不明继续核对，不自动 POST 重试。

### 6.2 agent 只公开 prepare 和 commit

agent 镜像增加与 runner 对齐的 Python/uv，全部请求经过现有 capability 签名：

1. `prepare`：在 scratch 内执行固定 `uv add/remove --no-sync`，源文件不变；成功后在同一 scratch 内以生产安装形态去掉选定 extras 的固定 argv（`uv sync --locked --no-dev --no-build --no-config --no-python-downloads --python /usr/local/bin/python3 --dry-run`，无 `--no-sync`）验证目标解释器/平台可安装性，两次 uv 调用共用同一单调预算截止；验证通过才将两个目标文件、requestSha256、单文件及组合摘要持久化到 `.manao/python-dependencies/<operationId>`，状态为 PREPARED——universal lock 可能解析出只有其他平台 wheel 的发行版，验证保证这类请求在任何 journal 产生前即被拒绝。响应仅返回 ID、requestSha256、beforeSha256、afterSha256；不把文件正文来回传给后端。已存在同请求 PREPARED 时返回同一摘要，不重新解析；ID 冲突或结果不明时拒绝猜测。
2. `commit`：接受后端已登记的 ID、请求摘要、前后摘要及 receipt；从本地 journal 校验并提交两个固定文件。首次调用、部分写入后的再次核对都进入同一实现。若最终 receipt 已存在且匹配，直接返回相同结果。没有单独的 apply/recover 协议，也没有自由命令入口。

后端先取得 prepare 摘要，再写现有 `workspace_operation` PENDING，最后调用 commit。V10 只在该表增加 `operation_kind` 和 `request_sha256`；旧 FILE 操作的请求摘要可空，Python 依赖操作必须有摘要。已有 id 为操作身份，COMMITTED 行保留到项目删除，足以回答成功响应丢失的查询；不新建请求表或任务平台。

journal 先持久化目标文件，commit 再逐文件 temp+fsync+rename，最后核对组合摘要并写 receipt。两个文件不是文件系统层面的同时原子替换；项目写锁、PENDING、journal 和最后的 receipt 共同保证用户不能运行中间状态。迟到 commit 和核对请求由 agent 同一文件锁串行化。journal 损坏、第三种文件内容、Forbidden/Unknown 继续 fail-closed，不靠删除 PENDING 解锁。

现有 `ProjectLifecycleGate` 同线程可重入，`WorkspaceService` 读取已通过同一 gate。复用它们，只补未决依赖操作检查；不另建读取锁或分布式锁。数据库恢复提交集中到工作区操作模块：在一个事务内校验 operationId、kind、revision、状态和 receipt 已核对的事实，再完成操作、递增一次 revision。若需恢复 FAILED，只能清除本次 WORKSPACE_RECONCILIATION_REQUIRED，不能清除其他失败或 DELETING。普通提交与核对提交共享内部事务代码，持久层方法不接收包名、uv 命令等语言细节。

组合摘要固定为以下 UTF-8 内容的 SHA-256；路径顺序固定，缺失文件用 ABSENT：

```text
python-dependencies-v1\npyproject.toml\n<pyproject-sha256-or-ABSENT>\nuv.lock\n<lock-sha256-or-ABSENT>\n
```

receipt 沿用既有身份/摘要格式，type 为 PYTHON_DEPENDENCIES、path 为 pyproject.toml、nextPath 为 uv.lock。请求摘要通过 DB 与 journal 绑定，提交响应还要核对 receiptSha256。未登记 PENDING 的 PREPARED 绝不自行应用；断网后原后端请求是否仍可能提交不能靠一次“记录不存在”推断。

### 6.3 工具预算与首版支持边界

首版技术默认支持公共 PyPI wheel 包、主依赖包名和可选精确版本，不开放私有索引、Git/path/workspace 来源、系统包或任意终端。这是本次方案选择的支持边界，不表述为用户曾逐项指定。缺 wheel 或不支持的配置给出具体类别的固定安全错误，不静默丢弃用户配置，也不把 uv stderr 直接返回浏览器。`PYTHON_DEPENDENCY_NO_WHEEL` 是端到端固定类别：helper 对非零验证结果按固定短语归入缺 wheel（universal lock 可能解析出只有其他平台 wheel 的发行版，prepare 的 dry-run 验证在任何 journal 产生前拒绝它），再经 agent 代码、后端 422 透传到达浏览器的固定文案，uv stderr 始终不到达浏览器。

agent 的 uv 子进程仅继承必需环境，不继承 capability 私钥或项目数据库 Secret；使用固定 argv 与 `--no-build --no-sources --no-config --no-python-downloads`，避免在管理 agent 执行用户构建后端。运行时仅 `uv sync --locked --no-dev --no-build` 加选定 extras，不自动改写声明和 lock。

依赖解析预算初值 20 秒，是可配置的工程默认值，不是已测得的包解析上限或产品承诺。实施时测量代表性模板与包解析；若需调整，连同对应 HTTP 请求超时一起设置为“解析预算 + 有界 journal I/O 和传输余量”，保留显式上限。原客户端默认 30 秒无需全局调大，只给该 prepare 调用所需预算。不为这项预算配置引入异步任务平台。

## 7. Job 与服务监督

`JobResourceFactory` 从固定模板决定镜像、TASK 命令、SERVICE profile 和缓存 subPath。Java 使用原 Maven image，Python 使用新增 `MANAO_PYTHON_RUNNER_IMAGE`；均要求不可变 digest。新 Python 镜像含 Python、uv 和运行公共监督器所需的 JRE，不携带 Maven。

服务命令保持固定启动器：

```text
manao-run-supervisor run python-fastapi-web
manao-run-supervisor probe python-fastapi-web
```

启动器只接受明确枚举的 profile；未知值或额外参数立即失败。旧 `run`/`probe` 默认 Java，用于已创建资源兼容。Java profile 继续检查 `/actuator/health/readiness`，Python profile 固定检查 `/health/ready`，运行和探针共用同一映射；不接受自由 health URL。

claim 必须在准备缓存/安装包和执行用户代码前获得。包准备耗时属于启动预算。共享 `RunDeadline`、receipt protocol 1、Pod UID、firstReadyAt/expiresAt、termination message、单调计时和退出处理，不引入第二个计时权威。失去 readiness 再恢复不得重置 expiresAt；后端离线仍必须到期终止。

既有 `maven-run` component label、`maven` 容器名及 `manao-maven-runner` 无权限 ServiceAccount 暂作为内部兼容标识复用。身份核验、Service selector、日志、停止、清理和旧 Pod 恢复依赖这些值；本阶段不只在新 factory 中孤立改名。显示语言依靠 Run 策略，不依靠这些历史名称。

原有 UID/GID 1001、只读 rootfs、`/tmp` 可写、无 SA token、资源限制、低端口 sysctl、`Never`、`backoffLimit=0` 等保持约束；测试检查实际 manifest 和真实低端口启动。

## 8. 用户界面与交付顺序

创建表单新增两个模板，FastAPI 默认 targetPort 8000，publicPort 保持空白要求用户填写。切换模板清理不适用输入；创建结果不明时继续查询原 creationKey，不新建第二个项目。

项目卡显示准确语言/模板。运行工具栏从所选 Run 的策略显示命令与版本；未有 Run 时使用当前项目模板，不能默认显示 Maven。停止提示采用通用 Run 文案。编辑器消费 agent 的 `.py` 语言类型，依赖声明及 lock 可用纯文本编辑；不要求 Python LSP。

依赖失败后的核对入口必须在 ProjectRoutePage 的失败状态页及项目卡可达，不依赖 READY 才能挂载的工作台。仅对 Python 项目的 WORKSPACE_RECONCILIATION_REQUIRED 开放，禁止顺便恢复其他失败；刷新后按原 operationId 查询，若浏览器记录缺失则读取 owner-scoped pending 摘要。COMMITTED 的丢失响应在 READY 页面也能核对。

发布时先让前端能解析新旧两类 Run，再启用 Python 后端和模板。后端镜像与 Python runner digest 成对记录。若需回滚，先停止创建 Python 项目和启动 Python Run，停止并核对已有活动 Python Run，保留包含 Python 数据的数据库；不能把不认识新 JSON 的旧后端直接切回来宣称兼容。

## 9. 验收与证据边界

实施分两个增量：Task 1–6 先验证模板、运行、日志、停止与删除路径，Task 7–9 再交付依赖增删和恢复；Task 10–11 发布准备与集中云端验收。增量 A 不新增强制生产部署审批或完整集群 gate；已有测试环境可执行时做真实浏览器烟测，环境缺失如实记录，不以 mock 宣称真实闭环通过。必要证据：

1. Java 旧项目、旧历史和新 Java Run 可用；新增 Python 普通程序成功/失败/修改/再次运行，中文实时日志及结束后回放正常。
2. FastAPI 真正通过选定公网端口响应业务请求；readiness 和依赖状态准确；停止后进程和访问结束，手动再次运行获得新 Run。
3. 浏览器 uv 增删依赖可用，新增包首次下载、第二次复用、移除后不残留；失败安装不得启动应用或无限占用 Run。
4. MySQL 项目数据在停止、改代码和再次运行后保留；Python 项目删除独立验证 DB 行、Job/Pod/Service/Secret/控制器、workspace/MySQL PVC、PV 与存储目录；缓存随 workspace 回收。
5. 公共监督器变更复用现有 Java 生命周期用例，验证 claim、receipt、计时和异常写入；Python 只补实际 uv/Python 进程链的 readiness、安装阻塞启动超时、短时到期、TERM/强制终止及日志，不复制第二份公共状态机故障矩阵。
6. Python 正式 7200 秒云端用例单独记录。Java 曾有 `WAIVED_BY_USER` 不会自动豁免 Python；短时容器证据也不会变成完整时长 PASS。实施时若用户另行豁免，明确记录原话、范围与未测行为。

Python 验收结果写入新 `poc4/docs/evidence/python-runtime/acceptance.md`，由实施任务创建；本轮不预建 PASS 记录。历史 6A/6B/Java 验收保持原始边界，包括既有 DELETING 诊断，不顺手处置历史资源。

环境前检核对实际 Kubernetes context/namespace、权限、节点容量、镜像拉取、存储与公网端口。数据库测试只使用一次性 schema。浏览器验收使用真实云端入口，不启动本地 Vite/backend 来替代。时间采样分开记录 workspace 创建、镜像拉取、依赖准备、应用 ready；历史 Java 58s/7s 不是 Python 指标。

## 10. 当前文档核对资料

2026-09-25 通过 Context7 查询官方资料：

- [uv Docker integration](https://docs.astral.sh/uv/guides/integration/docker)：独立 cache、`UV_LINK_MODE=copy`、分层准备依赖。
- [uv project synchronization](https://docs.astral.sh/uv/concepts/projects/sync)：`--locked` 校验声明与锁一致；`--frozen` 跳过锁新鲜度检查，不能拿来掩盖不一致；`--no-sync` 跳过环境同步。
- [uv dependencies](https://docs.astral.sh/uv/concepts/projects/dependencies)：`uv add/remove` 管理依赖。
- [FastAPI containers](https://fastapi.tiangolo.com/deployment/docker) 与 [server workers](https://fastapi.tiangolo.com/deployment/server-workers)：容器内单 Uvicorn 进程的部署方式。
- [Java Runtime Design](2026-09-21-java-project-runtime-design.md)、[Java Runtime Acceptance](../../../../poc4/docs/evidence/java-runtime/acceptance.md)：已有契约与证据边界。

这些文档支持方案选择；容器分发、缓存复制兼容性和目标集群可用性仍由实施中的实测证明。
