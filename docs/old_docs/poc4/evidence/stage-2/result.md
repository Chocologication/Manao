# EnsoAI Stage 2 Read-Only Workbench Result

## Source Commit

- 日期：`2026-08-22`
- 分支：`poc4/ensoai-stage-2-readonly-workbench`
- 验证树（代码 + 矩阵）：`936363ef3fc17158d0afd68668fcc7ba221acb29`（`936363e` `fix(poc4): show file-tab close focus for keyboard users`）
- 本报告是该 SHA 之后的文档提交，不改应用源码
- 工作目录：`poc4/frontend`；包管理器仅 pnpm
- 本报告所有退出码、测试数、构建体积、扫描结果与大文件实测均来自该 SHA 对应工作树

阶段 2 实现提交（`3e23699..936363e`）：

| SHA | 说明 |
|---|---|
| `9f80265` | 阶段 2 浏览器边界 |
| `86529fb` | 只读文件契约与相对路径 API |
| `c6a48e1` | MSW 只读文件夹具 |
| `d6087ab` | 项目作用域工作台会话 |
| `f7cbcde` | 懒加载只读文件树 |
| `c81eb2d` | 文件树焦点环与 roving tabindex |
| `e0bbe27` | metadata 门闩查看器 |
| `0c427ae` | 标签切换保留 Monaco model |
| `96564fd` | 组装生产只读工作台 |
| `a940542` | 失败边界与 stale 401 加固 |
| `5180930` | Stage 2 E2E、12 张 PNG、真实字节大文件 |
| `936363e` | 键盘关闭标签可见焦点 |

## Scope Boundary

阶段 2 仍是纯浏览器前端。证据只证明浏览器面对 mock `200/202/401/403/409/413/415/5xx` 与文件 `tree/meta/content/download` 时的状态机。用语一律为 **mock contract verified**。不得从 MSW 得出真实后端授权、PVC 路径规范化、symlink escape、项目所有权或 Kubernetes 集成已验证。

包含：`READY` 项目只读工作台、项目内正斜杠相对路径、根目录后懒加载、隐藏文件可见、多标签只读 Monaco、`PLAIN_TEXT` 降级、`BLOCKED` 零正文、受认证 Blob 下载、logout / 当前会话 401 清空、生产构建排除 mock、Chromium / Chrome / Edge 工作流与真实约 20 MiB 实测。

明确排除：真实 Spring Boot / JWT 签名 / MySQL、真实 PVC / 工作区 Pod / 文件代理、保存与 workspace revision 写入、拖拽上传 / Git / 搜索 / CRUD、Run / 日志 / 真实 PTY、refresh token、工作台状态持久化。

## Automated Verification

工作目录：`poc4/frontend`。下列命令于提交 `936363e` 的同一工作树执行。`rg` 不在 PATH；生产排除扫描见后文。浏览器测试后 `git diff --check` 无空白错误。channels 会改写已提交 PNG，Stage 0 与 Stage 2 的 recapture 均已 `git checkout` 还原，未纳入提交。

| 命令 | 退出码 | 观察结果 |
|---|---:|---|
| `pnpm test:boundary` | 0 | node:test **13 pass / 0 fail**（`duration_ms 130.5029`）；随后打印 `Browser boundary check passed.` |
| `pnpm typecheck` | 0 | `tsc -b --pretty false` 无诊断输出 |
| `pnpm test` | 0 | Vitest 3.2.7：Test Files **26 passed (26)**；Tests **248 passed (248)**；Duration 27.58s。stderr 仅 jsdom `HTMLCanvasElement.getContext` 未实现提示（Spike），不计入失败 |
| `pnpm build` | 0 | 内含 typecheck；Vite 7.3.6 production；`3738 modules transformed`；`built in 46.63s`。入口 `index-C1KbWvVa.js` 375.28 kB / gzip 119.46 kB；工作台 `ReadonlyWorkbenchPage-B6Fycwsf.js` 3,941.47 kB / gzip 1,024.61 kB |
| `pnpm build:mock` | 0 | Vite mock；`3755 modules transformed`；`built in 48.25s`。含 `stage0.html`、MSW worker、Monaco workers。存在 `>500 kB` chunk 提示，构建仍成功 |
| `pnpm test:e2e`（矩阵首次） | 1 | Playwright Chromium：Running 33 tests using 3 workers；**1 failed / 9 skipped / 23 passed**（2.3m）。失败用例：`stage2.spec.ts:479` `opens pom.xml and App.java, switches tabs, and preserves view state`。错误为登录页 `page.waitForResponse` `/api/v1/auth/login` 与 `getByLabel('Username').fill` 超过 60s，页面未出现用户名框。同矩阵 Chrome/Edge 该用例均通过 |
| `pnpm test:e2e:channels` | 0 | Playwright chrome + edge：Running 66 tests using 4 workers；**66 passed**（2.0m） |
| `pnpm test:e2e:large-files` | 0 | Playwright `chromium-large-files`：**2 passed**（1.1m，120s ceiling） |
| `pnpm test:e2e`（同 SHA 复跑） | 0 | **24 passed / 9 skipped**（1.3m）。先前失败的 pom/App 用例 2.7s 通过 |
| `pnpm build`（E2E 后生产重建） | 0 | mock/E2E 覆盖 `dist/` 后再构建；`3738 modules transformed`；`built in 47.50s`；产物哈希与矩阵首次生产构建一致 |
| `git -C ../.. diff --check` | 0 | 干净 |
| `git -C ../.. status --short` | 0 | 矩阵结束时仅 PNG recapture（3 张 Stage 0 + 8 张 Stage 2）；已还原，工作树干净 |

