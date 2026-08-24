# EnsoAI Stage 4 Run And Logs

阶段 4 是纯浏览器前端：在阶段 3 可写工作台之上，提供服务器权威的 Run 与日志闭环（固定 `mvn clean test`、停止、活动 Run 恢复、运行期编辑锁、终态后强制重载工作区、最近运行列表、同源 WebSocket replay/live、5 MiB 截断窗口）。不连接真实 Spring Boot、MySQL、Kubernetes Job、PVC、Pod 或集群。MSW 只在 mock 模式与自动化测试中启用。本目录一律使用 pnpm，禁止 npm。

工作目录：`poc4/frontend`。需要 Node.js >= 20 与 pnpm 10。`pnpm test:e2e:channels` 还需要本机已安装 Chrome 与 Edge。

所有 Run 授权、ticket、日志持久化、5 MiB 淘汰、刷新恢复目前只是 **mock contract verified**，在真实后端存在之前不能写成已验证。刷新/重进工作台通过 `ensoai.mock.run-scenario.v1` 再水合，证明的是 **浏览器恢复合同**，不是 MySQL 或后端重启。

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

`pnpm test:e2e*` 会先执行 `pnpm build:mock` 并覆盖 `dist/`。扫描生产排除项之前必须再跑一次 `pnpm build`。

## 合成 mock 凭据

仅用于 `pnpm dev:mock` 与自动化测试，**不是真实后端凭据**，也不是生产账号：

| 用户名 | 密码 |
|---|---|
| `alice` | `demo-pass` |
| `bob` | `demo-pass` |

强制 401 使用 mock-only `POST /api/v1/session/expire`。真实约 20 MiB 正文使用 mock-only `POST /api/v1/session/large-files`。写失败场景使用 mock-only `POST /api/v1/session/write-scenario`（`normal` / `delayed` / `locked` / `conflict` / `failure`）。Run 场景使用 mock-only `POST /api/v1/session/run-scenario`（`success` / `failure` / `timeout` / `recovery` / `delayed-start` / `gap` / `disconnect` / `large-log` / `reload-change`）。这些路径都不得进入生产 `dist`。

## mock-only Run / 日志合同

进入 `READY` 项目后，先查询权威 active Run，再决定工作台是否可编辑。Start 只发送 `{ expectedWorkspaceRevision }`，HTTP `202`，不接受浏览器提供的命令、镜像或资源配置。每项目一个活动 Run；重复启动返回 `409 RUN_ALREADY_ACTIVE` 后必须重新获取权威 active state。

Stop 只针对当前 owned active Run，确认对话框默认焦点在 Cancel；请求幂等，`STOPPING` / 网络不确定期间保持锁定。WebSocket 断开、ticket 失败或日志 complete 都不能解锁。只有权威 active query 到达终态并且 workspace reload 成功后才解锁编辑。

日志 ticket 通过 Bearer HTTP 获取（约 30 秒、单次使用、绑定用户/project/run）。同源 WebSocket 路径为 `/api/v1/ws/run-logs?ticket=`。**主 JWT 不得进入 WebSocket URL、frame、DOM 或截图。** replay 后再 live；`seq` 重复被忽略，缺口会换新 ticket 并从 last applied seq 重放。

每个 Run 只保留最近 5 MiB UTF-8 窗口。服务端淘汰后下发 `truncated` 与 `evictedBytes`；客户端不得伪造淘汰事实。`large-log` 场景会推送真实 `>= 5 MiB + 1 MiB` 字节（每块 `<= 64 KiB`），中途断开后仍继续追加，重连 replay 补齐，然后完成。

终态后强制清理文件 cache/models/buffers，并重新读取树和原打开文件；成功前不解锁。`reload-change` 会在终态前改写 `README.md`、新增 `docs/run-output.md`、删除 `AppTest.java`。File 与 Run 面板一直挂载；Terminal tab 继续 disabled，本阶段不接入 xterm / PTY。

## 阶段 4 边界

包含：权威 active Run、Start/Stop、运行期 File 锁、终态强制 reload、最近 Run 分页、ticket 安全 WebSocket、5 MiB 截断、断线补拉、Chromium/Chrome/Edge E2E 与真实超 5 MiB 日志压力。

不包含：真实 Job / MySQL / Kubernetes / 后端重启恢复 / Terminal。真实 `mvn clean test`、30 分钟超时、CPU/内存限制、Pod 日志、跨用户授权与七天定时删除都属于后续阶段。阶段 0 xterm 只作为 mock 构建里的独立 `/stage0.html` Spike 存在。

跨用户 403、revision 冲突、锁定和大日志窗口只验证前端契约与 mock handler（**mock contract verified**），不能写成真实 Kubernetes 单 Job 锁、MySQL 先持久化后推送或后端重启恢复已通过。

## 已知体积问题

生产入口约 375 kB（gzip 约 119 kB），不含 Monaco。可写工作台 chunk 约 3.9 MB（gzip 约 1.0 MB），另加五个 Monaco Worker（其中 `ts.worker` 约 7.0 MB）。Vite 会提示 `>500 kB`；不要用提高 `chunkSizeWarningLimit` 来掩盖。mock / 阶段 0 Spike 仍含独立 Monaco 包。
