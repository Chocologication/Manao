# EnsoAI Stage 1 Frontend Foundation Result

## Source Commit

- 日期：`2026-08-21`
- 分支：`poc4/ensoai-stage-1-frontend-foundation`
- 验证树（代码 + E2E + 12 张 PNG）：`b61513cf8e1ce323298f873da85a34156883026c`（`b61513c` `fix(poc4): bind 401 logout to current token and encode project ids`）
- 本报告是该 SHA 之后的文档提交，不改应用源码
- 工作目录：`poc4/frontend`；包管理器仅 pnpm
- 本报告所有退出码、测试数、构建体积与扫描结果均来自该 SHA 对应工作树（提交前）上的新鲜七命令矩阵

阶段 1 实现提交（`3bdead6..b61513c`）：

| SHA | 说明 |
|---|---|
| `5960e91` | 将终端快捷键限制在活动面板 |
| `5bc4163` | 阶段 1 应用骨架 |
| `2b53d53` | 浏览器 API 契约 |
| `be1835a` | 内存会话与路由守卫 |
| `98fbb2e` | MSW 浏览器 API 模拟 |
| `ec791d2` | 项目生命周期前端 |
| `069e9e9` | 集中处理会话失效 |
| `01c2a7c` | 阶段 1 工作流 E2E 与 12 张截图 |
| `19b8a2d` | 记录阶段 1 结果（当时矩阵未绿） |
| `91de5ec` | 登录 401 不清理会话、列表错误分流、mock token expire、Edge Monaco 输入稳定 |
| `73f2353` | 记录补救后的七命令矩阵 |
| `b61513c` | 401 清理绑定当前 token；迟到的旧会话 401 不清除新会话；项目链接编码不透明 ID |

## Scope Boundary

阶段 1 仍是纯浏览器前端。证据只证明浏览器面对 mock `200/202/401/403/409/5xx` 时的状态机。用语一律为 **mock contract verified**。不得从 MSW 得出真实后端授权、PVC 创建或 Kubernetes 集成已验证。

包含：`/login`、`/projects`、`/projects/:projectId`、匿名重定向、内存 JWT、项目三态与轮询、每用户 3 个上限、401 一次退出、403 通用拒绝、生产构建排除 mock、Chromium/Chrome/Edge 工作流。

明确排除：真实 Spring Boot / JWT 签名 / MySQL、真实项目所有权安全证明、PVC / 工作区 Pod / Maven 模板 / 失败回收、文件树与真实 Monaco 项目模型、Run / 日志 / 真实 PTY / ticket、refresh token 与持久化登录。

## Automated Verification

工作目录：`poc4/frontend`。七条矩阵命令于提交 `b61513c` 之前的同一工作树执行。`rg` 不在 PATH；生产排除扫描见后文。浏览器测试后 `git diff --check` 无空白错误（仅 `core.autocrlf` 提示）；channel 捕获未改动已提交 PNG。

| 命令 | 退出码 | 观察结果 |
|---|---:|---|
| `pnpm test:boundary` | 0 | node:test 3 pass / 0 fail（`duration_ms 109.1738`）；随后打印 `Browser boundary check passed.` |
| `pnpm typecheck` | 0 | `tsc -b --pretty false` 无诊断输出 |
| `pnpm test` | 0 | Vitest 3.2.7：Test Files 16 passed (16)；Tests 87 passed (87)；Duration 19.57s。stderr 仅 jsdom `HTMLCanvasElement.getContext` 未实现提示，不计入失败 |
| `pnpm build` | 0 | 内含 typecheck；Vite 7.3.6 production；`2091 modules transformed`；`built in 4.24s`。产物：`index.html` 0.39 kB；`index-B6W3YsCW.css` 32.96 kB；`index-Cw77Shhm.js` 370.57 kB / gzip 117.55 kB |
| `pnpm build:mock` | 0 | Vite mock；`3734 modules transformed`；`built in 46.63s`。含 `stage0.html`、Monaco workers；`stage0-BnUwFUcQ.js` 4,547.86 kB / gzip 1,179.42 kB。存在 >500 kB chunk 提示，构建仍成功 |
| `pnpm test:e2e` | 0 | Playwright Chromium：Running 19 tests using 2 workers；**13 passed / 6 skipped**（1.1m）。跳过的 6 条为 Spike 与 Stage 1 截图（仅 chrome/edge） |
| `pnpm test:e2e:channels` | 0 | Playwright chrome + edge：Running 38 tests using 4 workers；**38 passed**（1.3m） |

