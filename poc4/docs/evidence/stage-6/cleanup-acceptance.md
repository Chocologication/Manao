# Stage 6 可靠清理切片：验收记录

日期：2026-09-12
工作树：`.worktree/ensoai-stage-6-real-backend-kubernetes`
分支：`codex/poc4-stage-6-real-backend-kubernetes`

## 结论

离线实现已完成到 RC-8 核验器与 runner。真实集群/基础五项重跑仍等待明确授权。

当前状态：`CLEANUP_IMPLEMENTED_REAL_ACCEPTANCE_PENDING`

这不是 6A PASS，也不能开始 6B。

## 已完成的离线证据

- RC-1..RC-3：DELETING 迁移、生命周期互斥、Kubernetes 分层 cleaner。
- RC-4：owner-scoped DELETE、DELETING 续作、本地句柄关闭。聚焦测试 100/0/0/0。全量后端 320 tests / 1 unrelated failure (`WorkspaceApiClientTransportTest` RST 分类) / 1 skipped (`Stage6aPreflightTest`)。
- RC-5：前端 DELETING 轮询与不可打开工作台。`pnpm typecheck` + `pnpm test` 1147 passing（当时）。
- RC-6：持久化台账、创建响应核对、逐项 sweep。`pnpm exec vitest run --config vitest.stage6-cleanup.config.ts` 12 passing（随后 RC-7 增至 17）。
- RC-7：三套 Stage 6 spec 接入 `resources.createProject` / `recordRun`；resume 工具默认只读。`playwright test --project=stage6 --list` 发现 10 个既有业务测试。
- RC-8：离线 parser 规则与 gated verifier；真实 leftover 核验未跑。

## 未跑 / 需要授权

- `STAGE6_GATE=1` 下 cleanup/basic Playwright。
- `-Dmanao.stage6.cleanup.verify=true` 只读 DB/Kubernetes/PID 核验。
- 故障注入、压力、Maven 成功与 Run 一致。
