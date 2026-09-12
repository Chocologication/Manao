# Stage 6 可靠清理切片：验收记录

日期：2026-09-12
工作树：`.worktree/ensoai-stage-6-real-backend-kubernetes`
分支：`codex/poc4-stage-6-real-backend-kubernetes`

## 结论

离线实现仍在 RC-8。2026-09-12 17:18：后端已重启（PID 44892），DELETE 从 500 变为 `503 PROJECT_CLEANUP_INCOMPLETE`，但 general_log 证明 DELETE 未发出任何 SQL。原因是 `ProjectDeletionRepository` 的无参构造被 Spring 选用，`inspect` 在连库前 NPE。项目 `07f3cfca-...` 仍 READY；诊断 `083b8efd` 未改。C08、压力、故障未跑。

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

## 2026-09-12 17:18 重启后

- 新进程 PID 44892，启动 17:11:27，加载 `1982ed2` 的 503 映射。登录仍 200。
- `DELETE /api/v1/projects/07f3cfca-...` = 503，库行仍 READY。mysql.general_log（TABLE，用后已关）只有 login 的 `SELECT app_user`，没有 `FOR UPDATE` / `DELETING`。
- 已给 JDBC 构造函数加 `@Autowired`，无参实例的 inspect/begin 改为明确 `not connected`。需再次重启后端才能注入 JDBC 仓库。
- 诊断 `083b8efd` Pod/PVC rv 仍为 15521700 / 14891340。

## 未闭环

- 注入修复加载后，对 `07f3cfca` 台账续作并独立 leftover 核验。
- `STAGE6_GATE=1` cleanup/basic 真实通过。
- C08 重启续作、压力、故障、Maven 成功与 Run 一致。

本切片 runner 仍不启动或停止 4173/18080。要让 JDBC 注入修正生效，需要操作者再次重启 Spring 进程；这不是 C08 业务验收。