矩阵命令全部退出 0。

## Authentication Evidence

本项为 **mock contract verified**。

1. 未认证访问受保护路由重定向 `/login`：`RequireAuth` 在 `snapshot.status !== 'authenticated'` 时 `Navigate` 到 `/login` 并带 `state.from`。`LoginPage.test.tsx` 覆盖匿名受保护路由回跳；Playwright Chromium/Chrome/Edge 均通过 `/projects redirects to /login when anonymous`。
2. Token 只在内存：`createAuthSession()` 把 `accessToken` 留在闭包快照。`authSession.test.ts` 间谍断言不写 `localStorage` / `sessionStorage`、URL 不含 token、console 不含 `mem-token`。生产 `dist` 扫描无 `demo-pass`。
3. 已认证请求的 API `401` 只触发一次全局退出，且必须仍属于当前会话：`HttpClient` 在发出请求时捕获 `sentToken`，仅当响应 401 且 `sentToken === getAccessToken()` 时调用 `onUnauthorized`。登录 `auth: false` 与未带 Authorization 的 401 不清理。迟到的旧会话 401（Alice 的延迟列表请求在 Bob 登录之后返回）不调用 `onUnauthorized`，不 `closeAll`，不把 Bob 踢回 `/login`。`httpClient.test.ts` 覆盖“延迟 401 的 token 已不是当前 token”；`appRuntime.test.ts` 覆盖“Alice 延迟 401 不得清除 Bob 新会话”。并发当前会话 401 仍走 `closeAll` → `queryClient.clear()` → `authSession.clear('unauthorized')`，closer 各 1 次、登录页一条过期会话 alert。Playwright 通过 mock-only `POST /api/v1/session/expire` 让**当前** token 的下一次 `GET /api/v1/projects` 返回 401。无 UI expire 按钮。Stage 1 UI 没有注册生产 WebSocket。
4. 无效登录留在 `/login`，一条 `Invalid username or password`，不回显密码，不展示过期会话横幅。有效登录落到 `/projects`；logout 后再访问原受保护路径可回去。

合成凭据 `alice` / `demo-pass` 与 `bob` / `demo-pass` 仅存在于 mock state，不是真实后端凭据。

## Project Lifecycle Evidence

本项为 **mock contract verified**。未创建 PVC、Pod 或 Kubernetes 资源。

1. 列表状态：`ProjectsPage.test.tsx` 覆盖 loading（`Loading projects`）、empty（`No projects yet.`）、网络错误（`Network request failed` + Retry）、5xx / `INTERNAL_ERROR`（`Unable to load projects` + Retry，不说成断网）、`CREATING`（spinner + 禁用 Open）、`READY`（可点 Open）、`FAILED`（展示后端原因、无 Open）、已有 3 个项目时禁用创建、绕过 UI 提交得到 `409 PROJECT_LIMIT_REACHED`。
2. `CREATING` 轮询：`projectsRefetchInterval` / `projectDetailRefetchInterval` 仅在可见项目为 `CREATING` 时返回 `1000`。MSW handler 测试：创建 `202 CREATING`，两次观察 GET 后变为 `READY`；`fail-` 前缀两次观察后变为 `FAILED`，原因为 `Mock workspace provisioning failed`。
3. `READY` 才打开项目路由：`ProjectCard` 仅 `READY` 渲染 Open link，`to` 使用 `encodeURIComponent(project.id)`（与 `getProject` 的 API 路径编码一致）；`CREATING` 为禁用按钮。`ProjectCard.test.tsx` 锁定含 `/`、`?`、`#` 的不透明 ID 不会生成错误路由。E2E：创建 `Workspace Alpha` 可见 `CREATING` → `READY`，Open 进入 `/projects/prj-\d+`；项目页无 `terminal-spike-panel`。
4. `FAILED` 显示原因：E2E `fail-workspace` 经 `CREATING` 到 `FAILED` 并显示 `Mock workspace provisioning failed`。
5. 3 项目上限：Alice 种子 + 两个新项目后创建按钮与名称输入禁用；`page.evaluate` Bearer POST 第四个返回 `409` / `PROJECT_LIMIT_REACHED`，UI 不出现第四张卡。
6. `403` 通用拒绝：Alice 打开 `prj-bob-lab` 得到 `Access denied`，不匹配 `not found|does not exist|bob|prj-bob|exist`，无 `Bob Lab` 标题。logout 后 Bob 登录只见 `Bob Lab`，不见 Alice 缓存项目。这是 mock handler + 前端文案契约，不是所有权隔离已验证。

