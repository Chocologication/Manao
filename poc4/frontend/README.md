# EnsoAI Stage 2 Read-Only Workbench

阶段 2 是纯浏览器前端：在阶段 1 的登录与项目生命周期之上，提供 `READY` 项目的只读工作台（懒加载文件树、多标签只读 Monaco、20/50 MiB 分级、阻断文件与受认证下载）。不连接真实 Spring Boot、MySQL、PVC、Pod 或 Kubernetes。MSW 只在 mock 模式与自动化测试中启用。本目录一律使用 pnpm，禁止 npm。

工作目录：`poc4/frontend`。需要 Node.js >= 20 与 pnpm 10。`pnpm test:e2e:channels` 还需要本机已安装 Chrome 与 Edge。

所有文件授权、路径规范化、symlink escape 与项目所有权校验目前只是 **mock contract verified**，在真实后端存在之前不能写成已验证。

## 工作命令

| 命令 | 作用 |
|---|---|
| `pnpm dev:mock` | Vite mock 模式，端口 4173，启用 MSW 与阶段 0 `/stage0.html` |
| `pnpm typecheck` | `tsc -b --pretty false` |
| `pnpm test` | Vitest 单测 |
| `pnpm test:boundary` | 浏览器边界检查（禁止 Electron / Node PTY / 本机绝对路径 / 阶段 0 泄漏） |
| `pnpm build` | 生产构建。不含 MSW worker、mock 密码、mock expire / large-files 路径、`127.0.0.1:4174`、`stage0.html`。项目路由懒加载工作台与五个 Monaco Worker |
| `pnpm build:mock` | mock 生产构建（含 `stage0.html` 与 MSW worker，供 E2E / 本地演示） |
| `pnpm test:e2e` | Playwright Chromium（忽略真实字节大文件用例） |
| `pnpm test:e2e:channels` | Playwright 本机 Chrome 与 Edge |
| `pnpm test:e2e:large-files` | 仅 `chromium-large-files`：真实约 20 MiB 正文（需先 `POST /api/v1/session/large-files`，该路径只存在于 mock） |

`pnpm test:e2e*` 会先执行 `pnpm build:mock` 并覆盖 `dist/`。扫描生产排除项之前必须再跑一次 `pnpm build`。

## 合成 mock 凭据

仅用于 `pnpm dev:mock` 与自动化测试，**不是真实后端凭据**：

| 用户名 | 密码 |
|---|---|
| `alice` | `demo-pass` |
| `bob` | `demo-pass` |

强制 401 使用 mock-only `POST /api/v1/session/expire`。真实约 20 MiB 正文使用 mock-only `POST /api/v1/session/large-files`。这两条路径都不得进入生产 `dist`。

## 文件显示模式

打开文件始终先请求 metadata。`renderMode` / `blockReason` / `sizeBytes` / 编码由服务端（当前为 MSW）决定，浏览器不得按扩展名自行放宽。

| 模式 | 何时 | 查看器 | 是否请求正文 |
|---|---|---|---|
| `MONACO_TEXT` | 普通文本与 Java 等 `<= 20 MiB`；Markdown `<= 20 MiB` | 只读 Monaco（`readOnly` + `domReadOnly`） | 是 |
| `PLAIN_TEXT` | Markdown `20 MiB < size <= 50 MiB` | 只读 `<textarea>`，不创建 Monaco model | 是 |
| `BLOCKED` | 二进制、非 UTF-8、Markdown `> 50 MiB`、非 Markdown `> 20 MiB` | 说明 + Download；正文请求数为零 | 否 |

路径必须是项目内正斜杠相对路径；根目录只用空字符串。前端 `pathPolicy` 只拒绝明显错误输入，不能替代后端规范化、symlink escape 和所有权校验。

## 阶段 2 边界

包含：`READY` 项目只读工作台、根目录后懒加载目录、隐藏文件可见、多标签只读编辑、metadata 门闩、受认证 Blob 下载、logout / 当前会话 401 清空工作台、生产懒加载 Monaco Worker。

不包含：保存 / dirty / 写入 revision、拖拽上传、Git、搜索、CRUD、Run / 日志 / 真实 PTY、工作台状态持久化。Run 与 Terminal 在生产 Shell 中可见但禁用。阶段 0 xterm 只作为 mock 构建里的独立 `/stage0.html` Spike 存在。

跨用户 403、路径拒绝和大文件门闩只验证前端契约与 mock handler（**mock contract verified**），不能写成真实 PVC 隔离、symlink 防护或下载授权已通过。

## 已知体积问题

生产入口约 375 kB（gzip 约 119 kB），不含 Monaco。只读工作台 chunk 约 3.9 MB（gzip 约 1.0 MB），另加五个 Monaco Worker（其中 `ts.worker` 约 7.0 MB）。Vite 会提示 `>500 kB`；不要用提高 `chunkSizeWarningLimit` 来掩盖。mock / 阶段 0 Spike 仍含独立 Monaco 包。
