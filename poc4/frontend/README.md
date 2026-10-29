# EnsoAI Stage 5 Active Job Terminal

## Pi 阶段四接管验证（2026-10-27）

`Pause & take over` 先持久化关闭意图，权威核对完成并重读文件/Run事实后才交还编辑权；`Continue task` 在同conversation创建新Task，使用新预算和当前已保存revision。dirty内容保留，Task/Run权威未知闭锁，原End task继续可用。下文旧阶段说明保留历史范围，本地结果和随后已授权发布的真实云端结果见[阶段四验收](../docs/evidence/ai-stage4/acceptance.md)第7节：PI_STAGE4_CONTROL_RECOVERY_PASS；默认空Continue提示词云端路径仍未单独验证。

```powershell
pnpm test:e2e:ai-stage4
pnpm test:e2e:ai-terminal-settlement
```

先从仓库根目录运行 `mvn -f poc4/backend/pom.xml test-compile dependency:build-classpath '-Dmdep.outputFile=target/terminal-local-classpath.txt'`；显式传入本机 `MANAO_TERMINAL_TEST_DB_USERNAME/PASSWORD`，账号需有独立 `manao_stage6_*` schema的创建/删除权限。可选 `MANAO_AI_LOCAL_EVIDENCE_DIR` 隔离输出；两个套件按顺序运行，端口占用立即失败。夹具采用真实HTTP/MySQL/Pi1.2.0 SDK与scripted provider，资源mock，不调用付费模型或集群，不证明完整Workbench云验收。

阶段 5 仍是纯浏览器前端：在阶段 4 Run / 日志闭环上增加只绑定当前 owned `RUNNING` Run 的 xterm 会话、同源 ticket WebSocket、显式关闭、输出流控、本地搜索与结构化命令审计。不连接真实 Spring Boot、MySQL、Kubernetes Job、PVC、Pod、exec API 或集群。MSW 只在 mock 模式与自动化测试中启用。本目录一律使用 pnpm，禁止 npm。

工作目录：`poc4/frontend`。需要 Node.js >= 20 与 pnpm 10。`pnpm test:e2e:channels` 还需要本机已安装 Chrome 与 Edge。

所有 Run/Terminal 授权、ticket、流控、审计、日志持久化、5 MiB 淘汰与刷新恢复目前只是 **mock contract verified**，在真实后端存在之前不能写成已验证。刷新/重进工作台通过 mock `sessionStorage` 再水合，证明的是浏览器恢复合同，不是 MySQL 或后端重启。

## 工作命令

| 命令 | 作用 |
|---|---|
| `pnpm dev:mock` | Vite mock 模式，端口 4173，启用 MSW 与阶段 0 `/stage0.html` |
| `pnpm typecheck` | `tsc -b --pretty false` |
| `pnpm test` | Vitest 单测 |
| `pnpm test:boundary` | 浏览器边界检查（禁止 Electron / Node PTY / 本机绝对路径 / 阶段 0 泄漏） |
| `pnpm build` | 生产构建。不含 MSW worker、mock 密码、mock expire / large-files / write-scenario / run-scenario 路径、`127.0.0.1:4174`、`stage0.html`。项目路由懒加载工作台与五个 Monaco Worker |
| `pnpm build:mock` | mock 生产构建（含 `stage0.html` 与 MSW worker，供 E2E / 本地演示） |
| `pnpm test:e2e` | Playwright Chromium（忽略真实字节大文件、大写入与大日志用例） |
| `pnpm test:e2e:channels` | Playwright 本机 Chrome 与 Edge |
| `pnpm test:e2e:large-files` | 仅 `chromium-large-files`：真实约 20 MiB 正文（需先 `POST /api/v1/session/large-files`，该路径只存在于 mock） |
| `pnpm test:e2e:large-writes` | 仅 `chromium-large-writes`：真实 `20 MiB + 1` Markdown 写入（180 秒上限；需 mock-only `large-files`） |
| `pnpm test:e2e:large-logs` | 仅 `chromium-large-logs`：真实 `5 MiB + 1 MiB` UTF-8 日志流（180 秒上限；需 mock-only `run-scenario` 的 `large-log`） |
| `pnpm test:e2e:terminal-stress` | 仅 `chromium-terminal-stress`：真实 `>= 8 MiB` 二进制 PTY 输出、`<= 32 KiB` 帧、256 KiB credit、输入 burst、100+ resize 与唯一 marker（180 秒上限） |