## Browser And Visual Evidence

Chromium（`pnpm test:e2e`，退出 0）：

| 范围 | 结果 |
|---|---|
| Stage 1 用例 1–9 | 通过 |
| Spike 工作流 / dirty buffer / 终端会话 / inactive Ctrl+F | 通过 |
| 截图 6 条（Spike 3 + Stage 1 3） | skipped |

Chrome + Edge（`pnpm test:e2e:channels`，退出 0）：

| Project | Passed | Failed | Notes |
|---|---:|---:|---|
| chrome | 19 | 0 | Spike 4 + Spike 截图 3 + Stage 1 用例 9 + Stage 1 截图 3 |
| edge | 19 | 0 | 同上，含 `keeps dirty editor buffer when switching workbench panels` |

12 张视觉证据（`poc4/docs/evidence/stage-1/`，属于 `01c2a7c`；`91de5ec` 矩阵未改提交中的 PNG）。PNG 字节不是 golden-file；断言的是 CSS 像素尺寸、无横向溢出、header/main 不重叠、主操作可见、项目状态标签未裁切。

| 文件 | 尺寸 |
|---|---|
| `chrome-login-1280x720.png` / `edge-login-1280x720.png` | 1280×720 |
| `chrome-login-1440x900.png` / `edge-login-1440x900.png` | 1440×900 |
| `chrome-login-1920x1080.png` / `edge-login-1920x1080.png` | 1920×1080 |
| `chrome-projects-1280x720.png` / `edge-projects-1280x720.png` | 1280×720 |
| `chrome-projects-1440x900.png` / `edge-projects-1440x900.png` | 1440×900 |
| `chrome-projects-1920x1080.png` / `edge-projects-1920x1080.png` | 1920×1080 |

1280 px：Chrome/Edge 登录与已填充项目捕获均通过无溢出与可达 Sign in / Create project / Log out 断言。登录页只有 `main`，重叠 helper 在缺少 `header` 时为空操作（Task 8 已记录）。

Playwright webServer 执行 `pnpm build:mock && pnpm preview`（4173）与 `pnpm dev:echo`（4174）。未连接真实 POC4 后端。

## Production Exclusion Evidence

本机 `rg` 不在 PATH（`Get-Command rg` / `where.exe rg` 均失败）。矩阵中 `pnpm build:mock` 与 E2E 会覆盖 `dist/`，因此在同一 SHA 上于 mock/E2E 之后重新执行 `pnpm build`（production，非 mock）再扫描。产物 4 个文件：

| 路径 | 字节 |
|---|---:|
| `dist/index.html` | 391 |
| `dist/assets/index-B6W3YsCW.css` | 32960 |
| `dist/assets/index-Cw77Shhm.js` | 370568 |
| `dist/assets/index-Cw77Shhm.js.map` | 1844268 |

`dist/stage0.html` 与 `dist/mockServiceWorker.js` 均不存在。等价扫描：

```powershell
$pattern = "demo-pass|mockServiceWorker|127\.0\.0\.1:4174|stage0\.html|session/expire"
$files = Get-ChildItem -Path .\dist -Recurse -File
$matches = Select-String -Path $files.FullName -Pattern $pattern -Encoding utf8
```

结果：`FORBIDDEN_MATCH_COUNT=0`。