矩阵首次 Chromium 失败判定为 3 worker 并行下的登录超时 flake，不是产品回归。同 SHA 完整 `pnpm test:e2e` 复跑退出 0。后续退出门按复跑 + channels + large-files 判定。

## Relative Path And Contract Evidence

本项为 **mock contract verified**。

1. `parseProjectRelativePath` 只接受正斜杠相对路径；拒绝 leading `/`、`\`、Windows 盘符、UNC、NUL、空段、`.`、`..`。根目录只用 `''`（`parseProjectDirectoryPath` / `{ allowRoot: true }`）。不解码 percent 文本，传输编码由 `URLSearchParams` 完成，字面 `%2e%2e` 不会变成 `..`。
2. 导出的 `listDirectory` / `getFileMetadata` / `getFileContent` / `downloadFileBlob` 只接受 branded 路径。URL 形态：
   - `GET /api/v1/projects/{encodeURIComponent(projectId)}/files/tree|meta|content|download?path=`
   - 根目录 `path=` 为空字符串。
3. 表驱动单测覆盖 `/etc/passwd`、`../secret`、`src\\App.java`、NUL、`.gitignore`、Unicode、不透明项目 ID 编码。无效树/metadata/content 抛出单一 `Invalid file response`，不渲染部分树。
4. E2E 用 page `request`/`response` 观察实际 URL：初次进入只有根 `tree?path=`；展开 `src` → `src/main` → `src/main/java` → `src/main/java/demo` 各一次 GET；打开文件的 `meta`/`content` query 均为项目相对路径，无本机绝对路径。

前端路径检查不能替代后端规范化、symlink escape 或所有权校验。这些在真实后端上仍未验证。

## Lazy File Tree Evidence

本项为 **mock contract verified**。

1. 初次进入只请求根目录：E2E `requests only the root tree on first load and shows .gitignore` 断言根 `tree` ≥ 1，且所有 tree 请求的 `path === ''`；`src`/`docs`/`assets` 计数为 0；可见 `.gitignore` 与 `pom.xml`，不可见嵌套 `App.java` / `main`。
2. 目录仅在展开时请求一次：E2E `expands src -> main -> java -> demo lazily` 断言上述四层各 `count === 1`。组件测试覆盖折叠再展开仍为 1（`staleTime: 30_000`）、`retry: false`、collapse-all 不 `removeQueries`。
3. 隐藏文件可见（`.gitignore` `hidden: true`）。排序：目录优先，然后 `en` 大小写不敏感、重音敏感，原名作稳定 tie-break；渲染不原地 mutate 缓存数组。
4. 无 Git decoration、拖拽、上传或写操作入口。目录点击只 `toggleDirectory`；文件点击 `selectPath` + `openFile`。Refresh / Collapse all 为 32px 图标按钮（`title` + `aria-label`），无 hover scale。

## Metadata And Size-Gate Evidence

本项为 **mock contract verified**。浏览器不按扩展名放宽上限。

1. 打开文件先请求 metadata。`MONACO_TEXT` / `PLAIN_TEXT` 才启用 content query。`BLOCKED` 正文请求数为零。
2. E2E `opens binary, non-UTF-8 and oversized files without content requests`：`logo.png`（`BINARY_FILE`）、`docs/latin1.txt`（`UNSUPPORTED_ENCODING`）、`docs/too-large.md`（`FILE_TOO_LARGE`）各 1 次 meta、0 次 content；Download 可用；活动查看区无 `.monaco-editor`。
3. Handler 测试：绕过 UI 用 octet-stream 请求阻断正文仍返回 415/413/400，无 `content`。`UNSUPPORTED_ENCODING` 不是 API error code。
4. 边界 metadata（不分配匹配正文）：Markdown 恰好 `20 MiB` → `MONACO_TEXT`；恰好 `50 MiB` → `PLAIN_TEXT`；`20 MiB+1` Markdown → `PLAIN_TEXT`；`50 MiB+1` → `BLOCKED`；`NearLimit.java` = `20 MiB-1` → `MONACO_TEXT`。
5. 核心 E2E 的 `large-notes.md` 仍用小占位正文，但 UI 走 `PLAIN_TEXT` textarea，活动查看区零 `.monaco-editor`。真实字节见 Real-Size File Measurements。

## Monaco And Model Lifecycle Evidence

本项为 **mock contract verified**。

1. `MONACO_TEXT` 使用 `poc4://workspace/{encodeURIComponent(projectId)}/{relative}`，选项精确为 `readOnly`、`domReadOnly`、`automaticLayout`、`scrollBeyondLastLine: false`。无 `onChange`。E2E 打字 `SHOULD_NOT_STAY` 后缓冲区不变，标签无 `*`。
2. `PLAIN_TEXT` 只渲染只读 textarea，不创建 Monaco model。
3. 关闭标签：先 `closeFile` 切走，再 `disposeProjectModel` 该路径。E2E 关闭 `pom.xml` 后 URI 消失，`App.java` model 保留。
4. 项目切换：cancelQueries → disposeProjectModels(oldId) → removeQueries → reset → activateProject(newId)。logout / 当前会话 401：close connections → dispose workspace resources → reset session → `queryClient.clear()` → 清 auth。Alice 迟到的 file-content 401 不清除 Bob。
5. E2E：logout 后 Bob 只见 `lab-notes.md`，不见 Alice 树/标签/缓存；mock `POST /api/v1/session/expire` + Refresh 回到 `/login`，一条过期会话 alert，工作台清空。