`pnpm test:e2e*` 会先执行 `pnpm build:mock` 并覆盖 `dist/`。扫描生产排除项之前必须再跑一次 `pnpm build`。

文档与验收入口见[POC4 文档导航](../docs/README.md)。早期阶段0–6设计、计划和既有证据已归档至[历史资料](../../docs/old_docs/poc4/)；`spike.spec.ts`、`stage1.spec.ts` 至 `stage5.spec.ts` 的新截图使用 `testInfo.outputPath(...)`，写入每次测试独立的 `test-results/` 子目录，不覆盖历史验收附件。

## 合成 mock 凭据

仅用于 `pnpm dev:mock` 与自动化测试，**不是真实后端凭据**，也不是生产账号：

| 用户名 | 密码 |
|---|---|
| `alice` | `demo-pass` |
| `bob` | `demo-pass` |

强制 401 使用 mock-only `POST /api/v1/session/expire`。真实约 20 MiB 正文使用 mock-only `POST /api/v1/session/large-files`。写失败场景使用 mock-only `POST /api/v1/session/write-scenario`。Run 场景使用 mock-only `POST /api/v1/session/run-scenario`。Terminal 场景使用 mock-only `POST /api/v1/session/terminal-scenario`（`normal` / `ticket-expired` / `already-active` / `server-pause` / `disconnect` / `shell-exit` / `webgl-fallback` / `audit` / `stress`）。这些路径都不得进入生产 `dist`。

## mock-only Run / 日志合同

进入 `READY` 项目后，先查询权威 active Run，再决定工作台是否可编辑。Start 只发送 `{ expectedWorkspaceRevision }`，HTTP `202`，不接受浏览器提供的命令、镜像或资源配置。每项目一个活动 Run；重复启动返回 `409 RUN_ALREADY_ACTIVE` 后必须重新获取权威 active state。

Stop 只针对当前 owned active Run，确认对话框默认焦点在 Cancel；请求幂等，`STOPPING` / 网络不确定期间保持锁定。WebSocket 断开、ticket 失败或日志 complete 都不能解锁。只有权威 active query 到达终态并且 workspace reload 成功后才解锁编辑。

日志 ticket 通过 Bearer HTTP 获取（约 30 秒、单次使用、绑定用户/project/run）。同源 WebSocket 路径为 `/api/v1/ws/run-logs?ticket=`。**主 JWT 不得进入 WebSocket URL、frame、DOM 或截图。** replay 后再 live；`seq` 重复被忽略，缺口会换新 ticket 并从 last applied seq 重放。

每个 Run 只保留最近 5 MiB UTF-8 窗口。服务端淘汰后下发 `truncated` 与 `evictedBytes`；客户端不得伪造淘汰事实。`large-log` 场景会推送真实 `>= 5 MiB + 1 MiB` 字节（每块 `<= 64 KiB`），中途断开后仍继续追加，重连 replay 补齐，然后完成。

终态后强制清理文件 cache/models/buffers，并重新读取树和原打开文件；成功前不解锁。File、Run、Terminal 面板保持挂载，非活动面板使用 `inert`，Terminal 会话切换面板时保留但项目切换、logout、当前 401、Run 离开 `RUNNING` 时必须关闭。

## mock-only Terminal 合同

Open 只对当前 owned `RUNNING` Run 可用。浏览器先按可见 xterm 尺寸 POST 严格 `{ cols, rows }`，不能提交 command、image、Pod、容器或资源策略。返回 ticket 约 30 秒、单次使用并绑定 user/project/run/session；WebSocket 只能使用当前页面同源 `/api/v1/ws/terminals?ticket=`，主 JWT 不得进入 URL、frame、DOM 或截图。`terminal.ready.sessionId` 必须与 HTTP reservation 一致。