`main.tsx` 仅在 `import.meta.env.VITE_ENABLE_MOCK_API === 'true'` 时动态 `import('./mocks/browser')`。Vite `publicDir` 生产为 `public`，mock 为 `public-mock`。生产入口只有 `index.html`。mock-only `POST /api/v1/session/expire` 不进入生产包。

编码：对 `git ls-files` 下 `poc4/frontend` 与 `poc4/docs` 的文本文件做 UTF-8 严格解码；`BOM_FOUND=0`，`UTF8_STRICT_FAIL=0`。`git diff --check` 干净。仓库无 `.editorconfig` / `.gitattributes`；本机 `core.autocrlf=true`。

## Known Gaps

- 真实 JWT 签名、密码哈希、用户所有权和 MySQL 模型未验证。
- 真实项目创建的 PVC/Pod 状态可能比 mock 更慢、更复杂，并需要后端幂等与失败回收。
- Access token 仅在内存，刷新页面会回到登录页；这是 POC 的显式选择，不是 refresh-token 实现遗漏。
- 生产主包约 370 kB；mock / 阶段 0 Spike 的 Monaco `stage0` chunk 约 4.5 MB（历史约 4.8 MB 主包问题仍在 Spike 路径）。阶段 2 若并入工作台，需单独计量 Worker 与语言包。
- 阶段 0 xterm 继续只作为独立 Spike 页面存在，不能被当成真实 Job 终端。
- MSW 的跨用户拒绝测试只验证前端契约与 mock handler，不替代真实后端对抗性测试。
- 强制 401 仍是 mock contract：`POST /api/v1/session/expire` 只存在于 MSW handlers，不是产品 API。
- 契约未规定项目 ID 安全字符集；浏览器侧链接与 API 路径均 `encodeURIComponent`，真实后端仍需拒绝或规范化异常 ID。

## Decision

对照阶段 1 退出门八项，依据 `b61513c` 对应工作树上的新鲜七命令矩阵逐项判定：

1. 未认证访问受保护路由必定重定向 `/login`：通过。
2. 登录成功后 token 只存在内存，不写入 `localStorage`、`sessionStorage`、URL 或日志：通过。
3. 已认证 API `401` 只触发一次全局退出，清空 Query Cache 和连接注册表；登录 401 不走该路径；**迟到的旧会话 401 不清除新会话**：通过（mock contract verified）。
4. 项目列表完整展示空、加载、网络错误、后端 5xx、`CREATING`、`READY`、`FAILED` 和 3 项目上限：通过。
5. `CREATING` 自动轮询，`READY` 才允许进入项目路由，`FAILED` 显示后端原因：通过（mock 状态机，不是真实 PVC/Pod）。
6. `403` 使用通用拒绝文案，不推断项目是否存在：通过（mock contract verified）。
7. 生产构建不包含 MSW worker、mock 密码、`127.0.0.1:4174`、阶段 0 页面入口或 mock expire 路径：通过。
8. Chromium、真实 Chrome 和真实 Edge 核心 E2E 通过，1280 px 无重叠和不可达操作：通过。Chromium 13 passed / 6 skipped；Chrome 19 passed；Edge 19 passed。

因此决策为：

**READY_FOR_STAGE_2_PLAN**

外部审查曾在 `73f2353` 上复现“Alice 延迟 401 清掉 Bob 新会话”，当时退出门第 3 项不完整，结论应为 `STAGE_1_REMEDIATION_REQUIRED`。`b61513c` 把 401 清理绑定到请求发出时的 token，并编码项目路由 ID。官方七命令在该修复上全部退出 0。未编写阶段 2 计划；未 merge / push。

## Confidence

对阶段 1 产品退出门 1–8 的置信度为 **92%**（单测 87、迟到 401 回归、Chromium 工作流、Chrome/Edge 全绿、生产扫描 0 匹配）。对「现在就可以 `READY_FOR_STAGE_2_PLAN`」的置信度为 **88%**：七命令矩阵在 `b61513c` 全部退出 0；剩余风险是 Edge Monaco 输入仍可能偶发，以及 401 浏览器证明依赖 mock expire handler 而非真实后端。
