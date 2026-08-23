# EnsoAI Stage 3 Writable Workbench

阶段 3 是纯浏览器前端：在阶段 1 的登录与项目生命周期、阶段 2 的只读工作台之上，提供 `READY` 项目的可写工作台（可编辑 Monaco / 大 Markdown 纯文本、显式保存与 `Ctrl+S`、workspace revision、文件与目录 CRUD、dirty 守卫）。不连接真实 Spring Boot、MySQL、PVC、Pod 或 Kubernetes。MSW 只在 mock 模式与自动化测试中启用。本目录一律使用 pnpm，禁止 npm。

工作目录：`poc4/frontend`。需要 Node.js >= 20 与 pnpm 10。`pnpm test:e2e:channels` 还需要本机已安装 Chrome 与 Edge。

所有文件授权、路径规范化、symlink escape、项目所有权、revision 冲突与锁定校验目前只是 **mock contract verified**，在真实后端存在之前不能写成已验证。

## 工作命令

| 命令 | 作用 |
|---|---|
| `pnpm dev:mock` | Vite mock 模式，端口 4173，启用 MSW 与阶段 0 `/stage0.html` |
| `pnpm typecheck` | `tsc -b --pretty false` |
| `pnpm test` | Vitest 单测 |
| `pnpm test:boundary` | 浏览器边界检查（禁止 Electron / Node PTY / 本机绝对路径 / 阶段 0 泄漏） |
| `pnpm build` | 生产构建。不含 MSW worker、mock 密码、mock expire / large-files / write-scenario 路径、`127.0.0.1:4174`、`stage0.html`。项目路由懒加载工作台与五个 Monaco Worker |
| `pnpm build:mock` | mock 生产构建（含 `stage0.html` 与 MSW worker，供 E2E / 本地演示） |
| `pnpm test:e2e` | Playwright Chromium（忽略真实字节大文件与大写入用例） |
| `pnpm test:e2e:channels` | Playwright 本机 Chrome 与 Edge |
| `pnpm test:e2e:large-files` | 仅 `chromium-large-files`：真实约 20 MiB 正文（需先 `POST /api/v1/session/large-files`，该路径只存在于 mock） |
| `pnpm test:e2e:large-writes` | 仅 `chromium-large-writes`：真实 `20 MiB + 1` Markdown 写入（180 秒上限；需 mock-only `large-files`） |

`pnpm test:e2e*` 会先执行 `pnpm build:mock` 并覆盖 `dist/`。扫描生产排除项之前必须再跑一次 `pnpm build`。

## 合成 mock 凭据

仅用于 `pnpm dev:mock` 与自动化测试，**不是真实后端凭据**，也不是生产账号：

| 用户名 | 密码 |
|---|---|
| `alice` | `demo-pass` |
| `bob` | `demo-pass` |

强制 401 使用 mock-only `POST /api/v1/session/expire`。真实约 20 MiB 正文使用 mock-only `POST /api/v1/session/large-files`。写失败场景使用 mock-only `POST /api/v1/session/write-scenario`（`normal` / `delayed` / `locked` / `conflict` / `failure`）。这三条路径都不得进入生产 `dist`。

## 可写模式

打开文件始终先请求 metadata。`renderMode` / `blockReason` / `sizeBytes` / 编码由服务端（当前为 MSW）决定，浏览器不得按扩展名自行放宽。

| 模式 | 何时 | 查看器 | 是否请求正文 | 是否可写 |
|---|---|---|---|---|
| `MONACO_TEXT` | 普通文本与 Java 等 `<= 20 MiB`；Markdown `<= 20 MiB` | 可编辑 Monaco；Save 与 `Ctrl+S` / `Cmd+S` | 是 | 是 |
| `PLAIN_TEXT` | Markdown `20 MiB < size <= 50 MiB` | 可编辑 `<textarea>`，不创建 Monaco model | 是 | 是 |
| `BLOCKED` | 二进制、非 UTF-8、Markdown `> 50 MiB`、非 Markdown `> 20 MiB` | 说明 + Download；正文请求数为零；无 Save | 否 | 否 |

路径必须是项目内正斜杠相对路径；根目录只用空字符串。前端 `pathPolicy` 只拒绝明显错误输入，不能替代后端规范化、symlink escape 和所有权校验。越过 UI 的 PUT / CRUD 仍由 mock handler 按 owner、READY、path、类型、大小和 revision 拒绝。

## workspace revision

初次根目录响应给出非空 opaque `workspaceRevision`。每次保存、创建、重命名、删除都携带当前 revision；成功响应推进 revision。客户端只做完全相等比较，不得解析、排序、加一或从时间推断新旧。`409 WORKSPACE_REVISION_CONFLICT` 与 `409 PROJECT_LOCKED` 不得显示为保存成功，且必须保留 dirty 缓冲区。

## dirty 守卫

标签上的 `*` 是文本标记，不只靠颜色。活动文件 dirty 时 Save 可用；保存中继续编辑不得在响应后错误清 dirty。关闭 dirty 标签提供 Save and close / Discard / Cancel；返回项目列表与 logout 提供 Discard and leave / Cancel。取消不改变标签、模型、认证或路由。浏览器 `beforeunload` 仅在存在 dirty 时安装。当前 token `401` 仍按既有安全规则清会话，不弹出可取消的 dirty 对话框。

dirty 文件或其后代目录禁止重命名/删除，须先保存或丢弃。非空目录删除会二次确认，服务端仍可返回 `DIRECTORY_NOT_EMPTY`。

## 阶段 3 边界

包含：`READY` 项目可写工作台、根目录后懒加载目录、隐藏文件可见、多标签可写编辑、metadata 门闩、受认证 Blob 下载、显式保存与 revision、文件/目录创建、同目录重命名、确认删除、logout / 当前会话 401 清空工作台、生产懒加载 Monaco Worker。

不包含：真实 Spring Boot / JWT 签名 / MySQL、真实 PVC / 工作区 Pod / 文件代理、拖拽上传、Git、搜索、跨目录移动、自动保存、Run / 日志 / 真实 PTY、工作台状态持久化。Run 与 Terminal 在生产 Shell 中可见但禁用。`canRequestRun` 恒为 false。Run 的 disabled 原因可区分 dirty 与 Stage 4 未接入，但 **Run 权威与运行锁属于阶段 4**，本阶段不得写成已交付。阶段 0 xterm 只作为 mock 构建里的独立 `/stage0.html` Spike 存在。

跨用户 403、路径拒绝、锁定、冲突和大文件门闩只验证前端契约与 mock handler（**mock contract verified**），不能写成真实 PVC 隔离、symlink 防护、原子写入或下载授权已通过。

## 已知体积问题

生产入口约 375 kB（gzip 约 119 kB），不含 Monaco。可写工作台 chunk 约 3.9 MB（gzip 约 1.0 MB），另加五个 Monaco Worker（其中 `ts.worker` 约 7.0 MB）。Vite 会提示 `>500 kB`；不要用提高 `chunkSizeWarningLimit` 来掩盖。mock / 阶段 0 Spike 仍含独立 Monaco 包。
