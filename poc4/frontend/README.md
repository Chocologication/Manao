# EnsoAI Stage 1 Frontend Foundation

阶段 1 是纯浏览器前端：登录、内存中的短期 JWT、项目列表与创建状态机。不连接真实 Spring Boot、MySQL、PVC、Pod 或 Kubernetes。MSW 只在 mock 模式与自动化测试中启用。本目录一律使用 pnpm，禁止 npm。

工作目录：`poc4/frontend`。需要 Node.js >= 20 与 pnpm 10。`pnpm test:e2e:channels` 还需要本机已安装 Chrome 与 Edge。

## 工作命令

| 命令 | 作用 |
|---|---|
| `pnpm dev:mock` | Vite mock 模式，端口 4173，启用 MSW 与阶段 0 `/stage0.html` |
| `pnpm typecheck` | `tsc -b --pretty false` |
| `pnpm test` | Vitest 单测 |
| `pnpm test:boundary` | 浏览器边界检查（禁止 Electron / Node PTY / 本机绝对路径） |
| `pnpm build` | 生产构建（不含 MSW worker、mock 密码、`127.0.0.1:4174`、`stage0.html`） |
| `pnpm build:mock` | mock 生产构建（含 `stage0.html` 与 MSW worker，供 E2E） |
| `pnpm test:e2e` | Playwright Chromium |
| `pnpm test:e2e:channels` | Playwright 本机 Chrome 与 Edge |

## 合成 mock 凭据

仅用于 `pnpm dev:mock` 与自动化测试，**不是真实后端凭据**：

| 用户名 | 密码 |
|---|---|
| `alice` | `demo-pass` |
| `bob` | `demo-pass` |

## 阶段 1 边界

包含：`/login`、`/projects`、`/projects/:projectId`、匿名受保护路由重定向、内存 JWT、项目 `CREATING` / `READY` / `FAILED`、每用户 3 个项目上限、一次 401 全局退出、403 通用拒绝文案。

不包含：真实 JWT 签名与授权、PVC 创建、Kubernetes 集成、文件树、Run / 日志 / 真实 PTY、refresh token、浏览器持久化登录。阶段 0 xterm 只作为 mock 构建里的独立 `/stage0.html` Spike 存在，不能当成真实 Job 终端。

跨用户 403 与项目上限只验证前端契约与 mock handler（**mock contract verified**），不能写成真实所有权隔离或集群验收已通过。

## 已知体积问题

生产 `pnpm build` 主包约 370 kB（gzip 约 118 kB）。mock / 阶段 0 Spike 的 `stage0` chunk 约 4.5 MB（gzip 约 1.2 MB），与历史约 4.8 MB 主包同一数量级。后续若把 Monaco 工作台并入生产路由，需要单独做懒加载与 Worker / 语言包计量；阶段 1 不把该体积当作生产应用失败。