异常断线、ticket 失败与 shell exit 都 **不自动重连**；用户只有再次 Open 才能取得全新的 session/ticket。Close 发送一次 `terminal.close`，不可恢复该会话，Maven Run 独立继续。Run 进入 `STOPPING` / `RECOVERING` 或终态时先禁用输入并关闭 PTY，再执行工作区 reload。

服务端输出只用 `<= 32 KiB` 二进制帧；客户端初始 credit 为 256 KiB，xterm 完成解析后才按帧 ACK 并返还等量 credit。客户端输入按 `<= 16 KiB` 分帧，响应服务端 pause/resume，并在浏览器 `bufferedAmount` 高水位暂停、低水位以下恢复。Clear 与 Search 只操作本地 xterm，不产生审计或网络命令。

Audit 只渲染后端返回的结构化 command/state/time/exitCode，50 条一页并使用 opaque cursor。前端不得从逐键输入、PTY output 或 Run log 推断命令。PTY marker、Audit command 与 Run log marker 必须彼此隔离。

## 阶段 5 / Stage 6 边界

Stage 5 包含：浏览器内 active Run authority、单次 ticket、同源 Terminal WebSocket、显式 no-reconnect 生命周期、xterm WebGL/DOM fallback、输出 credit/ACK、输入背压、本地 Search/Clear、结构化 Audit、Chromium/Chrome/Edge E2E、12 张 branded-browser 截图与真实 8 MiB 压力。以上均只表示 **mock contract verified**。

Stage 6 仍需在真实系统验证：Spring Boot terminal session/ticket API、Kubernetes `pods/exec`/PTY 与 resize、单 exec 创建/销毁、Job/run authority 竞态、MySQL audit 的事务与七天清理、真实跨用户 401/403、断网与后端重启、Pod/节点故障、流控超时、代理层 WebSocket 限制及真实 8 MiB 跨网络压力。不能把本阶段 mock 写成 Kubernetes、MySQL 或生产安全边界已通过。

## 已知体积问题

生产入口约 375 kB（gzip 约 119 kB），不含 Monaco。可写工作台 chunk 约 3.9 MB（gzip 约 1.0 MB），另加五个 Monaco Worker（其中 `ts.worker` 约 7.0 MB）。Vite 会提示 `>500 kB`；不要用提高 `chunkSizeWarningLimit` 来掩盖。mock / 阶段 0 Spike 仍含独立 Monaco 包。


## Stage 6A: 本机后端联调（local-cluster）

前端始终通过 Vite 代理访问本机后端，所有 API 与 WebSocket 都是同源路径（`/api/v1/...`），
后端地址不会进入浏览器 bundle：

1. 启动本机 MySQL 与 SSH API 隧道（操作者管理，见 `backend/config/local-cluster.example.env`）。
2. 复制 `.env.local-cluster.example` 为 `.env.local`（MSW 关闭）。
3. 启动后端：`backend/scripts/start-local-cluster.ps1 -EnvFile <env>`（端口 `127.0.0.1:18080`）。
4. 启动前端：`pnpm dev`（端口 4173，代理已配置在 `vite.config.ts`）。

Vite 代理同时转发 HTTP 与 WebSocket（`ws: true`），浏览器永远看不到集群地址、
Service 名、PVC/Pod 名或绝对路径。项目 workspace bridge 由后端按项目动态管理
（loopback 18100-18199），浏览器不能提交 Service 名或端口。

## Stage 6A 决策门 E2E

`pnpm test:e2e:stage6`（需 `STAGE6_GATE=1` 环境变量以跳过 mock webServer）在门执行时运行：
后端（18080）与本机 Vite dev server（4173）必须已启动且 MSW 关闭。所有用例在后端不可达时
自动 skip，不产生伪证据。集群前置条件状态见 `docs/evidence/stage-6/6a-gate.md`。

## Stage 6B: 云端工作台（已验收，2026-09-18/19）

