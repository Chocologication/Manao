# Pi 阶段四实施 Agent 交接提示词

日期：2026-10-27。以下保留原实施交接提示词；当前本地实施已执行，继续工作先读[阶段四验收](../../../poc4/docs/evidence/ai-stage4/acceptance.md)，不要重复原实施或推断发布授权。

```text
你负责实现 Project_Manao 的 Pi 阶段四“暂停接管与手动继续”。

先读取以下文件，理解现有实现后按计划执行：
1. 实际checkout的 AGENTS.md；当前规划源checkout为
   D:/DeepLearning/MyProjects/Project_Manao/.worktree/ai-integration。
2. docs/superpowers/specs/2026-10-27-pi-stage4-control-recovery-design.md
3. docs/superpowers/plans/2026-10-27-pi-stage4-control-recovery-implementation-plan.md
4. docs/development-guide.md 中修改/AI合同/测试/清理部分。
5. poc4/docs/evidence/ai-terminal-settlement/cloud-faults-20261027.md，
   只用来理解已经完成的第三项与其证据边界。

用户已经确认：
- 原卡住Task恢复和Stage2正式验收先暂缓。
- 关键云端故障验证已经完成，不重新做完整故障矩阵。
- 当前实现第四阶段：暂停交还编辑权、用户修改后继续、浏览器重进、
  服务异常核对后手动继续，以及执行资源清理。
- “继续”是同一conversation的新Task：保留已持久上下文，读取当前保存版本，
  新taskId与新的1800秒/180工具/20构建预算；不复活旧Task、不沿用剩余预算、
  不重放旧工具。这个决定无需再次询问。

基线与工作区：
- 规划时AI分支为codex/ai-integration@1d410cd；执行前重新核对最新HEAD，
  不把这个SHA当永久基线，不从尚无AI实现的master开始。
- 使用superpowers:using-git-worktrees，在项目.worktree/下建立或核对复用
  pi-stage4-control-recovery，分支codex/pi-stage4-control-recovery。
- 源checkout有其他会话未提交的云端证据与文档整理，不能stash/reset/覆盖，
  也不能git add .混入本轮提交。三份规划文件如未提交，逐字复制到新worktree，
  核对SHA256；读取源checkout当前规则与证据，不整体复制其未提交树。
- 使用superpowers:executing-plans逐项执行；只有用户明确选择委派实施时，
  再使用subagent-driven-development，不能默认生成多层agent流程。

按五项任务推进：
1. 薄pause API、已有close_reason_code投影、Worker实际退出核对。
2. 确定旧Worker丢失后进入原收尾，核对完成后等待用户手动继续。
3. 长构建轮询关闭意图，调用原cleanup，确认Job/Pod退出后释放claim。
4. 前端暂停/继续、权威状态与版本刷新、同conversation新Task提交。
5. 复用local HTTP/MySQL/真实SDK scripted-provider夹具，完成定向测试、
   三条浏览器链、验收文档和发布准备。

最小实现边界：
- 预期不新增数据库迁移/表、生产服务、第三方依赖、scheduler或恢复引擎。
- 不增加PAUSED/RESUMING数据状态，不引入逻辑Task父表、剩余预算或自动续跑。
- 保留现有QUEUED/RUNNING/NEEDS_ATTENTION/COMPLETED/FAILED状态；
  “已暂停”是已安全结束执行加AI_PAUSED_BY_OWNER原因的UI投影。
- 复用close/receipt/reconciler和conversation提交，新增pause不接受任意原因参数。
- 尚未绑定Worker的启动窗口不接受新pause，返回409 AI_TASK_STARTING，
  显示稍后可暂停；原End task仍可用。不要为此新增补绑协议。
- 长构建使用窄Predicate查询真实close intent，不误用将所有非运行状态
  都当作关闭的hasClosingIntent。沿原UID/owner/commandId核对和cleanup。
- 复用现有revision/SHA保护和重读提示，不新建Worker读取凭证Map。
- 不全面拆分TaskStore，不顺手重构无关模块；仅有真实复用收益才提取小函数。
- 本阶段不开放自由Shell、多Agent产品能力、MCP/Skills、Python适配或执行池。

必须保持的正确性：
- HTTP200、abort请求、STOPPING或单个404不表示停止完成，不能提前允许编辑。
- 暂停先持久冻结新副作用，原执行主动停止；live claim/写receipt/Run/Job
  未确认就继续占用。不得重放结果不明的mutation或应用HTTP。
- CLOSING ACK先可被确认，Worker退出并释放slot后才满足新pause严格门槛；
  不能让ACK等待最终解锁而造成双方互等。
- Worker重启判断只在稳定的新boot、原task明确404、旧instance已绑定、
  同epoch且无receipt/关闭意图的条件下CAS；timeout/401/坏JSON都不是死亡证据。
- deadline=NULL的历史任务不被新恢复策略自动接管，尤其不处理
  b3b32518-f0ed-411e-aa85-1ecef95fbdc5。
- 正常COMPLETED保留READY应用；暂停/失败只清理本Task登记的目标，
  其他Run不误停；Run锁仍生效。
- 继续使用同conversation最新结果和新的已保存revision；dirty内容不丢失，
  响应丢失先核对同一个新taskId，多标签页不能重复执行。

实施与验证：
- 按计划先加能复现合同缺口的RED测试，再最小实现并验证GREEN。
  不为低风险文档写机械测试，不拿环境错误充当RED。
- 使用CodeGraph定位代码；库/SDK文档按AGENTS用Context7，
  Pi仍固定1.2.0，核对本地声明，不能借文档查询升级依赖。
- Java测试只用本机disposable schema，不重置运行schema。
- pnpm，禁止npm；Python若涉及，仅项目隔离环境与uv add/remove。
- 修改前重读文件；UTF-8无BOM，遵守行尾规则；最终检查git diff --check。
- 本地fixture资源为mock，不能标作真实Pod/子进程或完整工作台云验收。
- 本轮默认做到本地实现、定向测试、必要构建、文档、任务级本地提交和交付。
  不部署集群、不调用付费模型、不Git push/merge，不恢复原任务或清理历史资源。
  先完成可审阅的本地结果；只有后续用户明确授权才发布/云验收。
- 完成后清理本轮无用临时schema/PID/scratch，记录真实删除结果；
  其他会话残留和必要证据保留，拒绝的操作不能换工具绕过。

交付前自检重点：
每个新抽象/状态/表/依赖是否对应一个当前不可替代需求？能否复用已有接口？
删减是否会失去停止证明、版本保护、提交幂等或owner隔离？
遇到实现细节可按现有约定自主处理；只有真实阻塞或要改变已确认体验/范围，
才向用户询问，不把普通可逆步骤变成审批流程。

最终报告：分支和HEAD、五任务结果、关键设计取舍、真实测试命令及结果、
失败/未验证项、临时清理结果、可审阅diff。只有证据足够才授予
LOCAL_STAGE4_CONTROL_VERIFIED；云端未跑写NOT_RUN。Stage2保持PAUSED /
NOT_GRANTED，旧故障Task保持NOT_REPAIRED，不能宣称整个AI首版已验收。
```

设计与计划链接：[设计](../specs/2026-10-27-pi-stage4-control-recovery-design.md) · [五任务实施计划](2026-10-27-pi-stage4-control-recovery-implementation-plan.md)。