## Download Evidence

本项为 **mock contract verified**。

1. `requestBlob` 与 JSON 请求共用相对 `/api/v1/` 守卫和 Bearer header；JWT 不进入 URL。`Accept: application/octet-stream`。
2. 文件名来自已验证 `Content-Disposition`（`filename*` UTF-8 或 `filename=`）或 sanitized fallback；去掉路径分隔符与控制字符。
3. `downloadFile`：`createObjectURL` → 临时 `<a download>` click → `revokeObjectURL` 在 `finally`（含 click 抛错）。按钮仅在 in-flight 时禁用；失败为可重试 `role="alert"`。
4. 当前 token 的 download 401 走同一清理路径。过期下载 body 不泄漏路径。键盘 E2E 能 Tab 到 Download 并看到可见焦点。

真实下载授权、range/streaming 与 PVC 字节仍未验证。

## Browser And Visual Evidence

Chromium（`pnpm test:e2e` 复跑，退出 0）：

| 范围 | 结果 |
|---|---|
| Stage 2 用例 1–11 | 通过（含 pom/App 标签切换 2.7s） |
| Stage 1 用例 | 通过 |
| Spike 工作流 / dirty buffer / 终端会话 / inactive Ctrl+F | 通过 |
| 截图 9 条（Spike 3 + Stage 1 3 + Stage 2 3） | skipped |

Chrome + Edge（`pnpm test:e2e:channels`，退出 0）：

| Project | Passed | Failed | Notes |
|---|---:|---:|---|
| chrome | 33 | 0 | 含 11 条 Stage 2 核心 + 3 条 Stage 2 截图 |
| edge | 33 | 0 | 同上 |

12 张视觉证据已在 `5180930` 写入 `poc4/docs/evidence/stage-2/`。本矩阵 channels 复拍了其中 8 张及 3 张 Stage 0 PNG；按约束全部还原，不提交。PNG 字节不是 golden-file；断言的是 CSS 像素尺寸、无文档横向溢出、sidebar/editor 无内部重叠、Refresh / Collapse all / 活动标签 / Close / Download 可达、Monaco canvas 含非背景像素与源码 `Hello, POC4`、`App.java` tab `title` 为完整相对路径且标签截断。

