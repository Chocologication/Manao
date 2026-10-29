# AI 任务可靠收尾修复：实施 Agent 提示词

将下面分隔线内的内容交给实施Agent即可。提示词授权本地实现和验证，不包含部署或线上项目状态修改。

---

你负责实现 Project_Manao 的“AI任务可靠收尾”修复。不要停在重新分析或复述计划；完成计划中的本地实现、测试、文档和发布准备后交付可审查结果。

## 先读这些文件

文档源worktree：D:/DeepLearning/MyProjects/Project_Manao/.worktree/ai-integration，分支codex/ai-integration，计划编写时HEAD=8d4c573。

1. 该worktree的AGENTS.md与根目录用户指导。
2. docs/superpowers/specs/2026-10-25-ai-terminal-settlement-design.md
3. docs/superpowers/plans/2026-10-25-ai-terminal-settlement-implementation-plan.md
4. poc4/docs/evidence/ai-output/terminal-settlement-20261025.md
5. 同目录terminal-settlement-race-safe.json、terminal-settlement-diagnostic.java.txt、terminal-settlement-probe.mjs.txt
6. 按需阅读现有close、工具receipt、Run生命周期的代码和测试；代码库有.codegraph时先使用CodeGraph。

## 目标与已知原因

现象：AI Worker已完成，数据库Task仍RUNNING、lastSeq36，项目写权限和Stop run被持续锁住。

已验证机制：Run恢复巡检持project gate时，最后message和terminal均可收到409 PROJECT_BUSY；Worker两次紧接尝试后吞错，没有可靠补投/后台对账。历史binlog与该竞争吻合，但没有历史HTTP抓包，不能宣称已百分之百还原首次请求。

原故障项目bdddc018-f472-4fb9-a636-f164ed37b0cc、Task b3b32518-f0ed-411e-aa85-1ecef95fbdc5只是调查身份。不得把它们用于本地故障注入或自动线上恢复。

## 工作区和工作流

- 先检查git status/worktree/HEAD。master没有AI实现，不能从master开发。
- 按using-git-worktrees技能，从核对后的AI基线8d4c573建立或复用 .worktree/ai-terminal-settlement / codex/fix-ai-terminal-settlement。若AI基线后来变化，先审查相关diff，记录实际基线，不盲用旧SHA或覆盖用户改动。
- 源worktree的本轮调查/设计/计划可能尚未提交。逐文件复制到实施worktree同相对路径，核对内容；AGENTS只补相关索引，不覆盖整个文件。不提交.zcode配置、用户讨论、私有env、binlog或凭证。
- 默认执行superpowers:executing-plans与test-driven-development；此提示词不要求创建子Agent。若用户另行明确要求SDD，再按subagent-driven-development做任务与评审。
- Task1→Task8按依赖顺序，RED→GREEN，任务级提交。不要先改实现再补写失败测试。用verification-before-completion确认实际结果。
- 普通实现细节自主处理；协议/范围冲突以设计为准并更新书面记录。只有改变用户语义、扩大资源删除范围、增加基础设施或必要环境缺失才提出具体问题。

## 必须实现的结果

1. 独立terminal接口，带稳定reportId与内容摘要；短事务先持久保存并冻结新工具，再ACK。不争抢Run巡检的project gate，不依赖展示progress连续seq。
2. 终态同内容重发/ACK丢失/任务已结束后重发均幂等；不同内容、旧epoch、错instance明确拒绝；晚到成功不能逆转持久close。
3. Worker把“执行结果”与“投递确认”分开；有界退避，同一报告身份，不把发送失败伪装为完成或生成第二份相反结果。最终Context先持久化。
4. 后台有界reconcile从DB收据继续，逐一核对原工具、文件receipt、Job/Run；成功保留READY应用；失败/用户结束/期限到期冻结后停止并确认，不能提前放写权限。
5. 新任务服务器deadline=created_at+1800s；重启/重试不续期；旧任务deadline=NULL默认不自动处置。Worker404/无进度/最终聊天文本都不能作为成功或停止证明。
6. 周期恢复不再每15s把正常RUNNING置RECOVERING；启动与authority takeover仍恢复未完成Run，保留STOPPING/USER_STOPPED/fencing规则。
7. 当前AI任务“结束/重试结束”始终可达，选中历史会话也不会指向错Task；close先快速保存意图，UI轮询真实释放。Stop run禁用有原因和转到AI入口；启动上限、服务寿命、AI预算分别展示。
8. 新旧协议、迁移、重启、丢ACK、缺号、锁竞争、close竞态、未知副作用、调度公平性均按计划A–N验证。

## 实现纪律

- Pi固定1.2.0、Java17、pnpm、现有架构；不增加MQ/Redis队列/Worker PVC/通用workflow平台。
- 不能只增加一次重试、删锁、放开Stop run或直接SQL改FAILED来宣称修复。
- 新 terminal receipt ACK 与 project writes unlocked 是两个不同事实。
- 普通progress、最后Context、终态收据有各自语义；不造假补缺失消息，不把FAILED变COMPLETED。
- 关闭只针对该Task有合法记录的原副作用；禁止触碰其他项目或未关联的应用。UNKNOWN保持NEEDS_ATTENTION并可重试，不清空现场求绿。
- 所有外部IO在短DB事务/gate/任务monitor之外；不能把现有120s等待放进单线程维护循环，导致其他Task或Run维护阻塞。
- 使用真实MySQL的独立临时schema，禁止reset现有运行库；用Clock/Latch/fake timers构造确定性测试，不真实等30分钟、不依赖付费模型。
- Windows编辑前读最新文件；UTF-8无BOM，遵守.gitattributes；apply_patch失败先重读，不盲重试；git diff --check。
- 不打印密码/token/模型请求或响应全文。日志保留固定安全字段，能够区分PROJECT_BUSY、网络失败、身份冲突与ACK不匹配。

## 明确的执行边界

允许：实施worktree内代码/测试/文档，任务级本地提交，本机临时测试服务与临时MySQL schema，本地scripted-provider浏览器回归，发布/回滚/存量恢复操作手册。

暂不执行：云端镜像push/rollout、迁移运行库、重启/删除集群资源、付费模型调用、恢复或关闭上述原故障Task、Git push/merge。等本地结果可审查后，交付发布清单供用户后续决定。

此前清理临时文件被自动审批拒绝，不得换工具绕过。不依赖旧Temp文件；本轮新建临时资源按精确路径/schema盘点清理，拒绝则如实记录实际保留项。

## 完成时必须交付

- 实施worktree/分支/基线/最终SHA与提交列表。
- 计划Task1–8完成情况，A–N矩阵的命令、计数和结果；RED/故障复现与GREEN证据。
- 与真实MySQL和本地HTTP的完整复现，浏览器结束/恢复写入验证；产品假设与mock边界写清楚。
- 加法迁移、后端先行协议兼容、pending收据下的回滚限制；原故障项目只提供dry-run与授权后的owner-close步骤。
- 更新AGENTS、验收文档、发布README。标明LOCAL_REPAIR_VERIFIED、云端NOT_RUN、原Task NOT_REPAIRED；不能改变既有Stage2 PAUSED/NOT_GRANTED。
- 临时schema/文件实际清理结果与所有未解决问题。

现在从工作区和基线核对开始，然后执行Task1。不要重新让用户回答已经写入设计的常规决定。

---