Stage 6B 将本目录的静态生产构建 + nginx 同源代理（`/api/` REST 与 WebSocket）部署到云集群
namespace `manao-stage6b`，公网入口 `http://1.12.245.235:30080`（NodePort，HTTP 明文限制单独记录）。
2026-09-19 集中验收：`pnpm test:e2e:stage6b`（凭据经私有 env 注入，不本机起服务）6/6 通过——
创建、编辑保存、真实失败反馈、修复运行成功、刷新/重登持久化，最后经 UI 手动删除并全链路回收；
后端维护重启与 MySQL 重建后数据保留且可再次运行。两项条件测试（workspace Pod 主动删除、删除故障注入）
因触发条件未满足记录为 SKIPPED。

6B 只有两份正文文档（本节仅作入口，不复制其内容）：

- 验收记录（唯一阶段验收正文）：`../docs/evidence/stage-6b/acceptance.md`
- 部署与维护手册：`../deploy/6b/README.md`

## Manao Cloud IDE 界面体验

前端工作台保持 Stage 5 浏览器边界与现有 API 合同，并补充以下交互：

- 登录、项目列表、项目概览和工作台采用统一的 Manao 深色实验室视觉；登录页动效支持减少动态效果偏好。
- 项目列表支持搜索、状态筛选、排序、收藏、最近访问，以及网格/列表视图；偏好保存在当前浏览器本地。
- 项目概览与工作台可查看真实 Run 历史、日志证据和两次运行对比；错误日志可搜索并跳转到对应源码位置。
- 工作台支持 `Ctrl/Cmd+K` 命令面板、Activity Center、主题与编辑器偏好，以及窄屏抽屉布局。
- Activity Center 的已读状态和清空操作只影响本地通知；Run Insights 使用已有运行与日志数据，不补造后端事件。
- AI 诊断展示为预览且未连接；不会执行 AI 分析或自动修复。

### 云端验收脚本的本地回归

Java、Python 和 Stage 6B 的云端 lifecycle 脚本共用 `tests/support/cloudWorkbench.ts`：先通过带 `aria-expanded` 的控制台按钮展开创建区，再进入“所有配置”。该操作可重复调用，空项目列表中的同名快捷按钮不会造成定位歧义。Java/Python 首项入口检查也通过该操作读取模板。

Python 依赖恢复的出现、刷新后仍可核对和核对后消失断言共用实际中文告警定位，避免旧英文零匹配让 `toBeHidden()` 提前通过。原云端脚本保留整页刷新、单次 ADD 和依赖声明核验。

本地浏览器回归使用现有 MSW，覆盖折叠表单的完整模板、空列表创建、重复打开表单，以及丢失依赖响应后离开并重进工作台，通过原 operationId 核对且不重发 ADD：

```powershell
pnpm exec playwright test tests/e2e/cloud-workbench-ui.spec.ts --project=chromium
```

该命令自动构建并启动本地 mock 服务。MSW 的项目和依赖回执保存在页面内存中，因此本地用例通过 SPA 导航重进工作台；真实整页刷新、后端持久化和集群资源生命周期仍须在云端部署后运行对应 lifecycle 套件验证。

### AI 集成分支同步（2026-10-20）

将 `master@4c9fb89`（PR #2，包含 Cloud IDE 界面和 lifecycle 测试修复）合入 `codex/ai-integration`，保留该分支原有 AI 提交历史；master 不接收 AI 分支的改动。

两个内容冲突按功能组合解决：`RunPanel` 同时保留 Agent 占用锁、AI 指定 Run 选择和错误日志定位；`WorkbenchShell` 同时保留 AI 会话入口、任务收尾与工作区重载流程，以及新版布局、面板偏好和源码定位。依赖锁文件保留两侧新增依赖。Run Insights 的 AI 诊断预览与已有 AI 会话入口是独立功能。

本地验证：`pnpm install --frozen-lockfile`、`pnpm build`、`pnpm typecheck:stage6` 和 `pnpm test:boundary` 通过（边界单测 36/36）；`pnpm exec vitest run --maxWorkers=4 --reporter=dot` 全套 94 文件、1598/1598 通过；上述 Cloud IDE 本地 Playwright 回归 3/3 通过。首次默认并发单测出现一项首次懒加载等待超时，该文件单独复跑 5/5 通过，限制四个 worker 后全套通过，未通过修改业务代码或放宽断言消除失败。