| 文件 | 像素 |
|---|---|
| `chrome-workbench-1280x720.png` / `chrome-blocked-1280x720.png` | 1280×720 |
| `chrome-workbench-1440x900.png` / `chrome-blocked-1440x900.png` | 1440×900 |
| `chrome-workbench-1920x1080.png` / `chrome-blocked-1920x1080.png` | 1920×1080 |
| `edge-workbench-1280x720.png` / `edge-blocked-1280x720.png` | 1280×720 |
| `edge-workbench-1440x900.png` / `edge-blocked-1440x900.png` | 1440×900 |
| `edge-workbench-1920x1080.png` / `edge-blocked-1920x1080.png` | 1920×1080 |

1280 px：Chrome/Edge 工作台与阻断捕获均通过无溢出与可达断言。

键盘：skip link（`Skip to editor`）可见焦点 → 树箭头展开 → 打开文件 → 标签 → 关闭（`focus-visible:opacity-100`）→ Download。`role="alert"` 用于树/metadata/content/download 错误与过期会话。`prefers-reduced-motion` 覆盖标签指示与 `scrollIntoView`。

Playwright webServer 执行 `pnpm build:mock && pnpm preview`（4173）与 `pnpm dev:echo`（4174）。未连接真实 POC4 后端。

## Real-Size File Measurements

Chromium 项目 `chromium-large-files`，超时 120s。先 `POST /api/v1/session/large-files`（mock-only）再打开。载荷未缩小。本矩阵实测：

| File | Renderer | Content bytes | Response `Content-Length` | Click → viewer-ready | Console errors | Page errors |
|---|---|---:|---:|---:|---|---|
| `src/main/java/demo/NearLimit.java` | Monaco | 20,971,519（20 MiB − 1） | 20,971,624 | **669 ms** | none | none |
| `docs/large-notes.md` | Plain textarea | 20,971,521（20 MiB + 1） | 20,971,608 | **4004 ms** | none | none |

键盘输入后 `getValueLength` / textarea 长度不变，无 dirty `*`。页面未崩溃、未超时、未关闭。这只证明当前测试机器可运行，不构成生产 SLA。

## Production Exclusion Evidence

矩阵中 `pnpm build:mock` 与 E2E 会覆盖 `dist/`，因此在同一 SHA 上于 mock/E2E 之后重新执行 `pnpm build`（production，非 mock）再扫描。`dist/stage0.html` 与 `dist/mockServiceWorker.js` 均不存在。入口 chunk `index-C1KbWvVa.js` 不含 `monaco` 字符串。工作台 chunk 与五个 Worker 均存在。产物 190 个文件。

扫描字符串（brief 列表 **加上** `/api/v1/session/large-files`）：

```text
demo-pass
mockServiceWorker
/api/v1/session/expire
127.0.0.1:4174
stage0.html
window.electronAPI
node-pty
/api/v1/session/large-files
```

UTF-8 解码后逐文件 `Contains`：`FORBIDDEN_MATCH_COUNT=0`（每条 needle 的 MATCH_FILES=0）。

关键产物（Vite 打印；Worker 无 gzip 列，改用 `zlib.gzipSync({ level: 9 })`）：

| 路径 | raw | gzip |
|---|---:|---:|
| `dist/index.html` | 0.40 kB | 0.27 kB |
| `dist/assets/index-DL6KRvX_.css` | 34.61 kB | 6.58 kB |
| `dist/assets/index-C1KbWvVa.js`（入口，无 Monaco） | 375.28 kB | 119.46 kB |
| `dist/assets/ReadonlyWorkbenchPage-Ck3IbhyB.css` | 142.37 kB | 22.88 kB |
| `dist/assets/ReadonlyWorkbenchPage-B6Fycwsf.js`（工作台） | 3,941.47 kB | 1,024.61 kB |
| `dist/assets/editor.worker-C2_AfrSl.js` | 251,735 B | 75,845 B |
| `dist/assets/json.worker-C838mOW9.js` | 383,014 B | 113,613 B |
| `dist/assets/html.worker-eZJr__P7.js` | 693,120 B | 181,134 B |
| `dist/assets/css.worker-NZNbQL3P.js` | 1,030,315 B | 231,173 B |
| `dist/assets/ts.worker-BfwyojP3.js` | 7,010,073 B | 1,534,541 B |

Vite 打印 `Some chunks are larger than 500 kB after minification`。`chunkSizeWarningLimit` 未提高。

`main.tsx` 仅在 `import.meta.env.VITE_ENABLE_MOCK_API === 'true'` 时动态 `import('./mocks/browser')`。Vite `publicDir` 生产为 `public`，mock 为 `public-mock`。生产入口只有 `index.html`。

