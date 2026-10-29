# 协作与验证指南

本页保存按场景查阅的长期约定。产品状态查项目进度，测试结果与发布身份查对应专题记录；不要把历史授权或旧计划当作新任务授权。

## 开始修改

- 先核对实际 checkout、分支和本地改动，保留不相关修改；新实现分支放在项目 `.worktree/` 下。保留的已完成阶段 worktree 不是新工作的默认基准。
- 以当前任务指定的分支为准，从该 checkout 解析相对路径。不要把某日的 `master` SHA 写成永久基线。
- 用户叙述默认简体中文，代码、命令和技术标识保留英文；先讲影响和结论，再补必要证据。
- 前端使用 pnpm。Python 使用项目隔离环境与 uv，添加/删除依赖只用 `uv add/remove`，不用 npm、pip 或 `uv pip install/uninstall`。
- 新阶段和范围扩展需明确约定。旧 Task 编号、旧 gate 和已完成计划不自动成为当前执行指令；发布、模型调用、原任务恢复和资源删除分别遵循本次任务授权。

## Windows 文件修改

- 每次编辑已有文件前重读磁盘上的最新内容；优先小范围 patch。patch 失败后重读并缩小修改，或定点重写，不盲目重试。
- 生成内容使用 UTF-8 无 BOM。用 PowerShell 或其他方式直接重写后检查编码，遵守 `.editorconfig` / `.gitattributes`；Shell、Docker 入口尤其要保持 LF。
- 有意义的变更更新对应职责文档，不把实现流水追加到 `AGENTS.md`；链接从当前文件相对解析，不依赖私人 worktree 路径。

## 修改运行时或 AI 合同

### 应用与项目依赖

- 沿用 Job + Service 及现有 Run、日志和清理模块；应用失败由用户手动重跑，不默认引入应用 Deployment 或自动重启框架。AI 编程任务内已约定的自动 stop / wait / start 是单独的任务合同。
- 公网端口由用户输入，范围 30000–31000；冲突要求用户修正，不能自动换端口。容器端口只需合法，不附加产品范围限制。
- 项目 MySQL 数据使用独立 PVC，跨应用停止与重跑保存。应用成功启动后的两小时寿命、SERVICE 启动/就绪时限、AgentTask 期限和工具预算是不同概念，按对应设计处理。
- Maven 私有缓存放在该项目已有 workspace PVC 的 code subPath 之外，跨 Run 保留，随项目删除回收。不得添加缓存 PVC、跨项目可写缓存或无需求的通用 provider 框架。镜像预置依赖改善应用运行准备，不保证工作区瞬时创建。
- Workspace mutation 传输失败时保持 fail-closed；重试前核对 durable receipt、operation ID 和 digest，不能重放可能已经执行的写操作。

### AI 范围

- 已确认 Pi SDK、云端模型 API、直接修改当前用户项目及 Agent 独占项目写权限；Agent 不得操作 Manao 平台或其他用户项目。本地模型推理不在范围内。
- 编程任务可按合同自动管理应用 stop / wait / start，必须等旧 Run 退出后再编辑。浏览器断开不等于任务停止，进程状态也不能替代持久化收尾证据。
- 用户接管前必须确认执行已经停止并释放占用；历史任务的恢复不能直接重放原模型或工具调用。具体收尾和 owner close 行为以当前修复设计为准。
- 普通项目操作按已确认合同自动执行，破坏性或其他高风险操作需确认。初始专用验收项目没有重要既有数据，其项目库内操作已明确约定自动执行；该特例不覆盖平台库、其他项目或项目资源删除。重要既有数据的策略仍需另行设计。
- 选型时期的 free Shell、MCP/Skills、多 Agent 等目标不等于已交付工具。Go/TypeScript 不是 AI 的前置任务，后续语言和功能扩展按新范围处理。

## 本地联调与集群操作

- 接受的云环境使用 `cluster` profile、`manao-stage6b` namespace、`manao_poc4_6b` schema 和 `manao-backend` ServiceAccount。浏览器日常使用不依赖本地 Vite/backend、SSH 隧道或 workspace bridge。
- 明确进行 6A/本地调试时，`local-cluster` 默认经 `kubectl port-forward` 连接服务端确定的 workspace Pod。`MANAO_KUBECTL` 选择可执行文件；`MANAO_BRIDGE_MODE=fabric8` 仅作传输对比，`supervised` 需要有意管理的外部 bridge。
- 集群操作前核对目标 context、namespace、已加载凭据、节点就绪和调度容量；本地调试另查隧道。旧快照、历史连接成功或每用户八项目上限不证明当前健康与容量。
- 精确部署命令、镜像 digest、迁移顺序和回滚以对应发布手册为准，环境说明不能替代发布记录。
- 私人 SSH / kubeconfig 配置在仓库外；凭据刷新不改变 RBAC，已缓存凭据的服务需重新加载。密码、token、私钥、原始 kubeconfig 和未脱敏 trace 不进入提交。

## 测试与证据

- 选择与实际修改或失败范围相称的验证。可逆、低影响的文档修改不启动业务服务或重复全套验收；代码合同变化验证相关路径。
- schema-reset 测试只能使用 disposable schema；禁止重置运行库 `manao_poc4` / `manao_poc4_6b`。区分测试账号/迁移权限问题与运行时缺陷。
- 区分实现、局部测试、部署、真实浏览器/模型验证与用户验收；本地 fixture、独立 operator 样本或一次冒烟不能替代完整主流程与收尾证据。
- 保留 PASS、FAILED、SKIPPED、WAIVED_BY_USER、NOT_RUN、NOT_REVERIFIED 等区别；旧测试数与耗时是日期明确的样本，不是当前分支重跑结果或性能保证。
- 6A/6B 已按各自 MVP 范围关闭；完整 PTY/audit/stress/fault matrix 不因阶段关闭而获得 PASS。AI 各阶段及收尾修复的结论分别以所属记录为准，不能互相替代。

## 清理

- 区分本地产物清理与运行资源清理，前者不授权后者。先核对目标路径和归属，保留必要报告与未解决问题的最小诊断证据。
- 避免广泛 `git clean` / `mvn clean`、reparse-target 删除或移除有效配置。记录实际删除结果，命令被拒绝不能记作清理完成。
- 运行资源清理必须限定 project 和 owner，并检查 initializer/workspace/Job/Service/PVC、适用的 PV/存储残留及关联数据库行；`afterAll` 成功不能单独证明零残留。不得删除平台 MySQL PVC。
- 会话结束时清理本次生成且后续不需要的临时文件；保留未解决的、已明确归属的诊断材料。