本次同步只验证合并后的本地前端，不代表 AI 集成阶段完成，也不改变已有阶段验收结论；未执行云端部署或真实模型验收。

### AI 界面本地交付（2026-10-20）

本轮在 `codex/ai-integration` 完成 AI 展示改造，产品源码基线为 `efd0a52`。Tasks 1–4 的独立任务审核均通过，整体变更 `94c8047..fc2c307` 独立审查 Approved，Critical / Important / Minor 均为 0；本次仅文档状态收尾。保留现有任务、会话、流式、Markdown、上下文、写锁和 Run 合同；AI 页右栏显示项目会话历史，切回其他页恢复原 Run Insights。Task 4 仅增加 mock-only 展示夹具、浏览器测试与证据，没有新增 Agent 服务或模型状态机。

复现命令按以下顺序执行，浏览器 mock build 之后必须重新生产构建：

```powershell
pnpm exec vitest run src/features/ai src/components/shell/WorkbenchShell.test.tsx --maxWorkers=4
pnpm typecheck:stage6
pnpm exec playwright test --config playwright.ai-ui.config.ts
pnpm build
pnpm test:boundary
git diff --check
```

2026-10-20 实际结果：定向 Vitest 12 文件、259/259（71.79s），`typecheck:stage6` 通过，最终 Chromium 10/10（1.7m，7 项 AI UI + 3 项既有 cloud-workbench-ui 本地回归）。`pnpm build` exit 0（Vite 53.66s），`pnpm test:boundary` 36/36 且 Browser boundary check passed，`git diff --check` exit 0。最终生产 `dist` 显式扫描 `AI_UI_VISUAL_FIXTURE_ONLY|ui-conversation-reading|ui-task-completed|aiUiFixture|mockServiceWorker|/api/v1/session/` 无匹配。Controller 另跑全前端 Vitest 95 文件、1608/1608（145.37s）。新配置和 visual spec 不在 stage6 include 内，另执行 `pnpm exec tsc --noEmit --target ES2022 --lib 'ES2022,DOM,DOM.Iterable' --module ESNext --moduleResolution bundler --skipLibCheck --strict --types node playwright.ai-ui.config.ts tests/visual/ai-ui.spec.ts tests/e2e/cloud-workbench-ui.spec.ts`，exit 0。

专用配置仅启用 Chromium/单 worker，并通过 `VITE_ENABLE_AI=true` 与 `VITE_AI_UI_FIXTURE=true` 的 mock build 提供固定内容。原 4173 已有 Vite，未终止该进程；配置改用独立 `127.0.0.1:4183`，保留 `reuseExistingServer:false`。夹具只匹配 `prj-alice-notebook` 和 `usr-alice` 认证；其他项目沿用原默认 handler。两个会话分两页，新建只写空会话集合，任务提交、压缩和真实执行不由夹具模拟。

浏览器覆盖 1440×900 三主题、1024×768、1023×768 和 390×844：原生 slider 的 Home/ArrowRight/End、四档数值与中文值、刻度点击和鼠标拖动、胶囊端点边界、Escape/外侧关闭及焦点返回；AI 隐藏关闭弹层、草稿/选中会话保留；抽屉 Tab/Shift+Tab/Escape、单消息纵向滚动祖先、上翻保持、composer 保持可见及手动增高；代码/表格局部横向滚动；会话分页/空会话新建不 POST task；已有 View run 回到原 Run 与洞察；上下文环、压缩入口、思考、Markdown 和工具结果可见。禁用/准入未知、任务收尾/压缩语义由已有定向单测覆盖。

最终代表截图保留在 [AI UI screenshots](../docs/evidence/ai-ui/screenshots/)：`lab-1440x900.png`、`graphite-1440x900.png`、`light-1440x900.png`、`lab-1024x768.png`、`lab-1023-history.png`、`lab-1023-slider-input.png`、`lab-390-history.png`、`lab-390-slider-input.png`。Controller 已人工核对宽屏三主题和 390 抽屉/滑块图：用户气泡、助手阅读正文、思考、输入框和历史栏可辨，未见明显裁切或页面横向溢出。