编码：对 `git ls-files` 下 `poc4/frontend` 与 `poc4/docs` 的文本文件做 UTF-8 严格解码；`ENCODING_CHECKED=130`，`BOM_FOUND=0`，`UTF8_STRICT_FAIL=0`。工作区因 `core.autocrlf=true` 可见 CRLF（`CR_FOUND=78`）；`git diff --check` 干净。未添加 `.grok/`、`.superpowers/` 或 Stage 0 recapture。

## Known Gaps

- 真实后端文件 API、JWT 校验、项目所有权、PVC 路径规范化和 symlink escape 尚未实现或验证。
- MSW 目录结构和错误码只能稳定前端契约，不能模拟 NFS 延迟、Pod 重启或大目录规模。
- 19–20 MiB Monaco 和 20–50 MiB plain-text 测试只能证明当前测试机器可运行，不构成生产 SLA。
- 下载在浏览器内通过 Blob 暂存，接近存储上限时会产生额外内存占用；真实后端可在后续评审 range/streaming 或短期下载 ticket。
- 工作台状态故意不持久化；刷新页面会因阶段 1 的内存 JWT 回到登录页。
- Stage 2 不实现写入，所以 workspaceRevision 只读取和保留，不参与冲突控制；阶段 3 才验证保存与 revision。
- Run 和 Terminal 在生产 Shell 中保持禁用，阶段 0 echo terminal 仍仅用于独立回归。
- 强制 401 与真实字节开关仍是 mock contract：`POST /api/v1/session/expire` 与 `POST /api/v1/session/large-files` 只存在于 MSW，不是产品 API。
- Chromium 在 3 worker 并行下曾出现一次登录页 60s 超时 flake；同 SHA 复跑已绿。未当作产品缺陷修改代码。

## Decision

对照阶段 2 退出门十一项，依据 `936363e` 工作树上的矩阵（含同 SHA Chromium 复跑）逐项判定。全部为 **mock contract verified**：

1. 所有文件 API 只接收通过验证的项目内正斜杠相对路径；根目录只用空字符串：通过。
2. 初次进入只请求根目录；目录只有在展开时请求一次，折叠和重新展开使用同项目缓存：通过。
3. 隐藏文件可见；目录优先、名称稳定排序；无 Git、拖拽、上传或写操作入口：通过。
4. 打开文件先请求 metadata；`BLOCKED` 文件正文请求数为零，绕过 UI 请求正文也被 mock API 拒绝：通过。
5. `MONACO_TEXT` 使用唯一、项目隔离的 model URI 和 `readOnly`；`PLAIN_TEXT` 不创建 Monaco model：通过。
6. 普通文本 20 MiB 上限、Markdown 20/50 MiB 分级、二进制和非 UTF-8 行为均有边界值测试：通过。
7. 关闭标签 dispose 对应 model；项目切换、logout 和当前会话 401 清空全部工作台状态、文件缓存与相关 models：通过。
8. 受认证下载不会把 JWT 放入 URL，object URL 在触发后回收，文件名来自已验证 metadata：通过。
9. 生产构建不包含 MSW worker、mock 凭据、mock expire 路径、echo URL 或 `stage0.html`；生产项目路由可加载 Monaco Worker：通过。额外确认 mock-only `/api/v1/session/large-files` 零匹配。
10. Chromium、真实 Chrome 和真实 Edge 的核心工作流通过，1280 px 无重叠、裁切或不可达操作；大文件用例使用真实字节量并单独记录：通过。Chromium 复跑 24 passed / 9 skipped；Chrome 33 passed；Edge 33 passed；large-files 2 passed。
11. Keyboard-only navigation reaches the tree, tabs, viewer and Download; skip link, focus rings, `role="alert"` and reduced-motion behavior are covered：通过。

真实后端 / PVC / symlink / 所有权验证列为未解决，不阻塞本阶段退出门。

因此决策为：

**READY_FOR_STAGE_3_PLAN**

未编写阶段 3 计划；未 merge / push。

## Confidence

对阶段 2 产品退出门 1–11 的置信度为 **90%**（单测 248、Chromium 复跑 24、Chrome/Edge 66、真实 20 MiB 实测、生产扫描 0 匹配、工作台 chunk + 五 Worker）。对「现在就可以 `READY_FOR_STAGE_3_PLAN`」的置信度为 **86%**：矩阵首次 Chromium 有一次登录超时 flake；大文件耗时依赖本机；全部文件安全结论仍是 **mock contract verified**，真实后端/PVC/symlink/ownership 未验证。
