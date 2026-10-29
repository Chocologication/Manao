# 依赖 NetworkPolicy 收窄与旧策略迁移（poc4/deploy/multi-account）

本目录只做一件事：把共享 namespace 中历史遗留的依赖 NetworkPolicy（MySQL/Redis）
从“组件选择器”收窄为“本项目 + 组件选择器”，并给出一份可审阅、可预演、可回读的
迁移脚本。**本任务没有对任何集群执行 Apply；真实集群迁移与跨账号隔离验收均为
NOT_RUN，等待用户单独授权与人工执行。**

## 1. 缺陷与语义

- 旧 `dependencyNetworkPolicy(projectId)` 的 `spec.podSelector` 只匹配
  `manao.poc4/component In (mysql,redis)`，没有 `manao.poc4/project-id`。每个项目各有
  一条策略，于是旧 `manao-dep-netpol-p1` 的 ingress 允许 p1 的 Pod 访问**所有项目**的
  mysql/redis Pod，跨项目依赖访问由此成立。
- Kubernetes NetworkPolicy 的允许规则是**并集**：新增一条带 project 的窄策略
  **不会**抵消旧宽策略。只要 namespace 里还有任何一条旧宽策略，旧放行仍然有效。
  因此必须逐条原地收窄全部旧策略；“新策略已生效”不能作为完成依据。
- 本分支 backend 侧已修：`DependencyResourceFactory.dependencyNetworkPolicy` 的 target
  selector 同时带 project label 与 component 表达式；`Fabric8ProjectDependencies.ensure`
  在创建任何依赖 workload 之前创建一次策略。历史集群中的**旧对象**仍必须通过本目录
  脚本迁移。

## 2. 文件

| 文件 | 用途 |
| --- | --- |
| `repair-dependency-policy.ps1` | 迁移脚本：默认只读预览；`-Apply` 才按 JSON Patch 收窄 |
| `repair-dependency-policy.test.ps1` | 纯 fixture 测试（mock kubectl，不连接任何集群） |
| `README.md` | 本文件 |

## 3. 不变量与边界

- 必须显式给出 `-Context` 与 `-Namespace`。所有 kubectl 调用都带
  `--context <ctx> --namespace <ns>`；脚本**不使用** `-A` / `--all-namespaces`，
  不做跨 namespace 自动发现或自动修复。
- `-ProjectsFile` 是**人工核对过**的**顶层 JSON 数组**，元素必须是含字符串
  `ownerId` 与 `projectId` 的对象（`ownerId` 用于审阅记录）；`projectId` 必须精确等于
  小写 DNS label：`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`（最多 63 字符、不能有末尾连字符），
  且清单内不得重复。非数组、数字/对象字段、`P1`、`p1-` 等输入都会被拒绝。脚本只按
  清单逐项验证，不会自动生成、补全或扩大清单。
- 所有名称、标签、spec、UID/resourceVersion 比较都是**大小写敏感（ordinal）**的：例如
  ingress 来源是 `P1` 而清单是 `p1` 会判为 `UNKNOWN_SPEC`，managed-by 大小写不符会判为
  `IDENTITY_MISMATCH`，绝不按错误大小写执行 patch。
- 脚本只读取 NetworkPolicy；**从不读取 Secret**。备份目录里只可能是 NetworkPolicy。
- 不自动创建缺失策略、不自动处理清单外策略、不重试被拒 patch、不自动回滚。
- 不修改 RBAC，不引入全局自动修复器。

## 4. 用法

```powershell
# 1) 只读预览（默认）：不写集群、不写磁盘（也不创建任何临时文件）
pwsh -NoProfile -File poc4/deploy/multi-account/repair-dependency-policy.ps1 `
  -Context <kube-context> `
  -Namespace <namespace> `
  -ProjectsFile <reviewed-projects.json> `
  -OutputDirectory <evidence-dir>

# 2) 人工审阅预览输出后，才允许 Apply
pwsh -NoProfile -File poc4/deploy/multi-account/repair-dependency-policy.ps1 `
  -Context <kube-context> `
  -Namespace <namespace> `
  -ProjectsFile <reviewed-projects.json> `
  -OutputDirectory <evidence-dir> `
  -Apply