首轮浏览器 8 passed / 2 failed：向上弹层覆盖 textarea 中心导致外侧点击目标不成立；全局 Run ID `.first()` 命中隐藏 AI 页的代码节点。修正测试为实际外侧 heading 和 Run tabpanel scope 后第二轮 10/10，最终顺序复跑仍 10/10；未改产品代码掩盖失败。必要错误上下文保留在 [diagnostics](../docs/evidence/ai-ui/diagnostics/)。现有大 chunk、NO_COLOR/FORCE_COLOR 和 jsdom HTMLMediaElement play/pause 提示仍保留。

本地 fixture 不证明真实 DeepSeek、流式时序、云端发布或工程阶段验收。两个会话不足触发长会话列表滚动，浏览器未覆盖该极端场景；没有模拟活跃任务或压缩执行来声称成功。阶段三仍为用户确认使命完成；阶段二 `PAUSED / NOT_GRANTED`，阶段四未开始。本轮没有真实模型请求、镜像发布、集群/数据库操作或 Git push/merge。

### AI 界面实际前端发布（2026-10-20）

以上是本地实施阶段历史；用户随后明确授权集群发布。源码 `b3a1b8ef28f883b577280c2bf06589edeb54f6bd` 的标准 frontend 镜像已构建、push 并按 OCI index `sha256:a45d8c0ad6abf7e138b31a3ac43e79937fc33cddac109e943ea15e2789b5fca2` 部署到 `kubernetes-admin@learn` / `manao-stage6b`，generation/observed 22、Ready1/1、restart0。镜像构建使用 `VITE_ENABLE_AI=true`、frozen lockfile、revision label 和 USER101；typecheck/Vite build exit0，仅有已知 chunk 大小警告。有效镜像扫描覆盖 HTML、assets 和 sourcemap，无 fixture/session/mock 标记，`mockServiceWorker.js` 不存在；最初 BusyBox 不支持 `grep --include` 的扫描无效，已丢弃并改用 `grep -r -l -E` 重查（status1，无匹配）。

公网 `http://1.12.245.235:30080/` 与新 JS/CSS 均 HTTP200。真实登录后读取原 READY 项目的 10 个既有会话，选中会话 head26/history12、上下文 2,633/1,048,576（0.251102%）；四档滑块只作本地切换，侧栏显隐保留选择，切到 File 恢复 Run Insights，回到 AI 恢复会话侧栏，打开一个既有工具结果。page errors/API5xx/意外 mutation 均0，无 mock SW 或横向溢出。浏览器除登录外阻止非 GET，请求未提交任务、压缩或模型调用；未保留原始用户内容、凭据、截图或 trace。

