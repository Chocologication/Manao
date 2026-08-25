# EnsoAI Stage 5 Active Job Terminal

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
