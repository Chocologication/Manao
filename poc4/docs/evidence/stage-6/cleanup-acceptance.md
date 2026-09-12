# Stage 6 可靠清理切片：验收记录

日期：2026-09-12
工作树：`.worktree/ensoai-stage-6-real-backend-kubernetes`
分支：`codex/poc4-stage-6-real-backend-kubernetes`

## 结论

离线实现仍在 RC-8。2026-09-12 16:20 真实验收未通过：cleanup Playwright 创建了项目 `07f3cfca-9a39-48b3-8215-9677ad5c2eb8`，但运行中的后端对 owner DELETE 返回 `500 INTERNAL_ERROR`，项目停留 `READY`，台账 `UNRESOLVED / CLEANUP_REQUEST_FAILED`。诊断资源 `083b8efd-9f57-4cb4-aa6f-646b37bd6d57` 的 Pod/PVC resourceVersion 未变。C08、压力、故障未跑。

当前状态：`CLEANUP_IMPLEMENTED_REAL_ACCEPTANCE_PENDING`

这不是 6A PASS，也不能开始 6B。

## 已完成的离线证据

- RC-1..RC-3：DELETING 迁移、生命周期互斥、Kubernetes 分层 cleaner。
- RC-4：owner-scoped DELETE、DELETING 续作、本地句柄关闭。聚焦测试 100/0/0/0。全量后端 320 tests / 1 unrelated failure (`WorkspaceApiClientTransportTest` RST 分类) / 1 skipped (`Stage6aPreflightTest`)。
- RC-5：前端 DELETING 轮询与不可打开工作台。`pnpm typecheck` + `pnpm test` 1147 passing（当时）。
- RC-6：持久化台账、创建响应核对、逐项 sweep。`pnpm exec vitest run --config vitest.stage6-cleanup.config.ts` 12 passing（随后 RC-7 增至 17）。
- RC-7：三套 Stage 6 spec 接入 `resources.createProject` / `recordRun`；resume 工具默认只读。`playwright test --project=stage6 --list` 发现 10 个既有业务测试。
- RC-8：离线 parser 4/0/0/0；gated verifier 在未设 `-Dmanao.stage6.cleanup.verify=true` 时 1 skipped。真实 leftover 核验器已实现为只读 JDBC + Fabric8 list，普通构建不执行。

## 2026-09-12 16:20 实测

- SHA（开始时）：`ad32335`。身份：`system:serviceaccount:manao-stage6-test:manao-6a-local`。namespace=`manao-stage6-test`。4173/18080/6443 已由既有进程提供；runner 未启停服务。
- 运行库 `manao_poc4` 在当日 Flyway V1–V8 后 `app_user` 为空。只 INSERT 了文档账号 alice/bob（BCrypt12），未 DROP/reset。登录 18080 与 4173 均为 200。
- `STAGE6_VERIFY_DB_*` 从 `MANAO_DB_*` 显式复制，schema=`manao_poc4`，已记录为同库只读映射。
- 第一次 runner：PowerShell 把 `--reporter=list,json` 拆开，Playwright 未执行。
- 第二次 invocation `40584abf88eb40779f75d673b596f148`：Playwright 1 failed / 1.3s，`STAGE6_CLEANUP_INCOMPLETE`。项目已 READY、revision 21，workspace Pod/PVC/Service 仍在。
- 显式 resume（`STAGE6_CLEANUP_APPLY=1`）inspect 只读通过；apply 再次 `CLEANUP_REQUEST_FAILED`。直接 `DELETE /api/v1/projects/07f3cfca-...` = 500，库行仍 READY。
- 保护诊断 `083b8efd`：Pod rv=15521700，PVC rv=14891340，与 apply 前一致。历史 `6c6378b2` 工作区未动。
- 本轮代码修正（尚未被 PID 43608 加载）：台账忽略 `manifest.json`/`teardown-report.json`；runner 关闭 PowerShell native stderr 终止；inspect 失败映射 503 且 500 处理器记录异常类名。

## 未闭环

- 运行中后端 DELETE 500 的具体异常（当前处理器不记录栈，需加载新构建后才能看到类名）。
- `STAGE6_GATE=1` cleanup/basic 真实通过与独立 leftover VERIFIED。
- C08 重启续作、压力、故障、Maven 成功与 Run 一致。

本切片 runner 仍不启动或停止 4173/18080。要让上述后端修正生效，需要操作者重启已有 Spring 进程；这不是 C08 业务验收。