本次同时发布 `94c8047` 已合入、相对于此前线上 `1f41cf5` 的 Cloud IDE 视觉变化（登录、项目、主题、工作台、日志 UI）及 AI 样式；未改 API/合同、backend/worker、数据库或用户项目资源；仅更新 frontend Deployment。详细 digest、前后 Pod 身份、可复制回滚命令与证据在[发布指南 §5.3](../deploy/ai-context/README.md#53-thinkrail-界面实际前端发布2026-10-20)。这次只读回放不建立新的模型/工程阶段 PASS；阶段二仍 `PAUSED / NOT_GRANTED`，阶段三使命已由用户确认完成，阶段四未开始；未 Git push/merge 或资源清理。

### AI 界面文案与洞察收敛（2026-10-21）

按用户对已发布页面的标注，登录页将导航状态改为 `Agent已就绪`，运行能力项改为 `AI / READY · AI 诊断 · 已就绪`，主说明改为“人工智能为你保驾护航”，并将输入 placeholder 改为“用户名”和“请输入密码”。mock-only 演示账号提示及测试登录值仍保留，未改变认证行为。非 AI 页面右侧 Run Insights 移除“AI 诊断 · 预览 · 未接入”占位卡，运行、日志、服务访问和项目洞察入口继续保留。

本轮 `pnpm exec vitest run src/features/auth/LoginPage.test.tsx src/components/runs/RunEvidence.test.tsx src/components/shell/WorkbenchShell.test.tsx --maxWorkers=4` 为 3 files / 98 tests passed，`pnpm typecheck:stage6` exit0，`pnpm exec playwright test --config playwright.ai-ui.config.ts` 10/10 passed（1.8m）。另以 stdin Playwright annotation smoke 直接核对六处标注，lab1707×927、graphite/light1440×900、lab390×844 共4/4通过：登录文案和空 placeholder、洞察占位卡移除、AI 草稿跨 File 切换保留。窄屏沿用原 CSS 隐藏顶部导航和能力条，仅核对其 DOM 文案；未改可见性规则。截图与 JSON 记录保存在 `../docs/evidence/ai-ui/copy-20261021/`，本轮专项截图使用 `*-login.png` 和 `*-workbench.png`；旧 screenshots 目录保留原历史证据。

Playwright mock build 覆盖本地 dist 后，第一次 `pnpm test:boundary` 的36项单测通过而产物扫描失败（检出 mock 标记）；按要求重新生产 `pnpm build` exit0（Vite58.23s，仅有既有 chunk size warnings），再次 `pnpm test:boundary` 36/36且 Browser boundary check passed，`git diff --check` exit0。初次 RunEvidence 测试1项失败为旧断言仍期待已移除的占位卡，改为断言不存在后98/98；自定义 smoke 的早期失败来自无条件切换洞察、使用 mock 标题匹配真实会话、窄屏隐藏元素可见性断言及未剥除 env 外层引号，均仅修正验证脚本，未改产品代码来掩盖失败。全量 Vitest 和真实模型套件本轮未执行；以上本地 fixture 不建立模型或工程阶段验收结论。

用户随后授权更新集群。源码提交 `9e0c831ebda0762b10ef21a2b6721a2bbb692366` 的 frontend 镜像已 BUILT / PUSHED / DEPLOYED：tag `chocologic/manao_images_repository:ai-copy-frontend-9e0c831`，OCI index `sha256:297a81e47cc421223b552562acee5d99920aeda20bc5b5190dadbd1991059698`，linux/amd64 child `sha256:d45066a454f728fa781a3a203329f2319f55e02c2c9b45aebb1c09e5e52d9a54`，USER101。实际镜像扫描无 fixture/MSW 标记，`mockServiceWorker.js` 不存在。

发布目标为 `kubernetes-admin@learn` / `manao-stage6b`，frontend generation/observed 23、Ready1/1、restart0、Pod UID `50513a22-0b12-4c13-9c79-ce2adb5b84d7`；backend generation39、Pod UID `a5851be2-d432-4cbc-8c4d-3e5fb1d653f9`、restart8、digest `726c095f15d4866fbcea48146c90faf2fb1a6d680f02629f6ea893e49f694af1`；worker generation29、Pod UID `216e83c1-63b8-4ec2-a709-20ed58b15ea9`、restart3、digest `dd06e4148d466127914ebf0bc04e27b5f078d4061f4485f1c0b4221831e269f8`，backend/worker 未滚动。公网 `/login` HTTP200；最终真实只读回放登录文案 PASS、Run Insights AI 占位卡 ABSENT、AI 入口及切回 File 恢复洞察 PASS，page errors/API5xx/意外写请求均0。此前脚本误用 mock 会话标题，不能据此判定真实账号缺少会话；最终检查使用实际入口和任务输入区，不读取或保存原始会话内容，不提交任务或压缩。记录见 `../docs/evidence/ai-ui/copy-20261021/public-smoke-safe.json`；回滚目标为上一 frontend index `sha256:a45d8c0ad6abf7e138b31a3ac43e79937fc33cddac109e943ea15e2789b5fca2`。阶段二仍 PAUSED / NOT_GRANTED，阶段三使命由用户确认完成，阶段四未开始；未执行 Git push/merge、数据库迁移或用户资源清理。