```

`ProjectsFile` 示例（必须来自人工核对，不是脚本生成）：

```json
[
  { "ownerId": "<owner-1>", "projectId": "<project-uuid-1>" },
  { "ownerId": "<owner-2>", "projectId": "<project-uuid-2>" }
]
```

预览会逐项打印状态，末尾给出结论：

| 状态 | 含义 |
| --- | --- |
| `ALREADY_FIXED` | target selector 已是“本项目 + component”的窄选择器；幂等跳过 |
| `NEEDS_MIGRATION` | spec 精确等于已审阅的旧单组件 selector；Apply 时会 patch |
| `MISSING` | 清单内项目缺少策略：零遗漏失败，拒绝完成 |
| `UNKNOWN_SPEC` | spec 既不是已审阅旧 spec 也不是窄 spec：拒绝完成 |
| `IDENTITY_MISMATCH` | name/namespace/managed-by/project label/UID/resourceVersion 不符 |
| `OUT_OF_SCOPE` | 清单外的策略仍可能命中依赖 Pod 并放行 ingress；报告并拒绝完成 |
| `IGNORED` | 不影响依赖 Pod 的无关策略；仅列出 |

结论行为：`PREVIEW_RESULT=WOULD_PATCH count=N`（预览通过）或 `RESULT=REFUSED`
（范围/完整性校验失败，**没有做任何修改**）；Apply 成功为 `RESULT=APPLIED count=N`
或 `RESULT=ALREADY_SCOPED count=0`。

退出码：`0` 成功/无需操作；`2` 范围与完整性校验拒绝（未做修改）；`3` patch、
补丁负载文件写入或回读失败；`1` 意外错误。

## 5. 校验、JSON Patch 与回读

对清单内每个项目，脚本验证：

1. 资源名精确等于 `manao-dep-netpol-<projectId>`；
2. labels：`app.kubernetes.io/managed-by=manao-poc4-backend`、`manao.poc4/project-id`
   等于清单值、`manao.poc4/component=dependencies`；
3. `metadata.uid` 与 `metadata.resourceVersion` 非空（patch 前置条件用）；
4. `spec` 与“完整预期旧 spec”（target 仅 component 表达式、ingress 来源为本项目、
   端口 TCP 3306/6379、policyTypes 仅 Ingress）或“完整预期窄 spec”**精确相等**，且
   比较是大小写敏感的 canonical JSON 比较（不允许多余字段）；
5. 清单外策略按 **fail-closed** 处理：只有能**证明**其 podSelector 排除全部依赖 Pod 时才
   记为 `IGNORED`。依赖 Pod 已知标签是 `manao.poc4/project-id`（任意项目值）、
   `manao.poc4/component ∈ {mysql,redis}`、`app.kubernetes.io/managed-by=manao-poc4-backend`。
   可证明排除的情形：component 的等值/In 值不含 mysql、redis；component NotIn **同时**
   包含 mysql 与 redis；component DoesNotExist；managed-by 等值/In 值不是本平台；managed-by
   NotIn 含本平台；managed-by DoesNotExist；project-id DoesNotExist。没有 ingress 规则或
   policyTypes 明确不含 Ingress 的策略也不放行。除此之外（空 selector、任意 project-id
   约束、managed-by=本平台或 Exists、未知 label key/operator 等）一律 `OUT_OF_SCOPE` 并
   阻止完成判定，而不是偷偷扩大清单。

Apply 时对每条 `NEEDS_MIGRATION`：

1. 先把修改前策略对象写入 `<OutputDirectory>/backup/<policy>.json`（只有 NetworkPolicy）；
2. 把 JSON Patch 负载写入 `<OutputDirectory>/patch/<policy>.json`（紧凑 JSON），再用
   `kubectl patch --type=json --patch-file <该文件>` 发送。负载包含
   `test /metadata/uid`、`test /metadata/resourceVersion`、
   `replace /spec/podSelector`——**只替换 podSelector**，不动 ingress、来源、端口、
   labels 或名称。**不能**用内联 `--patch '<json>'`：Windows PowerShell 5.1 的原生参数
   引号处理会剥掉 JSON 双引号，kubectl 收到非法 JSON（本轮真实原生探测已复现，fixture
   的 `.cmd` mock 通过 `%*` 看不到该问题，因此测试改为强制要求 `--patch-file` 并拒绝
   内联 `--patch`）。补丁文件不写 OS 临时目录，只在 Apply 时出现在 OutputDirectory
   下；预览不创建任何文件；
3. 任一步骤失败即走统一失败路径：保留已成功应用的项目、为该候选记 `FAILED`、写
   FAILED `apply-report.json`、以 `3` 退出。包括任一 test 前置条件失败（并发修改）、
   补丁负载文件无法写入（例如 `<OutputDirectory>/patch` 路径不可写）、回读失败；
   全部都不重试、不继续后续策略；
4. 成功后回读该策略，验证 UID 不变、spec 等于窄契约、selector 只为本项目；失败同样
   以 `3` 退出，不重试；
5. 全部完成后写 `<OutputDirectory>/apply-report.json`：context/namespace、顶层状态/
   appliedCount，以及每个项目的**最终状态**（`PATCHED` / `ALREADY_FIXED` / `FAILED` /
   `NOT_ATTEMPTED`）与 **before/after** `uid` 和 `resourceVersion`；已迁移项目不会再
   报告为 `NEEDS_MIGRATION` 或旧的 resourceVersion。

Apply 产物布局：`<OutputDirectory>/backup/<policy>.json`（修改前 NetworkPolicy）、
`<OutputDirectory>/patch/<policy>.json`（实际发送的 JSON Patch 负载）与
`<OutputDirectory>/apply-report.json`。补丁文件保留作为审计证据（失败/重跑时同名的
项目会被覆盖）；它只含 uid/resourceVersion 测试值和 podSelector 替换，不含 Secret。

## 6. 零遗漏完成判定与旧策略叠加

- 完成条件不是“新代码已部署”，也不是“新窄策略已创建”，而是：**清单内所有项目的旧
  策略都已被收窄或本来就是窄的，且清单外没有任何仍可能放行依赖 ingress 的宽策略。**
  任何一项不满足，脚本只报告并停止，不宣称迁移完成。
- 旧宽策略与新窄策略并存时，两者的允许规则相加，旧放行继续存在；因此预览/Apply
  都必须覆盖全部旧对象，不能只挑一部分处理。

## 7. 备份与回滚注意（重要）

- `backup/` 只保存修改前的 NetworkPolicy 对象，作为审计与对比证据；脚本不保存、
  不读取任何 Secret。
- `patch/` 保存实际传给 kubectl `--patch-file` 的 JSON Patch 负载，作为审计证据，
  也用于避免 Windows PowerShell 5.1 内联 JSON 引号丢失问题；它不是备份，不回滚使用。
- **回滚不能直接恢复旧宽放行**：把 backup 原样 patch 回去会重新打开跨项目依赖访问。
  如果确需回退，应另行构造仍带 project 约束的策略/变更并重新走审阅流程；任何回滚
  都必须保持 target selector project-scoped。
- 本任务没有备份任何真实集群对象（未执行 Apply）。

## 8. 测试（不连接集群）

```powershell
pwsh -NoProfile -File poc4/deploy/multi-account/repair-dependency-policy.test.ps1
```

测试用本地生成的 `mock-kubectl.cmd` 读取 JSON fixture 并记录每次调用，完全不接触
集群。覆盖（16 个 fixture 场景）：默认预览不写集群/不写文件（TEMP 指向文件时也必须成功、
空 TEMP 不残留文件、OutputDirectory 不创建）、旧/新 selector 识别、清单外宽策略拒绝、
fail-closed 复现（managed-by=本平台、component NotIn [workspace]、未知 label 必须拒绝；
component=web、component NotIn [mysql,redis]、其它 manager、无 ingress 规则可忽略）、
未知 spec 拒绝、清单内缺失策略拒绝、ProjectsFile 严格校验（非数组/数字字段/大写/末尾
连字符/null/重复）、大小写敏感身份与 spec、UID 与 resourceVersion 冲突分别模拟（含两条
候选时首条失败即停止、不触碰第二条、不重试、不回读、失败报告状态）、already-fixed 幂等、
备份仅包含 NetworkPolicy、每个 patch 调用都使用 `--patch-file` 且**拒绝内联
`--patch`**（mock kubectl 读取该文件内容并校验存在/非空，再交给 fixture 断言）、补丁只含
3 个操作且 test 的 uid/resourceVersion 值与审阅对象完全一致、补丁文件位于
`<OutputDirectory>/patch/` 并保留为审计证据、patch 后回读、回读 UID/spec/GET 失败负例、
补丁负载文件写入失败时保留已应用项并写 FAILED apply-report/退出 3（不落到通用 exit-1）、
apply report 的最终状态与 before/after 值。

退出码 `0` 表示全部 fixture 场景通过，非 0 表示失败。脚本兼容 Windows PowerShell 5.1
与 PowerShell 7；当前机器若没有 `pwsh`，可用
`powershell -NoProfile -File poc4/deploy/multi-account/repair-dependency-policy.test.ps1`
运行同一套测试。

测试 seam：`MANAO_REPAIR_KUBECTL` 可指向 kubectl 替身，仅用于 fixture 测试；
生产运行不要设置该环境变量。

## 9. 本任务状态

| 项 | 状态 |
| --- | --- |
| backend target selector 与创建顺序修复 + 单元/行为测试 | PASS（本地 Maven，定向测试类） |
| 迁移脚本与 fixture 测试 | PASS（本地，mock kubectl，无集群） |
| 真实集群预览/Apply | NOT_RUN（本任务禁止连接集群） |
| 跨账号依赖隔离真实验收 | NOT_RUN（需用户授权与人工操作） |

下一步（需用户单独授权）：准备已核对 ProjectsFile → 在目标 context/namespace 运行
只读预览 → 人工审阅 NEEDS_MIGRATION / OUT_OF_SCOPE 清单 → Apply → 保存
`backup/`、`apply-report.json` 与回读证据 → 再执行跨账号隔离验收。

部署顺序（避免迁移被旧 backend 回写）：先部署包含本分支 backend 修复的版本（其
`ensure` 只会创建窄 target 策略），或至少与脚本迁移在同一变更窗口内完成；如果旧
backend 仍在运行，它可能为新建/重启的项目重新创建旧的宽 target 策略，需要重新跑一遍
本脚本收窄并复核。

## 10. 多账号部署配置模板（config.example.env）

`config.example.env` 是本次多账号后端的配置模板：已知非秘密的 126 SMTP 参数
（`smtp.126.com` / `465` / `shilizhengnanren@126.com` / `ssl`）直接写入；
`MANAO_MAIL_ENABLED=false` 与 `MANAO_REGISTRATION_ENABLED=false` 保持发布默认值；
数据库、JWT、验证码 HMAC 等只保留空占位符。

- `MANAO_MAIL_PASSWORD` 是 126 **客户端授权码**（不是邮箱网页登录密码），只能由运行时
  Secret 或受控环境注入；该文件、本仓库、日志、测试报告和交接文本都不得出现真实值。
- `MANAO_AUTH_CHALLENGE_SECRET` 为服务端验证码 HMAC secret（至少 32 随机字节），部署时
  生成一次并持久化到运行时 Secret。
- 邮件与注册开关只有在用户授权的人工验收窗口才可启用；启用动作不属于本地交付物，
  本任务不执行真实 SMTP 连接/发信。
- 6B 清单侧的引用见 `poc4/deploy/6b/backend.yaml`：`MANAO_AUTH_CHALLENGE_SECRET` 与
  `MANAO_MAIL_PASSWORD` 通过 Secret `manao-backend-auth` 注入（key 分别为
  `AUTH_CHALLENGE_SECRET` / `MAIL_PASSWORD`），非秘密 SMTP 参数以普通 env 值写入，
  由部署者确认后再 Apply。

## 11. 旧账号邮箱人工绑定（bind-legacy-email.ps1）

历史账号的 `app_user.email` 为 NULL，无法走邮箱找回；本脚本是其**唯一**绑定入口，
不提供公网管理 API。操作者必须先在线下确认该账号所有者控制目标邮箱，再执行绑定。

**机制（为什么不是 JDBC/Python）**：先调查了仓库现状——后端使用 JDBC（
`JdbcStoreTestSupport` 等，仅 Java 测试内使用），前端运维脚本（
`poc4/frontend/scripts/ai-stage*-verify-ledger.mjs`）已有成熟的小型 mysql CLI 传输约定
（仅 env 密码、显式 host/port/db/user、不打印原 stderr）。本脚本沿用该现有约定作为
PowerShell 侧依赖最少的通道，并在其上收紧：密码经子进程环境变量 `MYSQL_PWD` 传递
（不接受/不打印命令行密码）；SQL 经 stdin 传入（不拼 shell 命令行）；所有数据访问使用
服务端预处理语句（`PREPARE ... ?` / `EXECUTE ... USING`），用户输入值只以十六进制
字面量（`X'...'`）绑定为服务器变量，SQL 语句文本本身保持常量，不拼接用户文本；
mysql client 使用 `--no-defaults` 避免本机 option file 改变目标。

**用法（默认只读预览）：**

```powershell
$env:MANAO_DB_URL='jdbc:mysql://127.0.0.1:3306/manao_poc4'
$env:MANAO_DB_USERNAME='manao'
$env:MANAO_DB_PASSWORD=''   # 仅从环境读取；不接受密码参数、不会打印
powershell -NoProfile -File poc4/deploy/multi-account/bind-legacy-email.ps1 -UserId '<account-id>' -ExpectedUsername '<exact-username>' -Email '<owner@example.com>'
```

- 预览打印精确的 `[WOULD_BIND] ... email=<normalized> emailVerifiedAt=<planned>`，不写任何行；
  只有显式 `-Apply` 才执行一次条件 UPDATE：
  `WHERE id=? AND username=? AND email IS NULL`（不覆盖既有绑定），要求恰影响 1 行，
  显式写入 `email_verified_at`，随后回读校验 email 与 timestamp。
- 幂等：同值重跑报告 `[ALREADY_BOUND] DB_RESULT=NO_OP`（`0`）；不同值拒绝（`4`）。
- 邮箱按后端同一规则规范化：trim、`Locale.ROOT` 小写、长度 <= 254、格式校验；
  不删除点、不剥离 `+tag`。
- 脚本只读写 `app_user.email`/`email_verified_at` 一个精确 id；不创建账号、不改用户名/
  密码/项目、不发邮件、不读取其他表。

**退出码**：`0` 成功/幂等 no-op；`1` 环境/传输/SQL/回读失败；`2` 参数或邮箱格式非法；
`3` 身份不匹配（UserId 不存在或 username 非精确匹配）；`4` 账号已有不同邮箱（拒绝覆盖）；
`5` 邮箱已被其他账号占用。

**自测（只创建/删除自己的 disposable schema，绝不触碰 `manao_poc4` / `manao_poc4_6b`）：**

```powershell
$env:MANAO_DB_URL='jdbc:mysql://127.0.0.1:3306/manao_poc4_test'
$env:MANAO_DB_USERNAME='manao'
$env:MANAO_DB_PASSWORD=''
powershell -NoProfile -File poc4/deploy/multi-account/bind-legacy-email.ps1 -SelfTest
```

自测生成唯一名 `manao_stage6_t8_<32 hex>` schema，用真实子进程入口覆盖：预览只读、
非法邮箱、错误用户名、已绑定不同邮箱拒绝覆盖、邮箱被他账号占用、`-Apply` 成功
（规范化 + `email_verified_at`）、同值幂等 no-op、不同值再次拒绝；结束在 `finally`
中 DROP 该 schema。若本机没有 mysql client 或不满足环境，脚本如实报 NOT_RUN/失败，
不会连接任何运行 schema。
