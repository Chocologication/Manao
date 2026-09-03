# 阶段六 6A 第二轮修复台账（superpower-subagent-driven-development）

计划：poc4/docs/plans/2026-09-03-ensoai-stage-6a-gate-round2-remediation-plan.md
团队：AgentTeams stage6-remediation（implementer2=deepseek-v4-flash+max，reviewer1=deepseek-v4-pro+max，fixer1=deepseek-v4-pro+high 备用）

## Rulings（按序）
- R8: 最终评审 Important #1（输入流控断言运行时确定性）— 保留硬断言（计划 R4/R7 设计：以明确诊断失败而非静默通过），交外部复跑验证 — 代价：真实复跑可能硬失败一次，按诊断消息调整。
- R7: 输入侧流控断言的运行时确定性无法在沙箱内验证（无真实后端）；修复轮 2 只消除自死锁并做有界等待构造，真实验证并入 6A 外部复跑 — 代价：若真实运行暴露断言不稳需再修一轮。
- R1: 设计 startupProbe 条款适用对象为 6B 后端；本轮为 workspace Pod 补写等价条款（不修改 6B 小节）— 若评审反对则回退该文档修改。
- R2: supervised 模式无 factory 不可重建，如实上报监听状态；重建责任在外部操作者 — 代价：监督进程失联时依赖错误持续至操作者修复。
- R3: test:e2e:stage6:channels 脚本与 .env.cluster.example/README 等 6B 证据资产不在本轮范围（Task 11 步骤 2+ 需 6A PASS 后）— 代价：channels 脚本延后。
- R4: 操作者注入型故障用 STAGE6_FAULT 环境变量分阶段门控（未设置→skip）— 代价：纯自动复跑不含这些故障断言。
- R5: 计划存放路径沿用项目惯例 poc4/docs/plans/ — 代价：无。

## 任务进度
- R2-1（探针）: complete (65b411bb1b6fbb7b194e68867afd0a634bc208b4, review clean)
- minor (deferred): design.md:321/322 workspace Pod startupProbe 条款与 6B 后端 startupProbe 条款邻近冗余 — 最终评审分拣
- R2-2（bridge）: complete (293d0c08eab0215f90506ee65937808b9231d2cb, 42c466bc7788b6be2e84aeec5a729d86ac887f57, review clean)
- R2-3（spec）: fix round 1/5 (1 addressed, 1 new Important: 输入突发自死锁/不触发风险 — 复审引入)
- R2-3（spec）: fix round 2/5 (1 addressed, 0 open — 行式输入+有界等待; commits 5ba3443..26331be)
- R2-3（spec）: complete (bfb0d55c43fba258305cf5a156b7dd111affa683, 5ba34433ac6dce468a5e1fffcf2180e036427eb2, 26331be5b57f9683401b26edbb2ec5f825293d5f, review clean)
- R2-3 minor (deferred): 墙钟预算与「累计暂停」措辞不一致 — 最终评审分拣
- R2-3（spec）: review round 2 → 进入修复轮 2（Ruling R7）
- R2-3 minor (deferred): inputFrames 死代码；resizeGeneration 仅客户端计数；faults 注释与 close() 帧语义不符；replayBytes 3s 收尾宽限；三 spec 重复助手 — 最终评审分拣
- R2-4（证据）: complete (证据文档提交 = 最终 HEAD，见 git log)