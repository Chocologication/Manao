# Stage 6 可靠清理切片：验收记录

日期：2026-09-12
工作树：`.worktree/ensoai-stage-6-real-backend-kubernetes`
分支：`codex/poc4-stage-6-real-backend-kubernetes`

## 结论

2026-09-12 18:39：`ebca913` + JDBC `@Autowired` 后端（PID 45924）上，cleanup 专项 Playwright 1 passed、台账 `API_CLEANED`、独立 leftover 核验 1/0/0/0。18:45 basic 4/5；失败项是 Run 等待未覆盖 `RECOVERING`，随后该 Run 实际 `SUCCEEDED`/`BUILD_SUCCEEDED`/exitCode=0。DELETE 在 Run 仍活跃时为 409 `RUN_ALREADY_ACTIVE`；resume 后残留核验通过。诊断 `083b8efd` rv 未变。C08、压力、故障未跑。

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

## 2026-09-12 18:39 Autowired 后端后的 cleanup 专项

- SHA：`ebca913`。后端 PID 45924（18:17:24 启动，加载 JDBC `@Autowired`）。身份：`system:serviceaccount:manao-stage6-test:manao-6a-local`。4173/18080 由既有进程提供；runner 未启停服务。
- 先前 `07f3cfca` 已台账续作到 `API_CLEANED`。本次新 invocation `f95393c1bdcb44bca11995ae9ffb842f`：Playwright 1 passed / 0 failed / 0 skipped（约 20.4s），台账 `a73a42f4-...` = `API_CLEANED`，独立 verifier 1/0/0/0。
- Node 24.12.0 在测试通过后仍以 `UV_HANDLE_CLOSING` / `0xC0000409` 崩溃。runner 现以 Playwright JSON `stats`（expected>0 且 unexpected=0）作为 e2e 判定，并单独记录 `e2eProcessExit`。本轮 `run-summary.json`：`e2eExit=0`、`verifyExit=0`、`status=PENDING_HUMAN_REVIEW`、runner 进程退出码 0。
- 库 `manao_poc4.project` 空；alice 项目列表 0；集群无 `a73a42f4` 资源。诊断 `083b8efd` Pod/PVC rv 仍为 15521700 / 14891340。历史 `6c6378b2` 未动。
- 证据目录：`poc4/frontend/playwright-report/stage6-cleanup-f95393c1bdcb44bca11995ae9ffb842f/`。

## 2026-09-12 18:45 basic 五项

- 同一 SHA/身份/后端。invocation `31a7ea1ef4ed44889f474f88becc313a`。4 passed / 1 failed / teardown `STAGE6_CLEANUP_INCOMPLETE`。
- 失败项是 Run：等待循环只覆盖 `STARTING`/`RUNNING`，3.3 分钟时观测到 `RECOVERING`。随后 Job Complete、API Run=`SUCCEEDED`、`terminationReason=BUILD_SUCCEEDED`、`exitCode=0`、`finishedAt=2026-09-12T10:45:32Z`。这不是清理 API 失败；不能把五项凑绿当成 6A PASS。
- 失败当时 DELETE=`409 RUN_ALREADY_ACTIVE`（协议正确），台账 `bd9c7b14-...` = `UNRESOLVED`。Run 进入 SUCCEEDED 后显式 resume apply 将同一条目标为 `API_CLEANED`；独立 verifier 1/0/0/0；GET 404；集群无该项目资源。诊断 rv 未变。
- 证据目录：`poc4/frontend/playwright-report/stage6-basic-31a7ea1ef4ed44889f474f88becc313a/`。

当前状态：`CLEANUP_IMPLEMENTED_REAL_ACCEPTANCE_PENDING`

这不是 6A PASS，也不能开始 6B。C08、压力、故障套件仍为 `NOT_RUN_IN_THIS_SLICE`。

## 未闭环

- C08 后端重启后续作（需单独授权目标 PID 与启动方式）。
- 压力 / 三类故障套件。
- Run 等待需覆盖 `RECOVERING`，并核验 Maven 成功与 Run/Job 一致；不得把任意终态或本次 4/5 当作 6A PASS。
