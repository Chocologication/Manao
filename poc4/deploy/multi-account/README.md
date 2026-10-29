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

退出码：`0` 成功/无需操作；`2` 范围与完整性校验拒绝（未做修改）；`3` patch 或回读
失败；`1` 意外错误。

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
2. 发送 JSON Patch：`test /metadata/uid`、`test /metadata/resourceVersion`、
   `replace /spec/podSelector`——**只替换 podSelector**，不动 ingress、来源、端口、
   labels 或名称。patch 负载是紧凑 JSON，作为 `--patch` **参数数组**直接传给 kubectl
   （不写临时 patch 文件、不拼接 shell 字符串）；
3. 任一 test 前置条件失败（并发修改）→ 立即停止并以 `3` 退出，不重试、不继续后续策略；
4. 成功后回读该策略，验证 UID 不变、spec 等于窄契约、selector 只为本项目；失败同样
   以 `3` 退出，不重试；
5. 全部完成后写 `<OutputDirectory>/apply-report.json`：context/namespace、顶层状态/
   appliedCount，以及每个项目的**最终状态**（`PATCHED` / `ALREADY_FIXED` / `FAILED` /
   `NOT_ATTEMPTED`）与 **before/after** `uid` 和 `resourceVersion`；已迁移项目不会再
   报告为 `NEEDS_MIGRATION` 或旧的 resourceVersion。

## 6. 零遗漏完成判定与旧策略叠加

- 完成条件不是“新代码已部署”，也不是“新窄策略已创建”，而是：**清单内所有项目的旧
  策略都已被收窄或本来就是窄的，且清单外没有任何仍可能放行依赖 ingress 的宽策略。**
  任何一项不满足，脚本只报告并停止，不宣称迁移完成。
- 旧宽策略与新窄策略并存时，两者的允许规则相加，旧放行继续存在；因此预览/Apply
  都必须覆盖全部旧对象，不能只挑一部分处理。

## 7. 备份与回滚注意（重要）

- `backup/` 只保存修改前的 NetworkPolicy 对象，作为审计与对比证据；脚本不保存、
  不读取任何 Secret。
- **回滚不能直接恢复旧宽放行**：把 backup 原样 patch 回去会重新打开跨项目依赖访问。
  如果确需回退，应另行构造仍带 project 约束的策略/变更并重新走审阅流程；任何回滚
  都必须保持 target selector project-scoped。
- 本任务没有备份任何真实集群对象（未执行 Apply）。

## 8. 测试（不连接集群）

```powershell
pwsh -NoProfile -File poc4/deploy/multi-account/repair-dependency-policy.test.ps1
```

测试用本地生成的 `mock-kubectl.cmd` 读取 JSON fixture 并记录每次调用，完全不接触
集群。覆盖（15 个 fixture 场景）：默认预览不写集群/不写文件（TEMP 指向文件时也必须成功、
空 TEMP 不残留文件、OutputDirectory 不创建）、旧/新 selector 识别、清单外宽策略拒绝、
fail-closed 复现（managed-by=本平台、component NotIn [workspace]、未知 label 必须拒绝；
component=web、component NotIn [mysql,redis]、其它 manager、无 ingress 规则可忽略）、
未知 spec 拒绝、清单内缺失策略拒绝、ProjectsFile 严格校验（非数组/数字字段/大写/末尾
连字符/null/重复）、大小写敏感身份与 spec、UID 与 resourceVersion 冲突分别模拟（含两条
候选时首条失败即停止、不触碰第二条、不重试、不回读、失败报告状态）、already-fixed 幂等、
备份仅包含 NetworkPolicy、patch 只含 3 个操作且 test 的 uid/resourceVersion 值与审阅对象
完全一致、patch 后回读、回读 UID/spec/GET 失败负例、apply report 的最终状态与 before/after 值。

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
