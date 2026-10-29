# Pi 第一阶段实施交接提示词

本文件由用户要求准备，供复制到其他 Agent 的新会话。当前仅规划，尚未执行下面的实施任务。转交时一并提供整个工作树中的设计与计划，不只提供本提示词。

以下正文可直接复制：

```text
你负责在 Manao 的 AI 集成工作树中实施 Pi 第一阶段。请执行代码实现和与当前阶段相称的验证，按可演示结果推进，避免过度工程化。

工作目录：D:\DeepLearning\MyProjects\Project_Manao\.worktree\ai-integration
分支：codex/ai-integration
代码基线：ef852b7；实施前核对实际 HEAD 和 git status。存在本轮规划文档及索引修改时保留，不 reset、不切回主 checkout、不另建不必要的工作树。

先读：
1. 当前工作树 AGENTS.md、CONTEXT.md。
2. docs/research/2026-10-13-ai-integration-framework-evaluation.md 第 10 节的已确认决定。
3. docs/research/2026-10-13-pi-minimal-integration-implementation-slicing.md。
4. docs/superpowers/specs/2026-10-13-pi-stage1-design.md。
5. docs/superpowers/plans/2026-10-13-pi-stage1-implementation-plan.md。

目标：用户在浏览器下达 Spring Boot 修改目标 → Pi 理解需求 → 自主读取并修改当前项目代码 → 执行真实 Maven 构建测试 → 读取错误并修复 → 展示实际代码与构建结果。

当前只实施第一阶段：
- 新增 Node Pi worker，接入服务器统一配置的云端模型 API。
- 暴露 list_files/read_file/write_file/build 四个项目工具。
- 文件工具直接修改真实项目，沿用保存版本及 receipt。
- build 仅 compile/test/package；源码只读复制到临时构建目录，不回写。允许 Pi 自行决定工具顺序和修复，不预写固定的代码生成工作流。
- 新增最小持久 task/tool-call 两张表、项目独占写入、稳定编号及模糊结果核对。
- 最薄浏览器任务入口：目标、进度、输出、修改路径、结束任务、实际代码刷新。
- 完成可复现的失败→修复→测试通过证据。

不要进入应用 Run 自动停启、HTTP CRUD、数据库验证、暂停接管或异常续跑。阶段 1 遇 active Run 要拒绝并提示先停止；占用期间所有普通写、Run.start、删除等入口都必须拒绝。close 是结束任务和核对收尾，不是暂停／恢复。

用户已确认首轮使用无重要既有数据的专用验收项目，项目数据库全部自动。不要再为首阶段建设旧表只读、任务受限DB账号、逐次数据库审批。该授权只限该项目；本阶段构建本身无需DB凭据，也不能操作 Manao 平台或其他项目。

设计原则：
- 使用 codebase-design：Module 的 Interface 小，复杂度集中到项目工具和执行 Implementation；依赖从调用方注入。只有真正需要变化或测试 Adapter 的 Seam 才建 Interface。
- 复用现有文件协议、Java runner、Maven缓存、用户/项目鉴权、数据库测试和工作台。不要扩成通用任务平台、工作流引擎、事件总线、provider框架或插件平台。
- Pi SDK 负责模型与工具循环；Manao 负责真实项目执行与状态。不要把 Pi 变成只生成文本、由脚本替它修改的演示。
- 从第一次真实写入就实现占用、稳定操作ID和未知结果阻塞；不盲重放可能已应用的写入/Job，不以浏览器断连或 SDK abort 推断远端进程已停止。

执行方式：
1. 先确认代码与计划的少量差异；常规实现细节自行决定。遇到会改变已确认体验或扩大范围的差异，整理具体证据及更小方案再说明。
2. 按计划 Tasks 1→6 顺序实施。使用 superpowers:subagent-driven-development（若可用）或 executing-plans；行为代码先有失败测试，再最小实现和定向验证。不要重新询问已经确定的实现方式，也不要只输出另一份计划。
3. 每任务聚焦提交，记录测试命令和真实结果。独立审查可以并行；共享文件的实现任务不要并发编辑。
4. 接 SDK 前使用 Context7，并核对参考仓库 D:\DeepLearning\MyProjects\Project_Manao_ai_references\pi 的固定快照 7d75a0e3。SDK固定 @earendil-works/pi-coding-agent@1.2.0，Node>=22.19.0，pnpm10.33.0；验证包分发与lock，不静默升级。资源加载显式受控、禁内置文件/bash，模型key/session不进入项目或开发Job。
5. 不为审查便利打印秘密，不读出整份私密配置。模型 provider/API type/baseUrl/model/key 缺失时，先完成不依赖真实模型的实现与测试，最后列出缺失项。不能自行选择付费provider、填造密钥或将mock记为实测。
6. 当前转交授权代码实现、定向单元/适配测试、隔离本地容器验证及发布准备。现有云部署/运行库迁移/共享集群验收需要用户明确授权；先把待发布镜像、迁移、manifest、回滚和验收命令准备成可审阅结果，不提前修改现有6B环境。真实验收条件具备且获授权后执行计划Task6相关步骤。

必须遵守：
- 前端及worker只用pnpm，不用npm。Python环境和依赖沿用uv，第一阶段不改Python工具链。
- Windows修改前重读最新文件，小补丁；UTF-8无BOM，shell/Docker入口LF，git diff --check。
- MySQL测试使用disposable schema，禁止重置manao_poc4/manao_poc4_6b。
- worker只持模型能力；用户源码/插件/测试在开发Job中运行。构建main不挂源码PVC，只挂scratch/cache/tmp；无平台凭据和SA token。Pod实际收尾后才允许下一次副作用。
- 不把 ProjectLifecycleGate 持有整个任务。它是线程短锁；提交任务与旧写入口共用同一短gate，任务占用必须持久，未知状态不能按超时直接释放。close先在后端持久封住新调用，再stop worker及收尾，不能反过来。
- SDK事件中的agent_end可能willRetry，provider错误也可能正常settle；串行发送完整进度，检查stopReason和实际工具收尾后再结算，不把prompt resolve直接当成功。
- AI代码使用TypeScript不等于实现TS用户项目运行时，Go/TS语言适配继续跳过。
- CodeGraph在该worktree之前曾返回主checkout索引；确认projectPath与索引归属，错误/陈旧时用精准rg/read，不自行初始化索引。
- 不运行历史6A/6B门禁，不改已经关闭的阶段结论。只清理本轮自己的临时文件/验收项目；未知残留保留诊断。

验收：
1. 使用专用Spring Boot项目、独立DemoControllerAcceptanceTest，并故意预置可定位错误。
2. 浏览器提交自然语言目标；真实Pi完成至少一次Maven失败反馈→代码修复→Maven测试成功。
3. 独立复验预置测试未被削弱，实际文件、revision、构建退出码、工具身份和清理结果吻合；成功构建与独立复验都检查Surefire报告确实执行指定测试且无失败/错误/跳过，不能只看exit0；编辑器显示新代码。验收项目先bootstrap再配置服务器projectId，Playwright使用该已有ID，不自动换项目。
4. 任务占用、重复请求、错误token/owner、dirtybuffer、只读源码、未知Pod状态等定向回归通过。
5. 单元/mock、真实容器、真实云模型、真实集群分别记录。只有真实链路及独立复验通过才记 PI_STAGE1_CODE_TEST_LOOP_PASS；不能声称完整CRUD/完整AI首版已验收。

最终交付请用中文说明：
- 完成了哪些Tasks、对应提交和改动目的。
- 测试命令与结果，模型/镜像/源码版本，实际验收证据路径。
- 未完成/被环境阻塞的内容及具体缺失条件；不要用“测试通过”掩盖未实测项。
- 需要用户执行或授权的最后一步，以及可审阅的发布准备。
- 所有文档状态与代码真实一致；完成后停在第一阶段，不自动实现下一阶段。
```

## 交接材料

- [第一阶段设计](../specs/2026-10-13-pi-stage1-design.md)
- [第一阶段实施计划](2026-10-13-pi-stage1-implementation-plan.md)
- [整体实现拆分](../../research/2026-10-13-pi-minimal-integration-implementation-slicing.md)

将提示词交给实施 Agent 后，具体实现记录继续写入计划勾选与 `poc4/docs/evidence/ai-stage1/acceptance.md`；本规划回合没有这份验收结果。
